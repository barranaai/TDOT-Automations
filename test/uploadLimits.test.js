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

test('uploadSlot: a size budget, not a count — many small files pass together, very large ones take turns', () => {
  const MB = 1024 * 1024;
  const req = (mb) => ({ headers: { 'content-length': String(mb * MB) } });
  assert.equal(L.MAX_IN_FLIGHT_BYTES, 200 * MB);
  // 30 small files at once: all admitted
  const small = [];
  for (let i = 0; i < 30; i++) { const res = fakeRes(); let ok = false; L.uploadSlot(req(5), res, () => { ok = true; }); assert.equal(ok, true, `small file ${i + 1}`); small.push(res); }
  assert.equal(L._inFlightBytes(), 150 * MB);
  // a 50 MB file still fits (200), the next one does not
  const big = fakeRes(); let bigOk = false; L.uploadSlot(req(50), big, () => { bigOk = true; });
  assert.equal(bigOk, true);
  const refused = fakeRes(); let ran = false; L.uploadSlot(req(50), refused, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.body.retriable, true);
  assert.match(refused.body.error, /try again in a minute/);
  assert.equal(L._inFlightBytes(), 200 * MB, 'a refused request never counted');
  // finishing frees exactly what was held — once, even when both events fire
  big.emit('finish'); big.emit('close');
  assert.equal(L._inFlightBytes(), 150 * MB);
  small[0].emit('close');                      // a client that went away mid-upload
  assert.equal(L._inFlightBytes(), 145 * MB);
  for (const r of small.slice(1)) r.emit('finish');
  assert.equal(L._inFlightBytes(), 0);
});

test('uploadSlot: a lone upload is always admitted; a missing or absurd size counts as a full file', () => {
  const MB = 1024 * 1024;
  assert.equal(L.declaredBytes({ headers: {} }), L.MAX_UPLOAD_BYTES);
  assert.equal(L.declaredBytes({ headers: { 'content-length': 'abc' } }), L.MAX_UPLOAD_BYTES);
  assert.equal(L.declaredBytes({ headers: { 'content-length': String(900 * MB) } }), L.MAX_UPLOAD_BYTES + MB, 'capped — multer refuses it anyway');
  assert.equal(L.declaredBytes({ headers: { 'content-length': '1048576' } }), MB);
  const res = fakeRes(); let ok = false;
  L.uploadSlot({ headers: { 'content-length': String(900 * MB) } }, res, () => { ok = true; });
  assert.equal(ok, true, 'nothing else in flight');
  res.emit('finish');
  assert.equal(L._inFlightBytes(), 0);
});

test('a slow connection gets 15 minutes to deliver the file; the header guard is untouched', () => {
  assert.equal(L.UPLOAD_REQUEST_TIMEOUT_MS, 15 * 60 * 1000);
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(src, /const server = app\.listen\(PORT/);
  assert.match(src, /server\.requestTimeout = require\('\.\/utils\/uploadLimits'\)\.UPLOAD_REQUEST_TIMEOUT_MS;/);
  assert.doesNotMatch(src, /server\.headersTimeout\s*=/);
});

test('both pages send a file again by themselves when the server says busy (up to 4 tries)', () => {
  const portal = fs.readFileSync(require.resolve('../src/services/clientPortalService.js'), 'utf8');
  assert.match(portal, /busy: r\.status === 503 && !!j\.retriable/);
  assert.match(portal, /if \(res\.busy && n < 4\)/);
  const docs = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');
  assert.match(docs, /for \(let attempt = 1; attempt <= 4; attempt\+\+\)/);
  assert.match(docs, /res\.status === 503 && data\.retriable/);
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
