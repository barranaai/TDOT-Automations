#!/usr/bin/env node
/**
 * One-off reconcile of the Client Master questionnaire columns with the
 * saved answers (Gauri, 2026-09-04 meeting, point 01).
 *
 * Until 2026-09-08 "Q Readiness" (%) and "Q Completion Status" were written
 * only when the client clicked Submit, and a single-applicant submission
 * below 100% stayed "Working on it". The code now syncs progress on every
 * save and marks a submission Done; this script brings the EXISTING rows
 * in line, using the same derivation the portal/cockpit/board use:
 *
 *   GET /admin/questionnaire/:caseRef/progress   (live app, admin key)
 *     → members[] with submittedAt / hasData / hasAdditionalData /
 *       completionPct, derived pct, submitted (every member), and the
 *       current Monday columns.
 *
 * Rules (one write per row at most; nothing else is touched):
 *   DONE      every member submitted AND status ≠ Done
 *             → Q Completion Status = Done (+ Q Readiness = derived % when blank)
 *   WORKING   not submitted AND the client has saved answers AND status blank
 *             → Q Completion Status = Working on it, Q Readiness = derived %
 *   PCT-ONLY  not submitted AND saved answers AND status already "Working on it"
 *             but Q Readiness blank → Q Readiness = derived % (status untouched)
 *   (skip)    everything else — Done rows, rows already carrying a %, prefill-only
 *             seeds, cases with no saved answers, cases whose files cannot be read.
 *
 * Unlike scripts/backfill-q-completion-status.js (which trusted a
 * "Questionnaire Submitted" comment), this reads the member manifest, so a
 * partially-submitted multi-member case is NOT flipped to Done.
 *
 *   node scripts/reconcile-q-progress.js                 # dry run (default)
 *   node scripts/reconcile-q-progress.js --only 2026-OINP-041,2026-VRE-029
 *   node scripts/reconcile-q-progress.js --write         # apply
 *   node scripts/reconcile-q-progress.js --write --no-audit   # apply without the audit comment
 * A JSON report is always written (--out, else ./q-progress-reconcile-<timestamp>.json),
 * including on an aborted run.
 */
'use strict';

require('dotenv').config();   // before the constants — harmless when required from a test
// The same board the app itself writes to — the script can never target a different one.
const CM_BOARD_ID    = require('../config/monday').clientMasterBoardId || process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const CASE_REF_COL   = 'text_mm142s49';
const Q_STATUS_COL   = 'color_mm0x9s08';   // Done / Working on it
const Q_READY_COL    = 'numeric_mm0x9dea';
const STAGE_COL      = 'color_mm0x8faa';

// Same shape the questionnaire routes accept (routes/htmlQuestionnaireForm.js sanitiseCaseRef keeps [A-Za-z0-9_-]).
const refOk = (s) => /^[A-Za-z0-9_-]{3,40}$/.test(String(s || '').trim());

/** The progress endpoint's JSON, validated — anything else is "unreadable". */
function validProgress(p) {
  return !!p && !p.error && Array.isArray(p.members) && typeof p.submitted === 'boolean' && Number.isFinite(Number(p.pct));
}

/**
 * Pure decision for one row. `row` = { status, pct (text), ... } from Monday,
 * `p` = the progress endpoint's JSON (or { error }).
 */
function decide(row, p) {
  if (p && p.error) return { action: 'skip', why: `progress unreadable: ${p.error}` };
  if (!validProgress(p)) return { action: 'skip', why: 'progress unreadable: unexpected response shape' };
  const started = p.members.filter((m) => m.hasData || m.hasAdditionalData).length;
  const pct = Math.max(0, Math.min(100, Math.round(Number(p.pct))));
  if (p.submitted) {
    if (row.status === 'Done') return { action: 'skip', why: 'already Done' };
    const cols = { [Q_STATUS_COL]: { label: 'Done' } };
    if (row.pct === '') cols[Q_READY_COL] = pct;
    return { action: 'done', cols, why: `every member submitted (${p.members.map((m) => `${m.label}: ${m.completionPct}%`).join(', ')})` };
  }
  if (!started) return { action: 'skip', why: 'no client answers saved' };
  // Pre-JSON files (plain array / CSV era) carry no stored %: stamping 0%
  // beside "answers saved" would mislead — leave them for the client's next save.
  if (pct === 0) return { action: 'skip', why: 'answers saved but no stored % (legacy file format) — the next client save will sync it' };
  if (row.status === '') {
    return { action: 'working', cols: { [Q_STATUS_COL]: { label: 'Working on it' }, [Q_READY_COL]: pct }, why: `answers saved, ${pct}% (${started} of ${p.members.length} member file(s) started)` };
  }
  if (row.status === 'Working on it' && row.pct === '') {
    return { action: 'pct', cols: { [Q_READY_COL]: pct }, why: `status already Working on it but no %; answers saved, ${pct}%` };
  }
  return { action: 'skip', why: `status already "${row.status}" (${row.pct === '' ? 'no %' : row.pct + '%'})` };
}

