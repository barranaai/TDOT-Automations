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
  for (const s of ['id="snap-age"', 'id="needs-outcome"', 'id="nodate"', "<a href=\"/admin/retainers\">Retainers &amp; follow-ups</a>"]) assert.ok(q.includes(s), s);
});

test('the list: the "direct" pill with who booked it and the kind; an Existing-client row is never under "Needs outcome"', () => {
  const page = scriptsOf(C.buildQueueHTML())[0];
  const pick = (name) => { const i = page.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = page.indexOf('{', i); for (; j < page.length; j++) { if (page[j] === '{') depth++; else if (page[j] === '}' && --depth === 0) break; } return page.slice(i, j + 1); };
  const ctx = { escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext([pick('dParts'), pick('directPill'), pick('consultBucket')].join('\n'), ctx);
  assert.equal(ctx.directPill({ name: 'A' }), '', 'a normal row has no pill');
  const p = ctx.directPill({ direct: 'Follow-up', bookedBy: 'Melanie' });
  assert.match(p, />direct<\/span>$/);
  assert.match(p, /title="Booked by Melanie · Follow-up"/);
  assert.match(ctx.directPill({ direct: '?', bookedBy: '' }), /title="Direct consultation"/);
  assert.match(ctx.directPill({ direct: 'New', bookedBy: '<b>x' }), /Booked by &lt;b&gt;x/, 'escaped');
  const t = '2026-11-09';
  assert.equal(ctx.consultBucket({ bookedSlot: '2026-11-02 10:00' }, t), 'needs', 'a past consultation with no outcome');
  assert.equal(ctx.consultBucket({ bookedSlot: '2026-11-02 10:00', direct: 'New' }, t), 'needs', 'a direct New one too');
  assert.equal(ctx.consultBucket({ bookedSlot: '2026-11-02 10:00', direct: 'Follow-up' }, t), 'needs', 'a follow-up too');
  assert.equal(ctx.consultBucket({ bookedSlot: '2026-11-02 10:00', direct: 'Existing client' }, t), 'main', 'about their current file: nothing to decide');
  assert.equal(ctx.consultBucket({ bookedSlot: '' }, t), 'nodate');
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

function popupWorld({ matches = null, answer = { s: 200, j: { ok: true, message: 'Saved.', link: '/admin/consultation/9', left: [] } } } = {}) {
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
      if (String(url).startsWith('/api/consultation/client-matches')) return Promise.resolve({ ok: true, json: () => Promise.resolve(matches || { clients: [], cases: [], leads: [] }) });
      posts.push({ url, body: JSON.parse(o.body) });
      return Promise.resolve({ status: answer.s, json: () => Promise.resolve(answer.j) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DQ.DQ_JS + '\nDQ_OPTS=' + JSON.stringify(OPTIONS) + ';\nopenDirectConsult();', ctx);
  const pickRadio = (n, v) => { R[n].forEach((r) => { r.checked = r.value === v; }); const r = R[n].find((x) => x.value === v); if (r && r.onchange) r.onchange({}); };
  const type = (id, v, ev = 'input') => { el(id).value = v; el(id).fire(ev); };
  return { el, R, pickRadio, type, posts, dlg, ctx, settle: () => new Promise((r) => setTimeout(r, 20)) };
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
  w.type('dq-about', 'visitor visa'); w.el('dq-source').value = 'Walk-in'; w.pickRadio('dq-sq', 'no');
  w.el('dq-save').onclick();
  await w.settle();
  const b = w.posts[0].body;
  assert.equal(b.payment.kind, 'waived'); assert.equal('amountCents' in b.payment, false);
  assert.equal(b.inSquare, false); assert.equal(b.inCanada, 'No'); assert.equal(b.currentCountry, 'India');
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
    { id: '1', fullName: 'Asha', email: 'a@example.com', outcome: 'Follow-Up', bookingStatus: 'Booked', bookedSlot: '2026-11-01 10:00', assignedConsultant: 'Shafoli Kapur', consultOption: '' },
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
    assert.equal('rawLeads' in m, false, 'the raw rows never go to a page');
  } finally { restore.reverse().forEach((f) => f()); }
});

test('live fix 2026-11-09: the hidden button really hides (the .btn-direct display rule beats the hidden attribute)', () => {
  const { DQ_CSS, DQ_BUTTON_HTML } = require('../src/routes/directConsultUi');
  assert.match(DQ_BUTTON_HTML, /id="btn-direct-consult"[^>]*\bhidden\b/);
  assert.match(DQ_CSS, /#btn-direct-consult\[hidden\]\s*\{\s*display:\s*none/);
});
