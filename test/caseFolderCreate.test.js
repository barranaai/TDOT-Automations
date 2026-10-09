'use strict';

// Staff action "Create case folder" (2026-10-10, 2026-CEC-EE-025): a case with
// NO OneDrive folder gets "Client Documents/<case name> - <ref>" + the four
// working folders, linked on its Client Master row, one note — nothing else.
// It refuses whenever the case might already have a folder, and whenever it
// cannot be sure. A folder it made but could not link is linked by a second
// press ("finish"), never duplicated.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const svc      = require('../src/services/caseFolderCreateService');
const oneDrive = require('../src/services/oneDriveService');

const REF  = '2026-CEC-EE-025';
const NAME = 'Mohammed Sohail Ranebennur (2491) E004186232';
const FOLDER = `${NAME} - ${REF}`;
const WORK = ['1-Coordinator-Working', '2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'];
const NOW = Date.parse('2026-10-10T15:00:00Z');

const row = (o = {}) => ({ itemId: '12374687942', name: NAME, groupId: 'group_mm3twy0r', ref: REF, folderId: '', folderLink: '', assignees: { personIds: ['50811878'], teamIds: [] }, ...o });
const other = (name, id = 'X' + name.length) => ({ id, name, childCount: 3, createdAt: '2026-06-01T00:00:00Z' });

/** Stubs every io seam; records the order of calls. */
function world({ rows = [row()], rowsAfter = null, claims = [], held = false, root = [other('Someone Else - 2026-CEC-EE-024')], rootAfter = null, tree = null,
  create = null, work = null, link = 'https://org/link/NEW', write = null, note = null, item = null, leadFail = false, rootFail = false, rowsFail = false } = {}) {
  const calls = [];
  const saved = {};
  const stub = (k, fn) => { saved[k] = svc.io[k]; svc.io[k] = async (...a) => { calls.push([k, ...a]); return fn(...a); }; };
  let rowReads = 0, rootReads = 0;
  stub('caseRows', () => { rowReads++; if (rowsFail === true || (rowsFail === 'second' && rowReads > 1)) throw new Error('Monday 503'); return (rowReads > 1 && rowsAfter) ? rowsAfter : rows; });
  stub('leadClaims', () => { if (leadFail) throw new Error('lead board down'); return claims; });
  saved.isHeld = svc.io.isHeld; svc.io.isHeld = (ref) => { calls.push(['isHeld', ref]); return held; };
  stub('listRoot', () => { rootReads++; if (rootFail === true || (rootFail === 'second' && rootReads > 1)) throw new Error('Graph 503'); return (rootReads > 1 && rootAfter) ? rootAfter : root; });
  stub('folderTree', () => tree);
  stub('createFolder', create || (() => ({ id: 'NEW', name: FOLDER, webUrl: 'https://w/NEW', created: true, createdAt: '2026-10-10T15:00:01Z' })));
  stub('driveItem', item || (() => ({ id: 'NEW', name: FOLDER, webUrl: 'https://w/NEW', parentPath: '/drive/root:/Client Documents' })));
  stub('workFolders', work || (() => ({ created: WORK.slice(), present: [] })));
  stub('orgLink', typeof link === 'function' ? link : () => link);
  stub('writeFolder', write || (() => ({})));
  stub('postNote', note || (() => ({})));
  saved.forget = svc.io.forget; svc.io.forget = (ref) => { calls.push(['forget', ref]); };
  saved.now = svc.io.now; svc.io.now = () => NOW;
  return { calls, names: () => calls.map((c) => c[0]), restore: () => Object.assign(svc.io, saved) };
}
const afterCreate = (extra = []) => [other('Someone Else - 2026-CEC-EE-024'), { id: 'NEW', name: FOLDER, childCount: 0, createdAt: '2026-10-10T15:00:01Z' }, ...extra];
const ACTOR = { name: 'Deeksha Sharma' };

