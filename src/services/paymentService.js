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
  retainedBy:      'multiple_person_mm334yp5', // "Retained by" (one of the RBAC people columns)
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
    // Self-heal: if a prior maybeMarkRetained flip failed transiently, a redelivered
    // webhook / repeat "Mark paid" reconciles it here (idempotent + both-gated).
    try { await maybeMarkRetained(lead); }
    catch (e) { console.warn(`[Payment] retained reconcile (already-paid) failed for lead ${lead.id}: ${e.message}`); }
    return lead.clientMasterItemId || null;
  }

  // 1. Lead Board — record the payment. The conversion status is NOT set here:
  //    "Retained" is a BOTH-gated state (signed AND paid), so maybeMarkRetained
  //    (below) owns it — that way payment alone can never mark a client retained,
  //    and it flips the moment the second of {signed, paid} lands, either order.
  await leadService.updateLead(lead.id, {
    retainerPaid:     when,
    ...(txnId ? { squareRetainerTxnId: txnId } : {}),
  });
  console.log(`[Payment] Lead ${lead.id} retainer paid${txnId ? ` (txn ${txnId})` : reference ? ` (e-transfer ref ${reference})` : ''}`);

  // The retainer payment IS the first milestone — record it as paid on the panel.
  try { await require('./milestonePaymentService').patchPayment(lead.id, 0, { status: 'paid', paidAt: when, ...(txnId ? { txnId } : {}), ...(reference ? { reference, method: 'e-transfer' } : {}) }); } catch (_) {}

  // Signed + paid ⇒ Retained. Best-effort (never block the payment record / Phase-1
  // trigger below). Placed BEFORE the clientMasterItemId guard so a signed+paid lead
  // whose handoff failed still gets the Lead funnel flip (it just skips "Retained by").
  try { await maybeMarkRetained(lead.id); }
  catch (e) { console.warn(`[Payment] maybeMarkRetained failed for lead ${lead.id}: ${e.message}`); }

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

/** Best-effort Monday note on a lead item. */
async function postLeadNote(leadId, body) {
  try {
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
      { itemId: String(leadId), body }
    );
  } catch (err) { console.warn(`[Retained] note failed for ${leadId}: ${err.message}`); }
}

// Resolve a Monday user id from an email. Caches only DEFINITIVE results (a
// resolved id, or a confirmed "no such user"). A transient lookup FAILURE returns
// null WITHOUT caching, so the next retention retries instead of the process being
// permanently poisoned into skipping the "Retained by" (RBAC) write.
const _userIdByEmail = new Map();
async function resolveMondayUserIdByEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  if (_userIdByEmail.has(key)) return _userIdByEmail.get(key);
  let id;
  try {
    const data = await mondayApi.query(
      `query($emails: [String!]) { users(emails: $emails) { id email } }`, { emails: [key] });
    const users = (data && data.users) || [];
    const u = users.find((x) => String(x.email || '').toLowerCase() === key) || users[0];
    id = u && u.id != null ? String(u.id) : null; // definitive: resolved id or confirmed absent
  } catch (err) {
    console.warn(`[Retained] Monday user lookup failed for ${key} (not caching — will retry): ${err.message}`);
    return null; // transient — do NOT cache, so a later retention retries
  }
  _userIdByEmail.set(key, id);
  return id;
}

/**
 * Set the Client Master "Retained by" people column to the retaining consultant
 * (which also grants them RBAC visibility of the case). Best-effort and
 * non-destructive: never overwrites an existing assignment, and no-ops if the
 * consultant can't be resolved to a Monday user.
 */
