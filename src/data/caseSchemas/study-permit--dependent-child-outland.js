'use strict';
module.exports = {
  caseType: "Study Permit",
  subType: "Dependent Child (Outland)",
  schemaVersion: 1,
  source: "Document Checklist Items/Study Permit/Document Checklist- Study Permit for dependent child- Outland.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    parentsIncluded: { label: 'One or more parents are included on the application' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    {
      role: 'PrincipalApplicant',
      label: 'Principal Applicant (Dependent Child)',
      required: true,
      documents: [
        { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
        { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
        { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
        { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
        { code: 'GOVTID', name: 'Government issued Identity documents', category: 'Identity' },
        { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
        { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Relationship' },
        { code: 'PROOFSTATUS', name: 'Proof of status in the country', category: 'Other' },
        { code: 'ADDLFUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial' },
      ],
    },
    {
      role: 'Parent',
      label: 'Parent',
      includeWhen: { caseFlag: 'parentsIncluded' },
      multipleAllowed: true,
      documents: [
        { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
        { code: 'PERMITSHELD', name: 'All Permits ever held in Canada', category: 'Other' },
        { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
        { code: 'PROOFINCOME', name: 'Proof/source of Income - Mandatory for Worker Parent', category: 'Financial' },
      ],
    },
  ],
};
