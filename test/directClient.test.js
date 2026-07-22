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

const CASE_TYPE = CASE_TYPE_LABELS[0];
const CONSULTANT = 'Shermin Teymouri Mofrad';

// Registry unreachable in tests → the label source falls back to the static config.
const stubRegistryDown = () => stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); });

// ─── createDirectClient ───────────────────────────────────────────────────────

test('createDirectClient: creates a fully-wired lead (tag, case type, consultant, status)', async () => {
  let createArgs = null; const updates = [];
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findByColumnValue', async () => null),
    stub(leadService, 'createLead', async (f) => { createArgs = f; return { id: '900', ...f }; }),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(mondayApi, 'query', async () => ({})), // portal note
  ];
  try {
    const r = await portal.createDirectClient({
      fullName: 'Walkin Client', email: 'walkin@example.com', phone: '+1416', residentialAddress: '1 Main St',
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
    stub(leadService, 'findByColumnValue', async () => null),
    stub(leadService, 'createLead', async () => { created = true; return { id: 'x' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  const cases = [
    { fullName: '', email: 'a@b.co', caseType: CASE_TYPE, consultant: CONSULTANT },
    { fullName: 'A B', email: 'not-an-email', caseType: CASE_TYPE, consultant: CONSULTANT },
    { fullName: 'A B', email: 'a@b.co', caseType: 'Made Up Case Type', consultant: CONSULTANT },
    { fullName: 'A B', email: 'a@b.co', caseType: CASE_TYPE, consultant: 'Unknown Person' },
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
        () => portal.createDirectClient({ fullName: 'A B', email: 'a@b.co', caseType: withSubs, caseSubType: foreignSub, consultant: CONSULTANT }),
        (e) => e.badRequest === true);
    }
    // a sub-type supplied for a case type that HAS NO sub-types is also rejected
    const noSubs = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
    if (noSubs) {
      await assert.rejects(
        () => portal.createDirectClient({ fullName: 'A B', email: 'a@b.co', caseType: noSubs, caseSubType: 'Anything At All', consultant: CONSULTANT }),
        (e) => e.badRequest === true, 'foreign sub-type on a no-sub-type case type must be rejected');
    }
    assert.equal(created, false, 'no lead created on any invalid input');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: duplicate guard — an existing un-retained direct lead with the same email is REUSED', async () => {
  let created = false;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findByColumnValue', async (key, val) => (
      key === 'email' && val === 'walkin@example.com'
        ? { id: '777', sourceChannel: 'Direct Retainer', retainerSent: '' } : null)),
    stub(leadService, 'createLead', async () => { created = true; return { id: 'x' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Walkin Client', email: 'walkin@example.com', caseType: CASE_TYPE, consultant: CONSULTANT });
    assert.equal(r.reused, true);
    assert.equal(r.leadId, '777');
    assert.equal(created, false, 'no duplicate lead minted');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: wiring failure NEVER strands staff — retries once, then returns the lead with a warning', async () => {
  let createCalls = 0, updateCalls = 0;
  const restore = [
    stubRegistryDown(),
    stub(leadService, 'findByColumnValue', async () => null),
    stub(leadService, 'createLead', async () => { createCalls++; return { id: '901' }; }),
    stub(leadService, 'updateLead', async () => { updateCalls++; throw new Error('monday 500'); }),
    stub(mondayApi, 'query', async () => ({})), // failure note (best-effort)
  ];
  try {
    const r = await portal.createDirectClient({ fullName: 'Walkin Client', email: 'w2@example.com', caseType: CASE_TYPE, consultant: CONSULTANT });
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
