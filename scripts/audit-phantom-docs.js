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
 *   renamed          - the recorded name is gone, but the case folder holds at
 *                      least as many client files as unmatched rows: staff
 *                      reorganised into their own folders ("++prepration",
 *                      "<client> - EE final", "Apply Online", ...) and renamed
 *                      as they went. Filename matching cannot see through that.
 *   PHANTOM          - the recorded name is gone AND the case folder holds fewer
 *                      client files than unmatched rows  <- the ones to look at
 *   no-upload-record - Received with no client-upload comment at all (status set
 *                      by hand, or an upload from before the audit comments)
 *   folder-missing   - the case folder does not resolve by "<client> - <ref>"
 *
 * The renamed/PHANTOM split matters: staff routinely rename and re-file
 * documents while preparing a submission, so a missing FILENAME is not a
 * missing DOCUMENT. Only a case that is short of files is worth chasing.
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
// Folders the system creates per category; anything else with files in it was made by staff.
const CATEGORY_FOLDERS = new Set(['General', 'Identity', 'Academic', 'Financial', 'Background', 'Relationship',
  'Medical', 'Other', 'Forms', 'Travel', 'Legal', 'Employment', 'Supporting', 'Personal']);

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
  const tally = { cases: 0, rows: 0, ok: 0, misfiled: 0, renamed: 0, phantom: 0, noUploadRecord: 0, folderMissing: 0, treeErrors: 0 };
  const SYSTEM_FOLDERS = new Set(['Questionnaire', 'Retainer']);   // ours, not the client's documents
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
      if (!found.length) { outcomes.push({ ...rowBrief(row), verdict: 'unmatched', recordedFiles: files }); continue; }
      const inCategory = found.some((x) => x.folders.some((fo) => fo === row.category));
      if (inCategory) { tally.ok++; outcomes.push({ ...rowBrief(row), verdict: 'ok' }); }
      else {
        tally.misfiled++;
        outcomes.push({ ...rowBrief(row), verdict: 'misfiled', foundIn: [...new Set(found.flatMap((x) => x.folders))] });
      }
    }
    // A recorded name that is gone is only a MISSING DOCUMENT if the case is
    // actually short of files; otherwise staff renamed it while preparing.
    const unmatched = outcomes.filter((o) => o.verdict === 'unmatched');
    const clientFiles = (tree.tree || []).filter((f) => !SYSTEM_FOLDERS.has(f.folder)).reduce((n, f) => n + f.files.length, 0) + (tree.rootFiles || []).length;
    const staffFolders = (tree.tree || []).filter((f) => !SYSTEM_FOLDERS.has(f.folder) && !CATEGORY_FOLDERS.has(f.folder) && f.files.length).map((f) => `${f.folder} (${f.files.length})`);
    const shortOfFiles = clientFiles < unmatched.length;
    for (const o of unmatched) {
      o.verdict = shortOfFiles ? 'PHANTOM' : 'renamed';
      o.clientFilesInCase = clientFiles;
      if (shortOfFiles) { tally.phantom++; report.findings.push({ caseRef, clientName: tree.clientName, clientFiles, staffFolders, ...o }); }
      else tally.renamed++;
    }
    report.cases.push({ caseRef, clientName: tree.clientName, folders: (tree.tree || []).length, clientFiles, staffFolders, rows: outcomes });
    const m = outcomes.filter((o) => o.verdict === 'misfiled').length;
    const n = outcomes.filter((o) => o.verdict === 'no-upload-record').length;
    const rn = outcomes.filter((o) => o.verdict === 'renamed').length;
    const p = outcomes.filter((o) => o.verdict === 'PHANTOM').length;
    console.log(`[${i + 1}/${refs.length}] ${caseRef}  received:${outcomes.length}  ok:${outcomes.length - p - m - n - rn}  misfiled:${m}  renamed:${rn}  no-record:${n}${p ? `  *** SHORT OF FILES: ${p} (holds ${clientFiles}) ***` : ''}`);
    save(); await sleep(PACE);
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log('\nSummary:', JSON.stringify(tally, null, 2));
  if (report.findings.length) {
    const cases = [...new Set(report.findings.map((f) => f.caseRef))];
    console.log(`\nWORTH A LOOK — ${report.findings.length} row(s) across ${cases.length} case(s) whose recorded file is gone AND whose folder holds fewer files than that:`);
    for (const ref of cases) {
      const rows = report.findings.filter((f) => f.caseRef === ref);
      console.log(`  ${ref}  ${rows[0].clientName || ''}  — ${rows.length} unmatched, ${rows[0].clientFiles} client file(s) present${rows[0].staffFolders.length ? `, staff folders: ${rows[0].staffFolders.join(', ')}` : ''}`);
      for (const f of rows) console.log(`      ${f.doc}  ←  ${f.recordedFiles.join(', ')}  (uploaded ${f.uploadDate || '—'})`);
    }
  }
  console.log(`\nReport → ${OUT}`);
})().catch((err) => { console.error('FAILED:', err.stack || err.message); process.exit(err.abortRun ? 2 : 1); });

function rowBrief(row) { return { rowId: row.id, doc: row.doc, category: row.category, uploadDate: row.uploadDate }; }
