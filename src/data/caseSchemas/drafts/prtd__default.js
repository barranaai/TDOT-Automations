/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: PR Card/Document Checklist- PRTD- Accompanying spouse or child.pdf
 */

'use strict';

module.exports = {
  "caseType": "PRTD",
  "subType": "",
  "schemaVersion": 1,
  "source": "PR Card/Document Checklist- PRTD- Accompanying spouse or child.pdf",
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
          "code": "PASSPORTPAGESLAST",
          "name": "Passport with all pages- (in the last 5 years)",
          "category": "Identity"
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
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        },
        {
          "code": "PROOFRESIDENCYCANADA",
          "name": "Proof of Residency in Canada (Any 4) - For the last 5 years or since becoming a PR",
          "category": "Other"
        },
        {
          "code": "URGENTTRAVELPROOF",
          "name": "Urgent Travel Proof (if applicable)",
          "category": "Other"
        },
        {
          "code": "STATUSIDENTIFICATION",
          "name": "Status Identification",
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
          "code": "PASSPORTSTAMPEDPAGES",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "STATUSIDENTIFICATION-2",
          "name": "Status Identification",
          "category": "Other"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT-2",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        }
      ]
    }
  ]
};
