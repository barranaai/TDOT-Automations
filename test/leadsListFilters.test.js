'use strict';

// Leads list — filters and sorting in the column headers (Faran 2026-10-28:
// "integrate the filters in the respective header of the column professionally
// and intelligently"; Current status is the last column). The pure part
// (leadsTableCore) runs here; the page wiring is checked on the emitted HTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const { leadsTableCore, leadsTableScript } = require('../src/routes/leadsTableFilters');
const LT = leadsTableCore();
const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();

const ROWS = [
  { id: '0', name: 'Asha Rao', createdAt: '2026-10-28T15:00:00Z', createdDay: '2026-10-28', service: 'Express Entry', source: 'Website', owner: 'Gauri', tier: 'Tier 1', priority: 'High', bookingStatus: 'Not Yet', inviteSent: true, urgent: true, status: { key: 'invite', label: 'Invite sent', at: 3 } },
  { id: '1', name: 'Bo Li', createdAt: '2026-10-27T15:00:00Z', createdDay: '2026-10-27', service: 'Study Permit', source: 'Phone', owner: '', tier: 'Tier 2', priority: 'Low', bookingStatus: 'Abandoned', inviteSent: false, status: { key: 'remark', label: 'No answer / voicemail', at: 9 } },
  { id: '2', name: 'Chen Wu', createdAt: '2026-10-27T10:00:00Z', createdDay: '2026-10-27', service: 'Express Entry', source: 'Website', owner: 'Melanie', tier: '', priority: 'Critical', bookingStatus: '', inviteSent: true, status: { key: 'remark', label: 'Remark: called', at: 5 } },
  { id: '3', name: 'Dev Patel', createdAt: '2026-10-25T10:00:00Z', createdDay: '2026-10-25', service: '', source: 'Instagram', owner: 'Gauri', tier: 'Tier 1', priority: 'Medium', bookingStatus: 'Slot Held', inviteSent: true, status: { key: 'expired', label: 'Expired', at: 1 } },
  { id: '4', name: 'Eli Stone', createdAt: '2026-10-01T10:00:00Z', createdDay: '2026-10-01', service: 'Visitor Visa', source: '', owner: '', tier: 'Tier 3', priority: '', bookingStatus: 'Not Yet', inviteSent: false, status: { key: 'outcome', label: 'Outcome: Follow-Up', at: 2 } },
  { id: '5', name: 'Fay Khan', createdAt: '2026-09-15T10:00:00Z', createdDay: '2026-09-15', service: 'Study Permit', source: 'Phone', owner: 'Gauri', tier: 'Tier 2', priority: 'High', bookingStatus: 'Not Yet', inviteSent: true, status: { key: 'reminder1', label: '1st reminder sent', at: 4 } },
  { id: '6', name: 'Gus Ola', createdAt: '', createdDay: '', service: 'Express Entry', source: 'Phone', owner: '', tier: 'Tier 1', priority: 'Low', bookingStatus: 'Not Yet', inviteSent: false, status: { key: 'new', label: 'New' } },
];
const st = (o = {}) => Object.assign(LT.emptyState(), o);
const ids = (rows) => rows.map((r) => r.id);

test('the page: filters live in the column headers; Current status is the LAST column (before the delete button); the old filter row is gone', () => {
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const x of ['<thead><tr id="q-headrow"></tr></thead>', 'id="q-search"', 'id="q-chips"', '<div id="q-pop" role="dialog"', 'window.LeadsTable.setRows(ALLROWS);', '<div class="tbl-wrap">']) assert.ok(html.includes(x), x);
  for (const old of ['id="f-from"', 'id="f-source"', 'id="f-owner"', 'id="f-cstatus"', 'id="f-month"', 'function applyFilters', 'class="q-filters"']) assert.ok(!html.includes(old), `gone: ${old}`);
  const cells = (html.match(/function renderRows[\s\S]*?\}\)\.join\(''\);/) || [''])[0].match(/'<td[^']*'/g);
  assert.equal(cells.length, 10);
  const row = (html.match(/function renderRows[\s\S]*?\}\)\.join\(''\);/) || [''])[0];
  assert.ok(row.indexOf("statusCell(c.status)") > row.indexOf('invitePill(c)') && row.indexOf("statusCell(c.status)") < row.indexOf('data-del-lead'), 'status after Invite, before the delete button');
  const src = leadsTableScript();
  const order = [...src.matchAll(/\{ id: '([a-z]+)', label:/g)].map((m) => m[1]);
  assert.deepEqual(order, ['lead', 'service', 'source', 'received', 'tier', 'priority', 'booking', 'invite', 'status', 'del'], 'headers in the same order as the cells');
  assert.ok(src.includes('aria-haspopup="dialog"') && src.includes("e.key === 'Escape'") && src.includes('aria-sort'), 'keyboard + screen reader');
  new vm.Script(src);
});

test('tick-box filters: OR inside a column, AND across columns; "none" choices; the owner sits under Source', () => {
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { service: ['Express Entry'] } }))), ['0', '2', '6']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { service: ['Express Entry', 'Study Permit'] } }))), ['0', '1', '2', '5', '6']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { service: ['Express Entry'], source: ['Phone'] } }))), ['6']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { owner: [LT.NONE] } }))), ['1', '4', '6']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { source: [LT.NONE] } }))), ['4']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { booking: ['Not Yet'] } }))), ['0', '2', '4', '5', '6'], 'an empty booking status reads Not Yet');
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { invite: ['Not sent'] } }))), ['1', '4', '6']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { status: ['remark'] } }))), ['1', '2'], 'every remark together');
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { status: ['outcome:Outcome: Follow-Up'] } }))), ['4'], 'each Outcome on its own');
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ sel: { priority: ['Critical', 'High'] }, urgent: true }))), ['0']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ q: 'chen' }))), ['2']);
});

