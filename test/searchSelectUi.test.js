// The search box on a long list (staff request 2026-11-26): "Case type interest" on Add a lead —
// and, the same day, on Edit lead (the lead page) and on "＋ Direct consultation" (the same case type list).
// The filter is tested as the real function; the box itself runs here against a small fake DOM,
// using the very same source the page gets.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const SS = require('../src/routes/searchSelectUi');
const { SEARCH_SELECT_UI_JS, SEARCH_SELECT_CSS, tdotSearchFilter, tdotSearchMatch, tdotSearchNorm } = SS;

const TYPES = ['BCPNP', 'Canadian Experience Class (EE after ITA)', 'Canadian Experience Class (Profile+ITA+Submission)', 'Citizenship',
  'Co-op WP', 'LMIA Based WP', 'Manitoba PNP', 'OINP', 'PR Card Renewal', 'Visitor <b>Visa</b>'];

// ── the filter ────────────────────────────────────────────────────────────
test('filter: nothing typed keeps the whole list, in order', () => {
  assert.deepStrictEqual(tdotSearchFilter(TYPES, ''), TYPES);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, '   '), TYPES);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, null), TYPES);
  assert.deepStrictEqual(tdotSearchFilter(null, 'x'), []);
});

test('filter: any case, anywhere in the name', () => {
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'pnp'), ['BCPNP', 'Manitoba PNP']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'CITIZEN'), ['Citizenship']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'wp'), ['Co-op WP', 'LMIA Based WP']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'zzz'), []);
});

test('filter: extra spaces do not matter; every typed word must be there, in any order', () => {
  assert.deepStrictEqual(tdotSearchFilter(TYPES, '  ee   ita '), ['Canadian Experience Class (EE after ITA)']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'ita ee'), ['Canadian Experience Class (EE after ITA)']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'class ita'), ['Canadian Experience Class (EE after ITA)', 'Canadian Experience Class (Profile+ITA+Submission)']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'card  renewal'), ['PR Card Renewal']);
  assert.deepStrictEqual(tdotSearchFilter(TYPES, 'ee zzz'), []);
  assert.strictEqual(tdotSearchMatch('PR  Card Renewal', 'pr\tcard'), true, 'tabs and hard spaces count as spaces');
  assert.strictEqual(tdotSearchNorm('  A   b\tC '), 'a b c');
});

// ── the page-script rules ─────────────────────────────────────────────────
test('the browser code follows the page-script rules: no backtick, no dollar-brace, no backslash; it parses; it is the tested functions', () => {
  for (const [name, s] of [['SEARCH_SELECT_UI_JS', SEARCH_SELECT_UI_JS], ['SEARCH_SELECT_CSS', SEARCH_SELECT_CSS]]) {
    assert.ok(!s.includes('`'), name + ': no backtick');
    assert.ok(!s.includes('${'), name + ': no dollar-brace');
    assert.ok(!s.includes('\\'), name + ': no backslash');
  }
  new vm.Script(SEARCH_SELECT_UI_JS);
  for (const fn of [SS.tdotSearchNorm, SS.tdotSearchMatch, SS.tdotSearchFilter, SS.tdotSearchSelect]) assert.ok(SEARCH_SELECT_UI_JS.includes(fn.toString()), fn.name);
  // embedded in a template literal (as the pages do) it comes out unchanged
  assert.strictEqual(new Function('return `' + SEARCH_SELECT_UI_JS + '`')(), SEARCH_SELECT_UI_JS);
  assert.match(SEARCH_SELECT_CSS, /@media \(max-width: 760px\)[^}]*\{\s*\.ss-opt, \.ss-empty \{ font-size:16px; \}/, '16px rows on a phone');
});

test('Leads page: the box is switched on for al-casetype only; the select is still there; every script parses', () => {
  const al = require('../src/routes/adminLeads');
  const html = al.buildLeadsQueueHTML();
  assert.ok(html.includes('<label class="al-l" for="al-casetype">Case type interest</label>'), 'the label');
  assert.ok(html.includes('<select id="al-casetype"><option value="">— not sure yet —</option></select>'), 'the plain select stays as the fallback');
  assert.ok(html.includes("var AL_CT=null; try{ AL_CT=tdotSearchSelect('al-casetype',{ placeholder:'Type to search — or leave blank if not sure yet' }); }catch(e){}"), 'switched on, and a failure leaves the plain list working');
  assert.strictEqual(html.split('tdotSearchSelect(').length - 1, 2, 'one definition + one use: not on the edit-lead or other lists');
  assert.ok(html.includes("alEl('al-casetype').selectedIndex=0; if(AL_CT) AL_CT.sync();"), 'the form reset clears the box');
  assert.ok(html.includes("}).join(''); if(AL_CT) AL_CT.sync(); })"), 'the late-loaded list reaches the box');
  assert.ok(html.includes("caseTypeInterest:alEl('al-casetype').value"), 'the form still sends the select value');
  assert.ok(html.includes('.ss-list {'), 'the styles are on the page');
  assert.ok(html.indexOf('function tdotSearchSelect(') < html.indexOf('var AL_CT='), 'defined before it is used');
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { new vm.Script(m[1]); n++; }
  assert.ok(n > 0);
  assert.ok(!html.includes('bd-casetype') && !html.includes('dq-casetype'), 'the other two forms are on their own pages');
});

