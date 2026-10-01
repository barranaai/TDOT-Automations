'use strict';

// Case numbers are never handed out twice (2026-10-01 — the root cause of the
// test-folder collisions). The next number is one above the highest on the
// Cases board, in ANY OneDrive folder name (incl. the renamed "(was <ref>)"
// test folders) and among this process's recent numbers; then it is checked
// against every board that carries references. One allocation at a time.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const fresh = () => { const p = require.resolve('../src/services/caseRefAllocator'); delete require.cache[p]; const m = require(p); m._resetForTests(); return m; };
function harness({ board = [], folders = [], inUse = [], folderFail = 0, now = 1_000_000, mark = null, markFail = false } = {}) {
  const a = fresh();
  const seen = { boardReads: 0, folderReads: 0, probes: [], markWrites: [] };
  let file = mark ? { data: { ...mark }, etag: 'e1' } : null;
  a.io.readMark = async () => { if (markFail) throw new Error('OneDrive down'); return file ? { data: { ...file.data }, etag: file.etag } : null; };
  a.io.writeMark = async (data, etag) => {
    if ((file ? file.etag : '') !== (etag || '')) { const e = new Error('changed'); e.conflict = true; throw e; }
    seen.markWrites.push({ ...data }); file = { data: { ...data }, etag: 'e' + (seen.markWrites.length + 1) };
    return { etag: file.etag };
  };
  seen.file = () => file;
  seen.setFile = (f) => { file = f; };
  seen.backups = [];
  a.io.writeBackup = async (raw, stamp) => { seen.backups.push([raw, stamp]); return {}; };
  let t = now, fails = folderFail;
  a.io.boardRefs = async () => { seen.boardReads++; return board.slice(); };
  a.io.rootFolderNames = async () => { seen.folderReads++; if (fails > 0) { fails--; throw new Error('OneDrive down'); } return folders.slice(); };
  a.io.refInUse = async (ref) => { seen.probes.push(ref); return inUse.includes(ref); };
  a.io.now = () => t;
  return { a, seen, advance: (ms) => { t += ms; }, setFolders: (f) => { folders = f; }, failFolders: (n) => { fails = n; }, setBoard: (b) => { board = b; } };
}
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };

test('maxSeq: only exact "<prefix><digits>" — not glued to letters, digits or a dash; "(was …)" counts; other types never leak in', () => {
  const { maxSeq } = fresh();
  const names = ['Ada - 2026-VV-007', 'ZZ-TEST Praj (was 2026-VV-012)', 'Bo - 2026-VV-0099x', 'X-2026-VV-050', '12026-VV-090', 'Cy - 2026-VVS-070', 'Di - 2026-CEC-EE-040', 'Ed - 2026-CEC-030'];
  assert.equal(maxSeq(['Ada - 2026-VV-007', 'ZZ-TEST Praj (was 2026-VV-012)'], '2026-VV-'), 12, '"(was …)" counts');
  assert.equal(maxSeq(names, '2026-VV-'), 99, 'a suffix after the digits does not hide the number (counting too much only skips a number, never reuses one)');
  assert.equal(maxSeq(['X-2026-VV-050', '12026-VV-090'], '2026-VV-'), 0, 'glued before: not a reference');
  assert.equal(maxSeq(names, '2026-CEC-'), 30, '"2026-CEC-EE-040" is not a plain CEC number');
  assert.equal(maxSeq(names, '2026-CEC-EE-'), 40);
  assert.equal(maxSeq(['2026-SPE-012'], '2026-SP-'), 0, 'SPE is not SP');
});

test('the old rule\'s bug: a deleted case freed its number while its OneDrive folder kept it — now the folder holds the number', quiet(async () => {
  // board max VV-007; a leftover test folder carries VV-008 → old rule said 008, which collided
  const { a } = harness({ board: ['2026-VV-007', '2026-SP-003'], folders: ['Ameena Begum - 2026-VV-007', 'Praj - 2026-VV-008'] });
  const r = await a.allocate('2026-VV-');
  assert.equal(r.ref, '2026-VV-009');
  assert.deepEqual(r.from, { board: 7, folders: 8, recent: 0, mark: 0 });
  assert.equal(r.folderCheck, 'ok');
}));

