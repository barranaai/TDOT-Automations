'use strict';

// Multi-case behavior (client accounts Phase 3): a returning client's new
// application creates a NEW Client Master case instead of silently reusing —
// and overwriting — their existing one. Reuse survives ONLY for what it was
// built for: crash/double-submit recovery of an early shell of the SAME
// application. Flag-gated: clientMultiCaseEnabled off = legacy reuse-always.

const test   = require('node:test');
const assert = require('node:assert/strict');

const handoff        = require('../src/services/handoffService');
const leadService    = require('../src/services/leadService');
const mondayApi      = require('../src/services/mondayApi');
const clientAccounts = require('../src/services/clientAccountService');
const features       = require('../config/features');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// ─── decideCaseReuse — the pure rule ─────────────────────────────────────────

const D = handoff.decideCaseReuse;

test('decideCaseReuse: a PAID or progressed case is never reused', () => {
  assert.equal(D({ existingStage: 'Pre-Onboarding', existingPaymentStatus: 'Paid' }), 'new');
  assert.equal(D({ existingStage: 'Document Collection Started', existingPaymentStatus: '' }), 'new');
  assert.equal(D({ existingStage: 'Retained', existingPaymentStatus: 'Paid' }), 'new');
});

test('decideCaseReuse: a DIFFERENT confirmed case type means a second application', () => {
  assert.equal(D({ existingStage: 'Pre-Onboarding', existingPaymentStatus: '', existingCaseType: 'Visitor Visa', leadResolvedCaseType: 'Citizenship' }), 'new');
});

test('decideCaseReuse: an early unpaid shell of the same application IS reused (crash/double-submit recovery)', () => {
  assert.equal(D({ existingStage: 'Pre-Onboarding', existingPaymentStatus: '', existingCaseType: '', leadResolvedCaseType: 'Citizenship' }), 'reuse');
  assert.equal(D({ existingStage: '', existingPaymentStatus: '', existingCaseType: 'Citizenship', leadResolvedCaseType: 'Citizenship' }), 'reuse');
  // handoff itself writes 'Signed (Unpaid)' AT create — a crashed run leaves this exact signature
  assert.equal(D({ existingStage: 'Pre-Onboarding', existingPaymentStatus: 'Signed (Unpaid)', existingCaseType: '', leadResolvedCaseType: '' }), 'reuse');
  // the board automation's misspelled stamp on fresh rows is not an engagement signal
  assert.equal(D({ existingStage: 'Not Started', existingPaymentStatus: 'Alreaday Sent' }), 'reuse');
});

// ─── _doHandoff integration (driven via openCaseEarly) ───────────────────────

const LEAD = {
  id: '600', fullName: 'Returning Client', email: 'return@x.com', phone: '4165550100',
  clientMasterItemId: '', confirmedCaseType: 'Citizenship', sourceChannel: 'Direct Retainer',
};

// A CM row in the finder's wire shape.
function cmRow({ id, name, stage = '', pay = '', type = '', ref = '' }) {
  return { id, name, column_values: [
    { id: 'color_mm0x8faa', text: stage },
    { id: 'color_mm0x9fnn', text: pay },
    { id: 'dropdown_mm0xd1qn', text: type },
    { id: 'text_mm142s49', text: ref },
  ] };
}

// mondayApi router for the handoff flow; records creates + notes.
function handoffStub({ existingRow } = {}) {
  const calls = { created: 0, notes: [], mutatedItems: [] };
  const fn = async (q, vars) => {
    if (/items_page_by_column_values/.test(q)) {
      return { items_page_by_column_values: { items: existingRow ? [existingRow] : [] } };
    }
    if (/groups \{ id title \}|groups\s*{/.test(q)) return { boards: [{ groups: [{ id: 'g1', title: 'New Clients' }] }] };
    if (/create_item/.test(q)) { calls.created++; return { create_item: { id: '9900' } }; }
    if (/create_update/.test(q)) { calls.notes.push({ itemId: String(vars.itemId), body: vars.body }); return { create_update: { id: 'u' } }; }
    if (/change_multiple_column_values/.test(q)) { calls.mutatedItems.push(String(vars.itemId || (vars.i || ''))); return { change_multiple_column_values: { id: 'x' } }; }
    if (/items\(ids/.test(q)) return { items: [] };
    if (/updates\(limit/.test(q)) return { items: [{ updates: [] }] };
    return {};
  };
  return { fn, calls };
}

function commonStubs(m, { leadUpdates }) {
  return [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ ...LEAD })),
    stub(leadService, 'updateLead', async (id, f) => { leadUpdates.push({ id, f }); }),
    // account stamping is exercised elsewhere — neutralise it here.
    // (transferLeadUpdates needs no stub: _doHandoff calls the module-local
    // binding, and the mondayApi router answers its queries with empty sets.)
    stub(clientAccounts, 'findOrCreate', async () => null),
  ];
}

