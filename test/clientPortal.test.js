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
  // The actual privacy property: the RAW ops stage must never appear anywhere
  // in the client view (snap()'s caseStage is 'Document Collection Started').
  assert.ok(!html.includes('Document Collection Started'), 'raw ops stage never leaks into the client page');
});

test('clientStage: Retainer Confirmed maps to the questionnaire/documents step (not past it)', () => {
  const j = clientStage('Retainer Confirmed');
  assert.equal(j.step, 1, 'retainer signed, collection not started → step 1 is CURRENT, not done');
  assert.equal(clientStage('Submission Ready').step, 2);
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
  assert.ok(html.includes('we will email you the e-Transfer details for it shortly'),
    'due-but-not-requested row promises nothing automatic — the team sends the request');
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
    // Tripwire on the function the route ACTUALLY calls for ownership.
    stub(docSvc, 'getCaseDocuments', async () => { throw new Error('must not be called'); }),
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
    // Ownership uses the UNFILTERED checklist — the display-only manifest
    // filter (getCaseSummary) fails closed and would 404 legit member docs.
    stub(docSvc, 'getCaseDocuments', async () => [{ id: '999', name: 'Other doc' }]),
    stub(docSvc, 'uploadFileToOneDrive', async () => { throw new Error('must not upload'); }),
  ];
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'good' }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not on this case/i);
  } finally { restore.forEach((r) => r()); }
});

test('upload endpoint: disallowed file types rejected AFTER auth (no pre-auth probing)', async () => {
  // Wrong token + bad extension → 403, never the extension error.
  const restoreAuth = stub(htmlQ, 'validateAccess', async () => { throw new Error('Invalid token'); });
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'wrong' }, body: {},
      file: { originalname: 'virus.exe', mimetype: 'application/octet-stream', buffer: Buffer.from('x') }, cookies: {} }, res);
    assert.equal(res.statusCode, 403, 'unauthenticated callers cannot probe the extension allowlist');
  } finally { restoreAuth(); }
  // Valid token + bad extension → 400 with the type message.
  const restoreOk = stub(htmlQ, 'validateAccess', async () => ({ itemId: '1', clientName: 'X' }));
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'good' }, body: {},
      file: { originalname: 'virus.exe', mimetype: 'application/octet-stream', buffer: Buffer.from('x') }, cookies: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /not allowed/i);
  } finally { restoreOk(); }
});

test('upload endpoint: happy path uploads, marks Received, returns success — no live housekeeping I/O', async () => {
  const calls = [];
  const clientMasterSvc  = require('../src/services/clientMasterService');
  const caseReadinessSvc = require('../src/services/caseReadinessService');
  const restore = [
    stub(htmlQ, 'validateAccess', async () => ({ itemId: '1', clientName: 'X' })),
    stub(docSvc, 'getCaseDocuments', async () => [{ id: '11', name: 'Passport' }]),
    stub(docSvc, 'uploadFileToOneDrive', async (...a) => { calls.push(['upload', a[0]]); }),
    stub(docSvc, 'markDocumentReceived', async (id) => { calls.push(['received', id]); }),
    // The fire-and-forget housekeeping after res.json MUST be stubbed: left
    // real, every `npm test` run would fire live Monday lookups (and, with
    // creds exported, board WRITES against caseRef '2026-SP-001').
    stub(clientMasterSvc, 'updateLastActivityDate', async () => { calls.push(['activity']); }),
    stub(caseReadinessSvc, 'calculateForCaseRef', async () => { calls.push(['readiness']); }),
  ];
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'good' }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(calls.slice(0, 2), [['upload', '11'], ['received', '11']]);
    // let the post-response fire-and-forget settle inside the stubs
    await new Promise((r) => setImmediate(r));
  } finally { restore.forEach((r) => r()); }
});

test('upload endpoint: duplicate ?t= array never crashes token parsing', async () => {
  let seenTok = null;
  const restore = stub(htmlQ, 'validateAccess', async (ref, tok) => {
    seenTok = tok; // captured in a closure — an assert inside the stub would be
    throw new Error('Invalid token'); // swallowed by the route's auth catch
  });
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: ['a', 'b'] }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 403, 'clean 403, not a TypeError 500');
    assert.equal(seenTok, 'a', 'first array value used');
  } finally { restore(); }
});

