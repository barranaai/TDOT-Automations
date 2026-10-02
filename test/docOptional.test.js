'use strict';

// Optional documents (readiness item 2, cut 2, built 2026-10-02).
//
// A document whose NAME says "(Optional)", "(if applicable)", "if any", "If
// student …" used to count exactly like a mandatory one: a client who had no
// such document could never reach 100% and the case carried a "missing
// required" document forever. Now:
//   - the 32 text-only soft-named schema documents carry `optional: true`
//     (applied by hand; pinned here to the classifier's set minus the one
//     reasoned exception), resolved at read time — no board column, no reseed;
//   - with DOC_OPTIONAL on, the engine resolves such rows to Required Type
//     "Optional" and counts Optional/Conditional rows only once uploaded; the
//     client pages tag them "Optional" and count them the same way;
//   - OFF reproduces today's numbers and pages exactly;
//   - the Template board's Required Type is the lever for template-seeded
//     rows; scripts/template-required-type-optional.js sets it (dry-run first,
//     before-state saved, --undo), including the name affidavit (Faran, 2026-10-02).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const markers   = require('../src/utils/documentNameMarkers');
const optional  = require('../src/services/documentOptional');
const registry  = require('../src/services/caseSchemaService');
const planner   = require('../src/services/seedPlanner');
const mondayApi = require('../src/services/mondayApi');

const STATUS = 'color_mm0zwgvr', REF = 'text_mm0z2cck';

function withSwitch(on, fn) {
  const saved = process.env.DOC_OPTIONAL;
  if (on) process.env.DOC_OPTIONAL = '1'; else delete process.env.DOC_OPTIONAL;
  const done = () => { if (saved === undefined) delete process.env.DOC_OPTIONAL; else process.env.DOC_OPTIONAL = saved; };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(done); done(); return r; } catch (e) { done(); throw e; }
}
function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

/** A real registered code for (schemaFile, role, docCode) — the shape resolveDocumentCode parses. */
function realCode(caseType, subType, role, docCode) {
  const { slugUpper } = planner._internal;
  return `${slugUpper(caseType)}-${slugUpper(subType)}-${slugUpper(role)}-${docCode}-001`;
}
const OPT_CODE = realCode('AAIP', 'Opportunity Stream', 'PrincipalApplicant', 'LMIA');        // "Labour Market Impact Assessment (if applicable)"
const MAND_CODE = realCode('AAIP', 'Opportunity Stream', 'PrincipalApplicant', 'PASSPORT');   // "Passport with all stamped pages"

/* ───────────────────────── 1. the classifier ───────────────────────── */

test('classifier: optional wording in NAMES only; "if applicable"/"if any" win over a bare "if"; the reasoned exception is not optional', () => {
  assert.equal(markers.classify('Additional documents (Optional)').kinds.join(), 'optional');
  assert.equal(markers.classify('Urgent Travel Proof (if applicable)').kinds.join(), 'ifApplicable');
  assert.equal(markers.classify('Experience Documents … if any').kinds.join(), 'ifAny');
  assert.equal(markers.classify('If student: academic documents').kinds.join(), 'otherIf');
  assert.equal(markers.classify('Passport with all stamped pages').anySoft, false);
  assert.equal(markers.classify('Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core)').anySoft, false, 'A/B alternatives are not optional');
  assert.equal(markers.isSoftNamed('Labour Market Impact Assessment (if applicable)'), true);
  assert.equal(markers.isSoftNamed('Proof/source of Income (incl. academic docs if student)'), false, 'the income proof is always required — only the academic-docs part is conditional');
  assert.equal(markers.isSoftNamed('Proof / source of Income (incl. academic docs if student)'), false, 'spacing never changes the verdict');
  assert.equal(markers.AFFIDAVIT_RE.test('One and same name affidavit if name /surname changed'), true);
  assert.equal(markers.AFFIDAVIT_RE.test('One and same name affidavit if name/surname changed'), true);
});

/* ─────────────── 2. the schema flags — exactly the classifier's text-only set ─────────────── */

const SCHEMA_DIR = path.join(__dirname, '..', 'src', 'data', 'caseSchemas');
function everySchemaDoc() {
  const out = [];
  for (const f of fs.readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.js'))) {
    const s = require(path.join(SCHEMA_DIR, f));
    for (const r of s.roles || []) for (const d of r.documents || []) out.push({ file: f, role: r.role, code: d.code, name: d.name, doc: d });
  }
  return out;
}

