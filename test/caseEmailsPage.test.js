// The case page's Emails tab (Stage 2a, Faran 2026-11-19) — on the page: switch off = the page byte-for-byte as
// before; on / admins = the tab after Updates, its panel inside the main column (also beside the notes panel,
// critique #18), the mount; the widget's script rules; and the widget itself in a small fake page (loads on the
// first click, removes its tab when the route says admins-only, a failed source is never "No emails yet", Junk
// folded, links only http/https/mailto). Every name and address here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { buildCockpitHTML } = require('../src/routes/adminCase');
const W = require('../src/routes/caseEmailsWidget');

function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
}
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* ══ the page ═════════════════════════════════════════════════════════════════ */

test('switch off (unset / "off" / anything but on|admins): the case page is byte-for-byte as before — no tab, no panel, no CSS, no script', () => {
  for (const notes of [false, true]) {
    for (const v of [null, 'off', '', 'yes', '1']) {
      withEnv({ CASE_EMAILS_TAB: v }, () => {
        const html = buildCockpitHTML('2026-XX-000', { notesPanel: notes });
        assert.equal(html, buildCockpitHTML('2026-XX-000', { notesPanel: notes, emailsTab: 'off' }));
        for (const s of ['cem-', 'case-emails', 'tdotCaseEmailsMount', 'panel-emails', 'tab-emails', 'Emails with this client']) assert.ok(!html.includes(s), `${v}: ${s}`);
      });
    }
  }
  // an unknown value passed in is off too
  assert.equal(buildCockpitHTML('2026-XX-000', { notesPanel: false, emailsTab: 'everyone' }), buildCockpitHTML('2026-XX-000', { notesPanel: false, emailsTab: 'off' }));
});

test('switch on: the tab right after Updates; the panel after the Updates panel, INSIDE the main column when the notes panel is on; the mount after the helpers it uses', () => {
  for (const notes of [false, true]) {
    const html = buildCockpitHTML('2026-XX-000', { notesPanel: notes, emailsTab: 'on' });
    assert.ok(html.includes('<button class="tab" data-tab="updates">Updates</button>\n      <button class="tab" data-tab="emails" id="tab-emails">Emails</button>\n    </div>'));
    const pu = html.indexOf('id="panel-updates"'), pe = html.indexOf('<div class="tab-panel" id="panel-emails">');
    assert.ok(pu > 0 && pe > pu);
    if (notes) {
      const mainEnd = html.indexOf('</div><!-- /case-main -->'), aside = html.indexOf('<aside class="cnp" id="cnp"');
      assert.ok(pe < mainEnd && mainEnd < aside, 'inside the main column, before the notes panel (critique #18)');
    }
    assert.equal((html.match(/id="panel-emails"/g) || []).length, 1);
    assert.ok(html.includes(W.FIXED_NOTE));
    assert.ok(html.includes('/* the Emails tab (caseEmailsWidget.js) */'));
    const mount = html.indexOf('tdotCaseEmailsMount({ caseRef: CASE_REF, adminsOnly: false });');
    assert.ok(mount > 0);
    assert.ok(html.indexOf('function peekKey') < mount && html.indexOf('function tdotDialogNew') < mount, 'after the shared helpers (the pop-up)');
    // the page's own tab switching is untouched: the widget adds its own listener
    assert.ok(html.includes("document.getElementById('tabbar').addEventListener('click', function(e) {\n  var btn = e.target.closest('.tab');"));
  }
  assert.ok(buildCockpitHTML('2026-XX-000', { notesPanel: false, emailsTab: 'admins' }).includes('tdotCaseEmailsMount({ caseRef: CASE_REF, adminsOnly: true });'));
  assert.ok(withEnv({ CASE_EMAILS_TAB: 'on' }, () => buildCockpitHTML('2026-XX-000', { notesPanel: false })).includes('id="panel-emails"'), 'the switch is read when the page is built');
});

