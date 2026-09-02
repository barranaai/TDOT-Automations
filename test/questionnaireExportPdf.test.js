'use strict';

// Staff "Export PDF" (review bar + cockpit) serves a REAL PDF in the
// consultant layout, built on demand from the saved JSON truth files:
// one form (?formKey=) or the whole case (every saved form with a client
// answer, primary first, manifest order), staff correction flags printed
// beside the answers, honest status per form ("not confirmed" when nothing
// per member can back a verdict). The old print-styled HTML page is gone.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const CASE = '2026-ISS-009';
const F = (k) => `questionnaire-${CASE}-${k}.json`;
const P = (k) => `questionnaire-${CASE}-${k}.pdf`;

function harness({ files = [], store = {}, manifest = null, modified = {} }) {
  const fake = {
    listFiles: async () => files.map((name) => ({ name, size: 1, lastModifiedDateTime: modified[name] || '2026-09-02T11:00:00.000Z' })),
    readFile:  async ({ filename }) => {
      if (filename === `questionnaire-members-${CASE}.json`) return manifest ? Buffer.from(JSON.stringify(manifest)) : null;
      return store[filename] != null ? Buffer.from(JSON.stringify(store[filename])) : null;
    },
    uploadFile: async () => { throw new Error('export must never upload'); },
  };
  const odPath = require.resolve('../src/services/oneDriveService');
  require.cache[odPath] = { id: odPath, filename: odPath, loaded: true, exports: fake };
  const svcPath = require.resolve('../src/services/questionnairePdfService');
  delete require.cache[svcPath];
  return require(svcPath);
}

const form = (n, extra = {}) => ({ fields: [
  { section: 'Main Applicant › Section 1 › Personal', label: 'Given Name', key: `gn${n}`, value: `Name ${n}` },
  { section: 'Main Applicant › Section 2 › Address History › Table', label: 'City — Row 1', key: `city${n}`, value: 'Toronto' },
  { section: 'Main Applicant › Section 2 › Address History › Table', label: 'Country — Row 1', key: `ctry${n}`, value: 'Canada' },
], completionPct: 50, savedAt: '2026-08-01T10:00:00.000Z', formFile: '3. Express Entry - Questionnaire.html', ...extra });
const DUAL = { primary: '1. Spousal - Questionnaire.html', additional: '2. Sponsor Details - Questionnaire.html' };

