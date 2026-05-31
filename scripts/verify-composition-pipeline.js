/**
 * Live end-to-end verification: Family Members board → compositionAdapter →
 * seedPlanner. Creates a few throwaway member rows under a TEST case ref,
 * reads them back through the real adapter, runs the pure planner, prints the
 * resulting checklist, then deletes the throwaway rows.
 *
 * Proves the wiring works against real Monday without touching any real case.
 *
 *   node scripts/verify-composition-pipeline.js          # create, verify, clean up
 *   node scripts/verify-composition-pipeline.js --keep   # leave rows on the board
 */

'use strict';

require('dotenv').config();
const mondayApi          = require('../src/services/mondayApi');
const boardCfg           = require('../src/data/familyMembersBoard.json');
const compositionAdapter = require('../src/services/compositionAdapter');
const { seedPlan }       = require('../src/services/seedPlanner');
const schema             = require('../src/data/caseSchemas/supervisa-parents.js');

const KEEP     = process.argv.includes('--keep');
const TEST_REF = 'ZZZ-PIPELINE-TEST';
const C        = boardCfg.columns;
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_MEMBERS = [
  { name: 'Ramesh (PA)',     memberType: 'Principal Applicant', flags: [] },
  { name: 'Sunita (Spouse)', memberType: 'Spouse',              flags: ['Name Changed'] },
  { name: 'Arjun (Sponsor)', memberType: 'Sponsor',             flags: [] },
];

async function createMember(m) {
  const cols = {
    [C.caseReference]: TEST_REF,
    [C.memberType]:    { label: m.memberType },
  };
  if (m.flags.length) cols[C.flags] = { labels: m.flags };
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $name: String!, $cols: JSON!) {
       create_item(board_id: $boardId, item_name: $name, column_values: $cols, create_labels_if_missing: true) { id }
     }`,
    { boardId: String(boardCfg.boardId), name: m.name, cols: JSON.stringify(cols) }
  );
  return data?.create_item?.id;
}

async function main() {
  console.log(`Creating ${TEST_MEMBERS.length} throwaway member rows under ${TEST_REF}…`);
  const ids = [];
  for (const m of TEST_MEMBERS) {
    ids.push(await createMember(m));
    await sleep(250);
  }
  console.log(`  created ids: ${ids.join(', ')}\n`);

  // Monday search indexing can lag a beat after create.
  await sleep(1500);

  console.log('Reading composition back through the adapter…');
  const composition = await compositionAdapter.readForCase(TEST_REF);
  console.log(JSON.stringify(composition, null, 2));

  console.log('\nRunning seedPlanner against Supervisa-Parents schema…');
  const plan = seedPlan({ schema, composition });
  const byRole = {};
  for (const r of plan) byRole[r.role] = (byRole[r.role] || 0) + 1;
  console.log(`  Plan: ${plan.length} rows — ${JSON.stringify(byRole)}`);
  for (const r of plan) {
    console.log(`    [${r.applicantType.padEnd(22)}] [${(r.category).padEnd(10)}] ${r.documentName}`);
  }

  if (!KEEP) {
    console.log('\nCleaning up throwaway rows…');
    for (const id of ids) {
      if (!id) continue;
      await mondayApi.query(`mutation($id: ID!) { delete_item(item_id: $id) { id } }`, { id: String(id) });
      await sleep(200);
    }
    console.log('  deleted.');
  } else {
    console.log('\n(--keep) Rows left on the board.');
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