// ── decide (pure) ────────────────────────────────────────────────────────────
test('decide: every refusal, and "missing" names the folder exactly as the app’s own creators do', () => {
  const d = (o) => svc.decide({ ref: REF, rows: [row()], claims: [], rootFolders: [], now: NOW, ...o });
  assert.equal(svc.decide({ ref: REF, rows: [] }).state, 'not-found');
  assert.equal(d({ rows: [row(), row({ itemId: '2' })] }).state, 'duplicate-ref');
  assert.equal(d({ rows: [row({ groupId: 'group_mm3842s' })] }).state, 'test-case');
  assert.equal(d({ ref: '2026-SP-004', rows: [row({ ref: '2026-SP-004' })] }).state, 'test-case', 'the working-folders LEAVE_OUT list is a test case here too');
  assert.equal(d({ rows: [row({ name: '' })] }).state, 'no-name');
  assert.equal(d({ rows: [row({ name: 'Unknown Client' })] }).state, 'no-name');
  assert.equal(d({ rows: [row({ folderLink: 'https://x' })] }).state, 'recorded');
  assert.equal(d({ rows: [row({ folderId: 'ABC', folderLink: 'https://x' })] }).state, 'recorded');
  // recorded by id, no staff link: link THAT folder (checked in OneDrive), never make another
  assert.equal(d({ rows: [row({ folderId: 'ABC' })] }).state, 'recorded-id', 'not checked in OneDrive yet');
  assert.equal(d({ rows: [row({ folderId: 'ABC' })], recordedItem: null }).state, 'recorded-missing');
  assert.equal(d({ rows: [row({ folderId: 'ABC' })], recordedItem: { id: 'ABC', name: FOLDER, parentPath: '/drive/root:/Client Documents/Old' } }).state, 'recorded-odd', 'not directly under the root');
  assert.equal(d({ rows: [row({ folderId: 'ABC' })], recordedItem: { id: 'ABC', name: 'Somebody - 2026-CEC-EE-024', parentPath: '/drive/root:/Client Documents' } }).state, 'recorded-odd', 'another case’s folder');
  for (const n of ['ZZ-TEST Folder (was 2026-CEC-EE-025)', FOLDER + ' 1', 'Mohammed S - LEAD-123']) {
    assert.equal(d({ rows: [row({ folderId: 'ABC' })], recordedItem: { id: 'ABC', name: n, parentPath: '/drive/root:/Client Documents' } }).state, 'recorded-odd', `"${n}" is not the app's case-folder shape`);
  }
  assert.equal(d({ rows: [row({ folderId: 'ABC' })], recordedItem: { id: 'ABC', name: 'mohammed s - 2026-cec-ee-025', parentPath: '/drive/root:/Client Documents' } }).state, 'unlinked', 'any case, as OneDrive');
  const lk = d({ rows: [row({ folderId: 'ABC' })], recordedItem: { id: 'ABC', name: FOLDER, parentPath: '/drive/root:/Client Documents' } });
  assert.deepEqual([lk.state, lk.canCreate, lk.mode, lk.name, lk.folderId], ['unlinked', true, 'link', FOLDER, 'ABC']);
  assert.equal(d({ rows: [row({ folderId: 'ABC' })], held: true, recordedItem: { id: 'ABC', name: FOLDER, parentPath: '/drive/root:/Client Documents' } }).state, 'held');
  assert.equal(d({ held: true }).state, 'held');
  assert.equal(d({ claims: [{ id: '777', folderId: 'LF' }] }).state, 'lead-folder');
  const lf = d({ claims: [{ id: '777', folderId: '' }], rootFolders: [other('Mohammed S - LEAD-777')] });
  assert.equal(lf.state, 'lead-folder', 'the intake folder of a lead that claims the case, even when the lead lost its folder id');
  assert.equal(d({ rootFolders: [other(FOLDER)] }).state, 'exists');
  assert.equal(d({ rootFolders: [other('mohammed sohail - 2026-cec-ee-025')] }).state, 'exists', 'OneDrive ignores case — so does the check');
  assert.equal(d({ rootFolders: [other('ZZ-TEST Folder (was 2026-CEC-EE-025)')] }).state, 'exists', 'a repaired test folder still carrying the reference');
  assert.match(d({ rootFolders: [other('ZZ-TEST Folder (was 2026-CEC-EE-025)')] }).message, /leftover test folder/);
  assert.equal(d({ rootFolders: [other(FOLDER), other(FOLDER + ' 1', 'Y')] }).state, 'split');
  for (const n of ['X - 2026-CEC-EE-0250', 'X - 12026-CEC-EE-025', 'X - 2026-CEC-EE-02']) assert.equal(d({ rootFolders: [other(n)] }).state, 'missing', `"${n}" is another case`);
  const m = d({ rootFolders: [other('Someone Else - 2026-CEC-EE-024')] });
  assert.deepEqual([m.state, m.canCreate, m.mode, m.name], ['missing', true, 'create', FOLDER]);
  assert.equal(m.name, oneDrive.caseFolderName({ clientName: NAME, caseRef: REF }));
  for (const r of [d({ rows: [row({ folderId: 'A' })] }), d({ rootFolders: [other(FOLDER)] }), d({ held: true })]) assert.equal(r.canCreate, false);
  // every refusal tells staff nothing changed (or what to do)
  for (const st of [d({ rows: [row(), row({ itemId: '2' })] }), d({ rows: [row({ folderId: 'A' })] }), d({ rootFolders: [other(FOLDER)] }), d({ claims: [{ id: '1', folderId: 'F' }] })]) assert.match(st.message, /Nothing was changed/);
});

