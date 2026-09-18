'use strict';

// Two fixes for the client questionnaire (case 2026-CEC-EE-082, Sept 2026).
//
// FIX A — questions the client can NEVER SEE were counted as missing.
//   F1 hides its "Dependent Spouse" / "Dependent Children" sections with an
//   inline display:none on the .top-accordion container when the client
//   answers "no" to accompanying spouse / dependent children. The progress
//   rule only skipped blocks carrying a CONDITIONAL class, so 82 invisible
//   fields stayed in the denominator and a finished single applicant topped
//   out at 77% — under the 80% submit gate, with no way to reach it.
//   The discriminator these tests pin: the forms' toggleConditional() writes
//   an inline display on the CONTAINER, while collapsing a section toggles a
//   CLASS on its accordion BODY (and F12/F13 collapse by writing the same
//   inline style on the BODY). So a hidden container does not count; a hidden
//   accordion body always does — folding a section must never move the number.
//
// FIX B — the statutory Yes/No questions were never collected at all.
//   F1/F2/F3/F4/F5 author them as <div class="stat-q"> with a bare <select>
//   in .q-answer: no <label>, no <table>, so none of collectFields' passes saw
//   them. Every answer about criminal convictions, refugee claims and visa
//   refusals was dropped on save, never restored and never shown to staff.
//   Keys come from the question NUMBER, never its text: the text runs past
//   slugify's 90-character cap, where two questions would collapse onto one
//   key and smear each other's answers (the 2026-CEC-EE-077 defect class).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const svc = require('../src/services/htmlQuestionnaireService');
const { El, fakeDom } = require('./helpers/fakeDom');

const SRC = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
const FORMS_DIR = path.join(__dirname, '..', 'Questionnair Documents');
const F1 = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';

/** Slice a helper out of the CLIENT engine's template literal and evaluate it with real template semantics. */
function engineSlice(startMarker, endMarker, context) {
  const start = SRC.indexOf(startMarker);
  let end = SRC.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `engine slice located: ${startMarker.trim()}`);
  if (context.inclusive) end += endMarker.length;
  const raw = SRC.slice(start, end);
  assert.ok(!raw.includes('`') && !raw.includes('${'), 'the slice is plain template text');
  return vm.runInNewContext(new Function('return `' + raw + '`')() + '\n;({ ' + context.names.join(', ') + ' })', context.globals || {});
}

const { slugifyFull } = engineSlice('  function slugifyFull(s) {', '\n  }\n', { names: ['slugifyFull'], inclusive: true });

/** The ENGINE's own visibility rule, with the forms' stylesheet modelled by fakeDom. */
function visibilityRule(dom) {
  return engineSlice('  var CONDITIONAL_CLASSES =', '\n  function optionalSectionHeaderText(sec) {', {
    names: ['isHiddenConditional', 'isFormHiddenBlock'],
    globals: { window: dom.window, document: dom.document },
  });
}

function statCollector(dom) {
  return vm.runInNewContext(svc.STAT_Q_COLLECTOR_JS + '\n;collectStatQuestionFields', { document: dom.document });
}

/** One .stat-q block: <div class="stat-q"><div class="q-num">N</div><div class="q-text">..</div><div class="q-answer"><select>..</select></div></div> */
function statQ(parent, { num, text, value = '' }) {
  const block = parent.appendChild(new El('div', { cls: ['stat-q'] }));
  block.appendChild(new El('div', { cls: ['q-num'], text: String(num) }));
  block.appendChild(new El('div', { cls: ['q-text'], text }));
  const answer = block.appendChild(new El('div', { cls: ['q-answer'] }));
  const select = answer.appendChild(new El('select', { value }));
  return { block, select };
}

// ─── FIX A: what the form hid does not count; what the client folded does ────

test('a section the FORM hid because it does not apply (inline display:none on the container) does not count', () => {
  const dom = fakeDom();
  const { isHiddenConditional } = visibilityRule(dom);
  // F1's #spouse-section for a client with no accompanying spouse.
  const spouse = dom.body.appendChild(new El('div', { cls: ['top-accordion'], id: 'spouse-section', display: 'none' }));
  assert.equal(isHiddenConditional(spouse), true);
  // Answering "yes" reveals it (toggleConditional writes display:block) — it counts again.
  spouse.style.display = 'block';
  assert.equal(isHiddenConditional(spouse), false);
});

