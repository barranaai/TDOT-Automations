/**
 * caseCockpitService — single-case aggregator for the staff admin cockpit.
 *
 * The staff cockpit (/admin/case/:caseRef) shows everything about ONE case on
 * one screen, so staff run a file without opening Monday. This service is the
 * read seam: it orchestrates the existing single-client read functions (which
 * each serve a specific flow today) into one unified snapshot.
 *
 * Pure glue — no new Monday schema, no writes. Each sub-read is wrapped so one
 * slow/failed source (e.g. OneDrive hiccup) degrades that section to empty
 * rather than failing the whole page.
 *
 *   getCaseOverview(caseRef) → {
 *     caseRef, itemId, clientName, caseType, caseSubType,
 *     clientEmail, manager, paymentStatus, caseStage, health, slaRisk,
 *     deadline, qReadinessPct, docReadinessPct, portalLink, folderLink,
 *     accessToken,
 *     family:        [{ role, name, memberKey, flags }],
 *     questionnaire: { members:[{ key, type, badge, label, status, hasData, completionPct, submittedAt }],
 *                      submitted, total, unavailable, mondayDone },
 *     documents:     { counts:{ total, received, reviewed, rework, missing },
 *                      byCategory:[{ category, items:[...] }], rework:[...] },
 *     sponsor:       sponsorOnboardingService.describe() — the inviter / sponsor
 *                    card ({ available:false } when it could not be read),
 *   }
 */

'use strict';

const mondayApi          = require('./mondayApi');
const htmlQ              = require('./htmlQuestionnaireService');
const documentFormSvc    = require('./documentFormService');
const compositionAdapter = require('./compositionAdapter');
const { clientMasterBoardId } = require('../../config/monday');
const { torontoWallClock } = require('../utils/torontoTime');

// Client Master columns this aggregator reads. IDs verified against the live
// readers in chasingLoopService / dashboardService / config (single source).
const CM = {
  caseRef:        'text_mm142s49',
  clientEmail:    'text_mm0xw6bp',
  caseStage:      'color_mm0x8faa',
  paymentStatus:  'color_mm0x9fnn',
  qReadiness:     'numeric_mm0x9dea',
  docReadiness:   'numeric_mm0x5g9x',   // % staff-Reviewed (a status rarely set)
  docUploaded:    'numeric_mm2njqk1',   // % the client has uploaded — the progress number
  caseHealth:     'color_mm0xf5ry',
  slaRiskBand:    'color_mm0xszmm',
  caseManager:    'multiple_person_mm0xhmgk',
  hardDeadline:   'date_mm0x5pqd',
  deadlineType:   'color_mm6w7cdd',   // the client's deadline (2026-11-05): Deadline / Imaginary
  actualDeadline: 'date_mm33sj6t',
  internalDeadline: 'date_mm3t66pa',  // the promised submission date
  portalLink:     'link_mm2vta5',
  folderLink:     'link_mm47dng8',
  automationLock: 'color_mm0x3x1x',   // the document reminders' gate (block 2): Yes = no reminder from here
  manualOverride: 'color_mm0x975e',   // the same gate (plan §3b condition 4): Yes = no reminder from here
  escalationLastNotified: 'date_mm1gqbd',   // the escalation engine's last rule-match stamp (any rule, not only a client email) — a preview warning on the buttons, never a block
  qCompletionStatus: 'color_mm0x9s08',      // questionnaire status — Done = submitted; the reminders' fallback when the manifest has no stamps (the portal's rule). Read only.
};
// Document reminders (block 2): the case's newest notes ride on the same Client
// Master read — the "Sent:" line is read from them, never a second expensive read.
// 100 is Monday's maximum for updates on an item read (review 2026-11-07: 50 lost
// an older reminder on a busy case); the card says its facts come from the
// recent notes, since a case can hold more.
const CM_NOTES_LIMIT = 100;

