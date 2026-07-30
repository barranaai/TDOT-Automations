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
  caseSubType:   'dropdown_mm0x4t91', // written from the lead's selectedSubType when present
  paymentStatus: 'color_mm0x9fnn',    // titled "Payment Status" on the board
  caseStage:     'color_mm0x8faa',
  caseRef:       'text_mm142s49',     // read-only here (for the signed-time family top-up)
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

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * PURE: from the Client Master items sharing an email, pick the one that is the
 * SAME PERSON (case-insensitive, whitespace-normalised name match). A shared email
 * across a couple/family must NOT collapse two separate matters into one case, so
 * we only reuse on a name match; otherwise return null and a fresh case is created.
 * @returns {string|null} the matching item id
 */
function pickSamePersonMatch(items, fullName) {
  const wanted = normName(fullName);
  if (!wanted) return null; // no name to compare → safer to create a new case
  const match = (items || []).find((it) => normName(it.name) === wanted);
  return match ? match.id : null;
}

/**
 * Find an existing Client Master item for the SAME person (email + name) — dedup /
 * lost-link recovery. Returns null when the email exists only under a different
 * name (e.g. a spouse who shares the client's email), so that person gets their
 * own case instead of merging into the first one's.
 */
async function findClientMasterByEmailAndName(email, fullName) {
  if (!email) return null;
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 25, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) { items { id name } }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM.clientEmail, val: String(email) }
  );
  return pickSamePersonMatch(data?.items_page_by_column_values?.items || [], fullName);
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

// ─── Conversation-history transfer ────────────────────────────────────────────
// When a lead becomes a case, its Monday "Updates" thread (staff notes, the
// previous conversation) is copied onto the Client Master item so the record
// isn't lost. create_update cannot set the original author/timestamp, so each
// entry carries them inline; long threads are split across a few notes.
const IMPORT_MARKER = 'Conversation history imported from the lead record';

function _fmtDate(d) { if (!d) return ''; const t = new Date(d); return isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10); }

function _formatUpdateBlock(u) {
  const who = (u && u.creator && u.creator.name) || 'Unknown';
  const when = _fmtDate(u && u.created_at);
  let b = `<b>${who}</b>${when ? ' · ' + when : ''}<br>${(u && u.body) || ''}`;
  for (const r of ((u && u.replies) || [])) {
    const rwho = (r && r.creator && r.creator.name) || 'Unknown';
    const rwhen = _fmtDate(r && r.created_at);
    b += `<br>&nbsp;&nbsp;↳ <b>${rwho}</b>${rwhen ? ' · ' + rwhen : ''}: ${(r && (r.text_body || r.body)) || ''}`;
  }
  return b;
}

function _importHeader(count, part, total) {
  const base = `📋 <b>${IMPORT_MARKER}</b> (${count} update${count === 1 ? '' : 's'}, chronological — original author &amp; date preserved)`;
  return (total > 1 ? `${base} · part ${part}/${total}` : base) + '<br><br>';
}

/** PURE: lead updates (oldest-first) → Client Master update bodies (header + attributed blocks, chunked for length). */
function buildImportedHistoryChunks(updates, { maxLen = 9000 } = {}) {
  if (!updates || !updates.length) return [];
  const blocks = updates.map(_formatUpdateBlock);
  const chunks = [];
  let cur = '';
  for (const blk of blocks) {
    if (cur && cur.length + blk.length + 8 > maxLen) { chunks.push(cur); cur = ''; }
    cur += (cur ? '<br><br>' : '') + blk;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c, i) => _importHeader(updates.length, i + 1, chunks.length) + c);
}

/** Copy the lead's Updates thread onto the Client Master item. Best-effort
 *  (never blocks handoff) and idempotent (won't import twice onto a case). */
