/**
 * One-off — add the "Advertisement Fee" numbers column to the Lead Board.
 * LMIA retainers carry a recruitment/advertising disbursement the team was
 * writing in manually (feedback 2026-08-13, booking-stage point 11). Entered
 * on the retainer panel for LMIA-family case types only; printed on Annex B
 * as a third-party disbursement line. INERT — no webhook branches on it.
 *
 *   node scripts/add-advertisement-fee-column.js            # dry-run
 *   node scripts/add-advertisement-fee-column.js --write    # create if missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');

const COL = { key: 'advertisementFee', title: 'Advertisement Fee', type: 'numbers' };

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const existing = cfg.columns || {};
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  board: ${BOARD_ID}`);
  if (existing[COL.key]) { console.log(`"${COL.key}" already present (${existing[COL.key]}). Nothing to do.`); return; }
  console.log(`To create: ${COL.title} [${COL.type}] → "${COL.key}"`);
  if (!WRITE) { console.log('(Dry-run. Re-run with --write to create.)'); return; }

  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!) {
       create_column(board_id: $boardId, title: $title, column_type: $type) { id title type }
     }`,
    { boardId: String(BOARD_ID), title: COL.title, type: COL.type }
  );
  const created = data.create_column;
  if (!created?.id) throw new Error('create_column returned no id');
  cfg.columns[COL.key] = created.id;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✅ Created "${created.title}" (${created.id}) and saved to newLeadsBoard.json`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
