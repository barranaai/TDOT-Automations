'use strict';

// uploadFileAsNew: a client checklist upload is written as a NEW file, never
// a replacement. Graph is asked to rename on a clash and the name it reports
// is what comes back — the caller records the truth, not the request. The
// PUT lives alone in its 401-retry scope, so a failure on the sharing link
// can never re-PUT (and mint a spurious duplicate). uploadFile, which every
// app-owned file relies on for replace-in-place, is untouched.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const CLIENT = 'Jane Doe';
const REF    = '2026-CEC-EE-065';
const FOLDER = 'Jane Doe - 2026-CEC-EE-065';

function harness({ putStatus = 201, putName, putFails, linkFails, tokens = ['tok'], folders = [FOLDER] } = {}) {
  const calls = { get: [], put: [], post: [], invalidated: 0 };
  let tokenIdx = 0;
  const gone = (status, msg) => { const e = new Error(msg || `http ${status}`); e.response = { status }; return e; };
  const axios = {
    get: async (url) => {
      calls.get.push(decodeURIComponent(url));
      const dec = decodeURIComponent(url);
      if (/root:\/Client Documents:\/children/.test(dec)) {
        return { data: { value: folders.map((name) => ({ id: 'id-' + name, name, webUrl: 'https://w/f', folder: { childCount: 3 } })) } };
      }
      throw gone(404);
    },
    put: async (url, body, cfg) => {
      const auth = cfg.headers.Authorization;
      calls.put.push({ url: decodeURIComponent(url), rawUrl: url, auth, contentType: cfg.headers['Content-Type'], bytes: body.length });
      if (putFails && putFails.length) { const st = putFails.shift(); throw gone(st); }
      const dec = decodeURIComponent(url);
      const requested = /\/([^/]+):\/content/.exec(dec)[1];
      return { status: putStatus, data: { id: 'file-1', name: putName || requested, webUrl: 'https://w/file-1' } };
    },
    post: async (url, body, cfg) => {
      calls.post.push({ url: decodeURIComponent(url), body, auth: cfg.headers.Authorization });
      if (/\/createLink$/.test(url)) {
        if (linkFails && linkFails.length) { const st = linkFails.shift(); throw gone(st); }
        return { data: { link: { webUrl: 'https://org/file-1' } } };
      }
      throw gone(404);
    },
  };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('axios', axios);
  set('../src/services/microsoftMailService', {
    getAccessToken: async () => tokens[Math.min(tokenIdx, tokens.length - 1)],
    invalidateAccessToken: () => { calls.invalidated++; tokenIdx++; },
  });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const svc = require(p);
  svc._clearCaseFolderCache();
  const rootListings = () => calls.get.filter((u) => /Client Documents:\/children/.test(u)).length;
  return { svc, calls, rootListings };
}

const withConsole = async (level, fn) => {
  const lines = [];
  const orig = console[level];
  console[level] = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console[level] = orig; }
  return lines;
};

const args = (filename) => ({ clientName: CLIENT, caseRef: REF, category: 'Identity', filename, buffer: Buffer.from('PDF'), mimeType: 'application/pdf' });

test('(10) PUTs with conflictBehavior=rename, strips "/" from the name (never a sub-folder), resolves the case folder once', async () => {
  const h = harness();
  const out = await h.svc.uploadFileAsNew(args('Employment/Source – PA – 2026-09-30 14-32 – x.pdf'));
  assert.equal(h.calls.put.length, 1);
  const put = h.calls.put[0];
  assert.ok(put.url.endsWith(':/content?@microsoft.graph.conflictBehavior=rename'), put.url);
  assert.ok(put.url.includes(`/root:/Client Documents/${FOLDER}/Identity/EmploymentSource – PA – 2026-09-30 14-32 – x.pdf:/content`), 'the "/" is gone and the path has exactly root/case/category/file');
  assert.ok(put.rawUrl.includes('Client%20Documents'), 'path segments are URL-encoded');
  assert.equal(put.contentType, 'application/pdf');
  assert.equal(put.bytes, 3);
  assert.equal(h.rootListings(), 1, 'the case folder is resolved by reference, once');
  assert.deepEqual(out, { id: 'file-1', name: 'EmploymentSource – PA – 2026-09-30 14-32 – x.pdf', webUrl: 'https://w/file-1', url: 'https://org/file-1', replaced: false });
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.calls.post[0].url, 'https://graph.microsoft.com/v1.0/users/noreply@tdotimm.com/drive/items/file-1/createLink');
  assert.deepEqual(h.calls.post[0].body, { type: 'edit', scope: 'organization' });
});

test('(11) Graph renamed on a clash → the stored name is what comes back; the requested name appears nowhere in the result', async () => {
  const h = harness({ putName: 'x 1.pdf' });
  const lines = await withConsole('log', async () => {
    const out = await h.svc.uploadFileAsNew(args('x.pdf'));
    assert.equal(out.name, 'x 1.pdf');
    assert.equal(out.replaced, false);
    assert.ok(!JSON.stringify(out).includes('"x.pdf"'), 'the requested name is not reported as stored');
  });
  assert.ok(lines.some((l) => /stored as "x 1\.pdf" \(renamed on clash from "x\.pdf"\)/.test(l)), 'the rename is logged');
});

test('(12) a 200 answer means Graph REPLACED a file — flagged in the result and on console.error', async () => {
  const h = harness({ putStatus: 200 });
  const errs = await withConsole('error', async () => {
    const out = await h.svc.uploadFileAsNew(args('passport.pdf'));
    assert.equal(out.replaced, true);
    assert.equal(out.name, 'passport.pdf');
  });
  assert.equal(errs.filter((l) => l.includes('REPLACED-IN-PLACE')).length, 1);
  assert.ok(errs[0].includes(`Client Documents/${FOLDER}/Identity/passport.pdf`));
});

