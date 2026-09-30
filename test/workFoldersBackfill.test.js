'use strict';

// The four staff working folders for EVERY existing case folder (Faran,
// 2026-10-01: "make the same four folders for all the cases folders"). One
// admin job: a preview first (creates nothing), then the real run behind a
// confirmation text. Only the four exact names, only where missing, only in
// the folder the app itself uses for the case; nothing renamed, moved or
// deleted; TEST-group cases and lead folders are never touched.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const NAMES = ['1-Coordinator-Working', '2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'];

/* ───────────── OneDrive side: the preview mode and the root listing ───────────── */

function driveHarness(routes) {
  const calls = { get: [], post: [] };
  const axios = {
    get: async (url) => { const d = decodeURIComponent(url); calls.get.push(d); return routes.get(d); },
    post: async (url, body) => { const d = decodeURIComponent(url); calls.post.push([d, body && body.name]); return routes.post ? routes.post(d, body) : { data: { id: 'x' } }; },
  };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', axios);
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const svc = require(p);
  svc._clearCaseFolderCache();
  svc._resetWorkFoldersMemo();
  return { svc, calls };
}
const notFound = () => { const e = new Error('itemNotFound'); e.response = { status: 404 }; return e; };

test('preview (dryRun): ONE listing, NOTHING created, and it says which of the four are missing', async () => {
  const h = driveHarness({ get: () => ({ data: { value: [{ name: '2-Case-Manager-Draft', folder: {} }, { name: '1-Coordinator-Working', file: {} }, { name: 'Identity', folder: {} }] } }) });
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1', label: '2026-VV-001', dryRun: true });
  assert.deepEqual(r.present, ['2-Case-Manager-Draft']);
  assert.deepEqual(r.wouldCreate, ['1-Coordinator-Working', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'], 'a FILE with the name is not the folder');
  assert.deepEqual(r.created, []);
  assert.equal(h.calls.post.length, 0, 'a preview never writes');
  assert.equal(h.calls.get.length, 1);
});

test('a preview never marks a folder complete: the real run afterwards still looks and creates', async () => {
  const h = driveHarness({ get: () => ({ data: { value: [] } }) });
  await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1', dryRun: true });
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1' });
  assert.deepEqual(r.created, NAMES);
  assert.equal(h.calls.get.length, 2);
});

test('the case folder listing reads EVERY page: a working folder on page two counts as present, never re-created', async () => {
  const h = driveHarness({ get: (u) => (u.includes('skiptoken')
    ? { data: { value: [{ name: '4-Submitted-IRCC', folder: {} }] } }
    : { data: { value: [{ name: '1-Coordinator-Working', folder: {} }], '@odata.nextLink': 'https://graph/items/CASE-1/children?$skiptoken=2' } }) });
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1' });
  assert.deepEqual(r.created, ['2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC']);
  assert.deepEqual(r.present, ['1-Coordinator-Working', '4-Submitted-IRCC']);
});

test('listCaseFoldersInRoot: every page of "Client Documents", folders only, with their item counts', async () => {
  const h = driveHarness({ get: (u) => (u.includes('skiptoken')
    ? { data: { value: [{ id: 'B', name: 'Bo - 2026-VV-002', folder: { childCount: 3 }, createdDateTime: '2025-01-01T00:00:00Z' }] } }
    : { data: { value: [{ id: 'A', name: 'Ada - 2026-VV-001', folder: { childCount: 9 } }, { id: 'F', name: 'stray.pdf', file: {} }], '@odata.nextLink': 'https://graph/root:/Client Documents:/children?$skiptoken=2' } }) });
  const all = await h.svc.listCaseFoldersInRoot();
  assert.deepEqual(all.map((f) => [f.id, f.name, f.childCount]), [['A', 'Ada - 2026-VV-001', 9], ['B', 'Bo - 2026-VV-002', 3]]);
  assert.match(h.calls.get[0], /root:\/Client Documents:\/children/);
  assert.equal(h.calls.post.length, 0);
});

test('listCaseFoldersInRoot: no root yet = no folders; a stale page two FAILS the listing (a partial list would silently skip cases)', async () => {
  const h1 = driveHarness({ get: () => { throw notFound(); } });
  assert.deepEqual(await h1.svc.listCaseFoldersInRoot(), []);
  const h2 = driveHarness({ get: (u) => { if (u.includes('skiptoken')) throw notFound(); return { data: { value: [], '@odata.nextLink': 'https://graph/x?$skiptoken=2' } }; } });
  await assert.rejects(() => h2.svc.listCaseFoldersInRoot(), /root listing failed/);
});

/* ───────────── the plan: which folder, for which case ───────────── */

const pick = (hits) => [...hits].sort((a, b) => (b.childCount || 0) - (a.childCount || 0) || a.name.length - b.name.length)[0];
const svc = () => { const p = require.resolve('../src/services/workFoldersBackfillService'); delete require.cache[p]; return require(p); };
const row = (id, name, caseRef, extra = {}) => ({ id, name, state: 'active', groupId: 'group_live', groupTitle: 'Active', caseRef, ...extra });

test('plan: each case is matched to the folder ending " - <case ref>"; TEST group, archived rows and rows without a reference are left out', () => {
  const { planBackfill, TEST_GROUP_ID } = svc();
  const plan = planBackfill({
    pick,
    rootFolders: [
      { id: 'F1', name: 'Ada Lovelace - 2026-VV-001', childCount: 8 },
      { id: 'F2', name: 'Kamal - 2026-OSS-005', childCount: 4 },
      { id: 'F3', name: 'Old - 2026-SP-009', childCount: 4 },
      { id: 'L1', name: 'Lead Person - LEAD-12641191022', childCount: 1 },
    ],
    cases: [
      row('1', 'Ada Lovelace', '2026-VV-001'),
      row('2', 'KAMAL', '2026-OSS-005', { groupId: TEST_GROUP_ID, groupTitle: 'TEST' }),
      row('3', 'Old', '2026-SP-009', { state: 'archived' }),
      row('4', 'No Ref Yet', '   '),
      row('5', 'Ghost', '2026-PGWP-044'),
    ],
  });
  assert.deepEqual(plan.targets.map((t) => [t.folderId, t.refs]), [['F1', ['2026-VV-001']]]);
  assert.deepEqual(plan.counts.skipped, { 'TEST group': 1, 'not active': 1, 'no case reference': 1, 'no case folder in OneDrive': 1 });
  assert.equal(plan.counts.considered, 2);
  assert.ok(!plan.targets.some((t) => t.folderId === 'L1'), 'a lead folder is never a target');
});

test('plan: the match is exact — a longer reference, a copy, or a reference in the middle of a name is NOT this case', () => {
  const { planBackfill } = svc();
  const plan = planBackfill({
    pick,
    rootFolders: [
      { id: 'X1', name: 'Ada - 2026-VV-0061', childCount: 5 },
      { id: 'X2', name: 'Ada - 2026-VV-006 (old)', childCount: 5 },
      { id: 'X3', name: '2026-VV-006 - Ada', childCount: 5 },
      { id: 'X4', name: 'Ada-2026-VV-006', childCount: 5 },
    ],
    cases: [row('1', 'Ada', '2026-VV-006')],
  });
  assert.equal(plan.targets.length, 0);
  assert.deepEqual(plan.skipped, [{ caseRef: '2026-VV-006', name: 'Ada', reason: 'no case folder in OneDrive' }]);
});

test('plan: a client with TWO folders gets the four only in the one the app uses (the one holding the documents) — and it is flagged', () => {
  const { planBackfill } = svc();
  const plan = planBackfill({
    pick,
    rootFolders: [
      { id: 'OLD', name: 'Ada Lovelace - 2026-VV-001', childCount: 2 },
      { id: 'USED', name: 'Ada L - 2026-VV-001', childCount: 11 },
    ],
    cases: [row('1', 'Ada Lovelace', '2026-VV-001')],
  });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].folderId, 'USED');
  assert.equal(plan.targets[0].split, true);
  assert.deepEqual(plan.targets[0].splitNames.sort(), ['Ada L - 2026-VV-001', 'Ada Lovelace - 2026-VV-001']);
  assert.equal(plan.counts.splitCases, 1);
});

