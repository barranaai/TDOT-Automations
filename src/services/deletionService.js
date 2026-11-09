'use strict';

/**
 * Careful cascading delete of a client's records — admin-only, preview-first.
 *
 * Three shapes:
 *   - a LEAD with no case  → lead row + its OneDrive lead folder
 *   - a CASE, from the Cases page (team meeting point 8, Faran 2026-11-05: "the
 *     consultation record is kept forever") → Client Master row, checklist
 *     execution rows, questionnaire execution rows, family-member rows. The
 *     consultation record(s) — the lead row(s) — are KEPT and unlinked
 *     ("Case deleted" is filled in on them; nothing then opens a new case for
 *     them by itself), and NOTHING is deleted from OneDrive: the case folder is
 *     renamed back to the lead's "{name} - LEAD-{id}" so the record still finds
 *     its files. No Square booking or invoice is touched (the lead stays).
 *   - a LEAD that has a case (the bins on the Leads / Consultations / Retainers
 *     lists — the preview ESCALATES to the case so a lead delete can never
 *     orphan a case) → everything: the case rows above, every originating lead
 *     row, the client's OneDrive folder(s), Square cancels — deleting the
 *     consultation record is that explicit choice.
 *
 * Nothing is hard-deleted: Monday delete_item goes to Monday's 30-day recycle
 * bin; the Graph DELETE moves folders to the OneDrive recycle bin. Documenso
 * envelopes and Square records are NOT touched (no delete API wired) — the
 * preview says so.
 *
 * Safety rails (each earned by an adversarial-review finding):
 *   - executeDeletion re-enumerates on its own and validates the typed
 *     confirmation against the REBUILT graph; a case whose reference is still
 *     blank pins the confirmation to `CASE-{cmItemId}` — the generic word
 *     DELETE never authorises a case cascade.
 *   - the caller echoes the previewed `kind`; if the record escalated between
 *     preview and execute (lead → case, e.g. the client signed meanwhile) the
 *     execute is refused and the dialog must be reopened.
 *   - the leadId / clientMasterItemId targets are verified to live on the Lead
 *     and Client Master boards — Monday's items(ids) is account-global, and a
 *     mispasted id must never delete an arbitrary row.
 *   - a stored OneDrive folder id is resolved to its real name and parent and
 *     is only deleted when it sits directly under the Client Documents root.
 *   - if ANY child row fails to delete, the Client Master row, lead rows and
 *     folders are all KEPT, so the delete can simply be re-run by caseRef.
 *   - one in-flight delete per target (concurrent re-clicks are refused), and
 *     Monday deletes go in aliased batches so big cases finish inside the
 *     request window.
 *   - keeping the record (2026-11-05): the folder is renamed back BEFORE any lead
 *     is unlinked, every lead is unlinked (under its lock, from a fresh read)
 *     BEFORE the Client Master row goes, and any failure keeps the Client Master
 *     row — a re-run by case number finishes the job and never loses a folder
 *     (a case delete never deletes a folder at all).
 */

const mondayApi     = require('./mondayApi');
const leadService   = require('./leadService');
const oneDrive      = require('./oneDriveService');
const clientMaster  = require('./clientMasterService');
const squareBookings = require('./squareBookingsService');
const { clientMasterBoardId, leadBoardId, cmColumns } = require('../../config/monday');
const { isDirectClient } = require('../utils/directClient');

const familyBoard = require('../data/familyMembersBoard.json');
// The Leads board's "Case deleted" column (2026-11-05): written on a kept consultation record. Without it a
// case delete that keeps the record is refused — an unmarked, unlinked signed lead would be re-opened as a case.
const leadCaseDeletedCol = () => (require('../data/newLeadsBoard.json').columns || {}).caseDeleted || '';
const KEEP_LEADS_LIMIT = 50;   // findAllByColumnValue's page: at the limit there may be more — refuse rather than leave one linked

const EXEC_BOARD_ID   = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const QEXEC_BOARD_ID  = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const FAMILY_BOARD_ID = familyBoard.boardId;

const EXEC_CASE_REF_COL   = 'text_mm0z2cck';
const QEXEC_CASE_REF_COL  = 'text_mm12dgy9';
const FAMILY_CASE_REF_COL = familyBoard.columns.caseReference;
const CM_CASE_REF_COL     = 'text_mm142s49';
const CM_EMAIL_COL        = 'text_mm0xw6bp';
const CM_ONEDRIVE_ID_COL  = (cmColumns && cmColumns.oneDriveFolderId) || 'text_mm47y540';

const ROOT_FOLDER_NAME = 'Client Documents'; // must match oneDriveService.ROOT_FOLDER

