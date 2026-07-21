/**
 * Consultation Service (Phase 2 — WS4)
 *
 * After a booking is paid (bookingService.confirmSlot → onSlotConfirmed):
 *   - create a Zoom meeting
 *   - email the client the Zoom link + pre-consult form link
 * Plus the pre-consult form itself and reminder crons. Lead Board writes only.
 */

'use strict';

const leadService        = require('./leadService');
const microsoftMail      = require('./microsoftMailService');
const mondayApi          = require('./mondayApi');
const { leadBoardId }    = require('../../config/monday');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');
const { CURRENT_STATUS } = require('../../config/optionLists');

// ─── Pre-consultation form option lists (eligibility profile, per TDOT spec) ──
const PC_ENTRY_VISA   = ['Visitor visa', 'Study permit', 'Work permit', 'eTA', 'Other', 'Not applicable'];
const PC_MARITAL      = ['Single', 'Married', 'Common-law', 'Separated / Divorced'];
const PC_RELATIVE_REL = ['Parent', 'Sibling', 'Aunt / Uncle', 'Cousin', 'Child', 'Other'];
const PC_HIGHEST_EDU  = ['High school', 'Diploma / Certificate', "Bachelor's degree", 'Post-graduate diploma / certificate', "Master's degree", 'PhD', 'Trade certificate', 'Other'];
const PC_COMPLETED    = ['Yes', 'No, currently studying', 'No, not completed'];
const PC_FT_PT        = ['Full-time', 'Part-time'];
const PC_ENG_TEST     = ['IELTS General', 'CELPIP General', 'PTE Core', 'Other'];
const PC_TEST_RESULT  = ['Yes', 'No', 'Booked but not completed yet'];
const PC_YNNS         = ['Yes', 'No', 'Not sure'];
const PC_YNNA         = ['Yes', 'No', 'Not sure', 'Not applicable'];

const RENDER_URL      = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
const TZ              = 'America/Toronto';

// Meeting creation is provider-agnostic (Zoom today, Teams behind
// MEETING_PROVIDER=teams) — all platform specifics live in meetingService.
const meetingService = require('./meetingService');
const { getZoomAccessToken, createZoomMeeting } = meetingService; // re-exported for back-compat

const PROVIDER_LABEL = { zoom: 'Zoom', teams: 'Microsoft Teams' };
const OFFICE_ADDRESS = '20 De Boers Dr, Suite 321, North York, ON M3J 0H1';

