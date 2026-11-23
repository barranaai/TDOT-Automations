'use strict';

// "Follow-Up needs a date" (Gauri's answers H2 b + H4, built 2026-11-23) — the PAGE half.
// (The server half is test/followUpDate.test.js.)
//
// The switch FOLLOWUP_DATE_REQUIRED lives on the server and ships OFF. A page never decides it: the record detail and
// the lead detail carry followUpDateRequired, the lists' answer carries it only while it is on.
//   told "off" (or not told) = the pages are as before: Follow-Up saves in one click, no pill, no "not set" row.
//   told "on"  = the Follow-Up button opens ONE shared pop-up for the date (today or later, Toronto day) and the
//                page posts the label WITH the date; a Follow-Up row with no date shows "no follow-up date" (never on
//                the Retained tab); the lead page says "not set".
//   always     = "Save attribution" with the date box emptied asks first, and only the answer "Remove the date" sends
//                the remove mark — never before the record has loaded, never when the record had no date; the lead
//                page shows the follow-up date when there is one.
//
// The pages' own emitted code runs here against small fakes — nothing is started and nothing leaves the process.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const portal   = require('../src/services/consultantPortalService');
const outcomes = require('../config/outcomes');
const shared   = require('../src/routes/adminShared');
const ac       = require('../src/routes/adminConsultation');
const al       = require('../src/routes/adminLeads');
const FX       = require('./fixtures/consult-ready-frozen-4e4a63e.json');

const BACKSLASH = String.fromCharCode(92);
const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const firstScript = (html) => scriptsOf(html)[0];
/** The text of `function name(…){…}` in a script. */
function pickFn(js, name) { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, 'function ' + name); return braces(js, i); }
/** From `at`, the text up to the brace that closes the first one opened. */
function braces(js, at) { let depth = 0, j = js.indexOf('{', at); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(at, j + 1); }
/** A function expression that starts at the first `function(` after the marker. */
function handlerAfter(js, marker, from = 0) { const a = js.indexOf(marker, from); assert.ok(a >= 0, marker); return braces(js, js.indexOf('function(', a)); }

const NEEDED_HERE = 'Choose the follow-up date. Follow-Up cannot be saved without it.';
const LATER = '2026-11-27', TODAY = '2026-11-23', YESTERDAY = '2026-11-22';
// 12:00 in Toronto on Monday 23 November 2026.
const NOON = '2026-11-23T17:00:00Z';

/* ── the shared pop-up (src/routes/adminShared.js, beside the Not Wanted pop-up) ── */

const SHARED_JS = shared.BLACKLIST_UI_JS;
const FU_START = SHARED_JS.indexOf('/* ── "Follow-Up needs a date"');
const FU_JS = SHARED_JS.slice(FU_START);

/** The pop-up's own code against a fake box. `at` = the instant the browser's clock shows. */
function popup({ at = NOON, name = 'Test Client', saved = '', intl = Intl } = {}) {
  const els = {};
  const box = { innerHTML: '', focused: '',
    querySelector(sel) { return els[sel] || (els[sel] = { sel, value: '', textContent: '', onclick: null, onkeydown: null, focus() { box.focused = sel; } }); } };
  const p = { box, closed: 0, confirmed: [], order: [] };
  const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(at); } };
  const ctx = { Intl: intl, Date: FakeDate, setTimeout: (f) => f(),
    blEsc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    blOverlay: () => ({ box, close() { p.closed++; p.order.push('close'); return true; }, setBusy() {}, isOpen: () => p.closed === 0 }) };
  vm.createContext(ctx);
  vm.runInContext(['tdotIsDay', 'tdotTorontoDay', 'tdotOpenFollowUpModal'].map((n) => pickFn(SHARED_JS, n)).join('\n'), ctx);
  p.ctx = ctx;
  ctx.tdotOpenFollowUpModal({ name, saved, onConfirm(day) { p.confirmed.push(day); p.order.push('confirm'); } });
  p.input = box.querySelector('#blm-fu-date'); p.err = box.querySelector('.blm-err');
  p.save = () => box.querySelector('[data-go]').onclick();
  p.cancel = () => box.querySelector('[data-x]').onclick();
  return p;
}

test('the shared pop-up code follows the page-script rules (no backtick, no dollar-brace, no backslash), sits beside the Not Wanted pop-up and parses', () => {
  assert.ok(FU_START > SHARED_JS.indexOf('function tdotOpenNotWantedModal(o){'), 'after the Not Wanted pop-up, in the same shared script');
  for (const [what, s] of [['the whole shared script', SHARED_JS], ['the Follow-Up part', FU_JS]]) {
    assert.ok(!s.includes('`'), what + ': no backtick');
    assert.ok(!s.includes('${'), what + ': no dollar-brace');
    assert.ok(!s.includes(BACKSLASH), what + ': no backslash');
  }
  new vm.Script(SHARED_JS);
  assert.ok(FU_JS.includes('function tdotOpenFollowUpModal(o){'));
  assert.ok(FU_JS.includes('var d = blOverlay()'), 'built on the shared dialog, like the Not Wanted pop-up (one at a time)');
  // the switch is never written into the page script
  for (const html of [ac.buildQueueHTML(), ac.buildRetainersHTML(), ac.buildDetailHTML('555'), al.buildLeadDetailHTML('555')]) {
    assert.ok(!/process\.env|FOLLOWUP_DATE_REQUIRED\s*=/.test(scriptsOf(html).join('\n')), 'no page reads or sets the switch itself');
  }
});

