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
  // the row flash floats out of the flow (no row-height jump when it shows or goes)
  assert.match(ui.STAGE_CHANGE_CSS, /\.stc-wrap \{ position:relative; display:inline-block; \}/);
  assert.match(ui.STAGE_CHANGE_CSS, /\.stc-ok \{ position:absolute; [^}]*pointer-events:none; white-space:nowrap;/);
  assert.match(ui.STAGE_CHANGE_CSS, /@media \(max-width: 760px\) \{ \.stc-dlg \.stc-sel, \.stc-dlg \.stc-reason, \.stc-dlg \.tdlg-btn \{ font-size:16px; \} \}/);
});

test('Client Master page: carries the pop-up once, every script parses (All and Summary), the Change… button is guarded by canChangeStage, never opens the case, and is hidden in print', async () => {
  const html = await renderRoute('/');
  scripts(html).forEach((s, i) => { try { new vm.Script(s); } catch (e) { assert.fail('Client Master script #' + (i + 1) + ' does not parse: ' + e.message); } });
  for (const s of scripts(await renderRoute('/summary'))) new vm.Script(s);
  assert.equal(html.split('window.tdotStageChange = function').length - 1, 1);
  assert.equal(html.split('.stc-dlg .stc-sel {').length - 1, 1);
  assert.ok(html.includes("if (c.canChangeStage || stOk) stage += ' <span class=\"stc-wrap\">' +"));
  assert.ok(html.includes("(c.canChangeStage ? '<button type=\"button\" class=\"stc-btn\" data-stc=\"' + escHtml(String(c.id)) + '\" title=\"Change stage\" aria-label=\"Change stage\">Change…</button>' : '')"),
    'screen readers hear "Change stage"; the visible text stays Change…');
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
  const BTN = '<button type="button" class="stc-btn" data-stc="9" title="Change stage" aria-label="Change stage">Change…</button>';
  for (const v of [null, V.assigning, V.deadlines, V.eeita]) {
    const name = v ? v.key : 'All';
    assert.ok(!ctx.caseRow(ROW, v, '2026-11-26').innerHTML.includes('stc-btn'), name + ': no flag, no button');
    const h = ctx.caseRow({ ...ROW, canChangeStage: true }, v, '2026-11-26').innerHTML;
    assert.equal(h.split(BTN).length - 1, 1, name + ': one button');
    assert.ok(h.includes(' <span class="stc-wrap">' + BTN + '</span>'), name + ': inside the wrap the flash floats from');
    assert.ok(h.indexOf('Internal Review') < h.indexOf(BTN), name + ': after the stage');
  }
  ctx.CM_STC_FLASH['9'] = { text: '✓ Stage changed', until: Date.now() + 5000 };
  const FL = '<span class="stc-ok" data-stc-ok="9" role="status">✓ Stage changed</span>';
  assert.ok(ctx.caseRow(ROW, V.assigning, '2026-11-26').innerHTML.includes(' <span class="stc-wrap">' + FL + '</span>'), 'the flash alone still sits in the wrap');
  assert.ok(ctx.caseRow({ ...ROW, canChangeStage: true }, V.assigning, '2026-11-26').innerHTML.includes(' <span class="stc-wrap">' + BTN + FL + '</span>'),
    'the flash floats beside the button, out of the flow');
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
  // the fake shared pop-up runs onClosed on every close, like dialogUi; the page's focus is wherever doc.activeElement says
  const doc = { body: { contains: (e) => !!(e && e.inPage) }, activeElement: null };
  doc.activeElement = doc.body;
  const dlg = { box: null, openId: 1, busy: false, closed: false, opts: null,
    setBusy(on) { this.busy = !!on; return this; }, still(id) { return !this.closed && id === this.openId; },
    tryClose(how) { return this.close(true, how); },
    close(force, how) { if (this.closed) return false; this.closed = true; if (this.opts && this.opts.onClosed) this.opts.onClosed(how || ''); return true; } };
  dlg.box = { set innerHTML(h) { this._h = h; }, get innerHTML() { return this._h; }, querySelector: (sel) => el(sel.replace(/^#/, '')) };
  const ctx = {
    JSON, String, Array, Promise, encodeURIComponent,
    window: {}, document: doc, location: { pathname: '/admin/dashboard', search: '?view=assigning' },
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    peekKey: () => '',
    tdotDialogNew: (opts) => { dlg.opts = opts || {}; return dlg; },
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
  return { els, el, fetches, dlg, doc, saved, current, focused, open, flush, queue };
}
const OPT = (index, label, o) => ({ index, label, allowed: true, why: '', effects: [], reasonRequired: false, unlocks: false, locks: false, backward: false, ...o });
const PREVIEW = { ok: true, itemId: '5550001', current: { index: 12, label: 'Pre-Onboarding' }, reasonMin: 5, reasonMax: 300, options: [
  OPT(3, 'Retainer Confirmed'),
  OPT(0, 'Document Collection Started', { effects: ['The client is emailed “Your case is ready” now, and the document checklist is set up.'], warn: [true] }),
  OPT(7, 'Submission Ready', { reasonRequired: true, locks: true, effects: ['This locks the case — reminders, readiness checks and escalations stop.', 'It also emails the Submission Team and the Case Manager.'], warn: [true, true] }),
  OPT(6, 'Application Submitted', { effects: ['The case stays locked.', 'This does not lock or close the case.'], warn: [false, false] }),
  OPT(12, 'Pre-Onboarding', { allowed: false, why: 'This is the stage now.' }),
  OPT(1, 'Internal Review', { allowed: false, why: 'A case can only go to … (test)' }),
] };

test('pop-up: asks the server first (with the page\'s stage), lists the stages in its order with the not-allowed disabled and why, the effects of the chosen one, the reason required when the server says so', async () => {
  const sb = sandbox([{ status: 200, j: PREVIEW }]);
  sb.open();
  assert.match(sb.dlg.box.innerHTML, /<h3 id="stc-h">Change stage<\/h3><div class="stc-moved" id="stc-moved" role="status"><\/div><div class="stc-case">2026-TEST-001 · Client X<\/div>/);
  assert.equal(sb.el('stc-now').innerHTML, 'Now: <b>Pre-Onboarding</b>');
  assert.equal(sb.el('stc-go').disabled, true);
  await sb.flush();
  assert.equal(sb.fetches[0].url, '/admin/client-master/stage-options?itemId=5550001&expected=12');
  assert.equal(sb.fetches[0].opts.credentials, 'same-origin');
  const sel = sb.el('stc-sel');
  assert.equal(sel.disabled, false);
  assert.equal(sel.innerHTML, '<option value="">Choose a stage…</option><option value="3">Retainer Confirmed</option><option value="0">Document Collection Started</option>' +
    '<option value="7">Submission Ready</option><option value="6">Application Submitted</option><option value="12" disabled>Pre-Onboarding (now)</option><option value="1" disabled>Internal Review (not available)</option>');
  assert.equal(sb.el('stc-off').innerHTML, '<li><b>Internal Review</b>: A case can only go to … (test)</li>', 'why, for every refused stage but the current one');
  assert.equal(sb.el('stc-why').hidden, false, 'the toggle is there when some stage is refused');
  assert.equal(sb.el('stc-moved').textContent, '', 'the page showed this stage: no "changed" line');
  assert.equal(sb.el('stc-now').innerHTML, 'Now: <b>Pre-Onboarding</b>', 'not locked: nothing added');
  assert.equal(sb.el('stc-hint').textContent, '', 'nothing chosen: no count');
  assert.equal(sb.current.length, 0, 'the page already showed this stage');
  sel.value = '7'; sel.onchange();
  assert.equal(sb.el('stc-fx').innerHTML, '<li class="warn">This locks the case — reminders, readiness checks and escalations stop.</li><li class="warn">It also emails the Submission Team and the Case Manager.</li>',
    'the style follows the server\'s warn flags: the staff email is a warning');
  assert.equal(sb.el('stc-reason-l').textContent, 'Reason (required, at least 5 characters)', 'the minimum is said before the button stays grey');
  assert.equal(sb.el('stc-go').disabled, true, 'no reason yet');
  assert.equal(sb.el('stc-hint').textContent, '5 more characters needed');
  sb.el('stc-reason').value = 'abc'; sb.el('stc-reason').oninput();
  assert.equal(sb.el('stc-go').disabled, true, 'too short');
  assert.equal(sb.el('stc-hint').textContent, '2 more characters needed', 'the count follows the typing');
  sb.el('stc-reason').value = 'ab\t\tc'; sb.el('stc-reason').oninput();
  assert.equal(sb.el('stc-go').disabled, true, 'white space counts as the server counts it (one space): "ab c" is 4');
  assert.equal(sb.el('stc-hint').textContent, '1 more character needed');
  sb.el('stc-reason').value = 'a   b  c'; sb.el('stc-reason').oninput();
  assert.equal(sb.el('stc-go').disabled, false, '"a b c" is 5');
  assert.equal(sb.el('stc-hint').textContent, '', 'long enough: no count');
  sb.el('stc-reason').value = 'Ready for submission'; sb.el('stc-reason').oninput();
  assert.equal(sb.el('stc-go').disabled, false);
  sel.value = '6'; sel.onchange();
  assert.equal(sb.el('stc-fx').innerHTML, '<li>The case stays locked.</li><li>This does not lock or close the case.</li>', 'no warning style on plain lines that merely mention a lock');
  sel.value = '0'; sel.onchange();
  assert.equal(sb.el('stc-fx').innerHTML, '<li class="warn">The client is emailed “Your case is ready” now, and the document checklist is set up.</li>', 'the client email is a warning');
  sb.el('stc-reason').value = ''; sb.el('stc-reason').oninput();
  sel.value = '3'; sel.onchange();
  assert.equal(sb.el('stc-reason-l').textContent, 'Reason (optional)');
  assert.equal(sb.el('stc-hint').textContent, '', 'optional: no count, even when empty');
  assert.equal(sb.el('stc-fx').innerHTML, '');
  assert.equal(sb.el('stc-go').disabled, false);
});

test('pop-up: Change stage sends itemId / index / expected / reason; a save calls onSaved, closes and gives the focus back', async () => {
  const sb = sandbox([{ status: 200, j: PREVIEW }, { status: 200, j: { ok: true, stage: { index: 7, label: 'Submission Ready' }, row: { caseStage: 'Submission Ready', stageIdx: 7, views: [], waiting: null } } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '7'; sb.el('stc-sel').onchange();
  sb.el('stc-reason').value = '  Ready\n\n  for   submission '; sb.el('stc-reason').oninput();
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
  assert.equal(sb.focused.length, 1, 'the row was redrawn (focus on the page body): the page puts it on the new button');
});

test('pop-up: the focus comes back on EVERY close once its button is gone (note-failed Close, ×/Escape after a 409) — and is left alone when it is somewhere real', async () => {
  let sb = sandbox([{ status: 200, j: PREVIEW }, { status: 200, j: { ok: true, noteFailed: true, stage: { index: 3, label: 'Retainer Confirmed' } } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange(); sb.el('stc-go').onclick(); await sb.flush();
  assert.equal(sb.dlg.closed, false);
  assert.equal(sb.focused.length, 0);
  sb.el('stc-close').onclick();
  assert.equal(sb.dlg.closed, true);
  assert.equal(sb.focused.length, 1, 'Close after "note may not have been added" puts the focus back');
  sb = sandbox([{ status: 200, j: PREVIEW }]);
  sb.open(); await sb.flush();
  sb.dlg.tryClose('escape');
  assert.equal(sb.focused.length, 1, 'Escape / × with the focus lost');
  sb = sandbox([{ status: 200, j: PREVIEW }]);
  sb.open(); await sb.flush();
  sb.doc.activeElement = { inPage: true };   // the shared pop-up already put it back on the (still present) button
  sb.el('stc-cancel').onclick();
  assert.equal(sb.dlg.closed, true);
  assert.equal(sb.focused.length, 0, 'never moves a focus that is somewhere real');
});

test('pop-up: saved with a warning (the lock not confirmed, or a renamed stage) → says "Stage changed." and the warning, offers Close; onSaved still runs', async () => {
  const w = 'Monday still shows the Automation Lock as “Yes”, not No — check it in Monday; reminders and checks stay off while the case is locked.';
  const sb = sandbox([{ status: 200, j: PREVIEW }, { status: 200, j: { ok: true, lockUnconfirmed: true, unlocked: false, warning: w, stage: { index: 3, label: 'Retainer Confirmed' } } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange(); sb.el('stc-go').onclick(); await sb.flush();
  assert.equal(sb.saved.length, 1);
  assert.equal(sb.dlg.closed, false);
  assert.equal(sb.dlg.busy, false);
  assert.equal(sb.el('stc-err').textContent, 'Stage changed. ' + w);
  assert.match(sb.el('stc-acts').innerHTML, /id="stc-close">Close</);
  assert.equal(sb.el('stc-close').focused, true);
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
  assert.equal(sb.el('stc-moved').textContent, 'The stage changed since your page loaded — it is now Internal Review.');
  assert.equal(sb.el('stc-err').textContent, 'Nothing was changed. Check what will happen and choose again.', 'the line at the top says the stage now; the error only that nothing was written');
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
  // the shared key still on the page, the Monday sign-in expired: 403 key-only → the same sign-in link (as Assign), on load and on send
  sb = sandbox([{ status: 403, j: { ok: false, error: 'Sign in with Monday to change the stage.', code: 'key-only' } }]);
  sb.open(); await sb.flush();
  assert.equal(sb.el('stc-err').innerHTML, 'Sign in with Monday to change the stage. <a href="/q/auth/monday?returnTo=%2Fadmin%2Fdashboard%3Fview%3Dassigning">Sign in with Monday</a>');
  sb = sandbox([{ status: 200, j: PREVIEW }, { status: 403, j: { ok: false, error: 'Sign in with Monday to change the stage.', code: 'key-only' } }]);
  sb.open(); await sb.flush();
  sb.el('stc-sel').value = '3'; sb.el('stc-sel').onchange(); sb.el('stc-go').onclick(); await sb.flush();
  assert.equal(sb.el('stc-err').innerHTML, 'Sign in with Monday to change the stage. <a href="/q/auth/monday?returnTo=%2Fadmin%2Fdashboard%3Fview%3Dassigning">Sign in with Monday</a>');
  // any other 403 stays plain words
  sb = sandbox([{ status: 403, j: { ok: false, error: 'You are not assigned to this case.' } }]);
  sb.open(); await sb.flush();
  assert.equal(sb.el('stc-err').textContent, 'You are not assigned to this case.');
  assert.equal(sb.el('stc-err').innerHTML, '');
  sb = sandbox([{ status: 404, j: { ok: false, error: 'Changing the stage from this page is not switched on.', code: 'off' } }]);
  sb.open(); await sb.flush();
  assert.equal(sb.el('stc-err').textContent, 'Changing the stage from this page is not switched on.');
  assert.equal(sb.el('stc-go').disabled, true);
});

test('pop-up: the layout — the "why greyed out" list sits in a closed toggle under the reason, the neutral placeholder, the count is tied to the box', () => {
  const sb = sandbox([]);
  sb.open();
  const h = sb.dlg.box.innerHTML;
  assert.match(h, /<details class="stc-why" id="stc-why" hidden><summary>Why are some stages greyed out\?<\/summary><ul class="stc-off" id="stc-off"><\/ul><\/details>/);
  assert.ok(!/<details[^>]*\bopen\b/.test(h), 'closed by default');
  assert.ok(h.indexOf('id="stc-fx"') < h.indexOf('id="stc-reason"') && h.indexOf('id="stc-reason"') < h.indexOf('id="stc-hint"') && h.indexOf('id="stc-hint"') < h.indexOf('id="stc-why"'),
    'effects, then the reason and its count, then the toggle');
  assert.ok(h.indexOf('id="stc-why"') < h.indexOf('class="stc-what"'));
  assert.ok(h.indexOf('id="stc-sel"') < h.indexOf('id="stc-fx"') && h.indexOf('id="stc-off"') > h.indexOf('id="stc-fx"'), 'the refused list is no longer right under the select');
  assert.match(h, /placeholder="Why are you changing the stage\?" aria-describedby="stc-hint"/);
  assert.match(h, /<h3 id="stc-h">Change stage<\/h3><div class="stc-moved" id="stc-moved" role="status"><\/div>/, 'the "changed" line is at the top');
});

test('pop-up: no refused stage but the current one → no toggle; a locked case says " · locked"; the page\'s stage was stale → one amber line at the top and the row is redrawn', async () => {
  const P = { ...PREVIEW, locked: true, current: { index: 1, label: 'Internal Review' }, options: [OPT(3, 'Retainer Confirmed'), OPT(1, 'Internal Review', { allowed: false, why: 'This is the stage now.' })] };
  const sb = sandbox([{ status: 200, j: P }]);
  sb.open(); await sb.flush();
  assert.equal(sb.el('stc-why').hidden, true, 'nothing to explain: no toggle');
  assert.equal(sb.el('stc-off').innerHTML, '');
  assert.equal(sb.el('stc-sel').innerHTML, '<option value="">Choose a stage…</option><option value="3">Retainer Confirmed</option><option value="1" disabled>Internal Review (now)</option>');
  assert.equal(sb.el('stc-now').innerHTML, 'Now: <b>Internal Review</b><span class="stc-lk"> · locked</span>');
  assert.equal(sb.el('stc-moved').textContent, 'The stage changed since your page loaded — it is now Internal Review.');
  assert.equal(sb.current.length, 1, 'the row is still redrawn');
  // the stage went to blank meanwhile: said as "No stage"
  const sb2 = sandbox([{ status: 200, j: { ...PREVIEW, current: { index: 5, label: '' } } }]);
  sb2.open(); await sb2.flush();
  assert.equal(sb2.el('stc-moved').textContent, 'The stage changed since your page loaded — it is now No stage.');
  assert.equal(sb2.el('stc-now').innerHTML, 'Now: <b>No stage</b>');
});