// ─── Entry point: called by bookingService after payment ─────────────────────
async function onSlotConfirmed(leadId, meetingTypeOverride) {
  try {
    const lead = await leadService.getLead(leadId);
    if (!lead) return;
    // Idempotent: a virtual booking has a meeting id; either type has the
    // consultation date once processed. (confirmSlot also guards on Booked.)
    if (lead.zoomMeetingId || lead.consultationHeld) {
      console.log(`[Consult] Lead ${leadId} already processed — skipping`);
      return;
    }
    const slotStr = (lead.bookedSlot || '').trim();
    // Prefer the value threaded in from the POST (free path) so we don't depend
    // on the meetingType column having persisted; fall back to the stored value
    // (paid path, where the webhook fires later with no value in hand).
    const meetingType = (meetingTypeOverride === 'In-person' || meetingTypeOverride === 'Virtual')
      ? meetingTypeOverride
      : (lead.meetingType === 'In-person' ? 'In-person' : 'Virtual');

    let meeting = null;
    if (meetingType === 'Virtual') {
      meeting = await meetingService.createMeeting(lead, slotStr);
      await leadService.updateLead(leadId, {
        zoomMeetingId:   meeting.meetingId,                                   // column titled "Meeting Id" (provider-agnostic)
        meetingLink:     { url: meeting.joinUrl, text: `Join (${PROVIDER_LABEL[meeting.provider] || meeting.provider})` },
        consultationHeld: slotStr.split(' ')[0], // date of the consult
      });
    } else {
      // In-person: no video meeting — the confirmation carries the office address.
      await leadService.updateLead(leadId, { consultationHeld: slotStr.split(' ')[0] });
    }

    // Best-effort: write the paid appointment onto the Square calendar with the
    // client as the customer + an in-person/virtual seller note. Now that the
    // plan supports seller-level writes this genuinely fires, so a real failure
    // means the consultant won't see the appointment on their Square calendar —
    // surface it as an actionable staff note instead of only a server log. (The
    // benign "not configured"/"no phone" cases return without throwing, so this
    // catch only fires on a genuine API failure.)
    createSquareBooking(lead, slotStr, meetingType).catch(async (e) => {
      console.warn(`[Consult] Square booking write failed for lead ${leadId}: ${e.message}`);
      try {
        await mondayApi.query(
          `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
          { itemId: String(leadId), body: `⚠️ <b>Square appointment not added automatically</b> — please add this consultation to the Square calendar manually. <i>(${escapeHtml(e.message)})</i>` }
        );
      } catch (_) { /* the note is best-effort too — never disturb the booking flow */ }
    });

    // No auto client email here anymore. The client gets the Teams calendar invite
    // (virtual) + Square receipt at booking; the branded confirmation is now folded
    // into the ONE consolidated email the team sends with a click after reviewing the
    // consultation agreement (sendConsultationPackage). This keeps the client from
    // receiving several disjointed emails and adds the required completion disclaimer.
    console.log(`[Consult] ${meetingType} consultation confirmed for lead ${leadId}${meeting ? ` (${meeting.provider} ${meeting.meetingId})` : ''} — awaiting team "Review & send"`);
  } catch (err) {
    console.error(`[Consult] onSlotConfirmed failed for lead ${leadId}:`, err.message);
  }
}

/**
 * Best-effort: create the Square appointment for a paid consult — puts the client
 * on the seller's real calendar (customer = the client) with an in-person/virtual
 * seller note, and stamps our lead id onto the booking. Needs Square Appointments
 * seller-level writes (plan-gated), a configured service variation, and a valid
 * client phone; any gap just logs and returns without disturbing the booking flow.
 */
async function createSquareBooking(lead, slotStr, meetingType) {
  if (lead.squareBookingId) return;                                    // already written
  const serviceVariationId = process.env.SQUARE_CONSULT_SERVICE_VARIATION_ID;
  if (!serviceVariationId) return;                                     // Appointments not configured

  const sq = require('./squareBookingsService');
  const { torontoSlotToUTC } = require('./postConsultService');
  const { routeConsultant } = require('../../config/consultantRouting');

  const startMs = torontoSlotToUTC(slotStr);
  if (!Number.isFinite(startMs)) { console.warn(`[Consult] Square booking skipped for ${lead.id}: bad slot "${slotStr}"`); return; }
  const startAtIso = new Date(startMs).toISOString();

  const customerId = await sq.ensureCustomer({ email: lead.email, fullName: lead.fullName, phoneE164: sq.toE164(lead.phone) });
  if (!customerId) { console.warn(`[Consult] Square booking skipped for ${lead.id}: no customer`); return; }

  // CreateBooking needs the service variation VERSION — resolve it from the catalog.
  let version;
  try {
    const services = await sq.listAppointmentServices();
    const v = services.find((s) => s.variationId === serviceVariationId);
    version = v && v.variationVersion;
  } catch (e) { console.warn(`[Consult] Square service lookup failed for ${lead.id}: ${e.message}`); }
  if (!version) { console.warn(`[Consult] Square booking skipped for ${lead.id}: no service-variation version`); return; }

  const teamMemberId    = routeConsultant(lead).teamMemberId || process.env.SQUARE_CONSULT_TEAM_MEMBER_ID;
  const durationMinutes = parseInt(process.env.SQUARE_CONSULT_DURATION_MIN, 10) || 30;
  const caseNote = lead.confirmedCaseType || lead.caseTypeInterest;
  const sellerNote = `${meetingType} consultation — ${lead.fullName || 'Client'}${caseNote ? ` (${caseNote})` : ''}`;

  const { bookingId } = await sq.createBooking({
    customerId, serviceVariationId, serviceVariationVersion: version, teamMemberId,
    startAtIso, durationMinutes, sellerNote,
    idempotencyKey: `lead-${lead.id}-${slotStr}`.replace(/[^A-Za-z0-9_-]/g, ''),
  });
  if (!bookingId) { console.warn(`[Consult] Square createBooking returned no id for ${lead.id}`); return; }

  await leadService.updateLead(lead.id, { squareBookingId: bookingId });
  sq.upsertBookingCustomAttribute(bookingId, 'lead_id', String(lead.id)).catch(() => {});
  console.log(`[Consult] Square appointment created for lead ${lead.id}: ${bookingId} (${meetingType})`);
}

async function sendBookingConfirmation(lead, meeting, slotStr, meetingType) {
  if (!lead.email) return;
  const token  = lead.leadToken || '';
  const preUrl = `${RENDER_URL}/consult/${lead.id}?t=${encodeURIComponent(token)}`;
  const isInPerson = meetingType === 'In-person';
  const whereBlock = isInPerson
    ? `<p><b>Where:</b> In person at our office<br>${escapeHtml(OFFICE_ADDRESS)}</p>`
    : (meeting
        ? `<p><b>Join the ${PROVIDER_LABEL[meeting.provider] || 'video'} call:</b><br><a href="${meeting.joinUrl}" style="color:${BRAND.primary}">${meeting.joinUrl}</a></p>`
          + (meeting.provider === 'teams' ? `<p style="font-size:13px;color:${BRAND.mutedOnLight}">A calendar invite has also been sent to your email — accept it and the meeting appears in your calendar.</p>` : '')
        : '');
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your consultation is booked</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${escapeHtml((lead.fullName||'there').split(' ')[0])},</p>
      <p><b>When:</b> ${escapeHtml(slotStr)} (Toronto time)</p>
      ${lead.assignedConsultant ? `<p><b>With:</b> ${escapeHtml(lead.assignedConsultant)}, RCIC</p>` : ''}
      ${whereBlock}
      <p style="margin-top:24px">Please complete this short form before your call so we can make the most of your time:</p>
      <p><a href="${preUrl}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Complete pre-consultation form</a></p>
      <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">See you ${isInPerson ? 'soon' : 'on the call'}.</p>
    </div></div>`;
  await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration consultation is booked', html });
}

/**
 * Re-send the client their consultation links (meeting join URL + pre-consult
 * form) — used by the consultant portal when a client lost the original email.
 * Rebuilds from the lead's stored meetingLink; no new meeting is created.
 */
async function resendConsultationLinks(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) throw new Error('Lead not found.');
  if (!lead.email) throw new Error('No client email on file.');
  const token   = lead.leadToken || '';
  const preUrl  = `${RENDER_URL}/consult/${lead.id}?t=${encodeURIComponent(token)}`;
  const joinUrl = (lead.meetingLink || '').trim();
  const e = escapeHtml;
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your consultation details</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${e((lead.fullName || 'there').split(' ')[0])},</p>
      <p>Here are your consultation links again for easy reference:</p>
      ${lead.bookedSlot ? `<p><b>When:</b> ${e(lead.bookedSlot)} (Toronto time)</p>` : ''}
      ${lead.meetingType === 'In-person'
        ? `<p><b>Where:</b> In person at our office<br>${e(OFFICE_ADDRESS)}</p>`
        : (joinUrl ? `<p><b>Join the call:</b><br><a href="${e(joinUrl)}" style="color:${BRAND.primary}">${e(joinUrl)}</a></p>` : '')}
      <p style="margin-top:20px">Please complete this short form before your call so we can make the most of your time:</p>
      <p><a href="${e(preUrl)}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Complete pre-consultation form</a></p>
      <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">See you on the call.</p>
    </div></div>`;
  await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration consultation links', html });
  console.log(`[Consult] Re-sent consultation links to ${lead.email} for lead ${leadId}`);
}

/**
 * The consolidated "everything in one email" the team sends with ONE click after
 * reviewing the consultation agreement: booking details + meeting link/office +
 * the pre-consultation form + the consultation agreement (review-PDF link) + a
 * clear disclaimer that both must be completed ≥24h before or the consult may be
 * cancelled. Replaces the old separate booking-confirmation + agreement emails.
 * When Documenso e-sign is enabled, the agreement ALSO goes out as a real e-sign
 * envelope (the client gets Documenso's signature-request email alongside this
 * package; signing auto-captures + stamps Consult Agreement Signed) — the
 * package's agreement button then becomes a preview link. If e-sign is disabled
 * or the envelope send fails, the button stays the legacy review-PDF link.
 */
async function sendConsultationPackage(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) throw new Error('Lead not found.');
  if (!lead.email) throw new Error('No client email on file — cannot send the consultation package.');

  const token = lead.leadToken || '';
  const preUrl = `${RENDER_URL}/consult/${lead.id}?t=${encodeURIComponent(token)}`;
  // Generate + cache the agreement PDF so the client's link is instant (it doubles
  // as the preview link on the e-sign path and the fallback review link otherwise).
  const consultAgreementSvc = require('./consultAgreementService');
  const { url: agreementUrl } = await consultAgreementSvc.ensureConsultAgreementReady(leadId);
  // e-signature path (Documenso): issue the real signing envelope alongside the
  // package — the client signs in-browser and the webhook auto-stamps the signed
  // date. null = disabled / send failed → the package keeps the review-PDF link.
  const esign = await consultAgreementSvc.maybeSendConsultEsign(lead);
  const viaEsign = !!(esign && esign.envelopeId);
  const alreadySigned = !!(esign && esign.alreadySigned);

  const e = escapeHtml;
  const when = lead.bookedSlot || (lead.consultationHeld || '');
  const isInPerson = lead.meetingType === 'In-person';
  const joinUrl = (lead.meetingLink || '').trim();
  const whereBlock = isInPerson
    ? `<p style="margin:6px 0"><b>Where:</b> In person at our office<br>${e(OFFICE_ADDRESS)}</p>`
    : (joinUrl ? `<p style="margin:6px 0"><b>Join the video call:</b><br><a href="${e(joinUrl)}" style="color:${BRAND.primary}">${e(joinUrl)}</a></p>` : '');
  const btn = (href, label) => `<a href="${e(href)}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;margin:4px 0">${label}</a>`;

  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
    <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
      <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Your consultation is booked</h1></div>
    <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
      <p>Hi ${e((lead.fullName || 'there').split(' ')[0])},</p>
      <p>Your consultation with TDOT Immigration is confirmed. Here are the details and your next steps.</p>
      ${when ? `<p style="margin:6px 0"><b>When:</b> ${e(when)} (Toronto time)</p>` : ''}
      ${lead.assignedConsultant ? `<p style="margin:6px 0"><b>With:</b> ${e(lead.assignedConsultant)}, RCIC</p>` : ''}
      ${whereBlock}
      <div style="border-top:1px solid ${BRAND.border};margin:20px 0"></div>
      <p style="margin:0 0 4px"><b>${alreadySigned ? 'Before your consultation, please complete the step below:' : 'Before your consultation, please complete these two steps:'}</b></p>
      <p style="margin:14px 0 2px">1. Complete your pre-consultation form so we can prepare for your case:</p>
      <p style="margin:2px 0">${btn(preUrl, 'Complete pre-consultation form')}</p>
      ${alreadySigned
        ? `<p style="margin:16px 0 2px">2. Your initial consultation agreement is already signed — no further action needed. Your copy:</p>
      <p style="margin:2px 0">${btn(agreementUrl, 'View consultation agreement (PDF)')}</p>`
        : viaEsign
        ? `<p style="margin:16px 0 2px">2. Sign your initial consultation agreement — we've emailed it to you separately for e-signature (check your inbox for the signature request). You can preview it here:</p>
      <p style="margin:2px 0">${btn(agreementUrl, 'Preview consultation agreement (PDF)')}</p>`
        : `<p style="margin:16px 0 2px">2. Review and sign your initial consultation agreement:</p>
      <p style="margin:2px 0">${btn(agreementUrl, 'Review consultation agreement')}</p>`}
      <div style="background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:12px 14px;margin:22px 0 6px;font-size:13.5px;color:#7a4b00">
        ${alreadySigned
          ? `<b>Please complete the pre-consultation form at least 24 hours before your scheduled consultation.</b> If it is not completed in time, your consultation may be cancelled.`
          : `<b>Please complete both steps at least 24 hours before your scheduled consultation.</b> If they are not completed in time, your consultation may be cancelled.`}
      </div>
      <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:20px">Any questions? Just reply to this email.</p>
    </div></div>`;

  await microsoftMail.sendEmail({ to: lead.email, subject: 'Your TDOT Immigration consultation — details, form & agreement', html });
  // Sent-date stamping: the e-sign path stamps inside maybeSendConsultEsign (the
  // moment the envelope is out, so a package-email failure can't lose it), and an
  // already-signed re-send must NOT move Sent past Signed. Stamp only the
  // review-link fallback path here.
  if (!viaEsign && !alreadySigned) {
    await leadService.updateLead(leadId, { consultAgreementSent: new Date().toISOString().split('T')[0] });
  }
  console.log(`[Consult] Consultation package sent to ${lead.email} for lead ${leadId} (agreement via ${viaEsign ? 'documenso e-sign' : alreadySigned ? 'already-signed copy' : 'review link'})`);
  return { ok: true, url: agreementUrl, via: viaEsign ? 'documenso' : 'review-link', alreadySigned };
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
  const archive = await loadIntakeArchive(lead) || {};
  const tok = encodeURIComponent(lead.leadToken || '');
  const e = escapeHtml;

  // Prefill: intake archive first (full submission), then the lead columns.
  const A = (k, leadKey) => {
    const v = archive[k];
    if (v != null && String(v).trim()) return String(v);
    const lv = leadKey ? lead[leadKey] : lead[k];
    return lv != null ? String(lv) : '';
  };
  const childCount = A('childrenCount');
  const hasChildrenDefault = Number(childCount) > 0 ? 'Yes' : '';

  // ── field builders ──────────────────────────────────────────────────────────
  const sel = (name, opts, cur, attrs = '') => {
    const o = opts.map((v) => `<option${cur === v ? ' selected' : ''}>${e(v)}</option>`).join('');
    return `<select name="${name}" ${attrs}><option value="">Choose…</option>${o}</select>`;
  };
  const radio = (name, cur, opts = ['Yes', 'No'], attrs = '') =>
    `<div class="radios" ${attrs}>` + opts.map((v) =>
      `<label class="radio"><input type="radio" name="${name}" value="${e(v)}"${cur === v ? ' checked' : ''}> ${e(v)}</label>`).join('') + `</div>`;
  const txt = (name, cur = '', type = 'text', ph = '') =>
    `<input type="${type}" name="${name}" value="${e(cur)}" placeholder="${e(ph)}">`;

  // ── repeatable rows (rendered as index 0; JS clones for more) ────────────────
  const eduRow = `<div class="rrow">
      <label>School / college / university name</label>${txt('education[0][school]')}
      <label>Program / field name</label>${txt('education[0][program]')}
      <label>City and country of study</label>${txt('education[0][location]')}
      <div class="two"><div><label>Start (MM/YYYY)</label>${txt('education[0][start]', '', 'text', 'MM/YYYY')}</div>
        <div><label>End (MM/YYYY)</label>${txt('education[0][end]', '', 'text', 'MM/YYYY')}</div></div>
      <label>Completed?</label>${sel('education[0][completed]', PC_COMPLETED, '')}
    </div>`;
  const jobRow = `<div class="rrow">
      <label>Job title</label>${txt('employment[0][title]')}
      <label>Company name</label>${txt('employment[0][company]')}
      <label>Country of employment</label>${txt('employment[0][country]')}
      <div class="two"><div><label>Start (MM/YYYY)</label>${txt('employment[0][start]', '', 'text', 'MM/YYYY')}</div>
        <div><label>End (MM/YYYY)</label>${txt('employment[0][end]', '', 'text', 'MM/YYYY')}</div></div>
      <div class="two"><div><label>Full-time / part-time</label>${sel('employment[0][type]', PC_FT_PT, '')}</div>
        <div><label>Approx. hours / week</label>${txt('employment[0][hours]', '', 'number')}</div></div>
      <label>Briefly describe your main duties <span class="opt">(plain words — helps us find your NOC code)</span></label>
      <textarea name="employment[0][duties]" rows="2"></textarea>
    </div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pre-Consultation — TDOT Immigration</title><style>
    body{background:${BRAND.lightBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;color:${BRAND.textOnLight}}
    .container{max-width:680px;margin:0 auto;padding:32px 20px}
    .header{background:${BRAND.darkPanel};color:${BRAND.textOnDark};padding:26px;border-radius:12px 12px 0 0;text-align:center}
    .intro{background:${BRAND.lightCard};padding:18px 28px;border-bottom:1px solid ${BRAND.border};font-size:13.5px;color:${BRAND.mutedOnLight}}
    .card{background:${BRAND.lightCard};padding:24px 28px;border-radius:0 0 12px 12px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}
    .section{border:1px solid ${BRAND.border};border-radius:10px;padding:18px 20px;margin-top:18px}
    .section h2{margin:0 0 4px;font-size:16px;color:${BRAND.darkPanel}}
    .section .hint{margin:0 0 6px;font-size:13px;color:${BRAND.mutedOnLight}}
    label{display:block;font-weight:600;margin:14px 0 6px;font-size:14px}
    label .opt{font-weight:400;color:${BRAND.mutedOnLight}}
    input,select,textarea{width:100%;padding:11px;border:1px solid ${BRAND.border};border-radius:8px;font-size:15px;box-sizing:border-box;background:#fff}
    .radios{display:flex;gap:18px;flex-wrap:wrap}
    .radio{display:inline-flex;align-items:center;font-weight:400;margin:4px 0}
    .radio input{width:auto;margin-right:7px}
    .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .cond{display:none;margin-top:4px;padding-left:14px;border-left:3px solid ${BRAND.border}}
    .cond.show{display:block}
    .rrow{border:1px dashed ${BRAND.border};border-radius:8px;padding:12px 14px;margin-top:12px;position:relative}
    .rrow .rm{position:absolute;top:8px;right:10px;width:auto;background:none;border:none;color:${BRAND.mutedOnLight};font-size:18px;cursor:pointer;padding:0;margin:0}
    .addbtn{background:none;color:${BRAND.primary};border:1px dashed ${BRAND.primary};padding:9px;margin-top:12px;font-size:14px;font-weight:600}
    .prefill{font-size:11.5px;color:${BRAND.mutedOnLight};font-weight:400;margin-left:6px}
    button[type=submit]{background:${BRAND.primary};color:#fff;padding:15px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;margin-top:24px;width:100%}
    button:disabled{opacity:.75;cursor:not-allowed}
    .spin{display:inline-block;width:15px;height:15px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;vertical-align:-2px;margin-right:8px;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .disc{font-size:12px;color:${BRAND.mutedOnLight};margin-top:18px;line-height:1.6}
  </style></head><body><div class="container">
    <div class="header">${TDOT_LOGO_LIGHT_HTML}<h1 style="margin:12px 0 4px;font-size:21px">Pre-Consultation Form</h1>
    <p style="margin:0;opacity:.85;font-size:14px">A few details so we can make the most of your consultation.</p></div>
    <div class="intro">Please complete this short form before your consultation so we can understand your situation in advance. Answer only what applies to you. Some answers are pre-filled from your intake — please review and correct anything that has changed.</div>
    <form class="card" method="POST" action="/consult/${lead.id}?t=${tok}">

      <div class="section"><h2>1 · Personal Information</h2>
        <label>Full name</label>${txt('pc_fullName', A('fullName', 'fullName'))}
        <label>Age</label>${txt('pc_age', '', 'number')}
        <label>Complete address</label><textarea name="pc_address" rows="2">${e(A('residentialAddress'))}</textarea>
        <label>Are you currently in Canada?</label>${radio('pc_inCanada', A('insideCanada', 'insideCanada'))}
        <div class="cond" id="c-incanada">
          <label>When did you enter Canada?</label>${txt('pc_entryDate', '', 'date')}
          <label>What type of visa / permit did you use to enter Canada?</label>${sel('pc_entryVisa', PC_ENTRY_VISA, '')}
        </div>
        <label>What is your current status in Canada?</label>${sel('pc_currentStatus', CURRENT_STATUS, A('currentStatus', 'currentStatus'))}
        <label>If you have a current permit / visa, when does it expire?</label>${txt('pc_permitExpiry', A('statusExpiry', 'statusExpiry'), 'date')}
        <label>Marital status</label>${sel('pc_marital', PC_MARITAL, '')}
        <label>Do you have children?</label>${radio('pc_hasChildren', hasChildrenDefault)}
        <div class="cond" id="c-children"><label>If yes, how many?</label>${txt('pc_childrenCount', childCount, 'number')}</div>
        <label>Do you have any relatives in Canada who are PR or Canadian citizens?</label>${radio('pc_relatives', '')}
        <div class="cond" id="c-relatives"><label>If yes, please mention your relationship</label>${sel('pc_relativeRel', PC_RELATIVE_REL, '')}</div>
      </div>

      <div class="section"><h2>2 · Education Information</h2>
        <label>What is your highest completed education after Grade 10?</label>${sel('pc_highestEducation', PC_HIGHEST_EDU, '')}
        <p class="hint" style="margin-top:14px">Please provide details of your education after Grade 10 and onwards:</p>
        <div id="edu-list">${eduRow}</div>
        <button type="button" class="addbtn" data-add="edu-list">+ Add another education</button>
      </div>

      <div class="section"><h2>3 · Employment Information</h2>
        <label>Do you have paid work experience in TEER 0, 1, 2, or 3 in the last 5 years?</label>${radio('pc_teer', '', PC_YNNS)}
        <div class="cond" id="c-teer">
          <p class="hint" style="margin-top:8px">Please provide details of your TEER 0–3 jobs in the last 5 years:</p>
          <div id="job-list">${jobRow}</div>
          <button type="button" class="addbtn" data-add="job-list">+ Add another job</button>
        </div>
        <label>If you are looking for PNP options — did your employer earn more than $1 million in the past year?</label>${sel('pc_employerRevenue', PC_YNNA, '')}
      </div>

      <div class="section"><h2>4 · Language Proficiency</h2>
        <label>Do you have an English language test result?</label>${sel('pc_englishTest', PC_TEST_RESULT, '', 'id="pc_englishTest"')}
        <div class="cond" id="c-english">
          <label>Which test?</label>${sel('pc_englishTestType', PC_ENG_TEST, '')}
          <label>Your English scores, if available</label>
          <div class="two"><div>${txt('pc_engListening', '', 'text', 'Listening')}</div><div>${txt('pc_engReading', '', 'text', 'Reading')}</div></div>
          <div class="two" style="margin-top:10px"><div>${txt('pc_engWriting', '', 'text', 'Writing')}</div><div>${txt('pc_engSpeaking', '', 'text', 'Speaking')}</div></div>
        </div>
        <label>Do you have a French language test result?</label>${sel('pc_frenchTest', PC_TEST_RESULT, '', 'id="pc_frenchTest"')}
        <div class="cond" id="c-french">
          <label>Your French scores, if available</label>
          <div class="two"><div>${txt('pc_frListening', '', 'text', 'Listening')}</div><div>${txt('pc_frReading', '', 'text', 'Reading')}</div></div>
          <div class="two" style="margin-top:10px"><div>${txt('pc_frWriting', '', 'text', 'Writing')}</div><div>${txt('pc_frSpeaking', '', 'text', 'Speaking')}</div></div>
        </div>
      </div>

      <div class="section"><h2>5 · Spouse / Common-law Partner / Adult Child</h2>
        <label>Do you have a spouse or common-law partner?</label>${radio('pc_hasSpouse', A('hasSpouse', 'hasSpouse'))}
        <div class="cond" id="c-spouse"><label>Should their profile also be considered during the consultation?</label>${radio('pc_spouseConsider', '', PC_YNNS)}</div>
        <label>Do you have any child over 18 years of age who should be considered?</label>${radio('pc_adultChild', '')}
        <p class="hint" style="margin-top:14px">Note: if your spouse/partner or a child over 18 needs to be assessed, they may also be asked to complete this form.</p>
      </div>

      <div class="section"><h2>6 · Final Question</h2>
        <label>Is there anything important you want the consultant to know before the consultation? <span class="opt">(optional)</span></label>
        <textarea name="pc_finalNote" rows="3"></textarea>
      </div>

      <p class="disc">This form is only for consultation preparation. Final eligibility and legal advice can only be provided after reviewing complete information and documents.</p>
      <button type="submit" id="pcBtn">Submit</button>
    </form></div>
  <script>
    (function(){
      function radioVal(name){ var r=document.querySelector('input[name="'+name+'"]:checked'); return r?r.value:''; }
      function show(id,on){ var el=document.getElementById(id); if(el) el.classList[on?'add':'remove']('show'); }
      function onChange(name,fn){ Array.prototype.forEach.call(document.querySelectorAll('[name="'+name+'"]'),function(el){ el.addEventListener('change',fn); }); fn(); }

      onChange('pc_inCanada', function(){ show('c-incanada', radioVal('pc_inCanada')==='Yes'); });
      onChange('pc_hasChildren', function(){ show('c-children', radioVal('pc_hasChildren')==='Yes'); });
      onChange('pc_relatives', function(){ show('c-relatives', radioVal('pc_relatives')==='Yes'); });
      onChange('pc_teer', function(){ show('c-teer', radioVal('pc_teer')==='Yes'); });
      onChange('pc_hasSpouse', function(){ show('c-spouse', radioVal('pc_hasSpouse')==='Yes'); });
      var et=document.getElementById('pc_englishTest'); et.addEventListener('change',function(){ show('c-english', et.value==='Yes'); }); show('c-english', et.value==='Yes');
      var ft=document.getElementById('pc_frenchTest'); ft.addEventListener('change',function(){ show('c-french', ft.value==='Yes'); }); show('c-french', ft.value==='Yes');

      // Repeatable rows: clone the first .rrow, bump the [index], clear values.
      Array.prototype.forEach.call(document.querySelectorAll('.addbtn'), function(btn){
        btn.addEventListener('click', function(){
          var list=document.getElementById(btn.getAttribute('data-add'));
          var rows=list.querySelectorAll('.rrow');
          var idx=rows.length;
          var clone=rows[0].cloneNode(true);
          Array.prototype.forEach.call(clone.querySelectorAll('input,select,textarea'), function(f){
            if(f.name) f.name=f.name.replace(/\\[\\d+\\]/, '['+idx+']');
            if(f.tagName==='SELECT') f.selectedIndex=0; else f.value='';
          });
          if(!clone.querySelector('.rm')){
            var x=document.createElement('button'); x.type='button'; x.className='rm'; x.innerHTML='&times;';
            x.onclick=function(){ clone.remove(); }; clone.appendChild(x);
          }
          list.appendChild(clone);
        });
      });

      var form=document.querySelector('form'), btn=document.getElementById('pcBtn');
      form.addEventListener('submit', function(){ btn.disabled=true; btn.innerHTML='<span class="spin"></span>Saving your answers…'; });
      window.addEventListener('pageshow', function(){ if(btn.disabled){ btn.disabled=false; btn.innerHTML='Submit'; } });
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

// ── Helpers for the new eligibility fields (repeatable rows + language) ───────
/** Normalise a repeatable field (qs gives an array or an index-keyed object) to non-empty rows. */
function pcRows(x) {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : Object.values(x);
  return arr.filter((r) => r && typeof r === 'object' && Object.values(r).some((v) => String(v || '').trim()));
}
function pcEduLine(r) {
  const span = (r.start || r.end) ? `${r.start || '?'}–${r.end || '?'}` : '';
  return [r.program, r.school, r.location, span, r.completed].map((v) => String(v || '').trim()).filter(Boolean).join(' · ');
}
function pcJobLine(r) {
  const span = (r.start || r.end) ? `${r.start || '?'}–${r.end || '?'}` : '';
  const hrs = String(r.hours || '').trim() ? `${r.hours}h/wk` : '';
  return [r.title, r.company, r.country, span, r.type, hrs, r.duties].map((v) => String(v || '').trim()).filter(Boolean).join(' · ');
}
function pcLangLine(l, rd, w, s) {
  const parts = [l, rd, w, s].map((v) => String(v || '').trim());
  return parts.some(Boolean) ? parts.map((v) => v || '—').join(' / ') : '';
}

/** Ordered [question, answer] pairs of the PRE-CONSULT answers (Monday update). */
function buildPreConsultQA(lead, f) {
  const qa = [];
  const add = (q, a) => { if (String(a || '').trim()) qa.push([q, String(a).trim()]); };
  add('Client', lead.fullName);
  add('Email', lead.email);
  add('Consultation slot (Toronto)', lead.bookedSlot);

  add('Age', f.pc_age);
  add('Currently in Canada', f.pc_inCanada);
  add('Entered Canada on', f.pc_entryDate);
  add('Entry visa / permit', f.pc_entryVisa);
  add('Current status', f.pc_currentStatus);
  add('Permit / visa expiry', f.pc_permitExpiry);
  add('Marital status', f.pc_marital);
  add('Children', f.pc_hasChildren === 'Yes' ? (f.pc_childrenCount || 'Yes') : f.pc_hasChildren);
  add('Relatives in Canada (PR/citizen)', f.pc_relatives === 'Yes' ? (f.pc_relativeRel || 'Yes') : f.pc_relatives);

  add('Highest education', f.pc_highestEducation);
  pcRows(f.education).forEach((r, i) => add(`Education ${i + 1}`, pcEduLine(r)));

  add('Paid TEER 0–3 work (last 5y)', f.pc_teer);
  pcRows(f.employment).forEach((r, i) => add(`Job ${i + 1}`, pcJobLine(r)));
  add('Employer earned > $1M (PNP)', f.pc_employerRevenue);

  add('English test', f.pc_englishTest);
  add('English test type', f.pc_englishTestType);
  add('English scores (L/R/W/S)', pcLangLine(f.pc_engListening, f.pc_engReading, f.pc_engWriting, f.pc_engSpeaking));
  add('French test', f.pc_frenchTest);
  add('French scores (L/R/W/S)', pcLangLine(f.pc_frListening, f.pc_frReading, f.pc_frWriting, f.pc_frSpeaking));

  add('Spouse / common-law partner', f.pc_hasSpouse);
  add('Consider spouse profile', f.pc_spouseConsider);
  add('Adult child (18+) to consider', f.pc_adultChild);

  add('Anything else for the consultant', f.pc_finalNote);
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

  add = sec('Family Members (from intake form)');
  add('Spouse/common-law partner', pick('hasSpouse'));
  add('Spouse accompanying', pick('spouseAccompanying'));
  add('Dependent children', pick('childrenCount'));
  add('Children accompanying', pick('childrenAccompanying'));

  add = sec('Immigration Status (from intake form)');
  add('Current status', pick('currentStatus'));
  add('Status expiry', pick('statusExpiry'));
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
    const F_LABELS = {
      hasProfile: 'Has a valid Express Entry profile', crsScore: 'CRS score', hasIta: 'Has received an ITA',
      itaDeadline: 'ITA deadline', program: 'Program or draw', hasNomination: 'Has NOI/nomination',
      province: 'Province', employerSupport: 'Applying with employer support', permitType: 'Work permit held',
      prSubmitted: 'PR submitted / AOR received', employerDocs: 'Has employer documents', intake: 'Target intake',
      admission: 'Admission received', need: 'What they need', deadline: 'Deadline', purpose: 'Purpose',
      priorRefusal: 'Had a refusal before', whoSponsors: 'Who is sponsoring whom', sponsorStatus: 'Sponsor status',
      applicantLocation: 'Applicant location', concerns: 'Refusal/marriage-history concerns',
      prDate: 'Became PR on', role: 'Employer or employee', jobTitle: 'Job title',
      refusalType: 'What was refused', refusalDate: 'Refusal date',
    };
    const pretty = (k) => F_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase());
    for (const [key, val] of Object.entries(a)) {
      if (key.startsWith(fBlock.toLowerCase() + '_') && String(val || '').trim()) {
        add(pretty(key.replace(/^f\d+_/, '')), val);
      }
    }
  }

  add = sec('Pre-Consultation — Personal');
  add('Age', f.pc_age);
  add('Currently in Canada', f.pc_inCanada);
  add('Entered Canada on', f.pc_entryDate);
  add('Entry visa / permit', f.pc_entryVisa);
  add('Current status (confirmed)', f.pc_currentStatus);
  add('Permit / visa expiry', f.pc_permitExpiry);
  add('Marital status', f.pc_marital);
  add('Children', f.pc_hasChildren === 'Yes' ? (f.pc_childrenCount || 'Yes') : f.pc_hasChildren);
  add('Relatives in Canada (PR/citizen)', f.pc_relatives === 'Yes' ? (f.pc_relativeRel || 'Yes') : f.pc_relatives);

  add = sec('Pre-Consultation — Education');
  add('Highest education', f.pc_highestEducation);
  pcRows(f.education).forEach((r, i) => add(`Education ${i + 1}`, pcEduLine(r)));

  add = sec('Pre-Consultation — Employment');
  add('Paid TEER 0–3 work (last 5y)', f.pc_teer);
  pcRows(f.employment).forEach((r, i) => add(`Job ${i + 1}`, pcJobLine(r)));
  add('Employer earned > $1M (PNP)', f.pc_employerRevenue);

  add = sec('Pre-Consultation — Language');
  add('English test', f.pc_englishTest);
  add('English test type', f.pc_englishTestType);
  add('English scores (L/R/W/S)', pcLangLine(f.pc_engListening, f.pc_engReading, f.pc_engWriting, f.pc_engSpeaking));
  add('French test', f.pc_frenchTest);
  add('French scores (L/R/W/S)', pcLangLine(f.pc_frListening, f.pc_frReading, f.pc_frWriting, f.pc_frSpeaking));

  add = sec('Pre-Consultation — Family for assessment');
  add('Spouse / common-law partner', f.pc_hasSpouse);
  add('Consider spouse profile', f.pc_spouseConsider);
  add('Adult child (18+) to consider', f.pc_adultChild);

  add = sec('Pre-Consultation — Notes');
  add('Anything else for the consultant', f.pc_finalNote);

  add = sec('Booking & Triage');
  add('Consultation slot (Toronto)', lead.bookedSlot);
  add('Priority (rules engine)', lead.priority);
  add('Priority reasons', lead.priorityReasons);
  add('Consents given at', pick('consentsAt') || (a.consents && a.consents.at));

  return sections.filter((s) => s.rows.length);
}

/**
 * Branded full-dossier PDF styled like the FORM itself: section header bars,
 * each question as a label with the answer rendered inside a bordered field
 * box (like a filled-in input) — easy to scan, clean page breaks.
 */
function buildPreConsultPdf(lead, sections) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy = BRAND.darkPanel, red = BRAND.primary, muted = BRAND.mutedOnLight;
    const X = 50, W = 512;          // content box
    const PAD = 8;                  // field box padding
    const BOTTOM = 742;             // page break threshold

    const ensureRoom = (needed) => { if (doc.y + needed > BOTTOM) doc.addPage(); };

    // Document header (mirrors the form's dark header card)
    doc.roundedRect(X, 50, W, 64, 8).fill(navy);
    doc.fillColor('#FFFFFF').fontSize(17).text('TDOT Immigration', X + 18, 62);
    doc.fillColor('#E8E2D8').fontSize(11).text('Client Dossier — Intake & Pre-Consultation Form', X + 18, 84);
    doc.fillColor(muted).fontSize(8.5)
       .text(`Lead ${lead.id || ''} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, X, 122, { width: W, align: 'right' });
    doc.y = 138;

    let sectionNo = 0;
    for (const section of sections) {
      sectionNo++;
      ensureRoom(70); // section bar + at least one field

      // Section header bar (like the form's numbered section titles)
      doc.moveDown(0.6);
      const barY = doc.y;
      doc.roundedRect(X, barY, W, 24, 5).fill('#EFEAE2');
      doc.fillColor(red).fontSize(11.5).text(`${sectionNo} · ${section.title}`, X + 12, barY + 6, { width: W - 24 });
      doc.y = barY + 32;

      // Compact layout: short answers pack 2-3 per row; long text gets full width.
      const cls = ([q, a]) => {
        if (String(a).length <= 18 && String(q).length <= 30) return 3;  // third-width ok
        if (String(a).length <= 42 && String(q).length <= 46) return 2;  // half-width ok
        return 1;                                                        // full width
      };
      const rows = section.rows.slice();
      let i = 0;
      while (i < rows.length) {
        let group;
        if (cls(rows[i]) === 3 && i + 2 < rows.length && cls(rows[i + 1]) === 3 && cls(rows[i + 2]) === 3) {
          group = rows.slice(i, i + 3);
        } else if (cls(rows[i]) >= 2 && i + 1 < rows.length && cls(rows[i + 1]) >= 2) {
          group = rows.slice(i, i + 2);
        } else {
          group = [rows[i]];
        }
        i += group.length;

        const n = group.length, GAP = 10;
        const colW = (W - GAP * (n - 1)) / n;
        // Uniform heights across the row: tallest label + tallest answer win.
        doc.fontSize(9.5);
        const labelH = Math.max(...group.map(([q]) => doc.heightOfString(q, { width: colW })));
        doc.fontSize(10);
        const textH = Math.max(...group.map(([, a]) => doc.heightOfString(String(a), { width: colW - 2 * PAD })));
        const boxH = textH + 2 * PAD;
        ensureRoom(labelH + boxH + 13);

        const rowY = doc.y;
        group.forEach(([q, a], idx) => {
          const cx = X + idx * (colW + GAP);
          doc.fillColor(navy).fontSize(9.5).text(q, cx, rowY, { width: colW });
          const boxY = rowY + labelH + 3;
          doc.roundedRect(cx, boxY, colW, boxH, 5).fillAndStroke('#FFFFFF', '#D9D2C7');
          doc.fillColor('#1A1A1A').fontSize(10).text(String(a), cx + PAD, boxY + PAD, { width: colW - 2 * PAD });
        });
        doc.y = rowY + labelH + 3 + boxH + 10;
      }
      doc.y += 2;
    }

    doc.moveDown(1);
    ensureRoom(20);
    doc.fontSize(8.5).fillColor(muted)
       .text('Prepared automatically from the client\'s intake and pre-consultation submissions.', X, doc.y, { width: W, align: 'center' });
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
        // In-person → the office address; virtual → the join URL (Zoom/Teams).
        // Older virtual bookings without a stored meetingLink just omit the line.
        const whereLine = lead.meetingType === 'In-person'
          ? `<p><b>Where:</b> In person at our office<br>${escapeHtml(OFFICE_ADDRESS)}</p>`
          : (lead.meetingLink ? `<p><b>Join link:</b> <a href="${escapeHtml(lead.meetingLink)}">${escapeHtml(lead.meetingLink)}</a></p>` : '');
        await microsoftMail.sendEmail({
          to: lead.email,
          subject: `Reminder: your TDOT consultation (${L.bookedSlot} Toronto)`,
          html: `<p>Hi ${escapeHtml((lead.name || 'there').split(' ')[0])}, this is a reminder of your consultation on <b>${escapeHtml(L.bookedSlot)}</b> (Toronto time).</p>${whereLine}`,
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
  buildPreConsultFormHtml, savePreConsultData, resendConsultationLinks, sendConsultationPackage,
  send24hReminders, send1hReminders, sendPreConsultReminders,
  // exported for tests
  buildPreConsultQA, buildPreConsultPdf, buildDossierSections,
};
