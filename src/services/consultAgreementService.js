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
  // The agreement must state what the client ACTUALLY chose and paid — the
  // booking-page option (per-consultant duration + fee) wins over the env
  // defaults, which remain the fallback for legacy leads.
  const opt = require('./consultationService').parseConsultOption(lead);
  const feeCents = (opt && Number.isFinite(opt.feeCents)) ? opt.feeCents : CONSULT_FEE_CENTS;
  const durationText = opt ? `${opt.durationMin} minutes` : CONSULT_DURATION;
  // "has paid {amountPaid}" must state the amount actually COLLECTED: the
  // Square webhook records paidCents on the option (fee + HST since
  // 2026-08-14). Legacy leads without it keep the pre-tax fee — which is what
  // those clients really paid.
  const paidCents = (opt && Number.isFinite(Number(opt.paidCents)) && Number(opt.paidCents) > 0) ? Number(opt.paidCents) : null;
  const amountPaidText = paidCents != null
    ? `${centsToMoney(paidCents)}${paidCents > feeCents ? ' (incl. HST)' : ''}`
    : centsToMoney(feeCents);
  const data = {
    agreementDate:       formatAgreementDate(todayISO()),
    paName:              lead.fullName || lead.name || '',
    paAddress:           lead.residentialAddress || '',
    amountPaid:          amountPaidText,
    consultDurationMins: durationText,
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
  // email on top of Documenso's own signing email). The client envelope ids ride
  // along in the countersign state — they're the download fallback for the
  // client-signed PDF when the RCIC later countersigns.
  try {
    await leadService.updateLead(lead.id, {
      consultAgreementSent: todayISO(),
      consultCountersign: JSON.stringify({
        ...parseCountersign(lead),
        clientEnvelopeId: env.envelopeId, clientItemId: env.envelopeItemId || '',
      }),
    });
  }
  catch (err) { console.warn(`[ConsultAgreement] Sent-date stamp failed for lead ${lead.id} (envelope ${env.envelopeId} IS distributed): ${err.message}`); }
  return { envelopeId: env.envelopeId };
}

// ─── RCIC countersign (second envelope over the client-signed PDF) ───────────

/** PURE — the countersign state stored as JSON on the lead ({} when unset). */
function parseCountersign(lead) {
  try {
    const v = JSON.parse(String((lead && lead.consultCountersign) || ''));
    return (v && typeof v === 'object') ? v : {};
  } catch (_) { return {}; }
}

/**
 * PURE — a signing URL is only trusted when it is https on the Documenso host
 * we're configured against. The value round-trips through a Monday text column,
 * and the portal NAVIGATES a staff browser to it — a tampered column value must
 * become '' (the consultant still has Documenso's own emailed link), never an
 * open redirect.
 */
function safeSignUrl(u) {
  try {
    const x = new URL(String(u || ''));
    const base = new URL(process.env.DOCUMENSO_BASE_URL || 'https://app.documenso.com/api/v2');
    return (x.protocol === 'https:' && x.host === base.host) ? x.href : '';
  } catch (_) { return ''; }
}

async function _storeSignedToOneDrive(lead, pdf) {
  const oneDrive = require('./oneDriveService');
  // Best-known folder first: once a case opens, the client folder is RENAMED
  // to "{name} - {caseRef}" — writing by the old LEAD name would resurrect a
  // stale folder. Shared resolution with the retainer countersign.
  const [ref] = await require('./retainerCountersignService').candidateFolderRefs(lead);
  await oneDrive.uploadFile({ ...ref, category: 'Consultation', filename: 'consultation-agreement-SIGNED.pdf', buffer: pdf, mimeType: 'application/pdf' });
}

/**
 * The signed consultation-agreement PDF, newest signature state first.
 * Once the RCIC has countersigned, the consult2 envelope is the source of truth
 * — a replayed client-completion webhook can regress the OneDrive canonical
 * file to the client-only copy, so the countersigned download comes FIRST and
 * heals the canonical copy on the way through. Before the countersign, the
 * OneDrive copy (stored at client completion) leads, with the client envelope
 * download as the fallback. Returns null when nothing signed is retrievable.
 */
