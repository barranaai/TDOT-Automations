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
const { validateMilestones } = require('./retainerPlanService');
const { buildRetainerPlan, overridesFromLead } = require('./retainerPlanBuilder');
const { ANNEXES } = require('../../config/annexCatalogue');
const { feeToCents, centsToMoney } = require('../utils/money');
const consultAgreementService = require('./consultAgreementService');

// Curated lifecycle Case Stages offered as milestone payment triggers. These are
// the payment-relevant progression stages on the Client Master "Case Stage"
// column (color_mm0x8faa), in lifecycle order. Side-states (Stuck, Cancelled,
// Ads posted, Task Done, Profile Created/Linked, Reconsideration) are excluded —
// they aren't points at which a fee milestone falls due.
const MILESTONE_TRIGGER_STAGES = [
  'Pre-Onboarding',
  'Retainer Confirmed',
  'Document Collection Started',
  'Internal Review',
  'Submission Preparation',
  'Submission Ready',
  'Application Submitted',
];
const CM_CASE_STAGE_COL = 'color_mm0x8faa';

/** Read a case's current Case Stage from the Client Master board. Best-effort:
 *  returns '' when the lead isn't linked to a case yet, or on any error (a stage
 *  read must never break the detail page). */
async function readCaseStage(clientMasterItemId) {
  if (!clientMasterItemId) return '';
  try {
    const d = await mondayApi.query(
      `query($i:[ID!]){ items(ids:$i){ column_values(ids:["${CM_CASE_STAGE_COL}"]){ text } } }`,
      { i: [String(clientMasterItemId)] });
    return (d && d.items && d.items[0] && d.items[0].column_values[0] && d.items[0].column_values[0].text) || '';
  } catch (err) {
    console.warn(`[Portal] readCaseStage(${clientMasterItemId}) failed: ${err.message}`);
    return '';
  }
}

/** The retainer-plan payload the portal panel hydrates from — built from a lead
 *  we already hold (so the detail page and the /retainer-plan endpoint share it
 *  instead of each doing its own getLead). `extra.currentCaseStage` is the live
 *  Case Stage (when the lead is already a case) so the panel can flag the
 *  milestone whose trigger that stage has reached as due. */
