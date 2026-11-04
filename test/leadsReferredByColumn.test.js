'use strict';

// Leads list — "Referred By" next to "Source / Reference" (Faran 2026-11-04:
// "these new items should be included in the leads listing table as well side
// by side. Source column can be Source/Reference and next to it a new column
// Referred By to show employee or client name").

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const snap = require('../src/services/leadSnapshot');
const portal = require('../src/services/consultantPortalService');
const mondayApi = require('../src/services/mondayApi');
const C = require('../src/data/newLeadsBoard.json').columns;
const { leadsTableCore, leadsTableScript, LEADS_TABLE_CSS } = require('../src/routes/leadsTableFilters');
const LT = leadsTableCore();
const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('the list snapshot reads the Referred By column, and each Leads row carries it (spaces tidied)', async () => {
  snap._reset();
  assert.ok(snap.SNAPSHOT_KEYS.includes('referredBy') && snap.SNAPSHOT_IDS.includes(C.referredBy), 'the lists read Referred By');
  assert.equal(C.referredBy, 'text_mm47dtvq', 'the Monday "Referred By" text column');
  const calls = [];
  const item = (id, ref) => ({ id: String(id), name: `N${id}`, created_at: `2026-11-0${id}T12:00:00Z`, column_values: [
    { id: C.bookingStatus, text: 'Not Yet', value: '{"index":0}' },
    { id: C.sourceChannel, text: 'Employee Referral', value: null },
    ...(ref == null ? [] : [{ id: C.referredBy, text: ref, value: JSON.stringify(ref) }]),
  ] });
  const restore = [stub(mondayApi, 'query', async (q, v) => {
    calls.push({ q, v });
    return { boards: [{ items_page: { cursor: null, items: [item(1, '  Gauri   Berde '), item(2, ''), item(3, null)] } }] };
  })];
  try {
    portal.invalidateLeadsQueue();
    const rows = await portal.getLeadsQueue();
    assert.ok(calls[0].q.includes(`"${C.referredBy}"`), 'the board read asks for Referred By');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId['1'].referredBy, 'Gauri Berde');
    assert.equal(byId['2'].referredBy, '');
    assert.equal(byId['3'].referredBy, '', 'an empty cell is an empty string, never undefined');
    assert.equal(byId['1'].source, 'Employee Referral');
  } finally { restore.forEach((r) => r()); snap._reset(); portal.invalidateLeadsQueue(); }
});

const ROWS = [
  { id: 'a', name: 'Asha', source: 'Employee Referral', referredBy: 'Gauri Berde', owner: 'Gauri', status: {} },
  { id: 'b', name: 'Bo', source: 'Existing Client', referredBy: 'Raj Patel', owner: '', status: {} },
  { id: 'c', name: 'Cy', source: 'Website', referredBy: '', owner: '', status: {} },
  { id: 'd', name: 'Di', source: 'Employee Referral', referredBy: 'Gauri Berde', owner: 'Melanie', status: {} },
  { id: 'e', name: 'Ed', source: 'Phone', status: {} },
];
const st = (o = {}) => Object.assign(LT.emptyState(), o);
const ids = (rows) => rows.map((r) => r.id);

test('Referred By has its own header filter: tick names (counts), "Not set", a chip, kept across visits', () => {
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { referredBy: ['Gauri Berde'] } }))), ['a', 'd']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { referredBy: [LT.NONE] } }))), ['c', 'e'], 'blank or missing = Not set');
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { referredBy: ['Raj Patel'], source: ['Existing Client'] } }))), ['b']);
  assert.deepEqual(LT.facetCounts(ROWS, st(), 'referredBy').map((o) => [o.label, o.count]), [['Gauri Berde', 2], ['Raj Patel', 1], ['Not set', 2]]);
  assert.deepEqual(LT.facetCounts(ROWS, st({ sel: { source: ['Employee Referral'] } }), 'referredBy').map((o) => [o.label, o.count]), [['Gauri Berde', 2]], 'counted with the other filters applied');
  assert.deepEqual(LT.chips(st({ sel: { referredBy: ['Raj Patel', LT.NONE] } })).map((c) => c.text), ['Referred By: Raj Patel, Not set']);
  assert.deepEqual(LT.normalizeState({ sel: { referredBy: ['Raj Patel'] } }).sel, { referredBy: ['Raj Patel'] }, 'remembered while the tab is open');
  assert.equal(LT.FACETS.source.label, 'Source / Reference');
});

