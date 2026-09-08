'use strict';

// Statutory Yes/No answers (Gauri 2026-09-04, point 02).
//
// Until 2026-09-09 the engine's static-table pass collected each radio of a
// ".stat-table" row (F12 Visitor extension, F13 TRV) as its own field with no
// group name: the saved value was the option label ("yes"/"no") for every
// row, nothing restored on reopen, and the review ticked "No" for everyone.
// These tests pin the fix:
//   • ONE field per radio group, keyed by the first radio (names unchanged),
//     carrying _radioName so get/set use the checked state;
//   • the explanation textarea is collected;
//   • pre-fix placeholder pairs are stripped (client /data + localStorage),
//     kept as ONE "not recorded" marker for the review page and the PDF,
//     never shown as an answer.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const svc = require('../src/services/htmlQuestionnaireService');
const { stripLegacyStatutoryPairs, NOT_RECORDED_TEXT } = require('../src/utils/statutoryLegacy');
const { buildLayoutModel } = require('../src/services/questionnairePdfService');
const { El, fakeDom, statutoryTable } = require('./helpers/fakeDom');

const SECTION = 'Section 4 — Statutory Questions › Statutory Questions';
const SRC = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');

/** Slice a helper out of the CLIENT engine's template literal and evaluate it with real template semantics. */
function engineSlice(startMarker, endMarker, context) {
  const start = SRC.indexOf(startMarker);
  let end = SRC.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `engine slice located: ${startMarker.trim()}`);
  if (context.inclusive) end += endMarker.length;   // the marker IS the closing brace
  const raw = SRC.slice(start, end);
  assert.ok(!raw.includes('`') && !raw.includes('${'), 'the slice is plain template text');
  return vm.runInNewContext(new Function('return `' + raw + '`')() + '\n;({ ' + context.names.join(', ') + ' })', context.globals || {});
}
/** The ENGINE's own slugify — so key assertions prove the engine, not a copy. */
const { slugify } = engineSlice('  function slugify(s) {', '\n  }\n', { names: ['slugify'], inclusive: true });
function makeKeyFactory() {
  const seen = {};
  return (section, label) => { const b = slugify(section + '__' + label); seen[b] = (seen[b] || 0) + 1; return seen[b] === 1 ? b : `${b}-${seen[b]}`; };
}
function collector(dom) {
  return vm.runInNewContext(svc.STATIC_TABLE_COLLECTOR_JS + '\n;collectStaticTableFields', { document: dom.document });
}
/** The ENGINE's getFieldValue / setFieldValue (they read radio groups through _radioName). */
function engineGetSet(dom) {
  return engineSlice('  function getFieldValue(f) {', '\n  /* ── Progress ── */', { names: ['getFieldValue', 'setFieldValue'], globals: { document: dom.document } });
}
const ROWS = [
  { n: 1, name: 'sq1', question: 'Have you been convicted of a crime or offence in Canada?' },
  { n: 2, name: 'sq2', question: 'Have you ever been arrested for, charged with or convicted of any offence?' },
];

// ─── The shared collector: one field per radio group, legacy key kept ────────

test('collector: a statutory row is ONE field keyed by the first radio, with _radioName; the No radio is consumed', () => {
  const dom = fakeDom();
  const { table, radios } = statutoryTable(dom, ROWS);
  dom.body.add(table);
  const seen = [], fields = [];
  collector(dom)({ seen, fields, makeKey: makeKeyFactory(), getSectionContext: () => SECTION });
  assert.equal(fields.length, 2, 'one field per row, not one per radio');
  assert.equal(fields[0].key, 'section-4-statutory-questions-statutory-questions-1-answer-yes-no', 'the exact key pre-fix files used for the Yes radio');
  assert.equal(fields[1].key, 'section-4-statutory-questions-statutory-questions-2-answer-yes-no');
  assert.equal(fields[0].label, '1 — Answer (Yes / No)', 'label unchanged (keys derive from it)');
  assert.deepEqual([fields[0]._radioName, fields[1]._radioName], ['sq1', 'sq2']);
  assert.ok(fields[0].el === radios.sq1.yes, 'the group\'s element is the first radio');
  assert.ok(seen.includes(radios.sq1.no) && seen.includes(radios.sq2.no), 'both radios of the row are marked seen');
  assert.ok(!fields.some((f) => /-2$/.test(f.key)), 'the "-2" key is never produced again');
});

