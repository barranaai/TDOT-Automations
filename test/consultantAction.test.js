'use strict';

// Validation tests for the consultant-portal write actions. validateAction is
// the safety gate: it must reject anything that could mint a junk Monday label
// (create_labels_if_missing) or write a malformed value to the lead board.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { validateAction, parseSelections, OUTCOME_LABELS } = require('../src/services/consultantPortalService');

test('outcome accepts only the exact board labels (four since 2026-10-15); "Not Wanted" needs a reason', () => {
  for (const label of OUTCOME_LABELS) {
    if (label === 'Not Wanted') continue;
    assert.deepEqual(validateAction('outcome', label), { ok: true, normalized: label, reason: '' });
  }
  assert.deepEqual(OUTCOME_LABELS, ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted']);
  assert.equal(validateAction('outcome', 'Not Wanted').ok, false, 'no reason → refused');
  assert.deepEqual(validateAction('outcome', { label: 'Not Wanted', reason: ' rude  to staff ' }), { ok: true, normalized: 'Not Wanted', reason: 'rude to staff' });
});

test('outcome rejects near-matches and the retired labels that would mint junk labels', () => {
  assert.equal(validateAction('outcome', 'Not wanted').ok, false);                    // case
  assert.equal(validateAction('outcome', 'Not Wanted ').ok, false);                   // trailing space
  assert.equal(validateAction('outcome', 'Follow-up').ok, false);                     // case
  assert.equal(validateAction('outcome', 'Follow–Up').ok, false);                     // en dash
  assert.equal(validateAction('outcome', 'Don’t Retain — Ineligible').ok, false);     // retired 2026-10-15 (read as Follow-Up, never written)
  assert.equal(validateAction('outcome', 'Don’t Retain — Not Wanted').ok, false);     // retired 2026-10-15 (read as Not Wanted, never written)
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

test('retainerFee rejects loosely-typed inputs (boolean / array / hex / exponent)', () => {
  assert.equal(validateAction('retainerFee', true).ok, false);  // Number(true) === 1
  assert.equal(validateAction('retainerFee', [5]).ok, false);   // Number([5]) === 5
  assert.equal(validateAction('retainerFee', '0x10').ok, false); // hex
  assert.equal(validateAction('retainerFee', '1e9').ok, false);  // exponent
  assert.deepEqual(validateAction('retainerFee', '3500'), { ok: true, normalized: 3500 });
});

test('retainerSigned rejects structurally-valid but impossible dates', () => {
  assert.equal(validateAction('retainerSigned', '2026-13-99').ok, false);
  assert.equal(validateAction('retainerSigned', '2026-02-30').ok, false);
  assert.equal(validateAction('retainerSigned', '9999-99-99').ok, false);
  assert.equal(validateAction('retainerSigned', '2026-06-29').ok, true);
});

test('parseSelections bounds fee/govFee to non-negative within cap', () => {
  assert.equal(parseSelections({ template: 'pa', feeCents: -5 }).feeCents, undefined);
  assert.equal(parseSelections({ template: 'pa', govFeeDollars: -1 }).govFeeDollars, undefined);
  assert.equal(parseSelections({ template: 'pa', feeCents: 9e12 }).feeCents, undefined);
  assert.equal(parseSelections({ template: 'pa', feeCents: 350000 }).feeCents, 350000);
});