test('a renamed "(was <ref>)" test folder still holds its number', quiet(async () => {
  const { a } = harness({ board: ['2026-SP-014'], folders: ['ZZ-TEST E2E 1788536909757 (was 2026-SP-015)'] });
  assert.equal((await a.allocate('2026-SP-')).ref, '2026-SP-016');
}));

test('a number already on the Documents / Questionnaire / Family boards (rows left by a deleted case) is skipped, and said so', quiet(async () => {
  const { a, seen } = harness({ board: ['2026-OINP-060'], folders: [], inUse: ['2026-OINP-061', '2026-OINP-062'] });
  const r = await a.allocate('2026-OINP-');
  assert.equal(r.ref, '2026-OINP-063');
  assert.deepEqual(r.skipped, ['2026-OINP-061', '2026-OINP-062']);
  assert.deepEqual(seen.probes, ['2026-OINP-061', '2026-OINP-062', '2026-OINP-063']);
}));

test('a number this process just handed out is never handed out again, even before the board shows it', quiet(async () => {
  const { a } = harness({ board: ['2026-VV-001'], folders: [] });
  const r1 = await a.allocate('2026-VV-'); a.noteAssigned(r1.ref);
  const r2 = await a.allocate('2026-VV-'); a.noteAssigned(r2.ref);
  assert.deepEqual([r1.ref, r2.ref], ['2026-VV-002', '2026-VV-003']);
}));

test('one allocation at a time: two at once get different numbers', quiet(async () => {
  const { a } = harness({ board: ['2026-VV-001'] });
  const take = () => a.withAllocationLock(async () => { const r = await a.allocate('2026-VV-'); await new Promise((res) => setTimeout(res, 5)); a.noteAssigned(r.ref); return r.ref; });
  const got = await Promise.all([take(), take(), take()]);
  assert.deepEqual(got, ['2026-VV-002', '2026-VV-003', '2026-VV-004']);
}));

test('a failed allocation does not jam the lock', quiet(async () => {
  const { a } = harness({ board: [] });
  await assert.rejects(() => a.withAllocationLock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await a.withAllocationLock(async () => 'next'), 'next');
}));

test('OneDrive down: one retry; then the last listing of this process ("stale"); with none, Monday only ("unavailable") — a number is still given', quiet(async () => {
  const h = harness({ board: ['2026-VV-001'], folders: ['Old - 2026-VV-010'] });
  assert.equal((await h.a.allocate('2026-VV-')).ref, '2026-VV-011');
  h.advance(10 * 60 * 1000);
  h.failFolders(2);
  const r = await h.a.allocate('2026-VV-');
  assert.equal(r.folderCheck, 'stale');
  assert.equal(r.ref, '2026-VV-011', 'the stale listing still holds 010');
  const h2 = harness({ board: ['2026-VV-001'], folders: ['Old - 2026-VV-010'], folderFail: 2 });
  const r2 = await h2.a.allocate('2026-VV-');
  assert.equal(r2.folderCheck, 'unavailable');
  assert.equal(r2.ref, '2026-VV-002');
  assert.match(r2.folderError, /OneDrive down/);
  const h3 = harness({ board: ['2026-VV-001'], folders: ['Old - 2026-VV-010'], folderFail: 1 });
  assert.equal((await h3.a.allocate('2026-VV-')).folderCheck, 'ok', 'one failure is retried');
}));

test('a burst of new cases shares one root listing (60 s)', quiet(async () => {
  const h = harness({ board: [] });
  await h.a.allocate('2026-VV-'); await h.a.allocate('2026-SP-');
  assert.equal(h.seen.folderReads, 1);
  h.advance(61 * 1000);
  await h.a.allocate('2026-VV-');
  assert.equal(h.seen.folderReads, 2);
}));

test('every number taken on a board for 25 in a row: an error, never a reused number', quiet(async () => {
  const inUse = Array.from({ length: 30 }, (_, i) => `2026-VV-${String(i + 2).padStart(3, '0')}`);
  const { a } = harness({ board: ['2026-VV-001'], inUse });
  await assert.rejects(() => a.allocate('2026-VV-'), /no free case number found after 25 tries/);
}));

test('a bad prefix is refused', async () => {
  const { a } = harness();
  for (const p of ['VV-', '2026-VV', '2026-vv-', '']) await assert.rejects(() => a.allocate(p), /bad prefix/);
});

