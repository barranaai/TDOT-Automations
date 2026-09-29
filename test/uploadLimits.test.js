'use strict';

// Client document uploads: 50 MB per file (owner decision 2026-09-29), one
// shared limit for both upload routes and both page scripts, and a cap on how
// many uploads may be buffered in memory at once.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const { EventEmitter } = require('events');

const L = require('../src/utils/uploadLimits');

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200; res.body = null;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.emit('finish'); return res; };
  return res;
}

test('the limit is 50 MB, in one place', () => {
  assert.equal(L.MAX_UPLOAD_MB, 50);
  assert.equal(L.MAX_UPLOAD_BYTES, 50 * 1024 * 1024);
  for (const f of ['../src/routes/clientPortal.js', '../src/routes/documentUploadForm.js', '../src/services/clientPortalService.js']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.match(src, /uploadLimits\.MAX_UPLOAD_BYTES/, `${f} reads the shared limit`);
    assert.doesNotMatch(src, /20 \* 1024 \* 1024|20 MB/, `${f} carries no leftover 20 MB`);
  }
});

test('both routes take an upload slot BEFORE multer buffers the body', () => {
  const portal = fs.readFileSync(require.resolve('../src/routes/clientPortal.js'), 'utf8');
  assert.match(portal, /uploadRateLimit, uploadLimits\.uploadSlot, uploadSingle,/);
  const docs = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');
  assert.match(docs, /'\/:caseRef\/upload\/:itemId', uploadLimits\.uploadSlot, uploadSingle,/);
});

test('uploadSlot: at most 4 in flight; the fifth is told to retry; a finished or dropped upload frees its slot', () => {
  const held = [];
  for (let i = 0; i < L.MAX_UPLOADS_IN_FLIGHT; i++) {
    const res = fakeRes(); let nexted = false;
    L.uploadSlot({}, res, () => { nexted = true; });
    assert.equal(nexted, true);
    held.push(res);
  }
  assert.equal(L._inFlightCount(), 4);
  const fifth = fakeRes(); let ran = false;
  L.uploadSlot({}, fifth, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(fifth.statusCode, 503);
  assert.equal(fifth.body.retriable, true);
  assert.match(fifth.body.error, /try again in a minute/);
  assert.equal(L._inFlightCount(), 4, 'a refused request never held a slot');
  held[0].emit('finish'); held[0].emit('close');       // both events fire on a normal response
  assert.equal(L._inFlightCount(), 3, 'released once, not twice');
  held[1].emit('close');                                // the client went away mid-upload
  assert.equal(L._inFlightCount(), 2);
  held[2].emit('finish'); held[3].emit('finish');
  assert.equal(L._inFlightCount(), 0);
});

test('friendlyUpload: too big → 413 with what to do; any other multer error → 400; no error → next', () => {
  const big = fakeRes();
  L.friendlyUpload((req, res, cb) => cb(Object.assign(new Error('x'), { code: 'LIMIT_FILE_SIZE' })), 't')({}, big, () => assert.fail('must not continue'));
  assert.equal(big.statusCode, 413);
  assert.equal(big.body.error, L.TOO_BIG_MESSAGE);
  assert.match(L.TOO_BIG_MESSAGE, /over 50 MB/);
  const odd = fakeRes();
  L.friendlyUpload((req, res, cb) => cb(Object.assign(new Error('x'), { code: 'LIMIT_UNEXPECTED_FILE' })), 't')({}, odd, () => assert.fail('must not continue'));
  assert.equal(odd.statusCode, 400);
  let nexted = false;
  L.friendlyUpload((req, res, cb) => cb(), 't')({}, fakeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
});

test('the pages tell the client the file size and the limit before sending it', () => {
  const portal = fs.readFileSync(require.resolve('../src/services/clientPortalService.js'), 'utf8');
  assert.match(portal, /The limit is ' \+ MAX_MB \+ ' MB per file/);
  const docs = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');
  assert.match(docs, /if \(file\.size > MAX_UPLOAD_BYTES\)/);
  assert.match(docs, /showToast\(data\.error \?/, 'and shows the server\'s reason when an upload is refused');
});

test('the OneDrive upload allows the time a 50 MB file needs', () => {
  const od = fs.readFileSync(require.resolve('../src/services/oneDriveService.js'), 'utf8');
  const m = od.match(/GRAPH_UPLOAD_TIMEOUT_MS\s*=\s*(\d[\d_ *]*)/);
  assert.ok(m, 'upload timeout constant present');
  assert.ok(eval(m[1].replace(/_/g, '')) >= 120000, 'at least 120 s');
});

test('the documents page still emits a script that parses, with the limit in it', () => {
  const { _formPage } = require('../src/routes/documentUploadForm');
  const members = [{ memberType: 'Principal Applicant', sections: [{ category: 'Identity', items: [{ id: '1', name: 'Passport', status: 'Missing', documentName: 'Passport' }] }] }];
  const html = _formPage('2026-TEST-001', 'Test Client', members, false, [], null);
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1]), `script block ${n} parses`); }
  assert.ok(n >= 1);
  assert.match(html, /const MAX_UPLOAD_BYTES = 52428800;/);
  assert.match(html, /const MAX_UPLOAD_MB    = 50;/);
});
