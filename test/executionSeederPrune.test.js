'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { selectStaleRows } = require('../src/services/executionSeederService');

const KEEP = 'CEC Accompanying Spouse & Child';
// A reconciler-managed schema row: has a uniqueKey, no Template-Board relation.
const schema = (subType, status) => ({ id: Math.random().toString(36).slice(2), subType, status, uniqueKey: '2026-X-' + Math.random().toString(36).slice(2), templateRel: '' });

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
    { id: 'a', subType: 'CEC Single Applicant', status: 'Received',        uniqueKey: '2026-X-a', templateRel: '' },
    { id: 'b', subType: 'CEC Single Applicant', status: 'Reviewed',        uniqueKey: '2026-X-b', templateRel: '' },
    { id: 'c', subType: 'CEC Single Applicant', status: 'Rework Required', uniqueKey: '2026-X-c', templateRel: '' },
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), [], 'uploaded stale rows are preserved');
});

test('selectStaleRows: NEVER prunes legacy Template-Board or manually-added rows', () => {
  const rows = [
    { id: 'a', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '2026-X-a', templateRel: 'Template item' }, // legacy (has template relation)
    { id: 'b', subType: 'CEC Single Applicant', status: 'Missing', uniqueKey: '',          templateRel: '' },              // manual (no uniqueKey)
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), [], 'only reconciler-managed rows (uniqueKey + no template) are eligible');
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