test('audit (read-only): per prefix, board max vs folder max, the next number old rule vs now, and numbers carried by two rows', quiet(async () => {
  const { a } = harness({ board: ['2026-VV-007', '2026-VV-007', '2026-SP-014', '2026-CEC-EE-086', '2026-CEC-EE-086'], folders: ['Praj - 2026-VV-008', 'ZZ-TEST E2E 1 (was 2026-SP-015)', 'Zed - 2026-SP-002'] });
  const r = await a.audit();
  const by = Object.fromEntries(r.prefixes.map((p) => [p.prefix, p]));
  assert.deepEqual(by['2026-VV-'], { prefix: '2026-VV-', boardMax: 7, folderMax: 8, highWater: 0, nextOldRule: '2026-VV-008', nextNewRule: '2026-VV-009', wouldHaveReused: true });
  assert.equal(by['2026-SP-'].nextNewRule, '2026-SP-016');
  assert.equal(by['2026-CEC-EE-'].wouldHaveReused, false);
  assert.equal(r.wouldHaveReused.length, 2);
  assert.deepEqual(r.duplicateRefsOnBoard.sort((x, y) => x.ref.localeCompare(y.ref)), [{ ref: '2026-CEC-EE-086', rows: 2 }, { ref: '2026-VV-007', rows: 2 }]);
}));

test('the probe checks all four boards that carry references (Cases, Documents, Questionnaire, Family)', () => {
  const src = fs.readFileSync(require.resolve('../src/services/caseRefAllocator'), 'utf8');
  for (const needle of ['[clientMasterBoardId, CM_REF_COL]', '[EXEC_BOARD, EXEC_REF_COL]', '[Q_BOARD, Q_REF_COL]', '[FAMILY_BOARD, FAMILY_REF_COL]']) assert.ok(src.includes(needle), needle);
  assert.match(src, /EXEC_REF_COL\s+= 'text_mm0z2cck'/);
  assert.match(src, /Q_REF_COL\s+= 'text_mm12dgy9'/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /mutation|create_update|change_column/, 'the allocator only reads');
});

/* ───────────── caseRefService: the assignment flow ───────────── */

function serviceHarness({ existingRef = '', existingAfterLock = '', allocate, dupRows = [] } = {}) {
  const calls = { queries: [], notes: [], writes: [] };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  let reads = 0;
  set('../src/services/mondayApi', { query: async (q, v) => {
    calls.queries.push(q);
    if (/items\(ids: \[\$itemId\]\)[\s\S]*column_values\(ids: \["text_mm142s49"\]\)/.test(q)) { reads++; const t = reads === 1 ? existingRef : existingAfterLock; return { items: [{ column_values: [{ text: t }] }] }; }
    if (/change_column_value[\s\S]*text_mm142s49/.test(q)) { calls.writes.push(JSON.parse(v.value)); return {}; }
    if (/items_page_by_column_values[\s\S]*text_mm142s49/.test(q)) return { items_page_by_column_values: { items: [{ id: String(v.b === 'x' ? 0 : '111'), name: 'This case' }, ...dupRows] } };
    if (/create_update/.test(q)) { calls.notes.push(v.body); return {}; }
    return { items: [], boards: [{ items_page: { items: [], cursor: null } }] };
  } });
  const alloc = fresh();
  alloc.allocate = allocate || (async (prefix) => ({ ref: `${prefix}009`, seq: 9, from: { board: 7, folders: 8, recent: 0 }, skipped: [], folderCheck: 'ok' }));
  const p = require.resolve('../src/services/caseRefService');
  delete require.cache[p];
  const svc = require(p);
  return { svc, calls, alloc };
}

