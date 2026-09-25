'use strict';

// "Undo mark paid" — the pure planner (incident 2026-09-22, case 2026-OINP-059).
//
// Milestone 1 was marked paid on the wrong client. That stamped the lead's
// Retainer Paid date; the signing then flipped the lead to "Retained"; and the
// RCIC countersignature was armed to onboard an unpaid client. These tests pin
// every judgement the undo makes: what it restores, what it clears, when it
// refuses, and that — whatever it accepts — nothing can start onboarding
// afterwards (checked with the PRODUCTION gate and sync functions, not copies).

const test   = require('node:test');
const assert = require('node:assert/strict');

const U = require('../src/services/paymentUndoService');
const ms = require('../src/services/milestonePaymentService');
const { signatureGateForLead } = require('../src/services/caseGateService');
const recon = require('../src/services/retainerStatusReconciler');

const D = '2026-09-22';
const MILESTONES = JSON.stringify([
  { label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 87500, trigger: 'Retainer Confirmed', locked: true },
  { label: 'Milestone 2 – Before Submission', amountCents: 150000, trigger: 'Document Collection Started' },
  { label: 'Milestone 3 – Upon ITA', amountCents: 100000, trigger: 'Internal Review' },
]);
const pays = (o) => JSON.stringify(o);
/** The incident, redacted: paid first (never requested), then signed via Documenso, countersign pending. */
const INCIDENT = {
  id: '13108401448', fullName: 'Test Client', clientMasterItemId: '13108384096',
  confirmedCaseType: 'OINP', retainerFee: '4875', retainerHstRate: '13', retainerMilestones: MILESTONES,
  milestonePayments: pays({ 0: { status: 'paid', paidAt: D, method: 'e-transfer', reference: 'C1AdRgrQhzQG' } }),
  retainerSigned: D, retainerPaid: D, conversionStatus: 'Retained',
  retainerCountersign: JSON.stringify({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: '' }),
};
const CASE = { itemId: '13108384096', paymentStatus: 'Already Sent', caseRef: '2026-OINP-059', caseStage: 'Pre-Onboarding', checklistApplied: '', paymentConfDate: '', archived: false };
const ACTOR = { name: 'Faran', email: 'faran@example.com', verified: true };
const plan = (over = {}) => U.planMilestonePaidReversal({ lead: INCIDENT, index: 0, cm: CASE, actor: ACTOR, now: '2026-09-23T15:04:11.000Z', ...over });
const lead = (over) => ({ ...INCIDENT, ...over });

test('THE INCIDENT: the paid row goes back to "not requested", the payment date is cleared, "Retained" is corrected', () => {
  const p = plan();
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.equal(p.mode, 'milestone');
  assert.equal(p.after.status, 'pending', 'it was never requested, so "pending" is the true prior state');
  assert.deepEqual(p.clearKeys, ['retainerPaid']);
  assert.deepEqual(p.conversionStatus, { from: 'Retained', to: 'Retained — Awaiting Payment' });
  assert.equal(p.confirmText, '2026-OINP-059');
  assert.deepEqual(p.expect, { mode: 'milestone', entry: U.entryFingerprint(p.before), retainerPaid: D });
  assert.equal(p.after.undone.by, 'Faran');
  assert.equal(p.after.undone.was, U.entryFingerprint(p.before), 'the marker names the exact record it removed');
  const codes = p.info.map((x) => x.code);
  assert.ok(codes.includes('COUNTERSIGN_ARMED'), 'staff are told the countersignature was the live trigger');
  assert.ok(codes.includes('NEVER_REQUESTED'));
});

test('a row that WAS requested goes back to "requested" with the reference the client was emailed', () => {
  const p = plan({ lead: lead({ milestonePayments: pays({ 0: { status: 'paid', paidAt: D, method: 'e-transfer', reference: 'BANK-99', requestedAt: '2026-09-20', amountCents: 98875 } }) }) });
  assert.equal(p.after.status, 'requested');
  assert.equal(p.after.reference, ms.paymentReference(INCIDENT.id, 0), 'the deterministic TDOT reference, not the bank one typed at mark-paid');
  assert.equal(p.after.requestedAt, '2026-09-20');
  assert.equal(p.after.amountCents, 98875);
  assert.ok(!p.info.some((x) => x.code === 'NEVER_REQUESTED'));
});