function buildRetainerPlanResponse(lead, extra = {}) {
  return {
    plan:            buildRetainerPlan(lead, overridesFromLead(lead)),
    saved:           !!lead.selectedTemplate,
    feeSet:          feeToCents(lead.retainerFee) != null,
    retainerFee:     lead.retainerFee || '',
    annexOptions:    ANNEXES.map((a) => ({ code: a.code, label: a.label, group: a.group })),
    templateOptions: ['pa', 'pa-inviter', 'employer'],
    familyMembers:   resolveFamilyMembers(lead),
    familyMemberTypes: FAMILY_MEMBER_TYPES,
    milestoneTriggerStages: MILESTONE_TRIGGER_STAGES,
    currentCaseStage: extra.currentCaseStage || '',
  };
}

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

  const [preConsult, intake, currentCaseStage] = await Promise.all([
    readLeadJson(lead.fullName, leadId, 'pre-consult-submission.json'),
    readLeadJson(lead.fullName, leadId, 'intake-submission.json'),
    readCaseStage(lead.clientMasterItemId),
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

    // Initial Consultation agreement (consultant-sent)
    consultAgreement: {
      sent:     lead.consultAgreementSent || '',
      warnings: consultAgreementService.buildConsultAgreementData(lead).warnings,
    },

    // Assigned consultant. Routing (case type + CRS → Shafoli/Shermin) is the
    // default, but once a booking persists `assignedConsultant`, that stored name
    // is authoritative — the routing inputs can change afterward, so we show who
    // was actually assigned and flag for verification if live routing now differs.
    assignedConsultant: (() => {
      const routed = require('../../config/consultantRouting').routeConsultant(lead);
      const pinned = (lead.assignedConsultant || '').trim();
      if (!pinned) return routed;
      if (pinned === routed.name) return { ...routed, persisted: true };
      return { ...routed, name: pinned, persisted: true, needsVerify: true,
        reason: `Assigned at booking · live routing now suggests ${routed.name}` };
    })(),

    // Retainer plan — folded in so the detail page hydrates the panel without a
    // second getLead round-trip (built from the lead already in hand).
    retainerPlan: buildRetainerPlanResponse(lead, { currentCaseStage }),

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

const PLAN_TEMPLATES = ['pa', 'pa-inviter', 'employer'];
const SELECTION_STR_FIELDS = [
  'caseType', 'subType', 'annexCode', 'template', 'agreementDate', 'applicationType', 'paymentAnnexNo',
  'inviterName', 'inviterAddress', 'inviterPhone', 'inviterEmail',
  'empRepName', 'empCompanyName', 'empCompanyAddress', 'empCompanyPhone', 'empRepPhone', 'empRepEmail',
];

// Family member types the consultant can set in the retainer panel (these match
// the Family Members board labels; "Principal Applicant" is implicit, never
// listed). Only ACCOMPANYING members are later materialised to the board at
// handoff → per-member document checklist + questionnaire sections.
// Types that map to a real checklist schema role. "Worker Spouse" is deliberately
// excluded: compositionAdapter maps it to role 'WorkerSpouse', which no case schema
// defines, so it would render a questionnaire section but seed zero checklist docs.
// (SOWP schemas model the working partner as a 'Sponsor' role.)
const FAMILY_MEMBER_TYPES = ['Spouse', 'Dependent Child', 'Parent', 'Sibling', 'Sponsor'];

function normalizeFamilyMember(m) {
  return {
    type: String((m && m.type) || '').trim(),
    name: String((m && m.name) || '').trim(),
    accompanying: !!(m && (m.accompanying === true || m.accompanying === 'Yes' || m.accompanying === 'true' || m.accompanying === 1)),
  };
}

// The family list the retainer panel shows: the consultant's saved list wins;
// otherwise prefill from the intake answers (spouse + N children) so the panel
// opens with a sensible starting point the consultant just refines.
function resolveFamilyMembers(lead) {
  if (lead.retainerFamilyMembers) {
    try {
      const arr = JSON.parse(lead.retainerFamilyMembers);
      if (Array.isArray(arr)) return arr.map(normalizeFamilyMember).filter((m) => FAMILY_MEMBER_TYPES.includes(m.type));
    } catch (_) { /* fall through to the intake prefill */ }
  }
  const out = [];
  // spouseAccompanying is Yes/No/Not sure → '!== No' is meaningful. childrenAccompanying
  // is All/Some/None/Not sure → only 'None' means nobody accompanies (default the rest
  // to accompanying; the consultant confirms per-child in the panel).
  if (lead.hasSpouse === 'Yes') out.push({ type: 'Spouse', name: '', accompanying: lead.spouseAccompanying !== 'No' });
  const n = parseInt(String(lead.childrenCount || '0'), 10);
  for (let i = 1; i <= Math.min(Number.isFinite(n) ? n : 0, 12); i++) {
    out.push({ type: 'Dependent Child', name: '', accompanying: lead.childrenAccompanying !== 'None' });
  }
  return out;
}

/**
 * PURE — whitelist + normalise a retainer-selections payload (JSON string or
 * object) into the override shape buildRetainerPlan consumes. Returns null on
 * malformed/empty input or an unknown template. Shared by the save validation
 * AND the preview so the saved plan and the previewed PDF can never diverge.
 */
function parseSelections(value) {
  let raw = value;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { return null; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const sel = {};
  for (const k of SELECTION_STR_FIELDS) if (raw[k] != null) sel[k] = String(raw[k]).trim();
  if (raw.feeCents != null) { const c = Math.round(Number(raw.feeCents)); if (Number.isFinite(c) && c >= 0 && c <= FEE_MAX_CAD * 100) sel.feeCents = c; }
  if (raw.govFeeDollars != null) { const d = Number(raw.govFeeDollars); if (Number.isFinite(d) && d >= 0 && d <= FEE_MAX_CAD) sel.govFeeDollars = d; }
  if (raw.hstRate != null) { const r = Number(String(raw.hstRate).replace('%', '')); if (Number.isFinite(r) && r >= 0) sel.hstRate = r; }
  if (raw.withRprf != null) sel.withRprf = (raw.withRprf === true || raw.withRprf === 'Yes' || raw.withRprf === 'true');
  if (Array.isArray(raw.milestones)) {
    sel.milestones = raw.milestones.map((m, i) => ({
      label: String((m && m.label) || '').trim(),
      amountCents: Math.round(Number(m && m.amountCents) || 0),
      trigger: String((m && m.trigger) || '').trim(),
      locked: i === 0,
    }));
  }
  if (Array.isArray(raw.familyMembers)) {
    sel.familyMembers = raw.familyMembers
      .map(normalizeFamilyMember)
      .filter((m) => FAMILY_MEMBER_TYPES.includes(m.type))
      .slice(0, 20);
  }
  if (sel.template && !PLAN_TEMPLATES.includes(sel.template)) return null;
  return Object.keys(sel).length ? sel : null;
}

/** PURE validation of a consultant action. @returns {{ ok, error?, normalized? }} */
function validateAction(action, value) {
  switch (action) {
    case 'saveRetainerSelections': {
      const sel = parseSelections(value);
      if (!sel) return { ok: false, error: 'Provide valid retainer selections.' };
      if (!sel.template || !sel.annexCode) return { ok: false, error: 'Choose a signatory template and a scope annex.' };
      if (sel.feeCents == null || sel.feeCents <= 0) return { ok: false, error: 'Set the retainer fee before saving the plan.' };
      const mc = validateMilestones(sel.milestones || [], sel.feeCents);
      if (!mc.ok) return { ok: false, error: mc.errors[0] };
      return { ok: true, normalized: sel };
    }
    case 'outcome':
      return OUTCOME_LABELS.includes(value)
        ? { ok: true, normalized: value }
        : { ok: false, error: 'Invalid outcome value.' };
    case 'retainerFee': {
      // Reject loosely-typed inputs (boolean→1, [5]→5, '0x10'→16, '1e9'): require
      // a plain decimal number or numeric string before coercion.
      if (typeof value !== 'number' && typeof value !== 'string') return { ok: false, error: 'Fee must be a number.' };
      const s = String(value).trim();
      if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'Fee must be a plain CAD dollar amount.' };
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0 || n > FEE_MAX_CAD) {
        return { ok: false, error: `Fee must be a positive amount in CAD dollars (max ${FEE_MAX_CAD}).` };
      }
      return { ok: true, normalized: Math.round(n) };
    }
    case 'retainerSigned': {
      const d = (value && String(value).trim()) || new Date().toISOString().split('T')[0];
      if (!DATE_RE.test(d)) return { ok: false, error: 'Date must be YYYY-MM-DD.' };
      // Structural match isn't enough — reject impossible dates (2026-13-99) by
      // requiring the parsed date to round-trip to the same string.
      const dt = new Date(d + 'T00:00:00Z');
      if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) return { ok: false, error: 'That date doesn’t exist.' };
      return { ok: true, normalized: d };
    }
    case 'bookingInvite':
    case 'resendLinks':
    case 'sendConsultAgreement':
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
async function applyAction({ leadId, action, value, amend = false }) {
  const v = validateAction(action, value);
  if (!v.ok) { const e = new Error(v.error); e.badRequest = true; throw e; }

  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }

  // Once the retainer agreement has been emailed, its contractual terms — the fee
  // and the milestone schedule / plan — are locked: the client may already hold an
  // agreement stating them. Changing them needs a deliberate "Amend" (records a
  // staff note). The send itself never re-fires (retainerService2 guards on
  // retainerSent), so this protects data integrity, not duplicate emails.
  const agreementSent = !!(lead.retainerSent && String(lead.retainerSent).trim());
  if (agreementSent && !amend && (action === 'retainerFee' || action === 'saveRetainerSelections')) {
    const e = new Error('The retainer agreement has already been sent, so the fee and milestones are locked. Use “Amend” if you genuinely need to change them.');
    e.badRequest = true; e.locked = true; throw e;
  }

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
      await postPortalNote(leadId, agreementSent
        ? `⚠ <b>Retainer fee AMENDED after the agreement was sent</b> — now $${v.normalized} CAD. The client may hold an agreement stating a different fee; re-issue it if the change is material.`
        : `Retainer fee set to $${v.normalized} CAD.`);
      return { ok: true, message: agreementSent
        ? `Retainer fee amended to $${v.normalized}. A staff note was recorded — the agreement was NOT re-sent.`
        : `Retainer fee set to $${v.normalized}. The retainer agreement (once Outcome is Retain) and the payment link (once signed) are emailed automatically.` };

    case 'retainerSigned': {
      // Precondition: signing implies the consultation was retained. Without
      // this, a mis-click on an un-retained lead would still flow through to
      // handoffService and create a spurious Client Master case.
      if (lead.outcome !== 'Retain') {
        const e = new Error('Set the outcome to “Retain” before marking the retainer signed.');
        e.badRequest = true; throw e;
      }
      await leadService.updateLead(leadId, { retainerSigned: v.normalized });
      await postPortalNote(leadId, `Retainer marked signed (${v.normalized}).`);
      return { ok: true, message: 'Retainer marked signed — the case is being created and the payment link emailed to the client.' };
    }

    case 'bookingInvite':
      await leadService.updateLead(leadId, { bookingInvite: 'Send' });
      await postPortalNote(leadId, 'Booking invite re-sent to the client.');
      return { ok: true, message: 'The booking invite is being emailed to the client.' };

    case 'resendLinks':
      await require('./consultationService').resendConsultationLinks(leadId);
      await postPortalNote(leadId, 'Meeting + pre-consultation links re-sent to the client.');
      return { ok: true, message: 'The meeting and pre-consultation links have been re-sent to the client.' };

    case 'sendConsultAgreement': {
      const r = await require('./consultAgreementService').sendConsultAgreement(leadId);
      await postPortalNote(leadId, 'Initial consultation agreement emailed to the client.');
      return { ok: true, message: 'The initial consultation agreement has been emailed to the client.', url: r.url };
    }

    case 'saveRetainerSelections': {
      const s = v.normalized;
      // Writes ONLY the new inert columns — NOT retainerFee/outcome/retainerSigned,
      // so saving the plan never re-fires the retainer-agreement / payment automations.
      // clearKeys = the fields a consultant may blank/deselect, so clearing them in
      // the UI actually erases the stored value instead of leaving it stale.
      await leadService.updateLead(leadId, {
        selectedTemplate:   s.template,
        selectedScopeAnnex: s.annexCode,
        selectedSubType:    s.subType || '',
        govFee:             (s.govFeeDollars != null) ? s.govFeeDollars : '',
        retainerHstRate:    (s.hstRate != null) ? String(s.hstRate) : '13',
        retainerWithRprf:   s.withRprf ? 'Yes' : 'No',
        retainerMilestones: JSON.stringify(s.milestones || []),
        retainerFamilyMembers: JSON.stringify(s.familyMembers || []),
        inviterName: s.inviterName || '', inviterAddress: s.inviterAddress || '', inviterPhone: s.inviterPhone || '', inviterEmail: s.inviterEmail || '',
        empRepName: s.empRepName || '', empCompanyName: s.empCompanyName || '', empCompanyAddress: s.empCompanyAddress || '',
        empCompanyPhone: s.empCompanyPhone || '', empRepPhone: s.empRepPhone || '', empRepEmail: s.empRepEmail || '',
      }, { clearKeys: [
        'selectedSubType', 'govFee',
        'inviterName', 'inviterAddress', 'inviterPhone', 'inviterEmail',
        'empRepName', 'empCompanyName', 'empCompanyAddress', 'empCompanyPhone', 'empRepPhone', 'empRepEmail',
      ] });
      await postPortalNote(leadId, agreementSent
        ? `⚠ <b>Retainer plan AMENDED after the agreement was sent</b> — template ${s.template}, scope annex ${s.annexCode}, fee $${centsToMoney(s.feeCents)}. The sent agreement may state different terms.`
        : `Retainer plan saved — template ${s.template}, scope annex ${s.annexCode}, fee $${centsToMoney(s.feeCents)}.`);
      return { ok: true, message: agreementSent ? 'Retainer plan amended — a staff note was recorded.' : 'Retainer plan saved.' };
    }

    default: {
      const e = new Error('Unknown action.'); e.badRequest = true; throw e;
    }
  }
}

