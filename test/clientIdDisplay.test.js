'use strict';

// Build step 5 (2026-11-25): where the Client ID SHOWS — the Client Master page (an optional column + the search),
// the case page (the ID under the name + "Other cases of this client"), the warn-and-link panels, the Leads search,
// the client portal line and the one short line in client email BODIES (never the subject).
// Everything is inert while the "Client ID" columns are not made (the shipped config): each test sets the config
// it needs and puts it back. All made-up data. Monday, Graph and axios are stubbed; nothing leaves the machine.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');
const axios  = require('axios');

const D         = require('../src/services/clientIdDisplay');
const { parseClientId } = require('../src/utils/clientId');
const mondayApi = require('../src/services/mondayApi');
const S         = require('../src/routes/listSpecs');
const { listCore } = require('../src/routes/listFilters');

const CM_COL = 'text_cid_cm', LEAD_COL = 'text_cid_lead', CL_COL = 'text_cid_clients';
const CONFIGURED = { boardId: '1', columns: { clientId: CL_COL }, cmLinkColumns: { clientAccountId: 'text_mm5xmeka', clientId: CM_COL }, leadLinkColumns: { clientId: LEAD_COL } };
const SHIPPED = { boardId: '1', columns: { clientId: null }, cmLinkColumns: { clientAccountId: 'text_mm5xmeka', clientId: null }, leadLinkColumns: { clientId: null } };

function stub(obj, key, fn) { const keep = obj[key]; obj[key] = fn; return () => { obj[key] = keep; }; }
async function withConfig(cfg, fn) {
  D._resetForTests(); D._setConfigForTests(cfg);
  try { return await fn(); } finally { D._resetForTests(); }
}
const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

// ─── the pieces ────────────────────────────────────────────────────────────────

test('the shipped config: every Client ID column is still missing, so nothing is read and nothing shows', () => {
  D._resetForTests();
  assert.deepEqual(D.columns(), { clients: '', cm: '', lead: '' });
});

test('shownId / the line: only a stored ID shows; a blank, a typo, a Monday item id or markup shows NOTHING (never "CL-" or "undefined")', () => {
  assert.equal(D.shownId(' CL-2026-00042 '), 'CL-2026-00042');
  for (const bad of ['', null, undefined, 'cl-2026-00042', 'CL-2026-42', 'CL 42', '18425020416', '<b>CL-2026-00042</b>', 'CL-2026-00000']) {
    assert.equal(D.shownId(bad), '', String(bad));
    assert.equal(D.clientNumberLine(bad), '');
    assert.equal(D.mailLineHtml(bad), '');
    assert.equal(D.addMailLine('<p>hi</p>', bad), '<p>hi</p>', 'the body exactly as given');
  }
  assert.equal(D.clientNumberLine('CL-2026-00042'), 'Your client number: CL-2026-00042');
  assert.equal(D.clientNumberLine('CL-2027-123456'), 'Your client number: CL-2027-123456');
});

test('the email line: once, at the end of the body (before </body> when there is one), plain words, nothing from outside unescaped', () => {
  const line = D.mailLineHtml('CL-2026-00042');
  assert.match(line, /^<div data-tdot-client-id="1" style="[^"<>]*">Your client number: CL-2026-00042<\/div>$/);
  const doc = '<html><body><table><tr><td>Hello</td></tr></table></body></html>';
  const out = D.addMailLine(doc, 'CL-2026-00042');
  assert.equal(out, '<html><body><table><tr><td>Hello</td></tr></table>' + line + '</body></html>');
  assert.equal(D.addMailLine(out, 'CL-2026-00042'), out, 'never twice');
  assert.equal(D.addMailLine('<p>Hi</p>', 'CL-2026-00042'), '<p>Hi</p>' + line, 'no </body>: at the end');
  assert.equal(D.addMailLine('<P>a</P></BODY>', 'CL-2026-00042'), '<P>a</P>' + line + '</BODY>', 'any case');
  assert.equal(D.addMailLine(null, 'CL-2026-00042'), line);
});

test('caseStanding: a Cancel / Did-not-retain row is "Cancelled", a Leads-group row "Lead only", TEST "Test" — none of them open; a closing stage is "Closed (…)"', () => {
  assert.deepEqual(D.caseStanding({ group: { id: 'group_mm3b9tap', title: 'Cancel /Did not retained' }, caseStage: 'Document Collection Started' }), { kind: 'cancelled', label: 'Cancelled' });
  assert.deepEqual(D.caseStanding({ group: { id: 'x', title: 'Cancel / Did not retain' } }), { kind: 'cancelled', label: 'Cancelled' }, 'by title too');
  assert.deepEqual(D.caseStanding({ group: { id: 'group_mm2tz8e1', title: 'Leads' }, caseStage: 'Not Started' }), { kind: 'lead', label: 'Lead only' });
  assert.deepEqual(D.caseStanding({ group: { id: 'group_mm3842s', title: 'TEST' } }), { kind: 'test', label: 'Test' });
  assert.deepEqual(D.caseStanding({ group: { id: 'g', title: 'November 2026' }, caseStage: 'Approved' }), { kind: 'closed', label: 'Closed (Approved)' });
  assert.deepEqual(D.caseStanding({ group: { id: 'g', title: 'November 2026' }, caseStage: 'Internal Review' }), { kind: 'open', label: 'Internal Review' });
  assert.deepEqual(D.caseStanding({ group: {}, caseStage: '' }), { kind: 'open', label: 'Open' });
  assert.deepEqual(D.caseStanding(), { kind: 'open', label: 'Open' });
});

