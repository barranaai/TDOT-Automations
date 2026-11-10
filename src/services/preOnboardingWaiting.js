'use strict';

/**
 * "Waiting for" on the Client Master page (Assigning tab, Pre-Onboarding rows) — 2026-11-10.
 *
 * READ-ONLY and a thin wrapper: the one rule for "may this case start" is
 * caseGateService.signatureGateForLead (client signature → RCIC countersignature → payment). This
 * file only asks that gate, per linked lead, and turns its `missing` list into display codes. It
 * decides nothing of its own, writes nothing, and never reads Monday: the case rows come from the
 * dashboard copy and the leads from leadSnapshot.peek() (the copy as it is — never a wait).
 *
 * Codes, in the order of the process:
 *   'not-sent'    the app has NO RECORD of an agreement (a display split of the gate's 'client
 *                 signature': no signed date, no sent date AND no payment of any kind). The app only
 *                 knows what it sent itself — the words on screen say "no record", never "not sent".
 *                 Any payment (board Paid, or a paid date) means an agreement exists somewhere (sent
 *                 by hand, signed on paper) → 'client-sign', whose words carry the paper note.
 *   'client-sign' the client's signature
 *   'countersign' our (RCIC) countersignature
 *   'payment'     the payment
 *   'ready'       the gate is met but the case is still Pre-Onboarding (flagged, never fixed here)
 *   'unclear'     the data cannot say — why: 'no-lead' | 'leads-disagree' | 'pro-bono' |
 *                 'paid-conflict' (the client's record is signed and paid, but staff set the board to
 *                 Not Paid / Working on it by hand — retainerStatusReconciler's 'conflict': the app
 *                 never argues with that and never starts the case, so it is NOT 'ready')
 *   'unchecked'   the lead copy is not there yet ("Not checked yet")
 *
 * What goes to the browser per row: { code, also: [codes], partPaid: boolean, why? } — nothing else.
 */

const gate = require('./caseGateService');
const { GATE } = require('./leadSnapshot');
const { PRE_ONBOARDING_INDEX } = require('./clientMasterViews');
// The board values only a person sets to say "not paid" — the reconciler's own list (one rule).
const { STAFF_UNPAID_LABELS } = require('./retainerStatusReconciler');

const STEP_ORDER = ['not-sent', 'client-sign', 'countersign', 'payment'];
const CODES = [...STEP_ORDER, 'ready', 'unclear', 'unchecked'];
const s = (v) => String(v == null ? '' : v).trim();

/**
 * The gate's input for one lead. A snapshot lead carries the reduced facts under GATE (the raw
 * countersign / payments records are never kept on the copy); a lead read whole (leadService)
 * carries the raw columns — both give the gate exactly what it reads.
 */
function gateInput(lead) {
  const f = lead && lead[GATE];
  if (!f) return { lead: lead || {}, m1Partial: m1PartialOfRaw(lead) };
  const rc = { clientSignedVia: f.clientSignedVia || '', envelopeId: f.hasEnvelope ? '1' : '', signedAt: f.signedAt ? '1' : '' };
  return { lead: { retainerSigned: lead.retainerSigned, retainerPaid: lead.retainerPaid, retainerSent: lead.retainerSent, retainerCountersign: JSON.stringify(rc) }, m1Partial: f.m1Partial };
}
/** Milestone 1 part-paid from a raw payments record: true / false, null when it cannot be read. */
function m1PartialOfRaw(lead) {
  const { pay, unreadable } = require('./milestonePaymentService').readPayments(lead || {});
  if (unreadable) return null;
  return !!(pay && pay['0'] && pay['0'].status === 'partial');
}

/** The unmet steps of ONE lead, in process order ([] = the gate is met). */
function stepsOf(lead, boardPaid) {
  const { lead: l } = gateInput(lead);
  // The board's "Paid" IS the payment (as onboardingResumeService does) — never "Payment" for it.
  const g = gate.signatureGateForLead({ ...l, retainerPaid: s(l.retainerPaid) || (boardPaid ? 'board' : '') });
  const steps = [];
  // "No record of an agreement" only when there is no trace at all: any payment (the board's Paid
  // or a paid date) means an agreement went out some other way (by hand, on paper) — never guessed
  // to be "not sent".
  const noTrace = !s(l.retainerSigned) && !s(l.retainerSent) && !s(l.retainerPaid) && !boardPaid;
  if (g.missing.includes('client signature')) steps.push(noTrace ? 'not-sent' : 'client-sign');
  if (g.missing.includes('RCIC countersignature')) steps.push('countersign');
  if (g.missing.includes('payment')) steps.push('payment');
  return steps;
}

