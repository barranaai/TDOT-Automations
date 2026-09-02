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

/** Test seam: pending draft windows (keys) — not for production use. */
function _pendingDraftKeys() { return [..._draftPending.keys()]; }

module.exports = { generateAndSaveSubmissionPdf, scheduleDraftPdf, buildPdfBuffer, buildLayoutModel, MAX_GRID_COLS, DRAFT_PDF_THROTTLE_MS, _pendingDraftKeys };
