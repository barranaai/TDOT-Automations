/**
 * Case Structure Schema — Supervisa / Grandparents.
 *
 * Source: Document Checklist Items/Supervisa/Document Checklist- Supervisa- GrandParents.pdf
 *
 * Identical to Supervisa/Parents except the applicant section adds a standalone
 * "Support Affidavit" document (PDF page 3). Same role structure: PA + optional
 * Spouse + always-required Sponsor (Inviter).
 *
 * Reviewed against the PDF — see review note in caseSchemaService registration.
 */

'use strict';

const CASE_TYPE     = 'Supervisa';
const CASE_SUB_TYPE = 'Grandparents';

// PA + Dependent Spouse share an identical list (PDF pp.1-3). One row per ☐.
const PA_SPOUSE_DOCUMENTS = [
  { code: 'QUESTIONNAIRE',   category: 'Forms',     name: 'Questionnaire',
    guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
  { code: 'PASSPORT',        category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT',   category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'DIGITALPHOTO',    category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
  { code: 'UPFRONTMEDICAL',  category: 'Medical',   name: 'Upfront Medical',
    guidance: 'Must be done by an IRCC-approved Panel Physician (find one: https://secure.cic.gc.ca/PanelPhysicianMedecinDesigne/en/Home). Do the exam upfront so you don’t need a letter from IRCC asking for it. More information: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/medical-police/medical-exams/requirements-temporary-residents.html' },
  { code: 'IACD',            category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate, final divorce or annulment certificate (from each marriage if more than one); death certificate of former spouse/common-law partner; legal name/date-of-birth change documents; common-law declaration IMM5409; marriage affidavit with couple picture if no marriage certificate — whichever apply.' },
  { code: 'GOVTID',          category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Aadhar card, PAN card, or any other document issued by your government showing your full name, date of birth, photograph and signature.' },
  { code: 'INCOME',          category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Bank statement for the last 3 months with good funds. If salaried: job letter on letterhead (start date, title, salary, hours, duties — hand-signed), at least 3 pay slips, Form 16 or other tax proof. If self-employed: business establishment proof, tax payment proof, 3 months business bank statements. If pensioner/unemployed: pension confirmation and bank statement, or support documents from immediate family apart from the inviter.' },
  { code: 'FINDOCS',         category: 'Financial', name: 'Financial Documents',
    guidance: 'Higher funds raise approval chances. At least 3 months bank statements with no sudden deposits; investment proof in your name; property/gold evaluation reports; net-worth (CA) certificate highly recommended; support affidavit if the assets belong to supporting immediate family members.' },
  { code: 'HEALTHINS',       category: 'Insurance', name: 'Health Insurance',
    guidance: 'Proof of a health insurance policy certificate with an effective date same as the landing date, a minimum of $100,000 emergency coverage, valid at least 1 year from the date of entry. More information: https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/parent-grandparent-super-visa/eligibility.html#insurance' },
  { code: 'SUPPORTAFFIDAVIT', category: 'Financial', name: 'Support Affidavit',
    guidance: 'If the assets belong to immediate family members who will support you for this application: a notarised affidavit (we can share a template) plus relationship proof such as passports and birth certificates. We may ask for more documents if required to prove the relationship.' },
  { code: 'GOVTEMP',         category: 'Other',     name: 'Details of government employment, police service, military experience',
    guidance: 'We will provide an additional information form that must be completed with precise information; gaps may lead to additional document requests, processing delays or refusal.' },
];

// Sponsor / Inviter list (PDF pp.4-5).
const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with photo, name, signature, date/place of birth, place of issue and address.' },
  { code: 'CURSTATUS', category: 'Other',     name: 'Current Status in the country',
    guidance: 'Status documents in the country, i.e. Canadian passport and PR card. Canadian citizens: include the original-country passport as well.' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate',
    guidance: 'Issued by the government and showing the parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate, final divorce or annulment certificate (from each marriage if more than one); common-law declaration IMM5409; death certificate of former spouse/common-law partner; birth certificates of children; legal name/date-of-birth change documents — whichever apply.' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)',
    guidance: 'Any one of: driver’s licence (front and back), most recent credit card statement, most recent utility bill (electricity/gas), or provincial ID card.' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Notice of Assessment for the last year — mandatory for income eligibility; include yourself, spouse, children and parents when counting family size (see https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/parent-grandparent-super-visa/eligibility.html#eligibility) — plus 3 months bank statements with good funds. If salaried: signed job letter on letterhead, at least 3 pay slips, T4/Form 16, other tax proof. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets',
    guidance: 'Any funds, investments or assets that increase your net worth — disclose them with supporting documentation.' },
];

module.exports = {
  caseType:      CASE_TYPE,
  subType:       CASE_SUB_TYPE,
  schemaVersion: 1,
  source:        'Document Checklist Items/Supervisa/Document Checklist- Supervisa- GrandParents.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded: { label: 'The applicant’s spouse is also applying for the Super Visa' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Grandparent)', required: true,  documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Spouse (Grandparent)',    includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Sponsor',            label: 'Sponsor / Inviter (in Canada)',     required: true,  documents: SPONSOR_DOCUMENTS },
  ],
};
