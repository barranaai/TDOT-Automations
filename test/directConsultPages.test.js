'use strict';

// Direct consultation, commit 3 — the pages (step 2, 2026-11-09): the "＋ Direct consultation"
// pop-up on the Consultations page, the "direct" pill, the Otter summary tick on the record
// page's Updates box, "Change time" on a direct row, Retain that asks first, and "Paid in
// Square" in the fee dialog. Every emitted <script> must parse; the browser code keeps the
// inline-JS rules; the pop-up's own code runs here against a small fake page. Nothing reaches
// the network (the no-network guard, and fetch is a stub).

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const C   = require('../src/routes/adminConsultation');
const DQ  = require('../src/routes/directConsultUi');
const UW  = require('../src/routes/updatesWidget');

function scriptsOf(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]); }
function torontoIn(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const DAY = 86400000;

/* ── every emitted script parses; the rules of the browser code ── */

test('pages: every emitted <script> of the Consultations page and the record page parses (vm.Script)', () => {
  for (const [name, html] of [['consultations', C.buildQueueHTML()], ['record', C.buildDetailHTML('12345')], ['record from retainers', C.buildDetailHTML('12345', { from: 'retainers' })], ['retainers', C.buildRetainersHTML()]]) {
    const scripts = scriptsOf(html);
    assert.ok(scripts.length >= 1, name);
    scripts.forEach((src, i) => { try { new vm.Script(src); } catch (e) { assert.fail(`${name} script #${i + 1}: ${e.message}`); } });
  }
  // a hostile lead id stays inert on the record page
  const hostile = C.buildDetailHTML('</script><img src=x onerror=alert(1)>');
  scriptsOf(hostile).forEach((src) => new vm.Script(src));
  assert.ok(!hostile.includes('<img src=x'));
});

test('the pop-up code keeps the inline-JS rules: no backtick, no dollar-brace, no backslash; the shared pop-up, never alert/confirm', () => {
  for (const [name, js] of [['DQ_JS', DQ.DQ_JS], ['DQ_CSS', DQ.DQ_CSS], ['UPDATES_WIDGET_JS', UW.UPDATES_WIDGET_JS]]) {
    assert.ok(!js.includes('`'), `${name}: no backtick`);
    assert.ok(!js.includes('${'), `${name}: no dollar-brace`);
    assert.ok(!js.includes('\\'), `${name}: no backslash`);
  }
  assert.ok(DQ.DQ_JS.includes('tdotDialogNew({ cls:\'dq\''), 'the one pop-up standard');
  assert.ok(!/window\.(alert|confirm)\(/.test(DQ.DQ_JS), 'no browser alert / confirm in the pop-up');
  // the form: 16px inputs (a phone does not zoom in), Cancel before Save in the shared action row, the two choices
  assert.match(DQ.DQ_CSS, /font-size:16px/);
  const form = DQ.dqFormHtml();
  assert.ok(form.indexOf('data-x>Cancel') < form.indexOf('id="dq-save"'), 'Cancel before Save');
  assert.ok(form.includes('class="tdlg-actions"'));
  for (const s of ['New client / new matter', 'Existing client: about their current file', 'Already booked in Square?', 'id="dq-when" type="datetime-local"', 'Fee before HST', 'Booked by', 'Source / Reference', 'id="dq-ref-emp"', 'Email the client the consultation agreement and pre-consultation form now'])
    assert.ok(form.includes(s), s);
  // the phone layout: the two-column rows fold into one at phone width
  assert.match(DQ.DQ_CSS, /@media \(max-width:560px\)[\s\S]*\.dq \.dq-row2, \.dq \.dq-choice \{ grid-template-columns:1fr; \}/);
});

test('Consultations page: the button is hidden until the server says yes; the pop-up, the pill and the look-up are wired', () => {
  const q = C.buildQueueHTML();
  assert.ok(q.includes('<button class="btn-direct" id="btn-direct-consult" type="button" hidden'), 'hidden by default (the switch ships off)');
  assert.ok(q.includes('id="dq-done"'));
  assert.ok(q.includes('var DQ_FORM="'), 'the form markup is a JSON value, not template source');
  assert.ok(q.includes('dqInitButton();'));
  assert.ok(q.includes("fetch('/api/consultation/direct-consult/options'"));
  assert.ok(q.includes("fetch('/api/consultation/direct-consult',{method:'POST'"));
  assert.ok(q.includes("fetch('/api/consultation/client-matches?email='"));
  assert.ok(q.includes('function tdotBlacklistHtml(') && q.includes('function tdotRef('), 'the Not Wanted warning and the referral picker are on the page');
  assert.ok(q.includes("square:'Paid in Square'"), 'the Paid pill reads the new kind');
  assert.ok(q.includes("escHtml(c.name)+directPill(c)"), 'the pill sits by the client name');
  // the existing tests' anchors are unchanged
  for (const s of ['id="snap-age"', 'id="cq-tabs"', "<a href=\"/admin/retainers\">Retainers &amp; follow-ups</a>"]) assert.ok(q.includes(s), s);
});

test('the list: the "direct" pill with who booked it and the kind; an Existing-client row is never under "Needs outcome"', () => {
  const page = scriptsOf(C.buildQueueHTML())[0];
  const pick = (name) => { const i = page.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = page.indexOf('{', i); for (; j < page.length; j++) { if (page[j] === '{') depth++; else if (page[j] === '}' && --depth === 0) break; } return page.slice(i, j + 1); };
  const ctx = { escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext([pick('dParts'), pick('directPill')].join('\n'), ctx);
  assert.equal(ctx.directPill({ name: 'A' }), '', 'a normal row has no pill');
  const p = ctx.directPill({ direct: 'Follow-up', bookedBy: 'Melanie' });
  assert.match(p, />direct<\/span>$/);
  assert.match(p, /title="Booked by Melanie · Follow-up"/);
  assert.match(ctx.directPill({ direct: '?', bookedBy: '' }), /title="Direct consultation"/);
  assert.match(ctx.directPill({ direct: 'New', bookedBy: '<b>x' }), /Booked by &lt;b&gt;x/, 'escaped');
  // which tab a row is under: the list definition's rule (the tabs are the shared engine's, 2026-11-12)
  const LT = require('../src/routes/listFilters').listCore(require('../src/routes/listSpecs').consultListSpec({ today: () => '2026-11-09' }));
  const tab = (r) => LT.valuesOf('tab', r)[0];
  assert.equal(tab({ bookedSlot: '2026-11-02 10:00' }), 'needs', 'a past consultation with no outcome');
  assert.equal(tab({ bookedSlot: '2026-11-02 10:00', direct: 'New' }), 'needs', 'a direct New one too');
  assert.equal(tab({ bookedSlot: '2026-11-02 10:00', direct: 'Follow-up' }), 'needs', 'a follow-up too');
  assert.equal(tab({ bookedSlot: '2026-11-02 10:00', direct: 'Existing client' }), 'booked', 'about their current file: nothing to decide');
  assert.equal(tab({ bookedSlot: '' }), 'nodate');
});

test('record page: the "direct" chip, the Added-as lines, Change time (direct rows, no outcome), Retain that asks first, Paid in Square, the Otter tick', () => {
  const d = C.buildDetailHTML('555');
  for (const s of [
    "if(d.direct){ var dqTip=(d.direct.bookedBy?'Booked by '+d.direct.bookedBy+' · ':'')+(d.direct.kind||'Direct consultation');",
    "if(d.direct && d.direct.canChangeTime && !d.outcome) acts+='<button type=\"button\" class=\"btn\" id=\"btn-dq-time\"",
    "if(d.direct && d.direct.needsRcic && !d.outcome) acts+='<button type=\"button\" class=\"btn\" id=\"btn-dq-cons\"",
    'function openChangeConsultant(d){', "action:'setConsultant', value: sel.value",
    "'direct-consult':'A direct consultation — this box records the fee only: no booking, no meeting and no package.",
    "kv('Added as','Direct consultation · '",
    "kv('In Square',d.direct.inSquare===true?",
    'function openChangeTime(d){', "action:'changeDirectTime'", "Save anyway (different client)",
    'function dqAskFirst(text, onYes){', 'res.j.needsConfirm && confirmed!==true', 'confirm: confirmed===true',
    "doAction(action,value,null,staffNameOverride,true);",
    "['square','Paid in Square (booked by the team, not the booking link)']", "square:'Paid in Square'",
    'id="updw-otter"', 'Consultation summary (Otter)',
  ]) assert.ok(d.includes(s), s);
  // the shared pop-up is on the record page (it travels with the payment module) before the code that uses it
  const script = scriptsOf(d).pop();
  assert.ok(script.indexOf('function tdotDialogNew(') >= 0 && script.indexOf('function tdotDialogNew(') < script.indexOf('function openChangeTime('));
  // recordConsultPayment is posted exactly as before
  assert.ok(d.includes("doAction('recordConsultPayment', JSON.stringify(payload), null, by);"));
  // the Updates box elsewhere has no Otter tick
  assert.ok(!UW.updatesWidgetHtml('x').includes('otter'));
});

/* ── the Updates box: the Otter tick, run against a small fake page ── */

function fakeEl(id) {
  const l = {};
  return { id, value: '', textContent: '', innerHTML: '', style: {}, checked: false, disabled: false, maxLength: 4000, placeholder: '',
    classList: { _s: new Set(), toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild() {}, addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, fire(t) { (l[t] || []).forEach((f) => f({ target: this })); if (this['on' + t]) this['on' + t]({}); }, focus() {} };
}

test('Updates box: ticked, the post says kind "otter" and the box takes 20,000 characters; unticked, over 4,000 is refused on the page', async () => {
  assert.equal(UW.MAX_OTTER, require('../src/services/updatesService').MAX_OTTER);
  assert.equal(UW.MAX_UPDATE, require('../src/services/updatesService').MAX_UPDATE);
  const els = {};
  const el = (id) => (els[id] = els[id] || fakeEl(id));
  const posts = [];
  const ctx = {
    document: { getElementById: (id) => (['updw-list', 'updw-text', 'updw-name', 'updw-post', 'updw-msg', 'updw-otter', 'updw-compose'].includes(id) ? el(id) : null), createElement: () => fakeEl('x') },
    localStorage: { getItem: () => '', setItem() {} },
    window: {},
    peekKey: () => 'k',
    fetch: (url, o) => { if (o && o.method === 'POST') { posts.push(JSON.parse(o.body)); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }); } return Promise.resolve({ json: () => Promise.resolve({ updates: [] }) }); },
  };
  vm.createContext(ctx);
  vm.runInContext(UW.UPDATES_WIDGET_JS + '\ntdotUpdatesMount({ prefix: "updw", threadUrl: "/api/updates/1", itemId: "1" });', ctx);
  el('updw-name').value = 'Gauri';
  el('updw-text').value = 'x'.repeat(5000);
  el('updw-post').onclick();
  assert.equal(posts.length, 0, 'unticked: over 4,000 is not posted');
  assert.match(el('updw-msg').textContent, /tick Consultation summary \(Otter\)/);
  el('updw-otter').checked = true; el('updw-otter').fire('change');
  assert.equal(el('updw-text').maxLength, 20000);
  assert.ok(el('updw-compose').classList.contains('otter'));
  el('updw-post').onclick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { body: 'x'.repeat(5000), staffName: 'Gauri', kind: 'otter' });
  assert.equal(el('updw-otter').checked, false, 'unticked after posting');
  assert.equal(el('updw-text').maxLength, 20000, 'the box never shrinks back — unticking must not cut typed text (review round 1)');
  el('updw-text').value = 'a normal update'; el('updw-post').onclick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posts[1], { body: 'a normal update', staffName: 'Gauri' }, 'a normal update has no kind');
});

