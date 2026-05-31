/**
 * One-time backfill — retroactively fixes Q Completion Status on Client
 * Master rows where the questionnaire WAS submitted (per the Updates feed)
 * but the column got stuck on "Working on it" because of the old code
 * rule that required pct >= 100%.
 *
 * The code rule was fixed in commit 2a4a687 (Q Completion Status flips to
 * Done at submission, not 100%). New submissions will now behave correctly.
 * This script handles the cases that were submitted BEFORE that fix.
 *
 * Detection rule: a case is "stuck" if:
 *   1. Its Q Completion Status column is "Working on it" (not "Done"), AND
 *   2. Its Monday Updates feed contains a "📋 Questionnaire Submitted" entry
 *
 * Action: set Q Completion Status to "Done" and post an audit Update on
 * the row explaining what was corrected.
 *
 * Safety:
 *   - Default dry-run; --write to apply.
 *   - Read-only Updates feed query — no data is destroyed.
 *   - Posts an audit comment on each updated case so staff can trace the
 *     correction back to this script.
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../src/services/mondayApi');

const CM_BOARD_ID = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const CASE_REF_COL          = 'text_mm142s49';
const Q_COMPLETION_COL      = 'color_mm0x9s08';   // labels: Done / Working on it
const Q_READINESS_COL       = 'numeric_mm0x9dea';

const WRITE = process.argv.includes('--write');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAllCases() {
  const rows = [];
  let cursor = null;
  do {
    const q = cursor
      ? `query { next_items_page(limit:200, cursor:"${cursor}") { cursor items { id name column_values(ids:["${CASE_REF_COL}","${Q_COMPLETION_COL}","${Q_READINESS_COL}"]) { id text } updates { id body created_at } } } }`
      : `query { boards(ids:${CM_BOARD_ID}) { items_page(limit:200) { cursor items { id name column_values(ids:["${CASE_REF_COL}","${Q_COMPLETION_COL}","${Q_READINESS_COL}"]) { id text } updates { id body created_at } } } } }`;
    const data = await mondayApi.query(q);
    const ip = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const it of (ip.items || [])) {
      const cv = {};
      for (const c of it.column_values) cv[c.id] = c.text || '';
      rows.push({
        id:       it.id,
        name:     it.name,
        caseRef:  cv[CASE_REF_COL],
        qStatus:  cv[Q_COMPLETION_COL],
        qReadiness: cv[Q_READINESS_COL],
        updates:  it.updates || [],
      });
    }
    cursor = ip.cursor;
    if (cursor) await sleep(200);
  } while (cursor);
  return rows;
}

function hasSubmissionUpdate(row) {
  for (const u of row.updates) {
    const body = (u.body || '').toLowerCase();
    if (body.includes('questionnaire submitted')) return true;
  }
  return false;
}

function findSubmissionDate(row) {
  for (const u of row.updates) {
    if ((u.body || '').toLowerCase().includes('questionnaire submitted')) {
      return u.created_at;
    }
  }
  return null;
}

async function setQCompletionDone(row) {
  // Set Q Completion Status to "Done"
  await mondayApi.query(
    `mutation($itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: ${CM_BOARD_ID}, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      itemId: String(row.id),
      cols:   JSON.stringify({ [Q_COMPLETION_COL]: { label: 'Done' } }),
    }
  );

  // Post an audit Update explaining the correction
  const submissionDate = findSubmissionDate(row) || 'unknown date';
  const body =
    `🛠 Q Completion Status corrected (backfill)\n\n` +
    `Case: ${row.caseRef}  (${row.name})\n` +
    `Q Readiness at submission: ${row.qReadiness}%\n` +
    `Submission logged in Updates feed: ${submissionDate}\n\n` +
    `This case had its questionnaire submitted, but the old code rule required pct >= 100% before flipping Q Completion Status to Done. The rule was wrong -- the 80% submission gate is the authoritative threshold; once a client clears it and clicks Submit they're done from their side. Q Readiness still reflects the actual percentage.\n\n` +
    `Code fixed in commit 2a4a687. This backfill ran on ${new Date().toISOString().split('T')[0]} to retroactively correct cases that were already stuck in the old broken state.`;
  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId: String(row.id), body }
  );
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN'}\n`);

  console.log('Fetching all Client Master rows + Updates feeds…');
  const rows = await fetchAllCases();
  console.log(`  → ${rows.length} cases\n`);

  // Detect stuck cases
  const stuck = [];
  for (const row of rows) {
    if (row.qStatus === 'Done') continue;            // already correct
    if (!row.caseRef) continue;                       // no case ref → skip
    if (!hasSubmissionUpdate(row)) continue;          // never submitted → correct that it's not Done
    stuck.push(row);
  }

  console.log(`Stuck cases (submitted but Q Status still "${'Working on it'}"):`);
  console.log('');
  if (stuck.length === 0) {
    console.log('  (none — all cases are correctly classified)');
    return;
  }
  for (const r of stuck) {
    console.log(`  • ${r.caseRef.padEnd(20)} ${r.qStatus.padEnd(15)} Q=${(r.qReadiness || '?')}%  ${r.name}`);
  }
  console.log(`\n  → ${stuck.length} cases would be set to Done`);

  if (!WRITE) {
    console.log('\n(Dry-run only. Re-run with --write to apply.)');
    return;
  }

  console.log('\nApplying corrections…');
  let ok = 0, failed = 0;
  for (const r of stuck) {
    try {
      await setQCompletionDone(r);
      console.log(`  ✓ ${r.caseRef} (${r.name})`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${r.caseRef}: ${err.message}`);
      failed++;
    }
    await sleep(300);
  }
  console.log(`\nDone. Corrected: ${ok}  Failed: ${failed}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
