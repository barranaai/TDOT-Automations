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

function harness({ folders = [ACTUAL], files = {}, ids = {} } = {}) {
  // A folder's driveItem id survives a rename; the default only mirrors the
  // name because most tests never rename one out from under a warm cache.
  const idOf = (name) => ids[name] || ('id-' + name);
  const calls = { get: [], put: [], patch: [], post: [] };
  const notFound = () => { const e = new Error('itemNotFound'); e.response = { status: 404 }; return e; };
  const axios = {
    get: async (url) => {
      calls.get.push(url);
      const dec = decodeURIComponent(url);
      // root children listing (used to find a folder by case reference)
      if (/\/root\/children|root:\/Client Documents:\/children/.test(dec)) {
        return { data: { value: folders.map((name) => ({ id: idOf(name), name, webUrl: 'https://w/' + name,
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
        if (!rel) return { data: { id: idOf(folder), name: folder, webUrl: 'https://w/' + folder } };
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

// ─── The 404 heal: settled with evidence, once, cheaply ─────────────────────
//
// A 404 is ambiguous: the FILE is missing, or the FOLDER was renamed under us.
// Telling them apart used to mean re-paging the whole root, and the guard for
// "was this name already cached?" was "at least 1ms old" — which every real
// Graph round-trip is, so in practice every absent file paged the root twice.
// It is now one path lookup that compares the driveItem ID.

const pathLookups = (h) => h.calls.get.filter((u) => /Client Documents\/[^:/]+:$/.test(decodeURIComponent(u))).length;

test('an absent file costs ONE path lookup and never a root listing', async () => {
  const h = harness({ folders: [EXPECT], files: { [EXPECT]: { 'Identity/here.pdf': 'x' } } });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'here.pdf' });
  const listings = h.rootListings();
  assert.equal(await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'gone.pdf' }), null);
  assert.equal(h.rootListings(), listings, 'the root is never paged again for a missing file');
  assert.equal(pathLookups(h), 1, 'exactly one confirmation');
});

test('a burst of absent-file probes shares ONE confirmation', async () => {
  // The questionnaire load probes ~14 slots in parallel; that must not become
  // 14 lookups.
  const h = harness({ folders: [EXPECT], files: { [EXPECT]: { 'Identity/here.pdf': 'x' } } });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'here.pdf' });
  const listings = h.rootListings();
  const names = Array.from({ length: 14 }, (_, i) => `absent-${i}.pdf`);
  const got = await Promise.all(names.map((filename) =>
    h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename })));
  assert.deepEqual(got, names.map(() => null), 'all absent');
  assert.equal(h.rootListings(), listings, 'no root paging');
  assert.equal(pathLookups(h), 1, '14 parallel probes, one confirmation');
});

test('a folder renamed under a warm cache heals — no waiting for a trust window to lapse', async () => {
  const RENAMED = 'Nayala Sadaf (2720) v3 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const h = harness({ folders, files });   // one service instance, one warm cache
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'ONE');

  folders[0] = RENAMED;                     // staff rename it in OneDrive
  files[RENAMED] = { 'Identity/a.pdf': 'TWO' };
  delete files[EXPECT];

  const again = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });
  assert.equal(again && again.toString(), 'TWO', 'the read follows the folder to its new name, immediately');
});

test('a folder RE-CREATED under the old name does not fool the confirmation', async () => {
  // The "resurrection" half of the duplicate-folder defect: after a rename, a
  // write addressed by the old name mints an empty folder there. Checking only
  // that *a* folder wears the name would re-confirm the impostor and report
  // every document absent until the 10-minute cache expired.
  const RENAMED = 'Nayala Sadaf (2720) v9 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'ONE');

  folders.length = 0;
  folders.push(RENAMED, EXPECT);            // renamed away, and an empty duplicate left behind
  files[RENAMED] = { 'Identity/a.pdf': 'TWO' };
  files[EXPECT] = {};
  ids[RENAMED] = 'the-real-folder';         // the same driveItem, under its new name
  ids[EXPECT] = 'the-impostor';

  const again = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });
  assert.equal(again && again.toString(), 'TWO', 'the documents win — identity decides, not the name');
});

