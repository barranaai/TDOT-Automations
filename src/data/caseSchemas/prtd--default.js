'use strict';
module.exports = {
  caseType: "PRTD",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/PR Card/Document Checklist- PRTD- Accompanying spouse or child.pdf",
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
      { code: 'PASSPORT', name: 'Passport with all pages- (in the last 5 years)', category: 'Identity' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'PROOFRESIDENCY', name: 'Proof of Residency in Canada (Any 4) - For the last 5 years or since becoming a PR', category: 'Other' },
      { code: 'URGENTTRAVEL', name: 'Urgent Travel Proof (if applicable)', category: 'Other' },
      { code: 'STATUSID', name: 'Status Identification', category: 'Identity' },
    ] },
    { role: 'DependentChild', label: 'Dependent Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'STATUSID', name: 'Status Identification', category: 'Identity' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
    ] },
  ],
};
