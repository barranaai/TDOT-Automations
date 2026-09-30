'use strict';

// Every NEW case folder carries four staff working folders from the moment its
// case reference is assigned (Faran, 2026-10-01): 1-Coordinator-Working,
// 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC. Two moments
// "New" = a case folder created on or after 2026-10-01, whichever code path
// minted it: the rename of the lead's intake folder adds them at once, and every
// later touch of a new folder through the OneDrive service (the checklist build,
// a questionnaire save, a signed agreement) adds whatever is still missing — so
// an outage heals on the next touch. Cases from before are never touched.

const test   = require('node:test');
const assert = require('node:assert/strict');

const NAMES = ['1-Coordinator-Working', '2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'];

/** A fake Graph: a case folder by id with the sub-folders it already has. */
function driveHarness({ existing = [], failOn = null, unauthorizedOnce = false, caseFolderExists = false, folderCreatedAt = '2026-10-01T15:00:00Z' } = {}) {
  const calls = { get: [], post: [] };
  const posted = [];
  let tokenSeen = [];
  const axios = {
    get: async (url, cfg) => {
      calls.get.push(decodeURIComponent(url));
      tokenSeen.push(cfg.headers.Authorization);
      if (/\/items\/CASE-1\/children/.test(url)) return { data: { value: existing.map((n) => ({ name: n, folder: {} })).concat([{ name: 'loose.pdf', file: {} }]) } };
      if (/root:\/Client Documents\/Ada - 2026-VV-001:$/.test(decodeURIComponent(url))) return { data: { id: 'CASE-1', webUrl: 'https://w/case', createdDateTime: folderCreatedAt } };
      const e = new Error('itemNotFound'); e.response = { status: 404 }; throw e;
    },
    post: async (url, body, cfg) => {
      const dec = decodeURIComponent(url);
      calls.post.push([dec, body && body.name]);
      tokenSeen.push(cfg.headers.Authorization);
      if (unauthorizedOnce && cfg.headers.Authorization === 'Bearer tok1') { const e = new Error('expired'); e.response = { status: 401 }; throw e; }
      if (/\/items\/CASE-1\/children/.test(dec)) {
        if (failOn === body.name) { const e = new Error('serviceUnavailable'); e.response = { status: 503 }; throw e; }
        if (existing.includes(body.name)) { const e = new Error('nameAlreadyExists'); e.response = { status: 409 }; throw e; }
        posted.push(body.name);
        return { data: { id: 'sub-' + body.name, webUrl: 'https://w/' + body.name } };
      }
      if (/root:\/Client Documents:\/children/.test(dec)) {
        if (caseFolderExists) { const e = new Error('nameAlreadyExists'); e.response = { status: 409 }; throw e; }
        return { data: { id: 'CASE-1', webUrl: 'https://w/case', createdDateTime: '2026-10-01T15:00:00Z' } };
      }
      if (/\/root\/children/.test(dec)) return { data: { id: 'root', webUrl: 'https://w/root' } };
      if (/createLink/.test(dec)) return { data: { link: { webUrl: 'https://link/' + dec.split('/items/')[1].split('/')[0] } } };
      if (/root:\/Client Documents\/Ada - 2026-VV-001:\/children/.test(dec)) return { data: { id: 'cat-' + body.name, webUrl: 'https://w/' + body.name } };
      throw new Error('unexpected POST ' + dec);
    },
  };
  let tokens = 0;
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', axios);
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok' + (++tokens), invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const svc = require(p);
  svc._clearCaseFolderCache();
  svc._resetWorkFoldersMemo();
  return { svc, calls, posted, tokensUsed: () => [...new Set(tokenSeen)] };
}

test('the four names, exactly, in order — and they are not document categories', () => {
  const { svc } = driveHarness();
  assert.deepEqual(svc.CASE_WORK_FOLDERS, NAMES);
  const src = require('fs').readFileSync(require.resolve('../src/services/oneDriveService'), 'utf8');
  assert.match(src, /const CASE_WORK_FOLDERS\s+= \['1-Coordinator-Working', '2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'\];/);
  for (const f of ['../src/services/documentFormService', '../src/services/checklistService', '../src/services/executionSeederService']) {
    assert.ok(!require('fs').readFileSync(require.resolve(f), 'utf8').includes('CASE_WORK_FOLDERS'), `${f} never files anything into them`);
  }
});

