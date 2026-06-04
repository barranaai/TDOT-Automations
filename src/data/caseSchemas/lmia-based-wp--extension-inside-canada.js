'use strict';
module.exports = {
  caseType: "LMIA Based WP",
  subType: "Extension (Inside Canada)",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- LMIA Based Work permit Extension- Single or accompanying spouse- Inside Canada.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'An accompanying dependent spouse/partner is applying' },
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
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents (name/DOB change, common law declaration imm5409, marriage/divorce/annulment certificates, death certificate of former spouse, birth certificate of children, if applicable)', category: 'Identity' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' },
      { code: 'EMPLOYMENTPROOF', name: 'Employment Proof - employment letter, job offer letter, pay stubs, T4, Notice of Assessment, last 3 months bank statement', category: 'Financial' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
    ] },
    { role: 'Spouse', label: 'Dependent Spouse', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents (name/DOB change, common law declaration imm5409, marriage/divorce/annulment certificates, death certificate of former spouse, birth certificate of children, if applicable)', category: 'Identity' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
    ] },
    { role: 'DependentChild', label: 'Dependent Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'BIRTHCERT', name: 'Birth Certificate (government-issued, showing parents name)', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
    ] },
  ],
};