const bad = (m) => { const e = new Error(m); e.badRequest = true; throw e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** I/O. All item ids+names on a board whose case-ref column equals caseRef. */
async function rowsByCaseRef(boardId, colId, caseRef) {
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:500, board_id:$b, columns:[{column_id:"${colId}", column_values:[$v]}]){ items{ id name } } }`,
    { b: String(boardId), v: String(caseRef) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => ({ id: String(it.id), name: it.name }));
}

/**
 * I/O. Which board an item lives on ('' when the item doesn't exist).
 * Monday's items(ids:) is ACCOUNT-GLOBAL — every delete target must be pinned
 * to its expected board or a mispasted id deletes an arbitrary row.
 */
async function itemBoardId(itemId) {
  const data = await mondayApi.query(
    'query($id:ID!){ items(ids:[$id]){ id board { id } } }',
    { id: String(itemId) }
  );
  const it = data?.items?.[0];
  return it && it.board ? String(it.board.id) : '';
}

/** I/O. The Client Master row (name, email, oneDriveFolderId) by item id — null unless it really is on the CM board
 *  (and not in Monday's recycle bin: a lead still pointing at a deleted case is a plain lead). */
async function readCmItem(cmItemId) {
  const data = await mondayApi.query(
    `query($id:ID!){ items(ids:[$id]){ id name state board { id } column_values(ids:["${CM_CASE_REF_COL}","${CM_EMAIL_COL}","${CM_ONEDRIVE_ID_COL}"]){ id text } } }`,
    { id: String(cmItemId) }
  );
  const it = data?.items?.[0];
  if (!it) return null;
  if (it.state === 'deleted') return null;
  if (!it.board || String(it.board.id) !== String(clientMasterBoardId)) return null;
  const g = (colId) => ((it.column_values || []).find((c) => c.id === colId) || {}).text || '';
  return { id: String(it.id), name: it.name, state: String(it.state || ''), caseRef: g(CM_CASE_REF_COL).trim(), email: g(CM_EMAIL_COL).trim(), oneDriveFolderId: g(CM_ONEDRIVE_ID_COL).trim() };
}

/** I/O. A linked case row that is NOT on the Cases board: the name of the board it is live on (moved off the Cases
 *  board — 2026-ISS-009, found 2026-11-05), or '' when it is gone (Monday's recycle bin, no such item). */
async function caseRowElsewhere(cmItemId) {
  const d = await mondayApi.query('query($id:ID!){ items(ids:[$id]){ id state board { id name } } }', { id: String(cmItemId) });
  const it = d?.items?.[0];
  if (!it || it.state === 'deleted' || !it.board || String(it.board.id) === String(clientMasterBoardId)) return '';
  return String(it.board.name || `board ${it.board.id}`);
}

/**
 * Resolve the OneDrive folders to remove. A stored folder id is looked up and
 * only accepted when the item sits DIRECTLY under the Client Documents root —
 * these ids live in staff-editable Monday text columns, and a wrong-but-valid
 * id must never recycle another client's folder (or the whole root). Name
 * candidates are root-scoped by construction. Deduped by driveItem id; lookup
 * failures degrade to a warning (the Monday side still proceeds).
 */
async function resolveFolders({ folderId, nameCandidates }) {
  const folders = [];
  const warnings = [];
  const seen = new Set();
  if (folderId) {
    try {
      const item = await oneDrive.getDriveItemById(folderId);
      if (!item) {
        warnings.push('The stored OneDrive folder id no longer exists (already deleted?) — skipping it.');
      } else if (!String(item.parentPath || '').endsWith(`/${ROOT_FOLDER_NAME}`)) {
        warnings.push(`The stored OneDrive folder id points at "${item.name}" which is NOT directly under ${ROOT_FOLDER_NAME} — refusing to touch it; remove it manually if intended.`);
      } else {
        seen.add(item.id);
        folders.push({ id: item.id, name: item.name, via: 'id' });
      }
    } catch (err) {
      warnings.push(`OneDrive lookup of the stored folder id failed (${err.message}) — that folder, if it exists, will need manual removal.`);
    }
  }
  for (const cand of nameCandidates) {
    if (!cand || !String(cand).trim()) continue;
    try {
      const hit = await oneDrive.getClientFolderByName(cand);
      if (hit && !seen.has(hit.id)) { seen.add(hit.id); folders.push({ id: hit.id, name: hit.name, via: 'name' }); }
    } catch (err) {
      warnings.push(`OneDrive lookup for "${cand}" failed (${err.message}) — that folder, if it exists, will need manual removal.`);
    }
  }
  return { folders, warnings };
}

/**
 * The plan of a Cases-page delete, noted on the CASE row before anything is changed (review round 3, 2026-11-05).
 * A run that stops part-way leaves it there, so the next run still knows every record this delete keeps and the
 * folder it renamed — even once some records are unlinked (no longer found by the case link) and the folder no
 * longer carries the case number. The plan rides in a marker in the note (base64url JSON: survives the text form).
 */
const PLAN_OPEN = '⟦keep-plan ', PLAN_CLOSE = '⟧';
const planMarker = (p) => `${PLAN_OPEN}${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}${PLAN_CLOSE}`;
const NOTE_PAGES = 10;   // notes are looked through 100 a page, newest first, up to 1,000
async function readKeepPlan(cmItemId) {
  for (let page = 1; page <= NOTE_PAGES; page++) {
    const d = await mondayApi.query('query($id:[ID!],$p:Int!){ items(ids:$id, limit:1){ updates(limit:100, page:$p){ text_body } } }', { id: [String(cmItemId)], p: page });
    const ups = (d && d.items && d.items[0] && d.items[0].updates) || [];
    for (const u of ups) {   // newest first
      const t = String(u.text_body || '');
      const a = t.lastIndexOf(PLAN_OPEN); if (a < 0) continue;
      const b = t.indexOf(PLAN_CLOSE, a + PLAN_OPEN.length); if (b < 0) continue;
      try {
        const p = JSON.parse(Buffer.from(t.slice(a + PLAN_OPEN.length, b).trim(), 'base64url').toString('utf8'));
        if (p && p.v === 1 && Array.isArray(p.leads)) return p;
      } catch (_) { /* not a plan */ }
    }
    if (ups.length < 100) return null;
  }
  return null;
}

/** I/O. Monday's state of each item ('active' | 'archived' | 'deleted'); an item Monday does not return is left out. */
async function itemStates(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const d = await mondayApi.query('query($id:[ID!]){ items(ids:$id, limit:50){ id state } }', { id: ids.slice(i, i + 50).map(String) });
    for (const it of (d && d.items) || []) out.set(String(it.id), String(it.state || ''));
  }
  return out;
}

/** The "Case deleted" marker names its case between " · " separators (date · case · who) — never a prefix match. */
const markerNames = (caseDeleted, ref) => ` ${String(caseDeleted || '')} `.includes(` · ${ref} · `);

/**
 * The records of an earlier plan, each read fresh (review round 4 — the column search lags a write): `aside` = set
 * aside for THIS case (no link, its marker names the case; not in Monday's recycle bin), `relinked` = linked to this
 * case again but missed by the search. Records in `skip` (found linked already) are not read. A read error refuses.
 */
async function planRecords(prior, cmId, ref, skip) {
  const aside = [], relinked = [], seen = new Set(skip);
  for (const l of ((prior && prior.leads) || []).slice(0, KEEP_LEADS_LIMIT)) {
    const id = String(l.id);
    if (seen.has(id)) continue;
    seen.add(id);
    let cur;
    try { cur = await leadService.getLead(id); }
    catch (err) { bad(`Consultation record ${id} could not be read (${err.message}) — nothing was deleted. Try again in a minute.`); }
    if (!cur) continue;
    const link = String(cur.clientMasterItemId || '').trim();
    if (link === String(cmId)) relinked.push(cur);
    else if (!link && markerNames(cur.caseDeleted, ref)) aside.push(cur);
  }
  if (!aside.length && !relinked.length) return { aside, relinked };
  let states;
  try { states = await itemStates([...aside, ...relinked].map((l) => l.id)); }
  catch (err) { bad(`Monday could not be checked (${err.message}) — nothing was deleted. Try again in a minute.`); }
  const live = (l) => states.get(String(l.id)) !== 'deleted';
  return { aside: aside.filter(live), relinked: relinked.filter(live) };
}

/** The lead's folder name: the client name the record knows it by (clientFolderRefs.candidateFolderState), with the
 *  characters OneDrive does not allow stripped — as every folder the app makes (ensureLeadFolder, caseFolderName).
 *  The record finds it by the " - LEAD-{id}" ending, so a stripped name is found all the same. */
const leadFolderName = (l) => {
  const name = String((l && (l.fullName || l.name)) || '').replace(/[*:"<>?/\\|]/g, '').trim() || `Lead ${l && l.id}`;
  return `${name} - LEAD-${l && l.id}`;
};
const escNote = (v) => String(v == null ? '' : v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * Keeping the record (2026-11-05): which folder to rename back to the lead's name, if any.
 * The case folder is THE root folder whose name ends " - {case number}" (the suffix lookup every case read uses —
 * never an exact name: names drift). Its owner is the only kept lead, or the one kept lead whose stored folder id is
 * that folder. Nothing is planned (and the preview says why) when: the case has no number yet (the folder never took
 * it), no folder or two folders carry the number, the owner is unclear, or the record already has a folder of its
 * own (a root folder ending " - LEAD-{id}") — renaming would make two. (Only the ending counts: an unlinked record
 * finds its folder by that ending alone, so a stored id naming a folder WITHOUT it is no folder the record can use.)
 * A re-run after an earlier run renamed the folder already: `returned` describes it, so the undo steps still say
 * how to put the case number back.
 * If OneDrive cannot answer, the delete is REFUSED (preview and execute alike): going ahead without the rename
 * would leave the kept record unable to find its files, with the case row — the only way to re-run — gone.
 */
async function planFolderReturn(cm, kept, prior = null) {
  const none = (why) => ({ plan: null, note: why });
  const ask = async (fn) => {
    try { return await fn(); } catch (err) {
      bad(`OneDrive could not be checked (${err.message}) — nothing was deleted. Try again in a minute: the consultation record's folder must be found first.`);
    }
  };
  if (!cm.caseRef) return none('');   // the folder never took the case number: it still has the lead's name
  const keptIds = new Set(kept.map((l) => String(l.id)));
  const named = (fs) => fs.map((f) => `“${f.name}”`).join(', ');
  const plannedId = prior && prior.id ? String(prior.id) : '';
  // 1. The rename an earlier, stopped run of this delete already made (review round 4): its plan, noted on the case
  //    row, names the folder BY ITS ID and its owner. It stands whatever else carries the case number now — a folder
  //    carrying it at this point was made after that run (the case was still open and wrote files): KEPT as it is,
  //    and named in every note's way back. Another folder ending with the owner's lead number is not it.
  if (prior && prior.from && prior.owner && keptIds.has(String(prior.owner))) {
    const back = (await ask(() => oneDrive.findCaseFoldersByRef(`LEAD-${prior.owner}`))).filter((f) => !plannedId || String(f.id) === plannedId);
    if (back.length) {
      const later = await ask(() => oneDrive.findCaseFoldersByRef(cm.caseRef));
      return {
        plan: null,
        returned: { id: String(back[0].id), to: back[0].name, from: String(prior.from), owner: String(prior.owner) },
        later: later.map((f) => f.name),
        note: `The OneDrive folder was already renamed back to “${back[0].name}” (an earlier run of this delete). Nothing is deleted from OneDrive.` +
          (later.length ? ` ${later.length > 1 ? `${later.length} folders made since then also carry` : 'A folder made since then also carries'} the case number (${named(later)}) — KEPT as ${later.length > 1 ? 'they are' : 'it is'}: ${later.length > 1 ? 'they hold' : 'it holds'} what was added while the delete was stopped. Move ${later.length > 1 ? 'those files' : 'its files'} into “${back[0].name}” by hand in OneDrive — the record that owns it finds only that folder (the notes say so too).` : ''),
      };
    }
  }
  const caseFolders = await ask(() => oneDrive.findCaseFoldersByRef(cm.caseRef));
  if (!caseFolders.length) {
    // An earlier run renamed it back already, and its plan could not name it: the case row's own folder, now ending
    // " - LEAD-{id}" of a record this delete keeps. Nothing to do — but the undo steps must still give the way back.
    const ours = new Set([...keptIds, ...((prior && prior.leads) || []).map((l) => String(l.id))]);
    const sid = String(cm.oneDriveFolderId || '').trim();
    if (sid) {
      const item = await ask(() => oneDrive.getDriveItemById(sid));
      const m = item && String(item.parentPath || '').endsWith(`/${ROOT_FOLDER_NAME}`) ? / - LEAD-(\d+)$/.exec(String(item.name || '')) : null;
      if (m && ours.has(m[1])) {
        const back = `${String(item.name).slice(0, String(item.name).length - m[0].length)} - ${cm.caseRef}`;
        return { plan: null, note: `The OneDrive folder was already renamed back to “${item.name}” (an earlier run of this delete). Nothing is deleted from OneDrive.`, returned: { id: String(item.id), to: item.name, from: back, owner: m[1] }, later: [] };
      }
    }
    return none('No OneDrive folder carries this case number — there is nothing to rename. Nothing is deleted from OneDrive.');
  }
  if (caseFolders.length > 1) return none(`${caseFolders.length} OneDrive folders carry this case number — all are KEPT as they are (check them in OneDrive): the consultation record may not find its files until one is renamed to the lead's name.`);
  const folder = caseFolders[0];
  // Its owner: the earlier plan's owner while it is still a record this delete keeps (round 4 — also when that record
  // was set aside already); else the only record; else the record whose stored folder id is that folder.
  const planOwner = prior && prior.owner ? kept.find((l) => String(l.id) === String(prior.owner)) : null;
  const owners = planOwner ? [planOwner] : kept.length === 1 ? kept : kept.filter((l) => String(l.oneDriveFolderId || '').trim() === String(folder.id));
  if (owners.length !== 1) return none(kept.length ? `The OneDrive folder "${folder.name}" is KEPT as it is — it is not clear which consultation record owns it.` : `The OneDrive folder "${folder.name}" is KEPT as it is. Nothing is deleted from OneDrive.`);
  const owner = owners[0];
  const to = leadFolderName(owner);
  // The record's own folder already there (a root folder ending " - LEAD-{id}"): renaming would make two.
  const own = (await ask(() => oneDrive.findCaseFoldersByRef(`LEAD-${owner.id}`))).filter((f) => String(f.id) !== String(folder.id));
  if (own.length) {
    // The record was set aside by an earlier run of this delete, yet the case's folder still carries the case number
    // (the rename never happened, or was given back) and another folder now ends with its lead number — made after
    // that run (a late signature, a transcript). The rename is owed, and two folders must never end alike: merge first.
    let fresh = null;
    if (planOwner) {
      try { fresh = await leadService.getLead(String(owner.id)); }
      catch (err) { bad(`Consultation record ${owner.id} could not be read (${err.message}) — nothing was deleted. Try again in a minute.`); }
    }
    if (fresh && !String(fresh.clientMasterItemId || '').trim()) {
      bad(`Consultation record ${owner.fullName || owner.name || owner.id} (${owner.id}) was set aside by an earlier run of this delete, but the case’s folder “${folder.name}” still carries the case number and another folder, “${own[0].name}”, now ends with the record’s lead number (made after that run). In OneDrive, move the files from “${own[0].name}” into “${folder.name}” and delete the empty “${own[0].name}”, then run the delete again. Nothing more was changed.`);
    }
    return none(`The OneDrive folder "${folder.name}" is KEPT as it is — the consultation record already has its own folder "${own[0].name}".`);
  }
  return { plan: { id: String(folder.id), from: folder.name, to, leadId: String(owner.id) }, note: '' };
}

