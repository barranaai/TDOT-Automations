'use strict';

// Leads search by name, phone or email (Faran 2026-11-09, step 3 decision 1).
// The phone and email stay on the server: the page POSTs the text and gets back
// lead ids only. Matching is the old-client matcher's (oldClientDirectory).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const dir        = require('../src/services/oldClientDirectory');
const snap       = require('../src/services/leadSnapshot');
const leadSearch = require('../src/services/leadSearch');
const mondayApi  = require('../src/services/mondayApi');
const { listCore, listTableUi } = require('../src/routes/listFilters');
const LTF = require('../src/routes/leadsTableFilters');
const S   = require('../src/routes/listSpecs');
const C   = require('../src/data/newLeadsBoard.json').columns;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function quiet() { const l = console.log, w = console.warn, e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {}; return () => { console.log = l; console.warn = w; console.error = e; }; }

test('matchPeople returns every hit (no cap of 10); searchPeople output is unchanged', () => {
  const people = Array.from({ length: 15 }, (_, i) => dir.buildIndexEntry({ id: i + 1, name: 'Asha Rao ' + i, phone: '', email: '' }));
  const m = dir.matchPeople(people, 'asha');
  assert.equal(m.mode, 'name');
  assert.equal(m.hits.length, 15);
  const old = dir.searchPeople(people, 'asha');
  assert.equal(old.results.length, dir.MAX_RESULTS);
  assert.equal(old.more, true);
  assert.deepEqual(dir.searchPeople(people, 'a'), { results: [], more: false, mode: 'short' });
});

function rows() {
  return [
    { id: '11', fullName: 'Asha Rao', phone: '+1 416-555-0101', email: 'Asha.Rao@Example.com' },
    { id: '12', fullName: 'Bo Li', phone: '14165550199', email: '' },
    { id: '13', fullName: 'Rao Asha Devi', phone: '', email: 'devi@x.ca' },
    { id: '14', fullName: "Maria D'Souza", phone: '905 555 0123', email: 'm@d.com' },
  ];
}
/** The snapshot read with Monday stubbed: the real fetchLeads (so the email/phone stripping is exercised). */
async function withSnapshot(fn) {
  snap._reset();
  const items = rows().map((r) => ({ id: r.id, name: r.fullName, created_at: '2026-11-01T10:00:00Z', column_values: [
    { id: C.fullName, text: r.fullName, value: JSON.stringify(r.fullName) },
    { id: C.phone, text: r.phone, value: r.phone ? JSON.stringify({ phone: r.phone }) : null },
    { id: C.email, text: r.email, value: r.email ? JSON.stringify({ email: r.email, text: r.email }) : null },
  ] }));
  const r = [quiet(), stub(mondayApi, 'query', async () => ({ boards: [{ items_page: { cursor: null, items } }] }))];
  try { return await fn(); } finally { r.forEach((x) => x()); snap._reset(); }
}

test('the snapshot never carries a phone or email on a lead (JSON, keys, spread) — only the server index has them', async () => {
  await withSnapshot(async () => {
    const leads = await snap.leads();
    assert.equal(leads.length, 4);
    for (const l of leads) {
      assert.ok(!('email' in l) && !('phone' in l), 'no email / phone keys');
      const j = JSON.stringify(l) + JSON.stringify({ ...l });
      assert.ok(!/@/.test(j), 'no email in JSON');
      assert.ok(!/555/.test(j), 'no phone in JSON');
    }
    assert.equal(leads[0].hasEmail, true);
    assert.equal(leads[1].hasEmail, false);
    const { index } = await snap.contactIndex();
    assert.equal(index.length, 4);
    assert.deepEqual(index.map((x) => x.id), ['11', '12', '13', '14'], 'one entry per lead row');
  });
});

