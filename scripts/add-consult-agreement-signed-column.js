/**
 * One-off — add the "Consultation Agreement Signed" date column to the Lead Board.
 * Stamped by documensoService.captureCompleted when a client signs the initial
 * consultation agreement via Documenso (mirrors the existing "Retainer Signed"
 * date). Gives the consult agreement its own signed-on date instead of only a
 * note, so the cockpit/portal can show WHEN it was signed.
 * Merges the new id into src/data/newLeadsBoard.json (idempotent).
 *
 * INERT: the /webhook/lead automation does not branch on this column — unlike
 * Retainer Signed (which opens the case), a signed consultation agreement never
 * opens a case; it only records the date + stores the signed PDF.
 *
 *   node scripts/add-consult-agreement-signed-column.js            # dry-run
 *   node scripts/add-consult-agreement-signed-column.js --write    # create if missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');

const COL = { key: 'consultAgreementSigned', title: 'Consultation Agreement Signed', type: 'date' };

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
  const id = data && data.create_column && data.create_column.id;
  if (!id) throw new Error('create_column returned no id');
  existing[COL.key] = id;
  cfg.columns = existing;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`  + ${COL.title} → ${id}\nMerged into ${path.relative(process.cwd(), CFG_PATH)}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
