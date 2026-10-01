'use strict';

// When two root folders carry one case reference, the one the case's Monday
// row LINKS wins (2026-10-01: a leftover test folder used to win on item count).
// No usable link → the old tie-break, exactly as before.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

function od(rootFolders) {
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', { get: async (url) => {
    if (/root:\/Client Documents:\/children/.test(decodeURIComponent(url))) return { data: { value: rootFolders.map((f) => ({ id: f.id, name: f.name, folder: { childCount: f.childCount } })) } };
    throw new Error('unexpected ' + url);
  } });
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const m = require(p);
  m._clearCaseFolderCache();
  return m;
}
const quiet = (fn) => async () => { const o = [console.warn, console.log]; console.warn = console.log = () => {}; try { return await fn(); } finally { [console.warn, console.log] = o; } };
const SPLIT = [{ id: 'TEST', name: 'Praj - 2026-VV-008', childCount: 13 }, { id: 'REAL', name: 'Ameena Begum - 2026-VV-008', childCount: 2 }];

test('two folders, Monday links the smaller one: the LINKED folder wins (resolution and lookup)', quiet(async () => {
  const m = od(SPLIT);
  m.setCaseFolderLinkLookup(async (ref) => (ref === '2026-VV-008' ? ['REAL'] : []));
  assert.equal(await m.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }), 'Ameena Begum - 2026-VV-008');
  m._clearCaseFolderCache();
  assert.equal((await m.findCaseFolderByRef('2026-VV-008')).id, 'REAL');
}));

test('no link, a link to neither folder, a failing lookup, or no lookup wired: the old tie-break (most items) — unchanged behaviour', quiet(async () => {
  for (const lookup of [async () => [], async () => ['ELSEWHERE'], async () => { throw new Error('Monday down'); }, null]) {
    const m = od(SPLIT);
    m.setCaseFolderLinkLookup(lookup);
    assert.equal(await m.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }), 'Praj - 2026-VV-008');
  }
}));

test('one folder: the lookup is never even asked (no extra Monday call on the normal path)', quiet(async () => {
  const m = od([{ id: 'REAL', name: 'Ameena Begum - 2026-VV-008', childCount: 2 }]);
  let asked = 0;
  m.setCaseFolderLinkLookup(async () => { asked++; return ['REAL']; });
  await m.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' });
  assert.equal(asked, 0);
}));

test('the live server wires the lookup at startup', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(src, /require\('\.\/services\/oneDriveService'\)\.setCaseFolderLinkLookup\(require\('\.\/services\/caseFolderLinkService'\)\.linkedFolderIds\)/);
});

test('caseFolderLinkService: one linked id → [id]; two rows linking different folders → [] (no authority); a failure → [] and not cached; cached 5 minutes', async () => {
  const p = require.resolve('../src/services/caseFolderLinkService');
  delete require.cache[p];
  const s = require(p);
  let rows = ['REAL'], calls = 0, t = 0;
  s.io.rows = async () => { calls++; if (rows === 'fail') throw new Error('Monday down'); return rows; };
  s.io.now = () => t;
  const o = console.warn; console.warn = () => {};
  try {
    assert.deepEqual(await s.linkedFolderIds('2026-VV-008'), ['REAL']);
    assert.deepEqual(await s.linkedFolderIds('2026-VV-008'), ['REAL']); assert.equal(calls, 1, 'cached');
    t += 5 * 60 * 1000 + 1; rows = ['A', 'B'];
    assert.deepEqual(await s.linkedFolderIds('2026-VV-008'), []);
    s._resetForTests(); rows = 'fail';
    assert.equal(await s.linkedFolderIds('2026-VV-009'), null, 'never read and failing: unknown (null), not "no link"');
    rows = ['X'];
    assert.deepEqual(await s.linkedFolderIds('2026-VV-009'), ['X'], 'a failure was not cached');
    assert.deepEqual(await s.linkedFolderIds(''), []);
    rows = ['', 'Z', 'Z'];
    s._resetForTests();
    assert.deepEqual(await s.linkedFolderIds('2026-VV-010'), ['Z'], 'blank ids ignored; the same id twice is one id');
  } finally { console.warn = o; }
  const src = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /mutation|create_update/, 'reads only');
});

