'use strict';

// Leads list: a "Received" date range filter (Faran 2026-10-28) — From / To on
// the day the lead arrived (Toronto), both days included, dates entered the
// wrong way round still work, combines with the other filters, "Clear dates".
// The page's own filter code runs here against a tiny fake page.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');

function page(rows) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, value: '', min: '', max: '', style: { display: '' }, textContent: '' });
  ['f-search', 'f-status', 'f-service', 'f-month', 'f-urgent', 'f-invite', 'f-from', 'f-to', 'f-dates-clear', 'q-count'].forEach(el);
  const pick = (name) => { const m = script.match(new RegExp(`function ${name}\\(([^)]*)\\)\\{[\\s\\S]*?\\n\\}\\n`)); assert.ok(m, name); return m[0]; };
  const one = (name) => { const m = script.match(new RegExp(`function ${name}\\([^)]*\\)\\{[^\\n]*\\}`)); assert.ok(m, name); return m[0]; };
  const shown = [];
  const ctx = { document: { getElementById: (id) => el(id) }, ALLROWS: rows, renderRows: (r) => { shown.length = 0; shown.push(...r); } };
  vm.createContext(ctx);
  vm.runInContext(`${one('createdOf')}\n${one('monthOf')}\n${pick('applyFilters')}`, ctx);
  return { el, run: () => { ctx.applyFilters(); return shown.map((r) => r.createdDay); }, count: () => el('q-count').textContent };
}

const ROWS = ['2026-10-28', '2026-10-27', '2026-10-27', '2026-10-25', '2026-10-20', '2026-10-01', '2026-09-30', '2026-09-15', '']
  .map((d, i) => ({ id: String(i), name: `Lead ${i}`, createdDay: d, bookingStatus: 'Not Yet' }));

test('the page has From / To date boxes and a Clear button next to the other filters', () => {
  for (const s of ['<input id="f-from" type="date">', '<input id="f-to" type="date">', 'id="f-dates-clear"', 'aria-label="Received between"']) assert.ok(html.includes(s), s);
  assert.ok(html.indexOf('id="f-month"') < html.indexOf('id="f-from"'), 'after the month filter');
  assert.ok(script.includes("document.getElementById('f-dates-clear').onclick="));
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
});

test('From and To filter by the day the lead arrived, both days included', () => {
  const p = page(ROWS);
  assert.equal(p.run().length, 9);
  p.el('f-from').value = '2026-10-20';
  assert.deepEqual(p.run(), ['2026-10-28', '2026-10-27', '2026-10-27', '2026-10-25', '2026-10-20']);
  p.el('f-to').value = '2026-10-27';
  assert.deepEqual(p.run(), ['2026-10-27', '2026-10-27', '2026-10-25', '2026-10-20']);
  assert.equal(p.count(), '(4 of 9)');
  assert.equal(p.el('f-to').min, '2026-10-20'); assert.equal(p.el('f-from').max, '2026-10-27');
  assert.equal(p.el('f-dates-clear').style.display, '', 'Clear dates shows while a date is set');
  p.el('f-from').value = '';
  assert.deepEqual(p.run(), ['2026-10-27', '2026-10-27', '2026-10-25', '2026-10-20', '2026-10-01', '2026-09-30', '2026-09-15'], 'To only (a lead with no date is left out)');
});

test('dates entered the wrong way round still give the range; it combines with the month filter; cleared = everything', () => {
  const p = page(ROWS);
  p.el('f-from').value = '2026-10-27'; p.el('f-to').value = '2026-10-20';
  assert.equal(p.run().length, 4);
  p.el('f-from').value = '2026-09-01'; p.el('f-to').value = '2026-10-31'; p.el('f-month').value = '2026-09';
  assert.deepEqual(p.run(), ['2026-09-30', '2026-09-15']);
  p.el('f-month').value = ''; p.el('f-from').value = ''; p.el('f-to').value = '';
  assert.equal(p.run().length, 9);
  assert.equal(p.el('f-dates-clear').style.display, 'none');
});
