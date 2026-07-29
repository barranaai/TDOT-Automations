/**
 * One-off — add the "Consult Option" text column to the Lead Board.
 * Stores the client's chosen consultation option from the booking page as JSON:
 *   { "durationMin": 45, "feeCents": 30000, "variationId": "…", "consultant": "…" }
 * Written by POST /book; read by the confirm path (Square write-back books the
 * chosen variation), the consult agreement (states the real fee/duration), and
 * KPIs (per-consult revenue). INERT — no webhook branches on it.
 *
 *   node scripts/add-consult-option-column.js            # dry-run
 *   node scripts/add-consult-option-column.js --write    # create if missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');

const COL = { key: 'consultOption', title: 'Consult Option', type: 'text' };

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
