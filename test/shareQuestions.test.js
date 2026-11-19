'use strict';

// Gauri's 19 questions at a private no-sign-in link (Faran 2026-11-19): the form, its two answer calls and the
// named-admin read — against a FAKE OneDrive file. A wrong token is the ordinary 404 on all three public routes;
// only the token's hash is in the code; the page is a complete document whose one inline script runs by its hash;
// the page's questions equal the server's ONE list; validation, write limits, eTag conflict retry, storage
// failure → 503 with nothing lost, the admin gate, no note text or token in any log, and no page links to it.
// Offline (the no-network guard backs it). The token and every answer here are invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const svc = require('../src/services/shareQuestionsService');
const list = require('../src/share/questionsList');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A made-up token: the real one is not in the repo, so tests run their own instance on this one's hash.
const TOKEN = 'made-up-token-for-tests-0001';
const BASE = `/share/questions/${TOKEN}`;
const SPEC_IDS = ['G1', 'H1', 'H2', 'H3', 'H4', 'A1', 'B1', 'B2', 'B3', 'B4', 'B5', 'F1', 'F2', 'F3', 'F4', 'D1', 'R1', 'R2', 'O1'];
const WRONG_TOKENS = [undefined, '', 'x', 'questions', 'A'.repeat(24), '../../etc/passwd', 'a b c d e f g h i j k l', 'Z'.repeat(200), `${TOKEN}x`, TOKEN.slice(0, -1)];

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, kind: '', sent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (a, b) => { if (typeof a === 'string') r.headers[a] = b; else Object.assign(r.headers, a); return r; };
  r.type = (t) => { r.kind = t; return r; };
  r.send = (b) => { r.body = b; r.sent = true; return r; };
  r.json = (b) => { r.body = b; r.kind = 'json'; r.sent = true; return r; };
  return r;
}

/** A PUT request as Express hands it over (the global JSON parser has run). */
function putReq(qid, body, opts = {}) {
  const { ip = '203.0.113.7', type = 'application/json', raw } = opts;
  const token = 'token' in opts ? opts.token : TOKEN;      // an explicit undefined stays undefined
  const text = raw !== undefined ? raw : JSON.stringify(body);
  return { method: 'PUT', params: { token, qid }, headers: { 'content-type': type, 'x-forwarded-for': `10.9.9.9, ${ip}`, 'content-length': String(Buffer.byteLength(text)) },
    body, rawBody: Buffer.from(text), query: {} };
}
const getReq = (opts = {}) => ({ method: 'GET', params: { token: 'token' in opts ? opts.token : TOKEN }, headers: {}, query: {} });

/**
 * The harness: a fake OneDrive file with eTags (a write over an old eTag, or a create over an existing file,
 * is a conflict), a clock, the log lines, and one service instance on the made-up token.
 */
function harness({ file = null, limits } = {}) {
  const h = { file: file ? { data: JSON.parse(JSON.stringify(file)), etag: 'e0' } : null, reads: 0, writes: 0, tried: 0, inFlight: 0, maxInFlight: 0, logs: [],
    clock: { t: Date.parse('2026-11-19T15:00:00.000Z') }, failRead: null, failWrite: null, beforeWrite: null, delay: 0, n: 0 };
  const io = {
    now: () => h.clock.t,
    read: async () => {
      h.inFlight++; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      try {
        if (h.delay) await new Promise((r) => setTimeout(r, h.delay));
        h.reads++;
        if (h.failRead) throw h.failRead;
        return h.file ? { data: JSON.parse(JSON.stringify(h.file.data)), etag: h.file.etag } : null;
      } finally { h.inFlight--; }
    },
    write: async (data, etag) => {
      h.inFlight++; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      try {
        if (h.delay) await new Promise((r) => setTimeout(r, h.delay));
        h.tried++;
        if (h.beforeWrite) h.beforeWrite(h);
        if (h.failWrite) throw h.failWrite;
        if ((h.file ? h.file.etag : '') !== etag) throw Object.assign(new Error('changed meanwhile'), { conflict: true });
        h.file = { data: JSON.parse(JSON.stringify(data)), etag: `e${++h.n}` };
        h.writes++;
        return { etag: h.file.etag, created: !etag };
      } finally { h.inFlight--; }
    },
    log: (l) => h.logs.push(String(l)),
    warn: (l) => h.logs.push(String(l)),
  };
  h.svc = svc.create({ tokenSha256: sha256hex(TOKEN), io, ...(limits ? { limits } : {}) });
  h.put = async (qid, body, opts) => { const res = fakeRes(); let nexted = 0; await h.svc.putAnswer(putReq(qid, body, opts), res, () => { nexted++; }); res.nexted = nexted; return res; };
  h.get = async (opts) => { const res = fakeRes(); let nexted = 0; await h.svc.getAnswers(getReq(opts), res, () => { nexted++; }); res.nexted = nexted; return res; };
  /** Another writer (a second server instance) changes the file. */
  h.other = (qid, choice, note = '') => {
    const data = h.file ? h.file.data : { version: 1, answers: {}, history: [] };
    data.answers[qid] = { choice, note, at: '2026-11-19T14:59:00.000Z' };
    h.file = { data, etag: `x${++h.n}` };
  };
  return h;
}

/** GROUPS and QUESTIONS as the page's own inline script declares them. */
function pageLists() {
  const script = /<script>([\s\S]*?)<\/script>/.exec(svc.page())[1];
  const from = script.indexOf('var GROUPS = ['), to = script.indexOf('var TOTAL');
  assert.ok(from > 0 && to > from, 'the page declares GROUPS and QUESTIONS');
  const box = {};
  vm.runInNewContext(`${script.slice(from, to)}\nthis.G = GROUPS; this.Q = QUESTIONS;`, box);
  return { groups: JSON.parse(JSON.stringify(box.G)), questions: JSON.parse(JSON.stringify(box.Q)) };
}

// ─── The token ────────────────────────────────────────────────────────────────

test('a wrong, missing or malformed token falls through to the ordinary 404 on all three public routes, GET and PUT alike', async () => {
  for (const inst of ['live', 'test']) {
    const h = harness();
    const s = inst === 'live' ? svc : h.svc;
    for (const token of inst === 'live' ? [...WRONG_TOKENS, TOKEN] : WRONG_TOKENS) {
      const calls = [
        (res, next) => s.serve({ params: { token } }, res, next),
        (res, next) => s.getAnswers(getReq({ token }), res, next),
        (res, next) => s.putAnswer(putReq('G1', { choice: 'a', note: 'x' }, { token }), res, next),
      ];
      for (const call of calls) {
        const res = fakeRes();
        let nexted = 0;
        await call(res, () => { nexted++; });
        assert.equal(nexted, 1, `${inst} ${String(token)}`);
        assert.equal(res.sent, false, 'nothing sent');
        assert.deepEqual(res.headers, {}, 'no headers on a miss');
        const res2 = fakeRes();
        await call(res2);                                   // without next(): a plain 404
        assert.equal(res2.statusCode, 404);
        assert.equal(res2.body, 'Not found');
      }
    }
    assert.equal(h.reads + h.tried, 0, 'a miss never touches the answers file');
    assert.deepEqual(h.logs, [], 'and logs nothing');
  }
  // a wrong token is refused BEFORE validation and the write limits: an unknown question still reads as a 404
  const h = harness();
  const res = await h.put('NOPE', { choice: 'zz' }, { token: 'B'.repeat(32) });
  assert.equal(res.nexted, 1);
  assert.equal(res.sent, false);
});

