const path      = require('path');
const fs        = require('fs');
const mondayApi = require('./mondayApi');
const { uploadFile: uploadToOneDrive, ensureCategoryFolderLink } = require('./oneDriveService');
const { decodeUploadFilename } = require('../utils/uploadFilename');
const naming = require('../utils/uploadNaming');
const { clientMasterBoardId } = require('../../config/monday');

// ─── Disclaimer map (keyed by "caseType|subType") ────────────────────────────
const DISCLAIMER_MAP_PATH = path.join(__dirname, '../data/disclaimerMap.json');
let _disclaimerMap = null;
function getDisclaimerMap() {
  if (!_disclaimerMap) {
    try { _disclaimerMap = JSON.parse(fs.readFileSync(DISCLAIMER_MAP_PATH, 'utf8')); }
    catch { _disclaimerMap = {}; }
  }
  return _disclaimerMap;
}

const DEFAULT_DISCLAIMER = [
  'Documents accepted in English/French. If in another language, please include the original, a copy with stamp, and the translated document with stamp.',
  'Only well-scanned documents will be accepted.',
  'Our team may ask for additional documents or information as we review.',
];

// ─── Board / Column IDs ───────────────────────────────────────────────────────

const EXEC_BOARD_ID       = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const TEMPLATE_BOARD_ID   = process.env.MONDAY_TEMPLATE_BOARD_ID  || '18401624183';
const CM_BOARD_ID         = clientMasterBoardId || process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const BASE_URL            = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

// Execution Board columns
const CASE_REF_COL        = 'text_mm0z2cck';   // Case Reference Number
const DOC_CODE_COL        = 'text_mm0zr7tf';   // Document Code
const DOC_STATUS_COL      = 'color_mm0zwgvr';  // Document Status
const UPLOAD_DATE_COL     = 'date_mm0zyw0m';   // Last Upload Date
const REVIEW_REQ_COL      = 'color_mm0z796e';  // Review Required
const REVIEW_NOTES_COL    = 'long_text_mm0zbpr'; // Review Notes
const INTAKE_ID_COL       = 'text_mm0zfsp1';   // Template Board item ID (stored at checklist creation)
const CATEGORY_MIRROR_COL = 'lookup_mm0zqbvt'; // Document Category (mirror — often null)
const CATEGORY_TEXT_COL   = 'text_mm261tka';   // Document Category (direct text — set at checklist creation)
const EXEC_APPLICANT_TYPE_COL = 'text_mm26jcv7'; // Applicant Type on the execution row itself (schema-seeded items have NO Template link, so this is where their member type lives)

// Template Board columns
const TMPL_DESC_COL           = 'long_text_mm0zmb7j'; // Description
const TMPL_INSTRUCTIONS_COL   = 'long_text_mm0z10mg'; // Client-Facing Instructions
const TMPL_CATEGORY_COL       = 'dropdown_mm0x41zm';  // Document Category
const TMPL_APPLICANT_TYPE_COL = 'dropdown_mm261bn6';  // Applicant Type (which member)
const TMPL_PHASE_COL          = 'dropdown_mm297t2e';  // Checklist Phase ("Profile Creation" / "Submission")

// Client Master Board columns
const CM_CASE_REF_COL  = 'text_mm142s49';    // Case Reference Number
const CM_CASE_TYPE_COL = 'dropdown_mm0xd1qn'; // Primary Case Type
const CM_SUB_TYPE_COL  = 'dropdown_mm0x4t91'; // Case Sub Type

const DOC_FOLDER_COL      = 'link_mm1yrnz1';   // Document Folder (OneDrive sharing link)

