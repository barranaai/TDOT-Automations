/**
 * Milestone Payment Service — collect the retainer fee milestone-by-milestone.
 *
 * The professional fee is split into milestones (retainerMilestones JSON). The
 * FIRST milestone is charged at retain via the existing retainer-payment path
 * (paymentService); milestones 2..N are charged on demand from the retainer
 * panel when they fall DUE (their trigger case-stage is reached).
 *
 * Payment state lives in the `milestonePayments` column — a JSON object keyed by
 * milestone index: { "<i>": { status:'pending|sent|paid', amountCents, orderId,
 * url, sentAt, paidAt, txnId } }. Kept separate from retainerMilestones so
 * editing the plan never wipes payment state.
 *
 * Each milestone charges its TOTAL (amount + HST — per the fee schedule / Annex B).
 * Square correlates a milestone payment back via the payment note
 * "milestone-<leadId>-<index>" (see bookingService.handleSquarePaymentWebhook).
 *
 * PART-PAYMENTS (2026-10-13, Asmita: a client e-transferred half of milestone 1).
 * Each milestone keeps a small ledger `l` of the payments received for it:
 *   l: [{ a: cents, d: 'YYYY-MM-DD', r: 'bank ref', b: 'who recorded', v: verified, t: 'ISO-minute Z' }]
 * (short keys: the whole column must stay under MAX_PAYMENTS_JSON). While the
 * ledger is short of the milestone's total the row reads status 'partial' —
 * NOT 'paid': paidAt, marked, the "paid" note, and for milestone 1 the whole
 * retainer-paid chain (Retained, countersign, onboarding) happen only on the
 * payment that brings the balance to zero. The ledger is kept after that, so
 * the statement shows every payment.
 */

'use strict';

const leadService = require('./leadService');
const mondayApi   = require('./mondayApi');

// The Toronto calendar day: a payment recorded at 8:30 pm Toronto is dated that
// evening, not tomorrow (UTC) — and "the same amount, the same day" means one day.
function todayISO() { return require('../utils/torontoTime').torontoDay(new Date().toISOString()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// The retainer + every milestone are collected by Interac e-transfer (NOT Square —
// Square keeps its processing fee; e-transfer is free). Clients send to this
// address; the team reconciles each payment manually with the reference below.
const ETRANSFER_EMAIL = (process.env.ETRANSFER_EMAIL || 'admstdot@gmail.com').trim();
/** A short, stable reference the client puts in the e-transfer message so the team
 *  can match it to the right milestone (e.g. TDOT-13635-M2). */
function paymentReference(leadId, index) { return `TDOT-${String(leadId).slice(-5)}-M${Number(index) + 1}`; }
function dollarsCAD(cents) { return (Math.round(cents) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }); }

/** The payments recorded against one milestone row (the ledger), oldest first. */
function ledgerOf(entry) {
  const l = entry && Array.isArray(entry.l) ? entry.l : [];
  return l.filter((x) => x && typeof x === 'object' && Number.isFinite(Number(x.a)) && Number(x.a) > 0)
    .map((x) => ({ amountCents: Math.round(Number(x.a)), paidAt: String(x.d || ''), reference: String(x.r || ''), by: String(x.b || ''), verified: x.v === true, at: String(x.t || '') }));
}
/** A paid row whose ledger is the whole story: the payment that settled it was written to the
 *  ledger in the same click as the paid mark (its stamp equals the mark's). Not so for older
 *  records and Square (no ledger), a Square payment landing over part-payments (writes 'paid'
 *  without adding itself), or a row settled on money already on file ("Mark settled"). */
function ledgerComplete(entry) {
  if (!entry || entry.status !== 'paid') return false;
  const l = ledgerOf(entry);
  return !!(l.length && entry.marked && entry.marked.at && l[l.length - 1].at === String(entry.marked.at));
}
/** Cents received so far on a row: the ledger's sum. A paid row whose ledger is NOT the whole
 *  story counts as at least its total (the money that paid it was never written down here). */
function paidCentsOf(entry, totalCents) {
  const l = ledgerOf(entry);
  const sum = l.reduce((s, x) => s + x.amountCents, 0);
  if (entry && entry.status === 'paid' && !ledgerComplete(entry)) return Math.max(sum, Math.round(Number(totalCents) || 0));
  return sum;
}
/** Which ledger entry settled a paid row (its index), or -1 when none did: every entry is then a
 *  real part-payment (Square over part-payments; a row settled on money already on file) —
 *  readers list them all, and an undo keeps them all. */
function settlingIndexOf(entry) {
  return ledgerComplete(entry) ? ledgerOf(entry).length - 1 : -1;
}
// At most this many payments on one milestone — the whole column must stay under MAX_PAYMENTS_JSON.
const LEDGER_MAX = 6;
// Receipts to the client are a switch (PAYMENT_RECEIPT_EMAILS=1 on Render) — ships OFF.
function paymentReceiptsEnabled() { return /^(true|1)$/i.test(String(process.env.PAYMENT_RECEIPT_EMAILS || '').trim()); }

// Monday cuts long text written through the API at 2,000 characters, and a cut
// payments value no longer parses — every milestone would then read "pending".
// Stay well clear of the limit.
const MAX_PAYMENTS_JSON = 1900;

/**
 * The payments JSON as stored, and whether it is READABLE. A non-empty value
 * that will not parse must never be written over: parsePayments reads it as {}
 * (every milestone "pending"), and writing that back would make the loss of
 * real payment records permanent.
 */
function readPayments(lead) {
  const raw = String((lead && lead.milestonePayments) || '').trim();
  if (!raw) return { pay: {}, unreadable: false };
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return { pay: o, unreadable: false };
  } catch (_) { /* unreadable — below */ }
  return { pay: {}, unreadable: true };
}

