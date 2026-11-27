'use strict';

/**
 * The lead page's "Attachments" (Faran 2026-11-27) — its two READ-ONLY routes:
 *   GET /api/leads/:leadId/files        → { state, files }  (the list; 'unchecked' is still a 200 so the page can say so)
 *   GET /api/leads/:leadId/files/:key   → one file's bytes
 *
 * Who (Faran's decision 3): the same as the lead page itself — the shared team key. server.js registers both
 * under /api, so app.use('/api', requireApiKey) has already run; there is no second sign-in. When the Monday
 * sign-in cookie is also there, the log line names the staff member; otherwise it says "team key".
 *
 * A request names a file ONLY by its key (hex). The service lists the lead's folders again on every open and
 * matches the key against that fresh listing — a file name never arrives from the browser, never sits in a
 * URL and is never written to a log (the lead id and the key are).
 *
 * The bytes: Content-Type from a fixed list by extension, nosniff, a sandbox CSP, never cached; shown in the
 * tab (pdf / pictures) or saved (heic). The page fetches them with the key header and opens a blob.
 *
 * A small guard: only a few files may be on their way at once (per lead, and in all) — each one is held in
 * memory from the storage read until its bytes have left the server. A file keeps its place until the answer
 * is finished, or the connection drops; a reader that takes nothing for a minute is cut off, so a dead
 * connection can never keep a place (and lock the other staff out).
 *
 * server.js only registers these; the handlers live here so tests run them with fakes.
 */

const svcOf = (deps) => (deps && deps.service) || require('../services/leadFilesService');

const LEAD_RE = /^\d{5,20}$/;
const KEY_RE = /^[a-f0-9]{16,64}$/;

const MAX_READS_PER_LEAD = 3;
const MAX_READS_IN_ALL = 8;
/** A file being sent whose reader takes nothing for this long is cut off. A slow download that still moves is not. */
const SEND_IDLE_MS = 60 * 1000;

const TEXT = Object.freeze({
  badLead: 'Which client? (bad lead id)',
  badKey: 'That file link is not valid — close this box and open Attachments again.',
  noLead: 'That client could not be found — refresh the page.',
  gone: 'That file is not there any more — close this box and open Attachments again.',
  busy: 'Could not reach the files just now — try again.',
  tooMany: 'Too many files are being opened at once — wait a moment and try again.',
  tooBig: 'That file is too big to open here — ask an admin to open it in OneDrive.',
});

const _reads = new Map();   // leadId -> reads in flight
let _readsInAll = 0;
function enter(leadId) {
  const n = _reads.get(leadId) || 0;
  if (n >= MAX_READS_PER_LEAD || _readsInAll >= MAX_READS_IN_ALL) return false;
  _reads.set(leadId, n + 1); _readsInAll += 1;
  return true;
}
function leave(leadId) {
  const n = (_reads.get(leadId) || 1) - 1;
  if (n > 0) _reads.set(leadId, n); else _reads.delete(leadId);
  _readsInAll = Math.max(0, _readsInAll - 1);
}

/** Who opened it, for the log: the Monday sign-in when there is one (never required), else "team key". */
function whoOf(req, deps) {
  let staff = null;
  try { staff = deps && typeof deps.staff === 'function' ? deps.staff(req) : null; } catch (_) { staff = null; }
  const clean = (v) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);
  const name = clean(staff && staff.name), email = clean(staff && staff.email);
  if (name && email) return `${name} (${email})`;
  return name || email || 'team key';
}

/** Express 4 does not catch a rejected async handler: anything unforeseen ends as a plain 500, never an unhandled rejection. */
const safely = (what, handler) => async (req, res, deps) => {
  try { await handler(req, res, deps); }
  catch (_) {
    console.error(`[LeadFiles] ${what} failed unexpectedly`);
    try {
      if (res.headersSent) { if (typeof res.destroy === 'function') res.destroy(); return; }
      res.status(500).json({ error: TEXT.busy });
    } catch (__) { /* the connection itself is gone — nothing left to answer */ }
  }
};