// ─── the Client Master page ────────────────────────────────────────────────────

const TYPED = ['cl 42', 'CL42', 'CL-42', 'cl-00042', 'CL-2026-00042', 'cl 2026 42', 'CL.2026.42', 'CL#42', 'cl:2026-42', 'CL—2026—42', 'cl\t42',
  'cl  -  2026 . 42', 'CL 2026', 'CL 2025 42', 'cl-26-42', '42', '00042', 'CL', 'CL 0', 'CL 12345678', 'CL 2026 2026 4', 'clx42', 'CL 0999 42',
  'CL 2026-', 'cl 42a', 'TD-12345', 'CLIENT 42', '2026-CL-00042', 'CL202600042', ' CL 42 ', 'C L 42', 'CL 9999999', 'CL 1000 1'];

test('the page\'s own copy of the typed-ID reader (written without a backslash) agrees with parseClientId on every input', () => {
  const spec = S.casesListSpec({ views: [] });
  for (const q of TYPED) {
    const p = parseClientId(q);
    for (const id of ['CL-2026-00042', 'CL-2025-00042', 'CL-2026-02026', 'CL-1000-00001', 'CL-2026-9999999']) {
      const want = !!p && p.n === Number(id.split('-')[2]) && (!p.year || p.year === Number(id.split('-')[1]));
      assert.equal(spec.search.match({ clientId: id }, q.toLowerCase()), want, `${JSON.stringify(q)} vs ${id}`);
    }
  }
});

test('the Client Master search: "CL 42" finds that ONE person (not 420 or 4200), the whole ID and "00042" find it as written; a row with no ID is never hit', () => {
  const LT = listCore(S.casesListSpec({ views: [] }));
  const rows = [
    { id: '1', caseRef: '2026-VV-001', clientName: 'Ann Example', clientId: 'CL-2026-00042', views: [] },
    { id: '2', caseRef: '2026-VV-002', clientName: 'Bob Example', clientId: 'CL-2026-00420', views: [] },
    { id: '3', caseRef: '2026-VV-003', clientName: 'Cy Example', clientId: 'CL-2025-04200', views: [] },
    { id: '4', caseRef: '2026-VV-004', clientName: 'Dee Example', views: [] },
    { id: '5', caseRef: '2026-VV-005', clientName: 'Eve Example', clientId: 'garbage 42', views: [] },
  ];
  const find = (q) => { const st = LT.emptyState(); st.q = q; return LT.filterRows(rows, st).map((r) => r.id); };
  assert.deepEqual(find('CL 42'), ['1']);
  assert.deepEqual(find('cl42'), ['1']);
  assert.deepEqual(find('CL-2026-00042'), ['1']);
  assert.deepEqual(find('CL 2025 42'), [], 'a typed year must match');
  assert.deepEqual(find('cl 420'), ['2']);
  assert.deepEqual(find('CL 4200'), ['3']);
  assert.deepEqual(find('00042'), ['1'], 'the ID as written');
  assert.deepEqual(find('ann'), ['1'], 'the old search still works');
  // the search text carries the ID only when the row has one (a row without it reads as before)
  const spec = S.casesListSpec({ views: [] });
  assert.deepEqual(spec.search.text(rows[3]), ['Dee Example', '2026-VV-004', undefined, undefined, undefined, undefined, undefined]);
  assert.equal(spec.search.text(rows[0]).slice(-1)[0], 'CL-2026-00042');
});

test('the Client ID column: none until the Monday column exists; then ONE optional column (on no tab, last of the optional ones), sorted by the number, blanks last', () => {
  const before = S.casesListOpts({ views: [] }).cols.map((c) => c.id);
  assert.ok(!before.includes('clientId'));
  assert.ok(!('clientId' in S.casesListSpec({ views: [] }).sorts));
  const cols = S.casesListOpts({ views: [], clientIdCol: true }).cols;
  assert.deepEqual(cols.map((c) => c.id), before.concat(['clientId']));
  const c = cols.find((x) => x.id === 'clientId');
  assert.deepEqual([c.label, c.more, c.tabs, c.sort], ['Client ID', 'text', [], 'clientId']);
  const spec = S.casesListSpec({ views: [], clientIdCol: true });
  assert.equal(spec.sorts.clientId({ clientId: 'CL-2026-00042' }), '000000042');
  assert.equal(spec.sorts.clientId({ clientId: 'CL-2025-00100' }) > spec.sorts.clientId({ clientId: 'CL-2026-00042' }), true, 'the number, not the year label');
  assert.equal(spec.sorts.clientId({}), '');
  assert.ok(spec.sortBlanksLast.includes('clientId'));
});

