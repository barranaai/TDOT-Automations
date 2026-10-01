const mondayApi = require('./mondayApi');
const { clientMasterBoardId, cmColumns } = require('../../config/monday');
const { SUB_TYPES_BY_CASE } = require('../../config/caseTypes');
const { ensureAccessToken } = require('./accessTokenService');
const portalSvc = require('./clientPortalService');

const CASE_REF_COL      = 'text_mm142s49';
const CASE_TYPE_COL     = 'dropdown_mm0xd1qn';
const SUB_TYPE_HINT_COL = 'text_mm21gw44';
const PORTAL_LINK_COL   = (cmColumns && cmColumns.portalLink) || 'link_mm2vta5';
const ONEDRIVE_ID_COL   = (cmColumns && cmColumns.oneDriveFolderId) || 'text_mm47y540';
const ONEDRIVE_ROOT_FOLDER = 'Client Documents';   // mirrors oneDriveService.ROOT_FOLDER (ownership check only)
const CASE_STAGE_COL        = 'color_mm0x8faa';
const CHECKLIST_APPLIED_COL = 'color_mm0xs7kp';
const STAGE_START_COL       = 'date_mm0xjm1z';   // the document-chasing clock

const CASE_TYPE_ABBR = {
  'AAIP':                                                          'AAIP',
  'Addition of Spouse':                                            'AOS',
  'Amendment of Document':                                         'AMD',
  'Appeal':                                                        'APPL',
  'BCPNP':                                                         'BCPNP',
  'BOWP':                                                          'BOWP',
  'CEC':                                                           'CEC',
  'Canadian Experience Class (EE after ITA)':                      'CEC-EE',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'CEC-PR',
  'Canadian Experience Class (Profile+ITA+Submission)':            'CEC-PS',
  'Child Sponsorship':                                             'CSP',
  'Citizenship':                                                   'CIT',
  'Co-op WP':                                                      'COWP',
  'Concurrent WP':                                                 'CWP',
  'ETA':                                                           'ETA',
  'Employer Portal':                                               'EP',
  'Federal PR':                                                    'FPR',
  'Francophone Mobility WP':                                       'FMWP',
  'H & C':                                                         'HC',
  'ICAS/WES/IQAS':                                                 'ICAS',
  'Inland Spousal Sponsorship':                                    'ISS',
  'Invitation Letter':                                             'IL',
  'LMIA':                                                          'LMIA',
  'LMIA Based WP':                                                 'LBW',
  'LMIA Exempt WP':                                                'LEW',
  'Manitoba PNP':                                                  'MPNP',
  'MPNP':                                                          'MPNP',
  'Miscellaneous':                                                 'MISC',
  'NB WP Extension':                                               'NBWP',
  'NSNP':                                                          'NSNP',
  'Notary':                                                        'NOT',
  'OCI / Passport Surrender':                                      'OCI',
  'OINP':                                                          'OINP',
  'Outland Spousal Sponsorship':                                   'OSS',
  'PFL':                                                           'PFL',
  'PGWP':                                                          'PGWP',
  'PR Card Renewal':                                               'PCR',
  'PRAA':                                                          'PRAA',
  'PRTD':                                                          'PRTD',
  'Parents/Grandparents Sponsorship':                              'PGP',
  'RCIP':                                                          'RCIP',
  'RNIP':                                                          'RNIP',
  'Reconsideration':                                               'RECON',
  'Refugee':                                                       'REF',
  'Refugee WP':                                                    'RWP',
  'Renunciation of PR':                                            'RPR',
  'Request Letter':                                                'RL',
  'SCLPC WP':                                                      'SCLWP',
  'SNIP':                                                          'SNIP',
  'SOWP':                                                          'SOWP',
  'Study Permit':                                                  'SP',
  'Study Permit Extension':                                        'SPE',
  'Supervisa':                                                     'SV',
  'TRP':                                                           'TRP',
  'TRV':                                                           'TRV',
  'USA Visa':                                                      'UV',
  'Visitor Record / Extension':                                    'VRE',
  'Visitor Visa':                                                  'VV',
};

