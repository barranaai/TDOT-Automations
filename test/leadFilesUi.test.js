// "Attachments" beside Priority on the lead page (Faran 2026-11-27) — the browser half.
// The button and its pop-up run here on a small fake DOM, using the very same source the page gets;
// the page's own lines (the chip row, the first look, the staff upload) are cut out of the page as it is
// served and run on that same fake DOM. No network: fetch, window.open, Blob and URL are fakes.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const UI = require('../src/routes/leadFilesUi');
const { LEAD_FILES_UI_JS, LEAD_FILES_CSS } = UI;
const adminLeads = require('../src/routes/adminLeads');

const LEAD = '7654321';
const K1 = 'a'.repeat(24), K2 = 'b'.repeat(24), K3 = 'c'.repeat(24), K4 = 'd'.repeat(24);
const LETTER = { key: K1, label: 'Refusal letter', kind: 'client', ext: 'pdf', size: 1258291, modified: '2026-11-20T15:00:00Z', view: 'tab' };
const SHOT = { key: K2, label: 'passport scan.png', kind: 'staff', ext: 'png', size: 348160, modified: '2026-11-21T15:00:00Z', view: 'tab', addedBy: 'Asha Test', addedAt: '2026-11-21 10:05' };
const PHONE_PIC = { key: K3, label: 'phone picture.heic', kind: 'staff', ext: 'heic', size: 2097152, modified: '2026-11-22T15:00:00Z', view: 'download', addedBy: '', addedAt: '2026-11-22 09:00' };
const html = adminLeads.buildLeadDetailHTML(LEAD);
const scriptsOf = (h) => [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const plain = (v) => JSON.parse(JSON.stringify(v));   // a value made inside the page's sandbox, as a plain value of this one
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── a small fake page ─────────────────────────────────────────────────────
function world() {
  const doc = { activeElement: null };
  const unesc = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  function text(v) { return { nodeType: 3, parentNode: null, textContent: String(v) }; }
  function parse(src) {   // just enough HTML for the chip row: tags, attributes, text
    const root = el('root'); let at = root;
    for (const m of String(src).matchAll(/<(\/)?([a-zA-Z0-9]+)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:="[^"]*")?)*)\s*(\/)?>|([^<]+)/g)) {
      if (m[5] != null) { at.appendChild(text(unesc(m[5]))); continue; }
      if (m[1]) { at = at.parentNode || root; continue; }
      const n = el(m[2]);
      for (const a of m[3].matchAll(/([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g)) n.setAttribute(a[1], unesc(a[2] || ''));
      at.appendChild(n);
      if (!m[4]) at = n;
    }
    return root.children.map((c) => { c.parentNode = null; return c; });
  }
  function el(tag) {
    const listeners = {};
    const n = { nodeType: 1, tagName: String(tag).toUpperCase(), id: '', className: '', type: '', title: '', href: '', download: '', rel: '', hidden: false, disabled: false,
      style: {}, attrs: {}, children: [], parentNode: null, onclick: null, _text: '', clicks: 0,
      get firstChild() { return n.children[0] || null; },
      get textContent() { return n.children.length ? n.children.map((c) => c.textContent).join('') : n._text; },
      set textContent(v) { if (doc.activeElement && doc.activeElement !== n && n.contains(doc.activeElement)) doc.activeElement = null;   // what is taken out of the page loses the focus
        n.children.forEach((c) => { c.parentNode = null; }); n.children = []; n._text = String(v); },
      set innerHTML(v) { n.textContent = ''; parse(v).forEach((c) => n.appendChild(c)); },
      setAttribute(k, v) { n.attrs[k] = String(v); if (k === 'id') n.id = String(v); if (k === 'class') n.className = String(v); if (k === 'hidden') n.hidden = true; },
      getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; }, hasAttribute(k) { return k in n.attrs; }, removeAttribute(k) { delete n.attrs[k]; },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = n; n.children.push(c); return c; },
      removeChild(c) { const i = n.children.indexOf(c); assert.ok(i >= 0, 'removeChild: not a child'); n.children.splice(i, 1); c.parentNode = null; if (doc.activeElement === c) doc.activeElement = null; return c; },
      replaceChild(c, old) { const i = n.children.indexOf(old); assert.ok(i >= 0, 'replaceChild: not a child'); if (c.parentNode) c.parentNode.removeChild(c); n.children[n.children.indexOf(old)] = c; c.parentNode = n; old.parentNode = null; return old; },
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      click() { n.clicks++; if (n.disabled) return; (listeners.click || []).forEach((f) => f.call(n, { type: 'click', target: n })); if (typeof n.onclick === 'function') n.onclick.call(n, { type: 'click', target: n }); },
      focus() { if (!n.disabled) doc.activeElement = n; },
      contains(x) { for (let p = x; p; p = p.parentNode) if (p === n) return true; return false; } };
    return n;
  }
  const find = (n, ok) => { if (n.nodeType !== 1) return null; if (ok(n)) return n; for (const k of n.children) { const r = find(k, ok); if (r) return r; } return null; };
  const all = (n, ok, out = []) => { if (n.nodeType !== 1) return out; if (ok(n)) out.push(n); n.children.forEach((k) => all(k, ok, out)); return out; };
  doc.body = el('body');
  doc.createElement = el; doc.createTextNode = text;
  doc.getElementById = (id) => find(doc.body, (n) => n.id === id);

  const net = [];       // every fetch: { url, opts, answer(resp), fail() }
  const tabs = [];      // every window.open
  const timers = [];    // every setTimeout: { f, ms }
  const blobs = [];     // every object URL made: { url, blob, revoked }
  const dialogs = [];
  const win = { location: { href: '/admin/lead/' + LEAD }, blockTabs: false,
    open(url, target) {
      if (win.blockTabs) { tabs.push(null); return null; }
      const t = { url, target, opener: win, closed: false, location: { href: 'about:blank' }, document: { title: '', body: { textContent: '' } }, close() { t.closed = true; } };
      tabs.push(t); return t;
    } };
  const sandbox = { document: doc, window: win, console,
    fetch(url, opts) { return new Promise((resolve, reject) => { net.push({ url, opts, answer: resolve, fail: () => reject(new TypeError('Failed to fetch')) }); }); },
    setTimeout(f, ms) { timers.push({ f, ms }); return timers.length; },
    Blob: function (parts, o) { this.parts = parts; this.type = (o && o.type) || ''; },
    URL: { createObjectURL(b) { const u = 'blob:test/' + (blobs.length + 1); blobs.push({ url: u, blob: b, revoked: false }); return u; }, revokeObjectURL(u) { blobs.find((x) => x.url === u).revoked = true; } },
    // the house pop-up, as far as this code uses it (the real one is tested in test/dialogUi.test.js)
    tdotDialogNew(o) {
      dialogs.filter((d) => d.isOpen() && d.opts.group === o.group).forEach((d) => d.close(true));
      const ov = el('div'); ov.className = 'tdlg-ov' + (o.ovClass ? ' ' + o.ovClass : '');
      const frame = ov.appendChild(el('div')); frame.className = 'tdlg' + (o.cls ? ' ' + o.cls : ''); if (o.labelledBy) frame.setAttribute('aria-labelledby', o.labelledBy);
      const box = frame.appendChild(el('div')); box.className = 'tdlg-body';
      doc.body.appendChild(ov);
      let open = true;
      const c = { ov, frame, box, opts: o, openId: 1, isOpen: () => open, still: () => open,
        tryClose(how) { return c.close(true, how); },
        close(force, how) { if (!open) return false; open = false; doc.body.removeChild(ov); if (o.onClosed) o.onClosed(how || '', false); return true; } };
      dialogs.push(c); return c;
    } };
  vm.createContext(sandbox);
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: () => (body === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(body)) });
  const bytes = (name, type, how) => ({ status: 200, ok: true, headers: { get: (h) => (h === 'Content-Disposition' ? (how || 'inline') + '; filename="' + name + '"' : null) }, blob: () => Promise.resolve({ served: true, type }) });
  const w = { doc, win, sandbox, net, tabs, timers, blobs, dialogs, el, find, all, json, bytes,
    listCalls: () => net.filter((c) => c.url === '/api/leads/' + LEAD + '/files'),
    fileCalls: () => net.filter((c) => c.url.indexOf('/api/leads/' + LEAD + '/files/') === 0),
    async answerList(body, status) { const c = w.listCalls().find((x) => !x.done); assert.ok(c, 'a list request is waiting'); c.done = true; c.answer(json(status || 200, body)); await tick(); },
    async failList() { const c = w.listCalls().find((x) => !x.done); assert.ok(c, 'a list request is waiting'); c.done = true; c.fail(); await tick(); },
    dialog() { return dialogs.filter((d) => d.isOpen())[0] || null; },
    rows() { const d = w.dialog(); return d ? all(d.box, (n) => n.className === 'lf-item').map((li) => ({ li, name: find(li, (n) => n.className === 'lf-name').textContent,
      meta: (find(li, (n) => n.className === 'lf-meta') || { textContent: '' }).textContent, btn: find(li, (n) => n.tagName === 'BUTTON'), msg: find(li, (n) => n.className.indexOf('lf-msg') === 0) })) : []; },
    titles() { const d = w.dialog(); return d ? all(d.box, (n) => n.className === 'lf-group-t').map((n) => n.textContent) : []; } };
  return w;
}

