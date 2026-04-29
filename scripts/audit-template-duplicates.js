/**
 * Read-only audit of the Document Checklist Template Board.
 *
 * Scans every case-type group on the Template Board and reports any items
 * that share the same logical identity, where "logical identity" is:
 *
 *   (document name + case sub-type + applicant type + checklist phase)
 *
 * These are the items that show up as duplicate rows in the client document
 * upload form (e.g. three "Identity and Civil Documents" entries on OINP
 * cases) because executionService dedupes by documentCode, not by name.
 *
 * Usage:
 *   node scripts/audit-template-duplicates.js
 *
 * Output:
 *   - Human-readable summary printed to stdout
 *   - Full JSON report written to scripts/template-duplicates-report.json
 *
 * Strictly read-only — no Monday mutations. Safe to run any time.
 */

'use strict';

require('dotenv').config();

const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const TEMPLATE_BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';

const COLS = {
  documentCode:     'text_mm0xprz5',
  caseSubType:      'dropdown_mm204y6w',
  documentCategory: 'dropdown_mm0x41zm',
  applicantType:    'dropdown_mm261bn6',
  checklistPhase:   'dropdown_mm297t2e',
};

const RATE_LIMIT_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── Step 1: list every group on the board ─────────────────────────────── */

async function listAllGroups() {
  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         groups { id title }
       }
     }`,
    { boardId: String(TEMPLATE_BOARD_ID) }
  );
  return data?.boards?.[0]?.groups || [];
}

/* ─── Step 2: fetch all items in one group ──────────────────────────────── */

async function fetchGroupItems(groupId) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $groupId: String!) {
       boards(ids: [$boardId]) {
         groups(ids: [$groupId]) {
           items_page(limit: 500) {
             items {
               id
               name
               column_values(ids: [
                 "${COLS.documentCode}",
                 "${COLS.caseSubType}",
                 "${COLS.documentCategory}",
                 "${COLS.applicantType}",
                 "${COLS.checklistPhase}"
               ]) { id text }
             }
           }
         }
       }
     }`,
    { boardId: String(TEMPLATE_BOARD_ID), groupId }
  );
  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
  return items.map((it) => {
    const m = {};
    for (const c of it.column_values) m[c.id] = (c.text || '').trim();
    return {
      id:               it.id,
      name:             (it.name || '').trim(),
      documentCode:     m[COLS.documentCode]     || '',
      caseSubType:      m[COLS.caseSubType]      || '',
      documentCategory: m[COLS.documentCategory] || '',
      applicantType:    m[COLS.applicantType]    || 'Principal Applicant',
      checklistPhase:   m[COLS.checklistPhase]   || 'Submission',
    };
  });
}

/* ─── Step 3: logical-key normalisation + duplicate detection ───────────── */

function logicalKey(item) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    norm(item.name),
    norm(item.caseSubType),
    norm(item.applicantType) || 'principal applicant',
    norm(item.checklistPhase) || 'submission',
  ].join(' ¦ ');
}

function findDuplicateSets(items) {
  const buckets = new Map();
  for (const it of items) {
    const k = logicalKey(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  // Return only buckets with 2+ entries
  return [...buckets.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, arr]) => ({ key, items: arr }));
}

/* ─── Step 4: pretty-print summary ──────────────────────────────────────── */

function printGroupReport(groupTitle, dupSets) {
  if (!dupSets.length) return;
  console.log(`\n[${groupTitle}]`);
  for (const set of dupSets) {
    const sample = set.items[0];
    const subLbl = sample.caseSubType || '(none)';
    console.log(`  ⚠️  "${sample.name}"  ·  sub: ${subLbl}  ·  applicant: ${sample.applicantType}  ·  phase: ${sample.checklistPhase}  →  ${set.items.length} copies`);
    for (const it of set.items) {
      console.log(`        id=${it.id}  code=${it.documentCode || '(none)'}  category=${it.documentCategory || '(none)'}`);
    }
  }
}

/* ─── Main ──────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Auditing Template Board ${TEMPLATE_BOARD_ID} for logical duplicates…\n`);

  const groups = await listAllGroups();
  console.log(`Found ${groups.length} groups on the board.\n`);

  const report = {
    scannedAt:  new Date().toISOString(),
    boardId:    TEMPLATE_BOARD_ID,
    groups:     [],
  };

  let totalItems     = 0;
  let totalDupSets   = 0;
  let totalDupExtras = 0; // items that could be removed if dedup'd to 1

  for (const g of groups) {
    let items = [];
    try {
      items = await fetchGroupItems(g.id);
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch items for group "${g.title}" (${g.id}): ${err.message}`);
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    totalItems += items.length;

    const dupSets = findDuplicateSets(items);
    if (dupSets.length) {
      totalDupSets   += dupSets.length;
      totalDupExtras += dupSets.reduce((s, d) => s + (d.items.length - 1), 0);
      printGroupReport(g.title, dupSets);
    }

    report.groups.push({
      groupId:    g.id,
      groupTitle: g.title,
      itemCount:  items.length,
      duplicates: dupSets,
    });

    await sleep(RATE_LIMIT_MS);
  }

  /* Summary */
  console.log('\n──────────── SUMMARY ────────────');
  console.log(`Groups scanned:        ${groups.length}`);
  console.log(`Total template items:  ${totalItems}`);
  console.log(`Duplicate sets found:  ${totalDupSets}`);
  console.log(`Removable duplicates:  ${totalDupExtras}  (if each set were collapsed to one)`);

  report.summary = {
    groupsScanned:     groups.length,
    totalItems,
    duplicateSets:     totalDupSets,
    removableExtras:   totalDupExtras,
  };

  /* Write JSON report */
  const outPath = path.join(__dirname, 'template-duplicates-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull JSON report written to: ${outPath}`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
