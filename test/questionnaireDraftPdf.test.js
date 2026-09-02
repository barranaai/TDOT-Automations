'use strict';

// Draft questionnaire PDFs on every save (user request 2026-08-29): the same
// questionnaire-{caseRef}-{formKey}.pdf is overwritten on each save, so staff
// see one current PDF per form. Manual saves regenerate immediately; autosaves
// (every 60s while typing) are THROTTLED to one PDF per window, built from the
// latest fields — a typing session must not churn hundreds of overwrites.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

function freshService(throttleMs) {
  process.env.DRAFT_PDF_THROTTLE_MS = String(throttleMs);
  const p = require.resolve('../src/services/questionnairePdfService');
  delete require.cache[p];
  return require(p);
}

test('draft PDF cover states "In progress — not yet submitted" + "Last saved"; submissions unchanged', async () => {
  const svc = freshService(0);
  const fields = [{ section: 'S', label: 'Q', key: 'k', value: 'v' }];
  const draft = await svc.buildPdfBuffer({ clientName: 'C', caseRef: 'R', formLabel: 'F', memberLabel: 'Primary Applicant', completionPct: 40, submittedAt: new Date().toISOString(), fields, submitted: false });
  const sub   = await svc.buildPdfBuffer({ clientName: 'C', caseRef: 'R', formLabel: 'F', memberLabel: 'Primary Applicant', completionPct: 100, submittedAt: new Date().toISOString(), fields });
  assert.equal(draft.slice(0, 4).toString(), '%PDF');
  assert.equal(sub.slice(0, 4).toString(), '%PDF');
  const src = fs.readFileSync(require.resolve('../src/services/questionnairePdfService'), 'utf8');
  assert.match(src, /'In progress — not yet submitted'/);
  assert.match(src, /\['Last saved', formatTimestamp\(submittedAt\)\]/);
  assert.match(src, /\['Status', 'Submitted'\]/, 'submission cover keeps its Submitted rows');
});

test('scheduleDraftPdf: manual save → immediate; autosaves throttled to ONE PDF per window with the LATEST fields', async () => {
  const svc = freshService(40); // 40ms window for the test
  const calls = [];
  svc.generateAndSaveSubmissionPdf = async (p) => { calls.push(p); };

  // manual save → immediate, marked as a draft (submitted:false)
  await svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'primary', fields: [1], savedAt: 't1' }, { immediate: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].submitted, false);
  assert.equal(calls[0].submittedAt, 't1', 'draft timestamp = savedAt');

  // three rapid autosaves → one pending window, fields refreshed to the latest
  svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'primary', fields: [2], savedAt: 't2' });
  svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'primary', fields: [3], savedAt: 't3' });
  svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'primary', fields: [4], savedAt: 't4' });
  assert.deepEqual(svc._pendingDraftKeys(), ['R|primary']);
  assert.equal(calls.length, 1, 'nothing generated inside the window');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 2, 'exactly ONE PDF after the window');
  assert.deepEqual(calls[1].fields, [4], 'built from the LATEST autosave');
  assert.deepEqual(svc._pendingDraftKeys(), []);

  // a pending autosave window is flushed + cancelled by a manual save
  svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'spouse-1', fields: [5], savedAt: 't5' });
  await svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'spouse-1', fields: [6], savedAt: 't6' }, { immediate: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].fields, [6]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 3, 'the cancelled window never fires');

  // per-form isolation: different formKeys get independent windows
  svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'a', fields: [7] });
  svc.scheduleDraftPdf({ caseRef: 'R', formKey: 'b', fields: [8] });
  assert.deepEqual(svc._pendingDraftKeys().sort(), ['R|a', 'R|b']);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 5);
});

test('/save route schedules the draft PDF after the JSON save (immediate on manual save), fire-and-forget', () => {
  const r = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm'), 'utf8');
  const idx = r.indexOf("router.post('/:caseRef/save'");
  const rest = r.slice(idx);
  const block = rest.slice(0, rest.indexOf('router.post(', 20)); // the whole /save route, up to the next route
  const saveIdx = block.indexOf('svc.saveFormData(');
  const pdfIdx  = block.indexOf('scheduleDraftPdf(');
  assert.ok(saveIdx !== -1 && pdfIdx !== -1 && pdfIdx > saveIdx, 'PDF scheduled AFTER the JSON save (the truth record)');
  assert.match(block, /immediate: manual === true/, 'manual save regenerates immediately; autosave is throttled');
  assert.match(block, /submitted: false|scheduleDraftPdf/, 'draft path');
  // The PDF must never block or fail the save response.
  assert.ok(block.indexOf('scheduleDraftPdf(') < block.indexOf("res.json({ ok: true })"), 'scheduled before the response but not awaited into the response path');
  assert.ok(!/await [a-zA-Z.]*scheduleDraftPdf/.test(block), 'not awaited — fire-and-forget');
});