test('the token is not in the code: only its SHA-256 is', () => {
  assert.equal(svc.TOKEN_SHA256, '122b22ed0c462a7e8c60de4babb0190499e52aa461f069e9a45050f9e0e12021');
  const src = read('src/services/shareQuestionsService.js');
  assert.ok(!/randomBytes|base64url/.test(src), 'no token generator in the service');
  assert.equal(svc.tokenOk(TOKEN), false, 'the real routes do not open for the test token');
  // nothing in the feature's files hashes to the real token's hash
  for (const f of ['src/services/shareQuestionsService.js', 'src/share/questions.html', 'src/share/questionsList.js', 'src/server.js', 'test/shareQuestions.test.js']) {
    for (const word of read(f).match(/[A-Za-z0-9_-]{16,64}/g) || []) assert.notEqual(sha256hex(word), svc.TOKEN_SHA256, f);
  }
});

// ─── The page ─────────────────────────────────────────────────────────────────

test('the page is a complete document: no Claude storage, kept out of search engines, one inline script', () => {
  const html = svc.page();
  assert.ok(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n'), 'doctype + html + head');
  assert.ok(html.trimEnd().endsWith('</body>\n</html>'), 'closed');
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<title>Questions for Gauri<\/title>/);
  assert.ok(!/claude/i.test(html), 'no window.claude, no Claude meta, no "Open this page in Claude"');
  assert.ok(!html.includes('\r'), 'LF only (the script hash is over these exact bytes)');
  assert.equal((html.match(/<script/gi) || []).length, 1, 'one script');
  assert.match(html, /<script>\n\(function \(\) \{/, 'inline, no src');
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<script>[\s\S]*<\/script>/, '')), 'no inline event handlers (the CSP would block them)');
  // it never spells its own address: the two calls are built from the link's path
  assert.ok(!html.includes('/share/'), 'the page does not name its own path');
  assert.match(html, /var API = location\.pathname\.replace\(\/\\\/\+\$\/, ""\) \+ "\/answers";/);
  assert.equal((html.match(/cache: "no-store"/g) || []).length, 2, 'both calls are no-store');
  assert.equal((html.match(/\bfetch\(/g) || []).length, 2, 'two calls only: load and save');
  assert.ok(!/https?:\/\/(?!fonts\.googleapis\.com)/.test(html), 'no other host anywhere in the page');
  // the statuses, the draft on the device and the copy fallback
  for (const words of ['Answers save automatically', '"Saved"', 'Not saved yet — will try again', 'Not saved — your answer is kept on this device', 'Copy my answers', 'localStorage.setItem(DRAFT_KEY']) {
    assert.ok(html.includes(words), words);
  }
  // no client names, case numbers or addresses
  assert.deepEqual(html.match(/\b20\d\d-[A-Z]{2,5}(?:-[A-Z]{2,5})*-\d{3,}\b/g) || [], [], 'no case numbers');
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(html), 'no email addresses');
});

