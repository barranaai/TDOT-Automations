'use strict';
module.exports = {
  caseType: "SOWP",
  subType: "Outland (Spouse or Child)",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    childrenIncluded: { label: 'One or more dependent children are accompanying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
      { code: 'GOVTID', name: 'Government issued Identity documents', category: 'Identity' },
      { code: 'MARKSHEETS', name: 'All Marksheet and certificates', category: 'Academic' },
      { code: 'PCC', name: 'Police certificates (PCC)', category: 'Background' },
      { code: 'INCOME', name: 'Proof/source of Income', category: 'Financial' },
      { code: 'FINANCIALDOCS', name: 'Financial Documents', category: 'Financial' },
      { code: 'ADDLFUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial' },
    ] },
    { role: 'DependentChild', label: 'Dependent Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
      { code: 'STUDENTDOCS', name: 'If student (current grade marksheets, tuition fee receipt, enrollment letter, school ID, parents income proof)', category: 'Academic' },
    ] },
    { role: 'Sponsor', label: 'Worker Spouse', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Other' },
      { code: 'CANEDU', name: 'Canadian Education Documents (for each program if studied here)', category: 'Academic' },
      { code: 'INCOME', name: 'Proof/source of Income - Mandatory for Worker Spouse', category: 'Financial' },
      { code: 'RELATIONSHIP', name: 'Letters, printed text messages, emails, social media conversations and phone records showing regular contact', category: 'Relationship' },
    ] },
  ],
};