/* ── the pop-up itself, run against a small fake page ── */

const OPTIONS = {
  consultants: [
    { name: 'Shafoli Kapur', rcic: true, defaultMin: 30, options: [{ durationMin: 30, feeCents: 30000 }, { durationMin: 60, feeCents: 45000 }] },
    { name: 'Gauri Berde', rcic: false, defaultMin: 30, options: [] },
  ],
  lengths: [15, 30, 45, 60, 75, 90, 105, 120],
  meetingTypes: ['In-person', 'Virtual', 'Phone Call'],
  payments: [{ kind: 'square', label: 'Paid in Square' }, { kind: 'cash', label: 'Cash' }, { kind: 'e-transfer', label: 'E-transfer' }, { kind: 'waived', label: 'Free' }, { kind: 'none', label: 'Not paid yet' }],
  hstPct: 13, staff: ['Melanie', 'Shafoli Kapur'], bookedBy: 'Melanie', signedIn: true, sources: ['Walk-in', 'Existing Client'], caseTypes: ['Study Permit'], backDays: 30,
};

function popupWorld({ matches = null, answer = { s: 200, j: { ok: true, message: 'Saved.', link: '/admin/consultation/9', left: [] } }, options = {} } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || fakeEl(id));
  const radios = {
    'dq-choice': ['new', 'existing'], 'dq-how': OPTIONS.meetingTypes, 'dq-pay': OPTIONS.payments.map((p) => p.kind),
    'dq-inca': ['Yes', 'No', ''], 'dq-sq': ['yes', 'no'], 'dq-use': [],
  };
  const R = {};
  for (const [n, vals] of Object.entries(radios)) R[n] = vals.map((v) => Object.assign(fakeEl(n + ':' + v), { value: v, name: n }));
  R['dq-inca'][2].checked = true;
  const box = {
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    querySelector(sel) {
      let m = sel.match(/^#(.+)$/); if (m) return el(m[1]);
      m = sel.match(/^input\[name="([^"]+)"\]:checked$/); if (m) return (R[m[1]] || []).find((r) => r.checked) || null;
      m = sel.match(/^input\[name="([^"]+)"\]$/); if (m) return (R[m[1]] || [])[0] || null;
      if (sel === 'label[for="dq-fee"]') return el('label-dq-fee');
      if (sel === '[data-x]') return el('cancel');
      return null;
    },
    querySelectorAll(sel) { const m = sel.match(/^input\[name="([^"]+)"\]$/); return m ? (R[m[1]] || []) : []; },
  };
  el('dq-fees').querySelectorAll = () => [];
  const posts = [];
  const net = { lookup: null };   // a test may answer the look-up itself: net.lookup = (url) => a promise of the response
  const dlg = { box, openId: 1, still: () => true, setBusy(on) { dlg.busy = on; }, close() { dlg.closed = true; return true; }, tryClose() { dlg.closed = true; } };
  const ctx = {
    DQ_FORM: DQ.dqFormHtml(), DQ_OPTS: null, Intl, Date, Math, Number, String, isFinite, isNaN, encodeURIComponent, JSON, setTimeout, clearTimeout,
    peekKey: () => 'k', getKey: () => 'k',
    tdotDialogNew: () => dlg,
    tdotRef: () => ({ check: () => '', value: () => '', from: () => 'typed', focus() {} }),
    tdotBlacklistHtml: (r) => (r && r.hit ? '<div>Not Wanted</div>' : ''),
    load: () => { ctx.reloaded = (ctx.reloaded || 0) + 1; },
    location: { pathname: '/admin/consultations' },
    document: { getElementById: (id) => el(id) },
    fetch: (url, o) => {
      if (String(url).startsWith('/api/consultation/client-matches')) {
        if (net.lookup) return net.lookup(String(url));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(matches || { clients: [], cases: [], leads: [] }) });
      }
      posts.push({ url, body: JSON.parse(o.body) });
      return Promise.resolve({ status: answer.s, json: () => Promise.resolve(answer.j) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DQ.DQ_JS + '\nDQ_OPTS=' + JSON.stringify({ ...OPTIONS, ...options }) + ';\nopenDirectConsult();', ctx);
  const pickRadio = (n, v) => { R[n].forEach((r) => { r.checked = r.value === v; }); const r = R[n].find((x) => x.value === v); if (r && r.onchange) r.onchange({}); };
  const type = (id, v, ev = 'input') => { el(id).value = v; el(id).fire(ev); };
  return { el, R, pickRadio, type, posts, dlg, ctx, net, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

test('pop-up: a future Square booking — the payload the server gets (date and time split, the fee in cents, "in Square", no package, a new row)', async () => {
  const w = popupWorld();
  const when = torontoIn(3 * DAY).slice(0, 10) + 'T11:00';
  w.type('dq-name', 'Asha Example');
  w.type('dq-email', 'asha@example.com');
  w.pickRadio('dq-choice', 'new');
  w.el('dq-consultant').value = 'Shafoli Kapur'; w.el('dq-consultant').onchange();
  assert.equal(w.el('dq-len').value, '30', 'the consultant\'s usual length');
  w.pickRadio('dq-how', 'In-person');
  w.type('dq-when', when, 'change');
  assert.equal(w.el('dq-sq-w').style.display, '', '"Already booked in Square?" is asked for a time ahead');
  w.pickRadio('dq-pay', 'square');
  assert.equal(w.el('dq-fee').value, '300.00', 'the price for that consultant and length');
  assert.equal(w.el('dq-total').textContent, 'Fee $300.00 + HST 13% = $339.00 total');
  assert.equal(w.el('dq-pkg-w').style.display, '', 'the package tick is offered (new, ahead, email, RCIC, fee, in person)');
  w.type('dq-about', 'study permit extension');
  w.el('dq-source').value = 'Walk-in';
  // Save without "in Square?" → the page asks first, nothing is posted
  w.el('dq-save').onclick();
  assert.equal(w.posts.length, 0);
  assert.match(w.el('dq-err').textContent, /Already booked in Square/);
  w.pickRadio('dq-sq', 'yes');
  w.el('dq-save').onclick();
  await w.settle();
  assert.equal(w.posts.length, 1);
  const b = w.posts[0].body;
  assert.equal(w.posts[0].url, '/api/consultation/direct-consult');
  assert.deepEqual(
    { choice: b.choice, date: b.date, time: b.time, consultant: b.consultant, meetingType: b.meetingType, durationMin: b.durationMin, payment: b.payment.kind, cents: b.payment.amountCents, inSquare: b.inSquare, pkg: b.package, use: b.useLeadId, bookedBy: b.bookedBy, src: b.sourceChannel, diff: b.differentConsultation, clash: b.clashAck },
    { choice: 'new', date: when.slice(0, 10), time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'In-person', durationMin: 30, payment: 'square', cents: 30000, inSquare: true, pkg: false, use: '', bookedBy: 'Melanie', src: 'Walk-in', diff: false, clash: false });
  assert.match(b.payment.on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(w.dlg.closed, true, 'saved: the pop-up closes');
  assert.match(w.el('dq-done').innerHTML, /Saved\./);
  assert.equal(w.ctx.reloaded, 1, 'the list is read again');
});

test('pop-up: a past consultation about the current file — no "in Square?", no source, no package, "Not paid yet" sends no fee', async () => {
  const w = popupWorld();
  w.type('dq-name', 'Ravi Client'); w.type('dq-phone', '416 555 0199');
  w.pickRadio('dq-choice', 'existing');
  assert.equal(w.el('dq-src-w').style.display, 'none', 'no source asked for their current file');
  w.el('dq-consultant').value = 'Gauri Berde'; w.el('dq-consultant').onchange();
  w.pickRadio('dq-how', 'Phone Call');
  w.type('dq-when', torontoIn(-2 * DAY).slice(0, 10) + 'T10:15', 'change');
  assert.equal(w.el('dq-sq-w').style.display, 'none', 'already happened: not asked');
  w.pickRadio('dq-pay', 'none');
  assert.equal(w.el('dq-fee-w').style.display, 'none');
  assert.equal(w.el('dq-pkg-w').style.display, 'none', 'never a package for an existing client / a non-RCIC / no fee');
  w.type('dq-about', 'question about their PR card');
  w.el('dq-save').onclick();
  await w.settle();
  const b = w.posts[0].body;
  assert.equal(b.choice, 'existing'); assert.equal(b.inSquare, null); assert.deepEqual(b.payment, { kind: 'none' });
  assert.equal(b.sourceChannel, ''); assert.equal(b.package, false); assert.equal(b.useLeadId, '');
});

test('pop-up: video is never offered the package; Free sends no amount; outside Canada shows no HST', async () => {
  const w = popupWorld();
  w.type('dq-name', 'Mia V'); w.type('dq-email', 'mia@example.com');
  w.pickRadio('dq-choice', 'new');
  w.el('dq-consultant').value = 'Shafoli Kapur'; w.el('dq-consultant').onchange();
  w.type('dq-when', torontoIn(5 * DAY).slice(0, 10) + 'T14:00', 'change');
  w.pickRadio('dq-pay', 'cash');
  w.pickRadio('dq-how', 'Virtual');
  assert.equal(w.el('dq-pkg-w').style.display, 'none', 'video: no Teams link is made here, so no package');
  w.pickRadio('dq-inca', 'No'); w.el('dq-country').value = 'India'; w.el('dq-country').onchange();
  assert.equal(w.el('dq-total').textContent, 'Fee $300.00 — no HST (outside Canada)');
  w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-fee').style.display, 'none');
  w.type('dq-reason', 'family of a client');   // "Free" needs its reason (2026-11-20)
  w.type('dq-about', 'visitor visa'); w.el('dq-source').value = 'Walk-in'; w.pickRadio('dq-sq', 'no');
  w.el('dq-save').onclick();
  await w.settle();
  const b = w.posts[0].body;
  assert.equal(b.payment.kind, 'waived'); assert.equal('amountCents' in b.payment, false); assert.equal(b.payment.note, 'family of a client');
  assert.equal(b.inSquare, false); assert.equal(b.inCanada, 'No'); assert.equal(b.currentCountry, 'India');
});

/* ── "Free" needs a reason (Gauri B3, 2026-11-20) ── */

/** A form filled in up to the payment: a new client, a time ahead, in person. */
function filled(w, { choice = 'new', when = torontoIn(3 * DAY).slice(0, 10) + 'T11:00' } = {}) {
  w.type('dq-name', 'Asha Example'); w.type('dq-email', 'asha@example.com');
  w.pickRadio('dq-choice', choice);
  w.el('dq-consultant').value = 'Shafoli Kapur'; w.el('dq-consultant').onchange();
  w.pickRadio('dq-how', 'In-person');
  w.type('dq-when', when, 'change');
  w.type('dq-about', 'question about the file'); w.el('dq-source').value = 'Walk-in'; w.pickRadio('dq-sq', 'yes');
}

test('pop-up: "Why is it free? *" — one box (id dq-reason) inside the payment block, shown only for "Free"; Save with it empty says so and sends nothing; with words they travel as payment.note', async () => {
  const form = DQ.dqFormHtml();
  assert.equal(form.split('id="dq-reason"').length - 1, 1, 'built once');
  assert.ok(form.includes('<div id="dq-reason-w" style="display:none"><label class="dq-l" for="dq-reason">Why is it free? *</label><input id="dq-reason" type="text" maxlength="200" autocomplete="off" placeholder="e.g. existing client — question about their current file"></div>'));
  assert.ok(form.indexOf('id="dq-paidon"') < form.indexOf('id="dq-reason"') && form.indexOf('id="dq-reason"') < form.indexOf('id="dq-about"'), 'after "Date paid", inside the payment block');
  assert.ok(form.slice(form.indexOf('id="dq-fee-w"'), form.indexOf('id="dq-about"')).includes('id="dq-reason"'));
  for (const id of ['dq-fee-w', 'dq-paidon', 'dq-fee', 'dq-pay']) assert.ok(form.includes('id="' + id + '"'), 'kept: ' + id);
  assert.match(DQ.DQ_CSS, /\.dq input\[type=text\][^{]*\{[^}]*font-size:16px/, 'a text box like the others: 16px, full width (a phone does not zoom in)');

  const w = popupWorld();
  filled(w);
  assert.equal(w.el('dq-reason-w').style.display, 'none', 'nothing chosen yet');
  for (const kind of ['square', 'cash', 'e-transfer', 'none']) { w.pickRadio('dq-pay', kind); assert.equal(w.el('dq-reason-w').style.display, 'none', kind + ': no reason box'); }
  w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-reason-w').style.display, '', '"Free": the box shows');
  assert.equal(w.el('dq-reason').value, '', 'a new client: empty, it must be typed');
  for (const typed of ['', '  ', 'no']) {
    w.el('dq-reason').value = typed;
    w.el('dq-save').onclick();
    assert.equal(w.el('dq-err').textContent, 'Write why this consultation is free.', JSON.stringify(typed));
    assert.equal(w.posts.length, 0, 'nothing is sent');
    assert.equal(w.dlg.closed, undefined, 'the form stays open');
  }
  w.type('dq-reason', '  family of an existing client ');
  w.el('dq-save').onclick();
  await w.settle();
  assert.equal(w.posts.length, 1);
  const p = w.posts[0].body.payment;
  assert.deepEqual(Object.keys(p).sort(), ['kind', 'note', 'on']);
  assert.equal(p.kind, 'waived'); assert.equal(p.note, 'family of an existing client'); assert.equal('amountCents' in p, false);
  // a paid kind and "Not paid yet" never send a note
  for (const kind of ['cash', 'none']) {
    const w2 = popupWorld(); filled(w2);
    w2.pickRadio('dq-pay', 'waived'); w2.type('dq-reason', 'typed, then the payment was changed');
    w2.pickRadio('dq-pay', kind);
    w2.el('dq-save').onclick(); await w2.settle();
    assert.equal(w2.posts.length, 1, kind);
    assert.equal('note' in w2.posts[0].body.payment, false, kind + ': no note travels');
  }
  // the form is built fresh at every opening: the box is empty again
  const again = popupWorld(); filled(again); again.pickRadio('dq-pay', 'waived');
  assert.equal(again.el('dq-reason').value, '');
});

test('pop-up: "Existing client: about their current file" + "Free" — the reason box opens ALREADY FILLED; staff can keep or change it; unedited words never ride on a new client', async () => {
  const WORDS = 'Existing client — about their current file';
  assert.ok(DQ.DQ_JS.includes("var DQ_REASON_EXISTING='" + WORDS + "';"));
  // existing first, then Free
  let w = popupWorld(); filled(w, { choice: 'existing' });
  w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-reason-w').style.display, '');
  assert.equal(w.el('dq-reason').value, WORDS, 'pre-filled');
  w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1, 'kept as it is: it saves');
  assert.deepEqual([w.posts[0].body.choice, w.posts[0].body.payment.kind, w.posts[0].body.payment.note], ['existing', 'waived', WORDS]);
  // Free first, then existing
  w = popupWorld(); filled(w);
  w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-reason').value, '', 'a new client: empty');
  w.pickRadio('dq-choice', 'existing');
  assert.equal(w.el('dq-reason').value, WORDS, 'filled when the choice becomes "existing client"');
  // changed back to a new client without touching the words: taken out again, and it must be typed
  w.pickRadio('dq-choice', 'new');
  assert.equal(w.el('dq-reason').value, '', 'cleared — a pre-filled reason never rides on a new client');
  w.el('dq-save').onclick();
  assert.equal(w.el('dq-err').textContent, 'Write why this consultation is free.');
  assert.equal(w.posts.length, 0);
  // pre-filled, then the payment changes away from Free: cleared too (and not sent)
  w.pickRadio('dq-choice', 'existing');
  assert.equal(w.el('dq-reason').value, WORDS);
  w.pickRadio('dq-pay', 'cash');
  assert.equal(w.el('dq-reason').value, '');
  assert.equal(w.el('dq-reason-w').style.display, 'none');
  w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-reason').value, WORDS, 'and back');
  // staff CHANGE the words: theirs are kept, whatever is chosen next — the app never overwrites or removes typed text
  w.type('dq-reason', 'Existing client — about their current file, PR card renewal');
  w.pickRadio('dq-choice', 'new');
  assert.equal(w.el('dq-reason').value, 'Existing client — about their current file, PR card renewal', 'edited words are staff\'s own');
  w.pickRadio('dq-choice', 'existing');
  assert.equal(w.el('dq-reason').value, 'Existing client — about their current file, PR card renewal', 'never overwritten');
  // staff EMPTY the box: it is not filled in again behind their back
  w = popupWorld(); filled(w, { choice: 'existing' }); w.pickRadio('dq-pay', 'waived');
  w.type('dq-reason', '');
  w.pickRadio('dq-pay', 'cash'); w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-reason').value, '', 'emptied by staff: left empty');
  w.el('dq-save').onclick();
  assert.equal(w.el('dq-err').textContent, 'Write why this consultation is free.');
  // a reason typed for a new client is kept when the choice becomes "existing client"
  w = popupWorld(); filled(w); w.pickRadio('dq-pay', 'waived'); w.type('dq-reason', 'staff family');
  w.pickRadio('dq-choice', 'existing');
  assert.equal(w.el('dq-reason').value, 'staff family');
});

test('pop-up: the server refuses "Free" with no reason (a page left open from before) — the form stays OPEN with what was typed and shows the server\'s words', async () => {
  const words = 'Write the reason the fee is waived (why the consultation is free) — nothing was saved. If you cannot see a box for the reason, reload the page first.';
  const w = popupWorld({ answer: { s: 400, j: { error: words } } });
  filled(w); w.pickRadio('dq-pay', 'waived'); w.type('dq-reason', 'family of an existing client');
  w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1);
  assert.equal(w.el('dq-err').textContent, words);
  assert.equal(w.dlg.closed, undefined, 'still open');
  assert.deepEqual([w.el('dq-name').value, w.el('dq-email').value, w.el('dq-about').value, w.el('dq-reason').value], ['Asha Example', 'asha@example.com', 'question about the file', 'family of an existing client'], 'nothing typed is lost');
  assert.equal(w.ctx.reloaded, undefined, 'the list is not re-read: nothing was saved');
});

/* ── Money first (Gauri B4, Faran 2026-11-20): "Not paid yet" on the page — only when the server says the switch is on (options.moneyFirst) ── */

const PAY_FIRST_LINE = 'A new client pays first. “Not paid yet” is only for an existing client (about their current file) or a follow-up.';
const NO_FILE_LINE = 'The app finds no file for this email or phone, so “Not paid yet” is not offered.';
const TYPE_FIRST_LINE = 'Type the client’s email or phone first — “Not paid yet” is offered when the app finds their file.';
const LOOKING_LINE = 'Looking for this client’s file…';
const LOOK_FAILED_LINE = 'The app could not look this client up just now. Click in the email or phone box and out again to try once more.';
const ON = { options: { moneyFirst: true } };
const notPaid = (w) => w.R['dq-pay'].find((r) => r.value === 'none');
const offered = (w) => notPaid(w).disabled !== true;
const hint = (w) => (w.el('dq-pay-hint').style.display === 'none' ? '' : w.el('dq-pay-hint').textContent);
const A_CASE = { id: '501', name: 'Asha Example', caseRef: '2026-SP-001', caseStage: 'Document Collection Started' };
const heldLead = (over = {}) => ({ id: '77', name: 'Asha Example', bookingStatus: 'Booked', bookedSlot: torontoIn(-60 * DAY).slice(0, 10) + ' 10:00', consultationHeld: torontoIn(-60 * DAY).slice(0, 10), outcome: 'Follow-Up', consultant: 'Shafoli Kapur', ...over });
async function lookedUp(w) { w.el('dq-email').fire('blur'); await w.settle(); }

test('money first, the form and the browser code: one hidden line under "Payment *", a greyed look for a choice that is not offered, and the two lines of words', () => {
  const form = DQ.dqFormHtml();
  assert.ok(form.includes('id="dq-pay"></div><div class="dq-hint" id="dq-pay-hint" style="display:none" aria-live="polite"></div><div id="dq-fee-w"'), 'right under the payment choices, empty and hidden');
  assert.match(DQ.DQ_CSS, /\.dq \.dq-seg label:has\(input:disabled\) \{ opacity:\.5; cursor:not-allowed; \}/);
  assert.ok(DQ.DQ_JS.includes("var DQ_PAY_FIRST='" + PAY_FIRST_LINE + "';") && DQ.DQ_JS.includes("var DQ_NO_FILE='" + NO_FILE_LINE + "';"));
  assert.ok(DQ.DQ_JS.includes('if(!o.moneyFirst) return true;') && DQ.DQ_JS.includes('if(!o.moneyFirst) return;'), 'switched off, the new code does nothing');
});

test('money first ON, pop-up: "Not paid yet" stays in its place but is greyed for a new person the app does not know, and the line under Payment says why; it is live for "existing client" + a case found, and greyed (and unticked) again when the choice goes back to new', async () => {
  const w = popupWorld({ ...ON, matches: { clients: [], cases: [A_CASE], leads: [] } });
  assert.deepEqual(w.R['dq-pay'].map((r) => r.value), ['square', 'cash', 'e-transfer', 'waived', 'none'], 'five choices, the same order');
  assert.equal(offered(w), false, 'greyed from the start: nothing is known yet');
  assert.equal(hint(w), PAY_FIRST_LINE);
  for (const r of w.R['dq-pay']) if (r.value !== 'none') assert.notEqual(r.disabled, true, r.value + ' is always offered');
  filled(w);                       // a new client, a time three days ahead — the look-up has not answered yet
  assert.equal(offered(w), false); assert.equal(hint(w), PAY_FIRST_LINE);
  await lookedUp(w);               // the app finds a case — but a NEW matter pays first, file or no file (decision 4)
  assert.equal(offered(w), false, 'a new matter pays first even for someone who has a file');
  assert.equal(hint(w), PAY_FIRST_LINE);
  w.pickRadio('dq-choice', 'existing');
  assert.equal(offered(w), true, '"Existing client: about their current file" + a case found');
  assert.equal(hint(w), '', 'nothing to explain');
  w.pickRadio('dq-pay', 'none');
  assert.equal(notPaid(w).checked, true);
  assert.equal(w.el('dq-fee-w').style.display, 'none');
  // back to a new matter: greyed again AND unticked — the payment must be chosen again
  w.pickRadio('dq-choice', 'new');
  assert.equal(offered(w), false); assert.equal(notPaid(w).checked, false, 'unticked');
  assert.equal(hint(w), PAY_FIRST_LINE);
  w.el('dq-save').onclick();
  assert.equal(w.el('dq-err').textContent, 'Choose the payment.');
  assert.equal(w.posts.length, 0);
  // existing again, "Not paid yet": it saves as before, with no fee
  w.pickRadio('dq-choice', 'existing'); w.pickRadio('dq-pay', 'none');
  w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1);
  assert.deepEqual([w.posts[0].body.choice, w.posts[0].body.payment], ['existing', { kind: 'none' }]);
});

test('money first ON, pop-up: "existing client" picked but no file found — greyed, and the line says the app finds no file; a matched lead that has a case counts as a file', async () => {
  let w = popupWorld({ ...ON, matches: { clients: [], cases: [], leads: [{ id: '90', name: 'Asha Example', bookingStatus: 'Abandoned' }] } });
  filled(w, { choice: 'existing' }); await lookedUp(w);
  assert.equal(offered(w), false);
  assert.equal(hint(w), NO_FILE_LINE);
  // "Free" is always there: for an existing client the reason box opens filled, and it saves
  w.pickRadio('dq-pay', 'waived');
  assert.equal(w.el('dq-reason').value, 'Existing client — about their current file');
  w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1); assert.equal(w.posts[0].body.payment.kind, 'waived');
  // back to new: the general line
  w.pickRadio('dq-choice', 'new');
  assert.equal(hint(w), PAY_FIRST_LINE);
  // a lead linked to a case is a file
  w = popupWorld({ ...ON, matches: { clients: [], cases: [], leads: [{ id: '88', name: 'Asha Example', hasCase: true, conversionStatus: 'Retained' }] } });
  filled(w, { choice: 'existing' }); await lookedUp(w);
  assert.equal(offered(w), true); assert.equal(hint(w), '');
  // no email / phone typed yet: greyed — but the app has not looked, so it does not say "finds no file"
  w = popupWorld(ON);
  w.pickRadio('dq-choice', 'existing');
  assert.equal(offered(w), false); assert.equal(hint(w), TYPE_FIRST_LINE);
  // an email that is taken out again is "nothing typed" again
  filled(w, { choice: 'existing' }); await lookedUp(w);
  assert.equal(hint(w), NO_FILE_LINE);
  w.type('dq-email', ''); await lookedUp(w);
  assert.equal(offered(w), false); assert.equal(hint(w), TYPE_FIRST_LINE);
});

/* The line under Payment says what the app KNOWS (review 2026-11-20): "finds no file" only after a look-up that
   answered. And one failed look-up never takes a ticked "Not paid yet" away from a client whose file is on screen. */
const http500 = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Something went wrong' }) });
const WITH_CASE = { clients: [], cases: [A_CASE], leads: [] };
const NOTHING = { clients: [], cases: [], leads: [] };

test('money first ON, pop-up: the four lines for "existing client" with no file held are in the browser code — nothing typed, looking, could not look, no file', () => {
  for (const [name, line] of [['DQ_TYPE_FIRST', TYPE_FIRST_LINE], ['DQ_LOOKING', LOOKING_LINE], ['DQ_LOOK_FAILED', LOOK_FAILED_LINE], ['DQ_NO_FILE', NO_FILE_LINE]]) {
    assert.ok(DQ.DQ_JS.includes('var ' + name + "='" + line + "';"), name);
  }
});

test('money first ON, pop-up: while the look-up is still running the line says "Looking…", never "finds no file"; it goes when the answer comes', async () => {
  const w = popupWorld(ON);
  let answer; w.net.lookup = () => new Promise((res) => { answer = res; });
  filled(w, { choice: 'existing' });
  w.el('dq-email').fire('blur'); await w.settle();          // asked, no answer yet
  assert.equal(offered(w), false, 'greyed while nothing is known');
  assert.equal(hint(w), LOOKING_LINE);
  answer({ ok: true, status: 200, json: () => Promise.resolve(WITH_CASE) }); await w.settle();
  assert.equal(offered(w), true); assert.equal(hint(w), '');
  // a slow answer of "nothing found" ends in the true line
  const w2 = popupWorld(ON);
  let answer2; w2.net.lookup = () => new Promise((res) => { answer2 = res; });
  filled(w2, { choice: 'existing' }); w2.el('dq-email').fire('blur'); await w2.settle();
  assert.equal(hint(w2), LOOKING_LINE);
  answer2({ ok: true, status: 200, json: () => Promise.resolve(NOTHING) }); await w2.settle();
  assert.equal(offered(w2), false); assert.equal(hint(w2), NO_FILE_LINE);
});

test('money first ON, pop-up: ONE failed look-up (an HTTP 500, or no connection) after "Not paid yet" was ticked keeps the tick, the file on screen and the choice — the email and phone are the same ones', async () => {
  for (const [what, failure] of [['HTTP 500', http500], ['no connection', () => Promise.reject(new Error('offline'))], ['an answer that is not JSON', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad')) })]]) {
    const w = popupWorld({ ...ON, matches: WITH_CASE });
    filled(w, { choice: 'existing' }); await lookedUp(w);
    w.pickRadio('dq-pay', 'none');
    assert.equal(notPaid(w).checked, true, what);
    const panel = w.el('dq-match').innerHTML;
    assert.ok(panel.includes('2026-SP-001'), 'the case is listed');
    w.net.lookup = failure;
    await lookedUp(w);                                        // leaving the email box again: the look-up fails this once
    assert.equal(notPaid(w).checked, true, what + ': the tick stays');
    assert.equal(offered(w), true, what + ': still offered');
    assert.equal(hint(w), '', what + ': no false line');
    assert.equal(w.el('dq-match').innerHTML, panel, what + ': the file found a moment ago is still shown');
    w.pickRadio('dq-pay', 'waived');
    assert.equal(w.el('dq-reason').value, 'Existing client — about their current file', 'Free still works as before');
    w.pickRadio('dq-pay', 'none');
    w.el('dq-save').onclick(); await w.settle();
    assert.equal(w.posts.length, 1, what);
    assert.deepEqual([w.posts[0].body.choice, w.posts[0].body.payment], ['existing', { kind: 'none' }], 'the server is the judge on Save');
  }
});

test('money first ON, pop-up: a failed look-up after the email was CHANGED empties the match — the file of the earlier email never vouches for the new one; the line says the app could not look, and the next good answer brings it back', async () => {
  for (const [what, failure] of [['HTTP 500', http500], ['no connection', () => Promise.reject(new Error('offline'))]]) {
    const w = popupWorld({ ...ON, matches: WITH_CASE });
    filled(w, { choice: 'existing' }); await lookedUp(w);
    w.pickRadio('dq-pay', 'none');
    assert.equal(offered(w), true);
    w.net.lookup = failure;
    w.el('dq-email').value = 'someone.else@example.com';
    await lookedUp(w);
    assert.equal(w.el('dq-match').innerHTML, '', what + ': the panel is emptied');
    assert.equal(offered(w), false, what); assert.equal(notPaid(w).checked, false, what + ': unticked');
    assert.equal(hint(w), LOOK_FAILED_LINE, what + ': not "finds no file" — the app did not look');
    w.net.lookup = null;                                      // the look-up works again
    await lookedUp(w);
    assert.equal(offered(w), true, what); assert.equal(hint(w), '');
  }
  // the very first look-up fails: nothing is held, the line says so; a phone number alone works the same way
  const w = popupWorld(ON);
  w.net.lookup = http500;
  w.pickRadio('dq-choice', 'existing'); w.type('dq-phone', '416 555 0100'); w.el('dq-phone').fire('blur'); await w.settle();
  assert.equal(offered(w), false); assert.equal(hint(w), LOOK_FAILED_LINE);
  // a new matter keeps the general line whatever the look-up did
  w.pickRadio('dq-choice', 'new');
  assert.equal(hint(w), PAY_FIRST_LINE);
});

test('money first ON, pop-up: the app looked and found no file, then one look-up for the SAME email fails — the line still says "finds no file" (that answer stands)', async () => {
  const w = popupWorld({ ...ON, matches: NOTHING });
  filled(w, { choice: 'existing' }); await lookedUp(w);
  assert.equal(hint(w), NO_FILE_LINE);
  w.net.lookup = http500;
  await lookedUp(w);
  assert.equal(offered(w), false); assert.equal(hint(w), NO_FILE_LINE);
  // and asking again for the same email does not flicker through "Looking…"
  let answer; w.net.lookup = () => new Promise((res) => { answer = res; });
  w.el('dq-email').fire('blur'); await w.settle();
  assert.equal(hint(w), NO_FILE_LINE);
  answer({ ok: true, status: 200, json: () => Promise.resolve(WITH_CASE) }); await w.settle();
  assert.equal(offered(w), true); assert.equal(hint(w), '');
});

test('money first OFF, pop-up: a failed look-up behaves exactly as before — an HTTP 500 empties the match panel, a lost connection leaves it; no line, nothing greyed', async () => {
  for (const options of [{}, { moneyFirst: false }]) {
    const w = popupWorld({ options, matches: WITH_CASE });
    filled(w, { choice: 'existing' }); await lookedUp(w);
    w.pickRadio('dq-pay', 'none');
    const panel = w.el('dq-match').innerHTML;
    assert.ok(panel.includes('2026-SP-001'));
    w.net.lookup = () => Promise.reject(new Error('offline'));
    await lookedUp(w);
    assert.equal(w.el('dq-match').innerHTML, panel, 'a lost connection: left as it was');
    w.net.lookup = http500;
    await lookedUp(w);
    assert.equal(w.el('dq-match').innerHTML, '', 'an HTTP 500: emptied, as before');
    assert.equal(notPaid(w).checked, true, 'the tick is never taken away');
    assert.notEqual(notPaid(w).disabled, true);
    assert.equal(w.el('dq-pay-hint').textContent, ''); assert.notEqual(w.el('dq-pay-hint').style.display, '');
  }
});

test('money first ON, pop-up: live for a time that has ALREADY PASSED (entered late), for anyone; greyed again when the time is moved ahead', async () => {
  const w = popupWorld(ON);
  filled(w, { when: torontoIn(-2 * DAY).slice(0, 10) + 'T10:15' });
  assert.equal(offered(w), true, 'a past consultation, a new client: allowed (it then shows the red "Not paid")');
  assert.equal(hint(w), '');
  w.pickRadio('dq-pay', 'none');
  w.type('dq-when', torontoIn(3 * DAY).slice(0, 10) + 'T11:00', 'change');
  assert.equal(offered(w), false, 'moved to a time ahead'); assert.equal(notPaid(w).checked, false); assert.equal(hint(w), PAY_FIRST_LINE);
  w.type('dq-when', torontoIn(-1 * DAY).slice(0, 10) + 'T09:00', 'change');
  assert.equal(offered(w), true);
  w.pickRadio('dq-pay', 'none');
  w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1);
  assert.deepEqual([w.posts[0].body.choice, w.posts[0].body.payment, w.posts[0].body.inSquare], ['new', { kind: 'none' }, null]);
});

test('money first ON, pop-up: live for a follow-up (a new matter after an earlier held consultation, no file) — by the server\'s own rule; not when the person has a file, the earlier row was never held, or the held day is not before this one', async () => {
  let w = popupWorld({ ...ON, matches: { clients: [], cases: [], leads: [heldLead()] } });
  filled(w); await lookedUp(w);
  assert.equal(offered(w), true, 'a follow-up'); assert.equal(hint(w), '');
  w.pickRadio('dq-pay', 'none'); w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1); assert.deepEqual(w.posts[0].body.payment, { kind: 'none' });
  for (const [why, matches] of [
    ['has a file', { clients: [], cases: [A_CASE], leads: [heldLead()] }],
    ['a linked case', { clients: [], cases: [], leads: [heldLead({ hasCase: true })] }],
    ['never held', { clients: [], cases: [], leads: [heldLead({ consultationHeld: '' })] }],
    ['not Booked', { clients: [], cases: [], leads: [heldLead({ bookingStatus: 'Abandoned' })] }],
    ['held later than this one', { clients: [], cases: [], leads: [heldLead({ consultationHeld: torontoIn(5 * DAY).slice(0, 10) })] }],
    ['held the same day', { clients: [], cases: [], leads: [heldLead({ consultationHeld: torontoIn(3 * DAY).slice(0, 10) })] }],
  ]) {
    w = popupWorld({ ...ON, matches });
    filled(w); await lookedUp(w);
    assert.equal(offered(w), false, why); assert.equal(hint(w), PAY_FIRST_LINE, why);
  }
  // the lead picked in "Use this lead" is left out of the rule, as on the server: the check runs again when it changes
  w = popupWorld({ ...ON, matches: { clients: [], cases: [], leads: [heldLead()] } });
  const use = Object.assign(fakeEl('dq-use:77'), { value: '77', name: 'dq-use' });
  w.R['dq-use'].push(use);
  filled(w); await lookedUp(w);
  assert.equal(offered(w), true);
  assert.equal(typeof use.onchange, 'function', 'bound');
  use.checked = true; use.onchange({});
  assert.equal(offered(w), false, 'that lead is the consultation itself, not an earlier one');
});

test('money first ON, pop-up: the server is the judge — its refusal (400) keeps the form OPEN with what was typed and shows its words', async () => {
  const words = 'A new client pays first — nothing was saved. Choose how the fee was paid, or “Free” with the reason. “Not paid yet” is only for an existing client (about their current file) or a follow-up.';
  // a page whose options are older than the switch (it still offers "Not paid yet"); the server refuses
  const w = popupWorld({ answer: { s: 400, j: { error: words } } });
  filled(w); w.pickRadio('dq-pay', 'none');
  w.el('dq-save').onclick(); await w.settle();
  assert.equal(w.posts.length, 1);
  assert.equal(w.el('dq-err').textContent, words);
  assert.equal(w.dlg.closed, undefined, 'still open');
  assert.deepEqual([w.el('dq-name').value, w.el('dq-email').value, w.el('dq-about').value, w.el('dq-when').value !== '', notPaid(w).checked], ['Asha Example', 'asha@example.com', 'question about the file', true, true], 'nothing typed is lost');
  assert.equal(w.ctx.reloaded, undefined, 'the list is not re-read: nothing was saved');
  assert.notEqual(w.el('dq-save').disabled, true, 'Save works again — choose the payment and save');
});

test('money first OFF, pop-up: exactly as before — "Not paid yet" is never greyed, the line under Payment stays hidden and empty, nothing is bound to "Use this lead"', async () => {
  for (const options of [{}, { moneyFirst: false }, { moneyFirst: 0 }, { moneyFirst: '' }]) {
    const w = popupWorld({ options, matches: { clients: [], cases: [], leads: [heldLead()] } });
    const use = Object.assign(fakeEl('dq-use:77'), { value: '77', name: 'dq-use' });
    w.R['dq-use'].push(use);
    const same = () => { assert.notEqual(notPaid(w).disabled, true, JSON.stringify(options)); assert.equal(w.el('dq-pay-hint').textContent, ''); assert.notEqual(w.el('dq-pay-hint').style.display, ''); };
    same();
    filled(w); same();
    await lookedUp(w); same();
    assert.equal(use.onchange, undefined, 'nothing new is bound');
    w.pickRadio('dq-choice', 'existing'); same();
    w.pickRadio('dq-choice', 'new'); same();
    w.pickRadio('dq-pay', 'none');
    w.type('dq-when', torontoIn(6 * DAY).slice(0, 10) + 'T11:00', 'change'); same();
    assert.equal(notPaid(w).checked, true, 'the tick is never taken away');
    w.el('dq-save').onclick(); await w.settle();
    assert.equal(w.posts.length, 1, 'a new client, a time ahead, "Not paid yet": sent as before');
    assert.deepEqual([w.posts[0].body.choice, w.posts[0].body.payment], ['new', { kind: 'none' }]);
  }
});

test('pop-up: the look-up finds a live booking for the person — saving needs "This is a different consultation"', async () => {
  const slotDay = torontoIn(4 * DAY).slice(0, 10);
  const w = popupWorld({ matches: { clients: [], cases: [], leads: [{ id: '77', name: 'Asha Example', bookingStatus: 'Booked', bookedSlot: slotDay + ' 09:00', consultant: 'Shafoli Kapur', outcome: '' }] } });
  w.type('dq-name', 'Asha Example'); w.type('dq-email', 'asha@example.com'); w.el('dq-email').fire('blur');
  await w.settle();
  assert.match(w.el('dq-match').innerHTML, /A consultation for this person is already in the app/);
  assert.match(w.el('dq-match').innerHTML, /\/admin\/consultation\/77/);
  w.pickRadio('dq-choice', 'new');
  w.el('dq-consultant').value = 'Shafoli Kapur'; w.el('dq-consultant').onchange();
  w.pickRadio('dq-how', 'In-person'); w.type('dq-when', slotDay + 'T15:00', 'change');
  w.pickRadio('dq-pay', 'none'); w.type('dq-about', 'second matter'); w.el('dq-source').value = 'Walk-in'; w.pickRadio('dq-sq', 'yes');
  w.el('dq-save').onclick();
  assert.equal(w.posts.length, 0);
  assert.match(w.el('dq-err').textContent, /different consultation/);
  w.el('dq-diff').checked = true;
  w.el('dq-save').onclick();
  await w.settle();
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].body.differentConsultation, true);
});

