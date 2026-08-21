'use strict';

// Guards the 2026-08-21 staff-side review findings:
//  - the questionnaire version-list/restore admin endpoints must be auth-gated
//    (they were registered on `app` with NO middleware — unauthenticated data
//    destruction: anyone could overwrite a client's live questionnaire);
//  - the /q and /d staff detail routes must enforce per-case RBAC (a sibling
//    URL must not bypass the cockpit's assigned-staff visibility control);
//  - the OAuth post-login redirect must reject non-same-site targets.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('questionnaire version endpoints are gated (versions: case access; restore: admin-only)', () => {
  const s = read('src/server.js');
  // The versions + restore handlers must resolve case access before any OneDrive call.
  const vIdx = s.indexOf("app.get('/admin/questionnaire/:caseRef/versions'");
  const rIdx = s.indexOf("app.post('/admin/questionnaire/:caseRef/restore'");
  assert.ok(vIdx > 0 && rIdx > 0, 'both endpoints exist');
  const vBlock = s.slice(vIdx, vIdx + 700);
  const rBlock = s.slice(rIdx, rIdx + 1100);
  assert.match(vBlock, /resolveCaseForWrite\(req, res, caseRef\)/, 'versions endpoint enforces case access');
  assert.match(rBlock, /resolveCaseForWrite\(req, res, caseRef\)/, 'restore endpoint enforces case access');
  assert.match(rBlock, /ctx\.viewer\.isAdmin/, 'restore is admin-only (destructive overwrite)');
  // formKey path-injection guard.
  assert.match(s, /function sanitiseFormKeyParam/);
  assert.match(vBlock, /sanitiseFormKeyParam/);
  assert.match(rBlock, /sanitiseFormKeyParam/);
});

test('/q staff routes enforce per-case RBAC via enforceCaseAccess', () => {
  const r = read('src/routes/htmlQuestionnaireForm.js');
  assert.match(r, /async function enforceCaseAccess/);
  // review, export-pdf, flag, notify, notify-all all call it.
  for (const marker of [
    "router.get('/:caseRef/review'",
    "router.get('/:caseRef/export-pdf'",
    "router.post('/:caseRef/flag'",
    "router.post('/:caseRef/notify'",
    "router.post('/:caseRef/notify-all'",
  ]) {
    const idx = r.indexOf(marker);
    assert.ok(idx > 0, `${marker} exists`);
    const block = r.slice(idx, idx + 600);
    assert.match(block, /enforceCaseAccess\(req, res, caseRef/, `${marker} enforces case access`);
  }
  // Admin key path grants full access; the substring-token 403 guess can't fire here.
  assert.match(r, /req\.isAdminKey = true/);
});

test('/d document-review routes enforce per-case RBAC', () => {
  const d = read('src/routes/documentReviewForm.js');
  assert.match(d, /async function enforceCaseAccess/);
  const count = (d.match(/enforceCaseAccess\(req, res, caseRef/g) || []).length;
  assert.ok(count >= 3, `all 3 /d routes gated (found ${count})`);
});

test('OAuth returnTo only permits same-site relative paths (no open redirect)', () => {
  const r = read('src/routes/htmlQuestionnaireForm.js');
  assert.match(r, /function safeReturnTo/);
  // both the intake and the redirect sink route through it
  assert.match(r, /res\.redirect\(safeReturnTo\(returnTo\)\)/);
  // Reconstruct the validator and check it rejects the dangerous shapes.
  const m = r.match(/function safeReturnTo\(raw\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'safeReturnTo body found');
  // eslint-disable-next-line no-new-func
  const fn = new Function('raw', m[0].replace(/^function safeReturnTo\(raw\) \{/, '').replace(/\}$/, ''));
  assert.equal(fn('/admin/case/2026-VV-006'), '/admin/case/2026-VV-006');
  assert.equal(fn('https://evil.com'), '/admin/dashboard');
  assert.equal(fn('//evil.com'), '/admin/dashboard');
  assert.equal(fn('/\\evil.com'), '/admin/dashboard');
  assert.equal(fn('javascript:alert(1)'), '/admin/dashboard');
});

test('read-swallow-then-replace closed on the member manifest and flags', () => {
  const q = read('src/services/htmlQuestionnaireService.js');
  const lm = q.slice(q.indexOf('async function loadMembers'), q.indexOf('async function saveMembers'));
  assert.match(lm, /err\.transient = true;\s*\n\s*throw err;/);
  const rv = read('src/services/htmlQuestionnaireReviewService.js');
  const lf = rv.slice(rv.indexOf('async function loadFlags'), rv.indexOf('async function saveFlags'));
  assert.match(lf, /err\.transient = true;\s*\n\s*throw err;/);
});

test('flag save preserves the client reply (edit must not erase it)', () => {
  const r = read('src/routes/htmlQuestionnaireForm.js');
  const idx = r.indexOf("router.post('/:caseRef/flag'");
  const block = r.slice(idx, idx + 1400);
  assert.match(block, /const existing = await review\.loadFlags/);
  assert.match(block, /clientReply/);
  assert.match(block, /clientRepliedAt/);
});
