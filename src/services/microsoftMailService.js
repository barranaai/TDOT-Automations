/**
 * Microsoft Mail Service
 *
 * Sends emails via Microsoft Graph API using the same Azure app registration
 * used for OneDrive access. Requires Mail.Send application permission
 * granted in Azure Portal.
 *
 * Environment variables required:
 *   MS_TENANT_ID      — Azure Directory (tenant) ID
 *   MS_CLIENT_ID      — Azure Application (client) ID
 *   MS_CLIENT_SECRET  — Azure client secret value
 *   MS_FROM_EMAIL     — The M365 mailbox to send from (e.g. noreply@tdotimmigration.ca)
 *
 * Optional:
 *   CLIENT_MAIL_FROM  — the office mailbox CLIENT emails go from, with a copy kept (Stage 1, below).
 *                       Unset / blank = off (the default): every email goes exactly as before.
 *
 * Token caching: tokens are cached in memory and refreshed automatically
 * 5 minutes before expiry (Graph tokens last 1 hour).
 *
 * ── Client emails FROM the office mailbox, with a kept copy (Stage 1, Faran 2026-11-19) — rules, do not undo ──
 *  - A send that passes `tag` is a CLIENT email (the client send sites pass it; staff alerts never do).
 *  - The switch is CLIENT_MAIL_FROM, read at every call. Unset / blank → today's request for EVERY email:
 *    from MS_FROM_EMAIL, saveToSentItems:false, no stamp. Set → it must be an address on tdotimm.com and
 *    not MS_FROM_EMAIL (noreply@ is also the OneDrive / Otter account — no copies are ever kept there);
 *    anything else is ignored with one warning.
 *  - Switch on + `tag` → POST /users/{CLIENT_MAIL_FROM}/sendMail with { message } and NO saveToSentItems
 *    key, so Microsoft keeps the copy in that mailbox's Sent Items; the message carries the case stamp
 *    (utils/mailTag.js — named properties in our own namespace). Reply-To stays exactly as the caller gave it.
 *  - No `tag` (staff alerts) → unchanged: MS_FROM_EMAIL, saveToSentItems:false, no stamp, no copy.
 *  - A client email is never lost and never doubled. Microsoft accepts a send only with a 202, so a 4xx
 *    answer means it was NOT sent and one resend is safe; each fallback below happens at most once:
 *      400 / 422 with the stamp attached → once more to the same mailbox WITHOUT the stamp (still kept).
 *        When that one goes, stamping stops until the app restarts ("[Mail] Microsoft refused the case
 *        stamp — sent without it", logged once).
 *      403 / 404 from the office mailbox (sending as it refused, or no such mailbox) → once more the usual
 *        way: MS_FROM_EMAIL, saveToSentItems:false, no stamp, the same Reply-To. For the next 60 minutes
 *        client emails go straight the usual way; the refusal is logged at most once an hour — also when
 *        that one resend fails (the error then goes up as today's).
 *      401 → as before (no resend here; the error goes up — a fresh token is fetched by the expiry rule).
 *      429, 5xx, a timeout or a network error → NO resend: Microsoft may have taken the email.
 *  - Returns { sendId, via: 'client' | 'fallback' | 'default', stamped }. sendId is the TdotSendId on
 *    the kept copy (null when no stamp went). Callers may ignore it.
 *  - `testClientFrom` is for POST /api/test-email only: that one tagged send tries the office mailbox even
 *    with the switch off (and ignores the two memories above, so a re-test needs no restart).
 */

const axios = require('axios');
const { buildTagProps } = require('../utils/mailTag');

// ─── Token cache ──────────────────────────────────────────────────────────────

const TOKEN_TIMEOUT_MS = 15000;   // the Microsoft sign-in request
let _cachedToken  = null;
let _tokenExpiry  = 0;   // Unix timestamp ms

