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

// memberKey base per board type (matches the questionnaire convention so the
// manifest reuses the same keys); multi-allowed types get a 1-based index.
const KEY_BASE = {
  'Spouse': 'spouse', 'Dependent Child': 'child', 'Parent': 'parent',
  'Sibling': 'sibling', 'Sponsor': 'sponsor', 'Worker Spouse': 'worker-spouse',
};
const INDEXED_TYPES = new Set(['Dependent Child', 'Parent', 'Sibling']);

/**
 * PURE: the consultant's retainer-panel family list → the member rows that
 * should exist. ONLY accompanying members get rows (they drive the per-member
 * checklist + questionnaire); non-accompanying members are recorded on the lead
 * but never materialised. Returns null when the consultant never set a list
 * (so the caller falls back to the intake guesses); returns [] when the
 * consultant explicitly set no accompanying family.
 */
function planMembersFromConsultant(lead) {
  if (!lead.retainerFamilyMembers) return null;
  let arr;
  try { arr = JSON.parse(lead.retainerFamilyMembers); } catch (_) { return null; }
  if (!Array.isArray(arr)) return null;

  const counts = {};
  const used = new Set();
  const rows = [];
  for (const m of arr) {
    const type = String((m && m.type) || '').trim();
    const base = KEY_BASE[type];
    if (!base) continue;
    const accompanying = !!(m && (m.accompanying === true || m.accompanying === 'Yes' || m.accompanying === 'true' || m.accompanying === 1));
    if (!accompanying) continue;
    let key;
    if (INDEXED_TYPES.has(type)) { counts[base] = (counts[base] || 0) + 1; key = `${base}-${counts[base]}`; }
    else { key = base; }
    // Guarantee a unique memberKey even if a singleton type appears twice (e.g. two
    // Spouses by mistake) — index on collision (spouse, spouse-1, …) so the board
    // never gets two rows with the same key.
    while (used.has(key)) { counts[base] = (counts[base] || 0) + 1; key = `${base}-${counts[base]}`; }
    used.add(key);
    const name = String((m && m.name) || '').trim() || `${type} (consultant-set)`;
    rows.push({ memberType: type, name, memberKey: key });
  }
  return rows;
}

/** PURE: staff-facing note summarising what was created. */
function buildFamilyNote(planned, source) {
  const summary = planned.map((r) => `${r.name} (${r.memberType})`).join(' · ') || 'none';
  if (source === 'consultant') {
    return `👪 <b>Family members set by the consultant</b> (retainer panel): ${summary}.<br>` +
      `${planned.length} accompanying member(s) added to the Family Members board — they drive the per-member ` +
      `document checklist and questionnaire sections. Re-seed the checklist if this case was already seeded.`;
  }
  return `👪 <b>Family members created from the intake form</b>: ${summary}.<br>` +
    `${planned.length} row(s) added with placeholder names — please fill in real names, dates of birth, and any flags.<br><br>` +
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
  // The consultant's retainer-panel list is authoritative when present (even if
  // it yields zero accompanying members); otherwise fall back to intake guesses.
  const consultantRows = planMembersFromConsultant(lead);
  const source  = consultantRows !== null ? 'consultant' : 'intake';
  const planned = consultantRows !== null ? consultantRows : planMembersFromLead(lead);
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
  console.log(`[Family] Created ${created} Family Members row(s) for ${caseRef} from ${source === 'consultant' ? 'the consultant-set list' : 'intake answers'}`);

  // Tell staff on the case what exists and what they still decide (sub type).
  if (cmItemId) {
    await mondayApi.query(
      `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
      { i: String(cmItemId), body: buildFamilyNote(planned, source) }
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

module.exports = { createFromLead, createFamilyRowsForItem, planMembersFromLead, planMembersFromConsultant, buildFamilyNote };
