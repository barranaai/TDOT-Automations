/**
 * Lead Token Service
 *
 * Generates and validates access tokens for Lead Board items. Mirrors
 * accessTokenService.js but targets the Lead Board instead of Client Master.
 *
 * Token format: LEAD-<32 random hex chars>
 * Stored on the Lead Board in the Lead Token column (text type).
 *
 * Phase 2 uses this same crypto.randomBytes pattern as Phase 1 — NOT JWT.
 */

const crypto    = require('crypto');
const mondayApi = require('./mondayApi');
const { leadBoardId } = require('../../config/monday');

// Column ID for the Lead Token column on the New Leads board.
const LEAD_TOKEN_COL = process.env.MONDAY_LEAD_TOKEN_COL_ID || 'text_mm44pche';

function generateToken() {
  return `LEAD-${crypto.randomBytes(16).toString('hex')}`;
}

async function assignToken(leadId) {
  const token = generateToken();

  await mondayApi.query(
    `mutation($itemId: ID!, $boardId: ID!, $value: JSON!) {
       change_column_value(
         item_id:   $itemId,
         board_id:  $boardId,
         column_id: "${LEAD_TOKEN_COL}",
         value:     $value
       ) { id }
     }`,
    {
      itemId:  String(leadId),
      boardId: String(leadBoardId),
      value:   JSON.stringify(token),
    }
  );

  console.log(`[LeadToken] Assigned ${token} to lead ${leadId}`);
  return token;
}

async function getToken(leadId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: ["${LEAD_TOKEN_COL}"]) { text }
       }
     }`,
    { itemId: String(leadId) }
  );
  return (data.items[0]?.column_values[0]?.text || '').trim();
}

async function validateToken(leadId, providedToken) {
  if (!providedToken) return false;
  const stored = await getToken(leadId);
  return Boolean(stored) && stored === providedToken;
}

/**
 * Return the existing token for a lead, or generate and store a new one.
 */
const _ensuring = new Map();   // leadId → Promise: callers at once share ONE assignment
async function ensureToken(leadId) {
  const key = String(leadId);
  if (_ensuring.has(key)) return _ensuring.get(key);
  const p = (async () => {
    const existing = await getToken(key);
    if (existing) return existing;
    const mine = await assignToken(key);
    // Another writer (a second app instance) may have landed a code at the same moment:
    // the STORED one is what the links are checked against — use it (review 2026-10-16).
    const stored = await getToken(key).catch(() => '');
    return stored || mine;
  })();
  _ensuring.set(key, p);
  try { return await p; } finally { if (_ensuring.get(key) === p) _ensuring.delete(key); }
}

module.exports = { generateToken, assignToken, validateToken, getToken, ensureToken };
