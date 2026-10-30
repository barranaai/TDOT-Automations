'use strict';

// The old questionnaire page (/questionnaire/<case number>) reads the retired
// Monday questionnaire board. Until 2026-10-31 it opened — and saved — with the
// case number alone (10 old cases still had rows there, 4 with answers), and a
// save could write any row id it was sent. Now it opens like the documents
// page: the case's own access code (?t=) or a Monday staff sign-in, and a save
// touches only this case's own rows.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('fs');
const vm      = require('vm');
const http    = require('http');
const express = require('express');

const staffAuth = require('../src/middleware/staffAuth');
const htmlQ     = require('../src/services/htmlQuestionnaireService');
const qsvc      = require('../src/services/questionnaireFormService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// Every case has its own code, and a code opens its own case only (every
// client holds a valid code — for their case).
const CODES = { '2026-TEST-001': 'TDOT-good', '2026-TEST-002': 'TDOT-good-2', '2026-TEST-003': 'TDOT-good-3' };
const caseCodeCheck = async (ref, token) => {
  if (!token) throw new Error('Missing case reference or access token.');
  if (CODES[ref] !== token) throw new Error('Invalid or expired access token.');
  return {};
};

// The router takes its service functions when it is loaded — stub them first.
const ITEMS = [{ id: '101', name: 'Full name', category: 'Personal', inputType: 'Short Text', required: '', questionCode: 'P1', currentAnswer: 'Ana Secret-Answer', helpText: '', responseStatus: '', reviewNotes: '' }];
const ITEMS3 = [{ id: '301', name: 'Other client question', category: 'Personal', inputType: 'Short Text', required: '', questionCode: 'P1', currentAnswer: 'Bo Other-Answer', helpText: '', responseStatus: '', reviewNotes: '' }];
const writes = [];
let submits = 0;
const realGetCaseItemIds = qsvc.getCaseItemIds;
const realGetCaseItems = qsvc.getCaseItems;
stub(qsvc, 'getCaseItems', async (ref) => ({ '2026-TEST-001': ITEMS, '2026-TEST-003': ITEMS3 }[ref] || []));
stub(qsvc, 'getCaseItemIds', async (ref) => ({ '2026-TEST-001': ['101'], '2026-TEST-003': ['301'] }[ref] || []));
stub(qsvc, 'saveAnswers', async (answers) => { writes.push(...answers); return { saved: answers.length, failed: 0 }; });
stub(qsvc, 'submitQuestionnaire', async () => { submits++; return { submitted: 1, failed: 0 }; });
stub(require('../src/services/clientMasterService'), 'updateLastActivityDate', async () => {});
stub(require('../src/services/caseReadinessService'), 'calculateForCaseRef', async () => {});
const qForm = require('../src/routes/questionnaireForm');
const SRC = fs.readFileSync(require.resolve('../src/routes/questionnaireForm.js'), 'utf8');

async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use('/questionnaire', qForm);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

test('old questionnaire page: a stranger with only the case number sees nothing of the case and cannot save', async () => {
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  const r2 = stub(htmlQ, 'validateAccess', caseCodeCheck);
  writes.length = 0; submits = 0;
  try {
    await withRouter(async (base) => {
      let res = await fetch(`${base}/questionnaire`);
      assert.equal(res.status, 200);
      let html = await res.text();
      assert.doesNotMatch(html, /<input|name="ref"|Case Reference Number/, 'no case-number box to guess with');
      assert.match(html, /Open Your Portal/);
      assert.doesNotMatch(html, /sign in with Monday/i, 'no case → no staff link');

      for (const q of ['', '?t=TDOT-wrong']) {
        res = await fetch(`${base}/questionnaire/2026-TEST-001${q}`, { redirect: 'manual' });
        assert.equal(res.status, 403, q || 'no code');
        html = await res.text();
        // real clients come from OUR older emails, whose links never had the code
        assert.match(html, /This questionnaire link has changed/);
        assert.match(html, /older emails no longer opens this page/);
        assert.match(html, /Open Your Portal/);
        assert.match(html, /no Open Your Portal button\? Please email us at/);
        assert.doesNotMatch(html, /Full name|Ana Secret-Answer/, 'no question or answer leaks');
        assert.match(html, /noindex/);
        assert.match(html, /href="\/q\/auth\/monday\?returnTo=%2Fquestionnaire%2F2026-TEST-001%3Fstaff%3D1">sign in with Monday<\/a>/);
      }

      res = await post(`${base}/questionnaire/2026-TEST-001/save`, { answers: [{ itemId: '101', answer: 'hacked' }] });
      assert.equal(res.status, 401);
      res = await post(`${base}/questionnaire/2026-TEST-001/save?t=TDOT-wrong`, { answers: [{ itemId: '101', answer: 'hacked' }] });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { success: false, error: 'Access denied — please use the most recent link from your case officer.' });
      res = await post(`${base}/questionnaire/2026-TEST-001/submit`, {});
      assert.equal(res.status, 401);
      assert.deepEqual(writes, [], 'nothing written');
      assert.equal(submits, 0, 'nothing submitted');

      res = await fetch(`${base}/questionnaire/2026-%25E0`, { redirect: 'manual' });
      assert.equal(res.status, 400, 'a bad %-sequence answers, never hangs');
      res = await fetch(`${base}/questionnaire/x%3Cscript%3E`, { redirect: 'manual' });
      assert.equal(res.status, 400, 'not a case number');
    });
  } finally { r1(); r2(); }
});

