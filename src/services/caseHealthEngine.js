/**
 * Case Health Engine
 *
 * Runs AFTER the SLA engine and Expiry Risk Engine in the daily job.
 * It synthesises ALL health signals — time pressure, client behaviour,
 * expiry risk, blocking items, and deadline proximity — into four
 * authoritative output columns on the Client Master Board:
 *
 *   1. Client-Blocked Status  (Yes / No)
 *   2. Client Delay Level      (Low / Medium / High)
 *   3. Client Responsiveness Score  (0–100)
 *   4. Case Health Status      (Green / Orange / Red)   ← overrides SLA engine baseline
 *
 * ──────────────────────────────────────────────────────
 * Case Health Status Logic
 * ──────────────────────────────────────────────────────
 * RED (Supervisor attention required)
 *   - Client-Blocked Status = Yes
 *   - SLA Risk Band = Red
 *   - Hard deadline in < 7 days
 *   - Blocking docs AND deadline in < 14 days
 *
 * ORANGE (Requires monitoring)
 *   - SLA Risk Band = Orange
 *   - Expiry Risk Flag = Flagged
 *   - Blocking docs or blocking questions > 0
 *   - Client Delay Level = High
 *   - Reminder Count >= 2
 *   - Hard deadline in < 30 days
 *
 * GREEN (Healthy / on track)
 *   - None of the above
 *
 * ──────────────────────────────────────────────────────
 * Client Delay Level Logic
 * ──────────────────────────────────────────────────────
 * High   — Client Blocked  OR  reminderCount >= 3  OR  inactivityDays > 21
 * Medium — chasingStage in [R2 Sent, Final Notice Sent]  OR  reminderCount >= 2  OR  inactivityDays > 10
 * Low    — everything else
 *
 * ──────────────────────────────────────────────────────
 * Client Responsiveness Score  (0–100)
 * ──────────────────────────────────────────────────────
 * Start at 100.
 *   -15 per reminder already sent (cap at -45 from reminders)
 *   -2  per inactivity day        (cap at -40 from inactivity)
 *   -30 if client is currently blocked
 * Minimum score: 0.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseStage:             'color_mm0x8faa',
  caseRef:               'text_mm142s49',
  slaRiskBand:           'color_mm0xszmm',         // Green / Orange / Red
  expiryRiskFlag:        'color_mm1a7vbn',          // Flagged / Clear
  blockingDocsCount:     'numeric_mm0xje6p',
  blockingQCount:        'numeric_mm0xbpn1',
  reminderCount:         'numeric_mm1a4e8r',
  chasingStage:          'color_mm1abve4',          // Pending / R1 Sent / R2 Sent / Final Notice Sent / Client Blocked / Resolved
  inactivityCounter:     'formula_mm0xkdf4',        // formula — TODAY() - Last Client Activity Date
  daysToHardDeadline:    'formula_mm0xb5wm',        // formula — Hard Deadline - TODAY()
  caseHealthStatus:      'color_mm0xf5ry',          // Green / Orange / Red  (engine output)
  clientBlockedStatus:   'color_mm1b5gqv',          // Yes / No              (engine output)
  clientDelayLevel:      'color_mm1bq05h',          // Low / Medium / High   (engine output)
  clientResponsiveness:  'numeric_mm1bhyh1',        // 0–100                 (engine output)
};

const ACTIVE_STAGES = new Set([
  'Document Collection Started',
  'Internal Review',
  'Submission Preparation',
  'Stuck',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(text) {
  const n = parseFloat((text || '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ─── Core logic functions ─────────────────────────────────────────────────────

function calcDelayLevel(chasingStage, reminderCount, inactivityDays) {
  if (
    chasingStage === 'Client Blocked' ||
    reminderCount >= 3 ||
    inactivityDays > 21
  ) return 'High';

  if (
    chasingStage === 'R2 Sent' ||
    chasingStage === 'Final Notice Sent' ||
    reminderCount >= 2 ||
    inactivityDays > 10
  ) return 'Medium';

  return 'Low';
}

function calcResponsivenessScore(reminderCount, inactivityDays, isBlocked) {
  const reminderPenalty  = Math.min(reminderCount * 15, 45);
  const inactivityPenalty = Math.min(inactivityDays * 2, 40);
  const blockedPenalty   = isBlocked ? 30 : 0;
  return Math.max(0, 100 - reminderPenalty - inactivityPenalty - blockedPenalty);
}

function calcHealthStatus({
  slaRiskBand,
  expiryFlagged,
  blockingDocsCount,
  blockingQCount,
  reminderCount,
  delayLevel,
  isBlocked,
  daysToHardDeadline,
}) {
  // ── RED conditions ────────────────────────────────────────────────────────
  if (isBlocked)                                                         return 'Red';
  if (slaRiskBand === 'Red')                                             return 'Red';
  if (daysToHardDeadline !== null && daysToHardDeadline < 7)            return 'Red';
  if (blockingDocsCount > 0 && daysToHardDeadline !== null
      && daysToHardDeadline < 14)                                        return 'Red';

  // ── ORANGE conditions ─────────────────────────────────────────────────────
  if (slaRiskBand === 'Orange')                                          return 'Orange';
  if (expiryFlagged)                                                     return 'Orange';
  if (blockingDocsCount > 0 || blockingQCount > 0)                      return 'Orange';
  if (delayLevel === 'High')                                             return 'Orange';
  if (reminderCount >= 2)                                                return 'Orange';
  if (daysToHardDeadline !== null && daysToHardDeadline < 30)           return 'Orange';

  return 'Green';
}

// ─── Fetch active cases ───────────────────────────────────────────────────────

async function fetchCases() {
  const FETCH_IDS = [
    CM.caseStage, CM.caseRef,
    CM.slaRiskBand, CM.expiryRiskFlag,
    CM.blockingDocsCount, CM.blockingQCount,
    CM.reminderCount, CM.chasingStage,
    CM.inactivityCounter, CM.daysToHardDeadline,
  ];

  let items = [], cursor = null;
  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text } }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{ boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text } }
             }
           } }`
      );
    }
    const page = data.boards[0].items_page;
    items  = items.concat(page.items);
    cursor = page.cursor || null;
  } while (cursor);
  return items;
}

// ─── Process one case ─────────────────────────────────────────────────────────

function processCase(item) {
  const col       = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  const caseStage = col(CM.caseStage);
  if (!ACTIVE_STAGES.has(caseStage)) return null;

  const caseRef           = col(CM.caseRef);
  const slaRiskBand       = col(CM.slaRiskBand)       || 'Green';
  const expiryFlagged     = col(CM.expiryRiskFlag)    === 'Flagged';
  const blockingDocsCount = toNum(col(CM.blockingDocsCount));
  const blockingQCount    = toNum(col(CM.blockingQCount));
  const reminderCount     = toNum(col(CM.reminderCount));
  const chasingStage      = col(CM.chasingStage);
  const inactivityDays    = toNum(col(CM.inactivityCounter));

  // Formula columns return a text representation — parse to number
  const hardDeadlineText  = col(CM.daysToHardDeadline);
  const daysToHardDeadline = hardDeadlineText !== '' ? toNum(hardDeadlineText) : null;

  const isBlocked  = chasingStage === 'Client Blocked';
  const delayLevel = calcDelayLevel(chasingStage, reminderCount, inactivityDays);
  const score      = calcResponsivenessScore(reminderCount, inactivityDays, isBlocked);
  const health     = calcHealthStatus({
    slaRiskBand,
    expiryFlagged,
    blockingDocsCount,
    blockingQCount,
    reminderCount,
    delayLevel,
    isBlocked,
    daysToHardDeadline,
  });

  return {
    itemId:              item.id,
    caseRef:             caseRef || item.name,
    health,
    delayLevel,
    score,
    isBlocked,
    slaRiskBand,
    expiryFlagged,
    blockingDocsCount,
    blockingQCount,
    reminderCount,
    inactivityDays,
  };
}

// ─── Write to Monday ──────────────────────────────────────────────────────────

async function writeUpdates(itemId, result) {
  const colValues = JSON.stringify({
    [CM.caseHealthStatus]:  { label: result.health },
    [CM.clientBlockedStatus]:{ label: result.isBlocked ? 'Yes' : 'No' },
    [CM.clientDelayLevel]:  { label: result.delayLevel },
    [CM.clientResponsiveness]: result.score,
  });

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    { boardId: String(clientMasterBoardId), itemId: String(itemId), colValues }
  );
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function runHealthCheck() {
  console.log('[HealthEngine] Starting case health calculation…');
  const startTime = Date.now();

  const items = await fetchCases();

  const tally = { Green: 0, Orange: 0, Red: 0, skipped: 0, errors: 0 };

  for (const item of items) {
    const result = processCase(item);
    if (!result) { tally.skipped++; continue; }

    try {
      await writeUpdates(result.itemId, result);
      tally[result.health] = (tally[result.health] || 0) + 1;
      console.log(
        `[HealthEngine] ✓ ${result.caseRef} — Health: ${result.health} | ` +
        `Delay: ${result.delayLevel} | Score: ${result.score} | ` +
        `Blocked: ${result.isBlocked} | Blocking: D${result.blockingDocsCount}/Q${result.blockingQCount}`
      );
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      tally.errors++;
      console.error(`[HealthEngine] ✗ Item ${item.id}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[HealthEngine] Done in ${elapsed}s — ` +
    `Green:${tally.Green} Orange:${tally.Orange} Red:${tally.Red} | ` +
    `Skipped:${tally.skipped} Errors:${tally.errors}`
  );
  return tally;
}

module.exports = { runHealthCheck };
