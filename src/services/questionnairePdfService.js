/**
 * Questionnaire PDF Service
 *
 * Generates a clean, consultant-readable PDF of a questionnaire and saves it
 * to OneDrive alongside the JSON data file.
 *
 * Output path:
 *   Client Documents/{Client Name} - {CaseRef}/Questionnaire/questionnaire-{caseRef}-{formKey}.pdf
 *
 * Behaviour:
 *   - ONE file per form, overwritten on every submit and (throttled) on every
 *     save — OneDrive keeps its own version history, so we never manage
 *     versions ourselves.
 *   - Never throws to the caller; a PDF failure never blocks a save/submit.
 *   - Reads the fields it is given (or the freshly-saved JSON) so the PDF
 *     always reflects exactly what was persisted.
 *
 * Layout (redesigned 2026-08-29 for readability + easy copy by consultants):
 *   - every page carries a running header (client · case · member · status);
 *   - the section path "Part › Section › Sub-section" becomes a real
 *     hierarchy: a part heading when the part changes, then a sub-heading;
 *   - dynamic tables ("… › Table" sections with "Label — Row N" cells) are
 *     rendered as REAL GRIDS — header row, one row per entry, wrapped cells,
 *     header repeated after a page break — instead of a long label list;
 *   - plain fields are label / value on one baseline so a copied row reads
 *     "Label   value"; empty answers show a quiet "—" (consultants see gaps
 *     without the page being dominated by "not answered").
 */

const PDFDocument = require('pdfkit');
const oneDrive    = require('./oneDriveService');

const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';

// ─── Palette / metrics ───────────────────────────────────────────────────────

const NAVY       = '#1e3a5f';
const ACCENT     = '#C9A84C';
const TEXT_BODY  = '#111827';
const TEXT_MUTED = '#6b7280';
const RULE       = '#e5e7eb';
const BAND       = '#f3f4f6';
const ZEBRA      = '#fafafa';
const TABLE_HEAD = '#eef2f7';

const PAGE_MARGINS   = { top: 64, bottom: 30, left: 48, right: 48 };
const CONTENT_BOTTOM = 62;   // content stops this many pt above the page bottom (footer lives below)
const LABEL_W        = 190;  // plain-field label column width

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' (Toronto)';
}

const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

// ─── Layout model (pure; exported for tests) ─────────────────────────────────
//
// Input:  saved fields [{ section, label, key, value }]
// Output: ordered blocks:
//   { type: 'part',   title }                                   — top-level part changed
//   { type: 'fields', title, rows: [{ label, value }] }         — plain sub-section
//   { type: 'table',  title, columns: [...], rows: [[cell,…]] } — dynamic table

const ROW_RE = /^(.*?)\s+[—–-]\s+Row\s+(\d+)\s*$/i;
// Dynamic-table cell keys carry the table id: "…-tbl-tbl-{tableId}-r{N}-{column}".
// Several tables can live under ONE section title (Relationship Story holds
// visits / friends / ceremonies) — the id is what tells them apart.
const TABLE_ID_RE = /-tbl-tbl-([a-z0-9-]+?)-r\d+-/i;
const MAX_GRID_COLS = 7; // wider tables are rendered as records (one entry = label/value rows)

function splitPath(section) {
  return clean(section || 'General').split(/\s*›\s*/).filter(Boolean);
}

