'use strict';
module.exports = {
  caseType: "Study Permit",
  subType: "Change of Status (Visitor to Student)",
  schemaVersion: 1,
  source: "Document Checklist Items/Study Permit/Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    supporterIncluded: { label: 'A supporting family member is providing funds for this application' },
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
        { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
        { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
        { code: 'GOVTID', name: 'Government issued Identity documents', category: 'Identity' },
        { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
        { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
        { code: 'PCC', name: 'Police certificates (PCC) - Highly Recommended', category: 'Background' },
        { code: 'ENGTEST', name: 'English Language Test Report', category: 'Academic' },
        { code: 'RESUME', name: 'Resume', category: 'Other' },
        { code: 'MARKSHEETS', name: 'All Marksheet and certificates', category: 'Academic' },
        { code: 'RECOMMENDATION', name: 'Recommendation Letters', category: 'Academic' },
        { code: 'ADMISSION', name: 'Proof of Admission', category: 'Academic' },
        { code: 'SOP', name: 'Statement of Purpose', category: 'Academic' },
        { code: 'WORKEXP', name: 'Proof of work experience', category: 'Background' },
      ],
    },
    {
      role: 'Sponsor',
      label: 'Supporting Family Member (funds)',
      includeWhen: { caseFlag: 'supporterIncluded' },
      documents: [
        { code: 'GOVTID', name: 'Government issued Identity documents', category: 'Identity' },
        { code: 'INCOME', name: 'Proof/source of Income', category: 'Financial' },
        { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
        { code: 'INCOMEMANDATORY', name: 'Proof/source of Income - Mandatory', category: 'Financial' },
      ],
    },
  ],
};