async function getSignedConsultPdf(lead) {
  const leadId = lead.id;
  const documenso = require('./documensoService');
  const cs = parseCountersign(lead);
  if (cs.signedAt) {
    // The item id can be blank (some envelope-create responses omit it) —
    // recover it from the envelope itself before giving up on the download.
    let itemId = cs.itemId;
    if (!itemId && cs.envelopeId) {
      try {
        const env = await documenso.getEnvelope(cs.envelopeId);
        itemId = env && env.envelopeItems && env.envelopeItems[0] && env.envelopeItems[0].id;
      } catch (_) { /* fall through to OneDrive */ }
    }
    if (itemId) {
      try {
        const pdf = await documenso.downloadSignedPdf(itemId);
        if (pdf && pdf.length) {
          try { await _storeSignedToOneDrive(lead, pdf); } catch (_) { /* heal is best-effort */ }
          return pdf;
        }
      } catch (err) { console.warn(`[ConsultAgreement] Countersigned download failed (item ${itemId}, lead ${leadId}) — falling back to OneDrive: ${err.message}`); }
    }
  }
  // OneDrive: the case folder first (renamed at case-open — a retained client's
  // consult copy moved with it), then the pre-case LEAD-named folder.
  try {
    const oneDrive = require('./oneDriveService');
    const { candidateFolderRefs } = require('./retainerCountersignService');
    for (const ref of await candidateFolderRefs(lead)) {
      const pdf = await oneDrive.readFile({ ...ref, subfolder: 'Consultation', filename: 'consultation-agreement-SIGNED.pdf' }).catch(() => null);
      if (pdf && pdf.length) return pdf;
    }
  } catch (err) { console.warn(`[ConsultAgreement] OneDrive signed-copy read failed for lead ${leadId}: ${err.message}`); }
  for (const itemId of [cs.clientItemId].filter(Boolean)) {
    try {
      const pdf = await documenso.downloadSignedPdf(itemId);
      if (pdf && pdf.length) return pdf;
    } catch (err) { console.warn(`[ConsultAgreement] Documenso signed download failed (item ${itemId}, lead ${leadId}): ${err.message}`); }
  }
  return null;
}

/**
 * Issue (or return the already-issued) RCIC countersign envelope for a lead
 * whose CLIENT has signed the consultation agreement. Idempotent — a stored
 * envelopeId is returned as-is, so double-clicks and re-opens never mint a
 * second envelope. Returns:
 *   { alreadySigned: true }        the RCIC already countersigned
 *   { envelopeId, signUrl, resumed } envelope out (resumed = it already existed);
 *                                  signUrl may be '' — Documenso emailed the
 *                                  consultant their signing link regardless
 * @throws {Error} .badRequest / .notFound with staff-readable messages
 */
const _countersignInFlight = new Map(); // leadId → Promise — concurrent portal clicks share ONE issue attempt

async function startConsultCountersign(leadId) {
  const key = String(leadId);
  // A concurrent caller awaits the SAME issue and must be able to tell it
  // didn't cause one — otherwise two webhook deliveries each announce an
  // envelope that was only created once.
  if (_countersignInFlight.has(key)) return _countersignInFlight.get(key).then((r) => ({ ...r, coalesced: true }));
  const p = _doStartConsultCountersign(leadId).finally(() => _countersignInFlight.delete(key));
  _countersignInFlight.set(key, p);
  return p;
}

async function _doStartConsultCountersign(leadId) {
  const documenso = require('./documensoService');
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }
  if (!documenso.isEnabled()) { const e = new Error('E-signing (Documenso) is not enabled.'); e.badRequest = true; throw e; }
  if (!(lead.consultAgreementSigned && String(lead.consultAgreementSigned).trim())) {
    const e = new Error('The client has not signed the consultation agreement yet — the consultant signs after the client.');
    e.badRequest = true; throw e;
  }
  const cs = parseCountersign(lead);
  if (cs.signedAt) return { alreadySigned: true };
  if (cs.envelopeId) {
    // Envelopes issued before signing-link resolution existed stored no URL —
    // recover it now so the resumed click still opens the signing page.
    let url = safeSignUrl(cs.signUrl);
    if (!url) {
      url = safeSignUrl(await documenso.recipientSignUrl(cs.envelopeId));
      if (url) leadService.updateLead(leadId, { consultCountersign: JSON.stringify({ ...cs, signUrl: url }) }).catch(() => {});
    }
    return { envelopeId: cs.envelopeId, signUrl: url, resumed: true };
  }

  const consultant = require('../../config/consultantRouting').resolveConsultant(lead);
  if (!consultant || !consultant.email) {
    const e = new Error('No consultant email on record — cannot issue the countersign envelope.');
    e.badRequest = true; throw e;
  }

  // The document being countersigned is the CLIENT-SIGNED copy — never the
  // unsigned draft, so the final PDF carries both signatures.
  const pdf = await getSignedConsultPdf(lead);
  if (!pdf) {
    const e = new Error('The client-signed agreement PDF could not be retrieved (OneDrive + Documenso) — cannot start the countersign.');
    e.badRequest = true; throw e;
  }

  let env;
  try {
    env = await documenso.sendForSignature({
      pdfBuffer: pdf,
      title: `TDOT Consultation Agreement — ${lead.fullName || 'Client'} (RCIC countersign)`,
      externalId: documenso.externalIdFor('consult2', lead.id),
      signer: { email: consultant.email, name: consultant.name || consultant.email },
      subject: `Countersign: consultation agreement — ${lead.fullName || 'client'}`,
      message: 'The client has signed their initial consultation agreement. Please add your signature as the consulting RCIC.',
      // The RCIC signature line sits directly BELOW the client's (client line is
      // calibrated at y=72) — worth eyeballing on the first live countersign.
      signaturePosition: { positionX: 25, positionY: 79, width: 28, height: 6 },
    });
  } catch (err) {
    console.error(`[ConsultAgreement] Countersign envelope FAILED for lead ${leadId}: ${err.message}`);
    const e = new Error(`Could not issue the countersign envelope: ${err.message}`);
    e.badRequest = true; throw e;
  }

  // The envelope IS out — persist its ids so retries return it instead of
  // minting duplicates. This write is the dedupe record, so it gets one retry;
  // if Monday still refuses, surface persistFailed so staff know a later click
  // may issue a duplicate envelope.
  const state = { ...cs, envelopeId: env.envelopeId, itemId: env.envelopeItemId || '', signUrl: safeSignUrl(env.signUrl), sentAt: todayISO() };
  let persistFailed = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await leadService.updateLead(leadId, { consultCountersign: JSON.stringify(state) }); persistFailed = false; break; }
    catch (err) {
      persistFailed = true;
      console.warn(`[ConsultAgreement] Countersign state persist attempt ${attempt} failed for lead ${leadId} (envelope ${env.envelopeId} IS distributed — a retry may duplicate it): ${err.message}`);
    }
  }
  return { envelopeId: env.envelopeId, signUrl: state.signUrl, ...(persistFailed ? { persistFailed: true } : {}) };
}

