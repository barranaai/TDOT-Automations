// The case page's Emails tab (Stage 2a, Faran 2026-11-19) — the three READ-ONLY routes with fakes: the switch,
// the Monday sign-in (the shared key alone → 401 with the sign-in link), admins mode, the case access check
// (404 / 503 / 403), the list (a partial source is never an empty list), re-matching on open / attachment (404),
// the download's exact headers (a non-Latin file name too), the logs, and the wiring in server.js.
// Every name, address and id here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Writable, Readable } = require('node:stream');
const express = require('express');

const routes = require('../src/routes/caseEmailsRoutes');
const realSvc = require('../src/services/caseEmailsService');

const STAFF = { id: '42', email: 'staff.one@tdotimm.com', name: 'Staff One', teamIds: [] };
const BOSS = { id: '7', email: 'boss@tdotimm.com', name: 'Boss', teamIds: [] };
const isAdminEmail = (e) => e === BOSS.email;
const ROW = { assignees: { personIds: ['42'], teamIds: [] }, recordUrl: '', texts: {} };

function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const back = () => { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(back); back(); return r; } catch (e) { back(); throw e; }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
/** A writable response with Express's own set / attachment / type (the real Content-Disposition). */
function streamRes() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const headers = {};
  Object.assign(w, {
    statusCode: 200, body: undefined, headers, chunks,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()],
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    set: express.response.set, header: express.response.header, get: express.response.get,
    attachment: express.response.attachment, type: express.response.type, contentType: express.response.contentType,
  });
  return w;
}
const req = (o = {}) => ({ params: { caseRef: '2026-SPE-016' }, query: {}, ...o });

function fakeService(o = {}) {
  const calls = [];
  return {
    calls,
    ...realSvc,
    mode: () => (o.mode || 'on'),
    readCaseRow: async (id) => { calls.push(['row', id]); if (o.rowFails) throw new Error('monday down'); return o.row || ROW; },
    list: async (a) => { calls.push(['list', a]); if (o.listFails) throw o.listFails; return o.list || { caseRef: '2026-SPE-016', complete: true, sources: {}, keys: { addresses: [], banners: [] }, counts: { shown: 0 }, items: [], _keys: { secret: 1 } }; },
    open: async (a) => { calls.push(['open', a]); if (o.openFails) throw o.openFails; return o.open || { item: { id: a.id, subject: 'S' }, unique: [{ t: 'text' }], imidHash: 'abcdef0123' }; },
    attachment: async (a) => { calls.push(['att', a]); if (o.attFails) throw o.attFails; return o.att || { stream: Readable.from([Buffer.from('%PDF-1.4 data')]), name: 'passport.pdf', size: 13, imidHash: 'abcdef0123' }; },
  };
}
function deps(staff, service, extra = {}) {
  return { staff: () => staff, isAdminEmail, service, lookupCase: async (ref) => { service.calls.push(['lookup', ref]); if (extra.lookup) return extra.lookup(ref); return { itemId: '900', caseRef: ref }; }, ...extra };
}
const quiet = async (fn) => { const keep = { log: console.log, warn: console.warn }; const logs = []; console.log = console.warn = (...a) => logs.push(a.join(' ')); try { await fn(logs); } finally { Object.assign(console, keep); } return logs; };

/* ══ the switch, the sign-in, admins mode ═════════════════════════════════════ */

test('switch off → 404 on every route, before anything is read; every answer private, no-store', async () => {
  for (const h of [routes.list, routes.message, routes.attachment]) {
    const s = fakeService({ mode: 'off' }); const res = fakeRes();
    await h(req({ query: { source: 'office', id: 'a1', att: 'A' } }), res, deps(BOSS, s));
    assert.equal(res.statusCode, 404); assert.equal(res.body.off, true);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(s.calls, []);
  }
  assert.equal(withEnv({ CASE_EMAILS_TAB: null }, () => realSvc.mode()), 'off');
  assert.equal(withEnv({ CASE_EMAILS_TAB: ' ON ' }, () => realSvc.mode()), 'on');
  assert.equal(withEnv({ CASE_EMAILS_TAB: 'Admins' }, () => realSvc.mode()), 'admins');
  assert.equal(withEnv({ CASE_EMAILS_TAB: 'yes' }, () => realSvc.mode()), 'off');
});

