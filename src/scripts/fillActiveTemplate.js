/**
 * fillActiveTemplate.js
 *
 * Sets "Active Template" (color_mm0zsz8b) = Yes on every template board item.
 * All 1238 items are active — they're all on the board and in use.
 *
 * Run with: node src/scripts/fillActiveTemplate.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID       = '18401624183';
const ACTIVE_COL     = 'color_mm0zsz8b';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllItems() {
  const items = [];
  let cursor = null;

  do {
    const ca = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(`
      query {
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 500${ca}) {
            cursor
            items {
              id
              name
              column_values(ids: ["${ACTIVE_COL}"]) { id text }
            }
          }
        }
      }
    `);
    const page = data?.boards?.[0]?.items_page;
    if (!page) break;
    items.push(...(page.items || []));
    cursor = page.cursor || null;
  } while (cursor);

  return items;
}

async function main() {
  console.log('▶  Fetching all template board items …');
  const items = await fetchAllItems();
  console.log(`   ${items.length} items fetched\n`);

  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const current = item.column_values.find(c => c.id === ACTIVE_COL)?.text?.trim() || '';

    if (current === 'Yes') {
      skipped++;
      continue;
    }

    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        {
          boardId: String(BOARD_ID),
          itemId:  String(item.id),
          cols:    JSON.stringify({ [ACTIVE_COL]: { label: 'Yes' } }),
        }
      );
      updated++;
      if (updated % 50 === 0) console.log(`   … ${updated} updated so far`);
    } catch (err) {
      console.error(`❌ Failed: "${item.name}" (id:${item.id}) — ${err.message}`);
    }

    await sleep(120);
  }

  console.log(`\n✅ Done — Updated: ${updated}  |  Already Yes: ${skipped}`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
