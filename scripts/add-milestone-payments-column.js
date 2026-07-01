/**
 * One-off — add the "Milestone Payments" JSON column to the Lead Board. Holds
 * per-milestone payment state (parallel to retainerMilestones, keyed by index):
 *   { "<i>": { status:'pending|sent|paid', amountCents, orderId, url, sentAt, paidAt, txnId } }
 * Kept separate from retainerMilestones so editing the plan never wipes payment state.
 *   node scripts/add-milestone-payments-column.js --write
 */
'use strict';
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const mondayApi = require('../src/services/mondayApi');
const WRITE = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');
const NEW = [{ key: 'milestonePayments', title: 'Milestone Payments (JSON)', type: 'long_text' }];
async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const ex = cfg.columns || {};
  const todo = NEW.filter((c) => !ex[c.key]);
  console.log(`Mode: ${WRITE ? 'WRITE' : 'DRY-RUN'} | board: ${BOARD_ID}`);
  if (!todo.length) { console.log('Already present. Nothing to do.'); return; }
  if (!WRITE) { console.log('Would create: ' + todo.map((c) => c.key).join(', ')); return; }
  for (const c of todo) {
    const d = await mondayApi.query(`mutation($b:ID!,$t:String!,$ty:ColumnType!){create_column(board_id:$b,title:$t,column_type:$ty){id}}`, { b: String(BOARD_ID), t: c.title, ty: c.type });
    ex[c.key] = d.create_column.id; console.log(`  + ${c.title} -> ${d.create_column.id}`);
  }
  cfg.columns = ex; fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Merged into newLeadsBoard.json');
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
