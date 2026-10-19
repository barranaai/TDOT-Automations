'use strict';

// The staff Document Review page's "Request Rework" dialog, driven through the
// page's REAL script (rendered by buildReviewPage) against a stand-in DOM.
// Consultant report (EE-074): after one rework the dialog's Send button stayed
// on "Sending…" (disabled) for every other document until a page reload.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');

const svc = require('../src/services/documentReviewFormService');

const DOCS = [['101', 'Canadian Education Documents'], ['102', 'Foreign Education Documents'], ['103', 'Proof of language proficiency']];

/** A tiny DOM: elements by id, the doc rows by data-item-id, class lists, attributes. */
function el(id) {
  const cls = new Set();
  const attrs = {};
  const kids = [];
  const listeners = {};
  const e = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, className: '', listeners,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (on ? cls.add(c) : cls.delete(c))) },
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }, focus() {}, remove() { e.removed = true; },
    appendChild: (k) => { kids.push(k); return k; }, kids,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  };
  return e;
}
function makeRow(itemId) {
  const row = el('row-' + itemId);
  row.setAttribute('data-status', 'Received');
  const parts = { '.status-pill': el(), '.btn-reviewed': el(), '.btn-rework': el(), '.btn-undo': el(), '.doc-meta': el() };
  parts['.doc-meta'].querySelector = (sel) => (sel === '.review-notes' ? parts['.doc-meta'].kids.filter((k) => !k.removed && k.className === 'review-notes').pop() || null : null);
  row.querySelector = (sel) => parts[sel] || null;
  row.parts = parts;
  return row;
}

function loadPage() {
  const items = DOCS.map(([id, name]) => ({ id, name, status: 'Received', category: 'Academic', applicantType: 'Principal Applicant', documentCode: 'X-' + id }));
  const html = svc.buildReviewPage({ caseRef: '2026-CEC-EE-074', clientName: 'Test', staffName: 'Staff', items, folderLinks: {}, folderLinksUnavailable: false });
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const byId = {};
  const rows = Object.fromEntries(DOCS.map(([id]) => [id, makeRow(id)]));
  const docListeners = {};
  const document = {
    getElementById: (id) => (byId[id] = byId[id] || el(id)),
    querySelector: (sel) => { const m = /^\.doc-row\[data-item-id="([^"]*)"\]$/.exec(sel); return m ? rows[m[1]] || null : null; },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    createElement: () => el(),
    body: el('body'),
  };
  // the Send button as the page renders it
  byId['confirm-btn'] = Object.assign(el('confirm-btn'), { textContent: (html.match(/id="confirm-btn"[^>]*>([^<]*)</) || [])[1] });
  const calls = [];
  let next = null;   // the answer the next POST gets: a function (url, opts) => Promise<Response-like>
  const ctx = {
    document, console, URLSearchParams,
    setTimeout: (f) => { f(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { reload() {}, pathname: '/d/x/review', search: '' }, navigator: {},
    fetch: (url, opts) => {
      if (!opts || opts.method !== 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, replies: {}, uploads: {} }) });
      calls.push({ url, body: JSON.parse(opts.body) });
      return next ? next(url, opts) : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  const opener = (id) => ({ getAttribute: (a) => (a === 'data-id' ? id : DOCS.find((d) => d[0] === id)[1]) });
  return {
    ctx, rows, calls, btn: byId['confirm-btn'], el: (id) => document.getElementById(id),
    open: (id) => ctx.openRework(opener(id)),
    type: (t) => { document.getElementById('rework-notes').value = t; },
    answer: (fn) => { next = fn; },
    toast: () => document.getElementById('toast').textContent,
    dialogOpen: () => document.getElementById('modal-bg').classList.contains('open'),
    // fire an event on the overlay (target = the overlay itself, or the dialog/textarea inside it)
    overlay: (type, onOverlay) => (document.getElementById('modal-bg').listeners[type] || []).forEach((fn) => fn({ target: onOverlay ? { id: 'modal-bg' } : { id: 'rework-notes' } })),
    key: (k) => (docListeners.keydown || []).forEach((fn) => fn({ key: k })),
    cancel: () => document.getElementById('rework-cancel-btn'),
  };
}
const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });

test('the reported bug: after one rework, the dialog for the next document starts with a working "Send Rework Request" button — three in a row all go through', async () => {
  const p = loadPage();
  assert.equal(p.btn.textContent, 'Send Rework Request');
  for (const [id] of DOCS) {
    p.open(id);
    assert.equal(p.btn.textContent, 'Send Rework Request', `dialog for ${id}`);
    assert.equal(p.btn.disabled, false, `dialog for ${id}`);
    p.type('please re-upload ' + id);
    await p.ctx.confirmRework();
    assert.equal(p.rows[id].getAttribute('data-status'), 'Rework Required');
    assert.equal(p.dialogOpen(), false);
    assert.match(p.toast(), /Rework requested/);
  }
  assert.deepEqual(p.calls.map((c) => [c.url, c.body.action, c.body.notes]), DOCS.map(([id]) => [`/d/2026-CEC-EE-074/review/${id}/status`, 'rework', 'please re-upload ' + id]));
  assert.equal(p.btn.disabled, false); assert.equal(p.btn.textContent, 'Send Rework Request');
});

