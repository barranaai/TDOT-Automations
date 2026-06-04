/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Non-Express Entry/Document Checklist- Non-Express Entry- Non accompanying spouse.pdf
 */

'use strict';

module.exports = {
  "caseType": "Federal PR",
  "subType": "Non Express Entry - Non Accompanying Spouse",
  "schemaVersion": 1,
  "source": "Non-Express Entry/Document Checklist- Non-Express Entry- Non accompanying spouse.pdf",
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
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents- Front and Back both required",
          "category": "Identity"
        },
        {
          "code": "PROOFLANGUAGEPROFICIEN",
          "name": "Proof of language proficiency (IELTS- G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)",
          "category": "Other"
        },
        {
          "code": "MEDICALEXAM",
          "name": "Medical Exam",
          "category": "Medical"
        },
        {
          "code": "POLICECLEARANCECERTIFI",
          "name": "Police clearance certificates (PCC)",
          "category": "Background"
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
          "code": "SIBLINGPROOFLIVING",
          "name": "Sibling- Proof of living in Canada",
          "category": "Other"
        },
        {
          "code": "PROOFWORKEXPERIENCE",
          "name": "Proof of work experience for the claiming period (Inside and Outside Canada)",
          "category": "Other"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
        },
        {
          "code": "ONESAMENAME",
          "name": "One and same name affidavit if name /surname changed",
          "category": "Identity"
        },
        {
          "code": "PROOFLIVINGCANADA",
          "name": "Proof of living in Canada",
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
          "code": "DIGITALPHOTOSPECIFICAT-2",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        },
        {
          "code": "MEDICALEXAM-2",
          "name": "Medical Exam",
          "category": "Medical"
        },
        {
          "code": "POLICECLEARANCECERTIFI-2",
          "name": "Police clearance certificates (PCC)",
          "category": "Background"
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
