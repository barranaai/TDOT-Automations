'use strict';

// Gauri's questions at a private no-sign-in link (Faran 2026-11-19; five follow-up questions added on the same link
// 2026-11-23, shown first — 24 in all, the 19 earlier ones pinned as she answered them): the form, its two answer calls and the
// named-admin read — against a FAKE OneDrive file. A wrong token is the ordinary 404 on all three public routes;
// only the token's hash is in the code; the page is a complete document whose one inline script runs by its hash;
// the page's questions equal the server's ONE list; validation, write limits, eTag conflict retry, storage
// failure → 503 with nothing lost, the admin gate, no note text or token in any log, and no page links to it.
// The page's own script runs in a stand-in browser against the real handlers: nothing is sent before the saved
// answers are read, a tab shown again reads again, and an unsaved change is never lost to the device's own save.
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
// The five follow-up questions (23 November) come first; the 19 after them are the ones answered on 19 November.
const NEW_IDS = ['B3x', 'A1x', 'B2x', 'F1x', 'O1x'];
const OLD_IDS = ['G1', 'H1', 'H2', 'H3', 'H4', 'A1', 'B1', 'B2', 'B3', 'B4', 'B5', 'F1', 'F2', 'F3', 'F4', 'D1', 'R1', 'R2', 'O1'];
const SPEC_IDS = [...NEW_IDS, ...OLD_IDS];
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

/** GROUPS, QUESTIONS and the one divider heading (EARLIER) as the page's own inline script declares them. */
function pageLists() {
  const script = /<script>([\s\S]*?)<\/script>/.exec(svc.page())[1];
  const from = script.indexOf('var GROUPS = ['), to = script.indexOf('var TOTAL');
  assert.ok(from > 0 && to > from, 'the page declares GROUPS and QUESTIONS');
  const box = {};
  vm.runInNewContext(`${script.slice(from, to)}\nthis.G = GROUPS; this.Q = QUESTIONS; this.E = EARLIER;`, box);
  return { groups: JSON.parse(JSON.stringify(box.G)), questions: JSON.parse(JSON.stringify(box.Q)), earlier: JSON.parse(JSON.stringify(box.E)) };
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
  assert.deepEqual(svc.IDS, SPEC_IDS, 'the 24 ids, in order: the five follow-ups, then the 19');
  assert.equal(svc.IDS.length, 24);
  assert.equal(new Set(svc.IDS).size, 24, 'no id is used twice');
  assert.equal(svc.QUESTIONS, list.QUESTIONS, 'the service validates against the shared list itself');
  assert.deepEqual(questions.map((q) => ({ id: q.id, title: q.title, sug: q.sug, opts: q.opts })), JSON.parse(JSON.stringify(list.QUESTIONS)));
  // the page numbers the questions group by group: that is the list's own order
  const shown = groups.flatMap((g) => questions.filter((q) => q.group === g.id).map((q) => q.id));
  assert.deepEqual(shown, SPEC_IDS);
  assert.equal(groups.length, 9);
  for (const q of list.QUESTIONS) {
    const keys = q.opts.map((o) => o[0]);
    assert.ok(keys.includes(q.sug), `${q.id}: the suggestion is one of its options`);
    assert.equal(new Set(keys).size, keys.length, `${q.id}: option keys are unique`);
    assert.ok(!keys.includes('other') && !keys.includes(''), `${q.id}: "other" and "" are reserved`);
  }
  assert.ok(svc.page().includes('<b>all 19 questions</b>') && svc.page().includes('0 of 24 answered'));
  assert.ok(!svc.page().includes('19 decisions') && !/of 19 answered/.test(svc.page()), 'the old count is gone');
  // the counts come from the list itself, not from a typed number
  assert.ok(svc.page().includes('var TOTAL = QUESTIONS.length;'));
  assert.ok(svc.page().includes('var lines = ["Answers to the " + TOTAL + " questions ("'));
});

// ─── The follow-up of 23 November: five new questions, the 19 earlier ones untouched ─────────────

// Each earlier question's option keys and its suggestion, and the SHA-256 of the 19 as they stood at e5fc7fd (the
// commit that was live when Gauri answered them): the server's list (id, title, sug, opts), the page's own copy
// (with group, ctx, sugText and the note prompt) and the page's eight groups. Her answers are stored under these
// ids and keys, so none of it may change.
const OLD_PIN = { G1: 'abc:b', H1: 'abc:b', H2: 'abc:b', H3: 'abc:a', H4: 'abc:a', A1: 'abc:a', B1: 'abcd:a', B2: 'abc:a', B3: 'abcd:d', B4: 'abc:a',
  B5: 'abc:a', F1: 'abcd:a', F2: 'ab:a', F3: 'abc:a', F4: 'ab:a', D1: 'abcde:a', R1: 'abc:b', R2: 'abc:a', O1: 'abc:a' };
const OLD_SHA = {
  server: 'dd074fc1d48c104c686434fb846342f47dd1f126901625e4efa4cdcc5bbf0b1f',
  page: '807b12defecb35d4281efb73db20f66c41dfd91932118cfbf21a512485ce28a1',
  groups: '18d75cb204779de729f9953eb79f9baf3e53c354a9963237057c159178dd22a2',
};
// The five follow-ups: keys a, b, c each, and the suggestion of each; their texts as first published (id, title, sug, opts).
const NEW_PIN = { B3x: 'abc:b', A1x: 'abc:a', B2x: 'abc:c', F1x: 'abc:a', O1x: 'abc:a' };
const NEW_SHA = 'dc4fcad9d328b734a5c5e2f14be12d1ca9473987f753f8b98873e1eadb215109';
const keysAndSug = (qs) => Object.fromEntries(qs.map((q) => [q.id, `${q.opts.map((o) => o[0]).join('')}:${q.sug}`]));
const serverShape = (q) => ({ id: q.id, title: q.title, sug: q.sug, opts: q.opts });
const pin = (v) => sha256hex(JSON.stringify(v));

test('the 19 earlier questions are byte for byte what they were when Gauri answered them (pinned at e5fc7fd)', () => {
  const old = JSON.parse(JSON.stringify(list.QUESTIONS.slice(NEW_IDS.length)));
  assert.deepEqual(old.map((q) => q.id), OLD_IDS, 'the same 19 ids, in the same order, after the five new ones');
  assert.deepEqual(keysAndSug(old), OLD_PIN, 'the same option keys and suggestions');
  assert.equal(pin(old.map(serverShape)), OLD_SHA.server, "the server's 19: ids, titles, suggestions, option keys and option texts");
  const { groups, questions } = pageLists();
  const pageOld = questions.slice(NEW_IDS.length);
  assert.deepEqual(pageOld.map((q) => q.id), OLD_IDS);
  assert.equal(pin(pageOld.map((q) => ({ id: q.id, group: q.group, title: q.title, ctx: q.ctx, opts: q.opts, sug: q.sug, sugText: q.sugText, ask: q.ask === undefined ? null : q.ask }))),
    OLD_SHA.page, "the page's 19: also the group, the context, the suggestion line and the note prompt");
  assert.equal(pin(groups.slice(1).map((g) => ({ id: g.id, title: g.title, sub: g.sub }))), OLD_SHA.groups, 'the eight earlier groups');
  // the pin itself is honest: one changed letter, key or id changes the hash
  const bent = old.map(serverShape);
  bent[8] = { ...bent[8], opts: bent[8].opts.map((o) => (o[0] === 'd' ? ['e', o[1]] : o)) };
  assert.notEqual(pin(bent), OLD_SHA.server);
});

