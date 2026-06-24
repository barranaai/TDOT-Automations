'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { feeToCents, centsToMoney, dollarsToMoney } = require('../src/utils/money');

test('feeToCents parses dollar strings → cents, rejects non-positive', () => {
  assert.equal(feeToCents('2500'), 250000);
  assert.equal(feeToCents('$2,500.00'), 250000);
  assert.equal(feeToCents('  2,500.50 '), 250050);
  assert.equal(feeToCents(2500), 250000);
  assert.equal(feeToCents(''), null);
  assert.equal(feeToCents('0'), null);
  assert.equal(feeToCents(null), null);
  assert.equal(feeToCents('-5'), null);
  assert.equal(feeToCents('abc'), null);
});

test('centsToMoney groups thousands, 2 decimals', () => {
  assert.equal(centsToMoney(250000), '2,500.00');
  assert.equal(centsToMoney(32500), '325.00');
  assert.equal(centsToMoney(100), '1.00');
  assert.equal(centsToMoney(1234567), '12,345.67');
  assert.equal(centsToMoney(0), '0.00');
  assert.equal(centsToMoney(5), '0.05');
});

test('dollarsToMoney handles whole and fractional dollars', () => {
  assert.equal(dollarsToMoney(1590), '1,590.00');
  assert.equal(dollarsToMoney(401.25), '401.25');
  assert.equal(dollarsToMoney(1000), '1,000.00');
});
