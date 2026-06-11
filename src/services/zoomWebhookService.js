/**
 * Zoom Webhook Service — closes the post-consultation gap: until now the
 * system never learned a meeting actually happened or that its recording
 * was ready; staff had to check Zoom by hand.
 *
 *   meeting.ended        → stamp Consultation Held with the ACTUAL date,
 *                          post a "consultation done — set the Outcome" nudge
 *                          on the lead's Updates.
 *   recording.completed  → write the share link (+ passcode) to the
 *                          "Consultation Recording" column and post it to
 *                          the lead's Updates.
 *
 * Security (Zoom's scheme, implemented in full):
 *   - URL validation handshake: Zoom POSTs { event: "endpoint.url_validation",
 *     payload: { plainToken } } and expects { plainToken, encryptedToken }
 *     where encryptedToken = HMAC-SHA256-hex(plainToken, secretToken).
 *   - Every event carries x-zm-signature = "v0=" + HMAC-SHA256-hex(
 *     `v0:{x-zm-request-timestamp}:{rawBody}`, secretToken). We verify it and
 *     reject stale timestamps (>5 min — replay protection).
 *   - Until ZOOM_WEBHOOK_SECRET_TOKEN is configured, events are accepted with
 *     a loud warning (mirrors the Square webhook's pre-config grace) so the
 *     feature works before the Zoom-side setup is finished.
 *
 * Matching: payload.object.id is the Zoom meeting id — the same value we
 * store on the lead (zoomMeetingId) when the meeting is created.
 */

'use strict';

const crypto = require('crypto');

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

function secretToken() { return process.env.ZOOM_WEBHOOK_SECRET_TOKEN || ''; }

/** Answer Zoom's endpoint URL-validation challenge. */
function buildValidationResponse(plainToken) {
  return {
    plainToken,
    encryptedToken: crypto.createHmac('sha256', secretToken()).update(String(plainToken)).digest('hex'),
  };
}

/**
 * Verify x-zm-signature over the RAW body. Returns { ok, reason }.
 * FAIL CLOSED when no secret is configured: unlike Square, Zoom's URL
 * validation handshake cannot succeed without the real secret anyway, so an
 * unsigned grace mode would only ever serve attackers, never Zoom.
 */
function verifyZoomSignature(rawBody, signature, timestamp, now = Date.now()) {
  const secret = secretToken();
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing-headers' };
  const age = Math.abs(now - Number(timestamp) * 1000);
  if (!Number.isFinite(age) || age > SIGNATURE_MAX_AGE_MS) return { ok: false, reason: 'stale-timestamp' };
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? 'verified' : 'bad-signature' };
}

// In-process redelivery dedup. Keys are recorded only AFTER a handler
// completes successfully, so a mid-flight failure leaves the event
// replayable. Hard-capped (oldest evicted) so a flood can't grow memory.
const _seen = new Map(); // key → ts
function alreadyHandled(key) {
  return _seen.has(key);
}
function markHandled(key) {
  if (_seen.size >= 500) _seen.delete(_seen.keys().next().value);
  _seen.set(key, Date.now());
}

/** UTC ISO → "YYYY-MM-DD" in Toronto. '' for missing/invalid input. */
function torontoDate(utcIso) {
  if (!utcIso) return '';
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d);
  const m = {}; for (const x of p) m[x.type] = x.value;
  return `${m.year}-${m.month}-${m.day}`;
}

function torontoDateTime(utcIso) {
  if (!utcIso) return '';
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short', hour12: false })
    .format(d);
}

async function findLeadByMeetingId(meetingId) {
  if (!meetingId) return null;
  const leadService = require('./leadService');
  return leadService.findByColumnValue('zoomMeetingId', String(meetingId));
}

async function postLeadNote(leadId, body) {
  const mondayApi = require('./mondayApi');
  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
    { itemId: String(leadId), body }
  );
}

