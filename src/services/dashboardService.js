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

  const qR    = toNum(col(COLS.qReadiness));
  const docR  = toNum(col(COLS.docReadiness));
  const hasR  = qR > 0 || docR > 0;
  const overall = hasR ? Math.round((qR + docR) / 2) : 0;

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
    total:          cases.length,
    red:            0,
    orange:         0,
    green:          0,
    clientBlocked:  0,
    escalationOpen: 0,
    expiryFlagged:  0,
    avgReadiness:   0,
  };

  const byStage      = {};
  const byHealth     = {};
  const bySlaRisk    = {};
  const byType       = {};
  const byManager    = {}; // { name: { total, red, orange, green, totalReadiness } }
  const byChasingStage = {};

  let readinessSum    = 0;
  let qReadinessSum   = 0;
  let docReadinessSum = 0;
  let readinessCaseCount = 0;
  let inactiveCount   = 0;
  let deadlineSoonCount = 0;

  for (const c of cases) {
    const h = (c.health || 'Green');

    // Summary
    if      (h === 'Red')    summary.red++;
    else if (h === 'Orange') summary.orange++;
    else                     summary.green++;
    if (c.clientBlocked)      summary.clientBlocked++;
    if (c.escalationRequired) summary.escalationOpen++;
    if (c.expiryFlagged)      summary.expiryFlagged++;
    readinessSum += c.overallReadiness;

    // Separate Q vs Doc readiness
    qReadinessSum   += c.qReadiness;
    docReadinessSum += c.docReadiness;
    if (c.qReadiness > 0 || c.docReadiness > 0) readinessCaseCount++;

    // Chasing stage breakdown
    const cs = c.chasingStage || 'Pending';
    byChasingStage[cs] = (byChasingStage[cs] || 0) + 1;

    // Inactive cases (no activity in 14+ days)
    const lastAct = c.lastActivity ? new Date(c.lastActivity) : null;
    const daysSinceActivity = lastAct ? Math.floor((Date.now() - lastAct.getTime()) / 86400000) : 999;
    if (daysSinceActivity >= 14) inactiveCount++;

    // Deadline-soon cases (hardDeadline within next 30 days)
    if (c.hardDeadline) {
      const dl = new Date(c.hardDeadline);
      const daysUntil = Math.floor((dl.getTime() - Date.now()) / 86400000);
      if (daysUntil >= 0 && daysUntil <= 30) deadlineSoonCount++;
    }

    // By stage
    const stage = c.caseStage || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    // By health
    byHealth[h] = (byHealth[h] || 0) + 1;

    // By SLA risk
    const risk = c.slaRisk || 'Green';
    bySlaRisk[risk] = (bySlaRisk[risk] || 0) + 1;

    // By case type (shorten long names)
    const type = c.caseType || 'Unknown';
    byType[type] = (byType[type] || 0) + 1;

    // By manager — one case can have multiple managers (comma-separated names)
    const managers = c.manager.split(',').map((m) => m.trim()).filter(Boolean);
    for (const mgr of managers) {
      if (!byManager[mgr]) {
        byManager[mgr] = { total: 0, red: 0, orange: 0, green: 0, totalReadiness: 0 };
      }
      byManager[mgr].total++;
      const key = h.toLowerCase();
      byManager[mgr][key] = (byManager[mgr][key] || 0) + 1;
      byManager[mgr].totalReadiness += c.overallReadiness;
    }
  }

  // Finalise per-manager averages
  for (const mgr of Object.keys(byManager)) {
    const m = byManager[mgr];
    m.avgReadiness = m.total > 0 ? Math.round(m.totalReadiness / m.total) : 0;
    // Performance score: higher green %, higher readiness = better
    const greenPct = m.total > 0 ? m.green / m.total : 0;
    m.score = Math.round(greenPct * 60 + (m.avgReadiness / 100) * 40);
    delete m.totalReadiness;
  }

  summary.avgReadiness = cases.length > 0
    ? Math.round(readinessSum / cases.length)
    : 0;

  summary.avgQReadiness   = readinessCaseCount > 0 ? Math.round(qReadinessSum   / cases.length) : 0;
  summary.avgDocReadiness = readinessCaseCount > 0 ? Math.round(docReadinessSum / cases.length) : 0;
  summary.inactiveCount      = inactiveCount;
  summary.deadlineSoonCount  = deadlineSoonCount;

  return {
    summary,
    byStage,
    byHealth,
    bySlaRisk,
    byType,
    byManager,
    byChasingStage,
    cases,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getDashboardStats };
