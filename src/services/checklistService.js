const mondayApi = require('./mondayApi');
const extractColumnValue = require('../utils/extractColumnValue');

async function handleEvent(event) {
  const { type, pulseId, boardId, columnId } = event;

  console.log(`Event received — type: ${type}, item: ${pulseId}, board: ${boardId}`);

  // TODO: implement checklist automation logic
}

module.exports = { handleEvent };
