'use strict';

// A case's documents live in "<client name> - <case ref>". Renaming the Monday
// item — staff routinely append a client number — used to break every read and
// write for that case, silently: readFile reported "no file" and listFiles "no
// files" on a 404. Seven live cases (93 documents marked Received) were in that
// state on 2026-09-04.
//
// The case reference never changes, so a 404 now re-resolves the folder by the
// reference and retries once. Cost discipline matters as much as correctness:
// the healthy path must pay nothing, and a plain missing file must not page the
// whole root listing.

const test   = require('node:test');
const assert = require('node:assert/strict');

const CLIENT = 'Nayala Sadaf (2720)';       // the Monday name TODAY
const REF    = '2026-CEC-PS-012';
const ACTUAL = 'Nayala Sadaf - 2026-CEC-PS-012';   // what the folder is really called
const EXPECT = 'Nayala Sadaf (2720) - 2026-CEC-PS-012';

function harness({ folders = [ACTUAL], files = {} } = {}) {
  const calls = { get: [], put: [], patch: [], post: [] };
  const notFound = () => { const e = new Error('itemNotFound'); e.response = { status: 404 }; return e; };
  const axios = {
    get: async (url) => {
      calls.get.push(url);
      const dec = decodeURIComponent(url);
      // root children listing (used to find a folder by case reference)
      if (/\/root\/children|root:\/Client Documents:\/children/.test(dec)) {
        return { data: { value: folders.map((name) => ({ id: 'id-' + name, name, webUrl: 'https://w/' + name,
          folder: { childCount: Object.keys(files[name] || {}).length } })) } };
      }
      // a folder's own children
      const listing = /root:\/Client Documents\/([^:]+):\/children/.exec(dec);
      if (listing) {
        const [folder, ...rest] = listing[1].split('/');
        if (!folders.includes(folder)) throw notFound();
        const sub  = rest.join('/');
        const keys = Object.keys(files[folder] || {});
        if (!sub) {   // the case root: sub-folders, plus any loose files
          const subs  = [...new Set(keys.filter((k) => k.includes('/')).map((k) => k.split('/')[0]))];
          const loose = keys.filter((k) => !k.includes('/'));
          return { data: { value: [
            ...subs.map((n) => ({ name: n, folder: { childCount: keys.filter((k) => k.startsWith(n + '/')).length } })),
            ...loose.map((n) => ({ name: n, size: 1, lastModifiedDateTime: 't', file: {} })),
          ] } };
        }
        const inSub = keys.filter((k) => k.startsWith(sub + '/'));
        return { data: { value: inSub.map((k) => ({ name: k.split('/').pop(), size: 1, lastModifiedDateTime: 't', file: {} })) } };
      }
      // a single item (existence check or file content)
      const item = /root:\/Client Documents\/([^:]+):(\/content|\/versions)?$/.exec(dec);
      if (item) {
        const [folder, ...rest] = item[1].split('/');
        if (!folders.includes(folder)) throw notFound();
        const rel = rest.join('/');
        if (!rel) return { data: { id: 'id-' + folder, name: folder, webUrl: 'https://w/' + folder } };
        if (!(files[folder] || {})[rel]) throw notFound();
        return { data: Buffer.from(files[folder][rel]) };
      }
      throw notFound();
    },
    put:   async (url, body) => { calls.put.push(decodeURIComponent(url)); const dec = decodeURIComponent(url);
      const m = /root:\/Client Documents\/([^:]+):\/content/.exec(dec);
      const folder = m && m[1].split('/')[0];
      if (!folders.includes(folder)) throw notFound();
      return { data: { webUrl: 'https://w/uploaded' } }; },
    patch: async (url) => { calls.patch.push(decodeURIComponent(url)); return { data: { webUrl: 'https://w/moved', name: 'f.pdf' } }; },
    post:  async (url) => { calls.post.push(decodeURIComponent(url)); return { data: { id: 'new', webUrl: 'https://w/new' } }; },
  };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', axios);
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const svc = require(p);
  svc._clearCaseFolderCache();
  const rootListings = () => calls.get.filter((u) => /Client Documents:\/children|\/root\/children/.test(decodeURIComponent(u))).length;
  return { svc, calls, rootListings };
}

