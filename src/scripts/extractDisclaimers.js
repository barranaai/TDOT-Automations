/**
 * extractDisclaimers.js
 *
 * Reads every Document Checklist PDF, extracts the Disclaimer text from the
 * top of each document, and saves a map of:
 *
 *   "primaryCaseType|caseSubType" → "disclaimer text"
 *
 * Sub-type is empty string ("") for case types that have no sub-type variants.
 *
 * Output: src/data/disclaimerMap.json
 *
 * Run with: node src/scripts/extractDisclaimers.js
 */

require('dotenv').config();
const pdfParse = require('pdf-parse');
const fs   = require('fs');
const path = require('path');

const BASE_DIR  = path.join(__dirname, '../../Document Checklist Items');
const OUT_FILE  = path.join(__dirname, '../data/disclaimerMap.json');

// ─── PDF → { caseType, subType } mapping ─────────────────────────────────────
// Keys are the PDF filename (basename, no extension) — unique enough.
// Values are { caseType, subType } matching exactly the template board group titles
// and sub-type labels used in the Client Master Board.

const PDF_MAP = {
  // CEC
  'Document Checklist- CEC- Accompanying spouse and child':
    { caseType: 'Canadian Experience Class (EE after ITA)', subType: 'CEC Accompanying Spouse & Child' },
  'Document Checklist- CEC- Single applicant':
    { caseType: 'Canadian Experience Class (EE after ITA)', subType: 'CEC Single Applicant' },

  // Citizenship
  'Document Checklist- Citizenship- Accompanying spouse or child':
    { caseType: 'Citizenship', subType: '' },

  // Non-Express Entry (Federal PR)
  'Document Checklist- Non-Express Entry- Accompanying spouse and child':
    { caseType: 'Federal PR', subType: 'Non Express Entry - Accompanying Spouse & Child' },
  'Document Checklist- Non-Express Entry- Non accompanying spouse':
    { caseType: 'Federal PR', subType: 'Non Express Entry - Non Accompanying Spouse' },

  // PR Card, PRTD, Renunciation
  'Document Checklist- PR Card Renewal-Accompanying spouse or child':
    { caseType: 'PR Card Renewal', subType: '' },
  'Document Checklist- PRTD- Accompanying spouse or child':
    { caseType: 'PRTD', subType: '' },
  'Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child':
    { caseType: 'Renunciation of PR', subType: '' },

  // Parents & Grandparents
  'Document Checklist- Parents & Grandparents Sponsorship':
    { caseType: 'Parents/Grandparents Sponsorship', subType: '' },

  // AAIP
  'Document Checklist- AAIP- Express Entry Stream':
    { caseType: 'AAIP', subType: 'Express Entry Stream' },
  'Document Checklist- AAIP- Opportunity Stream':
    { caseType: 'AAIP', subType: 'Opportunity Stream' },
  'Document Checklist- AAIP- Tourism & Hospitality Stream':
    { caseType: 'AAIP', subType: 'Tourism & Hospitality Stream' },
  'Document Checklist- AAIP-Rural Renewal Stream':
    { caseType: 'AAIP', subType: 'Rural Renewal Stream' },

  // BCPNP
  'Document Checklist-BC PNP':
    { caseType: 'BCPNP', subType: 'BC PNP+ Company Info' },
  // Company info-BCPNP is supplementary, skip for disclaimer purposes
  'Company info-BCPNP': null,

  // NSNP
  'Document Checklist-NSNP':
    { caseType: 'NSNP', subType: '' },

  // OINP
  'Document Checklist- OINP- Foreign Worker Stream':
    { caseType: 'OINP', subType: 'Foreign Worker Stream' },
  'Document Checklist- OINP- Human Capital Priorities Stream':
    { caseType: 'OINP', subType: 'Human Capital Priorities Stream' },
  'Document Checklist- OINP- In-Demand Skills Stream':
    { caseType: 'OINP', subType: 'In-demand Skills Stream' },
  'Document Checklist- OINP- International Student Stream':
    { caseType: 'OINP', subType: 'International Student Stream' },
  'Document Checklist- OINP- Masters Graduate Stream':
    { caseType: 'OINP', subType: 'Masters Graduate Stream' },
  'Document Checklist- OINP- PhD Graduate Stream':
    { caseType: 'OINP', subType: 'PhD Graduate Stream' },
  'Document Checklist- OINP- Skilled Trades Stream':
    { caseType: 'OINP', subType: 'Skilled Trades Stream' },

  // Spousal Sponsorship
  'Document Checklist- Common Law Partner- Inland':
    { caseType: 'Inland Spousal Sponsorship', subType: 'Common Law Partner' },
  'Document Checklist- Spousal Sponsorship - Inland':
    { caseType: 'Inland Spousal Sponsorship', subType: 'Marriage' },
  'Document Checklist- Spousal Sponsorship - Outland':
    { caseType: 'Outland Spousal Sponsorship', subType: '' },

  // SOWP / Study Permit
  'Document Checklist- SOWP Extension (Worker Spouse)- spouse or child':
    { caseType: 'Study Permit Extension', subType: 'Accompanying Spouse or Child' },
  'Document Checklist- Study Permit  Extension- Accompanying spouse or child':
    { caseType: 'Study Permit Extension', subType: 'Accompanying Spouse or Child' },
  'Document Checklist- Study Permit  Extension- Single applicant':
    { caseType: 'Study Permit Extension', subType: 'Single Applicant' },
  'Document Checklist- Study Permit - Non SDS Stream- Single Applicant':
    { caseType: 'Study Permit', subType: 'Single Applicant' },
  'Document Checklist- Study Permit - Single Applicant':
    { caseType: 'Study Permit', subType: 'Single Applicant' },
  'Document Checklist- Study Permit for dependent child- Outland':
    { caseType: 'Study Permit', subType: 'Dependent Child (Outland)' },
  'Document Checklist- Study Permit- Non SDS Stream- Accompanying spouse or child':
    { caseType: 'Study Permit', subType: 'Non SDS - Accompanying Spouse or Child' },
  'Document Checklist- Study Permit- SDS Stream- Accompanying spouse or child':
    { caseType: 'Study Permit', subType: 'Non SDS - Accompanying Spouse or Child' },
  'Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant':
    { caseType: 'Study Permit', subType: 'Change of Status (Visitor to Student)' },

  // Supervisa
  'Document Checklist- Supervisa- GrandParents':
    { caseType: 'Supervisa', subType: 'Grandparents' },
  'Document Checklist- Supervisa- Parents':
    { caseType: 'Supervisa', subType: 'Parents' },

  // TRV
  'Document Checklist- TRV':
    { caseType: 'TRV', subType: '' },

  // Visitor Record
  'Document Checklist- Visitor Record (extension)':
    { caseType: 'Visitor Record / Extension', subType: 'Visitor Extension' },

  // Visitor Visa variants
  'Document Checklist- Visitor Visa-  1,2 or 3 members':
    { caseType: 'Visitor Visa', subType: '1-3 Members' },
  'Document Checklist- Visitor Visa-  Parents and siblings':
    { caseType: 'Visitor Visa', subType: 'Parents & Siblings' },
  'Document Checklist- Visitor Visa-  Single Parent':
    { caseType: 'Visitor Visa', subType: 'Single Parent' },
  'Document Checklist- Visitor Visa- 1 or 2 members':
    { caseType: 'Visitor Visa', subType: '1-2 Members' },
  'Document Checklist- Visitor Visa- Both Parents':
    { caseType: 'Visitor Visa', subType: 'Both Parents' },
  'Document Checklist- Visitor Visa- Change of Status (from student or worker)':
    { caseType: 'Visitor Visa', subType: 'Change of Status (Student/Worker to Visitor)' },
  'Document Checklist- Visitor Visa- Spouse  (Spousal Sponsorship in process)':
    { caseType: 'Visitor Visa', subType: 'Spousal Sponsorship in Process' },
  'Document Checklist- Visitor Visa- Spouse':
    { caseType: 'Visitor Visa', subType: 'Spouse' },

  // Work Permits
  'Document Checklist- BOWP- Single ,accompanying spouse or child':
    { caseType: 'BOWP', subType: '' },
  'Document Checklist- Concurrent Work permit- Single or accompanying spouse':
    { caseType: 'Concurrent WP', subType: '' },
  'Document Checklist- LMIA Based Work permit Extension- Single or accompanying spouse- Inside Canada':
    { caseType: 'LMIA Based WP', subType: 'Extension (Inside Canada)' },
  'Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Inside Canada':
    { caseType: 'LMIA Based WP', subType: 'Inside Canada' },
  'Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada':
    { caseType: 'LMIA Based WP', subType: 'Outside Canada' },
  'Document Checklist- LMIA exempt Work permit- Single or accompanying spouse':
    { caseType: 'LMIA Exempt WP', subType: '' },
  'Document Checklist- Open work permit (Worker Parent)- for child above 18 years of age':
    { caseType: 'SCLPC WP', subType: '' },
  'Document Checklist- PGWP (Single Applicant)':
    { caseType: 'PGWP', subType: 'Single Applicant' },
  'Document Checklist- PGWP Extension (Single Applicant)- Passport Validity':
    { caseType: 'PGWP', subType: 'Extension - Single Applicant' },
  'Document Checklist- PGWP Extension - Accompanying spouse established relationship or child- Passport Validity':
    { caseType: 'PGWP', subType: 'Extension - Accompanying Spouse/Child' },
  'Document Checklist- PGWP- Accompanying spouse established relationship or child- Inside Canada':
    { caseType: 'PGWP', subType: 'Extension - Accompanying Spouse/Child' },
  'Document Checklist- SOWP (Spousal Sponsorship in process)':
    { caseType: 'SOWP', subType: 'Outland (Spouse or Child)' },
  'Document Checklist- SOWP (Worker Spouse)- Established Relationship-Inland':
    { caseType: 'SOWP', subType: 'Inland - Established Relationship' },
  'Document Checklist- SOWP (Worker Spouse)- Non established Relationship-Inland':
    { caseType: 'SOWP', subType: 'Inland - Non Established Relationship' },
  'Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland':
    { caseType: 'SOWP', subType: 'Outland (Spouse or Child)' },
  'Document Checklist- SOWP Extension (Worker Spouse)- spouse or child':
    { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'Document Checklist- Work Permit Extension (NB) - Single or accompanying spouse':
    { caseType: 'NB WP Extension', subType: '' },
};

// ─── Extract disclaimer from PDF text ────────────────────────────────────────

function extractDisclaimer(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let inDisclaimer = false;
  const disclaimerLines = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Start when we hit "Disclaimer:"
    if (!inDisclaimer && lower.startsWith('disclaimer:')) {
      inDisclaimer = true;
      // Strip the "Disclaimer: " prefix, keep the rest
      disclaimerLines.push(line.replace(/^Disclaimer:\s*/i, '').trim());
      continue;
    }

    if (inDisclaimer) {
      // Stop at "Documents for the..." or "►" section headers or checkbox items
      if (
        lower.startsWith('documents for') ||
        lower.startsWith('► documents') ||
        lower.startsWith('☐') ||
        lower.startsWith('questionnaire') ||
        lower.startsWith('passport')
      ) break;

      // Skip page numbers / address lines
      if (
        /^page \d+/i.test(lower) ||
        lower.startsWith('20 de boers') ||
        lower.startsWith('www.') ||
        lower.startsWith('north york') ||
        lower.startsWith('suite') ||
        lower.startsWith('document checklist:') ||
        lower.startsWith('(single') ||
        lower.startsWith('(principal')
      ) continue;

      if (line) disclaimerLines.push(line);
    }
  }

  let raw = disclaimerLines.join(' ').replace(/\s+/g, ' ').trim();

  // Strip anything from "Documents for the..." onwards if it leaked through
  raw = raw.replace(/\s*Documents for the\b.*/i, '').trim();
  raw = raw.replace(/\s*►\s*Documents\b.*/i, '').trim();
  // Strip trailing website / address artifacts
  raw = raw.replace(/\s*tdotimm\.com\b.*/i, '').trim();
  raw = raw.replace(/\s*20 de boers\b.*/i, '').trim();
  // Fix font-encoding space artifacts (e.g. "o ther" → "other", "sca nned" → "scanned")
  raw = raw.replace(/\bo ther\b/g, 'other');
  raw = raw.replace(/\bsca nned\b/g, 'scanned');
  // Fix "document s" typo
  raw = raw.replace(/\bdocument s\b/g, 'documents');
  // Remove checkbox symbol artifact
  raw = raw.replace(/☑/g, '').replace(/\s{2,}/g, ' ').trim();

  // ── Remove the AI/Artificial Intelligence sentence entirely ──────────────────
  raw = raw.replace(/This application is processed by Artificial Intelligence[^.]*\./gi, '').trim();
  raw = raw.replace(/\s{2,}/g, ' ').trim();

  // ── Split into individual bullet points ───────────────────────────────────────
  // Split on sentence boundaries: ". ", "! ", "; " where the next word is capitalised
  const bullets = raw
    .split(/(?<=[.!])\s+(?=[A-Z])/)
    .map(s => s.trim().replace(/[.!]+$/, '').trim())  // strip trailing punctuation
    .filter(s => s.length > 10);                       // drop very short fragments

  return bullets;
}

