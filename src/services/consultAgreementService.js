/**
 * consultAgreementService — generates + delivers TDOT's Initial Consultation
 * agreement (a STANDALONE doc, no scope annex). Mirrors the retainer pattern:
 * consultant-triggered from the portal, pre-generated + cached at send-time, and
 * emailed to the client as a token-protected link served by /consult-agreement.
 *
 * The fee and duration have no per-lead column — they come from the booking
 * constants (SQUARE_CONSULT_FEE_CENTS / 30 min). The agreement states the client
 * address, which is captured at intake and is often blank at consult stage — so
 * this is consultant-triggered (the consultant fills the address first), never
 * auto-sent.
 */

'use strict';

const leadService        = require('./leadService');
const retainerDocService = require('./retainerDocService');
const { centsToMoney }   = require('../utils/money');
const { formatAgreementDate } = require('./retainerPlanBuilder');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

const RENDER_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
const CONSULT_DURATION = `${parseInt(process.env.CONSULT_DURATION_MINS, 10) || 30} minutes`;

function todayISO() { return new Date().toISOString().split('T')[0]; }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** PURE — the merge data + warnings for the Initial Consultation agreement. */
function buildConsultAgreementData(lead = {}) {
  const { CONSULT_FEE_CENTS } = require('./bookingService');
  const slotDate = String(lead.bookedSlot || '').split(' ')[0] || lead.consultationHeld || '';
  const data = {
    agreementDate:       formatAgreementDate(todayISO()),
    paName:              lead.fullName || lead.name || '',
    paAddress:           lead.residentialAddress || '',
    amountPaid:          centsToMoney(CONSULT_FEE_CENTS),
    consultDurationMins: CONSULT_DURATION,
    consultationDate:    formatAgreementDate(slotDate) || slotDate || '',
    paPhone:             lead.phone || '',
    paEmail:             lead.email || '',
    // signatory (routed RCIC) — the consultant this lead was booked with, so the
    // agreement names the right person. Resolved from lead.assignedConsultant.
    ...require('../../config/consultantRouting').consultantMergeFields(lead),
  };
  const warnings = [];
  if (!data.paAddress) warnings.push('Client residential address is blank — it appears on the agreement; add it before sending.');
  if (!data.paEmail)   warnings.push('Client email is blank — the agreement cannot be emailed.');
  if (!slotDate)       warnings.push('No consultation date on file — it will be blank on the agreement.');
  return { data, warnings };
}

const _cache = new Map(); // leadId → PDF Buffer
function cachePdf(leadId, buf) {
  const k = String(leadId);
  _cache.set(k, buf);
  if (_cache.size > 50) _cache.delete(_cache.keys().next().value);
}

/** Generate the consult-agreement PDF (fill the standalone template → convert). */
async function generateConsultAgreementPdf(lead) {
  const { data } = buildConsultAgreementData(lead);
  const docx = retainerDocService.fillMaster('consult', data);
  return require('./pdfConvertService').docxToPdf(docx, 'initial-consultation.docx');
}

/** Cached document for the stream route (regenerates on a cold cache). */
async function getConsultAgreementDocument(lead) {
  const key = String(lead.id);
  if (_cache.has(key)) return _cache.get(key);
  const pdf = await generateConsultAgreementPdf(lead);
  cachePdf(key, pdf);
  return pdf;
}

/**
 * Generate + email the client a token-link to their consultation agreement.
 * Re-sendable (no hard idempotency block — it's a manual, confirmed action).
 * @throws {Error} .notFound / .badRequest
 */
/**
 * Generate + cache the consultation-agreement PDF and return its token-link, so a
 * client link is instant and CloudConvert-independent. Sends NOTHING — the caller
 * decides how to deliver (standalone email, or bundled into the booking package).
 * @throws {Error} .notFound / .badRequest
 */
async function ensureConsultAgreementReady(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }
  if (!lead.email) { const e = new Error('No client email on file — cannot generate the agreement.'); e.badRequest = true; throw e; }
  let pdf;
  try { pdf = await generateConsultAgreementPdf(lead); }
  catch (err) { const e = new Error(`Could not generate the agreement: ${err.message}`); e.badRequest = true; throw e; }
  cachePdf(leadId, pdf);
  const token = lead.leadToken || '';
  const url = `${RENDER_URL}/consult-agreement/${leadId}?t=${encodeURIComponent(token)}`;
  return { lead, url };
}

