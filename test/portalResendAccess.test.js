'use strict';

// Resend portal access from the staff case page (Gauri 2026-09-04, point 03).
//
// Faran's decision (2026-09-09): available for ANY case, whatever its stage
// or payment status. Defaults: the existing token is reused (earlier links
// keep working) and the email is a short "here is your portal link again"
// variant that never prints the token separately. Staff cookie required;
// the client token is never authority; an audit note lands on the case.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');

const mondayApi  = require('../src/services/mondayApi');
const mail       = require('../src/services/microsoftMailService');
const htmlQ      = require('../src/services/htmlQuestionnaireService');
const tokens     = require('../src/services/accessTokenService');
const emailSvc   = require('../src/services/emailService');
const portalSvc  = require('../src/services/clientPortalService');
const staffAuth  = require('../src/middleware/staffAuth');
const router     = require('../src/routes/clientPortal');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function handler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:caseRef/resend-access');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const CM_ROW = (over = {}) => ({ items: [{ name: 'Jasnoor Kaur', column_values: [
  { id: 'text_mm0xw6bp', text: over.email === undefined ? 'jasnoor.k@example.com' : over.email },
  { id: 'text_mm142s49', text: '2026-OINP-006' },
  { id: 'dropdown_mm0xd1qn', text: 'OINP' },
  { id: 'text_mm0x6haq', text: over.token === undefined ? 'TDOT-abc' : over.token },
  { id: 'color_mm0x8faa', text: 'Profile Created' },
  { id: 'color_mm0x9fnn', text: 'Already Sent' },   // never onboarded — still allowed
] }] });

// ─── The email: resend variant, no payment gate, honest return value ─────────

