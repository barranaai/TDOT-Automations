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

/** A browser tab's sessionStorage — pass the same one to two loadPage calls to model a reload. */
function storage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size }; }

function loadPage({ na = false, session = storage() } = {}) {
  const prevNa = process.env.DOC_NOT_APPLICABLE;
  if (na) process.env.DOC_NOT_APPLICABLE = '1';
  const items = DOCS.map(([id, name]) => ({ id, name, status: 'Received', category: 'Academic', applicantType: 'Principal Applicant', documentCode: 'X-' + id }));
  const html = svc.buildReviewPage({ caseRef: '2026-CEC-EE-074', clientName: 'Test', staffName: 'Staff', items, folderLinks: {}, folderLinksUnavailable: false });
  if (na) { if (prevNa === undefined) delete process.env.DOC_NOT_APPLICABLE; else process.env.DOC_NOT_APPLICABLE = prevNa; }
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
  // short timers (focus, toast hide) run at once; long ones (the one-minute wait) only when the test says
  const longTimers = new Map(); let timerId = 0;
  const ctx = {
    document, console, URLSearchParams, AbortController, sessionStorage: session,
    setTimeout: (f, ms) => { if (!ms || ms < 5000) { f(); return 0; } const id = ++timerId; longTimers.set(id, f); return id; },
    clearTimeout: (id) => { longTimers.delete(id); }, setInterval: () => 0, clearInterval() {},
    location: { reload() {}, pathname: '/d/x/review', search: '' }, navigator: {},
    fetch: (url, opts) => {
      if (!opts || opts.method !== 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, replies: {}, uploads: {} }) });
      calls.push({ url, body: JSON.parse(opts.body), redirect: opts.redirect });
      const answer = next ? next(url, opts) : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      if (!opts.signal) return answer;
      // like a browser: an aborted request rejects with an AbortError
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
        answer.then(resolve, reject);
      });
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
    // a whole mouse click: press where, release where (the browser fires click on the common ancestor = the overlay)
    clickOverlay: (pressOn, releaseOn) => ['mousedown', 'mouseup', 'click'].forEach((t, i) => (document.getElementById('modal-bg').listeners[t] || []).forEach((fn) => fn({ target: { id: (i === 0 ? pressOn : i === 1 ? releaseOn : 'modal-bg') } }))),
    key: (k) => (docListeners.keydown || []).forEach((fn) => fn({ key: k })),
    cancel: () => document.getElementById('rework-cancel-btn'),
    fireLongTimers: () => { const fs = [...longTimers.values()]; longTimers.clear(); fs.forEach((f) => f()); },
    pendingLongTimers: () => longTimers.size,
    html,
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
  assert.ok(p.calls.every((c) => c.redirect === 'manual'), 'an expired sign-in is seen, never followed');
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

test('connection lost (no answer): "may or may not have gone through — reload to check"; the note stays on screen read-only, Send is off, and THAT document is blocked until a reload — other documents still work', async () => {
  const p = loadPage();
  p.open('102'); p.type('blurry');
  p.answer(() => Promise.reject(new TypeError('Failed to fetch')));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /may or may not have gone through\. Reload the page in a few minutes to check before sending again/);
  assert.equal(p.dialogOpen(), true, 'the note stays on screen');
  assert.equal(p.el('rework-notes').value, 'blurry'); assert.equal(p.el('rework-notes').readOnly, true);
  assert.equal(p.btn.disabled, true); assert.equal(p.btn.textContent, 'Reload the page to check');
  assert.equal(p.cancel().disabled, false);
  await p.ctx.confirmRework(); assert.equal(p.calls.length, 1, 'never sent again from here');
  p.ctx.closeModal(); assert.equal(p.dialogOpen(), false);
  p.open('102'); assert.equal(p.dialogOpen(), false, 'the same document: refused until a reload');
  assert.match(p.toast(), /may already have gone through — reload the page to check before sending again/);
  p.answer(ok); p.open('101');
  assert.equal(p.dialogOpen(), true, 'another document: fine');
  assert.equal(p.el('rework-notes').readOnly, false); assert.equal(p.btn.disabled, false); assert.equal(p.btn.textContent, 'Send Rework Request');
});