test('an empty case folder gets all four; ONE listing, four creates, no lookups', async () => {
  const h = driveHarness();
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1', label: '2026-VV-001' });
  assert.deepEqual(r, { created: NAMES, present: [] });
  assert.deepEqual(h.posted, NAMES);
  assert.equal(h.calls.get.length, 1, 'one children listing');
  assert.ok(h.calls.post.every(([u]) => u.endsWith('/items/CASE-1/children')), 'created under the folder ID, never by path');
});

test('a case folder that already has some of them only gets the missing ones; all four present = one call and nothing created', async () => {
  const h = driveHarness({ existing: ['1-Coordinator-Working', '4-Submitted-IRCC'] });
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1' });
  assert.deepEqual(r.created, ['2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC']);
  assert.deepEqual(r.present, ['1-Coordinator-Working', '4-Submitted-IRCC']);
  const all = driveHarness({ existing: NAMES });
  const r2 = await all.svc.ensureCaseWorkFolders({ folderId: 'CASE-1' });
  assert.deepEqual(r2, { created: [], present: NAMES });
  assert.equal(all.calls.post.length, 0);
});

test('a folder created by someone else in the meantime (409) counts as present; a real failure (503) on one folder still creates the others and the error names what is missing', async () => {
  const racing = driveHarness();
  racing.svc; // fresh module
  // simulate: listing says none, but the second create answers 409
  const orig = require('axios').post;
  require('axios').post = async (url, body, cfg) => { if (body && body.name === '2-Case-Manager-Draft') { const e = new Error('exists'); e.response = { status: 409 }; throw e; } return orig(url, body, cfg); };
  const r = await racing.svc.ensureCaseWorkFolders({ folderId: 'CASE-1' });
  assert.deepEqual(r.present, ['2-Case-Manager-Draft']);
  assert.deepEqual(r.created, ['1-Coordinator-Working', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC']);
  const down = driveHarness({ failOn: '3-AW-Analyst-Final-RCIC' });
  const errLog = []; const oe = console.error; console.error = (...a) => errLog.push(a.join(' '));
  try {
    await assert.rejects(() => down.svc.ensureCaseWorkFolders({ folderId: 'CASE-1', label: '2026-VV-001' }), (e) => { assert.deepEqual(e.missing, ['3-AW-Analyst-Final-RCIC']); assert.equal(e.transient, true); return true; });
  } finally { console.error = oe; }
  assert.deepEqual(down.posted, ['1-Coordinator-Working', '2-Case-Manager-Draft', '4-Submitted-IRCC'], 'every other folder is still made');
  assert.ok(errLog.some((l) => /Could not create working folder "3-AW-Analyst-Final-RCIC" for 2026-VV-001/.test(l)));
  assert.match(down.svc.workFoldersFailedNoteText(new Error('x')), /^⚠ Could not create the working folders 1-Coordinator-Working, 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC in this client's OneDrive folder — please add them by hand\. Reason: x$/);
  const one = new Error('nope'); one.missing = ['4-Submitted-IRCC'];
  assert.match(down.svc.workFoldersFailedNoteText(one), /^⚠ Could not create the working folder 4-Submitted-IRCC in this client's OneDrive folder — please add it by hand\. Reason: nope$/);
});

test('an expired token: refreshed once and the whole pass retried — still exactly four folders', async () => {
  const h = driveHarness({ unauthorizedOnce: true });
  const r = await h.svc.ensureCaseWorkFolders({ folderId: 'CASE-1' });
  assert.deepEqual(r.created, NAMES);
  assert.deepEqual(h.tokensUsed(), ['Bearer tok1', 'Bearer tok2']);
  assert.deepEqual(h.posted, NAMES, 'the 401 attempt created nothing, so the retry made each once');
});

test('createClientFolders: a case folder created FRESH gets the working folders; a folder from BEFORE the feature never does (older case, re-seed)', async () => {
  const fresh = driveHarness();
  await fresh.svc.createClientFolders({ clientName: 'Ada', caseRef: '2026-VV-001', categories: ['Identity'] });
  assert.deepEqual(fresh.posted, NAMES);
  const old = driveHarness({ caseFolderExists: true, folderCreatedAt: '2026-09-30T23:59:59Z' });
  await old.svc.createClientFolders({ clientName: 'Ada', caseRef: '2026-VV-001', categories: ['Identity'] });
  assert.deepEqual(old.posted, [], 'nothing added to a folder that predates the feature');
  assert.ok(!old.calls.get.some((u) => /\/items\/CASE-1\/children/.test(u)), 'not even listed');
});

test('a NEW case folder minted by another path (a questionnaire save, a signed agreement) gets them on its next touch; a complete one costs one listing per process', async () => {
  // the folder exists (created after the feature went live) but has only two of the four — e.g. an outage half-way
  const h = driveHarness({ caseFolderExists: true, folderCreatedAt: '2026-10-02T09:00:00Z', existing: ['1-Coordinator-Working', '2-Case-Manager-Draft'] });
  await h.svc.ensureClientFolder({ clientName: 'Ada', caseRef: '2026-VV-001' });
  assert.deepEqual(h.posted, ['3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'], 'self-heals what is missing');
  const listings = () => h.calls.get.filter((u) => /\/items\/CASE-1\/children/.test(u)).length;
  assert.equal(listings(), 1);
  await h.svc.ensureCategoryFolderLink({ clientName: 'Ada', caseRef: '2026-VV-001', category: 'Identity' });
  assert.equal(listings(), 1, 'remembered as complete — no second listing');
  const complete = driveHarness({ caseFolderExists: true, folderCreatedAt: '2026-10-02T09:00:00Z', existing: NAMES });
  await complete.svc.ensureClientFolder({ clientName: 'Ada', caseRef: '2026-VV-001' });
  await complete.svc.ensureClientFolder({ clientName: 'Ada', caseRef: '2026-VV-001' });
  assert.equal(complete.calls.get.filter((u) => /\/items\/CASE-1\/children/.test(u)).length, 1);
  assert.deepEqual(complete.posted, []);
});

test('the cut-over is the folder\'s own creation date: 2026-10-01 00:00 UTC', () => {
  const { svc } = driveHarness();
  assert.equal(svc.WORK_FOLDERS_SINCE, Date.parse('2026-10-01T00:00:00Z'));
});

test('createClientFolders: OneDrive refusing a working folder never breaks the checklist folders, and the caller\'s note hook is told what is missing', async () => {
  const h = driveHarness({ failOn: '1-Coordinator-Working' });
  const warn = []; const orig = console.warn; console.warn = (...a) => warn.push(a.join(' '));
  const oe = console.error; console.error = () => {};
  const told = [];
  try {
    const links = await h.svc.createClientFolders({ clientName: 'Ada', caseRef: '2026-VV-001', categories: ['Identity', 'Financial'], onWorkFoldersFailed: async (e) => { told.push(e.missing); } });
    assert.deepEqual(Object.keys(links), ['Identity', 'Financial']);
  } finally { console.warn = orig; console.error = oe; }
  assert.ok(warn.some((l) => /Working folders not created for 2026-VV-001/.test(l)));
  assert.deepEqual(told, [['1-Coordinator-Working']]);
  assert.deepEqual(h.posted, ['2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC']);
});

test('the checklist build posts that note on the case (it is the creator that knows the case row)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/checklistService'), 'utf8');
  assert.equal((src.match(/onWorkFoldersFailed: \(err\) => noteWorkFoldersFailed\(/g) || []).length, 2, 'both seeding paths');
  assert.match(src, /workFoldersFailedNoteText\(err\)/);
});

// ─── the rename hook (caseRefService) ────────────────────────────────────────

test('when the case reference is assigned: the folder is renamed, then the working folders are created under the SAME folder id', async () => {
  delete require.cache[require.resolve('axios')];
  const mondayApi   = require('../src/services/mondayApi');
  const oneDrive    = require('../src/services/oneDriveService');
  const caseRefSvc  = require('../src/services/caseRefService');
  const stub = (obj, key, fn) => { const o = obj[key]; obj[key] = fn; return () => { obj[key] = o; }; };
  const order = [], notes = [];
  const restore = [
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) { notes.push(vars.body); return {}; } return { items: [{ name: 'Ada', column_values: [{ text: 'DRIVE-9' }] }] }; }),
    stub(oneDrive, 'renameDriveItem', async (id, name) => { order.push(['rename', id, name]); return { id, name }; }),
    stub(oneDrive, 'ensureCaseWorkFolders', async (p) => { order.push(['work', p.folderId, p.label]); return { created: NAMES, present: [] }; }),
  ];
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-VV-001' });
    assert.deepEqual(order, [['rename', 'DRIVE-9', 'Ada - 2026-VV-001'], ['work', 'DRIVE-9', '2026-VV-001']]);
    assert.deepEqual(notes, [], 'no staff note when everything worked');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('rename hook: OneDrive refusing the working folders → one plain-word staff note naming the four; the rename is unaffected', async () => {
  const mondayApi   = require('../src/services/mondayApi');
  const oneDrive    = require('../src/services/oneDriveService');
  const caseRefSvc  = require('../src/services/caseRefService');
  const stub = (obj, key, fn) => { const o = obj[key]; obj[key] = fn; return () => { obj[key] = o; }; };
  const notes = []; let renamed = 0;
  const restore = [
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) { notes.push(vars.body); return {}; } return { items: [{ name: 'Ada', column_values: [{ text: 'DRIVE-9' }] }] }; }),
    stub(oneDrive, 'renameDriveItem', async () => { renamed++; return {}; }),
    stub(oneDrive, 'ensureCaseWorkFolders', async () => { throw new Error('serviceUnavailable <503>'); }),
  ];
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-VV-001' });
    assert.equal(renamed, 1);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^⚠ Could not create the working folders 1-Coordinator-Working, 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC in this client's OneDrive folder — please add them by hand\. Reason: serviceUnavailable 503$/);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('rename hook: a case with no folder to rename (legacy / manual row) creates nothing — its folder, when first made at checklist time, gets them then', async () => {
  const mondayApi   = require('../src/services/mondayApi');
  const oneDrive    = require('../src/services/oneDriveService');
  const leadService = require('../src/services/leadService');
  const caseRefSvc  = require('../src/services/caseRefService');
  const stub = (obj, key, fn) => { const o = obj[key]; obj[key] = fn; return () => { obj[key] = o; }; };
  let work = 0;
  const restore = [
    stub(mondayApi, 'query', async () => ({ items: [{ name: 'Manual Row', column_values: [{ text: '' }] }] })),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(oneDrive, 'ensureCaseWorkFolders', async () => { work++; return {}; }),
  ];
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5002', caseRef: '2026-VV-002' });
    assert.equal(work, 0);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('rename hook: a REFUSED rename (409 — a folder with the case name already exists) creates nothing in the abandoned LEAD folder; the note tells staff which folder to set up', async () => {
  const mondayApi   = require('../src/services/mondayApi');
  const oneDrive    = require('../src/services/oneDriveService');
  const caseRefSvc  = require('../src/services/caseRefService');
  const stub = (obj, key, fn) => { const o = obj[key]; obj[key] = fn; return () => { obj[key] = o; }; };
  const notes = []; let work = 0;
  const restore = [
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) { notes.push(vars.body); return {}; } return { items: [{ name: 'Ada', column_values: [{ text: 'DRIVE-9' }] }] }; }),
    stub(oneDrive, 'renameDriveItem', async () => { const e = new Error('nameAlreadyExists'); e.response = { status: 409 }; throw e; }),
    stub(oneDrive, 'ensureCaseWorkFolders', async () => { work++; return {}; }),
  ];
  const ow = console.warn; console.warn = () => {};
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-VV-001' });
    assert.equal(work, 0, 'the LEAD folder is not the case folder any more');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /and create the working folders \(1-Coordinator-Working, 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC\) in the folder you keep\.$/);
  } finally { console.warn = ow; restore.reverse().forEach((r) => r()); }
});