test('the five follow-up questions: new ids that collide with none of the 19, keys a, b and c, the agreed suggestions', () => {
  const fresh = JSON.parse(JSON.stringify(list.QUESTIONS.slice(0, NEW_IDS.length)));
  assert.deepEqual(fresh.map((q) => q.id), NEW_IDS, 'first in the list, in the order of the approved text');
  for (const id of NEW_IDS) assert.ok(!OLD_IDS.includes(id), `${id} is not one of the 19`);
  assert.deepEqual(keysAndSug(fresh), NEW_PIN);
  assert.deepEqual(fresh.map((q) => q.title), [
    'Free consultations: which ones does the consultant confirm afterwards?',
    'Agreement or form still missing at the consultation time',
    'Early slot: should the app hold the time while the client pays?',
    'Who approves a big discount?',
    'The sentence about recording, for the consultation agreement',
  ]);
  assert.equal(pin(fresh.map(serverShape)), NEW_SHA, 'the titles and option texts as first published (an answer is stored as a key of these)');
  for (const q of fresh) for (const o of q.opts) assert.ok(!/suggested/i.test(o[1]), `${q.id} (${o[0]}): the option text carries no "(suggested)" mark — the page adds its own`);
  // on the page: all five in the new group, each with its context, a suggestion line that names the suggested letter, and the plain note prompt
  const { questions } = pageLists();
  for (const q of questions.slice(0, NEW_IDS.length)) {
    assert.equal(q.group, 'followup', q.id);
    assert.ok(q.ctx.length > 40 && /\?$/.test(q.ctx.split('\n\n')[q.id === 'F1x' ? 1 : q.ctx.split('\n\n').length - 1]), `${q.id}: the context ends on the question (F1x: then the "One more point" paragraph)`);
    assert.ok(q.sugText.startsWith(`(${q.sug})`), `${q.id}: the suggestion line starts with the suggested letter`);
    assert.equal(q.ask, undefined, `${q.id}: the note box keeps "Note (optional)"`);
  }
  assert.ok(questions[3].ctx.split('\n\n')[2].startsWith('One more point, so you know: '), 'F1x: the extra point is the last paragraph of its context');
  assert.equal(questions[4].sugText, '(a), if these words are fine as they are.');
});

test('the page: thank-you header, the follow-up group first, one plain heading before the 19 earlier answers', () => {
  const html = svc.page();
  const { groups, questions, earlier } = pageLists();
  assert.deepEqual(groups[0], { id: 'followup', title: 'Five follow-up questions', sub: '23 November. One more word on five of your answers.' });
  assert.deepEqual(groups.slice(1).map((g) => g.id), ['who', 'handoff', 'ready', 'booking', 'fees', 'deadlines', 'reminders', 'recording']);
  assert.deepEqual(earlier, { before: 'who', title: 'Your 19 earlier answers', sub: 'You can still change any of them.' });
  assert.equal(earlier.before, groups[1].id, 'the heading stands before the first earlier group');
  assert.equal(questions.filter((q) => q.group === 'followup').length, 5);
  assert.equal(questions.length - 5, 19, 'the heading counts the earlier questions truly');
  // the header: thanks, what is already in the app, the fee sheet, the five at the top, how to answer, the 19 below
  const head = /<header[^>]*>([\s\S]*?)<\/header>/.exec(html)[1];
  for (const words of [
    'Thank you for answering <b>all 19 questions</b>.',
    'the first ones are already in the app:',
    '<li>The Deadlines tab now shows “Whole firm: N of 20” for each half-month window, and “Full” at 20 or more.</li>',
    '<li>The Consultations page now shows which upcoming consultations are “Ready”, and what is missing for the others.</li>',
    '<li>A consultation with no payment recorded now shows “Not paid” in red.</li>',
    '<li>A reason is now required whenever a consultation fee is waived or a consultation is added as free.</li>',
    'The fee sheet template is ready and is going to Asmita to fill in.',
    '<b>Five answers need one more word from you.</b> They are at the top of this page.',
    'The <b>suggested</b> answer is marked; “Use the suggestion” picks it in one click.',
    'Add a note wherever you want to explain or change something.',
    'Your answers save as you go.',
    'Your 19 earlier answers are below, and you can still change any of them.',
  ]) assert.ok(head.includes(words), words);
  assert.equal((head.match(/<li>/g) || []).length, 4);
  assert.ok(!head.includes('decisions we need from you'), 'the old opening paragraph is gone');
  // the context and the suggestion line may hold more than one paragraph: their line breaks show
  assert.match(html, /\n\.ctx\{[^}]*white-space:pre-line\}/);
  assert.match(html, /\n\.sugline\{[^}]*white-space:pre-line\}/);
  // words for a manager: no switch names, no file names, nothing about credits
  const shown = [head, ...groups.flatMap((g) => [g.title, g.sub]), earlier.title, earlier.sub,
    ...questions.slice(0, 5).flatMap((q) => [q.title, q.ctx, q.sugText, ...q.opts.map((o) => o[1])])].join('\n');
  assert.deepEqual(shown.match(/credit|[A-Z]{3,}_[A-Z_]+|\.(?:js|json|html|xlsx)\b|OneDrive|switch name/gi) || [], []);
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

test('validation: the five follow-up ids take a, b, c, "other" and "" — and refuse a key they do not have', async () => {
  const h = harness();
  // (each batch from its own address: a refusal counts toward the per-address write limit)
  for (const id of NEW_IDS) {
    for (const choice of ['a', 'b', 'c', 'other', '']) {
      assert.deepEqual(svc.validate(putReq(id, { choice, note: 'n' })), { ok: true, qid: id, choice, note: 'n' }, `${id} ${choice}`);
    }
    for (const choice of ['d', 'e', 'A', 'x', 'ab', 'a ', 'Other', 'suggested', 0, null, ['a']]) {
      const res = await h.put(id, { choice, note: 'kept out' }, { ip: `198.51.100.${NEW_IDS.indexOf(id)}` });
      assert.equal(res.statusCode, 400, `${id} ${String(choice)}`);
      assert.deepEqual(res.body, { error: 'Unknown answer.' }, `${id} ${String(choice)}`);
    }
  }
  // a new id does not lend its keys to the question it follows up, nor borrow that one's
  assert.equal(svc.validate(putReq('B3', { choice: 'd' })).ok, true, 'B3 still has (d)');
  assert.deepEqual(svc.validate(putReq('B3x', { choice: 'd' })), { ok: false, error: 'Unknown answer.' });
  assert.equal(svc.validate(putReq('F1', { choice: 'd' })).ok, true, 'F1 still has (d)');
  assert.deepEqual(svc.validate(putReq('F1x', { choice: 'd' })), { ok: false, error: 'Unknown answer.' });
  // the id check is as strict as before: only the exact 24 ids
  for (const qid of ['b3x', 'B3X', 'B3xx', 'B3x ', ' B3x', 'B3-x', 'G1x', 'H1x', 'D1x', 'X', 'x', 'B3x/..', 'followup']) {
    const res = await h.put(qid, { choice: 'a' }, { ip: '198.51.100.50' });
    assert.equal(res.statusCode, 400, qid);
    assert.deepEqual(res.body, { error: 'Unknown question.' }, qid);
  }
  assert.equal(h.reads + h.tried, 0, 'a refused answer never reaches the file');
  // and a real save lands under the new id, in the same file shape
  const res = await h.put('B2x', { choice: 'c', note: ' two hours ' }, { ip: '198.51.100.60' });
  assert.deepEqual(res.body, { ok: true, at: '2026-11-19T15:00:00.000Z' });
  assert.deepEqual(h.file.data, {
    version: 1,
    answers: { B2x: { choice: 'c', note: 'two hours', at: '2026-11-19T15:00:00.000Z' } },
    history: [{ qid: 'B2x', choice: 'c', noteLen: 9, at: '2026-11-19T15:00:00.000Z' }],
  });
  assert.deepEqual(h.logs, ['[ShareQuestions] B2x saved (choice 1, note 9)']);
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
  // what GET hands the page: the known questions only, strings only
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
  assert.equal(out.total, 24);
  assert.equal(out.withNote, 3);
  assert.equal(out.savedAt, '2026-11-19T15:05:00.000Z');
  assert.deepEqual(out.questions.map((q) => q.id), SPEC_IDS);
  assert.deepEqual(out.questions.map((q) => q.n), SPEC_IDS.map((_, i) => i + 1));
  const by = Object.fromEntries(out.questions.map((q) => [q.id, q]));
  assert.deepEqual(by.B3x, { n: 1, id: 'B3x', title: 'Free consultations: which ones does the consultant confirm afterwards?', choice: '', answer: '', suggested: false, note: '', at: null });
  assert.deepEqual(by.G1, { n: 6, id: 'G1', title: 'Should everyone sign in with their own Monday account?', choice: 'b',
    answer: "(b) Keep today's mix, and require Monday sign-in for each new “who did it” action (fee approval, waivers, hand-off)", suggested: true,
    note: 'Mahesh and Deeksha\nshare one', at: '2026-11-19T15:00:00.000Z' });
  assert.equal(by.F1.answer, '(a) You only');
  assert.equal(by.D1.answer, 'Something else (see note)');
  assert.equal(by.D1.suggested, false);
  assert.deepEqual(by.R2, { n: 23, id: 'R2', title: 'How should a red item reach the person?', choice: '', answer: '', suggested: false, note: 'will think about it', at: '2026-11-19T15:05:00.000Z' });
  assert.deepEqual(by.O1, { n: 24, id: 'O1', title: list.QUESTIONS[23].title, choice: '', answer: '', suggested: false, note: '', at: null });

  // ?format=text: the same, as a plain list
  res = await ask(admin, { format: 'Text' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.kind, 'text/plain');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  const text = res.body;
  assert.ok(text.startsWith("Gauri's answers: 3 of 24 answered\nLast saved: "), text.slice(0, 80));
  assert.match(text, /Last saved: Nov\.? 19, 2026, 10:05 a\.m\. \(Toronto\)/);
  assert.ok(text.includes('\n\n1. Free consultations: which ones does the consultant confirm afterwards? [B3x]\n   Answer: (not answered)\n\n2. Agreement or form still missing at the consultation time [A1x]\n'));
  assert.ok(text.includes("\n\n6. Should everyone sign in with their own Monday account? [G1]\n   Answer: (b) Keep today's mix, and require Monday sign-in for each new “who did it” action (fee approval, waivers, hand-off) (the suggestion)\n   Note: Mahesh and Deeksha\n         share one\n   Saved: "));
  assert.ok(text.includes('\n21. What is the limit per half-month window? [D1]\n   Answer: Something else (see note)\n   Note: 22 for the firm\n'));
  assert.ok(text.includes('\n23. How should a red item reach the person? [R2]\n   Answer: (not answered)\n   Note: will think about it\n'));
  assert.ok(text.endsWith('\n\n24. How is the client told the consultation is recorded and transcribed, and what if they say no? [O1]\n   Answer: (not answered)\n'));
  assert.equal((text.match(/^\d+\. /gm) || []).length, 24);
  assert.equal((await ask(admin, { format: 'json' })).statusCode, 200);
  res = await ask(admin, { format: 'csv' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'format must be json or text.' });

  // nothing saved yet
  const empty = harness();
  const r0 = fakeRes();
  await empty.svc.adminAnswers({ query: { format: 'text' }, headers: {} }, r0, deps(admin));
  assert.ok(r0.body.startsWith("Gauri's answers: 0 of 24 answered\nNothing saved yet.\n"));

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
});

// ─── The two places the server itself would write a request path to the log ────

/** A request through a real Express router, no socket: resolves with what was answered, or 'fell through' (the ordinary 404). */
function throughRouter(router, method, url, headers = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headersSent: false, body: undefined, to: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; resolve(res); return res; };
    res.send = res.json;
    res.redirect = (c, to) => { res.statusCode = c; res.to = to; res.headersSent = true; resolve(res); };
    res.setHeader = () => {};
    // Express's own request prototype, so req.path and the rest are the real getters
    const req = Object.assign(Object.create(require('express').request), { method, url, originalUrl: url, headers });
    router.handle(req, res, (err) => resolve({ fellThrough: true, err }));
  });
}