test('assignment: the number comes from the allocator, is written once, remembered, and double-checked; the old "board + 1" code is gone', quiet(async () => {
  const { svc, calls } = serviceHarness();
  const r = await svc.generateCaseRef('Visitor Visa');
  assert.match(r, /^\d{4}-VV-009$/);
  const src = fs.readFileSync(require.resolve('../src/services/caseRefService'), 'utf8');
  assert.doesNotMatch(src, /getAllCaseRefs|maxSeq \+ 1/, 'the board-only rule is gone');
  assert.match(src, /allocator\.withAllocationLock\(async \(\) => \{\s*const again = await getItemCaseRef\(itemId\);/, 'the "already has one?" check is repeated inside the lock');
  assert.match(src, /allocator\.recordAssigned\(a\.ref\)/);
  assert.equal(calls.writes.length, 0);
}));

test('checkAssignedRef: another row with the same number → a note on the case; OneDrive unchecked → a note; all clear → no note', quiet(async () => {
  const h1 = serviceHarness({ dupRows: [{ id: '222', name: 'Someone Else' }] });
  await h1.svc.checkAssignedRef({ itemId: '111', caseRef: '2026-VV-009', assigned: { folderCheck: 'ok' } });
  assert.equal(h1.calls.notes.length, 1);
  assert.match(h1.calls.notes[0], /2026-VV-009 is ALSO on "Someone Else" \(item 222\)/);
  const h2 = serviceHarness();
  await h2.svc.checkAssignedRef({ itemId: '111', caseRef: '2026-VV-009', assigned: { folderCheck: 'unavailable', folderError: 'token' } });
  assert.equal(h2.calls.notes.length, 1);
  assert.match(h2.calls.notes[0], /assigned while OneDrive could not be checked \(token\)/);
  const h3 = serviceHarness();
  await h3.svc.checkAssignedRef({ itemId: '111', caseRef: '2026-VV-009', assigned: { folderCheck: 'ok' } });
  assert.equal(h3.calls.notes.length, 0);
}));

test('prefixFor: the year and the case type\'s letters; unknown types → MISC', () => {
  const { svc } = serviceHarness();
  const y = new Date().getFullYear();
  assert.equal(svc.prefixFor('Visitor Visa'), `${y}-VV-`);
  assert.equal(svc.prefixFor('Canadian Experience Class (EE after ITA)'), `${y}-CEC-EE-`);
  assert.equal(svc.prefixFor('Something New'), `${y}-MISC-`);
});

test('the audit page is admin-only and read-only', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = src.indexOf("app.get('/admin/case-refs/audit'");
  assert.ok(i !== -1);
  const body = src.slice(i, i + 500);
  assert.ok(body.includes('resolveAdminOrReject'));
  assert.ok(body.includes("require('./services/caseRefAllocator').audit()"));
});

/* ───────────── onCaseTypeSet end to end (Monday, OneDrive and the follow-up steps stubbed) ───────────── */

function flowHarness({ refs = {}, board = [], folders = [] } = {}) {
  const writes = [], notes = [];
  const reads = {};   // itemId → number of getItemCaseRef reads
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/mondayApi', { query: async (q, v) => {
    if (/items\(ids: \[\$itemId\]\)[\s\S]*column_values\(ids: \["text_mm142s49"\]\)/.test(q)) {
      const id = String(v.itemId); reads[id] = (reads[id] || 0) + 1;
      const written = writes.filter((w) => w[0] === id).map((w) => w[1]).pop();   // the board shows what was written
      const r = refs[id]; const t = written || (typeof r === 'function' ? r(reads[id]) : (r || ''));
      return { items: [{ column_values: [{ text: t }] }] };
    }
    if (/change_column_value[\s\S]*text_mm142s49/.test(q)) { writes.push([String(v.itemId), JSON.parse(v.value)]); return {}; }
    if (/items_page_by_column_values[\s\S]*text_mm142s49/.test(q)) return { items_page_by_column_values: { items: writes.filter((w) => w[1] === v.v).map((w) => ({ id: w[0], name: 'case ' + w[0] })) } };
    if (/create_update/.test(q)) { notes.push(v.body); return {}; }
    return { items: [] };   // sub-type hint, rename lookups: nothing to do
  } });
  set('../src/services/accessTokenService', { ensureAccessToken: async () => {} });
  set('../src/services/clientPortalService', { buildPortalUrl: () => '', portalUrlFor: () => '' });
  set('../src/services/familyCompositionService', { createFamilyRowsForItem: async () => 0 });
  set('../src/services/sponsorOnboardingService', { ensureSponsor: async () => {} });
  const alloc = fresh();
  alloc.io.boardRefs = async () => [...board, ...writes.map((w) => w[1])];
  alloc.io.rootFolderNames = async () => folders;
  alloc.io.refInUse = async () => false;
  let markFile = null;   // the used-numbers record, in memory
  alloc.io.readMark = async () => (markFile ? { data: { ...markFile.data }, etag: markFile.etag } : null);
  alloc.io.writeMark = async (data) => { markFile = { data: { ...data }, etag: 'e' + Math.random() }; return {}; };
  alloc.io.writeBackup = async () => ({});
  const p = require.resolve('../src/services/caseRefService');
  delete require.cache[p];
  return { svc: require(p), writes, notes, reads, mark: () => markFile };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('onCaseTypeSet: a new case gets the next number that no leftover folder holds — written once, double-checked, no note when all is clear', quiet(async () => {
  const h = flowHarness({ board: ['2026-VV-007'].map((r) => r.replace('2026', String(new Date().getFullYear()))), folders: [`Praj - ${new Date().getFullYear()}-VV-008`] });
  await h.svc.onCaseTypeSet({ itemId: '111', caseType: 'Visitor Visa' });
  await settle();
  const y = new Date().getFullYear();
  assert.deepEqual(h.writes, [['111', `${y}-VV-009`]]);
  assert.equal(h.notes.length, 0);
  assert.equal(h.mark().data[`${y}-VV-`], 9, 'the used-numbers record now holds it');
  assert.equal(h.reads['111'], 2, 'asked once before the lock and once inside it');
}));

