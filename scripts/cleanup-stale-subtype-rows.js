/**
 * One-off cleanup — Execution Board rows whose Case Sub Type no longer
 * matches the parent Client Master case's current Case Sub Type.
 *
 * Background
 * ──────────
 * Before the retainer-idempotency fix, re-saving "Paid" on the Retainer
 * Status column would clear `checklistTemplateApplied` and re-trigger the
 * Document Collection Started webhook. If the sub-type had been edited
 * between payments, the second checklist run produced a new set of execution
 * rows tagged with the new sub-type — sitting alongside stale rows from the
 * first run, because the dedup key is per-template-item rather than logical.
 *
 * This script finds and archives those stale rows. It is intentionally
 * narrow — only rows that meet ALL of the following are touched:
 *
 *   1. Their `Case Sub Type` (text_mm17zdy7) is non-empty AND differs
 *      from the parent Client Master's current Case Sub Type
 *      (dropdown_mm0x4t91 on the Master row).
 *   2. They are Submission-phase items (the linked template's
 *      `dropdown_mm297t2e` is "Submission" or empty — never "Profile
 *      Creation"). Profile Creation phase items have empty sub-type by
 *      design and are shared across sub-types; they're never stale.
 *   3. The row has had no client interaction:
 *        - Document Status (color_mm0zwgvr) is "Missing" or empty
 *        - File column (file_mm0zf2hd) is empty
 *        - Last Upload Date (date_mm0zyw0m) is empty
 *        - Review Notes (long_text_mm0zbpr) is empty
 *        - Rework Count (numeric_mm0zwf95) is 0 or empty
 *
 * Rows that have ANY client/staff interaction are SKIPPED and reported
 * for manual review. Nothing is deleted — items are archived, which is
 * fully reversible from Monday's UI (Archive → Restore).
 *
 * Usage
 * ─────
 *   Dry-run (default):
 *     node scripts/cleanup-stale-subtype-rows.js
 *
 *   Restrict to one case:
 *     node scripts/cleanup-stale-subtype-rows.js --case 2026-OINP-002
 *
 *   Actually archive (after reviewing dry-run output):
 *     node scripts/cleanup-stale-subtype-rows.js --case 2026-OINP-002 --archive
 *
 *   Archive across all cases (only do this if dry-run looks clean
 *   for every affected case):
 *     node scripts/cleanup-stale-subtype-rows.js --archive
 */

'use strict';

require('dotenv').config();
const path      = require('path');
const fs        = require('fs');
const mondayApi = require('../src/services/mondayApi');

// ── Board IDs ───────────────────────────────────────────────────────────────

const EXEC_BOARD_ID = process.env.MONDAY_EXECUTION_BOARD_ID    || '18401875593';
const CM_BOARD_ID   = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const TMPL_BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID      || '18401624183';

// ── Column IDs ──────────────────────────────────────────────────────────────

const EXEC_COL = {
  caseRef:        'text_mm0z2cck',
  caseSubType:    'text_mm17zdy7',
  applicantType:  'text_mm26jcv7',
  documentCode:   'text_mm0zr7tf',
  uniqueKey:      'text_mm15dwah',
  intakeId:       'text_mm0zfsp1',
  status:         'color_mm0zwgvr',  // Document Status
  file:           'file_mm0zf2hd',
  lastUpload:     'date_mm0zyw0m',
  reviewNotes:    'long_text_mm0zbpr',
  reworkCount:    'numeric_mm0zwf95',
};

const CM_COL = {
  caseRef:     'text_mm142s49',
  caseSubType: 'dropdown_mm0x4t91',
};

const TMPL_COL = {
  checklistPhase: 'dropdown_mm297t2e',
};

// ── CLI args ────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const ARCHIVE   = args.includes('--archive');
const caseArgIx = args.indexOf('--case');
const ONLY_CASE = caseArgIx >= 0 ? args[caseArgIx + 1] : null;

const RATE_LIMIT_MS = 250;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: build map { caseRef -> currentSubType } from Client Master ─────

async function fetchClientMasterSubTypes() {
  console.log('Fetching Client Master rows…');
  const map = new Map();
  let cursor = null;
  do {
    const q = cursor
      ? `query { next_items_page(limit: 500, cursor: "${cursor}") { cursor items { id name column_values(ids: ["${CM_COL.caseRef}", "${CM_COL.caseSubType}"]) { id text } } } }`
      : `query { boards(ids: ${CM_BOARD_ID}) { items_page(limit: 500) { cursor items { id name column_values(ids: ["${CM_COL.caseRef}", "${CM_COL.caseSubType}"]) { id text } } } } }`;
    const data = await mondayApi.query(q);
    const ip   = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const it of ip.items || []) {
      const cv  = {};
      it.column_values.forEach(c => cv[c.id] = (c.text || '').trim());
      const ref = cv[CM_COL.caseRef];
      const sub = cv[CM_COL.caseSubType];
      if (ref) map.set(ref, { itemId: it.id, name: it.name, subType: sub });
    }
    cursor = ip.cursor;
  } while (cursor);
  console.log(`  → ${map.size} cases on Client Master`);
  return map;
}