test('sendIntakeEmail(resend): "link again" wording, same links, token not printed, sent to the row\'s email regardless of payment status', async () => {
  const sent = [];
  const restore = [stub(mondayApi, 'query', async () => CM_ROW()), stub(mail, 'sendEmail', async (m) => { sent.push(m); })];
  try {
    const r = await emailSvc.sendIntakeEmail('12652949990', { resend: true });
    assert.deepEqual(r, { sent: true, to: 'jasnoor.k@example.com', caseRef: '2026-OINP-006' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Your Client Portal link — 2026-OINP-006');
    assert.match(sent[0].html, /Here is your Client Portal link again/);
    assert.ok(!/Your case has been set up/.test(sent[0].html), 'no onboarding wording');
    assert.ok(sent[0].html.includes('/client/2026-OINP-006?t=TDOT-abc'), 'same portal link, same token');
    assert.ok(!/Access Token<\/td>/.test(sent[0].html), 'the token is carried by the links only');
    assert.match(sent[0].html, /re-sent your portal link so you can pick up where you left off/);
    assert.match(sent[0].html, /Case Type<\/td>/, 'the type row shows when the case has one');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('sendIntakeEmail: the onboarding email is unchanged, and a missing address is reported, not thrown', async () => {
  const sent = [];
  const restore = [stub(mondayApi, 'query', async () => CM_ROW()), stub(mail, 'sendEmail', async (m) => { sent.push(m); })];
  try {
    const r = await emailSvc.sendIntakeEmail('12652949990');
    assert.equal(r.sent, true);
    assert.match(sent[0].subject, /^Action Required — Your OINP Case Is Ready/);
    assert.match(sent[0].html, /Your case has been set up/);
    assert.match(sent[0].html, /Access Token<\/td>/);
  } finally { restore.reverse().forEach((r) => r()); }
  const restore2 = [stub(mondayApi, 'query', async () => CM_ROW({ email: '' })), stub(mail, 'sendEmail', async () => { throw new Error('must not send'); })];
  try {
    const r = await emailSvc.sendIntakeEmail('12652949990', { resend: true });
    assert.equal(r.sent, false);
    assert.match(r.reason, /no client email/);
  } finally { restore2.reverse().forEach((r) => r()); }
});

// ─── The route: staff only, any case, audit note ─────────────────────────────

/** A REAL staff cookie (signed with the dev secret) — the route reads it through tryStaffAuth. */
const asStaff = (staff) => ({ tdot_staff: staffAuth.createStaffToken(staff) });
const GAURI   = { id: '105063919', name: 'Gauri Berde', email: 'gauri@tdotimm.com', teamIds: [] };

test('resend route: no staff cookie → 401 and nothing is sent, even with a valid client token in the query', async () => {
  const restore = [stub(emailSvc, 'sendIntakeEmail', async () => { throw new Error('must not send'); })];
  try {
    const res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: { t: 'TDOT-abc' }, cookies: {} }, res);
    assert.equal(res.statusCode, 401);
    const bad = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: { tdot_staff: 'not-a-jwt' } }, bad);
    assert.equal(bad.statusCode, 401);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('resend route: staff → sends the resend variant for a never-onboarded case and posts an audit note with the masked address', async () => {
  const updates = [];
  const restore = [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '12652949990', clientName: 'Jasnoor Kaur' })),
    stub(emailSvc, 'sendIntakeEmail', async (itemId, opts) => { assert.equal(opts.resend, true); return { sent: true, to: 'jasnoor.k@example.com', caseRef: '2026-OINP-006' }; }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) updates.push(vars.body); return {}; }),
  ];
  try {
    const res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: asStaff(GAURI) }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, to: 'j***@example.com', noted: true }, 'the note is awaited, so the page can say it exists');
    assert.equal(updates.length, 1);
    assert.match(updates[0], /Portal access email re-sent by Gauri Berde to j\*\*\*@example\.com/);
    assert.ok(!updates[0].includes('jasnoor.k@'), 'the full address never lands in the case thread');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('resend route: no client email on the row → 400 with the reason; a send failure → 502', async () => {
  const base = [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '900002', clientName: 'X' })),   // its own item: the per-case cool-down is process-wide
  ];
  const monica = asStaff({ id: '1', name: 'Monica', email: 'monica@tdotimm.com', teamIds: [] });
  const r1 = stub(emailSvc, 'sendIntakeEmail', async () => ({ sent: false, to: '', caseRef: '2026-OINP-006', reason: 'This case has no client email on the Client Master row.' }));
  try {
    const res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: monica }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no client email/);
  } finally { r1(); }
  const r2 = stub(emailSvc, 'sendIntakeEmail', async () => { throw new Error('Graph 503'); });
  try {
    const res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: monica }, res);
    assert.equal(res.statusCode, 502);
  } finally { r2(); base.reverse().forEach((r) => r()); }
});

test('resend route: under CASE_VISIBILITY=assigned an unassigned staffer is refused; an assignee is allowed', async () => {
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  const people = { items: [{ column_values: [{ id: 'multiple_person_mm0xgpt', value: JSON.stringify({ personsAndTeams: [{ id: 105063919, kind: 'person' }] }) }] }] };
  const restore = [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '900003', clientName: 'X' })),
    stub(mondayApi, 'query', async (q) => (/create_update/.test(q) ? {} : people)),
    stub(emailSvc, 'sendIntakeEmail', async () => ({ sent: true, to: 'a@b.co', caseRef: '2026-OINP-006' })),
  ];
  try {
    let res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: asStaff({ id: '999', name: 'Someone', email: 'someone@tdotimm.com', teamIds: [] }) }, res);
    assert.equal(res.statusCode, 403);
    res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: asStaff({ id: '105063919', name: 'Shermin', email: 'shermin@tdotimm.com', teamIds: [] }) }, res);
    assert.equal(res.statusCode, 200);
  } finally {
    restore.reverse().forEach((r) => r());
    if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev;
  }
});

