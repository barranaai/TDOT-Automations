'use strict';

// Carry-over of embedded family answers (2026-10-09, case 2026-CEC-EE-075).
//
// The single-member F1 form embeds "Dependent Spouse / Common-Law Partner" and
// "Dependent Children" sections inside the principal applicant's own page; a
// client with no separate family member types the spouse's details there and
// they land in HIS file. Adding a second questionnaire member removes those
// sections from his page and his next save keeps the answers aside — hidden.
// Before a Spouse / Dependent Child member is added, the carry-over copies
// those answers into the member's own file, with the section path the member
// section stores (the top-level header stripped), labels/keys unchanged.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const carry    = require('../src/services/questionnaireCarryOverService');
const svc      = require('../src/services/htmlQuestionnaireService');
const oneDrive = require('../src/services/oneDriveService');

const SP  = 'Dependent Spouse / Common-Law Partner';
const CH  = 'Dependent Children';
const MA  = 'Main Applicant';
const AUG = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const F = (section, label, key, value, extra = {}) => ({ section, label, key, value, ...extra });

/* ───────────────────────── the pure planner ───────────────────────── */

test('spouse: every embedded field (empties included) is copied with the top-level header stripped; label, key and value unchanged; the principal\'s own and prefill fields are left out', () => {
  const src = [
    F(`${MA} › Section 1 — Profile Details`, 'Family Name (Surname)', 'main-applicant-section-1-profile-details-family-name-surname', 'Mohammed'),
    F(`${SP} › Personal Details`, 'Family Name (Surname)', 'dependent-spouse-common-law-partner-personal-details-family-name-surname', 'Khan'),
    F(`${SP} › Personal Details`, 'Given Name', 'dependent-spouse-common-law-partner-personal-details-given-name', ''),
    F(`${SP} › Section 3 — Address Details (Past 10 Years) › Table`, 'From — Row 2', 'dependent-spouse-common-law-partner-section-3-address-details-past--tbl-sp-address-r2-from', '01/2020'),
    F(`${SP} › Section 5 — Statutory Questions`, '4a. Have you ever been refused a visa?', 'dependent-spouse-common-law-partner-section-5-statutory-questions-sq-4a', 'No'),
    F('Pre-filled from intake', 'Spouse given name', 'prefill__spouse-given-name', 'Priya', { source: 'prefill' }),
    F(`${CH} › Personal Details`, 'Family Name', 'dependent-children-personal-details-family-name', 'Khan'),
  ];
  const p = carry.planCarryOver({ sourceFields: src, memberType: 'Spouse / Common-Law Partner' });
  assert.deepEqual(p.fields, [
    F('Personal Details', 'Family Name (Surname)', 'dependent-spouse-common-law-partner-personal-details-family-name-surname', 'Khan'),
    F('Personal Details', 'Given Name', 'dependent-spouse-common-law-partner-personal-details-given-name', ''),
    F('Section 3 — Address Details (Past 10 Years) › Table', 'From — Row 2', 'dependent-spouse-common-law-partner-section-3-address-details-past--tbl-sp-address-r2-from', '01/2020'),
    F('Section 5 — Statutory Questions', '4a. Have you ever been refused a visa?', 'dependent-spouse-common-law-partner-section-5-statutory-questions-sq-4a', 'No'),
  ]);
  assert.equal(p.copied, 3); assert.equal(p.total, 4); assert.equal(p.pct, 75);
  assert.deepEqual(p.bySection, { 'Personal Details': 1, 'Section 3 — Address Details (Past 10 Years)': 1, 'Section 5 — Statutory Questions': 1 });
  assert.deepEqual(p.unmapped, []);
});

test('nothing embedded → an empty plan; an unknown member type → an empty plan', () => {
  const src = [F(`${MA} › Section 1 — Profile Details`, 'Given Name', 'k', 'Rizwan')];
  assert.equal(carry.planCarryOver({ sourceFields: src, memberType: 'Spouse / Common-Law Partner' }).total, 0);
  assert.equal(carry.planCarryOver({ sourceFields: src, memberType: 'Sponsor' }).total, 0);
  assert.equal(carry.planCarryOver({ memberType: 'Spouse / Common-Law Partner' }).total, 0);
});

test('answers a case already kept aside (it flipped before this feature) are carried too — live fields first, aside entries only when not already there and not empty', () => {
  const src = [F(`${SP} › Personal Details`, 'Given Name', 'k-given', 'Priya')];
  const aside = [
    F(`${SP} › Personal Details`, 'Given Name', 'k-given', 'Old Priya', { setAsideAt: '2026-10-01T00:00:00Z' }),   // same spot: the live one wins
    F(`${SP} › Marital Status`, 'Date of Marriage', 'k-dom', '01/01/2020', { setAsideAt: '2026-10-01T00:00:00Z' }),
    F(`${SP} › Marital Status`, 'Place of Marriage', 'k-pom', '', { setAsideAt: '2026-10-01T00:00:00Z' }),
  ];
  const p = carry.planCarryOver({ sourceFields: src, sourceSetAside: aside, memberType: 'Spouse / Common-Law Partner' });
  assert.deepEqual(p.fields.map((f) => [f.section, f.label, f.value]), [['Personal Details', 'Given Name', 'Priya'], ['Marital Status', 'Date of Marriage', '01/01/2020']]);
});

test('children: block N (the N-th occurrence of each label) goes to child-N; two labels are renamed to the member section\'s wording; DOB / place of birth have no box there and are reported; the shared history table is never copied', () => {
  const src = [
    F(`${CH} › Personal Details`, 'Family Name', 'dependent-children-personal-details-family-name', 'Khan'),
    F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name', 'Aarav'),
    F(`${CH} › Personal Details`, 'Date of Birth', 'dependent-children-personal-details-date-of-birth', '01/01/2020'),
    F(`${CH} › Personal Details`, 'Eye Colour', 'dependent-children-personal-details-eye-colour', 'Brown'),
    F(`${CH} › Personal Details`, 'Family Name', 'dependent-children-personal-details-family-name-2', 'Khan'),
    F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name-2', 'Diya'),
    F(`${CH} › Personal Details`, 'Date of Birth', 'dependent-children-personal-details-date-of-birth-2', ''),
    F(`${CH} › Personal Details`, 'Eye Colour', 'dependent-children-personal-details-eye-colour-2', ''),
    F(`${CH} › Personal History (Employment / Education) › Table`, 'From — Row 1', 'dependent-children-personal-history-employment-educ-tbl-ch-history-r1-from', '2024'),
  ];
  const c1 = carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberIndex: 1 });
  assert.deepEqual(c1.fields.map((f) => [f.section, f.label, f.value]), [
    ['Personal Details', 'Family Name (Surname)', 'Khan'], ['Personal Details', 'Given Name', 'Aarav'], ['Personal Details', 'Date of Birth', '01/01/2020'], ['Personal Details', 'Eye Color', 'Brown'],
  ]);
  assert.deepEqual(c1.unmapped, ['Date of Birth']); assert.equal(c1.skippedSharedTable, 1); assert.equal(c1.copied, 4);
  assert.equal(c1.pct, 0, 'no % for a child: its section has far more boxes than the 9 embedded labels');
  const c2 = carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberIndex: 2 });
  assert.deepEqual(c2.fields.map((f) => [f.label, f.value]), [['Family Name (Surname)', 'Khan'], ['Given Name', 'Diya'], ['Date of Birth', ''], ['Eye Color', '']]);
  assert.deepEqual(c2.unmapped, [], 'an empty DOB is not reported');
  assert.equal(carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberIndex: 3 }).total, 0, 'no third block');
  assert.equal(carry.memberIndexOf('child-2'), 2); assert.equal(carry.memberIndexOf('spouse'), 1); assert.equal(carry.memberIndexOf('child-1'), 1);
});

