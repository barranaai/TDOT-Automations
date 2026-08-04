'use strict';

// Direct retainer clients (walk-in / referral — enter at the retainer stage,
// no booking or consultation): creation wiring, honest labeling, and KPI split.

const test   = require('node:test');
const assert = require('node:assert/strict');

const portal        = require('../src/services/consultantPortalService');
const retainer2     = require('../src/services/retainerService2');
const kpi           = require('../src/services/kpiService');
const leadService   = require('../src/services/leadService');
const mondayApi     = require('../src/services/mondayApi');
const microsoftMail = require('../src/services/microsoftMailService');
const documenso     = require('../src/services/documensoService');
const registry      = require('../src/services/caseTypeRegistryService');

const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// A case type WITHOUT sub-type variants — the happy path needs no sub-type
// (variant-carrying types now REQUIRE one; covered by its own test below).
const CASE_TYPE = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
const CONSULTANT = 'Shermin Teymouri Mofrad';

// Registry unreachable in tests → the label source falls back to the static config.
const stubRegistryDown = () => stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); });

// ─── createDirectClient ───────────────────────────────────────────────────────

test('createDirectClient: creates a fully-wired lead (tag, case type, consultant, status)', async () => {
  let createArgs = null; const updates = [];
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async (f) => { createArgs = f; return { id: '900', ...f }; }),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(mondayApi, 'query', async () => ({})), // portal note
  ];
  try {
    const r = await portal.createDirectClient({
      fullName: 'Walkin Client', email: 'walkin@example.com', phone: '+14165550100', residentialAddress: '1 Main St',
      caseType: CASE_TYPE, consultant: CONSULTANT, referredBy: 'Existing client X',
    });
    assert.equal(r.ok, true);
    assert.equal(r.leadId, '900');
    assert.equal(createArgs.fullName, 'Walkin Client');
    assert.equal(createArgs.email, 'walkin@example.com');
    const wired = updates.find((u) => u.id === '900' && u.f.sourceChannel);
    assert.ok(wired, 'the wiring update ran');
    assert.equal(wired.f.sourceChannel, 'Direct Retainer', 'tagged as direct (KPI/UI honesty)');
    assert.equal(wired.f.confirmedCaseType, CASE_TYPE, 'confirmed case type → handoff auto-resolves, checklist seeds');
    assert.equal(wired.f.assignedConsultant, CONSULTANT, 'pinned consultant → agreement signatory + Retained-by');
    assert.equal(wired.f.conversionStatus, 'Qualified', 'honest status — never "Booked"/"Consulted"');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: rejects bad input before creating anything', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async () => { created = true; return { id: 'x' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  const ADDR = '1 Main St';
  const PHONE = '4165550100';
  const cases = [
    { fullName: '', email: 'a@b.co', phone: PHONE, residentialAddress: ADDR, caseType: CASE_TYPE, consultant: CONSULTANT },
    { fullName: 'A B', email: 'not-an-email', phone: PHONE, residentialAddress: ADDR, caseType: CASE_TYPE, consultant: CONSULTANT },
    { fullName: 'A B', email: 'a@b.co', phone: PHONE, residentialAddress: ADDR, caseType: 'Made Up Case Type', consultant: CONSULTANT },
    { fullName: 'A B', email: 'a@b.co', phone: PHONE, residentialAddress: ADDR, caseType: CASE_TYPE, consultant: 'Unknown Person' },
    // Address is compulsory (user directive 2026-08-04) — it prints on the agreement.
    { fullName: 'A B', email: 'a@b.co', phone: PHONE, residentialAddress: '', caseType: CASE_TYPE, consultant: CONSULTANT },
    // Phone is compulsory too (user directive 2026-08-04) — it lands on the case
    // record; validated by the SAME rule as the Client Master write (≥7 digits).
    { fullName: 'A B', email: 'a@b.co', phone: '', residentialAddress: ADDR, caseType: CASE_TYPE, consultant: CONSULTANT },
    { fullName: 'A B', email: 'a@b.co', phone: '12345', residentialAddress: ADDR, caseType: CASE_TYPE, consultant: CONSULTANT },
  ];
  try {
    for (const c of cases) {
      await assert.rejects(() => portal.createDirectClient(c), (e) => e.badRequest === true, JSON.stringify(c));
    }
    // sub-type from a DIFFERENT case type is rejected too (when the chosen type has sub-types)
    const withSubs = CASE_TYPE_LABELS.find((ct) => (SUB_TYPES_BY_CASE[ct] || []).length);
    const foreignSub = CASE_TYPE_LABELS.map((ct) => (SUB_TYPES_BY_CASE[ct] || [])[0])
      .find((s) => s && !(SUB_TYPES_BY_CASE[withSubs] || []).includes(s));
    if (withSubs && foreignSub) {
      await assert.rejects(
        () => portal.createDirectClient({ fullName: 'A B', email: 'a@b.co', residentialAddress: '1 Main St', phone: '4165550100', caseType: withSubs, caseSubType: foreignSub, consultant: CONSULTANT }),
        (e) => e.badRequest === true);
    }
    // a sub-type supplied for a case type that HAS NO sub-types is also rejected
    const noSubs = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
    if (noSubs) {
      await assert.rejects(
        () => portal.createDirectClient({ fullName: 'A B', email: 'a@b.co', residentialAddress: '1 Main St', phone: '4165550100', caseType: noSubs, caseSubType: 'Anything At All', consultant: CONSULTANT }),
        (e) => e.badRequest === true, 'foreign sub-type on a no-sub-type case type must be rejected');
    }
    assert.equal(created, false, 'no lead created on any invalid input');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: duplicate guard — an existing un-retained direct lead with the same email is REUSED', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async (key, val) => (
      key === 'email' && val === 'walkin@example.com'
        ? [{ id: '777', fullName: 'Walkin Client', sourceChannel: 'Direct Retainer', retainerSent: '' }] : [])),
    stub(leadService, 'createLead', async () => { created = true; return { id: 'x' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Walkin Client', email: 'walkin@example.com', residentialAddress: '1 Main St', phone: '4165550100', caseType: CASE_TYPE, consultant: CONSULTANT });
    assert.equal(r.reused, true);
    assert.equal(r.leadId, '777');
    assert.equal(created, false, 'no duplicate lead minted');
  } finally { restore.forEach((x) => x()); }
});

