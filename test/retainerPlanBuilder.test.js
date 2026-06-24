'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { buildRetainerPlan } = require('../src/services/retainerPlanBuilder');
const { fillMaster } = require('../src/services/retainerDocService');

const noLeftoverTags = (buf) =>
  !/\{[a-z][a-zA-Z]+\}/.test(new PizZip(buf).file('word/document.xml').asText());

const baseLead = {
  id: '1', name: 'Barrana Test', fullName: 'Barrana Test',
  email: 'barrana@example.com', phone: '4165550100',
  residentialAddress: '123 Main St, Toronto, ON',
  confirmedCaseType: 'CEC', caseTypeInterest: 'CEC',
  hasSpouse: 'Yes', childrenCount: '2', retainerFee: '2500',
};

test('PA happy path: CEC + fee → ready, merge data correct', () => {
  const p = buildRetainerPlan(baseLead);
  assert.equal(p.template, 'pa');
  assert.equal(p.annex.code, 'P2');
  assert.equal(p.annex.id, 'canadian-experience-class');
  assert.equal(p.ready, true);
  assert.equal(p.warnings.length, 0);
  assert.equal(p.mergeData.paName, 'Barrana Test');
  assert.equal(p.mergeData.paAddress, '123 Main St, Toronto, ON');
  assert.equal(p.mergeData.paEmail, 'barrana@example.com');
  assert.equal(p.mergeData.applicationType, 'Canadian Experience Class');
  assert.equal(p.mergeData.scopeAnnexNo, 'P2');
  assert.equal(p.mergeData.serviceFees, '2,500.00');
  assert.equal(p.mergeData.hst, '325.00');
  assert.equal(p.mergeData.total, '2,825.00');
  assert.match(p.mergeData.agreementDate, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/); // "June 24, 2026"
});

test('applicant count + government fee scale by family (spouse + 2 kids)', () => {
  const p = buildRetainerPlan(baseLead);
  assert.deepEqual(p.applicants, { adults: 2, children: 2, total: 4 });
  // economic-pr: 1590 (PA) + 1590 (spouse) + 270*2 (children) = 3720
  assert.equal(p.govFee.dollars, 3720);
  assert.equal(p.mergeData.govFee, '3,720.00');
});

test('missing fee → not ready, fees null, blanks, warns', () => {
  const p = buildRetainerPlan({ ...baseLead, retainerFee: '' });
  assert.equal(p.ready, false);
  assert.equal(p.fees, null);
  assert.equal(p.mergeData.serviceFees, '');
  assert.ok(p.warnings.some((w) => /fee is not set/i.test(w)));
});

test('sponsorship → pa-inviter; needs inviter data; provided → ready', () => {
  const lead = { ...baseLead, confirmedCaseType: 'Inland Spousal Sponsorship', caseTypeInterest: 'Inland Spousal Sponsorship' };
  const p1 = buildRetainerPlan(lead);
  assert.equal(p1.annex.code, 'P8');
  assert.equal(p1.template, 'pa-inviter');
  assert.equal(p1.ready, false);
  assert.deepEqual(p1.missingForTemplate, ['inviterName', 'inviterAddress', 'inviterPhone', 'inviterEmail']);

  const p2 = buildRetainerPlan(lead, {
    inviterName: 'Spouse X', inviterAddress: '9 King St W, Toronto', inviterPhone: '4160000000', inviterEmail: 's@x.com',
  });
  assert.equal(p2.ready, true);
  assert.equal(p2.mergeData.inviterName, 'Spouse X');
  assert.equal(p2.missingForTemplate.length, 0);
});

test('LMIA → employer template + employer-paid flat gov fee', () => {
  const lead = { ...baseLead, confirmedCaseType: 'LMIA', caseTypeInterest: 'LMIA' };
  const p = buildRetainerPlan(lead);
  assert.equal(p.annex.code, 'P6');
  assert.equal(p.template, 'employer');
  assert.equal(p.govFee.dollars, 1000);
  assert.equal(p.govFee.employerPaid, true);
  assert.ok(p.missingForTemplate.includes('empRepName'));
  assert.equal(p.ready, false);
});

