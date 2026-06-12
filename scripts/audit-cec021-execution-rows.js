/**
 * Read-only audit of execution rows for one case reference.
 *
 * Groups the case's Document Checklist Execution rows by creation timestamp
 * (minute precision) and uniqueKey shape, to separate the stale GEN-1
 * template-engine seed from the correct GEN-2 schema-engine seed before any
 * cleanup. Prints the split + writes scripts/cec021-execution-audit.json.
 *
 * Usage: node scripts/audit-cec021-execution-rows.js [caseRef]
 * Strictly read-only — no Monday mutations.
 */

'use strict';

require('dotenv').config();

const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const CASE_REF = process.argv[2] || '2026-CEC-EE-021';
const BOARD_ID = process.env.MONDAY_EXECUTION_BOARD_ID;

const COLS = {
  caseReferenceNumber: 'text_mm0z2cck',
  uniqueKey:           'text_mm15dwah',
  applicantType:       'text_mm26jcv7',
};

async function main() {
  const items = [];
  let cursor = null;

  do {
    const data = await mondayApi.query(
      `query($boardId: ID!, $colId: String!, $val: String!, $cursor: String) {
         items_page_by_column_values(
           limit: 100, board_id: $boardId, cursor: $cursor,
           columns: [{ column_id: $colId, column_values: [$val] }]
         ) {
           cursor
           items {
             id name created_at
             column_values(ids: ["${COLS.uniqueKey}", "${COLS.applicantType}"]) { id text }
           }
         }
       }`,
      { boardId: String(BOARD_ID), colId: COLS.caseReferenceNumber, val: CASE_REF, cursor }
    );
    const page = data?.items_page_by_column_values;
    for (const it of page?.items || []) {
      const cv = {};
      for (const c of it.column_values) cv[c.id] = c.text || '';
      items.push({
        id:            it.id,
        name:          it.name,
        createdAt:     it.created_at,
        uniqueKey:     cv[COLS.uniqueKey],
        applicantType: cv[COLS.applicantType],
      });
    }
    cursor = page?.cursor || null;
  } while (cursor);

  console.log(`\n${CASE_REF}: ${items.length} execution rows\n`);

  // Group by creation minute
  const byMinute = {};
  for (const it of items) {
    const minute = (it.createdAt || '').slice(0, 16);
    (byMinute[minute] = byMinute[minute] || []).push(it);
  }
  for (const minute of Object.keys(byMinute).sort()) {
    const group = byMinute[minute];
    const types = {};
    for (const it of group) types[it.applicantType || '(blank)'] = (types[it.applicantType || '(blank)'] || 0) + 1;
    console.log(`── ${minute}Z — ${group.length} rows ──`);
    console.log(`   applicantTypes: ${JSON.stringify(types)}`);
    console.log(`   sample keys: ${group.slice(0, 3).map((i) => i.uniqueKey).join(' | ')}`);
  }

  const out = path.join(__dirname, 'cec021-execution-audit.json');
  fs.writeFileSync(out, JSON.stringify({ caseRef: CASE_REF, count: items.length, items }, null, 2));
  console.log(`\nFull detail → ${out}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
