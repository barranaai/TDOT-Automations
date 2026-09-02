/**
 * Questionnaire PDF Service
 *
 * Generates a clean, audit-style PDF of a submitted questionnaire and saves it
 * to OneDrive alongside the JSON data file.
 *
 * Output path:
 *   Client Documents/{Client Name} - {CaseRef}/Questionnaire/questionnaire-{caseRef}-{formKey}.pdf
 *
 * Behaviour:
 *   - Overwrites any previous PDF for the same formKey (OneDrive keeps its own
 *     version history, so we don't manage versions ourselves).
 *   - Never throws — caller should still fire-and-forget, but internal errors
 *     are caught and logged so a PDF failure never blocks the submit flow.
 *   - Reads the source fields directly from the OneDrive JSON so the PDF
 *     always reflects exactly what was persisted.
 */

const PDFDocument = require('pdfkit');
const oneDrive    = require('./oneDriveService');

const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';

// ─── Layout constants ────────────────────────────────────────────────────────

const BRAND_NAVY  = '#1e3a5f';
const TEXT_BODY   = '#1e293b';
const TEXT_MUTED  = '#6b7280';
const RULE_COLOR  = '#e5e7eb';
const SECTION_BG  = '#f8fafc';

// bottom margin is tight so the footer (drawn at height - 40) sits inside the
// writable area and doesn't trigger PDFKit's overflow-driven page flow.
// Content page breaks use CONTENT_BOTTOM explicitly below.
const PAGE_MARGINS   = { top: 60, bottom: 30, left: 54, right: 54 };
const CONTENT_BOTTOM = 70;   // content must stop this many pt above the page bottom

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    year:     'numeric',
    month:    'long',
    day:      'numeric',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  });
}

/**
 * Group fields by their section breadcrumb, preserving first-seen order.
 * Returns an array of { section, rows: [{ label, value }] }.
 */
function groupBySection(fields) {
  const order   = [];
  const buckets = new Map();

  for (const f of fields || []) {
    const sec = (f.section && f.section.trim()) || 'General';
    if (!buckets.has(sec)) {
      buckets.set(sec, []);
      order.push(sec);
    }
    buckets.get(sec).push({
      label: f.label || '(Untitled field)',
      value: (f.value == null ? '' : String(f.value)).trim(),
      key:   f.key || '',
    });
  }

  return order.map(section => ({ section, rows: buckets.get(section) }));
}

/**
 * Detect a dynamic-table field and return { row, column } or null.
 * Keys like "personal-info__members--1-first-name" end in "-{rowNum}-{col}".
 * The key itself isn't reliable for reconstructing tables cross-form, so we
 * fall back to parsing the label: "Row 1 — First Name" style or a numeric prefix.
 * For v1 we simply render row-keyed fields inline — acceptable for audit fidelity.
 */

// ─── Page chrome (header on page 1 + footer on every page) ───────────────────

function drawFooter(doc, caseRef, pageNum, totalPages, generatedStr) {
  const { width, height } = doc.page;
  const y     = height - 40;
  const left  = PAGE_MARGINS.left;
  const innerW = width - PAGE_MARGINS.left - PAGE_MARGINS.right;

  doc.save();
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica');

  const leftText  = `TDOT Immigration · Case ${caseRef}`;
  const midText   = `Page ${pageNum} of ${totalPages}`;
  const rightText = `Generated ${generatedStr}`;

  // All three at the same y, same width — render with different alignments.
  // lineBreak:false prevents any overflow-driven page flow.
  doc.text(leftText,  left, y, { width: innerW, align: 'left',   lineBreak: false });
  doc.text(midText,   left, y, { width: innerW, align: 'center', lineBreak: false });
  doc.text(rightText, left, y, { width: innerW, align: 'right',  lineBreak: false });

  doc.restore();
}

function drawCoverBlock(doc, { formLabel, clientName, caseRef, memberLabel, completionPct, submittedAt, submitted = true }) {
  const { width } = doc.page;
  const leftX = PAGE_MARGINS.left;
  const rightEdge = width - PAGE_MARGINS.right;

  // Brand line
  doc.fillColor(BRAND_NAVY).font('Helvetica-Bold').fontSize(18)
     .text('TDOT IMMIGRATION', leftX, PAGE_MARGINS.top, { lineBreak: false });

  doc.fillColor(TEXT_MUTED).font('Helvetica').fontSize(10)
     .text('Client Questionnaire', leftX, PAGE_MARGINS.top + 22, { lineBreak: false });

  // Rule
  const ruleY = PAGE_MARGINS.top + 42;
  doc.moveTo(leftX, ruleY).lineTo(rightEdge, ruleY)
     .lineWidth(0.75).strokeColor(RULE_COLOR).stroke();

  // Meta rows
  const rows = [
    ['Form',       formLabel || '(Unknown)'],
    ['Client',     clientName || '(Unknown)'],
    ['Case Ref',   caseRef],
  ];
  if (memberLabel && memberLabel !== 'Primary Applicant') rows.push(['Member', memberLabel]);
  rows.push(['Completion', `${Math.max(0, Math.min(100, Math.round(completionPct || 0)))}%`]);
  // A DRAFT save (client still working) must never read as a submission —
  // the same file is overwritten on every save, so the cover states the truth.
  if (submitted) {
    rows.push(['Status', 'Submitted'], ['Submitted', formatTimestamp(submittedAt)]);
  } else {
    rows.push(['Status', 'In progress — not yet submitted'], ['Last saved', formatTimestamp(submittedAt)]);
  }

  let y = ruleY + 14;
  doc.fontSize(10);
  for (const [label, value] of rows) {
    doc.fillColor(TEXT_MUTED).font('Helvetica-Bold')
       .text(label, leftX, y, { width: 90, lineBreak: false });
    doc.fillColor(TEXT_BODY).font('Helvetica')
       .text(value, leftX + 95, y, {
         width: rightEdge - leftX - 95,
         lineBreak: true,
       });
    y = doc.y + 4;
  }

  // Closing rule
  const endY = y + 6;
  doc.moveTo(leftX, endY).lineTo(rightEdge, endY)
     .lineWidth(0.75).strokeColor(RULE_COLOR).stroke();

  doc.y = endY + 14;
}

