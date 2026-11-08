'use strict';

/**
 * The Client Master page's view tabs: an exact copy of four Monday views on the
 * Client Master board, kept as DATA (operator, column_id, compare_value exactly
 * as Monday stores them — read 2026-11-08, API-Version 2026-01, and pinned by
 * test/fixtures/client-master-views-2026-11-08.json).
 *
 * How Monday's filters work (checked against Monday's own engine on all 718 rows):
 *   - a status cell's value is its label INDEX; an empty cell counts as index 5
 *     (an unused label slot on both Case Stage and Phase);
 *   - NOT_ANY_OF keeps a row unless its index is in the list, so an empty cell
 *     is kept unless 5 is listed;
 *   - a Group rule compares the row's group ID (as written; never by title, so
 *     do NOT use utils/caseGroups.isCaseGroup here);
 *   - a dropdown ANY_OF passes when any of the row's label ids is in the list;
 *   - every rule in a view is ANDed.
 *
 * The evaluator models ONLY that. Anything else in a definition (another
 * operator, OR, a compare_attribute, a user/team filter, an unknown group_by or
 * sort, an unknown column) THROWS when this module loads, so a test fails
 * rather than a tab going quietly wrong.
 *
 * A row with no groupId (a partial read) is left out of every view that has a
 * group rule (Assigning, EE after ITA): otherwise NOT_ANY_OF would let TEST or
 * Cancel rows through. The views without a group rule can still show it.
 *
 * Nothing here reads or writes Monday.
 */

const STAGE_COL = 'color_mm0x8faa';     // Case Stage
const PHASE_COL = 'color_mm3tf1ys';     // Phase
const TYPE_COL  = 'dropdown_mm0xd1qn';  // Primary Case Type
const EMPTY_INDEX = 5;                  // Monday: an empty status cell = index 5

// The columns a filter rule may name, and the parsed row field each reads.
const RULE_COLUMNS = {
  [STAGE_COL]: { kind: 'status',   field: 'stageIdx' },
  [PHASE_COL]: { kind: 'status',   field: 'phaseIdx' },
  [TYPE_COL]:  { kind: 'dropdown', field: 'caseTypeIds' },
  group:       { kind: 'group',    field: 'groupId' },
};
// The columns a view may group by, and the parsed row field that gives the heading key.
const GROUP_BY_COLUMNS = { [STAGE_COL]: 'stageIdx', [PHASE_COL]: 'phaseIdx' };
// The columns a view may sort by (plain YYYY-MM-DD dates on the row).
const SORT_COLUMNS = { date_mm33sj6t: 'actualDeadline', date_mm3t66pa: 'promisedDate' };

