#!/usr/bin/env node
/**
 * Re-file client uploads that landed in OneDrive "General" (pre-2026-09-02
 * bug) into their category folders. Finds the affected cases on the Document
 * Execution board (READ-ONLY: rows with an upload date), then asks the LIVE
 * app per case:  POST /admin/onedrive/refile-general  (admin key)
 * The app maps each General file to its checklist row via the upload audit
 * comment and moves it (never deletes). Dry-run unless --write --yes.
 *
 *   node scripts/refile-general-uploads.js                       # dry-run plan, every affected case
 *   node scripts/refile-general-uploads.js --only 2026-SPE-013   # explicit case(s) — no discovery
 *   node scripts/refile-general-uploads.js --write --yes --out report.json
 * A JSON report is ALWAYS written (--out, else ./refile-report-<mode>-<timestamp>.json).
 * NOTE: the sweep moves files only. Each row's "Document Folder" link and the
 * old upload comment still say General until the row's next upload re-points
 * the link (documentFormService) — the report lists every move for reference.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const mondayApi = require('../src/services/mondayApi');

const EXEC_BOARD_ID   = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF_COL    = 'text_mm0z2cck';
const UPLOAD_DATE_COL = 'date_mm0zyw0m';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt  = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const WRITE = flag('--write');
const YES   = flag('--yes');
const ONLY  = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const BASE  = opt('--base', 'https://app.tdotimm.com').replace(/\/$/, '');
const OUT   = opt('--out', '') || `refile-report-${WRITE ? 'write' : 'dry-run'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const PACE  = Number(opt('--pace', '400')) || 400;
const KEY   = process.env.ADMIN_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function casesWithUploads() {
  const refs = new Set();
  let cursor = null;
  do {
    const cols = `column_values(ids:["${CASE_REF_COL}","${UPLOAD_DATE_COL}"]) { id text }`;
    const q = cursor
      ? `query { next_items_page(limit:500, cursor:"${cursor}") { cursor items { id ${cols} } } }`
      : `query { boards(ids:${EXEC_BOARD_ID}) { items_page(limit:500) { cursor items { id ${cols} } } } }`;
    const data = await mondayApi.query(q);
    const ip = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const it of ip.items || []) {
      const c = {}; for (const cv of it.column_values) c[cv.id] = (cv.text || '').trim();
      if (c[CASE_REF_COL] && c[UPLOAD_DATE_COL]) refs.add(c[CASE_REF_COL]);
    }
    cursor = ip.cursor;
    if (cursor) await sleep(250);
  } while (cursor);
  return [...refs].sort();
}

// Retry only transient outcomes, with long waits. Results are ACCUMULATED across
// attempts (a partial 503 still carries the moves that succeeded); a client-side
// timeout is not retried (the server may still be moving files for this case).
const TRANSIENT_WAITS = [30000, 60000, 120000];
async function callCase(caseRef) {
  const url = `${BASE}/admin/onedrive/refile-general`;
  const acc = { moved: [], failed: [], attempts: 0 };
  for (let attempt = 0; ; attempt++) {
    acc.attempts++;
    let res, text;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ caseRef, dryRun: !WRITE }), signal: AbortSignal.timeout(300000) });
      text = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { status: 0, body: { error: 'client timeout — the server may still be moving files for this case; re-run --only later (dry-run first)', moved: acc.moved, failed: acc.failed }, partial: acc.moved.length > 0 };
      if (attempt >= TRANSIENT_WAITS.length) return { status: 0, body: { error: err.message, moved: acc.moved, failed: acc.failed }, partial: acc.moved.length > 0 };
      await sleep(TRANSIENT_WAITS[attempt]); continue;
    }
    let json = null; try { json = JSON.parse(text); } catch (_) { /* HTML error page */ }
    if (res.status === 401 || res.status === 403) { const e = new Error(`AUTH FAILURE ${res.status}: ${text.slice(0, 200)}`); e.abortRun = 'auth-failure'; throw e; }
    if (json && Array.isArray(json.moved)) acc.moved.push(...json.moved);
    if (json && Array.isArray(json.failed)) acc.failed.push(...json.failed.filter((f) => !f.transient));   // transient failures get retried
    const merged = json ? { ...json, moved: acc.moved, failed: acc.failed, attempts: acc.attempts } : null;
    if (res.ok) return { status: res.status, body: merged, partial: false };
    const transient = res.status === 503 || res.status === 429 || Boolean(json && json.transient);
    if (!transient || attempt >= TRANSIENT_WAITS.length) return { status: res.status, body: merged || { error: text.slice(0, 200), moved: acc.moved, failed: acc.failed }, partial: acc.moved.length > 0 };
    console.log(`   transient ${res.status} — waiting ${TRANSIENT_WAITS[attempt] / 1000}s (${acc.moved.length} moved so far)`);
    await sleep(TRANSIENT_WAITS[attempt]);
  }
}

