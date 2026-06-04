/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: PR Card/Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child.pdf
 */

'use strict';

module.exports = {
  "caseType": "Renunciation of PR",
  "subType": "",
  "schemaVersion": 1,
  "source": "PR Card/Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child.pdf",
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
          "code": "PASSPORTPAGES",
          "name": "Passport with all pages",
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
          "code": "ADOPTIONGUARDIANSHIPPR",
          "name": "Adoption/Guardianship Proof",
          "category": "Other"
        },
        {
          "code": "SOLECUSTODYPROOF",
          "name": "Sole custody Proof",
          "category": "Other"
        },
        {
          "code": "PHOTOSPECIFICATIONSPER",
          "name": "Photo as per specifications Permanent Residents",
          "category": "Identity"
        }
      ]
    }
  ]
};
