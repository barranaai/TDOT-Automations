'use strict';

// A very small DOM for exercising the browser-side questionnaire engine
// helpers in Node (no jsdom in this repo). Supports what the engine code
// touches: tag/class/attribute selectors (single compound selectors joined by
// commas, descendant matching only), classList.contains, style.display,
// children / parentElement, textContent, value / checked / type / name,
// closest, contains, createElement / appendChild / insertBefore, and a
// window.getComputedStyle that models the forms' stylesheet rules.

class El {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.tag = String(tag).toLowerCase();
    this.classes = new Set(opts.cls || []);
    this.attrs = { ...(opts.attrs || {}) };
    if (opts.type) this.attrs.type = opts.type;
    if (opts.name) this.attrs.name = opts.name;
    this.id = opts.id || '';
    this.style = { display: opts.display || '' };
    this.children = [];
    this.parentElement = null;
    this.text = opts.text || '';
    this.value = opts.value == null ? '' : opts.value;
    this.checked = !!opts.checked;
    this.classList = { contains: (c) => this.classes.has(c), add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c) };
  }
  get type() { return this.attrs.type || (this.tag === 'input' ? 'text' : ''); }
  get name() { return this.attrs.name || ''; }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  getAttribute(n) { if (n === 'type') return this.attrs.type == null ? null : this.attrs.type; return this.attrs[n] == null ? null : this.attrs[n]; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  add(child) { return this.appendChild(child); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child, ref) {
    child.parentElement = this;
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
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
        const a = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p);
        if (!a) return false;
        const actual = a[1] === 'type' ? this.type : this.getAttribute(a[1]);
        if (a[2] === undefined) { if (actual == null) return false; }
        else if (String(actual) !== a[2]) return false;
      }
    }
    return true;
  }
  _all(out) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  /* "thead th" / "tbody tr": descendant combinators — the last compound must match
     the element, each earlier one some ancestor, right to left. */
  _matchesComplex(sel) {
    const compounds = sel.trim().split(/\s+/);
    if (!this._matches(compounds[compounds.length - 1])) return false;
    let n = this.parentElement;
    for (let i = compounds.length - 2; i >= 0; i--) {
      while (n && !n._matches(compounds[i])) n = n.parentElement;
      if (!n) return false;
      n = n.parentElement;
    }
    return true;
  }
  querySelectorAll(sel) { const parts = sel.split(','); return this._all([]).filter((e) => parts.some((p) => e._matchesComplex(p))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { const parts = sel.split(','); let n = this; while (n) { if (parts.some((p) => n._matches(p))) return n; n = n.parentElement; } return null; }
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
}

function fakeDom() {
  const body = new El('body');
  const document = {
    body,
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    getElementById: (id) => body._all([]).find((e) => e.id === id) || null,
    createElement: (tag) => new El(tag),
  };
  // The forms' stylesheet: class-hidden wrappers open with .open / .visible;
  // collapsed accordion bodies are display:none.
  const css = (n) => {
    if (n.style.display) return n.style.display;
    const hiddenUnlessOpen = ['conditional-block', 'refusal-block', 'top-accordion-body', 'sub-accordion-body'];
    if (hiddenUnlessOpen.some((c) => n.classes.has(c)) && !n.classes.has('open')) return 'none';
    if (n.classes.has('conditional') && !n.classes.has('visible')) return 'none';
    return 'block';
  };
  const window = { getComputedStyle: (n) => ({ display: css(n) }) };
  return { El, body, document, window };
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

module.exports = { El, fakeDom, statutoryTable };
