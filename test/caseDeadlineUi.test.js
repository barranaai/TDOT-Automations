'use strict';

// The "Change the client deadline" pop-up on the case page and the Client Master page (2026-11-10):
// the shared module stays inside the inline-JS rules, both pages carry it once, every emitted
// script parses, and the buttons show only where the server allows the write.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

const ui = require('../src/routes/deadlineChangeUi');
const DL = require('../src/services/deadlineService');

function pageHtml(router, at) {
  const l = router.stack.find((x) => x.route && x.route.path === at && x.route.methods.get);
  let html = '';
  const res = { type() { return this; }, set() { return this; }, status() { return this; }, redirect() {}, send(h) { html = String(h); } };
  l.route.stack[l.route.stack.length - 1].handle({ query: {}, params: {}, headers: {}, get() { return ''; } }, res, () => {});
  return html;
}
const scripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const dash = () => pageHtml(require('../src/routes/adminDashboard'), '/');
const cockpit = () => require('../src/routes/adminCase').buildCockpitHTML('2026-TEST-001');

test('the shared module is plain template text: no backticks, no dollar-brace, no backslashes', () => {
  for (const k of ['DEADLINE_CHANGE_CSS', 'DEADLINE_CHANGE_HTML', 'DEADLINE_CHANGE_JS']) {
    assert.ok(!/`/.test(ui[k]), k + ' has a backtick');
    assert.ok(!/\$\{/.test(ui[k]), k + ' has a dollar-brace');
    assert.ok(!/\\/.test(ui[k]), k + ' has a backslash');
  }
  new vm.Script(ui.DEADLINE_CHANGE_JS);
});

test('the pop-up body: the shared deadline box (Real deadline / Imaginary, same values as everywhere), a required reason, and what will happen in plain words', () => {
  const h = ui.DEADLINE_CHANGE_HTML;
  assert.match(h, /^<template id="dlc-tpl">[\s\S]*<\/template>$/);
  assert.match(h, /name="dlc-dltype" value="Deadline"> Real deadline/);
  assert.match(h, /name="dlc-dltype" value="Imaginary"> Imaginary/);
  assert.match(h, /id="dlc-dl-actual"/); assert.match(h, /id="dlc-dl-promised"/);
  assert.match(h, /<label class="al-l" for="dlc-reason">Reason for the change \*<\/label>/);
  assert.match(h, /<textarea id="dlc-reason"[^>]*maxlength="300"/);
  assert.match(h, /adds a note on the case with your name and the reason\. Nothing is sent to the client\./);
  assert.match(h, /A date box left empty is removed from the case/);
  assert.ok(!/lead/i.test(h), 'the pop-up promises nothing about a lead (a case may have none)');
});

test('the pop-up script: uses the shared pop-up + box, pre-checks with the box, sends itemId / deadline / reason / expected, re-arms on a 409 "changed"', () => {
  const js = ui.DEADLINE_CHANGE_JS;
  assert.match(js, /window\.tdotDeadlineBox = function/);
  assert.match(js, /tdotDialogNew\(\{ cls: 'dlc-dlg', group: 'dlc', labelledBy: 'dlc-h' \}\)/);
  assert.match(js, /box\.check\(true, \{ promisedSubmissionDate: st\.expected\.promisedSubmissionDate \}\)/);
  assert.match(js, /why\.length < 5/);
  assert.match(js, /JSON\.stringify\(\{ itemId: String\(o\.itemId\), deadline: box\.read\(\), reason: why, expected: st\.expected \}\)/);
  assert.match(js, /res\.status === 409 && j\.code === 'changed' && j\.current/);
  assert.match(js, /st\.expected = tdotDeadlineRaw\(j\.current\)/);
  assert.match(js, /Press Save deadline again to replace it/);
  assert.match(js, /res\.status === 401/);
  assert.ok(!/id="dlc-go"[^>]*data-x/.test(js), 'Save is not a data-x button (the long-wait timer must never re-enable it)');
});

test('tdotDeadlineText (the "Now:" line) says what deadlineService.describe says', () => {
  const ctx = { window: {}, document: { getElementById() { return null; } } };
  vm.createContext(ctx);
  vm.runInContext(ui.DEADLINE_CHANGE_JS, ctx);
  for (const d of [
    { type: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '' },
    { type: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '2026-12-20' },
    { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2026-12-20' },
    { type: '', actualDeadline: '', promisedSubmissionDate: '' },
  ]) assert.equal(ctx.tdotDeadlineText(d), DL.describe(d));
  // …and for every shape a hand-kept row can have, what the server's note / 409 text says (describeStored)
  for (const d of [
    { type: '', actualDeadline: '2027-03-01', promisedSubmissionDate: '2027-02-10' },
    { type: '', actualDeadline: '', promisedSubmissionDate: '2027-02-10' },
    { type: 'Imaginary', actualDeadline: '2027-03-01', promisedSubmissionDate: '2027-02-10' },
    { type: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '2026-12-20' },
    { type: '', actualDeadline: '', promisedSubmissionDate: '' },
  ]) assert.equal(ctx.tdotDeadlineText(d), DL.describeStored(d));
  // an old row with a date but no type (never written by the app): said as it is
  assert.match(ctx.tdotDeadlineText({ type: '', actualDeadline: '2027-01-15', promisedSubmissionDate: '' }), /^Type not recorded — actual /);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.tdotDeadlineRaw({ type: 'Imaginary', promisedSubmissionDate: '2026-12-20', text: 'x' }))), { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2026-12-20' });
});

test('Client Master page: carries the pop-up once, every script parses, the button is on the Deadlines tab only and only with canChangeDeadline, hidden in print', () => {
  const html = dash();
  const ss = scripts(html);
  assert.ok(ss.length >= 1);
  ss.forEach((s, i) => { try { new vm.Script(s); } catch (e) { assert.fail('Client Master script #' + (i + 1) + ' does not parse: ' + e.message); } });
  assert.equal(html.split('<template id="dlc-tpl">').length - 1, 1);
  assert.equal(html.split('window.tdotDeadlineChange = function').length - 1, 1);
  assert.ok(html.includes(".dlc-dlg .dlx .al-yn input { width:auto; }"));
  assert.ok(html.includes("var dlBtn = (v && v.key === 'deadlines' && c.canChangeDeadline)"));
  assert.ok(html.includes('class="dlc-btn" data-dl="'));
  assert.ok(html.includes("if (db) db.onclick = function(e) { e.stopPropagation(); cmDeadlineDlg(String(c.id)); };"), 'the button never opens the case');
  assert.ok(html.includes("url: '/admin/client-master/deadline'"));
  // the row follows the answer (the promised date's row field is promisedDate) and the list redraws from the rows — no board read
  assert.ok(html.includes("row.promisedDate = String(d.promisedSubmissionDate || '');"));
  const apply = html.slice(html.indexOf('function cmDlApply'), html.indexOf('function cmDeadlineDlg'));
  assert.ok(apply.includes('CasesTable.setRows(_data.cases);'));
  const dlg = html.slice(html.indexOf('function cmDeadlineDlg'), html.indexOf('/* ── Helpers ─'));
  assert.ok(!/fetchData|dashboard-stats|location\.reload/.test(apply + dlg));
  assert.match(html, /@media print \{[\s\S]*?\.cm-assign, \.cm-asg-ok, \.dlc-btn, \.dlc-ok \{ display:none !important; \}/);
  assert.match(html, /@media \(max-width: 760px\) \{ \.dlc-dlg input\[type=date\], \.dlc-dlg \.dlc-reason, \.dlc-dlg \.tdlg-btn \{ font-size:16px; \} \}/);
});

test('Case page: the Change button sits right after the Client deadline pill, only with canChangeDeadline; a save redraws the pills only', () => {
  const html = cockpit();
  scripts(html).forEach((s, i) => { try { new vm.Script(s); } catch (e) { assert.fail('case page script #' + (i + 1) + ' does not parse: ' + e.message); } });
  assert.equal(html.split('<template id="dlc-tpl">').length - 1, 1);
  assert.equal(html.split('window.tdotDeadlineChange = function').length - 1, 1);
  const pills = html.slice(html.indexOf('function renderPills(d)'), html.indexOf('function caseDeadlineApply'));
  const at = (s) => { const i = pills.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('<span class="pk">Client deadline</span> Not set') < at('id="dl-change-btn"'));
  assert.ok(at('id="dl-change-btn"') < at('<span class="pk">SLA deadline</span>'));
  assert.ok(pills.includes("if (d.canChangeDeadline && d.itemId) pills +="));
  const dlg = html.slice(html.indexOf('function caseDeadlineApply'), html.indexOf('function render(d)'));
  assert.ok(dlg.includes("url: '/admin/case-deadline'"));
  assert.ok(dlg.includes('current: d.clientDeadlineRaw || {}'));
  assert.ok(dlg.includes('renderPills(LAST_D);'));
  assert.ok(!/loadCase\(/.test(dlg), 'never a whole case reload (about ten reads)');
  assert.ok(html.includes('  // Pills\n  renderPills(d);'));
});

test('the routes: both POSTs go to caseDeadlineService.change with the source set by the route; the page flags come from the Monday sign-in', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(src, /app\.post\('\/admin\/client-master\/deadline', express\.json\(\), deadlineChangeRoute\('client-master'\)\);/);
  assert.match(src, /app\.post\('\/admin\/case-deadline', express\.json\(\), deadlineChangeRoute\('case'\)\);/);
  const route = src.slice(src.indexOf('function deadlineChangeRoute'), src.indexOf("app.post('/admin/client-master/deadline'"));
  assert.match(route, /change\(\{ staff, hasKey, body: req\.body, source \}\)/);
  assert.ok(!/req\.body\.source|resolveCaseForWrite/.test(route));
  assert.match(src, /c\.canChangeDeadline = !!c\.canAssign;/);
  assert.match(src, /overview\.canChangeDeadline = !overview\.cmUnavailable && require\('\.\/services\/caseDeadlineService'\)\.canChange\(tryStaffAuth\(req\), overview\.assignees\);/);
});

// ── the pop-up run in a sandbox: a fake page (the template, the radios, the boxes), a fake shared pop-up, scripted answers ──
function sandbox(responses = []) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, onclick: null, focus() { this.focused = true; }, addEventListener() {} });
  const radios = ['Deadline', 'Imaginary'].map((v) => ({ value: v, checked: false, disabled: false, addEventListener() {} }));
  const fetches = [], queue = responses.slice(), dialogs = [], saved = [], current = [];
  const ctx = {
    JSON, String, Array, Date, Intl, encodeURIComponent, Promise,
    window: {}, location: { pathname: '/admin/case/2026-TEST-001', search: '?x=1' },
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    peekKey: () => '',
    document: {
      getElementById: (id) => (id === 'dlc-tpl' ? { innerHTML: '[the box]' } : el(id)),
      querySelectorAll: (sel) => (/dlc-dltype/.test(sel) ? radios : []),
      querySelector: (sel) => (/dlc-dltype"\]:checked/.test(sel) ? (radios.find((r) => r.checked) || null) : null),
    },
    tdotDialogNew(opts) {
      const c = { opts, openId: 1, busy: false, closed: [], box: { innerHTML: '', querySelector: (sel) => (sel === '.dlx input' ? radios[0] : el(sel.slice(1))), querySelectorAll: () => [...radios, el('dlc-dl-actual'), el('dlc-dl-promised'), el('dlc-reason')] },
        setBusy(on) { c.busy = !!on; }, tryClose(how) { return c.close(true, how); }, close(force, how) { c.closed.push(how); return true; }, still(id) { return id === c.openId && !c.closed.length; } };
      dialogs.push(c); return c;
    },
    fetch: (url, opts) => {
      fetches.push({ url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
      const next = queue.shift();
      if (next === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: next.status < 300, status: next.status, json: () => Promise.resolve(next.body) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(ui.DEADLINE_CHANGE_JS, ctx);
  const open = (cur) => ctx.window.tdotDeadlineChange({ url: '/admin/case-deadline', itemId: 5550001, caseLine: '2026-TEST-001 · A <b>', current: cur, onSaved: (d, j) => saved.push([d, j]), onCurrent: (c) => current.push(c) });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  const pick = (v) => radios.forEach((r) => { r.checked = r.value === v; });
  return { ctx, el, radios, fetches, dialogs, saved, current, open, flush, pick };
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('pop-up (sandbox): opens with "Now:" and the boxes filled from the page; refuses a missing date or a short reason without asking the server; Save posts and closes', async () => {
  const s = sandbox([{ status: 200, body: { ok: true, deadline: { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-05-20', text: 'Imaginary — promised May 20, 2099' }, leadsUpdated: 1 } }]);
  const cur = { type: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2099-03-01' };
  const c = s.open(cur);
  assert.match(c.box.innerHTML, /<h3 id="dlc-h">Change the client deadline<\/h3><div class="dlc-case">2026-TEST-001 · A &lt;b&gt;<\/div>/);
  assert.ok(c.box.innerHTML.includes('[the box]'));
  assert.equal(s.el('dlc-now').innerHTML, 'Now: <b>' + DL.describe(cur) + '</b>');
  assert.deepEqual([s.radios[0].checked, s.el('dlc-dl-actual').value, s.el('dlc-dl-promised').value], [true, '2099-03-15', '2099-03-01']);
  // Imaginary without its date
  s.pick('Imaginary'); s.el('dlc-dl-promised').value = '';
  s.el('dlc-go').onclick();
  assert.equal(s.el('dlc-err').textContent, 'An imaginary deadline needs the date promised to the client.');
  // a past date
  s.el('dlc-dl-promised').value = '2020-01-01';
  s.el('dlc-go').onclick();
  assert.equal(s.el('dlc-err').textContent, 'The promised submission date is in the past.');
  // no reason
  s.el('dlc-dl-promised').value = '2099-05-20'; s.el('dlc-reason').value = ' ok ';
  s.el('dlc-go').onclick();
  assert.equal(s.el('dlc-err').textContent, 'Give a short reason for the change (at least 5 characters).');
  assert.equal(s.fetches.length, 0);
  s.el('dlc-reason').value = ' Client asked\nfor more time ';
  s.el('dlc-go').onclick();
  assert.equal(c.busy, true); assert.equal(s.el('dlc-go').disabled, true);
  s.el('dlc-go').onclick();   // a second press while saving does nothing
  assert.equal(s.fetches.length, 1);
  assert.deepEqual(plain(s.fetches[0]), { url: '/admin/case-deadline', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { itemId: '5550001', deadline: { deadlineType: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-05-20' }, reason: 'Client asked for more time', expected: cur } });
  await s.flush();
  assert.equal(s.saved.length, 1); assert.equal(s.saved[0][0].type, 'Imaginary');
  assert.deepEqual(c.closed, ['done']);
});

test('pop-up (sandbox): a 409 "changed" shows the value now, tells the page, and the next Save asks against it; a 401 shows the sign-in link back to this page; a note failure stays open with Close', async () => {
  const now = { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-04-01', text: 'Imaginary — promised Apr 1, 2099' };
  const s = sandbox([
    { status: 409, body: { ok: false, code: 'changed', error: 'Someone changed it since your page loaded — it is now Imaginary — promised Apr 1, 2099.', current: now } },
    { status: 401, body: { ok: false, error: 'Sign in with Monday to change the deadline.', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' } },
    { status: 200, body: { ok: true, noteFailed: true, deadline: { type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '', text: 'Real deadline Jun 30, 2099' }, leadsUpdated: 0 } },
  ]);
  const c = s.open({ type: '', actualDeadline: '', promisedSubmissionDate: '' });
  assert.equal(s.el('dlc-now').innerHTML, 'Now: <b>Not set</b>');
  assert.equal(s.radios.some((r) => r.checked), false);
  s.pick('Deadline'); s.el('dlc-dl-actual').value = '2099-06-30'; s.el('dlc-reason').value = 'Permit expiry corrected';
  s.el('dlc-go').onclick(); await s.flush();
  assert.deepEqual(s.current, [now]);
  assert.equal(s.el('dlc-now').innerHTML, 'Now: <b>' + DL.describe(now) + '</b>');
  assert.match(s.el('dlc-err').textContent, /it is now Imaginary — promised Apr 1, 2099\. Press Save deadline again to replace it\.$/);
  assert.equal(c.busy, false); assert.equal(s.el('dlc-go').disabled, false); assert.deepEqual(c.closed, []);
  s.el('dlc-go').onclick(); await s.flush();
  assert.deepEqual(plain(s.fetches[1].body.expected), { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-04-01' });
  assert.deepEqual(plain(s.fetches[1].body.deadline), { deadlineType: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '' }, 'what the person typed is kept');
  assert.equal(s.el('dlc-err').innerHTML, 'Sign in with Monday to change the deadline. <a href="/q/auth/monday?returnTo=%2Fadmin%2Fcase%2F2026-TEST-001%3Fx%3D1">Sign in with Monday</a>');
  s.el('dlc-go').onclick(); await s.flush();
  assert.equal(s.saved.length, 1);
  assert.match(s.el('dlc-err').textContent, /^Saved\. The note may not have been added/);
  assert.deepEqual(c.closed, []);
  assert.match(s.el('dlc-acts').innerHTML, /id="dlc-close">Close</);
});

test('pop-up (sandbox): a promised date already on the case and left alone beside a real deadline may be in the past; a NEW past promised date is still refused', async () => {
  const s = sandbox([{ status: 200, body: { ok: true, deadline: { type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2020-01-01', text: 'x' }, leadsUpdated: 0 } }]);
  s.open({ type: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2020-01-01' });
  s.el('dlc-reason').value = 'Permit expiry corrected';
  // a different past promised date is being SET → refused
  s.el('dlc-dl-promised').value = '2020-02-02';
  s.el('dlc-go').onclick();
  assert.equal(s.el('dlc-err').textContent, 'The promised submission date is in the past.');
  // as Imaginary the promised date IS the deadline → refused even when unchanged
  s.el('dlc-dl-promised').value = '2020-01-01'; s.pick('Imaginary');
  s.el('dlc-go').onclick();
  assert.equal(s.el('dlc-err').textContent, 'The promised submission date is in the past.');
  assert.equal(s.fetches.length, 0);
  // only the actual date moved, the stored promised date untouched → sent
  s.pick('Deadline'); s.el('dlc-dl-actual').value = '2099-06-30';
  s.el('dlc-go').onclick();
  assert.equal(s.el('dlc-err').textContent, '');
  assert.deepEqual(plain(s.fetches[0].body.deadline), { deadlineType: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2020-01-01' });
  await s.flush();
  assert.equal(s.saved.length, 1);
});