test('plan: the real pick rule is the app\'s own (oneDriveService.pickCaseFolder), not a copy', () => {
  const src = fs.readFileSync(require.resolve('../src/services/workFoldersBackfillService'), 'utf8');
  assert.match(src, /pick:\s+\(hits, ref\) => require\('\.\/oneDriveService'\)\.pickCaseFolder\(hits, ref\)/);
  assert.match(src, /planBackfill\(\{ cases, rootFolders, pick: io\.pick \}\)/);
});

test('plan: two rows carrying the same reference share ONE folder — it is visited once', () => {
  const { planBackfill } = svc();
  const plan = planBackfill({
    pick,
    rootFolders: [{ id: 'F1', name: 'Ada - 2026-VV-001', childCount: 3 }, { id: 'F2', name: 'Bo - 2026-VV-002', childCount: 3 }],
    cases: [row('1', 'Ada', '2026-VV-001'), row('2', 'Ada (dup row)', ' 2026-VV-001 '), row('3', 'Bo', '2026-VV-002')],
  });
  assert.deepEqual(plan.targets.map((t) => [t.folderId, t.refs, t.cases.length]), [['F1', ['2026-VV-001'], 2], ['F2', ['2026-VV-002'], 1]]);
});

/* ───────────── the job ───────────── */

