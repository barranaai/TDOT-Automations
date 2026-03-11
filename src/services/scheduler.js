const cron                  = require('node-cron');
const caseReadinessService  = require('./caseReadinessService');
const slaRiskEngine         = require('./slaRiskEngine');
const expiryRiskEngine      = require('./expiryRiskEngine');
const chasingLoopService    = require('./chasingLoopService');

/**
 * Schedules all recurring background jobs.
 * Called once from server.js on startup.
 *
 * Daily sequence at 07:00:
 *   1. Case Readiness Engine — calculates Q+Doc readiness, writes to master,
 *                              triggers stage gates (Internal Review / Submission Prep)
 *   2. SLA & Risk Engine     — uses fresh readiness values to compute Risk Band,
 *                              Health Status, Days Elapsed, Expiry Flag.
 *                              Forces Risk Band to Orange/Red when expiry is flagged.
 *   3. Expiry Risk Engine    — detects new/escalating expiry flags, sets
 *                              Escalation Required, sends alert emails to supervisor
 *   4. Chasing Loop          — sends reminder emails based on SLA offsets
 */
function startScheduler() {
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] ── Daily jobs starting ──');

    // Step 1 — Case Readiness Engine (must run first, feeds SLA engine)
    try {
      await caseReadinessService.runDailyReadinessCheck();
    } catch (err) {
      console.error('[Scheduler] Case Readiness Engine failed:', err.message);
    }

    // Step 2 — SLA & Risk Engine (sets risk band, factors in expiry)
    try {
      await slaRiskEngine.runDailyCheck();
    } catch (err) {
      console.error('[Scheduler] SLA & Risk Engine failed:', err.message);
    }

    // Step 3 — Expiry Risk Engine (escalation + notifications for expiry flags)
    try {
      await expiryRiskEngine.runExpiryCheck();
    } catch (err) {
      console.error('[Scheduler] Expiry Risk Engine failed:', err.message);
    }

    // Step 4 — Client Chasing Loop
    try {
      await chasingLoopService.runChasingLoop();
    } catch (err) {
      console.error('[Scheduler] Chasing Loop failed:', err.message);
    }

    console.log('[Scheduler] ── Daily jobs complete ──');
  });

  console.log('[Scheduler] Jobs registered — Readiness → SLA → Expiry → Chasing run daily at 07:00');
}

module.exports = { startScheduler };
