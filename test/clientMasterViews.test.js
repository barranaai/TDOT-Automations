'use strict';
/**
 * Block 3 step 1: the Client Master view tabs' filters.
 *  1. the definitions equal the Monday views (fixture copied from views-raw.json, read 2026-11-08);
 *     every compare value names a real label / group; anything not modelled throws;
 *  2. one synthetic row per rule edge, through the real parseItem;
 *  3. a real, anonymised capture: the app's views give the SAME row sets as Monday's own engine,
 *     and the Mahesh order equals Monday's (ties on equal dates allowed).
 * No network: nothing here calls Monday.
 */
const test   = require('node:test');
const assert = require('node:assert/strict');

const cmv  = require('../src/services/clientMasterViews');
const dash = require('../src/services/dashboardService');
const VIEWS_FIXTURE = require('./fixtures/client-master-views-2026-11-08.json');
const META          = require('./fixtures/client-master-board-meta.json');
const CAPTURE       = require('./fixtures/client-master-capture.json');

const STAGE = 'color_mm0x8faa', PHASE = 'color_mm3tf1ys', TYPE = 'dropdown_mm0xd1qn';
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ── 1. definitions ── */

test('the four tab definitions equal the Monday views exactly (filter, sort, group_by, user/team filter)', () => {
  assert.deepEqual(cmv.VIEW_KEYS, ['assigning', 'deadlines', 'mahesh', 'eeita']);
  assert.deepEqual(cmv.VIEW_LABELS, { assigning: 'Assigning', deadlines: 'Deadlines', mahesh: 'Mahesh', eeita: 'EE after ITA' });
  assert.deepEqual(Object.keys(VIEWS_FIXTURE).sort(), ['260858028', '260886949', '283824419', '287709906']);
  const byId = Object.fromEntries(cmv.VIEWS.map((v) => [v.mondayViewId, v]));
  for (const [id, want] of Object.entries(VIEWS_FIXTURE)) {
    assert.ok(byId[id], `view ${id} (${want.name}) is a tab`);
    const { id: _id, ...got } = byId[id].monday;
    assert.deepEqual(got, want, `${want.name}: the copy is Monday's definition verbatim`);
  }
  assert.equal(cmv.view('assigning').mondayViewId, '260858028');
  assert.equal(cmv.view('deadlines').mondayViewId, '260886949');
  assert.equal(cmv.view('mahesh').mondayViewId, '283824419');
  assert.equal(cmv.view('eeita').mondayViewId, '287709906', 'the TABLE view, not the broadcast copy 287710509');
  assert.equal(cmv.view('nope'), null);
});

test('the compiled shape: grouping and sort per view', () => {
  assert.deepEqual(cmv.view('assigning').groupBy, { kind: 'status', columnId: STAGE, field: 'stageIdx', direction: 'ASC' }, 'no config = ascending');
  assert.deepEqual(cmv.view('deadlines').groupBy, { kind: 'status', columnId: PHASE, field: 'phaseIdx', direction: 'ASC' });
  assert.deepEqual(cmv.view('mahesh').groupBy, { kind: 'status', columnId: PHASE, field: 'phaseIdx', direction: 'ASC' });
  assert.deepEqual(cmv.view('eeita').groupBy, { kind: 'board', field: 'groupId', direction: 'ASC' }, 'no group_by: board groups');
  assert.deepEqual(cmv.view('mahesh').sort, [{ columnId: 'date_mm33sj6t', field: 'actualDeadline', direction: 'ASC' }]);
  for (const k of ['assigning', 'deadlines', 'eeita']) assert.deepEqual(cmv.view(k).sort, [], `${k}: board order`);
  for (const v of cmv.VIEWS) assert.equal(v.groupOrder, 'position', 'the default heading order (one-line change after the eye check)');
});

