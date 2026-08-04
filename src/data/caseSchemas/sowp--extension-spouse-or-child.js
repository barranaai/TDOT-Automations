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
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits ever issued to you in Canada as a visitor, student or worker.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
      { code: 'EDUDOCS', name: 'Canadian Education Documents- (For each program if studied here)', category: 'Academic',
        guidance: 'Official marksheet or transcript showing the grades obtained in each subject for every year or semester of the program, plus degree certificates from the institution verifying completion of the course, degree, diploma or other qualifications.' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Legal name or date-of-birth change documents; common-law declaration IMM5409; marriage certificate, final divorce or annulment certificate (from each marriage if more than one); death certificate of former spouse or common-law partner; birth certificates of children — whichever apply.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'INCOME', name: 'Proof/source of Income- Mandatory for Worker Spouse', category: 'Financial',
        guidance: 'Job letter from your current employer on company letterhead stating start date, job title, salary, hours worked and job duties — hand-signed, or electronic closely matching the original, or done through DocuSign (typed names are not acceptable); at least 3 pay slips; T4 issued by the employer; bank statement for the last 3 months with good funds.' },
      { code: 'FUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial',
        guidance: 'Any funds, investments or assets that increase your net worth — disclose them with supporting documentation.' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship',
        guidance: 'Driver’s licence (front and back); lease agreement; most recent credit card statement; most recent utility bill (electricity, gas).' }
    ] },
    { role: 'DependentChild', label: 'Accompanying Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits ever issued to you in Canada as a visitor, student or worker.' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity',
        guidance: 'Issued by the government and showing the parents’ names.' }
    ] }
  ],
};
