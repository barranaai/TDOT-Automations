/**
 * retainerDocService — assembles a client's retainer document from TDOT's REAL
 * templates (used as-is; only the yellow merge fields are filled).
 *
 * Pipeline (per IMPLEMENTATION-PLAN.md): fill the tagged master `.docx` with
 * docxtemplater → (Phase 0b) convert to PDF via the cloud convert service →
 * append the matching pre-rendered Annex A PDF with pdf-lib.
 *
 * This file currently implements `fillMaster` (the conversion-independent core).
 * The convert + append steps land once the cloud-convert API key is provisioned.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const PizZip        = require('pizzip');
const Docxtemplater = require('docxtemplater');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'retainer');

/**
 * Fill a tagged master retainer template with per-case data.
 * @param {string} templateName  e.g. 'pa' | 'pa-inviter' | 'employer'
 * @param {object} data          merge values (missing tags render as empty, never an error)
 * @returns {Buffer} the filled .docx
 */
function fillMaster(templateName, data) {
  const file = path.join(TEMPLATES_DIR, `${templateName}.docx`);
  const content = fs.readFileSync(file, 'binary');
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '', // an unset field becomes blank — never throws mid-render
  });
  doc.render(data || {});
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { fillMaster, TEMPLATES_DIR };
