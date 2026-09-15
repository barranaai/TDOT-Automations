'use strict';

// Restore matcher (2026-09-16, case 2026-CEC-EE-077).
//
// When a form opens, each box receives its saved answer. The old matchers
// dropped EMPTY saved answers before matching, so a box the client left blank
// fell through to a label match that took the first answer with the same
// label — on forms holding several people with identical table labels
// ("Given Name — Row 2") that was ANOTHER PERSON's answer. The client's next
// save stored it, and clearing the box never helped: it refilled on reopen.
//
// These tests run the ENGINE's own matcher (the RESTORE_MATCH_JS string both
// injected scripts embed), not a copy.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const svc = require('../src/services/htmlQuestionnaireService');

const engine = vm.runInNewContext(svc.RESTORE_MATCH_JS + '\n;({ planRestoreValues, rowsFromLabels, labelRowCount })');
const plan = (dom, saved, norm) => Array.from(engine.planRestoreValues(dom, saved, norm));   // main-realm array for deepEqual
const rowsFromLabels = engine.rowsFromLabels;
const labelRowCount = (loose, tables, i) => engine.labelRowCount(loose, tables, i);
const fold = (s) => (s || '').replace(/[‘’ʼ]/g, "'").trim().toLowerCase();   // the client engine's normLbl
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const MA = 'Main Applicant';
const SP = 'Dependent Spouse / Common-Law Partner';
const CH = 'Dependent Children';
function cell(person, table, row, header, value) {
  return {
    section: `${person} › Section 2 — Family Information › Table`,
    label:   `${header} — Row ${row}`,
    key:     `${slug(person).slice(0, 12)}-tbl-${table}-r${row}-${slug(header)}`,
    value,
  };
}
const domOf = (saved) => saved.map(({ key, label, section }) => ({ key, label, section }));

test('THE BUG: a box left empty is never filled with another person\'s answer that has the same label', () => {
  const saved = [
    cell(MA, 'ma-family-living', 1, 'Given Name', 'Alex'),
    cell(MA, 'ma-family-living', 1, 'Family Name', 'Patel'),
    cell(MA, 'ma-family-living', 2, 'Given Name', 'Bina'),
    cell(SP, 'sp-family-living', 1, 'Given Name', 'Chandra'),
    cell(SP, 'sp-family-living', 1, 'Family Name', ''),
    cell(SP, 'sp-family-living', 2, 'Given Name', ''),
    cell(SP, 'sp-family-living', 2, 'Relationship', ''),
  ];
  assert.deepEqual(plan(domOf(saved), saved, fold), ['Alex', 'Patel', 'Bina', 'Chandra', null, null, null]);
});

test('a cleared answer stays cleared across repeated open → save cycles', () => {
  const saved = [
    cell(MA, 'ma-family-deceased', 1, 'Given Name', 'Alex'),
    cell(MA, 'ma-family-deceased', 1, 'Date of Death (DD/MM/YYYY)', '01/01/2000'),
    cell(SP, 'sp-family-deceased', 1, 'Given Name', ''),
    cell(SP, 'sp-family-deceased', 1, 'Date of Death (DD/MM/YYYY)', ''),
  ];
  let file = saved.map((f) => ({ ...f }));
  for (let cycle = 0; cycle < 3; cycle++) {
    const vals = plan(domOf(file), file, fold);
    file = file.map((f, i) => ({ ...f, value: vals[i] == null ? '' : vals[i] }));   // what the next save stores
  }
  assert.deepEqual(file.map((f) => f.value), saved.map((f) => f.value), 'nothing drifted between people');
});

test('round trip: every answer returns to its own box — three people, two same-labelled tables, blank rows', () => {
  const saved = [];
  const people = [MA, SP, CH];
  const tables = ['family-living', 'family-deceased'];
  const headers = ['Given Name', 'Family Name', 'Relationship', 'Date of Birth (DD/MM/YYYY)'];
  people.forEach((p, pi) => tables.forEach((t, ti) => {
    for (let r = 1; r <= 4; r++) headers.forEach((h, hi) => {
      const blank = (pi + ti + r + hi) % 3 === 0;
      saved.push(cell(p, `${pi}-${t}`, r, h, blank ? '' : `${pi}.${ti}.${r}.${hi}`));
    });
  }));
  const vals = plan(domOf(saved), saved, fold);
  assert.deepEqual(vals, saved.map((f) => (f.value ? f.value : null)));
  assert.ok(saved.some((f) => !f.value) && saved.some((f) => f.value), 'fixture mixes blanks and answers');
});

