/**
 * cleanupStaleExecutionItems.js
 *
 * Cleans up the 30 remaining execution items that couldn't be backfilled:
 *   - "Questionnaire" items → deleted (template was removed globally)
 *   - Truncated name items ("anadian Education…", "Foreign E") → name + columns patched
 *
 * Run with: node src/scripts/cleanupStaleExecutionItems.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const EXEC_BOARD_ID      = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const INTAKE_ID_COL      = 'text_mm0zfsp1';
const APPLICANT_TYPE_COL = 'text_mm26jcv7';
const DOC_CATEGORY_COL   = 'text_mm261tka';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Fetch all unresolved items
  const data = await mondayApi.query(
    `query {
       boards(ids: [${EXEC_BOARD_ID}]) {
         items_page(limit: 500) {
           items {
             id name
             column_values(ids: ["${INTAKE_ID_COL}", "${APPLICANT_TYPE_COL}", "${DOC_CATEGORY_COL}"]) {
               id text
             }
           }
         }
       }
     }`
  );

  const items = data?.boards?.[0]?.items_page?.items || [];
  const unresolved = items.filter((item) => {
    const cat = item.column_values.find((c) => c.id === DOC_CATEGORY_COL)?.text?.trim();
    const apt = item.column_values.find((c) => c.id === APPLICANT_TYPE_COL)?.text?.trim();
    return !cat || !apt;
  });

  console.log(`Found ${unresolved.length} unresolved items`);

  let deleted = 0;
  let patched  = 0;

  for (const item of unresolved) {
    const nameTrimmed = item.name.trim();
    const nameLower   = nameTrimmed.toLowerCase();

    // ── Delete old Questionnaire items ──────────────────────────────────────
    if (nameLower === 'questionnaire') {
      await mondayApi.query(
        `mutation($itemId: ID!) { delete_item(item_id: $itemId) { id } }`,
        { itemId: String(item.id) }
      );
      console.log(`  ❌ Deleted: "${nameTrimmed}" (${item.id})`);
      deleted++;
      await sleep(180);
      continue;
    }

    // ── Patch truncated names ────────────────────────────────────────────────
    let newName, newCat;
    if (nameLower.startsWith('anadian education')) {
      newName = 'Canadian Education Documents';
      newCat  = 'Education';
    } else if (nameLower.startsWith('foreign e')) {
      newName = 'Foreign Education Documents along with Educational Credential Assessment';
      newCat  = 'Education';
    } else {
      console.log(`  ? Unhandled item: "${nameTrimmed}" (${item.id})`);
      continue;
    }

    // Update columns
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
       }`,
      {
        boardId:   String(EXEC_BOARD_ID),
        itemId:    String(item.id),
        colValues: JSON.stringify({
          [DOC_CATEGORY_COL]:   newCat,
          [APPLICANT_TYPE_COL]: 'Principal Applicant',
        }),
      }
    );
    await sleep(180);

    // Fix the item name
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $newName: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $newName) { id }
       }`,
      {
        boardId: String(EXEC_BOARD_ID),
        itemId:  String(item.id),
        newName: JSON.stringify({ name: newName }),
      }
    );
    console.log(`  ✅ Patched: "${nameTrimmed}" → "${newName}" (${item.id})`);
    patched++;
    await sleep(180);
  }

  console.log(`\n✅ Done — deleted ${deleted}, patched ${patched}`);
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
