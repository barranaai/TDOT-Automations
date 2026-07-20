const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const { getTemplateItemsByCaseType } = require('./templateService');
const { createMissingExecutionItems } = require('./executionService');
const { createClientFolders } = require('./oneDriveService');

// Schema-driven seeding (the new spine). Consulted only when enabled; otherwise
// the Template Board flow below runs exactly as before.
const caseSchemaService     = require('./caseSchemaService');
const compositionAdapter    = require('./compositionAdapter');
const { seedPlan, findOrphanMembers } = require('./seedPlanner');
const { reconcileExecutionRows } = require('./executionSeederService');

// Client Master column IDs
const CM_COLS = {
  caseReferenceNumber:     'text_mm142s49',
  primaryCaseType:         'dropdown_mm0xd1qn',
  caseSubType:             'dropdown_mm0x4t91',
  checklistTemplateApplied:'color_mm0xs7kp',
};

/**
 * Is schema-driven seeding enabled for this (caseType, subType)?
 *
 *   SCHEMA_DRIVEN_SEEDING   — master switch. Unless "true"/"1", schema-driven
 *                             seeding is OFF and everything uses the Template
 *                             Board (deploy = zero behaviour change).
 *   SCHEMA_DRIVEN_ALLOWLIST — optional comma-separated "CaseType:SubType" pairs.
 *                             When set, ONLY those pairs go schema-driven (even
 *                             if other schemas are registered). When unset, any
 *                             registered schema is eligible once the master
 *                             switch is on.
 */
function isSchemaDrivenEnabled(caseType, subType) {
  const master = String(process.env.SCHEMA_DRIVEN_SEEDING || '').toLowerCase();
  if (master !== 'true' && master !== '1') return false;

  const allowlist = (process.env.SCHEMA_DRIVEN_ALLOWLIST || '').trim();
  if (!allowlist) return true;

  const wanted = `${String(caseType).trim().toLowerCase()}:${String(subType).trim().toLowerCase()}`;
  return allowlist.split(',').map((s) => s.trim().toLowerCase()).includes(wanted);
}

// Re-seed Checklist column (shared with reseedButtonService) — used to surface
// a failed auto-seed as "Failed ⚠" so staff see it needs a one-click re-seed
// instead of the failure being silently swallowed.
const RESEED_COL = (require('../../config/monday').cmColumns || {}).reseedChecklist || 'color_mm47h11c';