test('old questionnaire page: the client\'s own code opens it and saves only this case\'s rows', async () => {
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  const r2 = stub(htmlQ, 'validateAccess', caseCodeCheck);
  writes.length = 0; submits = 0;
  try {
    await withRouter(async (base) => {
      let res = await fetch(`${base}/questionnaire/2026-TEST-001?t=TDOT-good`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Full name/);
      assert.match(html, /const ACCESS_TOKEN\s+= "TDOT-good";/, 'the page keeps the code for its saves');

      res = await post(`${base}/questionnaire/2026-TEST-001/save?t=TDOT-good`, { answers: [{ itemId: '101', answer: 'Ana' }] });
      assert.equal(res.status, 200);
      assert.deepEqual(writes, [{ itemId: '101', answer: 'Ana' }]);

      // a row of another case (any id the page did not show) is refused, and nothing at all is written
      res = await post(`${base}/questionnaire/2026-TEST-001/save?t=TDOT-good`, { answers: [{ itemId: '101', answer: 'B' }, { itemId: '999', answer: 'x' }] });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /not part of this questionnaire/);
      assert.deepEqual(writes, [{ itemId: '101', answer: 'Ana' }], 'the whole save is refused');
      // never more answers than the case has rows: one request cannot fan out into thousands of writes
      res = await post(`${base}/questionnaire/2026-TEST-001/save?t=TDOT-good`, { answers: [{ itemId: '101', answer: 'a' }, { itemId: '101', answer: 'b' }] });
      assert.equal(res.status, 400);
      assert.deepEqual(writes, [{ itemId: '101', answer: 'Ana' }], 'nothing written');
      for (const bad of [{ answers: 'x' }, { answers: [null] }, { answers: [{ itemId: '101', answer: { a: 1 } }] }, {}]) {
        res = await post(`${base}/questionnaire/2026-TEST-001/save?t=TDOT-good`, bad);
        assert.equal(res.status, 400, JSON.stringify(bad));
      }

      res = await post(`${base}/questionnaire/2026-TEST-001/submit?t=TDOT-good`, {});
      assert.equal(res.status, 200);
      assert.equal(submits, 1);

      // a case with nothing on the old board: the client is sent to the portal
      res = await fetch(`${base}/questionnaire/2026-TEST-002?t=TDOT-good-2`);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /Your questionnaire is in your portal/);
    });
  } finally { r1(); r2(); }
});

test('old questionnaire page: staff go through the Monday sign-in; signed in, they open it without a code', async () => {
  let staff = null;
  const r1 = stub(staffAuth, 'tryStaffAuth', () => staff);
  const r2 = stub(htmlQ, 'validateAccess', async () => { throw new Error('Missing case reference or access token.'); });
  const prev = process.env.CASE_VISIBILITY; delete process.env.CASE_VISIBILITY;
  try {
    await withRouter(async (base) => {
      let res = await fetch(`${base}/questionnaire/2026-TEST-001?staff=1`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/q/auth/monday?returnTo=%2Fquestionnaire%2F2026-TEST-001%3Fstaff%3D1');
      staff = { id: '7', name: 'Gauri', email: 'gauri.test@example.invalid', teamIds: [] };
      res = await fetch(`${base}/questionnaire/2026-TEST-001?staff=1`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Full name/);
      assert.match(html, /const ACCESS_TOKEN\s+= "";/, 'staff carry no code');
      res = await fetch(`${base}/questionnaire/2026-TEST-002`);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /Nothing on the old questionnaire board/);
    });
  } finally { r1(); r2(); if (prev !== undefined) process.env.CASE_VISIBILITY = prev; }
});