test('pop-up: the server\'s clash warning offers "Save anyway", which sends clashAck; a 503 says not set up', async () => {
  const w = popupWorld({ answer: { s: 409, j: { error: 'Shafoli Kapur already has a consultation at …', code: 'clash', clash: [{ leadId: '5', name: 'Other', slot: 'x', consultant: 'Shafoli Kapur', link: '/admin/consultation/5' }] } } });
  w.type('dq-name', 'Asha Example'); w.type('dq-phone', '4165550101');
  w.pickRadio('dq-choice', 'existing');
  w.el('dq-consultant').value = 'Shafoli Kapur'; w.el('dq-consultant').onchange();
  w.pickRadio('dq-how', 'In-person'); w.type('dq-when', torontoIn(-1 * DAY).slice(0, 10) + 'T12:00', 'change');
  w.pickRadio('dq-pay', 'none'); w.type('dq-about', 'file question');
  w.el('dq-save').onclick();
  await w.settle();
  assert.match(w.el('dq-server').innerHTML, /Save anyway \(different client\)/);
  assert.equal(w.dlg.closed, undefined, 'stays open');
  w.el('dq-anyway').onclick();
  await w.settle();
  assert.equal(w.posts.length, 2);
  assert.equal(w.posts[1].body.clashAck, true);

  const w2 = popupWorld({ answer: { s: 503, j: { error: 'Direct consultation is not set up yet: its Lead Board column has not been made. Nothing was saved.' } } });
  w2.type('dq-name', 'Asha Example'); w2.type('dq-phone', '4165550101');
  w2.pickRadio('dq-choice', 'existing'); w2.el('dq-consultant').value = 'Shafoli Kapur';
  w2.pickRadio('dq-how', 'In-person'); w2.type('dq-when', torontoIn(-1 * DAY).slice(0, 10) + 'T12:00', 'change');
  w2.pickRadio('dq-pay', 'none'); w2.type('dq-about', 'file question');
  w2.el('dq-save').onclick();
  await w2.settle();
  assert.match(w2.el('dq-err').textContent, /not set up yet/);
});

