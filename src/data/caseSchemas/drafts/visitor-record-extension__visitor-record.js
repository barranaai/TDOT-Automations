/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Visitor/Document Checklist- Visitor Record (extension).pdf
 */

'use strict';

module.exports = {
  "caseType": "Visitor Record / Extension",
  "subType": "Visitor Record",
  "schemaVersion": 1,
  "source": "Visitor/Document Checklist- Visitor Record (extension).pdf",
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
          "name": "Proof/source of Income (Back Home)",
          "category": "Financial"
        },
        {
          "code": "FINANCIALDOCUMENTSHIGH",
          "name": "Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request",
          "category": "Financial"
        },
        {
          "code": "ADDITIONALDOCUMENTSOPT",
          "name": "Additional documents (Optional)",
          "category": "Other"
        }
      ]
    },
    {
      "role": "Sponsor",
      "label": "Sponsor / Inviter",
      "required": true,
      "documents": [
        {
          "code": "PASSPORTSTAMPEDPAGES-2",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "CURRENTSTATUSCOUNTRY-2",
          "name": "Current Status in the country",
          "category": "Other"
        },
        {
          "code": "PROOFRELATIONSHIP",
          "name": "Proof of relationship",
          "category": "Other"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS-2",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "PROOFLIVINGCANADA",
          "name": "Proof of living in Canada (any 1)",
          "category": "Other"
        },
        {
          "code": "PROOFSOURCEINCOME-2",
          "name": "Proof/source of Income (If you will support the applicant)",
          "category": "Financial"
        },
        {
          "code": "ADDITIONALPROOFFUNDS",
          "name": "Additional proof of Funds/investments/assets",
          "category": "Financial"
        }
      ]
    }
  ]
};