// Columns to fetch per execution item
const FETCH_COLS = [
  DOC_CODE_COL,
  DOC_STATUS_COL,
  UPLOAD_DATE_COL,
  REVIEW_NOTES_COL,
  INTAKE_ID_COL,
  CATEGORY_MIRROR_COL,
  CATEGORY_TEXT_COL,
  EXEC_APPLICANT_TYPE_COL,
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
 * Fetch the disclaimer text matching the case's Primary Case Type + Sub Type.
 * Falls back to a generic disclaimer if no exact match is found.
 */
async function getDisclaimerForCase(caseRef) {
  try {
    const data = await mondayApi.query(
      `query($boardId: ID!, $caseRef: String!) {
         items_page_by_column_values(
           limit: 1,
           board_id: $boardId,
           columns: [{ column_id: "${CM_CASE_REF_COL}", column_values: [$caseRef] }]
         ) {
           items {
             column_values(ids: ["${CM_CASE_TYPE_COL}", "${CM_SUB_TYPE_COL}"]) { id text }
           }
         }
       }`,
      { boardId: String(CM_BOARD_ID), caseRef }
    );

    const cols    = data?.items_page_by_column_values?.items?.[0]?.column_values || [];
    const caseType = cols.find(c => c.id === CM_CASE_TYPE_COL)?.text?.trim() || '';
    const subType  = cols.find(c => c.id === CM_SUB_TYPE_COL)?.text?.trim()  || '';

    const map  = getDisclaimerMap();
    const key  = `${caseType}|${subType}`;
    const fallback = map[`${caseType}|`] || DEFAULT_DISCLAIMER;

    return map[key] || fallback;
  } catch (err) {
    console.warn(`[DocForm] Disclaimer lookup failed for "${caseRef}": ${err.message}`);
    return DEFAULT_DISCLAIMER;
  }
}

/**
 * The Template Board row behind a template-linked checklist row: its category
 * and which family member it is for (one query, both columns). Returns null
 * (not a default) when the id is not a Template item id or the lookup fails,
 * so the caller's fallback chain decides — never this function. The blank
 * applicant type defaults the way getCaseDocuments does, so the stored file
 * name and the page agree.
 */
async function getTemplateMeta(intakeId) {
  if (!isTemplateItemId(intakeId)) return null;
  try {
    const data = await mondayApi.query(
      `query($id: ID!) {
         items(ids: [$id]) {
           column_values(ids: ["${TMPL_CATEGORY_COL}", "${TMPL_APPLICANT_TYPE_COL}"]) { id text }
         }
       }`,
      { id: String(intakeId) }
    );
    const cols = data?.items?.[0]?.column_values;
    if (!cols) return null;
    const tc = (id) => cols.find((c) => c.id === id)?.text?.trim() || '';
    return { category: tc(TMPL_CATEGORY_COL), applicantType: tc(TMPL_APPLICANT_TYPE_COL) || 'Principal Applicant' };
  } catch (err) {
    console.warn(`[DocForm] Template lookup failed for intakeId ${intakeId}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch category from the Template Board using the stored intakeId.
 * Returns '' (not a default) when the id is not a Template item id or the
 * lookup fails, so the caller's fallback chain decides — never this function.
 */
async function getCategoryFromTemplate(intakeId) {
  if (!isTemplateItemId(intakeId)) return '';
  const meta = await getTemplateMeta(intakeId);
  return meta ? meta.category : '';
}

/**
 * Pure. Which family member a checklist row is for — the ONE rule the client
 * pages display by and the upload names files by, so both always agree:
 *   • a schema-seeded "code:" row resolves back to its schema role (the
 *     role's DISPLAY label, e.g. "Inviter (in Canada)" rather than "Sponsor",
 *     plus the member index for a second child);
 *   • template-linked rows carry applicantType on the Template row; schema-
 *     seeded rows have NO Template link, so the execution row's own column is
 *     read before defaulting. Without that fallback every schema-seeded
 *     per-member document reads as "Principal Applicant".
 * @returns {{ resolved: object|null, applicantType: string, applicantLabel: string }}
 */
function applicantLabelFor({ intakeId, templateApplicantType = '', execApplicantType = '' }) {
  const id = String(intakeId || '');
  let resolved = null;
  if (id.startsWith('code:')) {
    // Read-time resolution: already-seeded cases get this with no board rewrite.
    try { resolved = require('./seedPlanner').resolveDocumentCode(id.slice(5)); }
    catch (err) { console.warn(`[DocForm] Schema role lookup failed for ${id}: ${err.message}`); }
  }
  const applicantType = templateApplicantType || execApplicantType || 'Principal Applicant';
  const applicantLabel = resolved && resolved.role.label
    ? resolved.role.label + (resolved.memberIndex > 1 ? ` ${resolved.memberIndex}` : '')
    : applicantType;
  return { resolved, applicantType, applicantLabel };
}

/** A Template Board item id is numeric. Schema-seeded rows store "code:<documentCode>" instead. */
function isTemplateItemId(intakeId) { return /^\d+$/.test(String(intakeId || '').trim()); }

/** Category from the checklist schema for a schema-seeded row ("code:<documentCode>"), else ''. */
function categoryFromSchemaCode(intakeId) {
  const s = String(intakeId || '').trim();
  if (!s.startsWith('code:')) return '';
  try {
    const resolved = require('./seedPlanner').resolveDocumentCode(s.slice(5));
    return (resolved && resolved.doc && resolved.doc.category) ? String(resolved.doc.category).trim() : '';
  } catch (err) {
    console.warn(`[DocForm] Schema category lookup failed for ${s}: ${err.message}`);
    return '';
  }
}

/**
 * Pure. The OneDrive folder for an upload — the same precedence the client
 * form uses to DISPLAY the category (getCaseDocuments), so a file lands in the
 * folder the client saw it listed under:
 *   Template Board category (template-linked rows) → the execution row's own
 *   category column → the mirror column → the schema definition (code rows)
 *   → "General" only as a last resort.
 * (Before 2026-09-02 a non-empty "code:…" id short-circuited to the Template
 * lookup, which failed → every schema-seeded upload landed in "General".)
 */
function resolveUploadCategory({ templateCategory = '', catText = '', mirror = '', schemaCategory = '' }) {
  const clean = (v) => String(v || '').trim();
  return clean(templateCategory) || clean(catText) || clean(mirror) || clean(schemaCategory) || 'General';
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
  // CHUNKED + explicit limit: items(ids:) silently caps at 25 without one, and
  // a checklist routinely carries 30-60 rows — the unreturned templates lost
  // their category/applicant-type/instructions and fell back to defaults.
  const TMPL_CHUNK = 100;
  for (let i = 0; i < intakeIds.length; i += TMPL_CHUNK) {
    const batch = intakeIds.slice(i, i + TMPL_CHUNK);
    const tmplData = await mondayApi.query(
      `query($ids: [ID!]!, $lim: Int!) {
         items(ids: $ids, limit: $lim) {
           id
           column_values(ids: [
             "${TMPL_DESC_COL}",
             "${TMPL_INSTRUCTIONS_COL}",
             "${TMPL_CATEGORY_COL}",
             "${TMPL_APPLICANT_TYPE_COL}",
             "${TMPL_PHASE_COL}"
           ]) { id text }
         }
       }`,
      { ids: batch, lim: batch.length }
    );

    for (const tmpl of tmplData?.items || []) {
      const tc = (id) => tmpl.column_values.find((c) => c.id === id)?.text?.trim() || '';
      templateMap[tmpl.id] = {
        description:        tc(TMPL_DESC_COL),
        clientInstructions: tc(TMPL_INSTRUCTIONS_COL),
        category:           tc(TMPL_CATEGORY_COL),
        applicantType:      tc(TMPL_APPLICANT_TYPE_COL) || 'Principal Applicant',
        checklistPhase:     tc(TMPL_PHASE_COL) || '',
      };
    }
  }

  // ── Step 3: Merge and return ──────────────────────────────────────────────
  return items
    .map((item) => {
      const c        = (id) => col(item.column_values, id);
      const intakeId = c(INTAKE_ID_COL);
      const tmpl     = (intakeId && templateMap[intakeId]) || {};

      // Category: template dropdown → execution text column → mirror → fallback
      const category = tmpl.category || c(CATEGORY_TEXT_COL) || c(CATEGORY_MIRROR_COL) || 'General';

      // Which member the row is for — the same rule the upload names files by
      // (applicantLabelFor), so a schema-seeded "code:" row shows the role's
      // DISPLAY label and its per-document guidance.
      const { resolved, applicantType, applicantLabel } = applicantLabelFor({
        intakeId, templateApplicantType: tmpl.applicantType || '', execApplicantType: c(EXEC_APPLICANT_TYPE_COL),
      });

      return {
        id:                 item.id,
        name:               item.name,
        documentCode:       c(DOC_CODE_COL),
        status:             c(DOC_STATUS_COL) || 'Missing',
        category,
        applicantType,      // internal vocabulary — filters/grouping keys
        applicantLabel,     // human-facing — what pages should DISPLAY
        lastUpload:         c(UPLOAD_DATE_COL),
        description:        tmpl.description        || '',
        clientInstructions: tmpl.clientInstructions || (resolved && resolved.doc.guidance) || '',
        checklistPhase:     tmpl.checklistPhase     || '',
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
 * Compute which applicantType labels are valid for this case based on the
 * QUESTIONNAIRE MEMBER MANIFEST in OneDrive. The manifest is the single
 * source of truth for "who's actually on this case" — it changes whenever
 * the client adds or removes a family member from the questionnaire.
 *
 * Returns:
 *   • An array of allowed applicantType strings. Always includes both
 *     'Principal Applicant' AND 'Sponsor' (these are built-in roles, not
 *     family members added by the client). Any family-member types from
 *     the manifest (e.g. 'Spouse / Common-Law Partner', 'Dependent Child')
 *     are appended.
 *   • null  → only on truly unexpected errors (e.g. require() failure);
 *            caller should treat null as "skip filter".
 *
 * Behavior contract (matches loadMembers' internal error swallowing):
 *   • Manifest exists with members  → return all member types + Principal
 *   • Manifest absent or empty       → loadMembers returns defaultMembers()
 *                                      → result is ['Principal Applicant'] only
 *   • OneDrive transient read error → loadMembers catches internally and
 *                                      returns defaultMembers() → result is
 *                                      ['Principal Applicant'] only
 *
 * The "OneDrive error" case is therefore fail-closed-to-Principal. Multi-
 * member cases would have non-Principal docs hidden temporarily during an
 * outage; the data itself is preserved on Monday, only the display narrows.
 *
 * Member.type values match Template Board applicantType strings exactly
 * (`Spouse / Common-Law Partner`, `Dependent Child`, etc.) — see
 * config/questionnaireFormMap.js MEMBER_TYPE constants.
 */
/**
 * Canonicalise an applicant-type label so the schema seeder's role labels match
 * the questionnaire manifest's member types:
 *   "Spouse / Common-Law Partner" → "spouse"   (drop the "/ …" variance)
 *   "Dependent Child 2"           → "dependent child"  (drop the member index)
 * Used only for allow-list matching, never for display.
 */
function normApplicantType(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\s*\/.*$/, '')
    .replace(/\s+\d+$/, '')
    .trim();
}

async function getAllowedApplicantTypesFromManifest({ caseRef, clientName }) {
  if (!caseRef || !clientName) return null;
  try {
    // Lazy require avoids hard coupling at module load
    const htmlQ = require('./htmlQuestionnaireService');
    const members = await htmlQ.loadMembers({ clientName, caseRef });

    // Always-allowed applicant types — these aren't added via the
    // questionnaire's "+ Add Family Member" flow (which only handles
    // spouse / dependent child / etc.), but they ARE legitimate
    // applicants on the case by virtue of the case type itself:
    //
    //   • Principal Applicant — on every case
    //   • Sponsor — on Inland/Outland Spousal Sponsorship, Child
    //     Sponsorship, Parents/Grandparents Sponsorship. The Sponsor
    //     is a built-in role of the case type, not a family member
    //     the client picks. Including it here unconditionally is safe
    //     because non-sponsorship case types simply have no Sponsor
    //     rows on the Execution Board, so the filter has no effect.
    const allowed = new Set(['Principal Applicant', 'Sponsor']);
    for (const m of (members || [])) {
      // The primary member is always Principal Applicant — already in the set
      if (m.key === 'primary') continue;
      if (m.type) allowed.add(m.type);
    }
    return Array.from(allowed);
  } catch (err) {
    console.warn(`[DocForm] Could not resolve member manifest for ${caseRef}: ${err.message} — skipping applicant-type filter`);
    return null;
  }
}

/**
 * Load both the document items and the client's full name in parallel.
 * Used by the form route to populate both the document list and the top bar.
 *
 * As of 2026-04-29: filters out documents whose applicantType is not present
 * in the questionnaire member manifest. This hides phantom Spouse/Dependent
 * Child documents on cases where the client is genuinely a single applicant,
 * AND auto-shows them the moment a family member is added in the
 * questionnaire (the manifest update is reflected on the next page load).
 *
 * The filter is display-only: documents are not deleted from the Execution
 * Board, only omitted from the rendered list. Removing the filter restores
 * the previous behaviour with no data loss.
 */
async function getCaseSummary(caseRef) {
  const [items, clientName, disclaimer] = await Promise.all([
    getCaseDocuments(caseRef),
    getClientName(caseRef),
    getDisclaimerForCase(caseRef),
  ]);

  let filteredItems = items;
  if (clientName) {
    const allowed = await getAllowedApplicantTypesFromManifest({ caseRef, clientName });
    if (allowed) {
      // Match on a NORMALISED applicant type so the schema seeder's role labels
      // ("Spouse", "Dependent Child 1") match the questionnaire manifest's member
      // types ("Spouse / Common-Law Partner", "Dependent Child"). Without this,
      // every schema-seeded spouse/child document is wrongly hidden. Genuinely
      // phantom members (no matching manifest entry) are still filtered out.
      const allowedNorm = new Set(allowed.map(normApplicantType));
      filteredItems = items.filter(it =>
        allowedNorm.has(normApplicantType(it.applicantType || 'Principal Applicant'))
      );
      const hidden = items.length - filteredItems.length;
      if (hidden > 0) {
        console.log(`[DocForm] ${caseRef}: hid ${hidden} of ${items.length} document${items.length === 1 ? '' : 's'} (applicantType not in manifest: ${allowed.join(', ')})`);
      }
    }
  }

  return { items: filteredItems, clientName, disclaimer };
}

// ─── Public: post-upload actions ─────────────────────────────────────────────

/**
 * Upload a file to the client's OneDrive category subfolder.
 *
 * Category = resolveUploadCategory(): Template Board (template-linked rows
 * only) → execution row's category column → mirror → schema definition
 * (schema-seeded "code:" rows) → "General".
 *
 * Client name is fetched from the Client Master Board in parallel.
 *
 * Stored name — behind UPLOAD_UNIQUE_NAMES (read at call time):
 *   ON:  "<Document> – <Member> – <YYYY-MM-DD HH-mm> – <client's name>", written
 *        as a NEW file (uploadFileAsNew) so a re-upload never replaces an
 *        earlier copy; the note records the name Graph actually kept.
 *   OFF: today's path exactly — the client's own name, replace-in-place.
 *
 * Order: file → folder-link backfill → the ROW note (awaited, so the note that
 * names the file exists before the status write's webhook pings staff) →
 * readiness recalc. The caller (the route) then marks the row Received.
 *
 * @returns {Promise<{ id, name, webUrl, url, replaced, category, docName, memberLabel, originalName, noteBody, notePosted }>}
 *   name/id/url are '' on the OFF path (only webUrl is known there); noteBody is
 *   the row note as posted, notePosted whether it landed — the status-retry job
 *   needs both when the status write fails after the file is saved.
 */
async function uploadFileToOneDrive(itemId, caseRef, fileBuffer, rawOriginalName, mimeType) {
  // multipart filenames arrive as UTF-8 bytes read as latin1 (RFC 7578) - repair
  // them ONCE, here, so the OneDrive file name and the audit comment (both fed
  // from this variable) carry the name the client actually chose.
  const originalName = decodeUploadFilename(rawOriginalName);
  // Fetch the execution item — include documentFolder to check if it needs backfilling
  const execData = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         id
         name
         column_values(ids: ["${INTAKE_ID_COL}", "${CATEGORY_MIRROR_COL}", "${CATEGORY_TEXT_COL}", "${DOC_FOLDER_COL}", "${EXEC_APPLICANT_TYPE_COL}"]) { id text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const execItem   = execData?.items?.[0] || {};
  const docName    = execItem.name || 'Document';
  const cols       = execItem.column_values || [];
  const intakeId   = cols.find((c) => c.id === INTAKE_ID_COL)?.text?.trim()       || '';
  const mirror     = cols.find((c) => c.id === CATEGORY_MIRROR_COL)?.text?.trim() || '';
  const catText    = cols.find((c) => c.id === CATEGORY_TEXT_COL)?.text?.trim()    || '';
  const execApplicantType = cols.find((c) => c.id === EXEC_APPLICANT_TYPE_COL)?.text?.trim() || '';
  let folderText   = cols.find((c) => c.id === DOC_FOLDER_COL)?.text?.trim()      || '';

  // Parallel: resolve the Template row (category + member) + get client name
  const [tmplMeta, clientName] = await Promise.all([
    getTemplateMeta(intakeId),   // null unless a real Template item id resolves
    getClientName(caseRef),
  ]);
  const templateCategory = tmplMeta ? tmplMeta.category : '';
  const category = resolveUploadCategory({ templateCategory, catText, mirror, schemaCategory: categoryFromSchemaCode(intakeId) });
  if (category === 'General' && (catText || mirror || intakeId)) {
    console.warn(`[DocForm] Category fell back to "General" for item ${itemId} (intakeId="${intakeId}", catText="${catText}", mirror="${mirror}")`);
  }
  const { resolved, applicantType, applicantLabel } = applicantLabelFor({
    intakeId, templateApplicantType: tmplMeta ? tmplMeta.applicantType : '', execApplicantType,
  });

  console.log(
    `[DocForm] Uploading "${originalName}" | case ${caseRef} | client "${clientName}" | category "${category}"`
  );

  const now    = io.now();
  const unique = naming.isUniqueNamesEnabled();   // read once per upload, so the file and its note agree
  let saved, requested = '';
  if (unique) {
    requested = naming.buildStoredName({
      docName, member: naming.memberSegment({ resolved, applicantType, applicantLabel }), originalName, now,
    });
    saved = await io.uploadAsNew({ clientName, caseRef, category, filename: requested, buffer: fileBuffer, mimeType });
    console.log(`[DocForm] stored item=${itemId} case=${caseRef} category="${category}" name="${saved.name}" id=${saved.id} replaced=${saved.replaced}`);
  } else {
    const webUrl = await uploadToOneDrive({
      clientName,
      caseRef,
      category,
      filename: originalName,
      buffer:   fileBuffer,
      mimeType,
    });
    saved = { name: '', id: '', webUrl, url: '', replaced: false };
  }

  // ── Backfill folder link if the Document Folder column is empty ───────────
  // This covers items created when OneDrive was unavailable at checklist time.
  // Also re-point links the pre-2026-09-02 bug backfilled to "General Folder"
  // (the link column's text reads "General Folder - <url>") once the row's
  // real category is known — idempotent, and the file now lands in that folder.
  const staleGeneralLink = /^General Folder\b/i.test(folderText) && category !== 'General';
  if ((!folderText || staleGeneralLink) && category) {
    try {
      const folderUrl = await ensureCategoryFolderLink({ clientName, caseRef, category });
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
         }`,
        {
          boardId: EXEC_BOARD_ID,
          itemId:  String(itemId),
          colValues: JSON.stringify({
            [DOC_FOLDER_COL]: { url: folderUrl, text: `${category} Folder` },
          }),
        }
      );
      folderText = folderUrl;   // so the update comment links to the folder
      console.log(`[DocForm] ${staleGeneralLink ? 'Re-pointed stale General' : 'Backfilled'} folder link for "${category}" on item ${itemId}`);
    } catch (err) {
      // Best-effort — upload already succeeded so don't fail the whole request
      console.warn(`[DocForm] Folder link backfill failed for item ${itemId}:`, err.message);
    }
  }

  // ── Post Monday Updates so the case team is notified ──────────────────────
  // The ROW note is awaited (one Monday call) so the note naming the file
  // exists before the status write's webhook pings the reviewer; the Client
  // Master note stays fire-and-forget inside. Never fails the upload: the file
  // is saved, and the status-retry job re-posts a note that did not land.
  const noteParams = {
    itemId, caseRef, clientName, category, docName,
    filename:    saved.name || originalName,
    originalName,
    memberLabel: applicantLabel,
    fileUrl:     saved.url,
    folderUrl:   folderText,
    renamed:     !!saved.name && saved.name !== requested,
    replaced:    saved.replaced,
    now,
    unique,
  };
  let noteBody = '', notePosted = false;
  try {
    ({ noteBody, notePosted } = await postUploadUpdates(noteParams));
  } catch (err) {
    try { noteBody = buildUploadNoteBodies(noteParams).docBody; } catch (_) { /* the note is best effort; the file is saved */ }
    console.warn(`[DocForm] Upload update post failed for item ${itemId}:`, err.message);
  }

  // Fire-and-forget: refresh Documents Uploaded % and Documents Readiness %
  // on Client Master immediately so supervisors see live progress instead of
  // waiting for the 7 AM cron. Failure must not affect the upload response.
  require('./caseReadinessService')
    .calculateForCaseRef(caseRef)
    .catch((err) =>
      console.warn(`[DocForm] Live readiness recalc failed for ${caseRef}:`, err.message)
    );

  return { ...saved, category, docName, memberLabel: applicantLabel, originalName, noteBody, notePosted };
}

