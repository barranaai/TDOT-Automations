'use strict';

// READ-ONLY look into ONE root folder by its exact name — the way to see a
// client's real folder when the app resolves the case to a leftover test
// folder beside it (2026-09-30: 4 such clients). Lists every file, with who
// made and last changed it and when; never writes anything.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

function harness(routes) {
  const calls = { get: [], other: [] };
  const axios = {
    get: async (url) => { const d = decodeURIComponent(url); calls.get.push(d); return routes(d); },
    post: async (u) => { calls.other.push(['post', u]); throw new Error('write'); },
    patch: async (u) => { calls.other.push(['patch', u]); throw new Error('write'); },
    delete: async (u) => { calls.other.push(['delete', u]); throw new Error('write'); },
    put: async (u) => { calls.other.push(['put', u]); throw new Error('write'); },
  };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', axios);
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  return { svc: require(p), calls };
}
const notFound = () => { const e = new Error('itemNotFound'); e.response = { status: 404 }; return e; };
const by = (name) => ({ user: { displayName: name } });

test('lists the folder by its EXACT name: root files, each sub-folder with its files, who and when — and never writes', async () => {
  const h = harness((u) => {
    if (/root:\/Client Documents\/Praj - 2026-VV-008:\?/.test(u)) return { data: { id: 'TEST', name: 'Praj - 2026-VV-008', webUrl: 'https://w/praj', createdDateTime: '2026-08-01T10:00:00Z' } };
    if (/\/items\/TEST\/children/.test(u)) return { data: { value: [
      { id: 'S1', name: 'Identity', folder: { childCount: 2 }, createdDateTime: '2026-08-01T10:01:00Z', createdBy: by('TDOT App') },
      { id: 'R1', name: 'loose.pdf', file: {}, size: 10, createdDateTime: '2026-09-01T00:00:00Z', lastModifiedDateTime: '2026-09-02T00:00:00Z', createdBy: by('Faran'), lastModifiedBy: by('Gauri') },
    ] } };
    if (/\/items\/S1\/children/.test(u)) return { data: { value: [
      { id: 'F1', name: 'Passport – Ameena Begum – 2026-09-12 10-11 – scan.pdf', file: {}, size: 500, createdDateTime: '2026-09-12T14:11:00Z', createdBy: { application: { displayName: 'TDOT Automations' } } },
      { id: 'F2', name: 'nested', folder: {} },
    ] } };
    throw notFound();
  });
  const t = await h.svc.listRootFolderTree('Praj - 2026-VV-008');
  assert.deepEqual(t.folder, { id: 'TEST', name: 'Praj - 2026-VV-008', webUrl: 'https://w/praj', createdAt: '2026-08-01T10:00:00Z' });
  assert.deepEqual(t.rootFiles.map((f) => [f.name, f.createdBy, f.modifiedBy, f.modifiedAt]), [['loose.pdf', 'Faran', 'Gauri', '2026-09-02T00:00:00Z']]);
  assert.equal(t.folders.length, 1);
  assert.equal(t.folders[0].name, 'Identity');
  assert.deepEqual(t.folders[0].files.map((f) => [f.id, f.name, f.createdBy]), [['F1', 'Passport – Ameena Begum – 2026-09-12 10-11 – scan.pdf', 'TDOT Automations']], 'files only — a nested folder is not a file');
  assert.equal(h.calls.other.length, 0, 'read-only');
  assert.ok(h.calls.get.every((u) => /\$select=/.test(u)), 'asks only for the fields it shows');
});

test('no folder with that name → null (not an error); every listing page is read', async () => {
  const h1 = harness(() => { throw notFound(); });
  assert.equal(await h1.svc.listRootFolderTree('Nobody - 2026-XX-000'), null);
  assert.equal(await h1.svc.listRootFolderTree('   '), null);
  const h2 = harness((u) => {
    if (/root:\/Client Documents\/A - 1:\?/.test(u)) return { data: { id: 'A', name: 'A - 1' } };
    if (/\/items\/A\/children.*skiptoken/.test(u)) return { data: { value: [{ id: 'f2', name: 'two.pdf', file: {} }] } };
    if (/\/items\/A\/children/.test(u)) return { data: { value: [{ id: 'f1', name: 'one.pdf', file: {} }], '@odata.nextLink': 'https://graph/items/A/children?$skiptoken=2' } };
    throw notFound();
  });
  const t = await h2.svc.listRootFolderTree('A - 1');
  assert.deepEqual(t.rootFiles.map((f) => f.name), ['one.pdf', 'two.pdf']);
});

test('the admin route: admin only, needs the exact name, no slashes, 404 when absent', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = src.indexOf("app.get('/admin/onedrive/folder-tree'");
  assert.ok(i !== -1);
  const body = src.slice(i, i + 900);
  assert.ok(body.includes('resolveAdminOrReject'));
  assert.ok(body.includes("/[/\\\\]/.test(name)"), 'a slash would walk out of the root');
  assert.ok(body.includes('listRootFolderTree(name)'));
  assert.ok(body.includes('status(404)'));
});

test('the listing function only ever GETs', () => {
  const src = fs.readFileSync(require.resolve('../src/services/oneDriveService.js'), 'utf8');
  const i = src.indexOf('async function listRootFolderTree');
  const j = src.indexOf('\nasync function ', i + 10);
  const fn = src.slice(i, j === -1 ? undefined : j);
  assert.doesNotMatch(fn, /axios\.(post|put|patch|delete)/);
});
