'use strict';

// Document readiness metrics for schema-seeded checklists (user report
// 2026-08-10: "document readiness % stuck at 0 even when all documents are
// received").
//
// Root cause: schema-seeded execution rows carry intakeItemId "code:<DOC>" and
// no Template Board link, so their mirror columns (counts-toward-ready,
// blocking, required) are blank forever. calcDocMetrics only counts rows whose
// counts mirror reads "yes" — with every mirror blank it counted ZERO
// documents, so uploaded% and readiness% were 0 on every case seeded since the
// schema migration, regardless of what the client uploaded.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/services/caseReadinessService');
const { calcDocMetrics, applySchemaDefaults } = _internal;

// Column ids mirrored from caseReadinessService D_COLS.
const D = { counts: 'lookup_mm0zhkkd', status: 'color_mm0zwgvr', blocking: 'lookup_mm0zb0p6',
            required: 'lookup_mm0z1chx', intakeId: 'text_mm0zfsp1' };

const row = ({ intakeId, status = '', counts = '', blocking = '', required = '' }) => ({
  id: 'x',
  column_values: [
    { id: D.intakeId, text: intakeId }, { id: D.status, text: status },
    { id: D.counts, text: counts }, { id: D.blocking, text: blocking }, { id: D.required, text: required },
  ],
});

const schemaRows = (statuses) => statuses.map((s) => row({ intakeId: 'code:SCLPC-WP--PA-PASSPORT-001', status: s }));

test('THE BUG: schema-seeded rows with blank mirrors counted zero documents', () => {
  const items = schemaRows(['Received', 'Received', '']);
  // without defaults: nothing countable, everything reads 0
  assert.deepEqual(calcDocMetrics(items), { readinessPct: 0, uploadedPct: 0, blockingCount: 0, missingRequired: 0, totalCountable: 0 });
  // with the fix applied: all 3 count, 2 uploaded
  applySchemaDefaults(items);
  const m = calcDocMetrics(items);
  assert.equal(m.totalCountable, 3);
  assert.equal(m.uploadedPct, 67);
  assert.equal(m.readinessPct, 0, 'reviewed-based readiness stays 0 until staff review — a separate pipeline');
  assert.equal(m.missingRequired, 1, 'the un-uploaded doc is a missing required document');
});

test('fully-uploaded case reads 100% uploaded (the Navjot 8/8 shape)', () => {
  const items = schemaRows(Array(8).fill('Received'));
  applySchemaDefaults(items);
  const m = calcDocMetrics(items);
  assert.equal(m.uploadedPct, 100);
  assert.equal(m.missingRequired, 0);
});

test('schema rows never introduce blocking documents', () => {
  const items = schemaRows(['', '', 'Received']);
  applySchemaDefaults(items);
  assert.equal(calcDocMetrics(items).blockingCount, 0, 'schemas have no blocking concept');
});

test('legacy template-linked rows are left for the template fetch, not defaulted', () => {
  const items = [row({ intakeId: '123456789', status: 'Received' })];
  const applied = applySchemaDefaults(items);
  assert.equal(applied, 0, 'numeric template ids keep the template-board enrichment path');
  assert.equal(calcDocMetrics(items).totalCountable, 0, 'still uncounted until the template fetch fills the mirror');
});

test('an already-filled mirror value is never overwritten', () => {
  const items = [row({ intakeId: 'code:X-Y-001', status: 'Received', counts: 'No' })];
  applySchemaDefaults(items);
  const m = calcDocMetrics(items);
  assert.equal(m.totalCountable, 0, 'a real "No" mirror wins over the schema default');
});

test('Reviewed still counts as both uploaded and reviewed', () => {
  const items = schemaRows(['Reviewed', 'Received']);
  applySchemaDefaults(items);
  const m = calcDocMetrics(items);
  assert.equal(m.uploadedPct, 100);
  assert.equal(m.readinessPct, 50);
});

test('dashboard reads upload progress, not the never-set Reviewed status', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.match(src, /docUploaded:\s+'numeric_mm2njqk1'/, 'the uploaded% column is mapped');
  assert.match(src, /docR\s*=\s*toNum\(col\(COLS\.docUploaded\)\)/, 'document progress = client uploads');
  assert.match(src, /docReviewed/, 'the reviewed% stays available as its own field');
});

test('the cockpit exposes both percentages', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/caseCockpitService'), 'utf8');
  assert.match(src, /docReadinessPct:\s*clampPct\(txt\(CM\.docUploaded\)\)/, 'the meter shows client progress');
  assert.match(src, /docReviewedPct/, 'reviewed% still exposed separately');
});
