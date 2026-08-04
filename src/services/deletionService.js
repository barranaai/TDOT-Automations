'use strict';

/**
 * Careful cascading delete of a client's records — admin-only, preview-first.
 *
 * Two roots:
 *   - a LEAD with no case  → lead row + its OneDrive lead folder
 *   - a CASE (or a lead that has one — the preview ESCALATES to the case so a
 *     lead delete can never orphan a case) → Client Master row, checklist
 *     execution rows, questionnaire execution rows, family-member rows, every
 *     originating lead row, and the client's OneDrive folder(s)
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
 */

const mondayApi     = require('./mondayApi');
const leadService   = require('./leadService');
const oneDrive      = require('./oneDriveService');
const clientMaster  = require('./clientMasterService');
const { clientMasterBoardId, leadBoardId, cmColumns } = require('../../config/monday');

const familyBoard = require('../data/familyMembersBoard.json');

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

/** I/O. The Client Master row (name, email, oneDriveFolderId) by item id — null unless it really is on the CM board. */
async function readCmItem(cmItemId) {
  const data = await mondayApi.query(
    `query($id:ID!){ items(ids:[$id]){ id name board { id } column_values(ids:["${CM_CASE_REF_COL}","${CM_EMAIL_COL}","${CM_ONEDRIVE_ID_COL}"]){ id text } } }`,
    { id: String(cmItemId) }
  );
  const it = data?.items?.[0];
  if (!it) return null;
  if (!it.board || String(it.board.id) !== String(clientMasterBoardId)) return null;
  const g = (colId) => ((it.column_values || []).find((c) => c.id === colId) || {}).text || '';
  return { id: String(it.id), name: it.name, caseRef: g(CM_CASE_REF_COL).trim(), email: g(CM_EMAIL_COL).trim(), oneDriveFolderId: g(CM_ONEDRIVE_ID_COL).trim() };
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

/** The full deletion graph for a CASE, rooted at the Client Master item. */
async function caseGraph(cm) {
  const caseRef = cm.caseRef;
  const [execRows, qexecRows, familyRows, leads] = await Promise.all([
    caseRef ? rowsByCaseRef(EXEC_BOARD_ID, EXEC_CASE_REF_COL, caseRef) : [],
    caseRef ? rowsByCaseRef(QEXEC_BOARD_ID, QEXEC_CASE_REF_COL, caseRef) : [],
    caseRef ? rowsByCaseRef(FAMILY_BOARD_ID, FAMILY_CASE_REF_COL, caseRef) : [],
    leadService.findAllByColumnValue('clientMasterItemId', String(cm.id)),
  ]);

  const nameCandidates = [];
  if (caseRef) nameCandidates.push(`${cm.name} - ${caseRef}`);
  for (const l of leads) nameCandidates.push(`${l.fullName || cm.name} - LEAD-${l.id}`);
  const folderId = cm.oneDriveFolderId || (leads.find((l) => l.oneDriveFolderId) || {}).oneDriveFolderId || '';
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
    leads: leads.map((l) => ({ id: String(l.id), name: l.fullName || `Lead ${l.id}` })),
    folders,
    warnings: [
      ...warnings,
      'The client’s account row on the Clients board (if any) is KEPT — it is cross-application history, and other cases may link to it.',
      'Documenso envelopes (signed agreements) and Square payment records are NOT deleted — remove those manually if needed.',
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
    leads: [{ id: String(lead.id), name: lead.fullName || `Lead ${lead.id}` }],
    execRows: [], qexecRows: [], familyRows: [], cmItemId: null, caseRef: '',
    folders,
    warnings: [
      ...warnings,
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
    return caseGraph(cm);
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
      // CM link points nowhere (or at a non-CM item) — treat as a plain lead
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
    targets: {
      clientMasterRow: g.cmItemId ? 1 : 0,
      checklistRows: g.execRows.length,
      questionnaireRows: g.qexecRows.length,
      familyMemberRows: g.familyRows.length,
      leadRows: g.leads.map((l) => l.name),
      oneDriveFolders: g.folders.map((f) => f.name),
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

    const failures = [];
    const deleted = { checklistRows: 0, questionnaireRows: 0, familyMemberRows: 0, clientMasterRow: 0, leadRows: 0, oneDriveFolders: 0 };

    for (const [countKey, rows] of [['checklistRows', g.execRows], ['questionnaireRows', g.qexecRows], ['familyMemberRows', g.familyRows]]) {
      const r = await deleteMondayRows(rows, countKey);
      deleted[countKey] = r.deleted;
      failures.push(...r.errors);
    }

    // Child failures → keep every parent (CM row, leads, folders): the caseRef
    // survives, so the admin can simply re-run the delete once Monday recovers.
    // Deleting the CM row now would strand the failed children forever.
    if (failures.length) {
      failures.push('Client Master row, lead row(s) and OneDrive folder(s) were KEPT because some child rows failed — fix or wait, then run the delete again.');
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
      failures,
    };
    console.log(`[Deletion] ${actor || 'admin'} deleted ${g.kind} ${g.caseRef || (g.leads[0] && g.leads[0].id) || ''} (${g.client.name}): ${JSON.stringify(deleted)}${failures.length ? ` FAILURES: ${JSON.stringify(failures)}` : ''}`);
    return summary;
  } finally {
    _inFlight.delete(key);
  }
}

module.exports = { previewDeletion, executeDeletion, _internal: { buildGraph, rowsByCaseRef, resolveFolders, deleteMondayRows } };
