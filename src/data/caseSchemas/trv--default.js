'use strict';
module.exports = {
  caseType: "TRV",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Visitor/Document Checklist- TRV.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All permits ever held in Canada', category: 'Background',
        guidance: 'Your status documents in the country, i.e. study permits, work permits and visitor records you have ever held.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' }
    ] }
  ],
};