/** Runs `fn` with every console method collected instead of printed. */
async function quiet(fn) {
  const lines = [];
  const con = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  console.log = console.warn = console.error = console.info = console.debug = (...a) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { Object.assign(console, con); }
  return lines;
}

test('a link with a broken percent-escape is the ordinary 404 and is never logged (the questions and the checklist alike)', async () => {
  const express = require('express');
  const server = read('src/server.js');
  // the server's OWN two error handlers, as written, behind the same kind of routes
  const m = /\/\/ ─── Global error handler[^\n]*\napp\.use\(((?:.|\n)*?\n\})\);\n/.exec(server);
  assert.ok(m, 'the global error handler is where it was');
  assert.match(m[1], /^\(err, _req, res, next\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(err instanceof URIError && err\.status === 400\) return next\(\);\n\s*console\.error\(/, 'the guard comes before anything is logged');
  const globalHandler = new Function(`return (${m[1]});`)();
  const m2 = /\/\/ Body-parser failures[^\n]*\n[^\n]*\napp\.use\(((?:.|\n)*?\n\})\);\n/.exec(server);
  assert.ok(m2, 'the body-parser error handler follows it');
  const bodyHandler = new Function(`return (${m2[1]});`)();
  assert.ok(server.indexOf(m[0]) < server.indexOf(m2[0]));
  assert.ok(server.indexOf("app.put('/share/questions/:token/answers/:qid'") < server.indexOf(m[0]), 'the routes are registered before it');

  const served = [];
  let afterwards = 0;
  const router = express.Router();
  router.get('/share/questions/:token', (req, res) => { served.push(req.params.token); res.status(200).json({ page: true }); });
  router.get('/share/questions/:token/answers', (req, res) => { served.push(req.params.token); res.status(200).json({ answers: {} }); });
  router.put('/share/questions/:token/answers/:qid', (req, res) => { served.push(req.params.token); res.status(200).json({ ok: true }); });
  router.get('/share/checklist/:token', (req, res) => { served.push(req.params.token); res.status(200).json({ page: true }); });
  router.get('/boom', () => { throw new Error('a real fault'); });
  router.use(globalHandler);
  router.use((err, req, res, next) => { afterwards++; return bodyHandler(err, req, res, next); });

  const BROKEN = [
    ['GET', `${BASE}%E2%80`], ['GET', `${BASE}%`], ['GET', `${BASE}%zz`], ['GET', `/Share/Questions/${TOKEN}%E2%80`],
    ['GET', `${BASE}%E2%80/answers`], ['PUT', `${BASE}%/answers/G1`], ['PUT', `${BASE}/answers/G1%E2%80`],
    ['GET', `/share/checklist/${TOKEN}%E2%80`], ['GET', `/share/checklist/${TOKEN}%`],
  ];
  const lines = await quiet(async () => {
    for (const [method, url] of BROKEN) {
      const r = await throughRouter(router, method, url);
      assert.equal(r.fellThrough, true, `${method} ${url.replace(TOKEN, '<token>')} falls through`);
      assert.equal(r.err, undefined, 'with no error left: the ordinary 404, not a 500 and not a 400');
    }
    // the same as an address no route reads a piece of
    assert.deepEqual(await throughRouter(router, 'GET', '/other/x%E0'), { fellThrough: true, err: undefined });
  });
  assert.deepEqual(lines, [], 'nothing is logged');
  assert.deepEqual(served, [], 'and no handler ran');
  assert.equal(afterwards, 0, 'the error handler after it is skipped too');

  // a good link is still served, with an escaped piece decoded as before
  const fine = await quiet(async () => {
    assert.equal((await throughRouter(router, 'GET', BASE)).statusCode, 200);
    assert.equal((await throughRouter(router, 'GET', `/share/checklist/${TOKEN}%2D1`)).statusCode, 200);
  });
  assert.deepEqual(fine, []);
  assert.deepEqual(served, [TOKEN, `${TOKEN}-1`]);
  // and a genuine fault is still logged and answered 500
  let boom;
  const loud = await quiet(async () => { boom = await throughRouter(router, 'GET', '/boom'); });
  assert.equal(boom.statusCode, 500);
  assert.deepEqual(boom.body, { error: 'Internal server error' });
  assert.equal(loud.length, 1);
  assert.match(loud[0], /^\[Server\] Unhandled error: Error: a real fault/);
  // Express's own message is what would have carried the token: the reason for the guard
  const raw = express.Router();
  raw.get('/share/questions/:token', () => {});
  const seen = await throughRouter(raw, 'GET', `${BASE}%E2%80`);
  assert.ok(seen.err instanceof URIError && seen.err.status === 400 && seen.err.message.includes(TOKEN));
});

