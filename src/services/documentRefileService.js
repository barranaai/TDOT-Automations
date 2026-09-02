/**
 * Document re-filing — moves client uploads that landed in the OneDrive
 * "General" folder (pre-2026-09-02 bug, see documentFormService.
 * resolveUploadCategory) into the category folder of the checklist row they
 * were uploaded for.
 *
 * How a General file is mapped back to its row: every client upload posts a
 * "📄 Document Uploaded by Client … Document: <row> / File: <name> /
 * Category: <resolved-at-the-time>" update on the execution row
 * (documentFormService.postUploadUpdates). For a case: read the execution
 * rows (updates + category column), build normalised-filename → claimants,
 * and move each General file that has exactly ONE consistent claimant.
 *
 * Conservative by construction — a file STAYS (reported, never moved) when:
 *   - no comment claims it (unmapped);
 *   - claimants disagree on category, or any claimant row has no category;
 *   - a claiming comment recorded a category other than General (evidence
 *     that a same-named upload went elsewhere — the General copy may not be
 *     this row's content);
 *   - the row's category is General / not a safe folder name;
 *   - a same-named file already exists in the target folder;
 *   - the evidence may be truncated (row cap / updates cap hit).
 * Filenames are normalised on BOTH sides the way uploadFile stores them
 * (strip [*:"<>?\|], trim, collapse spaces, NFC, case-fold) — OneDrive
 * collapses such variants onto one item, so all variants are claimants.
 *
 * Writes: ONLY OneDrive moves (never delete, never Monday). Dry-run default.
 */

const mondayApi = require('./mondayApi');
const oneDrive  = require('./oneDriveService');

const EXEC_BOARD_ID     = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF_COL      = 'text_mm0z2cck';
const CATEGORY_TEXT_COL = 'text_mm261tka';
const INTAKE_ID_COL     = 'text_mm0zfsp1';
const ROWS_LIMIT        = 500;
const UPDATES_LIMIT     = 100;
const CATEGORY_RE       = /^[A-Za-z][A-Za-z &()_-]{1,40}$/;   // a folder name we are willing to move INTO