// Live-found regression (2026-07-23): the guard used a FIRST-HIT-ONLY lookup, so
// an older non-direct lead sharing the email hid the reusable one and every
// re-submit minted a duplicate. The guard must scan ALL matches.
test('createDirectClient: guard still reuses when an OLDER non-direct lead shares the email', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => ([
      { id: '100', fullName: 'Walkin Client', sourceChannel: 'Website', retainerSent: '' },        // older enquiry — first hit
      { id: '778', fullName: 'Walkin Client', sourceChannel: 'Direct Retainer', retainerSent: '' }, // the reusable one
    ])),
    stub(leadService, 'createLead', async () => { created = true; return { id: 'x' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Walkin Client', email: 'walkin@example.com', residentialAddress: '1 Main St', phone: '4165550100', caseType: CASE_TYPE, consultant: CONSULTANT });
    assert.equal(r.reused, true, 'must find the direct lead behind the older non-direct one');
    assert.equal(r.leadId, '778');
    assert.equal(created, false, 'no duplicate minted');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: a direct lead whose retainer ALREADY went out is not reused — and (since warn-and-link) the new matter needs an explicit choice', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => ([
      { id: '779', sourceChannel: 'Direct Retainer', retainerSent: '2026-07-01' },
    ])),
    stub(leadService, 'createLead', async () => { created = true; return { id: '780' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    // Without a choice: the match surfaces as a conflict (no silent duplicate).
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Walkin Client', email: 'walkin@example.com', residentialAddress: '1 Main St', phone: '4165550100', caseType: CASE_TYPE, consultant: CONSULTANT }),
      (e) => e.conflict === true);
    assert.equal(created, false);
    // With the explicit choice: a fresh lead — the sent-retainer one is never reused.
    const r = await portal.createDirectClient({ fullName: 'Walkin Client', email: 'walkin@example.com', residentialAddress: '1 Main St', phone: '4165550100', caseType: CASE_TYPE, consultant: CONSULTANT, allowDuplicate: true });
    assert.ok(!r.reused, 'a retained/sent client starts a fresh lead');
    assert.equal(created, true);
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: wiring failure NEVER strands staff — retries once, then returns the lead with a warning', async () => {
  let createCalls = 0, updateCalls = 0;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async () => { createCalls++; return { id: '901' }; }),
    stub(leadService, 'updateLead', async () => { updateCalls++; throw new Error('monday 500'); }),
    stub(mondayApi, 'query', async () => ({})), // failure note (best-effort)
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Walkin Client', email: 'w2@example.com', residentialAddress: '1 Main St', phone: '4165550100', caseType: CASE_TYPE, consultant: CONSULTANT });
    assert.equal(r.ok, true, 'no throw — throwing would tell staff to re-create (duplicate)');
    assert.equal(r.leadId, '901', 'staff lands on the created lead');
    assert.ok(r.warning, 'the manual-fix warning is surfaced');
    assert.equal(createCalls, 1, 'created exactly once');
    assert.equal(updateCalls, 2, 'the wiring write was retried once');
  } finally { restore.forEach((x) => x()); }
});

