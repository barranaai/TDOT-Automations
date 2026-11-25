/**
 * One-off — the Client ID backfill (step 6, 2026-11-25; owner decision 2):
 * every past client gets ONE readable Client ID ("CL-2026-00042"), through a
 * check list that Gauri answers first. Who is one person, the buckets, the year
 * and the order are worked out in src/services/clientIdBackfillPlan.js (pure);
 * this file only reads the boards and writes.
 *
 *   node scripts/backfill-client-ids.js
 *       DRY RUN (the default). Reads the Clients board, Client Master and the Lead
 *       Board (100 a page, a pause between pages) and the counter file (read only).
 *       Writes NOTHING to Monday or OneDrive — only the check list:
 *       backfill-client-ids/client-ids-check-list-<stamp>.xlsx (People · Summary · Left out).
 *       The sheet holds names, emails and phones: an internal staff file — keep it off
 *       shared drives and delete it after the apply. The folder is git-ignored.
 *
 *   node scripts/backfill-client-ids.js --apply --decisions <answered.xlsx> \
 *        --admin <your ADMIN_EMAILS address> --automations-checked --confirm "GIVE <N> CLIENT IDS"
 *       APPLY. Refused unless: CLIENT_IDS is not 'on' ON THIS MACHINE, the Client ID
 *       columns are set up, the admin is on ADMIN_EMAILS, the answered sheet reads
 *       cleanly (every answer Y, N or blank), no "same person" group changed since the
 *       sheet was made, and the typed phrase names the number of new IDs (a wrong
 *       phrase prints the right one and stops before any write).
 *       The live server's switch cannot be seen from here, so before its first write the
 *       apply puts a LOCK in the Client ID counter file (clientIdAllocator.setBackfillLock):
 *       while it is there no server gives a number and the hourly check writes nothing,
 *       whatever their CLIENT_IDS says. The apply clears it at the end; after a crash, run
 *       the apply again (it resumes) or `--unlock --admin <you>`. --automations-checked says you looked:
 *       no Monday automation watches the "Client ID" columns, "Client account (system)"
 *       (text_mm5xmeka) or the Client relation (board_relation_mm5xd2bh) — review #16.
 *       Run it in a quiet window.
 *
 * What the apply does, person by person, in the check list's order:
 *   1. the client record: the one the person has, else made through findOrCreate —
 *      which looks for an exact match once more right before making the row (review #3);
 *   2. the Client ID on the Clients row: kept when there is one (NEVER renumbered),
 *      else the next number of a block reserved in one counter write (allocateBlock);
 *      the cell is read first and never written over a value, nor after a read that
 *      did not come back;
 *   3. the copies: each case (linkCase — its record id, the Client ID copy and the
 *      relation) and each consultation record (linkLead). A box that did not come
 *      back in the read is never written; a consultation record that points at
 *      ANOTHER client record is left alone.
 * The apply itself is src/services/clientIdBackfillRun.js — the same code the admin page
 * /admin/client-ids/backfill runs on the server (2026-11-25; the laptop has no Microsoft keys,
 * on purpose, so the real apply is run from that page, its files on OneDrive). Here it keeps its
 * checkpoint and log in the --out folder.
 * Every step is saved in a checkpoint (resume = run the same command again — the phrase
 * it was started with still counts, as long as no more people get a number than it said) and an
 * apply log (one JSON line per record made and per cell written — the rollback list:
 * archive, never delete). Safe to run again: what is done is skipped.
 *
 * Options: --out <dir> (default ./backfill-client-ids), --placeholder-names <n> (default 3).
 *
 *   node scripts/backfill-client-ids.js --unlock --admin <your ADMIN_EMAILS address>
 *       Only takes the backfill lock out of the counter file (after an apply that was stopped).
 *
 * Gauri may sort and filter the sheet: the numbers are read back from "Proposed ID", never
 * from the row order. A record findOrCreate finds that belongs to ANOTHER person of the check
 * list is never used for this one (the sheet kept them apart) — that person is left for the admin.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const planner = require('../src/services/clientIdBackfillPlan');
// The apply itself lives in src/services/clientIdBackfillRun.js — the SAME code the admin page
// /admin/client-ids/backfill runs on the server (2026-11-25): one implementation, one set of refusals.
const backfill = require('../src/services/clientIdBackfillRun');

const OUT_DEFAULT = path.join(__dirname, '..', 'backfill-client-ids');

const s = (v) => String(v == null ? '' : v).trim();
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const { torontoTime } = require('../src/utils/torontoTime');

/** --flag value / --flag → { flag: value|true } */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}

const confirmPhrase = backfill.confirmPhrase;

/* ───────────────────────────── the real I/O (never used by the tests) ───────────────────────────── */

function realIo() {
  require('dotenv').config();
  const allocator = require('../src/services/clientIdAllocator');
  return {
    ...backfill.mondayIo(),          // the boards, the record helpers, the Monday backoff (shared with the page)
    lockCounter: (by) => allocator.setBackfillLock({ by }),
    unlockCounter: () => allocator.clearBackfillLock(),
    fs,
    xlsx: () => require('xlsx'),
  };
}

/* ───────────────────────────── files ───────────────────────────── */

