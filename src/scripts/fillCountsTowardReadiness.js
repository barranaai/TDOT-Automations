/**
 * fillCountsTowardReadiness.js
 *
 * Sets "Counts Toward Readiness" (color_mm0x78rc) on every template board item.
 *
 * Logic:
 *   Yes — Required Type = "Mandatory", OR name explicitly says "mandatory/required"
 *         and is not conditional/optional
 *   No  — name contains "if applicable", "optional", "if student",
 *          OR name starts with "If " (conditional), OR it's "Additional documents (Optional)"
 *
 * Run with: node src/scripts/fillCountsTowardReadiness.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID    = '18401624183';
const CTR_COL     = 'color_mm0x78rc';   // Counts Toward Readiness
const REQTYPE_COL = 'dropdown_mm0x9v5q'; // Required Type

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Returns true if this document should NOT count toward readiness
function isConditional(name) {
  const n = name.toLowerCase();
  return (
    n.includes('if applicable') ||
    n.includes('(optional)') ||
    n.startsWith('if ') ||
    n.includes('if student') ||
    n.includes('if you or your spouse')
  );
}

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
              column_values(ids: ["${CTR_COL}", "${REQTYPE_COL}"]) { id text }
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

  let yes = 0, no = 0, skipped = 0, errors = 0;
  const noList = [];

  for (const item of items) {
    const colMap = {};
    for (const col of item.column_values) colMap[col.id] = col.text?.trim() || '';

    const current  = colMap[CTR_COL];
    const reqType  = colMap[REQTYPE_COL];

    // Determine target value
    let target;
    if (isConditional(item.name)) {
      target = 'No';
      noList.push(item.name);
    } else if (reqType === 'Mandatory' || item.name.toLowerCase().includes('mandatory')) {
      target = 'Yes';
    } else {
      // Empty Required Type but not conditional — treat as Yes (it's still needed)
      target = 'Yes';
    }

    if (current === target) { skipped++; continue; }

    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        {
          boardId: String(BOARD_ID),
          itemId:  String(item.id),
          cols:    JSON.stringify({ [CTR_COL]: { label: target } }),
        }
      );
      target === 'Yes' ? yes++ : no++;
      if ((yes + no) % 50 === 0) console.log(`   … ${yes + no} updated`);
    } catch (err) {
      errors++;
      console.error(`❌ Failed: "${item.name}" — ${err.message}`);
    }

    await sleep(120);
  }

  console.log(`\n✅ Done`);
  console.log(`   Set Yes    : ${yes}`);
  console.log(`   Set No     : ${no}`);
  console.log(`   Already set: ${skipped}`);
  console.log(`   Errors     : ${errors}`);

  if (noList.length) {
    console.log(`\nItems set to No (conditional/optional):`);
    for (const n of [...new Set(noList)].sort()) console.log(`  • ${n}`);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
