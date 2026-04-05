const crypto    = require('crypto');
const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const ACCESS_TOKEN_COL = 'text_mm0x6haq';

/**
 * Generate a cryptographically secure access token.
 * Format: TDOT-<32 random hex chars>
 * Previous format (TDOT-{itemId}-{MMDD}) is still valid for existing items
 * because validation always compares stored vs. provided value.
 */
function generateToken() {
  return `TDOT-${crypto.randomBytes(16).toString('hex')}`;
}

async function assignToken(itemId) {
  const token = generateToken();

  await mondayApi.query(
    `mutation($itemId: ID!, $boardId: ID!, $value: JSON!) {
       change_column_value(
         item_id:   $itemId,
         board_id:  $boardId,
         column_id: "${ACCESS_TOKEN_COL}",
         value:     $value
       ) { id }
     }`,
    {
      itemId:  String(itemId),
      boardId: String(clientMasterBoardId),
      value:   JSON.stringify(token),
    }
  );

  console.log(`[AccessToken] Assigned ${token} to item ${itemId}`);
  return token;
}

async function onItemCreated({ itemId }) {
  try {
    // Check if a token was already set (e.g. manual entry or duplicate trigger)
    const data = await mondayApi.query(
      `query($itemId: ID!) {
         items(ids: [$itemId]) {
           column_values(ids: ["${ACCESS_TOKEN_COL}"]) { text }
         }
       }`,
      { itemId: String(itemId) }
    );

    const existing = (data.items[0]?.column_values[0]?.text || '').trim();
    if (existing) {
      console.log(`[AccessToken] Item ${itemId} already has token "${existing}", skipping`);
      return;
    }

    await assignToken(itemId);
  } catch (err) {
    console.error(`[AccessToken] Error assigning token to item ${itemId}:`, err.message);
  }
}

/**
 * Return the existing access token for an item, or generate and store a new one
 * if none exists.  Use this as a safe fallback wherever a token is required.
 *
 * @param {string|number} itemId
 * @returns {Promise<string>} The token (always non-empty on success)
 */
async function ensureAccessToken(itemId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: ["${ACCESS_TOKEN_COL}"]) { text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const existing = (data.items?.[0]?.column_values?.[0]?.text || '').trim();
  if (existing) return existing;

  console.warn(`[AccessToken] Token missing for item ${itemId} — generating fallback token`);
  return assignToken(itemId);
}

module.exports = { onItemCreated, ensureAccessToken };
