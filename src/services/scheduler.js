const cron        = require('node-cron');
const slaRiskEngine = require('./slaRiskEngine');

/**
 * Schedules all recurring background jobs.
 * Called once from server.js on startup.
 */
function startScheduler() {
  // ── SLA & Risk Engine — runs every day at 07:00 server time ─────────────────
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] Triggering daily SLA & Risk Engine…');
    try {
      await slaRiskEngine.runDailyCheck();
    } catch (err) {
      console.error('[Scheduler] SLA & Risk Engine failed:', err.message);
    }
  });

  console.log('[Scheduler] Jobs registered — SLA & Risk Engine runs daily at 07:00');
}

module.exports = { startScheduler };
