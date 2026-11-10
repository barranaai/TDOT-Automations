'use strict';

// Reporting charts (Summary → Reporting, 2026-11-10). The charts read computeTrend, and
// computeTrend reads computeKpis: one set of counting rules, so a chart can never disagree
// with the cards. Pinned here: the 12 Toronto months (never a future one), month edges,
// equality with computeKpis for every number, the /api/kpis/trend route (shared snapshot,
// no Square), the canvases on the Summary page only, and the Reporting link on the Leads,
// Consultations and Retainers pages. Offline: nothing here reads Monday, Square or Graph.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const K = require('../src/services/kpiService');
const { computeKpis, computeTrend, lastMonths, trendPoint, SOURCE_BLANK } = K;

const NOW = Date.parse('2026-11-10T15:00:00Z');   // 10 Nov 2026, 10:00 in Toronto

const LEADS = [
  // booked consultation → retained and paid in October
  { sourceChannel: 'Website', assignedConsultant: 'Consultant A', createdAt: '2026-10-02T14:00:00Z', bookingStatus: 'Booked', bookedSlot: '2026-10-06 10:00', consultationHeld: '2026-10-06', meetingType: 'Virtual', squareConsultTxnId: 't1', confirmedCaseType: 'Study Permit', retainerSent: '2026-10-07', retainerSigned: '2026-10-08', retainerPaid: '2026-10-09', retainerFee: '2000' },
  // signed in October, paid in November
  { sourceChannel: 'Google', assignedConsultant: 'Consultant B', createdAt: '2026-10-20T14:00:00Z', bookingStatus: 'Booked', bookedSlot: '2026-10-22 11:00', consultationHeld: '2026-10-22', meetingType: 'In-person', squareConsultTxnId: 't2', confirmedCaseType: 'Inland Spousal Sponsorship', retainerSigned: '2026-10-30', retainerPaid: '2026-11-03', retainerFee: '5000' },
  // 03:30 UTC on 1 Nov is still 31 Oct in Toronto: an October lead. No source.
  { sourceChannel: '', createdAt: '2026-11-01T03:30:00Z' },
  // 04:30 UTC on 1 Nov is 00:30 on 1 Nov in Toronto (still daylight time): a November lead
  { sourceChannel: 'Website', createdAt: '2026-11-01T04:30:00Z' },
  // an abandoned hold in November: not a booking
  { sourceChannel: 'Instagram', createdAt: '2026-11-02T15:00:00Z', bookingStatus: 'Abandoned', bookedSlot: '2026-11-04 10:00' },
  // a confirmed booking later this month: booked, not yet consulted
  { sourceChannel: 'Website', assignedConsultant: 'Consultant A', createdAt: '2026-11-03T15:00:00Z', bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00', meetingType: 'Virtual' },
  // a walk-in (direct retainer) signed in November
  { sourceChannel: 'Direct Retainer', assignedConsultant: 'Consultant A', createdAt: '2026-11-05T15:00:00Z', retainerSigned: '2026-11-06', confirmedCaseType: 'Study Permit', retainerFee: '1500' },
  // a lead converted into a direct retainer, signed in November
  { sourceChannel: 'Direct Retainer', originalChannel: 'Phone', assignedConsultant: 'Consultant B', createdAt: '2026-09-15T15:00:00Z', retainerSigned: '2026-11-07', retainerFee: '1800' },
  // dated NEXT month: must not appear anywhere in the charts
  { sourceChannel: 'Website', assignedConsultant: 'Consultant A', createdAt: '2026-11-08T15:00:00Z', bookingStatus: 'Booked', bookedSlot: '2026-12-03 10:00', retainerSigned: '2026-12-05', retainerPaid: '2026-12-06' },
  // 13 months back: outside the 12-month window
  { sourceChannel: 'Website', createdAt: '2025-10-15T15:00:00Z' },
];

test('lastMonths: 12 Toronto months, oldest first, ending at the current month — never a future one', () => {
  const m = lastMonths(12, NOW);
  assert.equal(m.length, 12);
  assert.equal(m[0], '2025-12');
  assert.equal(m[11], '2026-11');
  assert.deepEqual(lastMonths(3, Date.parse('2026-01-15T17:00:00Z')), ['2025-11', '2025-12', '2026-01']);   // across a year end
  // 02:00 UTC on 1 Dec is still 30 Nov in Toronto: the current month is November
  assert.equal(lastMonths(12, Date.parse('2026-12-01T02:00:00Z'))[11], '2026-11');
  assert.equal(lastMonths(12, Date.parse('2026-12-01T06:00:00Z'))[11], '2026-12');
});

test('computeTrend: one point per month, in order, with no future month', () => {
  const t = computeTrend(LEADS, { now: NOW });
  assert.deepEqual(t.months, lastMonths(12, NOW));
  assert.deepEqual(t.trend.map((p) => p.month), t.months);
  assert.ok(!t.months.includes('2026-12'), 'December is in the future');
  assert.ok(!t.months.includes('2025-10'), '13 months back is outside the window');
});

test('computeTrend: every number of every month equals computeKpis for that month', () => {
  const t = computeTrend(LEADS, { now: NOW });
  for (const p of t.trend) {
    const k = computeKpis(LEADS, p.month, { now: NOW });
    assert.equal(p.leads, k.funnel.leads, `${p.month} leads`);
    assert.equal(p.booked, k.funnel.booked, `${p.month} booked`);
    assert.equal(p.consulted, k.funnel.consulted, `${p.month} consulted`);
    assert.equal(p.retained, k.funnel.retained, `${p.month} retained`);
    assert.deepEqual(p.retainedFrom, k.funnel.retainedFrom, `${p.month} retained split`);
    assert.equal(p.paidThisMonth, k.funnel.paid, `${p.month} paid`);
    assert.equal(p.abandonedHolds, k.consultations.abandonedHolds, `${p.month} abandoned holds`);
    assert.equal(p.consultationsBooked, k.consultations.booked, `${p.month} consultations booked`);
    assert.equal(p.consultationsHeld, k.consultations.held, `${p.month} consultations held`);
    assert.deepEqual(p, trendPoint(k), `${p.month} whole point`);
    assert.equal(p.retainedFrom.booked + p.retainedFrom.converted + p.retainedFrom.walkIn, p.retained, `${p.month} split adds up`);
  }
});

test('computeTrend: the month edges and the counting rules, in real numbers', () => {
  const t = computeTrend(LEADS, { now: NOW });
  const by = Object.fromEntries(t.trend.map((p) => [p.month, p]));
  // October: two booked leads + the 31 Oct 23:30 (Toronto) lead
  assert.equal(by['2026-10'].leads, 3);
  assert.equal(by['2026-10'].booked, 2);
  assert.equal(by['2026-10'].consulted, 2);
  assert.equal(by['2026-10'].retained, 2);
  assert.deepEqual(by['2026-10'].retainedFrom, { booked: 2, converted: 0, walkIn: 0 });
  assert.equal(by['2026-10'].paidThisMonth, 1);
  // November: 00:30 lead, abandoned-hold lead, booked lead, December-booked lead (created in Nov); the walk-in is not a lead
  assert.equal(by['2026-11'].leads, 4);
  assert.equal(by['2026-11'].booked, 1, 'the abandoned hold and the December booking are not November bookings');
  assert.equal(by['2026-11'].abandonedHolds, 1);
  assert.equal(by['2026-11'].consulted, 0, 'the 20 Nov consultation has not happened yet');
  assert.equal(by['2026-11'].retained, 2);
  assert.deepEqual(by['2026-11'].retainedFrom, { booked: 0, converted: 1, walkIn: 1 });
  assert.equal(by['2026-11'].paidThisMonth, 1, 'paid in November, signed in October');
  assert.equal(by['2026-09'].leads, 1, 'the converted lead was a lead first');
  // nothing dated December leaks into any month shown
  assert.equal(t.trend.reduce((n, p) => n + p.retained, 0), 4);
});

test('computeTrend: the selected month breakdown — source, consultant, TR / PR', () => {
  const t = computeTrend(LEADS, { now: NOW, month: '2026-10' });
  const k = computeKpis(LEADS, '2026-10', { now: NOW });
  assert.equal(t.breakdown.month, '2026-10');
  assert.deepEqual(t.breakdown.leadsBySource, { Website: 1, Google: 1, [SOURCE_BLANK]: 1 });
  assert.equal(SOURCE_BLANK, 'Not recorded');
  assert.deepEqual(t.breakdown.leadsBySource, k.funnel.leadsBySource);
  assert.deepEqual(t.breakdown.consultationsByConsultant, k.consultations.byConsultant);
  assert.deepEqual(t.breakdown.consultationsByConsultant, { 'Consultant A': 1, 'Consultant B': 1 });
  assert.deepEqual(t.breakdown.retainersSignedByConsultant, k.retainers.byConsultant);
  assert.deepEqual(t.breakdown.trPr, { tr: 1, pr: 1, unclassified: 0 });
  // default = the current month; a future or unreadable month falls back to it
  assert.equal(computeTrend(LEADS, { now: NOW }).breakdown.month, '2026-11');
  assert.equal(computeTrend(LEADS, { now: NOW, month: '2027-01' }).breakdown.month, '2026-11');
  assert.equal(computeTrend(LEADS, { now: NOW, month: 'nonsense' }).breakdown.month, '2026-11');
  assert.deepEqual(computeTrend(LEADS, { now: NOW }).breakdown.trPr, { tr: 1, pr: 0, unclassified: 1 });
  // a month older than the window still gets its own breakdown
  assert.equal(computeTrend(LEADS, { now: NOW, month: '2025-10' }).breakdown.leads, 1);
});

test('leads by source always adds up to the Leads number (every month and all time)', () => {
  for (const m of ['', ...lastMonths(12, NOW)]) {
    const k = computeKpis(LEADS, m, { now: NOW });
    const sum = Object.values(k.funnel.leadsBySource).reduce((a, b) => a + b, 0);
    assert.equal(sum, k.funnel.leads, m || 'all time');
  }
  assert.deepEqual(computeTrend([], { now: NOW }).breakdown.leadsBySource, {});
});

test('getTrend reads the shared lead snapshot — and nothing else', async () => {
  const snap = require('../src/services/leadSnapshot');
  const orig = snap.leads;
  let calls = 0;
  snap.leads = async () => { calls++; return LEADS; };
  try {
    const t = await K.getTrend('2026-10');
    assert.equal(calls, 1);
    assert.equal(t.trend.length, 12);
    assert.equal(t.breakdown.month, '2026-10');
  } finally { snap.leads = orig; }
});

test('the route and the service: same gate as /api/kpis, no Square', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const gate = server.indexOf("app.use('/api', requireApiKey)");
  const route = server.indexOf("app.get('/api/kpis/trend'");
  assert.ok(gate > 0 && route > gate, '/api/kpis/trend is registered after the /api key gate');
  const body = server.slice(route, server.indexOf('});', route));
  assert.match(body, /kpiService'\)\.getTrend\(/);
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/kpiService.js'), 'utf8');
  assert.ok(!/require\([^)]*square/i.test(svc), 'reporting never reads Square (Faran 2026-11-10)');
});

/* ── the pages ── */

const dash = require('../src/routes/adminDashboard');
function renderRoute(p) {
  const layer = dash.stack.find((l) => l.route && l.route.path === p);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const CANVASES = ['chart-rp-trend', 'chart-rp-retained', 'chart-rp-source', 'chart-rp-consultant', 'chart-rp-signed'];

test('Summary page: the five chart canvases, each with reserved height, a title and a message box', async () => {
  const html = await renderRoute('/summary');
  for (const id of CANVASES) {
    assert.ok(html.includes(`<canvas id="${id}"`), `#${id}`);
    assert.ok(html.includes(`id="${id}-empty"`), `#${id}-empty`);
    assert.match(html, new RegExp(`class="rp-chart-wrap" style="height:\\d+px"><canvas id="${id}"`), `${id} reserves its height`);
  }
  assert.ok(html.indexOf('id="reporting"') < html.indexOf('id="chart-rp-trend"'), 'the charts sit in the Reporting section');
  assert.ok(html.indexOf('id="chart-rp-signed"') < html.indexOf('Action Required'), 'and before the next section');
  for (const title of ['Month by month — last 12 months', 'Retained — where they came from', 'Leads by source', 'Consultations by consultant', 'Retainers signed by consultant']) assert.ok(html.includes(title), title);
  assert.ok(html.includes('Nothing to show for this month'));
  assert.ok(html.includes("if (VIEW === 'summary') { loadKpis(); loadTrend(); }"));
  for (const s of scriptsOf(html)) new vm.Script(s);
});

test('Client Master page: no chart canvases, no Chart.js, and Chart is only named behind a typeof check', async () => {
  const html = await renderRoute('/');
  for (const id of CANVASES) assert.ok(!html.includes(`id="${id}"`), `no #${id}`);
  assert.ok(!/<script[^>]*chart\.umd/.test(html));
  const mine = html.slice(html.indexOf('function rpDraw('), html.indexOf('function rpClear('));
  assert.match(mine, /typeof Chart === 'undefined'/);
  assert.ok(mine.indexOf("typeof Chart === 'undefined'") < mine.indexOf('new Chart('), 'checked before it is used');
  for (const s of scriptsOf(html)) new vm.Script(s);
});

/* Run the page's own chart code against a small fake page and a fake Chart. */
async function chartHarness({ withChart = true } = {}) {
  const html = await renderRoute('/summary');
  const src = scriptsOf(html).find((s) => s.includes('function renderTrendCharts('));
  const pick = (name, endName) => src.slice(src.indexOf(name), src.indexOf(endName));
  const code = 'var _charts = {};\n' + pick('var RP_MON', '/* ── Render all');
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getContext() { return {}; } });
  const tags = [{ textContent: '' }, { textContent: '' }, { textContent: '' }];
  const made = [], destroyed = [];
  const sandbox = { document: { getElementById: el, querySelectorAll: () => tags }, peekKey: () => 'k' };
  if (withChart) sandbox.Chart = function (ctx, cfg) { this.cfg = cfg; made.push(cfg); this.destroy = () => destroyed.push(cfg); };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, els, el, tags, made, destroyed };
}

