'use strict';

// A very small DOM for exercising the browser-side questionnaire engine
// helpers in Node (no jsdom in this repo). Supports what the engine code
// touches: tag/class/attribute selectors (single compound selectors joined by
// commas, descendant matching only), classList, style, children / childNodes /
// parentElement / siblings, textContent, value / checked / type / name,
// closest, contains, cloneNode, remove, createElement / createTextNode /
// appendChild / insertBefore, addEventListener / dispatchEvent, and a
// window.getComputedStyle that models the forms' stylesheet rules.
// parseHtml() builds this DOM from a real form file (2026-10-24), so the
// multi-member engine can be run offline against the questionnaires as shipped.

class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentElement = null; }
  get parentNode() { return this.parentElement; }
  get tagName() { return undefined; }
  cloneNode() { return new TextNode(this.textContent); }
  _detach() { if (this.parentElement) { const n = this.parentElement._nodes; const i = n.indexOf(this); if (i !== -1) n.splice(i, 1); this.parentElement = null; } }
}

class El {
  constructor(tag, opts = {}) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.tag = String(tag).toLowerCase();
    this.classes = new Set(opts.cls || []);
    this.attrs = { ...(opts.attrs || {}) };
    if (opts.type) this.attrs.type = opts.type;
    if (opts.name) this.attrs.name = opts.name;
    this.id = opts.id || '';
    this.style = { display: opts.display || '' };
    this._nodes = [];
    this.parentElement = null;
    if (opts.text) this._nodes.push(Object.assign(new TextNode(opts.text), { parentElement: this }));
    this.value = opts.value == null ? '' : opts.value;
    this.checked = !!opts.checked;
    this._listeners = {};
    this.classList = {
      contains: (c) => this.classes.has(c), add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c),
      toggle: (c, force) => { const on = force === undefined ? !this.classes.has(c) : !!force; if (on) this.classes.add(c); else this.classes.delete(c); return on; },
    };
  }
  get type() { return this.attrs.type || (this.tag === 'input' ? 'text' : ''); }
  get name() { return this.attrs.name || ''; }
  set name(v) { this.attrs.name = String(v); }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get children() { return this._nodes.filter((n) => n.nodeType === 1); }
  set children(list) { this._nodes = list.slice(); for (const c of list) c.parentElement = this; }
  get childNodes() { return this._nodes.slice(); }
  get parentNode() { return this.parentElement; }
  /** The element's own text (direct text nodes) — kept for tests that built elements with { text }. */
  get text() { return this._nodes.filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''); }
  set text(v) { this._nodes = this._nodes.filter((n) => n.nodeType !== 3); if (String(v)) this._nodes.unshift(Object.assign(new TextNode(v), { parentElement: this })); }
  get textContent() { return this._nodes.map((n) => n.textContent).join(''); }
  set textContent(v) { for (const n of this._nodes) n.parentElement = null; this._nodes = []; if (String(v)) this._nodes.push(Object.assign(new TextNode(v), { parentElement: this })); }
  get firstChild() { return this._nodes[0] || null; }
  get nextSibling() { const p = this.parentElement; if (!p) return null; const i = p._nodes.indexOf(this); return p._nodes[i + 1] || null; }
  get nextElementSibling() { const p = this.parentElement; if (!p) return null; const c = p.children; const i = c.indexOf(this); return c[i + 1] || null; }
  get previousElementSibling() { const p = this.parentElement; if (!p) return null; const c = p.children; const i = c.indexOf(this); return i > 0 ? c[i - 1] : null; }
  getAttribute(n) {
    if (n === 'id') return this.id || null;
    if (n === 'class') return this.classes.size ? this.className : null;
    if (n === 'type') return this.attrs.type == null ? null : this.attrs.type;
    return this.attrs[n] == null ? null : this.attrs[n];
  }
  setAttribute(n, v) {
    if (n === 'id') { this.id = String(v); return; }
    if (n === 'class') { this.className = String(v); return; }
    this.attrs[n] = String(v);
  }
  hasAttribute(n) { return this.getAttribute(n) !== null; }
  removeAttribute(n) { if (n === 'id') this.id = ''; else if (n === 'class') this.classes.clear(); else delete this.attrs[n]; }
  get attributes() { const out = Object.entries(this.attrs).map(([name, value]) => ({ name, value })); if (this.id) out.push({ name: 'id', value: this.id }); if (this.classes.size) out.push({ name: 'class', value: this.className }); return out; }
  replaceChild(newChild, oldChild) { const i = this._nodes.indexOf(oldChild); if (i === -1) throw new Error('not a child'); newChild._detach(); newChild.parentElement = this; this._nodes[i] = newChild; oldChild.parentElement = null; return oldChild; }
  _detach() { if (this.parentElement) { const n = this.parentElement._nodes; const i = n.indexOf(this); if (i !== -1) n.splice(i, 1); this.parentElement = null; } }
  remove() { this._detach(); }
  add(child) { return this.appendChild(child); }
  appendChild(child) { child._detach(); child.parentElement = this; this._nodes.push(child); return child; }
  insertBefore(child, ref) {
    child._detach();
    child.parentElement = this;
    const i = ref ? this._nodes.indexOf(ref) : -1;
    if (i === -1) this._nodes.push(child); else this._nodes.splice(i, 0, child);
    return child;
  }
  cloneNode(deep) {
    const c = new El(this.tag, { cls: [...this.classes], attrs: { ...this.attrs }, id: this.id, value: this.value, checked: this.checked });
    c.style = { ...this.style };
    if (deep) for (const n of this._nodes) { const k = n.cloneNode(true); k.parentElement = c; c._nodes.push(k); }
    return c;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) { ev.target = ev.target || this; for (const fn of (this._listeners[ev.type] || [])) fn.call(this, ev); return true; }
  _matches(sel) {
    sel = sel.trim();
    /* ":checked" pseudo — the engine reads radio groups with it */
    if (sel.endsWith(':checked')) { if (!this.checked) return false; sel = sel.slice(0, -8); }
    const m = /^([a-zA-Z0-9]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(sel);
    if (!m) return false;
    if (m[1] && this.tag !== m[1].toLowerCase()) return false;
    const parts = m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
    for (const p of parts) {
      if (p[0] === '.') { if (!this.classes.has(p.slice(1))) return false; }
      else if (p[0] === '#') { if (this.id !== p.slice(1)) return false; }
      else {
        const a = /^\[([\w-]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\]$/.exec(p);
        if (!a) return false;
        const actual = a[1] === 'type' ? this.type : this.getAttribute(a[1]);
        if (a[3] === undefined) { if (actual == null) return false; }
        else if (a[2] === '*') { if (actual == null || String(actual).indexOf(a[3]) === -1) return false; }
        else if (a[2] === '^') { if (actual == null || !String(actual).startsWith(a[3])) return false; }
        else if (a[2] === '$') { if (actual == null || !String(actual).endsWith(a[3])) return false; }
        else if (String(actual) !== a[3]) return false;
      }
    }
    return true;
  }
  _all(out) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  /* "thead th" / "tbody tr": descendant combinators — the last compound must match
     the element, each earlier one some ancestor, right to left; "td > input":
     the child combinator wants the parent itself. */
  _matchesComplex(sel) {
    const tokens = sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
    const compounds = [], combinators = [];          // combinators[i]: between compounds[i] and compounds[i+1]
    for (const tk of tokens) { if (tk === '>') combinators[compounds.length - 1] = '>'; else { compounds.push(tk); combinators.push(' '); } }
    if (!this._matches(compounds[compounds.length - 1])) return false;
    let n = this.parentElement;
    for (let i = compounds.length - 2; i >= 0; i--) {
      if (combinators[i] === '>') { if (!n || !n._matches(compounds[i])) return false; }
      else { while (n && !n._matches(compounds[i])) n = n.parentElement; if (!n) return false; }
      n = n.parentElement;
    }
    return true;
  }
  matches(sel) { return sel.split(',').some((p) => this._matchesComplex(p)); }
  querySelectorAll(sel) { const parts = sel.split(','); return this._all([]).filter((e) => parts.some((p) => e._matchesComplex(p))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { const parts = sel.split(','); let n = this; while (n) { if (parts.some((p) => n._matches(p))) return n; n = n.parentElement; } return null; }
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
}

// The forms' stylesheet: class-hidden wrappers open with .open / .visible;
// collapsed accordion bodies are display:none.
function cssOf(n) {
  if (n.style.display) return n.style.display;
  const hiddenUnlessOpen = ['conditional-block', 'refusal-block', 'top-accordion-body', 'sub-accordion-body', 'accordion-body'];
  if (hiddenUnlessOpen.some((c) => n.classes.has(c)) && !n.classes.has('open')) return 'none';
  if ((n.classes.has('conditional') || n.classes.has('refusal-details')) && !n.classes.has('visible')) return 'none';
  return 'block';
}

function documentFor(body) {
  const document = {
    body,
    nodeType: 9,
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    getElementById: (id) => body._all([]).find((e) => e.id === id) || null,
    createElement: (tag) => new El(tag),
    createTextNode: (t) => new TextNode(t),
    addEventListener: () => {},
  };
  const window = { getComputedStyle: (n) => ({ display: cssOf(n) }), document };
  class Event { constructor(type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles); } }
  return { El, TextNode, body, document, window, Event };
}

function fakeDom() { return documentFor(new El('body')); }

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
  });
}