test('a confirmation that cannot answer re-resolves instead of guessing "absent"', async () => {
  // Answering "absent" on a guess is the blank-questionnaire class: it silently
  // serves an empty form over documents that are really there.
  const RENAMED = 'Nayala Sadaf (2720) v4 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'ONE');

  folders[0] = RENAMED;                     // renamed, so the cached name is stale
  files[RENAMED] = { 'Identity/a.pdf': 'TWO' };
  delete files[EXPECT];
  ids[RENAMED] = 'the-real-folder';

  // ...and the confirmation lookup itself fails, so it cannot say what happened
  const p = require.resolve('axios');
  const realGet = require.cache[p].exports.get;
  let failed = 0;
  require.cache[p].exports.get = async (url) => {
    const dec = decodeURIComponent(url);
    if (failed === 0 && /Client Documents\/[^:/]+:$/.test(dec)) {
      failed++;
      const e = new Error('Graph 503'); e.response = { status: 503 }; throw e;
    }
    return realGet(url);
  };
  try {
    const again = await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });
    assert.equal(failed, 1, 'the confirmation really was the call that failed');
    assert.equal(again && again.toString(), 'TWO', 'it re-resolved by case reference rather than answering "no such file"');
  } finally { require.cache[p].exports.get = realGet; }
});

test('a NON-EMPTY impostor under the old name still loses to the folder holding the documents', async () => {
  // The dangerous shape: the impostor is not empty (a write minted the full
  // category set into it) AND it wears the shorter pre-rename name, so the
  // split-case tie-break — most children, then shortest name — picks IT.
  // Healing must follow the driveItem id it already proved, not re-pick a name.
  const RENAMED = 'Nayala Sadaf (2720) v9 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'ONE');

  folders.length = 0;
  folders.push(RENAMED, EXPECT);
  files[RENAMED] = { 'Identity/a.pdf': 'TWO' };
  files[EXPECT] = { 'Identity/x.pdf': 'k', 'Legal/y.pdf': 'k', 'Employment/z.pdf': 'k' };   // MORE children
  ids[RENAMED] = 'the-real-folder';
  ids[EXPECT] = 'the-impostor';

  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'TWO',
    'the documents are found despite the impostor out-ranking them');
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'TWO',
    'and the next read does not short-circuit to "absent" — the impostor id was never cached');
  const listed = await h.svc.listFiles({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity' });
  assert.deepEqual(listed.map((f) => f.name), ['a.pdf'], 'listings follow the same folder');
});

test('a continuation page that 404s is an error, never "this case has no folder"', async () => {
  // Answering [] on a partial listing reports a case as folderless, which reads
  // as "no documents" and mints a duplicate on the next write.
  const h = harness({ folders: [EXPECT], files: { [EXPECT]: { 'Identity/a.pdf': 'ONE' } } });
  const p = require.resolve('axios');
  const realGet = require.cache[p].exports.get;
  let page = 0;
  require.cache[p].exports.get = async (url) => {
    const dec = decodeURIComponent(url);
    if (/Client Documents:\/children|\/root\/children/.test(dec)) {
      page += 1;
      if (page === 1) {
        const res = await realGet(url);
        return { data: { value: res.data.value, '@odata.nextLink': url + '&$skiptoken=stale' } };
      }
      const e = new Error('itemNotFound'); e.response = { status: 404 }; throw e;
    }
    return realGet(url);
  };
  try {
    await assert.rejects(() => h.svc.findCaseFoldersByRef(REF), /folder-by-ref lookup failed/,
      'a truncated listing surfaces instead of masquerading as an empty root');
  } finally { require.cache[p].exports.get = realGet; }
});

test('version history heals with the folder too, and a real failure is not "no history"', async () => {
  const RENAMED = 'Nayala Sadaf (2720) v5 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Questionnaire/q.json': '{}' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Questionnaire', filename: 'q.json' });  // warm the cache

  folders[0] = RENAMED;
  files[RENAMED] = { 'Questionnaire/q.json': '{}' };
  delete files[EXPECT];
  ids[RENAMED] = 'the-real-folder';

  const where = { clientName: CLIENT, caseRef: REF, subfolder: 'Questionnaire', filename: 'q.json' };
  const versions = await h.svc.listFileVersions(where);
  assert.ok(Array.isArray(versions), 'the renamed folder is followed rather than reported as having no history');

  const p = require.resolve('axios');
  const realGet = require.cache[p].exports.get;
  require.cache[p].exports.get = async (url) => {
    if (/:\/versions/.test(decodeURIComponent(url))) { const e = new Error('boom'); e.response = { status: 500 }; throw e; }
    return realGet(url);
  };
  try {
    await assert.rejects(() => h.svc.listFileVersions(where), /version list failed/,
      'a storage failure surfaces; it is never an empty history');
  } finally { require.cache[p].exports.get = realGet; }
});

