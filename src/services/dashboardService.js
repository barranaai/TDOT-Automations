/**
 * Dashboard Service
 * Fetches all Client Master Board items and aggregates them
 * into stats for the Owner / Manager dashboard.
 */

const mondayApi           = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const COLS = {
  caseRef:            'text_mm142s49',
  caseType:           'dropdown_mm0xd1qn',
  caseStage:          'color_mm0x8faa',
  slaRiskBand:        'color_mm0xszmm',
  caseHealthStatus:   'color_mm0xf5ry',
  expiryRiskFlag:     'color_mm1a7vbn',
  escalationRequired: 'color_mm0x7bje',
  qReadiness:         'numeric_mm0x9dea',
  docReadiness:       'numeric_mm0x5g9x',
  daysElapsed:        'numeric_mm0x58n1',
  clientBlockedStatus:'color_mm1b5gqv',
  chasingStage:       'color_mm1abve4',
  reminderCount:      'numeric_mm1a4e8r',
  caseManager:        'multiple_person_mm0xhmgk',
  opsSupervisor:      'multiple_person_mm0xp0sq',
  lastActivityDate:   'date_mm1amqyr',
  hardDeadline:       'date_mm0x5pqd',
  // ── Additional operational columns ──────────────────────────────────────────
  blockingQCount:     'numeric_mm0xbpn1',
  blockingDocCount:   'numeric_mm0xje6p',
  missingRequired:    'numeric_mm0x6qy4',
  clientDelayLevel:   'color_mm1bq05h',
  expectedReadiness:  'numeric_mm0xrbk1',
};

const COL_IDS = Object.values(COLS);

// ─── Fetch all items with cursor-based pagination ─────────────────────────────
async function fetchAllItems() {
  const items  = [];
  let   cursor = null;

  do {
    const data = await mondayApi.query(
      `query($boardId: ID!, $cursor: String) {
         boards(ids: [$boardId]) {
           items_page(limit: 100, cursor: $cursor) {
             cursor
             items {
               id name
               column_values(ids: [${COL_IDS.map((id) => `"${id}"`).join(',')}]) { id text }
             }
           }
         }
       }`,
      { boardId: String(clientMasterBoardId), cursor: cursor || undefined }
    );

    const page = data?.boards?.[0]?.items_page;
    if (!page) break;
    items.push(...(page.items || []));
    cursor = page.cursor || null;
  } while (cursor);

  return items;
}