test('the pop-up: the approved texts, one date box that starts at today (Toronto), Cancel before "Save Follow-Up"', () => {
  const p = popup();
  const h = p.box.innerHTML;
  assert.ok(h.includes('<h3 id="blm-title">Outcome: Follow-Up</h3>'));
  assert.ok(h.includes('<p>Choose the day to call <b>Test Client</b> back.</p>'));
  assert.equal(h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 'Outcome: Follow-Up Choose the day to call Test Client back. Follow-up date (required) Cancel Save Follow-Up');
  assert.ok(h.includes('<label for="blm-fu-date">Follow-up date (required)</label><input id="blm-fu-date" type="date" min="2026-11-23" max="9999-12-31">'));
  assert.equal((h.match(/<input/g) || []).length, 1, 'one box');
  assert.ok(h.includes('<button type="button" class="blm-btn" data-x>Cancel</button><button type="button" class="blm-btn primary" data-go>Save Follow-Up</button>'), 'Cancel first, then the main button');
  assert.ok(h.includes('<div class="blm-err" role="alert"></div>'));
  assert.equal(p.box.focused, '#blm-fu-date', 'the date box has the focus');
  assert.equal(p.input.value, '', 'nothing chosen for the person');
  assert.ok(!/Retainers|list|page/.test(h), 'nothing about which page the client shows on (a lead that never booked stays on the Leads list)');
  // a name is shown as text; no name still reads as a sentence
  assert.ok(popup({ name: 'A <b>"x"</b> & Co' }).box.innerHTML.includes('call <b>A &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; Co</b> back.'));
  assert.ok(popup({ name: '' }).box.innerHTML.includes('Choose the day to call <b>this client</b> back.'));
  // phone: a box in this pop-up is an <input>, which the shared rule makes 16px on a phone-sized screen
  assert.match(shared.NAV_CSS + shared.SHARED_CSS_VARS, /@media \(max-width: 760px\) \{\s*input:not\(\[type=checkbox\]\):not\(\[type=radio\]\):not\(\[type=file\]\):not\(\[type=button\]\):not\(\[type=submit\]\), select, textarea \{ font-size: 16px !important; \}/);
});

test('the pop-up refuses an empty date and a day before today with the exact words, stays open and sends nothing; today and later days close it and hand the day on', () => {
  let p = popup();
  p.save();
  assert.equal(p.err.textContent, NEEDED_HERE);
  assert.deepEqual([p.closed, p.confirmed, p.box.focused], [0, [], '#blm-fu-date'], 'still open, nothing sent, back in the box');
  p.input.value = YESTERDAY; p.save();
  assert.equal(p.err.textContent, portal.FOLLOW_UP_DATE_PAST, 'the server\'s own words');
  assert.equal(p.err.textContent, 'The follow-up date cannot be in the past. Choose today or a later day.');
  assert.deepEqual([p.closed, p.confirmed], [0, []]);
  p.input.value = '2025-12-31'; p.save();
  assert.deepEqual([p.err.textContent, p.closed], [portal.FOLLOW_UP_DATE_PAST, 0]);
  p.input.value = '202611-11-27'; p.save();
  assert.deepEqual([p.err.textContent, p.closed, p.confirmed], ['Follow-up date must be YYYY-MM-DD.', 0, []], 'a six-digit year: the date box\'s own words');
  p.input.value = TODAY; p.save();
  assert.deepEqual([p.closed, p.confirmed, p.order], [1, [TODAY], ['close', 'confirm']], 'today passes; the box closes, then the page saves');
  p = popup(); p.input.value = LATER; p.save();
  assert.deepEqual([p.closed, p.confirmed], [1, [LATER]]);
  // Enter in the date box is the main button
  p = popup(); p.input.value = LATER;
  let prevented = 0; p.input.onkeydown({ key: 'Enter', preventDefault() { prevented++; } });
  assert.deepEqual([p.closed, p.confirmed, prevented], [1, [LATER], 1]);
  p = popup(); p.input.onkeydown({ key: 'Tab' }); p.input.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual([p.closed, p.err.textContent], [0, NEEDED_HERE], 'Enter on an empty box says why');
  // Cancel closes and sends nothing
  p = popup(); p.input.value = LATER; p.cancel();
  assert.deepEqual([p.closed, p.confirmed], [1, []]);
});

test('"today" in the pop-up is the Toronto day, whatever the clock of the computer says', () => {
  // 22:30 on the 23rd in Toronto is already the 24th in UTC (and in Karachi): still the 23rd
  let p = popup({ at: '2026-11-24T03:30:00Z' });
  assert.ok(p.box.innerHTML.includes('min="2026-11-23"'));
  p.input.value = TODAY; p.save();
  assert.deepEqual(p.confirmed, [TODAY]);
  // 00:10 on the 24th in Toronto: the 23rd is past
  p = popup({ at: '2026-11-24T05:10:00Z' });
  assert.ok(p.box.innerHTML.includes('min="2026-11-24"'));
  p.input.value = TODAY; p.save();
  assert.deepEqual([p.err.textContent, p.confirmed], [portal.FOLLOW_UP_DATE_PAST, []]);
  // summer time: 23:30 on 30 June in Toronto (UTC-4)
  assert.ok(popup({ at: '2026-07-01T03:30:00Z' }).box.innerHTML.includes('min="2026-06-30"'));
  // the same day the server works out
  for (const at of [NOON, '2026-11-24T03:30:00Z', '2026-11-24T05:10:00Z', '2026-07-01T03:30:00Z']) {
    assert.equal(popup({ at }).ctx.tdotTorontoDay(), new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)));
  }
  // a browser that cannot say the Toronto day: no "min", no day check here — the server still checks
  const noIntl = { DateTimeFormat: function () { throw new Error('no time zones'); } };
  p = popup({ intl: noIntl, saved: YESTERDAY });
  assert.ok(!p.box.innerHTML.includes('min='));
  assert.equal(p.ctx.tdotTorontoDay(), '');
  p.input.value = ''; p.save();
  assert.equal(p.err.textContent, NEEDED_HERE, 'an empty box is still refused');
  const odd = { DateTimeFormat: function () { return { format: () => '11/23/2026' }; } };
  assert.equal(popup({ intl: odd }).ctx.tdotTorontoDay(), '', 'an answer that is not YYYY-MM-DD is not used');
});

test('the pop-up opens filled with the saved date only when that date is today or later; a past date, or text that is no date, leaves the box empty', () => {
  assert.equal(popup({ saved: LATER }).input.value, LATER);
  assert.equal(popup({ saved: TODAY }).input.value, TODAY);
  assert.equal(popup({ saved: ' ' + LATER + ' ' }).input.value, LATER);
  for (const saved of [YESTERDAY, '2025-01-01', '', null, undefined, 'soon', '27/11/2026']) assert.equal(popup({ saved }).input.value, '', 'not filled: ' + String(saved));
  // pressing Save on a pre-filled box saves that date again (the way to keep it); changing it sends the new one
  let p = popup({ saved: LATER }); p.save();
  assert.deepEqual(p.confirmed, [LATER]);
  p = popup({ saved: LATER }); p.input.value = '2026-12-04'; p.save();
  assert.deepEqual(p.confirmed, ['2026-12-04']);
});

/* ── every page still parses, and the lines other tests pin are still there ── */

