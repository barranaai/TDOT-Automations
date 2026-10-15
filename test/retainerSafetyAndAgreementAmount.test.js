'use strict';

// 2026-10-15 (Faran "go"): three small fixes found while building points 4 and 5.
//  A. The consultation agreement says what was ACTUALLY paid when the fee was not
//     paid through the booking link: the staff record (cash / e-transfer / invoice
//     / other — the fee before HST, plus the HST this client owes) or "waived".
//  B. A Retainer Signed date typed in Monday on a lead whose outcome is a decision
//     NOT to retain never opens a case or sends the payment link.
//  C. Re-issuing a retainer on a lead that is no longer Retain refuses up front —
//     before anything is voided — instead of leaving the client with no agreement.

const test   = require('node:test');
const assert = require('node:assert/strict');

const cas         = require('../src/services/consultAgreementService');
const retainer2   = require('../src/services/retainerService2');
const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const documenso   = require('../src/services/documensoService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const rec = (o) => JSON.stringify({ on: '2026-10-14', by: 'Melanie', ...o });

/* ── A ── */

test('agreement: the booking-link payment wins; a staff record prints fee + the HST FIXED when it was recorded; an old record prints the fee alone; waived says so', () => {
  const amt = (lead) => cas.buildConsultAgreementData({ fullName: 'A', residentialAddress: '1 St', email: 'a@x.co', bookedSlot: '2026-10-20 10:00', ...lead }).data.amountPaid;
  const opt = JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 });
  assert.equal(amt({ consultOption: opt, consultPayment: rec({ kind: 'cash', amountCents: 15000, hstCents: 1950 }) }), '226.00 (incl. HST)', 'the app payment outranks a record');
  assert.equal(amt({ consultPayment: rec({ kind: 'cash', amountCents: 20000, hstCents: 2600 }) }), '226.00 (incl. HST)');
  assert.equal(amt({ country: 'Canada', consultPayment: rec({ kind: 'e-transfer', amountCents: 20000, hstCents: 0 }) }), '200.00', 'recorded with no HST (client was abroad then) — a later move to Canada changes nothing');
  assert.equal(amt({ consultPayment: rec({ kind: 'invoice', amountCents: 20000 }) }), '200.00', 'an older record without the HST figure: the fee alone, no claim it cannot prove');
  assert.equal(amt({ consultPayment: rec({ kind: 'waived', amountCents: 0 }) }), 'nothing (the consultation fee was waived)');
  assert.equal(amt({}), '200.00', 'no payment on file → the standard fee, as before');
});

test('recording a payment fixes the HST from where the client is NOW (none abroad); recording after the agreement went out says the sent copy keeps the old amount', async () => {
  const writes = [], notes = [];
  for (const [lead, hst, out] of [[{ country: 'India' }, 0, false], [{ country: '' }, 2600, false], [{ consultAgreementSent: '2026-10-10' }, 2600, true]]) {
    const restore = [
      stub(leadService, 'getLead', async (id) => ({ id, ...lead })),
      stub(leadService, 'updateLead', async (id, f) => { writes.push(JSON.parse(f.consultPayment)); }),
      stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b); return {}; }),
    ];
    try {
      const r = await portal.applyAction({ leadId: '42', action: 'recordConsultPayment', value: { kind: 'cash', amountCents: 20000, on: '2026-10-14' }, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } });
      assert.equal(writes[writes.length - 1].hstCents, hst, JSON.stringify(lead));
      assert.equal(/already sent for signature keeps the earlier amount; its preview link now shows the new one/.test(r.message), out);
      assert.equal(/already sent for signature keeps the earlier amount/.test(notes[notes.length - 1]), out);
    } finally { restore.reverse().forEach((x) => x()); }
  }
});

test('recording or removing a payment drops the cached agreement copy (its "has paid" line changed)', async () => {
  const evicted = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, consultPayment: rec({ kind: 'cash', amountCents: 20000 }) })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
    stub(cas, 'evictCache', (id) => { evicted.push(String(id)); return true; }),
  ];
  try {
    await portal.applyAction({ leadId: '41', action: 'recordConsultPayment', value: { kind: 'waived' }, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } });
    await portal.applyAction({ leadId: '41', action: 'recordConsultPayment', value: { kind: 'clear' }, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } });
    assert.deepEqual(evicted, ['41', '41']);
  } finally { restore.reverse().forEach((x) => x()); }
});

/* ── B ── */

