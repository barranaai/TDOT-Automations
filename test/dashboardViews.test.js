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
                      'chart-readiness-target', 'readiness-overall', 'mgr-grid', 'atrisk-body'];
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