async function flagSeedFailed(itemId, caseRef, err) {
  const msg = String((err && err.message) || err || 'unknown error').slice(0, 300);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Visible status marker on the case.
  await mondayApi.query(
    `mutation($b: ID!, $i: ID!, $c: JSON!) {
       change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c, create_labels_if_missing: true) { id }
     }`,
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify({ [RESEED_COL]: { label: 'Failed ⚠' } }) }
  );
  // Audit note telling staff exactly what to do.
  await mondayApi.query(
    `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
    { i: String(itemId), body: `⚠️ <b>Document checklist auto-seed FAILED</b> for ${esc(caseRef)} after 2 attempts — the case has no checklist yet. Flip <b>Re-seed Checklist → Run</b> to build it (safe, additive). Error: ${esc(msg)}` }
  ).catch(() => {});
  console.error(`[ChecklistService] Flagged seed failure on Client Master for ${caseRef}`);
}

async function markChecklistApplied(itemId) {
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
}

/**
 * Schema-driven seed path. Reads family composition from the Family Members
 * board, computes the exact doc list from the schema, creates OneDrive folders,
 * and reconciles the Execution Board (idempotent — adds missing rows only).
 */
async function seedFromSchema({ schema, caseRef, clientName, clientMasterItemId }) {
  const composition = await compositionAdapter.readForCase(caseRef);
  console.log(
    `[ChecklistService] SCHEMA path for ${caseRef} (${schema.caseType}/${schema.subType}) — ` +
    `${composition.members.length} member(s): ${composition.members.map((m) => m.role).join(', ') || 'none on board'}`
  );

  const plan = seedPlan({ schema, composition });

  // Guardrail: a family member on the board whose role the SELECTED schema can't
  // seed (e.g. children on the board + a single-applicant Sub Type) would be
  // silently dropped — no rows, no error. Surface it so staff can correct the
  // Sub Type instead of the case quietly missing that member's documents.
  const orphans = findOrphanMembers({ schema, composition });

  // OneDrive folders per category (same as the Template Board path).
  const categories = [...new Set(plan.map((r) => r.category).filter(Boolean))];
  let categoryLinks = {};
  if (categories.length) {
    try {
      categoryLinks = await createClientFolders({ clientName, caseRef, categories });
    } catch (err) {
      console.warn(`[ChecklistService] OneDrive folder creation failed (schema path) — continuing: ${err.message}`);
    }
  }

  const result = await reconcileExecutionRows({
    caseRef,
    caseSubType:        schema.subType,
    clientMasterItemId: String(clientMasterItemId),
    plan,
    categoryLinks,
  });
  console.log(`[ChecklistService] SCHEMA seed done for ${caseRef} — created ${result.created}, skipped ${result.skipped}, failed ${result.failed}`);

  // Post the orphan-members warning AFTER a successful seed (best-effort; never
  // fails the seed). Gated on created > 0 so a retry (or an idempotent re-seed
  // that adds nothing) can't double-post the note within one DCS event.
  if (orphans.length && clientMasterItemId && result.created > 0) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const who = orphans.map((o) => `${o.count} ${esc(o.label)}${o.count > 1 ? 's' : ''}`).join(', ');
    console.warn(`[ChecklistService] ${caseRef}: family on board not covered by Sub Type "${schema.subType}" — orphaned: ${who}`);
    await mondayApi.query(
      `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
      { i: String(clientMasterItemId),
        body: `⚠️ <b>Family members not covered by this checklist.</b> ${esc(who)} on the Family Members board, but the current Case Sub Type <b>"${esc(schema.subType) || '(none)'}"</b> has no matching document role — <b>their documents were NOT seeded.</b> If they are accompanying this application, change the Case Sub Type to the accompanying variant and flip <b>Re-seed Checklist → Run</b>.` }
    ).catch((e) => console.warn(`[ChecklistService] orphan note failed for ${caseRef}: ${e.message}`));
  }
  return result;
}

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

  // ── Schema-driven seeding (gated) ──
  // If enabled AND a code schema is registered for this (caseType, subType),
  // seed from the schema + Family Members composition instead of the Template
  // Board, then stop. Otherwise fall through to the Template Board flow below,
  // which is byte-for-byte the original behaviour.
  if (isSchemaDrivenEnabled(caseType, caseSubType)) {
    const schema = caseSchemaService.lookup(caseType, caseSubType);
    if (schema) {
      // The DCS webhook fires ONCE per stage transition — a single failure here
      // strands the case with an empty checklist forever. seedFromSchema's
      // reconcile is additive/idempotent, so one bounded retry is safe and
      // recovers the common case (a transient Monday hiccup that outlasted
      // mondayApi's own inner retries). On final failure we do NOT set
      // checklistApplied (keeps the case re-seedable) and, critically, make the
      // failure VISIBLE to staff instead of swallowing it silently.
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await seedFromSchema({ schema, caseRef, clientName: item.name, clientMasterItemId: itemId });
          await markChecklistApplied(itemId);
          await seedQuestionnairePrefillSafe({ caseRef, caseType, caseSubType, clientName: item.name, itemId });
          console.log(`[ChecklistService] Checklist Template Applied → Yes for ${caseRef} (schema path${attempt > 1 ? `, attempt ${attempt}` : ''})`);
          return;
        } catch (err) {
          lastErr = err;
          console.error(`[ChecklistService] Schema seeding attempt ${attempt} failed for ${caseRef}: ${err.message}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      // Both attempts failed — flag it loudly so staff can one-click re-seed.
      await flagSeedFailed(itemId, caseRef, lastErr).catch((e) =>
        console.error(`[ChecklistService] Could not flag seed failure for ${caseRef}: ${e.message}`));
      return;
    }
    console.log(`[ChecklistService] Schema-driven enabled but no schema for "${caseType}/${caseSubType}" — using Template Board.`);
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

  await seedQuestionnairePrefillSafe({ caseRef, caseType, caseSubType, clientName: item.name, itemId });
}

/**
 * Best-effort questionnaire pre-fill: seed the client's questionnaire answers
 * from the intake + pre-consult data we already hold. Never throws — a failure
 * here must not affect checklist seeding.
 */
async function seedQuestionnairePrefillSafe({ caseRef, caseType, caseSubType, clientName, itemId }) {
  try {
    await require('./htmlQuestionnaireService').seedQuestionnairePrefill({
      caseRef, caseType, caseSubType, clientName, clientMasterItemId: itemId,
    });
  } catch (err) {
    console.warn(`[ChecklistService] questionnaire pre-fill failed for ${caseRef} (non-fatal): ${err.message}`);
  }
}

/**
 * Manual re-seed for a single case — schema path only, NO intake email and NO
 * stage change. Used by the admin re-seed endpoint to:
 *   - add rows after the Family Members board is populated/corrected late, and
 *   - safely verify schema seeding on Render without the webhook cascade.
 *
 * Idempotent (the reconciler only adds missing rows). Independent of the
 * SCHEMA_DRIVEN_SEEDING flag because it is a deliberate, explicit admin action;
 * it only requires that a schema is registered for the case's (type, subType).
 *
 * @returns {Promise<{ ok, caseRef, caseType, subType, members, created, skipped, failed }>}
 * @throws  {Error} with .code 'NOT_FOUND' | 'NO_SCHEMA' for clean HTTP mapping.
 */
async function reseedByCaseRef(caseRef) {
  const ref = String(caseRef || '').trim();
  if (!ref) { const e = new Error('caseRef required'); e.code = 'BAD_REQUEST'; throw e; }

  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 1, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]) {
         items {
           id name
           column_values(ids: ["${CM_COLS.primaryCaseType}", "${CM_COLS.caseSubType}"]) { id text }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM_COLS.caseReferenceNumber, val: ref }
  );
  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) { const e = new Error(`No Client Master case found for "${ref}"`); e.code = 'NOT_FOUND'; throw e; }

  const cv = {};
  for (const c of item.column_values) cv[c.id] = c.text;
  const caseType = (cv[CM_COLS.primaryCaseType] || '').trim();
  const subType  = (cv[CM_COLS.caseSubType] || '').trim() || null;

  const schema = caseSchemaService.lookup(caseType, subType);
  if (!schema) {
    const e = new Error(`No code schema registered for "${caseType} / ${subType}" — re-seed only supports schema-driven case types`);
    e.code = 'NO_SCHEMA';
    throw e;
  }

  const composition = await compositionAdapter.readForCase(ref);
  const result = await seedFromSchema({ schema, caseRef: ref, clientName: item.name, clientMasterItemId: item.id });
  await markChecklistApplied(item.id);
  // Recovery must restore the questionnaire prefill too, not just the documents —
  // a case that failed its original auto-seed also missed its prefill, so a
  // reseed that only rebuilt docs would leave a blank, un-prefilled questionnaire.
  await seedQuestionnairePrefillSafe({ caseRef: ref, caseType, caseSubType: subType, clientName: item.name, itemId: item.id });

  return {
    ok: true,
    caseRef: ref,
    caseType, subType,
    members: composition.members.map((m) => m.role),
    created: result.created, skipped: result.skipped, failed: result.failed,
  };
}

module.exports = { onDocumentCollectionStarted, reseedByCaseRef, _internal: { isSchemaDrivenEnabled } };
