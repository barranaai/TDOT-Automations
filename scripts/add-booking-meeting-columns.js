/**
 * One-off — add the "Meeting Type" (in-person / virtual) + "Square Booking ID"
 * columns to the Lead Board. Meeting Type is chosen by the client on the booking
 * page and drives the confirmation (Teams link vs office address) + the Square
 * seller note. Square Booking ID stores the created Square appointment id.
 *
 *   node scripts/add-booking-meeting-columns.js            # dry-run
 *   node scripts/add-booking-meeting-columns.js --write    # create them
 */
'use strict';
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const mondayApi = require('../src/services/mondayApi');
const WRITE = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');
const NEW_COLUMNS = [
  { key: 'meetingType',     title: 'Meeting Type',     type: 'text' },
  { key: 'squareBookingId', title: 'Square Booking ID', type: 'text' },
];
async function createColumn(col) {
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!) {
       create_column(board_id: $boardId, title: $title, column_type: $type) { id } }`,
    { boardId: String(BOARD_ID), title: col.title, type: col.type });
  return data && data.create_column && data.create_column.id;
}
async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const existing = cfg.columns || {};
  const todo = NEW_COLUMNS.filter((c) => !existing[c.key]);
  console.log(`Mode: ${WRITE ? 'WRITE' : 'DRY-RUN'} | board: ${BOARD_ID}`);
  if (!todo.length) { console.log('Both columns already present. Nothing to do.'); return; }
  console.log('To create: ' + todo.map((c) => `${c.title} [${c.type}] -> "${c.key}"`).join(', '));
  if (!WRITE) { console.log('(Dry-run. Re-run with --write.)'); return; }
  for (const col of todo) { const id = await createColumn(col); existing[col.key] = id; console.log(`  + ${col.title} -> ${id}`); }
  cfg.columns = existing;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Merged into ' + path.relative(process.cwd(), CFG_PATH));
}
main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
