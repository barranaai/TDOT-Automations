'use strict';

// Case-first direct retainer clients: the Client Master case opens at CREATION
// (neutral labels), the engine row lives in its own Lead Board group and never
// appears among leads, and SIGNING later upgrades the same case idempotently
// (labels + consultant-entered family top-up).

const test   = require('node:test');
const assert = require('node:assert/strict');

const handoff     = require('../src/services/handoffService');
const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const familyComp  = require('../src/services/familyCompositionService');
const registry    = require('../src/services/caseTypeRegistryService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const baseLead = (extra = {}) => ({
  id: '800', fullName: 'Walkin Case First', email: 'wcf@example.com',
  confirmedCaseType: 'Citizenship', clientMasterItemId: '', conversionStatus: 'Qualified', ...extra,
});

// A mondayApi stub covering the handoff's query mix. Records every call.
function handoffMondayStub({ dedupHit = null } = {}) {
  const calls = [];
  const fn = async (q, vars) => {
    calls.push({ q, vars });
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: dedupHit ? [dedupHit] : [] } };
    if (/groups \{ id title \}/.test(q) || /groups\s*{\s*id title/.test(q)) return { boards: [{ groups: [{ id: 'g1', title: 'Retainer Sent' }] }] };
    if (/create_item/.test(q)) return { create_item: { id: 'CM-900' } };
    if (/updates\(/.test(q)) return { items: [{ updates: [] }] };
    if (/column_values\(ids/.test(q)) return { items: [{ column_values: [] }] };
    return {};
  };
  return { fn, calls };
}

// ─── early open (presigned): neutral labels ──────────────────────────────────

test('openCaseEarly: creates the case WITHOUT signed-state stamps', async () => {
  process.env.MONDAY_CM_HANDOFF_GROUP_ID = 'gtest'; // skip the group lookup
  const m = handoffMondayStub();
  const updates = [];
  const restore = [
    stub(leadService, 'getLead', async () => baseLead()),
    stub(leadService, 'updateLead', async (id, f) => { updates.push(f); }),
    stub(mondayApi, 'query', m.fn),
    stub(registry, 'isCanonicalCaseType', async () => true),
  ];
  try {
    const cmId = await handoff.openCaseEarly({ leadId: '800' });
    assert.equal(cmId, 'CM-900');
    const createCall = m.calls.find((c) => /create_item/.test(c.q) && /item_name/.test(c.q));
    assert.ok(createCall, 'case created');
    assert.ok(!/Signed \(Unpaid\)/.test(createCall.vars.cols), 'Payment Status NOT stamped before signing');
    assert.ok(/Pre-Onboarding/.test(createCall.vars.cols), 'case stage still set');
    const link = updates.find((f) => f.clientMasterItemId);
    assert.ok(link, 'lead linked to the case');
    assert.ok(!('conversionStatus' in link), 'conversion status untouched (stays Qualified — not "Retained — Awaiting Payment")');
  } finally { restore.forEach((x) => x()); delete process.env.MONDAY_CM_HANDOFF_GROUP_ID; }
});

// ─── the classic signed-time handoff is unchanged ─────────────────────────────

test('onRetainerSigned (fresh handoff): still stamps Signed (Unpaid) + Retained — Awaiting Payment', async () => {
  process.env.MONDAY_CM_HANDOFF_GROUP_ID = 'gtest';
  const m = handoffMondayStub();
  const updates = [];
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ id: '801' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push(f); }),
    stub(mondayApi, 'query', m.fn),
    stub(registry, 'isCanonicalCaseType', async () => true),
    stub(familyComp, 'createFromLead', async () => 0),
  ];
  try {
    await handoff.onRetainerSigned({ leadId: '801' });
    const createCall = m.calls.find((c) => /create_item/.test(c.q) && /item_name/.test(c.q));
    assert.ok(/Signed \(Unpaid\)/.test(createCall.vars.cols), 'signed-time creation keeps the stamp');
    assert.ok(updates.some((f) => f.conversionStatus === 'Retained — Awaiting Payment'), 'lead status stamped');
  } finally { restore.forEach((x) => x()); delete process.env.MONDAY_CM_HANDOFF_GROUP_ID; }
});

// ─── ensureSignedState: the early-opened case is upgraded at signing ──────────