test('every compare value names a real label or group (the documented "topics" on Assigning excepted)', () => {
  const statusLabels = (col) => Object.keys(META.columns[col].settings.labels).map(Number);
  const dropIds = META.columns[TYPE].settings.labels.map((l) => l.id);
  const groupIds = META.groups.map((g) => g.id);
  const unknownGroups = [];
  for (const v of cmv.VIEWS) {
    for (const g of v.monday.filter.groups) for (const r of g.rules) {
      for (const x of r.compare_value) {
        if (r.column_id === 'group') { if (!groupIds.includes(x)) unknownGroups.push(v.key + ':' + x); continue; }
        if (r.column_id === TYPE) { assert.ok(dropIds.includes(x), `${v.key}: Primary Case Type id ${x} exists`); continue; }
        assert.ok(x === cmv.EMPTY_INDEX || statusLabels(r.column_id).includes(x), `${v.key}: ${r.column_id} index ${x} is a label (or 5 = empty)`);
        if (x === cmv.EMPTY_INDEX) assert.ok(!statusLabels(r.column_id).includes(5), 'index 5 is the empty slot (no label there)');
      }
    }
  }
  assert.deepEqual(unknownGroups, ['assigning:topics'], 'only the documented "topics", which matches no group');
  assert.equal(META.columns[TYPE].settings.labels.find((l) => l.id === 6).name, 'Canadian Experience Class (EE after ITA)');
});

test('anything the evaluator does not model throws (so a test fails rather than a tab going quietly wrong)', () => {
  const base = () => clone(cmv._DEFINITIONS.find((d) => d.key === 'eeita'));
  assert.doesNotThrow(() => cmv.compileView(base()));
  const bad = (label, mutate, re) => { const d = base(); mutate(d); assert.throws(() => cmv.compileView(d), re || /not modelled/, label); };
  bad('unknown operator', (d) => { d.monday.filter.groups[0].rules[0].operator = 'IS_EMPTY'; }, /operator IS_EMPTY/);
  bad('lower-case operator', (d) => { d.monday.filter.groups[0].rules[0].operator = 'any_of'; });
  bad('OR at the top', (d) => { d.monday.filter.operator = 'OR'; }, /with OR/);
  bad('OR in a group', (d) => { d.monday.filter.groups[1].operator = 'OR'; }, /with OR/);
  bad('compare_attribute', (d) => { d.monday.filter.groups[0].rules[0].compare_attribute = 'text'; }, /compare_attribute/);
  bad('compare_attribute missing', (d) => { delete d.monday.filter.groups[0].rules[0].compare_attribute; }, /compare_attribute/);
  bad('a user filter', (d) => { d.monday.filter_user_id = 123; }, /user/);
  bad('a team filter', (d) => { d.monday.filter_team_id = 9; }, /team/);
  bad('an unknown column', (d) => { d.monday.filter.groups[0].rules[0].column_id = 'color_mm0xf5ry'; }, /column color_mm0xf5ry/);
  bad('a text compare on a status', (d) => { d.monday.filter.groups[0].rules[0].compare_value = ['Cancelled']; });
  bad('an empty list', (d) => { d.monday.filter.groups[0].rules[0].compare_value = []; });
  bad('a group_by on another column', (d) => { d.monday.settings.group_by = { conditions: [{ columnId: 'color_mm0xf5ry' }] }; });
  bad('a two-level group_by', (d) => { d.monday.settings.group_by = { conditions: [{ columnId: STAGE }, { columnId: PHASE }] }; });
  bad('a group_by config we do not know', (d) => { d.monday.settings.group_by = { conditions: [{ columnId: PHASE, config: { sortSettings: { direction: 'ASC' }, hideEmpty: true } }] }; });
  bad('a group_by direction we do not know', (d) => { d.monday.settings.group_by = { conditions: [{ columnId: PHASE, config: { sortSettings: { direction: 'BY_COUNT' } } }] }; });
  bad('a group_by with extra keys', (d) => { d.monday.settings.group_by = { conditions: [{ columnId: PHASE }], collapsed: true }; });
  bad('other settings copied in', (d) => { d.monday.settings.columns = {}; });
  bad('a sort on an unknown column', (d) => { d.monday.sort = [{ column_id: 'date_mm0x5pqd', direction: 'ASC' }]; }, /date_mm0x5pqd/);
  bad('a two-column sort', (d) => { d.monday.sort = [{ column_id: 'date_mm33sj6t', direction: 'ASC' }, { column_id: 'date_mm3t66pa', direction: 'ASC' }]; });
  bad('an unknown heading order', (d) => { d.groupOrder = 'count'; });
  // the accepted group_by forms
  for (const gb of [undefined, { conditions: [{ columnId: STAGE }] }, { conditions: [{ columnId: PHASE, config: { sortSettings: { direction: 'DESC' } } }] }]) {
    const d = base(); if (gb === undefined) delete d.monday.settings.group_by; else d.monday.settings.group_by = gb;
    assert.doesNotThrow(() => cmv.compileView(d));
  }
  assert.equal(cmv.compileView((() => { const d = base(); d.monday.settings.group_by = { conditions: [{ columnId: PHASE, config: { sortSettings: { direction: 'DESC' } } }] }; return d; })()).groupBy.direction, 'DESC');
});

