/**
 * Payment Service (Phase 2 — WS7): the retainer-payment bridge.
 *
 * This is the LAST step of the Phase 2 funnel and the second bridge into
 * Phase 1. When a client pays their retainer fee through Square:
 *
 *   onSquareRetainerPaymentReceived(event)
 *     1. Lead Board   → Retainer Paid date + Square txn id + Conversion
 *                       Status = "Retained — Paid".
 *     2. Client Master → Payment Status = "Paid" + Payment Confirmation Date.
 *        Setting Payment Status = "Paid" is the documented Phase 1 trigger:
 *        Phase 1's webhook reacts to it and kicks off onboarding (access
 *        token, questionnaire, checklist seeding, etc.).
 *
 * Routing: bookingService.handleSquarePaymentWebhook() already matches a
 * Square payment whose order id equals a lead's Square Retainer Order Id and
 * forwards the event here, so this function only runs for retainer payments.
 *
 * sendRetainerPaymentLink(leadId, {amountCents}) creates the Square checkout
 * and emails the client the link. Auto-wired: retainerService2 calls it with
 * the per-client "Retainer Fee (CAD)" from the Lead Board once the retainer
 * is signed and the fee is set. The amount is always explicit — there is no
 * default, so a missing fee can never silently charge the wrong amount.
 */

'use strict';

const mondayApi     = require('./mondayApi');
const leadService   = require('./leadService');
const microsoftMail = require('./microsoftMailService');
const { clientMasterBoardId } = require('../../config/monday');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

// Client Master columns this bridge writes (live board 18401523447).
const CM = {
  paymentStatus:   'color_mm0x9fnn', // Phase 1 trigger when set to "Paid"
  paymentConfDate: 'date_mm0xgk76',
};

const RENDER_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
function todayISO() { return new Date().toISOString().split('T')[0]; }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Pull a COMPLETED payment out of a Square webhook event (else null). */
function extractCompletedPayment(event) {
  if (!event || (event.type !== 'payment.created' && event.type !== 'payment.updated')) return null;
  const payment = event.data?.object?.payment;
  if (!payment || payment.status !== 'COMPLETED') return null;
  return payment;
}

/**
 * Retainer payment received → record on the Lead Board and flip the Client
 * Master Payment Status to "Paid" (the Phase 1 onboarding trigger). Idempotent:
 * a redelivered webhook for an already-paid lead is a no-op.
 * opts.fallbackLeadId — lead to credit when the order-id lookup misses (the
 * caller recovered it from the Square payment note).
 */
/**
 * Record the retainer as PAID and start onboarding — the shared core used by both
 * the Square webhook and the manual e-transfer reconciliation (markMilestonePaid
 * on the first milestone). Sets the Lead Board fields, marks milestone 0 paid, and
 * flips the Client Master Payment Status to "Paid" (the Phase 1 trigger). Idempotent.
 * @param {string|object} leadOrId  a leadId or an already-loaded lead
 */
async function recordRetainerPaid(leadOrId, { txnId = '', reference = '', paidAt = '' } = {}) {
  const lead = (leadOrId && typeof leadOrId === 'object') ? leadOrId : await leadService.getLead(leadOrId);
  if (!lead) return null;
  const when = paidAt || todayISO();

  if (lead.retainerPaid) {
    console.log(`[Payment] Lead ${lead.id} retainer already marked paid (${lead.retainerPaid}) — skipping`);
    return lead.clientMasterItemId || null;
  }

  // 1. Lead Board.
  await leadService.updateLead(lead.id, {
    retainerPaid:     when,
    ...(txnId ? { squareRetainerTxnId: txnId } : {}),
    conversionStatus: 'Retained — Paid',
  });
  console.log(`[Payment] Lead ${lead.id} retainer paid${txnId ? ` (txn ${txnId})` : reference ? ` (e-transfer ref ${reference})` : ''}`);

  // The retainer payment IS the first milestone — record it as paid on the panel.
  try { await require('./milestonePaymentService').patchPayment(lead.id, 0, { status: 'paid', paidAt: when, ...(txnId ? { txnId } : {}), ...(reference ? { reference, method: 'e-transfer' } : {}) }); } catch (_) {}

  // 2. Client Master → Payment Status = "Paid" (Phase 1 trigger).
  if (!lead.clientMasterItemId) {
    console.warn(`[Payment] Lead ${lead.id} paid but has no clientMasterItemId — Phase 1 NOT triggered. ` +
      `Run the handoff (mark Retainer Signed) first, then re-trigger payment.`);
    return null;
  }
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    { boardId: String(clientMasterBoardId), itemId: String(lead.clientMasterItemId),
      cols: JSON.stringify({ [CM.paymentStatus]: { label: 'Paid' }, [CM.paymentConfDate]: { date: when } }) }
  );
  console.log(`[Payment] Client Master ${lead.clientMasterItemId} → Payment Status "Paid" (Phase 1 onboarding triggered)`);
  return lead.clientMasterItemId;
}

