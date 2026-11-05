// The one pop-up (team meeting point 3, Faran 2026-11-05): every pop-up looks and behaves the same.
// The browser code runs here against a small fake DOM — the rules are tested, not just the wording.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { DIALOG_UI_JS, DIALOG_UI_CSS, GRACE_MS } = require('../src/routes/dialogUi');

/* ── a fake DOM, just enough for the pop-up core ── */
function fakeDom() {
  const listeners = new Map();
  function on(node, type, fn) { const k = node._id + ':' + type; if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(fn); }
  let ids = 0;
  const doc = {
    _id: 'doc', activeElement: null, documentElement: null, body: null,
    addEventListener(type, fn) { on(doc, type, fn); },
    createElement(tag) { return el(tag); },
  };
  function el(tag, cls) {
    const n = {
      _id: 'n' + (++ids), tagName: String(tag).toUpperCase(), children: [], parentNode: null, hidden: false, disabled: false,
      style: {}, attrs: {}, textContent: '', innerHTML: '', className: cls || '', type: '',
      get firstChild() { return n.children[0] || null; },
      get firstElementChild() { return n.children[0] || null; },
      classList: {
        contains: (c) => n.className.split(' ').includes(c),
        toggle: (c, on2) => { const s = new Set(n.className.split(' ').filter(Boolean)); if (on2) s.add(c); else s.delete(c); n.className = [...s].join(' '); },
      },
      setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
      hasAttribute(k) { return k in n.attrs; }, removeAttribute(k) { delete n.attrs[k]; },
      appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
      insertBefore(c, ref) { c.parentNode = n; const i = ref ? n.children.indexOf(ref) : -1; if (i < 0) n.children.push(c); else n.children.splice(i, 0, c); return c; },
      removeChild(c) { n.children.splice(n.children.indexOf(c), 1); c.parentNode = null; return c; },
      contains(x) { for (let p = x; p; p = p.parentNode) if (p === n) return true; return false; },
      all() { const out = []; (function walk(m) { for (const k of m.children) { out.push(k); walk(k); } })(n); return out; },
      querySelector(sel) { return n.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        if (sel.startsWith('.')) return n.all().filter((k) => k.classList.contains(sel.slice(1)));
        if (sel === '[data-x]') return n.all().filter((k) => 'data-x' in k.attrs);
        return n.all().filter((k) => k.focusable && !k.disabled);   // the focusable list
      },
      addEventListener(type, fn) { on(n, type, fn); },
      focus() { doc.activeElement = n; }, click() { fire(n, 'click', {}); },
      offsetWidth: 10, offsetHeight: 10, getClientRects() { return [1]; },
    };
    return n;
  }
  function fire(target, type, extra) {
    const e = Object.assign({ type, target, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } }, extra);
    for (let p = target; p; p = p.parentNode) for (const fn of (listeners.get(p._id + ':' + type) || [])) fn(e);
    if (target !== doc) for (const fn of (listeners.get('doc:' + type) || [])) fn(e);
    return e;
  }
  doc.documentElement = el('html'); doc.body = el('body'); doc.documentElement.appendChild(doc.body);
  doc.body.parentNode = doc.documentElement;
  return { doc, el, fire };
}

/* a page with one pop-up written in it (the add forms) and an opener button */
function world() {
  const { doc, el, fire } = fakeDom();
  const timers = [];
  const sandbox = { document: doc, window: {}, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].f = null; } };
  vm.createContext(sandbox);
  vm.runInContext(DIALOG_UI_JS, sandbox);
  const opener = doc.body.appendChild(el('button')); opener.focusable = true;
  const ov = doc.body.appendChild(el('div', 'tdlg-ov')); ov.hidden = true;
  const frame = ov.appendChild(el('div', 'tdlg'));
  const body = frame.appendChild(el('div', 'tdlg-body'));
  const input = body.appendChild(el('input')); input.focusable = true;
  const acts = body.appendChild(el('div', 'tdlg-actions'));
  const cancel = acts.appendChild(el('button')); cancel.setAttribute('data-x', ''); cancel.focusable = true;
  const go = acts.appendChild(el('button')); go.focusable = true;
  const runTimers = (minMs) => { for (const t of timers) if (t.f && t.ms >= (minMs || 0)) { const f = t.f; t.f = null; f(); } };
  return { doc, fire, sandbox, opener, ov, frame, body, input, cancel, go, runTimers, T: sandbox.window.TDOT_DLG,
    make: (o) => sandbox.tdotDialog(ov, o || {}) };
}

