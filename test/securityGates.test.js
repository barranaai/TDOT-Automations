'use strict';

// Two security gates (Faran 2026-10-31):
//  1. The client documents page (/documents/<case number>) opens only with the
//     case's own access code (the ?t= in our emails) or a Monday staff sign-in —
//     the page, the uploads, the reply box and "complete" alike. Every email that
//     links to it now carries the code.
//  2. Deleting records and running the overnight engines by hand are for NAMED
//     admins (Monday sign-in + admin list) — the shared team key no longer counts.
// The server starts on import, so its wiring is checked from the source (as
// staffCaseAccess does); the page's own access check is exercised with stubs.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const staffAuth = require('../src/middleware/staffAuth');
const htmlQ     = require('../src/services/htmlQuestionnaireService');
const docForm   = require('../src/routes/documentUploadForm');

const SERVER = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
const DOCFORM = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('documents page: a Monday staff sign-in opens it; otherwise only the case\'s own access code does', async () => {
  const calls = [];
  const r1 = stub(staffAuth, 'tryStaffAuth', () => ({ name: 'Gauri', email: 'g@tdotimm.com' }));
  const r2 = stub(htmlQ, 'validateAccess', async (ref, token) => { calls.push([ref, token]); if (token !== 'TDOT-good') throw new Error('Invalid or expired access token.'); return {}; });
  try {
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-TEST-001'), { ok: true, staff: true, token: '' }, 'staff: no code needed');
    assert.equal(calls.length, 0, 'staff path never reads the token');
    staffAuth.tryStaffAuth = () => null;
    assert.deepEqual(await docForm._authorise({ query: { t: 'TDOT-good' } }, '2026-TEST-001'), { ok: true, staff: false, token: 'TDOT-good' });
    assert.deepEqual(await docForm._authorise({ query: { t: 'TDOT-wrong' } }, '2026-TEST-001'), { ok: false, status: 403, reason: 'token' });
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-TEST-001'), { ok: false, status: 403, reason: 'token' }, 'no code at all = refused');
    assert.deepEqual(await docForm._authorise({ query: { t: ['TDOT-good', 'x'] } }, '2026-TEST-001'), { ok: true, staff: false, token: 'TDOT-good' }, 'a repeated ?t= takes the first');
  } finally { r1(); r2(); }
});

test('documents page: a Monday hiccup is "try again", never a refusal that sends the client hunting for a new link', async () => {
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  const r2 = stub(htmlQ, 'validateAccess', async () => { throw new Error('ECONNRESET'); });
  const warn = console.error; console.error = () => {};
  try {
    assert.deepEqual(await docForm._authorise({ query: { t: 'TDOT-good' } }, '2026-TEST-001'), { ok: false, status: 503, reason: 'backend' });
    const page = docForm._accessPage('2026-TEST-001', 'backend');
    assert.match(page, /try again in a moment/i);
    assert.doesNotMatch(page, /sign in with Monday/i, 'a hiccup page does not send a client to the staff sign-in');
  } finally { r1(); r2(); console.error = warn; }
});

test('the refusal page names nothing about the case and points to the email link (staff to the Monday sign-in)', () => {
  const page = docForm._accessPage('2026-TEST-001', 'token');
  assert.match(page, /open this page from your email/i);
  assert.match(page, /Your case is ready/);
  assert.match(page, /noindex/);
  assert.match(page, /href="\/q\/auth\/monday\?returnTo=%2Fdocuments%2F2026-TEST-001%3Fstaff%3D1"/, 'staff link comes back here through the sign-in');
  assert.doesNotMatch(page, /Case Reference Number/, 'no case-number form to guess with');
});

