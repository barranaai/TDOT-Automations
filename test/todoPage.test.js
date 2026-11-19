'use strict';

// The To-do tab on the Client Master page — stage 1, READ-ONLY (Faran 2026-11-19): the PAGE and the TOP BAR.
// (The switch, the data answer and the list engine's part are in test/todoList.test.js; the pure helpers in
// test/todoUi.test.js.)
//
// What each mode of the switch TODO_TAB promises, pinned here:
//   • the top bar is byte for byte the six-link bar while the switch is off or on for admins only (sha256 values taken
//     from the clean tree, origin/main 36636cd); fully on, it gains the link and its own small style;
//   • a page WITHOUT the tab (off; admins for anyone who is not a named admin signed in with Monday; the Summary page
//     always) has today's tabs, columns and column names — literal copies of the clean tree — and not a word of the tab;
//   • a page WITH the tab: To-do is the last tab, with its twelve columns in order; the other tabs are as they were.
// Then the page's own behaviour, with the REAL emitted scripts run over a small made-up page (the style of
// test/clientMasterColumnChooser.test.js): the address, the kept choice, the picker, the numbers, the words.
// All made-up people and cases (Officer One, Reviewer One, Test Client 1 …). Nothing here reaches a network.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');
const crypto = require('crypto');

const T         = require('../src/services/todoListService');
const cmv       = require('../src/services/clientMasterViews');
const dash      = require('../src/services/dashboardService');
const S         = require('../src/routes/listSpecs');
const shared    = require('../src/routes/adminShared');
const staffAuth = require('../src/middleware/staffAuth');
const todoPage  = require('../src/routes/todoPage');
const { todoUi } = require('../src/routes/todoUi');
const { listCore } = require('../src/routes/listFilters');
const router    = require('../src/routes/adminDashboard');
const META_FIX  = require('./fixtures/client-master-board-meta.json');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** Run with these environment values (undefined = not set), then put them back — also for an async body. */
function withEnv(vars, fn) {
  const keep = {};
  for (const k of Object.keys(vars)) { keep[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const back = () => { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } };
  let out;
  try { out = fn(); } catch (e) { back(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { back(); return v; }, (e) => { back(); throw e; });
  back();
  return out;
}
/** A page of the dashboard router, asked the way Express would: req is whatever the test says the browser sent. */
function renderRoute(path, req) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle(req || { query: {} }, { type: () => ({ send: resolve }) }));
}
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* What a page without the tab must never carry (spec §1). */
const TAB_WORDS = ['todoUi', 'tdot_list_cases_todo_who', 'To-do', 'view=todo', 'todoWith'];
/* Today's values — LITERAL copies taken from the clean tree (origin/main 36636cd), exactly as the page emits them. */
const VIEWS_TODAY = "[{\"key\":\"assigning\",\"label\":\"Assigning\",\"hint\":\"Like Monday's Assigning view: open stages (not Application Submitted, Cancelled, Profile Created/Linked/Reviewed/Updated, Task Done, Ads posted, LMIA Submitted or empty), not in Leads, Cancel or TEST. Grouped by Case Stage.\",\"mondayViewId\":\"260858028\",\"by\":\"stage\",\"dir\":\"ASC\",\"groupOrder\":\"position\",\"sort\":null,\"stageStrip\":true,\"deadlineBox\":false},{\"key\":\"deadlines\",\"label\":\"Deadlines\",\"hint\":\"Like Monday's Deadlines view: Phase filled in, and the stage is not Application Submitted, ADR, Profile Created/Linked/Reviewed/Updated, Task Done or LMIA Submitted. So Cancelled, Ads posted and no-stage cases with a Phase show too, and so do rows in the Leads, Cancel or TEST groups, as on Monday. Grouped by Phase.\",\"mondayViewId\":\"260886949\",\"by\":\"phase\",\"dir\":\"ASC\",\"groupOrder\":\"position\",\"sort\":null,\"stageStrip\":false,\"deadlineBox\":true},{\"key\":\"eeita\",\"label\":\"EE after ITA\",\"hint\":\"Like Monday's EE after ITA view: case type Canadian Experience Class (EE after ITA), open stages (not Application Submitted, Cancelled, Profile Created/Linked/Reviewed/Updated, Task Done, Ads posted or LMIA Submitted), not in Leads, Cancel or TEST. Grouped by board group.\",\"mondayViewId\":\"287709906\",\"by\":\"board\",\"dir\":\"ASC\",\"groupOrder\":\"position\",\"sort\":null,\"stageStrip\":false,\"deadlineBox\":false}]";
const TABCOLS_TODAY = "{\"\":[\"caseRef\",\"clientName\",\"caseType\",\"caseStage\",\"phase\",\"deadline\",\"promised\",\"health\",\"slaRisk\",\"officer\",\"manager\",\"overallReadiness\",\"daysElapsed\",\"status\",\"del\"],\"assigning\":[\"caseRef\",\"clientName\",\"dependents\",\"clientEmail\",\"clientPhone\",\"caseTypeV\",\"subType\",\"actualDeadline\",\"deadlineType\",\"internalDeadline\",\"phaseV\",\"retainedBy\",\"retainerStatus\",\"paymentStatus\",\"stageV\",\"portal\",\"officerV\",\"managerV\",\"qPct\",\"docPct\"],\"deadlines\":[\"caseRef\",\"clientName\",\"dependents\",\"clientEmail\",\"clientPhone\",\"caseTypeV\",\"subType\",\"actualDeadline\",\"deadlineType\",\"internalDeadline\",\"phaseV\",\"retainedBy\",\"retainerStatus\",\"paymentStatus\",\"stageV\",\"portal\",\"officerV\",\"managerV\",\"qPct\",\"docPct\"],\"eeita\":[\"caseRef\",\"clientName\",\"dependents\",\"clientEmail\",\"clientPhone\",\"caseTypeV\",\"subType\",\"actualDeadline\",\"deadlineType\",\"internalDeadline\",\"phaseV\",\"retainedBy\",\"retainerStatus\",\"paymentStatus\",\"stageV\",\"portal\",\"officerV\",\"managerV\",\"qPct\",\"docPct\"]}";
const COLNAMES_TODAY = "{\"caseRef\":\"Case Ref\",\"clientName\":\"Client\",\"caseType\":\"Type\",\"caseStage\":\"Stage\",\"phase\":\"Phase\",\"deadline\":\"Deadline\",\"promised\":\"Promised\",\"health\":\"Health\",\"slaRisk\":\"SLA Risk\",\"officer\":\"Support Officer\",\"manager\":\"Manager\",\"overallReadiness\":\"Readiness\",\"daysElapsed\":\"Days\",\"status\":\"Status\",\"dependents\":\"Dependents\",\"clientEmail\":\"Client email\",\"clientPhone\":\"Contact number\",\"caseTypeV\":\"Case type\",\"subType\":\"Sub-type\",\"actualDeadline\":\"Actual deadline\",\"deadlineType\":\"Deadline type\",\"internalDeadline\":\"Internal deadline\",\"phaseV\":\"Phase\",\"retainedBy\":\"Retained by\",\"retainerStatus\":\"Retainer status\",\"paymentStatus\":\"Payment status\",\"stageV\":\"Stage\",\"portal\":\"Client portal\",\"officerV\":\"Support officer\",\"managerV\":\"Case manager\",\"qPct\":\"Questionnaire %\",\"docPct\":\"Documents uploaded %\"}";
const QUICK_TODAY = ['assigning', 'deadlines', 'eeita'];
const CTX_TODAY = '{ healthOrder: HEALTH_ORDER, views: CM_VIEWS, initial: cmInitial, onChange: cmOnChange, meta: function() { return (_data && _data.meta) || null; }, typeOf: CMW.typeOf }';
const TWELVE = ['caseRef', 'clientName', 'todoWith', 'caseTypeV', 'subType', 'stageV', 'actualDeadline', 'deadlineType', 'internalDeadline', 'officerV', 'qPct', 'docPct'];

const ADMIN = { id: '501', name: 'Admin One', email: 'admin.one@example.com', teamIds: ['7'] };
const OFFICER = { id: '111', name: 'Officer One', email: 'officer.one@example.com', teamIds: [] };
const ADMINS = 'someone.else@example.com, Admin.One@Example.com';
const cookieOf = (staff) => ({ tdot_staff: staffAuth.createStaffToken(staff) });
const reqOf = (staff) => ({ query: {}, cookies: staff ? cookieOf(staff) : {} });
/** A request whose cookies may not be looked at: reading them throws. */
const noPeek = () => { const req = { query: {} }; Object.defineProperty(req, 'cookies', { get() { throw new Error('the Monday cookie was read'); } }); return req; };

/* What the emitted page says it has. */
const mainOf = (html) => inlineScripts(html)[0];
const pageFacts = (html) => {
  const main = mainOf(html), scripts = inlineScripts(html);
  return {
    views: main.match(/var CM_VIEWS = (.*);/)[1], tabcols: main.match(/var CM_TABCOLS = (.*);/)[1], colnames: (main.match(/var CM_COLNAMES = (\{.*?\});/) || [])[1] || null,
    scripts: scripts.length,
    hasTab: JSON.parse(main.match(/var CM_VIEWS = (.*);/)[1]).some((v) => v.key === 'todo'),
    helper: main.includes('var TDU = (function todoUi(CMW, CMU) {'), block: main.includes('function cmTodoHas(r)'), css: html.includes('.cm-todo-pick'),
    hook: html.includes('todoHas: cmTodoHas, '), boot: html.includes('cmTodoBoot();'),
  };
};
const hasAll = (f) => f.hasTab && f.helper && f.block && f.css && f.hook && f.boot;
const hasNone = (f) => !f.hasTab && !f.helper && !f.block && !f.css && !f.hook && !f.boot;

/* ═══ the page route: three modes ═══ */

test('the page route, switch off (not set, "off", anything unknown): no tab for anybody — and the Monday cookie is not even read', async () => {
  for (const mode of [undefined, 'off', 'yes please', '']) {
    await withEnv({ TODO_TAB: mode, ADMIN_EMAILS: ADMINS }, async () => {
      const pages = [];
      for (const req of [undefined, reqOf(null), reqOf(OFFICER), reqOf(ADMIN), noPeek()]) {
        const html = await renderRoute('/', req);
        assert.ok(hasNone(pageFacts(html)), String(mode));
        for (const w of TAB_WORDS) assert.ok(!html.includes(w), String(mode) + ': the page holds "' + w + '"');
        pages.push(html);
      }
      assert.ok(pages.every((h) => h === pages[0]), 'one page for everybody: who asks changes nothing');
    });
  }
});

test('the page route, switch on: the tab for everybody who opens the page — with or without a Monday sign-in — and the cookie is not read here either', async () => {
  await withEnv({ TODO_TAB: 'on', ADMIN_EMAILS: undefined }, async () => {
    const pages = [];
    for (const req of [undefined, reqOf(null), reqOf(OFFICER), reqOf(ADMIN), noPeek()]) {
      const html = await renderRoute('/', req);
      assert.ok(hasAll(pageFacts(html)));
      pages.push(html);
    }
    assert.ok(pages.every((h) => h === pages[0]), 'the page never knows who views it: who "me" is comes with the data');
    for (const who of ['Admin One', 'Officer One', 'admin.one@example.com', '"501"', '"111"']) assert.ok(!pages[3].includes(who) && !pages[2].includes(who), 'nothing of the sign-in is in the page');
  });
  await withEnv({ TODO_TAB: ' ON ', ADMIN_EMAILS: undefined }, async () => assert.ok(hasAll(pageFacts(await renderRoute('/'))), 'read at call time, spaces and capitals forgiven'));
});

test('the page route, admins only: the tab for a named admin signed in with Monday — not for the team key alone, a non-admin, a forged or damaged cookie', async () => {
  await withEnv({ TODO_TAB: 'admins', ADMIN_EMAILS: ADMINS }, async () => {
    const off = await withEnv({ TODO_TAB: 'off' }, () => renderRoute('/'));
    const forged = { tdot_staff: require('jsonwebtoken').sign({ id: '501', name: 'Admin One', email: 'admin.one@example.com', teamIds: [] }, 'not-the-server-secret', { expiresIn: '8h' }) };
    const no = { 'a bare request': undefined, 'no cookie': reqOf(null), 'a non-admin': reqOf(OFFICER), 'a forged cookie': { query: {}, cookies: forged }, 'a damaged cookie': { query: {}, cookies: { tdot_staff: 'x.y.z' } },
      'an admin with no email in the sign-in': reqOf({ id: '501', name: 'Admin One', teamIds: [] }) };
    for (const [what, req] of Object.entries(no)) {
      const html = await renderRoute('/', req);
      assert.ok(hasNone(pageFacts(html)), what);
      assert.equal(html, off, what + ': exactly the page of the switch being off');
    }
    const yes = await renderRoute('/', reqOf(ADMIN));
    assert.ok(hasAll(pageFacts(yes)), 'the named admin');
    assert.ok(hasAll(pageFacts(await renderRoute('/', reqOf({ ...ADMIN, email: 'ADMIN.ONE@example.com' })))), 'the email is compared without regard to capitals');
    // the top bar stays the six-link bar in this mode (the link is for "on" only): the admin's page differs from everybody's
    // "on" page in the bar alone
    const on = await withEnv({ TODO_TAB: 'on' }, () => renderRoute('/'));
    const barOn = await withEnv({ TODO_TAB: 'on' }, () => shared.buildNavHeader('dashboard'));
    assert.ok(on.includes(barOn) && yes.includes(shared.buildNavHeader('dashboard')));
    assert.equal(on.replace(barOn, shared.buildNavHeader('dashboard')), yes);
    assert.ok(!yes.includes('id="nav-todo"'));
  });
  // nobody is an admin when ADMIN_EMAILS is not set
  await withEnv({ TODO_TAB: 'admins', ADMIN_EMAILS: undefined }, async () => assert.ok(hasNone(pageFacts(await renderRoute('/', reqOf(ADMIN))))));
});