test('the button: shown only on 200, greyed on 503 (not set up), hidden on 404 (switched off) and 401', async () => {
  for (const [status, hidden, disabled] of [[200, false, false], [503, false, true], [404, true, false], [401, true, false]]) {
    const b = fakeEl('btn-direct-consult'); b.hidden = true;
    const ctx = {
      document: { getElementById: (id) => (id === 'btn-direct-consult' ? b : null) }, peekKey: () => 'k', Intl, Date,
      fetch: () => Promise.resolve({ status, json: () => Promise.resolve(status === 200 ? OPTIONS : { error: status === 503 ? 'Direct consultation is not set up yet.' : 'Not found' }) }),
    };
    vm.createContext(ctx);
    vm.runInContext(DQ.DQ_JS + '\ndqInitButton();', ctx);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.hidden, hidden, `HTTP ${status}: hidden`);
    if (!hidden) assert.equal(b.disabled, disabled, `HTTP ${status}: disabled`);
  }
});

/* ── the look-up carries where each lead stands (additive fields) ── */

test('client-matches: each lead says its outcome, booking, consultant and whether it is a direct consultation', async () => {
  const leadService = require('../src/services/leadService');
  const cm = require('../src/services/clientMasterService');
  const ca = require('../src/services/clientAccountService');
  const portal = require('../src/services/consultantPortalService');
  const restore = [];
  const stub = (o, k, f) => { const orig = o[k]; o[k] = f; restore.push(() => { o[k] = orig; }); };
  stub(leadService, 'findAllByColumnValue', async (col) => (col === 'email' ? [
    { id: '1', fullName: 'Asha', email: 'a@example.com', outcome: 'Follow-Up', bookingStatus: 'Booked', bookedSlot: '2026-11-01 10:00', consultationHeld: ' 2026-11-01 ', assignedConsultant: 'Shafoli Kapur', consultOption: '' },
    { id: '2', fullName: 'Asha', email: 'a@example.com', bookingStatus: 'Booked', bookedSlot: '2026-11-12 10:00', consultOption: JSON.stringify({ directConsult: { kind: 'Existing client' } }) },
  ] : []));
  stub(cm, 'findCasesByEmail', async () => []);
  stub(cm, 'findCasesByPhone', async () => []);
  stub(ca, 'findMatches', async () => []);
  try {
    const m = await portal.findClientMatches({ email: 'a@example.com' });
    const [a, b] = m.leads;
    assert.deepEqual({ o: a.outcome, s: a.bookingStatus, t: a.bookedSlot, c: a.consultant, d: a.directConsult }, { o: 'Follow-Up', s: 'Booked', t: '2026-11-01 10:00', c: 'Shafoli Kapur', d: '' });
    assert.equal(b.directConsult, 'Existing client');
    // money first (2026-11-20): each lead also says the day its consultation was held ('' = none), so the pop-up can use the server's follow-up rule
    assert.deepEqual([a.consultationHeld, b.consultationHeld], ['2026-11-01', '']);
    assert.equal('rawLeads' in m, false, 'the raw rows never go to a page');
  } finally { restore.reverse().forEach((f) => f()); }
});

test('live fix 2026-11-09: the hidden button really hides (the .btn-direct display rule beats the hidden attribute)', () => {
  const { DQ_CSS, DQ_BUTTON_HTML } = require('../src/routes/directConsultUi');
  assert.match(DQ_BUTTON_HTML, /id="btn-direct-consult"[^>]*\bhidden\b/);
  assert.match(DQ_CSS, /#btn-direct-consult\[hidden\]\s*\{\s*display:\s*none/);
});