test('resend route: a second send for the same case within a minute is refused with 429; a failed Monday note is reported honestly', async () => {
  let noteFails = false;
  const restore = [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '900004', clientName: 'X' })),
    stub(emailSvc, 'sendIntakeEmail', async () => ({ sent: true, to: 'a@b.co', caseRef: '2026-OINP-006' })),
    stub(mondayApi, 'query', async (q) => { if (/create_update/.test(q) && noteFails) throw new Error('Monday 500'); return {}; }),
  ];
  try {
    let res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: asStaff(GAURI) }, res);
    assert.equal(res.statusCode, 200);
    res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: asStaff(GAURI) }, res);
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /less than a minute ago/);
    // A different case is not blocked, and a failed audit note comes back as noted:false.
    restore.push(stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '900005', clientName: 'Y' })));
    noteFails = true;
    res = fakeRes();
    await handler()({ params: { caseRef: '2026-OINP-007' }, query: {}, cookies: asStaff(GAURI) }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, to: 'a***@b.co', noted: false });
  } finally { restore.reverse().forEach((r) => r()); }
});

test('resend route: the 401 body carries the login URL the page turns into a "Sign in again" link', async () => {
  const res = fakeRes();
  await handler()({ params: { caseRef: '2026-OINP-006' }, query: {}, cookies: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.loginUrl, '/q/auth/monday');
  const html = portalSvc.buildPortalPage(snap(), { mode: 'staff', staffName: 'Gauri' });
  assert.match(html, /Sign in again/);
  assert.match(html, /the Monday note could not be added/);
});

// ─── The page: staff sees the control; the client never does ─────────────────

function snap(extra) {
  return Object.assign({
    clientName: 'Jasnoor Kaur', caseRef: '2026-OINP-006', caseType: 'OINP', caseSubType: null,
    caseStage: 'Profile Created', accessToken: 'tok',
    qReadinessPct: 0, qSubmitted: false, qLabel: 'Not Started', qUnavailable: false,
    clientEmailMasked: 'j***@example.com', hasClientEmail: true,
    docCounts: { total: 0, received: 0, reviewed: 0, rework: 0, missing: 0 }, docItems: [],
    totalMembers: 1, submittedMembers: 0,
    journey: portalSvc.clientStage('Profile Created'), timeline: [], payments: null,
  }, extra || {});
}
function scriptsOf(html) { return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }

test('portal page: the staff view shows the masked destination and the button; the script parses; the client view has neither', () => {
  const staff = portalSvc.buildPortalPage(snap(), { mode: 'staff', staffName: 'Gauri' });
  assert.match(staff, /Client access/);
  assert.match(staff, /j\*\*\*@example\.com/);
  assert.match(staff, /id="resend-access-btn"(?![^>]*disabled)/);
  const scripts = scriptsOf(staff);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'the staff script is valid JavaScript');
  assert.match(scripts[0], /\/resend-access/);
  const client = portalSvc.buildPortalPage(snap(), { mode: 'client' });
  assert.ok(!/Client access|resend-access/.test(client), 'clients never see the control');
});

test('portal page: no client email on the row → the button is disabled and says why; hostile values stay inert in the script', () => {
  const html = portalSvc.buildPortalPage(snap({ hasClientEmail: false, clientEmailMasked: '', caseRef: '2026-OINP-006</script><script>alert(1)' }), { mode: 'staff', staffName: 'Gauri' });
  assert.match(html, /id="resend-access-btn" disabled/);
  assert.match(html, /No client email on the Client Master row/);
  const scripts = scriptsOf(html);
  assert.equal(scripts.length, 1, 'the injected </script> never opens a second script');
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});

test('maskEmail: first character + domain only; anything that is not one plain address masks fully', () => {
  assert.equal(portalSvc.maskEmail('jasnoor.k@gmail.com'), 'j***@gmail.com');
  assert.equal(portalSvc.maskEmail('  Aamir@Example.org '), 'A***@Example.org');
  assert.equal(portalSvc.maskEmail('😀x@y.com'), '😀***@y.com', 'no split surrogate pair');
  assert.equal(portalSvc.maskEmail(''), '');
  assert.equal(portalSvc.maskEmail('not-an-email'), '***');
  assert.equal(portalSvc.maskEmail('a@b.com, c@d.com'), '***', 'a second address never leaks');
  assert.equal(portalSvc.maskEmail('Jasnoor Kaur <jas@x.com>'), '***');
});
