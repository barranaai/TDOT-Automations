'use strict';

// Phones (Faran 2026-11-04, "yes fix both"):
//  1. "Keep me signed in on this device" on the sign-in page — the team key is kept in
//     this browser, so a new tab opens without typing it again; Sign Out forgets it.
//  2. Every text box is 16px on a phone-sized screen (an iPhone zooms into smaller ones).

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { SHARED_AUTH_JS, NAV_CSS } = require('../src/routes/adminShared');

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function runAuth({ session = {}, local = {} } = {}) {
  const ss = storage(session), ls = storage(local), went = [];
  const ctx = { sessionStorage: ss, localStorage: ls, window: { location: { replace: (u) => went.push(u) } }, fetch: () => ({ then: (a) => { a(); return { then() {} }; } }), setTimeout: () => {}, document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(SHARED_AUTH_JS, ctx);
  return { ctx, ss, ls, went };
}

test('a kept key opens a new tab without typing it; a tab key wins; nothing kept = the sign-in page as before', () => {
  let r = runAuth({ local: { tdot_admin_key_keep: 'K1' } });
  assert.equal(r.ss.getItem('tdot_admin_key'), 'K1');
  assert.equal(vm.runInContext('getKey()', r.ctx), 'K1');
  r = runAuth({ session: { tdot_admin_key: 'K2' }, local: { tdot_admin_key_keep: 'K1' } });
  assert.equal(vm.runInContext('getKey()', r.ctx), 'K2', 'this tab’s own key is never replaced');
  r = runAuth();
  assert.equal(vm.runInContext('getKey()', r.ctx), null);
  assert.deepEqual(r.went, ['/admin']);
});

test('Sign Out forgets the kept key too (the next person on this device must sign in)', () => {
  const r = runAuth({ local: { tdot_admin_key_keep: 'K1' } });
  vm.runInContext('signOut()', r.ctx);
  assert.equal(r.ls.getItem('tdot_admin_key_keep'), null);
  assert.equal(r.ss.getItem('tdot_admin_key'), null);
});

test('blocked storage (private browsing) never breaks the page', () => {
  const ctx = { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem() { throw new Error('denied'); } }, window: { location: { replace() {} } }, document: { getElementById: () => null } };
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(SHARED_AUTH_JS, ctx));
});

test('the sign-in page: an unticked-by-default "Keep me signed in on this device" box; ticked keeps the key, unticked forgets any kept one; scripts parse', () => {
  const html = require('../src/routes/adminLogin').buildLoginHTML();
  assert.match(html, /<input type="checkbox" id="keep-signed-in">/, 'never ticked by default (shared office computers)');
  assert.match(html, /Only on your own phone or computer/);
  assert.match(html, /if \(document\.getElementById\('keep-signed-in'\)\.checked\) localStorage\.setItem\('tdot_admin_key_keep', key\);\s*else localStorage\.removeItem\('tdot_admin_key_keep'\);/);
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  assert.match(html, /@media \(max-width: 760px\) \{ \.field-input \{ font-size: 16px; \} \}/);
});

test('phones: every text box, list and note box is 16px on a phone-sized screen (no iPhone zoom); check boxes untouched', () => {
  assert.match(NAV_CSS, /@media \(max-width: 760px\) \{\s*input:not\(\[type=checkbox\]\):not\(\[type=radio\]\):not\(\[type=file\]\):not\(\[type=button\]\):not\(\[type=submit\]\), select, textarea \{ font-size: 16px !important; \}/);
  for (const page of [require('../src/routes/adminLeads').buildLeadsQueueHTML(), require('../src/routes/adminConsultation').buildQueueHTML()]) {
    assert.ok(page.includes('font-size: 16px !important'), 'the rule reaches the page');
    assert.ok(page.includes('tdotRestoreKey'), 'the kept key is picked up on the page');
  }
});