async function getItemCaseRef(itemId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: ["${CASE_REF_COL}"]) { text }
       }
     }`,
    { itemId: String(itemId) }
  );
  return (data.items[0]?.column_values[0]?.text || '').trim();
}

/** "2026-VV-" for a case type (unknown types → MISC). */
function prefixFor(caseType) {
  return `${new Date().getFullYear()}-${CASE_TYPE_ABBR[caseType] || 'MISC'}-`;
}


async function updateSubTypeHint(itemId, caseType) {
  const subTypes = SUB_TYPES_BY_CASE[caseType] || [];
  const hint = subTypes.length
    ? subTypes.join('  |  ')
    : '—  (no sub types for this case type)';

  await mondayApi.query(
    `mutation($itemId: ID!, $boardId: ID!, $value: JSON!) {
       change_column_value(
         item_id:   $itemId,
         board_id:  $boardId,
         column_id: "${SUB_TYPE_HINT_COL}",
         value:     $value
       ) { id }
     }`,
    {
      itemId:  String(itemId),
      boardId: String(clientMasterBoardId),
      value:   JSON.stringify(hint),
    }
  );

  console.log(`[CaseRef] Sub Type hint updated for item ${itemId}: "${hint}"`);
}

async function onCaseTypeSet({ itemId, caseType }) {
  if (!caseType) return;

  // Update the Sub Type hint column immediately so staff see valid options
  await updateSubTypeHint(itemId, caseType).catch(err =>
    console.error('[CaseRef] Error updating sub type hint:', err.message)
  );

  // One allocation at a time, from choosing the number until it is written —
  // and the "already has one?" question asked again INSIDE the lock, so a
  // webhook delivered twice cannot give one case two numbers.
  const allocator = require('./caseRefAllocator');
  let assigned;
  try {
    // Only assign a Case Ref if the item doesn't already have one (a quick
    // answer for the common case, before queueing for the lock).
    const existing = await getItemCaseRef(itemId);
    if (existing) {
      console.log(`[CaseRef] Item ${itemId} already has ref "${existing}", skipping`);
      return;
    }
    assigned = await allocator.withAllocationLock(async () => {
      const again = await getItemCaseRef(itemId);
      if (again) return { already: again };
      const a = await allocator.allocate(prefixFor(caseType));
      // Reserved BEFORE it is written: if the write fails (or half-succeeds),
      // the number is simply never used — burning one is harmless, reusing one is not.
      a.markSaved = await allocator.recordAssigned(a.ref);   // best effort: the number stands either way
      await mondayApi.query(
        `mutation($itemId: ID!, $boardId: ID!, $value: JSON!) {
           change_column_value(
             item_id:   $itemId,
             board_id:  $boardId,
             column_id: "${CASE_REF_COL}",
             value:     $value
           ) { id }
         }`,
        {
          itemId:  String(itemId),
          boardId: String(clientMasterBoardId),
          value:   JSON.stringify(a.ref),
        }
      );
      return a;
    });
  } catch (err) {
    // A case with no number stalls everything after it (portal link, folder,
    // checklist) — staff must see why and how to retry, not a blank column.
    console.error(`[CaseRef] Could not assign a case number to item ${itemId} (${caseType}): ${err.message}`);
    await mondayApi.query(`mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`, {
      itemId: String(itemId),
      body: `⚠ No case number could be assigned (${String(err.message || err).replace(/[<>]/g, '').slice(0, 200)}). ` +
        `Clear the Primary Case Type and select it again to retry — if it keeps failing, tell an admin.`,
    }).catch((e) => console.error(`[CaseRef] …and the note about it could not be posted on item ${itemId}: ${e.message}`));
    throw err;
  }
  if (assigned.already) {
    console.log(`[CaseRef] Item ${itemId} got ref "${assigned.already}" meanwhile, skipping`);
    return;
  }
  const caseRef = assigned.ref;

  console.log(`[CaseRef] Assigned ${caseRef} to item ${itemId}` +
    (assigned.from.folders > assigned.from.board ? ` (a leftover OneDrive folder holds ${assigned.from.folders} — the board alone would have reused it)` : '') +
    (assigned.skipped.length ? ` (skipped ${assigned.skipped.join(', ')}: already on a board)` : ''));
  checkAssignedRef({ itemId, caseRef, assigned }).catch((err) =>
    console.warn(`[CaseRef] Could not double-check ${caseRef}: ${err.message}`));

  // Fire-and-forget: write the unified Client Portal link column.
  // Failures here MUST NOT break the case-ref assignment flow — the case can
  // still be served correctly without the link column populated; it can be
  // backfilled with scripts/backfill-portal-links.js.
  writePortalLinkForItem({ itemId, caseRef }).catch(err =>
    console.warn(`[CaseRef] Could not write portal link for ${caseRef}: ${err.message}`)
  );

  // Fire-and-forget, but SEQUENCED: rename the intake-stage OneDrive folder,
  // THEN materialise the lead's family answers as Family Members rows (the
  // rows key on the case ref, and must exist BEFORE any checklist seeding so
  // family document sets are included), THEN make sure the sponsor / inviter
  // has a row of their own where the questionnaire gives them a section
  // ('prepare' never emails; it recognises the intake's Spouse row as the
  // same person), THEN resume any stuck onboarding — so a resumed seeding
  // sees the renamed folder and every family row. When rows were JUST
  // written, the prepare pass creates nothing: Monday's board search can lag
  // a create_item by seconds, and a Sponsor row written against a read that
  // missed the intake's Spouse row would be a second row for one person. The
  // first questionnaire read seeds from the board later; the DCS pass re-checks.
  renameClientFolderForItem({ itemId, caseRef })
    .catch(err => console.warn(`[CaseRef] OneDrive folder rename skipped for ${caseRef}: ${err.message}`))
    .then(() => require('./familyCompositionService').createFamilyRowsForItem({ itemId, caseRef }))
    .catch(err => { console.warn(`[CaseRef] Family rows skipped for ${caseRef}: ${err.message}`); return 0; })
    .then((rows) => require('./sponsorOnboardingService').ensureSponsor({ itemId, caseRef, mode: 'prepare', trigger: 'case-ref', boardJustWritten: Number(rows) > 0 }))
    .catch(err => console.warn(`[CaseRef] Sponsor prepare skipped for ${caseRef}: ${err.message}`))
    .then(() => resumeOnboardingIfStuck({ itemId, caseRef }))
    .catch(err => console.warn(`[CaseRef] Stuck-onboarding check failed for ${caseRef}: ${err.message}`));
}

/**
 * Rename the client's intake-stage OneDrive folder to its final name.
 * The folder id was stored on the Client Master at handoff (Phase 2 leads).
 * No-op for clients without one (legacy/manually created cases) — Phase 1
 * then creates the folder path-based at Document Collection Started, as ever.
 */
/**
 * The client's OneDrive folder id, resolved from the lead(s) linked to this
 * case — the fallback for when the case row never received it.
 *
 * Deliberately conservative: a case can have several leads (dedup reuse), and
 * renaming the WRONG person's folder would scatter their documents. So: exactly
 * one linked lead may carry a folder id, that folder must still exist, must
 * still be named "{that lead's name} - LEAD-{that lead's id}" (i.e. it has NOT
 * already been renamed for another case), and must sit directly under the
 * client-documents root. Anything else → '' (and a log saying why).
 *
 * @returns {Promise<string>} driveItem id, or '' when it cannot be established
 */
async function folderIdFromLead(itemId, clientName) {
  let leads = [];
  try {
    leads = await require('./leadService').findAllByColumnValue('clientMasterItemId', String(itemId));
  } catch (err) {
    console.warn(`[CaseRef] Lead lookup for case ${itemId} failed: ${err.message}`);
    return '';
  }
  const owners = (leads || []).filter((l) => l && String(l.oneDriveFolderId || '').trim());
  if (owners.length !== 1) {
    if (owners.length > 1) console.warn(`[CaseRef] ${owners.length} linked leads carry a folder id for case ${itemId} — not guessing which folder is the client's; leaving it alone.`);
    return '';
  }

  const lead = owners[0];
  const folderId = String(lead.oneDriveFolderId).trim();
  const expected = `${lead.fullName || clientName} - LEAD-${lead.id}`.replace(/[*:"<>?/\\|]/g, '').trim();
  try {
    const drive = await require('./oneDriveService').getDriveItemById(folderId);
    if (!drive) { console.warn(`[CaseRef] Lead ${lead.id}'s folder ${folderId} no longer exists — not renaming.`); return ''; }
    if (drive.name !== expected) {
      console.warn(`[CaseRef] Lead ${lead.id}'s folder is named "${drive.name}", not "${expected}" — it has already been renamed or belongs elsewhere; not touching it.`);
      return '';
    }
    // DIRECTLY under the root — not merely somewhere inside it. Same strict
    // test deletionService uses before acting on a staff-editable folder id.
    if (!String(drive.parentPath || '').endsWith(`/${ONEDRIVE_ROOT_FOLDER}`)) {
      console.warn(`[CaseRef] Lead ${lead.id}'s folder sits outside "${ONEDRIVE_ROOT_FOLDER}" (${drive.parentPath}) — not touching it.`);
      return '';
    }
  } catch (err) {
    console.warn(`[CaseRef] Could not verify lead ${lead.id}'s folder before renaming: ${err.message}`);
    return '';
  }
  console.log(`[CaseRef] Client folder resolved from lead ${lead.id} for case ${itemId} (the case row had none).`);
  return folderId;
}

async function renameClientFolderForItem({ itemId, caseRef }) {
  const data = await mondayApi.query(
    `query($id: ID!) { items(ids: [$id]) { name column_values(ids: ["${ONEDRIVE_ID_COL}"]) { text } } }`,
    { id: String(itemId) }
  );
  const item = data.items?.[0];
  const oneDrive = require('./oneDriveService');
  // No row read back, no name to rename TO — the fallback below cannot help
  // either, and every message here quotes the client's name.
  if (!item || !item.name) {
    console.warn(`[CaseRef] Client Master ${itemId} returned no row — cannot rename the client folder for ${caseRef}`);
    return;
  }
  let folderId = (item.column_values?.[0]?.text || '').trim();

  // SAFETY NET (Gauri 2026-09-04, point 12): the id is normally copied from the
  // lead when the case row is created, and handoffService now waits for it. If
  // that wait timed out (OneDrive slow) the column is empty and, before this
  // fallback, we returned silently — the lead folder kept its "LEAD-…" name and
  // the next case-ref-addressed write created a SECOND folder beside it.
  // Find the folder from the lead instead, but never guess: exactly one linked
  // lead must own it, and the folder must really still carry that lead's name.
  if (!folderId) {
    folderId = await folderIdFromLead(itemId, item.name);
    if (!folderId) {
      console.log(`[CaseRef] No client folder to rename for ${caseRef} — none on the case and none resolvable from a linked lead (normal for a legacy or manually created case).`);
      return;
    }
    // Back-fill so the careful-delete preview and any later rename can find it.
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
       }`,
      { boardId: String(clientMasterBoardId), itemId: String(itemId), cols: JSON.stringify({ [ONEDRIVE_ID_COL]: folderId }) }
    ).catch((err) => console.warn(`[CaseRef] Folder-id back-fill failed for ${caseRef}: ${err.message}`));
  }

  let renamed = false;
  try {
    await oneDrive.renameDriveItem(folderId, `${item.name} - ${caseRef}`);
    renamed = true;
    console.log(`[CaseRef] OneDrive folder renamed for ${caseRef}`);
  } catch (err) {
    // If the rename fails (OneDrive down, or a folder with the target name
    // already exists), the path-based flow will create/use a folder under the
    // NEW name — anything uploaded before this point stays in the old
    // "{name} - LEAD-…" folder. Tell staff so files get merged, not lost.
    console.warn(`[CaseRef] OneDrive folder rename FAILED for ${caseRef}: ${err.message}`);
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
      { itemId: String(itemId),
        body: `⚠ Could not rename this client's OneDrive intake folder to "${item.name} - ${caseRef}". ` +
              `Documents uploaded before today may still be in a folder named "${item.name} - LEAD-…" under Client Documents — please merge them manually, ` +
              `and create the working folders (${oneDrive.CASE_WORK_FOLDERS.join(', ')}) in the folder you keep.` }
    ).catch(() => {});
  }

  // The case has its reference now: give ITS folder the four staff working
  // folders (1-Coordinator-Working … 4-Submitted-IRCC). Only after a successful
  // rename — after a refused one, this id is the abandoned "LEAD-…" folder and
  // the note above tells staff which folder to set up. Best effort: if OneDrive
  // refuses, staff are told once so they can add them by hand (any later touch
  // of the folder — a questionnaire save, the checklist — adds them too).
  if (renamed) {
    try {
      await oneDrive.ensureCaseWorkFolders({ folderId, label: caseRef });
    } catch (err) {
      console.warn(`[CaseRef] Working folders not created for ${caseRef}: ${err.message}`);
      await mondayApi.query(
        `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
        { itemId: String(itemId), body: oneDrive.workFoldersFailedNoteText(err) }
      ).catch(() => {});
    }
  }
}

/**
 * Un-stick onboarding for cases paid BEFORE their Case Type was set.
 * In that order of events, retainerService moves Case Stage to
 * "Document Collection Started", but the stage webhook's checklist/intake-email
 * work bails out for lack of a case ref — and setting the Case Type later does
 * not re-fire the stage webhook. So when the ref is finally assigned, this
 * checks for that exact state and resumes what was skipped (mirroring the
 * Document Collection Started handler in mondayWebhook.js).
 */
const _resumeInFlight = new Set(); // itemId — collapses near-simultaneous duplicate webhook deliveries
let CASE_REF_RETRY_MS = 2000;       // one retry of an unreadable held-onboarding check (tests shorten it)

async function resumeOnboardingIfStuck({ itemId, caseRef }) {
  const key = String(itemId);
  if (_resumeInFlight.has(key)) return;
  _resumeInFlight.add(key);
  try {
    const data = await mondayApi.query(
      `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_STAGE_COL}", "${CHECKLIST_APPLIED_COL}", "color_mm0x9fnn", "${STAGE_START_COL}"]) { id text } } }`,
      { id: String(itemId) }
    );
    const cv = {};
    (data.items?.[0]?.column_values || []).forEach(c => { cv[c.id] = (c.text || '').trim(); });
    if (cv[CASE_STAGE_COL] !== 'Document Collection Started') return;
    // Require the EXPLICIT 'No' that retainerService writes on first payment.
    // An empty/legacy value means a manually-managed case that never went
    // through the payment flow — resuming would cold-email a real client.
    if ((cv[CHECKLIST_APPLIED_COL] || '').toLowerCase() !== 'no') return;
    // Payment gate (same invariant as everywhere): a payment that was marked
    // Paid by mistake and reverted leaves applied='No' behind — never resume
    // onboarding for a case that isn't currently Paid.
    if (cv['color_mm0x9fnn'] !== 'Paid') {
      console.log(`[CaseRef] ${caseRef}: onboarding-resume conditions met but Payment Status ≠ Paid — not resuming`);
      return;
    }
    // HELD for signatures (Paid set by hand before the agreement was fully
    // signed): this path used to send the intake email with no signature check.
    // The held-onboarding service decides instead — it waits for the agreement,
    // or, if it is already complete, starts onboarding now (once, recorded). A
    // case it places as NOT held (or with no linked lead) resumes as before. A
    // read error is retried once, then resumes as before (the case this path
    // exists for — paid before its Case Type — has no other rescue); but a
    // start it chose and could not record ("record-failed") is never sent from
    // here — the status sync retries it with the record.
    const resumeSvc = require('./onboardingResumeService');
    if (resumeSvc.isEnabled()) {
      let held = await resumeSvc.resumeIfOwed({ itemId, trigger: 'case-ref', caseRef });
      if (held.action === 'error' && held.code !== 'record-failed') {
        await new Promise((r) => setTimeout(r, CASE_REF_RETRY_MS));
        held = await resumeSvc.resumeIfOwed({ itemId, trigger: 'case-ref', caseRef });
      }
      const fallThrough = held.code === 'not-held' || held.code === 'no-lead' || (held.action === 'error' && held.code !== 'record-failed');
      if (!fallThrough) {
        console.log(`[CaseRef] ${caseRef}: onboarding is held for signatures — ${held.action}${held.code ? ` (${held.code})` : ''}; not resuming here`);
        return;
      }
    }

    // Residual micro-race (documented): if payment lands in the seconds
    // between the case-ref write and this read, the stage webhook handles
    // onboarding and this duplicates the intake email once. The window is a
    // single Monday query wide and requires payment + case-type-set in the
    // same instant; checklist seeding itself stays deduped by its own guard
    // and per-row unique keys.
    console.log(`[CaseRef] ${caseRef} was Paid before its Case Type was set — resuming onboarding (intake email + checklist)`);
    const emailService     = require('./emailService');     // lazy: avoid require cycles
    const checklistService = require('./checklistService');

    // The document-chasing clock. This start never set one (so these clients
    // were never chased), and it is also the trace that tells the held-
    // onboarding service this case WAS started — so it never starts it again.
    // Same payload as the payment webhook's; only when blank.
    if (!cv[STAGE_START_COL]) {
      await mondayApi.query(
        `mutation($b: ID!, $i: ID!, $c: JSON!){ change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c){ id } }`,
        { b: String(clientMasterBoardId), i: String(itemId),
          c: JSON.stringify({ [STAGE_START_COL]: { date: new Date().toISOString().slice(0, 10) }, color_mm1abve4: null, numeric_mm1a4e8r: '0' }) }
      ).catch((err) => console.warn(`[CaseRef] Resume: chasing clock not started for ${caseRef}: ${err.message}`));
    }

    emailService.sendIntakeEmail(itemId).catch(err =>
      console.error(`[CaseRef] Resume: intake email failed for ${caseRef}:`, err.message)
    );
    // The sponsor's own portal email (same link) — the service checks the
    // Paid / stage / not-yet-applied gates and its sent-marker itself.
    require('./sponsorOnboardingService').ensureSponsor({ itemId, caseRef, mode: 'onboard', trigger: 'resume' }).catch(err =>
      console.error(`[CaseRef] Resume: sponsor onboarding failed for ${caseRef}:`, err.message)
    );
    await checklistService.onDocumentCollectionStarted({ itemId, boardId: clientMasterBoardId })
      .then(() => console.log(`[CaseRef] Resume: checklist setup complete for ${caseRef}`))
      .catch(err => console.error(`[CaseRef] Resume: checklist setup failed for ${caseRef}:`, err.message));
  } finally {
    _resumeInFlight.delete(key);
  }
}