test('old questionnaire page: one case\'s code never opens, saves or submits another case', async () => {
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  const r2 = stub(htmlQ, 'validateAccess', caseCodeCheck);
  writes.length = 0; submits = 0;
  try {
    await withRouter(async (base) => {
      let res = await fetch(`${base}/questionnaire/2026-TEST-001?t=TDOT-good`);
      assert.equal(res.status, 200, 'the code opens its own case');
      // the same (valid) code on another case's address — also with a stray case= that names the code's own case
      for (const q of ['?t=TDOT-good', '?t=TDOT-good&case=2026-TEST-001', '?case=2026-TEST-001&t=TDOT-good']) {
        res = await fetch(`${base}/questionnaire/2026-TEST-003${q}`, { redirect: 'manual' });
        assert.equal(res.status, 403, q);
        assert.doesNotMatch(await res.text(), /Other client question|Bo Other-Answer/, 'nothing of the other case leaks');
        res = await post(`${base}/questionnaire/2026-TEST-003/save${q}`, { answers: [{ itemId: '301', answer: 'hacked' }] });
        assert.equal(res.status, 403, 'save ' + q);
        res = await post(`${base}/questionnaire/2026-TEST-003/submit${q}`, {});
        assert.equal(res.status, 403, 'submit ' + q);
      }
      // and a code with its own case's address cannot reach the other case's rows
      res = await post(`${base}/questionnaire/2026-TEST-001/save?t=TDOT-good`, { answers: [{ itemId: '301', answer: 'hacked' }] });
      assert.equal(res.status, 400);
      assert.deepEqual(writes, [], 'nothing written');
      assert.equal(submits, 0, 'nothing submitted');
    });
    // the shared check itself (the documents page uses it too)
    const access = require('../src/middleware/clientOrStaffAccess');
    assert.deepEqual(await access.authorise({ query: { t: 'TDOT-good' } }, '2026-TEST-001'), { ok: true, staff: false, token: 'TDOT-good' });
    assert.deepEqual(await access.authorise({ query: { t: 'TDOT-good' } }, '2026-TEST-003'), { ok: false, status: 403, reason: 'token' });
    assert.deepEqual(await access.authorise({ query: { t: 'TDOT-good', case: '2026-TEST-001' } }, '2026-TEST-003'), { ok: false, status: 403, reason: 'token' });
  } finally { r1(); r2(); }
});

