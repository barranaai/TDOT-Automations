/**
 * fixVisitorVisaApplicantTypes.js
 *
 * Fixes the Visitor Visa template group (group_mm20tt4n) which has ALL items
 * tagged as "Principal Applicant" with no Spouse or Dependent Child items.
 *
 * Adds Spouse / Common-Law Partner items to relevant sub-types, and
 * Dependent Child items to sub-types that include children.
 *
 * Run with: node src/scripts/fixVisitorVisaApplicantTypes.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID   = '18401624183';
const GROUP_ID   = 'group_mm20tt4n';

// Column IDs
const SUBTYPE_COL  = 'dropdown_mm204y6w';
const CATEGORY_COL = 'dropdown_mm0x41zm';
const APP_TYPE_COL = 'dropdown_mm261bn6';

// Applicant type labels
const SPOUSE = 'Spouse / Common-Law Partner';
const CHILD  = 'Dependent Child';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── API helpers ──────────────────────────────────────────────────────────────

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

async function createItems(docs, subType) {
  let created = 0;
  for (const doc of docs) {
    const id = await createItem(GROUP_ID, doc.name, subType, doc.cat, doc.type);
    console.log(`    ✅ [${doc.type}] ${doc.name} (id:${id})`);
    created++;
  }
  return created;
}

// ─── Document definitions ─────────────────────────────────────────────────────

// Common base documents shared across most Visitor Visa sub-types
const PASSPORT_STAMPED   = { name: 'Passport with all stamped pages',          cat: 'Identity' };
const PASSPORT_STAMPED2  = { name: 'Passport with all stamped pages.',         cat: 'Identity' }; // trailing period variant
const ONE_SAME_NAME      = { name: 'One and same name affidavit if name /surname changed', cat: 'Other' };
const DIGITAL_PHOTO      = { name: 'Digital photo as per specifications of Temporary Residents', cat: 'Identity' };
const IDENTITY_CIVIL     = { name: 'Identity and Civil Documents',             cat: 'Identity' };
const GOV_ID             = { name: 'Government issued Identity documents',     cat: 'Identity' };
const PROOF_INCOME       = { name: 'Proof/source of Income',                   cat: 'Financial' };
const FINANCIAL_DOCS     = { name: 'Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request.', cat: 'Financial' };
const CURRENT_STATUS     = { name: 'Current Status in the country',            cat: 'Other' };
const PROOF_LIVING_CAN   = { name: 'Proof of living in Canada (any 1)',        cat: 'Other' };
const ADDL_FUNDS         = { name: 'Additional proof of Funds/investments/assets', cat: 'Financial' };
const BIRTH_CERT         = { name: 'Birth Certificate',                        cat: 'Identity' };
const SUPPORT_AFFIDAVIT  = { name: 'Support Affidavit',                        cat: 'Other' };
const IF_STUDENT         = { name: 'If student',                               cat: 'Other' };
const PROOF_RELATIONSHIP = { name: 'Proof of Relationship',                    cat: 'Other' };
const PROOF_REL_APPS     = { name: 'Proof of Relationship with the applicants', cat: 'Other' };
const PROOF_INCOME_HIGHLY= { name: 'Proof/source of Income- Highly recommended', cat: 'Financial' };

// ─── Sub-type document sets ───────────────────────────────────────────────────

// 1-2 Members: Spouse visiting alongside PA (spouse/partner)
const DOCS_1_2_SPOUSE = [
  { ...PASSPORT_STAMPED,    type: SPOUSE },
  { ...ONE_SAME_NAME,       type: SPOUSE },
  { ...DIGITAL_PHOTO,       type: SPOUSE },
  { ...IDENTITY_CIVIL,      type: SPOUSE },
  { ...GOV_ID,              type: SPOUSE },
  { ...PROOF_INCOME,        type: SPOUSE },
  { ...FINANCIAL_DOCS,      type: SPOUSE },
  { ...PASSPORT_STAMPED2,   type: SPOUSE },
  { ...CURRENT_STATUS,      type: SPOUSE },
  { ...PROOF_REL_APPS,      type: SPOUSE },
  { ...PROOF_LIVING_CAN,    type: SPOUSE },
  { ...ADDL_FUNDS,          type: SPOUSE },
];

// 1-3 Members: PA + Spouse + Child
const DOCS_1_3_SPOUSE = [
  { ...PASSPORT_STAMPED,    type: SPOUSE },
  { ...ONE_SAME_NAME,       type: SPOUSE },
  { ...DIGITAL_PHOTO,       type: SPOUSE },
  { ...IDENTITY_CIVIL,      type: SPOUSE },
  { ...GOV_ID,              type: SPOUSE },
  { ...PROOF_INCOME,        type: SPOUSE },
  { ...FINANCIAL_DOCS,      type: SPOUSE },
  { ...IF_STUDENT,          type: SPOUSE },
  { ...BIRTH_CERT,          type: SPOUSE },
  { ...SUPPORT_AFFIDAVIT,   type: SPOUSE },
  { ...PASSPORT_STAMPED2,   type: SPOUSE },
  { ...CURRENT_STATUS,      type: SPOUSE },
  { ...PROOF_RELATIONSHIP,  type: SPOUSE },
  { ...PROOF_LIVING_CAN,    type: SPOUSE },
  { ...ADDL_FUNDS,          type: SPOUSE },
];

const DOCS_1_3_CHILD = [
  { ...PASSPORT_STAMPED,    type: CHILD },
  { ...DIGITAL_PHOTO,       type: CHILD },
  { ...BIRTH_CERT,          type: CHILD },
  { ...IDENTITY_CIVIL,      type: CHILD },
  { ...CURRENT_STATUS,      type: CHILD },
];

// Both Parents: Two parents visiting → PA + Spouse
const DOCS_BOTH_PARENTS_SPOUSE = [
  { ...PASSPORT_STAMPED,    type: SPOUSE },
  { ...ONE_SAME_NAME,       type: SPOUSE },
  { ...DIGITAL_PHOTO,       type: SPOUSE },
  { ...IDENTITY_CIVIL,      type: SPOUSE },
  { ...GOV_ID,              type: SPOUSE },
  { ...PROOF_INCOME,        type: SPOUSE },
  { ...FINANCIAL_DOCS,      type: SPOUSE },
  { ...PASSPORT_STAMPED2,   type: SPOUSE },
  { ...CURRENT_STATUS,      type: SPOUSE },
  { ...BIRTH_CERT,          type: SPOUSE },
  { ...PROOF_LIVING_CAN,    type: SPOUSE },
  { ...ADDL_FUNDS,          type: SPOUSE },
];

// Parents & Siblings: Multiple family members → PA + Spouse
const DOCS_PARENTS_SIBLINGS_SPOUSE = [
  { ...PASSPORT_STAMPED,    type: SPOUSE },
  { ...ONE_SAME_NAME,       type: SPOUSE },
  { ...DIGITAL_PHOTO,       type: SPOUSE },
  { ...IDENTITY_CIVIL,      type: SPOUSE },
  { ...GOV_ID,              type: SPOUSE },
  { ...PROOF_INCOME,        type: SPOUSE },
  { ...FINANCIAL_DOCS,      type: SPOUSE },
  { ...BIRTH_CERT,          type: SPOUSE },
  { ...SUPPORT_AFFIDAVIT,   type: SPOUSE },
  { ...PASSPORT_STAMPED2,   type: SPOUSE },
  { ...CURRENT_STATUS,      type: SPOUSE },
  { ...PROOF_LIVING_CAN,    type: SPOUSE },
  { ...ADDL_FUNDS,          type: SPOUSE },
];

// Spouse: Sub-type where PA's spouse is also applying → PA + Spouse
const DOCS_SPOUSE_SPOUSE = [
  { ...PASSPORT_STAMPED,    type: SPOUSE },
  { ...ONE_SAME_NAME,       type: SPOUSE },
  { ...DIGITAL_PHOTO,       type: SPOUSE },
  { ...IDENTITY_CIVIL,      type: SPOUSE },
  { ...GOV_ID,              type: SPOUSE },
  { ...PROOF_INCOME,        type: SPOUSE },
  { ...FINANCIAL_DOCS,      type: SPOUSE },
  { ...PASSPORT_STAMPED2,   type: SPOUSE },
  { ...CURRENT_STATUS,      type: SPOUSE },
  { ...BIRTH_CERT,          type: SPOUSE },
  { ...PROOF_LIVING_CAN,    type: SPOUSE },
  { ...ADDL_FUNDS,          type: SPOUSE },
];

// Spousal Sponsorship in Process: PA + accompanying Spouse
const DOCS_SPOUSAL_SPONSORSHIP_SPOUSE = [
  { ...PASSPORT_STAMPED,     type: SPOUSE },
  { ...ONE_SAME_NAME,        type: SPOUSE },
  { ...DIGITAL_PHOTO,        type: SPOUSE },
  { ...IDENTITY_CIVIL,       type: SPOUSE },
  { ...GOV_ID,               type: SPOUSE },
  { ...PROOF_INCOME_HIGHLY,  type: SPOUSE },
  { ...FINANCIAL_DOCS,       type: SPOUSE },
  { ...PASSPORT_STAMPED2,    type: SPOUSE },
  { ...CURRENT_STATUS,       type: SPOUSE },
  { ...BIRTH_CERT,           type: SPOUSE },
  { ...PROOF_LIVING_CAN,     type: SPOUSE },
  { ...PROOF_INCOME,         type: SPOUSE },
  { ...ADDL_FUNDS,           type: SPOUSE },
];

// ─── Operations ───────────────────────────────────────────────────────────────

const OPS = [
  {
    label:   'Spouse sub-type → Add Spouse items',
    subType: 'Spouse',
    items:   DOCS_SPOUSE_SPOUSE,
  },
  {
    label:   '1-2 Members → Add Spouse items',
    subType: '1-2 Members',
    items:   DOCS_1_2_SPOUSE,
  },
  {
    label:   '1-3 Members → Add Spouse items',
    subType: '1-3 Members',
    items:   DOCS_1_3_SPOUSE,
  },
  {
    label:   '1-3 Members → Add Dependent Child items',
    subType: '1-3 Members',
    items:   DOCS_1_3_CHILD,
  },
  {
    label:   'Both Parents → Add Spouse items',
    subType: 'Both Parents',
    items:   DOCS_BOTH_PARENTS_SPOUSE,
  },
  {
    label:   'Parents & Siblings → Add Spouse items',
    subType: 'Parents & Siblings',
    items:   DOCS_PARENTS_SIBLINGS_SPOUSE,
  },
  {
    label:   'Spousal Sponsorship in Process → Add Spouse items',
    subType: 'Spousal Sponsorship in Process',
    items:   DOCS_SPOUSAL_SPONSORSHIP_SPOUSE,
  },
  // Single Parent and Change of Status are solo-applicant sub-types → no changes needed
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('▶  Fixing Visitor Visa template group (group_mm20tt4n)');
  console.log('   Adding missing Spouse / Dependent Child items\n');

  let totalCreated = 0;

  for (const op of OPS) {
    console.log(`\n── ${op.label}`);
    const count = await createItems(op.items, op.subType);
    totalCreated += count;
    console.log(`   → ${count} items created`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Done — created ${totalCreated} items total`);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