test('the shared key alone (no Monday sign-in) → 401 with the Monday sign-in link back to the case; nothing is read', async () => {
  for (const h of [routes.list, routes.message, routes.attachment]) {
    const s = fakeService(); const res = fakeRes();
    await h(req(), res, deps(null, s));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.loginUrl, '/q/auth/monday?returnTo=%2Fadmin%2Fcase%2F2026-SPE-016');
    assert.match(res.body.error, /^Sign in with Monday to see emails — the shared team key doesn't say who you are\.$/);
    assert.deepEqual(s.calls, []);
    const res2 = fakeRes(); await h(req(), res2, deps({ name: 'No email' }, s));
    assert.equal(res2.statusCode, 401, 'a sign-in without an email is not enough');
  }
});

test('admins mode: a staff member → 403 "admins-only" (the page removes the tab); an admin → in; the probe answers without reading the case', async () => {
  let s = fakeService({ mode: 'admins' }); let res = fakeRes();
  await routes.list(req(), res, deps(STAFF, s));
  assert.equal(res.statusCode, 403); assert.equal(res.body.reason, 'admins-only'); assert.deepEqual(s.calls, []);
  s = fakeService({ mode: 'admins' }); res = fakeRes();
  await routes.list(req({ query: { probe: '1' } }), res, deps(BOSS, s));
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { ok: true }); assert.deepEqual(s.calls, [], 'the probe reads nothing');
  s = fakeService({ mode: 'admins' }); res = fakeRes();
  await routes.list(req(), res, deps(BOSS, s));
  assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true);
  s = fakeService({ mode: 'on' }); res = fakeRes();
  await routes.list(req({ query: { probe: '1' } }), res, deps(STAFF, s));
  assert.equal(res.statusCode, 200, 'on: everyone signed in passes the probe');
});

/* ══ the case access check ════════════════════════════════════════════════════ */

test('a bad ref / an unknown case → 404; the case lookup failing → 503; the case row failing → 503 (an admin too) — never let through', async () => {
  let s = fakeService(); let res = fakeRes();
  await routes.list(req({ params: { caseRef: '../etc' } }), res, deps(BOSS, s));
  assert.equal(res.statusCode, 404); assert.deepEqual(s.calls, []);
  s = fakeService(); res = fakeRes();
  await routes.list(req(), res, deps(BOSS, s, { lookup: () => { throw new Error('Case not found.'); } }));
  assert.equal(res.statusCode, 404);
  const logs = await quiet(async () => {
    s = fakeService(); res = fakeRes();
    await routes.list(req(), res, deps(BOSS, s, { lookup: () => { throw new Error('ECONNRESET'); } }));
    assert.equal(res.statusCode, 503);
    for (const who of [BOSS, STAFF]) {
      s = fakeService({ rowFails: true }); res = fakeRes();
      await routes.message(req({ query: { source: 'office', id: 'a1' } }), res, deps(who, s));
      assert.equal(res.statusCode, 503);
      assert.ok(!s.calls.some((c) => c[0] === 'open'));
    }
  });
  assert.ok(logs.every((l) => !l.includes('@')));
});

test('CASE_VISIBILITY=assigned: not on the case → 403 "not-assigned" (every route); assigned or admin → in', async () => {
  await withEnv({ CASE_VISIBILITY: 'assigned' }, async () => {
    const other = { ...STAFF, id: '99', email: 'staff.two@tdotimm.com' };
    for (const h of [routes.list, routes.message, routes.attachment]) {
      const s = fakeService(); const res = fakeRes();
      await h(req({ query: { source: 'office', id: 'a1', att: 'A' } }), res, deps(other, s));
      assert.equal(res.statusCode, 403); assert.equal(res.body.reason, 'not-assigned');
      assert.ok(!s.calls.some((c) => ['list', 'open', 'att'].includes(c[0])));
    }
    let res = fakeRes(); await routes.list(req(), res, deps(STAFF, fakeService()));
    assert.equal(res.statusCode, 200);
    res = fakeRes(); await routes.list(req(), res, deps(BOSS, fakeService({ row: { assignees: { personIds: [], teamIds: [] } } })));
    assert.equal(res.statusCode, 200);
  });
});

/* ══ the list ═════════════════════════════════════════════════════════════════ */