test('a Monday error while checking the code is "try again" (503) — never a way in: nothing shown, nothing written', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const docForm = require('../src/routes/documentUploadForm');
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  // the REAL access check runs; only its Monday read fails (rate limit, budget, outage…)
  const r2 = stub(mondayApi, 'query', async () => { throw new Error('Complexity budget exhausted'); });
  const warn = console.error; console.error = () => {};
  writes.length = 0; submits = 0;
  const app = express();
  app.use(express.json());
  app.use('/questionnaire', qForm);
  app.use('/documents', docForm);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/questionnaire/2026-TEST-001?t=any-code`, { redirect: 'manual' });
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.match(html, /Please try again in a moment/);
    assert.doesNotMatch(html, /Full name|Ana Secret-Answer/);
    for (const [url, body] of [
      ['/questionnaire/2026-TEST-001/save?t=any-code', { answers: [{ itemId: '101', answer: 'hacked' }] }],
      ['/questionnaire/2026-TEST-001/submit?t=any-code', {}],
      ['/documents/2026-TEST-001/reply-note?t=any-code', { itemId: '123', reply: 'hi' }],
      ['/documents/2026-TEST-001/complete?t=any-code', {}],
    ]) {
      res = await post(base + url, body);
      assert.equal(res.status, 503, url);
      assert.match((await res.json()).error, /could not verify your link/, url);
    }
    assert.deepEqual(writes, [], 'nothing written');
    assert.equal(submits, 0, 'nothing submitted');
  } finally {
    r1(); r2(); console.error = warn;
    await new Promise((r) => server.close(r));
  }
});

test('CASE_VISIBILITY=assigned: on the old page too, staff open only the cases they are named on (?staff=1 is no shortcut)', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const caseAccess = require('../src/services/caseAccessService');
  const prev = process.env.CASE_VISIBILITY; process.env.CASE_VISIBILITY = 'assigned';
  const staffer = { id: '77', name: 'Kamal', email: 'nobody.test@example.invalid', teamIds: [] };
  let people = { personsAndTeams: [{ id: 99, kind: 'person' }] };
  const r1 = stub(staffAuth, 'tryStaffAuth', () => staffer);
  const r2 = stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '555' }));
  const r3 = stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: caseAccess.PEOPLE_COLUMNS[0], value: JSON.stringify(people) }] }] }));
  writes.length = 0;
  try {
    assert.equal(caseAccess.isAdminEmail(staffer.email), false, 'the test staffer is not on the admin list');
    await withRouter(async (base) => {
      for (const q of ['', '?staff=1']) {
        const res = await fetch(`${base}/questionnaire/2026-TEST-001${q}`, { redirect: 'manual' });
        assert.equal(res.status, 403, q || 'plain');
        const html = await res.text();
        assert.match(html, /not assigned to this case/i);
        assert.doesNotMatch(html, /Full name|Ana Secret-Answer/);
      }
      let res = await post(`${base}/questionnaire/2026-TEST-001/save`, { answers: [{ itemId: '101', answer: 'x' }] });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { success: false, error: 'You are not assigned to this case.' });
      assert.deepEqual(writes, []);
      people = { personsAndTeams: [{ id: 77, kind: 'person' }] };   // now named on the case
      res = await fetch(`${base}/questionnaire/2026-TEST-001?staff=1`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Full name/);
    });
  } finally { r1(); r2(); r3(); if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
});

test('getCaseItemIds (what a save may touch) asks the old board for THIS case\'s rows only', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const calls = [];
  let answer = { items_page_by_column_values: { items: [{ id: 101 }, { id: '102' }] } };
  const r = stub(mondayApi, 'query', async (q, v) => { calls.push([q, v]); return answer; });
  try {
    assert.deepEqual(await realGetCaseItemIds('2026-TEST-001'), ['101', '102'], 'ids as strings');
    assert.equal(calls.length, 1);
    const [q, v] = calls[0];
    assert.match(q, /items_page_by_column_values\(\s*limit: 500,/, 'an explicit page size (Monday\'s default is 25 rows)');
    assert.match(q, /board_id: \$boardId/);
    assert.match(q, /columns: \[\{ column_id: "text_mm12dgy9", column_values: \[\$caseRef\] \}\]/, 'filtered by the case-number column');
    assert.doesNotMatch(q, /mutation/);
    assert.deepEqual(v, { boardId: process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488', caseRef: '2026-TEST-001' });
    answer = null;
    assert.deepEqual(await realGetCaseItemIds('2026-TEST-001'), [], 'no answer = no rows (a save is then refused)');
    // the page and the save check read the same number of rows — a save never sees fewer than the page shows
    calls.length = 0;
    mondayApi.query = async (qq, vv) => { calls.push([qq, vv]); return /items_page_by_column_values/.test(qq) ? { items_page_by_column_values: { items: [] } } : { boards: [{ items_page: { cursor: null, items: [] } }] }; };
    await realGetCaseItems('2026-TEST-001');
    const pageQuery = calls.find((c) => /items_page_by_column_values/.test(c[0]));
    const limitOf = (text) => (text.match(/items_page_by_column_values\(\s*limit: (\d+),/) || [])[1];
    assert.ok(pageQuery, 'the page reads by case number');
    assert.equal(limitOf(pageQuery[0]), limitOf(q), 'same page size for the page and for the save check');
    assert.equal(pageQuery[0].includes('column_id: "text_mm12dgy9", column_values: [$caseRef]'), true, 'same case filter');
  } finally { r(); }
});

test('old questionnaire page: its script parses and every request carries the code; a < in the code cannot end the script', () => {
  const html = qForm._formPage('2026-TEST-001', [{ category: 'Personal', items: ITEMS }], 'ab</script><b>c');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]);   // throws on a syntax error
  assert.match(scripts[0], /const ACCESS_TOKEN\s+= "ab\\u003c\/script>\\u003cb>c";/);
  assert.equal((scripts[0].match(/fetch\(withToken\('\/questionnaire\/' \+ encodeURIComponent\(CASE_REF\) \+ '\/(save|submit)'\)/g) || []).length, 2);
  assert.doesNotMatch(scripts[0], /fetch\('\/questionnaire\//, 'no request without the code');
});

test('old questionnaire page wiring: both POSTs sit behind the shared gate; no case-number box anywhere', () => {
  assert.match(SRC, /router\.post\('\/:caseRef\/save', requireClientOrStaff, async/);
  assert.match(SRC, /router\.post\('\/:caseRef\/submit', requireClientOrStaff, async/);
  assert.match(SRC, /const requireClientOrStaff = caseLinkAccess\.requireClientOrStaff\(\{ logTag: LOG \}\);/);
  // the page itself: a refusal (any reason, including "try again") always stops here
  assert.match(SRC, /const access = await caseLinkAccess\.authorise\(req, caseRef, \{ logTag: LOG \}\);\n  if \(!access\.ok\) return res\.status\(access\.status\)\.send\(noticePage\(caseRef, access\.reason\)\);/);
  assert.doesNotMatch(SRC, /<input type="text" id="caseRef"/);
  assert.doesNotMatch(SRC, /error: err\.message/, 'Monday\'s own error text is never sent to the browser');
});