test('upload endpoint: backend outage during auth → 500 "try again", never 403 "bad link"', async () => {
  const restore = stub(htmlQ, 'validateAccess', async () => { throw new Error('Monday API timeout after 30s'); });
  try {
    const res = fakeRes();
    await uploadHandler()({ params: { caseRef: '2026-SP-001', itemId: '11' }, query: { t: 'real-token' }, body: {}, file: GOOD_FILE, cookies: {} }, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /try again/i, 'transient failure tells the client to retry, not to hunt for a new link');
  } finally { restore(); }
});

// ─── Upload middleware (this session's audit fixes) ───────────────────────────

function uploadLayer(n) {
  const layer = clientPortalRouter.stack.find((l) => l.route && l.route.path === '/:caseRef/document/:itemId/upload');
  return layer.route.stack[n].handle;
}

function multipartReq(fieldName, bytes) {
  const { PassThrough } = require('stream');
  const boundary = 'testboundary123';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, bytes, tail]);
  const req = new PassThrough();
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  req.method = 'POST';
  req.end(body);
  return req;
}

test('uploadSingle middleware: an over-20MB body becomes friendly 413 JSON, not a 500', async () => {
  const wrapper = uploadLayer(1);
  const req = multipartReq('file', Buffer.alloc(20 * 1024 * 1024 + 1024)); // just over the limit
  const res = fakeRes();
  let nexted = false;
  await new Promise((resolve) => {
    const origJson = res.json;
    res.json = (b) => { origJson(b); resolve(); return res; };
    wrapper(req, res, () => { nexted = true; resolve(); });
  });
  assert.equal(nexted, false, 'oversized upload never reaches the handler');
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /20 MB/, 'friendly size message the portal script can display');
});