function humanizeTableId(id) {
  return String(id || '').replace(/^(ma|sp|pa|rel|main|sponsor|applicant|dep|inv)-/, '')
    .split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function buildLayoutModel(fields) {
  const blocks = [];
  let currentPart = null;
  let open = null; // the block currently being filled (fields or table)

  const flush = () => { if (open) { blocks.push(open); open = null; } };

  for (const f of fields || []) {
    const parts = splitPath(f.section);
    const label = clean(f.label || '(Untitled field)');
    const value = clean(f.value);
    const idMatch = TABLE_ID_RE.exec(String(f.key || ''));
    const tableId = idMatch ? idMatch[1].toLowerCase() : '';
    // A table cell is a "… › Table" section, or a "Label — Row N" cell whose key
    // carries a table id (some forms keep table cells under the plain section).
    const isTable = parts[parts.length - 1].toLowerCase() === 'table' || (Boolean(tableId) && ROW_RE.test(label));
    if (parts[parts.length - 1].toLowerCase() === 'table') parts.pop();
    const part  = parts.length > 1 ? parts[0] : null;
    const title = (parts.length > 1 ? parts.slice(1) : parts).join(' › ') || 'General';

    if (part !== currentPart) { flush(); currentPart = part; if (part) blocks.push({ type: 'part', title: part }); }

    if (isTable) {
      const m = ROW_RE.exec(label);
      const col = m ? clean(m[1]) : label;
      const row = m ? parseInt(m[2], 10) : 1;
      if (!open || open.type !== 'table' || open.title !== title || open.tableId !== tableId) {
        flush();
        open = { type: 'table', title, tableId, sub: humanizeTableId(tableId), columns: [], rows: [] };
      }
      if (!open.columns.includes(col)) open.columns.push(col);
      while (open.rows.length < row) open.rows.push([]);
      open.rows[row - 1][open.columns.indexOf(col)] = value;
    } else {
      if (!open || open.type !== 'fields' || open.title !== title) {
        flush();
        open = { type: 'fields', title, rows: [] };
      }
      open.rows.push({ label, value });
    }
  }
  flush();

  // Saved field order can interleave parts (Main Applicant › … then Sponsor › …
  // then Main Applicant again). Regroup so each PART appears ONCE, in
  // first-seen order, with its sub-sections contiguous — one heading per part.
  const grouped = [];
  const partIndex = new Map(); // part title → index of its 'part' block in grouped
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'part') {
      cur = b.title;
      if (!partIndex.has(cur)) { partIndex.set(cur, grouped.length); grouped.push(b); }
      continue;
    }
    if (cur && partIndex.has(cur)) {
      // insert after the last block belonging to this part
      let at = partIndex.get(cur) + 1;
      while (at < grouped.length && grouped[at].type !== 'part') at++;
      grouped.splice(at, 0, b);
    } else {
      grouped.push(b);
    }
  }
  blocks.length = 0; blocks.push(...grouped);

  // Normalise table rows to full column count; drop rows that are entirely empty.
  // When several tables share one section title, label each with its table name.
  const titleCount = new Map();
  for (const b of blocks) if (b.type === 'table') titleCount.set(b.title, (titleCount.get(b.title) || 0) + 1);
  for (const b of blocks) {
    if (b.type !== 'table') continue;
    b.rows = b.rows
      .map((r) => b.columns.map((_, i) => r[i] == null ? '' : r[i]))
      .filter((r) => r.some((c) => c !== ''));
    if (titleCount.get(b.title) > 1 && b.sub) b.title = `${b.title} · ${b.sub}`;
    delete b.tableId; delete b.sub;
  }
  return blocks;
}

// ─── Page chrome ─────────────────────────────────────────────────────────────

function pageWidth(doc) { return doc.page.width - PAGE_MARGINS.left - PAGE_MARGINS.right; }

function drawRunningHeader(doc, ctx) {
  const left = PAGE_MARGINS.left, right = doc.page.width - PAGE_MARGINS.right, y = 24;
  doc.save();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY)
     .text('TDOT IMMIGRATION', left, y, { lineBreak: false });
  const meta = [ctx.clientName, ctx.caseRef, ctx.memberLabel && ctx.memberLabel !== 'Primary Applicant' ? ctx.memberLabel : null, ctx.submitted ? 'Submitted' : 'In progress']
    .filter(Boolean).join('  ·  ');
  doc.font('Helvetica').fontSize(8).fillColor(TEXT_MUTED)
     .text(meta, left, y, { width: right - left, align: 'right', lineBreak: false });
  doc.moveTo(left, y + 14).lineTo(right, y + 14).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.restore();
}

function drawFooter(doc, caseRef, pageNum, totalPages, generatedStr) {
  const { width, height } = doc.page;
  const y = height - 40, left = PAGE_MARGINS.left, innerW = width - PAGE_MARGINS.left - PAGE_MARGINS.right;
  doc.save();
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica');
  doc.text(`Case ${caseRef}`, left, y, { width: innerW, align: 'left',   lineBreak: false });
  doc.text(`Page ${pageNum} of ${totalPages}`, left, y, { width: innerW, align: 'center', lineBreak: false });
  doc.text(`Generated ${generatedStr}`, left, y, { width: innerW, align: 'right',  lineBreak: false });
  doc.restore();
}

function ensureSpace(doc, needed, ctx) {
  if (doc.y + needed > doc.page.height - CONTENT_BOTTOM) {
    doc.addPage();
    drawRunningHeader(doc, ctx);
    doc.y = PAGE_MARGINS.top;
  }
}

// ─── Cover ───────────────────────────────────────────────────────────────────

