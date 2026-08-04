'use strict';
module.exports = {
  caseType: "AAIP",
  subType: "Tourism & Hospitality Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Tourism & Hospitality Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'A non-accompanying spouse is included in this application' },
    childrenIncluded: { label: 'One or more non-accompanying children are included in this application' }
  },
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits ever issued to you in Canada as a visitor, student or worker.' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Marriage certificate and final divorce/annulment certificates (from each marriage if more than one); common-law declaration IMM5409; death certificate of former spouse or common-law partner; birth certificates of children; legal name/date-of-birth change documents — whichever apply.' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic',
        guidance: 'Language test results must not be older than two years upon date of receipt. English tests must have CLB 7 or above in all language abilities; minimum of 4 for each English/French language skill.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic',
        guidance: 'Complete academic records and credentials: marksheets (detailed report card or official transcript showing the grades obtained in each subject for every year or semester of your program) and certificates issued by the institution verifying completion of the course, degree, diploma or other qualification.' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic',
        guidance: 'Complete marksheets and certificates plus an Educational Credential Assessment (ECA) report comparing your foreign education to Canadian standards, from a designated organization (CES, ICAS, ICES, IQAS or WES). More information: https://www.canada.ca/en/immigration-refugees-citizenship/corporate/partners-service-providers/immigrant-serving-organizations/best-practices/foreign-educational-credential-assessment.html.' },
      { code: 'RESUME', name: 'Resume', category: 'Other',
        guidance: 'Provide a detailed resume with a short written description of all your education, qualifications, and previous and current jobs.' },
      { code: 'LMIA', name: 'Labour Market Impact Assessment (if applicable)', category: 'Financial',
        guidance: 'If you have an approved LMIA, provide a complete scan of the approval letter received from ESDC.' },
      { code: 'EMPDECL', name: 'Employer Declaration and Authorization Form', category: 'Forms',
        guidance: 'The form must be complete, dated and signed by an authorized signing official of your Alberta employer to be accepted for processing. Download the form: https://cfr.forms.gov.ab.ca/Form/AINP13484.' },
      { code: 'WCB', name: 'Workers’ Compensation Board (WCB) document', category: 'Background',
        guidance: 'Provide a Clearance Letter from the Workers’ Compensation Board (WCB) Alberta for your employer, including an eligible WCB industry code or exempt activity as listed at https://www.alberta.ca/tourism-and-hospitality-stream-eligibility. Employers with WCB coverage can get the letter at https://www.wcb.ab.ca/insurance-and-premiums/clearance-letters/; employers in an exempt industry must ask WCB Employer Account Services to include their industry code in the clearance letter.' },
      { code: 'WORKEXP', name: 'Proof of work experience for your qualifying work experience', category: 'Financial',
        guidance: 'Your current employment in Alberta and Alberta job offer must all be for an eligible occupation. Provide all paystubs for the claiming experience OR bank statements showing salary deposits; T4; Notice of Assessment or any other tax payment proof (e.g. income tax returns); work contracts (optional). Also an employment/reference letter for all periods of qualifying work experience — printed on company letterhead with full contact details, signed by the responsible officer/supervisor (hand-signed, or electronic signatures closely matching the original or done through DocuSign; typed names are not acceptable), listing every position with job title, detailed duties, tenure, full-time or part-time status, weekly hours and current salary plus salary at the time of hiring (we can share a template).' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Financial',
        guidance: 'Must be less than six months old, printed on business letterhead with the business address, telephone/fax numbers, email and website; identify the responsible officer or supervisor with their signature; be stamped with the corporate seal if applicable; and be signed by you and your employer. It must include the job title, NOC code, wage, duties and responsibilities, hours per week, weeks of work per year, vacation days/weeks, workplace location and employment start date, and confirm a full-time position of indeterminate duration (no end date) with terms effective as of the date of nomination for current employees or upon obtaining a work permit for new hires.' },
      { code: 'SECTORMEMB', name: 'Sector association membership or Experience Provider status', category: 'Background',
        guidance: 'If qualifying through your employer’s sector association membership, contact the association for instructions and submit the required proof of membership. If applying based on your employer’s status as an Experience Provider, provide a printout of their business listing from the Travel Alberta website: https://www.travelalberta.com/experience-providers/all-experience-providers.' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits ever issued to you in Canada as a visitor, student or worker.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' }
    ] },
    { role: 'NonAccompanyingChild', label: 'Non-Accompanying Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits ever issued to you in Canada as a visitor, student or worker.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' }
    ] }
  ],
};
