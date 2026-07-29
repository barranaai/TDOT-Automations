/**
 * Safe end-to-end test for ANY schema-driven case type.
 * For each test case: create a throwaway Client Master item + Family Members,
 * run the real seeding entrypoint, verify the Execution Board got exactly the
 * rows the planner expects, then delete everything. Touches no real case.
 */
'use strict';
require('dotenv').config();
const mondayApi = require('../src/services/mondayApi');
const fmBoard   = require('../src/data/familyMembersBoard.json');
const adapter   = require('../src/services/compositionAdapter');
const { seedPlan } = require('../src/services/seedPlanner');
const caseSchemas  = require('../src/services/caseSchemaService');

const CM_BOARD   = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const EXEC_BOARD = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const FMC = fmBoard.columns;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TESTS = [
  { ref: 'ZZZ-TEST-VV', caseType: 'Visitor Visa', subType: '1-3 Members', members: [
      { name: 'Test PA',      type: 'Principal Applicant' },
      { name: 'Test Spouse',  type: 'Spouse' },
      { name: 'Test Child 1', type: 'Dependent Child' },
      { name: 'Test Child 2', type: 'Dependent Child' },
      { name: 'Test Sponsor', type: 'Sponsor' },
  ]},
  { ref: 'ZZZ-TEST-WP', caseType: 'LMIA Based WP', subType: 'Inside Canada', members: [
      { name: 'Test Worker', type: 'Principal Applicant' },
      { name: 'Test Spouse', type: 'Spouse' },
      { name: 'Test Child',  type: 'Dependent Child' },
  ]},
];

async function createCM(t) {
  const cols = { text_mm142s49: t.ref, dropdown_mm0xd1qn: { labels: [t.caseType] }, dropdown_mm0x4t91: { labels: [t.subType] } };
  const d = await mondayApi.query(
    `mutation($b:ID!,$n:String!,$c:JSON!){create_item(board_id:$b,item_name:$n,column_values:$c,create_labels_if_missing:true){id}}`,
    { b: String(CM_BOARD), n: 'ZZZ Test ' + t.caseType, c: JSON.stringify(cols) });
  return d.create_item.id;
}
async function addMember(ref, m) {
  const d = await mondayApi.query(
    `mutation($b:ID!,$n:String!,$c:JSON!){create_item(board_id:$b,item_name:$n,column_values:$c,create_labels_if_missing:true){id}}`,
    { b: String(fmBoard.boardId), n: m.name, c: JSON.stringify({ [FMC.caseReference]: ref, [FMC.memberType]: { label: m.type } }) });
  return d.create_item.id;
}
async function execRows(ref) {
  const d = await mondayApi.query(
    `query($b:ID!,$v:String!){items_page_by_column_values(limit:300,board_id:$b,columns:[{column_id:"text_mm0z2cck",column_values:[$v]}]){items{id column_values(ids:["text_mm26jcv7"]){text}}}}`,
    { b: String(EXEC_BOARD), v: ref });
  return d.items_page_by_column_values.items;
}
async function del(ids){ for(const id of ids){ if(!id) continue; await mondayApi.query(`mutation($id:ID!){delete_item(item_id:$id){id}}`,{id:String(id)}); await sleep(120);} }

async function runTest(t) {
  console.log('\n========== ' + t.caseType + ' / ' + t.subType + ' ==========');
  const cmId = await createCM(t);
  const fmIds = [];
  for (const m of t.members) { fmIds.push(await addMember(t.ref, m)); await sleep(200); }
  console.log('Created fake case + ' + t.members.length + ' family members: ' + t.members.map(m=>m.type).join(', '));
  await sleep(1500);

  // expected = what the planner says for this composition
  const comp = await adapter.readForCase(t.ref);
  const expected = seedPlan({ schema: caseSchemas.lookup(t.caseType, t.subType), composition: comp });

  process.env.SCHEMA_DRIVEN_SEEDING = 'true';
  process.env.SCHEMA_DRIVEN_ALLOWLIST = t.caseType + ':' + t.subType;
  const { onDocumentCollectionStarted } = require('../src/services/checklistService');
  await onDocumentCollectionStarted({ itemId: cmId, boardId: CM_BOARD });
  await sleep(1500);

  const rows = await execRows(t.ref);
  const byRole = {}; rows.forEach(r => { const a = r.column_values[0].text || '?'; byRole[a] = (byRole[a]||0)+1; });
  console.log('Checklist created: ' + rows.length + ' documents  ' + JSON.stringify(byRole));
  console.log('RESULT: ' + (rows.length === expected.length ? '✅ PASS' : '❌ FAIL') + '  (expected ' + expected.length + ')');

  console.log('Cleaning up…');
  await del(rows.map(r=>r.id)); await del(fmIds); await del([cmId]);
  console.log('  done — nothing left behind.');
}

(async () => { for (const t of TESTS) await runTest(t); })().catch(e => { console.error('Fatal:', e); process.exit(1); });