// ─── Parse one Monday item into a clean object ────────────────────────────────
function toNum(text) {
  const n = parseFloat((text || '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function parseItem(item) {
  const col = (id) => item.column_values?.find((c) => c.id === id)?.text?.trim() || '';

  const qR       = toNum(col(COLS.qReadiness));
  const docR     = toNum(col(COLS.docReadiness));
  const hasR     = qR > 0 || docR > 0;
  const overall  = hasR ? Math.round((qR + docR) / 2) : 0;
  const expected = toNum(col(COLS.expectedReadiness));

  return {
    id:                 item.id,
    clientName:         (item.name || '').trim(),
    caseRef:            col(COLS.caseRef),
    caseType:           col(COLS.caseType)  || 'Unknown',
    caseStage:          col(COLS.caseStage) || 'Unknown',
    slaRisk:            col(COLS.slaRiskBand)       || 'Green',
    health:             col(COLS.caseHealthStatus)  || 'Green',
    escalationRequired: col(COLS.escalationRequired) === 'Yes',
    expiryFlagged:      col(COLS.expiryRiskFlag)    === 'Flagged',
    clientBlocked:      col(COLS.clientBlockedStatus) === 'Yes',
    chasingStage:       col(COLS.chasingStage)  || '',
    reminderCount:      toNum(col(COLS.reminderCount)),
    qReadiness:         qR,
    docReadiness:       docR,
    overallReadiness:   overall,
    expectedReadiness:  expected,
    // A case is "behind schedule" when actual is 15+ pts below expected (and expected > 0)
    behindSchedule:     expected > 0 && overall < expected - 15,
    blockingQ:          toNum(col(COLS.blockingQCount)),
    blockingDoc:        toNum(col(COLS.blockingDocCount)),
    missingRequired:    toNum(col(COLS.missingRequired)),
    delayLevel:         col(COLS.clientDelayLevel) || '',
    daysElapsed:        toNum(col(COLS.daysElapsed)),
    manager:            col(COLS.caseManager)    || 'Unassigned',
    supervisor:         col(COLS.opsSupervisor)  || '',
    lastActivity:       col(COLS.lastActivityDate),
    hardDeadline:       col(COLS.hardDeadline),
  };
}

// ─── Aggregate all cases into dashboard stats ─────────────────────────────────
async function getDashboardStats() {
  const rawItems = await fetchAllItems();
  const cases    = rawItems.map(parseItem);

  // Summary counters
  const summary = {
    total:             cases.length,
    red:               0,
    orange:            0,
    green:             0,
    clientBlocked:     0,
    escalationOpen:    0,
    expiryFlagged:     0,
    avgReadiness:      0,
    avgQReadiness:     0,
    avgDocReadiness:   0,
    inactiveCount:     0,
    deadlineSoonCount: 0,
    unassignedCount:   0,
    casesWithBlocking: 0,
    behindScheduleCount: 0,
    totalMissingDocs:  0,
  };

  const byStage        = {};
  const byHealth       = {};
  const bySlaRisk      = {};
  const byType         = {};
  const byChasingStage = {};
  const byDelayLevel   = {};
  const readinessByStage = {}; // { stage: { count, actualSum, expectedSum } }

  // byManager tracks extra fields now
  const byManager = {};

  let readinessSum    = 0;
  let qReadinessSum   = 0;
  let docReadinessSum = 0;
  let readinessCaseCount = 0;

  for (const c of cases) {
    const h = (c.health || 'Green');

    // ── Health summary ──────────────────────────────────────────────────────
    if      (h === 'Red')    summary.red++;
    else if (h === 'Orange') summary.orange++;
    else                     summary.green++;
    if (c.clientBlocked)      summary.clientBlocked++;
    if (c.escalationRequired) summary.escalationOpen++;
    if (c.expiryFlagged)      summary.expiryFlagged++;

    // ── Readiness ───────────────────────────────────────────────────────────
    readinessSum    += c.overallReadiness;
    qReadinessSum   += c.qReadiness;
    docReadinessSum += c.docReadiness;
    if (c.qReadiness > 0 || c.docReadiness > 0) readinessCaseCount++;

    // ── Operational ────────────────────────────────────────────────────────
    if (!c.manager || c.manager === 'Unassigned') summary.unassignedCount++;
    if (c.blockingQ > 0 || c.blockingDoc > 0)    summary.casesWithBlocking++;
    if (c.behindSchedule)                         summary.behindScheduleCount++;
    summary.totalMissingDocs += c.missingRequired;

    // ── Inactive ────────────────────────────────────────────────────────────
    const lastAct = c.lastActivity ? new Date(c.lastActivity) : null;
    const daysSinceActivity = (lastAct && !isNaN(lastAct.getTime()))
      ? Math.floor((Date.now() - lastAct.getTime()) / 86400000)
      : 999;
    if (daysSinceActivity >= 14) summary.inactiveCount++;

    // ── Deadline soon ───────────────────────────────────────────────────────
    if (c.hardDeadline) {
      const dl = new Date(c.hardDeadline);
      if (!isNaN(dl.getTime())) {
        const daysUntil = Math.floor((dl.getTime() - Date.now()) / 86400000);
        if (daysUntil >= 0 && daysUntil <= 30) summary.deadlineSoonCount++;
      }
    }

    // ── Breakdowns ──────────────────────────────────────────────────────────
    const stage = c.caseStage || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    byHealth[h] = (byHealth[h] || 0) + 1;

    const risk = c.slaRisk || 'Green';
    bySlaRisk[risk] = (bySlaRisk[risk] || 0) + 1;

    const type = c.caseType || 'Unknown';
    byType[type] = (byType[type] || 0) + 1;

    const cs = c.chasingStage || 'Pending';
    byChasingStage[cs] = (byChasingStage[cs] || 0) + 1;

    const dl = c.delayLevel || 'None';
    byDelayLevel[dl] = (byDelayLevel[dl] || 0) + 1;

    // ── Readiness vs Expected by stage ──────────────────────────────────────
    if (!readinessByStage[stage]) {
      readinessByStage[stage] = { count: 0, actualSum: 0, expectedSum: 0 };
    }
    readinessByStage[stage].count++;
    readinessByStage[stage].actualSum   += c.overallReadiness;
    readinessByStage[stage].expectedSum += c.expectedReadiness;

    // ── By manager ──────────────────────────────────────────────────────────
    const managers = c.manager.split(/,\s*/).map((m) => m.trim()).filter(Boolean);
    for (const mgr of managers) {
      if (mgr === 'Unassigned') continue;
      if (!byManager[mgr]) {
        byManager[mgr] = {
          total: 0, red: 0, orange: 0, green: 0,
          totalReadiness: 0, blockingCount: 0, behindCount: 0,
        };
      }
      byManager[mgr].total++;
      byManager[mgr][h.toLowerCase()] = (byManager[mgr][h.toLowerCase()] || 0) + 1;
      byManager[mgr].totalReadiness  += c.overallReadiness;
      if (c.blockingQ > 0 || c.blockingDoc > 0) byManager[mgr].blockingCount++;
      if (c.behindSchedule)                      byManager[mgr].behindCount++;
    }
  }

  // ── Finalise per-manager averages ──────────────────────────────────────────
  for (const mgr of Object.keys(byManager)) {
    const m = byManager[mgr];
    m.avgReadiness = m.total > 0 ? Math.round(m.totalReadiness / m.total) : 0;
    const greenPct = m.total > 0 ? m.green / m.total : 0;
    m.score = Math.round(greenPct * 60 + (m.avgReadiness / 100) * 40);
    delete m.totalReadiness;
  }

  // ── Finalise readiness by stage ────────────────────────────────────────────
  for (const s of Object.keys(readinessByStage)) {
    const r = readinessByStage[s];
    r.avgActual   = r.count > 0 ? Math.round(r.actualSum   / r.count) : 0;
    r.avgExpected = r.count > 0 ? Math.round(r.expectedSum / r.count) : 0;
    delete r.actualSum;
    delete r.expectedSum;
  }

  // ── Finalise summary averages ──────────────────────────────────────────────
  summary.avgReadiness    = cases.length > 0 ? Math.round(readinessSum    / cases.length) : 0;
  summary.avgQReadiness   = cases.length > 0 ? Math.round(qReadinessSum   / cases.length) : 0;
  summary.avgDocReadiness = cases.length > 0 ? Math.round(docReadinessSum / cases.length) : 0;

  return {
    summary,
    byStage,
    byHealth,
    bySlaRisk,
    byType,
    byManager,
    byChasingStage,
    byDelayLevel,
    readinessByStage,
    cases,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getDashboardStats };