function jobHarness({ cases, rootFolders, ensure } = {}) {
  const s = svc();
  s._resetForTests();
  const seen = { ensure: [], sleeps: [] };
  s.io.listCases       = async () => cases || [row('1', 'Ada', '2026-VV-001'), row('2', 'Bo', '2026-VV-002')];
  s.io.listRootFolders = async () => rootFolders || [{ id: 'F1', name: 'Ada - 2026-VV-001', childCount: 3 }, { id: 'F2', name: 'Bo - 2026-VV-002', childCount: 3 }];
  s.io.pick            = pick;
  s.io.sleep           = async (ms) => { seen.sleeps.push(ms); };
  s.io.ensure          = async (p) => { seen.ensure.push(p); return ensure ? ensure(p, seen) : (p.dryRun ? { created: [], present: [], wouldCreate: NAMES } : { created: NAMES, present: [] }); };
  return { s, seen };
}
const quiet = (fn) => async () => {   // the job logs every folder; keep the test output readable
  const o = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { [console.log, console.warn, console.error] = o; }
};

test('a start with no options is a PREVIEW: every folder is asked in preview mode and the totals say what WOULD be added', quiet(async () => {
  const { s, seen } = jobHarness();
  const r = s.startBackfill({ by: 'faran@x' });
  assert.equal(r.started, true);
  const st = await s._waitForTests();
  assert.equal(st.state, 'done');
  assert.equal(st.mode, 'preview (nothing created)');
  assert.ok(seen.ensure.length === 2 && seen.ensure.every((p) => p.dryRun === true));
  assert.deepEqual(st.totals, { folders: 2, alreadyComplete: 0, foldersToAdd: 8, created: 0, failedFolders: 0 });
}));

test('the REAL run needs the exact confirmation text — otherwise nothing starts and nothing is touched', quiet(async () => {
  for (const confirm of [undefined, '', 'yes', 'add-work-folders', ' ADD-WORK-FOLDERS']) {
    const { s, seen } = jobHarness();
    const r = s.startBackfill({ dryRun: false, confirm });
    assert.equal(r.started, false, `confirm=${JSON.stringify(confirm)}`);
    assert.match(r.reason, /ADD-WORK-FOLDERS/);
    await new Promise((res) => setImmediate(res));
    assert.equal(seen.ensure.length, 0);
    assert.equal(s.statusOf(), null);
  }
  const { s, seen } = jobHarness();
  assert.equal(s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' }).started, true);
  const st = await s._waitForTests();
  assert.ok(seen.ensure.every((p) => p.dryRun === false));
  assert.equal(st.totals.created, 8);
  assert.equal(st.mode, 'REAL RUN');
}));

test('the route: admin only, a preview unless dryRun:false AND the text are sent, status + abort admin only too', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  for (const route of ["app.post('/admin/onedrive/work-folders-backfill'", "app.get('/admin/onedrive/work-folders-backfill'", "app.post('/admin/onedrive/work-folders-backfill/abort'"]) {
    const i = src.indexOf(route);
    assert.ok(i !== -1, `${route} exists`);
    assert.ok(src.slice(i, i + 300).includes('resolveAdminOrReject'), `${route} is admin only`);
  }
  const i = src.indexOf("app.post('/admin/onedrive/work-folders-backfill'");
  assert.ok(src.slice(i, i + 600).includes('dryRun: body.dryRun !== false'), 'anything but an explicit false is a preview');
});

