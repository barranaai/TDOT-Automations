'use strict';

// Consultations dashboard order (team feedback 2026-08-13): the MOST RECENT
// booked slot sits on top — staff were scrolling to the bottom for this
// week's consultations. Blank slots stay last.

const test   = require('node:test');
const assert = require('node:assert/strict');

const mondayApi = require('../src/services/mondayApi');
const svc       = require('../src/services/consultantPortalService');
const C         = require('../src/data/newLeadsBoard.json').columns;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const row = (id, slot) => ({ id, name: `Lead ${id}`, column_values: slot ? [{ id: C.bookedSlot, text: slot }] : [] });

test('getConsultationQueue: newest slot first, blanks last', async () => {
  const restore = stub(mondayApi, 'query', async () => ({
    items_page_by_column_values: { cursor: null, items: [
      row('1', '2026-06-01 10:00'),
      row('2', ''),
      row('3', '2026-08-12 09:00'),
      row('4', '2026-08-14 15:30'),
    ] },
  }));
  try {
    const items = await svc.getConsultationQueue();
    assert.deepEqual(items.map((i) => i.id), ['4', '3', '1', '2'],
      'descending by booked slot; the un-slotted row trails');
  } finally { restore(); }
});