// ── Layout model (redesign 2026-08-29): hierarchy + real table grids ─────────
test('buildLayoutModel: section paths become part/sub-section blocks; "Label — Row N" cells become table grids', () => {
  const svc = freshService(0);
  const fields = [
    { section: 'Main Applicant › Section 1 › Personal Details', label: 'Given Name', key: 'a', value: 'Harini' },
    { section: 'Main Applicant › Section 1 › Personal Details', label: 'Middle Name', key: 'b', value: '' },
    { section: 'Main Applicant › Section 2 › Address History › Table', label: 'From (DD/MM/YYYY) — Row 1', key: 'c', value: '01/01/2016' },
    { section: 'Main Applicant › Section 2 › Address History › Table', label: 'City — Row 1', key: 'd', value: 'Pondicherry' },
    { section: 'Main Applicant › Section 2 › Address History › Table', label: 'From (DD/MM/YYYY) — Row 2', key: 'e', value: '01/12/2021' },
    { section: 'Main Applicant › Section 2 › Address History › Table', label: 'City — Row 2', key: 'f', value: '' },
    { section: 'Main Applicant › Section 2 › Address History › Table', label: 'From (DD/MM/YYYY) — Row 3', key: 'g', value: '' },
    { section: 'Main Applicant › Section 2 › Address History › Table', label: 'City — Row 3', key: 'h', value: '' },
    { section: "Sponsor's Personal Details › Section 1 › Personal Details", label: 'Given Name', key: 'i', value: 'Bryan' },
  ];
  const blocks = svc.buildLayoutModel(fields);
  assert.deepEqual(blocks.map((b) => b.type), ['part', 'fields', 'table', 'part', 'fields']);
  assert.equal(blocks[0].title, 'Main Applicant');
  assert.equal(blocks[1].title, 'Section 1 › Personal Details');
  assert.deepEqual(blocks[1].rows, [{ label: 'Given Name', value: 'Harini', key: 'a' }, { label: 'Middle Name', value: '', key: 'b' }]);
  assert.deepEqual(blocks[2].keys, [['c', 'd'], ['e', 'f']], 'table cells keep their field keys (flags are keyed by field key)');
  const t = blocks[2];
  assert.equal(t.title, 'Section 2 › Address History', 'the "› Table" suffix is dropped from the heading');
  assert.deepEqual(t.columns, ['From (DD/MM/YYYY)', 'City']);
  assert.deepEqual(t.rows, [['01/01/2016', 'Pondicherry'], ['01/12/2021', '']], 'rows in order; the all-empty row 3 is dropped');
  assert.equal(blocks[3].title, "Sponsor's Personal Details");
});

test('buildLayoutModel: tables sharing one section title are split by the table id in the key and labelled', () => {
  const svc = freshService(0);
  const S = 'Relationship Details › Relationship Story'; // no "› Table" suffix — cells detected by key + "— Row N"
  const fields = [
    { section: S, label: 'Are you living together now?', key: 'relationship-details-relationship-story-are-you-living-together-now', value: 'Yes' },
    { section: S, label: 'From (DD/MM/YYYY) — Row 1', key: 'relationship-details-relationship-story-tbl-tbl-rel-visits-r1-from-dd-mm-yyyy', value: '01/06/2016' },
    { section: S, label: 'To (DD/MM/YYYY) — Row 1',   key: 'relationship-details-relationship-story-tbl-tbl-rel-visits-r1-to-dd-mm-yyyy',   value: '30/11/2021' },
    { section: S, label: 'Family Name — Row 1',       key: 'relationship-details-relationship-story-tbl-tbl-rel-friends-r1-family-name',   value: 'Doe' },
    { section: S, label: 'Given Name — Row 1',        key: 'relationship-details-relationship-story-tbl-tbl-rel-friends-r1-given-name',    value: 'Jane' },
    { section: S, label: 'Date (DD/MM/YYYY) — Row 1', key: 'relationship-details-relationship-story-tbl-tbl-rel-ceremonies-r1-date-dd-mm-yyyy', value: '' },
  ];
  const blocks = svc.buildLayoutModel(fields);
  assert.deepEqual(blocks.map((b) => b.type), ['part', 'fields', 'table', 'table', 'table']);
  assert.deepEqual(blocks.slice(2).map((b) => b.title), ['Relationship Story · Visits', 'Relationship Story · Friends', 'Relationship Story · Ceremonies']);
  assert.deepEqual(blocks[2].columns, ['From (DD/MM/YYYY)', 'To (DD/MM/YYYY)']);
  assert.deepEqual(blocks[3].rows, [['Doe', 'Jane']]);
  assert.deepEqual(blocks[4].rows, [], 'an all-empty entry is dropped');
  // a lone table under a title keeps the plain title (no " · name" suffix)
  const one = svc.buildLayoutModel([{ section: 'A › B › Table', label: 'X — Row 1', key: 'a-b-tbl-tbl-ma-parents-r1-x', value: 'v' }]);
  assert.equal(one[1].title, 'B');
  assert.ok(svc.MAX_GRID_COLS >= 5 && svc.MAX_GRID_COLS <= 8, 'wider tables fall back to the record layout');
});

test('buildPdfBuffer renders a multi-page PDF with real tables from the ISS-009 shape', async () => {
  const svc = freshService(0);
  const fields = [];
  for (let r = 1; r <= 6; r++) for (const c of ['From (DD/MM/YYYY)', 'To (DD/MM/YYYY)', 'Street Name', 'City / Town', 'Country']) {
    fields.push({ section: 'Main Applicant › Section 2 – Contact Details › Address History (Past 10 Years) › Table', label: `${c} — Row ${r}`, key: `k${r}${c}`, value: c === 'Country' ? 'CANADA' : `v${r}` });
  }
  for (let i = 0; i < 60; i++) fields.push({ section: 'Main Applicant › Section 1 – Profile Details › Personal Details', label: `Question ${i}`, key: `q${i}`, value: i % 4 ? 'answer '.repeat(1 + (i % 7)) : '' });
  const buf = await svc.buildPdfBuffer({ clientName: 'C', caseRef: 'R', formLabel: 'F', memberLabel: 'Primary Applicant', completionPct: 50, submittedAt: new Date().toISOString(), fields, submitted: false });
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
  assert.ok(buf.length > 6000, `PDF should carry real content (got ${buf.length} bytes)`);
  assert.ok((buf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length >= 2, 'multi-page');
});
