/**
 * fillSampleRequired.js
 *
 * Sets "Sample Required?" (color_mm0zry4d) on every template board item.
 *
 * Yes — documents where a sample/template is genuinely helpful:
 *   • Digital photo items (exact pixel/size/background specs need illustration)
 *   • Items whose instructions mention "we can provide a template upon request"
 *
 * No — everything else (standard documents where the name/instructions are clear)
 *
 * Run with: node src/scripts/fillSampleRequired.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID      = '18401624183';
const SAMPLE_COL    = 'color_mm0zry4d';
const INSTR_COL     = 'long_text_mm0z10mg';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function needsSample(name, instruction) {
  const n = name.toLowerCase();
  const i = (instruction || '').toLowerCase();

  // Digital photos — specs are highly specific
  if (n.includes('digital photo')) return true;
  if (n.includes('photo as per specifications')) return true;

  // Items where instructions explicitly offer a template
  if (i.includes('we can provide a template upon request') ||
      i.includes('we can share the form upon request')) return true;

  return false;
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
              column_values(ids: ["${SAMPLE_COL}", "${INSTR_COL}"]) { id text }
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
  const yesList = [];

  for (const item of items) {
    const colMap = {};
    for (const col of item.column_values) colMap[col.id] = col.text?.trim() || '';

    const current     = colMap[SAMPLE_COL];
    const instruction = colMap[INSTR_COL];
    const target      = needsSample(item.name, instruction) ? 'Yes' : 'No';

    if (current === target) { skipped++; continue; }

    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        {
          boardId: String(BOARD_ID),
          itemId:  String(item.id),
          cols:    JSON.stringify({ [SAMPLE_COL]: { label: target } }),
        }
      );
      if (target === 'Yes') { yes++; yesList.push(item.name); }
      else no++;
      if ((yes + no) % 50 === 0) console.log(`   … ${yes + no} updated`);
    } catch (err) {
      errors++;
      console.error(`❌ Failed: "${item.name}" — ${err.message}`);
    }

    await sleep(120);
  }

  console.log(`\n✅ Done`);
  console.log(`   Set Yes (sample needed) : ${yes}`);
  console.log(`   Set No  (no sample)     : ${no}`);
  console.log(`   Already set             : ${skipped}`);
  console.log(`   Errors                  : ${errors}`);

  if (yesList.length) {
    console.log(`\nDocuments marked Sample Required (Yes):`);
    for (const n of [...new Set(yesList)].sort()) console.log(`  • ${n}`);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
