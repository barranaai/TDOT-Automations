/**
 * Case Structure Schema — Supervisa / Parents.
 *
 * ⚠️  DESIGN ARTIFACT — not yet wired into any service. Nothing imports this.
 *     This is the canary that defines the schema FORMAT for all 68 case types.
 *     Reviewed against the source PDF before it drives any real seeding.
 *
 * Source-of-truth PDF:
 *   Document Checklist Items/Supervisa/Document Checklist- Supervisa- Parents.pdf
 *
 * Role mapping for this sub-type (per the PDF's own section headings):
 *   - PrincipalApplicant = the parent applying for the Super Visa        (PDF pp.1-3)
 *   - Spouse             = the second parent, "Dependent spouse Applicant" (same doc list as PA)
 *   - Sponsor            = the "Inviter(s)" — the child living in Canada   (PDF pp.4-5)
 *
 * The single per-document conditional in this PDF is the "One and same name
 * affidavit if name/surname changed" — modelled below as includeWhen.memberFlag.
 */

'use strict';

// ── PA and Spouse share an identical document list (each applicant supplies
//    their own copy). Defined once, referenced by both roles. ──
// Each entry corresponds to ONE ☐ checkbox in the PDF. Sub-bullets in the PDF
// (e.g. salaried vs self-employed income proofs) are client *guidance*, not
// separate checklist rows, so they live in `guidance`, not as extra docs.
const PA_SPOUSE_DOCUMENTS = [
  {
    code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms',
    guidance: 'Complete with full and accurate details. Gaps are not accepted.',
  },
  {
    code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
    guidance: 'Photo/name/signature/DOB/place-of-issue pages, plus old & current passports showing entry/exit stamps.',
  },
  {
    code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit (name/surname changed)', category: 'Identity',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn by a lawyer/notary. Include legal proof of the name change.',
  },
  {
    code: 'DIGITALPHOTO', name: 'Digital photo (Temporary Resident specifications)', category: 'Identity',
  },
  {
    code: 'UPFRONTMEDICAL', name: 'Upfront Medical', category: 'Medical',
    guidance: 'Must be done by an IRCC-approved Panel Physician.',
  },
  {
    code: 'IACD', name: 'Identity and Civil Documents', category: 'Identity',
    guidance: 'Marriage/divorce/annulment certificates, death certificate of former spouse, common-law declaration (IMM5409), marriage affidavit — whichever apply.',
  },
  {
    code: 'GOVTID', name: 'Government-issued Identity documents', category: 'Identity',
    guidance: 'Aadhar, PAN, or any government doc showing full name, DOB, photo, signature.',
  },
  {
    code: 'INCOME', name: 'Proof / source of Income', category: 'Financial',
    guidance: 'Salaried: job letter + 3 payslips + Form 16/tax proof. Self-employed: business proof + tax + 3mo bank statements. Pensioner/unemployed: pension confirmation + bank statement / family support docs.',
  },
  {
    code: 'FINDOCS', name: 'Financial Documents', category: 'Financial',
    guidance: '3mo bank statements, investments, asset/property/gold valuation, Net Worth (CA) report, support affidavit if relying on family assets.',
  },
  {
    code: 'HEALTHINS', name: 'Health Insurance', category: 'Insurance',
    guidance: 'Min $100,000 emergency coverage, valid ≥1 year from entry, effective on the landing date.',
  },
  {
    code: 'GOVTEMP', name: 'Details of government employment, police service, military experience', category: 'Other',
    guidance: 'Completed via the additional information form we provide.',
  },
];

// ── Sponsor / Inviter document list (PDF pp.4-5). ──
const SPONSOR_DOCUMENTS = [
  {
    code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
  },
  {
    code: 'CURSTATUS', name: 'Current Status in the country', category: 'Other',
    guidance: 'Canadian passport and PR card. If a citizen, also provide the original-country passport.',
  },
  {
    code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity',
    guidance: 'Government-issued, showing parents’ names. 10th/12th marksheet accepted as a fallback (not preferred).',
  },
  {
    code: 'IACD', name: 'Identity and Civil Documents', category: 'Identity',
    guidance: 'Name/DOB-change docs, common-law declaration (IMM5409), marriage/divorce/death certificates, children’s birth certificates — whichever apply.',
  },
  {
    code: 'POLC', name: 'Proof of living in Canada (any 1)', category: 'Other',
    guidance: 'Driver’s licence (front+back), recent credit-card statement, recent utility bill, or provincial ID card.',
  },
  {
    code: 'INCOME', name: 'Proof / source of Income', category: 'Financial',
    guidance: 'Notice of Assessment (mandatory) + 3mo bank statements. Salaried: job letter + payslips + T4. Self-employed: incorporation/business proof + 3mo business bank statements.',
  },
  {
    code: 'FUNDS', name: 'Additional proof of Funds / investments / assets', category: 'Financial',
    guidance: 'Any funds/investments/assets that increase net worth, with supporting documentation.',
  },
];

module.exports = {
  caseType:      'Supervisa',
  subType:       'Parents',
  schemaVersion: 1,
  source:        'Document Checklist Items/Supervisa/Document Checklist- Supervisa- Parents.pdf',

  // Set once a human (e.g. Shafoli) has verified this file against the PDF.
  // The seeder can warn/refuse on unreviewed schemas in production if we choose.
  reviewedBy: null,
  reviewedAt: null,

  // ── Composition flags this schema reads. ──
  // caseFlags are captured once per case (pre-consult form). memberFlags are
  // captured per applicant. The pure seeder evaluates includeWhen against these.
  caseFlags: {
    spouseIncluded: { label: 'The applicant’s spouse is also applying for the Super Visa' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  // ── Roles. Order here is the order rows are seeded. ──
  roles: [
    {
      role:      'PrincipalApplicant',
      label:     'Principal Applicant (Parent)',
      required:  true,                 // always seeded
      documents: PA_SPOUSE_DOCUMENTS,
    },
    {
      role:        'Spouse',
      label:       'Dependent Spouse (Parent)',
      includeWhen: { caseFlag: 'spouseIncluded' },   // seeded only if spouse applies
      documents:   PA_SPOUSE_DOCUMENTS,
    },
    {
      role:      'Sponsor',
      label:     'Sponsor / Inviter (in Canada)',
      required:  true,                 // ALWAYS required for Supervisa-Parents.
                                       // Client input cannot drop this — this is
                                       // exactly the invariant SV-002 violated.
      documents: SPONSOR_DOCUMENTS,
    },
  ],
};
