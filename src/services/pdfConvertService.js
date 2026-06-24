/**
 * pdfConvertService — converts a filled .docx Buffer to a PDF Buffer via the
 * CloudConvert API (LibreOffice engine = faithful fidelity), so the app's native
 * Node deploy on Render needs no system binaries.
 *
 * Provider-agnostic seam: only `docxToPdf` is exported; swap the body to change
 * providers. Reads CLOUDCONVERT_API_KEY from the environment (never in code).
 */

'use strict';

const CloudConvert = require('cloudconvert');

let _cc = null;
function client() {
  const key = process.env.CLOUDCONVERT_API_KEY;
  if (!key) throw new Error('CLOUDCONVERT_API_KEY is not set — cannot convert the retainer to PDF.');
  if (!_cc) _cc = new CloudConvert(key);
  return _cc;
}

/**
 * Convert a .docx Buffer to a PDF Buffer.
 * @param {Buffer} docxBuffer
 * @param {string} filename  label only (CloudConvert infers format from input_format)
 * @returns {Promise<Buffer>} the PDF
 */
async function docxToPdf(docxBuffer, filename = 'document.docx') {
  const cc = client();

  let job = await cc.jobs.create({
    tasks: {
      'import-file':  { operation: 'import/upload' },
      'convert-file': { operation: 'convert', input: 'import-file', input_format: 'docx', output_format: 'pdf' },
      'export-file':  { operation: 'export/url', input: 'convert-file' },
    },
  });

  const uploadTask = job.tasks.find((t) => t.name === 'import-file');
  await cc.tasks.upload(uploadTask, docxBuffer, filename);

  job = await cc.jobs.wait(job.id); // resolves when all tasks finish (or throws on failure)

  const exportTask = job.tasks.find((t) => t.operation === 'export/url' && t.status === 'finished');
  const file = exportTask && exportTask.result && exportTask.result.files && exportTask.result.files[0];
  if (!file || !file.url) throw new Error('CloudConvert returned no exported PDF.');

  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`CloudConvert: PDF download failed (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { docxToPdf };
