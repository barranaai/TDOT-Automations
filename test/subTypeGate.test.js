'use strict';

// Blank-Sub-Type seeding gate. Live incident 2026-CEC-PR-002 (2026-07-29): a
// direct-retainer case reached Document Collection with NO Case Sub Type; no
// schema matched, and the Template-Board fallback — which applies NO sub-type
// filter when blank — seeded the entire 62-item group across all three variants
// ("triplicate" checklist). A multi-variant case type must now refuse to seed
// until staff choose the Sub Type, and the prune must genuinely recognize
// legacy Template-Board rows (board_relation text is always null from Monday).

const test   = require('node:test');
const assert = require('node:assert/strict');

const checklist  = require('../src/services/checklistService');
const seeder     = require('../src/services/executionSeederService');
const mondayApi  = require('../src/services/mondayApi');

const { caseTypeHasSubTypeVariants } = checklist._internal;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const CEC_PR = 'Canadian Experience Class (Profile Recreation+ITA+Submission)';

test('caseTypeHasSubTypeVariants: true for CEC-PR (registry) and AAIP (config); false for a variant-less type', () => {
  assert.equal(caseTypeHasSubTypeVariants(CEC_PR), true, 'registry-known variants');
  assert.equal(caseTypeHasSubTypeVariants('AAIP'), true, 'config-known variants');
  assert.equal(caseTypeHasSubTypeVariants('Some Unknown Case Type'), false);
});

// A mondayApi router for the DCS flow: item fetch → blank sub-type; captures
// every mutation; the updates feed controls note dedup.
function dcsStub({ subType = '', checklistApplied = 'No', priorNotes = [] } = {}) {
  const calls = { creates: 0, notes: [] };
  const fn = async (q, vars) => {
    if (/getItem|column_values\(ids/.test(q) && /items\(ids/.test(q) && !/updates/.test(q)) {
      return { items: [{ id: '1', name: 'Test Client', column_values: [
        { id: 'text_mm142s49', text: '2026-CEC-PR-002' },
        { id: 'dropdown_mm0xd1qn', text: CEC_PR },
        { id: 'dropdown_mm0x4t91', text: subType },
        { id: 'color_mm0xs7kp', text: checklistApplied },
      ] }] };
    }
    if (/updates\(limit/.test(q)) return { items: [{ updates: priorNotes.map((b) => ({ body: b })) }] };
    if (/create_update/.test(q)) { calls.notes.push(vars.body || (vars && vars.b) || ''); return { create_update: { id: 'u1' } }; }
    if (/create_item/.test(q)) { calls.creates++; return { create_item: { id: 'x' } }; }
    return {};
  };
  return { fn, calls };
}

test('DCS with a blank Sub Type on a multi-variant case type: NOTHING seeds, one staff note posted', async () => {
  const m = dcsStub({ subType: '' });
  const restore = stub(mondayApi, 'query', m.fn);
  try {
    await checklist.onDocumentCollectionStarted({ itemId: '9101', boardId: 'b' });
    assert.equal(m.calls.creates, 0, 'no execution rows created');
    assert.equal(m.calls.notes.length, 1, 'exactly one note');
    assert.match(m.calls.notes[0], /Case Sub Type required/i);
    assert.match(m.calls.notes[0], /Re-seed Checklist/);
  } finally { restore(); }
});

test('the sub-type note is posted ONCE — re-fired triggers dedup via the updates-feed marker', async () => {
  const m = dcsStub({ subType: '', priorNotes: ['old note checklist-blocked-no-subtype marker here'] });
  const restore = stub(mondayApi, 'query', m.fn);
  try {
    await checklist.onDocumentCollectionStarted({ itemId: '9102', boardId: 'b' });
    assert.equal(m.calls.creates, 0);
    assert.equal(m.calls.notes.length, 0, 'marker present → no duplicate note');
  } finally { restore(); }
});

test('an already-applied checklist still short-circuits before the gate (no note spam)', async () => {
  const m = dcsStub({ subType: '', checklistApplied: 'Yes' });
  const restore = stub(mondayApi, 'query', m.fn);
  try {
    await checklist.onDocumentCollectionStarted({ itemId: '9103', boardId: 'b' });
    assert.equal(m.calls.notes.length, 0);
    assert.equal(m.calls.creates, 0);
  } finally { restore(); }
});

// ─── the prune's legacy-row detection ────────────────────────────────────────

test('parseTemplateRel: reads the linked relation from raw value (text is null for board_relation columns)', () => {
  const p = seeder.parseTemplateRel;
  assert.equal(p({ text: null, value: '{"linkedPulseIds":[{"linkedPulseId":123}]}' }), 'linked');
  assert.equal(p({ text: null, value: '{"linked_item_ids":[123]}' }), 'linked');
  assert.equal(p({ text: 'Some Template', value: null }), 'Some Template');
  assert.equal(p({ text: null, value: '{}' }), '');
  assert.equal(p(null), '');
});

test('selectStaleRows: legacy Template-Board rows (linked relation) are NEVER selected for pruning', () => {
  const rows = [
    { id: '1', uniqueKey: 'REF-A1', templateRel: 'linked', subType: 'Old Sub', status: '' }, // template row
    { id: '2', uniqueKey: 'REF-A2', templateRel: '',       subType: 'Old Sub', status: '' }, // schema row, stale
  ];
  const stale = seeder.selectStaleRows(rows, 'New Sub');
  assert.deepEqual(stale.map((r) => r.id), ['2'], 'only the schema-managed row is prunable');
});

test('createDirectClient: a variant-carrying case type REQUIRES a sub-type; with one it passes', async () => {
  const portal      = require('../src/services/consultantPortalService');
  const leadService = require('../src/services/leadService');
  const registry    = require('../src/services/caseTypeRegistryService');
  const handoff     = require('../src/services/handoffService');
  const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  const withSubs = CASE_TYPE_LABELS.find((ct) => (SUB_TYPES_BY_CASE[ct] || []).length);
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('offline'); }),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async () => ({ id: '950' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(handoff, 'openCaseEarly', async () => 'CM-950'),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(
      () => portal.createDirectClient({ fullName: 'A B', email: 'a@b.co', residentialAddress: '1 Main St', caseType: withSubs, consultant: 'Shafoli Kapur' }),
      (e) => e.badRequest === true && /Sub Type/i.test(e.message),
      'blank sub-type on a variant case type must be rejected');
    const ok = await portal.createDirectClient({
      fullName: 'A B', email: 'a@b.co', residentialAddress: '1 Main St', caseType: withSubs,
      caseSubType: (SUB_TYPES_BY_CASE[withSubs] || [])[0], consultant: 'Shafoli Kapur' });
    assert.equal(ok.ok, true, 'with a valid sub-type the creation proceeds');
  } finally { restore.forEach((x) => x()); }
});
