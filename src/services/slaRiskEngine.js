const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const SLA_BOARD_ID = process.env.MONDAY_SLA_CONFIG_BOARD_ID || '18402401449';

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseStage:            'color_mm0x8faa',
  stageStartDate:       'date_mm0xjm1z',
  caseType:             'dropdown_mm0xd1qn',
  daysElapsed:          'numeric_mm0x58n1',
  slaTotalDays:         'numeric_mm0x9mjz',
  stageExpectedDuration:'numeric_mm0xg6pw',   // Stage Expected Duration (from SLA Config)
  expectedReadiness:    'numeric_mm0xrbk1',
  slaRiskBand:          'color_mm0xszmm',
  caseHealthStatus:     'color_mm0xf5ry',
  slaRiskFlag:          'color_mm1ar8sh',     // Flagged / Clear
  expiryRiskFlag:       'color_mm1a7vbn',     // Flagged / Clear
  passportExpiry:       'date_mm0xe7fp',
  ieltsExpiry:          'date_mm0xvb0g',
  medicalExpiry:        'date_mm0x8c3t',
  qReadiness:           'numeric_mm0x9dea',
  docReadiness:         'numeric_mm0x5g9x',
  hardDeadline:         'date_mm0x5pqd',
  softDeadline:         'date_mm0x26t4',
  submissionPrepDeadline: 'date_mm0xfgbp',
};

// ─── Column IDs — SLA Config Board ───────────────────────────────────────────
const SLA_COLS = {
  slaTotalDays:        'numeric_mm13xx3y',
  urgencyWeight:       'numeric_mm13re1s',
  expirySensitivity:   'numeric_mm13rz8j',
  minThreshold:        'numeric_mm13t15j',
  profileActive:       'color_mm1361s8',
  orangeThreshold:     'numeric_mm1adysk',   // editable per case type
  redThreshold:        'numeric_mm1ayq6w',   // editable per case type
  expiryWarningDays:   'numeric_mm1a5694',   // editable per case type
  hardDeadlineOffset:  'numeric_mm13z1k',    // days buffer before SLA end → Hard Deadline
  softDeadlineOffset:  'numeric_mm13mqh2',   // days buffer before SLA end → Soft Deadline
};

// Stages the engine processes (skip submitted/closed cases)
const ACTIVE_STAGES = new Set([
  'Document Collection Started',
  'Internal Review',
  'Submission Preparation',
  'Stuck',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addDays(dateStr, days) {
  if (!dateStr || days == null) return null;
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function daysBetween(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today - start) / 86400000));
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const expiry = new Date(dateStr);
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((expiry - today) / 86400000);
}

function toNum(text) {
  const n = parseFloat(text);
  return isNaN(n) ? 0 : n;
}

/**
 * Risk band using thresholds read directly from the SLA Config Board.
 * Both values are fully editable per case type in Monday.com.
 */
function calcRiskBand(pctTimeConsumed, orangeThreshold, redThreshold) {
  if (pctTimeConsumed >= redThreshold)    return 'Red';
  if (pctTimeConsumed >= orangeThreshold) return 'Orange';
  return 'Green';
}

/**
 * Case health considers both time pressure and actual progress.
 * Green = on track, Orange = slightly behind, Red = significantly behind or critical time
 */
function calcHealthStatus(riskBand, qReadiness, docReadiness, expectedReadiness) {
  if (riskBand === 'Red') return 'Red';
  const avgReadiness = (qReadiness + docReadiness) / 2;
  const gap = expectedReadiness - avgReadiness;
  if (gap > 25) return 'Red';
  if (gap > 5 || riskBand === 'Orange') return 'Orange';
  return 'Green';
}

// ─── Load SLA profiles ────────────────────────────────────────────────────────

