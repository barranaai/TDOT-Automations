require('dotenv').config();

module.exports = {
  apiKey: process.env.MONDAY_API_KEY,
  apiUrl: 'https://api.monday.com/v2',
  clientMasterBoardId: process.env.MONDAY_CLIENT_MASTER_BOARD_ID,
};