test('a legacy Square-era request goes back to "sent"', () => {
  const p = plan({ lead: lead({ milestonePayments: pays({ 0: { status: 'paid', paidAt: D, sentAt: '2026-06-01', orderId: 'o1', url: 'https://x' } }) }) });
  assert.equal(p.after.status, 'sent');
  assert.equal(p.after.sentAt, '2026-06-01');
  assert.equal(p.after.orderId, 'o1');
});

test('a LATER milestone: only its row changes — no payment date, no status, no case check', () => {
  const l = lead({ milestonePayments: pays({ 0: { status: 'paid', paidAt: D }, 2: { status: 'paid', paidAt: D, reference: 'X' } }) });
  const p = plan({ lead: l, index: 2, cm: { ...CASE, paymentStatus: 'Paid', caseStage: 'Internal Review', checklistApplied: 'Yes' } });
  assert.equal(p.ok, true, 'later milestones are normally paid after onboarding — a Paid case is expected, not a refusal');
  assert.deepEqual(p.clearKeys, []);
  assert.equal(p.conversionStatus, null);
  assert.equal(p.isRetainer, false);
  assert.ok(p.warnings.some((w) => w.code === 'OTHER_PAID'), 'milestone 1 is still paid — staff are told');
});

test('refusals: nothing to undo', () => {
  const p = plan({ lead: lead({ milestonePayments: pays({ 0: { status: 'requested', requestedAt: D } }), retainerPaid: '' }) });
  assert.equal(p.ok, false);
  assert.equal(p.refusal.code, 'NOT_PAID');
  assert.equal(plan({ index: 1 }).refusal.code, 'NOT_PAID');
});

test('refusals: a Square PAYMENT (a txn id on the row or the lead) — Square would simply record it again', () => {
  assert.equal(plan({ lead: lead({ milestonePayments: pays({ 0: { status: 'paid', paidAt: D, txnId: 'sq1' } }) }) }).refusal.code, 'SQUARE_PAYMENT');
  assert.equal(plan({ lead: lead({ squareRetainerTxnId: 'sq2' }) }).refusal.code, 'SQUARE_PAYMENT');
  assert.equal(plan({ lead: lead({ squareRetainerTxnId: 'sq2', squareRetainerOrderId: 'ord2' }) }).refusal.code, 'SQUARE_PAYMENT', 'a paid Square order carries both');
});

test('a Square payment LINK (order id, no txn id): what the ORDER says decides — paid refuses, unpaid warns, unchecked warns and says so', () => {
  // Paid first by e-transfer (Mark paid), then the client also paid the link:
  // the webhook skipped "already paid", so no txn id was ever written. Only
  // the order knows — and the sweep would not put it back after 6 hours.
  const paid = plan({ lead: lead({ squareRetainerOrderId: 'ord3' }), squareOrder: { paid: true } });
  assert.equal(paid.ok, false);
  assert.equal(paid.refusal.code, 'SQUARE_PAYMENT');
  assert.match(paid.refusal.message, /Square shows the payment link for this retainer as PAID/);
  assert.equal(paid.refusal.detail.source, 'square-order');
  // the link is open: a warning, not a refusal — the id is stamped when the link is made, before any money
  const open = plan({ lead: lead({ squareRetainerOrderId: 'ord3' }), squareOrder: { paid: false } });
  assert.equal(open.ok, true, JSON.stringify(open));
  const w = open.warnings.find((x) => x.code === 'SQUARE_LINK_EXISTS');
  assert.ok(w, 'warned');
  assert.equal(w.message, 'A Square payment link was issued for this retainer; Square shows no payment on it yet. If the client pays it later, that payment is recorded automatically.');
  assert.doesNotMatch(w.message, /refund/i, 'says what is known — not an instruction to refund a payment nobody has seen');
  // Square could not be checked (null, or the planner was never told): the warning names the failed check and the 6-hour sweep
  for (const squareOrder of [null, undefined]) {
    const unknown = plan({ lead: lead({ squareRetainerOrderId: 'ord3' }), squareOrder });
    assert.equal(unknown.ok, true, JSON.stringify(unknown));
    const u = unknown.warnings.find((x) => x.code === 'SQUARE_LINK_EXISTS');
    assert.equal(u.message, 'A Square payment link was issued for this retainer, and Square could not be checked just now. Look in Square for a completed payment before removing this record — one made in the last 6 hours is put back by the Square sweep; an older one is not.');
  }
  // a later milestone never carried the retainer's link — whatever the order says
  const later = plan({ index: 1, lead: lead({ squareRetainerOrderId: 'ord3', milestonePayments: pays({ 1: { status: 'paid', paidAt: D } }) }), squareOrder: { paid: true } });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.ok(!later.warnings.some((x) => x.code === 'SQUARE_LINK_EXISTS'));
  // and without the order id there is no warning and no refusal, even if a stale order answer is passed
  assert.equal(plan({ squareOrder: { paid: true } }).ok, true);
  assert.ok(!plan().warnings.some((x) => x.code === 'SQUARE_LINK_EXISTS'));
});