// The 32 (file | role | code) flagged on 2026-10-02 — change this list only with a decision.
const FLAGGED = [
  'aaip--express-entry-stream.js|PrincipalApplicant|RELATIVEAB', 'aaip--express-entry-stream.js|Spouse|RELATIVEAB',
  'aaip--opportunity-stream.js|PrincipalApplicant|LMIA', 'aaip--rural-renewal-stream.js|PrincipalApplicant|LMIA', 'aaip--rural-renewal-stream.js|Spouse|LMIA', 'aaip--tourism-hospitality-stream.js|PrincipalApplicant|LMIA',
  'canadian-experience-class-ee-after-ita--cec-accompanying-spouse-child.js|PrincipalApplicant|SIBLINGPROOF', 'canadian-experience-class-ee-after-ita--cec-accompanying-spouse-child.js|Spouse|SIBLINGPROOF',
  'canadian-experience-class-profile-ita-submission--cec-accompanying-spouse-child.js|PrincipalApplicant|SIBLINGPROOF',
  'canadian-experience-class-profile-recreation-ita-submission--cec-accompanying-spouse-child.js|PrincipalApplicant|SIBLINGPROOF',
  'citizenship--default.js|PrincipalApplicant|LANGTEST',
  'lmia-based-wp--extension-inside-canada.js|PrincipalApplicant|IDCIVILDOCS', 'lmia-based-wp--extension-inside-canada.js|Spouse|IDCIVILDOCS',
  'lmia-based-wp--inside-canada.js|PrincipalApplicant|EXPERIENCEDOCS',
  'pr-card-renewal--default.js|PrincipalApplicant|URGENTTRAVEL', 'pr-card-renewal--default.js|Spouse|URGENTTRAVEL', 'prtd--default.js|PrincipalApplicant|URGENTTRAVEL', 'prtd--default.js|Spouse|URGENTTRAVEL',
  'sowp--extension-spouse-or-child.js|PrincipalApplicant|EDUDOCS', 'sowp--inland-established-relationship.js|Spouse|CANEDU', 'sowp--inland-non-established-relationship.js|Spouse|CANEDU',
  'sowp--outland-spouse-or-child.js|DependentChild|STUDENTDOCS', 'sowp--outland-spouse-or-child.js|Sponsor|CANEDU',
  'study-permit--non-sds-stream-accompanying-spouse-child.js|DependentChild|STUDENTDOCS',
  'visitor-record-extension--visitor-extension.js|PrincipalApplicant|ADDITIONALDOCS', 'visitor-record-extension--visitor-extension.js|Sponsor|INCOMEPROOF',
  'visitor-record-extension--visitor-record-restoration.js|PrincipalApplicant|ADDITIONALDOCS', 'visitor-record-extension--visitor-record-restoration.js|Sponsor|INCOMEPROOF',
  'visitor-record-extension--visitor-record.js|PrincipalApplicant|ADDITIONALDOCS', 'visitor-record-extension--visitor-record.js|Sponsor|INCOMEPROOF',
  'visitor-visa-1-3-members.js|DependentChild|STUDENTDOCS',
  'visitor-visa-spousal-sponsorship-in-process.js|PrincipalApplicant|FINDOCS',
].sort();

test('schemas: optional:true sits on exactly the classifier\'s text-only set (minus the exception) — the 32 pinned here; always a literal boolean; never on a name-change-gated document', () => {
  const docs = everySchemaDoc();
  const flagged = docs.filter((d) => 'optional' in d.doc);
  for (const d of flagged) assert.equal(d.doc.optional, true, `${d.file}:${d.code} optional must be the boolean true`);
  const expected = docs.filter((d) => !(d.doc.includeWhen && d.doc.includeWhen.memberFlag) && markers.isSoftNamed(d.name)).map((d) => `${d.file}|${d.role}|${d.code}`).sort();
  const actual = flagged.map((d) => `${d.file}|${d.role}|${d.code}`).sort();
  assert.deepEqual(actual, expected, 'the flags equal the classifier\'s verdict on every schema document');
  assert.deepEqual(actual, FLAGGED, 'the pinned list of 32');
  assert.equal(actual.length, 32);
  for (const d of docs) if (d.doc.includeWhen && d.doc.includeWhen.memberFlag) assert.ok(!('optional' in d.doc), `${d.file}:${d.code} is gated on a member flag — when it seeds it is required`);
  assert.ok(!docs.some((d) => /one and same name affidavit/i.test(d.name) && d.doc.optional), 'the affidavit is never optional on the schema path (it only seeds when the name changed)');
  assert.ok(docs.some((d) => /incl\. academic docs if student/.test(d.name) && !('optional' in d.doc)), 'the exception stays mandatory');
});

test('schemas: the registry never validates the flag (an invalid value must not reroute a case type to the Template board) — it is coerced at read time instead', () => {
  const src = fs.readFileSync(require.resolve('../src/services/caseSchemaService.js'), 'utf8');
  assert.ok(!/optional/i.test(src), 'caseSchemaService.isValidSchema knows nothing about optional');
  assert.equal(optional.isOptionalDoc({ optional: 'yes' }), false);
  assert.equal(optional.isOptionalDoc({ optional: 1 }), false);
  assert.equal(optional.isOptionalDoc({ optional: true }), true);
  assert.equal(optional.isOptionalDoc(null), false);
});

test('resolveDocumentCode exposes the flag for a real code; an unresolvable code is never optional', () => {
  const r = planner.resolveDocumentCode(OPT_CODE);
  assert.ok(r && r.doc, `resolves ${OPT_CODE}`);
  assert.equal(r.doc.name, 'Labour Market Impact Assessment (if applicable)');
  assert.equal(optional.isOptionalCode(OPT_CODE), true);
  assert.equal(optional.isOptionalCode(MAND_CODE), false);
  assert.equal(optional.isOptionalCode('SCLPC-WP--PA-PASSPORT-001'), false, 'unknown code → Mandatory, as today');
  assert.equal(optional.isOptionalIntake('code:' + OPT_CODE), true);
  assert.equal(optional.isOptionalIntake('18401624999'), false, 'a template item id is not a code');
});

/* ───────────────────────── 3. the switch + client maths ───────────────────────── */

test('DOC_OPTIONAL: off unless "1"/"true"', () => {
  withSwitch(false, () => assert.equal(optional.isEnabled(), false));
  withSwitch(true, () => assert.equal(optional.isEnabled(), true));
  const saved = process.env.DOC_OPTIONAL; process.env.DOC_OPTIONAL = 'yes';
  try { assert.equal(optional.isEnabled(), false); } finally { if (saved === undefined) delete process.env.DOC_OPTIONAL; else process.env.DOC_OPTIONAL = saved; }
});

