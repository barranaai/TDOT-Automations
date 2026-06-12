/**
 * Meeting Service — provider-agnostic consultation meeting creation.
 *
 *   MEETING_PROVIDER=zoom   (default) → Zoom server-to-server OAuth meeting
 *   MEETING_PROVIDER=teams            → Microsoft Teams meeting, created as a
 *                                       Graph CALENDAR EVENT on the organizer's
 *                                       account (MEETING_ORGANIZER_EMAIL)
 *
 * Why the calendar-event route for Teams (vs the onlineMeetings API):
 *   - the meeting lands on the organizer's Outlook calendar automatically
 *     (staff visibility — no second calendar to check),
 *   - the client is a real attendee → they receive a native Outlook/Teams
 *     calendar invite on top of our branded confirmation email,
 *   - it needs only Calendars.ReadWrite (application) — no PowerShell
 *     application-access-policy ceremony.
 *
 * Both providers return the same shape: { meetingId, joinUrl, password,
 * provider } — consultationService neither knows nor cares which ran.
 * Flipping the env var back to zoom is an instant rollback; existing booked
 * meetings keep working either way (their join links are already stored).
 */

'use strict';

const axios = require('axios');

const TZ = 'America/Toronto';

function provider() {
  return String(process.env.MEETING_PROVIDER || 'zoom').toLowerCase() === 'teams' ? 'teams' : 'zoom';
}

// ─── Zoom (moved verbatim from consultationService — behavior unchanged) ─────

let _zoomToken = { token: null, expiresAt: 0 };
async function getZoomAccessToken() {
  if (_zoomToken.token && Date.now() < _zoomToken.expiresAt - 60000) return _zoomToken.token;
  const res = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'account_credentials', account_id: process.env.ZOOM_ACCOUNT_ID },
    auth: { username: process.env.ZOOM_CLIENT_ID, password: process.env.ZOOM_CLIENT_SECRET },
  });
  _zoomToken = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return _zoomToken.token;
}

/** Convert "YYYY-MM-DD HH:MM" Toronto wall time → UTC ms (DST-aware). */
function torontoSlotToUTC(slotStr) {
  const [d, t] = String(slotStr).split(' ');
  if (!d || !t) return NaN;
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(utcGuess));
  const m = {}; for (const p of parts) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute);
  return utcGuess - (asUTC - utcGuess);
}

