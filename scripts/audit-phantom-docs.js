#!/usr/bin/env node
/**
 * Phantom-document audit (agreed at the 2026-08-13 meeting).
 *
 * A checklist row marked "Received" is staff's promise that the file is on
 * hand. One case in the week of Aug 3-10 showed a Canadian-education document
 * Received while the Academic folder was empty. This sweep answers, for every
 * Received row: is the file actually in the client's OneDrive, and where?
 *
 * READ-ONLY. Reads the Document Execution board (rows + their upload audit
 * comments) and asks the live app for each case's folder tree:
 *   GET /admin/onedrive/list?caseRef=<ref>&subfolder=*   (admin key)
 *
 * Every Received row lands in exactly one bucket:
 *   ok               - the file is in the folder the row's category names
 *   misfiled         - the file exists, but in another folder (the pre-2026-09-02
 *                      "General" bug; the re-filing sweep moves these)
 *   PHANTOM          - a client upload was recorded and the file is nowhere in
 *                      the case folder  <- the ones that matter
 *   no-upload-record - Received with no client-upload comment at all (status set
 *                      by hand, or an upload from before the audit comments)
 *   folder-missing   - the case folder does not resolve by "<client> - <ref>"
 *
 *   node scripts/audit-phantom-docs.js                  # everything
 *   node scripts/audit-phantom-docs.js --only 2026-SPE-013
 *   node scripts/audit-phantom-docs.js --out report.json
 * A JSON report is always written (--out, else ./phantom-docs-<timestamp>.json).
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const mondayApi = require('../src/services/mondayApi');
const { normFilename, uploadedFiles } = require('../src/services/documentRefileService');

const EXEC_BOARD_ID   = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF_COL    = 'text_mm0z2cck';
const STATUS_COL      = 'color_mm0zwgvr';   // Document Status: Missing / Received / ...
const CATEGORY_COL    = 'text_mm261tka';
const UPLOAD_DATE_COL = 'date_mm0zyw0m';
const UPDATES_LIMIT   = 30;

const argv = process.argv.slice(2);
const opt  = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = opt('--base', 'https://app.tdotimm.com').replace(/\/$/, '');
const OUT  = opt('--out', '') || `phantom-docs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const PACE = Number(opt('--pace', '250')) || 250;
const KEY  = process.env.ADMIN_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function receivedRows() {
  const rows = [];
  let cursor = null;
  do {
    const cols = `column_values(ids:["${CASE_REF_COL}","${STATUS_COL}","${CATEGORY_COL}","${UPLOAD_DATE_COL}"]) { id text }`;
    const q = cursor
      ? `query { next_items_page(limit:200, cursor:"${cursor}") { cursor items { id name ${cols} updates(limit:${UPDATES_LIMIT}){ text_body created_at } } } }`
      : `query { boards(ids:${EXEC_BOARD_ID}) { items_page(limit:200) { cursor items { id name ${cols} updates(limit:${UPDATES_LIMIT}){ text_body created_at } } } } }`;
    const d = await mondayApi.query(q);
    const ip = cursor ? d.next_items_page : d.boards[0].items_page;
    for (const it of ip.items || []) {
      const c = {}; for (const cv of it.column_values) c[cv.id] = (cv.text || '').trim();
      if (!/^received$/i.test(c[STATUS_COL] || '')) continue;
      rows.push({ id: String(it.id), doc: it.name, caseRef: c[CASE_REF_COL], category: c[CATEGORY_COL],
                  uploadDate: c[UPLOAD_DATE_COL], updates: (it.updates || []).map((u) => u.text_body || '') });
    }
    cursor = ip.cursor;
    if (cursor) await sleep(200);
  } while (cursor);
  return rows;
}

async function caseTree(caseRef) {
  const url = `${BASE}/admin/onedrive/list?caseRef=${encodeURIComponent(caseRef)}&subfolder=*`;
  for (let attempt = 0; ; attempt++) {
    let res, text;
    try {
      res = await fetch(url, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(120000) });
      text = await res.text();
    } catch (err) {
      if (attempt >= 2) return { error: err.message };
      await sleep(15000); continue;
    }
    let j = null; try { j = JSON.parse(text); } catch (_) { /* HTML error page */ }
    if (res.status === 401 || res.status === 403) { const e = new Error(`AUTH FAILURE ${res.status}`); e.abortRun = true; throw e; }
    if (res.ok && j) return j;
    if ((res.status === 503 || res.status === 429) && attempt < 2) { await sleep(20000); continue; }
    return { error: (j && j.error) || `HTTP ${res.status}`, status: res.status };
  }
}

