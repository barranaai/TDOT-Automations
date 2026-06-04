/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Work Permits/Document Checklist- Open work permit (Worker Parent)- for child above 18 years of age.pdf
 */

'use strict';

module.exports = {
  "caseType": "SCLPC WP",
  "subType": "",
  "schemaVersion": 1,
  "source": "Work Permits/Document Checklist- Open work permit (Worker Parent)- for child above 18 years of age.pdf",
  "generatedFromPdf": true,
  "reviewedBy": null,
  "reviewedAt": null,
  "caseFlags": {
    "parentsIncluded": {
      "label": "One or more parents are applying"
    }
  },
  "memberFlags": {
    "nameChanged": {
      "label": "Applicant’s name/surname differs across official documents"
    }
  },
  "roles": [
    {
      "role": "Parent",
      "label": "Parent",
      "includeWhen": {
        "caseFlag": "parentsIncluded"
      },
      "multipleAllowed": true,
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
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income",
          "category": "Financial"
        }
      ]
    }
  ]
};
