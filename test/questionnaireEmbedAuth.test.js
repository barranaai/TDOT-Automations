'use strict';

// Guards the cockpit's inline questionnaire embed: the review route must accept
// the admin key (so the cockpit can load it) but must NOT let an unauthenticated
// / wrong-key request through, and ?embed=1 must strip the standalone chrome.

const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';
const routeMod = require('../src/routes/htmlQuestionnaireForm');
const { staffOrAdminKey, maybeEmbed } = routeMod;

function fakeReq({ headers = {}, query = {}, cookies = {} } = {}) {
  return { headers, query, cookies, originalUrl: '/q/2026-X/review' };
}
function fakeRes() {
  const res = { redirected: null, statusCode: 200 };
  res.redirect = (url) => { res.redirected = url; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.clearCookie = () => res;
  return res;
}

test('staffOrAdminKey: valid admin key (header) → next(), sets a staff identity', () => {
  const req = fakeReq({ headers: { 'x-api-key': 'test-admin-key' } });
  let called = false;
  staffOrAdminKey(req, fakeRes(), () => { called = true; });
  assert.equal(called, true, 'passes through with the admin key');
  assert.ok(req.staff && req.staff.name, 'sets req.staff so downstream req.staff.name works');
});

test('staffOrAdminKey: valid admin key via ?key= query (iframe path) → next()', () => {
  const req = fakeReq({ query: { key: 'test-admin-key' } });
  let called = false;
  staffOrAdminKey(req, fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test('staffOrAdminKey: wrong key and no staff cookie → does NOT call next (redirects to login)', () => {
  const req = fakeReq({ query: { key: 'nope' } });
  const res = fakeRes();
  let called = false;
  staffOrAdminKey(req, res, () => { called = true; });
  assert.equal(called, false, 'must not authorise a wrong key');
  assert.ok(res.redirected, 'falls through to the Monday OAuth login redirect');
});

test('maybeEmbed: ?embed=1 injects the chrome-strip; without it the page is untouched', () => {
  const page = '<html><head><title>x</title></head><body>...</body></html>';
  const embedded = maybeEmbed(fakeReq({ query: { embed: '1' } }), page);
  assert.ok(embedded.includes('#print-toolbar{display:none'), 'hides the standalone toolbar');
  assert.ok(embedded.includes('</head>'), 'still valid document');
  assert.equal(maybeEmbed(fakeReq({}), page), page, 'no embed flag → unchanged');
});
