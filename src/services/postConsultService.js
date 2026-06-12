/**
 * Post-Consultation Service (Phase B of the Teams migration) — two crons that
 * make the post-meeting flow provider-agnostic:
 *
 * 1. sendPostConsultNudges() — when a booked slot's time has passed, post
 *    "consultation done — set the Outcome" on the lead. Replaces the
 *    Zoom-webhook dependency for Teams; coexists with it for Zoom (skips any
 *    lead the Zoom meeting.ended handler already nudged).
 *
 * 2. findTeamsRecordings() — Teams saves meeting recordings to the OneDrive
 *    of WHOEVER CLICKED RECORD (normally the consultant, not the organizer).
 *    We poll that user's /Recordings folder (RECORDINGS_DRIVE_USER, default
 *    STAFF_ATTENDEE_EMAIL) via the Files.ReadWrite.All permission already
 *    proven in production — no onlineMeetings application-access-policy
 *    ceremony. Files are matched to leads by the meeting subject (it carries
 *    the client's name) within a time window around the slot, then an
 *    org-share link is written to the Consultation Recording column + posted
 *    to the lead, exactly like the Zoom path.
 */

'use strict';

const mondayApi   = require('./mondayApi');
const { leadBoardId } = require('../../config/monday');
const C = require('../data/newLeadsBoard.json').columns;

const NUDGE_TAG = '📋 post-consult-nudge';
const SLOT_BUFFER_MIN = 45;     // meeting length + grace before we call it "done"
const NUDGE_MAX_AGE_H = 72;     // don't nudge ancient bookings on first deploy
const RECORDING_WINDOW_H = 48;  // look for recordings up to 2 days after the slot

/** Convert "YYYY-MM-DD HH:MM" Toronto wall time → UTC ms (DST-aware). */
function torontoSlotToUTC(slotStr) {
  const [d, t] = String(slotStr).split(' ');
  if (!d || !t) return NaN;
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(utcGuess));
  const m = {}; for (const p of parts) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute);
  return utcGuess - (asUTC - utcGuess);
}

/** Booked leads with the columns both crons need, updates feed included. */
async function getBookedLeadsFull() {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         items { id name updates(limit: 25) { body }
           column_values(ids: ["${C.bookedSlot}", "${C.outcome}", "${C.recordingLink}", "${C.meetingLink}", "${C.fullName}"]) { id text value } }
       }
     }`,
    { boardId: String(leadBoardId), colId: C.bookingStatus, val: 'Booked' }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => {
    const cv = {}; for (const c of it.column_values) cv[c.id] = c;
    let recordingUrl = '', meetingUrl = '';
    try { recordingUrl = JSON.parse(cv[C.recordingLink]?.value || '{}').url || ''; } catch (_) {}
    try { meetingUrl = JSON.parse(cv[C.meetingLink]?.value || '{}').url || ''; } catch (_) {}
    return {
      id: it.id,
      fullName: cv[C.fullName]?.text || it.name,
      bookedSlot: cv[C.bookedSlot]?.text || '',
      outcome: cv[C.outcome]?.text || '',
      recordingUrl, meetingUrl,
      updates: it.updates.map((u) => u.body || ''),
    };
  });
}

/** PURE: should this lead get the post-consult nudge now? */
function needsNudge(lead, now = Date.now()) {
  const slotMs = torontoSlotToUTC(lead.bookedSlot);
  if (!Number.isFinite(slotMs)) return false;
  const endMs = slotMs + SLOT_BUFFER_MIN * 60000;
  if (now < endMs) return false;                                      // not done yet
  if (now - endMs > NUDGE_MAX_AGE_H * 3600000) return false;          // too old — don't spam history
  if (lead.outcome) return false;                                     // staff already actioned
  if (lead.updates.some((b) => b.includes(NUDGE_TAG))) return false;  // already nudged (this cron)
  if (lead.updates.some((b) => b.includes('Consultation held'))) return false; // Zoom webhook already did it
  return true;
}

async function sendPostConsultNudges() {
  const leads = await getBookedLeadsFull();
  let sent = 0;
  for (const lead of leads) {
    if (!needsNudge(lead)) continue;
    try {
      await mondayApi.query(
        `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
        { i: String(lead.id),
          body: `✅ <b>Consultation time has passed</b> (was scheduled ${lead.bookedSlot} Toronto).<br>` +
                `<b>Next step:</b> set the <b>Outcome</b> column on this lead (Retain → the retainer agreement is emailed automatically).<br>` +
                `If a recording was made, its link will be posted here once it appears.<br>` +
                `<span style="display:none">${NUDGE_TAG}</span>` }
      );
      sent++;
    } catch (err) {
      console.warn(`[PostConsult] Nudge failed for ${lead.id}: ${err.message}`);
    }
  }
  if (sent) console.log(`[PostConsult] Sent ${sent} post-consult nudge(s)`);
  return sent;
}

