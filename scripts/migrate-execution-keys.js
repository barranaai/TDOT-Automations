/**
 * Migration — switch Execution Board uniqueKey from the legacy
 * `<caseRef>-<documentCode>` format to a logical-identity format:
 *
 *   LK::<caseRef>::<normalized name>::<applicantType>::<phase>
 *
 * Why: the old key uses documentCode, which legitimately varies per
 * (sub-type × applicant) tuple on the Template Board. That makes the
 * dedup check unable to recognise two rows as "the same logical document"
 * across sub-type drift, intra-run code collisions, or any of the other
 * recurring duplication root-causes we found. The logical key collapses
 * those variants into a single canonical identity so future re-runs of
 * checklist generation are idempotent.
 *
 * The "LK::" prefix on the new format guarantees it can never collide
 * with any existing legacy key — so during the transition window the
 * application code can safely check both formats.
 *
 * Safety
 * ──────
 *   • Default mode is DRY-RUN. --write must be passed explicitly.
 *   • Skips archived rows (only active rows are touched).
 *   • Skips rows that already have an LK:: key (idempotent — re-runnable).
 *   • Detects collisions before writing: two rows that would resolve to
 *     the same logical key are reported, NEVER both rewritten. Staff
 *     decides which to keep.
 *   • Per-case scope: `--case <ref>` runs only one case for safe rollout.
 *   • Writes a full JSON report to disk for audit trail.
 *
 * Usage
 * ─────
 *   Full dry-run (recommended first step):
 *     node scripts/migrate-execution-keys.js
 *
 *   Dry-run scoped to one case:
 *     node scripts/migrate-execution-keys.js --case 2026-OINP-002
 *
 *   Write changes for one case (after dry-run looks clean):
 *     node scripts/migrate-execution-keys.js --case 2026-OINP-002 --write
 *
 *   Write across every case (only after at least one --case write
 *   has been confirmed safe):
 *     node scripts/migrate-execution-keys.js --write
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

// ─── Boards & columns ───────────────────────────────────────────────────────

const EXEC_BOARD_ID = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const TMPL_BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID  || '18401624183';

const EXEC_COL = {
  caseRef:        'text_mm0z2cck',
  uniqueKey:      'text_mm15dwah',
  intakeId:       'text_mm0zfsp1',
  applicantType:  'text_mm26jcv7',
  caseSubType:    'text_mm17zdy7',
  documentCode:   'text_mm0zr7tf',
};

const TMPL_COL = {
  checklistPhase: 'dropdown_mm297t2e',
};

// ─── CLI ────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const WRITE     = args.includes('--write');
const caseArgIx = args.indexOf('--case');
const ONLY_CASE = caseArgIx >= 0 ? args[caseArgIx + 1] : null;
const RATE_LIMIT_MS = 250;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Logical key ────────────────────────────────────────────────────────────

const LK_PREFIX  = 'LK::';
const LK_SEP     = '::';

/**
 * Conservative name normalisation:
 *   • trim
 *   • collapse internal whitespace
 *   • lowercase
 *   • strip trailing periods (the "Passport." vs "Passport" issue)
 *
 * NOT done: stripping parenthetical content. Some document names use
 * parens to disambiguate (e.g. "Proof of language proficiency (IELTS-…)")
 * and those distinctions are real.
 */
function normName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '');
}

function logicalKey({ caseRef, name, applicantType, phase }) {
  const phaseClean = String(phase || 'Submission').trim() || 'Submission';
  const appClean   = String(applicantType || 'Principal Applicant').trim() || 'Principal Applicant';
  return `${LK_PREFIX}${caseRef}${LK_SEP}${normName(name)}${LK_SEP}${appClean}${LK_SEP}${phaseClean}`;
}

// ─── Step 1: Fetch all (active) execution rows ──────────────────────────────

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
        name:          (it.name || '').trim(),
        ref:           cv[EXEC_COL.caseRef].trim(),
        oldKey:        cv[EXEC_COL.uniqueKey].trim(),
        intakeId:      cv[EXEC_COL.intakeId].trim(),
        applicantType: cv[EXEC_COL.applicantType].trim() || 'Principal Applicant',
        caseSubType:   cv[EXEC_COL.caseSubType].trim(),
        documentCode:  cv[EXEC_COL.documentCode].trim(),
      });
    }
    cursor = ip.cursor;
  } while (cursor);
  console.log(`  → ${rows.length} active execution rows`);
  return rows;
}

// ─── Step 2: Resolve checklistPhase per template ────────────────────────────