function signedStateMondayStub({ payText = '', caseRef = '2026-CIT-001' } = {}) {
  const calls = [];
  const fn = async (q, vars) => {
    calls.push({ q, vars });
    if (/column_values\(ids/.test(q)) {
      return { items: [{ column_values: [
        { id: 'color_mm0x9fnn', text: payText },
        { id: 'text_mm142s49', text: caseRef },
      ] }] };
    }
    return {};
  };
  return { fn, calls };
}

test('ensureSignedState: stamps Payment Status + lead status and tops up family (IN-SCOPE lead) on an early-opened case', async () => {
  const m = signedStateMondayStub({ payText: '', caseRef: '2026-CIT-001' });
  const updates = []; let familyArgs = null;
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900', conversionStatus: 'Qualified' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push(f); }),
    stub(mondayApi, 'query', m.fn),
    stub(familyComp, 'createFromLead', async (a) => { familyArgs = a; return 2; }),
  ];
  try {
    await handoff.ensureSignedState('800');
    const stamp = m.calls.find((c) => /change_multiple_column_values/.test(c.q));
    assert.ok(stamp && /Signed \(Unpaid\)/.test(stamp.vars.cols), 'Payment Status stamped at signing');
    assert.ok(updates.some((f) => f.conversionStatus === 'Retained — Awaiting Payment'), 'lead upgraded');
    assert.equal(familyArgs.caseRef, '2026-CIT-001');
    assert.equal(familyArgs.cmItemId, 'CM-900');
    assert.equal(familyArgs.lead.id, '800', 'family built from the SIGNING lead — never a first-hit lookup that could pick another lead sharing the case');
  } finally { restore.forEach((x) => x()); }
});

test('ensureSignedState: overrides a Monday-automation label ("Alreaday Sent") at first signing — only Paid is sacred', async () => {
  const m = signedStateMondayStub({ payText: 'Alreaday Sent', caseRef: '2026-CIT-001' });
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900', conversionStatus: 'Qualified' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', m.fn),
    stub(familyComp, 'createFromLead', async () => 0),
  ];
  try {
    await handoff.ensureSignedState('800');
    assert.ok(m.calls.some((c) => /Signed \(Unpaid\)/.test(String(c.vars && c.vars.cols))),
      'the automation-stamped label is overridden by the real signed state');
  } finally { restore.forEach((x) => x()); }
});

test('ensureSignedState: ONCE-ONLY — a lead already at signed-state is skipped entirely (no reads, no family resurrection)', async () => {
  for (const cs of ['Retained — Awaiting Payment', 'Retained']) {
    let mondayCalls = 0, wrote = false, familyCalled = false;
    const restore = [
      stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900', conversionStatus: cs })),
      stub(leadService, 'updateLead', async () => { wrote = true; }),
      stub(mondayApi, 'query', async () => { mondayCalls++; return {}; }),
      stub(familyComp, 'createFromLead', async () => { familyCalled = true; return 0; }),
    ];
    try {
      await handoff.ensureSignedState('800');
      assert.equal(mondayCalls, 0, `${cs}: no CM reads/writes — re-fired webhooks are true no-ops`);
      assert.equal(wrote, false);
      assert.equal(familyCalled, false, `${cs}: staff-curated family boards are never touched again`);
    } finally { restore.forEach((x) => x()); }
  }
});

test('ensureSignedState: PAID-FIRST — runs the deferred paid-advance instead of stamping Signed (Unpaid)', async () => {
  const paymentService = require('../src/services/paymentService');
  const m = signedStateMondayStub({ payText: '', caseRef: '2026-CIT-001' });
  const updates = []; let advanced = null;
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900', conversionStatus: 'Qualified', retainerPaid: '2026-07-29' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push(f); }),
    stub(mondayApi, 'query', m.fn),
    stub(paymentService, 'advanceCaseToPaid', async (l) => { advanced = l.id; return 'CM-900'; }),
    stub(familyComp, 'createFromLead', async () => 0),
  ];
  try {
    await handoff.ensureSignedState('800');
    assert.equal(advanced, '800', 'deferred Paid advance runs at signing');
    assert.ok(!m.calls.some((c) => /Signed \(Unpaid\)/.test(String(c.vars && c.vars.cols))), 'no Signed (Unpaid) over a paid client');
    assert.ok(!updates.some((f) => f.conversionStatus), 'no interim label — maybeMarkRetained owns the Retained flip in the same chain');
  } finally { restore.forEach((x) => x()); }
});

test('ensureSignedState: fails CLOSED when the case read fails (no blind writes)', async () => {
  let wrote = false;
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900' })),
    stub(leadService, 'updateLead', async () => { wrote = true; }),
    stub(mondayApi, 'query', async () => { throw new Error('monday 500'); }),
  ];
  try {
    await handoff.ensureSignedState('800'); // must not throw
    assert.equal(wrote, false);
  } finally { restore.forEach((x) => x()); }
});

// ─── recordRetainerPaid: paid-first defers the onboarding advance ─────────────