async function createZoomMeeting(lead, slotStr, duration = 30) {
  const startUtcMs = torontoSlotToUTC(slotStr);
  if (!Number.isFinite(startUtcMs)) throw new Error(`Invalid slot "${slotStr}" — cannot schedule meeting`);
  const startTimeGmt = new Date(startUtcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const token = await getZoomAccessToken();
  const res = await axios.post(
    'https://api.zoom.us/v2/users/me/meetings',
    {
      topic: `Consultation: ${lead.fullName || 'Client'}`,
      type: 2,
      start_time: startTimeGmt,
      duration,
      timezone: TZ,
      settings: { join_before_host: false, waiting_room: true, auto_recording: process.env.ZOOM_AUTO_RECORDING || 'none' },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return { meetingId: String(res.data.id), joinUrl: res.data.join_url, password: res.data.password || '', provider: 'zoom' };
}

// ─── Microsoft Teams (Graph calendar event with isOnlineMeeting) ─────────────

/** "YYYY-MM-DD HH:MM" + minutes → Graph dateTime strings (wall time + named TZ). */
function slotToGraphTimes(slotStr, durationMinutes) {
  const m = String(slotStr).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid slot "${slotStr}" — cannot schedule meeting`);
  const [, date, hh, mm] = m;
  const startMin = Number(hh) * 60 + Number(mm);
  const endMin = startMin + durationMinutes;
  // Same-day end is guaranteed for consult slots (afternoon + 15-60 min).
  const pad = (n) => String(n).padStart(2, '0');
  return {
    start: { dateTime: `${date}T${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}:00`, timeZone: TZ },
    end:   { dateTime: `${date}T${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`, timeZone: TZ },
  };
}

/** PURE: the Graph event payload (exported for tests). */
function buildTeamsEventPayload(lead, slotStr, durationMinutes, { includeAttendees = true } = {}) {
  const { start, end } = slotToGraphTimes(slotStr, durationMinutes);
  const payload = {
    subject: `Consultation: ${lead.fullName || 'Client'} — TDOT Immigration`,
    body: {
      contentType: 'HTML',
      content: `<p>Immigration consultation with TDOT Immigration.</p><p>Booked for ${slotStr} (Toronto time).</p>`,
    },
    start, end,
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    allowNewTimeProposals: false,
  };
  payload.attendees = [];
  if (!includeAttendees) { delete payload.attendees; return payload; }
  if (lead.email) {
    payload.attendees.push({
      emailAddress: { address: lead.email, name: lead.fullName || 'Client' },
      type: 'required',
    });
  }
  // The consultant is invited too: the organizer (noreply automation account)
  // never joins, so the staff attendee is who actually runs the meeting,
  // receives the invite + join link, and admits the client from the lobby.
  const staff = String(process.env.STAFF_ATTENDEE_EMAIL || '').trim();
  if (staff) {
    payload.attendees.push({
      emailAddress: { address: staff, name: 'TDOT Immigration Consultant' },
      type: 'required',
    });
  }
  if (!payload.attendees.length) delete payload.attendees;
  return payload;
}

async function createTeamsMeeting(lead, slotStr, duration = 30) {
  const organizer = process.env.MEETING_ORGANIZER_EMAIL;
  if (!organizer) {
    throw new Error('MEETING_ORGANIZER_EMAIL not set — required for Teams meetings (a Teams-licensed staff mailbox)');
  }
  const { getAccessToken } = require('./microsoftMailService');
  const token = await getAccessToken();

  const res = await axios.post(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events`,
    buildTeamsEventPayload(lead, slotStr, duration),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const joinUrl = res.data.onlineMeeting?.joinUrl || res.data.onlineMeetingUrl || '';
  if (!joinUrl) {
    // Event exists but carries no Teams link — surface loudly rather than
    // emailing a confirmation with a dead "join" section.
    throw new Error(`Teams event ${res.data.id} created but no join URL returned — check the organizer's Teams license`);
  }
  return { meetingId: String(res.data.id), joinUrl, password: '', provider: 'teams' };
}

/**
 * PREFLIGHT: prove the Teams setup end-to-end with ZERO client impact —
 * creates a throwaway Teams event on the organizer's calendar (NO attendees,
 * so nobody receives an invite), confirms a join URL comes back (= organizer
 * exists + Calendars.ReadWrite granted + Teams license active), then deletes
 * the event. Run via POST /api/meeting-preflight before flipping the provider.
 */
async function preflightTeams() {
  const organizer = process.env.MEETING_ORGANIZER_EMAIL;
  if (!organizer) return { ok: false, error: 'MEETING_ORGANIZER_EMAIL not set' };

  const { getAccessToken } = require('./microsoftMailService');
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // a slot ~10 minutes from now, Toronto wall time
  const soon = new Date(Date.now() + 10 * 60000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(soon);
  const f = {}; for (const x of p) f[x.type] = x.value;
  const slotStr = `${f.year}-${f.month}-${f.day} ${f.hour === '24' ? '00' : f.hour}:${f.minute}`;

  const payload = buildTeamsEventPayload({ fullName: 'TDOT Preflight (safe to ignore)' }, slotStr, 15, { includeAttendees: false });
  payload.subject = 'TDOT preflight check — auto-deleted';

  let event;
  try {
    const res = await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events`, payload, { headers });
    event = res.data;
  } catch (err) {
    const detail = err.response?.data?.error;
    return { ok: false, step: 'create-event', status: err.response?.status,
      error: detail ? `${detail.code}: ${detail.message}` : err.message,
      hint: err.response?.status === 403 ? 'Calendars.ReadWrite (Application) likely missing or admin consent not granted'
          : err.response?.status === 404 ? 'Organizer mailbox not found — check MEETING_ORGANIZER_EMAIL' : undefined };
  }

  const joinUrl = event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || '';
  // Clean up regardless of join-URL outcome.
  await axios.delete(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events/${event.id}`, { headers })
    .catch((err) => console.warn(`[Meeting] Preflight cleanup failed (delete event ${event.id} manually): ${err.message}`));

  if (!joinUrl) {
    return { ok: false, step: 'join-url', error: 'Event created but no Teams join URL — the organizer mailbox likely has no Teams license', organizer };
  }
  return { ok: true, organizer, joinUrlSample: joinUrl.slice(0, 60) + '…',
    staffAttendee: process.env.STAFF_ATTENDEE_EMAIL || '(not set — recommended!)' };
}

// ─── The provider-agnostic entry point ────────────────────────────────────────

/**
 * @param {object} lead     needs fullName, email
 * @param {string} slotStr  "YYYY-MM-DD HH:MM" Toronto
 * @returns {Promise<{ meetingId, joinUrl, password, provider }>}
 */
async function createMeeting(lead, slotStr, duration = 30) {
  if (provider() === 'teams') return createTeamsMeeting(lead, slotStr, duration);
  return createZoomMeeting(lead, slotStr, duration);
}

module.exports = {
  createMeeting, provider, preflightTeams,
  // exported for tests / direct use
  createZoomMeeting, createTeamsMeeting, buildTeamsEventPayload, slotToGraphTimes, getZoomAccessToken,
};