const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const PLACEHOLDER = 'Type to search — or leave blank if not sure yet';

test('Lead page (Edit lead): the box is switched on for bd-casetype only; the select, the label and the Save line are as before; every script parses', () => {
  const al = require('../src/routes/adminLeads');
  const html = al.buildLeadDetailHTML('7');
  assert.ok(html.includes('<label class="al-l" for="bd-casetype">Case type interest</label><select id="bd-casetype"><option value="">— not sure yet —</option></select>'), 'the label and the plain select stay');
  assert.ok(html.includes("var BD_CT=null; try{ BD_CT=tdotSearchSelect('bd-casetype',{ placeholder:'" + PLACEHOLDER + "' }); }catch(e){}"), 'switched on, and a failure leaves the plain list working');
  assert.strictEqual(html.split('tdotSearchSelect(').length - 1, 2, 'one definition + one use: not on Source / Reference or any other list');
  assert.ok(html.includes("ct.value=d.caseTypeInterest||''; if(BD_CT) BD_CT.sync();"), 'the value filled in from the lead reaches the box');
  assert.ok(html.includes('bdOption(ct,keep); ct.value=keep; if(BD_CT) BD_CT.sync(); })'), 'and again when the list arrives');
  assert.ok(html.includes("caseTypeInterest:bdEl('casetype').value"), 'Save still sends the select value');
  assert.ok(html.includes("['name','email','phone','source','casetype'].forEach(function(k){ var el=bdEl(k); el.addEventListener(el.tagName==='SELECT'?'change':'input',function(){ BD_DIRTY=true; }); });"), 'the unsaved-edit flag still hangs on the select\'s change event');
  assert.ok(html.includes('.ss-list {'), 'the styles are on the page');
  assert.ok(html.indexOf('function tdotSearchSelect(') < html.indexOf('var BD_CT=') && html.indexOf('var BD_CT=') < html.indexOf('function hydrateBasic('), 'defined, then switched on, then used');
  const scripts = scriptsOf(html);
  assert.ok(scripts.length > 0);
  scripts.forEach((src) => new vm.Script(src));
});

test('Consultations page (＋ Direct consultation): the box is switched on for dq-casetype, on the select of this opening; every script parses', () => {
  const C = require('../src/routes/adminConsultation');
  const DQ = require('../src/routes/directConsultUi');
  const html = C.buildQueueHTML();
  assert.ok(DQ.dqFormHtml().includes('<label class="dq-l" for="dq-casetype">Case type <span class="dq-h">(optional)</span></label><select id="dq-casetype"><option value="">— not sure yet —</option></select>'), 'the label and the plain select stay');
  const use = "try{ if(typeof tdotSearchSelect==='function') tdotSearchSelect(q('dq-casetype'),{ placeholder:'" + PLACEHOLDER + "' }); }catch(e){}";
  assert.ok(DQ.DQ_JS.includes(use), 'switched on; a page without the box, or a failure, leaves the plain list working');
  assert.strictEqual(DQ.DQ_JS.split('tdotSearchSelect(').length - 1, 1, 'only on the case type — not on Source / Reference, Booked by or the consultant');
  const open = DQ.DQ_JS.indexOf('function openDirectConsult()'), fresh = DQ.DQ_JS.indexOf('box.innerHTML=DQ_FORM'), fill = DQ.DQ_JS.indexOf("q('dq-casetype').innerHTML="), at = DQ.DQ_JS.indexOf(use), wiring = DQ.DQ_JS.indexOf('/* ── Wiring ── */');
  assert.ok(open >= 0 && open < fresh && fresh < fill && fill < at && at < wiring, 'inside the opening, on the form built fresh for it, after the list is filled: a re-opened form starts with an empty box');
  assert.ok(DQ.DQ_JS.includes("caseType:q('dq-casetype').value"), 'Save still sends the select value');
  assert.strictEqual(html.split('tdotSearchSelect(').length - 1, 2, 'one definition + one use on the page');
  assert.ok(html.indexOf('function tdotSearchSelect(') >= 0 && html.indexOf('function tdotSearchSelect(') < html.indexOf('function openDirectConsult()'), 'defined before the pop-up code');
  assert.ok(html.includes('.ss-list {'), 'the styles are on the page');
  const scripts = scriptsOf(html);
  assert.ok(scripts.length > 0);
  scripts.forEach((src) => new vm.Script(src));
  // the form is on this page only
  for (const other of [C.buildRetainersHTML(), C.buildDetailHTML('7')]) {
    assert.ok(!other.includes('openDirectConsult') && !other.includes('tdotSearchSelect'), 'no direct-consultation form, no box');
    scriptsOf(other).forEach((src) => new vm.Script(src));
  }
});

