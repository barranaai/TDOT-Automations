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

test('every flowchart box has a "How do I…" list of 1 to 4 real answers, and every link in the guide leads somewhere (Gauri 2026-11-07)', () => {
  const g = JSON.parse(guide.data());
  const qs = new Set(g.howto.map((h) => h.q));
  const ids = new Set(g.steps.map((s) => s.id));
  assert.equal(qs.size, g.howto.length, 'no question twice');
  assert.equal(ids.size, g.steps.length, 'no step id twice');
  for (const n of g.workflow.nodes) {
    assert.ok(Array.isArray(n.howto) && n.howto.length >= 1 && n.howto.length <= 4, `box ${n.id} has 1-4 how-tos`);
    for (const q of n.howto) assert.ok(qs.has(q), `box ${n.id}: "${q}" is a real how-to`);
    for (const s of n.steps || []) assert.ok(ids.has(s), `box ${n.id}: step ${s}`);
  }
  for (const h of g.howto) for (const s of h.step_ids || []) assert.ok(ids.has(s), `how-to "${h.q}": step ${s}`);
  const page = guide.page();
  assert.ok(page.includes('function nodeHowtos(n)') && page.includes("<h5>How do I…</h5>"), 'the box card shows them');
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