/**
 * consult2 webhook completion: stamp signedAt on the countersign state and email
 * the client their fully-signed copy (attached). The state write is the critical
 * step; the email is best-effort with a loud staff note on failure.
 */
async function recordCountersignComplete(lead, { signedPdf, stored } = {}) {
  const leadId = lead.id;
  // Re-read for freshness AND idempotency: Documenso delivers webhooks at least
  // once, and the recapture tool can replay completions — a countersign that is
  // already recorded must not re-stamp, re-email the client, or re-note.
  const fresh = await leadService.getLead(leadId).catch(() => null);
  const current = parseCountersign(fresh || lead);
  if (current.signedAt) return { emailed: false, signedAt: current.signedAt, alreadyRecorded: true };
  const state = { ...current, signedAt: todayISO() };
  await leadService.updateLead(leadId, { consultCountersign: JSON.stringify(state) });

  // The email PROMISES a fully-signed copy, so its attachment may only come from
  // the consult2 envelope itself — never from getSignedConsultPdf, whose OneDrive
  // first-preference can still be the CLIENT-ONLY copy when the webhook download
  // failed (stored=false). No honest PDF → no email; staff forward manually.
  let emailed = false;
  let pdf = (signedPdf && signedPdf.length) ? signedPdf : null;
  if (!pdf && state.itemId) {
    try {
      pdf = await require('./documensoService').downloadSignedPdf(state.itemId);
      if (pdf && pdf.length && !stored) {
        // Repair the canonical OneDrive copy while we have the real thing.
        try { await _storeSignedToOneDrive(lead, pdf); } catch (_) { /* store stays best-effort */ }
      }
    } catch (err) { console.warn(`[ConsultAgreement] Countersigned PDF re-download failed for lead ${leadId}: ${err.message}`); }
  }
  if (lead.email && pdf && pdf.length) {
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
        <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your signed consultation agreement</h1></div>
      <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${esc((lead.fullName || 'there').split(' ')[0])},</p>
        <p>Your initial consultation agreement has now been signed by both you and your consultant. Your copy of the fully signed agreement is attached to this email for your records.</p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Any questions? Just reply to this email.</p>
      </div></div>`;
    try {
      await require('./microsoftMailService').sendEmail({
        to: lead.email, subject: 'Your fully signed TDOT Immigration consultation agreement', html,
        attachments: [{ filename: 'consultation-agreement-signed.pdf', buffer: pdf, mimeType: 'application/pdf' }],
      });
      emailed = true;
    } catch (err) { console.error(`[ConsultAgreement] Fully-signed copy email FAILED for lead ${leadId}: ${err.message}`); }
  }

  try {
    await require('./mondayApi').query(
      `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId), b: emailed
        ? `✍️ <b>Consultation agreement countersigned by the consultant</b>${stored ? ' — fully-signed copy saved to OneDrive and' : ' —'} emailed to the client.`
        : `✍️ <b>Consultation agreement countersigned by the consultant</b>${stored ? ' — fully-signed copy saved to OneDrive.' : '.'} ⚠️ The client copy email did NOT go out — please forward the signed agreement to the client manually.` }
    );
  } catch (err) { console.warn(`[ConsultAgreement] countersign note failed for ${leadId}: ${err.message}`); }
  return { emailed, signedAt: state.signedAt };
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
  parseCountersign, getSignedConsultPdf, startConsultCountersign, recordCountersignComplete, safeSignUrl,
};
