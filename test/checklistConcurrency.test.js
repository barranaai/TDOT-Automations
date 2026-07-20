'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const checklistService = require('../src/services/checklistService');
const mondayApi        = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// The real defect: three onboarding triggers call onDocumentCollectionStarted for
// the SAME case in a burst; without an in-flight collapse they all seed, each
// possibly under a different (still-settling) Case Sub Type → duplicate checklist
// rows. This proves concurrent calls collapse to a single execution.
test('onDocumentCollectionStarted: concurrent calls for one case collapse to a single run', async () => {
  let fetches = 0;
  const restore = stub(mondayApi, 'query', async (q) => {
    // The FIRST query in the handler is the Client Master item fetch. Count it +
    // make it slow so the three concurrent calls overlap. Return an item whose
    // checklist is already "Yes" so the handler exits at the guard right after the
    // fetch (no seeding needed for this concurrency assertion).
    if (/items\(ids:/.test(q)) {
      fetches++;
      await new Promise((r) => setTimeout(r, 25));
      return { items: [{ id: '1', name: 'Test', column_values: [
        { id: 'text_mm142s49', text: '2026-X-001' },
        { id: 'color_mm0xs7kp', text: 'Yes' },
      ] }] };
    }
    return {};
  });
  try {
    // Fire three concurrently for the same item id.
    await Promise.all([
      checklistService.onDocumentCollectionStarted({ itemId: '1', boardId: 'b' }),
      checklistService.onDocumentCollectionStarted({ itemId: '1', boardId: 'b' }),
      checklistService.onDocumentCollectionStarted({ itemId: '1', boardId: 'b' }),
    ]);
    assert.equal(fetches, 1, 'three concurrent triggers collapsed to ONE execution (one item fetch)');
  } finally { restore(); }
});

test('onDocumentCollectionStarted: different cases are NOT collapsed together', async () => {
  let fetches = 0;
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/items\(ids:/.test(q)) {
      fetches++;
      await new Promise((r) => setTimeout(r, 15));
      return { items: [{ id: 'x', name: 'T', column_values: [{ id: 'text_mm142s49', text: 'R' }, { id: 'color_mm0xs7kp', text: 'Yes' }] }] };
    }
    return {};
  });
  try {
    await Promise.all([
      checklistService.onDocumentCollectionStarted({ itemId: 'A', boardId: 'b' }),
      checklistService.onDocumentCollectionStarted({ itemId: 'B', boardId: 'b' }),
    ]);
    assert.equal(fetches, 2, 'distinct cases each run once');
  } finally { restore(); }
});
