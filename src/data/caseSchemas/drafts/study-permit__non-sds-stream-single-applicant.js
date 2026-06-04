/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf
 */

'use strict';

module.exports = {
  "caseType": "Study Permit",
  "subType": "Non SDS Stream - Single Applicant",
  "schemaVersion": 1,
  "source": "Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf",
  "generatedFromPdf": true,
  "reviewedBy": null,
  "reviewedAt": null,
  "caseFlags": {},
  "memberFlags": {
    "nameChanged": {
      "label": "Applicant’s name/surname differs across official documents"
    }
  },
  "roles": [
    {
      "role": "PrincipalApplicant",
      "label": "Principal Applicant",
      "required": true,
      "documents": [
        {
          "code": "PASSPORTSTAMPEDPAGES",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "ONESAMENAME",
          "name": "One and same name affidavit if name /surname changed",
          "category": "Identity"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "GOVERNMENTISSUEDIDENTI",
          "name": "Government issued Identity documents",
          "category": "Identity"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "UPFRONTMEDICALEXAMS",
          "name": "Upfront Medical exams – Check with us before booking your exam as some countries may not be eligible",
          "category": "Medical"
        },
        {
          "code": "RESUME",
          "name": "Resume",
          "category": "Other"
        },
        {
          "code": "MARKSHEETCERTIFICATES",
          "name": "All Marksheet and certificates",
          "category": "Other"
        },
        {
          "code": "RECOMMENDATIONLETTERS",
          "name": "Recommendation Letters",
          "category": "Other"
        },
        {
          "code": "PROOFADMISSION",
          "name": "Proof of Admission",
          "category": "Other"
        },
        {
          "code": "STATEMENTPURPOSE",
          "name": "Statement of Purpose",
          "category": "Other"
        },
        {
          "code": "PROOFWORKEXPERIENCE",
          "name": "Proof of work experience (we highly recommend)",
          "category": "Other"
        },
        {
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income",
          "category": "Financial"
        },
        {
          "code": "PROOFSOURCEINCOME-2",
          "name": "Proof/source of Income - Mandatory",
          "category": "Financial"
        }
      ]
    }
  ]
};
