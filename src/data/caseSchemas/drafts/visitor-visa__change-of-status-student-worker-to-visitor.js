/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf
 */

'use strict';

module.exports = {
  "caseType": "Visitor Visa",
  "subType": "Change of Status (Student/Worker to Visitor)",
  "schemaVersion": 1,
  "source": "Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf",
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
          "code": "CURRENTSTATUSCOUNTRY",
          "name": "Current Status in the country",
          "category": "Other"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income",
          "category": "Financial"
        },
        {
          "code": "FINANCIALDOCUMENTSHIGH",
          "name": "Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request",
          "category": "Financial"
        },
        {
          "code": "PROOFLIVINGCANADA",
          "name": "Proof of living in Canada (any 1)",
          "category": "Other"
        }
      ]
    }
  ]
};
