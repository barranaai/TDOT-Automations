'use strict';

// Per-lead mutex: capture-vs-reissue serialization (same process, same lead).

const test   = require('node:test');
const assert = require('node:assert/strict');
const { withLeadLock, withLeadLockOrSkip, holdsLeadLock } = require('../src/services/leadMutex');

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

// ─── Added with "Undo mark paid": re-entrancy and the wait budget ────────────

test('RE-ENTRANT: a section that reaches another locked writer for the SAME lead runs it inline — no deadlock', async () => {
  const order = [];
  await withLeadLock('R1', async () => {
    order.push('outer');
    await withLeadLock('R1', async () => { order.push('inner'); });   // e.g. recordRetainerPaid → advanceCaseToPaid
    order.push('outer-end');
  });
  assert.deepEqual(order, ['outer', 'inner', 'outer-end']);
});

test('re-entrancy is only for the holder: another caller still waits its turn', async () => {
  const order = [];
  let release;
  const a = withLeadLock('R2', () => new Promise((r) => { order.push('a'); release = r; }));
  const b = withLeadLock('R2', async () => { order.push('b'); });
  await sleep(15);
  assert.deepEqual(order, ['a'], 'b waits while a holds the lock');
  release(); await a; await b;
  assert.deepEqual(order, ['a', 'b']);
});

test('work left running after the section returns is NOT treated as the holder', async () => {
  let detached;
  await withLeadLock('R3', async () => { detached = (async () => { await sleep(10); return holdsLeadLock('R3'); })(); });
  assert.equal(await detached, false, 'the lock was released — a stray promise must queue like anyone else');
});

test('withLeadLockOrSkip: runs when free, gives up (and never runs later) when the lock stays held', async () => {
  assert.equal(await withLeadLockOrSkip('S1', 50, async () => 7), 7);
  let ran = false;
  // The holder frees the lock at 80 ms (a real timer, so the event loop stays
  // alive — the give-up timer is unref'd on purpose and would not).
  const held = withLeadLock('S2', () => sleep(80));
  const r = await withLeadLockOrSkip('S2', 20, async () => { ran = true; });
  assert.deepEqual(r, { busy: true });
  await held; await sleep(5);
  assert.equal(ran, false, 'a skipped section must not run once the lock frees up');
});

test('withLeadLockOrSkip inside the holder runs at once — never "busy" against itself', async () => {
  const r = await withLeadLock('S3', () => withLeadLockOrSkip('S3', 10, async () => 'inline'));
  assert.equal(r, 'inline');
});