test('the Client Master rows carry clientId ONLY once the copy column is made — read from that column, a non-ID cell is ""; the board read asks for it', async () => {
  const dash = require('../src/services/dashboardService');
  const item = (cells) => ({ id: '9', name: 'Ann Example', created_at: '2026-11-01T00:00:00Z', group: { id: 'g', title: 'Nov' }, column_values: cells });
  await withConfig(SHIPPED, () => { assert.ok(!('clientId' in dash.parseItem(item([{ id: CM_COL, text: 'CL-2026-00042' }]), 0))); });
  await withConfig(CONFIGURED, () => {
    assert.equal(dash.parseItem(item([{ id: CM_COL, text: 'CL-2026-00042' }]), 0).clientId, 'CL-2026-00042');
    assert.equal(dash.parseItem(item([{ id: CM_COL, text: '18425020416' }]), 0).clientId, '');
    assert.equal(dash.parseItem(item([]), 0).clientId, '');
    assert.equal(dash.parseItem(item([{ id: 'text_mm5xmeka', text: 'CL-2026-00042' }]), 0).clientId, '', 'never from the Client Account (item id) column');
  });
});

test('the Client Master page: with the column made it offers "Client ID" (CM_MORE, names, the list ctx) and every emitted script parses; without it, nothing of it', async () => {
  const router = require('../src/routes/adminDashboard');
  const layer = router.stack.find((l) => l.route && l.route.path === '/');
  const page = () => new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
  const keep = process.env.TODO_TAB; delete process.env.TODO_TAB;
  try {
    const off = await withConfig(SHIPPED, page);
    assert.ok(!off.includes(', clientIdCol: true') && !off.includes('"clientId":"text"') && !off.includes('"clientId":"Client ID"'));
    const on = await withConfig(CONFIGURED, page);
    const main = scriptsOf(on)[0];
    assert.equal(JSON.parse(main.match(/var CM_MORE = (\{.*?\});/)[1]).clientId, 'text');
    assert.equal(JSON.parse(main.match(/var CM_COLNAMES = (\{.*?\});/)[1]).clientId, 'Client ID');
    assert.ok(on.includes(', clientIdCol: true }'), 'the page list gets the same answer as the server');
    for (const sc of scriptsOf(on)) assert.doesNotThrow(() => new vm.Script(sc));
    // the cell: the ID, or the page's dash
    assert.ok(main.includes("clientId: cmTextCell('cm-c-cid', c.clientId, false),"));
  } finally { if (keep === undefined) delete process.env.TODO_TAB; else process.env.TODO_TAB = keep; }
});

// ─── the case page ─────────────────────────────────────────────────────────────

test('otherCasesOfClient: no ID or no column = no read; one read by the copy column (limit 50); this case, other IDs and TEST rows left out; Cancelled / Lead only said so; a failed read is "unavailable"', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const calls = [];
  const it = (id, ref, cid, group, stage) => ({ id, group, column_values: [{ id: 'text_mm142s49', text: ref }, { id: 'dropdown_mm0xd1qn', text: 'Visitor Visa' }, { id: 'color_mm0x8faa', text: stage }, { id: CM_COL, text: cid }] });
  const back = stub(mondayApi, 'query', async (q, v) => {
    calls.push({ q, v });
    return { items_page_by_column_values: { items: [
      it('100', '2026-VV-001', 'CL-2026-00042', { id: 'g', title: 'November 2026' }, 'Internal Review'),   // this case
      it('101', '2025-SV-004', 'CL-2026-00042', { id: 'group_mm3b9tap', title: 'Cancel /Did not retained' }, 'Document Collection Started'),
      it('102', '', 'CL-2026-00042', { id: 'group_mm2tz8e1', title: 'Leads' }, ''),
      it('103', '2026-PR-007', 'CL-2026-00042', { id: 'g', title: 'October 2026' }, 'Submitted'),
      it('104', '2026-XX-009', 'CL-2026-00042', { id: 'group_mm3842s', title: 'TEST' }, 'Internal Review'),
      it('105', '2026-XX-010', 'CL-2026-000420', { id: 'g', title: 'October 2026' }, 'Internal Review'),
    ] } };
  });
  try {
    await withConfig(SHIPPED, async () => {
      assert.deepEqual(await cockpit.otherCasesOfClient('CL-2026-00042', '100'), { otherCases: [], otherCasesUnavailable: false, more: false });
    });
    await withConfig(CONFIGURED, async () => {
      assert.deepEqual(await cockpit.otherCasesOfClient('', '100'), { otherCases: [], otherCasesUnavailable: false, more: false });
      assert.deepEqual(await cockpit.otherCasesOfClient('not an id', '100'), { otherCases: [], otherCasesUnavailable: false, more: false });
      assert.equal(calls.length, 0, 'nothing read without an ID or a column');
      const r = await cockpit.otherCasesOfClient('CL-2026-00042', '100');
      assert.equal(calls.length, 1);
      assert.match(calls[0].q, /items_page_by_column_values\(limit:50, board_id:\$b, columns:\[\{column_id:"text_cid_cm", column_values:\[\$v\]\}\]\)/);
      assert.ok(!/items\(ids/.test(calls[0].q));
      assert.equal(calls[0].v.v, 'CL-2026-00042');
      assert.deepEqual(r.otherCases, [
        { caseRef: '2026-PR-007', caseType: 'Visitor Visa', caseStage: 'Submitted', standing: 'Submitted', kind: 'open' },
        { caseRef: '2025-SV-004', caseType: 'Visitor Visa', caseStage: 'Document Collection Started', standing: 'Cancelled', kind: 'cancelled' },
        { caseRef: '', caseType: 'Visitor Visa', caseStage: '', standing: 'Lead only', kind: 'lead' },
      ]);
      assert.equal(r.otherCasesUnavailable, false);
      mondayApi.query = async () => { throw new Error('Monday down'); };
      const warn = stub(console, 'warn', () => {});
      try { assert.deepEqual(await cockpit.otherCasesOfClient('CL-2026-00042', '100'), { otherCases: [], otherCasesUnavailable: true, more: false }); } finally { warn(); }
    });
  } finally { back(); }
});

