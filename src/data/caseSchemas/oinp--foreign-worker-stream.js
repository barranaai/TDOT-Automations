'use strict';
module.exports = {
  caseType: "OINP",
  subType: "Foreign Worker Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- OINP- Foreign Worker Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'A non-accompanying spouse is included in the application' },
    childrenIncluded: { label: 'One or more non-accompanying children are included in the application' }
  },
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'RESUME', name: 'Resume', category: 'Other' },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Financial' },
      { code: 'EMPPROOF', name: 'Current Employment Proof', category: 'Financial' },
      { code: 'LICENCE', name: 'Licence or authorization', category: 'Other' },
      { code: 'WORKEXP', name: 'Proof of work experience (Inside and Outside Canada)', category: 'Financial' },
      { code: 'INTENTONT', name: 'Intention to Reside in Ontario', category: 'Other' },
      { code: 'CVOR', name: 'Commercial Vehicle Operator’s Registration (CVOR) Certificate', category: 'Other' },
      { code: 'EMPLOYERFORM', name: 'Application for Approval of an Employment Position (Employer Form)', category: 'Forms' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', required: false, includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] },
    { role: 'NonAccompanyingChild', label: 'Non-Accompanying Child', required: false, includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