/** The full deletion graph for a CASE, rooted at the Client Master item. keepLeads: the Cases-page delete (point 8). */
async function caseGraph(cm, { keepLeads = false } = {}) {
  const caseRef = cm.caseRef;
  // Every child row below is found by the case NUMBER. If two cases carry it
  // (2026-CEC-EE-086, found 2026-10-01), deleting "one" would delete the other
  // client's checklist, questionnaire and family rows too — so refuse, here,
  // before the preview even shows a count.
  if (caseRef) {
    const carriers = await rowsByCaseRef(clientMasterBoardId, CM_CASE_REF_COL, caseRef);
    if (carriers.length > 1) {
      bad(`Case number ${caseRef} is on ${carriers.length} cases (${carriers.map((c) => `"${c.name}"`).join(', ')}). ` +
        'Give all but one of them a new number first — deleting now would also delete the other client\'s checklist, questionnaire and family rows.');
    }
  }
  const [execRows, qexecRows, familyRows, leads] = await Promise.all([
    caseRef ? rowsByCaseRef(EXEC_BOARD_ID, EXEC_CASE_REF_COL, caseRef) : [],
    caseRef ? rowsByCaseRef(QEXEC_BOARD_ID, QEXEC_CASE_REF_COL, caseRef) : [],
    caseRef ? rowsByCaseRef(FAMILY_BOARD_ID, FAMILY_CASE_REF_COL, caseRef) : [],
    leadService.findAllByColumnValue('clientMasterItemId', String(cm.id)),
  ]);

  const folderId = cm.oneDriveFolderId || (leads.find((l) => l.oneDriveFolderId) || {}).oneDriveFolderId || '';

  if (!keepLeads) {
    // A Cases-page delete of this case that has not finished (review round 4): the records it set aside keep their
    // folder (the case row's own folder, renamed to the lead's name) — a full delete would take it, and the case row
    // that lets the delete be finished. Finish it first. Every plan record is read fresh (the column search lags).
    let prior = null;
    try { prior = await readKeepPlan(cm.id); }
    catch (err) { bad(`The case’s notes could not be read (${err.message}) — nothing was deleted. Try again in a minute.`); }
    const ref = caseRef || `CASE-${cm.id}`;
    const { aside } = await planRecords(prior, cm.id, ref, []);
    if (aside.length) bad(`A delete of case ${ref} from the Cases page already set aside ${aside.map((l) => `${l.fullName || l.name || `Lead ${l.id}`} (${l.id})`).join(', ')} (kept, marked “Case deleted”, with ${aside.length > 1 ? 'their' : 'its'} folder) and has not finished. Finish it on the Cases page — run the delete of ${ref} again there${cm.state === 'archived' ? ' (its case row is archived in Monday: restore it from the archive first)' : ''}. Nothing was deleted.`);
  }

  if (keepLeads) {
    // The consultation record is kept forever (point 8): the lead rows stay, unlinked and marked; no folder is deleted.
    if (leads.length >= KEEP_LEADS_LIMIT) bad(`${leads.length} or more consultation records are linked to this case — too many to be sure all are kept. Nothing was deleted; ask for help.`);
    // An earlier run that stopped part-way: its plan names the records it already set aside (unlinked — no longer found
    // by the case link) and the folder it renamed. Every plan record is read fresh: one set aside for THIS case counts
    // (not one in Monday's recycle bin), and one linked to this case again that the lagging search missed is set aside
    // like any linked record.
    const ref = caseRef || `CASE-${cm.id}`;
    let prior = null;
    try { prior = await readKeepPlan(cm.id); }
    catch (err) { bad(`The case’s notes could not be read (${err.message}) — nothing was deleted. Try again in a minute.`); }
    const { aside: earlierRows, relinked } = await planRecords(prior, cm.id, ref, leads.map((l) => String(l.id)));
    leads.push(...relinked);
    if (leads.length && !leadCaseDeletedCol()) bad('The Leads board has no "Case deleted" column set up in the app yet — nothing was deleted (a kept consultation record must be marked). Ask for help.');
    const earlier = earlierRows.map((l) => ({ id: String(l.id), name: String(l.fullName || l.name || `Lead ${l.id}`) }));
    const { plan, note, returned, later } = (leads.length || earlier.length)
      ? await planFolderReturn(cm, [...leads, ...earlierRows], prior)
      : { plan: null, note: '', returned: null, later: [] };
    const names = leads.map((l) => l.fullName || l.name || `Lead ${l.id}`);
    // A retainer agreement still out for signature (review 2026-11-05): the client can still sign it — recorded, no case.
    const outForSignature = leads.filter((l) => String(l.retainerSent || '').trim() && !String(l.retainerSigned || '').trim())
      .map((l) => l.fullName || l.name || `Lead ${l.id}`);
    return {
      kind: 'case',
      keepLeads: true,
      caseRef,
      confirmText: caseRef || `CASE-${cm.id}`,
      client: { name: cm.name, email: cm.email },
      cmItemId: cm.id,
      execRows, qexecRows, familyRows,
      leads: [],          // nothing of the consultation record is deleted or cancelled
      keptLeads: leads.map((l) => ({ id: String(l.id), name: l.fullName || l.name || `Lead ${l.id}` })),   // still linked: unlinked now
      earlierLeads: earlier,   // set aside by an earlier, stopped run of this delete
      keptAll: [...leads.map((l) => ({ id: String(l.id), name: l.fullName || l.name || `Lead ${l.id}` })), ...earlier],
      priorPlan: prior,
      folders: [],        // a case delete never deletes a OneDrive folder
      folderPlan: plan,
      folderReturned: returned || null,   // renamed back by an earlier run of this delete (for the undo steps)
      // The folder step this delete owns, by the folder's id: renamed now (plan), or by an earlier run (returned).
      folderStep: plan ? { id: plan.id, from: plan.from, to: plan.to, owner: plan.leadId, renameNow: true }
        : (returned && returned.id ? { id: returned.id, from: returned.from, to: returned.to, owner: returned.owner, renameNow: false } : null),
      folderLater: later || [],   // folders made while the delete was stopped that carry the case number (KEPT)
      warnings: [
        leads.length
          ? `The consultation record${leads.length > 1 ? 's' : ''} (${names.join(', ')}) ${leads.length > 1 ? 'are' : 'is'} KEPT on the Leads board — outcome, retainer dates, payments and notes stay — and no longer linked to this case. “Case deleted” is filled in on ${leads.length > 1 ? 'them' : 'it'}, and the app never opens a new case for ${leads.length > 1 ? 'them' : 'it'} by itself.`
          : (earlier.length ? '' : 'No consultation record (lead) is linked to this case.'),
        earlier.length ? `An earlier run of this delete already set aside ${earlier.map((l) => `${l.name} (${l.id})`).join(', ')} (kept, marked “Case deleted”) — this run finishes the rest.` : '',
        plan ? `The OneDrive folder is KEPT and renamed back to “${plan.to}”, so the consultation record finds its files. Nothing is deleted from OneDrive.`
          : (note || 'Nothing is deleted from OneDrive.'),
        'No Square booking or invoice is touched.',
        outForSignature.length ? `A retainer agreement sent to ${outForSignature.join(', ')} is still out for signature: if it is signed, the signature is recorded but no case opens and no payment request goes out. Void it in Documenso if it should not be signed.` : '',
        'The client’s account row on the Clients board (if any) is KEPT — it is cross-application history, and other cases may link to it.',
        'Monday rows go to Monday’s recycle bin (30-day recovery).',
      ].filter(Boolean),
    };
  }

  const nameCandidates = [];
  if (caseRef) nameCandidates.push(`${cm.name} - ${caseRef}`);
  for (const l of leads) nameCandidates.push(`${l.fullName || cm.name} - LEAD-${l.id}`);
  const { folders, warnings } = await resolveFolders({ folderId, nameCandidates });

  return {
    kind: 'case',
    caseRef,
    // A blank reference (webhook not fired yet / case type rejected) must NOT
    // degrade the confirmation to the generic word DELETE — pin it to the item.
    confirmText: caseRef || `CASE-${cm.id}`,
    client: { name: cm.name, email: cm.email },
    cmItemId: cm.id,
    execRows, qexecRows, familyRows,
    leads: leads.map((l) => ({ id: String(l.id), name: l.fullName || `Lead ${l.id}`,
                               squareBookingId: l.squareBookingId || '', slot: l.bookedSlot || '',
                               invoiceId: (() => { try { return JSON.parse(l.consultOption || '{}').invoiceId || ''; } catch (_) { return ''; } })() })),
    folders,
    warnings: [
      ...warnings,
      'The client’s account row on the Clients board (if any) is KEPT — it is cross-application history, and other cases may link to it.',
      'The Square consultation appointment (if any) IS cancelled, freeing the slot. Documenso envelopes (signed agreements) and Square payment records are NOT deleted — remove those manually if needed.',
      'Monday rows go to Monday’s recycle bin (30-day recovery); OneDrive folders go to the OneDrive recycle bin.',
    ],
  };
}

