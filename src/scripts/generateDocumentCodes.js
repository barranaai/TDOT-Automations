/**
 * generateDocumentCodes.js
 *
 * Generates Document Code values for Document Checklist Template Board items
 * that are missing one — replacing the Monday.com AI Autofill that was
 * consuming AI credits.
 *
 * Formula:
 *   {DOC_INITIALS}_{CASETYPE_ABBR}_{CATEGORY_ABBR}_{NUM:03}
 *
 *   DOC_INITIALS  — first letter of each word in the Document Name, uppercased
 *                   (max 8 chars to keep codes readable)
 *   CASETYPE_ABBR — short abbreviation from the CASE_TYPE_ABBR map below
 *   CATEGORY_ABBR — short abbreviation from the CATEGORY_ABBR map below
 *   NUM           — 3-digit number, unique within the same base prefix
 *                   (incremented across the whole board, not just per case type)
 *
 * Examples:
 *   "Passport with all stamps pages"  + Visitor Visa + Identity  → PWASP_VV_ID_001
 *   "Proof of Employment Letter"      + Study Permit + Employment → POEL_SP_EMP_001
 *   "Bank Statements (6 months)"      + PGWP          + Financial → BS6M_PGWP_FIN_001
 *
 * Behaviour:
 *   • Items that already have a Document Code are NEVER modified.
 *   • Generated codes are guaranteed unique within the board before being written.
 *   • Run without --write to preview all changes (dry run).
 *
 * Usage:
 *   node src/scripts/generateDocumentCodes.js            # dry run — preview only
 *   node src/scripts/generateDocumentCodes.js --write    # write to Monday.com
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

// ─── Board & column IDs ───────────────────────────────────────────────────────

const TEMPLATE_BOARD  = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';

const COL_DOC_CODE    = 'text_mm0xprz5';        // Document Code (target)
const COL_CATEGORY    = 'dropdown_mm0x41zm';     // Document Category
const COL_CASE_TYPE   = 'dropdown_mm0x7zb4';     // Primary Case Type

const DELAY_MS        = 300;   // ms between write mutations (rate-limit safe)
const MAX_INITIALS    = 8;     // cap on document-name initial characters

// ─── Case type → abbreviation map ────────────────────────────────────────────
// Covers all 56 case types from config/caseTypes.js.

const CASE_TYPE_ABBR = {
  'AAIP':                                                         'AAIP',
  'Addition of Spouse':                                           'AOS',
  'Amendment of Document':                                        'AMD',
  'Appeal':                                                       'APPL',
  'BCPNP':                                                        'BCPNP',
  'BOWP':                                                         'BOWP',
  'Canadian Experience Class (EE after ITA)':                     'CEC',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)':'CECPR',
  'Canadian Experience Class (Profile+ITA+Submission)':           'CECPIS',
  'Child Sponsorship':                                            'CS',
  'Citizenship':                                                  'CTZ',
  'Co-op WP':                                                     'COWP',
  'Concurrent WP':                                                'CWP',
  'Employer Portal':                                              'EP',
  'ETA':                                                          'ETA',
  'Federal PR':                                                   'FPR',
  'Francophone Mobility WP':                                      'FMWP',
  'H & C':                                                        'HC',
  'ICAS/WES/IQAS':                                               'IWI',
  'Inland Spousal Sponsorship':                                   'ISS',
  'Invitation Letter':                                            'IL',
  'LMIA':                                                         'LMIA',
  'LMIA Based WP':                                                'LBWP',
  'LMIA Exempt WP':                                               'LEWP',
  'Manitoba PNP':                                                 'MPNP',
  'Miscellaneous':                                                'MISC',
  'NB WP Extension':                                              'NBWPE',
  'Notary':                                                       'NOT',
  'NSNP':                                                         'NSNP',
  'OCI / Passport Surrender':                                     'OCI',
  'OINP':                                                         'OINP',
  'Outland Spousal Sponsorship':                                  'OSS',
  'Parents/Grandparents Sponsorship':                             'PGS',
  'PFL':                                                          'PFL',
  'PGWP':                                                         'PGWP',
  'PR Card Renewal':                                              'PRCR',
  'PRAA':                                                         'PRAA',
  'PRTD':                                                         'PRTD',
  'RCIP':                                                         'RCIP',
  'Reconsideration':                                              'RECON',
  'Refugee':                                                      'REF',
  'Refugee WP':                                                   'RFWP',
  'Renunciation of PR':                                           'RPR',
  'Request Letter':                                               'RL',
  'RNIP':                                                         'RNIP',
  'SCLPC WP':                                                     'SCWP',
  'SNIP':                                                         'SNIP',
  'SOWP':                                                         'SOWP',
  'Study Permit':                                                 'SP',
  'Study Permit Extension':                                       'SPE',
  'Supervisa':                                                    'SV',
  'TRP':                                                          'TRP',
  'TRV':                                                          'TRV',
  'USA Visa':                                                     'USAV',
  'Visitor Record / Extension':                                   'VRE',
  'Visitor Visa':                                                 'VV',
};

// ─── Document category → abbreviation map ────────────────────────────────────

const CATEGORY_ABBR = {
  'Identity':   'ID',
  'Personal':   'PER',
  'Financial':  'FIN',
  'Employment': 'EMP',
  'Education':  'EDU',
  'Travel':     'TRV',
  'Legal':      'LEG',
  'Medical':    'MED',
  'Supporting': 'SUP',
  'General':    'GEN',
  'Other':      'OTH',
};

// ─── Code generation helpers ──────────────────────────────────────────────────

/**
 * Derive initials from a document name.
 * Takes the first letter of each word (stripped of punctuation), uppercased,
 * capped at MAX_INITIALS characters.
 *
 * Examples:
 *   "Passport with all stamps pages"      → "PWASP"
 *   "Bank Statements (6 months)"          → "BS6M"
 *   "Proof of Employment Letter"          → "POEL"
 *   "Government Issued Identity Document" → "GIID"
 */
