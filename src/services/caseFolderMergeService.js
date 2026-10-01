'use strict';

/**
 * Repair for a case whose reference sits on TWO root folders — the client's
 * real one and a leftover test folder the app resolves to (2026-09-30:
 * 2026-CEC-PR-002, 2026-VV-008, 2026-SP-015). Faran's decision: move the
 * client's files into the real folder, leave the test run's own files behind,
 * rename the test folder so it no longer carries the reference; never delete.
 *
 * One call = one case. Preview by default: it lists every file with where it
 * would go, what stays, the rename, and anything that would stop a real run —
 * and changes nothing. The real run needs the confirmation text.
 *
 * ORDER of a real run — the test folder is taken OFF the reference first:
 *   0. fresh listing of both folders (never the preview's); refuse if a file
 *      in the test folder changed in the last 15 minutes (someone is working
 *      on it), if a sub-folder holds a folder (the listing stops at one
 *      level), or if the real folder is not the one Monday links;
 *   1. the case's Monday rows are read (a Monday outage is found out BEFORE
 *      anything irreversible);
 *   2. the case is put ON HOLD in this process (oneDriveService.holdCaseFolder:
 *      every lookup answers "try again in a minute" — a page view in the gap
 *      would otherwise seed a blank questionnaire into the real folder), then
 *      the test folder is RENAMED — from this moment only the real folder ends
 *      " - <ref>" — and the process forgets what it cached;
 *   3. MOVE: a whole sub-folder goes in ONE step when the real folder has no
 *      sub-folder of that name and nothing in it stays (Questionnaire first);
 *      the rest file by file, by item id, into the same-named sub-folder
 *      (created if missing). A same-named file there: the NEWER keeps the
 *      name, the older is set aside as "<name> (before merge <date>)" — both
 *      are kept. A move that fails is retried, then reported; the file simply
 *      stays in the renamed folder, and a run with finish: true, from = the
 *      renamed name and the SAME keep list finishes the job. The hold ends here;
 *   4. CHECK: the renamed folder is re-listed (only the kept files may be
 *      left) and the reference is looked up again (only the real folder may
 *      carry it — a write in flight could have re-created the old name); a
 *      file stored under a name the plan did not predict is a problem too;
 *   5. the case's checklist rows get their folder links re-pointed at the
 *      real folder, and a note on the case says what moved and where.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId, executionBoardId } = require('../../config/monday');

const CONFIRM_TEXT   = 'MOVE-CASE-FILES';
const CASE_REF_COL   = 'text_mm142s49';   // Cases board
const FOLDER_ID_COL  = 'text_mm47y540';   // Cases board: OneDrive Folder Id (the real folder)
const EXEC_REF_COL   = 'text_mm0z2cck';   // Documents board: case reference
const EXEC_CAT_COL   = 'text_mm261tka';   // Documents board: category text
const DOC_FOLDER_COL = 'link_mm1yrnz1';   // Documents board: "Open in OneDrive" per row
const RECENT_MS      = 15 * 60 * 1000;
const MOVE_RETRIES   = 2;

const SANITISE = (v) => String(v == null ? '' : v).replace(/[*:"<>?/\\|]/g, '').trim();
const refOf = (folderName) => { const m = /\s-\s(\S+)$/.exec(String(folderName || '').trim()); return m ? m[1] : ''; };
const clean = (v) => String(v == null ? '' : v).trim();

/* ───────────────────────────── I/O seam ───────────────────────────── */
const io = {
  tree:        (name) => require('./oneDriveService').listRootFolderTree(name),
  move:        (p) => require('./oneDriveService').moveItemById(p),
  rename:      (p) => require('./oneDriveService').renameItemById(p),
  subfolder:   (p) => require('./oneDriveService').ensureSubfolderById(p),
  forget:      (ref) => require('./oneDriveService').forgetCaseFolder(ref),
  hold:        (ref) => require('./oneDriveService').holdCaseFolder(ref),
  release:     (ref) => require('./oneDriveService').releaseCaseFolder(ref),
  foldersByRef:(ref) => require('./oneDriveService').findCaseFoldersByRef(ref),
  orgLink:     (id) => require('./oneDriveService').orgLinkById(id),
  categoryLink:(p) => require('./oneDriveService').ensureCategoryFolderLink(p),
  sleep:       (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); }),
  now:         () => new Date(),
  async caseItems(ref) {
    const d = await mondayApi.query(
      `query($b:ID!,$v:String!){ items_page_by_column_values(limit:20, board_id:$b, columns:[{column_id:"${CASE_REF_COL}", column_values:[$v]}]){ items{ id name column_values(ids:["${FOLDER_ID_COL}"]){ id text } } } }`,
      { b: String(clientMasterBoardId), v: ref });
    return ((d.items_page_by_column_values || {}).items || []).map((it) => ({ id: String(it.id), name: it.name, folderId: clean(((it.column_values || [])[0] || {}).text) }));
  },
  async docRows(ref) {
    const d = await mondayApi.query(
      `query($b:ID!,$v:String!){ items_page_by_column_values(limit:200, board_id:$b, columns:[{column_id:"${EXEC_REF_COL}", column_values:[$v]}]){ items{ id name column_values(ids:["${EXEC_CAT_COL}"]){ id text } } } }`,
      { b: String(executionBoardId), v: ref });
    return ((d.items_page_by_column_values || {}).items || []).map((it) => ({ id: String(it.id), name: it.name, category: clean(((it.column_values || [])[0] || {}).text) }));
  },
  async setRowFolderLink(itemId, url, text) {
    await mondayApi.query(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`,
      { b: String(executionBoardId), i: String(itemId), v: JSON.stringify({ [DOC_FOLDER_COL]: { url, text } }) });
  },
  async note(itemId, body) {
    await mondayApi.query(`mutation($i:ID!,$b:String!){ create_update(item_id:$i, body:$b){ id } }`, { i: String(itemId), b: body });
  },
};

/**
 * PURE — what a merge would do, from two fresh listings.
 * @param {{ from: object, to: object, keep: string[], now?: number }} p  keep = "Sub-folder/file name" paths that stay
 */
function planMerge({ from, to, keep = [], now = Date.now() }) {
  const keepSet = new Set(keep.map(clean).filter(Boolean));
  const toSubs = new Map();   // sub-folder name (lower) → { id, name, files: Map(lowerName → file) }
  for (const d of to.folders) toSubs.set(d.name.toLowerCase(), { id: d.id, name: d.name, files: new Map(d.files.map((f) => [f.name.toLowerCase(), f])) });
  const toRoot = new Map(to.rootFiles.map((f) => [f.name.toLowerCase(), f]));
  const moves = [], stays = [], blockers = [], folderMoves = [];
  const consider = (sub, f) => {
    const path = sub ? `${sub.name}/${f.name}` : f.name;
    if (keepSet.has(path)) { stays.push({ path, id: f.id }); return; }
    const dest = sub ? toSubs.get(sub.name.toLowerCase()) : null;
    const existing = sub ? (dest && dest.files.get(f.name.toLowerCase())) : toRoot.get(f.name.toLowerCase());
    const m = { id: f.id, path, name: f.name, size: f.size, modifiedAt: f.modifiedAt, subfolder: sub ? sub.name : '', destSubfolderId: dest ? dest.id : null, destSubfolderMissing: !!sub && !dest };
    if (existing) {
      // the NEWER file keeps the name; the older one is set aside (never replaced)
      m.clash = { existingId: existing.id, existingModifiedAt: existing.modifiedAt, movingIsNewer: String(f.modifiedAt) > String(existing.modifiedAt) };
    }
    if (f.modifiedAt && now - Date.parse(f.modifiedAt) < RECENT_MS) blockers.push(`"${path}" changed ${Math.round((now - Date.parse(f.modifiedAt)) / 60000)} min ago — someone is working on this case; wait`);
    moves.push(m);
  };
  for (const f of from.rootFiles) consider(null, f);
  for (const d of from.folders) {
    for (const f of d.files) consider(d, f);
    for (const n of (d.nested || [])) blockers.push(`"${d.name}/${n.name}" is a folder inside a sub-folder — the listing does not look inside it; move or empty it by hand first`);
    // The whole sub-folder goes in ONE step when the real folder has none of that
    // name, nothing in it stays and nothing is nested: no window in which the
    // real folder has the sub-folder but not yet its files.
    const whole = !toSubs.has(d.name.toLowerCase()) && !(d.nested || []).length && !d.files.some((f) => keepSet.has(`${d.name}/${f.name}`));
    if (whole) {
      folderMoves.push({ id: d.id, name: d.name, files: d.files.length });
      for (const m of moves) if (m.subfolder === d.name) { m.viaFolder = true; m.destSubfolderMissing = false; }
    }
  }
  folderMoves.sort((a, b) => (a.name === 'Questionnaire' ? -1 : b.name === 'Questionnaire' ? 1 : a.name.localeCompare(b.name)));
  const unknownKeep = [...keepSet].filter((k) => !stays.some((s) => s.path === k));
  return { moves, stays, unknownKeep, blockers, folderMoves, emptySubfoldersLeft: from.folders.filter((d) => !d.files.length && !(d.nested || []).length && !folderMoves.some((x) => x.id === d.id)).map((d) => d.name) };
}

/**
 * @param {{ from: string, to: string, keep?: string[], renameFromTo: string, dryRun?: boolean, confirm?: string, by?: string, note?: boolean, finish?: boolean }} p
 *   finish = true only to finish a run that left files behind: from = the RENAMED name (= renameFromTo), same keep list
 */
async function mergeCaseFolders({ from, to, keep = [], renameFromTo, dryRun = true, confirm = '', by = '', note = true, finish = false }) {
  from = clean(from); to = clean(to);
  const newName = SANITISE(renameFromTo);
  if (!from || !to) throw bad('from and to (exact root folder names) are required');
  if (!Array.isArray(keep) || keep.some((k) => typeof k !== 'string' || !clean(k))) throw bad('keep must be a list of "Sub-folder/file name" paths');
  if (SANITISE(from).toLowerCase() === SANITISE(to).toLowerCase()) throw bad('from and to are the same folder');
  const ref = refOf(to);
  if (!ref) throw bad(`to must end with the case reference (" - <ref>"); got "${to}"`);
  if (!newName) throw bad('renameFromTo is required: the name the emptied folder gets, so it no longer carries the reference');
  if (newName !== clean(renameFromTo)) throw bad(`renameFromTo contains characters OneDrive does not allow: "${renameFromTo}"`);
  if (refOf(newName) || newName.endsWith(` - ${ref}`)) throw bad(`renameFromTo must not end with " - <anything>" (it must not look like a case folder); got "${newName}"`);
  const alreadyRenamed = finish === true;                        // finishing an earlier run
  if (alreadyRenamed && from !== newName) throw bad(`finish: from must be the renamed name "${newName}"; got "${from}"`);
  if (alreadyRenamed && refOf(from)) throw bad(`finish: "${from}" still carries a case reference — finish is only for the renamed test folder`);
  if (!alreadyRenamed && from === newName) throw bad(`"${from}" is the renamed name — to finish an earlier run send finish: true`);
  if (!alreadyRenamed && refOf(from) !== ref) throw bad(`from must end with the SAME case reference as to (" - ${ref}"); got "${from}"`);
  if (!dryRun && confirm !== CONFIRM_TEXT) throw bad(`A real run needs the confirmation text "${CONFIRM_TEXT}".`);

  const [fromTree, toTree] = await Promise.all([io.tree(from), io.tree(to)]);
  if (!fromTree) throw bad(`no folder named "${from}"`);
  if (!toTree) throw bad(`no folder named "${to}"`);
  if (fromTree.folder.id === toTree.folder.id) throw bad('from and to are the same folder');
  const now = io.now().getTime();
  const plan = planMerge({ from: fromTree, to: toTree, keep, now });
  if (plan.unknownKeep.length) throw bad(`keep names files that are not in "${from}": ${plan.unknownKeep.join(', ')}`);

  // Monday first: the rows, and the folder Monday links — it must be `to`.
  let caseItems = [];
  try { caseItems = await io.caseItems(ref); } catch (err) { throw bad(`Monday could not be read (${err.message}) — nothing was changed`); }
  const linked = caseItems.map((c) => c.folderId).filter(Boolean);
  if (linked.length && !linked.includes(toTree.folder.id)) plan.blockers.push(`Monday links a different folder for ${ref} (id ${linked.join(', ')}) — "to" must be the folder Monday links`);
  if (!caseItems.length) plan.blockers.push(`no Cases-board row carries ${ref}`);

  const report = {
    mode: dryRun ? 'preview (nothing changed)' : 'REAL RUN', caseRef: ref, by: clean(by) || 'admin', startedAt: new Date(now).toISOString(),
    from: { name: fromTree.folder.name, id: fromTree.folder.id }, to: { name: toTree.folder.name, id: toTree.folder.id, webUrl: toTree.folder.webUrl },
    renameFromTo: newName, alreadyRenamed, caseRows: caseItems.map((c) => `${c.id} ${c.name}`),
    folderMoves: plan.folderMoves.map((d) => `${d.name}/ (${d.files} file${d.files === 1 ? '' : 's'}) — the whole sub-folder, in one step`),
    moves: plan.moves.map((m) => ({ path: m.path, to: `${toTree.folder.name}/${m.path}`, size: m.size, modifiedAt: m.modifiedAt,
      note: m.viaFolder ? 'moves with its whole sub-folder' : m.clash ? (m.clash.movingIsNewer
          ? `a file with this name is already there (changed ${m.clash.existingModifiedAt}) — this one is newer and keeps the name; the older is set aside as "(before merge …)"`
          : `a file with this name is already there (changed ${m.clash.existingModifiedAt}) and is NEWER — it keeps the name; this one is stored with a suffix`)
        : (m.destSubfolderMissing ? 'sub-folder will be created' : '') })),
    stays: plan.stays.map((s) => s.path), emptySubfoldersLeft: plan.emptySubfoldersLeft, blockers: plan.blockers,
    counts: { toMove: plan.moves.length, toStay: plan.stays.length, clashes: plan.moves.filter((m) => m.clash).length },
    renamed: null, moved: [], failed: [], setAside: [], leftBehind: null, foldersCarryingRef: null, rowLinks: null, noted: [], outcome: null,
  };
  if (dryRun) { report.outcome = plan.blockers.length ? 'a real run would be REFUSED — see blockers' : 'ready'; return report; }
  if (plan.blockers.length) throw bad(`refused: ${plan.blockers.join(' | ')}`);

  console.log(`[FolderMerge] REAL RUN ${ref}: "${from}" → "${to}", ${plan.moves.length} file(s), by ${report.by}`);
  const unexpectedNames = [];
  try {
    // 2. the case goes on hold, then the test folder comes OFF the reference
    io.hold(ref);
    if (!alreadyRenamed) {
      try {
        const r = await io.rename({ itemId: fromTree.folder.id, newName });
        if (r.name !== newName) throw new Error(`OneDrive stored the name as "${r.name}"`);
        report.renamed = { from: fromTree.folder.name, to: r.name };
        console.log(`[FolderMerge] ${ref}: renamed "${fromTree.folder.name}" → "${r.name}"`);
      } catch (err) {
        report.outcome = `REFUSED before any file moved: "${from}" could not be renamed (${err.message}). Nothing changed.`;
        console.error(`[FolderMerge] ${ref}: ${report.outcome}`);
        return report;
      }
    }
    try { io.forget(ref); } catch (_) { /* best effort */ }

    // 3a. whole sub-folders, Questionnaire first
    const viaFolderDone = new Set();
    for (const d of plan.folderMoves) {
      let lastErr = null;
      for (let attempt = 0; attempt <= MOVE_RETRIES; attempt++) {
        try {
          const r = await io.move({ itemId: d.id, toFolderId: toTree.folder.id });
          if (r.name !== d.name) unexpectedNames.push(`sub-folder "${d.name}" was stored as "${r.name}" — something made a "${d.name}" in the real folder during the run`);
          for (const m of plan.moves) if (m.viaFolder && m.subfolder === d.name) { report.moved.push({ path: m.path, storedAs: m.name, withFolder: r.name }); viaFolderDone.add(m.id); }
          console.log(`[FolderMerge] ${ref}: moved sub-folder "${d.name}" (${d.files} file(s)) → "${r.name}"`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < MOVE_RETRIES) { console.warn(`[FolderMerge] ${ref}: sub-folder "${d.name}" — ${err.message}; trying again`); await io.sleep(3000 * (attempt + 1)); }
        }
      }
      if (lastErr) for (const m of plan.moves) if (m.viaFolder && m.subfolder === d.name) { report.failed.push({ path: m.path, error: `with its sub-folder: ${lastErr.message}` }); console.error(`[FolderMerge] ${ref}: could not move sub-folder "${d.name}": ${lastErr.message}`); }
    }

    // 3b. the rest, file by file
    const subIds = new Map(plan.moves.filter((m) => m.destSubfolderId).map((m) => [m.subfolder.toLowerCase(), m.destSubfolderId]));
    for (const m of plan.moves) {
    if (m.viaFolder) continue;
    let lastErr = null;
    for (let attempt = 0; attempt <= MOVE_RETRIES; attempt++) {
      try {
        let toFolderId = toTree.folder.id;
        if (m.subfolder) {
          toFolderId = subIds.get(m.subfolder.toLowerCase());
          if (!toFolderId) { const sf = await io.subfolder({ parentId: toTree.folder.id, name: m.subfolder }); toFolderId = sf.id; subIds.set(m.subfolder.toLowerCase(), sf.id); }
        }
        if (m.clash && m.clash.movingIsNewer && !m.clash.asideDone) {
          const aside = asideName(m.name, now);
          await io.rename({ itemId: m.clash.existingId, newName: aside });
          m.clash.asideDone = true;
          report.setAside.push({ path: `${m.subfolder ? m.subfolder + '/' : ''}${m.name}`, storedAs: aside });
        }
        const r = await io.move({ itemId: m.id, toFolderId });
        report.moved.push({ path: m.path, storedAs: r.name, webUrl: r.webUrl });
        if (r.name !== m.name && !(m.clash && !m.clash.movingIsNewer)) unexpectedNames.push(`"${m.path}" was stored as "${r.name}" — a file of that name appeared in the real folder during the run`);
        console.log(`[FolderMerge] ${ref}: moved "${m.path}" → "${r.name}"`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < MOVE_RETRIES) { console.warn(`[FolderMerge] ${ref}: "${m.path}" — ${err.message}; trying again`); await io.sleep(3000 * (attempt + 1)); }
      }
    }
    if (lastErr) { report.failed.push({ path: m.path, error: lastErr.message }); console.error(`[FolderMerge] ${ref}: could not move "${m.path}": ${lastErr.message}`); }
    }
  } finally {
    io.release(ref);   // the files are where they are going to be; the app may look again
  }

  // 4. the checks
  try {
    const after = await io.tree(newName);
    if (!after) report.leftBehind = [`could not find "${newName}" to re-list — look before doing anything else`];
    else {
      const left = [...after.rootFiles.map((f) => f.name), ...after.folders.flatMap((d) => [...d.files.map((f) => `${d.name}/${f.name}`), ...(d.nested || []).map((n) => `${d.name}/${n.name}/`)])];
      report.leftBehind = left.filter((p) => !plan.stays.some((s) => s.path === p));
    }
  } catch (err) { report.leftBehind = [`could not re-list "${newName}": ${err.message}`]; }
  try {
    const hits = await io.foldersByRef(ref);
    report.foldersCarryingRef = hits.map((h) => h.name);
  } catch (err) { report.foldersCarryingRef = [`could not look up: ${err.message}`]; }
  const splitAgain = Array.isArray(report.foldersCarryingRef) && (report.foldersCarryingRef.length !== 1 || report.foldersCarryingRef[0] !== toTree.folder.name);

  // 5. the checklist rows' folder links, and the note
  const clientName = (caseItems[0] && caseItems[0].name) || '';
  report.rowLinks = { repointed: 0, failed: 0 };
  try {
    const rows = await io.docRows(ref);
    const linkByCat = new Map();
    for (const row of rows) {
      if (!row.category) continue;
      try {
        if (!linkByCat.has(row.category)) linkByCat.set(row.category, await io.categoryLink({ clientName, caseRef: ref, category: row.category }));
        await io.setRowFolderLink(row.id, linkByCat.get(row.category), `${row.category} Folder`);
        report.rowLinks.repointed++;
      } catch (err) { report.rowLinks.failed++; report.rowLinks.lastError = err.message; }
    }
  } catch (err) { report.rowLinks.error = err.message; }

  if (note) {
    let folderLink = toTree.folder.webUrl;
    try { folderLink = await io.orgLink(toTree.folder.id); } catch (_) { /* the plain url then */ }
    const body = `📁 Files moved into this client's own folder (${report.moved.length} file${report.moved.length === 1 ? '' : 's'}, by ${report.by}).\n\n` +
      `They had been filed in "${fromTree.folder.name}", a leftover test folder that carried this case reference. That folder is now named "${newName}"` +
      (plan.stays.length ? ` and holds only the test run's own files (${plan.stays.length}).` : ' and holds nothing of this client\'s.') +
      (report.failed.length ? `\n\n⚠ ${report.failed.length} file(s) could NOT be moved and are still in "${newName}": ${report.failed.map((f) => f.path).join('; ')} (kept there on purpose: ${keep.length ? keep.join('; ') : 'nothing'})` : '') +
      (report.setAside.length ? `\n\nSet aside (an older copy with the same name): ${report.setAside.map((x) => `${x.path} → ${x.storedAs}`).join('; ')}` : '') +
      `\n\nMoved: ${report.moved.map((x) => (x.storedAs && !x.path.endsWith(x.storedAs) ? `${x.path} (now "${x.storedAs}")` : x.path)).join('; ')}` +
      `\n\nThe folder: ${folderLink}`;
    for (const it of caseItems) {
      try { await io.note(it.id, body); report.noted.push(it.id); } catch (err) { report.noteError = err.message; }
    }
  }

  const problems = [];
  if (report.failed.length) problems.push(`${report.failed.length} file(s) could not be moved — they are still in "${newName}", which no longer carries the reference; to finish, run again with finish: true, from = "${newName}" and the SAME keep list ${JSON.stringify(keep)}`);
  if (unexpectedNames.length) { report.unexpectedNames = unexpectedNames; problems.push(unexpectedNames.join('; ')); }
  if (report.leftBehind && report.leftBehind.length) problems.push(`unexpected item(s) left in "${newName}": ${report.leftBehind.join('; ')}`);
  if (splitAgain) problems.push(`the reference is NOT on exactly the real folder now: ${JSON.stringify(report.foldersCarryingRef)} — look before doing anything else`);
  report.outcome = problems.length ? `done WITH PROBLEMS: ${report.moved.length} file(s) moved. ${problems.join('. ')}` : `done: ${report.moved.length} file(s) moved; "${fromTree.folder.name}" is now "${newName}"; the reference is only on "${toTree.folder.name}"`;
  (problems.length ? console.error : console.log)(`[FolderMerge] ${ref}: ${report.outcome}`);
  return report;
}

function asideName(name, now) {
  const d = new Date(now).toISOString().slice(0, 10);
  const i = name.lastIndexOf('.');
  return i > 0 ? `${name.slice(0, i)} (before merge ${d})${name.slice(i)}` : `${name} (before merge ${d})`;
}

function bad(msg) { const e = new Error(msg); e.badRequest = true; return e; }

module.exports = { mergeCaseFolders, planMerge, io, CONFIRM_TEXT, refOf, asideName };
