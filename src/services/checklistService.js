const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const { getTemplateItemsByCaseType } = require('./templateService');
const { createMissingExecutionItems } = require('./executionService');
const { createClientFolders } = require('./oneDriveService');

// Client Master column IDs
const CM_COLS = {
  caseReferenceNumber:     'text_mm142s49',
  primaryCaseType:         'dropdown_mm0xd1qn',
  caseSubType:             'text_mm17vbph',
  checklistTemplateApplied:'color_mm0xs7kp',
};

/**
 * Triggered automatically when an item's Case Stage changes to
 * "Document Collection Started" on the Client Master board.
 *
 * @param {{ itemId: string|number, boardId: string|number }} param
 */
async function onDocumentCollectionStarted({ itemId, boardId }) {
  console.log(`[ChecklistService] Triggered for item ${itemId} on board ${boardId}`);

  // 1. Fetch the Client Master item
  const data = await mondayApi.query(
    `query getItem($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values(ids: [
          "${CM_COLS.caseReferenceNumber}",
          "${CM_COLS.primaryCaseType}",
          "${CM_COLS.caseSubType}",
          "${CM_COLS.checklistTemplateApplied}"
        ]) {
          id
          text
        }
      }
    }`,
    { itemId: String(itemId) }
  );

  const item = data?.items?.[0];
  if (!item) {
    console.warn(`[ChecklistService] Item ${itemId} not found`);
    return;
  }

  // 2. Extract key fields
  const colMap = {};
  for (const col of item.column_values) {
    colMap[col.id] = col.text;
  }

  const caseRef           = (colMap[CM_COLS.caseReferenceNumber] || '').replace(/\s+/g, ' ').trim();
  const caseType          = (colMap[CM_COLS.primaryCaseType] || '').trim();
  const caseSubType       = (colMap[CM_COLS.caseSubType] || '').trim() || null;
  const checklistApplied  = (colMap[CM_COLS.checklistTemplateApplied] || '').trim();

  console.log(`[ChecklistService] Item: "${item.name}" | Ref: ${caseRef} | Type: ${caseType} | SubType: ${caseSubType} | Checklist Applied: ${checklistApplied}`);

  // Guard: skip if checklist was already applied
  if (checklistApplied.toLowerCase() === 'yes') {
    console.log(`[ChecklistService] Checklist already applied for ${caseRef}. Skipping.`);
    return;
  }

  if (!caseRef) {
    console.warn(`[ChecklistService] No Case Reference Number found for item ${itemId}. Skipping.`);
    return;
  }

  if (!caseType) {
    console.warn(`[ChecklistService] No Primary Case Type found for item ${itemId}. Skipping.`);
    return;
  }

  // 3. Fetch matching template items
  let templateItems;
  try {
    templateItems = await getTemplateItemsByCaseType(caseType, caseSubType);
    console.log(`[ChecklistService] Found ${templateItems.length} template items for "${caseType}"`);
  } catch (err) {
    console.error(`[ChecklistService] Template lookup failed: ${err.message}`);
    return;
  }

  if (!templateItems.length) {
    console.warn(`[ChecklistService] No template items found for case type "${caseType}". Nothing to create.`);
    return;
  }

  // 4. Create OneDrive category folders and get sharing links
  const uniqueCategories = [...new Set(
    templateItems.map(t => t.documentCategory).filter(Boolean)
  )];

  let categoryLinks = {};
  if (uniqueCategories.length) {
    try {
      categoryLinks = await createClientFolders({
        clientName: item.name,
        caseRef,
        categories: uniqueCategories,
      });
      console.log(`[ChecklistService] OneDrive folders created for ${Object.keys(categoryLinks).length} categories`);
    } catch (err) {
      console.warn(`[ChecklistService] OneDrive folder creation failed — continuing without folder links:`, err.message);
    }
  }

  // 5. Create missing execution items (with duplicate prevention)
  const { created, skipped } = await createMissingExecutionItems({
    caseRef,
    clientMasterItemId: String(itemId),
    templateItems,
    categoryLinks,
  });

  console.log(`[ChecklistService] Done — created: ${created}, skipped (already existed): ${skipped}`);

  // Mark checklist template as applied so this cannot run again for the same case
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(itemId),
      colValues: JSON.stringify({ [CM_COLS.checklistTemplateApplied]: { label: 'Yes' } }),
    }
  );
  console.log(`[ChecklistService] Checklist Template Applied → Yes for ${caseRef}`);
}

module.exports = { onDocumentCollectionStarted };