test('the redirect from the old host name never logs a private link, whatever the letter case of /share/', async () => {
  const server = read('src/server.js');
  assert.ok(server.includes("console.log(`[Canonical] ${host}${/^\\/share\\//i.test(req.path) ? '/share/…' : req.originalUrl} → ${CANONICAL_HOST}`);"));
  assert.ok(!/app\.(set|enable)\('case sensitive routing'/.test(server), 'routing ignores letter case, so the test must too');
  // the server's OWN middleware, as written, on a canonical host
  const m = /\nconst NO_REDIRECT = [^\n]*\napp\.use\(((?:.|\n)*?\n\})\);\n/.exec(server);
  assert.ok(m, 'the canonical-host redirect is where it was');
  const mw = new Function('CANONICAL_HOST', 'NO_REDIRECT', `return (${m[1]});`)('app.example.test', /^\/(webhook|api|phase2\/health)\b/);
  const express = require('express');
  const router = express.Router();
  router.use(mw);
  router.get('/share/questions/:token', (req, res) => res.status(200).json({ token: req.params.token }));
  const old = { host: 'old-name.example.test' };
  let r;
  const PRIVATE = [BASE, `/Share/questions/${TOKEN}`, `/SHARE/QUESTIONS/${TOKEN}`, `/sHaRe/checklist/${TOKEN}`, `${BASE}/answers`, `/Share/questions/${TOKEN}?x=1`];
  const lines = await quiet(async () => {
    for (const url of PRIVATE) {
      r = await throughRouter(router, 'GET', url, old);
      assert.equal(r.statusCode, 302);
      assert.equal(r.to, `https://app.example.test${url}`, 'the visitor is still sent on to the same address');
    }
  });
  assert.deepEqual(lines, PRIVATE.map(() => '[Canonical] old-name.example.test/share/… → app.example.test'));
  assert.ok(!lines.join('\n').includes(TOKEN));
  // the upper-case address is one the server really serves
  assert.equal((await throughRouter(router, 'GET', `/Share/Questions/${TOKEN}`, { host: 'app.example.test' })).body.token, TOKEN);
  // every other page is logged in full, as before — only /share/ itself is left out
  const others = await quiet(async () => {
    for (const url of ['/shared/x', '/admin/share/questions/answers', '/client/2026-EE-001?a=1']) await throughRouter(router, 'GET', url, old);
  });
  assert.deepEqual(others, [
    '[Canonical] old-name.example.test/shared/x → app.example.test',
    '[Canonical] old-name.example.test/admin/share/questions/answers → app.example.test',
    '[Canonical] old-name.example.test/client/2026-EE-001?a=1 → app.example.test',
  ]);
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
function browser(h, { drafts, unsaved, sync, online = true, clock = null, gated = false } = {}) {
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
  if (sync) store['gauri-q-sync-v1'] = JSON.stringify(sync);
  const timers = [];
  const calls = [];
  const win = { listeners: {}, addEventListener: (ev, fn) => { win.listeners[ev] = fn; } };
  const doc = { listeners: {}, visibilityState: 'visible' };
  const b = { els, store, timers, calls, win, doc, online, copied: '', closed: false, gate: null };
  // `gated`: requests wait at the server's door until b.open() (a slow connection). `closed`: the tab is gone —
  // a request already on its way still reaches the server, but no reply reaches the page and nothing new is sent.
  // b.hold('PUT') keeps only the saves waiting. const deliver = b.holdReplies('GET' | 'PUT'): the server answers such
  // a request at once but its reply is slow to arrive, until deliver().
  const hold = (only) => { let open; b.gateFor = only || ''; b.gate = new Promise((r) => { open = r; }); b.open = async () => { b.gate = null; open(); await b.settle(); }; };
  b.hold = hold;
  const replyGates = {};
  b.holdReplies = (method) => { let go; replyGates[method] = new Promise((r) => { go = r; }); return async () => { delete replyGates[method]; go(); await b.settle(); }; };
  if (gated) hold();
  const nobody = () => new Promise(() => {});
  const fetchFake = async (url, opts = {}) => {
    if (b.closed) return nobody();
    calls.push({ url, method: opts.method || 'GET', body: opts.body, cache: opts.cache, credentials: opts.credentials, ...(opts.keepalive ? { keepalive: true } : {}) });
    if (!b.online) throw new TypeError('Failed to fetch');
    if (b.gate && (!b.gateFor || b.gateFor === (opts.method || 'GET'))) await b.gate;
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
    if (replyGates[opts.method || 'GET']) await replyGates[opts.method || 'GET'];
    if (b.closed) return nobody();
    const status = nexted ? 404 : res.statusCode;
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (res.headers[k] === undefined ? null : res.headers[k]) }, json: async () => JSON.parse(JSON.stringify(res.body)) };
  };
  // The device's own clock, when a test needs it to differ from the server's (`clock` → ms).
  const DeviceDate = !clock ? Date : class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock()); }
    static now() { return clock(); }
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
    Promise, JSON, Date: DeviceDate, String, Object, Array, Error, parseInt, isNaN, encodeURIComponent,
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
  b.gets = () => calls.filter((c) => c.method === 'GET');
  /** What the device keeps (its localStorage), as a later visit would find it. */
  b.kept = () => ({ drafts: JSON.parse(store['gauri-q-drafts-v1'] || '{}'), unsaved: JSON.parse(store['gauri-q-unsaved-v1'] || '{}'), sync: JSON.parse(store['gauri-q-sync-v1'] || '{}') });
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
  assert.equal(b.text('count'), '1 of 24 answered');
  assert.equal(b.puts().length, 0, 'nothing to send after a plain load');
  assert.equal(b.els.size, 7 + 9 + 1 + 24 * 4 + list.QUESTIONS.reduce((n, q) => n + q.opts.length + 1, 0), 'every group, the one divider heading, and every question, option, note box and status is on the page');

  // a choice saves at once
  await b.pick('F1', 'b');
  assert.deepEqual(b.puts().map((c) => [c.url, c.body, c.cache, c.credentials]), [[`${BASE}/answers/F1`, '{"choice":"b","note":""}', 'no-store', 'omit']]);
  assert.equal(b.status('F1'), 'Saved');
  assert.equal(h.file.data.answers.F1.choice, 'b');
  assert.equal(b.text('count'), '2 of 24 answered');
  assert.equal(b.els.get('meter').style.width, '8%');
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
  assert.ok(b.copied.startsWith('Answers to the 24 questions ('), b.copied.slice(0, 40));
  assert.ok(b.copied.includes('\n17. Who approves a fee more than $500 below the minimum?\n   Answer: (b) You or Asmita\n   Note: You only, please\n'));
  assert.ok(b.copied.includes('\n7. Who is on the retainer team, and who may send agreements?\n   Answer: (not answered)\n'));
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
  assert.equal(b.text('count'), '2 of 24 answered');
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
  // coming back to the tab reads the answers again but does not jump the wait
  b.win.listeners.focus();
  await b.settle();
  assert.equal(b.gets().length, 2);
  assert.equal(b.puts().length, 2, 'no extra try');
  assert.equal(b.status('G1'), 'Not saved yet — will try again');
  assert.equal(b.els.get('r-G1-b').checked, true, 'her unsaved choice stays on the page');
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
  // coming back to the tab does not send the refused answer again as it is; a changed one is sent
  b2.win.listeners.focus();
  await b2.settle();
  assert.equal(b2.gets().length, 2);
  assert.equal(b2.puts().length, 1);
  assert.equal(b2.status('F2'), 'Not saved — your answer is kept on this device');
  await b2.pick('F2', 'a');
  assert.equal(b2.puts().length, 2);
  assert.equal(h2.file.data.answers.F2.choice, 'a');
  assert.equal(b2.status('F2'), 'Saved');
});

// ─── One answer is two halves (choice + note) and a save replaces both ─────────

const SAVED_G1 = { version: 1, answers: { G1: { choice: 'c', note: 'saved note', at: '2026-11-18T10:00:00.000Z' } }, history: [] };

