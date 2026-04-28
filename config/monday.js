require('dotenv').config();

// ─── Startup validation ─────────────────────────────────────────────────────
// Fail fast if critical environment variables are missing.
// Better to crash at startup than fail silently in production.

const REQUIRED_VARS = [
  'MONDAY_API_KEY',
  'MONDAY_CLIENT_MASTER_BOARD_ID',
  'MONDAY_TEMPLATE_BOARD_ID',
  'MONDAY_EXECUTION_BOARD_ID',
  'MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID',
  'MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID',
];

const OPTIONAL_VARS = [
  'MONDAY_SLA_CONFIG_BOARD_ID',
  'MONDAY_ESCALATION_MATRIX_BOARD_ID',
  'MS_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'MS_TENANT_ID',
  'MS_FROM_EMAIL',
  'RENDER_URL',
  'ADMIN_API_KEY',
];

const missing = REQUIRED_VARS.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing required environment variables:\n${missing.map(k => `   - ${k}`).join('\n')}\n`);
  console.error('Set these in your .env file or Render environment settings.\n');
  process.exit(1);
}

const missingOptional = OPTIONAL_VARS.filter(k => !process.env[k]);
if (missingOptional.length) {
  console.warn(`⚠️  Optional env vars not set (some features may be limited): ${missingOptional.join(', ')}`);
}

// ─── Export config ───────────────────────────────────────────────────────────

module.exports = {
  apiKey: process.env.MONDAY_API_KEY,
  apiUrl: 'https://api.monday.com/v2',
  clientMasterBoardId:           process.env.MONDAY_CLIENT_MASTER_BOARD_ID,
  templateBoardId:               process.env.MONDAY_TEMPLATE_BOARD_ID,
  executionBoardId:              process.env.MONDAY_EXECUTION_BOARD_ID,
  questionnaireTemplateBoardId:  process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID,
  questionnaireExecutionBoardId: process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID,
  slaConfigBoardId:              process.env.MONDAY_SLA_CONFIG_BOARD_ID,
  escalationMatrixBoardId:       process.env.MONDAY_ESCALATION_MATRIX_BOARD_ID,

  // Client Master Board column IDs (referenced across services).
  // Stored here so a column-ID drift only needs one update.
  cmColumns: {
    portalLink: 'link_mm2vta5',  // 🏠 Client Portal — created 2026-04-24, populated by caseRefService
  },
};