test('finish: ONLY a folder with exactly the expected name, under 24 h old, holding nothing but the empty working folders', () => {
  const f = { id: 'NEW', name: FOLDER, childCount: 4, createdAt: '2026-10-10T14:00:00Z' };
  const tree = (o = {}) => ({ folder: { id: 'NEW', name: FOLDER, createdAt: '2026-10-10T14:00:00Z' }, rootFiles: [], folders: WORK.map((n) => ({ id: n, name: n, files: [], nested: [] })), ...o });
  const ok = (o) => svc.finishable({ folder: f, name: FOLDER, tree: tree(), now: NOW, ...o });
  assert.equal(ok(), true);
  assert.equal(svc.finishable({ folder: f, name: FOLDER, tree: tree({ folders: [] }), now: NOW }), true, 'empty: the create landed, the work folders not yet');
  assert.equal(ok({ name: FOLDER + 'x' }), false, 'another name');
  assert.equal(ok({ now: Date.parse('2026-10-11T14:00:01Z') }), false, 'older than 24 h');
  assert.equal(svc.finishable({ folder: f, name: FOLDER, tree: tree({ rootFiles: [{ name: 'a.pdf' }] }), now: NOW }), false, 'a file in it');
  assert.equal(svc.finishable({ folder: f, name: FOLDER, tree: tree({ folders: [{ name: 'Questionnaire', files: [], nested: [] }] }), now: NOW }), false, 'a client save made it');
  assert.equal(svc.finishable({ folder: f, name: FOLDER, tree: tree({ folders: [{ name: '1-Coordinator-Working', files: [{ name: 'x' }], nested: [] }] }), now: NOW }), false, 'staff already filed into it');
  assert.equal(svc.finishable({ folder: f, name: FOLDER, tree: null, now: NOW }), false);
  assert.equal(svc.finishable({ folder: { ...f, id: 'OTHER' }, name: FOLDER, tree: tree(), now: NOW }), false, 'the tree is another folder');
  const st = svc.decide({ ref: REF, rows: [row()], rootFolders: [f], tree: tree(), now: NOW });
  assert.deepEqual([st.state, st.canCreate, st.mode, st.folderId], ['unrecorded-new', true, 'finish', 'NEW']);
});

// ── check (reads) ────────────────────────────────────────────────────────────
test('check fails closed: a read that does not answer is "try again", never "no folder"', async () => {
  for (const [o, re] of [[{ rowsFail: true }, /case row could not be read/], [{ leadFail: true }, /lead board could not be read/], [{ rootFail: true }, /OneDrive could not be checked/]]) {
    const w = world(o);
    try { await assert.rejects(svc.check({ caseRef: REF }), (e) => e.transient === true && re.test(e.message)); } finally { w.restore(); }
  }
  const w = world({});
  try {
    await assert.rejects(svc.check({ caseRef: 'bad ref!' }), (e) => e.badRequest === true);
    await assert.rejects(svc.check({ caseRef: REF, canSee: () => false }), (e) => e.forbidden === true);
    assert.ok(!w.names().includes('listRoot'), 'nothing in OneDrive is read for a viewer who may not see the case');
  } finally { w.restore(); }
});

test('check: a row-level refusal needs no OneDrive read; a held case is never listed as "no folder"', async () => {
  const w = world({ rows: [row({ folderLink: 'https://org/x' })] });
  try { const f = await svc.check({ caseRef: REF }); assert.equal(f.state, 'recorded'); assert.deepEqual(w.names(), ['caseRows']); } finally { w.restore(); }
  const idOnly = world({ rows: [row({ folderId: 'NEW' })] });
  try { const f = await svc.check({ caseRef: REF }); assert.deepEqual([f.state, f.mode], ['unlinked', 'link']); assert.deepEqual(idOnly.names(), ['caseRows', 'isHeld', 'driveItem'], 'the recorded folder is checked by id — no root listing, no lead read'); } finally { idOnly.restore(); }
  const idDown = world({ rows: [row({ folderId: 'NEW' })], item: () => { throw new Error('Graph 503'); } });
  try { await assert.rejects(svc.check({ caseRef: REF }), (e) => e.transient === true); } finally { idDown.restore(); }
  const h = world({ held: true });
  try { const f = await svc.check({ caseRef: REF }); assert.equal(f.state, 'held'); assert.ok(!h.names().includes('listRoot')); } finally { h.restore(); }
  const l = world({ rows: [row({ ref: '2026-cec-ee-025' })] });
  try { const f = await svc.check({ caseRef: '2026-CEC-EE-025' }); assert.equal(f.state, 'missing'); assert.equal(f.name, `${NAME} - 2026-cec-ee-025`, 'the reference as the ROW spells it'); } finally { l.restore(); }
  const p = world({});
  try { const v = svc.publicView(await svc.check({ caseRef: REF })); assert.deepEqual(Object.keys(v).sort(), ['canCreate', 'caseRef', 'folders', 'message', 'mode', 'name', 'ok', 'state', 'workFolders']); assert.deepEqual(v.workFolders, WORK); } finally { p.restore(); }
});