// ── the box itself, on a fake DOM ─────────────────────────────────────────
function world(opts) {
  const listeners = new WeakMap();
  const doc = { activeElement: null, byId: {}, parentNode: null,
    getElementById(id) { return doc.byId[id] || (function find(n) { if (n.id === id) return n; for (const k of n.children) { const r = find(k); if (r) return r; } return null; })(doc.body); },
    createElement(tag) { return el(tag); },
    addEventListener(t, f) { on(doc, t, f); },
    removeEventListener(t, f) { const a = (listeners.get(doc) || {})[t] || []; if (a.indexOf(f) >= 0) a.splice(a.indexOf(f), 1); } };
  const count = (n, t) => ((listeners.get(n) || {})[t] || []).length;
  function on(n, t, f) { if (!listeners.has(n)) listeners.set(n, {}); (listeners.get(n)[t] = listeners.get(n)[t] || []).push(f); }
  function fire(target, type, extra) {
    const e = Object.assign({ type, target, defaultPrevented: false, stopped: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.stopped = true; } }, extra);
    for (let p = target; p && !e.stopped; p = p.parentNode || (p === doc ? null : doc)) for (const f of ((listeners.get(p) || {})[type] || [])) f(e);
    return e;
  }
  function el(tag) {
    const n = { tagName: String(tag).toUpperCase(), id: '', className: '', type: '', hidden: false, style: {}, attrs: {}, children: [], parentNode: null, value: '', _text: '', selected: 0,
      get firstChild() { return n.children[0] || null; },
      get textContent() { return n._text + n.children.map((c) => c.textContent).join(''); }, set textContent(v) { n.children = []; n._text = String(v); },
      setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; }, removeAttribute(k) { delete n.attrs[k]; },
      appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
      insertBefore(c, ref) { c.parentNode = n; n.children.splice(n.children.indexOf(ref), 0, c); return c; },
      removeChild(c) { n.children.splice(n.children.indexOf(c), 1); c.parentNode = null; return c; },
      addEventListener(t, f) { on(n, t, f); }, dispatchEvent(e) { fire(n, e.type, { bubbles: e.bubbles }); return true; },
      focus() { if (doc.activeElement === n) return; const was = doc.activeElement; doc.activeElement = n; if (was) fire(was, 'blur'); fire(n, 'focus'); },
      select() { n.selectedAll = true; } };
    return n;
  }
  doc.body = el('body');
  const ID = (opts && opts.id) || 'al-casetype';
  // A select as the pages use it: value / selectedIndex / options, a late list (setOptions), an option added by code
  // (appendChild) and a list written as HTML (innerHTML) — as the lead page does.
  function select(id, labelText) {
    const label = doc.body.appendChild(el('label')); label.textContent = labelText; label.htmlFor = id;
    const sel = doc.body.appendChild(el('select')); sel.id = id;
    let options = [], index = 0;
    sel.setOptions = (names) => { options = [{ value: '', text: '— not sure yet —' }].concat(names.map((t) => ({ value: t, text: t }))); index = 0; };
    sel.appendChild = (o) => { options.push({ value: o.value, text: o.textContent }); return o; };
    const unesc = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    Object.defineProperty(sel, 'innerHTML', { set: (h) => { options = [...String(h).matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map((m) => ({ value: unesc(m[1] != null ? m[1] : m[2]), text: unesc(m[2]) })); index = 0; } });
    Object.defineProperty(sel, 'options', { get: () => options });
    Object.defineProperty(sel, 'selectedIndex', { get: () => (options.length ? index : -1), set: (i) => { index = i; } });
    Object.defineProperty(sel, 'value', { get: () => (options[index] ? options[index].value : ''), set: (v) => { const i = options.findIndex((o) => o.value === v); index = i < 0 ? -1 : i; } });
    Object.defineProperty(sel, 'labels', { get: () => (label.htmlFor === sel.id ? [label] : []) });
    sel.label = label;
    return sel;
  }
  const sel = select(ID, 'Case type interest'), label = sel.label, setOptions = sel.setOptions;
  setOptions((opts && opts.names) || []);
  const other = doc.body.appendChild(el('button'));
  const timers = [], changes = [], docKeys = [];
  on(sel, 'change', () => changes.push(sel.value));
  on(doc, 'keydown', (e) => docKeys.push(e.key + (e.defaultPrevented ? ':used' : '')));   // where the pop-up listens for Escape
  const sandbox = { document: doc, window: {}, setTimeout: (f) => { timers.push(f); }, Event: function (type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); } };
  vm.createContext(sandbox);
  let api;
  if (opts && opts.page) { opts.page({ doc, sandbox, el, select, sel }); api = sel.tdotSearch; }   // a page's own script switches the box on
  else {
    vm.runInContext(SEARCH_SELECT_UI_JS, sandbox);
    api = sandbox.tdotSearchSelect(opts && opts.byElement ? sel : ID, { placeholder: 'Type to search' });
  }
  const input = api.input, list = api.list;
  return { doc, sandbox, sel, label, api, input, list, other, changes, docKeys, setOptions, fire, el, select, count,
    type(text) { input.focus(); input.value = text; fire(input, 'input'); },
    key(k) { return fire(input, 'keydown', { key: k }); },
    rows() { return list.children.map((c) => c.textContent); },
    activeText() { const id = input.getAttribute('aria-activedescendant'); const r = list.children.find((c) => c.id === id); return r ? r.textContent : null; },
    tick() { while (timers.length) timers.shift()(); },
    leave() { other.focus(); while (timers.length) timers.shift()(); } };
}

