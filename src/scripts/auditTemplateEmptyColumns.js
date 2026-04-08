/**
 * auditTemplateEmptyColumns.js
 *
 * Audits the Document Checklist Template Board for empty columns.
 * Reports counts and lists items missing values in each key column.
 *
 * Run with: node src/scripts/auditTemplateEmptyColumns.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18401624183';

const COLS = {
  docCode:       'text_mm0xprz5',        // Document Code
  subType:       'dropdown_mm204y6w',    // Sub Type
  docCategory:   'dropdown_mm0x41zm',    // Document Category
  appType:       'dropdown_mm261bn6',    // Applicant Type
  instructions:  'long_text_mm0z10mg',   // Client-Facing Instructions
};

const COL_LABELS = {
  [COLS.docCode]:      'Document Code',
  [COLS.subType]:      'Sub Type',
  [COLS.docCategory]:  'Document Category',
  [COLS.appType]:      'Applicant Type',
  [COLS.instructions]: 'Client-Facing Instructions',
};

// ─── Fetch all items ──────────────────────────────────────────────────────────

async function fetchAllItems() {
  const items = [];
  let cursor = null;
  const colIds = Object.values(COLS).map(c => `"${c}"`).join(', ');

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
              column_values(ids: [${colIds}]) { id text }
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('▶  Fetching all template board items …');
  const items = await fetchAllItems();
  console.log(`   ${items.length} items fetched\n`);

  // Per-column: track missing items
  const missing = {};
  for (const colId of Object.values(COLS)) {
    missing[colId] = [];
  }

  for (const item of items) {
    const colMap = {};
    for (const col of item.column_values) {
      colMap[col.id] = col.text?.trim() || '';
    }

    for (const colId of Object.values(COLS)) {
      if (!colMap[colId]) {
        missing[colId].push({
          id:    item.id,
          name:  item.name,
          group: item.group?.title || '?',
        });
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('COLUMN AUDIT SUMMARY');
  console.log('═'.repeat(70));

  for (const [colId, label] of Object.entries(COL_LABELS)) {
    const count = missing[colId].length;
    const pct   = ((count / items.length) * 100).toFixed(1);
    const flag  = count === 0 ? '✅' : count < 20 ? '⚠️ ' : '❌';
    console.log(`${flag}  ${label.padEnd(30)} ${String(count).padStart(4)} empty  (${pct}%)`);
  }

  // ─── Detail: each column with missing values ────────────────────────────────
  for (const [colId, label] of Object.entries(COL_LABELS)) {
    const list = missing[colId];
    if (!list.length) continue;

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`❌  ${label} — ${list.length} items missing`);
    console.log('─'.repeat(70));

    // Group by template group for readability
    const byGroup = {};
    for (const item of list) {
      if (!byGroup[item.group]) byGroup[item.group] = [];
      byGroup[item.group].push(item);
    }

    for (const [groupTitle, groupItems] of Object.entries(byGroup).sort()) {
      console.log(`\n  [${groupTitle}]  (${groupItems.length} items)`);
      for (const it of groupItems) {
        console.log(`    • ${it.name}  (id:${it.id})`);
      }
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ Audit complete');
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