// ─── Teams recording discovery ────────────────────────────────────────────────

function recordingsDriveUser() {
  return String(process.env.RECORDINGS_DRIVE_USER || process.env.STAFF_ATTENDEE_EMAIL || '').trim();
}

/** List recent files in the recorder's /Recordings folder (empty on any miss). */
async function listRecordingFiles() {
  const user = recordingsDriveUser();
  if (!user) return [];
  const axios = require('axios');
  const { getAccessToken } = require('./microsoftMailService');
  const token = await getAccessToken();
  try {
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user)}/drive/root:/Recordings:/children?$top=50&$orderby=createdDateTime desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return (res.data.value || []).map((f) => ({
      id: f.id, name: f.name, webUrl: f.webUrl, createdMs: Date.parse(f.createdDateTime || '') || 0, driveId: f.parentReference?.driveId,
    }));
  } catch (err) {
    // 404 = no Recordings folder yet (nothing ever recorded) — quiet no-op.
    if (err.response?.status !== 404) console.warn(`[PostConsult] Recordings listing failed for ${user}: ${err.message}`);
    return [];
  }
}

/**
 * PURE: match a lead to a recording file. Teams names recordings after the
 * meeting subject ("Consultation_ <Client Name> — TDOT Immigration-<stamp>…"),
 * with filesystem-illegal characters replaced — so match on the client-name
 * part only, plus a created-time window around the slot.
 */
function matchRecording(lead, files, now = Date.now()) {
  const slotMs = torontoSlotToUTC(lead.bookedSlot);
  if (!Number.isFinite(slotMs)) return null;
  if (now - slotMs > RECORDING_WINDOW_H * 3600000) return null; // too old, stop looking
  const needle = String(lead.fullName || '').trim().toLowerCase();
  if (!needle) return null;
  return files.find((f) =>
    f.name.toLowerCase().includes(needle) &&
    f.createdMs >= slotMs - 30 * 60000 &&
    f.createdMs <= slotMs + RECORDING_WINDOW_H * 3600000
  ) || null;
}

/** Create an org-scoped sharing link for a file in the recorder's drive. */
async function shareRecording(file) {
  const axios = require('axios');
  const { getAccessToken } = require('./microsoftMailService');
  const token = await getAccessToken();
  try {
    const res = await axios.post(
      `https://graph.microsoft.com/v1.0/drives/${file.driveId}/items/${file.id}/createLink`,
      { type: 'view', scope: 'organization' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return res.data.link?.webUrl || file.webUrl;
  } catch (_) {
    return file.webUrl; // fall back to the direct URL
  }
}

async function findTeamsRecordings() {
  const leads = (await getBookedLeadsFull()).filter((l) =>
    !l.recordingUrl && /teams\.microsoft\.com/.test(l.meetingUrl) && l.bookedSlot);
  if (!leads.length) return 0;

  const files = await listRecordingFiles();
  if (!files.length) return 0;

  const leadService = require('./leadService');
  let linked = 0;
  for (const lead of leads) {
    const file = matchRecording(lead, files);
    if (!file) continue;
    try {
      const url = await shareRecording(file);
      await leadService.updateLead(lead.id, { recordingLink: { url, text: 'Consultation recording' } });
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      await mondayApi.query(
        `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
        { i: String(lead.id),
          body: `🎬 <b>Consultation recording is ready</b> (Teams)<br><a href="${esc(url)}">${esc(url)}</a><br>` +
                `Stored in ${esc(recordingsDriveUser())}'s OneDrive Recordings folder — link is organisation-wide view access.` }
      );
      linked++;
      console.log(`[PostConsult] Recording linked for lead ${lead.id}: ${file.name}`);
    } catch (err) {
      console.warn(`[PostConsult] Recording link failed for ${lead.id}: ${err.message}`);
    }
  }
  return linked;
}

module.exports = {
  sendPostConsultNudges, findTeamsRecordings,
  // exported for tests
  needsNudge, matchRecording, torontoSlotToUTC, NUDGE_TAG,
};
