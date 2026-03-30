const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const COLS = {
  paymentDate:              'date_mm0xgk76',
  caseStage:                'color_mm0x8faa',
  stageStartDate:           'date_mm0xjm1z',
  checklistTemplateApplied: 'color_mm0xs7kp',
  questionnaireApplied:     'color_mm0x3tpw',
  automationLock:           'color_mm0x3x1x',
};

async function onRetainerPaid({ itemId }) {
  const today = new Date().toISOString().split('T')[0];

  const colValues = JSON.stringify({
    [COLS.paymentDate]:              { date: today },
    [COLS.caseStage]:                { label: 'Document Collection Started' },
    [COLS.stageStartDate]:           { date: today },
    [COLS.checklistTemplateApplied]: { label: 'No' },
    [COLS.questionnaireApplied]:     { label: 'No' },
    [COLS.automationLock]:           { label: 'No' },
  });

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(
         board_id:      $boardId,
         item_id:       $itemId,
         column_values: $colValues
       ) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(itemId),
      colValues,
    }
  );

  console.log(`[Retainer] Payment confirmed for item ${itemId} — stage set to Document Collection Started`);
}

module.exports = { onRetainerPaid };
