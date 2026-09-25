'use strict';

// The consultation page's Mark-paid dialog names WHICH client: "For Harmeet
// Kaur · 2026-OINP-059", as the cockpit's does. The lead detail carries no case
// reference, so the retainer-plan payload brings it from the Client Master row
// it already reads for the live Case Stage (one query, two cells) and the page
// hands it to the dialog (ship review 2026-09-25, finding 16).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const LEAD = (over = {}) => ({ id: '555001', fullName: 'Harmeet Kaur', email: 'harmeet@example.com', confirmedCaseType: 'OINP', clientMasterItemId: '4001', retainerFee: '2000', retainerHstRate: '13', retainerMilestones: '[]', milestonePayments: '{}', ...over });
const STAGE_COL = 'color_mm0x8faa', REF_COL = 'text_mm142s49';

test('getRetainerPlan: the Client Master read brings the case reference with the stage, picked by column id (board order, not request order)', async () => {
  const queries = [];
  const r1 = stub(leadService, 'getLead', async () => LEAD());
  const r2 = stub(mondayApi, 'query', async (q, vars) => {
    queries.push({ q, vars });
    // the reference cell first: Monday answers in board order
    return { items: [{ column_values: [{ id: REF_COL, text: '2026-OINP-059' }, { id: STAGE_COL, text: 'Document Collection Started' }] }] };
  });
  try {
    const plan = await portal.getRetainerPlan('555001');
    assert.equal(plan.caseRef, '2026-OINP-059');
    assert.equal(plan.currentCaseStage, 'Document Collection Started', 'the stage still hydrates the "DUE" badge');
    assert.equal(queries.length, 1, 'one query for both cells');
    assert.match(queries[0].q, /column_values\(ids:\["color_mm0x8faa","text_mm142s49"\]\)\{ id text \}/);
    assert.deepEqual(queries[0].vars, { i: ['4001'] });
  } finally { r1(); r2(); }
});

test('getRetainerPlan: no case yet, or a failed read, gives blank cells — the dialog then shows the name alone, and the plan still loads', async () => {
  const r1 = stub(leadService, 'getLead', async () => LEAD({ clientMasterItemId: '' }));
  let calls = 0;
  const r2 = stub(mondayApi, 'query', async () => { calls++; throw new Error('should not be asked'); });
  try {
    const plan = await portal.getRetainerPlan('555001');
    assert.equal(plan.caseRef, ''); assert.equal(plan.currentCaseStage, ''); assert.equal(calls, 0, 'a lead with no case row is not looked up');
  } finally { r1(); r2(); }
  const r3 = stub(leadService, 'getLead', async () => LEAD());
  const r4 = stub(mondayApi, 'query', async () => { throw new Error('Monday 502'); });
  try {
    const plan = await portal.getRetainerPlan('555001');
    assert.equal(plan.caseRef, ''); assert.equal(plan.currentCaseStage, '', 'best-effort: the read never breaks the panel');
  } finally { r3(); r4(); }
  // a cell missing from the answer is blank, not a crash
  const r5 = stub(leadService, 'getLead', async () => LEAD());
  const r6 = stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: STAGE_COL, text: 'Internal Review' }] }] }));
  try {
    const plan = await portal.getRetainerPlan('555001');
    assert.equal(plan.caseRef, ''); assert.equal(plan.currentCaseStage, 'Internal Review');
  } finally { r5(); r6(); }
});

test('the consultation page hands the plan’s case reference to the Mark-paid dialog — never the lead detail’s (it has none)', () => {
  const page = fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8');
  const svc  = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  assert.doesNotMatch(page, /D\.caseRef/, 'LAST_DETAIL never carried a caseRef — the old argument was dead');
  assert.match(page, /var RP_CASE_REF='';/);
  assert.match(page, /RP_CASE_REF=d\.caseRef\|\|'';/, 'set where the plan payload hydrates the panel');
  assert.match(page, /tdotOpenMarkPaidModal\(\{ clientName: D\.name\|\|'', caseRef: RP_CASE_REF, m: row,/);
  // both ways the panel hydrates carry it: the detail's embedded plan and the /retainer-plan reload
  assert.match(svc, /retainerPlan: buildRetainerPlanResponse\(lead, \{ currentCaseStage: caseCells\.caseStage, caseRef: caseCells\.caseRef \}\)/);
  assert.match(svc, /return buildRetainerPlanResponse\(lead, \{ currentCaseStage: caseStage, caseRef \}\);/);
  assert.match(svc, /caseRef:\s+extra\.caseRef \|\| '',/);
  assert.doesNotMatch(svc, /readCaseStage\(/, 'one read for both cells');
  // the emitted page script still parses, and the dialog header prints the reference when there is one
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('555001');
  const vm = require('vm');
  const re = /<script>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(html))) { n++; assert.doesNotThrow(() => new vm.Script(m[1]), 'emitted script #' + n + ' parses'); }
  assert.ok(n >= 1);
  assert.ok(html.includes("caseRef: RP_CASE_REF"));
  assert.ok(html.includes("(o.caseRef ? ' · ' + payEsc(o.caseRef) : '')"), 'the shared dialog prints "· <caseRef>" after the name');
});
