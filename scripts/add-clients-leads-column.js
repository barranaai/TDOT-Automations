/**
 * One-off — add the "Leads" board_relation column to the Clients board.
 *
 * Each client (person) row should reference EVERYTHING of theirs: the Cases
 * relation already links their Client Master applications (active + closed);
 * this column links their Lead Board rows — enquiries, booked consultations,
 * direct-retainer entries (consultations live on the Lead Board in this
 * system, so this covers them too). Appended by clientAccountService.linkLead.
 *
 *   node scripts/add-clients-leads-column.js            # dry-run
 *   node scripts/add-clients-leads-column.js --write    # create if missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE         = process.argv.includes('--write');
const LEAD_BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH      = path.join(__dirname, '..', 'src', 'data', 'clientsBoard.json');

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  Clients board ${cfg.boardId}`);
  if (cfg.columns.leads) { console.log(`"leads" already present (${cfg.columns.leads}). Nothing to do.`); return; }
  console.log(`To create: Leads [board_relation → Lead Board ${LEAD_BOARD_ID}]`);
  if (!WRITE) { console.log('(Dry-run. Re-run with --write to create.)'); return; }

  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id title type }
     }`,
    { boardId: String(cfg.boardId), title: 'Leads', type: 'board_relation', defaults: JSON.stringify({ boardIds: [Number(LEAD_BOARD_ID)] }) }
  );
  cfg.columns.leads = data.create_column.id;
  fs.writeFileSync(CFG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`Created: Leads [board_relation] → ${data.create_column.id}`);
  console.log(`Saved ${path.relative(process.cwd(), CFG_PATH)}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
