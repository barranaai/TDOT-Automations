'use strict';

/**
 * Which OneDrive folder do a lead's files live in?
 *
 * A client's documents folder is created at LEAD stage as
 *   "{Client Name} - LEAD-{leadId}"
 * and RENAMED to
 *   "{Client Name} - {Case Ref}"
 * when the case reference is assigned (caseRefService.renameClientFolderForItem).
 * The driveItem id never changes, so it is one folder with two names over time.
 *
 * oneDriveService resolves a case folder by the " - {caseRef}" SUFFIX, so a
 * caller that still addresses the folder as "LEAD-{id}" after the rename
 * resolves nothing and CREATES a second root folder beside the real one — the
 * "resurrection" half of the duplicate-folder defect (Gauri 2026-09-04, point
 * 12). Every lead-scoped read and write therefore goes through here:
 *
 *   writeRef(lead)                 → where a NEW file belongs (case ref once the
 *                                    case exists, LEAD- only before that)
 *   readFirst(oneDrive, lead, {…}) → read, trying the case folder then the lead
 *                                    folder, so files written under either name
 *                                    are still found (older cases, split cases)
 *
 * Kept free of oneDriveService and leadService imports: the caller passes the
 * lead object it already has and (for reads) the oneDrive module, so this stays
 * a leaf with no cycle risk.
 */

const CM_CASE_REF_COL = 'text_mm142s49';   // Client Master → Case Reference Number
const ONEDRIVE_ROOT_FOLDER = 'Client Documents';   // mirrors oneDriveService.ROOT_FOLDER (ownership check only)

/**
 * The case reference of the lead's case.
 *
 * Returns { caseRef, known }. `known` is the important half: "" with
 * known=false means Monday could not answer, which is NOT the same as "this
 * lead has no case yet" — and a write that confuses the two names the LEAD
 * folder for a client whose folder was renamed long ago, re-creating it.
 */
const _caseRefInFlight = new Map();   // cmId -> Promise, so parallel reads for one lead ask once

async function caseRefStateForLead(lead) {
  const cmId = String((lead && lead.clientMasterItemId) || '').trim();
  if (!cmId) return { caseRef: '', known: true };      // no case row: genuinely pre-case
  // A page that loads two archives for the same lead (the consultation detail
  // reads the intake and pre-consult files side by side) must ask Monday once.
  const pending = _caseRefInFlight.get(cmId);
  if (pending) return pending;
  const lookup = readCaseRefState(cmId, lead).finally(() => _caseRefInFlight.delete(cmId));
  _caseRefInFlight.set(cmId, lookup);
  return lookup;
}

async function readCaseRefState(cmId, lead) {
  try {
    const d = await require('../services/mondayApi').query(
      `query($i: [ID!]) { items(ids: $i) { column_values(ids: ["${CM_CASE_REF_COL}"]) { text } } }`,
      { i: [cmId] }
    );
    const items = d.items || [];
    // The row is supposed to exist — an empty result is a failure to read it,
    // not evidence that the client has no case.
    if (!items.length) {
      console.warn(`[FolderRefs] Client Master ${cmId} returned no row for lead ${lead && lead.id}`);
      return { caseRef: '', known: false };
    }
    return { caseRef: ((items[0].column_values || [])[0]?.text || '').trim(), known: true };
  } catch (err) {
    console.warn(`[FolderRefs] case-ref read failed for lead ${lead && lead.id}: ${err.message}`);
    return { caseRef: '', known: false };
  }
}

/** The case reference of the lead's case, or '' (never throws). */
async function caseRefForLead(lead) {
  return (await caseRefStateForLead(lead)).caseRef;
}

/**
 * Folder refs to try, most-likely first: the renamed case folder, then the
 * pre-rename lead folder. A lead with no case yields the lead folder only.
 * @returns {Promise<Array<{clientName: string, caseRef: string}>>}
 */
async function candidateFolderRefs(lead) {
  return (await candidateFolderState(lead)).refs;
}

/** candidateFolderRefs plus whether the case reference could actually be READ. */
async function candidateFolderState(lead) {
  const clientName = (lead && (lead.fullName || lead.name)) || `Lead ${lead && lead.id}`;
  const refs = [];
  const { caseRef, known } = await caseRefStateForLead(lead);
  if (caseRef) refs.push({ clientName, caseRef });
  refs.push({ clientName, caseRef: `LEAD-${lead && lead.id}` });
  return { refs, caseRefKnown: known };
}

/**
 * The lead's folder as it is named NOW, read from the folder itself.
 * The last resort when the case reference cannot be read but the lead carries
 * the folder's driveItem id: the folder's own name is the truth, whatever the
 * case reference turned out to be.
 */
async function refFromFolderId(od, lead) {
  const id = String((lead && lead.oneDriveFolderId) || '').trim();
  if (!id) return null;
  const item = await od.getDriveItemById(id);
  if (!item) return null;
  // DIRECTLY under the client-documents root — the same guard caseRefService
  // applies before renaming. The id lives in a staff-editable Monday column, so
  // it is not on its own authority to send a signed agreement anywhere.
  const parent = String(item.parentPath || '');
  if (!parent.endsWith(`/${ONEDRIVE_ROOT_FOLDER}`)) {
    console.warn(`[FolderRefs] lead ${lead && lead.id}'s folder sits outside "${ONEDRIVE_ROOT_FOLDER}" (${parent}) — not writing to it`);
    return null;
  }
  const name = String(item.name || '');
  const at = name.lastIndexOf(' - ');          // a client name may itself contain " - "
  if (at < 0) return null;
  return { clientName: name.slice(0, at), caseRef: name.slice(at + 3) };
}

