'use strict';

/**
 * Per-lead async mutex — serializes flows that mutate the SAME lead's
 * e-sign/retainer/payment state from different entry points in this process
 * (the Documenso webhook capture, void-&-reissue, Mark paid, Undo mark paid,
 * and the two places that can start onboarding: advanceCaseToPaid and the
 * status sync's upgrade to "Paid").
 *
 * Single-instance semantics by design: the codebase's in-flight collapse maps
 * (_agreementInFlight, _sendInFlight, _dcsInFlight) already assume one Render
 * instance; this follows the same model. Not a cross-process lock.
 *
 * RE-ENTRANT for the chain of work that holds it. Mark paid holds the lock and,
 * deep inside, reaches advanceCaseToPaid and the status sync — which take the
 * same lock so they serialise with an undo. Without re-entrancy that nesting
 * would deadlock every Mark paid on the lead. The holder is tracked with
 * AsyncLocalStorage and a token that is switched OFF on release: work that was
 * started inside the section but runs after it (a fire-and-forget promise)
 * sees the dead token and queues like anyone else — re-entrancy never outlives
 * the section. Nested locked work that ENTERED while the holder was live is
 * recorded on the token, and the section does not release until all of it
 * has settled — so a nested writer the holder forgot to await can never run
 * alongside the next holder.
 *
 * Nothing bounds how long a holder keeps the lock (the e-sign capture holds
 * it across a Documenso download and a OneDrive upload — both bounded by
 * their own timeouts). A hold past HOLD_WARN_MS is logged once so a stuck
 * lead is visible instead of silently "busy".
 *
 * Usage: await withLeadLock(leadId, async () => { ...critical section... })
 */

const { AsyncLocalStorage } = require('async_hooks');

const _chains = new Map();            // leadId → promise that resolves when the queue tail releases
const _held = new AsyncLocalStorage(); // store: Map<leadId, { live: boolean, inline: Promise[] }> for the current async chain

/** How long the callers that must not stall (Mark paid, Undo, the 15-minute
 *  sync) wait behind another holder before giving up, changing nothing. */
const LEAD_LOCK_WAIT_MS = 20000;
/** A hold longer than this is logged — one line per section. */
const HOLD_WARN_MS = 60000;
const noop = () => {};

async function withLeadLock(leadId, fn, { holdWarnMs = HOLD_WARN_MS } = {}) {
  const key = String(leadId);
  const outer = _held.getStore();
  const mine = outer && outer.get(key);
  if (mine && mine.live) {             // this chain already holds it — run inline, and the holder waits for it
    let p;
    try { p = Promise.resolve(fn()); } catch (err) { p = Promise.reject(err); }
    mine.inline.push(p.then(noop, noop));   // settled only; the error still reaches this caller through p
    return p;
  }

  const prev = _chains.get(key) || Promise.resolve();
  let release;
  const tail = new Promise((r) => { release = r; });
  const entry = prev.then(() => tail);
  _chains.set(key, entry);          // enqueue is synchronous — later callers wait on us
  await prev;                        // wait for everyone ahead of us
  const token = { live: true, inline: [] };
  const store = new Map(outer || []);
  store.set(key, token);
  const since = Date.now();
  const watchdog = setTimeout(() => console.warn(`[LeadMutex] lead ${key} held for ${Math.round((Date.now() - since) / 1000)}s`), holdWarnMs);
  if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
  try {
    return await _held.run(store, () => fn());
  } finally {
    // Nested locked work the section did not await is still the holder's work:
    // wait for it (settled — its errors belong to its own callers) before
    // anyone else can take the lead. Work can enter while we wait, so drain.
    while (token.inline.length) await Promise.all(token.inline.splice(0));
    clearTimeout(watchdog);
    token.live = false;              // detached work from inside the section no longer counts as the holder
    release();
    // If nobody queued behind us the map still holds OUR entry — drop it so
    // the map stays bounded by concurrently-locked leads only.
    if (_chains.get(key) === entry) _chains.delete(key);
  }
}

/**
 * Like withLeadLock, but give up if the lock can't be had within `waitMs`
 * (e.g. an e-signature capture hung on a slow download). Resolves
 * { busy: true } WITHOUT running fn; if fn has started it is always awaited.
 * For callers that must not stall — the 15-minute sync — or that fail closed.
 */
function withLeadLockOrSkip(leadId, waitMs, fn) {
  let started = false;
  let gaveUp = false;
  let timer = null;
  const run = withLeadLock(leadId, () => {
    if (gaveUp) return { busy: true };
    started = true;
    if (timer) clearTimeout(timer);
    return fn();
  });
  if (started) return run;          // re-entrant: fn is already running
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { if (!started) { gaveUp = true; resolve({ busy: true }); } }, waitMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  run.then(() => { if (timer) clearTimeout(timer); }, () => { if (timer) clearTimeout(timer); });
  return Promise.race([run, timeout]);
}

/** True when the current async chain holds the lock for this lead. */
function holdsLeadLock(leadId) {
  const s = _held.getStore();
  const t = s && s.get(String(leadId));
  return !!(t && t.live);
}

module.exports = { withLeadLock, withLeadLockOrSkip, holdsLeadLock, LEAD_LOCK_WAIT_MS, HOLD_WARN_MS };