test('onCaseTypeSet: the same webhook twice, or a number written meanwhile — no second number', quiet(async () => {
  const h = flowHarness({ refs: { '111': (n) => (n === 1 ? '' : '2026-VV-005') } });
  await h.svc.onCaseTypeSet({ itemId: '111', caseType: 'Visitor Visa' });
  assert.equal(h.writes.length, 0, 'it got a number between the first read and the lock');
  // the same webhook delivered twice at once: both pass the first check, only one writes — the second sees the number inside the lock
  const h2 = flowHarness({ refs: {} });
  await Promise.all([h2.svc.onCaseTypeSet({ itemId: '111', caseType: 'Visitor Visa' }), h2.svc.onCaseTypeSet({ itemId: '111', caseType: 'Visitor Visa' })]);
  await settle();
  assert.equal(h2.writes.length, 1);
}));

test('onCaseTypeSet: two different cases of the same type at the same moment get different numbers', quiet(async () => {
  const h = flowHarness({ board: [] });
  await Promise.all([h.svc.onCaseTypeSet({ itemId: '111', caseType: 'Study Permit' }), h.svc.onCaseTypeSet({ itemId: '222', caseType: 'Study Permit' })]);
  await settle();
  const y = new Date().getFullYear();
  assert.deepEqual(h.writes.map((w) => w[1]).sort(), [`${y}-SP-001`, `${y}-SP-002`]);
}));

/* ───────────── the high-water mark (review round 1) ───────────── */

test('careful delete leaves nothing behind — the high-water mark still holds the number, so a later restore cannot collide', quiet(async () => {
  // the newest VV case (012) was careful-deleted: no row, no folder, no other rows — only the mark remembers it
  const { a } = harness({ board: ['2026-VV-011'], folders: ['X - 2026-VV-011'], mark: { '2026-VV-': 12 } });
  const r = await a.allocate('2026-VV-');
  assert.equal(r.ref, '2026-VV-013');
  assert.equal(r.from.mark, 12);
  assert.equal(r.markCheck, 'ok');
}));

test('recordAssigned raises the mark (never lowers it), creates the file the first time, and re-reads on a concurrent change', quiet(async () => {
  const h = harness({ board: [] });
  assert.equal(await h.a.recordAssigned('2026-VV-003'), true);
  assert.deepEqual(h.seen.file().data['2026-VV-'], 3, 'created');
  assert.equal(await h.a.recordAssigned('2026-VV-002'), true);
  assert.equal(h.seen.file().data['2026-VV-'], 3, 'never lowered');
  assert.equal(h.seen.markWrites.length, 1, 'no write when the mark is already higher');
  // someone else writes between our read and our write: we re-read and keep THEIR value too
  const real = h.a.io.readMark;
  let once = true;
  h.a.io.readMark = async () => { const r = await real(); if (once) { once = false; h.seen.setFile({ data: { ...h.seen.file().data, '2026-SP-': 9 }, etag: 'other' }); } return r; };
  assert.equal(await h.a.recordAssigned('2026-VV-004'), true);
  assert.deepEqual({ vv: h.seen.file().data['2026-VV-'], sp: h.seen.file().data['2026-SP-'] }, { vv: 4, sp: 9 }, 'the other writer\'s change is kept');
  assert.equal(await h.a.recordAssigned('Supervisa'), false, 'not a case number: nothing to record');
}));