test('page code: trend lines + stacked bars are drawn from the trend, redraw destroys the old chart', async () => {
  const h = await chartHarness();
  const t = JSON.parse(JSON.stringify(computeTrend(LEADS, { now: NOW })));
  h.sandbox.renderTrendCharts(t);
  assert.equal(h.made.length, 2);
  const [line, bars] = h.made;
  assert.equal(line.type, 'line');
  assert.deepEqual([...line.data.datasets.map((d) => d.label)], ['Leads', 'Booked', 'Consulted', 'Retained', 'Paid this month']);
  assert.ok(!/label:'Paid',/.test(require('fs').readFileSync(require.resolve('../src/routes/adminDashboard.js'), 'utf8')), 'the line is never called just "Paid": that word is the signers-who-paid step in the row above');
  assert.equal(line.data.labels.length, 12);
  assert.equal(line.data.labels[11], 'Nov 2026');
  assert.deepEqual([...line.data.datasets[0].data.slice(-2)], [3, 4]);
  assert.deepEqual([...line.data.datasets[3].data.slice(-2)], [2, 2]);
  assert.equal(new Set([...line.data.datasets].map((d) => d.pointStyle)).size, 5, 'each line has its own point shape — colour is not the only cue');
  assert.equal(line.options.maintainAspectRatio, false);
  assert.equal(bars.type, 'bar');
  assert.equal(bars.options.scales.x.stacked, true);
  assert.equal(bars.options.scales.y.stacked, true);
  assert.deepEqual([...bars.data.datasets.map((d) => d.label)], ['From a booked consultation', 'From a converted lead', 'Walk-in']);
  assert.deepEqual([...bars.data.datasets.map((d) => d.data[11])], [0, 1, 1]);
  assert.equal(h.els['chart-rp-trend-empty'].style.display, 'none');
  assert.match(h.els['chart-rp-trend'].attrs['aria-label'], /Leads 4/);
  h.sandbox.renderTrendCharts(t);
  assert.equal(h.destroyed.length, 2, 'destroy before redraw');
  // nothing at all → the empty message, no chart
  h.sandbox.renderTrendCharts(JSON.parse(JSON.stringify(computeTrend([], { now: NOW }))));
  assert.equal(h.made.length, 4);
  assert.equal(h.els['chart-rp-trend-empty'].textContent, 'Nothing to show for the last 12 months');
  assert.equal(h.els['chart-rp-trend'].style.visibility, 'hidden');
});