test('clientProgress: N/A rows out entirely; an optional row counts only once uploaded', () => {
  const rows = [
    { status: 'Received' }, { status: 'Reviewed' }, { status: 'Missing' },
    { status: 'Missing', optional: true }, { status: 'Received', optional: true },
    { status: 'Not Applicable' }, { status: 'Not Applicable', optional: true },
  ];
  assert.deepEqual(optional.clientProgress(rows), { total: 4, uploaded: 3, optionalOpen: 1 });
  assert.deepEqual(optional.clientProgress([]), { total: 0, uploaded: 0, optionalOpen: 0 });
  assert.deepEqual(optional.clientProgress([{ status: '' , optional: true }]), { total: 0, uploaded: 0, optionalOpen: 1 }, 'a blank status reads Missing');
});

/* ───────────────────────── 4. the readiness engine ───────────────────────── */

const { _internal } = require('../src/services/caseReadinessService');
const { calcDocMetrics, applySchemaDefaults } = _internal;
const D = { counts: 'lookup_mm0zhkkd', status: STATUS, blocking: 'lookup_mm0zb0p6', required: 'lookup_mm0z1chx', intakeId: 'text_mm0zfsp1' };
const row = ({ intakeId, status = '', counts = '', blocking = '', required = '' }) => ({ id: 'x', column_values: [
  { id: D.intakeId, text: intakeId }, { id: D.status, text: status }, { id: D.counts, text: counts }, { id: D.blocking, text: blocking }, { id: D.required, text: required } ] });
const req = (item) => item.column_values.find((c) => c.id === D.required).text;

test('applySchemaDefaults: with the switch ON an optional schema row resolves to Required "Optional"; others and unknown codes stay Mandatory; OFF → every row Mandatory (today)', () => {
  const build = () => [row({ intakeId: 'code:' + OPT_CODE, status: '' }), row({ intakeId: 'code:' + MAND_CODE, status: '' }), row({ intakeId: 'code:SCLPC-WP--PA-PASSPORT-001' }), row({ intakeId: '18401624999' })];
  withSwitch(true, () => {
    const items = build(); applySchemaDefaults(items);
    assert.deepEqual(items.map(req), ['Optional', 'Mandatory', 'Mandatory', ''], 'template rows are untouched (their mirror is filled from the template)');
    assert.equal(items[0].column_values.find((c) => c.id === D.counts).text, 'Yes', 'Counts stays Yes — optional rows count once present');
  });
  withSwitch(false, () => {
    const items = build(); applySchemaDefaults(items);
    assert.deepEqual(items.map(req), ['Mandatory', 'Mandatory', 'Mandatory', '']);
  });
});

test('calcDocMetrics: an Optional/Conditional row counts only once uploaded (ON); OFF keeps today\'s denominator; Missing Required is Mandatory-only either way', () => {
  // the EE-070 shape: 10 Received, 1 open optional row
  const ee070 = () => { const items = [...Array(10).fill('Received'), ''].map((s, i) => row({ intakeId: 'code:' + (i === 10 ? OPT_CODE : MAND_CODE), status: s })); return items; };
  withSwitch(true, () => {
    const items = ee070(); applySchemaDefaults(items);
    assert.deepEqual(calcDocMetrics(items), { readinessPct: 0, uploadedPct: 100, blockingCount: 0, missingRequired: 0, totalCountable: 10 });
    // the same optional row, once the client uploads it, joins the count
    const up = ee070(); up[10].column_values.find((c) => c.id === D.status).text = 'Received'; applySchemaDefaults(up);
    assert.deepEqual(calcDocMetrics(up), { readinessPct: 0, uploadedPct: 100, blockingCount: 0, missingRequired: 0, totalCountable: 11 });
    // a Reviewed optional row is a reviewed countable row
    const rv = ee070(); rv[10].column_values.find((c) => c.id === D.status).text = 'Reviewed'; applySchemaDefaults(rv);
    assert.equal(calcDocMetrics(rv).readinessPct, 9); assert.equal(calcDocMetrics(rv).totalCountable, 11);
  });
  withSwitch(false, () => {
    const items = ee070(); applySchemaDefaults(items);
    assert.deepEqual(calcDocMetrics(items), { readinessPct: 0, uploadedPct: 91, blockingCount: 0, missingRequired: 1, totalCountable: 11 }, 'today\'s numbers');
  });
  // the pure function can be pinned both ways regardless of the env
  const tmpl = [row({ intakeId: '1', status: '', counts: 'Yes', required: 'Optional' }), row({ intakeId: '2', status: 'Received', counts: 'Yes', required: 'Conditional' }), row({ intakeId: '3', status: '', counts: 'Yes', required: 'Mandatory' })];
  assert.deepEqual(calcDocMetrics(tmpl, { optionalCountsWhenPresent: true }), { readinessPct: 0, uploadedPct: 50, blockingCount: 0, missingRequired: 1, totalCountable: 2 });
  assert.deepEqual(calcDocMetrics(tmpl, { optionalCountsWhenPresent: false }), { readinessPct: 0, uploadedPct: 33, blockingCount: 0, missingRequired: 1, totalCountable: 3 }, 'OFF: today\'s denominator; an Optional row was never a missing required document');
  // a blank-Required template row (never Mandatory) is unchanged by the rule
  const blank = [row({ intakeId: '4', status: '', counts: 'Yes', required: '' })];
  assert.equal(calcDocMetrics(blank, { optionalCountsWhenPresent: true }).totalCountable, 1);
});

/* ───────────────────────── 5. getCaseDocuments carries `optional` ───────────────────────── */