test('the Summary page never has the tab, in any mode, for anybody — it is the same page whatever the switch says (apart from the top bar when the link is on)', async () => {
  const off = await withEnv({ TODO_TAB: undefined }, () => renderRoute('/summary'));
  const barOff = await withEnv({ TODO_TAB: undefined }, () => shared.buildNavHeader('summary'));
  for (const mode of ['off', 'admins', 'on']) {
    await withEnv({ TODO_TAB: mode, ADMIN_EMAILS: ADMINS }, async () => {
      for (const req of [undefined, reqOf(OFFICER), reqOf(ADMIN)]) {
        const html = await renderRoute('/summary', req);
        const main = mainOf(html);
        assert.equal(main.match(/var CM_VIEWS = (.*);/)[1], VIEWS_TODAY, mode);
        assert.equal(main.match(/var CM_TABCOLS = (.*);/)[1], TABCOLS_TODAY, mode);
        assert.ok(!main.includes('CM_COLNAMES') && !main.includes('var CMW = (') && !main.includes('var TDU') && !main.includes('cmTodoHas(') && !html.includes('.cm-todo-pick') && !html.includes('cmTodoBoot'), mode);
        assert.equal(inlineScripts(html).length, 1);
        for (const s of inlineScripts(html)) new vm.Script(s);
        const bar = shared.buildNavHeader('summary');
        assert.ok(html.includes(bar));
        assert.equal(html.replace(bar, barOff), off, mode + ': the page under the bar is the same page');
        // not a word of the tab — outside the top bar, which carries the link when the switch is fully on
        for (const w of TAB_WORDS) assert.ok(!html.replace(bar, '').includes(w), mode + ': the Summary page holds "' + w + '"');
        assert.equal(bar.includes('To-do'), mode === 'on');
      }
    });
  }
});

/* ═══ a page WITHOUT the tab: today's values, literally ═══ */

test('tab off: CM_VIEWS, CM_TABCOLS, CM_COLNAMES and the tab values are literal copies of today\'s; the list script gets today\'s context; not a word of the tab; every script parses', async () => {
  const cases = { 'switch not set': [{ TODO_TAB: undefined }, undefined], 'switch off': [{ TODO_TAB: 'off' }, reqOf(ADMIN)], 'admins, a non-admin': [{ TODO_TAB: 'admins', ADMIN_EMAILS: ADMINS }, reqOf(OFFICER)] };
  for (const [what, [env, req]] of Object.entries(cases)) {
    await withEnv({ ADMIN_EMAILS: undefined, ...env }, async () => {
      const html = await renderRoute('/', req), f = pageFacts(html);
      assert.equal(f.views, VIEWS_TODAY, what);
      assert.equal(f.tabcols, TABCOLS_TODAY, what);
      assert.equal(f.colnames, COLNAMES_TODAY, what);
      assert.equal(f.scripts, 2, what + ': the page script and the list engine\'s, as before');
      for (const w of TAB_WORDS) assert.ok(!html.includes(w), what + ': the page holds "' + w + '"');
      assert.ok(!/to-do/i.test(html), what + ': not in any spelling');
      assert.ok(html.includes('var LT = listCore((') && html.includes(')(CTX), window); })();</script>'), 'nothing is added after the list script');
      assert.ok(html.includes('var CTX = ' + CTX_TODAY + ';'), what + ': the list script\'s context is today\'s, to the letter');
      for (const s of inlineScripts(html)) new vm.Script(s);
      // the tabs the engine is given, and the columns it draws, from that page's own values
      const views = JSON.parse(f.views);
      assert.deepEqual(S.casesListOpts({ views }).quick.values, QUICK_TODAY);
      assert.deepEqual(Object.keys(JSON.parse(f.tabcols)), ['', 'assigning', 'deadlines', 'eeita']);
    });
  }
  assert.deepEqual(JSON.parse(VIEWS_TODAY), cmv.pageViews(), 'the literal copy is still what the Monday views module gives');
});

/* ═══ a page WITH the tab ═══ */

let PAGE_ON = null;
const pageOn = async () => (PAGE_ON = PAGE_ON || await withEnv({ TODO_TAB: 'on' }, () => renderRoute('/')));

test('tab on: To-do is the LAST tab; CM_TABCOLS.todo is the twelve in their order; the other tabs\' columns and names are untouched; "With" is one more column name', async () => {
  const html = await pageOn(), f = pageFacts(html), main = mainOf(html);
  const views = JSON.parse(f.views), tabcols = JSON.parse(f.tabcols), names = JSON.parse(f.colnames);
  assert.deepEqual(views, JSON.parse(VIEWS_TODAY).concat([JSON.parse(JSON.stringify(T.PAGE_VIEW))]), 'the Monday views as they were, then the page-only view');
  assert.deepEqual(views.map((v) => v.label), ['Assigning', 'Deadlines', 'EE after ITA', 'To-do'], 'after All: Assigning · Deadlines · EE after ITA · To-do');
  assert.deepEqual(tabcols.todo, TWELVE);
  assert.deepEqual(tabcols.todo, T.DEFAULT_COLS);
  const before = JSON.parse(TABCOLS_TODAY);
  assert.deepEqual(Object.keys(tabcols), ['', 'assigning', 'deadlines', 'eeita', 'todo']);
  for (const k of Object.keys(before)) assert.deepEqual(tabcols[k], before[k], 'the ' + (k || 'All') + ' tab\'s columns are as they were');
  assert.deepEqual(names, { ...JSON.parse(COLNAMES_TODAY), todoWith: 'With' });
  // the engine's own set for the tab is the same twelve (its order is the list's; the page's order is CM_TABCOLS)
  const opts = S.casesListOpts({ views });
  assert.deepEqual(listCore({}).colsOnTab(opts.cols, 'todo').map((c) => c.id).sort(), TWELVE.slice().sort());
  assert.deepEqual(opts.quick.values, ['assigning', 'deadlines', 'eeita', 'todo']);
  assert.equal(opts.quick.hints.todo, T.PAGE_VIEW.hint, 'the tab\'s tooltip');
  // the helper comes in by toString right after the CMU line; the tab's own block after the Columns code; both only here
  assert.ok(main.includes(')(CMW);\nvar TDU = (function todoUi(CMW, CMU) {'), 'TDU right after CMU');
  assert.ok(main.includes('var TDU = (' + todoUi.toString() + ')(CMW, CMU);'));
  assert.ok(main.indexOf('var CMCOLS = (') < main.indexOf('var CM_TODO_WHO_KEY = ') && main.indexOf('var TDU = (') < main.indexOf('var CM_TODO_WHO_KEY = '));
  assert.ok(main.includes(todoPage.TODO_PAGE_JS) && html.includes(todoPage.TODO_CSS));
  // the list script: the hook sits BEFORE meta: (the pinned head and tail of the context are untouched), the boot call after the script
  assert.ok(html.includes('var CTX = { healthOrder: HEALTH_ORDER, views: CM_VIEWS, initial: cmInitial, onChange: cmOnChange, todoHas: cmTodoHas, meta: function() { return (_data && _data.meta) || null; }, typeOf: CMW.typeOf };'));
  assert.ok(html.includes(')(CTX), window); })();\ncmTodoBoot();</script>'));
  assert.equal(f.scripts, 2, 'still two script blocks');
  // the page under the tab's own additions is the page without it: same title, same subtitle, same toolbar
  assert.ok(html.includes('<h1 class="dash-title">Client Master</h1>') && html.includes('The Client Master board, with its Monday views as tabs'));
});

test('every emitted <script> block parses in every mode, on both page variants (node --check does not see page script)', async () => {
  for (const mode of [undefined, 'off', 'admins', 'on']) {
    await withEnv({ TODO_TAB: mode, ADMIN_EMAILS: ADMINS }, async () => {
      for (const path of ['/', '/summary']) for (const req of [undefined, reqOf(OFFICER), reqOf(ADMIN)]) {
        const scripts = inlineScripts(await renderRoute(path, req));
        assert.equal(scripts.length, path === '/' ? 2 : 1, String(mode) + ' ' + path);
        for (const s of scripts) new vm.Script(s);
      }
    });
  }
});

test('the injected-code rule: no backslash, backtick or dollar-brace anywhere in todoPage.js or in what it puts into the page; no request and no write in the tab\'s code', async () => {
  const src = fs.readFileSync(require.resolve('../src/routes/todoPage'), 'utf8');
  assert.ok(!/[`\\]|\$\{/.test(src), 'the whole file, comments too');
  for (const text of [todoPage.TODO_PAGE_JS, todoPage.TODO_BOOT_JS, todoPage.TODO_CSS, todoPage.TODO_STATE_JS]) assert.ok(typeof text === 'string' && text.length > 0 && !/[`\\]|\$\{/.test(text));
  for (const fn of todoPage.TODO_FUNCTIONS) {
    assert.ok(/^cmTodo[A-Z]/.test(fn.name), fn.name + ': every page function of the tab carries the tab\'s prefix');
    assert.ok(todoPage.TODO_PAGE_JS.includes(fn.toString()), fn.name + ' is pasted in as it is written');
  }
  for (const file of ['../src/routes/todoPage', '../src/routes/todoUi']) {
    const text = fs.readFileSync(require.resolve(file), 'utf8');
    assert.ok(!text.includes('fetch(') && !/mutation/i.test(text) && !/XMLHttpRequest|sendBeacon|\.ajax\(|WebSocket|EventSource/.test(text), file + ': asks nothing of the server');
    assert.ok(!/localStorage/.test(text.replace(/never localStorage/g, '')), file + ': nothing about whose list goes to localStorage');
    assert.ok(!/assignable-users/.test(text), file + ': names are never taken from the Monday users list');
  }
  // the common page code in adminDashboard.js: the hooks sit inside the two pinned blocks, which keep the page-script rule
  const dashSrc = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const block = dashSrc.slice(dashSrc.indexOf('/* ── The view tabs (block 3)'), dashSrc.indexOf('/* ── Helpers ─'));
  assert.ok(block.includes('typeof cmTodoDraw === \'function\'') && !/[`\\]|\$\{/.test(block));
  // … and never name the tab or its column in their own text: a page without the tab stays free of it
  for (const w of TAB_WORDS) assert.ok(!block.includes(w), 'the common code holds "' + w + '"');
  assert.ok(!/to-do/i.test(block));
  // every hook in the common code is behind a guard: the page functions run by name in the older tests have none of the tab's code
  const calls = [...block.matchAll(/\b(cmTodo[A-Za-z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['cmTodoAddress', 'cmTodoDraw', 'cmTodoHead', 'cmTodoLink', 'cmTodoNav', 'cmTodoPassed', 'cmTodoWho', 'cmTodoWith']);
  for (const name of new Set(calls)) assert.ok(block.includes('typeof ' + name + ' === \'function\''), name + ' is called only behind typeof');
  assert.ok(block.includes("typeof CM_TODO_COL === 'string'"), 'the "With" cell is made only on a page that has the tab');
  // the pinned lines the older tests look for are as they were
  assert.ok(block.includes('if (v) return renderViewTable(v, rows, st, !(h && h.defaultSort === false));'));
  assert.ok(block.includes("var mgr = v && (!c.manager || c.manager === 'Unassigned') ? cmNoneDash() : escHtml(c.manager);"));
  assert.equal((dashSrc.match(/cmScrollBox\(!wide\);/g) || []).length, 2);
  // Assign and its route are not touched: the tab's code makes no request of its own and the assign code has no hook in it
  const asg = dashSrc.slice(dashSrc.indexOf('/* ── Assign the Case Support Officer'), dashSrc.indexOf('/* ── Change the client deadline'));
  assert.ok(asg.length > 3000 && !/cmTodo|CM_TODO|todoBox/.test(asg));
});

/* ═══ the top bar ═══ */

const BAR_TODAY = {
  leads: '06aa0c0502887084091579cc8978a2e27e79876761e6351a0a5482329349af16', consultations: '2b67fa0c71f22bed34481c5441048609fc18503929d84861140786464c4abcc2',
  retainers: '7c847ef30f3358b95573f9c8d3bac988fb8a3f2b3adde36766860bb40b0e71e2', dashboard: 'd6f5e7e0144b5a070668f4c3acc38dc8f2d1b0d4f7bb3a4c2c4b05966cffbb7b',
  summary: '69da876e6c6d0889da330ec98f15c76092782d2fed0e58c91819bb9992024989', engines: 'ef82565550c4fd24eef03475f0f64c804805face0a05851193e290713d5c784c',
  guide: 'c9aecf93d9f8dc5ddcf51f0b29e1939275bfdc405a54ca4f0dccf3b9fca4bc8d', '': 'ef82565550c4fd24eef03475f0f64c804805face0a05851193e290713d5c784c',
};
const NAV_CSS_TODAY = '2690b6579cd46fe898994d0c709965fee973b2b23b026afbab8878bc863a90f2';   // sha256 of NAV_CSS on the clean tree
/* The bar's logo address follows RENDER_URL (read once, when adminShared loads). The values above were taken with the permanent
   address, so a machine whose .env names another one still compares the same bytes: only that address is put back first. */
const LOGO_AT = shared.TDOT_LOGO_SVG.match(/src="([^"]*)\/assets\/tdot-logo\.png"/)[1];
const barSha = (bar) => sha(bar.split(LOGO_AT + '/assets/tdot-logo.png').join('https://tdot-automations.onrender.com/assets/tdot-logo.png'));

test('the top bar, switch off or admins-only: byte for byte the six-link bar of the clean tree on every page (sha256); NAV_CSS is not changed', () => {
  for (const mode of [undefined, 'off', 'admins', 'On?', '']) {
    withEnv({ TODO_TAB: mode, ADMIN_EMAILS: ADMINS }, () => {
      for (const [page, want] of Object.entries(BAR_TODAY)) assert.equal(barSha(shared.buildNavHeader(page)), want, String(mode) + ' / ' + (page || '(no page)'));
      assert.ok(!shared.buildNavHeader('dashboard').includes('nav-7') && !/<style/.test(shared.buildNavHeader('dashboard')));
    });
  }
  assert.equal(sha(shared.NAV_CSS), NAV_CSS_TODAY, 'none of the six-link CSS changed');
  assert.ok(!/nav-7|nav-todo/.test(shared.NAV_CSS));
});

test('the top bar, switch on: "To-do" right after "Client Master", opening the tab on the person\'s own list; the header is marked nav-7 and carries its own small style; the six links are as they were', () => {
  withEnv({ TODO_TAB: 'on' }, () => {
    for (const page of Object.keys(BAR_TODAY)) {
      const bar = shared.buildNavHeader(page);
      const links = [...bar.matchAll(/<a href="([^"]+)" class="nav-lnk[^"]*"[^>]*>\s*<span class="nav-icon" aria-hidden="true">([^<]+)<\/span> <span class="nav-txt">([^<]+)<\/span>/g)].map((m) => [m[1], m[3]]);
      assert.deepEqual(links, [['/admin/leads', 'Leads'], ['/admin/consultations', 'Consultations'], ['/admin/retainers', 'Retainers'], ['/admin/dashboard', 'Client Master'],
        ['/admin/dashboard?view=todo&amp;who=me', 'To-do'], ['/admin/dashboard/summary', 'Summary'], ['/admin/guide', 'Guide']], page);
      assert.ok(bar.includes('<a href="/admin/dashboard?view=todo&amp;who=me" class="nav-lnk" id="nav-todo" title="To-do: my list">\n        <span class="nav-icon" aria-hidden="true">📋</span> <span class="nav-txt">To-do</span>\n      </a>'), page);
      assert.equal((bar.match(/id="nav-todo"/g) || []).length, 1);
      // the server never lights the To-do link itself (it does not know the tab): the page does, from the tab on screen
      assert.ok(!/id="nav-todo"[^>]*(active|aria-current)/.test(bar) && !/class="nav-lnk active" id="nav-todo"/.test(bar));
      // take the three additions away and what is left is the six-link bar, to the byte
      const style = bar.slice(0, bar.indexOf('<header'));
      const six = bar.slice(style.length).replace('<header class="admin-hdr nav-7">', '<header class="admin-hdr">').replace(/\n      <a href="\/admin\/dashboard\?view=todo&amp;who=me"[\s\S]*?<\/a>/, '');
      assert.equal(barSha(six), BAR_TODAY[page], page + ': the six links, the logo and the right side are untouched');
      assert.ok(/^<style>\n[\s\S]+<\/style>\n$/.test(style), 'its own style, just before the header');
    }
    const bar = shared.buildNavHeader('dashboard');
    assert.ok(bar.includes('<a href="/admin/dashboard" class="nav-lnk active" title="Client Master" aria-current="page">'), 'on a Client Master page the server lights Client Master, as always');
    // the style: every rule is scoped to the seven-link header, so no other bar and no six-link rule is touched
    const css = bar.slice('<style>'.length, bar.indexOf('</style>'));
    const rules = [...css.matchAll(/([^{}@;]+)\{[^{}]*\}/g)].map((m) => m[1].trim());
    assert.ok(rules.length >= 20);
    for (const r of rules) assert.ok(r.startsWith('.admin-hdr.nav-7'), r);
    assert.ok(!/[`\\]|\$\{/.test(css));
    // where each step of the bar happens with seven links — always EARLIER than with six (NAV_CSS: 1100 / 1300, 1190, 1070, 945)
    assert.deepEqual([...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1])), [1480, 1340, 1280, 1180, 1060, 560]);
    const at = (px) => css.slice(css.indexOf('@media (max-width: ' + px + 'px)'), css.indexOf('@media', css.indexOf('@media (max-width: ' + px + 'px)') + 10) < 0 ? css.length : css.indexOf('@media', css.indexOf('@media (max-width: ' + px + 'px)') + 10));
    assert.ok(at(1060).includes('.admin-hdr.nav-7 .nav-lnk .nav-txt { display: none; }'), 'the link words go at 1060px (six links: 945px): icons only, each link keeps its title');
    assert.ok(at(1180).includes('.admin-hdr.nav-7 .who-chip .who-txt { display: none; }'), 'the name\'s words at 1180px (six: 1070px)');
    assert.ok(at(1340).includes('.admin-hdr.nav-7 .nav-lnk { padding: 7px 10px; }') && at(1340).includes('#sys-text { display: none; }'), 'the tighter spacing at 1340px (six: 1190px)');
    assert.ok(at(1280).includes('.admin-hdr.nav-7 .hdr-clock { display: none; }') && at(1480).includes(':has(.hdr-who:not(:empty)) .hdr-clock { display: none; }'), 'the clock at 1280px / 1480px beside a name (six: 1100px / 1300px)');
    assert.ok(at(560).includes('.admin-hdr.nav-7 .nav-lnk { padding: 7px 5px; }') && at(560).includes('.admin-hdr.nav-7 .admin-nav { gap: 2px; }'), 'a phone: the seven icons sit closer together');
    assert.ok(css.indexOf('padding: 7px 8px') < css.indexOf('padding: 7px 5px') && css.indexOf('padding: 7px 10px') < css.indexOf('padding: 7px 8px'), 'a narrower step comes later in the style, so it wins');
    assert.ok(css.includes('.admin-hdr.nav-7 #nav-todo .nav-txt { white-space: nowrap; }'), '"To-do" never breaks at its hyphen');
    for (const six of [945, 1070, 1190]) assert.ok(shared.NAV_CSS.includes('@media (max-width: ' + six + 'px)'), 'the six-link steps are still in NAV_CSS');
  });
  // read at every call: the same process answers the six-link bar again once the switch is off
  assert.equal(barSha(withEnv({ TODO_TAB: 'off' }, () => shared.buildNavHeader('leads'))), BAR_TODAY.leads);
  // every staff page that builds the bar gets the link while the switch is on — and none of them when it is not
  const pages = () => [require('../src/routes/adminLeads').buildLeadsQueueHTML(), require('../src/routes/adminConsultation').buildRetainersHTML(), require('../src/routes/adminCase').buildCockpitHTML('2026-TEST-001')];
  for (const html of withEnv({ TODO_TAB: 'on' }, pages)) assert.equal((html.match(/id="nav-todo"/g) || []).length, 1);
  for (const html of withEnv({ TODO_TAB: 'admins' }, pages)) assert.ok(!html.includes('nav-todo') && !html.includes('nav-7'));
});