async function fetchTemplatePhases(intakeIds) {
  if (!intakeIds.length) return {};
  console.log(`Fetching checklistPhase for ${intakeIds.length} unique templates…`);
  const map = {};
  // Smaller chunks + per-template lookup-by-id ensures the response
  // structure isn't fragile to ordering/missing items in larger batches.
  const CHUNK = 25;
  let fetched = 0;
  let missing = 0;
  for (let i = 0; i < intakeIds.length; i += CHUNK) {
    const chunk = intakeIds.slice(i, i + CHUNK);
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      try {
        const data = await mondayApi.query(
          `query($ids: [ID!]!) { items(ids: $ids) { id column_values(ids: ["${TMPL_COL.checklistPhase}"]) { id text } } }`,
          { ids: chunk }
        );
        const returned = data?.items || [];
        for (const t of returned) {
          const phaseCol = t.column_values?.find?.(c => c.id === TMPL_COL.checklistPhase);
          const ph = (phaseCol?.text || '').trim();
          map[t.id] = ph || 'Submission';
          fetched++;
        }
        // Detect any IDs in the chunk that didn't come back
        const got = new Set(returned.map(r => String(r.id)));
        for (const reqId of chunk) {
          if (!got.has(String(reqId))) {
            console.warn(`  ⚠ template ${reqId} not returned by Monday — defaulting to Submission`);
            map[reqId] = 'Submission';
            missing++;
          }
        }
        break;
      } catch (err) {
        if (attempts >= 3) {
          console.warn(`  ⚠ Template phase fetch failed at chunk ${i} after 3 attempts: ${err.message}`);
          for (const reqId of chunk) {
            if (!(reqId in map)) {
              map[reqId] = 'Submission';
              missing++;
            }
          }
        } else {
          await sleep(1000 * attempts);
        }
      }
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`  → ${fetched} templates fetched, ${missing} defaulted to Submission`);
  return map;
}

// ─── Step 3: Compute migration plan ─────────────────────────────────────────

function buildMigrationPlan(rows, phaseMap) {
  const plan = {
    rows:             [],   // { id, ref, oldKey, newKey, name, applicant, phase, action }
    collisions:       [],   // groups of rows that would resolve to the same newKey
    alreadyMigrated:  [],   // rows already using LK:: format
    skippedNoCaseRef: [],   // rows missing caseRef (corrupted)
  };

  // Pass 1 — compute newKey for every row
  const candidates = [];
  for (const r of rows) {
    if (!r.ref) {
      plan.skippedNoCaseRef.push(r);
      continue;
    }
    if (r.oldKey.startsWith(LK_PREFIX)) {
      plan.alreadyMigrated.push(r);
      continue;
    }
    const phase  = phaseMap[r.intakeId] || 'Submission';
    const newKey = logicalKey({
      caseRef:       r.ref,
      name:          r.name,
      applicantType: r.applicantType,
      phase,
    });
    candidates.push({ ...r, phase, newKey });
  }

  // Pass 2 — detect collisions (two+ rows mapping to the same newKey)
  const byNewKey = {};
  for (const c of candidates) {
    if (!byNewKey[c.newKey]) byNewKey[c.newKey] = [];
    byNewKey[c.newKey].push(c);
  }

  for (const [newKey, group] of Object.entries(byNewKey)) {
    if (group.length === 1) {
      plan.rows.push({
        ...group[0],
        action: 'rewrite',
      });
    } else {
      // Multiple rows would resolve to the same logical key — these ARE
      // duplicates by definition. We don't auto-rewrite all of them
      // (because doing so would put two rows on the board with the same
      // uniqueKey, which is bad). We flag the group for manual review:
      // staff decides which row is canonical, and the others should be
      // archived (using the existing cleanup script with --include-interacted
      // or a manual review).
      plan.collisions.push({ newKey, members: group });
      for (const r of group) {
        plan.rows.push({
          ...r,
          action: 'skip-collision',
        });
      }
    }
  }

  return plan;
}

// ─── Step 4: Apply (write mode only) ────────────────────────────────────────

