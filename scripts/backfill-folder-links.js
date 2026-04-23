/**
 * One-time backfill script — Document Folder links for case 2026-CEC-EE-001
 *
 * Run on the production server:
 *   node scripts/backfill-folder-links.js
 *
 * What it does:
 *   1. Fetches all 22 execution items for case 2026-CEC-EE-001
 *   2. Groups them by Document Category (Identity, Other, Medical, Legal, Education)
 *   3. For each category: calls ensureCategoryFolderLink() which ONLY fetches the
 *      existing OneDrive folder (never deletes or overwrites files inside it)
 *   4. Writes the sharing link back to the Monday.com Document Folder column
 *
 * Safe to run multiple times — ensureFolder uses conflictBehavior:'fail' so
 * existing folders are just fetched, never recreated.
 */

'use strict';

require('dotenv').config();

const mondayApi              = require('../src/services/mondayApi');
const { ensureCategoryFolderLink } = require('../src/services/oneDriveService');

const EXEC_BOARD_ID  = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF_COL   = 'text_mm0z2cck';
const CATEGORY_COL   = 'text_mm261tka';
const DOC_FOLDER_COL = 'link_mm1yrnz1';

const CLIENT_NAME = 'Harry Saini';
const CASE_REF    = '2026-CEC-EE-001';

async function run() {
  console.log(`\n=== Folder Link Backfill: ${CASE_REF} (${CLIENT_NAME}) ===\n`);

  // 1. Fetch all execution items for this case
  const data = await mondayApi.query(`
    query($boardId: ID!, $caseRef: String!) {
      items_page_by_column_values(
        board_id: $boardId, limit: 100,
        columns: [{ column_id: "${CASE_REF_COL}", column_values: [$caseRef] }]
      ) {
        items {
          id name
          column_values(ids: ["${CATEGORY_COL}", "${DOC_FOLDER_COL}"]) { id text value }
        }
      }
    }
  `, { boardId: EXEC_BOARD_ID, caseRef: CASE_REF });

  const items = data?.items_page_by_column_values?.items || [];
  console.log(`Found ${items.length} execution items on the board.\n`);

  if (!items.length) {
    console.error('No items found — check the case reference and board ID.');
    process.exit(1);
  }

  // 2. Group item IDs by category
  const categoryToItemIds = {};
  for (const item of items) {
    const category = item.column_values.find(c => c.id === CATEGORY_COL)?.text?.trim();
    if (!category) {
      console.warn(`  [SKIP] Item ${item.id} ("${item.name}") has no category — skipping`);
      continue;
    }
    if (!categoryToItemIds[category]) categoryToItemIds[category] = [];
    categoryToItemIds[category].push(item.id);
  }

  const categories = Object.keys(categoryToItemIds);
  console.log(`Categories: ${categories.join(', ')}\n`);

  let totalWritten = 0;
  let totalFailed  = 0;

  // 3. For each category: get/create sharing link → write to all items
  for (const category of categories) {
    console.log(`── Category: ${category} (${categoryToItemIds[category].length} items)`);

    let sharingUrl;
    try {
      sharingUrl = await ensureCategoryFolderLink({ clientName: CLIENT_NAME, caseRef: CASE_REF, category });
      console.log(`   ✓ Folder link: ${sharingUrl}`);
    } catch (err) {
      console.error(`   ✗ Could not get folder link: ${err.message}`);
      totalFailed += categoryToItemIds[category].length;
      continue;
    }

    for (const itemId of categoryToItemIds[category]) {
      try {
        await mondayApi.query(`
          mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
            change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
          }
        `, {
          boardId:   EXEC_BOARD_ID,
          itemId:    String(itemId),
          colValues: JSON.stringify({
            [DOC_FOLDER_COL]: { url: sharingUrl, text: `${category} Folder` },
          }),
        });
        console.log(`   ✓ Written → item ${itemId}`);
        totalWritten++;
      } catch (err) {
        console.error(`   ✗ Failed to write item ${itemId}: ${err.message}`);
        totalFailed++;
      }
    }
  }

  console.log(`\n=== Done — ${totalWritten} written, ${totalFailed} failed ===`);
  if (totalFailed > 0) process.exit(1);
}

run().catch(err => {
  console.error('\n[Fatal]', err.message);
  process.exit(1);
});