async function transferLeadUpdates(leadId, cmItemId) {
  if (!leadId || !cmItemId) return 0;
  try {
    const data = await mondayApi.query(
      `query($id:[ID!]){ items(ids:$id){ updates(limit:100){ body text_body created_at creator{ name } replies{ text_body created_at creator{ name } } } } }`,
      { id: [String(leadId)] });
    const raw = (data && data.items && data.items[0] && data.items[0].updates) || [];
    if (!raw.length) return 0;
    const updates = raw.slice().reverse(); // Monday returns newest-first → re-post oldest-first

    // Idempotency: never import twice onto the same case.
    const cmData = await mondayApi.query(
      `query($id:[ID!]){ items(ids:$id){ updates(limit:50){ body } } }`, { id: [String(cmItemId)] });
    const already = ((cmData && cmData.items && cmData.items[0] && cmData.items[0].updates) || [])
      .some((u) => (u.body || '').includes(IMPORT_MARKER));
    if (already) { console.log(`[Handoff] Lead updates already imported to CM ${cmItemId} — skipping`); return 0; }

    const bodies = buildImportedHistoryChunks(updates);
    for (const body of bodies) {
      await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
        { i: String(cmItemId), b: body });
    }
    console.log(`[Handoff] Imported ${updates.length} lead update(s) ${leadId} → Client Master ${cmItemId} (${bodies.length} note${bodies.length === 1 ? '' : 's'})`);
    return updates.length;
  } catch (err) {
    console.warn(`[Handoff] Update transfer ${leadId} → ${cmItemId} failed: ${err.message}`);
    return 0;
  }
}

/**
 * Create (or reuse) the Client Master case for a lead.
 * @param {object} [opts]
 * @param {boolean} [opts.presigned] — the case is being opened BEFORE the
 *   retainer is signed (direct retainer clients enter the case lifecycle at
 *   creation). Skips the signed-state stamps — Payment Status stays empty and
 *   the lead's conversion status is untouched; ensureSignedState() applies
 *   them when the client actually signs.
 */
