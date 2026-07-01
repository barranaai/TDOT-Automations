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
      status: p.status || 'pending', sentAt: p.sentAt || '', paidAt: p.paidAt || '', due,
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

function paymentEmailHtml(firstName, label, dollars, url) {
  const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');
  return `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your payment for ${esc(label)}</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${esc(firstName)},</p>
      <p>Your next payment on your file — <b>${esc(label)}</b> — is now due: <strong>${esc(dollars)}</strong>.</p>
      <p><a href="${esc(url)}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Pay securely</a></p>
      <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Questions about this payment? Just reply to this email.</p>
    </div></div>`;
}

/**
 * Generate + email the Square payment link for milestone `index` (the one-time
 * "Generate payment link" button). Charges the milestone TOTAL (amount + HST).
 * Refuses if already sent or paid.
 */
// Serialize concurrent generate calls for the same milestone in this process; the
// deterministic idempotencyKey (below) covers retries and other instances.
const _genInFlight = new Set();
async function generateMilestoneLink(leadId, index) {
  const key = `${leadId}:${index}`;
  if (_genInFlight.has(key)) { const e = new Error('A payment link for that milestone is already being generated — please wait.'); e.badRequest = true; throw e; }
  _genInFlight.add(key);
  try {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Lead not found.'); e.notFound = true; throw e; }
  const rows = scheduleRows(lead);
  const row = rows[index];
  if (!row) { const e = new Error('That milestone does not exist.'); e.badRequest = true; throw e; }

  const existing = parsePayments(lead)[index] || {};
  if (existing.status === 'paid') { const e = new Error('That milestone is already paid.'); e.badRequest = true; throw e; }
  if (existing.status === 'sent') { const e = new Error('A payment link for that milestone was already sent to the client.'); e.badRequest = true; throw e; }

  const amount = Math.round(row.totalCents);
  if (amount <= 0) { const e = new Error('That milestone has no amount.'); e.badRequest = true; throw e; }

  const bookingService = require('./bookingService');
  const { url, orderId } = await bookingService.createCheckout({
    leadId, amount, description: `TDOT Immigration — ${row.label}`,
    type: 'milestone', reference: `milestone-${leadId}-${index}`, storeOrderId: false,
    idempotencyKey: `ms-${leadId}-${index}`, // deterministic → Square returns the same link on a retry/double-click
  });

  await patchPayment(leadId, index, { status: 'sent', amountCents: amount, orderId: orderId || '', url, sentAt: todayISO() });

  const dollars = (amount / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
  if (lead.email) {
    try {
      await require('./microsoftMailService').sendEmail({
        to: lead.email, subject: `Your TDOT Immigration payment — ${row.label}`,
        html: paymentEmailHtml((lead.fullName || 'there').split(' ')[0], row.label, dollars, url),
      });
    } catch (err) { console.warn(`[Milestone] email failed for ${leadId}#${index}: ${err.message}`); }
  }
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(leadId),
      body: `💳 <b>Milestone payment link generated</b> — ${esc(row.label)} (${esc(dollars)})<br><a href="${esc(url)}">${esc(url)}</a><br>` +
            `Emailed to ${esc(lead.email || '(no email on lead)')}. It stays valid until paid.` });

  return { ok: true, url, amount, label: row.label };
  } finally { _genInFlight.delete(key); }
}

/** Webhook: milestone `index` was paid — mark it + note. Idempotent. */
async function markMilestonePaid(leadId, index, txnId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return;
  const existing = parsePayments(lead)[index] || {};
  if (existing.status === 'paid') { console.log(`[Milestone] ${leadId}#${index} already paid — skipping`); return; }
  await patchPayment(leadId, index, { status: 'paid', paidAt: todayISO(), txnId });
  const label = (scheduleRows(lead)[index] || {}).label || `Milestone ${index + 1}`;
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(leadId), b: `✅ <b>Milestone paid</b> — ${esc(label)} (txn ${esc(txnId)}).` });
  console.log(`[Milestone] ${leadId}#${index} marked paid (txn ${txnId})`);
}

module.exports = {
  generateMilestoneLink, markMilestonePaid, milestoneStates, patchPayment,
  // pure-ish (exported for tests)
  parsePayments, scheduleRows,
};
