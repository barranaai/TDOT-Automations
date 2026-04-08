/**
 * auditSubTypeMix.js
 *
 * For every template group, checks whether items have a MIX of
 * sub-types (some set, some empty).  A group with ALL empty or
 * ALL set is fine; a group with MIXED state is potentially wrong.
 *
 * Run with: node src/scripts/auditSubTypeMix.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID   = '18401624183';
const SUBTYPE_COL = 'dropdown_mm204y6w';
const APPTYPE_COL = 'dropdown_mm261bn6';

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
              group { id title }
              column_values(ids: ["${SUBTYPE_COL}", "${APPTYPE_COL}"]) { id text }
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

  // Group items by group title
  const byGroup = {};
  for (const item of items) {
    const g = item.group?.title || 'Unknown';
    if (!byGroup[g]) byGroup[g] = [];

    const colMap = {};
    for (const col of item.column_values) colMap[col.id] = col.text?.trim() || '';

    byGroup[g].push({
      id:       item.id,
      name:     item.name,
      subType:  colMap[SUBTYPE_COL] || '',
      appType:  colMap[APPTYPE_COL] || '',
    });
  }

  console.log('═'.repeat(70));
  console.log('SUB TYPE MIX AUDIT');
  console.log('═'.repeat(70));

  let problems = 0;

  for (const [group, groupItems] of Object.entries(byGroup).sort()) {
    const withSubType    = groupItems.filter(i => i.subType !== '');
    const withoutSubType = groupItems.filter(i => i.subType === '');

    const total = groupItems.length;
    const setCount   = withSubType.length;
    const emptyCount = withoutSubType.length;

    let status;
    if (setCount === 0) {
      status = `✅ ALL empty  (${total} items — no sub-types for this case type)`;
    } else if (emptyCount === 0) {
      status = `✅ ALL set    (${total} items)`;
    } else {
      status = `⚠️  MIXED: ${setCount} with sub-type, ${emptyCount} without`;
      problems++;
    }

    console.log(`\n[${group}]  ${status}`);

    // If mixed, show details
    if (setCount > 0 && emptyCount > 0) {
      // Show sub-type values present
      const subTypes = [...new Set(withSubType.map(i => i.subType))].sort();
      console.log(`   Sub-types in use: ${subTypes.join(', ')}`);
      console.log(`   Items WITHOUT sub-type (${emptyCount}):`);
      for (const it of withoutSubType) {
        console.log(`     • [${it.appType || 'no appType'}]  ${it.name}  (id:${it.id})`);
      }
    } else if (setCount > 0) {
      // Show summary of sub-types
      const subTypes = [...new Set(groupItems.map(i => i.subType))].sort();
      console.log(`   Sub-types: ${subTypes.join(', ')}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  if (problems === 0) {
    console.log('✅ No mixed sub-type state found — all groups are consistent');
  } else {
    console.log(`⚠️  ${problems} group(s) have mixed sub-type state`);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