test('healthy case: ONE folder lookup, then every later read is free', async () => {
  const h = harness({ folders: [EXPECT], files: { [EXPECT]: { 'Identity/passport.pdf': 'PDF', 'Identity/b.pdf': 'B' } } });
  const buf = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'passport.pdf' });
  assert.equal(buf.toString(), 'PDF');
  assert.equal(h.rootListings(), 1, 'the reference is resolved once, up front');
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'b.pdf' });
  await h.svc.listFiles({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity' });
  assert.equal(h.rootListings(), 1, 'cached for the rest of the process');
});

test('split case: the documents win even when Graph lists the EMPTY folder first', async () => {
  // Ordering must not decide anything — pickCaseFolder does.
  for (const order of [[EXPECT, ACTUAL], [ACTUAL, EXPECT]]) {
    const h = harness({
      folders: order,
      files: { [ACTUAL]: { 'Identity/passport.pdf': 'PDF', 'Legal/l.pdf': 'L' }, [EXPECT]: {} },
    });
    const buf = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'passport.pdf' });
    assert.equal(buf.toString(), 'PDF', `documents win with listing order ${JSON.stringify(order)}`);
    const seen = await h.svc.listChildren({ clientName: CLIENT, caseRef: REF, subfolder: '' });
    assert.deepEqual(seen.map((x) => x.name).sort(), ['Identity', 'Legal'], 'the whole tree comes from the right folder');
    assert.equal((await h.svc.findCaseFolderByRef(REF)).name, ACTUAL, 'the exported helper agrees');
  }
});

test('concurrent callers share ONE root lookup', async () => {
  const h = harness({ files: { [ACTUAL]: { 'Identity/a.pdf': 'x' } } });
  await Promise.all(Array.from({ length: 8 }, () =>
    h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })));
  assert.equal(h.rootListings(), 1, '8 parallel reads must not page the root 8 times');
});

test('a case with no folder yet is re-checked, never cached as absent forever', async () => {
  const h = harness({ folders: [] });
  assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'x.pdf' }), null);
  const afterFirst = h.rootListings();
  assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'x.pdf' }), null);
  assert.equal(h.rootListings(), afterFirst, 'the miss is cached briefly rather than re-paged on every probe');
  const src = require('fs').readFileSync(require.resolve('../src/services/oneDriveService'), 'utf8');
  assert.match(src, /CASE_FOLDER_MISS_TTL_MS = 30 \* 1000/, 'and it expires quickly, so setup\'s new folder is noticed');
});



test('a resolution is only cached once a folder has been SEEN — a case with no folder yet re-resolves', async () => {
  const h = harness({ folders: [] });
  assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'x.pdf' }), null);
  // the folder appears afterwards (created by case setup); the next read must find it
  h.calls.get.length = 0;
  const p = require.resolve('axios');
  const files = { [ACTUAL]: { 'Identity/x.pdf': 'LATE' } };
  require.cache[p].exports.get = harness({ folders: [ACTUAL], files }).calls ? require.cache[p].exports.get : require.cache[p].exports.get;
  const h2 = harness({ folders: [ACTUAL], files });
  assert.equal((await h2.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'x.pdf' })).toString(), 'LATE');
});

test('renamed folder: a read heals by case reference, and the answer is cached', async () => {
  const h = harness({ files: { [ACTUAL]: { 'Identity/passport.pdf': 'PDF' } } });   // folder is ACTUAL, Monday says EXPECT
  const buf = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'passport.pdf' });
  assert.equal(buf.toString(), 'PDF', 'the document is found despite the rename');
  const listingsAfterFirst = h.rootListings();
  assert.ok(listingsAfterFirst >= 1, 'the root was paged once to find the folder');

  const again = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'passport.pdf' });
  assert.equal(again.toString(), 'PDF');
  assert.equal(h.rootListings(), listingsAfterFirst, 'the resolved name is cached — no second root listing');
});

test('a missing file costs ONE folder search, then none — the questionnaire load probes for absent files constantly', async () => {
  const h = harness({ folders: [EXPECT], files: { [EXPECT]: { 'Identity/other.pdf': 'x' } } });
  assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'missing.pdf' }), null);
  const first = h.rootListings();
  assert.equal(first, 1, 'one resolution up front');
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
    assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: name }), null);
  }
  assert.equal(h.rootListings(), first, 'the folder is confirmed — later absent files are free');
});