/** The deletion graph for a case-less LEAD. `leadOnly`: a folder carrying a case number refuses (never just kept). */
async function leadGraph(lead, { leadOnly = false } = {}) {
  // A record a Cases-page delete set aside while that delete has NOT finished — its case row still exists (the row goes
  // last): the record's folder is still that case's folder, renamed to the lead's name (review round 4). The marker
  // carries the case row's item id, so an archived row or one moved to another board is found too (round 5).
  const marker = String(lead.caseDeleted || '').trim();
  const markRef = String(marker.split(' · ')[1] || '').trim();
  if (markRef && !String(lead.clientMasterItemId || '').trim()) {
    const caseId = (/ · item (\d+)$/.exec(marker) || /^CASE-(\d+)$/.exec(markRef) || [])[1] || '';
    let row = null, board = '';
    try {
      if (caseId) { row = await readCmItem(caseId); if (!row) board = await caseRowElsewhere(caseId); }
      else if (await clientMaster.findItemByCaseRef(markRef)) row = { state: 'active' };
    } catch (err) { bad(`Case ${markRef} could not be looked up (${err.message}) — nothing was deleted. Try again in a minute.`); }
    if (row || board) {
      const how = board
        ? `Its case row is on the Monday board “${board}”, not the Cases board: move it back (ask for help), then run the delete of ${markRef} again on the Cases page.`
        : row.state === 'archived'
          ? `Its case row is archived in Monday: restore it from the archive, then run the delete of ${markRef} again on the Cases page.`
          : `Run the delete of ${markRef} again on the Cases page first.`;
      bad(`This record was set aside by a delete of case ${markRef} from the Cases page that has not finished — the case row is still there, and this record's folder is still that case's. ${how} If the case was restored on purpose, clear “Case deleted” on this record (and link it to the case again). Nothing was deleted.`);
    }
  }
  const { folders: found, warnings } = await resolveFolders({
    folderId: lead.oneDriveFolderId || '',
    nameCandidates: [`${lead.fullName || `Lead ${lead.id}`} - LEAD-${lead.id}`],
  });
  // A folder that carries a CASE NUMBER is a case's folder (review round 4): never deleted with a plain record — KEPT,
  // and said plainly (a case that is archived, or moved to a board the app cannot see, is not gone).
  const folders = [];
  for (const f of found) {
    const m = / - (\d{4}-[A-Z]+(?:-[A-Z]+)*-\d+)$/.exec(String(f.name || ''));
    if (!m) { folders.push(f); continue; }
    if (leadOnly) bad(LEAD_ONLY_REFUSAL);
    const live = await clientMaster.findItemByCaseRef(m[1]).catch(() => null);
    warnings.push(live
      ? `The OneDrive folder “${f.name}” belongs to case ${m[1]}, which is on the Cases board — it is KEPT (a case’s folder is never deleted with a record).`
      : `The OneDrive folder “${f.name}” carries case number ${m[1]} — it is KEPT (a case’s folder is never deleted with a record). If that case is surely gone, remove the folder by hand in OneDrive.`);
  }
  return {
    kind: 'lead',
    confirmText: 'DELETE',
    client: { name: lead.fullName || `Lead ${lead.id}`, email: lead.email || '' },
    leads: [{ id: String(lead.id), name: lead.fullName || `Lead ${lead.id}`,
              squareBookingId: lead.squareBookingId || '', slot: lead.bookedSlot || '',
              invoiceId: (() => { try { return JSON.parse(lead.consultOption || '{}').invoiceId || ''; } catch (_) { return ''; } })() }],
    execRows: [], qexecRows: [], familyRows: [], cmItemId: null, caseRef: '',
    folders,
    warnings: [
      ...warnings,
      ...(lead.squareBookingId ? ['The Square consultation appointment is cancelled, freeing the slot on the calendar.'] : []),
      'Documenso envelopes (if any agreement was sent) are NOT deleted.',
      'The Monday row goes to Monday’s recycle bin (30-day recovery); the OneDrive folder goes to the OneDrive recycle bin.',
    ],
  };
}

/**
 * Lead-only delete (Faran 2026-11-09, step 3 decision 6): staff on LEAD_DELETE_EMAILS may delete a LEAD with no
 * case — never a case, never a client with a retainer. Read from a FRESH lead (never the list copy); checked again
 * inside the delete itself (executeDeletion → buildGraph), as the lead can gain a case between preview and delete.
 */
const LEAD_ONLY_REFUSAL = 'This lead has a case (or a retainer) — only an admin can delete it. Nothing was deleted.';
function leadOnlyRefusal(lead) {
  const t = (v) => String(v == null ? '' : v).trim();
  if (t(lead.clientMasterItemId)) return LEAD_ONLY_REFUSAL;           // even when that case row is gone: an admin handles it
  if (t(lead.caseDeleted)) return LEAD_ONLY_REFUSAL;                  // a kept consultation record of a deleted case
  if (isDirectClient(lead)) return LEAD_ONLY_REFUSAL;                 // a direct retainer client (walk-ins whose case opened early too)
  if (t(lead.conversionStatus) === 'Retained') return LEAD_ONLY_REFUSAL;
  if (t(lead.retainerSent) || t(lead.retainerSigned) || t(lead.retainerPaid)) return LEAD_ONLY_REFUSAL;
  return '';
}

/**
 * Build the deletion graph for a lead or a case. A lead that already has a
 * Client Master case ESCALATES to the full case graph — deleting a lead can
 * never silently leave an orphaned case behind.
 */
