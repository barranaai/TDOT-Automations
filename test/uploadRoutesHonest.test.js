'use strict';

// Nothing a client sees may lie. Until 2026-09-30 both upload routes answered
// 500 "Upload failed. Please try again." when the file HAD reached OneDrive
// and only the Monday status write failed — and the retry stored a second
// copy. Now: the file is saved → 200 { success:false, saved:true } with the
// plain-word message; the service retries the status write by itself; and
// the housekeeping (activity date, readiness) waits for a real success.

const test   = require('node:test');
const assert = require('node:assert/strict');

// One fake documentFormService for BOTH routes: /documents destructures it at
// load (so it must sit in require.cache first); the portal requires it lazily
// inside the handler and finds the same fake.
const state = { calls: [], upResult: undefined, upThrows: null, markThrows: null };
const fakeDocSvc = {
  getCaseDocuments:    async (ref) => { state.calls.push(['docs', ref]); return [{ id: '11', name: 'Passport' }]; },
  uploadFileToOneDrive: async (itemId, caseRef, buffer, name, mime) => {
    state.calls.push(['upload', itemId, caseRef, name, mime]);
    if (state.upThrows) throw state.upThrows;
    return state.upResult;
  },
  markDocumentReceived: async (id) => { state.calls.push(['received', id]); if (state.markThrows) throw state.markThrows; },
  onStatusWriteFailed:  async (p) => { state.calls.push(['statusFailed', p]); },
};
const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
set('../src/services/documentFormService', fakeDocSvc);
set('../src/services/clientMasterService', { updateLastActivityDate: async (ref) => { state.calls.push(['activity', ref]); } });
set('../src/services/caseReadinessService', { calculateForCaseRef: async (ref) => { state.calls.push(['readiness', ref]); } });

const uploadLimits = require('../src/utils/uploadLimits');
const docsRouter   = require('../src/routes/documentUploadForm');
const portalRouter = require('../src/routes/clientPortal');
const htmlQ        = require('../src/services/htmlQuestionnaireService');

