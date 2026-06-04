/**
 * Bulk-generate DRAFT Case Structure Schemas from the checklist PDFs.
 *
 * For every (caseType, subType) in the authoritative PDF map, parse the PDF,
 * group documents by applicant role, and write a draft schema file to
 *   src/data/caseSchemas/drafts/<caseType>__<subType>.js
 *
 * These are DRAFTS: reviewedBy is null and NOTHING is registered in
 * caseSchemaService, so generating them changes zero runtime behaviour. A case
 * type only goes live after a human reviews its draft, moves it up to
 * src/data/caseSchemas/, and adds a register() line.
 *
 * Also writes a review summary: src/data/caseSchemas/drafts/_REVIEW.md
 *
 * Generation choices (all flagged for human review):
 *   - Principal Applicant + Sponsor + Non-Accompanying Spouse → required: true
 *   - Spouse / Child / Parent / Sibling / Worker Spouse       → conditional
 *   - Document category is keyword-inferred (Identity/Financial/Medical/…)
 *   - Document codes are derived from the doc name (stable, unique per role)
 *
 *   node scripts/generate-schemas-from-pdfs.js          # dry-run (summary only)
 *   node scripts/generate-schemas-from-pdfs.js --write  # write the draft files
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { parsePdf, parsePdfFlat, buildPdfMap } = require('./lib/pdfChecklistParser');

const WRITE   = process.argv.includes('--write');
const OUT_DIR = path.join(__dirname, '..', 'src', 'data', 'caseSchemas', 'drafts');

// Applicant label (from the parser) → schema role + default seeding rule.
const ROLE_DEFS = {
  'Principal Applicant':          { role: 'PrincipalApplicant',   label: 'Principal Applicant',          rule: 'required',              order: 1 },
  'Spouse / Common-Law Partner':  { role: 'Spouse',               label: 'Spouse / Common-Law Partner',  rule: 'spouseIncluded',        order: 2 },
  'Non-Accompanying Spouse':      { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse',     rule: 'required',              order: 3 },
  'Worker Spouse':                { role: 'WorkerSpouse',          label: 'Worker Spouse',               rule: 'workerSpouseIncluded',  order: 4 },
  'Sponsor':                      { role: 'Sponsor',               label: 'Sponsor / Inviter',           rule: 'required',              order: 5 },
  'Dependent Child':              { role: 'DependentChild',        label: 'Dependent Child',             rule: 'childrenIncluded',      order: 6, multiple: true },
  'Parent':                       { role: 'Parent',                label: 'Parent',                      rule: 'parentsIncluded',       order: 7, multiple: true },
  'Sibling':                      { role: 'Sibling',               label: 'Sibling',                     rule: 'siblingsIncluded',      order: 8, multiple: true },
};

const FLAG_LABELS = {
  spouseIncluded:       'The applicant’s spouse is also applying',
  childrenIncluded:     'One or more dependent children are applying',
  parentsIncluded:      'One or more parents are applying',
  siblingsIncluded:     'One or more siblings are applying',
  workerSpouseIncluded: 'A worker spouse is part of this case',
};

const STOPWORDS = new Set(['WITH','ALL','THE','OF','AND','FOR','A','AN','OR','IF','YOUR','IN','TO','ON','AS','PER','ANY','S','1','2','3']);

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function deriveCode(name, used) {
  const words = String(name).toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  let code = (words.slice(0, 3).join('') || 'DOC').slice(0, 22);
  let final = code, n = 2;
  while (used.has(final)) { final = `${code}-${n++}`; }
  used.add(final);
  return final;
}

function classifyCategory(name) {
  const n = name.toLowerCase();
  if (/passport|photo|identit|birth|marriage|\bname\b|civil|aadhar|pan\b|nationality|citizen|surname/.test(n)) return 'Identity';
  if (/bank|income|fund|financ|tax|\bpay|salar|asset|invest|net worth|assessment|\bnoa\b|employ|job letter|remuneration|pension/.test(n)) return 'Financial';
  if (/medical/.test(n))   return 'Medical';
  if (/insurance/.test(n)) return 'Insurance';
  if (/questionnaire|\bform\b|imm\d|application form/.test(n)) return 'Forms';
  if (/police|clearance|background|biometric/.test(n)) return 'Background';
  return 'Other';
}

function buildRoles(byApplicant) {
  const used = new Set();
  const roles = [];
  const present = Object.keys(byApplicant)
    .map((label) => ({ label, def: ROLE_DEFS[label] }))
    .filter((x) => x.def)
    .sort((a, b) => a.def.order - b.def.order);

  for (const { label, def } of present) {
    const docs = byApplicant[label].map((name) => ({
      code:     deriveCode(name, used),
      name,
      category: classifyCategory(name),
    }));
    const role = { role: def.role, label: def.label };
    if (def.rule === 'required') role.required = true;
    else role.includeWhen = { caseFlag: def.rule };
    if (def.multiple) role.multipleAllowed = true;
    role.documents = docs;
    roles.push(role);
  }
  return roles;
}

function collectCaseFlags(roles) {
  const flags = {};
  for (const r of roles) {
    const f = r.includeWhen && r.includeWhen.caseFlag;
    if (f) flags[f] = { label: FLAG_LABELS[f] || f };
  }
  return flags;
}

function renderFile(schema) {
  const banner =
    `/**\n` +
    ` * DRAFT Case Structure Schema — auto-generated from PDF. NOT reviewed.\n` +
    ` *\n` +
    ` * ⚠️  Do not register/activate until a human verifies this against the PDF:\n` +
    ` *     - required vs conditional roles (esp. Sponsor / Worker Spouse)\n` +
    ` *     - "if applicable" documents (name-change affidavit, extra marriages, etc.)\n` +
    ` *     - document categories (keyword-inferred) and codes\n` +
    ` *\n` +
    ` * Source: ${schema.source}\n` +
    ` */\n\n` +
    `'use strict';\n\n` +
    `module.exports = `;
  return banner + JSON.stringify(schema, null, 2) + ';\n';
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE drafts' : '🔍 DRY-RUN (summary only)'}\n`);
  const entries = buildPdfMap();
  console.log(`PDF map: ${entries.length} (caseType, subType) entries\n`);

  if (WRITE) fs.mkdirSync(OUT_DIR, { recursive: true });

  const summary = [];
  for (const e of entries) {
    let byApplicant = await parsePdf(e.pdfPath);
    let usedFallback = false;
    if (Object.keys(byApplicant).length === 0) {
      const flat = await parsePdfFlat(e.pdfPath);
      byApplicant = { 'Principal Applicant': flat };
      usedFallback = true;
    }

    const roles = buildRoles(byApplicant);
    const docTotal = roles.reduce((n, r) => n + r.documents.length, 0);
    const hasRequiredRole = roles.some((r) => r.required);
    // Flag for extra review when: nothing parsed, the flat fallback was used,
    // or there's NO required role (an empty composition would seed zero rows —
    // usually means the PDF's Principal Applicant section wasn't recognised).
    const needsAttention = docTotal === 0 || usedFallback || !hasRequiredRole;

    const schema = {
      caseType:         e.caseType,
      subType:          e.subType,
      schemaVersion:    1,
      source:           e.pdfRelative,
      generatedFromPdf: true,
      reviewedBy:       null,
      reviewedAt:       null,
      caseFlags:        collectCaseFlags(roles),
      memberFlags:      { nameChanged: { label: 'Applicant’s name/surname differs across official documents' } },
      roles,
    };

    const fname = `${slug(e.caseType)}__${slug(e.subType) || 'default'}.js`;
    if (WRITE) fs.writeFileSync(path.join(OUT_DIR, fname), renderFile(schema));

    summary.push({
      caseType: e.caseType, subType: e.subType || '(none)', fname,
      roles: roles.map((r) => `${r.role}:${r.documents.length}`).join(' '),
      docTotal, needsAttention, usedFallback, hasRequiredRole,
    });
    const flag = needsAttention ? '⚠ ' : '  ';
    console.log(`${flag}${(e.caseType + ' / ' + (e.subType || '—')).padEnd(58)} ${docTotal} docs  [${roles.map((r) => r.role).join(', ')}]${usedFallback ? '  (flat fallback)' : ''}`);
  }

  // Review summary
  const md = [];
  md.push('# Draft schema review queue\n');
  md.push(`Generated ${summary.length} drafts. Review each against its source PDF, then move to`);
  md.push('`src/data/caseSchemas/` and add a `register()` line in `caseSchemaService.js`.\n');
  md.push('| ⚠ | Case Type | Sub Type | Docs | Roles (role:count) | Note | File |');
  md.push('|---|---|---|---|---|---|---|');
  for (const s of summary) {
    const note = !s.hasRequiredRole ? 'NO REQUIRED ROLE — check PA section' : (s.usedFallback ? 'flat fallback' : '');
    md.push(`| ${s.needsAttention ? '⚠' : ''} | ${s.caseType} | ${s.subType} | ${s.docTotal} | ${s.roles} | ${note} | ${s.fname} |`);
  }
  md.push('\n⚠ = needs extra attention: flat fallback (no applicant sections found), zero docs, or no required role (an empty composition would seed nothing — usually the PA section heading wasn’t recognised).');
  const attn = summary.filter((s) => s.needsAttention).length;
  console.log(`\nTotal: ${summary.length} drafts, ${attn} flagged ⚠ for extra attention.`);

  if (WRITE) {
    fs.writeFileSync(path.join(OUT_DIR, '_REVIEW.md'), md.join('\n') + '\n');
    console.log(`\nWrote ${summary.length} draft files + _REVIEW.md to ${path.relative(process.cwd(), OUT_DIR)}`);
  } else {
    console.log('\n(Dry-run. Re-run with --write to create the draft files.)');
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
