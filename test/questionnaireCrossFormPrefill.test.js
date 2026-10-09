'use strict';

// Cross-form pre-fill (2026-10-09, case 2026-CEC-PS-100): when a spouse is added
// on an Express Entry case, the answers the client typed for the spouse in the
// PROFILE form (F6) are pre-filled into the spouse's APPLICATION-form (F1)
// section for review — by a hand-made, question-by-question mapping checked
// here against the real forms.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const cross    = require('../src/services/questionnaireCrossFormPrefill');
const carry    = require('../src/services/questionnaireCarryOverService');
const svc      = require('../src/services/htmlQuestionnaireService');
const oneDrive = require('../src/services/oneDriveService');

const FORMS_DIR = path.join(__dirname, '..', 'Questionnair Documents');
const F6  = '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.html';
const F1  = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const FORMS = { primary: F6, additional: F1, memberTypes: ['Spouse / Common-Law Partner', 'Dependent Child'] };
const F = (section, label, key, value, extra = {}) => ({ section, label, key, value, ...extra });
const decode = (s) => s.replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/&#9662;/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** [{section, label}] of a form part, as the member section stores them; tables give { section: '<sub> › Table', table, header }. */
function questions(html, startMark, endMark) {
  const s = html.indexOf(startMark), e = endMark ? html.indexOf(endMark, s + 1) : html.length;
  const part = html.slice(s, e);
  const subs = [...part.matchAll(/<div class="sub-accordion-header[^"]*"[^>]*onclick="toggleSub\(this\)">([\s\S]*?)<\/div>/g)].map((m) => ({ name: decode(m[1]), at: m.index }));
  const out = [];
  for (let i = 0; i < subs.length; i++) {
    const seg = part.slice(subs[i].at, i + 1 < subs.length ? subs[i + 1].at : part.length);
    for (const m of seg.matchAll(/<label>([\s\S]*?)<\/label>/g)) out.push({ section: subs[i].name, label: decode(m[1]) });
    for (const t of seg.matchAll(/<table class="dynamic-table" id="([a-z0-9-]+)">([\s\S]*?)<\/table>/g)) {
      for (const h of t[2].matchAll(/<th>([\s\S]*?)<\/th>/g)) { const hh = decode(h[1]); if (hh && !/^(action|actions|remove)$/i.test(hh)) out.push({ section: `${subs[i].name} › Table`, table: t[1], header: hh }); }
    }
  }
  return out;
}

test('REAL FORMS: every mapped source question exists in the profile form\'s dependent block, and every target question exists in the application form\'s spouse section, exactly as written', () => {
  const f6 = fs.readFileSync(path.join(FORMS_DIR, F6), 'utf8');
  const f1 = fs.readFileSync(path.join(FORMS_DIR, F1), 'utf8');
  const dep = questions(f6, 'Dependent (If Accompany)', null);
  const main = questions(f6, 'Main Applicant', 'Dependent (If Accompany)');
  const sp = questions(f1, 'id="spouse-section"', 'id="children-section"');
  const has = (list, section, label) => list.some((q) => q.section === section && q.label === label);
  for (const [[fs6, l6], [fs1, l1]] of cross.MAP_BOXES) {
    assert.ok(has(dep, fs6, l6), `profile form has "${fs6}" / "${l6}"`);
    assert.ok(has(sp, fs1, l1), `application form spouse section has "${fs1}" / "${l1}"`);
  }
  for (const [l6, [fs1, l1]] of cross.MAP_MARITAL) {
    assert.ok(has(main, 'Section 1 — Profile Details', l6), `profile form main applicant has "${l6}"`);
    assert.ok(has(sp, fs1, l1), `application form spouse section has "${fs1}" / "${l1}"`);
  }
  for (const t of cross.MAP_TABLES) {
    const srcCols = dep.filter((q) => q.table === t.from).map((q) => q.header);
    const dstCols = sp.filter((q) => q.table === t.to).map((q) => q.header);
    assert.ok(srcCols.length && dstCols.length, `${t.from} → ${t.to} exist`);
    assert.ok(dep.some((q) => q.table === t.from && q.section === t.fromSection), `${t.from} sits in "${t.fromSection}"`);
    assert.ok(sp.some((q) => q.table === t.to && q.section === `${t.toSection} › Table`), `${t.to} sits in "${t.toSection}"`);
    for (const [from, to] of t.columns) {
      for (const h of (Array.isArray(from) ? from : [from])) assert.ok(srcCols.includes(h), `${t.from} has column "${h}"`);
      assert.ok(dstCols.includes(to), `${t.to} has column "${to}"`);
    }
  }
  for (const l of cross.NO_TARGET) assert.ok(dep.some((q) => q.label === l), `"${l}" is a profile-form question`);
  for (const [sec, l] of cross.MAP_SIBLINGS.from) assert.ok(has(dep, sec, l), `profile form has "${l}"`);
  assert.ok(has(sp, cross.MAP_SIBLINGS.to[0], cross.MAP_SIBLINGS.to[1]));
  // nothing answered in the block is silently forgotten: every box label is mapped or listed as having no target
  const mapped = new Set([...cross.MAP_BOXES.map(([[, l]]) => l), ...cross.MAP_SIBLINGS.from.map(([, l]) => l), ...cross.NO_TARGET]);
  for (const q of dep.filter((q) => q.label)) assert.ok(mapped.has(q.label), `"${q.label}" is mapped or listed`);
});

const SPOUSE_F6 = [   // as the carry-over writes the spouse's profile-form section (top header stripped, tagged)
  F('Section 1 — Profile Details', 'Family Name (Surname)', 'k-fam', 'Rauf'),
  F('Section 1 — Profile Details', 'Given Name', 'k-given', 'Sabri'),
  F('Section 1 — Profile Details', 'Have you ever used any other name? (If yes, please provide details)', 'k-other', 'no'),
  F('Section 1 — Profile Details', 'Current Residence Country', 'k-country', 'Canada'),
  F('Section 1 — Profile Details', 'Status in Current Country (Visitor, Student, Worker, Citizen)', 'k-status', 'Worker'),
  F('Section 1 — Profile Details', 'Mobile Number', 'k-mob', '+1 416 555 0100'),
  F('Section 1 — Profile Details', 'Residential Address Postal Code', 'k-pc', 'M1B 2C3'),
  F('Section 2 — Education › Table', 'Start Date (DD/MM/YYYY) — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-start-date-dd-mm-yyyy', '01/2010'),
  F('Section 2 — Education › Table', 'Course / Program Name — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-course-program-name', 'Bachelor of Science'),
  F('Section 2 — Education › Table', 'Education Institute — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-education-institute', 'University of Colombo'),
  F('Section 2 — Education › Table', 'City, Country — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-city-country', 'Colombo, Sri Lanka'),
  F('Section 2 — Employment History › Table', 'Job Title — Row 2', 'section-2-employment-history-tbl-spouse-dep-employment-r2-job-title', 'Cook'),
  F('Section 2 — Employment History › Table', 'Company Name — Row 2', 'section-2-employment-history-tbl-spouse-dep-employment-r2-company-name', 'Bhasha Lanka'),
  F('Section 2 — Employment History › Table', 'City — Row 2', 'section-2-employment-history-tbl-spouse-dep-employment-r2-city', 'Toronto'),
  F('Section 2 — Employment History › Table', 'Country — Row 2', 'section-2-employment-history-tbl-spouse-dep-employment-r2-country', 'Canada'),
  F('Section 2 — Employment History › Table', 'Start Date (DD/MM/YYYY) — Row 3', 'section-2-employment-history-tbl-spouse-dep-vacation-r3-start-date-dd-mm-yyyy', '01/2024'),   // the vacation table: no box on the application form
  F('Section 2 — Employment History', 'Explanation', 'k-expl', ''),
].map((f) => ({ ...f, source: 'carry-over' }));
const PRINCIPAL_F6 = [
  F('Main Applicant › Section 1 — Profile Details', 'Family Name (Surname)', 'p-fam', 'Mohamed Subuhan'),
  F('Main Applicant › Section 1 — Profile Details', 'Given Name', 'p-given', 'Fathima Bushra'),
  F('Main Applicant › Section 1 — Profile Details', 'Current Marital Status', 'p-ms', 'Married'),
  F('Main Applicant › Section 1 — Profile Details', 'Date of Marriage / Common Law', 'p-dom', '18/02/2018'),
  F('Main Applicant › Section 1 — Profile Details', 'Spouse’s Given Name', 'p-sg', 'Mohamed Sabri'),
  F('Dependent (If Accompany) › Section 1 — Profile Details', 'Given Name', 'd-given', 'Sabri'),
];

test('the plan: boxes by exact question, the spouse\'s "Marital Status" from the principal\'s own answers, table rows column by column (joined where the application form asks one question for two), keys the application-form boxes own; answers with no box are listed', () => {
  const p = cross.planCrossFormPrefill({ memberFields: SPOUSE_F6, principalFields: PRINCIPAL_F6, memberKey: 'spouse' });
  const by = Object.fromEntries(p.fields.map((f) => [`${f.section} | ${f.label}`, f.value]));
  assert.equal(by['Personal Details | Family Name (Surname)'], 'Rauf');
  assert.equal(by['Personal Details | Given Name'], 'Sabri');
  assert.equal(by['Personal Details | Have you ever used any other name?'], 'no');
  assert.equal(by['Personal Details | Current Residence Country'], 'Canada');
  assert.equal(by['Personal Details | Phone Number'], '+1 416 555 0100');
  assert.equal(by['Marital Status | Current Marital Status'], 'Married');
  assert.equal(by['Marital Status | Date of Marriage'], '18/02/2018');
  assert.equal(by["Marital Status | Spouse's Family Name"], 'Mohamed Subuhan', 'the spouse\'s spouse is the principal');
  assert.equal(by["Marital Status | Spouse's Given Name"], 'Fathima Bushra');
  assert.equal(by['Section 4 — Education and Employment › Table | Start Date — Row 1'], '01/2010');
  assert.equal(by['Section 4 — Education and Employment › Table | Course / Program — Row 1'], 'Bachelor of Science');
  assert.equal(by['Section 4 — Education and Employment › Table | Institute — Row 1'], 'University of Colombo');
  assert.equal(by['Section 4 — Education and Employment › Table | Country — Row 1'], 'Sri Lanka', 'the country is the part after the last comma');
  assert.equal(by['Section 4 — Education and Employment › Table | City (Address with Postal Code) — Row 1'], 'Colombo', 'no campus address typed: the city is the part before the comma');
  assert.equal(by['Section 5 — Personal History › Table | Job Title / Education — Row 2'], 'Cook');
  assert.equal(by['Section 5 — Personal History › Table | Company / School — Row 2'], 'Bhasha Lanka');
  assert.equal(by['Section 5 — Personal History › Table | City & Country (Address with Postal Code) — Row 2'], 'Toronto, Canada');
  assert.equal(p.copied, 17);
  assert.ok(p.fields.every((f) => f.source === 'prefill'), 'every pre-filled answer is tagged for review');
  const cell = p.fields.find((f) => f.label === 'Course / Program — Row 1');
  assert.equal(cell.key, carry.memberTableKey('Section 4 — Education and Employment', 'spouse-sp-education', 1, 'Course / Program'), 'the box\'s own key');
  assert.deepEqual(p.unmapped, ['Status in Current Country (Visitor, Student, Worker, Citizen)', 'Residential Address Postal Code', 'vacation table: Start Date (DD/MM/YYYY)'], 'answered on the profile form, no box on the application form (the vacation table named as such)');
  // the siblings question: yes/no + province become one answer; a campus address wins over the city; no comma → no country
  const q = cross.planCrossFormPrefill({ memberKey: 'spouse', memberFields: [
    F('Section 1 — Profile Details', 'Do you have siblings in Canada as a Permanent Resident?', 'k-sib', 'yes'),
    F('Section 1 — Profile Details', 'If yes, in which province he/she resides', 'k-prov', 'Ontario'),
    F('Section 2 — Education › Table', 'Campus Address with Postal Code — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-campus-address-with-postal-code', '12 Main St, Colombo 00100'),
    F('Section 2 — Education › Table', 'City, Country — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-city-country', 'Colombo'),
  ] });
  const qb = Object.fromEntries(q.fields.map((f) => [f.label, f.value]));
  assert.equal(qb['Siblings in Canada who are Permanent Residents?'], 'Yes — Ontario');
  assert.equal(qb['City (Address with Postal Code) — Row 1'], '12 Main St, Colombo 00100', 'the campus address wins');
  assert.equal(qb['Country — Row 1'], undefined, 'a lone word in "City, Country" is not guessed to be the country');
  assert.deepEqual(q.unmapped, ['education table: City, Country'], 'the lone word landed nowhere, so it is reported');
  // a lone word with no address either: neither cell is guessed (city? country?), the cell is reported
  const lone = cross.planCrossFormPrefill({ memberKey: 'spouse', memberFields: [
    F('Section 2 — Education › Table', 'Education Institute — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-education-institute', 'Seneca'),
    F('Section 2 — Education › Table', 'City, Country — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-city-country', 'Canada'),
  ] });
  assert.deepEqual(lone.fields.map((f) => [f.label, f.value]), [['Institute — Row 1', 'Seneca']]);
  assert.deepEqual(lone.unmapped, ['education table: City, Country']);
  // the province box is hidden for "no" on the profile form but still saved: a stale province never joins a "No"
  const stale = cross.planCrossFormPrefill({ memberKey: 'spouse', memberFields: [
    F('Section 1 — Profile Details', 'Do you have siblings in Canada as a Permanent Resident?', 'k-sib', 'no'),
    F('Section 1 — Profile Details', 'If yes, in which province he/she resides', 'k-prov', 'Ontario'),
  ] });
  assert.deepEqual(stale.fields.map((f) => [f.label, f.value]), [['Siblings in Canada who are Permanent Residents?', 'No']]);
  assert.deepEqual(stale.unmapped, []);
  assert.ok(!p.fields.some((f) => f.label === 'Explanation'), 'an empty answer is never pre-filled');
  assert.equal(cross.planCrossFormPrefill({ memberFields: [], principalFields: [], memberKey: 'spouse' }).copied, 0);
});

test('the form pair: only the profile form → the application form', () => {
  assert.equal(cross.isProfileToApplication(FORMS), true);
  assert.equal(cross.isProfileToApplication({ primary: F1, additional: null }), false);
  assert.equal(cross.isProfileToApplication({ primary: '19. Express Entry Profile Creation + EOI OINP - Questionnaire - Aug 2026.html', additional: F1 }), true);
  assert.equal(cross.isProfileToApplication(null), false);
});

/* I/O over stubbed storage */
function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
let N = 0;
function world(files) {
  const caseRef = `2026-XF-${String(++N).padStart(3, '0')}`;
  const store = {};
  for (const [k, v] of Object.entries(files)) store[`questionnaire-${caseRef}-${k}.json`] = JSON.stringify(v);
  const uploads = [];
  const restores = [
    stub(oneDrive, 'readFile', async (a) => (store[a.filename] != null ? Buffer.from(store[a.filename]) : null)),
    stub(oneDrive, 'uploadFile', async (a) => { uploads.push(a.filename); store[a.filename] = a.buffer.toString('utf8'); }),
    stub(oneDrive, 'ensureClientFolder', async () => {}),
    // what production returns for a case on the current edition: the forms unchanged (an older edition comes back as the April file name)
    stub(cross.io, 'servedForms', async ({ formFiles }) => ({ ...formFiles })),
  ];
  return { caseRef, store, uploads, file: (k) => JSON.parse(store[`questionnaire-${caseRef}-${k}.json`]), restore: () => restores.forEach((r) => r()) };
}
const args = (w, extra = {}) => ({ clientName: 'Fathima', caseRef: w.caseRef, itemId: '1', memberKey: 'spouse', memberFields: SPOUSE_F6, principalFields: PRINCIPAL_F6, forms: FORMS, ...extra });

test('writes the spouse\'s application-form file ONLY when it does not exist, recording the application-form edition the case is served; dry run writes nothing', async () => {
  const w = world({});
  try {
    const d = await cross.crossFormPrefill(args(w, { dryRun: true }));
    assert.equal(d.dryRun, true); assert.equal(d.copied, 17); assert.deepEqual(w.uploads, []);
    const r = await cross.crossFormPrefill(args(w));
    assert.equal(r.written, true); assert.equal(r.target, 'spouse-additional'); assert.equal(r.formFile, F1);
    assert.deepEqual(w.uploads, [`questionnaire-${w.caseRef}-spouse-additional.json`]);
    const f = w.file('spouse-additional');
    assert.equal(f.formFile, F1, 'records the current application-form edition — the only one the mapping is for'); assert.equal(f.completionPct, 0); assert.equal(f.fields.length, 17);
    const again = await cross.crossFormPrefill(args(w));
    assert.equal(again.skipped, 'has-file'); assert.equal(again.written, false); assert.equal(w.uploads.length, 1);
  } finally { w.restore(); }
  const seeded = world({ 'spouse-additional': { fields: [F('Pre-filled from intake', 'Given Name', 'prefill__given-name', 'S.', { source: 'prefill' })], completionPct: 0 } });
  try { const r = await cross.crossFormPrefill(args(seeded)); assert.equal(r.skipped, 'has-file', 'never over an existing file, not even a pre-fill'); assert.deepEqual(seeded.uploads, []); } finally { seeded.restore(); }
  const other = world({});
  try { const r = await cross.crossFormPrefill(args(other, { forms: { primary: F1, additional: null } })); assert.equal(r.skipped, 'not-this-form-pair'); assert.deepEqual(other.uploads, []); } finally { other.restore(); }
  // a case served an OLDER application-form edition: its questions differ, so nothing is pre-filled (and the note says so)
  const legacy = world({});
  const r3 = stub(cross.io, 'servedForms', async () => ({ primary: F6, additional: '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025.html' }));
  try { const r = await cross.crossFormPrefill(args(legacy)); assert.equal(r.skipped, 'legacy-edition'); assert.equal(r.written, false); assert.deepEqual(legacy.uploads, []); } finally { r3(); legacy.restore(); }
});

test('a storage failure throws (err.transient); the served-edition read failing throws too — nothing written', async () => {
  const w = world({});
  const r1 = stub(oneDrive, 'readFile', async () => { throw new Error('Graph 503'); });
  try { await assert.rejects(cross.crossFormPrefill(args(w)), (e) => e.transient === true); } finally { r1(); }
  const r2 = stub(cross.io, 'servedForms', async () => { const e = new Error('era read failed'); e.transient = true; throw e; });
  try { await assert.rejects(cross.crossFormPrefill(args(w)), (e) => e.transient === true); assert.deepEqual(w.uploads, []); } finally { r2(); w.restore(); }
});

test('through the carry-over: a spouse add on an Express Entry case copies the profile-form block AND pre-fills the application-form section, in that order; a child add, or another form pair, never pre-fills', async () => {
  const PRIMARY = { fields: [
    ...PRINCIPAL_F6.filter((f) => !/^Dependent/.test(f.section)),
    F('Main Applicant › Section 1 — Profile Details', 'Spouse’s Family Name', 'p-sf', 'Rauf'),
    F('Main Applicant › Section 1 — Profile Details', 'Accompany to the Application? (If yes, please provide details in dependent section)', 'p-acc', 'Yes'),
    F('Dependent (If Accompany) › Section 1 — Profile Details', 'Family Name (Surname)', 'd-fam', 'Rauf'),
    F('Dependent (If Accompany) › Section 1 — Profile Details', 'Given Name', 'd-given', 'Sabri'),
    F('Dependent (If Accompany) › Section 2 — Education › Table', 'Course / Program Name — Row 1', 'dependent-if-accompany-section-2-education-tbl-dep-education-r1-course-program-name', 'Bachelor of Science'),
  ], completionPct: 98, savedAt: '2026-09-30T11:33:22Z', formFile: F6 };
  const w = world({ primary: PRIMARY });
  try {
    const r = await carry.carryEmbeddedAnswers({ clientName: 'Fathima', caseRef: w.caseRef, itemId: '1', memberKey: 'spouse', memberType: 'Spouse / Common-Law Partner', memberName: 'Mohamed Sabri Rauf', forms: FORMS });
    assert.equal(r.written, true); assert.equal(r.attributedBlock, true); assert.equal(r.copied, 3);
    assert.ok(r.crossForm && r.crossForm.written, 'the application-form section was pre-filled');
    assert.deepEqual(w.uploads, [`questionnaire-${w.caseRef}-spouse.json`, `questionnaire-${w.caseRef}-spouse-additional.json`], 'the copy first, then the pre-fill');
    const x = w.file('spouse-additional');
    assert.deepEqual(x.fields.map((f) => [f.section, f.label, f.value]).slice(0, 4), [
      ['Personal Details', 'Family Name (Surname)', 'Rauf'], ['Personal Details', 'Given Name', 'Sabri'],
      ['Marital Status', 'Current Marital Status', 'Married'], ['Marital Status', 'Date of Marriage', '18/02/2018'],
    ]);
    assert.ok(x.fields.some((f) => f.label === 'Course / Program — Row 1' && f.value === 'Bachelor of Science'));
    assert.equal(x.formFile, F1);
    // dry run reports the same without writing
    const w2 = world({ primary: PRIMARY });
    try { const d = await carry.carryEmbeddedAnswers({ clientName: 'Fathima', caseRef: w2.caseRef, itemId: '1', memberKey: 'spouse', memberType: 'Spouse / Common-Law Partner', memberName: 'Mohamed Sabri Rauf', forms: FORMS, dryRun: true }); assert.equal(d.crossForm.copied, x.fields.length); assert.deepEqual(w2.uploads, []); } finally { w2.restore(); }
  } finally { w.restore(); }
  const child = world({ primary: PRIMARY });
  try { const r = await carry.carryEmbeddedAnswers({ clientName: 'Fathima', caseRef: child.caseRef, itemId: '1', memberKey: 'child-1', memberType: 'Dependent Child', memberName: 'Ayaan', forms: FORMS }); assert.equal(r.crossForm, null); assert.deepEqual(child.uploads, []); } finally { child.restore(); }
  const f1only = world({ primary: PRIMARY });
  try { const r = await carry.carryEmbeddedAnswers({ clientName: 'Fathima', caseRef: f1only.caseRef, itemId: '1', memberKey: 'spouse', memberType: 'Spouse / Common-Law Partner', memberName: 'Mohamed Sabri Rauf', forms: { primary: F6, additional: null } }); assert.equal(r.written, true); assert.ok(r.crossForm && r.crossForm.skipped === 'not-this-form-pair'); assert.equal(f1only.uploads.length, 1); } finally { f1only.restore(); }
});

test('the pre-fill lands in the spouse\'s boxes through the engine\'s own restore matcher (section + label exact; table cells by their own key)', () => {
  const vm = require('vm');
  const engine = vm.runInNewContext(svc.RESTORE_MATCH_JS + '\n;({ planRestoreValues })');
  const fold = (s) => (s || '').replace(/[‘’ʼ]/g, "'").trim().toLowerCase();
  const p = cross.planCrossFormPrefill({ memberFields: SPOUSE_F6, principalFields: PRINCIPAL_F6, memberKey: 'spouse' });
  const f1 = fs.readFileSync(path.join(FORMS_DIR, F1), 'utf8');
  const sp = questions(f1, 'id="spouse-section"', 'id="children-section"');
  const dom = [];
  for (const q of sp) {
    if (q.label) dom.push({ section: q.section, label: q.label, key: `clone-${q.section}-${q.label}` });
    else for (const row of [1, 2]) dom.push({ section: q.section, label: `${q.header} — Row ${row}`, key: carry.memberTableKey(q.section.replace(/ › Table$/, ''), `spouse-${q.table}`, row, q.header) });
  }
  const values = Array.from(engine.planRestoreValues(dom, p.fields, fold));
  const placed = dom.map((d, i) => [d.label, values[i]]).filter((x) => x[1] != null);
  assert.equal(placed.length, p.copied, 'every pre-filled answer found exactly one box');
  assert.ok(placed.some(([l, v]) => l === 'Course / Program — Row 1' && v === 'Bachelor of Science'));
  assert.ok(placed.some(([l, v]) => l === 'City & Country (Address with Postal Code) — Row 2' && v === 'Toronto, Canada'));
});
