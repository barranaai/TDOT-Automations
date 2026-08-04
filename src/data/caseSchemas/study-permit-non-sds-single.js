/**
 * Case Structure Schema — Study Permit / Non SDS Stream - Single Applicant.
 *
 * Source: Document Checklist Items/Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf
 *
 * Same as the SDS base Study Permit MINUS three SDS-only docs on the student:
 * Police certificates (PCC), English Language Test, and GIC. Supporting Family
 * Member list is identical to the SDS base.
 */

'use strict';

const STUDENT_DOCUMENTS = [
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC photo specifications for temporary residents — more information: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Any document issued by your government that has your full name, date of birth, photograph and signature.' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; birth certificates of children; marriage affidavit with couple picture if no marriage certificate — whichever apply.' },
  { code: 'UPFRONTMEDICAL', category: 'Medical',  name: 'Upfront Medical exams',
    guidance: 'Check with us before booking your exam — some countries may not be eligible for an upfront medical exam. Only IRCC-approved Panel Physicians can do this exam (find one: https://secure.cic.gc.ca/PanelPhysicianMedecinDesigne/en/Home); do it upfront so you don’t need a letter from IRCC asking for it.' },
  { code: 'RESUME',        category: 'Forms',     name: 'Resume',
    guidance: 'A detailed resume with a short written description of all your education, qualifications, and previous and current jobs.' },
  { code: 'MARKSHEETS',    category: 'Academic',  name: 'All Marksheets and certificates',
    guidance: 'Marksheets (report cards or official transcripts showing grades for every year/semester); certificates verifying completion of each course, degree or diploma; completion letter/passing certificate issued by the institution stating you completed the course.' },
  { code: 'RECOMMENDATION', category: 'Academic', name: 'Recommendation Letters',
    guidance: 'Should briefly introduce the recommender, their relationship with you and how long they’ve known you, highlight your academic strengths and personal qualities like leadership and teamwork, and give specific examples of your achievements or contributions.' },
  { code: 'ADMISSION',     category: 'Academic',  name: 'Proof of Admission (LOA, fee receipt, PAL/TAL)',
    guidance: 'Unconditional Letter of Acceptance (LOA); official fee receipt confirming one year’s tuition and fees are fully paid; Provincial/Territorial Attestation Letter (PAL/TAL) confirming your institution and program meet local regulations. More information: https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit/get-documents/provincial-attestation-letter.html' },
  { code: 'SOP',           category: 'Forms',     name: 'Statement of Purpose',
    guidance: 'A written statement explaining your motivation for choosing this specific program, how it aligns with your academic and career goals, and why you wish to pursue it in the selected country and institution. We encourage you to provide us with a draft of your SOP to better understand your perspective.' },
  { code: 'WORKEXP',       category: 'Financial', name: 'Proof of work experience (highly recommended)',
    guidance: 'All pay slips for the claimed experience; Statement of Remuneration Paid (T4) or Form 16; tax payment proof in that country (e.g. income tax returns); employment/reference letter stating start date, job title, salary, hours and duties, hand-signed by the employer on company letterhead — we can share a template.' },
];

const SUPPORTER_DOCUMENTS = [
  { code: 'GOVTID',  category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'If inside Canada: passport, PR card/work permit/study permit, birth certificate. If outside Canada: passport, Aadhaar card, PAN card — or any other government-issued document showing full name, date of birth, photograph and signature.' },
  { code: 'INCOME',  category: 'Financial', name: 'Proof/source of Income',
    guidance: 'If salaried: job letter from the current employer (start date, title, salary, hours, duties — hand-signed on company letterhead), at least 3 pay slips, T4/Form 16, and Notice of Assessment or other tax payment proof. If self-employed: business establishment proof/incorporation certificate, District/Tehsil income certificate, tax payment proof, at least 6 months business bank statements, and documents proving the business is legal and genuine. If pensioner: pension confirmation document and the bank statement where the pension is credited.' },
  { code: 'IACD',    category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; marriage affidavit with couple picture if no marriage certificate — whichever apply.' },
  { code: 'FUNDS',   category: 'Financial', name: 'Proof/source of Income — funds/assets (mandatory)',
    guidance: 'At least 6 months bank statements without suddenly deposited funds, from every account with good funds; investment proof showing the investment is in your name; most recent property and/or gold evaluation reports; a net-worth certificate/CA report on the Chartered Accountant’s letterhead reconciling those values; and a notarized support affidavit if the assets belong to immediate family members supporting you — we can share a template.' },
];

module.exports = {
  caseType:      'Study Permit',
  subType:       'Single Applicant',
  schemaVersion: 1,
  source:        'Document Checklist Items/Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    supporterIncluded: { label: 'A supporting family member is funding the application' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Student)',    required: true, documents: STUDENT_DOCUMENTS },
    { role: 'Sponsor',            label: 'Supporting Family Member (funds)', includeWhen: { caseFlag: 'supporterIncluded' }, documents: SUPPORTER_DOCUMENTS },
  ],
};