// ── create ───────────────────────────────────────────────────────────────────
test('create: the folder, the working folders, the link on the row (two columns only), one note — in that order, nothing else', async () => {
  const w = world({ rootAfter: afterCreate() });
  try {
    const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR });
    assert.deepEqual(w.names(), ['caseRows', 'isHeld', 'leadClaims', 'listRoot', 'createFolder', 'listRoot', 'workFolders', 'orgLink', 'caseRows', 'writeFolder', 'forget', 'postNote']);
    assert.deepEqual(w.calls.find((c) => c[0] === 'createFolder')[1], { clientName: NAME, caseRef: REF });
    assert.deepEqual(w.calls.find((c) => c[0] === 'workFolders')[1], { folderId: 'NEW', label: REF });
    assert.deepEqual(w.calls.find((c) => c[0] === 'writeFolder').slice(1), ['12374687942', { id: 'NEW', url: 'https://org/link/NEW' }]);
    const note = w.calls.filter((c) => c[0] === 'postNote');
    assert.equal(note.length, 1);
    assert.match(note[0][2], /^📁 <b>Case folder created<\/b> — “Client Documents\/Mohammed Sohail Ranebennur \(2491\) E004186232 - 2026-CEC-EE-025” was created by Deeksha Sharma, 10 Oct 2026, 11:00 am \(Toronto\)\. It holds the four working folders \(1-Coordinator-Working, 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC\)\. Linked on this row \(📁 OneDrive on the case page\)\. Nothing was sent to the client; the checklist, stage and payment are unchanged\. \(2026-CEC-EE-025\)$/);
    assert.deepEqual([r.ok, r.mode, r.created, r.recorded, r.noted, r.folderId], [true, 'create', true, 'linked', true, 'NEW']);
    assert.match(r.message, /^✓ Folder created: “Client Documents\/.* - 2026-CEC-EE-025” with the four working folders\. It is linked on the case/);
  } finally { w.restore(); }
});

test('the service touches nothing but the folder, its row and a note (no email, checklist, stage or payment code)', () => {
  const src = fs.readFileSync(require.resolve('../src/services/caseFolderCreateService'), 'utf8');
  for (const bad of ['emailService', 'sendIntakeEmail', 'checklistService', 'reseed', 'color_mm0x8faa', 'color_mm0x9fnn', 'retainerService', 'stageGateService']) assert.ok(!src.includes(bad), `no ${bad}`);
  assert.match(src, /JSON\.stringify\(\{ \.\.\.\(id \? \{ \[ID_COL\]: id \} : \{\}\), \[LINK_COL\]: \{ url, text: LINK_TEXT \} \}\)/, 'exactly the two folder columns, in the hand-off format');
  assert.equal(svc.LINK_TEXT, 'Open client folder');
  const cfg = require('../config/monday').cmColumns;
  assert.deepEqual([cfg.oneDriveFolderId, cfg.oneDriveFolderLink], ['text_mm47y540', 'link_mm47dng8']);
});

test('the Monday writes: the two columns in the format the lead hand-off uses, the note on the case row', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const orig = mondayApi.query; const seen = [];
  mondayApi.query = async (q, v) => { seen.push([q, v]); return {}; };
  try {
    await svc.io.writeFolder('123', { id: 'DRIVE-ID', url: 'https://org/x' });
    await svc.io.postNote('123', '📁 hi');
    await svc.io.writeFolder('123', { id: '', url: 'https://org/y' });
  } finally { mondayApi.query = orig; }
  assert.deepEqual(JSON.parse(seen[2][1].c), { link_mm47dng8: { url: 'https://org/y', text: 'Open client folder' } }, 'the id is never rewritten when the row has it');
  assert.match(seen[0][0], /change_multiple_column_values\(board_id: \$b, item_id: \$i, column_values: \$c\)/);
  assert.deepEqual(JSON.parse(seen[0][1].c), { text_mm47y540: 'DRIVE-ID', link_mm47dng8: { url: 'https://org/x', text: 'Open client folder' } });
  assert.equal(seen[0][1].i, '123');
  assert.match(seen[1][0], /create_update\(item_id: \$i, body: \$b\)/);
  assert.deepEqual(seen[1][1], { i: '123', b: '📁 hi' });
});

