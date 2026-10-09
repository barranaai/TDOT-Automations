'use strict';

/**
 * Staff action "Create case folder" (Faran 2026-10-10, voice note about
 * 2026-CEC-EE-025): an old client added after the ITA was never a lead, so no
 * OneDrive folder was ever made for him — the app makes one only from the
 * lead's intake folder, the checklist, or the client's own saves. The
 * caseworker needs a place to hand the final file to the submission team.
 *
 * ONE thing, for a case that has NO folder:
 *   "Client Documents/<case name> - <ref>" + the four staff working folders,
 *   recorded on the Client Master row (OneDrive Folder link + Folder Id — the
 *   same two columns, same format, the lead hand-off writes) + one note.
 * Never an email, a checklist row, a stage or a payment change.
 *
 * It refuses whenever the case might already have a folder — a folder whose
 * name carries the reference anywhere (any case: OneDrive ignores case), the
 * lead's intake folder, a folder already recorded on the row — and whenever it
 * cannot be sure (a read that fails is "unknown", never "none"): a second
 * folder splits a client's files, the exact trap the folder-split repairs
 * undid. Also refused: a reference on two case rows, a TEST case, a row with
 * no client name, a folder being repaired right now.
 *
 * Two exceptions, both "link what is already there", never a second folder:
 *  - "finish": a folder with EXACTLY the expected name, made in the last 24 h,
 *    holding nothing but the empty working folders, on a row that does not
 *    record it — what this action leaves behind when its answer was lost or a
 *    write failed. Pressing again links it.
 *  - "link": the row records the folder's id but has no staff link (the
 *    reference back-fill writes the id only). The recorded folder — directly
 *    under "Client Documents", named "<…> - <ref>" — gets its link.
 * Only an organisation link is ever written: the noreply drive's own URL opens
 * for that mailbox alone, so without one nothing is written ("press again").
 */

const mondayApi  = require('./mondayApi');
const oneDrive   = require('./oneDriveService');
const caseAccess = require('./caseAccessService');
const { clientMasterBoardId, cmColumns } = require('../../config/monday');
const { torontoTime } = require('../utils/torontoTime');

const REF_COL  = 'text_mm142s49';                 // Case Reference Number
const ID_COL   = cmColumns.oneDriveFolderId;      // text_mm47y540
const LINK_COL = cmColumns.oneDriveFolderLink;    // link_mm47dng8
const TEST_GROUP_ID = 'group_mm3842s';            // the Cases board's TEST group (same as the working-folders backfill)
const REF_RE = /^[A-Za-z0-9-]{3,40}$/;
const FINISH_WINDOW_MS = 24 * 3600 * 1000;
const LINK_TEXT = 'Open client folder';

const s = (v) => String(v == null ? '' : v).trim();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (message, extra) => Object.assign(new Error(message), extra);
const transient = (message, cause) => fail(message, { transient: true, cause });

/** The reference as a whole word, any case: "… - 2026-CEC-EE-025", "(was 2026-CEC-EE-025)", "… 2026-CEC-EE-025 1". */
function refInName(name, ref) {
  return new RegExp(`(^|[^a-z0-9])${ref.replace(/-/g, '\\-')}($|[^a-z0-9])`, 'i').test(s(name));
}
const looksLikeTest = (name) => /\btest\b|\be2e\b|^zz/i.test(s(name));

