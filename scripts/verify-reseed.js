/**
 * Verifies reseedByCaseRef() and the "populate Family Members late → re-seed"
 * recovery workflow, against real boards with a throwaway case.
 *
 * Scenario:
 *   1. Case seeded with only PA + Sponsor on the Family Members board → 17 rows.
 *   2. Officer adds the Spouse (Name Changed) to Family Members afterwards.
 *   3. Re-seed → adds the 11 spouse rows ONLY (created 11, skipped 17) → 28 total.
 *
 * That's the gap the admin endpoint closes. No intake email, no stage change.
 *
 *   node scripts/verify-reseed.js          # run + verify + clean up
 *   node scripts/verify-reseed.js --keep   # leave everything in place
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../src/services/mondayApi');
const fmBoard   = require('../src/data/familyMembersBoard.json');
const checklist = require('../src/services/checklistService');

const KEEP       = process.argv.includes('--keep');
const CM_BOARD   = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const EXEC_BOARD = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF   = 'ZZZ-RESEED-SV';
const sleep      = (ms) => new Promise((r) => setTimeout(r, ms));
const FMC = fmBoard.columns;

async function createCM() {
  const cols = {
    text_mm142s49:     CASE_REF,
    dropdown_mm0xd1qn: { labels: ['Supervisa'] },
    dropdown_mm0x4t91: { labels: ['Parents'] },
  };
  const d = await mondayApi.query(
    `mutation($b: ID!, $n: String!, $c: JSON!){ create_item(board_id:$b,item_name:$n,column_values:$c,create_labels_if_missing:true){ id } }`,
    { b: String(CM_BOARD), n: 'ZZZ Reseed Patel', c: JSON.stringify(cols) }
  );
  return d.create_item.id;
}
async function addMember(name, type, flags = []) {
  const cols = { [FMC.caseReference]: CASE_REF, [FMC.memberType]: { label: type } };
  if (flags.length) cols[FMC.flags] = { labels: flags };
  const d = await mondayApi.query(
    `mutation($b: ID!, $n: String!, $c: JSON!){ create_item(board_id:$b,item_name:$n,column_values:$c,create_labels_if_missing:true){ id } }`,
    { b: String(fmBoard.boardId), n: name, c: JSON.stringify(cols) }
  );
  return d.create_item.id;
}
async function countExec() {
  const d = await mondayApi.query(
    `query($b: ID!, $v: String!){ items_page_by_column_values(limit:300,board_id:$b,columns:[{column_id:"text_mm0z2cck",column_values:[$v]}]){ items{ id } } }`,
    { b: String(EXEC_BOARD), v: CASE_REF }
  );
  return d.items_page_by_column_values.items;
}
async function del(ids){ for (const id of ids){ if(!id) continue; await mondayApi.query('mutation($id:ID!){delete_item(item_id:$id){id}}',{id:String(id)}); await sleep(150);} }

async function main() {
  const cleanup = [];
  try {
    const cmId = await createCM(); cleanup.push(['cm', cmId]);
    console.log(`CM item: ${cmId}`);
    const m1 = await addMember('Reseed PA', 'Principal Applicant');     cleanup.push(['fm', m1]);
    const m2 = await addMember('Reseed Sponsor', 'Sponsor');           cleanup.push(['fm', m2]);
    console.log('Family Members: PA + Sponsor (no spouse yet)');
    await sleep(1500);

    console.log('\n── Re-seed #1 (no spouse) ──');
    const r1 = await checklist.reseedByCaseRef(CASE_REF);
    console.log(`  result: ${JSON.stringify(r1)}`);
    await sleep(1200);
    let rows = await countExec();
    console.log(`  rows on board: ${rows.length}  (expect 17)`);

    console.log('\n── Officer adds Spouse (Name Changed) to Family Members ──');
    const m3 = await addMember('Reseed Spouse', 'Spouse', ['Name Changed']); cleanup.push(['fm', m3]);
    await sleep(1500);

    console.log('\n── Re-seed #2 (spouse added) ──');
    const r2 = await checklist.reseedByCaseRef(CASE_REF);
    console.log(`  result: ${JSON.stringify(r2)}`);
    await sleep(1200);
    rows = await countExec();
    console.log(`  rows on board: ${rows.length}  (expect 28)`);

    const pass = r1.created === 17 && r2.created === 11 && r2.skipped === 17 && rows.length === 28;
    console.log(`\nRe-seed workflow: ${pass ? '✅ PASS' : '❌ FAIL'}`);
    cleanup.push(...rows.map((r) => ['fm-exec', r.id])); // exec rows for cleanup
  } finally {
    if (!KEEP) {
      console.log('\nCleaning up…');
      const execRows = await countExec();
      await del(execRows.map((r) => r.id));
      await del(cleanup.filter(([t]) => t === 'fm').map(([, id]) => id));
      await del(cleanup.filter(([t]) => t === 'cm').map(([, id]) => id));
      console.log('  done.');
    } else {
      console.log('\n(--keep) left in place.');
    }
  }
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
