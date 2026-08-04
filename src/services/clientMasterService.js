const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const CASE_STAGE_COLUMN_TITLE = 'Case Stage';
const DOCUMENT_COLLECTION_STARTED = 'Document Collection Started';

/**
 * Fetch board columns as a map of { [columnId]: columnTitle }.
 */
async function getBoardColumnMap(boardId) {
  const data = await mondayApi.query(
    `query getBoardColumns($boardIds: [ID!]!) {
      boards(ids: $boardIds) {
        columns { id title }
      }
    }`,
    { boardIds: [String(boardId)] }
  );

  const columns = data?.boards?.[0]?.columns;
  if (!columns?.length) {
    throw new Error(`Board ${boardId} not found or has no columns`);
  }

  const map = {};
  for (const col of columns) {
    map[col.id] = col.title;
  }
  return map;
}

/**
 * Fetch all items on Client Master board where Case Stage = "Document Collection Started".
 * Returns each item with a clean named `fields` object instead of a raw column_values array.
 * @returns {Promise<Array>}
 */
async function getDocumentCollectionStartedItems() {
  const boardId = clientMasterBoardId;
  if (!boardId) {
    throw new Error('Client Master Board ID is not configured (MONDAY_CLIENT_MASTER_BOARD_ID)');
  }

  // Fetch column map and Case Stage column id in parallel
  const columnMap = await getBoardColumnMap(boardId);

  const caseStageEntry = Object.entries(columnMap).find(
    ([, title]) => title.trim().toLowerCase() === CASE_STAGE_COLUMN_TITLE.toLowerCase()
  );
  if (!caseStageEntry) {
    throw new Error(`Column "${CASE_STAGE_COLUMN_TITLE}" not found on Client Master board`);
  }
  const caseStageColumnId = caseStageEntry[0];

  const data = await mondayApi.query(
    `query getItemsByCaseStage($boardId: ID!, $columnId: String!, $columnValue: String!) {
      items_page_by_column_values(
        limit: 500,
        board_id: $boardId,
        columns: [{ column_id: $columnId, column_values: [$columnValue] }]
      ) {
        cursor
        items {
          id
          name
          column_values {
            id
            text
          }
        }
      }
    }`,
    {
      boardId: String(boardId),
      columnId: caseStageColumnId,
      columnValue: DOCUMENT_COLLECTION_STARTED,
    }
  );

  const rawItems = data?.items_page_by_column_values?.items ?? [];

  // Shape each item into a clean object
  return rawItems.map((item) => {
    const fields = {};
    for (const col of item.column_values) {
      const title = columnMap[col.id];
      if (title && col.text) {
        fields[title] = col.text;
      }
    }
    return {
      id: item.id,
      name: item.name,
      fields,
    };
  });
}

// ─── Chasing Loop helpers ─────────────────────────────────────────────────────

const CASE_REF_COL       = 'text_mm142s49';
const LAST_ACTIVITY_COL  = 'date_mm1amqyr';

/**
 * Find the Client Master item ID for a given Case Reference Number.
 * Returns the item ID string, or null if not found.
 */
async function findItemByCaseRef(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 1,
         board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) { items { id } }
     }`,
    {
      boardId: String(clientMasterBoardId),
      colId:   CASE_REF_COL,
      val:     caseRef,
    }
  );
  return data?.items_page_by_column_values?.items?.[0]?.id || null;
}

/**
 * Update the Last Client Activity Date on the Client Master item to today.
 * Called whenever a client submits questionnaire answers or uploads a document.
 */
async function updateLastActivityDate(caseRef) {
  try {
    const itemId = await findItemByCaseRef(caseRef);
    if (!itemId) return;
    const today = new Date().toISOString().split('T')[0];
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
       }`,
      {
        boardId:   String(clientMasterBoardId),
        itemId:    String(itemId),
        colValues: JSON.stringify({ [LAST_ACTIVITY_COL]: { date: today } }),
      }
    );
    console.log(`[ClientMaster] Last activity date updated for case ${caseRef}`);
  } catch (err) {
    // Non-critical — log and move on
    console.warn(`[ClientMaster] Failed to update last activity for ${caseRef}:`, err.message);
  }
}

// ─── Case lookups by client identity ─────────────────────────────────────────
// (Duplicate detection / client accounts. The email variant generalises the
// lookup that previously lived privately inside handoffService.)

const CM_EMAIL_COL   = 'text_mm0xw6bp';
const CM_PHONE_COL   = 'phone_mm33zr0c';
const CM_TYPE_COL    = 'dropdown_mm0xd1qn';
const CM_STAGE_COL   = 'color_mm0x8faa';
const CM_PAYMENT_COL = 'color_mm0x9fnn';

function caseRow(it) {
  const g = (colId) => ((it.column_values || []).find((c) => c.id === colId) || {}).text || '';
  return {
    id: String(it.id),
    name: it.name,
    email: g(CM_EMAIL_COL),
    caseRef: g(CASE_REF_COL),
    caseType: g(CM_TYPE_COL),
    caseStage: g(CM_STAGE_COL),
    paymentStatus: g(CM_PAYMENT_COL),
  };
}

const CASE_FETCH_COLS = JSON.stringify([CM_EMAIL_COL, CASE_REF_COL, CM_TYPE_COL, CM_STAGE_COL, CM_PAYMENT_COL]);

async function findCasesByColumn(colId, value) {
  const data = await mondayApi.query(
    `query($boardId:ID!,$v:String!){ items_page_by_column_values(limit:25, board_id:$boardId, columns:[{column_id:"${colId}", column_values:[$v]}]){ items{ id name column_values(ids:${CASE_FETCH_COLS}){ id text } } } }`,
    { boardId: String(clientMasterBoardId), v: String(value) }
  );
  return (data?.items_page_by_column_values?.items || []).map(caseRow);
}

/** All Client Master cases whose client email matches (exact text match). */
async function findCasesByEmail(email) {
  const e = String(email || '').trim();
  if (!e) return [];
  // Legacy rows may carry mixed case — try the exact form, then lowercased.
  const seen = new Map();
  for (const v of [...new Set([e, e.toLowerCase()])]) {
    for (const row of await findCasesByColumn(CM_EMAIL_COL, v)) seen.set(row.id, row);
  }
  return [...seen.values()];
}

/**
 * All Client Master cases whose client phone matches. Monday phone columns
 * store DIGITS ONLY — the '+' our writers send is stripped on write (verified
 * by live probe), so the query variants must be digit-only, and the 11-digit
 * '1…' NA form must be tried alongside the bare 10-digit one.
 */
async function findCasesByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return [];
  const bare = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const seen = new Map();
  for (const v of [...new Set([bare, `1${bare}`, digits])]) {
    for (const row of await findCasesByColumn(CM_PHONE_COL, v)) seen.set(row.id, row);
  }
  return [...seen.values()];
}

module.exports = {
  getBoardColumnMap,
  getDocumentCollectionStartedItems,
  findItemByCaseRef,
  findCasesByEmail,
  findCasesByPhone,
  updateLastActivityDate,
};
