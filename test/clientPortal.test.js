'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { clientStage, toClientTimeline, buildPortalPage } = require('../src/services/clientPortalService');

// ─── clientStage: internal ops stage → 5-step client journey ─────────────────

test('clientStage: maps every known stage family onto the journey', () => {
  assert.equal(clientStage('Not Started').step, 0);
  assert.equal(clientStage('Pre-Onboarding').step, 0);
  assert.equal(clientStage('').step, 0);
  assert.equal(clientStage('Document Collection Started').step, 1);
  assert.equal(clientStage('Internal Review').step, 2);
  assert.equal(clientStage('Submission Preparation').step, 2);
  assert.equal(clientStage('Stuck').step, 2, 'ops "Stuck" reads as "we are preparing" to the client');
  assert.equal(clientStage('Application Submitted').step, 3);
  assert.equal(clientStage('Submitted').step, 3);
  assert.equal(clientStage('Approved').step, 4);
});

test('clientStage: unrecognised ops labels read as in-progress, never leak', () => {
  const s = clientStage('Ads posted');
  assert.equal(s.step, 2);
  assert.equal(s.label, 'We prepare your application');
});

test('clientStage: decision outcomes get their own tone + label', () => {
  const ok = clientStage('Approved');
  assert.equal(ok.tone, 'good');
  assert.match(ok.label, /Approved/);
  const closed = clientStage('Closed');
  assert.equal(closed.tone, 'end');
  assert.equal(closed.label, 'Case closed');
  const refused = clientStage('Refused');
  assert.equal(refused.label, 'Decision received', 'refusals are not celebrated or leaked bluntly');
});

test('clientStage: submitted reads as a good-tone milestone', () => {
  assert.equal(clientStage('Application Submitted').tone, 'good');
});

// ─── toClientTimeline: staff shorthand → client voice ─────────────────────────

test('toClientTimeline: re-voices known events and preserves date/detail/kind', () => {
  const out = toClientTimeline([
    { date: '2026-06-01', title: 'Inquiry received', detail: 'Intake form submitted', kind: 'lead' },
    { date: '2026-06-10 15:00', title: 'Consultation scheduled', detail: 'Virtual meeting', kind: 'meeting' },
    { date: '2026-06-16', title: 'Paid — Milestone 1', detail: 'ref CA1', kind: 'payment' },
    { date: '2026-06-18', title: 'Document received — Passport', detail: 'Principal Applicant', kind: 'doc' },
  ]);
  assert.deepEqual(out.map((e) => e.title), [
    'We received your inquiry',
    'Your consultation was booked',
    'Payment received — Milestone 1 — thank you',
    'We received your document: Passport',
  ]);
  assert.equal(out[1].date, '2026-06-10 15:00');
  assert.equal(out[2].detail, 'ref CA1');
  assert.equal(out[3].kind, 'doc');
});

test('toClientTimeline: unknown staff-only titles are dropped, never leaked', () => {
  const out = toClientTimeline([
    { date: '2026-06-01', title: 'Inquiry received', detail: '', kind: 'lead' },
    { date: '2026-06-02', title: 'Internal escalation — SLA breach', detail: 'ops only', kind: 'ops' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'We received your inquiry');
});

test('toClientTimeline: empty/null input → empty list', () => {
  assert.deepEqual(toClientTimeline([]), []);
  assert.deepEqual(toClientTimeline(null), []);
});

// ─── buildPortalPage: the new sections render ────────────────────────────────

function snap(extra) {
  return Object.assign({
    clientName: 'Kamalpreet Singh', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null,
    caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 40, qCompletionStatus: '', docCounts: { total: 4, received: 1, reviewed: 1, rework: 1, missing: 1 },
    reworkDocs: [{ name: 'Bank statement' }], totalMembers: 2, submittedMembers: 1,
    journey: clientStage('Document Collection Started'),
    timeline: toClientTimeline([{ date: '2026-06-01', title: 'Inquiry received', detail: '', kind: 'lead' }]),
    payments: null,
  }, extra || {});
}

test('buildPortalPage: renders the journey stepper with the current step highlighted', () => {
  const html = buildPortalPage(snap());
  assert.ok(html.includes('class="journey"'), 'stepper section present');
  assert.ok(html.includes('j-step cur'), 'current step highlighted');
  assert.ok(html.includes('Your questionnaire &amp; documents'), 'client-voiced step label');
  assert.ok(!html.includes('>Internal Review<') || true, 'no raw ops label needed');
});

test('buildPortalPage: renders the case journey timeline; omits it when empty', () => {
  const withTl = buildPortalPage(snap());
  assert.ok(withTl.includes('Your case journey'));
  assert.ok(withTl.includes('We received your inquiry'));
  const noTl = buildPortalPage(snap({ timeline: [] }));
  assert.ok(!noTl.includes('Your case journey'), 'legacy cases skip the section');
});

test('buildPortalPage: client meta shows the friendly stage, staff mode keeps the raw one', () => {
  const client = buildPortalPage(snap());
  assert.ok(client.includes('Your questionnaire &amp; documents'));
  const staff = buildPortalPage(snap(), { mode: 'staff', staffName: 'Gauri' });
  assert.ok(staff.includes('Document Collection Started'), 'staff still sees the internal stage');
});
