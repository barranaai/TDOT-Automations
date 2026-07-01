/**
 * Teams Transcript Service — fetches the Microsoft Teams meeting transcript for a
 * consultation and stores it on the lead, mirroring the recording flow.
 *
 * Unlike Zoom (where the transcript rode along on the recording share page),
 * Teams keeps the transcript as a separate artifact reachable only via Graph:
 *
 *   1. Resolve the onlineMeeting id from the stored join URL:
 *        GET /users/{organizer}/onlineMeetings?$filter=JoinWebUrl eq '{joinUrl}'
 *   2. List transcripts (empty until someone transcribed the meeting):
 *        GET /users/{organizer}/onlineMeetings/{id}/transcripts
 *   3. Download the latest as WebVTT:
 *        GET  …/transcripts/{tid}/content?$format=text/vtt
 *   4. Store it in the lead's OneDrive folder + write an org-share link to the
 *      Consultation Transcript column + post a note.
 *
 * SETUP REQUIRED (app-only) — see docs/teams-transcript-setup.md:
 *   • Application permissions OnlineMeetings.Read.All + OnlineMeetingTranscript.Read.All
 *     (admin-consented on the same Azure app used for mail/OneDrive).
 *   • A Teams application access policy granting that app id access to the
 *     MEETING_ORGANIZER_EMAIL mailbox (New-CsApplicationAccessPolicy / Grant-…).
 *   • Only works because our Teams meetings are CALENDAR EVENTS (the transcripts
 *     API rejects meetings created with the raw create-onlineMeeting API).
 *
 * Inert without that setup: every call fails closed (logged, returns 0).
 */

'use strict';

const axios       = require('axios');
const mondayApi   = require('./mondayApi');
const { leadBoardId } = require('../../config/monday');
const C = require('../data/newLeadsBoard.json').columns;
const { torontoSlotToUTC } = require('./postConsultService');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TRANSCRIPT_WINDOW_H = 72;   // transcripts can lag hours after the meeting; keep looking up to 3 days
const SLOT_BUFFER_MIN = 45;       // meeting length + grace before it counts as "done"
const TEAMS_RE = /teams\.microsoft\.com/i;

function organizer() { return String(process.env.MEETING_ORGANIZER_EMAIL || '').trim(); }

// ─── PURE helpers (exported for tests) ────────────────────────────────────────

/** Should we still be polling for this lead's transcript right now? */
function isTranscriptCandidate(lead, now = Date.now()) {
  if (lead.transcriptUrl) return false;                       // already captured
  if (!TEAMS_RE.test(lead.meetingUrl || '')) return false;    // not a Teams meeting
  const slotMs = torontoSlotToUTC(lead.bookedSlot);
  if (!Number.isFinite(slotMs)) return false;
  if (now < slotMs + SLOT_BUFFER_MIN * 60000) return false;   // not done yet
  if (now - slotMs > TRANSCRIPT_WINDOW_H * 3600000) return false; // window closed — stop looking
  return true;
}

function meetingLookupUrl(org, joinUrl) {
  const filter = `JoinWebUrl eq '${String(joinUrl).replace(/'/g, "''")}'`;
  return `${GRAPH}/users/${encodeURIComponent(org)}/onlineMeetings?$filter=${encodeURIComponent(filter)}`;
}
function transcriptsListUrl(org, meetingId) {
  return `${GRAPH}/users/${encodeURIComponent(org)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`;
}
function transcriptContentUrl(org, meetingId, transcriptId) {
  return `${GRAPH}/users/${encodeURIComponent(org)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`;
}
/** Newest transcript first (a meeting can have several — pick the latest). */
function pickLatestTranscript(transcripts) {
  if (!Array.isArray(transcripts) || !transcripts.length) return null;
  return transcripts.slice().sort((a, b) => Date.parse(b.createdDateTime || 0) - Date.parse(a.createdDateTime || 0))[0];
}
function graphErr(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  const inner = e && e.innerError && e.innerError.code;
  return e ? `${err.response.status} ${e.code}${inner ? '/' + inner : ''}: ${e.message}` : (err && err.message) || String(err);
}

// ─── Monday: booked Teams leads still awaiting a transcript ───────────────────

