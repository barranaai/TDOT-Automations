'use strict';

// Case-activation gate (meeting 2026-08-13): Payment Status → Paid, onboarding
// (intake email + checklist + questionnaire) and the move onto the active
// Cases-board group happen only when client signature + RCIC countersignature
// (for Documenso signings) + payment are ALL in — in ANY completion order.
// Manually-marked signings (no envelope chain) keep signed+paid semantics.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { signatureGateForLead } = require('../src/services/caseGateService');
const paymentService = require('../src/services/paymentService');
const leadService    = require('../src/services/leadService');
const mondayApi      = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const D = '2026-08-17';
const rcJson = (o) => JSON.stringify(o);

test('gate matrix — every completion order and the manual-signing carve-out', () => {
  // nothing yet
  assert.deepEqual(signatureGateForLead({}).missing, ['client signature', 'payment']);
  // manual signing (no envelope chain): signed+paid = complete — no phantom wait
  assert.equal(signatureGateForLead({ retainerSigned: D, retainerPaid: D }).complete, true);
  // envelope merely SENT + client signed on paper: NO countersign wait (it
  // would never be satisfiable — review finding 2026-08-17)
  assert.equal(signatureGateForLead({ retainerSigned: D, retainerPaid: D,
    retainerCountersign: rcJson({ clientEnvelopeId: 'e1' }) }).complete, true);
  // signature COMPLETED via Documenso, countersign pending: incomplete even when paid
  const doc = { retainerSigned: D, retainerPaid: D, retainerCountersign: rcJson({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso' }) };
  assert.deepEqual(signatureGateForLead(doc).missing, ['RCIC countersignature']);
  assert.equal(signatureGateForLead(doc).countersignRequired, true);
  // a countersign envelope chain existing is enough to require completion too
  assert.deepEqual(signatureGateForLead({ retainerSigned: D, retainerPaid: D,
    retainerCountersign: rcJson({ envelopeId: 'rc1' }) }).missing, ['RCIC countersignature']);
  // countersigned: complete
  assert.equal(signatureGateForLead({ ...doc, retainerCountersign: rcJson({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', signedAt: D }) }).complete, true);
  // countersigned but unpaid: still incomplete
  assert.deepEqual(signatureGateForLead({ retainerSigned: D, retainerCountersign: rcJson({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', signedAt: D }) }).missing, ['payment']);
  // corrupt countersign JSON = no envelope chain (legacy semantics)
  assert.equal(signatureGateForLead({ retainerSigned: D, retainerPaid: D, retainerCountersign: '{broken' }).complete, true);
});

test('recordRetainerPaid: payment with countersign pending DEFERS the case advance', async () => {
  const notes = [], cmWrites = [];
  const lead = { id: '700', clientMasterItemId: '9001', retainerSigned: D, retainerPaid: '',
    conversionStatus: '', retainerCountersign: rcJson({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso' }) };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_update/.test(q)) notes.push(v.b || v.body);
      if (/change_multiple_column_values/.test(q)) cmWrites.push(v.cols || v.colValues);
      return {};
    }),
    stub(require('../src/services/milestonePaymentService'), 'patchPayment', async () => {}),
  ];
  try {
    const r = await paymentService.recordRetainerPaid(lead, { reference: 'etr-1' });
    assert.equal(r, null, 'no case advance');
    assert.equal(cmWrites.filter((c) => /Paid/.test(String(c))).length, 0, 'CM Payment Status untouched');
    assert.ok(notes.some((n) => /on hold until the RCIC countersignature/i.test(n)), 'deferral note names the missing piece');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('recordRetainerPaid: manual signing (no envelope) + payment still advances (no phantom gate)', async () => {
  const cmWrites = [];
  const lead = { id: '701', clientMasterItemId: '9002', retainerSigned: D, retainerPaid: '', conversionStatus: '' };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q, v) => {
      if (/change_multiple_column_values/.test(q)) cmWrites.push(String(v.cols || v.colValues));
      return {};
    }),
    stub(require('../src/services/milestonePaymentService'), 'patchPayment', async () => {}),
    stub(require('../src/services/caseGateService'), 'moveCaseToActiveGroup', async () => true),
  ];
  try {
    const r = await paymentService.recordRetainerPaid(lead, {});
    assert.equal(r, '9002', 'case advanced');
    assert.ok(cmWrites.some((c) => /Paid/.test(c)), 'CM Payment Status → Paid');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('countersign completion is the LAST-piece trigger: gate complete + paid → advanceCaseToPaid', async () => {
  const rcSvc = require('../src/services/retainerCountersignService');
  const advances = [];
  const baseLead = { id: '702', clientMasterItemId: '9003', email: '', fullName: 'T',
    retainerSigned: D, retainerPaid: D,
    retainerCountersign: rcJson({ clientEnvelopeId: 'e1', envelopeId: 'rc1', itemId: 'i1' }) };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...baseLead,
      retainerCountersign: rcJson({ clientEnvelopeId: 'e1', envelopeId: 'rc1', itemId: 'i1', signedAt: D }) })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
    stub(paymentService, 'advanceCaseToPaid', async (l) => { advances.push(l.id); return l.clientMasterItemId; }),
    stub(require('../src/services/documensoService'), 'downloadSignedPdf', async () => null),
  ];
  try {
    // current state has NO signedAt (first completion) — the fn stamps it, then advances
    const leadIn = { ...baseLead };
    const restoreFirstRead = stub(leadService, 'getLead',
      (() => { let n = 0; return async () => (++n === 1 ? { ...leadIn } : { ...baseLead,
        retainerCountersign: rcJson({ clientEnvelopeId: 'e1', envelopeId: 'rc1', itemId: 'i1', signedAt: D }) }); })());
    try {
      await rcSvc.recordRetainerCountersignComplete(leadIn, {});
    } finally { restoreFirstRead(); }
    assert.deepEqual(advances, ['702'], 'the deferred advance ran exactly once');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('countersign completion with payment still missing does NOT advance', async () => {
  const rcSvc = require('../src/services/retainerCountersignService');
  const advances = [];
  const lead = { id: '703', clientMasterItemId: '9004', email: '', fullName: 'T',
    retainerSigned: D, retainerPaid: '',
    retainerCountersign: rcJson({ clientEnvelopeId: 'e1' }) };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead, retainerCountersign: rcJson({ clientEnvelopeId: 'e1', signedAt: D }) })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
    stub(paymentService, 'advanceCaseToPaid', async (l) => { advances.push(l.id); }),
    stub(require('../src/services/documensoService'), 'downloadSignedPdf', async () => null),
  ];
  try {
    await rcSvc.recordRetainerCountersignComplete({ ...lead }, {});
    assert.deepEqual(advances, [], 'unpaid — nothing advances');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('manual board-flip (onRetainerPaid): incomplete gate defers onboarding with a loud note', async () => {
  const retainerService = require('../src/services/retainerService');
  const notes = [], stageWrites = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/column_values\(ids/.test(q)) {
        // idempotency state read: first-time payment, stage not started
        return { items: [{ column_values: [] }] };
      }
      if (/create_update/.test(q)) { notes.push(v.b || v.body); return {}; }
      if (/change_multiple_column_values/.test(q)) { stageWrites.push(v.colValues || v.cols); return {}; }
      return {};
    }),
    stub(leadService, 'findAllByColumnValue', async () => ([{ id: '704', retainerSigned: '', retainerPaid: D, retainerCountersign: '' }])),
  ];
  try {
    await retainerService.onRetainerPaid({ itemId: '9005' });
    assert.equal(stageWrites.length, 0, 'no stage/flag writes on an unsigned case');
    assert.ok(notes.some((n) => /on hold/i.test(n) && /client signature/i.test(n)), 'deferral note posted');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('manual board-flip with NO linked lead (legacy case) proceeds as before', async () => {
  const retainerService = require('../src/services/retainerService');
  const stageWrites = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/column_values\(ids/.test(q)) return { items: [{ column_values: [] }] };
      if (/change_multiple_column_values/.test(q)) { stageWrites.push(String(v.colValues || v.cols)); return {}; }
      return {};
    }),
    stub(leadService, 'findByColumnValue', async () => null),
  ];
  try {
    await retainerService.onRetainerPaid({ itemId: '9006' });
    assert.ok(stageWrites.some((c) => /Document Collection Started/.test(c)), 'legacy flow untouched');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('wiring: pending-group creation, active-group move, and the DCS webhook signature gate', () => {
  const fs = require('fs');
  const handoff = fs.readFileSync(require.resolve('../src/services/handoffService'), 'utf8');
  assert.match(handoff, /caseGateService'\)\.pendingGroupId\(\) \|\| await getHandoffGroupId\(\)/, 'new cases start in the pending group');
  const pay = fs.readFileSync(require.resolve('../src/services/paymentService'), 'utf8');
  assert.match(pay, /moveCaseToActiveGroup\(lead\.clientMasterItemId\)/, 'gate completion graduates the row');
  const hook = fs.readFileSync(require.resolve('../src/routes/mondayWebhook'), 'utf8');
  assert.match(hook, /signatureGateForLead\(\{ \.\.\.l, retainerPaid/, 'manual DCS drag verifies signatures (payment leg forced — the board already proved it)');
  assert.match(hook, /Onboarding deferred:<\/b> missing/, 'defers with a note instead of emailing');
});
