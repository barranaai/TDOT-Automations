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
 *     questionnaire: { members:[{ key, type, label, status, hasData }], submitted, total },
 *     documents:     { counts:{ total, received, reviewed, rework, missing },
 *                      byCategory:[{ category, items:[...] }], rework:[...] },
 *   }
 */

'use strict';

const mondayApi          = require('./mondayApi');
const htmlQ              = require('./htmlQuestionnaireService');
const documentFormSvc    = require('./documentFormService');
const compositionAdapter = require('./compositionAdapter');
const { clientMasterBoardId } = require('../../config/monday');

// Client Master columns this aggregator reads. IDs verified against the live
// readers in chasingLoopService / dashboardService / config (single source).
const CM = {
  caseRef:        'text_mm142s49',
  clientEmail:    'text_mm0xw6bp',
  caseStage:      'color_mm0x8faa',
  paymentStatus:  'color_mm0x9fnn',
  qReadiness:     'numeric_mm0x9dea',
  docReadiness:   'numeric_mm0x5g9x',
  caseHealth:     'color_mm0xf5ry',
  slaRiskBand:    'color_mm0xszmm',
  caseManager:    'multiple_person_mm0xhmgk',
  hardDeadline:   'date_mm0x5pqd',
  portalLink:     'link_mm2vta5',
  folderLink:     'link_mm47dng8',
};

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
       items(ids: [$itemId]) {
         column_values(ids: [${ids}]) { id text value }
       }
     }`,
    { itemId: String(itemId) }
  );
  const cols = data?.items?.[0]?.column_values || [];
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
    docReadinessPct: clampPct(txt(CM.docReadiness)),
    health:          txt(CM.caseHealth) || '—',
    slaRisk:         txt(CM.slaRiskBand) || '—',
    manager:         txt(CM.caseManager) || 'Unassigned',
    deadline:        txt(CM.hardDeadline) || '',
    portalLink:      linkUrl(by[CM.portalLink]?.value) || txt(CM.portalLink),
    folderLink:      linkUrl(by[CM.folderLink]?.value) || txt(CM.folderLink),
    assignees:       caseAccess.assigneesFromColumnValues(valueByColId), // { personIds, teamIds }
  };
}

function summariseDocuments(items) {
  const counts = { total: items.length, received: 0, reviewed: 0, rework: 0, missing: 0 };
  const rework = [];
  const catMap = new Map();

  for (const it of items) {
    const s = it.status || 'Missing';
    if (s === 'Received')             counts.received++;
    else if (s === 'Reviewed')        counts.reviewed++;
    else if (s === 'Rework Required') { counts.rework++; rework.push(it); }
    else                              counts.missing++;

    const cat = it.category || 'Other';
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push({
      // id + notes + upload date power the Documents tab's INLINE actions
      // (mark reviewed / request rework) — not just the read-only summary.
      id:            it.id,
      name:          it.name,
      status:        s,
      applicantType: it.applicantType || 'Principal Applicant',
      lastUpload:    it.lastUpload || '',
      reviewNotes:   it.reviewNotes || '',
    });
  }

  const byCategory = [...catMap.entries()].map(([category, list]) => ({ category, items: list }));
  return { counts, byCategory, rework: rework.map((r) => ({ name: r.name, applicantType: r.applicantType })) };
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
  const push = (date, title, detail, kind) => {
    const d = String(date || '').trim();
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

  // Fan out the independent reads; degrade each section to empty on failure.
  const [cm, docSummary, composition, members] = await Promise.all([
    readClientMaster(itemId).catch((e) => { console.warn(`[Cockpit] CM read failed for ${caseRef}: ${e.message}`); return {}; }),
    documentFormSvc.getCaseSummary(caseRef).catch((e) => { console.warn(`[Cockpit] doc read failed for ${caseRef}: ${e.message}`); return { items: [] }; }),
    compositionAdapter.readForCase(caseRef).catch((e) => { console.warn(`[Cockpit] family read failed for ${caseRef}: ${e.message}`); return { members: [] }; }),
    htmlQ.loadMembers({ clientName, caseRef }).catch((e) => { console.warn(`[Cockpit] members read failed for ${caseRef}: ${e.message}`); return []; }),
  ]);

  // Questionnaire member statuses (needs the member list + form files).
  let qMembers = [];
  try {
    qMembers = await htmlQ.getMemberStatuses({ clientName, caseRef, members, formFiles });
  } catch (e) {
    console.warn(`[Cockpit] q-status read failed for ${caseRef}: ${e.message}`);
    qMembers = members.map((m) => ({ ...m, status: m.submittedAt ? 'Submitted' : 'Not Started' }));
  }

  const documents = summariseDocuments(docSummary.items || []);

  // ── Lead link → meetings, payments, timeline (all best-effort) ────────────
  // The lead is the pre-handoff record; legacy cases may have none, and each
  // section degrades to null/empty rather than failing the page.
  const { lead, payments } = await getLeadExtras(itemId, caseRef);

  const timeline = buildTimeline({
    lead,
    milestones: (payments && payments.milestones) || [],
    qMembers:   members || [],
    docItems:   docSummary.items || [],
  });

  return {
    caseRef,
    itemId,
    clientName,
    caseType:    caseType || '—',
    caseSubType: caseSubType || null,
    accessToken,
    clientEmail:     cm.clientEmail || '',
    manager:         cm.manager || 'Unassigned',
    assignees:       cm.assignees || { personIds: [], teamIds: [] }, // for per-user access control
    paymentStatus:   cm.paymentStatus || 'Unpaid',
    caseStage:       cm.caseStage || 'Not Started',
    health:          cm.health || '—',
    slaRisk:         cm.slaRisk || '—',
    deadline:        cm.deadline || '',
    qReadinessPct:   cm.qReadinessPct || 0,
    docReadinessPct: cm.docReadinessPct || 0,
    portalLink:      cm.portalLink || '',
    folderLink:      cm.folderLink || '',
    family: (composition.members || []).map((m) => ({
      role:      m.role,
      name:      m.name || '',
      memberKey: m.memberKey || '',
      flags:     Object.keys(m.flags || {}),
    })),
    questionnaire: {
      members:   qMembers.map((m) => ({ key: m.key, type: m.type, label: m.label, status: m.status, hasData: !!m.hasData, submittedAt: m.submittedAt || '' })),
      submitted: qMembers.filter((m) => m.status === 'Submitted').length,
      total:     qMembers.length,
    },
    documents,
    lead: pickLeadFields(lead),
    payments,
    timeline,
  };
}

module.exports = { getCaseOverview, getLeadExtras, buildTimeline, summariseDocuments, pickLeadFields, _CM: CM };