async function getTranscriptCandidates() {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         items { id name
           column_values(ids: ["${C.bookedSlot}", "${C.meetingLink}", "${C.transcriptLink}", "${C.fullName}", "${C.oneDriveFolderId}"]) { id text value } }
       }
     }`,
    { boardId: String(leadBoardId), colId: C.bookingStatus, val: 'Booked' }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => {
    const cv = {}; for (const c of it.column_values) cv[c.id] = c;
    let transcriptUrl = '', meetingUrl = '';
    try { transcriptUrl = JSON.parse(cv[C.transcriptLink]?.value || '{}').url || ''; } catch (_) {}
    try { meetingUrl = JSON.parse(cv[C.meetingLink]?.value || '{}').url || ''; } catch (_) {}
    return { id: it.id, fullName: cv[C.fullName]?.text || it.name, bookedSlot: cv[C.bookedSlot]?.text || '',
      transcriptUrl, meetingUrl, oneDriveFolderId: cv[C.oneDriveFolderId]?.text || '' };
  });
}

// ─── Graph I/O ────────────────────────────────────────────────────────────────

async function resolveMeetingId(token, org, joinUrl) {
  const res = await axios.get(meetingLookupUrl(org, joinUrl), { headers: { Authorization: `Bearer ${token}` } });
  return res.data?.value?.[0]?.id || null;
}
async function listTranscripts(token, org, meetingId) {
  const res = await axios.get(transcriptsListUrl(org, meetingId), { headers: { Authorization: `Bearer ${token}` } });
  return res.data?.value || [];
}
async function fetchTranscriptVtt(token, org, meetingId, transcriptId) {
  const res = await axios.get(transcriptContentUrl(org, meetingId, transcriptId),
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'text' });
  return typeof res.data === 'string' ? res.data : String(res.data || '');
}

// ─── The cron ─────────────────────────────────────────────────────────────────

let _running = false; // crons fire every 30 min; skip if a slow run overruns (avoids double-store / double-note)
async function findTeamsTranscripts() {
  const org = organizer();
  if (!org) return 0;
  if (_running) { console.log('[Transcript] previous run still in progress — skipping'); return 0; }
  _running = true;
  try {
  const candidates = (await getTranscriptCandidates()).filter((l) => isTranscriptCandidate(l));
  if (!candidates.length) return 0;

  const { getAccessToken } = require('./microsoftMailService');
  let token;
  try { token = await getAccessToken(); } catch (err) { console.warn(`[Transcript] token failed: ${err.message}`); return 0; }

  const oneDrive    = require('./oneDriveService');
  const leadService = require('./leadService');
  let linked = 0;

  for (const lead of candidates) {
    try {
      const meetingId = await resolveMeetingId(token, org, lead.meetingUrl);
      if (!meetingId) { console.log(`[Transcript] ${lead.id}: no onlineMeeting matched the join URL — skip`); continue; }

      const transcript = pickLatestTranscript(await listTranscripts(token, org, meetingId));
      if (!transcript) continue; // not transcribed yet (or still processing) — try again next run

      const vtt = await fetchTranscriptVtt(token, org, meetingId, transcript.id);
      if (!vtt.trim()) continue;

      const { url } = await oneDrive.uploadToLeadFolderAndLink({
        fullName: lead.fullName, leadId: lead.id, folderId: lead.oneDriveFolderId,
        filename: 'consultation-transcript.vtt', buffer: Buffer.from(vtt, 'utf8'), mimeType: 'text/vtt',
      });
      await leadService.updateLead(lead.id, { transcriptLink: { url, text: 'Consultation transcript' } });

      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      await mondayApi.query(
        `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
        { i: String(lead.id),
          body: `📝 <b>Consultation transcript is ready</b> (Teams)<br><a href="${esc(url)}">${esc(url)}</a><br>` +
                `Fetched from the Teams meeting and saved to the client's OneDrive folder (WebVTT).` }
      );
      linked++;
      console.log(`[Transcript] Linked transcript for lead ${lead.id} (${transcript.id})`);
    } catch (err) {
      console.warn(`[Transcript] ${lead.id}: ${graphErr(err)}`);
    }
  }
  if (linked) console.log(`[Transcript] Linked ${linked} Teams transcript(s)`);
  return linked;
  } finally { _running = false; }
}

/**
 * PREFLIGHT — verify the transcript setup WITHOUT needing a real transcribed
 * meeting. Probes the organizer's online meetings with a no-match filter:
 *   • 200 (even empty) → OnlineMeetings.Read.All + the Teams application access
 *     policy are active for the organizer. You're good.
 *   • 403 → the permission isn't admin-consented, OR the app-access-policy is
 *     missing / hasn't propagated yet (allow ~30 min).
 *   • 404 → organizer mailbox not found (MEETING_ORGANIZER_EMAIL wrong).
 * If a booked Teams meeting exists, it also exercises the real path and reports
 * whether a transcript is available yet. Run: POST /api/transcript-preflight
 */
async function preflightTranscripts() {
  const org = organizer();
  if (!org) return { ok: false, error: 'MEETING_ORGANIZER_EMAIL not set' };

  const { getAccessToken } = require('./microsoftMailService');
  let token;
  try { token = await getAccessToken(); }
  catch (err) { return { ok: false, step: 'token', error: err.message }; }

  // Tier 1 — access probe. A no-match filter returns 200 with an empty page when
  // access is in place; it 403s before evaluating the filter when it isn't.
  try {
    await axios.get(meetingLookupUrl(org, 'https://teams.microsoft.com/l/meetup-join/preflight-no-match'),
      { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    const status = err.response && err.response.status;
    const e = err.response && err.response.data && err.response.data.error;
    return { ok: false, step: 'onlineMeetings', status, error: e ? `${e.code}: ${e.message}` : err.message,
      hint: status === 403 ? `Either OnlineMeetings.Read.All isn't admin-consented, or the Teams application access policy isn't granted / hasn't propagated yet for ${org} (allow ~30 min).`
          : status === 404 ? `Organizer mailbox not found — check MEETING_ORGANIZER_EMAIL (${org}).`
          : undefined };
  }

  const result = { ok: true, organizer: org,
    message: `Access OK — Graph reached ${org}'s online meetings. The app permission + application access policy are active. Transcripts will be captured once a meeting is transcribed.` };

  // Tier 2 (best-effort) — exercise the real path against a booked Teams meeting.
  try {
    const lead = (await getTranscriptCandidates()).find((l) => TEAMS_RE.test(l.meetingUrl || ''));
    if (lead) {
      result.sampleLead = lead.id;
      const meetingId = await resolveMeetingId(token, org, lead.meetingUrl);
      if (!meetingId) result.sample = 'Sample join URL resolved 0 meetings (that meeting may have expired — not a setup problem).';
      else {
        const transcripts = await listTranscripts(token, org, meetingId);
        result.sample = `Sample meeting resolved; ${transcripts.length} transcript(s) available.`;
      }
    }
  } catch (err) { result.sampleError = graphErr(err); }

  return result;
}

module.exports = {
  findTeamsTranscripts, preflightTranscripts,
  // pure — exported for tests
  isTranscriptCandidate, meetingLookupUrl, transcriptsListUrl, transcriptContentUrl, pickLatestTranscript, graphErr,
};