test('collector: text and select cells (Spousal-style tables) behave exactly as before', () => {
  const dom = fakeDom();
  const table = dom.body.add(new El('table', { cls: ['part-table'] }));
  const thead = table.add(new El('thead')); const hr = thead.add(new El('tr'));
  ['Person', 'Full name', 'Relationship'].forEach((h) => hr.add(new El('th', { text: h })));
  const tbody = table.add(new El('tbody'));
  const tr = tbody.add(new El('tr'));
  tr.add(new El('td', { text: 'Mother' }));
  const nameIn = tr.add(new El('td')).add(new El('input', { type: 'text' }));
  const relSel = tr.add(new El('td')).add(new El('select'));
  const two = dom.body.add(new El('table'));
  const tr2 = two.add(new El('tbody')).add(new El('tr'));
  tr2.add(new El('td', { text: 'Spouse in Canada?' }));
  const ynSel = tr2.add(new El('td')).add(new El('select'));
  const seen = [], fields = [];
  collector(dom)({ seen, fields, makeKey: makeKeyFactory(), getSectionContext: () => 'Part A › Family', extra: (row) => ({ group: row }) });
  assert.deepEqual(fields.map((f) => f.label), ['Mother — Full name', 'Mother — Relationship', 'Spouse in Canada?']);
  assert.ok(fields[0].el === nameIn && fields[1].el === relSel && fields[2].el === ynSel);
  assert.ok(fields.every((f) => !f._radioName));
  assert.ok(fields[0].group === tr, 'extra() props travel (the review keeps the row for flags)');
});

test('collector: dynamic tables and skipTable() tables are left alone; header rows without a tbody are skipped', () => {
  const dom = fakeDom();
  const dyn = dom.body.add(new El('table', { cls: ['dynamic-table'] }));
  dyn.add(new El('tbody')).add(new El('tr')).add(new El('td', { text: 'x' })).parentElement.add(new El('td')).add(new El('input'));
  const { table } = statutoryTable(dom, ROWS.slice(0, 1));
  table.classes.add('mm-hidden-marker');
  dom.body.add(table);
  const seen = [], fields = [];
  collector(dom)({ seen, fields, makeKey: makeKeyFactory(), getSectionContext: () => SECTION, skipTable: (t) => t.classList.contains('mm-hidden-marker') });
  assert.equal(fields.length, 0);
});

test('collector + engine get/set contract: a checked radio reads as its value, and setting by value ticks the right radio', () => {
  // The collector hands the engine `_radioName`; getFieldValue/setFieldValue
  // (unchanged) read/write the group's checked state through that name.
  const dom = fakeDom();
  const { table, radios } = statutoryTable(dom, ROWS.slice(0, 1));
  dom.body.add(table);
  const fields = [];
  collector(dom)({ seen: [], fields, makeKey: makeKeyFactory(), getSectionContext: () => SECTION });
  const { getFieldValue, setFieldValue } = engineGetSet(dom);
  assert.equal(getFieldValue(fields[0]), '', 'unanswered reads empty — it now counts as missing');
  radios.sq1.no.checked = true;
  assert.equal(getFieldValue(fields[0]), 'no', 'the client\'s real choice is what gets saved');
  setFieldValue(fields[0], 'yes');
  assert.deepEqual([radios.sq1.yes.checked, radios.sq1.no.checked], [true, false], 'restore ticks the saved choice');
  assert.equal(getFieldValue(fields[0]), 'yes');
});

// ─── Legacy placeholder pairs → not recorded ────────────────────────────────

const K = 'section-4-statutory-questions-statutory-questions-1-answer-yes-no';
const legacy = (n) => [
  { section: SECTION, label: `${n} — Answer (Yes / No)`, key: K.replace('-1-', `-${n}-`), value: 'yes' },
  { section: SECTION, label: `${n} — Answer (Yes / No)`, key: K.replace('-1-', `-${n}-`) + '-2', value: 'no' },
];