test('the page script: a change made before the saved answers have loaded keeps the other half of the saved answer', async () => {
  // a device with no draft (a second device, a private window); the connection is slow
  const h = harness({ file: SAVED_G1 });
  const b = browser(h, { gated: true });
  await b.settle();
  assert.equal(b.text('conn'), 'Loading saved answers…');
  await b.pick('G1', 'a');
  assert.equal(b.puts().length, 0, 'nothing is sent before the saved answers are known');
  assert.equal(b.status('G1'), 'Saved on this device', 'and the page does not say it is saved for Faran');
  assert.deepEqual(b.kept().drafts.G1, { choice: 'a', note: '' });
  assert.ok(b.kept().unsaved.G1, 'kept as an unsaved change on the device');
  assert.deepEqual(b.kept().sync.touched.G1, { choice: 1 }, 'which half she changed is kept with it');
  await b.open();
  assert.deepEqual(b.puts().map((c) => c.body), ['{"choice":"a","note":"saved note"}'], 'one save, carrying the saved note');
  assert.deepEqual(h.file.data.answers.G1, { choice: 'a', note: 'saved note', at: '2026-11-19T15:00:00.000Z' });
  assert.equal(b.els.get('r-G1-a').checked, true);
  assert.equal(b.els.get('n-G1').value, 'saved note', 'the saved note is on the page');
  assert.equal(b.status('G1'), 'Saved');
  assert.deepEqual(b.kept().unsaved, {});
  assert.deepEqual(b.kept().sync.touched, {});
  assert.equal(b.text('count'), '1 of 24 answered');

  // the other way round: a note typed before the load keeps the saved choice
  const h2 = harness({ file: SAVED_G1 });
  const b2 = browser(h2, { gated: true });
  b2.type('G1', 'typed early');
  b2.els.get('n-G1').fire('blur');
  await b2.settle();
  assert.equal(b2.puts().length, 0);
  assert.equal(b2.status('G1'), 'Saved on this device');
  await b2.open();
  assert.deepEqual(b2.puts().map((c) => c.body), ['{"choice":"c","note":"typed early"}']);
  assert.equal(b2.els.get('r-G1-c').checked, true);
  assert.equal(b2.text('count'), '1 of 24 answered');
  await b2.runTimers();
  assert.equal(b2.puts().length, 1, 'the typing pause has nothing left to send');

  // both halves changed before the load: her whole answer stands
  const h3 = harness({ file: SAVED_G1 });
  const b3 = browser(h3, { gated: true });
  await b3.pick('G1', 'b');
  b3.type('G1', 'all mine');
  await b3.open();
  assert.deepEqual({ choice: h3.file.data.answers.G1.choice, note: h3.file.data.answers.G1.note }, { choice: 'b', note: 'all mine' });

  // the tab is closed before the load ever returns: the next visit still fills in the half she did not change
  const h4 = harness({ file: SAVED_G1 });
  const b4 = browser(h4, { gated: true });
  await b4.pick('G1', 'a');
  b4.closed = true;
  const later = browser(h4, b4.kept());
  await later.settle();
  assert.deepEqual(later.puts().map((c) => c.body), ['{"choice":"a","note":"saved note"}']);
  assert.equal(h4.file.data.answers.G1.note, 'saved note');
});

test('the page script: a note typed while the saved answers cannot be reached keeps the saved choice once they load', async () => {
  const h = harness({ file: SAVED_G1 });
  h.failRead = new Error('down');
  const b = browser(h);
  await b.settle();
  assert.equal(b.text('conn'), "Saved answers can't be reached");
  b.type('G1', 'my new thought');
  await b.runTimers(2000);                       // the typing pause; the next try at loading is 10 s away
  assert.equal(b.puts().length, 0, 'held: nothing is sent while the saved answer is unknown');
  assert.equal(b.status('G1'), 'Saved on this device');
  assert.equal(b.text('count'), '0 of 24 answered');
  // storage is back
  h.failRead = null;
  h.clock.t += svc.FAIL_MS;
  await b.runTimers();
  assert.equal(b.text('conn'), 'Answers save automatically');
  assert.deepEqual(b.puts().map((c) => c.body), ['{"choice":"c","note":"my new thought"}']);
  assert.deepEqual({ choice: h.file.data.answers.G1.choice, note: h.file.data.answers.G1.note }, { choice: 'c', note: 'my new thought' });
  assert.equal(b.els.get('r-G1-c').checked, true);
  assert.equal(b.text('count'), '1 of 24 answered');
  assert.equal(b.status('G1'), 'Saved');
});

// ─── A page left open ─────────────────────────────────────────────────────────

test('the page script: a tab that is shown or used again reads the saved answers again, and never overwrites what another tab saved', async () => {
  const h = harness();
  const tabB = browser(h);
  await tabB.settle();
  assert.equal(tabB.gets().length, 1);
  // another tab (or device) answers G1 and D1 meanwhile
  const tabA = browser(h);
  await tabA.settle();
  await tabA.pick('G1', 'a');
  tabA.type('G1', 'first note');
  tabA.els.get('n-G1').fire('blur');
  await tabA.pick('D1', 'b');
  await tabA.settle();
  assert.deepEqual({ choice: h.file.data.answers.G1.choice, note: h.file.data.answers.G1.note }, { choice: 'a', note: 'first note' });
  assert.equal(tabB.els.get('r-G1-a').checked, false, 'tab B has not looked yet');

  // tab B is shown again → it reads again, and shows what was saved
  tabB.doc.visibilityState = 'visible';
  tabB.doc.listeners.visibilitychange();
  assert.equal(tabB.text('conn'), 'Answers save automatically', 'no "Loading…" flash on a re-read');
  await tabB.settle();
  assert.equal(tabB.gets().length, 2);
  assert.deepEqual(tabB.gets()[1], { url: `${BASE}/answers`, method: 'GET', body: undefined, cache: 'no-store', credentials: 'omit' });
  assert.equal(tabB.els.get('r-G1-a').checked, true);
  assert.equal(tabB.els.get('n-G1').value, 'first note');
  assert.match(tabB.status('G1'), /^Saved · /);
  assert.equal(tabB.text('count'), '2 of 24 answered');
  assert.equal(tabB.puts().length, 0, 'a re-read sends nothing by itself');
  // a note typed in tab B now keeps tab A's choice
  tabB.type('G1', 'one more thought');
  await tabB.runTimers(2000);
  assert.deepEqual(tabB.puts().map((c) => c.body), ['{"choice":"a","note":"one more thought"}']);
  assert.deepEqual({ choice: h.file.data.answers.G1.choice, note: h.file.data.answers.G1.note }, { choice: 'a', note: 'one more thought' });
  // "Use the suggestion" on a question another tab changed is really sent (D1: suggested (a), saved (b))
  assert.equal(tabB.els.get('r-D1-b').checked, true);
  tabB.els.get('use-D1').fire('click');
  await tabB.settle();
  assert.equal(tabB.puts().length, 2);
  assert.equal(h.file.data.answers.D1.choice, 'a');
  assert.equal(tabB.status('D1'), 'Saved');

  // the window getting the focus back, and a page restored from the back/forward cache, read again as well
  tabA.win.listeners.focus();
  await tabA.settle();
  assert.equal(tabA.gets().length, 2);
  assert.equal(tabA.els.get('n-G1').value, 'one more thought');
  assert.equal(tabA.els.get('r-D1-a').checked, true);
  tabA.win.listeners.pageshow({ persisted: true });
  await tabA.settle();
  assert.equal(tabA.gets().length, 3);
  tabA.win.listeners.pageshow({ persisted: false });   // the ordinary first showing of a page is not a second read
  await tabA.settle();
  assert.equal(tabA.gets().length, 3);
  // shown + focused in the same moment is ONE read, and hiding the page reads nothing
  tabA.doc.listeners.visibilitychange();
  tabA.win.listeners.focus();
  tabA.win.listeners.pageshow({ persisted: true });
  await tabA.settle();
  assert.equal(tabA.gets().length, 4);
  tabA.doc.visibilityState = 'hidden';
  tabA.doc.listeners.visibilitychange();
  await tabA.settle();
  assert.equal(tabA.gets().length, 4);
  assert.equal(tabA.puts().length, 3, 'and none of this sent anything');
});

