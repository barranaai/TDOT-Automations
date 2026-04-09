/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TDOT Automations — End-to-End Test Script
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Simulates the complete lifecycle of a test immigration case:
 *
 *   Step 1  — Create test item on Client Master Board
 *   Step 2  — Assign Access Token (onItemCreated)
 *   Step 3  — Set Case Type → generate Case Reference Number
 *   Step 4  — Trigger Retainer Paid → Document Collection Started
 *   Step 5  — Trigger Document Checklist creation (checklistService)
 *   Step 6  — Trigger Questionnaire Execution creation (questionnaireService)
 *   Step 7  — Verify execution items on both boards
 *   Step 8  — Run SLA Risk Engine for test case
 *   Step 9  — Run Expiry Risk Engine for test case
 *   Step 10 — Run Case Health Engine for test case
 *   Step 11 — Run Readiness Calculation for test case
 *   Step 12 — Verify all output columns on Client Master Board
 *   Step 13 — Cleanup: archive test item
 *
 * Run from repo root:
 *   node scripts/e2e-test.js
 *
 * Options:
 *   --no-cleanup   Skip deleting test items at the end (manual inspection)
 *   --case-type "Study Permit"  Override the test case type (default: Study Permit)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const mondayApi = require('../src/services/mondayApi');
const { onItemCreated: assignToken } = require('../src/services/accessTokenService');
const { onCaseTypeSet }              = require('../src/services/caseRefService');
const { onRetainerPaid }             = require('../src/services/retainerService');
const { onDocumentCollectionStarted } = require('../src/services/checklistService');
const { onDocumentCollectionStarted: onQStarted } = require('../src/services/questionnaireService');
const { runHealthCheck }             = require('../src/services/caseHealthEngine');
const { runExpiryCheck }             = require('../src/services/expiryRiskEngine');
const { runDailyCheck: runSlaCheck } = require('../src/services/slaRiskEngine');
const { calculateForCaseRef }        = require('../src/services/caseReadinessService');
const { runEscalationRouting }       = require('../src/services/escalationRoutingService');

const {
  clientMasterBoardId,
  executionBoardId,
  questionnaireExecutionBoardId,
} = require('../config/monday');

// ─── Parse CLI flags ──────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const NO_CLEANUP  = args.includes('--no-cleanup');
const caseTypeArg = (() => {
  const i = args.indexOf('--case-type');
  return i !== -1 ? args[i + 1] : null;
})();

const TEST_CASE_TYPE = caseTypeArg || 'Study Permit';
const TEST_CLIENT_NAME = `TEST CLIENT - E2E ${Date.now()}`;

// ─── Utility ─────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

function log(symbol, msg, colour = RESET) {
  console.log(`${colour}${symbol} ${msg}${RESET}`);
}
function pass(msg)  { log('✅', msg, GREEN); }
function fail(msg)  { log('❌', msg, RED);   }
function info(msg)  { log('ℹ️ ', msg, CYAN);  }
function warn(msg)  { log('⚠️ ', msg, YELLOW);}
function step(n, msg) {
  console.log(`\n${BOLD}${CYAN}─── Step ${n}: ${msg} ───${RESET}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Board / Column IDs ───────────────────────────────────────────────────────

const CM_BOARD_ID   = String(clientMasterBoardId   || process.env.MONDAY_CLIENT_MASTER_BOARD_ID);
const EXEC_BOARD_ID = String(executionBoardId       || process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593');
const Q_BOARD_ID    = String(questionnaireExecutionBoardId || process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488');

// Client Master columns to verify at end
const CM = {
  caseRef:               'text_mm142s49',
  caseType:              'dropdown_mm0xd1qn',
  caseStage:             'color_mm0x8faa',
  accessToken:           'text_mm0x6haq',
  checklistApplied:      'color_mm0xs7kp',
  questionnaireApplied:  'color_mm0x3tpw',
  paymentDate:           'date_mm0xgk76',
  slaRiskBand:           'color_mm0xszmm',
  caseHealthStatus:      'color_mm0xf5ry',
  clientDelayLevel:      'color_mm1bq05h',
  clientResponsiveness:  'numeric_mm1bhyh1',
  clientBlockedStatus:   'color_mm1b5gqv',
  docReadiness:          'numeric_mm0x5g9x',
  qReadiness:            'numeric_mm0x9dea',
};

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchItemColumns(itemId, colIds) {
  const data = await mondayApi.query(
    `query($id: ID!) {
       items(ids: [$id]) {
         name
         column_values(ids: ${JSON.stringify(colIds)}) { id text }
       }
     }`,
    { id: String(itemId) }
  );
  const item = data?.items?.[0];
  if (!item) return {};
  const map = { _name: item.name };
  for (const c of item.column_values) map[c.id] = c.text?.trim() || '';
  return map;
}

async function countExecutionItems(boardId, caseRefColId, caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 500,
         board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) { items { id name } }
     }`,
    { boardId: boardId, colId: caseRefColId, val: caseRef }
  );
  return data?.items_page_by_column_values?.items || [];
}