/** Audit comment for a write — built from what was actually decided. */
function auditBody(row, d, p, today) {
  const prev = row.status === '' ? 'blank' : `"${row.status}"`;
  const n = p.members.length;
  if (d.action === 'done') {
    const single = n === 1 && row.status === 'Working on it';
    return `🛠 Q Completion Status set to Done (reconcile)\n\nCase: ${row.caseRef}\nPrevious status: ${prev} · ${n} member${n === 1 ? '' : 's'}, all submitted.\n` +
      (single
        ? 'The old rule kept a single-applicant submission below 100% on "Working on it"; the 80% submission gate is the authoritative threshold.'
        : 'The submission was recorded in the questionnaire files but the board status had not caught up.') +
      `\nReconciled on ${today}.`;
  }
  if (d.action === 'working') {
    return `🛠 Questionnaire progress stamped (reconcile)\n\nCase: ${row.caseRef}\nThe client had saved answers (${d.cols[Q_READY_COL]}%) but the board still read blank — progress used to reach Monday only at Submit. From now on every save updates Q Readiness and Q Completion Status automatically.\nReconciled on ${today}.`;
  }
  return `🛠 Q Readiness filled in (reconcile)\n\nCase: ${row.caseRef}\nStatus was already "Working on it" with no percentage; the saved answers put it at ${d.cols[Q_READY_COL]}%.\nReconciled on ${today}.`;
}

module.exports = { decide, refOk, validProgress, auditBody, Q_STATUS_COL, Q_READY_COL };

