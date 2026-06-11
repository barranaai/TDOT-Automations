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

// Service-specific deep-dive questions (mirrors the intake brief's F-sets).
// Prefilled from the intake archive when the client answered them already.
const PRECONSULT_FQ = {
  F1:  [['f1_crsScore', 'Your CRS score', 'number'], ['f1_itaDeadline', 'ITA deadline', 'date'], ['f1_program', 'Program or draw that invited you', 'text']],
  F2:  [['f2_deadline', 'Nomination/NOI deadline', 'date'], ['f2_province', 'Province', 'text']],
  F3:  [['f3_permitType', 'Work permit you currently hold', 'text'], ['f3_prSubmitted', 'Have you submitted PR / received AOR?', 'text']],
  F4:  [['f4_intake', 'Intake you are targeting', 'text'], ['f4_deadline', 'School deadline', 'date']],
  F5:  [['f5_purpose', 'Purpose of travel or stay extension', 'textarea']],
  F6:  [['f6_whoSponsors', 'Who is sponsoring whom', 'text'], ['f6_concerns', 'Any refusal or marriage-history concerns', 'text']],
  F7:  [['f7_prDate', 'When you became a permanent resident', 'date']],
  F8:  [['f8_role', 'Are you the employer or the employee?', 'text'], ['f8_jobTitle', 'Job title', 'text']],
  F9:  [['f9_refusalDate', 'Date of the refusal', 'date'], ['f9_deadline', 'Deadline to reapply or respond', 'date']],
  F10: [['f10_need', 'Document or update you need', 'text'], ['f10_deadline', 'Deadline', 'date']],
};

/** Best-effort load of the full intake archive from the client's OneDrive folder. */
async function loadIntakeArchive(lead) {
  try {
    const oneDrive = require('./oneDriveService');
    const buf = await oneDrive.readFile({
      clientName: lead.fullName, caseRef: `LEAD-${lead.id}`, subfolder: 'Intake', filename: 'intake-submission.json',
    });
    return buf ? (JSON.parse(buf.toString()).fields || null) : null;
  } catch (err) {
    console.warn(`[Consult] Intake archive unavailable for ${lead.id} (form still works): ${err.message}`);
    return null;
  }
}