test('readClientMaster: reads the Client ID copy only once the column is made; the case\'s ID is the stored form or ""', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  let q = '';
  const back = stub(mondayApi, 'query', async (gql) => { q = gql; return { items: [{ group: { id: 'g', title: 'Nov' }, column_values: [{ id: CM_COL, text: 'CL-2026-00042' }], updates: [] }] }; });
  try {
    await withConfig(SHIPPED, async () => { const r = await cockpit.readClientMaster('100'); assert.equal(r.clientId, ''); assert.ok(!q.includes(CM_COL)); });
    await withConfig(CONFIGURED, async () => { const r = await cockpit.readClientMaster('100'); assert.equal(r.clientId, 'CL-2026-00042'); assert.ok(q.includes(`"${CM_COL}"`)); });
  } finally { back(); }
});

/** The case page's own renderClientId over a tiny fake page. */
function casePage() {
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-VV-001', {});
  for (const sc of scriptsOf(html)) assert.doesNotThrow(() => new vm.Script(sc), 'every emitted script parses');
  const js = scriptsOf(html).find((s) => s.includes('function renderClientId('));
  const start = js.indexOf('function renderClientId(');
  const fn = js.slice(start, js.indexOf('function render(d)', start));
  const esc = js.slice(js.indexOf('function escHtml('), js.indexOf('}', js.indexOf('function escHtml(')) + 1);
  const els = { 'c-cid': { style: {}, textContent: '' }, 'oc-card': { style: {}, innerHTML: '' } };
  const ctx = { document: { getElementById: (id) => els[id] || null }, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(esc + '\n' + fn, ctx);
  assert.ok(html.includes('id="c-cid" style="display:none"') && html.includes('id="oc-card" style="display:none'), 'both start hidden');
  return { els, render: (d) => ctx.renderClientId(d) };
}

test('the case page: the ID under the name; "Other cases of this client" with Cancelled / Lead only said so; no ID = nothing; a failed read says so; everything escaped', () => {
  const p = casePage();
  // no client block at all (the column not made), or a blank ID: neither shows
  for (const d of [{}, { client: { id: '', otherCases: [{ caseRef: 'X' }] } }]) {
    p.render(d);
    assert.equal(p.els['c-cid'].style.display, 'none'); assert.equal(p.els['c-cid'].textContent, '');
    assert.equal(p.els['oc-card'].style.display, 'none'); assert.equal(p.els['oc-card'].innerHTML, '');
  }
  p.render({ client: { id: 'CL-2026-00042', otherCases: [], otherCasesUnavailable: false } });
  assert.equal(p.els['c-cid'].textContent, 'Client ID CL-2026-00042');
  assert.equal(p.els['c-cid'].style.display, '');
  assert.equal(p.els['oc-card'].style.display, 'none', 'no other case: no box');
  p.render({ client: { id: 'CL-2026-00042', otherCases: [
    { caseRef: '2026-PR-007', caseType: 'PR <b>', standing: 'Submitted', kind: 'open' },
    { caseRef: '2025-SV-004', caseType: 'Super Visa', standing: 'Cancelled', kind: 'cancelled' },
    { caseRef: '', caseType: '', standing: 'Lead only', kind: 'lead' },
  ] } });
  const h = p.els['oc-card'].innerHTML;
  assert.equal(p.els['oc-card'].style.display, '');
  assert.match(h, /Other cases of this client <span class="cnt">3<\/span>/);
  assert.match(h, /<a href="\/admin\/case\/2026-PR-007">2026-PR-007<\/a> · PR &lt;b&gt; <span class="oc-st oc-open">Submitted<\/span>/);
  assert.match(h, /2025-SV-004<\/a> · Super Visa <span class="oc-st oc-cancelled">Cancelled<\/span>/);
  assert.match(h, /No case number yet<\/span> <span class="oc-st oc-lead">Lead only<\/span>/);
  assert.ok(!/open case/i.test(h.replace('oc-open', '')), 'a cancelled or lead-only row is never called open');
  p.render({ client: { id: 'CL-2026-00042', otherCases: [], otherCasesUnavailable: true } });
  assert.match(p.els['oc-card'].innerHTML, /could not be read just now/);
  assert.equal(p.els['oc-card'].style.display, '');
});

// ─── the profile "New application" box (review #10) ────────────────────────────

test('the New application box: only OPEN cases are "open cases"; Cancelled / Lead only / Closed are listed as not open; this case and TEST rows left out', () => {
  const { splitPriorCases } = require('../src/services/clientProfileService');
  const r = splitPriorCases([
    { caseRef: '2026-VV-001', caseStage: 'Internal Review', group: { id: 'g', title: 'Nov' } },    // this case
    { caseRef: '2026-PR-007', caseStage: 'Submitted', group: { id: 'g', title: 'Oct' } },
    { caseRef: '2025-SV-004', caseStage: 'Document Collection Started', group: { id: 'group_mm3b9tap', title: 'Cancel /Did not retained' } },
    { caseRef: '2025-SV-005', caseStage: 'Not Started', group: { id: 'group_mm2tz8e1', title: 'Leads' } },
    { caseRef: '2024-WP-002', caseStage: 'Approved', group: { id: 'g', title: 'Old' } },
    { caseRef: '2026-XX-009', caseStage: 'Internal Review', group: { id: 'group_mm3842s', title: 'TEST' } },
    { caseRef: '', caseStage: 'Internal Review', group: {} },
  ], '2026-VV-001');
  assert.deepEqual(r.openCases, [{ caseRef: '2026-PR-007', caseStage: 'Submitted' }]);
  assert.deepEqual(r.otherCases, [
    { caseRef: '2025-SV-004', standing: 'Cancelled' }, { caseRef: '2025-SV-005', standing: 'Lead only' }, { caseRef: '2024-WP-002', standing: 'Closed (Approved)' }]);
  assert.deepEqual(splitPriorCases(null, 'x'), { openCases: [], otherCases: [] });
});

test('getClientCases reads each row\'s group (so a Cancelled row is never called open)', async () => {
  const acc = require('../src/services/clientAccountService');
  let q = '';
  const back = stub(mondayApi, 'query', async (gql) => { q = gql; return { items_page_by_column_values: { items: [{ id: '7', name: 'Ann', group: { id: 'group_mm3b9tap', title: 'Cancel' }, column_values: [{ id: 'text_mm142s49', text: '2025-SV-004' }] }] } }; });
  acc._setBoardForTests(CONFIGURED);
  try {
    const rows = await acc.getClientCases('555');
    assert.match(q, /group\{ id title \}/);
    assert.deepEqual(rows[0].group, { id: 'group_mm3b9tap', title: 'Cancel' });
  } finally { back(); acc._setBoardForTests(undefined); }
});

test('the Retainers page New-application box shows the not-open cases as not open', () => {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();
  const js = scriptsOf(html)[0];
  const fn = js.slice(js.indexOf('function dcApplyProfile(ref,p){'), js.indexOf('function dcLoadProfile('));
  const els = { 'dc-name': { value: '' }, 'dc-email': { value: '' }, 'dc-phone': { value: '' }, 'dc-address': { value: '' }, 'dc-profile': { style: {}, innerHTML: '' } };
  const run = new Function('dcEl', 'escHtml', `var DC_PROFILE_REF, DC_PROFILE_ADDR; ${fn}; return dcApplyProfile;`)((id) => els[id], (s) => String(s == null ? '' : s).replace(/</g, '&lt;'));
  run('2026-VV-001', { identity: {}, priorFacts: { openCases: [{ caseRef: '2026-PR-007', caseStage: 'Submitted' }], otherCases: [{ caseRef: '2025-SV-004', standing: 'Cancelled' }] } });
  const h = els['dc-profile'].innerHTML;
  assert.match(h, /This client also has open case 2026-PR-007 \(Submitted\)\./);
  assert.match(h, /This client also has case 2025-SV-004 \(Cancelled\)\. It is not open\./);
  assert.ok(!/open case 2025-SV-004/.test(h));
});

// ─── the warn-and-link panels ──────────────────────────────────────────────────

test('findClientMatches: a client account reaches the page as its readable Client ID ("" when none) — never the Monday item id', async () => {
  const portal = require('../src/services/consultantPortalService');
  const leadService = require('../src/services/leadService');
  const cm = require('../src/services/clientMasterService');
  const acc = require('../src/services/clientAccountService');
  const rs = [
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(cm, 'findCasesByEmail', async () => []),
    stub(cm, 'findCasesByPhone', async () => []),
    stub(acc, 'findMatches', async () => [
      { id: '18425020999', name: 'Ann Example', email: 'ann@example.com', confidence: 'exact', reasons: ['email'], clientIdText: 'CL-2026-00042' },
      { id: '18425021000', name: 'Ann E', email: 'ann@example.com', confidence: 'review', reasons: ['email'], clientIdText: '' },
    ]),
  ];
  try {
    const m = await portal.findClientMatches({ email: 'ann@example.com' });
    assert.deepEqual(m.clients, [
      { clientId: 'CL-2026-00042', name: 'Ann Example', email: 'ann@example.com', confidence: 'exact', reasons: ['email'] },
      { clientId: '', name: 'Ann E', email: 'ann@example.com', confidence: 'review', reasons: ['email'] },
    ]);
    assert.ok(!JSON.stringify(m).includes('1842502'), 'no Monday item id of the client account');
  } finally { rs.reverse().forEach((r) => r()); }
});

test('the Retainers duplicate panel: "Client CL-… · Name" when the person has an ID, "Client account: Name" when not; escaped', () => {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();
  const js = scriptsOf(html)[0];
  const fn = js.slice(js.indexOf('function dcRenderMatches(m){'), js.indexOf('/* ── "New application" prefill'));
  const els = { 'dc-matches': { style: {}, innerHTML: '' }, 'dc-profile': { style: {}, innerHTML: '' } };
  const render = new Function('dcEl', 'escHtml', `var DC_MATCHES=null, DC_CONVERT_LEAD_ID=null; ${fn}; return dcRenderMatches;`)((id) => els[id], (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  render({ leads: [], cases: [], clients: [{ clientId: 'CL-2026-00042', name: 'Ann <i>', reasons: ['email'] }, { clientId: '', name: 'Bob', reasons: [] }] });
  const h = els['dc-matches'].innerHTML;
  assert.match(h, /<div class="dcm-info">Client CL-2026-00042 · Ann &lt;i> <span class="dcm-badge">email<\/span><\/div>/);
  assert.match(h, /<div class="dcm-info">Client account: Bob<\/div>/);
});

test('the Leads "Add lead" panel and the Direct consultation panel show the ID the same way (the code on the page)', () => {
  const leadsJs = scriptsOf(require('../src/routes/adminLeads').buildLeadsQueueHTML()).join('\n');
  const line = leadsJs.split('\n').find((l) => l.includes('(m.clients||[]).forEach'));
  const rows = [];
  new Function('m', 'rows', 'escHtml', line)({ clients: [{ clientId: 'CL-2026-00042', name: 'Ann' }, { name: 'Bob' }] }, rows, (s) => String(s));
  assert.deepEqual(rows, ['Client CL-2026-00042 · Ann', 'Client account: Bob']);
  const dq = require('../src/routes/directConsultUi').DQ_JS;
  const dline = dq.split('\n').find((l) => l.includes('((m&&m.clients)||[]).forEach'));
  const people = {};
  new Function('m', 'person', 'dqEsc', dline)({ clients: [{ clientId: 'CL-2026-00042', name: 'Ann', reasons: ['email'] }, { name: 'Bob', reasons: [] }] },
    (n) => (people[n] = people[n] || { lines: [] }), (s) => String(s));
  assert.deepEqual(people.Ann.lines, ['Client CL-2026-00042 (email)']);
  assert.deepEqual(people.Bob.lines, ['Client account']);
});

// ─── the Leads search ──────────────────────────────────────────────────────────

test('the Leads search: a typed Client ID is looked for FIRST, on the lead\'s Client ID copy — "CL 42" finds that person\'s leads, bare digits stay a phone search', async () => {
  const leadSearch = require('../src/services/leadSearch');
  const { buildIndexEntry } = require('../src/services/oldClientDirectory');
  const index = [
    buildIndexEntry({ id: 1, name: 'Ann Example', phone: '4165550042', email: 'ann@x.com', clientId: 'CL-2026-00042' }),
    buildIndexEntry({ id: 2, name: 'Ann Example', phone: '', email: 'ann2@x.com', clientId: 'CL-2026-00042' }),
    buildIndexEntry({ id: 3, name: 'Bob Roy', phone: '', email: 'bob@x.com', clientId: 'CL-2026-00420' }),
    buildIndexEntry({ id: 4, name: 'Cl Ford', phone: '6475550042', email: '', clientId: '' }),
  ];
  assert.deepEqual([index[0].clientN, index[0].clientYear, index[3].clientN, index[3].clientYear], [42, 2026, 0, 0]);
  const back = stub(leadSearch.io, 'contactIndex', async () => ({ index, stale: false }));
  try {
    assert.deepEqual(await leadSearch.search('CL 42'), { ok: true, mode: 'clientId', ids: ['1', '2'] });
    assert.deepEqual(await leadSearch.search('cl-2026-00042'), { ok: true, mode: 'clientId', ids: ['1', '2'] });
    assert.deepEqual(await leadSearch.search('CL 2025 42'), { ok: true, mode: 'clientId', ids: [] }, 'a typed year must match');
    assert.deepEqual(await leadSearch.search('CL420'), { ok: true, mode: 'clientId', ids: ['3'] });
    const phone = await leadSearch.search('0042');
    assert.equal(phone.mode, 'phone');
    assert.deepEqual(phone.ids, ['1', '4']);
    assert.equal((await leadSearch.search('cl ford')).mode, 'name');
  } finally { back(); }
});

test('the lead snapshot reads the Lead Board Client ID copy only once it is made, and keeps it server-side (never on a lead a page gets)', async () => {
  const snap = require('../src/services/leadSnapshot');
  const leadService = require('../src/services/leadService');
  const queries = [];
  const back = [
    stub(mondayApi, 'query', async (q) => { queries.push(q); return { boards: [{ items_page: { cursor: null, items: [{ id: '11', name: 'Ann', created_at: '2026-11-01T00:00:00Z', column_values: [{ id: LEAD_COL, text: 'CL-2026-00042', value: null }] }] } }] }; }),
    stub(leadService, 'parseItem', (it) => ({ id: it.id, fullName: it.name })),
  ];
  try {
    await withConfig(SHIPPED, async () => {
      const leads = await snap.io.fetchLeads();
      assert.ok(!queries[0].includes(LEAD_COL));
      assert.equal(leads[0][snap.CONTACT].clientId, '');
    });
    await withConfig(CONFIGURED, async () => {
      const leads = await snap.io.fetchLeads();
      assert.ok(queries[1].includes(`"${LEAD_COL}"`));
      assert.equal(leads[0][snap.CONTACT].clientId, 'CL-2026-00042');
      assert.ok(!JSON.stringify(leads).includes('CL-2026'), 'not on the lead a list sends');
      assert.ok(!Object.keys(leads[0]).includes('clientId'));
    });
  } finally { back.reverse().forEach((r) => r()); }
});

// ─── the client portal ─────────────────────────────────────────────────────────

test('the client portal: "Your client number: CL-…" near the case ref when the client has one; nothing when not; staff see "Client number"; escaped', () => {
  const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  const snap = (extra) => Object.assign({
    clientName: 'Ann Example', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null, caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 40, docCounts: { total: 0, received: 0, reviewed: 0, rework: 0, missing: 0 }, docItems: [], totalMembers: 1, submittedMembers: 0,
    journey: clientStage('Document Collection Started'), timeline: toClientTimeline([]), payments: null,
  }, extra || {});
  for (const id of [undefined, '']) {
    const html = buildPortalPage(snap({ clientId: id }), { mode: 'client' });
    assert.ok(!/client number|client-number|undefined/i.test(html.replace(/qUnavailable|undefined_/g, '')), 'a blank ID: no line, nothing made up');
  }
  const html = buildPortalPage(snap({ clientId: 'CL-2026-00042' }), { mode: 'client' });
  assert.match(html, /<div>📋 <strong>Case:<\/strong> 2026-SP-001<\/div>\s*<div class="client-number">🪪 <strong>Your client number:<\/strong> CL-2026-00042<\/div>/);
  assert.match(buildPortalPage(snap({ clientId: 'CL-2026-00042' }), { mode: 'staff', staffName: 'Staff' }), /<strong>Client number:<\/strong> CL-2026-00042/);
  assert.ok(!buildPortalPage(snap({ clientId: 'CL-2026-00042<script>' }), { mode: 'client' }).includes('CL-2026-00042<script>'));
});

test('the portal snapshot reads the Client ID copy with the same row once it is made; a non-ID cell is ""', async () => {
  const portal = require('../src/services/clientPortalService');
  const docSvc = require('../src/services/documentFormService');
  const htmlQ = require('../src/services/htmlQuestionnaireService');
  const cockpit = require('../src/services/caseCockpitService');
  let cell = 'CL-2026-00042', q = '';
  const rs = [
    stub(mondayApi, 'query', async (gql) => { q = gql; return { items: [{ column_values: [{ id: 'color_mm0x8faa', text: 'Document Collection Started' }, { id: CM_COL, text: cell }] }] }; }),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [] })),
    stub(htmlQ, 'loadMembers', async () => []),
    stub(htmlQ, 'getMemberStatuses', async () => []),
    stub(cockpit, 'getLeadExtras', async () => ({ lead: null, payments: null })),
  ];
  const vc = { itemId: '1', clientName: 'Ann', caseType: 'Study Permit', caseSubType: null, accessToken: 'tok' };
  try {
    await withConfig(SHIPPED, async () => { const s = await portal.getPortalSnapshot({ caseRef: '2026-SP-001', validatedCase: vc }); assert.equal(s.clientId, ''); assert.ok(!q.includes(CM_COL)); });
    await withConfig(CONFIGURED, async () => {
      assert.equal((await portal.getPortalSnapshot({ caseRef: '2026-SP-001', validatedCase: vc })).clientId, 'CL-2026-00042');
      assert.ok(q.includes(`"${CM_COL}"`));
      cell = '18425020416';
      assert.equal((await portal.getPortalSnapshot({ caseRef: '2026-SP-001', validatedCase: vc })).clientId, '');
    });
  } finally { rs.reverse().forEach((r) => r()); }
});