/* ═══ the page's own behaviour: the real emitted scripts over a small made-up page ═══ */

const STAGE_COL = 'color_mm0x8faa', PHASE_COL = 'color_mm3tf1ys';
const META = dash._casesIo.parseMeta({ groups: META_FIX.groups, columns: [STAGE_COL, PHASE_COL].map((id) => ({ id, settings_str: JSON.stringify(META_FIX.columns[id].settings) })) });
const ONE = ['111', 'Officer One'], TWO = ['112', 'Officer Two'], REV = ['211', 'Reviewer One'], TEAM9 = ['9', 'Team Nine'];
const TODAY = '2026-11-19';
const me = (p, teamIds = []) => ({ id: p[0], name: p[1], teamIds });
/** A Client Master row as the page gets it when the tab is on (dashboardService.parseItem + the server's mark), open unless said otherwise. */
function mk(id, o = {}) {
  const { officers = [], officerTeams = [], managers = [], managerTeams = [], open = true, ...rest } = o;
  const text = (people, teams) => people.concat(teams).map((x) => x[1]).join(', ');
  return {
    id: String(id), caseRef: '2026-EE-' + String(id).padStart(3, '0'), clientName: 'Test Client ' + id, caseType: 'Express Entry', caseSubType: '', health: 'Green', slaRisk: 'Green',
    views: open ? ['assigning', 'todo'] : ['deadlines'], boardIdx: Number(id), groupId: 'group_mm8qqjyz', groupTitle: 'November 2026', createdAt: '2026-11-0' + (Number(id) % 9 + 1) + 'T10:00:00Z',
    officer: text(officers, officerTeams), officerIds: { personIds: officers.map((x) => x[0]), teamIds: officerTeams.map((x) => x[0]) },
    manager: text(managers, managerTeams) || 'Unassigned', managerIds: { personIds: managers.map((x) => x[0]), teamIds: managerTeams.map((x) => x[0]) },
    stageIdx: 1, caseStage: 'Internal Review', phase: '', deadlineType: '', actualDeadline: '', promisedDate: '', canAssign: true,
    ...rest,
  };
}
/* The cases of every behaviour test:
   Officer One — own: 1 (Real, passed), 2 (Imaginary, later);  for review: 3 (Officer Two's);
   Officer Two — own: 3 (no date), 4 (Real, next week);  Reviewer One — for review: 1, 8 (8 has no officer);
   nobody — 5 (Pre-Onboarding, no date), 6 (Document Collection Started, Real, passed);  7 is Officer One's but not open. */
const CASES = () => [
  mk(1, { officers: [ONE], managers: [REV], deadlineType: 'Deadline', actualDeadline: '2026-11-10' }),
  mk(2, { officers: [ONE], deadlineType: 'Imaginary', promisedDate: '2026-12-01', actualDeadline: '2027-01-15' }),
  mk(3, { officers: [TWO], managers: [ONE] }),
  mk(4, { officers: [TWO], deadlineType: 'Deadline', actualDeadline: '2026-11-25' }),
  mk(5, { stageIdx: 12, caseStage: 'Pre-Onboarding' }),
  mk(6, { stageIdx: 0, caseStage: 'Document Collection Started', deadlineType: 'Deadline', actualDeadline: '2026-11-12' }),
  mk(7, { officers: [ONE], open: false, deadlineType: 'Deadline', actualDeadline: '2026-11-01' }),
  mk(8, { managers: [REV], stageIdx: 2, caseStage: 'Stuck' }),
];
const KEY = 'tdot_list_cases_todo_who', TAB_KEY = 'tdot_list_cases_tab', GRP_KEY = 'tdot_list_cases_groups';
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const plain = (html) => unesc(String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

/* A browser store: a Map behind the Storage methods, with every write noted. */
function storage(init) {
  const m = new Map(Object.entries(init || {})), writes = [];
  return { m, writes, api: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push(['set', k, String(v)]); m.set(k, String(v)); }, removeItem: (k) => { writes.push(['remove', k]); m.delete(k); },
    key: (i) => [...m.keys()][i] === undefined ? null : [...m.keys()][i], get length() { return m.size; } } };
}

/**
 * The Client Master page WITH the tab, in a made-up window: both emitted scripts run exactly as they are.
 * search: the address's query; session / local: what the browser tab already keeps; signedOut: Sign Out has begun;
 * phone: the picker buttons are hidden (only the select can take the focus); bar: 'on' = the top bar has the To-do link.
 */
