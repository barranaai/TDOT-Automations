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
const { clientMasterBoardId, templateBoardId } = require('../../config/monday');

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
  countsTowardReady:  'lookup_mm0zhkkd',   // mirror → "Yes" / "No"  (broken — see T_COLS fallback)
  documentStatus:     'color_mm0zwgvr',    // text: Reviewed / Received / Missing / etc.
  blockingDoc:        'lookup_mm0zb0p6',   // mirror → "Yes" / "No"  (broken — see T_COLS fallback)
  requiredType:       'lookup_mm0z1chx',   // mirror → "Mandatory" / "Conditional" / "Optional"  (broken)
  intakeItemId:       'text_mm0zfsp1',     // stores the template item ID (used for direct lookup)
};

// ─── Column IDs — Document Checklist Template Board (source of truth) ────────
// The mirror columns on the Execution Board depend on a board_relation that the
// Monday.com API cannot reliably set.  As a workaround, the readiness engine
// fetches these values directly from the Template Board using the intakeItemId
// stored on each execution item.
const T_COLS = {
  countsTowardReady:  'color_mm0x78rc',    // status: "Yes" / "No"
  blockingFlag:       'color_mm0xmrw',     // status: "Yes" / "No"
  requiredType:       'dropdown_mm0x9v5q', // dropdown: "Mandatory" / "Conditional" / "Optional"
};

// Map: template column ID → execution mirror column ID (for enrichment)
const TMPL_TO_EXEC_MAP = {
  [T_COLS.countsTowardReady]: D_COLS.countsTowardReady,
  [T_COLS.blockingFlag]:      D_COLS.blockingDoc,
  [T_COLS.requiredType]:      D_COLS.requiredType,
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

// ─── Enrich doc execution items with template data (bypasses broken mirrors) ─

/**
 * The mirror columns on the Document Execution Board depend on a board_relation
 * link to the Template Board.  The Monday.com API cannot reliably write that
 * relation (the mutation returns success but nothing persists), so the mirrors
 * always return null.
 *
 * This function fetches the source values directly from the Template Board items
 * (using the intakeItemId stored on each execution item) and injects them into
 * the execution item's column_values array so calcDocMetrics works correctly.
 */
async function enrichDocItemsWithTemplateData(dItems) {
  // Collect template item IDs from execution items
  const templateIds = new Set();
  for (const item of dItems) {
    const intakeId = item.column_values.find((c) => c.id === D_COLS.intakeItemId)?.text?.trim();
    if (intakeId && /^\d+$/.test(intakeId)) templateIds.add(intakeId);
  }
  if (!templateIds.size) return;

  // Batch-fetch template items (Monday API accepts up to ~100 IDs at once)
  const allIds    = [...templateIds];
  const tmplMap   = {};  // templateItemId → { colId: textValue, ... }
  const fetchCols = Object.values(T_COLS);
  const BATCH     = 100;

  for (let i = 0; i < allIds.length; i += BATCH) {
    const batch = allIds.slice(i, i + BATCH);
    const data  = await mondayApi.query(
      `query($ids: [ID!]!) {
         items(ids: $ids) {
           id
           column_values(ids: ${JSON.stringify(fetchCols)}) { id text }
         }
       }`,
      { ids: batch }
    );
    for (const tmplItem of (data?.items || [])) {
      const vals = {};
      for (const cv of tmplItem.column_values) {
        vals[cv.id] = cv.text?.trim() || '';
      }
      tmplMap[tmplItem.id] = vals;
    }
  }

  // Inject template values where execution mirrors are null / empty
  let enriched = 0;
  for (const item of dItems) {
    const intakeId = item.column_values.find((c) => c.id === D_COLS.intakeItemId)?.text?.trim();
    const tmplVals = tmplMap[intakeId];
    if (!tmplVals) continue;

    for (const [tmplCol, execCol] of Object.entries(TMPL_TO_EXEC_MAP)) {
      const execCv = item.column_values.find((c) => c.id === execCol);
      if (execCv && (!execCv.text || execCv.text === 'null' || execCv.text.trim() === '')) {
        execCv.text = tmplVals[tmplCol] || '';
        enriched++;
      }
    }
  }

  if (enriched > 0) {
    console.log(`[Readiness] Enriched ${enriched} mirror values from template board (${templateIds.size} template items)`);
  }
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
    // A Mandatory document is "missing" if it hasn't been received or reviewed.
    // New execution items have null/blank status, which also means not yet received.
    const receivedStatuses = new Set(['Reviewed', 'Received', 'Under Review']);
    if (required === 'Mandatory' && !receivedStatuses.has(status)) missingRequired++;
  }

  const readinessPct = countable > 0 ? Math.round((reviewed / countable) * 100) : 0;
  return { readinessPct, blockingCount: blocking, missingRequired, totalCountable: countable };
}

