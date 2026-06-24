/**
 * One-off — create the standalone "Consultation Requests" Monday board for the
 * public consultation form, with a column per field from
 * config/consultationFormFields.js (the same source of truth the form uses), and
 * write the board id + key→columnId map to src/data/consultationBoard.json.
 *
 * Independent of the lead/intake boards. Idempotent for columns: re-running only
 * creates missing ones (board is created once).
 *
 *   node scripts/create-consultation-board.js            # dry-run
 *   node scripts/create-consultation-board.js --write    # create board + columns
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mondayApi = require('../src/services/mondayApi');
const { FIELDS, GROUPS } = require('../config/consultationFormFields');

const WRITE = process.argv.includes('--write');
const WORKSPACE_ID = process.env.MONDAY_WORKSPACE_ID || '14447959'; // "TDOT Boards"
const BOARD_NAME = process.env.CONSULTATION_BOARD_NAME || 'Consultation Requests';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'consultationBoard.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mondayType (from the field config) → Monday create_column type
const COLTYPE = { text: 'text', email: 'email', phone: 'phone', numbers: 'numbers', date: 'date', long_text: 'long_text', status: 'status', dropdown: 'dropdown' };

// Build the column list: one per field + one long_text per repeatable group.
const COLUMNS = [];
for (const f of FIELDS) {
  COLUMNS.push({ key: f.key, title: f.label.length > 60 ? f.label.slice(0, 57) + '…' : f.label, type: COLTYPE[f.mondayType] || 'text', options: (f.mondayType === 'status' || f.mondayType === 'dropdown') ? f.options : null });
}
for (const g of GROUPS) {
  COLUMNS.push({ key: g.group, title: g.group === 'education' ? 'Education (JSON)' : 'Work Experience (JSON)', type: 'long_text', options: null });
}

function defaultsFor(col) {
  if (col.type === 'status' && col.options) return { labels: Object.fromEntries(col.options.map((l, i) => [String(i + 1), l])) };
  if (col.type === 'dropdown' && col.options) return { settings: { labels: col.options.map((name, i) => ({ id: i + 1, name })) } };
  return null;
}

async function createBoard() {
  const data = await mondayApi.query(
    `mutation($name: String!, $ws: ID!){ create_board(board_name:$name, board_kind:public, workspace_id:$ws){ id } }`,
    { name: BOARD_NAME, ws: String(WORKSPACE_ID) }
  );
  return data && data.create_board && data.create_board.id;
}
async function createColumn(boardId, col) {
  const defaults = defaultsFor(col);
  const data = await mondayApi.query(
    `mutation($b: ID!, $t: String!, $ty: ColumnType!, $d: JSON){ create_column(board_id:$b, title:$t, column_type:$ty, defaults:$d){ id } }`,
    { b: String(boardId), t: col.title, ty: col.type, d: defaults ? JSON.stringify(defaults) : null }
  );
  return data && data.create_column && data.create_column.id;
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'} | workspace ${WORKSPACE_ID} | board "${BOARD_NAME}"`);
  console.log(`${COLUMNS.length} columns to create:\n`);
  for (const c of COLUMNS) console.log(`  ${c.title.slice(0, 42).padEnd(44)} [${c.type}]${c.options ? ' {' + c.options.length + ' opts}' : ''}`);
  if (!WRITE) { console.log('\n(Dry-run. Re-run with --write to create the board.)'); return; }

  let cfg = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : { columns: {} };
  if (!cfg.boardId) {
    cfg.boardId = await createBoard();
    console.log(`\n+ Board created → ${cfg.boardId}`);
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    await sleep(500);
  }
  for (const col of COLUMNS) {
    if (cfg.columns[col.key]) continue;
    try { cfg.columns[col.key] = await createColumn(cfg.boardId, col); console.log(`  + ${col.title.slice(0, 42)} → ${cfg.columns[col.key]}`); }
    catch (e) { console.error(`  ✗ ${col.title}: ${e.message}`); }
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    await sleep(280);
  }
  console.log(`\nDone — board ${cfg.boardId}, ${Object.keys(cfg.columns).length} columns → ${path.relative(process.cwd(), CFG_PATH)}`);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