test('every page: each emitted script parses; the pinned Not Wanted line and the pinned follow-up pill line are byte for byte; the outcome labels are the constants', () => {
  const pages = { consultations: ac.buildQueueHTML(), retainers: ac.buildRetainersHTML(), record: ac.buildDetailHTML('555'), lead: al.buildLeadDetailHTML('555'), leads: al.buildLeadsQueueHTML() };
  for (const [name, html] of Object.entries(pages)) {
    const scripts = scriptsOf(html);
    assert.ok(scripts.length >= 1, name);
    for (const src of scripts) { try { new vm.Script(src); } catch (e) { assert.fail(name + ': ' + e.message); } }
  }
  for (const html of [pages.record, pages.lead]) {
    assert.ok(html.includes('if(label===OUTCOME_NOT_WANTED){ tdotOpenNotWantedModal({'), 'the Not Wanted line is untouched');
    assert.ok(html.includes('var OUTCOME_NOT_WANTED="Not Wanted";'));
    assert.ok(html.includes('var OUTCOME_FOLLOW_UP="Follow-Up";'), 'the label comes from config/outcomes.js');
    assert.ok(html.includes('if(label===OUTCOME_FOLLOW_UP && '), 'the Follow-Up branch is a line of its own');
    assert.ok(html.includes('JSON.stringify({label:label, followUpDate:day})'), 'the label and the date in one value');
    assert.ok(html.includes('function tdotOpenFollowUpModal(o){'), 'the one shared pop-up');
    assert.equal(html.split('function tdotOpenFollowUpModal(o){').length - 1, 1, 'once on the page');
  }
  assert.equal(outcomes.OUTCOME_FOLLOW_UP, 'Follow-Up');
  for (const html of [pages.consultations, pages.retainers]) {
    assert.ok(html.includes("if(c.followUpDate) h+=' '+qpill(c.followUpDate<=todayStr()?'amber':'grey','follow-up '+c.followUpDate);"), 'the "follow-up <date>" line is untouched');
    assert.equal(pickFn(firstScript(html), 'outcomeCell'), FX.fn.outcomeCell, 'the outcome cell\'s own text is the frozen one');
  }
  assert.ok(pages.consultations.includes('var oc=outcomeCell(c);') && pages.retainers.includes("'<td>'+outcomeCell(c)+'</td>'"), 'both lists still draw the outcome through the one cell');
  // nothing of this on the Leads list (it has no outcome cell and its answer does not carry the switch)
  assert.ok(!pages.leads.includes('no follow-up date') && !pages.leads.includes('fuDateRule'));
});

/* ── the client record page: "Record outcome" ── */

/** The record page's own click handler for one outcome button, against fakes. */
function recordOutcomeClick(label, detail) {
  const js = firstScript(ac.buildDetailHTML('555'));
  const init = pickFn(js, 'initActions');
  const handler = handlerAfter(init, 'b.onclick=function(){');
  const r = { actions: [], notWanted: [], followUp: [] };
  const ctx = { LAST_DETAIL: detail, OUTCOME_NOT_WANTED: 'Not Wanted', OUTCOME_FOLLOW_UP: 'Follow-Up', JSON,
    doAction: (...a) => { r.actions.push(a); },
    tdotOpenNotWantedModal: (o) => { r.notWanted.push(o); },
    tdotOpenFollowUpModal: (o) => { r.followUp.push(o); } };
  vm.createContext(ctx);
  vm.runInContext(pickFn(js, 'fuDateRequired') + '\nvar CLICK=(function(label){ return ' + handler + '; });', ctx);
  ctx.CLICK(label)();
  return r;
}

test('record page, told the date is required: "Follow-Up" opens the pop-up (name and saved date from the record) and then posts the label WITH the date — a value the server accepts', () => {
  const r = recordOutcomeClick('Follow-Up', { name: 'Test Client', followUpDate: LATER, followUpDateRequired: true });
  assert.equal(r.actions.length, 0, 'nothing is saved by the click itself');
  assert.equal(r.followUp.length, 1);
  assert.deepEqual({ name: r.followUp[0].name, saved: r.followUp[0].saved }, { name: 'Test Client', saved: LATER });
  r.followUp[0].onConfirm('2026-12-04');
  assert.deepEqual(r.actions, [['outcome', '{"label":"Follow-Up","followUpDate":"2026-12-04"}']]);
  assert.deepEqual(portal.validateAction('outcome', r.actions[0][1]), { ok: true, normalized: 'Follow-Up', reason: '', followUpDate: '2026-12-04' });
  // a record with no saved date: the box opens empty
  assert.equal(recordOutcomeClick('Follow-Up', { name: 'Test Client', followUpDate: '', followUpDateRequired: true }).followUp[0].saved, '');
});

test('record page, not told so (switch off, an older answer, or the record has not arrived yet): "Follow-Up" saves in one click exactly as before', () => {
  for (const detail of [{ name: 'Test Client', followUpDateRequired: false }, { name: 'Test Client' }, { name: 'Test Client', followUpDateRequired: 'true' }, { name: 'Test Client', followUpDateRequired: 1 }, null]) {
    const r = recordOutcomeClick('Follow-Up', detail);
    assert.deepEqual(r.actions, [['outcome', 'Follow-Up']], JSON.stringify(detail));
    assert.equal(r.followUp.length, 0, 'no pop-up');
  }
  // the flag is read at the click, from the record as loaded — never when the buttons are built
  const js = firstScript(ac.buildDetailHTML('555'));
  assert.equal(pickFn(js, 'fuDateRequired'), 'function fuDateRequired(){ return !!(LAST_DETAIL && LAST_DETAIL.followUpDateRequired===true); }');
  assert.ok(js.indexOf('\ninitActions();') < js.lastIndexOf('load();'), 'the buttons are built before the record is asked for');
});

test('record page: Newsletter stays one click and Not Wanted still asks for its reason, whatever the switch; Retain is not a quick button', () => {
  for (const required of [true, false]) {
    const detail = { name: 'Test Client', followUpDate: LATER, followUpDateRequired: required };
    const n = recordOutcomeClick('Newsletter', detail);
    assert.deepEqual([n.actions, n.followUp.length, n.notWanted.length], [[['outcome', 'Newsletter']], 0, 0]);
    const w = recordOutcomeClick('Not Wanted', detail);
    assert.deepEqual([w.actions, w.followUp.length, w.notWanted.length], [[], 0, 1]);
    w.notWanted[0].onConfirm('rude to staff');
    assert.deepEqual(w.actions, [['outcome', '{"label":"Not Wanted","reason":"rude to staff"}']]);
  }
  assert.ok(pickFn(firstScript(ac.buildDetailHTML('555')), 'initActions').includes("if(label==='Retain') return;"));
});

/* ── the client record page: "Save attribution" and the emptied date box ── */