test('the browser code follows the page-script rules: no backtick, no dollar-brace, no backslash; it parses', () => {
  for (const [name, s] of [['DIALOG_UI_JS', DIALOG_UI_JS], ['DIALOG_UI_CSS', DIALOG_UI_CSS]]) {
    assert.ok(!s.includes('`'), name + ': no backtick');
    assert.ok(!s.includes('${'), name + ': no dollar-brace');
    assert.ok(!s.includes(String.fromCharCode(92)), name + ': no backslash');
  }
  new vm.Script(DIALOG_UI_JS);
  assert.equal(GRACE_MS, 45000);
  assert.match(DIALOG_UI_JS, /grace: 45000/);
});

test('open: on the stack, the page behind locked, focus moved into the pop-up; close: focus back to what opened it', () => {
  const w = world(); const c = w.make();
  w.opener.focus(); c.open();
  assert.equal(w.ov.hidden, false);
  assert.equal(w.T.stack.length, 1);
  assert.ok(w.doc.documentElement.classList.contains('tdlg-lock'));
  assert.equal(w.doc.activeElement, w.frame, 'focus leaves the button at once (Enter twice cannot open two)');
  assert.equal(w.frame.getAttribute('role'), 'dialog'); assert.equal(w.frame.getAttribute('aria-modal'), 'true');
  assert.ok(w.frame.querySelector('.tdlg-x'), 'a × is added when the page has none');
  assert.equal(c.close(), true);
  assert.equal(w.ov.hidden, true);
  assert.equal(w.T.stack.length, 0);
  assert.ok(!w.doc.documentElement.classList.contains('tdlg-lock'));
  assert.equal(w.doc.activeElement, w.opener);
});

test('outside click (Faran 2026-11-05): closes an untouched pop-up; never one with something typed or chosen; never a drag that started inside', () => {
  const w = world(); const c = w.make();
  c.open();
  w.fire(w.input, 'pointerdown', {}); w.fire(w.ov, 'click', {});
  assert.ok(c.isOpen(), 'press inside, release outside: stays open');
  w.fire(w.ov, 'pointerdown', {}); w.fire(w.ov, 'click', {});
  assert.ok(!c.isOpen(), 'untouched: an outside click closes it');
  c.open();
  w.fire(w.input, 'input', {});
  w.fire(w.ov, 'pointerdown', {}); w.fire(w.ov, 'click', {});
  assert.ok(c.isOpen(), 'typed: an outside click is ignored');
  c.close(); c.open();
  assert.equal(c.dirty, false, 'every opening starts clean');
  w.fire(w.input, 'change', {});
  w.fire(w.ov, 'pointerdown', {}); w.fire(w.ov, 'click', {});
  assert.ok(c.isOpen(), 'a choice made: an outside click is ignored');
});

