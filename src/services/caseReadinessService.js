/**
 * Case Readiness Calculation Service
 *
 * Queries both execution boards for a given case, calculates readiness
 * percentages and blocking counts, then writes the results back to the
 * Client Master Board.  Also fires the Automation Lock Engine when the
 * case crosses the "fully complete" threshold.
 *
 * Called from:
 *  - questionnaireFormService (after client saves answers)
 *  - documentFormService     (after client uploads a file)
 *  - scheduler               (daily, before SLA & Risk Engine runs)
 */

const mondayApi      = require('./mondayApi');
const stageGateService = require('./stageGateService');
const { clientMasterBoardId } = require('../../config/monday');

const Q_BOARD_ID  = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const D_BOARD_ID  = process.env.MONDAY_EXECUTION_BOARD_ID               || '18401875593';
const SLA_BOARD_ID = process.env.MONDAY_SLA_CONFIG_BOARD_ID             || '18402401449';

// ─── Column IDs — Questionnaire Execution Board ───────────────────────────────
const Q_COLS = {
  caseRef:            'text_mm12dgy9',
  countsTowardReady:  'lookup_mm13866r',   // mirror → "Yes" / "No"
  responseStatus:     'color_mm135pm1',    // text: Reviewed / Answered / Missing / etc.
  blockingQuestion:   'lookup_mm13p6f4',   // mirror → "Yes" / "No"
};

// ─── Column IDs — Document Execution Board ────────────────────────────────────
const D_COLS = {
  caseRef:            'text_mm0z2cck',
  countsTowardReady:  'lookup_mm0zhkkd',   // mirror → "Yes" / "No"
  documentStatus:     'color_mm0zwgvr',    // text: Reviewed / Received / Missing / etc.
  blockingDoc:        'lookup_mm0zb0p6',   // mirror → "Yes" / "No"
  requiredType:       'lookup_mm0z1chx',   // mirror → "Mandatory" / "Conditional" / "Optional"
};

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseRef:             'text_mm142s49',
  caseType:            'dropdown_mm0xd1qn',
  caseStage:           'color_mm0x8faa',
  automationLock:      'color_mm0x3x1x',
  qReadiness:          'numeric_mm0x9dea',
  docReadiness:        'numeric_mm0x5g9x',
  blockingQCount:      'numeric_mm0xbpn1',
  blockingDocCount:    'numeric_mm0xje6p',
  missingRequired:     'numeric_mm0x6qy4',
  qCompletionStatus:   'color_mm0x9s08',    // labels: Done / Working on it
  docThresholdMet:     'color_mm0xvxq2',    // labels: Yes / No
  readyForReview:      'color_mm0xh2fh',    // labels: Done / Working on it
  caseManager:         'multiple_person_mm0xhmgk',
  opsSupervisor:       'multiple_person_mm0xp0sq',
  clientName:          'text_mm0x1zdk',
  accessToken:         'text_mm0x6haq',
  chasingStage:        'color_mm1abve4',
};

// ─── Column IDs — SLA Config Board ───────────────────────────────────────────
const SLA_MIN_THRESHOLD_COL = 'numeric_mm13t15j';
const SLA_ACTIVE_COL        = 'color_mm1361s8';

// Full lock requires 100% on both boards with zero blocking items
const FULL_LOCK_THRESHOLD = 100;

// ─── Load minimum readiness thresholds per case type ─────────────────────────

let _thresholdCache    = null;
let _thresholdCacheAge = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function loadThresholds() {
  if (_thresholdCache && Date.now() - _thresholdCacheAge < CACHE_TTL_MS) {
    return _thresholdCache;
  }
  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         items_page(limit: 100) {
           items {
             name
             column_values(ids: ["${SLA_MIN_THRESHOLD_COL}", "${SLA_ACTIVE_COL}"]) { id text }
           }
         }
       }
     }`,
    { boardId: SLA_BOARD_ID }
  );
  const map = {};
  for (const item of data.boards[0].items_page.items) {
    const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    if (col(SLA_ACTIVE_COL) !== 'Yes') continue;
    map[item.name] = parseFloat(col(SLA_MIN_THRESHOLD_COL)) || 80;
  }
  _thresholdCache    = map;
  _thresholdCacheAge = Date.now();
  return map;
}

// ─── Query execution board items for a case ──────────────────────────────────

async function fetchExecutionItems(boardId, caseRefColId, fetchColIds, caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 500,
         board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items {
           id
           column_values(ids: ${JSON.stringify(fetchColIds)}) { id text }
         }
       }
     }`,
    { boardId: boardId, colId: caseRefColId, val: caseRef }
  );
  return data?.items_page_by_column_values?.items || [];
}

// ─── Calculate questionnaire readiness metrics ────────────────────────────────

