'use strict';

// Handoff dedup must match the SAME person (email + name), so a couple/family
// sharing one email never collapses two separate matters into one Client Master case.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { pickSamePersonMatch } = require('../src/services/handoffService');

const items = [{ id: '100', name: 'John Smith' }, { id: '200', name: 'Jane Smith' }];

test('reuses the existing case when name + email match the same person', () => {
  assert.equal(pickSamePersonMatch(items, 'John Smith'), '100');
});

test('name match is case- and whitespace-insensitive', () => {
  assert.equal(pickSamePersonMatch(items, '  jane   SMITH '), '200');
});

test('shared email with a different name → null (a fresh case is created)', () => {
  assert.equal(pickSamePersonMatch(items, 'Bobby Brown'), null);
});

test('no name or no candidates → null (never merge blindly)', () => {
  assert.equal(pickSamePersonMatch(items, ''), null);
  assert.equal(pickSamePersonMatch([], 'John Smith'), null);
  assert.equal(pickSamePersonMatch(null, 'John Smith'), null);
});