async function openPage({ search = '', session = {}, local = {}, signedOut = false, phone = false, bar = 'on' } = {}) {
  const html = await pageOn();
  const scripts = inlineScripts(html);
  const els = {}, timers = [], fetched = [], replaced = [], focused = [];
  const address = { href: 'https://staff.example/admin/dashboard' + search };
  const doc = { activeElement: null, readyState: 'loading' };
  let draw = 0, headEls = {}, pickEls = null;
  function mk2(tag, id) {
    const e = { tag, tagName: String(tag).toUpperCase(), id: id || '', _html: '', kids: [], style: {}, attrs: {}, className: '', value: '', title: '', textContent: '', disabled: false, onclick: null, parentNode: null, scrollWidth: 1000, clientWidth: 1000,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.kids.push(c); c.parentNode = this; return c; }, insertBefore(c) { this.kids.push(c); return c; }, removeChild() {}, addEventListener() {},
      querySelector(sel) { const cls = sel.replace(/^\./, ''); if (new RegExp('class="[^"]*\\b' + cls + '\\b').test(this._html)) { const b = { onclick: null, focus() { doc.activeElement = b; } }; (this.found = this.found || {})[sel] = b; return b; } return null; },
      querySelectorAll() { return []; }, contains(x) { return x === this; }, closest() { return null; }, focus() { doc.activeElement = this; focused.push(this.id || this.tag); }, scrollIntoView() {},
      getBoundingClientRect() { return { left: 640, right: 720, top: 270, bottom: 300, width: 80, height: 30 }; } };
    const words = () => e.className.split(/\s+/).filter(Boolean);
    e.classList = { contains: (c) => words().includes(c), add: (c) => { if (!words().includes(c)) e.className = words().concat([c]).join(' '); }, remove: (c) => { e.className = words().filter((w) => w !== c).join(' '); },
      toggle: (c, on) => { const has = words().includes(c), want = on === undefined ? !has : !!on; if (want && !has) e.classList.add(c); if (!want && has) e.classList.remove(c); return want; } };
    Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); this.kids = []; if (this.id === 'cm-head') { draw++; headEls = {}; pickEls = null; } }, configurable: true });
    return e;
  }
  for (const id of ['cs-quick', 'cm-head', 'search-box', 'cm-oc', 'cm-cols-btn', 'table-count', 'cs-chips', 'cs-headrow', 'all-cases-body', 'refresh-btn', 'loading', 'content', 'error-msg']) els[id] = mk2('div', id);
  els['all-cases-table'] = mk2('table', 'all-cases-table'); els['all-cases-table'].className = 'data-table';
  const wrap = mk2('div'); wrap.className = 'tbl-wrap'; els['all-cases-table'].parentNode = wrap;
  els['cm-cols-btn'].className = 'cm-oc-b cm-cols-b';
  const head = els['cm-head'];
  /* An element inside the box above the table, made from the HTML the page wrote there (one object per id per draw). */
  function fromHtml(tag, attrText, inner) {
    const attrs = Object.fromEntries([...attrText.matchAll(/([a-z-]+)="([^"]*)"/g)].map((x) => [x[1], unesc(x[2])]));
    const e = { tagName: tag.toUpperCase(), id: attrs.id || '', attrs, html: inner, inHead: draw, textContent: plain(inner), offsetParent: phone && tag === 'button' ? null : {},
      getAttribute: (k) => (k in attrs ? attrs[k] : null), focus() { doc.activeElement = e; focused.push(attrs['data-who'] ? 'button ' + attrs['data-who'] : attrs.id || tag); } };
    if (tag === 'select') { const on = inner.match(/<option value="([^"]*)" selected/); e.value = on ? unesc(on[1]) : ''; }
    return e;
  }
  function headEl(id) {
    if (headEls[id]) return headEls[id];
    const m = head._html.match(new RegExp('<([a-z]+)((?:\\s[^>]*)?\\sid="' + id + '"[^>]*)>([\\s\\S]*?)</\\1>'));
    return m ? (headEls[id] = fromHtml(m[1], m[2], m[3])) : null;
  }
  function pickButtons() {
    if (pickEls) return pickEls;
    const box = head._html.match(/<div class="cm-strip cm-todo-pick"[^>]*>([\s\S]*?)<\/div>/);
    pickEls = box ? [...box[1].matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => fromHtml('button', m[1], m[2])) : [];
    return pickEls;
  }
  head.contains = (x) => !!x && x.inHead === draw;
  const groupButtons = () => els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)).map((k) => ({ row: k, className: 'cm-grp-b', getAttribute: (a) => (a === 'data-gk' ? unesc(k.innerHTML.match(/data-gk="([^"]*)"/)[1]) : null), focus() { doc.activeElement = this; focused.push('group ' + this.getAttribute('data-gk')); }, scrollIntoView() {} }));
  // the top bar's links, as the server wrote them for a Client Master page
  const barHtml = withEnv({ TODO_TAB: bar }, () => shared.buildNavHeader('dashboard'));
  const navLinks = [...barHtml.matchAll(/<a href="([^"]+)" class="(nav-lnk[^"]*)"([^>]*)>/g)].map((m) => {
    const a = mk2('a'); a.className = m[2]; a.attrs.href = unesc(m[1]);
    for (const x of m[3].matchAll(/([a-z-]+)="([^"]*)"/g)) { a.attrs[x[1]] = unesc(x[2]); if (x[1] === 'id') a.id = x[2]; }
    return a;
  });
  for (const a of navLinks) if (a.id) els[a.id] = a;
  const body = mk2('body');
  body.appendChild = (c) => { if (c.id) els[c.id] = c; return c; };
  body.contains = (x) => !!x && x !== body && !x.gone && (x.inHead === undefined || x.inHead === draw);
  Object.assign(doc, { getElementById: (id) => els[id] || headEl(id), createElement: (t) => mk2(t), body, documentElement: mk2('html'), querySelector: () => null,
    querySelectorAll: (sel) => (sel === '#cm-todo-pick button' ? pickButtons() : sel === '.admin-nav .nav-lnk' ? navLinks : sel === '#all-cases-body .cm-grp-b' ? groupButtons() : []),
    addEventListener() {}, dispatchEvent() { return true; } });
  const ls = storage(local), ss = storage(session);
  const ctx = { document: doc, console, URL, URLSearchParams, setTimeout: (fn, ms) => { timers.push({ fn, at: ctx.__NOW + (ms || 0) }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {},
    history: { replaceState: (_s, _t, url) => { address.href = String(url); replaced.push(String(url)); } },
    innerWidth: 1440, innerHeight: 900, addEventListener() {}, matchMedia: () => ({ matches: true }), fetch: (url) => { fetched.push(String(url)); return new Promise(() => {}); },
    TDOT_IS_ADMIN: false, TDOT_SIGNED_OUT: signedOut, CustomEvent: function (type) { this.type = type; }, sessionStorage: ss.api, localStorage: ls.api };
  Object.defineProperty(ctx, 'location', { get() { const u = new URL(address.href); return { href: u.href, search: u.search, pathname: u.pathname, replace() {} }; }, enumerable: true, configurable: true });
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('var __NOW = 1795111200000; Date.now = function() { return __NOW; };', ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  ctx.cmToday = () => TODAY;   // a fixed day: "passed" is counted from it
  const atLoad = fetched.length;
  const tb = els['all-cases-body'];
  const colsOf = (tab) => Array.from(ctx.cmColIds(tab ? { key: tab } : null));
  const cellsOf = (tr) => tr.innerHTML.split('</td>').slice(0, -1).map((c) => c + '</td>');
  const p = {
    ctx, els, html, doc, address, timers, fetched, replaced, focused, kept: ss.m, session: ss, local: ls, navLinks,
    /** A /admin/dashboard-stats answer arrives (o.todo: its `todo` part; leave it out for an answer without the lists). */
    answer(cases, o = {}) {
      const d = { meta: META, cases, dataAt: '2026-11-19T14:05:00Z', viewer: o.viewer || { name: 'Admin', email: '', scope: 'all', isAdmin: true, canAssign: true } };
      if (o.todo !== undefined) d.todo = o.todo;
      ctx._data = d;
      ctx.initAllCasesTable(d);
      return d;
    },
    state: () => ctx.CasesTable.state(),
    tab(v) { const st = ctx.CasesTable.state(); if (v) st.sel.view = [v]; else delete st.sel.view; ctx.CasesTable.apply('filter'); },
    search(q) { ctx.CasesTable.state().q = q; ctx.CasesTable.apply('filter'); },
    onTab: () => (ctx.CasesTable.state().sel.view || [''])[0],
    /** Press a picker button (by its who value), or choose in the phone select. */
    pick(who) { const b = pickButtons().find((x) => x.attrs['data-who'] === who); assert.ok(b, 'a picker button for ' + who); doc.activeElement = b; ctx.cmTodoPick(b); },
    choose(who) { const s = headEl('cm-todo-sel'); assert.ok(s, 'the select'); s.value = who; doc.activeElement = s; ctx.cmTodoPick(s); },
    head: () => head._html,
    headText: () => plain(head._html),
    el: (id) => headEl(id),
    title: () => (headEl('cm-todo-title') || {}).textContent,
    status: () => (headEl('cm-todo-status') || { textContent: null }).textContent,
    /** [who, pressed, the words on the button, its spoken name] */
    picker: () => pickButtons().map((b) => [b.attrs['data-who'], b.attrs['aria-pressed'] === 'true', b.textContent, b.attrs['aria-label']]),
    pressed: () => pickButtons().filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.attrs['data-who']),
    /** the phone select: [[value, words, selected]] */
    options: () => { const s = head._html.match(/<select[^>]*id="cm-todo-sel"[^>]*>([\s\S]*?)<\/select>/); return s ? [...s[1].matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [unesc(m[1]), unesc(m[3]), !!m[2]]) : null; },
    tabs: () => Object.fromEntries([...els['cs-quick'].innerHTML.matchAll(/data-quick="([^"]*)"[^>]*>([^<]*) <span class="lt-tab-n">(\d+)<\/span>/g)].map((m) => [m[1] || 'all', Number(m[3])])),
    tabLabels: () => [...els['cs-quick'].innerHTML.matchAll(/data-quick="([^"]*)"[^>]*>([^<]*) <span/g)].map((m) => m[2]),
    count: () => els['table-count'].textContent,
    chips: () => plain(els['cs-chips'].innerHTML),
    heads: () => tb.kids.filter((k) => /^cm-grp /.test(k.className)),
    rows: () => tb.kids.filter((k) => /(^| )cm-in( |$)/.test(k.className)),
    none: () => { const k = tb.kids.find((x) => x.className === 'cm-none'); return k ? plain(k.innerHTML) : null; },
    /** "title n ▾ / ▸ [— extra]" per heading, then the case references drawn under it */
    look: () => {
      const out = [];
      tb.kids.forEach((k) => {
        if (/^cm-grp /.test(k.className)) {
          const m = k.innerHTML.match(/<b>(.*?)<\/b> · <span class="cm-grp-n">(\d+)<\/span><\/span><\/button>(.*)<\/span><\/td>$/);
          out.push(unesc(m[1]) + ' ' + m[2] + (/ open/.test(k.className) ? ' ▾' : ' ▸') + (m[3] ? ' ' + plain(m[3]) : ''));
        } else if (/(^| )cm-in( |$)/.test(k.className)) out[out.length - 1] += ' ' + plain(cellsOf(k)[0]).replace('2026-EE-', '#');
      });
      return out;
    },
    click(title) { const h = p.heads().find((k) => k.innerHTML.includes('<b>' + title + '</b>')); assert.ok(h, 'a heading ' + title); h.onclick(); },
    cols: colsOf,
    /** one cell of a drawn row, by case number and column id (the tab on view's columns) */
    cell(n, col) { const tr = p.rows().find((k) => plain(cellsOf(k)[0]) === '2026-EE-' + String(n).padStart(3, '0')); assert.ok(tr, 'row ' + n + ' is drawn'); const at = colsOf(p.onTab()).indexOf(col); assert.ok(at >= 0, col + ' is a column of this tab'); return cellsOf(tr)[at]; },
    headerRow: () => [...els['cs-headrow'].innerHTML.matchAll(/<th scope="col"[^>]*>(?:<div class="th-in">)?(?:<button[^>]*class="th-l th-sortbtn"[^>]*>|<span class="th-l">)?([^<]*)/g)].map((m) => m[1]),
    /** the page's clock moves on by ms, and the timers whose time has come run */
    later(ms) { ctx.__NOW += ms; const due = timers.filter((t) => t.at <= ctx.__NOW && !t.ran); for (const t of due) { t.ran = true; t.fn(); } },
    /** what was asked of the server since the page's own scripts started (the page asks who is signed in when it loads) */
    asked: () => fetched.slice(atLoad),
    search_: () => new URL(address.href).search,
  };
  return p;
}
const I = { me: me(ONE) };   // the answer's `todo` part for Officer One signed in with Monday

test('the tab on the page: To-do is the last tab; on it the picker offers "My list" first, each person A → Z, then "No one assigned"; a new browser tab opens on the person\'s own list', async () => {
  const p = await openPage();
  p.answer(CASES(), { todo: I });
  assert.deepEqual(p.tabLabels(), ['All', 'Assigning', 'Deadlines', 'EE after ITA', 'To-do']);
  assert.equal(p.onTab(), '', 'a new browser tab opens on All, as before');
  assert.deepEqual(p.tabs(), { all: 8, assigning: 7, deadlines: 1, eeita: 0, todo: 3 }, 'the To-do tab\'s number is the list it would open: my own three, not the seven open cases');
  assert.equal(p.els['cm-head'].style.display, 'none', 'no box above the table on All');
  p.tab('todo');
  assert.deepEqual(p.picker(), [['me', true, '✓ My list 3', 'My list, 3 cases'], ['p:112', false, 'Officer Two 2', 'Officer Two, 2 cases'], ['p:211', false, 'Reviewer One 2', 'Reviewer One, 2 cases'], ['nobody', false, 'No one assigned 2', 'No one assigned, 2 cases']]);
  assert.ok(p.head().includes('<div class="cm-strip cm-todo-pick" id="cm-todo-pick" role="group" aria-label="Whose to-do list">'));
  assert.ok(p.head().includes('<button type="button" class="cm-st cm-todo-b" data-who="me" aria-pressed="true" aria-label="My list, 3 cases" onclick="cmTodoPick(this)"><span class="cm-todo-tick" aria-hidden="true">✓</span> My list <b>3</b></button>'), 'the chosen one: pressed, and a tick — not colour alone');
  assert.equal((p.head().match(/cm-todo-tick/g) || []).length, 1);
  assert.equal(p.title(), 'To-do · Officer One', 'the title says whose list it is (a printed list does too)');
  assert.ok(p.head().includes('<span class="cm-dataat" id="cm-dataat">Monday data from ') && p.head().includes('<button type="button" class="cm-print" id="cm-print" onclick="window.print()"'));
  assert.equal(p.el('cm-todo-in').textContent, 'Signed in with Monday as Officer One.');
  assert.deepEqual(p.look(), ['My cases 2 ▾ — 1 passed #001 #002', 'With me for review 1 ▾ — 1 no deadline #003']);
  assert.equal(p.count(), '3 cases');
  assert.deepEqual(p.headerRow(), ['Case Ref', 'Client', 'With', 'Case type', 'Sub-type', 'Stage', 'Actual deadline', 'Deadline type', 'Internal deadline', 'Support officer', 'Questionnaire %', 'Documents uploaded %'], 'the twelve columns, With third');
  assert.equal(p.kept.get(TAB_KEY), 'todo', 'the tab is kept for this browser tab like any other');
  assert.equal(p.search_(), '?view=todo', 'the address carries the tab — and nothing about whose list');
  assert.deepEqual(p.asked(), [], 'the tab asked nothing of the server');
  // the other tabs are drawn as always, with the tab on the page
  p.tab('assigning');
  assert.ok(p.head().includes('id="cm-strip"') && p.head().includes('id="cm-noofficer"') && !p.head().includes('cm-todo-pick') && p.head().includes('<span class="cm-title">Assigning</span>'));
  assert.equal(p.count(), '7 cases');
  assert.equal(p.headerRow().length, 20);
  p.tab('');
  assert.equal(p.els['cm-head'].style.display, 'none');
});

test('the address: ?view=todo&who=me (the top-bar link) opens the tab on my own list — who is read once, kept for this browser tab and taken off the address; no id and no name ever goes there', async () => {
  const p = await openPage({ search: '?view=todo&who=me', session: { [KEY]: 'p:112' } });
  assert.equal(p.search_(), '?view=todo', 'who is gone from the address before any data');
  assert.equal(p.kept.get(KEY), 'me', 'the link wins over the list this browser tab was on');
  p.answer(CASES(), { todo: I });
  assert.equal(p.onTab(), 'todo');
  assert.deepEqual(p.pressed(), ['me']);
  // "No one assigned" may be linked too; a person never — an id in the address is not read, and it is taken off
  const n = await openPage({ search: '?x=1&view=todo&who=nobody' });
  assert.deepEqual([n.search_(), n.kept.get(KEY)], ['?x=1&view=todo', 'nobody']);
  n.answer(CASES(), { todo: I });
  assert.deepEqual(n.pressed(), ['nobody']);
  for (const who of ['p:112', 't:9', '112', 'Officer%20Two', '', 'me%20', 'everyone']) {
    const q = await openPage({ search: '?view=todo&who=' + who, session: { [KEY]: 'p:211' } });
    assert.equal(q.search_(), '?view=todo', who + ': taken off the address');
    assert.equal(q.kept.get(KEY), who === 'me%20' ? 'me' : 'p:211', who + ': not read as a list (the kept one stays)');
  }
  assert.equal((await openPage({ search: '?view=TODO&who=ME' })).kept.get(KEY), 'me', 'capitals are forgiven, as for the tab');
  // only together with view=todo: on another tab's link who is not read (and the first change takes the stray one off)
  const other = await openPage({ search: '?view=assigning&who=me' });
  assert.equal(other.kept.has(KEY), false);
  assert.equal(other.search_(), '?view=assigning&who=me');
  other.answer(CASES(), { todo: I });
  other.tab('deadlines');
  assert.equal(other.search_(), '?view=deadlines', 'cmOnChange never writes who, and deletes a stray one');
  const none = await openPage({ search: '?who=me' });
  assert.equal(none.kept.has(KEY), false, 'no tab in the link: who is not read');
  // Sign Out has begun: nothing is written
  const out = await openPage({ search: '?view=todo&who=me', signedOut: true });
  assert.equal(out.kept.has(KEY), false);
  assert.equal(out.search_(), '?view=todo');
  // whatever is done afterwards, the address only ever carries the tab
  p.pick('p:112'); p.pick('nobody'); p.search('client'); p.tab('assigning'); p.tab('todo'); p.pick('p:211');
  for (const url of p.replaced) assert.ok(/^https:\/\/staff\.example\/admin\/dashboard(\?view=(todo|assigning))?$/.test(url), url);
  assert.ok(p.replaced.length >= 5);
});

test('cmInitial and cmOnChange with the tab\'s two address hooks touch only window, URL, URLSearchParams and history (no document, no data) — run in the older tests\' bare harness', async () => {
  const html = await pageOn();
  const from = html.indexOf('var CM_GONE = '), to = html.indexOf('function cmToday()');
  const fnText = (name) => { const f = todoPage.TODO_FUNCTIONS.find((x) => x.name === name); assert.ok(f, name); return f.toString(); };
  const run = (search, store = {}) => {
    const kept = new Map(Object.entries(store)), address = { href: 'https://staff.example/admin/dashboard' + search };
    const win = { sessionStorage: { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } }, get location() { const u = new URL(address.href); return { href: u.href, search: u.search }; } };
    const ctx = vm.createContext({ window: win, URL, URLSearchParams, history: { replaceState: (_s, _t, url) => { address.href = String(url); } }, CM_VIEWS: cmv.pageViews().concat([JSON.parse(JSON.stringify(T.PAGE_VIEW))]) });
    vm.runInContext(html.slice(from, to) + '\n' + todoPage.TODO_STATE_JS + '\n' + fnText('cmTodoLink') + '\n' + fnText('cmTodoAddress'), ctx);
    const st = { sel: {} };
    const linked = ctx.cmInitial(st);
    return { ctx, st, linked, kept, search: () => new URL(address.href).search };
  };
  const a = run('?view=todo&who=me');
  assert.deepEqual([a.linked, Array.from(a.st.sel.view), a.search(), a.kept.get(KEY)], [true, ['todo'], '?view=todo', 'me']);
  a.ctx.cmOnChange({ sel: { view: ['assigning'] } });
  assert.equal(a.search(), '?view=assigning');
  const b = run('?view=eeita&who=me&x=2');
  assert.deepEqual([b.linked, b.search(), b.kept.has(KEY)], [true, '?view=eeita&who=me&x=2', false]);
  b.ctx.cmOnChange({ sel: {} });
  assert.equal(b.search(), '?x=2', 'back on All: no tab in the address, and the stray who is gone');
  // the same page code WITHOUT the tab's hooks (a page without the tab): today's behaviour to the letter
  const bare = vm.createContext({ window: { sessionStorage: { getItem: () => null, setItem() {} }, location: { href: 'https://staff.example/admin/dashboard?view=assigning&who=me', search: '?view=assigning&who=me' } }, URL, URLSearchParams,
    history: { replaceState: (_s, _t, url) => { bare.window.location = { href: String(url), search: new URL(String(url)).search }; } }, CM_VIEWS: cmv.pageViews() });
  vm.runInContext(html.slice(from, to), bare);
  const st = { sel: {} };
  assert.equal(bare.cmInitial(st), true);
  bare.cmOnChange({ sel: { view: ['deadlines'] } });
  assert.equal(bare.window.location.search, '?view=deadlines&who=me', 'without the tab nothing touches who');
});

test('choosing a list: kept as p:<id> in sessionStorage only — never the address, never localStorage; one CasesTable.apply redraws the rows, the tab\'s number and the count; the focus goes back to the chosen button', async () => {
  const p = await openPage({ search: '?view=todo' });
  p.answer(CASES(), { todo: I });
  const before = { local: p.local.writes.length, fetched: p.fetched.length };
  const applies = [];
  const realApply = p.ctx.CasesTable.apply;
  p.ctx.CasesTable.apply = (why) => { applies.push(why); return realApply(why); };
  p.pick('p:112');
  assert.deepEqual(applies, ['who'], 'through the engine: one apply, as the Columns button does');
  assert.equal(p.kept.get(KEY), 'p:112');
  assert.deepEqual(p.pressed(), ['p:112']);
  assert.equal(p.title(), 'To-do · Officer Two');
  assert.deepEqual(p.look(), ["Officer Two's cases 2 ▾ — 1 no deadline #004 #003"], 'soonest deadline first, no date last');
  assert.deepEqual([p.tabs().todo, p.count()], [2, '2 cases'], 'the tab\'s number and the count follow on that apply');
  assert.deepEqual(p.tabs(), { all: 8, assigning: 7, deadlines: 1, eeita: 0, todo: 2 }, 'the other tabs do not move');
  assert.equal(p.focused[p.focused.length - 1], 'button p:112', 'the focus is back on the chosen button after the redraw');
  assert.equal(p.doc.activeElement.attrs['data-who'], 'p:112');
  assert.equal(p.doc.activeElement.inHead, p.el('cm-todo-title').inHead, '… the one of the NEW drawing, not the one that was pressed');
  assert.equal(p.search_(), '?view=todo', 'nothing about the person in the address');
  assert.equal(p.local.writes.length, before.local, 'nothing in localStorage');
  // what the browser tab keeps: the choice under its own key (one of the four shapes), and nothing about the person anywhere else
  for (const [what, k, v] of p.session.writes) {
    if (k === KEY) assert.ok(what === 'remove' || v === 'p:112', what + ' ' + v);   // nothing kept before the press; then the person, as p:<id>
    else assert.ok(!/p:112|Officer Two/.test(k + ' ' + String(v)), k + ' = ' + v);
  }
  assert.deepEqual(p.session.writes.filter((w) => w[1] === KEY).pop(), ['set', KEY, 'p:112']);
  assert.equal(p.fetched.length, before.fetched, 'no request');
  // a reviewer: the review section only, with whose cases they are in the Support officer column
  p.pick('p:211');
  assert.deepEqual(p.look(), ['With Reviewer One for review 2 ▾ — 1 passed · 1 no deadline #001 #008']);
  assert.equal(plain(p.cell(1, 'officerV')).replace(' Assign…', ''), 'Officer One');
  // "No one assigned", then back to my own: kept as the WORD me, never my id
  p.pick('nobody');
  assert.equal(p.kept.get(KEY), 'nobody');
  p.pick('me');
  assert.equal(p.kept.get(KEY), 'me');
  assert.ok(![...p.kept.values()].some((v) => /111/.test(v)), 'my own id is nowhere in what the browser tab keeps');
  // the kept choice is always the one of the page on screen: another copy of the page (Back) wrote its own meanwhile — the next draw puts this page's back
  p.kept.set(KEY, 'p:211');
  p.search('client');
  assert.equal(p.kept.get(KEY), 'me');
  assert.deepEqual(p.pressed(), ['me']);
  p.search('');
  // the kept choice survives a reload of the page in the same browser tab
  const again = await openPage({ search: '?view=todo', session: { [KEY]: 'p:112', [TAB_KEY]: 'todo' } });
  again.answer(CASES(), { todo: I });
  assert.deepEqual([again.pressed(), again.title()], [['p:112'], 'To-do · Officer Two']);
  // junk in the store is not a list: my own list
  for (const junk of ['p:', 'p:12x', 'P:112', ' me', 'everyone', '{"who":"me"}', 'p:112 ']) {
    const j = await openPage({ search: '?view=todo', session: { [KEY]: junk } });
    j.answer(CASES(), { todo: I });
    assert.deepEqual(j.pressed(), ['me'], JSON.stringify(junk));
  }
});

test('after Sign Out has begun nothing is written: not the choice of list, not from a link, not on a redraw', async () => {
  const p = await openPage({ search: '?view=todo', session: { [KEY]: 'p:112' } });
  p.answer(CASES(), { todo: I });
  const n = p.session.writes.filter((w) => w[1] === KEY).length;
  p.ctx.TDOT_SIGNED_OUT = true;
  p.pick('nobody'); p.pick('me'); p.search('x'); p.answer(CASES(), { todo: I });
  assert.equal(p.session.writes.filter((w) => w[1] === KEY).length, n, 'no write of the kept list after Sign Out');
  assert.equal(p.kept.get(KEY), 'p:112');
  assert.deepEqual(p.pressed(), ['me'], 'the page itself still follows the press until it leaves');
  assert.ok(KEY.indexOf('tdot_list_') === 0, 'under the lists\' prefix: Sign Out forgets it with the filters');
  assert.equal(require('../src/routes/listFilters').LIST_STATE_KEYS_PREFIX, 'tdot_list_');
  // storage switched off (a private window): the page still works, the choice lives in the page
  const priv = await openPage({ search: '?view=todo' });
  priv.ctx.sessionStorage.getItem = () => { throw new Error('blocked'); };
  priv.ctx.sessionStorage.setItem = () => { throw new Error('blocked'); };
  priv.ctx.sessionStorage.removeItem = () => { throw new Error('blocked'); };
  priv.answer(CASES(), { todo: I });
  priv.pick('p:112');
  assert.deepEqual(priv.pressed(), ['p:112']);
});

test('the numbers and the words are about the list on screen: the tab\'s number, the count, the Filtered line, the header-filter counts; a search looks only in that list', async () => {
  const p = await openPage({ search: '?view=todo' });
  // who has a list is worked out ONCE per set of rows (the engine asks about every open row, several times, at every draw)
  let worked = 0;
  const realPeople = p.ctx.TDU.people;
  p.ctx.TDU.people = (...a) => { worked++; return realPeople(...a); };
  p.answer(CASES(), { todo: I });
  assert.equal(worked, 1);
  p.search('a'); p.search('ab'); p.search(''); p.tab('assigning'); p.tab('todo'); p.click('My cases'); p.click('My cases');
  assert.equal(worked, 1, 'searching, changing tab, opening and closing: the same rows, nothing worked out again');
  p.pick('p:112'); p.pick('me');
  assert.equal(worked, 3, 'a new choice of list: once more each');
  p.ctx.cmAsgApply('4', { names: ['Officer Two'], personIds: ['112'], teamIds: [] });
  assert.equal(worked, 4, 'the rows were handed over again (an Assign changes one in place): once more, so nothing stale is shown');
  p.answer(CASES(), { todo: I });
  assert.equal(worked, 5, 'new data');
  assert.ok(!p.head().includes('cm-filtered'), 'no Filtered line without a search or filter of the person\'s own');
  p.search('test client 2');
  assert.deepEqual(p.look(), ['My cases 1 ▾ #002']);
  assert.equal(p.count(), '1 of 3 cases');
  assert.equal(p.el('cm-filtered').textContent, 'Filtered: 1 of 3 on this list · Clear filters');
  assert.ok(p.head().includes('onclick="CasesTable.clearFilters()">Clear filters</button>'));
  assert.ok(!/Monday's view/.test(p.headText()), 'never "in Monday\'s view" on this tab');
  assert.equal(p.tabs().todo, 1, 'the tab\'s number is counted with the search on, like every tab');
  // the picker's numbers are of the whole lists — never of the engine's filtered rows
  assert.deepEqual(p.picker().map((b) => b[2]), ['✓ My list 3', 'Officer Two 2', 'Reviewer One 2', 'No one assigned 2']);
  // a case on another list is not found: the search looks only in the list chosen
  p.search('test client 4');
  assert.deepEqual(p.look(), []);
  assert.equal(p.none(), 'No cases on this list match. The search looks only in the list chosen above.');
  assert.equal(p.count(), '0 of 3 cases');
  assert.equal(p.el('cm-filtered').textContent, 'Filtered: 0 of 3 on this list · Clear filters', 'Clear filters stays');
  assert.equal(p.els['cm-oc'].style.display, 'none', 'nothing to open or close');
  p.ctx.CasesTable.clearFilters();
  assert.equal(p.count(), '3 cases');
  // the counts inside a column's filter are of the list on screen
  const core = p.ctx.CasesTable.core;
  assert.deepEqual(Array.from(core.facetCounts(p.ctx._data.cases, p.state(), 'officer'), (x) => [x.label, x.count]), [['Officer One', 2], ['Officer Two', 1]]);
  assert.deepEqual(Array.from(core.facetCounts(p.ctx._data.cases, p.state(), 'todoWith'), (x) => [x.label, x.count]), [['Officer One', 1], ['Reviewer One', 1], ['Nobody', 1]]);
  // a filter of the person's own
  p.state().sel.todoWith = ['Reviewer One']; p.ctx.CasesTable.apply('filter');
  assert.deepEqual(p.look(), ['My cases 1 ▾ — 1 passed #001']);
  assert.equal(p.el('cm-filtered').textContent, 'Filtered: 1 of 3 on this list · Clear filters');
  assert.ok(p.chips().includes('With: Reviewer One'));
  p.ctx.CasesTable.clearFilters();
  // a column sort chosen (on any tab) stays on here too; its chip goes back to the deadline order in words
  p.state().sort = { key: 'clientName', dir: 'desc' }; p.ctx.CasesTable.apply('sort');
  assert.deepEqual(p.look(), ['My cases 2 ▾ — 1 passed #002 #001', 'With me for review 1 ▾ — 1 no deadline #003'], 'the engine\'s order inside each heading');
  assert.ok(p.els['cs-chips'].innerHTML.includes('aria-label="Back to the normal order: soonest deadline first"') && p.els['cs-chips'].innerHTML.includes('title="Back to soonest deadline first"'));
  p.state().sort = { key: 'createdAt', dir: 'desc' }; p.ctx.CasesTable.apply('sort');
  assert.deepEqual(p.look()[0], 'My cases 2 ▾ — 1 passed #001 #002', 'back in deadline order');
});

test('the rows: "With …" in my own cases and "Also with …" in my review cases, never my own name; "Passed" in the cell that holds the date the row is ordered by; the Deadlines flags are not drawn here; Assign… stays', async () => {
  const cases = CASES().concat([
    mk(9, { officers: [ONE], managers: [ONE] }),                                                          // officer and manager the same person
    mk(10, { officers: [TWO], managers: [ONE, REV], deadlineType: 'Imaginary', promisedDate: '2026-11-05', actualDeadline: '2026-12-20', docUploadedPct: 10 }),   // two managers; an Imaginary date that has passed
    mk(11, { officers: [ONE], deadlineType: 'Imaginary', actualDeadline: '2026-11-02' }),                 // Imaginary with no Internal deadline: ordered by the Actual one
  ]);
  const p = await openPage({ search: '?view=todo' });
  p.answer(cases, { todo: I });
  assert.deepEqual(p.look(), ['My cases 4 ▾ — 2 passed · 1 no deadline #011 #001 #002 #009', 'With me for review 2 ▾ — 1 passed · 1 no deadline #010 #003']);
  const DASH = '<span style="color:var(--light)">—</span>';
  assert.equal(p.cell(1, 'todoWith'), '<td class="cm-c-with"><span class="cm-with">With Reviewer One</span></td>');
  assert.equal(p.cell(2, 'todoWith'), '<td class="cm-c-with">' + DASH + '</td>', 'no Case Manager: a dash, never "Unassigned"');
  assert.equal(p.cell(9, 'todoWith'), '<td class="cm-c-with">' + DASH + '</td>', 'the only manager is the person whose list it is');
  assert.equal(p.cell(3, 'todoWith'), '<td class="cm-c-with">' + DASH + '</td>', 'my review case with no other manager');
  assert.equal(p.cell(10, 'todoWith'), '<td class="cm-c-with"><span class="cm-with">Also with Reviewer One</span></td>');
  assert.ok(!p.rows().some((r) => /Unassigned/.test(r.innerHTML)));
  // Passed: Real / not recorded → the Actual deadline cell; Imaginary → the Internal deadline cell; an Imaginary case with no Internal date → the Actual one
  const PASSED = ' <span class="cm-flag passed" data-due="passed" title="This date has passed. Nothing has been changed.">Passed</span>';
  assert.ok(p.cell(1, 'actualDeadline').includes('Nov 10, 2026') && p.cell(1, 'actualDeadline').includes(PASSED) && !p.cell(1, 'internalDeadline').includes('Passed'));
  assert.ok(p.cell(10, 'internalDeadline').includes('Nov 5, 2026') && p.cell(10, 'internalDeadline').endsWith(PASSED + '</td>') && !p.cell(10, 'actualDeadline').includes('Passed'));
  assert.ok(p.cell(11, 'actualDeadline').includes(PASSED) && !p.cell(11, 'internalDeadline').includes('Passed'));
  assert.ok(!p.cell(2, 'internalDeadline').includes('Passed') && !p.cell(2, 'actualDeadline').includes('Passed') && !p.cell(3, 'actualDeadline').includes('Passed'), 'a date to come, or none: no pill');
  assert.ok(!p.rows().some((r) => /data-flag=|May slide|Promise passed|dlc-btn/.test(r.innerHTML)), 'none of the Deadlines tab\'s flags or its Change… button');
  assert.ok(!p.rows().some((r) => /cm-wait/.test(r.innerHTML)), 'no "Waiting for" line on this tab');
  assert.ok(p.cell(1, 'officerV').includes('Officer One <button type="button" class="cm-assign" data-assign="1"'), 'Assign… where the row allows it, as on Assigning');
  assert.ok(!p.cell(1, 'stageV').includes('tone-') && plain(p.cell(1, 'stageV')) === 'Internal Review');
  // on another person's list the same rule with that person
  p.pick('p:211');
  assert.deepEqual(p.look(), ['With Reviewer One for review 3 ▾ — 2 passed · 1 no deadline #010 #001 #008']);
  assert.equal(plain(p.cell(10, 'todoWith')), 'Also with Officer One');
  assert.equal(plain(p.cell(1, 'todoWith')), '—');
  // "No one assigned": every manager (there is none by the rule), grouped by stage
  p.pick('nobody');
  assert.equal(plain(p.cell(5, 'todoWith')), '—');
  // the same pills on the Deadlines / Assigning tabs are NOT drawn: "Passed" is this tab's only
  p.tab('assigning');
  assert.ok(!p.rows().some((r) => /data-due=|cm-with/.test(r.innerHTML)));
});

test('"No one assigned": open cases with no officer and no manager, grouped by stage in the board\'s order with the stage colours and the stage counts as buttons; its own first line', async () => {
  const p = await openPage({ search: '?view=todo&who=nobody' });
  // every view the page's grouping and ordering helpers are handed is noted: the tab's own definition must never be one of them
  const handed = [];
  for (const f of ['groupRows', 'viewOrder']) { const real = p.ctx.CMU[f]; p.ctx.CMU[f] = (view, ...rest) => { handed.push([f, view && view.key, view && view.by]); return real(view, ...rest); }; }
  p.answer(CASES(), { todo: I });
  assert.equal(p.title(), 'To-do · No one assigned');
  assert.deepEqual(p.look(), ['Document Collection Started 1 ▾ — 1 passed #006', 'Pre-Onboarding 1 ▾ — 1 no deadline #005'], 'case 8 has a Case Manager: it is not here');
  assert.deepEqual(p.heads().map((h) => h.className), ['cm-grp open tone-blue', 'cm-grp open tone-grey'], 'the stage colour on each heading, as on Assigning');
  assert.equal(p.el('cm-todo-l1').textContent, 'Open cases with no Case Support Officer and no Case Manager. Cases are usually given to someone at Internal Review; earlier stages show here until then.');
  assert.equal(p.el('cm-todo-l2').textContent, 'This list can differ from the Monday to-do boards. Those boards are not changed.');
  const strip = p.head().match(/<div class="cm-strip" id="cm-strip" role="group" aria-label="Cases by stage: press a stage to go to its group">(.*?)<\/div>/)[1];
  assert.deepEqual([...strip.matchAll(/<button type="button" class="cm-st (tone-[a-z]+)" data-go="([^"]+)" onclick="cmGrpGo\(this\.dataset\.go\)" title="[^"]*">([^<]*) <b>(\d+)<\/b><\/button>/g)].map((m) => m.slice(1).join('|')),
    ['tone-blue|nobody|0|Document Collection Started|1', 'tone-grey|nobody|12|Pre-Onboarding|1']);
  // a stage count goes to its group (opens it when it is closed) — the existing code, with the list's own group ids
  p.click('Pre-Onboarding');
  assert.equal(p.look()[1], 'Pre-Onboarding 1 ▸ — 1 no deadline');
  p.ctx.cmGrpGo('nobody|12');
  assert.equal(p.look()[1], 'Pre-Onboarding 1 ▾ — 1 no deadline #005');
  assert.equal(p.focused[p.focused.length - 1], 'group nobody|12');
  // a person's list has no stage strip, and the general first line
  p.pick('me');
  assert.ok(!p.head().includes('id="cm-strip"'));
  assert.equal(p.el('cm-todo-l1').textContent, 'From Client Master: cases where the person is Case Support Officer, and cases where they are Case Manager (for review). Soonest deadline first (Actual deadline; Internal deadline for an Imaginary case).');
  assert.equal(p.el('cm-todo-l2').textContent, 'This list can differ from the Monday to-do boards. Those boards are not changed.');
  assert.deepEqual(p.heads().map((h) => h.className), ['cm-grp open', 'cm-grp open'], 'a person\'s own groups carry no status colour');
  p.state().sort = { key: 'clientName', dir: 'asc' }; p.ctx.CasesTable.apply('sort');
  p.pick('nobody'); p.tab('assigning'); p.tab('todo');
  assert.ok(handed.length > 0 && handed.every((h) => h[1] !== 'todo' && h[2] !== 'todo'), 'the tab\'s definition is never handed to CMU.groupRows or CMU.viewOrder (it would silently group by board group)');
  assert.ok(handed.some((h) => h[0] === 'groupRows' && h[2] === 'stage' && h[1] !== 'assigning'), '"No one assigned" is grouped through a stage-grouped shape of the helper\'s own');
  // a person whose name reads like a status word gets no colour either (the board groups' "pending" / "cancel" rule is not for names)
  const odd = await openPage({ search: '?view=todo', session: { [KEY]: 'p:300' } });
  odd.answer([mk(1, { officers: [['300', 'Pending Cancel']] })], { todo: I });
  assert.deepEqual([odd.look(), odd.heads().map((h) => h.className)], [["Pending Cancel's cases 1 ▾ — 1 no deadline #001"], ['cm-grp open']]);
});

test('"More about this list": a native details with the five lines; it stays open through a redraw; the exact words', async () => {
  const p = await openPage({ search: '?view=todo' });
  p.answer(CASES(), { todo: I });
  const more = p.head().match(/<details class="cm-todo-more" id="cm-todo-more"( open)? ontoggle="cmTodoMore\(this\.open\)"><summary id="cm-todo-more-s">More about this list<\/summary><ul>(.*?)<\/ul><\/details>/);
  assert.ok(more && !more[1], 'closed to begin with');
  assert.deepEqual([...more[2].matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]), [
    'Only cases on the Assigning tab are listed.',
    "A case passed for review stays on the officer's list, marked 'With …'. The mark shows only when a Case Manager is set on Client Master.",
    'A case with two officers is on both lists.',
    'Work that has no case on Client Master is not listed.',
    'Looking at a list changes nothing in Monday. Assign… works here as on the Assigning tab: it sets the Case Support Officer in Monday.']);
  p.ctx.cmTodoMore(true);
  p.search('client');
  assert.ok(p.head().includes('<details class="cm-todo-more" id="cm-todo-more" open ontoggle='), 'still open after the box was redrawn');
  p.ctx.cmTodoMore(false);
  p.search('');
  assert.ok(p.head().includes('<details class="cm-todo-more" id="cm-todo-more" ontoggle='));
  assert.ok(!/Nothing here changes Monday/.test(p.headText()), 'the untrue line is not there (Assign… does write)');
  // someone on the summary with the keyboard keeps their place when new data redraws the box
  p.doc.activeElement = p.el('cm-todo-more-s');
  p.answer(CASES(), { todo: I });
  assert.equal(p.doc.activeElement.id, 'cm-todo-more-s');
  assert.equal(p.doc.activeElement.inHead, p.el('cm-todo-title').inHead, 'the new one');
});

test('the empty states, word for word — and never "No cases in the … view right now."', async () => {
  // nothing chosen: no Monday sign-in, so no "My list" to open on
  const key = await openPage({ search: '?view=todo' });
  key.answer(CASES(), { todo: { me: null } });
  assert.deepEqual(key.pressed(), []);
  assert.equal(key.none(), 'Choose a list above.');
  assert.equal(key.title(), 'To-do');
  assert.deepEqual([key.count(), key.tabs().todo], ['0 cases', 0], 'no list chosen: 0, never every open case');
  assert.equal(key.el('cm-todo-in').textContent, 'Sign in with Monday to open on your own list.');
  assert.ok(key.head().includes('<a href="/q/auth/monday?returnTo=' + encodeURIComponent('/admin/dashboard?view=todo&who=me') + '">Sign in with Monday</a> to open on your own list.'), 'the link comes back to this tab, on the person\'s own list');
  assert.deepEqual(key.picker().map((b) => b[0]), ['p:111', 'p:112', 'p:211', 'nobody'], 'everybody by name, no "My list"');
  assert.deepEqual(key.options()[0], ['', 'Choose a list…', true]);
  assert.ok(!key.head().includes('cm-filtered'));
  // my own list, empty
  const mine = await openPage({ search: '?view=todo' });
  mine.answer(CASES(), { todo: { me: { id: '900', name: 'Officer Nine', teamIds: [] } } });
  assert.deepEqual(mine.picker()[0], ['me', true, '✓ My list 0', 'My list, 0 cases'], '"My list" is there with 0 cases too');
  assert.equal(mine.none(), 'You have no open cases as Case Support Officer or Case Manager. Choose a name above to see another list.');
  assert.equal(mine.title(), 'To-do · Officer Nine');
  assert.equal(mine.count(), '0 cases');
  // a Monday sign-in with no name (the sign-in's name was an email: the server never sends that), not named on any row either
  const anon = await openPage({ search: '?view=todo' });
  anon.answer(CASES(), { todo: { me: { id: '900', name: '', teamIds: [] } } });
  assert.deepEqual([anon.title(), anon.el('cm-todo-in').textContent], ['To-do · My list', 'Signed in with Monday.']);
  // … named on a row, the name is learned from there
  const learned = await openPage({ search: '?view=todo' });
  learned.answer(CASES(), { todo: { me: { id: '112', name: '', teamIds: [] } } });
  assert.deepEqual([learned.title(), learned.el('cm-todo-in').textContent], ['To-do · Officer Two', 'Signed in with Monday as Officer Two.']);
  // "No one assigned", empty
  const all = await openPage({ search: '?view=todo&who=nobody' });
  all.answer(CASES().filter((c) => !['5', '6'].includes(c.id)), { todo: I });
  assert.deepEqual(all.picker()[3], ['nobody', true, '✓ No one assigned 0', 'No one assigned, 0 cases']);
  assert.equal(all.none(), 'Every open case has a Case Support Officer or a Case Manager.');
  // one case in a spoken name
  assert.equal(all.picker().find((b) => b[0] === 'p:112')[3], 'Officer Two, 2 cases');
  const one = await openPage({ search: '?view=todo' });
  one.answer([mk(1, { officers: [TWO] })], { todo: I });
  assert.equal(one.picker()[1][3], 'Officer Two, 1 case');
  for (const p of [key, mine, all]) {
    assert.ok(!/No cases in the|view right now|Monday's view/.test(plain(p.els['all-cases-body'].kids.map((k) => k.innerHTML).join(' ')) + p.headText()));
    assert.equal(p.els['cm-oc'].style.display, 'none');
  }
});

test('a kept person who no longer has an open case falls back to my own list — and without a Monday sign-in to no list; "me" changing between two answers is followed', async () => {
  const p = await openPage({ search: '?view=todo', session: { [KEY]: 'p:211' } });
  p.answer(CASES(), { todo: I });
  assert.deepEqual([p.pressed(), p.title()], [['p:211'], 'To-do · Reviewer One']);
  // new data: Reviewer One has nothing open any more
  p.answer(CASES().map((c) => ({ ...c, manager: 'Unassigned', managerIds: { personIds: [], teamIds: [] } })), { todo: I });
  assert.deepEqual([p.pressed(), p.title()], [['me'], 'To-do · Officer One']);
  assert.ok(!p.picker().some((b) => b[0] === 'p:211'), 'they are not offered while they have no open case');
  assert.equal(p.kept.get(KEY), 'p:211', 'the kept choice is left alone: it is used again the moment that person has a case');
  p.answer(CASES(), { todo: I });
  assert.deepEqual(p.pressed(), ['p:211']);
  // the sign-in of the NEXT answer is another person: "My list" is theirs at once (never kept from the first load)
  p.pick('me');
  assert.deepEqual([p.title(), p.look()[0]], ['To-do · Officer One', 'My cases 2 ▾ — 1 passed #001 #002']);
  p.answer(CASES(), { todo: { me: me(TWO) } });
  assert.deepEqual([p.pressed(), p.title()], [['me'], 'To-do · Officer Two']);
  assert.deepEqual(p.look(), ['My cases 2 ▾ — 1 no deadline #004 #003']);
  assert.equal(p.el('cm-todo-in').textContent, 'Signed in with Monday as Officer Two.');
  assert.ok(p.picker().some((b) => b[0] === 'p:111') && !p.picker().some((b) => b[0] === 'p:112'), 'the person signed in is "My list" — not repeated by name; the one before is back by name');
  assert.equal(p.tabs().todo, 2);
  // the next answer has no Monday sign-in at all (the cookie ran out, the switch fully on): my list cannot be shown
  p.answer(CASES(), { todo: { me: null } });
  assert.deepEqual([p.pressed(), p.none(), p.tabs().todo], [[], 'Choose a list above.', 0]);
  assert.equal(p.kept.get(KEY), 'me', 'kept as the word: after signing in again the tab opens on the person\'s own list');
  // a team I am in: its cases are on my list, and the team still shows as itself
  const t = await openPage({ search: '?view=todo' });
  t.answer(CASES().concat([mk(12, { officerTeams: [TEAM9] })]), { todo: { me: me(ONE, ['9']) } });
  assert.deepEqual(t.picker().map((b) => b[2]), ['✓ My list 4', 'Officer Two 2', 'Reviewer One 2', 'Team Nine 1', 'No one assigned 2']);
  // only my own cases are sent (CASE_VISIBILITY=assigned, reachable by a direct data call only): just "My list"
  const own = await openPage({ search: '?view=todo&who=nobody' });
  own.answer(CASES(), { todo: I, viewer: { name: 'Officer One', email: '', scope: 'assigned', isAdmin: false, canAssign: true } });
  assert.deepEqual(own.picker().map((b) => b[0]), ['me']);
  assert.deepEqual(own.pressed(), ['me'], '"No one assigned" is not offered then, so the link falls back to my own list');
  assert.ok(own.headText().includes('Showing only your cases; ask an admin to see everyone’s.'));
});

test('an answer WITHOUT the lists (an admin\'s Monday sign-in ended): one line with the way back in — no picker, no rows, no "Choose a list"; the lists return with the next answer that has them', async () => {
  const p = await openPage({ search: '?view=todo', session: { [KEY]: 'p:112' } });
  p.answer(CASES(), { todo: I });
  assert.deepEqual(p.pressed(), ['p:112']);
  // the next answer: no `todo`, no row marked, no managerIds (what the server sends when the tab is not for this request)
  const bare = CASES().map((c) => { const r = { ...c, views: c.views.filter((v) => v !== 'todo') }; delete r.managerIds; return r; });
  p.answer(bare);
  assert.equal(p.head(), '<div class="cm-line cm-todo-ended" id="cm-todo-ended">Your Monday sign-in has ended. <a href="/q/auth/monday?returnTo=' + encodeURIComponent('/admin/dashboard?view=todo') + '">Sign in with Monday again</a> to see the to-do lists.</div>');
  assert.equal(p.headText(), 'Your Monday sign-in has ended. Sign in with Monday again to see the to-do lists.');
  assert.deepEqual([p.picker(), p.options(), p.rows().length, p.heads().length, p.none()], [[], null, 0, 0, null], 'no picker, no select, no rows, and no line in the table');
  assert.deepEqual([p.tabs().todo, p.count()], [0, '0 cases']);
  assert.equal(p.els['cm-oc'].style.display, 'none');
  assert.equal(p.onTab(), 'todo', 'the tab stays where it is');
  assert.equal(p.kept.get(KEY), 'p:112', 'and the kept list is not thrown away');
  // even with rows still marked (an older answer shape), nothing is listed without the answer's own `todo`
  p.answer(CASES());
  assert.deepEqual([p.rows().length, p.tabs().todo, p.none()], [0, 0, null]);
  // the other tabs are untouched by all this
  p.tab('assigning');
  assert.equal(p.count(), '7 cases');
  p.tab('todo');
  // signed in again: the next answer has the lists, and the page is back on the kept list
  p.answer(CASES(), { todo: I });
  assert.deepEqual([p.pressed(), p.title(), p.rows().length], [['p:112'], 'To-do · Officer Two', 2]);
});

test('Assign on this tab (the existing code path, unchanged): a case assigned from "No one assigned" leaves the list — the row is gone, both counts change, a status line says where it went (the case reference only), and the focus goes to the chosen picker button', async () => {
  const p = await openPage({ search: '?view=todo&who=nobody' });
  p.answer(CASES(), { todo: I });
  assert.deepEqual(p.look(), ['Document Collection Started 1 ▾ — 1 passed #006', 'Pre-Onboarding 1 ▾ — 1 no deadline #005']);
  assert.equal(p.status(), '', 'the status line is there, empty');
  assert.ok(p.head().includes('<div class="cm-todo-status" id="cm-todo-status" role="status"></div>'));
  const fetchedBefore = p.fetched.length;
  // what the page does when the server answers an Assign: the row's officer from the answer, then the list is set again (cmAsgApply, not changed)
  p.doc.activeElement = { gone: true };   // the pop-up's button: the pop-up closes, so the focus would be nowhere
  p.ctx.cmAsgApply('5', { names: ['Officer Two'], personIds: ['112'], teamIds: [] }, true);
  assert.deepEqual(p.look(), ['Document Collection Started 1 ▾ — 1 passed #006'], 'the row is gone from the list on screen');
  assert.deepEqual(p.picker().map((b) => b[2]), ['My list 3', 'Officer Two 3', 'Reviewer One 2', '✓ No one assigned 1'], 'both counts changed: one fewer here, one more on the officer\'s list');
  assert.deepEqual([p.tabs().todo, p.count()], [1, '1 case']);
  assert.equal(p.status(), "2026-EE-005 is now on Officer Two's list.");
  assert.ok(!/Test Client/.test(p.status()), 'the case reference only — never the client\'s name');
  assert.equal(p.fetched.length, fetchedBefore, 'no request of the tab\'s own');
  p.later(0);
  assert.equal(p.focused[p.focused.length - 1], 'button nobody', 'the focus goes to the chosen picker button');
  // a redraw inside the six seconds keeps the line; after them it is gone
  p.later(3000);
  p.search('document');
  assert.equal(p.status(), "2026-EE-005 is now on Officer Two's list.");
  assert.ok(p.head().includes("role=\"status\">2026-EE-005 is now on Officer Two's list.</div>"), 'a redraw writes the line again while it is alive');
  p.later(3200);
  assert.equal(p.status(), '');
  p.search('');
  assert.equal(p.status(), '');
  // assigned from my own list to someone else: gone from mine; the case is on theirs
  p.pick('me');
  p.doc.activeElement = p.doc.body;
  p.ctx.cmAsgApply('2', { names: ['Officer Two'], personIds: ['112'], teamIds: [] });
  assert.deepEqual(p.look(), ['My cases 1 ▾ — 1 passed #001', 'With me for review 1 ▾ — 1 no deadline #003']);
  assert.equal(p.status(), "2026-EE-002 is now on Officer Two's list.");
  p.later(0);
  assert.equal(p.focused[p.focused.length - 1], 'button me');
  // an Assign that leaves the case ON the list on screen (I am its Case Manager): no line — the row's own "✓ Assigned" is there to see
  p.later(7000);
  p.ctx.cmFlash('3', '✓ Assigned');
  p.ctx.cmAsgApply('3', { names: ['Officer Three'], personIds: ['113'], teamIds: [] });
  assert.equal(p.status(), '');
  assert.ok(p.cell(3, 'officerV').includes('Officer Three') && p.cell(3, 'officerV').includes('role="status">✓ Assigned</span>'));
  // while someone is typing elsewhere the focus is left alone
  const box = p.els['search-box'];
  p.doc.activeElement = box;
  const n = p.focused.length;
  p.ctx.cmAsgApply('1', { names: ['Officer Two'], personIds: ['112'], teamIds: [] });
  p.later(0);
  assert.equal(p.status(), "2026-EE-001 is now on Officer Two's list.");
  assert.equal(p.focused.length, n, 'no focus is taken from the search box');
  assert.equal(p.doc.activeElement, box);
  // … and while the Assign pop-up is still open (the note could not be added; Monday had changed): the focus stays in the pop-up
  p.later(7000);
  p.pick('nobody');
  const m = p.focused.length;
  p.doc.activeElement = p.doc.body;
  p.ctx.TDOT_DLG.stack.push({ frame: {} });
  p.ctx.cmAsgApply('6', { names: ['Officer Two'], personIds: ['112'], teamIds: [] });
  p.later(0);
  assert.equal(p.status(), "2026-EE-006 is now on Officer Two's list.");
  assert.equal(p.focused.length, m, 'the pop-up keeps the focus');
  p.ctx.TDOT_DLG.stack.pop();
  // a case with no reference yet, and Monday now showing nobody: still true words, no client name
  const q = await openPage({ search: '?view=todo&who=nobody' });
  q.answer([mk(1, { caseRef: '' }), mk(2, { officers: [TWO] })], { todo: I });
  q.ctx.cmAsgApply('1', { names: ['Officer One', 'Officer Two'], personIds: ['111', '112'], teamIds: [] });
  assert.equal(q.status(), 'The case is now on the lists of Officer One and Officer Two.');
  q.later(7000);
  q.pick('p:112');
  q.ctx.cmAsgApply('2', { names: [], personIds: [], teamIds: [] });
  assert.equal(q.status(), '2026-EE-002 now has no Case Support Officer.');
  // new data from a Refresh is not an Assign made here: a case that left the list meanwhile brings no line
  const r = await openPage({ search: '?view=todo&who=nobody' });
  r.answer(CASES(), { todo: I });
  r.answer(CASES().map((c) => (c.id === '5' ? mk(5, { officers: [TWO], stageIdx: 12, caseStage: 'Pre-Onboarding' }) : c)), { todo: I });
  assert.equal(r.status(), '');
  assert.deepEqual(r.look(), ['Document Collection Started 1 ▾ — 1 passed #006']);
  // … and on another tab an Assign brings no to-do line at all
  const a = await openPage({ search: '?view=assigning' });
  a.answer(CASES(), { todo: I });
  a.ctx.cmAsgApply('5', { names: ['Officer Two'], personIds: ['112'], teamIds: [] });
  a.tab('todo');
  assert.equal(a.status(), '');
});

test('open and closed groups are remembered PER LIST: closing a section on one list leaves another person\'s open; under a search the choices are per list too', async () => {
  const p = await openPage({ search: '?view=todo' });
  p.answer(CASES(), { todo: I });
  p.click('With me for review');
  assert.deepEqual(p.look(), ['My cases 2 ▾ — 1 passed #001 #002', 'With me for review 1 ▸ — 1 no deadline']);
  assert.deepEqual(JSON.parse(p.kept.get(GRP_KEY)), { todo: { 'me|review': false } }, 'kept under the tab, by a group id that carries the list');
  p.pick('p:211');
  assert.deepEqual(p.look(), ['With Reviewer One for review 2 ▾ — 1 passed · 1 no deadline #001 #008'], 'the reviewer\'s only section is open');
  p.click('With Reviewer One for review');
  p.pick('nobody');
  p.click('Pre-Onboarding');
  assert.deepEqual(JSON.parse(p.kept.get(GRP_KEY)), { todo: { 'me|review': false, 'p:211|review': false, 'nobody|12': false } });
  p.pick('me');
  assert.deepEqual(p.look(), ['My cases 2 ▾ — 1 passed #001 #002', 'With me for review 1 ▸ — 1 no deadline'], 'my own choice is as I left it');
  // Open all / Close all act on the list on screen only
  p.ctx.cmGrpAll(false);
  assert.ok(p.look().every((t) => / ▸/.test(t)));
  assert.equal(p.count(), '3 cases', 'the count is of every case on the list, open or closed');
  p.ctx.cmGrpAll(true);
  p.pick('p:211');
  assert.equal(p.look()[0].includes('▸'), true, 'the reviewer\'s list is as it was left');
  // a new page in the same browser tab reads the kept choices
  const again = await openPage({ search: '?view=todo', session: { [GRP_KEY]: p.kept.get(GRP_KEY), [KEY]: 'nobody' } });
  again.answer(CASES(), { todo: I });
  assert.deepEqual(again.look(), ['Document Collection Started 1 ▾ — 1 passed #006', 'Pre-Onboarding 1 ▸ — 1 no deadline']);
  // a list never opens with a group closed that nobody closed: every group starts open
  const fresh = await openPage({ search: '?view=todo&who=nobody' });
  fresh.answer(CASES(), { todo: I });
  assert.ok(fresh.look().every((t) => / ▾/.test(t)));
  // under a search every group with a match is open; what is closed then is only for that search ON THAT LIST
  const s = await openPage({ search: '?view=todo' });
  s.answer(CASES(), { todo: I });
  s.click('My cases');
  s.search('test client');
  assert.ok(s.look().every((t) => / ▾/.test(t)), 'a closed group never hides a match');
  s.click('My cases');
  assert.equal(s.look()[0], 'My cases 2 ▸ — 1 passed');
  s.pick('p:112');
  assert.ok(s.look().every((t) => / ▾/.test(t)));
  s.click("Officer Two's cases");
  s.pick('me');
  assert.ok(s.look().every((t) => / ▾/.test(t)), 'another list is another search: the choice made under the first is not used');
  assert.deepEqual(JSON.parse(s.kept.get(GRP_KEY)), { todo: { 'me|mine': false } }, 'nothing done under a search is kept');
});

test('a phone: one native select with a visible label, drawn from the same people data as the buttons; choosing there puts the focus back on the select', async () => {
  const p = await openPage({ search: '?view=todo', phone: true });
  p.answer(CASES(), { todo: I });
  assert.ok(p.head().includes('<div class="cm-todo-phone" id="cm-todo-phone"><label class="cm-todo-sel-l" for="cm-todo-sel">Whose list</label><select class="cm-todo-sel" id="cm-todo-sel" onchange="cmTodoPick(this)">'));
  assert.deepEqual(p.options(), [['me', 'My list (3)', true], ['p:112', 'Officer Two (2)', false], ['p:211', 'Reviewer One (2)', false], ['nobody', 'No one assigned (2)', false]]);
  assert.deepEqual(p.options().map((o) => o[0]), p.picker().map((b) => b[0]), 'the same lists in the same order as the buttons');
  p.choose('p:211');
  assert.deepEqual([p.kept.get(KEY), p.title()], ['p:211', 'To-do · Reviewer One']);
  assert.deepEqual(p.options().filter((o) => o[2]).map((o) => o[0]), ['p:211']);
  assert.equal(p.focused[p.focused.length - 1], 'cm-todo-sel', 'the focus is back on the select');
  p.choose('');   // the "Choose a list…" line, were it there: nothing happens
  assert.equal(p.kept.get(KEY), 'p:211');
  // after an Assign the focus goes to the control that is on show: the select (the buttons are hidden)
  p.choose('nobody');
  p.doc.activeElement = p.doc.body;
  p.ctx.cmAsgApply('6', { names: ['Officer Two'], personIds: ['112'], teamIds: [] });
  p.later(0);
  assert.equal(p.focused[p.focused.length - 1], 'cm-todo-sel');
  // the look: buttons hidden and the select shown at 760px and below; 16px text; a finger-sized select
  const css = todoPage.TODO_CSS;
  assert.ok(css.includes('.cm-todo-phone { display:none;'));
  assert.ok(css.includes('@media (max-width: 760px) { .cm-todo-pick { display:none; } .cm-todo-phone { display:flex; } .cm-todo-sel-l { font-size:16px; }'));
  assert.ok(/\.cm-todo-sel \{[^}]*min-height:44px;[^}]*font-size:16px;/.test(css));
});

test('the look and the print: the picker has a class of its own on the pill look — no "›" arrow, the chosen one filled navy with white text; on paper the picker, the select, the sign-in line, the status line and "More…" are left out', async () => {
  const html = await pageOn(), css = todoPage.TODO_CSS;
  assert.ok(html.indexOf(css) > html.indexOf("button.cm-st::after { content:'›';"), 'the tab\'s style comes after the page\'s own, so its rules win');
  assert.ok(css.includes('button.cm-todo-b::after { content:none; }'));
  assert.ok(css.includes('.cm-todo-b[aria-pressed="true"], .cm-todo-b[aria-pressed="true"]:hover { background:var(--navy); border-color:var(--navy); color:#fff; }'));
  assert.ok(css.includes('.cm-todo-b[aria-pressed="true"] b { color:#fff; }'));
  assert.ok(html.includes('button.cm-st:focus-visible, .cm-oc-b:focus-visible, .cm-grp-b:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }'), 'the focus ring of the other pill buttons');
  assert.ok(css.includes('@media print { .cm-todo-pick, .cm-todo-phone, .cm-todo-in, .cm-todo-status, .cm-todo-more, .cm-todo-ended { display:none !important; } }'));
  assert.ok(css.includes('.cm-todo-status:empty { display:none; }'));
  assert.ok(css.includes('.cm-with {') && css.includes('#all-cases-table.cm-wide td.cm-c-with {'));
  assert.ok(html.includes('.cm-flag.passed { background:var(--st-red-bg); color:var(--st-red-fg); border:1px solid var(--st-red-solid); }'), '"Passed" uses the existing look');
  // what stays on paper: the title (it names the list), the data time, the lines, the table — the page's own print rules
  const print = html.slice(html.indexOf('@media print {', html.indexOf('@page { size: landscape')));
  assert.ok(print.slice(0, 400).includes('.cm-print,') && !/cm-title|cm-line|cm-dataat/.test(print.slice(0, 400)));
  // a page without the tab has none of this look
  const off = await withEnv({ TODO_TAB: undefined }, () => renderRoute('/'));
  assert.ok(!off.includes('cm-todo') && !off.includes('.cm-with'));
});

test('every name from Monday is text, never markup: the picker, the select, the title, the headings, the "With" pill, the spoken names, the status line', async () => {
  const BAD = '<img src=x onerror=alert(1)> & "Co"', SAFE = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;';
  const EVIL = ['666', BAD];
  const cases = [mk(1, { officers: [EVIL], managers: [REV] }), mk(2, { officers: [ONE], managers: [EVIL] }), mk(3, {})];
  const p = await openPage({ search: '?view=todo', session: { [KEY]: 'p:666' } });
  p.answer(cases, { todo: { me: { id: '111', name: BAD, teamIds: [] } } });
  const all = () => p.head() + p.els['all-cases-body'].kids.map((k) => k.innerHTML).join('');
  assert.ok(!/<img/.test(all()), 'no tag of the name\'s reaches the page');
  assert.ok(p.head().includes('aria-label="' + SAFE + ', 2 cases"') && p.head().includes('</span> ' + SAFE + ' <b>2</b></button>') && p.head().includes('>' + SAFE + ' (2)</option>'));
  assert.ok(p.head().includes('<span class="cm-title" id="cm-todo-title">To-do · ' + SAFE + '</span>'));
  assert.ok(p.head().includes('Signed in with Monday as ' + SAFE + '.'));
  assert.ok(p.heads()[0].innerHTML.includes('<b>' + SAFE + '\'s cases</b>') && p.heads()[0].innerHTML.includes('aria-label="' + SAFE + '\'s cases, 1 case, open'));
  assert.ok(p.heads()[1].innerHTML.includes('<b>With ' + SAFE + ' for review</b>'));
  assert.equal(p.title(), 'To-do · ' + BAD, 'and it reads as the name itself');
  p.pick('me');
  assert.equal(p.cell(2, 'todoWith'), '<td class="cm-c-with"><span class="cm-with">With ' + SAFE + '</span></td>');
  // the status line is set as text
  p.pick('nobody');
  p.ctx.cmAsgApply('3', { names: [BAD], personIds: ['666'], teamIds: [] });
  assert.equal(p.status(), '2026-EE-003 is now on ' + BAD + "'s list.");
  p.search('x');
  assert.ok(p.head().includes('role="status">2026-EE-003 is now on ' + SAFE + "'s list.</div>") && !/<img/.test(all()));
  // an empty list of someone with such a name: the table's line too (the one place a name is written into the table's own words)
  const cmTodoNone = todoPage.TODO_FUNCTIONS.find((f) => f.name === 'cmTodoNone');
  const ctx = vm.createContext({ TDU: { nameOf: () => BAD }, escHtml: p.ctx.escHtml });
  assert.equal(vm.runInContext('(' + cmTodoNone.toString() + ')({ ok: true, who: "p:666", size: 0, names: {} })', ctx), SAFE + ' has no open cases as Case Support Officer or Case Manager.');
});

/* The older page tests run the page's functions BY NAME with a fixed set of globals. The same harnesses here, on the page WITH the tab,
   with nothing of the tab's own block loaded: the common code must still run (every hook is behind a guard). */
function fnSrc(script, name) {
  const i = script.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is in the page');
  const line = script.slice(i + 1, script.indexOf('\n', i + 1));
  return /\}\s*$/.test(line) ? line : script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}

test('caseRow by itself (the older row harness: its fixed helpers, none of the tab\'s code): the row is drawn as before; with only the column\'s id known the "With" cell is made inline from every Case Manager, and no "Passed" pill', async () => {
  const main = mainOf(await pageOn());
  const el = () => ({ innerHTML: '', style: {}, className: '', title: '', onclick: null, querySelector: () => null });
  const page = (extra) => {
    const ctx = { window: { TDOT_IS_ADMIN: false }, document: { createElement: el, getElementById: () => null }, Date, isNaN, isFinite, String, Math,
      CM_FLASH: {}, CM_DL_FLASH: {}, TDOT_DEL_SVG: '[bin]', CM_PRE_ONBOARDING: cmv.PRE_ONBOARDING_INDEX, _data: null, CM_TABCOLS: JSON.parse(main.match(/var CM_TABCOLS = (.*);/)[1]), ...extra };
    vm.createContext(ctx);
    const names = ['caseRow', 'cmColIds', 'cmTextCell', 'cmPctCell', 'cmPortalCell', 'escHtml', 'healthBadge', 'shortType', 'cmNoneDash', 'cmDay', 'cmFlashText', 'cmDlFlashText'];
    vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' + names.map((n) => fnSrc(main, n)).join('\n'), ctx);
    return (c, v) => ctx.caseRow(c, v, TODAY).innerHTML.split('</td>').slice(0, -1).map((x) => x + '</td>');
  };
  const TODO_VIEW = JSON.parse(JSON.stringify(T.PAGE_VIEW)), ASSIGNING = cmv.pageViews()[0];
  const c = mk(1, { officers: [ONE], managers: [REV, TWO], deadlineType: 'Deadline', actualDeadline: '2026-11-10' });
  // nothing of the tab known at all: the tab's twelve cells, the "With" one empty (no id, no cell) — and the other tabs' rows as always
  const bare = page({});
  assert.equal(bare(c, ASSIGNING).length, 20);
  assert.equal(bare(c, null).length, 15);
  const none = bare(c, TODO_VIEW);
  assert.equal(none.length, 12);
  assert.equal(none[2], '<td></td>');
  assert.ok(!none.join('').includes('Passed'), 'no hook, no pill');
  // only the column's id: the cell from the row itself — every manager, never "Unassigned"
  const withId = page({ CM_TODO_COL: 'todoWith' });
  assert.equal(withId(c, TODO_VIEW)[2], '<td class="cm-c-with"><span class="cm-with">With Reviewer One, Officer Two</span></td>');
  assert.equal(withId(mk(2, { officers: [ONE] }), TODO_VIEW)[2], '<td class="cm-c-with"><span style="color:var(--light)">—</span></td>');
  assert.equal(withId({ ...c, manager: '<b>x</b> & y' }, TODO_VIEW)[2], '<td class="cm-c-with"><span class="cm-with">With &lt;b&gt;x&lt;/b&gt; &amp; y</span></td>');
  assert.deepEqual(withId(c, ASSIGNING), bare(c, ASSIGNING), 'a tab that does not show the column draws the same row');
});

test('the table code by itself (the older groups harness, none of the tab\'s code): a view marked as the page-only tab is never grouped by its own definition — it draws nothing rather than a wrong list; the other tabs draw as before', async () => {
  const main = mainOf(await pageOn());
  const mkEl = (tag) => { const e = { tag, className: '', style: {}, kids: [], _html: '', onclick: null, appendChild(c) { this.kids.push(c); }, getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, focus() {} };
    Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; this.kids = []; } }); return e; };
  const els = { 'all-cases-body': mkEl('tbody'), 'cm-head': mkEl('div'), 'cm-oc': mkEl('span') };
  const views = cmv.pageViews().concat([JSON.parse(JSON.stringify(T.PAGE_VIEW))]);
  const ctx = vm.createContext({ window: { sessionStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: true }) }, JSON, String, Object, Array,
    document: { getElementById: (id) => els[id] || null, createElement: mkEl, activeElement: null, querySelectorAll: () => [] },
    CM_VIEWS: views, CM_PRE_ONBOARDING: cmv.PRE_ONBOARDING_INDEX, CM_TABCOLS: JSON.parse(main.match(/var CM_TABCOLS = (.*);/)[1]), _data: { meta: META, cases: [] } });
  const names = ['renderCasesList', 'renderViewTable', 'renderCmHead', 'cmKept', 'cmKeptSave', 'cmGroupState', 'cmSetOpen', 'cmGrpToggle', 'cmGrpAll', 'cmGrpButton', 'cmGrpGo',
    'cmGroupTone', 'cmViewDef', 'cmView', 'cmInView', 'cmHm', 'cmDataTimeText', 'escHtml', 'cmColIds', 'cmScrollBox'];
  vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' + main.match(/var CM_GRP_KEY = [\s\S]*?var CM_LAST = null;[^\n]*/)[0] + '\n' + names.map((n) => fnSrc(main, n)).join('\n') + '\n' +
    'function cmToday() { return "2026-11-19"; }\nfunction stageTone() { return "grey"; }\nfunction caseRow(c, v) { return { className: "", id: c.id, view: v }; }\n' +
    'var HANDED = []; (function() { var g = CMU.groupRows, o = CMU.viewOrder; CMU.groupRows = function(v, r, m) { HANDED.push(v.key); return g(v, r, m); }; CMU.viewOrder = function(v, r) { HANDED.push(v.key); return o(v, r); }; })();', ctx);
  const rows = CASES();
  ctx._data.cases = rows;
  const out = ctx.renderCasesList(rows.filter((r) => r.views.includes('todo')), 'filter', { q: '', sel: { view: ['todo'] } }, { total: rows.length, defaultSort: true });
  assert.deepEqual(Array.from(ctx.HANDED), [], 'neither helper was handed the tab\'s definition');
  assert.deepEqual([els['all-cases-body'].kids.length, els['cm-head'].innerHTML, out.total], [0, '', 0], 'nothing drawn, an empty box, a list of 0');
  // the other tabs with the tab among the views: as before
  ctx.renderCasesList(rows.filter((r) => r.views.includes('assigning')), 'filter', { q: '', sel: { view: ['assigning'] } }, { total: rows.length, defaultSort: true });
  assert.deepEqual(Array.from(ctx.HANDED), ['assigning', 'assigning']);
  assert.equal(els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)).length, 4);
  assert.ok(els['cm-head'].innerHTML.includes('<span class="cm-title">Assigning</span>') && els['cm-head'].innerHTML.includes('id="cm-strip"'));
  assert.equal(ctx.cmGroupTone(views[3], { title: 'Pending cancel', section: 'mine' }), '', 'a person\'s group on the tab: no colour from a word in a name');
  assert.equal(ctx.cmGroupTone(views[3], { title: 'Stuck', section: 'nobody' }), ' tone-grey', '(the harness\'s stand-in for the stage colour)');
  assert.equal(ctx.cmGroupTone(views[0], { title: 'Stuck' }), ' tone-grey');
  assert.equal(ctx.cmGroupTone(views[2], { title: 'Pending' }), ' tone-amber', 'the board groups\' own rule is as it was');
});