// ─── The four views, as Monday stores them (do not tidy them up) ─────────────
// groupOrder: how the group HEADINGS are ordered ('position' = the label order /
// board group order Monday shows; 'index'; 'alpha'). A one-line change if the
// by-eye check says Monday orders them differently.
const DEFINITIONS = [
  {
    key: 'assigning', label: 'Assigning', groupOrder: 'position',
    monday: {
      id: '260858028', name: 'Assigning',
      filter: { operator: 'AND', groups: [
        { operator: 'AND', rules: [{ column_id: STAGE_COL, compare_value: [6, 5, 8, 9, 10, 11, 13, 15, 17, 18], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
        // "topics" is no group on the board (has no effect); copied as Monday has it.
        { operator: 'AND', rules: [{ column_id: 'group', compare_value: ['group_mm2tz8e1', 'topics', 'group_mm3b9tap', 'group_mm3842s'], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
      ] },
      sort: [],
      settings: { group_by: { conditions: [{ columnId: STAGE_COL }] } },
      filter_user_id: null, filter_team_id: null,
    },
  },
  {
    key: 'deadlines', label: 'Deadlines', groupOrder: 'position',
    monday: {
      id: '260886949', name: 'Deadlines',
      filter: { operator: 'AND', groups: [
        { operator: 'AND', rules: [{ column_id: STAGE_COL, compare_value: [6, 9, 10, 13, 15, 17, 18, 16], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
        { operator: 'AND', rules: [{ column_id: PHASE_COL, compare_value: [5], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
      ] },
      sort: [],
      settings: { group_by: { conditions: [{ columnId: PHASE_COL, config: { sortSettings: { direction: 'ASC' } } }] } },
      filter_user_id: null, filter_team_id: null,
    },
  },
  {
    key: 'mahesh', label: 'Mahesh', groupOrder: 'position',
    monday: {
      id: '283824419', name: 'Mahesh',
      filter: { operator: 'AND', groups: [
        { operator: 'AND', rules: [{ column_id: STAGE_COL, compare_value: [6, 8, 9, 10, 13, 15, 17, 18], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
        { operator: 'AND', rules: [{ column_id: PHASE_COL, compare_value: [5], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
      ] },
      sort: [{ column_id: 'date_mm33sj6t', direction: 'ASC' }],
      settings: { group_by: { conditions: [{ columnId: PHASE_COL, config: { sortSettings: { direction: 'ASC' } } }] } },
      filter_user_id: null, filter_team_id: null,
    },
  },
  {
    key: 'eeita', label: 'EE after ITA', groupOrder: 'position',
    monday: {
      id: '287709906', name: 'EE after ITA',
      filter: { operator: 'AND', groups: [
        { operator: 'AND', rules: [{ column_id: STAGE_COL, compare_value: [6, 8, 9, 10, 11, 13, 15, 17, 18], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
        { operator: 'AND', rules: [{ column_id: 'group', compare_value: ['group_mm2tz8e1', 'group_mm3b9tap', 'group_mm3842s'], compare_attribute: '', operator: 'NOT_ANY_OF' }] },
        { operator: 'AND', rules: [{ column_id: TYPE_COL, compare_value: [6], compare_attribute: '', operator: 'ANY_OF' }] },
      ] },
      sort: [],
      settings: {},           // no group_by: Monday groups by board group
      filter_user_id: null, filter_team_id: null,
    },
  },
];

const GROUP_ORDER_MODES = ['position', 'index', 'alpha'];

function fail(view, msg) { throw new Error(`clientMasterViews: view "${view}" ${msg} — not modelled; check the Monday view and this module`); }

function compileRule(view, r) {
  if (!r || typeof r !== 'object') fail(view, 'has a rule that is not an object');
  const col = RULE_COLUMNS[r.column_id];
  if (!col) fail(view, `filters on column ${r.column_id}`);
  if (r.compare_attribute !== '') fail(view, `uses compare_attribute ${JSON.stringify(r.compare_attribute)}`);
  const op = r.operator;
  if (op !== 'ANY_OF' && op !== 'NOT_ANY_OF') fail(view, `uses operator ${op}`);
  const list = r.compare_value;
  if (!Array.isArray(list) || !list.length) fail(view, 'has an empty or non-list compare_value');
  const wantString = col.kind === 'group';
  for (const v of list) {
    if (wantString ? typeof v !== 'string' : !Number.isInteger(v)) fail(view, `compares ${r.column_id} with ${JSON.stringify(v)}`);
  }
  const set = new Set(list);
  const field = col.field;
  let valuesOf;
  if (col.kind === 'status') valuesOf = (row) => [Number.isInteger(row[field]) ? row[field] : EMPTY_INDEX];
  else if (col.kind === 'dropdown') valuesOf = (row) => (Array.isArray(row[field]) ? row[field] : []);
  else valuesOf = (row) => (row[field] ? [String(row[field])] : null);   // group: missing = unknown
  return (row) => {
    const vals = valuesOf(row);
    if (vals === null) return false;          // no group id: out of every view with a group rule
    const hit = vals.some((v) => set.has(v));
    return op === 'ANY_OF' ? hit : !hit;
  };
}

function compileGroupBy(view, settings) {
  if (!settings || typeof settings !== 'object') fail(view, 'has no settings object');
  const extra = Object.keys(settings).filter((k) => k !== 'group_by');
  if (extra.length) fail(view, `has settings ${extra.join(', ')} (copy only filter, sort and group_by)`);
  const gb = settings.group_by;
  if (gb === undefined) return { kind: 'board', field: 'groupId', direction: 'ASC' };
  if (!gb || typeof gb !== 'object' || Object.keys(gb).some((k) => k !== 'conditions')) fail(view, `has group_by ${JSON.stringify(gb)}`);
  const conds = gb.conditions;
  if (!Array.isArray(conds) || conds.length !== 1) fail(view, 'groups by more or less than one column');
  const c = conds[0];
  if (!c || Object.keys(c).some((k) => k !== 'columnId' && k !== 'config')) fail(view, `has group_by condition ${JSON.stringify(c)}`);
  const field = GROUP_BY_COLUMNS[c.columnId];
  if (!field) fail(view, `groups by column ${c.columnId}`);
  let direction = 'ASC';
  if (c.config !== undefined) {
    const cfg = c.config;
    const okShape = cfg && typeof cfg === 'object' && Object.keys(cfg).length === 1 && cfg.sortSettings
      && typeof cfg.sortSettings === 'object' && Object.keys(cfg.sortSettings).length === 1;
    if (!okShape || (cfg.sortSettings.direction !== 'ASC' && cfg.sortSettings.direction !== 'DESC')) fail(view, `has group_by config ${JSON.stringify(cfg)}`);
    direction = cfg.sortSettings.direction;
  }
  return { kind: 'status', columnId: c.columnId, field, direction };
}

function compileSort(view, sort) {
  if (!Array.isArray(sort)) fail(view, 'has a sort that is not a list');
  if (sort.length > 1) fail(view, 'sorts by more than one column');
  return sort.map((s) => {
    if (!s || Object.keys(s).some((k) => k !== 'column_id' && k !== 'direction')) fail(view, `has sort ${JSON.stringify(s)}`);
    const field = SORT_COLUMNS[s.column_id];
    if (!field) fail(view, `sorts by column ${s.column_id}`);
    if (s.direction !== 'ASC' && s.direction !== 'DESC') fail(view, `sorts ${s.direction}`);
    return { columnId: s.column_id, field, direction: s.direction };
  });
}

/** Turn one definition into { key, label, test(row), groupBy, sort, groupOrder, monday }; throws on anything not modelled. */
function compileView(def) {
  const view = (def && def.key) || '?';
  if (!def || typeof def.key !== 'string' || !/^[a-z]+$/.test(def.key)) fail(view, 'has no plain key');
  if (!GROUP_ORDER_MODES.includes(def.groupOrder)) fail(view, `has groupOrder ${def.groupOrder}`);
  const m = def.monday;
  if (!m || !m.filter) fail(view, 'has no Monday filter');
  if (m.filter_user_id !== null) fail(view, `is filtered to user ${m.filter_user_id}`);
  if (m.filter_team_id !== null) fail(view, `is filtered to team ${m.filter_team_id}`);
  if (m.filter.operator !== 'AND') fail(view, `joins its rule groups with ${m.filter.operator}`);
  if (!Array.isArray(m.filter.groups) || !m.filter.groups.length) fail(view, 'has no rule groups');
  if (Object.keys(m.filter).some((k) => k !== 'operator' && k !== 'groups')) fail(view, 'has filter keys beyond operator and groups');
  const rules = [];
  for (const g of m.filter.groups) {
    if (!g || g.operator !== 'AND') fail(view, `joins rules inside a group with ${g && g.operator}`);
    if (Object.keys(g).some((k) => k !== 'operator' && k !== 'rules')) fail(view, 'has a rule group with keys beyond operator and rules');
    if (!Array.isArray(g.rules) || !g.rules.length) fail(view, 'has an empty rule group');
    for (const r of g.rules) rules.push(compileRule(view, r));
  }
  return {
    key: def.key,
    label: def.label,
    mondayViewId: m.id,
    monday: m,
    groupOrder: def.groupOrder,
    groupBy: compileGroupBy(view, m.settings),
    sort: compileSort(view, m.sort),
    test: (row) => !!row && rules.every((ok) => ok(row)),
  };
}

const VIEWS = DEFINITIONS.map(compileView);          // throws at load on anything not modelled
const VIEW_KEYS = VIEWS.map((v) => v.key);
const VIEW_LABELS = Object.fromEntries(VIEWS.map((v) => [v.key, v.label]));
const BY_KEY = Object.fromEntries(VIEWS.map((v) => [v.key, v]));
if (new Set(VIEW_KEYS).size !== VIEW_KEYS.length) throw new Error('clientMasterViews: duplicate view key');

/** The keys of every view a parsed Client Master row belongs to, in tab order. */
function viewsOf(row) {
  const out = [];
  for (const v of VIEWS) if (v.test(row)) out.push(v.key);
  return out;
}

/** Status cell → its label index (Monday's model: blank / unreadable / no index = 5). */
function statusIndex(rawValue) {
  if (!rawValue) return EMPTY_INDEX;
  try {
    const j = JSON.parse(rawValue);
    const n = j && j.index != null ? Number(j.index) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : EMPTY_INDEX;
  } catch (_) { return EMPTY_INDEX; }
}

/** Dropdown cell → its label ids (numbers); blank / unreadable = []. */
function dropdownIds(rawValue) {
  if (!rawValue) return [];
  try {
    const ids = (JSON.parse(rawValue) || {}).ids;
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
  } catch (_) { return []; }
}

// The tab tooltips: each says the Monday view's filter in plain words.
const HINTS = {
  assigning: "Like Monday's Assigning view: open stages (not Application Submitted, Cancelled, Profile Created/Linked/Reviewed/Updated, Task Done, Ads posted, LMIA Submitted or empty), not in Leads, Cancel or TEST. Grouped by Case Stage.",
  deadlines: "Like Monday's Deadlines view: Phase filled in, and the stage is not Application Submitted, ADR, Profile Created/Linked/Reviewed/Updated, Task Done or LMIA Submitted. So Cancelled, Ads posted and no-stage cases with a Phase show too, and so do rows in the Leads, Cancel or TEST groups, as on Monday. Grouped by Phase.",
  mahesh: "Like Monday's Mahesh view: Phase filled in, and the stage is not Application Submitted, Cancelled, Profile Created/Linked/Reviewed/Updated, Task Done or LMIA Submitted. So ADR, Ads posted and no-stage cases with a Phase show too, and so do rows in the Leads, Cancel or TEST groups, as on Monday. Grouped by Phase, soonest Actual Deadline first (no date last).",
  eeita: "Like Monday's EE after ITA view: case type Canadian Experience Class (EE after ITA), open stages (not Application Submitted, Cancelled, Profile Created/Linked/Reviewed/Updated, Task Done, Ads posted or LMIA Submitted), not in Leads, Cancel or TEST. Grouped by board group.",
};
const PRE_ONBOARDING_INDEX = 12;   // Case Stage "Pre-Onboarding" (label ids read 2026-11-08)
// What the page adds above / inside each tab (display only): Assigning the stage counts and the no-officer line;
// Deadlines and Mahesh the half-month windows, the Real / Imaginary counts on each Phase heading and the two flags.
const PAGE_EXTRAS = { assigning: { stageStrip: true }, deadlines: { deadlineBox: true }, mahesh: { deadlineBox: true } };

/**
 * What the page needs to draw the tabs (plain data, JSON for the page script):
 * per view its key, label, tooltip, what it groups by ('stage' | 'phase' | 'board'),
 * the heading order mode + direction, and its sort (Mahesh: Actual Deadline).
 */
function pageViews() {
  const BY = { stageIdx: 'stage', phaseIdx: 'phase', groupId: 'board' };
  return VIEWS.map((v) => ({
    key: v.key, label: v.label, hint: HINTS[v.key] || '', mondayViewId: v.mondayViewId,
    by: BY[v.groupBy.field], dir: v.groupBy.direction, groupOrder: v.groupOrder,
    sort: v.sort.length ? { field: v.sort[0].field, dir: v.sort[0].direction } : null,
    stageStrip: !!(PAGE_EXTRAS[v.key] && PAGE_EXTRAS[v.key].stageStrip),
    deadlineBox: !!(PAGE_EXTRAS[v.key] && PAGE_EXTRAS[v.key].deadlineBox),
  }));
}

module.exports = {
  VIEWS, VIEW_KEYS, VIEW_LABELS, EMPTY_INDEX, STAGE_COL, PHASE_COL, TYPE_COL, PRE_ONBOARDING_INDEX, pageViews,
  view: (key) => BY_KEY[key] || null,
  viewsOf, statusIndex, dropdownIds, compileView,
  _DEFINITIONS: DEFINITIONS,
};