/** Serialise the payments object for writing, refusing anything Monday would cut. */
function serializePayments(leadId, pay) {
  const text = JSON.stringify(pay);
  if (text.length > MAX_PAYMENTS_JSON) {
    const e = new Error(`Payment records for lead ${leadId} would be ${text.length} characters — over the ${MAX_PAYMENTS_JSON} limit, so nothing was written.`);
    e.code = 'PAYMENTS_TOO_LARGE';
    e.badRequest = true;   // shown to staff as-is, not as a generic server error
    throw e;
  }
  return text;
}

function paymentsUnreadableError(leadId) {
  const e = new Error(`The payment records on lead ${leadId} can't be read, so nothing was written over them. Ask an admin to check the lead's "Milestone Payments (JSON)" column.`);
  e.code = 'PAYMENTS_UNREADABLE';
  e.badRequest = true;
  return e;
}

/** Parse the milestonePayments JSON column → object keyed by index. */
function parsePayments(lead) {
  try { const o = JSON.parse((lead && lead.milestonePayments) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch (_) { return {}; }
}

/** The milestone schedule rows ({label, amountCents, hstCents, totalCents}) for a lead. */
function scheduleRows(lead) {
  try {
    const { buildRetainerPlan, overridesFromLead } = require('./retainerPlanBuilder');
    const plan = buildRetainerPlan(lead, overridesFromLead(lead));
    return (plan && plan.schedule && plan.schedule.rows) || [];
  } catch (_) { return []; }
}

/**
 * The per-milestone view for the panel: schedule figures + payment status + a
 * `due` flag. For collection, "due" means the case has REACHED OR PASSED the
 * milestone's trigger stage (by the lifecycle order in `orderedStages`), so the
 * payment button stays available until it's paid rather than only at the exact
 * stage. Falls back to an exact-stage match when the stages aren't in the list.
 */
function milestoneStates(lead, currentCaseStage, orderedStages = []) {
  const rows = scheduleRows(lead);
  const pay  = parsePayments(lead);
  let milestones = []; try { milestones = JSON.parse((lead && lead.retainerMilestones) || '[]'); } catch (_) {}
  const curIdx = orderedStages.indexOf(currentCaseStage);
  return rows.map((r, i) => {
    const p = pay[i] || {};
    const trigger = (milestones[i] && milestones[i].trigger) || '';
    let due = false;
    if (currentCaseStage && trigger) {
      const trigIdx = orderedStages.indexOf(trigger);
      due = (curIdx >= 0 && trigIdx >= 0) ? curIdx >= trigIdx : trigger === currentCaseStage;
    }
    // Legacy Square-era rows persisted status 'sent'; consumers (cockpit +
    // client portal) branch on 'requested', so normalise here — otherwise an
    // old request renders as "Not due yet" / a false "on its way" promise.
    // Those rows also predate the reference system, so synthesize the SAME
    // deterministic reference sendMilestoneEtransferRequest would generate —
    // a client who pays against it still reconciles. `legacySent` lets staff
    // UIs offer a deliberate "send proper e-Transfer details" re-issue.
    const legacySent = p.status === 'sent';
    return {
      // displayMilestoneLabel: pre-2026-08-13 plans stored "(50% Non-Refundable)"
      // — normalized here so the portal card, e-transfer emails and notes can
      // never contradict the re-generated Annex B.
      index: i, label: require('./retainerPlanService').displayMilestoneLabel(r.label), amountCents: r.amountCents, totalCents: r.totalCents, trigger,
      status: legacySent ? 'requested' : (p.status || 'pending'),
      legacySent,
      requestedAt: p.requestedAt || p.sentAt || '', paidAt: p.paidAt || '',
      reference: p.reference || (legacySent && lead && lead.id ? paymentReference(lead.id, i) : ''),
      method: p.method || '', due,
      // Who recorded or removed the payment, and when — shown to staff as a small
      // tooltip on the row. Never rendered by the client portal.
      markedBy: (p.marked && p.marked.by) || '', markedAt: (p.marked && p.marked.at) || '',
      markedVerified: !!(p.marked && p.marked.verified),
      undoneBy: (p.undone && p.undone.by) || '', undoneAt: (p.undone && p.undone.at) || '',
      // Part-payments: what has been received on this row and what is still owed.
      paidCents: paidCentsOf(p, r.totalCents),
      balanceCents: Math.max(0, Math.round(r.totalCents || 0) - paidCentsOf(p, r.totalCents)),
      payments: ledgerOf(p),
      // The entry that settled a paid row (-1: none — a plain full payment, or paid by Square over part-payments).
      settlingIndex: settlingIndexOf(p),
    };
  });
}

// Serialize all payment-JSON writes per lead so concurrent patches (e.g. a
// webhook marking one milestone paid while staff generate another's link) do a
// clean read-modify-write instead of clobbering each other's index.
const _patchQueue = new Map();
/** Run `fn` in this lead's payment-write queue. Every read-modify-write of the
 *  payments JSON goes through here — patchPayment and the payment undo alike. */
function withPaymentWriteQueue(leadId, fn) {
  const k = String(leadId);
  const next = (_patchQueue.get(k) || Promise.resolve()).then(fn, fn);
  _patchQueue.set(k, next.catch(() => {}));
  return next;
}
async function patchPayment(leadId, index, patch, opts = {}) {
  return withPaymentWriteQueue(leadId, () => _doPatchPayment(leadId, index, patch, opts));
}
/** Read-modify-write a per-index payment patch. Never downgrades a milestone
 *  already marked 'paid' (a late "sent" patch racing the webhook must not un-pay it)
 *  — undoing a payment is a deliberate admin act with its own path
 *  (paymentUndoService), never a patch. A 'partial' row is protected the same
 *  way from a late request patch (money is on file). `opts.appendLedger` adds
 *  one ledger entry from the FRESH read, so two part-payments never lose one. */
async function _doPatchPayment(leadId, index, patch, opts = {}) {
  const lead = await leadService.getLead(leadId);
  const { pay, unreadable } = readPayments(lead);
  if (unreadable) throw paymentsUnreadableError(leadId);
  const existing = pay[index] || {};
  const merged = { ...existing, ...patch };
  if (existing.status === 'paid') merged.status = 'paid';
  else if (existing.status === 'partial' && merged.status !== 'paid') merged.status = 'partial';
  if (opts.appendLedger) merged.l = [...(Array.isArray(existing.l) ? existing.l : []), opts.appendLedger];
  pay[index] = merged;
  await leadService.updateLead(leadId, { milestonePayments: serializePayments(leadId, pay) });
  return pay;
}

function etransferInstructionsHtml({ firstName, label, dollars, reference }) {
  const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');
  return `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Payment due — ${esc(label)}</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${esc(firstName)},</p>
      <p>Your payment on your file — <b>${esc(label)}</b> — is now due: <strong>${esc(dollars)}</strong> (incl. HST).</p>
      <div style="background:#eef3fb;border:1px solid ${BRAND.border};border-radius:8px;padding:14px 16px;margin:16px 0">
        <p style="margin:0 0 8px"><b>How to pay — Interac e-Transfer</b></p>
        <p style="margin:4px 0">Send an Interac e-Transfer of <b>${esc(dollars)}</b> to:</p>
        <p style="margin:4px 0;font-size:16px"><b>${esc(ETRANSFER_EMAIL)}</b></p>
        <p style="margin:10px 0 0">In the e-transfer <b>message/memo</b>, please include this reference so we can match your payment:</p>
        <p style="margin:4px 0;font-size:15px"><b>${esc(reference)}</b></p>
      </div>
      <p style="font-size:13px;color:${BRAND.mutedOnLight}">Once we receive your e-transfer we'll confirm it and send your receipt. Questions? Just reply to this email.</p>
    </div></div>`;
}

/**
 * The client's receipt for one payment — a part-payment or the one that settles
 * the milestone — with the running statement (scheduled, paid so far, balance)
 * and, while a balance remains, how to pay it with the same reference.
 */
function paymentReceiptHtml({ firstName, label, amountCents, paidCents, totalCents, reference, paidAt, settled, payReference }) {
  const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');
  const balance = Math.max(0, totalCents - paidCents);
  const row = (k, v, strong) => `<tr><td style="padding:4px 0;color:${BRAND.mutedOnLight}">${esc(k)}</td><td style="padding:4px 0;text-align:right;${strong ? 'font-weight:700' : ''}">${esc(v)}</td></tr>`;
  return `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">${settled ? 'Payment received' : 'Part-payment received'} — ${esc(label)}</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${esc(firstName)},</p>
      <p>Thank you — we received your e-transfer of <b>${esc(dollarsCAD(amountCents))}</b>${paidAt ? ` on ${esc(paidAt)}` : ''}${reference ? ` (reference ${esc(reference)})` : ''} toward <b>${esc(label)}</b>.</p>
      <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px">
        ${row('Scheduled (incl. HST)', dollarsCAD(totalCents))}${row('Paid so far', dollarsCAD(paidCents))}${row('Balance', dollarsCAD(balance), true)}
      </table>
      ${settled
        ? `<p>This milestone is now <b>paid in full</b>.</p>`
        : `<div style="background:#eef3fb;border:1px solid ${BRAND.border};border-radius:8px;padding:14px 16px;margin:16px 0">
        <p style="margin:0 0 8px"><b>Balance remaining: ${esc(dollarsCAD(balance))}</b></p>
        <p style="margin:4px 0">When you are ready, please send an Interac e-Transfer of <b>${esc(dollarsCAD(balance))}</b> to <b>${esc(ETRANSFER_EMAIL)}</b>${payReference ? ` with the reference <b>${esc(payReference)}</b> in the message` : ''}.</p>
      </div>`}
      <p style="font-size:13px;color:${BRAND.mutedOnLight}">This is your receipt — please keep it for your records. Questions? Just reply to this email.</p>
    </div></div>`;
}

/**
 * Email the client the e-transfer instructions for milestone `index` (the one-time
 * "Send e-transfer request" button) — amount + HST, the e-transfer address, and a
 * reference to quote. Marks the milestone 'requested'. Refuses if already
 * requested, part-paid or paid. Payment itself is reconciled manually via markMilestonePaid.
 */
// Serialize concurrent requests for the same milestone in this process so a
// double-click can't send two emails / two 'requested' patches.
const _reqInFlight = new Set();
async function sendMilestoneEtransferRequest(leadId, index) {
  const key = `${leadId}:${index}`;
  if (_reqInFlight.has(key)) { const e = new Error('An e-transfer request for that milestone is already being sent — please wait.'); e.badRequest = true; throw e; }
  _reqInFlight.add(key);
  try {
    const lead = await leadService.getLead(leadId);
    if (!lead) { const e = new Error('Lead not found.'); e.notFound = true; throw e; }
    const row = scheduleRows(lead)[index];
    if (!row) { const e = new Error('That milestone does not exist.'); e.badRequest = true; throw e; }

    const existing = parsePayments(lead)[index] || {};
    if (existing.status === 'paid') { const e = new Error('That milestone is already paid.'); e.badRequest = true; throw e; }
    if (existing.status === 'requested') { const e = new Error('An e-transfer request for that milestone was already sent to the client.'); e.badRequest = true; throw e; }
    // Money is already on file: the client owes the balance, never the full amount
    // again. (The signing / fee-edit auto-request lands here too — it logs and skips.)
    if (existing.status === 'partial') {
      const onFile = paidCentsOf(existing, Math.round(row.totalCents || 0));
      const e = new Error(`A part-payment is already on file for that milestone (${dollarsCAD(onFile)} of ${dollarsCAD(row.totalCents || 0)}) — the client owes the balance, not the full amount, so no request was sent. Record the balance when it arrives.`);
      e.badRequest = true; e.code = 'PART_PAID'; throw e;
    }
    // The client's record already says the retainer is paid (Square, or the case
    // set to Paid) — never ask them to pay it again.
    if (Number(index) === 0 && String(lead.retainerPaid || '').trim()) {
      const e = new Error(`The retainer is already recorded as paid (${String(lead.retainerPaid).trim()}), so no request was sent. If that date is wrong, an admin can remove it first.`);
      e.badRequest = true; e.code = 'ALREADY_PAID'; throw e;
    }
    // Legacy Square-era rows ('sent') never received e-Transfer details — a
    // deliberate re-issue is allowed and recorded as such below.
    const reIssue = existing.status === 'sent';

    const amount = Math.round(row.totalCents);
    if (amount <= 0) { const e = new Error('That milestone has no amount.'); e.badRequest = true; throw e; }
    const reference = paymentReference(leadId, index);
    const dollars = dollarsCAD(amount);

    await patchPayment(leadId, index, { status: 'requested', amountCents: amount, reference, method: 'e-transfer', requestedAt: todayISO() });

    if (lead.email) {
      try {
        await require('./microsoftMailService').sendEmail({
          to: lead.email, subject: `Your TDOT Immigration payment — ${row.label}`,
          html: etransferInstructionsHtml({ firstName: (lead.fullName || 'there').split(' ')[0], label: row.label, dollars, reference }),
        });
      } catch (err) { console.warn(`[Milestone] e-transfer request email failed for ${leadId}#${index}: ${err.message}`); }
    }
    // The variable MUST be named b — it was sent as "body", Monday rejected the
    // note, and the button reported an error AFTER the client had been emailed.
    await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId),
        b: `📧 <b>E-transfer request ${reIssue ? 're-issued' : 'sent'}</b> — ${esc(row.label)} (${esc(dollars)})<br>` +
              (reIssue ? `This milestone originally went out via the old Square flow with no e-Transfer details — this replaces it. ` : '') +
              `Client asked to e-transfer to <b>${esc(ETRANSFER_EMAIL)}</b>, reference <b>${esc(reference)}</b>. ` +
              `Emailed to ${esc(lead.email || '(no email on lead)')}. Record it as paid here once the e-transfer arrives.` });

    return { ok: true, amount, label: row.label, reference };
  } finally { _reqInFlight.delete(key); }
}

