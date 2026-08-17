'use strict';

/**
 * Documenso e-signature integration (v2 API).
 *
 * Auto-capture flow:
 *   1. sendForSignature() uploads an already-generated agreement PDF, places a
 *      signature field, and distributes it to the client for signing.
 *   2. Documenso fires a DOCUMENT_COMPLETED webhook (see routes/phase2.js
 *      /webhook/documenso) → we download the signed PDF, store it to OneDrive,
 *      and set the "signed" state on the lead so the existing automation runs.
 *
 * Everything is gated by DOCUMENSO_ENABLED so the legacy email-a-PDF flow stays
 * the default until we deliberately switch over. All config is read at call
 * time (not module load) so setting env vars + restarting is enough.
 *
 * Config (Render env):
 *   DOCUMENSO_ENABLED         'true' to route agreements through Documenso
 *   DOCUMENSO_BASE_URL        default https://app.documenso.com/api/v2
 *   DOCUMENSO_API_TOKEN       the "api_…" token (Settings → API Tokens)
 *   DOCUMENSO_WEBHOOK_SECRET  the per-webhook secret (Settings → Webhooks)
 *
 * The webhook is authenticated by a plain shared secret in the
 * `X-Documenso-Secret` header (Documenso does NOT HMAC the body) — compared in
 * constant time. externalId ties an envelope back to its lead + agreement type
 * ("retainer-<leadId>" / "consult-<leadId>"), so we need no reverse-lookup.
 */

const crypto = require('crypto');

function cfg() {
  return {
    enabled: /^(true|1)$/i.test(String(process.env.DOCUMENSO_ENABLED || '')),
    baseUrl: (process.env.DOCUMENSO_BASE_URL || 'https://app.documenso.com/api/v2').replace(/\/+$/, ''),
    token:   process.env.DOCUMENSO_API_TOKEN || '',
    secret:  process.env.DOCUMENSO_WEBHOOK_SECRET || '',
  };
}

function isEnabled() {
  const c = cfg();
  return c.enabled && Boolean(c.token);
}

