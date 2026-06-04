/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Work Permits/Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland.pdf
 */

'use strict';

module.exports = {
  "caseType": "SOWP",
  "subType": "Outland (Spouse or Child)",
  "schemaVersion": 1,
  "source": "Work Permits/Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland.pdf",
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
          "code": "PERMITSEVERHELD",
          "name": "All Permits ever held in Canada",
          "category": "Other"
        },
        {
          "code": "CANADIANEDUCATIONDOCUM",
          "name": "Canadian Education Documents- (For each program if studied here)",
          "category": "Other"
        },
        {
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income- Mandatory for Worker Spouse",
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
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "UPFRONTMEDICALEXAMS",
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