test('getDirectClientOptions: serves the form its case types and consultants (config fallback)', async () => {
  const restore = stubRegistryDown();
  try {
    const o = await portal.getDirectClientOptions();
    assert.ok(o.caseTypes.length >= 10, 'canonical case-type list');
    assert.ok(o.consultants.includes(CONSULTANT));
    assert.ok(o.subTypesByCase && typeof o.subTypesByCase === 'object');
  } finally { restore(); }
});

test('getDirectClientOptions: prefers the LIVE Client Master canon when the registry is reachable', async () => {
  const restore = stub(registry, 'getCaseTypes', async () => ['Live Type A', 'Live Type B']);
  try {
    const o = await portal.getDirectClientOptions();
    assert.deepEqual(o.caseTypes, ['Live Type A', 'Live Type B'], 'live labels win — no drift vs handoff validation');
  } finally { restore(); }
});

// ─── the "Consulted" stamp is skipped for direct clients ──────────────────────

function retainLead(extra = {}) {
  return {
    id: extra.id, fullName: 'Walkin Client', email: 'walkin@example.com', outcome: 'Retain',
    retainerFee: 2500, retainerSent: '', retainerSigned: '', retainerPaid: '', conversionStatus: 'Qualified',
    leadToken: 'tok', bookedSlot: '', consultationHeld: '', bookingStatus: 'Not Yet', ...extra,
  };
}

test('retainer send: a DIRECT lead (never booked/consulted) is NOT stamped "Consulted"', async () => {
  const updates = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => retainLead({ id })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push(f); }),
    stub(documenso, 'isEnabled', () => false), // legacy email path
    stub(microsoftMail, 'sendEmail', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await retainer2.maybeSendRetainerAgreement('911');
    assert.equal(r.status, 'sent');
    const sentWrite = updates.find((f) => f.retainerSent);
    assert.ok(sentWrite, 'retainerSent stamped');
    assert.ok(!('conversionStatus' in sentWrite), 'no false "Consulted" for a walk-in');
  } finally { restore.forEach((x) => x()); }
});

test('retainer send: a BOOKED lead still gets "Consulted" (unchanged behavior)', async () => {
  const updates = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => retainLead({ id, bookedSlot: '2026-07-01 10:00', bookingStatus: 'Booked' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push(f); }),
    stub(documenso, 'isEnabled', () => false),
    stub(microsoftMail, 'sendEmail', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await retainer2.maybeSendRetainerAgreement('912');
    assert.equal(r.status, 'sent');
    const sentWrite = updates.find((f) => f.retainerSent);
    assert.equal(sentWrite.conversionStatus, 'Consulted');
  } finally { restore.forEach((x) => x()); }
});