test('documents page wiring: the gate runs before the upload parser, on every POST, and ?staff=1 goes through the Monday sign-in', () => {
  assert.match(DOCFORM, /router\.post\('\/:caseRef\/upload\/:itemId', requireClientOrStaff, uploadLimits\.uploadSlot, uploadSingle,/);
  assert.match(DOCFORM, /router\.post\('\/:caseRef\/reply-note', requireClientOrStaff,/);
  assert.match(DOCFORM, /router\.post\('\/:caseRef\/complete', requireClientOrStaff,/);
  assert.match(DOCFORM, /oneStr\(req\.query\.staff\) === '1' && !staffAuth\.tryStaffAuth\(req\)[\s\S]{0,200}res\.redirect\(`\/q\/auth\/monday\?returnTo=/);
  assert.match(DOCFORM, /if \(!access\.ok\) return res\.status\(access\.status\)\.send\(accessPage\(caseRef, access\.reason\)\)/);
  // the page carries the code on every request it makes
  assert.match(DOCFORM, /const ACCESS_TOKEN  = \$\{JSON\.stringify\(token\)\.replace\(\/<\/g, '\\\\u003c'\)\};/, 'a < in the code can never close the script');
  for (const u of ["withToken('/documents/' + encodeURIComponent(CASE_REF) + '/reply-note')", "withToken('/documents/' + encodeURIComponent(caseRef) + '/upload/' + itemId)", "withToken('/documents/' + encodeURIComponent(CASE_REF) + '/complete')"]) assert.ok(DOCFORM.includes(u), u);
  assert.ok(DOCFORM.includes('disclaimer, hasDualPhase ? phases : null, access.token)'), 'the page is built with the code it was opened with');
  // the landing page no longer asks for a case number
  assert.doesNotMatch(DOCFORM, /<input type="text" id="caseRef" name="ref"/);
});

test('every email that links to the documents page carries the case\'s access code', () => {
  const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  assert.match(read('../src/services/emailService.js'), /documentsUrl\s*=\s*`\$\{BASE_URL\}\/documents\/\$\{encodedRef\}\?t=\$\{encodeURIComponent\(accessToken\)\}`/);
  assert.match(read('../src/services/revisionNotificationService.js'), /documentsUrl\s*=\s*`\$\{BASE_URL\}\/documents\/\$\{encodedRef\}\$\{tokenParam\}`/);
  assert.match(read('../src/services/chasingLoopService.js'), /docLink = token \? `\$\{BASE_URL\}\/documents\/\$\{encodeURIComponent\(caseRef\)\}\?t=\$\{encodeURIComponent\(token\)\}` : ''/);
  assert.match(read('../src/services/escalationRoutingService.js'), /docLink\s*=\s*accessToken \? `\$\{BASE_URL\}\/documents\/\$\{encodeURIComponent\(caseRef\)\}\?t=\$\{encodeURIComponent\(accessToken\)\}` : ''/);
  assert.match(read('../src/services/revisionNotificationService.js'), /\$\{tokenParam \? `<a href="\$\{documentsUrl\}"/, 'no code → no dead documents button');
  assert.match(read('../src/services/clientPortalService.js'), /`\$\{BASE_URL\}\/documents\/\$\{encodedRef\}\$\{tokenParam\}`/, 'the portal already carried it');
});

test('deleting and the hand-run engines use the NAMED-admin gate — the shared key is not enough', () => {
  const routes = ["app.get('/admin/delete/preview'", "app.post('/admin/delete/execute'",
    ...['readiness', 'sla', 'health', 'expiry', 'escalation', 'chasing'].map((e) => `app.post('/api/${e}/run'`),
    "app.post('/api/utils/doc-codes/generate'"];
  for (const route of routes) {
    const i = SERVER.indexOf(route);
    assert.ok(i !== -1, `${route} exists`);
    const body = SERVER.slice(i, i + 400);
    assert.match(body, /resolveNamedAdminViewerOrReject\(req, res, '/, `${route} requires a named admin`);
    assert.doesNotMatch(body, /resolveAdminOrReject\(|resolveViewer\(/, `${route} must not accept the shared key`);
  }
  // the delete audit note names the admin, never "admin-key"
  const ex = SERVER.slice(SERVER.indexOf("app.post('/admin/delete/execute'"), SERVER.indexOf("app.post('/admin/delete/execute'") + 900);
  assert.match(ex, /actor: actor\.email \|\| actor\.name,/);
  assert.doesNotMatch(ex, /'admin-key'/);
  // the gate answers with error + message (every dialog shows one of them) and the sign-in link
  const helper = SERVER.slice(SERVER.indexOf('function resolveNamedAdminViewerOrReject'), SERVER.indexOf('function resolveNamedAdminViewerOrReject') + 600);
  assert.match(helper, /namedAdminCheck\(tryStaffAuth\(req\), caseAccess\.isAdminEmail, \{ what, hint: '' \}\)/);
  assert.match(helper, /error: r\.error, message: r\.error/);
  // the preview (read-only) of the code generator stays on the key; the admin back-end tools keep their gate
  assert.match(SERVER.slice(SERVER.indexOf("app.get('/api/utils/doc-codes/preview'"), SERVER.indexOf("app.get('/api/utils/doc-codes/preview'") + 200), /docCodeGenerator\.previewCodes/);
});

test('the pages tell non-admins: bin icons hidden, engine buttons off with a sign-in note', () => {
  const shared = fs.readFileSync(require.resolve('../src/routes/adminShared.js'), 'utf8');
  assert.match(shared, /fetch\('\/admin\/payments\/viewer', \{ headers: delHeaders\(\), credentials: 'same-origin' \}\)[\s\S]{0,300}if \(v && !v\.canUndo\)[\s\S]{0,120}\.del-btn\{display:none!important\}/);
  const engines = fs.readFileSync(require.resolve('../src/routes/adminEngines.js'), 'utf8');
  assert.match(engines, /guardNamedAdmin\(\);/);
  assert.match(engines, /if \(!v \|\| v\.canUndo\) return;[\s\S]{0,1600}'\.run-btn, #run-all-btn, #btn-doccode-generate'/);
  assert.match(engines, /if \(v\.signedIn\) \{[\s\S]{0,300}not on the admin list/, 'a signed-in non-admin is told the real reason, not sent to sign in again');
});

// End to end, in this process: the real router on a local port, Monday stubbed
// away. A stranger with only a case number gets the "open your email" page and
// a 403 JSON on uploads — before any upload slot or file parsing; ?staff=1 is
// sent through the Monday sign-in; the client's own code opens the page.
test('documents router on a local port: strangers refused, ?staff=1 → Monday sign-in, the code lets the client in', async () => {
  const express = require('express');
  const http = require('http');
  const docFormSvc = require('../src/services/documentFormService');
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  const r2 = stub(htmlQ, 'validateAccess', async (ref, token) => { if (token !== 'TDOT-good') throw new Error('Invalid or expired access token.'); return {}; });
  const app = express();
  app.use(express.json());
  app.use('/documents', docForm);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const slotBefore = require('../src/utils/uploadLimits')._inFlightBytes();
  try {
    let res = await fetch(`${base}/documents/2026-TEST-001`, { redirect: 'manual' });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /open this page from your email/i);
    assert.match(html, /Open Your Portal/, 'points at the button that still works');
    assert.match(html, /older reminder or document email/, 'old tokenless buttons are explained');
    assert.doesNotMatch(html, /Educational|Passport|Not uploaded yet/, 'no document list leaks');

    res = await fetch(`${base}/documents/2026-TEST-001?staff=1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/q/auth/monday?returnTo=%2Fdocuments%2F2026-TEST-001%3Fstaff%3D1');

    res = await fetch(`${base}/documents/2026-TEST-001/upload/123?t=TDOT-wrong`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': '5' }, body: 'hello' });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Access denied — please use the most recent link from your case officer.' });
    res = await fetch(`${base}/documents/2026-TEST-001/upload/123`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': '5' }, body: 'hello' });
    assert.equal(res.status, 401, 'no code at all = the staff cookie ran out');
    assert.match((await res.json()).error, /Monday sign-in has expired/);
    res = await fetch(`${base}/documents/2026-%25E0`, { redirect: 'manual' });
    assert.equal(res.status, 400, 'a bad %-sequence answers, never hangs');
    assert.equal(require('../src/utils/uploadLimits')._inFlightBytes(), slotBefore, 'a refused upload never took a slot');

    res = await fetch(`${base}/documents/2026-TEST-001/reply-note?t=TDOT-wrong`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: '123', reply: 'hi' }) });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/documents/2026-TEST-001/complete?t=TDOT-wrong`, { method: 'POST' });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/documents/2026-TEST-001/complete?t=TDOT-good`, { method: 'POST' });
    assert.equal(res.status, 200, 'the client\'s own code passes the gate');

    // the landing page no longer offers a case-number box
    res = await fetch(`${base}/documents`);
    assert.doesNotMatch(await res.text(), /name="ref"/);
    assert.ok(docFormSvc, 'service module loads');
  } finally {
    r1(); r2();
    await new Promise((r) => server.close(r));
  }
});

// ── second review (2026-10-31): the exact refusal texts, the per-case staff rule, the emails ──

test('the three refusal messages are the access check\'s own words — reworded there, they must be reworded here', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  for (const m of ['Missing case reference or access token.', 'Case not found.', 'Invalid or expired access token.']) {
    assert.ok(svc.includes(`throw new Error('${m}')`), `the service still throws "${m}"`);
    assert.ok(DOCFORM.includes(`'${m}'`), `the page recognises "${m}"`);
  }
});

test('authorise: each of the three messages is a bad link (403); anything else is the backend (503)', async () => {
  const r1 = stub(staffAuth, 'tryStaffAuth', () => null);
  const r2 = stub(htmlQ, 'validateAccess', async (ref, token) => {
    if (!token) throw new Error('Missing case reference or access token.');
    if (ref === '2026-NOPE-001') throw new Error('Case not found.');
    if (token !== 'TDOT-good') throw new Error('Invalid or expired access token.');
    return {};
  });
  const warn = console.error; console.error = () => {};
  try {
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-TEST-001'), { ok: false, status: 403, reason: 'token' });
    assert.deepEqual(await docForm._authorise({ query: { t: 'TDOT-good' } }, '2026-NOPE-001'), { ok: false, status: 403, reason: 'token' });
    assert.deepEqual(await docForm._authorise({ query: { t: 'x' } }, '2026-TEST-001'), { ok: false, status: 403, reason: 'token' });
    htmlQ.validateAccess = async () => { throw new Error('Monday: column not found'); };   // contains "not found" — still the backend
    assert.deepEqual(await docForm._authorise({ query: { t: 'TDOT-good' } }, '2026-TEST-001'), { ok: false, status: 503, reason: 'backend' });
  } finally { r1(); r2(); console.error = warn; }
});

test('CASE_VISIBILITY=assigned: staff open only the cases they are named on; an unknown number is a 404 for staff', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const caseAccess = require('../src/services/caseAccessService');
  const COL = caseAccess.PEOPLE_COLUMNS[0];
  const prev = process.env.CASE_VISIBILITY; process.env.CASE_VISIBILITY = 'assigned';
  const staffer = { id: '77', name: 'Kamal', email: 'nobody.test@example.invalid', teamIds: [] };
  const r1 = stub(staffAuth, 'tryStaffAuth', () => staffer);
  const r2 = stub(htmlQ, 'validateAccessForStaff', async (ref) => { if (ref === '2026-NOPE-001') throw new Error('Case not found.'); if (ref === '2026-DOWN-001') throw new Error('ECONNRESET'); return { itemId: '555' }; });
  let people = { personsAndTeams: [{ id: 77, kind: 'person' }] };
  const r3 = stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: COL, value: JSON.stringify(people) }] }] }));
  const warn = console.error; console.error = () => {};
  try {
    assert.equal(caseAccess.isAdminEmail(staffer.email), false, 'the test staffer is not on the admin list');
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-TEST-001'), { ok: true, staff: true, token: '' }, 'named on the case');
    people = { personsAndTeams: [{ id: 99, kind: 'person' }] };
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-TEST-001'), { ok: false, status: 403, reason: 'assigned' }, 'someone else\'s case');
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-NOPE-001'), { ok: false, status: 404, reason: 'notfound' });
    assert.deepEqual(await docForm._authorise({ query: {} }, '2026-DOWN-001'), { ok: false, status: 503, reason: 'backend' });
    const page = docForm._accessPage('2026-TEST-001', 'assigned');
    assert.match(page, /not assigned to this case/i);
    assert.doesNotMatch(page, /sign in with Monday/i, 'they are already signed in');
    assert.match(docForm._accessPage('2026-NOPE-001', 'notfound'), /No case with this number/);
    // the gate's JSON for the same two cases
    const express = require('express'); const http = require('http');
    const app = express(); app.use('/documents', docForm);
    const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let res = await fetch(`${base}/documents/2026-TEST-001/upload/1`, { method: 'POST', headers: { 'content-length': '0' } });
      assert.equal(res.status, 403); assert.deepEqual(await res.json(), { success: false, error: 'You are not assigned to this case.' });
      res = await fetch(`${base}/documents/2026-NOPE-001/complete`, { method: 'POST' });
      assert.equal(res.status, 404); assert.deepEqual(await res.json(), { success: false, error: 'No case with this number.' });
      res = await fetch(`${base}/documents/2026-TEST-001`, { redirect: 'manual' });
      assert.equal(res.status, 403); assert.match(await res.text(), /not assigned to this case/i);
    } finally { await new Promise((r) => server.close(r)); }
  } finally { r1(); r2(); r3(); console.error = warn; if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
});

test('reminder and rework emails: with a code both buttons carry it; with no code there are no buttons, only the contact line', () => {
  const { buildChasingEmail } = require('../src/services/chasingLoopService');
  const { buildRevisionEmailHtml } = require('../src/services/revisionNotificationService');
  const withCode = buildChasingEmail('R1', { clientName: 'Ana', caseRef: '2026-X-001', token: 'ab c', qLink: 'https://x/q/2026-X-001?t=ab%20c' }).html;
  assert.match(withCode, /href="https:\/\/x\/q\/2026-X-001\?t=ab%20c" class="btn btn-q">Complete Questionnaire/);
  assert.match(withCode, /\/documents\/2026-X-001\?t=ab%20c" class="btn btn-d">Upload Documents/);
  const noCode = buildChasingEmail('R1', { clientName: 'Ana', caseRef: '2026-X-001', token: '', qLink: '' }).html;
  assert.doesNotMatch(noCode, /class="btn btn-[qd]"|\/documents\/|\/questionnaire\//, 'no dead buttons');
  assert.match(noCode, /Need your portal link again\? Please email us at .*info@tdotimm\.com/);
  const chasingSrc = fs.readFileSync(require.resolve('../src/services/chasingLoopService.js'), 'utf8');
  assert.doesNotMatch(chasingSrc, /\/questionnaire\/\$\{encodeURIComponent\(caseRef\)\}/, 'the retired /questionnaire page is never linked');
  const rw = buildRevisionEmailHtml({ clientName: 'Ana', caseRef: '2026-X-001', accessToken: 'tok', questionnaire: [], documents: [{ name: 'Passport', notes: '' }] });
  assert.match(rw, /href="[^"]*\/documents\/2026-X-001\?t=tok"/);
  const rwNo = buildRevisionEmailHtml({ clientName: 'Ana', caseRef: '2026-X-001', accessToken: '', questionnaire: [], documents: [{ name: 'Passport', notes: '' }] });
  assert.doesNotMatch(rwNo, /\/documents\//);
  assert.match(rwNo, /Need your portal link again\?/);
  assert.doesNotMatch(rwNo, /<p style="margin:0 0 20px;">\s*<p>/, 'no paragraph nested in a paragraph');
});
