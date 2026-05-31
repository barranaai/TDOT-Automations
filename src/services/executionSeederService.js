/**
 * executionSeederService — turns a seed plan into Execution Board rows,
 * idempotently.
 *
 * Given a plan (from seedPlanner.seedPlan) it:
 *   1. reads the uniqueKeys already on the Execution Board for the case,
 *   2. creates ONLY the rows that are missing,
 *   3. NEVER deletes or modifies existing rows.
 *
 * That makes it safe to re-run whenever composition changes (client adds a
 * spouse mid-case, a member's flag flips, etc.) — exactly the re-entrancy the
 * old one-shot Template-Board seeding lacked. Rows that already exist (and may
 * carry client uploads) are left untouched.
 *
 * Code-sourced rows do NOT link the Template Board board_relation (there's no
 * matching Monday template item) — only the Client Master relations are set.
 *
 * Split:
 *   - diffPlan(...)              — PURE. plan + existing keys → {toCreate, toSkip}.
 *   - reconcileExecutionRows(...) — I/O. reads existing, creates missing.
 */

'use strict';

const mondayApi = require('./mondayApi');
const { getExistingUniqueKeys } = require('./executionService');

const BOARD_ID          = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const EXECUTION_GROUP_ID = 'topics';

const EXEC_COLS = {
  caseReferenceNumber: 'text_mm0z2cck',
  uniqueKey:           'text_mm15dwah',
  documentCode:        'text_mm0zr7tf',
  clientCase:          'board_relation_mm0zwb5',
  clientMasterBoard:   'board_relation_mm0z5p76',
  caseSubType:         'text_mm17zdy7',
  intakeItemId:        'text_mm0zfsp1',
  documentFolder:      'link_mm1yrnz1',
  applicantType:       'text_mm26jcv7',
  documentCategory:    'text_mm261tka',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** uniqueKey scheme — must match executionService's: `${caseRef}-${documentCode}`. */
function planRowToUniqueKey(caseRef, row) {
  return `${caseRef}-${row.documentCode}`;
}

/**
 * PURE. Partition a plan into rows to create vs rows that already exist.
 *
 * @param {{ plan: Array, existingKeys: Set<string>, caseRef: string }} args
 * @returns {{ toCreate: Array<{row, uniqueKey}>, toSkip: Array<{row, uniqueKey}> }}
 */
function diffPlan({ plan, existingKeys, caseRef }) {
  const keys = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  const toCreate = [];
  const toSkip   = [];
  for (const row of plan || []) {
    const uniqueKey = planRowToUniqueKey(caseRef, row);
    (keys.has(uniqueKey) ? toSkip : toCreate).push({ row, uniqueKey });
  }
  return { toCreate, toSkip };
}

/** I/O. Create one Execution Board row from a planned row. */
async function createRow({ caseRef, caseSubType, clientMasterItemId, row, uniqueKey, folderUrl }) {
  const cols = {
    [EXEC_COLS.caseReferenceNumber]: caseRef,
    [EXEC_COLS.uniqueKey]:           uniqueKey,
    [EXEC_COLS.documentCode]:        row.documentCode,
    [EXEC_COLS.caseSubType]:         caseSubType || '',
    [EXEC_COLS.intakeItemId]:        `code:${row.documentCode}`, // marks the row as schema-sourced
    [EXEC_COLS.applicantType]:       row.applicantType || '',
    [EXEC_COLS.documentCategory]:    row.category || '',
  };
  if (folderUrl) {
    cols[EXEC_COLS.documentFolder] = { url: folderUrl, text: `${row.category} Folder` };
  }

  const data = await mondayApi.query(
    `mutation($boardId: ID!, $groupId: String!, $name: String!, $cols: JSON!) {
       create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $cols) { id }
     }`,
    { boardId: String(BOARD_ID), groupId: EXECUTION_GROUP_ID, name: row.documentName, cols: JSON.stringify(cols) }
  );
  const newId = data?.create_item?.id;

  // Board relations must be set in a separate mutation (Monday ignores them in
  // create_item). Only Client Master relations — no Template Board link for
  // code-sourced rows. Best-effort; non-fatal if it fails.
  if (newId && clientMasterItemId) {
    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        {
          boardId: String(BOARD_ID),
          itemId:  String(newId),
          cols:    JSON.stringify({
            [EXEC_COLS.clientCase]:        { item_ids: [Number(clientMasterItemId)] },
            [EXEC_COLS.clientMasterBoard]: { item_ids: [Number(clientMasterItemId)] },
          }),
        }
      );
    } catch (relErr) {
      console.warn(`[ExecSeeder] Relation set failed for "${row.documentName}": ${relErr.message}`);
    }
  }
  return newId;
}

/**
 * I/O. Reconcile a case's Execution Board rows against a plan.
 *
 * @param {{
 *   caseRef: string,
 *   caseSubType?: string,
 *   clientMasterItemId?: string,   // optional — relations skipped if absent
 *   plan: Array,                   // from seedPlanner.seedPlan
 *   categoryLinks?: { [category]: string },
 * }} args
 * @returns {Promise<{ created: number, skipped: number, failed: number }>}
 */
async function reconcileExecutionRows({ caseRef, caseSubType, clientMasterItemId, plan, categoryLinks = {} }) {
  const existingKeys = await getExistingUniqueKeys(caseRef);
  const { toCreate, toSkip } = diffPlan({ plan, existingKeys, caseRef });

  console.log(`[ExecSeeder] ${caseRef}: ${plan.length} planned, ${toSkip.length} already present, ${toCreate.length} to create`);

  let created = 0, failed = 0;
  for (const { row, uniqueKey } of toCreate) {
    try {
      const folderUrl = row.category ? categoryLinks[row.category] : undefined;
      await createRow({ caseRef, caseSubType, clientMasterItemId, row, uniqueKey, folderUrl });
      created++;
    } catch (err) {
      console.error(`[ExecSeeder] Failed to create "${row.documentName}" (${uniqueKey}): ${err.message}`);
      failed++;
    }
    await sleep(200);
  }

  console.log(`[ExecSeeder] ${caseRef}: created ${created}, skipped ${toSkip.length}, failed ${failed}`);
  return { created, skipped: toSkip.length, failed };
}

module.exports = {
  reconcileExecutionRows,
  diffPlan,
  planRowToUniqueKey,
  _cols: EXEC_COLS,
};
