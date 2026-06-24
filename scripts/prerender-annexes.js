/**
 * One-off: pre-render the static Annex A scope documents to PDF (they have no
 * merge fields), so retainer generation just appends the right one. Run once (and
 * whenever an annex changes). Needs CLOUDCONVERT_API_KEY in .env.
 *
 * Source of truth = config/annexCatalogue (id + sourceFile), so the output
 * basenames always match what retainerDocService.loadAnnexPdf expects.
 *
 * NOTE: CloudConvert free tier ≈ 25 conversions/day — rendering all 27 may need
 * two days or a plan upgrade. Use the filter arg to do a batch.
 *
 * Usage:
 *   node scripts/prerender-annexes.js              # all 27
 *   node scripts/prerender-annexes.js P1-P8        # by code range (permanent)
 *   node scripts/prerender-annexes.js "Study"      # by label/id substring
 *   node scripts/prerender-annexes.js --missing    # only annexes not yet rendered
 */
'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { docxToPdf } = require('../src/services/pdfConvertService');
const { ANNEXES } = require('../config/annexCatalogue');

const SRC_ROOT = path.join(__dirname, '..', 'Retainer Agreement Templates', 'RCIC Roles and Responsibilities');
const OUT      = path.join(__dirname, '..', 'src', 'templates', 'retainer', 'annexes');

function selected(filterArg) {
  if (!filterArg) return ANNEXES;
  if (filterArg === '--missing') return ANNEXES.filter((a) => !fs.existsSync(path.join(OUT, `${a.id}.pdf`)));
  const m = filterArg.match(/^([PT])(\d+)-([PT])(\d+)$/i); // e.g. P1-P8, T1-T19
  if (m && m[1].toUpperCase() === m[3].toUpperCase()) {
    const lo = +m[2], hi = +m[4], grp = m[1].toUpperCase();
    return ANNEXES.filter((a) => a.code[0] === grp && +a.code.slice(1) >= lo && +a.code.slice(1) <= hi);
  }
  const f = filterArg.toLowerCase();
  return ANNEXES.filter((a) => a.id.includes(f) || a.label.toLowerCase().includes(f) || a.code.toLowerCase() === f);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = selected(process.argv[2]);
  if (!list.length) { console.log('No annexes match the filter.'); return; }
  console.log(`Rendering ${list.length} annex(es)…`);
  let done = 0;
  for (const a of list) {
    process.stdout.write(`  ${a.code} ${a.id} … `);
    try {
      const src = path.join(SRC_ROOT, a.sourceFile);
      const pdf = await docxToPdf(fs.readFileSync(src), `${a.id}.docx`);
      fs.writeFileSync(path.join(OUT, `${a.id}.pdf`), pdf);
      console.log(`ok (${pdf.length} bytes)`);
      done++;
    } catch (e) { console.log(`FAILED: ${e.message}`); }
  }
  console.log(`\nPre-rendered ${done}/${list.length} → ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
