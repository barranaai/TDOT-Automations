'use strict';

// The staff guide at /admin/guide (Faran 2026-10-30): the page carries no guide
// content, the content is only served to signed-in staff, and every staff page
// header links to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const guide = require('../src/services/staffGuideService');

test('the page itself holds no guide content and loads it only after a sign-in check', () => {
  const page = guide.page();
  assert.match(page, /<script type="application\/json" id="guide-data"><\/script>/, 'empty data slot');
  assert.ok(!page.includes('"steps":['), 'no steps in the page');
  assert.ok(page.includes("fetch('/admin/guide/data'"), 'fetches the content');
  assert.ok(page.includes('Please sign in first'), 'friendly sign-in message on 401');
  assert.ok(page.includes('noindex'), 'kept out of search engines');
});

test('the content file is the full guide', () => {
  const g = JSON.parse(guide.data());
  assert.ok(Array.isArray(g.steps) && g.steps.length > 100, 'steps');
  assert.ok(g.workflow && Array.isArray(g.workflow.nodes) && g.workflow.nodes.length > 40, 'diagram');
  for (const k of ['glossary', 'howto', 'firstday', 'emails', 'automatic']) assert.ok(Array.isArray(g[k]) && g[k].length, k);
});

test('the data route answers only to the team key or a Monday staff sign-in', () => {
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const i = src.indexOf("app.get('/admin/guide/data'");
  assert.ok(i > 0, 'route exists');
  const body = src.slice(i, i + 600);
  assert.match(body, /key === ADMIN_API_KEY/);
  assert.match(body, /tryStaffAuth\(req\)/);
  assert.match(body, /status\(401\)/);
  assert.match(body, /no-store/);
});

test('every staff page header has the Guide button, opening in the same tab (the team key lives in the tab)', () => {
  const { buildNavHeader } = require('../src/routes/adminShared');
  const html = buildNavHeader('leads');
  assert.match(html, /<a href="\/admin\/guide" class="nav-lnk"/);
  // A new tab would not carry the team key (it is kept per tab), so key-only staff would be asked to sign in.
  assert.ok(!/href="\/admin\/guide"[^>]*target=/.test(html), 'same tab');
  assert.ok(html.includes('<span class="nav-txt">Guide</span>'));
});
