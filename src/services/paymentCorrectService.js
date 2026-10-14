'use strict';

/**
 * Correct amount — an admin fixes the AMOUNT recorded for a milestone's latest
 * payment, without undoing anything else (2026-10-13, Sanjeev Kumar 2026-CWP-016:
 * the full $1,130 was recorded as paid; the client sent part of it, and his case
 * had already started — right under the team rule that a part-payment on
 * milestone 1 starts the case).
 *
 * Undo is for "this payment never happened"; this is for "it happened, for a
 * different amount". Only the payments column changes: the Retainer Paid date,
 * "Retained", the case's Payment Status and stage, signatures and anything already
 * sent stay as they are. It never emails the client and never writes the case.
 *
 * Rules:
 *  - named admins only (the route), preview first, a reason, a typed confirmation;
 *  - the LATEST payment on the row is corrected: a plain paid row (no ledger) is one
 *    payment of the full amount; a part-paid row, or one settled by parts, its last
 *    ledger entry;
 *  - the corrected total must stay BELOW the milestone — the row then reads
 *    'part-paid' with its balance. Reaching or passing the total is refused: a
 *    correction never marks a milestone paid (record the missing money instead);
 *  - refused: Square-linked rows, a paid row whose ledger is not the whole story
 *    (Square over part-payments, "Mark settled"), unreadable records, the same amount.
 *
 * Shape (as paymentUndoService): planAmountCorrection is PURE; the preview reads and
 * plans; the execute re-reads and re-plans under the lead lock, checks the preview
 * still matches, writes ONE lead mutation (compare-and-swap inside the payment-write
 * queue), holds the lock until it reads back, then posts the record and alerts.
 */

const leadService = require('./leadService');
const ms          = require('./milestonePaymentService');
const U           = require('./paymentUndoService');
const { torontoTime } = require('../utils/torontoTime');

const s = (v) => String(v == null ? '' : v).trim();
const oneLine = (v) => s(v).replace(/\s+/g, ' ');
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dollars(cents) { return (Math.round(Number(cents) || 0) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }); }
const MAX_CENTS = 20000000;   // $200,000 — the same ceiling as Record payment

/**
 * PURE. What correcting the latest payment on milestone `index` to `newAmountCents` would write.
 * @returns {{ok:false, refusal:{code,message}} | {ok:true, ...plan}}
 */
