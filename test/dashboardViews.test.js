'use strict';

// Dashboard split (user directive 2026-08-05): /admin/dashboard is the 📋 All
// Cases table ONLY; everything else moved to /admin/dashboard/summary.
//
// The load-bearing detail: several summary renderers dereference their
// container with no null check (renderActionCards →
// getElementById('act-count-deadline').textContent). If render() ever runs
// them on the cases page, the TypeError aborts render() BEFORE
// initAllCasesTable and the table silently stays empty behind a stuck
// spinner. These tests pin the separation that prevents that.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');

const router = require('../src/routes/adminDashboard');

function renderRoute(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(layer, `route ${path} is registered`);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}

const CASES_ONLY   = ['all-cases-body', 'search-box', 'filter-stage', 'filter-health', 'filter-manager', 'table-count', 'pagination'];
const SUMMARY_ONLY = ['kpi-total', 'kpi-red', 'act-count-deadline', 'act-list-behind', 'chart-health', 'chart-stage',
                      'chart-readiness-target', 'readiness-overall', 'mgr-grid', 'atrisk-body',
                      // the needs-attention list (2026-10-01) sits at the top of the summary
                      'na-panel', 'na-body', 'na-check', 'na-total', 'na-note'];
const SHARED       = ['loading', 'error-msg', 'content', 'hdr-updated', 'refresh-btn'];

test('both dashboard routes exist and emit parseable client JS', async () => {
  for (const path of ['/', '/summary']) {
    const html = await renderRoute(path);
    assert.ok(html.length > 10000, `${path} renders a full page`);
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, `${path} emits inline script`);
    for (const s of scripts) new vm.Script(s);           // throws on a syntax error
    assert.ok(!/\$\{/.test(html), `${path} has no un-interpolated template placeholders`);
  }
});

test('the cases view carries the All Cases table and NONE of the summary containers', async () => {
  const html = await renderRoute('/');
  assert.match(html, /var VIEW = "cases"/);
  for (const id of CASES_ONLY)   assert.ok(html.includes(`id="${id}"`), `cases view must have #${id}`);
  for (const id of SUMMARY_ONLY) assert.ok(!html.includes(`id="${id}"`), `cases view must NOT have #${id}`);
  for (const id of SHARED)       assert.ok(html.includes(`id="${id}"`), `shared shell keeps #${id}`);
});

test('the summary view carries every moved section and NOT the cases table', async () => {
  const html = await renderRoute('/summary');
  assert.match(html, /var VIEW = "summary"/);
  for (const id of SUMMARY_ONLY) assert.ok(html.includes(`id="${id}"`), `summary view must have #${id}`);
  for (const id of CASES_ONLY)   assert.ok(!html.includes(`id="${id}"`), `summary view must NOT have #${id}`);
  for (const id of SHARED)       assert.ok(html.includes(`id="${id}"`), `shared shell keeps #${id}`);
});

test('render() is view-branched — the cases page never calls a summary renderer', async () => {
  const html = await renderRoute('/');
  const body = html.slice(html.indexOf('function render(data)'), html.indexOf('function render(data)') + 900);
  assert.match(body, /if \(VIEW === 'summary'\)/, 'explicit branch, not null-safety by luck');
  assert.match(body, /return;/, 'the summary arm returns before initAllCasesTable');
  // The unguarded renderers must sit INSIDE the summary arm.
  const summaryArm = body.slice(body.indexOf("if (VIEW === 'summary')"), body.indexOf('return;'));
  for (const fn of ['renderActionCards', 'renderAtRisk', 'renderKPIs', 'renderManagerCards']) {
    assert.ok(summaryArm.includes(fn), `${fn} must only run on the summary view`);
  }
});

test('Chart.js loads ONLY on the summary view (the cases page must not depend on it)', async () => {
  assert.ok(!(await renderRoute('/')).includes('chart.umd.min.js'), 'cases view skips the CDN');
  assert.ok((await renderRoute('/summary')).includes('chart.umd.min.js'), 'summary view loads it');
});