test('the page script: a change made in the moment after coming back waits for the re-read, then goes with the other half as saved', async () => {
  const h = harness({ file: SAVED_G1 });
  const b = browser(h);
  await b.settle();
  // meanwhile, from another device: a new choice and a longer note on G1, and a first answer on H1
  h.file.data.answers.G1 = { choice: 'b', note: 'saved note, extended on the laptop', at: '2026-11-19T14:59:00.000Z' };
  h.file.data.answers.H1 = { choice: 'a', note: '', at: '2026-11-19T14:59:00.000Z' };
  h.file.etag = 'laptop-1';
  h.clock.t += svc.CACHE_MS;                    // (the server's own 15-second memory of the file has run out)
  // she clicks back into the window and picks at once, on a slow connection
  b.hold();
  b.win.listeners.focus();
  await b.pick('G1', 'a');
  b.type('H1', 'Asmita');
  b.els.get('n-H1').fire('blur');
  await b.settle();
  assert.equal(b.puts().length, 0, 'held while the re-read is on its way');
  assert.equal(b.status('G1'), 'Saved on this device');
  await b.open();
  assert.deepEqual(b.puts().map((c) => [c.url.slice(-2), c.body]), [
    ['G1', '{"choice":"a","note":"saved note, extended on the laptop"}'],
    ['H1', '{"choice":"a","note":"Asmita"}'],
  ]);
  assert.equal(h.file.data.answers.G1.note, 'saved note, extended on the laptop', "the laptop's note is not lost");
  assert.equal(h.file.data.answers.H1.choice, 'a', "nor the laptop's choice");
  assert.equal(b.els.get('n-G1').value, 'saved note, extended on the laptop');
  assert.equal(b.status('G1'), 'Saved');

  // a save already on its way when the re-read starts is not undone by a reply that left the server before it landed
  const h2 = harness({ file: SAVED_G1 });
  const b2 = browser(h2);
  await b2.settle();
  b2.hold();
  await b2.pick('G1', 'a');                     // the save is on its way (waiting at the door)
  assert.equal(b2.puts().length, 1);
  b2.win.listeners.focus();                     // the re-read waits behind it
  await b2.open();
  assert.deepEqual(b2.puts().map((c) => c.body), ['{"choice":"a","note":"saved note"}'], 'one save, not two');
  assert.equal(b2.els.get('r-G1-a').checked, true);
  assert.equal(b2.status('G1'), 'Saved');
  assert.equal(h2.file.data.answers.G1.choice, 'a');
  // …nor by one that reaches the page only after the save's own reply (an overtaken reply is not news)
  const h2b = harness({ file: SAVED_G1 });
  const b2b = browser(h2b);
  await b2b.settle();
  b2b.hold('PUT');
  await b2b.pick('G1', 'a');                    // the save is on its way
  const deliver = b2b.holdReplies('GET');
  b2b.win.listeners.focus();                    // the server answers the re-read at once, from before the save…
  await b2b.settle();
  assert.equal(b2b.gets().length, 2);
  await b2b.open();                             // …the save lands and its reply arrives first…
  assert.equal(h2b.file.data.answers.G1.choice, 'a');
  assert.equal(b2b.status('G1'), 'Saved');
  await deliver();                              // …and then the older reply to the re-read
  assert.equal(b2b.els.get('r-G1-a').checked, true, 'the page still shows what is saved');
  assert.equal(b2b.puts().length, 1);
  assert.equal(b2b.status('G1'), 'Saved');
  await b2b.pick('G1', 'b');                    // and the page is in working order afterwards
  assert.deepEqual({ choice: h2b.file.data.answers.G1.choice, note: h2b.file.data.answers.G1.note }, { choice: 'b', note: 'saved note' });

  // a second change waiting its turn behind a save whose reply is slow is held too once a re-read has begun
  const h2c = harness({ file: SAVED_G1 });
  let device = h2c.clock.t;
  const b2c = browser(h2c, { clock: () => device });
  await b2c.settle();
  const putReply = b2c.holdReplies('PUT');
  await b2c.pick('G1', 'a');                    // saved on the server at once; the reply is slow
  device += 800;
  await b2c.pick('G1', 'b');                    // waits its turn behind that reply
  assert.equal(b2c.puts().length, 1);
  h2c.clock.t += svc.CACHE_MS;                  // meanwhile the laptop rewrites the note
  h2c.file.data.answers.G1 = { choice: 'a', note: 'laptop note', at: new Date(h2c.clock.t).toISOString() };
  h2c.file.etag = 'laptop-2';
  const getReply = b2c.holdReplies('GET');
  b2c.win.listeners.focus();                    // she comes back: the re-read is on its way…
  await b2c.settle();
  await putReply();                             // …when the first save's reply arrives
  assert.equal(b2c.puts().length, 1, 'the waiting change is not sent with the old note');
  assert.equal(b2c.status('G1'), 'Saved on this device');
  await getReply();
  assert.deepEqual(b2c.puts().map((c) => c.body), ['{"choice":"a","note":"saved note"}', '{"choice":"b","note":"laptop note"}']);
  assert.deepEqual({ choice: h2c.file.data.answers.G1.choice, note: h2c.file.data.answers.G1.note }, { choice: 'b', note: 'laptop note' });
  assert.equal(b2c.status('G1'), 'Saved');

  // an answer the server no longer has (the file was started afresh) is sent up again, as on a fresh opening of the page
  const h2d = harness({ file: SAVED_G1 });
  const b2d = browser(h2d);
  await b2d.settle();
  h2d.file = null;
  h2d.clock.t += svc.CACHE_MS;
  b2d.win.listeners.focus();
  await b2d.settle();
  assert.deepEqual(b2d.puts().map((c) => c.body), ['{"choice":"c","note":"saved note"}']);
  assert.deepEqual({ choice: h2d.file.data.answers.G1.choice, note: h2d.file.data.answers.G1.note }, { choice: 'c', note: 'saved note' });
  assert.equal(b2d.status('G1'), 'Saved');

  // the re-read fails: the page says so, a change is held on the device, and it is sent when the answers are back
  const h3 = harness({ file: SAVED_G1 });
  const b3 = browser(h3);
  await b3.settle();
  h3.clock.t += svc.CACHE_MS;
  h3.failRead = new Error('down');
  b3.win.listeners.focus();
  await b3.settle();
  assert.equal(b3.text('conn'), "Saved answers can't be reached");
  assert.equal(b3.els.get('notice').hidden, false);
  await b3.pick('G1', 'b');
  assert.equal(b3.puts().length, 0);
  assert.equal(b3.status('G1'), 'Saved on this device');
  b3.win.listeners.focus();
  await b3.settle();
  assert.equal(b3.gets().length, 2, 'no second read beside the one already retrying');
  h3.failRead = null;
  h3.clock.t += svc.FAIL_MS;
  await b3.runTimers();
  assert.equal(b3.text('conn'), 'Answers save automatically');
  assert.equal(b3.els.get('notice').hidden, true);
  assert.deepEqual(b3.puts().map((c) => c.body), ['{"choice":"b","note":"saved note"}']);
  assert.equal(b3.status('G1'), 'Saved');
});

test('the page script: a window left open and never hidden reads again before a save once its last read is a minute old', async () => {
  const T = Date.parse('2026-11-19T15:00:00.000Z');
  let device = T;
  const h = harness({ file: SAVED_G1 });
  const b = browser(h, { clock: () => device });
  await b.settle();
  // within the minute: a save is just a save
  device += 59 * 1000;
  await b.pick('H1', 'a');
  assert.equal(b.gets().length, 1);
  assert.equal(b.puts().length, 1);
  // she answers on her phone; the laptop window stays open in front, so nothing tells it to look again
  h.clock.t += 10 * 60 * 1000;
  h.file.data.answers.G1 = { choice: 'c', note: 'added on the phone', at: new Date(h.clock.t - 1000).toISOString() };
  h.file.data.answers.D1 = { choice: 'b', note: '', at: new Date(h.clock.t - 1000).toISOString() };
  h.file.etag = 'phone-1';
  device += 10 * 60 * 1000;
  b.hold();
  await b.pick('G1', 'a');
  assert.equal(b.gets().length, 2, 'the page reads again first');
  assert.equal(b.puts().length, 1, 'and the save waits for it');
  assert.equal(b.status('G1'), 'Saved on this device');
  assert.equal(b.text('conn'), 'Answers save automatically');
  await b.open();
  assert.deepEqual(b.puts().map((c) => c.body).slice(1), ['{"choice":"a","note":"added on the phone"}']);
  assert.equal(h.file.data.answers.G1.note, 'added on the phone', "the phone's note is kept");
  assert.equal(b.status('G1'), 'Saved');
  // "Use the suggestion" on D1 (suggested (a), saved (b) from the phone) is really sent, not taken as saved already
  assert.equal(b.els.get('r-D1-b').checked, true);
  b.els.get('use-D1').fire('click');
  await b.settle();
  assert.equal(h.file.data.answers.D1.choice, 'a');
  assert.equal(b.gets().length, 2, 'the read is fresh again: no third one');
  // a note still waiting when the page is LEFT goes at once, old read or not: the page will not live to read first
  device += 10 * 60 * 1000;
  b.type('H2', 'date only');
  b.win.listeners.pagehide();
  await b.settle();
  assert.equal(b.gets().length, 2);
  assert.equal(b.puts()[b.puts().length - 1].keepalive, true);
  assert.equal(h.file.data.answers.H2.note, 'date only');
});

// ─── A change left unsaved on the device, and the two clocks ──────────────────