test('a write confirms a cached folder name before using it — never mints a duplicate', async () => {
  // A PUT to a path whose parent is missing CREATES that parent, so a stale
  // cached name does not fail loudly: it quietly mints a second folder for the
  // case. Reads heal on the 404; writes must check BEFORE.
  const RENAMED = 'Nayala Sadaf (2720) v7 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });   // warm the cache

  folders[0] = RENAMED;                     // staff rename it in OneDrive
  files[RENAMED] = { 'Identity/a.pdf': 'ONE' };
  delete files[EXPECT];
  ids[RENAMED] = 'the-real-folder';

  await h.svc.uploadFile({ clientName: CLIENT, caseRef: REF, category: 'Identity',
    filename: 'new.pdf', buffer: Buffer.from('x'), mimeType: 'application/pdf' });
  assert.equal(h.calls.put.length, 1, 'exactly one PUT');
  assert.match(h.calls.put[0], new RegExp(RENAMED.replace(/[()]/g, '\\$&')), 'it landed in the folder that holds the documents');
  assert.ok(!h.calls.put[0].includes(`${EXPECT}/`), 'and never re-created the stale name');
});

test('a write whose confirmation cannot answer re-resolves rather than trusting the cache', async () => {
  const RENAMED = 'Nayala Sadaf (2720) v8 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });

  folders[0] = RENAMED;
  files[RENAMED] = { 'Identity/a.pdf': 'ONE' };
  delete files[EXPECT];
  ids[RENAMED] = 'the-real-folder';

  const p = require.resolve('axios');
  const realGet = require.cache[p].exports.get;
  let failed = 0;
  require.cache[p].exports.get = async (url) => {
    const dec = decodeURIComponent(url);
    if (failed === 0 && /Client Documents\/[^:/]+:$/.test(dec)) {
      failed++; const e = new Error('Graph 503'); e.response = { status: 503 }; throw e;
    }
    return realGet(url);
  };
  try {
    await h.svc.uploadFile({ clientName: CLIENT, caseRef: REF, category: 'Identity',
      filename: 'new.pdf', buffer: Buffer.from('x'), mimeType: 'application/pdf' });
    assert.equal(failed, 1, 'the confirmation really was the call that failed');
    assert.match(h.calls.put[0], new RegExp(RENAMED.replace(/[()]/g, '\\$&')), 'the write still found the right folder');
  } finally { require.cache[p].exports.get = realGet; }
});

test('a write whose confirmation is throttled follows the folder by id, not by the name tie-break', async () => {
  // The dangerous shape: the real folder renamed away (same driveItem), a
  // NON-EMPTY duplicate left behind under the old name — so the split-case
  // tie-break (most children, then shortest name) prefers the wrong one.
  // A confirmation that fails must not fall back to that tie-break.
  const RENAMED = 'Nayala Sadaf (2720) v9 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'REAL' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });   // warm

  folders.length = 0; folders.push(RENAMED, EXPECT);
  files[RENAMED] = { 'Identity/a.pdf': 'REAL' };
  files[EXPECT] = { 'Identity/x.pdf': 'k', 'Legal/y.pdf': 'k', 'Employment/z.pdf': 'k' };   // MORE children
  ids[RENAMED] = 'the-real-folder';
  ids[EXPECT] = 'the-impostor';

  const p = require.resolve('axios');
  const realGet = require.cache[p].exports.get;
  let failed = 0;
  require.cache[p].exports.get = async (url) => {
    if (failed === 0 && /Client Documents\/[^:/]+:$/.test(decodeURIComponent(url))) {
      failed++; const e = new Error('Graph 429'); e.response = { status: 429 }; throw e;
    }
    return realGet(url);
  };
  try {
    await h.svc.uploadFile({ clientName: CLIENT, caseRef: REF, category: 'Identity',
      filename: 'new.pdf', buffer: Buffer.from('x'), mimeType: 'application/pdf' });
    assert.equal(failed, 1, 'the confirmation really was the call that failed');
    assert.equal(h.calls.put.length, 1, 'one PUT');
    assert.ok(!h.calls.put[0].includes(`${EXPECT}/`), 'a throttled confirmation must not hand the write to the impostor');
    assert.match(h.calls.put[0], new RegExp(RENAMED.replace(/[()]/g, '\\$&')), 'it landed with the documents');
  } finally { require.cache[p].exports.get = realGet; }
});