test('recordRetainerPaid: payment on an UNSIGNED case defers the Paid advance (no premature onboarding)', async () => {
  const paymentService = require('../src/services/paymentService');
  const calls = []; const notes = [];
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900', retainerSigned: '', retainerPaid: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q, v) => {
      calls.push({ q, v });
      if (/create_update/.test(q)) notes.push(v.b);
      return {};
    }),
  ];
  try {
    const r = await paymentService.recordRetainerPaid(
      baseLead({ clientMasterItemId: 'CM-900', retainerSigned: '', retainerPaid: '' }), { reference: 'ETR-1' });
    assert.equal(r, null, 'no Phase-1 trigger returned');
    assert.ok(!calls.some((c) => /change_multiple_column_values/.test(c.q) && /"Paid"/.test(String(c.v && c.v.cols))),
      'CM Payment Status NOT advanced to Paid before signing');
    assert.ok(notes.some((n) => /before signing/i.test(n)), 'staff note explains the deferral');
  } finally { restore.forEach((x) => x()); }
});

test('recordRetainerPaid: normal signed→paid order still advances the case immediately', async () => {
  const paymentService = require('../src/services/paymentService');
  const calls = [];
  const restore = [
    stub(leadService, 'getLead', async () => baseLead({ clientMasterItemId: 'CM-900', retainerSigned: '2026-07-29', retainerPaid: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q, v) => { calls.push({ q, v }); return {}; }),
  ];
  try {
    const r = await paymentService.recordRetainerPaid(
      baseLead({ clientMasterItemId: 'CM-900', retainerSigned: '2026-07-29', retainerPaid: '' }), { txnId: 't9' });
    assert.equal(r, 'CM-900');
    assert.ok(calls.some((c) => /change_multiple_column_values/.test(c.q) && /"Paid"/.test(String(c.v && c.v.cols))),
      'CM advanced to Paid (classic behavior unchanged)');
  } finally { restore.forEach((x) => x()); }
});

// ─── portal surfaces ──────────────────────────────────────────────────────────

test('getLeadsQueue: direct retainer clients never appear among leads', async () => {
  const restore = stub(leadService, 'listAllLeads', async () => [
    { id: '1', fullName: 'Normal Lead', bookingStatus: 'Not Yet', sourceChannel: 'Website', createdAt: '2026-07-30' },
    { id: '2', fullName: 'Direct Client', bookingStatus: 'Not Yet', sourceChannel: 'Direct Retainer', createdAt: '2026-07-30' },
  ]);
  try {
    const rows = await portal.getLeadsQueue();
    assert.ok(rows.some((r) => r.id === '1'));
    assert.ok(!rows.some((r) => r.id === '2'), 'direct client hidden from the Leads tab');
  } finally { restore(); }
});

test('getDirectRetainerQueue: lists in-progress direct clients, drops Retained ones', async () => {
  const restore = stub(leadService, 'listAllLeads', async () => [
    { id: '3', fullName: 'In Progress', sourceChannel: 'Direct Retainer', conversionStatus: 'Qualified',
      retainerFee: 2000, retainerSent: '2026-07-30', clientMasterItemId: 'CM1', createdAt: '2026-07-30' },
    { id: '4', fullName: 'Done', sourceChannel: 'Direct Retainer', conversionStatus: 'Retained', createdAt: '2026-07-29' },
    { id: '5', fullName: 'Normal Lead', sourceChannel: 'Website', createdAt: '2026-07-28' },
  ]);
  try {
    const rows = await portal.getDirectRetainerQueue();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, '3');
    assert.equal(rows[0].retainerStatus, 'Sent');
    assert.equal(rows[0].caseOpen, true);
  } finally { restore(); }
});

// ─── createDirectClient: group + immediate case ───────────────────────────────

test('createDirectClient: engine row goes to the direct group and the case opens immediately', async () => {
  let createOpts = null, earlyCalled = false;
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async (f, opts) => { createOpts = opts; return { id: '900' }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(handoff, 'openCaseEarly', async () => { earlyCalled = true; return 'CM-901'; }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
    const noSubs = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
    const r = await portal.createDirectClient({
      fullName: 'Walkin Client', email: 'w@example.com', residentialAddress: '1 Main St',
      caseType: noSubs, consultant: 'Shermin Teymouri Mofrad',
    });
    assert.equal(r.ok, true);
    assert.equal(r.caseOpened, true, 'case-first: the Client Master case exists at creation');
    assert.equal(earlyCalled, true);
    assert.ok(createOpts && createOpts.groupId, 'engine row created in the dedicated board group');
  } finally { restore.forEach((x) => x()); }
});

test('createDirectClient: a failed early case-open does not block creation (signing will open it)', async () => {
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async () => ({ id: '901' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(handoff, 'openCaseEarly', async () => { throw new Error('monday down'); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
    const noSubs = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
    const r = await portal.createDirectClient({
      fullName: 'Walkin Client', email: 'w2@example.com', residentialAddress: '1 Main St',
      caseType: noSubs, consultant: 'Shermin Teymouri Mofrad',
    });
    assert.equal(r.ok, true);
    assert.equal(r.caseOpened, false, 'reported honestly; the signed-time handoff remains the fallback');
  } finally { restore.forEach((x) => x()); }
});