async function buildGraph({ leadId, caseRef, recordOnly = false, leadOnly = false }) {
  if (leadOnly && (caseRef || !leadId)) bad('Only admins can delete cases. Nothing was deleted.');
  if (leadOnly && recordOnly) bad(LEAD_ONLY_REFUSAL);
  if (caseRef) {
    const cmId = await clientMaster.findItemByCaseRef(String(caseRef).trim());
    if (!cmId) bad(`No case found with reference "${caseRef}".`);
    const cm = await readCmItem(cmId);
    if (!cm) bad(`Case ${caseRef} could not be read from the Client Master board.`);
    return caseGraph(cm, { keepLeads: true });   // the Cases page: the consultation record is kept (point 8)
  }
  if (leadId) {
    // Pin the id to the Lead board FIRST — items(ids) is account-global and a
    // pasted id from any Monday URL must never be deletable as a "lead".
    const board = await itemBoardId(leadId);
    if (!board) bad(`Lead ${leadId} not found.`);
    if (String(board) !== String(leadBoardId)) {
      bad(`Item ${leadId} is not on the Lead Board — refusing to delete it as a lead. If it is a case, delete it by its case reference.`);
    }
    const lead = await leadService.getLead(String(leadId));
    if (!lead) bad(`Lead ${leadId} not found.`);
    if (leadOnly) {
      const why = leadOnlyRefusal(lead);
      if (why) bad(why);
      const g = await leadGraph(lead, { leadOnly: true });
      if (g.kind !== 'lead') bad(LEAD_ONLY_REFUSAL);
      return g;
    }
    if (lead.clientMasterItemId) {
      const cm = await readCmItem(lead.clientMasterItemId);
      if (cm) {
        // The Retained tab's bin (review round 4): "Case not found" there comes from a short-lived copy of the active
        // rows — an archived case, or one just moved back, is still a case. Never a full delete from that bin.
        if (recordOnly) {
          const how = !cm.caseRef ? 'That case has no case number, so the Cases page cannot delete it — ask for help.'
            : cm.state === 'archived'
              ? 'Its case row is archived in Monday: restore it from the archive, then delete the case on the Cases page (the consultation record is kept).'
              : `Delete case ${cm.caseRef} on the Cases page first — the consultation record is kept.`;
          bad(`This client’s case${cm.caseRef ? ` ${cm.caseRef}` : ''} is still on the Cases board — this bin deletes only a record whose case is gone. ${how} If this record is not that client’s (a duplicate), clear its “Client Master Item ID” in Monday and delete it again. Nothing was deleted.`);
        }
        return caseGraph(cm);
      }
      // Not on the Cases board. Gone (Monday's recycle bin, no such item) → a plain lead. Live on ANOTHER board → the
      // case was moved off the Cases board and is not gone (2026-ISS-009): deleting the record would take its folder.
      const where = await caseRowElsewhere(lead.clientMasterItemId);
      if (where) bad(`This record is linked to a case row on the Monday board “${where}”, not on the Cases board — the case was moved, it is not gone, and deleting the record would take its OneDrive folder. Nothing was deleted. Move the case row back to the Cases board (ask for help); if the link is wrong, clear “Client Master Item ID” on the lead and delete again.`);
    }
    return leadGraph(lead);
  }
  bad('Provide a leadId or a caseRef.');
}

/** What a delete WOULD remove — shown in the confirm dialog. */
async function previewDeletion({ leadId, caseRef, recordOnly = false, leadOnly = false }) {
  const g = await buildGraph({ leadId, caseRef, recordOnly, leadOnly });
  return {
    kind: g.kind,
    caseRef: g.caseRef || '',
    confirmText: g.confirmText,
    client: g.client,
    keepsLeads: !!g.keepLeads,
    // What stays (point 8): the consultation record(s), and the folder — renamed back to the lead's name when planned.
    kept: g.keepLeads ? { leadRows: (g.keptAll || g.keptLeads || []).map((l) => l.name), folderRename: g.folderPlan ? { from: g.folderPlan.from, to: g.folderPlan.to } : null } : null,
    targets: {
      clientMasterRow: g.cmItemId ? 1 : 0,
      checklistRows: g.execRows.length,
      questionnaireRows: g.qexecRows.length,
      familyMemberRows: g.familyRows.length,
      leadRows: g.leads.map((l) => l.name),
      oneDriveFolders: g.folders.map((f) => f.name),
      // Consultation slots on the real Square calendar. Cancelled during
      // execute, BEFORE the lead rows go — the booking id lives on the lead.
      squareAppointments: g.leads.filter((l) => l.squareBookingId)
        .map((l) => `${l.name}${l.slot ? ` — ${l.slot}` : ''}`),
    },
    warnings: g.warnings,
  };
}

/**
 * I/O. Delete Monday rows in aliased batches (one mutation per BATCH, not per
 * row) so large cases finish inside the request window. If a batch fails it
 * falls back to per-item deletes so one bad row never takes out the honesty of
 * the whole batch's accounting.
 * @returns {Promise<{ deleted: number, errors: string[] }>}
 */
async function deleteMondayRows(rows, label) {
  const BATCH = 20;
  let deleted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const safeIds = chunk.map((r) => String(r.id).replace(/\D/g, '')).filter(Boolean);
    const mutation = 'mutation { ' + safeIds.map((id, n) => `d${n}: delete_item(item_id: ${id}) { id }`).join(' ') + ' }';
    try {
      await mondayApi.query(mutation, {});
      deleted += safeIds.length;
    } catch (_) {
      // batch failed → per-item fallback keeps the count honest
      for (const id of safeIds) {
        try {
          await mondayApi.query('mutation($id:ID!){ delete_item(item_id:$id){ id } }', { id });
          deleted++;
        } catch (err) {
          errors.push(`${label} ${id}: ${err.message}`);
        }
        await sleep(120);
      }
    }
    if (i + BATCH < rows.length) await sleep(250);
  }
  return { deleted, errors };
}

// One in-flight delete per target: a proxy timeout must not let a re-click
// interleave a second cascade with the first (spurious failures, wrong summary).
const _inFlight = new Set();

/**
 * Perform the delete. Re-enumerates the graph (never trusts a client-supplied
 * list), verifies the typed confirmation AND the previewed kind, then removes
 * children first: checklist/questionnaire/family rows → Client Master row →
 * lead row(s) → OneDrive folder(s). If ANY child row failed, the parents and
 * folders are kept so the whole delete can simply be re-run by caseRef.
 */
