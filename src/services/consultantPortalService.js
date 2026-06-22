/**
 * consultantPortalService — read aggregator for the consultant portal.
 *
 * The consultant works the consultation (lead) stage and should never open
 * Monday's frontend. This service gathers everything for that workflow from
 * Monday (New Leads board) + OneDrive (the pre-consult eligibility profile and
 * intake archive) into two reads:
 *
 *   getConsultationQueue()        → the consultant's list of booked consultations
 *   getConsultationDetail(leadId) → one consultation, fully assembled
 *
 * Pure read/glue — writes live in the route layer (Phase B) and go through
 * leadService.updateLead so Monday's existing webhook automations fire exactly
 * as they would for a manual board edit. Each OneDrive read degrades to null on
 * failure rather than breaking the page.
 */

'use strict';

const mondayApi   = require('./mondayApi');
const leadService = require('./leadService');
const oneDrive    = require('./oneDriveService');
const { leadBoardId } = require('../../config/monday');

const C = require('../data/newLeadsBoard.json').columns;

/**
 * List booked consultations for the queue, soonest first.
 * @returns {Promise<Array<{ id, name, bookedSlot, tier, service, preConsultSubmitted, outcome, hasMeeting }>>}
 */
async function getConsultationQueue() {
  const ids = [C.bookedSlot, C.tier, C.serviceRequired, C.confirmedCaseType, C.preConsultSubmitted, C.outcome, C.meetingLink]
    .map((c) => `"${c}"`).join(', ');
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         items { id name column_values(ids: [${ids}]) { id text } }
       }
     }`,
    { boardId: String(leadBoardId), colId: C.bookingStatus, val: 'Booked' }
  );
  const items = (data?.items_page_by_column_values?.items || []).map((it) => {
    const cv = {}; it.column_values.forEach((c) => { cv[c.id] = (c.text || '').trim(); });
    return {
      id:                 it.id,
      name:               it.name,
      bookedSlot:         cv[C.bookedSlot] || '',
      tier:               cv[C.tier] || '',
      service:            cv[C.confirmedCaseType] || cv[C.serviceRequired] || '',
      preConsultSubmitted: (cv[C.preConsultSubmitted] || '') === 'Yes',
      outcome:            cv[C.outcome] || '',
      hasMeeting:         Boolean((cv[C.meetingLink] || '').trim()),
    };
  });
  // Soonest slot first; blanks last.
  items.sort((a, b) => (a.bookedSlot || '9999').localeCompare(b.bookedSlot || '9999'));
  return items;
}

/** Best-effort read of a OneDrive JSON in the lead's Intake folder. */
async function readLeadJson(clientName, leadId, filename) {
  try {
    const buf = await oneDrive.readFile({
      clientName, caseRef: `LEAD-${leadId}`, subfolder: 'Intake', filename,
    });
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  } catch (err) {
    console.warn(`[Consultant] ${filename} unavailable for lead ${leadId}: ${err.message}`);
    return null;
  }
}

/**
 * Assemble one consultation: lead columns + the pre-consult eligibility profile
 * + the intake archive.
 * @param {string} leadId
 * @returns {Promise<object>} throws only if the lead itself is not found
 */
async function getConsultationDetail(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }

  const [preConsult, intake] = await Promise.all([
    readLeadJson(lead.fullName, leadId, 'pre-consult-submission.json'),
    readLeadJson(lead.fullName, leadId, 'intake-submission.json'),
  ]);

  const answers = (preConsult && preConsult.answers) || {};
  const eligibility = (preConsult && preConsult.answers) ? {
    submitted:  true,
    submittedAt: preConsult.submittedAt || '',
    personal: {
      age:           answers.pc_age || '',
      inCanada:      answers.pc_inCanada || '',
      entryDate:     answers.pc_entryDate || '',
      entryVisa:     answers.pc_entryVisa || '',
      currentStatus: answers.pc_currentStatus || '',
      permitExpiry:  answers.pc_permitExpiry || '',
      marital:       answers.pc_marital || '',
      children:      answers.pc_hasChildren === 'Yes' ? (answers.pc_childrenCount || 'Yes') : (answers.pc_hasChildren || ''),
      relatives:     answers.pc_relatives === 'Yes' ? (answers.pc_relativeRel || 'Yes') : (answers.pc_relatives || ''),
    },
    highestEducation: answers.pc_highestEducation || '',
    education:  normaliseRows(answers.education),
    teer:       answers.pc_teer || '',
    employment: normaliseRows(answers.employment),
    employerRevenue: answers.pc_employerRevenue || '',
    language: {
      englishTest:  answers.pc_englishTest || '',
      englishType:  answers.pc_englishTestType || '',
      english:      [answers.pc_engListening, answers.pc_engReading, answers.pc_engWriting, answers.pc_engSpeaking],
      frenchTest:   answers.pc_frenchTest || '',
      french:       [answers.pc_frListening, answers.pc_frReading, answers.pc_frWriting, answers.pc_frSpeaking],
    },
    family: {
      hasSpouse:      answers.pc_hasSpouse || '',
      spouseConsider: answers.pc_spouseConsider || '',
      adultChild:     answers.pc_adultChild || '',
    },
    finalNote: answers.pc_finalNote || '',
  } : { submitted: false };

  const intakeFields = (intake && intake.fields) || {};

  return {
    leadId:    lead.id,
    name:      lead.fullName || lead.name,
    email:     lead.email || '',
    phone:     lead.phone || '',
    country:   lead.country || '',
    tier:      lead.tier || '',
    priority:  lead.priority || '',
    priorityReasons: lead.priorityReasons || '',
    aiTalkingPoints:  lead.aiTalkingPoints || '',
    aiComplianceFlags: lead.aiComplianceFlags || '',

    // Booking / consultation state
    bookingStatus:   lead.bookingStatus || '',
    bookedSlot:      lead.bookedSlot || '',
    consultationHeld: lead.consultationHeld || '',
    preConsultSubmitted: (lead.preConsultSubmitted || '') === 'Yes',
    meetingLink:     lead.meetingLink || '',
    recordingLink:   lead.recordingLink || '',
    preConsultPdf:   lead.preConsultPdf || '',
    leadToken:       lead.leadToken || '',

    // Intake context
    serviceRequired:  lead.confirmedCaseType || lead.serviceRequired || '',
    situationDescription: lead.situationDescription || intakeFields.situationDescription || '',
    insideCanada:     lead.insideCanada || '',
    currentStatus:    lead.currentStatus || '',
    hasSpouse:        lead.hasSpouse || '',
    childrenCount:    lead.childrenCount || '',

    // Outcome / retainer state (what the consultant acts on)
    outcome:        lead.outcome || '',
    retainerFee:    lead.retainerFee || '',
    retainerSent:   lead.retainerSent || '',
    retainerSigned: lead.retainerSigned || '',
    retainerPaid:   lead.retainerPaid || '',
    clientMasterItemId: lead.clientMasterItemId || '',

    eligibility,
  };
}

/** A repeatable field from the pre-consult JSON may be an array or index-keyed object. */
function normaliseRows(x) {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : Object.values(x);
  return arr.filter((r) => r && typeof r === 'object' && Object.values(r).some((v) => String(v || '').trim()));
}

// ─── Phase B: consultant write actions ───────────────────────────────────────
//
// The portal mirrors a manual Monday edit: it writes a lead column via
// leadService.updateLead, and Monday's existing /webhook/lead automation fires
// exactly once (Retain → retainer email; signed → handoff + payment link; fee →
// payment link; bookingInvite 'Send' → booking email). The portal NEVER calls
// those service functions directly, so there is no double-fire. 'resendLinks'
// is the only direct call (no column triggers it).
//
// Outcome labels are the EXACT strings on the board (curly apostrophe + em
// dash) — writing a near-match would mint a junk label via
// create_labels_if_missing, so they must match byte-for-byte.
const OUTCOME_LABELS = ['Retain', 'Don’t Retain — Ineligible', 'Don’t Retain — Not Wanted', 'Newsletter', 'Follow-Up'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FEE_MAX_CAD = 100000;

/** PURE validation of a consultant action. @returns {{ ok, error?, normalized? }} */
function validateAction(action, value) {
  switch (action) {
    case 'outcome':
      return OUTCOME_LABELS.includes(value)
        ? { ok: true, normalized: value }
        : { ok: false, error: 'Invalid outcome value.' };
    case 'retainerFee': {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > FEE_MAX_CAD) {
        return { ok: false, error: `Fee must be a positive amount in CAD dollars (max ${FEE_MAX_CAD}).` };
      }
      return { ok: true, normalized: Math.round(n) };
    }
    case 'retainerSigned': {
      const d = (value && String(value).trim()) || new Date().toISOString().split('T')[0];
      return DATE_RE.test(d) ? { ok: true, normalized: d } : { ok: false, error: 'Date must be YYYY-MM-DD.' };
    }
    case 'bookingInvite':
    case 'resendLinks':
      return { ok: true, normalized: null };
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

/** Post a portal-origin audit note on the lead (best-effort; never blocks the action). */
async function postPortalNote(leadId, text) {
  try {
    await mondayApi.query(
      `mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }`,
      { id: String(leadId), b: `🧑‍💼 <b>[Consultant portal]</b> ${text}` }
    );
  } catch (err) {
    console.warn(`[Consultant] audit note failed for lead ${leadId}: ${err.message}`);
  }
}

/**
 * Apply a consultant action to a lead. Validates, writes the column (or sends),
 * posts an audit note, and returns a human-facing result message.
 * @throws {Error} with .badRequest=true on validation failure, .notFound on missing lead
 */
async function applyAction({ leadId, action, value }) {
  const v = validateAction(action, value);
  if (!v.ok) { const e = new Error(v.error); e.badRequest = true; throw e; }

  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }

  const feeSet = require('./retainerService2').feeToCents(lead.retainerFee);

  switch (action) {
    case 'outcome':
      await leadService.updateLead(leadId, { outcome: v.normalized });
      await postPortalNote(leadId, `Outcome set to “${v.normalized}”.`);
      if (v.normalized === 'Retain') {
        return { ok: true, message: feeSet
          ? 'Outcome recorded as Retain — the retainer agreement (stating the fee) is being emailed to the client.'
          : 'Outcome recorded as Retain. The agreement states the fee, so it will be emailed automatically once you set the retainer fee below — no agreement goes out without a fee.' };
      }
      return { ok: true, message: `Outcome recorded: ${v.normalized}.` };

    case 'retainerFee':
      await leadService.updateLead(leadId, { retainerFee: v.normalized });
      await postPortalNote(leadId, `Retainer fee set to $${v.normalized} CAD.`);
      return { ok: true, message: `Retainer fee set to $${v.normalized}. The retainer agreement (once Outcome is Retain) and the payment link (once signed) are emailed automatically.` };

    case 'retainerSigned':
      await leadService.updateLead(leadId, { retainerSigned: v.normalized });
      await postPortalNote(leadId, `Retainer marked signed (${v.normalized}).`);
      return { ok: true, message: 'Retainer marked signed — the case is being created and the payment link emailed to the client.' };

    case 'bookingInvite':
      await leadService.updateLead(leadId, { bookingInvite: 'Send' });
      await postPortalNote(leadId, 'Booking invite re-sent to the client.');
      return { ok: true, message: 'The booking invite is being emailed to the client.' };

    case 'resendLinks':
      await require('./consultationService').resendConsultationLinks(leadId);
      await postPortalNote(leadId, 'Meeting + pre-consultation links re-sent to the client.');
      return { ok: true, message: 'The meeting and pre-consultation links have been re-sent to the client.' };

    default: {
      const e = new Error('Unknown action.'); e.badRequest = true; throw e;
    }
  }
}

module.exports = { getConsultationQueue, getConsultationDetail, validateAction, applyAction, OUTCOME_LABELS };