test('on / admins: every emitted <script> parses, a hostile case ref stays inert; the widget is never redrawn by render() / loadCase()', () => {
  for (const mode of ['on', 'admins']) for (const notes of [false, true]) for (const ref of ['2026-XX-000', '</script><img src=x onerror=alert(1)>']) {
    const html = buildCockpitHTML(ref, { notesPanel: notes, emailsTab: mode });
    const scripts = scriptsOf(html);
    assert.equal(scripts.length, 1);
    for (const s of scripts) new vm.Script(s);
    assert.ok(!html.includes('<img src=x'));
  }
  const page = require('node:fs').readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  const renderFn = page.slice(page.indexOf('function render(d) {'), page.indexOf('var LAST_D = null;'));
  const loadFn = page.slice(page.indexOf('function loadCase() {'), page.indexOf('// Tab switching'));
  assert.ok(!/cem-|CaseEmails/.test(renderFn) && !/cem-|CaseEmails/.test(loadFn));
});

test('widget script rules: no backtick, no backslash, no dollar-brace, no innerHTML, no </script>; links only http/https/mailto; downloads by fetch + blob, never a ?key= link', () => {
  const js = W.CASE_EMAILS_JS;
  assert.ok(!js.includes('`')); assert.ok(!js.includes('\\')); assert.ok(!js.includes('${'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
  assert.ok(!/<\/script/i.test(js));
  assert.ok(!/key=/.test(js) && !/X-Api-Key/i.test(js), 'the cookie only — the shared key is never sent');
  assert.ok(js.includes('/^(https?:|mailto:)/i.test(sg.u)'));
  assert.ok(js.includes('a.rel = "noopener noreferrer"'));
  assert.ok(js.includes('URL.createObjectURL(b)'));
  new vm.Script(js);
  assert.ok(!/<script|on\w+=/.test(W.caseEmailsHtml()), 'the static markup carries no script');
});

/* ══ the widget in a small fake page ══════════════════════════════════════════ */

function fakeDom() {
  const byId = {};
  function el(tag) {
    const l = {};
    const e = {
      tagName: String(tag || 'div').toUpperCase(), id: '', className: '', hidden: false, disabled: false, type: '', href: '', target: '', rel: '', title: '', download: '', tabIndex: -1,
      childNodes: [], parentNode: null, attrs: {}, onclick: null, onkeydown: null, style: {}, _text: '', isText: false,
      get textContent() { return this.isText ? this._text : (this.childNodes.length ? this.childNodes.map((c) => c.textContent).join('') : this._text); },
      set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._text = String(v); },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); if (c.id) byId[c.id] = c; return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? this.childNodes.indexOf(ref) : -1; c.parentNode = this; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; },
      removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; if (c.id && byId[c.id] === c) delete byId[c.id]; return c; },
      replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) { this.childNodes[i] = n; n.parentNode = this; o.parentNode = null; } return o; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(t, f) { (l[t] = l[t] || []).push(f); },
      click() { const ev = { target: this }; (l.click || []).forEach((f) => f(ev)); if (this.onclick) this.onclick(ev); let p = this.parentNode; while (p) { (p._l.click || []).forEach((f) => f(ev)); p = p.parentNode; } },
      closest(sel) { const cls = sel.replace(/^\./, ''); let n = this; while (n) { if ((' ' + n.className + ' ').includes(' ' + cls + ' ')) return n; n = n.parentNode; } return null; },
      all() { const out = []; const walk = (n) => n.childNodes.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; },
      querySelector(sel) { const cls = sel.replace(/^\./, ''); return this.all().find((n) => (' ' + n.className + ' ').includes(' ' + cls + ' ')) || null; },
      _l: l,
    };
    e.classList = {
      contains: (c) => (' ' + e.className + ' ').includes(' ' + c + ' '),
      add: (c) => { if (!e.classList.contains(c)) e.className = (e.className + ' ' + c).trim(); },
      remove: (c) => { e.className = (' ' + e.className + ' ').replace(' ' + c + ' ', ' ').trim(); },
      toggle: (c, on) => { const want = on === undefined ? !e.classList.contains(c) : !!on; if (want) e.classList.add(c); else e.classList.remove(c); return want; },
    };
    return e;
  }
  const body = el('body');
  const bar = el('div'); bar.id = 'tabbar'; byId.tabbar = bar; body.appendChild(bar);
  const ov = el('button'); ov.className = 'tab active'; ov.attrs['data-tab'] = 'overview'; bar.appendChild(ov);
  const tab = el('button'); tab.className = 'tab'; tab.id = 'tab-emails'; bar.appendChild(tab);
  const panel = el('div'); panel.id = 'panel-emails'; panel.className = 'tab-panel'; body.appendChild(panel);
  for (const id of ['cem-cnt', 'cem-refresh', 'cem-status', 'cem-keys', 'cem-banners', 'cem-list', 'cem-foot']) { const x = el('div'); x.id = id; panel.appendChild(x); }
  const document = { getElementById: (id) => byId[id] || null, createElement: el, createTextNode: (t) => { const n = el('#text'); n.isText = true; n._text = String(t); return n; }, body };
  return { document, byId, body, tab, panel, bar, ov };
}