(async () => {
  if (!KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }
  console.log(`Phantom-document audit (read-only) → ${BASE}\nReport → ${OUT}`);
  let rows = await receivedRows();
  if (ONLY.length) rows = rows.filter((r) => ONLY.includes(r.caseRef));
  const byCase = new Map();
  for (const r of rows) { if (!r.caseRef) continue; byCase.set(r.caseRef, [...(byCase.get(r.caseRef) || []), r]); }
  console.log(`rows marked Received: ${rows.length} across ${byCase.size} cases`);

  const report = { base: BASE, startedAt: new Date().toISOString(), cases: [], findings: [] };
  const tally = { cases: 0, rows: 0, ok: 0, misfiled: 0, phantom: 0, noUploadRecord: 0, folderMissing: 0, treeErrors: 0 };
  const save = () => fs.writeFileSync(OUT, JSON.stringify({ ...report, tally }, null, 2));

  const refs = [...byCase.keys()].sort();
  for (const [i, caseRef] of refs.entries()) {
    const caseRows = byCase.get(caseRef);
    const tree = await caseTree(caseRef);
    tally.cases++;
    if (tree.error) {
      tally.treeErrors++;
      report.cases.push({ caseRef, error: tree.error, rows: caseRows.length });
      console.log(`[${i + 1}/${refs.length}] ${caseRef}  TREE ERROR ${tree.error}`);
      save(); await sleep(PACE); continue;
    }
    // filename (normalised) -> folders it appears in
    const where = new Map();
    for (const f of tree.tree || []) for (const file of f.files || []) {
      const k = normFilename(file.name);
      where.set(k, [...(where.get(k) || []), f.folder]);
    }
    for (const file of tree.rootFiles || []) where.set(normFilename(file.name), [...(where.get(normFilename(file.name)) || []), '(case root)']);
    const folderMissing = !(tree.tree || []).length && !(tree.rootFiles || []).length;

    const outcomes = [];
    for (const row of caseRows) {
      tally.rows++;
      const files = uploadedFiles(row.updates).map((u) => u.file);
      if (folderMissing) { tally.folderMissing++; outcomes.push({ ...rowBrief(row), verdict: 'folder-missing' }); continue; }
      if (!files.length) { tally.noUploadRecord++; outcomes.push({ ...rowBrief(row), verdict: 'no-upload-record' }); continue; }
      // the row is satisfied if ANY file it recorded is present somewhere
      const found = files.map((f) => ({ file: f, folders: where.get(normFilename(f)) || [] })).filter((x) => x.folders.length);
      if (!found.length) {
        tally.phantom++;
        const v = { ...rowBrief(row), verdict: 'PHANTOM', recordedFiles: files };
        outcomes.push(v); report.findings.push({ caseRef, clientName: tree.clientName, ...v });
        continue;
      }
      const inCategory = found.some((x) => x.folders.some((fo) => fo === row.category));
      if (inCategory) { tally.ok++; outcomes.push({ ...rowBrief(row), verdict: 'ok' }); }
      else {
        tally.misfiled++;
        outcomes.push({ ...rowBrief(row), verdict: 'misfiled', foundIn: [...new Set(found.flatMap((x) => x.folders))] });
      }
    }
    report.cases.push({ caseRef, clientName: tree.clientName, folders: (tree.tree || []).length, rows: outcomes });
    const p = outcomes.filter((o) => o.verdict === 'PHANTOM').length;
    const m = outcomes.filter((o) => o.verdict === 'misfiled').length;
    const n = outcomes.filter((o) => o.verdict === 'no-upload-record').length;
    console.log(`[${i + 1}/${refs.length}] ${caseRef}  received:${outcomes.length}  ok:${outcomes.length - p - m - n}  misfiled:${m}  no-record:${n}${p ? `  *** PHANTOM:${p} ***` : ''}`);
    save(); await sleep(PACE);
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log('\nSummary:', JSON.stringify(tally, null, 2));
  if (report.findings.length) {
    console.log(`\nPHANTOM DOCUMENTS (${report.findings.length}) — marked Received, file not in the case folder:`);
    for (const f of report.findings) console.log(`  ${f.caseRef.padEnd(16)} ${String(f.clientName || '').padEnd(24)} ${f.doc}\n      recorded: ${f.recordedFiles.join(', ')}  (uploaded ${f.uploadDate || '—'})`);
  }
  console.log(`\nReport → ${OUT}`);
})().catch((err) => { console.error('FAILED:', err.stack || err.message); process.exit(err.abortRun ? 2 : 1); });

function rowBrief(row) { return { rowId: row.id, doc: row.doc, category: row.category, uploadDate: row.uploadDate }; }