// ─── client emails ─────────────────────────────────────────────────────────────

test('idForMail: the case\'s Client Master copy first, else the lead\'s copy; nothing read while the columns are missing; a sponsor or test email never; a failed or slow read = ""; cached', async () => {
  const calls = [];
  const answers = { [`${CM_COL}:555`]: 'CL-2026-00042', [`${LEAD_COL}:77`]: 'CL-2026-00007', [`${CM_COL}:556`]: '' };
  const keep = { q: D.io.query, ms: D.io.readMs };
  D.io.query = async (gql, v) => {
    const col = gql.match(/column_values\(ids:\["([^"]+)"\]\)/)[1];
    calls.push(`${col}:${v.i[0]}`);
    if (v.i[0] === '999') throw new Error('Monday down');
    if (v.i[0] === '998') return new Promise(() => {});   // never answers
    return { items: [{ id: v.i[0], column_values: [{ id: col, text: answers[`${col}:${v.i[0]}`] || '' }] }] };
  };
  D.io.readMs = () => 20;
  try {
    await withConfig(SHIPPED, async () => {
      assert.equal(await D.idForMail({ caseItemId: '555', leadId: '77', kind: 'doc-reminder' }), '');
      assert.equal(calls.length, 0, 'no column: no read');
    });
    await withConfig(CONFIGURED, async () => {
      assert.equal(await D.idForMail({ caseItemId: '555', leadId: '77', kind: 'doc-reminder' }), 'CL-2026-00042');
      assert.equal(await D.idForMail({ caseItemId: '555', kind: 'receipt' }), 'CL-2026-00042');
      assert.deepEqual(calls, [`${CM_COL}:555`], 'cached');
      assert.equal(await D.idForMail({ caseItemId: '556', leadId: '77', kind: 'receipt' }), 'CL-2026-00007', 'the case has none: the lead\'s');
      assert.equal(await D.idForMail({ leadId: '78', kind: 'booking-invite' }), '', 'a new lead has none yet');
      for (const kind of ['sponsor', 'test']) assert.equal(await D.idForMail({ caseItemId: '555', kind }), '', kind);
      assert.equal(await D.idForMail({ kind: 'consult-form' }), '', 'no record named: nothing');
      assert.equal(await D.idForMail(null), '');
      assert.equal(await D.idForMail({ caseItemId: '555; drop', kind: 'x' }), '', 'an id that is not one is not read');
      assert.equal(await D.idForMail({ caseItemId: '999', kind: 'x' }), '', 'a failed read');
      assert.equal(await D.idForMail({ caseItemId: '998', kind: 'x' }), '', 'a slow read');
      assert.equal(await D.idForMail({ caseItemId: '998', kind: 'x' }), '');
      assert.equal(calls.filter((c) => c === `${CM_COL}:998`).length, 2, 'a slow read is not kept as "no ID": the next email asks again');
      assert.equal(await D.idForMail({ clientId: 'CL-2026-00099', caseItemId: '555', kind: 'x' }), 'CL-2026-00099', 'a caller that knows it');
      assert.equal(await D.mailBody('<p>x</p>', { caseItemId: '999', kind: 'x' }), '<p>x</p>');
    });
  } finally { D.io.query = keep.q; D.io.readMs = keep.ms; }
});

async function sendWith({ cfg, tag, html, answer }) {
  const mail = require('../src/services/microsoftMailService');
  const keys = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_FROM_EMAIL', 'CLIENT_MAIL_FROM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_FROM_EMAIL: 'noreply@tdotimm.com' }); delete process.env.CLIENT_MAIL_FROM;
  const sent = [], reads = [];
  const keepPost = axios.post, keepQ = D.io.query;
  axios.post = async (url, body) => {
    if (/oauth2\/v2\.0\/token/.test(url)) return { data: { access_token: 'tok', expires_in: 3600 } };
    sent.push(JSON.parse(JSON.stringify(body))); return { status: 202, data: '' };
  };
  D.io.query = async (gql, v) => { reads.push(v); return { items: [{ column_values: [{ id: CM_COL, text: answer }] }] }; };
  mail.invalidateAccessToken(); mail._reset();
  try {
    await withConfig(cfg, () => mail.sendEmail({ to: 'ann@example.com', subject: 'Documents still needed — 2026-SPE-016 · Internal Review', html, ...(tag ? { tag } : {}) }));
    return { message: sent[0].message, reads };
  } finally {
    axios.post = keepPost; D.io.query = keepQ; mail.invalidateAccessToken(); mail._reset();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('sendEmail: a CLIENT email (tagged) carries "Your client number: CL-…" in the BODY, never the subject; untagged staff alerts, no ID, or no column = the body exactly as given', async () => {
  const html = '<html><body><p>Hello Ann</p></body></html>';
  const SUBJECT = 'Documents still needed — 2026-SPE-016 · Internal Review';
  const tag = { caseRef: '2026-SPE-016', caseItemId: '555', kind: 'doc-reminder' };
  const on = await sendWith({ cfg: CONFIGURED, tag, html, answer: 'CL-2026-00042' });
  assert.equal(on.message.subject, SUBJECT, 'the subject is untouched (the app reads "— ref · stage" back)');
  assert.equal(on.message.body.content, '<html><body><p>Hello Ann</p>' + D.mailLineHtml('CL-2026-00042') + '</body></html>');
  assert.equal(on.reads.length, 1);
  const none = await sendWith({ cfg: CONFIGURED, tag, html, answer: '' });
  assert.equal(none.message.body.content, html);
  const staff = await sendWith({ cfg: CONFIGURED, tag: null, html, answer: 'CL-2026-00042' });
  assert.equal(staff.message.body.content, html);
  assert.equal(staff.reads.length, 0, 'a staff alert reads nothing');
  const shipped = await sendWith({ cfg: SHIPPED, tag, html, answer: 'CL-2026-00042' });
  assert.equal(shipped.message.body.content, html);
  assert.equal(shipped.reads.length, 0, 'no column: nothing read');
  const sponsor = await sendWith({ cfg: CONFIGURED, tag: { caseItemId: '555', kind: 'sponsor' }, html, answer: 'CL-2026-00042' });
  assert.equal(sponsor.message.body.content, html, 'the sponsor is not the client: never their number');
});

test('never in a subject, a folder name, an Otter code, Square or a payment reference: the display code is used by none of them', () => {
  const fs = require('fs');
  for (const f of ['../src/utils/clientSubject.js', '../src/utils/mailTag.js', '../src/services/oneDriveService.js', '../src/utils/recordingCode.js', '../src/services/squareBookingsService.js', '../src/services/squareInvoicesService.js', '../src/services/paymentService.js']) {
    assert.ok(!/clientIdDisplay|clientNumberLine|mailLineHtml/.test(fs.readFileSync(require.resolve(f), 'utf8')), f);
  }
  const src = fs.readFileSync(require.resolve('../src/services/microsoftMailService.js'), 'utf8');
  assert.match(src, /const content = \(tag && typeof tag === 'object'\) \? await require\('\.\/clientIdDisplay'\)\.mailBody\(html, tag\) : html;/);
  assert.match(src, /subject,\n\s*body:\s*\{ contentType: 'HTML', content \},/);
});