/**
 * After a number is written: tell staff when it could not be checked against
 * OneDrive, or when another Cases-board row carries the same number (a number
 * typed by hand, or one given out by something other than this process).
 * Best effort — the number stays either way.
 */
async function checkAssignedRef({ itemId, caseRef, assigned }) {
  const notes = [];
  if (assigned.folderCheck === 'unavailable') {
    notes.push(`⚠ Case number ${caseRef} was assigned while OneDrive could not be checked (${assigned.folderError || 'OneDrive unavailable'}). ` +
      `If a folder in "Client Documents" already ends with " - ${caseRef}" and belongs to someone else, tell an admin before any documents arrive.`);
  }
  if (assigned.folderCheck !== 'unavailable' && (assigned.markCheck === 'unavailable' || assigned.markSaved === false)) {
    notes.push(`⚠ Case number ${caseRef} is fine, but it could not be ${assigned.markSaved === false ? 'saved to' : 'checked against'} the record of numbers already used ("TDOT System/case-number-high-water.json" in OneDrive). ` +
      `Until that works again, a number freed by a careful delete could be given out twice — tell an admin.`);
  }
  const d = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:10, board_id:$b, columns:[{column_id:"${CASE_REF_COL}", column_values:[$v]}]){ items{ id name } } }`,
    { b: String(clientMasterBoardId), v: caseRef });
  const others = ((d.items_page_by_column_values || {}).items || []).filter((it) => String(it.id) !== String(itemId));
  if (others.length) {
    notes.push(`⚠ Case number ${caseRef} is ALSO on ${others.map((o) => `"${o.name}" (item ${o.id})`).join(', ')}. ` +
      `Two cases must never share a number — tell an admin before any documents arrive.`);
    console.error(`[CaseRef] ${caseRef} assigned to item ${itemId} is also on ${others.map((o) => o.id).join(', ')}`);
  }
  for (const body of notes) {
    await mondayApi.query(`mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`, { itemId: String(itemId), body });
  }
}

/**
 * Write the Client Portal Link column on the Client Master row.
 * Pulls (or generates) the access token first so the URL is fully usable.
 * Idempotent — safe to run multiple times for the same item.
 */
async function writePortalLinkForItem({ itemId, caseRef }) {
  const accessToken = await ensureAccessToken(itemId).catch(() => '');
  if (!accessToken) {
    console.warn(`[CaseRef] No access token available for item ${itemId} — portal link will be missing token`);
  }
  // staff:true → URL includes ?staff=1 so the route knows to trigger Monday
  // OAuth when a staff member opens the link without an active cookie.
  // This column is only ever rendered inside Monday (staff-facing); clients
  // never see it — they get the email link instead, which has no staff flag.
  const url = portalSvc.buildPortalUrl({ caseRef, accessToken, staff: true });

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(clientMasterBoardId),
      itemId:  String(itemId),
      cols:    JSON.stringify({
        [PORTAL_LINK_COL]: { url, text: 'Open Client Portal' },
      }),
    }
  );

  console.log(`[CaseRef] Wrote Client Portal link for ${caseRef}`);
}

module.exports = {
  onCaseTypeSet, prefixFor, checkAssignedRef, writePortalLinkForItem, CASE_TYPE_ABBR, resumeOnboardingIfStuck,
  _setRetryMsForTests: (ms) => { CASE_REF_RETRY_MS = ms; },
  // Exported for tests: the rename is what keeps a client to ONE folder.
  renameClientFolderForItem, folderIdFromLead,
};