/* ── 2. one synthetic row per rule edge, through the real parseItem ── */

const G = { oct: 'group_mm7qvmt1', leads: 'group_mm2tz8e1', cancel: 'group_mm3b9tap', test: 'group_mm3842s', pending: 'group_mm6a68f5' };
let nextId = 1;
function rawItem({ stage, phase, types, group = G.oct, stageValue, phaseValue } = {}) {
  const cv = [];
  cv.push({ id: STAGE, text: '', value: stageValue !== undefined ? stageValue : (stage == null ? null : JSON.stringify({ index: stage })) });
  cv.push({ id: PHASE, text: '', value: phaseValue !== undefined ? phaseValue : (phase == null ? null : JSON.stringify({ index: phase })) });
  cv.push({ id: TYPE, text: '', value: types ? JSON.stringify({ ids: types }) : null });
  return { id: String(nextId++), name: 'X', created_at: '', group: group === null ? null : { id: group, title: 'T' }, column_values: cv };
}
const viewsOfRaw = (o) => dash.parseItem(rawItem(o), 0).views;

test('the rule edges, tab by tab', () => {
  // empty stage: kept by Deadlines / Mahesh / EE (5 not listed), dropped by Assigning (5 listed)
  assert.deepEqual(viewsOfRaw({ stage: null, phase: 6, types: [6] }), ['deadlines', 'mahesh', 'eeita']);
  // Cancelled: Deadlines yes, Mahesh no
  assert.deepEqual(viewsOfRaw({ stage: 8, phase: 6 }), ['deadlines']);
  // ADR: Mahesh yes, Deadlines no (and Assigning yes)
  assert.deepEqual(viewsOfRaw({ stage: 16, phase: 2 }), ['assigning', 'mahesh']);
  // Ads posted: Deadlines / Mahesh yes, Assigning / EE no
  assert.deepEqual(viewsOfRaw({ stage: 11, phase: 6, types: [6] }), ['deadlines', 'mahesh']);
  // a Cancel-group row with a Phase: Deadlines / Mahesh (no group rule), not Assigning / EE
  assert.deepEqual(viewsOfRaw({ stage: 1, phase: 6, types: [6], group: G.cancel }), ['deadlines', 'mahesh']);
  // Leads group, no phase: nowhere
  assert.deepEqual(viewsOfRaw({ stage: 1, group: G.leads, types: [6] }), []);
  // a TEST row without a Phase: none
  assert.deepEqual(viewsOfRaw({ stage: 1, group: G.test, types: [6] }), []);
  // Primary Case Type: any of the ids
  assert.deepEqual(viewsOfRaw({ stage: 1, types: [64, 6] }), ['assigning', 'eeita']);
  assert.deepEqual(viewsOfRaw({ stage: 1, types: [64] }), ['assigning']);
  assert.deepEqual(viewsOfRaw({ stage: 1 }), ['assigning'], 'no case type: not EE');
  // a "topics" group id (none exists): Assigning lists it, EE does not — harmless
  assert.deepEqual(viewsOfRaw({ stage: 1, types: [6], group: 'topics' }), ['eeita']);
  // a Pending-group case in Pre-Onboarding is on Assigning
  assert.deepEqual(viewsOfRaw({ stage: 12, group: G.pending }), ['assigning']);
  // Application Submitted with a phase: nowhere
  assert.deepEqual(viewsOfRaw({ stage: 6, phase: 6, types: [6] }), []);
  // Phase N/A (7) counts as filled
  assert.deepEqual(viewsOfRaw({ stage: 1, phase: 7 }), ['assigning', 'deadlines', 'mahesh']);
});

