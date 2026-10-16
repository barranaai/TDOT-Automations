/**
 * executionSeederService — turns a seed plan into Execution Board rows,
 * idempotently.
 *
 * Given a plan (from seedPlanner.seedPlan) it:
 *   1. reads the uniqueKeys already on the Execution Board for the case,
 *   2. moves rows built for ANOTHER Sub Type of the same Case Type onto the
 *      plan's rows when they are the same document for the same person
 *      (planVariantMigration — keys rewritten, the row and its uploads kept),
 *   3. creates ONLY the rows that are missing,
 *   4. never modifies any other existing row (the prune below deletes only
 *      empty rows of another Sub Type, and only when the caller allows it).
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
 *   - planVariantMigration(...)  — PURE. rows of another Sub Type → moves onto the plan.
 *   - reconcileExecutionRows(...) — I/O. reads existing, moves, creates missing, prunes.
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

/**
 * PURE. A board_relation column's `text` is NULL from Monday's API — the linked
 * items live in the raw `value` JSON. Returns 'linked' when the relation holds
 * any item (so selectStaleRows' legacy-Template-Board exclusion actually works).
 */
function parseTemplateRel(col) {
  if (!col) return '';
  if (String(col.text || '').trim()) return String(col.text).trim();
  try {
    const v = JSON.parse(col.value || '{}');
    const ids = v.linkedPulseIds || v.linked_item_ids || v.linkedItemIds || [];
    if (Array.isArray(ids) && ids.length) return 'linked';
  } catch (_) { /* no relation */ }
  return '';
}

