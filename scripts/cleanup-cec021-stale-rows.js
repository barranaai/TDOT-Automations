/**
 * One-off cleanup: delete the 51 stale GEN-1 execution rows on 2026-CEC-EE-021.
 *
 * Background: the case was paid BEFORE its Sub Type was set, so the old
 * template engine seeded 51 rows at 13:37–13:40 on 2026-06-11 (with the PA
 * block duplicated inside the template itself). Once the Sub Type was set,
 * the schema engine seeded the correct 30 rows at 14:16–14:17. The seeder is
 * additive by design, so the stale 51 lingered and inflate the client portal.
 *
 * A row is deleted ONLY if BOTH hold (belt and braces):
 *   - created before 2026-06-11T14:00Z (the GEN-1 window), AND
 *   - uniqueKey does NOT carry the schema engine's case-type slug.
 * The script ABORTS unless the doomed set is exactly 51 and the survivor set
 * is exactly 30.
 *
 * Usage:
 *   node scripts/cleanup-cec021-stale-rows.js           (dry run)
 *   node scripts/cleanup-cec021-stale-rows.js --apply   (delete)
 */

'use strict';

require('dotenv').config();

const mondayApi = require('../src/services/mondayApi');

const CASE_REF    = '2026-CEC-EE-021';
const BOARD_ID    = process.env.MONDAY_EXECUTION_BOARD_ID;
const CUTOFF      = '2026-06-11T14:00';
const SCHEMA_SLUG = 'CANADIAN-EXPERIENCE-CLASS';
const APPLY       = process.argv.includes('--apply');

const COLS = {
  caseReferenceNumber: 'text_mm0z2cck',
  uniqueKey:           'text_mm15dwah',
  applicantType:       'text_mm26jcv7',
};

async function fetchRows() {
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
      items.push({ id: it.id, name: it.name, createdAt: it.created_at, uniqueKey: cv[COLS.uniqueKey] });
    }
    cursor = page?.cursor || null;
  } while (cursor);
  return items;
}

async function main() {
  const items = await fetchRows();
  const doomed   = items.filter((it) => it.createdAt < CUTOFF && !String(it.uniqueKey).includes(SCHEMA_SLUG));
  const survivors = items.filter((it) => !doomed.includes(it));

  console.log(`${CASE_REF}: ${items.length} rows total — ${doomed.length} stale GEN-1, ${survivors.length} schema rows kept`);

  if (doomed.length !== 51 || survivors.length !== 30) {
    console.error(`ABORT: expected exactly 51 stale + 30 kept. The board has changed since the audit — re-audit before cleanup.`);
    process.exit(1);
  }
  // Every survivor must carry the schema slug — confirms the discriminator is airtight.
  const oddSurvivor = survivors.find((it) => !String(it.uniqueKey).includes(SCHEMA_SLUG));
  if (oddSurvivor) {
    console.error(`ABORT: survivor without schema slug — ${oddSurvivor.id} ${oddSurvivor.uniqueKey}`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing deleted. First/last 3 doomed rows:');
    for (const it of [...doomed.slice(0, 3), ...doomed.slice(-3)]) {
      console.log(`  ${it.id}  ${it.createdAt}  ${it.name}  [${it.uniqueKey}]`);
    }
    console.log('\nRe-run with --apply to delete.');
    return;
  }

  let deleted = 0;
  for (const it of doomed) {
    await mondayApi.query(
      `mutation($itemId: ID!) { delete_item(item_id: $itemId) { id } }`,
      { itemId: String(it.id) }
    );
    deleted += 1;
    if (deleted % 10 === 0) console.log(`  …${deleted}/${doomed.length} deleted`);
  }
  console.log(`Deleted ${deleted} stale rows.`);

  const after = await fetchRows();
  console.log(`Post-check: ${after.length} rows remain (expected 30).`);
  process.exit(after.length === 30 ? 0 : 1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