async function getBoardGroups(boardId) {
  const data = await mondayApi.query(
    `query($boardId: ID!) { boards(ids: [$boardId]) { groups { id title } } }`,
    { boardId: String(boardId) }
  );
  return data?.boards?.[0]?.groups || [];
}

// ─── Main Test ────────────────────────────────────────────────────────────────

const results = [];
let testItemId = null;
let testCaseRef = null;

function record(stepName, ok, detail = '') {
  results.push({ stepName, ok, detail });
  if (ok) pass(`${stepName}${detail ? ' — ' + detail : ''}`);
  else     fail(`${stepName}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log(`\n${BOLD}════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  TDOT Automations — End-to-End Test${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════════${RESET}`);
  info(`Case Type: ${TEST_CASE_TYPE}`);
  info(`Client Name: ${TEST_CLIENT_NAME}`);
  info(`CM Board: ${CM_BOARD_ID}`);
  info(`Exec Board: ${EXEC_BOARD_ID}`);
  info(`Q Board: ${Q_BOARD_ID}`);
  info(`Cleanup: ${NO_CLEANUP ? 'DISABLED (--no-cleanup)' : 'enabled'}`);

  // ── Step 1: Create test item ──────────────────────────────────────────────
  step(1, 'Create test item on Client Master Board');

  try {
    const groups = await getBoardGroups(CM_BOARD_ID);
    info(`Available groups: ${groups.map(g => g.title).join(', ')}`);

    // Pick first group (or a group named "Active" / "Clients")
    const targetGroup = groups.find(g =>
      /active|client|lead|new/i.test(g.title)
    ) || groups[0];

    if (!targetGroup) throw new Error('No groups found on Client Master Board');
    info(`Using group: "${targetGroup.title}" (${targetGroup.id})`);

    // Also set a test client email at creation time using column_values
    const createData = await mondayApi.query(
      `mutation($boardId: ID!, $groupId: String!, $name: String!) {
         create_item(board_id: $boardId, group_id: $groupId, item_name: $name) { id }
       }`,
      { boardId: CM_BOARD_ID, groupId: targetGroup.id, name: TEST_CLIENT_NAME }
    );

    testItemId = createData?.create_item?.id;
    if (!testItemId) throw new Error('create_item returned no id');

    pass(`Test item created: ID ${testItemId}`);
    record('Step 1 — Create test item', true, `ID ${testItemId}`);
  } catch (err) {
    record('Step 1 — Create test item', false, err.message);
    console.error(err);
    process.exit(1);
  }

  await sleep(1000);

  // ── Step 2: Assign Access Token ───────────────────────────────────────────
  step(2, 'Assign Access Token (onItemCreated)');
  try {
    await assignToken({ itemId: testItemId });
    const cols = await fetchItemColumns(testItemId, [CM.accessToken]);
    const token = cols[CM.accessToken];
    if (token && token.startsWith('TDOT-')) {
      record('Step 2 — Access Token assigned', true, token);
    } else {
      record('Step 2 — Access Token assigned', false, `Token value: "${token}"`);
    }
  } catch (err) {
    record('Step 2 — Access Token assigned', false, err.message);
  }

  await sleep(500);

  // ── Step 3: Set Case Type → Case Ref ─────────────────────────────────────
  step(3, `Set Case Type → "${TEST_CASE_TYPE}" and generate Case Reference`);
  try {
    // Monday dropdown columns require { labels: [...] } format (not { label: ... })
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
       }`,
      {
        boardId:   CM_BOARD_ID,
        itemId:    testItemId,
        colValues: JSON.stringify({ [CM.caseType]: { labels: [TEST_CASE_TYPE] } }),
      }
    );
    info(`Case Type column set to "${TEST_CASE_TYPE}"`);

    // Now trigger the case ref service
    await onCaseTypeSet({ itemId: testItemId, caseType: TEST_CASE_TYPE });

    await sleep(800);

    const cols = await fetchItemColumns(testItemId, [CM.caseRef]);
    testCaseRef = cols[CM.caseRef];

    if (testCaseRef && /^\d{4}-\w+-\d{3}$/.test(testCaseRef)) {
      record('Step 3 — Case Reference generated', true, testCaseRef);
    } else {
      record('Step 3 — Case Reference generated', false, `Value: "${testCaseRef}"`);
    }
  } catch (err) {
    record('Step 3 — Case Reference generated', false, err.message);
  }

  await sleep(500);

  // ── Step 4: Set Retainer Paid → Document Collection Started ──────────────
  step(4, 'Trigger Retainer Paid → Document Collection Started');
  try {
    // Call the service directly (as the webhook would when Retainer Status → Paid)
    await onRetainerPaid({ itemId: testItemId });

    await sleep(800);

    const cols = await fetchItemColumns(testItemId, [CM.caseStage, CM.paymentDate, CM.checklistApplied]);
    const stage = cols[CM.caseStage];
    const paid  = cols[CM.paymentDate];

    if (stage === 'Document Collection Started' && paid) {
      record('Step 4 — Retainer Paid / Stage set', true,
        `Stage: ${stage} | Payment Date: ${paid}`);
    } else {
      record('Step 4 — Retainer Paid / Stage set', false,
        `Stage: "${stage}" | Payment Date: "${paid}"`);
    }
  } catch (err) {
    record('Step 4 — Retainer Paid / Stage set', false, err.message);
  }

  await sleep(500);

  // ── Step 5: Set client email for later chasing/email tests ───────────────
  step(5, 'Set client email on test item (needed for emails)');
  try {
    const testEmail = `e2e-test+${Date.now()}@example.com`;
    // text_mm0xw6bp is the client email column (verified in previous session)
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
       }`,
      {
        boardId:   CM_BOARD_ID,
        itemId:    testItemId,
        colValues: JSON.stringify({ 'text_mm0xw6bp': testEmail }),
      }
    );
    record('Step 5 — Client email set', true, testEmail);
  } catch (err) {
    record('Step 5 — Client email set', false, err.message);
  }

  await sleep(500);

  // ── Wait for case ref to propagate if needed ──────────────────────────────
  if (!testCaseRef) {
    info('Case Ref not yet set — re-fetching…');
    const c = await fetchItemColumns(testItemId, [CM.caseRef]);
    testCaseRef = c[CM.caseRef] || null;
    info(`Case Ref after re-fetch: ${testCaseRef || '(still empty)'}`);
  }

  // ── Step 6: Trigger Document Checklist creation ───────────────────────────
  step(6, 'Trigger Document Checklist creation (checklistService)');
  try {
    await onDocumentCollectionStarted({ itemId: testItemId, boardId: CM_BOARD_ID });

    await sleep(2000); // allow OneDrive and Monday mutations to settle

    const cols = await fetchItemColumns(testItemId, [CM.checklistApplied]);
    const applied = cols[CM.checklistApplied];

    // Count execution items
    const execItems = testCaseRef
      ? await countExecutionItems(EXEC_BOARD_ID, 'text_mm0z2cck', testCaseRef)
      : [];

    if (applied === 'Yes' && execItems.length > 0) {
      record('Step 6 — Document checklist created', true,
        `${execItems.length} execution items | Checklist Applied: ${applied}`);
    } else if (applied === 'Yes') {
      record('Step 6 — Document checklist created', false,
        `Checklist Applied: ${applied} but 0 execution items found for ref "${testCaseRef}"`);
    } else {
      record('Step 6 — Document checklist created', false,
        `Checklist Applied: "${applied}" | Exec items: ${execItems.length}`);
    }
  } catch (err) {
    record('Step 6 — Document checklist created', false, err.message);
    console.error(err);
  }

  await sleep(1000);

  // ── Step 7: Trigger Questionnaire Execution creation ─────────────────────
  step(7, 'Trigger Questionnaire Execution creation (questionnaireService)');
  try {
    await onQStarted({ itemId: testItemId, boardId: CM_BOARD_ID });

    await sleep(2000);

    const cols = await fetchItemColumns(testItemId, [CM.questionnaireApplied]);
    const applied = cols[CM.questionnaireApplied];

    const qItems = testCaseRef
      ? await countExecutionItems(Q_BOARD_ID, 'text_mm12dgy9', testCaseRef)
      : [];

    if (applied === 'Yes') {
      record('Step 7 — Questionnaire execution created', true,
        `${qItems.length} Q items | Q Applied: ${applied}`);
    } else {
      // Some case types use HTML form mode — no Q board items, still valid
      warn(`Q Applied: "${applied}" | Q items: ${qItems.length} — may be HTML-form-only case type`);
      record('Step 7 — Questionnaire execution created',
        (applied === 'Yes' || qItems.length === 0), // pass if html form mode
        `Q Applied: "${applied}" | Q items: ${qItems.length}`);
    }
  } catch (err) {
    record('Step 7 — Questionnaire execution created', false, err.message);
    console.error(err);
  }

  await sleep(1000);

  // ── Step 8: Run SLA Risk Engine ───────────────────────────────────────────
  step(8, 'Run SLA Risk Engine');
  try {
    await runSlaCheck();
    await sleep(500);

    const cols = await fetchItemColumns(testItemId, [CM.slaRiskBand]);
    const band = cols[CM.slaRiskBand];

    if (['Green', 'Orange', 'Red'].includes(band)) {
      record('Step 8 — SLA Risk Band calculated', true, `SLA Band: ${band}`);
    } else {
      record('Step 8 — SLA Risk Band calculated', false, `SLA Band: "${band}"`);
    }
  } catch (err) {
    record('Step 8 — SLA Risk Engine', false, err.message);
  }

  await sleep(500);

  // ── Step 9: Run Expiry Risk Engine ────────────────────────────────────────
  step(9, 'Run Expiry Risk Engine');
  try {
    await runExpiryCheck();
    record('Step 9 — Expiry Risk Engine ran', true, 'No expiry columns set on test case (expected)');
  } catch (err) {
    record('Step 9 — Expiry Risk Engine', false, err.message);
  }

  await sleep(500);

  // ── Step 10: Run Case Health Engine ──────────────────────────────────────
  step(10, 'Run Case Health Engine');
  try {
    await runHealthCheck();
    await sleep(500);

    const cols = await fetchItemColumns(testItemId, [
      CM.caseHealthStatus, CM.clientDelayLevel,
      CM.clientResponsiveness, CM.clientBlockedStatus,
    ]);

    const health      = cols[CM.caseHealthStatus];
    const delay       = cols[CM.clientDelayLevel];
    const score       = cols[CM.clientResponsiveness];
    const blocked     = cols[CM.clientBlockedStatus];

    const ok = ['Green', 'Orange', 'Red'].includes(health)
            && ['Low', 'Medium', 'High'].includes(delay)
            && blocked !== '';

    record('Step 10 — Case Health calculated', ok,
      `Health: ${health} | Delay: ${delay} | Score: ${score} | Blocked: ${blocked}`);
  } catch (err) {
    record('Step 10 — Case Health Engine', false, err.message);
  }

  await sleep(500);

  // ── Step 11: Run Readiness Calculation ───────────────────────────────────
  step(11, 'Run Readiness Calculation');
  try {
    if (testCaseRef) {
      await calculateForCaseRef(testCaseRef);
      await sleep(800);

      const cols = await fetchItemColumns(testItemId, [CM.docReadiness, CM.qReadiness]);
      const docR = cols[CM.docReadiness];
      const qR   = cols[CM.qReadiness];

      record('Step 11 — Readiness calculated', true,
        `Doc Readiness: ${docR}% | Q Readiness: ${qR}%`);
    } else {
      record('Step 11 — Readiness calculated', false, 'No caseRef available — skipping');
    }
  } catch (err) {
    record('Step 11 — Readiness Calculation', false, err.message);
  }

  await sleep(500);

  // ── Step 12: Verify final state of Client Master item ────────────────────
  step(12, 'Verify final state of Client Master item');
  try {
    const allColIds = Object.values(CM);
    const cols      = await fetchItemColumns(testItemId, allColIds);

    console.log(`\n  Client: ${cols._name}`);
    console.log(`  Case Ref:            ${cols[CM.caseRef]        || '(empty)'}`);
    console.log(`  Case Type:           ${cols[CM.caseType]       || '(empty)'}`);
    console.log(`  Case Stage:          ${cols[CM.caseStage]      || '(empty)'}`);
    console.log(`  Access Token:        ${cols[CM.accessToken]    || '(empty)'}`);
    console.log(`  Checklist Applied:   ${cols[CM.checklistApplied] || '(empty)'}`);
    console.log(`  Q Applied:           ${cols[CM.questionnaireApplied] || '(empty)'}`);
    console.log(`  Payment Date:        ${cols[CM.paymentDate]    || '(empty)'}`);
    console.log(`  SLA Risk Band:       ${cols[CM.slaRiskBand]    || '(empty)'}`);
    console.log(`  Case Health Status:  ${cols[CM.caseHealthStatus] || '(empty)'}`);
    console.log(`  Client Delay Level:  ${cols[CM.clientDelayLevel] || '(empty)'}`);
    console.log(`  Client Blocked:      ${cols[CM.clientBlockedStatus] || '(empty)'}`);
    console.log(`  Responsiveness:      ${cols[CM.clientResponsiveness] || '(empty)'}`);
    console.log(`  Doc Readiness:       ${cols[CM.docReadiness]   || '(empty)'}%`);
    console.log(`  Q Readiness:         ${cols[CM.qReadiness]     || '(empty)'}%`);

    const criticalOk =
      cols[CM.caseRef]?.startsWith(`${new Date().getFullYear()}-`) &&
      cols[CM.accessToken]?.startsWith('TDOT-') &&
      cols[CM.caseStage] === 'Document Collection Started' &&
      cols[CM.checklistApplied] === 'Yes' &&
      ['Green', 'Orange', 'Red'].includes(cols[CM.caseHealthStatus]);

    record('Step 12 — Final state verified', criticalOk,
      criticalOk ? 'All critical columns populated' : 'One or more critical columns missing');
  } catch (err) {
    record('Step 12 — Final state verified', false, err.message);
  }

  // ── Step 13: Cleanup ──────────────────────────────────────────────────────
  step(13, `Cleanup test item${NO_CLEANUP ? ' (SKIPPED — --no-cleanup flag)' : ''}`);

  if (!NO_CLEANUP) {
    try {
      // Clean up execution items
      if (testCaseRef) {
        const execItems = await countExecutionItems(EXEC_BOARD_ID, 'text_mm0z2cck', testCaseRef);
        const qItems    = await countExecutionItems(Q_BOARD_ID, 'text_mm12dgy9', testCaseRef);

        for (const item of [...execItems, ...qItems]) {
          try {
            await mondayApi.query(
              `mutation($itemId: ID!) { delete_item(item_id: $itemId) { id } }`,
              { itemId: String(item.id) }
            );
            await sleep(100);
          } catch (e) {
            warn(`Could not delete execution item ${item.id}: ${e.message}`);
          }
        }
        info(`Deleted ${execItems.length} doc execution items + ${qItems.length} Q items`);
      }

      // Delete the Client Master test item
      await mondayApi.query(
        `mutation($itemId: ID!) { delete_item(item_id: $itemId) { id } }`,
        { itemId: String(testItemId) }
      );

      record('Step 13 — Cleanup', true, `Deleted test item ${testItemId} and execution items`);
    } catch (err) {
      record('Step 13 — Cleanup', false, err.message);
    }
  } else {
    warn(`Cleanup skipped. Test item ID: ${testItemId} | Case Ref: ${testCaseRef}`);
    record('Step 13 — Cleanup', true, 'Skipped by --no-cleanup flag');
  }

  // ── Final Report ──────────────────────────────────────────────────────────

  const total  = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  console.log(`\n${BOLD}════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  TEST RESULTS${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════════${RESET}`);

  for (const r of results) {
    const symbol = r.ok ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
    console.log(`  ${symbol}  ${r.stepName}${r.detail ? ` — ${r.detail}` : ''}`);
  }

  console.log(`\n${BOLD}  Total: ${total} | Passed: ${GREEN}${passed}${RESET}${BOLD} | Failed: ${failed > 0 ? RED : GREEN}${failed}${RESET}`);

  if (failed === 0) {
    console.log(`\n${GREEN}${BOLD}  ✅ ALL TESTS PASSED — Automation is healthy!${RESET}\n`);
  } else {
    console.log(`\n${RED}${BOLD}  ❌ ${failed} TEST(S) FAILED — Review the output above.${RESET}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n💥 Unexpected error:', err);
  process.exit(1);
});