/** I/O. Read a case's existing rows with the fields the prune needs. */
async function getExistingRowsForPrune(caseRef) {
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:500, board_id:$b, columns:[{column_id:"${EXEC_COLS.caseReferenceNumber}", column_values:[$v]}]){ items{ id column_values(ids:["${EXEC_COLS.caseSubType}","${EXEC_COLS.uniqueKey}","board_relation_mm0zhagw","color_mm0zwgvr"]){ id text value } } } }`,
    { b: String(BOARD_ID), v: String(caseRef) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => {
    const g = (id) => (it.column_values.find((c) => c.id === id) || {}).text || '';
    const relCol = it.column_values.find((c) => c.id === 'board_relation_mm0zhagw');
    return { id: it.id, subType: g(EXEC_COLS.caseSubType), uniqueKey: g(EXEC_COLS.uniqueKey), templateRel: parseTemplateRel(relCol), status: g('color_mm0zwgvr') };
  });
}

/**
 * I/O. Delete schema-sourced rows left over from a PREVIOUS Case Sub Type, so a
 * sub-type change re-seeds cleanly instead of piling stale duplicates on top.
 * Best-effort; never throws (a prune failure must not fail the seed).
 * @returns {Promise<number>} number of rows pruned
 */
async function pruneStaleSubTypeRows({ caseRef, keepSubType, keepIds = null }) {
  let rows;
  try { rows = await getExistingRowsForPrune(caseRef); }
  catch (err) { console.warn(`[ExecSeeder] prune read failed for ${caseRef}: ${err.message}`); return 0; }
  // keepIds: rows this run just moved onto the current Sub Type (or tried to) — never pruned
  const stale = selectStaleRows(rows, keepSubType).filter((r) => !(keepIds && keepIds.has(String(r.id))));
  let pruned = 0;
  for (const r of stale) {
    try { await mondayApi.query(`mutation($id:ID!){ delete_item(item_id:$id){ id } }`, { id: String(r.id) }); pruned++; await sleep(150); }
    catch (err) { console.warn(`[ExecSeeder] prune delete failed for row ${r.id}: ${err.message}`); }
  }
  if (pruned) console.log(`[ExecSeeder] ${caseRef}: pruned ${pruned} stale row(s) from other sub-type(s) — kept "${keepSubType}"`);
  return pruned;
}

// ─── Rows built for another Sub Type of the same Case Type (2026-10-16) ─────
// A case whose Case Sub Type changes after its checklist was built (EE-085:
// "CEC Single Applicant" → "CEC Accompanying Spouse & Child" when a spouse
// joined) holds rows whose keys start with the OLD variant. Every key of the
// new variant differs, so a re-seed used to lay a second checklist beside the
// first (the old rows the client had uploaded to stay; the empty ones were
// pruned). Instead, each old row that is the SAME document for the SAME person
// in the new variant is moved onto it — its keys, Sub Type and document code
// rewritten, the row itself (uploads, status, review notes) kept. Matched by
// role + member number + document code, else by the exact document name; one
// old row per new row; anything unsure stays as it was.

/** Kill switch: CHECKLIST_VARIANT_MIGRATE=0 / off / false / no → re-seeds behave as before. */
function variantMigrateEnabled() {
  return !/^(0|off|false|no)$/i.test(String(process.env.CHECKLIST_VARIANT_MIGRATE || '').trim());
}

const normName = (s) => String(s || '').toLowerCase().replace(/\(if applicable\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const normText = (s) => String(s || '').trim().toLowerCase();
const isOpenStatus = (s) => ['', 'missing'].includes(normText(s));   // as selectStaleRows reads "not uploaded"

/**
 * PURE. The variant a schema code was built for: the registered variant whose
 * prefix is the LONGEST the code starts with ("Visitor Record" must not claim
 * "Visitor Record Restoration" rows); a variant since retired or renamed via
 * the row's own Sub Type column, when the code starts with this Case Type +
 * that Sub Type. null = no variant claims it.
 */
function variantOwnerOf(code, rowSubType, caseType, registered) {
  const { slugUpper } = require('./seedPlanner')._internal;
  const prefixOf = (ct, st) => `${slugUpper(ct)}-${slugUpper(st)}-`;
  const c = String(code || '');
  const hit = (registered || [])
    .map((s) => ({ caseType: s.caseType, subType: s.subType || '', prefix: prefixOf(s.caseType, s.subType) }))
    .filter((v) => c.startsWith(v.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (hit) return hit;
  const st = String(rowSubType || '').trim();
  if (st && slugUpper(st) && c.startsWith(prefixOf(caseType, st))) return { caseType, subType: st, prefix: prefixOf(caseType, st), retired: true };
  return null;
}

/** PURE. "ROLESLUG[idx]-DOCCODE-001" → { role, index, docCode } using these role names (longest slug first); null when none fits. */
function parseCodeTail(rest, roles) {
  const { slugUpper } = require('./seedPlanner')._internal;
  const list = [...new Set((roles || []).filter(Boolean))].map((role) => ({ role, slug: slugUpper(role) }))
    .filter((r) => r.slug).sort((a, b) => b.slug.length - a.slug.length);
  for (const { role, slug } of list) {
    if (!String(rest || '').startsWith(slug)) continue;
    const m = /^(\d*)-(.+)-001$/.exec(String(rest).slice(slug.length));
    if (m) return { role, index: m[1] ? Number(m[1]) : 1, docCode: m[2] };
  }
  return null;
}

/**
 * PURE. Which of the case's rows move onto the variant being seeded.
 *
 * @param {object} a
 * @param {Array<{id,name,uniqueKey,documentCode,intake,subType,templateRel,status,applicantType,category}>} a.rows  the case's checklist rows
 * @param {Array} a.plan            seedPlanner rows for the CURRENT variant
 * @param {string} a.caseRef
 * @param {string} a.caseType       the case's Case Type
 * @param {string} a.caseSubType    the Sub Type being seeded
 * @param {Set<string>|string[]} [a.existingKeys]  keys already on the board (default: the rows' own)
 * @param {Array} [a.registered]    caseSchemaService.listRegistered()
 * @param {Function} [a.lookup]     caseSchemaService.lookup
 * @returns {{ moves: Array<{id, name, status, by:'code'|'name', from:{uniqueKey,documentCode,subType,applicantType,category}, to:{row, uniqueKey}}>,
 *             stale: Array<{id, name, status, subType, owner, moved:boolean, sameType:boolean}> }}
 *   stale = every schema row NOT of the current variant (moved ones flagged) — what is left is the caller's call.
 */
function planVariantMigration({ rows, plan, caseRef, caseType, caseSubType, existingKeys, registered, lookup }) {
  const css = require('./caseSchemaService');
  const { slugUpper } = require('./seedPlanner')._internal;
  const reg = registered || css.listRegistered();
  const look = lookup || ((ct, st) => css.lookup(ct, st));
  const mine = `${slugUpper(caseType)}-${slugUpper(caseSubType)}-`;
  const present = existingKeys instanceof Set ? existingKeys
    : new Set(existingKeys || (rows || []).map((r) => String(r.uniqueKey || '').trim()).filter(Boolean));
  const planRoles = [...new Set((plan || []).map((p) => p.role))];

  // The case's schema rows ("code:" intake, no Template relation), well-formed:
  // the key and the document code agree — anything else is left alone.
  const stale = [];
  const cands = [];
  for (const r of rows || []) {
    const intake = String(r.intake || '').trim();
    if (!intake.startsWith('code:') || String(r.templateRel || '').trim()) continue;
    const code = String(r.documentCode || '').trim() || intake.slice(5);
    const owner = variantOwnerOf(code, r.subType, caseType, reg);
    if (owner && owner.prefix === mine) continue;                      // the current variant's own row
    const sameType = !!owner && slugUpper(owner.caseType) === slugUpper(caseType);
    const s = { id: String(r.id), name: r.name || '', status: r.status || '', subType: r.subType || '', owner, moved: false, sameType };
    stale.push(s);
    if (!sameType) continue;
    if (intake.slice(5) !== code || String(r.uniqueKey || '').trim() !== `${caseRef}-${code}`) continue;
    const ownerSchema = owner.retired ? null : look(owner.caseType, owner.subType);
    const roles = [...planRoles, ...((ownerSchema && ownerSchema.roles) || []).map((x) => x.role)];
    const parsed = parseCodeTail(code.slice(owner.prefix.length), roles);
    if (!parsed) continue;
    const ownerRole = ownerSchema && (ownerSchema.roles || []).find((x) => x.role === parsed.role);
    const ownerDoc = ownerRole && (ownerRole.documents || []).find((d) => d.code === parsed.docCode);
    cands.push({ row: r, code, stale: s, ...parsed, names: [normName(r.name), normName(ownerDoc && ownerDoc.name)].filter(Boolean), ownerDocName: ownerDoc ? ownerDoc.name : '' });
  }

  // The current variant's rows not on the board yet.
  const targets = [];
  for (const p of plan || []) {
    const uniqueKey = planRowToUniqueKey(caseRef, p);
    if (present.has(uniqueKey)) continue;
    const parsed = parseCodeTail(String(p.documentCode || '').slice(mine.length), [p.role]);
    if (!parsed) continue;
    targets.push({ row: p, uniqueKey, role: p.role, index: Number(p.memberIndex) || parsed.index, docCode: parsed.docCode, name: normName(p.documentName) });
  }

  const used = new Set();
  const moves = [];
  const pick = (list) => list.slice().sort((a, b) =>
    (isOpenStatus(a.row.status) - isOpenStatus(b.row.status)) || (Number(a.row.id) - Number(b.row.id)))[0];   // the one the client uploaded to, else the oldest
  const take = (t, c, by) => {
    used.add(c.row.id); t.done = true; c.stale.moved = true;
    moves.push({
      id: String(c.row.id), name: c.row.name || '', status: c.row.status || '', by, ownerDocName: c.ownerDocName,
      from: { uniqueKey: c.row.uniqueKey, documentCode: c.code, subType: c.row.subType || '', applicantType: c.row.applicantType || '', category: c.row.category || '' },
      to: { row: t.row, uniqueKey: t.uniqueKey },
    });
  };
  const sameSlot = (t, c) => c.role === t.role && c.index === t.index && !used.has(c.row.id);
  // 1) the same document code, same person
  for (const t of targets) {
    const list = cands.filter((c) => sameSlot(t, c) && c.docCode === t.docCode);
    if (list.length) take(t, pick(list), 'code');
  }
  // 2) the exact document name, same person — only when that name is one
  //    document on each side (never a guess between two)
  for (const t of targets) {
    if (t.done || !t.name) continue;
    if (targets.filter((o) => !o.done && o.role === t.role && o.index === t.index && o.name === t.name).length !== 1) continue;
    const list = cands.filter((c) => sameSlot(t, c) && c.names.includes(t.name));
    const docs = new Set(list.map((c) => c.docCode));
    if (list.length && docs.size === 1) take(t, pick(list), 'name');
  }
  return { moves, stale };
}

/** I/O. The case's checklist rows with every field the variant move reads. */
async function getExistingRowsForMigration(caseRef) {
  const ids = [EXEC_COLS.uniqueKey, EXEC_COLS.documentCode, EXEC_COLS.intakeItemId, EXEC_COLS.caseSubType, EXEC_COLS.applicantType, EXEC_COLS.documentCategory, 'board_relation_mm0zhagw', 'color_mm0zwgvr'];
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:500, board_id:$b, columns:[{column_id:"${EXEC_COLS.caseReferenceNumber}", column_values:[$v]}]){ items{ id name column_values(ids:${JSON.stringify(ids)}){ id text value } } } }`,
    { b: String(BOARD_ID), v: String(caseRef) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => {
    const g = (id) => String((it.column_values.find((c) => c.id === id) || {}).text || '').trim();
    return {
      id: String(it.id), name: it.name || '',
      uniqueKey: g(EXEC_COLS.uniqueKey), documentCode: g(EXEC_COLS.documentCode), intake: g(EXEC_COLS.intakeItemId),
      subType: g(EXEC_COLS.caseSubType), applicantType: g(EXEC_COLS.applicantType), category: g(EXEC_COLS.documentCategory),
      templateRel: parseTemplateRel(it.column_values.find((c) => c.id === 'board_relation_mm0zhagw')), status: g('color_mm0zwgvr'),
    };
  });
}

