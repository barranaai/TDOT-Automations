'use strict';

// Ship review (2026-09-25), finding 25: a Square ORDER id alone is a payment
// LINK, stamped before any money. Whether money landed is the order's own
// state, read through retrieveOrderState — the undo asks it via io.readSquareOrder.
// The undo tests stub that seam, so the reader itself is pinned here (axios is
// stubbed, as every Square test does; the no-network guard sits beneath it).

const test   = require('node:test');
const assert = require('node:assert/strict');
const axios  = require('axios');
const sq     = require('../src/services/squareInvoicesService');
const U      = require('../src/services/paymentUndoService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('retrieveOrderState: COMPLETED is paid; any tender is paid whatever the state; OPEN with none is unpaid; the id is URL-encoded', async () => {
  const urls = [];
  let answer;
  const restore = stub(axios, 'get', async (url) => { urls.push(url); return { data: answer }; });
  try {
    answer = { order: { state: 'COMPLETED', tenders: [] } };
    assert.deepEqual(await sq.retrieveOrderState('ord/1'), { paid: true, state: 'COMPLETED' });
    assert.match(urls[0], /\/v2\/orders\/ord%2F1$/);
    answer = { order: { state: 'OPEN', tenders: [{ id: 't1' }] } };
    assert.deepEqual(await sq.retrieveOrderState('ord2'), { paid: true, state: 'OPEN' }, 'a tender is money, whatever the state reads');
    answer = { order: { state: 'OPEN', tenders: [] } };
    assert.deepEqual(await sq.retrieveOrderState('ord3'), { paid: false, state: 'OPEN' });
    answer = { order: { state: 'OPEN' } };
    assert.deepEqual(await sq.retrieveOrderState('ord4'), { paid: false, state: 'OPEN' }, 'no tenders field = none');
    answer = {};
    assert.equal(await sq.retrieveOrderState('ord5'), null, 'no order in the answer');
  } finally { restore(); }
});

test('retrieveOrderState: a 404 is null (Square no longer knows the order); anything else THROWS — the caller decides what "could not be checked" means', async () => {
  const r404 = stub(axios, 'get', async () => { const e = new Error('Request failed with status code 404'); e.response = { status: 404 }; throw e; });
  try { assert.equal(await sq.retrieveOrderState('gone'), null); } finally { r404(); }
  const rTimeout = stub(axios, 'get', async () => { const e = new Error('timeout of 30000ms exceeded'); e.code = 'ETIMEDOUT'; throw e; });
  try { await assert.rejects(sq.retrieveOrderState('x'), /timeout/); } finally { rTimeout(); }
  const r500 = stub(axios, 'get', async () => { const e = new Error('Request failed with status code 500'); e.response = { status: 500 }; throw e; });
  try { await assert.rejects(sq.retrieveOrderState('x'), /500/); } finally { r500(); }
});

test('the undo asks Square through retrieveOrderState (io.readSquareOrder), by the order id, and hands back what it says', async () => {
  const asked = [];
  const restore = stub(sq, 'retrieveOrderState', async (id) => { asked.push(id); return { paid: true, state: 'COMPLETED' }; });
  try {
    assert.deepEqual(await U.io.readSquareOrder('ord-9'), { paid: true, state: 'COMPLETED' });
    assert.deepEqual(asked, ['ord-9']);
  } finally { restore(); }
  const rThrow = stub(sq, 'retrieveOrderState', async () => { throw new Error('square down'); });
  try { await assert.rejects(U.io.readSquareOrder('ord-9'), /square down/, 'a failed read reaches readState, which turns it into "could not be checked"'); } finally { rThrow(); }
});
