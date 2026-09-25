'use strict';

// Per-lead mutex: capture-vs-reissue serialization (same process, same lead).

const test   = require('node:test');
const assert = require('node:assert/strict');
const { withLeadLock, withLeadLockOrSkip, holdsLeadLock, LEAD_LOCK_WAIT_MS, HOLD_WARN_MS } = require('../src/services/leadMutex');

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

// ─── Ship review (2026-09-25): the hold is visible, nested work is waited for ─

test('one shared give-up budget for the callers that must not stall', () => {
  assert.equal(LEAD_LOCK_WAIT_MS, 20000);
  assert.equal(HOLD_WARN_MS, 60000);
});

test('WATCHDOG: a section that holds a lead past the threshold is logged once, naming the lead and the seconds; the timer is cleared on release', async () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await withLeadLock('W1', () => sleep(60), { holdWarnMs: 15 });
    assert.equal(warned.length, 1, 'exactly one line');
    assert.match(warned[0], /^\[LeadMutex\] lead W1 held for \d+s$/);
    await sleep(40);
    assert.equal(warned.length, 1, 'it does not fire again after release');
    // a short section never logs — and its timer does not fire later either
    await withLeadLock('W2', () => sleep(5), { holdWarnMs: 20 });
    await sleep(40);
    assert.equal(warned.length, 1);
  } finally { console.warn = orig; }
});

test('the watchdog timer never holds the process open (unref) and defaults to the exported threshold', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/leadMutex'), 'utf8');
  assert.match(src, /const watchdog = setTimeout\(\(\) => console\.warn\(`\[LeadMutex\] lead \$\{key\} held for \$\{[^`]+\}s`\), holdWarnMs\);/);
  assert.match(src, /if \(watchdog && typeof watchdog\.unref === 'function'\) watchdog\.unref\(\);/);
  assert.match(src, /\{ holdWarnMs = HOLD_WARN_MS \} = \{\}/);
  assert.match(src, /clearTimeout\(watchdog\);/);
});

test('NESTED WORK NOT AWAITED: the section does not release until locked work that entered inside it has finished — the next holder waits', async () => {
  const order = [];
  const outer = withLeadLock('N1', async () => {
    order.push('outer');
    withLeadLock('N1', async () => { await sleep(30); order.push('inner-end'); });   // forgotten await
    order.push('outer-end');
  });
  const next = withLeadLock('N1', async () => { order.push('next'); });
  await Promise.all([outer, next]);
  assert.deepEqual(order, ['outer', 'outer-end', 'inner-end', 'next']);
});

test('nested work that itself starts more nested work is drained too, and a nested failure belongs to its own caller — the outer still succeeds', async () => {
  const order = [];
  let innerFailure = null;
  const outer = withLeadLock('N2', async () => {
    withLeadLock('N2', async () => {
      await sleep(10);
      withLeadLock('N2', async () => { await sleep(20); order.push('grandchild-end'); });   // entered while the outer waits
      order.push('child-end');
    });
    const failing = withLeadLock('N2', async () => { await sleep(5); throw new Error('nested boom'); });
    failing.catch((e) => { innerFailure = e; });
    return 'outer-ok';
  });
  const next = withLeadLock('N2', async () => { order.push('next'); });
  assert.equal(await outer, 'outer-ok', 'a nested failure never fails the outer section');
  await next;
  assert.deepEqual(order, ['child-end', 'grandchild-end', 'next']);
  assert.match(String(innerFailure && innerFailure.message), /nested boom/, 'the error reached the nested caller');
});

test('withLeadLockOrSkip nested in the holder is tracked the same way', async () => {
  const order = [];
  const outer = withLeadLock('N3', async () => {
    withLeadLockOrSkip('N3', 10, async () => { await sleep(25); order.push('skip-inner-end'); });   // forgotten await
  });
  const next = withLeadLock('N3', async () => { order.push('next'); });
  await Promise.all([outer, next]);
  assert.deepEqual(order, ['skip-inner-end', 'next']);
});
