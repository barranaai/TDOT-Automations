'use strict';

// End-to-end family-member pipeline: consultant input → save (parseSelections) →
// handoff (planMembersFromConsultant) → board → composition (mapRowsToComposition)
// → checklist (seedPlan) AND questionnaire keys. Asserts that the checklist and
// questionnaire both carry EXACTLY the accompanying family, with matching keys.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseSelections } = require('../src/services/consultantPortalService');
const { planMembersFromConsultant } = require('../src/services/familyCompositionService');
const { mapRowsToComposition } = require('../src/services/compositionAdapter');
const { seedPlan } = require('../src/services/seedPlanner');
const schema = require('../src/data/caseSchemas/canadian-experience-class-ee-after-ita--cec-accompanying-spouse-child.js');

const KEY_RE = /^[a-z][a-z0-9-]{0,40}$/;

function runPipeline(consultantInput) {
  const sel = parseSelections({ template: 'pa', familyMembers: consultantInput });
  const lead = { id: '9001', fullName: 'Aarav Sharma', email: 'a@x.com',
    confirmedCaseType: schema.caseType, retainerFamilyMembers: JSON.stringify(sel.familyMembers || []) };
  const boardRows = planMembersFromConsultant(lead).map((r) => ({ memberType: r.memberType, name: r.name, memberKey: r.memberKey, flagsText: '' }));
  const comp = mapRowsToComposition(boardRows);
  const rows = seedPlan({ schema, composition: comp });
  const qMembers = ['primary'].concat(boardRows.map((r) => r.memberKey));
  const applicants = new Set(rows.map((r) => r.applicantType));
  return { sel, boardRows, comp, rows, qMembers, applicants };
}

test('e2e: accompanying spouse + child flow through to BOTH checklist and questionnaire; non-accompanying excluded', () => {
  const r = runPipeline([
    { type: 'Spouse',          name: 'Priya',  accompanying: true  },
    { type: 'Dependent Child', name: 'Aanya',  accompanying: true  },
    { type: 'Dependent Child', name: 'Vihaan', accompanying: false }, // stays abroad
    { type: 'Worker Spouse',   name: 'x',      accompanying: true  }, // invalid type
  ]);

  // save drops the invalid type, keeps the 3 valid
  assert.equal(r.sel.familyMembers.length, 3);

  // only the 2 accompanying members reach the board
  assert.deepEqual(r.boardRows.map((b) => b.memberKey), ['spouse', 'child-1']);

  // composition flags both on
  assert.equal(r.comp.caseFlags.spouseIncluded, true);
  assert.equal(r.comp.caseFlags.childrenIncluded, true);

  // CHECKLIST: spouse + the accompanying child seed; the non-accompanying child does NOT
  assert.ok(r.applicants.has('Spouse'));
  assert.ok(r.applicants.has('Dependent Child 1'));
  assert.ok(!r.applicants.has('Dependent Child 2'));

  // QUESTIONNAIRE: same members, keys valid for manifest reuse
  assert.deepEqual(r.qMembers, ['primary', 'spouse', 'child-1']);
  assert.ok(r.boardRows.every((b) => KEY_RE.test(b.memberKey)));

  // checklist child index lines up with the questionnaire key (both = the accompanying child)
  assert.ok(r.rows.some((row) => /DEPENDENTCHILD1-/.test(row.documentCode)));
});

test('e2e: principal applicant only when no accompanying family', () => {
  const r = runPipeline([{ type: 'Spouse', name: 'Priya', accompanying: false }]);
  assert.equal(r.boardRows.length, 0);                 // nobody accompanies → no board rows
  assert.ok(!r.applicants.has('Spouse'));              // no spouse docs
  assert.deepEqual(r.qMembers, ['primary']);           // questionnaire is primary-only
});
