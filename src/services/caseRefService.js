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
const CASE_STAGE_COL        = 'color_mm0x8faa';
const CHECKLIST_APPLIED_COL = 'color_mm0xs7kp';

const CASE_TYPE_ABBR = {
  'AAIP':                                                          'AAIP',
  'Addition of Spouse':                                            'AOS',
  'Amendment of Document':                                         'AMD',
  'Appeal':                                                        'APPL',
  'BCPNP':                                                         'BCPNP',
  'BOWP':                                                          'BOWP',
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

async function getAllCaseRefs() {
  let allRefs = [];
  let cursor  = null;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items { column_values(ids: ["${CASE_REF_COL}"]) { text } }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items { column_values(ids: ["${CASE_REF_COL}"]) { text } }
             }
           }
         }`
      );
    }

    const page = data.boards[0].items_page;
    for (const item of page.items) {
      const ref = item.column_values[0]?.text?.trim();
      if (ref) allRefs.push(ref);
    }
    cursor = page.cursor || null;
  } while (cursor);

  return allRefs;
}

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

async function generateCaseRef(caseType) {
  const year  = new Date().getFullYear();
  const abbr  = CASE_TYPE_ABBR[caseType] || 'MISC';
  const prefix = `${year}-${abbr}-`;

  const allRefs = await getAllCaseRefs();

  let maxSeq = 0;
  for (const ref of allRefs) {
    if (ref.startsWith(prefix)) {
      const seq = parseInt(ref.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  }

  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
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

  // Only assign a Case Ref if the item doesn't already have one
  const existing = await getItemCaseRef(itemId);
  if (existing) {
    console.log(`[CaseRef] Item ${itemId} already has ref "${existing}", skipping`);
    return;
  }

  const caseRef = await generateCaseRef(caseType);

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
      value:   JSON.stringify(caseRef),
    }
  );

  console.log(`[CaseRef] Assigned ${caseRef} to item ${itemId}`);

  // Fire-and-forget: write the unified Client Portal link column.
  // Failures here MUST NOT break the case-ref assignment flow — the case can
  // still be served correctly without the link column populated; it can be
  // backfilled with scripts/backfill-portal-links.js.
  writePortalLinkForItem({ itemId, caseRef }).catch(err =>
    console.warn(`[CaseRef] Could not write portal link for ${caseRef}: ${err.message}`)
  );

  // Fire-and-forget, but SEQUENCED: first rename the intake-stage OneDrive
  // folder ("{name} - LEAD-{id}" → "{name} - {caseRef}"), THEN resume any
  // stuck onboarding — so a resumed checklist setup resolves to the renamed
  // folder instead of racing it into a duplicate.
  renameClientFolderForItem({ itemId, caseRef })
    .catch(err => console.warn(`[CaseRef] OneDrive folder rename skipped for ${caseRef}: ${err.message}`))
    .then(() => resumeOnboardingIfStuck({ itemId, caseRef }))
    .catch(err => console.warn(`[CaseRef] Stuck-onboarding check failed for ${caseRef}: ${err.message}`));
}

/**
 * Rename the client's intake-stage OneDrive folder to its final name.
 * The folder id was stored on the Client Master at handoff (Phase 2 leads).
 * No-op for clients without one (legacy/manually created cases) — Phase 1
 * then creates the folder path-based at Document Collection Started, as ever.
 */
async function renameClientFolderForItem({ itemId, caseRef }) {
  const data = await mondayApi.query(
    `query($id: ID!) { items(ids: [$id]) { name column_values(ids: ["${ONEDRIVE_ID_COL}"]) { text } } }`,
    { id: String(itemId) }
  );
  const item = data.items?.[0];
  const folderId = (item?.column_values?.[0]?.text || '').trim();
  if (!folderId) return;

  const oneDrive = require('./oneDriveService');
  try {
    await oneDrive.renameDriveItem(folderId, `${item.name} - ${caseRef}`);
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
              `Documents uploaded before today may still be in a folder named "${item.name} - LEAD-…" under Client Documents — please merge them manually.` }
    ).catch(() => {});
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

async function resumeOnboardingIfStuck({ itemId, caseRef }) {
  const key = String(itemId);
  if (_resumeInFlight.has(key)) return;
  _resumeInFlight.add(key);
  try {
    const data = await mondayApi.query(
      `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_STAGE_COL}", "${CHECKLIST_APPLIED_COL}"]) { id text } } }`,
      { id: String(itemId) }
    );
    const cv = {};
    (data.items?.[0]?.column_values || []).forEach(c => { cv[c.id] = (c.text || '').trim(); });
    if (cv[CASE_STAGE_COL] !== 'Document Collection Started') return;
    // Require the EXPLICIT 'No' that retainerService writes on first payment.
    // An empty/legacy value means a manually-managed case that never went
    // through the payment flow — resuming would cold-email a real client.
    if ((cv[CHECKLIST_APPLIED_COL] || '').toLowerCase() !== 'no') return;

    // Residual micro-race (documented): if payment lands in the seconds
    // between the case-ref write and this read, the stage webhook handles
    // onboarding and this duplicates the intake email once. The window is a
    // single Monday query wide and requires payment + case-type-set in the
    // same instant; checklist seeding itself stays deduped by its own guard
    // and per-row unique keys.
    console.log(`[CaseRef] ${caseRef} was Paid before its Case Type was set — resuming onboarding (intake email + checklist)`);
    const emailService     = require('./emailService');     // lazy: avoid require cycles
    const checklistService = require('./checklistService');

    emailService.sendIntakeEmail(itemId).catch(err =>
      console.error(`[CaseRef] Resume: intake email failed for ${caseRef}:`, err.message)
    );
    await checklistService.onDocumentCollectionStarted({ itemId, boardId: clientMasterBoardId })
      .then(() => console.log(`[CaseRef] Resume: checklist setup complete for ${caseRef}`))
      .catch(err => console.error(`[CaseRef] Resume: checklist setup failed for ${caseRef}:`, err.message));
  } finally {
    _resumeInFlight.delete(key);
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

module.exports = { onCaseTypeSet, generateCaseRef, writePortalLinkForItem };