test("the page script: an unsaved change left on the device is not thrown away because the server stamped this device's OWN earlier save later", async () => {
  // Case 1 — the clocks agree. She picks (a), then (b) straight after; the tab closes while the (a) save is still
  // on its way, so the (b) save never starts. The server writes (a) three seconds AFTER she picked (b).
  const T = Date.parse('2026-11-19T15:00:00.000Z');
  let device = T;
  const h = harness();
  h.clock.t = T;
  const b = browser(h, { clock: () => device });
  await b.settle();
  b.hold();
  await b.pick('G1', 'a');
  device = T + 1000;
  await b.pick('G1', 'b');
  assert.equal(b.puts().length, 1, 'the second save waits its turn behind the first');
  const kept = b.kept();
  assert.deepEqual(kept.drafts.G1, { choice: 'b', note: '' });
  assert.equal(kept.unsaved.G1, '2026-11-19T15:00:01.000Z');
  assert.deepEqual(kept.sync.sent.G1, { choice: 'a', note: '' }, 'the device remembers what it last started to send');
  b.closed = true;                              // the tab is closed…
  h.clock.t = T + 4000;
  await b.open();                               // …and the (a) save still lands
  assert.deepEqual(h.file.data.answers.G1, { choice: 'a', note: '', at: '2026-11-19T15:00:04.000Z' });
  assert.ok(h.file.data.answers.G1.at > kept.unsaved.G1, "the server's stamp of the OLDER answer is the later one");
  assert.equal(b.puts().length, 1);
  // the next visit
  device = T + 60 * 60 * 1000; h.clock.t = device;
  const next = browser(h, { ...kept, clock: () => device });
  assert.equal(next.els.get('r-G1-b').checked, true);
  await next.settle();
  assert.deepEqual(next.puts().map((c) => c.body), ['{"choice":"b","note":""}'], 'her last answer is sent');
  assert.equal(h.file.data.answers.G1.choice, 'b');
  assert.equal(next.els.get('r-G1-b').checked, true);
  assert.equal(next.status('G1'), 'Saved');
  assert.deepEqual(next.kept().unsaved, {});
  assert.deepEqual(next.kept().sync.sent, {});
  assert.equal(next.kept().sync.seen.G1, h.file.data.answers.G1.at, "the device keeps the server's own stamp of what it saw");

  // Case 2 — the device's clock is five minutes behind the server's. (a) is saved; (b) cannot be saved; she leaves.
  const SKEW = 5 * 60 * 1000;
  device = T;
  const h2 = harness();
  h2.clock.t = T + SKEW;
  const b2 = browser(h2, { clock: () => device });
  await b2.settle();
  await b2.pick('R2', 'a');
  assert.equal(h2.file.data.answers.R2.at, '2026-11-19T15:05:00.000Z');
  device = T + 10 * 1000;
  h2.failWrite = new Error('down');
  await b2.pick('R2', 'b');
  b2.type('R2', 'and a morning email');
  await b2.runTimers(2000);
  assert.equal(b2.status('R2'), 'Not saved yet — will try again');
  const kept2 = b2.kept();
  b2.closed = true;
  assert.ok(kept2.unsaved.R2 < h2.file.data.answers.R2.at, "by the two clocks, the saved answer looks newer than her change");
  assert.equal(kept2.sync.seen.R2, '2026-11-19T15:05:00.000Z');
  h2.failWrite = null;
  device = T + 30 * 1000; h2.clock.t = device + SKEW;
  const next2 = browser(h2, { ...kept2, clock: () => device });
  await next2.settle();
  assert.deepEqual(next2.puts().map((c) => c.body), ['{"choice":"b","note":"and a morning email"}']);
  assert.deepEqual({ choice: h2.file.data.answers.R2.choice, note: h2.file.data.answers.R2.note }, { choice: 'b', note: 'and a morning email' });
  assert.equal(next2.status('R2'), 'Saved');

  // The rule that stays: when someone ELSE has saved a newer answer since, the leftover gives way to it.
  const h3 = harness({ file: { version: 1, answers: { R2: { choice: 'c', note: 'from the laptop', at: '2026-11-19T15:20:00.000Z' } }, history: [] } });
  const b3 = browser(h3, { ...kept2, clock: () => device });
  await b3.settle();
  assert.equal(b3.puts().length, 0);
  assert.equal(b3.els.get('r-R2-c').checked, true);
  assert.equal(b3.els.get('n-R2').value, 'from the laptop');
  assert.equal(h3.file.data.answers.R2.choice, 'c');
  assert.deepEqual(b3.kept().unsaved, {});
  assert.deepEqual(b3.kept().drafts.R2, { choice: 'c', note: 'from the laptop' });
  // …and someone else's OLDER answer does not replace her newer unsaved change
  const h4 = harness({ file: { version: 1, answers: { R2: { choice: 'c', note: 'from the laptop', at: '2026-11-19T14:00:00.000Z' } }, history: [] } });
  const b4 = browser(h4, { ...kept2, clock: () => device });
  await b4.settle();
  assert.deepEqual(b4.puts().map((c) => c.body), ['{"choice":"b","note":"and a morning email"}']);
  assert.equal(h4.file.data.answers.R2.choice, 'b');

  // what the device keeps beside the drafts is read defensively: junk there changes nothing
  const h5 = harness({ file: SAVED_G1 });
  const b5 = browser(h5, { drafts: { G1: { choice: 'a', note: '' } }, unsaved: { G1: '2026-11-19T12:00:00.000Z' }, sync: { seen: 'x', sent: { G1: 7 }, touched: null } });
  await b5.settle();
  assert.deepEqual(b5.puts().map((c) => c.body), ['{"choice":"a","note":""}'], 'an old-format leftover goes whole, by the time rule as before');
  const b6 = browser(harness({ file: SAVED_G1 }), { sync: ['not', 'an', 'object'] });
  await b6.settle();
  assert.equal(b6.els.get('r-G1-c').checked, true);
  assert.equal(b6.puts().length, 0);
});