test('page code: the month charts read the same answer as the cards; top 10 + Other; empty month says so', async () => {
  const h = await chartHarness();
  const k = JSON.parse(JSON.stringify(computeKpis(LEADS, '2026-10', { now: NOW })));
  h.sandbox.renderMonthCharts(k);
  assert.equal(h.made.length, 3);
  const [src, cons, signed] = h.made;
  assert.equal(src.options.indexAxis, 'y');
  assert.deepEqual([...src.data.labels], ['Google', 'Not recorded', 'Website']);
  assert.deepEqual([...src.data.datasets[0].data], [1, 1, 1]);
  assert.deepEqual([...cons.data.labels], ['Consultant A', 'Consultant B']);
  assert.deepEqual([...signed.data.datasets[0].data], [1, 1]);
  assert.ok(h.tags.every((t) => t.textContent === 'Oct 2026'));
  // 13 sources → 10 bars + Other
  const many = { month: '2026-10', funnel: { leadsBySource: {} }, consultations: { byConsultant: {} }, retainers: { byConsultant: {} } };
  for (let i = 1; i <= 13; i++) many.funnel.leadsBySource['Source ' + String(i).padStart(2, '0')] = 20 - i;
  h.sandbox.renderMonthCharts(many);
  const last = h.made[h.made.length - 1];
  assert.equal(last.data.labels.length, 11);
  assert.equal(last.data.labels[10], 'Other (3 more)');
  assert.equal(last.data.datasets[0].data[10], 9 + 8 + 7);
  assert.equal(last.data.datasets[0].data.reduce((a, b) => a + b, 0), Object.values(many.funnel.leadsBySource).reduce((a, b) => a + b, 0), 'nothing is dropped');
  assert.equal(h.els['chart-rp-consultant-empty'].textContent, 'Nothing to show for this month');
  assert.equal(h.els['chart-rp-signed-empty'].textContent, 'Nothing to show for this month');
  // all time
  h.sandbox.renderMonthCharts({ month: 'all', funnel: { leadsBySource: {} }, consultations: {}, retainers: {} });
  assert.ok(h.tags.every((t) => t.textContent === 'All time'));
  assert.equal(h.els['chart-rp-source-empty'].textContent, 'Nothing to show yet');
});