async function executeDeletion({ leadId, caseRef, confirmText, expectedKind, actor, recordOnly = false, leadOnly = false }) {
  if (leadOnly && (caseRef || !leadId)) bad('Only admins can delete cases. Nothing was deleted.');
  if (leadOnly && expectedKind !== 'lead') bad('Close the dialog and open it again. Nothing was deleted.');
  const key = caseRef ? `case:${String(caseRef).trim()}` : `lead:${String(leadId).trim()}`;
  if (_inFlight.has(key)) bad('A delete for this record is already running — wait for it to finish, then refresh the list.');
  _inFlight.add(key);
  let caseKey = '';
  try {
    // One delete per CASE at a time, whichever bin started it (review round 4) — taken BEFORE anything else is read, so
    // no run ever acts on a picture of the case read while another delete of it was running.
    const lockId = await caseRowIdOf({ leadId, caseRef });
    if (lockId) {
      const k = `cm:${lockId}`;
      if (_inFlight.has(k)) bad('A delete of this case is already running — wait for it to finish, then refresh the list.');
      _inFlight.add(k); caseKey = k;
    }
    const g = await buildGraph({ leadId, caseRef, recordOnly, leadOnly });
    if (g.cmItemId && String(g.cmItemId) !== String(lockId)) bad('This record changed while the delete was starting — close the window, refresh the list and try again. Nothing was deleted.');
    if (expectedKind && expectedKind !== g.kind) {
      bad(g.kind === 'case'
        ? 'This record changed since the preview (it now has an open case). Close the dialog and re-open it to see the full scope.'
        : 'This record changed since the preview (its case was deleted or unlinked meanwhile). Close the dialog and re-open it to see what a delete would remove now.');
    }
    const expected = g.confirmText;
    if (String(confirmText || '').trim() !== expected) {
      bad(`Confirmation text does not match — type "${expected}" exactly to delete.`);
    }

    // The case number must stay used after its case is gone (nothing of the
    // case is left for the allocator to find, and restoring it from the
    // recycle bins must never collide with a new client): record it in the
    // high-water mark FIRST — and refuse to delete when that cannot be done.
    if (g.kind === 'case' && g.caseRef && /^\d{4}-[A-Z]+(?:-[A-Z]+)*-\d+$/.test(g.caseRef)) {
      const saved = await require('./caseRefAllocator').recordAssigned(g.caseRef).catch(() => false);
      if (!saved) bad(`Could not record case number ${g.caseRef} as used in OneDrive ("TDOT System/case-number-high-water.json") — nothing was deleted. Try again in a minute; if it keeps failing, OneDrive is unavailable.`);
    }

    const failures = [];
    const deleted = { checklistRows: 0, questionnaireRows: 0, familyMemberRows: 0, clientMasterRow: 0, leadRows: 0, oneDriveFolders: 0, squareAppointmentsCancelled: 0 };
    const kept = g.keepLeads ? { leadRows: 0, folderRenamed: 0, leadsAlreadyUnlinked: 0 } : null;
    if (kept && g.folderReturned) kept.folderRenamedEarlier = 1;   // a re-run says the whole result
    // "date · case · who · item {case row id}" — the item id lets a record's own bin find an unfinished delete's case row
    // even when it is archived or moved (round 5); markerNames matches ' · {case} · '.
    const marker = g.keepLeads ? `${torontoDay()} · ${g.caseRef || `CASE-${g.cmItemId}`} · ${actor || 'admin'} · item ${g.cmItemId}` : '';

    // Keeping the record (review round 3): the plan goes on the case row BEFORE anything is changed — a run that
    // stops part-way leaves it for the next run (every record kept, the folder names). Not noted → nothing deleted.
    if (g.keepLeads && (g.keptAll || []).length) {
      // The folder step, by the folder's id: this run's rename, else the rename an earlier run made (still in place) —
      // never dropped; and the folders made while the delete was stopped (named in every note's way back).
      const st = g.folderStep;
      const fp = st ? { id: st.id, from: st.from, to: st.to, owner: st.owner } : {};
      const later = (g.folderLater || []).slice().sort();
      const pp = g.priorPlan;
      const same = !!pp && (pp.id || '') === (fp.id || '') && (pp.from || '') === (fp.from || '') && (pp.to || '') === (fp.to || '')
        && (pp.later || []).slice().sort().join('|') === later.join('|')
        && pp.leads.map((l) => String(l.id)).sort().join(',') === g.keptAll.map((l) => l.id).sort().join(',');
      if (!same) {
        const body = `🗑 <b>Deleting this case from the Cases page — the consultation record is kept</b> (${escNote(marker)}). ` +
          `Kept: ${g.keptAll.map((l) => `${escNote(l.name)} (${l.id})`).join(', ')}.` +
          (fp.from ? ` OneDrive folder “${escNote(fp.from)}” → renamed back to “${escNote(fp.to)}”.` : '') +
          (later.length ? ` Made while the delete was stopped, also carrying the case number: ${later.map((x) => `“${escNote(x)}”`).join(', ')}.` : '') +
          ` If the delete stops part-way, running it again finishes it from this plan. ${planMarker({ v: 1, leads: g.keptAll, ...fp, ...(later.length ? { later } : {}) })}`;
        if (!(await postNote(g.cmItemId, body))) bad('The delete could not be noted on the case (Monday did not answer) — nothing was deleted. Try again in a minute.');
      }
    }

    for (const [countKey, rows] of [['checklistRows', g.execRows], ['questionnaireRows', g.qexecRows], ['familyMemberRows', g.familyRows]]) {
      const r = await deleteMondayRows(rows, countKey);
      deleted[countKey] = r.deleted;
      failures.push(...r.errors);
    }

    // Free the Square consultation slot(s) BEFORE any lead row goes — the
    // booking id lives only on the lead, so once the row is deleted a failed
    // cancel could never be retried. Runs even when child rows failed (the
    // cancel is idempotent: a re-run sees CANCELLED / not-found and no-ops),
    // but a cancel FAILURE joins the child failures and keeps every parent,
    // so the id survives for the re-run.
    for (const l of g.leads) {
      // An outstanding consultation INVOICE must not survive its lead — a
      // client could still pay it after the lead is gone. Best-effort with the
      // same retry semantics as the appointment cancel below (idempotent;
      // failure keeps the parents so the id survives for a re-run).
      if (l.invoiceId) {
        try {
          const ri = await require('./squareInvoicesService').cancelInvoice(l.invoiceId);
          console.log(`[Deletion] Consultation invoice ${l.invoiceId} → ${ri.status} (${l.name})`);
        } catch (err) {
          failures.push(`Consultation invoice ${l.invoiceId} for ${l.name} could not be cancelled: ${squareBookings.squareErrorText(err)}`);
        }
      }
      if (!l.squareBookingId) continue;
      try {
        const r = await squareBookings.cancelBookingIfActive(l.squareBookingId);
        if (r.cancelled) {
          deleted.squareAppointmentsCancelled++;
          console.log(`[Deletion] Square appointment ${l.squareBookingId} cancelled (${l.name}${l.slot ? `, ${l.slot}` : ''})`);
        } else {
          console.log(`[Deletion] Square appointment ${l.squareBookingId} left alone: ${r.reason}`);
        }
      } catch (err) {
        // Square's real cause (VERSION_MISMATCH / UNAUTHORIZED / …) decides
        // whether a retry can ever work — axios's generic message hides it.
        failures.push(`Square appointment for ${l.name} (${l.squareBookingId}) could not be cancelled: ${squareBookings.squareErrorText(err)}`);
      }
    }

    // Child failures → keep every parent (CM row, leads, folders): the caseRef
    // survives, so the admin can simply re-run the delete once Monday recovers.
    // Deleting the CM row now would strand the failed children forever.
    if (failures.length) {
      failures.push(g.keepLeads
        ? 'The Client Master row was KEPT (and the consultation record left linked to it) because some steps failed — fix or wait, then run the delete again.'
        : 'Client Master row, lead row(s) and OneDrive folder(s) were KEPT because some steps failed — fix or wait, then run the delete again.');
    } else if (g.keepLeads) {
      // Keeping the consultation record (point 8). The folder's OWNER first, in ONE section under its lead lock (review
      // round 4): the folder renamed to its name and the record set aside — or, when the record cannot be set aside, the
      // folder given its case name back and NOTHING else changed, so the open case keeps finding its files. A fresh
      // read decides, never the column search or a count. Then every other record; the case row last.
      const st = g.folderStep;
      const ownerId = st && (g.keptAll || []).some((l) => String(l.id) === String(st.owner)) ? String(st.owner) : '';
      const order = [...(g.keptAll || [])].sort((x, y) => (String(y.id) === ownerId) - (String(x.id) === ownerId));
      const noNote = [];
      const tally = (l, r) => {
        if (r === 'unlinked' || r === 'unlinked-no-note') kept.leadRows++;
        else if (r === 'not-linked') kept.leadsAlreadyUnlinked++;
        else if (r === 'aside-gone') (kept.inRecycleBin = kept.inRecycleBin || []).push(`${l.name} (${l.id})`);
        else kept.leadsSetAsideEarlier = (kept.leadsSetAsideEarlier || 0) + 1;
        if (r === 'aside-posted') kept.notesPosted = (kept.notesPosted || 0) + 1;
        if (r === 'unlinked-no-note' || r === 'aside-no-note') noNote.push(l);
      };
      for (const l of order) {
        if (ownerId && String(l.id) === ownerId) {
          const res = await ownerSection(l, st, g, marker, kept, failures);
          if (res.stop) break;
          tally(l, res.r);
          continue;
        }
        let r;
        try { r = await unlinkKeptLead(l.id, g, marker); }
        catch (err) { failures.push(`Consultation record ${l.name} (${l.id}) could not be set aside: ${err.message}`); continue; }
        tally(l, r);
      }
      // The note carries the way back — the case row (the only way to re-run) is not deleted without it.
      if (noNote.length) failures.push(`The note with the way back could not be added on ${noNote.map((l) => `${l.name} (${l.id})`).join(', ')} — run the delete again in a minute: it adds the note, then deletes the case row.`);
      // Just before the case row goes: every kept record read once more — one linked to this case again meanwhile (a
      // signature handled at that very moment) keeps the case row.
      if (!failures.length) {
        for (const l of g.keptAll || []) {
          let cur;
          try { cur = await leadService.getLead(String(l.id)); }
          catch (err) { failures.push(`Consultation record ${l.name} (${l.id}) could not be checked one last time (${err.message}) — run the delete again in a minute.`); continue; }
          if (cur && String(cur.clientMasterItemId || '').trim() === String(g.cmItemId)) {
            failures.push(`Consultation record ${l.name} (${l.id}) was linked to this case again while the delete ran — check it, then run the delete again.`);
            // The folder's owner linked again (round 5): the open case gets its folder back.
            if (st && String(l.id) === String(st.owner)) await giveFolderBack(st, g, kept, failures);
          }
        }
      }
      // A folder the still-open case made while this run set records aside (an upload, an autosave — round 5): it is in
      // no note yet. Keep the case row; the re-run names it in the plan and in every record's note.
      if (!failures.length && st && g.caseRef) {
        const now = await oneDrive.findCaseFoldersByRef(g.caseRef).catch(() => null);
        const known = new Set(g.folderLater || []);
        const fresh = now ? now.filter((f) => !known.has(f.name)) : null;
        if (!fresh) failures.push('OneDrive could not be checked one last time for folders carrying the case number — run the delete again in a minute.');
        else if (fresh.length) failures.push(`A folder carrying the case number, ${fresh.map((f) => `“${f.name}”`).join(', ')}, was made while the delete ran (files the client added) — run the delete again: it names ${fresh.length > 1 ? 'them' : 'it'} on every record.`);
      }
      if (failures.length) {
        failures.push('The Client Master row was KEPT because the consultation record could not be fully set aside — nothing of it was deleted. Run the delete again in a minute.');
      } else if (g.cmItemId) {
        const r = await deleteMondayRows([{ id: g.cmItemId }], 'clientMasterRow');
        deleted.clientMasterRow = r.deleted;
        failures.push(...r.errors);
      }
    } else {
      if (g.cmItemId) {
        const r = await deleteMondayRows([{ id: g.cmItemId }], 'clientMasterRow');
        deleted.clientMasterRow = r.deleted;
        failures.push(...r.errors);
      }
      const rl = await deleteMondayRows(g.leads, 'leadRow');
      deleted.leadRows = rl.deleted;
      failures.push(...rl.errors);

      for (const f of g.folders) {
        try {
          await oneDrive.deleteDriveItem(f.id);
          deleted.oneDriveFolders++;
        } catch (err) {
          failures.push(`OneDrive folder ${f.name}: ${err.message}`);
        }
      }
    }

    const summary = {
      ok: failures.length === 0,
      kind: g.kind,
      caseRef: g.caseRef || '',
      client: g.client,
      deleted,
      kept,
      failures,
    };
    console.log(`[Deletion] ${actor || 'admin'}${leadOnly ? ' (lead-only permission)' : ''} deleted ${g.kind} ${g.caseRef || (g.leads[0] && g.leads[0].id) || ''} (${g.client.name}): ${JSON.stringify(deleted)}${kept ? ` KEPT: ${JSON.stringify(kept)}` : ''}${failures.length ? ` FAILURES: ${JSON.stringify(failures)}` : ''}`);
    return summary;
  } finally {
    _inFlight.delete(key);
    if (caseKey) _inFlight.delete(caseKey);
  }
}