test('pre-2026-08-19 smeared keys still restore by label — positionally, with blanks counted', () => {
  // Old files gave every cell of a long table ONE key; the page now has unique keys.
  const saved = [
    { section: `${MA} › Family › Table`, label: 'Given Name — Row 1', key: 'smeared-living', value: '' },
    { section: `${MA} › Family › Table`, label: 'Family Name — Row 1', key: 'smeared-living', value: '' },
    { section: `${MA} › Family › Table`, label: 'Given Name — Row 1', key: 'smeared-deceased', value: 'Alex' },
    { section: `${MA} › Family › Table`, label: 'Family Name — Row 1', key: 'smeared-deceased', value: 'Patel' },
  ];
  const dom = [
    { section: `${MA} › Family › Table`, key: 'ma-tbl-living-r1-given-name', label: 'Given Name — Row 1' },
    { section: `${MA} › Family › Table`, key: 'ma-tbl-living-r1-family-name', label: 'Family Name — Row 1' },
    { section: `${MA} › Family › Table`, key: 'ma-tbl-deceased-r1-given-name', label: 'Given Name — Row 1' },
    { section: `${MA} › Family › Table`, key: 'ma-tbl-deceased-r1-family-name', label: 'Family Name — Row 1' },
  ];
  assert.deepEqual(plan(dom, saved, fold), [null, null, 'Alex', 'Patel'],
    'the blank living row stays blank; the deceased row keeps its own answers');
});

test('an answer claimed by its own box is never offered to another box with the same label', () => {
  const saved = [{ section: 'S1', label: 'City', key: 'a', value: 'Toronto' }];
  const dom = [{ key: 'a', label: 'City' }, { key: 'b-added-by-a-form-edit', label: 'City' }];
  assert.deepEqual(plan(dom, saved, fold), ['Toronto', null]);
});

test('an EMPTY own answer stays empty; same section + label under a new key is the same question; other sections never borrow', () => {
  const saved = [
    { section: 'Spouse › Family › Table', label: 'Given Name — Row 1', key: 'sp-given', value: '' },
    { section: 'Spouse › Family › Table', label: 'Given Name — Row 1', key: 'old-key-before-a-form-edit', value: 'Alex' },
    { section: 'Spouse › Family › Table', label: 'Family Name — Row 1', key: 'sp-family', value: '' },
    { section: 'Pre-filled from intake', label: 'Family Name — Row 1', key: 'prefill__family-name', value: 'Patel', source: 'prefill' },
  ];
  const dom = [
    { section: 'Spouse › Family › Table', key: 'sp-given', label: 'Given Name — Row 1' },
    { section: 'Spouse › Family › Table', key: 'sp-family', label: 'Family Name — Row 1' },
    { section: 'Spouse › Family › Table', key: 'sp-given-new-key', label: 'Given Name — Row 1' },
    { section: 'Main Applicant › Family › Table', key: 'ma-given-new', label: 'Given Name — Row 1' },
    { section: 'Main Applicant › Family › Table', key: 'ma-family-new', label: 'Family Name — Row 1' },
  ];
  assert.deepEqual(plan(dom, saved, fold), [null, null, 'Alex', null, 'Patel'], [
    'empty own answers stay empty and consume no label positions',
    'the same question under a new key (same section + label) is restored',
    'a section the page still has never lends its answers to another section',
    'intake pre-fill (a section the page does not have) still places by label',
  ].join('; '));
});

test('intake pre-fill (synthetic keys) still fills by label — first occurrence first, apostrophes folded', () => {
  const saved = [
    { section: 'Pre-filled from intake', label: 'Given Name', key: 'prefill__given-name', value: 'John', source: 'prefill' },
    { section: 'Pre-filled from intake', label: "Spouse's Date of Birth", key: 'prefill__spouse-s-date-of-birth', value: '01/01/1990', source: 'prefill' },
  ];
  const dom = [
    { key: 'ma-given-name', label: 'Given Name' },
    { key: 'sp-given-name', label: 'Given Name' },
    { key: 'sp-dob', label: 'Spouse’s Date of Birth' },
  ];
  assert.deepEqual(plan(dom, saved, fold), ['John', null, '01/01/1990']);
});

