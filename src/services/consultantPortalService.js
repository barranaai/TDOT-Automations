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
const { torontoDay, torontoWallClock } = require('../utils/torontoTime');
const { statusText } = require('../utils/mondayStatus');
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
const CM_CASE_REF_COL   = 'text_mm142s49';

/** Read a case's current Case Stage and case reference from the Client Master
 *  board, in one query. Best-effort: both '' when the lead isn't linked to a
 *  case yet, or on any error (this read must never break the detail page). */
async function readCaseCells(clientMasterItemId) {
  const none = { caseStage: '', caseRef: '' };
  if (!clientMasterItemId) return none;
  try {
    const d = await mondayApi.query(
      `query($i:[ID!]){ items(ids:$i){ column_values(ids:["${CM_CASE_STAGE_COL}","${CM_CASE_REF_COL}"]){ id text } } }`,
      { i: [String(clientMasterItemId)] });
    const cols = (d && d.items && d.items[0] && d.items[0].column_values) || [];
    // Monday returns the cells in board order, so each is picked by id.
    const text = (id) => { const c = cols.find((x) => x && x.id === id); return (c && c.text) || ''; };
    return { caseStage: text(CM_CASE_STAGE_COL), caseRef: text(CM_CASE_REF_COL) };
  } catch (err) {
    console.warn(`[Portal] readCaseCells(${clientMasterItemId}) failed: ${err.message}`);
    return none;
  }
}

/** The retainer-plan payload the portal panel hydrates from — built from a lead
 *  we already hold (so the detail page and the /retainer-plan endpoint share it
 *  instead of each doing its own getLead). `extra.currentCaseStage` is the live
 *  Case Stage (when the lead is already a case) so the panel can flag the
 *  milestone whose trigger that stage has reached as due; `extra.caseRef` is
 *  the case reference, so the Mark-paid dialog can name WHICH client. */
function buildRetainerPlanResponse(lead, extra = {}) {
  return {
    caseRef:         extra.caseRef || '',
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
    milestonePayments: require('./milestonePaymentService').milestoneStates(lead, extra.currentCaseStage || '', MILESTONE_TRIGGER_STAGES),
  };
}

const C = require('../data/newLeadsBoard.json').columns;

/**
 * List booked consultations for the queue, soonest first.
 * @returns {Promise<Array<{ id, name, bookedSlot, tier, service, preConsultSubmitted, outcome, hasMeeting }>>}
 */