test('the top bar on the page: "To-do" is lit while the tab is on screen, else "Client Master" — set once before any data and at every change of tab; nothing happens when the bar has no To-do link', async () => {
  const lit = (p) => p.navLinks.filter((a) => a.classList.contains('active')).map((a) => [a.attrs.href, a.attrs['aria-current'] || null]);
  // opened on the To-do tab (the top-bar link): lit before any data has come
  const p = await openPage({ search: '?view=todo&who=me' });
  assert.deepEqual(lit(p), [['/admin/dashboard?view=todo&who=me', 'page']], 'at once, while the spinner still turns');
  p.answer(CASES(), { todo: I });
  p.tab('assigning');
  assert.deepEqual(lit(p), [['/admin/dashboard', 'page']]);
  p.tab('todo');
  assert.deepEqual(lit(p), [['/admin/dashboard?view=todo&who=me', 'page']]);
  p.tab('');
  assert.deepEqual(lit(p), [['/admin/dashboard', 'page']]);
  assert.equal(p.navLinks.filter((a) => 'aria-current' in a.attrs).length, 1, 'one link says "page", never two');
  // opened on another tab: Client Master stays lit, as the server wrote it
  const q = await openPage({ search: '?view=deadlines' });
  assert.deepEqual(lit(q), [['/admin/dashboard', 'page']]);
  // a browser tab left on To-do, opened through "Client Master" (no ?view): the kept tab is To-do again — and the bar says so
  const kept = await openPage({ session: { [TAB_KEY]: 'todo' } });
  assert.deepEqual(lit(kept), [['/admin/dashboard?view=todo&who=me', 'page']]);
  assert.equal(kept.onTab(), 'todo', 'the Client Master link still opens the tab this browser tab was last on');
  // the tab is on the page but the bar has no link (admins-only mode): nothing is touched
  const adm = await openPage({ search: '?view=todo', bar: 'admins' });
  assert.equal(adm.navLinks.length, 6);
  adm.answer(CASES(), { todo: I });
  adm.tab('assigning'); adm.tab('todo');
  assert.deepEqual(lit(adm), [['/admin/dashboard', 'page']], 'Client Master stays lit');
  // the other script that walks the top bar matches a link by its exact address: a seventh link does not disturb it
  assert.ok(fs.readFileSync(require.resolve('../src/routes/adminConsultation'), 'utf8').includes("var on=a.getAttribute('href')===nav;"));
});