/**
 * I/O. Move one row onto the current variant: ONE write of its key columns
 * (document code, unique key, intake id, Sub Type), plus the person label /
 * category / folder link when the new variant's differ, and the name when the
 * row still carries the old variant's own name for the document. Status,
 * files and notes are never touched.
 */
async function moveRow({ move, caseSubType, categoryLinks = {} }) {
  const t = move.to.row;
  const cols = {
    [EXEC_COLS.uniqueKey]:    move.to.uniqueKey,
    [EXEC_COLS.documentCode]: t.documentCode,
    [EXEC_COLS.intakeItemId]: `code:${t.documentCode}`,
    [EXEC_COLS.caseSubType]:  caseSubType || '',
  };
  if (t.applicantType && t.applicantType !== move.from.applicantType) cols[EXEC_COLS.applicantType] = t.applicantType;
  if (t.category && t.category !== move.from.category) {
    cols[EXEC_COLS.documentCategory] = t.category;
    if (categoryLinks[t.category]) cols[EXEC_COLS.documentFolder] = { url: categoryLinks[t.category], text: `${t.category} Folder` };
  }
  if (t.documentName && move.ownerDocName && move.name === move.ownerDocName && t.documentName !== move.name) cols.name = t.documentName;
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    { boardId: String(BOARD_ID), itemId: String(move.id), cols: JSON.stringify(cols) }
  );
  if (!data?.change_multiple_column_values?.id) throw new Error('Monday did not confirm the change');
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
 *   caseType?: string,             // given → rows of another Sub Type of this Case Type are moved, not duplicated
 *   staleOpen?: 'keep'|'refuse',   // 'refuse': write nothing when an EMPTY row of another variant would be left over
 * }} args
 * @returns {Promise<{ created, skipped, failed, pruned, migrated, refused?, leftover? }>}
 */
