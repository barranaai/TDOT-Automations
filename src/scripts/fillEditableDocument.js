/**
 * fillEditableDocument.js
 *
 * Sets "Editable Document" (color_mm0z43r5) on every template board item.
 *
 * Yes — documents the client or their representative creates / fills in / signs:
 *   affidavits, forms (employer/NSNP), resume/CV, statement of purpose,
 *   intention-to-reside letters, application forms, questionnaires, declarations
 *
 * No — documents the client just uploads (pre-existing / third-party issued):
 *   passports, birth certificates, permits, police certs, medical exams,
 *   language tests, tax docs, bank statements, photos, job offer letters,
 *   educational credentials, government-issued docs, proof of relationship, etc.
 *
 * Run with: node src/scripts/fillEditableDocument.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID    = '18401624183';
const EDITABLE_COL = 'color_mm0z43r5';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Returns true if the document is one the client creates/fills/signs.
 */
function isEditable(name) {
  const n = name.toLowerCase();

  // Affidavits
  if (n.includes('affidavit')) return true;

  // Resumes / CVs
  if (n.includes('resume') || n.includes('curriculum vitae') || n === 'cv') return true;

  // Intention to reside letters
  if (n.includes('intention to reside')) return true;

  // Statement of purpose
  if (n.includes('statement of purpose')) return true;

  // Employer / government forms (client or employer fills these in)
  if (n.includes('employer declaration')) return true;
  if (n.includes('employer information form')) return true;
  if (n.includes('application for approval of an employment position')) return true;
  if (n.includes('nsnp 200')) return true;

  // Previous application forms (client provides filled-in forms)
  if (n.includes('previous application forms')) return true;

  // Conditional questions that are essentially declarations
  if (n.startsWith('if you or your spouse')) return true;

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
              column_values(ids: ["${EDITABLE_COL}"]) { id text }
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

    const current = colMap[EDITABLE_COL];
    const target  = isEditable(item.name) ? 'Yes' : 'No';

    if (current === target) { skipped++; continue; }

    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        {
          boardId: String(BOARD_ID),
          itemId:  String(item.id),
          cols:    JSON.stringify({ [EDITABLE_COL]: { label: target } }),
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
  console.log(`   Set Yes (editable)    : ${yes}`);
  console.log(`   Set No  (upload only) : ${no}`);
  console.log(`   Already set           : ${skipped}`);
  console.log(`   Errors                : ${errors}`);

  if (yesList.length) {
    console.log(`\nDocuments marked Editable (Yes):`);
    for (const n of [...new Set(yesList)].sort()) console.log(`  • ${n}`);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
