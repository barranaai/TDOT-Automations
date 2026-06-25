/**
 * One-off — add the retainer-plan columns to the existing Lead Board for the
 * consultant-portal retainer panel (P2). MERGES the new column IDs into
 * src/data/newLeadsBoard.json (never overwrites existing ids), and is idempotent:
 * a key that already exists is skipped, so re-running cannot duplicate columns.
 *
 * These columns are INERT — the /webhook/lead automation does not branch on any
 * of them, so writing them never triggers a client email.
 *
 *   node scripts/add-retainer-plan-columns.js            # dry-run (list only)
 *   node scripts/add-retainer-plan-columns.js --write    # create the missing ones
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

const NEW_COLUMNS = [
  { key: 'selectedTemplate',   title: 'Selected Template',          type: 'text' },
  { key: 'selectedScopeAnnex', title: 'Selected Scope Annex',       type: 'text' },
  { key: 'selectedSubType',    title: 'Selected Sub Type',          type: 'text' },
  { key: 'govFee',             title: 'Government Fee',              type: 'numbers' },
  { key: 'retainerWithRprf',   title: 'Retainer With RPRF',         type: 'text' },
  { key: 'retainerHstRate',    title: 'Retainer HST Rate (%)',      type: 'text' },
  { key: 'retainerMilestones', title: 'Retainer Milestones (JSON)', type: 'long_text' },
  // pa-inviter block
  { key: 'inviterName',        title: 'Inviter Name',               type: 'text' },
  { key: 'inviterAddress',     title: 'Inviter Address',            type: 'text' },
  { key: 'inviterPhone',       title: 'Inviter Phone',              type: 'text' },
  { key: 'inviterEmail',       title: 'Inviter Email',              type: 'text' },
  // employer block
  { key: 'empRepName',         title: 'Employer Rep Name',          type: 'text' },
  { key: 'empCompanyName',     title: 'Employer Company Name',      type: 'text' },
  { key: 'empCompanyAddress',  title: 'Employer Company Address',   type: 'text' },
  { key: 'empCompanyPhone',    title: 'Employer Company Phone',     type: 'text' },
  { key: 'empRepPhone',        title: 'Employer Rep Phone',         type: 'text' },
  { key: 'empRepEmail',        title: 'Employer Rep Email',         type: 'text' },
  // Initial Consultation agreement (consultant-sent marker)
  { key: 'consultAgreementSent', title: 'Consult Agreement Sent',   type: 'date' },
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
  const already = NEW_COLUMNS.filter((c) => existing[c.key]);

  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  board: ${BOARD_ID}`);
  if (already.length) console.log(`Already present (skipped): ${already.map((c) => c.key).join(', ')}`);
  console.log(`\n${todo.length} column(s) to create:`);
  for (const c of todo) console.log(`  ${c.title.padEnd(28)} [${c.type}]  → key "${c.key}"`);

  if (!WRITE) { console.log('\n(Dry-run. Re-run with --write to create.)'); return; }
  if (!todo.length) { console.log('\nNothing to create.'); return; }

  for (const col of todo) {
    try {
      const id = await createColumn(col);
      existing[col.key] = id;
      console.log(`  + ${col.title.padEnd(28)} → ${id}`);
    } catch (err) {
      console.error(`  ✗ ${col.title}: ${err.message}`);
    }
    await sleep(300);
  }

  cfg.columns = existing;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\nMerged ${todo.length} column ID(s) into ${path.relative(process.cwd(), CFG_PATH)}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
