'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc       = require('../src/services/documentReviewFormService');
const mondayApi = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('reopenDoc: reverts a document to "Received" (and touches nothing else → no client email)', async () => {
  let vars = null;
  const restore = stub(mondayApi, 'query', async (q, v) => { vars = v; return {}; });
  try {
    await svc.reopenDoc('9001');
    assert.ok(vars, 'a Monday write happened');
    assert.equal(vars.itemId, '9001');
    const cols = JSON.parse(vars.cols);
    // Only the document-status column is written, set to Received.
    assert.deepEqual(Object.values(cols), [{ label: 'Received' }], 'sets status → Received');
    assert.ok(!/Rework|Reviewed/.test(vars.cols), 'does not set a review note or rework/reviewed status');
  } finally { restore(); }
});