/**
 * Assemble the retainer plan for the portal panel: the system's suggestion
 * merged with any saved selections, plus the option lists the UI needs.
 * @throws {Error} .notFound if the lead is missing
 */
async function getRetainerPlan(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }
  const currentCaseStage = await readCaseStage(lead.clientMasterItemId);
  return buildRetainerPlanResponse(lead, { currentCaseStage });
}

/**
 * Render a preview PDF from the consultant's current (unsaved) selections.
 * Costs one CloudConvert conversion. @returns {Promise<{buffer:Buffer, filename:string}>}
 * @throws {Error} .badRequest on malformed selections, .notFound on missing lead
 */
async function previewRetainerPdf(leadId, value) {
  const sel = parseSelections(value);
  if (!sel) { const e = new Error('Provide valid retainer selections.'); e.badRequest = true; throw e; }
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }

  const plan = buildRetainerPlan(lead, sel);
  if (!plan.ready) {
    const e = new Error(plan.warnings.join(' · ') || 'The retainer plan is incomplete — fill it in before previewing.');
    e.badRequest = true; throw e;
  }
  const { milestoneAnnexFromPlan } = require('./retainerPlanBuilder');
  const buffer = await require('./retainerDocService').generate({
    template: plan.template, data: plan.mergeData, annexId: plan.annex.id,
    milestoneAnnex: milestoneAnnexFromPlan(plan),
  });
  return { buffer, filename: `retainer-${leadId}-preview.pdf` };
}

/**
 * Render a preview PDF of the Initial Consultation agreement (read-only).
 * @throws {Error} .notFound on missing lead
 */
async function previewConsultAgreement(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }
  const buffer = await require('./consultAgreementService').generateConsultAgreementPdf(lead);
  return { buffer, filename: `consult-agreement-${leadId}.pdf` };
}

module.exports = {
  getConsultationQueue, getConsultationDetail, validateAction, applyAction, OUTCOME_LABELS,
  parseSelections, getRetainerPlan, previewRetainerPdf, previewConsultAgreement,
  resolveFamilyMembers, FAMILY_MEMBER_TYPES, MILESTONE_TRIGGER_STAGES,
};
