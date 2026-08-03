'use strict';
module.exports = {
  caseType: "OINP",
  subType: "International Student Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- OINP- International Student Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'A non-accompanying spouse is included in this application' },
    childrenIncluded: { label: 'One or more non-accompanying children are included in this application' }
  },
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms',
        guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach every permit issued to you in Canada as a visitor, student or worker.' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity',
        guidance: 'Must meet IRCC permanent-resident photo specifications. More information: https://www.canada.ca/en/immigration-refugees-citizenship/services/new-immigrants/pr-card/apply-renew-replace/photo.html' },
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Marriage certificate; final divorce or annulment certificate (from each marriage if married more than once); common-law declaration IMM5409; death certificate of former spouse or common-law partner; birth certificate of children; legal documents showing name or date-of-birth changes — whichever apply.' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic',
        guidance: 'Test results must not be older than two years upon date of receipt.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'RESUME', name: 'Resume', category: 'Background',
        guidance: 'A detailed resume with a short written description of all your education, qualifications, and previous and current jobs.' },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic',
        guidance: 'Complete academic records and credentials: marksheets (official transcripts showing the grades obtained in each subject for every year or semester) and certificates verifying completion of each course, degree, diploma or other qualification.' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic',
        guidance: 'Marksheets and certificates for your complete academic history, plus an Educational Credential Assessment (ECA) report comparing your foreign education to Canadian standards — providers include CES, ICAS, ICES, IQAS and WES. More information: https://www.canada.ca/en/immigration-refugees-citizenship/corporate/partners-service-providers/immigrant-serving-organizations/best-practices/foreign-educational-credential-assessment.html' },
      { code: 'EMPLOYMENTPROOF', name: 'Current Employment Proof', category: 'Financial',
        guidance: 'Employment/reference letter on company letterhead — hand-signed (or DocuSign) by the responsible officer/supervisor, listing all positions held, duties, tenure, full/part-time status, weekly hours, and current salary plus salary at hiring (we can share a template). Also include all paystubs received so far, T4s received so far, and Notices of Assessment for the last 5 years.' },
      { code: 'LICENCE', name: 'Licence or authorization', category: 'Other',
        guidance: 'If your job offer is in an occupation that requires a mandatory licence or other authorization in Ontario, scan and upload a copy of your licence or other authorization.' },
      { code: 'INTENTONTARIO', name: 'Intention to Reside in Ontario', category: 'Other',
        guidance: 'Provide recent utility bills, a recent credit card statement and a lease agreement.' },
      { code: 'CVOR', name: 'Commercial Vehicle Operator’s Registration (CVOR) Certificate', category: 'Other',
        guidance: 'Required if your job offer is for NOC 73300 (transport truck drivers) or NOC 73301 (bus drivers, subway operators and other transit operators): upload a copy of your employer’s valid CVOR Certificate — a CVOR Abstract (Level 1) must be provided.' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Other',
        guidance: 'Must be less than six months old, on business letterhead with full contact details, signed by both you and the responsible officer/supervisor, and stamped with the corporate seal if applicable. Include the job title, wage, duties and responsibilities, hours per week, weeks of work per year, vacation, workplace location and start date. It must confirm a full-time position of indeterminate duration (no end date), with terms effective as of the date of nomination for current employees or upon obtaining a work permit for new hires.' },
      { code: 'EMPLOYERFORM', name: 'Application for Approval of an Employment Position (Employer Form)', category: 'Forms',
        guidance: 'For this stream you must include this form completed and signed by your employer (or signing officer) — we can share the form upon request. More information: https://forms.mgcs.gov.on.ca/dataset/009-0233. Please also review the OINP Employer Checklist for documents that may be requested on submission: https://www.ontario.ca/document/oinp-document-checklists/employer-job-offer-streams-employer-checklist' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', required: false, includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach every permit issued to you in Canada as a visitor, student or worker.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' }
    ] },
    { role: 'NonAccompanyingChild', label: 'Non-Accompanying Child', required: false, includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach every permit issued to you in Canada as a visitor, student or worker.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' }
    ] }
  ],
};
