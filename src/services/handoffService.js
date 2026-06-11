/**
 * Handoff Service — the Phase 2 → Phase 1 bridge (WS6).
 *
 * The ONLY Phase 2 service that CREATES items on the Client Master Board.
 * Triggered by retainerService2 after the retainer is signed.
 *
 * Hardened after adversarial review (3 critical issues fixed):
 *
 *  1. Idempotency — an in-flight map collapses concurrent/re-delivered calls,
 *     a pre-create email lookup reuses an existing case, and a post-create
 *     reconciliation deletes a duplicate if another call won the race. So a
 *     signed lead yields at most ONE Client Master item.
 *
 *  2. Case reference — Monday does NOT emit a column-change event for values
 *     set INSIDE create_item, so setting Case Type there would never trigger
 *     Phase 1's caseRefService. We therefore create the item WITHOUT Case Type,
 *     then set Case Type in a SEPARATE mutation, which DOES fire the webhook →
 *     caseRefService assigns the reference.
 *
 *  3. Case type value — the public form only captures a high-level interest
 *     (e.g. "Work Permit"). We use the staff-set "Confirmed Case Type" if
 *     present; else map the 3 unambiguous high-level types; else leave Case
 *     Type unset and post a Monday Update asking a case officer to set it
 *     (which then generates the reference). We never invent junk labels.
 */

'use strict';

const mondayApi   = require('./mondayApi');
const leadService = require('./leadService');
const { clientMasterBoardId, cmColumns } = require('../../config/monday');

const CM = {
  clientEmail:   'text_mm0xw6bp',
  caseType:      'dropdown_mm0xd1qn', // setting this (separately) triggers caseRefService
  paymentStatus: 'color_mm0x9fnn',    // titled "Payment Status" on the board
  caseStage:     'color_mm0x8faa',
  oneDriveFolderId:   cmColumns.oneDriveFolderId,
  oneDriveFolderLink: cmColumns.oneDriveFolderLink,
};

// The 3 high-level lead-form values that map unambiguously to a canonical
// Client Master case type. The other 4 ("Work Permit", "Permanent Residence",
// "Spousal Sponsorship", "Other") need a human — they are deferred.
const LEAD_TO_CANONICAL = {
  'Study Permit': 'Study Permit',
  'Visitor Visa': 'Visitor Visa',
  'Citizenship':  'Citizenship',
};

const _inFlight = new Map(); // leadId → Promise (collapses concurrent calls in-process)
let _cachedGroupId = null;

async function getHandoffGroupId() {
  if (_cachedGroupId) return _cachedGroupId;
  if (process.env.MONDAY_CM_HANDOFF_GROUP_ID) return (_cachedGroupId = process.env.MONDAY_CM_HANDOFF_GROUP_ID);
  const data = await mondayApi.query(
    `query($boardId: ID!) { boards(ids: [$boardId]) { groups { id title } } }`,
    { boardId: String(clientMasterBoardId) }
  );
  const groups = data?.boards?.[0]?.groups || [];
  const match = groups.find((g) => /retainer sent|new client|active|main/i.test(g.title))
             || groups.find((g) => /lead/i.test(g.title))
             || groups[0];
  if (!match) throw new Error('No groups found on Client Master Board');
  console.log(`[Handoff] Using Client Master group: "${match.title}" (${match.id})`);
  return (_cachedGroupId = match.id);
}

/** Find an existing Client Master item by Client Email (dedup / lost-link recovery). */
async function findClientMasterByEmail(email) {
  if (!email) return null;
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 1, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) { items { id } }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM.clientEmail, val: String(email) }
  );
  return data?.items_page_by_column_values?.items?.[0]?.id || null;
}

/** Resolve the specific Client Master case type, or null if it must be set by staff. */
function resolveCaseType(lead) {
  const confirmed = (lead.confirmedCaseType || '').trim();
  if (confirmed) return confirmed;
  return LEAD_TO_CANONICAL[(lead.caseTypeInterest || '').trim()] || null;
}

/**
 * Resolve AND validate against the live canon — the Client Master board's
 * Primary Case Type labels are the approved standard, so a value that isn't
 * on that list (stale dropdown option, renamed type) is never written; the
 * case defers to staff instead, with the rejected value named in the note.
 */
async function resolveValidatedCaseType(lead) {
  const candidate = resolveCaseType(lead);
  if (!candidate) return { caseType: null, rejected: null };
  try {
    const registry = require('./caseTypeRegistryService');
    if (await registry.isCanonicalCaseType(candidate)) return { caseType: candidate, rejected: null };
    console.warn(`[Handoff] "${candidate}" is not an approved Client Master case type — deferring to staff`);
    return { caseType: null, rejected: candidate };
  } catch (err) {
    // Registry unreachable — fall back to optimistic write; the Monday write
    // itself still rejects unknown labels (create_labels_if_missing is off).
    console.warn(`[Handoff] Case-type registry unavailable (${err.message}) — proceeding unvalidated`);
    return { caseType: candidate, rejected: null };
  }
}

