'use strict';

// Guards added with "Undo mark paid" (2026-09-23) to the payment writers
// themselves: never write over unreadable records, never let Monday cut them,
// always record who marked a payment, serialise marks with undos, the
// e-transfer request's note that silently failed, and the activation re-check.

const test   = require('node:test');
const assert = require('node:assert/strict');

const ms          = require('../src/services/milestonePaymentService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const paymentService = require('../src/services/paymentService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const MILESTONES = JSON.stringify([
  { label: 'M1 admin', amountCents: 100000, trigger: 'Retainer Confirmed', locked: true },
  { label: 'M2 filing', amountCents: 100000, trigger: 'Internal Review' },
]);
const LEAD = (over = {}) => ({ id: '555001', fullName: 'Test Client', email: 'client@example.com', confirmedCaseType: 'Study permit', retainerFee: '2000', retainerHstRate: '13', retainerMilestones: MILESTONES, milestonePayments: '{}', ...over });

test('readPayments tells an EMPTY record from an UNREADABLE one', () => {
  assert.deepEqual(ms.readPayments({ milestonePayments: '' }), { pay: {}, unreadable: false });
  assert.deepEqual(ms.readPayments({ milestonePayments: '{"0":{"status":"paid"}}' }), { pay: { 0: { status: 'paid' } }, unreadable: false });
  assert.equal(ms.readPayments({ milestonePayments: '{"0":{"status":"pa' }).unreadable, true, 'cut short');
  assert.equal(ms.readPayments({ milestonePayments: '[1]' }).unreadable, true);
});

test('a payment write NEVER goes over unreadable records (it would wipe every real payment)', async () => {
  const writes = [];
  const r1 = stub(leadService, 'getLead', async () => LEAD({ milestonePayments: '{"0":{"status":"paid","paidAt":"2026-0' }));
  const r2 = stub(leadService, 'updateLead', async (...a) => { writes.push(a); });
  try {
    await assert.rejects(ms.patchPayment('555001', 1, { status: 'requested' }), (e) => e.code === 'PAYMENTS_UNREADABLE');
    assert.equal(writes.length, 0);
  } finally { r1(); r2(); }
});

test('a payment write that Monday would cut at 2,000 characters is refused', async () => {
  assert.throws(() => ms.serializePayments('1', { 0: { reference: 'x'.repeat(2000) } }), (e) => e.code === 'PAYMENTS_TOO_LARGE');
  assert.equal(typeof ms.serializePayments('1', { 0: { status: 'paid' } }), 'string');
});

test('patchPayment still never downgrades a paid milestone — undo is its own deliberate path', async () => {
  let stored = JSON.stringify({ 0: { status: 'paid', paidAt: '2026-09-22' } });
  const r1 = stub(leadService, 'getLead', async () => LEAD({ milestonePayments: stored }));
  const r2 = stub(leadService, 'updateLead', async (id, f) => { stored = f.milestonePayments; });
  try {
    await ms.patchPayment('555001', 0, { status: 'requested' });
    assert.equal(JSON.parse(stored)[0].status, 'paid');
  } finally { r1(); r2(); }
});

test('the payment-write queue serialises writers on one lead — neither clobbers the other', async () => {
  let stored = '{}';
  const r1 = stub(leadService, 'getLead', async () => { await new Promise((r) => setTimeout(r, 5)); return LEAD({ milestonePayments: stored }); });
  const r2 = stub(leadService, 'updateLead', async (id, f) => { await new Promise((r) => setTimeout(r, 5)); stored = f.milestonePayments; });
  try {
    await Promise.all([
      ms.patchPayment('555001', 0, { status: 'requested' }),
      ms.withPaymentWriteQueue('555001', async () => {
        const pay = ms.readPayments(await leadService.getLead('555001')).pay;
        pay[1] = { status: 'pending', undone: { by: 'F' } };
        await leadService.updateLead('555001', { milestonePayments: JSON.stringify(pay) });
      }),
    ]);
    const pay = JSON.parse(stored);
    assert.equal(pay[0].status, 'requested');
    assert.equal(pay[1].undone.by, 'F');
  } finally { r1(); r2(); }
});

test('THE REQUEST NOTE: sent with the variable the mutation declares ($b), so it lands on Monday', async () => {
  const queries = [];
  const r1 = stub(leadService, 'getLead', async () => LEAD());
  const r2 = stub(leadService, 'updateLead', async () => {});
  const r3 = stub(mondayApi, 'query', async (q, v) => { queries.push({ q, v }); return {}; });
  const mail = require('../src/services/microsoftMailService');
  const r4 = stub(mail, 'sendEmail', async () => {});
  try {
    await ms.sendMilestoneEtransferRequest('555001', 1);
    const note = queries.find((x) => /create_update/.test(x.q));
    assert.ok(note, 'a note was posted');
    assert.match(note.q, /\$b: String!/);
    assert.equal(typeof note.v.b, 'string', 'the variable is b');
    assert.equal(note.v.body, undefined, 'not "body" — Monday rejected that, after the client had been emailed');
  } finally { r1(); r2(); r3(); r4(); }
});

test('Mark paid records WHO and WHEN, and says so in the note', async () => {
  let stored = '{}';
  const notes = [];
  const r1 = stub(leadService, 'getLead', async () => LEAD({ milestonePayments: stored }));
  const r2 = stub(leadService, 'updateLead', async (id, f) => { stored = f.milestonePayments; });
  const r3 = stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b); return {}; });
  try {
    await ms.markMilestonePaid('555001', 1, { reference: 'BANK-1', actor: { name: 'Gauri Berde', email: 'g@x.com', verified: true } });
    const e = JSON.parse(stored)[1];
    assert.equal(e.status, 'paid');
    assert.equal(e.marked.by, 'Gauri Berde');
    assert.equal(e.marked.verified, true);
    assert.match(e.marked.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    assert.match(notes[0], /Recorded by Gauri Berde/);
    // a typed name (no Monday sign-in) is labelled as such
    stored = '{}'; notes.length = 0;
    await ms.markMilestonePaid('555001', 1, { actor: { name: 'Kamalpreet' } });
    assert.equal(JSON.parse(stored)[1].marked.verified, false);
    assert.match(notes[0], /name as typed/);
  } finally { r1(); r2(); r3(); }
});

