/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Study Permit/Document Checklist- Study Permit- SDS Stream- Accompanying spouse or child.pdf
 */

'use strict';

module.exports = {
  "caseType": "Study Permit",
  "subType": "SDS Stream - Accompanying Spouse/Child",
  "schemaVersion": 1,
  "source": "Study Permit/Document Checklist- Study Permit- SDS Stream- Accompanying spouse or child.pdf",
  "generatedFromPdf": true,
  "reviewedBy": null,
  "reviewedAt": null,
  "caseFlags": {
    "spouseIncluded": {
      "label": "The applicant’s spouse is also applying"
    },
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
      "role": "Spouse",
      "label": "Spouse / Common-Law Partner",
      "includeWhen": {
        "caseFlag": "spouseIncluded"
      },
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
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income - Mandatory",
          "category": "Financial"
        },
        {
          "code": "GOVERNMENTISSUEDIDENTI",
          "name": "Government issued Identity documents",
          "category": "Identity"
        },
        {
          "code": "UPFRONTMEDICALEXAMS",
          "name": "Upfront Medical exams",
          "category": "Medical"
        },
        {
          "code": "POLICECERTIFICATESPCC",
          "name": "Police certificates (PCC)- Highly recommend",
          "category": "Background"
        },
        {
          "code": "PROOFSOURCEINCOME-2",
          "name": "Proof/source of Income Higher the funds, higher the chances of approval. We can provide a template upon request",
          "category": "Financial"
        },
        {
          "code": "ADDITIONALPROOFFUNDS",
          "name": "Additional proof of Funds/investments/assets",
          "category": "Financial"
        },
        {
          "code": "LETTERSPRINTEDTEXT",
          "name": "Letters, Printed text messages, emails, social media conversations and phone records showing regular",
          "category": "Other"
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
          "code": "DIGITALPHOTOSPECIFICAT-2",
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "UPFRONTMEDICALEXAMS-2",
          "name": "Upfront Medical exams",
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