async function writeNewKey(itemId, newKey) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(EXEC_BOARD_ID),
      itemId:  String(itemId),
      cols:    JSON.stringify({ [EXEC_COL.uniqueKey]: newKey }),
    }
  );
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printPlan(plan, scope) {
  const rewriteCount  = plan.rows.filter(r => r.action === 'rewrite').length;
  const collisionRows = plan.rows.filter(r => r.action === 'skip-collision').length;

  console.log('\n──────────── MIGRATION PLAN ────────────');
  console.log(`  Scope                       : ${scope}`);
  console.log(`  Active rows considered      : ${plan.rows.length + plan.alreadyMigrated.length + plan.skippedNoCaseRef.length}`);
  console.log(`  Already on logical keys     : ${plan.alreadyMigrated.length}  (skipped — idempotent)`);
  console.log(`  Missing caseRef (corrupted) : ${plan.skippedNoCaseRef.length}  (skipped — manual review)`);
  console.log(`  Will rewrite to logical key : ${rewriteCount}`);
  console.log(`  Collision groups            : ${plan.collisions.length}  (skipped — manual review needed)`);
  console.log(`     ↳ rows in collision sets : ${collisionRows}`);

  // Per-case breakdown of rewrites
  const byCase = {};
  for (const r of plan.rows) {
    if (r.action !== 'rewrite') continue;
    byCase[r.ref] = (byCase[r.ref] || 0) + 1;
  }
  if (Object.keys(byCase).length) {
    console.log('\n  Rewrites by case:');
    for (const [ref, n] of Object.entries(byCase).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${ref.padEnd(28)} ${n}`);
    }
  }

  // Sample of rewrites (first 5)
  const samples = plan.rows.filter(r => r.action === 'rewrite').slice(0, 5);
  if (samples.length) {
    console.log('\n  Sample rewrites:');
    for (const r of samples) {
      console.log(`    [${r.ref}]  ${r.id}`);
      console.log(`       old: ${r.oldKey}`);
      console.log(`       new: ${r.newKey}`);
    }
  }

  // Collisions (full detail)
  if (plan.collisions.length) {
    console.log('\n──────────── COLLISIONS — MANUAL REVIEW ────────────');
    for (const col of plan.collisions) {
      console.log(`\n  Logical key: ${col.newKey}`);
      console.log(`  → ${col.members.length} existing rows would collapse onto this key:`);
      for (const m of col.members) {
        console.log(`     id=${m.id}  oldKey=${m.oldKey}  sub="${m.caseSubType}"  intake=${m.intakeId}`);
      }
    }
    console.log('\n  These rows are NOT auto-rewritten. Decide which row is the canonical one for each');
    console.log('  collision group, then archive the others using scripts/cleanup-stale-subtype-rows.js');
    console.log('  or a manual archive in Monday. After that, re-run this script.');
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN'}${ONLY_CASE ? `  |  scope: ${ONLY_CASE}` : '  |  scope: ALL CASES'}\n`);

  const allRows  = await fetchAllExecRows();
  const rowsIn   = ONLY_CASE ? allRows.filter(r => r.ref === ONLY_CASE) : allRows;
  if (!rowsIn.length) {
    console.log('No rows in scope. Nothing to do.');
    return;
  }

  const intakeIds = [...new Set(rowsIn.map(r => r.intakeId).filter(Boolean))];
  const phaseMap  = await fetchTemplatePhases(intakeIds);

  const plan = buildMigrationPlan(rowsIn, phaseMap);
  printPlan(plan, ONLY_CASE || 'ALL CASES');

  // Write report to disk regardless
  const reportPath = path.join(__dirname, 'migrate-execution-keys-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    runAt:       new Date().toISOString(),
    mode:        WRITE ? 'write' : 'dry-run',
    scope:       ONLY_CASE || 'ALL',
    summary: {
      totalConsidered:    plan.rows.length + plan.alreadyMigrated.length + plan.skippedNoCaseRef.length,
      alreadyMigrated:    plan.alreadyMigrated.length,
      missingCaseRef:     plan.skippedNoCaseRef.length,
      willRewrite:        plan.rows.filter(r => r.action === 'rewrite').length,
      collisionGroups:    plan.collisions.length,
    },
    rewrites:   plan.rows.filter(r => r.action === 'rewrite'),
    collisions: plan.collisions,
    skipped:    {
      alreadyMigrated:  plan.alreadyMigrated,
      missingCaseRef:   plan.skippedNoCaseRef,
    },
  }, null, 2));
  console.log(`\nReport written to: ${reportPath}`);

  if (!WRITE) {
    console.log('\n(Dry-run only — no rows written. Re-run with --write to apply.)');
    return;
  }

  // ── Write phase ──
  const toWrite = plan.rows.filter(r => r.action === 'rewrite');
  if (!toWrite.length) {
    console.log('\nNothing to write.');
    return;
  }

  console.log(`\n✏  Writing logical keys for ${toWrite.length} rows…`);
  let written = 0;
  let failed  = 0;
  for (const r of toWrite) {
    try {
      await writeNewKey(r.id, r.newKey);
      written++;
      console.log(`  ✓ ${r.ref}  id=${r.id}  ${r.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${r.ref}  id=${r.id}  ${err.message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`\nDone. Written: ${written}  Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