test('getCaseDocuments: optional from the schema flag (code rows) or the template\'s Required Type — only while the switch is on', async () => {
  const set = (rel, exports) => { const p = require.resolve(rel); const prev = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; }; };
  const rows = [
    { id: '1', name: 'LMIA', cols: { text_mm0zfsp1: 'code:' + OPT_CODE } },
    { id: '2', name: 'Passport', cols: { text_mm0zfsp1: 'code:' + MAND_CODE } },
    { id: '3', name: 'Urgent Travel Proof (if applicable)', cols: { text_mm0zfsp1: '18401624991' } },   // template: Optional
    { id: '4', name: 'Passport', cols: { text_mm0zfsp1: '18401624992' } },                            // template: Mandatory
  ];
  const undo = [
    set('../src/services/mondayApi', { query: async (q) => {
      if (q.includes('items_page_by_column_values')) return { items_page_by_column_values: { items: rows.map((r) => ({ id: r.id, name: r.name, column_values: Object.entries(r.cols).map(([id, text]) => ({ id, text })) })) } };
      if (q.includes('items(ids: $ids, limit: $lim)')) {
        assert.match(q, /dropdown_mm0x9v5q/, 'the template fetch asks for Required Type');
        return { items: [
          { id: '18401624991', column_values: [{ id: 'dropdown_mm0x9v5q', text: 'Optional' }, { id: 'dropdown_mm261bn6', text: 'Principal Applicant' }] },
          { id: '18401624992', column_values: [{ id: 'dropdown_mm0x9v5q', text: 'Mandatory' }, { id: 'dropdown_mm261bn6', text: 'Principal Applicant' }] } ] };
      }
      return {};
    } }),
    set('../src/services/oneDriveService', {}), set('../src/services/caseReadinessService', { calculateForCaseRef: async () => {} }),
  ];
  const p = require.resolve('../src/services/documentFormService'); const prevMod = require.cache[p]; delete require.cache[p];
  try {
    const fresh = require(p);
    await withSwitch(true, async () => {
      const by = Object.fromEntries((await fresh.getCaseDocuments('2026-X-001')).map((d) => [d.id, d.optional]));
      assert.deepEqual(by, { 1: true, 2: false, 3: true, 4: false });
    });
    await withSwitch(false, async () => {
      const by = Object.fromEntries((await fresh.getCaseDocuments('2026-X-001')).map((d) => [d.id, d.optional]));
      assert.deepEqual(by, { 1: false, 2: false, 3: false, 4: false }, 'OFF: no row is optional');
    });
  } finally { delete require.cache[p]; if (prevMod) require.cache[p] = prevMod; undo.forEach((u) => u()); }
});

/* ───────────────────────── 6. the pages ───────────────────────── */

const DOCS = (opt) => [
  { id: '11', name: 'Passport', status: 'Received', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '2026-07-10' },
  { id: '12', name: 'Urgent Travel Proof (if applicable)', status: 'Missing', category: 'Travel', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '', optional: opt },
];