if (require.main === module) {
  const fs = require('fs');
  const mondayApi = require('../src/services/mondayApi');

  const argv  = process.argv.slice(2);
  const opt   = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
  const WRITE = argv.includes('--write');
  const AUDIT = !argv.includes('--no-audit');
  const ONLY  = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
  const BASE  = opt('--base', 'https://app.tdotimm.com').replace(/\/$/, '');
  const OUT   = opt('--out', '') || `q-progress-reconcile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const PACE  = Number(opt('--pace', '250')) || 250;
  const KEY   = process.env.ADMIN_API_KEY || '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = new Date().toISOString().split('T')[0];

  async function fetchRows() {
    const rows = [];
    let cursor = null;
    do {
      const cols = `column_values(ids:["${CASE_REF_COL}","${Q_STATUS_COL}","${Q_READY_COL}","${STAGE_COL}"]) { id text }`;
      const q = cursor
        ? `query { next_items_page(limit:200, cursor:"${cursor}") { cursor items { id name ${cols} } } }`
        : `query { boards(ids:${CM_BOARD_ID}) { items_page(limit:200) { cursor items { id name ${cols} } } } }`;
      const d  = await mondayApi.query(q);
      const ip = cursor ? d.next_items_page : d.boards[0].items_page;
      for (const it of ip.items || []) {
        const c = {}; for (const cv of it.column_values) c[cv.id] = (cv.text || '').trim();
        rows.push({ id: String(it.id), name: it.name, caseRef: c[CASE_REF_COL], status: c[Q_STATUS_COL], pct: c[Q_READY_COL], stage: c[STAGE_COL] });
      }
      cursor = ip.cursor;
      if (cursor) await sleep(200);
    } while (cursor);
    return rows;
  }

  async function progressFor(caseRef) {
    const url = `${BASE}/admin/questionnaire/${encodeURIComponent(caseRef)}/progress`;
    for (let attempt = 0; ; attempt++) {
      let res, text;
      try {
        res  = await fetch(url, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(90000) });
        text = await res.text();
      } catch (err) {
        if (attempt >= 2) return { error: err.message };
        await sleep(10000); continue;
      }
      if (res.status === 401 || res.status === 403) { const e = new Error(`AUTH FAILURE ${res.status}`); e.abortRun = true; throw e; }
      let j = null; try { j = JSON.parse(text); } catch (_) { /* HTML error page */ }
      if (res.ok && j) return j;
      if ((res.status === 503 || res.status === 429) && attempt < 2) { await sleep(15000); continue; }
      return { error: (j && j.error) || `HTTP ${res.status}`, status: res.status };
    }
  }

  async function apply(row, d, p) {
    await mondayApi.query(
      `mutation($itemId: ID!, $cols: JSON!) {
         change_multiple_column_values(board_id: ${CM_BOARD_ID}, item_id: $itemId, column_values: $cols) { id }
       }`,
      { itemId: row.id, cols: JSON.stringify(d.cols) }
    );
    if (!AUDIT) return;
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: row.id, body: auditBody(row, d, p, today) }
    );
  }

  const report = { base: BASE, write: WRITE, startedAt: new Date().toISOString(), skippedRefs: [], rows: [] };
  const tally  = { done: 0, working: 0, pct: 0, skip: 0, applied: 0, failed: 0 };
  const save   = () => { try { fs.writeFileSync(OUT, JSON.stringify({ ...report, tally }, null, 2)); } catch (e) { console.error(`report write failed: ${e.message}`); } };

  (async () => {
    if (!KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }
    console.log(`Questionnaire progress reconcile — ${WRITE ? '✏  WRITE' : '🔍 DRY RUN'}${AUDIT ? '' : ' (no audit comments)'} → ${BASE}\nReport → ${OUT}\n`);
    const all = await fetchRows();
    report.skippedRefs = all.filter((r) => r.caseRef && !refOk(r.caseRef)).map((r) => ({ id: r.id, caseRef: r.caseRef }));
    let rows = all.filter((r) => refOk(r.caseRef));
    if (ONLY.length) rows = rows.filter((r) => ONLY.includes(r.caseRef));
    console.log(`Client Master rows with a usable case reference: ${rows.length}` + (report.skippedRefs.length ? ` (${report.skippedRefs.length} odd-shaped refs listed in the report, not examined)` : ''));

    for (const [i, row] of rows.entries()) {
      const p = await progressFor(row.caseRef);
      const d = decide(row, p);
      tally[d.action]++;
      const entry = { ...row, decision: d.action, why: d.why, cols: d.cols || null, derived: validProgress(p) ? { pct: p.pct, label: p.label, submitted: p.submitted } : null };
      if (d.action !== 'skip') {
        console.log(`[${i + 1}/${rows.length}] ${row.caseRef.padEnd(18)} ${d.action.toUpperCase().padEnd(8)} status="${row.status}" pct=${row.pct || '—'} stage=${row.stage || '—'}  ← ${d.why}`);
        if (WRITE) {
          try { await apply(row, d, p); tally.applied++; entry.applied = true; }
          catch (err) { tally.failed++; entry.error = err.message; console.error(`   ✗ ${row.caseRef}: ${err.message}`); }
          await sleep(300);
        }
      }
      report.rows.push(entry);
      if (d.action !== 'skip' || i % 25 === 0) save();
      await sleep(PACE);
    }
    report.finishedAt = new Date().toISOString(); save();
    console.log(`\nSummary: set Done ${tally.done} · set Working on it ${tally.working} · % only ${tally.pct} · untouched ${tally.skip}` + (WRITE ? ` · applied ${tally.applied} · failed ${tally.failed}` : '') + `\nReport → ${OUT}`);
    if (!WRITE && (tally.done || tally.working || tally.pct)) console.log('(Dry run. Re-run with --write to apply.)');
  })().catch((err) => { save(); console.error('FAILED:', err.stack || err.message); process.exit(err.abortRun ? 2 : 1); });
}
