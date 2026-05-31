/**
 * Live integration test for executionSeederService against the REAL Execution
 * Board, using a throwaway case ref so no real case is touched.
 *
 * Proves:
 *   1. reconcile creates the planned rows,
 *   2. re-running creates ZERO (idempotency),
 *   3. cleanup deletes them.
 *
 *   node scripts/verify-execution-seeder.js          # create, re-run, verify, clean up
 *   node scripts/verify-execution-seeder.js --keep   # leave rows on the board
 */

'use strict';

require('dotenv').config();
const mondayApi    = require('../src/services/mondayApi');
const { seedPlan } = require('../src/services/seedPlanner');
const seeder       = require('../src/services/executionSeederService');
const schema       = require('../src/data/caseSchemas/supervisa-parents.js');

const KEEP     = process.argv.includes('--keep');
const TEST_REF = 'ZZZ-EXEC-TEST';
const BOARD_ID = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF_COL = seeder._cols.caseReferenceNumber;
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

// PA applying alone → 10 PA docs + 7 Sponsor (required) = 17 rows.
const composition = {
  caseFlags: { spouseIncluded: false },
  members:   [{ role: 'PrincipalApplicant', flags: { nameChanged: false } }],
};

async function fetchTestRows() {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]) { items { id name } }
     }`,
    { boardId: String(BOARD_ID), colId: CASE_REF_COL, val: TEST_REF }
  );
  return data?.items_page_by_column_values?.items || [];
}

async function main() {
  const plan = seedPlan({ schema, composition });
  console.log(`Plan: ${plan.length} rows (PA alone + required Sponsor)\n`);

  console.log('── Run 1: reconcile (should create all) ──');
  const r1 = await seeder.reconcileExecutionRows({
    caseRef: TEST_REF, caseSubType: schema.subType, plan,
  });
  console.log(`  → created ${r1.created}, skipped ${r1.skipped}, failed ${r1.failed}\n`);

  await sleep(1500); // let Monday index the new rows

  console.log('── Run 2: reconcile again (should create NOTHING — idempotency) ──');
  const r2 = await seeder.reconcileExecutionRows({
    caseRef: TEST_REF, caseSubType: schema.subType, plan,
  });
  console.log(`  → created ${r2.created}, skipped ${r2.skipped}, failed ${r2.failed}\n`);

  const rows = await fetchTestRows();
  console.log(`On board now: ${rows.length} rows for ${TEST_REF}`);

  // ── Assertions ──
  const ok = r1.created === plan.length && r2.created === 0 && r2.skipped === plan.length;
  console.log(`\nIdempotency check: ${ok ? '✅ PASS' : '❌ FAIL'}`);

  if (!KEEP) {
    console.log('\nCleaning up…');
    let del = 0;
    for (const it of rows) {
      await mondayApi.query(`mutation($id: ID!){ delete_item(item_id: $id){ id } }`, { id: String(it.id) });
      del++; await sleep(150);
    }
    console.log(`  deleted ${del} rows.`);
  } else {
    console.log('\n(--keep) Rows left on the board.');
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