/**
 * Create + distribute the Documenso consult e-sign envelope for a lead. Sends NO
 * fallback email itself — callers decide (standalone email, or the consultation
 * package's review link). On a successful envelope send it stamps
 * consultAgreementSent IMMEDIATELY (mirroring the retainer path) — the client
 * already has Documenso's signing email at that point, so the delivery must be
 * recorded even if a caller's follow-up email later fails. Returns:
 *   { envelopeId }          envelope sent + Sent stamped — the client has
 *                           Documenso's signing email
 *   { alreadySigned: true } agreement already signed (never re-issue an envelope)
 *   null                    e-sign disabled / no client email / the send failed
 *                           (logged) — caller falls back to the review-PDF link
 */
async function maybeSendConsultEsign(lead) {
  const documenso = require('./documensoService');
  if (!documenso.isEnabled() || !lead || !lead.email) return null;
  if (lead.consultAgreementSigned && String(lead.consultAgreementSigned).trim()) return { alreadySigned: true };
  let env;
  try {
    const pdf = await getConsultAgreementDocument(lead);
    env = await documenso.sendForSignature({
      pdfBuffer: pdf,
      title: `TDOT Consultation Agreement — ${lead.fullName || 'Client'}`,
      externalId: documenso.externalIdFor('consult', lead.id),
      signer: { email: lead.email, name: lead.fullName || lead.email },
      subject: 'Your TDOT Immigration consultation agreement — please sign',
      // Client signature line near the bottom of the single-page agreement.
      signaturePosition: { positionX: 25, positionY: 72, width: 28, height: 6 },
    });
  } catch (err) {
    console.error(`[ConsultAgreement] Documenso send FAILED for lead ${lead.id} — falling back to the review link: ${err.message}`);
    return null;
  }
  // Best-effort stamp — the envelope IS out; a transient Monday failure must not
  // make the caller think the e-sign send failed (that would trigger the fallback
  // email on top of Documenso's own signing email).
  try { await leadService.updateLead(lead.id, { consultAgreementSent: todayISO() }); }
  catch (err) { console.warn(`[ConsultAgreement] Sent-date stamp failed for lead ${lead.id} (envelope ${env.envelopeId} IS distributed): ${err.message}`); }
  return { envelopeId: env.envelopeId };
}

async function sendConsultAgreement(leadId) {
  const { lead, url } = await ensureConsultAgreementReady(leadId);

  // e-signature path (Documenso): send for in-browser signature; the signed
  // copy auto-captures via webhook. On any failure, fall through to the legacy
  // email so the client is never left un-served.
  const esign = await maybeSendConsultEsign(lead);
  if (esign && esign.alreadySigned) {
    // Signed already — never re-issue an envelope or email a "please review" for
    // a completed agreement.
    return { ok: true, alreadySigned: true, url };
  }
  if (esign && esign.envelopeId) {
    // Sent-date already stamped inside maybeSendConsultEsign.
    return { ok: true, via: 'documenso', envelopeId: esign.envelopeId };
  }

  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
        <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your initial consultation agreement</h1></div>
      <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${esc((lead.fullName || 'there').split(' ')[0])},</p>
        <p>Thank you for booking your initial consultation with TDOT Immigration. Please review your consultation agreement:</p>
        <p><a href="${url}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">View &amp; download your agreement (PDF)</a></p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Any questions? Just reply to this email.</p>
      </div></div>`;

  await require('./microsoftMailService').sendEmail({
    to: lead.email, subject: 'Your TDOT Immigration initial consultation agreement', html,
  });

  await leadService.updateLead(leadId, { consultAgreementSent: todayISO() });
  return { ok: true, url };
}

module.exports = {
  buildConsultAgreementData, generateConsultAgreementPdf, getConsultAgreementDocument,
  ensureConsultAgreementReady, sendConsultAgreement, maybeSendConsultEsign,
};
