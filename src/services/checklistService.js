const mondayApi = require('./mondayApi');
const { getTemplateItemsByCaseType } = require('./templateService');
const { createMissingExecutionItems } = require('./executionService');

// Client Master column IDs
const CM_COLS = {
  caseReferenceNumber: 'text_mm142s49',
  primaryCaseType:     'dropdown_mm0xd1qn',
  caseSubType:         'text_mm17vbph',
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
          "${CM_COLS.caseSubType}"
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

  const caseRef      = colMap[CM_COLS.caseReferenceNumber];
  const caseType     = colMap[CM_COLS.primaryCaseType];
  const caseSubType  = colMap[CM_COLS.caseSubType] || null;

  console.log(`[ChecklistService] Item: "${item.name}" | Ref: ${caseRef} | Type: ${caseType} | SubType: ${caseSubType}`);

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

  // 4. Create missing execution items (with duplicate prevention)
  const { created, skipped } = await createMissingExecutionItems({
    caseRef,
    clientMasterItemId: String(itemId),
    templateItems,
  });

  console.log(`[ChecklistService] Done — created: ${created}, skipped (already existed): ${skipped}`);
}

module.exports = { onDocumentCollectionStarted };