async function _doHandoff(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.clientMasterItemId) {
    console.log(`[Handoff] Lead ${leadId} already handed off → ${lead.clientMasterItemId}`);
    return lead.clientMasterItemId;
  }

  const missing = ['email', 'caseTypeInterest'].filter((k) => !lead[k]);
  if (!lead.fullName || lead.fullName === lead.id) missing.push('fullName');
  if (missing.length) throw new Error(`Lead ${leadId} missing required field(s) for handoff: ${missing.join(', ')}`);

  // Pre-create dedup: an item with this email may already exist (lost Lead link).
  const existing = await findClientMasterByEmail(lead.email);
  if (existing) {
    console.log(`[Handoff] Reusing existing Client Master ${existing} for lead ${leadId} (matched by email)`);
    await leadService.updateLead(leadId, { clientMasterItemId: existing, conversionStatus: 'Retained — Awaiting Payment' });
    // Carry the intake OneDrive folder onto the reused case too (best-effort),
    // so the rename hook can find it when the case ref is assigned.
    if (lead.oneDriveFolderId) {
      const reuseCols = { [CM.oneDriveFolderId]: lead.oneDriveFolderId };
      if (lead.oneDriveFolderLink) reuseCols[CM.oneDriveFolderLink] = { url: lead.oneDriveFolderLink, text: 'Open client folder' };
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        { boardId: String(clientMasterBoardId), itemId: String(existing), cols: JSON.stringify(reuseCols) }
      ).catch((err) => console.warn(`[Handoff] Folder carry to reused CM ${existing} failed: ${err.message}`));
    }
    return existing;
  }

  const groupId = await getHandoffGroupId();

  // Create WITHOUT Case Type (Case Type is set separately below so the webhook fires).
  const createCols = {
    [CM.clientEmail]:   lead.email,
    [CM.paymentStatus]: { label: 'Signed (Unpaid)' },
    [CM.caseStage]:     { label: 'Pre-Onboarding' },
  };
  // Carry the intake-stage OneDrive folder across (caseRefService renames it
  // to "{name} - {caseRef}" when the reference is generated).
  if (lead.oneDriveFolderId) {
    createCols[CM.oneDriveFolderId] = lead.oneDriveFolderId;
    if (lead.oneDriveFolderLink) {
      createCols[CM.oneDriveFolderLink] = { url: lead.oneDriveFolderLink, text: 'Open client folder' };
    }
  }
  const result = await mondayApi.query(
    `mutation($boardId: ID!, $groupId: String!, $name: String!, $cols: JSON!) {
       create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $cols, create_labels_if_missing: true) { id }
     }`,
    {
      boardId: String(clientMasterBoardId), groupId, name: lead.fullName,
      cols: JSON.stringify(createCols),
    }
  );
  const newId = result?.create_item?.id;
  if (!newId) throw new Error(`create_item returned no id for lead ${leadId}`);

  // Post-create reconciliation: did another call persist a different item first?
  const reread = await leadService.getLead(leadId);
  if (reread?.clientMasterItemId && reread.clientMasterItemId !== newId) {
    console.warn(`[Handoff] Race detected for lead ${leadId} — deleting duplicate ${newId}, keeping ${reread.clientMasterItemId}`);
    try { await mondayApi.query(`mutation($id: ID!){ delete_item(item_id: $id){ id } }`, { id: String(newId) }); } catch (_) {}
    return reread.clientMasterItemId;
  }

  await leadService.updateLead(leadId, { clientMasterItemId: newId, conversionStatus: 'Retained — Awaiting Payment' });

  // Set the specific Case Type separately → triggers Phase 1 caseRefService.
  // The value is validated against the LIVE Client Master canon first (the
  // approved standard); create_labels_if_missing stays OFF as a second wall,
  // so a junk/typo value can never pollute the Client Master dropdown.
  const { caseType, rejected } = await resolveValidatedCaseType(lead);
  let caseTypeSet = false;
  if (caseType) {
    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        { boardId: String(clientMasterBoardId), itemId: String(newId),
          cols: JSON.stringify({ [CM.caseType]: { labels: [caseType] } }) }
      );
      caseTypeSet = true;
      console.log(`[Handoff] Lead ${leadId} → Client Master ${newId} · Case Type "${caseType}"`);
    } catch (err) {
      console.warn(`[Handoff] Case Type "${caseType}" not accepted for ${newId} (${err.message}) — deferring to staff`);
    }
  }

  if (!caseTypeSet) {
    const interest = lead.confirmedCaseType || lead.caseTypeInterest || '(none)';
    const note = `⚠ Case officer: please set the Primary Case Type to generate the case reference.\n\n` +
      `This client retained via the Phase 2 lead funnel. Their stated interest was: "${interest}".\n` +
      (rejected ? `The value "${rejected}" on the lead is NOT one of the approved Client Master case types, so it was not applied.\n` : '') +
      `The exact case type wasn't auto-confirmed at handoff, so no reference has been assigned yet. ` +
      `Selecting the Primary Case Type will automatically generate it.`;
    try {
      await mondayApi.query(`mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
        { itemId: String(newId), body: note });
    } catch (_) {}
    console.log(`[Handoff] Lead ${leadId} → Client Master ${newId} · Case Type DEFERRED to staff (interest: "${lead.caseTypeInterest}")`);
  }

  return newId;
}

/** Idempotent entry point. Collapses concurrent calls for the same lead. */
async function onRetainerSigned({ leadId }) {
  const key = String(leadId);
  if (_inFlight.has(key)) return _inFlight.get(key);
  const p = _doHandoff(leadId);
  _inFlight.set(key, p);
  try { return await p; } finally { _inFlight.delete(key); }
}

module.exports = { onRetainerSigned, resolveCaseType, resolveValidatedCaseType };
