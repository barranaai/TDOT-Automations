'use strict';

// The automation checklist shared with the management team by a private link
// (Faran 2026-11-19): no sign-in, a hashed token, never linked from any page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('../src/services/shareChecklistService');

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '', kind: '' };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (h) => { Object.assign(r.headers, h); return r; };
  r.type = (t) => { r.kind = t; return r; };
  r.send = (b) => { r.body = String(b); return r; };
  return r;
}

test('a wrong, missing or malformed token is a plain 404 with no page and no hints', () => {
  for (const token of [undefined, '', 'x', 'checklist', 'A'.repeat(24), '../../etc/passwd', 'a b c d e f g h i j k l', 'Z'.repeat(200)]) {
    const res = fakeRes();
    svc.serve({ params: { token } }, res);
    assert.equal(res.statusCode, 404, String(token));
    assert.equal(res.body, 'Not found');
    assert.ok(!res.headers['X-Robots-Tag'], 'no special headers on a miss');
  }
});

test('the token is not in the code: only its SHA-256 is', () => {
  assert.match(svc.TOKEN_SHA256, /^[0-9a-f]{64}$/);
  const src = fs.readFileSync(require.resolve('../src/services/shareChecklistService'), 'utf8');
  assert.ok(!/randomBytes|base64url/.test(src), 'no token generator in the service');
});

test('the headers sent with the page: no-index, no-referrer, no-store and a tight CSP with no scripts', () => {
  // The real token is not in the repo, so a test cannot open the page through serve();
  // these are the exact headers serve() sends with it.
  const h = svc.HEADERS;
  assert.equal(h['X-Robots-Tag'], 'noindex, nofollow, noarchive');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['Cache-Control'], 'no-store');
  assert.match(h['Content-Security-Policy'], /default-src 'none'/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.ok(!/script-src/.test(h['Content-Security-Policy']), 'no scripts allowed');
  const src = fs.readFileSync(require.resolve('../src/services/shareChecklistService'), 'utf8');
  assert.match(src, /res\.set\(HEADERS\)\.type\('html'\)\.send\(html\)/, 'serve() sends these headers');
});

test('the page is a complete document, kept out of search engines, with no scripts and no client details', () => {
  const html = svc.page();
  assert.ok(html.startsWith('<!doctype html>'), 'doctype');
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<title>TDOT Automation Checklist<\/title>/);
  assert.ok(!/<script/i.test(html), 'no scripts');
  // No real case numbers (only the neutral example) and no email addresses.
  const refs = (html.match(/\b20\d\d-[A-Z]{2,5}(?:-[A-Z]{2,5})*-\d{3,}\b/g) || []).filter((r) => r !== '2026-ABC-001');
  assert.deepEqual(refs, [], 'no real case numbers');
  assert.ok(!/[\w.+-]+@(?!tdotimm\.com)[\w-]+\.[\w.]+/.test(html), 'no client email addresses');
  assert.ok(!/Section L|salary|contract renewal/i.test(html), 'nothing from the private section');
});

test('no page links to the shared checklist (not on the dashboard or anywhere else)', () => {
  const root = path.join(__dirname, '..', 'src');
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html|json)$/.test(e.name)) continue;
      const rel = path.relative(root, p);
      if (rel === 'server.js' || rel === path.join('services', 'shareChecklistService.js')) continue;
      if (fs.readFileSync(p, 'utf8').includes('/share/checklist')) hits.push(rel);
    }
  })(root);
  assert.deepEqual(hits, []);
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.equal((server.match(/\/share\/checklist/g) || []).length, 1, 'only the route itself');
  assert.match(server, /app\.get\('\/share\/checklist\/:token'/);
});