test('strip (server): a placeholder pair is removed; a real answer under the same key survives; keep:true leaves one marker', () => {
  const real = { section: SECTION, label: '3 — Answer (Yes / No)', key: K.replace('-1-', '-3-'), value: 'no' };
  const other = { section: 'Profile', label: 'Family Name', key: 'profile-family-name', value: 'Kaur' };
  const r = stripLegacyStatutoryPairs([...legacy(1), ...legacy(2), real, other]);
  assert.deepEqual(r.fields.map((f) => f.key), [real.key, other.key]);
  assert.deepEqual(r.notRecorded.map((x) => x.key), [K, K.replace('-1-', '-2-')]);
  const kept = stripLegacyStatutoryPairs([...legacy(1), other], { keep: true });
  assert.deepEqual(kept.fields.map((f) => [f.key, f.value, !!f.notRecorded]), [[K, '', true], [other.key, 'Kaur', false]]);
  // A "-2" entry alone, or a pair whose values are not the option labels, is not a placeholder.
  assert.equal(stripLegacyStatutoryPairs([{ key: K + '-2', value: 'no' }]).fields.length, 1);
  assert.equal(stripLegacyStatutoryPairs([{ key: K, value: 'no' }, { key: K + '-2', value: 'no' }]).fields.length, 2);
  assert.equal(stripLegacyStatutoryPairs([{ key: K, value: 'YES ' }, { key: K + '-2', value: 'No' }]).fields.length, 0, 'case/space tolerant');
});

test('strip (engine twin): the browser drops the same pairs from the server copy and the localStorage backup', () => {
  const strip = vm.runInNewContext(svc.LEGACY_STRIP_JS + '\n;stripLegacyStatutoryPairs', {});
  const real = { key: K.replace('-1-', '-3-'), value: 'no' };
  assert.deepEqual(strip([...legacy(1), real]).map((f) => f.key), [real.key]);
  assert.equal(strip(null), null);
});

test('PDF: a placeholder pair prints as ONE "not recorded" row, never as yes / no', () => {
  const blocks = buildLayoutModel([...legacy(5), { section: SECTION, label: 'Date of Refusal', key: 'x-date', value: '10/07/2026' }]);
  const rows = blocks.filter((b) => b.type === 'fields').flatMap((b) => b.rows);
  assert.deepEqual(rows.map((r) => [r.label, r.value]), [['5 — Answer (Yes / No)', NOT_RECORDED_TEXT], ['Date of Refusal', '10/07/2026']]);
});

// ─── Review page: no fake "No", a note per row and one warning ──────────────

function reviewMarker(dom, savedData) {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  const start = src.indexOf('  function markNotRecorded(fields) {');
  const end = src.indexOf('  function createReviewBar() {', start);
  assert.ok(start > 0 && end > start);
  const raw = src.slice(start, end);
  assert.ok(!raw.includes('`') && !raw.includes('${'));
  const code = new Function('return `' + raw + '`')();
  return vm.runInNewContext(code + '\n;markNotRecorded', { document: dom.document, SAVED_DATA: savedData, REVIEW_MEMBERS: [], IS_MULTI_REVIEW: false });
}

test('review: rows whose saved entry is a "not recorded" marker get unticked, noted, and a section warning', () => {
  const dom = fakeDom();
  const { table, radios } = statutoryTable(dom, ROWS);
  const section = dom.body.add(new El('div', { cls: ['section-body'] }));
  section.add(table);
  radios.sq1.no.checked = true;   // what the old page showed: "No" for everyone
  radios.sq2.no.checked = true;
  const fields = [];
  collector(dom)({ seen: [], fields, makeKey: makeKeyFactory(), getSectionContext: () => SECTION });
  const saved = stripLegacyStatutoryPairs([...legacy(1)], { keep: true }).fields;   // row 1 is a marker, row 2 has nothing saved
  reviewMarker(dom, saved)(fields);
  assert.equal(radios.sq1.no.checked, false, 'nothing ticked for the not-recorded row');
  assert.equal(radios.sq2.no.checked, true, 'other rows are untouched by the marker pass');
  assert.equal(table.querySelectorAll('.tdot-not-recorded').length, 1);
  assert.match(table.querySelector('.tdot-not-recorded').textContent, /re-confirm/);
  const banner = section.querySelector('.tdot-not-recorded-banner');
  assert.ok(banner && section.children.indexOf(banner) < section.children.indexOf(table), 'warning sits above the table');
  assert.match(banner.textContent, /1 statutory Yes\/No answer .*not captured/);
});