// The button alone: the module's own code, as the page gets it.
function alone(opts) {
  const w = world();
  vm.runInContext(LEAD_FILES_UI_JS, w.sandbox);
  w.keys = 0;
  w.api = w.sandbox.tdotLeadFiles(Object.assign({ leadId: LEAD, key: () => { w.keys++; return 'team-key'; }, icons: { clip: '<svg class="clip"></svg>', file: '<svg class="file"></svg>' }, name: () => 'Asha Test' }, opts));
  w.chip = w.api.chip;
  w.doc.body.appendChild(w.chip);
  return w;
}
async function loaded(files, extra) {
  const w = alone();
  w.api.start();
  await w.answerList(Object.assign({ state: 'ok', files }, extra));
  return w;
}

// ── the page-script rules ─────────────────────────────────────────────────
test('the browser code follows the page-script rules: no backtick, no dollar-brace, no backslash; it parses; it is the tested functions', () => {
  for (const [name, s] of [['LEAD_FILES_UI_JS', LEAD_FILES_UI_JS], ['LEAD_FILES_CSS', LEAD_FILES_CSS]]) {
    assert.ok(!s.includes('`'), name + ': no backtick');
    assert.ok(!s.includes('${'), name + ': no dollar-brace');
    assert.ok(!s.includes('\\'), name + ': no backslash');
  }
  new vm.Script(LEAD_FILES_UI_JS);
  for (const fn of [UI.tdotLfSize, UI.tdotLfMeta, UI.tdotLfSaveName, UI.tdotLeadFiles]) assert.ok(LEAD_FILES_UI_JS.includes(fn.toString()), fn.name);
  assert.strictEqual(new Function('return `' + LEAD_FILES_UI_JS + '`')(), LEAD_FILES_UI_JS, 'inside a template literal it comes out unchanged');
  assert.strictEqual(new Function('return `' + LEAD_FILES_CSS + '`')(), LEAD_FILES_CSS);
});

test('lead page: every script parses; the pop-up code, then the button code, then the button — and the page carries its styles', () => {
  const scripts = scriptsOf(html);
  assert.strictEqual(scripts.length, 1);
  scripts.forEach((src) => new vm.Script(src));
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, 'on the page: ' + s); return i; };
  assert.ok(at('function tdotDialogNew(') < at('function tdotLeadFiles(') && at('function tdotLeadFiles(') < at('var LEAD_FILES=null; try{ LEAD_FILES=tdotLeadFiles({ leadId:LEAD_ID, key:getKey,'));
  assert.ok(at('var LEAD_FILES=null;') < at('function render(d){'), 'made before the page first draws');
  assert.strictEqual(html.split('tdotLeadFiles(').length - 1, 2, 'one definition + one use');
  assert.ok(html.includes(LEAD_FILES_CSS), 'the styles');
  // a real paperclip in both icon sets (the old "clip" is a clipboard)
  const icons = JSON.parse(/var ICONS=(\{.*\});/.exec(html)[1]);
  assert.match(icons.paperclip, /^<svg [^>]*><path d="m21\.44 11\.05/);
  assert.notStrictEqual(icons.paperclip, icons.file);
  // the Leads list page is not touched
  const queue = adminLeads.buildLeadsQueueHTML();
  assert.ok(!queue.includes('tdotLeadFiles') && !queue.includes('chip-btn') && !queue.includes('c-att-chip'));
});

test('lead page: the old bottom card is gone — markup, its drawing code and its row style', () => {
  for (const gone of ['c-attach-card', 'id="c-attach"', 'OneDrive · Intake', 'd.attachments', 'file-row']) assert.ok(!html.includes(gone), 'gone: ' + gone);
  assert.ok(html.includes('id="la-att-card"'), 'the staff-only attach card stays');
  assert.ok(html.includes('<div id="c-sections"></div>'), 'the intake sections stay');
});