test('refusals: the case can’t be read → fail closed for the retainer payment', () => {
  const p = plan({ cm: null, cmReadError: 'timeout' });
  assert.equal(p.refusal.code, 'CASE_UNREADABLE');
  // …but a later milestone never depended on the case
  const l = lead({ milestonePayments: pays({ 1: { status: 'paid', paidAt: D } }) });
  assert.equal(plan({ lead: l, index: 1, cm: null, cmReadError: 'timeout' }).ok, true);
});

test('refusals: onboarding started — the case reads Paid, even if archived', () => {
  const p = plan({ cm: { ...CASE, paymentStatus: 'Paid', checklistApplied: 'Yes', caseStage: 'Document Collection Started' } });
  assert.equal(p.refusal.code, 'ONBOARDING_STARTED');
  assert.ok(p.refusal.detail.signals.length >= 2, 'the refusal names what tripped');
  assert.match(p.refusal.message, /Not Paid/);
  assert.match(p.refusal.message, /Working on it/, 'it says which labels actually hold against the sync');
  assert.equal(plan({ cm: { ...CASE, paymentStatus: 'Paid', archived: true } }).refusal.code, 'ONBOARDING_STARTED');
});

test('a case a human took off Paid ("Not Paid") after onboarding: allowed, with a loud warning', () => {
  const p = plan({ cm: { ...CASE, paymentStatus: 'Not Paid', checklistApplied: 'Yes', caseStage: 'Document Collection Started', paymentConfDate: D } });
  assert.equal(p.ok, true);
  const w = p.warnings.find((x) => x.code === 'ONBOARDING_RAN_EARLIER');
  assert.ok(w, 'warned');
  assert.match(w.message, /doesn’t unsend emails/);
});

test('retainer-date only: the row isn’t paid but the lead carries a payment date (case set to Paid by hand, then back)', () => {
  const l = lead({ milestonePayments: pays({ 0: { status: 'requested', requestedAt: D, reference: 'TDOT-01448-M1' } }) });
  const p = plan({ lead: l, cm: { ...CASE, paymentStatus: 'Not Paid' } });
  assert.equal(p.ok, true);
  assert.equal(p.mode, 'retainer-date');
  assert.equal(p.after.status, 'requested', 'the row keeps its status…');
  assert.equal(p.after.reference, 'TDOT-01448-M1');
  assert.equal(p.after.undone.by, 'Faran', '…and only gains the marker, so the tooltip shows who removed the date');
  assert.ok(!p.willChange.some((x) => /Milestone goes back/.test(x)), 'nothing claims the row changed');
  assert.deepEqual(p.clearKeys, ['retainerPaid']);
  assert.ok(p.info.some((x) => x.code === 'RETAINER_DATE_ONLY'));
  // …but never while the case still reads Paid
  assert.equal(plan({ lead: l, cm: { ...CASE, paymentStatus: 'Paid' } }).refusal.code, 'ONBOARDING_STARTED');
});

test('Conversion Status is derived, never "restored": only a signed lead reading Retained changes', () => {
  assert.equal(plan({ lead: lead({ retainerSigned: '' }) }).conversionStatus, null, 'unsigned: the flip never happened');
  assert.equal(plan({ lead: lead({ conversionStatus: 'Lost' }) }).conversionStatus, null, 'a human’s label is left alone');
  assert.equal(plan({ lead: lead({ conversionStatus: 'Qualified' }) }).conversionStatus, null, 'never set back to Qualified — that reopens the once-only signed gate');
  assert.deepEqual(plan({ lead: lead({ conversionStatus: 'Retained — Paid' }) }).conversionStatus, { from: 'Retained — Paid', to: 'Retained — Awaiting Payment' });
});