/** The record page's own "Save attribution" handler against fakes. answer = what the person answers to the question. */
function attributionSave({ detail, box = '', badInput = false, owner = 'Staff One', answer } = {}) {
  const js = firstScript(ac.buildDetailHTML('555'));
  const handler = handlerAfter(pickFn(js, 'initActions'), "document.getElementById('btn-attr-save').onclick=function(){");
  const els = { 'at-followup': { value: box, validity: { badInput } }, 'at-owner': { value: owner }, 'at-bookedby': { value: '' }, 'at-reviewer': { value: 'Staff Two' } };
  const r = { sent: [], asked: [], msgs: [], els };
  const ctx = { LAST_DETAIL: detail, OUTCOME_FOLLOW_UP: 'Follow-Up', FOLLOW_UP_DATE_KEPT: portal.FOLLOW_UP_DATE_KEPT, JSON, String,
    document: { getElementById: (id) => els[id] },
    doAction: (action, value, confirmMsg) => { r.sent.push({ action, value: JSON.parse(value), confirmMsg }); },
    setMsg: (text, kind) => { r.msgs.push([text, kind]); },
    askRemoveFollowUpDate: (day, done) => { r.asked.push(day); if (answer !== undefined) done(answer); } };
  vm.createContext(ctx);
  vm.runInContext(pickFn(js, 'fuDateRequired') + '\nvar SAVE=' + handler + ';', ctx);
  ctx.SAVE();
  return r;
}
const REST = { leadOwner: 'Staff One', bookedBy: '', paymentReviewedBy: 'Staff Two' };

test('Save attribution, the date box emptied on a record that HAD a date: the page asks first, and only "Remove the date" sends the remove mark', () => {
  const detail = { name: 'Test Client', outcome: 'Newsletter', followUpDate: LATER, followUpDateRequired: false };
  // asked, not answered yet: nothing is sent
  let r = attributionSave({ detail });
  assert.deepEqual([r.asked, r.sent], [[LATER], []]);
  // "Remove the date"
  r = attributionSave({ detail, answer: 'remove' });
  assert.deepEqual(r.sent, [{ action: 'saveAttribution', value: { followUpDate: '', ...REST, removeFollowUpDate: true }, confirmMsg: null }]);
  const v = portal.validateAction('saveAttribution', JSON.stringify(r.sent[0].value));
  assert.equal(v.ok && v.normalized.removeFollowUpDate, true, 'the server reads the mark');
  // "Keep the date": the other three boxes are saved, NOTHING is sent for the date, and the old date is back in the box
  r = attributionSave({ detail, answer: 'keep' });
  assert.deepEqual(r.sent, [{ action: 'saveAttribution', value: { followUpDate: '', ...REST }, confirmMsg: null }]);
  assert.ok(!('removeFollowUpDate' in r.sent[0].value), 'no mark');
  assert.equal(portal.validateAction('saveAttribution', JSON.stringify(r.sent[0].value)).normalized.removeFollowUpDate, false);
  assert.equal(r.els['at-followup'].value, LATER, 'the old date is back in the box');
  // closed with × or Escape: nothing is saved at all, and the page says so
  r = attributionSave({ detail, answer: '' });
  assert.deepEqual([r.sent, r.msgs, r.els['at-followup'].value], [[], [['Nothing was saved.', 'info']], LATER]);
  // the same on a record told the date is required, when the outcome is not Follow-Up
  r = attributionSave({ detail: { ...detail, followUpDateRequired: true }, answer: 'remove' });
  assert.equal(r.sent[0].value.removeFollowUpDate, true);
});

test('Save attribution never sends the remove mark when the record has not loaded, had no date, or the box holds a date — those saves go exactly as before', () => {
  const plain = (r, date) => { assert.deepEqual(r.asked, []); assert.deepEqual(r.sent, [{ action: 'saveAttribution', value: { followUpDate: date, ...REST }, confirmMsg: null }]); };
  // pressed before the record arrived: every box still empty
  plain(attributionSave({ detail: null }), '');
  // a record with no date, box left empty
  plain(attributionSave({ detail: { outcome: 'Newsletter', followUpDate: '' } }), '');
  plain(attributionSave({ detail: { outcome: 'Follow-Up', followUpDate: '', followUpDateRequired: true } }), '');
  plain(attributionSave({ detail: { outcome: '', followUpDate: '   ' } }), '');
  // a date in the box: saved as before, past days included ("Save attribution" keeps taking any real date)
  plain(attributionSave({ detail: { outcome: 'Newsletter', followUpDate: '' }, box: LATER }), LATER);
  plain(attributionSave({ detail: { outcome: 'Newsletter', followUpDate: LATER }, box: '2026-12-04' }), '2026-12-04');
  plain(attributionSave({ detail: { outcome: 'Follow-Up', followUpDate: LATER, followUpDateRequired: true }, box: YESTERDAY }), YESTERDAY);
  // a half-typed date reads as empty in a browser: that is not "emptied" — no question, nothing changes for the date
  plain(attributionSave({ detail: { outcome: 'Newsletter', followUpDate: LATER }, badInput: true }), '');
});

test('Save attribution, told the date is required and the outcome is Follow-Up: emptying the box is refused at once with the server\'s words — no question, nothing sent, the date back in the box', () => {
  const r = attributionSave({ detail: { outcome: 'Follow-Up', followUpDate: LATER, followUpDateRequired: true }, answer: 'remove' });
  assert.deepEqual([r.asked, r.sent], [[], []]);
  assert.deepEqual(r.msgs, [[portal.FOLLOW_UP_DATE_KEPT, 'err']]);
  assert.equal(r.els['at-followup'].value, LATER);
  assert.ok(ac.buildDetailHTML('555').includes('var FOLLOW_UP_DATE_KEPT=' + JSON.stringify(portal.FOLLOW_UP_DATE_KEPT) + ';'), 'the words come from the server\'s own constant');
  // switched off, a date may be removed from a Follow-Up client: the page asks as for anyone
  const off = attributionSave({ detail: { outcome: 'Follow-Up', followUpDate: LATER, followUpDateRequired: false }, answer: 'remove' });
  assert.deepEqual([off.asked, off.sent[0].value.removeFollowUpDate, off.msgs], [[LATER], true, []]);
});