function signedWorld(lead) {
  const calls = { writes: [], notes: [], handoff: 0, link: 0, agreement: 0 };
  const handoff = require('../src/services/handoffService');
  const payment = require('../src/services/paymentService');
  const ms = require('../src/services/milestonePaymentService');
  const state = { lead: { retainerSigned: '2026-10-15', ...lead } };
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, ...state.lead })),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.writes.push({ f, o }); Object.assign(state.lead, f); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.body || v.b); return {}; }),
    stub(handoff, 'onRetainerSigned', async () => { calls.handoff++; return 'CM'; }),
    stub(ms, 'sendMilestoneEtransferRequest', async () => { calls.link++; return { sent: true }; }),
    stub(retainer2, 'maybeSendRetainerAgreement', async () => { calls.agreement++; return { status: 'sent' }; }),
    stub(payment, 'maybeMarkRetained', async () => ({})),
  ];
  return { calls, state, done: () => restore.reverse().forEach((x) => x()) };
}

test('Retainer Signed typed on a Not Wanted / Follow-Up / Newsletter lead: no case, no payment link — the date is KEPT as the record and a note says to set Retain', async () => {
  for (const outcome of ['Not Wanted', 'Follow-Up', 'Newsletter', 'Don’t Retain — Ineligible']) {
    const w = signedWorld({ outcome });
    try {
      const r = await retainer2.onRetainerSigned('70');
      assert.deepEqual(r, { status: 'not-retain', outcome });
      assert.deepEqual([w.calls.handoff, w.calls.link], [0, 0], outcome);
      assert.equal(w.calls.writes.length, 1, 'one write: the hold marker — the signed date stays');
      assert.deepEqual(Object.keys(w.calls.writes[0].f), ['retainerCountersign']);
      assert.equal(JSON.parse(w.calls.writes[0].f.retainerCountersign).signedHeld.date, '2026-10-15');
      assert.equal(w.state.lead.retainerSigned, '2026-10-15');
      assert.match(w.calls.notes[0], new RegExp(`Retainer Signed \\(2026-10-15\\) is recorded, but the outcome is “${outcome}”`));
      assert.match(w.calls.notes[0], /set the outcome to Retain: the case then opens with this signed date, and no new agreement is sent/);
      await retainer2.onRetainerSigned('70');             // the webhook again (e.g. a redelivery)
      assert.equal(w.calls.notes.length, 1, 'no repeat note while held for the same date');
      assert.equal(w.calls.writes.length, 1);
    } finally { w.done(); }
  }
});

test('ROUND 2: Retain resumes ONLY a lead the gate held — an old signed lead without a case link gets the normal path (no second case)', async () => {
  const w = signedWorld({ outcome: 'Retain', retainerSigned: '2025-03-01' });   // signed long ago, no marker, no case link
  try {
    await retainer2.onOutcomeRetain('80');
    assert.deepEqual([w.calls.handoff, w.calls.agreement], [0, 1], 'not resumed — the agreement path (which refuses a signed lead) runs as before');
  } finally { w.done(); }
});

test('ROUND 2: a held lead that was marked paid (Retained) still opens its case when Retain is set', async () => {
  const w = signedWorld({ outcome: 'Follow-Up' });
  try {
    await retainer2.onRetainerSigned('81');
    w.state.lead.conversionStatus = 'Retained';           // paid in the meantime → maybeMarkRetained
    w.state.lead.outcome = 'Retain';
    await retainer2.onOutcomeRetain('81');
    assert.equal(w.calls.handoff, 1);
    assert.equal(w.calls.agreement, 0);
  } finally { w.done(); }
});

test('ROUND 2: while held, the payment request waits — even when the fee is typed (the fee webhook) — and goes once Retain opens the case', async () => {
  const w = signedWorld({ outcome: 'Not Wanted', retainerFee: '2000' });
  const ms = require('../src/services/milestonePaymentService');
  const r1 = stub(ms, 'scheduleRows', () => [{ index: 0, totalCents: 226000 }]);
  try {
    await retainer2.onRetainerSigned('82');
    await retainer2.maybeSendRetainerPaymentLink('82', { warnIfSent: true });   // the fee webhook
    assert.equal(w.calls.link, 0, 'no e-transfer request while held');
    w.state.lead.outcome = 'Retain';
    await retainer2.maybeSendRetainerPaymentLink('82', {});
    assert.equal(w.calls.link, 1, 'once Retain, it goes');
  } finally { r1(); w.done(); }
});

test('REVIEW: following the note — setting Retain opens the case with the signed date and sends NO new agreement', async () => {
  const w = signedWorld({ outcome: 'Follow-Up' });
  try {
    await retainer2.onRetainerSigned('72');
    assert.equal(w.calls.handoff, 0);
    w.state.lead.outcome = 'Retain';                       // staff set Retain (in Monday or the portal)
    await retainer2.onOutcomeRetain('72');                  // the outcome webhook
    assert.equal(w.calls.handoff, 1, 'the case opens');
    assert.equal(w.calls.agreement, 0, 'no second agreement to a client who already signed');
  } finally { w.done(); }
  // a lead with no signed date: Retain still sends the agreement as before
  const w2 = signedWorld({ outcome: 'Retain', retainerSigned: '' });
  try {
    await retainer2.onOutcomeRetain('73');
    assert.deepEqual([w2.calls.agreement, w2.calls.handoff], [1, 0]);
  } finally { w2.done(); }
});