test('INVARIANT sweep: for every accepted retainer undo, nothing can start onboarding and the sync has nothing to put back', () => {
  const entries = [
    { status: 'paid', paidAt: D },
    { status: 'paid', paidAt: D, requestedAt: '2026-09-20' },
    { status: 'paid', paidAt: D, sentAt: '2026-06-01' },
  ];
  const signed = ['', D];
  const statuses = ['Retained', 'Retained — Awaiting Payment', 'Qualified'];
  const countersigns = [
    '',
    JSON.stringify({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: '' }),
    JSON.stringify({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: D }),
  ];
  const cases = ['', 'Already Sent', 'Signed (Unpaid)', 'Not Paid', 'Working on it', null];
  let accepted = 0;
  for (const e of entries) for (const sg of signed) for (const cs of statuses) for (const rc of countersigns) for (const cp of cases) {
    const l = lead({ milestonePayments: pays({ 0: e }), retainerSigned: sg, conversionStatus: cs, retainerCountersign: rc });
    const cm = cp === null ? null : { ...CASE, paymentStatus: cp };
    const p = plan({ lead: l, cm, cmMissing: cp === null });
    if (!p.ok) continue;
    accepted++;
    const post = { ...l, milestonePayments: p.paymentsText || l.milestonePayments, retainerPaid: '', ...(p.conversionStatus ? { conversionStatus: p.conversionStatus.to } : {}) };
    assert.equal(signatureGateForLead(post).complete, false, `gate complete after undo: ${JSON.stringify({ e, sg, cs, rc, cp })}`);
    assert.notEqual(recon.deriveCmPaymentStatus(post), 'Paid');
    const drift = recon.classifyDrift(post, cm ? cm.paymentStatus : null);
    assert.ok(!['backstamp-lead', 'conflict'].includes(drift.action), `sync would act: ${drift.action}`);
    assert.ok(!(drift.action === 'upgrade-cm' && drift.to === 'Paid'));
  }
  assert.ok(accepted > 100, `the sweep exercised ${accepted} accepted shapes`);
});

test('warnings: case gone, activation imminent', () => {
  assert.ok(plan({ cm: null, cmMissing: true }).warnings.some((w) => w.code === 'CASE_MISSING'));
  const countersigned = lead({ retainerCountersign: JSON.stringify({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: D }) });
  const p = plan({ lead: countersigned });
  assert.ok(p.warnings.some((w) => w.code === 'ACTIVATION_IMMINENT'), 'the 15-minute sync would have onboarded this client');
});

test('confirmation word: the case ref; otherwise CASE-<id> or LEAD-<id> — never a generic word', () => {
  assert.equal(plan().confirmText, '2026-OINP-059');
  assert.equal(plan({ cm: { ...CASE, caseRef: '' } }).confirmText, 'CASE-13108384096');
  assert.equal(plan({ lead: lead({ clientMasterItemId: '' }), cm: null }).confirmText, 'LEAD-13108401448');
});

test('unreadable or oversized payment records: refused, never written over', () => {
  assert.equal(plan({ lead: lead({ milestonePayments: '{"0":{"status":"paid","paidAt":"2026-09-2' }) }).refusal.code, 'PAYMENTS_UNREADABLE');
  // Removing a huge entry shrinks the record (fine); another row keeping it too large is refused.
  const shrinks = { 0: { status: 'paid', paidAt: D, reference: 'x'.repeat(1800) } };
  assert.equal(plan({ lead: lead({ milestonePayments: pays(shrinks) }) }).ok, true);
  const staysHuge = { 0: { status: 'paid', paidAt: D }, 1: { status: 'requested', reference: 'x'.repeat(1850) } };
  assert.equal(plan({ lead: lead({ milestonePayments: pays(staysHuge) }) }).refusal.code, 'PAYMENTS_TOO_LARGE');
});

test('the fingerprint changes when the same payment is marked again after an undo — a stale replay cannot remove it', () => {
  const first = { status: 'paid', paidAt: D, reference: 'R', marked: { by: 'A', at: '2026-09-22T20:59Z' } };
  const again = { ...first, marked: { by: 'A', at: '2026-09-23T10:00Z' }, undone: { by: 'F', at: '2026-09-23T09:00Z', was: 'x' } };
  assert.notEqual(U.entryFingerprint(first), U.entryFingerprint(again));
  const sameMinute = { ...first, undone: { by: 'F', at: '2026-09-22T21:00Z', was: 'x' } };
  assert.notEqual(U.entryFingerprint(first), U.entryFingerprint(sameMinute), 'even marked again within the same minute');
});

