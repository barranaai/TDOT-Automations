'use strict';

// Consultant-set family members: the retainer panel collects {type,name,accompanying};
// at handoff only ACCOMPANYING members are materialised to the Family Members board
// (driving the per-member checklist + questionnaire). These tests pin both the
// portal-side normalization and the handoff-side planning.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { parseSelections } = require('../src/services/consultantPortalService');
const { planMembersFromConsultant } = require('../src/services/familyCompositionService');

test('parseSelections whitelists family member types and coerces accompanying', () => {
  const sel = parseSelections({
    template: 'pa', annexCode: 'X', feeCents: 100,
    familyMembers: [
      { type: 'Spouse', name: ' Jane ', accompanying: true },
      { type: 'Dependent Child', name: 'Kid', accompanying: 'Yes' },
      { type: 'Principal Applicant', name: 'PA', accompanying: true }, // not a valid family type → dropped
      { type: 'Bogus', name: 'x', accompanying: true },                // unknown → dropped
    ],
  });
  assert.deepEqual(sel.familyMembers, [
    { type: 'Spouse', name: 'Jane', accompanying: true },
    { type: 'Dependent Child', name: 'Kid', accompanying: true },
  ]);
});

test('parseSelections caps the family list length', () => {
  const many = Array.from({ length: 30 }, () => ({ type: 'Sibling', name: 's', accompanying: true }));
  const sel = parseSelections({ template: 'pa', familyMembers: many });
  assert.equal(sel.familyMembers.length, 20);
});

test('planMembersFromConsultant materialises only accompanying members with board keys', () => {
  const rows = planMembersFromConsultant({ retainerFamilyMembers: JSON.stringify([
    { type: 'Spouse', name: 'Jane Doe', accompanying: true },
    { type: 'Dependent Child', name: 'Kid A', accompanying: true },
    { type: 'Dependent Child', name: 'Kid B', accompanying: false }, // non-accompanying → no row
    { type: 'Parent', name: 'Mom', accompanying: true },
  ]) });
  assert.deepEqual(rows, [
    { memberType: 'Spouse', name: 'Jane Doe', memberKey: 'spouse' },
    { memberType: 'Dependent Child', name: 'Kid A', memberKey: 'child-1' },
    { memberType: 'Parent', name: 'Mom', memberKey: 'parent-1' },
  ]);
});

test('planMembersFromConsultant: unset → null (fall back to intake); explicit empty → []', () => {
  assert.equal(planMembersFromConsultant({}), null);
  assert.deepEqual(planMembersFromConsultant({ retainerFamilyMembers: '[]' }), []);
  assert.deepEqual(planMembersFromConsultant({ retainerFamilyMembers: JSON.stringify([{ type: 'Spouse', accompanying: false }]) }), []);
});

test('planMembersFromConsultant: blank name gets a placeholder, multi children indexed', () => {
  const rows = planMembersFromConsultant({ retainerFamilyMembers: JSON.stringify([
    { type: 'Spouse', accompanying: true },
    { type: 'Dependent Child', name: 'A', accompanying: true },
    { type: 'Dependent Child', name: 'B', accompanying: true },
  ]) });
  assert.deepEqual(rows, [
    { memberType: 'Spouse', name: 'Spouse (consultant-set)', memberKey: 'spouse' },
    { memberType: 'Dependent Child', name: 'A', memberKey: 'child-1' },
    { memberType: 'Dependent Child', name: 'B', memberKey: 'child-2' },
  ]);
});