async function getAccessToken() {
  const now = Date.now();

  // Return cached token if still valid with 5-minute buffer
  if (_cachedToken && now < _tokenExpiry - 300_000) {
    return _cachedToken;
  }

  const tenantId     = process.env.MS_TENANT_ID;
  const clientId     = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Microsoft Mail: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET must all be set in .env'
    );
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  // Bounded like every other Microsoft call: a sign-in request that never
  // answers must fail (and be retried by the caller), not hang everything
  // waiting on a token — case numbering waits on it inside its one-at-a-time lock.
  const response = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TOKEN_TIMEOUT_MS }
  );

  _cachedToken = response.data.access_token;
  _tokenExpiry = now + (response.data.expires_in * 1000);   // expires_in is seconds

  return _cachedToken;
}

/** Drop the cached token — callers retry after a Graph 401 (revocation, drift). */
function invalidateAccessToken() { _cachedToken = null; _tokenExpiry = 0; }

// ─── Client emails from the office mailbox (Stage 1) ─────────────────────────

const SEND_TIMEOUT_MS  = 30000;            // awaited by staff/admin routes — fail fast instead of hanging the request
const SEND_AS_PAUSE_MS = 60 * 60 * 1000;   // after a send-as refusal: client emails go the usual way this long
const CLIENT_DOMAIN    = 'tdotimm.com';
const EMAIL_RE         = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Memory only — a restart starts clean. */
let _mem = { stampRefused: false, sendAsRefusedAt: 0, sendAsBox: '', sendAsLoggedAt: 0, badSettingWarned: null };
const io = { now: () => Date.now() };

/**
 * The office mailbox client emails go from, or '' (the usual way). Read at call time.
 * @param {string} [override]  /api/test-email's mailbox — never set by anything else
 */
function clientMailbox(override) {
  const raw = String((override != null && String(override).trim()) ? override : (process.env.CLIENT_MAIL_FROM || '')).trim();
  if (!raw) return '';
  const box = raw.toLowerCase();
  const usual = String(process.env.MS_FROM_EMAIL || '').trim().toLowerCase();
  if (EMAIL_RE.test(box) && box.split('@')[1] === CLIENT_DOMAIN && box !== usual) return box;
  if (_mem.badSettingWarned !== raw) {
    _mem.badSettingWarned = raw;
    console.warn(`[Mail] CLIENT_MAIL_FROM must be an address on ${CLIENT_DOMAIN} other than the usual sending address — ignored; client emails go the usual way, with no copy kept`);
  }
  return '';
}

const sendAsPaused = (box) => _mem.sendAsBox === box && io.now() - _mem.sendAsRefusedAt < SEND_AS_PAUSE_MS;
const statusOf = (err) => err && err.response && err.response.status;

// ─── Send email ───────────────────────────────────────────────────────────────

/**
 * Send an email via Microsoft Graph.
 *
 * @param {object} options
 * @param {string|string[]} options.to        — recipient email(s)
 * @param {string}          options.subject
 * @param {string}          options.html      — HTML body
 * @param {string}          [options.replyTo] — optional reply-to address
 * @param {object}          [options.tag]     — a CLIENT email: { caseItemId?, caseRef?, leadId?, kind } —
 *                                              the case stamp (utils/mailTag.js); with CLIENT_MAIL_FROM set
 *                                              it goes from that mailbox and a copy is kept. Staff alerts: none.
 * @param {string}          [options.testClientFrom] — /api/test-email only (see the header)
 * @returns {Promise<{ sendId: ?string, via: 'client'|'fallback'|'default', stamped: boolean }>}
 */