async function _doHandoff(leadId, { presigned = false } = {}) {
  const lead = await leadService.getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.clientMasterItemId) {
    console.log(`[Handoff] Lead ${leadId} already handed off → ${lead.clientMasterItemId}`);
    return lead.clientMasterItemId;
  }

  // Only email + a real name are genuinely required. The case type is NOT —
  // resolveValidatedCaseType already falls back (confirmedCaseType → canonical
  // map → defer-to-staff with a note), so requiring caseTypeInterest (which only
  // the public intake form sets) would wrongly block a staff-created or
  // confirmedCaseType-only lead from ever getting a Client Master case.
  const missing = ['email'].filter((k) => !lead[k]);
  if (!lead.fullName || lead.fullName === lead.id) missing.push('fullName');
  if (missing.length) throw new Error(`Lead ${leadId} missing required field(s) for handoff: ${missing.join(', ')}`);

  // Pre-create dedup: the SAME person may already have a case (lost Lead link).
  // Matched on email AND name so a shared family email never merges two matters.
  const existing = await findClientMasterByEmailAndName(lead.email, lead.fullName);
  if (existing) {
    console.log(`[Handoff] Reusing existing Client Master ${existing} for lead ${leadId} (matched by email + name)`);
    await leadService.updateLead(leadId, presigned
      ? { clientMasterItemId: existing }
      : { clientMasterItemId: existing, conversionStatus: 'Retained — Awaiting Payment' });
    // Preserve the lead's conversation history on the (reused) case.
    await transferLeadUpdates(leadId, existing);
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
  // presigned (direct retainer, case-first): Payment Status stays EMPTY — the
  // client hasn't signed anything yet; ensureSignedState() stamps it at signing.
  const createCols = {
    [CM.clientEmail]:   lead.email,
    ...(presigned ? {} : { [CM.paymentStatus]: { label: 'Signed (Unpaid)' } }),
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

  await leadService.updateLead(leadId, presigned
    ? { clientMasterItemId: newId }
    : { clientMasterItemId: newId, conversionStatus: 'Retained — Awaiting Payment' });

  // Preserve the lead's conversation history (its Updates thread) on the new case.
  await transferLeadUpdates(leadId, newId);

  // Record the consultation's assigned RCIC on the new case (best-effort note),
  // so the routed consultant carries across the handoff instead of being lost.
  if (lead.assignedConsultant) {
    try {
      await mondayApi.query(`mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
        { itemId: String(newId), body: `👤 Consultation handled by: ${lead.assignedConsultant}` });
    } catch (_) {}
  }

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
      // Carry the lead's chosen sub-type (direct-retainer form / retainer plan)
      // onto the case — a blank Case Sub Type on a multi-variant case type
      // blocks checklist seeding (see checklistService's blank-sub-type gate;
      // live incident 2026-CEC-PR-002). Labels are validated upstream, so
      // create_labels_if_missing stays OFF (a junk value must never pollute
      // the Client Master dropdown).
      const subType = String(lead.selectedSubType || '').trim();
      if (subType) {
        await mondayApi.query(
          `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
             change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
           }`,
          { boardId: String(clientMasterBoardId), itemId: String(newId),
            cols: JSON.stringify({ [CM.caseSubType]: { labels: [subType] } }) }
        ).then(() => console.log(`[Handoff] Lead ${leadId} → CM ${newId} · Sub Type "${subType}"`))
         .catch((err) => console.warn(`[Handoff] Sub Type "${subType}" not accepted for ${newId} (${err.message}) — staff can set it manually`));
      }
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

/**
 * Apply the SIGNED-state effects to a lead whose case ALREADY exists — the
 * case-first (direct retainer) flow opens the case at creation with neutral
 * labels, so signing must (idempotently) catch it up:
 *   • CM Payment Status → 'Signed (Unpaid)' — only when EMPTY (never downgrades
 *     an existing 'Paid', e.g. a walk-in who prepaid a milestone).
 *   • Lead conversion status → 'Retained — Awaiting Payment' — unless the lead
 *     is already Retained (a redelivered signed webhook must never downgrade).
 *   • Family Members top-up: the consultant enters family in the retainer panel
 *     AFTER the early case-open (whose ref-time family hook found nothing), so
 *     materialize them now (createFromLead skips boards staff already curated).
 * For the classic signed-time handoff all three are no-ops.
 */
async function ensureSignedState(leadId) {
  const lead = await leadService.getLead(leadId);
  if (!lead || !lead.clientMasterItemId) return;

  // ONCE-ONLY: a lead that already reached signed-state is skipped ENTIRELY —
  // the classic flow (whose fresh handoff just stamped these labels) and every
  // re-fired webhook (a staff date correction, a Documenso redelivery) are true
  // no-ops: no CM reads, no re-stamps of a staff-cleared Payment Status, and no
  // resurrection of staff-curated Family Members rows.
  const cs = (lead.conversionStatus || '').trim();
  if (cs === 'Retained' || cs === 'Retained — Awaiting Payment') return;

  const cmItemId = lead.clientMasterItemId;
  let payText = '', caseRef = '';
  try {
    const d = await mondayApi.query(
      `query($ids:[ID!]){ items(ids:$ids){ column_values(ids:["${CM.paymentStatus}","${CM.caseRef}"]){ id text } } }`,
      { ids: [String(cmItemId)] });
    const cvs = (d?.items?.[0]?.column_values) || [];
    payText = ((cvs.find((c) => c.id === CM.paymentStatus) || {}).text || '').trim();
    caseRef = ((cvs.find((c) => c.id === CM.caseRef) || {}).text || '').trim();
  } catch (err) {
    console.warn(`[Handoff] ensureSignedState read failed for CM ${cmItemId}: ${err.message}`);
    return; // fail closed — better to leave labels than write against unknown state
  }

  // Re-read the lead once just before writing — a payment or the Retained flip
  // may have landed while we read the case (walk-ins pay at the desk).
  const fresh = (await leadService.getLead(leadId).catch(() => null)) || lead;
  const paidNow = !!(fresh.retainerPaid && String(fresh.retainerPaid).trim());
  const csNow = (fresh.conversionStatus || '').trim();

  if (paidNow) {
    // PAID-FIRST: the payment's case advance was deferred while unsigned
    // (recordRetainerPaid). Signing is the moment onboarding may start — run
    // the deferred Paid advance; the Retained flip (signed+paid, both-gated)
    // follows in this same signed chain via maybeMarkRetained, so no interim
    // conversion label is written here.
    await require('./paymentService').advanceCaseToPaid(fresh)
      .catch((err) => console.warn(`[Handoff] Deferred paid-advance failed for lead ${leadId}: ${err.message}`));
  } else {
    // Stamp over anything EXCEPT 'Paid' — Monday board automations stamp their
    // own labels on new items (observed live: "Alreaday Sent" [sic] appears on
    // creation), and the first signing must override them. Staff-cleared labels
    // are protected by the once-only gate above, never by this condition.
    if (payText.toLowerCase() !== 'paid' && payText !== 'Signed (Unpaid)') {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols, create_labels_if_missing: true) { id }
         }`,
        { boardId: String(clientMasterBoardId), itemId: String(cmItemId),
          cols: JSON.stringify({ [CM.paymentStatus]: { label: 'Signed (Unpaid)' } }) }
      ).catch((err) => console.warn(`[Handoff] Payment Status stamp failed for CM ${cmItemId}: ${err.message}`));
    }
    if (csNow !== 'Retained' && csNow !== 'Retained — Awaiting Payment') {
      await leadService.updateLead(leadId, { conversionStatus: 'Retained — Awaiting Payment' })
        .catch((err) => console.warn(`[Handoff] conversionStatus stamp failed for lead ${leadId}: ${err.message}`));
    }
  }

  // Family top-up with the IN-SCOPE signing lead — the consultant entered the
  // family AFTER the early case-open. Never resolved via the first-hit
  // clientMasterItemId lookup: when two leads share one case (dedup reuse), that
  // lookup can return the OTHER lead and silently drop the entered family.
  if (caseRef) {
    await require('./familyCompositionService').createFromLead({ lead: fresh, caseRef, cmItemId })
      .catch((err) => console.warn(`[Handoff] Signed-time family top-up failed for ${caseRef}: ${err.message}`));
  }
}

