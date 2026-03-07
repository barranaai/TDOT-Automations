require('dotenv').config();

module.exports = {
  apiKey: process.env.MONDAY_API_KEY,
  apiUrl: 'https://api.monday.com/v2',
  clientMasterBoardId: process.env.MONDAY_CLIENT_MASTER_BOARD_ID,
  templateBoardId: process.env.MONDAY_TEMPLATE_BOARD_ID,
  executionBoardId: process.env.MONDAY_EXECUTION_BOARD_ID,
};
