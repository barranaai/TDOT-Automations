'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { mapRowsToComposition } = require('../src/services/compositionAdapter');
const { seedPlan } = require('../src/services/seedPlanner');

// ── supporterIncluded: derived from a Sponsor member (was a dead flag) ──
test('mapRowsToComposition derives supporterIncluded from a Sponsor row', () => {
  const noSponsor = mapRowsToComposition([{ memberType: 'Spouse', name: 'Jane', memberKey: 'spouse' }]);
  assert.equal(noSponsor.caseFlags.supporterIncluded, false);

  const withSponsor = mapRowsToComposition([{ memberType: 'Sponsor', name: 'Funder', memberKey: 'sponsor' }]);
  assert.equal(withSponsor.caseFlags.supporterIncluded, true);
  // siblings still derive correctly
  assert.equal(withSponsor.caseFlags.spouseIncluded, false);
});

// ── stable per-member checklist keying (index from memberKey, not array order) ──
const SCHEMA = {
  caseType: 'X', subType: 'Y',
  roles: [
    { role: 'PrincipalApplicant', required: true, documents: [{ code: 'PP', name: 'Passport' }] },
    { role: 'DependentChild', multipleAllowed: true, includeWhen: { caseFlag: 'childrenIncluded' }, documents: [{ code: 'PP', name: 'Passport' }] },
  ],
};
const childCodes = (members) =>
  seedPlan({ schema: SCHEMA, composition: { caseFlags: { childrenIncluded: true }, members } })
    .filter((r) => r.role === 'DependentChild').map((r) => r.documentCode).sort();

test('per-member document codes are stable across board reordering', () => {
  const ordered   = childCodes([{ role: 'DependentChild', memberKey: 'child-1' }, { role: 'DependentChild', memberKey: 'child-2' }]);
  const reordered = childCodes([{ role: 'DependentChild', memberKey: 'child-2' }, { role: 'DependentChild', memberKey: 'child-1' }]);
  assert.deepEqual(reordered, ordered); // same set regardless of order — no duplicate codes
});

test('removing a middle child does not renumber the others', () => {
  const codes = childCodes([{ role: 'DependentChild', memberKey: 'child-1' }, { role: 'DependentChild', memberKey: 'child-3' }]);
  assert.ok(codes.some((c) => /DEPENDENTCHILD1-/.test(c)));
  assert.ok(codes.some((c) => /DEPENDENTCHILD3-/.test(c))); // child-3 keeps index 3, not bumped to 2
});

test('falls back to array position when a memberKey carries no number', () => {
  const codes = childCodes([{ role: 'DependentChild', memberKey: '' }, { role: 'DependentChild', memberKey: '' }]);
  assert.deepEqual(codes, ['X-Y-DEPENDENTCHILD1-PP-001', 'X-Y-DEPENDENTCHILD2-PP-001']);
});