test('the mark file cannot be read: the last one read is used ("stale"); never read → "unavailable", the rest still decides; saving it failing never breaks an assignment', quiet(async () => {
  const h = harness({ board: ['2026-VV-001'], mark: { '2026-VV-': 9 } });
  assert.equal((await h.a.allocate('2026-VV-')).ref, '2026-VV-010');
  h.a.io.readMark = async () => { throw new Error('down'); };
  const r = await h.a.allocate('2026-VV-');
  assert.equal(r.markCheck, 'stale'); assert.equal(r.ref, '2026-VV-010');
  const h2 = harness({ board: ['2026-VV-001'], markFail: true });
  const r2 = await h2.a.allocate('2026-VV-');
  assert.equal(r2.markCheck, 'unavailable'); assert.equal(r2.ref, '2026-VV-002');
  h2.a.io.writeMark = async () => { throw new Error('down'); };
  assert.equal(await h2.a.recordAssigned('2026-VV-002'), false);
  assert.equal((await h2.a.allocate('2026-VV-')).ref, '2026-VV-003', 'the process still remembers it');
}));

test('numbers handed out are remembered for the life of the process (not one hour): a stale listing after a long time still cannot reuse them', quiet(async () => {
  const h = harness({ board: ['2026-VV-001'], markFail: true });
  const r1 = await h.a.allocate('2026-VV-'); h.a.noteAssigned(r1.ref);
  h.advance(30 * 24 * 3600 * 1000);
  h.failFolders(5);
  assert.equal((await h.a.allocate('2026-VV-')).ref, '2026-VV-003');
}));

test('onCaseTypeSet saves the mark inside the lock, after the Monday write', () => {
  const src = fs.readFileSync(require.resolve('../src/services/caseRefService'), 'utf8');
  const i = src.indexOf('change_column_value(');
  const j = src.indexOf('a.markSaved = await allocator.recordAssigned(a.ref);');
  assert.ok(i !== -1 && j > i, 'recorded after the write');
  assert.ok(src.slice(src.indexOf('allocator.withAllocationLock'), j).includes('allocate(prefixFor(caseType))'));
});

test('the mark lives OUTSIDE "Client Documents" (no case listing or backfill ever sees it)', () => {
  const { MARK_PATH } = fresh();
  assert.equal(MARK_PATH, 'TDOT System/case-number-high-water.json');
  assert.ok(!MARK_PATH.startsWith('Client Documents'));
});

test('audit shows the high-water mark per prefix and counts it in the next number', quiet(async () => {
  const { a } = harness({ board: ['2026-VV-007'], folders: [], mark: { '2026-VV-': 12, '2026-LMIA-': 3, updatedAt: 'x' } });
  const r = await a.audit();
  const by = Object.fromEntries(r.prefixes.map((p) => [p.prefix, p]));
  assert.equal(by['2026-VV-'].highWater, 12);
  assert.equal(by['2026-VV-'].nextNewRule, '2026-VV-013');
  assert.equal(by['2026-LMIA-'].nextNewRule, '2026-LMIA-004', 'a prefix only the mark knows still shows');
  assert.ok(!r.prefixes.some((p) => p.prefix === 'updatedAt'));
}));