// ─── Walk PDFs ─────────────────────────────────────────────────────────────────

function getAllPdfs(dir) {
  const results = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) {
      results.push(...getAllPdfs(full));
    } else if (f.endsWith('.pdf')) {
      results.push(full);
    }
  }
  return results.sort();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pdfs = getAllPdfs(BASE_DIR);
  console.log(`Found ${pdfs.length} PDFs\n`);

  const disclaimerMap = {};
  const unmapped = [];

  for (const filePath of pdfs) {
    const basename = path.basename(filePath, '.pdf');
    const mapping  = PDF_MAP[basename];

    if (mapping === null) {
      console.log(`  ⏭  Skipping (supplementary): ${basename}`);
      continue;
    }
    if (!mapping) {
      unmapped.push(basename);
      console.warn(`  ⚠️  No mapping for: ${basename}`);
      continue;
    }

    const buffer     = fs.readFileSync(filePath);
    const parsed     = await pdfParse(buffer);
    const disclaimer = extractDisclaimer(parsed.text);

    const key = `${mapping.caseType}|${mapping.subType}`;

    if (!disclaimer || !disclaimer.length) {
      console.warn(`  ❌ No disclaimer found in: ${basename}`);
      continue;
    }

    disclaimerMap[key] = disclaimer;
    console.log(`  ✅ [${key}]  (${disclaimer.length} bullets)`);
    disclaimer.forEach((b, i) => console.log(`     ${i + 1}. ${b.substring(0, 90)}`));
    console.log('');
  }

  // Save
  fs.writeFileSync(OUT_FILE, JSON.stringify(disclaimerMap, null, 2));
  console.log(`\n✅ Saved ${Object.keys(disclaimerMap).length} disclaimers → ${OUT_FILE}`);

  if (unmapped.length) {
    console.log(`\n⚠️  Unmapped PDFs (${unmapped.length}):`);
    unmapped.forEach(f => console.log(`  • ${f}`));
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
