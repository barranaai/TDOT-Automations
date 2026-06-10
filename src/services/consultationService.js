/**
 * Consultation Service (Phase 2 — WS4)
 *
 * After a booking is paid (bookingService.confirmSlot → onSlotConfirmed):
 *   - create a Zoom meeting
 *   - email the client the Zoom link + pre-consult form link
 * Plus the pre-consult form itself and reminder crons. Lead Board writes only.
 */

'use strict';

const axios              = require('axios');
const leadService        = require('./leadService');
const microsoftMail      = require('./microsoftMailService');
const mondayApi          = require('./mondayApi');
const { leadBoardId }    = require('../../config/monday');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

const RENDER_URL      = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
const ZOOM_RECORDING  = process.env.ZOOM_AUTO_RECORDING || 'none'; // 'cloud' when transcript feature ships
const TZ              = 'America/Toronto';

// ─── Zoom auth (server-to-server OAuth, cached) ──────────────────────────────
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

/** Create a Zoom meeting for a slot string "YYYY-MM-DD HH:MM" (Toronto local). */
async function createZoomMeeting(lead, slotStr, duration = 30) {
  // Send the start time as an explicit GMT instant ("...Z"). Sending local
  // time + a timezone field proved unreliable: Zoom ignored the timezone and
  // applied the host account's profile timezone (observed: a 14:30 Toronto
  // slot created as 14:30 Asia/Tashkent = 5:30 AM Toronto). UTC is unambiguous;
  // the timezone field below is then only used for display in Zoom's portal.
  const startUtcMs = torontoSlotToUTC(slotStr);
  if (!Number.isFinite(startUtcMs)) throw new Error(`Invalid slot "${slotStr}" — cannot schedule Zoom meeting`);
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
      settings: { join_before_host: false, waiting_room: true, auto_recording: ZOOM_RECORDING },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return { meetingId: String(res.data.id), joinUrl: res.data.join_url, password: res.data.password };
}

// ─── Entry point: called by bookingService after payment ─────────────────────
async function onSlotConfirmed(leadId) {
  try {
    const lead = await leadService.getLead(leadId);
    if (!lead) return;
    if (lead.zoomMeetingId) {
      console.log(`[Consult] Lead ${leadId} already has Zoom meeting — skipping`);
      return;
    }
    const slotStr = (lead.bookedSlot || '').trim();
    const meeting = await createZoomMeeting(lead, slotStr);

    await leadService.updateLead(leadId, {
      zoomMeetingId:   meeting.meetingId,
      consultationHeld: slotStr.split(' ')[0], // date of the consult
    });

    await sendBookingConfirmation(lead, meeting, slotStr);
    console.log(`[Consult] Zoom + confirmation sent for lead ${leadId} (meeting ${meeting.meetingId})`);
  } catch (err) {
    console.error(`[Consult] onSlotConfirmed failed for lead ${leadId}:`, err.message);
  }
}

async function sendBookingConfirmation(lead, meeting, slotStr) {
  if (!lead.email) return;
  const token  = lead.leadToken || '';
  const preUrl = `${RENDER_URL}/consult/${lead.id}?t=${encodeURIComponent(token)}`;
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your consultation is booked</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${escapeHtml((lead.fullName||'there').split(' ')[0])},</p>
      <p><b>When:</b> ${escapeHtml(slotStr)} (Toronto time)</p>
      <p><b>Join the Zoom call:</b><br><a href="${meeting.joinUrl}" style="color:${BRAND.primary}">${meeting.joinUrl}</a></p>
      <p style="margin-top:24px">Please complete this short form before your call so we can make the most of your time:</p>
      <p><a href="${preUrl}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Complete pre-consultation form</a></p>
      <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">See you on the call.</p>
    </div></div>`;
  await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration consultation is booked', html });
}

// ─── Pre-consult form ────────────────────────────────────────────────────────
function buildPreConsultFormHtml(lead) {
  const tok = encodeURIComponent(lead.leadToken || '');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pre-Consultation — TDOT Immigration</title><style>
    body{background:${BRAND.lightBg};font-family:-apple-system,sans-serif;margin:0;color:${BRAND.textOnLight}}
    .container{max-width:600px;margin:0 auto;padding:32px 24px}
    .header{background:${BRAND.darkPanel};color:${BRAND.textOnDark};padding:24px;border-radius:12px 12px 0 0;text-align:center}
    .card{background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}
    label{display:block;font-weight:600;margin:16px 0 6px}
    input,select,textarea{width:100%;padding:12px;border:1px solid ${BRAND.border};border-radius:8px;font-size:15px;box-sizing:border-box}
    button{background:${BRAND.primary};color:#fff;padding:14px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;margin-top:24px;width:100%}
  </style></head><body><div class="container">
    <div class="header">${TDOT_LOGO_LIGHT_HTML}<h1 style="margin:12px 0 4px">Before Your Consultation</h1>
    <p style="margin:0;opacity:.85;font-size:14px">A few details so we can prepare.</p></div>
    <form class="card" method="POST" action="/consult/${lead.id}?t=${tok}">
      <label>Case type</label>
      <input name="caseType" value="${escapeHtml(lead.caseTypeInterest||'')}">
      <label>Do you have a deadline or target date?</label>
      <input name="deadline" placeholder="e.g. program starts September, or none">
      <label>Where are you now / current status?</label>
      <input name="currentStatus" placeholder="e.g. in Canada on a study permit / outside Canada">
      <label>What have you done so far, and which documents do you already have?</label>
      <textarea name="progress" rows="4"></textarea>
      <label>Your top questions for the consultant</label>
      <textarea name="questions" rows="4"></textarea>
      <button type="submit">Submit</button>
    </form></div></body></html>`;
}

