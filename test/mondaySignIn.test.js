'use strict';

// "Sign in with Monday" made visible (Faran 2026-10-31) — staff saw only the
// admin-key box and did not know the Monday sign-in existed. Now:
//  - the sign-in page has a "Sign in with Monday" button (or "Signed in with
//    Monday as …" once done);
//  - every staff page's top bar shows your name, or a sign-in link that comes
//    back to the same page;
//  - Sign Out ends the Monday sign-in too (POST /q/auth/logout), so the next
//    person at the computer is not taken for the last one.

const test         = require('node:test');
const assert       = require('node:assert/strict');
const vm           = require('vm');
const http         = require('http');
const express      = require('express');
const cookieParser = require('cookie-parser');

const shared    = require('../src/routes/adminShared');
const staffAuth = require('../src/middleware/staffAuth');

async function withApp(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const tick = () => new Promise((r) => setImmediate(r));

test('sign-in page: the key box as before, then a "Sign in with Monday" button that comes back here', async () => {
  const app = express();
  app.use('/admin', require('../src/routes/adminLogin'));
  await withApp(app, async (base) => {
    const html = await (await fetch(`${base}/admin`)).text();
    assert.match(html, /id="api-key"/);
    assert.match(html, /Sign In →/);
    assert.match(html, /<a class="btn-monday" id="mon-btn" href="\/q\/auth\/monday\?returnTo=%2Fadmin">[\s\S]{0,700}Sign in with Monday\s*<\/a>/);
    assert.match(html, /so the app knows who you are/);
    // once signed in it says who — the name goes in as text, never as HTML
    assert.match(html, /fetch\('\/admin\/payments\/viewer', \{ credentials: 'same-origin' \}\)/);
    assert.match(html, /getElementById\('mon-as'\)\.textContent = ' as ' \+ v\.name/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const s of scripts) new vm.Script(s);   // the page's own script parses
    assert.doesNotMatch(html, /body \{[^}]*overflow: hidden/, 'a short window scrolls instead of cutting the card off');
  });
});

test('sign-in page: "Not you? Sign out" ends someone else\'s Monday sign-in on this computer and says what to do next', async () => {
  const app = express();
  app.use('/admin', require('../src/routes/adminLogin'));
  let html;
  await withApp(app, async (base) => { html = await (await fetch(`${base}/admin`)).text(); });
  assert.match(html, /<div class="mon-ok" id="mon-ok" role="status" style="display:none">[\s\S]{0,200}<button type="button" class="mon-out" id="mon-out">Not you\? Sign out<\/button><\/div>/);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join('\n');
  // run the page's own script in a stand-in browser: signed in with Monday as "Ana", no key
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
  const requests = []; const timers = []; let reloads = 0; const replaced = []; let logoutOk = true;
  const ctx = {
    sessionStorage: { getItem: () => null },
    window: { location: { replace: (u) => replaced.push(u), reload: () => { reloads++; } } },
    document: { getElementById: el, addEventListener() {} },
    fetch: (url, opts) => { requests.push([url, opts]); return url === '/admin/payments/viewer' ? Promise.resolve({ ok: true, json: async () => ({ signedIn: true, name: 'Ana' }) }) : Promise.resolve({ ok: logoutOk }); },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await tick();
  assert.deepEqual(replaced, [], 'no key: stays on the sign-in page');
  assert.equal(els['mon-ok'].style.display, 'block');
  assert.equal(els['mon-as'].textContent, ' as Ana');
  assert.equal(els['mon-btn'].style.display, 'none');
  assert.equal(typeof els['mon-out'].handlers.click, 'function');
  els['mon-out'].handlers.click();
  const out = requests.find((r) => r[0] === '/q/auth/logout');
  assert.ok(out, 'asks the server to end the Monday sign-in');
  assert.equal(out[1].method, 'POST');
  assert.equal(out[1].headers['X-Tdot-Signout'], '1');
  await tick();
  assert.equal(reloads, 0, 'no reload: the page says what to do next');
  assert.equal(els['mon-ok'].style.display, 'none');
  assert.equal(els['mon-btn'].style.display, '', 'the Monday button is back');
  assert.match(els['mon-note'].textContent, /Signed out of Monday here\. Now press "Sign in with Monday"\. If it brings back the same name, log out on the Monday\.com website first\./);
  assert.equal(els['mon-note'].style.display, 'block');
  timers.find((x) => x[1] === 3000)[0]();
  assert.equal(reloads, 0, 'the fallback does nothing once done');

  // the server did not confirm: reload, so the page shows the real state (never a false "signed out")
  logoutOk = false; timers.length = 0;
  vm.runInContext(script, ctx);   // a fresh page
  await tick();
  els['mon-out'].handlers.click();
  await tick();
  assert.equal(reloads, 1);
});

// A tiny stand-in for the browser, enough for the shared top-bar script.
function browserFor({ viewer, key = 'k', path = '/admin/leads', search = '' }) {
  const slot = { children: [], innerHTML: '', appendChild(c) { this.children.push(c); } };
  const requests = [];
  const went = [];
  const timers = [];
  const store = key ? { tdot_admin_key: key } : {};
  const ctx = {
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), removeItem: (k) => { delete store[k]; } },
    location: { pathname: path, search },
    window: { location: { replace: (u) => went.push(u) } },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: (id) => (id === 'hdr-who' ? slot : null),
      createElement: (tag) => {
        const txt = { textContent: '' };
        return { tag, attrs: {}, txt, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: (sel) => (sel === '.who-txt' ? txt : null) };
      },
    },
    fetch: (url, opts) => {
      requests.push([url, opts]);
      if (url === '/q/auth/logout') return new Promise(() => {});   // never answers
      return Promise.resolve(viewer ? { ok: true, json: async () => viewer } : { ok: false, json: async () => ({}) });
    },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); },
    setInterval() {},
  };
  vm.createContext(ctx);
  vm.runInContext(shared.SHARED_AUTH_JS, ctx);
  return { ctx, slot, requests, went, timers, store };
}

