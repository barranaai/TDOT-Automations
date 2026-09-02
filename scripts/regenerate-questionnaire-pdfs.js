#!/usr/bin/env node
/**
 * One-time questionnaire PDF regeneration (layout refresh, 2026-09-02).
 *
 * Enumerates Client Master cases (Monday, READ-ONLY: case ref, Q Completion
 * Status, and the item's Updates — the submission audit comments) and asks the
 * LIVE app to regenerate each case's saved-form PDFs:
 *   POST /admin/questionnaire/:caseRef/regenerate-pdfs   (admin key)
 * The app does the OneDrive work with its own credentials; this script only
 * reads Monday and drives the loop. Dry-run unless --write.
 *
 *   node scripts/regenerate-questionnaire-pdfs.js                        # dry-run, every case
 *   node scripts/regenerate-questionnaire-pdfs.js --only 2026-ISS-009    # one (or comma-separated) case(s)
 *   node scripts/regenerate-questionnaire-pdfs.js --write --out report.json
 *   --create-missing      also create PDFs for answered forms that have none (default: refresh existing only)
 *   --base <url>          default https://app.tdotimm.com       --pace <ms>  between cases (default 250)
 * A JSON report is ALWAYS written (--out, else ./regen-report-<mode>-<timestamp>.json), per case as it goes.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const mondayApi = require('../src/services/mondayApi');

const CM_BOARD_ID      = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const CASE_REF_COL     = 'text_mm142s49';
const Q_COMPLETION_COL = 'color_mm0x9s08';   // labels: Done / Working on it
const UPDATES_LIMIT    = 100;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt  = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const WRITE          = flag('--write');
const CREATE_MISSING = flag('--create-missing');
const ONLY  = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const BASE  = opt('--base', 'https://app.tdotimm.com').replace(/\/$/, '');
const OUT   = opt('--out', '') || `regen-report-${WRITE ? 'write' : 'dry-run'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const PACE  = Number(opt('--pace', '250')) || 250;
const KEY   = process.env.ADMIN_API_KEY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllCases() {
  const rows = [];
  let cursor = null;
  do {
    const fields = `id name column_values(ids:["${CASE_REF_COL}","${Q_COMPLETION_COL}"]) { id text } updates(limit: ${UPDATES_LIMIT}) { text_body body created_at }`;
    const q = cursor
      ? `query { next_items_page(limit:100, cursor:"${cursor}") { cursor items { ${fields} } } }`
      : `query { boards(ids:${CM_BOARD_ID}) { items_page(limit:100) { cursor items { ${fields} } } } }`;
    const data = await mondayApi.query(q);
    const ip = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const it of (ip.items || [])) {
      const cv = {};
      for (const c of it.column_values) cv[c.id] = (c.text || '').trim();
      const rawUpdates = it.updates || [];
      const updates = rawUpdates
        .map((u) => ({ body: u.text_body || u.body || '', createdAt: u.created_at || null }))
        .filter((u) => /Questionnaire Submitted/i.test(u.body));
      rows.push({ id: it.id, name: it.name, caseRef: cv[CASE_REF_COL], qStatus: cv[Q_COMPLETION_COL], updates, updatesTruncated: rawUpdates.length >= UPDATES_LIMIT });
    }
    cursor = ip.cursor;
    if (cursor) await sleep(300);
  } while (cursor);
  return rows;
}

// Retry ONLY transient outcomes (503 / 429 / body.transient / network), with
// long waits — Graph throttling needs breathing room, not a fast retry storm.
// A partial 503 carries the per-form results: forms already regenerated are
// passed back as skipKeys so a retry never re-uploads them. A CLIENT-SIDE
// timeout is NOT retried (the server may still be running that case).
const TRANSIENT_WAITS = [30000, 60000, 120000];
async function callCase(row) {
  const url = `${BASE}/admin/questionnaire/${encodeURIComponent(row.caseRef)}/regenerate-pdfs`;
  const done = new Map(); // formKey → form result already regenerated in an earlier attempt
  for (let attempt = 0; ; attempt++) {
    const body = JSON.stringify({ dryRun: !WRITE, qCompletionStatus: row.qStatus, updates: row.updates, updatesTruncated: row.updatesTruncated, createMissing: CREATE_MISSING, skipKeys: [...done.keys()] });
    let res, text;
    try {
      res  = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body, signal: AbortSignal.timeout(180000) });
      text = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { status: 0, body: { error: 'client timeout after 180s — the server may still be processing this case; re-run with --only later', forms: [...done.values()] }, transient: false };
      }
      if (attempt >= TRANSIENT_WAITS.length) return { status: 0, body: { error: err.message, forms: [...done.values()] }, transient: true };
      console.log(`   network error (${err.message}) — waiting ${TRANSIENT_WAITS[attempt] / 1000}s`);
      await sleep(TRANSIENT_WAITS[attempt]); continue;
    }
    let json = null; try { json = JSON.parse(text); } catch (_) { /* HTML error page */ }
    if (res.status === 401 || res.status === 403) { const e = new Error(`AUTH FAILURE ${res.status}: ${text.slice(0, 200)} — check ADMIN_API_KEY in .env`); e.abortRun = 'auth-failure'; throw e; }
    const merge = (b) => {
      if (!b || !Array.isArray(b.forms)) return b;
      // replace 'skipped-by-caller' placeholders with the earlier attempt's real results
      return { ...b, forms: b.forms.map((f) => (f.reason === 'skipped-by-caller' && done.has(f.formKey)) ? done.get(f.formKey) : f) };
    };
    if (res.ok) return { status: res.status, body: merge(json), transient: false };
    const transient = res.status === 503 || res.status === 429 || Boolean(json && json.transient);
    if (json && Array.isArray(json.forms)) for (const f of json.forms) if (f.action === 'regenerated') done.set(f.formKey, f);
    if (!transient || attempt >= TRANSIENT_WAITS.length) return { status: res.status, body: merge(json) || { error: text.slice(0, 200), forms: [...done.values()] }, transient };
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait = Math.max(TRANSIENT_WAITS[attempt], Number.isFinite(retryAfter) ? retryAfter : 0);
    console.log(`   transient ${res.status} — waiting ${wait / 1000}s${done.size ? ` (${done.size} form(s) already done will be skipped)` : ''}`);
    await sleep(wait);
  }
}

