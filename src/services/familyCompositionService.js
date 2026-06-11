/**
 * Family Composition Service — closes the gap between the intake form and the
 * Family Members board (until now, the board only ever had a READER —
 * compositionAdapter — and staff created every row by hand).
 *
 * The intake form captures composition (spouse? accompanying? children?).
 * When the case REFERENCE is born (Family Members rows key on it), this
 * service materialises those answers as board rows:
 *
 *   Spouse row            ← hasSpouse = Yes
 *   Dependent Child × N   ← childrenCount
 *
 * Rows carry placeholder names ("Spouse (from intake)", "Child 1 (from
 * intake)") and stable memberKeys; staff refine names/DOB/flags later — the
 * schema seeder only needs ROLE PRESENCE to activate the right document sets.
 * Accompanying-or-not is a SUB TYPE decision (different schemas), so it is
 * surfaced to staff as a note, not encoded in the rows.
 *
 * Idempotent + staff-respecting: if the case already has ANY member rows,
 * nothing is created (a curated board is never polluted).
 */

'use strict';

const boardCfg = require('../data/familyMembersBoard.json');

/** PURE: intake answers → the member rows that should exist. */
function planMembersFromLead(lead) {
  const rows = [];
  if (lead.hasSpouse === 'Yes') {
    rows.push({ memberType: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse' });
  }
  const n = parseInt(String(lead.childrenCount || '0'), 10);
  for (let i = 1; i <= Math.min(Number.isFinite(n) ? n : 0, 12); i++) {
    rows.push({ memberType: 'Dependent Child', name: `Child ${i} (from intake)`, memberKey: `child-${i}` });
  }
  return rows;
}

/** PURE: staff-facing note summarising what was created + the sub-type nudge. */
function buildFamilyNote(lead, planned) {
  const parts = [];
  if (lead.hasSpouse === 'Yes') {
    parts.push(`spouse (accompanying: ${lead.spouseAccompanying || 'not stated'})`);
  }
  const n = parseInt(String(lead.childrenCount || '0'), 10) || 0;
  if (n > 0) parts.push(`${n} dependent child(ren) (accompanying: ${lead.childrenAccompanying || 'not stated'})`);

  return `👪 <b>Family members created from the intake form</b>: ${parts.join(' · ')}.<br>` +
    `${planned.length} row(s) added to the Family Members board with placeholder names — ` +
    `please fill in names, dates of birth, and any flags.<br><br>` +
    `<b>Reminder:</b> set the case's <b>Sub Type</b> (see the Sub Type hint column) — whether family members ` +
    `are accompanying decides which document checklist applies. Re-seed adds their documents without touching existing rows.`;
}

/**
 * Create Family Members rows for a case from the lead's intake answers.
 * Called when the case reference is assigned (rows key on the reference).
 *
 * @returns {Promise<number>} rows created (0 = nothing to do / already curated)
 */
async function createFromLead({ lead, caseRef, cmItemId }) {
  if (!lead || !caseRef) return 0;
  const planned = planMembersFromLead(lead);
  if (!planned.length) return 0;

  // Never pollute a board staff already curated for this case.
  const compositionAdapter = require('./compositionAdapter');
  const existing = await compositionAdapter.readForCase(caseRef);
  if (existing && existing.members && existing.members.length > 0) {
    console.log(`[Family] ${caseRef} already has ${existing.members.length} member row(s) — intake auto-create skipped`);
    return 0;
  }

  const mondayApi = require('./mondayApi');
  const C = boardCfg.columns;
  let created = 0;
  for (const row of planned) {
    const cols = {
      [C.caseReference]: caseRef,
      [C.memberType]:    { label: row.memberType },
      [C.memberKey]:     row.memberKey,
    };
    if (cmItemId && C.case) cols[C.case] = { item_ids: [Number(cmItemId)] };
    await mondayApi.query(
      `mutation($b: ID!, $n: String!, $c: JSON!) {
         create_item(board_id: $b, item_name: $n, column_values: $c, create_labels_if_missing: false) { id }
       }`,
      { b: String(boardCfg.boardId), n: row.name, c: JSON.stringify(cols) }
    );
    created++;
  }
  console.log(`[Family] Created ${created} Family Members row(s) for ${caseRef} from intake answers`);

  // Tell staff on the case what exists and what they still decide (sub type).
  if (cmItemId) {
    await mondayApi.query(
      `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
      { i: String(cmItemId), body: buildFamilyNote(lead, planned) }
    ).catch((err) => console.warn(`[Family] Staff note failed for ${caseRef}: ${err.message}`));
  }
  return created;
}

/**
 * Hook for caseRefService: ref was just assigned to a Client Master item —
 * find the originating lead (if any) and materialise its family answers.
 * No-op for cases without a Phase 2 lead (manually created clients).
 */
async function createFamilyRowsForItem({ itemId, caseRef }) {
  const leadService = require('./leadService');
  const lead = await leadService.findByColumnValue('clientMasterItemId', String(itemId));
  if (!lead) return 0;
  return createFromLead({ lead, caseRef, cmItemId: itemId });
}

module.exports = { createFromLead, createFamilyRowsForItem, planMembersFromLead, buildFamilyNote };
