'use strict';

// "Correct amount" (2026-10-13, Sanjeev Kumar 2026-CWP-016): the full $1,130 was
// recorded as paid; the client sent part of it. A named admin corrects the AMOUNT
// of the latest payment — the row becomes part-paid with its balance — and nothing
// else changes: the case stays started, no email, no case write.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const C              = require('../src/services/paymentCorrectService');
const U              = require('../src/services/paymentUndoService');
const ms             = require('../src/services/milestonePaymentService');
const leadService    = require('../src/services/leadService');
const paymentService = require('../src/services/paymentService');
const mail           = require('../src/services/microsoftMailService');
const NA             = require('../src/services/needsAttentionService');

const MILESTONES = JSON.stringify([
  { label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 100000, trigger: 'Retainer Confirmed', locked: true },
  { label: 'Milestone 2 – Before Submission', amountCents: 100000, trigger: 'Internal Review' },
]);
// Sanjeev's row exactly as it reads on the Lead Board (2026-10-13).
const SANJEEV_ROW = { status: 'paid', amountCents: 113000, reference: 'C1AeUbQTRwZy', method: 'e-transfer', requestedAt: '2026-10-13', paidAt: '2026-10-13', marked: { by: 'Asmita', at: '2026-10-13T16:47Z', verified: false } };
const LEAD = (pay, over = {}) => ({ id: '13278417769', fullName: 'Sanjeev Kumar', clientMasterItemId: '13278338146', confirmedCaseType: 'Work permit', retainerFee: '2000', retainerHstRate: '13',
  retainerMilestones: MILESTONES, milestonePayments: JSON.stringify(pay), retainerSigned: '2026-10-13', retainerPaid: '2026-10-13', conversionStatus: 'Retained', retainerCountersign: '{}', ...over });