test('the question itself: the shared pop-up, "Remove the follow-up date <date> from this client?", "Keep the date" before "Remove the date"; each way out gives its own answer, once', () => {
  const js = firstScript(ac.buildDetailHTML('555'));
  function ask(day) {
    const els = {}, q = { answers: [], opts: null, focused: '' };
    const box = { innerHTML: '', querySelector: (sel) => els[sel] || (els[sel] = { onclick: null, focus() { q.focused = sel; } }) };
    let open = true;
    const dlg = { box, close() { if (!open) return false; open = false; q.opts.onClosed(); return true; }, tryClose() { return dlg.close(); } };
    const ctx = { setTimeout: (f) => f(), tdotDialogNew: (o) => { q.opts = o; return dlg; },
      escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
    vm.createContext(ctx);
    vm.runInContext(pickFn(js, 'askRemoveFollowUpDate'), ctx);
    ctx.askRemoveFollowUpDate(day, (a) => q.answers.push(a));
    q.box = box; q.dlg = dlg; q.keep = () => box.querySelector('[data-x]').onclick(); q.remove = () => box.querySelector('[data-go]').onclick();
    return q;
  }
  let q = ask(LATER);
  assert.equal(q.box.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    'Remove the follow-up date? Remove the follow-up date 2026-11-27 from this client? Lead owner, Booked by and Payment reviewed by are saved either way. Keep the date Remove the date');
  assert.ok(q.box.innerHTML.includes('<button type="button" class="tdlg-btn" data-x>Keep the date</button><button type="button" class="tdlg-btn primary" data-go>Remove the date</button>'));
  assert.equal(q.focused, '[data-x]', 'the focus starts on the answer that removes nothing');
  assert.deepEqual(q.answers, [], 'nothing is answered by opening it');
  q.remove(); assert.deepEqual(q.answers, ['remove']);
  q = ask(LATER); q.keep(); assert.deepEqual(q.answers, ['keep']);
  q = ask(LATER); q.dlg.tryClose('x'); assert.deepEqual(q.answers, [''], '× / Escape / a click outside: no answer');
  q = ask(LATER); q.remove(); q.keep(); q.dlg.tryClose('x'); assert.deepEqual(q.answers, ['remove'], 'one answer only');
  assert.ok(ask('<i>x</i>').box.innerHTML.includes('<b>&lt;i&gt;x&lt;/i&gt;</b>'), 'the date is shown as text');
  // it is the shared pop-up — the page has no window.confirm for this
  assert.ok(pickFn(js, 'askRemoveFollowUpDate').includes('tdotDialogNew({'));
  assert.ok(!/window\.confirm\([^)]*follow-up date/i.test(js));
});

test('the question, a double-click on "Save attribution": the second click of the double-click that opened the question never answers "Remove the date" — only a click of its own (or the keyboard) does', () => {
  const js = firstScript(ac.buildDetailHTML('555'));
  function ask() {
    const els = {}, q = { answers: [], opts: null };
    const box = { innerHTML: '', querySelector: (sel) => els[sel] || (els[sel] = { onclick: null, focus() {} }) };
    let open = true;
    const dlg = { box, close() { if (!open) return false; open = false; q.opts.onClosed(); return true; }, tryClose() { return dlg.close(); } };
    const ctx = { setTimeout: (f) => f(), tdotDialogNew: (o) => { q.opts = o; return dlg; }, escHtml: (x) => String(x) };
    vm.createContext(ctx);
    vm.runInContext(pickFn(js, 'askRemoveFollowUpDate'), ctx);
    ctx.askRemoveFollowUpDate(LATER, (a) => q.answers.push(a));
    q.isOpen = () => open; q.remove = (e) => box.querySelector('[data-go]').onclick(e); q.keep = (e) => box.querySelector('[data-x]').onclick(e);
    return q;
  }
  // the browser counts the clicks of one double-click in detail: 1 opened the question, 2 lands on whatever is now under the pointer
  let q = ask();
  q.remove({ detail: 2 });
  assert.deepEqual([q.answers, q.isOpen()], [[], true], 'the second click of a double-click: no answer, the question stays open');
  q.remove({ detail: 3 });
  assert.deepEqual([q.answers, q.isOpen()], [[], true], 'a third quick click: the same');
  // the person then reads it and answers with a click of their own
  q.remove({ detail: 1 });
  assert.deepEqual([q.answers, q.isOpen()], [['remove'], false]);
  // Enter or Space on the focused button is a click with detail 0
  q = ask(); q.remove({ detail: 0 }); assert.deepEqual(q.answers, ['remove'], 'the keyboard still answers');
  // an ignored second click leaves the other ways out as they were
  q = ask(); q.remove({ detail: 2 }); q.keep({ detail: 1 }); assert.deepEqual(q.answers, ['keep']);
  q = ask(); q.remove({ detail: 2 }); q.opts.onClosed(); assert.deepEqual(q.answers, [''], 'closed after an ignored click: no answer, nothing is saved');
  // through the page's own "Save attribution": with the question still open, nothing has been sent
  const r = attributionSave({ detail: { name: 'Test Client', outcome: 'Newsletter', followUpDate: LATER, followUpDateRequired: false } });
  assert.deepEqual([r.asked, r.sent], [[LATER], []]);
  // the shared dialog has the same rule for its backdrop — this is that rule, not a new timer
  assert.ok(require('../src/routes/dialogUi').DIALOG_UI_JS.includes('if (e.detail > 1) return;'));
  assert.ok(!/setTimeout\([^)]*300/.test(pickFn(js, 'askRemoveFollowUpDate')));
});

/* ── the lead page ── */

/** The lead page's own click handler for one outcome button, against fakes. */
function leadOutcomeClick(label, detail) {
  const js = scriptsOf(al.buildLeadDetailHTML('555')).find((s) => s.includes('var LEAD_DETAIL=null;'));
  const handler = handlerAfter(js, 'b.onclick=function(){', js.indexOf('OUTCOMES.forEach(function(label){'));
  const r = { actions: [], notWanted: [], followUp: [], loads: 0 };
  const ctx = { LEAD_DETAIL: detail, OUTCOME_NOT_WANTED: 'Not Wanted', OUTCOME_FOLLOW_UP: 'Follow-Up', JSON, String, window: {},
    document: { getElementById: () => ({ textContent: 'Name On The Page' }) },
    doAction: (btn, action, confirmText, value, msgElId) => { r.actions.push([action, confirmText, value, msgElId]); return { then() {} }; },
    load: () => { r.loads++; },
    tdotOpenNotWantedModal: (o) => { r.notWanted.push(o); },
    tdotOpenFollowUpModal: (o) => { r.followUp.push(o); } };
  vm.createContext(ctx);
  vm.runInContext('var CLICK=(function(label){ return ' + handler + '; });', ctx);
  ctx.CLICK(label).call({});
  return r;
}

test('lead page, told the date is required: "Follow-Up" opens the same pop-up and posts the label with the date; pressed again it opens with the saved date', () => {
  let r = leadOutcomeClick('Follow-Up', { name: 'Test Client', followUpDate: '', followUpDateRequired: true });
  assert.deepEqual([r.actions, r.followUp.length], [[], 1]);
  assert.deepEqual({ name: r.followUp[0].name, saved: r.followUp[0].saved }, { name: 'Test Client', saved: '' });
  r.followUp[0].onConfirm(LATER);
  assert.deepEqual(r.actions, [['outcome', null, '{"label":"Follow-Up","followUpDate":"2026-11-27"}', 'oc-msg']]);
  assert.deepEqual(portal.validateAction('outcome', r.actions[0][2]), { ok: true, normalized: 'Follow-Up', reason: '', followUpDate: LATER });
  // pressed again on a lead that already has its date
  r = leadOutcomeClick('Follow-Up', { name: 'Test Client', outcome: 'Follow-Up', followUpDate: LATER, followUpDateRequired: true });
  assert.equal(r.followUp[0].saved, LATER);
});

test('lead page, not told so: "Follow-Up" is one click as before; Newsletter and Webinar are one click and Not Wanted asks its reason, whatever the switch', () => {
  for (const detail of [{ name: 'Test Client', followUpDateRequired: false }, { name: 'Test Client' }, { name: 'Test Client', followUpDateRequired: 'yes' }, null]) {
    const r = leadOutcomeClick('Follow-Up', detail);
    assert.deepEqual([r.actions, r.followUp.length], [[['outcome', null, 'Follow-Up', 'oc-msg']], 0], JSON.stringify(detail));
  }
  for (const required of [true, false]) {
    const detail = { name: 'Test Client', followUpDate: LATER, followUpDateRequired: required };
    for (const label of ['Newsletter', 'Webinar']) {
      const r = leadOutcomeClick(label, detail);
      assert.deepEqual([r.actions, r.followUp.length, r.notWanted.length], [[['outcome', null, label, 'oc-msg']], 0, 0]);
    }
    const w = leadOutcomeClick('Not Wanted', detail);
    assert.deepEqual([w.actions, w.followUp.length, w.notWanted.length], [[], 0, 1]);
  }
  // the lead as loaded is kept for the click (the buttons are built before it arrives)
  const js = scriptsOf(al.buildLeadDetailHTML('555')).find((s) => s.includes('var LEAD_DETAIL=null;'));
  assert.ok(js.indexOf('var LEAD_DETAIL=null;') < js.indexOf('OUTCOMES.forEach(function(label){'));
  assert.ok(/function render\(d\)\{\n {2}LEAD_DETAIL=d;\n/.test(js), 'every load refreshes it');
});

test('lead page "Lead status" card: the "Follow-up date" row shows a date whenever there is one; "not set" only when told the date is required and the outcome is Follow-Up', () => {
  const js = scriptsOf(al.buildLeadDetailHTML('555')).find((s) => s.includes('var LEAD_DETAIL=null;'));
  const m = js.match(/ {2}if\(d\.followUpDate\) st\+=kv\('Follow-up date', d\.followUpDate\);\n {2}else if\([^\n]*\n/);
  assert.ok(m, 'the two lines');
  assert.ok(js.indexOf("if(d.outcome) st+=kv('Outcome', d.outcome);") < m.index && m.index < js.indexOf("if(d.consultant) st+=kv('Consultant', d.consultant);"), 'right under the Outcome row');
  const rows = (d) => { const ctx = { d, st: '', OUTCOME_FOLLOW_UP: 'Follow-Up', kv: (k, v) => '[' + k + ': ' + v + ']' }; vm.createContext(ctx); vm.runInContext(m[0], ctx); return ctx.st; };
  // a date: always, switch on or off, whatever the outcome
  for (const d of [{ outcome: 'Follow-Up', followUpDate: LATER, followUpDateRequired: true }, { outcome: 'Follow-Up', followUpDate: LATER, followUpDateRequired: false },
    { outcome: 'Newsletter', followUpDate: LATER, followUpDateRequired: false }, { outcome: '', followUpDate: LATER }]) assert.equal(rows(d), '[Follow-up date: 2026-11-27]', JSON.stringify(d));
  // no date
  assert.equal(rows({ outcome: 'Follow-Up', followUpDate: '', followUpDateRequired: true }), '[Follow-up date: not set]');
  for (const d of [{ outcome: 'Follow-Up', followUpDate: '', followUpDateRequired: false }, { outcome: 'Follow-Up', followUpDate: '' }, { outcome: 'Follow-Up', followUpDate: '', followUpDateRequired: 'true' },
    { outcome: 'Newsletter', followUpDate: '', followUpDateRequired: true }, { outcome: 'Webinar', followUpDate: '', followUpDateRequired: true }, { outcome: '', followUpDate: '', followUpDateRequired: true }]) assert.equal(rows(d), '', JSON.stringify(d));
});

/* ── the lists: "no follow-up date" ── */

/** The code the two list pages share, as emitted (everything up to the row-click wiring), with a fixed "today". */
function listCode(html) {
  const js = firstScript(html);
  const a = js.indexOf('function escHtml('), b = js.indexOf('function bindRowClicks(');
  assert.ok(a >= 0 && b > a);
  const ctx = { Intl };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + "\nfunction todayStr(){ return '2026-11-23'; }", ctx);
  return { ctx, js };
}
const NO_DATE_PILL = ' <span class="pill amber">no follow-up date</span>';

test('lists, the outcome cell: told the date is required, a Follow-Up row with no date shows the amber "no follow-up date" — never on the Retained tab, never another outcome, never a row that has its date', () => {
  for (const html of [ac.buildQueueHTML(), ac.buildRetainersHTML()]) {
    const { ctx } = listCode(html);
    const cell = (c) => ctx.outcomeCell(c), plain = (c) => ctx.outcomeCell.plain(c);
    const FU = { outcome: 'Follow-Up', followUpDate: '' };
    // not told (switch off): the cell is the old one for every row
    const rows = [FU, { outcome: 'Follow-Up', followUpDate: LATER }, { outcome: 'Follow-Up', followUpDate: YESTERDAY }, { outcome: 'Newsletter', followUpDate: '' }, { outcome: 'Not Wanted', followUpDate: '' },
      { outcome: 'Retain', followUpDate: '' }, { outcome: '', followUpDate: '' }, { outcome: 'Follow-Up', followUpDate: '', retained: true }, { outcome: 'Newsletter', followUpDate: LATER }];
    for (const c of rows) assert.equal(cell(c), plain(c), 'off: ' + JSON.stringify(c));
    assert.equal(cell(FU), '<span class="pill amber">Follow-Up</span>');
    // an answer without the mark, or with anything but the boolean true, leaves it off
    for (const d of [{}, null, undefined, { followUpDateRequired: false }, { followUpDateRequired: 'true' }, { followUpDateRequired: 1 }]) { ctx.fuDateRule(d); assert.equal(cell(FU), plain(FU), 'still off: ' + JSON.stringify(d)); }
    // told
    ctx.fuDateRule({ followUpDateRequired: true });
    assert.equal(cell(FU), '<span class="pill amber">Follow-Up</span>' + NO_DATE_PILL);
    assert.equal(cell({ outcome: 'Follow-Up' }), '<span class="pill amber">Follow-Up</span>' + NO_DATE_PILL, 'a row with no date field at all');
    assert.equal(cell({ outcome: 'Follow-Up', followUpDate: '', retained: true }), '<span class="pill amber">Follow-Up</span>', 'the Retained tab never shows a follow-up cue');
    assert.equal(cell({ outcome: 'Follow-Up', followUpDate: LATER }), '<span class="pill amber">Follow-Up</span> <span class="pill grey">follow-up 2026-11-27</span>', 'a date later than today: grey, as before');
    assert.equal(cell({ outcome: 'Follow-Up', followUpDate: TODAY }), '<span class="pill amber">Follow-Up</span> <span class="pill amber">follow-up 2026-11-23</span>', 'due today: amber, as before');
    for (const c of rows.filter((x) => x !== FU)) assert.equal(cell(c), plain(c), 'on, nothing new: ' + JSON.stringify(c));
    for (const c of rows.filter((x) => x !== FU)) assert.ok(!cell(c).includes('no follow-up date'));
    // the next answer says off again (the switch was turned off): the pill goes with the next refresh
    ctx.fuDateRule({ consultations: [] });
    assert.equal(cell(FU), plain(FU));
    // the colour is the shared amber pill — no new colour
    assert.match(html, /\.pill\.amber \{ background:var\(--st-amber-bg\); color:var\(--st-amber-fg\); \}/);
    assert.ok(!/fu-pill|no-fu/.test(html), 'no new class');
  }
});

test('lists: each page hands the board\'s answer to the rule BEFORE it draws the rows, on every load; the rule is never set anywhere else', () => {
  for (const [html, rowsLine] of [[ac.buildQueueHTML(), 'ALLROWS=(d.consultations||[]).concat(d.completed||[]);'], [ac.buildRetainersHTML(), 'RETAINERS=(d.retainers||[]).concat(d.retained||[]);']]) {
    const js = firstScript(html);
    const load = braces(js, js.indexOf('function load(force){'));   // the page's own load (a helper inside the referral picker is also called load)
    assert.ok(load.includes('fuDateRule(d);') && load.indexOf('fuDateRule(d);') < load.indexOf(rowsLine), 'told first, drawn after');
    assert.equal(js.split('fuDateRule(d)').length - 1, 2, 'the definition and the one call');
    assert.equal(js.split('FU_DATE_RULE=').length - 1, 2, 'starts off; set only from the answer');
    assert.ok(js.includes('var FU_DATE_RULE=false;'));
    assert.equal(pickFn(js, 'fuDateRule'), 'function fuDateRule(d){ FU_DATE_RULE=!!(d && d.followUpDateRequired===true); }');
    assert.equal(js.split('function outcomeCell(').length - 1, 1);
  }
});

test('Retainers & follow-ups table, drawn by the page\'s own code: the pill sits in the Outcome cell of the Follow-Up row with no date, and only there; switched off the table is the old one', () => {
  const html = ac.buildRetainersHTML();
  const { ctx, js } = listCode(html);
  const tb = { innerHTML: '' };
  Object.assign(ctx, { document: { getElementById: (id) => (id === 'rbody' ? tb : null) }, bindRowClicks() {}, RET_APART: ['Retained'], TDOT_DEL_SVG: '<svg/>' });
  vm.runInContext(['dParts', 'retCase', 'renderRetainerList'].map((n) => pickFn(js, n)).join('\n'), ctx);
  const rows = [
    { id: '1', name: 'Test Client One', outcome: 'Follow-Up', followUpDate: '', stage: '' },
    { id: '2', name: 'Test Client Two', outcome: 'Follow-Up', followUpDate: LATER, stage: '' },
    { id: '3', name: 'Test Client Three', outcome: 'Newsletter', followUpDate: '', stage: '' },
    { id: '4', name: 'Test Client Four', outcome: 'Retain', followUpDate: '', stage: 'Sent', retainerSent: '2026-11-20' },
    { id: '5', name: 'Test Client Five', outcome: 'Follow-Up', followUpDate: '', stage: 'Paid', retained: true, caseRef: '2026-XX-001' },
  ];
  ctx.RETAINERS = rows;
  const draw = () => { ctx.renderRetainerList(rows, 'data', { sel: {} }, { without: () => rows.length }); return tb.innerHTML.split('</tr>').filter(Boolean).map((tr) => tr.split('<td').slice(1).map((c) => '<td' + c)); };
  const off = draw();
  assert.ok(!tb.innerHTML.includes('no follow-up date'));
  ctx.fuDateRule({ followUpDateRequired: true });
  const on = draw();
  assert.equal(on[0][3], '<td><span class="pill amber">Follow-Up</span>' + NO_DATE_PILL + '</td>');
  const changed = []; on.forEach((cells, i) => cells.forEach((c, j) => { if (c !== off[i][j]) changed.push([rows[i].id, j]); }));
  assert.deepEqual(changed, [['1', 3]], 'one cell differs: the Outcome cell of the Follow-Up row with no date — not the retained one (row 5)');
});

test('Consultations list row, drawn by the page\'s own code: the same pill in the Outcome cell (a completed consultation set to Follow-Up with no date)', () => {
  const { ctx, js } = listCode(ac.buildQueueHTML());
  ctx.TDOT_DEL_SVG = '<svg/>';
  vm.runInContext(['dParts', 'dAdd', 'dLabel', 'dateCell', 'timeCell', 'directPill', 'nowCell', 'readyPill', 'rowHtml'].map((n) => pickFn(js, n)).join('\n'), ctx);
  const row = { id: '1', name: 'Test Client', bookedSlot: '2026-11-10 10:00', outcome: 'Follow-Up', followUpDate: '', done: true };
  const off = ctx.rowHtml(row, '');
  assert.ok(!off.includes('no follow-up date'));
  ctx.fuDateRule({ followUpDateRequired: true });
  const on = ctx.rowHtml(row, '');
  assert.equal(on, off.replace('<span class="pill amber">Follow-Up</span>', '<span class="pill amber">Follow-Up</span>' + NO_DATE_PILL), 'the row is the old one plus the pill');
  assert.equal(on.split('no follow-up date').length - 1, 1);
  assert.equal(ctx.rowHtml({ ...row, followUpDate: LATER }, ''), (ctx.fuDateRule({}), ctx.rowHtml({ ...row, followUpDate: LATER }, '')), 'a row with its date is the same either way');
});

test('a retained client never shows "no follow-up date": on the Consultations page the completed row says Retained only in its "Now" column, and that is enough', () => {
  for (const html of [ac.buildQueueHTML(), ac.buildRetainersHTML()]) {
    const { ctx } = listCode(html);
    const cell = (c) => ctx.outcomeCell(c), plain = (c) => ctx.outcomeCell.plain(c);
    const RETAINED = { outcome: 'Follow-Up', followUpDate: '', done: true, now: 'Retained', nowTone: 'green' };
    assert.equal(cell(RETAINED), plain(RETAINED), 'off: the old cell');
    ctx.fuDateRule({ followUpDateRequired: true });
    assert.equal(cell(RETAINED), '<span class="pill amber">Follow-Up</span>', 'on: no pill for a retained client');
    assert.equal(cell({ outcome: 'Follow-Up', now: 'Retained' }), '<span class="pill amber">Follow-Up</span>', 'no date field at all');
    // every other "Now" still asks for the date — the client is not retained yet
    for (const now of ['Following up', 'Retainer to send', 'Retainer sent', 'Retainer signed', 'Retainer paid', '', undefined]) {
      assert.equal(cell({ outcome: 'Follow-Up', followUpDate: '', done: true, now }), '<span class="pill amber">Follow-Up</span>' + NO_DATE_PILL, 'Now: ' + now);
    }
    // the old "follow-up <date>" pill of a completed row is not touched by this
    assert.equal(cell({ outcome: 'Follow-Up', followUpDate: LATER, done: true, now: 'Retained' }), plain({ outcome: 'Follow-Up', followUpDate: LATER, done: true, now: 'Retained' }));
  }
});

test('Consultations page, from the board\'s real answer: a client set to Follow-Up with no date who later signed and paid (Retained) shows no pill on the Completed list; the client still being followed up does', async () => {
  const snap = require('../src/services/leadSnapshot');
  const leads = [
    { id: '101', fullName: 'Test Client', bookingStatus: 'Booked', bookedSlot: '2026-10-01 10:00', outcome: 'Follow-Up', followUpDate: '', conversionStatus: 'Retained', retainerSent: '2026-10-02', retainerSigned: '2026-10-20', retainerPaid: '2026-10-21' },
    { id: '102', fullName: 'Test Client Two', bookingStatus: 'Booked', bookedSlot: '2026-10-01 11:00', outcome: 'Follow-Up', followUpDate: '' },
  ];
  const dash = require('../src/services/dashboardService');
  const orig = [snap.io.fetchLeads, dash.fetchAllItems, process.env.FOLLOWUP_DATE_REQUIRED];
  snap.io.fetchLeads = async () => JSON.parse(JSON.stringify(leads)); dash.fetchAllItems = async () => [];
  process.env.FOLLOWUP_DATE_REQUIRED = '1';
  let board, tab;
  try {
    snap._reset(); board = await portal.getConsultationsBoard({ now: new Date(NOON), withCompleted: true });
    snap._reset(); tab = await portal.getConsultationsBoard({ now: new Date(NOON), withRetained: true });
  } finally {
    snap.io.fetchLeads = orig[0]; dash.fetchAllItems = orig[1];
    if (orig[2] === undefined) delete process.env.FOLLOWUP_DATE_REQUIRED; else process.env.FOLLOWUP_DATE_REQUIRED = orig[2];
    snap._reset();
  }
  assert.strictEqual(board.followUpDateRequired, true);
  const byId = Object.fromEntries(board.completed.map((r) => [r.id, r]));
  // what the page is given for the retained client: Follow-Up, no date, "Now: Retained" — and no key that says retained
  assert.deepEqual([byId['101'].outcome, byId['101'].followUpDate, byId['101'].now, 'retained' in byId['101']], ['Follow-Up', '', 'Retained', false]);
  assert.deepEqual([byId['102'].outcome, byId['102'].followUpDate, byId['102'].now], ['Follow-Up', '', 'Following up']);
  const { ctx, js } = listCode(ac.buildQueueHTML());
  ctx.TDOT_DEL_SVG = '<svg/>';
  vm.runInContext(['dParts', 'dAdd', 'dLabel', 'dateCell', 'timeCell', 'directPill', 'nowCell', 'readyPill', 'rowHtml'].map((n) => pickFn(js, n)).join('\n'), ctx);
  const offRows = board.completed.map((r) => ctx.rowHtml(r, ''));
  ctx.fuDateRule(board);
  const drawn = Object.fromEntries(board.completed.map((r) => [r.id, ctx.rowHtml(r, '')]));
  assert.ok(drawn['101'].includes('>Retained</span>') && !drawn['101'].includes('no follow-up date'), 'Now: Retained, and no call-back cue');
  assert.equal(drawn['101'], offRows[board.completed.indexOf(byId['101'])], 'the retained client\'s row is the old row, letter for letter');
  assert.equal(drawn['102'].split('no follow-up date').length - 1, 1, 'the client still being followed up keeps the pill');
  // the same client on the Retained tab of Retainers & follow-ups: no pill there either (as before)
  const rt = listCode(ac.buildRetainersHTML()).ctx; rt.fuDateRule(tab);
  assert.deepEqual(tab.retained.map((r) => [r.id, r.retained, rt.outcomeCell(r).includes('no follow-up date')]), [['101', true, false]]);
});

test('the shared list code can be on a page twice without the cell wrapping itself twice', () => {
  const js = firstScript(ac.buildRetainersHTML());
  const a = js.indexOf('function escHtml('), b = js.indexOf('function bindRowClicks(');
  const ctx = { Intl };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\n' + js.slice(a, b) + "\nfunction todayStr(){ return '2026-11-23'; }", ctx);
  ctx.fuDateRule({ followUpDateRequired: true });
  assert.equal(ctx.outcomeCell({ outcome: 'Follow-Up', followUpDate: '' }), '<span class="pill amber">Follow-Up</span>' + NO_DATE_PILL, 'one pill, no endless loop');
});
