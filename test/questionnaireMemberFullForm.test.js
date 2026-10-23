'use strict';

// A family member on a form with SEVERAL top sections and no dependent
// template gets the WHOLE questionnaire (2026-10-24, case 2026-SV-021: the
// second Super Visa parent used to get a copy of "Section 1 – Profile Details"
// only). Each person — the principal too — is one wrapper carrying
// data-member-key with a banner and every section inside; a box's section path
// keeps the section heading, i.e. the very key the single-applicant page
// writes, so the principal loses nothing when the second member arrives.
// Both engines (the client page and the staff review page) run here against
// the real form files through the offline DOM in test/helpers/fakeDom.js.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const { parseHtml } = require('./helpers/fakeDom');

const SRC   = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
const FORMS = path.join(__dirname, '..', 'Questionnair Documents');
const F11 = '11. Super Visa - Outside  - Questionnaires - April 2025.html';
const F7  = '7. Study Permit - Inside and Outside  - Questionnaires - April 2025.html';
const F9  = '9. Lost PR Card - PR Card Renewal - PR TD   - Questionnair - April 2025.html';
const F12 = '12. Visitor Visa Extension - Questionnair - April 2025.html';
const F2  = '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnaire - August 2026.html';
const F1  = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const F13 = '13. TRV - Questionnair - April 2025.html';
const F17 = 'USA Visa  -  Questionnaire - April 2025.html';
const F14 = 'Indian Passport Surrender Application.html';
/* Every form that takes the whole-form path: several top sections, no dependent template. The last three have no
   memberTypes but become multi-member when the Family Members board lists someone (the route's board fallback). */
const WHOLE_FORM = [[F11, 6], [F7, 5], [F9, 5], [F12, 4], [F13, 4], [F17, 4], [F14, 5]];
const REVIEW_AT = SRC.indexOf('function buildReviewInjectionScript');

const PRIMARY = { key: 'primary', type: 'Principal Applicant', label: 'Principal Applicant' };
const SPOUSE  = { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Meena Sharma' };
const CHILD   = { key: 'child-1', type: 'Dependent Child', label: 'Child 1' };

const form = (f) => parseHtml(fs.readFileSync(path.join(FORMS, f), 'utf8'));
const boxes = (el) => el.querySelectorAll('input, select, textarea');
const heading = (sec) => (sec.querySelector('.top-accordion-header, .applicant-header, .accordion-header').textContent || '').replace('▼', '').trim();

/** A helper out of an engine's template literal, evaluated with real template semantics (the review engine from REVIEW_AT). */
function slice(startMarker, endMarker, from = 0) {
  const start = SRC.indexOf(startMarker, from);
  const end = SRC.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `engine slice located: ${startMarker.trim()}`);
  const raw = SRC.slice(start, end);
  assert.ok(!raw.includes('`') && !raw.includes('${'), 'the slice is plain template text');
  return new Function('return `' + raw + '`')();
}

function clientEngine(dom, members) {
  const code = slice('  function getHeadingText(el) {', '\n  function isVisible(el) {')
    + '\n' + slice('  /* ── Multi-member DOM setup ── */', '\n  function createAddMemberArea(')
    + '\n' + slice('  function getMemberKeyForEl(el) {', '\n  function getSerializableFieldsForMember(');
  const g = { document: dom.document, window: dom.window, Event: dom.Event, console, MEMBERS: members, ALLOWED_TYPES: [], MEMBER_EDITING_LOCKED: true, IS_MULTI: members.length > 1, FORM_KEY: 'primary' };
  return vm.runInNewContext(code + '\n;({ setupMultiMemberDOM, getSectionContext, getMemberKeyForEl, getActiveMemberKeys, findTopSections })', g);
}

function reviewEngine(dom, members) {
  const code = slice('  function getHeadingText(el) {', '\n  ${STATIC_TABLE_COLLECTOR_JS}', REVIEW_AT)
    + '\n' + slice('  var MEMBER_ICONS = {', '\n  function prefillMultiMemberReview(', REVIEW_AT);
  const g = { document: dom.document, window: dom.window, console, REVIEW_MEMBERS: members.map((m) => ({ ...m, fields: [], flags: {} })), IS_MULTI_REVIEW: members.length > 1, FORM_KEY: 'primary' };
  return vm.runInNewContext(code + '\n;({ setupMultiMemberReview, getSectionContext, getMemberKeyForEl, reviewTopSections })', g);
}

