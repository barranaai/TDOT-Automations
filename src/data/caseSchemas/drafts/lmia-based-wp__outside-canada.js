/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada.pdf
 */

'use strict';

module.exports = {
  "caseType": "LMIA Based WP",
  "subType": "Outside Canada",
  "schemaVersion": 1,
  "source": "Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada.pdf",
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
          "name": "Police certificates (PCC)- We highly recommend it",
          "category": "Background"
        },
        {
          "code": "INTERNATIONALENGLISHLA",
          "name": "International English Language Testing System (IELTS) Test Report Form /CELPIP",
          "category": "Forms"
        },
        {
          "code": "UPDATEDRESUME",
          "name": "Updated Resume",
          "category": "Other"
        },
        {
          "code": "MARKSHEETCERTIFICATES",
          "name": "All Marksheet and certificates",
          "category": "Other"
        },
        {
          "code": "EDUCATIONALCREDENTIALA",
          "name": "Educational Credential Assessment – Service Providers",
          "category": "Financial"
        },
        {
          "code": "FINANCIALDOCUMENTSHIGH",
          "name": "Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request",
          "category": "Financial"
        },
        {
          "code": "PROOFWORKEXPERIENCE",
          "name": "Proof of work experience (for Principal Applicant)",
          "category": "Other"
        },
        {
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income (for Dependent Applicant)",
          "category": "Financial"
        },
        {
          "code": "RECOMMENDATIONLETTERSO",
          "name": "Recommendation Letters (only for Principal Applicant)- at least 3",
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
        },
        {
          "code": "UPFRONTMEDICALEXAMS-2",
          "name": "Upfront Medical exams",
          "category": "Medical"
        }
      ]
    }
  ]
};
