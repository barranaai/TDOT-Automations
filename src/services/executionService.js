const mondayApi = require('./mondayApi');
const { executionBoardId, clientMasterBoardId, templateBoardId } = require('../../config/monday');

// Execution Board column IDs
const EXEC_COLS = {
  caseReferenceNumber: 'text_mm0z2cck',
  uniqueKey:           'text_mm15dwah',
  documentCode:        'text_mm0zr7tf',
  clientCase:          'board_relation_mm0zwb5',   // connect → Client Master
  clientMasterBoard:   'board_relation_mm0z5p76',  // connect → Client Master
  templateBoard:       'board_relation_mm0zhagw',  // connect → Template Board
  caseSubType:         'text_mm17zdy7',
  intakeItemId:        'text_mm0zfsp1',
  documentFolder:      'link_mm1yrnz1',            // OneDrive category folder URL
};

// The single execution group — rename this in Monday to "Active Cases Execution" if desired
const EXECUTION_GROUP_ID = 'topics';

/**
 * Fetch all Unique Keys already in the Execution Board for a given case reference.
 * Used for duplicate prevention.
 *
 * @param {string} caseRef
 * @returns {Promise<Set<string>>}
 */
async function getExistingUniqueKeys(caseRef) {
  const data = await mondayApi.query(
    `query getExistingItems($boardId: ID!, $colId: String!, $colValue: String!) {
      items_page_by_column_values(
        limit: 500,
        board_id: $boardId,
        columns: [{ column_id: $colId, column_values: [$colValue] }]
      ) {
        items {
          column_values(ids: ["${EXEC_COLS.uniqueKey}"]) {
            id
            text
          }
        }
      }
    }`,
    {
      boardId: String(executionBoardId),
      colId: EXEC_COLS.caseReferenceNumber,
      colValue: caseRef,
    }
  );

  const items = data?.items_page_by_column_values?.items ?? [];
  const keys = new Set();
  for (const item of items) {
    const uk = item.column_values.find((c) => c.id === EXEC_COLS.uniqueKey);
    if (uk?.text) keys.add(uk.text);
  }
  return keys;
}

/**
 * Create a single item in the Execution Board.
 *
 * @param {{
 *   name: string,
 *   caseRef: string,
 *   uniqueKey: string,
 *   documentCode: string,
 *   caseSubType: string,
 *   clientMasterItemId: string,
 *   templateItemId: string,
 *   folderUrl?: string,       - OneDrive category folder sharing URL (optional)
 *   documentCategory?: string - Category label for display text on link
 * }} itemData
 */
async function createExecutionItem(itemData) {
  const {
    name,
    caseRef,
    uniqueKey,
    documentCode,
    caseSubType,
    clientMasterItemId,
    templateItemId,
    folderUrl,
    documentCategory,
  } = itemData;

  // Monday.com silently ignores board_relation columns set inside create_item.
  // Board relations (clientCase, clientMasterBoard, templateBoard) must be set
  // via a separate change_multiple_column_values mutation after creation.
  const createColValues = {
    [EXEC_COLS.caseReferenceNumber]: caseRef,
    [EXEC_COLS.uniqueKey]:           uniqueKey,
    [EXEC_COLS.documentCode]:        documentCode,
    [EXEC_COLS.caseSubType]:         caseSubType,
    [EXEC_COLS.intakeItemId]:        templateItemId,
  };

  if (folderUrl) {
    createColValues[EXEC_COLS.documentFolder] = {
      url:  folderUrl,
      text: documentCategory ? `${documentCategory} Folder` : 'Open Folder',
    };
  }

  // Step 1: Create the item (without board_relation columns)
  const data = await mondayApi.query(
    `mutation createItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!,
      $columnValues: JSON!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
      }
    }`,
    {
      boardId:      String(executionBoardId),
      groupId:      EXECUTION_GROUP_ID,
      itemName:     name,
      columnValues: JSON.stringify(createColValues),
    }
  );

  const createdItem = data?.create_item;
  if (!createdItem?.id) return createdItem;

  // Step 2: Set board_relation columns separately (Monday.com requires this)
  const relationColValues = {
    [EXEC_COLS.clientCase]:        { item_ids: [Number(clientMasterItemId)] },
    [EXEC_COLS.clientMasterBoard]: { item_ids: [Number(clientMasterItemId)] },
    [EXEC_COLS.templateBoard]:     { item_ids: [Number(templateItemId)] },
  };

  try {
    await mondayApi.query(
      `mutation setRelations($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(
           board_id:      $boardId,
           item_id:       $itemId,
           column_values: $colValues
         ) { id }
       }`,
      {
        boardId:   String(executionBoardId),
        itemId:    String(createdItem.id),
        colValues: JSON.stringify(relationColValues),
      }
    );
  } catch (err) {
    console.warn(`[ExecutionService] Board relation set failed for item ${createdItem.id}: ${err.message}`);
  }

  return createdItem;
}

/**
 * Create all missing execution items for a client case.
 * Skips items whose Unique Key already exists (duplicate prevention).
 *
 * @param {{
 *   caseRef: string,
 *   clientMasterItemId: string,
 *   templateItems: Array,
 *   categoryLinks?: { [category: string]: string }, - OneDrive folder URLs keyed by Document Category
 * }} params
 * @returns {Promise<{ created: number, skipped: number }>}
 */
async function createMissingExecutionItems({ caseRef, clientMasterItemId, templateItems, categoryLinks = {} }) {
  const existingKeys = await getExistingUniqueKeys(caseRef);
  console.log(`[ExecutionService] Existing keys for "${caseRef}": ${existingKeys.size}`);

  let created = 0;
  let skipped = 0;

  for (const tmpl of templateItems) {
    if (!tmpl.name) continue;

    const uniqueKey = `${caseRef}-${tmpl.documentCode || tmpl.name}`;

    if (existingKeys.has(uniqueKey)) {
      console.log(`[ExecutionService] Skipping (exists): ${uniqueKey}`);
      skipped++;
      continue;
    }

    const folderUrl = tmpl.documentCategory ? categoryLinks[tmpl.documentCategory] : undefined;

    try {
      const result = await createExecutionItem({
        name:               tmpl.name,
        caseRef,
        uniqueKey,
        documentCode:       tmpl.documentCode,
        caseSubType:        tmpl.caseSubType,
        clientMasterItemId,
        templateItemId:     tmpl.id,
        folderUrl,
        documentCategory:   tmpl.documentCategory,
      });
      console.log(`[ExecutionService] Created: "${tmpl.name}" (id: ${result?.id})${folderUrl ? ' + folder link' : ''}`);
      created++;
    } catch (err) {
      console.error(`[ExecutionService] Failed to create "${tmpl.name}":`, err.message);
    }
  }

  return { created, skipped };
}

module.exports = { createMissingExecutionItems, getExistingUniqueKeys };
