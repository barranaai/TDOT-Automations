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

// ── Team decision 2026-09-04: every signed-in staffer can open every case ────
// Visibility only. Deleting a case, restoring/repairing a client's answers, the
// status audit and the OneDrive tools stay behind ADMIN_EMAILS.

const caseAccessPolicy = require('../src/services/caseAccessService');

const withPolicy = (value, fn) => {
  const prev = process.env.CASE_VISIBILITY;
  if (value === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
};

const STRANGER = { userId: '999', teamIds: [], email: 'someone@tdotimm.com', isAdmin: false };
const ASSIGNED = { userId: '48329256', teamIds: [], email: 'gauri@tdotimm.com', isAdmin: false };
const CASE     = { personIds: ['48329256'], teamIds: [] };

test('default: any signed-in staffer sees any case; nobody signed out sees anything', () => {
  withPolicy(undefined, () => {
    assert.equal(caseAccessPolicy.caseVisibilityPolicy(), 'all');
    assert.equal(caseAccessPolicy.viewerCanSee(CASE, STRANGER), true, 'a colleague who is not assigned can now open it');
    assert.equal(caseAccessPolicy.viewerCanSee(CASE, ASSIGNED), true);
    assert.equal(caseAccessPolicy.viewerCanSee({ personIds: [], teamIds: [] }, STRANGER), true, 'an unassigned case too');
    assert.equal(caseAccessPolicy.viewerCanSee(CASE, null), false, 'still requires a signed-in viewer');
  });
});

test('CASE_VISIBILITY=assigned restores the original per-assignment rule without a deploy', () => {
  withPolicy('assigned', () => {
    assert.equal(caseAccessPolicy.caseVisibilityPolicy(), 'assigned');
    assert.equal(caseAccessPolicy.viewerCanSee(CASE, ASSIGNED), true);
    assert.equal(caseAccessPolicy.viewerCanSee(CASE, STRANGER), false);
    assert.equal(caseAccessPolicy.viewerCanSee(CASE, { ...STRANGER, isAdmin: true }), true, 'admins are unaffected');
  });
  withPolicy('ASSIGNED  ', () => assert.equal(caseAccessPolicy.caseVisibilityPolicy(), 'assigned', 'case/space tolerant'));
  withPolicy('nonsense', () => assert.equal(caseAccessPolicy.caseVisibilityPolicy(), 'all', 'anything unrecognised opens up, never silently locks out'));
});

test('opening visibility grants NO admin powers: the destructive surfaces still demand ADMIN_EMAILS', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  for (const [route, guard] of [
    ["app.get('/admin/delete/preview'", 'resolveAdminOrReject'],
    ["app.post('/admin/delete/execute'", 'resolveAdminOrReject'],
    ["app.post('/admin/onedrive/refile-general'", 'resolveAdminOrReject'],
    ["app.get('/admin/status-audit'", 'viewer.isAdmin'],
  ]) {
    const i = src.indexOf(route);
    assert.ok(i !== -1, `${route} exists`);
    assert.ok(src.slice(i, i + 700).includes(guard), `${route} still requires ${guard}`);
  }
  // restore/repair rewrite a client's saved answers — admin only, regardless of visibility
  for (const needle of ['Admins only — repair rewrites', 'Admins only — restore overwrites']) {
    assert.ok(src.includes(needle), needle);
  }
  const access = fs.readFileSync(require.resolve('../src/services/caseAccessService.js'), 'utf8');
  assert.doesNotMatch(access, /caseVisibilityPolicy\(\)[^\n]*isAdmin\s*=/, 'the policy never confers admin');
});
