/**
 * retainerCountersignService — the RCIC's countersignature on the CLIENT-SIGNED
 * retainer agreement. Mirrors the consultation countersign (consultAgreementService)
 * with the same hardening, built as its own module so the live consult flow
 * stays untouched:
 *   - a SECOND Documenso envelope (externalId retainer2-<leadId>) wrapping the
 *     client-signed PDF, sole signer = the routed RCIC
 *   - field ANCHORED to the "Signature of RCIC" label (never a fixed % — the
 *     Praj incident), static fallback only when the PDF can't be parsed
 *   - state as JSON in lead column retainerCountersign {clientEnvelopeId,
 *     clientItemId, envelopeId, itemId, signUrl, sentAt, signedAt}
 *   - on completion: fully-signed PDF replaces the canonical OneDrive copy and
 *     is emailed to the client as an attachment
 *   - idempotent completion, single-flight issue, origin-checked signUrl
 *
 * Storage nuance vs the consult flow: a signed retainer ALWAYS opens a case,
 * which renames the client folder from "{name} - LEAD-{id}" to
 * "{name} - {caseRef}" — so reads/writes resolve the REAL case ref first and
 * only fall back to the LEAD-named folder.
 */

'use strict';

const leadService = require('./leadService');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

const SIGNED_FILENAME = 'retainer-agreement-SIGNED.pdf';
const CM_CASE_REF_COL = 'text_mm142s49'; // Client Master "Case Reference Number" (see handoffService.CM)

function todayISO() { return new Date().toISOString().split('T')[0]; }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** PURE — the countersign state stored as JSON on the lead ({} when unset). */
function parseRetainerCountersign(lead) {
  try {
    const v = JSON.parse(String((lead && lead.retainerCountersign) || ''));
    return (v && typeof v === 'object') ? v : {};
  } catch (_) { return {}; }
}

/**
 * The OneDrive folder refs to try, most-likely first: the renamed case folder
 * ("{name} - {caseRef}", read live from Client Master) and the pre-rename lead
 * folder ("{name} - LEAD-{id}").
 */
async function candidateFolderRefs(lead) {
  const clientName = lead.fullName || `Lead ${lead.id}`;
  const refs = [];
  if ((lead.clientMasterItemId || '').trim()) {
    try {
      const d = await require('./mondayApi').query(
        `query($i: [ID!]){ items(ids: $i){ column_values(ids: ["${CM_CASE_REF_COL}"]){ text } } }`,
        { i: [String(lead.clientMasterItemId)] });
      const caseRef = ((d.items[0].column_values[0] || {}).text || '').trim();
      if (caseRef) refs.push({ clientName, caseRef });
    } catch (err) { console.warn(`[RetainerCountersign] case-ref read failed for lead ${lead.id}: ${err.message}`); }
  }
  refs.push({ clientName, caseRef: `LEAD-${lead.id}` });
  return refs;
}

async function storeSignedToOneDrive(lead, pdf) {
  const oneDrive = require('./oneDriveService');
  const [ref] = await candidateFolderRefs(lead); // best-known folder (case ref when it exists)
  await oneDrive.uploadFile({ ...ref, category: 'Retainer', filename: SIGNED_FILENAME, buffer: pdf, mimeType: 'application/pdf' });
}

/**
 * The signed retainer PDF, newest signature state first. Once countersigned,
 * the retainer2 envelope is the source of truth (a replayed client-completion
 * can regress the OneDrive copy); before that, OneDrive (case folder, then
 * lead folder), then the client envelope download. null = nothing retrievable.
 */
