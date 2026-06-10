/**
 * Retainer Service 2 (Phase 2 — WS5, Option B: email PDF + one-click signed)
 *
 * Named retainerService2 to avoid colliding with Phase 1's retainerService.js.
 *
 * Flow (no e-signature tool):
 *   1. Staff set Lead Board Outcome = "Retain"  → onOutcomeRetain()
 *        → generate a filled retainer PDF (pdfkit), email the client a link
 *          to it, set Retainer Sent.
 *   2. Client signs & emails the PDF back (as today).
 *   3. Staff set the "Retainer Signed" date on the Lead Board → onRetainerSigned()
 *        → calls handoffService (WS6) to create the Phase 1 case.
 *
 * Writes only to the Lead Board. The PDF uses standard retainer wording
 * (client-approved for now) — swap in TDOT's official text in
 * buildRetainerPdf() if/when they provide it.
 */

'use strict';

const PDFDocument   = require('pdfkit');
const leadService   = require('./leadService');
const microsoftMail = require('./microsoftMailService');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

const RENDER_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

function todayISO() { return new Date().toISOString().split('T')[0]; }

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Step 1: Outcome → Retain ────────────────────────────────────────────────
async function onOutcomeRetain(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return;
  if (lead.retainerSent) {
    console.log(`[Retainer2] Retainer already sent for lead ${leadId} — skipping`);
    return;
  }

  const token = lead.leadToken || '';
  const url = `${RENDER_URL}/retainer/${leadId}?t=${encodeURIComponent(token)}`;
  if (lead.email) {
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
        <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your retainer agreement</h1></div>
      <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${esc((lead.fullName || 'there').split(' ')[0])},</p>
        <p>Thank you for choosing TDOT Immigration. Please review your retainer agreement:</p>
        <p><a href="${url}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">View &amp; download your retainer (PDF)</a></p>
        <p style="margin-top:20px">To proceed: sign the agreement and email the signed copy back to us. Once we receive it, we'll send your secure payment link.</p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Questions about the fee? Just reply to this email.</p>
      </div></div>`;
    try {
      await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration retainer agreement', html });
    } catch (err) {
      console.warn(`[Retainer2] Retainer email failed for lead ${leadId} (link still valid): ${err.message}`);
    }
  }

  await leadService.updateLead(leadId, {
    retainerSent:     todayISO(),
    conversionStatus: 'Consulted',
  });
  console.log(`[Retainer2] Retainer sent to lead ${leadId} (${lead.email || 'no email'})`);
}

// ─── The retainer PDF (standard wording — swap in TDOT's official text when provided) ──
function buildRetainerPdf(lead) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy = BRAND.darkPanel, red = BRAND.primary, muted = BRAND.mutedOnLight;

    doc.fillColor(red).fontSize(20).text('TDOT Immigration', { align: 'left' });
    doc.fillColor(navy).fontSize(14).text('Retainer Agreement', { align: 'left' });
    doc.moveDown(0.5).fillColor(muted).fontSize(10)
       .text('20 De Boers Dr Suite 321, North York, ON M3J 0H1 · www.tdotimm.com');
    doc.moveDown(1).strokeColor('#DDDDDD').moveTo(56, doc.y).lineTo(556, doc.y).stroke();

    doc.moveDown(1).fillColor('#111111').fontSize(11);
    doc.text(`Date: ${todayISO()}`);
    doc.moveDown(0.5);
    doc.text('This Retainer Agreement is entered into between TDOT Immigration ("the Firm") and:');
    doc.moveDown(0.5).fontSize(11).fillColor(navy)
       .text(`Client: ${lead.fullName || ''}`)
       .text(`Email: ${lead.email || ''}`)
       .text(`Matter / Case Type: ${lead.caseTypeInterest || ''}`);

    doc.moveDown(1).fillColor('#111111').fontSize(11);
    const STANDARD_TERMS = [
      ['1. Scope of Services', 'The Firm agrees to provide immigration consulting and representation services for the matter described above, in accordance with the rules of the College of Immigration and Citizenship Consultants (CICC).'],
      ['2. Professional Fees', 'The professional fee for this matter will be confirmed with the Client and is separate from third-party disbursements (government fees, biometrics, medical exams, translations, courier, etc.).'],
      ['3. Client Responsibilities', 'The Client agrees to provide complete, accurate, and timely information and documents. Delays or inaccuracies may affect processing times and outcomes.'],
      ['4. No Guarantee of Outcome', 'The Firm does not and cannot guarantee any particular outcome. Immigration decisions are made solely by the relevant government authorities.'],
      ['5. Confidentiality', 'All information provided by the Client will be kept confidential and used only for the purposes of this matter.'],
      ['6. Termination', 'Either party may terminate this agreement in writing. Fees for work completed up to the date of termination remain payable.'],
    ];
    for (const [h, body] of STANDARD_TERMS) {
      doc.moveDown(0.6).fillColor(navy).fontSize(11).text(h);
      doc.fillColor('#111111').fontSize(10).text(body, { align: 'justify' });
    }

    doc.moveDown(2).fillColor('#111111').fontSize(11);
    doc.text('Signed:');
    doc.moveDown(1.5);
    doc.text('______________________________            ______________________________');
    doc.fontSize(9).fillColor(muted).text('Client signature                                          Date', { continued: false });
    doc.moveDown(1.5).fillColor('#111111').fontSize(11)
       .text('______________________________            ______________________________');
    doc.fontSize(9).fillColor(muted).text('TDOT Immigration (authorized representative)          Date');

    doc.end();
  });
}

// ─── Step 3: staff marked Retainer Signed → hand off + auto-send payment link ──
//
// 1. Hand off to Phase 1 (creates the Client Master case as "Signed (Unpaid)").
// 2. Auto-generate the Square retainer payment link for THIS client's fee
//    (the "Retainer Fee (CAD)" column on the lead — fees vary per client) and
//    email it. The client pays on Square; the payment webhook (WS7) then flips
//    Phase 1 on. If the fee isn't set yet, staff get a note on the lead, and
//    the link goes out automatically the moment they fill the fee in (the
//    Retainer Fee column webhook calls maybeSendRetainerPaymentLink too).
//
// Both steps are idempotent — handoff dedups internally, and the payment link is
// only sent if one hasn't been generated yet (no Square Retainer Order Id).
async function onRetainerSigned(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return;
  if (!lead.retainerSigned) {
    await leadService.updateLead(leadId, { retainerSigned: todayISO() });
  }

  // 1. Hand off to Phase 1 (WS6). Safe no-op until handoffService exists.
  let handoff;
  try { handoff = require('./handoffService'); } catch (_) { handoff = null; }
  if (handoff && handoff.onRetainerSigned) {
    await handoff.onRetainerSigned({ leadId });
  } else {
    console.log(`[Retainer2] Retainer signed for lead ${leadId} — handoffService (WS6) not built yet`);
  }

  // 2. Auto-send the payment link (WS7) for this client's fee.
  try {
    await maybeSendRetainerPaymentLink(leadId, { notifyIfMissing: true });
  } catch (err) {
    console.warn(`[Retainer2] Retainer payment link send failed for lead ${leadId} (handoff still done): ${err.message}`);
  }
}

/** Parse a Monday "Retainer Fee (CAD)" value (dollars) into cents, or null. */
function feeToCents(value) {
  const n = parseFloat(String(value == null ? '' : value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

const _sendInFlight = new Map(); // leadId → Promise (collapses concurrent webhook calls)

/** Best-effort Monday update on the lead item (staff-facing note). */
async function postLeadNote(leadId, body) {
  try {
    const mondayApi = require('./mondayApi');
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
      { itemId: String(leadId), body }
    );
  } catch (_) { /* note is best-effort */ }
}

/**
 * Send the retainer payment link if (and only if) the lead is ready:
 * retainer signed, no link sent yet, and a per-client Retainer Fee is set.
 * Called from onRetainerSigned AND from the Retainer Fee column webhook, so
 * staff can fill the fee in before or after marking signed — either order
 * works. Concurrent calls (fee + signed set seconds apart) collapse to one
 * send so the client never gets two payment links.
 *
 * opts.notifyIfMissing — post a staff note when the fee is missing. Only the
 *   signing path sets this (one note per signing); fee-column edits don't, so
 *   clearing/retyping the fee can't spam notes.
 * opts.warnIfSent — post a staff note when a fee EDIT lands after the link
 *   already went out (the edit does NOT change the sent link).
 */
async function maybeSendRetainerPaymentLink(leadId, opts = {}) {
  const key = String(leadId);
  if (_sendInFlight.has(key)) return _sendInFlight.get(key);
  const p = _doMaybeSendRetainerPaymentLink(leadId, opts);
  _sendInFlight.set(key, p);
  try { return await p; } finally { _sendInFlight.delete(key); }
}

async function _doMaybeSendRetainerPaymentLink(leadId, { notifyIfMissing = false, warnIfSent = false } = {}) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return;
  if (!lead.retainerSigned) return; // fee set early — wait for signing
  if (lead.squareRetainerOrderId) {
    console.log(`[Retainer2] Retainer payment link already sent for lead ${leadId} — skipping`);
    if (warnIfSent) {
      await postLeadNote(leadId,
        'ℹ A retainer payment link was already emailed to this client — changing the Retainer Fee does not update it. ' +
        'If the amount must change, contact the administrator to reissue the link.');
    }
    return;
  }

  const amountCents = feeToCents(lead.retainerFee);
  if (!amountCents) {
    console.log(`[Retainer2] No Retainer Fee set for lead ${leadId} — payment link NOT sent`);
    if (notifyIfMissing) {
      await postLeadNote(leadId,
        '⚠ Retainer signed, but no Retainer Fee is set. Enter the "Retainer Fee (CAD)" on this lead and the Square payment link will be emailed to the client automatically.');
    }
    return;
  }

  await require('./paymentService').sendRetainerPaymentLink(leadId, { amountCents });
}

module.exports = { onOutcomeRetain, buildRetainerPdf, onRetainerSigned, maybeSendRetainerPaymentLink, feeToCents };
