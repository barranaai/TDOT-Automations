'use strict';

// An EMPTY Monday status cell reads '' (2026-10-12, Soniya: "Booked, but the
// Outcome still says Follow Up"). Monday shows a status column's id-5 label on
// every empty cell and the API returns it as `text` with `value: null`. On the
// Lead Board that label is "Follow-Up" (Outcome), "T4" (Tier) and "Retained —
// Awaiting Payment" (Conversion Status): 473 / 227 / 6 leads nobody decided on
// looked decided, and the "set the Outcome" reminder never fired.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { statusText } = require('../src/utils/mondayStatus');
const C = require('../src/data/newLeadsBoard.json').columns;

test('statusText: null value → empty; a stored value keeps its label; a query that never asked for value keeps today\'s text', () => {
  assert.equal(statusText({ text: 'Follow-Up', value: null }), '');
  assert.equal(statusText({ text: 'Follow-Up', value: '{"index":5,"post_id":null,"changed_at":"2026-10-02T15:00:00Z"}' }), 'Follow-Up', 'really set to Follow-Up');
  assert.equal(statusText({ text: 'Booked' }), 'Booked', 'value not requested → never blank a real status');
  assert.equal(statusText({ text: '', value: '{"index":5}' }), '', 'index pointing at no label');
  assert.equal(statusText(null), '');
  assert.equal(statusText(undefined), '');
});

test('parseItem: the three affected status columns read empty when the cell is empty — and only status cells change', () => {
  const { parseItem } = require('../src/services/leadService');
  const lead = parseItem({ id: '1', name: 'Ada', created_at: '2026-10-01T01:30:00Z', column_values: [
    { id: C.outcome, text: 'Follow-Up', value: null },
    { id: C.tier, text: 'T4', value: null },
    { id: C.conversionStatus, text: 'Retained — Awaiting Payment', value: null },
    { id: C.bookingStatus, text: 'Booked', value: '{"index":3}' },
    { id: C.preConsultSubmitted, text: 'Yes', value: '{"index":2}' },
    { id: C.email, text: 'ada@example.com', value: null },         // not a status column: unchanged
    { id: C.bookedSlot, text: '2026-10-02 10:00', value: null },
  ] });
  assert.deepEqual([lead.outcome, lead.tier, lead.conversionStatus], ['', '', '']);
  assert.deepEqual([lead.bookingStatus, lead.preConsultSubmitted], ['Booked', 'Yes']);
  assert.deepEqual([lead.email, lead.bookedSlot], ['ada@example.com', '2026-10-02 10:00']);
  const real = parseItem({ id: '2', name: 'Bo', column_values: [
    { id: C.outcome, text: 'Follow-Up', value: '{"index":5}' },
    { id: C.conversionStatus, text: 'Retained — Awaiting Payment', value: '{"index":5}' },
    { id: C.tier, text: 'T2', value: '{"index":3}' },
  ] });
  assert.deepEqual([real.outcome, real.conversionStatus, real.tier], ['Follow-Up', 'Retained — Awaiting Payment', 'T2'], 'real picks keep their labels');
  const noValue = parseItem({ id: '3', name: 'Cy', column_values: [{ id: C.outcome, text: 'Retain' }] });
  assert.equal(noValue.outcome, 'Retain');
});

test('every query that feeds parseItem asks Monday for value (else the rule could not tell empty from set)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/leadService'), 'utf8');
  const feeders = src.match(/column_values \{ id text value \}/g) || [];
  assert.ok(feeders.length >= 3, 'getLead, listAllLeads, findAllByColumnValue');
  assert.ok(!/column_values \{ id text \}/.test(src), 'no lead read without value');
});

test('Consultations queue: asks for value on both pages; an empty Outcome / Tier reads empty; a real Retain still counts', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const portal = require('../src/services/consultantPortalService');
  const orig = mondayApi.query; const queries = [];
  const row = (id, cells) => ({ id, name: 'Lead ' + id, column_values: cells });
  mondayApi.query = async (q) => {
    queries.push(q);
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { cursor: 'c1', items: [
      row('1', [{ id: C.outcome, text: 'Follow-Up', value: null }, { id: C.tier, text: 'T4', value: null }, { id: C.preConsultSubmitted, text: 'Yes', value: '{"index":2}' }, { id: C.bookedSlot, text: '2026-10-10 10:00', value: null }]),
      row('2', [{ id: C.outcome, text: 'Retain', value: '{"index":1}' }, { id: C.tier, text: 'T1', value: '{"index":2}' }, { id: C.bookedSlot, text: '2026-10-09 10:00', value: null }]),
    ] } };
    return { next_items_page: { cursor: null, items: [row('3', [{ id: C.outcome, text: 'Follow-Up', value: '{"index":5}' }, { id: C.bookedSlot, text: '2026-10-08 10:00', value: null }])] } };
  };
  try {
    const out = await portal.getConsultationQueue();
    const rows = Array.isArray(out) ? out : (out.items || out.rows || out.booked || []);
    const r = (id) => rows.find((x) => String(x.id) === id);
    assert.ok(r('1') && r('2') && r('3'), 'all three rows');
    assert.deepEqual([r('1').outcome, r('1').tier, r('1').preConsultSubmitted], ['', '', true]);
    assert.deepEqual([r('2').outcome, r('2').tier, r('2').retainerStatus], ['Retain', 'T1', 'Retain']);
    assert.equal(r('3').outcome, 'Follow-Up', 'a real Follow-Up stays');
    assert.equal(queries.filter((q) => /\{ id text value \}/.test(q)).length, 2, 'both the first page and the next page ask for value');
  } finally { mondayApi.query = orig; }
});

test('post-consultation reminder: an empty Outcome after a finished consultation gets ONE note; a real Follow-Up gets none', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const pc = require('../src/services/postConsultService');
  const two = new Date(Date.now() - 2 * 3600000);
  const slot = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(two).replace(',', '');   // 'YYYY-MM-DD HH:MM' Toronto, 2 h ago
  const orig = mondayApi.query; const writes = [];
  const item = (id, outcome) => ({ id, name: 'Lead ' + id, updates: [], column_values: [
    { id: C.bookedSlot, text: slot, value: null }, { id: C.outcome, ...outcome }, { id: C.fullName, text: 'Lead ' + id, value: null },
  ] });
  mondayApi.query = async (q, v) => {
    if (/create_update/.test(q)) { writes.push(v.i); return { create_update: { id: 'u' } }; }
    return { items_page_by_column_values: { items: [item('11', { text: 'Follow-Up', value: null }), item('12', { text: 'Follow-Up', value: '{"index":5}' }), item('13', { text: 'Retain', value: '{"index":1}' })] } };
  };
  const log = console.log; console.log = () => {};
  try {
    assert.match(slot, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const sent = await pc.sendPostConsultNudges();
    assert.equal(sent, 1);
    assert.deepEqual(writes, ['11'], 'only the lead whose Outcome is really empty');
  } finally { mondayApi.query = orig; console.log = log; }
});
