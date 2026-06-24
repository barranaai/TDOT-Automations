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
const { PDFDocument } = require('pdf-lib');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'retainer');
const ANNEX_DIR     = path.join(TEMPLATES_DIR, 'annexes'); // pre-rendered annex PDFs

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

/**
 * Append annex PDF pages onto a master PDF.
 * @param {Buffer} masterPdf
 * @param {Buffer|null} annexPdf  null/absent → returns the master unchanged
 * @returns {Promise<Buffer>} combined PDF
 */
async function appendPdf(masterPdf, annexPdf) {
  const out = await PDFDocument.load(masterPdf);
  if (annexPdf) {
    const annex = await PDFDocument.load(annexPdf);
    const pages = await out.copyPages(annex, annex.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

/** Load a pre-rendered annex PDF by id (e.g. 'cec'), or null if not present. */
function loadAnnexPdf(annexId) {
  if (!annexId) return null;
  const file = path.join(ANNEX_DIR, `${annexId}.pdf`);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

/**
 * Full retainer pipeline: fill master → convert to PDF → append the scope annex.
 * @param {{ template: string, data: object, annexId?: string }} params
 * @returns {Promise<Buffer>} the combined retainer PDF
 */
async function generate({ template, data, annexId }) {
  const { docxToPdf } = require('./pdfConvertService'); // lazy: only needed at generation time
  const filledDocx = fillMaster(template, data);
  const masterPdf  = await docxToPdf(filledDocx, `retainer-${template}.docx`);
  return appendPdf(masterPdf, loadAnnexPdf(annexId));
}

module.exports = { fillMaster, appendPdf, loadAnnexPdf, generate, TEMPLATES_DIR, ANNEX_DIR };