test('review: with no markers nothing is added', () => {
  const dom = fakeDom();
  const { table } = statutoryTable(dom, ROWS);
  dom.body.add(table);
  const fields = [];
  collector(dom)({ seen: [], fields, makeKey: makeKeyFactory(), getSectionContext: () => SECTION });
  reviewMarker(dom, [{ key: K, value: 'no' }])(fields);
  assert.equal(dom.body.querySelectorAll('.tdot-not-recorded, .tdot-not-recorded-banner').length, 0);
});

// ─── The explanation box counts only when some statutory answer is Yes ──────

function engineProgressHelpers(dom) {
  return engineSlice('  var CONDITIONAL_CLASSES', '\n  /* ── Dirty-tracking', { names: ['isExcludedFromProgress', 'findOptionalSections'], globals: { document: dom.document, window: dom.window } });
}

test('completion: the "please provide complete details" box is not a missing field for an all-No client', () => {
  const dom = fakeDom();
  const { table, radios } = statutoryTable(dom, ROWS);
  const section = dom.body.add(new El('div'));
  section.add(table);
  const expl = section.add(new El('div', { cls: ['explanation-block'] }));
  expl.add(new El('label', { text: 'If you answered Yes for any of the above questions, please provide complete details below:' }));
  const ta = expl.add(new El('textarea'));
  const h = engineProgressHelpers(dom);
  radios.sq1.no.checked = true; radios.sq2.no.checked = true;
  assert.equal(h.isExcludedFromProgress(ta, []), true, 'all No → the box does not apply');
  radios.sq2.no.checked = false; radios.sq2.yes.checked = true;
  assert.equal(h.isExcludedFromProgress(ta, []), false, 'a Yes → the details box is expected');
});

// ─── Multi-member: one member's placeholder never blanks another's answer ───

test('review: markers are scoped per member section', () => {
  const dom = fakeDom();
  const primary = dom.body.add(new El('div', { attrs: { 'data-member-key': 'primary' } }));
  const spouse  = dom.body.add(new El('div', { attrs: { 'data-member-key': 'spouse' } }));
  const p = statutoryTable(dom, [{ n: 1, name: 'primary-sq1', question: 'Q1' }]); primary.add(p.table);
  const s = statutoryTable(dom, [{ n: 1, name: 'spouse-sq1', question: 'Q1' }]);  spouse.add(s.table);
  s.radios['spouse-sq1'].yes.checked = true;   // the spouse answered Yes on the new engine
  const fields = [];
  collector(dom)({ seen: [], fields, makeKey: makeKeyFactory(), getSectionContext: () => SECTION });
  assert.equal(fields.length, 2);
  const marker = stripLegacyStatutoryPairs([...legacy(1)], { keep: true }).fields;   // primary's file: a placeholder
  const src = SRC; const start = src.indexOf('  function markNotRecorded(fields) {'); const end = src.indexOf('  function createReviewBar() {', start);
  const code = new Function('return `' + src.slice(start, end) + '`')();
  const mark = vm.runInNewContext(code + '\n;markNotRecorded', {
    document: dom.document, SAVED_DATA: marker, IS_MULTI_REVIEW: true,
    REVIEW_MEMBERS: [{ key: 'primary', fields: marker }, { key: 'spouse', fields: [{ key: K, value: 'yes' }] }],
    getMemberKeyForEl: (el) => (el.closest('[data-member-key]') || {}).attrs ? el.closest('[data-member-key]').getAttribute('data-member-key') : '',
  });
  mark(fields);
  assert.equal(s.radios['spouse-sq1'].yes.checked, true, 'the spouse\'s real Yes survives');
  assert.equal(p.table.querySelectorAll('.tdot-not-recorded').length, 1, 'only the primary\'s row is noted');
  assert.equal(s.table.querySelectorAll('.tdot-not-recorded').length, 0);
});

