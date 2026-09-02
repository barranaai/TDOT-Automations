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
