'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildTimeline, summariseDocuments, pickLeadFields } = require('../src/services/caseCockpitService');

// ─── buildTimeline ────────────────────────────────────────────────────────────

test('buildTimeline: assembles the full journey in chronological order', () => {
  const ev = buildTimeline({
    lead: {
      createdAt: '2026-06-01T10:00:00Z', inviteSentAt: '2026-06-02',
      bookedSlot: '2026-06-10 15:00', meetingType: 'Virtual',
      consultationHeld: '2026-06-10', assignedConsultant: 'Shermin Teymouri Mofrad',
      consultAgreementSent: '2026-06-05', consultAgreementSigned: '2026-06-06',
      retainerSent: '2026-06-12', retainerSigned: '2026-06-15', retainerPaid: '2026-06-16',
    },
    milestones: [
      { index: 0, label: 'Milestone 1', requestedAt: '2026-06-15T18:00:00Z', paidAt: '2026-06-16', reference: 'CA1ETRF' },
      { index: 1, label: 'Milestone 2', requestedAt: '', paidAt: '' },
    ],
    qMembers: [ { key: 'primary', label: 'Principal Applicant', submittedAt: '2026-06-20T12:00:00Z' }, { key: 'spouse', label: 'Spouse' } ],
    docItems: [ { name: 'Passport', lastUpload: '2026-06-18', applicantType: 'Principal Applicant' }, { name: 'IELTS', lastUpload: '' } ],
  });

  const titles = ev.map((e) => e.title);
  assert.deepEqual(titles, [
    'Inquiry received',                            // Jun 1
    'Booking invite sent',                         // Jun 2
    'Consultation agreement sent',                 // Jun 5
    'Consultation agreement signed',               // Jun 6
    'Consultation scheduled',                      // Jun 10 15:00
    'Consultation held',                           // Jun 10 (date-only → end of day, after the slot)
    'Retainer agreement sent',                     // Jun 12
    'e-Transfer requested — Milestone 1',          // Jun 15 18:00Z
    'Retainer signed — case opened',               // Jun 15 (date-only → end of day)
    'First retainer payment recorded',             // Jun 16 (insertion order on tie)
    'Paid — Milestone 1',                          // Jun 16
    'Document received — Passport',                // Jun 18
    'Questionnaire submitted — Principal Applicant', // Jun 20
  ]);
  // dateless sources are skipped: milestone 2, spouse questionnaire, IELTS doc
  assert.ok(!titles.some((t) => t.includes('Milestone 2') || t.includes('Spouse') || t.includes('IELTS')));
});

test('buildTimeline: same-day ordering works across "YYYY-MM-DD HH:mm" and ISO formats', () => {
  const ev = buildTimeline({
    lead: { createdAt: '2026-06-10T09:00:00Z', bookedSlot: '2026-06-10 15:00' },
  });
  assert.deepEqual(ev.map((e) => e.title), ['Inquiry received', 'Consultation scheduled']);
});

test('buildTimeline: no lead → events still assemble from the other sources', () => {
  const ev = buildTimeline({
    lead: null,
    docItems: [ { name: 'Passport', lastUpload: '2026-06-18', applicantType: 'Spouse' } ],
    qMembers: [ { key: 'primary', label: 'PA', submittedAt: '2026-06-20' } ],
  });
  assert.equal(ev.length, 2);
  assert.equal(ev[0].title, 'Document received — Passport');
  assert.equal(ev[0].detail, 'Spouse');
});

test('buildTimeline: empty input → empty timeline', () => {
  assert.deepEqual(buildTimeline({}), []);
});

// ─── summariseDocuments: inline-action fields pass through ────────────────────

test('summariseDocuments: byCategory items carry id / lastUpload / reviewNotes for inline actions', () => {
  const out = summariseDocuments([
    { id: '111', name: 'Passport', status: 'Received', category: 'Identity', applicantType: 'Principal Applicant', lastUpload: '2026-06-18', reviewNotes: '' },
    { id: '222', name: 'Bank letter', status: 'Rework Required', category: 'Financial', applicantType: 'Principal Applicant', reviewNotes: 'Statement must show 6 months' },
  ]);
  const identity = out.byCategory.find((c) => c.category === 'Identity');
  assert.equal(identity.items[0].id, '111');
  assert.equal(identity.items[0].lastUpload, '2026-06-18');
  const fin = out.byCategory.find((c) => c.category === 'Financial');
  assert.equal(fin.items[0].reviewNotes, 'Statement must show 6 months');
  assert.equal(out.counts.received, 1);
  assert.equal(out.counts.rework, 1);
});

// ─── The sponsor / inviter card (overview.sponsor) ────────────────────────────
// describeFromInputs is the pure half of sponsorOnboardingService.describe —
// what the cockpit renders for the '🤝 Sponsor / inviter' card.