test('one job at a time: a second start while one runs is refused and the first carries on', quiet(async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { s } = jobHarness({ ensure: async (p) => { await gate; return { created: [], present: NAMES, wouldCreate: [] }; } });
  assert.equal(s.startBackfill({}).started, true);
  const second = s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  assert.equal(second.started, false);
  assert.match(second.reason, /already running/);
  release();
  const st = await s._waitForTests();
  assert.equal(st.mode, 'preview (nothing created)', 'the running preview was not replaced by a real run');
  assert.equal(st.totals.alreadyComplete, 2);
}));

test('abort: stops after the folder it is on; the rest are never touched', quiet(async () => {
  const folders = Array.from({ length: 6 }, (_, i) => ({ id: `F${i}`, name: `C${i} - 2026-VV-00${i}`, childCount: 1 }));
  const cases = folders.map((f, i) => row(String(i), `C${i}`, `2026-VV-00${i}`));
  let s;
  const h = jobHarness({ cases, rootFolders: folders, ensure: (p, seen) => { if (seen.ensure.length === 2) s.abortBackfill(); return { created: NAMES, present: [] }; } });
  s = h.s;
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(st.state, 'aborted');
  assert.equal(h.seen.ensure.length, 2);
  assert.equal(st.progress.done, 2);
  assert.deepEqual(s.abortBackfill(), { aborted: false, reason: 'Nothing is running.' });
}));

test('OneDrive throttling (429): waits what Graph asks, tries again, and the folder is done', quiet(async () => {
  let n = 0;
  const { s, seen } = jobHarness({
    cases: [row('1', 'Ada', '2026-VV-001')], rootFolders: [{ id: 'F1', name: 'Ada - 2026-VV-001', childCount: 3 }],
    ensure: () => { if (n++ === 0) { const e = new Error('tooManyRequests'); e.response = { status: 429, headers: { 'retry-after': '7' } }; e.transient = true; throw e; } return { created: NAMES, present: [] }; },
  });
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(n, 2);
  assert.ok(seen.sleeps.includes(7000), 'honours Retry-After');
  assert.equal(st.totals.created, 4);
  assert.equal(st.totals.failedFolders, 0);
  assert.equal(st.rows[0].error, undefined);
}));

test('a refusal (403) is not retried: that folder is reported with what is missing, and the job moves on', quiet(async () => {
  const { s, seen } = jobHarness({
    ensure: (p) => {
      if (p.folderId !== 'F1') return { created: NAMES, present: [] };
      const cause = new Error('accessDenied'); cause.response = { status: 403 };
      const e = new Error('working folders not created: 3-AW-Analyst-Final-RCIC (accessDenied)'); e.missing = ['3-AW-Analyst-Final-RCIC']; e.cause = cause; e.transient = true;
      throw e;
    },
  });
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(seen.ensure.filter((p) => p.folderId === 'F1').length, 1, 'no retry');
  assert.equal(st.state, 'done');
  assert.equal(st.totals.failedFolders, 1);
  assert.equal(st.totals.created, 4, 'the next folder still got its four');
  const bad = st.rows.find((r) => r.folder === 'Ada - 2026-VV-001');
  assert.deepEqual(bad.missing, ['3-AW-Analyst-Final-RCIC']);
}));