test('listings heal too, and an absent case still reads as empty', async () => {
  let h = harness({ files: { [ACTUAL]: { 'Identity/a.pdf': 'x', 'Identity/b.pdf': 'y' } } });
  const files = await h.svc.listFiles({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity' });
  assert.deepEqual(files.map((f) => f.name).sort(), ['a.pdf', 'b.pdf']);

  h = harness({ folders: [] });   // nothing anywhere
  assert.deepEqual(await h.svc.listFiles({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity' }), []);
  assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'x.pdf' }), null);
});

test('an upload resolves the folder BEFORE writing, so a missing parent can never be auto-created', async () => {
  const h = harness({ files: { [ACTUAL]: {} } });
  await h.svc.uploadFile({ clientName: CLIENT, caseRef: REF, category: 'Identity', filename: 'new.pdf', buffer: Buffer.from('x'), mimeType: 'application/pdf' });
  assert.equal(h.calls.put.length, 1, 'exactly one PUT — never a speculative one at the stale path');
  assert.match(h.calls.put[0], new RegExp(ACTUAL), 'landed in the folder that carries the case reference');
});

test('folder creation reuses a renamed folder instead of minting a duplicate', async () => {
  const h = harness({ files: { [ACTUAL]: {} } });
  await h.svc.ensureClientFolder({ clientName: CLIENT, caseRef: REF });
  const created = h.calls.post.map((u) => u).join(' ');
  assert.ok(!created.includes(EXPECT), 'no folder created under the new client name');
});

test('a non-404 failure is never mistaken for a renamed folder', async () => {
  const h = harness({ folders: [EXPECT] });
  const p = require.resolve('axios');
  require.cache[p].exports.get = async () => { const e = new Error('boom'); e.response = { status: 500 }; throw e; };
  await assert.rejects(() => h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'x.pdf' }), /OneDrive read failed/);
});

test('findCaseFolderByRef matches on the case reference suffix only', async () => {
  const h = harness({ folders: ['Someone Else - 2026-CEC-PS-0120', 'Nayala Sadaf - 2026-CEC-PS-012', 'Other - 2026-XYZ-001'] });
  const hit = await h.svc.findCaseFolderByRef(REF);
  assert.equal(hit.name, ACTUAL, 'a longer reference that merely starts the same must not match');
  assert.equal(await h.svc.findCaseFolderByRef('2026-NOPE-999'), null);
  assert.equal(await h.svc.findCaseFolderByRef(''), null);
  assert.equal(h.svc.caseFolderName({ clientName: 'A/B', caseRef: 'R' }), 'AB - R', 'the one definition of the folder name');
});

test('a cached name that goes stale mid-process still heals — the retry re-resolves for real', async () => {
  const h = harness({ files: { [ACTUAL]: { 'Identity/a.pdf': 'ONE' } } });
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'ONE');

  // the folder is renamed again while the process is running
  const RENAMED_AGAIN = 'Nayala Sadaf (2720) v2 - 2026-CEC-PS-012';
  const p = require.resolve('axios');
  const fresh = harness({ folders: [RENAMED_AGAIN], files: { [RENAMED_AGAIN]: { 'Identity/a.pdf': 'TWO' } } });
  // carry the stale cache over from the first service instance
  fresh.svc._clearCaseFolderCache();
  await fresh.svc.resolveCaseFolderName({ clientName: CLIENT, caseRef: REF });
  const again = await fresh.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });
  assert.equal(again.toString(), 'TWO', 'the new name is found');
  assert.ok(p, 'axios stubbed');
});

test('findCaseFoldersByRef returns EVERY match so a split case is visible, and picks the one with content', async () => {
  const h = harness({
    folders: ['Nayala Sadaf - 2026-CEC-PS-012', 'Nayala Sadaf (2720) - 2026-CEC-PS-012', 'Other - 2026-CEC-PS-0120'],
    files: { 'Nayala Sadaf - 2026-CEC-PS-012': { 'a.pdf': 'x', 'b.pdf': 'y' }, 'Nayala Sadaf (2720) - 2026-CEC-PS-012': {} },
  });
  const all = await h.svc.findCaseFoldersByRef(REF);
  assert.equal(all.length, 2, 'both folders for this reference are returned; the longer reference is not one of them');
  assert.equal((await h.svc.findCaseFolderByRef(REF)).name, ACTUAL, 'the folder holding the documents is chosen');
});
