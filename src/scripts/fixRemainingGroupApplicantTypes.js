/**
 * fixRemainingGroupApplicantTypes.js
 *
 * Fixes the 9 remaining Template Board groups that have all items tagged
 * as "Principal Applicant" only — adds Spouse / Common-Law Partner and
 * Dependent Child items where appropriate.
 *
 * Groups fixed:
 *   1. Visitor Record / Extension  — Spouse + Child for all 3 sub-types
 *   2. Supervisa                   — Spouse for Parents & Grandparents
 *   3. TRV                         — Spouse + Child (no sub-type)
 *   4. Co-op WP                    — Spouse + Child (no sub-type)
 *   5. SCLPC WP                    — Dependent Child only (PA is the spouse)
 *   6. AAIP                        — Spouse + Child for all 4 sub-types
 *   7. BCPNP                       — Spouse + Child for BC PNP+ Company Info
 *   8. NSNP                        — Spouse + Child (no sub-type)
 *   9. OINP                        — Spouse + Child for all 7 sub-types
 *
 * Run with: node src/scripts/fixRemainingGroupApplicantTypes.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID    = '18401624183';
const SUBTYPE_COL  = 'dropdown_mm204y6w';
const CATEGORY_COL = 'dropdown_mm0x41zm';
const APP_TYPE_COL = 'dropdown_mm261bn6';

const SPOUSE = 'Spouse / Common-Law Partner';
const CHILD  = 'Dependent Child';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── API helper ───────────────────────────────────────────────────────────────

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

async function createItems(groupId, docs, subType) {
  let created = 0;
  for (const doc of docs) {
    const id = await createItem(groupId, doc.name, subType || '', doc.cat, doc.type);
    console.log(`    ✅ [${doc.type}] ${doc.name} (id:${id})`);
    created++;
  }
  return created;
}

// ─── Shared document definitions ─────────────────────────────────────────────

// Identity / core temp resident
const PASSPORT_STAMPED   = { name: 'Passport with all stamped pages',          cat: 'Identity' };
const PASSPORT_STAMPED2  = { name: 'Passport with all stamped pages.',         cat: 'Identity' };
const DIGITAL_PHOTO_TEMP = { name: 'Digital photo as per specifications of Temporary Residents', cat: 'Identity' };
const DIGITAL_PHOTO_PR   = { name: 'Digital photo as per specifications Permanent Residents', cat: 'Identity' };
const IDENTITY_CIVIL     = { name: 'Identity and Civil Documents',             cat: 'Identity' };
const GOV_ID             = { name: 'Government issued Identity documents',     cat: 'Identity' };
const ONE_SAME_NAME      = { name: 'One and same name affidavit if name /surname changed', cat: 'Other' };
const BIRTH_CERT         = { name: 'Birth Certificate',                        cat: 'Identity' };
const ALL_PERMITS        = { name: 'All Permits ever held in Canada',          cat: 'Other' };
const ALL_PERMITS_V2     = { name: 'All Permits ever held in Canada',          cat: 'Other' }; // same text, different groups use same name

// Financial
const PROOF_INCOME        = { name: 'Proof/source of Income',                  cat: 'Financial' };
const PROOF_INCOME_BACKHM = { name: 'Proof/source of Income (Back Home)',      cat: 'Financial' };
const PROOF_INCOME_SUPT   = { name: 'Proof/source of Income (If you will support the applicant)', cat: 'Financial' };
const FINANCIAL_DOCS      = { name: 'Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request.', cat: 'Financial' };
const ADDL_FUNDS          = { name: 'Additional proof of Funds/investments/assets', cat: 'Financial' };
const SETTLEMENT_FUNDS    = { name: 'Settlement Funds (Please confirm with us in advance)', cat: 'Financial' };

// Other
const CURRENT_STATUS      = { name: 'Current Status in the country',           cat: 'Other' };
const PROOF_LIVING_CAN    = { name: 'Proof of living in Canada (any 1)',       cat: 'Other' };
const PROOF_RELATIONSHIP  = { name: 'Proof of relationship',                   cat: 'Other' };
const ADDL_DOCS_OPT       = { name: 'Additional documents (Optional)',         cat: 'Other' };
const SUPPORT_AFFIDAVIT   = { name: 'Support Affidavit',                       cat: 'Other' };
const PROOF_COHAB         = { name: 'Proof of cohabitation',                   cat: 'Other' };
const LANG_PROF           = { name: 'Proof of language proficiency (IELTS- G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)', cat: 'Other' };
const RESUME              = { name: 'Resume',                                  cat: 'Other' };

// Medical / Employment
const UPFRONT_MEDICAL     = { name: 'Upfront Medical',                         cat: 'Medical' };
const HEALTH_INSURANCE    = { name: 'Health Insurance',                        cat: 'Medical' };
const GOVT_EMPLOYMENT     = { name: 'Details of government employment, police service, military experience', cat: 'Employment' };

// Education
const CAN_EDU_DOCS        = { name: 'Canadian Education Documents',            cat: 'Education' };
const FOREIGN_EDU_ECA     = { name: 'Foreign Education Documents along with Educational Credential Assessment', cat: 'Education' };

// ─── GROUP OPERATIONS ─────────────────────────────────────────────────────────

const GROUPS = [

  // ── 1. Visitor Record / Extension ──────────────────────────────────────────
  // All 3 sub-types are identical (13 PA items each). Mirror as Spouse + add Child.
  {
    name:    'Visitor Record / Extension',
    groupId: 'group_mm20emfw',
    ops: [
      // Visitor Extension
      {
        label:   'Visitor Extension → Spouse',
        subType: 'Visitor Extension',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...CURRENT_STATUS,      type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...PROOF_INCOME_BACKHM, type: SPOUSE },
          { ...FINANCIAL_DOCS,      type: SPOUSE },
          { ...ADDL_DOCS_OPT,       type: SPOUSE },
          { ...PASSPORT_STAMPED2,   type: SPOUSE },
          { ...PROOF_RELATIONSHIP,  type: SPOUSE },
          { ...PROOF_LIVING_CAN,    type: SPOUSE },
          { ...PROOF_INCOME_SUPT,   type: SPOUSE },
          { ...ADDL_FUNDS,          type: SPOUSE },
        ],
      },
      {
        label:   'Visitor Extension → Child',
        subType: 'Visitor Extension',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...CURRENT_STATUS,      type: CHILD },
        ],
      },
      // Visitor Record
      {
        label:   'Visitor Record → Spouse',
        subType: 'Visitor Record',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...CURRENT_STATUS,      type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...PROOF_INCOME_BACKHM, type: SPOUSE },
          { ...FINANCIAL_DOCS,      type: SPOUSE },
          { ...ADDL_DOCS_OPT,       type: SPOUSE },
          { ...PASSPORT_STAMPED2,   type: SPOUSE },
          { ...PROOF_RELATIONSHIP,  type: SPOUSE },
          { ...PROOF_LIVING_CAN,    type: SPOUSE },
          { ...PROOF_INCOME_SUPT,   type: SPOUSE },
          { ...ADDL_FUNDS,          type: SPOUSE },
        ],
      },
      {
        label:   'Visitor Record → Child',
        subType: 'Visitor Record',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...CURRENT_STATUS,      type: CHILD },
        ],
      },
      // Visitor Record + Restoration
      {
        label:   'Visitor Record + Restoration → Spouse',
        subType: 'Visitor Record + Restoration',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...CURRENT_STATUS,      type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...PROOF_INCOME_BACKHM, type: SPOUSE },
          { ...FINANCIAL_DOCS,      type: SPOUSE },
          { ...ADDL_DOCS_OPT,       type: SPOUSE },
          { ...PASSPORT_STAMPED2,   type: SPOUSE },
          { ...PROOF_RELATIONSHIP,  type: SPOUSE },
          { ...PROOF_LIVING_CAN,    type: SPOUSE },
          { ...PROOF_INCOME_SUPT,   type: SPOUSE },
          { ...ADDL_FUNDS,          type: SPOUSE },
        ],
      },
      {
        label:   'Visitor Record + Restoration → Child',
        subType: 'Visitor Record + Restoration',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...CURRENT_STATUS,      type: CHILD },
        ],
      },
    ],
  },

  // ── 2. Supervisa ────────────────────────────────────────────────────────────
  // Parents = both parents applying. Spouse mirrors all 15 PA items.
  // Grandparents = same structure, just the Support Affidavit extra item.
  {
    name:    'Supervisa',
    groupId: 'group_mm205fc9',
    ops: [
      {
        label:   'Parents → Spouse',
        subType: 'Parents',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...UPFRONT_MEDICAL,     type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...GOV_ID,              type: SPOUSE },
          { ...PROOF_INCOME,        type: SPOUSE },
          { ...FINANCIAL_DOCS,      type: SPOUSE },
          { ...HEALTH_INSURANCE,    type: SPOUSE },
          { ...GOVT_EMPLOYMENT,     type: SPOUSE },
          { ...PASSPORT_STAMPED2,   type: SPOUSE },
          { ...CURRENT_STATUS,      type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
          { ...PROOF_LIVING_CAN,    type: SPOUSE },
          { ...ADDL_FUNDS,          type: SPOUSE },
        ],
      },
      {
        label:   'Grandparents → Spouse',
        subType: 'Grandparents',
        items: [
          { ...SUPPORT_AFFIDAVIT,   type: SPOUSE },
        ],
      },
    ],
  },

  // ── 3. TRV ─────────────────────────────────────────────────────────────────
  // 3 items, no sub-type. Spouse + Child each mirror the 3 PA items.
  {
    name:    'TRV',
    groupId: 'group_mm20sqwz',
    ops: [
      {
        label:   'TRV → Spouse',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
        ],
      },
      {
        label:   'TRV → Child',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
        ],
      },
    ],
  },

  // ── 4. Co-op WP ─────────────────────────────────────────────────────────────
  // 7 PA items, no sub-type. Spouse = core identity docs. Child = core + Birth Cert.
  {
    name:    'Co-op WP',
    groupId: 'group_mm209dn7',
    ops: [
      {
        label:   'Co-op WP → Spouse',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...DIGITAL_PHOTO_TEMP,  type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...PROOF_COHAB,         type: SPOUSE },
        ],
      },
      {
        label:   'Co-op WP → Child',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
    ],
  },

  // ── 5. SCLPC WP ─────────────────────────────────────────────────────────────
  // SCLPC = Spousal/Common-Law Partner in Canada WP.
  // PA is the spouse — no separate "Spouse" section needed.
  // Add Dependent Child items only.
  {
    name:    'SCLPC WP',
    groupId: 'group_mm20z5wq',
    ops: [
      {
        label:   'SCLPC WP → Dependent Child',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...DIGITAL_PHOTO_TEMP,  type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
          { ...CURRENT_STATUS,      type: CHILD },
        ],
      },
    ],
  },

  // ── 6. AAIP ─────────────────────────────────────────────────────────────────
  // Alberta Advantage Immigration Program — PNP route to PR.
  // Spouse and Child need standard PNP dependant documents for all sub-types.
  {
    name:    'AAIP',
    groupId: 'group_mm20pzmk',
    ops: [
      {
        label:   'Tourism & Hospitality Stream → Spouse',
        subType: 'Tourism & Hospitality Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
          { ...LANG_PROF,           type: SPOUSE },
        ],
      },
      {
        label:   'Tourism & Hospitality Stream → Child',
        subType: 'Tourism & Hospitality Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...DIGITAL_PHOTO_PR,    type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
      {
        label:   'Rural Renewal Stream → Spouse',
        subType: 'Rural Renewal Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
        ],
      },
      {
        label:   'Rural Renewal Stream → Child',
        subType: 'Rural Renewal Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...DIGITAL_PHOTO_PR,    type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
      {
        label:   'Opportunity Stream → Spouse',
        subType: 'Opportunity Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
        ],
      },
      {
        label:   'Opportunity Stream → Child',
        subType: 'Opportunity Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...DIGITAL_PHOTO_PR,    type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
      {
        label:   'Express Entry Stream → Spouse',
        subType: 'Express Entry Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
        ],
      },
      {
        label:   'Express Entry Stream → Child',
        subType: 'Express Entry Stream',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...DIGITAL_PHOTO_PR,    type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
    ],
  },

  // ── 7. BCPNP ────────────────────────────────────────────────────────────────
  // BC Provincial Nominee Program — PNP route to PR.
  {
    name:    'BCPNP',
    groupId: 'group_mm20pk4z',
    ops: [
      {
        label:   'BC PNP+ Company Info → Spouse',
        subType: 'BC PNP+ Company Info',
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
          { ...LANG_PROF,           type: SPOUSE },
        ],
      },
      {
        label:   'BC PNP+ Company Info → Child',
        subType: 'BC PNP+ Company Info',
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...DIGITAL_PHOTO_PR,    type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
    ],
  },

  // ── 8. NSNP ─────────────────────────────────────────────────────────────────
  // Nova Scotia Nominee Program — PNP route to PR.
  {
    name:    'NSNP',
    groupId: 'group_mm20yspz',
    ops: [
      {
        label:   'NSNP → Spouse',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: SPOUSE },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
          { ...IDENTITY_CIVIL,      type: SPOUSE },
          { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
          { ...ONE_SAME_NAME,       type: SPOUSE },
          { ...BIRTH_CERT,          type: SPOUSE },
          { ...LANG_PROF,           type: SPOUSE },
        ],
      },
      {
        label:   'NSNP → Child',
        subType: null,
        items: [
          { ...PASSPORT_STAMPED,    type: CHILD },
          { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
          { ...IDENTITY_CIVIL,      type: CHILD },
          { ...DIGITAL_PHOTO_PR,    type: CHILD },
          { ...BIRTH_CERT,          type: CHILD },
        ],
      },
    ],
  },

  // ── 9. OINP ─────────────────────────────────────────────────────────────────
  // Ontario Immigrant Nominee Program — PNP route to PR.
  // 7 sub-types, all get the same Spouse + Child PNP dependant document set.
  {
    name:    'OINP',
    groupId: 'group_mm205n4v',
    ops: [
      ...([
        'International Student Stream',
        'Foreign Worker Stream',
        'Skilled Trades Stream',
        'Human Capital Priorities Stream',
        'In-demand Skills Stream',
        'PhD Graduate Stream',
        'Masters Graduate Stream',
      ].flatMap(subType => [
        {
          label:   `${subType} → Spouse`,
          subType,
          items: [
            { ...PASSPORT_STAMPED,    type: SPOUSE },
            { name: 'All Permits ever held in Canada', cat: 'Other', type: SPOUSE },
            { ...DIGITAL_PHOTO_PR,    type: SPOUSE },
            { ...IDENTITY_CIVIL,      type: SPOUSE },
            { ...ONE_SAME_NAME,       type: SPOUSE },
            { ...BIRTH_CERT,          type: SPOUSE },
            { ...LANG_PROF,           type: SPOUSE },
          ],
        },
        {
          label:   `${subType} → Child`,
          subType,
          items: [
            { ...PASSPORT_STAMPED,    type: CHILD },
            { name: 'All Permits ever held in Canada', cat: 'Other', type: CHILD },
            { ...DIGITAL_PHOTO_PR,    type: CHILD },
            { ...IDENTITY_CIVIL,      type: CHILD },
            { ...BIRTH_CERT,          type: CHILD },
          ],
        },
      ])),
    ],
  },

];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('▶  Fixing remaining Template Board groups — adding Spouse / Child items\n');

  let totalCreated = 0;

  for (const group of GROUPS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`▶  ${group.name} (${group.groupId})`);

    for (const op of group.ops) {
      console.log(`\n  ↳ ${op.label} (${op.items.length} items)`);
      const count = await createItems(group.groupId, op.items, op.subType);
      totalCreated += count;
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Done — created ${totalCreated} items total`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