test('children from a KEPT-ASIDE list (empties not kept): each answer goes to its own child by the key\'s counter, never shifted to another child', () => {
  const aside = [
    F(`${CH} › Personal Details`, 'Family Name', 'dependent-children-personal-details-family-name', 'Khan'),
    F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name', 'Aarav'),
    F(`${CH} › Personal Details`, 'Family Name', 'dependent-children-personal-details-family-name-2', 'Khan'),
    F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name-2', 'Diya'),
    F(`${CH} › Personal Details`, 'Native Language', 'dependent-children-personal-details-native-language-2', 'Hindi'),   // child 2 only
  ];
  const c1 = carry.planCarryOver({ sourceSetAside: aside, memberType: 'Dependent Child', memberIndex: 1 });
  const c2 = carry.planCarryOver({ sourceSetAside: aside, memberType: 'Dependent Child', memberIndex: 2 });
  assert.deepEqual(c1.fields.map((f) => [f.label, f.value]), [['Family Name (Surname)', 'Khan'], ['Given Name', 'Aarav']]);
  assert.deepEqual(c2.fields.map((f) => [f.label, f.value]), [['Family Name (Surname)', 'Khan'], ['Given Name', 'Diya'], ['Native Language', 'Hindi']]);
});

test('a table row the client REMOVED from a table still on his page is not brought back; rows of a section that is no longer on his page (a case that flipped earlier) are', () => {
  const T = `${SP} › Section 3 — Address Details (Past 10 Years) › Table`;
  const live = [F(T, 'From — Row 1', 'dependent-spouse-common-law-partner-section-3-address-details-past--tbl-sp-address-r1-from', '01/2016'), F(T, 'From — Row 2', 'dependent-spouse-common-law-partner-section-3-address-details-past--tbl-sp-address-r2-from', '01/2020')];
  const removed = [F(T, 'From — Row 3', 'dependent-spouse-common-law-partner-section-3-address-details-past--tbl-sp-address-r3-from', '01/2022', { setAsideAt: '2026-10-01T00:00:00Z' })];
  const kept = carry.planCarryOver({ sourceFields: live, sourceSetAside: removed, memberType: 'Spouse / Common-Law Partner' });
  assert.deepEqual(kept.fields.map((f) => f.label), ['From — Row 1', 'From — Row 2'], 'row 3 stays removed');
  assert.equal(kept.live, 2);
  const flipped = carry.planCarryOver({ sourceFields: [], sourceSetAside: [...live, ...removed].map((f) => ({ ...f, setAsideAt: 'x' })), memberType: 'Spouse / Common-Law Partner' });
  assert.deepEqual(flipped.fields.map((f) => f.label), ['From — Row 1', 'From — Row 2', 'From — Row 3']);
  assert.equal(flipped.live, 0, 'nothing live: the page no longer shows these boxes');
});

test('a dual-form main form\'s "Dependent (If Accompany)" block is counted as unattributed and NOT planned for a member when nothing names the spouse (no staff-typed name, no "Spouse’s Given Name" in the principal\'s answers)', () => {
  const f6 = [F('Dependent (If Accompany) › Section 1 — Profile Details', 'Given Name', 'k', 'Priya'), F('Dependent (If Accompany) › Section 1 — Profile Details', 'Height', 'k2', '')];
  assert.equal(carry.countAmbiguousDependent(f6), 1);
  assert.equal(carry.planCarryOver({ sourceFields: f6, memberType: 'Spouse / Common-Law Partner' }).total, 0);
  assert.equal(carry.planCarryOver({ sourceFields: f6, memberType: 'Dependent Child' }).total, 0);
});

test('a pre-fill answer in the target keeps its place when the carried box for the same label is empty; a carried answer wins otherwise', () => {
  const planned = [F('Personal Details', 'Given Name', 'k-given', ''), F('Personal Details', 'Family Name (Surname)', 'k-family', 'Khan')];
  const existing = [
    F('Pre-filled from intake', 'Given Name', 'prefill__given-name', 'Priya', { source: 'prefill' }),
    F('Pre-filled from intake', 'Family Name (Surname)', 'prefill__family-name', 'Old', { source: 'prefill' }),
  ];
  const merged = carry.mergeOverPrefill(planned, existing);
  assert.deepEqual(merged.map((f) => [f.label, f.value]), [['Family Name (Surname)', 'Khan'], ['Given Name', 'Priya']], 'the pre-fill fills the empty box; the carried answer replaces the pre-fill for its label');
  assert.deepEqual(carry.mergeOverPrefill(planned, []), planned);
});

/* ───────────────────────── the sections match the REAL form, through the engine's own restore ───────────────────────── */

const FORMS_DIR = path.join(__dirname, '..', 'Questionnair Documents');
const decode = (s) => s.replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/&#9662;/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** The spouse section of the real F1, as the member section would store it: [{section, label}] for form-group labels and table headers (row 1 and 2). */
function spouseBoxesFromForm(html) {
  const start = html.indexOf('id="spouse-section"'), end = html.indexOf('id="children-section"');
  assert.ok(start > 0 && end > start, 'the spouse section is in the form');
  const part = html.slice(start, end);
  const subs = [...part.matchAll(/<div class="sub-accordion-header"[^>]*onclick="toggleSub\(this\)">([\s\S]*?)<\/div>/g)].map((m) => ({ name: decode(m[1]), at: m.index }));
  const boxes = [];
  for (let i = 0; i < subs.length; i++) {
    const seg = part.slice(subs[i].at, i + 1 < subs.length ? subs[i + 1].at : part.length);
    for (const m of seg.matchAll(/<label>([\s\S]*?)<\/label>/g)) boxes.push({ section: subs[i].name, label: decode(m[1]) });
    for (const t of seg.matchAll(/<table class="dynamic-table" id="([a-z0-9-]+)">([\s\S]*?)<\/table>/g)) {
      const headers = [...t[2].matchAll(/<th>([\s\S]*?)<\/th>/g)].map((h) => decode(h[1])).filter((h) => h && !/^(action|actions)$/i.test(h));
      for (const row of [1, 2]) for (const h of headers) boxes.push({ section: `${subs[i].name} › Table`, label: `${h} — Row ${row}`, table: t[1] });
    }
  }
  return boxes;
}

