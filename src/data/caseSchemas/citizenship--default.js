'use strict';
module.exports = {
  caseType: "Citizenship",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Citizenship/Document Checklist- Citizenship- Accompanying spouse or child.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    childrenIncluded: { label: 'One or more accompanying children are applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (and dependent spouse)', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all pages (that covers 5-year eligibility period)', category: 'Identity' },
      { code: 'PERSONALID', name: 'Personal Identification - any 2 from the listed options', category: 'Identity' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Relationship' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PHOTO', name: 'Digital photo as per Permanent Resident specifications', category: 'Identity' },
      { code: 'LANGTEST', name: 'Language Test Report (if you are 18 to 54 years of age)', category: 'Academic' },
      { code: 'PCC', name: 'Police certificates (PCC)', category: 'Background' },
    ] },
    { role: 'DependentChild', label: 'Accompanying Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERSONALID', name: 'Personal Identification', category: 'Identity' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per Permanent Resident specifications', category: 'Identity' },
    ] },
  ],
};