async function getSignedRetainerPdf(lead) {
  const documenso = require('./documensoService');
  const rc = parseRetainerCountersign(lead);
  if (rc.signedAt) {
    // The item id can be blank (some envelope-create responses omit it) —
    // recover it from the envelope itself before giving up on the download.
    let itemId = rc.itemId;
    if (!itemId && rc.envelopeId) {
      try {
        const env = await documenso.getEnvelope(rc.envelopeId);
        itemId = env && env.envelopeItems && env.envelopeItems[0] && env.envelopeItems[0].id;
      } catch (_) { /* fall through to OneDrive */ }
    }
    if (itemId) {
      try {
        const pdf = await documenso.downloadSignedPdf(itemId);
        if (pdf && pdf.length) {
          try { await storeSignedToOneDrive(lead, pdf); } catch (_) { /* heal is best-effort */ }
          return pdf;
        }
      } catch (err) { console.warn(`[RetainerCountersign] countersigned download failed (item ${itemId}, lead ${lead.id}) — falling back to OneDrive: ${err.message}`); }
    }
  }
  try {
    const oneDrive = require('./oneDriveService');
    for (const ref of await candidateFolderRefs(lead)) {
      const pdf = await oneDrive.readFile({ ...ref, subfolder: 'Retainer', filename: SIGNED_FILENAME }).catch(() => null);
      if (pdf && pdf.length) return pdf;
    }
  } catch (err) { console.warn(`[RetainerCountersign] OneDrive signed-copy read failed for lead ${lead.id}: ${err.message}`); }
  for (const itemId of [rc.clientItemId].filter(Boolean)) {
    try {
      const pdf = await documenso.downloadSignedPdf(itemId);
      if (pdf && pdf.length) return pdf;
    } catch (err) { console.warn(`[RetainerCountersign] Documenso signed download failed (item ${itemId}, lead ${lead.id}): ${err.message}`); }
  }
  return null;
}

const _inFlight = new Map(); // leadId → Promise — concurrent portal clicks share ONE issue attempt

async function startRetainerCountersign(leadId) {
  const key = String(leadId);
  // A concurrent caller awaits the SAME issue and must be able to tell it
  // didn't cause one — otherwise two webhook deliveries each announce an
  // envelope that was only created once.
  if (_inFlight.has(key)) return _inFlight.get(key).then((r) => ({ ...r, coalesced: true }));
  const p = _doStartRetainerCountersign(leadId).finally(() => _inFlight.delete(key));
  _inFlight.set(key, p);
  return p;
}

/**
 * Issue (or return the already-issued) RCIC countersign envelope for a lead
 * whose CLIENT has signed the retainer. Same contract as the consult flow:
 *   { alreadySigned: true } | { envelopeId, signUrl, resumed?, persistFailed? }
 * @throws {Error} .badRequest / .notFound with staff-readable messages
 */
async function _doStartRetainerCountersign(leadId) {
  const documenso = require('./documensoService');
  const { safeSignUrl } = require('./consultAgreementService');
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Lead not found'); e.notFound = true; throw e; }
  if (!documenso.isEnabled()) { const e = new Error('E-signing (Documenso) is not enabled.'); e.badRequest = true; throw e; }
  if (!(lead.retainerSigned && String(lead.retainerSigned).trim())) {
    const e = new Error('The client has not signed the retainer agreement yet — the consultant signs after the client.');
    e.badRequest = true; throw e;
  }
  const rc = parseRetainerCountersign(lead);
  if (rc.signedAt) return { alreadySigned: true };
  if (rc.envelopeId) {
    // Envelopes issued before signing-link resolution existed stored no URL —
    // recover it now so the resumed click still opens the signing page.
    let url = safeSignUrl(rc.signUrl);
    if (!url) {
      url = safeSignUrl(await documenso.recipientSignUrl(rc.envelopeId));
      if (url) leadService.updateLead(leadId, { retainerCountersign: JSON.stringify({ ...rc, signUrl: url }) }).catch(() => {});
    }
    return { envelopeId: rc.envelopeId, signUrl: url, resumed: true };
  }

  const consultant = require('../../config/consultantRouting').resolveConsultant(lead);
  if (!consultant || !consultant.email) {
    const e = new Error('No consultant email on record — cannot issue the countersign envelope.');
    e.badRequest = true; throw e;
  }

  // The document being countersigned is the CLIENT-SIGNED copy — never a fresh
  // render, so the final PDF carries both signatures.
  const pdf = await getSignedRetainerPdf(lead);
  if (!pdf) {
    const e = new Error('The client-signed retainer PDF could not be retrieved (OneDrive + Documenso) — cannot start the countersign.');
    e.badRequest = true; throw e;
  }

  let env;
  try {
    env = await documenso.sendForSignature({
      pdfBuffer: pdf,
      title: `TDOT Retainer Agreement — ${lead.fullName || 'Client'} (RCIC countersign)`,
      externalId: documenso.externalIdFor('retainer2', lead.id),
      signer: { email: consultant.email, name: consultant.name || consultant.email },
      subject: `Countersign: retainer agreement — ${lead.fullName || 'client'}`,
      message: 'The client has signed their retainer agreement. Please add your signature as the retained RCIC.',
      // Anchored to the RCIC's own label on the execution page; the static
      // fallback (measured on the rendered pa template: RCIC line at ~42.7%)
      // applies only when the PDF can't be parsed.
      signaturePosition: { positionX: 11, positionY: 35, width: 40, height: 6 },
      signatureAnchorItem: { anchors: [/^signature of\s+rcic/i], gapPct: 2 },
    });
  } catch (err) {
    console.error(`[RetainerCountersign] envelope FAILED for lead ${leadId}: ${err.message}`);
    const e = new Error(`Could not issue the countersign envelope: ${err.message}`);
    e.badRequest = true; throw e;
  }

  const state = { ...rc, envelopeId: env.envelopeId, itemId: env.envelopeItemId || '', signUrl: safeSignUrl(env.signUrl), sentAt: todayISO() };
  let persistFailed = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await leadService.updateLead(leadId, { retainerCountersign: JSON.stringify(state) }); persistFailed = false; break; }
    catch (err) {
      persistFailed = true;
      console.warn(`[RetainerCountersign] state persist attempt ${attempt} failed for lead ${leadId} (envelope ${env.envelopeId} IS distributed — a retry may duplicate it): ${err.message}`);
    }
  }
  return { envelopeId: env.envelopeId, signUrl: state.signUrl, ...(persistFailed ? { persistFailed: true } : {}) };
}