test('box: built on top of the select — label moved to the box, select hidden but kept, combobox roles', () => {
  const w = world();
  assert.strictEqual(w.sel.style.display, 'none');
  assert.strictEqual(w.label.htmlFor, w.input.id);
  assert.strictEqual(w.doc.body.children.indexOf(w.input.parentNode.parentNode) + 1, w.doc.body.children.indexOf(w.sel), 'the box sits right before the select');
  assert.strictEqual(w.input.getAttribute('role'), 'combobox');
  assert.strictEqual(w.input.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(w.input.getAttribute('aria-controls'), w.list.id);
  assert.strictEqual(w.list.getAttribute('role'), 'listbox');
  assert.strictEqual(w.list.getAttribute('aria-label'), 'Case type interest');
  assert.strictEqual(w.list.hidden, true);
  assert.strictEqual(w.input.value, '');
  assert.strictEqual(w.sandbox.tdotSearchSelect('al-casetype'), w.api, 'asking twice gives the same box, not a second one');
  assert.strictEqual(w.sandbox.tdotSearchSelect('no-such-select'), null);
});

test('box: options loaded late, type, arrows, Enter picks — the select gets the value and one change event', () => {
  const w = world();
  w.type('pnp');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —', 'The list has not loaded yet.'], 'before the list arrives: not called "no match"');
  w.setOptions(TYPES); w.api.sync();   // the fetch lands while the staffer is typing
  assert.strictEqual(w.input.value, 'pnp', 'the typed text is kept');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —', 'BCPNP', 'Manitoba PNP']);
  assert.deepStrictEqual(w.changes, [], 'loading the list sends no event (the form stays untouched)');
  assert.strictEqual(w.input.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(w.activeText(), 'BCPNP', 'Enter would take the first match');
  assert.strictEqual(w.key('ArrowDown').defaultPrevented, true);
  assert.strictEqual(w.activeText(), 'Manitoba PNP');
  w.key('ArrowDown'); assert.strictEqual(w.activeText(), '— not sure yet —', 'wraps round');
  w.key('ArrowUp'); assert.strictEqual(w.activeText(), 'Manitoba PNP');
  const e = w.key('Enter');
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(w.sel.value, 'Manitoba PNP');
  assert.strictEqual(w.input.value, 'Manitoba PNP');
  assert.deepStrictEqual(w.changes, ['Manitoba PNP']);
  assert.strictEqual(w.list.hidden, true);
  assert.strictEqual(w.input.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(w.input.getAttribute('aria-activedescendant'), null);
  assert.strictEqual(w.key('Enter').defaultPrevented, false, 'list closed: Enter is left alone');
});

test('box: Escape closes the list only (the pop-up never sees it); with the list closed Escape is the pop-up\'s', () => {
  const w = world({ names: TYPES });
  w.type('citi');
  const e = w.key('Escape');
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(w.list.hidden, true);
  assert.strictEqual(w.input.value, '', 'back to the last pick (nothing)');
  assert.deepStrictEqual(w.docKeys, [], 'the page-level Escape handler did not run');
  const e2 = w.key('Escape');
  assert.strictEqual(e2.defaultPrevented, false);
  assert.deepStrictEqual(w.docKeys, ['Escape'], 'now it reaches the pop-up');
});

test('box: junk text never reaches the form — leaving the box goes back to the last pick', () => {
  const w = world({ names: TYPES });
  w.type('citizen'); w.key('Enter');
  assert.strictEqual(w.sel.value, 'Citizenship');
  w.type('something made up');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —', 'No match. Try fewer letters.']);
  assert.strictEqual(w.key('Enter').defaultPrevented, true);   // nothing to take
  assert.strictEqual(w.sel.value, 'Citizenship');
  w.other.focus();   // straight to another control: the value is right at once, before any timer
  assert.strictEqual(w.input.value, 'Citizenship');
  assert.strictEqual(w.sel.value, 'Citizenship');
  w.leave();
  assert.strictEqual(w.list.hidden, true);
  assert.deepStrictEqual(w.changes, ['Citizenship']);
});

test('box: emptying it means "not sure yet"; a full name typed out counts as picked; the x clears', () => {
  const w = world({ names: TYPES });
  w.type('oinp'); w.key('Enter');
  w.type(''); w.leave();
  assert.strictEqual(w.sel.value, '');
  assert.strictEqual(w.input.value, '');
  w.type('  pr card   RENEWAL '); w.leave();
  assert.strictEqual(w.sel.value, 'PR Card Renewal');
  assert.strictEqual(w.input.value, 'PR Card Renewal');
  const x = w.input.parentNode.children[1];
  assert.strictEqual(x.hidden, false);
  assert.strictEqual(x.getAttribute('tabindex'), '-1');
  assert.strictEqual(w.fire(x, 'mousedown').defaultPrevented, true, 'the click does not take focus out of the box');
  w.fire(x, 'click');
  assert.strictEqual(w.sel.value, ''); assert.strictEqual(w.input.value, ''); assert.strictEqual(x.hidden, true);
  assert.deepStrictEqual(w.changes, ['OINP', '', 'PR Card Renewal', '']);
});

test('box: a click opens the whole list with the pick marked; a click on a row picks it; names are shown as text', () => {
  const w = world({ names: TYPES });
  w.type('co-op'); w.key('Enter');
  w.input.focus(); w.fire(w.input, 'click');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —'].concat(TYPES), 'the box showing the pick means the whole list');
  assert.strictEqual(w.activeText(), 'Co-op WP');
  assert.strictEqual(w.list.children.find((c) => c.textContent === 'Co-op WP').getAttribute('aria-selected'), 'true');
  assert.ok(w.list.children.every((c) => c.getAttribute('role') === 'option' && !('tabindex' in c.attrs)), 'rows are options and not tab stops');
  const row = w.list.children.find((c) => c.textContent === 'Visitor <b>Visa</b>');
  assert.strictEqual(row.children.length, 0, 'set as text, never as HTML');
  assert.strictEqual(w.fire(row, 'mousedown').defaultPrevented, true);
  w.fire(row, 'click');
  assert.strictEqual(w.sel.value, 'Visitor <b>Visa</b>');
  assert.strictEqual(w.list.hidden, true);
  w.key('ArrowDown');
  assert.strictEqual(w.list.hidden, false, 'Arrow Down opens the list');
});

test('box: the form reset (selectedIndex=0 then sync) empties the box and sends no event', () => {
  const w = world({ names: TYPES });
  w.type('bcpnp'); w.key('Enter'); w.leave();
  assert.strictEqual(w.input.value, 'BCPNP');
  const before = w.changes.length;
  w.sel.selectedIndex = 0; w.api.sync();
  assert.strictEqual(w.input.value, '');
  assert.strictEqual(w.input.parentNode.children[1].hidden, true);
  assert.strictEqual(w.list.hidden, true);
  assert.strictEqual(w.changes.length, before);
  w.sel.value = 'OINP'; w.api.sync();   // a value set by code shows too
  assert.strictEqual(w.input.value, 'OINP');
  assert.strictEqual(w.fire(w.input, 'change').stopped, true, 'the box\'s own change event stays in the box — only the select\'s reaches the page');
});

// ── review fixes (2026-11-26) ─────────────────────────────────────────────
test('box: emptied and then Enter means "not sure yet" — it does not take the old pick back', () => {
  const w = world({ names: TYPES });
  w.type('citizen'); w.key('Enter');
  assert.strictEqual(w.sel.value, 'Citizenship');
  w.type('');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —'].concat(TYPES));
  assert.strictEqual(w.activeText(), '— not sure yet —', 'the blank choice is the one Enter takes');
  w.key('Enter');
  assert.strictEqual(w.sel.value, '');
  assert.strictEqual(w.input.value, '');
  assert.deepStrictEqual(w.changes, ['Citizenship', '']);
});

test('box: the window loses focus while typing — the list follows the box, Enter cannot take a row from the old search', () => {
  const w = world({ names: TYPES });
  w.type('pnp');
  assert.strictEqual(w.activeText(), 'BCPNP');
  w.fire(w.input, 'blur'); w.tick();   // alt-tab: blur, but the box is still the page's active element
  assert.strictEqual(w.input.value, '', 'back to the last pick');
  assert.strictEqual(w.list.hidden, false);
  assert.deepStrictEqual(w.rows(), ['— not sure yet —'].concat(TYPES), 'no leftover "pnp" filter');
  w.key('Enter');
  assert.strictEqual(w.sel.value, '');
  assert.deepStrictEqual(w.changes, []);
});

test('box: a held mouse press on another field — the list stays until the button is let go, then closes', () => {
  const w = world({ names: TYPES });
  w.type('wp');
  w.fire(w.other, 'mousedown'); w.other.focus(); w.tick();
  assert.strictEqual(w.list.hidden, false, 'nothing moves under the press');
  assert.strictEqual(w.input.value, '', 'but the value is already settled');
  w.fire(w.other, 'mouseup'); w.tick();
  assert.strictEqual(w.list.hidden, true);
  assert.strictEqual(w.input.parentNode.parentNode.className, 'ss-wrap');
});

test('box: the list is shown before it is filled, starts from its top, and is brought into sight every time it changes', () => {
  const w = world({ names: TYPES });
  const wrap = w.input.parentNode.parentNode, hiddenWhenFilled = [];
  let reveals = 0;
  wrap.scrollIntoView = () => { reveals++; };
  Object.defineProperty(w.list, 'scrollTop', { get: () => 0, set: () => { hiddenWhenFilled.push(w.list.hidden); } });
  w.type('zz');
  assert.strictEqual(wrap.className, 'ss-wrap ss-open', 'the phone rule for spare room below hangs on this');
  assert.strictEqual(reveals, 1);
  w.type('');   // back to the long list: it may now reach under the pop-up's buttons
  assert.strictEqual(reveals, 2);
  w.key('Escape');
  w.fire(w.input, 'click');
  assert.strictEqual(reveals, 3);
  assert.ok(hiddenWhenFilled.length >= 3 && hiddenWhenFilled.every((h) => h === false), 'never measured while hidden');
  assert.match(SEARCH_SELECT_CSS, /@media \(max-width: 760px\)[\s\S]*\.ss-wrap\.ss-open \{ padding-bottom:45vh; \}/);
});

test('box: the page sets the select while the list is open on the old pick — the box shows the new value and leaving does not undo it', () => {
  const w = world({ names: TYPES });
  w.type('oinp'); w.key('Enter');
  w.fire(w.input, 'click');
  assert.strictEqual(w.list.hidden, false);
  w.sel.selectedIndex = 0; w.api.sync();
  assert.strictEqual(w.input.value, '');
  w.leave();
  assert.strictEqual(w.sel.value, '');
  assert.deepStrictEqual(w.changes, ['OINP']);
});

test('box: a screen reader hears the result count and "no match"; the hover text is only for a cut-off name', () => {
  const w = world({ names: TYPES });
  const status = w.input.parentNode.children[2];
  assert.strictEqual(status.getAttribute('role'), 'status');
  w.type('pnp'); assert.strictEqual(status.textContent, '2 matches');
  w.type('citizen'); assert.strictEqual(status.textContent, '1 match');
  w.type('zzz'); assert.strictEqual(status.textContent, 'No match. Try fewer letters.');
  w.type(''); assert.strictEqual(status.textContent, '');
  w.type('citizen'); w.key('Enter');
  assert.strictEqual(status.textContent, '');
  assert.strictEqual(w.input.title, '', 'fits in the box: no second reading');
  w.input.scrollWidth = 400; w.input.clientWidth = 200;
  w.sel.value = 'Canadian Experience Class (EE after ITA)'; w.api.sync();
  assert.strictEqual(w.input.title, 'Canadian Experience Class (EE after ITA)');
});

// ── Edit lead (the lead page) and ＋ Direct consultation (2026-11-26) ───────
// The lead page's own code, cut out of the page as it is served: bdEl, bdOption, the box, hydrateBasic and the
// line that sets the unsaved-edit flag. Run on the fake DOM, with the case type list arriving late (the fetch).
function leadPage() {
  const html = require('../src/routes/adminLeads').buildLeadDetailHTML('7');
  const a = html.indexOf('var BD_LOADED='), b = html.indexOf("document.getElementById('btn-bd-save').onclick");
  assert.ok(a > 0 && b > a);
  const net = {};
  const w = world({ id: 'bd-casetype', page({ doc, sandbox, el, select }) {
    for (const id of ['bd-name', 'bd-email', 'bd-phone', 'bd-lock']) { const n = doc.body.appendChild(el(id === 'bd-lock' ? 'div' : 'input')); n.id = id; }
    select('bd-source', 'Source / Reference').setOptions(['Website', 'Walk-in']);
    Object.assign(sandbox, { getKey: () => 'k', escHtml: (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      fetch: (url) => { net.url = url; return { then(f) { net.land = (types) => f({ json: () => ({ caseTypes: types }) }); return { then(g) { const first = net.land; net.land = (types) => g(first(types)); return { catch() {} }; } }; } }; } });
    vm.runInContext('var BD_DIRTY=false, BD_TYPES=null; var BD_REF={ load:function(){} };\n' + html.slice(a, b), sandbox);
  } });
  return Object.assign(w, { net, dirty: () => vm.runInContext('BD_DIRTY', w.sandbox), hydrate: (d) => w.sandbox.hydrateBasic(d) });
}

test('Edit lead: an old case type that is no longer on the list shows in the box, stays through the late list and every re-load, and never marks the form as edited', () => {
  const w = leadPage();
  const OLD = 'Spousal (old label)';
  assert.strictEqual(w.sel.style.display, 'none', 'the page switched the box on');
  assert.strictEqual(w.label.htmlFor, w.input.id);
  w.hydrate({ name: 'Asha', caseTypeInterest: OLD });
  assert.strictEqual(w.input.value, OLD, 'shown before the list has even arrived');
  assert.strictEqual(w.sel.value, OLD);
  assert.strictEqual(w.net.url, '/api/consultation/direct-client/options');
  w.net.land(TYPES);   // the list arrives
  assert.deepStrictEqual(w.sel.options.map((o) => o.value), [''].concat(TYPES, [OLD]), 'the real list, and the old label kept at the end');
  assert.strictEqual(w.sel.value, OLD); assert.strictEqual(w.input.value, OLD);
  w.hydrate({ name: 'Asha', caseTypeInterest: OLD });   // the page re-loads the lead (after any other action)
  assert.strictEqual(w.input.value, OLD);
  w.input.focus(); w.fire(w.input, 'click');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —'].concat(TYPES, [OLD]), 'the whole list, the old label still offered');
  assert.strictEqual(w.activeText(), OLD);
  w.key('Escape'); w.leave();   // looked, changed nothing
  w.type('made up'); w.leave();   // junk typed, then left
  assert.strictEqual(w.sel.value, OLD, 'an unrelated save sends the old label back untouched');
  assert.strictEqual(w.input.value, OLD);
  assert.deepStrictEqual(w.changes, []);
  assert.strictEqual(w.dirty(), false, 'loading, the late list, looking and junk text: the form is still "not edited"');
});

test('Edit lead: a pick marks the form as edited (a re-load no longer overwrites it); so does a clear; a saved pick comes back from the server', () => {
  const w = leadPage();
  w.hydrate({ name: 'Asha', caseTypeInterest: 'OINP' }); w.net.land(TYPES);
  assert.strictEqual(w.input.value, 'OINP'); assert.strictEqual(w.dirty(), false);
  w.type('citizen'); w.key('Enter');
  assert.strictEqual(w.sel.value, 'Citizenship');
  assert.strictEqual(w.dirty(), true, 'the pick is an edit');
  w.hydrate({ name: 'Asha', caseTypeInterest: 'OINP' });   // a re-load while the edit is unsaved
  assert.strictEqual(w.sel.value, 'Citizenship', 'the unsaved pick survives');
  assert.strictEqual(w.input.value, 'Citizenship');
  vm.runInContext('BD_DIRTY=false', w.sandbox);   // Save went through; the page loads the lead again
  w.hydrate({ name: 'Asha', caseTypeInterest: 'Citizenship' });
  assert.strictEqual(w.input.value, 'Citizenship'); assert.strictEqual(w.dirty(), false);
  w.fire(w.input.parentNode.children[1], 'click');   // the x
  assert.strictEqual(w.sel.value, ''); assert.strictEqual(w.input.value, '');
  assert.strictEqual(w.dirty(), true, 'the clear is an edit');
  assert.deepStrictEqual(w.changes, ['Citizenship', '']);
  vm.runInContext('BD_DIRTY=false', w.sandbox);
  w.hydrate({ name: 'Asha', caseTypeInterest: '' });
  assert.strictEqual(w.input.value, '', 'a lead with no case type: an empty box');
});

test('Edit lead: typing while the list arrives keeps the text; an old label stays the value until a pick is made', () => {
  const w = leadPage();
  w.hydrate({ name: 'Asha', caseTypeInterest: 'Old label' });
  w.type('pnp');   // typing before the list is there
  w.net.land(TYPES);
  assert.strictEqual(w.input.value, 'pnp');
  assert.deepStrictEqual(w.rows(), ['— not sure yet —', 'BCPNP', 'Manitoba PNP']);
  assert.strictEqual(w.sel.value, 'Old label', 'nothing changed yet');
  assert.strictEqual(w.dirty(), false);
  w.key('Enter');
  assert.strictEqual(w.sel.value, 'BCPNP');
  assert.strictEqual(w.dirty(), true);
});

test('＋ Direct consultation: the box is built on the select it is handed; the next opening has its own empty box; a box whose form is gone stops listening', () => {
  const w = world({ id: 'dq-casetype', names: TYPES, byElement: true });
  assert.strictEqual(w.input.id, 'dq-casetype-ss-in'); assert.strictEqual(w.list.id, 'dq-casetype-ss-list');
  assert.strictEqual(w.label.htmlFor, w.input.id);
  w.type('oinp'); w.key('Enter');
  assert.strictEqual(w.sel.value, 'OINP'); assert.strictEqual(w.input.value, 'OINP');
  assert.deepStrictEqual(w.changes, ['OINP'], 'the select\'s change event is what the pop-up counts as "something was chosen"');
  assert.strictEqual(w.count(w.doc, 'mousedown'), 1);
  // the pop-up closes (its form leaves the page) and is opened again: a new form, a new select
  const wrap = w.input.parentNode.parentNode;
  wrap.isConnected = false;
  const sel2 = w.select('dq-casetype', 'Case type (optional)'); sel2.setOptions(TYPES);
  const api2 = w.sandbox.tdotSearchSelect(sel2, { placeholder: 'x' });
  assert.notStrictEqual(api2, w.api);
  assert.strictEqual(api2.input.value, '', 'nothing left over from the last client');
  assert.strictEqual(sel2.value, '');
  assert.strictEqual(sel2.style.display, 'none');
  assert.strictEqual(w.count(w.doc, 'mousedown'), 2);
  w.fire(w.other, 'mousedown'); w.fire(w.other, 'mouseup');
  assert.strictEqual(w.count(w.doc, 'mousedown'), 1, 'the old box took its page listeners away');
  assert.strictEqual(w.count(w.doc, 'mouseup'), 1);
  // the new box still works after that
  api2.input.focus(); api2.input.value = 'wp'; w.fire(api2.input, 'input');
  w.fire(w.other, 'mousedown'); w.other.focus(); w.tick();
  assert.strictEqual(api2.list.hidden, false, 'held press: the list waits');
  w.fire(w.other, 'mouseup'); w.tick();
  assert.strictEqual(api2.list.hidden, true);
});

test('＋ Direct consultation: the pop-up code runs without the box too (a page that does not carry it keeps the plain list)', () => {
  const DQ = require('../src/routes/directConsultUi');
  const calls = [];
  const fn = new Function('tdotSearchSelect', 'q', DQ.DQ_JS.split('\n').find((l) => l.includes("tdotSearchSelect(q('dq-casetype')")));
  fn((el, o) => { calls.push([el, o.placeholder]); }, (id) => 'the ' + id + ' of this opening');
  assert.deepStrictEqual(calls, [['the dq-casetype of this opening', PLACEHOLDER]]);
  fn(undefined, () => { throw new Error('not asked'); });   // no box on the page: nothing happens, nothing throws
  fn(() => { throw new Error('broken'); }, () => 1);   // a failure stays inside
});
