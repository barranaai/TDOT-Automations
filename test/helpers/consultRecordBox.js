'use strict';

// A stand-in for the record page's "Record the consultation payment" box, for tests.
// The box's code is the page's OWN emitted script (picked out of buildDetailHTML), run in a vm against a small fake
// page: nothing here re-implements the box. Setting innerHTML reads the ids, the typed values and the chosen option
// out of the markup the page built, so a test sees what staff would see when the box opens.
// No network: doAction (the page's own POST) is replaced by a recorder.

const assert = require('node:assert/strict');
const vm     = require('node:vm');
const C      = require('../../src/routes/adminConsultation');

const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
function pickFn(js, name) { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = js.indexOf('{', i); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(i, j + 1); }
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {{ detail: object, viewer?: { signedIn: boolean, name: string } }} a  detail = what GET /api/consultation/:id answers
 * @returns the opened box: q(selector), kind(value), label(id), go(), err(), sent[] (what the page would POST), dlg.closed
 */
function recordBox({ detail, viewer = { signedIn: true, name: 'Staff One' } } = {}) {
  const js = scriptsOf(C.buildDetailHTML('555')).pop();
  const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const els = {};
  const mk = (id) => ({ id, value: '', textContent: '', innerHTML: '', style: {}, checked: false, disabled: false, focus() { box.focused = id; } });
  const box = {
    focused: '', _html: '',
    set innerHTML(v) {
      this._html = v;
      for (const k of Object.keys(els)) delete els[k];
      for (const m of v.matchAll(/<(input|select|label|div|span|button|textarea)\b([^>]*)>/g)) {
        const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
        const forId = m[1] === 'label' ? (m[2].match(/\bfor="([^"]+)"/) || [])[1] : '';
        if (!id && !forId) continue;
        const e = mk(id || ('label:' + forId));
        if (id) els['#' + id] = e;
        if (forId) els['label[for="' + forId + '"]'] = e;   // a label is also found by the box it names
        const val = m[2].match(/\bvalue="([^"]*)"/);
        if (m[1] === 'input' && val) e.value = unesc(val[1]);
        if (m[1] === 'select') {
          const inner = v.slice(m.index + m[0].length, v.indexOf('</select>', m.index));
          const opts = [...inner.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)/g)];
          e.options = opts.map((o) => ({ value: unesc(o[1]), text: unesc(o[3]) }));
          const sel = opts.find((o) => o[2]) || opts[0];
          e.value = sel ? unesc(sel[1]) : '';
        }
        if (m[1] === 'label') {
          e.innerHTML = v.slice(m.index + m[0].length, v.indexOf('</label>', m.index));
          e.textContent = unesc(e.innerHTML.replace(/<[^>]+>/g, ''));
        }
      }
      els['[data-x]'] = mk('x'); els['[data-go]'] = mk('go'); els['.paym-err'] = mk('err');
      const go = v.match(/data-go>([^<]*)</); els['[data-go]'].textContent = go ? go[1] : '';
    },
    get innerHTML() { return this._html; },
    querySelector(sel) { return els[sel] || null; },
  };
  const sent = [];
  const dlg = { box, closed: false, close() { dlg.closed = true; } };
  const ctx = {
    escHtml, Number, String, isNaN, JSON, Intl, Date, Math,
    setTimeout: () => 0,
    tdotPayViewer: (cb) => cb(viewer),
    payOverlay: () => dlg,
    payTitle: (t) => '<h3 id="paym-title">' + escHtml(t) + '</h3>',
    payEsc: escHtml,
    payParseCents: (v) => { const s = String(v == null ? '' : v).replace(/[^0-9.]/g, ''); if (!s) return NaN; const n = Number(s); return isFinite(n) ? Math.round(n * 100) : NaN; },
    payTypedName: () => '',
    paySaveName() {},
    doAction: (action, value, confirmMsg, by) => { sent.push({ action, value: JSON.parse(value), by }); },
    LAST_DETAIL: detail,
  };
  vm.createContext(ctx);
  vm.runInContext([js.match(/var CP_LABELS=\{[^}]*\};/)[0], js.match(/var CP_WHY=\{[^}]*\};/)[0]].join('\n') + '\n'
    + ['cpMoney', 'cpTodayStr', 'cpDirectWhy', 'cpRecOn', 'cpLooksTaxed', 'cpPackageSection', 'cpPackageBind', 'openConsultPaymentModal'].map((n) => pickFn(js, n)).join('\n'), ctx);
  const open = (clear = false) => { ctx.openConsultPaymentModal(detail, clear); return api; };
  const q = (sel) => box.querySelector(sel);
  const api = {
    box, dlg, sent, q, open,
    kind(v) { q('#cp-kind').value = v; q('#cp-kind').onchange(); },
    label: (id) => q('#' + id).innerHTML.replace(/<[^>]+>/g, ''),
    go() { q('[data-go]').onclick(); },
    err: () => q('.paym-err').textContent,
  };
  return api;
}

module.exports = { recordBox, scriptsOf, pickFn, escHtml };