function calcQMetrics(items) {
  // If there are no Q board items the case uses the HTML questionnaire form.
  // Return a sentinel so callers know not to overwrite the form-submitted value.
  if (!items.length) {
    return { readinessPct: null, blockingCount: 0, totalCountable: 0, htmlFormMode: true };
  }

  let countable   = 0;
  let reviewed    = 0;
  let blocking    = 0;

  for (const item of items) {
    const col    = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    const counts = col(Q_COLS.countsTowardReady).toLowerCase();
    const status = col(Q_COLS.responseStatus);
    const isBlocking = col(Q_COLS.blockingQuestion).toLowerCase() === 'yes';

    if (counts === 'yes') {
      countable++;
      if (status === 'Reviewed') reviewed++;
    }
    if (isBlocking && status !== 'Reviewed') blocking++;
  }

  const readinessPct = countable > 0 ? Math.round((reviewed / countable) * 100) : 0;
  return { readinessPct, blockingCount: blocking, totalCountable: countable, htmlFormMode: false };
}

// ─── Calculate document readiness metrics ────────────────────────────────────

function calcDocMetrics(items) {
  let countable       = 0;
  let reviewed        = 0;
  let blocking        = 0;
  let missingRequired = 0;

  for (const item of items) {
    const col        = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    const counts     = col(D_COLS.countsTowardReady).toLowerCase();
    const status     = col(D_COLS.documentStatus);
    const isBlocking = col(D_COLS.blockingDoc).toLowerCase() === 'yes';
    const required   = col(D_COLS.requiredType);

    if (counts === 'yes') {
      countable++;
      if (status === 'Reviewed') reviewed++;
    }
    if (isBlocking && status !== 'Reviewed') blocking++;
    if (required === 'Mandatory' && status === 'Missing') missingRequired++;
  }

  const readinessPct = countable > 0 ? Math.round((reviewed / countable) * 100) : 0;
  return { readinessPct, blockingCount: blocking, missingRequired, totalCountable: countable };
}

// ─── Write calculated metrics to Client Master Board ─────────────────────────

async function writeToCaseMaster(masterItemId, qMetrics, docMetrics, minThreshold) {
  const docReady      = docMetrics.readinessPct;
  const htmlFormMode  = qMetrics.htmlFormMode;

  // When the case uses HTML-form questionnaires (no Q board items exist), preserve
  // whatever Q readiness the form submission has already written.  Only update
  // document-related columns so the daily scheduler cannot reset the form value to 0.
  const colValues = {
    [CM.docReadiness]:     docReady,
    [CM.blockingDocCount]: docMetrics.blockingCount,
    [CM.missingRequired]:  docMetrics.missingRequired,
  };

  let thresholdMet  = false;
  let fullyComplete = false;
  let qReady        = 0;

  if (!htmlFormMode) {
    qReady        = qMetrics.readinessPct;
    const totalBlocking = qMetrics.blockingCount + docMetrics.blockingCount;
    thresholdMet  = qReady >= minThreshold && docReady >= minThreshold && totalBlocking === 0;
    fullyComplete = qReady >= FULL_LOCK_THRESHOLD && docReady >= FULL_LOCK_THRESHOLD && totalBlocking === 0;

    colValues[CM.qReadiness]        = qReady;
    colValues[CM.blockingQCount]    = qMetrics.blockingCount;
    colValues[CM.qCompletionStatus] = { label: qReady >= FULL_LOCK_THRESHOLD ? 'Done' : 'Working on it' };
    colValues[CM.docThresholdMet]   = { label: thresholdMet ? 'Yes' : 'No' };
    colValues[CM.readyForReview]    = { label: thresholdMet ? 'Done' : 'Working on it' };
  }

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(masterItemId),
      colValues: JSON.stringify(colValues),
    }
  );

  return { qReady, docReady, totalBlocking: qMetrics.blockingCount + docMetrics.blockingCount, thresholdMet, fullyComplete };
}

// ─── Core: calculate for one case ────────────────────────────────────────────

/**
 * @param {string} masterItemId  - Client Master Board item ID
 * @param {string} caseRef       - Case Reference Number (e.g. 2026-SP-001)
 * @param {string} caseType      - Primary Case Type (e.g. "Study Permit")
 * @param {string} caseStage     - Current Case Stage (skip if not eligible)
 * @param {boolean} checkLock    - Whether to check and trigger automation lock
 */