test('five folders failing in a row = OneDrive is down: the job stops and says so, instead of grinding through hundreds', quiet(async () => {
  const folders = Array.from({ length: 9 }, (_, i) => ({ id: `F${i}`, name: `C${i} - 2026-VV-00${i}`, childCount: 1 }));
  const cases = folders.map((f, i) => row(String(i), `C${i}`, `2026-VV-00${i}`));
  const { s, seen } = jobHarness({ cases, rootFolders: folders, ensure: () => { const e = new Error('forbidden'); e.response = { status: 403 }; throw e; } });
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(st.state, 'stopped');
  assert.equal(seen.ensure.length, 5);
  assert.match(st.error, /5 folders in a row failed/);
}));

test('the lists cannot be read (Monday or OneDrive down): the job fails before touching a single folder', quiet(async () => {
  const { s, seen } = jobHarness();
  s.io.listRootFolders = async () => { throw new Error('OneDrive root listing failed: 503'); };
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(st.state, 'failed');
  assert.match(st.error, /root listing failed/);
  assert.equal(seen.ensure.length, 0);
}));

test('paced: a pause between folders so OneDrive is never hammered', quiet(async () => {
  const { s, seen } = jobHarness();
  s.startBackfill({});
  await s._waitForTests();
  assert.deepEqual(seen.sleeps, [250, 250]);
}));

test('the status report: short by default (only folders that need or got something, failures and split clients); full on request with every skipped case', quiet(async () => {
  const { s } = jobHarness({ ensure: (p) => (p.folderId === 'F1' ? { created: [], present: NAMES, wouldCreate: [] } : { created: [], present: [], wouldCreate: NAMES }) });
  s.startBackfill({});
  await s._waitForTests();
  const short = s.statusOf();
  assert.deepEqual(short.rows.map((r) => r.folder), ['Bo - 2026-VV-002']);
  assert.equal(short.skipped, undefined);
  const full = s.statusOf({ full: true });
  assert.equal(full.rows.length, 2);
  assert.deepEqual(full.skipped, []);
  assert.deepEqual(short.totals, { folders: 2, alreadyComplete: 1, foldersToAdd: 4, created: 0, failedFolders: 0 });
}));

