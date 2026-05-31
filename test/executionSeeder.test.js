'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { diffPlan, planRowToUniqueKey } = require('../src/services/executionSeederService');

const plan = [
  { documentCode: 'SUPERVISA-PARENTS-PRINCIPALAPPLICANT-PASSPORT-001', documentName: 'Passport' },
  { documentCode: 'SUPERVISA-PARENTS-SPONSOR-PASSPORT-001',           documentName: 'Sponsor Passport' },
  { documentCode: 'SUPERVISA-PARENTS-SPONSOR-BIRTHCERT-001',          documentName: 'Birth Certificate' },
];
const caseRef = '2026-SV-002';

test('uniqueKey scheme matches executionService (`${caseRef}-${documentCode}`)', () => {
  assert.equal(
    planRowToUniqueKey(caseRef, plan[0]),
    '2026-SV-002-SUPERVISA-PARENTS-PRINCIPALAPPLICANT-PASSPORT-001'
  );
});

test('nothing exists yet → everything is created', () => {
  const { toCreate, toSkip } = diffPlan({ plan, existingKeys: new Set(), caseRef });
  assert.equal(toCreate.length, 3);
  assert.equal(toSkip.length, 0);
});

test('all exist → nothing created (idempotent re-run)', () => {
  const existing = new Set(plan.map((r) => planRowToUniqueKey(caseRef, r)));
  const { toCreate, toSkip } = diffPlan({ plan, existingKeys: existing, caseRef });
  assert.equal(toCreate.length, 0);
  assert.equal(toSkip.length, 3);
});

test('partial overlap → only the missing rows are created', () => {
  // Simulate the SV-002 fix: PA passport already there, sponsor rows missing.
  const existing = new Set([planRowToUniqueKey(caseRef, plan[0])]);
  const { toCreate, toSkip } = diffPlan({ plan, existingKeys: existing, caseRef });
  assert.equal(toSkip.length, 1);
  assert.equal(toCreate.length, 2);
  assert.deepEqual(
    toCreate.map((c) => c.row.documentName).sort(),
    ['Birth Certificate', 'Sponsor Passport']
  );
});

test('accepts a plain array of existing keys, not just a Set', () => {
  const existing = [planRowToUniqueKey(caseRef, plan[0])];
  const { toCreate } = diffPlan({ plan, existingKeys: existing, caseRef });
  assert.equal(toCreate.length, 2);
});
