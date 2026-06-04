/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Provincial Nominee Programs/Ontario/Document Checklist- OINP- Human Capital Priorities Stream.pdf
 */

'use strict';

module.exports = {
  "caseType": "OINP",
  "subType": "Human Capital Priorities Stream",
  "schemaVersion": 1,
  "source": "Provincial Nominee Programs/Ontario/Document Checklist- OINP- Human Capital Priorities Stream.pdf",
  "generatedFromPdf": true,
  "reviewedBy": null,
  "reviewedAt": null,
  "caseFlags": {
    "spouseIncluded": {
      "label": "The applicant’s spouse is also applying"
    }
  },
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
          "code": "PERMITSEVERHELD",
          "name": "All Permits ever held in Canada",
          "category": "Other"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "PROOFLANGUAGEPROFICIEN",
          "name": "Proof of language proficiency (IELTS- G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)",
          "category": "Other"
        },
        {
          "code": "ONESAMENAME",
          "name": "One and same name affidavit if name /surname changed",
          "category": "Identity"
        },
        {
          "code": "RESUME",
          "name": "Resume",
          "category": "Other"
        },
        {
          "code": "CANADIANEDUCATIONDOCUM",
          "name": "Canadian Education Documents",
          "category": "Other"
        },
        {
          "code": "FOREIGNEDUCATIONDOCUME",
          "name": "Foreign Education Documents along with Educational Credential Assessment",
          "category": "Financial"
        },
        {
          "code": "JOBOFFERLETTER",
          "name": "Job Offer Letter",
          "category": "Other"
        },
        {
          "code": "CURRENTEMPLOYMENTPROOF",
          "name": "Current Employment Proof",
          "category": "Financial"
        },
        {
          "code": "LICENCEAUTHORIZATION",
          "name": "Licence or authorization",
          "category": "Other"
        },
        {
          "code": "PROOFWORKEXPERIENCE",
          "name": "Proof of work experience (Inside and Outside Canada)",
          "category": "Other"
        },
        {
          "code": "INTENTIONRESIDEONTARIO",
          "name": "Intention to Reside in Ontario",
          "category": "Other"
        },
        {
          "code": "SETTLEMENTFUNDSPLEASE",
          "name": "Settlement Funds – (Please confirm with us in advance)",
          "category": "Financial"
        },
        {
          "code": "DOCUMENTSRELATIVESCANA",
          "name": "Documents for relatives in Canada",
          "category": "Other"
        }
      ]
    },
    {
      "role": "Spouse",
      "label": "Spouse / Common-Law Partner",
      "includeWhen": {
        "caseFlag": "spouseIncluded"
      },
      "documents": [
        {
          "code": "PASSPORTSTAMPEDPAGES-2",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "PERMITSEVERHELD-2",
          "name": "All Permits ever held in Canada",
          "category": "Other"
        },
        {
          "code": "ONESAMENAME-2",
          "name": "One and same name affidavit if name /surname changed",
          "category": "Identity"
        },
        {
          "code": "CANADIANEDUCATIONDOCUM-2",
          "name": "Canadian Education Documents",
          "category": "Other"
        },
        {
          "code": "PROOFLANGUAGEPROFICIEN-2",
          "name": "Proof of language proficiency (IELTS- G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)",
          "category": "Other"
        },
        {
          "code": "PROOFWORKEXPERIENCE-2",
          "name": "Proof of work experience (Inside Canada)",
          "category": "Other"
        }
      ]
    }
  ]
};