async function getConsultationQueue() {
  const ids = [C.bookedSlot, C.tier, C.serviceRequired, C.confirmedCaseType, C.preConsultSubmitted, C.outcome, C.meetingLink,
    C.assignedConsultant, C.meetingType, C.retainerFee, C.retainerSent, C.retainerSigned, C.retainerPaid, C.followUpDate, C.leadOwner]
    .map((c) => `"${c}"`).join(', ');
  // bookingStatus='Booked' is permanent (never reset at handoff), so this
  // population grows forever — paginate with the cursor or rows beyond the
  // first page silently vanish from BOTH tabs (excluded from Leads by the
  // partition, dropped from Consultations by truncation).
  const rawItems = [];
  const first = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         cursor
         items { id name column_values(ids: [${ids}]) { id text value } }
       }
     }`,
    { boardId: String(leadBoardId), colId: C.bookingStatus, val: 'Booked' }
  );
  rawItems.push(...(first?.items_page_by_column_values?.items || []));
  let cursor = first?.items_page_by_column_values?.cursor || null;
  let guard = 0;
  while (cursor && ++guard <= 50) { // 50 × 200 = 10k booked leads — far beyond plausible
    const next = await mondayApi.query(
      `query($cursor: String!) {
         next_items_page(limit: 200, cursor: $cursor) {
           cursor
           items { id name column_values(ids: [${ids}]) { id text value } }
         }
       }`,
      { cursor }
    );
    rawItems.push(...(next?.next_items_page?.items || []));
    cursor = next?.next_items_page?.cursor || null;
  }
  if (cursor) console.warn('[Portal] getConsultationQueue hit the pagination guard with pages remaining — list is PARTIAL.');
  const items = rawItems.map((it) => {
    // Status cells: an EMPTY cell reads '' (not the label Monday shows on empty cells — utils/mondayStatus).
    const STATUS_IDS = new Set([C.tier, C.outcome, C.preConsultSubmitted]);
    const cv = {}; it.column_values.forEach((c) => { cv[c.id] = (STATUS_IDS.has(c.id) ? statusText(c) : (c.text || '')).trim(); });
    return {
      id:                 it.id,
      name:               it.name,
      bookedSlot:         cv[C.bookedSlot] || '',
      tier:               cv[C.tier] || '',
      service:            cv[C.confirmedCaseType] || cv[C.serviceRequired] || '',
      preConsultSubmitted: (cv[C.preConsultSubmitted] || '') === 'Yes',
      outcome:            cv[C.outcome] || '',
      hasMeeting:         Boolean((cv[C.meetingLink] || '').trim()),
      consultant:         cv[C.assignedConsultant] || '',
      meetingType:        cv[C.meetingType] || '',
      retainerFee:        cv[C.retainerFee] || '',
      // one derived status from the retainer date columns (most-advanced wins)
      retainerStatus:     cv[C.retainerPaid] ? 'Paid' : cv[C.retainerSigned] ? 'Signed' : cv[C.retainerSent] ? 'Sent' : (cv[C.outcome] === 'Retain' ? 'Retain' : ''),
      followUpDate:       cv[C.followUpDate] || '',
      leadOwner:          cv[C.leadOwner] || '',
    };
  });
  // MOST RECENT slot first (team feedback 2026-08-13 — staff had to scroll to
  // the bottom for this week's consultations); blanks last.
  items.sort((a, b) => (b.bookedSlot || '').localeCompare(a.bookedSlot || ''));
  return items;
}

/**
 * Best-effort read of a OneDrive JSON in the client's Intake folder — the case
 * folder once the case exists, else the pre-rename lead folder (point 12).
 */
async function readLeadJson(lead, filename) {
  const leadId = lead && lead.id;
  try {
    const buf = await require('../utils/clientFolderRefs')
      .readFirst(oneDrive, lead, { subfolder: 'Intake', filename });
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

  const [preConsult, intake, caseCells, blacklist] = await Promise.all([
    readLeadJson(lead, 'pre-consult-submission.json'),
    readLeadJson(lead, 'intake-submission.json'),
    readCaseCells(lead.clientMasterItemId),
    require('./blacklistService').check({ email: lead.email, phone: lead.phone }),   // point 5: the staff-only warning (never throws)
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
    residentialAddress: lead.residentialAddress || '',   // editable on the page (prints on the agreement)
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
    transcriptLink:  lead.transcriptLink || '',
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
    // RCIC countersign over the client-signed retainer (mirrors consultAgreement.countersign)
    retainerCountersign: (() => {
      const rc = require('./retainerCountersignService').parseRetainerCountersign(lead);
      return { sentAt: rc.sentAt || '', signedAt: rc.signedAt || '' };
    })(),
    conversionStatus: lead.conversionStatus || '', // 'Retained' once signed AND paid — locks the send button
    clientMasterItemId: lead.clientMasterItemId || '',

    // KPI attribution (staff-entered on the detail page)
    followUpDate:      lead.followUpDate || '',
    leadOwner:         lead.leadOwner || '',
    bookedBy:          lead.bookedBy || '',
    paymentReviewedBy: lead.paymentReviewedBy || '',

    // The Not Wanted list (point 5): { checked, hit, matchedOn, entries[] } — a staff warning, never a block.
    blacklist,

    // The consultation fee (point 4 part 2): paid 'app' = through the booking link;
    // a kind = recorded by staff (cash / e-transfer / invoice / other / waived); '' =
    // nothing yet. alsoRecorded: a staff record that an app payment then outranked.
    consultPayment: (() => {
      const cp = require('./consultPaymentService');
      const ps = cp.paidState(lead);
      return {
        paid: ps.paid, paidCents: ps.paidCents, on: ps.on, by: ps.by, verified: ps.verified,
        reference: ps.reference, note: ps.note, at: ps.at, feeCents: ps.feeCents,
        alsoRecorded: ps.paid === 'app' && ps.record ? cp.describe(ps.record) : '',
        onRecord: recordPackageView(lead, ps),
      };
    })(),

    // Initial Consultation agreement (consultant-sent). countersign = the RCIC's
    // signature over the client-signed copy: sentAt when the countersign envelope
    // went out, signedAt once fully signed (client + consultant).
    consultAgreement: (() => {
      const cs = consultAgreementService.parseCountersign(lead);
      return {
        sent:     lead.consultAgreementSent || '',
        signed:   lead.consultAgreementSigned || '',
        countersign: { sentAt: cs.sentAt || '', signedAt: cs.signedAt || '' },
        warnings: consultAgreementService.buildConsultAgreementData(lead).warnings,
        // point 08: the automatic package — WHY it is HELD: 'blank-address'
        // (entering the address releases it), 'slot-clash' or 'late-payment'
        // (a person decides; "Review & send").
        held:     cs.packageHeld || '',
        // a pending marker past the stale mark reads as interrupted (never "not sent — use Review & send")
        stalled:  cs.packageStalled || ((cs.packagePending && (Date.now() - Date.parse(cs.packagePending)) >= require('./consultationService').PACKAGE_STALE_MS) ? cs.packagePending : ''),
        emailedAt: cs.packageEmailedAt || '',
        expired:  cs.packageExpired || '',
        attempts: cs.packageAttempts || 0,
        // the server's own verdict (Review & send asks AGAIN on it — an envelope id alone counts)
        alreadySent: require('./consultationService').packageAlreadySent(lead),
        pending: !!(cs.packagePending && !cs.packageStalled && (Date.now() - Date.parse(cs.packagePending)) < require('./consultationService').PACKAGE_STALE_MS),
        heldBy: cs.packageHeldBy || '',
        recordOn: require('./consultationService').packageOnRecordEnabled(lead.id),
        skipped: (() => { const r = require('./consultPaymentService').parseConsultPayment(lead); return r && r.package === 'skip' ? (r.packageNote || 'chosen when the fee was recorded') : ''; })(),
        autoSend: require('./consultationService').consultPackageAutoSendEnabled(),
      };
    })(),

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
    retainerPlan: buildRetainerPlanResponse(lead, { currentCaseStage: caseCells.caseStage, caseRef: caseCells.caseRef }),

    eligibility,
  };
}

// ─── Leads (pre-booking pipeline) ─────────────────────────────────────────────
//
// The Consultations queue shows only bookingStatus='Booked' leads; the Leads
// tab shows the WHOLE Lead Board so staff see fresh intake submissions the
// moment they arrive, before any booking exists.

/** Human labels for the intake form's service-specific (F-block) answer keys. */
const FBLOCK_LABELS = {
  f1_hasProfile: 'Valid Express Entry profile?', f1_crsScore: 'CRS score', f1_hasIta: 'Received an ITA?',
  f1_itaDeadline: 'ITA deadline', f1_program: 'Inviting program / draw',
  f2_hasNomination: 'NOI / nomination / invitation?', f2_deadline: 'Deadline', f2_province: 'Province',
  f2_employerSupport: 'Employer support?',
  f3_permitType: 'Current work permit type', f3_expiry: 'Permit expiry', f3_prSubmitted: 'PR application / AOR?',
  f3_employerDocs: 'Employer documents?',
  f4_intake: 'Target intake', f4_admission: 'Admission received?', f4_need: 'Filing or document review',
  f4_deadline: 'School deadline',
  f5_location: 'Inside / outside Canada', f5_priorRefusal: 'Prior refusal?', f5_purpose: 'Purpose of travel / extension',
  f6_whoSponsors: 'Who is sponsoring whom', f6_sponsorStatus: 'Sponsor status', f6_applicantLocation: 'Applicant location',
  f6_concerns: 'Refusal / marriage-history concerns',
  f7_serviceNeeded: 'Service needed', f7_prDate: 'PR landing date', f7_insideCanada: 'Inside Canada?',
  f8_role: 'Employer or employee', f8_jobTitle: 'Job title', f8_supportType: 'Support type',
  f9_refusalType: 'Application refused', f9_refusalDate: 'Refusal date', f9_deadline: 'Deadline to respond',
  f10_need: 'Document / update needed', f10_deadline: 'Deadline',
};

/** Fallback: f2_someFieldName → "Some field name". */
function prettifyFieldKey(k) {
  const bare = String(k).replace(/^f\d+_/, '');
  const words = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * PURE: intake archive fields (+ lead-column fallbacks) → labelled sections in
 * the intake form's own order, plus the urgency flags. Empty rows are dropped;
 * empty sections are omitted. Mirrors intakeFormService.buildDigest.
 *
 * @param {object} f    archive.fields (may be {})
 * @param {object} lead parsed lead columns (may be {})
 * @returns {{ sections: Array<{title, rows: Array<{label, value}>}>, flags: string[] }}
 */
function buildIntakeSections(f, lead) {
  f = f || {}; lead = lead || {};
  // Archive answer first (the full submission), lead column as fallback.
  const A = (k, leadKey) => {
    const v = f[k];
    if (v != null && typeof v !== 'object' && String(v).trim()) return String(v).trim();
    const lv = lead[leadKey || k];
    return (lv != null && typeof lv !== 'object') ? String(lv).trim() : '';
  };
  const sections = [];
  const row = (label, value) => ({ label, value: String(value == null ? '' : value).trim() });
  const push = (title, rows) => { const rs = rows.filter((r) => r.value); if (rs.length) sections.push({ title, rows: rs }); };

  push('Basic information', [
    row('Full legal name', A('fullName') || lead.fullName || ''),
    row('Email', A('email')),
    row('Phone', A('phone')),
    // Column FIRST: the address is editable on the lead page, so a correction
    // must show here too (the archive keeps what the client originally typed).
    row('Residential address', String(lead.residentialAddress || '').trim() || A('residentialAddress')),
    // Column first: staff can correct where the client is on the lead page (it sets the consultation HST).
    row('Inside Canada', String(lead.insideCanada || '').trim() || A('insideCanada')),
    row('Country', String(lead.country || '').trim() || (A('insideCanada') === 'Yes' ? 'Canada' : A('currentCountry', 'country'))),
  ]);

  const kids = A('childrenCount');
  push('Family members', [
    row('Spouse / common-law partner', A('hasSpouse')),
    row('Spouse accompanying', A('hasSpouse') === 'Yes' ? A('spouseAccompanying') : ''),
    row('Dependent children', kids),
    row('Children accompanying', Number(kids) > 0 ? A('childrenAccompanying') : ''),
  ]);

  push('Current immigration status', [
    row('Status', A('currentStatus')),
    row('Status expiry', A('statusExpiry')),
    row('Recent extension / status application', A('recentExtension')),
    row('Extension details', A('recentExtensionDetails')),
  ]);

  push('Relationship with TDOT', [
    row('Relationship', A('relationshipWithTdot')),
    row('Existing file type', A('existingFileType')),
  ]);

  push('Service required', [
    row('Service', A('serviceRequired')),
    row('Wants to', A('whatDoYouWant')),
  ]);

  // Service-specific answers — scoped to the ACTIVE F-block for the selected
  // service, like intakeFormService.buildDigest. The raw archive keeps values
  // typed into F-blocks the client abandoned when switching service (hidden
  // inputs still submit); rendering those would present wrong-service facts as
  // triage data. Unknown/unmapped service ⇒ show everything (better than
  // hiding real answers).
  let activeBlockPrefix = null;
  try {
    const blk = require('./intakeFormService').serviceToFBlock(A('serviceRequired'));
    if (blk) activeBlockPrefix = blk.toLowerCase() + '_';   // 'F1' → 'f1_' ('f1_' never matches 'f10_…')
  } catch (_) { /* keep unscoped */ }
  const labelOrder = Object.keys(FBLOCK_LABELS);
  const fRows = Object.keys(f)
    .filter((k) => /^f\d+_/.test(k) && f[k] != null && typeof f[k] !== 'object' && String(f[k]).trim())
    .filter((k) => !activeBlockPrefix || k.toLowerCase().startsWith(activeBlockPrefix))
    .sort((a, b) => {
      const ka = labelOrder.indexOf(a), kb = labelOrder.indexOf(b);
      return (ka < 0 ? 999 : ka) - (kb < 0 ? 999 : kb);
    })
    .map((k) => row(FBLOCK_LABELS[k] || prettifyFieldKey(k), f[k]));
  if (fRows.length) sections.push({ title: 'Service-specific answers', rows: fRows });

  // The raw archive keeps a deadline the client typed then disowned (toggled
  // urgentDeadline back to "No" — hidden inputs still submit). The lead COLUMN
  // is the properly-gated write, so it is the only date fallback used here.
  const gatedDeadline = String((lead && lead.deadlineDate) || '').trim();
  const urgency = [
    row('Urgent deadline', A('urgentDeadline') === 'Yes'
      ? [A('deadlineDate'), A('deadlineReason')].filter(Boolean).join(' — ') || 'Yes'
      : A('urgentDeadline') || gatedDeadline),
    row('Removal / enforcement order', A('removalOrder')),
    row('CBSA / IRCC letter', A('enforcementLetter')),
    row('Enforcement details', A('enforcementDetails')),
    row('Restoration period', A('restorationPeriod')),
    row('Restoration deadline', A('restorationDeadline')),
    row('Recent refusal', A('recentRefusal') === 'Yes'
      ? [A('refusalType'), A('refusalDate')].filter(Boolean).join(' — ') || 'Yes'
      : A('recentRefusal')),
  ];
  push('Urgency screening', urgency);

  push('Source', [
    row('How they heard about TDOT', A('howHeard')),
    row('Referred by', A('referredBy')),
  ]);

  const flags = [];
  if (A('removalOrder') === 'Yes') flags.push('Removal / enforcement order');
  if (A('enforcementLetter') === 'Yes') flags.push('CBSA / IRCC letter received');
  if (A('urgentDeadline') === 'Yes' || gatedDeadline) flags.push('Urgent deadline');

  return { sections, flags };
}

/**
 * The pre-booking pipeline as lightweight listing rows, newest first.
 * Booked leads are EXCLUDED — once a consultation is booked the lead "moves"
 * to the Consultations queue (which filters bookingStatus='Booked'); the two
 * tabs partition the Lead Board with no overlap.
 *
 * listAllLeads paginates the ENTIRE board, so the result is cached briefly
 * (same pattern as kpiService); invite sends bust it so the pill is fresh.
 */
const LEADS_QUEUE_CACHE_MS = 20 * 1000;
let _leadsQueueCache = { at: 0, rows: null };
/** Drop the funnel-leads queue cache — after a staff create/delete/convert so
    the refreshed list never shows a deleted lead alive or hides a new one.
    The shared board snapshot is marked too: every list reads it. */
function invalidateLeadsQueue() { _leadsQueueCache = { at: 0, rows: null }; require('./leadSnapshot').invalidate(); }

/**
 * Where a Lead Board row belongs (Gauri point 4, 2026-10-15): ONE rule for every
 * tab, so a row lands on exactly one of Leads / Consultations / Retainers — or
 * on none ('gone': retained, so a case on the Cases page). PURE.
 *   retainer     — a direct-retainer client, or a retainer sent/signed/paid, or
 *                  the consultant's outcome is Retain (the retainer team's turn)
 *   consultation — booked, still at the consultation stage
 *   lead         — everything before a booking (Not Yet / Slot Held / Abandoned)
 */
function classifyLead(l) {
  const s = (v) => String(v == null ? '' : v).trim();
  if (s(l.conversionStatus) === 'Retained') return 'gone';
  if (s(l.sourceChannel) === DIRECT_SOURCE || s(l.retainerSent) || s(l.retainerSigned) || s(l.retainerPaid) || s(l.outcome) === 'Retain') return 'retainer';
  if (s(l.bookingStatus) === 'Booked') return 'consultation';
  return 'lead';
}

async function getLeadsQueue() {
  if (_leadsQueueCache.rows && (Date.now() - _leadsQueueCache.at) < LEADS_QUEUE_CACHE_MS) {
    return _leadsQueueCache.rows;
  }
  const leads = await require('./leadSnapshot').leads();
  // One row, one tab: booked leads are on Consultations, direct-retainer clients
  // and leads with a retainer under way on Retainers, retained clients on Cases.
  const rows = leads.filter((l) => classifyLead(l) === 'lead').map((l) => ({
    id:            l.id,
    name:          l.fullName || l.name,
    createdAt:     l.createdAt || '',                     // raw UTC instant — the sort below needs it
    createdDay:    torontoDay(l.createdAt),               // what the page shows: the Toronto day it arrived
    service:       l.confirmedCaseType || l.serviceRequired || l.caseTypeInterest || '',
    source:        (l.sourceChannel || '').trim(),      // how they reached us
    owner:         (l.leadOwner || '').trim(),          // who added / owns it
    tier:          l.tier || '',
    priority:      l.priority || '',
    bookingStatus: l.bookingStatus || 'Not Yet',
    bookedSlot:    l.bookedSlot || '',
    consultant:    (l.assignedConsultant || '').trim(),
    outcome:       l.outcome || '',
    wantsTo:       l.whatDoYouWant || '', // non-booking intents get a queue pill + invite warning
    urgent:        l.removalOrder === 'Yes' || l.enforcementLetter === 'Yes' || Boolean((l.deadlineDate || '').trim()),
    inviteSent:    (l.bookingInvite || '') === 'Sent',
    inviteSentAt:  l.inviteSentAt || '',  // blank for invites sent before the stamp existed
    // Where the lead is WITH US (Faran 2026-10-28) — invite, reminders, a remark, booked, expired, the Outcome.
    status:        require('./leadStatusService').leadStatus(l, require('./leadStatusService').activityFor(l.id), Date.now()),
  }));
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || Number(b.id) - Number(a.id));
  _leadsQueueCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Assemble one lead: lead columns + the complete intake archive rendered as
 * labelled sections. Works for un-booked leads (the Consultations detail only
 * makes sense once a slot is booked).
 */
async function getLeadDetail(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Lead not found'); e.notFound = true; throw e; }

  // Where the booking-invite reminders stand (one line; invited leads only).
  // Started now, read alongside the intake; time-boxed so it never slows the page.
  const remindersP = (lead.bookingInvite || '') === 'Sent'
    ? Promise.race([
      require('./bookingRemindersService').describeForLead(lead),
      new Promise((resolve) => { const t = setTimeout(() => resolve(''), 4000); if (t.unref) t.unref(); }),
    ]).catch(() => '')
    : Promise.resolve('');

  const intake = await readLeadJson(lead, 'intake-submission.json');
  const f = (intake && intake.fields) || {};
  const { sections, flags } = buildIntakeSections(f, lead);

  // Personalized booking-invite draft: AI-generate once from the intake data
  // when nothing is saved yet, then persist so the next load is instant and
  // staff edits stick. Guards:
  //   • only for un-booked leads that have NOT been invited yet — after a send,
  //     a cleared draft stays cleared (no surprise regeneration);
  //   • generation is time-boxed (see generateInviteMessage); AI unavailable ⇒
  //     '' and the email keeps its standard intro;
  //   • before persisting, RE-READ the lead — a draft staff saved during the
  //     generation window must never be overwritten;
  //   • the persist is awaited (screen = saved) but time-boxed so a degraded
  //     Monday API cannot hang the detail page.
  let inviteMessage = (lead.inviteMessage || '').trim();
  // '[cleared]' = staff explicitly deleted the draft (saveInviteMessage) — show
  // an empty textarea but do NOT regenerate: cleared stays cleared.
  const draftCleared = inviteMessage === '[cleared]';
  if (draftCleared) inviteMessage = '';
  const inviteAlreadySent = (lead.bookingInvite || '') === 'Sent';
  if (!inviteMessage && !draftCleared && !inviteAlreadySent && (lead.bookingStatus || '').trim() !== 'Booked') {
    const generated = await leadService.generateInviteMessage(lead);
    if (generated) {
      let current = null;
      try { current = await leadService.getLead(leadId); } catch (_) { /* keep generated */ }
      const saved = current ? (current.inviteMessage || '').trim() : '';
      if (saved) {
        inviteMessage = saved;   // staff won the race — theirs stands
      } else {
        inviteMessage = generated;
        const persist = leadService.updateLead(leadId, { inviteMessage: generated });
        const timeout = new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), 5000); if (t.unref) t.unref(); });
        try {
          if (await Promise.race([persist.then(() => 'ok'), timeout]) === 'timeout') {
            console.warn(`[Leads] AI invite draft persist slow for ${leadId} — returning draft without waiting`);
            persist.catch((err) => console.warn(`[Leads] AI invite draft persist failed for ${leadId}: ${err.message}`));
          }
        } catch (err) { console.warn(`[Leads] Could not persist the AI invite draft for ${leadId}: ${err.message}`); }
      }
    }
  }

  // The Not Wanted list (point 5): a staff-only warning on the page, never a block; never throws.
  const blacklist = await require('./blacklistService').check({ email: lead.email, phone: lead.phone });

  return {
    leadId:   lead.id,
    blacklist,
    name:     lead.fullName || lead.name,
    email:    lead.email || '',
    phone:    lead.phone || '',
    address:  lead.residentialAddress || '', // convert-to-direct-retainer prefill
    createdAt: lead.createdAt || '',
    createdWhen: torontoWallClock(lead.createdAt),   // 'YYYY-MM-DD HH:MM' Toronto — when the lead arrived
    // Pre-invite consultant override (2026-08-17): the auto-routing suggestion
    // + the pickable registry names. `consultant` (below) is the pinned value.
    routedConsultant: (() => {
      try {
        const routing = require('../../config/consultantRouting');
        const r = routing.routeConsultant(lead);
        return (routing.CONSULTANTS[r.key] && routing.CONSULTANTS[r.key].name) || '';
      } catch (_) { return ''; }
    })(),
    consultants: (() => {
      try { return Object.values(require('../../config/consultantRouting').CONSULTANTS).map((c) => c.name); }
      catch (_) { return []; }
    })(),
    tier:     lead.tier || '',
    priority: lead.priority || '',
    service:  lead.confirmedCaseType || lead.serviceRequired || lead.caseTypeInterest || '',
    situationDescription: lead.situationDescription || (typeof f.situationDescription === 'string' ? f.situationDescription : '') || '',
    // Add-lead group (2026-10-15)
    sourceChannel:    (lead.sourceChannel || '').trim(),
    originalChannel:  (lead.originalChannel || '').trim(),
    caseTypeInterest: (lead.caseTypeInterest || '').trim(),
    leadOwner:        (lead.leadOwner || '').trim(),
    staffAdded:       STAFF_LEAD_SOURCES.includes((lead.sourceChannel || '').trim()),
    insideCanada:     (lead.insideCanada || '').trim(),
    country:          (lead.country || '').trim(),

    bookingStatus: lead.bookingStatus || 'Not Yet',
    bookedSlot:    lead.bookedSlot || '',
    outcome:       lead.outcome || '',
    // The client's stated intent ("Book consultation" / "Request quote" / …) —
    // the portal warns before sending a booking invite when it isn't a booking.
    wantsTo:       lead.whatDoYouWant || '',
    // Walk-in/referral entering at the retainer stage — the leads page shows the
    // consultation/retainer link for these even though they never book.
    directRetainer: (lead.sourceChannel || '').trim() === DIRECT_SOURCE,
    consultant:    (lead.assignedConsultant || '').trim(),
    preConsultSubmitted: (lead.preConsultSubmitted || '') === 'Yes',
    clientMasterItemId:  lead.clientMasterItemId || '',
    // "Record payment / Waived" from the lead page (review 2026-10-16): a client booked by
    // hand is often never set to Booked — the box must be reachable before that.
    paidOnline:   !!String(lead.squareConsultTxnId || '').trim(),
    heldOnline:   (String(lead.bookingStatus || '').trim() === 'Slot Held' && Date.parse(String(lead.slotHeldUntil || '')) > Date.now()),
    // "(and book)" only when the box will really ask for the booking (same test as the dialog)
    recordBooks:  (() => { const cs = require('./consultationService'); return cs.packageOnRecordEnabled(lead.id) && cs.packageApplicable(lead).ok && !cs.packageAlreadySent(lead); })(),
    // a fee staff already recorded (the booking link would charge again)
    feeRecorded:  (() => { const cp = require('./consultPaymentService'); const ps = cp.paidState(lead); return ps.record && ps.paid !== 'app' ? cp.describe(ps.record) : ''; })(),
    inviteMessage,
    inviteSent: (lead.bookingInvite || '') === 'Sent',
    inviteSentAt: lead.inviteSentAt || '',
    bookingReminders: await remindersP,

    hasIntakeArchive: Boolean(intake),
    intakeSubmittedAt: torontoWallClock(intake && intake.submittedAt),   // shown as a Toronto date
    attachments: ((intake && intake.uploadedFiles) || [])
      .map((u) => (typeof u === 'string' ? u : String((u && (u.filename || u.name)) || ''))).filter(Boolean),
    consentsAt: torontoWallClock(intake && intake.consents && intake.consents.at),

    flags,
    sections,

    aiTalkingPoints:   lead.aiTalkingPoints || '',
    aiComplianceFlags: lead.aiComplianceFlags || '',
    priorityReasons:   lead.priorityReasons || '',
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
// Outcome labels are the EXACT strings on the board — writing a near-match
// would mint a junk label via create_labels_if_missing, so they must match
// byte-for-byte. Four since 2026-10-15 (Gauri point 5): config/outcomes.js.
const { OUTCOME_LABELS, OUTCOME_NOT_WANTED, OUTCOME_RETAIN, canonicalOutcome } = require('../../config/outcomes');
const NOT_WANTED_REASON_MIN = 3;
// One-click remark presets (consultant note #8) — config/leadRemarks.js
const { REMARK_PRESETS } = require('../../config/leadRemarks');
const escHtmlNote = (str) => String(str == null ? '' : str).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
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
    dateOfBirth:        String((m && m.dateOfBirth) || '').trim(),
    currentStatus:      String((m && m.currentStatus) || '').trim(),
    countryOfResidence: String((m && m.countryOfResidence) || '').trim(),
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
  if (raw.adFeeDollars != null) { const d = Number(raw.adFeeDollars); if (Number.isFinite(d) && d >= 0 && d <= FEE_MAX_CAD) sel.adFeeDollars = d; }
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
    case 'outcome': {
      // A label, or { label, reason }. "Not Wanted" needs the consultant's reason —
      // it goes on the lead's note and on the Not Wanted list (point 5).
      let label = value, reason = '';
      if (value && typeof value === 'object') { label = value.label; reason = value.reason; }
      else if (typeof value === 'string' && value.trim().startsWith('{')) {
        try { const o = JSON.parse(value); label = o && o.label; reason = o && o.reason; } catch (_) { return { ok: false, error: 'Invalid outcome value.' }; }
      }
      if (!OUTCOME_LABELS.includes(label)) return { ok: false, error: 'Invalid outcome value.' };
      reason = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
      if (label === OUTCOME_NOT_WANTED) {
        if (reason.length < NOT_WANTED_REASON_MIN) return { ok: false, error: 'Give the reason this person is not wanted — it is recorded on the lead and on the Not Wanted list.' };
        if (reason.length > require('./blacklistService').MAX_REASON) return { ok: false, error: `Keep the reason under ${require('./blacklistService').MAX_REASON} characters.` };
      } else {
        reason = '';
      }
      return { ok: true, normalized: label, reason };
    }
    case 'remark': {
      // { preset?: key, text?: string } — a preset alone is a one-click remark; text alone is free-form.
      let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { return { ok: false, error: 'Invalid remark payload.' }; }
      if (!o || typeof o !== 'object') return { ok: false, error: 'Invalid remark payload.' };
      const presetKey = String(o.preset || '').trim();
      const preset = presetKey ? REMARK_PRESETS.find((r) => r.key === presetKey) : null;
      if (presetKey && !preset) return { ok: false, error: 'Unknown remark preset.' };
      const text = String(o.text || '').replace(/\r\n/g, '\n').trim();
      if (text.length > 2000) return { ok: false, error: 'Remarks are limited to 2000 characters.' };
      if (!preset && !text) return { ok: false, error: 'Pick a remark or write one.' };
      return { ok: true, normalized: { preset: preset ? preset.key : '', presetLabel: preset ? preset.label : '', text } };
    }
    case 'sendMilestoneEtransferRequest': {
      const i = parseInt(value, 10);
      if (!Number.isInteger(i) || i < 0 || i > 20) return { ok: false, error: 'Invalid milestone.' };
      return { ok: true, normalized: i };
    }
    case 'markMilestonePaid': {
      let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { return { ok: false, error: 'Invalid payload.' }; }
      const i = parseInt(o && o.index, 10);
      if (!Number.isInteger(i) || i < 0 || i > 20) return { ok: false, error: 'Invalid milestone.' };
      const reference = String((o && o.reference) || '').trim().slice(0, 120);
      // Part-payments (2026-10-13): the amount received, in cents. Absent = the whole balance (today's Mark paid).
      let amountCents = null;
      if (o && o.amountCents != null && o.amountCents !== '') {
        const a = Number(o.amountCents);
        if (!Number.isInteger(a) || a <= 0 || a > 20000000) return { ok: false, error: 'Enter the amount received, in dollars and cents (up to $200,000).' };
        amountCents = a;
      }
      // settle: "Mark settled" — close a part-paid milestone that the money on file already covers (no amount).
      return { ok: true, normalized: { index: i, reference, amountCents, settle: !!(o && o.settle === true) } };
    }
    case 'saveAttribution': {
      let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { return { ok: false, error: 'Invalid payload.' }; }
      o = o || {};
      const fu = String(o.followUpDate || '').trim();
      if (fu) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fu)) return { ok: false, error: 'Follow-up date must be YYYY-MM-DD.' };
        const dt = new Date(`${fu}T00:00:00Z`);
        if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== fu) return { ok: false, error: 'That follow-up date doesn’t exist.' };
      }
      const clean = (s) => String(s || '').trim().slice(0, 80);
      return { ok: true, normalized: { followUpDate: fu, leadOwner: clean(o.leadOwner), bookedBy: clean(o.bookedBy), paymentReviewedBy: clean(o.paymentReviewedBy) } };
    }
    // Residential address on an EXISTING lead (Gauri 2026-09-04, point 07):
    // the Add-lead form has required it since 2026-09-04, but leads created
    // before that (and any typo) had nowhere to be corrected — the consultation
    // agreement and the retainer print this line.
    case 'saveResidentialAddress': {
      // Keep the LINE BREAKS: the agreement/retainer templates render them
      // (docxtemplater linebreaks:true), so a two-line address printed on two
      // lines must stay that way after a typo fix. Only horizontal runs collapse.
      const addr = String(value == null ? '' : value)
        .replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).slice(0, 4).join('\n');
      if (addr.length < 5) return { ok: false, error: 'Enter the client’s full residential address (street, city, province/state, postal code, country).' };
      if (addr.length > 500) return { ok: false, error: 'Address is too long (max 500 characters).' };
      return { ok: true, normalized: addr };
    }
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
    case 'bookingInvite': {
      // Optional personalized email body — saved to the lead before the send
      // fires. null = no message provided (leave the saved draft untouched,
      // e.g. the consultations-page button); '' = explicitly cleared. Reject
      // non-strings: String({}) would email the client "[object Object]".
      if (value == null) return { ok: true, normalized: null };
      if (typeof value !== 'string') return { ok: false, error: 'Invite message must be text.' };
      const msg = value.trim();
      if (msg.length > 2000) return { ok: false, error: 'Invite message is too long (max 2000 characters).' };
      return { ok: true, normalized: msg };
    }
    // Add-lead group (2026-10-15): where the client is now (sets the consultation HST); the lead owner.
    case 'saveLocation': {
      let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { return { ok: false, error: 'Invalid location.' }; }
      const r = normalizeLeadLocation(o || {});
      return r.ok ? { ok: true, normalized: { insideCanada: r.insideCanada, country: r.country } } : r;
    }
    // Basic details on the lead page (Faran 2026-10-28: "all the basic information should be editable").
    case 'saveBasicInfo': {
      let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { return { ok: false, error: 'Invalid details.' }; }
      if (!o || typeof o !== 'object') return { ok: false, error: 'Invalid details.' };
      const one = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max);
      const fullName = one(o.fullName, 120), email = one(o.email, 200), phone = one(o.phone, 40);
      const sourceChannel = one(o.sourceChannel, 40), caseTypeInterest = one(o.caseTypeInterest, 120);
      if (fullName.length < 2) return { ok: false, error: 'Enter the client’s full name.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email address (the booking invite and reminders go there).' };
      const digits = phone.replace(/\D/g, '');
      if (phone && (!/^[\d\s()+.\-]+$/.test(phone) || digits.length < 7 || digits.length > 15)) return { ok: false, error: 'Enter a valid phone number (7 to 15 digits).' };
      return { ok: true, normalized: { fullName, email, phone, sourceChannel, caseTypeInterest } };
    }
    case 'saveInquiry': {
      const t = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
      if (t.length > 5000) return { ok: false, error: 'The inquiry is too long (max 5000 characters).' };
      return { ok: true, normalized: t };
    }
    case 'saveLeadOwner': {
      const n = String(value == null ? '' : value).trim();
      if (n && !require('../../config/portalStaff').onRoster(n)) return { ok: false, error: 'Choose an owner from the list.' };
      return { ok: true, normalized: n };
    }
    // Gauri point 4 part 2: a consultation fee settled outside the booking link (or waived).
    case 'recordConsultPayment':
      return require('./consultPaymentService').validateRecord(value);
    case 'saveInviteMessage': {
      if (value != null && typeof value !== 'string') return { ok: false, error: 'Invite message must be text.' };
      const msg = String(value == null ? '' : value).trim();
      if (msg.length > 2000) return { ok: false, error: 'Invite message is too long (max 2000 characters).' };
      return { ok: true, normalized: msg };
    }
    case 'setConsultant': {
      // Pre-invite consultant override (Melanie, 2026-08-17): '' clears the pin
      // (back to auto-routing); otherwise the EXACT registry name only.
      const v = String(value == null ? '' : value).trim();
      if (!v) return { ok: true, normalized: '' };
      const names = Object.values(require('../../config/consultantRouting').CONSULTANTS).map((c) => c.name);
      return names.includes(v)
        ? { ok: true, normalized: v }
        : { ok: false, error: 'Unknown consultant — pick one from the list.' };
    }
    case 'sendConsultationPackage': {
      // { again: true } once the package already went out (2026-10-16: automatic sends from
      // recorded payments make a stale page's click likely — the server decides, not the page).
      let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { o = null; }
      return { ok: true, normalized: { again: !!(o && typeof o === 'object' && o.again === true) } };
    }
    case 'resendLinks':
    case 'sendConsultAgreement':
    case 'consultantSignAgreement':
    case 'consultantSignRetainer':
    case 'retainAndSend':
    case 'reissueRetainer':
      return { ok: true, normalized: null };
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

/**
 * Post a staff remark on the lead's Monday row (consultant note #8). NOT
 * best-effort: the remark IS the action, so a failure surfaces to the user.
 * Body: 📝 [Remark · <staff>] <Preset label> — <free text>
 */
async function postRemarkNote(leadId, { presetLabel = '', text = '', staffName = '' } = {}) {
  const head = `📝 <b>[Remark${staffName ? ' · ' + escHtmlNote(staffName) : ''}]</b>`;
  const parts = [];
  if (presetLabel) parts.push(`<b>${escHtmlNote(presetLabel)}</b>`);
  if (text) parts.push(escHtmlNote(text).replace(/\n/g, '<br>'));
  await mondayApi.query(
    `mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }`,
    { id: String(leadId), b: `${head} ${parts.join(' — ')}` }
  );
  // The Leads list's Current status shows it at once (the notes copy reads it within 10 minutes anyway).
  require('./leadStatusService').record(leadId, `📝 [Remark${staffName ? ' · ' + staffName : ''}] ${[presetLabel, text].filter(Boolean).join(' — ')}`);
  _leadsQueueCache.at = 0;
}

/**
 * Email the team when a lead's OUTCOME changes (team feedback 2026-08-13:
 * Kamal was reading the board every morning to see what had been decided).
 * Recipients come from STAFF_OUTCOME_NOTIFY_EMAILS (comma-separated);
 * unset = feature off, exactly like STAFF_SIGNATURE_NOTIFY_EMAILS.
 *
 * Only a REAL change is announced — re-clicking the outcome a lead already has
 * sends nothing. Best-effort: a mail failure never breaks the outcome write
 * (the board column and the audit note are the record; this is a nudge).
 */
async function notifyOutcomeChange({ leadId, lead = {}, from = '', to = '', staffName = '' }) {
  try {
    const before = String(from || '').trim(), after = String(to || '').trim();
    if (!after || before === after) return { sent: false, reason: 'unchanged' };
    const list = String(process.env.STAFF_OUTCOME_NOTIFY_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.length) return { sent: false, reason: 'no-recipients' };

    const esc = (str) => String(str == null ? '' : str).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const base = (process.env.RENDER_URL || 'https://app.tdotimm.com').replace(/\/$/, '');
    const who  = String(staffName || '').trim();
    const name = lead.fullName || lead.name || 'A lead';
    const caseType = lead.confirmedCaseType || lead.caseTypeInterest || '';
    await require('./microsoftMailService').sendEmail({
      to: list,
      subject: `🏁 Outcome: ${after} — ${name}${caseType ? ' (' + caseType + ')' : ''}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:520px">
        <p><b>${esc(name)}</b> — outcome ${before ? 'changed from <b>' + esc(before) + '</b> to ' : 'set to '}<b>${esc(after)}</b>${who ? ' by ' + esc(who) : ''}.</p>
        <p style="margin:4px 0">Case type: <b>${esc(caseType || '—')}</b><br>
        Consultant: ${esc(lead.assignedConsultant || '—')}<br>
        Fee: ${lead.retainerFee ? '$' + esc(lead.retainerFee) : 'not set'}</p>
        <p><a href="${base}/admin/consultation/${encodeURIComponent(leadId)}">Open the consultation record</a></p>
      </div>`,
    });
    console.log(`[Consultant] outcome notification sent for lead ${leadId}: ${before || '(none)'} → ${after}`);
    return { sent: true, recipients: list.length };
  } catch (err) {
    console.warn(`[Consultant] outcome notification failed for lead ${leadId}: ${err.message}`);
    return { sent: false, reason: 'error', error: err.message };
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
async function applyAction({ leadId, action, value, amend = false, staffName = '', actor = null }) {
  const who = String(staffName || '').trim().slice(0, 60);
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
    case 'outcome': {
      // Who: the Monday sign-in when there is one (verified), else the typed name.
      const byName = (actor && actor.verified && String(actor.name || '').trim()) ? String(actor.name).trim().slice(0, 60) : who;
      const isNotWanted = v.normalized === OUTCOME_NOT_WANTED;

      // Not Wanted (point 5): the person goes on the Not Wanted list BEFORE the
      // outcome is written — the write echoes back through the Lead Board webhook,
      // which then finds this lead on the list instead of adding a second,
      // reason-less row (review 2026-10-15). A failed add never stops the outcome.
      const bl = require('./blacklistService');
      const listActor = { name: byName, verified: !!(actor && actor.verified) };
      let listResult = null, listError = null;
      const tryList = async () => {
        try { listResult = await bl.addFromLead({ lead, reason: v.reason, actor: listActor, source: 'portal' }); listError = null; }
        catch (err) { listError = err; console.warn(`[Consultant] Not Wanted list add failed for lead ${leadId}: ${err.message}`); }
      };
      if (isNotWanted && bl.enabled()) await tryList();

      await leadService.updateLead(leadId, { outcome: v.normalized });
      await postPortalNote(leadId, `Outcome set to “${v.normalized}”${byName ? ` by ${escHtmlNote(byName)}` : ''}${isNotWanted ? ` — reason: ${escHtmlNote(v.reason)}` : ''}.`);
      await module.exports.notifyOutcomeChange({ leadId, lead, from: lead.outcome, to: v.normalized, staffName: byName });
      if (v.normalized === OUTCOME_RETAIN) {
        return { ok: true, message: feeSet
          ? 'Outcome recorded as Retain — the retainer agreement (stating the fee) is being emailed to the client.'
          : 'Outcome recorded as Retain. The agreement states the fee, so it will be emailed automatically once you set the retainer fee below — no agreement goes out without a fee.' };
      }
      if (!isNotWanted) return { ok: true, message: `Outcome recorded: ${v.normalized}.` };

      // A record only — nothing already in flight is cancelled; the note says what is still live so a person decides.
      const extras = [];
      const live = [];
      if (lead.retainerSent && String(lead.retainerSent).trim() && !(lead.retainerSigned && String(lead.retainerSigned).trim())) {
        live.push(`the retainer agreement sent ${String(lead.retainerSent).trim()} is still live — if the client signs it, the case opens. Void it in Documenso if that is not intended.`);
      }
      const slot = String(lead.bookedSlot || '').trim();
      const slotMs = slot ? require('./postConsultService').torontoSlotToUTC(slot) : NaN;
      if (slot && String(lead.bookingStatus || '').trim() === 'Booked' && Number.isFinite(slotMs) && Date.now() < slotMs) {
        live.push(`the consultation booked for ${slot} still stands and its reminders will still go out — cancel it in Square if that is intended.`);
      }
      if (live.length) {
        await postPortalNote(leadId, `⚠ Not Wanted, but ${live.join(' Also, ')}`);
        extras.push(live.length === 1 ? 'Note: something is still live on this lead — see the note.' : 'Note: a retainer and a booking are still live on this lead — see the notes.');
      }
      let listMsg = '';
      if (!bl.enabled()) listMsg = 'The Not Wanted list is not set up on this server, so nobody will be warned if they come back.';
      else {
        // One retry after the write (a passing Monday hiccup); the add is serialised per lead, so it
        // completes — never duplicates — a row the webhook made in the meantime.
        if (listError && !listError.badRequest) await tryList();
        if (listResult) {
          listMsg = listResult.result === 'created' ? 'They are now on the Not Wanted list — staff will be warned if they come back.'
            : listResult.result === 'merged' ? 'They were already on the Not Wanted list — this lead and any new email or phone were added to their entry.'
            : 'They are on the Not Wanted list.';
        } else {
          listMsg = listError && listError.badRequest ? listError.message : 'They could not be added to the Not Wanted list just now — the list is checked every 15 minutes and will pick this lead up.';
          if (!(listError && listError.badRequest)) await postPortalNote(leadId, `⚠ Not added to the Not Wanted list yet (${escHtmlNote(listError ? listError.message : 'unknown error')}) — the 15-minute check will retry.`);
        }
      }
      return { ok: true, message: `Outcome recorded: ${v.normalized}. ${listMsg}${extras.length ? ` ${extras.join(' ')}` : ''}` };
    }

    case 'remark': {
      // Not blocked by the plan lock — a remark records what was done, it edits no terms.
      await postRemarkNote(leadId, { ...v.normalized, staffName: who });
      return { ok: true, message: `Remark posted to the lead's Monday updates${v.normalized.presetLabel ? `: ${v.normalized.presetLabel}` : ''}.` };
    }

    case 'retainerFee':
      await leadService.updateLead(leadId, { retainerFee: v.normalized });
      await postPortalNote(leadId, agreementSent
        ? `⚠ <b>Retainer fee AMENDED after the agreement was sent</b> — now $${v.normalized} CAD. The client may hold an agreement stating a different fee; re-issue it if the change is material.`
        : `Retainer fee set to $${v.normalized} CAD.`);
      return { ok: true, message: agreementSent
        ? `Retainer fee amended to $${v.normalized}. A staff note was recorded — the agreement was NOT re-sent.`
        : `Retainer fee set to $${v.normalized}. The retainer agreement (once Outcome is Retain) and the payment link (once signed) are emailed automatically.` };

    case 'sendMilestoneEtransferRequest': {
      // Not blocked by the plan lock — this collects a payment, it doesn't edit terms.
      const r = await require('./milestonePaymentService').sendMilestoneEtransferRequest(leadId, v.normalized);
      return { ok: true, message: `E-transfer request for ${r.label} emailed to the client (ref ${r.reference}).` };
    }

    case 'markMilestonePaid': {
      // Who recorded it — shown on the row's tooltip and in the note.
      const by = actor || (staffName ? { name: staffName, verified: false } : null);
      const r = await require('./milestonePaymentService').markMilestonePaid(leadId, v.normalized.index, { reference: v.normalized.reference, actor: by, amountCents: v.normalized.amountCents, settle: v.normalized.settle });
      if (r.already) return { ok: true, message: `Already recorded as paid (${r.existingOn}) — nothing changed.` };
      const $ = (c) => (Math.round(c) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
      if (r.settled === false) {
        // Milestone 1: the first part-payment starts the case (team rule 2026-10-13).
        const start = r.caseStart === 'started' ? ' The case has been started on this payment — collect the balance before submission.'
          : r.caseStart === 'held' ? ` The case will start on this payment once the ${(r.missing || []).join(' and ')} ${(r.missing || []).length > 1 ? 'are' : 'is'} in — collect the balance before submission.`
          : r.caseStart === 'no-case' ? ' No case is linked yet — it starts on this payment when the case is opened.'
          : r.caseStart === 'failed' ? ' Starting the case did not finish — check the case’s Payment Status in a few minutes and tell an admin if it is not Paid. Do not record the payment again.'
          : r.caseStart === 'already' ? ' The case has already started — collect the balance before submission.'
          : '';
        return { ok: true, message: `Recorded — ${$(r.amountCents)} toward ${r.label || 'the milestone'} by e-transfer. Paid so far ${$(r.paidCents)} of ${$(r.totalCents)}; balance ${$(r.balanceCents)}. The milestone is not paid until the balance is in.${start}` };
      }
      if (r.settled && r.amountCents === 0) return { ok: true, message: `Recorded — ${r.label || 'milestone'} marked settled: the ${$(r.paidCents)} already on file covers it; no new payment was received.` };
      if (r.settled && r.paidCents > r.amountCents) return { ok: true, message: `Recorded — ${r.label || 'milestone'} marked paid by e-transfer (this ${$(r.amountCents)} settles it; ${$(r.paidCents)} received in total).` };
      return { ok: true, message: `Recorded — ${r.label || 'milestone'} marked paid by e-transfer.` };
    }

    case 'saveAttribution': {
      const n = v.normalized;
      await leadService.updateLead(leadId, { followUpDate: n.followUpDate, leadOwner: n.leadOwner, bookedBy: n.bookedBy, paymentReviewedBy: n.paymentReviewedBy });
      await postPortalNote(leadId, `Attribution saved — owner: ${n.leadOwner || '—'}, booked by: ${n.bookedBy || '—'}, payment reviewed by: ${n.paymentReviewedBy || '—'}, follow-up: ${n.followUpDate || '—'}.`);
      return { ok: true, message: 'Attribution saved.' };
    }

    case 'saveLocation': {
      const n = v.normalized;
      const before = { insideCanada: String(lead.insideCanada || '').trim(), country: String(lead.country || '').trim() };
      if (before.insideCanada === n.insideCanada && before.country === n.country) return { ok: true, message: 'No change.' };
      await leadService.updateLead(leadId, { insideCanada: n.insideCanada, country: n.country });
      const byName = (actor && actor.verified && String(actor.name || '').trim()) ? String(actor.name).trim().slice(0, 60) : who;
      const hst = n.insideCanada === 'Yes' ? 'HST applies to the consultation fee' : 'no HST on the consultation fee';
      // What a client may still pay at the OLD price (review 2026-10-15): a held slot's payment
      // page / invoice, or a hand-booked consultation whose app link was never paid. Said first,
      // always, and kept on the note so whoever sees a later payment knows the location changed.
      const paid = require('./consultPaymentService').paidState(lead).paid;
      const status = String(lead.bookingStatus || '').trim();
      let opt = null; try { opt = JSON.parse(lead.consultOption || ''); } catch (_) { /* none */ }
      const openPage = !paid && (status === 'Slot Held' || status === 'Booked'
        || !!String(lead.squareConsultOrderId || '').trim() || !!(opt && opt.invoiceId));
      const lines = [];
      if (paid) lines.push('The amount already paid does not change; any refund is done in Square.');
      if (openPage) lines.push('A payment page or invoice at the OLD price may still be open and payable — cancel it in Square (or let the hold expire) before re-sending.');
      if (!paid && (lead.bookingInvite || '') === 'Sent' && status !== 'Booked') lines.push('The invite email quoted the old price — use "Send booking invite" to re-send it.');
      await postPortalNote(leadId, `Where the client is now: ${n.insideCanada === 'Yes' ? 'in Canada' : `outside Canada (${escHtmlNote(n.country)})`}${byName ? ` — set by ${escHtmlNote(byName)}` : ''}${before.country ? ` (was: ${escHtmlNote(before.country)})` : ''}. ${hst}.${openPage ? ' ⚠ A payment page or invoice at the old price may still be open.' : ''}`);
      return { ok: true, message: `Saved — ${hst}.${lines.length ? ' ' + lines.join(' ') : ''}` };
    }

    case 'saveBasicInfo': {
      const n = v.normalized;
      const st = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
      const cur = { fullName: st(lead.fullName || lead.name), email: st(lead.email), phone: st(lead.phone), sourceChannel: st(lead.sourceChannel), caseTypeInterest: st(lead.caseTypeInterest) };
      // A phone typed with or without spaces / dashes / the +1 is the same number.
      const digits = (x) => { const d = String(x || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
      const same = (k) => (k === 'phone' ? digits(n.phone) === digits(cur.phone) : n[k] === cur[k]);
      const changed = Object.keys(cur).filter((k) => !same(k));
      if (!changed.length) return { ok: true, message: 'No change.' };
      const refuse = (msg) => { const e = new Error(msg); e.badRequest = true; throw e; };
      if (st(lead.clientMasterItemId) && changed.some((k) => ['fullName', 'email', 'phone'].includes(k))) {
        refuse('This lead already has a case — change the client’s name, email or phone on the case page, so the case and its emails use the right details.');
      }
      // The source: an unchanged value (any label, old ones too) passes; a CHANGE must be one
      // of the list (labels the board already has — a typo would mint a new one).
      if (changed.includes('sourceChannel')) {
        if (cur.sourceChannel === DIRECT_SOURCE) refuse('A direct-retainer client stays "Direct Retainer".');
        if (!BASIC_SOURCES.includes(n.sourceChannel)) refuse('Choose how they reached us from the list.');
      }
      if (changed.includes('caseTypeInterest') && n.caseTypeInterest) {
        const canon = await directCaseTypeLabels();
        if (!canon.caseTypes.includes(n.caseTypeInterest)) refuse(`"${n.caseTypeInterest}" is not a case type from the list.`);
      }
      const fields = {}, clear = [];
      for (const k of changed) { if (n[k]) fields[k] = n[k]; else clear.push(k); }
      // The row name first: the Full Name column is what the next read compares against, so a
      // rename that failed after the column was written could never be retried.
      if (changed.includes('fullName')) await leadService.renameLead(leadId, n.fullName);
      await leadService.updateLead(leadId, fields, { clearKeys: clear });
      // The unsigned consultation-agreement review copy prints the name and email — rebuild it.
      try { consultAgreementService.evictCache(leadId); } catch (_) { /* best-effort */ }
      _leadsQueueCache.at = 0;

      const LABEL = { fullName: 'Name', email: 'Email', phone: 'Phone', sourceChannel: 'How they reached us', caseTypeInterest: 'Case type interest' };
      const show = (x) => (x ? `“${escHtmlNote(x)}”` : '(empty)');
      const byName = (actor && actor.verified && String(actor.name || '').trim()) ? String(actor.name).trim().slice(0, 60) : who;
      const warn = [];
      if (changed.includes('email') && st(lead.bookingInvite) === 'Sent' && st(lead.bookingStatus) !== 'Booked') {
        warn.push('The booking invite went to the old email address — send it again so the client gets it (the reminders only go to an address an invite went to).');
      }
      if ((changed.includes('fullName') || changed.includes('email')) && (st(lead.consultAgreementSent) || st(lead.retainerSent))) {
        warn.push('An agreement already sent keeps the old details.');
      }
      if (changed.includes('email') || changed.includes('phone')) {
        const probe = { email: changed.includes('email') ? n.email : '', phone: changed.includes('phone') ? n.phone : '' };
        const m = await module.exports.findClientMatches(probe).catch(() => null);
        const others = m ? [...(m.leads || []).filter((x) => String(x.id) !== String(leadId)).map((x) => `lead ${x.id}`), ...(m.cases || []).map((x) => `case ${x.caseRef || x.id}`)] : [];
        if (others.length) warn.push(`This ${probe.email && probe.phone ? 'email or phone' : probe.email ? 'email' : 'phone'} is also on ${others.slice(0, 5).join(', ')}${others.length > 5 ? '…' : ''}.`);
        const bl = await require('./blacklistService').check(probe).catch(() => null);
        if (bl && bl.hit) warn.push('This person is on the Not Wanted list.');
      }
      await postPortalNote(leadId, `Basic details changed${byName ? ` by ${escHtmlNote(byName)}` : ''}: `
        + changed.map((k) => `${LABEL[k]} ${show(n[k])} (was ${show(cur[k])})`).join('; ') + '.'
        + (warn.length ? ` ${warn.map(escHtmlNote).join(' ')}` : ''));
      return { ok: true, message: `Saved: ${changed.map((k) => LABEL[k].toLowerCase()).join(', ')}.${warn.length ? ` ${warn.join(' ')}` : ''}`, warnings: warn };
    }

    case 'saveInquiry': {
      const before = String(lead.situationDescription || '').trim();
      if (before === v.normalized) return { ok: true, message: 'No change.' };
      await leadService.updateLead(leadId, { situationDescription: v.normalized }, { clearKeys: v.normalized ? [] : ['situationDescription'] });
      _leadsQueueCache.at = 0;
      const byName = (actor && actor.verified && String(actor.name || '').trim()) ? String(actor.name).trim().slice(0, 60) : who;
      const cut = (x) => escHtmlNote(x.length > 400 ? `${x.slice(0, 399)}…` : x);
      await postPortalNote(leadId, `Inquiry ${before ? 'edited' : 'added'}${byName ? ` by ${escHtmlNote(byName)}` : ''}.${before ? ` It was: “${cut(before)}”` : ''}`);
      return { ok: true, message: 'Inquiry saved.' };
    }

    case 'saveLeadOwner': {
      const before = String(lead.leadOwner || '').trim();
      if (before === v.normalized) return { ok: true, message: 'No change.', leadOwner: before };
      await leadService.updateLead(leadId, { leadOwner: v.normalized }, { clearKeys: v.normalized ? [] : ['leadOwner'] });
      const byName = (actor && actor.verified && String(actor.name || '').trim()) ? String(actor.name).trim().slice(0, 60) : who;
      await postPortalNote(leadId, `Lead owner ${v.normalized ? `set to ${escHtmlNote(v.normalized)}` : 'cleared'}${before ? ` (was ${escHtmlNote(before)})` : ''}${byName ? ` by ${escHtmlNote(byName)}` : ''}.`);
      return { ok: true, message: v.normalized ? `Lead owner: ${v.normalized}.` : 'Lead owner cleared.', leadOwner: v.normalized };
    }

    // Gauri point 4 part 2 (2026-10-15): the fee was paid by cash / e-transfer / an
    // invoice the team sent / another way, or waived — a RECORD on the lead, so the
    // Consultations list and the KPIs count it. A fee paid through the booking link
    // is recorded by the app itself and cannot be overwritten here.
    //
    // 2026-10-16 (Gauri 2026-10-08, Faran's four choices): with CONSULT_PACKAGE_ON_RECORD
    // on, the record also carries the consultation package choice — a paid kind sends
    // it (or "No — the client already has them", with a reason), waived asks yes / no —
    // and, for a client booked by hand, the booking itself (time, consultant, in person
    // / video / phone, length), which is written to the lead so the package and the
    // agreement can state it. Video creates the Teams meeting the way online bookings
    // do. The package goes through the ONE automatic path (trigger 'recorded'), with
    // every once-only guard it already has. Switch off = exactly the old record.
    case 'recordConsultPayment':
      // One save at a time per lead, each from a FRESH read: a re-save after the page
      // gave up waiting (or two staff at once) must not create a second Teams meeting
      // or act on a stale record (review 2026-10-16).
      return withRecordLock(leadId, () => recordConsultPaymentAction({ leadId, n: v.normalized, who, actor }));

    case 'saveResidentialAddress': {
      const before = String(lead.residentialAddress || '').trim();
      await leadService.updateLead(leadId, { residentialAddress: v.normalized });
      // The unsigned consultation-agreement REVIEW copy is a cache of the lead's
      // data — drop it so the client's review link shows the corrected address.
      // A retainer already sent and any SIGNED copy are documents of record and keep the old one.
      try { consultAgreementService.evictCache(leadId); } catch (_) { /* best-effort */ }
      const line = (s) => escHtmlNote(String(s || '').replace(/\n/g, ', '));
      await postPortalNote(leadId, `Residential address ${before ? 'corrected' : 'added'}${who ? ` by ${escHtmlNote(who)}` : ''}: ${line(v.normalized)}${before ? ` (was: ${line(before)})` : ''}. The consultation agreement and retainer print this line; a retainer already sent and any signed copy keep the old address.`);
      // A package HELD for a blank address (point 08) is released by this very
      // action. autoSend sends only when the hold marker is present — so an
      // address edit on any other lead sends nothing — and gets the new address
      // handed over, since a re-read may not show it yet.
      let released = null;
      if (consultAgreementService.parseCountersign(lead).packageHeld) {
        released = await require('./consultationService')
          .autoSendConsultationPackage(leadId, { trigger: 'address', overrides: { residentialAddress: v.normalized } })
          .catch((err) => ({ status: 'failed', reason: err.message }));
      }
      const message = released && released.status === 'sent'
        ? 'Residential address saved — the consultation package has been emailed to the client.'
        : released && released.status === 'failed'
        ? `Residential address saved, but the held consultation package could not be sent (${released.reason || 'unknown error'}) — use "Review & send".`
        : released && released.status === 'disabled'
        ? 'Residential address saved. Automatic sending is switched off — the held consultation package still needs "Review & send".'
        : released && released.status === 'expired'
        ? 'Residential address saved. The consultation date has already passed, so the held package was not sent — use "Review & send" if it is still needed.'
        : released && released.retired
        ? `Residential address saved. The consultation package that was waiting for it was NOT sent — ${require('./consultationService').RETIRE_WHY[released.reason] || released.reason} (see the note).`
        : 'Residential address saved.';
      return { ok: true, message, residentialAddress: v.normalized, ...(released ? { packageReleased: released.status } : {}) };
    }

    // ONE-CLICK retain: set Outcome=Retain and email the agreement synchronously,
    // reporting the real result (sent / held / missing) instead of relying on the
    // background column-change webhook. The UI gates this button until fee + plan.
    case 'retainAndSend': {
      if (agreementSent) { const e = new Error('The retainer agreement has already been sent to this client.'); e.badRequest = true; e.locked = true; throw e; }
      // Never send a fresh agreement to a client who has already SIGNED / been
      // RETAINED — even if retainerSent was never stamped (manual signing, a
      // failed stamp, or a legacy path). The UI locks the button on this too, but
      // this is the authoritative guard. retainerPaid alone does NOT block:
      // direct/walk-in clients often prepay their first milestone by e-transfer
      // BEFORE the agreement goes out — the send must still happen.
      const alreadyRetained = !!(lead.retainerSigned && String(lead.retainerSigned).trim())
        || String(lead.conversionStatus || '').trim() === 'Retained';
      if (alreadyRetained) {
        const e = new Error('This client has already been retained (signed) — a new retainer agreement should not be sent. Use “Amend” to record a change instead.');
        e.badRequest = true; e.locked = true; throw e;
      }
      if (!feeSet) { const e = new Error('Set the retainer fee before sending the agreement.'); e.badRequest = true; throw e; }
      {
        // A variant case type MUST carry a sub-type before the retainer goes out —
        // a blank one blocks the document checklist at case-open (the direct-client
        // form enforces the same rule at creation). Legacy non-canonical case
        // types pass — their variants are unknown.
        const canon = await directCaseTypeLabels();
        const ct = (lead.confirmedCaseType || lead.caseTypeInterest || '').trim();
        const subs = canon.caseTypes.includes(ct) ? (canon.subTypesByCase[ct] || []) : [];
        if (subs.length && !String(lead.selectedSubType || '').trim()) {
          const e = new Error(`"${ct}" needs a Sub-type before sending — pick one in the retainer plan (it selects the document checklist).`);
          e.badRequest = true; throw e;
        }
      }
      await leadService.updateLead(leadId, { outcome: 'Retain' });
      await module.exports.notifyOutcomeChange({ leadId, lead, from: lead.outcome, to: 'Retain', staffName: who });
      const r = (await require('./retainerService2').maybeSendRetainerAgreement(leadId, { notifyIfMissing: true })) || {};
      await postPortalNote(leadId, r.status === 'sent'
        ? 'Outcome set to “Retain” — retainer agreement emailed to the client.'
        : `“Retain & send” attempted, agreement NOT sent (${r.status}).`);
      switch (r.status) {
        case 'sent':     return { ok: true, message: '✓ Retainer agreement emailed to the client.' };
        case 'held':     return { ok: true, message: `Not sent — the retainer plan isn’t complete: ${(r.warnings || []).join(' · ')}. Fix these, save, and click again.` };
        case 'no-email': return { ok: true, message: 'Not sent — no client email on file. Add the client’s email, then click again.' };
        case 'no-fee':   return { ok: true, message: 'Not sent — set the retainer fee first.' };
        case 'held-cosigner':
          // This agreement is signed by the PA AND the inviter/sponsor/
          // dependent — the send is held until both signers are addressable.
          return { ok: true, message: `Not sent — ${r.reason || 'the Inviter/Sponsor/Dependent signer details are incomplete'} ` +
            'Fix them in the retainer panel, save, and click again — the agreement goes to both signers at once.' };
        case 'failed':   return { ok: true, message: `Not sent — generation/email failed (${r.reason || 'unknown'}). It will retry; check the note on the lead.` };
        default:         return { ok: true, message: 'Outcome set to Retain — the agreement will be emailed shortly.' };
      }
    }

    case 'retainerSigned': {
      // Precondition: signing implies the consultation was retained. Without
      // this, a mis-click on an un-retained lead would still flow through to
      // handoffService and create a spurious Client Master case.
      if (lead.outcome !== 'Retain') {
        const e = new Error('Set the outcome to “Retain” before marking the retainer signed.');
        e.badRequest = true; throw e;
      }
      // Idempotent on a DONE deal: once the case is open (handoff succeeded) or the
      // client is retained, a re-click must NOT re-write the date — that re-fires the
      // signed→handoff→payment-link chain on a completed retention. But a signed lead
      // whose handoff FAILED (retainerSigned stamped, no case yet) must still be
      // re-markable so staff can retry per the failed-handoff recovery note.
      const alreadySigned = !!(lead.retainerSigned && String(lead.retainerSigned).trim());
      const caseOpen      = !!(lead.clientMasterItemId && String(lead.clientMasterItemId).trim());
      const isRetained    = String(lead.conversionStatus || '').trim() === 'Retained';
      if (alreadySigned && (caseOpen || isRetained)) {
        return { ok: true, message: `The retainer was already marked signed on ${lead.retainerSigned} and the case is open — no change.` };
      }
      await leadService.updateLead(leadId, { retainerSigned: v.normalized });
      await postPortalNote(leadId, `Retainer marked signed (${v.normalized}).`);
      return { ok: true, message: 'Retainer marked signed — the case is being created and the payment link emailed to the client.' };
    }

    case 'bookingInvite':
      // Fail fast on states where sendBookingInvite would silently skip — the
      // portal must never report "being emailed" for a send that cannot happen.
      if ((lead.bookingStatus || '').trim() === 'Booked') {
        const e = new Error('This lead has already booked a consultation — no booking invite is needed.');
        e.badRequest = true; throw e;
      }
      if (!String(lead.email || '').trim()) {
        const e = new Error('No client email on file — add an email address to the lead before sending the invite.');
        e.badRequest = true; throw e;
      }
      // Persist the personalized body FIRST, so the webhook-fired email (which
      // re-reads the lead) picks it up. null = no message in the request (the
      // consultations-page button) — leave any saved draft untouched; '' =
      // explicitly cleared — clearKeys forces the empty write through (updateLead
      // otherwise skips empties), so the email falls back to its standard intro.
      if (v.normalized != null) {
        await leadService.updateLead(leadId, { inviteMessage: v.normalized }, { clearKeys: ['inviteMessage'] });
      }
      await leadService.updateLead(leadId, { bookingInvite: 'Send' });
      _leadsQueueCache.at = 0;   // the queue's Invite pill should reflect this promptly
      // The actual email fires async via the Monday webhook and can fail — this
      // note records the TRIGGER only; sendBookingInvite posts the definitive
      // "emailed" / "FAILED" note when the send resolves.
      await postPortalNote(leadId, v.normalized
        ? 'Booking invite triggered from the portal with a personalized message — send in progress.'
        : 'Booking invite triggered from the portal — send in progress.');
      return { ok: true, message: 'The booking invite is being emailed to the client.' };

    case 'saveInviteMessage':
      // An explicitly cleared draft persists as the '[cleared]' sentinel — an
      // EMPTY column is indistinguishable from never-drafted, so the AI
      // auto-draft would silently regenerate (and re-persist) text staff just
      // deleted. Hydration maps the sentinel back to '' and sendBookingInvite
      // treats it as "use the standard intro".
      await leadService.updateLead(leadId, { inviteMessage: v.normalized || '[cleared]' });
      return { ok: true, message: '✓ Invite message saved.' };

    case 'resendLinks':
      await require('./consultationService').resendConsultationLinks(leadId);
      await postPortalNote(leadId, 'Meeting + pre-consultation links re-sent to the client.');
      return { ok: true, message: 'The meeting and pre-consultation links have been re-sent to the client.' };

    case 'sendConsultAgreement': {
      const r = await require('./consultAgreementService').sendConsultAgreement(leadId);
      if (r.alreadySigned) {
        return { ok: true, message: 'The consultation agreement is already signed — nothing was re-sent.', url: r.url };
      }
      const viaEsign = r.via === 'documenso';
      await postPortalNote(leadId, viaEsign
        ? 'Initial consultation agreement sent for e-signature (Documenso) — signing auto-records on this lead.'
        : 'Initial consultation agreement emailed to the client.');
      return { ok: true, message: viaEsign
        ? 'The consultation agreement has been sent for e-signature — signing records automatically.'
        : 'The initial consultation agreement has been emailed to the client.', url: r.url };
    }

    case 'sendConsultationPackage': {
      const again = !!(v.normalized && v.normalized.again);
      if (require('./consultationService').packageAlreadySent(lead) && !again) {
        const e = new Error(`This client already received the consultation package${String(lead.consultAgreementSent || '').trim() ? ` on ${String(lead.consultAgreementSent).trim()}` : ' (a signing request was already issued)'}. Reload the page — the button then asks whether to send it AGAIN.`);
        e.badRequest = true; throw e;
      }
      // A "Record payment" save still writing the booking / meeting goes first; then the
      // gate re-checks from a fresh read (an automatic send may be finishing right now).
      const r = await require('./consultationService').sendConsultationPackage(leadId, { again });
      const viaEsign = r.via === 'documenso';
      await postPortalNote(leadId, r.alreadySigned
        ? 'Consultation package re-sent to the client (booking details + pre-consult form + the complete-before-your-consultation note). The consultation agreement is ALREADY SIGNED — no signature was requested; the email includes their signed-copy link.'
        : viaEsign
        ? 'Consultation package emailed to the client (booking details + pre-consult form + agreement + the complete-before-your-consultation note) — the agreement also went out for e-signature (Documenso); signing auto-records on this lead.'
        : 'Consultation package emailed to the client (booking details + pre-consult form + agreement + the complete-before-your-consultation note).');
      const base = r.alreadySigned
        ? 'The consultation email has been re-sent. The agreement is already signed, so no new signature was requested.'
        : viaEsign
        ? 'The consolidated consultation email has been sent — the agreement also went out for e-signature, so signing records automatically.'
        : 'The consolidated consultation email (details, pre-consult form & agreement) has been sent to the client.';
      // Delivered, but Monday refused the record: say so, or the page keeps
      // reading "not sent" and someone sends it again.
      const message = r.stampFailed
        ? `${base} HOWEVER the Sent date could not be saved in Monday (${r.stampFailed}) — please set "Consult Agreement Sent" to today by hand. Do not re-send.`
        : base;
      return { ok: true, message, url: r.url, ...(r.stampFailed ? { stampFailed: r.stampFailed } : {}) };
    }

    case 'consultantSignAgreement': {
      const r = await consultAgreementService.startConsultCountersign(leadId);
      if (r.alreadySigned) {
        return { ok: true, message: 'The consultant has already countersigned this agreement — nothing to do.' };
      }
      if (!r.resumed) {
        await postPortalNote(leadId, 'RCIC countersign envelope issued (Documenso) over the client-signed consultation agreement — completion auto-records and emails the client their fully signed copy.');
      }
      return { ok: true, signUrl: r.signUrl || '', message: r.signUrl
        ? (r.resumed ? 'The countersign envelope was already out — opening the signing page.' : 'Countersign envelope issued — opening the signing page.')
        : (r.resumed ? 'The countersign envelope is already out — the signing link is in the consultant\'s email (Documenso).' : 'Countersign envelope issued — the signing link has been emailed to the consultant (Documenso).') };
    }

    case 'consultantSignRetainer': {
      const r = await require('./retainerCountersignService').startRetainerCountersign(leadId);
      if (r.alreadySigned) {
        return { ok: true, message: 'The consultant has already countersigned this retainer — nothing to do.' };
      }
      if (!r.resumed) {
        await postPortalNote(leadId, 'RCIC countersign envelope issued (Documenso) over the client-signed retainer agreement — completion auto-records and emails the client their fully signed copy.');
      }
      return { ok: true, signUrl: r.signUrl || '', message: r.signUrl
        ? (r.resumed ? 'The countersign envelope was already out — opening the signing page.' : 'Countersign envelope issued — opening the signing page.')
        : (r.resumed ? 'The countersign envelope is already out — the signing link is in the consultant\'s email (Documenso).' : 'Countersign envelope issued — the signing link has been emailed to the consultant (Documenso).') };
    }

    case 'saveRetainerSelections': {
      const s = v.normalized;
      // Canonical case-type / sub-type enforcement: the SAME vocabulary must flow
      // retainer panel → lead → Client Master → checklist/questionnaire seeding
      // (a free-typed sub-type silently matches no checklist variant). The canon
      // is the live Client Master registry with config fallback — the same source
      // the direct-client form and the pickers' options endpoint use.
      // ABSENT ≠ blank: the panel omits these fields when its options never
      // loaded (or a legacy value is displayed) — an omitted field must leave the
      // stored value untouched, never clear it.
      const subTypeProvided = s.subType != null;
      const canon = await directCaseTypeLabels();
      if (s.caseType && !canon.caseTypes.includes(s.caseType)) {
        const e = new Error(`"${s.caseType}" is not a canonical case type — pick one from the list.`);
        e.badRequest = true; throw e;
      }
      // `lead` is already in scope (loaded at the top of applyAction) — the
      // validation input must never come from a second read that can fail.
      const effectiveCaseType = (s.caseType || lead.confirmedCaseType || lead.caseTypeInterest || '').trim();
      // Legacy leads can carry a case type that predates the canon — their
      // stored sub-type passes through untouched until staff confirm a
      // canonical case type; only canonical types get strict sub-type rules.
      const knownCase = canon.caseTypes.includes(effectiveCaseType);
      const subs = canon.subTypesByCase[effectiveCaseType] || [];
      if (subTypeProvided && s.subType && knownCase && subs.length && !subs.includes(s.subType)) {
        const e = new Error(`"${s.subType}" is not a known sub-type of ${effectiveCaseType} — pick one from the list.`);
        e.badRequest = true; throw e;
      }
      if (subTypeProvided && knownCase && !subs.length) s.subType = ''; // no variants — nothing to store
      // Writes ONLY inert columns — NOT retainerFee/outcome/retainerSigned, so
      // saving the plan never re-fires the retainer-agreement / payment
      // automations (confirmedCaseType has no webhook consumers — verified).
      // clearKeys = the fields a consultant may blank/deselect, so clearing them in
      // the UI actually erases the stored value instead of leaving it stale.
      await leadService.updateLead(leadId, {
        ...(s.caseType ? { confirmedCaseType: s.caseType } : {}),
        selectedTemplate:   s.template,
        selectedScopeAnnex: s.annexCode,
        ...(subTypeProvided ? { selectedSubType: s.subType || '' } : {}),
        govFee:             (s.govFeeDollars != null) ? s.govFeeDollars : '',
        advertisementFee:   (s.adFeeDollars != null && s.adFeeDollars > 0) ? s.adFeeDollars : '',
        retainerHstRate:    (s.hstRate != null) ? String(s.hstRate) : '13',
        retainerWithRprf:   s.withRprf ? 'Yes' : 'No',
        retainerMilestones: JSON.stringify(s.milestones || []),
        retainerFamilyMembers: JSON.stringify(s.familyMembers || []),
        inviterName: s.inviterName || '', inviterAddress: s.inviterAddress || '', inviterPhone: s.inviterPhone || '', inviterEmail: s.inviterEmail || '',
        empRepName: s.empRepName || '', empCompanyName: s.empCompanyName || '', empCompanyAddress: s.empCompanyAddress || '',
        empCompanyPhone: s.empCompanyPhone || '', empRepPhone: s.empRepPhone || '', empRepEmail: s.empRepEmail || '',
      }, { clearKeys: [
        ...(subTypeProvided ? ['selectedSubType'] : []),
        'govFee', 'advertisementFee',
        'inviterName', 'inviterAddress', 'inviterPhone', 'inviterEmail',
        'empRepName', 'empCompanyName', 'empCompanyAddress', 'empCompanyPhone', 'empRepPhone', 'empRepEmail',
      ] });
      await postPortalNote(leadId, agreementSent
        ? `⚠ <b>Retainer plan AMENDED after the agreement was sent</b> — template ${s.template}, scope annex ${s.annexCode}, fee $${centsToMoney(s.feeCents)}. The sent agreement may state different terms.`
        : `Retainer plan saved — template ${s.template}, scope annex ${s.annexCode}, fee $${centsToMoney(s.feeCents)}.`);
      return { ok: true, message: agreementSent ? 'Retainer plan amended — a staff note was recorded.' : 'Retainer plan saved.' };
    }

    case 'setConsultant': {
      // The booking page reads the pin live (resolveConsultant) — but once a
      // slot is BOOKED the consultation sits on a real calendar; changing the
      // pin then would only make the record lie.
      if ((lead.bookedSlot || '').trim() || (lead.bookingStatus || '').trim() === 'Booked') {
        const e = new Error('Already booked — the consultation is on the assigned consultant\'s calendar. Cancel/rebook to change it.');
        e.badRequest = true; throw e;
      }
      await leadService.updateLead(leadId, { assignedConsultant: v.normalized }, { clearKeys: ['assignedConsultant'] });
      await postPortalNote(leadId, v.normalized
        ? `Consultant set to ${v.normalized} — the booking link will offer their calendar and fees.`
        : 'Consultant selection cleared — automatic routing applies again.');
      return { ok: true, message: v.normalized ? `✓ Consultation will be with ${v.normalized}.` : '✓ Back to automatic routing.' };
    }

    case 'reissueRetainer': {
      // Void the UN-SIGNED envelope and send a fresh agreement with the
      // CURRENT plan — the designed recovery for a typo'd signer email, a
      // renegotiated fee, or any post-send modification (meeting 2026-08-13).
      if (!agreementSent) {
        const e = new Error('Nothing to re-issue — no agreement has been sent. Use “Retain & send agreement”.');
        e.badRequest = true; throw e;
      }
      const r = (await require('./retainerService2').voidAndReissueRetainer(leadId)) || {};
      if (r.status === 'not-retain' && !r.reissued) {
        const e = new Error(`Nothing was voided — the outcome is ${r.outcome ? `“${r.outcome}”` : 'not set'}, and a fresh agreement goes out only for “Retain”. If the client is being retained, set the Outcome to Retain on the Lead Board in Monday (no new agreement is sent — one is already on record), then re-issue.`);
        e.badRequest = true; throw e;
      }
      switch (r.status) {
        case 'sent':
          await postPortalNote(leadId, '🔄 Retainer agreement re-issued — the old envelope was voided and a fresh agreement emailed.');
          return { ok: true, message: `✓ Old agreement voided${r.oldEnvelopeActive ? ' (Documenso could not cancel the old links — tell the signers to use the NEW email only)' : ''} — fresh agreement emailed with the current details.` };
        case 'already-signed': {
          const e = new Error('The client has already signed — a signed agreement cannot be voided from here. Record changes with “Amend”.');
          e.badRequest = true; e.locked = true; throw e;
        }
        case 'not-sent': {
          const e = new Error('Nothing to re-issue — no agreement is on record as sent.');
          e.badRequest = true; throw e;
        }
        case 'coalesced':
          return { ok: true, message: 'A re-issue is already running for this client — give it a moment, then refresh.' };
        case 'held':
          return { ok: true, message: `Old agreement voided, but the new one is HELD — the plan isn’t complete: ${(r.warnings || []).join(' · ')}. Fix these, save, and click “Retain & send agreement”.` };
        case 'held-cosigner':
          return { ok: true, message: `Old agreement voided, but the new one is HELD — ${r.reason || 'the co-signer details are incomplete'}. Fix them, save, and click “Retain & send agreement”.` };
        case 'no-email':
          return { ok: true, message: 'Old agreement voided, but the new one was NOT sent — no client email on file. Add it, then click “Retain & send agreement”.' };
        default:
          return { ok: true, message: `Old agreement voided; the new send reported "${r.status || 'unknown'}${r.reason ? ` — ${r.reason}` : ''}". Check the note on the lead, then use “Retain & send agreement” if needed.` };
      }
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
  const { caseStage, caseRef } = await readCaseCells(lead.clientMasterItemId);
  return buildRetainerPlanResponse(lead, { currentCaseStage: caseStage, caseRef });
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

/**
 * The SIGNED consultation agreement PDF (client-signed; fully signed once the
 * RCIC countersigns — the newest state wins).
 * @throws {Error} .notFound on missing lead / no signed copy retrievable
 */
async function getSignedConsultAgreementPdf(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }
  const buffer = await require('./consultAgreementService').getSignedConsultPdf(lead);
  if (!buffer) { const e = new Error('No signed copy is available yet — the signed PDF could not be retrieved from OneDrive or Documenso.'); e.notFound = true; throw e; }
  return { buffer, filename: `consult-agreement-SIGNED-${leadId}.pdf` };
}

/** The SIGNED retainer PDF (client-signed; fully signed once the RCIC countersigns). */
async function getSignedRetainerAgreementPdf(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Lead not found'); e.notFound = true; throw e; }
  const buffer = await require('./retainerCountersignService').getSignedRetainerPdf(lead);
  if (!buffer) { const e = new Error('No signed copy is available yet — the signed PDF could not be retrieved from OneDrive or Documenso.'); e.notFound = true; throw e; }
  return { buffer, filename: `retainer-agreement-SIGNED-${leadId}.pdf` };
}

// ─── Direct retainer client (walk-in / referral — no booking, no consultation) ─
//
// The retainer chain has no booking/consultation gate, but a hand-made lead
// misses everything the intake pipeline wires up. This creates a FULLY-wired
// lead in one step: token + OneDrive folder (createLead), pinned consultant
// (agreement signatory + "Retained by"/RBAC), confirmed case type (handoff
// auto-resolves it → case ref + checklist seed at first payment instead of
// silently no-opping), and the "Direct Retainer" source tag that keeps the KPI
// funnel honest and stops the retainer send stamping a false "Consulted".

const DIRECT_SOURCE = 'Direct Retainer';

// ─── Staff-entered lead (phone-in — meeting 2026-08-13 "direct leads") ────────
//
// A caller Melanie takes down by hand becomes a NORMAL funnel lead with the
// full intake wiring createLead provides (access token + OneDrive folder) but
// NO case, NO consultant pin, NO retainer intent — the regular booking-invite
// and pre-consultation machinery takes over from the lead's detail page.
// Source options are the EXISTING board labels only (no label minting).
const STAFF_LEAD_SOURCES = ['Phone', 'Email', 'WhatsApp', 'Instagram', 'Other'];
// "How they reached us" choices on the lead page (labels the board already has).
const BASIC_SOURCES = ['Website', ...STAFF_LEAD_SOURCES];

/**
 * Where the client is now (Add-lead group, 2026-10-15): it decides the HST on
 * the consultation fee (no HST for a non-blank, non-Canada country). Stored the
 * same way as the public intake form: Yes → country 'Canada'; No → a country
 * from the list. Used by Add lead and the lead page.
 * @returns {{ok:true, insideCanada:'Yes'|'No', country:string} | {ok:false, error:string}}
 */
function normalizeLeadLocation({ inCanada, country } = {}) {
  const yn = String(inCanada == null ? '' : inCanada).trim();
  if (yn !== 'Yes' && yn !== 'No') return { ok: false, error: 'Answer "In Canada now?" — it decides whether HST is charged on the consultation fee. (Reload the page if you don\u2019t see the question.)' };
  if (yn === 'Yes') return { ok: true, insideCanada: 'Yes', country: 'Canada' };
  const c = String(country == null ? '' : country).trim();
  if (!require('../../config/countries').isListedCountry(c)) return { ok: false, error: 'Choose the country the client is in now from the list.' };
  return { ok: true, insideCanada: 'No', country: c };
}

async function createStaffLead(payload = {}, { actor = null } = {}) {
  const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
  const fullName         = clean(payload.fullName, 120);
  const email            = clean(payload.email, 200);
  const phone            = clean(payload.phone, 40);
  const sourceRaw        = clean(payload.sourceChannel, 30);
  const sourceChannel    = STAFF_LEAD_SOURCES.includes(sourceRaw) ? sourceRaw : 'Phone';
  const caseTypeInterest = clean(payload.caseTypeInterest, 100);
  const note             = clean(payload.note, 2000);
  const address          = clean(payload.residentialAddress, 500);
  const allowDuplicate   = payload.allowDuplicate === true;

  const bad = (m) => { const e = new Error(m); e.badRequest = true; throw e; };
  if (!fullName) bad('Full name is required.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('A valid email is required.');
  if (!phone || phone.replace(/\D/g, '').length < 7) bad('A valid phone number is required.');
  // Required (staff request 2026-09-04): the retainer agreement prints it, the
  // questionnaire pre-fills from it, and chasing it later costs a call back.
  if (!address) bad('A residential address is required.');
  if (caseTypeInterest) {
    const canon = await directCaseTypeLabels();
    if (!canon.caseTypes.includes(caseTypeInterest)) bad(`"${caseTypeInterest}" is not a canonical case type — pick one from the list.`);
  }
  // Where the client is now — it sets the HST on the consultation fee (Melanie's
  // rule, 2026-08-24). Asked before any duplicate / Not Wanted stop, so a missing
  // answer is the first thing staff see.
  const loc = normalizeLeadLocation({ inCanada: payload.inCanada, country: payload.currentCountry });
  if (!loc.ok) bad(loc.error);
  // Who added it → the Lead Owner (Faran 2026-10-15): the Monday sign-in when
  // there is one (matched to the roster name), else the name picked in the form.
  const roster = require('../../config/portalStaff');
  const signedIn = !!(actor && actor.verified && String(actor.name || '').trim());
  const addedBy = signedIn ? roster.rosterNameFor(actor.name) : clean(payload.addedBy, 60);
  if (!signedIn && !roster.onRoster(addedBy)) bad('Choose your name in "Added by" (or sign in with Monday and it is filled in for you).');

  // The Not Wanted list (point 5): checked on EVERY submit, including "create
  // anyway" — a warning, never a block. First submit with a hit → 409 so staff
  // see it before the lead exists; the re-submit creates and the lead gets a note.
  const blacklist = await require('./blacklistService').check({ email, phone });

  // Same duplicate contract as the direct-client modal: matches without an
  // explicit staff choice → 409 with the matches payload; "create anyway"
  // re-submits with allowDuplicate.
  if (!allowDuplicate) {
    // Via module.exports — the tests' stub seam for the matcher.
    const matches = await module.exports.findClientMatches({ email, phone }).catch(() => null);
    if ((matches && (matches.leads.length || matches.cases.length || matches.clients.length)) || blacklist.hit) {
      const e = new Error(blacklist.hit ? 'This person is on the Not Wanted list.' : 'This email/phone already exists in the system.');
      e.conflict = true; e.matches = matches || { leads: [], cases: [], clients: [] }; e.blacklist = blacklist; throw e;
    }
  }

  const lead = await leadService.createLead({
    fullName, email, phone, sourceChannel,
    residentialAddress: address,   // written AT creation — a mandatory field must never be missing
    country: loc.country,          // text column, AT creation: an invite sent at once already prices the HST right
    leadOwner: addedBy,
    ...(note ? { situationDescription: note } : {}),
  });
  // The interest dropdown's board vocabulary is the intake's coarse label set —
  // canonical labels do NOT exist there and create_item has no label minting,
  // so a canon pick inside createLead would fail the whole creation. Carry it
  // in a follow-up updateLead instead, whose mutation auto-creates labels —
  // the SAME sanctioned path createDirectClient uses for confirmedCaseType.
  // Status / dropdown values follow via updateLead (create_item mints no labels).
  await leadService.updateLead(lead.id, { insideCanada: loc.insideCanada, ...(caseTypeInterest ? { caseTypeInterest } : {}) })
    .catch((err) => console.warn(`[Leads] follow-up write (In Canada / case type) failed for staff lead ${lead.id}: ${err.message} — the lead itself is created`));
  await postPortalNote(lead.id,
    `Lead added by ${escHtmlNote(addedBy)}${signedIn ? ' (signed in with Monday)' : ''} (${sourceChannel.toLowerCase()} intake)${caseTypeInterest ? ` — interested in ${escHtmlNote(caseTypeInterest)}` : ''}. ` +
    `${loc.insideCanada === 'Yes' ? 'In Canada now — HST applies to the consultation fee.' : `Outside Canada now (${escHtmlNote(loc.country)}) — no HST on the consultation fee.`} ` +
    'Next: send the booking invite from this page when they are ready.');
  if (blacklist.hit) await require('./blacklistService').noteOnLead(lead.id, blacklist, 'Staff saw the warning and added this lead anyway.');
  invalidateLeadsQueue(); // the new lead must appear on the next queue load
  return { leadId: String(lead.id), blacklist };
}

/**
 * Case-type labels for the direct-client form + validation. Prefer the LIVE
 * Client Master canon (the same registry the handoff validates against, so a
 * form-accepted type can never be deferred at handoff for label drift); fall
 * back to the static config when the registry is unreachable. Per-case
 * sub-types only exist in the config mapping.
 */
async function directCaseTypeLabels() {
  const cfg = require('../../config/caseTypes');
  try {
    const live = await require('./caseTypeRegistryService').getCaseTypes();
    if (Array.isArray(live) && live.length) {
      const subTypesByCase = {};
      for (const ct of live) subTypesByCase[ct] = cfg.SUB_TYPES_BY_CASE[ct] || [];
      return { caseTypes: live, subTypesByCase };
    }
  } catch (_) { /* registry unreachable — static config below */ }
  return { caseTypes: cfg.CASE_TYPE_LABELS, subTypesByCase: cfg.SUB_TYPES_BY_CASE };
}

async function createDirectClient(payload = {}) {
  const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
  const fullName    = clean(payload.fullName, 120);
  const email       = clean(payload.email, 200);
  const phone       = clean(payload.phone, 40);
  const caseType    = clean(payload.caseType, 100);
  const caseSubType = clean(payload.caseSubType, 120);
  const consultant  = clean(payload.consultant, 80);
  const address     = clean(payload.residentialAddress, 500);
  const referredBy  = clean(payload.referredBy, 200);
  // Warn-and-link choices (duplicate handling) — staff-explicit, from the modal.
  const linkLeadId      = clean(payload.linkLeadId, 30).replace(/\D/g, '');
  const chosenAccountId = clean(payload.clientAccountId, 30).replace(/\D/g, '');
  const allowDuplicate  = payload.allowDuplicate === true;
  // "New application" flow: the previous case this client's profile was
  // carried from (staff-confirmed in the modal). Drives the previousCaseRef
  // stamp + family-roster carry + questionnaire previous-application prefill.
  const profileSourceCaseRef = /^[A-Z0-9-]{4,30}$/i.test(clean(payload.profileSourceCaseRef, 30))
    ? clean(payload.profileSourceCaseRef, 30) : '';

  // Extras shared by BOTH the link path and the create path when a profile
  // source is present. Family carry is best-effort: the roster lands as the
  // retainer panel's editable draft (the consultant confirms it there before
  // anything materializes to the Family Members board at case-ref time).
  const reuseExtras = {};
  if (profileSourceCaseRef) {
    reuseExtras.previousCaseRef = profileSourceCaseRef;
    try {
      const compAdapter = require('./compositionAdapter');
      const ROLE_TO_TYPE = Object.fromEntries(Object.entries(compAdapter._maps.MEMBER_TYPE_TO_ROLE).map(([t, r]) => [r, t]));
      const comp = await compAdapter.readForCase(profileSourceCaseRef);
      const fam = ((comp && comp.members) || [])
        .filter((m) => m.role !== 'PrincipalApplicant')
        .map((m) => ({
          type: ROLE_TO_TYPE[m.role] || '',
          name: m.name || '',
          dateOfBirth: m.dateOfBirth || '',
          currentStatus: m.currentStatus || '',
          countryOfResidence: m.countryOfResidence || '',
          accompanying: (ROLE_TO_TYPE[m.role] || '') !== 'Sponsor', // sponsors are in Canada already
        }))
        .filter((m) => FAMILY_MEMBER_TYPES.includes(m.type));
      if (fam.length) reuseExtras.retainerFamilyMembers = JSON.stringify(fam);
    } catch (err) {
      console.warn(`[Consultant] family carry from ${profileSourceCaseRef} failed: ${err.message}`);
    }
  }

  const bad = (m) => { const e = new Error(m); e.badRequest = true; throw e; };
  if (fullName.length < 2) bad('The client’s full legal name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('A valid client email is required — the retainer agreement is sent to it.');
  if (address.length < 5) bad('The client’s residential address is required — it is printed on the retainer agreement.');
  // Same rule the Client Master write uses (handoffService.phoneColValue), so a
  // phone that passes here is guaranteed to land on the case row.
  if (!require('./handoffService').phoneColValue(phone)) bad('A valid client phone number is required — it goes on the case record and is used to reach the client.');
  const labels = await directCaseTypeLabels();
  if (!labels.caseTypes.includes(caseType)) bad('Choose a case type — it generates the case reference and the document checklist.');
  {
    const subs = labels.subTypesByCase[caseType] || [];
    if (caseSubType) {
      // ANY supplied sub-type must belong to the chosen case type — a case type
      // with no sub-types accepts none.
      if (!subs.includes(caseSubType)) bad('That sub-type does not belong to the chosen case type.');
    } else if (subs.length) {
      // REQUIRED when the case type has variants: a blank sub-type blocks the
      // document checklist (multi-variant seeding is refused — see the
      // 2026-CEC-PR-002 pile-up), so collect it up front.
      bad('This case type has checklist variants — choose the Case Sub Type (it drives the document checklist).');
    }
  }
  const { CONSULTANTS } = require('../../config/consultantRouting');
  const consultantNames = Object.values(CONSULTANTS).map((c) => c.name);
  if (!consultantNames.includes(consultant)) bad('Choose the consultant retaining this client — they sign the agreement and own the case.');

  // The Not Wanted list (point 5): a direct client is RETAINED at creation (the
  // case opens now), so this is the moment to warn. Checked on every path; a
  // warning only. With no explicit choice yet, a hit answers 409 like a duplicate
  // so the modal shows it; link / "create anyway" proceed and the lead gets a note.
  const blacklist = await require('./blacklistService').check({ email, phone });
  const noteBlacklist = (id, context) => blacklist.hit ? require('./blacklistService').noteOnLead(id, blacklist, context) : Promise.resolve(false);
  // The case opens at creation, so the warning must be SEEN first: a hit needs
  // the modal's explicit "I have read the warning" (blacklistAck) on EVERY path —
  // link, convert, create anyway (review 2026-10-15: a pre-fetched duplicate
  // choice used to skip it). One tick, never a block.
  if (blacklist.hit && payload.blacklistAck !== true) {
    const m = await findClientMatches({ email, phone }).catch(() => ({ leads: [], cases: [], clients: [] }));
    const e = new Error('This person is on the Not Wanted list — read the warning and tick the box if you mean to set them up anyway.');
    e.conflict = true; e.matches = m; e.blacklist = blacklist; throw e;
  }

  // Staff explicitly chose to LINK an existing lead (warn-and-link modal):
  // convert that lead into the direct-retainer client instead of minting a new
  // one. Only an un-retained, case-less lead is linkable — anything further
  // along already has a case to work in.
  if (linkLeadId) {
    const existing = await leadService.getLead(String(linkLeadId));
    if (!existing) bad('The lead you chose to link no longer exists — refresh and try again.');
    if (existing.clientMasterItemId || String(existing.conversionStatus || '').trim() === 'Retained') {
      bad('That lead already has an open case — open the case instead of creating a direct client.');
    }
    if (existing.retainerSent && String(existing.retainerSent).trim()) {
      bad('That lead has already been sent a retainer — open it from the Consultations page instead.');
    }
    // A lead that is mid-funnel must NOT be hijacked into the direct pipeline:
    // converting a booked lead corrupts the KPI funnel (booked without being a
    // lead), leaves a live Square appointment dangling, and dual-lists the
    // person in two queues. Same for an in-progress retainer plan — the old
    // plan's template/annex/milestones would be stale under the new case type.
    const booking = String(existing.bookingStatus || '').trim();
    if (booking === 'Booked' || booking === 'Slot Held' || (existing.bookedSlot && String(existing.bookedSlot).trim()) || (existing.consultationHeld && String(existing.consultationHeld).trim())) {
      bad('That lead has a consultation booked or held — manage it from the Consultations page instead of converting it to a direct client.');
    }
    if ([existing.retainerMilestones, existing.selectedTemplate, existing.retainerFee].some((v) => v && String(v).trim())) {
      bad('That lead already has a retainer plan in progress — open it from the Consultations page and continue there.');
    }
    // The chosen lead must actually BE the person staff just typed — a stale
    // match panel (email edited after the radios rendered) or a mispick must
    // never route the new client into someone else's record.
    const handoffSvc = require('./handoffService');
    const sameEmail = existing.email && String(existing.email).trim().toLowerCase() === email.toLowerCase();
    const samePhone = String(existing.phone || '').replace(/\D/g, '').slice(-10) === phone.replace(/\D/g, '').slice(-10) && phone.replace(/\D/g, '').length >= 7;
    const sameName  = handoffSvc.normName(existing.fullName) === handoffSvc.normName(fullName);
    if (!sameEmail && !samePhone && !sameName) {
      bad('The chosen lead does not match the name, email or phone you typed — re-check the duplicate panel and try again.');
    }
    const priorChannel = (existing.sourceChannel || '').trim();
    const linkWiring = {
      // The staff-typed identity is the CURRENT one (they just validated it) —
      // it must win over the lead's stored values, or the retainer would go to
      // a stale email under an old name.
      fullName, email, phone,
      sourceChannel:      DIRECT_SOURCE,
      confirmedCaseType:  caseType,
      selectedSubType:    caseSubType,
      assignedConsultant: consultant,
      residentialAddress: address,
      referredBy,
      conversionStatus:   'Qualified',
      ...reuseExtras,
    };
    if (chosenAccountId) linkWiring.clientAccountId = chosenAccountId;
    // Keep how they first reached us (Add-lead group, 2026-10-15): Source Channel must read
    // "Direct Retainer" (it drives the Retainers tab, the KPIs, the direct group), so the
    // original goes to its own column — once, never overwritten.
    if (priorChannel && priorChannel !== DIRECT_SOURCE && !String(existing.originalChannel || '').trim()) linkWiring.originalChannel = priorChannel;
    await leadService.updateLead(String(linkLeadId), linkWiring);
    _directQueueCache = { at: 0, rows: null };
    invalidateLeadsQueue(); // the lead just left the funnel — drop it from the funnel queue too
    let caseOpened = false;
    try {
      caseOpened = !!(await require('./handoffService').openCaseEarly({ leadId: String(linkLeadId) }));
    } catch (err) {
      console.error(`[Consultant] Early case-open failed for linked lead ${linkLeadId}: ${err.message}`);
    }
    await postPortalNote(String(linkLeadId),
      `Linked as a direct retainer client by staff${priorChannel && priorChannel !== DIRECT_SOURCE ? ` (originally a “${priorChannel}” lead — kept as ONE client instead of a duplicate)` : ''}. ` +
      `Case type: ${caseType}${caseSubType ? ` / ${caseSubType}` : ''} · Consultant: ${consultant}.`).catch(() => {});
    console.log(`[Consultant] Direct client LINKED to existing lead ${linkLeadId} (was "${priorChannel}")`);
    await noteBlacklist(String(linkLeadId), 'Staff saw the warning and set this person up as a direct retainer client anyway.');
    return { ok: true, leadId: String(linkLeadId), reused: true, linked: true, caseOpened, blacklist };
  }

  // Duplicate guard: a lost response / re-submit must not mint a second lead.
  // Reuse an existing direct-tagged lead with this email AND THE SAME PERSON'S
  // NAME AND THE SAME (or unset) CASE TYPE that hasn't been sent a retainer
  // yet. Each check answers a different question:
  //   name  — a shared family email under a different name is a DIFFERENT
  //           person and must never land on their spouse's record;
  //   type  — the same person retaining for a DIFFERENT case type is a NEW
  //           application (user directive 2026-08-04) — only a same-type
  //           re-submit is the double-click this guard exists for.
  // Runs even under allowDuplicate: "create new anyway" answers the
  // different-person/matter question, and skipping the scan there would drop
  // double-submit protection on exactly the retry path staff are on.
  // MUST scan every match — the same email commonly also exists on an older
  // non-direct lead. Best-effort: a read failure falls through to create.
  try {
    const { normName } = require('./handoffService');
    const matches = await leadService.findAllByColumnValue('email', email);
    const reusable = (matches || []).filter((l) => {
      const existingType = String(l.confirmedCaseType || '').trim();
      return (l.sourceChannel || '').trim() === DIRECT_SOURCE &&
        normName(l.fullName) === normName(fullName) &&
        (!existingType || existingType === caseType) &&
        !(l.retainerSent && String(l.retainerSent).trim());
    });
    if (reusable.length) {
      // Newest wins if several exist (highest Monday item id).
      const pick = reusable.sort((a, b) => Number(b.id) - Number(a.id))[0];
      console.log(`[Consultant] Direct client for ${email} already exists (lead ${pick.id}) — reusing`);
      await noteBlacklist(pick.id, 'Staff saw the warning and set this person up as a direct retainer client anyway.');
      return { ok: true, leadId: pick.id, reused: true, blacklist };
    }
  } catch (_) { /* fall through to create */ }

  // Warn-and-link guard: this person may already exist (another lead, an open
  // case, a client account). Creating blind would mint the duplicate the user
  // asked us to stop — so the caller must EXPLICITLY choose (linkLeadId or
  // allowDuplicate). 409 carries the matches so even a stale UI shows them.
  // Fail-open on lookup errors: blocking creation on a Monday hiccup is worse
  // than a rare duplicate.
  if (!allowDuplicate) {
    try {
      const m = await findClientMatches({ email, phone });
      if (m.leads.length || m.cases.length || m.clients.length) {
        const e = new Error('This client may already exist — choose "link to existing" or "create new anyway".');
        e.conflict = true;
        e.matches = m;
        e.blacklist = blacklist;
        throw e;
      }
    } catch (err) {
      if (err.conflict) throw err;
      console.warn(`[Consultant] duplicate-check failed (${err.message}) — proceeding with create`);
    }
  }

  // createLead wires the token + OneDrive folder; the follow-up update carries
  // the direct-specific fields (its mutation auto-creates the new labels).
  // The engine row lives in the dedicated "Direct retainer clients" group on
  // the Lead Board — these clients are cases, not funnel leads.
  const directGroupId = require('../data/newLeadsBoard.json').directRetainerGroupId || undefined;
  const created = await leadService.createLead({
    fullName, email, phone,
    // Tagged AT creation (not in the follow-up write) — there must be no window
    // where this row exists as an untagged "Website" lead that a refreshing
    // Leads tab could cache and display.
    sourceChannel: DIRECT_SOURCE,
    situationDescription: referredBy
      ? `Direct retainer client — entered at the retainer stage, no consultation. Referred by: ${referredBy}`
      : 'Direct retainer client — entered at the retainer stage, no consultation.',
  }, { groupId: directGroupId });
  const leadId = created.id;
  invalidateDirectRetainerQueue(); // the new client must show on the Retainers tab at once (the shared snapshot too)
  const wiring = {
    sourceChannel:      DIRECT_SOURCE,
    confirmedCaseType:  caseType,
    selectedSubType:    caseSubType,
    assignedConsultant: consultant,
    residentialAddress: address,
    referredBy,
    conversionStatus:   'Qualified', // honest: qualified to retain, never booked/consulted
    ...reuseExtras,
  };
  if (chosenAccountId) wiring.clientAccountId = chosenAccountId; // staff-explicit account link from the modal
  try {
    await leadService.updateLead(leadId, wiring);
  } catch (err) {
    // The lead EXISTS — a thrown error would tell staff "try again", and the
    // retry would mint a duplicate. Retry the wiring once; if it still fails,
    // land staff on the created lead with an explicit manual-fix warning.
    console.warn(`[Consultant] Direct-client wiring failed for lead ${leadId} — retrying once: ${err.message}`);
    try {
      await leadService.updateLead(leadId, wiring);
    } catch (err2) {
      console.error(`[Consultant] Direct-client wiring failed twice for lead ${leadId}: ${err2.message}`);
      await postPortalNote(leadId,
        `⚠ <b>Direct retainer client created, but the wiring write failed</b> (${err2.message}). ` +
        `Please set manually: Confirmed Case Type “${caseType}”${caseSubType ? ` (sub-type ${caseSubType})` : ''}, ` +
        `consultant “${consultant}”, Source Channel “${DIRECT_SOURCE}”.`);
      return { ok: true, leadId, warning: 'The client was created, but tagging failed — opening the lead; please set the case type and consultant manually (see the note on the lead).' };
    }
  }
  // CASE-FIRST: direct retainer clients enter the case lifecycle at creation —
  // open the Client Master case NOW (neutral labels; the case ref generates off
  // the confirmed case type). Signing later upgrades the same case via
  // ensureSignedState — the handoff is idempotent, so no duplicate is possible.
  let caseOpened = false;
  try {
    const cmId = await require('./handoffService').openCaseEarly({ leadId });
    caseOpened = !!cmId;
  } catch (err) {
    console.error(`[Consultant] Early case-open failed for direct client ${leadId}: ${err.message}`);
    await postPortalNote(leadId,
      `⚠ <b>The Client Master case could not be opened yet</b> (${err.message}). ` +
      `It will be created automatically when the retainer is signed — no action needed unless this repeats.`).catch(() => {});
  }
  await postPortalNote(leadId,
    `Direct retainer client created — walk-in/referral entering at the retainer stage (no consultation). ` +
    `Case type: ${caseType}${caseSubType ? ` / ${caseSubType}` : ''} · Consultant: ${consultant}${referredBy ? ` · Referred by: ${referredBy}` : ''}. ` +
    (caseOpened ? `The Client Master case is open (case-first — this client is never a funnel lead). ` : '') +
    `Next: set the retainer fee + plan and click “Retain &amp; send agreement”.`);
  await noteBlacklist(leadId, 'Staff saw the warning and created this direct retainer client anyway.');
  console.log(`[Consultant] Direct retainer client created — lead ${leadId} (${fullName}, ${caseType}, ${consultant}, caseOpened=${caseOpened})`);
  return { ok: true, leadId, caseOpened, blacklist };
}

/** HST on a staff-recorded consultation fee, fixed when it is recorded (none when waived or outside Canada). */
/** One "Record payment" save at a time per lead — the lock lives in consultationService,
 *  where every other package trigger waits for it. */
function withRecordLock(leadId, fn) { return require('./consultationService').withRecordSave(leadId, fn); }

/** Two consultations with the same consultant overlap (a claim's length is not known: 30 minutes). PURE. */
function slotsOverlap(aSlot, aMin, bSlot, bMin = 30) {
  const t = (slot) => { const m = String(slot || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN; };
  const a = t(aSlot), b = t(bSlot);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return String(aSlot) === String(bSlot);
  return a < b + bMin && b < a + aMin;
}

/**
 * "Record payment / Waived" (Gauri point 4 part 2, 2026-10-15): the fee was paid by
 * cash / e-transfer / an invoice the team sent / another way, or waived — a RECORD on
 * the lead, so the Consultations list and the KPIs count it. A fee paid through the
 * booking link is recorded by the app itself and cannot be overwritten here.
 *
 * 2026-10-16 (Gauri 2026-10-08, Faran's four choices): with CONSULT_PACKAGE_ON_RECORD
 * on, the record also carries the consultation package choice — "Yes — email them"
 * or "No — don't email them" (a reason required for a paid fee; waived asks every
 * time) — and, for a client booked by hand, the booking itself (time, consultant, in
 * person / video / phone, length), written to the lead so the package and the
 * agreement can state it. Video creates the Teams meeting the way online bookings
 * do. The package goes through the ONE automatic path (trigger 'recorded'), with
 * every once-only guard it already has. Switch off = exactly the old record.
 */
async function recordConsultPaymentAction({ leadId, n, who, actor }) {
  const cp = require('./consultPaymentService');
  const cs = require('./consultationService');
  const s = (x) => String(x == null ? '' : x).trim();
  const bad = (msg) => { const e = new Error(msg); e.badRequest = true; return e; };
  const lead = await leadService.getLead(leadId);
  if (!lead) { const e = new Error('Consultation not found'); e.notFound = true; throw e; }
  const verified = !!(actor && actor.verified);
  const name = verified ? s(actor.name).slice(0, 60) : who;
  if (!name) throw bad('Enter your name — it is recorded with the payment.');
  const state = cp.paidState(lead);
  if (state.paid === 'app') {
    throw bad(`This consultation was paid through the booking link${state.paidCents != null ? ` (${(state.paidCents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })} incl. HST)` : ''} — there is nothing to record here. A refund is done in Square.`);
  }
  const before = state.record;
  const signed = verified ? '' : ' (name as typed)';
  const onRecord = cs.packageOnRecordEnabled(leadId);
  let rawOpt = {}; try { rawOpt = JSON.parse(s(lead.consultOption)) || {}; } catch (_) { rawOpt = {}; }
  if (!rawOpt || typeof rawOpt !== 'object' || Array.isArray(rawOpt)) rawOpt = {};

  if (n.kind === 'clear') {
    if (!before) throw bad('No consultation payment is recorded on this lead.');
    await leadService.updateLead(leadId, { consultPayment: '' }, { clearKeys: ['consultPayment'] });
    try { consultAgreementService.evictCache(leadId); } catch (_) { /* best-effort */ }
    // A package this record asked for and that is still waiting (for the address)
    // is retired — inside the per-lead gate, from a fresh read.
    let pkg = null;
    if (onRecord && before.package === 'send') {
      pkg = await cs.autoSendConsultationPackage(leadId, { trigger: 'recorded', overrides: { consultPayment: '' } })
        .catch((err) => ({ status: 'failed', reason: err.message }));
    }
    const lines = [];
    if (pkg && pkg.retired) lines.push('The consultation package that was waiting will not be sent.');
    else if (pkg && pkg.status === 'already' && pkg.reason === 'in-progress') lines.push('A send of the consultation package is in progress or was interrupted — check the notes in a few minutes.');
    else if (onRecord && before.package === 'send' && ((pkg && pkg.status === 'already') || cs.packageAlreadySent(lead))) lines.push('The consultation package already went out — it cannot be recalled.');
    // Removing the record never cancels a booking: the money may simply not have
    // arrived. Say so, so a booking entered by mistake is not left running unnoticed.
    if (onRecord && s(lead.bookingStatus) === 'Booked' && s(lead.bookedSlot)) {
      const virtualMeeting = s(lead.meetingType) === 'Virtual' && s(lead.zoomMeetingId);
      lines.push(`The booking is NOT cancelled: ${s(lead.bookedSlot)}${s(lead.assignedConsultant) ? ` with ${s(lead.assignedConsultant)}` : ''}${s(lead.meetingType) ? ` (${s(lead.meetingType)})` : ''} is still on this lead and the client still gets the booking reminders. If it was a mistake, change Booking Status in Monday${virtualMeeting ? ' and delete the Teams meeting from the organiser’s calendar (the client already has its invite)' : ''}.`);
    }
    await postPortalNote(leadId, `🗑 Consultation fee record removed by ${escHtmlNote(name)}${signed} — was: ${escHtmlNote(cp.describe(before))}.${lines.length ? ' ' + escHtmlNote(lines.join(' ')) : ''}`);
    return { ok: true, message: `The consultation payment record was removed.${lines.length ? ' ' + lines.join(' ') : ''}`, consultPayment: null };
  }

  // ── The package question: asked only with the switch on, for a client the package
  // is for, when none has gone out (an emailed package keeps the time it stated).
  const alreadySent = cs.packageAlreadySent(lead);
  const applicable = cs.packageApplicable(lead);
  const pendingNow = (() => { const st = consultAgreementService.parseCountersign(lead); return st.packagePending && !st.packageStalled && (Date.now() - Date.parse(st.packagePending)) < cs.PACKAGE_STALE_MS; })();
  if (onRecord && pendingNow && n.booking) throw bad('The consultation package is being sent right now — nothing was saved. Wait a minute, reload the page and try again.');
  const asks = onRecord && !alreadySent && applicable.ok;
  let pkgChoice = before ? before.package : '', pkgNote = before ? before.packageNote : '';
  let booking = null;
  const lines = [];   // what happened after the record, for the reply and the note
  if (asks) {
    if (!n.package) throw bad('Choose whether to email the consultation agreement and pre-consultation form to the client.');
    pkgChoice = n.package; pkgNote = n.packageNote;
    if (pkgChoice === 'skip' && n.kind !== 'waived' && pkgNote.length < 3) throw bad('Say why the client is not being emailed the agreement and form (for example: "given to them in person").');
    if (pkgChoice === 'send' && !n.booking) throw bad('Enter the consultation date and time, the consultant, how it happens and its length — the email and the agreement state them.');
    if (pkgChoice === 'send' && !s(lead.email)) throw bad('There is no email for this client, so the package cannot be emailed. Add the email first, or choose "No".');
    booking = n.booking;
    if (booking && booking.past) {
      // Only with "No" (validateRecord refuses a past time for "send"): the consultation
      // has happened — the lead's booking is left exactly as it is.
      booking = null;
      lines.push('The consultation time entered has already passed, so the booking on the lead was left as it is.');
    }
    // "No" with the booking the lead already has: nothing to write.
    const storedLen = parseInt(rawOpt.durationMin, 10);
    if (booking && pkgChoice === 'skip' && s(lead.bookingStatus) === 'Booked' && s(lead.bookedSlot) === booking.slot
      && s(lead.assignedConsultant) === booking.consultant && s(lead.meetingType) === booking.meetingType
      && storedLen === booking.durationMin
      && (booking.meetingType !== 'Virtual' || s(lead.meetingLink))) booking = null;
  } else if (n.booking) {
    // A page opened before the package went out (or before an outcome was set) still
    // carried a booking: it is NOT written — and staff are told so.
    lines.push(`The booking you entered was NOT saved — ${alreadySent ? 'the consultation package already went out with the time on the lead' : !onRecord ? 'booking from this box is switched off' : 'this client no longer has a consultation to book'}. Change the booking in Monday if it really moved.`);
  }

  // A Not Wanted person is never emailed automatically — not the package, not a Teams invite.
  let notWanted = false;
  if (pkgChoice === 'send' || (booking && booking.meetingType === 'Virtual')) {
    try { const hit = await require('./blacklistService').check({ email: lead.email, phone: lead.phone }); notWanted = !!(hit && hit.hit); }
    catch (_) { notWanted = false; }
  }

  if (booking) {
    // The client is part-way through booking online: their time is held and a
    // payment page is open — recording now invites a second payment.
    const heldUntil = Date.parse(s(lead.slotHeldUntil));
    if (s(lead.bookingStatus) === 'Slot Held' && Number.isFinite(heldUntil) && heldUntil > Date.now()) {
      throw bad(`The client is booking online right now — their time (${s(lead.bookedSlot)}) is held until ${require('../utils/torontoTime').torontoWallClock(new Date(heldUntil).toISOString())} Toronto time and a payment page is open. Wait until the hold ends (or ask them not to pay online), then record.`);
    }
    // Another client in the app already has this consultant at an overlapping time.
    const bk = require('./bookingService');
    let claims;
    try { claims = await bk.readSlotClaims({ strict: true }); }
    catch (err) { throw bad('Could not check the consultant’s other bookings in the app just now — nothing was saved. Try again in a minute.'); }
    const clash = (claims || []).find((c) => String(c.leadId) !== String(leadId)
      && (!c.consultant || c.consultant === booking.consultant)
      && slotsOverlap(booking.slot, booking.durationMin, c.slot));
    if (clash) {
      if (!clash.consultant) throw bad(`Another client (lead ${clash.leadId}) is booked at ${clash.slot} with no consultant set, which overlaps ${booking.slot} — the app cannot tell whose time it is. Nothing was saved: set that lead's consultant in Monday, or choose another time.`);
      throw bad(`${booking.consultant} already has a consultation at ${clash.slot} (another client in the app${clash.status === 'Slot Held' ? ', time held for online payment' : ''}), which overlaps ${booking.slot}. Nothing was saved — choose another time.`);
    }
  }

  // 1) The record — the core, written first. The HST on top of the fee is fixed NOW
  // from where the client is (none outside Canada) — the consultation agreement prints
  // fee + this; a later location edit never changes it. An edit of the SAME amount
  // keeps the HST fixed when it was first recorded (round-2 review).
  const hstCents = (before && before.amountCents === n.amountCents && Number.isInteger(before.hstCents) && n.kind !== 'waived') ? before.hstCents : rec0HstCents(n, lead);
  const rec = {
    kind: n.kind, amountCents: n.amountCents, hstCents, on: n.on, reference: n.reference, note: n.note, by: name, at: new Date().toISOString(), verified,
    ...(pkgChoice ? { package: pkgChoice } : {}), ...(pkgChoice && pkgNote ? { packageNote: pkgNote } : {}),
  };
  await leadService.updateLead(leadId, { consultPayment: JSON.stringify(rec) });
  try { consultAgreementService.evictCache(leadId); } catch (_) { /* the agreement's "has paid" line changes — drop the cached copy */ }
  const money = (c) => (c / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });

  // 2) The booking. From here a failure never undoes the record — the reply says what is left.
  let bookingOverrides = {}, bookingOk = !booking;
  if (booking) {
    try {
      const w = await writeRecordedBooking(leadId, lead, booking, name, lines, { noMeeting: notWanted });
      bookingOverrides = w.overrides;
      bookingOk = !w.meetingFailed;
    } catch (err) {
      lines.push(`⚠ The booking could not be saved (${err.message}) — the package was NOT emailed. Save the record again to retry.`);
    }
  }

  // 3) The package — only through the one automatic path.
  let pkg = null;
  if (onRecord && !alreadySent && (pkgChoice === 'send' || (before && before.package === 'send'))) {
    // Always through the gate (it re-checks the Not Wanted list and retires a package an
    // earlier save left waiting) — a failed booking or meeting is passed in as a block.
    pkg = await cs.autoSendConsultationPackage(leadId, { trigger: 'recorded', ...(pkgChoice === 'send' && !bookingOk ? { block: 'booking-failed' } : {}), overrides: { consultPayment: JSON.stringify(rec), ...bookingOverrides } })
      .catch((err) => ({ status: 'failed', reason: err.message }));
  }
  const futureTime = (slot) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s(slot)) && s(slot) > cp.torontoNowWall();
  const pkgLine = packageResultLine(pkg, { pkgChoice, pkgNote, kind: n.kind, alreadySent, applicable, onRecord,
    hasTime: bookingOk && booking ? true : (s(lead.bookingStatus) === 'Booked' && futureTime(lead.bookedSlot)) });
  if (pkgLine) lines.push(pkgLine);

  // A booking-page payment page or Square invoice made for this client earlier may still be payable.
  if (onRecord && !s(lead.squareConsultTxnId) && (s(lead.squareConsultOrderId) || (rawOpt.invoiceId && s(lead.bookingStatus) !== 'Abandoned'))) {
    lines.push('⚠ A booking-page payment link or Square invoice was made for this client earlier — cancel it in Square so they are not charged.');
  }

  const signedAgreement = !!s(lead.consultAgreementSigned);
  const agreementLine = signedAgreement ? ' The signed consultation agreement keeps the earlier amount.'
    : (onRecord ? alreadySent : !!s(lead.consultAgreementSent)) ? ' The consultation agreement already sent for signature keeps the earlier amount; its preview link now shows the new one.' : '';
  const recordOnly = onRecord ? '' : ' A record only — no email or automatic step runs from it.';
  await postPortalNote(leadId, `${rec.kind === 'waived' ? '🆓 Consultation fee waived' : '💳 Consultation fee recorded as paid'} — ${escHtmlNote(cp.describe(rec))}.${before ? ` Replaces: ${escHtmlNote(cp.describe(before))}.` : ''}${recordOnly}${agreementLine}${lines.length ? ' ' + escHtmlNote(lines.join(' ')) : ''}`);
  const head = rec.kind === 'waived'
    ? 'Recorded — the consultation fee is waived.'
    : `Recorded — ${cp.KINDS[rec.kind]} ${money(rec.amountCents)} received ${rec.on}.${before ? ' The earlier record was replaced.' : ''}${hstCents > 0 ? ` The consultation agreement states ${money(rec.amountCents + hstCents)} incl. HST.` : ''}`;
  return {
    ok: true,
    message: `${head}${agreementLine}${lines.length ? ' ' + lines.join(' ') : ''}`,
    consultPayment: rec,
    ...(pkg ? { package: pkg.status } : {}),
  };
}

/**
 * Write the booking staff typed with the fee onto the lead (2026-10-16): Booked,
 * the time, the consultant, in person / video / phone, the length — what the
 * package email and the agreement state. The length's standard fee goes on the
 * consultation option (the agreement's duration line), keeping whatever the
 * booking page stored there (an open invoice id stays findable).
 * Video: the meeting is created the way online bookings create it (the client
 * and the consultant get its invite). It is stamped with what it was made for
 * (time, consultant, length) and reused only for exactly that; any other video
 * meeting on the lead is cleared from it when the booking changes (staff are told
 * to delete it), so a stale or deleted link is never emailed (review 2026-10-16).
 * NO Square appointment: staff keep the Square calendar themselves (the app never
 * sees a booking made in Square), so writing one here would double it.
 * @returns {Promise<{ overrides: object, meetingFailed?: true }>} the values just written,
 *   handed to the package (a Monday re-read may not show them yet)
 */
async function writeRecordedBooking(leadId, lead, booking, staffName, lines, { noMeeting = false } = {}) {
  const s = (v) => String(v == null ? '' : v).trim();
  const { CONSULTANTS, consultOptionsFor } = require('../../config/consultantRouting');
  const reg = Object.values(CONSULTANTS).find((c) => c.name === booking.consultant);
  const opt = (reg ? consultOptionsFor(reg) : []).find((o) => o.durationMin === booking.durationMin) || {};
  let raw = {};
  try { raw = JSON.parse(s(lead.consultOption)); } catch (_) { raw = {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const want = { slot: booking.slot, consultant: booking.consultant, durationMin: booking.durationMin };
  const mf = raw.meetingFor && typeof raw.meetingFor === 'object' ? raw.meetingFor : null;
  const hadMeeting = s(lead.zoomMeetingId), hadLink = s(lead.meetingLink);
  const stampOk = !!mf && mf.slot === want.slot && mf.consultant === want.consultant && Number(mf.durationMin) === want.durationMin;
  // A link with no stamp (pasted into Monday by hand, or made before the stamp existed)
  // counts only for the lead's exact current video booking (review round 2).
  const unstampedCurrent = !mf && s(lead.bookingStatus) === 'Booked' && s(lead.bookedSlot) === want.slot && s(lead.assignedConsultant) === want.consultant;
  const reuse = booking.meetingType === 'Virtual' && !!hadLink && s(lead.meetingType) === 'Virtual' && (stampOk || unstampedCurrent);
  const { meetingFor, ...rawRest } = raw;
  const optFields = {
    ...rawRest, durationMin: booking.durationMin,
    ...(Number.isFinite(opt.feeCents) ? { feeCents: opt.feeCents } : {}),
    ...(opt.variationId ? { variationId: opt.variationId } : {}),
    consultant: booking.consultant, bookedByStaff: true,
    ...(reuse ? { meetingFor: want } : {}),
  };
  const fields = {
    bookingStatus: 'Booked', bookedSlot: booking.slot, meetingType: booking.meetingType,
    assignedConsultant: booking.consultant, consultationHeld: booking.date, consultOption: JSON.stringify(optFields),
    ...(s(lead.bookedBy) ? {} : { bookedBy: staffName }),
  };
  // A video meeting that is not for exactly this booking is taken off the lead in the
  // same write — the reply names it so staff can delete it from the calendar.
  const dropMeeting = !!(hadMeeting || hadLink) && !reuse;
  await leadService.updateLead(leadId, { ...fields, ...(dropMeeting ? { zoomMeetingId: '', meetingLink: '' } : {}) },
    dropMeeting ? { clearKeys: ['zoomMeetingId', 'meetingLink'] } : undefined);
  const overrides = { ...fields, ...(dropMeeting ? { zoomMeetingId: '', meetingLink: '' } : {}) };
  if (dropMeeting) lines.push(`An earlier video meeting (for ${s(lead.bookedSlot) || 'an earlier time'}${hadLink ? `: ${hadLink}` : ''}) is no longer used — delete it from the meeting organiser's calendar so the client is not confused.`);
  if (booking.meetingType !== 'Virtual') return { overrides };
  if (reuse) { overrides.meetingLink = s(lead.meetingLink); overrides.zoomMeetingId = hadMeeting; return { overrides }; }
  if (noMeeting) {
    lines.push('No Teams meeting was created: this person is on the Not Wanted list.');
    return { overrides, meetingFailed: true };
  }
  let meeting;
  try {
    meeting = await require('./meetingService').createMeeting({ ...lead, ...fields }, booking.slot, booking.durationMin);
  } catch (err) {
    if (err.eventId) {
      // The calendar event (and its invites) exists — only the Teams link is missing.
      try { await leadService.updateLead(leadId, { zoomMeetingId: String(err.eventId) }); } catch (_) { /* named below */ }
      lines.push(`⚠ A calendar invite went to the client and ${booking.consultant}, but it has no Teams link (${err.message}) — the package was NOT emailed. Delete that event from the meeting organiser's calendar (id ${err.eventId}) BEFORE saving again, or choose in person or phone.`);
    } else {
      lines.push(`⚠ Booked, but the video meeting could not be created (${err.message}) — no invite went out and the package was NOT emailed. Save the record again to retry, or choose in person or phone.`);
    }
    return { overrides, meetingFailed: true };
  }
  // Created: the invites are out. From here the meeting is NEVER reported as missing.
  overrides.meetingLink = meeting.joinUrl; overrides.zoomMeetingId = meeting.meetingId;
  const label = meeting.provider === 'teams' ? 'Microsoft Teams' : 'Zoom';
  const store = { zoomMeetingId: meeting.meetingId, meetingLink: { url: meeting.joinUrl, text: `Join (${label})` },
    consultOption: JSON.stringify({ ...optFields, meetingFor: want }) };
  let stored = false;
  for (let i = 0; i < 2 && !stored; i++) {
    try { await leadService.updateLead(leadId, store); stored = true; }
    catch (err) { if (i === 1) console.warn(`[Consultant] storing the new meeting failed for lead ${leadId}: ${err.message}`); }
  }
  lines.push(`The ${meeting.provider === 'teams' ? 'Teams' : 'video'} meeting was created — the client and ${booking.consultant} get its invite.`);
  if (!stored) lines.push(`⚠ Its link could not be saved on the lead — do NOT save the record again (that would create a second meeting). Put this link in "Meeting Link" in Monday by hand: ${meeting.joinUrl}`);
  return { overrides };
}

/**
 * What the "Record payment" dialog needs to ask about the consultation package
 * (2026-10-16): whether to ask at all, what to pre-fill for the booking, the
 * consultants and their lengths, the HST for the "has paid" preview. PURE apart
 * from the clock.
 */
function recordPackageView(lead, ps) {
  const cs = require('./consultationService');
  if (!cs.packageOnRecordEnabled(lead.id)) return { enabled: false };
  const s = (v) => String(v == null ? '' : v).trim();
  const { CONSULTANTS, consultOptionsFor, routeConsultant } = require('../../config/consultantRouting');
  const app = cs.packageApplicable(lead);
  const slot = s(lead.bookedSlot), status = s(lead.bookingStatus);
  // Only a BOOKED time still ahead is offered: a time left from an expired online hold
  // may not be the real one, and a past one cannot be emailed (review 2026-10-16).
  const timeOk = status === 'Booked' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slot) && slot > require('./consultPaymentService').torontoNowWall();
  const pinned = Object.values(CONSULTANTS).find((c) => c.name === s(lead.assignedConsultant));
  let routed = null; try { routed = routeConsultant(lead); } catch (_) { routed = null; }
  const opt = cs.parseConsultOption(lead);
  const heldUntil = Date.parse(s(lead.slotHeldUntil));
  return {
    enabled: true, applicable: app.ok, why: app.ok ? '' : app.why,
    alreadySent: cs.packageAlreadySent(lead), sentOn: s(lead.consultAgreementSent),
    record: (ps.record && ps.record.package) || '', recordNote: (ps.record && ps.record.packageNote) || '',
    stored: ps.record ? { kind: ps.record.kind, amountCents: ps.record.amountCents, hstCents: ps.record.hstCents } : null,
    hstPct: require('./bookingService').consultHstPctForLead(lead),
    hasEmail: !!s(lead.email), hasAddress: !!s(lead.residentialAddress),
    heldOnline: (status === 'Slot Held' && Number.isFinite(heldUntil) && heldUntil > Date.now()) ? s(lead.slotHeldUntil) : '',
    consultants: Object.values(CONSULTANTS).map((c) => ({ name: c.name, options: consultOptionsFor(c).map((o) => ({ durationMin: o.durationMin, feeCents: o.feeCents })) })),
    prefill: {
      date: timeOk ? slot.slice(0, 10) : '', time: timeOk ? slot.slice(11) : '',
      // Only a consultant actually set on the lead — the routing guess is offered as a hint, never chosen for staff.
      consultant: pinned ? pinned.name : '',
      suggested: pinned ? '' : ((routed && routed.name) || ''),
      meetingType: (timeOk && ['In-person', 'Virtual', 'Phone Call'].includes(s(lead.meetingType))) ? s(lead.meetingType) : '',
      durationMin: opt ? opt.durationMin : null,
    },
  };
}

/** The one line the record's reply and note say about the consultation package. PURE. */
function packageResultLine(pkg, { pkgChoice, pkgNote, kind, alreadySent, applicable, onRecord, hasTime }) {
  if (!onRecord) return '';
  if (pkg && pkg.status === 'already' && pkg.reason === 'in-progress') return 'A send of the consultation package is in progress or was interrupted — check the notes in a few minutes before doing anything.';
  if (alreadySent || (pkg && pkg.status === 'already')) return 'The consultation package already went out to the client — it is not sent again.';
  if (applicable && !applicable.ok) {
    return ({
      outcome: 'No consultation package: an outcome is already set, so the consultation has happened.',
      case: 'No consultation package: this client already has a case.',
      retainer: 'No consultation package: a retainer is already under way.',
      direct: 'No consultation package: a direct retainer client has no consultation.',
    })[applicable.why] || '';
  }
  if (pkgChoice === 'skip') {
    return `The agreement and pre-consultation form were NOT emailed — you chose not to${pkgNote ? ` (${pkgNote})` : ''}.`
      + (pkg && pkg.retired ? ' The package that was waiting will not be sent.' : '')
      + (hasTime ? ' The booking reminders still go out.' : '');
  }
  if (!pkg) return '';
  switch (pkg.status) {
    case 'sent': return 'The consultation agreement (for e-signature) and the pre-consultation form have been emailed to the client.';
    case 'held': return pkg.armed === false
      ? 'The package is NOT sent: there is no residential address (the agreement prints it), and the automatic release could not be set up — add the address, then use "Review & send".'
      : 'The package is waiting for the client\'s residential address (the agreement prints it) — add it on this page and it is emailed automatically.';
    case 'too-late': return 'The consultation time has passed, so the package was not emailed.';
    case 'not-ready':
      return pkg.reason === 'booking-failed' ? ''
        : pkg.reason === 'no-email' ? 'The package was not emailed: there is no email for this client.'
        : 'The package was not emailed: the consultation is not booked with a date and time yet.';
    case 'needs-person': return `The package was not emailed — it needs a person first (${pkg.reason || 'see the notes'}). Use "Review & send" on this page.`;
    case 'not-wanted':
      return pkg.reason === 'not-wanted-list' ? 'The package was NOT emailed: this person is on the Not Wanted list. Use "Review & send" only if you are sure.'
        : pkg.retired ? 'The consultation package that was waiting will not be sent.' : '';
    case 'disabled': return 'Automatic sending is switched off — use "Review & send" to email the package.';
    case 'expired': return 'The consultation time has passed, so the package was not emailed.';
    case 'failed': return `The package could not be emailed (${pkg.reason || 'unknown error'}) — use "Review & send" once fixed.`;
    default: return '';
  }
}

function rec0HstCents(n, lead) {
  if (!n || n.kind === 'waived' || !(n.amountCents > 0)) return 0;
  return require('./bookingService').consultTotalWithTaxForLead(n.amountCents, lead) - n.amountCents;
}

/** The 409 body for a create conflict: the duplicates AND the Not Wanted warning travel together. */
function conflictBody(err) {
  return { error: err.message, matches: err.matches || { leads: [], cases: [], clients: [] }, ...(err.blacklist ? { blacklist: err.blacklist } : {}) };
}

/**
 * Everything that already exists for this email/phone — the warn-and-link
 * panel's data. Three buckets: client accounts (registry), open Client Master
 * cases, and leads. Each lookup is independent and best-effort: one source
 * failing must not blind staff to the others.
 */
async function findClientMatches({ email, phone } = {}) {
  const e = String(email || '').trim();
  const p = String(phone || '').trim();
  const out = { clients: [], cases: [], leads: [], matchedOn: { email: !!e, phone: !!p } };
  if (!e && !p) return out;

  const clientMaster = require('./clientMasterService');
  const clientAccounts = require('./clientAccountService');

  const settle = async (fn) => { try { return await fn(); } catch (err) { console.warn(`[Consultant] client-match lookup failed: ${err.message}`); return []; } };

  // Lead phone columns store the digits of whatever was submitted — a
  // formatted or '+'-prefixed staff entry never matches raw, so query the
  // digit variants (bare 10-digit and the NA 1-prefixed form).
  const pDigits = p.replace(/\D/g, '');
  const pBare = pDigits.length === 11 && pDigits.startsWith('1') ? pDigits.slice(1) : pDigits;
  const phoneVariants = pDigits.length >= 7 ? [...new Set([pDigits, pBare, `1${pBare}`])] : [];

  const [leadsByEmail, leadsByPhone, casesByEmail, casesByPhone, clients] = await Promise.all([
    e ? settle(() => leadService.findAllByColumnValue('email', e)) : [],
    phoneVariants.length
      ? settle(async () => (await Promise.all(phoneVariants.map((v) => leadService.findAllByColumnValue('phone', v)))).flat())
      : [],
    e ? settle(() => clientMaster.findCasesByEmail(e)) : [],
    p ? settle(() => clientMaster.findCasesByPhone(p)) : [],
    settle(() => clientAccounts.findMatches({ email: e, phone: p })),
  ]);

  const leadMap = new Map();
  for (const l of [...leadsByEmail, ...leadsByPhone]) {
    if (!leadMap.has(String(l.id))) {
      leadMap.set(String(l.id), {
        id: String(l.id),
        name: l.fullName || l.name || `Lead ${l.id}`,
        email: l.email || '',
        phone: l.phone || '',
        sourceChannel: (l.sourceChannel || '').trim(),
        conversionStatus: (l.conversionStatus || '').trim(),
        hasCase: !!(l.clientMasterItemId && String(l.clientMasterItemId).trim()),
        retainerSent: !!(l.retainerSent && String(l.retainerSent).trim()),
        // Mid-funnel state — the modal must show it and must NOT offer linking.
        booked: ['Booked', 'Slot Held'].includes(String(l.bookingStatus || '').trim())
          || !!(l.bookedSlot && String(l.bookedSlot).trim())
          || !!(l.consultationHeld && String(l.consultationHeld).trim()),
        planInProgress: [l.retainerMilestones, l.selectedTemplate, l.retainerFee].some((v) => v && String(v).trim()),
      });
    }
  }
  const caseMap = new Map();
  for (const c of [...casesByEmail, ...casesByPhone]) if (!caseMap.has(c.id)) caseMap.set(c.id, c);

  out.leads = [...leadMap.values()];
  out.cases = [...caseMap.values()];
  out.clients = (clients || []).map((c) => ({ id: c.id, name: c.name, email: c.email, confidence: c.confidence, reasons: c.reasons }));
  return out;
}

/**
 * In-progress direct retainer clients (created case-first, not yet Retained) —
 * the Consultations page's "Direct retainer clients" section. Retained ones
 * graduate to the normal case views and drop off this list.
 */
let _directQueueCache = { at: 0, rows: null };
/** Drop the direct-retainer queue cache (e.g. after a client is deleted); the shared snapshot too. */
function invalidateDirectRetainerQueue() { _directQueueCache = { at: 0, rows: null }; require('./leadSnapshot').invalidate(); }
async function getDirectRetainerQueue() {
  if (_directQueueCache.rows && (Date.now() - _directQueueCache.at) < 60 * 1000) return _directQueueCache.rows;
  const leads = await require('./leadSnapshot').leads();
  const rows = leads
    .filter((l) => (l.sourceChannel || '').trim() === DIRECT_SOURCE
      && String(l.conversionStatus || '').trim() !== 'Retained')
    .map((l) => ({
      id: l.id,
      name: l.fullName || l.name,
      createdAt: l.createdAt || '',
      caseType: l.confirmedCaseType || '',
      consultant: (l.assignedConsultant || '').trim(),
      retainerStatus: l.retainerPaid ? 'Paid' : l.retainerSigned ? 'Signed'
        : l.retainerSent ? 'Sent' : l.retainerFee ? 'Fee set' : 'New',
      caseOpen: !!(l.clientMasterItemId && String(l.clientMasterItemId).trim()),
      clientMasterItemId: l.clientMasterItemId || '',
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || Number(b.id) - Number(a.id));
  _directQueueCache = { at: Date.now(), rows };
  return rows;
}

/**
 * A booked consultation with an outcome moves to Retainers AS SOON AS the
 * outcome is set (Gauri point 4: "once an outcome is set, the client moves to
 * the Retainers view"; Faran 2026-10-16: no waiting for the next day).
 *   - upcoming (a later day): stays on Consultations, whatever its outcome;
 *   - today: moves once the outcome was set TODAY (Toronto) — nothing clears an
 *     outcome when a client is re-booked, so one set on an earlier day belongs
 *     to an earlier consultation and must not take today's meeting off the
 *     day's list (review 2026-10-16). Unknown when it was set: stays today;
 *   - an earlier day, or no date at all: moves (the outcome says it happened).
 * Retain (or a retainer under way) never gets here: classifyLead sends it to
 * Retainers at once, whatever the date — by design (f09e491).
 *
 * @param {object} l      the lead (snapshot row; outcomeChangedAt = Monday's changed_at)
 * @param {string} today  the Toronto day, 'YYYY-MM-DD'
 */
function consultationDone(l, today) {
  if (!canonicalOutcome(l.outcome)) return false;
  const m = String(l.bookedSlot == null ? '' : l.bookedSlot).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m || m[1] < today) return true;
  if (m[1] > today) return false;
  return torontoDay(l.outcomeChangedAt) === today;
}

/**
 * The Consultations page (Gauri point 4): the Consultations and Retainers tabs,
 * from the shared snapshot, one row per lead by classifyLead — plus a booked
 * consultation that has happened and has an outcome moves to Retainers
 * (consultationDone). Each Retainers row carries its outcome group, which the
 * page's quick filters use. Dates are passed as stored (Toronto
 * 'YYYY-MM-DD[ HH:MM]'); the page does Today/Week/Month in Toronto. Never a
 * client's email or phone — a list, not a record.
 */
async function getConsultationsBoard({ fresh = false, now = new Date() } = {}) {
  const snap = await require('./leadSnapshot').getLeadSnapshot({ fresh });
  const s = (v) => String(v == null ? '' : v).trim();
  const consultations = [], retainers = [];
  const consultPayment = require('./consultPaymentService');
  const today = torontoDay(now.toISOString());
  for (const l of snap.leads) {
    let kind = classifyLead(l);
    if (kind === 'consultation' && consultationDone(l, today)) kind = 'retainer';
    if (kind === 'consultation') {
      // paid: 'app' (the booking link's Square payment, paidCents incl. HST) | a kind
      // staff recorded (cash / e-transfer / invoice / other, paidCents before HST;
      // waived = 0) | '' (nothing yet). paidBy/paidOn only for a staff record.
      const ps = consultPayment.paidState(l);
      consultations.push({
        id: l.id, name: l.fullName || l.name,
        service: s(l.confirmedCaseType) || s(l.serviceRequired),
        consultant: s(l.assignedConsultant),
        bookedSlot: s(l.bookedSlot),
        meetingType: s(l.meetingType),
        preConsultSubmitted: s(l.preConsultSubmitted) === 'Yes',
        agreementSent: s(l.consultAgreementSent), agreementSigned: s(l.consultAgreementSigned),
        paid: ps.paid, paidCents: ps.paidCents, paidBy: ps.by, paidOn: ps.on, paidVerified: ps.verified,
        outcome: s(l.outcome), followUpDate: s(l.followUpDate),
        consultationHeld: s(l.consultationHeld), hasMeeting: !!s(l.meetingLink),
        tier: s(l.tier), createdAt: l.createdAt || '',
      });
    } else if (kind === 'retainer') {
      const oc = canonicalOutcome(l.outcome);
      const direct = s(l.sourceChannel) === DIRECT_SOURCE;
      // the CONSULTATION fee (not the retainer's): a client who had one keeps its
      // paid state on this tab, so an unrecorded fee is still found (review 2026-10-16).
      // A direct client had no consultation, but a fee staff recorded for one still shows.
      const ps = consultPayment.paidState(l);
      retainers.push({
        id: l.id, name: l.fullName || l.name,
        kind: direct ? 'direct' : 'booked',
        originalChannel: s(l.originalChannel),
        caseType: s(l.confirmedCaseType) || s(l.caseTypeInterest) || s(l.serviceRequired),
        consultant: s(l.assignedConsultant),
        fee: s(l.retainerFee),
        retainerSent: s(l.retainerSent), retainerSigned: s(l.retainerSigned), retainerPaid: s(l.retainerPaid),
        // one stage, most advanced first; '' = no retainer under way (a Follow-Up,
        // Newsletter or Not Wanted client the consultation left here)
        stage: s(l.retainerPaid) ? 'Paid' : s(l.retainerSigned) ? 'Signed' : s(l.retainerSent) ? 'Sent' : s(l.retainerFee) ? 'Fee set'
          : oc === OUTCOME_RETAIN ? 'Retain' : oc ? '' : 'New',
        // the quick filters: the outcome, or Retain for a row with none (a direct
        // retainer client, or a retainer under way with the outcome left blank)
        outcomeGroup: oc || OUTCOME_RETAIN,
        caseOpen: !!s(l.clientMasterItemId), clientMasterItemId: s(l.clientMasterItemId),
        bookedSlot: s(l.bookedSlot), outcome: oc || s(l.outcome), followUpDate: s(l.followUpDate), createdAt: l.createdAt || '',
        paid: ps.paid, paidCents: ps.paidCents, paidBy: ps.by, paidOn: ps.on, paidVerified: ps.verified,
      });
    }
  }
  // Consultations: earliest time first (today on top), blanks last.
  consultations.sort((a, b) => (a.bookedSlot && b.bookedSlot) ? a.bookedSlot.localeCompare(b.bookedSlot) : a.bookedSlot ? -1 : b.bookedSlot ? 1 : Number(b.id) - Number(a.id));
  // Retainers: by stage (the ones waiting on us first), then oldest first within a
  // stage; the rows with no retainer under way last, oldest consultation first
  // (one with no date after them).
  const STAGE_ORDER = { Paid: 0, Signed: 1, Sent: 2, 'Fee set': 3, Retain: 4, New: 5, '': 6 };
  const stageDate = (r) => (r.stage === '' ? (r.bookedSlot || '\uffff') : (r.retainerPaid || r.retainerSigned || r.retainerSent || r.createdAt || ''));
  retainers.sort((a, b) => (STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]) || stageDate(a).localeCompare(stageDate(b)) || Number(a.id) - Number(b.id));
  return { consultations, retainers, at: snap.at, ageMs: snap.ageMs, stale: !!snap.stale };
}

/** Option lists for the direct-client form (case types → sub-types, consultants). */
async function getDirectClientOptions() {
  const labels = await directCaseTypeLabels();
  const { CONSULTANTS } = require('../../config/consultantRouting');
  return {
    caseTypes: labels.caseTypes,
    subTypesByCase: labels.subTypesByCase,
    consultants: Object.values(CONSULTANTS).map((c) => c.name),
  };
}

module.exports = {
  REMARK_PRESETS, postRemarkNote, notifyOutcomeChange,
  getConsultationQueue, getConsultationDetail, validateAction, applyAction, OUTCOME_LABELS,
  getLeadsQueue, getLeadDetail, buildIntakeSections,
  parseSelections, getRetainerPlan, previewRetainerPdf, previewConsultAgreement, getSignedConsultAgreementPdf, getSignedRetainerAgreementPdf,
  resolveFamilyMembers, FAMILY_MEMBER_TYPES, MILESTONE_TRIGGER_STAGES,
  createDirectClient, getDirectClientOptions, getDirectRetainerQueue, invalidateDirectRetainerQueue, findClientMatches, DIRECT_SOURCE,
  createStaffLead, STAFF_LEAD_SOURCES,
  invalidateLeadsQueue,
  classifyLead, consultationDone, getConsultationsBoard,
  _recordPackageView: recordPackageView, _packageResultLine: packageResultLine,   // test seams
  conflictBody, normalizeLeadLocation,
};