test('list: the service\'s answer for this viewer (the keys never leave the server); a partial source is answered as it is — never turned into an empty list; refresh passed through', async () => {
  const partial = { caseRef: '2026-SPE-016', complete: false, sources: { office: { ok: false, failed: [{ part: 'office mail search', status: 503, code: 'X', hint: 'h' }] }, old: { ok: true } }, keys: { addresses: [], banners: [] }, counts: { shown: 1 }, items: [{ id: 'a1' }], _keys: { addresses: ['x@example.org'] } };
  const s = fakeService({ list: partial }); const res = fakeRes();
  await routes.list(req({ query: { refresh: '1' } }), res, deps(STAFF, s));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.complete, false); assert.deepEqual(res.body.items, [{ id: 'a1' }]);
  assert.equal(res.body._keys, undefined);
  assert.deepEqual(s.calls.find((c) => c[0] === 'list')[1], { itemId: '900', caseRef: '2026-SPE-016', row: ROW, refresh: true });
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  // the build failing → 503 (never an empty 200), logged by status + code only
  const err = Object.assign(new Error('boom asha@example.org'), { response: { status: 500, data: { error: { code: 'ErrorInternal', message: 'participants:asha@example.org' } } } });
  const logs = await quiet(async () => {
    const r2 = fakeRes(); await routes.list(req(), r2, deps(STAFF, fakeService({ listFails: err })));
    assert.equal(r2.statusCode, 503); assert.equal(r2.body.ok, false);
  });
  assert.deepEqual(logs, ['[CaseEmails] 2026-SPE-016: the email list failed (500 ErrorInternal)']);
});

/* ══ one email ════════════════════════════════════════════════════════════════ */

test('message: only { source: office|old, id: safe characters } — anything else 400 after the access check; the service re-matches (not on this case → 404); the open is logged with the staff email + a hash only', async () => {
  for (const q of [{}, { source: 'office' }, { source: 'S', id: 'a1' }, { source: 'office', id: 'a/../b' }, { source: 'office', id: 'a1 ' + 'x'.repeat(600) }, { source: ['office', 'old'], id: 'a1' }]) {
    const s = fakeService(); const res = fakeRes();
    await routes.message(req({ query: q }), res, deps(STAFF, s));
    assert.equal(res.statusCode, 400, JSON.stringify(q));
    assert.ok(s.calls.some((c) => c[0] === 'row'), 'the access check runs first');
    assert.ok(!s.calls.some((c) => c[0] === 'open'));
  }
  let s = fakeService({ openFails: Object.assign(new Error('x'), { notFound: true, why: 'other-record' }) }); let res = fakeRes();
  await routes.message(req({ query: { source: 'office', id: 'a3' } }), res, deps(STAFF, s));
  assert.equal(res.statusCode, 404); assert.match(res.body.error, /not on this case any more/);
  const logs = await quiet(async () => {
    s = fakeService(); res = fakeRes();
    await routes.message(req({ query: { source: 'old', id: 'AAMk-1_x=' } }), res, deps(STAFF, s));
    assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true); assert.equal(res.body.imidHash, undefined);
    assert.deepEqual(s.calls.find((c) => c[0] === 'open')[1], { itemId: '900', caseRef: '2026-SPE-016', row: ROW, source: 'old', id: 'AAMk-1_x=', viewer: { userId: '42', teamIds: [], email: STAFF.email, name: STAFF.name, isAdmin: false } });
    const r3 = fakeRes();
    await routes.message(req({ query: { source: 'office', id: 'a1' } }), r3, deps(STAFF, fakeService({ openFails: Object.assign(new Error('timeout of 10000ms exceeded for asha@example.org'), { code: 'ECONNABORTED' }) })));
    assert.equal(r3.statusCode, 503);
  });
  assert.deepEqual(logs, ['[CaseEmails] 2026-SPE-016: email opened by staff.one@tdotimm.com (msg abcdef0123)', '[CaseEmails] 2026-SPE-016: opening an email failed (no answer no-answer)']);
});

/* ══ one attachment ═══════════════════════════════════════════════════════════ */