async function loadSLAProfiles() {
  const data = await mondayApi.query(
    `{
       boards(ids: ["${SLA_BOARD_ID}"]) {
         items_page(limit: 100) {
           items {
             name
             column_values(ids: [
               "${SLA_COLS.slaTotalDays}",
               "${SLA_COLS.urgencyWeight}",
               "${SLA_COLS.expirySensitivity}",
               "${SLA_COLS.minThreshold}",
               "${SLA_COLS.profileActive}",
               "${SLA_COLS.orangeThreshold}",
               "${SLA_COLS.redThreshold}",
               "${SLA_COLS.expiryWarningDays}",
               "${SLA_COLS.hardDeadlineOffset}",
               "${SLA_COLS.softDeadlineOffset}"
             ]) { id text }
           }
         }
       }
     }`
  );

  const profiles = {};
  for (const item of data.boards[0].items_page.items) {
    const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    if (col(SLA_COLS.profileActive) !== 'Yes') continue;
    const slaTotalDays = toNum(col(SLA_COLS.slaTotalDays)) || 60;
    profiles[item.name] = {
      slaTotalDays,
      urgencyWeight:      toNum(col(SLA_COLS.urgencyWeight))     || 5,
      expirySensitivity:  toNum(col(SLA_COLS.expirySensitivity)) || 5,
      minThreshold:       toNum(col(SLA_COLS.minThreshold))      || 80,
      orangeThreshold:    toNum(col(SLA_COLS.orangeThreshold))   || 60,
      redThreshold:       toNum(col(SLA_COLS.redThreshold))      || 80,
      expiryWarningDays:  toNum(col(SLA_COLS.expiryWarningDays)) || 90,
      // Deadline dates are computed as: Stage Start + (SLA Total − offset)
      // A larger offset = more buffer before the SLA period ends
      hardDeadlineOffset: toNum(col(SLA_COLS.hardDeadlineOffset)) || 5,
      softDeadlineOffset: toNum(col(SLA_COLS.softDeadlineOffset)) || 10,
    };
  }
  console.log(`[SLAEngine] Loaded ${Object.keys(profiles).length} SLA profiles`);
  return profiles;
}

// ─── Fetch active cases ───────────────────────────────────────────────────────

