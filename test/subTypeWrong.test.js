'use strict';

// WRONG Case Sub Type (Faran 2026-09-15). The Sub Type dropdown is shared across
// case types; live 2026-CEC-EE-080 carried "Single Applicant" (a PGWP / Study
// Permit label) on a CEC case, matched nothing, and the checklist silently
// never built. It must now stop with ONE staff note naming the valid options —
// and never block a sub-type that any catalogue or the Template Board knows.

const test   = require('node:test');
const assert = require('node:assert/strict');

const checklist       = require('../src/services/checklistService');
const mondayApi       = require('../src/services/mondayApi');
const templateService = require('../src/services/templateService');

const { knownSubTypeLabels, checkSubTypeKnown, displayedSubTypeLabels } = checklist._internal;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const CEC_EE = 'Canadian Experience Class (EE after ITA)';

// mondayApi router for the DCS flow: the item fetch returns the given sub-type;
// captures notes and row creates; the updates feed drives note dedup.
function dcsStub({ caseType = CEC_EE, subType, checklistApplied = 'No', priorNotes = [] }) {
  const calls = { creates: 0, notes: [] };
  const fn = async (q, vars) => {
    if (/items\(ids/.test(q) && /column_values\(ids/.test(q) && !/updates/.test(q)) {
      return { items: [{ id: '1', name: 'Test Client', column_values: [
        { id: 'text_mm142s49', text: '2026-CEC-EE-999' },
        { id: 'dropdown_mm0xd1qn', text: caseType },
        { id: 'dropdown_mm0x4t91', text: subType },
        { id: 'color_mm0xs7kp', text: checklistApplied },
      ] }] };
    }
    if (/updates\(limit/.test(q)) return { items: [{ updates: priorNotes.map((b) => ({ body: b })) }] };
    if (/create_update/.test(q)) { calls.notes.push(vars.body || vars.b || ''); return { create_update: { id: 'u1' } }; }
    if (/create_item/.test(q)) { calls.creates++; return { create_item: { id: 'x' } }; }
    return {};
  };
  return { fn, calls };
}

async function runDcs(state, templateImpl) {
  const m = dcsStub(state);
  const prevSchema = process.env.SCHEMA_DRIVEN_SEEDING;
  process.env.SCHEMA_DRIVEN_SEEDING = '';   // keep a known-good sub-type from seeding for real
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(templateService, 'getTemplateItemsByCaseType', templateImpl || (async () => { throw new Error(`No template group found for case type "${state.caseType || CEC_EE}".`); })),
  ];
  try { await checklist.onDocumentCollectionStarted({ itemId: String(state.itemId || '9201'), boardId: 'b' }); }
  finally { restore.forEach((r) => r()); if (prevSchema === undefined) delete process.env.SCHEMA_DRIVEN_SEEDING; else process.env.SCHEMA_DRIVEN_SEEDING = prevSchema; }
  return m.calls;
}

// ─── the catalogue check ─────────────────────────────────────────────────────

test('knownSubTypeLabels: CEC (EE after ITA) has exactly its two variants', () => {
  assert.deepEqual(knownSubTypeLabels(CEC_EE), ['CEC Accompanying Spouse & Child', 'CEC Single Applicant']);
});

test('checkSubTypeKnown: the live mistake is refused; the right label is accepted exactly as the seeder would match it', async () => {
  const restore = stub(templateService, 'getTemplateItemsByCaseType', async () => { throw new Error('No template group found for case type "x".'); });
  try {
    assert.equal((await checkSubTypeKnown(CEC_EE, 'Single Applicant')).known, false, 'a PGWP / Study Permit label');
    assert.equal((await checkSubTypeKnown(CEC_EE, 'CEC Single Applicant')).known, true);
    assert.equal((await checkSubTypeKnown(CEC_EE, '  cec single applicant ')).known, true, 'outer spaces and case: the seeder ignores them too');
    // An inner double space: caseSchemaService.keyOf and the template filter can't
    // match it, so accepting it would bring back the silent empty checklist.
    assert.equal((await checkSubTypeKnown(CEC_EE, 'CEC  Single Applicant')).known, false);
  } finally { restore(); }
});

test('checkSubTypeKnown: a registry-only variant (OINP streams the config does not list) is accepted', async () => {
  const restore = stub(templateService, 'getTemplateItemsByCaseType', async () => { throw new Error('must not be needed'); });
  try {
    const oinp = knownSubTypeLabels('OINP');
    const registryOnly = oinp.find((l) => /masters graduate stream/i.test(l));
    assert.ok(registryOnly, 'fixture: the registry knows an OINP stream');
    assert.equal((await checkSubTypeKnown('OINP', registryOnly)).known, true);
  } finally { restore(); }
});

test('checkSubTypeKnown: a legacy Template-Board-only variant is accepted (never block a case that would seed)', async () => {
  const restore = stub(templateService, 'getTemplateItemsByCaseType', async () => ([
    { caseSubType: '' }, { caseSubType: 'Legacy Stream' },
  ]));
  try {
    assert.equal((await checkSubTypeKnown('AAIP', 'Legacy Stream')).known, true);
    assert.equal((await checkSubTypeKnown('AAIP', 'Nonsense Stream')).known, false);
  } finally { restore(); }
});

test('checkSubTypeKnown: a TRANSIENT Template-Board failure fails OPEN — a Monday blip never blocks seeding', async () => {
  const restore = stub(templateService, 'getTemplateItemsByCaseType', async () => { throw new Error('Request failed with status code 502'); });
  try {
    assert.equal((await checkSubTypeKnown(CEC_EE, 'Single Applicant')).known, true);
  } finally { restore(); }
});

test('checkSubTypeKnown: a case type with no catalogued variants is never judged', async () => {
  assert.equal((await checkSubTypeKnown('Some Unknown Case Type', 'Anything')).known, true);
});

// ─── the flow ────────────────────────────────────────────────────────────────

test('DCS with a WRONG Sub Type: nothing seeds, one note naming the wrong value and both valid options', async () => {
  const calls = await runDcs({ subType: 'Single Applicant', itemId: '9202' });
  assert.equal(calls.creates, 0, 'no execution rows created');
  assert.equal(calls.notes.length, 1, 'exactly one note');
  const n = calls.notes[0];
  assert.match(n, /Document checklist NOT created — the Case Sub Type doesn't match this case type/);
  assert.match(n, /“Single Applicant” is not a Sub Type of “Canadian Experience Class \(EE after ITA\)”/);
  assert.match(n, /<b>CEC Accompanying Spouse &amp; Child<\/b>, <b>CEC Single Applicant<\/b>/, 'valid options, HTML-escaped');
  assert.match(n, /Re-seed Checklist/);
  assert.match(n, /While the case is at <b>Document Collection Started<\/b> the checklist then builds automatically; otherwise flip/, 'no promise the automation cannot keep');
  assert.match(n, /checklist-blocked-wrong-subtype:canadian-experience-class-ee-after-ita-:single-applicant;/, 'marker: case type + value, closed');
});

const markerFor = (ct, v) => `checklist-blocked-wrong-subtype:${ct.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${v.toLowerCase().replace(/[^a-z0-9]+/g, '-')};`;

test('the wrong-sub-type note is posted ONCE per value; a DIFFERENT wrong value gets its own', async () => {
  const same = await runDcs({ subType: 'Single Applicant', itemId: '9203', priorNotes: [`… <span style="display:none">${markerFor(CEC_EE, 'Single Applicant')}</span>`] });
  assert.equal(same.notes.length, 0, 'same value → no repeat');
  const other = await runDcs({ subType: 'Extension - Single Applicant', itemId: '9204', priorNotes: [`… ${markerFor(CEC_EE, 'Single Applicant')}`] });
  assert.equal(other.notes.length, 1, 'a new wrong value → a new note');
  assert.match(other.notes[0], /“Extension - Single Applicant”/);
});

test('a value whose slug is a PREFIX of an already-noted one still gets its own note ("CEC" after "CEC Single Applicant")', async () => {
  const calls = await runDcs({ subType: 'CEC', itemId: '9210', priorNotes: [`… ${markerFor(CEC_EE, 'CEC Single Applicant')}`] });
  assert.equal(calls.notes.length, 1);
  assert.match(calls.notes[0], /“CEC” is not a Sub Type/);
});

test('switching A → B → A notes again — only the NEWEST wrong-sub-type note counts', async () => {
  const newestFirst = [`note B ${markerFor(CEC_EE, 'Extension - Single Applicant')}`, `note A ${markerFor(CEC_EE, 'Single Applicant')}`];
  const calls = await runDcs({ subType: 'Single Applicant', itemId: '9211', priorNotes: newestFirst });
  assert.equal(calls.notes.length, 1, 'the column is A again, the latest note names B — staff get a note for A');
});

test('the same wrong label on a DIFFERENT case type is a different mistake — its own note', async () => {
  const calls = await runDcs({ caseType: 'AAIP', subType: 'Single Applicant', itemId: '9212', priorNotes: [`… ${markerFor(CEC_EE, 'Single Applicant')}`] });
  assert.equal(calls.notes.length, 1);
});

test('the note shows TODAY\'s options (config), not retired registry variants — the decision still uses both', async () => {
  const { SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  const shown = displayedSubTypeLabels('OINP', knownSubTypeLabels('OINP'));
  assert.deepEqual(shown, [...new Set(SUB_TYPES_BY_CASE.OINP)].sort((a, b) => a.localeCompare(b)));
  assert.ok(!shown.some((l) => /masters graduate stream/i.test(l)), 'a retired stream is not offered');
  assert.equal((await checkSubTypeKnown('OINP', knownSubTypeLabels('OINP').find((l) => /masters graduate stream/i.test(l)))).known, true, '…but a case already on it is not blocked');
});

test('two Sub Types selected at once: the note says choose exactly one', async () => {
  const calls = await runDcs({ subType: 'CEC Single Applicant, CEC Accompanying Spouse & Child', itemId: '9205' });
  assert.equal(calls.creates, 0);
  assert.equal(calls.notes.length, 1);
  assert.match(calls.notes[0], /More than one Sub Type is selected/);
});

test('a CORRECT Sub Type passes the gate — no wrong-sub-type note', async () => {
  const calls = await runDcs({ subType: 'CEC Single Applicant', itemId: '9206' }, async () => []);
  assert.ok(!calls.notes.some((n) => /doesn't match this case type/.test(n)), 'the gate stays silent');
});

test('the BLANK sub-type path is unchanged — still the "Sub Type required" note, never the wrong-value one', async () => {
  const calls = await runDcs({ subType: '', itemId: '9207' });
  assert.equal(calls.notes.length, 1);
  assert.match(calls.notes[0], /Case Sub Type required/i);
  assert.ok(!/doesn't match this case type/.test(calls.notes[0]));
});

test('an already-applied checklist short-circuits before the gate (a wrong label on a seeded case is not re-flagged)', async () => {
  const calls = await runDcs({ subType: 'Single Applicant', checklistApplied: 'Yes', itemId: '9208' });
  assert.equal(calls.notes.length, 0);
  assert.equal(calls.creates, 0);
});