test('attachment: always a download — octet-stream, attachment, nosniff, a sandbox CSP, private no-store — streamed; a non-Latin name is RFC 5987-safe', async () => {
  for (const name of ['passport.pdf', 'جواز السفر.pdf', 'Résumé "final".docx']) {
    const s = fakeService({ att: { stream: Readable.from([Buffer.from('%PDF-1.4 data')]), name, size: 13, imidHash: 'abcdef0123' } });
    const res = streamRes();
    const logs = await quiet(async () => {
      await routes.attachment(req({ query: { source: 'office', id: 'a1', att: 'AT-1' } }), res, deps(STAFF, s));
      await new Promise((r) => res.on('finish', r));
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'");
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['content-disposition'], require('content-disposition')(name));
    assert.match(res.headers['content-disposition'], /^attachment; filename="/);
    if (/[^\x00-\xff]/.test(name)) assert.match(res.headers['content-disposition'], /; filename\*=UTF-8''%D8%AC/, 'the Arabic name rides in filename* (RFC 5987)');
    assert.equal(Buffer.concat(res.chunks).toString(), '%PDF-1.4 data');
    assert.deepEqual(logs, ['[CaseEmails] 2026-SPE-016: attachment downloaded by staff.one@tdotimm.com (msg abcdef0123)'], 'never the file name');
    assert.deepEqual(s.calls.find((c) => c[0] === 'att')[1].att, 'AT-1');
  }
});

test('attachment: refused types / links / too large answer their status with words; gone → 404 "reopen"; a bad att id → 400; the stream breaking ends the response', async () => {
  let res = fakeRes();
  await routes.attachment(req({ query: { source: 'office', id: 'a1', att: 'AT-2' } }), res, deps(STAFF, fakeService({ att: { refused: { status: 415, error: 'This file type can\'t be downloaded here — open it in Outlook.' } } })));
  assert.equal(res.statusCode, 415); assert.match(res.body.error, /open it in Outlook/);
  res = fakeRes();
  await routes.attachment(req({ query: { source: 'office', id: 'a1', att: 'AT-9' } }), res, deps(STAFF, fakeService({ attFails: Object.assign(new Error('x'), { notFound: true }) })));
  assert.equal(res.statusCode, 404); assert.match(res.body.error, /reopen the email/);
  res = fakeRes();
  const s = fakeService();
  await routes.attachment(req({ query: { source: 'office', id: 'a1', att: '../../x' } }), res, deps(STAFF, s));
  assert.equal(res.statusCode, 400); assert.ok(!s.calls.some((c) => c[0] === 'att'));
  // a stream that fails half-way: the response is destroyed, never left hanging
  const bad = new Readable({ read() { this.destroy(new Error('socket hang up')); } });
  const w = streamRes(); let destroyed = false; const d = w.destroy.bind(w); w.destroy = (e) => { destroyed = true; return d(e); };
  await quiet(async () => {
    await routes.attachment(req({ query: { source: 'office', id: 'a1', att: 'AT-1' } }), w, deps(STAFF, fakeService({ att: { stream: bad, name: 'a.pdf', size: 1, imidHash: 'x' } })));
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(destroyed, true);
});

/* ══ wiring ═══════════════════════════════════════════════════════════════════ */

test('server.js: three GET routes outside /api with tryStaffAuth handed in; no other /admin/case-emails route (nothing collides with :caseRef)', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  for (const line of [
    "app.get('/admin/case-emails/:caseRef/message', (req, res) => require('./routes/caseEmailsRoutes').message(req, res, { staff: tryStaffAuth }));",
    "app.get('/admin/case-emails/:caseRef/attachment', (req, res) => require('./routes/caseEmailsRoutes').attachment(req, res, { staff: tryStaffAuth }));",
    "app.get('/admin/case-emails/:caseRef', (req, res) => require('./routes/caseEmailsRoutes').list(req, res, { staff: tryStaffAuth }));",
  ]) assert.ok(src.includes(line), line);
  assert.equal((src.match(/'\/admin\/case-emails/g) || []).length, 3);
  assert.ok(!/app\.(post|put|patch|delete)\('\/admin\/case-emails/.test(src), 'read-only: no write route');
  // the route modules never sign anything with the staff session secret (critique #1)
  for (const f of ['../src/routes/caseEmailsRoutes.js', '../src/services/caseEmailsService.js', '../src/services/caseEmailsRules.js']) {
    const t = fs.readFileSync(require.resolve(f), 'utf8');
    assert.ok(!/STAFF_SESSION_SECRET|jsonwebtoken|jwt\.sign/.test(t), f);
    assert.ok(!/req\.(body|query)\.(box|mailbox|user)/.test(t), f + ': the mailbox never comes from the request');
  }
});
