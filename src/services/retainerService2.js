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
const { feeToCents } = require('../utils/money');

const RENDER_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

function todayISO() { return new Date().toISOString().split('T')[0]; }

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Retainer engine: v1 (generic pdfkit) | v2 (TDOT's real templates) ───────
// v2 is OFF by default and opt-in via RETAINER_ENGINE=v2. When on, the agreement
// is built from the consultant's saved plan (template + scope annex + fees +
// milestones) using retainerDocService; the send is gated on the plan being
// READY and the PDF is pre-generated + cached at send-time so the client's view
// never depends on CloudConvert being up.
function isV2() { return String(process.env.RETAINER_ENGINE || 'v1').trim().toLowerCase() === 'v2'; }

const _pdfCache = new Map(); // leadId → PDF Buffer (warmed at send-time, served by the /retainer route)
function cacheRetainerPdf(leadId, buf) {
  const key = String(leadId);
  _pdfCache.set(key, buf);
  if (_pdfCache.size > 50) _pdfCache.delete(_pdfCache.keys().next().value); // evict oldest
}

/** Build the plan from the lead's saved columns and render the combined PDF (v2). */
async function generateV2Pdf(lead) {
  const { buildRetainerPlan, overridesFromLead } = require('./retainerPlanBuilder');
  const plan = buildRetainerPlan(lead, overridesFromLead(lead));
  if (!plan.ready) {
    const e = new Error(plan.warnings.join(' · ') || 'The retainer plan is not complete.');
    e.notReady = true; e.warnings = plan.warnings;
    throw e;
  }
  return require('./retainerDocService').generate({
    template: plan.template, data: plan.mergeData, annexId: plan.annex.id,
  });
}

/**
 * The PDF the /retainer/:leadId route streams. v1 → the generic pdfkit doc;
 * v2 → the cached (or freshly generated) real-template PDF.
 */
async function getRetainerDocument(lead) {
  if (!isV2()) return buildRetainerPdf(lead);
  const key = String(lead.id);
  if (_pdfCache.has(key)) return _pdfCache.get(key);
  const pdf = await generateV2Pdf(lead);
  cacheRetainerPdf(key, pdf);
  return pdf;
}

// ─── Step 1: Outcome → Retain (GATED on the per-client fee being set) ────────
//
// The retainer agreement STATES the professional fee, so it must never be
// emailed before the "Retainer Fee (CAD)" is set on the lead. Like the payment
// link, the agreement send is therefore guarded and driven by TWO triggers —
// the Outcome=Retain change AND the Retainer Fee change — so staff/consultants
// can set them in either order; the agreement emails the moment BOTH are true.
// Concurrent calls (fee + outcome set seconds apart) collapse to one send so
// the client never receives two agreement emails.

const _agreementInFlight = new Map(); // leadId → Promise

/** Public entry from the Outcome=Retain webhook — notifies if the fee is missing. */
async function onOutcomeRetain(leadId) {
  return maybeSendRetainerAgreement(leadId, { notifyIfMissing: true });
}

/**
 * Send the retainer agreement if (and only if) the lead is ready: Outcome is
 * "Retain", a per-client fee is set, and it hasn't been sent yet. Called from
 * BOTH the Outcome webhook and the Retainer Fee webhook.
 * opts.notifyIfMissing — post a staff note when the fee is missing (the Outcome
 *   path sets this; fee-column edits don't, so retyping the fee can't spam notes).
 */
async function maybeSendRetainerAgreement(leadId, opts = {}) {
  const key = String(leadId);
  if (_agreementInFlight.has(key)) return _agreementInFlight.get(key);
  const p = _doMaybeSendRetainerAgreement(leadId, opts);
  _agreementInFlight.set(key, p);
  try { return await p; } finally { _agreementInFlight.delete(key); }
}

async function _doMaybeSendRetainerAgreement(leadId, { notifyIfMissing = false } = {}) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return;
  if (lead.retainerSent) {
    console.log(`[Retainer2] Retainer already sent for lead ${leadId} — skipping`);
    return;
  }
  if (lead.outcome !== 'Retain') {
    return; // fee set on a not-yet-retained lead — nothing to send
  }
  if (!feeToCents(lead.retainerFee)) {
    console.log(`[Retainer2] Outcome is Retain but no Retainer Fee set for lead ${leadId} — agreement HELD`);
    if (notifyIfMissing) {
      await postLeadNote(leadId,
        '⚠ Outcome is set to "Retain", but no Retainer Fee is set. The retainer agreement states the fee, so it has NOT been emailed yet — enter the "Retainer Fee (CAD)" on this lead and the agreement is emailed to the client automatically.');
    }
    return;
  }

  // v2: the agreement is the real-template PDF built from the consultant's saved
  // plan. Hold the send until the plan is READY, and pre-generate + cache the PDF
  // now so the client's view is instant and CloudConvert-independent. Either gate
  // failure leaves the lead un-sent (retries) and posts a visible staff note.
  if (isV2()) {
    try {
      const pdf = await generateV2Pdf(lead);
      cacheRetainerPdf(leadId, pdf);
    } catch (err) {
      if (err.notReady) {
        console.log(`[Retainer2] v2 plan not ready for lead ${leadId} — agreement HELD`);
        if (notifyIfMissing) {
          await postLeadNote(leadId,
            `⚠ <b>Retainer agreement HELD — the retainer plan isn't complete.</b> Open the consultant portal → ` +
            `"Retainer plan" for this client and resolve: ${esc(err.warnings ? err.warnings.join(' · ') : err.message)}`);
        }
      } else {
        console.warn(`[Retainer2] v2 generation FAILED for lead ${leadId}: ${err.message}`);
        await postLeadNote(leadId,
          `⚠ <b>Retainer agreement generation FAILED</b> — NOT sent; the lead was left un-sent so it retries. ` +
          `Check the scope annex is available and CloudConvert credits.<br>(error: ${esc(err.message)})`);
      }
      return;
    }
  }

  const token = lead.leadToken || '';
  const url = `${RENDER_URL}/retainer/${leadId}?t=${encodeURIComponent(token)}`;

  // Invariant: mark retainerSent (the idempotency lock) ONLY when the agreement
  // was actually DELIVERED. A no-email lead or a failed send must NOT lock the
  // lead — otherwise the guard above blocks every retry and the client silently
  // never gets the agreement. Both non-delivery paths post a VISIBLE staff note.
  if (!lead.email) {
    console.warn(`[Retainer2] No email on file for lead ${leadId} — agreement NOT sent`);
    await postLeadNote(leadId,
      `⚠ <b>Retainer agreement not sent — no client email on file.</b> Add the client's email and re-set ` +
      `the Outcome to "Retain" to send. The agreement link: <a href="${esc(url)}">${esc(url)}</a>`);
    return;
  }

  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
        <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your retainer agreement</h1></div>
      <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${esc((lead.fullName || 'there').split(' ')[0])},</p>
        <p>Thank you for choosing TDOT Immigration. Please review your retainer agreement, which sets out the professional fee for your matter:</p>
        <p><a href="${url}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">View &amp; download your retainer (PDF)</a></p>
        <p style="margin-top:20px">To proceed: sign the agreement and email the signed copy back to us. Once we receive it, we'll send your secure payment link.</p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Questions about the fee? Just reply to this email.</p>
      </div></div>`;
  try {
    await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration retainer agreement', html });
  } catch (err) {
    // Do NOT mark sent — leave the lead un-locked so the next trigger retries.
    console.warn(`[Retainer2] Retainer email FAILED for lead ${leadId}: ${err.message}`);
    await postLeadNote(leadId,
      `⚠ <b>Retainer agreement email FAILED to send</b> — the client has NOT received it. The lead was left ` +
      `un-sent so it retries automatically; to resend now, switch the Outcome away from "Retain" and back. ` +
      `The agreement link is valid: <a href="${esc(url)}">${esc(url)}</a><br>(error: ${esc(err.message)})`);
    return;
  }

  await leadService.updateLead(leadId, {
    retainerSent:     todayISO(),
    conversionStatus: 'Consulted',
  });
  console.log(`[Retainer2] Retainer agreement sent to lead ${leadId} (${lead.email}) — fee included`);
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

    // The professional fee is stated explicitly when the per-client Retainer
    // Fee is set (the agreement is only ever emailed once it is — see
    // maybeSendRetainerAgreement). Defensive fallback keeps the generic clause
    // if the PDF is ever rendered before a fee exists.
    const feeC = feeToCents(lead.retainerFee);
    const feeClause = feeC
      ? `The professional fee for this matter is $${(feeC / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CAD. This fee is separate from third-party disbursements (government fees, biometrics, medical exams, translations, courier, etc.) and any applicable taxes.`
      : 'The professional fee for this matter will be confirmed with the Client and is separate from third-party disbursements (government fees, biometrics, medical exams, translations, courier, etc.).';

    doc.moveDown(1).fillColor('#111111').fontSize(11);
    const STANDARD_TERMS = [
      ['1. Scope of Services', 'The Firm agrees to provide immigration consulting and representation services for the matter described above, in accordance with the rules of the College of Immigration and Citizenship Consultants (CICC).'],
      ['2. Professional Fees', feeClause],
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

module.exports = { onOutcomeRetain, maybeSendRetainerAgreement, buildRetainerPdf, getRetainerDocument, onRetainerSigned, maybeSendRetainerPaymentLink, feeToCents };