test('readJsonFile / writeJsonFile: read with the eTag; write only over that version (If-Match) or only when absent (If-None-Match: *); a 412 is a conflict; no file → null', async () => {
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const calls = [];
  let exists = true;
  set('axios', {
    get: async (url, cfg) => {
      calls.push(['get', decodeURIComponent(url)]);
      if (/root:\/TDOT System\/case-number-high-water.json:\?\$select=id,eTag/.test(decodeURIComponent(url))) { if (!exists) { const e = new Error('nf'); e.response = { status: 404 }; throw e; } return { data: { id: 'F', eTag: '"v7"' } }; }
      if (/\/items\/F\/content$/.test(url)) return { data: '{"2026-VV-":12}' };
      throw new Error('unexpected ' + url);
    },
    put: async (url, body, cfg) => {
      calls.push(['put', decodeURIComponent(url), cfg.headers['If-Match'], cfg.headers['If-None-Match'], body]);
      if (cfg.headers['If-Match'] === '"stale"') { const e = new Error('pre'); e.response = { status: 412 }; throw e; }
      return { data: { eTag: '"v8"' } };
    },
  });
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const od = require(p);
  assert.deepEqual(await od.readJsonFile('TDOT System/case-number-high-water.json'), { data: { '2026-VV-': 12 }, etag: '"v7"' });
  assert.deepEqual(await od.writeJsonFile('TDOT System/case-number-high-water.json', { '2026-VV-': 13 }, { etag: '"v7"' }), { etag: '"v8"' });
  assert.deepEqual(calls.at(-1).slice(1, 4), ['https://graph.microsoft.com/v1.0/users/' + calls.at(-1)[1].split('/users/')[1].split('/')[0] + '/drive/root:/TDOT System/case-number-high-water.json:/content', '"v7"', undefined].map((x, i) => (i === 0 ? calls.at(-1)[1] : x)));
  await od.writeJsonFile('TDOT System/case-number-high-water.json', { a: 1 });
  assert.deepEqual(calls.at(-1).slice(2, 4), [undefined, '*'], 'first creation: only if absent');
  await assert.rejects(() => od.writeJsonFile('TDOT System/case-number-high-water.json', { a: 1 }, { etag: '"stale"' }), (e) => e.conflict === true);
  exists = false;
  assert.equal(await od.readJsonFile('TDOT System/case-number-high-water.json'), null);
});

/* ───────────── review round 2 ───────────── */

test('seeding: the first allocation after deploy writes the board and folder maximums for EVERY prefix, so a number handed out before the file existed is protected too', quiet(async () => {
  const h = harness({ board: ['2026-SV-020', '2026-VV-007', 'Supervisa'], folders: ['Old - 2026-SP-031', 'ZZ (was 2026-VV-009)'] });
  await h.a.allocate('2026-VV-');
  const f = h.seen.file().data;
  assert.deepEqual({ sv: f['2026-SV-'], vv: f['2026-VV-'], sp: f['2026-SP-'] }, { sv: 20, vv: 9, sp: 31 });
  // SV-020 is then careful-deleted (row and folder gone): the next SV is still 021
  h.setBoard(['2026-VV-007']); h.setFolders([]);
  assert.equal((await h.a.allocate('2026-SV-')).ref, '2026-SV-021');
}));

test('seeding never lowers a mark and writes nothing when the file is already up to date', quiet(async () => {
  const h = harness({ board: ['2026-VV-007'], mark: { '2026-VV-': 15 } });
  await h.a.allocate('2026-VV-');
  assert.equal(h.seen.markWrites.length, 0);
  assert.equal(h.seen.file().data['2026-VV-'], 15);
}));

test('a corrupt file (hand-edited, not JSON) is rebuilt from what exists — after a copy of it is kept', quiet(async () => {
  const h = harness({ board: ['2026-VV-007'], mark: { x: 1 } });
  let corrupt = true;
  const realRead = h.a.io.readMark;
  h.a.io.readMark = async () => { if (corrupt) { const e = new Error('not valid JSON'); e.corrupt = true; e.etag = 'bad1'; e.raw = '{"2026-VV-": 12,}'; throw e; } return realRead(); };
  const realWrite = h.a.io.writeMark;
  h.a.io.writeMark = async (d, etag) => { const r = await realWrite(d, etag); corrupt = false; return r; };
  h.seen.setFile({ data: {}, etag: 'bad1' });
  const r = await h.a.allocate('2026-VV-');
  assert.equal(r.markCheck, 'corrupt');
  assert.equal(h.seen.backups.length, 1);
  assert.equal(h.seen.backups[0][0], '{"2026-VV-": 12,}');
  assert.equal(h.seen.file().data['2026-VV-'], 12, 'rebuilt over the damaged version (If-Match on its eTag) — keeping the 12 still readable in it, not lowering to the board\'s 7');
  assert.equal(r.ref, '2026-VV-013', 'and the salvaged 12 counts for this very allocation');
}));