test('review 2026-11-05: the second click of the double-click that opened it never closes it; only html is locked (body stays, so the sticky top bar keeps its place)', () => {
  const w = world(); const c = w.make();
  c.open();
  w.fire(w.ov, 'pointerdown', {}); w.fire(w.ov, 'click', { detail: 2 });
  assert.ok(c.isOpen(), 'a double-click');
  w.fire(w.ov, 'pointerdown', {}); w.fire(w.ov, 'click', { detail: 1 });
  assert.ok(!c.isOpen(), 'a single click outside still closes an untouched pop-up');
  assert.ok(DIALOG_UI_CSS.includes('html.tdlg-lock { overflow:hidden; }') && !/tdlg-lock body/.test(DIALOG_UI_CSS));
  assert.ok(DIALOG_UI_JS.includes("window.addEventListener('pageshow'") && DIALOG_UI_JS.includes("d.setBusy(false); d.close(true, 'restore');"), 'Back to the page: no half-saving pop-up');
  assert.ok(DIALOG_UI_JS.includes("document.dispatchEvent(new CustomEvent('tdot-dialog-open'))"), 'an open list filter panel is told to close');
  const { listTableUi } = require('../src/routes/listFilters');
  assert.ok(listTableUi.toString().includes("doc.addEventListener('tdot-dialog-open', function () { close(false); });"));
  assert.ok(listTableUi.toString().includes('if (win.TDOT_DLG && win.TDOT_DLG.stack && win.TDOT_DLG.stack.length) return;'), 'Escape under a pop-up is the pop-up\'s');
});

test('Escape closes the top pop-up only — and not when something inside already used it (the client search list)', () => {
  const w = world(); const c = w.make();
  c.open();
  const used = w.fire(w.input, 'keydown', { key: 'Escape', defaultPrevented: true });
  assert.ok(used && c.isOpen(), 'Escape already used inside: the pop-up stays');
  w.fire(w.input, 'keydown', { key: 'Escape' });
  assert.ok(!c.isOpen());
  // a second pop-up on top: Escape closes only that one
  const ov2 = w.doc.body.appendChild(w.doc.createElement('div')); const f2 = ov2.appendChild(w.doc.createElement('div')); f2.className = 'tdlg';
  const c2 = w.sandbox.tdotDialog(ov2, { remove: true });
  c.open(); c2.open();
  w.fire(w.doc.body, 'keydown', { key: 'Escape' });
  assert.ok(c.isOpen() && !c2.isOpen(), 'the one underneath stays');
  assert.ok(!f2.parentNode || !w.doc.body.contains(ov2), 'a pop-up built on the fly is taken out of the page');
});

test('saving: nothing closes it (×, Cancel, Escape, outside, the page) — Cancel and × are off; after the grace time it can be closed and says why', () => {
  const w = world(); const c = w.make();
  c.open(); c.setBusy(true);
  assert.equal(w.cancel.disabled, true); assert.equal(w.frame.querySelector('.tdlg-x').disabled, true);
  w.fire(w.input, 'keydown', { key: 'Escape' });
  w.fire(w.ov, 'pointerdown', {}); w.fire(w.ov, 'click', {});
  assert.equal(c.tryClose('x'), false); assert.equal(c.close(), false);
  assert.ok(c.isOpen(), 'still open while saving');
  w.runTimers(GRACE_MS);   // the wait goes on too long
  assert.equal(c.slow, true);
  assert.equal(w.cancel.disabled, false); assert.equal(w.frame.querySelector('.tdlg-x').disabled, false);
  const note = w.body.querySelector('.tdlg-slow');
  assert.ok(note && /Still waiting for an answer/.test(note.textContent));
  assert.equal(w.body.children.indexOf(note), w.body.children.indexOf(w.body.querySelector('.tdlg-actions')) - 1, 'the note sits just above the buttons');
  let closedBusy = null;
  c.opts.onClosed = (how, wasBusy) => { closedBusy = [how, wasBusy]; };
  w.fire(w.input, 'keydown', { key: 'Escape' });
  assert.ok(!c.isOpen(), 'closable after the grace time');
  assert.deepEqual(closedBusy, ['escape', true], 'the page is told it closed while a request still ran');
  c.open();
  assert.ok(!w.body.querySelector('.tdlg-slow') && !c.busy && w.cancel.disabled === false, 'reopened: clean');
  c.setBusy(true); assert.equal(c.close(true), true, 'the page may force it');
});