async function setRetainedBy(lead) {
  if (!lead || !lead.clientMasterItemId) return { ok: false, reason: 'no-case' };
  const { resolveConsultant } = require('../../config/consultantRouting');
  const consultant = resolveConsultant(lead);
  const userId = consultant.mondayUserId || await resolveMondayUserIdByEmail(consultant.email);
  if (!userId || !Number.isFinite(Number(userId))) {
    console.warn(`[Retained] No valid Monday user id for consultant ${consultant.name} (${consultant.email}) — "Retained by" not set on CM ${lead.clientMasterItemId}`);
    return { ok: false, reason: 'no-user' };
  }

  // Don't stomp an existing "Retained by" assignment (staff may have set it).
  // FAIL CLOSED: if the current-value read fails, treat the column as possibly
  // occupied and SKIP the write — a transient read error must never overwrite a
  // human-set assignment (this column drives RBAC case visibility).
  try {
    const cur = await mondayApi.query(
      `query($id: [ID!]) { items(ids: $id) { column_values(ids: ["${CM.retainedBy}"]) { value } } }`,
      { id: [String(lead.clientMasterItemId)] });
    const raw = cur && cur.items && cur.items[0] && cur.items[0].column_values && cur.items[0].column_values[0] && cur.items[0].column_values[0].value;
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.personsAndTeams) && parsed.personsAndTeams.length) {
      console.log(`[Retained] CM ${lead.clientMasterItemId} already has "Retained by" — leaving as-is`);
      return { ok: true, already: true };
    }
  } catch (err) {
    console.warn(`[Retained] Could not verify existing "Retained by" on CM ${lead.clientMasterItemId} (${err.message}) — skipping to avoid overwriting a manual assignment`);
    return { ok: false, reason: 'read-failed' };
  }

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    { boardId: String(clientMasterBoardId), itemId: String(lead.clientMasterItemId),
      cols: JSON.stringify({ [CM.retainedBy]: { personsAndTeams: [{ id: Number(userId), kind: 'person' }] } }) }
  );
  console.log(`[Retained] CM ${lead.clientMasterItemId} "Retained by" → ${consultant.name} (user ${userId})`);
  return { ok: true, userId, consultant: consultant.name };
}

/**
 * The single authority for the terminal "Retained" state: a client is retained
 * once the retainer agreement is BOTH signed and paid — whichever lands last.
 * Called from both events (recordRetainerPaid and retainerService2.onRetainerSigned),
 * so ordering doesn't matter and a late signing can't downgrade a paid client.
 * Idempotent on both writes. Concurrent calls for the same lead collapse to one
 * execution (mirrors retainerService2._sendInFlight), so two near-simultaneous
 * webhooks can't produce a duplicate "Client retained" note. Returns a summary.
 * @param {string|object} leadOrId
 */
const _retainInFlight = new Map(); // leadId → Promise (collapse concurrent flips)
async function maybeMarkRetained(leadOrId) {
  const key = String((leadOrId && typeof leadOrId === 'object') ? leadOrId.id : leadOrId);
  if (_retainInFlight.has(key)) return _retainInFlight.get(key);
  const p = _doMaybeMarkRetained(leadOrId);
  _retainInFlight.set(key, p);
  try { return await p; } finally { _retainInFlight.delete(key); }
}

async function _doMaybeMarkRetained(leadOrId) {
  const lead = (leadOrId && typeof leadOrId === 'object') ? leadOrId : await leadService.getLead(leadOrId);
  if (!lead) return { ok: false, reason: 'no-lead' };
  const signed = Boolean(String(lead.retainerSigned || '').trim());
  const paid   = Boolean(String(lead.retainerPaid || '').trim());
  if (!(signed && paid)) return { ok: false, retained: false, signed, paid };

  // 1. Lead funnel → clean terminal "Retained" (idempotent; only writes on change).
  const wasRetained = lead.conversionStatus === 'Retained';
  if (!wasRetained) {
    await leadService.updateLead(lead.id, { conversionStatus: 'Retained' });
    await postLeadNote(lead.id,
      '🎉 <b>Client retained</b> — retainer agreement signed and payment received. Conversion status set to "Retained".');
    console.log(`[Retained] Lead ${lead.id} → Retained (signed ${lead.retainerSigned}, paid ${lead.retainerPaid})`);
  }

  // 2. Client Master → "Retained by" the retaining consultant (best-effort; also
  //    grants RBAC visibility). Idempotent + non-destructive inside setRetainedBy.
  let retainedBy = null;
  if (lead.clientMasterItemId) {
    try { retainedBy = await setRetainedBy(lead); }
    catch (err) { console.warn(`[Retained] "Retained by" write failed for lead ${lead.id} → CM ${lead.clientMasterItemId}: ${err.message}`); }
  }
  return { ok: true, retained: true, statusChanged: !wasRetained, retainedBy };
}

module.exports = {
  onSquareRetainerPaymentReceived, recordRetainerPaid, sendRetainerPaymentLink,
  extractCompletedPayment, maybeMarkRetained, setRetainedBy,
  _resetRetainedCaches: () => _userIdByEmail.clear(), // test hook (the cache is stable in prod)
};
