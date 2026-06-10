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
 * Writes only to the Lead Board. The retainer wording below is a PLACEHOLDER —
 * swap in TDOT's real retainer text in buildRetainerPdf().
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

// ─── The retainer PDF (PLACEHOLDER wording — replace with TDOT's text) ────────
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
    const PLACEHOLDER = [
      ['1. Scope of Services', 'The Firm agrees to provide immigration consulting and representation services for the matter described above, in accordance with the rules of the College of Immigration and Citizenship Consultants (CICC).'],
      ['2. Professional Fees', 'The professional fee for this matter will be confirmed with the Client and is separate from third-party disbursements (government fees, biometrics, medical exams, translations, courier, etc.).'],
      ['3. Client Responsibilities', 'The Client agrees to provide complete, accurate, and timely information and documents. Delays or inaccuracies may affect processing times and outcomes.'],
      ['4. No Guarantee of Outcome', 'The Firm does not and cannot guarantee any particular outcome. Immigration decisions are made solely by the relevant government authorities.'],
      ['5. Confidentiality', 'All information provided by the Client will be kept confidential and used only for the purposes of this matter.'],
      ['6. Termination', 'Either party may terminate this agreement in writing. Fees for work completed up to the date of termination remain payable.'],
    ];
    for (const [h, body] of PLACEHOLDER) {
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

    doc.moveDown(2).fontSize(8).fillColor(muted)
       .text('PLACEHOLDER DRAFT — replace with TDOT\'s approved retainer wording before production use.', { align: 'center' });

    doc.end();
  });
}

// ─── Step 3: staff marked Retainer Signed → hand off + auto-send payment link ──
//
// 1. Hand off to Phase 1 (creates the Client Master case as "Signed (Unpaid)").
// 2. Auto-generate the standard-fee Square retainer payment link and email it.
//    The client pays on Square; the payment webhook (WS7) then flips Phase 1 on.
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

  // 2. Auto-send the standard retainer payment link (WS7). Idempotent.
  try {
    const fresh = await leadService.getLead(leadId);
    if (fresh && fresh.squareRetainerOrderId) {
      console.log(`[Retainer2] Retainer payment link already sent for lead ${leadId} — skipping`);
    } else if (parseInt(process.env.SQUARE_RETAINER_FEE_CENTS, 10) > 0) {
      await require('./paymentService').sendRetainerPaymentLink(leadId);
    } else {
      console.log(`[Retainer2] SQUARE_RETAINER_FEE_CENTS not set — retainer payment link NOT sent for lead ${leadId}`);
    }
  } catch (err) {
    console.warn(`[Retainer2] Retainer payment link send failed for lead ${leadId} (handoff still done): ${err.message}`);
  }
}

module.exports = { onOutcomeRetain, buildRetainerPdf, onRetainerSigned };