// ── Step 2: fetch all execution rows ────────────────────────────────────────

async function fetchAllExecRows() {
  console.log('Fetching Execution Board rows…');
  const rows  = [];
  let cursor  = null;
  do {
    const colsList = Object.values(EXEC_COL).map(c => `"${c}"`).join(',');
    const q = cursor
      ? `query { next_items_page(limit: 500, cursor: "${cursor}") { cursor items { id name column_values(ids: [${colsList}]) { id text } } } }`
      : `query { boards(ids: ${EXEC_BOARD_ID}) { items_page(limit: 500) { cursor items { id name column_values(ids: [${colsList}]) { id text } } } } }`;
    const data = await mondayApi.query(q);
    const ip   = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const it of ip.items || []) {
      const cv = {};
      it.column_values.forEach(c => cv[c.id] = (c.text || ''));
      rows.push({
        id:            it.id,
        name:          it.name,
        ref:           cv[EXEC_COL.caseRef].trim(),
        subType:       cv[EXEC_COL.caseSubType].trim(),
        applicantType: cv[EXEC_COL.applicantType].trim(),
        intakeId:      cv[EXEC_COL.intakeId].trim(),
        status:        cv[EXEC_COL.status].trim(),
        file:          cv[EXEC_COL.file].trim(),
        lastUpload:    cv[EXEC_COL.lastUpload].trim(),
        reviewNotes:   cv[EXEC_COL.reviewNotes].trim(),
        reworkCount:   cv[EXEC_COL.reworkCount].trim(),
      });
    }
    cursor = ip.cursor;
  } while (cursor);
  console.log(`  → ${rows.length} execution rows`);
  return rows;
}

// ── Step 3: fetch checklistPhase per template (in batches) ─────────────────