function drawCoverBlock(doc, { formLabel, clientName, caseRef, memberLabel, completionPct, submittedAt, submitted = true, blocks = [] }) {
  const leftX = PAGE_MARGINS.left, rightEdge = doc.page.width - PAGE_MARGINS.right, W = rightEdge - leftX;

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text('Client Questionnaire', leftX, PAGE_MARGINS.top, { lineBreak: false });
  doc.fillColor(TEXT_MUTED).font('Helvetica').fontSize(10).text(formLabel || 'Questionnaire', leftX, PAGE_MARGINS.top + 26, { width: W });
  let y = doc.y + 10;
  doc.moveTo(leftX, y).lineTo(rightEdge, y).lineWidth(1).strokeColor(ACCENT).stroke();
  y += 12;

  // Meta rows
  const rows = [
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
  for (const [label, value] of rows) {
    doc.font('Helvetica').fontSize(10);
    const h = Math.max(doc.heightOfString(value, { width: W - 96 }), 12);
    doc.fillColor(TEXT_MUTED).font('Helvetica-Bold').fontSize(10).text(label, leftX, y, { width: 90, lineBreak: false });
    doc.fillColor(TEXT_BODY).font('Helvetica').fontSize(10).text(value, leftX + 96, y, { width: W - 96 });
    y += h + 5;
  }

  // Contents — parts and sub-sections, so a consultant can scan to what they need.
  const parts = blocks.filter((b) => b.type === 'part');
  if (blocks.length) {
    y += 14;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('Contents', leftX, y, { lineBreak: false });
    y += 18;
    const lines = [];
    const describe = (b) => b.type === 'table'
      ? `${b.title}  (table · ${b.rows.length ? `${b.rows.length} ${b.rows.length === 1 ? 'row' : 'rows'}` : 'no entries'})`
      : b.title;
    if (parts.length) {
      let cur = null;
      for (const b of blocks) {
        if (b.type === 'part') { cur = b.title; lines.push({ text: b.title, indent: 0, bold: true }); }
        else lines.push({ text: describe(b), indent: cur ? 14 : 0, bold: false });
      }
    } else {
      for (const b of blocks) lines.push({ text: describe(b), indent: 0, bold: false });
    }
    for (const l of lines) {
      if (y > doc.page.height - CONTENT_BOTTOM - 14) break; // keep the cover to one page
      doc.fillColor(l.bold ? TEXT_BODY : TEXT_MUTED).font(l.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
         .text(l.text, leftX + l.indent, y, { width: W - l.indent, lineBreak: false });
      y += 13;
    }
  }
  doc.y = y + 8;
}

// ─── Body blocks ─────────────────────────────────────────────────────────────

function drawPartHeading(doc, title, ctx) {
  ensureSpace(doc, 46, ctx);
  const leftX = PAGE_MARGINS.left, W = pageWidth(doc), y = doc.y + 6;
  doc.save();
  doc.rect(leftX, y, 4, 20).fill(ACCENT);
  doc.restore();
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14).text(title, leftX + 12, y + 2, { width: W - 12, lineBreak: false });
  doc.y = y + 30;
}

function drawSectionHeading(doc, title, ctx) {
  ensureSpace(doc, 40, ctx);
  const leftX = PAGE_MARGINS.left, W = pageWidth(doc), y = doc.y, h = 20;
  doc.save();
  doc.rect(leftX, y, W, h).fill(BAND);
  doc.restore();
  doc.fillColor(TEXT_BODY).font('Helvetica-Bold').fontSize(9.5)
     .text(title, leftX + 8, y + 5.5, { width: W - 16, lineBreak: false });
  doc.y = y + h + 6;
}

function drawFieldRow(doc, label, value, ctx, zebra) {
  const leftX = PAGE_MARGINS.left, rightEdge = doc.page.width - PAGE_MARGINS.right;
  const valueX = leftX + LABEL_W + 10, valueW = rightEdge - valueX - 6;
  const hasValue = Boolean(value);
  const shown = hasValue ? value : '—';

  doc.font('Helvetica').fontSize(9);
  const labelH = doc.heightOfString(label, { width: LABEL_W - 12, lineGap: 1.5 });
  doc.font('Helvetica').fontSize(10);
  const valueH = doc.heightOfString(shown, { width: valueW, lineGap: 1.5 });
  const rowH = Math.max(labelH, valueH) + 8;
  ensureSpace(doc, rowH, ctx);

  const y0 = doc.y;
  if (zebra) { doc.save(); doc.rect(leftX, y0 - 2, rightEdge - leftX, rowH).fill(ZEBRA); doc.restore(); }
  doc.fillColor(TEXT_MUTED).font('Helvetica').fontSize(9).text(label, leftX + 6, y0 + 2, { width: LABEL_W - 12, lineGap: 1.5 });
  doc.fillColor(hasValue ? TEXT_BODY : TEXT_MUTED).font('Helvetica').fontSize(10)
     .text(shown, valueX, y0 + 1, { width: valueW, lineGap: 1.5 });
  doc.y = y0 + rowH;
}

// Column widths: every column gets at least its longest single WORD (so
// "PUDUCHERRY" never breaks into "PUDUCH / ERRY"), the remaining width is
// shared in proportion to content length. Returns null when even the
// word-minimums cannot fit — the caller then uses the record layout.
function tableColumnWidths(doc, columns, rows, totalW) {
  const longestWord = (s, font, size) => {
    doc.font(font).fontSize(size);
    return Math.max(0, ...String(s || '').split(/\s+/).map((w) => doc.widthOfString(w)));
  };
  const fullWidth = (s, font, size) => { doc.font(font).fontSize(size); return doc.widthOfString(String(s || '')); };
  const need = columns.map((c, i) => {
    let w = longestWord(c, 'Helvetica-Bold', 8.5);
    for (const r of rows) w = Math.max(w, longestWord(r[i], 'Helvetica', 9));
    return Math.min(w, 220) + 10;   // a single very long token (an email) may still wrap
  });
  const want = columns.map((c, i) => {
    let w = fullWidth(c, 'Helvetica-Bold', 8.5) + 12;
    for (const r of rows) w = Math.max(w, Math.min(fullWidth(r[i], 'Helvetica', 9) + 12, 200));
    return Math.max(need[i], w);
  });
  const needSum = need.reduce((a, b) => a + b, 0);
  if (needSum > totalW) return null;
  const extra = totalW - needSum;
  const growth = want.map((w, i) => w - need[i]);
  const gsum = growth.reduce((a, b) => a + b, 0) || 1;
  return need.map((n, i) => n + extra * (growth[i] / gsum));
}

function drawTableHeader(doc, columns, widths, ctx) {
  const leftX = PAGE_MARGINS.left, W = pageWidth(doc);
  doc.font('Helvetica-Bold').fontSize(8.5);
  let h = 0;
  columns.forEach((c, i) => { h = Math.max(h, doc.heightOfString(c, { width: widths[i] - 8 })); });
  h += 8;
  ensureSpace(doc, h + 24, ctx);
  const y = doc.y;
  doc.save(); doc.rect(leftX, y, W, h).fill(TABLE_HEAD); doc.restore();
  let x = leftX;
  columns.forEach((c, i) => {
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8.5).text(c, x + 4, y + 4, { width: widths[i] - 8 });
    x += widths[i];
  });
  doc.y = y + h;
}

