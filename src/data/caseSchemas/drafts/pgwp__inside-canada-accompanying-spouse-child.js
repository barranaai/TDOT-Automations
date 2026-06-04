/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Work Permits/Document Checklist- PGWP- Accompanying spouse established relationship or child- Inside Canada.pdf
 */

'use strict';

module.exports = {
  "caseType": "PGWP",
  "subType": "Inside Canada - Accompanying Spouse/Child",
  "schemaVersion": 1,
  "source": "Work Permits/Document Checklist- PGWP- Accompanying spouse established relationship or child- Inside Canada.pdf",
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
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "CANADIANEDUCATIONDOCUM",
          "name": "Canadian Education Documents- (For each program)",
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
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income- Mandatory for the Principal Applicant",
          "category": "Financial"
        },
        {
          "code": "ADDITIONALPROOFFUNDS",
          "name": "Additional proof of Funds/investments/assets",
          "category": "Financial"
        },
        {
          "code": "PROOFCOHABITATION",
          "name": "Proof of cohabitation",
          "category": "Other"
        },
        {
          "code": "LANGUAGETESTREPORT",
          "name": "Language Test Report",
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
          "code": "PERMITSEVERHELD-2",
          "name": "All Permits ever held in Canada",
          "category": "Other"
        },
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
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
        }
      ]
    }
  ]
};
