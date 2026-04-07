/**
 * fixAllGroupApplicantTypes.js
 *
 * Fixes all remaining Template Board groups that have incomplete Spouse/Child items.
 *
 * For each group/sub-type combination:
 *   - Deletes items that need to be replaced (incorrect/incomplete sub-types)
 *   - Creates correct items with proper Applicant Type and Category tags
 *
 * Run with: node src/scripts/fixAllGroupApplicantTypes.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18401624183';

// Column IDs
const SUBTYPE_COL  = 'dropdown_mm204y6w';
const CATEGORY_COL = 'dropdown_mm0x41zm';
const APP_TYPE_COL = 'dropdown_mm261bn6';
const DOC_CODE_COL = 'text_mm0xprz5';

// Applicant types
const PA    = 'Principal Applicant';
const SPOUSE = 'Spouse / Common-Law Partner';
const CHILD  = 'Dependent Child';

// ─── Rate limiting ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── API helpers ──────────────────────────────────────────────────────────────

async function getGroupItems(groupId) {
  const data = await mondayApi.query(
    `query { boards(ids:[${BOARD_ID}]) { groups(ids:["${groupId}"]) {
      items_page(limit:500) { items {
        id name
        column_values(ids:["${SUBTYPE_COL}","${APP_TYPE_COL}"]) { id text }
      } }
    } } }`
  );
  return data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
}

async function deleteItem(itemId) {
  await mondayApi.query(
    `mutation($id: ID!) { delete_item(item_id: $id) { id } }`,
    { id: String(itemId) }
  );
  await sleep(150);
}

async function createItem(groupId, name, subType, category, appType) {
  const colValues = {
    [CATEGORY_COL]: { labels: [category] },
    [APP_TYPE_COL]: { labels: [appType] },
  };
  if (subType) colValues[SUBTYPE_COL] = { labels: [subType] };

  const data = await mondayApi.query(
    `mutation($gid: String!, $name: String!, $cols: JSON!) {
       create_item(
         board_id: ${BOARD_ID},
         group_id: $gid,
         item_name: $name,
         column_values: $cols,
         create_labels_if_missing: true
       ) { id }
     }`,
    { gid: groupId, name, cols: JSON.stringify(colValues) }
  );
  await sleep(160);
  return data?.create_item?.id;
}

// ─── Delete items matching a sub-type (or all items if subType is null) ────────

async function deleteItemsForSubType(groupId, subTypeFilter) {
  const items = await getGroupItems(groupId);
  let deleted = 0;
  for (const item of items) {
    const sub = item.column_values.find((c) => c.id === SUBTYPE_COL)?.text?.trim() || '';
    if (subTypeFilter === null || sub === subTypeFilter) {
      await deleteItem(item.id);
      console.log(`    ❌ Deleted: "${item.name}" [${sub || 'NO_SUB'}]`);
      deleted++;
    }
  }
  return deleted;
}

// ─── Create a list of items for a given applicant type ────────────────────────

async function createItems(groupId, docs, subType) {
  let created = 0;
  for (const doc of docs) {
    const id = await createItem(groupId, doc.name, subType, doc.cat, doc.type);
    console.log(`    ✅ Created [${doc.type}] ${doc.name} (id:${id})`);
    created++;
  }
  return created;
}

// ─── Document definitions ─────────────────────────────────────────────────────

// Shared document lists (used across multiple groups)

const PASSPORT_TEMP   = { name: 'Passport with all stamped pages', cat: 'Identity' };
const PASSPORT_PR     = { name: 'Passport with all pages- (in the last 5 years)', cat: 'Identity' };
const PASSPORT_RENUNC = { name: 'Passport with all pages', cat: 'Identity' };
const PASSPORT_CITIZEN = { name: 'Passport with all pages. (that covers 5-year eligibility period)', cat: 'Identity' };
const PASSPORT_PGWP_EXT = { name: 'Passport with all stamped pages- Old and New', cat: 'Identity' };
const ALL_PERMITS     = { name: 'All Permits ever held in Canada', cat: 'Other' };
const DIGITAL_PHOTO_TEMP = { name: 'Digital photo as per specifications of Temporary Residents', cat: 'Identity' };
const DIGITAL_PHOTO_PR   = { name: 'Digital photo as per specifications Permanent Residents', cat: 'Identity' };
const IDENTITY_CIVIL  = { name: 'Identity and Civil Documents', cat: 'Identity' };
const ONE_SAME_NAME   = { name: 'One and same name affidavit if name /surname changed', cat: 'Other' };
const PROOF_COHAB     = { name: 'Proof of cohabitation', cat: 'Other' };
const BIRTH_CERT      = { name: 'Birth Certificate', cat: 'Identity' };
const IELTS           = { name: 'International English Language Testing System (IELTS) Test Report Form /CELPIP', cat: 'Other' };
const UPFRONT_MEDICAL = { name: 'Upfront Medical exams', cat: 'Medical' };
const POLICE_CERT_WP  = { name: 'Police certificates (PCC)- We highly recommend it', cat: 'Legal' };
const POLICE_CLEAR    = { name: 'Police clearance certificates (PCC)', cat: 'Legal' };
const UPDATED_RESUME  = { name: 'Updated Resume', cat: 'Other' };
const ALL_MARKSHEET   = { name: 'All Marksheet and certificates', cat: 'Other' };
const ECA             = { name: 'Educational Credential Assessment – Service Providers', cat: 'Education' };
const FINANCIAL_DOCS  = { name: 'Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request.', cat: 'Financial' };
const GOV_ID          = { name: 'Government issued Identity documents', cat: 'Identity' };
const STATUS_ID_PR    = { name: 'Status Identification', cat: 'Identity' };
const PROOF_RESIDENCY = { name: 'Proof of Residency in Canada (Any 4) - For the last 5 years or since becoming a PR', cat: 'Other' };
const URGENT_TRAVEL   = { name: 'Urgent Travel Proof (if applicable)', cat: 'Other' };
const LANG_TEST_PGWP  = { name: 'Language Test Report', cat: 'Other' };
const LANG_TEST_CITIZEN = { name: 'Language Test Report (if you are 18 to 54 years of age)', cat: 'Other' };
const LANG_PROF_FEDNEE = { name: 'Proof of language proficiency (IELTS- G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)', cat: 'Other' };
const MEDICAL_EXAM    = { name: 'Medical Exam', cat: 'Medical' };
const CAN_EDU_DOCS_PGWP = { name: 'Canadian Education Documents- (For each program)', cat: 'Education' };
const CAN_EDU_DOCS_NEE  = { name: 'Canadian Education Documents', cat: 'Education' };
const FOREIGN_EDU_ECA   = { name: 'Foreign Education Documents along with Educational Credential Assessment', cat: 'Education' };
const SIBLING_PROOF     = { name: 'Sibling- Proof of living in Canada', cat: 'Other' };
const PROOF_WORK_EXP_NEE = { name: 'Proof of work experience for the claiming period (Inside and Outside Canada)', cat: 'Other' };
const PROOF_LIVING_CAN   = { name: 'Proof of living in Canada', cat: 'Other' };
const PROOF_FUNDS_PGWP   = { name: 'Additional proof of Funds/investments/assets', cat: 'Financial' };
const PROOF_INCOME_PGWP  = { name: 'Proof/source of Income- Mandatory for the Principal Applicant', cat: 'Financial' };
const PREV_APP_FORMS     = { name: 'Previous application Forms', cat: 'Other' };
const PROOF_ADMISSION    = { name: 'Proof of Admission', cat: 'Other' };
const PROOF_FINANCIAL_SP = { name: 'Proof of financial support while you study in Canada', cat: 'Financial' };
const INVITATION_BOWP    = { name: 'Invitation to Apply and Submission Confirmation of PR', cat: 'Other' };
const EMP_PROOF_LMIA     = { name: 'Employment Proof (Mandatory documents)', cat: 'Employment' };
const EMP_PROOF_LMIA_EXT = { name: 'Employment Proof (Mandatory documents)- for Principal Applicant', cat: 'Employment' };
const EMP_PROOF_CONCUR   = { name: 'Employment Proof (Mandatory documents)', cat: 'Employment' };
const EXPERIENCE_DOCS    = { name: 'Experience Documents- Provide all relevant experience documents from previous employers if any.', cat: 'Other' };
const RESUME             = { name: 'Resume', cat: 'Other' };
const PROOF_WORK_EXP_PA  = { name: 'Proof of work experience (for Principal Applicant)', cat: 'Other' };
const PROOF_INCOME_DEP   = { name: 'Proof/source of Income (for Dependent Applicant)', cat: 'Financial' };
const RECOMMENDATION     = { name: 'Recommendation Letters (only for Principal Applicant)- at least 3', cat: 'Other' };
const PERSONAL_ID_CITIZEN = { name: 'Personal Identification- Any 2 from the following', cat: 'Identity' };
const PERSONAL_ID_CHILD  = { name: 'Personal Identification-', cat: 'Identity' };
const POLICE_CERT_CITIZEN = { name: 'Police certificates (PCC)', cat: 'Legal' };
const ADOPTION_PROOF     = { name: 'Adoption/Guardianship Proof', cat: 'Legal' };
const SOLE_CUSTODY_PROOF = { name: 'Sole custody Proof', cat: 'Legal' };
const PHOTO_PR           = { name: 'Photo as per specifications Permanent Residents', cat: 'Identity' };
const DIGITAL_PHOTO_NEE  = { name: 'Digital photo as per specifications Permanent Residents- Front and Back both required', cat: 'Identity' };

// ─── Group definitions ────────────────────────────────────────────────────────

const GROUPS = [

  // ── BOWP ─────────────────────────────────────────────────────────────────
  // Combined PA+Spouse section already has PA items (7). Just add Spouse + Child.
  {
    name:    'BOWP',
    groupId: 'group_mm20z1tm',
    ops: [
      // Add Spouse items (same as existing PA items)
      {
        action: 'add',
        subType: null,
        items: [
          { ...PASSPORT_TEMP,    type: SPOUSE },
          { ...ALL_PERMITS,      type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP, type: SPOUSE },
          { ...IDENTITY_CIVIL,   type: SPOUSE },
          { ...ONE_SAME_NAME,    type: SPOUSE },
          { ...PROOF_COHAB,      type: SPOUSE },
          { ...INVITATION_BOWP,  type: SPOUSE },
        ],
      },
      // Add Child items
      {
        action: 'add',
        subType: null,
        items: [
          { ...ALL_PERMITS,       type: CHILD },
          { ...PASSPORT_TEMP,     type: CHILD },
          { ...DIGITAL_PHOTO_TEMP, type: CHILD },
        ],
      },
    ],
  },

  // ── LMIA Based WP ─────────────────────────────────────────────────────────
  {
    name:    'LMIA Based WP',
    groupId: 'group_mm203qtg',
    ops: [
      // ── Inside Canada: SEPARATE sections. PA items exist (11). Add Spouse (4) + Child (3 missing).
      {
        action: 'add',
        subType: 'Inside Canada',
        items: [
          { ...PASSPORT_TEMP,      type: SPOUSE },
          { ...ALL_PERMITS,        type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP, type: SPOUSE },
          { ...PROOF_COHAB,        type: SPOUSE },
          // Child items missing (Birth Certificate exists, need to add the other 3)
          { ...ALL_PERMITS,        type: CHILD },
          { ...PASSPORT_TEMP,      type: CHILD },
          { ...DIGITAL_PHOTO_TEMP, type: CHILD },
        ],
      },
      // ── Extension (Inside Canada): COMBINED section. Delete 1 incomplete PA, recreate all.
      {
        action: 'delete_subtype',
        subType: 'Extension (Inside Canada)',
      },
      {
        action: 'add',
        subType: 'Extension (Inside Canada)',
        items: [
          // PA items
          { ...PASSPORT_TEMP,       type: PA },
          { ...ALL_PERMITS,         type: PA },
          { ...DIGITAL_PHOTO_TEMP,  type: PA },
          { ...IDENTITY_CIVIL,      type: PA },
          { ...PROOF_COHAB,         type: PA },
          { ...EMP_PROOF_LMIA_EXT,  type: PA },
          // Spouse items (same as PA — combined section)
          { ...PASSPORT_TEMP,       type: SPOUSE },
          { ...ALL_PERMITS,         type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...PROOF_COHAB,         type: SPOUSE },
          { ...EMP_PROOF_LMIA_EXT,  type: SPOUSE },
          // Child items
          { ...ALL_PERMITS,         type: CHILD },
          { ...PASSPORT_TEMP,       type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
      // ── Outside Canada: COMBINED section. Delete incomplete PA items, recreate all.
      {
        action: 'delete_subtype',
        subType: 'Outside Canada',
      },
      {
        action: 'add',
        subType: 'Outside Canada',
        items: [
          // PA items (combined → both PA & Spouse get all items)
          { ...PASSPORT_TEMP,       type: PA },
          { ...ALL_PERMITS,         type: PA },
          { ...DIGITAL_PHOTO_TEMP,  type: PA },
          { ...IDENTITY_CIVIL,      type: PA },
          { ...ONE_SAME_NAME,       type: PA },
          { ...GOV_ID,              type: PA },
          { ...UPFRONT_MEDICAL,     type: PA },
          { ...POLICE_CERT_WP,      type: PA },
          { ...IELTS,               type: PA },
          { ...UPDATED_RESUME,      type: PA },
          { ...ALL_MARKSHEET,       type: PA },
          { ...ECA,                 type: PA },
          { ...FINANCIAL_DOCS,      type: PA },
          { ...PROOF_WORK_EXP_PA,   type: PA },
          { ...PROOF_INCOME_DEP,    type: PA },
          { ...RECOMMENDATION,      type: PA },
          // Spouse items
          { ...PASSPORT_TEMP,       type: SPOUSE },
          { ...ALL_PERMITS,         type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...GOV_ID,              type: SPOUSE },
          { ...UPFRONT_MEDICAL,     type: SPOUSE },
          { ...POLICE_CERT_WP,      type: SPOUSE },
          { ...IELTS,               type: SPOUSE },
          { ...UPDATED_RESUME,      type: SPOUSE },
          { ...ALL_MARKSHEET,       type: SPOUSE },
          { ...ECA,                 type: SPOUSE },
          { ...FINANCIAL_DOCS,      type: SPOUSE },
          { ...PROOF_WORK_EXP_PA,   type: SPOUSE },
          { ...PROOF_INCOME_DEP,    type: SPOUSE },
          { ...RECOMMENDATION,      type: SPOUSE },
          // Child items
          { ...ALL_PERMITS,         type: CHILD },
          { ...PASSPORT_TEMP,       type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
          { ...UPFRONT_MEDICAL,     type: CHILD },
        ],
      },
    ],
  },

  // ── LMIA Exempt WP ────────────────────────────────────────────────────────
  // Combined PA+Spouse section. PA items (16) exist. Add Spouse (16) + missing Child items (4).
  {
    name:    'LMIA Exempt WP',
    groupId: 'group_mm20h35m',
    ops: [
      {
        action: 'add',
        subType: null,
        items: [
          // Spouse items (copy of PA items — combined section)
          { ...PASSPORT_TEMP,       type: SPOUSE },
          { ...ALL_PERMITS,         type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...GOV_ID,              type: SPOUSE },
          { ...UPFRONT_MEDICAL,     type: SPOUSE },
          { ...POLICE_CERT_WP,      type: SPOUSE },
          { ...IELTS,               type: SPOUSE },
          { ...UPDATED_RESUME,      type: SPOUSE },
          { ...ALL_MARKSHEET,       type: SPOUSE },
          { ...ECA,                 type: SPOUSE },
          { ...FINANCIAL_DOCS,      type: SPOUSE },
          { ...PROOF_WORK_EXP_PA,   type: SPOUSE },
          { ...PROOF_INCOME_DEP,    type: SPOUSE },
          { name: 'Recommendation Letters (only for Principal Applicant)', cat: 'Other', type: SPOUSE },
          // Child items (Birth Certificate exists, add the rest)
          { ...ALL_PERMITS,         type: CHILD },
          { ...PASSPORT_TEMP,       type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...UPFRONT_MEDICAL,     type: CHILD },
        ],
      },
    ],
  },

  // ── PGWP ─────────────────────────────────────────────────────────────────
  {
    name:    'PGWP',
    groupId: 'group_mm201tn9',
    ops: [
      // Extension - Single Applicant: Delete incomplete PA (1 item), recreate full PA list (8 items).
      {
        action: 'delete_subtype',
        subType: 'Extension - Single Applicant',
      },
      {
        action: 'add',
        subType: 'Extension - Single Applicant',
        items: [
          { ...PASSPORT_PGWP_EXT,     type: PA },
          { ...ALL_PERMITS,           type: PA },
          { ...DIGITAL_PHOTO_TEMP,    type: PA },
          { ...CAN_EDU_DOCS_PGWP,     type: PA },
          { ...IDENTITY_CIVIL,        type: PA },
          { ...ONE_SAME_NAME,         type: PA },
          { ...PREV_APP_FORMS,        type: PA },
          { ...LANG_TEST_PGWP,        type: PA },
        ],
      },
      // Extension - Accompanying Spouse/Child: Delete incomplete items (5), recreate all (11 PA + 11 Spouse + 4 Child).
      {
        action: 'delete_subtype',
        subType: 'Extension - Accompanying Spouse/Child',
      },
      {
        action: 'add',
        subType: 'Extension - Accompanying Spouse/Child',
        items: [
          // PA items
          { ...PASSPORT_TEMP,         type: PA },
          { ...ALL_PERMITS,           type: PA },
          { ...DIGITAL_PHOTO_TEMP,    type: PA },
          { ...CAN_EDU_DOCS_PGWP,     type: PA },
          { ...IDENTITY_CIVIL,        type: PA },
          { ...ONE_SAME_NAME,         type: PA },
          { ...PROOF_INCOME_PGWP,     type: PA },
          { ...PROOF_FUNDS_PGWP,      type: PA },
          { ...PROOF_COHAB,           type: PA },
          { ...PREV_APP_FORMS,        type: PA },
          { ...LANG_TEST_PGWP,        type: PA },
          // Spouse items (combined → same as PA)
          { ...PASSPORT_TEMP,         type: SPOUSE },
          { ...ALL_PERMITS,           type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,    type: SPOUSE },
          { ...CAN_EDU_DOCS_PGWP,     type: SPOUSE },
          { ...IDENTITY_CIVIL,        type: SPOUSE },
          { ...ONE_SAME_NAME,         type: SPOUSE },
          { ...PROOF_INCOME_PGWP,     type: SPOUSE },
          { ...PROOF_FUNDS_PGWP,      type: SPOUSE },
          { ...PROOF_COHAB,           type: SPOUSE },
          { ...PREV_APP_FORMS,        type: SPOUSE },
          { ...LANG_TEST_PGWP,        type: SPOUSE },
          // Child items
          { ...ALL_PERMITS,           type: CHILD },
          { ...PASSPORT_TEMP,         type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,    type: CHILD },
          { ...BIRTH_CERT,            type: CHILD },
        ],
      },
      // Single Applicant: Has correct PA items (7). Also needs accompanying items from PDF.
      // The PGWP Accompanying PDF has additional items NOT in single applicant.
      // The PGWP Accompanying sub-type is "Extension - Accompanying" but original PGWP has its own.
      // Looking at the group: "Single Applicant" sub-type has 7 PA items — correct, no changes needed.
    ],
  },

  // ── Study Permit Extension ─────────────────────────────────────────────────
  {
    name:    'Study Permit Extension',
    groupId: 'group_mm20k9f8',
    ops: [
      // Accompanying Spouse or Child: Delete incomplete items (2), recreate all.
      {
        action: 'delete_subtype',
        subType: 'Accompanying Spouse or Child',
      },
      {
        action: 'add',
        subType: 'Accompanying Spouse or Child',
        items: [
          // PA items
          { ...PASSPORT_TEMP,        type: PA },
          { ...ALL_PERMITS,          type: PA },
          { ...ONE_SAME_NAME,        type: PA },
          { ...DIGITAL_PHOTO_TEMP,   type: PA },
          { ...PROOF_ADMISSION,      type: PA },
          { ...PROOF_FINANCIAL_SP,   type: PA },
          { ...PROOF_COHAB,          type: PA },
          // Spouse items (combined → same as PA)
          { ...PASSPORT_TEMP,        type: SPOUSE },
          { ...ALL_PERMITS,          type: SPOUSE },
          { ...ONE_SAME_NAME,        type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,   type: SPOUSE },
          { ...PROOF_ADMISSION,      type: SPOUSE },
          { ...PROOF_FINANCIAL_SP,   type: SPOUSE },
          { ...PROOF_COHAB,          type: SPOUSE },
          // Child items
          { ...ALL_PERMITS,          type: CHILD },
          { ...PASSPORT_TEMP,        type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,   type: CHILD },
          { ...BIRTH_CERT,           type: CHILD },
        ],
      },
    ],
  },

  // ── PR Card Renewal ────────────────────────────────────────────────────────
  // Combined PA+Spouse section. PA items (7) exist. Add Spouse (7) + missing Child items (2).
  {
    name:    'PR Card Renewal',
    groupId: 'group_mm20qncv',
    ops: [
      {
        action: 'add',
        subType: null,
        items: [
          // Spouse items (combined → same as PA)
          { ...PASSPORT_PR,           type: SPOUSE },
          { ...IDENTITY_CIVIL,        type: SPOUSE },
          { ...ONE_SAME_NAME,         type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,      type: SPOUSE },
          { ...URGENT_TRAVEL,         type: SPOUSE },
          { ...STATUS_ID_PR,          type: SPOUSE },
          { ...PROOF_RESIDENCY,       type: SPOUSE },
          // Child items (Passport exists, add Status Identification + Digital photo)
          { ...STATUS_ID_PR,          type: CHILD },
          { ...DIGITAL_PHOTO_PR,      type: CHILD },
        ],
      },
    ],
  },

  // ── PRTD ─────────────────────────────────────────────────────────────────
  // Combined PA+Spouse section. PA items (7) exist. Add Spouse (7) + missing Child items (2).
  {
    name:    'PRTD',
    groupId: 'group_mm20905c',
    ops: [
      {
        action: 'add',
        subType: null,
        items: [
          // Spouse items
          { ...PASSPORT_PR,           type: SPOUSE },
          { ...IDENTITY_CIVIL,        type: SPOUSE },
          { ...ONE_SAME_NAME,         type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,      type: SPOUSE },
          { ...PROOF_RESIDENCY,       type: SPOUSE },
          { ...URGENT_TRAVEL,         type: SPOUSE },
          { ...STATUS_ID_PR,          type: SPOUSE },
          // Child items (Passport exists, add Status Identification + Digital photo)
          { ...STATUS_ID_PR,          type: CHILD },
          { ...DIGITAL_PHOTO_PR,      type: CHILD },
        ],
      },
    ],
  },

  // ── Renunciation of PR ────────────────────────────────────────────────────
  // Combined PA+Spouse section. PA items (5) exist. Child items (4) exist but missing Status ID.
  // Add Spouse (5) + 1 missing Child item.
  {
    name:    'Renunciation of PR',
    groupId: 'group_mm20p4n1',
    ops: [
      {
        action: 'add',
        subType: null,
        items: [
          // Spouse items (combined → same as PA)
          { ...PASSPORT_RENUNC,       type: SPOUSE },
          { ...IDENTITY_CIVIL,        type: SPOUSE },
          { ...ONE_SAME_NAME,         type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,      type: SPOUSE },
          { ...STATUS_ID_PR,          type: SPOUSE },
          // Child Status Identification (missing)
          { ...STATUS_ID_PR,          type: CHILD },
        ],
      },
    ],
  },

  // ── Citizenship ───────────────────────────────────────────────────────────
  // Combined PA+Spouse section. PA items (7) exist. Child items (3: Passport, Personal ID, Birth Cert) exist.
  // Add Spouse (7) + missing Child Digital photo.
  {
    name:    'Citizenship',
    groupId: 'group_mm20fk69',
    ops: [
      {
        action: 'add',
        subType: null,
        items: [
          // Spouse items (combined → same as PA)
          { ...PASSPORT_CITIZEN,       type: SPOUSE },
          { ...PERSONAL_ID_CITIZEN,    type: SPOUSE },
          { ...IDENTITY_CIVIL,         type: SPOUSE },
          { ...ONE_SAME_NAME,          type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,       type: SPOUSE },
          { ...LANG_TEST_CITIZEN,      type: SPOUSE },
          { ...POLICE_CERT_CITIZEN,    type: SPOUSE },
          // Child items (Passport, Personal ID, Birth Cert exist — add Digital photo)
          { ...DIGITAL_PHOTO_PR,       type: CHILD },
        ],
      },
    ],
  },

  // ── Federal PR (Non-Express Entry) ────────────────────────────────────────
  {
    name:    'Federal PR',
    groupId: 'group_mm20v0tw',
    ops: [
      // Non Express Entry - Accompanying Spouse & Child: COMBINED section.
      // PA items (14) exist. Add Spouse (14) + Child (5).
      {
        action: 'add',
        subType: 'Non Express Entry - Accompanying Spouse & Child',
        items: [
          // Spouse items (combined → same as PA)
          { ...PASSPORT_TEMP,           type: SPOUSE },
          { ...ALL_PERMITS,             type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,        type: SPOUSE },
          { ...LANG_PROF_FEDNEE,        type: SPOUSE },
          { ...MEDICAL_EXAM,            type: SPOUSE },
          { ...POLICE_CLEAR,            type: SPOUSE },
          { ...CAN_EDU_DOCS_NEE,        type: SPOUSE },
          { ...FOREIGN_EDU_ECA,         type: SPOUSE },
          { ...SIBLING_PROOF,           type: SPOUSE },
          { ...PROOF_WORK_EXP_NEE,      type: SPOUSE },
          { ...IDENTITY_CIVIL,          type: SPOUSE },
          { ...BIRTH_CERT,              type: SPOUSE },
          { ...PROOF_LIVING_CAN,        type: SPOUSE },
          { ...ONE_SAME_NAME,           type: SPOUSE },
          // Child items
          { ...PASSPORT_TEMP,           type: CHILD },
          { ...ALL_PERMITS,             type: CHILD },
          { ...DIGITAL_PHOTO_PR,        type: CHILD },
          { ...MEDICAL_EXAM,            type: CHILD },
          { ...BIRTH_CERT,              type: CHILD },
        ],
      },
      // Non Express Entry - Non Accompanying Spouse: SEPARATE sections.
      // Delete incomplete PA (1 item), recreate PA (14) + Spouse (6).
      {
        action: 'delete_subtype',
        subType: 'Non Express Entry - Non Accompanying Spouse',
      },
      {
        action: 'add',
        subType: 'Non Express Entry - Non Accompanying Spouse',
        items: [
          // PA items
          { ...PASSPORT_TEMP,           type: PA },
          { ...ALL_PERMITS,             type: PA },
          { ...DIGITAL_PHOTO_NEE,       type: PA },
          { ...LANG_PROF_FEDNEE,        type: PA },
          { ...MEDICAL_EXAM,            type: PA },
          { ...POLICE_CLEAR,            type: PA },
          { ...CAN_EDU_DOCS_NEE,        type: PA },
          { ...FOREIGN_EDU_ECA,         type: PA },
          { ...SIBLING_PROOF,           type: PA },
          { ...PROOF_WORK_EXP_NEE,      type: PA },
          { ...IDENTITY_CIVIL,          type: PA },
          { ...BIRTH_CERT,              type: PA },
          { ...ONE_SAME_NAME,           type: PA },
          { ...PROOF_LIVING_CAN,        type: PA },
          // Non-accompanying Spouse items (separate section)
          { ...PASSPORT_TEMP,           type: SPOUSE },
          { ...ALL_PERMITS,             type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,        type: SPOUSE },
          { ...MEDICAL_EXAM,            type: SPOUSE },
          { ...POLICE_CLEAR,            type: SPOUSE },
          { ...ONE_SAME_NAME,           type: SPOUSE },
        ],
      },
    ],
  },

  // ── Concurrent WP ─────────────────────────────────────────────────────────
  // SEPARATE sections. PA items (11) exist. Add Spouse items (4).
  {
    name:    'Concurrent WP',
    groupId: 'group_mm20hga4',
    ops: [
      {
        action: 'add',
        subType: null,
        items: [
          // Dependent Applicant / Spouse section (4 items)
          { ...PASSPORT_TEMP,         type: SPOUSE },
          { ...ALL_PERMITS,           type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,    type: SPOUSE },
          { ...PROOF_COHAB,           type: SPOUSE },
        ],
      },
    ],
  },

];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let totalCreated = 0;
  let totalDeleted = 0;

  for (const group of GROUPS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`▶  Processing: ${group.name} (${group.groupId})`);

    for (const op of group.ops) {
      if (op.action === 'delete_subtype') {
        console.log(`  ↳ Deleting items for sub-type: "${op.subType}"`);
        const d = await deleteItemsForSubType(group.groupId, op.subType);
        totalDeleted += d;
        console.log(`    Deleted ${d} items`);

      } else if (op.action === 'add') {
        const label = op.subType ? `sub-type "${op.subType}"` : 'no sub-type';
        console.log(`  ↳ Creating ${op.items.length} items for ${label}`);
        const c = await createItems(group.groupId, op.items, op.subType || '');
        totalCreated += c;
      }
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Done — deleted ${totalDeleted} items, created ${totalCreated} items`);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
