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

async function readClientMaster(itemId) {
  const ids = Object.values(CM).map((c) => `"${c}"`).join(', ');
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
      name:          it.name,
      status:        s,
      applicantType: it.applicantType || 'Principal Applicant',
    });
  }

  const byCategory = [...catMap.entries()].map(([category, list]) => ({ category, items: list }));
  return { counts, byCategory, rework: rework.map((r) => ({ name: r.name, applicantType: r.applicantType })) };
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

  return {
    caseRef,
    itemId,
    clientName,
    caseType:    caseType || '—',
    caseSubType: caseSubType || null,
    accessToken,
    clientEmail:     cm.clientEmail || '',
    manager:         cm.manager || 'Unassigned',
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
      members:   qMembers.map((m) => ({ key: m.key, type: m.type, label: m.label, status: m.status, hasData: !!m.hasData })),
      submitted: qMembers.filter((m) => m.status === 'Submitted').length,
      total:     qMembers.length,
    },
    documents,
  };
}

module.exports = { getCaseOverview, _CM: CM };