// ─── KPI funnel: direct retentions counted separately ─────────────────────────

test('computeKpis: TAGGED direct retentions do not inflate booked→retained conversion', () => {
  const leads = [
    // booked + consulted + retained (normal funnel)
    { createdAt: '2026-07-01', bookedSlot: '2026-07-02 10:00', consultationHeld: '2026-07-02', retainerSigned: '2026-07-03', retainerPaid: '2026-07-04', retainerFee: 2000, assignedConsultant: 'A' },
    // walk-in: explicitly TAGGED direct — retained + paid, never booked/consulted
    { createdAt: '2026-07-05', sourceChannel: 'Direct Retainer', bookedSlot: '', consultationHeld: '', retainerSigned: '2026-07-06', retainerPaid: '2026-07-07', retainerFee: 3000, assignedConsultant: 'B' },
  ];
  const K = kpi.computeKpis(leads, '2026-07');
  assert.equal(K.funnel.leads, 1, 'direct clients never enter the booking funnel (bookedFromLeads honest)');
  assert.equal(K.funnel.booked, 1);
  assert.equal(K.funnel.retained, 1, 'only the booked lead counts in the funnel');
  assert.equal(K.funnel.retainedDirect, 1, 'the tagged walk-in counts as a DIRECT retention');
  assert.equal(K.funnel.rates.retainedFromBooked, 100, '1/1 — not 200%');
  assert.equal(K.funnel.paid, 2);
  assert.equal(K.funnel.rates.paidFromRetained, 100, '2 paid over (1 funnel + 1 direct) retentions');
  assert.equal(K.retainers.signed, 2, 'total signed still counts both');
});

test('computeKpis: an UNTAGGED historical lead with missing booking data is NOT reclassified as direct', () => {
  // e.g. a pre-automation retained lead whose bookedSlot/consultationHeld were never stamped
  const leads = [
    { createdAt: '2026-03-01', bookedSlot: '', consultationHeld: '', retainerSigned: '2026-03-10', retainerPaid: '2026-03-12', retainerFee: 4000 },
  ];
  const K = kpi.computeKpis(leads, '2026-03');
  assert.equal(K.funnel.retained, 1, 'stays in the normal funnel — history unchanged');
  assert.equal(K.funnel.retainedDirect, 0, 'no phantom "Direct" step for pre-feature months');
  assert.equal(K.funnel.leads, 1, 'still counted as a lead');
});

// ─── Warn-and-link (client accounts Phase 1, 2026-08-04) ─────────────────────

const clientMaster   = require('../src/services/clientMasterService');
const clientAccounts = require('../src/services/clientAccountService');
const handoff2       = require('../src/services/handoffService');

test('createDirectClient: existing NON-direct lead with this email → 409-style conflict carrying the matches', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async (key) => (key === 'email'
      ? [{ id: '300', fullName: 'Same Person', email: 'dup@x.co', sourceChannel: 'Website', conversionStatus: '', clientMasterItemId: '', retainerSent: '' }] : [])),
    stub(clientMaster, 'findCasesByEmail', async () => []),
    stub(clientMaster, 'findCasesByPhone', async () => []),
    stub(clientAccounts, 'findMatches', async () => []),
    stub(leadService, 'createLead', async () => { created = true; return { id: 'x' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Same Person', email: 'dup@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT }),
      (e) => e.conflict === true && e.matches && e.matches.leads.length === 1 && e.matches.leads[0].id === '300');
    assert.equal(created, false, 'no lead minted while the choice is unmade');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: allowDuplicate=true skips the conflict and creates', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => [{ id: '300', fullName: 'Same Person', sourceChannel: 'Website', retainerSent: '' }]),
    stub(clientMaster, 'findCasesByEmail', async () => []),
    stub(clientMaster, 'findCasesByPhone', async () => []),
    stub(clientAccounts, 'findMatches', async () => []),
    stub(leadService, 'createLead', async () => { created = true; return { id: '901' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(handoff2, 'openCaseEarly', async () => 'CM-901'),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Different Person', email: 'dup@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, allowDuplicate: true });
    assert.equal(r.ok, true);
    assert.equal(created, true);
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: linkLeadId converts the existing lead (one person, one record)', async () => {
  const updates = [];
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'getLead', async () => ({ id: '300', fullName: 'Same Person', sourceChannel: 'Website', clientMasterItemId: '', conversionStatus: '', retainerSent: '' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
    stub(handoff2, 'openCaseEarly', async () => 'CM-300'),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Same Person', email: 'dup@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, linkLeadId: '300' });
    assert.equal(r.linked, true);
    assert.equal(r.leadId, '300');
    const w = updates.find((u) => u.id === '300');
    assert.equal(w.f.sourceChannel, 'Direct Retainer');
    assert.equal(w.f.confirmedCaseType, CASE_TYPE);
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: linkLeadId is refused when the lead already has a case', async () => {
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'getLead', async () => ({ id: '301', fullName: 'Cased', clientMasterItemId: '900', retainerSent: '' })),
    stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Cased', email: 'c@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, linkLeadId: '301' }),
      (e) => e.badRequest === true && /already has an open case/.test(e.message));
  } finally { restore.forEach((x) => x()); }
});

