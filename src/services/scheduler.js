const cron                      = require('node-cron');
const caseReadinessService      = require('./caseReadinessService');
const slaRiskEngine             = require('./slaRiskEngine');
const expiryRiskEngine          = require('./expiryRiskEngine');
const caseHealthEngine          = require('./caseHealthEngine');
const chasingLoopService        = require('./chasingLoopService');
const escalationRoutingService  = require('./escalationRoutingService');

const ENGINE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per engine

/**
 * Run a job with a timeout — prevents a stalled engine from blocking the entire sequence.
 *
 * @param {string}   label    - Engine name for logging
 * @param {Function} fn       - Async function to execute
 * @param {number}   timeout  - Max duration in ms (default 5 min)
 */
function withTimeout(label, fn, timeout = ENGINE_TIMEOUT_MS) {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeout / 1000}s`)), timeout)
    ),
  ]);
}

/**
 * Schedules all recurring background jobs.
 * Called once from server.js on startup.
 *
 * Daily sequence at 07:00:
 *   1. Case Readiness Engine — Q+Doc readiness, writes to master,
 *                              triggers stage gates (Internal Review / Submission Prep)
 *   2. SLA & Risk Engine     — Risk Band, Days Elapsed, Expiry Flag.
 *                              Forces Risk Band to Orange/Red when expiry is close.
 *   3. Expiry Risk Engine    — detects new/escalating expiry flags,
 *                              sets Escalation Required, emails supervisor
 *   4. Case Health Engine    — synthesises all signals into Case Health Status,
 *                              Client Delay Level, Client Responsiveness Score,
 *                              and Client-Blocked Status
 *   5. Escalation Routing    — matches each case to Escalation Routing Matrix rules,
 *                              notifies supervisors/directors, applies stage/SLA actions
 *   6. Chasing Loop          — sends timed reminder emails based on SLA offsets
 */
function startScheduler() {
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] ── Daily jobs starting ──');
    const start = Date.now();

    // Step 1 — Case Readiness Engine (must run first, feeds SLA engine)
    try {
      await withTimeout('Case Readiness Engine', () => caseReadinessService.runDailyReadinessCheck());
    } catch (err) {
      console.error('[Scheduler] Case Readiness Engine failed:', err.message);
    }

    // Step 2 — SLA & Risk Engine (sets risk band, factors in expiry)
    try {
      await withTimeout('SLA & Risk Engine', () => slaRiskEngine.runDailyCheck());
    } catch (err) {
      console.error('[Scheduler] SLA & Risk Engine failed:', err.message);
    }

    // Step 3 — Expiry Risk Engine (escalation + notifications for new expiry flags)
    try {
      await withTimeout('Expiry Risk Engine', () => expiryRiskEngine.runExpiryCheck());
    } catch (err) {
      console.error('[Scheduler] Expiry Risk Engine failed:', err.message);
    }

    // Step 4 — Case Health Engine (full health synthesis across all signals)
    try {
      await withTimeout('Case Health Engine', () => caseHealthEngine.runHealthCheck());
    } catch (err) {
      console.error('[Scheduler] Case Health Engine failed:', err.message);
    }

    // Step 5 — Escalation Routing Engine (applies matrix rules to Orange/Red cases)
    try {
      await withTimeout('Escalation Routing Engine', () => escalationRoutingService.runEscalationRouting());
    } catch (err) {
      console.error('[Scheduler] Escalation Routing Engine failed:', err.message);
    }

    // Step 6 — Client Chasing Loop
    try {
      await withTimeout('Chasing Loop', () => chasingLoopService.runChasingLoop());
    } catch (err) {
      console.error('[Scheduler] Chasing Loop failed:', err.message);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Scheduler] ── Daily jobs complete (${elapsed}s) ──`);
  });

  console.log('[Scheduler] Jobs registered — Readiness → SLA → Expiry → Health → Escalation → Chasing at 07:00');
}

module.exports = { startScheduler };