test('the counts beside each choice say what you would get with the OTHER filters on; a ticked choice never disappears', () => {
  const src = LT.facetCounts(ROWS, st({ sel: { service: ['Express Entry'], source: ['Website'] } }), 'source');
  assert.deepEqual(src.map((o) => [o.label, o.count]), [['Phone', 1], ['Website', 2]], 'counted within Express Entry, ignoring the Source choice itself');
  const pr = LT.facetCounts(ROWS, st(), 'priority');
  assert.deepEqual(pr.map((o) => o.label), ['Critical', 'High', 'Medium', 'Low', 'No priority'], 'urgency order, "none" last');
  const stc = LT.facetCounts(ROWS, st(), 'status');
  assert.deepEqual(stc.map((o) => o.label), ['New', 'Invite sent', '1st reminder sent', 'A remark', 'Expired', 'Outcome: Follow-Up']);
  assert.deepEqual(stc.map((o) => o.value), ['new', 'invite', 'reminder1', 'remark', 'expired', 'outcome:Outcome: Follow-Up'], 'in the order a lead moves through them');
  const kept = LT.facetCounts(ROWS, st({ q: 'nobody', sel: { tier: ['Tier 3'] } }), 'tier');
  assert.deepEqual(kept.map((o) => [o.value, o.count]), [['Tier 3', 0]]);
});

test('Received: From / To both included, either way round, either end alone; the quick ranges are Toronto days', () => {
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ from: '2026-10-25', to: '2026-10-27' }))), ['1', '2', '3']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ from: '2026-10-27', to: '2026-10-25' }))), ['1', '2', '3']);
  assert.deepEqual(ids(LT.filterRows(ROWS, st({ to: '2026-10-01' }))), ['4', '5'], 'a lead with no day is left out');
  const now = Date.parse('2026-11-01T02:30:00Z');   // Oct 31, 22:30 in Toronto
  assert.deepEqual(LT.presetRange('today', now), { from: '2026-10-31', to: '2026-10-31' });
  assert.deepEqual(LT.presetRange('7d', now), { from: '2026-10-25', to: '2026-10-31' });
  assert.deepEqual(LT.presetRange('30d', now), { from: '2026-10-02', to: '2026-10-31' });
  assert.deepEqual(LT.presetRange('month', now), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(LT.presetRange('lastmonth', now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(LT.presetRange('lastmonth', Date.parse('2026-03-10T12:00:00Z')), { from: '2026-02-01', to: '2026-02-28' });
});

test('sorting: newest first by default; name, Received, status, priority, tier both ways; ties keep the server order', () => {
  assert.deepEqual(ids(LT.sortRows(ROWS, LT.emptyState().sort)), ['0', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'received', dir: 'asc' })), ['6', '5', '4', '3', '2', '1', '0']);
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'name', dir: 'asc' })), ['0', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'name', dir: 'desc' })), ['6', '5', '4', '3', '2', '1', '0']);
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'status', dir: 'desc' })), ['1', '2', '5', '0', '4', '3', '6']);
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'priority', dir: 'asc' })), ['2', '0', '5', '3', '1', '6', '4'], 'most urgent first, no priority last');
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'tier', dir: 'asc' })), ['0', '3', '6', '1', '5', '4', '2'], 'no tier last');
  assert.deepEqual(ids(LT.sortRows(ROWS, { key: 'nonsense', dir: 'asc' })), ['6', '5', '4', '3', '2', '1', '0'], 'unknown key → Received');
});

test('chips: one per active filter, readable; removing one clears only it; a saved state is cleaned', () => {
  const s1 = st({ q: 'asha', urgent: true, from: '2026-10-01', to: '2026-10-28', sel: { owner: [LT.NONE, 'Gauri'], status: ['remark', 'outcome:Outcome: Follow-Up'] } });
  assert.deepEqual(LT.chips(s1).map((c) => c.text), ['Name contains “asha”', 'Urgent only', 'Received Oct 1 – Oct 28', 'Owner: No owner, Gauri', 'Current status: A remark, Outcome: Follow-Up']);
  assert.equal(LT.chips(st({ from: '2026-10-05', to: '2026-10-05' }))[0].text, 'Received Oct 5');
  assert.equal(LT.chips(st({ to: '2026-10-05' }))[0].text, 'Received until Oct 5');
  LT.clearKey(s1, 'owner');
  assert.equal(s1.sel.owner, undefined); assert.deepEqual(s1.sel.status, ['remark', 'outcome:Outcome: Follow-Up']);
  LT.clearKey(s1, 'received'); assert.equal(s1.from + s1.to, '');
  const clean = LT.normalizeState({ q: 'x', urgent: 'yes', from: 'tomorrow', to: '2026-10-05', sel: { owner: ['Gauri', 7], hacker: ['x'] }, sort: { key: 'evil', dir: 'up' } });
  assert.deepEqual(clean, { q: 'x', urgent: false, from: '', to: '2026-10-05', sel: { owner: ['Gauri', '7'] }, sort: { key: 'received', dir: 'desc' } });
  assert.deepEqual(LT.normalizeState(null), LT.emptyState());
});