test('the header: "Source / Reference" then "Referred By", side by side; the table is wide enough and scrolls sideways on small screens', () => {
  const src = leadsTableScript();
  new vm.Script(src);
  const cols = [...src.matchAll(/\{ id: '([a-z]+)', label: '([^']*)'/g)].map((m) => [m[1], m[2]]);
  const at = cols.findIndex((c) => c[0] === 'source');
  assert.deepEqual(cols.slice(at, at + 3), [['source', 'Source / Reference'], ['referred', 'Referred By'], ['received', 'Received']]);
  assert.match(src, /id: 'referred', label: 'Referred By', title: '[^']+', menu: 'facet', facets: \['referredBy'\]/);
  assert.match(LEADS_TABLE_CSS, /\.tbl-wrap \{ overflow-x:auto; \}/);
  assert.match(LEADS_TABLE_CSS, /\.tbl-wrap table \{ min-width:1100px; \}/);
  assert.match(LEADS_TABLE_CSS, /td\.ref-by \{ max-width:200px; overflow-wrap:anywhere; \}/, 'a long typed name wraps instead of stretching the table');
});

/** Run the page's own row code (escHtml … renderRows) against a tiny fake page. */
function renderWith(rows) {
  const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).find((s) => s.includes('function renderRows('));
  const body = { innerHTML: '' };
  const sandbox = {
    TDOT_DEL_SVG: '<svg></svg>', ALLROWS: rows,
    document: { getElementById: () => body, querySelectorAll: () => [] },
    window: { location: {} },
  };
  vm.createContext(sandbox);
  const escLine = script.match(/function escHtml\(s\)\{[^\n]*\n/)[0];
  vm.runInContext(escLine + ['qpill', 'statusPill', 'createdOf', 'stDay', 'statusCell', 'invitePill', 'renderRows'].map((n) => {
    const one = script.match(new RegExp(`function ${n}\\([^\\n]*\\n(?:(?!function )[^\\n]*\\n)*`));
    assert.ok(one, `found ${n}`); return one[0];
  }).join('') + '\nrenderRows(ALLROWS);', sandbox);
  return body.innerHTML;
}

test('each row: the Referred By cell sits right after Source / Reference; names are escaped; the owner is labelled so it is not read as the referrer', () => {
  const out = renderWith([
    { id: '1', name: 'Asha', source: 'Existing Client', referredBy: 'Raj <b>Patel</b>', owner: 'Gauri', status: {} },
    { id: '2', name: 'Bo', source: 'Website', referredBy: '', owner: '', status: {} },
  ]);
  const tds = (row) => row.split('<td').slice(1).map((t) => t.replace(/^[^>]*>/, '').replace(/<\/td>[\s\S]*$/, ''));
  const [r1, r2] = out.split('</tr>').filter((r) => r.includes('<tr'));
  const c1 = tds(r1), c2 = tds(r2);
  assert.equal(c1.length, 11);
  assert.match(c1[2], /^Existing Client<div class="muted" style="font-size:11.5px">Owner: Gauri<\/div>$/);
  assert.equal(c1[3], 'Raj &lt;b&gt;Patel&lt;/b&gt;', 'typed text never becomes HTML');
  assert.ok(r1.includes('<td class="ref-by">'));
  assert.equal(c2[2], 'Website', 'no owner: no Owner line');
  assert.equal(c2[3], '<span class="muted">—</span>', 'nothing referred: a dash');
  assert.match(renderWith([]), /<td colspan="11" class="empty">/, 'the empty message spans every column');
});
