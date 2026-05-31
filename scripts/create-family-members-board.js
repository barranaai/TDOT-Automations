/**
 * One-time setup — create the "Family Members" board.
 *
 * One row = one person on a case. The checklist seeder reads composition from
 * this board (filled manually today, by the intake form later).
 *
 * Creates a NEW empty board. Touches nothing existing. The only reference to an
 * existing board is the optional board_relation column pointing at Client Master
 * (read-only link; does not modify Client Master).
 *
 * After creation, writes the board id + column ids to
 * src/data/familyMembersBoard.json so the adapter can read them.
 *
 * Safety: default DRY-RUN. Pass --write to actually create.
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE            = process.argv.includes('--write');
const CLIENT_MASTER_ID = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const WORKSPACE_ID     = process.env.MONDAY_WORKSPACE_ID || '14447959'; // "TDOT Boards" — where the production boards live
const OUT_PATH         = path.join(__dirname, '..', 'src', 'data', 'familyMembersBoard.json');

const MEMBER_TYPE_LABELS = [
  'Principal Applicant', 'Spouse', 'Dependent Child',
  'Sponsor', 'Worker Spouse', 'Parent', 'Sibling',
];

const FLAG_LABELS = [
  'Name Changed', 'Married More Than Once', 'Common-Law',
  'Previously Sponsored', 'Former Spouse Deceased',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createColumn(boardId, title, columnType, defaults) {
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) {
         id title type
       }
     }`,
    { boardId: String(boardId), title, type: columnType, defaults: defaults ? JSON.stringify(defaults) : null }
  );
  const col = data?.create_column;
  console.log(`   + ${title.padEnd(22)} [${columnType}] → ${col?.id}`);
  return col?.id;
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN'}\n`);
  if (!WRITE) {
    console.log('Would create board "Family Members" (public) with columns:');
    console.log('   • Case Reference        [text]          — functional key the adapter queries on');
    console.log('   • Case                  [board_relation]→ Client Master (human navigation)');
    console.log(`   • Member Type           [status]        — ${MEMBER_TYPE_LABELS.join(' / ')}`);
    console.log('   • Date of Birth         [date]');
    console.log('   • Country of Residence  [text]');
    console.log('   • Current Status        [text]');
    console.log(`   • Flags                 [dropdown]      — ${FLAG_LABELS.join(' / ')}`);
    console.log('   • Member Key            [text]          — stable key tying to questionnaire');
    console.log('\n(Dry-run only. Re-run with --write to create.)');
    return;
  }

  // ── 1. Create the board (in the target workspace) ──────────────────────────
  const boardData = await mondayApi.query(
    `mutation($name: String!, $workspaceId: ID!) {
       create_board(board_name: $name, board_kind: public, workspace_id: $workspaceId) { id name }
     }`,
    { name: 'Family Members', workspaceId: String(WORKSPACE_ID) }
  );
  const boardId = boardData?.create_board?.id;
  if (!boardId) throw new Error('Board creation returned no id');
  console.log(`Created board "Family Members" → ${boardId} (workspace ${WORKSPACE_ID})\n`);
  console.log('Creating columns:');

  // ── 2. Columns ─────────────────────────────────────────────────────────────
  const cols = {};
  cols.caseReference = await createColumn(boardId, 'Case Reference', 'text');
  await sleep(200);

  // board_relation to Client Master (best-effort — functional key is the text col above)
  try {
    cols.case = await createColumn(boardId, 'Case', 'board_relation', { boardIds: [Number(CLIENT_MASTER_ID)] });
  } catch (err) {
    console.warn(`     ⚠ board_relation "Case" failed (${err.message}). Skipping — text Case Reference is the functional key.`);
    cols.case = null;
  }
  await sleep(200);

  cols.memberType = await createColumn(boardId, 'Member Type', 'status',
    { labels: Object.fromEntries(MEMBER_TYPE_LABELS.map((l, i) => [String(i + 1), l])) });
  await sleep(200);

  cols.dateOfBirth = await createColumn(boardId, 'Date of Birth', 'date');
  await sleep(200);

  cols.countryOfResidence = await createColumn(boardId, 'Country of Residence', 'text');
  await sleep(200);

  cols.currentStatus = await createColumn(boardId, 'Current Status', 'text');
  await sleep(200);

  cols.flags = await createColumn(boardId, 'Flags', 'dropdown',
    { settings: { labels: FLAG_LABELS.map((name, i) => ({ id: i + 1, name })) } });
  await sleep(200);

  cols.memberKey = await createColumn(boardId, 'Member Key', 'text');

  // ── 3. Persist board + column ids for the adapter ──────────────────────────
  const out = {
    boardId,
    clientMasterBoardId: CLIENT_MASTER_ID,
    columns: cols,
    memberTypeLabels: MEMBER_TYPE_LABELS,
    flagLabels: FLAG_LABELS,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote board config → ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log('\nDone.');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
