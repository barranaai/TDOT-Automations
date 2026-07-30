'use strict';

// Canonical case-type + sub-type end to end (user directive 2026-07-30): the
// retainer panel's new pickers, the lead columns, Client Master, and the
// checklist/questionnaire seeders must share ONE vocabulary. saveRetainerSelections
// therefore validates against the same canon the pickers' options endpoint
// serves (live registry ∪ config fallback) and writes confirmedCaseType.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { applyAction } = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const registry    = require('../src/services/caseTypeRegistryService');
const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');

const VARIANT_CT   = Object.keys(SUB_TYPES_BY_CASE).find((ct) => (SUB_TYPES_BY_CASE[ct] || []).length >= 2);
const VARIANT_SUB  = SUB_TYPES_BY_CASE[VARIANT_CT][0];
const PLAIN_CT     = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

async function withStubs(fn, leadOverrides) {
  const writes = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({
      id, fullName: 'Canon Lead', retainerSent: '', email: 'client@x.com', retainerFee: '2500',
      ...(leadOverrides || {}),
    })),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ fields, opts }); }),
    stub(mondayApi, 'query', async () => ({})),
    stub(registry, 'getCaseTypes', async () => { throw new Error('offline — config canon'); }),
  ];
  try { return await fn(writes); } finally { restore.forEach((r) => r()); }
}

const sel = (over) => JSON.stringify({
  template: 'pa', annexCode: 'P2', feeCents: 250000,
  milestones: [
    { label: 'Non-refundable administrative fee', amountCents: 100000, trigger: 'On signing' },
    { label: 'Milestone 2', amountCents: 150000, trigger: 'On submission' },
  ],
  ...over,
});

test('canon fixtures exist in config', () => {
  assert.ok(VARIANT_CT, 'a case type with sub-type variants exists');
  assert.ok(PLAIN_CT, 'a case type without variants exists');
});

test('save rejects a non-canonical case type', () =>
  withStubs(async () => {
    await assert.rejects(
      () => applyAction({ leadId: '1', action: 'saveRetainerSelections', value: sel({ caseType: 'Made Up Visa' }) }),
      /not a canonical case type/i);
  }));

test('save writes confirmedCaseType for a canonical pick (+ canonical sub-type persists)', () =>
  withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'saveRetainerSelections',
      value: sel({ caseType: VARIANT_CT, subType: VARIANT_SUB }) });
    assert.equal(r.ok, true);
    const w = writes.find((x) => x.fields.confirmedCaseType);
    assert.ok(w, 'confirmedCaseType written');
    assert.equal(w.fields.confirmedCaseType, VARIANT_CT);
    assert.equal(w.fields.selectedSubType, VARIANT_SUB);
  }));

test('save rejects a sub-type that is not one of the case type variants', () =>
  withStubs(async () => {
    await assert.rejects(
      () => applyAction({ leadId: '1', action: 'saveRetainerSelections',
        value: sel({ caseType: VARIANT_CT, subType: 'Extention (typo)' }) }),
      /not a known sub-type/i);
  }));

test('save clears the sub-type for a case type with no variants', () =>
  withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'saveRetainerSelections',
      value: sel({ caseType: PLAIN_CT, subType: 'Leftover Free Text' }) });
    assert.equal(r.ok, true);
    const w = writes.find((x) => 'selectedSubType' in x.fields);
    assert.equal(w.fields.selectedSubType, '', 'free-typed sub-type cannot survive on a variant-less case type');
  }));

test('no case type picked → confirmedCaseType untouched, sub-type validated against the lead\'s current case type', () =>
  withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'saveRetainerSelections',
      value: sel({ subType: VARIANT_SUB }) });
    assert.equal(r.ok, true);
    assert.ok(!writes.some((x) => 'confirmedCaseType' in x.fields), 'blank pick never clears the stored confirmation');
    assert.equal(writes.find((x) => 'selectedSubType' in x.fields).fields.selectedSubType, VARIANT_SUB);
  }, { confirmedCaseType: VARIANT_CT }));

test('OMITTED case/sub-type (options never loaded client-side) leaves stored values untouched', () =>
  withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'saveRetainerSelections', value: sel({}) }); // no caseType, no subType keys
    assert.equal(r.ok, true);
    const w = writes[0];
    assert.ok(!('confirmedCaseType' in w.fields), 'case type untouched');
    assert.ok(!('selectedSubType' in w.fields), 'sub-type not written');
    assert.ok(!(w.opts.clearKeys || []).includes('selectedSubType'), 'sub-type not cleared either — omission is not blank');
  }, { confirmedCaseType: VARIANT_CT, selectedSubType: VARIANT_SUB }));

test('legacy NON-canonical lead case type: stored sub-type passes through, never force-cleared', () =>
  withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'saveRetainerSelections',
      value: sel({ subType: 'Old Free Text' }) }); // legacy pair predates the canon
    assert.equal(r.ok, true);
    assert.equal(writes[0].fields.selectedSubType, 'Old Free Text',
      'unknown case type → no variant list to validate against — the stored pair survives until staff confirm a canonical type');
  }, { confirmedCaseType: '', caseTypeInterest: 'Work Permit' }));

test('retainAndSend blocks a variant case type with a blank sub-type (checklist would stall at case-open)', () =>
  withStubs(async () => {
    await assert.rejects(
      () => applyAction({ leadId: '1', action: 'retainAndSend', value: null }),
      /needs a Sub-type before sending/i);
  }, { confirmedCaseType: VARIANT_CT, selectedSubType: '', retainerFee: '2500', retainerSigned: '', conversionStatus: '' }));

test('detail page: canonical pickers present and wired', () => {
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('555');
  assert.ok(html.includes('id="rp-casetype"'), 'case-type select present');
  assert.ok(html.includes('<select id="rp-subtype">'), 'sub-type is a SELECT, not free text');
  assert.ok(html.includes('rpPopulateSubtypes'), 'dependent repopulation wired');
  assert.ok(html.includes("'/api/consultation/direct-client/options'"), 'pickers share the direct-form canon endpoint');
  assert.ok(html.includes('if(RP_CT_OPTS){'), 'case/sub-type only enter the payload once the canon options loaded');
  assert.ok(html.includes('data-noncanon'), 'legacy values are displayed but flagged, never submitted');
  assert.ok(html.includes('rpSelectedNonCanon'), 'collectSelections neutralizes flagged legacy selections');
  assert.ok(html.includes('(loading list…)'), 'stored values stay visible while the options fetch is in flight');
});