/**
 * Parse a form file into this DOM: tags, attributes, text, void elements;
 * <script> / <style> / comments / doctype are dropped (the engine never reads
 * them, tests evaluate the engine's own source instead). Returns the same
 * shape as fakeDom() with `body` = the file's <body> (or the whole tree when it
 * has none) and `html` = the root. Tolerant: a stray closing tag is ignored, an
 * unclosed element is closed by its ancestor's end tag.
 */
function parseHtml(html) {
  const root = new El('html');
  const stack = [root];
  const src = String(html);
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (!tok) break;
    if (tok.startsWith('<!--') || tok.startsWith('<!DOCTYPE') || /^<(script|style)\b/i.test(tok)) continue;
    if (m[1]) {                                             // closing tag
      const tag = m[1].toLowerCase();
      let i = stack.length - 1;
      while (i > 0 && stack[i].tag !== tag) i--;
      if (i > 0) stack.length = i;
      continue;
    }
    if (m[2]) {                                             // opening tag
      const tag = m[2].toLowerCase();
      const attrs = {}; let cls = []; let id = '';
      const attrRe = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(m[3] || ''))) {
        const name = a[1].toLowerCase(); const val = decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '');
        if (name === 'class') cls = val.split(/\s+/).filter(Boolean);
        else if (name === 'id') id = val;
        else attrs[name] = val;
      }
      const el = new El(tag, { cls, attrs, id });
      if (tag === 'option' && attrs.value == null) el.attrs.value = '';
      if (attrs.checked != null) el.checked = true;
      if (tag === 'input' && attrs.value != null) el.value = attrs.value;
      stack[stack.length - 1].appendChild(el);
      if (!VOID.has(tag) && !m[4]) stack.push(el);
      continue;
    }
    const text = decode(tok).replace(/\s+/g, ' ');
    if (text.trim()) stack[stack.length - 1].appendChild(new TextNode(text));
  }
  const body = root.querySelector('body') || root;
  const dom = documentFor(body);
  // a <select> shows its first option: value '' unless one is marked selected
  for (const s of body.querySelectorAll('select')) { const sel = s.querySelectorAll('option').find((o) => o.hasAttribute('selected')); const first = s.querySelector('option'); s.value = sel ? sel.getAttribute('value') : first ? (first.getAttribute('value') || '') : ''; }
  return { ...dom, html: root };
}