test('findClientMatches: merges lead/case/account sources, dedupes, and survives one source failing', async () => {
  const restore = [
    stub(leadService, 'findAllByColumnValue', async (key) => (key === 'email'
      ? [{ id: '1', fullName: 'A', sourceChannel: 'Website', clientMasterItemId: '', retainerSent: '' }]
      : [{ id: '1', fullName: 'A', sourceChannel: 'Website', clientMasterItemId: '', retainerSent: '' },
         { id: '2', fullName: 'B', sourceChannel: 'Direct Retainer', clientMasterItemId: '77', retainerSent: '2026-01-01' }])),
    stub(clientMaster, 'findCasesByEmail', async () => { throw new Error('monday down'); }),
    stub(clientMaster, 'findCasesByPhone', async () => [{ id: '77', name: 'B', caseRef: '2026-VV-001', caseStage: 'Retained', paymentStatus: 'Paid' }]),
    stub(clientAccounts, 'findMatches', async () => [{ id: '5', name: 'A', email: 'a@x.co', confidence: 'exact', reasons: ['same email', 'same name'] }]),
  ];
  try {
    const m = await portal.findClientMatches({ email: 'a@x.co', phone: '4165550100' });
    assert.equal(m.leads.length, 2, 'lead 1 deduped across email+phone hits');
    assert.equal(m.leads.find((l) => l.id === '2').hasCase, true);
    assert.equal(m.cases.length, 1, 'phone-side case still found though the email lookup failed');
    assert.equal(m.clients.length, 1);
  } finally { restore.forEach((x) => x()); }
});

// ─── Review-earned rails on warn-and-link (2026-08-04) ───────────────────────

test('linkLeadId: a BOOKED lead is refused — converting it would corrupt the KPI funnel', async () => {
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'getLead', async () => ({ id: '310', fullName: 'Booked Person', email: 'b@x.co', sourceChannel: 'Website', bookingStatus: 'Booked', bookedSlot: '2026-08-10 10:00', clientMasterItemId: '', retainerSent: '' })),
    stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
    stub(leadService, 'updateLead', async () => { throw new Error('must not write'); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Booked Person', email: 'b@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, linkLeadId: '310' }),
      (e) => e.badRequest === true && /consultation booked/.test(e.message));
  } finally { restore.forEach((x) => x()); }
});

test('linkLeadId: a lead with a retainer plan in progress is refused', async () => {
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'getLead', async () => ({ id: '311', fullName: 'Planned Person', email: 'p@x.co', retainerMilestones: '[{"pct":100}]', clientMasterItemId: '', retainerSent: '' })),
    stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
    stub(leadService, 'updateLead', async () => { throw new Error('must not write'); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Planned Person', email: 'p@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, linkLeadId: '311' }),
      (e) => e.badRequest === true && /retainer plan in progress/.test(e.message));
  } finally { restore.forEach((x) => x()); }
});

