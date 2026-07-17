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
