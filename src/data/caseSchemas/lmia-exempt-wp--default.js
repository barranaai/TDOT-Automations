'use strict';
module.exports = {
  caseType: "LMIA Exempt WP",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- LMIA exempt Work permit- Single or accompanying spouse.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    childrenIncluded: { label: 'One or more dependent children are applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'GOVTID', name: 'Government issued Identity documents', category: 'Identity' },
      { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
      { code: 'PCC', name: 'Police certificates (PCC)', category: 'Background' },
      { code: 'IELTS', name: 'International English Language Testing System (IELTS) Test Report Form / CELPIP', category: 'Academic' },
      { code: 'RESUME', name: 'Updated Resume', category: 'Other' },
      { code: 'MARKSHEETS', name: 'All Marksheet and certificates', category: 'Academic' },
      { code: 'ECA', name: 'Educational Credential Assessment – Service Providers', category: 'Academic' },
      { code: 'FINANCIAL', name: 'Financial Documents', category: 'Financial' },
      { code: 'WORKEXP', name: 'Proof of work experience (for Principal Applicant)', category: 'Other' },
      { code: 'INCOME', name: 'Proof/source of Income (for Dependent Applicant)', category: 'Financial' },
      { code: 'RECLETTERS', name: 'Recommendation Letters (only for Principal Applicant)', category: 'Other' },
    ] },
    { role: 'DependentChild', label: 'Dependent Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
      { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
    ] },
  ],
};