const report = { mode: WRITE ? 'write' : 'dry-run', base: BASE, startedAt: new Date().toISOString(), cases: [], aborted: null };
const tally  = { cases: 0, generalFiles: 0, planned: 0, moved: 0, renamed: 0, failed: 0, notAttempted: 0, unmapped: 0, ambiguous: 0, stays: 0, folderMissing: 0, evidenceTruncated: 0, errors: 0, byTarget: {} };
const save   = () => fs.writeFileSync(OUT, JSON.stringify({ ...report, tally }, null, 2));

(async () => {
  if (!KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }
  if (WRITE && !YES) { console.error('--write moves client files in production OneDrive: add --yes to confirm (dry-run first).'); process.exit(2); }
  console.log(`${WRITE ? '*** WRITE MODE ***' : 'dry-run'} → ${BASE}\nReport → ${OUT}`);
  let cases;
  if (ONLY.length) { cases = ONLY; console.log(`explicit cases: ${cases.join(', ')}`); }
  else { cases = await casesWithUploads(); console.log(`cases with uploads: ${cases.length}`); }
  let consecutiveFailures = 0;
  for (const [i, caseRef] of cases.entries()) {
    const r = await callCase(caseRef);
    const b = r.body || {};
    report.cases.push({ caseRef, status: r.status, partial: r.partial, result: b });
    tally.cases++;
    const hasPlan = Boolean(b.plan);
    if (hasPlan) {
      tally.generalFiles += b.generalCount; tally.planned += b.plan.moves.length;
      tally.unmapped += b.plan.unmapped.length; tally.ambiguous += b.plan.ambiguous.length; tally.stays += b.plan.stays.length;
      if (b.caseFolderFound === false) tally.folderMissing++;
      if (b.evidenceTruncated) tally.evidenceTruncated++;
      for (const m of b.plan.moves) tally.byTarget[m.to] = (tally.byTarget[m.to] || 0) + 1;
      tally.notAttempted += (b.notAttempted || []).length;
    }
    tally.moved += (b.moved || []).length; tally.renamed += (b.moved || []).filter((m) => m.renamed).length; tally.failed += (b.failed || []).length;
    if (r.status !== 200 && !r.partial) {
      tally.errors++; consecutiveFailures++;
      console.log(`[${i + 1}/${cases.length}] ${caseRef}  ERROR ${r.status} ${b.error || ''}`);
      if (consecutiveFailures >= 5) { report.aborted = 'consecutive-failures'; save(); break; }
    } else {
      consecutiveFailures = 0;
      if (r.status !== 200) { tally.errors++; console.log(`[${i + 1}/${cases.length}] ${caseRef}  PARTIAL ${r.status}: ${(b.moved || []).length} moved, ${b.error || ''}`); }
      else if (b.caseFolderFound === false) console.log(`[${i + 1}/${cases.length}] ${caseRef}  case folder NOT FOUND by name (${b.clientName})`);
      else if (b.generalCount) console.log(`[${i + 1}/${cases.length}] ${caseRef}  General:${b.generalCount}  ${WRITE ? 'moved' : 'plan'}:${WRITE ? (b.moved || []).length : b.plan.moves.length}  unmapped:${b.plan.unmapped.length}  ambiguous:${b.plan.ambiguous.length}  stays:${b.plan.stays.length}${b.evidenceTruncated ? '  EVIDENCE-TRUNCATED' : ''}${(b.failed || []).length ? '  FAILED:' + b.failed.length : ''}`);
    }
    save();
    await sleep(PACE);
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log('\nSummary:', JSON.stringify(tally, null, 2));
  console.log(`Report → ${OUT}`);
})().catch((err) => { report.aborted = err.abortRun || 'crash'; report.error = err.message; try { save(); } catch (_) { /* */ } console.error('FAILED:', err.stack || err.message); process.exit(err.abortRun ? 2 : 1); });
