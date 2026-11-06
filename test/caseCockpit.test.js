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
  'caseRef', 'itemId', 'clientName', 'caseType', 'caseSubType',
  'familyAddTypes',   // the member types the case page may add (2026-10-07)
  'accessToken', 'cmUnavailable', 'clientEmail', 'manager', 'assignees',
  'paymentStatus', 'caseStage', 'health', 'slaRisk', 'deadline', 'clientDeadline',
  // document reminders (block 2, 2026-11-06): the stored deadline answer, the board group, the lock, Manual Override
  // (the send gate, review 2026-11-07) and the escalation engine's stamp (a preview warning only), and the Reminders card's facts
  'clientDeadlineRaw', 'group', 'automationLock', 'manualOverride', 'escalationLastNotified', 'reminders',
  'qReadinessPct', 'docReadinessPct', 'docReviewedPct', 'portalLink', 'folderLink',
  'family', 'questionnaire', 'documents', 'lead', 'payments', 'timeline',
];

test('getCaseOverview: keys unchanged apart from the new sponsor key, which the real describe fills from the case reads', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const restore = cockpitStubs();
  try {
    const o = await cockpit.getCaseOverview('2026-SOWP-017');
    assert.deepEqual(o.familyAddTypes, require('../config/questionnaireFormMap').resolveMemberTypes(o.caseType, o.caseSubType), 'the Family card offers exactly the questionnaire\'s member types for this case');
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


// ─── Document reminders (block 2, 2026-11-06): the overview facts + the case page's card ───

const vm = require('vm');
const { parseHtml } = require('./helpers/fakeDom');
const docRem = require('../src/services/docReminderService');
const T_REM = Date.parse('2026-11-07T15:14:00Z');   // 7 Nov 2026, 10:14 am Toronto

/** The cockpit fan-out with the Client Master read answering group + columns + notes (the one read the card uses). */
function reminderStubs({ cmFail = false, docsFail = false, updates = [], items = [{ id: '1', name: 'Passport', status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', applicantLabel: 'Principal Applicant', optional: false }], lock = 'No', override = '', stage = 'Document Collection Started', payment = 'Paid', group = { id: 'group_sv', title: 'Super Visa' } } = {}) {
  const cockpit     = require('../src/services/caseCockpitService');
  const mondayApi   = require('../src/services/mondayApi');
  const htmlQ       = require('../src/services/htmlQuestionnaireService');
  const docSvc      = require('../src/services/documentFormService');
  const composition = require('../src/services/compositionAdapter');
  const stub = (obj, key, fn) => { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; };
  return [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '4001', clientName: 'Aisha Khan', caseType: 'Super Visa', caseSubType: 'Parent', accessToken: 'tok-1', formFiles: { primary: 'f.html' } })),
    stub(mondayApi, 'query', async (q) => {
      if (cmFail) throw new Error('monday down');
      assert.match(q, /items\(ids: \[\$itemId\], limit: 1\)/, 'the Client Master read carries an explicit limit');
      assert.match(q, /"color_mm0x975e"/, 'Manual Override rides on the same read (the send gate, review 2026-11-07)');
      assert.match(q, /updates\(limit: 100\) \{ id created_at text_body body \}/, "the newest 100 notes (Monday's maximum) ride on the same read — review 2026-11-07 [2]/[16]/[24]");
      return { items: [{ group, updates, column_values: [
        { id: 'color_mm0x8faa', text: stage }, { id: 'color_mm0x9fnn', text: payment }, { id: 'text_mm0xw6bp', text: 'aisha@example.com' },
        { id: 'color_mm6w7cdd', text: 'Deadline', value: '{"index":1}' }, { id: 'date_mm33sj6t', text: '2026-12-16' }, { id: 'color_mm0x3x1x', text: lock }, { id: 'color_mm0x975e', text: override }, { id: 'date_mm1gqbd', text: '2026-11-06' },
      ] }] };
    }),
    stub(docSvc, 'getCaseSummary', async () => { if (docsFail) throw new Error('monday timeout'); return { items }; }),
    stub(composition, 'readForCase', async () => ({ members: [] })),
    stub(htmlQ, 'loadMembers', async () => [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant', submittedAt: '' }]),
    stub(htmlQ, 'getMemberStatuses', async ({ members }) => members.map((m) => ({ ...m, status: 'In Progress', hasData: true, completionPct: 40 }))),
    stub(cockpit, 'getLeadExtras', async () => ({ lead: null, payments: null })),
    stub(S, 'describe', async () => ({ available: false })),
  ];
}

test('getCaseOverview: the reminders card facts come from the SAME Client Master read (group, lock, escalation date, the newest notes) — the Sent line, the stored deadline, no second read', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const claim = docRem.claimNote({ level: 1, to: 'a***@example.com', actor: 'Mahesh Sharma', count: 3, now: T_REM - 4 * 86400e3 });
  const restore = reminderStubs({ updates: [{ id: '77', created_at: new Date(T_REM - 4 * 86400e3).toISOString(), text_body: claim.replace(/<[^>]*>/g, ''), body: claim }] });
  try {
    const o = await cockpit.getCaseOverview('2026-SV-021');
    assert.deepEqual(o.clientDeadlineRaw, { type: 'Deadline', actualDeadline: '2026-12-16', promisedSubmissionDate: '' });
    assert.deepEqual(o.group, { id: 'group_sv', title: 'Super Visa' });
    assert.equal(o.automationLock, 'No');
    assert.equal(o.manualOverride, '');
    assert.equal(o.escalationLastNotified, '2026-11-06');
    assert.equal(o.clientDeadline, 'Real deadline Dec 16, 2026', 'the pill is unchanged');
    assert.deepEqual([o.reminders.available, o.reminders.canSend, o.reminders.reason, o.reminders.missingCount], [true, true, '', 1]);
    assert.deepEqual([o.reminders.sent[1].label, o.reminders.sent[1].by, o.reminders.sent[2], o.reminders.auto], ['3 Nov 2026', 'Mahesh Sharma', null, []]);
    assert.equal(o.reminders.recentNotes, 100, 'the card says its facts come from the newest 100 notes (review 2026-11-07 [2]/[16]/[24])');
    assert.ok(!JSON.stringify(o.reminders).includes('aisha@'), 'the card facts never carry the client address');
  } finally { restore.reverse().forEach((r) => r()); }
  // the 100th note still counts: a claim behind 99 newer notes is on the Sent line
  const old1 = docRem.claimNote({ level: 2, to: 'a***@example.com', actor: 'Deeksha Sharma', count: 2, now: T_REM - 9 * 86400e3 });
  const filler = Array.from({ length: 99 }, (_, i) => ({ id: String(900 - i), created_at: new Date(T_REM - (i + 1) * 3600e3).toISOString(), text_body: 'Upload ' + i, body: '<p>📎 Upload ' + i + '</p>' }));
  const busy = reminderStubs({ updates: [...filler, { id: '70', created_at: new Date(T_REM - 9 * 86400e3).toISOString(), text_body: old1.replace(/<[^>]*>/g, ''), body: old1 }] });
  try {
    const o = await cockpit.getCaseOverview('2026-SV-021');
    assert.deepEqual([o.reminders.sent[2].label, o.reminders.sent[2].by, o.reminders.recentNotes], ['29 Oct 2026', 'Deeksha Sharma', 100]);
  } finally { busy.reverse().forEach((r) => r()); }
  // review [4]: a failed checklist read is named — never "No checklist rows yet" as fact
  const docsDown = reminderStubs({ docsFail: true });
  try {
    const o = await cockpit.getCaseOverview('2026-SV-021');
    assert.deepEqual([o.reminders.available, o.reminders.reason, o.reminders.canSend, o.reminders.message], [false, 'docs-unavailable', false, 'The checklist could not be read just now — reload in a moment.']);
    assert.doesNotMatch(o.reminders.message, /No checklist rows/);
    assert.equal(o.cmUnavailable, false, 'the case read itself was fine');
  } finally { docsDown.reverse().forEach((r) => r()); }
  const locked = reminderStubs({ lock: 'Yes', group: { id: 'group_mm3b9tap', title: 'Cancel / Did not retained' } });
  try {
    const o = await cockpit.getCaseOverview('2026-SV-021');
    assert.deepEqual([o.reminders.available, o.reminders.canSend], [true, false]);
    assert.match(o.reminders.blocked, /not a live case/, 'the group refusal is named first');
  } finally { locked.reverse().forEach((r) => r()); }
  const noRows = reminderStubs({ items: [] });
  try {
    const o = await cockpit.getCaseOverview('2026-SV-021');
    assert.deepEqual([o.reminders.available, o.reminders.reason], [false, 'no-rows']);
  } finally { noRows.reverse().forEach((r) => r()); }
  // plan §3b conditions 2–4 (review 2026-11-07): not Paid, not at Document Collection, Manual Override = Yes → the card shows the line, the buttons are off
  for (const [over, re] of [[{ payment: 'Unpaid' }, /Payment Status is Unpaid, not Paid/], [{ stage: 'Internal Review' }, /at Internal Review, not Document Collection/], [{ override: 'Yes' }, /Manual Override is on/]]) {
    const r = reminderStubs(over);
    try {
      const o = await cockpit.getCaseOverview('2026-SV-021');
      assert.deepEqual([o.reminders.available, o.reminders.canSend], [true, false], JSON.stringify(over));
      assert.match(o.reminders.blocked, re);
      if (over.override) assert.equal(o.manualOverride, 'Yes');
    } finally { r.reverse().forEach((x) => x()); }
  }
});

test('getCaseOverview: a failed Client Master read hides the Reminders card with its reason (no fabricated card) and blanks the gate facts', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const restore = reminderStubs({ cmFail: true });
  try {
    const o = await cockpit.getCaseOverview('2026-SV-021');
    assert.equal(o.cmUnavailable, true);
    assert.deepEqual([o.reminders.available, o.reminders.reason, o.reminders.canSend], [false, 'cm-unavailable', false]);
    assert.match(o.reminders.message, /temporarily unavailable/);
    assert.deepEqual([o.group, o.automationLock, o.manualOverride, o.escalationLastNotified], [{ id: '', title: '' }, '', '', '']);
  } finally { restore.reverse().forEach((r) => r()); }
});

// ── the page: the card in both tabs, the inline-JS rules, the emitted script ──

const PAGE_REF = '2026-SV-021';
function pageJs() {
  const html = require('../src/routes/adminCase').buildCockpitHTML(PAGE_REF);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);   // every emitted script parses
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  return { html, js };
}

test('case page: the Reminders card markup sits under the Document readiness meter (Overview) and above the review card (Documents); render() draws it; phone CSS stacks the buttons and makes the dialog a full-screen sheet', () => {
  const { html, js } = pageJs();
  const ov = html.indexOf('id="panel-overview"'), meters = html.indexOf('id="d-sub"', ov), remOv = html.indexOf('id="rem-ov"'), famCard = html.indexOf('👪 Family on this case');
  assert.ok(ov < meters && meters < remOv && remOv < famCard, 'Overview: meters → Reminders card → the family card');
  const docs = html.indexOf('id="panel-documents"'), remDoc = html.indexOf('id="rem-doc"'), review = html.indexOf('📂 Document review');
  assert.ok(docs < remDoc && remDoc < review, 'Documents tab: the card before the review card');
  assert.equal((html.match(/class="card rem-card"/g) || []).length, 2);
  assert.match(html, /<div class="card rem-card" id="rem-ov" style="display:none"><\/div>/, 'hidden until the server reports the facts');
  assert.match(js, /renderSponsor\(d\.sponsor, d\.cmUnavailable\);\n  \/\/ Document reminders card \(block 2\)[^\n]*\n  renderReminders\(d\.reminders\);/, 'render() draws the card right after the sponsor card');
  assert.match(html, /@media \(max-width: 600px\) \{\n\s+\.rem-btns \.sbtn \{ width:100%; justify-content:center; font-size:16px; min-height:44px; \}/, 'phones: full-width 16px / 44px buttons');
  assert.match(html, /\.tdlg\.rem-dlg \{ max-width:none; width:100%; height:100%; max-height:100vh; max-height:100dvh; border-radius:0; \}/, 'phones: a full-screen sheet');
  assert.match(html, /textarea\.rem-in \{ resize:vertical; min-height:150px;/);
  // the inline-JS rules on the whole reminders block (template-literal traps)
  const a = js.indexOf('// ── Document reminders (block 2'), b = js.indexOf('function loadCase()');
  assert.ok(a > 0 && b > a, 'the block is emitted before loadCase');
  const block = js.slice(a, b);
  assert.ok(!block.includes('`'), 'no backtick inside the reminders block');
  assert.ok(!block.includes('${'), 'no ${ inside the reminders block');
  assert.ok(!block.includes('\\'), 'no backslash inside the reminders block (the lost-backslash trap)');
  for (const fn of ['function renderReminders(', 'function remOpen(', 'function remDialog(', 'function remSend(', 'function remFail(']) assert.ok(block.includes(fn), fn);
  assert.ok(block.includes("'/reminder/preview?level='") && block.includes("'/reminder'"), 'the two routes');
  assert.ok(block.includes("tdotDialogNew({ cls: 'rem-dlg', ovClass: 'rem-ov', group: 'rem'"), 'the shared pop-up');
});

/** The reminders block run in a sandbox: two card slots, a message list, a fake pop-up, scripted fetch answers. */
function remSandbox({ responses = [] } = {}) {
  const { js } = pageJs();
  const helpers = js.slice(js.indexOf('function escHtml('), js.indexOf('function pctColor('));
  const block = js.slice(js.indexOf('// ── Document reminders (block 2'), js.indexOf('function loadCase()'));
  const cardEl = () => { const c = { style: {}, innerHTML: '', querySelectorAll(sel) { const dom = parseHtml('<body>' + c.innerHTML + '</body>'); return dom.body.querySelectorAll(sel); } }; return c; };
  const cards = [cardEl(), cardEl()];
  const msgs = [{ className: '', textContent: '', innerHTML: '' }, { className: '', textContent: '', innerHTML: '' }];
  const fetches = [], queue = responses.slice();
  let loads = 0;
  const dialogs = [];
  const ctx = {
    CASE_REF: PAGE_REF, JSON, encodeURIComponent, String, Number, Array, Boolean,
    location: { pathname: '/admin/case/' + PAGE_REF, search: '' },
    document: { querySelectorAll: (sel) => (sel === '.rem-card' ? cards : sel === '.rem-msg' ? msgs : []) },
    peekKey: () => '', loadCase: () => { loads++; },
    tdotDialogNew(opts) {
      const els = {};
      const el = (id) => els[id] || (els[id] = { id, value: '', min: '', textContent: '', onclick: null, focus() { this.focused = true; } });
      const c = { opts, openId: 1, closed: [], busy: [], box: { innerHTML: '', querySelector: (sel) => el(sel.slice(1)) },
        tryClose(how) { c.close(true, how); }, close(force, how) { c.closed.push(how); if (opts.onClosed) opts.onClosed(how); },
        setBusy(on) { c.busy.push(on); }, still(id) { return id === c.openId && !c.closed.length; }, els };
      dialogs.push(c); return c;
    },
    fetch: (url, opts) => {
      fetches.push([url, (opts && opts.method) || 'GET', opts && opts.body ? JSON.parse(opts.body) : null]);
      const next = queue.shift();
      if (!next) return Promise.reject(new Error('no scripted answer'));
      if (next === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: next.status < 300, status: next.status, json: () => Promise.resolve(next.body) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(helpers + '\n' + block, ctx);
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  return { ctx, cards, msgs, fetches, dialogs, loads: () => loads, flush, buttons: (i = 0) => cards[i].querySelectorAll('[data-rem-level]') };
}
const FACTS = (over = {}) => ({ available: true, reason: '', message: '', canSend: true, blocked: '', recentNotes: 100, missingCount: 4, sent: { 1: { day: '2026-11-03', label: '3 Nov 2026', by: 'Mahesh Sharma', at: '', lastDay: '' }, 2: null, 3: null }, auto: [{ day: '2026-11-06', label: '6 Nov 2026' }], autoLast: { day: '2026-11-06', label: '6 Nov 2026' }, autoCount: 1, failures: [], lastFailed: false, ...over });
const PREVIEW = (over = {}) => ({ ok: true, level: 1, to: 'a***@example.com', subject: 'Documents still needed — 2026-SV-021', body: 'Dear Aisha Khan,\n\n{MissingList}\n\n{PortalLink}', tokensLeft: ['{MissingList}', '{PortalLink}'],
  missing: { groups: [{ member: 'Principal Applicant', categories: [{ category: 'Identity', items: [{ name: 'Passport <all pages>', instruction: 'Colour scan & all pages.' }] }] }], count: 1 }, missingList: '  - Passport', missingCount: 1,
  deadlineLine: 'Deadline 16 Dec 2026', lastDay: '', minLastDay: '2026-11-07', warnings: ['Reminder 1 already went on 3 Nov 2026 (Mahesh Sharma)'], template: { name: 'Reminder 1', source: 'default' }, history: {}, ...over });

test('case page (sandbox): renderReminders draws the three buttons and the Sent line into BOTH slots, disables them when blocked, hides with the reason, and never redraws over an open dialog', async () => {
  const s = remSandbox();
  s.ctx.renderReminders(FACTS());
  for (const i of [0, 1]) {
    assert.equal(s.cards[i].style.display, 'block');
    const btns = s.buttons(i);
    assert.deepEqual(btns.map((b) => [b.getAttribute('data-rem-level'), b.textContent.trim(), b.hasAttribute('disabled')]), [['1', 'Send reminder 1 · friendly', false], ['2', 'Send reminder 2 · firm', false], ['3', 'Send final reminder', false]]);
    assert.match(s.cards[i].innerHTML, /Sent \(recent notes\): 1st 3 Nov 2026 \(Mahesh Sharma\) · 2nd — · Final — · Auto: last 6 Nov 2026 \(1 so far\)</);
    assert.match(s.cards[i].innerHTML, /never questionnaire items/);
    assert.match(s.cards[i].innerHTML, /the Sent line reads the newest 100 notes, so an older send may be further down the notes\.<\/div>/, 'the card says where its facts come from (review [2]/[16]/[24])');
    assert.match(s.cards[i].innerHTML, /<div class="act-msg rem-msg"><\/div>$/, 'the message slot is part of the card');
  }
  s.ctx.renderReminders(FACTS({ canSend: false, blocked: 'Automation Lock is on for this case — reminders are off until it is cleared in Monday.' }));
  assert.ok(s.buttons(0).every((b) => b.hasAttribute('disabled')));
  assert.match(s.cards[0].innerHTML, /<div class="rem-blocked">Automation Lock is on/);
  // plan §3b conditions 2–4 (review 2026-11-07 [1]/[5]/[11]): the same line and off buttons for Manual Override, the stage and Paid
  for (const blocked of ['Manual Override is on for this case — reminders are off until it is cleared in Monday.', 'This case is at Internal Review, not Document Collection — reminders are for cases collecting documents.', 'Payment Status is Unpaid, not Paid — no reminder until the case is paid.']) {
    s.ctx.renderReminders(FACTS({ canSend: false, blocked }));
    assert.ok(s.buttons(0).every((b) => b.hasAttribute('disabled')), blocked);
    assert.ok(s.cards[1].innerHTML.includes('<div class="rem-blocked">' + blocked + '</div>'), blocked);
  }
  // the automatic days: the newest + the count, never the whole list (review [29]); none = "—"; 0 recentNotes = the plain "Sent:" label
  s.ctx.renderReminders(FACTS({ auto: [], autoLast: { day: '2026-11-20', label: '20 Nov 2026' }, autoCount: 14, recentNotes: 0 }));
  assert.match(s.cards[0].innerHTML, /<div class="rem-sent">Sent: 1st 3 Nov 2026 \(Mahesh Sharma\) · 2nd — · Final — · Auto: last 20 Nov 2026 \(14 so far\)<\/div>/);
  assert.doesNotMatch(s.cards[0].innerHTML, /recent notes|newest 100/);
  s.ctx.renderReminders(FACTS({ sent: { 1: null, 2: null, 3: { day: '2026-11-07', label: '7 Nov 2026', by: 'Deeksha Sharma', at: '', lastDay: '14 Nov 2026' } }, auto: [], autoLast: null, autoCount: 0, lastFailed: true, failures: [{ day: '2026-11-07', label: '7 Nov 2026', reason: 'x', at: '' }] }));
  assert.match(s.cards[1].innerHTML, /Sent \(recent notes\): 1st — · 2nd — · Final 7 Nov 2026 \(Deeksha Sharma\), last day 14 Nov 2026 · Auto: —/);
  assert.match(s.cards[1].innerHTML, /<div class="rem-fail">Last attempt did not go out \(7 Nov 2026\)/);
  s.ctx.renderReminders({ available: false, reason: 'no-token', message: 'No access code on the case <x>', canSend: false });
  assert.equal(s.buttons(0).length, 0);
  assert.match(s.cards[0].innerHTML, /<div class="muted">No access code on the case &lt;x&gt;<\/div>/, 'the reason, escaped, no buttons');
  s.ctx.renderReminders(null);
  assert.equal(s.cards[0].style.display, 'none');
  // an open dialog: a reload keeps the card as it is; the facts are kept and drawn when it closes
  s.ctx.renderReminders(FACTS());
  const before = s.cards[0].innerHTML;
  s.ctx.REM_OPEN = true;
  s.ctx.renderReminders(FACTS({ sent: { 1: null, 2: null, 3: null }, auto: [], autoLast: null, autoCount: 0 }));
  assert.equal(s.cards[0].innerHTML, before, 'no redraw under the dialog');
  s.ctx.REM_OPEN = false;
  s.ctx.renderReminders(s.ctx.REM_LAST);
  assert.match(s.cards[0].innerHTML, /Sent \(recent notes\): 1st — · 2nd — · Final — · Auto: —/);
});

test('case page (sandbox): a click previews first (GET), the dialog carries To / subject / text / extra line / the read-only list / amber warnings, the final adds the last-day box; a 401 preview shows the sign-in link', async () => {
  const s = remSandbox({ responses: [{ status: 200, body: PREVIEW() }, { status: 200, body: PREVIEW({ level: 3, lastDay: '2026-11-14', warnings: [] }) }, { status: 401, body: { ok: false, error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' } }] });   // the real server shape (server.js resolveCaseForWrite): its returnTo points at the dashboard
  s.ctx.renderReminders(FACTS());
  // the real page binds onclick on the card's buttons (parsed nodes here are copies) — call remOpen as the binding does
  s.ctx.remOpen(1); await s.flush();
  assert.equal(s.fetches[0][0], '/admin/case-action/2026-SV-021/reminder/preview?level=1');
  assert.equal(s.fetches[0][1], 'GET');
  const d = s.dialogs[0];
  assert.equal(s.ctx.REM_OPEN, true);
  const dom = parseHtml('<body>' + d.box.innerHTML + '</body>').body;
  assert.equal(dom.querySelector('h3').textContent, 'Send reminder 1 · friendly');
  assert.match(d.box.innerHTML, /<span class="k">To<\/span>a\*\*\*@example\.com <span class="muted">· Deadline 16 Dec 2026<\/span>/);
  assert.match(d.box.innerHTML, /<div class="rem-warn">⚠ Reminder 1 already went on 3 Nov 2026 \(Mahesh Sharma\)<\/div>/);
  assert.match(d.box.innerHTML, /<textarea class="rem-in" id="rem-body" rows="8" maxlength="6000">/);
  assert.match(d.box.innerHTML, /the missing list goes where \{MissingList\} is, the portal link where \{PortalLink\} is<\/span>/);
  assert.match(d.box.innerHTML, /<li>Passport &lt;all pages&gt; <span class="muted">— Colour scan &amp; all pages\.<\/span><\/li>/, 'the list is read-only, escaped');
  assert.doesNotMatch(d.box.innerHTML, /rem-lastday/, 'no last-day box on reminder 1');
  assert.equal(d.els['rem-subject'].value, 'Documents still needed — 2026-SV-021');
  assert.equal(d.els['rem-body'].value, 'Dear Aisha Khan,\n\n{MissingList}\n\n{PortalLink}');
  assert.equal(d.els['rem-subject'].focused, true);
  assert.ok(d.els['rem-send'].onclick && d.els['rem-cancel'].onclick);
  d.els['rem-cancel'].onclick();
  assert.deepEqual(d.closed, ['cancel']);
  assert.equal(s.ctx.REM_OPEN, false, 'closing frees the card');
  s.ctx.remOpen(3); await s.flush();
  const f = s.dialogs[1];
  assert.match(f.box.innerHTML, /<h3>Send the final reminder<\/h3>/);
  assert.match(f.box.innerHTML, /<input class="rem-in" type="date" id="rem-lastday">/);
  assert.match(f.box.innerHTML, /the date below where \{LastDay\} is/);
  assert.deepEqual([f.els['rem-lastday'].value, f.els['rem-lastday'].min], ['2026-11-14', '2026-11-07']);
  f.els['rem-cancel'].onclick();
  s.ctx.remOpen(2); await s.flush();
  assert.equal(s.dialogs.length, 2, 'a 401 opens no dialog');
  assert.match(s.msgs[0].innerHTML, /Sign in required <a href="\/q\/auth\/monday\?returnTo=%2Fadmin%2Fcase%2F2026-SV-021">Sign in with Monday<\/a>/, 'the sign-in comes back to THIS case, not the dashboard the server named (review 2026-11-07 [26])');
  assert.equal(s.msgs[1].className, 'act-msg rem-msg err');
  // the same rule on the document-action handler earlier in the page (the pre-existing sibling)
  const { js: pageSrc } = pageJs();
  assert.equal((pageSrc.match(/\.split\('\?'\)\[0\] \+ '\?returnTo=' \+ encodeURIComponent\(location\.pathname \+ location\.search\)/g) || []).length, 2, 'both 401 handlers replace the server\'s returnTo with this page');
});

test('case page (sandbox): Send posts the edited text (level, subject, body, extra, lastDay), goes busy, closes on success and reloads; a 502 stays open with the server\'s neutral words; a lost race closes and reloads; an empty box never posts', async () => {
  const s = remSandbox({ responses: [
    { status: 200, body: PREVIEW({ level: 3, lastDay: '2026-11-14' }) },
    { status: 200, body: { ok: true, noted: true, to: 'a***@example.com', level: 3, day: '2026-11-07' } },
    { status: 200, body: PREVIEW() },
    { status: 502, body: { ok: false, reason: 'send-failed', error: 'The email could not be sent — please try again in a moment.' } },
    { status: 200, body: PREVIEW() },
    { status: 409, body: { ok: false, reason: 'lost-race', error: 'A document reminder is going to this client right now (someone else, or the automatic run) — nothing was sent twice. Reload the page in a moment.' } },
    { status: 200, body: PREVIEW() },
    { status: 409, body: { ok: false, reason: 'max-tries', error: 'This reminder did not go out 3 times today — the email system is having a temporary problem. Please try again tomorrow, or email the client by hand.' } },
  ] });
  s.ctx.renderReminders(FACTS());
  s.ctx.remOpen(3); await s.flush();
  const d = s.dialogs[0];
  d.els['rem-lastday'].value = '';
  d.els['rem-send'].onclick(); await s.flush();
  assert.equal(d.els['rem-err'].textContent, 'Enter the last day you will wait for the documents.');
  assert.equal(s.fetches.length, 1, 'nothing posted');
  d.els['rem-lastday'].value = '2026-11-21'; d.els['rem-subject'].value = 'Final — 2026-SV-021'; d.els['rem-body'].value = 'Last call.\n{MissingList}'; d.els['rem-extra'].value = 'We still need the lease.';
  d.els['rem-send'].onclick(); await s.flush();
  assert.deepEqual(s.fetches[1], ['/admin/case-action/2026-SV-021/reminder', 'POST', { level: 3, subject: 'Final — 2026-SV-021', body: 'Last call.\n{MissingList}', extra: 'We still need the lease.', lastDay: '2026-11-21' }]);
  assert.deepEqual(d.busy, [true, false]);
  assert.deepEqual(d.closed, ['sent']);
  assert.equal(s.loads(), 1, 'the case reloads: the Sent line comes from the notes');
  assert.deepEqual([s.msgs[0].className, s.msgs[0].textContent], ['act-msg rem-msg ok', 'Sent to a***@example.com — noted on the case.']);
  assert.equal(s.ctx.REM_OPEN, false);
  // a failed send: the dialog stays open with the neutral wording (the text is not lost)
  s.ctx.remOpen(1); await s.flush();
  const e = s.dialogs[1];
  e.els['rem-send'].onclick(); await s.flush();
  assert.equal(e.els['rem-err'].textContent, 'The email could not be sent — please try again in a moment.');
  assert.deepEqual(e.closed, [], 'still open');
  assert.equal(s.loads(), 1, 'no reload under the open dialog');
  assert.equal(s.ctx.REM_STALE, true, 'the server noted the failed attempt on the case');
  // review 2026-11-07 [32]: Cancel after the failure reads the case again (the "did not go out" line comes from the notes), never the facts from before the send
  const beforeCancel = s.cards[0].innerHTML;
  e.els['rem-cancel'].onclick();
  assert.deepEqual(e.closed, ['cancel']);
  assert.equal(s.loads(), 2, 'closing the failed dialog reloads the case');
  assert.equal(s.ctx.REM_STALE, false);
  assert.equal(s.cards[0].innerHTML, beforeCancel, 'no redraw from the stale facts — the reload draws the card');
  s.ctx.remOpen(1); await s.flush();
  const g = s.dialogs[2];
  g.els['rem-send'].onclick(); await s.flush();   // the lost race
  assert.deepEqual(g.closed, ['refused']);
  assert.equal(s.loads(), 3, 'one reload, not two');
  assert.match(s.msgs[1].textContent, /nothing was sent twice/);
  // the day's tries used up (409 max-tries): the dialog stays open with the words, Cancel reloads
  s.ctx.remOpen(1); await s.flush();
  const h = s.dialogs[3];
  h.els['rem-send'].onclick(); await s.flush();
  assert.match(h.els['rem-err'].textContent, /did not go out 3 times today/);
  assert.deepEqual([h.closed, s.loads(), s.ctx.REM_STALE], [[], 3, true]);
  h.els['rem-cancel'].onclick();
  assert.equal(s.loads(), 4);
});
