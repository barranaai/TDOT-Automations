const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const ACCESS_TOKEN_COL = 'text_mm0x6haq';

function generateToken(itemId) {
  const now = new Date();
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const dd  = String(now.getDate()).padStart(2, '0');
  return `TDOT-${itemId}-${mm}${dd}`;
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

    const token = generateToken(itemId);

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
  } catch (err) {
    console.error(`[AccessToken] Error assigning token to item ${itemId}:`, err.message);
  }
}

module.exports = { onItemCreated };