test('the row read: archived rows ignored, link URL from the JSON value, assignees from the people columns', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const orig = mondayApi.query; let q = '';
  mondayApi.query = async (gql) => { q = gql; return { items_page_by_column_values: { items: [
    { id: '1', name: ' Ada ', state: 'active', group: { id: 'g' }, column_values: [
      { id: 'text_mm142s49', text: REF }, { id: 'text_mm47y540', text: '' }, { id: 'link_mm47dng8', text: 'Open client folder - https://u', value: '{"url":"https://u","text":"Open client folder"}' },
      { id: 'multiple_person_mm0xhmgk', value: '{"personsAndTeams":[{"id":50811878,"kind":"person"}]}' }] },
    { id: '2', name: 'Old', state: 'archived', group: { id: 'g' }, column_values: [{ id: 'text_mm142s49', text: REF }] },
  ] } }; };
  try {
    const rows = await svc.io.caseRows(REF);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].itemId, rows[0].name, rows[0].ref, rows[0].folderLink, rows[0].folderId], ['1', 'Ada', REF, 'https://u', '']);
    assert.deepEqual(rows[0].assignees.personIds, ['50811878']);
    assert.match(q, /limit: 10/, 'more than one row is seen — a duplicated reference is refused, not hidden');
  } finally { mondayApi.query = orig; }
});

test('create re-checks everything live: a changed name, a folder that appeared, a second press while the first runs — refused, nothing made', async () => {
  const w = world({});
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: 'Someone else - ' + REF, actor: ACTOR }), (e) => e.refused && e.reason === 'changed');
    assert.ok(!w.names().includes('createFolder'));
  } finally { w.restore(); }
  const x = world({ root: [other(FOLDER)] });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.refused && e.reason === 'exists' && /Nothing was changed/.test(e.message));
    assert.ok(!x.names().includes('createFolder') && !x.names().includes('writeFolder') && !x.names().includes('postNote'));
  } finally { x.restore(); }
  let release;
  const slow = world({ rootAfter: afterCreate(), create: () => new Promise((r) => { release = () => r({ id: 'NEW', name: FOLDER, webUrl: 'https://w/NEW', created: true }); }) });
  try {
    const first = svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    await assert.rejects(svc.createCaseFolder({ caseRef: REF.toLowerCase(), expectName: FOLDER, actor: ACTOR }), (e) => e.refused && e.reason === 'in-progress');
    while (!release) await new Promise((r) => setImmediate(r));
    release(); await first;
    assert.equal(slow.names().filter((n) => n === 'createFolder').length, 1);
    assert.equal(svc._inFlight.size, 0, 'the lock is released');
  } finally { slow.restore(); }
});

test('after the create, exactly ONE folder may carry the reference — otherwise nothing is linked and an admin is told', async () => {
  const split = world({ rootAfter: afterCreate([other('Mohammed S - 2026-CEC-EE-025', 'OTHER')]) });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && /another folder carries the reference/.test(e.message));
    assert.ok(!split.names().includes('writeFolder') && !split.names().includes('workFolders'));
    assert.match(split.calls.find((c) => c[0] === 'postNote')[2], /^⚠️ <b>Case folder not linked<\/b>/);
  } finally { split.restore(); }
  const blind = world({ rootFail: 'second' });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && e.reason === 'not-linked' && /Press the button again/.test(e.message));
    assert.ok(!blind.names().includes('writeFolder'), 'unchecked is not fine: not linked');
  } finally { blind.restore(); }
  // a fresh folder missing from the listing is confirmed by id (parent = the root, same name)
  const lag = world({ rootAfter: [other('Someone Else - 2026-CEC-EE-024')] });
  try { const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }); assert.equal(r.recorded, 'linked'); assert.ok(lag.names().includes('driveItem')); } finally { lag.restore(); }
  const elsewhere = world({ rootAfter: [other('Someone Else - 2026-CEC-EE-024')], item: () => ({ id: 'NEW', name: FOLDER, parentPath: '/drive/root:/Client Documents/Other' }) });
  try { await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial); assert.ok(!elsewhere.names().includes('writeFolder')); } finally { elsewhere.restore(); }
});

test('the same name made at the same moment by a client save is linked (one folder), and said so', async () => {
  const w = world({ rootAfter: afterCreate(), create: () => ({ id: 'NEW', name: FOLDER, webUrl: 'https://w/NEW', created: false }) });
  try {
    const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR });
    assert.deepEqual([r.created, r.recorded], [false, 'linked']);
    assert.match(w.calls.find((c) => c[0] === 'postNote')[2], /^📁 <b>Case folder linked<\/b> — .* was made at the same moment by another step of the app and is now linked/);
  } finally { w.restore(); }
});

test('the working folders failing is reported (the shared note the Summary tab tracks); the folder is still linked', async () => {
  const w = world({ rootAfter: afterCreate(), work: () => { const e = new Error('Graph 503'); e.missing = ['3-AW-Analyst-Final-RCIC']; throw e; } });
  try {
    const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR });
    assert.deepEqual(r.workFolders.missing, ['3-AW-Analyst-Final-RCIC']);
    assert.equal(r.recorded, 'linked');
    const notes = w.calls.filter((c) => c[0] === 'postNote').map((c) => c[2]);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /Could not create the working folder/, 'the shared wording (needsAttention workFoldersFailed)');
    assert.match(notes[1], /The working folder\(s\) 3-AW-Analyst-Final-RCIC still need to be added/);
    assert.match(r.message, /Some working folders could not be made \(3-AW-Analyst-Final-RCIC\)/);
  } finally { w.restore(); }
});

