'use strict';

// Ship review (2026-09-25), finding 24: the undo takes the lead lock in its
// give-up flavour. The execute tests stub io, so the seam itself — that
// io.withLeadLockOrSkip really is leadMutex.withLeadLockOrSkip, budget and all —
// is pinned here against the real lock.

const test   = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/services/paymentUndoService');
const { withLeadLock } = require('../src/services/leadMutex');

test('io.withLeadLockOrSkip: behind a holder it answers { busy: true } once the budget is spent, without running; on a free lead it runs at once', async () => {
  const keepAlive = setTimeout(() => {}, 5000);   // the lock's own timers are unref'd — keep the loop alive while the holder sits
  try {
    let release;
    const holder = withLeadLock('UNDO-SEAM', () => new Promise((r) => { release = r; }));
    await new Promise((r) => setImmediate(r));   // the holder has the lead
    let ran = 0;
    const busy = await U.io.withLeadLockOrSkip('UNDO-SEAM', 10, async () => { ran++; return 'ran'; });
    assert.deepEqual(busy, { busy: true });
    assert.equal(ran, 0, 'the section never started');
    release();
    await holder;
    assert.equal(await U.io.withLeadLockOrSkip('UNDO-SEAM', 10, async () => { ran++; return 'ran'; }), 'ran');
    assert.equal(ran, 1);
  } finally { clearTimeout(keepAlive); }
});
