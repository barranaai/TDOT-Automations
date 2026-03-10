const cron              = require('node-cron');
const slaRiskEngine     = require('./slaRiskEngine');
const chasingLoopService = require('./chasingLoopService');

/**
 * Schedules all recurring background jobs.
 * Called once from server.js on startup.
 *
 * Daily sequence at 07:00:
 *   1. SLA & Risk Engine — updates Days Elapsed, Risk Band, Health Status, Expiry Flag
 *   2. Chasing Loop      — sends reminder emails based on SLA offsets
 */
function startScheduler() {
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] ── Daily jobs starting ──');

    // Step 1 — SLA & Risk Engine (must run first so Days Elapsed is fresh)
    try {
      await slaRiskEngine.runDailyCheck();
    } catch (err) {
      console.error('[Scheduler] SLA & Risk Engine failed:', err.message);
    }

    // Step 2 — Client Chasing Loop
    try {
      await chasingLoopService.runChasingLoop();
    } catch (err) {
      console.error('[Scheduler] Chasing Loop failed:', err.message);
    }

    console.log('[Scheduler] ── Daily jobs complete ──');
  });

  console.log('[Scheduler] Jobs registered — SLA + Chasing Loop run daily at 07:00');
}

module.exports = { startScheduler };