const report = { mode: WRITE ? 'write' : 'dry-run', createMissing: CREATE_MISSING, base: BASE, startedAt: new Date().toISOString(), duplicates: [], cases: [], aborted: null };
const tally  = { cases: 0, forms: 0, regenerated: 0, wouldRegenerate: 0, failed: 0, skipped: {}, via: {}, errors: 0, noForms: 0, submittedPdfs: 0, draftPdfs: 0, parseMiss: 0, updatesTruncated: 0 };
const save   = () => fs.writeFileSync(OUT, JSON.stringify({ ...report, tally }, null, 2));

(async () => {
  if (!KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }
  console.log(`${WRITE ? '*** WRITE MODE ***' : 'dry-run'} → ${BASE}${CREATE_MISSING ? '  (+create-missing)' : ''}\nReport → ${OUT}`);
  const all = await fetchAllCases();
  const withRef = all.filter((r) => r.caseRef);

  // A case ref must be unique — a duplicated ref is skipped (which row is "the" case is a human call).
  const byRef = new Map();
  for (const r of withRef) byRef.set(r.caseRef, [...(byRef.get(r.caseRef) || []), r]);
  report.duplicates = [...byRef.entries()].filter(([, rows]) => rows.length > 1).map(([ref, rows]) => ({ caseRef: ref, rows: rows.map((x) => ({ id: x.id, name: x.name, qStatus: x.qStatus })) }));
  let cases = [...byRef.entries()].filter(([, rows]) => rows.length === 1).map(([, rows]) => rows[0]);
  if (ONLY.length) cases = cases.filter((r) => ONLY.includes(r.caseRef));
  console.log(`Client Master rows: ${all.length}; with a case ref: ${withRef.length}; duplicated refs skipped: ${report.duplicates.length}; selected: ${cases.length}`);
  for (const d of report.duplicates) console.log(`   DUPLICATE ref ${d.caseRef}: ${d.rows.map((x) => `${x.name} (#${x.id})`).join(' | ')}`);

  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
  let consecutiveFailures = 0;

  for (const [i, row] of cases.entries()) {
    const r = await callCase(row);
    const body = r.body || {};
    const forms = Array.isArray(body.forms) ? body.forms : [];
    report.cases.push({ caseRef: row.caseRef, name: row.name, qStatus: row.qStatus, comments: row.updates.length, updatesTruncated: row.updatesTruncated, status: r.status, result: body });
    tally.cases++;
    if (row.updatesTruncated) tally.updatesTruncated++;
    if (r.status !== 200) {
      tally.errors++; consecutiveFailures++;
      console.log(`[${i + 1}/${cases.length}] ${row.caseRef}  ERROR ${r.status} ${body.error || ''}${forms.length ? ` (${forms.length} form result(s) kept)` : ''}`);
      if (consecutiveFailures >= 5) { report.aborted = 'consecutive-failures'; console.error('\n5 consecutive failures — aborting so a systemic problem does not run across the portfolio.'); save(); break; }
    } else {
      consecutiveFailures = 0;
      if (!forms.length) tally.noForms++;
      // Parse-health: comments exist for this case but none parsed as submission evidence → the comment format assumption may be wrong.
      if (row.updates.length > 0 && body.evidence && body.evidence.exact.length === 0 && body.evidence.batches === 0) { tally.parseMiss++; console.log(`   PARSE-MISS: ${row.updates.length} "Questionnaire Submitted" comment(s) but no evidence parsed`); }
    }
    for (const f of forms) {
      tally.forms++;
      if (f.action === 'regenerated') { tally.regenerated++; bump(tally.via, f.submittedVia); f.submitted ? tally.submittedPdfs++ : tally.draftPdfs++; }
      else if (f.action === 'would-regenerate') { tally.wouldRegenerate++; bump(tally.via, f.submittedVia); f.submitted ? tally.submittedPdfs++ : tally.draftPdfs++; }
      else if (f.action === 'failed') tally.failed++;
      else bump(tally.skipped, f.reason + (f.reason === 'status-uncertain' && f.submittedVia ? ':' + f.submittedVia : ''));
    }
    if (r.status === 200) {
      const summary = forms.map((f) => `${f.formKey}:${f.action === 'skipped' ? 'skip(' + f.reason + (f.submittedVia && f.reason === 'status-uncertain' ? ':' + f.submittedVia : '') + ')' : f.action === 'failed' ? 'FAILED' : (f.submitted ? 'submitted' : 'draft') + '/' + f.submittedVia + (f.bytes ? ' ' + Math.round(f.bytes / 1024) + 'KB' : '')}`).join(', ');
      console.log(`[${i + 1}/${cases.length}] ${row.caseRef}  ${forms.length ? summary : '(no saved forms)'}`);
    }
    save();
    await sleep(PACE);
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log('\nSummary:', JSON.stringify(tally, null, 2));
  console.log(`Report → ${OUT}`);
})().catch((err) => {
  report.aborted = err.abortRun || 'crash'; report.error = err.message;
  try { save(); } catch (_) { /* nothing more to do */ }
  console.error('FAILED:', err.stack || err.message);
  process.exit(err.abortRun ? 2 : 1);
});