test('a late answer knows it is late: still(id) is false once the pop-up was closed or reopened', () => {
  const w = world(); const c = w.make();
  c.open(); const run = c.openId;
  assert.equal(c.still(run), true);
  c.close();
  assert.equal(c.still(run), false, 'closed');
  c.open();
  assert.equal(c.still(run), false, 'reopened for someone else');
  assert.equal(c.still(c.openId), true);
});

test('one at a time per group (a double-click never stacks two payment dialogs)', () => {
  const w = world();
  const mk = () => { const ov = w.doc.body.appendChild(w.doc.createElement('div')); const f = ov.appendChild(w.doc.createElement('div')); f.className = 'tdlg'; return w.sandbox.tdotDialog(ov, { remove: true, group: 'paym' }); };
  const a = mk(), b = mk();
  a.open(); a.setBusy(true); b.open();
  assert.ok(!a.isOpen() && b.isOpen() && w.T.stack.length === 1);
});

test('Tab stays inside: from the last control to the first, Shift+Tab from the first to the last', () => {
  const w = world(); const c = w.make();
  c.open();
  const f = w.sandbox.tdotDlgFocusables(w.frame);
  f[f.length - 1].focus(); w.fire(f[f.length - 1], 'keydown', { key: 'Tab' });
  assert.equal(w.doc.activeElement, f[0]);
  f[0].focus(); w.fire(f[0], 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(w.doc.activeElement, f[f.length - 1]);
});

/* ── the pages ── */
function renderRoute(router, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
const pages = async () => {
  const al = require('../src/routes/adminLeads'), ac = require('../src/routes/adminConsultation'), ad = require('../src/routes/adminDashboard');
  return { leads: al.buildLeadsQueueHTML(), lead: al.buildLeadDetailHTML('7'), consultations: ac.buildQueueHTML(), consultation: ac.buildDetailHTML('555'),
    cases: await renderRoute(ad, '/'), summary: await renderRoute(ad, '/summary'), cockpit: require('../src/routes/adminCase').buildCockpitHTML('2026-TEST-001') };
};

test('every page with a pop-up carries the shared pop-up code and CSS, and every script on it parses', async () => {
  const all = await pages();
  assert.ok(Object.keys(all).length >= 5, Object.keys(all).join(','));
  for (const [name, html] of Object.entries(all)) {
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1], { filename: name });
    const uses = /payOverlay\(\)|blOverlay\(\)|tdotOpenDeleteModal\(|alDlg\(\)|dcDlg\(\)/.test(html);
    if (!uses) continue;
    assert.ok(html.includes('function tdotDialog(ov, opts){'), name + ': has the shared pop-up code');
    assert.ok(html.includes('.tdlg-ov {'), name + ': has the shared pop-up CSS');
  }
});

test('the old one-off pop-up rules are gone (no second look, no page-level Escape / backdrop handlers)', () => {
  const S = require('../src/routes/adminShared');
  const css = S.DELETE_UI_CSS + S.PAYMENT_UI_CSS + S.BLACKLIST_UI_CSS;
  for (const old of ['.delm-overlay {', '.paym-overlay {', '.blm-overlay {', '.delm {', '.paym {', '.blm {']) assert.ok(!css.includes(old), old);
  const js = S.DELETE_UI_JS + S.PAYMENT_UI_JS + S.BLACKLIST_UI_JS;
  assert.ok(!/ov\.remove\(\)/.test(js), 'Delete no longer removes itself behind the shared close');
  assert.ok(!/function onKey\(e\)/.test(js), 'no per-dialog Escape listener');
  const { buildLeadsQueueHTML } = require('../src/routes/adminLeads');
  const { buildQueueHTML } = require('../src/routes/adminConsultation');
  const q = buildLeadsQueueHTML(), c = buildQueueHTML();
  assert.ok(!q.includes("o.style.display!=='none') alClose()"), 'Add lead: no own Escape handler');
  assert.ok(!c.includes("ev.key==='Escape'&&o&&o.style.display!=='none'"), 'Direct retainer: no own Escape handler');
  assert.ok(q.includes('<div id="al-overlay" class="tdlg-ov" hidden>') && c.includes('<div id="dc-overlay" class="tdlg-ov" hidden>'));
  assert.ok(q.includes('<div id="al-err" class="tdlg-err" role="alert"></div>'), 'Add lead errors are announced');
});

test('Add lead (Faran 2026-11-05): always opens EMPTY; a late answer for an earlier caller is never painted into the form', () => {
  const q = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(q.includes("['al-name','al-email','al-phone','al-address','al-note'].forEach(function(id){ var e=alEl(id); if(e) e.value=''; });"));
  assert.ok(q.includes("alEl('al-casetype').selectedIndex=0;"));
  assert.ok(q.includes("var dlg=alDlg(), run=dlg.openId;"));
  assert.ok(q.includes("if(!dlg.still(run)){   /* closed after the long wait: never painted into the form; the outcome is not lost either */"), 'late answer: never painted');
  assert.ok(q.includes("if(hadFiles && dlg.openId===run && AL_ATT.files().length){"), 'closed but not reopened: the files picked are still this person\'s — attached');
  assert.ok(q.includes("if(hadFiles) window.alert('The lead for '+who+' was created, but its attached file(s) were not saved — add them from the lead page.');"), 'reopened: said, not lost');
  assert.ok(q.includes(".catch(function(){ if(!dlg.still(run)) return;"));
  assert.ok(q.includes(".finally(function(){ if(!dlg.still(run)) return; dlg.setBusy(false);"));
  assert.ok(q.includes("var go=function(){ if(!dlg.still(run)){ load(); return; }"), 'closed during the attach upload: no jump to the lead');
});

test('New direct retainer client: a duplicate lookup or a 409 for an earlier client never lands in a reopened form', () => {
  const c = require('../src/routes/adminConsultation').buildQueueHTML();
  assert.ok(c.includes("DC_MATCHES=null; DC_MATCH_SEQ++; var mb=dcEl('dc-matches');"), 'opening invalidates a lookup still out for the last person');
  assert.ok(c.includes("var dlg=dcDlg(), run=dlg.openId;"));
  assert.ok(c.includes("if(!dlg.still(run)){   /* closed after the long wait: never painted into a later opening — but the outcome is told, not lost */"));
  assert.ok(c.includes("if(res.j.warning) window.alert(who+': '+res.j.warning);"), 'a late "tagging failed" warning is still shown');
  assert.ok(c.includes("if(hadFiles && dlg.openId===run && DC_ATT.files().length){"));
  assert.ok(c.includes(".catch(function(e){ if(!dlg.still(run)) return; dlg.setBusy(false);"));
  assert.ok(c.includes("if(!dcDlg().still(run)) return;   /* closed or reopened for someone else meanwhile */"), 'the lead-conversion prefill belongs to its own opening');
  assert.ok(c.includes(".then(function(p){ if(!dcDlg().still(run)) return; if(p){ dcApplyProfile(ref,p); dcCheckMatches(); } })"), 'the carried-profile prefill too');
});

test('Delete: Escape and × work; once sent, every way of closing refreshes the list; a late answer refreshes it too', () => {
  const js = require('../src/routes/adminShared').DELETE_UI_JS;
  assert.ok(js.includes("var dlg = tdotDialog(ov, { remove: true, group: 'delm', onClosed: function(){ if (sent) refresh(); },"));
  assert.ok(js.includes("sent = true; dlg.setBusy(true);"));
  assert.equal((js.match(/if \(!dlg\.isOpen\(\)\) \{ refresh\(\); return; \}/g) || []).length, 2, 'a late success and a late network error both refresh');
  assert.ok(js.includes('aria-labelledby="delm-title"'));
});
