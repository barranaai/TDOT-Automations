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

/**
 * PURE. From a case's existing rows, pick the ones to prune because they belong
 * to a DIFFERENT sub-type than the one now being seeded (the stale-duplicate
 * signature: a case re-seeded after its Case Sub Type changed). Conservative:
 *   - only reconciler-managed SCHEMA rows — identified by having a uniqueKey AND
 *     no Template-Board relation (this covers BOTH the old numeric-intakeItemId
 *     format and the new "code:" format; it excludes legacy Template-Board rows
 *     and manually-added rows, which have no uniqueKey),
 *   - only rows whose caseSubType differs from the current one,
 *   - NEVER a row a client has uploaded to (status beyond "Missing").
 * @param {Array<{id,subType,uniqueKey,templateRel,status}>} rows
 * @param {string} keepSubType  the sub-type currently being seeded
 */
function selectStaleRows(rows, keepSubType) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const keep = norm(keepSubType);
  const uploaded = (s) => { const n = norm(s); return n !== '' && n !== 'missing'; };
  return (rows || []).filter((r) =>
    String(r.uniqueKey || '').trim() !== '' &&        // reconciler-managed schema row (old or new format)
    String(r.templateRel || '').trim() === '' &&      // NOT a legacy Template-Board row
    norm(r.subType) !== keep &&                        // from a DIFFERENT sub-type than the current one
    !uploaded(r.status)                                // never a row a client has uploaded to
  );
}

/** I/O. Read a case's existing rows with the fields the prune needs. */
async function getExistingRowsForPrune(caseRef) {
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:500, board_id:$b, columns:[{column_id:"${EXEC_COLS.caseReferenceNumber}", column_values:[$v]}]){ items{ id column_values(ids:["${EXEC_COLS.caseSubType}","${EXEC_COLS.uniqueKey}","board_relation_mm0zhagw","color_mm0zwgvr"]){ id text } } } }`,
    { b: String(BOARD_ID), v: String(caseRef) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => {
    const g = (id) => (it.column_values.find((c) => c.id === id) || {}).text || '';
    return { id: it.id, subType: g(EXEC_COLS.caseSubType), uniqueKey: g(EXEC_COLS.uniqueKey), templateRel: g('board_relation_mm0zhagw'), status: g('color_mm0zwgvr') };
  });
}

/**
 * I/O. Delete schema-sourced rows left over from a PREVIOUS Case Sub Type, so a
 * sub-type change re-seeds cleanly instead of piling stale duplicates on top.
 * Best-effort; never throws (a prune failure must not fail the seed).
 * @returns {Promise<number>} number of rows pruned
 */
async function pruneStaleSubTypeRows({ caseRef, keepSubType }) {
  let rows;
  try { rows = await getExistingRowsForPrune(caseRef); }
  catch (err) { console.warn(`[ExecSeeder] prune read failed for ${caseRef}: ${err.message}`); return 0; }
  const stale = selectStaleRows(rows, keepSubType);
  let pruned = 0;
  for (const r of stale) {
    try { await mondayApi.query(`mutation($id:ID!){ delete_item(item_id:$id){ id } }`, { id: String(r.id) }); pruned++; await sleep(150); }
    catch (err) { console.warn(`[ExecSeeder] prune delete failed for row ${r.id}: ${err.message}`); }
  }
  if (pruned) console.log(`[ExecSeeder] ${caseRef}: pruned ${pruned} stale row(s) from other sub-type(s) — kept "${keepSubType}"`);
  return pruned;
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

  // Prune rows left over from a PREVIOUS sub-type so a Sub Type change re-seeds
  // clean (this is the fix for the multi-sub-type duplicate pile-up). Runs after
  // create so the current-sub-type rows are already in place; best-effort.
  const pruned = await pruneStaleSubTypeRows({ caseRef, keepSubType: caseSubType });

  console.log(`[ExecSeeder] ${caseRef}: created ${created}, skipped ${toSkip.length}, failed ${failed}, pruned ${pruned}`);
  return { created, skipped: toSkip.length, failed, pruned };
}

module.exports = {
  reconcileExecutionRows,
  diffPlan,
  planRowToUniqueKey,
  selectStaleRows,
  pruneStaleSubTypeRows,
  _cols: EXEC_COLS,
};