// Legacy Square retainer webhook path (retainer is now collected by e-transfer, so
// this no longer fires for new leads — kept for any in-flight Square retainer order).
async function onSquareRetainerPaymentReceived(event, { fallbackLeadId } = {}) {
  const payment = extractCompletedPayment(event);
  if (!payment) return;
  const orderId = payment.order_id;
  const txnId   = payment.id;
  if (!orderId) { console.warn(`[Payment] Retainer payment ${txnId} has no order_id`); return; }

  const lead = await leadService.findByColumnValue('squareRetainerOrderId', orderId)
            || (fallbackLeadId ? await leadService.getLead(fallbackLeadId) : null);
  if (!lead) { console.warn(`[Payment] Retainer order ${orderId} (txn ${txnId}) matched no lead`); return; }
  return recordRetainerPaid(lead, { txnId });
}

/**
 * Create a Square retainer checkout and email the client the link.
 * @param {string} leadId
 * @param {object} opts
 * @param {number} opts.amountCents  retainer fee in cents CAD (required —
 *        per-client, from the Lead Board's "Retainer Fee (CAD)" column).
 */
async function sendRetainerPaymentLink(leadId, { amountCents, label } = {}) {
  const bookingService = require('./bookingService');
  const amount = Number.isFinite(amountCents) ? Math.round(amountCents) : 0;
  if (amount <= 0) throw new Error('Retainer fee amount required (pass a positive amountCents)');

  const lead = await leadService.getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const { url } = await bookingService.createCheckout({
    leadId, amount, description: label || 'TDOT Immigration — Retainer Fee', type: 'retainer',
  });

  // Staff-visible backup of the link on the lead BEFORE the email attempt —
  // a spammed/failed email must never leave the link existing only in Square.
  try {
    const dollars = (amount / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
      { itemId: String(leadId),
        body: `💳 <b>Retainer payment link generated</b> (${esc(dollars)})<br>` +
              `<a href="${esc(url)}">${esc(url)}</a><br>` +
              `Emailed to ${esc(lead.email || '(no email on lead)')} automatically. ` +
              `If the client didn't receive it, this link can be re-shared — it stays valid until paid.` }
    );
  } catch (err) {
    console.warn(`[Payment] Payment-link backup note failed for ${leadId}: ${err.message}`);
  }

  if (lead.email) {
    const dollars = (amount / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
        <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your retainer payment</h1></div>
      <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${esc((lead.fullName || 'there').split(' ')[0])},</p>
        <p>Thank you for signing your retainer agreement. To begin work on your file, please complete your ${label ? `first payment (<b>${esc(label)}</b>)` : 'retainer payment'} of <strong>${dollars}</strong>:</p>
        <p><a href="${esc(url)}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Pay your retainer securely</a></p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Once your payment is received, we'll begin onboarding right away. Questions about the fee? Just reply to this email.</p>
      </div></div>`;
    try {
      await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration retainer payment link', html });
    } catch (err) {
      // The link is preserved (Square + the backup note above), so no lock — but
      // make the failed delivery VISIBLE so staff re-share, not just a log line.
      console.warn(`[Payment] Retainer payment email FAILED for lead ${leadId}: ${err.message}`);
      try {
        await mondayApi.query(
          `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
          { itemId: String(leadId),
            body: `⚠ <b>Payment-link email FAILED to send</b> — the client has NOT received it. Please ` +
                  `re-share the link above with the client. (error: ${esc(err.message)})` }
        );
      } catch (_) { /* note is best-effort */ }
    }
  }

  console.log(`[Payment] Retainer payment link processed for lead ${leadId} (${(amount / 100)} CAD)`);
  return url;
}

module.exports = { onSquareRetainerPaymentReceived, recordRetainerPaid, sendRetainerPaymentLink, extractCompletedPayment };