test('REAL FORM + the restore matcher: carried answers (with keys no box has) are placed by section + label into the spouse section\'s boxes, table rows expand, and the principal\'s same-label box is never filled', () => {
  const html = fs.readFileSync(path.join(FORMS_DIR, AUG), 'utf8');
  const boxes = spouseBoxesFromForm(html);
  assert.ok(boxes.length > 100, `the spouse section has ${boxes.length} boxes`);
  const bySection = {}; for (const b of boxes) bySection[b.section] = (bySection[b.section] || 0) + 1;
  for (const s of ['Personal Details', 'Marital Status', 'Section 2 — Family Information › Table', 'Section 3 — Address Details (Past 10 Years) › Table', 'Section 4 — Education and Employment › Table', 'Section 5 — Statutory Questions']) assert.ok(bySection[s], `section "${s}" found`);

  // the principal's file, as the single-member page saved it: the member section's path with the top-level header in front
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const sample = (section, label) => boxes.find((b) => b.section === section && b.label === label);
  const picked = [
    { ...sample('Personal Details', 'Family Name (Surname)'), value: 'Khan' },
    { ...sample('Personal Details', 'Given Name'), value: 'Priya' },
    { ...sample('Marital Status', 'Date of Marriage'), value: '02/02/2018' },
    { ...sample('Section 3 — Address Details (Past 10 Years) › Table', 'From — Row 1'), value: '01/2016' },
    { ...sample('Section 3 — Address Details (Past 10 Years) › Table', 'From — Row 2'), value: '01/2020' },
    { ...sample('Section 3 — Address Details (Past 10 Years) › Table', 'To — Row 2'), value: 'Present' },
    { ...sample('Section 2 — Family Information › Table', 'Given Name — Row 1'), value: 'Father' },
  ];
  for (const p of picked) assert.ok(p.section && p.label, 'every sample box exists on the form');
  const primaryFile = picked.map((b) => ({
    section: `${SP} › ${b.section}`, label: b.label, value: b.value,
    key: b.table ? `${slug(SP).slice(0, 12)}-tbl-${b.table}-r${/Row (\d+)$/.exec(b.label)[1]}-${slug(b.label.replace(/ — Row \d+$/, ''))}` : slug(`${SP} › ${b.section}__${b.label}`).slice(0, 90),
  }));
  const plan = carry.planCarryOver({ sourceFields: primaryFile, memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse' });
  assert.equal(plan.copied, picked.length);
  // every carried TABLE cell now carries the member section's own key for that box
  for (const f of plan.fields.filter((x) => / — Row \d+$/.test(x.label))) {
    const b = boxes.find((x) => x.section === f.section && x.label === f.label);
    const row = Number(/Row (\d+)$/.exec(f.label)[1]);
    assert.equal(f.key, carry.memberTableKey(f.section.replace(/ › Table$/, ''), `spouse-${b.table}`, row, f.label.replace(/ — Row \d+$/, '')));
  }

  // the ENGINE's own restore planner, over the member section's boxes (keys as the clone would make them: unknown to the carried file) plus the principal's own boxes
  const engine = vm.runInNewContext(svc.RESTORE_MATCH_JS + '\n;({ planRestoreValues, rowsFromLabels })');
  const fold = (s) => (s || '').replace(/[‘’ʼ]/g, "'").trim().toLowerCase();
  const dom = [
    { section: 'Section 1 — Profile Details', label: 'Family Name (Surname)', key: 'section-1-profile-details-family-name-surname' },   // the principal's own box, same label
    { section: 'Section 1 — Profile Details', label: 'Given Name', key: 'section-1-profile-details-given-name' },
    // the clone's boxes, keyed as the engine keys them (table cells: the member-prefixed table key; others: a key the carried file does not share)
    ...boxes.map((b) => ({ section: b.section, label: b.label, key: b.table ? carry.memberTableKey(b.section.replace(/ › Table$/, ''), `spouse-${b.table}`, Number(/Row (\d+)$/.exec(b.label)[1]), b.label.replace(/ — Row \d+$/, '')) : `clone-${slug(b.section)}-${slug(b.label)}` })),
  ];
  const values = Array.from(engine.planRestoreValues(dom, plan.fields, fold));
  const placed = dom.map((d, i) => [d.section, d.label, values[i]]).filter((x) => x[2] != null);
  assert.deepEqual(placed, [
    ['Personal Details', 'Family Name (Surname)', 'Khan'],
    ['Personal Details', 'Given Name', 'Priya'],
    ['Marital Status', 'Date of Marriage', '02/02/2018'],
    ['Section 2 — Family Information › Table', 'Given Name — Row 1', 'Father'],
    ['Section 3 — Address Details (Past 10 Years) › Table', 'From — Row 1', '01/2016'],
    ['Section 3 — Address Details (Past 10 Years) › Table', 'From — Row 2', '01/2020'],
    ['Section 3 — Address Details (Past 10 Years) › Table', 'To — Row 2', 'Present'],
  ]);
  assert.equal(values[0], null, 'the principal\'s "Family Name (Surname)" box is never filled with the spouse\'s');
  // the table-row expansion the client engine uses for rows the clone does not have yet: exact section + the named table in the key
  // (the engine passes the clone's table slug and the bare one; a carried key carries "-tbl-sp-address", so the row counts whatever columns it covers)
  const loose = plan.fields.filter((f) => / — Row \d+$/.test(f.label));
  const addressHeaders = [...new Set(boxes.filter((b) => b.table === 'sp-address').map((b) => b.label.replace(/ — Row \d+$/, '')))];
  assert.ok(addressHeaders.length >= 5, 'the address table has its columns');
  const rows = engine.rowsFromLabels(loose, 'Section 3 — Address Details (Past 10 Years) › Table', addressHeaders, fold, ['spouse-sp-address', 'sp-address']);
  assert.equal(rows, 2, 'the address table expands to the carried rows');
  assert.equal(engine.rowsFromLabels(loose, 'Section 2 — Family Information › Table', [...new Set(boxes.filter((b) => b.table === 'sp-family-living').map((b) => b.label.replace(/ — Row \d+$/, '')))], fold, ['spouse-sp-family-living', 'sp-family-living']), 1);
});

/* The premise, proven on the page's OWN code: the section name a box gets in
   the single-member page is "<top header> › <sub-section>", and in the
   multi-member page (the member's own section is the cloned top-accordion,
   carrying data-member-key) it is "<sub-section>" — exactly what the
   carry-over writes. getSectionContext / getHeadingText are sliced out of the
   client engine and run over a DOM built like the real F1 spouse section. */
const ENGINE_SRC = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
function sectionEngine(isMulti, body) {
  const start = ENGINE_SRC.indexOf('  function getHeadingText(el) {');
  const endMarker = "    return parts.join(' › ');\n  }";
  const end = ENGINE_SRC.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start > 0 && end > start, 'the engine helpers are located');
  const raw = ENGINE_SRC.slice(start, end);
  assert.ok(!raw.includes('`') && !raw.includes('${'), 'the slice is plain template text');
  const js = new Function('return `' + raw + '`')();
  return vm.runInNewContext(js + '\n;({ getHeadingText, getSectionContext })', { IS_MULTI: isMulti, document: { body } });
}
class Node {
  constructor(tag, { text = '', attrs = {}, cls = [] } = {}) { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.attrs = { ...attrs }; this.cls = new Set(cls); this.kids = []; this.parentElement = null; if (text) this.kids.push({ nodeType: 3, textContent: text }); }
  add(child) { child.parentElement = this; this.kids.push(child); return child; }
  get childNodes() { return this.kids; }
  get children() { return this.kids.filter((k) => k.nodeType === 1); }
  get previousElementSibling() { const p = this.parentElement; if (!p) return null; const c = p.children; const i = c.indexOf(this); return i > 0 ? c[i - 1] : null; }
  get textContent() { return this.kids.map((k) => k.textContent).join(''); }
  get classList() { return { contains: (c) => this.cls.has(c) }; }
  getAttribute(n) { return this.attrs[n] == null ? null : this.attrs[n]; }
  hasAttribute(n) { return this.attrs[n] != null; }
}
/** body > [div.top-accordion(#spouse-section | data-member-key)] > header + body > sub-accordion > header + body > form-group > label + input */
function spouseDom({ memberKey, headerText }) {
  const body = new Node('body');
  const top = body.add(new Node('div', { cls: ['top-accordion'], attrs: memberKey ? { 'data-member-key': memberKey } : { id: 'spouse-section' } }));
  const th = top.add(new Node('div', { cls: ['top-accordion-header'], attrs: { onclick: 'toggleTop(this)' }, text: `\n    ${headerText}\n    ` }));
  th.add(new Node('span', { cls: ['chevron'], text: '▾' }));
  const tb = top.add(new Node('div', { cls: ['top-accordion-body'] }));
  const inputs = {};
  for (const sub of ['Personal Details', 'Section 3 — Address Details (Past 10 Years)', 'Section 5 — Statutory Questions']) {
    const sa = tb.add(new Node('div', { cls: ['sub-accordion'] }));
    const sh = sa.add(new Node('div', { cls: ['sub-accordion-header'], attrs: { onclick: 'toggleSub(this)' }, text: `\n        ${sub}\n        ` }));
    sh.add(new Node('span', { cls: ['chevron'], text: '▾' }));
    const sb = sa.add(new Node('div', { cls: ['sub-accordion-body'] }));
    const fg = sb.add(new Node('div', { cls: ['form-group'] }));
    fg.add(new Node('label', { text: 'Given Name' }));
    inputs[sub] = fg.add(new Node('input'));
  }
  return { body, inputs };
}

test("THE PAGE'S OWN CODE: single-member boxes read '<top header> › <sub-section>'; the member section's boxes read '<sub-section>' — the carry-over's rewrite turns one into the other exactly", () => {
  const single = spouseDom({ headerText: SP });
  const e1 = sectionEngine(false, single.body);
  const multi = spouseDom({ memberKey: 'spouse', headerText: '💍  Priya Khan' });   // the clone: header text replaced by the member's label
  const e2 = sectionEngine(true, multi.body);
  for (const sub of Object.keys(single.inputs)) {
    const embedded = e1.getSectionContext(single.inputs[sub]);
    const member = e2.getSectionContext(multi.inputs[sub]);
    assert.equal(embedded, `${SP} › ${sub}`);
    assert.equal(member, sub);
    const planned = carry.planCarryOver({ sourceFields: [F(embedded, 'Given Name', 'k', 'Priya')], memberType: 'Spouse / Common-Law Partner' }).fields[0];
    assert.equal(planned.section, member, `the carried section for "${sub}" is the member section's own, byte for byte`);
  }
  // the source pin the premise rests on: in multi mode the walk stops at the member wrapper
  assert.match(ENGINE_SRC, /if \(IS_MULTI && current\.parentElement &&\s*current\.parentElement\.hasAttribute\('data-member-key'\)\) break;/);
  assert.match(ENGINE_SRC, /section\.setAttribute\('data-member-key', member\.key\);/, 'the member section IS the cloned top-accordion, carrying the key');
});

/* ───────────────────────── the I/O: read the principal, write the member, never the other way ───────────────────────── */

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
let N = 0;
function world(files, { now = Date.parse('2026-10-09T12:00:00Z') } = {}) {
  const caseRef = `2026-CO-${String(++N).padStart(3, '0')}`;
  const store = {};
  for (const [k, v] of Object.entries(files)) store[`questionnaire-${caseRef}-${k}.json`] = JSON.stringify(v);
  const uploads = [];
  const restores = [
    stub(oneDrive, 'readFile', async (a) => (store[a.filename] != null ? Buffer.from(store[a.filename]) : null)),
    stub(oneDrive, 'uploadFile', async (a) => { uploads.push(a.filename); store[a.filename] = a.buffer.toString('utf8'); }),
    stub(oneDrive, 'ensureClientFolder', async () => {}),
    stub(carry.io, 'now', () => now),
  ];
  return { caseRef, store, uploads, file: (k) => JSON.parse(store[`questionnaire-${caseRef}-${k}.json`]), restore: () => restores.forEach((r) => r()) };
}
const PRIMARY = {
  fields: [
    F(`${MA} › Section 1 — Profile Details`, 'Given Name', 'main-applicant-section-1-profile-details-given-name', 'Rizwan'),
    F(`${SP} › Personal Details`, 'Given Name', 'dependent-spouse-common-law-partner-personal-details-given-name', 'Priya'),
    F(`${SP} › Personal Details`, 'Height', 'dependent-spouse-common-law-partner-personal-details-height', ''),
  ],
  completionPct: 66, savedAt: '2026-10-08T16:29:11Z', formFile: AUG,
};
const base = (w) => ({ clientName: 'Rizwan', caseRef: w.caseRef, itemId: '1', memberKey: 'spouse', memberType: 'Spouse / Common-Law Partner' });

test('a real run writes ONLY the member file: the carried fields tagged "carry-over", a proxy %, and the SAME edition as the source; the principal\'s file is untouched', async () => {
  const w = world({ primary: PRIMARY });
  try {
    const r = await carry.carryEmbeddedAnswers(base(w));
    assert.equal(r.written, true); assert.equal(r.copied, 1); assert.equal(r.total, 2); assert.equal(r.recopied, false);
    assert.deepEqual(r.slots, [{ source: 'primary', target: 'spouse', copied: 1, total: 2, pct: 50, formFile: AUG, written: true, recopied: false }]);
    assert.deepEqual(w.uploads, [`questionnaire-${w.caseRef}-spouse.json`]);
    const sp = w.file('spouse');
    assert.deepEqual(sp.fields, [
      F('Personal Details', 'Given Name', 'dependent-spouse-common-law-partner-personal-details-given-name', 'Priya', { source: 'carry-over' }),
      F('Personal Details', 'Height', 'dependent-spouse-common-law-partner-personal-details-height', '', { source: 'carry-over' }),
    ]);
    assert.equal(sp.completionPct, 50); assert.equal(sp.formFile, AUG);
    assert.deepEqual(w.file('primary'), PRIMARY, 'the principal\'s file is byte-for-byte what it was');
  } finally { w.restore(); }
});

test('the copy records the source\'s edition and NEVER a guessed one: an unrecorded source gives an unrecorded copy (the era resolver judges both by the same labels)', async () => {
  const w = world({ primary: { ...PRIMARY, formFile: '' } });
  try {
    const r = await carry.carryEmbeddedAnswers(base(w));
    assert.equal(r.slots[0].formFile, '');
    assert.notEqual(w.file('spouse').formFile, AUG, 'no edition invented for the copy');
  } finally { w.restore(); }
});

test('dry run: the same plan, nothing written', async () => {
  const w = world({ primary: PRIMARY });
  try {
    const r = await carry.carryEmbeddedAnswers({ ...base(w), dryRun: true });
    assert.equal(r.dryRun, true); assert.equal(r.written, false); assert.equal(r.copied, 1); assert.equal(r.slots[0].written, false); assert.deepEqual(w.uploads, []);
  } finally { w.restore(); }
});

test('never over a client answer: a member file that already holds one is left alone; a pre-fill-only member file is replaced (pre-fill kept where the carried box is empty)', async () => {
  const typed = world({ primary: PRIMARY, spouse: { fields: [F('Personal Details', 'Given Name', 'personal-details-given-name', 'Typed by her')], completionPct: 5 } });
  try {
    const r = await carry.carryEmbeddedAnswers(base(typed));
    assert.equal(r.skipped, 'has-answers'); assert.equal(r.existing, 1); assert.equal(r.written, false); assert.equal(r.copied, 0, 'nothing reported as copied'); assert.deepEqual(typed.uploads, []);
  } finally { typed.restore(); }
  const seeded = world({ primary: PRIMARY, spouse: { fields: [F('Pre-filled from intake', 'Height', 'prefill__height', '170 cm', { source: 'prefill' }), F('Pre-filled from intake', 'Given Name', 'prefill__given-name', 'P.', { source: 'prefill' })], completionPct: 0 } });
  try {
    const r = await carry.carryEmbeddedAnswers(base(seeded));
    assert.equal(r.written, true);
    assert.deepEqual(seeded.file('spouse').fields.map((f) => [f.label, f.value, f.source || '']), [['Given Name', 'Priya', 'carry-over'], ['Height', '170 cm', 'prefill']]);
  } finally { seeded.restore(); }
});

test('a RE-RUN (or a retry after a failed add) replaces the service\'s OWN earlier copy and picks up answers typed since; once the client saved the member section himself, it writes nothing', async () => {
  const w = world({ primary: PRIMARY });
  try {
    await carry.carryEmbeddedAnswers(base(w));
    // the client kept typing in his old single-member tab
    const later = JSON.parse(w.store[`questionnaire-${w.caseRef}-primary.json`]);
    later.fields[2] = F(`${SP} › Personal Details`, 'Height', 'dependent-spouse-common-law-partner-personal-details-height', '165 cm');
    later.savedAt = '2026-10-09T11:30:00Z';
    w.store[`questionnaire-${w.caseRef}-primary.json`] = JSON.stringify(later);
    const r = await carry.carryEmbeddedAnswers(base(w));
    assert.equal(r.written, true); assert.equal(r.recopied, true); assert.equal(r.copied, 2);
    assert.deepEqual(w.file('spouse').fields.map((f) => [f.label, f.value]), [['Given Name', 'Priya'], ['Height', '165 cm']]);
    // the client saves the spouse section (his page rebuilds fields WITHOUT the tag)
    await svc.saveFormData({ clientName: 'Rizwan', caseRef: w.caseRef, itemId: '1', formKey: 'spouse', fields: [F('Personal Details', 'Given Name', 'personal-details-given-name', 'Priya'), F('Personal Details', 'Height', 'personal-details-height', '165 cm')], completionPct: 10, formFile: AUG });
    const again = await carry.carryEmbeddedAnswers(base(w));
    assert.equal(again.skipped, 'has-answers'); assert.equal(again.written, false);
  } finally { w.restore(); }
});

test('nothing to carry (no embedded answers, or none for this member type) → skipped, nothing written; a Sponsor is never carried', async () => {
  const w = world({ primary: { fields: [F(`${MA} › Section 1 — Profile Details`, 'Given Name', 'k', 'Rizwan')], completionPct: 10, savedAt: '2026-10-01T00:00:00Z' } });
  try {
    assert.equal((await carry.carryEmbeddedAnswers(base(w))).skipped, 'nothing');
    assert.equal((await carry.carryEmbeddedAnswers({ ...base(w), memberKey: 'child-1', memberType: 'Dependent Child' })).skipped, 'nothing');
    assert.equal((await carry.carryEmbeddedAnswers({ ...base(w), memberKey: 'sponsor', memberType: 'Sponsor' })).skipped, 'type');
    assert.deepEqual(w.uploads, []);
  } finally { w.restore(); }
  const empties = world({ primary: { fields: [F(`${SP} › Personal Details`, 'Given Name', 'k', '')], completionPct: 0, savedAt: '2026-10-01T00:00:00Z' } });
  try { assert.equal((await carry.carryEmbeddedAnswers(base(empties))).skipped, 'nothing', 'boxes but no answers'); assert.deepEqual(empties.uploads, []); } finally { empties.restore(); }
});

test('the "may still be typing" refusal: only when something would be copied FROM a page that still shows the embedded boxes, saved < 10 minutes ago — nothing written', async () => {
  const w = world({ primary: { ...PRIMARY, savedAt: '2026-10-09T11:55:00Z' } });
  try {
    await assert.rejects(carry.carryEmbeddedAnswers(base(w)), (e) => e.badRequest === true && e.code === 'RECENT_SAVE' && /5 minutes ago/.test(e.message));
    assert.deepEqual(w.uploads, []);
  } finally { w.restore(); }
  // nothing to copy (the child block is all empty boxes) → no refusal at all
  const kids = world({ primary: { fields: [...PRIMARY.fields, F(`${CH} › Personal Details`, 'Family Name', 'dependent-children-personal-details-family-name', '')], completionPct: 66, savedAt: '2026-10-09T11:56:00Z', formFile: AUG } });
  try { const r = await carry.carryEmbeddedAnswers({ ...base(kids), memberKey: 'child-1', memberType: 'Dependent Child' }); assert.equal(r.skipped, 'nothing'); assert.deepEqual(kids.uploads, []); } finally { kids.restore(); }
  // a multi-member page (its saves hold no embedded box): answers only in the kept-aside list are copied without refusal
  const flipped = world({ primary: { fields: [F('Section 1 — Profile Details', 'Given Name', 'section-1-profile-details-given-name', 'Rizwan')], setAside: [F(`${SP} › Personal Details`, 'Given Name', 'dependent-spouse-common-law-partner-personal-details-given-name', 'Priya', { setAsideAt: '2026-10-09T11:00:00Z' })], completionPct: 66, savedAt: '2026-10-09T11:59:00Z', formFile: AUG } });
  try { const r = await carry.carryEmbeddedAnswers(base(flipped)); assert.equal(r.written, true); assert.equal(r.copied, 1); } finally { flipped.restore(); }
});

test('a storage failure throws (err.transient) — an outage never reads as "nothing to carry"', async () => {
  const w = world({ primary: PRIMARY });
  const restore = stub(oneDrive, 'readFile', async () => { throw new Error('Graph 503'); });
  try { await assert.rejects(carry.carryEmbeddedAnswers(base(w)), (e) => e.transient === true); assert.deepEqual(w.uploads, []); }
  finally { restore(); w.restore(); }
});

test('dual-form case: F1 in primary-additional goes to <member>-additional; the main form\'s "Dependent (If Accompany)" block is counted, not copied when nothing names the spouse', async () => {
  const F6 = { fields: [F('Main Applicant › Section 1 — Profile Details', 'Given Name', 'k1', 'Rizwan'), F('Dependent (If Accompany) › Section 1 — Profile Details', 'Given Name', 'k2', 'Priya'), F('Dependent (If Accompany) › Section 1 — Profile Details', 'Height', 'k3', '')], completionPct: 1, savedAt: '2026-10-01T00:00:00Z' };
  const w = world({ primary: F6, 'primary-additional': { ...PRIMARY, savedAt: '2026-10-01T00:00:00Z' } });
  try {
    const r = await carry.carryEmbeddedAnswers(base(w));
    assert.equal(r.ambiguousDependent, 1);
    assert.deepEqual(r.slots.map((s) => [s.source, s.target, s.skipped || 'written']), [['primary', 'spouse', 'nothing'], ['primary-additional', 'spouse-additional', 'written']]);
    assert.deepEqual(w.uploads, [`questionnaire-${w.caseRef}-spouse-additional.json`]);
  } finally { w.restore(); }
});

test('a refusal on ANY slot writes nothing on any slot (all slots are checked before the first write)', async () => {
  const w = world({ primary: { ...PRIMARY, savedAt: '2026-10-01T00:00:00Z' }, 'primary-additional': { ...PRIMARY, savedAt: '2026-10-09T11:58:00Z' } });
  try { await assert.rejects(carry.carryEmbeddedAnswers(base(w)), (e) => e.code === 'RECENT_SAVE'); assert.deepEqual(w.uploads, []); } finally { w.restore(); }
});

test('table keys: the carry-over writes exactly the key the member section\'s box has (engine formula, member-prefixed table id) — the round-1 design study\'s worked examples', () => {
  assert.equal(carry.memberTableKey('Section 3 — Address Details (Past 10 Years)', 'spouse-sp-address', 1, 'From'), 'section-3-address-details-past-10-years-tbl-spouse-sp-address-r1-from');
  assert.equal(carry.memberTableKey('Section 3 — Address Details (Past 10 Years)', 'spouse-sp-address', 9, 'Postal Code'), 'section-3-address-details-past-10-years-tbl-spouse-sp-address-r9-postal-code');
  assert.equal(carry.memberTableKey('Section 2 — Family Information', 'spouse-sp-family-deceased', 1, 'Given Name'), 'section-2-family-information-tbl-spouse-sp-family-deceased-r1-given-name');
  assert.equal(carry.memberTableKey('Section 4 — Education and Employment', 'spouse-sp-education', 3, 'Course / Program'), 'section-4-education-and-employment-tbl-spouse-sp-education-r3-course-program');
  const long = carry.memberTableKey('Section 2 — Family Information', 'spouse-sp-family-living', 1, 'Current City & Country of Residence (Address with Postal Code)');
  assert.equal(long, '-tbl-spouse-sp-family-living-r1-current-city-country-of-residence-address-with-postal-code'); assert.equal(long.length, 90);
  // rekeying a carried cell: section + header + row from the cell, table id from the old key
  const cell = F('Section 2 — Family Information › Table', 'Given Name — Row 1', 'dependent-spouse-common-law-partner-section-2-family--tbl-sp-family-deceased-r1-given-name', 'Grandpa');
  assert.equal(carry.rekeyTableCell(cell, 'spouse'), 'section-2-family-information-tbl-spouse-sp-family-deceased-r1-given-name');
  assert.equal(carry.rekeyTableCell({ ...cell, key: 'old-truncated-key' }, 'spouse'), 'old-truncated-key', 'an unparseable key is kept (placement falls back to section + label)');
  // the engine source these mirror is unchanged
  assert.match(ENGINE_SRC, /var full2      = slugifyFull\(section2 \+ '--tbl-' \+ slugify\(tableId\) \+ '--r' \+ \(ri \+ 1\) \+ '--' \+ headers\[ci\]\);/);
  assert.match(ENGINE_SRC, /var tail2 = '-tbl-' \+ slugifyFull\(tableId\) \+ '-r' \+ \(ri \+ 1\) \+ '-' \+ slugifyFull\(headers\[ci\]\);/);
  assert.match(ENGINE_SRC, /key2 = slugifyFull\(section2\)\.slice\(0, Math\.max\(0, 90 - tail2\.length\)\) \+ tail2;/);
  assert.match(ENGINE_SRC, /function slugifyFull\(s\) \{\s*return String\(s \|\| ''\)\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g, '-'\)\.replace\(\/\^-\+\|-\+\$\/, ''\);/);
  assert.match(ENGINE_SRC, /els\[i\]\.id = memberKey \+ '-' \+ els\[i\]\.id;/, 'the clone prefixes every id inside it (its tables included) with the member key');
});

test('EVERY table cell of the real F1 spouse section (rows 1-3): the key the single-member page saved is re-keyed to exactly the key the member section\'s box has', () => {
  const html = fs.readFileSync(path.join(FORMS_DIR, AUG), 'utf8');
  const cells = spouseBoxesFromForm(html).filter((b) => b.table);
  const tables = new Set(cells.map((c) => c.table));
  assert.ok(tables.size >= 6, `spouse tables found: ${[...tables].join(', ')}`);
  let n = 0;
  for (const c of cells) {
    for (const row of [1, 2, 3]) {
      const header = c.label.replace(/ — Row \d+$/, '');
      const sub = c.section.replace(/ › Table$/, '');
      // what the SINGLE-member page saved: full path with the top header, the table's own id
      const singleKey = carry.memberTableKey(`${SP} › ${sub}`, c.table, row, header);
      const carried = carry.planCarryOver({ sourceFields: [F(`${SP} › ${c.section}`, `${header} — Row ${row}`, singleKey, 'x')], memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse' }).fields[0];
      assert.equal(carried.key, carry.memberTableKey(sub, `spouse-${c.table}`, row, header), `${c.table} / ${header} / row ${row}`);
      n++;
    }
  }
  assert.ok(n > 100, `${n} cells checked`);
});

test('kept-aside only (empties never kept aside): the living and deceased family tables share column names, yet each carried cell is claimed by ITS box — never shifted into the other table', () => {
  const engine = vm.runInNewContext(svc.RESTORE_MATCH_JS + '\n;({ planRestoreValues })');
  const fold = (s) => (s || '').replace(/[‘’ʼ]/g, "'").trim().toLowerCase();
  const S = `${SP} › Section 2 — Family Information › Table`;
  const aside = [
    F(S, 'Given Name — Row 1', 'dependent-spouse-common-law-partner-section-2-family--tbl-sp-family-living-r1-given-name', 'Father', { setAsideAt: 'x' }),
    F(S, 'Given Name — Row 1', 'dependent-spouse-common-law-partner-section-2-family--tbl-sp-family-deceased-r1-given-name', 'Grandpa', { setAsideAt: 'x' }),
    F(S, 'Relationship — Row 1', 'dependent-spouse-common-law-partner-section-2-family--tbl-sp-family-deceased-r1-relationship', 'Grandfather', { setAsideAt: 'x' }),
  ];
  const plan = carry.planCarryOver({ sourceSetAside: aside, memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse' });
  const sec = 'Section 2 — Family Information';
  const box = (tbl, header) => ({ section: `${sec} › Table`, label: `${header} — Row 1`, key: carry.memberTableKey(sec, `spouse-${tbl}`, 1, header) });
  const dom = [box('sp-family-living', 'Given Name'), box('sp-family-living', 'Relationship'), box('sp-family-deceased', 'Given Name'), box('sp-family-deceased', 'Relationship')];
  assert.deepEqual(Array.from(engine.planRestoreValues(dom, plan.fields, fold)), ['Father', null, 'Grandpa', 'Grandfather'], 'the deceased relationship stays in the deceased row');
});

test('a child is chosen by the NAME staff typed (first names compared); no unique match → nothing copied, the names listed; no name → by number', () => {
  const src = [
    F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name', 'Aarav'),
    F(`${CH} › Personal Details`, 'Height', 'dependent-children-personal-details-height', '120 cm'),
    F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name-2', 'Diya Rani'),
    F(`${CH} › Personal Details`, 'Height', 'dependent-children-personal-details-height-2', '100 cm'),
  ];
  const diya = carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberIndex: 1, memberName: 'Diya Khan' });
  assert.equal(diya.givenName, 'Diya Rani'); assert.deepEqual(diya.fields.map((f) => f.value), ['Diya Rani', '100 cm'], 'child-1 named Diya gets block 2');
  const nobody = carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberIndex: 1, memberName: 'Kabir' });
  assert.equal(nobody.unmatched, true); assert.equal(nobody.total, 0); assert.deepEqual(nobody.childNames, ['Aarav', 'Diya Rani']);
  const twins = carry.planCarryOver({ sourceFields: [...src, F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name-3', 'Aarav')], memberType: 'Dependent Child', memberName: 'Aarav' });
  assert.equal(twins.unmatched, true, 'two children called Aarav: no guess');
  const byNumber = carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberIndex: 2 });
  assert.equal(byNumber.givenName, 'Diya Rani');
});

test('the children\'s shared history table and any unattributed "Dependent" block (F6/F19 "Dependent (If Accompany…)", F3/F8 "Dependent Applicant") are reported even when nothing is copied', async () => {
  assert.equal(carry.countAmbiguousDependent([F('Dependent Applicant › Personal Details', 'Given Name', 'k', 'Priya')]), 1);
  assert.equal(carry.countAmbiguousDependent([F(`${SP} › Personal Details`, 'Given Name', 'k', 'Priya')]), 0, 'F1\'s spouse section is attributed, never "ambiguous"');
  const w = world({ primary: { fields: [F(`${CH} › Personal Details`, 'Given Name', 'dependent-children-personal-details-given-name', ''), F(`${CH} › Personal History (Employment / Education) › Table`, 'From — Row 1', 'dependent-children-personal-history-employment-educ-tbl-ch-history-r1-from', '2020')], completionPct: 5, savedAt: '2026-10-01T00:00:00Z' } });
  try {
    const r = await carry.carryEmbeddedAnswers({ ...base(w), memberKey: 'child-1', memberType: 'Dependent Child' });
    assert.equal(r.skipped, 'nothing'); assert.equal(r.skippedSharedTable, 1); assert.deepEqual(w.uploads, []);
  } finally { w.restore(); }
});

test('the shared save path carries NO carry-over special case (every page that shows a member section was loaded after the copy)', () => {
  assert.doesNotMatch(ENGINE_SRC, /carriedHeld|carry-over'.*kept: true/);
});

/* ───────────────────────── the Express Entry profile forms (F6 / F19): one "Dependent (If Accompany)" block ───────────────────────── */

const F6 = '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.html';
const DEP = 'Dependent (If Accompany)';
const f6Primary = ({ spouseGiven = 'Mohamed Sabri', spouseFamily = 'Rauf', blockGiven = 'Sabri', accompany = 'Yes' } = {}) => ({
  fields: [
    F(`${MA} › Section 1 — Profile Details`, 'Given Name', 'main-applicant-section-1-profile-details-given-name', 'Fathima Bushra'),
    F(`${MA} › Section 1 — Profile Details`, 'Current Marital Status', 'main-applicant-section-1-profile-details-current-marital-status', 'Married'),
    F(`${MA} › Section 1 — Profile Details`, 'Accompany to the Application? (If yes, please provide details in dependent section)', 'main-applicant-section-1-profile-details-accompany-to-the-application-if-yes-please-provide', accompany),
    F(`${MA} › Section 1 — Profile Details`, 'Spouse’s Given Name', 'main-applicant-section-1-profile-details-spouse-s-given-name', spouseGiven),
    F(`${MA} › Section 1 — Profile Details`, 'Spouse’s Family Name', 'main-applicant-section-1-profile-details-spouse-s-family-name', spouseFamily),
    F(`${DEP} › Section 1 — Profile Details`, 'Family Name (Surname)', 'dependent-if-accompany-section-1-profile-details-family-name-surname', 'Rauf'),
    F(`${DEP} › Section 1 — Profile Details`, 'Given Name', 'dependent-if-accompany-section-1-profile-details-given-name', blockGiven),
    F(`${DEP} › Section 1 — Profile Details`, 'Height', 'dependent-if-accompany-section-1-profile-details-height', ''),
    F(`${DEP} › Section 2 — Education › Table`, 'Course / Program Name — Row 1', 'dependent-if-accompany-section-2-education-tbl-dep-education-r1-course-program-name', 'Bachelor of Science'),
    F(`${DEP} › Section 2 — Employment History › Table`, 'Company Name — Row 2', 'dependent-if-accompany-section-2-employment-history-tbl-dep-employment-r2-company-name', 'Bhasha Lanka'),
  ],
  completionPct: 98, savedAt: '2026-09-30T11:33:22Z', formFile: F6,
});

test('F6: the one "Dependent (If Accompany)" block is copied to the SPOUSE only when EVERY word of its Given Name is a word of the spouse\'s name (staff-typed or the principal\'s own answer) and the spouse accompanies; tables re-keyed; nothing for a child', () => {
  const src = f6Primary().fields;
  const typed = carry.planCarryOver({ sourceFields: src, memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse', memberName: 'Mohamed Sabri Rauf' });
  assert.equal(typed.attributedBlock, true); assert.equal(typed.givenName, 'Sabri'); assert.equal(typed.copied, 4); assert.equal(typed.total, 5);
  assert.deepEqual(typed.fields.map((f) => [f.section, f.label, f.key]), [
    ['Section 1 — Profile Details', 'Family Name (Surname)', 'dependent-if-accompany-section-1-profile-details-family-name-surname'],
    ['Section 1 — Profile Details', 'Given Name', 'dependent-if-accompany-section-1-profile-details-given-name'],
    ['Section 1 — Profile Details', 'Height', 'dependent-if-accompany-section-1-profile-details-height'],
    ['Section 2 — Education › Table', 'Course / Program Name — Row 1', 'section-2-education-tbl-spouse-dep-education-r1-course-program-name'],
    ['Section 2 — Employment History › Table', 'Company Name — Row 2', 'section-2-employment-history-tbl-spouse-dep-employment-r2-company-name'],
  ]);
  const byPrincipal = carry.planCarryOver({ sourceFields: src, memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse' });
  assert.equal(byPrincipal.attributedBlock, true, 'no name typed: the principal\'s own "Spouse’s Given Name = Mohamed Sabri" shares the word Sabri');
  const plan = (over, opts) => carry.planCarryOver({ sourceFields: f6Primary(over).fields, memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse', ...opts });
  assert.equal(plan({ spouseGiven: '', spouseFamily: '' }, { memberName: 'Fatima Noor' }).attributedBlock, false, 'a typed name that shares nothing, and no clue from the principal');
  assert.equal(plan({ spouseGiven: '', spouseFamily: '' }, {}).attributedBlock, false, 'nothing to match against: never a guess');
  assert.equal(plan({}, { memberName: 'Mohamed Rauf' }).attributedBlock, true, 'staff omitted "Sabri": the principal\'s own "Spouse’s Given Name = Mohamed Sabri" still proves it (the two names are joined)');
  assert.equal(plan({}, { memberName: 'Spouse' }).attributedBlock, true, 'a placeholder "name" is no name: the principal\'s answer decides');
  // REFUSED: a block that is someone else's, even when a word is shared
  assert.equal(plan({ blockGiven: 'Mohamed Ayaan' }, { memberName: 'Mohamed Sabri Rauf' }).attributedBlock, false, 'a son named after the father: "ayaan" is not a word of the spouse\'s name');
  assert.equal(plan({ blockGiven: 'Mohamed Ayaan' }, {}).attributedBlock, false);
  assert.equal(plan({ blockGiven: 'Rauf' }, { memberName: 'Mohamed Sabri Rauf' }).attributedBlock, false, 'only the family name: proves nothing');
  assert.equal(plan({ blockGiven: 'Ayaan Rauf' }, { memberName: 'Mohamed Sabri Rauf' }).attributedBlock, false);
  assert.equal(plan({ accompany: 'No' }, { memberName: 'Mohamed Sabri Rauf' }).attributedBlock, false, 'the principal said the spouse is not accompanying: the block is someone else\'s');
  assert.equal(plan({ accompany: '' }, { memberName: 'Mohamed Sabri Rauf' }).attributedBlock, true, 'a blank answer never refuses');
  const child = carry.planCarryOver({ sourceFields: src, memberType: 'Dependent Child', memberKey: 'child-1', memberName: 'Sabri' });
  assert.equal(child.total, 0, 'a child never gets the adult-shaped block');
  assert.equal(child.attributedBlock, true, '…but learns it is the spouse\'s (no warning for it)');
  const f3 = [F(`${MA} › Section 1 — Profile Details › Marital Status`, 'Spouse’s Given Name', 'ms-prev', 'Rizwan'), F('Dependent Applicant › Section 1 — Profile Details', 'Given Name', 'dep-given', 'Rizwan'), F('Dependent Applicant › Section 1 — Profile Details', 'Height', 'dep-h', '120')];
  assert.equal(carry.planCarryOver({ sourceFields: f3, memberType: 'Spouse / Common-Law Partner', memberKey: 'spouse', memberName: 'Rizwan Khan' }).attributedBlock, false, 'the visitor / work-permit forms\' "Dependent Applicant" is never attributed by name');
  assert.deepEqual(carry.nameTokens('Mohamed Sabri Rauf'), ['mohamed', 'sabri', 'rauf']);
  assert.equal(carry.spouseNameFromPrincipal(src), 'Mohamed Sabri Rauf');
});

test('F6 I/O (a case like 2026-CEC-PS-100): the spouse add copies the block, tagged, into questionnaire-<ref>-spouse.json with no "unattributed" warning; a child add copies nothing and warns only when the block is nobody\'s', async () => {
  const w = world({ primary: f6Primary() });
  try {
    const r = await carry.carryEmbeddedAnswers({ ...base(w), memberName: 'Mohamed Sabri Rauf' });
    assert.equal(r.written, true); assert.equal(r.attributedBlock, true); assert.equal(r.ambiguousDependent, 0); assert.equal(r.copied, 4); assert.equal(r.givenName, 'Sabri');
    assert.deepEqual(w.uploads, [`questionnaire-${w.caseRef}-spouse.json`]);
    const sp = w.file('spouse');
    assert.equal(sp.formFile, F6); assert.ok(sp.fields.every((f) => f.source === 'carry-over'));
    assert.deepEqual(w.file('primary'), f6Primary(), 'the principal\'s file untouched');
  } finally { w.restore(); }
  const c = world({ primary: f6Primary() });
  try {
    const r = await carry.carryEmbeddedAnswers({ ...base(c), memberKey: 'child-1', memberType: 'Dependent Child', memberName: 'Ayaan' });
    assert.equal(r.skipped, 'nothing'); assert.equal(r.ambiguousDependent, 0, 'the block is the spouse\'s by the principal\'s own answer: no warning on a child add'); assert.equal(r.attributedBlock, true); assert.deepEqual(c.uploads, []);
    const unknown = world({ primary: f6Primary({ spouseGiven: '', spouseFamily: '' }) });
    try { const u = await carry.carryEmbeddedAnswers({ ...base(unknown), memberKey: 'child-1', memberType: 'Dependent Child' }); assert.equal(u.ambiguousDependent, 4, 'no clue whose it is: reported'); } finally { unknown.restore(); }
  } finally { c.restore(); }
});

test('REAL F6 FORM: the block\'s sub-sections and tables are what the member section stores (top header stripped; table ids dep-education / dep-employment / dep-vacation prefixed with the member key)', () => {
  const html = fs.readFileSync(path.join(FORMS_DIR, F6), 'utf8');
  const start = html.indexOf('Dependent (If Accompany)');
  assert.ok(start > 0);
  const block = html.slice(start);
  const subs = [...block.matchAll(/<div class="sub-accordion-header"[^>]*onclick="toggleSub\(this\)">([\s\S]*?)<\/div>/g)].map((m) => decode(m[1]));
  assert.deepEqual(subs.slice(0, 3), ['Section 1 — Profile Details', 'Section 2 — Education', 'Section 2 — Employment History']);
  const tables = [...block.matchAll(/<table class="dynamic-table" id="([a-z0-9-]+)">/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['dep-education', 'dep-employment', 'dep-vacation']);
  // the page's own section-name code on an F6-shaped DOM
  const single = spouseDom({ headerText: DEP });
  const multi = spouseDom({ memberKey: 'spouse', headerText: '💍  Mohamed Sabri Rauf' });
  const e1 = sectionEngine(false, single.body), e2 = sectionEngine(true, multi.body);
  const sub = 'Personal Details';   // spouseDom's first sub-section stands in for "Section 1 — Profile Details"
  assert.equal(e1.getSectionContext(single.inputs[sub]), `${DEP} › ${sub}`);
  assert.equal(e2.getSectionContext(multi.inputs[sub]), sub);
  assert.equal(carry.rekeyTableCell(F('Section 2 — Education › Table', 'Course / Program Name — Row 1', 'dependent-if-accompany-section-2-education-tbl-dep-education-r1-course-program-name', 'x'), 'spouse'), carry.memberTableKey('Section 2 — Education', 'spouse-dep-education', 1, 'Course / Program Name'));
});

/* ───────────────────────── the save path ───────────────────────── */

test('the flip: the principal\'s answers re-keyed without "Main Applicant ›" are NOT kept aside; the embedded spouse answers still are (computeSetAside)', () => {
  const previous = [
    F(`${MA} › Marital Status`, 'Current Marital Status', 'main-applicant-marital-status-current-marital-status', 'Married'),
    F(`${SP} › Marital Status`, 'Current Marital Status', 'dependent-spouse-common-law-partner-marital-status-current-marital-status', 'Married'),
    F(`${MA} › Section 1 — Profile Details`, 'Given Name', 'main-applicant-section-1-profile-details-given-name', 'Rizwan'),
  ];
  const incoming = [
    F('Marital Status', 'Current Marital Status', 'marital-status-current-marital-status', 'Married'),
    F('Section 1 — Profile Details', 'Given Name', 'section-1-profile-details-given-name', 'Rizwan'),
  ];
  const { setAside, added } = svc.computeSetAside({ previousFields: previous, previousSetAside: [], incomingFields: incoming, fromFormFile: AUG, now: '2026-10-09T00:00:00Z' });
  assert.equal(added, 1);
  assert.deepEqual(setAside.map((e) => e.section), [`${SP} › Marital Status`], 'only the spouse\'s answer is kept aside — the principal\'s are on the page');
  // and an earlier kept-aside duplicate of the principal\'s own answer leaves the list
  const again = svc.computeSetAside({ previousFields: [], previousSetAside: [{ ...previous[2], setAsideAt: '2026-10-01T00:00:00Z' }], incomingFields: incoming });
  assert.deepEqual(again.setAside, []);
});

test('the switch: QUESTIONNAIRE_CARRY_OVER is on unless set to 0 / false / off', () => {
  const prev = process.env.QUESTIONNAIRE_CARRY_OVER;
  try {
    delete process.env.QUESTIONNAIRE_CARRY_OVER; assert.equal(carry.isEnabled(), true);
    process.env.QUESTIONNAIRE_CARRY_OVER = '1'; assert.equal(carry.isEnabled(), true);
    for (const v of ['0', 'false', 'off']) { process.env.QUESTIONNAIRE_CARRY_OVER = v; assert.equal(carry.isEnabled(), false, v); }
  } finally { if (prev === undefined) delete process.env.QUESTIONNAIRE_CARRY_OVER; else process.env.QUESTIONNAIRE_CARRY_OVER = prev; }
});