/**
 * PURE. What one Pre-Onboarding case is waiting for.
 * @param {{ cmPayment?: string }} row   the case's Client Master Payment Status text ('' when empty)
 * @param {object[]} claimants           every lead whose "Client Master item" is this case
 * @returns {{ code: string, also: string[], partPaid: boolean, why?: string }}
 */
function waitingFor(row, claimants) {
  const cmPayment = s(row && row.cmPayment);
  const boardPaid = cmPayment === 'Paid';
  const list = (claimants || []).filter(Boolean);
  if (!list.length) return { code: 'unclear', also: [], partPaid: false, why: 'no-lead' };

  const each = list.map((l) => stepsOf(l, boardPaid));
  // A first part-payment exists (never a claim from a record that cannot be read). It is only ever
  // extra words: a milestone-1 part-payment stamps the paid date, so the gate's payment is met.
  const partPaid = list.some((l) => gateInput(l).m1Partial === true);

  // Two or more leads on one case: one fully executed claimant is enough (the rule of the Paid and
  // Case Stage webhooks and the held-onboarding resume) — never "the first lead found".
  if (each.some((st) => st.length === 0)) {
    // Signed and paid on the client's record, but a person set the board to "Not Paid" / "Working on
    // it" (a bounced e-transfer, a refund, a corrected misclick). The reconciler calls this pair a
    // conflict and never starts the case — so it is not "should have started".
    if (STAFF_UNPAID_LABELS.includes(cmPayment.toLowerCase())) return { code: 'unclear', also: [], partPaid, why: 'paid-conflict' };
    return { code: 'ready', also: [], partPaid };
  }

  const first = each[0][0];
  if (!each.every((st) => st[0] === first)) return { code: 'unclear', also: [], partPaid, why: 'leads-disagree' };
  const rest = STEP_ORDER.filter((c) => c !== first && each.some((st) => st.includes(c)));
  // Pro Bono on the board: the gate still wants a payment on the client's record, which may never
  // come — the app cannot say what this case is waiting for.
  if (cmPayment === 'Pro Bono' && (first === 'payment' || rest.includes('payment'))) return { code: 'unclear', also: [], partPaid, why: 'pro-bono' };
  return { code: first, also: rest, partPaid };
}

/** One Map(case item id → leads[]) per snapshot copy (the leads array is the copy's identity). */
const _byCase = new WeakMap();
function claimantsByCase(leads) {
  let m = _byCase.get(leads);
  if (!m) {
    m = new Map();
    for (const l of leads) {
      const id = s(l && l.clientMasterItemId);   // free text on the board: trimmed, keyed as a string
      if (!id) continue;                          // a held or case-deleted record has no link
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(l);
    }
    _byCase.set(leads, m);
  }
  return m;
}

/**
 * Sets `waiting` on the Pre-Onboarding rows ONLY (every other stage: nothing) and takes the board
 * Payment Status off every row (it was read for this alone). Synchronous — `snap` is
 * leadSnapshot.peek(): null = no lead copy yet → every Pre-Onboarding row is 'unchecked'.
 * @returns {number|null} when the lead copy was read (ms), or null
 */
function mark(cases, snap) {
  const leads = snap && Array.isArray(snap.leads) ? snap.leads : null;
  const byCase = leads ? claimantsByCase(leads) : null;
  for (const c of cases || []) {
    const cmPayment = c.paymentStatus;
    delete c.paymentStatus;
    if (c.stageIdx !== PRE_ONBOARDING_INDEX) continue;
    c.waiting = byCase
      ? waitingFor({ cmPayment }, byCase.get(s(c.id)) || [])
      : { code: 'unchecked', also: [], partPaid: false };
  }
  return leads ? (snap.at || null) : null;
}

module.exports = { waitingFor, mark, claimantsByCase, stepsOf, STEP_ORDER, CODES };
