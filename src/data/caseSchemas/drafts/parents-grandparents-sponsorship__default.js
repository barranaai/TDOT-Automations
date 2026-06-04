/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf
 */

'use strict';

module.exports = {
  "caseType": "Parents/Grandparents Sponsorship",
  "subType": "",
  "schemaVersion": 1,
  "source": "Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf",
  "generatedFromPdf": true,
  "reviewedBy": null,
  "reviewedAt": null,
  "caseFlags": {
    "spouseIncluded": {
      "label": "The applicant’s spouse is also applying"
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
          "code": "GOVERNMENTISSUEDIDENTI",
          "name": "Government issued Identity documents",
          "category": "Identity"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications Permanent Residents",
          "category": "Identity"
        },
        {
          "code": "RESUMECURRICULUMVITAE",
          "name": "Resume/Curriculum Vitae (CV)",
          "category": "Other"
        },
        {
          "code": "DETAILSGOVERNMENTEMPLO",
          "name": "Details of government employment, police service, military experience",
          "category": "Financial"
        },
        {
          "code": "POLICECERTIFICATESPCC",
          "name": "Police certificates (PCC)- Highly recommended",
          "category": "Background"
        },
        {
          "code": "MEDICALEXAMPERMANENT",
          "name": "Medical exam for permanent residence applicants",
          "category": "Medical"
        }
      ]
    },
    {
      "role": "Sponsor",
      "label": "Sponsor / Inviter",
      "required": true,
      "documents": [
        {
          "code": "PASSPORTSTAMPEDPAGES",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "PROOFSTATUSCOUNTRY",
          "name": "Proof of status in the country",
          "category": "Other"
        },
        {
          "code": "BIRTHCERTIFICATEGRADE",
          "name": "Birth Certificate or Grade 10-12 marksheets",
          "category": "Identity"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS-2",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "NOTICEASSESSMENT",
          "name": "Notice of Assessment",
          "category": "Financial"
        }
      ]
    }
  ]
};