test('a refusal from the server: its message is shown, the dialog stays open with the note, and the button works again', async () => {
  const p = loadPage();
  p.open('101'); p.type('wrong file');
  p.answer(() => Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: 'This document is marked Not Applicable — press "Applies again" first, then reload the page.' }) }));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /^✗ This document is marked Not Applicable/);
  assert.equal(p.dialogOpen(), true); assert.equal(p.el('rework-notes').value, 'wrong file');
  assert.equal(p.btn.disabled, false); assert.equal(p.btn.textContent, 'Send Rework Request');
  assert.equal(p.rows['101'].getAttribute('data-status'), 'Received', 'the row is not changed');
});

test('no clear answer (connection lost, or an expired sign-in — a real browser rejects the hop to the Monday login): "reload to check", the dialog closes, and THAT document cannot be re-sent blind until a reload — other documents still can', async () => {
  const p = loadPage();
  p.open('102'); p.type('blurry');
  p.answer(() => Promise.reject(new TypeError('Failed to fetch')));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /reload the page to see whether the request went through/);
  assert.equal(p.dialogOpen(), false);
  p.open('102');
  assert.equal(p.dialogOpen(), false, 'the same document: refused until the page is reloaded');
  assert.match(p.toast(), /may already have gone through — reload the page to check before sending again/);
  p.answer(ok);
  p.open('101');
  assert.equal(p.dialogOpen(), true, 'another document: fine');
  assert.equal(p.btn.disabled, false); assert.equal(p.btn.textContent, 'Send Rework Request');
});

test('an answer that is not the app\'s (the login page when sign-in is not set up, a proxy error page): treated as "may have gone through" too', async () => {
  const p = loadPage();
  p.open('103'); p.type('expired');
  p.answer(() => Promise.resolve({ ok: false, status: 503, redirected: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /sign-in has expired — reload the page and sign in again, then check this document/);
  p.open('103'); assert.equal(p.dialogOpen(), false);
  const q = loadPage();
  q.open('101'); q.type('x');
  q.answer(() => Promise.resolve({ ok: false, status: 502, redirected: false, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  await q.ctx.confirmRework();
  assert.match(q.toast(), /did not answer clearly \(502\) — reload the page to see whether the request went through/);
});

test('one send at a time: while it sends, the dialog cannot be closed (Cancel, Esc, outside click) or sent twice, and the result lands on the document it was sent for', async () => {
  const p = loadPage();
  let release;
  p.answer(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) }); }));
  p.open('101'); p.type('first');
  const sending = p.ctx.confirmRework();
  assert.equal(p.btn.textContent, 'Sending…'); assert.equal(p.btn.disabled, true);
  assert.equal(p.cancel().disabled, true, 'Cancel is off while sending');
  await p.ctx.confirmRework();                                   // a second click
  assert.equal(p.calls.length, 1, 'never sent twice');
  p.ctx.closeModal(); p.key('Escape'); p.overlay('mousedown', true); p.overlay('click', true);
  assert.equal(p.dialogOpen(), true, 'still open — the note is never lost mid-send');
  assert.equal(p.el('rework-notes').value, 'first');
  release(); await sending;
  assert.equal(p.rows['101'].getAttribute('data-status'), 'Rework Required');
  assert.equal(p.rows['102'].getAttribute('data-status'), 'Received');
  assert.equal(p.dialogOpen(), false);
  assert.equal(p.cancel().disabled, false); assert.equal(p.btn.disabled, false); assert.equal(p.btn.textContent, 'Send Rework Request');
  p.answer(ok);
  p.open('102'); p.type('second');
  await p.ctx.confirmRework();
  assert.equal(p.rows['102'].getAttribute('data-status'), 'Rework Required');
  assert.deepEqual(p.calls.map((c) => c.body.notes), ['first', 'second']);
});

test('outside click closes the dialog only when the press started outside: selecting note text and releasing past the edge keeps it (and the note)', () => {
  const p = loadPage();
  p.open('101'); p.type('a long explanation');
  p.overlay('mousedown', false); p.overlay('click', true);       // drag-select from the textarea, released on the overlay
  assert.equal(p.dialogOpen(), true); assert.equal(p.el('rework-notes').value, 'a long explanation');
  p.overlay('mousedown', true); p.overlay('click', true);        // a real click outside
  assert.equal(p.dialogOpen(), false);
});

test('the note shown on the row is the escaped text that was sent', async () => {
  const p = loadPage();
  p.open('103'); p.type('score <5> & expired');
  await p.ctx.confirmRework();
  const note = p.rows['103'].parts['.doc-meta'].kids.find((k) => k.className === 'review-notes');
  assert.match(note.innerHTML, /score &lt;5&gt; &amp; expired/);
});
