/**
 * updateInstructionsFromPdfs.js
 *
 * Updates the Client-Facing Instructions column (long_text_mm0z10mg) on every
 * Template Board item using the exact text extracted from the Document
 * Checklist PDFs (stored in src/data/pdfInstructionsMap.json).
 *
 * Items whose name has no match in the map are skipped and reported.
 *
 * Run with: node src/scripts/updateInstructionsFromPdfs.js
 */

require('dotenv').config();
const fs  = require('fs');
const path = require('path');
const mondayApi = require('../services/mondayApi');

const BOARD_ID     = '18401624183';
const INSTR_COL    = 'long_text_mm0z10mg';

const MAP_PATH = path.join(__dirname, '../data/pdfInstructionsMap.json');
const instructionsMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Fetch all template board items (paginated) ───────────────────────────────

async function fetchAllItems() {
  const items = [];
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(`
      query {
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 500${cursorArg}) {
            cursor
            items {
              id
              name
              column_values(ids: ["${INSTR_COL}"]) { id text }
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

// ─── Update a single item's instruction ───────────────────────────────────────

async function updateInstruction(itemId, text) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(
         board_id: $boardId, item_id: $itemId, column_values: $cols
       ) { id }
     }`,
    {
      boardId: String(BOARD_ID),
      itemId:  String(itemId),
      cols:    JSON.stringify({ [INSTR_COL]: { text } }),
    }
  );
  await sleep(120);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('▶  Loading instructions map …');
  console.log(`   ${Object.keys(instructionsMap).length} entries in map\n`);

  console.log('▶  Fetching all template board items …');
  const items = await fetchAllItems();
  console.log(`   ${items.length} items fetched\n`);

  let updated  = 0;
  let skipped  = 0;
  let noMatch  = 0;
  const unmatched = new Set();

  for (const item of items) {
    const instruction = instructionsMap[item.name];

    if (!instruction) {
      noMatch++;
      unmatched.add(item.name);
      continue;
    }

    const current = item.column_values.find(c => c.id === INSTR_COL)?.text || '';

    // Skip if already identical
    if (current.trim() === instruction.trim()) {
      skipped++;
      continue;
    }

    try {
      await updateInstruction(item.id, instruction);
      console.log(`✅ Updated: "${item.name}" (id:${item.id})`);
      updated++;
    } catch (err) {
      console.error(`❌ Failed: "${item.name}" — ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Done`);
  console.log(`   Updated  : ${updated}`);
  console.log(`   Skipped  : ${skipped} (already correct)`);
  console.log(`   No match : ${noMatch}`);

  if (unmatched.size) {
    console.log(`\n⚠️  ${unmatched.size} document name(s) not in map:`);
    for (const n of [...unmatched].sort()) {
      console.log(`   • ${n}`);
    }
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