function lastHandler(router, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(layer, `route ${path} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;   // multer/slot skipped; req.file preset
}
const docsUpload   = () => lastHandler(docsRouter, '/:caseRef/upload/:itemId');
const portalUpload = () => lastHandler(portalRouter, '/:caseRef/document/:itemId/upload');

function fakeRes() {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}
const FILE = { originalname: 'passport.pdf', mimetype: 'application/pdf', buffer: Buffer.from('x') };
const docsReq   = () => ({ params: { caseRef: '2026-SP-001', itemId: '11' }, file: FILE });
const portalReq = () => ({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'good' }, body: {}, file: FILE, cookies: {} });

const SAVED = { id: 'i1', name: 'Passport – PA – 2026-09-30 14-32 – passport.pdf', url: 'https://org/i1', webUrl: 'https://web/i1', replaced: false, noteBody: '📄 …', notePosted: true };

function reset(over = {}) { state.calls = []; state.upResult = undefined; state.upThrows = null; state.markThrows = null; Object.assign(state, over); }
const settle = () => new Promise((r) => setImmediate(r));
async function captureErrors(fn) {
  const lines = []; const orig = console.error; console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

const routes = [
  ['documents', docsUpload, docsReq, () => () => {}],
  ['portal', portalUpload, portalReq, () => { const orig = htmlQ.validateAccess; htmlQ.validateAccess = async () => ({ itemId: '1', clientName: 'X' }); return () => { htmlQ.validateAccess = orig; }; }],
];

for (const [name, handler, mkReq, auth] of routes) {
  test(`(23) ${name}: happy path unchanged — upload, mark Received, 200 { success:true } with no extra fields, then housekeeping`, async () => {
    reset({ upResult: SAVED });
    const restore = auth();
    try {
      const res = fakeRes();
      await handler()(mkReq(), res);
      await settle();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { success: true });
      const names = state.calls.map((c) => c[0]).filter((n) => n !== 'docs');
      assert.deepEqual(names.slice(0, 2), ['upload', 'received']);
      assert.deepEqual(state.calls.find((c) => c[0] === 'received'), ['received', '11']);
      assert.ok(names.includes('activity') && names.includes('readiness'), 'housekeeping ran after a real success');
      assert.ok(!names.includes('statusFailed'));
    } finally { restore(); }
  });

  test(`(24) ${name}: file saved but the status write failed → 200 { success:false, saved:true, error }, retry scheduled with the stored name + link, SAVED-BUT-UNMARKED logged, NO housekeeping`, async () => {
    reset({ upResult: SAVED, markThrows: new Error('Monday 502') });
    const restore = auth();
    try {
      const res = fakeRes();
      const errs = await captureErrors(async () => { await handler()(mkReq(), res); await settle(); });
      assert.equal(res.statusCode, 200, 'the request was handled; the truth is in the body');
      assert.deepEqual(res.body, { success: false, saved: true, error: uploadLimits.SAVED_NOT_MARKED_MESSAGE });
      assert.match(res.body.error, /^Your file was saved\. .*Please do not upload it again\.$/);
      const failed = state.calls.find((c) => c[0] === 'statusFailed');
      assert.ok(failed, 'the service was told');
      assert.equal(failed[1].itemId, '11');
      assert.equal(failed[1].caseRef, '2026-SP-001');
      assert.equal(failed[1].saved, SAVED, 'with everything the upload returned (name, link, note body)');
      assert.equal(failed[1].error, 'Monday 502');
      const line = errs.find((l) => l.includes('SAVED-BUT-UNMARKED'));
      assert.ok(line, 'the monitoring signal');
      assert.ok(line.includes('item 11') && line.includes('case 2026-SP-001') && line.includes(`file "${SAVED.name}"`) && line.includes(`link ${SAVED.url}`) && line.includes('Monday 502'), line);
      const names = state.calls.map((c) => c[0]);
      assert.ok(!names.includes('activity') && !names.includes('readiness'), 'no housekeeping for a row that is not Received');
    } finally { restore(); }
  });

  test(`(25) ${name}: uploadFileToOneDrive returning undefined never crashes the failure path`, async () => {
    reset({ upResult: undefined, markThrows: new Error('down') });
    const restore = auth();
    try {
      const res = fakeRes();
      const errs = await captureErrors(async () => { await handler()(mkReq(), res); await settle(); });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.saved, true);
      assert.ok(errs.some((l) => /SAVED-BUT-UNMARKED item 11 case 2026-SP-001 file "undefined" link undefined: down/.test(l)));
      const failed = state.calls.find((c) => c[0] === 'statusFailed');
      assert.equal(failed[1].saved, undefined);
    } finally { restore(); }
  });

  test(`(26) ${name}: the OneDrive write itself failing is still a 500 "Upload failed. Please try again." (nothing was stored)`, async () => {
    reset({ upThrows: Object.assign(new Error('OneDrive upload failed: 503'), { transient: true }) });
    const restore = auth();
    try {
      const res = fakeRes();
      await captureErrors(async () => { await handler()(mkReq(), res); await settle(); });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { success: false, error: 'Upload failed. Please try again.' });
      const names = state.calls.map((c) => c[0]);
      assert.ok(!names.includes('received') && !names.includes('statusFailed') && !names.includes('activity'));
    } finally { restore(); }
  });
}

test('the saved-but-unmarked message never asks for a retry, and both routes read it from the shared module', () => {
  const fs = require('fs');
  assert.doesNotMatch(uploadLimits.SAVED_NOT_MARKED_MESSAGE, /try again/i);
  for (const f of ['../src/routes/clientPortal.js', '../src/routes/documentUploadForm.js']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.match(src, /res\.status\(200\)\.json\(\{ success: false, saved: true, error: uploadLimits\.SAVED_NOT_MARKED_MESSAGE \}\)/, `${f}`);
    assert.match(src, /SAVED-BUT-UNMARKED/);
    assert.match(src, /const attemptedAt = new Date\(\);/, 'the retry job measures from the ATTEMPT, not from when the write gave up');
    assert.match(src, /onStatusWriteFailed\(\{ itemId, caseRef, saved: up, error: err\.message, attemptedAt \}\)/);
  }
  const docs = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');
  assert.match(docs, /const \{ getCaseSummary, uploadFileToOneDrive, markDocumentReceived, onStatusWriteFailed \} = require\('\.\.\/services\/documentFormService'\);/);
  assert.match(docs, /else if \(data\.saved\) \{/, 'the page script knows the saved answer');
  assert.match(docs, /savedReason = data\.error/);
  assert.match(docs, /else if \(savedPending > 0 && failed === 0\) \{[\s\S]*?#d97706/, 'rendered amber, not red');
  assert.match(docs, /row\.querySelector\('\.badge\.action-required'\)/, 'a stale "Re-upload Required" badge goes after a success');
  // A mixed pick (one uploaded, one saved-but-unmarked) must name the saved file in the SUCCESS branch too,
  // or "✓ 1 file uploaded" invites the client to send the other one again.
  const successBranch = docs.slice(docs.indexOf('if (succeeded > 0) {'), docs.indexOf('} else if (savedPending > 0 && failed === 0) {'));
  assert.match(successBranch, /if \(savedPending > 0\) \{[\s\S]*?please do not send[\s\S]*?#d97706/, 'the saved file is named, in amber');
  assert.match(docs, /document\.getElementById\('note_' \+ itemId\)/);
});
