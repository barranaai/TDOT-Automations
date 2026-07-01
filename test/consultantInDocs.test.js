'use strict';

// The routed consultant (Shermin or Shafoli) must appear as the signatory on BOTH
// the initial consultation agreement and the retainer agreement. This covers the
// resolution (lead → consultant record), the shared merge fields, and — crucially —
// that the .docx templates actually carry the {consultantName}/{rcicNumber} tags
// (a template re-import that dropped them would silently reprint one hardcoded RCIC).

const test   = require('node:test');
const assert = require('node:assert/strict');

const { resolveConsultant, consultantMergeFields, CONSULTANTS } = require('../config/consultantRouting');
const { fillMaster } = require('../src/services/retainerDocService');
const PizZip = require('pizzip');

function rendered(tpl, data) {
  const xml = new PizZip(fillMaster(tpl, data)).file('word/document.xml').asText();
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

test('resolveConsultant: assignedConsultant name → the matching registry record', () => {
  assert.equal(resolveConsultant({ assignedConsultant: 'Shermin Teymouri Mofrad' }).key, 'shermin');
  assert.equal(resolveConsultant({ assignedConsultant: 'Shafoli Kapur' }).key, 'shafoli');
});

test('resolveConsultant: blank or unknown pin falls back to live routing (never undefined)', () => {
  // no pin → routing. A generic lead routes to Shermin.
  assert.equal(resolveConsultant({}).key, 'shermin');
  // name drift → routing fallback, still a real consultant
  const r = resolveConsultant({ assignedConsultant: 'Someone Not In The Registry' });
  assert.ok(r && r.name && r.key);
  // a removal-order lead pins to Shafoli via routing even with no assignedConsultant
  assert.equal(resolveConsultant({ removalOrder: 'Yes' }).key, 'shafoli');
});

test('consultantMergeFields: shared shape; Shafoli carries R518177, Shermin blank by default', () => {
  const shafoli = consultantMergeFields({ assignedConsultant: 'Shafoli Kapur' });
  assert.deepEqual(Object.keys(shafoli).sort(), ['consultantName', 'rcicNumber', 'rcicTitle']);
  assert.equal(shafoli.consultantName, 'Shafoli Kapur');
  assert.equal(shafoli.rcicNumber, CONSULTANTS.shafoli.rcicNumber); // 'R518177' unless env-overridden
  const shermin = consultantMergeFields({ assignedConsultant: 'Shermin Teymouri Mofrad' });
  assert.equal(shermin.consultantName, 'Shermin Teymouri Mofrad');
  assert.equal(shermin.rcicNumber, CONSULTANTS.shermin.rcicNumber); // '' until configured
});

test('templates carry the merge tags: each renders the routed consultant, no hardcoded leak', () => {
  for (const tpl of ['consult', 'pa', 'pa-inviter', 'employer']) {
    const data = Object.assign(
      { agreementDate: 'x', paName: 'Test Client', applicationType: 'Study permit', scopeAnnexNo: 'A', paymentAnnexNo: 'B' },
      consultantMergeFields({ assignedConsultant: 'Shermin Teymouri Mofrad' }),
    );
    const t = rendered(tpl, data);
    assert.ok(t.includes('Shermin Teymouri Mofrad'), `${tpl}: routed consultant name missing`);
    assert.ok(!t.includes('Shafoli Kapur'), `${tpl}: hardcoded 'Shafoli Kapur' still leaks for a Shermin lead`);
    assert.ok(!/\{consultantName\}|\{rcicNumber\}/.test(t), `${tpl}: unresolved merge tag left in the document`);
  }
});

test('retainer mergeData includes the signatory fields', () => {
  const { buildRetainerPlan } = require('../src/services/retainerPlanBuilder');
  const plan = buildRetainerPlan(
    { fullName: 'Test Client', retainerFee: '2000', assignedConsultant: 'Shafoli Kapur' },
    {},
  );
  assert.equal(plan.mergeData.consultantName, 'Shafoli Kapur');
  assert.equal(plan.mergeData.rcicNumber, CONSULTANTS.shafoli.rcicNumber);
});
