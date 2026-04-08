/**
 * auditAllColumns.js
 *
 * Audits EVERY column on the Document Checklist Template Board for empty values.
 * Skips Subitems (structural column) and Name (always set).
 *
 * Run with: node src/scripts/auditAllColumns.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18401624183';

// All auditable columns (skip 'name' and 'subtasks' structural columns)
const COLS = [
  { id: 'long_text_mm0zmb7j',    label: 'Description',                  optional: true  },
  { id: 'text_mm0xprz5',         label: 'Document Code',                 optional: false },
  { id: 'dropdown_mm0x41zm',     label: 'Document Category',             optional: false },
  { id: 'dropdown_mm0x7zb4',     label: 'Primary Case Type',             optional: false },
  { id: 'dropdown_mm204y6w',     label: 'Case Sub Type',                 optional: true  },
  { id: 'color_mm0xmrw',         label: 'Blocking Flag',                 optional: true  },
  { id: 'dropdown_mm0xm5zg',     label: 'Checklist Template Version',    optional: true  },
  { id: 'color_mm0x78rc',        label: 'Counts Toward Readiness',       optional: false },
  { id: 'dropdown_mm0x9v5q',     label: 'Required Type',                 optional: false },
  { id: 'long_text_mm0x8vqe',    label: 'Conditional Logic Notes',       optional: true  },
  { id: 'multiple_person_mm0z75kq', label: 'Default Reviewer (Optional)',optional: true  },
  { id: 'dropdown_mm0zfq2v',     label: 'Default Reviewer Role',         optional: true  },
  { id: 'color_mm0z43r5',        label: 'Editable Document',             optional: false },
  { id: 'dropdown_mm0z8ztk',     label: 'Document Source',               optional: false },
  { id: 'dropdown_mm0za6r4',     label: 'Acceptable Format',             optional: false },
  { id: 'color_mm0zry4d',        label: 'Sample Required?',              optional: false },
  { id: 'file_mm0zscs4',         label: 'Sample File',                   optional: true  },
  { id: 'long_text_mm0z10mg',    label: 'Client-Facing Instructions',    optional: false },
  { id: 'color_mm0zsz8b',        label: 'Active Template',               optional: false },
  { id: 'long_text_mm0zcc2e',    label: 'Internal Notes',                optional: true  },
  { id: 'color_mm0z1a2t',        label: 'Automation Lock',               optional: true  },
  { id: 'dropdown_mm261bn6',     label: 'Applicant Type',                optional: false },
];

async function fetchAllItems() {
  const items = [];
  let cursor = null;
  const colIds = COLS.map(c => `"${c.id}"`).join(', ');

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
              group { title }
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

async function main() {
  console.log('▶  Fetching all template board items …');
  const items = await fetchAllItems();
  console.log(`   ${items.length} items fetched\n`);

  const missingMap = {};
  for (const col of COLS) missingMap[col.id] = [];

  for (const item of items) {
    const colMap = {};
    for (const col of item.column_values) colMap[col.id] = col.text?.trim() || '';

    for (const col of COLS) {
      if (!colMap[col.id]) {
        missingMap[col.id].push({ id: item.id, name: item.name, group: item.group?.title || '?' });
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('═'.repeat(72));
  console.log('FULL COLUMN AUDIT SUMMARY  (1238 items)');
  console.log('═'.repeat(72));
  console.log('  Flag  Optional  Column                          Empty   %');
  console.log('  ────  ────────  ──────────────────────────────  ──────  ────');

  const nonOptionalProblems = [];

  for (const col of COLS) {
    const count = missingMap[col.id].length;
    const pct   = ((count / items.length) * 100).toFixed(1);
    const flag  = count === 0 ? '✅' : (col.optional ? '📋' : '❌');
    const opt   = col.optional ? 'yes      ' : 'NO       ';
    console.log(`  ${flag}  ${opt} ${col.label.padEnd(34)} ${String(count).padStart(5)}  ${pct}%`);
    if (!col.optional && count > 0) nonOptionalProblems.push(col);
  }

  // ─── Detail for non-optional empty columns ─────────────────────────────────
  for (const col of nonOptionalProblems) {
    const list = missingMap[col.id];
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`❌  ${col.label} — ${list.length} items missing`);
    console.log('─'.repeat(72));

    const byGroup = {};
    for (const item of list) {
      if (!byGroup[item.group]) byGroup[item.group] = [];
      byGroup[item.group].push(item);
    }

    for (const [g, gItems] of Object.entries(byGroup).sort()) {
      console.log(`\n  [${g}]  (${gItems.length})`);
      for (const it of gItems) console.log(`    • ${it.name}  (id:${it.id})`);
    }
  }

  console.log(`\n${'═'.repeat(72)}`);
  if (nonOptionalProblems.length === 0) {
    console.log('✅ All required columns are fully populated');
  } else {
    console.log(`⚠️  ${nonOptionalProblems.length} required column(s) have missing values`);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