/** Build a statutory table like F12/F13's: rows [{ n, question, name }], radios Yes/No per row. */
function statutoryTable(dom, rows, { header = 'Answer (Yes / No)' } = {}) {
  const { El } = dom;
  const table = new El('table', { cls: ['stat-table'] });
  const thead = table.add(new El('thead'));
  const hr = thead.add(new El('tr'));
  hr.add(new El('th', { cls: ['q-num'], text: '#' }));
  hr.add(new El('th', { cls: ['q-text'], text: 'Questions' }));
  hr.add(new El('th', { cls: ['q-yn'], text: header }));
  const tbody = table.add(new El('tbody'));
  const radios = {};
  for (const r of rows) {
    const tr = tbody.add(new El('tr'));
    tr.add(new El('td', { cls: ['q-num'], text: String(r.n) }));
    tr.add(new El('td', { cls: ['q-text'], text: r.question }));
    const td = tr.add(new El('td', { cls: ['q-yn'] }));
    const grp = td.add(new El('div', { cls: ['yn-group'] }));
    const yes = grp.add(new El('label', { text: ' Yes' })).add(new El('input', { type: 'radio', name: r.name, value: 'yes' }));
    const no  = grp.add(new El('label', { text: ' No' })).add(new El('input', { type: 'radio', name: r.name, value: 'no' }));
    radios[r.name] = { yes, no };
  }
  return { table, radios };
}

module.exports = { El, TextNode, fakeDom, parseHtml, statutoryTable };