function planAmountCorrection({ lead, index, cm = null, cmMissing = false, claimants, squareOrder = null, newAmountCents, actor = null, now = null } = {}) {
  const refuse = (code, message) => ({ ok: false, refusal: { code, message } });
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > U.MAX_INDEX) return refuse('BAD_INDEX', 'That milestone does not exist.');
  const { pay, unreadable } = ms.readPayments(lead);
  if (unreadable) return refuse('PAYMENTS_UNREADABLE', 'The payment records on this client can’t be read, so nothing can be changed safely. Ask an admin to check the lead’s “Milestone Payments (JSON)” column.');
  const before = (pay[i] && typeof pay[i] === 'object') ? pay[i] : null;
  const row = ms.scheduleRows(lead)[i] || null;
  const total = row ? Math.round(row.totalCents || 0) : 0;
  const label = s(require('./retainerPlanService').displayMilestoneLabel(row && row.label)) || `Milestone ${i + 1}`;
  if (!before || (before.status !== 'paid' && before.status !== 'partial')) {
    return refuse('NOT_RECORDED', 'No payment is recorded on this milestone, so there is no amount to correct.');
  }
  if (!(total > 0)) return refuse('NO_SCHEDULE', 'This milestone has no scheduled amount on the retainer plan, so a corrected amount can’t be checked against it.');
  if (s(before.txnId) || (i === 0 && s(lead.squareRetainerTxnId))) {
    return refuse('SQUARE_PAYMENT', 'This payment is linked to Square — correct it in Square (refund the difference), not here.');
  }
  // A retainer stamped paid first can carry a Square link Square reports as PAID with no txn id (as Undo).
  const squareLink = i === 0 && s(lead.squareRetainerOrderId);
  if (squareLink && squareOrder && squareOrder.paid) {
    return refuse('SQUARE_PAYMENT', 'Square shows the payment link for this retainer as PAID, so Square holds the money — correct it in Square, not here.');
  }
  const ledger = ms.ledgerOf(before);
  const raw = Array.isArray(before.l) ? before.l.filter((x) => x && typeof x === 'object' && Number.isFinite(Number(x.a)) && Number(x.a) > 0) : [];
  let mode, wasCents, otherCents, latest;
  if (before.status === 'paid' && !ledger.length) {
    // A plain "Mark paid": one payment of the whole milestone.
    mode = 'full'; wasCents = total; otherCents = 0;
    latest = { paidAt: s(before.paidAt), reference: s(before.reference), by: s(before.marked && before.marked.by) };
  } else if (before.status === 'paid' && !ms.ledgerComplete(before)) {
    return refuse('NOT_CORRECTABLE', 'This milestone was settled on payments already on file, or by Square, so its amount can’t be corrected here. Use Undo… instead.');
  } else {
    mode = 'last';
    const last = ledger[ledger.length - 1];
    wasCents = last.amountCents; otherCents = ledger.reduce((t, x) => t + x.amountCents, 0) - wasCents;
    latest = { paidAt: last.paidAt, reference: last.reference, by: last.by };
  }
  const n = Number(newAmountCents);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CENTS) return refuse('BAD_AMOUNT', 'Enter the amount actually received, in dollars and cents.');
  if (n === wasCents) return refuse('SAME_AMOUNT', `That payment is already recorded as ${dollars(n)} — nothing to correct.`);
  const newSum = otherCents + n;
  // Lowering a payment while what is on file still covers the milestone (the plan was
  // amended down): nothing would be owed either way — that is "Mark settled", not this.
  if (newSum >= total && n < wasCents) {
    return refuse('COVERED', `Even at ${dollars(n)}, the payments on file (${dollars(newSum)}) cover this milestone (${dollars(total)}) — nothing would be owed. Nothing was changed. Use “Mark settled” on the payment row instead.`);
  }
  if (newSum > total) {
    return refuse('OVER_TOTAL', otherCents > 0
      ? `That is more than this milestone allows: ${dollars(otherCents)} is on file from earlier payments, and the milestone is ${dollars(total)}. Nothing was changed. Record anything extra on the next milestone.`
      : `That is more than the milestone (${dollars(total)}). Nothing was changed. Record anything extra on the next milestone.`);
  }
  if (newSum === total) {
    return refuse('WOULD_SETTLE', `That would make the milestone fully paid. A correction never marks a milestone paid — record the missing ${dollars(total - (otherCents + wasCents))} with “Record balance / part-payment” instead. Nothing was changed.`);
  }

  const at = s(now) || new Date().toISOString();
  const by = oneLine((actor && (actor.name || actor.email)) || '').slice(0, 60) || 'Unknown';
  const fixed = { by, at: at.slice(0, 16) + 'Z', was: U.entryFingerprint(before), from: wasCents, to: n };
  let l;
  if (mode === 'full') {
    // The recorded payment becomes the row's first ledger entry: its date, bank reference and recorder kept.
    const m = before.marked || {};
    l = [{ a: n, d: s(before.paidAt) || at.slice(0, 10), r: s(before.reference).slice(0, 24), b: oneLine(m.by).slice(0, 24), v: m.verified === true, t: s(m.at) }];
  } else {
    l = raw.map((x) => ({ ...x }));
    l[l.length - 1] = { ...l[l.length - 1], a: n };
  }
  const after = { ...before };
  delete after.paidAt; delete after.marked; delete after.undone; delete after.fixed;
  if (before.status === 'paid') {
    // The reference the client quotes for the balance: the request's, when a request went out
    // (a paid row carries the BANK reference typed when it was marked).
    if (s(before.requestedAt)) after.reference = ms.paymentReference(lead.id, i);
    else delete after.reference;
  }
  Object.assign(after, { status: 'partial', method: s(before.method) || 'e-transfer', l, fixed });

  const postPay = { ...pay }; postPay[i] = after;
  const paymentsText = JSON.stringify(postPay);
  if (paymentsText.length > ms.MAX_PAYMENTS_JSON) {
    return refuse('PAYMENTS_TOO_LARGE', 'The payment records on this client are too long to update safely. Ask an admin to check the lead.');
  }

  const shared = Array.isArray(claimants) && claimants.length > 1;
  const retainerPaid = s(lead.retainerPaid);
  const balance = total - newSum;
  const warnings = [], info = [];
  if (shared) warnings.push({ code: 'SHARED_CASE', message: `This case is linked to ${claimants.length} client records (${claimants.map((c) => `${oneLine(c.name) || 'unnamed'} #${c.id}`).join(', ')}). You are changing ${oneLine(lead.fullName) || 'this client'} #${s(lead.id)} only — check it is the right one.` });
  else if (claimants === null && s(lead.clientMasterItemId)) info.push({ code: 'CLAIMANTS_UNKNOWN', message: 'Couldn’t check whether another client record shares this case — make sure this is the right client.' });
  if (s(lead.clientMasterItemId) && cmMissing) warnings.push({ code: 'CASE_MISSING', message: 'The case this client points at no longer exists on the Cases board. The correction changes the client’s record only.' });
  if (cm && cm.archived) warnings.push({ code: 'CASE_ARCHIVED', message: 'This client’s case is archived.' });
  if (squareLink && !squareOrder) warnings.push({ code: 'SQUARE_LINK_EXISTS', message: 'A Square payment link was issued for this retainer, and Square could not be checked just now. Look in Square for a completed payment before correcting this amount.' });
  info.push({ code: 'BALANCE', message: i === 0
    ? `The ${dollars(balance)} balance is collected before submission — the Summary lists it once the case reaches Submission Preparation.`
    : `The ${dollars(balance)} balance stays on this milestone until it is recorded.` });

  const when = latest.paidAt ? ` of ${latest.paidAt}` : '';
  const willChange = [
    `The payment${when}${latest.reference ? ` (ref ${latest.reference})` : ''} is recorded as ${dollars(n)} — it was ${dollars(wasCents)}`,
    `${label} reads “part-paid”: ${dollars(newSum)} of ${dollars(total)} on file — balance ${dollars(balance)}`,
  ];
  // Milestone 1: is the case started, or held for a signature? (Say only what is true.)
  const gate = require('./caseGateService').signatureGateForLead(lead);
  const caseState = (i !== 0 || !retainerPaid) ? null
    : ((cm && s(cm.paymentStatus).toLowerCase() === 'paid') || gate.complete) ? 'started' : 'held';
  const retained = U.RETAINED_LABELS.includes(s(lead.conversionStatus).toLowerCase());
  const willNotChange = ['No money moves, and nothing is sent to the client'];
  if (caseState === 'started') willNotChange.push(`The case stays started — Retainer Paid date (${retainerPaid})${retained ? ', “Retained”' : ''}, and the case’s Payment Status and stage`);
  else if (caseState === 'held') willNotChange.push(`The Retainer Paid date (${retainerPaid}) — the case still starts on the money on file once the ${gate.missing.join(' and ')} ${gate.missing.length > 1 ? 'are' : 'is'} in`);
  else if (i === 0) willNotChange.push('The client’s Retainer Paid date and the case');
  willNotChange.push('Signatures, “Retained by”, emails already sent, and Monday history');

  return {
    ok: true,
    leadId: s(lead.id), index: i, label, totalCents: total, mode,
    before, after, wasCents, newAmountCents: n, newSumCents: newSum, balanceCents: balance, latest, caseState, retained, missing: caseState === 'held' ? gate.missing : [],
    warnings, info, willChange, willNotChange, paymentsText,
    expect: { entry: U.entryFingerprint(before), amountCents: n },
    confirmText: U.confirmTextFor(lead, cm, shared),
  };
}

function publicPlan(plan) {
  if (!plan.ok) return plan;
  const { paymentsText, ...rest } = plan;   // eslint-disable-line no-unused-vars
  return rest;
}

/** The write: ONE lead mutation inside the payment-write queue, compare-and-swap on the fresh row. */
async function commitCorrection(plan) {
  return ms.withPaymentWriteQueue(plan.leadId, async () => {
    const fresh = await leadService.getLead(plan.leadId);
    if (!fresh) { const e = new Error('That client record could not be found.'); e.code = 'NO_LEAD'; throw e; }
    const { pay, unreadable } = ms.readPayments(fresh);
    if (unreadable) { const e = new Error('The payment records on this client can’t be read — nothing was changed.'); e.code = 'PAYMENTS_UNREADABLE'; throw e; }
    if (U.entryFingerprint(pay[plan.index]) !== plan.expect.entry) {
      const e = new Error('This payment changed while the correction was being prepared — nothing was changed. Close the dialog and open it again.'); e.code = 'CHANGED_SINCE_PREVIEW'; throw e;
    }
    pay[plan.index] = plan.after;
    await leadService.updateLead(plan.leadId, { milestonePayments: ms.serializePayments(plan.leadId, pay) });
  });
}

/** Side effects not shared with the undo (which owns reads, notes and alerts — U.io). */
const io = { commit: (plan) => commitCorrection(plan) };

/** Read-only: what correcting milestone `index` to `amountCents` would do right now. */
async function previewAmountCorrection({ leadId, index, amountCents, actor = null } = {}) {
  const st = await U.readState(leadId, index);
  if (st.error) return { ok: false, status: st.status, code: st.code, error: st.error };
  const plan = planAmountCorrection({ ...st, index, newAmountCents: amountCents, actor, now: U.io.nowIso() });
  return { ok: true, client: { name: oneLine(st.lead.fullName) || 'Client', leadId: s(st.lead.id), caseRef: (st.cm && st.cm.caseRef) || '' }, plan: publicPlan(plan) };
}

function validateCorrectionRequest({ leadId, index, amountCents, confirmText, reason, expect, actor } = {}) {
  if (!/^\d{3,20}$/.test(s(leadId))) return 'Unknown client.';
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > U.MAX_INDEX) return 'That milestone does not exist.';
  const n = Number(amountCents);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CENTS) return 'Enter the amount actually received, in dollars and cents.';
  const r = s(reason);
  if (r.length < U.REASON_MIN) return `Give a reason of at least ${U.REASON_MIN} characters — it goes on the record.`;
  if (r.length > U.REASON_MAX) return `Keep the reason under ${U.REASON_MAX} characters.`;
  if (typeof confirmText !== 'string' || confirmText.length > 60) return 'Type the confirmation shown in the dialog.';
  if (!expect || typeof expect !== 'object' || typeof expect.entry !== 'string' || expect.entry.length > 20 || Number(expect.amountCents) !== n) {
    return 'This dialog is out of date — close it and open it again.';
  }
  if (!actor || !s(actor.email)) return 'Sign in with Monday to correct a payment.';
  return null;
}

