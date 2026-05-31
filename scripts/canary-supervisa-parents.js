/**
 * Step 6 — live canary for schema-driven seeding, on a THROWAWAY case.
 *
 * Exercises the exact production path: it calls the same
 * checklistService.onDocumentCollectionStarted() that the Monday webhook calls,
 * with the schema-driven flag enabled IN-PROCESS (does not change Render env).
 *
 * Sequence:
 *   1. Create a throwaway Client Master item (Supervisa / Parents).
 *   2. Add Family Members rows (PA, Spouse w/ Name Changed, Sponsor).
 *   3. Enable SCHEMA_DRIVEN_SEEDING + allowlist for THIS process only.
 *   4. Call onDocumentCollectionStarted() → seeds Execution Board from schema.
 *   5. Verify: row count + per-role breakdown + "Checklist Template Applied".
 *   6. Tear everything down (unless --keep).
 *
 * Nothing real is touched. OneDrive folder creation will no-op locally (no MS
 * creds) — the code handles that gracefully; rows still get created.
 *
 *   node scripts/canary-supervisa-parents.js          # run + verify + clean up
 *   node scripts/canary-supervisa-parents.js --keep   # leave everything in place
 */

'use strict';

require('dotenv').config();
const mondayApi  = require('../src/services/mondayApi');
const fmBoard    = require('../src/data/familyMembersBoard.json');

const KEEP        = process.argv.includes('--keep');
const CM_BOARD    = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const EXEC_BOARD  = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF    = 'ZZZ-CANARY-SV';
const CLIENT_NAME = 'ZZZ Canary Patel';
const sleep       = (ms) => new Promise((r) => setTimeout(r, ms));

const CM = {
  caseRef:  'text_mm142s49',
  caseType: 'dropdown_mm0xd1qn',
  subType:  'dropdown_mm0x4t91',
  applied:  'color_mm0xs7kp',
};
const FMC = fmBoard.columns;
const EXEC_CASEREF = 'text_mm0z2cck';
const EXEC_APPLICANT = 'text_mm26jcv7';

const MEMBERS = [
  { name: 'Canary PA',      type: 'Principal Applicant', flags: [] },
  { name: 'Canary Spouse',  type: 'Spouse',              flags: ['Name Changed'] },
  { name: 'Canary Sponsor', type: 'Sponsor',             flags: [] },
];

async function createClientMaster() {
  const cols = {
    [CM.caseRef]:  CASE_REF,
    [CM.caseType]: { labels: ['Supervisa'] },
    [CM.subType]:  { labels: ['Parents'] },
  };
  const d = await mondayApi.query(
    `mutation($b: ID!, $n: String!, $c: JSON!) {
       create_item(board_id: $b, item_name: $n, column_values: $c, create_labels_if_missing: true) { id }
     }`,
    { b: String(CM_BOARD), n: CLIENT_NAME, c: JSON.stringify(cols) }
  );
  return d?.create_item?.id;
}

async function createFamilyMember(m) {
  const cols = { [FMC.caseReference]: CASE_REF, [FMC.memberType]: { label: m.type } };
  if (m.flags.length) cols[FMC.flags] = { labels: m.flags };
  const d = await mondayApi.query(
    `mutation($b: ID!, $n: String!, $c: JSON!) {
       create_item(board_id: $b, item_name: $n, column_values: $c, create_labels_if_missing: true) { id }
     }`,
    { b: String(fmBoard.boardId), n: m.name, c: JSON.stringify(cols) }
  );
  return d?.create_item?.id;
}

async function fetchRowsByCaseRef(boardId, colId, fields = 'id name') {
  const d = await mondayApi.query(
    `query($b: ID!, $c: String!, $v: String!) {
       items_page_by_column_values(limit: 300, board_id: $b, columns: [{ column_id: $c, column_values: [$v] }]) {
         items { ${fields} }
       }
     }`,
    { b: String(boardId), c: colId, v: CASE_REF }
  );
  return d?.items_page_by_column_values?.items || [];
}

async function deleteItems(ids) {
  for (const id of ids) {
    if (!id) continue;
    await mondayApi.query(`mutation($id: ID!){ delete_item(item_id: $id){ id } }`, { id: String(id) });
    await sleep(150);
  }
}

async function main() {
  console.log('── Step 6 canary: Supervisa / Parents (throwaway case ' + CASE_REF + ') ──\n');

  // 1. Client Master throwaway item
  const cmId = await createClientMaster();
  console.log(`1. Client Master item created: ${cmId} ("${CLIENT_NAME}")`);
  await sleep(400);

  // 2. Family Members
  const fmIds = [];
  for (const m of MEMBERS) { fmIds.push(await createFamilyMember(m)); await sleep(250); }
  console.log(`2. Family Members created: ${fmIds.join(', ')}  (PA, Spouse[Name Changed], Sponsor)`);
  await sleep(1500); // let Monday index

  // 3. Enable the flag for THIS process only.
  process.env.SCHEMA_DRIVEN_SEEDING   = 'true';
  process.env.SCHEMA_DRIVEN_ALLOWLIST = 'Supervisa:Parents';
  console.log('3. Flag enabled in-process: SCHEMA_DRIVEN_SEEDING=true, allowlist=Supervisa:Parents\n');

  // 4. Call the EXACT production entrypoint the webhook uses.
  const { onDocumentCollectionStarted } = require('../src/services/checklistService');
  console.log('4. Invoking onDocumentCollectionStarted()…');
  await onDocumentCollectionStarted({ itemId: cmId, boardId: CM_BOARD });
  await sleep(1500);

  // 5. Verify
  console.log('\n5. Verifying Execution Board…');
  const execRows = await fetchRowsByCaseRef(EXEC_BOARD, EXEC_CASEREF, `id name column_values(ids:["${EXEC_APPLICANT}"]){ text }`);
  const byRole = {};
  for (const r of execRows) {
    const at = r.column_values?.[0]?.text || '(none)';
    byRole[at] = (byRole[at] || 0) + 1;
  }
  console.log(`   Execution rows for ${CASE_REF}: ${execRows.length}`);
  console.log(`   By applicant: ${JSON.stringify(byRole)}`);

  const cmCheck = await mondayApi.query(
    `query($id: ID!){ items(ids:[$id]){ column_values(ids:["${CM.applied}"]){ text } } }`, { id: String(cmId) }
  );
  const applied = cmCheck?.items?.[0]?.column_values?.[0]?.text;
  console.log(`   Checklist Template Applied: ${applied}`);

  const EXPECTED = 28; // PA 10 + Spouse 11 (name-change affidavit) + Sponsor 7
  const pass = execRows.length === EXPECTED && applied === 'Yes';
  console.log(`\n   Canary: ${pass ? '✅ PASS' : '❌ FAIL'}  (expected ${EXPECTED} rows + Applied=Yes)`);

  // 6. Teardown
  if (!KEEP) {
    console.log('\n6. Cleaning up…');
    await deleteItems(execRows.map((r) => r.id));
    await deleteItems(fmIds);
    await deleteItems([cmId]);
    console.log('   deleted Execution rows, Family Members, and Client Master item.');
  } else {
    console.log('\n6. (--keep) Left in place. Manual cleanup needed.');
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
