'use strict';
module.exports = {
  caseType: "OINP",
  subType: "PhD Graduate Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- OINP- PhD Graduate Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'Applicant has a non-accompanying spouse' },
    childrenIncluded: { label: 'Applicant has one or more non-accompanying children' },
  },
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms',
        guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'All permits issued to you in Canada as a visitor, student or worker.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity',
        guidance: 'Must meet IRCC photo specifications for permanent residents — more information: https://www.canada.ca/en/immigration-refugees-citizenship/services/new-immigrants/pr-card/apply-renew-replace/photo.html' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); common-law declaration IMM5409; death certificate of former spouse/common-law partner; birth certificates of children; legal name/date-of-birth change documents — whichever apply.' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic',
        guidance: 'Test results must not be older than two years upon date of receipt. English tests must have CLB 7 or above in all language abilities.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'CDNEDU', name: 'Canadian Education Documents', category: 'Academic',
        guidance: 'Complete academic records: marksheets (report cards or official transcripts showing grades for every year/semester) and certificates verifying completion of each course, degree or diploma.' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic',
        guidance: 'Marksheets and completion certificates for all foreign studies, plus an Educational Credential Assessment (ECA) report from CES, ICAS, ICES, IQAS or WES comparing your education to Canadian standards. More information: https://www.canada.ca/en/immigration-refugees-citizenship/corporate/partners-service-providers/immigrant-serving-organizations/best-practices/foreign-educational-credential-assessment.html' },
      { code: 'RESUME', name: 'Resume', category: 'Other',
        guidance: 'A detailed resume with a short written description of all your education, qualifications, and previous and current jobs.' },
      { code: 'EMPLOYMENT', name: 'Current Employment Proof (reference letter, paystubs, T4, NOA last 5 years)', category: 'Financial',
        guidance: 'Employment/reference letter on company letterhead with the company’s contact details and the signer’s name and title, hand-signed (typed names are not acceptable), listing all positions held with duties, tenure, full/part-time status, weekly hours, and current salary plus salary at hiring — we can share a template. Also include all paystubs and T4s received so far and NOAs for the last 5 years.' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Other',
        guidance: 'Must be less than six months old, printed on business letterhead with full contact details, identify and be signed by the responsible officer (stamped with the corporate seal if applicable), and be signed by both you and your employer. It must include job title, wage, duties, hours per week, weeks of work per year, vacation, workplace location and start date, and confirm a full-time position of indeterminate duration (no end date) with terms effective as of nomination for current employees or upon obtaining a work permit for new hires.' },
      { code: 'SETTLEMENT', name: 'Settlement Funds (Please confirm with us in advance)', category: 'Financial',
        guidance: 'Recent bank statements (last 3 months) showing your name, financial institution, account number and balance. If using your spouse’s or common-law partner’s account, include their statements plus a letter granting you access to the funds; investment statements need a letter from the financial institution confirming availability and redeemable value. More information: https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/documents/proof-funds.html' },
      { code: 'INTENTRESIDE', name: 'Intention to Reside in Ontario', category: 'Other',
        guidance: 'Recent utility bills; recent credit card statement; lease agreement.' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'All permits issued to you in Canada as a visitor, student or worker.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' }
    ] },
    { role: 'NonAccompanyingChild', label: 'Non-Accompanying Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'All permits issued to you in Canada as a visitor, student or worker.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' }
    ] }
  ],
};