test('flag OFF: even a PAID existing case is reused (legacy behavior, byte-for-byte)', async () => {
  const m = handoffStub({ existingRow: cmRow({ id: '800', name: 'Returning Client', stage: 'Retained', pay: 'Paid', type: 'Visitor Visa', ref: '2026-VV-100' }) });
  const leadUpdates = [];
  const restore = [...commonStubs(m, { leadUpdates })];
  const flagWas = features.clientMultiCaseEnabled; features.clientMultiCaseEnabled = false;
  try {
    const cmId = await handoff.openCaseEarly({ leadId: '600' });
    assert.equal(cmId, '800', 'the old case is reused');
    assert.equal(m.calls.created, 0, 'no new case created');
    assert.ok(leadUpdates.some((u) => u.f.clientMasterItemId === '800'));
  } finally { features.clientMultiCaseEnabled = flagWas; restore.forEach((x) => x()); }
});

test('flag ON: a RETAINED existing case gets a NEW case — old case untouched, cross-notes on both, lead points at the new case', async () => {
  const m = handoffStub({ existingRow: cmRow({ id: '800', name: 'Returning Client', stage: 'Retained', pay: 'Paid', type: 'Visitor Visa', ref: '2026-VV-100' }) });
  const leadUpdates = [];
  const restore = [...commonStubs(m, { leadUpdates })];
  const flagWas = features.clientMultiCaseEnabled; features.clientMultiCaseEnabled = true;
  try {
    const cmId = await handoff.openCaseEarly({ leadId: '600' });
    assert.equal(cmId, '9900', 'a NEW Client Master case');
    assert.equal(m.calls.created, 1);
    assert.ok(!m.calls.mutatedItems.includes('800'), 'the old case\'s columns were never written');
    assert.ok(leadUpdates.some((u) => u.f.clientMasterItemId === '9900'), 'the lead points at the NEW case');
    const noteOnNew = m.calls.notes.find((n) => n.itemId === '9900' && /Returning client/.test(n.body));
    const noteOnOld = m.calls.notes.find((n) => n.itemId === '800' && /Client returned/.test(n.body));
    assert.ok(noteOnNew && /2026-VV-100/.test(noteOnNew.body), 'new case notes the previous case ref');
    assert.ok(noteOnOld && /NOT|not changed/i.test(noteOnOld.body), 'old case notes it was untouched');
  } finally { features.clientMultiCaseEnabled = flagWas; restore.forEach((x) => x()); }
});

test('flag ON: an early unpaid same-type shell is STILL reused (double-submit protection intact)', async () => {
  const m = handoffStub({ existingRow: cmRow({ id: '801', name: 'Returning Client', stage: 'Pre-Onboarding', pay: '', type: 'Citizenship', ref: '' }) });
  const leadUpdates = [];
  const restore = [...commonStubs(m, { leadUpdates })];
  const flagWas = features.clientMultiCaseEnabled; features.clientMultiCaseEnabled = true;
  try {
    const cmId = await handoff.openCaseEarly({ leadId: '600' });
    assert.equal(cmId, '801', 'the shell is reused');
    assert.equal(m.calls.created, 0);
  } finally { features.clientMultiCaseEnabled = flagWas; restore.forEach((x) => x()); }
});

test('flag ON: a shared-email DIFFERENT-name row still yields a separate case (spouse rule unchanged)', async () => {
  const m = handoffStub({ existingRow: cmRow({ id: '802', name: 'The Spouse', stage: 'Retained', pay: 'Paid' }) });
  const leadUpdates = [];
  const restore = [...commonStubs(m, { leadUpdates })];
  const flagWas = features.clientMultiCaseEnabled; features.clientMultiCaseEnabled = true;
  try {
    const cmId = await handoff.openCaseEarly({ leadId: '600' });
    assert.equal(cmId, '9900', 'new case (name mismatch → no match at all)');
    assert.equal(m.calls.notes.filter((n) => /Returning client|Client returned/.test(n.body)).length, 0,
      'no returning-client notes — this was never a match, not an escalation');
  } finally { features.clientMultiCaseEnabled = flagWas; restore.forEach((x) => x()); }
});

test('multi-match: among several same-person rows, the early SHELL is preferred (crash-retry reuses it, never orphans it)', async () => {
  const progressed = cmRow({ id: '800', name: 'Returning Client', stage: 'Retained', pay: 'Paid', type: 'Visitor Visa', ref: '2026-VV-100' });
  const shell      = cmRow({ id: '803', name: 'Returning Client', stage: 'Pre-Onboarding', pay: '', type: 'Citizenship', ref: '' });
  const m = handoffStub({});
  const routed = async (q, vars) => {
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [progressed, shell] } };
    return m.fn(q, vars);
  };
  const leadUpdates = [];
  const restore = [
    stub(mondayApi, 'query', routed),
    stub(leadService, 'getLead', async () => ({ ...LEAD })),
    stub(leadService, 'updateLead', async (id, f) => { leadUpdates.push({ id, f }); }),
    stub(clientAccounts, 'findOrCreate', async () => null),
  ];
  const flagWas = features.clientMultiCaseEnabled; features.clientMultiCaseEnabled = true;
  try {
    const cmId = await handoff.openCaseEarly({ leadId: '600' });
    assert.equal(cmId, '803', 'the shell wins over the progressed case');
    assert.equal(m.calls.created, 0, 'no orphan duplicate created');
  } finally { features.clientMultiCaseEnabled = flagWas; restore.forEach((x) => x()); }
});
