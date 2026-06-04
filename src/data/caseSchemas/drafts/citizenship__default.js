/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Citizenship/Document Checklist- Citizenship- Accompanying spouse or child.pdf
 */

'use strict';

module.exports = {
  "caseType": "Citizenship",
  "subType": "",
  "schemaVersion": 1,
  "source": "Citizenship/Document Checklist- Citizenship- Accompanying spouse or child.pdf",
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
          "code": "PASSPORTPAGESTHAT",
          "name": "Passport with all pages. (that covers 5-year eligibility period)",
          "category": "Identity"
        },
        {
          "code": "PERSONALIDENTIFICATION",
          "name": "Personal Identification- Any 2 from the following",
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
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        },
        {
          "code": "LANGUAGETESTREPORT",
          "name": "Language Test Report (if you are 18 to 54 years of age)",
          "category": "Other"
        },
        {
          "code": "POLICECERTIFICATESPCC",
          "name": "Police certificates (PCC)",
          "category": "Background"
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
          "code": "PERSONALIDENTIFICATION-2",
          "name": "Personal Identification",
          "category": "Other"
        },
        {
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
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
