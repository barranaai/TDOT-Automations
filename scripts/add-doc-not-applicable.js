/**
 * One-off — the Monday side of "Not Applicable" documents (2026-10-02):
 *   1. VERIFIES the Document Status label "Not Applicable" on the Documents
 *      board (color_mm0zwgvr) — added by hand (the API cannot add labels) in a
 *      NEW index, never Monday's blank/grey slot 5 (a label there would make
 *      every cleared cell read "Not Applicable"); stops if missing or in slot 5;
 *   2. creates a long-text column "Not Applicable Reason" (reason — staff, when).
 * The column id is recorded in src/data/documentsBoard.json; the app reads it
 * from there (documentNotApplicable.js). Nothing is written to any row; the
 * dry-run writes nothing at all.
 *
 *   node scripts/add-doc-not-applicable.js            # dry-run (shows what it would do)
 *   node scripts/add-doc-not-applicable.js --write    # create what is missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE     = process.argv.includes('--write');
const BOARD_ID  = String(process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593');
const STATUS_COL = 'color_mm0zwgvr';
const LABEL     = 'Not Applicable';
const CFG_PATH  = path.join(__dirname, '..', 'src', 'data', 'documentsBoard.json');
const COL       = { key: 'notApplicableReason', title: 'Not Applicable Reason', type: 'long_text' };

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  Documents board: ${BOARD_ID}`);
  const cfg = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : { boardId: BOARD_ID, columns: {} };
  cfg.columns = cfg.columns || {};

  // 1. the label — Monday's API cannot add a status label (change_column_metadata
  //    takes only title/description; a row write with Monday's auto-create-labels
  //    flag picks the colour, i.e. the slot). It is added BY HAND; this verifies it.
  const meta = await mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ columns(ids:["${STATUS_COL}"]){ id settings_str } } }`, { b: [BOARD_ID] });
  const labels = JSON.parse(meta.boards[0].columns[0].settings_str || '{}').labels || {};
  console.log('Document Status labels now:', JSON.stringify(labels));
  const have = Object.entries(labels).find(([, text]) => text === LABEL);
  if (!have) {
    console.log(`Label "${LABEL}" is MISSING. Add it by hand first: Documents board → Document Status column → Edit labels → "${LABEL}", any colour EXCEPT the default grey. Then re-run this script.`);
    process.exit(1);
  }
  if (String(have[0]) === '5') throw new Error('The label sits in slot 5 — Monday\'s blank/grey slot (every cleared cell would read "Not Applicable"). Delete it in Monday and re-add it in a different colour.');
  console.log(`Label "${LABEL}" present at index ${have[0]} ✓`);

  // 2. the reason column
  if (cfg.columns[COL.key]) {
    console.log(`Column "${COL.title}" already recorded as ${cfg.columns[COL.key]}.`);
  } else {
    const cols = await mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ columns{ id title type } } }`, { b: [BOARD_ID] });
    const existing = cols.boards[0].columns.find((c) => c.title === COL.title && c.type === COL.type);
    if (existing) {
      console.log(`Column "${COL.title}" exists on the board as ${existing.id} — recording it.`);
      cfg.columns[COL.key] = existing.id;
    } else {
      console.log(`To create: column "${COL.title}" [${COL.type}].`);
      if (WRITE) {
        const r = await mondayApi.query(
          `mutation($b:ID!,$t:String!,$ty:ColumnType!){ create_column(board_id:$b, title:$t, column_type:$ty){ id title type } }`,
          { b: BOARD_ID, t: COL.title, ty: COL.type });
        cfg.columns[COL.key] = r.create_column.id;
        console.log(`Column created: ${r.create_column.id} ✓`);
      }
    }
    if (WRITE) { cfg.boardId = BOARD_ID; fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n'); console.log(`Recorded in ${path.relative(process.cwd(), CFG_PATH)}`); }
    else if (cfg.columns[COL.key]) console.log(`(Would record ${cfg.columns[COL.key]} in ${path.relative(process.cwd(), CFG_PATH)}.)`);
  }
  if (!WRITE) console.log('(Dry-run. Re-run with --write to apply.)');
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