const CASE = { itemId: '13278338146', paymentStatus: 'Paid', caseRef: '2026-CWP-016', caseStage: 'Document Collection Started', checklistApplied: 'Yes', paymentConfDate: '2026-10-13', archived: false };
const ADMIN = { name: 'Faran', email: 'faran@example.com', verified: true };
const NOW = '2026-10-14T15:04:11.000Z';
const L1 = { a: 56500, d: '2026-10-13', r: 'C1', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' };
const L2 = { a: 30000, d: '2026-10-14', r: 'C2', b: 'Asmita', v: false, t: '2026-10-14T10:00Z' };
const plan = (pay, amount, over = {}, cm = CASE) => C.planAmountCorrection({ lead: LEAD(pay, over), index: 0, cm, claimants: [{ id: '13278417769', name: 'Sanjeev Kumar' }], newAmountCents: amount, actor: ADMIN, now: NOW });

test('Sanjeev: $1,130 recorded as paid, corrected to $565 → part-paid with ONE ledger entry (same date, bank ref, recorder); the request reference back; the case stays started', () => {
  const p = plan({ 0: SANJEEV_ROW }, 56500);
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.deepEqual([p.mode, p.wasCents, p.newSumCents, p.balanceCents], ['full', 113000, 56500, 56500]);
  assert.deepEqual(p.after, {
    status: 'partial', amountCents: 113000, reference: 'TDOT-17769-M1', method: 'e-transfer', requestedAt: '2026-10-13',
    l: [{ a: 56500, d: '2026-10-13', r: 'C1AeUbQTRwZy', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' }],
    fixed: { by: 'Faran', at: '2026-10-14T15:04Z', was: U.entryFingerprint(SANJEEV_ROW), from: 113000, to: 56500 },
  });
  assert.deepEqual(p.willChange, [
    'The payment of 2026-10-13 (ref C1AeUbQTRwZy) is recorded as $565.00 — it was $1,130.00',
    'Milestone 1 – Admin Fee (Non-Refundable) reads “part-paid”: $565.00 of $1,130.00 on file — balance $565.00',
  ]);
  assert.ok(p.willNotChange.includes('The case stays started — Retainer Paid date (2026-10-13), “Retained”, and the case’s Payment Status and stage'));
  assert.ok(p.info.some((x) => x.code === 'BALANCE' && /\$565\.00 balance is collected before submission/.test(x.message)));
  assert.deepEqual(p.expect, { entry: U.entryFingerprint(SANJEEV_ROW), amountCents: 56500 });
  assert.equal(p.confirmText, '2026-CWP-016');
  // what every reader then shows
  const st = ms.milestoneStates(LEAD({ 0: p.after }), '', [])[0];
  assert.deepEqual([st.status, st.paidCents, st.balanceCents, st.settlingIndex, st.reference, st.fixedBy, st.fixedFrom, st.fixedTo], ['partial', 56500, 56500, -1, 'TDOT-17769-M1', 'Faran', 113000, 56500]);
  // and the balance, when it comes, settles it the normal way (not a duplicate: its own bank reference)
  assert.equal(ms.paidCentsOf(p.after, 113000), 56500);
});

test('refused out loud: nothing recorded, the same amount, more than the milestone, a correction that would settle it, Square, a row settled on file, bad amounts, unreadable records, no schedule', () => {
  const code = (pay, amount, over) => { const r = plan(pay, amount, over); return r.ok ? 'OK' : r.refusal.code; };
  assert.equal(code({ 0: { status: 'requested', reference: 'TDOT-17769-M1' } }, 56500), 'NOT_RECORDED');
  assert.equal(code({}, 56500), 'NOT_RECORDED');
  assert.equal(code({ 0: SANJEEV_ROW }, 113000), 'SAME_AMOUNT');
  assert.equal(code({ 0: SANJEEV_ROW }, 113001), 'OVER_TOTAL');
  assert.equal(code({ 0: { status: 'partial', l: [L1] } }, 113000), 'WOULD_SETTLE');
  assert.match(plan({ 0: { status: 'partial', l: [L1] } }, 113000).refusal.message, /record the missing \$565\.00 with “Record balance \/ part-payment” instead/);
  assert.equal(code({ 0: { status: 'partial', l: [L1, L2] } }, 70000), 'OVER_TOTAL');
  assert.equal(code({ 0: { ...SANJEEV_ROW, txnId: 'SQ1' } }, 56500), 'SQUARE_PAYMENT');
  assert.equal(code({ 0: SANJEEV_ROW }, 56500, { squareRetainerTxnId: 'SQ9' }), 'SQUARE_PAYMENT');
  assert.equal(code({ 0: { status: 'paid', paidAt: '2026-10-14', marked: { by: 'G', at: '2026-10-14T10:00Z' }, l: [L1] } }, 30000), 'NOT_CORRECTABLE', 'settled on money on file ("Mark settled")');
  for (const bad of [0, -5, 12.5, 'x', 20000001]) assert.equal(code({ 0: SANJEEV_ROW }, bad), 'BAD_AMOUNT', String(bad));
  assert.equal(C.planAmountCorrection({ lead: { id: '1', milestonePayments: '{"0":{"status":"paid"' }, index: 0, newAmountCents: 1 }).refusal.code, 'PAYMENTS_UNREADABLE');
  assert.equal(code({ 0: SANJEEV_ROW }, 56500, { retainerMilestones: '', retainerFee: '' }), 'NO_SCHEDULE');
});

test('a part-paid row: the LAST part-payment is corrected (the earlier ones and the request reference stay); a row settled by parts goes back to part-paid with its corrected settling payment', () => {
  const p = plan({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-17769-M1', requestedAt: '2026-10-01', l: [L1, L2] } }, 20000);
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.deepEqual(p.after.l, [L1, { ...L2, a: 20000 }]);
  assert.deepEqual([p.after.status, p.after.reference, p.newSumCents, p.balanceCents, p.wasCents], ['partial', 'TDOT-17769-M1', 76500, 36500, 30000]);
  const settled = { status: 'paid', paidAt: '2026-10-14', method: 'e-transfer', reference: 'C2', requestedAt: '2026-10-01', marked: { by: 'Gauri Berde', at: L2.t, verified: true }, l: [L1, { ...L2, a: 56500 }] };
  const p2 = plan({ 0: settled }, 30000);
  assert.equal(p2.ok, true, JSON.stringify(p2.refusal));
  assert.deepEqual([p2.mode, p2.after.status, p2.after.paidAt, p2.after.marked, p2.after.reference], ['last', 'partial', undefined, undefined, 'TDOT-17769-M1']);
  assert.deepEqual(p2.after.l, [L1, { ...L2, a: 30000 }]);
  // milestone 2 (not the retainer): no "case stays started" line
  const p3 = C.planAmountCorrection({ lead: LEAD({ 1: { ...SANJEEV_ROW } }), index: 1, cm: CASE, claimants: [], newAmountCents: 50000, actor: ADMIN, now: NOW });
  assert.equal(p3.ok, true, JSON.stringify(p3.refusal));
  assert.ok(!p3.willNotChange.some((x) => /case stays started/.test(x)));
  assert.ok(p3.info.some((x) => /stays on this milestone until it is recorded/.test(x.message)));
});

test('the column cap is respected; a shared case and a missing case warn', () => {
  const p = C.planAmountCorrection({ lead: LEAD({ 0: SANJEEV_ROW }), index: 0, cm: null, cmMissing: true, claimants: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }], newAmountCents: 56500, actor: ADMIN, now: NOW });
  assert.ok(p.warnings.some((x) => x.code === 'SHARED_CASE') && p.warnings.some((x) => x.code === 'CASE_MISSING'));
  assert.equal(p.confirmText, 'LEAD-13278417769', 'a shared case names the exact record');
  const big = {}; for (let i = 0; i < 6; i++) big[i] = { status: 'paid', paidAt: '2026-10-13', reference: 'X'.repeat(120), marked: { by: 'Y'.repeat(60), at: '2026-10-13T16:47Z' }, amountCents: 113000, requestedAt: '2026-10-01', method: 'e-transfer', note: 'Z'.repeat(150) };
  assert.equal(C.planAmountCorrection({ lead: LEAD(big), index: 0, newAmountCents: 56500, actor: ADMIN, now: NOW }).refusal.code, 'PAYMENTS_TOO_LARGE');
});

/* ── execute ── */
function harness({ pay = { 0: SANJEEV_ROW }, over = {}, cm = CASE, commitLands = true, commitThrows = null, readBackNever = false } = {}) {
  const store = { lead: LEAD(pay, over) };
  const calls = [];
  const real = { ...U.io }, realCommit = C.io.commit;
  const trap = (name) => async () => { throw new Error(`FORBIDDEN: ${name} was called`); };
  const traps = [[paymentService, ['recordRetainerPaid', 'maybeMarkRetained', 'advanceCaseToPaid']], [ms, ['markMilestonePaid', 'patchPayment', 'sendMilestoneEtransferRequest']], [mail, ['sendEmail']]];
  const restore = [];
  for (const [mod, keys] of traps) for (const k of keys) { const o = mod[k]; mod[k] = trap(k); restore.push(() => { mod[k] = o; }); }
  U._resetFlagThrottle();
  Object.assign(U.io, {
    getLead: async () => ({ ...store.lead }), readCase: async () => (cm ? { ...cm } : null),
    writeLeadFields: async (id, f) => { calls.push(['writeLeadFields', f]); },
    postNote: async (item, body) => { calls.push(['postNote', item, body]); }, notify: async (id) => { calls.push(['notify', id]); },
    resolveUserId: async (e) => ({ 'admin2@example.com': '222' })[e] || null, consultantFor: () => null, adminEmails: () => ['faran@example.com', 'admin2@example.com'], invalidateQueues: () => { calls.push(['invalidate']); },
    withLeadLockOrSkip: async (k, w, f) => { calls.push(['lock', k]); return f(); }, isLeadItem: async () => true, findClaimants: async () => [{ id: store.lead.id, name: store.lead.fullName }], caseAssignees: async () => ({ personIds: [], teamIds: [] }),
    readSquareOrder: async () => ({ paid: false }), now: () => 1000, nowIso: () => NOW, sleep: async () => {},
  });
  C.io.commit = async (p) => {
    calls.push(['commit', p.index]);
    if (commitThrows) throw commitThrows;
    if (commitLands && !readBackNever) { const pay2 = ms.readPayments(store.lead).pay; pay2[p.index] = p.after; store.lead.milestonePayments = JSON.stringify(pay2); }
  };
  return { store, calls, restore: () => { Object.assign(U.io, real); C.io.commit = realCommit; restore.forEach((f) => f()); U._resetFlagThrottle(); } };
}
const request = async (h, over = {}) => {
  const pv = await C.previewAmountCorrection({ leadId: '13278417769', index: 0, amountCents: 56500, actor: ADMIN });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(pv.plan.ok, true, JSON.stringify(pv.plan.refusal));
  assert.equal(pv.plan.paymentsText, undefined, 'the preview never carries the raw column');
  return { leadId: '13278417769', index: 0, amountCents: 56500, confirmText: pv.plan.confirmText, reason: 'The client sent $565, not the full amount', expect: pv.plan.expect, actor: ADMIN, ...over };
};

test('execute: one commit under the lead lock, notes on the lead and the case, admins alerted; nothing that pays, starts, emails or writes a lead field; a retry reads "already"', async () => {
  const h = harness();
  try {
    const req = await request(h);
    const r = await C.executeAmountCorrection(req);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.message, 'Corrected. Milestone 1 – Admin Fee (Non-Refundable) now reads “part-paid”: $565.00 of $1,130.00 — balance $565.00. The case stays started — collect the balance before submission.');
    assert.deepEqual(r.corrected, { index: 0, from: 113000, to: 56500, balanceCents: 56500 });
    assert.equal(h.calls.filter((c) => c[0] === 'commit').length, 1);
    assert.equal(h.calls.filter((c) => c[0] === 'writeLeadFields').length, 0, 'only the payments column changes');
    const notes = h.calls.filter((c) => c[0] === 'postNote');
    assert.deepEqual(notes.map((n) => n[1]), ['13278417769', '13278338146']);
    assert.match(notes[0][2], /^✏️ <b>Payment amount corrected<\/b> — Milestone 1 – Admin Fee \(Non-Refundable\): the payment of 2026-10-13 \(ref C1AeUbQTRwZy\) is now recorded as <b>\$565\.00<\/b> \(it was \$1,130\.00\)\./);
    assert.match(notes[0][2], /the case stays started \(Retainer Paid date, “Retained”, Payment Status and stage\)/);
    assert.match(notes[0][2], /Collect the balance before submission\./);
    assert.deepEqual(h.calls.filter((c) => c[0] === 'notify').map((c) => c[1]), ['222'], 'the other admin (not the actor)');
    // the Summary never reads this note as a payment problem
    const plain = notes[0][2].replace(/<[^>]+>/g, '');
    for (const [name, re] of Object.entries(NA.NOTE)) if (name !== 'handled') assert.ok(!re.test(plain), `must not read as "${name}"`);
    assert.equal(NA.newestPaymentNote(NA.caseNotes([{ id: 'y', created_at: NOW, text_body: plain }])), null);
    // retry after a lost response
    const again = await C.executeAmountCorrection(req);
    assert.deepEqual([again.ok, again.already], [true, true], JSON.stringify(again));
    assert.equal(h.calls.filter((c) => c[0] === 'commit').length, 1, 'no second write');
  } finally { h.restore(); }
});

test('execute refuses: a changed row (stale dialog), a wrong confirmation, an out-of-date request, a write Monday never confirms', async () => {
  let h = harness();
  try {
    const req = await request(h);
    h.store.lead.milestonePayments = JSON.stringify({ 0: { ...SANJEEV_ROW, reference: 'OTHER' } });
    const r = await C.executeAmountCorrection(req);
    assert.deepEqual([r.ok, r.code], [false, 'CHANGED_SINCE_PREVIEW']);
    assert.equal(h.calls.filter((c) => c[0] === 'commit').length, 0);
  } finally { h.restore(); }
  h = harness();
  try {
    const req = await request(h);
    assert.equal((await C.executeAmountCorrection({ ...req, confirmText: 'nope' })).code, 'CONFIRM_MISMATCH');
    assert.equal((await C.executeAmountCorrection({ ...req, amountCents: 50000 })).code, 'BAD_REQUEST', 'the amount must be the previewed one');
    assert.equal((await C.executeAmountCorrection({ ...req, reason: 'short' })).code, 'BAD_REQUEST');
    assert.equal((await C.executeAmountCorrection({ ...req, actor: { name: 'K' } })).code, 'BAD_REQUEST', 'a named admin');
    assert.equal(h.calls.filter((c) => c[0] === 'commit').length, 0);
  } finally { h.restore(); }
  h = harness({ readBackNever: true });
  try {
    const req = await request(h);
    const r = await C.executeAmountCorrection(req);
    assert.deepEqual([r.ok, r.code], [false, 'NOT_CONFIRMED']);
    assert.match(r.error, /^Monday didn’t confirm the change in time\. The note with the reason is on the client’s record, and the other admins were alerted\. Reload the page and check the payment row before doing anything else\.$/);
    // REVIEW: a correction Monday may have taken is never left with no reason on record
    const notes = h.calls.filter((c) => c[0] === 'postNote');
    assert.equal(notes.length, 2);
    for (const n of notes) assert.match(n[2], /⚠️ <b>Monday did not confirm this change in time<\/b> — an admin must check the payment row now\. If it still shows the old amount, the correction did not land\./);
    assert.ok(h.calls.some((c) => c[0] === 'notify'));
  } finally { h.restore(); }
});

test('REVIEW: a lost response (a transport error with a code) is read back — landed → recorded and alerted as a success; not landed → "nothing was changed", no record', async () => {
  const axiosLike = (code) => Object.assign(new Error('timeout of 30000ms exceeded'), { code });
  let h = harness({ commitThrows: null });
  const realCommit = C.io.commit;
  C.io.commit = async (p) => { await realCommitInto(h, p); throw axiosLike('ECONNABORTED'); };
  try {
    const r = await C.executeAmountCorrection(await request(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(h.calls.filter((c) => c[0] === 'postNote').length, 2);
    assert.ok(!h.calls.some((c) => c[0] === 'postNote' && /did not confirm/.test(c[2])));
  } finally { C.io.commit = realCommit; h.restore(); }
  h = harness();
  C.io.commit = async () => { throw axiosLike('ERR_BAD_RESPONSE'); };
  try {
    const r = await C.executeAmountCorrection(await request(h));
    assert.deepEqual([r.ok, r.code], [false, 'COMMIT_FAILED']);
    assert.match(r.error, /nothing was changed/);
    assert.equal(h.calls.filter((c) => c[0] === 'postNote').length, 0);
  } finally { C.io.commit = realCommit; h.restore(); }
});
function realCommitInto(h, p) { const pay = ms.readPayments(h.store.lead).pay; pay[p.index] = p.after; h.store.lead.milestonePayments = JSON.stringify(pay); }

test('REVIEW: a milestone-1 case HELD for a signature is never called "started"; "Retained" only when it reads Retained; a Square link Square reports PAID is refused, an unchecked one warns; lowering a payment that still covers the milestone points to Mark settled', () => {
  const held = C.planAmountCorrection({ lead: LEAD({ 0: SANJEEV_ROW }, { retainerSigned: '', conversionStatus: '' }), index: 0, cm: { ...CASE, paymentStatus: 'Already Sent' }, claimants: [], newAmountCents: 56500, actor: ADMIN, now: NOW });
  assert.equal(held.ok, true, JSON.stringify(held.refusal));
  assert.equal(held.caseState, 'held');
  assert.ok(held.willNotChange.includes('The Retainer Paid date (2026-10-13) — the case still starts on the money on file once the client signature is in'));
  assert.ok(!held.willNotChange.some((x) => /stays started|“Retained”/.test(x)), 'not started, not Retained (“Retained by” is a different line)');
  const notRetained = plan({ 0: SANJEEV_ROW }, 56500, { conversionStatus: 'Retained — Awaiting Payment' });
  assert.ok(notRetained.willNotChange.some((x) => /^The case stays started — Retainer Paid date \(2026-10-13\), and the case’s Payment Status and stage$/.test(x)));
  const sq = C.planAmountCorrection({ lead: LEAD({ 0: SANJEEV_ROW }, { squareRetainerOrderId: 'ORD-1' }), index: 0, cm: CASE, claimants: [], squareOrder: { paid: true }, newAmountCents: 56500, actor: ADMIN, now: NOW });
  assert.equal(sq.refusal.code, 'SQUARE_PAYMENT');
  const unchecked = C.planAmountCorrection({ lead: LEAD({ 0: SANJEEV_ROW }, { squareRetainerOrderId: 'ORD-1' }), index: 0, cm: CASE, claimants: [], squareOrder: null, newAmountCents: 56500, actor: ADMIN, now: NOW });
  assert.ok(unchecked.ok && unchecked.warnings.some((x) => x.code === 'SQUARE_LINK_EXISTS'));
  const covered = { 0: { status: 'partial', l: [{ ...L1, a: 60000 }, { ...L2, a: 63000 }] } };
  for (const n of [53000, 55000]) {
    const r = plan(covered, n);
    assert.equal(r.refusal.code, 'COVERED', String(n));
    assert.match(r.refusal.message, /cover this milestone \(\$1,130\.00\) — nothing would be owed\. Nothing was changed\. Use “Mark settled”/);
  }
  assert.ok(!/-\$/.test(plan(covered, 53000).refusal.message), 'never a negative amount');
  assert.match(plan({ 0: { status: 'partial', l: [L1, L2] } }, 56500).refusal.message, /record the missing \$265\.00/);
});

test('REVIEW: the undo reads back after a transport error too — a reversal that landed is recorded, not reported as "nothing was changed"', async () => {
  const lead = LEAD({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-17769-M1', requestedAt: '2026-10-01', l: [L1, L2] } });
  const store = { lead: { ...lead } };
  const calls = [];
  const real = { ...U.io };
  U._resetFlagThrottle();
  Object.assign(U.io, {
    getLead: async () => ({ ...store.lead }), readCase: async () => ({ ...CASE }),
    commit: async (p) => { const pay = ms.readPayments(store.lead).pay; pay[p.index] = p.after; store.lead.milestonePayments = JSON.stringify(pay); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
    writeLeadFields: async (id, f) => { calls.push(['writeLeadFields', f]); }, postNote: async (item, body) => { calls.push(['postNote', item, body]); }, notify: async () => {},
    resolveUserId: async () => null, consultantFor: () => null, adminEmails: () => [], invalidateQueues: () => {},
    withLeadLockOrSkip: async (k, w, f) => f(), isLeadItem: async () => true, findClaimants: async () => [{ id: lead.id, name: lead.fullName }], caseAssignees: async () => ({ personIds: [], teamIds: [] }),
    readSquareOrder: async () => ({ paid: false }), now: () => 1000, nowIso: () => NOW, sleep: async () => {},
  });
  try {
    const pv = await U.previewMilestonePaidReversal({ leadId: lead.id, index: 0, actor: ADMIN });
    const res = await U.executeMilestonePaidReversal({ leadId: lead.id, index: 0, confirmText: pv.plan.confirmText, reason: 'The second e-transfer was from another client', expect: pv.plan.expect, actor: ADMIN });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(calls.some((c) => c[0] === 'postNote' && /Part-payment record removed|Payment record removed/.test(c[2])));
  } finally { Object.assign(U.io, real); U._resetFlagThrottle(); }
});

test('the real write: ONE lead mutation carrying only the payments column; compare-and-swap refuses a row that changed', async () => {
  const writes = [];
  let stored = JSON.stringify({ 0: SANJEEV_ROW });
  const origGet = leadService.getLead, origUpd = leadService.updateLead;
  leadService.getLead = async () => LEAD(JSON.parse(stored));
  leadService.updateLead = async (id, f) => { writes.push(f); stored = f.milestonePayments; };
  try {
    const p = plan({ 0: SANJEEV_ROW }, 56500);
    await C.commitCorrection(p);
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0]), ['milestonePayments']);
    assert.deepEqual(JSON.parse(writes[0].milestonePayments)[0], p.after);
    await assert.rejects(C.commitCorrection(p), (e) => e.code === 'CHANGED_SINCE_PREVIEW');
    assert.equal(writes.length, 1);
  } finally { leadService.getLead = origGet; leadService.updateLead = origUpd; }
});

test('after a correction on a started case, Undo of the only part-payment is still refused (it would stop the case) — the correction is the way to fix an amount', () => {
  const p = plan({ 0: SANJEEV_ROW }, 56500);
  const u = U.planMilestonePaidReversal({ lead: LEAD({ 0: p.after }), index: 0, cm: CASE, actor: ADMIN, now: NOW });
  assert.equal(u.ok, false);
  assert.equal(u.refusal.code, 'ONBOARDING_STARTED');
  // and the undo dialog opened BEFORE the correction no longer matches the row
  assert.notEqual(U.entryFingerprint(p.after), U.entryFingerprint(SANJEEV_ROW));
});

test('routes and page: admin-only preview + execute; "Correct amount…" only for admins on paid / part-paid rows; the dialog follows the page-script rules; the tooltip says who corrected it', () => {
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  for (const route of ["app.get('/admin/retainer/:leadId/milestone/:index/correct-preview', async (req, res) => {\n  const actor = resolveNamedAdminOrReject(req, res);",
    "app.post('/admin/retainer/:leadId/milestone/:index/correct', express.json(), async (req, res) => {\n  const actor = resolveNamedAdminOrReject(req, res);"]) assert.ok(server.includes(route), route.slice(0, 60));
  const js = require('../src/routes/adminShared').PAYMENT_UI_JS;
  assert.ok(!/[`\\]|\$\{/.test(js), 'plain template text');
  new Function(js);
  const fn = new Function(js + '; TDOT_PAY.viewer = { canUndo: true }; var a = tdotPayRowActions({ index: 0, status: "paid" }, {}, "b"); TDOT_PAY.viewer = { canUndo: false, signedIn: true }; var b = tdotPayRowActions({ index: 0, status: "paid" }, {}, "b"); TDOT_PAY.viewer = { canUndo: true }; var c = tdotPayRowActions({ index: 0, status: "requested" }, {}, "b"); return { a: a, b: b, c: c, audit: tdotPayAuditText };')();
  assert.ok(fn.a.includes('data-pay-fixamt="0"') && fn.a.includes('Correct amount…'));
  assert.ok(!fn.b.includes('data-pay-fixamt'), 'not for staff who cannot undo');
  assert.ok(!fn.c.includes('data-pay-fixamt'), 'nothing recorded → nothing to correct');
  assert.match(fn.audit({ status: 'partial', fixedBy: 'Faran', fixedFrom: 113000, fixedTo: 56500, payments: [] }), /^Amount corrected by Faran: \$1130\.00 → \$565\.00/);
  assert.ok(js.includes("'/correct-preview?amountCents=' + encodeURIComponent(cents)"));
  assert.ok(js.includes("body: JSON.stringify({ amountCents: p.newAmountCents, confirmText: conf.value.trim(), reason: why.value.trim(), expect: p.expect })"));
});

test('REVIEW 2: not confirmed AND the notes could not be posted — the message says so (never "the record was posted"); the alert says NOT CONFIRMED', async () => {
  const h = harness({ readBackNever: true });
  const alerts = [];
  U.io.postNote = async () => { throw new Error('Monday 503'); };
  U.io.notify = async (id, text) => { alerts.push(text); };
  try {
    const r = await C.executeAmountCorrection(await request(h));
    assert.deepEqual([r.ok, r.code], [false, 'NOT_CONFIRMED']);
    assert.match(r.error, /The note could NOT be posted on Monday either — add a note by hand with the reason, and tell the other admins\./);
    assert.ok(!/is on the client’s record/.test(r.error));
    assert.ok(alerts.length && alerts.every((x) => /^NOT CONFIRMED — check the payment row: Payment amount corrected/.test(x)));
  } finally { h.restore(); }
});

test('the named-admin gate speaks for both Undo and Correct amount ("change a payment record")', () => {
  const { namedAdminCheck } = require('../src/utils/staffIdentity');
  const none = namedAdminCheck(null, () => true);
  assert.deepEqual([none.status, none.error], [401, 'Sign in with Monday to change a payment record — the shared admin key doesn’t say who you are.']);
  const notAdmin = namedAdminCheck({ email: 'k@example.com', name: 'K' }, () => false);
  assert.deepEqual([notAdmin.status, notAdmin.error], [403, 'Only admins can change a payment record. Use “Flag as wrong” to alert them.']);
  assert.equal(namedAdminCheck({ email: 'f@example.com', name: 'Faran' }, () => true).ok, true);
});
