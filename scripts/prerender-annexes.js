/**
 * One-off: pre-render the static Annex A .docx scope documents to PDF (they have
 * no merge fields), so retainer generation can just append the right one.
 * Run once (and whenever an annex changes). Needs CLOUDCONVERT_API_KEY in .env.
 *
 * Usage:
 *   node scripts/prerender-annexes.js            # all 27
 *   node scripts/prerender-annexes.js "Canadian Experience"   # only matches (substring)
 */
'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { docxToPdf } = require('../src/services/pdfConvertService');

const ROOT = '/Users/faran/TDOT-Automations/Retainer Agreement Templates/RCIC Roles and Responsibilities';
const OUT  = path.join(__dirname, '..', 'src', 'templates', 'retainer', 'annexes');

function slug(name) {
  return name
    .replace(/ Application.*$/i, '')
    .replace(/-? ?Annex A.*$/i, '')
    .replace(/\(.*?\)/g, ' ')      // drop parentheticals like (SOWP)
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const files = [];
  for (const sub of ['Permanent Applications', 'Temporary Applications']) {
    const dir = path.join(ROOT, sub);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.docx')) files.push(path.join(dir, f));
  }
  const only = process.argv[2];
  let done = 0;
  for (const f of files) {
    const name = path.basename(f);
    if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;
    const id = slug(name);
    process.stdout.write(`  ${id} … `);
    try {
      const pdf = await docxToPdf(fs.readFileSync(f), name);
      fs.writeFileSync(path.join(OUT, `${id}.pdf`), pdf);
      console.log(`ok (${pdf.length} bytes)`);
      done++;
    } catch (e) { console.log(`FAILED: ${e.message}`); }
  }
  console.log(`\nPre-rendered ${done} annex PDF(s) → ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
