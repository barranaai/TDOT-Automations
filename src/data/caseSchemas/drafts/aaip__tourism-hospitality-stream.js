/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Tourism & Hospitality Stream.pdf
 */

'use strict';

module.exports = {
  "caseType": "AAIP",
  "subType": "Tourism & Hospitality Stream",
  "schemaVersion": 1,
  "source": "Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Tourism & Hospitality Stream.pdf",
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
          "code": "LABOURMARKETIMPACT",
          "name": "Labour Market Impact Assessment (if applicable)",
          "category": "Financial"
        },
        {
          "code": "EMPLOYERDECLARATIONAUT",
          "name": "Employer Declaration and Authorization Form",
          "category": "Financial"
        },
        {
          "code": "WORKERSCOMPENSATIONBOA",
          "name": "Workers’ Compensation Board (WCB) document",
          "category": "Other"
        },
        {
          "code": "PROOFWORKEXPERIENCE",
          "name": "Proof of work experience for your qualifying work experience. Please Note: Your current employment in Alberta and",
          "category": "Financial"
        },
        {
          "code": "JOBOFFERLETTER",
          "name": "Job Offer Letter",
          "category": "Other"
        },
        {
          "code": "SECTORASSOCIATIONMEMBE",
          "name": "Sector association membership or Experience Provider status",
          "category": "Other"
        }
      ]
    },
    {
      "role": "NonAccompanyingSpouse",
      "label": "Non-Accompanying Spouse",
      "required": true,
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
        }
      ]
    }
  ]
};
