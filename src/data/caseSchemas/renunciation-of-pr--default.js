'use strict';
module.exports = {
  caseType: "Renunciation of PR",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/PR Card/Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    childrenIncluded: { label: 'One or more accompanying dependent children are applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    { role: 'PrincipalApplicant', label: 'Applicant and Dependent Spouse', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all pages', category: 'Identity' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'STATUSID', name: 'Status Identification (PR Card and COPR)', category: 'Identity' },
    ] },
    { role: 'DependentChild', label: 'Accompanying Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'STATUSID', name: 'Status Identification (PR Card, COPR, Birth Certificate)', category: 'Identity' },
      { code: 'ADOPTIONPROOF', name: 'Adoption/Guardianship Proof', category: 'Relationship' },
      { code: 'SOLECUSTODY', name: 'Sole custody Proof', category: 'Relationship' },
      { code: 'PHOTO', name: 'Photo as per specifications Permanent Residents', category: 'Identity' },
    ] },
  ],
};
