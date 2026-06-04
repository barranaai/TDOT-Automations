'use strict';
module.exports = {
  caseType: "Visitor Record / Extension",
  subType: "Visitor Extension",
  schemaVersion: 1,
  source: "Document Checklist Items/Visitor/Document Checklist- Visitor Record (extension).pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CURRENTSTATUS', name: 'Current Status in the country', category: 'Identity' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'INCOMEPROOF', name: 'Proof/source of Income (Back Home)', category: 'Financial' },
      { code: 'FINANCIALDOCS', name: 'Financial Documents (bank statements, investments, support affidavit)', category: 'Financial' },
      { code: 'ADDITIONALDOCS', name: 'Additional documents (Optional)', category: 'Other' }
    ] },
    { role: 'Sponsor', label: 'Inviter / Sponsor', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'CURRENTSTATUS', name: 'Current Status in the country', category: 'Identity' },
      { code: 'PROOFRELATIONSHIP', name: 'Proof of relationship', category: 'Relationship' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'PROOFLIVINGCANADA', name: 'Proof of living in Canada (any 1)', category: 'Identity' },
      { code: 'INCOMEPROOF', name: 'Proof/source of Income (If you will support the applicant)', category: 'Financial' },
      { code: 'ADDITIONALFUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial' }
    ] }
  ],
};