async function buildPreConsultFormHtml(lead) {
  const { serviceToFBlock } = require('./intakeFormService');
  const archive = await loadIntakeArchive(lead) || {};
  const tok = encodeURIComponent(lead.leadToken || '');
  const e = escapeHtml;

  // "What we already know" — read-only snapshot from the intake.
  const known = [];
  const k = (label, v) => { if (String(v || '').trim()) known.push(`<div><b>${label}:</b> ${e(v)}</div>`); };
  k('Name', lead.fullName); k('Service', lead.serviceRequired || lead.caseTypeInterest);
  k('Inside Canada', lead.insideCanada); k('Current status', lead.currentStatus);
  k('Status expiry', lead.statusExpiry);
  k('Urgent deadline', lead.deadlineDate ? `${lead.deadlineDate} (${lead.deadlineReason || ''})` : '');
  k('Your inquiry', archive.situationDescription || lead.situationDescription);

  // Service-specific deep-dive, prefilled from the archive.
  const fBlock = serviceToFBlock(lead.serviceRequired || '');
  const fq = (PRECONSULT_FQ[fBlock] || []).map(([name, label, type]) => {
    const val = e(archive[name] || '');
    if (type === 'textarea') return `<label>${label}</label><textarea name="${name}" rows="3">${val}</textarea>`;
    return `<label>${label}</label><input type="${type}" name="${name}" value="${val}">`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pre-Consultation — TDOT Immigration</title><style>
    body{background:${BRAND.lightBg};font-family:-apple-system,sans-serif;margin:0;color:${BRAND.textOnLight}}
    .container{max-width:620px;margin:0 auto;padding:32px 24px}
    .header{background:${BRAND.darkPanel};color:${BRAND.textOnDark};padding:24px;border-radius:12px 12px 0 0;text-align:center}
    .card{background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}
    .known{background:#fff;border:1px solid ${BRAND.border};border-radius:10px;padding:16px 18px;font-size:14px;line-height:1.7}
    .known .note{color:${BRAND.mutedOnLight};font-size:12.5px;margin-top:8px}
    h2{font-size:16px;color:${BRAND.darkPanel};margin:24px 0 4px}
    label{display:block;font-weight:600;margin:16px 0 6px;font-size:14.5px}
    input,select,textarea{width:100%;padding:12px;border:1px solid ${BRAND.border};border-radius:8px;font-size:15px;box-sizing:border-box;background:#fff}
    button{background:${BRAND.primary};color:#fff;padding:14px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;margin-top:24px;width:100%}
    button:disabled{opacity:.75;cursor:not-allowed}
    .spin{display:inline-block;width:15px;height:15px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;vertical-align:-2px;margin-right:8px;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body><div class="container">
    <div class="header">${TDOT_LOGO_LIGHT_HTML}<h1 style="margin:12px 0 4px">Before Your Consultation</h1>
    <p style="margin:0;opacity:.85;font-size:14px">A few details so we can make the most of your time.</p></div>
    <form class="card" method="POST" action="/consult/${lead.id}?t=${tok}">
      ${known.length ? `<h2 style="margin-top:0">What you've told us</h2><div class="known">${known.join('')}
        <div class="note">Spot something wrong or outdated? Correct it in the questions below.</div></div>` : ''}

      <h2>Your case details</h2>
      <label>Has anything changed since you filled in our intake form?</label>
      <textarea name="changes" rows="3" placeholder="New documents, new deadlines, a decision arrived — or 'nothing changed'"></textarea>
      <label>Do you have a deadline or target date?</label>
      <input name="deadline" value="${e(lead.deadlineDate ? `${lead.deadlineDate} (${lead.deadlineReason || ''})` : '')}" placeholder="e.g. program starts September, or none">
      ${fq ? `<h2>About your ${e(lead.serviceRequired || 'case')}</h2>${fq}` : ''}

      <h2>Help us prepare</h2>
      <label>What have you done so far, and which documents do you already have?</label>
      <textarea name="progress" rows="4">${e(archive.recentExtensionDetails || '')}</textarea>
      <label>Your top questions for the consultant</label>
      <textarea name="questions" rows="4"></textarea>
      <button type="submit" id="pcBtn">Submit</button>
    </form></div>
  <script>
    (function(){
      var form = document.querySelector('form'), btn = document.getElementById('pcBtn');
      form.addEventListener('submit', function(){ btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving your answers…'; });
      window.addEventListener('pageshow', function(){ if (btn.disabled) { btn.disabled = false; btn.innerHTML = 'Submit'; } });
    })();
  </script></body></html>`;
}

/**
 * Save pre-consult answers:
 *   1. Complete Monday update on the lead (core op) + status = Yes.
 *   2. Raw answers archived as pre-consult-submission.json in the client's
 *      OneDrive Intake folder (next to intake-submission.json).
 *   3. A FULL-DOSSIER PDF — every intake answer (from the archive + lead
 *      columns) plus every pre-consult answer, in sections — saved to the
 *      same folder, staff link in the "Pre-Consult PDF" column.
 * OneDrive steps are best-effort; a Graph outage never loses the answers.
 */
async function savePreConsultData(leadId, formData) {
  const lead = await leadService.getLead(leadId);
  const e = escapeHtml;
  const { serviceToFBlock } = require('./intakeFormService');
  const fBlock = serviceToFBlock(lead?.serviceRequired || '');
  const qa = buildPreConsultQA(lead || {}, formData, fBlock);

  // 1. Formatted Monday update (the staff-visible record of THIS submission).
  const body = ['📝 <b>Pre-Consultation Form submitted</b><br>']
    .concat(qa.map(([q, a]) => `<b>${e(q)}:</b> ${e(a || '—')}`))
    .join('<br>');
  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId: String(leadId), body }
  );
  await leadService.updateLead(leadId, { preConsultSubmitted: 'Yes' });
  console.log(`[Consult] Pre-consult saved for lead ${leadId}`);

  // 2+3. OneDrive: raw JSON archive + full-dossier PDF + board link (best-effort).
  try {
    const oneDrive = require('./oneDriveService');
    const put = (filename, buffer, mimeType) => oneDrive.uploadFile({
      clientName: lead?.fullName || 'Client', caseRef: `LEAD-${leadId}`, category: 'Intake', filename, buffer, mimeType,
    });
    await put('pre-consult-submission.json',
      Buffer.from(JSON.stringify({ submittedAt: new Date().toISOString(), leadId, answers: { ...formData } }, null, 2)),
      'application/json');

    const archive = await loadIntakeArchive({ ...lead, id: leadId }) || {};
    const sections = buildDossierSections(lead || { id: leadId }, archive, formData, fBlock);
    const pdf = await buildPreConsultPdf(lead || { id: leadId }, sections);
    const { url } = await oneDrive.uploadFileAndLink({
      clientName: lead?.fullName || 'Client', caseRef: `LEAD-${leadId}`, category: 'Intake',
      filename: 'pre-consultation-summary.pdf', buffer: pdf, mimeType: 'application/pdf',
    });
    await leadService.updateLead(leadId, { preConsultPdf: { url, text: 'Pre-Consult PDF' } });
    console.log(`[Consult] Pre-consult JSON + dossier PDF saved + linked for lead ${leadId}`);
  } catch (err) {
    console.warn(`[Consult] Pre-consult OneDrive save failed for ${leadId} (answers safe in Monday update): ${err.message}`);
  }
}

/** Ordered [question, answer] pairs of the PRE-CONSULT answers (Monday update). */
function buildPreConsultQA(lead, f, fBlock) {
  const qa = [];
  const add = (q, a) => { if (String(a || '').trim()) qa.push([q, String(a).trim()]); };
  add('Client', lead.fullName);
  add('Email', lead.email);
  add('Service', lead.serviceRequired || lead.caseTypeInterest);
  add('Consultation slot (Toronto)', lead.bookedSlot);
  add('Has anything changed since the intake form?', f.changes);
  add('Deadline or target date', f.deadline);
  for (const [name, label] of (PRECONSULT_FQ[fBlock] || [])) add(label, f[name]);
  add('Progress so far & documents in hand', f.progress);
  add('Top questions for the consultant', f.questions);
  return qa;
}

/**
 * The COMPLETE dossier: every intake answer (archive-first, lead columns as
 * fallback) + every pre-consult answer, grouped into titled sections.
 * @returns {Array<{ title: string, rows: Array<[string, string]> }>}
 */
function buildDossierSections(lead, a, f, fBlock) {
  const sections = [];
  const sec = (title) => { const s = { title, rows: [] }; sections.push(s); return (q, v) => { if (String(v || '').trim()) s.rows.push([q, String(v).trim()]); }; };
  const pick = (k) => a[k] || lead[k] || '';

  let add = sec('Client & Contact');
  add('Full legal name', pick('fullName') || lead.name);
  add('Email', pick('email'));
  add('Phone', pick('phone'));
  add('Residential address', pick('residentialAddress'));
  add('Inside Canada', pick('insideCanada'));
  add('Country', pick('insideCanada') === 'Yes' ? 'Canada' : (a.currentCountry || lead.country));

  add = sec('Inquiry (from intake form)');
  add('Relationship with TDOT', pick('relationshipWithTdot'));
  add('Existing file type', pick('existingFileType'));
  add('Service required', pick('serviceRequired') || lead.caseTypeInterest);
  add('Inquiry / goal', pick('situationDescription'));
  add('Wants to', pick('whatDoYouWant'));
  add('How they heard of TDOT', pick('howHeard'));
  add('Referred by', pick('referredBy'));

  add = sec('Immigration Status (from intake form)');
  add('Current status', pick('currentStatus'));
  add('Status expiry', pick('statusExpiry'));
  add('Maintained/implied status', pick('maintainedStatus'));
  add('Recent extension/status application', a.recentExtension);
  add('Extension details', a.recentExtensionDetails);

  add = sec('Urgency Screening (from intake form)');
  add('Urgent deadline', pick('urgentDeadline') === 'Yes' || lead.deadlineDate
    ? `${pick('deadlineDate')} (${pick('deadlineReason')})` : pick('urgentDeadline') || 'No');
  add('Removal/enforcement order', pick('removalOrder'));
  add('CBSA/IRCC letter', pick('enforcementLetter'));
  add('Enforcement details', a.enforcementDetails);
  add('Restoration period', pick('restorationPeriod'));
  add('Restoration deadline', pick('restorationDeadline'));
  add('Recent refusal', pick('recentRefusal') === 'Yes' ? `${pick('refusalType')} (${pick('refusalDate')})` : pick('recentRefusal'));

  if (fBlock) {
    add = sec(`Service-Specific Answers (intake, ${fBlock})`);
    for (const [key, val] of Object.entries(a)) {
      if (key.startsWith(fBlock.toLowerCase() + '_') && String(val || '').trim()) {
        add(key.replace(/^f\d+_/, ''), val);
      }
    }
  }

  add = sec('Pre-Consultation Answers');
  add('Has anything changed since the intake form?', f.changes);
  add('Deadline or target date', f.deadline);
  for (const [name, label] of (PRECONSULT_FQ[fBlock] || [])) add(label, f[name]);
  add('Progress so far & documents in hand', f.progress);
  add('Top questions for the consultant', f.questions);

  add = sec('Booking & Triage');
  add('Consultation slot (Toronto)', lead.bookedSlot);
  add('Priority (rules engine)', lead.priority);
  add('Priority reasons', lead.priorityReasons);
  add('Consents given at', pick('consentsAt') || (a.consents && a.consents.at));

  return sections.filter((s) => s.rows.length);
}

/** Branded full-dossier PDF: titled sections, Q&A rows, clean page breaks. */
function buildPreConsultPdf(lead, sections) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy = BRAND.darkPanel, red = BRAND.primary, muted = BRAND.mutedOnLight;
    doc.fillColor(red).fontSize(20).text('TDOT Immigration');
    doc.fillColor(navy).fontSize(14).text('Client Dossier — Intake & Pre-Consultation');
    doc.moveDown(0.4).fillColor(muted).fontSize(10)
       .text(`Lead ${lead.id || ''} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    doc.moveDown(0.8).strokeColor('#DDDDDD').moveTo(56, doc.y).lineTo(556, doc.y).stroke();

    for (const section of sections) {
      if (doc.y > 660) doc.addPage();
      doc.moveDown(1.1).fillColor(red).fontSize(13).text(section.title);
      doc.moveDown(0.1).strokeColor('#EEEEEE').moveTo(56, doc.y).lineTo(556, doc.y).stroke();
      for (const [q, a] of section.rows) {
        if (doc.y > 700) doc.addPage();
        doc.moveDown(0.55).fillColor(navy).fontSize(10.5).text(q);
        doc.moveDown(0.1).fillColor('#111111').fontSize(10).text(a, { align: 'left' });
      }
    }

    doc.moveDown(2).fontSize(8.5).fillColor(muted)
       .text('Prepared automatically from the client\'s intake and pre-consultation submissions.', { align: 'center' });
    doc.end();
  });
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
  // exported for tests
  buildPreConsultQA, buildPreConsultPdf, buildDossierSections,
};