function clampPct(raw) {
  if (raw === '' || raw == null) return 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Link columns return "text - url" mashed in .text; the URL lives in .value JSON. */
function linkUrl(colValue) {
  try {
    const parsed = JSON.parse(colValue || 'null');
    return (parsed && parsed.url) ? parsed.url : '';
  } catch {
    return '';
  }
}

const caseAccess = require('./caseAccessService');

async function readClientMaster(itemId) {
  // Fetch our columns PLUS every people column (for the access check), deduped.
  const fetchIds = [...new Set([...Object.values(CM), ...caseAccess.PEOPLE_COLUMNS])];
  const ids = fetchIds.map((c) => `"${c}"`).join(', ');
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId], limit: 1) {
         group { id title }
         column_values(ids: [${ids}]) { id text value }
         updates(limit: ${CM_NOTES_LIMIT}) { id created_at text_body body }
       }
     }`,
    { itemId: String(itemId) }
  );
  const item = data?.items?.[0] || {};
  const cols = item.column_values || [];
  const by = {};
  for (const c of cols) by[c.id] = c;
  const txt = (id) => (by[id]?.text || '').trim();
  const valueByColId = {};
  for (const c of cols) valueByColId[c.id] = c.value;

  return {
    clientEmail:     txt(CM.clientEmail),
    caseStage:       txt(CM.caseStage) || 'Not Started',
    paymentStatus:   txt(CM.paymentStatus) || 'Unpaid',
    qReadinessPct:   clampPct(txt(CM.qReadiness)),
    docReadinessPct: clampPct(txt(CM.docUploaded)),
    docReviewedPct:  clampPct(txt(CM.docReadiness)),
    health:          txt(CM.caseHealth) || '—',
    slaRisk:         txt(CM.slaRiskBand) || '—',
    manager:         txt(CM.caseManager) || 'Unassigned',
    deadline:        txt(CM.hardDeadline) || '',
    clientDeadline:  require('./deadlineService').describe({ ok: true, type: txt(CM.deadlineType), actualDeadline: txt(CM.actualDeadline), promisedSubmissionDate: txt(CM.internalDeadline) }),
    // the same answer as stored (the reminders fill {Deadline} / {PromisedDate} from it)
    clientDeadlineRaw: require('./deadlineService').fromLead({ deadlineType: txt(CM.deadlineType), actualDeadline: txt(CM.actualDeadline), promisedSubmissionDate: txt(CM.internalDeadline) }),
    portalLink:      linkUrl(by[CM.portalLink]?.value) || txt(CM.portalLink),
    folderLink:      linkUrl(by[CM.folderLink]?.value) || txt(CM.folderLink),
    assignees:       caseAccess.assigneesFromColumnValues(valueByColId), // { personIds, teamIds }
    group:           { id: (item.group && item.group.id) || '', title: (item.group && item.group.title) || '' },
    automationLock:  txt(CM.automationLock),
    manualOverride:  txt(CM.manualOverride),
    escalationLastNotified: txt(CM.escalationLastNotified).slice(0, 10),
    qDone:           txt(CM.qCompletionStatus) === 'Done',
    notes:           require('./docReminderService').rawNotes(item.updates),   // newest CM_NOTES_LIMIT, for the reminders record
  };
}

function summariseDocuments(items) {
  const na = require('./documentNotApplicable');
  const counts = { total: items.length, received: 0, reviewed: 0, rework: 0, missing: 0, na: 0, optionalOpen: 0 };
  const rework = [];
  const catMap = new Map();
  const memMap = new Map(); // applicantType (member) → (category → items[])

  for (const it of items) {
    const s = it.status || 'Missing';
    if (it.optional === true && s === 'Missing') counts.optionalOpen++;   // optional, not sent: not asked of the client (cut 2)
    if (s === 'Received')             counts.received++;
    else if (s === 'Reviewed')        counts.reviewed++;
    else if (s === 'Rework Required') { counts.rework++; rework.push(it); }
    else if (s === 'Not Applicable')  counts.na++;
    else                              counts.missing++;

    const cat = it.category || 'Other';
    const member = it.applicantType || 'Principal Applicant';
    const memberLabel = it.applicantLabel || member;         // what pages SHOW (a Super Visa's "Second parent")
    // id + notes + upload date power the Documents tab's INLINE actions
    // (mark reviewed / request rework) — not just the read-only summary.
    const row = {
      id:            it.id,
      name:          it.name,
      status:        s,
      applicantType: member,
      applicantLabel: memberLabel,
      lastUpload:    it.lastUpload || '',
      reviewNotes:   it.reviewNotes || '',
      // the reason split server-side: the cockpit script may carry no backslash
      optional:      it.optional === true,   // "Optional" tag (cut 2)
      naReason:      na.reasonOnly(it.naReason),
      naBy:          na.reasonBy(it.naReason),
    };
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(row);

    if (!memMap.has(member)) memMap.set(member, { label: memberLabel, cats: new Map() });
    const cm = memMap.get(member).cats;
    if (!cm.has(cat)) cm.set(cat, []);
    cm.get(cat).push(row);
  }

  const byCategory = [...catMap.entries()].map(([category, list]) => ({ category, items: list }));
  // Per-member view (applicantType → category → items), Principal Applicant first,
  // then spouse/children alphabetically — mirrors the standalone /d review page so
  // a consultant sees each member's documents grouped together inside the cockpit.
  const memberRank = (m) => (/principal applicant/i.test(m) ? 0 : 1);
  const byMember = [...memMap.entries()]
    .sort((a, b) => memberRank(a[0]) - memberRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([member, cm]) => ({ member: cm.label, applicantType: member, categories: [...cm.cats.entries()].map(([category, list]) => ({ category, items: list })) }));
  return { counts, byCategory, byMember, rework: rework.map((r) => ({ name: r.name, applicantType: r.applicantType, applicantLabel: r.applicantLabel || r.applicantType })),
    notApplicableEnabled: na.isReady() };
}

// ─── Lead link + derived timeline ────────────────────────────────────────────
//
// The case's LEAD record (pre-handoff pipeline) carries the consultation
// meeting artifacts and the retainer/milestone payment state. The link is
// one-directional (the lead stores clientMasterItemId), so we reverse-resolve.

/** The lead fields the cockpit tabs consume (null when no lead is linked). */
function pickLeadFields(lead) {
  if (!lead) return null;
  return {
    leadId:              lead.id,
    createdAt:           lead.createdAt || '',
    bookedSlot:          lead.bookedSlot || '',
    meetingType:         lead.meetingType || '',
    meetingLink:         lead.meetingLink || '',
    recordingLink:       lead.recordingLink || '',
    transcriptLink:      lead.transcriptLink || '',
    preConsultPdf:       lead.preConsultPdf || '',
    consultationHeld:    lead.consultationHeld || '',
    consultAgreementSent:   lead.consultAgreementSent || '',
    consultAgreementSigned: lead.consultAgreementSigned || '',
    inviteSentAt:        lead.inviteSentAt || '',
    assignedConsultant:  (lead.assignedConsultant || '').trim(),
    retainerFee:         lead.retainerFee || '',
    retainerSent:        lead.retainerSent || '',
    retainerSigned:      lead.retainerSigned || '',
    retainerPaid:        lead.retainerPaid || '',
    consultPaid:         Boolean((lead.squareConsultTxnId || '').trim()),
  };
}

/**
 * PURE: derive a chronological case timeline from the timestamps the system
 * already records — no new capture infrastructure. Events sort ascending;
 * dates are the raw stored strings (ISO or YYYY-MM-DD), display-truncated
 * client-side.
 *
 * @param {{ lead?: object|null, milestones?: Array, qMembers?: Array, docItems?: Array }} src
 * @returns {Array<{ date, title, detail, kind }>}
 */
function buildTimeline({ lead, milestones = [], qMembers = [], docItems = [] } = {}) {
  const ev = [];
  // Instants (the lead's arrival, a questionnaire submit) become Toronto wall-clock,
  // like every other date here, so the timeline shows Toronto time and sorts right.
  const push = (date, title, detail, kind) => {
    const d = torontoWallClock(date);
    if (d) ev.push({ date: d, title, detail: detail || '', kind });
  };
  const L = lead || {};

  push(L.createdAt,            'Inquiry received',            'Intake form submitted', 'lead');
  push(L.inviteSentAt,         'Booking invite sent',         '', 'lead');
  push(L.bookedSlot,           'Consultation scheduled',      L.meetingType ? `${L.meetingType} meeting` : '', 'meeting');
  push(L.consultationHeld,     'Consultation held',           L.assignedConsultant ? `with ${L.assignedConsultant}` : '', 'meeting');
  push(L.consultAgreementSent,   'Consultation agreement sent',   '', 'doc');
  push(L.consultAgreementSigned, 'Consultation agreement signed', '', 'doc');
  push(L.retainerSent,         'Retainer agreement sent',     '', 'retainer');
  push(L.retainerSigned,       'Retainer signed — case opened', '', 'retainer');
  push(L.retainerPaid,         'First retainer payment recorded', '', 'payment');

  for (const m of milestones) {
    const label = m.label || `Milestone ${Number(m.index) + 1}`;
    push(m.requestedAt, `e-Transfer requested — ${label}`, m.reference ? `ref ${m.reference}` : '', 'payment');
    // Part-payments on file (the one that settled the milestone is the "Paid" event below;
    // a row Square marked paid over part-payments has none — every entry shows).
    const parts = Array.isArray(m.payments) ? m.payments : [];
    const settlingAt = (m.settlingIndex != null) ? Number(m.settlingIndex) : (m.status === 'paid' ? parts.length - 1 : -1);
    parts.forEach((x, n) => {
      if (n === settlingAt) return;
      push(x.paidAt, `Part-payment — ${label}`, `$${(Math.round(x.amountCents || 0) / 100).toFixed(2)}${x.reference ? ` · ref ${x.reference}` : ''}`, 'payment');
    });
    push(m.paidAt,      `Paid — ${label}`,                 m.reference ? `ref ${m.reference}` : '', 'payment');
  }
  for (const q of qMembers) {
    push(q.submittedAt, `Questionnaire submitted — ${q.label || q.key || 'member'}`, '', 'questionnaire');
  }
  for (const doc of docItems) {
    push(doc.lastUpload, `Document received — ${doc.name}`, doc.applicantType || '', 'doc');
  }

  // Normalise "YYYY-MM-DD HH:mm" vs ISO 'T' separators so same-day events
  // sort by time regardless of stored format. Date-ONLY events (no time
  // component) sort at END of day — "by the end of that day this had
  // happened" — so e.g. "Consultation held" (a date column) never renders
  // before that same day's 15:00 scheduled slot. Ties keep insertion order
  // (Array.prototype.sort is stable), which follows the journey sequence.
  const sortKey = (d) => (/[T ]/.test(d) ? d.replace(' ', 'T') : d + 'T23:59');
  ev.sort((a, b) => sortKey(a.date).localeCompare(sortKey(b.date)));
  return ev;
}

/**
 * Best-effort lead link + payment state for a case. The lead is the
 * pre-handoff record (it stores clientMasterItemId, so we reverse-resolve);
 * legacy cases may have none. Shared by the staff cockpit AND the client
 * portal so both read the same shapes.
 *
 * @param {string} itemId  Client Master item id
 * @param {string} caseRef for log context only
 * @returns {Promise<{ lead: object|null, payments: object|null }>}
 */
async function getLeadExtras(itemId, caseRef) {
  let lead = null;
  try {
    lead = await require('./leadService').findByColumnValue('clientMasterItemId', String(itemId));
  } catch (e) {
    console.warn(`[Cockpit] lead lookup failed for ${caseRef}: ${e.message}`);
  }

  let payments = null;
  if (lead) {
    try {
      const rp = await require('./consultantPortalService').getRetainerPlan(lead.id);
      payments = {
        retainerFee:     rp.retainerFee || '',
        feeSet:          !!rp.feeSet,
        planSaved:       !!rp.saved,
        etransferEmail:  require('./milestonePaymentService').ETRANSFER_EMAIL,
        milestones:      rp.milestonePayments || [],
        currentCaseStage: rp.currentCaseStage || '',
      };
    } catch (e) {
      console.warn(`[Cockpit] payments read failed for ${caseRef}: ${e.message}`);
    }
  }
  return { lead, payments };
}

/**
 * Aggregate one case into a single overview snapshot for the staff cockpit.
 * @param {string} caseRef
 * @returns {Promise<object>} the unified snapshot (throws only if the case itself can't be resolved)
 */
async function getCaseOverview(caseRef) {
  const validated = await htmlQ.validateAccessForStaff(caseRef); // throws if case not found
  const { itemId, clientName, caseType, caseSubType, accessToken, formFiles } = validated;
  let qUnavailable = false;   // set by the questionnaire reads below

  // Fan out the independent reads; degrade each section to empty on failure.
  const [cm, docSummary, composition, members] = await Promise.all([
    readClientMaster(itemId).catch((e) => { console.warn(`[Cockpit] CM read failed for ${caseRef}: ${e.message}`); return { _unavailable: true }; }),
    documentFormSvc.getCaseSummary(caseRef).catch((e) => { console.warn(`[Cockpit] doc read failed for ${caseRef}: ${e.message}`); return { items: [], _unavailable: true }; }),   // _unavailable: the Reminders card says "could not be read", never "no rows" (review 2026-11-07)
    compositionAdapter.readForCase(caseRef).catch((e) => { console.warn(`[Cockpit] family read failed for ${caseRef}: ${e.message}`); return { members: [] }; }),
    htmlQ.loadMembers({ clientName, caseRef }).catch((e) => { console.warn(`[Cockpit] members read failed for ${caseRef}: ${e.message}`); qUnavailable = true; return []; }),
  ]);

  // Questionnaire member statuses (needs the member list + form files).
  // qUnavailable: the member list or a member file could not be read — the
  // reminders then leave the questionnaire out (never a nudge on a blip — the
  // portal's qUnavailable rule); the page still shows the degraded statuses.
  let qMembers = [];
  try {
    qMembers = await htmlQ.getMemberStatuses({ clientName, caseRef, members, formFiles });
  } catch (e) {
    console.warn(`[Cockpit] q-status read failed for ${caseRef}: ${e.message}`);
    qUnavailable = true;
    qMembers = members.map((m) => ({ ...m, status: m.submittedAt ? 'Submitted' : 'Not Started', hasData: false, completionPct: 0 }));
  }
  const questionnaire = {
    members:   require('../utils/familyRoleLabels').decorateMembers(caseType, qMembers, caseSubType).map((m) => ({ key: m.key, type: m.type, badge: m.badge || '', label: m.label, status: m.status, hasData: !!m.hasData, completionPct: Number(m.completionPct) || 0, submittedAt: torontoWallClock(m.submittedAt) })),
    submitted: qMembers.filter((m) => m.status === 'Submitted').length,
    total:     qMembers.length,
    unavailable: qUnavailable,                          // the reminders' "could not be read" (an empty list is unknown too)
    mondayDone:  cm._unavailable ? false : cm.qDone === true,   // the board's questionnaire status reads Done
  };

  const documents = summariseDocuments(docSummary.items || []);

  // ── Lead link → meetings, payments, timeline (all best-effort) ────────────
  // The lead is the pre-handoff record; legacy cases may have none, and each
  // section degrades to null/empty rather than failing the page.
  const { lead, payments } = await getLeadExtras(itemId, caseRef);

  // ── Sponsor / inviter (best-effort) ───────────────────────────────────────
  // Who the in-Canada partner is, whether their portal email went out, and
  // whether the button may send. Reads the claiming leads + the OneDrive
  // marker; any failure degrades to { available:false } (card hidden).
  const sponsor = await require('./sponsorOnboardingService').describe({
    itemId, caseRef, clientName, caseType, caseSubType,
    clientEmail:   cm._unavailable ? null : cm.clientEmail,
    cmUnavailable: cm._unavailable === true,
    caseStage:     cm._unavailable ? '' : (cm.caseStage || 'Not Started'),
    paymentStatus: cm._unavailable ? '' : (cm.paymentStatus || 'Unpaid'),
    composition, qMembers,
  }).catch((e) => { console.warn(`[Cockpit] sponsor read failed for ${caseRef}: ${e.message}`); return { available: false }; });

  const timeline = buildTimeline({
    lead,
    milestones: (payments && payments.milestones) || [],
    qMembers:   members || [],
    docItems:   docSummary.items || [],
  });

  // ── Document reminders (block 2): the card's facts from the reads above ───
  // The three buttons + the "Sent:" line; the record is the case's notes (read
  // with the Client Master columns). Hidden with its reason when the case has
  // no email / no access code / no checklist rows, or the CM read failed.
  const group = cm.group || { id: '', title: '' };
  const automationLock = cm._unavailable ? '' : (cm.automationLock || '');
  const manualOverride = cm._unavailable ? '' : (cm.manualOverride || '');
  const caseStage = cm._unavailable ? '' : (cm.caseStage || 'Not Started');
  const paymentStatus = cm._unavailable ? '' : (cm.paymentStatus || 'Unpaid');
  const clientDeadlineRaw = cm.clientDeadlineRaw || { type: '', actualDeadline: '', promisedSubmissionDate: '' };
  const reminders = require('./docReminderService').describeForCase({
    overview: { cmUnavailable: cm._unavailable === true, clientEmail: cm.clientEmail || '', accessToken, group, automationLock, manualOverride, caseStage, paymentStatus },
    items: docSummary.items || [],
    docsUnavailable: docSummary._unavailable === true,
    notes: cm.notes || [],
    notesLimit: CM_NOTES_LIMIT,   // the card says "Sent (recent notes)": the facts come from the newest 100, never a second read
    questionnaire,                // the buttons also work when only the questionnaire is unfinished (Gauri's texts, 2026-11-07)
  });

  return {
    caseRef,
    itemId,
    clientName,
    caseType:    caseType || '—',
    caseSubType: caseSubType || null,
    // the member types the "Add family member" form may offer (the questionnaire's own list)
    familyAddTypes: require('../../config/questionnaireFormMap').resolveMemberTypes(caseType, caseSubType),
    accessToken,
    // When the Client Master read transiently failed, do NOT present fabricated
    // 'Unpaid / Not Started' defaults as if authoritative — flag it so the
    // cockpit renders an explicit 'unavailable — reload' state for these pills.
    cmUnavailable:   cm._unavailable === true,
    clientEmail:     cm.clientEmail || '',
    manager:         cm.manager || 'Unassigned',
    assignees:       cm.assignees || { personIds: [], teamIds: [] }, // for per-user access control
    paymentStatus,
    caseStage,
    health:          cm.health || '—',
    slaRisk:         cm.slaRisk || '—',
    deadline:        cm.deadline || '',
    clientDeadline:  cm._unavailable ? '' : (cm.clientDeadline || 'Not set'),   // the client's own deadline (block 1) — the case page pill (review 2026-11-06: it was read but never passed on)
    clientDeadlineRaw,          // { type, actualDeadline, promisedSubmissionDate } as stored (the reminders' merge fields)
    group,                      // the board group ({ id, title }) — a reminder goes only from a live case group
    automationLock,             // 'Yes' = the reminders refuse (the ladder's own gate)
    manualOverride,             // 'Yes' = the reminders refuse (plan §3b condition 4)
    escalationLastNotified: cm._unavailable ? '' : (cm.escalationLastNotified || ''),   // the escalation engine's rule-match stamp — a preview warning on the buttons only
    reminders,                  // the Reminders card: { available, reason, message, canSend, blocked, sent, auto, failures }
    // Questionnaire % from the SAVED ANSWERS when they could be read (the
    // Monday number used to be written only at Submit); Monday is the fallback.
    qReadinessPct:   htmlQ.deriveQuestionnaireProgress({ members: qMembers, mondayPct: cm.qReadinessPct || 0 }).pct,
    // Document progress = client uploads; the rarely-set staff-Reviewed % is
    // its own field so the cockpit can show both honestly.
    docReadinessPct: cm.docReadinessPct || 0,
    docReviewedPct:  cm.docReviewedPct || 0,
    portalLink:      cm.portalLink || '',
    folderLink:      cm.folderLink || '',
    family: (composition.members || []).map((m) => ({
      role:      m.role,
      name:      m.name || '',
      memberKey: m.memberKey || '',
      flags:     Object.keys(m.flags || {}),
    })),
    questionnaire,
    documents,
    lead: pickLeadFields(lead),
    payments,
    timeline,
    sponsor,
  };
}

module.exports = { getCaseOverview, getLeadExtras, buildTimeline, summariseDocuments, pickLeadFields, readClientMaster, _CM: CM };
