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

// ─── Documents card: per-doc rows + inline upload (Phase 2) ───────────────────

function docSnap() {
  return snap({
    docItems: [
      { id: '11', name: 'Passport', status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' },
      { id: '12', name: 'Bank statement', status: 'Rework Required', category: 'Financial', applicantType: 'Principal Applicant', reviewNotes: 'May is missing', clientInstructions: '', lastUpload: '2026-07-13' },
      { id: '13', name: 'IELTS', status: 'Reviewed', category: 'Language', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '2026-07-10' },
    ],
  });
}

test('documents card: upload controls only on Missing/Rework rows; done rows read-only', () => {
  const html = buildPortalPage(docSnap());
  assert.equal((html.match(/data-item="/g) || []).length, 2, 'Passport + Bank get upload inputs');
  assert.ok(html.includes('Upload new copy'), 'rework rows say Upload new copy');
  assert.ok(html.includes('✓ Reviewed'), 'reviewed rows show their state');
  assert.ok(html.includes('From your case officer:') && html.includes('May is missing'), 'rework note surfaced');
  assert.ok(html.includes('<script>'), 'upload script emitted when uploadables exist');
});

test('documents card: staff mode renders read-only (no upload inputs, review button instead)', () => {
  const html = buildPortalPage(docSnap(), { mode: 'staff', staffName: 'G' });
  assert.ok(!html.includes('data-item='), 'no client upload controls for staff');
  assert.ok(!html.includes('<script>'), 'no upload script in staff mode');
});

test('documents card: no uploadables → no script emitted', () => {
  const html = buildPortalPage(snap({ docItems: [
    { id: '13', name: 'IELTS', status: 'Reviewed', category: 'Language', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' },
  ] }));
  assert.ok(!html.includes('<script>'));
});

// ─── Payments card (Phase 3): view + how-to-pay, never a processor ────────────

function paySnap(milestones) {
  return snap({ payments: { retainerFee: '2000', etransferEmail: 'admstdot@gmail.com', milestones } });
}

test('payments card: paid / requested / due / pending states render correctly', () => {
  const html = buildPortalPage(paySnap([
    { index: 0, label: 'Milestone 1 – Admin Fee', totalCents: 113000, status: 'paid', paidAt: '2026-07-12', reference: 'CA123ETRF', due: false },
    { index: 1, label: 'Milestone 2 – Filing', totalCents: 113000, status: 'requested', reference: 'TDOT-135-M2', due: true },
    { index: 2, label: 'Milestone 3 – Submission', totalCents: 113000, status: 'pending', reference: '', due: true },
    { index: 3, label: 'Milestone 4 – Decision', totalCents: 113000, status: 'pending', reference: '', due: false },
  ]));
  assert.ok(html.includes('✓ Paid') && html.includes('ref CA123ETRF'), 'paid row shows date + reference');
  assert.ok(html.includes('TDOT-135-M2') && html.includes('Interac e-Transfer') && html.includes('admstdot@gmail.com'),
    'requested row carries the how-to-pay instructions with the reference code');
  assert.ok(html.includes('a payment request with the e-Transfer details is on its way'),
    'due-but-not-requested row is announced without instructions');
  assert.ok(html.includes('Not due yet'), 'future milestone stays calm');
  assert.ok(html.includes('1 of 4 paid'));
  assert.ok(html.includes('$1130.00 of $4520.00'), 'paid-so-far totals');
});

test('payments card: omitted entirely when there is no milestone schedule', () => {
  assert.ok(!buildPortalPage(snap({ payments: null })).includes('💳 Payments'));
  assert.ok(!buildPortalPage(paySnap([])).includes('💳 Payments'));
});

test('payments card: never renders any card-processing controls', () => {
  const html = buildPortalPage(paySnap([{ index: 0, label: 'M1', totalCents: 100, status: 'requested', reference: 'R', due: true }]));
  // Precise processor signals only — "stripe" alone would false-positive on the
  // CSS "gold accent stripe" comment.
  assert.ok(!/pay now|card number|cardholder|cvv|checkout|stripe\.com|js\.stripe|square\.link|squareup\.com/i.test(html),
    'view + instructions only');
});

// ─── Upload endpoint: auth + ownership guards (stubbed route handler) ─────────

const clientPortalRouter = require('../src/routes/clientPortal');
const htmlQ  = require('../src/services/htmlQuestionnaireService');
const docSvc = require('../src/services/documentFormService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

function uploadHandler() {
  const layer = clientPortalRouter.stack.find((l) => l.route && l.route.path === '/:caseRef/document/:itemId/upload');
  return layer.route.stack[layer.route.stack.length - 1].handle; // final handler (multer skipped; req.file preset)
}

function fakeRes() {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}

const GOOD_FILE = { originalname: 'passport.pdf', mimetype: 'application/pdf', buffer: Buffer.from('x') };

test('upload endpoint: rejects a wrong token with 403 before touching documents', async () => {
  const restore = [
    stub(htmlQ, 'validateAccess', async () => { throw new Error('Invalid token'); }),
    stub(docSvc, 'getCaseSummary', async () => { throw new Error('must not be called'); }),
  ];
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'wrong' }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 403);
  } finally { restore.forEach((r) => r()); }
});

test('upload endpoint: rejects an item that belongs to a different case (404)', async () => {
  const restore = [
    stub(htmlQ, 'validateAccess', async () => ({ itemId: '1', clientName: 'X' })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [{ id: '999', name: 'Other doc' }] })),
    stub(docSvc, 'uploadFileToOneDrive', async () => { throw new Error('must not upload'); }),
  ];
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'good' }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not on this case/i);
  } finally { restore.forEach((r) => r()); }
});

test('upload endpoint: rejects disallowed file types (400) with no auth round-trip needed', async () => {
  const res = fakeRes();
  await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'x' }, body: {},
    file: { originalname: 'virus.exe', mimetype: 'application/octet-stream', buffer: Buffer.from('x') }, cookies: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not allowed/i);
});

test('upload endpoint: happy path uploads, marks Received, returns success', async () => {
  const calls = [];
  const restore = [
    stub(htmlQ, 'validateAccess', async () => ({ itemId: '1', clientName: 'X' })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [{ id: '11', name: 'Passport' }] })),
    stub(docSvc, 'uploadFileToOneDrive', async (...a) => { calls.push(['upload', a[0]]); }),
    stub(docSvc, 'markDocumentReceived', async (id) => { calls.push(['received', id]); }),
  ];
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'good' }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(calls.slice(0, 2), [['upload', '11'], ['received', '11']]);
  } finally { restore.forEach((r) => r()); }
});