test('the job only ever ADDS: no rename, move or delete call anywhere in it', () => {
  const src = fs.readFileSync(require.resolve('../src/services/workFoldersBackfillService'), 'utf8');
  assert.doesNotMatch(src, /\.(delete|patch|put)\(|renameFolder|moveItem|deleteItem|change_column|create_update|mutation/i);
});

/* ───────────── review round 1: an honest count, a job that cannot hang ───────────── */

/** A fake case folder that remembers what was created, driven through the REAL ensureCaseWorkFolders. */
function statefulDrive({ onPost } = {}) {
  const inside = new Set();
  let posts = 0;
  let tok = 0;
  const axios = {
    get: async () => ({ data: { value: [...inside].map((name) => ({ name, folder: {} })) } }),
    post: async (url, body, cfg) => {
      const n = ++posts;
      const verdict = onPost ? onPost(body.name, n, cfg.headers.Authorization) : null;
      if (verdict === 'landed-but-timed-out') { inside.add(body.name); const e = new Error('timeout of 30000ms exceeded'); e.code = 'ECONNABORTED'; throw e; }
      if (verdict) throw verdict;
      if (inside.has(body.name)) { const e = new Error('nameAlreadyExists'); e.response = { status: 409 }; throw e; }
      inside.add(body.name);
      return { data: { id: 'sub-' + body.name } };
    },
  };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', axios);
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'Bearer-tok' + (++tok), invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const od = require(p);
  od._clearCaseFolderCache();
  od._resetWorkFoldersMemo();
  return { od, inside };
}
const status = (st) => { const e = new Error('HTTP ' + st); e.response = { status: st, headers: { 'retry-after': '1' } }; return e; };

test('a folder half-done then throttled: the retry finishes it AND the report still says all four were added by this run', quiet(async () => {
  const d = statefulDrive({ onPost: (name, n) => (n === 3 ? status(429) : null) });
  const { s } = jobHarness({ cases: [row('1', 'Ada', '2026-VV-001')], rootFolders: [{ id: 'F1', name: 'Ada - 2026-VV-001', childCount: 3 }] });
  s.io.ensure = d.od.ensureCaseWorkFolders;
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.deepEqual([...d.inside].sort(), NAMES);
  assert.deepEqual(st.rows[0].created, NAMES);
  assert.equal(st.rows[0].tries, 2);
  assert.equal(st.totals.created, 4);
  assert.equal(st.totals.alreadyComplete, 0);
}));

test('a create that timed out but landed anyway is counted as added by this run, not as "already there"', quiet(async () => {
  const d = statefulDrive({ onPost: (name, n) => (n === 2 ? 'landed-but-timed-out' : null) });
  const { s } = jobHarness({ cases: [row('1', 'Ada', '2026-VV-001')], rootFolders: [{ id: 'F1', name: 'Ada - 2026-VV-001', childCount: 3 }] });
  s.io.ensure = d.od.ensureCaseWorkFolders;
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.deepEqual(st.rows[0].created, NAMES);
  assert.equal(st.totals.created, 4);
  assert.equal(st.totals.alreadyComplete, 0);
}));

test('an expired token half-way through a folder: refreshed, finished, and what the first pass made is still reported as made', async () => {
  const d = statefulDrive({ onPost: (name, n, auth) => (n === 3 && auth === 'Bearer Bearer-tok1' ? status(401) : null) });
  const r = await d.od.ensureCaseWorkFolders({ folderId: 'F1', label: '2026-VV-001' });
  assert.deepEqual(r.created, NAMES);
  assert.deepEqual(r.present, []);
  assert.deepEqual([...d.inside].sort(), NAMES);
});

test('a failure still tells the caller what was made before it (err.created) next to what is missing (err.missing)', async () => {
  const d = statefulDrive({ onPost: (name) => (name === '3-AW-Analyst-Final-RCIC' ? status(403) : null) });
  await assert.rejects(() => d.od.ensureCaseWorkFolders({ folderId: 'F1' }), (err) => {
    assert.deepEqual(err.created, ['1-Coordinator-Working', '2-Case-Manager-Draft', '4-Submitted-IRCC']);
    assert.deepEqual(err.missing, ['3-AW-Analyst-Final-RCIC']);
    return true;
  });
});

test('a folder staff made by hand in other letter case ("1-coordinator-working") IS that folder: the preview does not count it, the run does not re-create it', async () => {
  const h = driveHarness({ get: () => ({ data: { value: [{ name: '1-coordinator-working', folder: {} }] } }) });
  const p = await h.svc.ensureCaseWorkFolders({ folderId: 'F1', dryRun: true });
  assert.deepEqual(p.wouldCreate, ['2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC']);
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'F1' });
  assert.deepEqual(h.calls.post.map(([, n]) => n), ['2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC']);
  assert.deepEqual(r.present, ['1-Coordinator-Working']);
});

test('a preview leaves no trace: it never marks a folder complete (the app\'s next touch would skip it), a real pass does', async () => {
  const d = statefulDrive();
  await d.od.ensureCaseWorkFolders({ folderId: 'F1', dryRun: true });
  assert.equal(d.inside.size, 0);
  assert.equal(d.od._workFoldersMemoHas('F1'), false, 'the preview did not mark it complete');
  await d.od.ensureCaseWorkFolders({ folderId: 'F1' });
  assert.equal(d.od._workFoldersMemoHas('F1'), true);
  assert.deepEqual([...d.inside].sort(), NAMES);
});

