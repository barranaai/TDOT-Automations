/**
 * One-off — add the "Retainer Family Members" column to the Lead Board so the
 * consultant can set the case's family members in the retainer panel during
 * onboarding. Stored as a JSON array of { type, name, accompanying }. At handoff,
 * familyCompositionService materialises the accompanying members onto the Family
 * Members board, which drives BOTH the per-member checklist and questionnaire.
 *
 * INERT: the /webhook/lead automation does not branch on this column.
 *
 *   node scripts/add-retainer-family-column.js            # dry-run
 *   node scripts/add-retainer-family-column.js --write    # create it
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');

const NEW_COLUMNS = [
  { key: 'retainerFamilyMembers', title: 'Retainer Family Members (JSON)', type: 'long_text' },
];

async function createColumn(col) {
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!) {
       create_column(board_id: $boardId, title: $title, column_type: $type) { id title type }
     }`,
    { boardId: String(BOARD_ID), title: col.title, type: col.type }
  );
  return data && data.create_column && data.create_column.id;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const existing = cfg.columns || {};
  const todo = NEW_COLUMNS.filter((c) => !existing[c.key]);

  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  board: ${BOARD_ID}`);
  if (!todo.length) { console.log(`"retainerFamilyMembers" already present (${existing.retainerFamilyMembers}). Nothing to do.`); return; }
  console.log(`\nTo create: ${todo.map((c) => `${c.title} [${c.type}] → "${c.key}"`).join(', ')}`);
  if (!WRITE) { console.log('\n(Dry-run. Re-run with --write to create.)'); return; }

  for (const col of todo) {
    const id = await createColumn(col);
    existing[col.key] = id;
    console.log(`  + ${col.title} → ${id}`);
  }
  cfg.columns = existing;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\nMerged into ${path.relative(process.cwd(), CFG_PATH)}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