const LIST = (o = {}) => ({ ok: true, caseRef: '2026-EE-900', loadedAt: '2026-11-20T15:00:00Z', complete: true,
  sources: { office: { name: 'Office mailbox', ok: true, failed: [] }, old: { name: 'old no-reply inbox', ok: true, failed: [] } },
  keys: { addresses: [{ address: 'asha.sample@example.org', sharedWith: ['2026-EE-901'], checkFailed: false }], leadCount: 1, banners: [] },
  counts: { shown: 2, otherRecords: 1, unverified: 0 },
  items: [
    { source: 'office', id: 'c1', direction: 'client', folder: 'inbox', folderLabel: 'Inbox', junk: false, deleted: false, when: '2026-11-20T14:00:00Z', from: { name: 'Asha Sample', address: 'asha.sample@example.org' }, to: ['info@tdotimm.com'], subject: 'Re: Documents — 2026-EE-900', preview: '<b>not markup</b>', hasAttachments: true, how: 'ref', kind: '', warnings: [], sharedRisk: false, webLink: 'https://outlook.office365.com/owa/?ItemID=c1' },
    { source: 'office', id: 'j1', direction: 'client', folder: 'junkemail', folderLabel: 'Junk', junk: true, deleted: false, when: '2026-11-19T14:00:00Z', from: { name: '', address: 'asha.sample@example.org' }, to: ['info@tdotimm.com'], subject: 'JUNK SUBJECT', preview: 'junk text', hasAttachments: false, how: 'address', kind: '', warnings: [], sharedRisk: false, webLink: '' },
    { source: 'office', id: 'r1', direction: 'client', folder: 'inbox', folderLabel: 'Inbox', junk: false, deleted: false, when: '2026-11-18T14:00:00Z', from: { name: '', address: '' }, to: [], subject: 'Restricted one', preview: '', hasAttachments: false, how: 'address', kind: '', warnings: ['⚠ This address is also on 2026-EE-901 — this email may belong there.'], sharedRisk: true, restricted: true, webLink: '' },
  ], ...o });

