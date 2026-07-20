'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { selectStaleRows } = require('../src/services/executionSeederService');

const KEEP = 'CEC Accompanying Spouse & Child';
const schema = (subType, status) => ({ id: Math.random().toString(36).slice(2), subType, status, intakeItemId: 'code:X-1' });

test('selectStaleRows: prunes empty schema rows from OTHER sub-types', () => {
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
    { id: 'a', subType: 'CEC Single Applicant', status: 'Received',  intakeItemId: 'code:X-1' },
    { id: 'b', subType: 'CEC Single Applicant', status: 'Reviewed',  intakeItemId: 'code:X-2' },
    { id: 'c', subType: 'CEC Single Applicant', status: 'Rework Required', intakeItemId: 'code:X-3' },
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), [], 'uploaded stale rows are preserved');
});

test('selectStaleRows: NEVER prunes legacy Template-Board or manually-added rows', () => {
  const rows = [
    { id: 'a', subType: 'CEC Single Applicant', status: 'Missing', intakeItemId: '12345' },    // legacy (template item id)
    { id: 'b', subType: 'CEC Single Applicant', status: 'Missing', intakeItemId: '' },          // manual (no marker)
  ];
  assert.deepEqual(selectStaleRows(rows, KEEP), [], 'only schema-sourced (code:) rows are eligible');
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