function docInitials(name) {
  return name
    .replace(/[()[\]{}/\\]/g, ' ')   // treat brackets as word separators
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())   // first char of each token
    .filter((c) => /[A-Z0-9]/.test(c)) // letters and digits only
    .slice(0, MAX_INITIALS)
    .join('');
}

/**
 * Look up the case type abbreviation.
 * Falls back to auto-deriving initials from the case type string if not in map.
 */
function caseTypeAbbr(caseType) {
  if (!caseType) return '';
  if (CASE_TYPE_ABBR[caseType]) return CASE_TYPE_ABBR[caseType];
  // Fallback: derive from the string (handles unknown/future case types)
  return caseType
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/**
 * Look up the category abbreviation.
 * Falls back to first 3 uppercase chars if not in map.
 */
function categoryAbbr(category) {
  if (!category) return '';
  if (CATEGORY_ABBR[category]) return CATEGORY_ABBR[category];
  return category.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}

/**
 * Build a full document code given its components and a set of already-taken codes.
 * Tries 001, 002, … until finding one not already in takenCodes.
 *
 * @param {string}      docName
 * @param {string}      caseType
 * @param {string}      category
 * @param {Set<string>} takenCodes  — all codes already on the board (including newly
 *                                    assigned ones from earlier in this run)
 * @returns {string}
 */
function buildCode(docName, caseType, category, takenCodes) {
  const parts = [
    docInitials(docName),
    caseTypeAbbr(caseType),
    categoryAbbr(category),
  ].filter(Boolean);

  const base = parts.join('_');

  let n = 1;
  let candidate;
  do {
    candidate = `${base}_${String(n).padStart(3, '0')}`;
    n++;
  } while (takenCodes.has(candidate));

  return candidate;
}

// ─── Monday.com helpers ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAllTemplateItems() {
  const items  = [];
  let   cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(`
      query {
        boards(ids: ["${TEMPLATE_BOARD}"]) {
          items_page(limit: 500${cursorArg}) {
            cursor
            items {
              id
              name
              column_values(ids: [
                "${COL_DOC_CODE}",
                "${COL_CATEGORY}",
                "${COL_CASE_TYPE}"
              ]) { id text }
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

async function writeDocCode(itemId, code) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(
         board_id:      $boardId,
         item_id:       $itemId,
         column_values: $cols
       ) { id }
     }`,
    {
      boardId: String(TEMPLATE_BOARD),
      itemId:  String(itemId),
      cols:    JSON.stringify({ [COL_DOC_CODE]: code }),
    }
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const DRY_RUN = !process.argv.includes('--write');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Document Code Generator — Document Checklist Template Board  ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (preview only — pass --write to apply)' : '✏️  WRITE MODE'}`);
  console.log('');

  // ── 1. Fetch all template items ──────────────────────────────────────────────
  console.log('▶  Fetching template board items…');
  const allItems = await fetchAllTemplateItems();
  console.log(`   ${allItems.length} items loaded\n`);

  // ── 2. Build set of all existing codes ──────────────────────────────────────
  const takenCodes  = new Set();
  const toProcess   = [];
  let   alreadyHas  = 0;

  for (const item of allItems) {
    const cv       = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    const code     = cv(COL_DOC_CODE);
    const category = cv(COL_CATEGORY);
    const caseType = cv(COL_CASE_TYPE);

    if (code) {
      takenCodes.add(code);    // register existing codes so we don't duplicate
      alreadyHas++;
    } else {
      toProcess.push({ id: item.id, name: item.name, category, caseType });
    }
  }

  console.log(`   ${alreadyHas} items already have a Document Code — will not be modified`);
  console.log(`   ${toProcess.length} items are missing a Document Code\n`);

  if (!toProcess.length) {
    console.log('✅ Nothing to do — all items already have a Document Code.');
    return;
  }

  // ── 3. Generate codes & preview ──────────────────────────────────────────────
  console.log('─'.repeat(67));
  console.log('  Item Name                                        Generated Code');
  console.log('─'.repeat(67));

  const plan = [];    // [{ id, name, code }]
  let warnings = 0;

  for (const item of toProcess) {
    const { id, name, category, caseType } = item;

    const warn = [];
    if (!caseType)  warn.push('no case type');
    if (!category)  warn.push('no category');

    const code = buildCode(name, caseType, category, takenCodes);
    takenCodes.add(code);   // reserve immediately so next item won't collide
    plan.push({ id, name, code, warn });

    const label = name.length > 44 ? name.slice(0, 43) + '…' : name;
    const warnStr = warn.length ? `  ⚠ ${warn.join(', ')}` : '';
    console.log(`  ${label.padEnd(46)}  ${code}${warnStr}`);
    if (warn.length) warnings++;
  }

  console.log('─'.repeat(67));
  console.log(`\n  Total to generate: ${plan.length}`);
  if (warnings) console.log(`  Warnings (partial info): ${warnings}`);
  console.log('');

  if (DRY_RUN) {
    console.log('ℹ️  Dry run complete. No changes made.');
    console.log('   Run with --write to apply these codes to the board.\n');
    return;
  }

  // ── 4. Write codes to the board ──────────────────────────────────────────────
  console.log('▶  Writing codes to Monday.com…\n');

  let written = 0;
  let failed  = 0;

  for (const { id, name, code } of plan) {
    try {
      await writeDocCode(id, code);
      written++;
      console.log(`  ✓  "${code}"  ←  ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗  FAILED for "${name}" (id:${id}): ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Done — written: ${written}  failed: ${failed}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
