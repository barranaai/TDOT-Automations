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
  'MONDAY_LEAD_BOARD_ID',                    // ← Phase 2
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
  // ── Phase 2 (each service checks at runtime; absence won't crash Phase 1) ──
  'MONDAY_LEAD_TOKEN_COL_ID',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_WEBHOOK_SECRET',
  'SQUARE_LOCATION_ID',
  'ADOBESIGN_CLIENT_ID',
  'ADOBESIGN_CLIENT_SECRET',
  'ADOBESIGN_RETAINER_TEMPLATE_ID',
  'ZOOM_ACCOUNT_ID',
  'ZOOM_CLIENT_ID',
  'ZOOM_CLIENT_SECRET',
  'ZOOM_WEBHOOK_SECRET_TOKEN',
  'ANTHROPIC_API_KEY',
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
  leadBoardId:                   process.env.MONDAY_LEAD_BOARD_ID,  // ← Phase 2

  // Client Master Board column IDs (referenced across services).
  // Stored here so a column-ID drift only needs one update.
  cmColumns: {
    portalLink:         'link_mm2vta5',  // 🏠 Client Portal — created 2026-04-24, populated by caseRefService
    oneDriveFolderLink: 'link_mm47dng8', // OneDrive Folder — staff-clickable client folder link (carried from Lead Board at handoff)
    oneDriveFolderId:   'text_mm47y540', // OneDrive Folder Id — driveItem id; lets caseRefService rename the intake folder to "{name} - {caseRef}"
    reseedChecklist:    'color_mm47h11c', // Re-seed Checklist button: staff set "Run" → additive re-seed → "Done ✓"/"Failed ⚠"
  },
};
