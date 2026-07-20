'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const checklistService = require('../src/services/checklistService');
const mondayApi        = require('../src/services/mondayApi');

const { markQuestionnaireApplied } = checklistService._internal;
function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('markQuestionnaireApplied: sets "Yes" when the case type has a questionnaire form', async () => {
  let wrote = null;
  const restore = stub(mondayApi, 'query', async (q, vars) => { wrote = vars; return {}; });
  try {
    await markQuestionnaireApplied({ itemId: '123', caseType: 'Citizenship', caseSubType: '' });
    assert.ok(wrote, 'a column write happened');
    assert.match(wrote.colValues, /color_mm0x3tpw/, 'writes the Questionnaire Template Applied column');
    assert.match(wrote.colValues, /"label":"Yes"/, 'sets it to Yes');
    assert.equal(wrote.itemId, '123');
  } finally { restore(); }
});

test('markQuestionnaireApplied: no-op when the case type has NO questionnaire form', async () => {
  let called = false;
  const restore = stub(mondayApi, 'query', async () => { called = true; return {}; });
  try {
    // Renunciation of PR has a checklist but no questionnaire (Q = N/A in the master mapping)
    await markQuestionnaireApplied({ itemId: '123', caseType: 'Renunciation of PR', caseSubType: '' });
    assert.equal(called, false, 'no write for a case type with no questionnaire → column stays as-is');
  } finally { restore(); }
});

test('markQuestionnaireApplied: never throws (best-effort) on a Monday failure', async () => {
  const restore = stub(mondayApi, 'query', async () => { throw new Error('monday 500'); });
  try {
    await markQuestionnaireApplied({ itemId: '123', caseType: 'Citizenship', caseSubType: '' }); // must not throw
  } finally { restore(); }
});