test('a reference lookup never overwrites a folder identity already established', async () => {
  const RENAMED = 'Nayala Sadaf (2720) v9 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'REAL' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });

  folders.length = 0; folders.push(RENAMED, EXPECT);          // renamed, impostor left behind
  files[RENAMED] = { 'Identity/a.pdf': 'REAL' };
  files[EXPECT] = { 'Identity/x.pdf': 'k', 'Legal/y.pdf': 'k', 'Employment/z.pdf': 'k' };
  ids[RENAMED] = 'the-real-folder';
  ids[EXPECT] = 'the-impostor';
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'REAL',
    'the read heals to the real folder by identity');

  // Now a lead-scoped write asks by reference. It must not re-seed the cache
  // with pickCaseFolder's answer (the bigger impostor) over what we know.
  await h.svc.findCaseFolderByRef(REF);
  await h.svc.uploadFile({ clientName: CLIENT, caseRef: REF, category: 'Identity',
    filename: 'new.pdf', buffer: Buffer.from('x'), mimeType: 'application/pdf' });
  assert.ok(!h.calls.put.some((u) => u.includes(`${EXPECT}/`)), 'the write stayed with the documents');
  assert.equal((await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' })).toString(), 'REAL',
    'and the documents are still visible afterwards');
});

test('a burst healing one rename pages the root ONCE, not once per caller', async () => {
  const RENAMED = 'Nayala Sadaf (2720) v6 - 2026-CEC-PS-012';
  const folders = [EXPECT];
  const files = { [EXPECT]: { 'Identity/a.pdf': 'ONE' } };
  const ids = { [EXPECT]: 'the-real-folder' };
  const h = harness({ folders, files, ids });
  await h.svc.readFile({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity', filename: 'a.pdf' });
  const before = h.rootListings();

  folders[0] = RENAMED;
  files[RENAMED] = { 'Identity/a.pdf': 'ONE' };
  delete files[EXPECT];
  ids[RENAMED] = 'the-real-folder';

  await Promise.all(Array.from({ length: 12 }, (_, i) =>
    h.svc.uploadFile({ clientName: CLIENT, caseRef: REF, category: 'Identity',
      filename: `f${i}.pdf`, buffer: Buffer.from('x'), mimeType: 'application/pdf' })));
  assert.equal(h.rootListings() - before, 1, '12 parallel uploads share one root enumeration');
  assert.equal(h.calls.put.length, 12, 'and all 12 were written');
  assert.ok(h.calls.put.every((u) => u.includes(`${RENAMED}/`)), 'all into the renamed folder');
});

test('a folder the tie-break merely guessed does not pin the case to itself', async () => {
  // The case ref reaches Monday before the rename runs, so a write can mint an
  // impostor that is briefly the ONLY folder carrying the reference — and gets
  // cached. Once the real folder is renamed in, the cache must still be
  // correctable: only an identity FOLLOWED to the document-holder outranks the
  // tie-break, not one the tie-break itself produced.
  const REAL = 'Nayala Sadaf - 2026-CEC-PS-012';
  const folders = [EXPECT];                                    // the impostor, alone at first
  const files = { [EXPECT]: { 'Identity/stray.pdf': 'k' } };
  const ids = { [EXPECT]: 'the-impostor' };
  const h = harness({ folders, files, ids });
  assert.equal((await h.svc.findCaseFolderByRef(REF)).id, 'the-impostor', 'it is the only candidate, so it is cached');

  folders.push(REAL);                                          // the real folder is renamed in
  files[REAL] = { 'Identity/a.pdf': 'REAL', 'Legal/b.pdf': 'x', 'Employment/c.pdf': 'x' };
  ids[REAL] = 'the-real-folder';

  assert.equal((await h.svc.findCaseFolderByRef(REF)).id, 'the-real-folder', 'the guess is corrected, not pinned');
  const listed = await h.svc.listFiles({ clientName: CLIENT, caseRef: REF, subfolder: 'Identity' });
  assert.deepEqual(listed.map((f) => f.name), ['a.pdf'], 'and reads follow the documents');
});