/**
 * Pure. The two "document uploaded" note bodies.
 *
 * Line order is load-bearing: the re-file tool and the phantom-docs audit
 * parse `File:` up to the next newline OR `Category:`, and `Category:` up to
 * `Case:` — and Monday collapses newlines into spaces, so a line placed
 * between them would be swallowed into the captured name. Every line that is
 * new with unique names therefore sits AFTER `Case:`, the link label is
 * "Open this upload" (no second `File:` anywhere), and the stored name carries
 * no ":" (stripped), so it can never contain `Category:`.
 *
 * With `unique` false (switch OFF) both bodies are today's, byte for byte.
 */
function buildUploadNoteBodies({ caseRef, clientName, category, docName, filename, originalName, memberLabel, fileUrl, folderUrl, renamed, replaced, now, unique }) {
  const uploadedAt = (now || new Date()).toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true });
  const clientLine = clientName ? ` (${clientName})` : '';
  const folderLine = folderUrl  ? `\n\n📁 Folder: ${folderUrl}` : '';
  const reviewUrl  = `${BASE_URL}/d/${encodeURIComponent(caseRef)}/review`;
  const reviewLine = `\n\n🔎 Review all documents for this case: ${reviewUrl}`;

  if (!unique) {
    const docBody =
      `📄 Document Uploaded by Client\n\n` +
      `Document: ${docName}\n` +
      `File: ${filename}\n` +
      `Category: ${category}\n` +
      `Case: ${caseRef}${clientLine}\n` +
      `Uploaded: ${uploadedAt} (Toronto)${folderLine}\n\n` +
      `Status set to Received — please review.${reviewLine}`;
    const masterBody =
      `📄 Client Uploaded Document\n\n` +
      `Document: ${docName}\n` +
      `File: ${filename}\n` +
      `Category: ${category}\n` +
      `Case: ${caseRef}\n` +
      `Uploaded: ${uploadedAt} (Toronto)${folderLine}${reviewLine}`;
    return { docBody, masterBody };
  }

  // Monday renders update bodies as HTML — a client's file name must read as
  // text, never as a tag or a link (the OFF path keeps today's raw name).
  const namedBy   = String(originalName || '').replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const memberLn  = `For: ${memberLabel || 'Principal Applicant'}\n`;
  const namedLn   = `Named by client: ${namedBy}\n`;
  const renamedLn = renamed  ? `Note: OneDrive added a number to the name because a file with this name already existed — both files are kept.\n` : '';
  const replaceLn = replaced ? `Warning: OneDrive replaced a file with this name — the earlier copy is in that file's version history.\n` : '';
  // The file link on its own line before the folder link; either alone when the other is unknown.
  const links     = fileUrl
    ? `\n\n🔗 Open this upload: ${fileUrl}${folderUrl ? `\n📁 Folder: ${folderUrl}` : ''}`
    : folderLine;

  const docBody =
    `📄 Document Uploaded by Client\n\n` +
    `Document: ${docName}\n` +
    `File: ${filename}\n` +
    `Category: ${category}\n` +
    `Case: ${caseRef}${clientLine}\n` +
    memberLn + namedLn + renamedLn + replaceLn +
    `Uploaded: ${uploadedAt} (Toronto)${links}\n\n` +
    `Status set to Received — please review.${reviewLine}`;
  const masterBody =
    `📄 Client Uploaded Document\n\n` +
    `Document: ${docName}\n` +
    `File: ${filename}\n` +
    `Category: ${category}\n` +
    `Case: ${caseRef}\n` +
    memberLn + namedLn +
    `Uploaded: ${uploadedAt} (Toronto)${links}${reviewLine}`;
  return { docBody, masterBody };
}