async function reconcileExecutionRows({ caseRef, caseType = '', caseSubType, clientMasterItemId, plan, categoryLinks = {}, prune = true, staleOpen = 'keep' }) {
  const existingKeys = await getExistingUniqueKeys(caseRef);

  // Rows of another Sub Type of this Case Type: moved onto this one BEFORE the
  // diff, so their documents are not created a second time.
  let migrated = 0, migrateFailed = 0, migratedFrom = [];
  const hold = new Set();      // keys a failed move still owns — never created beside it this run
  const keepIds = new Set();   // rows the move touched — never pruned this run (a search may still show the old Sub Type)
  if (caseType && variantMigrateEnabled()) {
    let rows = null;
    try { rows = await getExistingRowsForMigration(caseRef); }
    catch (err) {
      // A checklist exists but cannot be read row by row: seeding now could lay
      // the new Sub Type's rows beside the old ones — stop; a re-run fixes it.
      if (existingKeys.size) throw new Error(`the checklist rows could not be read to check for another Sub Type's rows (${err.message}) — nothing was changed; try again in a minute`);
    }
    if (rows) {
      for (const r of rows) if (r.uniqueKey) existingKeys.add(r.uniqueKey);   // a key either read shows is on the board
      const { moves, stale } = planVariantMigration({ rows, plan, caseRef, caseType, caseSubType, existingKeys });
      const leftover = stale.filter((s) => !s.moved && isOpenStatus(s.status));
      if (staleOpen === 'refuse' && leftover.length) {
        return { created: 0, skipped: 0, failed: 0, pruned: 0, migrated: 0, refused: 'stale-open', leftover: leftover.map((s) => ({ id: s.id, name: s.name, subType: s.subType || (s.owner && s.owner.subType) || '' })) };
      }
      for (const m of moves) {
        keepIds.add(m.id);
        try {
          await moveRow({ move: m, caseSubType, categoryLinks });
          migrated++;
          existingKeys.delete(m.from.uniqueKey);
          existingKeys.add(m.to.uniqueKey);   // Monday's search can lag the write — the diff must see it now
          migratedFrom.push(m.from.subType);
        } catch (err) {
          migrateFailed++;
          hold.add(m.to.uniqueKey);
          console.error(`[ExecSeeder] ${caseRef}: moving row ${m.id} "${m.name}" to ${m.to.uniqueKey} failed: ${err.message}`);
        }
        await sleep(150);
      }
      if (moves.length) console.log(`[ExecSeeder] ${caseRef}: moved ${migrated} row(s) from another Sub Type onto "${caseSubType}"${migrateFailed ? `, ${migrateFailed} failed` : ''}`);
    }
  } else if (staleOpen === 'refuse') {
    return { created: 0, skipped: 0, failed: 0, pruned: 0, migrated: 0, refused: 'migration-off', leftover: [] };
  }

  const { toCreate, toSkip } = diffPlan({ plan, existingKeys, caseRef });
  const held = toCreate.filter((c) => hold.has(c.uniqueKey));
  const create = toCreate.filter((c) => !hold.has(c.uniqueKey));

  console.log(`[ExecSeeder] ${caseRef}: ${plan.length} planned, ${toSkip.length} already present, ${create.length} to create${held.length ? `, ${held.length} held for a failed move` : ''}`);

  let created = 0, failed = migrateFailed;
  for (const { row, uniqueKey } of create) {
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
  // prune:false — a caller that only ever ADDS rows (adding a family member)
  // must never delete another sub type's rows under staff's feet.
  const pruned = prune ? await pruneStaleSubTypeRows({ caseRef, keepSubType: caseSubType, keepIds }) : 0;

  console.log(`[ExecSeeder] ${caseRef}: created ${created}, skipped ${toSkip.length}, failed ${failed}, pruned ${pruned}, moved ${migrated}`);
  return { created, skipped: toSkip.length - migrated, failed, pruned, migrated, migratedFrom: [...new Set(migratedFrom.filter(Boolean))] };
}

module.exports = {
  reconcileExecutionRows,
  diffPlan,
  planRowToUniqueKey,
  selectStaleRows,
  parseTemplateRel,
  pruneStaleSubTypeRows,
  planVariantMigration,
  variantOwnerOf,
  parseCodeTail,
  variantMigrateEnabled,
  _cols: EXEC_COLS,
};