function drawSectionHeading(doc, title) {
  const { width } = doc.page;
  const leftX = PAGE_MARGINS.left;
  const rightEdge = width - PAGE_MARGINS.right;

  // Space check — heading + at least one row (~30pt) should fit on the page
  if (doc.y + 40 > doc.page.height - CONTENT_BOTTOM) doc.addPage();

  const padX = 10;
  const padY = 6;
  const h    = 22;
  const y    = doc.y;

  doc.save();
  doc.rect(leftX, y, rightEdge - leftX, h).fill(SECTION_BG);
  doc.restore();

  doc.fillColor(TEXT_MUTED).font('Helvetica-Bold').fontSize(9)
     .text(title.toUpperCase(), leftX + padX, y + padY, {
       width: rightEdge - leftX - padX * 2,
       lineBreak: false,
       characterSpacing: 0.8,
     });

  doc.y = y + h + 8;
}

function drawFieldRow(doc, label, value) {
  const { width } = doc.page;
  const leftX = PAGE_MARGINS.left;
  const rightEdge = width - PAGE_MARGINS.right;

  const labelW = 170;
  const valueX = leftX + labelW + 12;
  const valueW = rightEdge - valueX;

  // Measure both columns' heights at the current widths, take the larger
  doc.font('Helvetica-Bold').fontSize(9);
  const labelH = doc.heightOfString(label, { width: labelW, lineGap: 2 });

  const hasValue = Boolean(value && value.trim());
  const renderedValue = hasValue ? value : '— not answered —';

  doc.font(hasValue ? 'Helvetica' : 'Helvetica-Oblique').fontSize(10);
  const valueH = doc.heightOfString(renderedValue, { width: valueW, lineGap: 2 });

  const rowH = Math.max(labelH, valueH) + 10;

  // Page break if this row would overflow
  if (doc.y + rowH > doc.page.height - CONTENT_BOTTOM) {
    doc.addPage();
  }

  const y0 = doc.y;

  doc.fillColor(TEXT_MUTED).font('Helvetica-Bold').fontSize(9)
     .text(label, leftX, y0, { width: labelW, lineGap: 2 });

  doc.fillColor(hasValue ? TEXT_BODY : TEXT_MUTED)
     .font(hasValue ? 'Helvetica' : 'Helvetica-Oblique').fontSize(10)
     .text(renderedValue, valueX, y0, { width: valueW, lineGap: 2 });

  // Row divider
  const endY = Math.max(y0 + labelH, y0 + valueH) + 4;
  doc.moveTo(leftX, endY).lineTo(rightEdge, endY)
     .lineWidth(0.25).strokeColor(RULE_COLOR).stroke();

  doc.y = endY + 6;
}

// ─── Build PDF buffer from field data ────────────────────────────────────────

function buildPdfBuffer({ clientName, caseRef, formLabel, memberLabel, completionPct, submittedAt, fields, submitted = true }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size:        'LETTER',
        margins:     PAGE_MARGINS,
        bufferPages: true,   // enables switchToPage() for footer pass
        info: {
          Title:    `Questionnaire — ${caseRef}${memberLabel ? ' — ' + memberLabel : ''}`,
          Author:   'TDOT Immigration',
          Subject:  formLabel || 'Client Questionnaire',
          Keywords: `questionnaire, ${caseRef}`,
        },
      });

      const chunks = [];
      doc.on('data',  (c) => chunks.push(c));
      doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // First page cover
      drawCoverBlock(doc, { formLabel, clientName, caseRef, memberLabel, completionPct, submittedAt });

      // Body
      const sections = groupBySection(fields);
      if (!sections.length) {
        doc.fillColor(TEXT_MUTED).font('Helvetica-Oblique').fontSize(10)
           .text('No responses were recorded for this submission.', {
             width: doc.page.width - PAGE_MARGINS.left - PAGE_MARGINS.right,
           });
      } else {
        for (const { section, rows } of sections) {
          drawSectionHeading(doc, section);
          for (const row of rows) drawFieldRow(doc, row.label, row.value);
          doc.y += 6;
        }
      }

      // Single-pass footer render — now we know the final page count.
      const generatedStr = formatTimestamp();
      const range        = doc.bufferedPageRange();
      const totalPages   = range.count;
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        drawFooter(doc, caseRef, i - range.start + 1, totalPages, generatedStr);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate the submission PDF and save it to OneDrive.
 * Fire-and-forget from the caller: errors are caught and logged here so the
 * submit flow never fails because of PDF trouble.
 *
 * @param {{ clientName, caseRef, formKey, formLabel, memberLabel,
 *          completionPct, submittedAt?, fields? }} params
 *   fields is optional — if omitted, the JSON is read from OneDrive.
 */