const io = {
  /** Every Client Master row carrying the reference (Monday's match; filtered exactly below). */
  caseRows: async (ref) => {
    const ids = [REF_COL, ID_COL, LINK_COL, ...caseAccess.PEOPLE_COLUMNS];
    const data = await mondayApi.query(
      `query($b: ID!, $v: String!) { items_page_by_column_values(limit: 10, board_id: $b, columns: [{ column_id: "${REF_COL}", column_values: [$v] }]) {
         items { id name state group { id } column_values(ids: ${JSON.stringify(ids)}) { id text value } } } }`,
      { b: String(clientMasterBoardId), v: ref });
    const items = (data && data.items_page_by_column_values && data.items_page_by_column_values.items) || [];
    return items.filter((it) => !it.state || it.state === 'active').map((it) => {
      const by = {}; for (const c of it.column_values || []) by[c.id] = c;
      const valueByColId = {}; for (const id of caseAccess.PEOPLE_COLUMNS) valueByColId[id] = by[id] && by[id].value;
      let linkUrl = ''; try { linkUrl = s(JSON.parse((by[LINK_COL] && by[LINK_COL].value) || '{}').url); } catch (_) { linkUrl = s(by[LINK_COL] && by[LINK_COL].text); }
      return { itemId: String(it.id), name: s(it.name), groupId: (it.group && it.group.id) || '', ref: s(by[REF_COL] && by[REF_COL].text),
        folderId: s(by[ID_COL] && by[ID_COL].text), folderLink: linkUrl || s(by[LINK_COL] && by[LINK_COL].text),
        assignees: caseAccess.assigneesFromColumnValues(valueByColId) };
    });
  },
  /** Leads that point at this case row (the hand-off writes clientMasterItemId). */
  leadClaims: async (itemId) => (await require('./leadService').findAllByColumnValue('clientMasterItemId', itemId))
    .map((l) => ({ id: String(l.id), folderId: s(l.oneDriveFolderId) })),
  isHeld:       (ref) => oneDrive.isCaseFolderHeld(ref),
  listRoot:     () => oneDrive.listCaseFoldersInRoot(),
  folderTree:   (name) => oneDrive.listRootFolderTree(name),
  createFolder: (args) => oneDrive.createCaseFolder(args),
  driveItem:    (id) => oneDrive.getDriveItemById(id),
  workFolders:  (args) => oneDrive.ensureCaseWorkFolders(args),
  orgLink:      (id) => oneDrive.orgLinkById(id),
  forget:       (ref) => oneDrive.forgetCaseFolder(ref),
  /** The two hand-off columns; the id only when it is not on the row yet. */
  writeFolder: (itemId, { id, url }) => mondayApi.query(
    `mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify({ ...(id ? { [ID_COL]: id } : {}), [LINK_COL]: { url, text: LINK_TEXT } }) }),
  postNote: (itemId, body) => mondayApi.query(
    'mutation($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }', { i: String(itemId), b: body }),
  now: () => Date.now(),
};

/**
 * PURE: what can be done about this case's folder, from what was read.
 * @returns {{ state, canCreate, mode, name, folders, message }}
 */
function decide({ ref, rows, claims = [], held = false, rootFolders = [], tree = null, recordedItem, now = Date.now() }) {
  const out = (state, message, extra = {}) => ({ state, canCreate: false, mode: null, name: '', folders: [], message, ...extra });
  const mine = rows.filter((r) => r.ref.toUpperCase() === ref.toUpperCase());
  if (!mine.length) return out('not-found', `No case carries the reference ${ref}.`);
  if (mine.length > 1) return out('duplicate-ref', `${mine.length} cases carry the reference ${ref} — fix the duplicate first. Nothing was changed.`);
  const row = mine[0];
  if (row.groupId === TEST_GROUP_ID || require('./workFoldersBackfillService').LEAVE_OUT.has(row.ref)) return out('test-case', 'This is a test case — no folder is made for it. Nothing was changed.');
  if (!row.name || /^unknown client$/i.test(row.name)) return out('no-name', 'The case row has no client name — add the name on the Client Master row first. Nothing was changed.');
  if (row.folderLink) return out('recorded', 'This case’s folder is already linked — use “📁 OneDrive” at the top of the case. Nothing was changed.');
  if (held) return out('held', 'This case’s folder is being repaired right now — try again in a minute. Nothing was changed.');
  if (row.folderId) {   // recorded by id, no staff link: link THAT folder, never make another
    if (recordedItem === undefined) return out('recorded-id', 'This case’s folder is recorded on the case row (not yet checked in OneDrive). Nothing was changed.');
    if (!recordedItem) return out('recorded-missing', 'The case row records a folder that is no longer in OneDrive — an admin checks it. Nothing was changed.');
    // the app's own case-folder shape only ("<name> - <ref>"): not a "(was <ref>)" test leftover, not a "<ref> 1" clash copy
    if (!/\/Client Documents$/.test(s(recordedItem.parentPath)) || !s(recordedItem.name).toLowerCase().endsWith(` - ${row.ref.toLowerCase()}`)) {
      return out('recorded-odd', `The case row records a folder (“${s(recordedItem.name)}”) that does not look like this case’s folder — an admin checks it. Nothing was changed.`);
    }
    return { state: 'unlinked', canCreate: true, mode: 'link', name: s(recordedItem.name), folders: [{ name: s(recordedItem.name) }], folderId: row.folderId,
      message: `This case’s folder “Client Documents/${s(recordedItem.name)}” is recorded on the case row but has no staff link. The link can be added now.` };
  }
  const name = oneDrive.caseFolderName({ clientName: row.name, caseRef: row.ref });
  const leadFolders = rootFolders.filter((f) => claims.some((c) => new RegExp(` - LEAD-${c.id}$`, 'i').test(s(f.name))));
  if (claims.some((c) => c.folderId) || leadFolders.length) {
    return out('lead-folder', `This client has an intake folder from the lead${leadFolders.length ? ` ("${leadFolders.map((f) => f.name).join('", "')}")` : ''}. A new folder would split the client’s files — an admin renames the intake folder to the case instead. Nothing was changed.`,
      { folders: leadFolders.map((f) => ({ name: f.name })) });
  }
  const hits = rootFolders.filter((f) => refInName(f.name, row.ref));
  const folders = hits.map((f) => ({ name: f.name }));
  const testHint = hits.some((f) => looksLikeTest(f.name)) ? ' One of them looks like a leftover test folder — an admin sorts that out first.' : '';
  if (hits.length > 1) return out('split', `This case already has ${hits.length} folders in OneDrive (“${hits.map((f) => f.name).join('”, “')}”). An admin merges them first.${testHint} Nothing was changed.`, { folders });
  if (hits.length === 1) {
    const f = hits[0];
    if (finishable({ folder: f, name, tree, now })) {
      return { state: 'unrecorded-new', canCreate: true, mode: 'finish', name, folders, folderId: f.id,
        message: `The folder “Client Documents/${name}” was made a moment ago but is not linked on the case yet. It can be linked now.` };
    }
    return out('exists', `This case already has a folder in OneDrive: “Client Documents/${f.name}”. It is not linked on the case row — an admin can link it.${testHint} Nothing was changed.`, { folders });
  }
  return { state: 'missing', canCreate: true, mode: 'create', name, folders: [],
    message: `This case has no OneDrive folder. It can be created as “Client Documents/${name}”, with the four working folders.` };
}

/** The folder this action made a moment ago and could not record: exact name, < 24 h old, only the empty working folders in it. */
function finishable({ folder, name, tree, now }) {
  if (!tree || !tree.folder || tree.folder.id !== folder.id || s(folder.name) !== name) return false;
  const made = Date.parse(tree.folder.createdAt || folder.createdAt || '');
  if (!Number.isFinite(made) || now - made > FINISH_WINDOW_MS || made - now > 5 * 60 * 1000) return false;
  const work = new Set(oneDrive.CASE_WORK_FOLDERS.map((n) => n.toLowerCase()));
  if ((tree.rootFiles || []).length) return false;
  return (tree.folders || []).every((k) => work.has(s(k.name).toLowerCase()) && !(k.files || []).length && !(k.nested || []).length);
}

/**
 * Read everything the decision needs. Fails closed: any read that does not
 * answer throws err.transient ("unknown" is never "no folder").
 * @param {{ caseRef: string, canSee?: (assignees) => boolean }} p
 */
async function check({ caseRef, canSee = () => true }) {
  const ref = s(caseRef);
  if (!REF_RE.test(ref)) throw fail('That is not a case reference.', { badRequest: true });
  let rows;
  try { rows = await io.caseRows(ref); } catch (err) { throw transient('The case row could not be read just now — nothing was changed. Try again in a minute.', err); }
  const mine = rows.filter((r) => r.ref.toUpperCase() === ref.toUpperCase());
  if (mine.length && !mine.every((r) => canSee(r.assignees))) throw fail('You are not assigned to this case.', { forbidden: true });
  if (mine.length !== 1) return { ...decide({ ref, rows }), row: null };
  const row = mine[0];
  const quick = decide({ ref, rows });   // row-only refusals (test case, no name, recorded) need no OneDrive read
  if (['test-case', 'no-name', 'recorded'].includes(quick.state)) return { ...quick, row };
  const held = io.isHeld(row.ref);
  if (held) return { ...decide({ ref, rows, held }), row };
  if (row.folderId) {
    let recordedItem;
    try { recordedItem = await io.driveItem(row.folderId); } catch (err) { throw transient('OneDrive could not be checked just now — nothing was changed. Try again in a minute.', err); }
    return { ...decide({ ref, rows, recordedItem: recordedItem || null }), row };
  }
  let claims, rootFolders;
  try { claims = await io.leadClaims(row.itemId); } catch (err) { throw transient('The lead board could not be read just now — nothing was changed. Try again in a minute.', err); }
  try { rootFolders = await io.listRoot(); } catch (err) { throw transient('OneDrive could not be checked just now — nothing was changed. Try again in a minute.', err); }
  const hits = rootFolders.filter((f) => refInName(f.name, row.ref));
  let tree = null;
  if (hits.length === 1 && s(hits[0].name) === oneDrive.caseFolderName({ clientName: row.name, caseRef: row.ref })) {
    try { tree = await io.folderTree(hits[0].name); } catch (err) { throw transient('OneDrive could not be checked just now — nothing was changed. Try again in a minute.', err); }
  }
  return { ...decide({ ref, rows, claims, held: false, rootFolders, tree, now: io.now() }), row };
}

/** The end of a not-linked message: the admin note is there — or it is not, and staff pass it on. */
function tellAdmin(noted, name, ref) {
  return noted ? ' A note is on the case for an admin.' : ` The note for an admin could not be posted — tell an admin: “Client Documents/${name}” is not linked on ${ref}.`;
}

const _inFlight = new Set();   // one create per case at a time (single web process)

/**
 * Create (or finish) the case folder. Re-checks everything live first.
 * @param {{ caseRef: string, expectName: string, actor: { name: string }, canSee?: Function }} p
 * @returns {Promise<object>} the outcome; throws err.badRequest / err.forbidden / err.transient / err.refused / err.partial
 */
async function createCaseFolder({ caseRef, expectName, actor, canSee }) {
  const key = s(caseRef).toUpperCase();
  if (_inFlight.has(key)) throw fail('This case’s folder is being created right now — wait a moment and reload.', { refused: true, reason: 'in-progress' });
  _inFlight.add(key);
  try {
    return await _create({ caseRef, expectName, actor, canSee });
  } finally {
    _inFlight.delete(key);
  }
}

async function _create({ caseRef, expectName, actor, canSee }) {
  const facts = await check({ caseRef, canSee });
  if (!facts.canCreate) throw fail(facts.message, { refused: true, reason: facts.state });
  if (s(expectName) !== facts.name) throw fail('The case name changed since the check — reload the page and try again. Nothing was changed.', { refused: true, reason: 'changed' });
  const { row, name } = facts;
  const who = (actor && actor.name) || 'staff';
  const done = [];

  // 1. the folder
  let folder;
  if (facts.mode === 'finish' || facts.mode === 'link') {
    folder = { id: facts.folderId, name, created: false };
  } else {
    try {
      folder = await io.createFolder({ clientName: row.name, caseRef: row.ref });
    } catch (err) {
      throw fail(`The folder could not be created (${err.message}). Press the button again in a minute — if it was made anyway, that links it.`, { transient: !!err.transient, createFailed: true });
    }
    if (folder.created) done.push('folder created');
    // exactly ONE folder may carry the reference now, and it must be this one —
    // unchecked is not "fine": the folder stays unlinked and a second press links it (finish)
    let after;
    try { after = await io.listRoot(); } catch (err) {
      throw fail(`The folder “Client Documents/${name}” ${folder.created ? 'was created' : 'is there'}, but OneDrive could not be re-checked to link it safely. Press the button again in a minute — it links the folder.`, { partial: true, reason: 'not-linked' });
    }
    const others = after.filter((f) => refInName(f.name, row.ref) && f.id !== folder.id);
    let mine = after.find((f) => f.id === folder.id) || null;
    if (!mine) {   // a fresh folder can lag in the listing — ask for it by id
      const it = await io.driveItem(folder.id).catch(() => null);
      if (it && /\/Client Documents$/.test(s(it.parentPath))) mine = { id: it.id, name: it.name };
    }
    if (others.length || !mine || s(mine.name) !== name) {
      const why = others.length ? `another folder carries the reference too (“${others.map((f) => f.name).join('”, “')}”)` : !mine ? 'the new folder could not be confirmed in OneDrive' : `it is named “${mine.name}”`;
      const noted = await io.postNote(row.itemId, `⚠️ <b>Case folder not linked</b> — “Client Documents/${esc(folder.name || name)}” was ${folder.created ? 'created' : 'found'} by ${esc(who)}, ${esc(torontoTime(io.now()))} (Toronto), but it was NOT linked on this row: ${esc(why)}. An admin checks the folders in OneDrive. (${esc(row.ref)})`).then(() => true, () => false);
      const retry = !others.length && !mine ? ' Pressing the button again once OneDrive answers links it.' : '';
      throw fail(`The folder ${folder.created ? 'was created' : 'exists'} but was not linked: ${why}.${retry}${tellAdmin(noted, folder.name || name, row.ref)}`, { partial: true, reason: 'unconfirmed' });
    }
  }

  // 2. the four working folders (a failure is reported, the folder still gets linked)
  let work = { created: [], present: [], missing: [] };
  try {
    const r = await io.workFolders({ folderId: folder.id, label: row.ref });
    work = { created: r.created || [], present: r.present || [], missing: [] };
  } catch (err) {
    work.missing = Array.isArray(err.missing) && err.missing.length ? err.missing : oneDrive.CASE_WORK_FOLDERS.slice();
    await io.postNote(row.itemId, oneDrive.workFoldersFailedNoteText(err)).catch(() => {});
  }

  // 3. a link staff can open — the organisation link ONLY: the noreply drive's
  //    own URL opens for that mailbox alone, and a written link ends the offer
  let url = '';
  try { url = s(await io.orgLink(folder.id)); } catch (_) { url = ''; }
  if (!url) {
    throw fail(`The folder “Client Documents/${name}” ${folder.created ? 'was created' : 'is there'}, but the staff link to it could not be made just now. Press the button again in a minute — it links the folder.`, { partial: true, reason: 'not-linked' });
  }

  // 4. record it on the row — only while the row still records nothing (never overwrite)
  let fresh;
  try { fresh = (await io.caseRows(row.ref)).find((r) => r.itemId === row.itemId); } catch (_) { fresh = undefined; }
  if (!fresh) {
    throw fail(`The folder “Client Documents/${name}” ${folder.created ? 'was created' : 'is there'}, but the case row could not be re-read to link it. Press the button again in a minute — it links the folder.`, { partial: true, reason: 'not-linked' });
  }
  let recorded = 'linked';
  if (fresh.folderId && fresh.folderId !== folder.id) {
    // someone recorded ANOTHER folder meanwhile: two folders for one client — never overwrite, tell an admin
    const noted = await io.postNote(row.itemId, `⚠️ <b>Case folder not linked</b> — “Client Documents/${esc(name)}” was ${folder.created ? 'created' : 'found'} by ${esc(who)}, ${esc(torontoTime(io.now()))} (Toronto), but this row already records a different folder. An admin checks the folders in OneDrive. (${esc(row.ref)})`).then(() => true, () => false);
    throw fail(`The folder “Client Documents/${name}” ${folder.created ? 'was created' : 'is there'}, but the case row already records a different folder — it was left as it was.${tellAdmin(noted, name, row.ref)}`, { partial: true, reason: 'other-folder-recorded' });
  }
  if (fresh.folderLink) {
    recorded = 'already';
  } else {
    // the id only when the row does not carry it yet (link mode: it does — the same folder)
    try { await io.writeFolder(row.itemId, { id: fresh.folderId ? '' : folder.id, url }); } catch (err) {
      throw fail(`The folder “Client Documents/${name}” ${folder.created ? 'was created' : 'is there'}, but it could not be linked on the case row (${err.message}). Press the button again in a minute — it links the folder.`, { partial: true, reason: 'not-linked' });
    }
  }
  io.forget(row.ref);

  // 5. one note
  const head = folder.created ? 'Case folder created' : facts.mode === 'link' ? 'Case folder link added' : 'Case folder linked';
  const what = folder.created ? `“Client Documents/${esc(name)}” was created`
    : facts.mode === 'finish' ? `“Client Documents/${esc(name)}”, made a moment ago, is now linked`
    : facts.mode === 'link' ? `“Client Documents/${esc(name)}”, recorded on this row, now has its staff link`
    : `“Client Documents/${esc(name)}” was made at the same moment by another step of the app and is now linked`;
  const workLine = work.missing.length ? ` The working folder(s) ${esc(work.missing.join(', '))} still need to be added (see the other note).` : ` It holds the four working folders (${esc(oneDrive.CASE_WORK_FOLDERS.join(', '))}).`;
  const body = `📁 <b>${head}</b> — ${what} by ${esc(who)}, ${esc(torontoTime(io.now()))} (Toronto).${workLine} ${recorded === 'already' ? 'The row already recorded a folder, so it was left as it was.' : 'Linked on this row (📁 OneDrive on the case page).'} Nothing was sent to the client; the checklist, stage and payment are unchanged. (${esc(row.ref)})`;
  let noted = true;
  try { await io.postNote(row.itemId, body); } catch (_) { noted = false; }

  console.log(`[CaseFolder] ${row.ref}: ${head.toLowerCase()} "${name}" by ${who}${work.missing.length ? ` — working folders missing: ${work.missing.join(', ')}` : ''}`);
  const message = `✓ ${folder.created ? 'Folder created' : facts.mode === 'link' ? 'Link added' : 'Folder linked'}: “Client Documents/${name}”${work.missing.length ? '' : ' with the four working folders'}. `
    + (recorded === 'already' ? 'The case already recorded a folder, so its link was left as it was. ' : 'It is linked on the case — use “📁 OneDrive” at the top. ')
    + (work.missing.length ? `Some working folders could not be made (${work.missing.join(', ')}) — see the note on the case. ` : '')
    + (noted ? '' : 'The note on the Monday item could not be posted. ')
    + 'Nothing was sent to the client.';
  return { ok: true, mode: facts.mode, created: !!folder.created, caseRef: row.ref, name, folderId: folder.id, url, workFolders: work, recorded, noted, message: message.trim() };
}

/** What the page may see of a check (no ids, no assignees). */
function publicView(f) {
  return { ok: true, caseRef: f.row ? f.row.ref : '', state: f.state, canCreate: !!f.canCreate, mode: f.mode || null, name: f.name || '',
    folders: (f.folders || []).map((x) => ({ name: x.name })), workFolders: oneDrive.CASE_WORK_FOLDERS.slice(), message: f.message };
}

module.exports = { check, createCaseFolder, decide, finishable, refInName, publicView, io, TEST_GROUP_ID, FINISH_WINDOW_MS, LINK_TEXT, _inFlight };