test('a row with no group id (a partial read) is out of Assigning and EE, and still on Deadlines / Mahesh when it has a Phase', () => {
  assert.deepEqual(viewsOfRaw({ stage: 1, phase: 6, types: [6], group: null }), ['deadlines', 'mahesh']);
  assert.deepEqual(viewsOfRaw({ stage: 1, types: [6], group: null }), []);
  const row = dash.parseItem(rawItem({ stage: 1, group: null }), 0);
  assert.equal(row.groupId, '');
  for (const k of ['assigning', 'eeita']) assert.equal(cmv.view(k).test({ ...row, groupId: undefined }), false);
});

test('raw cell edges through parseItem: null, {"index":5}, unreadable JSON, a deleted label', () => {
  const p = (o) => dash.parseItem(rawItem(o), 3);
  assert.equal(p({ stageValue: null }).stageIdx, 5, 'value null = empty = 5');
  assert.equal(p({ stageValue: '{"index":5}' }).stageIdx, 5);
  assert.equal(p({ stageValue: '{not json' }).stageIdx, 5, 'unreadable = empty');
  assert.equal(p({ stageValue: '{"post_id":null}' }).stageIdx, 5, 'no index = empty');
  assert.equal(p({ stageValue: '{"index":19}' }).stageIdx, 19, 'an index whose label was deleted keeps its number');
  assert.deepEqual(p({ stageValue: '{"index":19}' }).views, ['assigning'], 'and NOT_ANY_OF keeps it, as Monday does');
  assert.deepEqual(p({ stageValue: '{"index":5}', phase: 6 }).views, ['deadlines', 'mahesh']);
  assert.equal(p({ phaseValue: null }).phaseIdx, 5);
  assert.deepEqual(dash.parseItem({ id: '1', name: '', column_values: [{ id: TYPE, value: '{"ids":["6","64"]}', text: '' }] }).caseTypeIds, [6, 64], 'dropdown ids as numbers');
  assert.deepEqual(dash.parseItem({ id: '1', name: '', column_values: [{ id: TYPE, value: '{bad', text: '' }] }).caseTypeIds, []);
  assert.equal(p({}).boardIdx, 3);
  // a row object with no index field at all counts as empty (5), as Monday does
  assert.deepEqual(cmv.viewsOf({ groupId: G.oct, phaseIdx: 6 }), ['deadlines', 'mahesh'], 'no stageIdx = empty stage: off Assigning, on Deadlines / Mahesh');
  assert.deepEqual(cmv.viewsOf({ groupId: G.oct, stageIdx: 1 }), ['assigning'], 'no phaseIdx = empty Phase');
  assert.equal(dash.parseItem({ id: '1', name: '', column_values: [] }).boardIdx, null);
});

test('viewsOf: one row in three views at once, and in all four', () => {
  assert.deepEqual(cmv.viewsOf(dash.parseItem(rawItem({ stage: 1, phase: 6, types: [8] }), 0)), ['assigning', 'deadlines', 'mahesh']);
  assert.deepEqual(cmv.viewsOf(dash.parseItem(rawItem({ stage: 1, phase: 6, types: [6] }), 0)), ['assigning', 'deadlines', 'mahesh', 'eeita']);
  assert.deepEqual(cmv.viewsOf(null), []);
});