// A staff click waits this long behind another holder of the lead (the shared
// budget from leadMutex), then says so — recording nothing.
const MARK_LOCK_WAIT_MS = require('./leadMutex').LEAD_LOCK_WAIT_MS;

/**
 * Manually reconcile milestone `index` as paid by e-transfer (the "Mark paid"
 * button) — records the reference + date. Idempotent. When it's the FIRST
 * milestone, this IS the retainer payment, so it also flips the client into
 * onboarding (Client Master → Paid / Phase 1), the same as the old Square path.
 */
async function markMilestonePaid(leadId, index, opts = {}) {
  // Under the lead's lock — the one "Undo mark paid" and the e-signature capture
  // hold — so a mark and an undo on the same lead can never interleave into
  // "the milestone reads unpaid but Retainer Paid is still stamped".
  const r = await require('./leadMutex').withLeadLockOrSkip(leadId, MARK_LOCK_WAIT_MS, () => _markMilestonePaid(leadId, index, opts));
  if (r && r.busy === true && Object.keys(r).length === 1) {
    const e = new Error('Another change to this client’s record is in progress (a signature, a payment or the status sync). Nothing was recorded — try again in a minute.');
    e.badRequest = true; e.code = 'BUSY'; throw e;
  }
  return r;
}

/** A compact record of who did something, for the payment row's tooltip. */
function actorStamp(actor) {
  const a = actor || {};
  const by = String(a.name || a.email || '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Unknown';
  return { by, at: new Date().toISOString().slice(0, 16) + 'Z', verified: a.verified === true };
}

async function _markMilestonePaid(leadId, index, { reference = '', paidAt = '', method = 'e-transfer', txnId = '', actor = null, amountCents = null, settle = false } = {}) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return { ok: false };
  const existing = parsePayments(lead)[index] || {};
  const when = paidAt || todayISO();
  // Part-payments: how much is on file for this row, and what this payment leaves.
  const row = scheduleRows(lead)[index] || null;
  const totalCents = row ? Math.round(row.totalCents || 0) : 0;
  const before = paidCentsOf(existing, totalCents);
  const balanceCents = Math.max(0, totalCents - before);
  // Part-payments on file already cover the milestone (the plan was amended down
  // after they were recorded): nothing more is owed — "Mark settled" closes it
  // without an amount, and an amount is refused rather than recorded over it.
  const nothingOwed = existing.status === 'partial' && totalCents > 0 && before >= totalCents;
  const nothingOwedError = () => { const e = new Error(`Nothing more is owed on this milestone — the ${dollarsCAD(before)} already on file covers its ${dollarsCAD(totalCents)}. Nothing was recorded. Use “Mark settled” to close it; if the client sent more, record it on the next milestone.`); e.badRequest = true; e.code = 'NOTHING_OWED'; return e; };
  // "Mark settled" is explicit (settle: true) and only valid while nothing is owed: a dialog
  // opened before the plan was amended back up must never settle on a balance that exists again.
  if (settle === true && !nothingOwed && existing.status !== 'paid') {
    const e = new Error('The balance on this milestone changed since you opened this — nothing was recorded. Reload the page and enter the amount received.');
    e.badRequest = true; e.code = 'SETTLE_STALE'; throw e;
  }
  let amount = null;   // null = the whole balance (today's "Mark paid", rows with no part-payments)
  if (amountCents != null) {
    const n = Number(amountCents);
    if (!Number.isInteger(n) || n <= 0) { const e = new Error('Enter the amount received, in dollars and cents. Nothing was recorded.'); e.badRequest = true; e.code = 'BAD_AMOUNT'; throw e; }
    if (nothingOwed) throw nothingOwedError();
    if (existing.status !== 'paid' && totalCents > 0 && n > balanceCents) {
      const e = new Error(`That is more than the ${dollarsCAD(balanceCents)} still owed on this milestone. Nothing was recorded. Record the balance here and the rest on the next milestone.`);
      e.badRequest = true; e.code = 'AMOUNT_OVER_BALANCE'; throw e;
    }
    amount = n;
  } else if (settle !== true && existing.status === 'partial' && ledgerOf(existing).length) {
    // No amount on a part-paid row: the dialog always sends one, so this is a stale page
    // or a raw call — never silently record "the whole balance" over real part-payments.
    if (nothingOwed) throw nothingOwedError();
    const e = new Error(`This milestone is part-paid (${dollarsCAD(before)} of ${dollarsCAD(totalCents)} on file) — enter the amount received. Nothing was recorded.`);
    e.badRequest = true; e.code = 'AMOUNT_REQUIRED'; throw e;
  }
  if (existing.status === 'paid') {
    // Never swallow a payment silently. A row that already reads paid is either
    // a double-click (same or no reference — harmless) or a SECOND payment being
    // recorded over a first record that may be wrong (the 2026-09-22 wrong-client
    // mark): recording "done" then would lose the real one when the wrong one is
    // undone. Say exactly what is on file either way.
    const on = `${existing.paidAt || '?'}${existing.reference ? `, ref ${existing.reference}` : ''}${existing.marked && existing.marked.by ? `, by ${existing.marked.by}` : ''}`;
    const typed = String(reference || '').trim();
    if (typed && typed !== String(existing.reference || '').trim()) {
      const e = new Error(`This milestone is already recorded as paid (${on}). Nothing was recorded now. If that record is wrong, undo it (admins) or flag it first, then record this payment.`);
      e.badRequest = true;
      throw e;
    }
    console.log(`[Milestone] ${leadId}#${index} already paid — skipping`);
    return { ok: true, already: true, existingOn: on };
  }
  // Keep the request-time reference when staff mark paid without entering one.
  const ref = reference || existing.reference || '';
  const marked = actorStamp(actor);
  const label = (row || {}).label || `Milestone ${index + 1}`;
  const whoLine = /^Unidentified/.test(marked.by)
    ? 'Recorded with the shared admin key — nobody was identified (not signed in with Monday).'
    : `Recorded by ${esc(marked.by)}${marked.verified ? '' : ' (name as typed — not signed in with Monday)'}.`;
  // This payment, as the ledger keeps it (short keys and short values — the column is small).
  const paidNow = amount != null ? amount : (totalCents > 0 ? balanceCents : 0);
  const entry = { a: paidNow, d: when, r: String(reference || '').trim().slice(0, 24), b: String(marked.by).slice(0, 24), v: marked.verified === true, t: marked.at };
  const paidAfter = before + paidNow;
  const settled = totalCents <= 0 || paidAfter >= totalCents;   // no schedule to compare with (older plans) → as today: paid
  const parts = ledgerOf(existing);
  if (parts.length >= LEDGER_MAX && !settled) {
    const e = new Error(`This milestone already has ${LEDGER_MAX} part-payments on file — the most the record can hold. Nothing was recorded. Record the balance as ONE payment once it is all in, or ask an admin.`);
    e.badRequest = true; e.code = 'LEDGER_FULL'; throw e;
  }
  // The same e-transfer recorded twice (two people reading one bank notification,
  // a stale page) must never add up to "paid" — and for milestone 1, to onboarding.
  // A bank reference is unique, so the same reference is the same transfer; the
  // milestone's own request reference (what the client was asked to write) is not
  // distinguishing. Without a distinguishing reference, the same amount on the
  // same day is taken as the same transfer — a genuine second one needs its own.
  if (parts.length && paidNow > 0) {
    const requestRef = String(existing.reference || paymentReference(leadId, index)).trim().slice(0, 24);
    const distinct = entry.r && entry.r !== requestRef ? entry.r : '';
    const same = parts.find((x) => (distinct ? x.reference === distinct : (x.amountCents === paidNow && x.paidAt === when)));
    if (same) {
      const onFile = `${dollarsCAD(same.amountCents)} on ${same.paidAt || '?'}${same.reference ? `, ref ${same.reference}` : ''}${same.by ? `, by ${same.by}` : ''}`;
      const e = new Error(distinct
        ? `A payment with reference ${distinct} is already on file for this milestone (${onFile}). Nothing was recorded — the same e-transfer cannot be recorded twice. If that record is wrong, undo it first (admins).`
        : `A ${dollarsCAD(paidNow)} payment is already on file for this milestone today (${onFile}). Nothing was recorded — it looks like the same e-transfer. If the client really sent a second ${dollarsCAD(paidNow)}, enter that transfer's own bank reference.`);
      e.badRequest = true; e.code = 'DUPLICATE_PART'; throw e;
    }
  }

  if (settle === true) {
    // "Mark settled" (nothingOwed, checked above): settle on what is on file — no new money,
    // no ledger entry, no receipt. The ledger stays incomplete on purpose (its last stamp is
    // older than the mark), so readers list every part-payment and an undo keeps them all.
    await patchPayment(leadId, index, { status: 'paid', paidAt: when, method, reference: ref, marked });
    await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId), b: `✅ <b>Milestone settled</b> — ${esc(label)}: the ${esc(dollarsCAD(before))} already on file covers its ${esc(dollarsCAD(totalCents))} (the plan was amended). No new payment was received. ${whoLine}` });
    console.log(`[Milestone] ${leadId}#${index} settled on part-payments already on file (${before} ≥ ${totalCents})`);
    if (Number(index) === 0) {
      try { await require('./paymentService').recordRetainerPaid(leadId, { reference: ref, paidAt: when }); }
      catch (e) { console.warn(`[Milestone] retainer-paid onboarding trigger failed for ${leadId}: ${e.message}`); }
    }
    return { ok: true, label, settled: true, amountCents: 0, paidCents: before, balanceCents: 0, totalCents };
  }

  if (!settled) {
    // A part-payment: on file, NOT paid — nothing downstream may read it as paid.
    await patchPayment(leadId, index, { status: 'partial', method }, { appendLedger: entry });
    const receipt = await _emailReceipt(lead, { label, amountCents: paidNow, paidCents: paidAfter, totalCents, reference: entry.r, paidAt: when, settled: false, payReference: existing.reference || paymentReference(leadId, index) });
    await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId), b: `💵 <b>Part-payment received</b> — ${esc(label)}: ${esc(dollarsCAD(paidNow))} of ${esc(dollarsCAD(totalCents))} (${esc(method)}${entry.r ? `, ref ${esc(entry.r)}` : ''}). ` +
        `<b>Balance ${esc(dollarsCAD(totalCents - paidAfter))}</b> — the milestone is not paid until the balance is in. ${whoLine}${receipt ? ' Receipt emailed to the client.' : ''}` });
    console.log(`[Milestone] ${leadId}#${index} part-payment ${paidNow} of ${totalCents} (${method}${entry.r ? ` ref ${entry.r}` : ''})`);
    return { ok: true, label, settled: false, amountCents: paidNow, paidCents: paidAfter, balanceCents: totalCents - paidAfter, totalCents };
  }

  // The ledger exists only where part-payments happened: a plain full payment writes exactly what it always did.
  const settlesParts = before > 0;
  await patchPayment(leadId, index, { status: 'paid', paidAt: when, method, reference: ref, marked, ...(txnId ? { txnId } : {}) }, settlesParts ? { appendLedger: entry } : {});
  const receipt = totalCents > 0 ? await _emailReceipt(lead, { label, amountCents: paidNow, paidCents: paidAfter, totalCents, reference: entry.r, paidAt: when, settled: true }) : false;
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(leadId), b: `✅ <b>Payment received</b> — ${esc(label)} (${esc(method)}${ref ? `, ref ${esc(ref)}` : ''}). ` +
      (settlesParts ? `This ${esc(dollarsCAD(paidNow))} payment settles it — ${esc(dollarsCAD(paidAfter))} received in total. ` : '') +
      whoLine + (receipt ? ' Receipt emailed to the client.' : '') });
  console.log(`[Milestone] ${leadId}#${index} marked paid (${method}${ref ? ` ref ${ref}` : ''})`);

  // The first milestone paid = retainer paid → start onboarding (Phase 1).
  if (Number(index) === 0) {
    try { await require('./paymentService').recordRetainerPaid(leadId, { reference: ref, paidAt: when }); }
    catch (e) { console.warn(`[Milestone] retainer-paid onboarding trigger failed for ${leadId}: ${e.message}`); }
  }
  return { ok: true, label, settled: true, amountCents: paidNow, paidCents: paidAfter, balanceCents: 0, totalCents };
}

/** The client's receipt — best-effort, only when the switch is on; true when it went. */
async function _emailReceipt(lead, p) {
  if (!paymentReceiptsEnabled() || !lead || !lead.email) return false;
  try {
    await require('./microsoftMailService').sendEmail({
      to: lead.email,
      subject: `Your TDOT Immigration payment receipt — ${p.label}`,
      html: paymentReceiptHtml({ firstName: (lead.fullName || 'there').split(' ')[0], ...p }),
      replyTo: process.env.EMAIL_REPLY_TO || undefined,
    });
    return true;
  } catch (err) { console.warn(`[Milestone] receipt email failed for ${lead.id}: ${err.message}`); return false; }
}

module.exports = {
  sendMilestoneEtransferRequest, markMilestonePaid, milestoneStates, patchPayment,
  withPaymentWriteQueue, readPayments, serializePayments, actorStamp,
  ETRANSFER_EMAIL, paymentReference, MAX_PAYMENTS_JSON,
  // pure-ish (exported for tests)
  parsePayments, scheduleRows,
  // part-payments (2026-10-13)
  ledgerOf, paidCentsOf, settlingIndexOf, ledgerComplete, todayISO, paymentReceiptHtml, paymentReceiptsEnabled, LEDGER_MAX,
};