/** meeting.ended → consultation actually happened. */
async function onMeetingEnded(obj) {
  const meetingId = String(obj?.id || '');
  // Key on the meeting INSTANCE uuid: the same meeting id can legitimately
  // end multiple times (host restarts a scheduled meeting).
  const key = `ended-${meetingId}-${obj?.uuid || obj?.end_time || ''}`;
  if (alreadyHandled(key)) return;

  const lead = await findLeadByMeetingId(meetingId);
  if (!lead) { console.log(`[Zoom] meeting.ended ${meetingId} — no matching lead (not a consultation)`); return; }

  const leadService = require('./leadService');
  const endedDate = torontoDate(obj.end_time) || lead.consultationHeld;
  try {
    if (endedDate) await leadService.updateLead(lead.id, { consultationHeld: endedDate });
  } catch (err) {
    console.warn(`[Zoom] consultationHeld update failed for ${lead.id}: ${err.message}`);
  }
  const endedAt = torontoDateTime(obj.end_time);
  await postLeadNote(lead.id,
    `✅ <b>Consultation held</b> — Zoom meeting ended${endedAt ? ` ${endedAt} (Toronto)` : ''}.<br>` +
    `The recording link will be posted here automatically when Zoom finishes processing it.<br><br>` +
    `<b>Next step:</b> set the <b>Outcome</b> column on this lead (Retain → the retainer agreement is emailed automatically).`);
  markHandled(key); // only after full success — failures stay replayable
  console.log(`[Zoom] Consultation held recorded for lead ${lead.id} (meeting ${meetingId})`);
}

/** recording.completed → share the recording with staff. */
async function onRecordingCompleted(obj) {
  const meetingId = String(obj?.id || '');
  const key = `rec-${meetingId}-${obj?.uuid || ''}`;
  if (alreadyHandled(key)) return;

  const lead = await findLeadByMeetingId(meetingId);
  if (!lead) { console.log(`[Zoom] recording.completed ${meetingId} — no matching lead`); return; }

  const shareUrl = String(obj?.share_url || '');
  const passcode = obj?.recording_play_passcode || obj?.password || '';
  // Defense in depth: only ever link to Zoom itself — a forged/compromised
  // payload must not plant an arbitrary clickable URL in front of staff.
  if (!/^https:\/\/([\w-]+\.)*zoom\.us\//i.test(shareUrl)) {
    console.warn(`[Zoom] recording.completed ${meetingId}: share_url missing or not a zoom.us link — skipping`);
    return;
  }

  const leadService = require('./leadService');
  try {
    await leadService.updateLead(lead.id, { recordingLink: { url: shareUrl, text: 'Consultation recording' } });
  } catch (err) {
    console.warn(`[Zoom] recording column write failed for ${lead.id}: ${err.message}`);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  await postLeadNote(lead.id,
    `🎬 <b>Consultation recording is ready</b><br>` +
    `<a href="${esc(shareUrl)}">${esc(shareUrl)}</a>` +
    (passcode ? `<br>Passcode: <b>${esc(passcode)}</b>` : '') +
    `<br><br>Note: Zoom cloud recordings expire per your Zoom account's retention settings — download it if it must be kept long-term.`);
  markHandled(key); // only after full success
  console.log(`[Zoom] Recording link posted for lead ${lead.id} (meeting ${meetingId})`);
}

/** Dispatch a verified Zoom event. */
async function handleZoomEvent(event) {
  const type = event?.event;
  const obj = event?.payload?.object;
  if (type === 'meeting.ended') return onMeetingEnded(obj);
  if (type === 'recording.completed') return onRecordingCompleted(obj);
  console.log(`[Zoom] Ignoring event "${type}"`);
}

module.exports = {
  buildValidationResponse, verifyZoomSignature, handleZoomEvent,
  // exported for tests
  onMeetingEnded, onRecordingCompleted, torontoDate, alreadyHandled, markHandled,
};
