'use strict';
module.exports = {
  caseType: "Concurrent WP",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- Concurrent Work permit- Single or accompanying spouse.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'Accompanying dependent spouse/partner is included in this application' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    {
      role: 'PrincipalApplicant',
      label: 'Principal Applicant',
      required: true,
      documents: [
        { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
        { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
        { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
        { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
        { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
        { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
        { code: 'EMPLOYMENT', name: 'Employment Proof (Mandatory documents)', category: 'Financial' },
        { code: 'EXPERIENCE', name: 'Experience Documents - all relevant experience documents from previous employers', category: 'Financial' },
        { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' },
        { code: 'IELTS', name: 'International English Language Testing System (IELTS) Test Report Form / CELPIP', category: 'Academic' },
        { code: 'RESUME', name: 'Resume', category: 'Other' },
        { code: 'MARKSHEETS', name: 'All Marksheet and certificates', category: 'Academic' },
      ],
    },
    {
      role: 'Spouse',
      label: 'Dependent Spouse',
      includeWhen: { caseFlag: 'spouseIncluded' },
      documents: [
        { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
        { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
        { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
        { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
        { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' },
      ],
    },
  ],
};