// ─── Write calculated metrics to Client Master Board ─────────────────────────

/**
 * @param {number|null} storedQReadiness  For HTML-form cases: the Q readiness
 *   already stored on the master board by the last form submission.  Pass null
 *   if unknown — gates will be skipped safely for that run.
 */
async function writeToCaseMaster(masterItemId, qMetrics, docMetrics, minThreshold, storedQReadiness = null) {
  const docReady     = docMetrics.readinessPct;
  const htmlFormMode = qMetrics.htmlFormMode;

  // Always update document-related columns.
  const colValues = {
    [CM.docReadiness]:     docReady,
    [CM.blockingDocCount]: docMetrics.blockingCount,
    [CM.missingRequired]:  docMetrics.missingRequired,
  };

  let thresholdMet  = false;
  let fullyComplete = false;
  let qReady        = 0;

  if (!htmlFormMode) {
    // ── Legacy Q-board path ────────────────────────────────────────────────
    qReady = qMetrics.readinessPct;
    const totalBlocking = qMetrics.blockingCount + docMetrics.blockingCount;
    thresholdMet  = qReady >= minThreshold && docReady >= minThreshold && totalBlocking === 0;
    fullyComplete = qReady >= FULL_LOCK_THRESHOLD && docReady >= FULL_LOCK_THRESHOLD && totalBlocking === 0;

    colValues[CM.qReadiness]        = qReady;
    colValues[CM.blockingQCount]    = qMetrics.blockingCount;
    colValues[CM.qCompletionStatus] = { label: qReady >= FULL_LOCK_THRESHOLD ? 'Done' : 'Working on it' };
    colValues[CM.docThresholdMet]   = { label: thresholdMet ? 'Yes' : 'No' };
    colValues[CM.readyForReview]    = { label: thresholdMet ? 'Done' : 'Working on it' };

  } else if (storedQReadiness !== null) {
    // ── HTML-form path — Q readiness already set by form submission ────────
    // Never overwrite qReadiness or qCompletionStatus (preserve submitted values).
    // Do update the threshold visibility columns so officers see the correct state,
    // and compute thresholdMet/fullyComplete so stage gates can fire from the daily scan.
    qReady = storedQReadiness;
    // Q board has no blocking items; only doc-side blocking counts here.
    const totalBlocking = docMetrics.blockingCount;
    thresholdMet  = qReady >= minThreshold && docReady >= minThreshold && totalBlocking === 0;
    fullyComplete = qReady >= FULL_LOCK_THRESHOLD && docReady >= FULL_LOCK_THRESHOLD && totalBlocking === 0;

    colValues[CM.docThresholdMet] = { label: thresholdMet ? 'Yes' : 'No' };
    colValues[CM.readyForReview]  = { label: thresholdMet ? 'Done' : 'Working on it' };
  }
  // If htmlFormMode=true AND storedQReadiness is null (caller didn't fetch it),
  // we write only the doc columns and return thresholdMet=false — safe fallback.

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
 * @param {string}      masterItemId     - Client Master Board item ID
 * @param {string}      caseRef          - Case Reference Number (e.g. 2026-SP-001)
 * @param {string}      caseType         - Primary Case Type (e.g. "Study Permit")
 * @param {string}      caseStage        - Current Case Stage (skip if not eligible)
 * @param {boolean}     checkLock        - Whether to check and trigger automation lock
 * @param {number|null} storedQReadiness - For HTML-form cases: Q readiness already on
 *   the master board (set by the last form submission).  When provided, the daily scan
 *   can still fire stage gates even though the Q board has no items.
 */
async function calculateForCase({ masterItemId, caseRef, caseType, caseStage, checkLock = true, storedQReadiness = null }) {
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
      [D_COLS.countsTowardReady, D_COLS.documentStatus, D_COLS.blockingDoc, D_COLS.requiredType, D_COLS.intakeItemId], caseRef),
  ]);

  if (qItems.length === 0 && dItems.length === 0) return null;

  // Enrich doc items with template data (mirrors are broken due to unfixable board_relation)
  if (dItems.length > 0) {
    await enrichDocItemsWithTemplateData(dItems);
  }

  const minThreshold = thresholds[caseType] || 80;
  const qMetrics     = calcQMetrics(qItems);
  const docMetrics   = calcDocMetrics(dItems);
  const result       = await writeToCaseMaster(masterItemId, qMetrics, docMetrics, minThreshold, storedQReadiness);

  const htmlFormMode = qMetrics.htmlFormMode;
  console.log(
    `[Readiness] ${caseRef} | ` +
    (htmlFormMode
      ? `Q:(html-form, stored=${storedQReadiness ?? 'unknown'}%)`
      : `Q:${result.qReady}%`) +
    ` Doc:${result.docReady}% Blocking:${result.totalBlocking} Threshold:${minThreshold}% ` +
    (result.fullyComplete ? '→ FULLY COMPLETE' : result.thresholdMet ? '→ threshold met' : '')
  );

  if (!checkLock) return result;

  // For HTML-form cases where storedQReadiness was not fetched by the caller,
  // we cannot determine thresholdMet accurately — skip gates safely this run.
  // When storedQReadiness IS provided (daily scan / doc upload path), gates fire normally.
  if (htmlFormMode && storedQReadiness === null) return result;

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

  // qReadiness is fetched so HTML-form cases can still fire stage gates when
  // doc readiness crosses the threshold after the initial form submission.
  const FETCH_IDS = [CM.caseRef, CM.caseType, CM.caseStage, CM.automationLock, CM.qReadiness];
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
    const col       = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    const caseRef   = col(CM.caseRef);
    const caseStage = col(CM.caseStage);

    if (!caseRef) { skipped++; continue; }
    // Skip already locked or non-active stages (daily scan only targets collection/review)
    if (col(CM.automationLock) === 'Yes') { skipped++; continue; }

    // Parse the stored Q readiness (non-null so HTML-form gate checks fire correctly)
    const rawQ           = col(CM.qReadiness);
    const storedQReadiness = rawQ !== '' ? parseFloat(rawQ) : null;

    try {
      const result = await calculateForCase({
        masterItemId: item.id,
        caseRef,
        caseType:  col(CM.caseType),
        caseStage,
        storedQReadiness,
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

  const LOOKUP_IDS = [CM.caseRef, CM.caseType, CM.caseStage, CM.automationLock, CM.qReadiness];
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

  const rawQ           = col(CM.qReadiness);
  const storedQReadiness = rawQ !== '' ? parseFloat(rawQ) : null;

  await calculateForCase({
    masterItemId: item.id,
    caseRef,
    caseType:  col(CM.caseType),
    caseStage: col(CM.caseStage),
    storedQReadiness,
  });
}

module.exports = { calculateForCase, calculateForCaseRef, runDailyReadinessCheck, loadThresholds };