// Wide tables (more columns than fit legibly) → one "Entry N" block per row,
// label / value lines: readable, and each line copies as "Label   value".
function drawRecords(doc, block, ctx) {
  block.rows.forEach((row, ri) => {
    ensureSpace(doc, 40, ctx);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
       .text(`Entry ${ri + 1}`, PAGE_MARGINS.left + 6, doc.y + 2, { lineBreak: false });
    doc.y += 16;
    block.columns.forEach((col, i) => drawFieldRow(doc, col, row[i], ctx, i % 2 === 1));
    doc.y += 6;
  });
  doc.y += 4;
}

function drawTable(doc, block, ctx) {
  drawSectionHeading(doc, block.title, ctx);
  if (!block.rows.length) {
    doc.fillColor(TEXT_MUTED).font('Helvetica-Oblique').fontSize(9).text('— no entries —', PAGE_MARGINS.left + 6, doc.y, { lineBreak: false });
    doc.y += 16;
    return;
  }
  if (block.columns.length > MAX_GRID_COLS) return drawRecords(doc, block, ctx);
  const leftX = PAGE_MARGINS.left, W = pageWidth(doc);
  const widths = tableColumnWidths(doc, block.columns, block.rows, W);
  if (!widths) return drawRecords(doc, block, ctx);   // words would not fit → records
  drawTableHeader(doc, block.columns, widths, ctx);

  block.rows.forEach((row, ri) => {
    doc.font('Helvetica').fontSize(9);
    let h = 0;
    row.forEach((cell, i) => { h = Math.max(h, doc.heightOfString(cell || '—', { width: widths[i] - 8, lineGap: 1 })); });
    h += 8;
    if (doc.y + h > doc.page.height - CONTENT_BOTTOM) {
      doc.addPage(); drawRunningHeader(doc, ctx); doc.y = PAGE_MARGINS.top;
      drawTableHeader(doc, block.columns, widths, ctx);   // repeat the header after a break
    }
    const y = doc.y;
    if (ri % 2 === 1) { doc.save(); doc.rect(leftX, y, W, h).fill(ZEBRA); doc.restore(); }
    let x = leftX;
    row.forEach((cell, i) => {
      const has = Boolean(cell);
      doc.fillColor(has ? TEXT_BODY : TEXT_MUTED).font('Helvetica').fontSize(9)
         .text(has ? cell : '—', x + 4, y + 4, { width: widths[i] - 8, lineGap: 1 });
      x += widths[i];
    });
    doc.moveTo(leftX, y + h).lineTo(leftX + W, y + h).lineWidth(0.25).strokeColor(RULE).stroke();
    doc.y = y + h;
  });
  doc.y += 10;
}

