/**
 * Case Structure Schema — Visitor Visa / 1-3 Members.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf
 *
 * Same as Visitor Visa/1-2 Members (PA + optional Spouse + required Inviter)
 * PLUS a Dependent Child role (PDF pp.3-4), conditional and multiple-allowed.
 *
 * Team-review note: Inviter marked required (standard PDF section). Child's
 * "if student" academics row is included as one row — client uploads if it
 * applies.
 */

'use strict';

const PA_SPOUSE_DOCUMENTS = [
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

const CHILD_DOCUMENTS = [
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC temporary-resident photo specifications (see canada.ca photo specifications page).' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Aadhar card, or any other government-issued document showing your full name, date of birth, photograph and signature.' },
  { code: 'STUDENTDOCS',   category: 'Other',     name: 'If student: academic documents (marksheets, enrolment letter, school ID)',
    guidance: 'Current grade marksheets; a letter from the school/college confirming current enrolment with program start and end dates; school/college identity card; plus supporting proof-of-income documents from the parents based on their current employment status.' },
  { code: 'BIRTHCERT',     category: 'Identity',  name: 'Birth Certificate',
    guidance: 'Government-issued and showing the parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'SUPPORTAFFIDAVIT', category: 'Financial', name: 'Support Affidavit',
    guidance: 'If the assets belong to immediate family members who will support this application, a notarized affidavit along with the financial documents is required — we can share a template.' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with photo, name, signature, date/place of birth, place of issue and address.' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country',
    guidance: 'Status documents in Canada: study permit, work permit, Canadian passport or PR card. Canadian citizens: include the original country passport as well.' },
  { code: 'RELPROOF',  category: 'Other',     name: 'Proof of Relationship',
    guidance: 'Your case manager will advise which documents can be used to prove the relationship.' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage/divorce/annulment certificates (each marriage if more than one); birth certificates of children — whichever apply.' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)',
    guidance: 'Any one of: driver’s licence (front and back), most recent credit card statement, most recent utility bill (electricity/gas), or provincial ID card.' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Notice of Assessment for last year (mandatory for income eligibility) and 3 months bank statements with good funds. If salaried: signed job letter on letterhead, 3 pay slips, T4 or other tax proof. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets',
    guidance: 'Any funds, investments or assets that increase your net worth — disclose them with supporting documentation.' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       '1-3 Members',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded:   { label: 'A dependent spouse is also applying' },
    childrenIncluded: { label: 'One or more dependent children are applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant',  required: true, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Spouse',     includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'DependentChild',     label: 'Dependent Child',      includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: CHILD_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (in Canada)',  required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