/**
 * retainer2 webhook completion: stamp signedAt (idempotent — replays are
 * no-ops), store the fully-signed PDF to the case folder, and email the client
 * their copy. The email only ever attaches the retainer2 envelope's own PDF.
 */
async function recordRetainerCountersignComplete(lead, { signedPdf, stored } = {}) {
  const leadId = lead.id;
  const fresh = await leadService.getLead(leadId).catch(() => null);
  const current = parseRetainerCountersign(fresh || lead);
  if (current.signedAt) return { emailed: false, signedAt: current.signedAt, alreadyRecorded: true };
  const state = { ...current, signedAt: todayISO() };
  await leadService.updateLead(leadId, { retainerCountersign: JSON.stringify(state) });

  let emailed = false;
  let pdf = (signedPdf && signedPdf.length) ? signedPdf : null;
  if (!pdf && state.itemId) {
    try { pdf = await require('./documensoService').downloadSignedPdf(state.itemId); }
    catch (err) { console.warn(`[RetainerCountersign] countersigned PDF re-download failed for lead ${leadId}: ${err.message}`); }
  }
  if (pdf && pdf.length && !stored) {
    // The generic capture store is skipped for retainer2 — THIS write targets
    // the renamed case folder instead of resurrecting the stale LEAD folder.
    try { await storeSignedToOneDrive(lead, pdf); stored = true; } catch (err) { console.warn(`[RetainerCountersign] signed store failed for lead ${leadId}: ${err.message}`); }
  }
  if (lead.email && pdf && pdf.length) {
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
        <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your signed retainer agreement</h1></div>
      <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${esc((lead.fullName || 'there').split(' ')[0])},</p>
        <p>Your retainer agreement has now been signed by both you and your consultant. Your copy of the fully signed agreement is attached to this email for your records.</p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Any questions? Just reply to this email.</p>
      </div></div>`;
    try {
      await require('./microsoftMailService').sendEmail({
        to: lead.email, subject: 'Your fully signed TDOT Immigration retainer agreement', html,
        attachments: [{ filename: 'retainer-agreement-signed.pdf', buffer: pdf, mimeType: 'application/pdf' }],
      });
      emailed = true;
    } catch (err) { console.error(`[RetainerCountersign] fully-signed copy email FAILED for lead ${leadId}: ${err.message}`); }
  }

  try {
    await require('./mondayApi').query(
      `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId), b: emailed
        ? `✍️ <b>Retainer agreement countersigned by the consultant</b>${stored ? ' — fully-signed copy saved to OneDrive and' : ' —'} emailed to the client.`
        : `✍️ <b>Retainer agreement countersigned by the consultant</b>${stored ? ' — fully-signed copy saved to OneDrive.' : '.'} ⚠️ The client copy email did NOT go out — please forward the signed agreement to the client manually.` }
    );
  } catch (err) { console.warn(`[RetainerCountersign] note failed for ${leadId}: ${err.message}`); }
  return { emailed, signedAt: state.signedAt };
}

module.exports = {
  parseRetainerCountersign, getSignedRetainerPdf, startRetainerCountersign, recordRetainerCountersignComplete,
  candidateFolderRefs, // shared with the consult flow — same rename-aware folder resolution
};