/**
 * Post "document uploaded" updates to Monday.com so the case team is notified
 * via Monday's native update subscription (bell + email).
 *
 *  • Update on the Document Execution item → notifies Assigned Reviewer
 *    (awaited by the caller; ONE retry only, so a degraded Monday cannot hold
 *    the 50 MB upload slot for minutes)
 *  • Update on the Client Master item      → notifies Case Manager, Ops Supervisor,
 *                                             Case Support Officer, Stage Owner
 *    (fire-and-forget)
 *
 * @returns {Promise<{ noteBody: string, notePosted: boolean }>} the row note and whether it landed
 */
async function postUploadUpdates(params) {
  const { itemId, caseRef } = params;
  const { docBody, masterBody } = buildUploadNoteBodies(params);

  // 1. Document Execution item — reviewer gets notified
  let notePosted = false;
  try {
    await io.query(
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(itemId), body: docBody },
      1
    );
    notePosted = true;
  } catch (err) {
    console.warn(`[DocForm] Row upload note failed for item ${itemId}: ${err.message}`);
  }

  // 2. Client Master item — case team gets notified
  postMasterUploadNote({ caseRef, masterBody }).catch((err) =>
    console.warn(`[DocForm] Client Master update failed for case ${caseRef}:`, err.message)
  );

  return { noteBody: docBody, notePosted };
}