// ─── Guard: the placeholder detector matches every served radio table ───────

test('guard: every served form\'s radio stat-table header slugs to the suffix the strip helper keys on', () => {
  const map = fs.readFileSync(require.resolve('../config/questionnaireFormMap.js'), 'utf8');
  const path = require('path');
  const { FORMS_DIR } = require('../config/questionnaireFormMap');
  const files = [...new Set((map.match(/'[^']*\.html'/g) || []).map((s) => s.slice(1, -1)))];
  assert.ok(files.length >= 15, 'form list found');
  let radioTables = 0;
  for (const file of files) {
    const html = fs.readFileSync(path.join(FORMS_DIR, file), 'utf8');
    const tables = html.split(/<table\b/).slice(1);
    for (const t of tables) {
      const body = '<table' + t.slice(0, t.indexOf('</table>'));
      if (/class="[^"]*dynamic-table/.test(body) || !/type="radio"/.test(body)) continue;
      radioTables++;
      const ths = [...body.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
      const last = ths[ths.length - 1] || '';
      assert.ok(slugify('x__' + last).endsWith('-answer-yes-no'), `${file}: radio table header "${last}" must slug to …-answer-yes-no`);
    }
  }
  assert.ok(radioTables >= 2, `radio stat-tables found in served forms (${radioTables})`);
});

// ─── Wiring pins ─────────────────────────────────────────────────────────────

test('pins: the review\'s positional fallback only runs when NOTHING matched; unanswered groups fire on "No"; placeholder-only files get the note', () => {
  assert.match(SRC, /if \(keyMatched === 0 && lblMatched === 0\) \{/);
  assert.match(SRC, /var target = checked \|\| noOpt \|\| radios\[0\];/);
  const routes = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm.js'), 'utf8');
  assert.match(routes, /statutory Yes\/No rows were not captured by the form before 2026-09-09/);
  assert.match(SRC, /stripLegacyStatutoryPairs\(primaryFile\.fields\)\.fields\.some\(isClientAnswer\)/);
  const pdf = fs.readFileSync(require.resolve('../src/services/questionnairePdfService.js'), 'utf8');
  assert.equal((pdf.match(/stripLegacyStatutoryPairs\(fields\)\.fields/g) || []).length, 2, 'regenerate + export skip placeholder-only files');
});

test('pins: both engines use the shared collector and collect the explanation textarea; the client strips legacy pairs on restore', () => {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  assert.equal((src.match(/\$\{STATIC_TABLE_COLLECTOR_JS\}/g) || []).length, 2, 'client + review engines');
  assert.equal((src.match(/\$\{LEGACY_STRIP_JS\}/g) || []).length, 1, 'client engine');
  assert.equal((src.match(/document\.querySelectorAll\('table'\)/g) || []).length, 1, 'no private copy of pass 3 left behind');
  assert.equal((src.match(/querySelectorAll\('\.form-group, \.field-group, \.explanation-block'\)/g) || []).length, 2);
  assert.equal((src.match(/collectStaticTableFields\(\{/g) || []).length, 2);
  assert.match(src, /serverFields = stripLegacyStatutoryPairs\(data\.fields\)/);
  assert.match(src, /localFields = stripLegacyStatutoryPairs\(/);
  assert.match(src, /markNotRecorded\(fields\);\n\s+createReviewBar\(\);/);
});

test('pins: /data removes the pairs; the review routes keep one marker per row', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm.js'), 'utf8');
  const data = src.slice(src.indexOf("router.get('/:caseRef/data'"), src.indexOf("router.post('/:caseRef/save'"));
  assert.match(data, /svc\.stripLegacyStatutoryPairs\(await svc\.loadFormData\(/);
  assert.equal((src.match(/stripLegacyStatutoryPairs\([^)]*\{ keep: true \}\)/g) || []).length, 2, 'single + multi-member review');
});