/** [memberKey, section path, box id-or-label] for every box, in page order. */
function shape(dom, eng) {
  return boxes(dom.body).map((b) => [eng.getMemberKeyForEl(b), eng.getSectionContext(b), b.id || (b.closest('.form-group, .field-group') || { textContent: '' }).textContent.trim().slice(0, 40)]);
}

/** A function out of a form file's own script (brace-matched), runnable against the DOM. */
function formFn(file, name, dom) {
  const html = fs.readFileSync(path.join(FORMS, file), 'utf8');
  const at = html.indexOf('function ' + name + '(');
  assert.ok(at > 0, `${file} defines ${name}`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  return vm.runInNewContext(html.slice(at, i + 1) + '\n;' + name, { document: dom.document, Array });
}

test('Super Visa: every person gets the whole form — one wrapper per member with all six sections; the principal\'s sections moved (ids kept), the member\'s cloned (ids prefixed, buttons retargeted)', () => {
  const dom = form(F11);
  const single = boxes(dom.body).length;
  const eng = clientEngine(dom, [PRIMARY, SPOUSE]);
  const titles = [...eng.findTopSections()].map(heading);   // spread: a host array (vm arrays fail strict deep-equality)
  assert.equal(titles.length, 6);
  eng.setupMultiMemberDOM();

  const wraps = dom.document.querySelectorAll('[data-member-key]');
  assert.deepEqual([...wraps.map((w) => w.getAttribute('data-member-key'))], ['primary', 'spouse']);
  assert.deepEqual([...eng.getActiveMemberKeys()], ['primary', 'spouse'], 'one member element per person — one save per person');
  for (const w of wraps) {
    assert.ok(w.classList.contains('mm-member'));
    const kids = w.children;
    assert.ok(kids[0].classList.contains('mm-member-header'), 'the banner first');
    assert.deepEqual(kids.slice(1).map(heading), titles, `${w.getAttribute('data-member-key')}: all six sections, in order`);
    assert.equal(boxes(w).length, single, 'as many boxes as the single-applicant page');
  }
  assert.match(wraps[0].children[0].textContent, /Principal Applicant/);
  assert.match(wraps[1].children[0].textContent, /Meena Sharma/);
  assert.equal(wraps[1].children[0].querySelector('.mm-section-badge').textContent, 'Spouse');

  // the page around them: title, subtitle and instructions stay above the first person
  const top = dom.document.querySelector('.container').children.map((c) => c.classList.contains('mm-member') ? 'member:' + c.getAttribute('data-member-key') : c.tag + (c.classList.contains('instructions') ? '.instructions' : ''));
  assert.deepEqual(top, ['h1', 'p', 'div.instructions', 'member:primary', 'member:spouse']);

  // ids: the principal's untouched (the form's own ids, "spouse-details" among them), the spouse's each prefixed — nothing collides
  const original = boxes(form(F11).body).length && form(F11).body.querySelectorAll('[id]').map((e) => e.id);
  assert.deepEqual(wraps[0].querySelectorAll('[id]').map((e) => e.id), original);
  assert.deepEqual(wraps[1].querySelectorAll('[id]').map((e) => e.id), original.map((id) => 'spouse-' + id));
  assert.ok(wraps[0].contains(dom.document.getElementById('tbl-education')));
  assert.ok(wraps[1].contains(dom.document.getElementById('spouse-tbl-education')));
  const addBtn = (w) => w.querySelectorAll('[onclick]').map((b) => b.getAttribute('onclick')).filter((o) => /addRow\('/.test(o));
  assert.ok(addBtn(wraps[1]).length >= 8 && addBtn(wraps[1]).every((o) => /addRow\('spouse-tbl-/.test(o)), 'every "+ Add row" of the spouse targets her own table');
  assert.ok(addBtn(wraps[0]).every((o) => /addRow\('tbl-/.test(o)));
  const cond = (w) => w.querySelectorAll('[onchange]').map((b) => b.getAttribute('onchange')).filter((o) => /toggleConditional/.test(o));
  assert.ok(cond(wraps[1]).length >= 4 && cond(wraps[1]).every((o) => /toggleConditional\(this,'spouse-/.test(o)));

  // whose box is it, and which section: full headings, identical lists for the two people
  const rows = shape(dom, eng);
  assert.equal(rows.length, single * 2);
  assert.ok(rows.slice(0, single).every((r) => r[0] === 'primary') && rows.slice(single).every((r) => r[0] === 'spouse'));
  const paths = (k) => rows.filter((r) => r[0] === k).map((r) => r[1]);
  assert.deepEqual(paths('spouse'), paths('primary'));
  const sp = paths('spouse');
  assert.ok(sp.includes('Section 1 – Profile Details › Personal Details'));
  assert.ok(sp.includes('Section 2 – Purpose of Visit'));
  assert.ok(sp.includes('Section 4 – Family Information › Children\'s Information'));
  assert.ok(sp.includes('Section 4 — Statutory Questions'), 'the &mdash; heading, decoded');
  assert.ok(!sp.some((p) => /Meena|Principal Applicant/.test(p)), 'the banner is never part of a path');
});

test('the principal keeps every key: in multi-member mode each box\'s section path equals the single-applicant page\'s (a case gaining its second member keeps every answer)', () => {
  const alone = form(F11);
  const solo = clientEngine(alone, [PRIMARY]);           // IS_MULTI false: the page as the father filled it
  const before = boxes(alone.body).map((b) => solo.getSectionContext(b));
  const dom = form(F11);
  const eng = clientEngine(dom, [PRIMARY, SPOUSE]);
  eng.setupMultiMemberDOM();
  const primary = dom.document.querySelector('[data-member-key="primary"]');
  const after = boxes(primary).map((b) => eng.getSectionContext(b));
  assert.equal(after.length, before.length);
  assert.deepEqual(after, before);
  assert.ok(before.every((p) => p !== ''), 'every box has a section');
});

test('the same shape on every form with this layout (Study Permit, PR Card / PRTD, Visitor Record, TRV, USA Visa, Passport Surrender); a one-section form (work permit) and a template form (Express Entry) are exactly as before', () => {
  for (const [f, n] of WHOLE_FORM.filter(([x]) => x !== F11)) {
    const dom = form(f); const eng = clientEngine(dom, [PRIMARY, SPOUSE]);
    assert.equal(eng.findTopSections().length, n, f);
    eng.setupMultiMemberDOM();
    const wraps = dom.document.querySelectorAll('[data-member-key]');
    assert.equal(wraps.length, 2, f);
    assert.ok(wraps.every((w) => w.classList.contains('mm-member') && w.children.length === n + 1), f + ': banner + every section, per person');
    const rows = shape(dom, eng);
    const paths = (k) => rows.filter((r) => r[0] === k).map((r) => r[1]);
    assert.deepEqual(paths('spouse'), paths('primary'), f);
    assert.ok(paths('spouse').length === paths('primary').length && paths('spouse').length > 0, f);
  }
  // F2: one top section = the whole form already; the section itself is the member element, its heading dropped from the path (as before)
  const alone = form(F2); const solo = clientEngine(alone, [PRIMARY]);
  const soloPath = solo.getSectionContext(boxes(alone.body)[0]);
  const dom2 = form(F2); const eng2 = clientEngine(dom2, [PRIMARY, SPOUSE]);
  assert.equal(eng2.findTopSections().length, 1);
  eng2.setupMultiMemberDOM();
  const w2 = dom2.document.querySelectorAll('[data-member-key]');
  assert.equal(w2.length, 2);
  assert.ok(w2.every((w) => w.classList.contains('top-accordion') && !w.classList.contains('mm-member')), 'no wrapper: the cloned section carries the key');
  assert.equal(dom2.document.querySelectorAll('.mm-member').length, 0);
  assert.match(w2[1].querySelector('.top-accordion-header').textContent, /Meena Sharma/, 'the section header is the member banner');
  const firstSpouseBox = boxes(w2[1])[0];
  assert.equal(eng2.getSectionContext(firstSpouseBox), soloPath.replace(/^[^›]+› /, ''), 'the top heading is dropped inside a member section, as before');
  assert.equal(eng2.getMemberKeyForEl(firstSpouseBox), 'spouse');
  // F1: the dependent template is the blueprint; the children template is removed
  const dom1 = form(F1); const eng1 = clientEngine(dom1, [PRIMARY, SPOUSE]);
  eng1.setupMultiMemberDOM();
  const w1 = dom1.document.querySelectorAll('[data-member-key]');
  assert.deepEqual(w1.map((w) => [w.getAttribute('data-member-key'), w.id]), [['primary', ''], ['spouse', 'spouse-spouse-section']]);
  assert.equal(dom1.document.getElementById('children-section'), null);
  assert.equal(dom1.document.querySelectorAll('.mm-member').length, 0);
});

test('a dependent child on every whole-form form keeps its FIRST section only (whatever the form calls it), trimmed inside by the keep words — exactly what the child got before; never an empty form', () => {
  for (const [f, n] of WHOLE_FORM) {
    const dom = form(f); const eng = clientEngine(dom, [PRIMARY, CHILD, SPOUSE]); eng.setupMultiMemberDOM();
    const child = dom.document.querySelector('[data-member-key="child-1"]');
    const secs = child.children.slice(1);
    assert.equal(secs.length, n, f);
    assert.deepEqual(secs.map((s) => s.getAttribute('data-mm-hidden') === 'true'), secs.map((_, i) => i > 0), f + ': the first section stays, every later one is hidden');
    const visibleBoxes = boxes(secs[0]).filter((b) => !b.closest('[data-mm-hidden]')).length;
    // the Passport Surrender page is step-by-step guidance: its first section holds no boxes (so it never did for a child)
    if (f !== F14) assert.ok(visibleBoxes > 0, f + ': the child has questions to answer (' + heading(secs[0]) + ')');
    const r = form(f); const re = reviewEngine(r, [PRIMARY, CHILD]); re.setupMultiMemberReview();
    const rc = r.document.querySelector('[data-member-key="child-1"]');
    assert.deepEqual(rc.children.slice(1).map((s) => s.style.display === 'none'), secs.map((_, i) => i > 0), f + ': the review page trims the same way');
  }
  // F9's "Personal History (Past 5 Years)" and F17's "Main Applicant": the first-section rule, not a keyword, decides
  const d9 = form(F9); const e9 = clientEngine(d9, [PRIMARY, CHILD]); e9.setupMultiMemberDOM();
  assert.deepEqual(d9.document.querySelector('[data-member-key="child-1"]').children.slice(1).map((s) => [heading(s).slice(0, 16), s.getAttribute('data-mm-hidden') === 'true']), [['Section 1 – Prof', false], ['Address Details ', true], ['Travel History (', true], ['Personal History', true], ['Section 4 — Stat', true]]);
  const d17 = form(F17); const e17 = clientEngine(d17, [PRIMARY, CHILD]); e17.setupMultiMemberDOM();
  const c17 = d17.document.querySelector('[data-member-key="child-1"]');
  assert.equal(heading(c17.children[1]), 'Main Applicant'); assert.equal(c17.children[1].getAttribute('data-mm-hidden'), null);
  assert.ok(boxes(c17.children[1]).filter((b) => !b.closest('[data-mm-hidden]')).length > 0, 'the USA Visa child keeps the Main Applicant section');
})

test('a dependent child on the Study Permit form keeps the profile section only — the other sections are hidden and out of the count, exactly what the child got before; a spouse gets everything', () => {
  const dom = form(F7); const eng = clientEngine(dom, [PRIMARY, CHILD, SPOUSE]);
  eng.setupMultiMemberDOM();
  const child = dom.document.querySelector('[data-member-key="child-1"]');
  const secs = child.children.slice(1);
  assert.equal(secs.length, 5);
  assert.deepEqual(secs.map((s) => [heading(s).slice(0, 9), s.getAttribute('data-mm-hidden') === 'true']), [['Section 1', false], ['Section 2', true], ['Section 3', true], ['Section 4', true], ['Statutory', true]]);
  const subs = secs[0].querySelectorAll('.sub-accordion').map((s) => [s.querySelector('.sub-accordion-header').textContent.replace('▼', '').trim(), s.getAttribute('data-mm-hidden') === 'true']);
  assert.ok(subs.some(([t, h]) => /Personal Details/.test(t) && !h), 'Personal Details kept');
  assert.ok(subs.some(([t, h]) => /Marital Status/.test(t) && h), 'Marital Status hidden');
  const spouse = dom.document.querySelector('[data-member-key="spouse"]');
  assert.equal(spouse.querySelectorAll('[data-mm-hidden]').length, 0);
  for (const el of child.querySelectorAll('[id]')) assert.match(el.id, /^child-1-/);
});

test('the staff review page builds the identical structure: same wrappers, same prefixed ids, the same section path for every box', () => {
  const members = [PRIMARY, SPOUSE];
  const c = form(F11); const ce = clientEngine(c, members); ce.setupMultiMemberDOM();
  const r = form(F11); const re = reviewEngine(r, members); re.setupMultiMemberReview();
  const wraps = r.document.querySelectorAll('[data-member-key]');
  assert.deepEqual(wraps.map((w) => [w.getAttribute('data-member-key'), w.classList.contains('mm-member'), w.children.length]), [['primary', true, 7], ['spouse', true, 7]]);
  assert.match(wraps[1].children[0].textContent, /Meena Sharma/);
  assert.equal(wraps[1].children[0].querySelector('.mm-review-section-label').textContent, 'Spouse');
  assert.equal(wraps[0].children[0].querySelector('.mm-review-section-label'), null, 'no type badge on the principal');
  assert.deepEqual(shape(r, re), shape(c, ce));
  assert.equal(re.reviewTopSections().length, 12, 'the "(no data submitted)" badges see every section of both people');
  // a child on the review page is trimmed the same way
  const r7 = form(F7); const re7 = reviewEngine(r7, [PRIMARY, CHILD]); re7.setupMultiMemberReview();
  const child = r7.document.querySelector('[data-member-key="child-1"]');
  assert.deepEqual(child.children.slice(1).map((s) => s.style.display === 'none'), [false, true, true, true, true]);
});

test('the statutory "If yes, please provide details" block opens for the person who answered Yes — not for the other one (Super Visa, Study Permit, Visitor Record)', () => {
  for (const f of [F11, F7]) {
    const html = fs.readFileSync(path.join(FORMS, f), 'utf8');
    assert.ok(!/addEventListener\('change'/.test(html), f + ': no load-time wiring (a cloned section would lose it)');
    const dom = form(f); const eng = clientEngine(dom, [PRIMARY, SPOUSE]); eng.setupMultiMemberDOM();
    const toggle = formFn(f, 'toggleRefusalDetails', dom);
    const [p, s] = dom.document.querySelectorAll('[data-member-key]');
    const triggers = (w) => w.querySelectorAll('select.refusal-trigger');
    assert.ok(triggers(s).length >= 15 && triggers(s).every((t) => t.getAttribute('onchange') === 'toggleRefusalDetails(this)'), f + ': every statutory select is wired inline');
    const details = (w) => w.querySelector('.refusal-details');
    triggers(s)[3].value = 'yes'; toggle(triggers(s)[3]);
    assert.ok(details(s).classList.contains('visible') && details(s).style.display === 'block', f + ': her block opens');
    assert.ok(!details(p).classList.contains('visible') && details(p).style.display !== 'block', f + ': his stays closed');
    triggers(s)[3].value = 'no'; toggle(triggers(s)[3]);
    assert.equal(details(s).style.display, 'none', f + ': closes again when no answer is Yes');
    triggers(p)[0].value = 'yes'; toggle(triggers(p)[0]);
    assert.equal(details(p).style.display, 'block');
  }
  for (const f of [F12, F13]) {
    const dom = form(f); const eng = clientEngine(dom, [PRIMARY, SPOUSE]); eng.setupMultiMemberDOM();
    const toggle = formFn(f, 'toggleRefusalBlock', dom);
    const yes = dom.document.querySelector('input[name="spouse-sq5"][value="yes"]');
    assert.ok(yes, f + ': the clone\'s radio group is its own');
    yes.checked = true; toggle(yes);
    const block = (k) => dom.document.querySelector('[data-member-key="' + k + '"]').querySelector('.refusal-block');
    assert.ok(block('spouse').classList.contains('open') && !block('primary').classList.contains('open'), f);
    const no = dom.document.querySelector('input[name="spouse-sq5"][value="no"]'); no.checked = true; yes.checked = false; toggle(no);
    assert.ok(!block('spouse').classList.contains('open'), f + ': closes again');
  }
  // no other whole-form form reaches past its own copy by element id
  for (const [f] of WHOLE_FORM) {
    const html = fs.readFileSync(path.join(FORMS, f), 'utf8');
    const script = html.slice(html.lastIndexOf('<script>'));
    for (const m of script.matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(/^(targetId|tableId)$/.test(m[1]) || /refusal-block|refusal-details/.test(m[1]) === false || /closest/.test(script.slice(Math.max(0, m.index - 300), m.index)), f + ': ' + m[0] + ' is scoped to the copy first');
  }
});

test('wiring: the banner styles in both engines, the flags badge on the banner, the same section selectors in the two trims', () => {
  assert.equal((SRC.match(/\.mm-member-header \{/g) || []).length, 2, 'client + review CSS');
  assert.match(SRC, /var header = section\.querySelector\('\.mm-member-header'\) \|\| section\.querySelector\('\.top-accordion-header, \.applicant-header, \.accordion-header'\);\s*if \(header\) \{\s*var badge/, 'the 🚩 flags badge sits on the banner');
  assert.equal((SRC.match(/if \(section\.classList\.contains\('mm-member'\)\) \{/g) || []).length, 2, 'the per-type trim keeps the first section of a whole-form member in both engines');
  assert.match(SRC, /var subAccordions = scope\.querySelectorAll\('\.sub-accordion, \.accordion'\);/);
  assert.match(SRC, /var subs = trimScope\.querySelectorAll\('\.sub-accordion, \.accordion'\);/);
  assert.equal((SRC.match(/\} else if \(topSections\.length > 1\) \{/g) || []).length, 2, 'the whole-form branch in both engines');
});

test('a table row added on the page: the cell wrapper that swaps its boxes for textareas refreshes the engine\'s field list, so the new cells are never counted as the principal\'s (a detached box has no member)', () => {
  const svc = require('../src/services/htmlQuestionnaireService');
  const dom = form(F11); const eng = clientEngine(dom, [PRIMARY, SPOUSE]); eng.setupMultiMemberDOM();
  let refreshed = 0;
  const wrap = vm.runInNewContext(svc.WRAP_CELLS_JS + '\n;({ convertTableCellInputs })', { document: dom.document, window: dom.window, invalidateCache: () => { refreshed++; } });
  const tbody = dom.document.getElementById('spouse-tbl-education').querySelector('tbody');
  const tr = dom.document.createElement('tr'); const td = dom.document.createElement('td'); const inp = dom.document.createElement('input'); inp.setAttribute('type', 'text'); inp.value = 'typed before the swap';
  td.appendChild(inp); tr.appendChild(td); tbody.appendChild(tr);
  assert.equal(eng.getMemberKeyForEl(inp), 'spouse');
  wrap.convertTableCellInputs(dom.document);
  assert.ok(refreshed >= 1, 'the field list is refreshed');
  assert.equal(inp.parentElement, null, 'the input is detached …');
  assert.equal(eng.getMemberKeyForEl(inp), 'primary', '… and a detached box falls back to the principal — which is why the refresh matters');
  const ta = td.querySelector('textarea');
  assert.equal(ta.value, 'typed before the swap'); assert.equal(eng.getMemberKeyForEl(ta), 'spouse');
  refreshed = 0; wrap.convertTableCellInputs(dom.document);
  assert.equal(refreshed, 0, 'nothing to replace: no refresh');
  // the review page has no cache: the same code runs there without one
  const r = form(F11); vm.runInNewContext(svc.WRAP_CELLS_JS + '\n;convertTableCellInputs(document)', { document: r.document, window: r.window });
});

test('a table row the client removes is nobody\'s: the engine\'s field list drops boxes that left the page, so her removed row never reaches the principal\'s file (the 60-second autosave after a ✕ click)', () => {
  const svc = require('../src/services/htmlQuestionnaireService');
  const dom = form(F11);
  const members = [PRIMARY, SPOUSE];
  const code = slice('  function slugify(s) {', '\n  function isVisible(el) {')
    + '\n' + slice('  /* ── Multi-member DOM setup ── */', '\n  function createAddMemberArea(')
    + '\n' + slice('  function getMemberKeyForEl(el) {', '\n  function getProgressForMember(')
    + '\n  var _fieldCache = null; var _cacheStale = true; function invalidateCache() { _cacheStale = true; }\n'
    + '\n  function collectStaticTableFields(){}\n  function collectStatQuestionFields(){}\n'
    + '\n' + slice('  function collectFields() {', '\n  /** Set the value on a collected field');
  const g = { document: dom.document, window: dom.window, Event: dom.Event, console, MEMBERS: members, ALLOWED_TYPES: [], MEMBER_EDITING_LOCKED: true, IS_MULTI: true, FORM_KEY: 'primary', setTimeout };
  const eng = vm.runInNewContext(code + '\n;({ setupMultiMemberDOM, getMemberKeyForEl, collectFields, invalidateCache, getSerializableFieldsForMember })', g);
  eng.setupMultiMemberDOM();
  const tbody = dom.document.getElementById('spouse-tbl-education').querySelector('tbody');
  const row2 = tbody.querySelectorAll('tr')[0].cloneNode(true); tbody.appendChild(row2);
  const cells = row2.querySelectorAll('input, select, textarea'); cells.forEach((c, i) => { c.value = 'typed ' + i; });
  eng.invalidateCache();
  const before = eng.collectFields().filter((f) => cells.includes(f.el));
  assert.equal(before.length, cells.length); assert.ok(before.every((f) => eng.getMemberKeyForEl(f.el) === 'spouse'));
  row2.remove();                                   // the form's ✕: no change/input event, nothing replaced
  const primaryNow = [...eng.getSerializableFieldsForMember('primary')];
  assert.equal(primaryNow.filter((f) => /tbl-spouse-/.test(f.key)).length, 0, 'none of her removed cells is his');
  assert.equal([...eng.collectFields()].filter((f) => cells.includes(f.el)).length, 0, 'the removed boxes are gone from the list');
  assert.equal(primaryNow.length, [...eng.getSerializableFieldsForMember('spouse')].length, 'the two people have the same boxes again');
  assert.match(svc.WRAP_CELLS_JS, /if \(replaced && typeof invalidateCache === "function"\) invalidateCache\(\);/);
});

test('kept-aside answers: a member file saved before this change (no section heading) is recognised on the whole-form page (heading restored) — nothing is parked; the older single→multi direction still holds', () => {
  const svc = require('../src/services/htmlQuestionnaireService');
  const fn = svc.computeSetAside || (svc._internal && svc._internal.computeSetAside);
  assert.ok(fn, 'computeSetAside reachable');
  const old = [{ section: 'Personal Details', label: 'Given Name', key: 'personal-details-given-name', value: 'Meena' }, { section: 'Marital Status', label: 'Spouse\'s Given Name', key: 'marital-status-spouse-s-given-name', value: 'Udhav' }];
  const now = [{ section: 'Section 1 – Profile Details › Personal Details', label: 'Given Name', key: 'section-1-profile-details-personal-details-given-name', value: 'Meena' }, { section: 'Section 1 – Profile Details › Marital Status', label: 'Spouse\'s Given Name', key: 'section-1-profile-details-marital-status-spouse-s-given-name', value: 'Udhav' }];
  assert.deepEqual(fn({ previousFields: old, previousSetAside: [], incomingFields: now }), { setAside: [], added: 0 });
  // the reverse (the principal's heading dropped by a template-form flip) — as before
  assert.deepEqual(fn({ previousFields: now, previousSetAside: [], incomingFields: old }), { setAside: [], added: 0 });
  // a genuinely gone answer is still parked
  const gone = fn({ previousFields: old, previousSetAside: [], incomingFields: [now[0]] });
  assert.equal(gone.added, 1); assert.equal(gone.setAside[0].value, 'Udhav');
  // a dependent's heading is never the top heading that gets stripped
  const dep = [{ section: 'Dependent Spouse / Common-Law Partner › Personal Details', label: 'Given Name', key: 'k1', value: 'X' }];
  assert.equal(fn({ previousFields: [{ section: 'Personal Details', label: 'Given Name', key: 'k0', value: 'X' }], previousSetAside: [], incomingFields: dep }).added, 1);
});
