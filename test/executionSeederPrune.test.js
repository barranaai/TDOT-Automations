'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { selectStaleRows } = require('../src/services/executionSeederService');

const KEEP = 'CEC Accompanying Spouse & Child';
// A reconciler-managed schema row: has a uniqueKey, a "code:" intake id, no Template-Board relation.
const schema = (subType, status) => ({ id: Math.random().toString(36).slice(2), subType, status, uniqueKey: '2026-X-' + Math.random().toString(36).slice(2), intake: 'code:PASSPORT', templateRel: '' });

test('selectStaleRows: prunes empty schema rows from OTHER sub-types (old + new format)', () => {
  const rows = [
    schema(KEEP, 'Missing'),                         // current sub-type → keep
    schema('CEC Single Applicant', 'Missing'),       // stale + empty → prune
    schema('', 'Missing'),                            // blank stale + empty → prune
  ];
  const stale = selectStaleRows(rows, KEEP);
  assert.equal(stale.length, 2);
  assert.ok(stale.every((r) => r.subType !== KEEP));
});

test('selectStaleRows: NEVER prunes a row a client uploaded to (any status beyond Missing)', () => {
  const rows = [
    { id: 'a', subType: 'CEC Single Applicant', status: 'Received',        uniqueKey: '2026-X-a', intake: 'code:X', templateRel: '' },
    { id: 'b', subType: 'CEC Single Applicant', status: 'Reviewed',        uniqueKey: '2026-X-b', intake: 'code:X', templateRel: '' },
    { id: 'c', subType: 'CEC Single Applicant', status: 'Rework Required', uniqueKey: '2026-X-c', intake: 'code:X', templateRel: '' },
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), [], 'uploaded stale rows are preserved');
});

test('selectStaleRows: NEVER prunes legacy Template-Board or manually-added rows', () => {
  const rows = [
    { id: 'a', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '2026-X-a', intake: 'code:X', templateRel: 'Template item' }, // legacy (has template relation)
    { id: 'b', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '',          intake: 'code:X', templateRel: '' },              // manual (no uniqueKey)
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), [], 'only reconciler-managed rows (uniqueKey + no template) are eligible');
});

// 2026-10-22: the relation read came back blank for every row for months (Monday
// returns null text/value for link cells), so the Template rows of 4 open cases
// (93 rows: PS-030, CWP-001, VRE-001, OSS-002) were one Re-seed from deletion.
test('selectStaleRows: a Template-built row (numeric intake id) is NEVER pruned — even when its relation reads blank', () => {
  const rows = [
    { id: 't1', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '2026-CEC-PS-030-PASSPORT', intake: '18401700001', templateRel: '' },
    { id: 't2', subType: '',                     status: '',        uniqueKey: '2026-CWP-001-IMM5710',     intake: '18401700002', templateRel: '' },
    { id: 't3', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '2026-X-t3',                intake: '',            templateRel: '' }, // no intake at all
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), []);
});

test('selectStaleRows: a row whose template link could not be read ("unknown") is never pruned', () => {
  const rows = [{ id: 'u', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '2026-X-u', intake: 'code:X', templateRel: 'unknown' }];
  assert.deepEqual(selectStaleRows(rows, KEEP), []);
});

test('the prune and move reads ask Monday for the link through the typed fragment, and the prune read carries the intake id', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/executionSeederService.js'), 'utf8');
  const prune = src.slice(src.indexOf('async function getExistingRowsForPrune'), src.indexOf('async function getExistingRowsForPrune') + 1200);
  assert.match(prune, /mondayColumnRead'\)\.RELATION_FIELDS/);
  assert.match(prune, /EXEC_COLS\.intakeItemId/);
  assert.match(prune, /intake: g\(EXEC_COLS\.intakeItemId\)/);
  const move = src.slice(src.indexOf('async function getExistingRowsForMigration'), src.indexOf('async function getExistingRowsForMigration') + 1200);
  assert.match(move, /mondayColumnRead'\)\.RELATION_FIELDS/);
});

test('selectStaleRows: same sub-type is never pruned (case/space-insensitive)', () => {
  const rows = [
    schema('cec accompanying spouse & child  ', 'Missing'), // same, messy casing/space → keep
    schema(KEEP, 'Missing'),
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), []);
});

test('selectStaleRows: safe on empty input', () => {
  assert.deepEqual(selectStaleRows(null, KEEP), []);
  assert.deepEqual(selectStaleRows([], KEEP), []);
});