test('client portal: an open optional row is tagged, worded "only if it applies to you", and out of "X of Y" — so 100% is reachable', () => {
  const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  const page = (opt) => buildPortalPage({
    clientName: 'K', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null, caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 0, qCompletionStatus: '', docCounts: { total: 2, received: 1, reviewed: 0, rework: 0, missing: 1, na: 0, optionalOpen: opt ? 1 : 0 },
    reworkDocs: [], totalMembers: 1, submittedMembers: 0, journey: clientStage('Document Collection Started'), timeline: toClientTimeline([]), payments: null, docItems: DOCS(opt),
  });
  const on = page(true);
  assert.ok(on.includes('<span class="doc-tag doc-tag-opt">Optional</span>'));
  assert.ok(on.includes('Optional — only if it applies to you'));
  assert.ok(on.includes('1 optional — only if it applies to you.'));
  assert.match(on, /1 of 1 ready/, 'the optional row is out of the denominator');
  assert.match(on, /100% uploaded/);
  assert.equal((on.match(/data-item="/g) || []).length, 2, 'the client can still upload it');
  const off = page(false);
  assert.ok(!off.includes('>Optional<') && !off.includes('only if it applies'));
  assert.match(off, /1 of 2 ready/);
  const src = fs.readFileSync(require.resolve('../src/services/clientPortalService.js'), 'utf8');
  assert.match(src, /if \(it\.optional === true && s === 'Missing'\) docCounts\.optionalOpen\+\+;/, 'the snapshot counts open optional rows');
  assert.match(src, /const docTotal\s+= snap\.docCounts\.total - docNa - docOptOpen;/);
});

test('legacy /documents page: the Optional badge, data-optional, the shared count, and live counters that follow the same rule', () => {
  const { _formPage } = require('../src/routes/documentUploadForm');
  const members = [{ memberType: 'Principal Applicant', sections: [{ category: 'Identity', items: [
    { id: '1', name: 'Passport', status: 'Received', documentName: 'Passport' },
    { id: '2', name: 'Urgent Travel Proof (if applicable)', status: 'Missing', documentName: 'Urgent Travel Proof', optional: true },
    { id: '3', name: 'Marriage certificate', status: 'Not Applicable', documentName: 'Marriage certificate' } ] }] }];
  const html = _formPage('2026-TEST-001', 'Test Client', members, false, [], null);
  assert.match(html, /1 of 1 documents uploaded \(100%\)/);
  assert.match(html, /let uploadedCount = 1;/); assert.match(html, /let totalCount\s+= 1;/);
  assert.match(html, /id="pmeta_0">1 of 1 uploaded</);
  assert.match(html, /data-status="Missing" data-optional="1"/);
  assert.ok(!/data-status="Received" data-optional/.test(html), 'the attribute is emitted only on optional rows (OFF pages carry nothing new)');
  assert.ok(html.includes('<span class="badge optional"'));
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
  assert.match(html, /function countRows\(nodeList\)/);
  assert.match(html, /if \(r\.dataset\.optional === '1' && !up\) return;/, 'client-side: an open optional row is out of the count');
  assert.match(html, /if \(row\.dataset\.optional === '1'\) totalCount\+\+;/, 'client-side: an optional row joins the count once uploaded');
  const src = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');
  assert.match(src, /const \{ clientProgress: countsForClient \} = require\('\.\.\/services\/documentOptional'\);/, 'one helper for both client pages');
});

test('review page + cockpit: staff see the Optional pill / "(optional)"; nothing when the row is not optional', () => {
  const svc = require('../src/services/documentReviewFormService');
  const items = (opt) => [{ id: '2', name: 'Urgent Travel Proof (if applicable)', status: 'Missing', category: 'Travel', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '', optional: opt }];
  const on = svc.buildReviewPage({ caseRef: '2026-X-001', clientName: 'K', staffName: 'G', items: items(true), folderLinks: {} });
  assert.ok(on.includes('<span class="opt-pill" title="Optional document — counts toward the % only once uploaded">Optional</span>'));
  const off = svc.buildReviewPage({ caseRef: '2026-X-001', clientName: 'K', staffName: 'G', items: items(false), folderLinks: {} });
  assert.ok(!off.includes('class="opt-pill"'));
  const { summariseDocuments } = require('../src/services/caseCockpitService');
  const out = summariseDocuments([{ id: '2', name: 'LMIA', status: 'Missing', category: 'Employment', applicantType: 'Principal Applicant', optional: true }, { id: '3', name: 'Passport', status: 'Received', category: 'Identity', applicantType: 'Principal Applicant' }]);
  const rows = out.byCategory.flatMap((c) => c.items);
  assert.equal(rows.find((r) => r.id === '2').optional, true);
  assert.equal(rows.find((r) => r.id === '3').optional, false);
  const cockpit = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.match(cockpit, /\(it\.optional \? ' <span class="muted">\(optional\)<\/span>' : ''\)/);
});

/* ───────────────────────── 7. the Template-board tool ───────────────────────── */

test('template tool plan: soft-named items + the name affidavit when Required Type is blank or Mandatory; Counts No→Yes on those; a Blocking=Yes item is skipped and reported; never Optional/Conditional, never the exception, never a plain name', () => {
  const tool = require('../scripts/template-required-type-optional');
  const items = [
    { id: '1', name: 'Urgent Travel Proof (if applicable)', requiredType: '', counts: 'Yes' },
    { id: '2', name: 'Additional documents (Optional)', requiredType: 'Mandatory', counts: 'No' },
    { id: '3', name: 'One and same name affidavit if name /surname changed', requiredType: 'Mandatory', counts: '' },
    { id: '4', name: 'One and same name affidavit if name/surname changed', requiredType: '', counts: 'Yes' },
    { id: '5', name: 'Passport with all stamped pages', requiredType: 'Mandatory', counts: 'Yes' },
    { id: '6', name: 'Labour Market Impact Assessment (if applicable)', requiredType: 'Optional', counts: 'Yes' },
    { id: '7', name: 'If student (current grade marksheets)', requiredType: 'Conditional', counts: 'No' },
    { id: '8', name: 'Proof/source of Income (incl. academic docs if student)', requiredType: '', counts: 'Yes' },
    { id: '9', name: 'Proof of language proficiency (IELTS-G/CELPIP-G)', requiredType: '', counts: 'Yes' },
    { id: '10', name: 'Sibling- Proof of living in Canada- if applicable', requiredType: 'Mandatory', counts: 'No', blocking: 'Yes' },
  ];
  const plan = tool.planTemplateWrites(items);
  assert.deepEqual(plan.map((p) => p.id), ['1', '2', '3', '4', '10']);
  assert.deepEqual(plan[0], { id: '1', name: 'Urgent Travel Proof (if applicable)', counts: 'Yes', previous: { required: '' }, writes: { required: 'Optional' } });
  assert.deepEqual(plan[1].writes, { required: 'Optional' }, 'Required Type is the ONLY column written — Counts stays as it is');
  assert.deepEqual(plan[1].previous, { required: 'Mandatory' }); assert.equal(plan[1].counts, 'No', 'Counts is read for the report only');
  assert.match(plan[4].skipped, /Blocking Flag = Yes/);
  assert.ok(!('writes' in plan[4]));
  // the write shape: a dropdown takes labels; an empty list clears (undo of a previously-blank item)
  assert.deepEqual(tool.colValues({ required: 'Optional' }), { dropdown_mm0x9v5q: { labels: ['Optional'] } });
  assert.deepEqual(tool.colValues({ required: '' }), { dropdown_mm0x9v5q: { labels: [] } });
  // the dropdown's settings_str holds labels as [{id, name}]; a status-style map is read too
  assert.deepEqual(tool.dropdownLabelNames(JSON.stringify({ labels: [{ id: 1, name: 'Mandatory' }, { id: 2, name: 'Conditional' }, { id: 3, name: 'Optional' }] })), ['Mandatory', 'Conditional', 'Optional']);
  assert.deepEqual(tool.dropdownLabelNames(JSON.stringify({ labels: { 1: 'Yes', 2: 'No' } })), ['Yes', 'No']);
  assert.deepEqual(tool.dropdownLabelNames(''), []);
  assert.equal(tool.LABEL, 'Optional'); assert.equal(tool.REQ_COL, 'dropdown_mm0x9v5q'); assert.equal(tool.BOARD_ID, '18401624183');
});

test('template tool: requiring it runs nothing; the before-state is written BEFORE the first write; dry-run never mutates; --undo restores from that file', () => {
  const src = fs.readFileSync(require.resolve('../scripts/template-required-type-optional.js'), 'utf8');
  assert.match(src, /if \(require\.main === module\) main\(\)/);
  const dry = src.indexOf("if (!WRITE) { console.log('\\n(Dry-run.");
  const before = src.indexOf('fs.writeFileSync(beforePath');
  const firstWrite = src.indexOf('await writeItem(mondayApi, p.id, p.writes)');
  assert.ok(dry !== -1 && before !== -1 && firstWrite !== -1);
  assert.ok(dry < before && before < firstWrite, 'dry-run returns before any write; the before-state file lands before the first mutation');
  assert.ok(!/create_labels_if_missing/.test(src));
  assert.match(src, /saved\.column !== REQ_COL\) throw/, 'undo refuses a file for another board/column');
  assert.match(src, /\{ flag: 'wx' \}/, 'the before-state file is never overwritten');
  assert.match(src, /slice\(0, 19\)/, 'the stamp is to the second');
  assert.match(src, /if \(argv\.includes\('--undo'\) && \(!UNDO \|\| UNDO\.startsWith\('--'\)\)\)/, '--undo without a file stops before anything runs');
  assert.match(src, /if \(UNDO && WRITE\)/, '--undo and --write never combine');
  assert.match(src, /function colValues\(\{ required \}\) \{\s*return \{ \[REQ_COL\]: required \? \{ labels: \[required\] \} : \{ labels: \[\] \} \};\s*\}/, 'the only mutation payload carries Required Type alone');
  assert.equal((src.match(/change_multiple_column_values/g) || []).length, 1);
  assert.match(src, /const back = await readBack\(mondayApi, todo\.map\(\(p\) => p\.id\)\);/, 'the write re-reads what it wrote');
  assert.match(src, /await assertLabelsExist\(mondayApi\);/, 'the labels are checked before the first write');
  assert.ok(src.indexOf('await assertLabelsExist(mondayApi);') < src.indexOf('fs.writeFileSync(beforePath'), 'label check before the before-state, before any write');
  assert.match(src, /catch \(err\) \{ failed\.push\(`\$\{it\.id\} \(\$\{err\.message\}\)`\); \}/, 'undo continues past a failed item and reports it');
  // a mutation only ever targets the one column
  assert.equal((src.match(/change_multiple_column_values/g) || []).length, 1);
  assert.ok(!/change_simple_column_value|create_item|delete_item|archive_item/.test(src));
});


/* ───────────────────────── 8. after the cut-2 review ───────────────────────── */

test('engine: "Conditional" behaves like "Optional"; with the rule ON an UPLOADED optional row counts whatever Counts says (the template\'s Counts=No was the old "optional"); OFF leaves Counts=No rows out as today; an open optional BLOCKING row still blocks (blocking untouched)', async () => {
  const tmpl = [row({ intakeId: '5', status: '', counts: 'Yes', required: 'Conditional' }), row({ intakeId: '6', status: 'Received', counts: 'Yes', required: 'Mandatory' })];
  assert.equal(calcDocMetrics(tmpl, { optionalCountsWhenPresent: true }).totalCountable, 1);
  assert.equal(calcDocMetrics(tmpl, { optionalCountsWhenPresent: false }).totalCountable, 2);
  const no = [row({ intakeId: '7', status: 'Received', counts: 'No', required: 'Optional' }), row({ intakeId: '7b', status: '', counts: 'No', required: 'Optional' }), row({ intakeId: '7c', status: 'Received', counts: 'No', required: 'Mandatory' })];
  assert.equal(calcDocMetrics(no, { optionalCountsWhenPresent: true }).totalCountable, 1, 'ON: the uploaded optional row counts; the open one and the Counts=No mandatory one do not');
  assert.equal(calcDocMetrics(no, { optionalCountsWhenPresent: false }).totalCountable, 0, 'OFF: Counts=No rows are out, as today');
  assert.equal(calcDocMetrics(no, { optionalCountsWhenPresent: true }).missingRequired, 0);
  const blk = [row({ intakeId: '8', status: '', counts: 'Yes', required: 'Optional', blocking: 'Yes' })];
  assert.equal(calcDocMetrics(blk, { optionalCountsWhenPresent: true }).blockingCount, 1, 'pinned: the tool never flags a Blocking=Yes item');
});

test('engine: Missing Required is Mandatory-only, ON and OFF — the switch and the Template-board tool are one change (rollback = switch OFF + --undo)', () => {
  const tmpl = [row({ intakeId: '9', status: '', counts: 'Yes', required: 'Optional' }), row({ intakeId: '10', status: '', counts: 'Yes', required: 'Conditional' }), row({ intakeId: '11', status: '', counts: 'Yes', required: '' }), row({ intakeId: '12', status: '', counts: 'Yes', required: 'Mandatory' })];
  assert.equal(calcDocMetrics(tmpl, { optionalCountsWhenPresent: false }).missingRequired, 1);
  assert.equal(calcDocMetrics(tmpl, { optionalCountsWhenPresent: true }).missingRequired, 1);
  const src = fs.readFileSync(require.resolve('../src/services/documentOptional.js'), 'utf8');
  assert.match(src, /the rollback is the switch OFF AND the tool's --undo/);
});

test('engine: applySchemaDefaults fills only EMPTY mirrors — a code row that already carries a Required Type keeps it', () => {
  withSwitch(true, () => {
    const items = [row({ intakeId: 'code:' + OPT_CODE, status: '', required: 'Mandatory' }), row({ intakeId: 'code:' + OPT_CODE, status: '' })];
    applySchemaDefaults(items);
    assert.deepEqual(items.map(req), ['Mandatory', 'Optional']);
  });
});

test('getCaseDocuments: a template Required Type of "Conditional" is optional too (ON), and never OFF', async () => {
  const set = (rel, exports) => { const p = require.resolve(rel); const prev = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; }; };
  const undo = [
    set('../src/services/mondayApi', { query: async (q) => {
      if (q.includes('items_page_by_column_values')) return { items_page_by_column_values: { items: [{ id: '5', name: 'If student', column_values: [{ id: 'text_mm0zfsp1', text: '18401624993' }] }] } };
      if (q.includes('items(ids: $ids, limit: $lim)')) return { items: [{ id: '18401624993', column_values: [{ id: 'dropdown_mm0x9v5q', text: 'Conditional' }, { id: 'dropdown_mm261bn6', text: 'Dependent Child' }] }] };
      return {};
    } }),
    set('../src/services/oneDriveService', {}), set('../src/services/caseReadinessService', { calculateForCaseRef: async () => {} }),
  ];
  const p = require.resolve('../src/services/documentFormService'); const prevMod = require.cache[p]; delete require.cache[p];
  try {
    const fresh = require(p);
    await withSwitch(true, async () => assert.equal((await fresh.getCaseDocuments('2026-X-001'))[0].optional, true));
    await withSwitch(false, async () => assert.equal((await fresh.getCaseDocuments('2026-X-001'))[0].optional, false));
  } finally { delete require.cache[p]; if (prevMod) require.cache[p] = prevMod; undo.forEach((u) => u()); }
});

test('classifier: the live Template-board spellings read as optional; the exception matches loosely (punctuation / spacing)', () => {
  for (const name of ['Sibling- Proof of living in Canada- if applicable', 'If student', 'Relative in Alberta- Parents/ Siblings/ Children (applicable only if you were drawn based on having a family', 'Experience Documents- Provide all relevant experience documents from previous employers if any.', 'Canadian Education Documents- (For each program if studied here)', 'If you or your spouse or common-law partner has a relative who is a Canadian citizen or a permanent resident of Canada']) {
    assert.equal(markers.isSoftNamed(name), true, name);
  }
  for (const name of ['Proof/source of Income (incl academic docs if student)', 'Proof / source of income (incl. academic docs if student).', 'PROOF/SOURCE OF INCOME (INCL. ACADEMIC DOCS IF STUDENT)']) {
    assert.equal(markers.isSoftNamed(name), false, name);
  }
  assert.equal(markers.loose('Proof/source of Income (incl. academic docs if student)'), 'proofsourceofincomeinclacademicdocsifstudent');
});

test('portal: countDocItems is the pure count the card is built from; staff mode words it for staff', () => {
  const { countDocItems, buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  assert.deepEqual(countDocItems([{ status: 'Received' }, { status: 'Missing', optional: true }, { status: 'Missing' }, { status: 'Not Applicable' }, { status: 'Reviewed', optional: true }]),
    { total: 5, received: 1, reviewed: 1, rework: 0, missing: 2, na: 1, optionalOpen: 1 });
  const html = buildPortalPage({
    clientName: 'K', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null, caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 0, qCompletionStatus: '', docCounts: { total: 2, received: 1, reviewed: 0, rework: 0, missing: 1, na: 0, optionalOpen: 1 },
    reworkDocs: [], totalMembers: 1, submittedMembers: 0, journey: clientStage('Document Collection Started'), timeline: toClientTimeline([]), payments: null, docItems: DOCS(true),
  }, { mode: 'staff', staffName: 'G' });
  assert.ok(html.includes('Optional — counts once uploaded'));
  assert.ok(html.includes('(1 optional, not sent)'));
  assert.ok(html.includes('class="doc-tag doc-tag-opt"'));
});

test('cockpit + review strip: open optional rows are out of "X of Y" and the Pending/Missing counts', () => {
  const { summariseDocuments } = require('../src/services/caseCockpitService');
  const out = summariseDocuments([{ id: '1', name: 'LMIA', status: 'Missing', category: 'Employment', applicantType: 'Principal Applicant', optional: true }, { id: '2', name: 'Passport', status: 'Received', category: 'Identity', applicantType: 'Principal Applicant' }]);
  assert.equal(out.counts.optionalOpen, 1); assert.equal(out.counts.missing, 1);
  const cockpit = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.match(cockpit, /\(c\.total - na - opt\) \+ ' document\(s\) in'/);
  assert.match(cockpit, /document\.getElementById\('d-sub'\)\.textContent = docSubtitle\(d\.documents\.counts, d\.docReviewedPct\);/);
  assert.match(cockpit, /\['Missing', c\.missing - \(c\.optionalOpen \|\| 0\), '#94a3b8'\]/);
  const svc = require('../src/services/documentReviewFormService');
  const page = svc.buildReviewPage({ caseRef: '2026-X-001', clientName: 'K', staffName: 'G', items: [
    { id: '1', name: 'LMIA', status: 'Missing', category: 'Employment', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '', optional: true },
    { id: '2', name: 'Passport', status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '' } ], folderLinks: {} });
  assert.match(page, /<div class="num">1<\/div><div class="lbl">Pending · \+1 optional<\/div>/);
});

test('legacy page: a group whose rows are all optional (not sent) says "nothing required" instead of "0 of 0" — server and client side', () => {
  const { _formPage } = require('../src/routes/documentUploadForm');
  const members = [{ memberType: 'Principal Applicant', sections: [
    { category: 'Travel', items: [{ id: '2', name: 'Urgent Travel Proof (if applicable)', status: 'Missing', documentName: 'UTP', optional: true }] },
    { category: 'Identity', items: [{ id: '1', name: 'Passport', status: 'Received', documentName: 'Passport' }] } ] }];
  const html = _formPage('2026-TEST-001', 'Test Client', members, false, [], null);
  assert.match(html, /id="pmeta_0">nothing required yet</);
  assert.match(html, /id="pmeta_1">1 of 1 uploaded</);
  assert.match(html, /function countLabel\(c, sep\) \{ return \(c\.total === 0 && c\.rows > 0\) \? 'nothing required'/);
  const only = _formPage('2026-TEST-001', 'Test Client', [{ memberType: 'Principal Applicant', sections: [{ category: 'Travel', items: [{ id: '2', name: 'UTP', status: 'Missing', documentName: 'UTP', optional: true }] }] }], false, [], null);
  assert.match(only, /No documents required right now — the optional ones only if they apply to you/);
  const allNa = _formPage('2026-TEST-001', 'Test Client', [{ memberType: 'Principal Applicant', sections: [{ category: 'Travel', items: [{ id: '3', name: 'X', status: 'Not Applicable', documentName: 'X' }] }] }], false, [], null);
  assert.match(allNa, /Nothing to upload right now — your case officer confirmed these documents are not needed/);
  assert.ok(!allNa.includes('the optional ones'));
  // multi-member layout: pill, category badge and panel meta all say so
  const multi = _formPage('2026-TEST-001', 'Test Client', [
    { memberType: 'Principal Applicant', sections: [{ category: 'Identity', items: [{ id: '1', name: 'Passport', status: 'Received', documentName: 'P' }] }] },
    { memberType: 'Spouse', sections: [{ category: 'Travel', items: [{ id: '2', name: 'UTP', status: 'Missing', documentName: 'U', optional: true }] }] } ], true, [], null);
  assert.match(multi, /id="pcount_1">nothing required</);
  assert.match(multi, /class="cat-count">nothing required</);
  assert.match(multi, /id="pmeta_1">nothing required yet</);
  assert.match(multi, /id="pcount_0">1\/1</);
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
});


test('legacy page: the emitted client-side counters follow the same rule (run in a VM over fake rows)', () => {
  const vm = require('vm');
  const { _formPage } = require('../src/routes/documentUploadForm');
  const html = _formPage('2026-TEST-001', 'Test Client', [{ memberType: 'Principal Applicant', sections: [{ category: 'Identity', items: [{ id: '1', name: 'Passport', status: 'Missing', documentName: 'P' }] }] }], false, [], null);
  const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).find((s) => s.includes('function countRows'));
  const a = script.indexOf('function isUploadedRow'), b = script.indexOf('function updatePanelMeta');
  assert.ok(a !== -1 && b > a);
  const ctx = {};
  vm.runInNewContext(script.slice(a, b) + '\nout = { countRows: countRows, countLabel: countLabel };', ctx);
  const rows = [{ dataset: { status: 'Received' } }, { dataset: { status: 'Missing', optional: '1' } }, { dataset: { status: 'Received', optional: '1' } }, { dataset: { status: 'Not Applicable' } }, { dataset: { status: 'Missing' } }];
  assert.deepEqual({ ...ctx.out.countRows(rows) }, { total: 3, uploaded: 2, rows: 5 });   // copied: the VM realm's Object.prototype differs
  assert.equal(ctx.out.countLabel({ total: 0, uploaded: 0, rows: 2 }, ' / '), 'nothing required');
  assert.equal(ctx.out.countLabel({ total: 3, uploaded: 2, rows: 5 }, '/'), '2/3');
  assert.equal(ctx.out.countLabel({ total: 0, uploaded: 0, rows: 0 }, '/'), '0/0', 'an empty group is simply empty');
});

test('cockpit: the Documents subtitle is one pure function — with and without N/A / optional, and an old-shaped payload', () => {
  const vm = require('vm');
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  const html = buildCockpitHTML('2026-X-001');
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const a = script.indexOf('function docSubtitle'), b = script.indexOf('function renderDocRow');
  assert.ok(a !== -1 && b > a);
  const block = script.slice(a, b);
  assert.ok(!block.includes('\\') && !block.includes('`') && !block.includes('${'), 'inline-JS house rules');
  const ctx = {};
  vm.runInNewContext(block + '\nout = docSubtitle;', ctx);
  assert.equal(ctx.out({ total: 5, received: 2, reviewed: 1, rework: 0, missing: 2, na: 1, optionalOpen: 1 }, 0), '3 of 3 document(s) in · 1 not applicable · 1 optional not sent · 1 reviewed');
  assert.equal(ctx.out({ total: 5, received: 3, reviewed: 0, rework: 0, missing: 2 }, 40), '3 of 5 document(s) in · 40% reviewed', 'an old-shaped answer (no na / optionalOpen) never shows NaN');
  assert.match(script, /c\.total \+ ' total' \+ \(c\.optionalOpen \? ' · ' \+ c\.optionalOpen \+ ' optional not sent' : ''\)/, 'the strip explains why the tiles do not sum');
});

test('portal: a checklist whose every row is optional-not-sent (or N/A) says "Nothing required" and shows a green badge, like the legacy page', () => {
  const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  const page = (docItems, docCounts) => buildPortalPage({
    clientName: 'K', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null, caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 0, qCompletionStatus: '', docCounts, reworkDocs: [], totalMembers: 1, submittedMembers: 0,
    journey: clientStage('Document Collection Started'), timeline: toClientTimeline([]), payments: null, docItems,
  });
  const opt = page([DOCS(true)[1]], { total: 1, received: 0, reviewed: 0, rework: 0, missing: 1, na: 0, optionalOpen: 1 });
  assert.ok(opt.includes('No documents required right now — 1 optional, only if it applies to you.'));
  assert.ok(opt.includes('>Nothing required</span>') && opt.includes('badge-ok'));
  assert.ok(!opt.includes('0 of 0 ready') && !opt.includes('0% uploaded'));
  const na = page([{ id: '13', name: 'X', status: 'Not Applicable', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' }], { total: 1, received: 0, reviewed: 0, rework: 0, missing: 0, na: 1, optionalOpen: 0 });
  assert.ok(na.includes('Nothing to upload right now — your case officer confirmed these documents are not needed.'));
});