test('buildPdfBuffer renders staff flags beside answers (field rows + table cells) and lists unmatched flags; markers are plain text', async () => {
  const svc = harness({});
  const flags = { gn1: { comment: 'Please use the passport spelling' }, city1: { comment: 'City missing province' }, ghost: { section: 'Old', label: 'Removed field', comment: 'still open' } };
  const withFlags = await svc.buildPdfBuffer({ clientName: 'C', caseRef: CASE, formLabel: 'F', memberLabel: 'Primary Applicant', completionPct: 50, submittedAt: '2026-08-01T10:00:00.000Z', fields: form(1).fields, submitted: true, flags });
  const without   = await svc.buildPdfBuffer({ clientName: 'C', caseRef: CASE, formLabel: 'F', memberLabel: 'Primary Applicant', completionPct: 50, submittedAt: '2026-08-01T10:00:00.000Z', fields: form(1).fields, submitted: true });
  assert.equal(withFlags.slice(0, 4).toString(), '%PDF');
  assert.ok(withFlags.length > without.length, 'flag notes add content');
  const src = fs.readFileSync(require.resolve('../src/services/questionnairePdfService'), 'utf8');
  assert.match(src, /`Officer note: \$\{clean\(flag\.comment\)/, 'field-row flag note');
  assert.match(src, /Officer note — Entry \$\{ri \+ 1\} · \$\{block\.columns\[i\]\}/, 'table-cell flag notes listed under the table');
  assert.match(src, /'Officer notes on fields not shown above'/, 'unmatched flags are listed, never dropped');
  assert.match(src, /'Saved — submission status not confirmed for this form'/, 'neutral cover state exists');
  assert.match(src, /'could not be loaded at export time/, 'unreadable flags are stated on the cover');
  assert.ok(!src.includes('⚑'), 'no glyph outside the built-in PDF fonts');
});

test('buildCasePdfBuffer: several forms in one document, each with its own cover; page numbers run across', async () => {
  const svc = harness({});
  const forms = [1, 2, 3].map((n) => ({ formLabel: 'F', memberLabel: n === 1 ? 'Primary Applicant' : `Member ${n}`, completionPct: 40, submittedAt: '2026-08-01T10:00:00.000Z', fields: form(n).fields, submitted: n === 1, statusUnknown: n === 3 }));
  const buf = await svc.buildCasePdfBuffer({ clientName: 'C', caseRef: CASE, forms });
  const pages = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(pages >= 6, `3 forms × (cover + body) → at least 6 pages, got ${pages}`);
  await assert.rejects(() => svc.buildCasePdfBuffer({ clientName: 'C', caseRef: CASE, forms: [] }), /no forms/);
});

test('exportCasePdf: whole case = every answered form in manifest order (member + its additional slot together); removed members, legacy duplicates and prefill-only forms dropped; ?formKey → exactly that file', async () => {
  const manifest = { members: [{ key: 'primary', label: 'Primary Applicant' }, { key: 'child-1', label: 'Child — Aanya' }, { key: 'spouse-1', label: 'Spouse — Karthik' }] };
  const svc = harness({
    files: [F('spouse-1'), F('primary'), F('primary-flags'), F('additional'), F('primary-additional'), F('child-1'), F('child-1-additional'), F('child-9'), F('spouse-1-additional'), `questionnaire-members-${CASE}.json`],
    store: {
      [F('spouse-1')]: form(2), [F('primary')]: form(1), [F('additional')]: form(9), [F('primary-additional')]: form(3, { formFile: '' }),
      [F('child-1')]: form(4), [F('child-1-additional')]: { fields: [{ section: 'A', label: 'Q', key: 'p', value: 'seeded', source: 'prefill' }] },
      [F('child-9')]: form(5), [F('spouse-1-additional')]: form(6),
    },
    manifest,
  });
  const asked = [];
  const all = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: DUAL, loadFlags: async (k) => { asked.push(k); return {}; } });
  assert.deepEqual(all.forms.map((f) => f.formKey), ['primary', 'primary-additional', 'child-1', 'spouse-1', 'spouse-1-additional'],
    'primary + its slot, then manifest order; child-1-additional is prefill-only, child-9 was removed from the manifest, legacy "additional" collapsed into primary-additional');
  assert.deepEqual([...asked].sort(), ['child-1', 'child-1-additional', 'primary', 'primary-additional', 'spouse-1', 'spouse-1-additional']);
  assert.equal(all.forms[1].formLabel, 'Sponsor Details'); assert.equal(all.forms[3].memberLabel, 'Spouse — Karthik');
  assert.ok(all.forms.every((f) => f.submitted === false && f.statusUnknown === false), 'manifest members without a stamp → plain draft');
  assert.equal(all.buffer.slice(0, 4).toString(), '%PDF');

  const one = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: DUAL, formKey: 'spouse-1' });
  assert.deepEqual(one.forms.map((f) => f.formKey), ['spouse-1']);
  const legacy = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: DUAL, formKey: 'additional' });
  assert.deepEqual(legacy.forms.map((f) => f.formKey), ['additional'], 'an explicit legacy key is honoured as-is');
  assert.equal(await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formKey: 'nope' }), null);
  assert.equal(await harness({ files: [] }).exportCasePdf({ clientName: 'C', caseRef: CASE }), null);
});

test('exportCasePdf status: single-form export still sees the whole case\'s slot count; no manifest → "not confirmed"; Done case without stamps → "not confirmed"; legacy PDF → submitted; later client save → edited', async () => {
  // two-slot case (only visible from the OTHER file on disk) + per-member stamp → the requested form cannot be confirmed
  let svc = harness({ files: [F('primary'), F('primary-additional')], store: { [F('primary')]: form(1), [F('primary-additional')]: form(2) },
    manifest: { members: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' }] } });
  let out = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: { primary: 'x' }, formKey: 'primary' });
  assert.equal(out.forms[0].submitted, false); assert.equal(out.forms[0].statusUnknown, true);
  // single-slot case + stamp → submitted via the manifest
  svc = harness({ files: [F('primary')], store: { [F('primary')]: form(1) }, manifest: { members: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' }] } });
  out = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: { primary: 'x' }, formKey: 'primary' });
  assert.equal(out.forms[0].submitted, true);
  // no manifest at all → nothing can back "not submitted" → not confirmed (Done or not)
  for (const caseDone of [false, true]) {
    svc = harness({ files: [F('primary')], store: { [F('primary')]: form(1) }, manifest: null });
    out = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: { primary: 'x' }, caseDone });
    assert.equal(out.forms[0].submitted, false); assert.equal(out.forms[0].statusUnknown, true, `caseDone=${caseDone}`);
  }
  // submission-era PDF proves it; a client save well after → edited-after
  svc = harness({ files: [F('primary'), P('primary')], store: { [F('primary')]: form(1, { savedAt: '2026-08-20T09:00:00.000Z' }) },
    manifest: { members: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' }] }, modified: { [P('primary')]: '2026-08-10T12:00:05.000Z' } });
  out = await svc.exportCasePdf({ clientName: 'C', caseRef: CASE, formFiles: DUAL });
  assert.equal(out.forms[0].submitted, true); assert.equal(out.forms[0].editedAt, '2026-08-20T09:00:00.000Z');
});

test('exportCasePdf flags: a transient flags-read failure fails the export; a corrupt flags file is stated on the cover', async () => {
  const mk = () => harness({ files: [F('primary')], store: { [F('primary')]: form(1) }, manifest: { members: [{ key: 'primary', label: 'Primary Applicant' }] } });
  await assert.rejects(() => mk().exportCasePdf({ clientName: 'C', caseRef: CASE, loadFlags: async () => { const e = new Error('OneDrive read failed'); e.transient = true; throw e; } }), (e) => e.transient === true);
  const out = await mk().exportCasePdf({ clientName: 'C', caseRef: CASE, loadFlags: async () => { throw new SyntaxError('Unexpected token'); } });
  assert.equal(out.forms[0].flagsUnavailable, true);
});

test('route + review bar pins: application/pdf inline, staff auth + RBAC kept, strict ?formKey, caseDone passed, whole case from multi-member review pages; print page gone', () => {
  const r = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm'), 'utf8');
  const i = r.indexOf("router.get('/:caseRef/export-pdf'");
  const block = r.slice(i, r.indexOf('router.post(', i));
  assert.match(block, /staffOrAdminKey/); assert.match(block, /enforceCaseAccess\(req, res, caseRef\)/);
  assert.match(block, /rawKey === undefined \? null : sanitiseFormKey/, 'formKey absent → whole case');
  assert.match(block, /res\.status\(400\)/, 'present-but-empty/invalid formKey → 400, never silently the whole case');
  assert.match(block, /caseDone: String\(qCompletionStatus \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'done'/);
  assert.match(block, /exportCasePdf\(/); assert.match(block, /'Content-Type', 'application\/pdf'/); assert.match(block, /inline; filename=/);
  assert.match(block, /loadFlags: \(k\) => review\.loadFlags/);
  assert.match(block, /err\.transient\) return res\.status\(503\)/);
  assert.doesNotMatch(block, /buildPrintPage/);
  const rv = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireReviewService'), 'utf8');
  assert.match(rv, /qCompletionStatus: col\(Q_COMPLETION_COL\)/, 'getCaseDetails returns the Q Completion Status');
  const svcSrc = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService'), 'utf8');
  assert.doesNotMatch(svcSrc, /buildPrintPage/, 'HTML print page removed');
  assert.match(svcSrc, /if \(!IS_MULTI_REVIEW\) params\.push\('formKey=' \+ encodeURIComponent\(FORM_KEY\)\);/, 'multi-member review exports the whole case');
  assert.match(svcSrc, /new URLSearchParams\(location\.search\)\.get\('key'\)/, 'admin key carried into the new tab');
  const cockpit = fs.readFileSync(require.resolve('../src/routes/adminCase'), 'utf8');
  assert.match(cockpit, /\/export-pdf' \+ kq \+ '" target="_blank"/);
});
