'use strict';

// The "Change stage" pop-up on the Client Master page (2026-11-26, switch STAGE_EDIT): the shared module stays inside
// the inline-JS rules, the page carries it once and every emitted script parses, the button is drawn only where the
// server says so (every tab, beside the stage, never opening the case, hidden in print), the routes are wired with the
// source set by the route, the case page does NOT have it yet — and the pop-up itself, run in a sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

const ui = require('../src/routes/stageChangeUi');
const cmv = require('../src/services/clientMasterViews');
delete process.env.TODO_TAB;   // the page is pinned without the To-do tab here

const router = require('../src/routes/adminDashboard');
function renderRoute(at) {
  const layer = router.stack.find((l) => l.route && l.route.path === at);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {}, headers: {} }, { type: () => ({ send: resolve }) }));
}
const scripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
function fnSrc(script, name) {
  const i = script.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is in the page');
  const line = script.slice(i + 1, script.indexOf('\n', i + 1));
  return /\}\s*$/.test(line) ? line : script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}

test('the shared module is plain template text: no backticks, no dollar-brace, no backslashes; the script parses', () => {
  for (const k of ['STAGE_CHANGE_CSS', 'STAGE_CHANGE_JS']) {
    assert.ok(!/`/.test(ui[k]), k + ' has a backtick');
    assert.ok(!/\$\{/.test(ui[k]), k + ' has a dollar-brace');
    assert.ok(!/\\/.test(ui[k]), k + ' has a backslash');
  }
  new vm.Script(ui.STAGE_CHANGE_JS);
  assert.match(ui.STAGE_CHANGE_CSS, /@media print \{ \.stc-btn, \.stc-ok \{ display:none !important; \} \}/);
  assert.match(ui.STAGE_CHANGE_CSS, /@media \(max-width: 760px\) \{ \.stc-dlg \.stc-sel, \.stc-dlg \.stc-reason, \.stc-dlg \.tdlg-btn \{ font-size:16px; \} \}/);
});

test('Client Master page: carries the pop-up once, every script parses (All and Summary), the Change… button is guarded by canChangeStage, never opens the case, and is hidden in print', async () => {
  const html = await renderRoute('/');
  scripts(html).forEach((s, i) => { try { new vm.Script(s); } catch (e) { assert.fail('Client Master script #' + (i + 1) + ' does not parse: ' + e.message); } });
  for (const s of scripts(await renderRoute('/summary'))) new vm.Script(s);
  assert.equal(html.split('window.tdotStageChange = function').length - 1, 1);
  assert.equal(html.split('.stc-dlg .stc-sel {').length - 1, 1);
  assert.ok(html.includes("if (c.canChangeStage) stage += ' <button type=\"button\" class=\"stc-btn\" data-stc=\""));
  assert.ok(html.includes("if (sb) sb.onclick = function(e) { e.stopPropagation(); cmStageDlg(String(c.id)); };"), 'the button never opens the case');
  assert.ok(html.includes("previewUrl: '/admin/client-master/stage-options',"));
  assert.ok(html.includes("url: '/admin/client-master/stage',"));
  assert.match(html, /@media print \{[\s\S]*?\.lt-pop, \.stc-btn, \.stc-ok, \.cm-assign/);
  // the row follows the server's rebuilt row and the list redraws from the rows — no board read
  const apply = html.slice(html.indexOf('function cmStcApply'), html.indexOf('function cmStageDlg'));
  assert.ok(apply.includes('CasesTable.setRows(_data.cases);'));
  assert.ok(apply.includes('if (r.waiting) row.waiting = r.waiting; else delete row.waiting;'));
  const dlg = html.slice(html.indexOf('function cmStageDlg'), html.indexOf('/* ── Helpers ─'));
  assert.ok(!/fetchData|dashboard-stats|location\.reload|loadData/.test(apply + dlg));
  assert.ok(dlg.includes("cmStcFlash(itemId, j && j.unchanged ? 'No change needed' : '✓ Stage changed');"));
});

test('the row: the button and the flash sit right after the stage on EVERY tab (All and the view tabs), only with canChangeStage; before "Waiting for"', async () => {
  const html = await renderRoute('/');
  const main = scripts(html).find((s) => s.includes('function caseRow('));
  const el = () => ({ innerHTML: '', style: {}, className: '', title: '', onclick: null, querySelector() { return null; } });
  const ctx = { window: { TDOT_IS_ADMIN: false }, document: { createElement: el, getElementById: () => null }, Date, isNaN, isFinite, String, Math,
    CM_FLASH: {}, CM_DL_FLASH: {}, CM_STC_FLASH: {}, TDOT_DEL_SVG: '[bin]', CM_PRE_ONBOARDING: cmv.PRE_ONBOARDING_INDEX, _data: null, CM_TABCOLS: JSON.parse(main.match(/var CM_TABCOLS = (.*);/)[1]) };
  vm.createContext(ctx);
  const names = ['caseRow', 'cmColIds', 'cmTextCell', 'cmPctCell', 'cmPortalCell', 'escHtml', 'healthBadge', 'shortType', 'cmNoneDash', 'cmDay', 'cmFlashText', 'cmDlFlashText', 'cmStcFlashText'];
  vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' + names.map((n) => fnSrc(main, n)).join('\n'), ctx);
  const V = Object.fromEntries(cmv.pageViews().map((v) => [v.key, v]));
  const ROW = { id: '9', caseRef: '2026-XX-001', clientName: 'Test Person', caseType: 'Visitor Visa', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Green' };
  const BTN = '<button type="button" class="stc-btn" data-stc="9"';
  for (const v of [null, V.assigning, V.deadlines, V.eeita]) {
    const name = v ? v.key : 'All';
    assert.ok(!ctx.caseRow(ROW, v, '2026-11-26').innerHTML.includes('stc-btn'), name + ': no flag, no button');
    const h = ctx.caseRow({ ...ROW, canChangeStage: true }, v, '2026-11-26').innerHTML;
    assert.equal(h.split(BTN).length - 1, 1, name + ': one button');
    assert.ok(h.indexOf('Internal Review') < h.indexOf(BTN), name + ': after the stage');
  }
  ctx.CM_STC_FLASH['9'] = { text: '✓ Stage changed', until: Date.now() + 5000 };
  assert.ok(ctx.caseRow(ROW, V.assigning, '2026-11-26').innerHTML.includes('<span class="stc-ok" data-stc-ok="9" role="status">✓ Stage changed</span>'));
  // a Pre-Onboarding row on Assigning: the button comes before its "Waiting for" line
  const pre = ctx.caseRow({ ...ROW, caseStage: 'Pre-Onboarding', stageIdx: cmv.PRE_ONBOARDING_INDEX, canChangeStage: true, waiting: { code: 'unchecked', also: [] } }, V.assigning, '2026-11-26').innerHTML;
  if (pre.includes('class="cm-wait')) assert.ok(pre.indexOf(BTN) < pre.indexOf('class="cm-wait'));
});

test('the routes: GET stage-options and POST stage go to caseStageService with the source set by the route; the per-row flag comes from markChangeable; no case-page route yet', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const g = src.indexOf("app.get('/admin/client-master/stage-options'");
  assert.ok(g > 0);
  assert.match(src.slice(g, g + 600), /caseStageService'\)\.preview\(\{ staff, hasKey, itemId: req\.query\.itemId, expected: req\.query\.expected \}\)/);
  assert.match(src.slice(g, g + 600), /res\.set\('Cache-Control', 'no-store'\)/);
  assert.match(src, /app\.post\('\/admin\/client-master\/stage', express\.json\(\), stageChangeRoute\('client-master'\)\);/);
  const route = src.slice(src.indexOf('function stageChangeRoute'), src.indexOf("app.post('/admin/client-master/stage'"));
  assert.match(route, /change\(\{ staff, hasKey, body: req\.body, source \}\)/);
  assert.match(route, /The result is unknown — check the case in Monday before trying again\./);
  assert.ok(!/req\.body\.source/.test(route));
  const ds = src.slice(src.indexOf("app.get('/admin/dashboard-stats'"), src.indexOf("app.get('/admin/needs-attention'"));
  assert.match(ds, /require\('\.\/services\/caseStageService'\)\.markChangeable\(stats\.cases\);/);
  assert.ok(ds.indexOf('markChangeable') > ds.indexOf('markAssignable'), 'after canAssign is set');
  assert.ok(!/\/admin\/case-stage|\/admin\/case-action\/:caseRef\/stage/.test(src), 'the case page has no stage route yet');
  const cockpit = require('../src/routes/adminCase').buildCockpitHTML('2026-TEST-001');
  assert.ok(!cockpit.includes('tdotStageChange'), 'the case page does not carry the pop-up yet');
});

// ── the pop-up run in a sandbox: a fake shared pop-up, elements by id, scripted answers ──
function sandbox(responses) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, value: '', textContent: '', innerHTML: '', disabled: false, onclick: null, onchange: null, oninput: null, focus() { this.focused = true; } });
  const fetches = [], queue = responses.slice(), saved = [], current = [], focused = [];
  const dlg = { box: null, openId: 1, busy: false, closed: false,
    setBusy(on) { this.busy = !!on; return this; }, still(id) { return !this.closed && id === this.openId; }, tryClose() { this.closed = true; }, close() { this.closed = true; } };
  dlg.box = { set innerHTML(h) { this._h = h; }, get innerHTML() { return this._h; }, querySelector: (sel) => el(sel.replace(/^#/, '')) };
  const ctx = {
    JSON, String, Array, Promise, encodeURIComponent,
    window: {}, location: { pathname: '/admin/dashboard', search: '?view=assigning' },
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    peekKey: () => '',
    tdotDialogNew: () => dlg,
    fetch: (url, opts) => {
      fetches.push({ url, opts: opts || {} });
      const r = queue.shift() || { status: 500, j: {} };
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.j) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(ui.STAGE_CHANGE_JS, ctx);
  const open = (o) => ctx.window.tdotStageChange({ previewUrl: '/admin/client-master/stage-options', url: '/admin/client-master/stage', itemId: '5550001', caseLine: '2026-TEST-001 · Client X',
    nowLabel: 'Pre-Onboarding', expected: 12, onSaved: (j) => saved.push(j), onCurrent: (c, r) => current.push({ c, r }), focusBack: () => focused.push(1), ...(o || {}) });
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { els, el, fetches, dlg, saved, current, focused, open, flush, queue };
}
const OPT = (index, label, o) => ({ index, label, allowed: true, why: '', effects: [], reasonRequired: false, unlocks: false, locks: false, backward: false, ...o });
const PREVIEW = { ok: true, itemId: '5550001', current: { index: 12, label: 'Pre-Onboarding' }, reasonMin: 5, reasonMax: 300, options: [
  OPT(3, 'Retainer Confirmed'),
  OPT(0, 'Document Collection Started', { effects: ['The client is emailed “Your case is ready” now, and the document checklist is set up.'] }),
  OPT(7, 'Submission Ready', { reasonRequired: true, locks: true, effects: ['This locks the case — reminders, readiness checks and escalations stop.', 'It also emails the Submission Team and the Case Manager.'] }),
  OPT(12, 'Pre-Onboarding', { allowed: false, why: 'This is the stage now.' }),
  OPT(1, 'Internal Review', { allowed: false, why: 'A case can only go to … (test)' }),
] };

test('pop-up: asks the server first (with the page\'s stage), lists the stages in its order with the not-allowed disabled and why, the effects of the chosen one, the reason required when the server says so', async () => {
  const sb = sandbox([{ status: 200, j: PREVIEW }]);
  sb.open();
  assert.match(sb.dlg.box.innerHTML, /<h3 id="stc-h">Change stage<\/h3><div class="stc-case">2026-TEST-001 · Client X<\/div>/);
  assert.equal(sb.el('stc-now').innerHTML, 'Now: <b>Pre-Onboarding</b>');
  assert.equal(sb.el('stc-go').disabled, true);
  await sb.flush();
  assert.equal(sb.fetches[0].url, '/admin/client-master/stage-options?itemId=5550001&expected=12');
  assert.equal(sb.fetches[0].opts.credentials, 'same-origin');
  const sel = sb.el('stc-sel');
  assert.equal(sel.disabled, false);
  assert.equal(sel.innerHTML, '<option value="">Choose a stage…</option><option value="3">Retainer Confirmed</option><option value="0">Document Collection Started</option>' +
    '<option value="7">Submission Ready</option><option value="12" disabled>Pre-Onboarding (not available)</option><option value="1" disabled>Internal Review (not available)</option>');
  assert.equal(sb.el('stc-off').innerHTML, '<li><b>Internal Review</b>: A case can only go to … (test)</li>', 'why, for every refused stage but the current one');
  assert.equal(sb.current.length, 0, 'the page already showed this stage');
  sel.value = '7'; sel.onchange();
  assert.match(sb.el('stc-fx').innerHTML, /<li class="warn">This locks the case — reminders, readiness checks and escalations stop\.<\/li><li>It also emails the Submission Team and the Case Manager\.<\/li>/);
  assert.equal(sb.el('stc-reason-l').textContent, 'Reason (required)');
  assert.equal(sb.el('stc-go').disabled, true, 'no reason yet');
  sb.el('stc-reason').value = 'abc'; sb.el('stc-reason').oninput();
  assert.equal(sb.el('stc-go').disabled, true, 'too short');
  sb.el('stc-reason').value = 'Ready for submission'; sb.el('stc-reason').oninput();
  assert.equal(sb.el('stc-go').disabled, false);
  sel.value = '3'; sel.onchange();
  assert.equal(sb.el('stc-reason-l').textContent, 'Reason (optional)');
  assert.equal(sb.el('stc-fx').innerHTML, '');
  assert.equal(sb.el('stc-go').disabled, false);
});

test('pop-up: Change stage sends itemId / index / expected / reason; a save calls onSaved, closes and gives the focus back', async () => {
  const sb = sandbox([{ status: 200, j: PREVIEW }, { status: 200, j: { ok: true, stage: { index: 7, label: 'Submission Ready' }, row: { caseStage: 'Submission Ready', stageIdx: 7, views: [], waiting: null } } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '7'; sb.el('stc-sel').onchange();
  sb.el('stc-reason').value = 'Ready\nfor submission'; sb.el('stc-reason').oninput();
  sb.el('stc-go').onclick();
  assert.equal(sb.dlg.busy, true);
  assert.equal(sb.el('stc-go').disabled, true);
  await sb.flush();
  const post = sb.fetches[1];
  assert.equal(post.url, '/admin/client-master/stage');
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual(JSON.parse(post.opts.body), { itemId: '5550001', index: 7, expected: 12, reason: 'Ready for submission' });
  assert.equal(sb.saved.length, 1);
  assert.equal(sb.dlg.closed, true);
  assert.equal(sb.focused.length, 1);
});

test('pop-up: a 409 "changed" tells the page the stage now, asks the server again from there and says to choose again', async () => {
  const later = { ...PREVIEW, current: { index: 1, label: 'Internal Review' } };
  const sb = sandbox([{ status: 200, j: PREVIEW },
    { status: 409, j: { ok: false, code: 'changed', error: 'Someone changed the stage since your page loaded — it is now Internal Review.', current: { index: 1, label: 'Internal Review' }, row: { caseStage: 'Internal Review', stageIdx: 1 } } },
    { status: 200, j: later }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange();
  sb.el('stc-go').onclick(); await sb.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(sb.current[0])), { c: { index: 1, label: 'Internal Review' }, r: { caseStage: 'Internal Review', stageIdx: 1 } });
  assert.equal(sb.fetches[2].url, '/admin/client-master/stage-options?itemId=5550001&expected=12');
  assert.equal(sb.el('stc-now').innerHTML, 'Now: <b>Internal Review</b>');
  assert.equal(sb.el('stc-err').textContent, 'Someone changed the stage since your page loaded — it is now Internal Review. Check what will happen and choose again.');
  assert.equal(sb.dlg.closed, false);
  assert.equal(sb.saved.length, 0);
  // the next send carries the stage Monday has now
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange();
  sb.queue.push({ status: 200, j: { ok: true, stage: { index: 3, label: 'Retainer Confirmed' } } });
  sb.el('stc-go').onclick(); await sb.flush();
  assert.equal(JSON.parse(sb.fetches[3].opts.body).expected, 1);
});

test('pop-up: the note failed → says so and offers Close; a refusal shows the server\'s words; 401 → a sign-in link back to this page', async () => {
  let sb = sandbox([{ status: 200, j: PREVIEW }, { status: 200, j: { ok: true, noteFailed: true, stage: { index: 3, label: 'Retainer Confirmed' } } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange(); sb.el('stc-go').onclick(); await sb.flush();
  assert.equal(sb.saved.length, 1);
  assert.equal(sb.dlg.closed, false);
  assert.match(sb.el('stc-err').textContent, /^Stage changed\. The note may not have been added/);
  assert.match(sb.el('stc-acts').innerHTML, /id="stc-close">Close</);
  sb = sandbox([{ status: 200, j: PREVIEW }, { status: 400, j: { ok: false, error: 'Give a short reason for this change (at least 5 characters).', code: 'reason' } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange(); sb.el('stc-go').onclick(); await sb.flush();
  assert.equal(sb.el('stc-err').textContent, 'Give a short reason for this change (at least 5 characters).');
  assert.equal(sb.dlg.busy, false);
  sb = sandbox([{ status: 401, j: { ok: false, error: 'Sign in with Monday to change the stage.', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' } }]);
  sb.open(); await sb.flush();
  assert.equal(sb.el('stc-err').innerHTML, 'Sign in with Monday to change the stage. <a href="/q/auth/monday?returnTo=%2Fadmin%2Fdashboard%3Fview%3Dassigning">Sign in with Monday</a>');
  sb = sandbox([{ status: 404, j: { ok: false, error: 'Changing the stage from this page is not switched on.', code: 'off' } }]);
  sb.open(); await sb.flush();
  assert.equal(sb.el('stc-err').textContent, 'Changing the stage from this page is not switched on.');
  assert.equal(sb.el('stc-go').disabled, true);
});