const _inFlight = new Set();
async function executeAmountCorrection({ leadId, index, amountCents, confirmText, reason, expect, actor } = {}) {
  const bad = validateCorrectionRequest({ leadId, index, amountCents, confirmText, reason, expect, actor });
  if (bad) return { ok: false, status: 400, code: 'BAD_REQUEST', error: bad };
  const key = s(leadId), i = Number(index), n = Number(amountCents);
  if (_inFlight.has(key)) return { ok: false, status: 409, code: 'BUSY', error: 'A payment change for this client is already running — wait a moment, then reload.' };
  _inFlight.add(key);
  let outcome;
  try {
    outcome = await U.io.withLeadLockOrSkip(key, U.LEAD_LOCK_WAIT_MS, async () => {
      const st = await U.readState(key, i);
      if (st.error) return { ok: false, status: st.status, code: st.code, error: st.error };
      // A retry after a lost response: our correction is already on the row.
      const cur = ms.readPayments(st.lead).pay[i] || {};
      if (cur.fixed && cur.fixed.was === expect.entry && Number(cur.fixed.to) === n) {
        return { ok: true, already: true, message: 'This amount was already corrected. Nothing more was needed.' };
      }
      const plan = planAmountCorrection({ ...st, index: i, newAmountCents: n, actor, now: U.io.nowIso() });
      if (!plan.ok) return { ok: false, status: 409, code: plan.refusal.code, error: plan.refusal.message, refusal: plan.refusal };
      if (plan.expect.entry !== expect.entry) {
        return { ok: false, status: 409, code: 'CHANGED_SINCE_PREVIEW', error: 'This payment changed since you opened the dialog. Close it and open it again.' };
      }
      if (s(confirmText) !== plan.confirmText) return { ok: false, status: 400, code: 'CONFIRM_MISMATCH', error: `Type ${plan.confirmText} exactly to confirm.` };
      let commitErr = null;
      try { await io.commit(plan); }
      catch (err) {
        if (err.code === 'CHANGED_SINCE_PREVIEW') return { ok: false, status: 409, code: err.code, error: err.message };
        if (U.OWN_COMMIT_CODES.includes(err.code)) return { ok: false, status: 503, code: err.code, error: err.message };
        // A transport error (ECONNABORTED, a 504 …) may hide a write that landed — the read-back decides.
        commitErr = err;
      }
      // Hold the lock until the correction reads back (whoever takes it next must see it).
      const want = U.entryFingerprint(plan.after), was = U.entryFingerprint(plan.before);
      let seen = 'unread';
      for (let k = 0; k < U.VERIFY_READS && seen !== 'after'; k++) {
        if (k) await U.io.sleep(U.VERIFY_GAP_MS);
        try {
          const l = await U.io.getLead(key);
          const fp = l ? U.entryFingerprint(ms.readPayments(l).pay[i]) : '';
          seen = fp === want ? 'after' : fp === was ? 'before' : 'other';
        } catch (_) { /* read again */ }
      }
      // The write failed and the row still reads as before: nothing changed — nothing to record.
      if (commitErr && seen === 'before') return { ok: false, status: 503, code: 'COMMIT_FAILED', error: 'Monday didn’t accept the change — nothing was changed. Try again in a minute.' };
      // Landed but not confirmed in time (or unreadable): still record it and alert — an
      // admin-only money change must never be left with no reason on record.
      return { ok: true, plan, lead: st.lead, cm: st.cm, cmMissing: st.cmMissing, unconfirmed: seen !== 'after' };
    });
  } finally {
    _inFlight.delete(key);
  }
  if (outcome && outcome.busy === true && Object.keys(outcome).length === 1) return { ok: false, status: 409, code: 'BUSY', error: U.BUSY_MESSAGE };
  if (!outcome.ok || outcome.already) return outcome;

  // ── After the lock: the record and the alerts ──
  const { plan, lead, cm, unconfirmed } = outcome;
  const who = esc(s(actor.name) || s(actor.email));
  const when = `${torontoTime(Date.parse(U.io.nowIso()))} (Toronto)`;
  const started = plan.caseState === 'started';
  const held = plan.caseState === 'held';
  const heldLine = held ? `the Retainer Paid date stays — the case still starts on the money on file once the ${(plan.missing || []).join(' and ')} ${(plan.missing || []).length > 1 ? 'are' : 'is'} in` : '';
  const alarm = unconfirmed ? '<br>⚠️ <b>Monday did not confirm this change in time</b> — an admin must check the payment row now. If it still shows the old amount, the correction did not land.' : '';
  const what = `the payment${plan.latest.paidAt ? ` of ${esc(plan.latest.paidAt)}` : ''}${plan.latest.reference ? ` (ref ${esc(plan.latest.reference)})` : ''}`;
  const head = `✏️ <b>Payment amount corrected</b> — ${esc(plan.label)}: ${what} is now recorded as <b>${esc(dollars(plan.newAmountCents))}</b> (it was ${esc(dollars(plan.wasCents))}). ` +
    `${esc(plan.label)} reads “part-paid”: ${esc(dollars(plan.newSumCents))} of ${esc(dollars(plan.totalCents))} on file — <b>balance ${esc(dollars(plan.balanceCents))}</b>.`;
  const leadBody = `${head}<br>Corrected by ${who} — ${when}. <b>Reason:</b> ${esc(s(reason))}<br>` +
    `<b>Not changed:</b> ${started ? `the case stays started (Retainer Paid date, ${plan.retained ? '“Retained”, ' : ''}Payment Status and stage); ` : held ? `${esc(heldLine)}; ` : ''}signatures, and anything already sent to the client. No money moved.` +
    (plan.index === 0 ? ' Collect the balance before submission.' : '') + alarm +
    `<br><small>Before: ${esc(JSON.stringify(plan.before))}</small>`;
  const caseBody = `${head} Corrected by ${who} — ${when}. <b>Reason:</b> ${esc(s(reason))}.${started ? ' The case stays started.' : ''} Details are on the client’s lead record.${alarm}`;
  const caseItem = (s(lead.clientMasterItemId) && !outcome.cmMissing) ? s(lead.clientMasterItemId) : '';
  const warnings = [...plan.warnings];
  let notesFailed = false;
  try { await U.io.postNote(lead.id, leadBody); } catch (_) { notesFailed = true; }
  if (caseItem) { try { await U.io.postNote(caseItem, caseBody); } catch (_) { notesFailed = true; } }
  if (notesFailed) warnings.push({ code: 'NOTES_FAILED', message: 'The amount was corrected, but posting the note on Monday failed — add a short note by hand.' });
  const notified = await U.notifyPeople(lead,
    `Payment amount corrected for ${s(lead.fullName) || 'a client'}${(cm && cm.caseRef) ? ` (${cm.caseRef})` : ''}: ${plan.label} ${dollars(plan.wasCents)} → ${dollars(plan.newAmountCents)}. By ${s(actor.name) || s(actor.email)} — ${s(reason).slice(0, 120)}`,
    caseItem || lead.id, actor.email).catch(() => 0);
  try { U.io.invalidateQueues(); } catch (_) { /* cache only */ }
  if (unconfirmed) {
    return { ok: false, status: 503, code: 'NOT_CONFIRMED', warnings, notified,
      error: 'Monday didn’t confirm the change in time. The record and the alerts were posted — reload the page and check the payment row before doing anything else.' };
  }
  return {
    ok: true,
    message: `Corrected. ${plan.label} now reads “part-paid”: ${dollars(plan.newSumCents)} of ${dollars(plan.totalCents)} — balance ${dollars(plan.balanceCents)}.${started ? ' The case stays started — collect the balance before submission.' : held ? ` The case still starts on the money on file once the ${(plan.missing || []).join(' and ')} ${(plan.missing || []).length > 1 ? 'are' : 'is'} in.` : ''}`,
    corrected: { index: plan.index, from: plan.wasCents, to: plan.newAmountCents, balanceCents: plan.balanceCents },
    warnings, notified,
  };
}

module.exports = { planAmountCorrection, previewAmountCorrection, executeAmountCorrection, validateCorrectionRequest, commitCorrection, io, MAX_CENTS };