test('"With" may be added on the other tabs through the Columns button (the same cell: every Case Manager); the To-do tab is offered the other tabs\' columns by the existing rules', async () => {
  const p = await openPage({ search: '?view=assigning' });
  p.answer(CASES(), { todo: I });
  const plan = (tab) => p.ctx.CMU.colPlan(p.ctx.CM_TABCOLS, tab);
  assert.ok(plan('assigning').extra.includes('todoWith') && plan('').extra.includes('todoWith') && plan('deadlines').extra.includes('todoWith'));
  assert.deepEqual(Array.from(plan('todo').own), TWELVE);
  assert.ok(plan('todo').extra.includes('manager') && !plan('todo').extra.includes('managerV') && plan('todo').extra.includes('phase') && plan('todo').extra.includes('clientEmail'), 'the manager column offered there is the All tab\'s "Manager"');
  assert.ok(!plan('todo').extra.includes('del'));
  p.ctx.CMCOLS.toggle('assigning', 'todoWith', true);
  p.ctx.CasesTable.apply('columns');
  assert.equal(p.headerRow()[p.headerRow().length - 1], 'With');
  assert.equal(p.headerRow().length, 21);
  assert.equal(p.cell(1, 'todoWith'), '<td class="cm-c-with"><span class="cm-with">With Reviewer One</span></td>');
  assert.equal(plain(p.cell(3, 'todoWith')), 'With Officer One', 'on another tab nobody is left out');
  assert.equal(plain(p.cell(5, 'todoWith')), '—');
  // the To-do tab remembers its own choice like the other tabs
  p.tab('todo');
  p.ctx.CMCOLS.toggle('todo', 'qPct', false);
  p.ctx.CasesTable.apply('columns');
  assert.equal(p.headerRow().length, 11);
  assert.ok(JSON.parse(p.local.m.get('tdot_view_cm_columns_v1')).tabs.todo.hidden.includes('qPct'));
});
