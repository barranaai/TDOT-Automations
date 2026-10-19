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
  const e = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, className: '',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (on ? cls.add(c) : cls.delete(c))) },
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener() {}, focus() {}, remove() { e.removed = true; },
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
  const document = {
    getElementById: (id) => (byId[id] = byId[id] || el(id)),
    querySelector: (sel) => { const m = /^\.doc-row\[data-item-id="([^"]*)"\]$/.exec(sel); return m ? rows[m[1]] || null : null; },
    querySelectorAll: () => [],
    addEventListener() {},
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

test('no answer (connection lost / expired sign-in redirected away): says reload to check — never invites a blind second send — and the button works again', async () => {
  const p = loadPage();
  p.open('102'); p.type('blurry');
  p.answer(() => Promise.reject(new TypeError('Failed to fetch')));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /reload the page to see whether the request went through/);
  assert.equal(p.btn.disabled, false);
  // an expired sign-in answered with the login page (not JSON)
  p.answer(() => Promise.resolve({ ok: true, status: 200, redirected: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /sign-in has expired — reload the page and sign in again/);
  assert.equal(p.btn.textContent, 'Send Rework Request');
});

test('one send at a time, and the result always lands on the document it was sent for — even when the dialog is closed or another one is tried meanwhile', async () => {
  const p = loadPage();
  let release;
  p.answer(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) }); }));
  p.open('101'); p.type('first');
  const sending = p.ctx.confirmRework();
  assert.equal(p.btn.textContent, 'Sending…'); assert.equal(p.btn.disabled, true);
  await p.ctx.confirmRework();                       // a second click while sending
  assert.equal(p.calls.length, 1, 'never sent twice');
  p.ctx.closeModal();                                // staff close the dialog meanwhile
  p.open('102');                                     // … and try the next document
  assert.equal(p.dialogOpen(), false, 'refused while the first is still sending');
  assert.match(p.toast(), /previous rework request is still being sent/);
  release(); await sending;
  assert.equal(p.rows['101'].getAttribute('data-status'), 'Rework Required', 'the first document got its result');
  assert.equal(p.rows['102'].getAttribute('data-status'), 'Received', 'never the other one');
  assert.equal(p.btn.disabled, false); assert.equal(p.btn.textContent, 'Send Rework Request');
  p.answer(ok);
  p.open('102'); p.type('second');
  await p.ctx.confirmRework();
  assert.equal(p.rows['102'].getAttribute('data-status'), 'Rework Required');
  assert.deepEqual(p.calls.map((c) => c.body.notes), ['first', 'second']);
});

test('the note shown on the row is the escaped text that was sent', async () => {
  const p = loadPage();
  p.open('103'); p.type('score <5> & expired');
  await p.ctx.confirmRework();
  const note = p.rows['103'].parts['.doc-meta'].kids.find((k) => k.className === 'review-notes');
  assert.match(note.innerHTML, /score &lt;5&gt; &amp; expired/);
});