test('leadSearch: email any case, phone on the last 10 with +1 / a leading 1, name words in any order; ids only', async () => {
  await withSnapshot(async () => {
    assert.deepEqual(await leadSearch.search('ASHA.RAO@example'), { ok: true, mode: 'email', ids: ['11'] });
    assert.deepEqual((await leadSearch.search('4165550101')).ids, ['11']);
    assert.deepEqual((await leadSearch.search('+1 416 555 0199')).ids, ['12']);
    assert.deepEqual((await leadSearch.search('1-416-555-0101')).ids, ['11']);
    assert.deepEqual((await leadSearch.search('0123')).ids, ['14']);
    assert.deepEqual((await leadSearch.search('rao asha')).ids.sort(), ['11', '13']);
    assert.deepEqual((await leadSearch.search('dsouza')).ids, ['14']);
    assert.deepEqual(await leadSearch.search('a'), { ok: true, mode: 'short', ids: [] });
    assert.deepEqual((await leadSearch.search('nobody@nowhere')).ids, []);
  });
});

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('the route: no-store, answers only ok/mode/ids (no phone, no email), 429 over the limit, never logs the text', async () => {
  await withSnapshot(async () => {
    const h = leadSearch.httpHandler(leadSearch.rateLimiter({ max: 2, windowMs: 60000 }));
    const logs = [];
    const r = [stub(console, 'log', (...a) => logs.push(a.join(' '))), stub(console, 'warn', (...a) => logs.push(a.join(' '))), stub(console, 'error', (...a) => logs.push(a.join(' ')))];
    try {
      let res = fakeRes();
      await h({ ip: '1.1.1.1', body: { q: 'asha.rao@example.com' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Cache-Control'], 'private, no-store');
      assert.deepEqual(Object.keys(res.body).sort(), ['ids', 'mode', 'ok']);
      assert.deepEqual(res.body.ids, ['11']);
      assert.ok(!/@|example/i.test(JSON.stringify(res.body)));
      res = fakeRes();
      await h({ ip: '1.1.1.1', body: { q: '4165550101' } }, res);
      assert.ok(!/555|0101/.test(JSON.stringify(res.body)));
      res = fakeRes();
      await h({ ip: '1.1.1.1', body: { q: 'asha' } }, res);
      assert.equal(res.statusCode, 429);
      res = fakeRes();
      await h({ ip: '2.2.2.2', body: { q: 'asha' } }, res);
      assert.equal(res.statusCode, 200, 'the limit is per IP');
      // a failure answers 503 and does not log the search text
      const r2 = stub(leadSearch.io, 'contactIndex', async () => { throw new Error('Monday down'); });
      try {
        res = fakeRes();
        await h({ ip: '3.3.3.3', body: { q: 'secret@mail.com' } }, res);
        assert.equal(res.statusCode, 503);
      } finally { r2(); }
      assert.ok(!logs.some((l) => /secret@mail|asha\.rao|4165550101/.test(l)), 'the text is never logged');
    } finally { r.forEach((x) => x()); }
  });
});

test('the route sits behind the team key (/api) and takes a small JSON body', () => {
  const SERVER = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const gate = SERVER.indexOf("app.use('/api', requireApiKey);");
  const route = SERVER.indexOf("app.post('/api/leads/search', express.json({ limit: '2kb' }), require('./services/leadSearch').httpHandler());");
  assert.ok(gate > 0 && route > gate);
});

test('the list engine: a server answer filters to its ids; an answer for older text is ignored; without one, name-contains', () => {
  const LT = LTF.leadsTableCore();
  const R = [{ id: '1', name: 'Asha Rao' }, { id: '2', name: 'Bo Li' }, { id: '3', name: 'Chen Wu' }];
  const st = (q) => Object.assign(LT.emptyState(), { q });
  assert.deepEqual(LT.filterRows(R, st('4165')).map((r) => r.id), [], 'no answer yet: name-contains (digits match no name)');
  LT.setServerHits('4165', ['2', '3']);
  assert.deepEqual(LT.filterRows(R, st('4165')).map((r) => r.id), ['2', '3']);
  assert.deepEqual(LT.filterRows(R, st('asha')).map((r) => r.id), ['1'], 'another text: the answer does not apply');
  LT.setServerHits('', null);
  assert.deepEqual(LT.filterRows(R, st('4165')).map((r) => r.id), []);
  assert.equal(LT.chips(st('bo'))[0].text, 'Search “bo”');
  const saved = JSON.parse(JSON.stringify(st('x')));
  assert.ok(!('serverHit' in saved), 'the answer is never saved with the filters');
});

test('the three lists use the server search; the boxes say name, phone or email', () => {
  assert.equal(LTF.leadsTableOpts().serverSearch, '/api/leads/search');
  assert.equal(S.consultListOpts({}).serverSearch, '/api/leads/search');
  assert.equal(S.retainerListOpts({ outcomes: [] }).serverSearch, '/api/leads/search');
  assert.equal(S.consultListSpec({ today: () => '' }).search.id({ id: 7 }), 7);
  assert.equal(S.retainerListSpec({ outcomes: [], today: () => '' }).search.id({ id: 8 }), 8);
  assert.ok(LTF.leadsTableScript().includes("serverSearch: '/api/leads/search'"));
  const L = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  const A = require('../src/routes/adminConsultation');
  for (const h of [L, A.buildQueueHTML(), A.buildRetainersHTML()]) assert.ok(h.includes('placeholder="Search by name, phone or email…"'));
});

/** The browser part, with a stub window: debounced POST, stale answers dropped, failure → names only + a note. */
async function runUi(answers) {
  const els = {};
  const el = (tag) => {
    const e = { tag, value: '', textContent: '', style: {}, _l: {}, setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } },
      appendChild() {}, addEventListener(t, f) { (e._l[t] = e._l[t] || []).push(f); }, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, focus() {} };
    return e;
  };
  const box = el('div'); const tb = el('div');
  box.parentNode = tb; tb.insertBefore = (n) => { els.note = n; };
  const search = el('input'); search.parentNode = box; els['rq-search'] = search;
  const posts = []; const timers = [];
  let shown = null;
  const win = { document: { getElementById: (id) => els[id] || null, createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
    sessionStorage: { getItem: (k) => (k === 'tdot_admin_key' ? 'K' : null), setItem() {} }, addEventListener() {}, location: { search: '' },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
    fetch: (url, opt) => { posts.push({ url, opt }); const a = answers.shift(); return a instanceof Error ? Promise.reject(a) : Promise.resolve({ status: a.status || 200, json: async () => a.body }); },
    renderRetainerList: (rs) => { shown = rs.map((r) => r.id); } };
  const o = S.retainerListOpts({ outcomes: ['Retain'], onChange() {} });
  const api = listTableUi(listCore(S.retainerListSpec({ outcomes: ['Retain'], today: () => '' })), o, win) || win[o.api];
  api.setRows([{ id: '1', name: 'Asha', outcomeGroup: 'Retain' }, { id: '2', name: 'Bo', outcomeGroup: 'Retain' }]);
  const type = (v) => { search.value = v; search._l.input.forEach((f) => f()); };
  const flush = () => new Promise((r) => setImmediate(r));
  return { type, posts, timers, flush, shown: () => shown, note: () => els.note };
}

test('the browser: POSTs the text (never in the URL) with the key, filters to the ids, drops an older answer, falls back on failure', async () => {
  const u = await runUi([{ body: { ok: true, mode: 'phone', ids: ['1'] } }, { body: { ok: true, mode: 'phone', ids: ['2'] } }]);
  u.type('4165'); u.type('41655');
  assert.equal(u.timers.length, 2);
  u.timers[0](); u.timers[1]();   // the first answer arrives after the second request was sent
  await u.flush(); await u.flush();
  assert.equal(u.posts[0].url, '/api/leads/search');
  assert.equal(u.posts[0].opt.method, 'POST');
  assert.equal(u.posts[0].opt.headers['X-Api-Key'], 'K');
  assert.deepEqual(JSON.parse(u.posts[1].opt.body), { q: '41655' });
  assert.deepEqual(u.shown(), ['2'], 'only the latest answer counts');

  const f = await runUi([new Error('offline')]);
  f.type('Bo'); f.timers[0](); await f.flush(); await f.flush();
  assert.deepEqual(f.shown(), ['2'], 'names only');
  assert.equal(f.note().textContent, 'Phone and email search is not available right now — searching names only.');
});