/**
 * Where a NEW file for this lead belongs.
 *
 * Prefers the folder that ACTUALLY EXISTS, because the case reference is
 * written to Client Master a moment before the folder is renamed: naming the
 * case folder inside that window would create it as a second folder and make
 * the rename fail with a 409 — the very split this is here to prevent.
 * So: the case folder if it exists; else the lead folder if it exists (the
 * rename will carry the file across); else the case name, which is final.
 *
 * @param {object} lead
 * @param {object} [oneDrive]  oneDriveService (injected for tests)
 */
async function writeRef(lead, oneDrive = null) {
  const { refs, caseRefKnown } = await candidateFolderState(lead);
  const od = oneDrive || require('../services/oneDriveService');

  // One candidate means "this lead has no case" — but only when we actually
  // KNOW that. If Monday could not answer, a case may well exist and its
  // folder may already have been renamed to carry the reference, so naming
  // "LEAD-{id}" unprobed would re-create the old folder beside the real one.
  if (refs.length < 2) {
    if (caseRefKnown) return refs[0];
    const lead1 = refs[0];
    // Per-probe, like the loop below: one transient failure forecloses only
    // itself, never the lookups that could still answer the question.
    try {
      if (await od.getClientFolderByName(`${lead1.clientName} - ${lead1.caseRef}`)) return lead1;
    } catch (err) {
      console.warn(`[FolderRefs] exact-name check for "${lead1.caseRef}" failed for lead ${lead && lead.id}: ${err.message}`);
    }
    try {
      if (await od.findCaseFolderByRef(lead1.caseRef)) return lead1;
    } catch (err) {
      console.warn(`[FolderRefs] folder check for "${lead1.caseRef}" failed for lead ${lead && lead.id}: ${err.message}`);
    }
    try {
      // Proven gone: it HAS been renamed, for a case this call cannot name.
      // Ask the folder what it is called now.
      const viaId = await refFromFolderId(od, lead);
      if (viaId) return viaId;
    } catch (err) {
      console.warn(`[FolderRefs] folder-id check failed for lead ${lead && lead.id}: ${err.message}`);
    }
    // Better to store nothing this time — every caller is best-effort and
    // retries — than to mint a second root folder for this client forever.
    throw new Error(`client folder unknown for lead ${lead && lead.id}: the case reference could not be read`);
  }

  let disproved = 0;                       // candidates that answered a definite "not there"
  for (const ref of refs) {
    let answered = false;
    // Cheap exact-name lookup first. A failure here is NOT the end of the
    // question — the authoritative lookup below may still answer it.
    try {
      if (await od.getClientFolderByName(`${ref.clientName} - ${ref.caseRef}`)) return ref;
    } catch (err) {
      console.warn(`[FolderRefs] exact-name check for "${ref.caseRef}" failed for lead ${lead && lead.id}: ${err.message}`);
    }
    // The suffix " - {ref}" is what actually owns a folder; the client-name half
    // drifts (staff append a client number to the Monday name), so an
    // exact-name miss is not proof of absence.
    try {
      if (await od.findCaseFolderByRef(ref.caseRef)) return ref;
      answered = true;
    } catch (err) {
      console.warn(`[FolderRefs] folder check for "${ref.caseRef}" failed for lead ${lead && lead.id}: ${err.message}`);
    }
    if (!answered) {
      // Nobody could answer for this candidate. Only a CONFIRMED absence lets a
      // less-preferred candidate win: if the CASE folder is already known not to
      // exist, naming it would create it as a second folder and make the pending
      // rename fail — so the lead folder is the better guess, and the rename
      // carries the file across. Otherwise the case ref, which is the final name.
      return disproved ? refs[refs.length - 1] : refs[0];
    }
    disproved += 1;
  }
  return refs[0];
}

/**
 * Read a file from whichever of the lead's folders holds it.
 * @param {object} oneDrive  the oneDriveService module (passed in — no cycle)
 * @param {object} lead
 * @param {{ subfolder: string, filename: string }} where
 * @returns {Promise<Buffer|null>} null when no candidate holds it
 */
async function readFirst(oneDrive, lead, { subfolder, filename }) {
  const refs = await candidateFolderRefs(lead);
  for (const ref of refs) {
    // readFile returns null for "not there" and THROWS for anything else. A
    // genuine miss moves to the next candidate; a storage failure is allowed to
    // surface, so a transient error can never be mistaken for "absent" and
    // quietly serve an older copy from the other folder. Each caller already
    // wraps this and decides what a failure means for it.
    const buf = await oneDrive.readFile({ ...ref, subfolder, filename });
    if (buf) return buf;
  }
  return null;
}

module.exports = { candidateFolderRefs, candidateFolderState, writeRef, readFirst, caseRefForLead, caseRefStateForLead, CM_CASE_REF_COL };
