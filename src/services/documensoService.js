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
function externalIdFor(type, leadId) { return `${type}-${leadId}`; }
function parseExternalId(externalId) {
  const m = /^(retainer|consult)-(\d+)$/.exec(String(externalId || '').trim());
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
// Signature-field placement (percent of page). Isolated so the first live
// calibration pass can nudge it without touching the rest of the flow.
const SIGNATURE_FIELD = { type: 'SIGNATURE', page: 1, positionX: 12, positionY: 82, width: 30, height: 8 };

/** Create an envelope (DRAFT — not distributed). Returns { envelopeId, envelopeItemId, raw }. */
async function createEnvelope({ pdfBuffer, title, externalId, signer, subject, message }) {
  if (!pdfBuffer || !pdfBuffer.length) throw new Error('createEnvelope: empty PDF');
  if (!signer || !signer.email) throw new Error('createEnvelope: signer.email required');

  const payload = {
    title,
    type: 'DOCUMENT',
    externalId,
    recipients: [{
      email: signer.email,
      name:  signer.name || signer.email,
      role:  'SIGNER',
      fields: [{ ...SIGNATURE_FIELD }],
    }],
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
  return { envelopeId: String(envelopeId), envelopeItemId: envelopeItemId != null ? String(envelopeItemId) : '', raw: created };
}

/** Distribute (send) a previously-created envelope to its recipients. */
async function distributeEnvelope(envelopeId) {
  return api('/envelope/distribute', { method: 'POST', json: { envelopeId } });
}

/** Create + distribute in one step (the production path). */
async function sendForSignature(args) {
  const env = await createEnvelope(args);
  await distributeEnvelope(env.envelopeId);
  return { envelopeId: env.envelopeId, envelopeItemId: env.envelopeItemId, signUrl: env.raw?.signUrl || '' };
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

  const leadService = require('./leadService');
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error(`lead ${leadId} not found`); e.badRequest = true; throw e; }

  // 2. Download the signed PDF and store it to OneDrive (best-effort).
  let stored = false;
  try {
    if (itemId != null) {
      const signed = await downloadSignedPdf(itemId);
      if (signed && signed.length) {
        const oneDrive = require('./oneDriveService');
        const ref = { clientName: lead.fullName || `Lead ${leadId}`, caseRef: `LEAD-${leadId}` };
        await oneDrive.ensureClientFolder(ref).catch(() => {});
        await oneDrive.uploadFile({
          ...ref,
          category: type === 'retainer' ? 'Retainer' : 'Consultation',
          filename: type === 'retainer' ? 'retainer-agreement-SIGNED.pdf' : 'consultation-agreement-SIGNED.pdf',
          buffer: signed, mimeType: 'application/pdf',
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
    // path, no double-run.
    if (!lead.retainerSigned) await leadService.updateLead(leadId, { retainerSigned: todayISO() });
    await postNote(leadId, `✍️ <b>Retainer agreement signed via Documenso</b>${stored ? ' — signed copy saved to OneDrive.' : '.'} The case will open automatically.`);
  } else {
    await postNote(leadId, `✍️ <b>Consultation agreement signed via Documenso</b>${stored ? ' — signed copy saved to OneDrive.' : '.'}`);
  }
  return { type, leadId, stored, retainerSignedSet: type === 'retainer' && !lead.retainerSigned };
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
  sendForSignature,
  getEnvelope,
  downloadSignedPdf,
  verifyWebhook,
  captureCompleted,
  recordWebhook,
  lastWebhook,
  _cfg: cfg, // exposed for tests
};