async function sendEmail({ to, subject, html, replyTo, attachments, tag, testClientFrom }) {
  const fromEmail = process.env.MS_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('Microsoft Mail: MS_FROM_EMAIL must be set in .env');
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));

  if (!recipients.length) {
    throw new Error('Microsoft Mail: no recipients provided');
  }

  // A CLIENT email (a tag) carries one short line "Your client number: CL-…" at the end of the BODY when the
  // person has a Client ID (build step 5) — never in the subject. Best-effort: no ID, no copy column yet, or a
  // slow / failed read = the body exactly as given. The look-up (one Monday read) runs only while CLIENT_IDS is
  // report or on — switched off, nothing is read here and the request is exactly as before.
  const content = (tag && typeof tag === 'object') ? await require('./clientIdDisplay').mailBody(html, tag) : html;

  const message = {
    subject,
    body:         { contentType: 'HTML', content },
    toRecipients: recipients,
  };

  if (replyTo) {
    message.replyTo = [{ emailAddress: { address: replyTo } }];
  }

  // File attachments: [{ filename, buffer, mimeType }] → Graph fileAttachment.
  // Graph caps a simple sendMail request around 3 MB total — our agreement PDFs
  // are well under that; larger files would need an upload session (not needed).
  if (Array.isArray(attachments) && attachments.length) {
    message.attachments = attachments
      .filter((a) => a && a.buffer && a.buffer.length)
      .map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name:          a.filename || 'attachment',
        contentType:   a.mimeType || 'application/octet-stream',
        contentBytes:  Buffer.from(a.buffer).toString('base64'),
      }));
  }

  // Which way: a tagged (client) send with the switch on — or the test send — tries the office mailbox.
  const tagged = !!tag && typeof tag === 'object';
  const testing = tagged && testClientFrom != null && String(testClientFrom).trim() !== '';
  const box = !tagged ? '' : testing ? clientMailbox(testClientFrom) : clientMailbox();

  const token = await getAccessToken();

  const post = (mailbox, body) => axios.post(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: SEND_TIMEOUT_MS,
    }
  );
  const failure = (err) => {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    return new Error(`sendMail failed (${err.response?.status}): ${detail}`);
  };

  /** Today's request: the usual address, no copy, no stamp. */
  const usualWay = async (via) => {
    try {
      await post(fromEmail, { message, saveToSentItems: false });
    } catch (err) {
      throw failure(err);
    }
    return { sendId: null, via, stamped: false };
  };

  /**
   * 403/404 from the office mailbox: nothing was sent — once more the usual way, and remember it for an hour.
   * The refusal is logged (at most once an hour) whether that resend goes or fails — otherwise a failed
   * resend would leave the next hour of client emails skipping the office mailbox with no log line.
   */
  const sendAsRefused = async () => {
    _mem.sendAsRefusedAt = io.now(); _mem.sendAsBox = box;
    const note = (how) => {
      if (io.now() - _mem.sendAsLoggedAt < SEND_AS_PAUSE_MS) return;
      _mem.sendAsLoggedAt = io.now();
      console.warn(`[Mail] Microsoft refused sending as ${box} — ${how}`);
    };
    let out;
    try {
      out = await usualWay('fallback');
    } catch (e) {
      note('the resend from the usual address failed too');
      throw e;
    }
    note('sent from the usual address');
    return out;
  };

  if (!box) return usualWay('default');
  if (!testing && sendAsPaused(box)) return usualWay('fallback');

  let stamp = { props: [], sendId: null };
  if (testing || !_mem.stampRefused) {
    try { stamp = buildTagProps(tag, to); } catch (_) { stamp = { props: [], sendId: null }; }   // a stamp never blocks an email
  }
  const stamped = stamp.props.length > 0;

  try {
    await post(box, { message: stamped ? { ...message, singleValueExtendedProperties: stamp.props } : message });
    return { sendId: stamped ? stamp.sendId : null, via: 'client', stamped };
  } catch (err) {
    const st = statusOf(err);
    if (stamped && (st === 400 || st === 422)) {
      try {
        await post(box, { message });   // the same mailbox, still kept — without the stamp
      } catch (err2) {
        const st2 = statusOf(err2);
        if (st2 === 403 || st2 === 404) return sendAsRefused();
        throw failure(err2);
      }
      if (!_mem.stampRefused) {
        _mem.stampRefused = true;
        console.warn('[Mail] Microsoft refused the case stamp — sent without it');
      }
      return { sendId: null, via: 'client', stamped: false };
    }
    if (st === 403 || st === 404) return sendAsRefused();
    throw failure(err);
  }
}

module.exports = {
  sendEmail, getAccessToken, invalidateAccessToken, clientMailbox,
  // tests
  io, SEND_AS_PAUSE_MS,
  _state: () => ({ ..._mem }),
  _reset: () => { _mem = { stampRefused: false, sendAsRefusedAt: 0, sendAsBox: '', sendAsLoggedAt: 0, badSettingWarned: null }; },
};