test('the link: the organisation link ONLY — without one nothing is written and a second press links it', async () => {
  for (const link of [() => { throw new Error('createLink 503'); }, () => '']) {
    const w = world({ rootAfter: afterCreate(), link });
    try {
      await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && e.reason === 'not-linked' && /staff link to it could not be made/.test(e.message) && /Press the button again/.test(e.message));
      assert.ok(!w.names().includes('writeFolder'), 'never the noreply drive’s own URL, never an empty link');
    } finally { w.restore(); }
  }
  // the second press: the folder now holds the four EMPTY working folders → finish
  const tree = { folder: { id: 'NEW', name: FOLDER, createdAt: '2026-10-10T14:59:00Z' }, rootFiles: [], folders: WORK.map((n) => ({ id: n, name: n, files: [], nested: [] })) };
  const f2 = world({ root: [{ id: 'NEW', name: FOLDER, childCount: 4, createdAt: '2026-10-10T14:59:00Z' }], tree });
  try { const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }); assert.deepEqual([r.mode, r.recorded, r.url], ['finish', 'linked', 'https://org/link/NEW']); } finally { f2.restore(); }
});

test('link mode: a row recording the folder id but no link gets the link to THAT folder — no create, no listing, the id untouched', async () => {
  const w = world({ rows: [row({ folderId: 'NEW' })] });
  try {
    const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR });
    assert.ok(!w.names().includes('createFolder') && !w.names().includes('listRoot'));
    assert.deepEqual(w.calls.find((c) => c[0] === 'writeFolder').slice(1), ['12374687942', { id: '', url: 'https://org/link/NEW' }]);
    assert.deepEqual([r.mode, r.created, r.recorded], ['link', false, 'linked']);
    assert.match(w.calls.find((c) => c[0] === 'postNote')[2], /^📁 <b>Case folder link added<\/b> — “Client Documents\/.*”, recorded on this row, now has its staff link by /);
    assert.match(r.message, /^✓ Link added: /);
  } finally { w.restore(); }
});

test('a not-linked message never claims an admin note that could not be posted', async () => {
  const w = world({ rootAfter: afterCreate([other('Mohammed S - 2026-CEC-EE-025', 'OTHER')]), note: () => { throw new Error('Monday 503'); } });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && /The note for an admin could not be posted — tell an admin: “Client Documents\/.* - 2026-CEC-EE-025” is not linked on 2026-CEC-EE-025\./.test(e.message) && !/A note is on the case/.test(e.message));
  } finally { w.restore(); }
  const raced = world({ rootAfter: afterCreate(), rowsAfter: [row({ folderId: 'SOMETHING-ELSE' })], note: () => { throw new Error('Monday 503'); } });
  try { await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => /tell an admin/.test(e.message)); } finally { raced.restore(); }
  const lost = world({ rootAfter: [other('Someone Else - 2026-CEC-EE-024')], item: () => { throw new Error('Graph 503'); } });
  try { await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.reason === 'unconfirmed' && /Pressing the button again once OneDrive answers links it\./.test(e.message)); } finally { lost.restore(); }
});

test('the row is never overwritten: re-read just before writing; unreadable or another folder recorded → not linked, said plainly', async () => {
  const gone = world({ rootAfter: afterCreate(), rowsFail: 'second' });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && /could not be re-read/.test(e.message) && /was created/.test(e.message));
    assert.ok(!gone.names().includes('writeFolder'));
  } finally { gone.restore(); }
  const raced = world({ rootAfter: afterCreate(), rowsAfter: [row({ folderId: 'SOMETHING-ELSE' })] });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && e.reason === 'other-folder-recorded');
    assert.ok(!raced.names().includes('writeFolder'));
    assert.match(raced.calls.filter((c) => c[0] === 'postNote').pop()[2], /already records a different folder/);
  } finally { raced.restore(); }
  // the SAME folder's id recorded meanwhile (no link): only the missing link is written
  const same = world({ rootAfter: afterCreate(), rowsAfter: [row({ folderId: 'NEW' })] });
  try { const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }); assert.equal(r.recorded, 'linked'); assert.deepEqual(same.calls.find((c) => c[0] === 'writeFolder')[2], { id: '', url: 'https://org/link/NEW' }); } finally { same.restore(); }
  // a link recorded meanwhile: left as it was
  const linked = world({ rootAfter: afterCreate(), rowsAfter: [row({ folderId: 'NEW', folderLink: 'https://org/old' })] });
  try { const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }); assert.equal(r.recorded, 'already'); assert.ok(!linked.names().includes('writeFolder')); assert.match(r.message, /already recorded a folder, so its link was left as it was/); } finally { linked.restore(); }
  const wfail = world({ rootAfter: afterCreate(), write: () => { throw new Error('Monday 500'); } });
  try { await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.partial && /could not be linked on the case row/.test(e.message) && /Press the button again/.test(e.message)); } finally { wfail.restore(); }
  const nofail = world({ rootAfter: afterCreate(), note: () => { throw new Error('Monday 500'); } });
  try { const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }); assert.equal(r.noted, false); assert.match(r.message, /note on the Monday item could not be posted/); } finally { nofail.restore(); }
});

