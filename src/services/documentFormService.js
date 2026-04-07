const mondayApi = require('./mondayApi');
const { uploadFile: uploadToOneDrive } = require('./oneDriveService');
const { clientMasterBoardId } = require('../../config/monday');

// ─── Board / Column IDs ───────────────────────────────────────────────────────

const EXEC_BOARD_ID       = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const TEMPLATE_BOARD_ID   = process.env.MONDAY_TEMPLATE_BOARD_ID  || '18401624183';
const CM_BOARD_ID         = clientMasterBoardId || process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';

// Execution Board columns
const CASE_REF_COL        = 'text_mm0z2cck';   // Case Reference Number
const DOC_CODE_COL        = 'text_mm0zr7tf';   // Document Code
const DOC_STATUS_COL      = 'color_mm0zwgvr';  // Document Status
const UPLOAD_DATE_COL     = 'date_mm0zyw0m';   // Last Upload Date
const REVIEW_REQ_COL      = 'color_mm0z796e';  // Review Required
const REVIEW_NOTES_COL    = 'long_text_mm0zbpr'; // Review Notes
const INTAKE_ID_COL       = 'text_mm0zfsp1';   // Template Board item ID (stored at checklist creation)
const CATEGORY_MIRROR_COL = 'lookup_mm0zqbvt'; // Document Category (mirror — often null)

// Template Board columns
const TMPL_DESC_COL           = 'long_text_mm0zmb7j'; // Description
const TMPL_INSTRUCTIONS_COL   = 'long_text_mm0z10mg'; // Client-Facing Instructions
const TMPL_CATEGORY_COL       = 'dropdown_mm0x41zm';  // Document Category
const TMPL_APPLICANT_TYPE_COL = 'dropdown_mm261bn6';  // Applicant Type (which member)

// Client Master Board columns
const CM_CASE_REF_COL = 'text_mm142s49'; // Case Reference Number

