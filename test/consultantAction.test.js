'use strict';

// Validation tests for the consultant-portal write actions. validateAction is
// the safety gate: it must reject anything that could mint a junk Monday label
// (create_labels_if_missing) or write a malformed value to the lead board.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { validateAction, OUTCOME_LABELS } = require('../src/services/consultantPortalService');

test('outcome accepts only the exact board labels', () => {
  for (const label of OUTCOME_LABELS) {
    assert.deepEqual(validateAction('outcome', label), { ok: true, normalized: label });
  }
});

test('outcome rejects near-matches (straight quote / hyphen) that would mint junk labels', () => {
  assert.equal(validateAction('outcome', "Don't Retain — Ineligible").ok, false); // straight apostrophe
  assert.equal(validateAction('outcome', 'Don’t Retain - Ineligible').ok, false);  // hyphen not em-dash
  assert.equal(validateAction('outcome', 'retain').ok, false);
  assert.equal(validateAction('outcome', '').ok, false);
});

test('retainerFee accepts positive dollars, rounds, rejects junk', () => {
  assert.deepEqual(validateAction('retainerFee', '2500'), { ok: true, normalized: 2500 });
  assert.deepEqual(validateAction('retainerFee', 1999.6), { ok: true, normalized: 2000 });
  assert.equal(validateAction('retainerFee', '0').ok, false);
  assert.equal(validateAction('retainerFee', '-5').ok, false);
  assert.equal(validateAction('retainerFee', 'abc').ok, false);
  assert.equal(validateAction('retainerFee', '999999').ok, false); // over the cap
});

test('retainerSigned defaults to today and validates format', () => {
  const r = validateAction('retainerSigned', '');
  assert.equal(r.ok, true);
  assert.match(r.normalized, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(validateAction('retainerSigned', '2026-06-22'), { ok: true, normalized: '2026-06-22' });
  assert.equal(validateAction('retainerSigned', '22/06/2026').ok, false);
});

test('no-arg actions pass; unknown action is rejected', () => {
  assert.equal(validateAction('bookingInvite').ok, true);
  assert.equal(validateAction('resendLinks').ok, true);
  assert.equal(validateAction('deleteEverything').ok, false);
});
