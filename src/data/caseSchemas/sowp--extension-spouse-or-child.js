'use strict';
module.exports = {
  caseType: "SOWP",
  subType: "Extension (Spouse or Child)",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- SOWP Extension (Worker Spouse)- spouse or child.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    childrenIncluded: { label: 'One or more accompanying children are applying' },
  },
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Worker Spouse)', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'EDUDOCS', name: 'Canadian Education Documents- (For each program if studied here)', category: 'Academic' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'INCOME', name: 'Proof/source of Income- Mandatory for Worker Spouse', category: 'Financial' },
      { code: 'FUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' }
    ] },
    { role: 'DependentChild', label: 'Accompanying Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' }
    ] }
  ],
};