// Columns to fetch per execution item
const FETCH_COLS = [
  DOC_CODE_COL,
  DOC_STATUS_COL,
  UPLOAD_DATE_COL,
  REVIEW_NOTES_COL,
  INTAKE_ID_COL,
  CATEGORY_MIRROR_COL,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the client's full name from the Client Master Board by case reference.
 */
async function getClientName(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $caseRef: String!) {
       items_page_by_column_values(
         limit: 1,
         board_id: $boardId,
         columns: [{ column_id: "${CM_CASE_REF_COL}", column_values: [$caseRef] }]
       ) { items { name } }
     }`,
    { boardId: String(CM_BOARD_ID), caseRef }
  );
  return data?.items_page_by_column_values?.items?.[0]?.name?.trim() || 'Unknown Client';
}

/**
 * Fetch category from the Template Board using the stored intakeId.
 * Used as fallback when the mirror column on the Execution Board is null.
 */
async function getCategoryFromTemplate(intakeId) {
  if (!intakeId) return 'General';
  try {
    const data = await mondayApi.query(
      `query($id: ID!) {
         items(ids: [$id]) {
           column_values(ids: ["${TMPL_CATEGORY_COL}"]) { id text }
         }
       }`,
      { id: String(intakeId) }
    );
    return data?.items?.[0]?.column_values
      ?.find((c) => c.id === TMPL_CATEGORY_COL)?.text?.trim() || 'General';
  } catch (err) {
    console.warn(`[DocForm] Template category lookup failed for intakeId ${intakeId}: ${err.message}`);
    return 'General';
  }
}

// ─── Public: load form data ───────────────────────────────────────────────────

/**
 * Fetch all document checklist items for a given case reference.
 *
 * Optimised two-query strategy:
 *  1. Fetch all execution items for the case (single paginated query).
 *  2. Batch-fetch only the relevant template items by their stored IDs
 *     (text_mm0zfsp1) — no full-table scan of the Template Board.
 *
 * Returns items sorted by category then document code.
 */
async function getCaseDocuments(caseRef) {
  // ── Step 1: Execution Board items for this case ───────────────────────────
  const execData = await mondayApi.query(
    `query($boardId: ID!, $caseRef: String!) {
       items_page_by_column_values(
         limit: 500,
         board_id: $boardId,
         columns: [{ column_id: "${CASE_REF_COL}", column_values: [$caseRef] }]
       ) {
         items {
           id
           name
           column_values(ids: ${JSON.stringify(FETCH_COLS)}) { id text }
         }
       }
     }`,
    { boardId: EXEC_BOARD_ID, caseRef }
  );

  const items = execData?.items_page_by_column_values?.items || [];
  if (!items.length) return [];

  // Helper: extract text from column_values array
  const col = (columnValues, id) =>
    columnValues.find((c) => c.id === id)?.text?.trim() || '';

  // ── Step 2: Batch-fetch template items by intakeId ────────────────────────
  const intakeIds = [
    ...new Set(
      items
        .map((item) => col(item.column_values, INTAKE_ID_COL))
        .filter(Boolean)
    ),
  ];

  const templateMap = {};
  if (intakeIds.length) {
    const tmplData = await mondayApi.query(
      `query($ids: [ID!]!) {
         items(ids: $ids) {
           id
           column_values(ids: [
             "${TMPL_DESC_COL}",
             "${TMPL_INSTRUCTIONS_COL}",
             "${TMPL_CATEGORY_COL}",
             "${TMPL_APPLICANT_TYPE_COL}"
           ]) { id text }
         }
       }`,
      { ids: intakeIds }
    );

    for (const tmpl of tmplData?.items || []) {
      const tc = (id) => tmpl.column_values.find((c) => c.id === id)?.text?.trim() || '';
      templateMap[tmpl.id] = {
        description:        tc(TMPL_DESC_COL),
        clientInstructions: tc(TMPL_INSTRUCTIONS_COL),
        category:           tc(TMPL_CATEGORY_COL),
        applicantType:      tc(TMPL_APPLICANT_TYPE_COL) || 'Principal Applicant',
      };
    }
  }

  // ── Step 3: Merge and return ──────────────────────────────────────────────
  return items
    .map((item) => {
      const c        = (id) => col(item.column_values, id);
      const intakeId = c(INTAKE_ID_COL);
      const tmpl     = (intakeId && templateMap[intakeId]) || {};

      // Category: template lookup preferred over mirror (mirror is often null)
      const category = tmpl.category || c(CATEGORY_MIRROR_COL) || 'General';

      return {
        id:                 item.id,
        name:               item.name,
        documentCode:       c(DOC_CODE_COL),
        status:             c(DOC_STATUS_COL) || 'Missing',
        category,
        applicantType:      tmpl.applicantType || 'Principal Applicant',
        lastUpload:         c(UPLOAD_DATE_COL),
        description:        tmpl.description        || '',
        clientInstructions: tmpl.clientInstructions || '',
        reviewNotes:        c(REVIEW_NOTES_COL)     || '',
        intakeId,
      };
    })
    .sort((a, b) => {
      // Primary: applicant type (Principal Applicant first)
      const aType = a.applicantType || 'Principal Applicant';
      const bType = b.applicantType || 'Principal Applicant';
      if (aType < bType) return -1;
      if (aType > bType) return  1;
      // Secondary: category
      if (a.category < b.category) return -1;
      if (a.category > b.category) return  1;
      // Tertiary: document code
      return (a.documentCode || '').localeCompare(
        b.documentCode || '', undefined, { numeric: true }
      );
    });
}

/**
 * Load both the document items and the client's full name in parallel.
 * Used by the form route to populate both the document list and the top bar.
 */
async function getCaseSummary(caseRef) {
  const [items, clientName] = await Promise.all([
    getCaseDocuments(caseRef),
    getClientName(caseRef),
  ]);
  return { items, clientName };
}

// ─── Public: post-upload actions ─────────────────────────────────────────────

/**
 * Upload a file to the client's OneDrive category subfolder.
 *
 * Category resolution order:
 *  1. Execution item's intakeId → fetch category directly from Template Board.
 *  2. Execution item's mirror column (lookup_mm0zqbvt) if intakeId is missing.
 *  3. Default "General".
 *
 * Client name is fetched from the Client Master Board in parallel with (1).
 */
async function uploadFileToOneDrive(itemId, caseRef, fileBuffer, originalName, mimeType) {
  // Fetch the execution item to get intakeId and mirror category
  const execData = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: ["${INTAKE_ID_COL}", "${CATEGORY_MIRROR_COL}"]) { id text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const cols     = execData?.items?.[0]?.column_values || [];
  const intakeId = cols.find((c) => c.id === INTAKE_ID_COL)?.text?.trim()       || '';
  const mirror   = cols.find((c) => c.id === CATEGORY_MIRROR_COL)?.text?.trim() || '';

  // Parallel: resolve category + get client name
  const [category, clientName] = await Promise.all([
    intakeId
      ? getCategoryFromTemplate(intakeId)   // preferred: direct template lookup
      : Promise.resolve(mirror || 'General'), // fallback: mirror or default
    getClientName(caseRef),
  ]);

  console.log(
    `[DocForm] Uploading "${originalName}" | case ${caseRef} | client "${clientName}" | category "${category}"`
  );

  return uploadToOneDrive({
    clientName,
    caseRef,
    category,
    filename: originalName,
    buffer:   fileBuffer,
    mimeType,
  });
}

/**
 * After a successful upload:
 *  - Set Document Status → Received
 *  - Set Last Upload Date → today
 *  - Set Review Required → Yes
 */
async function markDocumentReceived(itemId) {
  const today     = new Date().toISOString().split('T')[0];
  const colValues = JSON.stringify({
    [DOC_STATUS_COL]:  { label: 'Received' },
    [UPLOAD_DATE_COL]: { date: today },
    [REVIEW_REQ_COL]:  { label: 'Yes' },
  });

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(
         board_id:      $boardId,
         item_id:       $itemId,
         column_values: $colValues
       ) { id }
     }`,
    { boardId: EXEC_BOARD_ID, itemId: String(itemId), colValues }
  );
}

module.exports = {
  getCaseDocuments,
  getCaseSummary,
  uploadFileToOneDrive,
  markDocumentReceived,
};
