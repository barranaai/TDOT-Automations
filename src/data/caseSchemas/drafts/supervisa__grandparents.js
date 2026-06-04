/**
 * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.
 *
 * ⚠️  Do not register/activate until a human verifies this against the PDF:
 *     - required vs conditional roles (esp. Sponsor / Worker Spouse)
 *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)
 *     - document categories (keyword-inferred) and codes
 *
 * Source: Supervisa/Document Checklist- Supervisa- GrandParents.pdf
 */

'use strict';

module.exports = {
  "caseType": "Supervisa",
  "subType": "Grandparents",
  "schemaVersion": 1,
  "source": "Supervisa/Document Checklist- Supervisa- GrandParents.pdf",
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
          "code": "DIGITALPHOTOSPECIFICAT",
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "UPFRONTMEDICAL",
          "name": "Upfront Medical",
          "category": "Medical"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "GOVERNMENTISSUEDIDENTI",
          "name": "Government issued Identity documents",
          "category": "Identity"
        },
        {
          "code": "PROOFSOURCEINCOME",
          "name": "Proof/source of Income",
          "category": "Financial"
        },
        {
          "code": "FINANCIALDOCUMENTSHIGH",
          "name": "Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request",
          "category": "Financial"
        },
        {
          "code": "HEALTHINSURANCE",
          "name": "Health Insurance",
          "category": "Insurance"
        },
        {
          "code": "SUPPORTAFFIDAVIT",
          "name": "Support Affidavit",
          "category": "Other"
        },
        {
          "code": "DETAILSGOVERNMENTEMPLO",
          "name": "Details of government employment, police service, military experience",
          "category": "Financial"
        }
      ]
    },
    {
      "role": "Spouse",
      "label": "Spouse / Common-Law Partner",
      "includeWhen": {
        "caseFlag": "spouseIncluded"
      },
      "documents": [
        {
          "code": "PASSPORTSTAMPEDPAGES-2",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "ONESAMENAME-2",
          "name": "One and same name affidavit if name /surname changed",
          "category": "Identity"
        },
        {
          "code": "DIGITALPHOTOSPECIFICAT-2",
          "name": "Digital photo as per specifications of Temporary Residents",
          "category": "Identity"
        },
        {
          "code": "UPFRONTMEDICAL-2",
          "name": "Upfront Medical",
          "category": "Medical"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS-2",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "GOVERNMENTISSUEDIDENTI-2",
          "name": "Government issued Identity documents",
          "category": "Identity"
        },
        {
          "code": "PROOFSOURCEINCOME-2",
          "name": "Proof/source of Income",
          "category": "Financial"
        },
        {
          "code": "FINANCIALDOCUMENTSHIGH-2",
          "name": "Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request",
          "category": "Financial"
        },
        {
          "code": "HEALTHINSURANCE-2",
          "name": "Health Insurance",
          "category": "Insurance"
        },
        {
          "code": "SUPPORTAFFIDAVIT-2",
          "name": "Support Affidavit",
          "category": "Other"
        },
        {
          "code": "DETAILSGOVERNMENTEMPLO-2",
          "name": "Details of government employment, police service, military experience",
          "category": "Financial"
        }
      ]
    },
    {
      "role": "Sponsor",
      "label": "Sponsor / Inviter",
      "required": true,
      "documents": [
        {
          "code": "PASSPORTSTAMPEDPAGES-3",
          "name": "Passport with all stamped pages",
          "category": "Identity"
        },
        {
          "code": "CURRENTSTATUSCOUNTRY",
          "name": "Current Status in the country",
          "category": "Other"
        },
        {
          "code": "BIRTHCERTIFICATE",
          "name": "Birth Certificate",
          "category": "Identity"
        },
        {
          "code": "IDENTITYCIVILDOCUMENTS-3",
          "name": "Identity and Civil Documents",
          "category": "Identity"
        },
        {
          "code": "PROOFLIVINGCANADA",
          "name": "Proof of living in Canada (any 1)",
          "category": "Other"
        },
        {
          "code": "PROOFSOURCEINCOME-3",
          "name": "Proof/source of Income",
          "category": "Financial"
        },
        {
          "code": "ADDITIONALPROOFFUNDS",
          "name": "Additional proof of Funds/investments/assets",
          "category": "Financial"
        }
      ]
    }
  ]
};