async function fetchTemplatePhases(intakeIds) {
  console.log(`Fetching phase data for ${intakeIds.length} unique templates…`);
  const map = {};
  const CHUNK = 50;
  for (let i = 0; i < intakeIds.length; i += CHUNK) {
    const chunk = intakeIds.slice(i, i + CHUNK);
    try {
      const data = await mondayApi.query(
        `query($ids: [ID!]!) { items(ids: $ids) { id column_values(ids: ["${TMPL_COL.checklistPhase}"]) { id text } } }`,
        { ids: chunk }
      );
      for (const t of (data.items || [])) {
        const ph = (t.column_values?.[0]?.text || '').trim();
        map[t.id] = ph || 'Submission'; // empty defaults to Submission
      }
    } catch (err) {
      console.warn(`  ⚠ Template phase fetch failed for chunk ${i}: ${err.message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }
  return map;
}

// ── Step 4: classify each exec row ──────────────────────────────────────────

function isInteractedWith(row) {
  if (row.status && row.status.toLowerCase() !== 'missing') return true;
  if (row.file)        return true;
  if (row.lastUpload)  return true;
  if (row.reviewNotes) return true;
  if (row.reworkCount && Number(row.reworkCount) > 0) return true;
  return false;
}

function classify(row, masterMap, phaseMap) {
  const master = masterMap.get(row.ref);
  if (!master) return { kind: 'orphan', reason: 'No Client Master row for this caseRef' };

  // Profile Creation rows have empty sub-type by design — never stale
  const phase = phaseMap[row.intakeId] || 'Submission';
  if (phase === 'Profile Creation') return { kind: 'keep', reason: 'Profile Creation phase — shared across sub-types' };

  // Empty exec sub-type on a Submission item = sub-type-agnostic Submission row → keep
  if (!row.subType) return { kind: 'keep', reason: 'Submission item with empty sub-type (sub-type-agnostic)' };

  // Sub-type matches current Client Master → keep
  if (row.subType === master.subType) return { kind: 'keep', reason: 'Sub-type matches Client Master' };

  // Sub-type differs from current Master → STALE candidate
  const interacted = isInteractedWith(row);
  if (interacted) {
    return { kind: 'stale-but-interacted', reason: `Sub-type "${row.subType}" ≠ Master "${master.subType}", but row has client interaction (status="${row.status}", file=${!!row.file}, lastUpload="${row.lastUpload}", reviewNotes=${!!row.reviewNotes}, reworkCount=${row.reworkCount})` };
  }
  return { kind: 'stale', reason: `Sub-type "${row.subType}" ≠ Master "${master.subType}"` };
}

// ── Step 5: archive ─────────────────────────────────────────────────────────

async function archiveItem(itemId) {
  await mondayApi.query(
    `mutation($id: ID!) { archive_item(item_id: $id) { id } }`,
    { id: String(itemId) }
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${ARCHIVE ? '🗑  ARCHIVE (live)' : '🔍 DRY-RUN'}${ONLY_CASE ? ` | scoped to ${ONLY_CASE}` : ''}\n`);

  const masterMap = await fetchClientMasterSubTypes();
  const allRows   = await fetchAllExecRows();
  const rows      = ONLY_CASE ? allRows.filter(r => r.ref === ONLY_CASE) : allRows;
  console.log(`Rows in scope: ${rows.length}`);

  const intakeIds = [...new Set(rows.map(r => r.intakeId).filter(Boolean))];
  const phaseMap  = await fetchTemplatePhases(intakeIds);

  // Classify everything
  const buckets = { keep: [], stale: [], 'stale-but-interacted': [], orphan: [] };
  for (const row of rows) {
    const { kind, reason } = classify(row, masterMap, phaseMap);
    buckets[kind].push({ row, reason });
  }

  // Report
  console.log('\n──────────── CLASSIFICATION SUMMARY ────────────');
  console.log(`  ✅ keep                   : ${buckets.keep.length}`);
  console.log(`  🗑  stale (will archive)  : ${buckets.stale.length}`);
  console.log(`  ⚠️  stale-but-interacted  : ${buckets['stale-but-interacted'].length}  (manual review needed)`);
  console.log(`  ❓ orphan (no Master)     : ${buckets.orphan.length}`);

  // Per-case breakdown of stale rows
  const byCase = {};
  for (const e of buckets.stale) {
    byCase[e.row.ref] = (byCase[e.row.ref] || 0) + 1;
  }
  if (Object.keys(byCase).length) {
    console.log('\n  Stale rows by case:');
    for (const [ref, n] of Object.entries(byCase).sort((a,b) => b[1]-a[1])) {
      const m = masterMap.get(ref);
      console.log(`    ${ref.padEnd(28)} ${String(n).padStart(3)}  current sub="${m?.subType || '?'}"`);
    }
  }

  // Detail listing of stale rows (full)
  if (buckets.stale.length) {
    console.log('\n──────────── STALE ROWS — DETAIL ────────────');
    for (const e of buckets.stale) {
      const m = masterMap.get(e.row.ref);
      console.log(`  ${e.row.ref}  exec_id=${e.row.id}  "${e.row.name}"`);
      console.log(`     applicant=${e.row.applicantType}  rowSub="${e.row.subType}"  masterSub="${m?.subType}"  status="${e.row.status}"`);
    }
  }

  // Detail listing of stale-but-interacted (NEVER archive these, just report)
  if (buckets['stale-but-interacted'].length) {
    console.log('\n──────────── STALE-BUT-INTERACTED — MANUAL REVIEW ────────────');
    for (const e of buckets['stale-but-interacted']) {
      console.log(`  ${e.row.ref}  exec_id=${e.row.id}  "${e.row.name}"`);
      console.log(`     ${e.reason}`);
    }
  }

  // Orphans
  if (buckets.orphan.length) {
    console.log('\n──────────── ORPHAN ROWS (no Client Master) ────────────');
    for (const e of buckets.orphan.slice(0, 20)) {
      console.log(`  exec_id=${e.row.id}  ref="${e.row.ref}"  name="${e.row.name}"`);
    }
    if (buckets.orphan.length > 20) console.log(`  …and ${buckets.orphan.length - 20} more`);
  }

  // Write a detailed report to disk no matter what
  const reportPath = path.join(__dirname, 'cleanup-stale-subtype-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    mode:      ARCHIVE ? 'archive' : 'dry-run',
    scopedTo:  ONLY_CASE || 'all',
    summary: {
      keep:                  buckets.keep.length,
      stale:                 buckets.stale.length,
      staleButInteracted:    buckets['stale-but-interacted'].length,
      orphan:                buckets.orphan.length,
    },
    byCase,
    staleDetail:               buckets.stale.map(e => ({ ...e.row, reason: e.reason })),
    staleButInteractedDetail:  buckets['stale-but-interacted'].map(e => ({ ...e.row, reason: e.reason })),
    orphanDetail:              buckets.orphan.map(e => ({ ...e.row, reason: e.reason })),
  }, null, 2));
  console.log(`\nReport written to: ${reportPath}`);

  // Archive (only if --archive AND there are stale rows)
  if (!ARCHIVE) {
    console.log('\n(Dry-run only — no rows were archived. Re-run with --archive to actually archive the "stale" bucket above.)');
    return;
  }
  if (!buckets.stale.length) {
    console.log('\nNothing to archive.');
    return;
  }

  console.log(`\n🗑  Archiving ${buckets.stale.length} stale rows…`);
  let archived = 0;
  let failed   = 0;
  for (const e of buckets.stale) {
    try {
      await archiveItem(e.row.id);
      archived++;
      console.log(`  ✓ archived exec_id=${e.row.id}  ${e.row.ref}  "${e.row.name}"  applicant=${e.row.applicantType}  sub="${e.row.subType}"`);
    } catch (err) {
      failed++;
      console.error(`  ✗ failed   exec_id=${e.row.id}  (${err.message})`);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`\nDone. Archived: ${archived}  Failed: ${failed}`);
  console.log('Archived items can be restored from Monday → Board menu → Archived items.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