/** The name OneDrive would store for an uploaded filename (uploadFile's strip), case-folded for matching. */
function normFilename(name) {
  return String(name || '').replace(/[*:"<>?\\|]/g, '').trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase();
}

/** Pure. Parse { file, category } out of a row's upload comments. */
function uploadedFiles(updateBodies) {
  const out = [];
  for (const b of updateBodies || []) {
    const body = String(b || '');
    if (!/Document Uploaded by Client/i.test(body)) continue;
    const fm = /File:\s*([\s\S]+?)\s*(?:\r?\n|Category:)/.exec(body);
    if (!fm || !fm[1].trim()) continue;
    const cm = /Category:\s*([\s\S]+?)\s*(?:\r?\n|Case:)/.exec(body);
    out.push({ file: fm[1].trim(), category: cm ? cm[1].trim() : '' });
  }
  return out;
}

/**
 * Pure. Plan the moves for one case.
 * @param {Array<{name:string}>} generalFiles  files currently in General
 * @param {Array<{id:string,name:string,category:string,updates:string[]}>} rows  execution rows
 * @param {{ targetFiles?: Record<string, string[]>, evidenceTruncated?: boolean }} [opts]
 *        targetFiles: category → names already in that folder (collision check)
 * @returns {{ moves, unmapped, ambiguous, stays }}
 */
function planRefile(generalFiles, rows, opts = {}) {
  const targetFiles = opts.targetFiles || {};
  const moves = [], unmapped = [], ambiguous = [], stays = [];
  if (opts.evidenceTruncated) {
    for (const gf of generalFiles || []) stays.push({ file: gf.name, reason: 'evidence truncated (row/updates cap) — re-run with a smaller scope' });
    return { moves, unmapped, ambiguous, stays };
  }
  // normalised filename → claimants [{ rowId, rowName, rowCategory, commentCategory, rawFile }]
  const claims = new Map();
  for (const row of rows || []) {
    const rowCategory = String(row.category || '').trim();
    for (const u of uploadedFiles(row.updates)) {
      const key = normFilename(u.file);
      if (!key) continue;
      if (!claims.has(key)) claims.set(key, []);
      claims.get(key).push({ rowId: row.id, rowName: row.name, rowCategory, commentCategory: u.category, rawFile: u.file });
    }
  }
  for (const gf of generalFiles || []) {
    const name = String(gf.name || '');
    const cs = claims.get(normFilename(name));
    if (!cs || !cs.length) { unmapped.push(name); continue; }
    const rowCats = [...new Set(cs.map((c) => c.rowCategory))];
    if (rowCats.some((c) => !c)) { stays.push({ file: name, reason: `claimed by a row with no category (${cs.filter((c) => !c.rowCategory).map((c) => c.rowName).join(', ')})` }); continue; }
    if (rowCats.length > 1) { ambiguous.push({ file: name, categories: rowCats }); continue; }
    const elsewhere = [...new Set(cs.map((c) => c.commentCategory).filter((c) => c && c !== 'General'))];
    if (elsewhere.length) { ambiguous.push({ file: name, categories: rowCats, reason: `a same-named upload was recorded under ${elsewhere.join(', ')}` }); continue; }
    const to = rowCats[0];
    if (to === 'General') { stays.push({ file: name, reason: 'row category is General' }); continue; }
    if (!CATEGORY_RE.test(to)) { stays.push({ file: name, reason: `unsafe folder name "${to}"` }); continue; }
    const there = (targetFiles[to] || []).some((n) => normFilename(n) === normFilename(name));
    if (there) { stays.push({ file: name, reason: `a file with this name already exists in ${to}` }); continue; }
    moves.push({ file: name, to, rowId: cs[0].rowId, docName: cs[0].rowName });
  }
  return { moves, unmapped, ambiguous, stays };
}

async function fetchExecutionRows(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $v: String!) {
       items_page_by_column_values(limit: ${ROWS_LIMIT}, board_id: $boardId, columns: [{ column_id: "${CASE_REF_COL}", column_values: [$v] }]) {
         items { id name column_values(ids: ["${CATEGORY_TEXT_COL}", "${INTAKE_ID_COL}"]) { id text } updates(limit: ${UPDATES_LIMIT}) { text_body body } }
       }
     }`,
    { boardId: String(EXEC_BOARD_ID), v: caseRef }
  );
  const items = data?.items_page_by_column_values?.items || [];
  const rows = items.map((it) => {
    const col = (id) => (it.column_values || []).find((c) => c.id === id)?.text?.trim() || '';
    return { id: String(it.id), name: it.name, category: col(CATEGORY_TEXT_COL), intakeId: col(INTAKE_ID_COL),
             updates: (it.updates || []).map((u) => u.text_body || u.body || '') };
  });
  const evidenceTruncated = items.length >= ROWS_LIMIT || rows.some((r) => r.updates.length >= UPDATES_LIMIT);
  return { rows, evidenceTruncated };
}

/**
 * Re-file one case's General uploads. dryRun (default) only plans.
 * @returns {{ caseRef, clientName, dryRun, caseFolderFound, generalCount, rowCount, evidenceTruncated, plan, moved, failed, notAttempted }}
 */
async function refileGeneralUploads({ caseRef, clientName, dryRun = true }) {
  if (!caseRef || !clientName) throw new Error('caseRef and clientName are required');
  const generalFiles = await oneDrive.listFiles({ clientName, caseRef, subfolder: 'General' });
  let caseFolderFound = true;
  if (!generalFiles.length) {
    // an absent General folder lists as [] — tell "clean" apart from "case folder not found by this name"
    const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
    caseFolderFound = Boolean(await oneDrive.getClientFolderByName(safeName));
    return { caseRef, clientName, dryRun: dryRun !== false, caseFolderFound, generalCount: 0, rowCount: 0, evidenceTruncated: false,
             plan: { moves: [], unmapped: [], ambiguous: [], stays: [] }, moved: [], failed: [], notAttempted: [] };
  }
  const { rows, evidenceTruncated } = await fetchExecutionRows(caseRef);
  // collision check: list each candidate target folder once
  const draft = planRefile(generalFiles, rows, { evidenceTruncated });
  const targetFiles = {};
  for (const to of new Set(draft.moves.map((m) => m.to))) {
    targetFiles[to] = (await oneDrive.listFiles({ clientName, caseRef, subfolder: to })).map((f) => f.name);
  }
  const plan = planRefile(generalFiles, rows, { evidenceTruncated, targetFiles });

  const moved = [], failed = [], notAttempted = [];
  if (dryRun === false) {
    let stop = false;
    for (const m of plan.moves) {
      if (stop) { notAttempted.push(m); continue; }
      try {
        const r = await oneDrive.moveFile({ clientName, caseRef, fromSubfolder: 'General', toSubfolder: m.to, filename: m.file });
        moved.push({ ...m, webUrl: r.webUrl, finalName: r.name, renamed: Boolean(r.name) && r.name !== m.file });
        console.log(`[Refile] ${caseRef}: "${m.file}" → ${m.to}${r.name && r.name !== m.file ? ` (as "${r.name}")` : ''}`);
      } catch (err) {
        failed.push({ ...m, error: err.message, transient: Boolean(err.transient) });
        console.warn(`[Refile] ${caseRef}: move failed for "${m.file}" → ${m.to}: ${err.message}`);
        if (err.transient) stop = true;   // Graph is unhappy — stop hammering, report the rest as not attempted
      }
    }
  }
  return { caseRef, clientName, dryRun: dryRun !== false, caseFolderFound, generalCount: generalFiles.length, rowCount: rows.length,
           evidenceTruncated, plan, moved, failed, notAttempted };
}

module.exports = { refileGeneralUploads, planRefile, uploadedFiles, normFilename, fetchExecutionRows };