const S = require('../src/services/sponsorOnboardingService');
const SP_LEAD = (over = {}) => ({ id: '9001', fullName: 'Aisha Khan', clientMasterItemId: '4001', inviterName: 'Faheem Khan', inviterEmail: 'faheem@example.com', retainerSigned: '2026-09-01', retainerPaid: '2026-09-02', ...over });
const SP_BASE = { caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', clientEmail: 'aisha@example.com', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }], now: Date.parse('2026-09-24T15:00:00Z') };

test('sponsor card: a shared case (two client records) fails closed — nothing to send to', () => {
  const r = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD(), SP_LEAD({ id: '9002' })] });
  assert.equal(r.available, true);
  assert.equal(r.status, 'none');
  assert.equal(r.reason, 'shared-case');
  assert.equal(r.canSend, false);
  assert.equal(r.sendBlockedReason, 'shared-case');
  assert.equal(r.claimantCount, 2);
});

test('sponsor card: single claimant + marker sent → ok, emailed, resend allowed, section label = the sponsor', () => {
  const r = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD()], marker: { status: 'sent', sentAt: '2026-09-12T18:03:00Z', sendCount: 1 } });
  assert.equal(r.status, 'ok');
  assert.equal(r.name, 'Faheem Khan');
  assert.equal(r.roleLabel, 'Worker Spouse');
  assert.equal(r.docCount, 5);
  assert.equal(r.sectionMode, 'section');
  assert.equal(r.sectionLabel, 'Faheem Khan');
  assert.equal(r.emailedAt, '2026-09-12T18:03:00Z');
  assert.equal(r.sentCount, 1);
  assert.equal(r.canSend, true);
  assert.equal(r.sendBlockedReason, null);
});

test('sponsor card: before Document Collection the button cannot send (not-started)', () => {
  const r = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD()], caseStage: 'Retainer Signed' });
  assert.equal(r.status, 'ok');
  assert.equal(r.canSend, false);
  assert.equal(r.sendBlockedReason, 'not-started');
  assert.equal(r.emailedAt, null);
});

test('sponsor card: a marker read failure disables the button rather than guessing', () => {
  const r = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD()], markerUnavailable: true });
  assert.equal(r.markerUnavailable, true);
  assert.equal(r.canSend, false);
  assert.equal(r.sendBlockedReason, 'marker-unavailable');
});

test('sponsor card: a CEC case has no sponsor role → not-applicable (the card is hidden)', () => {
  const r = S.describeFromInputs({ ...SP_BASE, caseType: 'Canadian Experience Class (EE after ITA)', caseSubType: 'CEC Single Applicant', claimants: [SP_LEAD()] });
  assert.equal(r.status, 'none');
  assert.equal(r.reason, 'not-applicable');
});

test('sponsor card: the masked address never carries the local part', () => {
  for (const email of ['faheem@example.com', 'fk@example.com', 'faheem.khan+sowp@sub.example.co.uk']) {
    const r = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD({ inviterEmail: email })] });
    assert.equal(r.status, 'ok');
    assert.ok(!r.emailMasked.includes(email.split('@')[0]), `${email} → ${r.emailMasked}`);
    assert.ok(r.emailMasked.includes('@'), 'still recognisably an address');
  }
});

/** The cockpit fan-out, fully stubbed (no Monday, no OneDrive). */
function cockpitStubs({ sponsorDescribe } = {}) {
  const cockpit     = require('../src/services/caseCockpitService');
  const mondayApi   = require('../src/services/mondayApi');
  const htmlQ       = require('../src/services/htmlQuestionnaireService');
  const docSvc      = require('../src/services/documentFormService');
  const composition = require('../src/services/compositionAdapter');
  const stub = (obj, key, fn) => { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; };
  return [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '4001', clientName: 'Aisha Khan', caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', accessToken: 't', formFiles: { primary: 'f.html' } })),
    stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: 'color_mm0x8faa', text: 'Document Collection Started' }, { id: 'color_mm0x9fnn', text: 'Paid' }, { id: 'text_mm0xw6bp', text: 'aisha@example.com' }] }] })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [] })),
    stub(composition, 'readForCase', async () => ({ members: [] })),
    stub(htmlQ, 'loadMembers', async () => [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant', submittedAt: '' }]),
    stub(htmlQ, 'getMemberStatuses', async ({ members }) => members.map((m) => ({ ...m, status: 'In Progress', hasData: true, completionPct: 40 }))),
    stub(cockpit, 'getLeadExtras', async () => ({ lead: null, payments: null })),
    stub(S.io, 'findClaimants', async () => [SP_LEAD()]),
    stub(S.io, 'readMarker', async () => null),
    ...(sponsorDescribe ? [stub(S, 'describe', sponsorDescribe)] : []),
  ];
}