test('Retainer Signed still opens the case for Retain, a blank outcome (legacy hand-sent), a real e-signature, a direct-retainer client, a case already open, or Retained', async () => {
  for (const lead of [
    { outcome: 'Retain' },
    { outcome: '' },
    { outcome: 'Not Wanted', retainerCountersign: JSON.stringify({ clientSignedVia: 'documenso', clientEnvelopeId: 'e1' }) },
    { outcome: 'Follow-Up', sourceChannel: 'Direct Retainer' },
    { outcome: 'Follow-Up', clientMasterItemId: '12345' },
    { outcome: 'Newsletter', conversionStatus: 'Retained' },
  ]) {
    const w = signedWorld(lead);
    try {
      const r = await retainer2.onRetainerSigned('71');
      assert.notEqual(r && r.status, 'not-retain', JSON.stringify(lead));
      assert.equal(w.calls.handoff, 1, JSON.stringify(lead));
    } finally { w.done(); }
  }
});

/* ── C ── */

test('re-issue on a lead that is no longer Retain: refused BEFORE anything is voided; the page says why', async () => {
  const deleted = [], writes = [], sends = [];
  const lead = { id: '900', fullName: 'R', email: 'x@x.com', outcome: 'Follow-Up', retainerFee: '3000', retainerSent: '2026-08-14', retainerSigned: '', conversionStatus: 'Qualified',
    retainerCountersign: JSON.stringify({ clientEnvelopeId: 'env-old' }) };
  const restore = [
    stub(leadService, 'getLead', async () => lead),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(mondayApi, 'query', async () => ({})),
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'getEnvelope', async () => ({ status: 'PENDING' })),
    stub(documenso, 'deleteEnvelope', async (id) => { deleted.push(id); }),
    stub(retainer2, 'maybeSendRetainerAgreement', async () => { sends.push(1); return { status: 'sent' }; }),
  ];
  try {
    assert.deepEqual(await retainer2.voidAndReissueRetainer('900'), { status: 'not-retain', outcome: 'Follow-Up' });
    assert.deepEqual([deleted.length, writes.length, sends.length], [0, 0, 0], 'nothing voided, nothing written, nothing sent');
    await assert.rejects(portal.applyAction({ leadId: '900', action: 'reissueRetainer', value: null, staffName: 'X' }),
      (e) => e.badRequest && /Nothing was voided — the outcome is “Follow-Up”.*set the Outcome to Retain on the Lead Board in Monday \(no new agreement is sent — one is already on record\), then re-issue/.test(e.message));
  } finally { restore.reverse().forEach((x) => x()); }
});

test('REVIEW: a "not-retain" from the fresh send AFTER the void is reported as voided-but-not-sent, never "nothing was voided"', async () => {
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, outcome: 'Retain', retainerSent: '2026-08-14', retainerFee: '3000', email: 'x@x.com' })),
    stub(mondayApi, 'query', async () => ({})),
    stub(retainer2, 'voidAndReissueRetainer', async () => ({ status: 'not-retain', reissued: true, voided: true })),
  ];
  try {
    const r = await portal.applyAction({ leadId: '901', action: 'reissueRetainer', value: null, staffName: 'X' });
    assert.match(r.message, /^Old agreement voided; the new send reported "not-retain/);
  } finally { restore.reverse().forEach((x) => x()); }
});

test('ROUND 2: editing a record with the same amount keeps the HST fixed when it was first recorded; a waived record after the agreement went out says so', async () => {
  const writes = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, country: 'India', consultAgreementSent: '2026-10-10', consultPayment: rec({ kind: 'cash', amountCents: 20000, hstCents: 2600 }) })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(JSON.parse(f.consultPayment)); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await portal.applyAction({ leadId: '43', action: 'recordConsultPayment', value: { kind: 'e-transfer', amountCents: 20000, on: '2026-10-14' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.equal(writes[0].hstCents, 2600, 'same amount → the HST fixed at first record survives a later move abroad');
    await portal.applyAction({ leadId: '43', action: 'recordConsultPayment', value: { kind: 'cash', amountCents: 25000, on: '2026-10-14' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.equal(writes[1].hstCents, 0, 'a new amount → the HST from where the client is now (abroad)');
    const r = await portal.applyAction({ leadId: '43', action: 'recordConsultPayment', value: { kind: 'waived' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.match(r.message, /^Recorded — the consultation fee is waived\. The consultation agreement already sent for signature keeps the earlier amount/);
  } finally { restore.reverse().forEach((x) => x()); }
});