test('a try that never answers (a hung login call) gives up after the deadline, is retried, and is flagged in the report', quiet(async () => {
  let n = 0;
  const { s } = jobHarness({ cases: [row('1', 'Ada', '2026-VV-001')], rootFolders: [{ id: 'F1', name: 'Ada - 2026-VV-001', childCount: 3 }],
    ensure: () => (n++ === 0 ? new Promise(() => {}) : { created: ['2-Case-Manager-Draft'], present: ['1-Coordinator-Working', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'] }) });
  s.io.deadlineMs = 20;
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(st.state, 'done');
  assert.equal(st.rows[0].tries, 2);
  assert.equal(st.rows[0].unansweredTry, true);
  assert.equal(s.statusOf().rows.length, 1, 'a retried folder shows in the short report');
}));

test('the default deadline is two minutes per try', () => {
  const { io } = svc();
  assert.equal(io.deadlineMs, 120000);
});

test('abort works even while a folder hangs or the job is waiting out a throttle: it stops at once', quiet(async () => {
  for (const mode of ['hang', 'throttle-wait']) {
    const { s } = jobHarness({ ensure: () => (mode === 'hang' ? new Promise(() => {}) : Promise.reject(status(429))) });
    if (mode === 'throttle-wait') s.io.sleep = () => new Promise(() => {});   // a Retry-After that would never end
    s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.abortBackfill().aborted, true);
    const st = await s._waitForTests();
    assert.equal(st.state, 'aborted', mode);
    assert.equal(st.progress.done, 1, `${mode}: the folder in hand is reported, the rest untouched`);
    assert.match(st.rows[0].error, /aborted/);
    assert.equal(st.totals.failedFolders, 0, 'an abort is not a failure');
  }
}));

test('server hiccups (503) and dropped connections are retried; a success in between resets the "in a row" count', quiet(async () => {
  const folders = Array.from({ length: 9 }, (_, i) => ({ id: `F${i}`, name: `C${i} - 2026-VV-00${i}`, childCount: 1 }));
  const cases = folders.map((f, i) => row(String(i), `C${i}`, `2026-VV-00${i}`));
  const tries = {};
  const { s } = jobHarness({ cases, rootFolders: folders, ensure: (p) => {
    tries[p.folderId] = (tries[p.folderId] || 0) + 1;
    if (p.folderId === 'F4') return { created: NAMES, present: [] };   // the one good folder
    if (p.folderId === 'F0' && tries.F0 === 1) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
    throw status(503);
  } });
  s.startBackfill({ dryRun: false, confirm: 'ADD-WORK-FOLDERS' });
  const st = await s._waitForTests();
  assert.equal(tries.F1, 3, 'a 503 gets two more tries');
  assert.equal(tries.F0, 3, 'a dropped connection is retried too');
  assert.equal(st.state, 'done', '4 failures, a success, 4 failures: never 5 in a row');
  assert.equal(st.totals.failedFolders, 8);
}));

test('the Monday list: every page, first without a cursor then with it; reference, group and state read per row', quiet(async () => {
  const calls = [];
  const p = require.resolve('../src/services/mondayApi');
  const saved = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { query: async (q, v) => {
    calls.push([q, v]);
    const item = (id, ref, g) => ({ id, name: 'N' + id, state: 'active', group: { id: g, title: g }, column_values: [{ id: 'text_mm142s49', text: ref }] });
    return v && v.c === 'CUR2'
      ? { boards: [{ items_page: { cursor: null, items: [item('3', '2026-VV-003', 'group_mm3842s')] } }] }
      : { boards: [{ items_page: { cursor: 'CUR2', items: [item('1', '2026-VV-001', 'g1'), item('2', '', 'g1')] } }] };
  } } };
  try {
    const { io } = svc();
    const rows = await io.listCases();
    assert.deepEqual(rows.map((r) => [r.id, r.caseRef, r.groupId, r.state]), [['1', '2026-VV-001', 'g1', 'active'], ['2', '', 'g1', 'active'], ['3', '2026-VV-003', 'group_mm3842s', 'active']]);
    assert.equal(calls.length, 2);
    assert.ok(!/cursor:\s*\$c/.test(calls[0][0]) && /cursor:\s*\$c/.test(calls[1][0]));
    assert.ok(calls.every(([q]) => !/mutation/i.test(q)), 'read only');
  } finally {
    if (saved) require.cache[p] = saved; else delete require.cache[p];
  }
}));

test('the report order is the four names as the app defines them', () => {
  const src = fs.readFileSync(require.resolve('../src/services/workFoldersBackfillService'), 'utf8');
  const m = src.match(/const CASE_WORK_FOLDERS_ORDER = (\[[^\]]+\])/);
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), NAMES);
});
