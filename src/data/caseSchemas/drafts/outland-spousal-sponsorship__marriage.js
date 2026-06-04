/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf
 */

'use strict';

module.exports = {
  "caseType": "Outland Spousal Sponsorship",
  "subType": "Marriage",
  "schemaVersion": 1,
  "source": "Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf",
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
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
        },
        {
          "code": "GOVERNMENTISSUEDIDENTI",
          "name": "Government issued Identity documents",
          "category": "Identity"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        },
        {
          "code": "POLICECLEARANCECERTIFI",
          "name": "Police clearance certificates (PCC)",
          "category": "Background"
        },
        {
          "code": "LETTERSPRINTEDTEXT",
          "name": "Letters, Printed text messages, emails, social media conversations and phone records showing regular",
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
          "code": "PRCARDECOPR",
          "name": "PR Card or eCOPR",
          "category": "Other"
        },
        {
          "code": "NOTICEASSESSMENT",
          "name": "Notice of Assessment",
          "category": "Financial"
        },
        {
          "code": "EMPLOYMENTSOURCEINCOME",
          "name": "Employment/ Source of Income",
          "category": "Financial"
        },
        {
          "code": "PAYSTUBS",
          "name": "Paystubs",
          "category": "Financial"
        }
      ]
    }
  ]
};