function writeWorkbook(io, file, plan, { madeAt, counter }) {
  const XLSX = io.xlsx();
  const sheet = (rows, widths, { filter = false } = {}) => {
    const ws = {};
    rows.forEach((r, ri) => r.forEach((v, ci) => { ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v == null ? '' : v).slice(0, 32000) }; }));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: cols - 1 } });
    if (widths) ws['!cols'] = widths.map((wch) => ({ wch }));
    if (filter) ws['!autofilter'] = { ref: ws['!ref'] };   // a filter button on every header
    return ws;
  };
  const wb = XLSX.utils.book_new();
  // "Summary" (how to answer) opens first; "People" has a filter on every column (ux review #2).
  XLSX.utils.book_append_sheet(wb, sheet(planner.summaryRows(plan, { madeAt, counter }), [32, 110]), 'Summary');
  XLSX.utils.book_append_sheet(wb, sheet([planner.SHEET_HEADERS, ...planner.sheetRows(plan)], planner.SHEET_HEADERS.map((h) => planner.SHEET_WIDTHS[h] || 16), { filter: true }), 'People');
  XLSX.utils.book_append_sheet(wb, sheet(planner.leftOutRows(plan), [26, 30, 18, 80]), 'Left out');
  io.fs.mkdirSync(path.dirname(file), { recursive: true });
  io.fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function readWorkbook(io, file) {
  return backfill.readSheetBuffer(io.xlsx(), io.fs.readFileSync(file));
}

/* ───────────────────────────── the run ───────────────────────────── */

/**
 * @param {{ argv?: string[], io?: object, log?: Function }} opts
 * @returns {Promise<{ ok: boolean, mode: 'dry-run'|'apply'|'unlock', reason?: string, message?: string, plan?: object, file?: string, done?: object }>}
 */
async function run({ argv = process.argv.slice(2), io = null, log = console.log } = {}) {
  const args = parseArgs(argv);
  const apply = !!args.apply;
  const x = io || realIo();
  const outDir = s(args.out) && args.out !== true ? path.resolve(String(args.out)) : OUT_DEFAULT;
  const refuse = (reason, message) => { log(`REFUSED — ${message}`); return { ok: false, mode: apply ? 'apply' : 'dry-run', reason, message }; };
  const arg = (k) => s(args[k] === true ? '' : args[k]);

  const cfg = x.loadBoard();
  if (!cfg) return refuse('dormant', 'src/data/clientsBoard.json is missing — there is no Clients board here.');
  const configured = backfill.configured(cfg);
  const placeholderNames = Number.isFinite(Number(args['placeholder-names'])) && args['placeholder-names'] !== true ? Number(args['placeholder-names']) : undefined;

  if (args.unlock) {
    const admin = arg('admin');
    if (!admin || !x.isAdminEmail(admin)) return refuse('not-admin', 'Name yourself with --admin <your address>; it must be on ADMIN_EMAILS.');
    const r = await x.unlockCounter();
    if (!r || !r.ok) return refuse('unlock', `The lock could not be taken out (${(r && r.message) || 'no answer'}).`);
    log(r.cleared ? 'The backfill lock is out of the counter file — the live app gives Client IDs again.' : 'There was no backfill lock in the counter file — nothing to do.');
    return { ok: true, mode: 'unlock', cleared: !!r.cleared };
  }

  let sheet = { decisions: null, order: [], proposed: null, problems: [] };
  if (apply) {
    log('Mode: APPLY (writes to Monday)');
    const g = backfill.guards(x, cfg, { admin: arg('admin'), decisionsGiven: !!arg('decisions'), automationsChecked: !!args['automations-checked'], via: 'script', log });
    if (g) return g;
    try { sheet = readWorkbook(x, path.resolve(String(args.decisions))); }
    catch (err) { return refuse('bad-decisions', `The answered check list cannot be read: ${err.message}`); }
    if (!sheet.order.length) return refuse('bad-decisions', 'The answered check list has no rows.');
    for (const p of sheet.problems) log(`  ! ${p}`);
  } else {
    log('Mode: DRY RUN (reads only — nothing is written to Monday or OneDrive; the check list is saved locally)');
    if (!configured) log('  ! The Client ID columns are not set up yet: every person counts as without an ID, and copies are not read.');
  }

  // ── read everything ──
  const ready = await backfill.readAndPlan(x, cfg, { decisions: sheet.decisions, order: sheet.order, proposed: sheet.proposed, placeholderNames, apply, log });
  if (!ready.ok) return { ...ready, mode: apply ? 'apply' : 'dry-run' };
  const { plan, now, counterText } = ready;
  const c = plan.counts;

  if (!apply) {
    const file = path.join(outDir, `client-ids-check-list-${stamp(now)}.xlsx`);
    writeWorkbook(x, file, plan, { madeAt: `${torontoTime(now)} (Toronto)`, counter: counterText });
    log(`Check list → ${file}`);
    log(`(Dry run. Gauri answers the ${c.amberQuestions} AMBER and ${c.buckets['NO-CASE']} NO-CASE rows; then run --apply with the answered file — or upload it on /admin/client-ids/backfill.)`);
    return { ok: true, mode: 'dry-run', plan, file };
  }

  // ── apply: the guards that need the plan, the lock, the writes (the shared implementation) ──
  return backfill.applyPlan({ x, store: backfill.fsStore(x.fs, outDir), cfg, ready, admin: arg('admin'), typed: arg('confirm'), via: 'script', log });
}

module.exports = { run, parseArgs, confirmPhrase, writeWorkbook, readWorkbook, OUT_DEFAULT };
if (require.main === module) {
  run().then((r) => { if (!r.ok) process.exitCode = 1; }).catch((err) => { console.error('Fatal:', err && err.message); process.exit(1); });
}
