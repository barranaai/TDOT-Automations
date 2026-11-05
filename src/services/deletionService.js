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
  return { id: String(it.id), name: it.name, caseRef: g(CM_CASE_REF_COL).trim(), email: g(CM_EMAIL_COL).trim(), oneDriveFolderId: g(CM_ONEDRIVE_ID_COL).trim() };
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
async function readKeepPlan(cmItemId) {
  const d = await mondayApi.query('query($id:[ID!]){ items(ids:$id, limit:1){ updates(limit:100){ text_body } } }', { id: [String(cmItemId)] });
  for (const u of (d && d.items && d.items[0] && d.items[0].updates) || []) {   // newest first
    const t = String(u.text_body || '');
    const a = t.lastIndexOf(PLAN_OPEN); if (a < 0) continue;
    const b = t.indexOf(PLAN_CLOSE, a + PLAN_OPEN.length); if (b < 0) continue;
    try {
      const p = JSON.parse(Buffer.from(t.slice(a + PLAN_OPEN.length, b).trim(), 'base64url').toString('utf8'));
      if (p && p.v === 1 && Array.isArray(p.leads)) return p;
    } catch (_) { /* not a plan */ }
  }
  return null;
}
/** The "Case deleted" marker names its case between " · " separators (date · case · who) — never a prefix match. */
const markerNames = (caseDeleted, ref) => ` ${String(caseDeleted || '')} `.includes(` · ${ref} · `);

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
async function planFolderReturn(cm, leads, prior = null) {
  const none = (why) => ({ plan: null, note: why });
  const ask = async (fn) => {
    try { return await fn(); } catch (err) {
      bad(`OneDrive could not be checked (${err.message}) — nothing was deleted. Try again in a minute: the consultation record's folder must be found first.`);
    }
  };
  if (!cm.caseRef) return none('');   // the folder never took the case number: it still has the lead's name
  const caseFolders = await ask(() => oneDrive.findCaseFoldersByRef(cm.caseRef));
  if (!caseFolders.length) {
    // An earlier run of this delete may have renamed it back already. Nothing to do — but the undo steps must still
    // give the way back. Its plan (noted on the case row) names the folder and its owner; failing that, the case
    // row's own folder now ending " - LEAD-{id}" of a record this delete keeps.
    if (prior && prior.from && prior.owner) {
      const back = (await ask(() => oneDrive.findCaseFoldersByRef(`LEAD-${prior.owner}`)))[0];
      if (back) return { plan: null, note: `The OneDrive folder was already renamed back to “${back.name}” (an earlier run of this delete). Nothing is deleted from OneDrive.`, returned: { to: back.name, from: String(prior.from) } };
    }
    const ours = new Set([...leads, ...((prior && prior.leads) || [])].map((l) => String(l.id)));
    const sid = String(cm.oneDriveFolderId || '').trim();
    if (sid) {
      const item = await ask(() => oneDrive.getDriveItemById(sid));
      const m = item && String(item.parentPath || '').endsWith(`/${ROOT_FOLDER_NAME}`) ? / - LEAD-(\d+)$/.exec(String(item.name || '')) : null;
      if (m && ours.has(m[1])) {
        const back = `${String(item.name).slice(0, String(item.name).length - m[0].length)} - ${cm.caseRef}`;
        return { plan: null, note: `The OneDrive folder was already renamed back to “${item.name}” (an earlier run of this delete). Nothing is deleted from OneDrive.`, returned: { to: item.name, from: back } };
      }
    }
    return none('No OneDrive folder carries this case number — there is nothing to rename. Nothing is deleted from OneDrive.');
  }
  if (caseFolders.length > 1) return none(`${caseFolders.length} OneDrive folders carry this case number — all are KEPT as they are (check them in OneDrive): the consultation record may not find its files until one is renamed to the lead's name.`);
  const folder = caseFolders[0];
  const owners = leads.length === 1 ? leads : leads.filter((l) => String(l.oneDriveFolderId || '').trim() === String(folder.id));
  if (owners.length !== 1) return none(leads.length ? `The OneDrive folder "${folder.name}" is KEPT as it is — it is not clear which consultation record owns it.` : `The OneDrive folder "${folder.name}" is KEPT as it is. Nothing is deleted from OneDrive.`);
  const owner = owners[0];
  const to = leadFolderName(owner);
  // The record's own folder already there (a root folder ending " - LEAD-{id}"): renaming would make two.
  const own = (await ask(() => oneDrive.findCaseFoldersByRef(`LEAD-${owner.id}`))).filter((f) => String(f.id) !== String(folder.id));
  if (own.length) return none(`The OneDrive folder "${folder.name}" is KEPT as it is — the consultation record already has its own folder "${own[0].name}".`);
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

  if (keepLeads) {
    // The consultation record is kept forever (point 8): the lead rows stay, unlinked and marked; no folder is deleted.
    if (leads.length >= KEEP_LEADS_LIMIT) bad(`${leads.length} or more consultation records are linked to this case — too many to be sure all are kept. Nothing was deleted; ask for help.`);
    if (leads.length && !leadCaseDeletedCol()) bad('The Leads board has no "Case deleted" column set up in the app yet — nothing was deleted (a kept consultation record must be marked). Ask for help.');
    // An earlier run that stopped part-way: its plan names the records it already set aside (unlinked — no longer
    // found by the case link) and the folder it renamed. Only records still set aside for THIS case count.
    const ref = caseRef || `CASE-${cm.id}`;
    let prior = null;
    try { prior = await readKeepPlan(cm.id); }
    catch (err) { bad(`The case’s notes could not be read (${err.message}) — nothing was deleted. Try again in a minute.`); }
    const linkedIds = new Set(leads.map((l) => String(l.id)));
    const earlier = [];
    for (const l of ((prior && prior.leads) || []).slice(0, KEEP_LEADS_LIMIT)) {
      const id = String(l.id);
      if (linkedIds.has(id) || earlier.some((e) => e.id === id)) continue;
      let cur;
      try { cur = await leadService.getLead(id); }
      catch (err) { bad(`Consultation record ${id} could not be read (${err.message}) — nothing was deleted. Try again in a minute.`); }
      if (cur && !String(cur.clientMasterItemId || '').trim() && markerNames(cur.caseDeleted, ref)) {
        earlier.push({ id, name: String(cur.fullName || cur.name || l.name || `Lead ${id}`) });
      }
    }
    const { plan, note, returned } = (leads.length || earlier.length) ? await planFolderReturn(cm, leads, prior) : { plan: null, note: '', returned: null };
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

/** The deletion graph for a case-less LEAD. */
async function leadGraph(lead) {
  const { folders, warnings } = await resolveFolders({
    folderId: lead.oneDriveFolderId || '',
    nameCandidates: [`${lead.fullName || `Lead ${lead.id}`} - LEAD-${lead.id}`],
  });
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
 * Build the deletion graph for a lead or a case. A lead that already has a
 * Client Master case ESCALATES to the full case graph — deleting a lead can
 * never silently leave an orphaned case behind.
 */
async function buildGraph({ leadId, caseRef }) {
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
    if (lead.clientMasterItemId) {
      const cm = await readCmItem(lead.clientMasterItemId);
      if (cm) return caseGraph(cm);
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
async function previewDeletion({ leadId, caseRef }) {
  const g = await buildGraph({ leadId, caseRef });
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
async function executeDeletion({ leadId, caseRef, confirmText, expectedKind, actor }) {
  const key = caseRef ? `case:${String(caseRef).trim()}` : `lead:${String(leadId).trim()}`;
  if (_inFlight.has(key)) bad('A delete for this record is already running — wait for it to finish, then refresh the list.');
  _inFlight.add(key);
  try {
    const g = await buildGraph({ leadId, caseRef });
    if (expectedKind && expectedKind !== g.kind) {
      bad('This record changed since the preview (it now has an open case). Close the dialog and re-open it to see the full scope.');
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
    if (kept && (g.earlierLeads || []).length) kept.leadsSetAsideEarlier = g.earlierLeads.length;   // a re-run says the whole result
    if (kept && g.folderReturned) kept.folderRenamedEarlier = 1;
    const marker = g.keepLeads ? `${torontoDay()} · ${g.caseRef || `CASE-${g.cmItemId}`} · ${actor || 'admin'}` : '';

    // Keeping the record (review round 3): the plan goes on the case row BEFORE anything is changed — a run that
    // stops part-way leaves it for the next run (every record kept, the folder names). Not noted → nothing deleted.
    if (g.keepLeads && (g.keptAll || []).length) {
      const fp = g.folderPlan ? { from: g.folderPlan.from, to: g.folderPlan.to, owner: g.folderPlan.leadId }
        : (g.priorPlan && g.priorPlan.from ? { from: g.priorPlan.from, to: g.priorPlan.to, owner: g.priorPlan.owner } : {});
      const same = g.priorPlan && (g.priorPlan.from || '') === (fp.from || '') && (g.priorPlan.to || '') === (fp.to || '')
        && g.priorPlan.leads.map((l) => String(l.id)).sort().join(',') === g.keptAll.map((l) => l.id).sort().join(',');
      if (!same) {
        const body = `🗑 <b>Deleting this case from the Cases page — the consultation record is kept</b> (${escNote(marker)}). ` +
          `Kept: ${g.keptAll.map((l) => `${escNote(l.name)} (${l.id})`).join(', ')}.` +
          (fp.from ? ` OneDrive folder “${escNote(fp.from)}” → renamed back to “${escNote(fp.to)}”.` : '') +
          ` If the delete stops part-way, running it again finishes it from this plan. ${planMarker({ v: 1, leads: g.keptAll, ...fp })}`;
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
      // Keeping the consultation record (point 8). Order matters for a safe re-run: the folder first (a failure stops
      // before any lead changes), every lead unlinked next (a failure keeps the case row), the case row last.
      if (g.folderPlan) {
        try {
          await oneDrive.renameItemById({ itemId: g.folderPlan.id, newName: g.folderPlan.to });
          kept.folderRenamed = 1;
          console.log(`[Deletion] folder "${g.folderPlan.from}" renamed back to "${g.folderPlan.to}" (case ${g.caseRef || g.cmItemId} deleted, record kept)`);
        } catch (err) {
          failures.push(`The OneDrive folder “${g.folderPlan.from}” could not be renamed back to “${g.folderPlan.to}” (${err.message}).`);
        }
      }
      if (!failures.length) {
        const noNote = [];
        for (const l of g.keptLeads) {
          try {
            const r = await unlinkKeptLead(l.id, g, marker);
            if (r === 'unlinked' || r === 'unlinked-no-note') kept.leadRows++; else kept.leadsAlreadyUnlinked++;
            if (r === 'unlinked-no-note') noNote.push(l);
          } catch (err) {
            failures.push(`Consultation record ${l.name} (${l.id}) could not be unlinked from the case: ${err.message}`);
          }
        }
        // Stopped before ANY record was set aside (now or by an earlier run): the folder gets the case number back, so
        // nothing is half-done on the record's side — the next run renames it again.
        if (failures.length && kept.folderRenamed && !kept.leadRows && !(g.earlierLeads || []).length) {
          try {
            await oneDrive.renameItemById({ itemId: g.folderPlan.id, newName: g.folderPlan.from });
            kept.folderRenamed = 0;
            failures.push(`The OneDrive folder was given its case name “${g.folderPlan.from}” back — the consultation record is still linked to the case.`);
          } catch (err) {
            failures.push(`The OneDrive folder is now “${g.folderPlan.to}” and could NOT be given its case name back (${err.message}) — the case does not find its files until it is: rename it in OneDrive to “${g.folderPlan.from}”, or run the delete again.`);
          }
        }
        // A record an earlier, stopped run set aside whose note never got posted: posted now.
        for (const l of g.earlierLeads || []) {
          const r = await postMissingKeptNote(l, g).catch(() => 'failed');
          if (r === 'posted') kept.notesPosted = (kept.notesPosted || 0) + 1;
          if (r === 'failed') noNote.push(l);
        }
        // The note carries the way back — the case row (the only way to re-run) is not deleted without it.
        if (noNote.length) failures.push(`The note with the way back could not be added on ${noNote.map((l) => `${l.name} (${l.id})`).join(', ')} — run the delete again in a minute: it adds the note, then deletes the case row.`);
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
    console.log(`[Deletion] ${actor || 'admin'} deleted ${g.kind} ${g.caseRef || (g.leads[0] && g.leads[0].id) || ''} (${g.client.name}): ${JSON.stringify(deleted)}${kept ? ` KEPT: ${JSON.stringify(kept)}` : ''}${failures.length ? ` FAILURES: ${JSON.stringify(failures)}` : ''}`);
    return summary;
  } finally {
    _inFlight.delete(key);
  }
}

/**
 * The note on a kept consultation record: what happened, and the whole way back — the same case-level steps on
 * every kept record, whatever this run did (a re-run after a partial failure sees no rows left and the folder
 * renamed already: the steps come from the case, not from this run's counts).
 */
function keptNote(leadId, g, marker) {
  const ref = g.caseRef || `CASE-${g.cmItemId}`;
  const folderStep = g.folderPlan || g.folderReturned;
  const mine = folderStep && (g.folderPlan ? g.folderPlan.leadId === String(leadId) : new RegExp(` - LEAD-${String(leadId)}$`).test(folderStep.to));
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
    ...(folderStep ? [`${n++}) In OneDrive, rename the folder “${escNote(folderStep.to)}” back to “${escNote(folderStep.from)}”.`] : []),
    `${n++}) Type ${g.cmItemId} back into the “Client Master Item ID” column, and clear “Case deleted”, on ${relink}.`,
  ];
  return `🗑 <b>Case ${escNote(ref)} was deleted</b> (${escNote(marker)}). This consultation record was <b>kept</b> and is no longer linked to a case — its outcome, retainer dates, payments and notes stay.${folderLine} ` +
    'While “Case deleted” is filled in, the app never opens a new case for this client by itself.<br>' +
    `<b>Deleted by mistake?</b> ${steps.join(' ')}<br>` +
    '<b>A new case instead?</b> Clear “Case deleted”; then, if the retainer was signed, clear this lead’s Retainer Signed date in Monday and type it again — the case opens (no new agreement is sent, and a payment already recorded is not asked for again).';
}

/** Today in Toronto, YYYY-MM-DD (the marker's date — the team's day). */
function torontoDay() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }

/**
 * Keeping the record (point 8): unlink one consultation record from the deleted case and mark it — under the lead's
 * lock, from a fresh read, and only when it still points at THIS case (a lead re-linked meanwhile is left alone).
 * Throws on a failed write (the caller then keeps the case row). Returns 'unlinked' | 'not-linked'.
 */
async function unlinkKeptLead(leadId, g, marker) {
  return require('./leadMutex').withLeadLock(String(leadId), async () => {
    const cur = await leadService.getLead(String(leadId));
    if (!cur) throw new Error('the lead could not be read');
    if (String(cur.clientMasterItemId || '').trim() !== String(g.cmItemId)) {
      console.log(`[Deletion] lead ${leadId} no longer points at case ${g.cmItemId} — left as it is`);
      return 'not-linked';
    }
    await leadService.updateLead(String(leadId), { clientMasterItemId: '', caseDeleted: marker }, { clearKeys: ['clientMasterItemId'] });
    return (await postNote(leadId, keptNote(leadId, g, marker))) ? 'unlinked' : 'unlinked-no-note';
  });
}

/** A note on a Monday item, tried twice — never throws. */
async function postNote(itemId, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await mondayApi.query('mutation($id:ID!,$b:String!){ create_update(item_id:$id, body:$b){ id } }', { id: String(itemId), b: body });
      return true;
    } catch (err) {
      console.warn(`[Deletion] note on item ${itemId} failed (try ${attempt}): ${err.message}`);
      if (attempt < 2) await sleep(800);
    }
  }
  return false;
}

/**
 * A record an earlier, stopped run set aside: when it is still set aside for THIS case and has no deletion note yet,
 * the note is posted now (under the lead's lock, from a fresh read). Returns 'posted' | 'present' | 'skipped' | 'failed'.
 */
async function postMissingKeptNote(l, g) {
  const ref = g.caseRef || `CASE-${g.cmItemId}`;
  return require('./leadMutex').withLeadLock(String(l.id), async () => {
    const cur = await leadService.getLead(String(l.id));
    if (!cur || String(cur.clientMasterItemId || '').trim() || !markerNames(cur.caseDeleted, ref)) return 'skipped';
    const d = await mondayApi.query('query($id:[ID!]){ items(ids:$id, limit:1){ updates(limit:100){ text_body } } }', { id: [String(l.id)] });
    const notes = (d && d.items && d.items[0] && d.items[0].updates) || [];
    if (notes.some((u) => String(u.text_body || '').includes(`Case ${ref} was deleted`))) return 'present';
    return (await postNote(l.id, keptNote(l.id, g, String(cur.caseDeleted).trim()))) ? 'posted' : 'failed';
  });
}

module.exports = { previewDeletion, executeDeletion, _internal: { buildGraph, rowsByCaseRef, resolveFolders, deleteMondayRows, planFolderReturn, unlinkKeptLead, keptNote, readKeepPlan, planMarker } };