test('the working-folders job chooses like the live app: the Monday-linked folder wins a split', () => {
  const p = require.resolve('../src/services/workFoldersBackfillService');
  delete require.cache[p];
  const { planBackfill } = require(p);
  const pick = (hits) => [...hits].sort((a, b) => (b.childCount || 0) - (a.childCount || 0))[0];
  const row = (caseRef, folderId) => ({ id: '1', name: 'Ameena', state: 'active', groupId: 'g', caseRef, folderId });
  assert.equal(planBackfill({ pick, rootFolders: SPLIT, cases: [row('2026-VV-008', 'REAL')] }).targets[0].folderId, 'REAL');
  assert.equal(planBackfill({ pick, rootFolders: SPLIT, cases: [row('2026-VV-008', '')] }).targets[0].folderId, 'TEST', 'no link → the tie-break, as before');
  assert.match(fs.readFileSync(p, 'utf8'), /column_values\(ids:\["\$\{CASE_REF_COL\}","\$\{FOLDER_ID_COL\}"\]\)/);
});

test('the e2e test script: refuses without --allow-production, uses ONLY the TEST group, and renames (never deletes) its folder off the number on clean-up', () => {
  const src = fs.readFileSync(require.resolve('../scripts/e2e-test.js'), 'utf8');
  assert.match(src, /if \(!ALLOW_PRODUCTION\) \{[\s\S]{0,300}process\.exit\(2\);/);
  assert.match(src, /const targetGroup = groups\.find\(g => g\.id === TEST_GROUP_ID\);/);
  assert.match(src, /TEST_GROUP_ID = 'group_mm3842s'/);
  assert.doesNotMatch(src, /\/active\|client\|lead\|new\/i/, 'the old "first live-looking group" pick is gone');
  assert.match(src, /oneDrive\.renameItemById\(\{ itemId: h\.id, newName: `ZZ-TEST E2E \$\{stamp\} \(was \$\{testCaseRef\}\)` \}\)/);
  assert.match(src, /filter\(\(x\) => String\(x\.name\)\.startsWith\('TEST CLIENT - E2E'\)\)/, 'only its own folders');
  assert.doesNotMatch(src, /deleteItem|axios\.delete|\/content`, \{ method: 'DELETE'/);
});

/* ───────────── review round 1: the link choice is sticky ───────────── */

test('a link Monday gave once survives a failed read later (last good answer) — the case never flips back to the leftover folder', async () => {
  const p = require.resolve('../src/services/caseFolderLinkService');
  delete require.cache[p];
  const s = require(p);
  let fail = false, t = 0;
  s.io.rows = async () => { if (fail) throw new Error('Monday complexity budget'); return ['REAL']; };
  s.io.now = () => t;
  const o = console.warn; console.warn = () => {};
  try {
    assert.deepEqual(await s.linkedFolderIds('2026-VV-008'), ['REAL']);
    t += 6 * 60 * 1000; fail = true;
    assert.deepEqual(await s.linkedFolderIds('2026-VV-008'), ['REAL'], 'stale-on-error');
  } finally { console.warn = o; }
});

test('a folder chosen BY THE LINK is kept as authoritative: a later lookup whose Monday read fails does not swap it for the tie-break', quiet(async () => {
  const m = od(SPLIT);
  let fail = false;
  m.setCaseFolderLinkLookup(async () => { if (fail) throw new Error('down'); return ['REAL']; });
  assert.equal((await m.findCaseFolderByRef('2026-VV-008')).id, 'REAL');
  fail = true;
  assert.equal((await m.findCaseFolderByRef('2026-VV-008')).id, 'REAL', 'the cached linked choice outranks a fresh tie-break');
  assert.equal(await m.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }), 'Ameena Begum - 2026-VV-008');
}));

test('the e2e script puts its case back in TEST right after "paid" (which moves it to the live group) and checks it stayed there', () => {
  const src = fs.readFileSync(require.resolve('../scripts/e2e-test.js'), 'utf8');
  const paid = src.indexOf('await onRetainerPaid({ itemId: testItemId });');
  const back = src.indexOf("moveCaseToGroup(testItemId, TEST_GROUP_ID, 'TEST group')", paid);
  assert.ok(paid !== -1 && back !== -1 && back - paid < 300, 'moved back immediately after Step 4');
  assert.match(src, /record\('Test case stayed in the TEST group', gid === TEST_GROUP_ID/);
});

test('right after a restart, a failed Monday read makes the tie-break a GUESS: kept 30 s, not 10 min — when Monday answers, the linked folder wins', quiet(async () => {
  const m = od(SPLIT);
  let fail = true, now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    m.setCaseFolderLinkLookup(async () => (fail ? null : ['REAL']));
    assert.equal(await m.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }), 'Praj - 2026-VV-008', 'a guess while Monday is unreadable');
    fail = false;
    now += 31 * 1000;
    assert.equal(await m.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }), 'Ameena Begum - 2026-VV-008', 'asked again after 30 s');
  } finally { Date.now = realNow; }
}));