test('(13) link 401 → token invalidated once, link retried once, the PUT count stays 1; link 503 → url falls back to webUrl', async () => {
  let h = harness({ linkFails: [401], tokens: ['tok-a', 'tok-b'] });
  let out = await h.svc.uploadFileAsNew(args('a.pdf'));
  assert.equal(h.calls.put.length, 1, 'a link failure must NEVER re-PUT (it would mint a duplicate under rename)');
  assert.equal(h.calls.post.length, 2, 'the link was retried once');
  assert.equal(h.calls.invalidated, 1);
  assert.equal(h.calls.post[1].auth, 'Bearer tok-b', 'with the fresh token');
  assert.equal(out.url, 'https://org/file-1');

  h = harness({ linkFails: [503] });
  const warns = await withConsole('warn', async () => { out = await h.svc.uploadFileAsNew(args('a.pdf')); });
  assert.equal(h.calls.put.length, 1);
  assert.equal(out.url, 'https://w/file-1', 'the file is saved — the bare webUrl is better than nothing');
  assert.equal(out.webUrl, 'https://w/file-1');
  assert.equal(out.name, 'a.pdf');
  assert.ok(warns.some((l) => /Org link failed for a\.pdf/.test(l)));
});

test('(14) PUT 401 → one re-PUT with the fresh token (a 401 attempt wrote nothing); PUT 503 → throws, tagged transient', async () => {
  let h = harness({ putFails: [401], tokens: ['tok-a', 'tok-b'] });
  const out = await h.svc.uploadFileAsNew(args('a.pdf'));
  assert.equal(h.calls.put.length, 2);
  assert.equal(h.calls.put[0].auth, 'Bearer tok-a');
  assert.equal(h.calls.put[1].auth, 'Bearer tok-b');
  assert.equal(h.calls.invalidated, 1);
  assert.equal(out.name, 'a.pdf');
  assert.equal(h.calls.post.length, 1, 'one file, one link');

  h = harness({ putFails: [503] });
  await withConsole('error', async () => {
    await assert.rejects(() => h.svc.uploadFileAsNew(args('a.pdf')), (err) => {
      assert.match(err.message, /^OneDrive upload failed/);
      assert.equal(err.transient, true);
      return true;
    });
  });
  assert.equal(h.calls.put.length, 1, 'a 503 is not retried here — the route answers honestly and mondayApi-style retries are not Graph\'s');
  assert.equal(h.calls.post.length, 0, 'no link for a file that was not written');
});

test('(15) uploadFile is untouched: PUTs to :/content with NO query string and returns the webUrl string', async () => {
  const od = fs.readFileSync(require.resolve('../src/services/oneDriveService.js'), 'utf8');
  const i = od.indexOf('async function uploadFile(');
  const block = od.slice(i, od.indexOf('\n}\n', i));
  assert.match(block, /const url\s+= `\$\{userBase\(\)\}\/root:\/\$\{encoded\}:\/content`;/, 'no conflictBehavior on the replace-in-place writer');
  assert.doesNotMatch(block, /conflictBehavior/);
  assert.match(block, /return res\.data\.webUrl;/);
  assert.match(block, /safeFile = filename\.replace\(\/\[\*:"<>\?\\\\\|\]\/g, ''\)\.trim\(\) \|\| 'document'/, 'its own strip (keeps "/") is unchanged');
  // and behaviourally: the same fake, the old function
  const h = harness();
  const url = await h.svc.uploadFile(args('passport.pdf'));
  assert.equal(url, 'https://w/file-1');
  assert.ok(h.calls.put[0].url.endsWith(':/content'), 'no query string');
  assert.equal(h.calls.post.length, 0, 'no link');
});

test('(16) the export line the re-file test pins is intact; uploadFileAsNew is exported after it (never spliced into that line)', () => {
  const od = fs.readFileSync(require.resolve('../src/services/oneDriveService.js'), 'utf8');
  assert.match(od, /readFile, listFiles, listChildren, moveFile,/);
  const exp = od.slice(od.lastIndexOf('module.exports = {'));
  assert.match(exp, /listFileVersions, readFileVersion,\n[\s\S]*?\buploadFileAsNew,/);
});

test('(A14) a path near Graph\'s limit is warned about, measured on the DECODED path', async () => {
  const h = harness({ folders: [] });   // no folder yet → the expected "<client> - <ref>" name is used
  const client = 'N'.repeat(200);
  const long = `${'D'.repeat(60)} – ${'M'.repeat(25)} – 2026-09-30 14-32 – ${'s'.repeat(40)}.pdf`;
  const warns = await withConsole('warn', async () => {
    await h.svc.uploadFileAsNew({ clientName: client, caseRef: REF, category: 'Identity', filename: long, buffer: Buffer.from('x'), mimeType: 'application/pdf' });
  });
  const w = warns.find((l) => /path is \d+ characters/.test(l));
  assert.ok(w, 'warned');
  const decodedPath = `Client Documents/${client} - ${REF}/Identity/${long}`;
  assert.ok(decodedPath.length > 380 && decodedPath.length < 400, `fixture sits between 380 and 400 (${decodedPath.length})`);
  assert.equal(Number(/path is (\d+) characters/.exec(w)[1]), decodedPath.length, 'the count is of the DECODED path (the encoded one is far longer)');
  // and a normal path is not warned about
  const quiet = harness();
  const none = await withConsole('warn', async () => { await quiet.svc.uploadFileAsNew(args('passport.pdf')); });
  assert.equal(none.filter((l) => /path is/.test(l)).length, 0);
});