test('the page script: the follow-up group is drawn first, then the one plain heading, then the eight earlier groups', async () => {
  const h = harness();
  const b = browser(h);
  await b.settle();
  const { questions } = pageLists();
  const parts = b.els.get('groups').children;
  assert.deepEqual(parts.map((e) => e.tag), ['section', 'div', 'section', 'section', 'section', 'section', 'section', 'section', 'section', 'section']);
  // 1) the five follow-up questions, numbered 1 to 5
  const first = parts[0];
  assert.equal(first.attrs['aria-labelledby'], 'g-followup');
  assert.equal(first.children[0].tag, 'h2');
  assert.equal(first.children[0].textContent, 'Five follow-up questions');
  assert.equal(first.children[1].textContent, '23 November. One more word on five of your answers.');
  const cards = first.children.slice(2);
  assert.deepEqual(cards.map((c) => c.attrs.id), NEW_IDS.map((id) => `q-${id}`));
  assert.deepEqual(cards.map((c) => c.children[0].children[0].textContent), ['1.', '2.', '3.', '4.', '5.']);
  cards.forEach((c, i) => {
    const q = questions[i];
    // the same six parts as every other card: head, context, options, suggestion line, note, row
    assert.deepEqual(c.children.map((x) => x.tag), ['div', 'p', 'fieldset', 'p', 'label', 'div'], q.id);
    assert.equal(c.children[0].children[1].textContent, q.title);
    assert.equal(c.children[1].className, 'ctx');
    assert.equal(c.children[1].textContent, q.ctx);
    const labels = c.children[2].children.slice(1);                                  // after the hidden legend
    assert.deepEqual(labels.map((l) => l.children[1].textContent), [...q.opts.map((o) => `(${o[0]}) ${o[1]}`), 'Something else (write it in the note)'], q.id);
    assert.deepEqual(labels.filter((l) => l.attrs['data-sug'] === '1').map((l) => l.attrs.for), [`r-${q.id}-${q.sug}`], `${q.id}: one option carries the Suggested mark`);
    assert.equal(labels.find((l) => l.attrs['data-sug'] === '1').children[1].children[0].textContent, 'Suggested');
    assert.equal(c.children[3].className, 'sugline');
    assert.equal(c.children[3].children[0].textContent, 'Suggested: ');
    assert.equal(c.children[3].children[1].text, q.sugText);
    assert.equal(c.children[4].textContent, 'Note (optional)');
  });
  // 2) the divider: a heading and one line, nothing to click
  const div = parts[1];
  assert.equal(div.className, 'earlier');
  assert.deepEqual(div.children.map((x) => [x.tag, x.textContent]), [['h2', 'Your 19 earlier answers'], ['p', 'You can still change any of them.']]);
  assert.equal(b.els.get('earlier'), div.children[0]);
  assert.deepEqual(Object.keys(div.listeners).concat(Object.keys(div.children[0].listeners)), [], 'no behaviour on it');
  // 3) the eight earlier groups, unchanged, numbered on from 6 to 24
  assert.deepEqual(parts.slice(2).map((s) => s.children[0].textContent),
    ['Who did what', 'Consultant hand-off to the retainer team', 'Agreement and form before the consultation', 'Bookings, waivers and cash',
      'Fee approvals and the minimum-fee sheet', 'Deadlines', 'Reminders that chase staff until fixed', 'Recording consultations']);
  const oldCards = parts.slice(2).flatMap((s) => s.children.slice(2));
  assert.deepEqual(oldCards.map((c) => c.attrs.id), OLD_IDS.map((id) => `q-${id}`));
  assert.deepEqual(oldCards.map((c) => c.children[0].children[0].textContent), OLD_IDS.map((_, i) => `${i + 6}.`));
  assert.equal(b.text('count'), '0 of 24 answered');

  // a follow-up answer saves like any other: the choice at once, the note after the pause, "other" with a note
  await b.pick('A1x', 'a');
  b.type('A1x', 'on the spot is fine');
  await b.runTimers(2000);
  await b.pick('O1x', 'other');
  b.type('O1x', 'Shafoli will send her wording');
  b.els.get('n-O1x').fire('blur');
  await b.settle();
  assert.deepEqual(h.file.data.answers, {
    A1x: { choice: 'a', note: 'on the spot is fine', at: '2026-11-19T15:00:00.000Z' },
    O1x: { choice: 'other', note: 'Shafoli will send her wording', at: '2026-11-19T15:00:00.000Z' },
  });
  assert.equal(b.status('A1x'), 'Saved');
  assert.equal(b.text('count'), '2 of 24 answered');
  assert.deepEqual(b.kept().drafts.O1x, { choice: 'other', note: 'Shafoli will send her wording' }, 'the draft is kept on the device under the new id');
  // "Copy my answers" lists the five first, then the 19, numbered as on the page
  b.els.get('copyBtn').fire('click');
  await b.settle();
  const lines = b.copied.split('\n');
  assert.match(lines[0], /^Answers to the 24 questions \(/);
  assert.ok(b.copied.includes('\n1. Free consultations: which ones does the consultant confirm afterwards?\n   Answer: (not answered)\n\n2. Agreement or form still missing at the consultation time\n   Answer: (a) Yes. The team chases the client the day before'));
  assert.ok(b.copied.includes('\n5. The sentence about recording, for the consultation agreement\n   Answer: Something else (see note)\n   Note: Shafoli will send her wording\n\n6. Should everyone sign in with their own Monday account?\n   Answer: (not answered)\n'));
  assert.deepEqual(lines.filter((l) => /^\d+\. /.test(l)).map((l) => l.split('.')[0]), SPEC_IDS.map((_, i) => String(i + 1)));
  // a later visit reads them back
  const again = browser(h);
  await again.settle();
  assert.equal(again.els.get('r-A1x-a').checked, true);
  assert.equal(again.els.get('n-O1x').value, 'Shafoli will send her wording');
  assert.equal(again.text('count'), '2 of 24 answered');
  assert.equal(again.puts().length, 0);
});

/** The answers file as it stood before the follow-up: the 19 earlier answers only (every choice and note invented here). */
function oldOnlyFile() {
  const answers = {};
  OLD_IDS.forEach((id, i) => {
    const keys = OLD_PIN[id].split(':')[0].split('');
    answers[id] = { choice: i % 5 === 4 ? 'other' : keys[i % keys.length], note: i % 3 === 0 ? `a note on ${id}\nsecond line` : '', at: new Date(Date.parse('2026-11-19T16:00:00.000Z') + i * 60000).toISOString() };
  });
  return { version: 1, answers, history: OLD_IDS.map((id) => ({ qid: id, choice: answers[id].choice, noteLen: answers[id].note.length, at: answers[id].at })) };
}

test('an answers file that holds only the 19 earlier answers reads exactly as before: 19 of 24, the five new ones empty', async () => {
  const before = oldOnlyFile();
  const h = harness({ file: before });
  // GET: the same 19 answers, each exactly as stored, in the same order; nothing for the five new ones
  const got = (await h.get()).body;
  assert.deepEqual(Object.keys(got.answers), OLD_IDS);
  assert.deepEqual(got.answers, before.answers);
  assert.equal(got.savedAt, before.answers.O1.at);
  for (const id of NEW_IDS) assert.ok(!(id in got.answers), id);
  // the admin read: 24 listed, the five new ones first and empty, the 19 with the stored choice in plain words
  const res = fakeRes();
  await h.svc.adminAnswers({ query: {}, headers: {} }, res, { staff: () => ({ name: 'The Boss', email: 'boss@tdotimm.com' }), isAdminEmail: (e) => e === 'boss@tdotimm.com' });
  const out = res.body;
  assert.equal(out.answered, 19);
  assert.equal(out.total, 24);
  assert.equal(out.withNote, OLD_IDS.filter((id) => before.answers[id].note).length);
  assert.equal(out.savedAt, before.answers.O1.at);
  assert.deepEqual(out.questions.map((q) => q.id), SPEC_IDS);
  assert.deepEqual(out.questions.slice(0, 5).map((q) => ({ n: q.n, choice: q.choice, answer: q.answer, suggested: q.suggested, note: q.note, at: q.at })),
    [1, 2, 3, 4, 5].map((n) => ({ n, choice: '', answer: '', suggested: false, note: '', at: null })));
  out.questions.slice(5).forEach((x, i) => {
    const q = list.QUESTIONS[5 + i], a = before.answers[x.id];
    const text = a.choice === 'other' ? 'Something else (see note)' : `(${a.choice}) ${q.opts.find((o) => o[0] === a.choice)[1]}`;
    assert.deepEqual(x, { n: 6 + i, id: OLD_IDS[i], title: q.title, choice: a.choice, answer: text, suggested: a.choice === OLD_PIN[x.id].split(':')[1], note: a.note, at: a.at }, x.id);
  });
  assert.ok(svc.reportText(out).startsWith("Gauri's answers: 19 of 24 answered\nLast saved: "));
  // the page: the 19 shown as saved, the five new ones blank, and opening it sends nothing
  const b = browser(h);
  await b.settle();
  assert.equal(b.text('count'), '19 of 24 answered');
  assert.equal(b.els.get('meter').style.width, '79%');
  for (const id of OLD_IDS) {
    assert.equal(b.els.get(`r-${id}-${before.answers[id].choice}`).checked, true, id);
    assert.equal(b.els.get(`n-${id}`).value, before.answers[id].note, id);
    assert.match(b.status(id), /^Saved · /, id);
    assert.equal(b.els.get(`q-${id}`).attrs['data-answered'], '1', id);
  }
  for (const id of NEW_IDS) {
    for (const key of ['a', 'b', 'c', 'other']) assert.equal(b.els.get(`r-${id}-${key}`).checked, false, `${id} ${key}`);
    assert.equal(b.els.get(`r-${id}-d`), undefined, `${id} has no (d)`);
    assert.equal(b.els.get(`n-${id}`).value, '', id);
    assert.equal(b.status(id), '', id);
    assert.equal(b.els.get(`q-${id}`).attrs['data-answered'], '0', id);
  }
  assert.equal(b.puts().length, 0, 'a plain load sends nothing');
  assert.equal(h.tried, 0, 'and nothing was written');
  assert.deepEqual(h.file.data, before, 'the file is as it was');
  // answering a follow-up adds ONE answer under its own id; the 19 stay exactly as they were
  await b.pick('B3x', 'b');
  b.els.get('use-B2x').fire('click');
  await b.settle();
  assert.deepEqual(b.puts().map((c) => [c.url, c.body]), [[`${BASE}/answers/B3x`, '{"choice":"b","note":""}'], [`${BASE}/answers/B2x`, '{"choice":"c","note":""}']]);
  assert.equal(b.text('count'), '21 of 24 answered');
  assert.deepEqual(Object.keys(h.file.data.answers), [...OLD_IDS, 'B3x', 'B2x']);
  for (const id of OLD_IDS) assert.deepEqual(h.file.data.answers[id], before.answers[id], id);
  assert.equal(h.file.data.version, 1);
  assert.deepEqual(h.file.data.history.slice(0, 19), before.history);
  assert.deepEqual(h.file.data.history.slice(19).map((x) => [x.qid, x.choice, x.noteLen]), [['B3x', 'b', 0], ['B2x', 'c', 0]]);
  // and the 19 can still be changed
  await b.pick('G1', 'c');
  assert.equal(h.file.data.answers.G1.choice, 'c');
  assert.equal(h.file.data.answers.G1.note, before.answers.G1.note, 'the note she wrote stays with the changed choice');
  assert.equal(b.text('count'), '21 of 24 answered');
});
