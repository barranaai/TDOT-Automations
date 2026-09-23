'use strict';

// "Undo mark paid" — who may do what, and the wiring of the routes.
// The identity rules are pure (src/utils/staffIdentity); the server starts on
// import, so its wiring is checked from the source, as staffCaseAccess does.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const { actorFromStaff, namedAdminCheck } = require('../src/utils/staffIdentity');
const SRC = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
const isAdmin = (email) => ['faran@example.com'].includes(String(email).toLowerCase());

test('undo is for NAMED admins: Monday sign-in AND on the admin list — the shared key alone is not enough', () => {
  const noSignIn = namedAdminCheck(null, isAdmin);
  assert.equal(noSignIn.ok, false);
  assert.equal(noSignIn.status, 401);
  assert.match(noSignIn.error, /Sign in with Monday/);
  assert.equal(noSignIn.loginUrl, '/q/auth/monday');
  const staffer = namedAdminCheck({ name: 'Kamalpreet', email: 'k@example.com' }, isAdmin);
  assert.equal(staffer.status, 403);
  assert.match(staffer.error, /Flag as wrong/, 'a non-admin is pointed at the flag');
  const admin = namedAdminCheck({ name: 'Faran', email: 'Faran@Example.com' }, isAdmin);
  assert.equal(admin.ok, true);
  assert.deepEqual(admin.actor, { name: 'Faran', email: 'Faran@Example.com', verified: true });
});

test('who is recorded on a payment: Monday identity first, then the typed name — labelled as such', () => {
  assert.deepEqual(actorFromStaff({ name: 'Gauri Berde', email: 'g@example.com' }, 'ignored'), { name: 'Gauri Berde', email: 'g@example.com', verified: true });
  assert.deepEqual(actorFromStaff(null, '  Kamalpreet  '), { name: 'Kamalpreet', email: '', verified: false });
  assert.deepEqual(actorFromStaff(null, ''), { name: 'Unidentified (shared admin key)', email: '', verified: false }, 'says plainly nobody was identified');
  assert.equal(actorFromStaff(null, '  Kamal\npreet\t K ').name, 'Kamal preet K', 'a typed name is one line — no faked second tooltip line');
  assert.equal(actorFromStaff({ name: 'Faran\nX', email: 'f@x.com' }, '').name, 'Faran X');
  assert.equal(actorFromStaff(null, 'x'.repeat(200)).name.length, 60);
});

test('the undo routes use the NAMED-admin gate — never the shared-key admin gate', () => {
  for (const route of ["app.get('/admin/retainer/:leadId/milestone/:index/undo-preview'", "app.post('/admin/retainer/:leadId/milestone/:index/undo'"]) {
    const i = SRC.indexOf(route);
    assert.ok(i !== -1, `${route} exists`);
    const body = SRC.slice(i, i + 400);
    assert.match(body, /resolveNamedAdminOrReject\(req, res\)/, `${route} requires a named admin`);
    assert.doesNotMatch(body, /resolveAdminOrReject\(|resolveViewer\(/, `${route} must not accept the shared key`);
  }
  const gate = SRC.slice(SRC.indexOf('function resolveNamedAdminOrReject'), SRC.indexOf('function resolveNamedAdminOrReject') + 400);
  assert.match(gate, /namedAdminCheck\(tryStaffAuth\(req\), caseAccess\.isAdminEmail\)/);
});

test('undo is NOT reachable through the general action routes', () => {
  const cockpit = SRC.slice(SRC.indexOf('const COCKPIT_MS_ACTIONS'), SRC.indexOf('const COCKPIT_MS_ACTIONS') + 120);
  assert.doesNotMatch(cockpit, /undo/i);
  const portal = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  assert.doesNotMatch(portal, /executeMilestonePaidReversal|paymentUndoService/, 'the consultation action switch cannot undo');
});

test('flagging is open to any signed-in staffer, and records who flagged', () => {
  const i = SRC.indexOf("app.post('/admin/retainer/:leadId/milestone/:index/flag-error'");
  assert.ok(i !== -1);
  const body = SRC.slice(i, i + 700);
  assert.match(body, /resolveViewer\(req\)/);
  assert.match(body, /flagPaymentError\(\{[^}]*actor: staffActor\(req, staffName\)/);
});

test('every Mark paid now records who clicked — from both pages', () => {
  const cockpit = SRC.slice(SRC.indexOf("app.post('/admin/case-action/:caseRef/milestone'"), SRC.indexOf("app.post('/admin/case-action/:caseRef/milestone'") + 2600);
  assert.match(cockpit, /applyAction\(\{[^}]*actor: staffActor\(req, staffName\)/);
  const consult = SRC.slice(SRC.indexOf("app.post('/api/consultation/:leadId/action'"), SRC.indexOf("app.post('/api/consultation/:leadId/action'") + 1400);
  assert.match(consult, /actor: staffActor\(req, staffName\)/);
  const portal = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  assert.match(portal, /markMilestonePaid\(leadId, v\.normalized\.index, \{ reference: v\.normalized\.reference, actor: by \}\)/);
});

test('THE COCKPIT BUG: its milestone route reads the lead id the cockpit actually provides', () => {
  const cockpit = SRC.slice(SRC.indexOf("app.post('/admin/case-action/:caseRef/milestone'"), SRC.indexOf("app.post('/admin/case-action/:caseRef/milestone'") + 900);
  assert.match(cockpit, /L\.leadId \|\| L\.id/, 'leadId first — the cockpit lead has no .id');
  const cockpitSvc = fs.readFileSync(require.resolve('../src/services/caseCockpitService.js'), 'utf8');
  const pick = cockpitSvc.slice(cockpitSvc.indexOf('function pickLeadFields'), cockpitSvc.indexOf('function pickLeadFields') + 300);
  assert.match(pick, /leadId:\s+lead\.id/, 'the shape the route depends on');
  assert.doesNotMatch(pick, /\bid:\s+lead\.id/);
});

test('the viewer endpoint tells the page what to offer, and whether any admin is configured', () => {
  const i = SRC.indexOf("app.get('/admin/payments/viewer'");
  assert.ok(i !== -1);
  const body = SRC.slice(i, i + 900);
  assert.match(body, /canUndo: !!\(staff && staff\.email && caseAccess\.isAdminEmail\(staff\.email\)\)/, 'from the Monday sign-in, never from the key');
  assert.match(body, /adminsConfigured/);
});

test('SHARED CASE: the cockpit refuses to record payments when two client records claim the case — and fails closed', () => {
  const i = SRC.indexOf("app.post('/admin/case-action/:caseRef/milestone'");
  const body = SRC.slice(i, i + 2600);
  const guard = body.indexOf("findAllByColumnValue('clientMasterItemId', String(ctx.overview.itemId))");
  const act = body.indexOf('applyAction(');
  assert.ok(guard !== -1 && guard < act, 'the claimant check runs BEFORE any action');
  assert.match(body, /catch \(err\) \{ return res\.status\(503\)/, 'a failed lookup refuses — it never falls through to the write');
  assert.match(body, /\(claimants \|\| \[\]\)\.length > 1[\s\S]*status\(409\)/);
});

test('flagging passes the viewer through, so CASE_VISIBILITY=assigned is honoured', () => {
  const i = SRC.indexOf("app.post('/admin/retainer/:leadId/milestone/:index/flag-error'");
  assert.match(SRC.slice(i, i + 700), /flagPaymentError\(\{[^}]*viewer \}\)/);
});