async function calculateForCase({ masterItemId, caseRef, caseType, caseStage, checkLock = true }) {
  if (!caseRef || !masterItemId) return null;

  // Only calculate for active collection/review stages
  const eligibleStages = new Set([
    'Document Collection Started',
    'Internal Review',
    'Submission Preparation',
    'Stuck',
  ]);
  if (caseStage && !eligibleStages.has(caseStage)) return null;

  const [thresholds, qItems, dItems] = await Promise.all([
    loadThresholds(),
    fetchExecutionItems(Q_BOARD_ID, Q_COLS.caseRef,
      [Q_COLS.countsTowardReady, Q_COLS.responseStatus, Q_COLS.blockingQuestion], caseRef),
    fetchExecutionItems(D_BOARD_ID, D_COLS.caseRef,
      [D_COLS.countsTowardReady, D_COLS.documentStatus, D_COLS.blockingDoc, D_COLS.requiredType], caseRef),
  ]);

  if (qItems.length === 0 && dItems.length === 0) return null;

  const minThreshold = thresholds[caseType] || 80;
  const qMetrics     = calcQMetrics(qItems);
  const docMetrics   = calcDocMetrics(dItems);
  const result       = await writeToCaseMaster(masterItemId, qMetrics, docMetrics, minThreshold);

  const htmlFormMode = qMetrics.htmlFormMode;
  console.log(
    `[Readiness] ${caseRef} | Q:${htmlFormMode ? '(html-form)' : result.qReady + '%'} Doc:${result.docReady}% ` +
    `Blocking:${result.totalBlocking} Threshold:${minThreshold}% ` +
    (htmlFormMode ? '(Q columns preserved)' : result.fullyComplete ? '→ FULLY COMPLETE' : result.thresholdMet ? '→ threshold met' : '')
  );

  // Stage gates are skipped for HTML-form cases — the form submission handles them.
  if (!checkLock || htmlFormMode) return result;

  // Gate 1: threshold met → Internal Review (from Document Collection Started only)
  if (result.thresholdMet && !result.fullyComplete && caseStage === 'Document Collection Started') {
    stageGateService.onThresholdMet({ masterItemId, caseRef, caseType })
      .catch((err) => console.error(`[Readiness] Threshold gate failed for ${caseRef}:`, err.message));
  }

  // Gate 2: 100% complete → Submission Preparation (from Internal Review only)
  if (result.fullyComplete && caseStage === 'Internal Review') {
    stageGateService.onFullyComplete({ masterItemId, caseRef, caseType })
      .catch((err) => console.error(`[Readiness] Submission prep gate failed for ${caseRef}:`, err.message));
  }

  return result;
}

// ─── Daily scan: calculate readiness for all active cases ────────────────────

async function runDailyReadinessCheck() {
  console.log('[Readiness] Starting daily readiness calculation…');
  const start = Date.now();

  const FETCH_IDS = [CM.caseRef, CM.caseType, CM.caseStage, CM.automationLock];
  let items = [];
  let cursor = null;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items { id column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text } }
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
               items { id column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text } }
             }
           }
         }`
      );
    }
    const page = data.boards[0].items_page;
    items  = items.concat(page.items);
    cursor = page.cursor || null;
  } while (cursor);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const item of items) {
    const col      = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    const caseRef  = col(CM.caseRef);
    const caseStage = col(CM.caseStage);

    if (!caseRef) { skipped++; continue; }
    // Skip already locked or non-active stages (daily scan only targets collection/review)
    if (col(CM.automationLock) === 'Yes') { skipped++; continue; }

    try {
      const result = await calculateForCase({
        masterItemId: item.id,
        caseRef,
        caseType:  col(CM.caseType),
        caseStage,
      });
      if (result) processed++;
      else skipped++;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      errors++;
      console.error(`[Readiness] Error for item ${item.id} (${caseRef}):`, err.message);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Readiness] Done in ${elapsed}s — ${processed} updated, ${skipped} skipped, ${errors} errors`);
}

// ─── Convenience wrapper — call with just a caseRef ──────────────────────────

/**
 * Look up the master item by case ref and trigger readiness calculation.
 * Safe to call fire-and-forget (.catch(()=>{})) from route handlers.
 */
async function calculateForCaseRef(caseRef) {
  if (!caseRef) return;

  const LOOKUP_IDS = [CM.caseRef, CM.caseType, CM.caseStage, CM.automationLock];
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 1,
         board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items { id column_values(ids: ${JSON.stringify(LOOKUP_IDS)}) { id text } }
       }
     }`,
    {
      boardId: String(clientMasterBoardId),
      colId:   CM.caseRef,
      val:     caseRef,
    }
  );

  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return;

  const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  if (col(CM.automationLock) === 'Yes') return; // already locked

  await calculateForCase({
    masterItemId: item.id,
    caseRef,
    caseType:  col(CM.caseType),
    caseStage: col(CM.caseStage),
  });
}

module.exports = { calculateForCase, calculateForCaseRef, runDailyReadinessCheck };