async function generateAndSaveSubmissionPdf(params) {
  const { clientName, caseRef, formKey, formLabel, memberLabel, completionPct, submittedAt } = params;
  const submitted = params.submitted !== undefined ? !!params.submitted : true;
  let { fields } = params;

  if (!clientName || !caseRef || !formKey) {
    console.warn('[QPdf] Missing clientName/caseRef/formKey — skipping PDF generation');
    return;
  }

  try {
    // If fields weren't passed in, read the freshly-saved JSON from OneDrive.
    if (!Array.isArray(fields)) {
      const jsonBuf = await oneDrive.readFile({
        clientName,
        caseRef,
        subfolder: QUESTIONNAIRE_SUBFOLDER,
        filename:  `questionnaire-${caseRef}-${formKey}.json`,
      });
      if (!jsonBuf) {
        console.warn(`[QPdf] No JSON found for ${caseRef}/${formKey} — skipping PDF`);
        return;
      }
      const parsed = JSON.parse(jsonBuf.toString('utf8'));
      fields = Array.isArray(parsed) ? parsed : (parsed.fields || []);
    }

    const buffer = await buildPdfBuffer({
      clientName,
      caseRef,
      formLabel,
      memberLabel,
      completionPct,
      submittedAt: submittedAt || new Date().toISOString(),
      fields,
      submitted,
    });

    const filename = `questionnaire-${caseRef}-${formKey}.pdf`;
    await oneDrive.uploadFile({
      clientName,
      caseRef,
      category: QUESTIONNAIRE_SUBFOLDER,
      filename,
      buffer,
      mimeType: 'application/pdf',
    });

    console.log(`[QPdf] Saved ${submitted ? 'submission' : 'draft'} PDF → ${filename} (${buffer.length} bytes, ${fields.length} fields)`);
  } catch (err) {
    console.warn(`[QPdf] PDF generation/upload failed for ${caseRef}/${formKey}: ${err.message}`);
  }
}

/**
 * DRAFT PDFs on every save (user request 2026-08-29): the SAME file
 * questionnaire-{caseRef}-{formKey}.pdf is overwritten, so staff always see
 * one current PDF per form (no version clutter; OneDrive keeps history).
 *
 * Trigger policy — the autosave fires every 60s while the client types, so a
 * PDF per autosave would churn hundreds of overwrites per session. Instead:
 *   - a MANUAL "Save Progress" (or submit) regenerates immediately, and
 *   - autosaves are THROTTLED per form: the first autosave in a window
 *     schedules one PDF DRAFT_PDF_THROTTLE_MS later, built from the LATEST
 *     fields seen when it fires; later autosaves in the window just refresh
 *     those fields. A manual save flushes and cancels the pending one.
 * Fire-and-forget: never throws, never blocks the JSON save (the truth).
 */
const DRAFT_PDF_THROTTLE_MS = (() => {
  const n = Number(process.env.DRAFT_PDF_THROTTLE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
})();
const _draftPending = new Map(); // "caseRef|formKey" → { timer, params }

function scheduleDraftPdf(params, { immediate = false } = {}) {
  const key = `${params.caseRef}|${params.formKey}`;
  // Called via module.exports so tests can stub the generator.
  const run = (p) => module.exports.generateAndSaveSubmissionPdf({ ...p, submitted: false, submittedAt: p.savedAt || new Date().toISOString() })
    .catch((err) => console.warn(`[QPdf] draft PDF failed for ${key}: ${err.message}`));
  const pending = _draftPending.get(key);
  if (immediate) {
    if (pending) { clearTimeout(pending.timer); _draftPending.delete(key); }
    return run(params);
  }
  if (pending) { pending.params = params; return; }   // keep the window, refresh the fields
  const timer = setTimeout(() => {
    const p = _draftPending.get(key);
    _draftPending.delete(key);
    if (p) run(p.params);
  }, DRAFT_PDF_THROTTLE_MS);
  if (timer.unref) timer.unref();
  _draftPending.set(key, { timer, params });
}

/** Test seam: pending draft windows (keys) — not for production use. */
function _pendingDraftKeys() { return [..._draftPending.keys()]; }

module.exports = { generateAndSaveSubmissionPdf, scheduleDraftPdf, buildPdfBuffer, DRAFT_PDF_THROTTLE_MS, _pendingDraftKeys };
