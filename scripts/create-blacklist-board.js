/**
 * One-time setup — create the "Not Wanted list" board (Gauri 2026-10-08, point 5).
 *
 * One row = one PERSON the firm has decided not to serve (the consultant's
 * outcome "Not Wanted"). The app fills it (blacklistService) and reads it to
 * warn staff when the person comes back — by email or phone. Staff can read it
 * in Monday; only named admins remove someone (the row is kept as Removed).
 *
 * Creates a NEW empty board. Touches nothing existing. After creation, writes
 * the board id + column ids to src/data/blacklistBoard.json — blacklistService
 * treats a missing file as "feature dormant", so merely running this script
 * changes no behaviour until the app that reads the file is deployed.
 *
 * IMPORTANT: keep this board automation-free in Monday (a board automation
 * stamping labels on new items has burned us before).
 *
 * Safety: default DRY-RUN. Pass --write to actually create.
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE        = process.argv.includes('--write');
const WORKSPACE_ID = process.env.MONDAY_WORKSPACE_ID || '14447959'; // "TDOT Boards"
const BOARD_NAME   = 'Not Wanted list';
const OUT_PATH     = path.join(__dirname, '..', 'src', 'data', 'blacklistBoard.json');

const STATUS_LABELS = ['Active', 'Removed'];
const COLUMNS = [
  // key              title              type          note
  ['emails',          'Emails',          'text',       'MATCH KEY — lowercased, comma-separated'],
  ['phones',          'Phones',          'text',       'MATCH KEY — digits only (no leading 1), comma-separated'],
  ['reason',          'Reason',          'long_text',  'the consultant’s reason, as typed'],
  ['status',          'Status',          'status',     STATUS_LABELS.join(' / ')],
  ['leadIds',         'Lead Ids',        'text',       'the Lead Board items this person was Not Wanted on'],
  ['addedBy',         'Added By',        'text',       ''],
  ['addedOn',         'Added On',        'date',       ''],
  ['source',          'Source',          'text',       'portal / monday / sweep'],
  ['removedBy',       'Removed By',      'text',       'named admin'],
  ['removedOn',       'Removed On',      'date',       ''],
  ['removalReason',   'Removal Reason',  'long_text',  ''],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createColumn(boardId, title, columnType, defaults) {
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id title type }
     }`,
    { boardId: String(boardId), title, type: columnType, defaults: defaults ? JSON.stringify(defaults) : null }
  );
  const col = data?.create_column;
  console.log(`   + ${title.padEnd(16)} [${columnType}] → ${col?.id}`);
  return col?.id;
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN'}\n`);
  if (fs.existsSync(OUT_PATH)) {
    console.log(`STOPPED — ${path.relative(process.cwd(), OUT_PATH)} already exists (board ${JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).boardId}). Delete the file first if you really mean to create a second board.`);
    process.exit(2);
  }
  // Refuse to create a second board with the same name.
  const existing = await mondayApi.query('query($ws: [ID!]) { boards(workspace_ids: $ws, limit: 200) { id name } }', { ws: [String(WORKSPACE_ID)] });
  const dup = (existing?.boards || []).find((b) => b.name === BOARD_NAME);
  if (dup) { console.log(`STOPPED — a board named "${BOARD_NAME}" already exists: ${dup.id}`); process.exit(2); }

  console.log(`Would create board "${BOARD_NAME}" (public, workspace ${WORKSPACE_ID}) with columns:`);
  for (const [, title, type, note] of COLUMNS) console.log(`   • ${title.padEnd(16)} [${type.padEnd(9)}] ${note}`);
  if (!WRITE) { console.log('\n(Dry-run only. Re-run with --write to create.)'); return; }

  const boardData = await mondayApi.query(
    `mutation($name: String!, $workspaceId: ID!) {
       create_board(board_name: $name, board_kind: public, workspace_id: $workspaceId) { id name }
     }`,
    { name: BOARD_NAME, workspaceId: String(WORKSPACE_ID) }
  );
  const boardId = boardData?.create_board?.id;
  if (!boardId) throw new Error('Board creation returned no id');
  console.log(`Created board "${BOARD_NAME}" → ${boardId} (workspace ${WORKSPACE_ID})\n`);
  console.log('Creating columns:');

  const cols = {};
  for (const [key, title, type] of COLUMNS) {
    const defaults = type === 'status' ? { labels: Object.fromEntries(STATUS_LABELS.map((l, i) => [String(i + 1), l])) } : undefined;
    cols[key] = await createColumn(boardId, title, type, defaults);
    await sleep(200);
  }

  const out = { boardId: String(boardId), name: BOARD_NAME, columns: cols, statusLabels: STATUS_LABELS, createdAt: new Date().toISOString() };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote board config → ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log('Done. Keep the board automation-free in Monday.');
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