test('each view links to the other so nothing becomes unreachable', async () => {
  assert.match(await renderRoute('/'), /class="view-switch" href="\/admin\/dashboard\/summary"/);
  assert.match(await renderRoute('/summary'), /class="view-switch" href="\/admin\/dashboard"/);
});

test('the admin-only delete control survives on the cases view', async () => {
  const html = await renderRoute('/');
  assert.ok(html.includes('TDOT_IS_ADMIN'), 'admin gate still applied to the delete cell');
  assert.ok(html.includes('data-del-case='), 'delete button still emitted per row');
  assert.ok(html.includes('tdotBindDelete'), 'delete modal still wired');
});

// User directive 2026-08-05: the newest case must be at the top by default.
test('All Cases defaults to newest-created first', async () => {
  const html = await renderRoute('/');
  assert.match(html, /var _sortCol\s*=\s*'createdAt'/, 'defaults to the creation timestamp');
  assert.match(html, /var _sortDir\s*=\s*-1/, 'descending — latest at the top');
});

test('createdAt ordering: newest first, same-day times honoured, missing timestamps sink', () => {
  // Mirrors the comparator in sortTable for the string branch with _sortDir=-1.
  const cmp = (a, b) => {
    const av = (a.createdAt || '').toLowerCase(), bv = (b.createdAt || '').toLowerCase();
    return av < bv ? 1 : av > bv ? -1 : 0;
  };
  const rows = [
    { ref: 'old',      createdAt: '2026-06-15T16:41:48Z' },
    { ref: 'today-am', createdAt: '2026-08-05T09:10:00Z' },
    { ref: 'mid',      createdAt: '2026-07-07T22:07:06Z' },
    { ref: 'no-stamp', createdAt: '' },
    { ref: 'today-pm', createdAt: '2026-08-05T18:00:00Z' },
  ].sort(cmp);
  assert.deepEqual(rows.map((r) => r.ref), ['today-pm', 'today-am', 'mid', 'old', 'no-stamp'],
    'ISO-8601 sorts chronologically as a string; a blank stamp must never masquerade as newest');
});

test('dashboardService requests and maps the Monday created_at', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.match(src, /id name created_at/, 'created_at is selected in the items query');
  assert.match(src, /createdAt:\s+item\.created_at/, 'and mapped onto the case object');
});

test('the top bar has a Summary tab; it is the active one on the summary view, Cases on the cases view', async () => {
  const active = (html) => [...html.matchAll(/<a href="([^"]+)" class="nav-lnk active"/g)].map((m) => m[1]);
  const summary = await renderRoute('/summary');
  const cases = await renderRoute('/');
  for (const html of [summary, cases]) assert.match(html, /<a href="\/admin\/dashboard\/summary" class="nav-lnk[^"]*"[^>]*>[\s\S]{0,120}Summary<\/span>/);
  assert.deepEqual(active(summary), ['/admin/dashboard/summary']);
  assert.deepEqual(active(cases), ['/admin/dashboard']);
});

test('the needs-attention list loads with the summary page and only there, and sits above the KPI figures', async () => {
  const summary = await renderRoute('/summary');
  assert.ok(summary.indexOf('id="na-panel"') < summary.indexOf('id="kpi-total"'), 'the list comes first');
  // Outside #content (hidden until the figures load, and again on every Refresh):
  // the list comes from the server's memory and must show even when they fail.
  assert.ok(summary.indexOf('id="na-panel"') < summary.indexOf('id="content"'), 'the list is not inside #content');
  assert.ok(summary.indexOf('class="dash-header"') < summary.indexOf('id="na-panel"'), 'under the page title');
  assert.match(summary, /if \(VIEW === 'summary'\) naLoad\(\);/);
  assert.match(summary, /fetch\('\/admin\/needs-attention'/);
  // Every value from the server goes through escHtml before innerHTML.
  const fn = summary.slice(summary.indexOf('function naItemHtml'), summary.indexOf('function naRender'));
  for (const field of ['e.caseRef', 'e.client', 'e.why', 'e.todo', 'e.key']) assert.match(fn, new RegExp('escHtml\\(' + field.replace('.', '\\.')), field + ' is escaped');
});