async function postMasterUploadNote({ caseRef, masterBody }) {
  const masterData = await io.query(
    `query($boardId: ID!, $caseRef: String!) {
       items_page_by_column_values(
         board_id: $boardId, limit: 1,
         columns: [{ column_id: "${CM_CASE_REF_COL}", column_values: [$caseRef] }]
       ) { items { id } }
     }`,
    { boardId: String(CM_BOARD_ID), caseRef }
  );
  const masterItemId = masterData?.items_page_by_column_values?.items?.[0]?.id;
  if (!masterItemId) {
    console.warn(`[DocForm] No Client Master item found for case ${caseRef} — skipping master update`);
    return;
  }
  await io.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId: String(masterItemId), body: masterBody }
  );
}

/**
 * After a successful upload:
 *  - Set Document Status → Received
 *  - Set Last Upload Date → today (the TORONTO date: a 9 pm upload used to be
 *    dated tomorrow, because the UTC date was written)
 *  - Set Review Required → Yes
 * No retry of its own: mondayApi.query already retries 429/5xx/network 3×.
 *
 * @param {string|number} itemId
 * @param {{ date?: string }} [opts]  a YYYY-MM-DD to write instead of today (the status-retry job passes the upload's date)
 */
async function markDocumentReceived(itemId, { date } = {}) {
  const today     = date || naming.torontoDate(io.now());
  const colValues = JSON.stringify({
    [DOC_STATUS_COL]:  { label: 'Received' },
    [UPLOAD_DATE_COL]: { date: today },
    [REVIEW_REQ_COL]:  { label: 'Yes' },
  });

  await io.query(
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

// ─── Saved but not marked: the status write is retried in-process ────────────
//
// The one upload failure that does not heal by itself: the file reached
// OneDrive but Monday refused the status write. The client is told the truth
// (file saved — do not send it again), so the row has to be marked without
// them. Three attempts in this process, at +1, +5 and +15 minutes; one job per
// row. A deploy inside that window loses the job — the SAVED-BUT-UNMARKED log
// line, the ⚠️ row note and the self-describing file name are the manual path.
//
// Each attempt, in this order:
//   1. post every upload note that never landed (the file's record — it can
//      overwrite nobody's decision, so it goes up whatever happens next);
//   2. read when the row's status and Review Notes were last changed; stop if
//      either was after the failed write was ATTEMPTED (staff acted: Reviewed,
//      Rework Required again, an undo, a fresh note) — their decision stands;
//   3. write the status, then a recovery note.
const STATUS_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const _statusRetries = new Map();   // itemId → { job, attempt, timer, running }

/**
 * The route calls this when markDocumentReceived threw after the file was
 * saved. Schedules the retry (synchronously — never throws) and then posts a
 * best-effort ⚠️ note on the row so staff can see why it is not Received.
 *
 * @param {{ itemId: string|number, caseRef: string, saved: object|undefined, error: string, attemptedAt?: Date|string }} p
 *   saved = what uploadFileToOneDrive returned (may be undefined when a stub returned nothing);
 *   attemptedAt = when the route FIRST tried the status write — the write's own
 *   retries can take two minutes, and a staff decision inside that window (or
 *   a timed-out write that actually landed) must count as "after the upload"
 */
async function onStatusWriteFailed({ itemId, caseRef, saved, error, attemptedAt }) {
  const s   = saved || {};
  const at  = attemptedAt ? new Date(attemptedAt) : io.now();
  const job = {
    itemId:     String(itemId),
    caseRef:    String(caseRef || ''),
    docName:    s.docName || '',
    storedName: s.name || s.originalName || '',       // OFF path: the client's own name — never an empty File:
    url:        s.url || s.webUrl || '',
    date:       naming.torontoDate(at),
    t:          at.toISOString(),                      // the reference the changed_at guard compares against
    // Upload notes still to post — this file's, when it never landed, plus any
    // carried over from an earlier failed upload on the same row.
    notes:      s.noteBody && s.notePosted !== true ? [s.noteBody] : [],
    error:      String(error || ''),
  };
  scheduleStatusRetry(job);

  const body =
    `⚠️ File saved, but the status could not be set to Received\n\n` +
    `Document: ${job.docName || 'Document'}\n` +
    `File: ${job.storedName}\n` +
    `Case: ${job.caseRef}\n` +
    `Saved: ${torontoWhen(at)} (Toronto)\n\n` +
    (job.url ? `🔗 Open this upload: ${job.url}\n\n` : '') +
    `Monday refused the status write (${job.error}). The app will try again by itself after 1, 5 and 15 minutes; ` +
    `the client was told the file is saved and not to send it again. ` +
    `If this row is still not Received in half an hour, set it by hand.`;
  try {
    await postRowNote(job.itemId, body);
  } catch (err) {
    console.warn(`[upload] could not post the saved-but-unmarked note on item ${job.itemId}: ${err.message}`);
  }
}

/**
 * One job per row. A second failure on the same row never doubles the job and
 * never loses a note: an ARMED job (timer pending) is replaced and its unposted
 * notes move into the new one; a RUNNING job (mid-attempt) is not replaced —
 * the new upload's notes and status intent are merged into it, so nothing
 * finishes behind its back and no note is posted twice.
 */
function scheduleStatusRetry(job) {
  const prev = _statusRetries.get(job.itemId);
  if (prev && prev.running) {
    prev.job.notes.push(...job.notes);
    Object.assign(prev.job, { docName: job.docName || prev.job.docName, storedName: job.storedName, url: job.url, date: job.date, t: job.t, error: job.error });
    return;
  }
  if (prev) {
    if (prev.timer) io.clearTimer(prev.timer);
    job.notes = [...prev.job.notes, ...job.notes];
  }
  const entry = { job, attempt: 0, timer: null, running: false };
  _statusRetries.set(job.itemId, entry);
  armStatusRetry(entry);
}

function armStatusRetry(entry) {
  const delay = STATUS_RETRY_DELAYS_MS[entry.attempt];
  entry.timer = io.setTimer(() => {
    entry.timer = null;
    runStatusRetry(entry).catch((err) => console.error(`[upload] status retry crashed for item ${entry.job.itemId}: ${err.message}`));
  }, delay);
}

/** Forget this row's job — only when it is still ours. */
function finishStatusRetry(entry) {
  if (_statusRetries.get(entry.job.itemId) === entry) _statusRetries.delete(entry.job.itemId);
}

async function runStatusRetry(entry) {
  const { job } = entry;
  if (_statusRetries.get(job.itemId) !== entry) return;   // replaced by a newer job for this row
  entry.attempt++;
  entry.running = true;
  // The files' records go up before anything else — and again after every
  // await, because a second failed upload on this row can merge its note in
  // while an attempt is mid-flight.
  const postPendingNotes = async () => {
    while (job.notes.length) {
      await postRowNote(job.itemId, job.notes[0]);
      job.notes.shift();   // after success, so a failure re-posts only what did not land
    }
  };
  try {
    // 1. The files' records first — whatever the status decision turns out to be.
    await postPendingNotes();
    // 2. Has anyone acted on the row since the write was attempted?
    const changedAt = await readLastStaffChange(job.itemId);
    await postPendingNotes();
    if (changedAt && Date.parse(changedAt) > Date.parse(job.t)) {
      console.warn(`[upload] status retry for item ${job.itemId} (${job.caseRef}) stopped: the row was changed at ${changedAt}, after the failed write attempted at ${job.t}`);
      finishStatusRetry(entry);
      return;
    }
    // 3. The status.
    await markDocumentReceived(job.itemId, { date: job.date });
    await postPendingNotes();
    finishStatusRetry(entry);
    const doneAt = io.now();
    console.log(`[upload] RECOVERED item ${job.itemId} (${job.caseRef}) marked Received on attempt ${entry.attempt}`);
    try {
      await postRowNote(job.itemId,
        `✅ Status set to Received (recovered)\n\n` +
        `Document: ${job.docName || 'Document'}\n` +
        `File: ${job.storedName}\n` +
        `Case: ${job.caseRef}\n\n` +
        `The status write that failed at ${torontoWhen(new Date(job.t))} succeeded on retry at ${torontoWhen(doneAt)}.`);
    } catch (err) {
      console.warn(`[upload] recovered, but the recovery note failed for item ${job.itemId}: ${err.message}`);
    }
  } catch (err) {
    if (entry.attempt >= STATUS_RETRY_DELAYS_MS.length) {
      console.error(`[upload] UNMARKED-FOR-GOOD item ${job.itemId} case ${job.caseRef} file "${job.storedName}" link ${job.url}: ${err.message} — set the row to Received by hand${job.notes.length ? ` (${job.notes.length} upload note(s) never posted)` : ''}`);
      finishStatusRetry(entry);
      return;
    }
    console.warn(`[upload] status retry ${entry.attempt}/${STATUS_RETRY_DELAYS_MS.length} failed for item ${job.itemId}: ${err.message} — trying again later`);
    armStatusRetry(entry);
  } finally {
    entry.running = false;
  }
}

/**
 * Monday's own timestamp of the last change to the row's status OR its Review
 * Notes (ISO), or '' when neither was ever set. A note edited on a row that
 * is already Rework Required is a staff decision the status column alone
 * cannot show.
 */
async function readLastStaffChange(itemId) {
  const data = await io.query(
    `query($ids: [ID!]!) { items(ids: $ids) { column_values(ids: ["${DOC_STATUS_COL}", "${REVIEW_NOTES_COL}"]) { id value } } }`,
    { ids: [String(itemId)] }
  );
  let latest = '';
  for (const c of data?.items?.[0]?.column_values || []) {
    if (!c.value) continue;
    let at = '';
    try { at = String(JSON.parse(c.value)?.changed_at || ''); } catch (_) { /* unreadable value — no evidence */ }
    if (at && (!latest || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}

async function postRowNote(itemId, body) {
  await io.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId: String(itemId), body }
  );
}

/** "30 Sep 2026, 2:32 pm" — the wording of every other staff note. */
function torontoWhen(d) { return require('../utils/torontoTime').torontoTime(d instanceof Date ? d.getTime() : d); }

/** Test seam: forget every pending status retry (timers are unref'd, but a test must not leak jobs into the next). */
function _resetForTests() {
  for (const e of _statusRetries.values()) if (e.timer) io.clearTimer(e.timer);
  _statusRetries.clear();
}
function pendingStatusRetries() { return [..._statusRetries.keys()]; }

/**
 * The side effects behind one seam — tests replace these. The load-time
 * `uploadFile` destructure above stays for the OFF path, so every existing
 * require.cache harness keeps working; the new writer is looked up at call
 * time. Timers are unref'd: a pending retry must never keep the process alive.
 */
const io = {
  uploadAsNew: (p) => require('./oneDriveService').uploadFileAsNew(p),
  query:       (gql, vars, retries) => mondayApi.query(gql, vars, retries),
  now:         () => new Date(),
  setTimer:    (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; },
  clearTimer:  (t) => clearTimeout(t),
};

module.exports = {
  getCaseDocuments,
  getCaseSummary,
  getDisclaimerForCase,
  uploadFileToOneDrive,
  markDocumentReceived,
  onStatusWriteFailed,
  applicantLabelFor,
  io,
  normApplicantType, // exported for tests (manifest-filter label matching)
  resolveUploadCategory, isTemplateItemId, categoryFromSchemaCode, // exported for tests (upload folder resolution)
  decodeUploadFilename, // re-exported so the upload tests can reach it through this service
  buildUploadNoteBodies, pendingStatusRetries, _resetForTests, // exported for tests (upload notes + status retry)
};
