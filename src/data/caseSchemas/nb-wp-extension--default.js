'use strict';
module.exports = {
  caseType: "NB WP Extension",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- Work Permit Extension (NB) - Single or accompanying spouse.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits issued to you in Canada as a visitor, student or worker.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications (see https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html).' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Common-law declaration IMM5409; marriage certificate and final divorce or annulment certificate (from each marriage and divorce if married more than once) — whichever apply.' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship',
        guidance: 'Driver’s licence (front and back); lease agreement; most recent credit card statement; most recent utility bill (electricity, gas).' },
      { code: 'INCOME', name: 'Proof/source of Income- Mandatory for Worker Spouse', category: 'Financial',
        guidance: 'Job letter from your current employer on company letterhead stating start date, job title, salary, hours worked and job duties — hand-signed, or electronic closely matching the original, or done through DocuSign (typed names are not acceptable); at least 3 pay slips; T4 issued by the employer; bank statement for the last 3 months with good funds.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