/** Idempotent entry point. Collapses concurrent calls for the same lead. */
async function onRetainerSigned({ leadId }) {
  const key = String(leadId);
  if (_inFlight.has(key)) return _inFlight.get(key);
  const p = (async () => {
    const cmId = await _doHandoff(leadId);
    // Early-opened cases (direct retainer) get their signed-state labels +
    // consultant-entered family applied now; for fresh handoffs this no-ops.
    try { await ensureSignedState(leadId); }
    catch (err) { console.warn(`[Handoff] ensureSignedState failed for ${leadId}: ${err.message}`); }
    return cmId;
  })();
  _inFlight.set(key, p);
  try { return await p; } finally { _inFlight.delete(key); }
}

/**
 * Case-first entry (direct retainer clients): open the Client Master case at
 * client creation, BEFORE any signing — neutral labels, case ref + folder +
 * history exactly like a handoff. Idempotent + concurrency-collapsed.
 */
async function openCaseEarly({ leadId }) {
  const key = `early-${leadId}`;
  if (_inFlight.has(key)) return _inFlight.get(key);
  const p = _doHandoff(leadId, { presigned: true });
  _inFlight.set(key, p);
  try { return await p; } finally { _inFlight.delete(key); }
}

module.exports = { onRetainerSigned, openCaseEarly, ensureSignedState, resolveCaseType, resolveValidatedCaseType, pickSamePersonMatch, transferLeadUpdates, buildImportedHistoryChunks };