test('linkLeadId: a lead matching NOTHING typed (stale panel / mispick) is refused', async () => {
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'getLead', async () => ({ id: '312', fullName: 'Someone Else', email: 'other@y.co', phone: '9055559999', clientMasterItemId: '', retainerSent: '' })),
    stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
    stub(leadService, 'updateLead', async () => { throw new Error('must not write'); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Typed Person', email: 'typed@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, linkLeadId: '312' }),
      (e) => e.badRequest === true && /does not match the name, email or phone/.test(e.message));
  } finally { restore.forEach((x) => x()); }
});

test('linkLeadId: the TYPED identity is written onto the linked lead (retainer must use the current email)', async () => {
  const updates = [];
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'getLead', async () => ({ id: '313', fullName: 'Same Person', email: 'old-dead@x.co', phone: '4165550100', sourceChannel: 'Website', clientMasterItemId: '', retainerSent: '' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(handoff2, 'openCaseEarly', async () => 'CM-313'),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Same Person', email: 'new-current@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, linkLeadId: '313' });
    assert.equal(r.linked, true);
    const w = updates.find((u) => u.id === '313');
    assert.equal(w.f.email, 'new-current@x.co', 'typed email replaces the stale one');
    assert.equal(w.f.fullName, 'Same Person');
    assert.equal(w.f.phone, '4165550100');
  } finally { restore.forEach((x) => x()); }
});

test('allowDuplicate: an explicit "create new" is NEVER redirected onto a same-email spouse\'s direct lead', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => ([
      // The SPOUSE's direct lead — same family email, different person.
      { id: '790', fullName: 'John Doe', sourceChannel: 'Direct Retainer', retainerSent: '' },
    ])),
    stub(leadService, 'createLead', async () => { created = true; return { id: '791' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(handoff2, 'openCaseEarly', async () => 'CM-791'),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Jane Doe', email: 'family@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT, allowDuplicate: true });
    assert.equal(created, true, 'a NEW lead for Jane — never John\'s record');
    assert.ok(!r.reused);
  } finally { restore.forEach((x) => x()); }
});

test('direct-reuse guard requires the SAME NAME — a spouse double-submit cannot land on the other spouse', async () => {
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findAllByColumnValue', async () => ([
      { id: '790', fullName: 'John Doe', sourceChannel: 'Direct Retainer', retainerSent: '' },
    ])),
    stub(clientMaster, 'findCasesByEmail', async () => []),
    stub(clientMaster, 'findCasesByPhone', async () => []),
    stub(clientAccounts, 'findMatches', async () => []),
    stub(leadService, 'createLead', async () => ({ id: 'x' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    // Jane (different name) hits the conflict guard instead of silently reusing John's lead.
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'Jane Doe', email: 'family@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT }),
      (e) => e.conflict === true);
  } finally { restore.forEach((x) => x()); }
});

test('findClientMatches: a formatted typed phone still finds the digits-only stored lead', async () => {
  const phoneQueries = [];
  const restore = [
    stub(leadService, 'findAllByColumnValue', async (key, val) => {
      if (key === 'phone') { phoneQueries.push(val); return val === '14165550100' ? [{ id: '9', fullName: 'Phone Hit', clientMasterItemId: '', retainerSent: '' }] : []; }
      return [];
    }),
    stub(clientMaster, 'findCasesByEmail', async () => []),
    stub(clientMaster, 'findCasesByPhone', async () => []),
    stub(clientAccounts, 'findMatches', async () => []),
  ];
  try {
    const m = await portal.findClientMatches({ email: '', phone: '+1 (416) 555-0100' });
    assert.ok(phoneQueries.includes('4165550100') && phoneQueries.includes('14165550100'), 'digit variants queried');
    assert.ok(!phoneQueries.some((q) => /\+|\(/.test(q)), 'no raw/formatted forms queried');
    assert.equal(m.leads.length, 1);
  } finally { restore.forEach((x) => x()); }
});
