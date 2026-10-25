'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const mondayApi = require('../src/services/mondayApi');
const docSvc    = require('../src/services/documentFormService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// Column IDs mirrored from documentFormService (the reader under test).
const EXEC_APPLICANT_TYPE_COL = 'text_mm26jcv7';
const INTAKE_ID_COL           = 'text_mm0zfsp1';
const DOC_STATUS_COL          = 'color_mm0zwgvr';
const CATEGORY_TEXT_COL       = 'text_mm261tka';
const TMPL_APPLICANT_TYPE_COL = 'dropdown_mm261bn6';

function execItem(id, name, cols) {
  return { id, name, column_values: Object.entries(cols).map(([k, v]) => ({ id: k, text: v })) };
}

test('getCaseDocuments: schema-seeded item (no Template link) reads applicantType from its own execution column', async () => {
  const restore = stub(mondayApi, 'query', async (q) => {
    if (q.includes('items_page_by_column_values')) {
      return { items_page_by_column_values: { items: [
        // schema-seeded: no intakeId, member type lives on the exec row
        execItem('1', 'Passport with all stamped pages', {
          [INTAKE_ID_COL]: '', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Identity',
          [EXEC_APPLICANT_TYPE_COL]: 'Spouse',
        }),
        execItem('2', 'Passport with all stamped pages', {
          [INTAKE_ID_COL]: '', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Identity',
          [EXEC_APPLICANT_TYPE_COL]: 'Dependent Child',
        }),
        // no member info anywhere → legitimate default
        execItem('3', 'Birth Certificate', {
          [INTAKE_ID_COL]: '', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Identity',
          [EXEC_APPLICANT_TYPE_COL]: '',
        }),
      ] } };
    }
    // no intakeIds → template query should not even run, but be safe
    return { items: [] };
  });
  try {
    const docs = await docSvc.getCaseDocuments('2026-CEC-EE-021');
    const byId = Object.fromEntries(docs.map((d) => [d.id, d.applicantType]));
    assert.equal(byId['1'], 'Spouse', 'per-member type read from the execution column, not defaulted');
    assert.equal(byId['2'], 'Dependent Child');
    assert.equal(byId['3'], 'Principal Applicant', 'genuinely-unlabelled item still defaults');
  } finally { restore(); }
});

test('normApplicantType: schema role labels canonicalise to the manifest member types (filter must not hide real members)', () => {
  const n = docSvc.normApplicantType;
  // The exact live mismatch that was hiding spouse/child docs on CEC-EE-021.
  assert.equal(n('Spouse'), n('Spouse / Common-Law Partner'), 'schema "Spouse" matches manifest "Spouse / Common-Law Partner"');
  assert.equal(n('Dependent Child 1'), n('Dependent Child'), 'indexed child matches un-indexed manifest type');
  assert.equal(n('Dependent Child 2'), n('Dependent Child'));
  assert.equal(n('Principal Applicant'), n('Principal Applicant'));
  assert.equal(n('Sponsor'), n('Sponsor'));
  // A genuinely different role must NOT collide (phantom docs still filtered).
  assert.notEqual(n('Spouse'), n('Sponsor'));
  assert.notEqual(n('Dependent Child'), n('Principal Applicant'));
});

test('manifest allow-set (normalised) shows real members and hides phantom ones', () => {
  const n = docSvc.normApplicantType;
  const allowed = new Set(['Principal Applicant', 'Sponsor', 'Spouse / Common-Law Partner', 'Dependent Child'].map(n));
  const shown = (t) => allowed.has(n(t));
  // real members' schema-labelled docs are shown
  assert.ok(shown('Spouse') && shown('Dependent Child 1') && shown('Dependent Child 2') && shown('Principal Applicant'));
  // phantom member (spouse doc on a single-applicant case) is hidden
  const singleAllowed = new Set(['Principal Applicant', 'Sponsor'].map(n));
  assert.ok(!singleAllowed.has(n('Spouse')), 'phantom spouse doc hidden when no spouse member');
});

test('getCaseDocuments: Template-linked item still wins from the Template row (no regression)', async () => {
  const restore = stub(mondayApi, 'query', async (q) => {
    if (q.includes('items_page_by_column_values')) {
      return { items_page_by_column_values: { items: [
        execItem('9', 'Sponsor income proof', {
          [INTAKE_ID_COL]: 'T100', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Financial',
          [EXEC_APPLICANT_TYPE_COL]: 'Principal Applicant', // stale on exec row
        }),
      ] } };
    }
    // template lookup by intakeId
    return { items: [ { id: 'T100', column_values: [{ id: TMPL_APPLICANT_TYPE_COL, text: 'Sponsor' }] } ] };
  });
  try {
    const docs = await docSvc.getCaseDocuments('2026-OSS-005');
    assert.equal(docs[0].applicantType, 'Sponsor', 'template applicantType takes precedence for legacy template-linked items');
  } finally { restore(); }
});

test('getCaseSummary: on a Super Visa every row without a schema role — Template-linked or typed on the exec row — is shown as "Second parent" / "First parent (principal applicant)"; any other case type, and a failed case-type read, show what they always did', async () => {
  const htmlQ = require('../src/services/htmlQuestionnaireService');
  const rows = () => [
    execItem('1', 'Passport', { [INTAKE_ID_COL]: '18401700001', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Identity', [EXEC_APPLICANT_TYPE_COL]: '' }),            // Template-linked
    execItem('2', 'Passport', { [INTAKE_ID_COL]: '', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Identity', [EXEC_APPLICANT_TYPE_COL]: 'Spouse' }),                 // typed on the exec row
    execItem('3', 'Passport', { [INTAKE_ID_COL]: '', [DOC_STATUS_COL]: 'Missing', [CATEGORY_TEXT_COL]: 'Identity', [EXEC_APPLICANT_TYPE_COL]: 'Principal Applicant' }),
  ];
  const stubFor = (caseType, subType, { typeFails = false } = {}) => {
    const r1 = stub(mondayApi, 'query', async (q) => {
      if (q.includes('dropdown_mm0xd1qn')) {   // the case type + sub type
        if (typeFails) throw new Error('Monday 500');
        return { items_page_by_column_values: { items: [{ column_values: [{ id: 'dropdown_mm0xd1qn', text: caseType }, { id: 'dropdown_mm0x4t91', text: subType }] }] } };
      }
      if (q.includes('items { name }')) return { items_page_by_column_values: { items: [{ name: 'Test Client' }] } };
      if (q.includes('items_page_by_column_values')) return { items_page_by_column_values: { items: rows() } };
      return { items: [{ id: '18401700001', column_values: [{ id: TMPL_APPLICANT_TYPE_COL, text: 'Spouse / Common-Law Partner' }, { id: 'dropdown_mm0x41zm', text: 'Identity' }] }] };   // the Template row
    });
    const r2 = stub(htmlQ, 'loadMembers', async () => [{ key: 'primary', type: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner' }]);
    return () => { r1(); r2(); };
  };
  const labels = async () => { const s = await docSvc.getCaseSummary('2026-SV-004'); return Object.fromEntries(s.items.map((d) => [d.id, [d.applicantType, d.applicantLabel, d.templateRow]])); };
  let restore = stubFor('Supervisa', 'Parents');
  try {
    assert.deepEqual(await labels(), { 1: ['Spouse / Common-Law Partner', 'Second parent', true], 2: ['Spouse', 'Second parent', true], 3: ['Principal Applicant', 'First parent (principal applicant)', true] });
  } finally { restore(); }
  restore = stubFor('Super Visa', 'Grandparents');
  try { assert.equal((await labels())['1'][1], 'Second grandparent'); } finally { restore(); }
  restore = stubFor('BOWP', '');
  try {
    assert.deepEqual(await labels(), { 1: ['Spouse / Common-Law Partner', 'Spouse / Common-Law Partner', true], 2: ['Spouse', 'Spouse', true], 3: ['Principal Applicant', 'Principal Applicant', true] }, 'any other case type: the row\'s own type, as always');
  } finally { restore(); }
  restore = stubFor('Supervisa', 'Parents', { typeFails: true });
  try {
    const s = await docSvc.getCaseSummary('2026-SV-004');
    assert.equal(s.items.find((d) => d.id === '1').applicantLabel, 'Spouse / Common-Law Partner', 'the case type unreadable: the page still renders, the row as before');
    assert.ok(Array.isArray(s.disclaimer) && s.disclaimer.length, 'with the default disclaimer');
  } finally { restore(); }
});