async function listHandler(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const leadId = String((req.params && req.params.leadId) || '');
  if (!LEAD_RE.test(leadId)) return res.status(400).json({ error: TEXT.badLead });
  let out;
  try { out = await svcOf(deps).listLeadFiles(leadId); }
  catch (_) { out = { state: 'unchecked', files: [], reason: 'storage' }; }
  if (!out || out.state === 'not-found') return res.status(404).json({ error: TEXT.noLead });
  if (out.state !== 'ok') {
    console.warn(`[LeadFiles] lead ${leadId}: the files could not be checked (${out.reason || 'unknown'})`);
    return res.json({ state: 'unchecked', files: [], reason: out.reason || 'storage', message: TEXT.busy });
  }
  res.json({ state: 'ok', files: Array.isArray(out.files) ? out.files : [], ...(out.partial ? { partial: true } : {}) });
}

async function fileHandler(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const leadId = String((req.params && req.params.leadId) || '');
  const key = String((req.params && req.params.key) || '');
  if (!LEAD_RE.test(leadId)) return res.status(400).json({ error: TEXT.badLead });
  if (!KEY_RE.test(key)) return res.status(400).json({ error: TEXT.badKey });
  if (!enter(leadId)) return res.status(429).json({ error: TEXT.tooMany });
  // The place is given back exactly once: here when no file is sent, else when the bytes have really left.
  let released = false, sending = false;
  const release = () => { if (!released) { released = true; leave(leadId); } };
  try {
    let r;
    try { r = await svcOf(deps).readLeadFile(leadId, key); }
    catch (_) { r = { refused: 'unchecked', reason: 'storage' }; }
    if (!r || r.refused === 'not-found') return res.status(404).json({ error: TEXT.gone });
    if (r.refused === 'too-big') return res.status(413).json({ error: TEXT.tooBig });
    if (r.refused || !Buffer.isBuffer(r.buffer) || !r.mime) {
      console.warn(`[LeadFiles] lead ${leadId}: file ${key} could not be read (${(r && r.reason) || 'unknown'})`);
      return res.status(503).json({ error: TEXT.busy });
    }
    // The person left while the file was being fetched: nobody to send it to ("close" has already fired, so
    // waiting for it below would keep the place for ever).
    if (res.destroyed === true || res.closed === true || (res.socket && res.socket.destroyed === true)) return;
    const download = r.view !== 'tab';
    // the save name is built by the service from a fixed alphabet; cleaned again here so the header can never break
    let saveAs = String(r.downloadName || '').replace(/[^A-Za-z0-9 ._()-]+/g, '').replace(/^[\s.]+/, '').trim();
    if (!/[^.]\.[A-Za-z0-9]{1,5}$/.test(saveAs)) saveAs = `attachment${/^[a-z0-9]{1,5}$/.test(String(r.ext || '')) ? `.${r.ext}` : ''}`;
    res.set('Content-Type', r.mime);
    res.set('Content-Length', String(r.buffer.length));
    res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${saveAs}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', download ? "sandbox; default-src 'none'" : 'sandbox');
    res.set('Cache-Control', 'private, no-store');
    console.log(`[LeadFiles] lead ${leadId}: file ${key} opened by ${whoOf(req, deps)} (${r.kind || 'file'}, ${r.buffer.length} bytes)`);
    // end() only queues the bytes: the buffer stays in memory until the reader has taken it. So the place is
    // kept until the answer is finished or the connection closes, whichever comes first.
    if (typeof res.once === 'function') {
      res.once('finish', release); res.once('close', release);
      sending = true;
      // A reader that has stopped is cut off — that closes the connection, which gives the place back.
      // (Node holds this timer back while the queue to the reader is still getting shorter.)
      if (typeof res.setTimeout === 'function') res.setTimeout(SEND_IDLE_MS, () => { try { res.destroy(); } catch (_) { /* already gone */ } });
    }
    try { res.status(200).end(r.buffer); }
    catch (err) { release(); throw err; }
  } finally {
    if (!sending) release();
  }
}

const list = safely('the list', listHandler);
const file = safely('a file read', fileHandler);

module.exports = { list, file, TEXT, LEAD_RE, KEY_RE, MAX_READS_PER_LEAD, MAX_READS_IN_ALL, SEND_IDLE_MS, _inFlight: () => ({ leads: _reads.size, all: _readsInAll }) };
