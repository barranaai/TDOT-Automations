/**
 * Populates the "Client-Facing Instructions" column (long_text_mm0z10mg)
 * for all items on the Monday.com Template Board (ID: 18401624183).
 *
 * Usage: node src/scripts/populateClientInstructions.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const TMPL_BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';
const INST_COL = 'long_text_mm0z10mg';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Instructions Map ───────────────────────────────────────────────────────────

const INSTRUCTIONS_MAP = {
  // ── Identity ────────────────────────────────────────────────────────────────
  'Passport with all pages': 'Upload all pages of your passport, including the bio-data (photo) page, any visa/permit sticker pages, and every page showing entry/exit stamps. If you have held multiple passports, include all of them.',
  'Passport with all pages- (in the last 5 years)': 'Upload all pages of every passport you have held in the last 5 years, including expired ones. Include the bio-data page, all visa/permit sticker pages, and all entry/exit stamp pages.',
  'Passport with all pages. (that covers 5-year eligibility period)': 'Upload all pages of every passport held during your 5-year eligibility period, including any expired passports. Include the bio-data page, all visa/permit sticker pages, and all entry/exit stamp pages.',
  'Passport with all stamped pages': 'Upload clear scans of all pages in your passport that contain stamps, visas, entry/exit markings, or any endorsements — plus the bio-data (photo) page.',
  'Passport with all stamped pages- Old and New': 'Upload all stamped pages of both your current passport and all previous passports, plus the bio-data (photo) page of each.',
  'Passport with all stamped pages.': 'Upload clear scans of all pages in your passport that contain stamps, visas, entry/exit markings, or any endorsements — plus the bio-data (photo) page.',
  'Birth Certificate': 'Upload a clear copy of your official birth certificate issued by the government. If it is not in English or French, please also include a certified translation.',
  'Birth Certificate or Grade 10-12 marksheets.': 'Upload either your official birth certificate or your Grade 10–12 school marksheets/certificates clearly showing your date of birth.',
  'Digital photo as per specifications of Temporary Residents': 'Upload a digital photo meeting IRCC temporary resident specifications: 35mm × 45mm, plain white background, taken within the last 6 months, full face clearly visible. No glasses or head coverings (unless for religious reasons).',
  'Digital photo as per specifications Permanent Residents': 'Upload a digital photo meeting IRCC permanent resident specifications: 50mm × 70mm (2" × 2.75"), plain white background, taken within the last 6 months. Full face must be clearly visible.',
  'Digital photo as per specifications Permanent Residents- Front and Back both required': 'Upload two photos meeting IRCC PR specifications (50mm × 70mm, white background, taken within the last 6 months): one front-facing and one showing the back of your head.',
  'Photo as per specifications Permanent Residents': 'Upload a photo meeting IRCC PR specifications: 50mm × 70mm, plain white background, taken within the last 6 months. Full face must be clearly visible.',
  'Government issued Identity documents': 'Upload any 2 valid government-issued photo ID documents (e.g., driver\'s licence, national ID card, provincial health card). Ensure they are not expired.',
  'Identity and Civil Documents': 'Upload government-issued photo ID along with civil documents such as your birth certificate, marriage certificate, or national ID card, as applicable.',
  'PR Card or eCOPR': 'Upload a copy of your current Permanent Resident (PR) Card (front and back) or your electronic Confirmation of Permanent Residence (eCOPR) document.',

  // ── Employment ───────────────────────────────────────────────────────────────
  'Current Employment Proof': 'Provide all of the following from your current employer:\n1. Employment letter on company letterhead stating your job title, start date, salary, and hours per week\n2. Recent pay stubs (last 3 months)\n3. T4 slip or Notice of Assessment (if applicable)',
  'Employment Proof (Mandatory documents)': 'Upload the following:\n1. Official employment/experience letter on company letterhead, signed by HR or a supervisor, stating your job title, employment dates, salary, hours per week, and main duties\n2. Most recent pay stubs (last 3 months)\n3. Reference or experience letters, if available',
  'Employment Proof (Mandatory documents)- for Principal Applicant': 'Upload the following for the Principal Applicant:\n1. Official employment/experience letter on company letterhead, signed by HR or a supervisor, stating job title, employment dates, salary, hours per week, and main duties\n2. Most recent pay stubs (last 3 months)\n3. T4 slip or Notice of Assessment (for Canadian employment)',
  'Job Offer Letter': 'Upload the official job offer letter on company letterhead, signed by an authorized representative of the employer. The letter must include: job title, NOC code (if known), start date, salary/wage, hours per week, and business address.',
  'Job Offer Letter:': 'Upload the official job offer letter on company letterhead, signed by an authorized representative of the employer. The letter must include: job title, start date, salary/wage, hours per week, and business address.',
  'Paystubs': 'Upload your most recent 3–6 pay stubs from your employer. Ensure your name, employer name, pay period, and deductions are clearly visible.',
  'T4': 'Upload your T4 slip(s) for the relevant tax year(s). If you had multiple employers, include T4s from all of them.',
  'Details of government employment, police service, military experience': 'Provide official documentation for any government employment, police service, or military experience you have had: employment letters, service records, or discharge papers. Include dates, job titles, and duties.',
  'Application for Approval of an Employment Position (Employer Form)- We can share the form upon': 'This form is completed by your employer. Please ask your employer to contact us — we will provide them with the correct form and guidance for completion.',
  'Application for Approval of an Employment Position (Employer Form)- We can share the form upon request': 'This form is completed by your employer. Please ask your employer to contact us — we will provide them with the correct form and guidance for completion.',
  'Proof of work experience for your qualifying work experience.': 'Provide employment/experience letters from each employer covering your qualifying work period. Each letter must be on company letterhead, signed by HR or a supervisor, and state: job title, employment dates, salary, hours per week, and main duties.',
  'Proof of work experience for your qualifying work experience. Please Note: Your current employment in Alberta and': 'Provide employment/experience letters for all qualifying work, including your current Alberta employment. Each letter must be on company letterhead, signed by HR or a supervisor, and state: job title, employment dates, salary, hours per week, and main duties. Alberta-based work must meet the minimum hours requirement.',
  'Proof of work experience for your qualifying work experience. (either 12 months work experience in Alberta': 'Provide employment/experience letters covering your qualifying work experience (minimum 12 months in Alberta or as specified). Each letter must be on company letterhead, signed, and include job title, dates, salary, hours per week, and main duties.',

  // ── Financial ────────────────────────────────────────────────────────────────
  'Proof/source of Income': 'Upload recent bank statements (last 3–6 months), pay stubs, T4 slips, or a Notice of Assessment showing your current source and level of income.',
  'Proof/source of Income - Mandatory': 'Upload recent bank statements (last 3–6 months), pay stubs, T4 slips, or a Notice of Assessment clearly showing your current source and level of income. This document is mandatory.',
  'Proof/source of Income - Mandatory for Worker Parent': 'The Worker Parent must upload proof of income: recent bank statements (last 3–6 months), pay stubs, T4 slips, or a Notice of Assessment. This document is mandatory.',
  'Proof/source of Income (Back Home)': 'Upload recent bank statements (last 3–6 months) or other proof of income from your home country, showing your financial situation before coming to Canada.',
  'Proof/source of Income (for Dependent Applicant)': 'Upload recent bank statements (last 3–6 months), pay stubs, or other income proof for the dependent applicant, showing their current source and level of income.',
  'Proof/source of Income (If you will support the applicant)': 'As the financial supporter, upload recent bank statements (last 3–6 months), pay stubs, T4 slips, or a Notice of Assessment showing you have sufficient income to support the applicant.',
  'Proof/source of Income Higher the funds, higher the chances of approval. We can provide a template upon request.': 'Upload bank statements (last 6 months) and any additional proof of savings, investments, or assets. Higher fund amounts improve approval chances. We can provide a template for a financial declaration if needed.',
  'Proof/source of Income- Highly recommended': 'We strongly recommend uploading proof of income such as bank statements (last 3–6 months), pay stubs, T4 slips, or a Notice of Assessment. This significantly strengthens your application.',
  'Proof/source of Income- Mandatory for the Principal Applicant': 'The Principal Applicant must upload proof of income: recent bank statements (last 3–6 months), pay stubs, T4 slips, or a Notice of Assessment. This document is mandatory.',
  'Proof/source of Income- Mandatory for Worker Spouse': 'The Worker Spouse must upload proof of income: recent bank statements (last 3–6 months), pay stubs, or T4 slips. This document is mandatory.',
  'Employment/ Source of Income': 'Upload proof of your employment and/or source of income: employment letter, pay stubs (last 3 months), bank statements (last 3–6 months), T4 slip, or Notice of Assessment.',
  'Financial Documents- Higher the funds, higher the chances of approval. We can provide a template upon request.': 'Upload bank statements (last 6 months) and additional proof of savings, investments, or assets (GIC certificates, fixed deposits, property valuations, etc.). Higher funds improve your application. We can provide a financial declaration template if needed.',
  'Settlement Funds – (Please confirm with us in advance)': 'Upload bank statements for the last 3–6 months showing the required settlement funds. Funds must be unencumbered (not borrowed or a loan). Please confirm the exact required amount with us before preparing your documents.',
  'Settlement Funds (Please confirm with us in advance)': 'Upload bank statements for the last 3–6 months showing the required settlement funds. Funds must be unencumbered (not borrowed or a loan). Please confirm the exact required amount with us before preparing your documents.',
  'Guaranteed Investment Certificate': 'Upload your GIC certificate from a Schedule I Canadian bank. The certificate must clearly show the required minimum amount as per current IRCC guidelines.',
  'Additional proof of Funds/investments/assets': 'Upload supplementary financial documents such as: investment account statements, property valuations, fixed deposit certificates, vehicle ownership documents, business ownership documents, or any other evidence of assets.',
  'Proof of financial support while you study in Canada': 'Upload evidence of sufficient funds to cover your tuition and living expenses for the full duration of your studies. Acceptable documents: bank statements (last 6 months), GIC certificate, scholarship/sponsorship letter, or a signed financial support letter from your sponsor.',

  // ── Education ─────────────────────────────────────────────────────────────────
  'Canadian Education Documents': 'Upload official transcripts and degree/diploma/certificate from each Canadian educational institution you attended.',
  'Canadian Education Documents- (For each program if studied here)': 'For each program you studied in Canada, upload: official transcripts, degree/diploma/certificate, and enrollment confirmation letter.',
  'Canadian Education Documents- (For each program)': 'For each program completed in Canada, upload: official transcripts and the degree/diploma/certificate awarded.',
  'Foreign Education Documents along with Educational Credential Assessment': 'Upload:\n1. All official foreign education transcripts and degrees/diplomas/certificates\n2. Your Educational Credential Assessment (ECA) report from a designated organization (e.g., WES, ICAS, IQAS)\n\nIf you have not yet obtained an ECA, please contact us right away.',
  'Educational Credential Assessment – Service Providers': 'Upload your ECA report from a designated IRCC service provider (e.g., WES, ICAS, IQAS, CES, PEBC). Ensure the ECA is addressed to Immigration, Refugees and Citizenship Canada (IRCC) and has not expired.',

  // ── Medical ───────────────────────────────────────────────────────────────────
  'Medical Exam': 'You must complete an immigration medical exam with a designated IRCC panel physician. Please contact us before booking to confirm the correct exam type and panel physician in your area. Upload the completed IMM 1017 form and any supporting documents provided.',
  'Medical exam for permanent residence applicants': 'Complete an upfront immigration medical exam with a designated IRCC panel physician before submitting your PR application. Upload the signed IMM 1017 form and all related medical documents provided by the panel physician.',
  'Upfront Medical': 'Complete an upfront medical exam with a designated IRCC panel physician before your application is submitted. Upload the completed IMM 1017 form and all documents provided by the panel physician.',
  'Upfront Medical exams': 'Complete upfront medical exams with a designated IRCC panel physician. Upload the completed IMM 1017 form and any supporting results or documents provided by the panel physician.',
  'Health Insurance': 'Upload proof of valid health insurance coverage for your stay in Canada (e.g., provincial health insurance confirmation, or a private health insurance policy document showing coverage dates and amounts).',

  // ── Legal ─────────────────────────────────────────────────────────────────────
  'Police certificates (PCC)': 'Obtain a Police Clearance Certificate (PCC) from every country you have lived in for 6 months or more since the age of 18. Upload all PCCs obtained. Contact us if you need guidance on how to obtain a PCC for a specific country.',
  'Police certificates (PCC)- Highly recommend': 'We strongly recommend obtaining Police Clearance Certificates (PCCs) from all countries where you have lived for 6 months or more since age 18. Upload all available PCCs — this significantly strengthens your application.',
  'Police certificates (PCC)- Highly recommended': 'We strongly recommend obtaining Police Clearance Certificates (PCCs) from all countries where you have lived for 6 months or more since age 18. Upload all available PCCs — this significantly strengthens your application.',
  'Police certificates (PCC)- Highly Recommended': 'We strongly recommend obtaining Police Clearance Certificates (PCCs) from all countries where you have lived for 6 months or more since age 18. Upload all available PCCs — this significantly strengthens your application.',
  'Police certificates (PCC)- We highly recommend it': 'We strongly recommend obtaining Police Clearance Certificates (PCCs) from all countries where you have lived for 6 months or more since age 18. Upload all available PCCs — this significantly strengthens your application.',
  'Police clearance certificates (PCC)': 'Obtain a Police Clearance Certificate from every country where you have lived for 6 months or more since turning 18. Upload all certificates obtained.',

  // ── Travel ────────────────────────────────────────────────────────────────────
  'Urgent Travel Proof (if applicable)': 'If you are requesting expedited processing due to urgent travel, upload supporting documentation such as: a funeral notice, medical emergency letter, work assignment confirmation, or other proof of urgent need. Travel for vacation does not qualify for expedited processing.',

  // ── Other ─────────────────────────────────────────────────────────────────────
  'Resume': 'Upload an up-to-date resume listing all education, work experience, and any other relevant activities. Include month and year for all start and end dates.',
  'Updated Resume': 'Upload your most current, up-to-date resume listing all education and work experience. Include month and year for all start and end dates.',
  'Resume/Curriculum Vitae (CV)': 'Upload an up-to-date resume or CV listing all education, work experience, and relevant activities. Include month and year for all start and end dates.',
  'Language Test Report': 'Upload your official language test result from an approved IRCC test: IELTS General, CELPIP-G, PTE Core, TEF Canada, or TCF Canada. Results must be within 2 years of the application date.',
  'Language Test Report (if you are 18 to 54 years of age)': 'If you are between 18 and 54 years old, upload your official language test result: IELTS-G, CELPIP-G, PTE Core, TEF Canada, or TCF Canada. Results must be within 2 years of the application date.',
  'English Language Test Report': 'Upload your official English language test report: IELTS (General or Academic), CELPIP-G, or PTE Core. Results must be within 2 years of the application date.',
  'International English Language Testing System (IELTS) Test Report Form /CELPIP': 'Upload your official IELTS (General or Academic) Test Report Form or CELPIP-G certificate. Results must be dated within 2 years of your application date.',
  'Proof of language proficiency (IELTS- G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)': 'Upload your official language proficiency test result from one of the following: IELTS General (IELTS-G), CELPIP-G, PTE Core, TEF Canada, or TCF Canada. Results must be within 2 years of the application date.',
  'Proof of relationship': 'Upload documents proving your relationship with the principal applicant or sponsor, such as: marriage certificate, common-law statutory declaration, joint bank account statements, joint lease agreements, or photos together.',
  'Proof of Relationship': 'Upload documents proving your relationship with the principal applicant or sponsor, such as: marriage certificate, common-law statutory declaration, joint bank account statements, joint lease agreements, or photos together.',
  'Proof of Relationship with the applicants': 'Upload documents proving your relationship with the applicant(s): birth certificate (for parent/child), marriage certificate (for spouse), or adoption certificate.',
  'Proof of cohabitation': 'Upload documents showing you share the same address, such as: a joint lease or mortgage agreement, utility bills in both names, joint bank account statements, or official government mail addressed to both parties at the same address.',
  'Proof of Admission': 'Upload your official letter of acceptance from a Designated Learning Institution (DLI). The letter must show: your program name, start date, program duration, tuition amount, and DLI number.',
  'Proof of living in Canada': 'Upload any documents confirming your physical presence in Canada: utility bills, bank statements, lease agreement, CRA correspondence, or government-issued documents showing your Canadian address.',
  'Proof of living in Canada (any 1)': 'Upload any one document confirming your physical presence in Canada: utility bill, bank statement, lease agreement, CRA correspondence, or government-issued document showing your Canadian address.',
  'Sibling- Proof of living in Canada': 'Upload documents confirming your sibling\'s Canadian status and address: PR card or citizenship certificate plus a recent utility bill, driver\'s licence, or government-issued mail showing their Canadian address.',
  'Sibling- Proof of living in Canada- if applicable': 'If applicable, upload documents confirming your sibling\'s Canadian status and address: PR card or citizenship certificate plus a recent utility bill, driver\'s licence, or government-issued mail showing their Canadian address.',
  'All permits ever held in Canada': 'Upload copies of all immigration documents you have held in Canada: study permits, work permits, visitor records, and any other status documents — both current and expired.',
  'All Permits ever held in Canada': 'Upload copies of all immigration documents you have held in Canada: study permits, work permits, visitor records, and any other status documents — both current and expired.',
  'Proof of status in the country': 'Upload your current valid immigration status document for the country you reside in (e.g., work permit, study permit, visa, permanent residence document).',
  'Current Status in the country': 'Upload your current valid immigration status document for the country you currently reside in (e.g., work permit, study permit, visa, PR card, or equivalent).',
  'Status Identification': 'Upload valid government-issued identification confirming your current immigration status: permanent resident card, visa label, work permit, study permit, or equivalent document.',
  'Notice of Assessment': 'Upload your most recent Notice of Assessment (NOA) from the Canada Revenue Agency (CRA). You can download it from your My CRA Account online at canada.ca.',
  'Previous application Forms': 'Upload copies of all previously submitted immigration application forms and any correspondence received from IRCC, including approval letters, refusal letters, or procedural fairness letters.',
  'Invitation to Apply and Submission Confirmation of PR': 'Upload:\n1. Your Invitation to Apply (ITA) email or letter from IRCC\n2. The submission confirmation email you received after submitting your permanent residence application',
  'Labour Market Impact Assessment (if applicable)': 'If your employer has obtained an LMIA for your position, upload the LMIA approval letter. If an LMIA is not required for your work permit category, this document is not needed.',
  'One and same name affidavit if name /surname changed': 'If your name or surname appears differently across your documents (due to marriage, transliteration, or a legal name change), provide a notarized "one and same person" affidavit confirming both names belong to the same individual.',
  'Statement of Purpose': 'Provide a personal statement explaining your purpose for coming to or remaining in Canada, your ties to your home country, and your intention to comply with all immigration conditions. Please contact us if you would like a template.',
  'Proof of work experience (for Principal Applicant)': 'Upload employment/experience letters for all qualifying work experience for the Principal Applicant. Each letter must be on company letterhead, signed by HR or a supervisor, and state: job title, employment dates, salary, hours per week, and main duties. Also include pay stubs and T4s for Canadian employment.',
  'Proof of work experience (Inside Canada)': 'Upload employment/experience letters for all Canadian work experience. Each letter must be on company letterhead, signed by HR or a supervisor, and state: job title, employment dates, salary, hours per week, and main duties. Also include pay stubs and T4s.',
  'Proof of work experience (Inside and Outside Canada)': 'Upload employment/experience letters for all Canadian and international work experience. Each letter must state: job title, employment dates, salary, hours per week, and main duties. Include pay stubs and T4s for Canadian employment.',
  'Proof of work experience (we highly recommend)': 'We strongly recommend uploading employment/experience letters for all relevant work experience. Each letter should be on company letterhead, signed, and state job title, employment dates, salary, hours, and main duties.',
  'Proof of work experience for the claiming period (Inside and Outside Canada)': 'Upload employment/experience letters covering all jobs during your claiming period, both inside and outside Canada. Each letter must be on company letterhead, signed, and include job title, dates, salary, hours, and main duties.',
  'Experience Documents- Provide all relevant experience documents from previous employers if any.': 'Provide all relevant experience documents from each previous employer: employment/experience letters on company letterhead, pay stubs, reference letters, and any other documents supporting your work history.',
  'Recommendation Letters': 'Upload recommendation letters from employers, professional supervisors, or community leaders who can speak to your character and contributions. Letters should be on official letterhead and signed.',
  'Recommendation Letters (only for Principal Applicant)': 'The Principal Applicant should upload recommendation letters from employers or professional supervisors. Letters should be on official letterhead, signed, and address your work ethic and professional abilities.',
  'Recommendation Letters (only for Principal Applicant)- at least 3': 'The Principal Applicant must upload at least 3 recommendation letters from employers, professional supervisors, or community leaders. Letters should be on official letterhead, signed, and speak to your character and professional abilities.',
  'Support Affidavit': 'Upload a notarized affidavit from your sponsor or financial supporter confirming they will provide financial and/or personal support during your stay in Canada. Include their contact information and relationship to you.',
  'Trade Certificate': 'Upload your trade certificate or journeyperson certificate issued by the relevant provincial authority. Ensure it is valid and not expired.',
  'All Marksheet and certificates': 'Upload all academic marksheets (transcripts) and certificates/diplomas for every level of education you have completed (secondary, post-secondary, trade, vocational, etc.).',
  'Adoption/Guardianship Proof': 'Upload official legal documentation proving adoption or guardianship, such as a court order, adoption certificate, or guardianship certificate. If not in English or French, include a certified translation.',
  'Sole custody Proof': 'Upload a court order or legally binding agreement confirming you have sole custody of the dependent child.',
  'Endorsement of Candidate letter': 'Upload the endorsement letter from the provincial or territorial nominee program confirming your nomination as a candidate.',
  'Intention to Reside in BC': 'Upload a signed personal letter stating your sincere intention to reside and settle in British Columbia. Include specific reasons why you plan to make BC your home.',
  'Intention to Reside in Nova Scotia': 'Upload a signed personal letter stating your sincere intention to reside and settle in Nova Scotia. Include specific reasons why you plan to make Nova Scotia your home.',
  'Intention to Reside in Ontario': 'Upload a signed personal letter stating your sincere intention to reside and settle in Ontario. Include specific reasons why you plan to make Ontario your home.',
  'Relative in Alberta- Parents/ Siblings/ Children (applicable only if you were drawn based on having a family': 'Upload documents proving your relative\'s status and residence in Alberta:\n1. PR card or Canadian citizenship certificate\n2. Proof of Alberta address (utility bill, driver\'s licence, or government-issued mail)\n\nThis only applies if you were drawn from the pool based on having a family connection in Alberta.',
  'If you or your spouse or common-law partner has a relative who is a Canadian citizen or a permanent resident of Canada': 'If you or your spouse/common-law partner has a relative who is a Canadian citizen or permanent resident, upload:\n1. Proof of their citizenship or PR status (citizenship certificate or PR card)\n2. Documents confirming your relationship to them (birth certificate or marriage certificate)',
  'If student': 'If you are currently a student, upload your current study permit, enrollment/acceptance letter from your institution, and your most recent academic transcripts.',
  'Letters, Printed text messages, emails, social media conversations and phone records showing regular': 'Upload evidence of your ongoing genuine relationship: printed messages (WhatsApp, email, social media), phone records showing regular contact, photos together, or travel records showing visits to each other.',
  'Personal Identification-': 'Upload 2 valid government-issued photo ID documents (e.g., passport, driver\'s licence, national ID card, or provincial health card).',
  'Personal Identification- Any 2 from the following': 'Upload any 2 of the following government-issued photo ID documents: passport, driver\'s licence, national ID card, provincial health card, or other government-issued photo ID.',
  'Proof of Residency in Canada (Any 4) - For the last 5 years or since becoming a PR': 'Upload any 4 of the following documents showing your Canadian residency over the last 5 years (or since you became a PR): lease agreements, utility bills, bank statements, CRA correspondence, employment records, school records, health records, or government-issued mail.',
  'NSNP 200- Employer Information Form': 'This form must be completed by your employer for the Nova Scotia Nominee Program (NSNP). Please ask your employer to contact us — we will provide them with the NSNP 200 form and instructions for completion.',
  'Employer Declaration and Authorization Form-': 'This form must be signed by your employer. Please ask your employer to contact us — we will provide them with the correct form and instructions for completion.',
  'Sector association membership or Experience Provider status': 'Upload your current certificate of membership with the relevant sector association, or your designation/approval as an Experience Provider, as required for your specific application stream.',
  'Commercial Vehicle Operator\'s Registration (CVOR) Certificate': 'Upload a valid CVOR (Commercial Vehicle Operator\'s Registration) certificate issued by the Ministry of Transportation of Ontario. The certificate must be current and in good standing.',
  'Workers\' Compensation Board (WCB) document': 'Upload your current WCB clearance letter or certificate from the relevant provincial Workers\' Compensation Board, confirming you are in good standing.',
  'Licence or authorization': 'Upload your current professional licence or government-issued authorization to practise in your field (e.g., engineering licence, medical licence, or trade licence). Ensure it is valid and not expired.',
  'Licensing, Registration and Certificate': 'Upload all current professional licences, registration documents, and certificates relevant to your occupation (e.g., trade certificate, professional association registration, occupational licence). Ensure all documents are valid.',
  'Additional documents (Optional)': 'Upload any additional supporting documents you believe would strengthen your application. Please label each document clearly so it is easy to identify.',
};

// ── Fetch all board items with cursor-based pagination ─────────────────────────

async function fetchAllItems() {
  const allItems = [];
  let cursor = null;
  let page = 1;

  console.log('Fetching all template board items (paginated)...');

  do {
    let data;

    if (!cursor) {
      // First page — no cursor
      data = await mondayApi.query(
        `query getItemsFirstPage($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 500) {
              cursor
              items {
                id
                name
                column_values(ids: ["${INST_COL}"]) {
                  id
                  text
                  value
                }
              }
            }
          }
        }`,
        { boardId: TMPL_BOARD_ID }
      );
    } else {
      // Subsequent pages — use cursor
      data = await mondayApi.query(
        `query getItemsNextPage($cursor: String!) {
          next_items_page(limit: 500, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values(ids: ["${INST_COL}"]) {
                id
                text
                value
              }
            }
          }
        }`,
        { cursor }
      );
    }

    let pageResult;
    if (!cursor) {
      pageResult = data?.boards?.[0]?.items_page;
    } else {
      pageResult = data?.next_items_page;
    }

    const items = pageResult?.items ?? [];
    cursor = pageResult?.cursor ?? null;

    allItems.push(...items);
    console.log(`  Page ${page}: fetched ${items.length} items (total so far: ${allItems.length})`);
    page++;
  } while (cursor);

  console.log(`\nTotal items fetched: ${allItems.length}\n`);
  return allItems;
}

// ── Look up instructions for an item name ─────────────────────────────────────

function lookupInstructions(name) {
  const trimmedName = name.trim();

  // 1. Exact match
  if (INSTRUCTIONS_MAP[trimmedName] !== undefined) {
    return { instructions: INSTRUCTIONS_MAP[trimmedName], matchType: 'exact' };
  }

  // 2. Case-insensitive startsWith / includes fallback
  const lowerName = trimmedName.toLowerCase();
  const fallbackKey = Object.keys(INSTRUCTIONS_MAP).find(
    (k) =>
      lowerName.includes(k.toLowerCase()) ||
      k.toLowerCase().includes(lowerName)
  );

  if (fallbackKey !== undefined) {
    return { instructions: INSTRUCTIONS_MAP[fallbackKey], matchType: 'fuzzy', matchedKey: fallbackKey };
  }

  return { instructions: null, matchType: 'none' };
}

// ── Update a single item with retry logic ─────────────────────────────────────

async function updateItemInstructions(itemId, instructions, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mondayApi.query(
        `mutation updateInstructions($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(
            board_id: $boardId,
            item_id: $itemId,
            column_values: $columnValues
          ) {
            id
          }
        }`,
        {
          boardId: TMPL_BOARD_ID,
          itemId: String(itemId),
          columnValues: JSON.stringify({
            [INST_COL]: { text: instructions },
          }),
        }
      );
      return; // success
    } catch (err) {
      if (attempt < retries) {
        console.warn(`    Attempt ${attempt} failed for item ${itemId}: ${err.message} — retrying...`);
        await sleep(500 * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Populate Client-Facing Instructions ===\n');
  console.log(`Board ID : ${TMPL_BOARD_ID}`);
  console.log(`Column   : ${INST_COL}\n`);

  const items = await fetchAllItems();

  let countUpdated = 0;
  let countSkippedAlreadyHad = 0;
  let countSkippedNoMatch = 0;
  const noMatchNames = new Set();

  for (const item of items) {
    const itemName = item.name.trim();

    // Check if column already has a non-empty value
    const colValue = item.column_values?.find((cv) => cv.id === INST_COL);
    const existingText = colValue?.text?.trim() || '';

    if (existingText) {
      countSkippedAlreadyHad++;
      continue;
    }

    // Look up instructions
    const { instructions, matchType, matchedKey } = lookupInstructions(itemName);

    if (!instructions) {
      countSkippedNoMatch++;
      noMatchNames.add(itemName);
      continue;
    }

    // Update via mutation
    try {
      await updateItemInstructions(item.id, instructions);

      if (matchType === 'exact') {
        console.log(`  [UPDATED] "${itemName}" (exact match)`);
      } else {
        console.log(`  [UPDATED] "${itemName}" (fuzzy match -> "${matchedKey}")`);
      }

      countUpdated++;
    } catch (err) {
      console.error(`  [FAILED]  "${itemName}" (id: ${item.id}) — ${err.message}`);
    }

    await sleep(200);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Updated               : ${countUpdated}`);
  console.log(`  Skipped (already had) : ${countSkippedAlreadyHad}`);
  console.log(`  Skipped (no match)    : ${countSkippedNoMatch}`);

  if (noMatchNames.size > 0) {
    console.log('\n  Items with no matching instructions:');
    for (const name of [...noMatchNames].sort()) {
      console.log(`    - "${name}"`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