test('a create that throws never says "nothing was changed" (it may have landed) — a second press finishes it', async () => {
  const w = world({ create: () => { const e = new Error('timeout'); e.transient = true; throw e; } });
  try {
    await assert.rejects(svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR }), (e) => e.createFailed && e.transient && /if it was made anyway, that links it/.test(e.message) && !/Nothing was changed/.test(e.message));
  } finally { w.restore(); }
  // the second press: the folder is there, empty, unlinked → finish (no second create)
  const tree = { folder: { id: 'NEW', name: FOLDER, createdAt: '2026-10-10T14:59:00Z' }, rootFiles: [], folders: [] };
  const f2 = world({ root: [{ id: 'NEW', name: FOLDER, childCount: 0, createdAt: '2026-10-10T14:59:00Z' }], tree });
  try {
    const c = await svc.check({ caseRef: REF });
    assert.deepEqual([c.state, c.mode], ['unrecorded-new', 'finish']);
    const r = await svc.createCaseFolder({ caseRef: REF, expectName: FOLDER, actor: ACTOR });
    assert.ok(!f2.names().includes('createFolder'), 'finish never creates');
    assert.deepEqual([r.mode, r.created, r.recorded], ['finish', false, 'linked']);
    assert.match(f2.calls.find((x) => x[0] === 'postNote')[2], /^📁 <b>Case folder linked<\/b> — “Client Documents\/.*”, made a moment ago, is now linked by/);
  } finally { f2.restore(); }
});

// ── oneDriveService.createCaseFolder (Graph) ─────────────────────────────────
function graph({ conflict = false, unauthorizedOnce = false } = {}) {
  const posts = [];
  let tokens = 0;
  const axios = {
    get: async (url) => {
      const u = decodeURIComponent(url);
      if (/root:\/Client Documents:\/children/.test(u)) return { data: { value: [] } };   // the root listing: no folder for the ref yet
      if (/root:\/Client Documents:$/.test(u.split('?')[0])) return { data: { id: 'ROOT', webUrl: 'https://w/root' } };   // the root itself (already there)
      if (/root:\/Client Documents\/.+ - 2026-VV-001:$/.test(u.split('?')[0])) return { data: { id: 'CASE-1', webUrl: 'https://w/case', createdDateTime: '2026-10-10T15:00:00Z' } };
      const e = new Error('itemNotFound'); e.response = { status: 404 }; throw e;
    },
    post: async (url, body, cfg) => {
      const u = decodeURIComponent(url);
      posts.push([u, body && body.name]);
      if (unauthorizedOnce && cfg.headers.Authorization === 'Bearer tok1' && /Client Documents:\/children/.test(u)) { const e = new Error('expired'); e.response = { status: 401 }; throw e; }
      if (/\/root\/children/.test(u)) { const e = new Error('nameAlreadyExists'); e.response = { status: 409 }; throw e; }
      if (/root:\/Client Documents:\/children/.test(u)) {
        if (conflict || posts.filter((p) => /Client Documents:\/children/.test(p[0])).length > 1) { const e = new Error('nameAlreadyExists'); e.response = { status: 409 }; throw e; }
        return { data: { id: 'CASE-1', webUrl: 'https://w/case', createdDateTime: '2026-10-10T15:00:00Z' } };
      }
      throw new Error('unexpected POST ' + u);
    },
  };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const saved = ['axios', '../src/services/microsoftMailService'].map((r) => [require.resolve(r), require.cache[require.resolve(r)]]);
  set('axios', axios);
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok' + (++tokens), invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  const savedDrive = require.cache[p];
  delete require.cache[p];
  const od = require(p);
  od._clearCaseFolderCache();
  return { od, posts, restore: () => { for (const [k, v] of saved) { if (v) require.cache[k] = v; else delete require.cache[k]; } require.cache[p] = savedDrive; } };
}