test('uploadSingle middleware: an unexpected multipart field becomes 400 JSON (all multer errors answered as JSON)', async () => {
  const wrapper = uploadLayer(1);
  const req = multipartReq('wrongfield', Buffer.from('tiny'));
  const res = fakeRes();
  let nexted = false;
  await new Promise((resolve) => {
    const origJson = res.json;
    res.json = (b) => { origJson(b); resolve(); return res; };
    wrapper(req, res, () => { nexted = true; resolve(); });
  });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('uploadRateLimit middleware: 61st hit from one IP inside the window → 429 JSON', () => {
  const limiter = uploadLayer(0);
  const req = { headers: { 'x-forwarded-for': 'spoofed, 203.0.113.9' }, ip: '10.0.0.1' };
  let last = null;
  for (let i = 0; i < 61; i++) {
    const res = fakeRes();
    let passed = false;
    limiter(req, res, () => { passed = true; });
    last = { res, passed };
  }
  assert.equal(last.passed, false, '61st request blocked');
  assert.equal(last.res.statusCode, 429);
  assert.equal(last.res.body.success, false);
});

test('uploadRateLimit middleware: keys on the proxy-appended LAST XFF hop (spoofing the first entry cannot mint fresh buckets)', () => {
  const limiter = uploadLayer(0);
  // 61 requests, each with a DIFFERENT client-forged first entry but the same
  // proxy-appended real peer — must still trip the limiter.
  let last = null;
  for (let i = 0; i < 61; i++) {
    const req = { headers: { 'x-forwarded-for': `1.2.3.${i}, 198.51.100.7` }, ip: '10.0.0.1' };
    const res = fakeRes();
    let passed = false;
    limiter(req, res, () => { passed = true; });
    last = { res, passed };
  }
  assert.equal(last.passed, false, 'rotating forged XFF entries does not bypass the limiter');
  assert.equal(last.res.statusCode, 429);
});

// ─── milestoneStates: legacy Square-era rows ──────────────────────────────────

test('milestoneStates: legacy "sent" reads as requested, keeps its date, synthesizes the deterministic reference', () => {
  const { milestoneStates } = require('../src/services/milestonePaymentService');
  const lead = {
    id: '12345678',
    retainerFee: '20', retainerHstRate: '13',
    retainerMilestones: JSON.stringify([{ label: 'M1', amountCents: 2000, trigger: '' }]),
    milestonePayments: JSON.stringify({ 0: { status: 'sent', sentAt: '2026-05-01' } }), // Square-era: NO reference
  };
  const rows = milestoneStates(lead, '', []);
  assert.equal(rows[0].status, 'requested');
  assert.equal(rows[0].legacySent, true, 'flag lets staff UIs offer a deliberate re-issue');
  assert.equal(rows[0].requestedAt, '2026-05-01');
  assert.equal(rows[0].reference, 'TDOT-45678-M1',
    'the SAME deterministic reference sendMilestoneEtransferRequest would generate — never an empty refcode in the client portal');
});

test('milestoneStates: a stored reference always wins over synthesis; non-legacy rows never get legacySent', () => {
  const { milestoneStates } = require('../src/services/milestonePaymentService');
  const lead = {
    id: '12345678',
    retainerFee: '20', retainerHstRate: '13',
    retainerMilestones: JSON.stringify([{ label: 'M1', amountCents: 2000, trigger: '' }, { label: 'M2', amountCents: 2000, trigger: '' }]),
    milestonePayments: JSON.stringify({
      0: { status: 'sent', sentAt: '2026-05-01', reference: 'OLD-REF' },
      1: { status: 'requested', requestedAt: '2026-06-01', reference: 'TDOT-45678-M2' },
    }),
  };
  const rows = milestoneStates(lead, '', []);
  assert.equal(rows[0].reference, 'OLD-REF');
  assert.equal(rows[1].legacySent, false);
});

// ─── Seam test: the REAL getPortalSnapshot → buildPortalPage pipeline ─────────
//
// Every render test above feeds a hand-crafted snapshot; if the aggregator's
// output shape drifted (milestoneStates fields, getCaseSummary items, extras
// envelope), the portal would render blank cards for every client while the
// unit tests stayed green. This runs the real pipeline over stubbed leaf I/O.

test('seam: getPortalSnapshot output renders docs, payments and timeline through buildPortalPage', async () => {
  const svc       = require('../src/services/clientPortalService');
  const mondayApi = require('../src/services/mondayApi');
  const cockpit   = require('../src/services/caseCockpitService');

  const restore = [
    stub(mondayApi, 'query', async () => ({
      items: [{ column_values: [
        { id: 'color_mm0x8faa', text: 'Document Collection Started' },
        { id: 'numeric_mm0x9dea', text: '55' },
      ] }],
    })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [
      { id: '71', name: 'Passport', status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: 'Colour scan, all pages.', lastUpload: '' },
      { id: '72', name: 'IELTS', status: 'Reviewed', category: 'Language', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '2026-07-10' },
    ] })),
    stub(htmlQ, 'loadMembers', async () => [{ label: 'Principal Applicant', submittedAt: '' }]),
    stub(cockpit, 'getLeadExtras', async () => ({
      lead: { id: '999', createdAt: '2026-06-01', bookedSlot: '', inviteSentAt: '' },
      payments: { retainerFee: '20', etransferEmail: 'admstdot@gmail.com', milestones: [
        { index: 0, label: 'Milestone 1', totalCents: 226000, status: 'requested', reference: 'TDOT-99-M1', due: true, legacySent: false, requestedAt: '2026-07-01', paidAt: '', method: 'e-transfer', trigger: '' },
      ] },
    })),
  ];
  try {
    const snapReal = await svc.getPortalSnapshot({
      caseRef: '2026-SP-001',
      validatedCase: { itemId: '1', clientName: 'Seam Client', caseType: 'Study Permit', caseSubType: null, accessToken: 'tok' },
    });
    const html = svc.buildPortalPage(snapReal, { mode: 'client' });
    assert.ok(html.includes('Passport') && html.includes('data-item="71"'), 'documents card renders the real snapshot rows with upload controls');
    assert.ok(html.includes('Colour scan, all pages.'), 'clientInstructions render on uploadable rows');
    assert.ok(html.includes('TDOT-99-M1') && html.includes('$2260.00'), 'payments card renders the milestone with its reference');
    assert.ok(html.includes('class="journey"'), 'journey stepper renders');
    assert.ok(!html.includes('Document Collection Started'), 'raw ops stage still never leaks');
  } finally { restore.forEach((r) => r()); }
});