test('the plan never touches the case or "Retained by" — only lead fields', () => {
  const p = plan();
  assert.deepEqual(Object.keys(p).filter((k) => /retainedBy|cmWrite|caseWrite/i.test(k)), []);
  assert.ok(p.willNotChange.some((x) => /Retained by/.test(x)));
  assert.ok(p.willNotChange.some((x) => /No money moves/.test(x)));
});

test('validateUndoRequest: bounds', () => {
  const good = { leadId: '13108401448', index: 0, confirmText: '2026-OINP-059', reason: 'Wrong client — belongs to someone else', expect: { mode: 'milestone', entry: 'abc', retainerPaid: D }, actor: ACTOR };
  assert.equal(U.validateUndoRequest(good), null);
  assert.match(U.validateUndoRequest({ ...good, reason: 'too short' }), /at least 10/);
  assert.match(U.validateUndoRequest({ ...good, index: 21 }), /does not exist/);
  assert.match(U.validateUndoRequest({ ...good, expect: null }), /out of date/);
  assert.match(U.validateUndoRequest({ ...good, actor: { name: 'x' } }), /Sign in with Monday/);
  assert.match(U.validateUndoRequest({ ...good, leadId: 'abc' }), /Unknown client/);
});

test('the INVARIANT guard itself works: if anything upstream ever let an unsafe plan through, it refuses', () => {
  const gate = require('../src/services/caseGateService');
  const orig = gate.signatureGateForLead;
  gate.signatureGateForLead = (l) => ({ ...orig(l), complete: true, missing: [] });   // simulate a future regression upstream
  try {
    const p = plan();
    assert.equal(p.ok, false);
    assert.equal(p.refusal.code, 'INVARIANT');
  } finally { gate.signatureGateForLead = orig; }
});

test('SHARED CASE: two client records claim one case — warned by name, and the confirmation names the exact record', () => {
  const claimants = [{ id: '13108401448', name: 'Test Client' }, { id: '13100000001', name: 'Other Person' }];
  const p = plan({ claimants });
  const w = p.warnings.find((x) => x.code === 'SHARED_CASE');
  assert.ok(w, 'staff are told another record shares the case');
  assert.match(w.message, /Other Person #13100000001/);
  assert.equal(p.confirmText, 'LEAD-13108401448', 'the case ref would not tell the two records apart');
  assert.equal(plan({ claimants: [claimants[0]] }).confirmText, '2026-OINP-059', 'one claimant: the case ref as usual');
  const unknown = plan({ claimants: null });
  assert.ok(unknown.info.some((x) => x.code === 'CLAIMANTS_UNKNOWN'), 'a failed lookup is said, not hidden');
  assert.equal(unknown.confirmText, '2026-OINP-059');
});

test('NEVER_REQUESTED: any milestone restored to "not requested" says so — not only the first', () => {
  const l = lead({ milestonePayments: pays({ 0: { status: 'paid', paidAt: D }, 1: { status: 'paid', paidAt: D, reference: 'X' } }) });
  const p = plan({ lead: l, index: 1 });
  assert.equal(p.after.status, 'pending');
  assert.ok(p.info.some((x) => x.code === 'NEVER_REQUESTED'));
});

test('names are one line in the marker — a typed newline can’t fake a second tooltip line', () => {
  const l = lead({ milestonePayments: pays({ 0: { status: 'paid', paidAt: D, marked: { by: 'Kamal\nMarked paid by Faran', at: '2026-09-22T10:00Z', verified: false } } }) });
  const p = plan({ lead: l, actor: { name: 'Faran\n X', email: 'f@x.com' } });
  assert.equal(p.after.undone.by, 'Faran X');
  assert.equal(p.after.undone.prevBy, 'Kamal Marked paid by Faran');
});

test('refusals point at "an admin", never at one person by name (the same wording as Mark paid)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/paymentUndoService'), 'utf8');
  assert.doesNotMatch(src, /Ask Faran|ask Faran/);
  assert.match(plan({ lead: lead({ milestonePayments: '{"0":{"status":"paid","paidAt":"2026-09-2' }) }).refusal.message, /Ask an admin to check the lead’s/);
});
