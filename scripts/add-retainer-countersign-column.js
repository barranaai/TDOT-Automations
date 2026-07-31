/**
 * One-off — add the "Retainer Countersign" text column to the Lead Board.
 * Stores the consultation-agreement e-sign envelope state as JSON:
 *   { "clientEnvelopeId": "…", "clientItemId": "…",       ← client envelope (retainer-<leadId>)
 *     "envelopeId": "…", "itemId": "…", "signUrl": "…",   ← RCIC countersign envelope (retainer2-<leadId>)
 *     "sentAt": "YYYY-MM-DD", "signedAt": "YYYY-MM-DD" }
 * Written by consultAgreementService (send + countersign) and the Documenso
 * consult2 webhook capture. INERT — no Monday webhook branches on it.
 *
 *   node scripts/add-retainer-countersign-column.js            # dry-run
 *   node scripts/add-retainer-countersign-column.js --write    # create if missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');

const COL = { key: 'retainerCountersign', title: 'Retainer Countersign', type: 'text' };

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
  console.log(`Created: ${created.title} [${created.type}] → id ${created.id}`);
  cfg.columns = { ...existing, [COL.key]: created.id };
  fs.writeFileSync(CFG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`Saved ${CFG_PATH}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