/**
 * The note on a kept consultation record: what happened, and the whole way back — the same case-level steps on
 * every kept record, whatever this run did (a re-run after a partial failure sees no rows left and the folder
 * renamed already: the steps come from the case, not from this run's counts).
 */
function keptNote(leadId, g, marker) {
  const ref = g.caseRef || `CASE-${g.cmItemId}`;
  const folderStep = g.folderStep || (g.folderPlan ? { from: g.folderPlan.from, to: g.folderPlan.to, owner: g.folderPlan.leadId } : g.folderReturned);
  const mine = folderStep && (folderStep.owner ? String(folderStep.owner) === String(leadId) : new RegExp(` - LEAD-${String(leadId)}$`).test(folderStep.to));
  const later = folderStep ? (g.folderLater || []) : [];
  const ownerName = folderStep && !mine ? ((g.keptAll || []).find((l) => String(l.id) === String(folderStep.owner)) || {}).name : '';
  const added = later.length ? `<br><b>Files added while the delete was stopped</b> are in ${later.map((x) => `“${escNote(x)}”`).join(', ')}: in OneDrive, move them into ` +
    (mine ? `“${escNote(folderStep.to)}” and delete the empty folder${later.length > 1 ? 's' : ''} — this record finds only “${escNote(folderStep.to)}”.`
      : `the case’s folder “${escNote(folderStep.to)}”${ownerName ? ` (kept with ${escNote(ownerName)} (${folderStep.owner}))` : ''} and delete the empty folder${later.length > 1 ? 's' : ''}.`) : '';
  const folderLine = folderStep
    ? (mine ? ` Its OneDrive folder was kept and renamed back to “${escNote(folderStep.to)}”.` : ` The case’s OneDrive folder was kept and renamed back to “${escNote(folderStep.to)}”.`)
    : ' Its OneDrive folder was kept as it is.';
  const others = (g.keptAll || g.keptLeads || []).filter((l) => String(l.id) !== String(leadId));
  const relink = others.length
    ? `this lead and on ${others.map((l) => `${escNote(l.name)} (${l.id})`).join(', ')}`
    : 'this lead';
  let n = 1;
  const steps = [
    `${n++}) In Monday’s recycle bin, restore the case row ${escNote(ref)} (item ${g.cmItemId})${g.caseRef ? ` and every checklist, questionnaire and family row of ${escNote(g.caseRef)}` : ''}.`,
    ...(later.length ? [`${n++}) In OneDrive, if ${later.length > 1 ? 'any of ' : ''}${later.map((x) => `“${escNote(x)}”`).join(', ')} (made while the delete was stopped) ${later.length > 1 ? 'are' : 'is'} still there, move ${later.length > 1 ? 'their' : 'its'} files into “${escNote(folderStep.to)}” and delete ${later.length > 1 ? 'them' : 'it'}.`] : []),
    ...(folderStep ? [`${n++}) In OneDrive, rename the folder “${escNote(folderStep.to)}” back to “${escNote(folderStep.from)}”.`] : []),
    `${n++}) Type ${g.cmItemId} back into the “Client Master Item ID” column, and clear “Case deleted”, on ${relink}.`,
  ];
  return `🗑 <b>Case ${escNote(ref)} was deleted</b> (${escNote(marker)}). This consultation record was <b>kept</b> and is no longer linked to a case — its outcome, retainer dates, payments and notes stay.${folderLine} ` +
    'While “Case deleted” is filled in, the app never opens a new case for this client by itself.<br>' +
    `${added}<br><b>Deleted by mistake?</b> ${steps.join(' ')}<br>` +
    '<b>A new case instead?</b> Clear “Case deleted”; then, if the retainer was signed, clear this lead’s Retainer Signed date in Monday and type it again — the case opens (no new agreement is sent, and a payment already recorded is not asked for again).' +
    ` ⟦way ${wayDigest(g)}⟧`;
}

/** A fingerprint of the case-level way back (round 5): the folder step, the folders made while stopped, every record
 *  kept. A record's note counts as present only when it carries the fingerprint of the plan being finished. */
function wayDigest(g) {
  const st = g.folderStep || (g.folderPlan ? { id: g.folderPlan.id, from: g.folderPlan.from, to: g.folderPlan.to } : g.folderReturned) || null;
  const basis = JSON.stringify({ case: String(g.cmItemId), ref: g.caseRef || '', step: st ? [String(st.id || ''), st.from, st.to] : null,
    later: (g.folderLater || []).slice().sort(), kept: (g.keptAll || g.keptLeads || []).map((l) => String(l.id)).sort() });
  return require('crypto').createHash('sha1').update(basis).digest('hex').slice(0, 10);
}

/** Today in Toronto, YYYY-MM-DD (the marker's date — the team's day). */
function torontoDay() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }

/** Pauses (ms) before the re-reads after a write that answered with an error, and between note tries — tests set 0. */
const timing = { reReadMs: [1500, 3000], noteRetryMs: 800, ownerLockMs: 0 /* 0 = leadMutex.LEAD_LOCK_WAIT_MS */ };

/**
 * Keeping the record (point 8): set one consultation record aside from the deleted case — under the lead's lock, from
 * a fresh read (review round 4: a fresh read decides, never the column search, which lags a write):
 *  - linked to THIS case → unlinked + marked, then its note → 'unlinked' | 'unlinked-no-note'. A write that answers
 *    with an error is read again (twice, with pauses — it can land a moment later): it LANDED → as above; still linked
 *    → throws with err.stillLinked = true; unreadable → throws (stillLinked unknown).
 *  - set aside for THIS case already (no link, its marker names the case — an earlier run, or a write that landed late)
 *    → its note is made sure of → 'aside' | 'aside-posted' | 'aside-no-note' | 'aside-gone' (in Monday's recycle bin).
 *  - anything else (linked to another case, unlinked without the marker) → 'not-linked', left as it is.
 */
async function unlinkKeptLead(leadId, g, marker) {
  const ref = g.caseRef || `CASE-${g.cmItemId}`;
  return require('./leadMutex').withLeadLock(String(leadId), async () => {
    const cur = await leadService.getLead(String(leadId));
    if (!cur) throw new Error('the lead could not be read');
    const link = String(cur.clientMasterItemId || '').trim();
    if (link !== String(g.cmItemId)) {
      if (!link && markerNames(cur.caseDeleted, ref)) {
        const n = await ensureKeptNote(leadId, g, String(cur.caseDeleted).trim());
        return { posted: 'aside-posted', present: 'aside', gone: 'aside-gone' }[n] || 'aside-no-note';
      }
      console.log(`[Deletion] lead ${leadId} no longer points at case ${g.cmItemId} — left as it is`);
      return 'not-linked';
    }
    try {
      await leadService.updateLead(String(leadId), { clientMasterItemId: '', caseDeleted: marker }, { clearKeys: ['clientMasterItemId'] });
    } catch (err) {
      let again = null;
      for (const ms of timing.reReadMs) {
        if (ms) await sleep(ms);
        again = await leadService.getLead(String(leadId)).catch(() => null);
        if (again && !String(again.clientMasterItemId || '').trim() && markerNames(again.caseDeleted, ref)) {
          console.warn(`[Deletion] lead ${leadId}: the write answered "${err.message}" but landed — set aside`);
          return (await postNote(leadId, keptNote(leadId, g, String(again.caseDeleted).trim()))) ? 'unlinked' : 'unlinked-no-note';
        }
      }
      err.stillLinked = again ? String(again.clientMasterItemId || '').trim() === String(g.cmItemId) : undefined;
      throw err;
    }
    return (await postNote(leadId, keptNote(leadId, g, marker))) ? 'unlinked' : 'unlinked-no-note';
  });
}