test('a COLLAPSED accordion body still counts — folding a section must never change the number', () => {
  const dom = fakeDom();
  const { isHiddenConditional } = visibilityRule(dom);
  // F12/F13's toggleTop writes this inline style when the client folds a section,
  // and the engine's own handler does the same on cloned member sections.
  for (const cls of ['top-accordion-body', 'sub-accordion-body', 'accordion-body', 'applicant-body']) {
    const body = dom.body.appendChild(new El('div', { cls: [cls], display: 'none' }));
    assert.equal(isHiddenConditional(body), false, `${cls} collapsed → still counted`);
  }
});

test('the existing conditional rules are untouched: class-hidden wrappers hide, .visible and .open reveal', () => {
  const dom = fakeDom();
  const { isHiddenConditional } = visibilityRule(dom);
  const cond = dom.body.appendChild(new El('div', { cls: ['conditional'] }));          // hidden by the stylesheet, no inline style
  assert.equal(isHiddenConditional(cond), true);
  cond.classList.add('visible');
  assert.equal(isHiddenConditional(cond), false);
  const refusal = dom.body.appendChild(new El('div', { cls: ['refusal-block'] }));
  assert.equal(isHiddenConditional(refusal), true);
  refusal.classList.add('open');
  assert.equal(isHiddenConditional(refusal), false);
  const plain = dom.body.appendChild(new El('div', { cls: ['form-group'] }));
  assert.equal(isHiddenConditional(plain), false, 'an ordinary visible group is not hidden');
});