/** Save pre-consult answers as a Monday Update on the lead, set status = Yes. */
async function savePreConsultData(leadId, formData) {
  const lines = [
    '📝 Pre-Consultation Form submitted',
    '',
    `Case type: ${formData.caseType || '—'}`,
    `Deadline: ${formData.deadline || '—'}`,
    `Current status: ${formData.currentStatus || '—'}`,
    '',
    `Progress / documents:\n${formData.progress || '—'}`,
    '',
    `Questions for consultant:\n${formData.questions || '—'}`,
  ].join('\n');

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId: String(leadId), body: lines }
  );
  await leadService.updateLead(leadId, { preConsultSubmitted: 'Yes' });
  console.log(`[Consult] Pre-consult saved for lead ${leadId}`);
}

// ─── Reminders (crons) ───────────────────────────────────────────────────────

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

async function getBookedLeads() {
  const C = require('../data/newLeadsBoard.json').columns;
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         items { id name updates { body }
           column_values(ids: ["${C.bookedSlot}","${C.preConsultSubmitted}"]) { id text } }
       }
     }`,
    { boardId: String(leadBoardId), colId: C.bookingStatus, val: 'Booked' }
  );
  const C2 = C;
  return (data?.items_page_by_column_values?.items || []).map((it) => {
    const cv = {}; it.column_values.forEach((c) => { cv[c.id] = c.text || ''; });
    return { id: it.id, name: it.name, bookedSlot: cv[C2.bookedSlot], preConsult: cv[C2.preConsultSubmitted],
             updates: (it.updates || []).map((u) => u.body || '') };
  });
}

async function sendReminderWindow(label, minH, maxH, markerTag) {
  const leads = await getBookedLeads();
  const now = Date.now();
  let sent = 0;
  for (const L of leads) {
    const ts = torontoSlotToUTC(L.bookedSlot);
    if (isNaN(ts)) continue;
    const hoursOut = (ts - now) / 3600000;
    if (hoursOut < minH || hoursOut >= maxH) continue;
    if (L.updates.some((b) => b.includes(markerTag))) continue; // dedup via updates feed
    try {
      const lead = await leadService.getLead(L.id);
      if (lead.email) {
        await microsoftMail.sendEmail({
          to: lead.email,
          subject: `Reminder: your TDOT consultation (${L.bookedSlot} Toronto)`,
          html: `<p>Hi ${escapeHtml((lead.name || 'there').split(' ')[0])}, this is a reminder of your consultation on <b>${escapeHtml(L.bookedSlot)}</b> (Toronto time).</p>`,
        });
      }
      await mondayApi.query(`mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
        { itemId: String(L.id), body: markerTag });
      sent++;
    } catch (err) { console.warn(`[Consult] ${label} reminder failed for ${L.id}: ${err.message}`); }
  }
  if (sent) console.log(`[Consult] Sent ${sent} ${label} reminder(s)`);
}

const send24hReminders      = () => sendReminderWindow('24h', 23, 25, '⏰ 24h reminder sent');
const send1hReminders       = () => sendReminderWindow('1h', 0.5, 1.5, '⏰ 1h reminder sent');
async function sendPreConsultReminders() {
  const leads = await getBookedLeads();
  const now = Date.now();
  let sent = 0;
  for (const L of leads) {
    if (L.preConsult === 'Yes') continue;
    const ts = torontoSlotToUTC(L.bookedSlot);
    const hoursOut = (ts - now) / 3600000;
    if (hoursOut < 1 || hoursOut >= 24) continue;
    if (L.updates.some((b) => b.includes('📋 pre-consult chase sent'))) continue;
    try {
      const lead = await leadService.getLead(L.id);
      const preUrl = `${RENDER_URL}/consult/${lead.id}?t=${encodeURIComponent(lead.leadToken || '')}`;
      if (lead.email) await microsoftMail.sendEmail({ to: lead.email, subject: 'Please complete your pre-consultation form',
        html: `<p>Hi ${escapeHtml((lead.name || 'there').split(' ')[0])}, please complete your pre-consultation form before your call:</p><p><a href="${preUrl}">${preUrl}</a></p>` });
      await mondayApi.query(`mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
        { itemId: String(L.id), body: '📋 pre-consult chase sent' });
      sent++;
    } catch (err) { console.warn(`[Consult] pre-consult chase failed for ${L.id}: ${err.message}`); }
  }
  if (sent) console.log(`[Consult] Sent ${sent} pre-consult chase(s)`);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  onSlotConfirmed, createZoomMeeting, getZoomAccessToken,
  buildPreConsultFormHtml, savePreConsultData,
  send24hReminders, send1hReminders, sendPreConsultReminders,
};