test('page code: without the chart library the page says so and does not throw', async () => {
  const h = await chartHarness({ withChart: false });
  h.sandbox.renderTrendCharts(JSON.parse(JSON.stringify(computeTrend(LEADS, { now: NOW }))));
  h.sandbox.renderMonthCharts(JSON.parse(JSON.stringify(computeKpis(LEADS, '2026-10', { now: NOW }))));
  assert.match(h.els['chart-rp-trend-empty'].textContent, /could not be drawn/);
  assert.match(h.els['chart-rp-source-empty'].textContent, /could not be drawn/);
});

test('Leads, Consultations and Retainers pages: one Reporting link each, the same one, to Summary #reporting', () => {
  const { REPORTING_LINK_HTML } = require('../src/routes/adminShared');
  const C = require('../src/routes/adminConsultation');
  const L = require('../src/routes/adminLeads');
  assert.match(REPORTING_LINK_HTML, /href="\/admin\/dashboard\/summary#reporting"/);
  assert.match(REPORTING_LINK_HTML, />📊 Reporting<\/a>$/);
  for (const [name, html] of [['leads', L.buildLeadsQueueHTML()], ['consultations', C.buildQueueHTML()], ['retainers', C.buildRetainersHTML()]]) {
    assert.equal(html.split(REPORTING_LINK_HTML).length - 1, 1, `${name}: the link, once`);
    const at = html.indexOf(REPORTING_LINK_HTML);
    const h1 = html.indexOf('<h1 class="page-h"');
    assert.ok(h1 > 0 && at > h1 && at - h1 < 600, `${name}: beside the page title`);
    assert.ok(!/<canvas/.test(html), `${name}: no charts on this page`);
    for (const s of scriptsOf(html)) new vm.Script(s);
  }
  assert.ok(!C.buildDetailHTML('12345').includes(REPORTING_LINK_HTML), 'not on a record page');
});

test('Leads by source: the old "Direct Retainer" marker is never a source — a converted lead is filed under how it first reached us', () => {
  const rows = [
    { sourceChannel: 'Direct Retainer', originalChannel: 'Instagram', createdAt: '2026-10-05T15:00:00Z' },                 // converted before 2026-11-04
    { sourceChannel: 'Direct Retainer', originalChannel: '', createdAt: '2026-10-06T15:00:00Z' },                          // a walk-in: never a lead
    { sourceChannel: 'Walk-in', directClient: 'Yes', originalChannel: 'Website', createdAt: '2026-10-07T15:00:00Z' },      // converted since: the real source is in the column
    { sourceChannel: 'Instagram', createdAt: '2026-10-08T15:00:00Z' },
  ];
  const k = computeKpis(rows, '2026-10', { now: NOW });
  assert.deepEqual(k.funnel.leadsBySource, { Instagram: 2, 'Walk-in': 1 });
  assert.equal(Object.values(k.funnel.leadsBySource).reduce((a, b) => a + b, 0), k.funnel.leads);
  assert.equal('Direct Retainer' in computeKpis(rows, null, { now: NOW }).funnel.leadsBySource, false);
});