test('parseItem: the new row fields, and the old ones unchanged', () => {
  const item = {
    id: '42', name: ' A B ', created_at: '2026-10-01T00:00:00Z', group: { id: G.oct, title: 'October 2026' },
    column_values: [
      { id: STAGE, text: 'Internal Review', value: '{"index":1}' },
      { id: PHASE, text: 'Phase 11', value: '{"index":6}' },
      { id: 'color_mm6w7cdd', text: 'Imaginary', value: '{"index":0}' },
      { id: 'date_mm33sj6t', text: '2026-11-20', value: '{"date":"2026-11-20"}' },
      { id: 'date_mm3t66pa', text: '2026-11-18 10:00', value: '{"date":"2026-11-18","time":"10:00:00"}' },
      { id: 'dropdown_mm0xd1qn', text: 'Canadian Experience Class (EE after ITA)', value: '{"ids":[6]}' },
      { id: 'multiple_person_mm0xm710', text: 'Ann, Bo', value: '{"personsAndTeams":[{"id":11,"kind":"person"},{"id":12,"kind":"person"},{"id":7,"kind":"team"}]}' },
      { id: 'multiple_person_mm0xhmgk', text: 'Cy', value: '{"personsAndTeams":[{"id":13,"kind":"person"}]}' },
      { id: 'numeric_mm2njqk1', text: '30', value: '"30"' },
    ],
  };
  const r = dash.parseItem(item, 7);
  assert.equal(r.boardIdx, 7);
  assert.equal(r.groupId, G.oct); assert.equal(r.groupTitle, 'October 2026');
  assert.equal(r.stageIdx, 1); assert.equal(r.caseStage, 'Internal Review');
  assert.equal(r.phase, 'Phase 11'); assert.equal(r.phaseIdx, 6);
  assert.equal(r.deadlineType, 'Imaginary');
  assert.equal(r.actualDeadline, '2026-11-20');
  assert.equal(r.promisedDate, '2026-11-18', 'date only, never the time');
  assert.deepEqual(r.caseTypeIds, [6]);
  assert.equal(r.officer, 'Ann, Bo');
  assert.deepEqual(r.officerIds, { personIds: ['11', '12'], teamIds: ['7'] }, 'Case Support Officer only');
  assert.deepEqual(r.assignees.personIds.sort(), ['11', '12', '13'], 'RBAC still reads every people column');
  assert.equal(r.docUploadedPct, 30); assert.equal(r.docReadiness, 30, 'the old field is unchanged');
  assert.deepEqual(r.views, ['assigning', 'deadlines', 'mahesh', 'eeita']);
  // blanks: % blank is null (never 0), stage blank keeps the old 'Unknown' text
  const b = dash.parseItem({ id: '1', name: '', column_values: [{ id: 'numeric_mm2njqk1', text: '', value: null }] }, 0);
  assert.equal(b.docUploadedPct, null, 'a blank % is not 0');
  assert.equal(b.docReadiness, 0, 'the old field still reads 0');
  assert.equal(b.caseStage, 'Unknown'); assert.equal(b.caseType, 'Unknown');
  assert.equal(b.stageIdx, 5); assert.equal(b.phase, ''); assert.equal(b.actualDeadline, ''); assert.equal(b.officer, '');
  assert.deepEqual(b.officerIds, { personIds: [], teamIds: [] });
  assert.equal(dash.parseItem({ id: '1', name: '', column_values: [{ id: 'numeric_mm2njqk1', text: '0', value: '"0"' }] }, 0).docUploadedPct, 0, '0 % is known');
  // an empty status cell reads '' even when Monday puts an id-5 label in its text (the Lead Board trap, 2026-10-12)
  const e5 = dash.parseItem({ id: '1', name: '', column_values: [
    { id: PHASE, text: 'Some label', value: null }, { id: 'color_mm6w7cdd', text: 'Some label', value: null },
  ] }, 0);
  assert.equal(e5.phase, ''); assert.equal(e5.deadlineType, ''); assert.equal(e5.phaseIdx, 5);
  // the officer: one column only, de-duplicated, not tied to the RBAC column list
  const o = dash.parseItem({ id: '1', name: '', column_values: [{ id: 'multiple_person_mm0xm710', text: 'A', value: '{"personsAndTeams":[{"id":5,"kind":"person"},{"id":5,"kind":"person"},{"id":9,"kind":"team"},{"id":null}]}' }] }, 0);
  assert.deepEqual(o.officerIds, { personIds: ['5'], teamIds: ['9'] });
  const src = require('fs').readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.ok(!/officerIds = caseAccess\./.test(src), 'officerIds is parsed from its own column');
});

