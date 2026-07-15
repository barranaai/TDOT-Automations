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
 */

'use strict';

const leadService = require('./leadService');
const mondayApi   = require('./mondayApi');

function todayISO() { return new Date().toISOString().split('T')[0]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// The retainer + every milestone are collected by Interac e-transfer (NOT Square —
// Square keeps its processing fee; e-transfer is free). Clients send to this
// address; the team reconciles each payment manually with the reference below.
const ETRANSFER_EMAIL = (process.env.ETRANSFER_EMAIL || 'admstdot@gmail.com').trim();
/** A short, stable reference the client puts in the e-transfer message so the team
 *  can match it to the right milestone (e.g. TDOT-13635-M2). */
function paymentReference(leadId, index) { return `TDOT-${String(leadId).slice(-5)}-M${Number(index) + 1}`; }
function dollarsCAD(cents) { return (Math.round(cents) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }); }

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
    return {
      index: i, label: r.label, amountCents: r.amountCents, totalCents: r.totalCents, trigger,
      // Legacy Square-era rows persisted status 'sent'; consumers (cockpit +
      // client portal) branch on 'requested', so normalise here — otherwise an
      // old request renders as "Not due yet" / a false "on its way" promise.
      status: p.status === 'sent' ? 'requested' : (p.status || 'pending'),
      requestedAt: p.requestedAt || p.sentAt || '', paidAt: p.paidAt || '',
      reference: p.reference || '', method: p.method || '', due,
    };
  });
}

// Serialize all payment-JSON writes per lead so concurrent patches (e.g. a
// webhook marking one milestone paid while staff generate another's link) do a
// clean read-modify-write instead of clobbering each other's index.
const _patchQueue = new Map();
async function patchPayment(leadId, index, patch) {
  const k = String(leadId);
  const run = () => _doPatchPayment(leadId, index, patch);
  const next = (_patchQueue.get(k) || Promise.resolve()).then(run, run);
  _patchQueue.set(k, next.catch(() => {}));
  return next;
}
/** Read-modify-write a per-index payment patch. Never downgrades a milestone
 *  already marked 'paid' (a late "sent" patch racing the webhook must not un-pay it). */
async function _doPatchPayment(leadId, index, patch) {
  const lead = await leadService.getLead(leadId);
  const pay = parsePayments(lead);
  const merged = { ...(pay[index] || {}), ...patch };
  if ((pay[index] || {}).status === 'paid') merged.status = 'paid';
  pay[index] = merged;
  await leadService.updateLead(leadId, { milestonePayments: JSON.stringify(pay) });
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
 * Email the client the e-transfer instructions for milestone `index` (the one-time
 * "Send e-transfer request" button) — amount + HST, the e-transfer address, and a
 * reference to quote. Marks the milestone 'requested'. Refuses if already
 * requested or paid. Payment itself is reconciled manually via markMilestonePaid.
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
    await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId),
        body: `📧 <b>E-transfer request sent</b> — ${esc(row.label)} (${esc(dollars)})<br>` +
              `Client asked to e-transfer to <b>${esc(ETRANSFER_EMAIL)}</b>, reference <b>${esc(reference)}</b>. ` +
              `Emailed to ${esc(lead.email || '(no email on lead)')}. Record it as paid here once the e-transfer arrives.` });

    return { ok: true, amount, label: row.label, reference };
  } finally { _reqInFlight.delete(key); }
}

/**
 * Manually reconcile milestone `index` as paid by e-transfer (the "Mark paid"
 * button) — records the reference + date. Idempotent. When it's the FIRST
 * milestone, this IS the retainer payment, so it also flips the client into
 * onboarding (Client Master → Paid / Phase 1), the same as the old Square path.
 */
async function markMilestonePaid(leadId, index, { reference = '', paidAt = '', method = 'e-transfer', txnId = '' } = {}) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return { ok: false };
  const existing = parsePayments(lead)[index] || {};
  const when = paidAt || todayISO();
  if (existing.status === 'paid') { console.log(`[Milestone] ${leadId}#${index} already paid — skipping`); return { ok: true, already: true }; }
  // Keep the request-time reference when staff mark paid without entering one.
  const ref = reference || existing.reference || '';
  await patchPayment(leadId, index, { status: 'paid', paidAt: when, method, reference: ref, ...(txnId ? { txnId } : {}) });
  const label = (scheduleRows(lead)[index] || {}).label || `Milestone ${index + 1}`;
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(leadId), b: `✅ <b>Payment received</b> — ${esc(label)} (${esc(method)}${ref ? `, ref ${esc(ref)}` : ''}).` });
  console.log(`[Milestone] ${leadId}#${index} marked paid (${method}${ref ? ` ref ${ref}` : ''})`);

  // The first milestone paid = retainer paid → start onboarding (Phase 1).
  if (Number(index) === 0) {
    try { await require('./paymentService').recordRetainerPaid(leadId, { reference: ref, paidAt: when }); }
    catch (e) { console.warn(`[Milestone] retainer-paid onboarding trigger failed for ${leadId}: ${e.message}`); }
  }
  return { ok: true, label };
}

module.exports = {
  sendMilestoneEtransferRequest, markMilestonePaid, milestoneStates, patchPayment,
  ETRANSFER_EMAIL, paymentReference,
  // pure-ish (exported for tests)
  parsePayments, scheduleRows,
};
