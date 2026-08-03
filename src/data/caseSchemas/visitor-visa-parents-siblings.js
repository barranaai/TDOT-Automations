/**
 * Case Structure Schema — Visitor Visa / Parents & Siblings.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf
 *
 * Parents (PA + optional second parent) + optional Sibling(s) + required
 * Inviter. Sibling role has its own 9-doc list. Inviter uses Birth Certificate.
 */

'use strict';

const PARENT_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire',
    guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC temporary-resident photo specifications (see canada.ca photo specifications page).' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; legal name/date-of-birth change documents; common-law declaration IMM5409; marriage affidavit with couple picture if no marriage certificate — whichever apply.' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Aadhar card, PAN card, or any other government-issued document showing your full name, date of birth, photograph and signature.' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Bank statement for the last 3 months with good funds. If salaried: job letter on letterhead (start date, title, salary, hours, duties — hand-signed), at least 3 pay slips, Form 16 or other tax proof. If self-employed: business establishment proof, tax payment proof, 3 months business bank statements. If pensioner/unemployed: pension confirmation and bank statement, or support documents from immediate family apart from the inviter.' },
  { code: 'FINDOCS',       category: 'Financial', name: 'Financial Documents',
    guidance: 'Higher funds raise approval chances. At least 3 months bank statements with no sudden deposits; investment proof in your name; property/gold evaluation reports; net-worth (CA) certificate recommended; notarized support affidavit if the assets belong to supporting family members.' },
];

const SIBLING_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire',
    guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC temporary-resident photo specifications (see canada.ca photo specifications page).' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; legal name/date-of-birth change documents; marriage affidavit with couple picture if no marriage certificate — whichever apply.' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Aadhar card, PAN card, or any other government-issued document showing your full name, date of birth, photograph and signature.' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income (incl. academic docs if student)',
    guidance: 'Bank statement for the last 3 months with good funds. If a student: current grade marksheets, a school/college letter confirming current enrolment with program start and end dates, school/college identity card, plus supporting proof-of-income documents from the parents. If you/parents are salaried: job letter on letterhead (hand-signed), at least 3 pay slips, Form 16 or other tax proof. If you/parents are self-employed: business establishment/incorporation proof, tax payment proof, 3 months business bank statements.' },
  { code: 'BIRTHCERT',     category: 'Identity',  name: 'Birth Certificate',
    guidance: 'Government-issued and showing the parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'SUPPORTAFFIDAVIT', category: 'Financial', name: 'Support Affidavit',
    guidance: 'If the assets belong to immediate family members who will support this application, a notarized affidavit is required — we can share a template. We can ask for more documents to prove the ties to the home country.' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with photo, name, signature, date/place of birth, place of issue and address.' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country',
    guidance: 'Status documents in Canada: study permit, work permit, Canadian passport or PR card. Canadian citizens: include the original country passport as well.' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate (proves relationship)',
    guidance: 'Government-issued and showing the parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage/divorce/annulment certificates (each marriage if more than one); death certificate of former spouse/common-law partner; birth certificates of children — whichever apply.' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)',
    guidance: 'Any one of: driver’s licence (front and back), most recent credit card statement, or most recent utility bill (electricity/gas).' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Notice of Assessment for last year (mandatory for income eligibility) and 3 months bank statements with good funds. If salaried: job letter (start date, title, salary, hours, duties), at least 3 pay slips, T4. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets',
    guidance: 'Any funds, investments or assets that increase your net worth — disclose them with supporting documentation.' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Parents & Siblings',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded:   { label: 'A second parent is also applying' },
    siblingsIncluded: { label: 'One or more siblings are also applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Parent)', required: true, documents: PARENT_DOCUMENTS },
    { role: 'Spouse',             label: 'Second Parent',                includeWhen: { caseFlag: 'spouseIncluded' }, documents: PARENT_DOCUMENTS },
    { role: 'Sibling',            label: 'Sibling',                      includeWhen: { caseFlag: 'siblingsIncluded' }, multipleAllowed: true, documents: SIBLING_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (in Canada)',          required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