/* ── 3. against a real capture (Monday's own engine), not circular ── */

test('the capture is anonymised: only the filter / grouping / date / type / % / officer cells, officer ids only, no item ids', () => {
  const allowed = new Set([STAGE, PHASE, TYPE, 'date_mm33sj6t', 'date_mm3t66pa', 'color_mm6w7cdd', 'numeric_mm2njqk1', 'multiple_person_mm0xm710']);
  assert.ok(CAPTURE.rows.length > 500, 'a whole board');
  assert.equal(CAPTURE.viewsDriftFromViewsRaw, false, 'the views had not changed since views-raw.json');
  for (const r of CAPTURE.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['cells', 'groupId']);
    for (const c of r.cells) {
      assert.ok(allowed.has(c.id), c.id);
      if (c.id === 'multiple_person_mm0xm710') {
        assert.equal(c.text, '', 'no officer names');
        if (c.value) for (const p of JSON.parse(c.value).personsAndTeams) assert.deepEqual(Object.keys(p).sort(), ['id', 'kind']);
      }
    }
  }
  assert.ok(!/@|\b20\d\d-[A-Z]+-\d{3}\b/.test(JSON.stringify(CAPTURE.rows)), 'no emails or case references');
});

function captureRows() {
  const title = Object.fromEntries(META.groups.map((g) => [g.id, g.title]));
  return CAPTURE.rows.map((r, i) => dash.parseItem({
    id: String(i), name: '', created_at: '',
    group: r.groupId ? { id: r.groupId, title: title[r.groupId] || '' } : null,
    column_values: r.cells,
  }, i));
}

test('every tab holds EXACTLY the rows Monday\'s own engine returns for that view (id sets, captured at one moment)', () => {
  const rows = captureRows();
  for (const v of cmv.VIEWS) {
    const mine = rows.filter((r) => r.views.includes(v.key)).map((r) => r.boardIdx);
    const monday = CAPTURE.engine[v.mondayViewId];
    assert.ok(monday.length > 0, `${v.label}: Monday returned rows`);
    assert.deepEqual(mine, monday.slice().sort((a, b) => a - b), `${v.label}: same rows as Monday`);
  }
});

test('the Mahesh order equals Monday\'s engine order (Actual Deadline ascending, blanks last; ties on equal dates allowed)', () => {
  const rows = captureRows();
  const v = cmv.view('mahesh');
  const s = v.sort[0];
  assert.equal(s.field, 'actualDeadline');
  const mine = rows.filter((r) => r.views.includes('mahesh'))
    .sort((a, b) => {
      const x = a[s.field], y = b[s.field];
      if (!x !== !y) return x ? -1 : 1;                 // blanks last
      if (x !== y) return (x < y ? -1 : 1) * (s.direction === 'DESC' ? -1 : 1);
      return a.boardIdx - b.boardIdx;                   // ties: board order
    });
  const byIdx = new Map(rows.map((r) => [r.boardIdx, r]));
  const monday = CAPTURE.maheshEngineOrder.map((i) => byIdx.get(i));
  assert.equal(monday.length, mine.length);
  assert.deepEqual(monday.map((r) => r[s.field]), mine.map((r) => r[s.field]), 'the same date at every place');
  const dated = mine.filter((r) => r[s.field]).length;
  assert.ok(dated > 0 && dated < mine.length, 'the capture has both dated and blank rows');
  assert.ok(mine.slice(dated).every((r) => !r[s.field]), 'blanks are last');
  // inside one date, the same rows (any order)
  const sets = (list) => { const m = new Map(); for (const r of list) { const k = r[s.field]; if (!m.has(k)) m.set(k, []); m.get(k).push(r.boardIdx); } for (const a of m.values()) a.sort((p, q) => p - q); return m; };
  assert.deepEqual(sets(monday), sets(mine));
});