function widget({ adminsOnly = false, answers = {} } = {}) {
  const d = fakeDom(); const gets = []; const dialogs = [];
  const answer = (url) => { for (const [k, v] of Object.entries(answers)) if (url.includes(k)) return typeof v === 'function' ? v(url) : v; return { s: 200, j: LIST() }; };
  const ctx = {
    document: d.document, window: {}, Date, JSON, Number, String, Math, isNaN, setTimeout, clearTimeout, encodeURIComponent, Array,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    fetch: (url, o) => { gets.push({ url, o }); const a = answer(url); return Promise.resolve({ status: a.s, ok: a.s >= 200 && a.s < 300, json: () => Promise.resolve(a.j), blob: () => Promise.resolve({}) }); },
    tdotDialogNew: (o) => { const box = d.document.createElement('div'); const c = { o, box, openId: 1, closed: false, still: () => !c.closed, tryClose: () => { c.closed = true; } }; dialogs.push(c); return c; },
  };
  vm.createContext(ctx);
  vm.runInContext(W.CASE_EMAILS_JS + '\ntdotCaseEmailsMount({ caseRef: "2026-EE-900", adminsOnly: ' + adminsOnly + ' });', ctx);
  return { d, gets, dialogs, ctx, text: () => d.byId['cem-list'].textContent };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('widget: nothing is read until the tab is clicked; the first click loads (cookie only, no-store); a second click does not read again', async () => {
  const w = widget(); await tick();
  assert.equal(w.gets.length, 0, 'not on page load');
  w.d.ov.click(); await tick();
  assert.equal(w.gets.length, 0, 'another tab does not load it');
  w.d.tab.click(); await tick();
  assert.equal(w.gets.length, 1);
  assert.equal(w.gets[0].url, '/admin/case-emails/2026-EE-900');
  assert.deepEqual(JSON.parse(JSON.stringify(w.gets[0].o)), { credentials: 'same-origin', cache: 'no-store' });
  w.d.tab.click(); await tick();
  assert.equal(w.gets.length, 1);
  const t = w.text();
  assert.ok(t.includes('← Client') && t.includes('Asha Sample <asha.sample@example.org>') && t.includes('<b>not markup</b>') && t.includes('by case number'));
  assert.ok(w.d.byId['cem-status'].textContent.includes('Office mailbox ✓') && w.d.byId['cem-status'].textContent.includes('old no-reply inbox ✓'));
  assert.ok(w.d.byId['cem-keys'].textContent.includes('Matched by case number 2026-EE-900, or asha.sample@example.org ⚠ also on 2026-EE-901'));
  assert.ok(w.d.byId['cem-foot'].textContent.includes('1 email to these addresses belong to other records'));
  assert.equal(w.d.byId['cem-refresh'].disabled, true, 'Refresh waits 15 s');
});

test('widget: Junk is folded (its subject hidden until Show); a restricted row shows subject + date only and cannot be opened', async () => {
  const w = widget(); w.d.tab.click(); await tick();
  assert.ok(!w.text().includes('JUNK SUBJECT'), 'folded');
  const rows = w.d.byId['cem-list'].childNodes;
  const fold = rows[1];
  const show = fold.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Show');
  show.onclick({ stopPropagation() {} });
  assert.ok(w.text().includes('JUNK SUBJECT'), 'shown after Show');
  const restricted = w.d.byId['cem-list'].childNodes[2];
  assert.equal(restricted.onclick, null);
  assert.ok(restricted.textContent.includes('only the subject and date are shown here'));
});

test('widget: a failed source → ✗, a Retry and "may be incomplete" — never "No emails yet"; "No emails yet." only when every source answered', async () => {
  let w = widget({ answers: { 'case-emails/2026-EE-900': { s: 200, j: LIST({ complete: false, items: [], sources: { office: { ok: false, failed: [{ part: 'office mail search', hint: 'Microsoft is busy — try again in 30 s.' }] }, old: { ok: true } } }) } } });
  w.d.tab.click(); await tick();
  assert.ok(!w.text().includes('No emails yet'));
  assert.ok(w.text().includes('No emails found so far — part of the mailboxes could not be read'));
  assert.ok(w.d.byId['cem-status'].textContent.includes('Office mailbox ✗'));
  const banner = w.d.byId['cem-banners'].textContent;
  assert.ok(banner.includes('Office mailbox could not be fully read: office mail search — Microsoft is busy — try again in 30 s.') && banner.includes('Retry'));
  w = widget({ answers: { 'case-emails/2026-EE-900': { s: 200, j: LIST({ items: [], counts: {} }) } } });
  w.d.tab.click(); await tick();
  assert.equal(w.text(), 'No emails yet.');
});

test('widget: 401 → the Monday sign-in link (only a /q/auth/monday address); 403 not assigned → said; admins mode: the probe at load, 403 admins-only → the tab and panel are removed', async () => {
  let w = widget({ answers: { 'case-emails/': { s: 401, j: { error: 'Sign in with Monday to see emails.', loginUrl: 'https://evil.example/x' } } } });
  w.d.tab.click(); await tick();
  const a = w.d.byId['cem-list'].all().find((n) => n.tagName === 'A');
  assert.equal(a.href, '/q/auth/monday');
  w = widget({ answers: { 'case-emails/': { s: 403, j: { reason: 'not-assigned', error: 'You are not assigned to this case.' } } } });
  w.d.tab.click(); await tick();
  assert.ok(w.text().includes('You are not assigned to this case.'));
  w = widget({ adminsOnly: true, answers: { '?probe=1': { s: 403, j: { reason: 'admins-only' } } } }); await tick();
  assert.equal(w.gets[0].url, '/admin/case-emails/2026-EE-900?probe=1');
  assert.equal(w.d.document.getElementById('tab-emails'), null); assert.equal(w.d.panel.parentNode, null);
  w = widget({ adminsOnly: true, answers: { '?probe=1': { s: 200, j: { ok: true } } } }); await tick();
  assert.ok(w.d.tab.parentNode, 'an admin keeps the tab');
  w = widget({ adminsOnly: false }); await tick();
  assert.equal(w.gets.length, 0, '"on" never probes');
});

test('widget: one email in the shared pop-up — its text as text nodes, only http/https/mailto as links (new tab, no referrer), the attachments with Download or the reason, Open in Outlook', async () => {
  const open = { s: 200, j: { ok: true, item: { ...LIST().items[0] }, from: { name: 'Asha Sample', address: 'asha.sample@example.org' }, toPeople: [{ name: '', address: 'info@tdotimm.com' }], ccPeople: [], replyToPeople: [],
    unique: [{ t: 'See ' }, { u: 'https://www.canada.ca/a' }, { t: ' and ' }, { u: 'javascript:alert(1)' }, { t: ' <img src=x>' }], whole: [{ t: 'whole thread' }],
    attachments: [{ id: 'AT-1', name: 'passport.pdf', size: 1258291, kind: 'file', downloadable: true, note: '' }, { id: 'AT-2', name: 'form.html', size: 10, kind: 'file', downloadable: false, note: 'This file type can\'t be downloaded here — open it in Outlook.' }], inlineImages: 1 } };
  const w = widget({ answers: { '/message?': open } });
  w.d.tab.click(); await tick();
  w.d.byId['cem-list'].childNodes[0].onclick(); await tick();
  assert.equal(w.dialogs.length, 1);
  assert.equal(w.gets.at(-1).url, '/admin/case-emails/2026-EE-900/message?source=office&id=c1');
  const box = w.dialogs[0].box;
  const links = box.all().filter((n) => n.tagName === 'A');
  assert.deepEqual(links.map((l) => [l.href, l.target, l.rel]), [['https://www.canada.ca/a', '_blank', 'noopener noreferrer'], ['https://outlook.office365.com/owa/?ItemID=c1', '_blank', 'noopener noreferrer']]);
  const t = box.textContent;
  assert.ok(t.includes('javascript:alert(1)') && t.includes(' <img src=x>'), 'shown as text, never a link or markup');
  assert.ok(t.includes('passport.pdf') && t.includes('1.2 MB') && t.includes('open it in Outlook') && t.includes('1 picture(s) inside the email are not shown here.'));
  const more = box.all().find((n) => n.tagName === 'BUTTON' && /whole email/.test(n.textContent));
  more.onclick(); assert.ok(box.textContent.includes('whole thread'));
  const dl = box.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Download');
  dl.onclick(); await tick();
  assert.equal(w.gets.at(-1).url, '/admin/case-emails/2026-EE-900/attachment?source=office&id=c1&att=AT-1');
  assert.deepEqual(JSON.parse(JSON.stringify(w.gets.at(-1).o)), { credentials: 'same-origin', cache: 'no-store' });
});

test('the staff guide: one how-to for the Emails tab — Monday sign-in, read-only, what is not shown, not switched on yet', () => {
  const g = JSON.parse(require('node:fs').readFileSync(require.resolve('../src/staffGuide/guide-data.json'), 'utf8'));
  const h = g.howto.filter((x) => /emails with a client on the case page/i.test(x.q));
  assert.equal(h.length, 1);
  assert.equal(h[0].lane, 'case');
  for (const re of [/Sign in with Monday/, /read-only/, /Copies of app emails start 19 Nov 2026/, /old no-reply address/, /Not switched on yet\.$/]) assert.match(h[0].answer, re);
});

/* ══ review fixes (2026-11-19) ════════════════════════════════════════════════ */

test('phones: a row never grows wider than the screen — the one-column track has a 0 minimum and the text column may shrink (the nowrap preview no longer widens the page)', () => {
  const css = W.CASE_EMAILS_CSS;
  const mobile = css.match(/@media \(max-width: 600px\) \{(.*)\}/)[1];
  assert.match(mobile, /\.cem-row \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.ok(!/grid-template-columns:1fr\b/.test(css), 'no bare 1fr track (its minimum is the min-content width)');
  assert.match(css, /\.cem-main \{ min-width:0; \}/);
});

test('widget: a 503 on opening an email / downloading an attachment shows the plain words, never the code "temporarily-unavailable"; other refusals keep their words', async () => {
  const BUSY = 'Could not read the emails just now — retry in a moment.';
  const busy = { s: 503, j: { ok: false, error: 'temporarily-unavailable', message: BUSY } };
  let w = widget({ answers: { '/message?': busy } });
  w.d.tab.click(); await tick();
  w.d.byId['cem-list'].childNodes[0].onclick(); await tick();
  let t = w.dialogs[0].box.textContent;
  assert.ok(t.includes(BUSY) && !t.includes('temporarily-unavailable'), t);
  w = widget({ answers: { '/message?': { s: 404, j: { ok: false, error: 'This email is not on this case any more (it may have been moved or deleted). Reload the list.' } } } });
  w.d.tab.click(); await tick();
  w.d.byId['cem-list'].childNodes[0].onclick(); await tick();
  assert.ok(w.dialogs[0].box.textContent.includes('This email is not on this case any more'));
  // the download: open fine, the attachment answers 503 / 415
  const open = { s: 200, j: { ok: true, item: { ...LIST().items[0] }, from: { name: '', address: 'asha.sample@example.org' }, toPeople: [], ccPeople: [], replyToPeople: [], unique: [{ t: 'x' }], whole: null,
    attachments: [{ id: 'AT-1', name: 'passport.pdf', size: 10, kind: 'file', downloadable: true, note: '' }], inlineImages: 0 } };
  for (const [ans, want] of [[busy, BUSY], [{ s: 415, j: { ok: false, error: 'This file type can\'t be downloaded here — open it in Outlook.' } }, 'This file type can\'t be downloaded here']]) {
    w = widget({ answers: { '/message?': open, '/attachment?': ans } });
    w.d.tab.click(); await tick();
    w.d.byId['cem-list'].childNodes[0].onclick(); await tick();
    const box = w.dialogs[0].box;
    box.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Download').onclick(); await tick();
    t = box.textContent;
    assert.ok(t.includes(want) && !t.includes('temporarily-unavailable'), t);
  }
});

test('widget: a list cut short with every mailbox answering (a cap / the consultations not all read) — "not everything could be checked", never "No emails yet."; staffHidden → its own banner', async () => {
  const w = widget({ answers: { 'case-emails/2026-EE-900': { s: 200, j: LIST({ complete: false, staffHidden: true, items: [], counts: { unverified: 1 }, sources: { office: { ok: true, failed: [], cappedApp: true }, old: { ok: true, failed: [] } } }) } } });
  w.d.tab.click(); await tick();
  assert.equal(w.text(), 'No emails found so far — not everything could be checked (see above).');
  const b = w.d.byId['cem-banners'].textContent;
  assert.ok(b.includes('Too many app emails to this address to check them all, so answers sent from the office mailbox are not shown — open Outlook for them.'), b);
  assert.ok(b.includes('Some older app emails are not shown'));
  assert.ok(w.d.byId['cem-foot'].textContent.includes('1 email could not be checked against this case'));
  const plain = widget({ answers: { 'case-emails/2026-EE-900': { s: 200, j: LIST({ staffHidden: false }) } } });
  plain.d.tab.click(); await tick();
  assert.ok(!plain.d.byId['cem-banners'].textContent.includes('Too many app emails'));
});