// ─── Build PDF buffer from field data ────────────────────────────────────────

function buildPdfBuffer({ clientName, caseRef, formLabel, memberLabel, completionPct, submittedAt, fields, submitted = true }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER', margins: PAGE_MARGINS, bufferPages: true,
        info: {
          Title:    `Questionnaire — ${caseRef}${memberLabel ? ' — ' + memberLabel : ''}`,
          Author:   'TDOT Immigration',
          Subject:  formLabel || 'Client Questionnaire',
          Keywords: `questionnaire, ${caseRef}`,
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const blocks = buildLayoutModel(fields);
      const ctx = { clientName, caseRef, memberLabel, submitted };

      drawRunningHeader(doc, ctx);
      drawCoverBlock(doc, { formLabel, clientName, caseRef, memberLabel, completionPct, submittedAt, submitted, blocks });

      if (!blocks.length) {
        doc.fillColor(TEXT_MUTED).font('Helvetica-Oblique').fontSize(10)
           .text('No responses were recorded.', { width: pageWidth(doc) });
      } else {
        // Body starts on a fresh page so the cover/contents stay clean.
        doc.addPage(); drawRunningHeader(doc, ctx); doc.y = PAGE_MARGINS.top;
        for (const b of blocks) {
          if (b.type === 'part') { drawPartHeading(doc, b.title, ctx); continue; }
          if (b.type === 'table') { drawTable(doc, b, ctx); continue; }
          drawSectionHeading(doc, b.title, ctx);
          b.rows.forEach((r, i) => drawFieldRow(doc, r.label, r.value, ctx, i % 2 === 1));
          doc.y += 8;
        }
      }

      const generatedStr = formatTimestamp();
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        drawFooter(doc, caseRef, i - range.start + 1, range.count, generatedStr);
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate the PDF and save it to OneDrive. Fire-and-forget from the caller:
 * errors are caught and logged here so a save/submit never fails because of
 * PDF trouble. `submitted` (default true) picks the cover wording.
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
    if (!Array.isArray(fields)) {
      const jsonBuf = await oneDrive.readFile({ clientName, caseRef, subfolder: QUESTIONNAIRE_SUBFOLDER, filename: `questionnaire-${caseRef}-${formKey}.json` });
      if (!jsonBuf) { console.warn(`[QPdf] No JSON found for ${caseRef}/${formKey} — skipping PDF`); return; }
      const parsed = JSON.parse(jsonBuf.toString('utf8'));
      fields = Array.isArray(parsed) ? parsed : (parsed.fields || []);
    }
    const buffer = await buildPdfBuffer({
      clientName, caseRef, formLabel, memberLabel, completionPct,
      submittedAt: submittedAt || new Date().toISOString(), fields, submitted,
    });
    const filename = `questionnaire-${caseRef}-${formKey}.pdf`;
    await oneDrive.uploadFile({ clientName, caseRef, category: QUESTIONNAIRE_SUBFOLDER, filename, buffer, mimeType: 'application/pdf' });
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

// ─── One-time regeneration from the JSON truth files (admin-driven) ──────────

const MEMBERS_PREFIX   = 'questionnaire-members-';
const RECENT_WINDOW_MS = 15 * 60 * 1000;   // a form saved this recently may have a live client on it → skip, re-run later
const MONTHS_RE        = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const formTitleFromFile = (file) => String(file || '')
  .replace(/\.html?$/i, '')
  .replace(/^\d+\.\s*/, '')
  .replace(/\s*-\s*Questionnaire?.*$/i, '')
  .replace(new RegExp(`\\s*-\\s*${MONTHS_RE}\\s+\\d{4}\\s*$`, 'i'), '')
  .trim();
const escapeRe = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A CLIENT answer: prefill-seeded values (source:'prefill' / prefill__ keys) are not answers.
const isPrefill      = (f) => Boolean(f) && (f.source === 'prefill' || String(f.key || '').startsWith('prefill__'));
const isClientAnswer = (f) => Boolean(f) && !isPrefill(f) && String(f.value == null ? '' : f.value).trim() !== '';

/** Normalise a stored form key. Legacy bare "additional" = the primary member's additional slot. */
function splitFormKey(formKey) {
  const k = String(formKey || '');
  if (/^additional$/i.test(k)) return { formKey: 'primary-additional', memberKey: 'primary', isAdditional: true };
  const isAdditional = /-additional$/i.test(k);
  return { formKey: k, memberKey: k.replace(/-additional$/i, ''), isAdditional };
}

/**
 * Submission evidence from the case's Monday Updates (plain-text bodies).
 * Two audit-comment shapes exist (htmlQuestionnaireService.markSubmitted /
 * markAllSubmitted):
 *   single form:  "📋 Questionnaire Submitted … Staff Review Link: …/review?formKey=<formKey>"
 *   batch:        "📋 Questionnaire Submitted (N members) … Members submitted:\n  • <label>: <pct>% …"
 * @param {Array<{ body: string, createdAt?: string }>|null|undefined} updates — null/undefined = not fetched
 * @returns {{ exact: Map<string, string|null>, batches: Array<{ labels: string[], createdAt: string|null }>, count: number }|null}
 */
function parseSubmissionUpdates(updates) {
  if (!Array.isArray(updates)) return null;
  const exact = new Map(), batches = [];
  let count = 0;
  for (const u of updates) {
    const body = String((u && u.body) || '').trim();
    // Anchor on the audit-comment prefix: a staff note that merely mentions
    // "questionnaire submitted" and carries a review link is NOT evidence.
    if (!/^(📋\s*)?Questionnaire Submitted\b/.test(body)) continue;
    count++;
    const createdAt = (u && u.createdAt) || null;
    if (/Questionnaire Submitted\s*\(\d+\s+members?\)/i.test(body)) {
      const labels = [];
      const re = /•\s*([^:<\n]+?):\s*\d+%/g;
      let m;
      while ((m = re.exec(body))) labels.push(m[1].trim());
      batches.push({ labels, createdAt });
      continue;
    }
    const km = /review\?formKey=([^\s&"'<>]+)/i.exec(body);
    if (!km) continue;
    let key;
    try { key = decodeURIComponent(km[1]); } catch (_) { key = km[1]; }
    key = splitFormKey(key).formKey;
    const prev = exact.get(key);
    if (!exact.has(key) || (createdAt && (!prev || createdAt > prev))) exact.set(key, createdAt);
  }
  return { exact, batches, count };
}

/**
 * Decide whether ONE stored form was submitted. Pure.
 * Precedence — and ambiguity NEVER resolves to "submitted":
 *   1. an exact per-form audit comment (review?formKey=<this form>)        → submitted
 *   2. a batch comment naming this member — only if the case has a single
 *      form slot (with an additional slot, which page was batch-submitted is unknown)
 *   3. the member's manifest submittedAt — same single-slot condition (the
 *      stamp is per member, set by whichever slot was submitted)
 *   4. Q Completion Status "Done" alone is never evidence for a form: with a
 *      manifest the unstamped member is a draft; without one → uncertain
 *   5. otherwise: draft
 * @returns {{ submitted: boolean, via: string, submittedAt?: string|null, uncertain?: boolean }}
 */
function decideSubmission({ formKey, memberKey, member, manifestExists, hasAdditionalSlot, evidence, caseDone, savedAt }) {
  const stamp = (member && member.submittedAt) || null;
  if (evidence && evidence.exact.has(formKey)) {
    return { submitted: true, via: 'update-exact', submittedAt: evidence.exact.get(formKey) || stamp || savedAt || null };
  }
  const label = (member && member.label) || (memberKey === 'primary' ? 'Primary Applicant' : null);
  const batch = evidence && label
    ? evidence.batches.find((b) => b.labels.some((l) => l.toLowerCase() === label.toLowerCase()))
    : null;
  if (batch) {
    if (!hasAdditionalSlot) return { submitted: true, via: 'update-batch', submittedAt: batch.createdAt || stamp || savedAt || null };
    return { submitted: false, via: 'ambiguous-batch', uncertain: true };
  }
  if (stamp) {
    if (!hasAdditionalSlot) return { submitted: true, via: 'manifest', submittedAt: stamp };
    return { submitted: false, via: 'ambiguous-manifest', uncertain: true };
  }
  if (caseDone) {
    // "Done" is written only after a submission — but WHICH forms is unknown.
    // With a manifest, a member lacking a stamp (e.g. added later) is a draft.
    // Without a manifest there is nothing per member to lean on → uncertain.
    return manifestExists ? { submitted: false, via: 'draft-despite-done' } : { submitted: false, via: 'ambiguous-done', uncertain: true };
  }
  return { submitted: false, via: 'none' };
}

/**
 * Regenerate the PDF of EVERY saved form of one case from its JSON truth
 * file (layout refresh; run by an admin over the portfolio).
 *
 * Reads: the case's Questionnaire folder listing, each form JSON, the members
 * manifest (read directly — loadMembers would seed + WRITE a manifest when
 * absent). The ONLY write is the overwrite of questionnaire-{caseRef}-{formKey}.pdf,
 * and only when dryRun === false. Never touches JSON, manifest, Monday, email.
 *
 * Skips (all reported with a reason, never written): forms with no CLIENT
 * answer, forms with no existing PDF (unless createMissing), forms saved
 * within RECENT_WINDOW_MS (a client may be on it), members missing from an
 * existing manifest, and forms whose submission status is ambiguous.
 * Per-form failures are recorded (action 'failed') and the case continues.
 * In dry-run the PDF is still BUILT (not uploaded) so render errors surface.
 */
async function regenerateCasePdfs({ clientName, caseRef, formFiles = null, qCompletionStatus = '', updates = null, updatesTruncated = false,
                                    skipKeys = [], dryRun = true, createMissing = false, now = Date.now() }) {
  if (!clientName || !caseRef) throw new Error('clientName and caseRef are required');
  const write = dryRun === false;
  const files = await oneDrive.listFiles({ clientName, caseRef, subfolder: QUESTIONNAIRE_SUBFOLDER });
  const byName = new Map(files.map((f) => [f.name, f]));
  const re = new RegExp(`^questionnaire-${escapeRe(caseRef)}-(.+)\\.json$`, 'i');
  const forms = [];
  for (const f of files) {
    const m = re.exec(f.name);
    if (!m) continue;
    const storedKey = m[1];
    if (/-flags$/i.test(storedKey)) continue;              // staff correction flags sidecar
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(storedKey)) continue; // not a form key we ever write
    forms.push({ storedKey, filename: f.name, lastModified: f.lastModifiedDateTime || null });
  }

  let members = [], manifestExists = false;
  const manifestBuf = await oneDrive.readFile({ clientName, caseRef, subfolder: QUESTIONNAIRE_SUBFOLDER, filename: `${MEMBERS_PREFIX}${caseRef}.json` });
  if (manifestBuf) {
    let d;
    try { d = JSON.parse(manifestBuf.toString('utf8')); }
    catch (_) { throw new Error(`members manifest for ${caseRef} is not valid JSON — nothing regenerated for this case`); }
    if (Array.isArray(d.members)) { members = d.members; manifestExists = members.length > 0; }
  }
  const caseDone = String(qCompletionStatus || '').trim().toLowerCase() === 'done';
  const evidence = parseSubmissionUpdates(updates);
  // Two form slots? The CURRENT form map can disagree with history (case re-typed,
  // sub-type override, unmapped type) — so also trust what is on disk / in the
  // audit trail. Over-counting slots only makes the run more cautious.
  const slotFromMap      = Boolean(formFiles && formFiles.additional);
  const slotFromDisk     = forms.some((f) => splitFormKey(f.storedKey).isAdditional);
  const slotFromEvidence = Boolean(evidence) && [...evidence.exact.keys()].some((k) => /-additional$/i.test(k));
  const hasAdditionalSlot = slotFromMap || slotFromDisk || slotFromEvidence;
  const hasAdditionalSlotSource = slotFromMap ? 'map' : slotFromDisk ? 'disk' : slotFromEvidence ? 'evidence' : 'none';
  // Legacy bare "additional" and "primary-additional" normalise to ONE slot — if
  // both files exist, one comment cannot tell them apart.
  const normCount = new Map();
  for (const f of forms) { const k = splitFormKey(f.storedKey).formKey; normCount.set(k, (normCount.get(k) || 0) + 1); }
  const skip = new Set((Array.isArray(skipKeys) ? skipKeys : []).map(String));

  const results = [];
  let failed = 0, transientFailures = 0;
  for (const form of forms) {
    const { formKey, memberKey, isAdditional } = splitFormKey(form.storedKey);
    const r = { formKey: form.storedKey, action: 'skipped', reason: '', fieldCount: 0, answered: 0, submitted: false, submittedVia: '',
                memberLabel: '', formLabel: '', hadPdf: byName.has(`questionnaire-${caseRef}-${form.storedKey}.pdf`) };
    results.push(r);
    try {
      if (skip.has(form.storedKey)) { r.reason = 'skipped-by-caller'; continue; }   // already done in an earlier (partially failed) attempt
      const buf = await oneDrive.readFile({ clientName, caseRef, subfolder: QUESTIONNAIRE_SUBFOLDER, filename: form.filename });
      if (!buf) { r.reason = 'vanished'; continue; }
      let parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { r.reason = 'invalid-json'; continue; }
      const data   = Array.isArray(parsed) ? { fields: parsed } : (parsed || {});
      const fields = Array.isArray(data.fields) ? data.fields : [];
      r.fieldCount = fields.length;
      r.answered   = fields.filter(isClientAnswer).length;
      r.savedAt    = data.savedAt || null;
      if (!r.answered) { r.reason = fields.some(isPrefill) ? 'prefill-only' : 'no-answers'; continue; }
      if (!createMissing && !r.hadPdf) { r.reason = 'no-existing-pdf'; continue; }
      const recent = [form.lastModified, r.savedAt].some((t) => { const ms = Date.parse(t || ''); return Number.isFinite(ms) && (now - ms) < RECENT_WINDOW_MS; });
      if (recent) { r.reason = 'recently-saved'; continue; }

      const member = members.find((m) => m && m.key === memberKey) || null;
      if (manifestExists && !member) { r.reason = 'orphan-member'; continue; }
      r.memberLabel = (member && member.label) || (memberKey === 'primary' ? 'Primary Applicant' : memberKey);
      const fileForLabel = data.formFile || (isAdditional ? (formFiles && formFiles.additional) : (formFiles && formFiles.primary)) || '';
      r.formLabel = formTitleFromFile(fileForLabel) || (isAdditional ? 'Additional Questionnaire' : 'Questionnaire');
      r.completionPct = Number(data.completionPct) || 0;

      if (normCount.get(formKey) > 1) { r.reason = 'status-uncertain'; r.submittedVia = 'ambiguous-legacy-key'; continue; }
      const decision = decideSubmission({ formKey, memberKey, member, manifestExists, hasAdditionalSlot, evidence, caseDone, savedAt: r.savedAt });
      r.submitted = decision.submitted; r.submittedVia = decision.via;
      if (decision.uncertain) { r.reason = 'status-uncertain'; continue; }
      // The Updates feed was cut at the fetch limit: an older exact comment may be missing.
      if (!decision.submitted && updatesTruncated && !(member && member.submittedAt)) { r.reason = 'status-uncertain'; r.submittedVia = 'updates-truncated'; continue; }
      // Edited after submission: the live save path labels such saves "In progress";
      // re-labelling newer content "Submitted <old date>" would be wrong → report, never write.
      if (decision.submitted) {
        const subMs   = Date.parse(decision.submittedAt || '');
        const savedMs = Math.max(Date.parse(r.savedAt || '') || 0, Date.parse(form.lastModified || '') || 0);
        if (Number.isFinite(subMs) && savedMs > subMs + 5 * 60 * 1000) { r.reason = 'edited-after-submission'; r.editedAt = new Date(savedMs).toISOString(); continue; }
      }
      const submittedAt = decision.submittedAt || r.savedAt || new Date(now).toISOString();

      const buffer = await buildPdfBuffer({ clientName, caseRef, formLabel: r.formLabel, memberLabel: r.memberLabel,
        completionPct: r.completionPct, submittedAt, fields, submitted: r.submitted });
      r.bytes = buffer.length;
      if (!write) { r.action = 'would-regenerate'; r.reason = ''; continue; }
      await oneDrive.uploadFile({ clientName, caseRef, category: QUESTIONNAIRE_SUBFOLDER,
        filename: `questionnaire-${caseRef}-${form.storedKey}.pdf`, buffer, mimeType: 'application/pdf' });
      r.action = 'regenerated';
    } catch (err) {
      r.action = 'failed'; r.reason = ''; r.error = err.message; r.transient = Boolean(err.transient);
      failed++; if (err.transient) transientFailures++;
    }
  }
  return { caseRef, clientName, dryRun: !write, manifestExists, memberCount: members.length, hasAdditionalSlot, hasAdditionalSlotSource, updatesTruncated: Boolean(updatesTruncated),
           evidence: evidence ? { exact: [...evidence.exact.keys()], batches: evidence.batches.length, comments: evidence.count } : null,
           forms: results, failed, transientFailures };
}

/** Test seam: pending draft windows (keys) — not for production use. */
function _pendingDraftKeys() { return [..._draftPending.keys()]; }

module.exports = { generateAndSaveSubmissionPdf, scheduleDraftPdf, regenerateCasePdfs, decideSubmission, parseSubmissionUpdates, splitFormKey, buildPdfBuffer, buildLayoutModel, MAX_GRID_COLS, DRAFT_PDF_THROTTLE_MS, RECENT_WINDOW_MS, _pendingDraftKeys };