test('odd input: whitespace-only is empty, a duplicated key falls back to labels, missing entries are safe', () => {
  const saved = [
    { label: 'X', key: 'a', value: '   ' },
    null,
    { label: 'Y', key: 'd', value: 'one' },
    { label: 'Y', key: 'd', value: 'two' },
  ];
  const dom = [{ key: 'a', label: 'X' }, { key: 'd', label: 'Y' }, { key: 'e', label: 'Y' }, { key: 'z', label: 'Z' }, null];
  assert.deepEqual(plan(dom, saved, fold), [null, 'one', 'two', null, null]);
  assert.deepEqual(plan([], []), []);
  assert.deepEqual(plan(undefined, undefined), []);
  assert.deepEqual(plan([{ key: 'q', label: 'Q' }], [{ key: 'q', label: 'Q', value: 'kept' }]), ['kept'], 'default label fold works');
});

test('old table keys: rows land by section + column even when another table has fewer boxes than saved rows', () => {
  // Pre-2026-08-19 file: every cell key smeared; the parents table could not be expanded (one box row).
  const P = 'Main Applicant › Section 4 — Family › Parents › Table', C = 'Main Applicant › Section 4 — Family › Children › Table';
  const saved = [
    { section: P, label: 'Full Name — Row 1', key: 'smeared-p', value: 'Father' },
    { section: P, label: 'Full Name — Row 2', key: 'smeared-p', value: '' },
    { section: C, label: 'Full Name — Row 1', key: 'smeared-c', value: 'Child One' },
    { section: C, label: 'Full Name — Row 2', key: 'smeared-c', value: 'Child Two' },
  ];
  const dom = [
    { section: P, key: 'p-r1', label: 'Full Name — Row 1' },
    { section: C, key: 'c-r1', label: 'Full Name — Row 1' },
    { section: C, key: 'c-r2', label: 'Full Name — Row 2' },
  ];
  assert.deepEqual(plan(dom, saved, fold), ['Father', 'Child One', 'Child Two']);
});

test('rowsFromLabels: a table\'s row count read from saved " — Row N" labels in its own section', () => {
  const sec = 'Main Applicant › Section 4 — Family Information › Table';
  const cell = (label, section = sec) => ({ section, label, key: 'main-applicant-section-4-family-information-parent-s-and-spouse-s-information-tbl-tbl-ma-p', value: '' });
  const saved = [
    cell('Full Name — Row 1'), cell('Relationship — Row 1'),
    cell('Full Name — Row 2'), cell('Relationship — Row 2'),
    cell('Full Name — Row 3'),                                        // incomplete row: not counted
    cell('Full Name — Row 9', 'Some Other Section › Table'), cell('Relationship — Row 9', 'Some Other Section › Table'),
    cell('Full Name — Row x2'), cell('Relationship — Row 02'),        // malformed row numbers ignored
    cell('Full Name — Row 500'), cell('Relationship — Row 500'),      // absurd row numbers ignored
  ];
  assert.equal(rowsFromLabels(saved, sec, ['Full Name', 'Relationship']), 2);
  assert.equal(rowsFromLabels(saved, sec, ['Full Name']), 3, 'a one-column table counts every row with that column');
  assert.equal(rowsFromLabels(saved, sec, ['Full Name', 'Relationship', 'Date of Birth']), 0, 'rows must carry every column of THIS table');
  assert.equal(rowsFromLabels(saved, sec, []), 0);
  assert.equal(rowsFromLabels(null, sec, ['Full Name']), 0);
});