const OVERVIEW_KEYS = [
  'caseRef', 'itemId', 'clientName', 'caseType', 'caseSubType', 'accessToken', 'cmUnavailable', 'clientEmail', 'manager', 'assignees',
  'paymentStatus', 'caseStage', 'health', 'slaRisk', 'deadline', 'qReadinessPct', 'docReadinessPct', 'docReviewedPct', 'portalLink', 'folderLink',
  'family', 'questionnaire', 'documents', 'lead', 'payments', 'timeline',
];

test('getCaseOverview: keys unchanged apart from the new sponsor key, which the real describe fills from the case reads', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const restore = cockpitStubs();
  try {
    const o = await cockpit.getCaseOverview('2026-SOWP-017');
    const keys = Object.keys(o);
    assert.ok(keys.includes('sponsor'));
    assert.deepEqual(keys.filter((k) => k !== 'sponsor'), OVERVIEW_KEYS, 'no other key changes (the client portal and the cockpit page read these)');
    assert.equal(o.sponsor.available, true);
    assert.equal(o.sponsor.status, 'ok');
    assert.equal(o.sponsor.name, 'Faheem Khan');
    assert.equal(o.sponsor.canSend, true);
    assert.equal(o.sponsor.emailedAt, null);
    assert.ok(!JSON.stringify(o.sponsor).includes('faheem@'), 'the overview never carries the raw sponsor address');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('getCaseOverview: a failed sponsor read hides the card and never fails the page', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const restore = cockpitStubs({ sponsorDescribe: async () => { throw new Error('boom'); } });
  try {
    const o = await cockpit.getCaseOverview('2026-SOWP-017');
    assert.deepEqual(o.sponsor, { available: false });
    assert.equal(o.caseRef, '2026-SOWP-017');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('getCaseOverview: the describe call carries what the marker read and the gates need', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  let seen = null;
  const restore = cockpitStubs({ sponsorDescribe: async (args) => { seen = args; return { available: true, status: 'none', reason: 'no-inviter' }; } });
  try {
    const o = await cockpit.getCaseOverview('2026-SOWP-017');
    assert.equal(o.sponsor.reason, 'no-inviter');
    assert.equal(seen.itemId, '4001');
    assert.equal(seen.caseRef, '2026-SOWP-017');
    assert.equal(seen.clientName, 'Aisha Khan', 'OneDrive resolves the case folder by client name + case ref');
    assert.equal(seen.caseType, 'SOWP');
    assert.equal(seen.caseSubType, 'Outland (Spouse or Child)');
    assert.equal(seen.clientEmail, 'aisha@example.com');
    assert.equal(seen.cmUnavailable, false);
    assert.equal(seen.caseStage, 'Document Collection Started');
    assert.equal(seen.paymentStatus, 'Paid');
    assert.deepEqual(seen.composition, { members: [] });
    assert.equal(seen.qMembers.length, 1);
  } finally { restore.reverse().forEach((r) => r()); }
});

// ─── pickLeadFields ───────────────────────────────────────────────────────────

test('pickLeadFields: null-safe and maps the cockpit fields', () => {
  assert.equal(pickLeadFields(null), null);
  const f = pickLeadFields({
    id: '77', bookedSlot: '2026-06-10 15:00', meetingType: 'Virtual', meetingLink: 'https://x',
    retainerSigned: '2026-06-15', squareConsultTxnId: 'TX1', assignedConsultant: ' Shafoli Kapur ',
  });
  assert.equal(f.leadId, '77');
  assert.equal(f.meetingLink, 'https://x');
  assert.equal(f.retainerSigned, '2026-06-15');
  assert.equal(f.consultPaid, true);
  assert.equal(f.assignedConsultant, 'Shafoli Kapur');
});

test('sponsor card: the sponsor replaced after a send is NOT emailed — the card names whom the earlier email went to, and a first send needs Paid + Document Collection', () => {
  const sentToFaheem = { status: 'sent', sentAt: '2026-09-12T18:03:00Z', sendCount: 1, sponsor: { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') } };
  const r = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD({ inviterName: 'Rahim Ali', inviterEmail: 'rahim@example.com' })], marker: sentToFaheem });
  assert.equal(r.status, 'ok'); assert.equal(r.name, 'Rahim Ali');
  assert.equal(r.emailedAt, null); assert.equal(r.sentCount, 0); assert.equal(r.lastError, null);
  assert.equal(r.replacedFrom, 'f***@example.com');
  assert.equal(r.canSend, true);
  const early = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD({ inviterName: 'Rahim Ali', inviterEmail: 'rahim@example.com' })], marker: sentToFaheem, caseStage: 'Retainer Signed' });
  assert.equal(early.canSend, false); assert.equal(early.sendBlockedReason, 'not-started');
  const same = S.describeFromInputs({ ...SP_BASE, claimants: [SP_LEAD()], marker: sentToFaheem });
  assert.equal(same.replacedFrom, null); assert.equal(same.emailedAt, '2026-09-12T18:03:00Z'); assert.equal(same.sentCount, 1);
  assert.ok(!JSON.stringify(r).includes('faheem@') && !JSON.stringify(r).includes('rahim@'));
});