test('the real F1 form still matches the rule: both dependent sections are inline-hidden CONTAINERS, not bodies', () => {
  const html = fs.readFileSync(path.join(FORMS_DIR, F1), 'utf8');
  for (const id of ['spouse-section', 'children-section']) {
    const tag = new RegExp(`<div[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(tag, `${id} exists`);
    assert.match(tag[0], /class="top-accordion"/, `${id} is a container`);
    assert.match(tag[0], /style="display:\s*none/, `${id} is hidden inline by the form`);
    assert.doesNotMatch(tag[0], /accordion-body/, `${id} is not an accordion body`);
  }
  // …and the form reveals them from the client's own answer.
  assert.match(html, /toggleConditional\(this,\s*'spouse-section'\)/);
  assert.match(html, /toggleConditional\(this,\s*'children-section'\)/);
});

// ─── FIX B: the statutory questions are collected, keyed by number ───────────

test('statutory .stat-q questions are collected: one field each, label "N. question", value read from the select', () => {
  const dom = fakeDom();
  const section = 'Main Applicant › Section 5 — Statutory Questions';
  statQ(dom.body, { num: '1', text: 'Have you been convicted of a crime or offence in Canada?', value: 'No' });
  statQ(dom.body, { num: '5d', text: 'Have you ever been denied entry or ordered to leave any other country?', value: 'yes' });
  const fields = [];
  statCollector(dom)({ seen: [], fields, getSectionContext: () => section, slugifyFull });
  assert.equal(fields.length, 2);
  assert.equal(fields[0].label, '1. Have you been convicted of a crime or offence in Canada?');
  assert.equal(fields[0].key, 'main-applicant-section-5-statutory-questions-sq-1');
  assert.equal(fields[0].el.value, 'No');
  assert.equal(fields[1].key, 'main-applicant-section-5-statutory-questions-sq-5d');
  assert.equal(fields[1].el.value, 'yes');
  assert.equal(fields[0].section, section);
});

test('keys come from the question NUMBER, so two long questions can never collapse onto one key', () => {
  const dom = fakeDom();
  const section = 'Main Applicant › Section 5 — Statutory Questions (Criminal Record, Refugee Claims and Previous Refusals)';
  const long1 = 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country or territory whatsoever, including offences later pardoned?';
  const long2 = 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country or territory whatsoever, including offences never prosecuted?';
  statQ(dom.body, { num: '2', text: long1, value: 'No' });
  statQ(dom.body, { num: '3', text: long2, value: 'Yes' });
  const fields = [];
  statCollector(dom)({ seen: [], fields, getSectionContext: () => section, slugifyFull });
  assert.notEqual(fields[0].key, fields[1].key, 'two near-identical long questions keep distinct keys');
  for (const f of fields) assert.ok(f.key.length <= 90, `key within the 90-char cap: ${f.key.length}`);
  assert.ok(fields[0].key.endsWith('-sq-2') && fields[1].key.endsWith('-sq-3'), 'the number survives truncation — the section is what gets cut');
});

test('every statutory question in every real form produces a unique key', () => {
  const forms = fs.readdirSync(FORMS_DIR).filter((f) => f.endsWith('.html'));
  let checked = 0;
  for (const name of forms) {
    const html = fs.readFileSync(path.join(FORMS_DIR, name), 'utf8');
    if (!html.includes('class="stat-q"')) continue;
    checked++;
    // Walk the file in order, rebuilding the section path getSectionContext()
    // gives the collector in the browser: the enclosing toggleTop header, then
    // the toggleSub header (so the spouse copy of question 1 is a different
    // section from the main applicant's).
    const token = /<div[^>]*onclick="toggleTop\(this\)"[^>]*>([\s\S]*?)<\/div>|<div[^>]*onclick="toggleSub\(this\)"[^>]*>([\s\S]*?)<\/div>|<div class="stat-q"><div class="q-num">([^<]*)</g;
    const clean = (x) => String(x || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    let m, top = '', sub = '', keys = new Set(), dupes = [];
    while ((m = token.exec(html)) !== null) {
      if (m[1] !== undefined) { top = clean(m[1]); sub = ''; continue; }
      if (m[2] !== undefined) { sub = clean(m[2]); continue; }
      const section = [top, sub].filter(Boolean).join(' \u203a ');
      const tail = '-sq-' + slugifyFull((m[3] || '').trim());
      const key = slugifyFull(section).slice(0, Math.max(0, 90 - tail.length)) + tail;
      if (keys.has(key)) dupes.push(key);
      keys.add(key);
    }
    assert.equal(dupes.length, 0, `${name}: duplicate statutory keys ${dupes.slice(0, 3).join(', ')}`);
    assert.ok(keys.size > 0, `${name}: statutory keys produced`);
  }
  assert.ok(checked >= 5, `every .stat-q form checked (saw ${checked})`);
});

test('a question already collected by another pass is never collected twice, and hidden member sections are skipped', () => {
  const dom = fakeDom();
  const { select } = statQ(dom.body, { num: '1', text: 'Already seen by an earlier pass?', value: 'No' });
  const fields = [];
  statCollector(dom)({ seen: [select], fields, getSectionContext: () => 'S', slugifyFull });
  assert.equal(fields.length, 0, 'an input another pass already took is left alone');

  const dom2 = fakeDom();
  const hidden = dom2.body.appendChild(new El('div', { cls: ['sub-accordion'], attrs: { 'data-mm-hidden': 'true' } }));
  statQ(hidden, { num: '1', text: 'Belongs to a member section this page is not showing', value: 'Yes' });
  const fields2 = [];
  statCollector(dom2)({
    seen: [], fields: fields2, getSectionContext: () => 'S', slugifyFull,
    skipBlock: (b) => b.closest('[data-mm-hidden="true"]') !== null,
  });
  assert.equal(fields2.length, 0, 'skipBlock is honoured, as the multi-member page needs');
});

test('a .stat-q block with no answer control, or no number, degrades safely', () => {
  const dom = fakeDom();
  const empty = dom.body.appendChild(new El('div', { cls: ['stat-q'] }));
  empty.appendChild(new El('div', { cls: ['q-text'], text: 'No answer control at all' }));
  const noNum = dom.body.appendChild(new El('div', { cls: ['stat-q'] }));
  noNum.appendChild(new El('div', { cls: ['q-text'], text: 'Numberless question' }));
  noNum.appendChild(new El('div', { cls: ['q-answer'] })).appendChild(new El('select', { value: 'Yes' }));
  const fields = [];
  statCollector(dom)({ seen: [], fields, getSectionContext: () => 'S', slugifyFull });
  assert.equal(fields.length, 1, 'the block with no control is skipped, not crashed on');
  assert.equal(fields[0].label, 'Numberless question');
  assert.equal(fields[0].key, 's-sq-2', 'falls back to its position so the key stays unique');
});

// ─── Both engines run the same collector ────────────────────────────────────

test('the client engine AND the staff review engine both collect the statutory questions', () => {
  assert.equal((SRC.match(/\$\{STAT_Q_COLLECTOR_JS\}/g) || []).length, 2, 'shipped into both injected scripts');
  assert.equal((SRC.match(/collectStatQuestionFields\(\{/g) || []).length, 2, 'called by both collectFields');
  const client = SRC.indexOf('function buildInjectionScript(');
  const review = SRC.indexOf('function buildReviewInjectionScript(');
  assert.ok(client > 0 && review > client);
  const firstCall = SRC.indexOf('collectStatQuestionFields({', client);
  const secondCall = SRC.indexOf('collectStatQuestionFields({', firstCall + 1);
  assert.ok(firstCall > client && firstCall < review, 'the client engine calls it');
  assert.ok(secondCall > review, 'the review engine calls it');
  assert.ok(!svc.STAT_Q_COLLECTOR_JS.includes('`') && !svc.STAT_Q_COLLECTOR_JS.includes('${'),
    'plain template text, so the two engines cannot drift apart');
});