test('oneDriveService.createCaseFolder: the same name rule and create as every creator; says whether IT made the folder, also across a 401 re-run; adds no working folders itself', async () => {
  const a = graph();
  try {
    const r = await a.od.createCaseFolder({ clientName: 'Ada', caseRef: '2026-VV-001' });
    assert.deepEqual(r, { id: 'CASE-1', name: 'Ada - 2026-VV-001', webUrl: 'https://w/case', created: true, createdAt: '2026-10-10T15:00:00Z' });
    assert.ok(!a.posts.some((p) => /CASE-1\/children/.test(p[0])), 'the working folders are the caller’s job (so a failure reaches staff)');
  } finally { a.restore(); }
  const b = graph({ conflict: true });
  try { const r = await b.od.createCaseFolder({ clientName: 'Ada', caseRef: '2026-VV-001' }); assert.equal(r.created, false); assert.equal(r.id, 'CASE-1'); } finally { b.restore(); }
  const c = graph({ unauthorizedOnce: true });
  try { const r = await c.od.createCaseFolder({ clientName: 'Ada', caseRef: '2026-VV-001' }); assert.equal(r.id, 'CASE-1'); } finally { c.restore(); }
  const d = graph();
  try {
    d.od.holdCaseFolder('2026-VV-001', 'folder repair in progress');
    assert.equal(d.od.isCaseFolderHeld('2026-VV-001'), true);
    await assert.rejects(d.od.createCaseFolder({ clientName: 'Ada', caseRef: '2026-VV-001' }), (e) => e.held === true);
    d.od.releaseCaseFolder('2026-VV-001');
    assert.equal(d.od.isCaseFolderHeld('2026-VV-001'), false);
  } finally { d.restore(); }
});

// ── routes + page ────────────────────────────────────────────────────────────
const code = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
test('routes: GET checks, POST creates; signed-in viewer + assignment, never the case overview (it can create the folder itself); ids never from the body', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const g = src.indexOf("app.get('/admin/case-action/:caseRef/folder'");
  const p = src.indexOf("app.post('/admin/case-action/:caseRef/folder'");
  assert.ok(g > 0 && p > g);
  const get = code(src.slice(g, src.indexOf('\n});', g)));
  const post = code(src.slice(p, src.indexOf('\n});', p)));
  for (const r of [get, post]) {
    assert.ok(r.indexOf('caseFolderViewer(req, res)') < r.indexOf('caseFolderCreateService'), 'sign-in gate before the service');
    assert.ok(!/resolveCaseForWrite|getCaseOverview/.test(r));
    assert.ok(!/req\.body\.(itemId|folderId|name|staffName)/.test(r));
  }
  assert.match(post, /createCaseFolder\(\{ caseRef, expectName, actor: staffActor\(req\), canSee: who\.canSee \}\)/, 'actor from the sign-in, no typed name');
  assert.match(post, /if \(!expectName \|\| expectName\.length > 300\) return res\.status\(400\)/);
  assert.match(get, /svc\.publicView\(f\)/);
  const helper = code(src.slice(src.indexOf('function caseFolderViewer'), src.indexOf("app.get('/admin/case-action/:caseRef/folder'")));
  assert.match(helper, /viewer\.isAdmin \|\| caseAccess\.viewerCanSee\(assignees, viewer\)/);
  assert.match(helper, /err\.partial\)\s+return res\.status\(502\)/);
  assert.match(helper, /err\.transient\)\s+return res\.status\(503\)/);
  assert.match(helper, /err\.refused\)\s+return res\.status\(err\.reason === 'not-found' \? 404 : 409\)/);
});

test('page: the button only when no folder is linked and the row was read; check → confirm → create → reload; message outside the re-rendered row', () => {
  const html = require('../src/routes/adminCase').buildCockpitHTML(REF);
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  new Function(js);   // parses
  assert.match(js, /if \(d\.folderLink\) acts \+= .*📁 OneDrive<\/a>';\n[\s\S]*?else if \(!d\.cmUnavailable\) acts \+= '<button type="button" class="act-btn" id="folder-btn"/);
  assert.match(js, /if \(fbtn\) fbtn\.addEventListener\('click', caseFolder\);/);
  const block = js.slice(js.indexOf('function folderErr'), js.indexOf('function renderDocsTab'));
  assert.ok(!/[`\\]|\$\{/.test(block), 'no backtick, ${ or backslash inside the template-literal page script');
  const get = block.indexOf("fetch(url, { headers: headers, credentials: 'same-origin' })");
  const confirm = block.indexOf('window.confirm(');
  const post = block.indexOf("method: 'POST'");
  assert.ok(get > 0 && confirm > get && post > confirm, 'read-only check, then the confirm, then the create');
  assert.match(block, /body: JSON\.stringify\(\{ expectName: j\.name \}\)/);
  assert.match(block, /if \(res\.ok\) \{ actMsg\('folder-msg', 'ok', res\.j\.message\); loadCase\(\); \}/);
  assert.match(block, /if \(!j\.canCreate\) \{ again\(\); actMsg\('folder-msg', 'info', j\.message\); return null; \}/);
  const hd = html.slice(html.indexOf('<div class="case-hd">'), html.indexOf('<!-- Tabs -->'));
  assert.ok(hd.indexOf('id="folder-msg"') > hd.indexOf('id="c-actions"'), 'the message sits outside #c-actions (rebuilt on every load)');
  assert.match(html, /button\.act-btn:disabled/);
});