test('top bar: signed in with Monday → your name (as text); not signed in → a "Sign in with Monday" link back to this page', async () => {
  const hdr = shared.buildNavHeader('leads');
  assert.match(hdr, /<span class="hdr-who" id="hdr-who"><\/span>\s*<button class="sign-out-btn" onclick="signOut\(\)">Sign Out<\/button>/);
  assert.match(shared.NAV_CSS, /\.hdr-who:empty \{ display: none; \}/, 'an empty slot takes no room');

  const nasty = '<img src=x onerror=alert(1)>';
  let b = browserFor({ viewer: { signedIn: true, name: nasty } });
  await tick();
  assert.deepEqual(b.requests.map((r) => r[0]), ['/admin/payments/viewer']);
  assert.equal(b.requests[0][1].credentials, 'same-origin');
  assert.equal(b.requests[0][1].headers['X-Api-Key'], 'k');
  assert.equal(b.slot.children.length, 1);
  const on = b.slot.children[0];
  assert.equal(on.tag, 'span');
  assert.equal(on.className, 'who-chip on');
  assert.equal(on.txt.textContent, nasty, 'the name is set as text');
  assert.doesNotMatch(on.innerHTML, /onerror/, 'never as HTML');
  assert.equal(on.title, `Signed in with Monday as ${nasty}`);

  b = browserFor({ viewer: { signedIn: false, name: '' }, path: '/admin/case/2026-EE-001', search: '?tab=docs' });
  await tick();
  const link = b.slot.children[0];
  assert.equal(link.tag, 'a');
  assert.equal(link.href, '/q/auth/monday?returnTo=' + encodeURIComponent('/admin/case/2026-EE-001?tab=docs'));
  assert.match(link.innerHTML, /Sign in with Monday/);
  assert.equal(link.attrs['aria-label'], 'Sign in with Monday, so the app knows who you are');

  b = browserFor({ viewer: null, key: null });   // no key, no Monday: the page sends you to sign in anyway
  await tick();
  assert.equal(b.slot.children.length, 0);
  assert.equal(b.requests[0][1].headers['X-Api-Key'], undefined, 'no key header without a key');
});

test('Sign Out: drops the key at once, asks the server to end the Monday sign-in, and leaves even if that never answers', async () => {
  const b = browserFor({ viewer: null });
  await tick();
  b.requests.length = 0;
  vm.runInContext('signOut();', b.ctx);
  assert.equal(b.store.tdot_admin_key, undefined, 'the key is gone before anything else');
  assert.equal(b.requests.length, 1);
  const [url, opts] = b.requests[0];
  assert.equal(url, '/q/auth/logout');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.credentials, 'same-origin');
  assert.equal(opts.headers['X-Tdot-Signout'], '1');
  assert.deepEqual(b.went, []);
  const fallback = b.timers.find((t) => t[1] === 3000);
  assert.ok(fallback, 'a 3-second fallback');
  fallback[0]();
  fallback[0]();
  assert.deepEqual(b.went, ['/admin'], 'to the sign-in page, once');
});

test('POST /q/auth/logout ends the Monday sign-in — only from the Sign Out button, never cached; a link (GET) does nothing', async () => {
  const app = express();
  app.use(cookieParser());
  app.use('/q', require('../src/routes/htmlQuestionnaireForm'));
  const cookie = 'tdot_staff=' + staffAuth.createStaffToken({ id: '1', name: 'Test Staffer', email: 'test.staffer@example.invalid' });
  const log = console.log; console.log = () => {};
  try {
    await withApp(app, async (base) => {
      let res = await fetch(`${base}/q/auth/logout`, { method: 'POST', headers: { cookie } });
      assert.equal(res.status, 400, 'a plain form post from another website');
      assert.equal(res.headers.get('set-cookie'), null, 'clears nothing');

      res = await fetch(`${base}/q/auth/logout`, { method: 'POST', headers: { cookie, 'X-Tdot-Signout': '1' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      const sc = res.headers.get('set-cookie') || '';
      assert.match(sc, /^tdot_staff=;/);
      assert.match(sc, /Expires=Thu, 01 Jan 1970/);
      assert.match(sc, /Path=\//);
      assert.match(sc, /HttpOnly/);
      assert.match(sc, /SameSite=Lax/i);
      assert.equal(res.headers.get('cache-control'), 'no-store');

      res = await fetch(`${base}/q/auth/logout`, { redirect: 'manual' });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('set-cookie'), null);
    });
  } finally { console.log = log; }
});

test('the cookie is cleared with the options it was set with (else the browser keeps it)', () => {
  const calls = [];
  const res = { cookie: (n, v, o) => calls.push(['set', n, o]), clearCookie: (n, o) => calls.push(['clear', n, o]) };
  staffAuth.setStaffCookie(res, 'x');
  staffAuth.clearStaffCookie(res);
  const [set, clear] = calls;
  assert.equal(clear[1], set[1]);
  for (const k of ['httpOnly', 'secure', 'sameSite']) assert.equal(clear[2][k], set[2][k], k);
  assert.equal(set[2].path, undefined, 'both use the default path "/"');
  assert.equal(clear[2].path, undefined);
});