// ─── externalId ⇄ (type, leadId) ─────────────────────────────────────────────
// Types: retainer / consult (the CLIENT signs), retainer2 / consult2 (the RCIC
// countersign of the respective client-signed agreement — a second envelope
// whose only recipient is the consultant).
function externalIdFor(type, leadId) { return `${type}-${leadId}`; }
function parseExternalId(externalId) {
  const m = /^(retainerinv|retainer2|retainer|consult2|consult)-(\d+)$/.exec(String(externalId || '').trim());
  return m ? { type: m[1], leadId: m[2] } : null;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', json, form, raw } = {}) {
  const c = cfg();
  if (!c.token) { const e = new Error('DOCUMENSO_API_TOKEN not set'); e.config = true; throw e; }
  const headers = { Authorization: c.token };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) { body = form; } // fetch sets the multipart boundary itself
  const res = await fetch(`${c.baseUrl}${path}`, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`Documenso ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/**
 * Create an envelope from a PDF and distribute it for signature.
 * @returns {Promise<{ envelopeId, envelopeItemId, signUrl }>}
 *
 * NOTE: the signature-field placement (page/position) is a sensible default —
 * bottom of the last page — and is the one thing worth eyeballing on the first
 * live send; it's isolated here for easy tuning.
 */
// Signature-field placement (percent of page). Our agreements sign at the END,
// so the field goes on the LAST page (page number resolved per-document from the
// PDF, since the retainer's length varies with its annexes). Calibrated to the
// "Client: Signature ______" block near the bottom-left of the TDOT agreement
// templates. Callers may pass a per-document override via opts.signaturePosition.
const SIGNATURE_FIELD = { positionX: 25, positionY: 70, width: 28, height: 8 };

/** Count PDF pages (for last-page field placement); default 1 on any error. */
async function pdfPageCount(pdfBuffer) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    return doc.getPageCount() || 1;
  } catch (_) { return 1; }
}

/**
 * Find the page + vertical position (% from the page top) of the first text
 * item matching one of `anchors`, tried in priority order. Used to place a
 * signature field relative to the document's ACTUAL signature line — a fixed
 * percentage is wrong whenever preceding content reflows (the Praj incident:
 * the static retainer y landed the client's field on the RCIC's line).
 * Returns { page, yTopPct } or null (unparsable / no match).
 */
/**
 * PURE — first text item matching one of `anchors` (tried in priority order)
 * across extracted pages ([[{ str, yTopPct }], …]). Split from the PDF
 * extraction so the matching rules are unit-testable without pdf-parse, whose
 * bundled pdf.js rejects some synthetic PDFs nondeterministically ("bad XRef
 * entry") — real CloudConvert renders parse reliably.
 */
/**
 * @param {number} occurrence  1-based: return the Nth matching text item in
 *   reading order instead of the first. The pa-inviter execution block renders
 *   TWO client "Signature of …" lines (PA first, inviter second, fixed template
 *   order) — and the two names can be identical or prefix each other (family
 *   members), so no name-based regex can safely tell the lines apart. Position
 *   can: the inviter is always occurrence 2 of the generic non-RCIC anchor.
 */
function anchorHitFromPages(pages, anchors, occurrence = 1) {
  for (const a of [].concat(anchors || [])) {
    const re = a instanceof RegExp ? a : new RegExp(a, 'i');
    let seen = 0;
    for (let p = 0; p < (pages || []).length; p++) {
      for (const it of pages[p] || []) {
        if (it && it.str && re.test(it.str)) {
          seen++;
          if (seen === occurrence) return { page: p + 1, yTopPct: it.yTopPct };
        }
      }
    }
  }
  return null;
}

async function findAnchorPosition(pdfBuffer, anchors, occurrence = 1) {
  try {
    const pdfParse = require('pdf-parse');
    const pages = [];
    await pdfParse(pdfBuffer, {
      pagerender: async (pageData) => {
        const view = pageData.pageInfo.view;
        const H = (view[3] - view[1]) || 1;
        const tc = await pageData.getTextContent();
        pages.push((tc.items || []).map((it) => ({
          str: String(it.str || '').trim(),
          yTopPct: (1 - it.transform[5] / H) * 100,
        })));
        return '';
      },
    });
    return anchorHitFromPages(pages, anchors, occurrence);
  } catch (_) { return null; /* caller keeps the static fallback */ }
}

// The signature block isn't always the last page — the retainer appends annexes
// AFTER the execution page. So we find the page whose text matches a signature
// anchor. Works for both templates (retainer "IN WITNESS THEREOF / Signature of",
// consult "Client: Signature"). Returns a 1-based page, or 0 if not found.
const SIG_ANCHOR = /in witness thereof|signature of\b|client\s*:?\s*signature/i;
async function findSignaturePage(pdfBuffer, anchor = SIG_ANCHOR) {
  try {
    const pdfParse = require('pdf-parse');
    const re = anchor instanceof RegExp ? anchor : new RegExp(anchor, 'i');
    const pageTexts = [];
    await pdfParse(pdfBuffer, {
      pagerender: async (pageData) => {
        const tc = await pageData.getTextContent();
        const txt = (tc.items || []).map((i) => i.str).join(' ');
        pageTexts.push(txt);
        return txt;
      },
    });
    const idx = pageTexts.findIndex((t) => re.test(t));
    return idx >= 0 ? idx + 1 : 0;
  } catch (_) { return 0; }
}

/** Create an envelope (DRAFT — not distributed). Returns { envelopeId, envelopeItemId, raw }. */
async function createEnvelope({ pdfBuffer, title, externalId, signer, signers, subject, message, signaturePosition, signatureAnchor, signatureAnchorItem }) {
  if (!pdfBuffer || !pdfBuffer.length) throw new Error('createEnvelope: empty PDF');
  // Multi-party agreements (PA + inviter/sponsor/dependent) pass `signers`;
  // the single `signer` form stays for every one-party envelope (consult
  // agreement, both countersigns). Each signer gets their OWN anchored field —
  // their signature must land on THEIR "Signature of …" line, not the PA's.
  const signerList = (signers && signers.length) ? signers
    // A signer's OWN anchorItem/position wins — the top-level args are the
    // legacy spelling. (Caught live: the inviter co-sign passed them inside
    // the signer and this mapping clobbered both with undefined, dropping the
    // field to the module default {25,70} instead of the inviter's line.)
    : (signer ? [{ ...signer, anchorItem: signer.anchorItem || signatureAnchorItem, position: signer.position || signaturePosition }] : []);
  if (!signerList.length || signerList.some((s) => !s.email)) throw new Error('createEnvelope: signer.email required');

  // Fallback page: the one carrying the signature block (annexes come after it
  // in the retainer), else the last page. Resolved once, shared by any signer
  // whose own anchor doesn't match.
  let fallbackPage = 0;

  const recipients = [];
  for (let i = 0; i < signerList.length; i++) {
    const s = signerList[i];
    const anchorItem = s.anchorItem || null;
    const position = s.position || null;

    // Preferred: place the field relative to the document's ACTUAL signature
    // line (anchors, priority-ordered). The field bottom lands gapPct above the
    // matched label, so the signature sits ON the line above it.
    let page = 0;
    let dynY = null;
    if (anchorItem && anchorItem.anchors) {
      const hit = await findAnchorPosition(pdfBuffer, anchorItem.anchors, anchorItem.occurrence || 1);
      if (hit) {
        page = hit.page;
        const h = (position && position.height) || SIGNATURE_FIELD.height;
        const gap = anchorItem.gapPct != null ? anchorItem.gapPct : 2;
        dynY = Math.max(2, Math.round((hit.yTopPct - h - gap) * 10) / 10);
      }
    }
    if (!page) {
      if (!fallbackPage) fallbackPage = (await findSignaturePage(pdfBuffer, signatureAnchor)) || (await pdfPageCount(pdfBuffer));
      page = fallbackPage;
    }
    let sigField = { type: 'SIGNATURE', page, ...SIGNATURE_FIELD, ...(position || {}), ...(dynY != null ? { positionY: dynY } : {}) };
    // Two un-anchored signers would otherwise stack on the same fallback spot —
    // a signer signing on someone else's line is worse than an ugly offset.
    if (dynY == null && i > 0) sigField.positionY = Math.min(92, (sigField.positionY || 27) + i * (sigField.height + 3));
    recipients.push({ email: s.email, name: s.name || s.email, role: 'SIGNER', fields: [sigField] });
  }

  const payload = {
    title,
    type: 'DOCUMENT',
    externalId,
    recipients,
    meta: {
      subject: subject || `Please sign: ${title}`,
      message: message || 'Please review and sign the attached agreement. Thank you — TDOT Immigration.',
    },
  };

  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  form.append('files', new Blob([pdfBuffer], { type: 'application/pdf' }), `${title}.pdf`);

  const created = await api('/envelope/create', { method: 'POST', form });
  const envelopeId = created?.id ?? created?.envelopeId ?? created?.envelope?.id;
  const envelopeItemId = created?.items?.[0]?.id ?? created?.envelopeItems?.[0]?.id;
  if (!envelopeId) throw new Error(`Documenso create returned no envelope id: ${JSON.stringify(created).slice(0, 300)}`);
  return { envelopeId: String(envelopeId), envelopeItemId: envelopeItemId != null ? String(envelopeItemId) : '', raw: created,
    // What was actually placed, per recipient — lets callers verify a field
    // landed on an anchored line instead of the static fallback.
    placedFields: recipients.map((r) => ({ email: r.email, field: r.fields[0] })) };
}

/** Distribute (send) a previously-created envelope to its recipients. */
async function distributeEnvelope(envelopeId) {
  return api('/envelope/distribute', { method: 'POST', json: { envelopeId } });
}

/**
 * Best-effort: the recipient's direct signing URL. The create response carries
 * no signUrl, so without this the portal's "sign as consultant" tab has nowhere
 * to go. Reads the envelope and tries the shapes Documenso is known to use.
 */
async function recipientSignUrl(envelopeId) {
  try {
    const env = await getEnvelope(envelopeId);
    const recipients = (env && (env.recipients || (env.envelope && env.envelope.recipients))) || [];
    const r = recipients[0] || {};
    if (r.signingUrl) return String(r.signingUrl);
    const token = r.token || r.signingToken || '';
    if (token) {
      const origin = new URL((process.env.DOCUMENSO_BASE_URL || 'https://app.documenso.com/api/v2')).origin;
      return `${origin}/sign/${token}`;
    }
  } catch (_) { /* the emailed link still reaches the signer */ }
  return '';
}

/** Create + distribute in one step (the production path). */
async function sendForSignature(args) {
  const env = await createEnvelope(args);
  await distributeEnvelope(env.envelopeId);
  let signUrl = env.raw?.signUrl || '';
  if (!signUrl) signUrl = await recipientSignUrl(env.envelopeId);
  return { envelopeId: env.envelopeId, envelopeItemId: env.envelopeItemId, signUrl, placedFields: env.placedFields };
}

/** Best-effort envelope delete/void (reissue path). Tries the known shapes. */
async function deleteEnvelope(envelopeId) {
  const id = encodeURIComponent(envelopeId);
  try { return await api(`/envelope/${id}`, { method: 'DELETE' }); }
  catch (e1) {
    try { return await api('/envelope/delete', { method: 'POST', json: { envelopeId } }); }
    catch (e2) { const e = new Error(`delete failed: ${e1.message} / ${e2.message}`); throw e; }
  }
}

/** Read an envelope (used to resolve externalId + the signed item id from a webhook). */
async function getEnvelope(envelopeId) {
  return api(`/envelope/${encodeURIComponent(envelopeId)}`, { method: 'GET' });
}

/** Download the signed PDF for an envelope item. */
async function downloadSignedPdf(envelopeItemId) {
  return api(`/envelope/item/${encodeURIComponent(envelopeItemId)}/download?version=signed`, { method: 'GET', raw: true });
}

/**
 * Verify an inbound webhook by constant-time comparing the X-Documenso-Secret
 * header to our configured secret. If no secret is configured we FAIL CLOSED
 * (return false) — a signature endpoint that opens cases must never be open.
 */
function verifyWebhook(headers = {}) {
  const c = cfg();
  const received = String(headers['x-documenso-secret'] || headers['X-Documenso-Secret'] || '');
  if (!c.secret) return false;           // fail closed: no secret set = reject
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(c.secret);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Lightweight in-memory record of the most recent inbound webhook, so a live
// calibration test can confirm the round-trip without server log access.
let _lastWebhook = null;
function recordWebhook(body) {
  const p = (body && body.payload) || {};
  _lastWebhook = {
    at: new Date().toISOString(),
    event: body && body.event,
    externalId: p.externalId || null,
    envelopeId: p.id || null,
    status: p.status || null,
    payloadKeys: p && typeof p === 'object' ? Object.keys(p) : [],
    hasEnvelopeItems: Boolean(p.envelopeItems && p.envelopeItems.length),
    raw: (() => { try { return JSON.stringify(body).slice(0, 4000); } catch { return null; } })(),
  };
}
function lastWebhook() { return _lastWebhook; }

/**
 * Handle a verified DOCUMENT_COMPLETED webhook: resolve the lead + agreement
 * type from externalId, download the signed PDF, store it to OneDrive, and set
 * the "signed" state so the existing automation runs (retainer → case opens).
 * Best-effort on the side steps (PDF store); the state write is the critical
 * one. Returns a small summary for logging/tests.
 */
async function captureCompleted(body) {
  const event = body && body.event;
  if (event && event !== 'DOCUMENT_COMPLETED') return { skipped: event };
  const p = (body && body.payload) || {};

  // 1. Resolve externalId + the signed item id. The webhook may inline them; if
  //    not, fetch the envelope once (the item id lives under `envelopeItems`).
  let ext = p.externalId;
  let itemId = (p.envelopeItems && p.envelopeItems[0] && p.envelopeItems[0].id)
    || (p.items && p.items[0] && p.items[0].id)
    || null;
  // The v2 API keys on the string envelopeId ("envelope_…"), NOT the numeric
  // payload.id the webhook also carries — use envelopeId for the fetch.
  const envId = p.envelopeId || p.id;
  if ((!ext || !itemId) && envId) {
    try {
      const env = await getEnvelope(envId);
      if (!ext) ext = env && env.externalId;
      if (!itemId) itemId = env && env.envelopeItems && env.envelopeItems[0] && env.envelopeItems[0].id;
    } catch (_) { /* fall through with whatever we have */ }
  }
  const parsed = parseExternalId(ext);
  if (!parsed) { const e = new Error(`unresolved externalId "${ext}"`); e.badRequest = true; throw e; }
  const { type, leadId } = parsed;

  // Serialized per lead with void-&-reissue (leadMutex): a capture must never
  // interleave with a staff reissue that is voiding/re-sending this lead's
  // envelopes — both flows run in this process, same lock.
  return require('./leadMutex').withLeadLock(leadId, async () => {

  const leadService = require('./leadService');
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error(`lead ${leadId} not found`); e.badRequest = true; throw e; }
  const consultAgreementSvc = require('./consultAgreementService');
  const retainerCountersignSvc = require('./retainerCountersignService');
  const csState = consultAgreementSvc.parseCountersign(lead);
  const rcState = retainerCountersignSvc.parseRetainerCountersign(lead);

  // Countersign guard: a completion naming an envelope that is NOT the recorded
  // countersign envelope must not stamp/email anything for this lead.
  if (type === 'consult2' || type === 'retainer2') {
    const state = type === 'consult2' ? csState : rcState;
    const wired = [p.envelopeId, p.id].filter((x) => x != null).map(String);
    if (state.envelopeId && wired.length && !wired.includes(String(state.envelopeId))) {
      console.warn(`[Documenso] ${type} completion for lead ${leadId} names envelope ${wired.join('/')} but the recorded countersign envelope is ${state.envelopeId} — skipping`);
      return { skipped: `${type} envelope mismatch` };
    }
  }

  // Superseded-envelope guard for the RETAINER family: after a void-&-reissue
  // the lead records the NEW envelope id — a completion naming any OTHER
  // envelope is a signer executing a VOIDED agreement whose TERMS may differ
  // (the whole point of the reissue). Never stamp, store, or act on it; a lead
  // with no recorded id (legacy sends) passes through unchanged.
  // Deliberately NOT applied to 'consult': consult packages are re-sendable
  // with identical terms, and the established contract is that whichever
  // envelope actually completes replaces any stale recorded ids.
  if (['retainer', 'retainerinv'].includes(type)) {
    const recorded = String((type === 'retainer' ? rcState.clientEnvelopeId : rcState.inviterEnvelopeId) || '').trim();
    const wired = [p.envelopeId, p.id].filter((x) => x != null).map(String);
    if (recorded && wired.length && !wired.includes(recorded)) {
      const clean = (s) => String(s).replace(/[<>&"]/g, '');
      console.warn(`[Documenso] ${type} completion for lead ${leadId} names envelope ${wired.join('/')} but the recorded envelope is ${recorded} — superseded, skipping`);
      await postNote(leadId,
        `⚠️ <b>A superseded e-sign envelope was completed</b> (envelope ${clean(wired[0])}; the current one is ${clean(recorded)}). ` +
        'A signer likely used the OLD links of a voided agreement. Nothing was recorded — ask them to sign from the NEWEST email.');
      return { skipped: `${type} envelope mismatch (superseded)` };
    }
  }

  // 2. Download the signed PDF; store it to OneDrive (best-effort) unless:
  //    - a late/replayed CLIENT completion would REGRESS the canonical SIGNED
  //      file to the client-only copy after the countersign completed, or
  //    - the type is retainer2, whose storage happens in
  //      recordRetainerCountersignComplete targeting the RENAMED case folder
  //      (the generic LEAD-named path would resurrect a stale folder).
  //    The countersigned (…2) copies use the SAME filename as the client ones —
  //    the fully-signed version replaces the client-only version as the one
  //    canonical "SIGNED" file.
  // Event-fabrication guard for the CLIENT envelopes, mirroring retainer2/
  // consult2 below: the event string is caller-supplied (the admin recapture
  // tool fabricates DOCUMENT_COMPLETED), and a retainer envelope can now be
  // legitimately HALF-signed — pa-inviter agreements carry two parallel
  // signers. Without this check, a recapture on a pending envelope would stamp
  // retainerSigned (opening the case and requesting payment on an agreement a
  // named party never signed) and store a partially-signed PDF as the
  // canonical SIGNED copy, which the RCIC countersign would then be issued
  // over. Verified BEFORE the download/store, not after.
  if ((type === 'retainer' || type === 'consult' || type === 'retainerinv') && envId) {
    try {
      const env = await getEnvelope(envId);
      const status = String((env && env.status) || '').toUpperCase();
      if (status && !status.includes('COMPLET')) return { skipped: `${type} envelope status ${status}` };
    } catch (_) { /* can't verify — proceed; the signed-date guards still dedupe replays */ }
  }

  let stored = false;
  let signedPdf = null;
  const skipStore = (type === 'consult' && Boolean(csState.signedAt))
    || (type === 'retainer' && Boolean(rcState.signedAt))
    || type === 'retainer2'
    || type === 'retainerinv';   // stores via recordInviterSignatureComplete (case folder)
  try {
    if (itemId != null) {
      signedPdf = await downloadSignedPdf(itemId);
      if (signedPdf && signedPdf.length && !skipStore) {
        const oneDrive = require('./oneDriveService');
        const ref = { clientName: lead.fullName || `Lead ${leadId}`, caseRef: `LEAD-${leadId}` };
        await oneDrive.ensureClientFolder(ref).catch(() => {});
        await oneDrive.uploadFile({
          ...ref,
          category: type === 'retainer' ? 'Retainer' : 'Consultation',
          filename: type === 'retainer' ? 'retainer-agreement-SIGNED.pdf' : 'consultation-agreement-SIGNED.pdf',
          buffer: signedPdf, mimeType: 'application/pdf',
        });
        stored = true;
      }
    }
  } catch (err) {
    console.warn(`[Documenso] Signed PDF store failed for ${type}-${leadId}: ${err.message}`);
  }

  // 3. Set the signed state.
  if (type === 'retainer') {
    // Exactly what a human clicking "Mark retainer signed" does — setting the
    // date fires the Monday webhook → onRetainerSigned → the case opens. Single
    // path, no double-run. The COMPLETED envelope's ids ride along in the
    // countersign state as the client-signed download reference.
    if (!lead.retainerSigned) {
      await leadService.updateLead(leadId, {
        retainerSigned: todayISO(),
        retainerCountersign: JSON.stringify({
          ...rcState,
          // clientSignedVia: the activation gate's countersign requirement keys
          // on the signature COMPLETING through Documenso — clientEnvelopeId
          // alone only proves an envelope was SENT (a client who then signs on
          // paper must not wait on a countersign envelope that never issues).
          clientSignedVia: 'documenso',
          ...(envId != null ? { clientEnvelopeId: String(envId) } : {}),
          ...(itemId != null ? { clientItemId: String(itemId) } : {}),
        }),
      });

      // Staff push notification (team feedback 2026-08-13: Kamal was checking
      // the board every morning to see who signed). Recipients come from
      // STAFF_SIGNATURE_NOTIFY_EMAILS (comma-separated); unset = feature off.
      // INSIDE the first-time guard — webhook redeliveries and the admin
      // recapture endpoint replay this capture on already-signed leads, and
      // only the delivery that actually flips the signed state may email
      // (same replay semantics as the state write itself).
      // Best-effort — a mail failure must never break the signature capture.
      try {
        const notifyList = String(process.env.STAFF_SIGNATURE_NOTIFY_EMAILS || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        if (notifyList.length) {
          const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
          const base = (process.env.RENDER_URL || 'https://app.tdotimm.com').replace(/\/$/, '');
          await require('./microsoftMailService').sendEmail({
            to: notifyList,
            subject: `✍️ Retainer signed — ${lead.fullName || 'client'} (${lead.confirmedCaseType || lead.caseTypeInterest || 'case type TBD'})`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:520px">
              <p><b>${esc(lead.fullName || 'A client')}</b> just signed their retainer agreement.</p>
              <p style="margin:4px 0">Case type: <b>${esc(lead.confirmedCaseType || lead.caseTypeInterest || '—')}</b><br>
              Consultant: ${esc(lead.assignedConsultant || '—')}<br>
              Fee: ${lead.retainerFee ? '$' + esc(lead.retainerFee) : '—'}</p>
              <p>The case opens automatically; payment ${lead.retainerPaid ? 'is already recorded' : 'is not recorded yet'}.</p>
              <p><a href="${base}/admin/consultation/${encodeURIComponent(leadId)}">Open the consultation record</a></p>
            </div>`,
          });
        }
      } catch (err) {
        console.warn(`[Documenso] staff signature notification failed for lead ${leadId}: ${err.message}`);
      }
    }
    await postNote(leadId, `✍️ <b>Retainer agreement signed via Documenso</b>${stored ? ' — signed copy saved to OneDrive.' : '.'} The case will open automatically.`);

    // The consultant's countersign envelope now goes out AUTOMATICALLY the
    // moment the client signs — previously it waited for someone to notice a
    // Monday note and click "Sign retainer as consultant", so a signed retainer
    // could sit indefinitely with nobody aware it was their turn.
    // Best-effort and idempotent: startRetainerCountersign holds an in-flight
    // lock, resumes an already-issued envelope, and no-ops once countersigned —
    // so replays and a staff click racing this can't mint a second envelope.
    // A failure here must never break the client-signature capture; the portal
    // button stays as the manual fallback and the note says so.
    try {
      const auto = await retainerCountersignSvc.startRetainerCountersign(leadId);
      // Only announce a genuinely NEW envelope: `resumed` = one already
      // existed, `coalesced` = a concurrent delivery is awaiting the same
      // in-flight issue (two webhook deliveries must not post two notes).
      if (auto && auto.envelopeId && !auto.resumed && !auto.coalesced) {
        if (auto.persistFailed) {
          // The envelope IS distributed but its id never reached the lead, so
          // nothing downstream knows it exists — say so loudly, because the
          // obvious recovery (clicking the button) would email a SECOND
          // signature request to the same consultant.
          await postNote(leadId,
            `⚠️ <b>Countersign request WAS emailed to the consultant, but could not be recorded on this lead</b> (envelope ${String(auto.envelopeId).replace(/[<>&"]/g, '')}). ` +
            'Do NOT click “Sign retainer as consultant” — that would send them a second request. Ask them to sign from the Documenso email they already have.');
        } else {
          await postNote(leadId, '🖋️ <b>Countersign request sent to the consultant</b> — Documenso emailed them the retainer to sign. The client gets their fully-signed copy automatically once they do.');
        }
      }
    } catch (err) {
      console.warn(`[Documenso] auto-countersign for lead ${leadId} failed: ${err.message}`);
      await postNote(leadId, '⚠️ <b>The countersign request could not be sent to the consultant automatically.</b> Open this lead in the Consultations page and click “Sign retainer as consultant”.');
    }
  } else if (type === 'retainer2') {
    // RCIC countersign completed → the retainer is FULLY signed. Same
    // event-fabrication guard as consult2: with no signed payload in hand,
    // verify the envelope really completed before stamping.
    if (!(signedPdf && signedPdf.length) && envId) {
      try {
        const env = await getEnvelope(envId);
        const status = String((env && env.status) || '').toUpperCase();
        if (status && !status.includes('COMPLET')) return { skipped: `retainer2 envelope status ${status}` };
      } catch (_) { /* can't verify — proceed; recordRetainerCountersignComplete still dedupes replays */ }
    }
    await retainerCountersignSvc.recordRetainerCountersignComplete(lead, { signedPdf, stored });
  } else if (type === 'retainerinv') {
    // Inviter/sponsor/dependent co-signature completed (post-hoc flow for
    // agreements that went out PA-only). Never touches retainerSigned — the
    // client's own signature state — only the inviter fields in the
    // countersign JSON, plus the stored final copy.
    await retainerCountersignSvc.recordInviterSignatureComplete(lead, { signedPdf });
  } else if (type === 'consult2') {
    // RCIC countersign completed → the agreement is FULLY signed. Record it on
    // the countersign state (never touching consultAgreementSigned — that is the
    // CLIENT's date) and email the client their final copy.
    // The event string is caller-supplied (the admin recapture tool fabricates
    // DOCUMENT_COMPLETED), so when no signed payload could be downloaded, check
    // the envelope really completed before stamping — otherwise a premature
    // recapture would falsely mark the countersign done and permanently hide
    // the "Sign as consultant" button.
    if (!(signedPdf && signedPdf.length) && envId) {
      try {
        const env = await getEnvelope(envId);
        const status = String((env && env.status) || '').toUpperCase();
        if (status && !status.includes('COMPLET')) return { skipped: `consult2 envelope status ${status}` };
      } catch (_) { /* can't verify — proceed; recordCountersignComplete still dedupes replays */ }
    }
    await consultAgreementSvc.recordCountersignComplete(lead, { signedPdf, stored });
  } else {
    // Consultation signing never opens a case — it just records the signed date
    // (its own column, mirroring Retainer Signed) + stores the signed PDF. The
    // COMPLETED envelope's ids also land in the countersign state — they are the
    // authoritative client-signed download reference (a later re-send would
    // otherwise leave clientItemId pointing at a never-signed envelope).
    if (!lead.consultAgreementSigned) {
      await leadService.updateLead(leadId, {
        consultAgreementSigned: todayISO(),
        consultCountersign: JSON.stringify({
          ...csState,
          ...(envId != null ? { clientEnvelopeId: String(envId) } : {}),
          ...(itemId != null ? { clientItemId: String(itemId) } : {}),
        }),
      });
    }
    await postNote(leadId, `✍️ <b>Consultation agreement signed via Documenso</b>${stored ? ' — signed copy saved to OneDrive.' : '.'}`);

    // Same automation as the retainer (user directive 2026-08-04): the client's
    // signature issues the consultant's countersign envelope immediately, so
    // Documenso emails them the signing link instead of the agreement waiting
    // on someone spotting a Monday note. Identical rails — best-effort so a
    // failure can never break the client-signature capture, idempotent so
    // replays and a racing staff click can't double-email the consultant.
    try {
      const auto = await consultAgreementSvc.startConsultCountersign(leadId);
      if (auto && auto.envelopeId && !auto.resumed && !auto.coalesced) {
        if (auto.persistFailed) {
          await postNote(leadId,
            `⚠️ <b>Countersign request WAS emailed to the consultant, but could not be recorded on this lead</b> (envelope ${String(auto.envelopeId).replace(/[<>&"]/g, '')}). ` +
            'Do NOT click “Sign as consultant” — that would send them a second request. Ask them to sign from the Documenso email they already have.');
        } else {
          await postNote(leadId, '🖋️ <b>Countersign request sent to the consultant</b> — Documenso emailed them the consultation agreement to sign. The client gets their fully-signed copy automatically once they do.');
        }
      }
    } catch (err) {
      console.warn(`[Documenso] auto-countersign (consult) for lead ${leadId} failed: ${err.message}`);
      await postNote(leadId, '⚠️ <b>The countersign request could not be sent to the consultant automatically.</b> Open this lead in the Consultations page and click “Sign as consultant”.');
    }
  }
  return {
    type, leadId, stored,
    retainerSignedSet: type === 'retainer' && !lead.retainerSigned,
    consultSignedSet:  type === 'consult'  && !lead.consultAgreementSigned,
    countersignSet:    type === 'consult2' || type === 'retainer2',
  };

  }); // withLeadLock
}

async function postNote(leadId, body) {
  try {
    const mondayApi = require('./mondayApi');
    await mondayApi.query(
      `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId), b: body }
    );
  } catch (err) { console.warn(`[Documenso] note failed for ${leadId}: ${err.message}`); }
}

module.exports = {
  isEnabled,
  externalIdFor,
  parseExternalId,
  createEnvelope,
  distributeEnvelope,
  deleteEnvelope,
  findSignaturePage,
  findAnchorPosition,
  anchorHitFromPages,
  recipientSignUrl,
  sendForSignature,
  getEnvelope,
  downloadSignedPdf,
  verifyWebhook,
  captureCompleted,
  recordWebhook,
  lastWebhook,
  _cfg: cfg, // exposed for tests
};