test('reading the file is retried once; a single failure is not "unavailable"', quiet(async () => {
  const h = harness({ board: ['2026-VV-001'], mark: { '2026-VV-': 9 } });
  const real = h.a.io.readMark; let n = 0;
  h.a.io.readMark = async () => { if (n++ === 0) throw new Error('503'); return real(); };
  const r = await h.a.allocate('2026-VV-');
  assert.equal(r.markCheck, 'ok'); assert.equal(r.ref, '2026-VV-010');
}));

test('careful delete records the case number as used BEFORE deleting anything — and refuses to delete when it cannot', () => {
  const src = fs.readFileSync(require.resolve('../src/services/deletionService'), 'utf8');
  const rec = src.indexOf("require('./caseRefAllocator').recordAssigned(g.caseRef)");
  const firstDelete = src.indexOf('await deleteMondayRows(rows, countKey);');
  assert.ok(rec !== -1 && firstDelete !== -1 && rec < firstDelete, 'recorded before the first delete');
  assert.match(src.slice(rec, rec + 300), /if \(!saved\) bad\(`Could not record case number \$\{g\.caseRef\} as used/);
});

test('checkAssignedRef: the used-numbers record could not be read or saved → a staff note (not when OneDrive as a whole was down — that note already covers it)', quiet(async () => {
  const h1 = serviceHarness();
  await h1.svc.checkAssignedRef({ itemId: '111', caseRef: '2026-VV-009', assigned: { folderCheck: 'ok', markCheck: 'ok', markSaved: false } });
  assert.equal(h1.calls.notes.length, 1);
  assert.match(h1.calls.notes[0], /could not be saved to the record of numbers already used/);
  const h2 = serviceHarness();
  await h2.svc.checkAssignedRef({ itemId: '111', caseRef: '2026-VV-009', assigned: { folderCheck: 'ok', markCheck: 'unavailable', markSaved: true } });
  assert.match(h2.calls.notes[0], /could not be checked against the record/);
  const h3 = serviceHarness();
  await h3.svc.checkAssignedRef({ itemId: '111', caseRef: '2026-VV-009', assigned: { folderCheck: 'unavailable', markCheck: 'unavailable', markSaved: false } });
  assert.equal(h3.calls.notes.length, 1, 'one note, the OneDrive one');
}));

test('salvageMarks reads every "prefix": number pair out of damaged text (quoted numbers too); junk keys are ignored', () => {
  const { salvageMarks } = fresh();
  assert.deepEqual(salvageMarks('{"2026-VV-": 12, "2026-SP-":"31",, "2026-VV-": 9, "junk": 99, "updatedAt": "2026"'), { '2026-VV-': 12, '2026-SP-': 31 });
  assert.deepEqual(salvageMarks(''), {});
});

test('careful delete is never blocked by a damaged record: recordAssigned rebuilds it (copy kept, every readable number kept) with the deleted case\'s number in it', quiet(async () => {
  const h = harness({ board: [] });
  let corrupt = true;
  h.seen.setFile({ data: {}, etag: 'bad7' });
  const realRead = h.a.io.readMark;
  h.a.io.readMark = async () => { if (corrupt) { const e = new Error('not valid JSON'); e.corrupt = true; e.etag = 'bad7'; e.raw = '{"2026-VV-": 15, "2026-SP-": 4,'; throw e; } return realRead(); };
  const realWrite = h.a.io.writeMark;
  h.a.io.writeMark = async (d, etag) => { const r = await realWrite(d, etag); corrupt = false; return r; };
  assert.equal(await h.a.recordAssigned('2026-VV-011'), true);
  const f = h.seen.file().data;
  assert.deepEqual({ vv: f['2026-VV-'], sp: f['2026-SP-'] }, { vv: 15, sp: 4 }, 'never lowered: 15 stays, the deleted 011 is below it');
  assert.equal(h.seen.backups.length, 1);
  assert.equal(await h.a.recordAssigned('2026-LMIA-020'), true, 'the rebuilt file works normally afterwards');
  assert.equal(h.seen.file().data['2026-LMIA-'], 20);
}));