/**
 * A record set aside for this case: its note — the one carrying the marker it has NOW and the fingerprint of the way
 * back being finished (round 5) — is there, or is posted now. A note written under an older plan (a folder step, a
 * folder made while stopped, or a record that changed since) does not count, whichever run noted that plan.
 * One in Monday's recycle bin needs none. Returns 'present' | 'posted' | 'failed' | 'gone'.
 */
async function ensureKeptNote(leadId, g, marker) {
  const ref = g.caseRef || `CASE-${g.cmItemId}`;
  const want = `Case ${ref} was deleted (${marker})`, way = `⟦way ${wayDigest(g)}⟧`;
  let found = false, state = '';
  try {
    for (let page = 1; page <= NOTE_PAGES; page++) {
      const d = await mondayApi.query('query($id:[ID!],$p:Int!){ items(ids:$id, limit:1){ state updates(limit:100, page:$p){ text_body } } }', { id: [String(leadId)], p: page });
      const it = d && d.items && d.items[0];
      if (!it) break;
      if (it.state) state = String(it.state);
      const ups = it.updates || [];
      if (ups.some((u) => { const t = String(u.text_body || ''); return t.includes(want) && t.includes(way); })) { found = true; break; }
      if (ups.length < 100) break;
    }
  } catch (err) {
    console.warn(`[Deletion] notes of lead ${leadId} could not be read: ${err.message}`);
    return 'failed';
  }
  if (state === 'deleted') return 'gone';
  if (found) return 'present';
  return (await postNote(leadId, keptNote(leadId, g, marker))) ? 'posted' : 'failed';
}

/**
 * The folder's owner (review rounds 4-5), in ONE section under its lead lock — a bounded wait. The record is read FIRST
 * and decides everything (a read that fails changes nothing):
 *  - linked to this case → the folder renamed to its name (unless an earlier run did; a rename that answers with an
 *    error is read back by its id), then the record set aside; if it cannot be, the folder gets its case name back and
 *    the delete stops there.
 *  - set aside for this case already (an earlier run) → the rename finished if still owed, its note made sure of; the
 *    folder is NEVER given back (it belongs with the record).
 *  - linked elsewhere / unlinked without the marker (changed meanwhile) → stop; a folder an earlier run renamed for it
 *    gets its case name back (the case is still open).
 * Busy → stop; a folder an earlier run renamed is given back only when an unlocked read shows the record still linked.
 * Returns { r } (set aside) or { stop: true }.
 */
async function ownerSection(l, st, g, marker, kept, failures) {
  const ref = g.caseRef || `CASE-${g.cmItemId}`;
  const mutex = require('./leadMutex');
  const res = await mutex.withLeadLockOrSkip(String(l.id), timing.ownerLockMs || mutex.LEAD_LOCK_WAIT_MS, async () => {
    let cur;
    try { cur = await leadService.getLead(String(l.id)); } catch (err) { cur = undefined; failures.push(`Consultation record ${l.name} (${l.id}) could not be read (${err.message}) — it and its folder were not changed. Run the delete again in a minute.`); }
    if (cur === undefined) return { stop: true };
    if (!cur) { failures.push(`Consultation record ${l.name} (${l.id}) could not be read — it and its folder were not changed. Run the delete again in a minute.`); return { stop: true }; }
    const link = String(cur.clientMasterItemId || '').trim();
    const linked = link === String(g.cmItemId);
    const aside = !link && markerNames(cur.caseDeleted, ref);
    if (!linked && !aside) {
      kept.leadsAlreadyUnlinked++;
      failures.push(`Consultation record ${l.name} (${l.id}) is no longer linked to this case (changed meanwhile) — check it.`);
      // Give an earlier run's rename back only for an owner that was LINKED when this run started — one already set
      // aside then keeps its folder, whatever its record says now (the same as a change made between runs).
      const wasAside = (g.earlierLeads || []).some((e) => String(e.id) === String(l.id));
      if (!st.renameNow && !wasAside) await giveFolderBack(st, g, kept, failures);
      else failures.push('Its folder and the other records were not changed. Run the delete again once it is checked.');
      return { stop: true };
    }
    if (st.renameNow) {
      try {
        await oneDrive.renameItemById({ itemId: st.id, newName: st.to });
      } catch (err) {
        const now = await oneDrive.getDriveItemById(st.id).catch(() => null);
        if (!now || now.name !== st.to) {
          failures.push(now
            ? `The OneDrive folder “${st.from}” could not be renamed back to “${st.to}” (${err.message}).`
            : `The OneDrive folder “${st.from}” may or may not have been renamed to “${st.to}” (${err.message}; it could not be read back) — check it in OneDrive before running the delete again.`);
          return { stop: true };
        }
        console.warn(`[Deletion] the folder rename answered "${err.message}" but landed`);
      }
      kept.folderRenamed = 1;
      console.log(`[Deletion] folder "${st.from}" renamed back to "${st.to}" (case ${g.caseRef || g.cmItemId} deleted, record kept)`);
    }
    if (aside) {
      const n = await ensureKeptNote(l.id, g, String(cur.caseDeleted).trim());
      return { r: { posted: 'aside-posted', present: 'aside', gone: 'aside-gone' }[n] || 'aside-no-note' };
    }
    let r = null, err = null;
    try { r = await unlinkKeptLead(l.id, g, marker); } catch (e) { err = e; }
    if (!err && r !== 'not-linked') return { r };
    if (err) failures.push(`Consultation record ${l.name} (${l.id}) could not be set aside${err.stillLinked === true ? ' — it still reads as linked to the case' : ''}: ${err.message}`);
    else { kept.leadsAlreadyUnlinked++; failures.push(`Consultation record ${l.name} (${l.id}) is no longer linked to this case (changed meanwhile) — check it.`); }
    await giveFolderBack(st, g, kept, failures);
    return { stop: true };
  });
  if (res && res.busy) {
    failures.push(`Consultation record ${l.name} (${l.id}) is busy (another task is working on it) — it was not changed. Run the delete again in a minute.`);
    // A folder an earlier run renamed while this record stayed linked: the open case gets it back now (read unlocked).
    if (!st.renameNow) {
      const cur = await leadService.getLead(String(l.id)).catch(() => null);
      if (cur && String(cur.clientMasterItemId || '').trim() === String(g.cmItemId)) await giveFolderBack(st, g, kept, failures);
    }
    return { stop: true };
  }
  return res;
}

/** The folder gets its case name back (by its id). A rename that answers with an error is read back (by id, then by the
 *  case number); a folder the open case made meanwhile under the case name is named, so the two can be merged.
 *  Never throws. */
async function giveFolderBack(st, g, kept, failures) {
  const done = () => { kept.folderRenamed = 0; failures.push(`The OneDrive folder was given its case name “${st.from}” back. Run the delete again in a minute.`); };
  try {
    await oneDrive.renameItemById({ itemId: st.id, newName: st.from });
    return done();
  } catch (err) {
    const now = await oneDrive.getDriveItemById(st.id).catch(() => null);
    if (now && now.name === st.from) return done();
    const found = g.caseRef ? await oneDrive.findCaseFoldersByRef(g.caseRef).catch(() => null) : [];
    if (found && found.some((f) => String(f.id) === String(st.id))) return done();
    const twins = (found || []).filter((f) => String(f.id) !== String(st.id));
    failures.push(twins.length
      ? `The OneDrive folder is still “${st.to}”, and the open case made a new folder “${twins[0].name}” meanwhile (${err.message}) — in OneDrive, move the files from “${twins[0].name}” into “${st.to}”, delete the empty “${twins[0].name}”, then rename “${st.to}” back to “${st.from}”.`
      : `The OneDrive folder is still “${st.to}” and could NOT be given its case name back (${err.message}) — the case does not find its files until it is: rename it in OneDrive to “${st.from}”, or run the delete again.`);
  }
}

/** I/O. The case row a delete is about, read before anything else (the per-case lock): by case number, or the lead's link. */
async function caseRowIdOf({ leadId, caseRef }) {
  if (caseRef) return String((await clientMaster.findItemByCaseRef(String(caseRef).trim())) || '');
  if (!leadId) return '';
  const lead = await leadService.getLead(String(leadId));
  return lead ? String(lead.clientMasterItemId || '').trim() : '';
}

/** A note on a Monday item, tried twice — never throws. */
async function postNote(itemId, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await mondayApi.query('mutation($id:ID!,$b:String!){ create_update(item_id:$id, body:$b){ id } }', { id: String(itemId), b: body });
      return true;
    } catch (err) {
      console.warn(`[Deletion] note on item ${itemId} failed (try ${attempt}): ${err.message}`);
      if (attempt < 2 && timing.noteRetryMs) await sleep(timing.noteRetryMs);
    }
  }
  return false;
}

module.exports = { previewDeletion, executeDeletion, LEAD_ONLY_REFUSAL, _internal: { buildGraph, leadOnlyRefusal, rowsByCaseRef, resolveFolders, deleteMondayRows, planFolderReturn, unlinkKeptLead, keptNote, readKeepPlan, planMarker, timing } };
