/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Provincial Nominee Programs/British Columbia/Document Checklist-BC PNP.pdf
 */

'use strict';

module.exports = {
  "caseType": "BCPNP",
  "subType": "BC PNP+ Company Info",
  "schemaVersion": 1,
  "source": "Provincial Nominee Programs/British Columbia/Document Checklist-BC PNP.pdf",
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
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents",
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
          "code": "RESUME",
          "name": "Resume",
          "category": "Other"
        },
        {
          "code": "PROOFWORKEXPERIENCE",
          "name": "Proof of work experience for your qualifying work experience",
          "category": "Other"
        },
        {
          "code": "JOBOFFERLETTER",
          "name": "Job Offer Letter",
          "category": "Other"
        },
        {
          "code": "INTENTIONRESIDEBC",
          "name": "Intention to Reside in BC",
          "category": "Other"
        },
        {
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
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
          "code": "BIRTHCERTIFICATE-2",
          "name": "Birth Certificate",
          "category": "Identity"
        }
      ]
    }
  ]
};