test('an expired sign-in turns the request away BEFORE anything is done (the browser reports an opaque redirect): "nothing was sent", the note is kept and can be sent again after signing in', async () => {
  const p = loadPage();
  p.open('103'); p.type('expired session note');
  p.answer(() => Promise.resolve({ ok: false, status: 0, type: 'opaqueredirect', redirected: false, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /sign-in has expired — nothing was sent\. Reload the page to sign in again; your note will be kept/);
  assert.equal(p.dialogOpen(), true); assert.equal(p.el('rework-notes').value, 'expired session note'); assert.equal(p.el('rework-notes').readOnly, false);
  assert.equal(p.btn.disabled, false, 'not blocked: nothing was sent');
});

test('an answer that is not the app\'s (a proxy error page): treated as "may have gone through" — note kept read-only, Send off', async () => {
  const q = loadPage();
  q.open('101'); q.type('x');
  q.answer(() => Promise.resolve({ ok: false, status: 502, redirected: false, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  await q.ctx.confirmRework();
  assert.match(q.toast(), /did not answer clearly \(502\) — reload the page in a few minutes to see whether the request went through/);
  assert.equal(q.dialogOpen(), true); assert.equal(q.btn.textContent, 'Reload the page to check');
});

test('an unsent note survives a reload: back in the dialog for that document, with a pointer to check the row; a sent note is forgotten', async () => {
  const session = storage();
  const p = loadPage({ session });
  p.open('102'); p.type('long explanation the reviewer would hate to retype');
  p.answer(() => Promise.reject(new TypeError('Failed to fetch')));
  await p.ctx.confirmRework();
  const r = loadPage({ session });                 // the page is reloaded
  r.open('102');
  assert.equal(r.dialogOpen(), true);
  assert.equal(r.el('rework-notes').value, 'long explanation the reviewer would hate to retype');
  assert.match(r.toast(), /earlier note for this document is back\. If the row does not say Rework Required, it was not sent/);
  await r.ctx.confirmRework();                     // sent this time
  assert.equal(session.size(), 0, 'a sent note is forgotten');
  r.open('101'); assert.equal(r.el('rework-notes').value, '', 'other documents start blank');
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
  p.ctx.closeModal(); p.key('Escape'); p.clickOverlay('modal-bg', 'modal-bg');
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

test('outside click closes the dialog only when the press both started and ended on the backdrop: selecting note text past the edge, or pressing outside and releasing inside, keeps it (and the note)', () => {
  const p = loadPage();
  p.open('101'); p.type('a long explanation');
  p.clickOverlay('rework-notes', 'modal-bg');       // drag-select from the textarea, released on the backdrop
  assert.equal(p.dialogOpen(), true);
  p.clickOverlay('modal-bg', 'rework-notes');       // pressed on the backdrop, released inside the dialog
  assert.equal(p.dialogOpen(), true); assert.equal(p.el('rework-notes').value, 'a long explanation');
  p.clickOverlay('modal-bg', 'modal-bg');           // a real click outside
  assert.equal(p.dialogOpen(), false);
});

test('the note shown on the row is the escaped text that was sent', async () => {
  const p = loadPage();
  p.open('103'); p.type('score <5> & expired');
  await p.ctx.confirmRework();
  const note = p.rows['103'].parts['.doc-meta'].kids.find((k) => k.className === 'review-notes');
  assert.match(note.innerHTML, /score &lt;5&gt; &amp; expired/);
});

test('a server that never answers: after one minute the dialog stops waiting — "may still go through, reload to check" — and that document is blocked until a reload (the page is never held hostage)', async () => {
  const p = loadPage();
  p.answer(() => new Promise(() => {}));   // no answer, ever
  p.open('101'); p.type('slow');
  const sending = p.ctx.confirmRework();
  assert.equal(p.dialogOpen(), true); assert.equal(p.pendingLongTimers(), 1);
  p.fireLongTimers();                      // a minute passes
  await sending;
  assert.match(p.toast(), /No answer after a minute — the request may still go through\. Reload the page in about 5 minutes to check before sending again/);
  assert.equal(p.dialogOpen(), true); assert.equal(p.el('rework-notes').readOnly, true);
  assert.equal(p.btn.disabled, true); assert.equal(p.cancel().disabled, false, 'the reviewer can close it now');
  p.ctx.closeModal(); assert.equal(p.dialogOpen(), false);
  p.open('101'); assert.equal(p.dialogOpen(), false, 'blocked until a reload');
  p.answer(ok); p.open('102'); assert.equal(p.dialogOpen(), true, 'other documents are fine');
});

test('an answer in time clears the one-minute wait', async () => {
  const p = loadPage();
  p.open('101'); p.type('fast');
  await p.ctx.confirmRework();
  assert.equal(p.pendingLongTimers(), 0);
});

test('the server says Monday did not confirm its write (a timeout after retries): treated as "may have been saved" — never invites a second send', async () => {
  const p = loadPage();
  p.open('102'); p.type('timeout');
  p.answer(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'timeout of 30000ms exceeded', outcomeUnknown: true }) }));
  await p.ctx.confirmRework();
  assert.match(p.toast(), /Monday did not confirm the change \(timeout of 30000ms exceeded\) — it may still have been saved\. Reload the page to check before sending again/);
  assert.equal(p.btn.disabled, true); assert.equal(p.btn.textContent, 'Reload the page to check');
  p.ctx.closeModal(); p.open('102'); assert.equal(p.dialogOpen(), false);
});

test('the route marks every failure past its checks as "outcome unknown" (Monday may still have saved it); clear refusals stay plain 400s', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/documentReviewForm.js'), 'utf8');
  assert.match(src, /if \(err\.badRequest\) return res\.status\(400\)\.json\(\{ ok: false, error: err\.message \}\);/);
  assert.match(src, /return res\.status\(500\)\.json\(\{ ok: false, error: err\.message, outcomeUnknown: true \}\);/);
});

test('the Not Applicable dialog: selecting reason text and releasing past the edge no longer closes it (a real outside click still does)', () => {
  const p = loadPage({ na: true });
  assert.ok(p.html.includes('id="na-modal"'), 'the Not Applicable dialog is on the page');
  p.ctx.openNaModal({ getAttribute: (a) => (a === 'data-id' ? '101' : 'Doc A') });
  const m = p.el('na-modal');
  assert.equal(m.classList.contains('open'), true);
  p.el('na-reason').value = 'client is single';
  const click = (pressOn, releaseOn) => ['mousedown', 'mouseup', 'click'].forEach((t, i) => (m.listeners[t] || []).forEach((fn) => fn({ target: { id: i === 0 ? pressOn : i === 1 ? releaseOn : 'na-modal' } })));
  click('na-reason', 'na-modal');
  assert.equal(m.classList.contains('open'), true);
  click('na-modal', 'na-reason');
  assert.equal(m.classList.contains('open'), true); assert.equal(p.el('na-reason').value, 'client is single');
  click('na-modal', 'na-modal');
  assert.equal(m.classList.contains('open'), false);
});
