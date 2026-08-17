'use strict';

/**
 * Per-lead async mutex — serializes flows that mutate the SAME lead's
 * e-sign/retainer state from different entry points in this process
 * (the Documenso webhook capture vs. staff-triggered void-&-reissue).
 *
 * Single-instance semantics by design: the codebase's in-flight collapse maps
 * (_agreementInFlight, _sendInFlight, _dcsInFlight) already assume one Render
 * instance; this follows the same model. Not a cross-process lock.
 *
 * Usage: await withLeadLock(leadId, async () => { ...critical section... })
 * Reentrancy is NOT supported — never acquire the lock inside a held section.
 */

const _chains = new Map(); // leadId → promise that resolves when the queue tail releases

async function withLeadLock(leadId, fn) {
  const key = String(leadId);
  const prev = _chains.get(key) || Promise.resolve();
  let release;
  const tail = new Promise((r) => { release = r; });
  const entry = prev.then(() => tail);
  _chains.set(key, entry);          // enqueue is synchronous — later callers wait on us
  await prev;                        // wait for everyone ahead of us
  try {
    return await fn();
  } finally {
    release();
    // If nobody queued behind us the map still holds OUR entry — drop it so
    // the map stays bounded by concurrently-locked leads only.
    if (_chains.get(key) === entry) _chains.delete(key);
  }
}

module.exports = { withLeadLock };