test('case type from interest (not staff-confirmed) warns', () => {
  const p = buildRetainerPlan({ ...baseLead, confirmedCaseType: '', caseTypeInterest: 'CEC' });
  assert.ok(p.warnings.some((w) => /not staff-confirmed/i.test(w)));
});

test('Federal PR flagged for P3-vs-P4 verification; override clears it', () => {
  const lead = { ...baseLead, confirmedCaseType: 'Federal PR', caseTypeInterest: 'Federal PR' };
  const sugg = buildRetainerPlan(lead);
  assert.equal(sugg.annex.code, 'P3');
  assert.equal(sugg.annex.needsVerify, true);
  assert.ok(sugg.warnings.some((w) => /Verify scope annex/i.test(w)));

  const conf = buildRetainerPlan(lead, { annexCode: 'P4' });
  assert.equal(conf.annex.code, 'P4');
  assert.equal(conf.annex.confidence, 'confirmed');
  assert.equal(conf.annex.needsVerify, false);
  assert.ok(!conf.warnings.some((w) => /Verify scope annex/i.test(w)));
});

test('hasSpouse "Yes"/"No" status text handled (no truthy-string bug)', () => {
  assert.equal(buildRetainerPlan({ ...baseLead, hasSpouse: 'No', childrenCount: '0' }).applicants.total, 1);
  assert.equal(buildRetainerPlan({ ...baseLead, hasSpouse: 'Yes', childrenCount: '0' }).applicants.total, 2);
});

test('fee as $-formatted dollar string parses to cents', () => {
  const p = buildRetainerPlan({ ...baseLead, retainerFee: '$3,200.50' });
  assert.equal(p.fees.feeCents, 320050);
  assert.equal(p.mergeData.serviceFees, '3,200.50');
});

test('coverage-gap case type → no annex, not ready, scope blank', () => {
  const p = buildRetainerPlan({ ...baseLead, confirmedCaseType: 'Co-op WP', caseTypeInterest: 'Co-op WP' });
  assert.equal(p.annex.code, null);
  assert.equal(p.ready, false);
  assert.equal(p.mergeData.scopeAnnexNo, '');
  assert.ok(p.warnings.some((w) => /annex/i.test(w)));
});

test('blank residential address warns', () => {
  const p = buildRetainerPlan({ ...baseLead, residentialAddress: '' });
  assert.ok(p.warnings.some((w) => /address is blank/i.test(w)));
});

test('sub-type drives base-vs-extension annex via override', () => {
  const base = buildRetainerPlan({ ...baseLead, confirmedCaseType: 'PGWP' });
  assert.equal(base.annex.code, 'T3');
  const ext = buildRetainerPlan({ ...baseLead, confirmedCaseType: 'PGWP' }, { subType: 'Extension - Single Applicant' });
  assert.equal(ext.annex.code, 'T4');
});

// The critical cross-check: the bridge's mergeData keys must cover EVERY tag in
// each real template — otherwise a placeholder would survive into a signed legal doc.
test('bridge mergeData fills every template tag (no leftover placeholders)', () => {
  const pa = buildRetainerPlan(baseLead);
  assert.ok(noLeftoverTags(fillMaster('pa', pa.mergeData)), 'pa template fully filled');

  const inv = buildRetainerPlan(
    { ...baseLead, confirmedCaseType: 'Inland Spousal Sponsorship' },
    { inviterName: 'Inv', inviterAddress: 'Addr', inviterPhone: '4160000000', inviterEmail: 'i@x.com' },
  );
  assert.ok(noLeftoverTags(fillMaster('pa-inviter', inv.mergeData)), 'pa-inviter template fully filled');

  const emp = buildRetainerPlan(
    { ...baseLead, confirmedCaseType: 'LMIA' },
    { empRepName: 'Rep', empCompanyName: 'Co', empCompanyAddress: 'Addr', empCompanyPhone: '111', empRepPhone: '222', empRepEmail: 'r@co.com', paymentAnnexNo: 'B' },
  );
  assert.ok(noLeftoverTags(fillMaster('employer', emp.mergeData)), 'employer template fully filled');
});
