'use strict';

// Per-lead mutex: capture-vs-reissue serialization (same process, same lead).

const test   = require('node:test');
const assert = require('node:assert/strict');
const { withLeadLock } = require('../src/services/leadMutex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('same lead: sections run strictly in order, even when the first is slow', async () => {
  const order = [];
  const a = withLeadLock('L1', async () => { order.push('a-start'); await sleep(40); order.push('a-end'); });
  const b = withLeadLock('L1', async () => { order.push('b'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('different leads run in parallel (no global serialization)', async () => {
  const order = [];
  const a = withLeadLock('L2', async () => { await sleep(40); order.push('slow'); });
  const b = withLeadLock('L3', async () => { order.push('fast'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['fast', 'slow']);
});

test('a throwing section releases the lock (no deadlock) and propagates its error', async () => {
  await assert.rejects(withLeadLock('L4', async () => { throw new Error('boom'); }), /boom/);
  let ran = false;
  await withLeadLock('L4', async () => { ran = true; });
  assert.equal(ran, true);
});

test('return values pass through', async () => {
  assert.equal(await withLeadLock('L5', async () => 42), 42);
});