test('the headers sent with the page: the CSP runs the inline script by its hash, never by unsafe-inline', () => {
  const html = svc.page();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  const h = svc.pageHeaders();
  assert.equal(h['Content-Security-Policy'],
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; "
    + `script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  const scriptSrc = /script-src ([^;]+)/.exec(h['Content-Security-Policy'])[1];
  assert.ok(!scriptSrc.includes('unsafe'), 'no unsafe-inline / unsafe-eval for scripts');
  assert.equal(svc.pageInfo().scriptHash, hash);
  assert.doesNotThrow(() => new vm.Script(script), 'the script parses');
  // the same other headers as the shared checklist
  const checklist = require('../src/services/shareChecklistService').HEADERS;
  for (const k of ['Cache-Control', 'X-Robots-Tag', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options']) assert.equal(h[k], checklist[k], k);
  // served: the right token gets the page with exactly these headers
  const res = fakeRes();
  harness().svc.serve({ params: { token: TOKEN } }, res, () => assert.fail('must not fall through'));
  assert.equal(res.body, html);
  assert.equal(res.kind, 'html');
  assert.deepEqual(res.headers, h);
});

test("the page's questions, options and suggestions are the server's ONE list", () => {
  const { groups, questions } = pageLists();
  assert.deepEqual(svc.IDS, SPEC_IDS, 'the 19 ids, in order');
  assert.equal(svc.QUESTIONS, list.QUESTIONS, 'the service validates against the shared list itself');
  assert.deepEqual(questions.map((q) => ({ id: q.id, title: q.title, sug: q.sug, opts: q.opts })), JSON.parse(JSON.stringify(list.QUESTIONS)));
  // the page numbers the questions group by group: that is the list's own order
  const shown = groups.flatMap((g) => questions.filter((q) => q.group === g.id).map((q) => q.id));
  assert.deepEqual(shown, SPEC_IDS);
  assert.equal(groups.length, 8);
  for (const q of list.QUESTIONS) {
    const keys = q.opts.map((o) => o[0]);
    assert.ok(keys.includes(q.sug), `${q.id}: the suggestion is one of its options`);
    assert.equal(new Set(keys).size, keys.length, `${q.id}: option keys are unique`);
    assert.ok(!keys.includes('other') && !keys.includes(''), `${q.id}: "other" and "" are reserved`);
  }
  assert.ok(svc.page().includes('<b>19 decisions</b>') && svc.page().includes('0 of 19 answered'));
});

// ─── Validation ───────────────────────────────────────────────────────────────

test('validation: a table of refusals — 400 with a short plain message that never repeats the input', async () => {
  const SECRET = 'zebra-crossing-9917';
  const big = 'n'.repeat(4001);
  const rows = [
    // [what, qid, body, opts, message]
    ['unknown question', 'G9', { choice: 'a', note: SECRET }, {}, 'Unknown question.'],
    ['a lower-case id', 'g1', { choice: 'a' }, {}, 'Unknown question.'],
    ['a prototype key as the id', '__proto__', { choice: '' }, {}, 'Unknown question.'],
    ['constructor as the id', 'constructor', { choice: '' }, {}, 'Unknown question.'],
    ["another question's option key", 'F2', { choice: 'c', note: SECRET }, {}, 'Unknown answer.'],          // F2 has a, b only
    ['an option text instead of its key', 'G1', { choice: 'Keep the shared key as it is' }, {}, 'Unknown answer.'],
    ['an upper-case key', 'G1', { choice: 'A' }, {}, 'Unknown answer.'],
    ['a choice that is not text', 'G1', { choice: 1 }, {}, 'Unknown answer.'],
    ['a choice that is null', 'G1', { choice: null }, {}, 'Unknown answer.'],
    ['a choice that is a list', 'G1', { choice: ['a'] }, {}, 'Unknown answer.'],
    ['a note that is not text', 'G1', { choice: 'a', note: { text: SECRET } }, {}, 'The note must be text.'],
    ['a note that is a number', 'G1', { choice: 'a', note: 7 }, {}, 'The note must be text.'],
    ['a note over 4,000 characters', 'G1', { choice: 'a', note: big }, {}, 'The note is too long — keep it under 4,000 characters.'],
    ['a body that is a list', 'G1', [{ choice: 'a' }], {}, 'Send the answer as JSON.'],
    ['no body', 'G1', undefined, { raw: '' }, 'Send the answer as JSON.'],
    ['a form post', 'G1', { choice: 'a' }, { type: 'application/x-www-form-urlencoded' }, 'Send the answer as JSON.'],
    ['plain text', 'G1', { choice: 'a' }, { type: 'text/plain' }, 'Send the answer as JSON.'],
    ['a look-alike content type', 'G1', { choice: 'a' }, { type: 'application/jsonp' }, 'Send the answer as JSON.'],
    ['a body over 16 KB', 'G1', { choice: 'a', note: SECRET, pad: 'p'.repeat(17 * 1024) }, {}, 'That is too long to save.'],
  ];
  const h = harness();
  for (const [what, qid, body, opts, message] of rows) {
    const res = await h.put(qid, body, opts);
    assert.equal(res.statusCode, 400, what);
    assert.deepEqual(res.body, { error: message }, what);
    assert.ok(!JSON.stringify(res.body).includes(SECRET), what);
    assert.equal(res.headers['Cache-Control'], 'no-store', what);
  }
  assert.equal(h.reads + h.tried, 0, 'a refused answer never reaches the file');
  assert.equal(h.file, null);
  assert.deepEqual(h.logs, [], 'and a refusal logs nothing');
  // the body limit is the real byte count when the parser kept it, else the declared length
  const req = putReq('G1', { choice: 'a' });
  delete req.rawBody; req.headers['content-length'] = String(16 * 1024 + 1);
  assert.deepEqual(svc.validate(req), { ok: false, error: 'That is too long to save.' });
  req.headers['content-length'] = 'lots';
  assert.equal(svc.validate(req).ok, false);
});

test('validation: what is accepted, and how a note is cleaned', async () => {
  const h = harness();
  // every option key of every question, plus "other" and "" (cleared)
  for (const q of list.QUESTIONS) {
    for (const choice of [...q.opts.map((o) => o[0]), 'other', '']) {
      const v = svc.validate(putReq(q.id, { choice, note: '' }));
      assert.deepEqual(v, { ok: true, qid: q.id, choice, note: '' }, `${q.id} ${choice}`);
    }
  }
  assert.deepEqual(svc.validate(putReq('G1', {})), { ok: true, qid: 'G1', choice: '', note: '' }, 'both parts may be left out');
  assert.equal(svc.validate(putReq('G1', { choice: 'a' }, { type: 'application/json; charset=utf-8' })).ok, true);
  assert.equal(svc.validate(putReq('G1', { choice: 'a', note: 'n'.repeat(4000) })).note.length, 4000, 'exactly 4,000 is fine');
  // trimmed; line ends → \n; a tab → a space; every other control character dropped
  assert.equal(svc.cleanNote('  first\r\nsecond\rthird\n\tfourth\u0000\u0007\u001b[31m\u007f\u0085 end \n '), 'first\nsecond\nthird\n fourth[31m end');
  assert.equal(svc.cleanNote('\u0000\u0001\u0002'), '');
  assert.equal(svc.cleanNote('Déjà vu — “quoted” 😀'), 'Déjà vu — “quoted” 😀', 'ordinary text is untouched');
  // 4,000 is counted after cleaning
  assert.equal(svc.validate(putReq('G1', { note: `${' '.repeat(50)}${'n'.repeat(4000)}${'\u0000'.repeat(50)}` })).ok, true);
  // an extra field is ignored, never stored
  const res = await h.put('B3', { choice: 'd', note: ' ok\u0000 ', by: 'someone', at: '1999-01-01T00:00:00.000Z' });
  assert.deepEqual(res.body, { ok: true, at: '2026-11-19T15:00:00.000Z' });
  assert.deepEqual(h.file.data.answers.B3, { choice: 'd', note: 'ok', at: '2026-11-19T15:00:00.000Z' });
});

// ─── Storage ──────────────────────────────────────────────────────────────────

test('saving: the first answer creates the file, later ones merge one question each, history keeps the last 200', async () => {
  const h = harness();
  assert.deepEqual((await h.get()).body, { answers: {}, savedAt: null }, 'no file yet: nothing answered');
  let res = await h.put('G1', { choice: 'b', note: 'Mahesh has no seat' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, at: '2026-11-19T15:00:00.000Z' });
  assert.deepEqual(h.file.data, {
    version: 1,
    answers: { G1: { choice: 'b', note: 'Mahesh has no seat', at: '2026-11-19T15:00:00.000Z' } },
    history: [{ qid: 'G1', choice: 'b', noteLen: 18, at: '2026-11-19T15:00:00.000Z' }],
  });
  h.clock.t += 60 * 1000;
  res = await h.put('O1', { choice: 'other', note: '' });
  assert.deepEqual(res.body, { ok: true, at: '2026-11-19T15:01:00.000Z' });
  assert.deepEqual(Object.keys(h.file.data.answers), ['G1', 'O1'], 'the other question is kept');
  assert.equal(h.file.data.history.length, 2);
  assert.ok(!JSON.stringify(h.file.data.history).includes('Mahesh'), 'history holds the note length, never its text');
  // the same answer again: no write, the first time stands
  h.clock.t += 60 * 1000;
  const before = h.writes;
  res = await h.put('G1', { choice: 'b', note: '  Mahesh has no seat  ' });
  assert.deepEqual(res.body, { ok: true, at: '2026-11-19T15:00:00.000Z' });
  assert.equal(h.writes, before, 'nothing to change → nothing written');
  // clearing a question that was never answered writes nothing either
  res = await h.put('F4', { choice: '', note: '   ' });
  assert.equal(res.statusCode, 200);
  assert.equal(h.writes, before);
  assert.ok(!('F4' in h.file.data.answers));
  // clearing an answered one is a real change
  res = await h.put('O1', { choice: '', note: '' });
  assert.deepEqual(h.file.data.answers.O1, { choice: '', note: '', at: '2026-11-19T15:02:00.000Z' });
  // history is capped
  for (let i = 0; i < 205; i++) { h.clock.t += 1000; await h.svc.save('D1', i % 2 ? 'a' : 'b', ''); }
  assert.equal(h.file.data.history.length, svc.HISTORY_MAX);
  assert.equal(h.file.data.history[199].qid, 'D1');
  // what GET hands the page: the 19 known questions only, strings only
  h.file.data.answers.ZZ = { choice: 'a', note: 'not a question', at: 'x' };
  h.file.data.answers.H1 = { choice: 'q', note: 5, at: 7 };            // a key the list does not have, wrong types
  h.file.data.answers.H2 = 'nonsense';
  h.clock.t += svc.CACHE_MS;
  const got = (await h.get()).body;
  assert.deepEqual(Object.keys(got.answers), ['G1', 'H1', 'D1', 'O1']);
  assert.deepEqual(got.answers.H1, { choice: '', note: '', at: '' });
  assert.equal(got.savedAt, got.answers.D1.at);
});

test('GET answers: one OneDrive read per 15 seconds, shared by everyone asking; a save refreshes it at once', async () => {
  const h = harness({ file: { version: 1, answers: { G1: { choice: 'a', note: '', at: '2026-11-18T10:00:00.000Z' } }, history: [] } });
  h.delay = 5;
  const all = await Promise.all([h.get(), h.get(), h.get(), h.get()]);
  for (const res of all) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { answers: { G1: { choice: 'a', note: '', at: '2026-11-18T10:00:00.000Z' } }, savedAt: '2026-11-18T10:00:00.000Z' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow, noarchive');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  }
  assert.equal(h.reads, 1, 'four requests at once → one read');
  h.delay = 0;
  h.clock.t += svc.CACHE_MS - 1;
  await h.get();
  assert.equal(h.reads, 1, 'still the cache');
  h.other('H3', 'a');                                       // changed behind the app's back
  h.clock.t += 1;
  assert.deepEqual(Object.keys((await h.get()).body.answers), ['G1', 'H3'], 'read again after 15 s');
  assert.equal(h.reads, 2);
  // a save shows in the very next GET, without waiting for the cache to age
  await h.put('B1', { choice: 'a', note: '' });
  const reads = h.reads;
  assert.deepEqual(Object.keys((await h.get()).body.answers), ['G1', 'H3', 'B1']);
  assert.equal(h.reads, reads, 'served from the copy the save just wrote');
  assert.ok(svc.CACHE_MS <= 15000);
});

test('an eTag conflict re-reads and retries: the other writer is kept, nothing is lost', async () => {
  const h = harness({ file: { version: 1, answers: { G1: { choice: 'a', note: '', at: '2026-11-18T10:00:00.000Z' } }, history: [] } });
  // between this request's read and its write, another instance saves H4
  let once = true;
  h.beforeWrite = () => { if (once) { once = false; h.other('H4', 'c', 'Melanie'); } };
  const res = await h.put('R2', { choice: 'a', note: 'no Teams' });
  assert.equal(res.statusCode, 200);
  assert.equal(h.tried, 2, 'refused once, written on the retry');
  assert.equal(h.reads, 2, 're-read before the retry');
  assert.deepEqual(Object.keys(h.file.data.answers), ['G1', 'H4', 'R2']);
  assert.equal(h.file.data.answers.H4.note, 'Melanie');
  assert.equal(h.file.data.answers.R2.note, 'no Teams');
  // a first write racing another creator: the create is refused, the retry merges into the new file
  const h2 = harness();
  let first = true;
  h2.beforeWrite = () => { if (first) { first = false; h2.other('A1', 'a'); } };
  assert.equal((await h2.put('B2', { choice: 'a' })).statusCode, 200);
  assert.deepEqual(Object.keys(h2.file.data.answers), ['A1', 'B2']);
  // a conflict every time: the first try plus 3 retries, then 503 — and the file is the other writer's, whole
  const h3 = harness({ file: { version: 1, answers: {}, history: [] } });
  let k = 0;
  h3.beforeWrite = () => { h3.other('F1', k++ % 2 ? 'a' : 'b'); };
  const res3 = await h3.put('F2', { choice: 'a', note: 'secret words' });
  assert.equal(res3.statusCode, 503);
  assert.deepEqual(res3.body, { error: 'Could not save right now — please try again.' });
  assert.equal(h3.tried, 1 + svc.CONFLICT_RETRIES);
  assert.equal(svc.CONFLICT_RETRIES, 3);
  assert.deepEqual(Object.keys(h3.file.data.answers), ['F1'], 'no partial write');
  assert.equal(h3.writes, 0);
});

test('a storage failure is a 503: the file is untouched, nothing half-written, and the unsaved answer is never shown as saved', async () => {
  const start = { version: 1, answers: { G1: { choice: 'a', note: 'kept', at: '2026-11-18T10:00:00.000Z' } }, history: [{ qid: 'G1', choice: 'a', noteLen: 4, at: '2026-11-18T10:00:00.000Z' }] };
  const boom = () => Object.assign(new Error('OneDrive JSON write failed: {"error":{"code":"serviceNotAvailable","message":"try later"}}'), { transient: true });
  // the write fails
  let h = harness({ file: start });
  await h.get();                                             // the cache holds the stored answers
  h.failWrite = boom();
  let res = await h.put('G1', { choice: 'c', note: 'changed my mind' });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Could not save right now — please try again.' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(h.file.data, start, 'the file is exactly as it was');
  assert.equal(h.tried, 1, 'a failure that is not a conflict is not retried by the server (the page retries)');
  h.failWrite = null;
  assert.deepEqual((await h.get()).body.answers.G1, start.answers.G1, 'GET still shows the stored answer');
  // the page's retry then lands, once
  res = await h.put('G1', { choice: 'c', note: 'changed my mind' });
  assert.equal(res.statusCode, 200);
  assert.equal(h.file.data.answers.G1.choice, 'c');
  assert.equal(h.file.data.history.length, 2);

  // the read fails: PUT and GET both 503, nothing written
  h = harness({ file: start });
  h.failRead = new Error('OneDrive JSON read failed: timeout of 15000ms exceeded');
  assert.equal((await h.put('H1', { choice: 'a' })).statusCode, 503);
  assert.equal(h.tried, 0);
  res = await h.get();
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Could not load the saved answers right now — please try again.' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  // a failed read is not asked again for a few seconds, then it is
  const reads = h.reads;
  assert.equal((await h.get()).statusCode, 503);
  assert.equal(h.reads, reads, 'no second read inside the short window');
  h.failRead = null;
  h.clock.t += svc.FAIL_MS;
  assert.equal((await h.get()).statusCode, 200);
  assert.deepEqual(h.file.data, start);

  // a damaged file, or one with a shape this code does not know, is NEVER written over
  for (const bad of [
    { failRead: Object.assign(new Error('TDOT System/x.json is not a JSON object'), { corrupt: true }) },
    { file: { version: 2, answers: {}, history: [] } },
    { file: { version: 1, answers: [], history: [] } },
    { file: { version: 1, history: [] } },
    { file: { version: 1, answers: {}, history: 'none' } },
    { file: { somethingElse: true } },
  ]) {
    h = harness({ file: bad.file || start });
    if (bad.failRead) h.failRead = bad.failRead;
    const kept = JSON.stringify(h.file.data);
    assert.equal((await h.put('H1', { choice: 'a' })).statusCode, 503);
    assert.equal((await h.get()).statusCode, 503);
    assert.equal(h.tried, 0, 'no write attempted');
    assert.equal(JSON.stringify(h.file.data), kept);
  }
});

test('writes are serialised in-process: many at once, one OneDrive call at a time, every answer kept', async () => {
  const h = harness();
  h.delay = 2;
  const ids = SPEC_IDS.slice(0, 12);
  const out = await Promise.all([...ids.map((id, i) => h.put(id, { choice: 'a', note: `n${i}` }, { ip: `198.51.100.${i}` })), h.get(), h.get()]);
  for (const res of out) assert.equal(res.statusCode, 200);
  assert.equal(h.maxInFlight, 1, 'never two OneDrive calls in flight');
  assert.deepEqual(Object.keys(h.file.data.answers).sort(), [...ids].sort());
  assert.equal(h.file.data.history.length, 12);
  assert.equal(h.tried, 12, 'no conflicts between its own writes');
  // a failed job does not block the next one
  let nth = 0;
  h.beforeWrite = () => { h.failWrite = nth++ === 0 ? new Error('down') : null; };
  const [a, b] = await Promise.all([h.put('R1', { choice: 'a' }), h.put('R2', { choice: 'a' })]);
  assert.equal(a.statusCode, 503);
  assert.equal(b.statusCode, 200);
  assert.ok('R2' in h.file.data.answers && !('R1' in h.file.data.answers));
});

// ─── Write limits ─────────────────────────────────────────────────────────────

test('write limits: 60 per address per 10 minutes, 600 overall per hour — 429 with Retry-After, counted on the proxy-attested address', async () => {
  assert.deepEqual(svc.LIMITS, { ipMax: 60, ipWindowMs: 10 * 60 * 1000, allMax: 600, allWindowMs: 60 * 60 * 1000 });
  const h = harness();
  const A = '203.0.113.50';
  for (let i = 0; i < 60; i++) {
    h.clock.t += 1000;
    const res = await h.put('G1', { choice: i % 2 ? 'a' : 'b' }, { ip: A });
    assert.equal(res.statusCode, 200, `write ${i + 1}`);
  }
  const writes = h.writes;
  let res = await h.put('G1', { choice: 'c', note: 'one too many' }, { ip: A });
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: 'Too many changes at once — please wait a moment and try again.' });
  assert.equal(res.headers['Retry-After'], String(10 * 60 - 59), 'until the oldest write leaves the window');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(h.writes, writes, 'a limited write never reaches the file');
  // refused requests are not counted, and a refused body is not even validated
  assert.equal((await h.put('NOPE', { choice: 'zz' }, { ip: A })).statusCode, 429);
  // rotating the FIRST X-Forwarded-For entry does not mint a fresh allowance (the last one is the proxy's)
  const spoof = putReq('G1', { choice: 'c' }, { ip: A });
  spoof.headers['x-forwarded-for'] = `1.2.3.4, ${A}`;
  const r2 = fakeRes();
  await h.svc.putAnswer(spoof, r2, () => assert.fail());
  assert.equal(r2.statusCode, 429);
  assert.equal(svc.clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '5.6.7.8');
  assert.equal(svc.clientIp({ headers: {}, ip: '9.9.9.9' }), '9.9.9.9');
  // another address is not affected; reading is not limited
  assert.equal((await h.put('G1', { choice: 'c' }, { ip: '203.0.113.51' })).statusCode, 200);
  assert.equal((await h.get()).statusCode, 200);
  // a refusal (400) still counts as a write attempt
  const h2 = harness({ limits: { ipMax: 3, ipWindowMs: 1000, allMax: 100, allWindowMs: 5000 } });
  for (let i = 0; i < 3; i++) assert.equal((await h2.put('NOPE', {}, { ip: A })).statusCode, 400);
  assert.equal((await h2.put('G1', { choice: 'a' }, { ip: A })).statusCode, 429);
  // the window slides: once the oldest write is 10 minutes old, one more is allowed
  h.clock.t += (10 * 60 - 59) * 1000;
  res = await h.put('G1', { choice: 'a', note: 'later' }, { ip: A });
  assert.equal(res.statusCode, 200);
  assert.equal((await h.put('G1', { choice: 'b' }, { ip: A })).statusCode, 429);

  // overall: 600 an hour across every address
  const g = harness();
  for (let i = 0; i < 600; i++) {
    g.clock.t += 100;
    const wait = g.svc.limiter.take(`198.51.${Math.floor(i / 50)}.${i % 50}`);       // 50 per address: under the per-address limit
    assert.equal(wait, 0, `write ${i + 1}`);
  }
  res = await g.put('G1', { choice: 'a' }, { ip: '192.0.2.1' });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], String(60 * 60 - 60 + 1));
  assert.equal(g.reads + g.tried, 0);
  g.clock.t += 60 * 60 * 1000;
  assert.equal((await g.put('G1', { choice: 'a' }, { ip: '192.0.2.1' })).statusCode, 200);
});

// ─── The admin read ───────────────────────────────────────────────────────────

test('the admin read: named admins only, private no-store, every question with its title and the chosen option in plain words', async () => {
  const h = harness();
  await h.put('G1', { choice: 'b', note: 'Mahesh and Deeksha\nshare one' });
  h.clock.t += 5 * 60 * 1000;
  await h.put('F1', { choice: 'a', note: '' });
  await h.put('D1', { choice: 'other', note: '22 for the firm' });
  await h.put('R2', { choice: '', note: 'will think about it' });
  const deps = (staff) => ({ staff: () => staff, isAdminEmail: (e) => e === 'boss@tdotimm.com' });
  const ask = async (staff, query = {}) => { const res = fakeRes(); await h.svc.adminAnswers({ query, headers: {} }, res, deps(staff)); return res; };

  // the gate: the shared key alone (no Monday sign-in) → 401; signed in but not an admin → 403; the file is not read
  const reads = h.reads;
  let res = await ask(null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.loginUrl, '/q/auth/monday');
  assert.match(res.body.error, /^Sign in with Monday to read the answers to the questions/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  res = await ask({ name: 'Staff Person', email: 'staff@tdotimm.com' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Only admins can read the answers to the questions.');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.ok(!JSON.stringify(res.body).includes('Mahesh'));
  assert.equal(h.reads, reads, 'a refused read never opens the file');

  // a named admin: JSON
  const admin = { name: 'The Boss', email: 'boss@tdotimm.com' };
  res = await ask(admin);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(h.reads, reads + 1, 'always a fresh read, never the 15-second cache');
  const out = res.body;
  assert.equal(out.answered, 3);
  assert.equal(out.total, 19);
  assert.equal(out.withNote, 3);
  assert.equal(out.savedAt, '2026-11-19T15:05:00.000Z');
  assert.deepEqual(out.questions.map((q) => q.id), SPEC_IDS);
  assert.deepEqual(out.questions.map((q) => q.n), SPEC_IDS.map((_, i) => i + 1));
  const by = Object.fromEntries(out.questions.map((q) => [q.id, q]));
  assert.deepEqual(by.G1, { n: 1, id: 'G1', title: 'Should everyone sign in with their own Monday account?', choice: 'b',
    answer: "(b) Keep today's mix, and require Monday sign-in for each new “who did it” action (fee approval, waivers, hand-off)", suggested: true,
    note: 'Mahesh and Deeksha\nshare one', at: '2026-11-19T15:00:00.000Z' });
  assert.equal(by.F1.answer, '(a) You only');
  assert.equal(by.D1.answer, 'Something else (see note)');
  assert.equal(by.D1.suggested, false);
  assert.deepEqual(by.R2, { n: 18, id: 'R2', title: 'How should a red item reach the person?', choice: '', answer: '', suggested: false, note: 'will think about it', at: '2026-11-19T15:05:00.000Z' });
  assert.deepEqual(by.O1, { n: 19, id: 'O1', title: list.QUESTIONS[18].title, choice: '', answer: '', suggested: false, note: '', at: null });

  // ?format=text: the same, as a plain list
  res = await ask(admin, { format: 'Text' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.kind, 'text/plain');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  const text = res.body;
  assert.ok(text.startsWith("Gauri's answers: 3 of 19 answered\nLast saved: "), text.slice(0, 80));
  assert.match(text, /Last saved: Nov\.? 19, 2026, 10:05 a\.m\. \(Toronto\)/);
  assert.ok(text.includes("1. Should everyone sign in with their own Monday account? [G1]\n   Answer: (b) Keep today's mix, and require Monday sign-in for each new “who did it” action (fee approval, waivers, hand-off) (the suggestion)\n   Note: Mahesh and Deeksha\n         share one\n   Saved: "));
  assert.ok(text.includes('16. What is the limit per half-month window? [D1]\n   Answer: Something else (see note)\n   Note: 22 for the firm\n'));
  assert.ok(text.includes('18. How should a red item reach the person? [R2]\n   Answer: (not answered)\n   Note: will think about it\n'));
  assert.ok(text.endsWith('\n\n19. How is the client told the consultation is recorded and transcribed, and what if they say no? [O1]\n   Answer: (not answered)\n'));
  assert.equal((text.match(/^\d+\. /gm) || []).length, 19);
  assert.equal((await ask(admin, { format: 'json' })).statusCode, 200);
  res = await ask(admin, { format: 'csv' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'format must be json or text.' });

  // nothing saved yet
  const empty = harness();
  const r0 = fakeRes();
  await empty.svc.adminAnswers({ query: { format: 'text' }, headers: {} }, r0, deps(admin));
  assert.ok(r0.body.startsWith("Gauri's answers: 0 of 19 answered\nNothing saved yet.\n"));

  // the file cannot be read → 503 in plain words, still private no-store
  h.failRead = new Error('down');
  res = await ask(admin);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'The answers could not be read right now — please try again.' });
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

// ─── The log ──────────────────────────────────────────────────────────────────

test('no note text and no token in any console output: the question id and lengths only', async () => {
  const NOTE = 'Purple-giraffe-4471 says the fee is private';
  const lines = [];
  const con = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  console.log = console.warn = console.error = console.info = console.debug = (...a) => { lines.push(a.map(String).join(' ')); };
  const keep = { read: svc.io.read, write: svc.io.write, now: svc.io.now };
  let file = null, failWrite = null, failRead = null;
  try {
    // the REAL log seam (console), with only the OneDrive file faked
    const inst = svc.create({ tokenSha256: sha256hex(TOKEN), io: svc.io });
    svc.io.read = async () => { if (failRead) throw failRead; return file ? { data: JSON.parse(JSON.stringify(file.data)), etag: file.etag } : null; };
    svc.io.write = async (data, etag) => { if (failWrite) throw failWrite; file = { data, etag: `${etag}+` }; return { etag: file.etag }; };
    const put = async (qid, body, opts) => { const res = fakeRes(); await inst.putAnswer(putReq(qid, body, opts), res, () => assert.fail()); return res; };
    assert.equal((await put('H4', { choice: 'a', note: NOTE })).statusCode, 200);                 // saved
    assert.equal((await put('H4', { choice: 'a', note: NOTE })).statusCode, 200);                 // unchanged
    assert.equal((await put('H4', { choice: 'zz', note: NOTE })).statusCode, 400);                // refused
    assert.equal((await put('NOPE', { choice: 'a', note: NOTE })).statusCode, 400);
    // a storage error whose own text carries the note and the token must not carry them into the log
    failWrite = Object.assign(new Error(`OneDrive JSON write failed: {"error":{"code":"generalException","message":"${NOTE} at ${BASE}"}}`), { transient: true });
    assert.equal((await put('B5', { choice: 'b', note: NOTE })).statusCode, 503);
    failWrite = new Error(`Request failed with status code 507 for ${BASE}`);
    assert.equal((await put('B5', { choice: 'b', note: NOTE })).statusCode, 503);
    failWrite = null;
    failRead = Object.assign(new Error(`${NOTE} ${TOKEN}`), { corrupt: true, raw: NOTE });
    assert.equal((await put('B5', { choice: 'b', note: NOTE })).statusCode, 503);
    const g = fakeRes();
    await inst.getAnswers(getReq(), g, () => assert.fail());
    assert.equal(g.statusCode, 503);
    const a = fakeRes();
    await inst.adminAnswers({ query: {}, headers: {} }, a, { staff: () => ({ email: 'boss@tdotimm.com' }), isAdminEmail: () => true });
    assert.equal(a.statusCode, 503);
    failRead = null;
    // limited
    const tight = svc.create({ tokenSha256: sha256hex(TOKEN), io: svc.io, limits: { ipMax: 1, ipWindowMs: 60000, allMax: 5, allWindowMs: 60000 } });
    const r1 = fakeRes(), r2 = fakeRes();
    await tight.putAnswer(putReq('G1', { choice: 'a', note: NOTE }), r1, () => assert.fail());
    await tight.putAnswer(putReq('G1', { choice: 'b', note: NOTE }), r2, () => assert.fail());
    assert.equal(r2.statusCode, 429);
    // the page itself, and a miss
    inst.serve({ params: { token: TOKEN } }, fakeRes(), () => assert.fail());
    inst.serve({ params: { token: 'nope' } }, fakeRes(), () => {});
  } finally {
    Object.assign(console, con);
    Object.assign(svc.io, keep);
  }
  const all = lines.join('\n');
  assert.ok(!all.includes(TOKEN), 'no token');
  assert.ok(!all.includes('/share/'), 'no link');
  for (const word of ['Purple', 'giraffe', '4471', 'private', 'fee']) assert.ok(!all.includes(word), `no note text (${word})`);
  assert.deepEqual(lines, [
    `[ShareQuestions] H4 saved (choice 1, note ${NOTE.length})`,
    `[ShareQuestions] H4 unchanged (choice 1, note ${NOTE.length})`,
    `[ShareQuestions] B5 NOT saved (temporary generalException; choice 1, note ${NOTE.length})`,
    `[ShareQuestions] B5 NOT saved (HTTP 507; choice 1, note ${NOTE.length})`,
    `[ShareQuestions] B5 NOT saved (damaged file; choice 1, note ${NOTE.length})`,
    '[ShareQuestions] answers could not be read (damaged file)',
    '[ShareQuestions] admin read failed (damaged file)',
    `[ShareQuestions] G1 saved (choice 1, note ${NOTE.length})`,
  ]);
  // the one place the server logs a request path leaves a private link out
  assert.ok(read('src/server.js').includes("console.log(`[Canonical] ${host}${req.path.startsWith('/share/') ? '/share/…' : req.originalUrl} → ${CANONICAL_HOST}`);"));
});

// ─── Never linked ─────────────────────────────────────────────────────────────

test('no page links to the questions (not on the dashboard or anywhere else); the routes are the four in server.js', () => {
  const root = path.join(ROOT, 'src');
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html|json)$/.test(e.name)) continue;
      const rel = path.relative(root, p);
      if (rel === 'server.js' || rel === path.join('services', 'shareQuestionsService.js')) continue;
      if (/\/share\/questions|shareQuestions/.test(fs.readFileSync(p, 'utf8'))) hits.push(rel);
    }
  })(root);
  assert.deepEqual(hits, []);
  const server = read('src/server.js');
  assert.equal((server.match(/\/share\/questions/g) || []).length, 4, 'only the routes themselves');
  assert.ok(server.includes("app.get('/share/questions/:token', (req, res, next) => require('./services/shareQuestionsService').serve(req, res, next));"));
  assert.ok(server.includes("app.get('/share/questions/:token/answers', (req, res, next) => require('./services/shareQuestionsService').getAnswers(req, res, next));"));
  assert.ok(server.includes("app.put('/share/questions/:token/answers/:qid', (req, res, next) => require('./services/shareQuestionsService').putAnswer(req, res, next));"));
  assert.ok(server.includes("app.get('/admin/share/questions/answers', (req, res) => require('./services/shareQuestionsService').adminAnswers(req, res, { staff: tryStaffAuth, isAdminEmail: caseAccess.isAdminEmail }));"));
  // the public three are outside the /api key gate and before nothing that could answer for them
  assert.ok(!/app\.(get|put|post|use)\('\/share'/.test(server), 'no broader /share handler');
  // the answers file sits beside the app's other state file
  assert.equal(svc.STORE_PATH, 'TDOT System/gauri-questions-answers.json');
  const src = read('src/services/shareQuestionsService.js');
  assert.match(src, /read: \(\) => require\('\.\/oneDriveService'\)\.readJsonFile\(STORE_PATH\)/);
  assert.match(src, /write: \(data, etag\) => require\('\.\/oneDriveService'\)\.writeJsonFile\(STORE_PATH, data, \{ etag \}\)/);
});

// ─── The page's own script, run against the real handlers ─────────────────────

/**
 * Runs the page's inline script in a tiny stand-in for the browser (just the calls it makes), with fetch wired
 * straight to a service instance on the fake file. Timers are collected and run by hand.
 */
function browser(h, { drafts, unsaved, online = true } = {}) {
  const els = new Map();
  const made = [];
  const node = (tag) => {
    const e = { tag, attrs: {}, children: [], listeners: {}, style: {}, textContent: '', hidden: false, value: '', checked: false, className: '' };
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); if (k === 'id') els.set(String(v), e); if (k === 'value') e.value = String(v); };
    e.getAttribute = (k) => (k in e.attrs ? e.attrs[k] : null);
    e.removeAttribute = (k) => { delete e.attrs[k]; };
    e.appendChild = (c) => { e.children.push(c); return c; };
    e.addEventListener = (ev, fn) => { (e.listeners[ev] = e.listeners[ev] || []).push(fn); };
    e.fire = (ev) => (e.listeners[ev] || []).forEach((fn) => fn({}));
    e.focus = () => {}; e.select = () => {};
    made.push(e);
    return e;
  };
  for (const id of ['count', 'meter', 'conn', 'notice', 'groups', 'copyBtn', 'copyBox']) { const e = node('div'); e.setAttribute('id', id); }
  els.get('notice').hidden = true;
  const store = {};
  if (drafts) store['gauri-q-drafts-v1'] = JSON.stringify(drafts);
  if (unsaved) store['gauri-q-unsaved-v1'] = JSON.stringify(unsaved);
  const timers = [];
  const calls = [];
  const win = { listeners: {}, addEventListener: (ev, fn) => { win.listeners[ev] = fn; } };
  const doc = { listeners: {}, visibilityState: 'visible' };
  const b = { els, store, timers, calls, win, doc, online, copied: '' };
  const fetchFake = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, cache: opts.cache, credentials: opts.credentials, ...(opts.keepalive ? { keepalive: true } : {}) });
    if (!b.online) throw new TypeError('Failed to fetch');
    const res = fakeRes();
    let nexted = false;
    const m = /^\/share\/questions\/([^/]+)\/answers(?:\/([^/]+))?$/.exec(url);
    assert.ok(m, `the page called ${url}`);
    if (opts.method === 'PUT') {
      assert.equal(opts.headers['Content-Type'], 'application/json');
      await h.svc.putAnswer(putReq(decodeURIComponent(m[2]), JSON.parse(opts.body), { token: m[1], raw: opts.body }), res, () => { nexted = true; });
    } else {
      assert.equal(m[2], undefined);
      await h.svc.getAnswers(getReq({ token: m[1] }), res, () => { nexted = true; });
    }
    const status = nexted ? 404 : res.statusCode;
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (res.headers[k] === undefined ? null : res.headers[k]) }, json: async () => JSON.parse(JSON.stringify(res.body)) };
  };
  const sandbox = {
    window: win,
    document: Object.assign(doc, {
      addEventListener: (ev, fn) => { doc.listeners[ev] = fn; },
      createElement: node,
      createTextNode: (t) => ({ text: t }),
      getElementById: (id) => els.get(id) || null,
      querySelectorAll: (sel) => { const name = /name="([^"]+)"/.exec(sel)[1]; return made.filter((e) => e.tag === 'input' && e.attrs.name === name); },
      activeElement: null,
    }),
    location: { pathname: `${BASE}/` },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    navigator: { clipboard: { writeText: async (t) => { b.copied = t; } } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].fn = null; },
    // a fixed "random" part: a retry waits 1500 × 2^n + 1350 ms, so a test can tell it from the 2-second note pause
    Math: Object.assign(Object.create(Math), { random: () => 0.9 }),
    Promise, JSON, Date, String, Object, Array, Error, parseInt, isNaN, encodeURIComponent,
  };
  if (online !== 'no-fetch') { win.fetch = fetchFake; sandbox.fetch = fetchFake; }
  const script = /<script>([\s\S]*?)<\/script>/.exec(svc.page())[1];
  vm.runInNewContext(script, sandbox);
  b.settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
  /** Run the timers waiting now (optionally only those up to `maxMs`). */
  b.runTimers = async (maxMs = Infinity) => {
    const due = timers.filter((t) => t.fn && t.ms <= maxMs);
    for (const t of due) { const fn = t.fn; t.fn = null; fn(); }
    await b.settle();
  };
  b.pick = async (qid, key) => { const r = els.get(`r-${qid}-${key}`); r.checked = true; r.fire('change'); await b.settle(); };
  b.type = (qid, text) => { const ta = els.get(`n-${qid}`); ta.value = text; ta.fire('input'); };
  b.status = (qid) => els.get(`s-${qid}`).textContent;
  b.text = (id) => els.get(id).textContent;
  b.puts = () => calls.filter((c) => c.method === 'PUT');
  return b;
}

test('the page script: loads the saved answers, saves each change to the server, and keeps a draft on the device', async () => {
  const h = harness({ file: { version: 1, answers: { G1: { choice: 'c', note: 'from before', at: '2026-11-18T10:00:00.000Z' } }, history: [] } });
  const b = browser(h);
  assert.equal(b.text('conn'), 'Loading saved answers…');
  await b.settle();
  assert.equal(b.text('conn'), 'Answers save automatically');
  assert.equal(b.els.get('notice').hidden, true);
  assert.deepEqual(b.calls[0], { url: `${BASE}/answers`, method: 'GET', body: undefined, cache: 'no-store', credentials: 'omit' });
  assert.equal(b.els.get('r-G1-c').checked, true, 'the stored choice is shown');
  assert.equal(b.els.get('n-G1').value, 'from before');
  assert.match(b.status('G1'), /^Saved · /);
  assert.equal(b.text('count'), '1 of 19 answered');
  assert.equal(b.puts().length, 0, 'nothing to send after a plain load');
  assert.equal(b.els.size, 7 + 8 + 19 * 4 + list.QUESTIONS.reduce((n, q) => n + q.opts.length + 1, 0), 'every question, option, note box and status is on the page');

  // a choice saves at once
  await b.pick('F1', 'b');
  assert.deepEqual(b.puts().map((c) => [c.url, c.body, c.cache, c.credentials]), [[`${BASE}/answers/F1`, '{"choice":"b","note":""}', 'no-store', 'omit']]);
  assert.equal(b.status('F1'), 'Saved');
  assert.equal(h.file.data.answers.F1.choice, 'b');
  assert.equal(b.text('count'), '2 of 19 answered');
  assert.equal(b.els.get('meter').style.width, '11%');
  assert.deepEqual(JSON.parse(b.store['gauri-q-drafts-v1']).F1, { choice: 'b', note: '' }, 'the draft is on the device too');
  assert.deepEqual(JSON.parse(b.store['gauri-q-unsaved-v1']), {}, 'and nothing is marked unsaved');

  // "Use the suggestion" picks the suggested option
  b.els.get('use-B3').fire('click');
  await b.settle();
  assert.equal(h.file.data.answers.B3.choice, 'd');
  assert.equal(b.els.get('r-B3-d').checked, true);

  // a note saves after the typing pause, once
  b.type('F1', 'You only');
  b.type('F1', 'You only, please');
  assert.equal(b.status('F1'), 'Typing…');
  assert.equal(b.puts().length, 2);
  assert.ok(JSON.parse(b.store['gauri-q-unsaved-v1']).F1, 'marked unsaved while it waits');
  assert.deepEqual(b.timers.filter((t) => t.fn).map((t) => t.ms), [2000], 'one pause timer, restarted by the second keystroke');
  await b.runTimers(2000);
  assert.equal(b.puts().length, 3, 'one save for the two keystrokes');
  assert.deepEqual(h.file.data.answers.F1, { choice: 'b', note: 'You only, please', at: '2026-11-19T15:00:00.000Z' });
  assert.equal(b.status('F1'), 'Saved');
  // leaving the box sends the note at once, and the pause timer then has nothing left to send
  b.type('H1', 'Asmita and Soniya');
  b.els.get('n-H1').fire('blur');
  await b.settle();
  assert.equal(h.file.data.answers.H1.note, 'Asmita and Soniya');
  assert.equal(b.puts().length, 4);
  await b.runTimers();
  assert.equal(b.puts().length, 4);
  // hiding or leaving the page sends a note that is still waiting, as a request that may outlive the page
  b.type('H2', 'date only');
  b.doc.visibilityState = 'hidden';
  b.doc.listeners.visibilitychange();
  await b.settle();
  assert.equal(h.file.data.answers.H2.note, 'date only');
  assert.equal(b.puts()[4].keepalive, true);
  b.doc.visibilityState = 'visible';
  b.doc.listeners.visibilitychange();
  b.type('H3', 'one payment');
  b.win.listeners.pagehide();
  await b.settle();
  assert.equal(h.file.data.answers.H3.note, 'one payment');
  b.win.listeners.pageshow();
  await b.pick('H4', 'a');
  assert.equal(b.puts()[6].keepalive, undefined, 'an ordinary save is an ordinary request');

  // "Copy my answers" still works from what is on the page
  b.els.get('copyBtn').fire('click');
  await b.settle();
  assert.ok(b.copied.includes('12. Who approves a fee more than $500 below the minimum?\n   Answer: (b) You or Asmita\n   Note: You only, please\n'));
  assert.ok(b.copied.includes('2. Who is on the retainer team, and who may send agreements?\n   Answer: (not answered)\n'));
});

test('the page script: a save that fails is retried and the answer stays on the device, even across a reload', async () => {
  const h = harness({ file: { version: 1, answers: { H2: { choice: 'a', note: '', at: '2026-11-18T10:00:00.000Z' } }, history: [] } });
  const b = browser(h);
  await b.settle();
  // the server cannot save (503): "will try again", and it does
  h.failWrite = new Error('down');
  await b.pick('H2', 'b');
  assert.equal(b.status('H2'), 'Not saved yet — will try again');
  assert.equal(b.els.get('s-H2').attrs['data-state'], 'err');
  assert.equal(h.file.data.answers.H2.choice, 'a');
  assert.deepEqual(JSON.parse(b.store['gauri-q-drafts-v1']).H2, { choice: 'b', note: '' });
  assert.ok(JSON.parse(b.store['gauri-q-unsaved-v1']).H2);
  await b.runTimers();
  assert.equal(b.status('H2'), 'Not saved yet — will try again', 'still failing');
  h.failWrite = null;
  await b.runTimers();
  assert.equal(b.status('H2'), 'Saved');
  assert.equal(h.file.data.answers.H2.choice, 'b');
  assert.deepEqual(JSON.parse(b.store['gauri-q-unsaved-v1']), {});
  // the network is gone: the same
  b.online = false;
  await b.pick('H3', 'a');
  assert.equal(b.status('H3'), 'Not saved yet — will try again');
  assert.deepEqual(b.timers.filter((t) => t.fn).map((t) => t.ms), [2850], 'the retry is waiting: 1500 ms + the random part');
  b.online = true;
  // a note longer than the limit: the page sends its first 4,000 characters
  b.type('H4', 'x'.repeat(4100));
  await b.runTimers(2000);
  assert.equal(h.file.data.answers.H4.note.length, 4000);
  assert.equal(b.els.get('n-H4').attrs.maxlength, '4000', 'and the box itself stops at 4,000');

  // reload while H3 is still unsaved: the device's newer answer wins over the server's older one and is sent
  const drafts = JSON.parse(b.store['gauri-q-drafts-v1']);
  const unsaved = JSON.parse(b.store['gauri-q-unsaved-v1']);
  assert.deepEqual(Object.keys(unsaved), ['H3']);
  const b2 = browser(h, { drafts, unsaved });
  assert.equal(b2.els.get('r-H3-a').checked, true, 'drafts show at once, before the server answers');
  assert.equal(b2.status('H3'), 'Saved on this device');
  await b2.settle();
  assert.equal(h.file.data.answers.H3.choice, 'a', 'the unsaved answer reached the server after the reload');
  assert.equal(b2.status('H3'), 'Saved');
  assert.deepEqual(JSON.parse(b2.store['gauri-q-unsaved-v1']), {});

  // an unsaved leftover that is OLDER than what the server has (answered since, on another device) gives way
  const h3 = harness({ file: { version: 1, answers: { R1: { choice: 'b', note: 'newer, from the laptop', at: '2026-11-19T14:00:00.000Z' } }, history: [] } });
  const b3 = browser(h3, { drafts: { R1: { choice: 'c', note: 'old phone draft' } }, unsaved: { R1: '2026-11-17T09:00:00.000Z' } });
  await b3.settle();
  assert.equal(b3.els.get('r-R1-b').checked, true);
  assert.equal(b3.els.get('n-R1').value, 'newer, from the laptop');
  assert.equal(h3.file.data.answers.R1.choice, 'b', 'the newer saved answer is not overwritten');
  assert.equal(b3.puts().length, 0);
  // an unsaved mark without its draft never sends an empty answer
  const b4 = browser(h3, { drafts: {}, unsaved: { R1: '2026-11-19T14:30:00.000Z' } });
  await b4.settle();
  assert.equal(b4.puts().length, 0);
  assert.equal(h3.file.data.answers.R1.choice, 'b');
});

test('the page script: when the saved answers cannot be loaded it shows the drafts, says so, and tries again', async () => {
  const h = harness({ file: { version: 1, answers: { A1: { choice: 'a', note: '', at: '2026-11-18T10:00:00.000Z' } }, history: [] } });
  h.failRead = new Error('down');
  const b = browser(h, { drafts: { B1: { choice: 'c', note: 'typed on the train' }, junk: 'x', G1: 'not an object' } });
  await b.settle();
  assert.equal(b.text('conn'), "Saved answers can't be reached");
  assert.equal(b.els.get('notice').hidden, false);
  assert.equal(b.text('notice'), 'The saved answers can\'t be reached right now. Your answers are kept on this device; reload later, or use “Copy my answers”.');
  assert.equal(b.els.get('r-B1-c').checked, true, 'the draft is shown');
  assert.equal(b.els.get('n-B1').value, 'typed on the train');
  assert.equal(b.puts().length, 0, 'nothing is pushed before a load has worked');
  // it loads on a later try: the server's answers appear and the device's draft is sent up
  h.failRead = null;
  h.clock.t += svc.FAIL_MS;
  await b.runTimers();
  assert.equal(b.text('conn'), 'Answers save automatically');
  assert.equal(b.els.get('notice').hidden, true);
  assert.equal(b.els.get('r-A1-a').checked, true);
  assert.deepEqual(h.file.data.answers.B1, { choice: 'c', note: 'typed on the train', at: h.file.data.answers.B1.at });
  assert.equal(b.text('count'), '2 of 19 answered');
  // a retired link (the ordinary 404) reads the same as unreachable; the draft stays on the device
  const gone = browser(Object.assign(harness(), { svc: svc.create({ tokenSha256: sha256hex('another-token-entirely-0002'), io: { now: () => 0 } }) }), { drafts: { G1: { choice: 'a', note: '' } } });
  await gone.settle();
  assert.equal(gone.text('conn'), "Saved answers can't be reached");
  assert.equal(gone.els.get('r-G1-a').checked, true);
  assert.equal(gone.puts().length, 0);
  // a browser without fetch: device only, with the copy fallback
  const none = browser(harness(), { online: 'no-fetch' });
  await none.settle();
  assert.equal(none.text('conn'), 'Answers save on this device only');
  await none.pick('G1', 'a');
  assert.equal(none.status('G1'), 'Saved on this device only');
  assert.deepEqual(JSON.parse(none.store['gauri-q-drafts-v1']).G1, { choice: 'a', note: '' });
});

test('the page script: a write limit (429) waits for Retry-After, and a refusal (400) is not retried', async () => {
  const h = harness({ limits: { ipMax: 1, ipWindowMs: 120 * 1000, allMax: 50, allWindowMs: 120 * 1000 } });
  const b = browser(h);
  await b.settle();
  await b.pick('G1', 'a');
  assert.equal(b.status('G1'), 'Saved');
  await b.pick('G1', 'b');
  assert.equal(b.status('G1'), 'Not saved yet — will try again');
  const waiting = b.timers.filter((t) => t.fn);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].ms, 120 * 1000, 'waits as long as the server asked');
  h.clock.t += 120 * 1000;
  await b.runTimers();
  assert.equal(b.status('G1'), 'Saved');
  assert.equal(h.file.data.answers.G1.choice, 'b');

  // a refusal: a draft whose option the server does not have (an old page against a changed list)
  const h2 = harness();
  const b2 = browser(h2, { drafts: { F2: { choice: 'z', note: '' } } });
  await b2.settle();
  assert.equal(b2.puts().length, 1);
  assert.equal(b2.status('F2'), 'Not saved — your answer is kept on this device');
  assert.equal(b2.els.get('s-F2').attrs['data-state'], 'err');
  assert.equal(b2.timers.filter((t) => t.fn).length, 0, 'no retry is waiting');
  assert.equal(h2.file, null);
  assert.deepEqual(JSON.parse(b2.store['gauri-q-drafts-v1']).F2, { choice: 'z', note: '' });
});