async function fetchActiveCases() {
  const FETCH_IDS = [
    CM.caseStage, CM.stageStartDate, CM.caseType,
    CM.qReadiness, CM.docReadiness,
    CM.passportExpiry, CM.ieltsExpiry, CM.medicalExpiry,
  ];

  let items  = [];
  let cursor = null;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items {
                 id name
                 column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value }
               }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items {
                 id name
                 column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value }
               }
             }
           }
         }`
      );
    }

    const page = data.boards[0].items_page;
    items  = items.concat(page.items);
    cursor = page.cursor || null;
  } while (cursor);

  return items;
}

// ─── Process one case ─────────────────────────────────────────────────────────

function processCase(item, profiles) {
  const col       = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  const caseStage = col(CM.caseStage);

  if (!ACTIVE_STAGES.has(caseStage)) return null;

  const caseType  = col(CM.caseType);
  const startDate = col(CM.stageStartDate);
  if (!startDate) return null;

  const profile = profiles[caseType] || {
    slaTotalDays: 60, urgencyWeight: 5, expirySensitivity: 5, minThreshold: 80,
    orangeThreshold: 60, redThreshold: 80, expiryWarningDays: 90,
    hardDeadlineOffset: 5, softDeadlineOffset: 10,
  };

  const daysElapsed  = daysBetween(startDate);
  const slaTotalDays = profile.slaTotalDays;

  // Deadline dates — derived from Stage Start Date and SLA config offsets
  // Hard Deadline = start + (SLA days − hard offset) = latest possible internal deadline
  // Soft Deadline = start + (SLA days − soft offset) = "should be done" date
  // Submission Prep Deadline = 7 days before Soft Deadline = when all docs must be compiled
  const hardDeadline         = addDays(startDate, slaTotalDays - profile.hardDeadlineOffset);
  const softDeadline         = addDays(startDate, slaTotalDays - profile.softDeadlineOffset);
  const submissionPrepDeadline = addDays(softDeadline, -7);
  const pctConsumed   = slaTotalDays > 0 ? Math.round((daysElapsed / slaTotalDays) * 100) : 0;
  const expectedReady = Math.min(pctConsumed, 100);

  const qReadiness   = toNum(col(CM.qReadiness));
  const docReadiness = toNum(col(CM.docReadiness));

  // Both thresholds come directly from the SLA Config Board row for this case type
  const riskBand     = calcRiskBand(pctConsumed, profile.orangeThreshold, profile.redThreshold);
  const healthStatus = calcHealthStatus(riskBand, qReadiness, docReadiness, expectedReady);
  const slaFlagged   = riskBand !== 'Green';

  // Expiry window comes directly from the SLA Config Board row
  const expiryDays  = profile.expiryWarningDays;
  const expiryDates = [col(CM.passportExpiry), col(CM.ieltsExpiry), col(CM.medicalExpiry)];
  const daysToExpiries = expiryDates
    .map((d) => (d ? daysUntil(d) : Infinity))
    .filter((d) => d >= 0);
  const minDaysToExpiry = daysToExpiries.length ? Math.min(...daysToExpiries) : Infinity;
  const expiryFlagged   = minDaysToExpiry <= expiryDays;
  const expiryCritical  = minDaysToExpiry <= 30; // always a hard critical threshold

  // If expiry is flagged, force risk band up — expiry risk overrides SLA time assessment
  let finalRiskBand = riskBand;
  if (expiryFlagged) {
    if (expiryCritical) finalRiskBand = 'Red';
    else if (finalRiskBand === 'Green') finalRiskBand = 'Orange';
  }
  const finalHealthStatus = calcHealthStatus(finalRiskBand, qReadiness, docReadiness, expectedReady);

  return {
    itemId: item.id,
    daysElapsed,
    slaTotalDays,
    expectedReadiness: expectedReady,
    riskBand:          finalRiskBand,      // expiry-adjusted
    healthStatus:      finalHealthStatus,  // expiry-adjusted
    slaFlagged:        finalRiskBand !== 'Green',
    expiryFlagged,
    expiryCritical,
    minDaysToExpiry,
    pctConsumed,
    caseType,
    hardDeadline,
    softDeadline,
    submissionPrepDeadline,
  };
}

// ─── Write updates ────────────────────────────────────────────────────────────

async function writeUpdates(itemId, result) {
  const deadlines = {};
  if (result.hardDeadline)          deadlines[CM.hardDeadline]          = { date: result.hardDeadline };
  if (result.softDeadline)          deadlines[CM.softDeadline]          = { date: result.softDeadline };
  if (result.submissionPrepDeadline) deadlines[CM.submissionPrepDeadline] = { date: result.submissionPrepDeadline };

  const colValues = JSON.stringify({
    [CM.daysElapsed]:            result.daysElapsed,
    [CM.slaTotalDays]:           result.slaTotalDays,
    [CM.stageExpectedDuration]:  result.slaTotalDays,   // keeps Stage Overrun formula fed
    [CM.expectedReadiness]:      result.expectedReadiness,
    [CM.slaRiskBand]:            { label: result.riskBand },
    [CM.caseHealthStatus]:       { label: result.healthStatus },
    [CM.slaRiskFlag]:            { label: result.slaFlagged    ? 'Flagged' : 'Clear' },
    [CM.expiryRiskFlag]:         { label: result.expiryFlagged ? 'Flagged' : 'Clear' },
    ...deadlines,
  });

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    { boardId: String(clientMasterBoardId), itemId: String(itemId), colValues }
  );
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function runDailyCheck() {
  console.log('[SLAEngine] Starting daily SLA & risk check…');
  const startTime = Date.now();

  const [profiles, items] = await Promise.all([
    loadSLAProfiles(),
    fetchActiveCases(),
  ]);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;
  const summary = { Green: 0, Orange: 0, Red: 0, expiryFlagged: 0 };

  for (const item of items) {
    const result = processCase(item, profiles);
    if (!result) { skipped++; continue; }

    try {
      await writeUpdates(result.itemId, result);
      summary[result.riskBand]++;
      if (result.expiryFlagged) summary.expiryFlagged++;
      processed++;
      console.log(
        `[SLAEngine] ✓ ${item.name} — ${result.caseType} | ` +
        `${result.daysElapsed}/${result.slaTotalDays}d (${result.pctConsumed}%) | ` +
        `Band: ${result.riskBand} | Health: ${result.healthStatus} | ` +
        `Deadlines: Soft=${result.softDeadline || 'N/A'} Hard=${result.hardDeadline || 'N/A'} Prep=${result.submissionPrepDeadline || 'N/A'}` +
        (result.expiryFlagged ? ' | EXPIRY' : '')
      );
      // Gentle rate limiting
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      errors++;
      console.error(`[SLAEngine] ✗ Item ${result.itemId} (${item.name}):`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[SLAEngine] Done in ${elapsed}s — ` +
    `${processed} updated, ${skipped} skipped, ${errors} errors | ` +
    `Green:${summary.Green} Orange:${summary.Orange} Red:${summary.Red} | ` +
    `Expiry flags:${summary.expiryFlagged}`
  );

  return summary;
}

module.exports = { runDailyCheck };
