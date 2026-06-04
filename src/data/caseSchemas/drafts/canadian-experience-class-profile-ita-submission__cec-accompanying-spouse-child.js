/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: CEC/Document Checklist- CEC- Accompanying spouse and child.pdf
 */

'use strict';

module.exports = {
  "caseType": "Canadian Experience Class (Profile+ITA+Submission)",
  "subType": "CEC Accompanying Spouse & Child",
  "schemaVersion": 1,
  "source": "CEC/Document Checklist- CEC- Accompanying spouse and child.pdf",
  "generatedFromPdf": true,
  "reviewedBy": null,
  "reviewedAt": null,
  "caseFlags": {
    "childrenIncluded": {
      "label": "One or more dependent children are applying"
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
          "code": "FOREIGNE",
          "name": "Foreign E",
          "category": "Other"
        },
        {
          "code": "SIBLINGPROOFLIVING",
          "name": "Sibling- Proof of living in Canada- if applicable",
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
          "code": "ONESAMENAME",
          "name": "One and same name affidavit if name /surname changed",
          "category": "Identity"
        }
      ]
    },
    {
      "role": "DependentChild",
      "label": "Dependent Child",
      "includeWhen": {
        "caseFlag": "childrenIncluded"
      },
      "multipleAllowed": true,
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
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
        }
      ]
    }
  ]
};