test('labelRowCount: no guess when another table in the section carries every column; rows from 10 on are counted', () => {
  const S = 'Main Applicant › Section 4 — Family Information › Table';
  const rowsOf = (n, headers, section = S) => headers.map((h) => ({ section, label: `${h} — Row ${n}`, key: 'cut-before-row-number', value: '' }));
  const loose = [...rowsOf(1, ['Full Name', 'Relationship']), ...rowsOf(2, ['Full Name', 'Relationship']), ...rowsOf(3, ['Full Name', 'Relationship'])];
  const twins = [{ section: S, headers: ['Full Name', 'Relationship'] }, { section: S, headers: ['Full Name', 'Relationship'] }];
  assert.deepEqual([labelRowCount(loose, twins, 0), labelRowCount(loose, twins, 1)], [0, 0], 'identical twins: the rows could belong to either');
  const superset = [{ section: S, headers: ['Full Name', 'Relationship'] }, { section: S, headers: ['Full Name', 'Relationship', 'Date of Birth'] }];
  assert.equal(labelRowCount(loose, superset, 0), 0, 'a wider table in the section carries every column of this one');
  assert.equal(labelRowCount([...loose, ...rowsOf(1, ['Date of Birth']), ...rowsOf(2, ['Date of Birth'])], superset, 1), 2, 'the wider table is unambiguous');
  const apart = [{ section: S, headers: ['Full Name', 'Relationship'] }, { section: 'Dependent Spouse › Family › Table', headers: ['Full Name', 'Relationship'] }];
  assert.equal(labelRowCount(loose, apart, 0), 3, 'same columns in another section do not block');
  const tenPlus = [...rowsOf(10, ['Full Name', 'Relationship']), ...rowsOf(11, ['Full Name', 'Relationship'])];
  assert.equal(labelRowCount(tenPlus, [{ section: S, headers: ['Full Name', 'Relationship'] }], 0), 11, 'rows whose keys were cut before -r10- still count');
  assert.equal(labelRowCount(loose, [], 0), 0);
});

test('both engines use the shared matcher, and the empty-skipping matchers are gone', () => {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  assert.equal((src.match(/planRestoreValues\(memberFields, sourceFields, normLbl\)/g) || []).length, 1, 'client form');
  assert.equal((src.match(/planRestoreValues\(memberFields, m\.fields,/g) || []).length, 1, 'staff family review');
  assert.equal((src.match(/planRestoreValues\(fields, SAVED_DATA,/g) || []).length, 1, 'staff single-page review (F1 family forms)');
  assert.equal((src.match(/var labelMax = labelRowCount\(looseRows, tableInfo, ti\);\s+if \(labelMax > \(maxRow \|\| 0\)\) maxRow = labelMax;/g) || []).length, 2, 'both engines expand old-key tables by label (the larger count wins)');
  assert.equal((src.match(/tableInfo\.push\(\{ section: getSectionContext\(tables\[tii\]\) \+ ' › Table', headers: tableHeadersOf\(tables\[tii\]\) \}\);/g) || []).length, 2, 'both engines describe every table by section + headers');
  assert.doesNotMatch(src, /byLabel\[fkey\]\[occ\]/, 'the staff review\'s all-answers label pass is gone');
  assert.equal((src.match(/\$\{RESTORE_MATCH_JS\}/g) || []).length, 2, 'embedded in both injected scripts');
  assert.doesNotMatch(src, /if \(!sf\.value \|\| !sf\.value\.trim\(\)\) continue;/, 'no matcher skips empty saved answers');
  assert.ok(!svc.RESTORE_MATCH_JS.includes('`') && !svc.RESTORE_MATCH_JS.includes('${') && !svc.RESTORE_MATCH_JS.includes('\\'),
    'the shared snippet is plain template text');
});

test('the emitted client form and staff review page carry the matcher and their scripts parse', () => {
  const F1 = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
  const page = svc.buildFormPage({
    formFile: F1, caseRef: 'T', token: 't', formKey: 'primary', formTitle: 'x', hasAdditionalForm: false,
    overviewUrl: '/q', memberLabel: 'PA', members: [{ key: 'primary', type: 'Principal Applicant', label: 'PA' }],
    allowedMemberTypes: [], otherFormUrl: null, otherFormTitle: null, isAdditionalForm: false, formKeySuffix: '',
  });
  const review = svc.buildReviewFormPage({ formFile: F1, caseRef: 'T', formKey: 'primary', staffName: 'S',
    savedFields: [], savedFlags: {}, members: [], formKeySuffix: '' });
  for (const [name, html] of [['client form', page], ['staff review', review]]) {
    assert.ok(html.includes('function planRestoreValues('), `${name} embeds the matcher`);
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m, n = 0;
    while ((m = re.exec(html))) { n++; assert.doesNotThrow(() => new vm.Script(m[1]), `${name} script #${n} parses`); }
    assert.ok(n >= 1, `${name}: scripts found`);
  }
});