test('styles: a chip that is a button, a 44px tap area on small and touch screens, long names wrap, the pop-up never prints', () => {
  assert.match(LEAD_FILES_CSS, /\.chip-btn \{[^}]*position:relative;[^}]*border:0;[^}]*font-family:inherit;[^}]*cursor:pointer;/);
  assert.match(LEAD_FILES_CSS, /\.chip-btn:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\) \{ box-shadow:/, 'a hover state, only when it can be clicked');
  assert.match(LEAD_FILES_CSS, /\.chip-btn:disabled, \.chip-btn\[aria-disabled="true"\] \{ cursor:default; opacity:1; \}/, 'greyed by colour, never faded');
  assert.match(LEAD_FILES_CSS, /@media \(max-width:900px\), \(pointer:coarse\) \{\s*\.chip-btn::after \{ content:''; position:absolute; left:0; right:0; top:50%; height:44px; transform:translateY\(-50%\); \}/);
  assert.ok(!/\.chip-btn[^{]*\{[^}]*(?:font-size|padding|background|outline)\s*:/.test(LEAD_FILES_CSS), 'size, colours and the shared focus ring stay the chip\'s and the page\'s own');
  for (const cls of ['lf-name', 'lf-meta', 'lf-msg', 'lf-who']) assert.match(LEAD_FILES_CSS, new RegExp('\\.' + cls + ' \\{[^}]*overflow-wrap:anywhere;'), cls + ' wraps');
  assert.match(LEAD_FILES_CSS, /\.lf-main \{ flex:1 1 auto; min-width:0; \}/);
  assert.match(LEAD_FILES_CSS, /@media \(max-width:560px\) \{ \.tdlg \.lf-open \{ min-height:44px; \} \}/);
  assert.match(LEAD_FILES_CSS, /@media print \{ \.lf-ov \{ display:none !important; \}/);
  // the row the chip sits in wraps, and the header is sticky only on wide screens
  assert.match(html, /\.ctx-meta \{ display:flex; gap:8px; flex-wrap:wrap;/);
  assert.match(html, /@media \(max-width:900px\)\{ \.cols\{[^}]*\} \.ctx\{ position:static; \} \}/);
});

// ── which rule really wins on the page ────────────────────────────────────
// A rule that is only LOOKED for in the text can be dead: the house pop-up's styles come later on the lead
// page and also set a min-height on .tdlg-btn. So the cascade is worked out here from the page as served:
// every rule that sets the property and matches the element, by weight (ids, classes, tags), then by order.
function cssRules(css) {
  const out = []; let order = 0;
  (function walk(text, media) {
    let pos = 0;
    while (pos < text.length) {
      const open = text.indexOf('{', pos); if (open < 0) break;
      let depth = 0, close = open;
      for (; close < text.length; close++) { if (text[close] === '{') depth++; else if (text[close] === '}' && !--depth) break; }
      const head = text.slice(pos, open).split(';').pop().trim(), body = text.slice(open + 1, close);
      if (head.startsWith('@media')) walk(body, (media ? media + ' and ' : '') + head.slice(6).trim());
      else if (!head.startsWith('@')) out.push({ selectors: head.split(',').map((x) => x.trim()).filter(Boolean), body, media, order: order++ });
      pos = close + 1;
    }
  })(String(css).replace(/\/\*[\s\S]*?\*\//g, ''), '');
  return out;
}
/** Does this @media apply on a screen `width` px wide? (print never; a feature this does not know counts as "yes" — a rival too many is the safe side.) */
function mediaApplies(media, width) {
  if (!media) return true;
  if (/\bprint\b/.test(media)) return false;
  for (const m of media.matchAll(/\(\s*(max|min)-width\s*:\s*(\d+)px\s*\)/g)) { if (m[1] === 'max' ? width > +m[2] : width < +m[2]) return false; }
  return true;
}
/** The value of `prop` that wins for the LAST element of `path` ([{ tag, cls: [] }] from <html> down). Plain selectors only (tags, classes, descendant and child); any other kind must not set the property for it to count as checked. */
function winner(css, path, prop, width) {
  const compound = (c, node) => { const tag = (/^(\*|[a-z][a-z0-9]*)/i.exec(c) || [''])[0]; return (!tag || tag === '*' || tag.toLowerCase() === node.tag) && [...c.matchAll(/\.([\w-]+)/g)].every((m) => node.cls.includes(m[1])); };
  const matches = (sel) => {
    const t = sel.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
    const rec = (ti, ni) => {
      if (ni < 0 || !compound(t[ti], path[ni])) return false;
      if (ti === 0) return true;
      if (t[ti - 1] === '>') return rec(ti - 2, ni - 1);
      for (let k = ni - 1; k >= 0; k--) if (rec(ti - 1, k)) return true;
      return false;
    };
    return rec(t.length - 1, path.length - 1);
  };
  let best = null;
  for (const r of cssRules(css)) {
    const decl = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(r.body);
    if (!decl || !mediaApplies(r.media, width)) continue;
    for (const sel of r.selectors) {
      if (/[:\[#+~]/.test(sel)) continue;   // a state, an attribute, an id: none of them sets this property for these buttons (checked below)
      if (!matches(sel)) continue;
      const weight = [0, (sel.match(/\./g) || []).length, (sel.replace(/\.[\w-]+/g, ' ').match(/[a-z][a-z0-9]*/gi) || []).length];
      const cand = { sel, value: decl[1].trim(), key: [/!important/.test(decl[1]) ? 1 : 0, ...weight, r.order] };
      if (!best || cand.key.some((v, i) => v !== best.key[i] && cand.key.slice(0, i).every((x, j) => x === best.key[j]) && v > best.key[i])) best = cand;
    }
  }
  return best;
}
const ROW_BUTTON = [{ tag: 'html', cls: [] }, { tag: 'body', cls: [] }, { tag: 'div', cls: ['tdlg-ov', 'lf-ov'] }, { tag: 'div', cls: ['tdlg', 'lf-dlg'] }, { tag: 'div', cls: ['tdlg-body'] },
  { tag: 'div', cls: ['lf-list'] }, { tag: 'ul', cls: ['lf-group'] }, { tag: 'li', cls: ['lf-item'] }, { tag: 'div', cls: ['lf-row'] }, { tag: 'button', cls: ['tdlg-btn', 'lf-open'] }];

test('lead page as served: on a phone the Open / Download buttons really are 44px tall — the pop-up\'s own later 38px rule does not win', () => {
  const pageCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  // the worked-out cascade is the real one: the rival rule is on the page, AFTER this feature's styles
  const mine = pageCss.indexOf('.tdlg .lf-open { min-height:44px; }'), house = pageCss.search(/\.tdlg-btn,[^{]*\{[^}]*min-height:38px/);
  assert.ok(mine > 0 && house > mine, 'the house rule comes later on the page');
  const phone = winner(pageCss, ROW_BUTTON, 'min-height', 500);
  assert.deepStrictEqual([phone.sel, phone.value], ['.tdlg .lf-open', '44px']);
  assert.strictEqual(winner(pageCss, ROW_BUTTON, 'min-height', 560).value, '44px');
  // wider than a phone: the house size, untouched
  const wide = winner(pageCss, ROW_BUTTON, 'min-height', 561);
  assert.strictEqual(wide.value, '38px'); assert.match(wide.sel, /^\.tdlg-btn$/);
  // the footer's Close was already 44px on a phone (the house rule for the pop-up's own buttons)
  const CLOSE = [...ROW_BUTTON.slice(0, 5), { tag: 'div', cls: ['tdlg-actions'] }, { tag: 'button', cls: ['tdlg-btn'] }];
  assert.strictEqual(winner(pageCss, CLOSE, 'min-height', 500).value, '44px');
  // the check itself: a one-class rule placed before the house rule loses (this is what the page had), and no
  // selector the check skips (a state, an attribute, an id) sets a min-height on these buttons
  const before = pageCss.replace('.tdlg .lf-open { min-height:44px; }', '.lf-open { min-height:44px; }');
  assert.strictEqual(winner(before, ROW_BUTTON, 'min-height', 500).value, '38px');
  for (const r of cssRules(pageCss)) {
    if (!/(?:^|;)\s*min-height\s*:/.test(r.body)) continue;
    for (const sel of r.selectors) if (/[:\[#+~]/.test(sel)) assert.ok(!/tdlg-btn|lf-open|\.tdlg\s+button|\.tdlg\s+\*/.test(sel), sel);
  }
});

// ── small helpers ─────────────────────────────────────────────────────────
test('size, the small line and the save name', () => {
  assert.strictEqual(UI.tdotLfSize(348160), '340 KB');
  assert.strictEqual(UI.tdotLfSize(1258291), '1.2 MB');
  assert.strictEqual(UI.tdotLfSize(200), '1 KB');
  for (const none of [null, undefined, 0, -5, 'x', NaN]) assert.strictEqual(UI.tdotLfSize(none), '');
  assert.strictEqual(UI.tdotLfMeta(LETTER), 'PDF · 1.2 MB');
  assert.strictEqual(UI.tdotLfMeta(SHOT), 'PNG · 340 KB · added by Asha Test · 2026-11-21 10:05');
  assert.strictEqual(UI.tdotLfMeta(PHONE_PIC), 'HEIC · 2 MB · 2026-11-22 09:00', 'no staff name in the stored name: just the time');
  assert.strictEqual(UI.tdotLfMeta({ kind: 'client', ext: 'jpg', size: null }), 'JPG');
  // the same letter twice (this lead's own, and the case folder's): the other copy says where it is from
  assert.strictEqual(UI.tdotLfMeta({ ...LETTER, fromCase: true }), 'PDF · 1.2 MB · from the case folder');
  assert.strictEqual(UI.tdotLfMeta({ ...SHOT, fromCase: true }), 'PNG · 340 KB · added by Asha Test · 2026-11-21 10:05', 'never on a staff file');
  assert.strictEqual(UI.tdotLfSaveName('inline; filename="refusal-letter.pdf"', LETTER), 'refusal-letter.pdf');
  assert.strictEqual(UI.tdotLfSaveName('attachment; filename="phone picture.heic"', PHONE_PIC), 'phone picture.heic');
  assert.strictEqual(UI.tdotLfSaveName('', LETTER), 'attachment.pdf');
  assert.strictEqual(UI.tdotLfSaveName(null, { ext: '../x' }), 'attachment');
  assert.strictEqual(UI.tdotLfSaveName('inline; filename="../..//evil<script>.html"', LETTER), 'evilscript.html.pdf', 'only plain letters survive, and it ends with the real type');
  assert.strictEqual(UI.tdotLfSaveName('inline; filename="no end', LETTER), 'attachment.pdf');
});

// ── the button's four looks ───────────────────────────────────────────────
test('chip: a real button with a paperclip; while checking it is grey, says "Attachments …" and does nothing', async () => {
  const w = alone();
  const c = w.chip;
  assert.strictEqual(c.tagName, 'BUTTON'); assert.strictEqual(c.type, 'button'); assert.strictEqual(c.id, 'c-att-chip');
  assert.strictEqual(c.getAttribute('aria-haspopup'), 'dialog');
  assert.strictEqual(c.children[0].getAttribute('aria-hidden'), 'true');
  assert.strictEqual(c.children[0].children[0].className, 'clip', 'the paperclip');
  assert.strictEqual(c.children[1].className, 'pk'); assert.strictEqual(c.children[1].textContent, 'Attachments');
  assert.strictEqual(c.className, 'chip chip-btn grey');
  assert.strictEqual(c.textContent, 'Attachments …');
  assert.strictEqual(c.getAttribute('aria-busy'), 'true'); assert.strictEqual(c.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(c.disabled, false, 'it keeps the keyboard focus while checking');
  assert.strictEqual(c.title, 'Checking for files…');
  assert.strictEqual(w.net.length, 0, 'nothing is asked until the page says so');
  c.click();
  assert.strictEqual(w.dialogs.length, 0); assert.strictEqual(w.net.length, 0);
  w.api.start();
  assert.strictEqual(w.listCalls().length, 1);
  assert.deepStrictEqual(plain(w.net[0].opts.headers), { 'X-Api-Key': 'team-key' }, 'the team key, in a header');
  assert.strictEqual(w.net[0].opts.cache, 'no-store');
  c.click();
  assert.strictEqual(w.dialogs.length, 0, 'still checking: a click does nothing');
  w.api.start(); w.api.start();
  assert.strictEqual(w.listCalls().length, 1, 'the first look happens once');
});

test('chip: files found — blue "Attachments 2", clickable; one file reads "the file"', async () => {
  const w = await loaded([LETTER, SHOT]);
  assert.strictEqual(w.chip.className, 'chip chip-btn blue');
  assert.strictEqual(w.chip.textContent, 'Attachments 2');
  assert.strictEqual(w.chip.disabled, false);
  assert.strictEqual(w.chip.getAttribute('aria-busy'), null); assert.strictEqual(w.chip.getAttribute('aria-disabled'), null);
  assert.strictEqual(w.chip.title, 'Show the 2 files on this lead');
  const one = await loaded([LETTER]);
  assert.strictEqual(one.chip.textContent, 'Attachments 1'); assert.strictEqual(one.chip.title, 'Show the file on this lead');
});

test('chip: no files — still there, grey "Attachments 0", disabled, and it says why', async () => {
  const w = await loaded([]);
  assert.strictEqual(w.chip.className, 'chip chip-btn grey');
  assert.strictEqual(w.chip.textContent, 'Attachments 0');
  assert.strictEqual(w.chip.disabled, true);
  assert.strictEqual(w.chip.title, 'No files on this lead');
  assert.strictEqual(w.chip.getAttribute('aria-busy'), null);
  w.chip.click();
  assert.strictEqual(w.dialogs.length, 0); assert.strictEqual(w.listCalls().length, 1);
});

test('chip: could not check — amber, never a false 0; a click tries again', async () => {
  const w = alone();
  w.api.start();
  await w.answerList({ state: 'unchecked', files: [], reason: 'storage', message: 'Could not reach the files just now — try again.' });
  assert.strictEqual(w.chip.className, 'chip chip-btn amber');
  assert.strictEqual(w.chip.textContent, 'Attachments — could not check · try again', 'the way out is in the words — a phone has no hover to show the tooltip');
  assert.strictEqual(w.chip.title, 'Click to try again');
  assert.strictEqual(w.chip.disabled, false);
  w.chip.click();
  assert.strictEqual(w.dialogs.length, 0, 'no pop-up: it looks again');
  assert.strictEqual(w.listCalls().length, 2);
  assert.strictEqual(w.chip.textContent, 'Attachments …'); assert.strictEqual(w.chip.className, 'chip chip-btn grey');
  await w.answerList({ state: 'ok', files: [LETTER] });
  assert.strictEqual(w.chip.textContent, 'Attachments 1'); assert.strictEqual(w.chip.className, 'chip chip-btn blue');
});

test('chip: every kind of failed look is "could not check" — a server error, an answer that is not JSON, an odd answer, no connection', async () => {
  for (const how of ['500', 'notjson', 'odd', 'offline', '404']) {
    const w = alone();
    w.api.start();
    const call = w.listCalls()[0];
    if (how === '500') call.answer(w.json(500, { error: 'Could not reach the files just now — try again.' }));
    if (how === '404') call.answer(w.json(404, { error: 'That client could not be found — refresh the page.' }));
    if (how === 'notjson') call.answer(w.json(200, undefined));
    if (how === 'odd') call.answer(w.json(200, { state: 'ok', files: 'none' }));
    if (how === 'offline') call.fail();
    await tick();
    assert.strictEqual(w.chip.textContent, 'Attachments — could not check · try again', how);
    assert.strictEqual(w.chip.className, 'chip chip-btn amber', how);
  }
});

test('chip: the team key is no longer accepted (401 / 403) — back to the sign-in page, like the rest of the page', async () => {
  for (const status of [401, 403]) {
    const w = alone();
    w.api.start();
    w.listCalls()[0].answer(w.json(status, { error: 'Invalid or missing API key' }));
    await tick();
    assert.strictEqual(w.win.location.href, '/admin');
    assert.strictEqual(w.chip.textContent, 'Attachments …', 'no wrong state while the page leaves');
  }
  // no key at all: the page's own getKey sends the person to sign in; nothing is asked
  const w = alone({ key: () => null });
  w.api.start();
  assert.strictEqual(w.net.length, 0);
});

test('chip: an old answer never overwrites a newer one; an entry without a proper key is dropped', async () => {
  const w = alone();
  w.api.start();            // look 1
  w.api.reload();           // look 2 (a staff upload meanwhile)
  const [first, second] = w.listCalls();
  second.answer(w.json(200, { state: 'ok', files: [LETTER, SHOT] })); await tick();
  first.answer(w.json(200, { state: 'ok', files: [] })); await tick();
  assert.strictEqual(w.chip.textContent, 'Attachments 2');
  const odd = await loaded([LETTER, { key: '../../intake-submission.json', label: 'x', kind: 'staff', ext: 'pdf', view: 'tab' }, { label: 'no key' }, null, { key: K4, label: 'page.html', kind: 'staff', ext: 'html', view: 'tab' }]);
  assert.strictEqual(odd.chip.textContent, 'Attachments 2');
  assert.deepStrictEqual(plain(odd.api.state().files).map((f) => [f.key, f.view]), [[K1, 'tab'], [K4, 'download']], 'a type that is not a pdf or picture is never shown in a tab');
});

// ── the chip row on the real page ─────────────────────────────────────────
// The page's own lines, cut out of the page as it is served: the icons, the button code and the line that
// makes the button; then the lines of render() that build the chip row.
function page() {
  const w = world();
  const pills = w.doc.body.appendChild(w.el('div')); pills.id = 'c-pills';
  const a = html.indexOf('var ICONS='), b = html.indexOf('/* The email edit box is easier to find');
  const p1 = html.indexOf("var pills='';"), p2 = html.indexOf("document.getElementById('c-alert').innerHTML=");
  assert.ok(a > 0 && b > a && p1 > b && p2 > p1);
  assert.ok(html.slice(a, b).includes('var LEAD_FILES=null; try{ LEAD_FILES=tdotLeadFiles('), 'the cut holds the line that makes the button');
  assert.ok(html.slice(p1, p2).includes('if(LEAD_FILES) LEAD_FILES.place(attFocus);'), 'the cut holds the line that puts it back');
  w.keys = 0;
  w.sandbox.getKey = () => { w.keys++; return 'team-key'; };
  vm.runInContext('var LEAD_ID=' + JSON.stringify(LEAD) + ', LEAD_DETAIL=null;\n' + html.slice(a, b) + '\nfunction drawRow(d){ LEAD_DETAIL=d;\n' + html.slice(p1, p2) + '\n}', w.sandbox);
  w.api = vm.runInContext('LEAD_FILES', w.sandbox);
  assert.ok(w.api, 'the page made the button');
  w.chip = w.api.chip;
  w.render = (d) => w.sandbox.drawRow(Object.assign({ leadId: LEAD, name: 'Asha Test', createdWhen: '2026-11-20 10:00', bookingStatus: 'Not Yet' }, d));
  w.row = () => pills.children.map((c) => c.textContent.trim());
  w.pills = pills;
  return w;
}

test('chip row: the button sits right after Priority — and in that same place when there is no Priority, or no Tier either', () => {
  const w = page();
  w.render({ tier: 'A', priority: 'High', wantsTo: 'Request a quote', consultant: 'Sam Example', flags: ['Deadline in 5 days'] });
  assert.deepStrictEqual(w.row(), ['Received 2026-11-20 10:00 (Toronto)', 'Booking Not Yet', 'Tier A', 'Priority High', 'Attachments …', 'Asked for Request a quote', 'Sam Example', 'URGENT']);
  assert.strictEqual(w.pills.children[4], w.chip);
  assert.strictEqual(w.chip.tagName, 'BUTTON');
  assert.ok(w.pills.children.every((c, i) => (i === 4) === (c.tagName === 'BUTTON')), 'the other chips stay plain labels');
  assert.strictEqual(w.doc.getElementById('c-att-slot'), null, 'the slot marker is gone once the button is in');
  w.render({ tier: 'B', wantsTo: 'Request a quote', consultant: 'Sam Example' });
  assert.deepStrictEqual(w.row(), ['Received 2026-11-20 10:00 (Toronto)', 'Booking Not Yet', 'Tier B', 'Attachments …', 'Asked for Request a quote', 'Sam Example']);
  w.render({ priority: 'Critical' });
  assert.deepStrictEqual(w.row(), ['Received 2026-11-20 10:00 (Toronto)', 'Booking Not Yet', 'Priority Critical', 'Attachments …']);
  w.render({});
  assert.deepStrictEqual(w.row(), ['Received 2026-11-20 10:00 (Toronto)', 'Booking Not Yet', 'Attachments …'], 'a staff-added lead with nothing else: still there, after Booking');
  assert.strictEqual(w.net.length, 0, 'drawing the row never asks the server for the files');
});

test('chip row: a re-render keeps the same button, its count, the keyboard focus and an open pop-up — and never looks the files up again', async () => {
  const w = page();
  w.render({ priority: 'High' });
  w.api.start();
  await w.answerList({ state: 'ok', files: [LETTER, SHOT] });
  assert.deepStrictEqual(w.row().slice(2), ['Priority High', 'Attachments 2']);
  w.chip.focus();
  w.render({ priority: 'High', consultant: 'Sam Example' });   // the page loaded the lead again after a save
  assert.strictEqual(w.pills.children[3], w.chip, 'the very same button');
  assert.deepStrictEqual(w.row().slice(2), ['Priority High', 'Attachments 2', 'Sam Example']);
  assert.strictEqual(w.doc.activeElement, w.chip, 'focus stays on it');
  assert.strictEqual(w.listCalls().length, 1);
  w.chip.click();
  const dlg = w.dialog();
  assert.ok(dlg && dlg.ov.parentNode === w.doc.body, 'the pop-up hangs on the page body, not in the chip row');
  assert.ok(!w.pills.contains(dlg.ov));
  w.doc.activeElement = dlg.frame;
  w.render({ priority: 'Critical' });
  assert.strictEqual(w.dialog(), dlg, 'still open');
  assert.strictEqual(w.rows().length, 2);
  assert.strictEqual(w.doc.activeElement, dlg.frame, 'focus is not pulled out of the pop-up');
  assert.deepStrictEqual(w.row().slice(2), ['Priority Critical', 'Attachments 2']);
  // a re-render while the first look is still running keeps "checking", and the answer lands on the same button
  const v = page();
  v.render({});
  v.api.start();
  v.render({ priority: 'High' });
  assert.deepStrictEqual(v.row().slice(2), ['Priority High', 'Attachments …']);
  await v.answerList({ state: 'ok', files: [] });
  assert.deepStrictEqual(v.row().slice(2), ['Priority High', 'Attachments 0']);
  assert.strictEqual(v.pills.children[3].disabled, true);
});

test('lead page: the files are looked up once, after the first successful load — not on later re-loads', async () => {
  const a = html.indexOf('\nfunction load(){\n  var key=getKey();'), b = html.indexOf('// Address box:');   // the page's own load (the Updates box has one of its own, further up)
  assert.ok(a > 0 && b > a);
  const src = html.slice(a, b);
  assert.ok(src.includes("document.getElementById('content').style.display='block';\n     if(LEAD_FILES) LEAD_FILES.start();"), 'after the page is shown');
  const w = alone();
  for (const id of ['loading', 'content', 'error-msg']) { const n = w.doc.body.appendChild(w.el('div')); n.id = id; }
  let renders = 0;
  Object.assign(w.sandbox, { LEAD_ID: LEAD, LEAD_FILES: w.api, getKey: () => 'team-key', render: () => { renders++; } });
  vm.runInContext(src, w.sandbox);
  const leadCalls = () => w.net.filter((c) => c.url === '/api/lead/' + LEAD);
  w.sandbox.load();
  assert.strictEqual(w.listCalls().length, 0, 'not before the lead itself is there');
  leadCalls()[0].answer(w.json(200, { leadId: LEAD })); await tick();
  assert.strictEqual(renders, 1); assert.strictEqual(w.listCalls().length, 1);
  w.sandbox.load();   // after a save
  leadCalls()[1].answer(w.json(200, { leadId: LEAD })); await tick();
  assert.strictEqual(renders, 2); assert.strictEqual(w.listCalls().length, 1, 'no second look');
  // a lead that fails to load never asks for files
  const x = alone();
  for (const id of ['loading', 'content', 'error-msg']) { const n = x.doc.body.appendChild(x.el('div')); n.id = id; }
  Object.assign(x.sandbox, { LEAD_ID: LEAD, LEAD_FILES: x.api, getKey: () => 'team-key', render: () => {} });
  vm.runInContext(src, x.sandbox);
  x.sandbox.load();
  x.net[0].answer(w.json(404, { error: 'x' })); await tick();
  assert.strictEqual(x.listCalls().length, 0);
  assert.strictEqual(x.doc.getElementById('error-msg').textContent, 'Failed to load: Lead not found.');
});

test('staff upload: the text points to "Attachments" at the top, and the count is looked up again — only when something was attached', async () => {
  const a = html.indexOf("document.getElementById('btn-la-att').onclick=function(){"), b = html.indexOf('var BD_LOADED=');
  assert.ok(a > 0 && b > a);
  assert.ok(!html.includes('the link is in the updates below'), 'the old text is gone');
  async function attach(result) {
    const w = await loaded([LETTER]);
    const btn = w.doc.body.appendChild(w.el('button')); btn.id = 'btn-la-att';
    const said = [];
    let updates = 0;
    w.win.tdotUpdatesReload_updw = () => { updates++; };
    Object.assign(w.sandbox, { LEAD_ID: LEAD, LEAD_FILES: w.api,
      LA_ATT: { check: () => '', files: () => [{ name: 'x.png' }], reset() {}, setStatus: (t, cls) => said.push([t, cls]), upload: () => Promise.resolve(result) } });
    vm.runInContext(html.slice(a, b), w.sandbox);
    btn.click();
    await tick();
    return { w, said, updates };
  }
  const one = await attach({ sent: 1, failed: [] });
  assert.deepStrictEqual(one.said, [['1 attached — open "Attachments" at the top of this page to see it.', 'ok']]);
  assert.strictEqual(one.w.listCalls().length, 2, 'the list is asked for again');
  assert.strictEqual(one.w.chip.textContent, 'Attachments …');
  await one.w.answerList({ state: 'ok', files: [LETTER, SHOT] });
  assert.strictEqual(one.w.chip.textContent, 'Attachments 2', 'the count went up without a page refresh');
  assert.strictEqual(one.updates, 1, 'the Updates box is still refreshed');
  const three = await attach({ sent: 3, failed: [] });
  assert.deepStrictEqual(three.said, [['3 attached — open "Attachments" at the top of this page to see them.', 'ok']]);
  const part = await attach({ sent: 1, failed: [{ name: 'big.pdf', error: 'too big' }] });
  assert.strictEqual(part.said[0][1], 'err'); assert.match(part.said[0][0], /^1 attached; 1 not attached: big\.pdf \(too big\)\./);
  assert.strictEqual(part.w.listCalls().length, 2, 'one file did go in: look again');
  const none = await attach({ sent: 0, failed: [{ name: 'big.pdf', error: 'too big' }] });
  assert.strictEqual(none.w.listCalls().length, 1, 'nothing attached: nothing to look up');
  assert.strictEqual(none.w.chip.textContent, 'Attachments 1');
});

// ── the pop-up ────────────────────────────────────────────────────────────
test('pop-up: the house pop-up — title, the lead\'s name, two groups, one row per file, Close; opening it looks again quietly', async () => {
  const w = await loaded([LETTER, SHOT, PHONE_PIC]);
  w.chip.click();
  const d = w.dialog();
  assert.ok(d, 'open');
  assert.deepStrictEqual({ cls: d.opts.cls, ovClass: d.opts.ovClass, labelledBy: d.opts.labelledBy, group: d.opts.group }, { cls: 'lf-dlg', ovClass: 'lf-ov', labelledBy: 'lf-title', group: 'lf' });
  const kids = d.box.children;
  assert.strictEqual(kids[0].tagName, 'H3'); assert.strictEqual(kids[0].textContent, 'Attachments'); assert.strictEqual(kids[0].id, 'lf-title');
  assert.strictEqual(kids[1].className, 'lf-who'); assert.strictEqual(kids[1].textContent, 'Files for Asha Test');
  const acts = kids[kids.length - 1];
  assert.strictEqual(acts.className, 'tdlg-actions');
  assert.deepStrictEqual(acts.children.map((b) => [b.tagName, b.type, b.textContent, b.getAttribute('data-x')]), [['BUTTON', 'button', 'Close', '1']]);
  assert.deepStrictEqual(w.titles(), ['From the client’s form', 'Added by staff']);
  assert.deepStrictEqual(w.rows().map((r) => [r.name, r.meta, r.btn.textContent, r.btn.getAttribute('aria-label')]), [
    ['Refusal letter', 'PDF · 1.2 MB', 'Open', 'Open Refusal letter'],
    ['passport scan.png', 'PNG · 340 KB · added by Asha Test · 2026-11-21 10:05', 'Open', 'Open passport scan.png'],
    ['phone picture.heic', 'HEIC · 2 MB · 2026-11-22 09:00', 'Download', 'Download phone picture.heic'],
  ]);
  assert.deepStrictEqual(w.rows().map((r) => r.btn.title), ['Opens in a new tab', 'Opens in a new tab', 'This kind of file does not open in the browser — it is saved to your computer.']);
  assert.ok(w.rows().every((r) => r.btn.type === 'button' && r.msg.hidden === true && r.li.children[0].children[0].children[0].className === 'file'), 'a file icon, a button, no message yet');
  // it looked again, without touching what is shown
  assert.strictEqual(w.listCalls().length, 2);
  assert.strictEqual(w.chip.textContent, 'Attachments 3');
  w.chip.click();
  assert.strictEqual(w.dialogs.length, 1, 'a second click does not open a second pop-up');
  acts.children[0].click();
  assert.strictEqual(w.dialog(), null, 'Close closes it');
  w.chip.click();
  assert.strictEqual(w.dialogs.length, 2); assert.strictEqual(w.rows().length, 3, 'and it opens again');
});

test('pop-up: only the group that has files is shown; a name with HTML in it stays plain text; no name → "Files on this lead"', async () => {
  const w = await loaded([LETTER]);
  w.chip.click();
  assert.deepStrictEqual(w.titles(), ['From the client’s form']);
  const s = alone({ name: () => '' });
  s.api.start();
  await s.answerList({ state: 'ok', files: [Object.assign({}, SHOT, { label: '<img src=x onerror=alert(1)>.png', addedBy: '<b>x</b>' })] });
  s.chip.click();
  assert.deepStrictEqual(s.titles(), ['Added by staff']);
  assert.strictEqual(s.dialog().box.children[1].textContent, 'Files on this lead');
  const r = s.rows()[0];
  assert.strictEqual(r.name, '<img src=x onerror=alert(1)>.png');
  assert.strictEqual(r.li.children[0].children[1].children[0].children.length, 0, 'written as text: no element was made from the name');
  assert.ok(r.meta.includes('added by <b>x</b>'));
});

test('pop-up: the quiet look on opening — a changed list is drawn (and the count follows); the same list leaves the rows alone; a failed look changes nothing', async () => {
  const w = await loaded([LETTER, SHOT]);
  const reopen = () => { w.dialog().tryClose('x'); w.chip.click(); };
  w.chip.click();
  const firstRow = w.rows()[0].li;
  await w.answerList({ state: 'ok', files: [LETTER, SHOT] });
  assert.strictEqual(w.rows()[0].li, firstRow, 'nothing changed: nothing redrawn');
  reopen();
  await w.answerList({ state: 'ok', files: [LETTER] });   // the staff file was removed meanwhile
  assert.deepStrictEqual(w.rows().map((r) => r.name), ['Refusal letter']);
  assert.strictEqual(w.chip.textContent, 'Attachments 1');
  reopen();
  await w.answerList({ state: 'unchecked', files: [], reason: 'storage' });
  assert.deepStrictEqual(w.rows().map((r) => r.name), ['Refusal letter'], 'the list stays');
  assert.strictEqual(w.chip.textContent, 'Attachments 1', 'and so does the count');
  assert.strictEqual(w.chip.className, 'chip chip-btn blue');
  reopen();
  await w.failList();
  assert.strictEqual(w.chip.textContent, 'Attachments 1');
  assert.strictEqual(w.rows().length, 1);
  // every file gone meanwhile: the open box says so, the chip goes to 0
  reopen();
  await w.answerList({ state: 'ok', files: [] });
  assert.strictEqual(w.chip.textContent, 'Attachments 0');
  assert.strictEqual(w.chip.disabled, true);
  assert.strictEqual(w.rows().length, 0);
  assert.strictEqual(w.find(w.dialog().box, (n) => n.className === 'lf-empty').textContent, 'No files on this lead.');
});

test('pop-up: the same letter twice — this lead\'s own first, the other row says "from the case folder" (in its line and for a screen reader)', async () => {
  const OTHER_COPY = { ...LETTER, key: K4, size: 348160, fromCase: true };
  const w = await loaded([LETTER, OTHER_COPY, { ...SHOT, fromCase: true }]);
  assert.strictEqual(w.chip.textContent, 'Attachments 3');
  w.chip.click();
  assert.deepStrictEqual(w.rows().map((r) => [r.name, r.meta, r.btn.getAttribute('aria-label')]), [
    ['Refusal letter', 'PDF · 1.2 MB', 'Open Refusal letter'],
    ['Refusal letter', 'PDF · 340 KB · from the case folder', 'Open Refusal letter (from the case folder)'],
    ['passport scan.png', 'PNG · 340 KB · added by Asha Test · 2026-11-21 10:05', 'Open passport scan.png'],
  ]);
  assert.deepStrictEqual(plain(w.api.state().files).map((f) => f.fromCase), [false, true, false], 'only a client letter can carry the mark');
});

test('pop-up: "there may be more" is said when the case folder could not be checked', async () => {
  const w = await loaded([SHOT], { partial: true });
  assert.strictEqual(w.chip.textContent, 'Attachments 1');
  w.chip.click();
  const note = w.find(w.dialog().box, (n) => n.className === 'lf-note');
  assert.strictEqual(note.textContent, 'There may be more files than these: the client’s case folder could not be checked just now. Close this box and open Attachments again in a minute.');
  assert.strictEqual(note.getAttribute('role'), 'status');
  const full = await loaded([SHOT]);
  full.chip.click();
  assert.strictEqual(full.find(full.dialog().box, (n) => n.className === 'lf-note'), null);
});

// ── opening a file ────────────────────────────────────────────────────────
test('open: the tab is opened inside the click, the bytes are fetched with the team key, the tab is pointed at them', async () => {
  const w = await loaded([LETTER, SHOT]);
  w.chip.click();
  const r = w.rows()[0];
  r.btn.click();
  // all of this before any answer has come back
  assert.strictEqual(w.tabs.length, 1, 'the tab is opened at once — inside the click');
  assert.deepStrictEqual([w.tabs[0].url, w.tabs[0].target], ['', '_blank']);
  assert.strictEqual(w.tabs[0].opener, null, 'the new tab cannot reach back into the page');
  assert.strictEqual(w.tabs[0].document.body.textContent, 'Opening the file…');
  assert.strictEqual(r.btn.disabled, true); assert.strictEqual(r.btn.textContent, 'Opening…');
  const call = w.fileCalls()[0];
  assert.strictEqual(call.url, '/api/leads/' + LEAD + '/files/' + K1, 'the address holds the lead id and the key — never a file name');
  assert.deepStrictEqual(plain(call.opts.headers), { 'X-Api-Key': 'team-key' });
  r.btn.click(); r.btn.click();
  assert.strictEqual(w.fileCalls().length, 1, 'one opening at a time per file');
  assert.strictEqual(w.tabs.length, 1);
  // another file can be opened meanwhile
  w.rows()[1].btn.click();
  assert.strictEqual(w.fileCalls().length, 2); assert.strictEqual(w.tabs.length, 2);
  call.answer(w.bytes('refusal-letter.pdf', 'text/html'));
  await tick();
  assert.strictEqual(w.blobs.length, 1);
  assert.strictEqual(w.blobs[0].blob.type, 'application/pdf', 'the type comes from the fixed list by extension — whatever the answer said');
  assert.strictEqual(w.blobs[0].blob.parts.length, 1); assert.strictEqual(w.blobs[0].blob.parts[0].served, true, 'the very bytes that were fetched');
  assert.strictEqual(w.tabs[0].location.href, 'blob:test/1');
  assert.strictEqual(w.tabs[0].closed, false);
  assert.strictEqual(r.btn.disabled, false); assert.strictEqual(r.btn.textContent, 'Open');
  assert.strictEqual(r.msg.hidden, true);
  assert.strictEqual(w.rows()[1].btn.textContent, 'Opening…', 'the other file is still on its way');
  assert.strictEqual(w.all(w.doc.body, (n) => n.tagName === 'A').length, 0, 'no download');
  // the bytes are let go two minutes later
  const later = w.timers.filter((t) => t.ms === 120000);
  assert.strictEqual(later.length, 1); assert.strictEqual(w.blobs[0].revoked, false);
  later[0].f();
  assert.strictEqual(w.blobs[0].revoked, true);
  // a quiet look that lands while a file is being opened does not redraw the list under it
  const second = w.rows()[1].li;
  await w.answerList({ state: 'ok', files: [SHOT] });
  assert.strictEqual(w.rows()[1].li, second);
  assert.strictEqual(w.chip.textContent, 'Attachments 1');
});

test('open: the browser blocked the new tab — the file is saved instead, and the row says so', async () => {
  const w = await loaded([LETTER]);
  w.win.blockTabs = true;
  w.chip.click();
  const r = w.rows()[0];
  r.btn.click();
  assert.deepStrictEqual(w.tabs, [null]);
  assert.strictEqual(r.btn.textContent, 'Opening…');
  w.fileCalls()[0].answer(w.bytes('refusal-letter.pdf', 'application/pdf'));
  await tick();
  const links = w.all(w.doc.body, (n) => n.tagName === 'A');
  assert.strictEqual(links.length, 1);
  assert.deepStrictEqual([links[0].href, links[0].download, links[0].rel, links[0].clicks, links[0].style.display], ['blob:test/1', 'refusal-letter.pdf', 'noopener', 1, 'none']);
  assert.strictEqual(r.msg.hidden, false);
  assert.strictEqual(r.msg.textContent, 'The file could not be shown in a new tab, so it was saved to your computer instead — look in your downloads.');
  assert.strictEqual(r.msg.getAttribute('role'), 'status'); assert.strictEqual(r.msg.className, 'lf-msg');
  assert.strictEqual(r.btn.disabled, false); assert.strictEqual(r.btn.textContent, 'Open');
  w.timers.filter((t) => t.ms === 2000).forEach((t) => t.f());
  assert.strictEqual(w.all(w.doc.body, (n) => n.tagName === 'A').length, 0, 'the helper link is taken away');
  // a tab the person closed while the file was on its way: the same
  const v = await loaded([LETTER]);
  v.chip.click();
  v.rows()[0].btn.click();
  v.tabs[0].closed = true;
  v.fileCalls()[0].answer(v.bytes('refusal-letter.pdf', 'application/pdf'));
  await tick();
  assert.strictEqual(v.all(v.doc.body, (n) => n.tagName === 'A').length, 1);
  assert.strictEqual(v.rows()[0].msg.getAttribute('role'), 'status');
});

test('open: a HEIC picture is saved, not shown — no tab is opened', async () => {
  const w = await loaded([PHONE_PIC]);
  w.chip.click();
  const r = w.rows()[0];
  r.btn.click();
  assert.strictEqual(w.tabs.length, 0);
  assert.strictEqual(r.btn.textContent, 'Downloading…'); assert.strictEqual(r.btn.disabled, true);
  w.fileCalls()[0].answer(w.bytes('phone picture.heic', 'image/heic', 'attachment'));
  await tick();
  const link = w.all(w.doc.body, (n) => n.tagName === 'A')[0];
  assert.deepStrictEqual([link.download, link.clicks], ['phone picture.heic', 1]);
  assert.strictEqual(w.blobs[0].blob.type, 'image/heic');
  assert.strictEqual(r.msg.hidden, true, 'nothing to explain: it was a download from the start');
  assert.strictEqual(r.btn.textContent, 'Download'); assert.strictEqual(r.btn.disabled, false);
});

test('open: a refusal — the tab is closed, the server\'s own words are shown under the file, the button works again', async () => {
  const cases = [
    [404, { error: 'That file is not there any more — close this box and open Attachments again.' }, 'That file is not there any more — close this box and open Attachments again.'],
    [503, { error: 'Could not reach the files just now — try again.' }, 'Could not reach the files just now — try again.'],
    [429, { error: 'Too many files are being opened at once — wait a moment and try again.' }, 'Too many files are being opened at once — wait a moment and try again.'],
    [413, { error: 'That file is too big to open here — ask an admin to open it in OneDrive.' }, 'That file is too big to open here — ask an admin to open it in OneDrive.'],
    [502, undefined, 'Could not open the file (error 502) — try again.'],
    [500, {}, 'Could not open the file (error 500) — try again.'],
  ];
  for (const [status, body, shown] of cases) {
    const w = await loaded([LETTER]);
    w.chip.click();
    const r = w.rows()[0];
    r.btn.click();
    w.fileCalls()[0].answer(w.json(status, body));
    await tick();
    assert.strictEqual(w.tabs[0].closed, true, status + ': the blank tab is closed');
    assert.strictEqual(r.msg.textContent, shown);
    assert.strictEqual(r.msg.getAttribute('role'), 'alert'); assert.strictEqual(r.msg.hidden, false); assert.strictEqual(r.msg.className, 'lf-msg err');
    assert.strictEqual(r.btn.disabled, false); assert.strictEqual(r.btn.textContent, 'Open');
    assert.strictEqual(w.blobs.length, 0);
    assert.strictEqual(w.win.location.href, '/admin/lead/' + LEAD, 'the page stays');
    // trying again clears the message and can succeed
    r.btn.click();
    assert.strictEqual(r.msg.hidden, true); assert.strictEqual(r.msg.textContent, ''); assert.strictEqual(r.msg.getAttribute('role'), null);
    w.fileCalls()[1].answer(w.bytes('refusal-letter.pdf', 'application/pdf'));
    await tick();
    assert.strictEqual(w.tabs[1].location.href, 'blob:test/1');
    assert.strictEqual(r.msg.hidden, true);
  }
});

test('open: no connection — plain words, the tab closed; the team key refused — back to the sign-in page', async () => {
  const w = await loaded([LETTER]);
  w.chip.click();
  const r = w.rows()[0];
  r.btn.click();
  w.fileCalls()[0].fail();
  await tick();
  assert.strictEqual(w.tabs[0].closed, true);
  assert.strictEqual(r.msg.textContent, 'Could not reach the server — try again.');
  assert.strictEqual(r.msg.getAttribute('role'), 'alert');
  assert.strictEqual(r.btn.disabled, false); assert.strictEqual(r.btn.textContent, 'Open');
  for (const status of [401, 403]) {
    const v = await loaded([LETTER]);
    v.chip.click();
    const row = v.rows()[0];
    row.btn.click();
    v.fileCalls()[0].answer(v.json(status, { error: 'Invalid or missing API key' }));
    await tick();
    assert.strictEqual(v.tabs[0].closed, true);
    assert.strictEqual(v.win.location.href, '/admin');
    assert.strictEqual(row.msg.hidden, true, 'no error text: the page is leaving');
  }
});

test('open: closing the pop-up while a file is on its way is safe — the tab still gets the file', async () => {
  const w = await loaded([LETTER]);
  w.chip.click();
  w.rows()[0].btn.click();
  w.dialog().tryClose('x');
  w.fileCalls()[0].answer(w.bytes('refusal-letter.pdf', 'application/pdf'));
  await tick();
  assert.strictEqual(w.tabs[0].location.href, 'blob:test/1');
  w.chip.click();
  assert.strictEqual(w.rows()[0].btn.disabled, false, 'a fresh row in the next opening');
  await w.answerList({ state: 'ok', files: [] });
  await w.answerList({ state: 'ok', files: [LETTER, SHOT] });
  assert.strictEqual(w.rows().length, 2, 'and the list follows the newest look again');
});