test('Mark paid waits for the lead lock — it can never interleave with an undo', async () => {
  let stored = '{}';
  const order = [];
  const r1 = stub(leadService, 'getLead', async () => LEAD({ milestonePayments: stored }));
  const r2 = stub(leadService, 'updateLead', async (id, f) => { stored = f.milestonePayments; order.push('mark wrote'); });
  const r3 = stub(mondayApi, 'query', async () => ({}));
  try {
    const { withLeadLock } = require('../src/services/leadMutex');
    let release;
    const held = withLeadLock('555001', () => new Promise((r) => { release = () => { order.push('lock released'); r(); }; }));
    const mark = ms.markMilestonePaid('555001', 1, { actor: { name: 'X' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, [], 'the mark is waiting');
    release();
    await held; await mark;
    assert.deepEqual(order, ['lock released', 'mark wrote']);
  } finally { r1(); r2(); r3(); }
});

test('milestoneStates carries the tooltip facts — who marked it, who undid it, when', () => {
  const s = ms.milestoneStates(LEAD({ milestonePayments: JSON.stringify({
    0: { status: 'paid', paidAt: '2026-09-22', marked: { by: 'Gauri', at: '2026-09-22T20:59Z', verified: true } },
    1: { status: 'pending', undone: { by: 'Faran', at: '2026-09-23T15:04Z', was: 'x' } },
  }) }), '', []);
  assert.equal(s[0].markedBy, 'Gauri');
  assert.equal(s[0].markedAt, '2026-09-22T20:59Z');
  assert.equal(s[0].markedVerified, true);
  assert.equal(s[1].undoneBy, 'Faran');
  assert.equal(s[1].status, 'pending');
});

// ─── The activation re-check at the point of no return ───────────────────────

test('advanceCaseToPaid re-reads the payment: removed since the caller read it → NOT activated', async () => {
  const writes = [];
  const r1 = stub(leadService, 'getLead', async () => ({ id: '555001', clientMasterItemId: '9', retainerPaid: '' }));
  const r2 = stub(mondayApi, 'query', async (q) => { if (/change_multiple_column_values/.test(q)) writes.push(q); return { items: [{ column_values: [{ text: 'Already Sent' }] }] }; });
  try {
    const r = await paymentService.advanceCaseToPaid({ id: '555001', clientMasterItemId: '9', retainerPaid: '2026-09-22' });
    assert.equal(r, null);
    assert.equal(writes.length, 0, 'no "Paid" written — onboarding would have emailed an unpaid client');
  } finally { r1(); r2(); }
});

test('advanceCaseToPaid re-check fails CLOSED: an unreadable lead means no activation now', async () => {
  const writes = [];
  const r1 = stub(leadService, 'getLead', async () => { throw new Error('monday down'); });
  const r2 = stub(mondayApi, 'query', async (q) => { if (/change_multiple_column_values/.test(q)) writes.push(q); return { items: [{ column_values: [{ text: '' }] }] }; });
  try {
    assert.equal(await paymentService.advanceCaseToPaid({ id: '555001', clientMasterItemId: '9', retainerPaid: '2026-09-22' }), null);
    assert.equal(writes.length, 0);
  } finally { r1(); r2(); }
});

test('advanceCaseToPaid still activates a genuinely paid client — and recordRetainerPaid skips the re-check', async () => {
  const writes = [];
  const gate = require('../src/services/caseGateService');
  const r0 = stub(gate, 'moveCaseToActiveGroup', async () => {});
  const r1 = stub(leadService, 'getLead', async () => ({ id: '555001', clientMasterItemId: '9', retainerPaid: '2026-09-22' }));
  const r2 = stub(mondayApi, 'query', async (q) => { if (/change_multiple_column_values/.test(q)) writes.push(q); return { items: [{ column_values: [{ text: '' }] }] }; });
  try {
    assert.equal(await paymentService.advanceCaseToPaid({ id: '555001', clientMasterItemId: '9', retainerPaid: '2026-09-22' }), '9');
    assert.equal(writes.length, 1);
    // recheckPaid:false (recordRetainerPaid just wrote the date; a read can lag) writes without re-reading
    r1(); const r3 = stub(leadService, 'getLead', async () => { throw new Error('must not be called'); });
    assert.equal(await paymentService.advanceCaseToPaid({ id: '555001', clientMasterItemId: '9', retainerPaid: '2026-09-22' }, '2026-09-22', { recheckPaid: false }), '9');
    r3();
    const src = require('fs').readFileSync(require.resolve('../src/services/paymentService.js'), 'utf8');
    assert.match(src, /await advanceCaseToPaid\(lead, when, \{ recheckPaid: false \}\);/, 'recordRetainerPaid opts out explicitly');
  } finally { r0(); r2(); }
});
