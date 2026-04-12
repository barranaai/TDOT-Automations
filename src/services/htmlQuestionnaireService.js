/**
 * HTML Questionnaire Service
 *
 * Handles all server-side logic for the new HTML-form questionnaire system:
 *   • Validating client access via token
 *   • Loading / saving questionnaire data as CSV files in OneDrive
 *   • Updating Monday.com Q readiness when the client submits
 *   • Building the injection script that makes each static HTML file dynamic
 *   • Assembling the final HTML sent to the browser
 */

'use strict';

const fs               = require('fs');
const path             = require('path');
const mondayApi        = require('./mondayApi');
const oneDrive         = require('./oneDriveService');
const stageGateService = require('./stageGateService');
const { loadThresholds } = require('./caseReadinessService');
const { clientMasterBoardId } = require('../../config/monday');
const { FORMS_DIR, resolveForm } = require('../../config/questionnaireFormMap');

// ─── Column IDs — Client Master Board ────────────────────────────────────────

const BASE_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

const CM = {
  caseRef:           'text_mm142s49',
  caseType:          'dropdown_mm0xd1qn',
  caseSubType:       'dropdown_mm0x4t91',
  accessToken:       'text_mm0x6haq',
  qReadiness:        'numeric_mm0x9dea',
  qCompletionStatus: 'color_mm0x9s08',   // labels: Done / Working on it
  // Extra columns read during stage-gate check (not written)
  caseStage:         'color_mm0x8faa',
  docReadiness:      'numeric_mm0x5g9x',
  blockingDocCount:  'numeric_mm0xje6p', // written by daily readiness scan
  automationLock:    'color_mm0x3x1x',
};

const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';

// ─── RFC 4180 CSV helpers ─────────────────────────────────────────────────────

// ─── JSON data helpers ────────────────────────────────────────────────────────
// Storing form data as JSON (same approach as officer flags) — simpler,
// more reliable, and easier to debug than CSV.

function toJson(fields, completionPct) {
  return JSON.stringify({ fields, completionPct: completionPct || 0, savedAt: new Date().toISOString() }, null, 2);
}

function parseJson(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;           // legacy plain array
    if (Array.isArray(obj.fields)) return obj.fields;
    return [];
  } catch {
    return [];
  }
}

// ─── Legacy CSV fallback (read-only — for any existing .csv files) ────────────

function parseCsvLegacy(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  for (let i = 1; i < lines.length; i++) {       // skip header row
    const line = lines[i].trim();
    if (!line) continue;
    // Simple split on comma — values were always quoted so strip outer quotes
    const parts = line.match(/("(?:[^"]|"")*"|[^,]*),?/g) || [];
    const unquote = s => s.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"');
    const [section, label, key, value] = parts.map(unquote);
    if (key) result.push({ section: section || '', label: label || '', key, value: value || '' });
  }
  return result;
}

// ─── Monday.com helpers ───────────────────────────────────────────────────────

/**
 * Look up a Client Master item by case reference number.
 * Returns { itemId, clientName, caseType, caseSubType, accessToken } or null.
 */
async function lookupCase(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 1, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items {
           id
           name
           column_values(ids: [
             "${CM.caseRef}", "${CM.caseType}", "${CM.caseSubType}",
             "${CM.accessToken}"
           ]) { id text }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM.caseRef, val: caseRef }
  );

  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return null;

  const col = (id) => item.column_values.find(c => c.id === id)?.text?.trim() || '';

  return {
    itemId:      item.id,
    /* Use the item's display name (same source as the document-upload service)
     * so that questionnaire CSVs land in the same OneDrive folder as documents. */
    clientName:  (item.name || '').trim() || 'Unknown Client',
    caseType:    col(CM.caseType),
    caseSubType: col(CM.caseSubType) || null,
    accessToken: col(CM.accessToken),
  };
}

// ─── Access validation ────────────────────────────────────────────────────────

/**
 * Validate that caseRef exists and the provided token matches the stored token.
 *
 * @returns {{ itemId, clientName, caseType, caseSubType, formFiles }}
 * @throws  Error with a user-safe message on invalid access
 */
async function validateAccess(caseRef, token) {
  if (!caseRef || !token) throw new Error('Missing case reference or access token.');

  const entry = await lookupCase(caseRef);
  if (!entry) throw new Error('Case not found.');

  if (!entry.accessToken || entry.accessToken !== token) {
    throw new Error('Invalid or expired access token.');
  }

  const formFiles = resolveForm(entry.caseType, entry.caseSubType);

  return { ...entry, formFiles };
}

// ─── OneDrive data operations ─────────────────────────────────────────────────

function dataFilename(caseRef, formKey) {
  return `questionnaire-${caseRef}-${formKey}.json`;
}

/** @deprecated Only used for backward-compat fallback read of old .csv files. */
function csvFilename(caseRef, formKey) {
  return `questionnaire-${caseRef}-${formKey}.csv`;
}

/**
 * Load previously saved questionnaire data for a given form.
 * Reads the JSON file first; falls back to the legacy CSV if JSON is not found.
 * Returns an array of { section, label, key, value } objects, or [] if none saved.
 */
async function loadFormData({ clientName, caseRef, formKey }) {
  try {
    // ── Primary: JSON file ──────────────────────────────────────────────────
    const jsonBuf = await oneDrive.readFile({
      clientName,
      caseRef,
      subfolder: QUESTIONNAIRE_SUBFOLDER,
      filename:  dataFilename(caseRef, formKey),
    });
    if (jsonBuf) {
      const fields = parseJson(jsonBuf.toString('utf8'));
      console.log(`[HtmlQ] Loaded ${fields.length} fields (JSON) for ${caseRef}/${formKey}`);
      return fields;
    }

    // ── Fallback: legacy CSV file ────────────────────────────────────────────
    const csvBuf = await oneDrive.readFile({
      clientName,
      caseRef,
      subfolder: QUESTIONNAIRE_SUBFOLDER,
      filename:  csvFilename(caseRef, formKey),
    });
    if (csvBuf) {
      const fields = parseCsvLegacy(csvBuf.toString('utf8'));
      console.log(`[HtmlQ] Loaded ${fields.length} fields (CSV legacy) for ${caseRef}/${formKey}`);
      return fields;
    }

    return [];
  } catch (err) {
    console.error(`[HtmlQ] loadFormData failed for ${caseRef}/${formKey}:`, err.message);
    return [];
  }
}

/**
 * Save questionnaire data to OneDrive as JSON, replacing any previous file.
 *
 * @param {{ clientName, caseRef, itemId, formKey, fields, completionPct }} params
 *   fields: [{ section, label, key, value }]
 */
async function saveFormData({ clientName, caseRef, itemId, formKey, fields, completionPct }) {
  const content  = toJson(fields, completionPct);
  const buffer   = Buffer.from(content, 'utf8');
  const filename = dataFilename(caseRef, formKey);

  // Ensure the client folder exists (safe to call even if it was already created)
  await oneDrive.ensureClientFolder({ clientName, caseRef });

  await oneDrive.uploadFile({
    clientName,
    caseRef,
    category: QUESTIONNAIRE_SUBFOLDER,
    filename,
    buffer,
    mimeType: 'application/json',
  });

  const filled = fields.filter(f => f.value && f.value.trim()).length;
  console.log(`[HtmlQ] Saved ${fields.length} fields (${filled} non-empty) as JSON for ${caseRef}/${formKey} (${completionPct}%)`);
}

// ─── Member manifest operations ──────────────────────────────────────────────
// Stores the list of members (PA + spouse/child/parent/sibling) for a case.
// File: questionnaire-{caseRef}-members.json in the Questionnaire subfolder.
//
// The manifest is created lazily — if it doesn't exist, the system assumes
// a single "primary" member (the Principal Applicant). When a client adds
// a member via the overview page, the manifest is created/updated.

const MEMBERS_FILENAME_PREFIX = 'questionnaire-members-';

function membersFilename(caseRef) {
  return `${MEMBERS_FILENAME_PREFIX}${caseRef}.json`;
}

/** Default member list when no manifest exists — just the primary applicant. */
function defaultMembers() {
  return [
    { key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant', addedAt: new Date().toISOString() },
  ];
}

/**
 * Human-friendly label for a member type + index.
 * E.g., ('Dependent Child', 2) → 'Child 2', ('Parent', 1) → 'Parent 1'
 */
function memberLabel(memberType, index) {
  const LABEL_MAP = {
    'Spouse / Common-Law Partner': 'Spouse',
    'Dependent Child':             'Child',
    'Sponsor':                     'Sponsor',
    'Worker Spouse':               'Worker Spouse',
    'Parent':                      'Parent',
    'Sibling':                     'Sibling',
  };
  const base = LABEL_MAP[memberType] || memberType;
  return index > 1 ? `${base} ${index}` : base;
}

/**
 * Generate a unique member key from the type + count of existing members of that type.
 * E.g., first child → 'child-1', second child → 'child-2', spouse → 'spouse'
 */
function generateMemberKey(memberType, existingMembers) {
  const KEY_BASE = {
    'Spouse / Common-Law Partner': 'spouse',
    'Dependent Child':             'child',
    'Sponsor':                     'sponsor',
    'Worker Spouse':               'worker-spouse',
    'Parent':                      'parent',
    'Sibling':                     'sibling',
  };
  const base = KEY_BASE[memberType] || memberType.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // Count how many of this type already exist
  const sameType = existingMembers.filter(m => m.type === memberType);
  const index = sameType.length + 1;

  // For types that typically have only one (spouse, worker-spouse, sponsor), use plain key for the first
  const singletonTypes = ['Spouse / Common-Law Partner', 'Worker Spouse', 'Sponsor'];
  if (singletonTypes.includes(memberType) && index === 1) {
    return base;
  }

  return `${base}-${index}`;
}

/**
 * Load the member manifest for a case.
 * Returns an array of { key, type, label, addedAt, submittedAt? } objects.
 * If no manifest exists, returns the default single-member list.
 */
async function loadMembers({ clientName, caseRef }) {
  try {
    const buf = await oneDrive.readFile({
      clientName,
      caseRef,
      subfolder: QUESTIONNAIRE_SUBFOLDER,
      filename:  membersFilename(caseRef),
    });
    if (buf) {
      const data = JSON.parse(buf.toString('utf8'));
      if (Array.isArray(data.members) && data.members.length > 0) {
        return data.members;
      }
    }
  } catch (err) {
    console.warn(`[HtmlQ] loadMembers failed for ${caseRef}: ${err.message}`);
  }
  return defaultMembers();
}

/**
 * Save the member manifest to OneDrive.
 */
async function saveMembers({ clientName, caseRef, members }) {
  const content = JSON.stringify({ members, updatedAt: new Date().toISOString() }, null, 2);
  const buffer  = Buffer.from(content, 'utf8');

  await oneDrive.ensureClientFolder({ clientName, caseRef });
  await oneDrive.uploadFile({
    clientName,
    caseRef,
    category: QUESTIONNAIRE_SUBFOLDER,
    filename: membersFilename(caseRef),
    buffer,
    mimeType: 'application/json',
  });

  console.log(`[HtmlQ] Saved member manifest for ${caseRef} — ${members.length} members`);
}

/**
 * Add a new member to the case manifest.
 *
 * @param {{ clientName, caseRef, memberType }} params
 *   memberType: one of the MEMBER_TYPE constants from questionnaireFormMap
 * @returns {{ key, type, label }} The newly added member
 */
async function addMember({ clientName, caseRef, memberType }) {
  const members = await loadMembers({ clientName, caseRef });

  // Validate: don't allow duplicate singletons (spouse, worker-spouse, sponsor)
  const singletonTypes = ['Spouse / Common-Law Partner', 'Worker Spouse', 'Sponsor'];
  if (singletonTypes.includes(memberType)) {
    const existing = members.find(m => m.type === memberType);
    if (existing) {
      throw new Error(`A ${memberType.split(' / ')[0]} has already been added to this case.`);
    }
  }

  const key   = generateMemberKey(memberType, members);
  const count = members.filter(m => m.type === memberType).length + 1;
  const label = memberLabel(memberType, count);

  const newMember = {
    key,
    type:    memberType,
    label,
    addedAt: new Date().toISOString(),
  };

  members.push(newMember);
  await saveMembers({ clientName, caseRef, members });

  console.log(`[HtmlQ] Added member "${label}" (${key}) for ${caseRef}`);
  return newMember;
}

/**
 * Remove a member from the case manifest.
 * Only allowed if the member hasn't submitted their questionnaire yet.
 *
 * @param {{ clientName, caseRef, memberKey }} params
 * @returns {boolean} true if removed, false if not found
 */
async function removeMember({ clientName, caseRef, memberKey }) {
  if (memberKey === 'primary') {
    throw new Error('The Primary Applicant cannot be removed.');
  }

  const members = await loadMembers({ clientName, caseRef });
  const idx     = members.findIndex(m => m.key === memberKey);

  if (idx === -1) {
    throw new Error('Member not found.');
  }

  const member = members[idx];

  // Check if the member has already submitted (check if form data file exists with submission flag)
  if (member.submittedAt) {
    throw new Error(`Cannot remove "${member.label}" — their questionnaire has already been submitted.`);
  }

  members.splice(idx, 1);
  await saveMembers({ clientName, caseRef, members });

  console.log(`[HtmlQ] Removed member "${member.label}" (${memberKey}) from ${caseRef}`);
  return true;
}

/**
 * Get the completion status for each member by checking if their form data files exist.
 * Returns the members array with added `status` and `completionPct` fields.
 *
 * @param {{ clientName, caseRef, members, formFiles }} params
 *   formFiles: { primary, additional? } from resolveForm()
 * @returns {Array} members with status info
 */
async function getMemberStatuses({ clientName, caseRef, members, formFiles }) {
  const result = [];
  for (const member of members) {
    // Check primary form data
    const primaryData = await loadFormData({ clientName, caseRef, formKey: member.key });
    const hasData     = primaryData.length > 0 && primaryData.some(f => f.value && f.value.trim());

    // Check additional form data (if dual-form case)
    let hasAdditionalData = false;
    if (formFiles?.additional) {
      const addKey = `${member.key}-additional`;
      const additionalData = await loadFormData({ clientName, caseRef, formKey: addKey });
      hasAdditionalData = additionalData.length > 0 && additionalData.some(f => f.value && f.value.trim());
    }

    let status = 'Not Started';
    if (member.submittedAt) status = 'Submitted';
    else if (hasData || hasAdditionalData) status = 'In Progress';

    result.push({
      ...member,
      status,
      hasData,
      hasAdditionalData,
    });
  }
  return result;
}

/**
 * Mark a member as submitted in the manifest (sets submittedAt timestamp).
 */
async function markMemberSubmitted({ clientName, caseRef, memberKey }) {
  const members = await loadMembers({ clientName, caseRef });
  const member  = members.find(m => m.key === memberKey);
  if (member) {
    member.submittedAt = new Date().toISOString();
    await saveMembers({ clientName, caseRef, members });
  }
}

/**
 * Mark a questionnaire form as submitted.
 * Updates Q readiness on Monday.com, posts an audit comment, and
 * triggers stage gates if the completion threshold has been crossed.
 *
 * @param {{ itemId, caseRef, caseType, formKey, formLabel, completionPct }} params
 *   caseType is required for threshold lookup and stage gate calls.
 */
async function markSubmitted({ itemId, caseRef, caseType, formKey, formLabel, completionPct, clientName }) {
  const pct = Math.round(completionPct);

  // ── Step 0: Extract member key from formKey ───────────────────────────────
  // formKey can be 'primary', 'spouse', 'child-1', 'spouse-additional', etc.
  // The member key is the part before '-additional' (if present).
  const memberKey = formKey.replace(/-additional$/, '');

  // ── Step 1: Mark member as submitted in manifest (if multi-member) ────────
  let members = null;
  let memberLabel = '';
  if (clientName) {
    try {
      await markMemberSubmitted({ clientName, caseRef, memberKey });
      members = await loadMembers({ clientName, caseRef });
      const member = members.find(m => m.key === memberKey);
      memberLabel = member?.label || '';
    } catch (err) {
      console.warn(`[HtmlQ] Could not update member manifest for ${caseRef}/${memberKey}: ${err.message}`);
    }
  }

  // ── Step 2: Calculate aggregate Q readiness across all members ─────────────
  // If there are multiple members, aggregate = average of all members' pct.
  // Each member's pct comes from their most recent submission.
  // For single-member cases, aggregate = this submission's pct (backward compatible).
  let aggregatePct = pct;
  let totalMembers = 1;
  let submittedCount = 1;
  let allDone = pct >= 100;

  if (members && members.length > 1) {
    // Count submitted members and average their completion
    let totalPct = 0;
    submittedCount = 0;
    totalMembers = members.length;

    for (const m of members) {
      if (m.submittedAt) {
        submittedCount++;
        // For the member we just submitted, use the current pct
        if (m.key === memberKey) {
          totalPct += pct;
        } else {
          // For other submitted members, assume 100% (they were submitted previously)
          totalPct += 100;
        }
      }
      // Non-submitted members contribute 0%
    }

    aggregatePct = totalMembers > 0 ? Math.round(totalPct / totalMembers) : pct;
    allDone = submittedCount >= totalMembers && pct >= 100;
  }

  // ── Step 3: Update Q Readiness and Q Completion Status on Monday.com ──────
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(clientMasterBoardId),
      itemId:  String(itemId),
      cols:    JSON.stringify({
        [CM.qReadiness]:        aggregatePct,
        [CM.qCompletionStatus]: { label: allDone ? 'Done' : 'Working on it' },
      }),
    }
  );

  // ── Step 4: Audit comment with staff review link ───────────────────────────
  const label       = formLabel ? `"${formLabel}"` : `(${formKey})`;
  const submittedAt = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true });
  const reviewUrl   = `${BASE_URL}/q/${encodeURIComponent(caseRef)}/review?formKey=${encodeURIComponent(formKey)}`;

  const memberNote  = memberLabel && memberLabel !== 'Primary Applicant'
    ? `\nMember: ${memberLabel}`
    : '';
  const progressNote = totalMembers > 1
    ? `\nProgress: ${submittedCount} of ${totalMembers} members submitted (aggregate Q readiness: ${aggregatePct}%)`
    : '';

  const comment = `📋 Questionnaire Submitted\n\nForm: ${label}${memberNote}\nCase: ${caseRef}\nCompletion: ${pct}%${progressNote}\nSubmitted: ${submittedAt} (Toronto)\n\nData saved to client OneDrive folder.\n\n🔍 Staff Review Link:\n${reviewUrl}`;

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: comment }
  );

  console.log(`[HtmlQ] Marked submitted — ${caseRef}/${formKey} at ${pct}% (aggregate: ${aggregatePct}%, ${submittedCount}/${totalMembers} members)`);

  // ── Step 5: Stage gate check ───────────────────────────────────────────────
  // Fire-and-forget: errors here must not block the submit response to the client.
  checkStageGate({ itemId, caseRef, caseType, qPct: aggregatePct }).catch((err) =>
    console.error(`[HtmlQ] Stage gate check failed for ${caseRef}:`, err.message)
  );
}

/**
 * Batch-submit multiple members at once.
 * Saves each member's data, marks all submitted in the manifest, then posts
 * a SINGLE audit comment covering all members — so the case officer gets one
 * notification instead of N separate ones.
 *
 * @param {{ itemId, caseRef, caseType, formLabel, clientName, memberSubmissions }} params
 *   memberSubmissions: [{ formKey, fields, completionPct }]
 */
async function markAllSubmitted({ itemId, caseRef, caseType, formLabel, clientName, memberSubmissions }) {
  // ── Step 1: Mark all members submitted in the manifest ────────────────────
  const perMember = [];
  for (const sub of memberSubmissions) {
    const memberKey = sub.formKey.replace(/-additional$/, '');
    const pct = Math.round(sub.completionPct);
    try {
      await markMemberSubmitted({ clientName, caseRef, memberKey });
    } catch (err) {
      console.warn(`[HtmlQ] Could not mark member ${memberKey} submitted: ${err.message}`);
    }
    perMember.push({ memberKey, formKey: sub.formKey, pct });
  }

  // ── Step 2: Re-load manifest and calculate aggregate readiness ────────────
  let members = [];
  try {
    members = await loadMembers({ clientName, caseRef });
  } catch (err) {
    console.warn(`[HtmlQ] Could not load members for ${caseRef}: ${err.message}`);
  }

  const totalMembers = members.length || perMember.length;
  let submittedCount = 0;
  let totalPct = 0;

  // Build a pct lookup from current submissions
  const pctMap = {};
  for (const pm of perMember) pctMap[pm.memberKey] = pm.pct;

  for (const m of members) {
    if (m.submittedAt) {
      submittedCount++;
      totalPct += pctMap[m.key] !== undefined ? pctMap[m.key] : 100;
    }
  }

  const aggregatePct = totalMembers > 0 ? Math.round(totalPct / totalMembers) : 0;
  const allDone = submittedCount >= totalMembers && perMember.every(pm => pm.pct >= 100);

  // ── Step 3: Update Monday.com Q readiness (one write) ─────────────────────
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(clientMasterBoardId),
      itemId:  String(itemId),
      cols:    JSON.stringify({
        [CM.qReadiness]:        aggregatePct,
        [CM.qCompletionStatus]: { label: allDone ? 'Done' : 'Working on it' },
      }),
    }
  );

  // ── Step 4: Post ONE audit comment covering all members ───────────────────
  const submittedAt = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true });
  const label       = formLabel ? `"${formLabel}"` : 'Questionnaire';
  const reviewUrl   = `${BASE_URL}/q/${encodeURIComponent(caseRef)}/review?formKey=primary`;

  const memberLines = perMember.map(pm => {
    const member = members.find(m => m.key === pm.memberKey);
    const memberLabel = member?.label || pm.memberKey;
    return `  • ${memberLabel}: ${pm.pct}%`;
  }).join('\n');

  const comment = `📋 Questionnaire Submitted (${perMember.length} member${perMember.length > 1 ? 's' : ''})\n\nForm: ${label}\nCase: ${caseRef}\n\nMembers submitted:\n${memberLines}\n\nAggregate Q readiness: ${aggregatePct}% (${submittedCount} of ${totalMembers} members)\nSubmitted: ${submittedAt} (Toronto)\n\nData saved to client OneDrive folder.\n\n🔍 Staff Review Link:\n${reviewUrl}`;

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: comment }
  );

  console.log(`[HtmlQ] Batch submitted — ${caseRef} — ${perMember.length} member(s) (aggregate: ${aggregatePct}%, ${submittedCount}/${totalMembers})`);

  // ── Step 5: Stage gate check ──────────────────────────────────────────────
  checkStageGate({ itemId, caseRef, caseType, qPct: aggregatePct }).catch((err) =>
    console.error(`[HtmlQ] Stage gate check failed for ${caseRef}:`, err.message)
  );
}

/**
 * Check whether the form submission has crossed the readiness threshold
 * and fire the appropriate stage gate if so.
 *
 * Reads the current case stage, doc readiness, and automation lock from Monday
 * so it can make the same decision the daily readiness scan would make.
 */
async function checkStageGate({ itemId, caseRef, caseType, qPct }) {
  // Fetch current case state — we need stage, doc readiness, and automation lock
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: [
           "${CM.caseStage}", "${CM.docReadiness}",
           "${CM.blockingDocCount}", "${CM.automationLock}"
         ]) { id text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const cols        = data?.items?.[0]?.column_values || [];
  const col         = (id) => cols.find(c => c.id === id)?.text?.trim() || '';
  const stage       = col(CM.caseStage);
  const docPct      = parseFloat(col(CM.docReadiness)) || 0;
  const blockingDoc = parseInt(col(CM.blockingDocCount), 10) || 0;
  const locked      = col(CM.automationLock) === 'Yes';

  if (locked) {
    console.log(`[HtmlQ] Stage gate skipped — automation locked for ${caseRef}`);
    return;
  }

  // Only eligible stages can advance via stage gates
  const eligibleStages = new Set(['Document Collection Started', 'Internal Review']);
  if (!eligibleStages.has(stage)) {
    console.log(`[HtmlQ] Stage gate skipped — stage "${stage}" not eligible for ${caseRef}`);
    return;
  }

  // Load the SLA threshold for this case type (cached, ~30-min TTL)
  const thresholds    = await loadThresholds();
  const minThreshold  = thresholds[caseType] || 80;

  // Mirror the daily scan logic exactly: blocking docs prevent gate advancement
  const thresholdMet  = qPct >= minThreshold && docPct >= minThreshold && blockingDoc === 0;
  const fullyComplete = qPct >= 100 && docPct >= 100 && blockingDoc === 0;

  console.log(
    `[HtmlQ] Stage gate check — ${caseRef} | Q:${qPct}% Doc:${docPct}% ` +
    `BlockingDocs:${blockingDoc} Threshold:${minThreshold}% Stage:"${stage}" | ` +
    (fullyComplete ? 'FULLY COMPLETE' : thresholdMet ? 'THRESHOLD MET' : 'below threshold / blocking')
  );

  if (fullyComplete && stage === 'Internal Review') {
    stageGateService.onFullyComplete({ masterItemId: itemId, caseRef, caseType })
      .catch(err => console.error(`[HtmlQ] onFullyComplete failed for ${caseRef}:`, err.message));
    return;
  }

  if (thresholdMet && stage === 'Document Collection Started') {
    stageGateService.onThresholdMet({ masterItemId: itemId, caseRef, caseType })
      .catch(err => console.error(`[HtmlQ] onThresholdMet failed for ${caseRef}:`, err.message));
  }
}

// ─── Injection script builder ─────────────────────────────────────────────────

/**
 * Build the <style> + <script> block that is injected before </body> in each HTML form.
 *
 * The injected script adds a floating toolbar (save / submit / progress) and
 * handles all data persistence via the /q/:caseRef API endpoints.
 *
 * @param {{ caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl }} params
 * @returns {string}  HTML string ready to splice into the form HTML
 */
function buildInjectionScript({ caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl, memberLabel, members, allowedMemberTypes, otherFormUrl, otherFormTitle, isAdditionalForm, formKeySuffix }) {
  const isMultiMember = Array.isArray(members) && members.length > 0;
  return `
<!-- TDOT Dynamic Questionnaire — injected by server -->
<style>
#tdot-toolbar {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: #1e3a5f; color: #fff;
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 24px; z-index: 9999;
  box-shadow: 0 -3px 16px rgba(0,0,0,0.25);
  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
  gap: 12px;
}
#tdot-progress { color: rgba(255,255,255,0.75); white-space: nowrap; }
#tdot-actions  { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
#tdot-saved-msg { font-size: 12px; color: #86efac; min-width: 100px; text-align: right; }
.tdot-btn {
  padding: 7px 16px; border: none; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background 0.15s;
}
.tdot-btn-save   { background: #374151; color: #fff; }
.tdot-btn-save:hover   { background: #4b5563; }
.tdot-btn-submit { background: #059669; color: #fff; }
.tdot-btn-submit:hover { background: #047857; }
.tdot-btn:disabled { opacity: 0.45; cursor: not-allowed; }
body { padding-bottom: 68px !important; }
${isMultiMember ? `
/* ── Multi-member mode ── */
.mm-section-badge {
  display: inline-flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.18); padding: 4px 14px;
  border-radius: 6px; font-size: 13px; font-weight: 700;
  letter-spacing: 0.02em; color: #fff; margin-left: 6px;
}
.mm-remove-btn {
  position: absolute; top: 12px; right: 16px; z-index: 5;
  background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25);
  border-radius: 6px; width: 30px; height: 30px; cursor: pointer;
  font-size: 16px; color: rgba(255,255,255,0.7);
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.mm-remove-btn:hover { background: #dc2626; border-color: #dc2626; color: #fff; }
.mm-add-area {
  max-width: 900px; margin: 24px auto 80px; text-align: center;
}
.mm-add-btn {
  padding: 14px 32px; background: #fff; border: 2px dashed #cbd5e1;
  border-radius: 12px; font-size: 15px; font-weight: 600; color: #475569;
  cursor: pointer; transition: all 0.15s;
}
.mm-add-btn:hover { border-color: #1e3a5f; color: #1e3a5f; background: #f0f4f8; }
.mm-add-menu {
  margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px;
  justify-content: center;
}
.mm-add-option {
  padding: 10px 18px; background: #fff; border: 1px solid #e2e8f0;
  border-radius: 8px; font-size: 13px; font-weight: 500; color: #334155;
  cursor: pointer; transition: all 0.15s;
}
.mm-add-option:hover { background: #eff6ff; border-color: #93c5fd; color: #1e3a5f; }
.mm-toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: #1e3a5f; color: #fff; padding: 12px 24px; border-radius: 8px;
  font-size: 14px; font-weight: 500; z-index: 10000; display: none;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
}
.mm-member-status {
  display: inline-block; padding: 2px 8px; border-radius: 4px;
  font-size: 11px; font-weight: 600; margin-left: 8px;
}
.mm-member-status.submitted { background: #dcfce7; color: #166534; }
.mm-member-status.in-progress { background: #fef9c3; color: #854d0e; }
` : ''}
${hasAdditionalForm ? `
.tdot-nav-bar {
  display: flex; background: #f8fafc; border-bottom: 2px solid #dde3ea;
  padding: 0 20px; position: sticky; top: 0; z-index: 90;
}
.tdot-nav-tab {
  padding: 11px 22px; font-size: 14px; font-weight: 600;
  cursor: pointer; border-bottom: 3px solid transparent;
  color: #6b7280; text-decoration: none; display: block;
}
.tdot-nav-tab.active { color: #1e3a5f; border-bottom-color: #1e3a5f; }
` : ''}
</style>
<script>
(function () {
  'use strict';

  /* ── Config injected by server ── */
  var CASE_REF       = ${JSON.stringify(String(caseRef))};
  var TOKEN          = ${JSON.stringify(String(token))};
  var FORM_KEY       = ${JSON.stringify(String(formKey))};
  var OVERVIEW_URL   = ${JSON.stringify(overviewUrl || '')};
  var MEMBER_LABEL   = ${JSON.stringify(memberLabel || '')};
  var MEMBERS        = ${JSON.stringify(isMultiMember ? members : [])};
  var ALLOWED_TYPES  = ${JSON.stringify(isMultiMember ? (allowedMemberTypes || []) : [])};
  var IS_MULTI       = MEMBERS.length > 0;
  var OTHER_FORM_URL   = ${JSON.stringify(otherFormUrl || '')};
  var OTHER_FORM_TITLE = ${JSON.stringify(otherFormTitle || '')};
  var IS_ADDITIONAL    = ${JSON.stringify(Boolean(isAdditionalForm))};
  var FORM_KEY_SUFFIX  = ${JSON.stringify(formKeySuffix || '')};

  /* ── Utilities ── */

  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/, '')
      .slice(0, 90);
  }

  function getHeadingText(el) {
    return Array.from(el.childNodes)
      .filter(function (n) {
        return n.nodeType === 3 ||
               (n.nodeType === 1 && !n.classList.contains('chevron') && n.tagName !== 'SPAN');
      })
      .map(function (n) { return n.textContent.trim(); })
      .join(' ')
      .trim();
  }

  function getSectionContext(el) {
    var parts   = [];
    var current = el.parentElement;
    while (current && current !== document.body) {
      /* In multi-member mode, stop before the top-level member header
         so that field keys are identical across member sections */
      if (IS_MULTI && current.parentElement &&
          current.parentElement.hasAttribute('data-member-key')) break;
      var prev = current.previousElementSibling;
      if (prev) {
        var onclick = prev.getAttribute('onclick') || '';
        if (onclick.indexOf('toggleTop') !== -1 || onclick.indexOf('toggleSub') !== -1 || onclick.indexOf('toggleApplicant') !== -1 || onclick.indexOf('toggleAccordion') !== -1) {
          var text = getHeadingText(prev);
          if (text) parts.unshift(text);
        }
      }
      current = current.parentElement;
    }
    return parts.join(' › ');
  }

  function isVisible(el) {
    var node = el;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  }

  /* ── Dirty-tracking — only auto-save when the user has made changes ── */

  var _isDirty       = false;
  var _autoSaveTimer = null;

  /* localStorage key for local backup */
  var _LS_KEY = 'tdot_form_' + CASE_REF + '_' + FORM_KEY;

  function markDirty() { _isDirty = true; }

  /* Write current fields to localStorage (cheap, synchronous) */
  function backupToLocal() {
    try {
      if (IS_MULTI) {
        var memberKeys = getActiveMemberKeys();
        for (var i = 0; i < memberKeys.length; i++) {
          var mk = memberKeys[i];
          var data = getSerializableFieldsForMember(mk);
          if (data && data.length) {
            localStorage.setItem('tdot_form_' + CASE_REF + '_' + mk + FORM_KEY_SUFFIX,
              JSON.stringify({ ts: Date.now(), fields: data }));
          }
        }
      } else {
        var data = getSerializableFields ? getSerializableFields() : null;
        if (data) localStorage.setItem(_LS_KEY, JSON.stringify({ ts: Date.now(), fields: data }));
      }
    } catch (e) { /* storage quota or private mode — ignore */ }
  }

  /* Read back from localStorage. Returns [] if nothing stored. */
  function restoreFromLocal() {
    try {
      var raw = localStorage.getItem(_LS_KEY);
      if (!raw) return [];
      var obj = JSON.parse(raw);
      return Array.isArray(obj.fields) ? obj.fields : [];
    } catch (e) { return []; }
  }

  /* ── Field collection ── */

  var _fieldCache = null;
  var _cacheStale = true;

  function invalidateCache() { _cacheStale = true; }

  function collectFields() {
    if (!_cacheStale && _fieldCache) return _fieldCache;

    var fields  = [];
    var seen    = [];
    var keyMap  = {};

    function makeKey(section, label, el) {
      /* In multi-member mode, prefix the key counter with the member key
         so that identical sub-section fields in different member sections
         don't collide in the dedup map. */
      var mk = IS_MULTI ? getMemberKeyForEl(el) : '';
      var base = slugify(section + '__' + label);
      var counterKey = mk ? mk + '::' + base : base;
      if (keyMap[counterKey] === undefined) { keyMap[counterKey] = 1; return base; }
      keyMap[counterKey]++;
      return base + '-' + keyMap[counterKey];
    }

    /* Helper: check if element is inside a mm-hidden sub-section */
    function isInHiddenMmSection(el) {
      var n = el;
      while (n && n !== document.body) {
        if (n.getAttribute && n.getAttribute('data-mm-hidden') === 'true') return true;
        n = n.parentElement;
      }
      return false;
    }

    /* 1 — Standard form-group inputs */
    var groups = document.querySelectorAll('.form-group');
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      var lbl   = group.querySelector('label');
      var inp   = group.querySelector('input, select, textarea');
      if (!lbl || !inp || seen.indexOf(inp) !== -1) continue;
      if (IS_MULTI && isInHiddenMmSection(group)) continue;
      seen.push(inp);
      var labelText = lbl.textContent.trim();
      var section   = getSectionContext(group);
      fields.push({ section: section, label: labelText, key: makeKey(section, labelText, inp), el: inp });
    }

    /* 2 — Dynamic table rows */
    var tables = document.querySelectorAll('.dynamic-table');
    for (var ti = 0; ti < tables.length; ti++) {
      var table   = tables[ti];
      if (IS_MULTI && isInHiddenMmSection(table)) continue;
      var tableId = table.id || ('table-' + ti);
      var headers = [];
      var ths     = table.querySelectorAll('thead th');
      for (var hi = 0; hi < ths.length; hi++) {
        var h = ths[hi].textContent.trim();
        if (h && h.toLowerCase() !== 'remove' && h !== '') headers.push(h);
      }
      var tbody = table.querySelector('tbody');
      if (!tbody) continue;
      var rows = tbody.querySelectorAll('tr');
      for (var ri = 0; ri < rows.length; ri++) {
        var row       = rows[ri];
        var rowInputs = row.querySelectorAll('input, select');
        for (var ci = 0; ci < headers.length; ci++) {
          var cell = rowInputs[ci];
          if (!cell || seen.indexOf(cell) !== -1) continue;
          seen.push(cell);
          var section2 = getSectionContext(table);
          /* Embed tableId so pre-fill can identify and expand this table */
          var labelText2 = headers[ci] + ' — Row ' + (ri + 1);
          var key2       = slugify(section2 + '--tbl-' + slugify(tableId) + '--r' + (ri + 1) + '--' + headers[ci]);
          fields.push({ section: section2 + ' › Table', label: labelText2, key: key2, el: cell, _tableId: tableId, _col: ci });
        }
      }
    }

    _fieldCache = fields;
    _cacheStale = false;
    return fields;
  }

  /* ── Progress ── */

  function getProgress() {
    if (IS_MULTI) {
      /* Aggregate progress across all members */
      var memberKeys = getActiveMemberKeys();
      var total = 0, filled = 0;
      for (var i = 0; i < memberKeys.length; i++) {
        var mp = getProgressForMember(memberKeys[i]);
        total  += mp.total;
        filled += mp.filled;
      }
      var pct = total > 0 ? Math.round(filled / total * 100) : 0;
      return { total: total, filled: filled, pct: pct };
    }

    var fields = collectFields();
    var total  = 0;
    var filled = 0;
    for (var i = 0; i < fields.length; i++) {
      var f   = fields[i];
      var val = (f.el.value || '').trim();
      var inConditional = false;
      var node = f.el.parentElement;
      while (node && node !== document.body) {
        if ((node.classList.contains('conditional') || node.classList.contains('refusal-details')) &&
            node.style.display === 'none' && !node.classList.contains('visible')) {
          inConditional = true;
          break;
        }
        if (node.getAttribute('data-mm-hidden') === 'true') {
          inConditional = true; break;
        }
        node = node.parentElement;
      }
      if (inConditional) continue;
      total++;
      if (val && val !== '-- Select --' && val !== 'Select...' && val !== '') filled++;
    }
    var pct = total > 0 ? Math.round(filled / total * 100) : 0;
    return { total: total, filled: filled, pct: pct };
  }

  function getSerializableFields() {
    var fields = collectFields();
    var result = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      result.push({ section: f.section, label: f.label, key: f.key, value: f.el.value || '' });
    }
    return result;
  }

  function updateProgressUI() {
    var bar = document.getElementById('tdot-progress');
    if (!bar) return;
    var p = getProgress();
    bar.textContent = p.filled + ' / ' + p.total + ' fields completed (' + p.pct + '%)';
    var pctBar = document.getElementById('tdot-pct-fill');
    if (pctBar) pctBar.style.width = p.pct + '%';
  }

  /* ── Save ── */

  var _saveTimeout = null;

  async function doSave(silent) {
    var saveBtn = document.getElementById('tdot-save-btn');
    var msg     = document.getElementById('tdot-saved-msg');
    if (!silent && saveBtn) saveBtn.disabled = true;

    /* ── Local backup first — always ── */
    backupToLocal();

    if (IS_MULTI) {
      /* ── Multi-member save: save each member separately ── */
      var memberKeys = getActiveMemberKeys();
      var anyFailed = false;
      for (var mi = 0; mi < memberKeys.length; mi++) {
        var mk = memberKeys[mi];
        var mFields = getSerializableFieldsForMember(mk);
        var mProg   = getProgressForMember(mk);
        if (mProg.pct === 0 && silent) continue; /* skip empty members on auto-save */
        try {
          var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/save', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ token: TOKEN, formKey: mk + FORM_KEY_SUFFIX, fields: mFields, completionPct: mProg.pct }),
          });
          if (!res.ok) throw new Error('Save failed for ' + mk);
        } catch (err) {
          console.error('[TDOT] Save error for ' + mk + ':', err);
          anyFailed = true;
        }
      }
      _isDirty = false;
      if (msg) {
        if (anyFailed) {
          msg.textContent = '⚠ Some sections failed to save';
          msg.style.color = '#fca5a5';
        } else {
          msg.textContent = '✓ Saved at ' + new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
          msg.style.color = '';
          setTimeout(function () { if (msg) msg.textContent = ''; }, 8000);
        }
      }
      if (!silent && saveBtn) saveBtn.disabled = false;
      return;
    }

    /* ── Single-member save (original logic) ── */
    var currentFields = getSerializableFields();
    var p             = getProgress();

    if (p.pct === 0 && silent) {
      console.log('[TDOT] Auto-save skipped — form is empty (pre-fill may still be loading).');
      if (!silent && saveBtn) saveBtn.disabled = false;
      return;
    }

    try {
      var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/save', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          token:         TOKEN,
          formKey:       FORM_KEY,
          fields:        currentFields,
          completionPct: p.pct,
        }),
      });
      if (!res.ok) throw new Error('Save failed (' + res.status + ')');
      _isDirty = false;
      if (msg) {
        msg.textContent = '✓ Saved at ' + new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
        msg.style.color = '';
        setTimeout(function () { if (msg) msg.textContent = ''; }, 8000);
      }
    } catch (err) {
      console.error('[TDOT] Save error:', err);
      if (msg) { msg.textContent = '⚠ Save failed — your data is backed up locally'; msg.style.color = '#fca5a5'; }
    } finally {
      if (!silent && saveBtn) saveBtn.disabled = false;
    }
  }

  /* ── Submit ── */

  async function doSubmit() {
    var p = getProgress();
    var confirmed = confirm(
      'Submit your questionnaire?\\n\\n' +
      'Completion: ' + p.pct + '% (' + p.filled + ' of ' + p.total + ' fields)\\n\\n' +
      (p.pct < 100 ? 'Note: some fields are still empty. You can still submit — your consultant will follow up.\\n\\n' : '') +
      'Click OK to submit.'
    );
    if (!confirmed) return;

    var submitBtn = document.getElementById('tdot-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

    try {
      if (IS_MULTI) {
        /* ── Multi-member submit: batch all members in one request ── */
        var memberKeys = getActiveMemberKeys();
        var memberSubs = [];
        for (var mi = 0; mi < memberKeys.length; mi++) {
          var mk = memberKeys[mi];
          memberSubs.push({
            formKey:       mk + FORM_KEY_SUFFIX,
            fields:        getSerializableFieldsForMember(mk),
            completionPct: getProgressForMember(mk).pct,
          });
        }
        var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/submit-all', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: TOKEN, members: memberSubs }),
        });
        if (!res.ok) throw new Error('Submit failed (' + res.status + ')');
      } else {
        /* ── Single-member submit ── */
        var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/submit', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            token:         TOKEN,
            formKey:       FORM_KEY,
            fields:        getSerializableFields(),
            completionPct: p.pct,
          }),
        });
        if (!res.ok) throw new Error('Submit failed (' + res.status + ')');
      }

      /* Stop the auto-save timer */
      if (_autoSaveTimer) { clearInterval(_autoSaveTimer); _autoSaveTimer = null; }

      /* Clear local backup */
      try { localStorage.removeItem(_LS_KEY); } catch (e) {}
      if (IS_MULTI) {
        var mKeys = getActiveMemberKeys();
        for (var k = 0; k < mKeys.length; k++) {
          try { localStorage.removeItem('tdot_form_' + CASE_REF + '_' + mKeys[k]); } catch (e) {}
        }
      }

      /* Show a success message */
      document.body.innerHTML =
        '<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:80px auto;text-align:center;padding:40px 24px">' +
        '<div style="font-size:56px;margin-bottom:20px">✅</div>' +
        '<h2 style="color:#1e3a5f;margin-bottom:12px">Questionnaire Submitted</h2>' +
        '<p style="color:#6b7280;font-size:15px">Thank you! Your answers have been saved and your consultant has been notified.</p>' +
        '</div>';
    } catch (err) {
      console.error('[TDOT] Submit error:', err);
      alert('Submission failed. Please try again or contact your consultant.\\n\\nError: ' + err.message);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '✅ Submit Questionnaire'; }
    }
  }

  /* ── Flags (correction notes from consultant) ── */

  /* ── Build a flag note + reply UI for one field ── */

  function buildFlagNote(flagKey, flag, parentEl, memberFormKey) {
    var container = document.createElement('div');
    container.setAttribute('data-tdot-flag', flagKey);
    container.setAttribute('data-tdot-comment', flag.comment || '');
    if (memberFormKey) container.setAttribute('data-tdot-formkey', memberFormKey);
    container.style.cssText =
      'margin-top:6px;border-radius:8px;overflow:hidden;border:1px solid #fed7aa;font-family:Segoe UI,sans-serif;';

    /* Officer comment */
    var commentDiv = document.createElement('div');
    commentDiv.style.cssText =
      'padding:10px 14px;background:#fff7ed;font-size:13px;color:#92400e;line-height:1.5;';
    commentDiv.innerHTML = '<strong>\ud83d\udcac Consultant note:</strong> ' + escHtml(flag.comment);
    container.appendChild(commentDiv);

    /* Existing client reply (if any) */
    if (flag.clientReply) {
      var replyDiv = document.createElement('div');
      replyDiv.style.cssText =
        'padding:10px 14px;background:#eff6ff;border-top:1px solid #bfdbfe;font-size:13px;color:#1e40af;line-height:1.5;';
      replyDiv.innerHTML =
        '<strong>\u2709\ufe0f Your reply:</strong> ' + escHtml(flag.clientReply) +
        (flag.clientRepliedAt ? '<div style="font-size:11px;color:#6b7280;margin-top:4px;">' +
          new Date(flag.clientRepliedAt).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
        '</div>' : '');
      container.appendChild(replyDiv);
    }

    /* Reply action area */
    var replyArea = document.createElement('div');
    replyArea.style.cssText =
      'padding:8px 14px;background:#fafafa;border-top:1px solid #f0f0f0;';

    if (flag.clientReply) {
      /* Already replied — show edit link */
      var editLink = document.createElement('button');
      editLink.type = 'button';
      editLink.style.cssText =
        'background:none;border:none;color:#2563eb;font-size:12px;font-weight:600;cursor:pointer;padding:0;font-family:inherit;';
      editLink.textContent = '\u270f\ufe0f Edit reply';
      editLink.onclick = function () { showReplyEditor(container, flagKey, flag.clientReply || ''); };
      replyArea.appendChild(editLink);
    } else {
      /* No reply yet — show reply button */
      var replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.style.cssText =
        'display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:#2563eb;color:#fff;' +
        'border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;';
      replyBtn.innerHTML = '\u21a9\ufe0f Reply to consultant';
      replyBtn.onmouseover = function () { this.style.background = '#1d4ed8'; };
      replyBtn.onmouseout  = function () { this.style.background = '#2563eb'; };
      replyBtn.onclick = function () { showReplyEditor(container, flagKey, ''); };
      replyArea.appendChild(replyBtn);
    }
    container.appendChild(replyArea);

    /* Remove old flag note if exists */
    if (parentEl) {
      var existing = parentEl.querySelector('[data-tdot-flag="' + flagKey + '"]');
      if (existing) existing.remove();
      parentEl.appendChild(container);
    }
    return container;
  }

  function showReplyEditor(container, flagKey, existingReply) {
    /* Remove any existing editor in this container */
    var old = container.querySelector('.tdot-reply-editor');
    if (old) old.remove();

    var editor = document.createElement('div');
    editor.className = 'tdot-reply-editor';
    editor.style.cssText =
      'padding:12px 14px;background:#f0f7ff;border-top:1px solid #bfdbfe;';

    var ta = document.createElement('textarea');
    ta.placeholder = 'Type your reply or question for your consultant...';
    ta.value = existingReply;
    ta.style.cssText =
      'width:100%;min-height:70px;border:1px solid #93c5fd;border-radius:6px;padding:8px 10px;' +
      'font-size:13px;font-family:inherit;line-height:1.5;resize:vertical;box-sizing:border-box;' +
      'color:#1e293b;background:#fff;';
    editor.appendChild(ta);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;justify-content:flex-end;';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText =
      'padding:6px 16px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;' +
      'font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;';
    cancelBtn.onclick = function () { editor.remove(); };

    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send Reply';
    sendBtn.style.cssText =
      'padding:6px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;' +
      'font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s;';
    sendBtn.onmouseover = function () { this.style.background = '#1d4ed8'; };
    sendBtn.onmouseout  = function () { this.style.background = '#2563eb'; };

    sendBtn.onclick = async function () {
      var reply = ta.value.trim();
      if (!reply) { alert('Please type a reply before sending.'); return; }

      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';

      try {
        var formKey = container.getAttribute('data-tdot-formkey') || FORM_KEY;
        var fieldKey = flagKey;
        /* For multi-member, extract the real formKey from the flag key prefix */
        if (IS_MULTI) {
          var match = flagKey.match(/^__([^_]+(?:-[^_]+)*)__(.+)$/);
          if (match) {
            formKey = match[1] + FORM_KEY_SUFFIX;
            fieldKey = match[2];
          }
        }

        var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/reply-flag', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: TOKEN, formKey: formKey, fieldKey: fieldKey, reply: reply }),
        });
        if (!res.ok) throw new Error('Server error ' + res.status);

        /* Rebuild the flag note to show the saved reply */
        var parentEl = container.parentElement;
        var flag = { comment: container.getAttribute('data-tdot-comment') || '', clientReply: reply, clientRepliedAt: new Date().toISOString() };
        var memberFk = container.getAttribute('data-tdot-formkey') || '';
        container.remove();
        buildFlagNote(flagKey, flag, parentEl, memberFk || undefined);
      } catch (err) {
        alert('Could not send reply: ' + err.message);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Reply';
      }
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);
    editor.appendChild(actions);
    container.appendChild(editor);
    ta.focus();
  }

  async function loadAndApplyFlags() {
    try {
      var res = await fetch(
        '/q/' + encodeURIComponent(CASE_REF) + '/flags' +
        '?t=' + encodeURIComponent(TOKEN) + '&formKey=' + encodeURIComponent(FORM_KEY),
        { method: 'GET' }
      );
      if (!res.ok) return;
      var data = await res.json();
      if (!data.flags || !Object.keys(data.flags).length) return;

      var fields = collectFields();
      for (var fi = 0; fi < fields.length; fi++) {
        var f    = fields[fi];
        var flag = data.flags[f.key];
        if (!flag) continue;

        /* Highlight the input */
        f.el.style.borderColor = '#f97316';
        f.el.style.outline     = '2px solid #fed7aa';

        /* Insert flag note + reply UI below the input */
        var parent = f.el.parentElement;
        if (parent) buildFlagNote(f.key, flag, parent);
      }

      /* Banner at top of page */
      var flagCount = Object.keys(data.flags).length;
      var banner = document.createElement('div');
      banner.style.cssText =
        'position:sticky;top:0;z-index:91;background:#fff7ed;border-bottom:2px solid #fed7aa;' +
        'padding:10px 24px;font-family:Segoe UI,sans-serif;font-size:14px;color:#92400e;' +
        'display:flex;align-items:center;gap:10px;';
      banner.innerHTML =
        '<span style="font-size:18px">\ud83d\udea9</span>' +
        '<strong>Your consultant has flagged ' + flagCount + ' item' + (flagCount !== 1 ? 's' : '') +
        ' for correction.</strong> Scroll down to see the highlighted fields, update your answers, then click Save.';
      document.body.insertBefore(banner, document.body.firstChild);
    } catch (err) {
      console.error('[TDOT] Flags load error:', err);
    }
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── Multi-member flags ── */

  async function loadAndApplyFlagsForMember(memberKey) {
    try {
      var res = await fetch(
        '/q/' + encodeURIComponent(CASE_REF) + '/flags' +
        '?t=' + encodeURIComponent(TOKEN) + '&formKey=' + encodeURIComponent(memberKey + FORM_KEY_SUFFIX),
        { method: 'GET' }
      );
      if (!res.ok) return;
      var data = await res.json();
      if (!data.flags || !Object.keys(data.flags).length) return;

      var fields = collectFields();
      var memberFields = fields.filter(function(f) { return getMemberKeyForEl(f.el) === memberKey; });
      var flagCount = 0;

      for (var fi = 0; fi < memberFields.length; fi++) {
        var f    = memberFields[fi];
        var flag = data.flags[f.key];
        if (!flag) continue;
        flagCount++;

        f.el.style.borderColor = '#f97316';
        f.el.style.outline     = '2px solid #fed7aa';

        var parent = f.el.parentElement;
        if (parent) buildFlagNote(f.key, flag, parent, memberKey + FORM_KEY_SUFFIX);
      }

      if (flagCount > 0) {
        /* Find the member section header and add a flag indicator */
        var section = document.querySelector('[data-member-key="' + memberKey + '"]');
        if (section) {
          var header = section.querySelector('.top-accordion-header, .applicant-header');
          if (header) {
            var badge = document.createElement('span');
            badge.style.cssText = 'display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#fff7ed;color:#92400e;border:1px solid #fed7aa;margin-left:8px;';
            badge.textContent = '\ud83d\udea9 ' + flagCount + ' flag' + (flagCount !== 1 ? 's' : '');
            header.appendChild(badge);
          }
        }
      }
    } catch (err) {
      console.error('[TDOT] Flags load error for ' + memberKey + ':', err);
    }
  }

  /* ── Pre-fill ── */

  async function expandTableRows(savedFields, scopeEl) {
    /* Build a map: tableId slug → max row index found in saved data */
    var tableMaxRow = {};
    for (var i = 0; i < savedFields.length; i++) {
      var key   = savedFields[i].key;
      var match = key.match(/--tbl-([a-z0-9-]+)--r(\d+)--/);
      if (match) {
        var tblSlug = match[1];
        var rowNum  = parseInt(match[2], 10);
        if (!tableMaxRow[tblSlug] || tableMaxRow[tblSlug] < rowNum) {
          tableMaxRow[tblSlug] = rowNum;
        }
      }
    }

    var root = scopeEl || document;
    var tables = root.querySelectorAll('.dynamic-table');
    for (var ti = 0; ti < tables.length; ti++) {
      var table   = tables[ti];
      var tblSlug = slugify(table.id || ('table-' + ti));
      var maxRow  = tableMaxRow[tblSlug];
      if (!maxRow) continue;

      var currentRows = table.querySelectorAll('tbody tr').length;
      var needed      = maxRow - currentRows;
      if (needed <= 0) continue;

      /* Find the "Add Row" / "Add Entry" button associated with this table */
      var container = table.closest('.sub-accordion-body') || table.parentElement;
      var addBtn    = null;
      if (container) {
        var btns = container.querySelectorAll('button, .btn-add');
        for (var bi = 0; bi < btns.length; bi++) {
          var onclick = btns[bi].getAttribute('onclick') || '';
          if (onclick.indexOf(table.id) !== -1 || onclick.indexOf('addRow') !== -1) {
            addBtn = btns[bi]; break;
          }
        }
      }
      if (!addBtn) continue;
      for (var ri = 0; ri < needed; ri++) { addBtn.click(); }
    }
  }

  async function prefillMemberSection(memberKey, sectionEl) {
    /* Load saved data for this member from the server */
    var serverFields = [];
    try {
      var res = await fetch(
        '/q/' + encodeURIComponent(CASE_REF) + '/data' +
        '?t=' + encodeURIComponent(TOKEN) + '&formKey=' + encodeURIComponent(memberKey + FORM_KEY_SUFFIX),
        { method: 'GET' }
      );
      if (res.ok) {
        var data = await res.json();
        if (data.fields && Array.isArray(data.fields)) serverFields = data.fields;
      }
    } catch (fetchErr) {
      console.warn('[TDOT] Could not reach server for pre-fill (' + memberKey + ').', fetchErr);
    }

    /* Local backup */
    var localKey = 'tdot_form_' + CASE_REF + '_' + memberKey + FORM_KEY_SUFFIX;
    var localFields = [];
    try {
      var raw = localStorage.getItem(localKey);
      if (raw) { var obj = JSON.parse(raw); localFields = Array.isArray(obj.fields) ? obj.fields : []; }
    } catch (e) {}

    var serverFilled = serverFields.filter(function(f) { return f.value && f.value.trim(); }).length;
    var localFilled  = localFields.filter(function(f) { return f.value && f.value.trim(); }).length;
    var sourceFields = (localFilled > serverFilled) ? localFields : serverFields;
    var sourceFilled = Math.max(serverFilled, localFilled);
    if (!sourceFilled) return;

    console.log('[TDOT] Pre-filling ' + memberKey + ': ' + sourceFilled + ' non-empty fields.');

    /* Expand dynamic tables within this member's section only */
    await expandTableRows(sourceFields, sectionEl);
    invalidateCache();

    /* Build lookup maps */
    var byKey = {}, byLabel = {};
    for (var i = 0; i < sourceFields.length; i++) {
      var sf = sourceFields[i];
      if (!sf.value || !sf.value.trim()) continue;
      byKey[sf.key] = sf.value;
      var lbl = (sf.label || '').trim().toLowerCase();
      if (!byLabel[lbl]) byLabel[lbl] = [];
      byLabel[lbl].push(sf.value);
    }

    /* Get fields within this member section only */
    var fields = collectFields();
    var memberFields = sectionEl
      ? fields.filter(function(f) { return getMemberKeyForEl(f.el) === memberKey; })
      : fields;

    var matched = 0, lblOcc = {};
    for (var fi = 0; fi < memberFields.length; fi++) {
      var f   = memberFields[fi];
      var val = byKey[f.key];
      if (!val) {
        var fLbl = (f.label || '').trim().toLowerCase();
        var occ  = lblOcc[fLbl] || 0;
        lblOcc[fLbl] = occ + 1;
        if (byLabel[fLbl] && byLabel[fLbl][occ]) val = byLabel[fLbl][occ];
      }
      if (val) {
        if (f.el.tagName === 'SELECT') {
          var opts = Array.prototype.slice.call(f.el.options);
          var opt  = opts.find(function(o){ return o.value === val; }) ||
                     opts.find(function(o){ return o.value.toLowerCase() === val.toLowerCase(); });
          if (opt) f.el.value = opt.value;
        } else {
          f.el.value = val;
        }
        matched++;
        try { f.el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      }
    }
    console.log('[TDOT] Pre-fill ' + memberKey + ': ' + matched + ' fields matched.');
    if (localFilled > serverFilled) markDirty();
  }

  async function loadAndPrefill() {
    try {
      if (IS_MULTI) {
        /* ── Multi-member pre-fill: load each member's data ── */
        var memberSections = document.querySelectorAll('[data-member-key]');
        for (var si = 0; si < memberSections.length; si++) {
          var mk = memberSections[si].getAttribute('data-member-key');
          await prefillMemberSection(mk, memberSections[si]);
        }
        updateProgressUI();
        return;
      }

      /* ── Single-member pre-fill (original logic) ── */
      await prefillMemberSection(FORM_KEY, null);
      updateProgressUI();
    } catch (err) {
      console.error('[TDOT] Pre-fill error:', err);
    }
  }

  /* ── Multi-member DOM setup ── */

  var _memberBlueprint = null;

  /* Which sub-sections to KEEP per member type (matched case-insensitively against header text).
     Types not listed here keep ALL sub-sections (spouse, worker spouse, sponsor). */
  var KEEP_SECTIONS_FOR = {
    'Dependent Child': ['profile', 'personal', 'passport', 'flagged'],
    'Parent':          ['profile', 'personal', 'passport', 'address', 'contact', 'flagged'],
    'Sibling':         ['profile', 'personal', 'passport', 'flagged'],
  };

  var MEMBER_ICONS = {
    'Principal Applicant':        '👤',
    'Spouse / Common-Law Partner': '💑',
    'Dependent Child':            '👶',
    'Sponsor':                    '🏠',
    'Worker Spouse':              '👷',
    'Parent':                     '👨‍👩‍👧',
    'Sibling':                    '👫',
  };

  function findTopSections() {
    /* Find all top-level accordion sections — handles both naming conventions */
    var sections = document.querySelectorAll('.top-accordion, .applicant-accordion');
    return Array.prototype.slice.call(sections);
  }

  function findSectionHeader(section) {
    return section.querySelector('.top-accordion-header, .applicant-header');
  }

  function findSectionBody(section) {
    return section.querySelector('.top-accordion-body, .applicant-body');
  }

  function setupMultiMemberDOM() {
    var topSections = findTopSections();
    if (topSections.length === 0) return;

    /* The first section is always the primary applicant */
    var primarySection = topSections[0];
    primarySection.setAttribute('data-member-key', 'primary');

    /* Everything after the first section is a "dependent" section — use the first
       one as the blueprint for cloning, then remove ALL of them from the DOM. */
    if (topSections.length > 1) {
      _memberBlueprint = topSections[1].cloneNode(true);
      for (var i = 1; i < topSections.length; i++) {
        topSections[i].remove();
      }
    } else {
      /* No dependent section in template — clone primary as a stripped blueprint */
      _memberBlueprint = primarySection.cloneNode(true);
    }

    /* Create sections for each non-primary member from the manifest */
    var insertRef = primarySection;
    for (var mi = 0; mi < MEMBERS.length; mi++) {
      var m = MEMBERS[mi];
      if (m.key === 'primary') continue;
      var section = createMemberSection(m);
      insertRef.parentNode.insertBefore(section, insertRef.nextSibling);
      insertRef = section;
    }

    /* Add the "Add Family Member" button if there are allowed types */
    if (ALLOWED_TYPES.length > 0) {
      var addArea = createAddMemberArea();
      insertRef.parentNode.insertBefore(addArea, insertRef.nextSibling);
    }

    /* Add toast element for notifications */
    var toast = document.createElement('div');
    toast.className = 'mm-toast';
    toast.id = 'mm-toast';
    document.body.appendChild(toast);
  }

  function createMemberSection(member) {
    var section = _memberBlueprint.cloneNode(true);
    section.setAttribute('data-member-key', member.key);
    section.style.position = 'relative';

    /* Update the header text */
    var header = findSectionHeader(section);
    if (header) {
      var chevron = header.querySelector('.chevron');
      var icon = MEMBER_ICONS[member.type] || '👤';
      header.textContent = '';
      header.appendChild(document.createTextNode(icon + '  ' + member.label));
      if (member.type !== 'Principal Applicant') {
        var typeBadge = document.createElement('span');
        typeBadge.className = 'mm-section-badge';
        typeBadge.textContent = member.type.split(' / ')[0];
        header.appendChild(typeBadge);
      }
      if (member.status === 'Submitted') {
        var statusBadge = document.createElement('span');
        statusBadge.className = 'mm-member-status submitted';
        statusBadge.textContent = '✅ Submitted';
        header.appendChild(statusBadge);
      }
      if (chevron) header.appendChild(chevron.cloneNode(true));
    }

    /* Make the body visible / open */
    var body = findSectionBody(section);
    if (body) {
      body.classList.add('open');
      body.style.display = '';
    }

    /* Adjust sub-sections based on member type */
    adjustSectionsForType(section, member.type);

    /* Deduplicate IDs to avoid DOM conflicts */
    deduplicateIds(section, member.key);

    /* Re-attach onclick handlers for accordions inside the clone */
    reattachAccordionHandlers(section);

    /* Add remove button for non-primary, non-submitted members */
    if (member.key !== 'primary' && member.status !== 'Submitted') {
      var removeBtn = document.createElement('button');
      removeBtn.className = 'mm-remove-btn';
      removeBtn.title = 'Remove ' + member.label;
      removeBtn.textContent = '✕';
      removeBtn.onclick = function() { removeMemberAction(member.key, member.label); };
      section.appendChild(removeBtn);
    }

    return section;
  }

  function adjustSectionsForType(section, memberType) {
    var keepList = KEEP_SECTIONS_FOR[memberType];
    if (!keepList) return; /* Keep all sections for spouse/worker-spouse/sponsor */

    /* Find all sub-accordion sections within this member section */
    var subAccordions = section.querySelectorAll('.sub-accordion, .accordion');
    for (var i = 0; i < subAccordions.length; i++) {
      var sub = subAccordions[i];
      var subHeader = sub.querySelector('.sub-accordion-header, .accordion-header');
      if (!subHeader) continue;
      var text = (subHeader.textContent || '').toLowerCase();

      var keep = false;
      for (var k = 0; k < keepList.length; k++) {
        if (text.indexOf(keepList[k]) !== -1) { keep = true; break; }
      }
      if (!keep) {
        sub.style.display = 'none';
        sub.setAttribute('data-mm-hidden', 'true');
      }
    }
  }

  function deduplicateIds(section, memberKey) {
    var els = section.querySelectorAll('[id]');
    for (var i = 0; i < els.length; i++) {
      els[i].id = memberKey + '-' + els[i].id;
    }
    /* Update onclick handlers that reference IDs (toggleConditional calls) */
    var onclickEls = section.querySelectorAll('[onchange]');
    for (var j = 0; j < onclickEls.length; j++) {
      var oc = onclickEls[j].getAttribute('onchange') || '';
      if (oc.indexOf('toggleConditional') !== -1) {
        /* Replace the ID reference inside toggleConditional(this, 'id') */
        onclickEls[j].setAttribute('onchange',
          oc.replace(/toggleConditional\(this,\s*'([^']+)'\)/,
            "toggleConditional(this,'" + memberKey + "-$1')"));
      }
    }
  }

  function reattachAccordionHandlers(section) {
    /* The cloned elements have onclick as HTML attributes, which should still work.
       But just in case, re-add handlers for common accordion toggle patterns. */
    var headers = section.querySelectorAll(
      '.top-accordion-header, .applicant-header, ' +
      '.sub-accordion-header, .accordion-header'
    );
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if (!h.getAttribute('onclick')) {
        (function(header) {
          header.style.cursor = 'pointer';
          header.addEventListener('click', function() {
            var body = header.nextElementSibling;
            if (body) {
              var isOpen = body.classList.contains('open') || body.style.display !== 'none';
              if (isOpen) {
                body.classList.remove('open');
                body.style.display = 'none';
              } else {
                body.classList.add('open');
                body.style.display = '';
              }
            }
          });
        })(h);
      }
    }
  }

  function createAddMemberArea() {
    var area = document.createElement('div');
    area.className = 'mm-add-area';
    area.id = 'mm-add-area';

    var btn = document.createElement('button');
    btn.className = 'mm-add-btn';
    btn.textContent = '+ Add Family Member';
    btn.onclick = function() {
      var menu = document.getElementById('mm-add-menu');
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    };
    area.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'mm-add-menu';
    menu.id = 'mm-add-menu';
    menu.style.display = 'none';

    for (var i = 0; i < ALLOWED_TYPES.length; i++) {
      (function(type) {
        var opt = document.createElement('button');
        opt.className = 'mm-add-option';
        var icon = MEMBER_ICONS[type] || '👤';
        opt.textContent = icon + '  ' + type.split(' / ')[0];
        opt.onclick = function() { addMemberAction(type); };
        menu.appendChild(opt);
      })(ALLOWED_TYPES[i]);
    }

    area.appendChild(menu);
    return area;
  }

  function mmToast(msg, duration) {
    var el = document.getElementById('mm-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(function() { el.style.display = 'none'; }, duration || 3000);
  }

  function addMemberAction(memberType) {
    mmToast('Adding ' + memberType.split(' / ')[0] + '…');
    fetch('/q/' + encodeURIComponent(CASE_REF) + '/add-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, memberType: memberType }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        mmToast(data.member.label + ' added!');
        setTimeout(function() { window.location.reload(); }, 600);
      } else {
        mmToast('Error: ' + (data.error || 'Could not add'), 4000);
      }
    })
    .catch(function() { mmToast('Network error — try again', 4000); });
  }

  function removeMemberAction(memberKey, memberLabel) {
    if (!confirm('Remove ' + memberLabel + '? Any unsaved answers will be lost.')) return;
    mmToast('Removing ' + memberLabel + '…');
    fetch('/q/' + encodeURIComponent(CASE_REF) + '/remove-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, memberKey: memberKey }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        mmToast(memberLabel + ' removed.');
        /* Remove the section from DOM */
        var el = document.querySelector('[data-member-key="' + memberKey + '"]');
        if (el) el.remove();
        invalidateCache();
        updateProgressUI();
      } else {
        mmToast('Error: ' + (data.error || 'Could not remove'), 4000);
      }
    })
    .catch(function() { mmToast('Network error — try again', 4000); });
  }

  /* ── Multi-member field helpers ── */

  function getMemberKeyForEl(el) {
    if (!IS_MULTI) return FORM_KEY;
    var section = el.closest('[data-member-key]');
    return section ? section.getAttribute('data-member-key') : FORM_KEY;
  }

  function getActiveMemberKeys() {
    if (!IS_MULTI) return [FORM_KEY];
    var sections = document.querySelectorAll('[data-member-key]');
    var keys = [];
    for (var i = 0; i < sections.length; i++) {
      keys.push(sections[i].getAttribute('data-member-key'));
    }
    return keys;
  }

  function getSerializableFieldsForMember(memberKey) {
    var fields = collectFields();
    var result = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (getMemberKeyForEl(f.el) === memberKey) {
        result.push({ section: f.section, label: f.label, key: f.key, value: f.el.value || '' });
      }
    }
    return result;
  }

  function getProgressForMember(memberKey) {
    var fields = collectFields();
    var total = 0, filled = 0;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (getMemberKeyForEl(f.el) !== memberKey) continue;
      var val = (f.el.value || '').trim();
      var inConditional = false;
      var node = f.el.parentElement;
      while (node && node !== document.body) {
        if ((node.classList.contains('conditional') || node.classList.contains('refusal-details')) &&
            node.style.display === 'none' && !node.classList.contains('visible')) {
          inConditional = true; break;
        }
        /* Don't count fields in mm-hidden sub-sections */
        if (node.getAttribute('data-mm-hidden') === 'true') {
          inConditional = true; break;
        }
        node = node.parentElement;
      }
      if (inConditional) continue;
      total++;
      if (val && val !== '-- Select --' && val !== 'Select...' && val !== '') filled++;
    }
    var pct = total > 0 ? Math.round(filled / total * 100) : 0;
    return { total: total, filled: filled, pct: pct };
  }

  /* ── Toolbar ── */

  function createToolbar() {
    var bar = document.createElement('div');
    bar.id  = 'tdot-toolbar';
    var memberBadge = MEMBER_LABEL && MEMBER_LABEL !== 'Primary Applicant'
      ? '<span style="display:inline-block;background:rgba(255,255,255,0.15);padding:2px 10px;border-radius:4px;font-size:11px;font-weight:700;margin-right:10px;letter-spacing:.03em">' + MEMBER_LABEL.replace(/</g,'&lt;') + '</span>'
      : '';
    bar.innerHTML =
      '<div>' +
        memberBadge +
        '<div id="tdot-progress" style="display:inline">Loading saved data…</div>' +
      '</div>' +
      '<div id="tdot-actions">' +
        '<span id="tdot-saved-msg"></span>' +
        '<button class="tdot-btn tdot-btn-save"   id="tdot-save-btn"   onclick="tdotSave()">💾 Save Progress</button>' +
        '<button class="tdot-btn tdot-btn-submit" id="tdot-submit-btn" onclick="tdotSubmit()">✅ Submit Questionnaire</button>' +
      '</div>';
    document.body.appendChild(bar);
  }

  /* ── Navigation tabs (two-form cases) ── */
  ${otherFormUrl ? `
  function createNavTab() {
    var nav = document.createElement('div');
    nav.className = 'tdot-nav-bar';
    var primaryTitle = IS_ADDITIONAL ? OTHER_FORM_TITLE : ${JSON.stringify(formTitle || '')};
    var additionalTitle = IS_ADDITIONAL ? ${JSON.stringify(formTitle || '')} : OTHER_FORM_TITLE;
    var primaryUrl = IS_ADDITIONAL ? OTHER_FORM_URL : '';
    var additionalUrl = IS_ADDITIONAL ? '' : OTHER_FORM_URL;
    nav.innerHTML =
      (primaryUrl
        ? '<a href="' + primaryUrl + '" class="tdot-nav-tab">📝 ' + primaryTitle + '</a>'
        : '<span class="tdot-nav-tab active" style="cursor:default">📝 ' + primaryTitle + '</span>') +
      (additionalUrl
        ? '<a href="' + additionalUrl + '" class="tdot-nav-tab">📋 ' + additionalTitle + '</a>'
        : '<span class="tdot-nav-tab active" style="cursor:default">📋 ' + additionalTitle + '</span>');
    document.body.insertBefore(nav, document.body.firstChild);
  }
  ` : overviewUrl ? `
  function createNavTab() {
    var nav = document.createElement('div');
    nav.className = 'tdot-nav-bar';
    nav.innerHTML = '<a href="' + OVERVIEW_URL + '" class="tdot-nav-tab">← All Forms</a>';
    document.body.insertBefore(nav, document.body.firstChild);
  }
  ` : '/* single-form case — no nav tab */'}

  /* ── Auto-save ── */

  function scheduleAutoSave() {
    _autoSaveTimer = setInterval(function () {
      if (_isDirty) doSave(true);
    }, 60 * 1000); // check every 60 s, only saves when form is modified
  }

  /* ── Expose globals for inline button handlers ── */

  window.tdotSave   = function () { doSave(false); };
  window.tdotSubmit = doSubmit;

  /* ── Initialise ── */

  async function init() {
    /* Set up multi-member DOM before anything else */
    if (IS_MULTI) setupMultiMemberDOM();

    createToolbar();
    ${(overviewUrl || otherFormUrl) ? 'createNavTab();' : ''}

    /* Listen for any field change to update progress, invalidate cache and mark dirty */
    document.addEventListener('change', function () { markDirty(); invalidateCache(); updateProgressUI(); });
    document.addEventListener('input',  function () { markDirty(); invalidateCache(); updateProgressUI(); });

    await loadAndPrefill();
    if (IS_MULTI) {
      /* Load flags for each member section */
      var memberKeys = getActiveMemberKeys();
      for (var fi = 0; fi < memberKeys.length; fi++) {
        await loadAndApplyFlagsForMember(memberKeys[fi]);
      }
    } else {
      await loadAndApplyFlags();
    }
    updateProgressUI();
    scheduleAutoSave();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
`;
}

// ─── HTML page builders ───────────────────────────────────────────────────────

/**
 * Read an HTML form file from disk and inject the dynamic script block.
 *
 * @param {{ formFile, caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl }} params
 * @returns {string} Complete HTML ready to send to the browser
 */
function buildFormPage({ formFile, caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl, memberLabel, members, allowedMemberTypes, otherFormUrl, otherFormTitle, isAdditionalForm, formKeySuffix }) {
  const filePath = path.join(FORMS_DIR, formFile);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Form file not found: ${formFile}`);
  }

  const html   = fs.readFileSync(filePath, 'utf8');
  const script = buildInjectionScript({ caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl, memberLabel, members, allowedMemberTypes, otherFormUrl, otherFormTitle, isAdditionalForm, formKeySuffix });

  // Inject immediately before </body>
  if (html.includes('</body>')) {
    return html.replace('</body>', script + '\n</body>');
  }
  // Fallback: append to end
  return html + script;
}

/**
 * Build the overview page shown for two-form cases.
 * Displays a card for each form with a link to open it.
 *
 * @param {{ caseRef, token, primaryTitle, additionalTitle }} params
 * @returns {string} HTML string
 */
/**
 * Build the overview page showing all members and their forms.
 *
 * @param {{ caseRef, token, members, formFiles, allowedMemberTypes }} params
 *   members: array from getMemberStatuses() with status info
 *   formFiles: { primary, additional? } from resolveForm()
 *   allowedMemberTypes: string[] of member types the client can add
 */
function buildOverviewPage({ caseRef, token, members, formFiles, allowedMemberTypes }) {
  const base     = `/q/${encodeURIComponent(caseRef)}?t=${encodeURIComponent(token)}`;
  const hasTwo   = Boolean(formFiles?.additional);
  const escHtml  = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Extract clean form titles
  const titleClean = (f) => (f || '').replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();
  const primaryTitle    = titleClean(formFiles?.primary);
  const additionalTitle = hasTwo ? titleClean(formFiles.additional) : '';

  // Status badge colors
  const statusStyle = (status) => {
    if (status === 'Submitted')   return 'background:#dcfce7;color:#166534;border:1px solid #bbf7d0';
    if (status === 'In Progress') return 'background:#fef9c3;color:#854d0e;border:1px solid #fde68a';
    return 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb'; // Not Started
  };

  const statusIcon = (status) => {
    if (status === 'Submitted')   return '✅';
    if (status === 'In Progress') return '📝';
    return '⬜';
  };

  // Member type display icons
  const memberIcon = (type) => {
    const icons = {
      'Principal Applicant':        '👤',
      'Spouse / Common-Law Partner': '💑',
      'Dependent Child':            '👶',
      'Sponsor':                    '🏠',
      'Worker Spouse':              '👷',
      'Parent':                     '👨‍👩‍👧',
      'Sibling':                    '👫',
    };
    return icons[type] || '👤';
  };

  // Build member cards
  const memberCards = members.map((member) => {
    const icon    = memberIcon(member.type);
    const badge   = `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;${statusStyle(member.status)}">${statusIcon(member.status)} ${escHtml(member.status)}</span>`;
    const isPrimary = member.key === 'primary';

    // Form buttons — one per form file
    let formButtons = '';
    if (hasTwo) {
      formButtons = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <a href="${base}&f=${encodeURIComponent(member.key)}&form=primary" class="form-btn">${escHtml(primaryTitle)}</a>
          <a href="${base}&f=${encodeURIComponent(member.key)}&form=additional" class="form-btn form-btn-secondary">${escHtml(additionalTitle)}</a>
        </div>`;
    } else {
      formButtons = `
        <a href="${base}&f=${encodeURIComponent(member.key)}" class="form-btn" style="margin-top:8px">${escHtml(primaryTitle)} →</a>`;
    }

    // Remove button (only for non-primary, non-submitted members)
    const removeBtn = (!isPrimary && member.status !== 'Submitted')
      ? `<button class="remove-btn" onclick="removeMember('${escHtml(member.key)}', '${escHtml(member.label)}')" title="Remove ${escHtml(member.label)}">✕</button>`
      : '';

    return `
    <div class="member-card${member.status === 'Submitted' ? ' submitted' : ''}">
      ${removeBtn}
      <div class="member-header">
        <span class="member-icon">${icon}</span>
        <div>
          <div class="member-label">${escHtml(member.label)}</div>
          <div class="member-type">${escHtml(member.type)}</div>
        </div>
      </div>
      <div style="margin:8px 0">${badge}</div>
      ${formButtons}
    </div>`;
  }).join('');

  // Add Member button (only if there are allowed types)
  const addMemberSection = allowedMemberTypes.length > 0 ? `
    <div class="add-member-section" id="addMemberSection">
      <button class="add-member-btn" onclick="toggleAddMenu()">+ Add Family Member</button>
      <div class="add-menu" id="addMenu" style="display:none">
        ${allowedMemberTypes.map(type => `
          <button class="add-option" onclick="addMember('${escHtml(type)}')">
            ${memberIcon(type)} ${escHtml(type.split(' / ')[0])}
          </button>
        `).join('')}
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Questionnaire — ${escHtml(caseRef)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex; flex-direction: column; align-items: center;
      padding: 40px 20px;
    }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-size: 24px; color: #1e3a5f; font-weight: 700; }
    .header p  { color: #6b7280; font-size: 14px; margin-top: 6px; }
    .members-grid {
      display: flex; flex-wrap: wrap; gap: 16px;
      justify-content: center; width: 100%; max-width: 920px;
    }
    .member-card {
      background: #fff; border-radius: 12px; padding: 24px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.07);
      flex: 1 1 280px; min-width: 260px; max-width: 420px;
      display: flex; flex-direction: column;
      position: relative;
      border: 2px solid transparent;
      transition: border-color 0.2s;
    }
    .member-card:hover { border-color: #dbeafe; }
    .member-card.submitted { border-color: #bbf7d0; background: #fafffe; }
    .member-header {
      display: flex; align-items: center; gap: 12px; margin-bottom: 4px;
    }
    .member-icon { font-size: 28px; }
    .member-label { font-size: 16px; font-weight: 700; color: #1e3a5f; }
    .member-type  { font-size: 12px; color: #9ca3af; }
    .form-btn {
      display: block; text-align: center;
      padding: 9px 16px; background: #1e3a5f; color: #fff;
      border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 13px;
      transition: background 0.15s;
    }
    .form-btn:hover { background: #2d5186; }
    .form-btn-secondary { background: #475569; }
    .form-btn-secondary:hover { background: #64748b; }
    .remove-btn {
      position: absolute; top: 10px; right: 10px;
      background: none; border: 1px solid #e5e7eb; border-radius: 6px;
      width: 28px; height: 28px; cursor: pointer; font-size: 14px; color: #9ca3af;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .remove-btn:hover { background: #fef2f2; border-color: #fca5a5; color: #dc2626; }
    .add-member-section {
      margin-top: 24px; text-align: center; width: 100%; max-width: 920px;
    }
    .add-member-btn {
      padding: 12px 28px; background: #fff; border: 2px dashed #cbd5e1;
      border-radius: 10px; font-size: 14px; font-weight: 600; color: #475569;
      cursor: pointer; transition: all 0.15s;
    }
    .add-member-btn:hover { border-color: #1e3a5f; color: #1e3a5f; background: #f0f4f8; }
    .add-menu {
      margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px;
      justify-content: center;
    }
    .add-option {
      padding: 10px 18px; background: #fff; border: 1px solid #e2e8f0;
      border-radius: 8px; font-size: 13px; font-weight: 500; color: #334155;
      cursor: pointer; transition: all 0.15s;
    }
    .add-option:hover { background: #eff6ff; border-color: #93c5fd; color: #1e3a5f; }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1e3a5f; color: #fff; padding: 12px 24px; border-radius: 8px;
      font-size: 14px; font-weight: 500; z-index: 999; display: none;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    }
    @media (max-width: 600px) {
      .members-grid { flex-direction: column; }
      .member-card { max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Your Questionnaire</h1>
    <p>Case Reference: <strong>${escHtml(caseRef)}</strong></p>
    <p style="margin-top:8px;font-size:13px;color:#6b7280">
      ${members.length > 1
        ? 'Complete the questionnaire for each family member listed below.'
        : hasTwo
          ? 'This case requires two questionnaire forms. Please complete both.'
          : 'Please complete the questionnaire below.'}
    </p>
  </div>

  <div class="members-grid" id="membersGrid">
    ${memberCards}
  </div>

  ${addMemberSection}

  <div class="toast" id="toast"></div>

  <script>
  (function() {
    var CASE_REF = ${JSON.stringify(caseRef)};
    var TOKEN    = ${JSON.stringify(token)};
    var BASE     = ${JSON.stringify(base)};

    function showToast(msg, duration) {
      var el = document.getElementById('toast');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(function() { el.style.display = 'none'; }, duration || 3000);
    }

    function toggleAddMenu() {
      var menu = document.getElementById('addMenu');
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    }

    function addMember(memberType) {
      showToast('Adding ' + memberType.split(' / ')[0] + '...');
      fetch('/q/' + encodeURIComponent(CASE_REF) + '/add-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, memberType: memberType }),
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          showToast(data.member.label + ' added successfully!');
          setTimeout(function() { window.location.reload(); }, 800);
        } else {
          showToast('Error: ' + (data.error || 'Could not add member'), 4000);
        }
      })
      .catch(function() { showToast('Network error — please try again', 4000); });
    }

    function removeMember(memberKey, memberLabel) {
      if (!confirm('Remove ' + memberLabel + '? Any unsaved answers will be lost.')) return;
      showToast('Removing ' + memberLabel + '...');
      fetch('/q/' + encodeURIComponent(CASE_REF) + '/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, memberKey: memberKey }),
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          showToast(memberLabel + ' removed.');
          setTimeout(function() { window.location.reload(); }, 800);
        } else {
          showToast('Error: ' + (data.error || 'Could not remove member'), 4000);
        }
      })
      .catch(function() { showToast('Network error — please try again', 4000); });
    }

    // Expose to onclick handlers
    window.toggleAddMenu = toggleAddMenu;
    window.addMember     = addMember;
    window.removeMember  = removeMember;
  })();
  </script>
</body>
</html>`;
}

/**
 * Build the placeholder page shown when no form is available for the case type.
 * (Option B: "Your questionnaire is being prepared.")
 */
function buildPlaceholderPage(caseRef) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Questionnaire — ${caseRef}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 40px 20px;
    }
    .box {
      background: #fff; border-radius: 14px; padding: 48px 40px;
      box-shadow: 0 2px 20px rgba(0,0,0,0.09); text-align: center;
      max-width: 520px; width: 100%;
    }
    .icon  { font-size: 52px; margin-bottom: 20px; }
    h1     { font-size: 22px; color: #1e3a5f; font-weight: 700; margin-bottom: 14px; }
    p      { font-size: 14px; color: #6b7280; line-height: 1.6; }
    .ref   { margin-top: 20px; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">📋</div>
    <h1>Your Questionnaire Is Being Prepared</h1>
    <p>
      Your consultant is currently finalising the questionnaire for your case.
      You will receive an email with a direct link as soon as it is ready.
    </p>
    <p class="ref">Case Reference: ${caseRef}</p>
  </div>
</body>
</html>`;
}

/**
 * Build an error / access-denied page.
 */
function buildErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Error</title>
  <style>
    body { font-family:'Segoe UI',sans-serif; background:#f0f4f8; display:flex;
           align-items:center; justify-content:center; min-height:100vh; padding:40px 20px; }
    .box { background:#fff; border-radius:14px; padding:48px 40px; text-align:center;
           box-shadow:0 2px 20px rgba(0,0,0,.09); max-width:480px; width:100%; }
    h1   { color:#dc2626; font-size:20px; margin-bottom:12px; }
    p    { color:#6b7280; font-size:14px; line-height:1.6; }
  </style>
</head>
<body>
  <div class="box">
    <div style="font-size:48px;margin-bottom:16px">🔒</div>
    <h1>Access Denied</h1>
    <p>${message || 'This link is invalid or has expired. Please contact your consultant.'}</p>
  </div>
</body>
</html>`;
}

// ─── Review-mode page builder ─────────────────────────────────────────────────

/**
 * Build the CSS + JS block injected into the HTML form for staff review mode.
 * Uses the same field-collection logic as the client script so keys match exactly.
 */
function buildReviewInjectionScript({ caseRef, formKey, staffName, savedFields, savedFlags, members, formKeySuffix }) {
  const isMultiMember = Array.isArray(members) && members.length > 1;
  return `
<!-- TDOT Review Mode — injected by server -->
<style>
body { padding-top: 62px !important; }
${isMultiMember ? `
/* Multi-member review styles */
.mm-review-section-label {
  display: inline-flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.18); padding: 3px 12px;
  border-radius: 5px; font-size: 12px; font-weight: 700; color: #fff;
  margin-left: 6px;
}
.mm-review-member-divider {
  border: none; border-top: 3px solid #1e3a5f; margin: 32px 0 8px;
  position: relative;
}
` : ''}
#tdot-review-bar {
  position: fixed; top: 0; left: 0; right: 0;
  background: #1e3a5f; color: #fff;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; height: 54px; z-index: 9999;
  box-shadow: 0 3px 16px rgba(0,0,0,0.22);
  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; gap: 16px;
}
#tdot-review-bar .rb-left  { display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
#tdot-review-bar .rb-title { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#tdot-review-bar .rb-sub   { font-size: 11px; color: rgba(255,255,255,.65); white-space: nowrap; }
#tdot-review-bar .rb-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
#tdot-flag-count { font-size: 13px; color: rgba(255,255,255,.8); }
#tdot-notify-btn {
  padding: 7px 16px; border: none; border-radius: 6px;
  background: #059669; color: #fff; font-size: 13px; font-weight: 600;
  cursor: pointer; white-space: nowrap;
}
#tdot-notify-btn:hover { background: #047857; }
#tdot-notify-btn:disabled { opacity: .45; cursor: not-allowed; }
#tdot-export-btn:hover { background: rgba(255,255,255,.15) !important; }
#tdot-notify-msg { font-size: 12px; color: #86efac; }

/* Read-only field styling */
input[disabled], select[disabled], textarea[disabled] {
  background: #f9fafb !important;
  color: #374151 !important;
  cursor: default !important;
  opacity: 1 !important;
  border-color: #e5e7eb !important;
}

/* Label-row wrapper (label + flag button side-by-side) */
.tdot-label-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; margin-bottom: 4px;
}
.tdot-label-row label { margin: 0 !important; flex: 1; }
.tdot-flag-btn {
  flex-shrink: 0;
  background: none; border: 1px solid #d1d5db; border-radius: 5px;
  font-size: 11px; font-weight: 600; color: #6b7280;
  padding: 2px 8px; cursor: pointer; white-space: nowrap;
  transition: background .15s, border-color .15s;
}
.tdot-flag-btn:hover { background: #fff7ed; border-color: #f59e0b; color: #b45309; }
.tdot-flag-btn.flagged { background: #fff7ed; border-color: #f59e0b; color: #b45309; font-weight: 700; }

/* Flag inline editor */
.tdot-flag-editor {
  margin-top: 8px; background: #fffbeb; border: 1px solid #fde68a;
  border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
}
.tdot-flag-editor textarea {
  width: 100%; border: 1px solid #fcd34d; border-radius: 6px;
  padding: 6px 8px; font-size: 13px; font-family: inherit; resize: vertical;
  min-height: 60px; background: #fff;
}
.tdot-flag-editor .fe-actions { display: flex; gap: 8px; }
.tdot-flag-editor .fe-save {
  padding: 5px 14px; background: #f59e0b; color: #fff;
  border: none; border-radius: 5px; font-size: 12px; font-weight: 700; cursor: pointer;
}
.tdot-flag-editor .fe-save:hover { background: #d97706; }
.tdot-flag-editor .fe-remove {
  padding: 5px 14px; background: #fff; color: #dc2626;
  border: 1px solid #fca5a5; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.tdot-flag-editor .fe-remove:hover { background: #fef2f2; }
.tdot-flag-editor .fe-cancel {
  padding: 5px 14px; background: #fff; color: #6b7280;
  border: 1px solid #d1d5db; border-radius: 5px; font-size: 12px; cursor: pointer;
}
.tdot-flag-note {
  margin-top: 8px; background: #fffbeb; border-left: 3px solid #f59e0b;
  padding: 6px 10px; font-size: 12px; color: #92400e; border-radius: 0 6px 6px 0;
}

/* Highlight flagged form-groups */
.form-group.tdot-flagged { background: #fffbeb !important; border-radius: 8px; padding: 8px !important; margin: -8px !important; }
</style>
<script>
(function () {
  'use strict';

  /* ── Server-injected data ── */
  var CASE_REF    = ${JSON.stringify(String(caseRef))};
  var FORM_KEY    = ${JSON.stringify(String(formKey))};
  var STAFF_NAME  = ${JSON.stringify(String(staffName))};
  var SAVED_DATA  = ${JSON.stringify(savedFields)};
  var flags       = ${JSON.stringify(savedFlags)};
  var REVIEW_MEMBERS = ${JSON.stringify(isMultiMember ? members.map(m => ({ key: m.key, type: m.type, label: m.label, fields: m.fields, flags: m.flags })) : [])};
  var IS_MULTI_REVIEW = REVIEW_MEMBERS.length > 1;
  var REVIEW_KEY_SUFFIX = ${JSON.stringify(formKeySuffix || '')};

  /* ── Utilities (identical to client script so keys match) ── */

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function slugify(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').slice(0, 90);
  }

  function getHeadingText(el) {
    return Array.from(el.childNodes)
      .filter(function (n) {
        return n.nodeType === 3 ||
               (n.nodeType === 1 && !n.classList.contains('chevron') && n.tagName !== 'SPAN');
      })
      .map(function (n) { return n.textContent.trim(); })
      .join(' ').trim();
  }

  function getSectionContext(el) {
    var parts = [], current = el.parentElement;
    while (current && current !== document.body) {
      /* In multi-member review, stop at member section boundary */
      if (IS_MULTI_REVIEW && current.parentElement &&
          current.parentElement.hasAttribute('data-member-key')) break;
      var prev = current.previousElementSibling;
      if (prev) {
        var oc = prev.getAttribute('onclick') || '';
        if (oc.indexOf('toggleTop') !== -1 || oc.indexOf('toggleSub') !== -1 || oc.indexOf('toggleApplicant') !== -1 || oc.indexOf('toggleAccordion') !== -1) {
          var t = getHeadingText(prev);
          if (t) parts.unshift(t);
        }
      }
      current = current.parentElement;
    }
    return parts.join(' \u203a ');
  }

  function getMemberKeyForEl(el) {
    if (!IS_MULTI_REVIEW) return FORM_KEY;
    var section = el.closest('[data-member-key]');
    return section ? section.getAttribute('data-member-key') : FORM_KEY;
  }

  function collectFields() {
    var fields = [], seen = [], keyMap = {};
    function makeKey(section, label, el) {
      var mk = IS_MULTI_REVIEW ? getMemberKeyForEl(el) : '';
      var base = slugify(section + '__' + label);
      var counterKey = mk ? mk + '::' + base : base;
      if (keyMap[counterKey] === undefined) { keyMap[counterKey] = 1; return base; }
      keyMap[counterKey]++; return base + '-' + keyMap[counterKey];
    }

    var groups = document.querySelectorAll('.form-group');
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      var lbl   = group.querySelector('label');
      var inp   = group.querySelector('input, select, textarea');
      if (!lbl || !inp || seen.indexOf(inp) !== -1) continue;
      seen.push(inp);
      var labelText = lbl.textContent.trim();
      var section   = getSectionContext(group);
      fields.push({ section: section, label: labelText, key: makeKey(section, labelText, inp), el: inp, group: group });
    }

    var tables = document.querySelectorAll('.dynamic-table');
    for (var ti = 0; ti < tables.length; ti++) {
      var table   = tables[ti];
      var tableId = table.id || ('table-' + ti);
      var headers = [];
      var ths     = table.querySelectorAll('thead th');
      for (var hi = 0; hi < ths.length; hi++) {
        var h = ths[hi].textContent.trim();
        if (h && h.toLowerCase() !== 'remove' && h !== '') headers.push(h);
      }
      var tbody = table.querySelector('tbody');
      if (!tbody) continue;
      var rows = tbody.querySelectorAll('tr');
      for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri], rowInputs = row.querySelectorAll('input, select');
        for (var ci = 0; ci < headers.length; ci++) {
          var cell = rowInputs[ci];
          if (!cell || seen.indexOf(cell) !== -1) continue;
          seen.push(cell);
          var section2   = getSectionContext(table);
          var labelText2 = headers[ci] + ' \u2014 Row ' + (ri + 1);
          var key2       = slugify(section2 + '--tbl-' + slugify(tableId) + '--r' + (ri + 1) + '--' + headers[ci]);
          fields.push({ section: section2 + ' \u203a Table', label: labelText2, key: key2, el: cell, group: row });
        }
      }
    }
    return fields;
  }

  /* ── Expand all accordions and conditional sections ── */

  function expandAll() {
    document.querySelectorAll(
      '.accordion-body, .applicant-body, .sub-accordion-body, .open, .active'
    ).forEach(function (el) {
      el.style.display = 'block';
    });
    // Expand ALL collapsible bodies regardless of class naming convention
    document.querySelectorAll('[class*="body"], [class*="content"], [class*="panel"]').forEach(function (el) {
      var s = window.getComputedStyle(el);
      if (s.display === 'none' && el.querySelectorAll('input, select, textarea').length > 0) {
        el.style.display = 'block';
      }
    });
    // Conditional sections (both .conditional and .conditional-section)
    document.querySelectorAll('.conditional, .conditional-section').forEach(function (el) {
      el.style.display = 'block';
    });
  }

  /* ── Collapse accordions and attach toggle handlers (review mode) ── */

  function setupAccordionToggles() {
    var HEADER_SEL = '.top-accordion-header, .applicant-header, .sub-accordion-header, .accordion-header';
    var BODY_SEL   = '.top-accordion-body, .applicant-body, .sub-accordion-body, .accordion-body';

    /* Collapse all accordion bodies first */
    document.querySelectorAll(BODY_SEL).forEach(function (body) {
      body.style.display = 'none';
    });

    /* Open just the first top-level accordion so the page is not blank */
    var firstBody = document.querySelector('.top-accordion-body, .applicant-body');
    if (firstBody) firstBody.style.display = 'block';

    /* Chevron indicator styles */
    var chevStyle = document.createElement('style');
    chevStyle.textContent =
      '.tdot-chevron { display: inline-block; margin-left: 8px; transition: transform .2s; font-size: .7em; }' +
      '.tdot-chevron.open { transform: rotate(90deg); }';
    document.head.appendChild(chevStyle);

    /* Attach click handlers to all accordion headers */
    document.querySelectorAll(HEADER_SEL).forEach(function (header) {
      header.style.cursor = 'pointer';
      header.style.userSelect = 'none';
      /* pointer-events might be blocked by makeReadOnly — override for headers */
      header.style.pointerEvents = 'auto';

      /* Add a chevron indicator */
      var chev = document.createElement('span');
      chev.className = 'tdot-chevron';
      chev.textContent = '\u25B6';
      header.appendChild(chev);

      /* Determine initial state from the body's display */
      var body = header.nextElementSibling;
      if (!body) return;
      var isBody = false;
      BODY_SEL.split(', ').forEach(function (sel) { if (body.matches(sel)) isBody = true; });
      if (!isBody) return;

      if (body.style.display !== 'none') chev.classList.add('open');

      /* Remove any existing inline onclick to avoid double-firing */
      header.removeAttribute('onclick');

      header.addEventListener('click', function (e) {
        /* Don't toggle if clicking a button inside the header (e.g. flag button) */
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        chev.classList.toggle('open', !open);
      });
    });
  }

  /* ── Pre-fill from saved data ── */

  function setValue(el, val) {
    if (!el || val === undefined || val === null) return;
    if (el.tagName === 'SELECT') {
      // Try exact match first, then case-insensitive
      var opts = Array.prototype.slice.call(el.options);
      var match = opts.find(function(o) { return o.value === val; }) ||
                  opts.find(function(o) { return o.value.toLowerCase() === String(val).toLowerCase(); }) ||
                  opts.find(function(o) { return o.text.toLowerCase() === String(val).toLowerCase(); });
      if (match) { el.value = match.value; }
    } else {
      el.value = val;
    }
  }

  function prefill(fields) {
    console.log('[TDOT Review] SAVED_DATA entries:', SAVED_DATA.length, '  DOM fields:', fields.length);

    /* ── Self-test: verify el.value assignment works at all ── */
    if (fields.length > 0) {
      var testEl = fields[0].el;
      var prev   = testEl.value;
      testEl.value = '__TDOT_TEST__';
      var testResult = testEl.value;
      testEl.value = prev; // restore
      console.log('[TDOT Review] Value assignment self-test:', testResult === '__TDOT_TEST__' ? 'OK' : 'BROKEN — el.value does not stick! tag=' + testEl.tagName + ' type=' + testEl.type);
    }

    /* Dump first 3 saved entries and field entries for comparison */
    for (var di = 0; di < Math.min(3, SAVED_DATA.length); di++) {
      console.log('[TDOT Review] SAVED_DATA[' + di + ']:', JSON.stringify(SAVED_DATA[di]));
    }
    for (var fi = 0; fi < Math.min(3, fields.length); fi++) {
      console.log('[TDOT Review] field[' + fi + ']: key=' + fields[fi].key + ' label=' + fields[fi].label + ' tag=' + fields[fi].el.tagName);
    }

    /* ── Strategy 1: key-based match ── */
    var byKey = {};
    for (var i = 0; i < SAVED_DATA.length; i++) {
      var entry = SAVED_DATA[i];
      if (entry && entry.key && entry.value !== undefined) byKey[entry.key] = entry.value;
    }
    var keyMatched = 0;
    for (var j = 0; j < fields.length; j++) {
      var v = byKey[fields[j].key];
      if (v !== undefined && v !== '') { setValue(fields[j].el, v); keyMatched++; }
    }
    console.log('[TDOT Review] Key-matched:', keyMatched);

    /* ── Strategy 2: label+occurrence match ── */
    if (keyMatched === 0) {
      console.warn('[TDOT Review] Key match 0 — trying label+occurrence');
      var byLabel = {};
      for (var li = 0; li < SAVED_DATA.length; li++) {
        var ld = SAVED_DATA[li];
        if (!ld) continue;
        var lbl = (ld.label || '').trim().toLowerCase();
        if (!byLabel[lbl]) byLabel[lbl] = [];
        byLabel[lbl].push(ld.value);
      }
      var lblOcc = {};
      var lblMatched = 0;
      for (var lj = 0; lj < fields.length; lj++) {
        var fld = fields[lj];
        var fkey = (fld.label || '').trim().toLowerCase();
        var occ  = lblOcc[fkey] || 0;
        lblOcc[fkey] = occ + 1;
        if (byLabel[fkey] && byLabel[fkey][occ] !== undefined && byLabel[fkey][occ] !== '') {
          setValue(fld.el, byLabel[fkey][occ]);
          lblMatched++;
        }
      }
      console.log('[TDOT Review] Label-matched:', lblMatched);

      /* ── Strategy 3: positional match as last resort ── */
      if (lblMatched === 0) {
        console.warn('[TDOT Review] Label match 0 — using positional fallback');
        var limit = Math.min(fields.length, SAVED_DATA.length);
        var posMatched = 0;
        for (var k = 0; k < limit; k++) {
          var pd = SAVED_DATA[k];
          if (pd && pd.value !== undefined && pd.value !== '') {
            setValue(fields[k].el, pd.value);
            posMatched++;
          }
        }
        console.log('[TDOT Review] Positional-matched:', posMatched);

        /* Verify first 3 assignments stuck */
        for (var vi = 0; vi < Math.min(limit, 10); vi++) {
          if (SAVED_DATA[vi] && SAVED_DATA[vi].value !== '') {
            console.log('[TDOT Review] pos[' + vi + '] expected=' + JSON.stringify(SAVED_DATA[vi].value) + ' got=' + JSON.stringify(fields[vi].el.value));
          }
        }
      }
    }
  }

  /* ── Make form read-only via CSS (not disabled attribute) ── */
  /* Using pointer-events:none keeps values visible without browser quirks   */
  /* that sometimes prevent disabled inputs from displaying assigned values. */

  function makeReadOnly() {
    var style = document.createElement('style');
    style.textContent =
      /* Lock ALL form inputs — flag editor overrides these below */
      'input, select, textarea {' +
        'pointer-events: none !important;' +
        'user-select: none !important;' +
        '-webkit-user-select: none !important;' +
        'cursor: default !important;' +
        'background: #f9fafb !important;' +
        'color: #374151 !important;' +
        'border-color: #e5e7eb !important;' +
      '}' +
      'select { -webkit-appearance: none !important; appearance: none !important; }' +
      /* Higher specificity overrides unlock the flag editor and review bar */
      '.tdot-flag-editor textarea {' +
        'pointer-events: auto !important;' +
        'cursor: text !important;' +
        'user-select: text !important;' +
        'background: white !important;' +
        'color: #111 !important;' +
        '-webkit-appearance: auto !important; appearance: auto !important;' +
      '}' +
      '.tdot-flag-editor button, .tdot-flag-btn, #tdot-review-bar button {' +
        'pointer-events: auto !important;' +
        'cursor: pointer !important;' +
      '}';
    document.head.appendChild(style);
  }

  /* ── Flag counter UI ── */

  function updateFlagCount() {
    var n   = Object.keys(flags).length;
    var cnt = document.getElementById('tdot-flag-count');
    var btn = document.getElementById('tdot-notify-btn');
    if (cnt) cnt.textContent = n + ' flag' + (n !== 1 ? 's' : '');
    if (btn) btn.textContent = 'Send Correction Request (' + n + ')';
  }

  /* ── Persist flags to server ── */

  async function persistFlags() {
    try {
      if (IS_MULTI_REVIEW) {
        /* Persist flags per member — split global flags map by member prefix */
        var perMember = {};
        for (var fk in flags) {
          if (!flags.hasOwnProperty(fk)) continue;
          var match = fk.match(/^__([^_]+(?:-[^_]+)*)__(.+)$/);
          if (match) {
            var mk = match[1], realKey = match[2];
            if (!perMember[mk]) perMember[mk] = {};
            perMember[mk][realKey] = flags[fk];
          } else {
            /* Primary applicant flags (no prefix) */
            if (!perMember['primary']) perMember['primary'] = {};
            perMember['primary'][fk] = flags[fk];
          }
        }
        for (var memberKey in perMember) {
          var r = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/flag', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ formKey: memberKey + REVIEW_KEY_SUFFIX, flags: perMember[memberKey] }),
            credentials: 'same-origin',
          });
          if (!r.ok) throw new Error('Server returned ' + r.status);
        }
        return;
      }
      var r = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/flag', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ formKey: FORM_KEY, flags: flags }),
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('Server returned ' + r.status);
    } catch (err) {
      console.error('[TDOT Review] Flag save failed:', err);
      var msg = document.getElementById('tdot-notify-msg');
      if (msg) { msg.textContent = '\u26a0 Flag save failed — please re-login and try again'; msg.style.color = '#fca5a5'; }
      alert('Could not save flag to server: ' + err.message + '\\n\\nPlease refresh the page and re-login if needed.');
    }
  }

  /* ── Build flag button + inline editor for one field ── */

  function attachFlagUI(field) {
    var group = field.group;
    if (!group) return;

    /* In multi-member review, prefix the flag key with __memberKey__ */
    var flagKey = field.key;
    if (IS_MULTI_REVIEW) {
      var mk = getMemberKeyForEl(field.el);
      flagKey = '__' + mk + '__' + field.key;
    }

    var btn = document.createElement('button');
    btn.className = 'tdot-flag-btn' + (flags[flagKey] ? ' flagged' : '');
    btn.type      = 'button';
    btn.innerHTML = flags[flagKey] ? '\ud83d\udea9 Flagged' : '\ud83d\udea9 Flag';

    /* Place the flag button inline with the label — wrap both in a flex row */
    var lbl = group.querySelector('label');
    if (lbl) {
      var row = document.createElement('div');
      row.className = 'tdot-label-row';
      lbl.parentNode.insertBefore(row, lbl);
      row.appendChild(lbl);
      row.appendChild(btn);
    } else {
      /* Table row or labelless group — prepend the button */
      group.insertBefore(btn, group.firstChild);
    }

    /* Inline editor container (hidden by default) */
    var editor = null;

    /* Note shown when flagged */
    var note = null;

    function renderNote() {
      if (note) note.remove();
      note = null;
      if (!flags[flagKey]) return;
      note = document.createElement('div');
      note.className = 'tdot-flag-note';
      note.innerHTML = '\ud83d\udcac ' + escHtml(flags[flagKey].comment);
      /* Show client reply if present */
      if (flags[flagKey].clientReply) {
        var replyEl = document.createElement('div');
        replyEl.style.cssText =
          'margin-top:8px;padding:8px 10px;background:#eff6ff;border:1px solid #bfdbfe;' +
          'border-radius:6px;font-size:12px;color:#1e40af;line-height:1.5;';
        replyEl.innerHTML =
          '<strong>\u2709\ufe0f Client reply:</strong> ' + escHtml(flags[flagKey].clientReply) +
          (flags[flagKey].clientRepliedAt
            ? '<div style="font-size:10px;color:#6b7280;margin-top:3px;">' +
              new Date(flags[flagKey].clientRepliedAt).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
              '</div>'
            : '');
        note.appendChild(replyEl);
      }
      group.appendChild(note);
      group.classList.add('tdot-flagged');
    }

    function openEditor() {
      if (editor) { editor.remove(); editor = null; return; }
      var existing = (flags[flagKey] || {}).comment || '';
      editor = document.createElement('div');
      editor.className = 'tdot-flag-editor';
      editor.innerHTML =
        '<textarea placeholder="Write a note for the client about this field...">' + existing + '</textarea>' +
        '<div class="fe-actions">' +
          '<button class="fe-save" type="button">Save Flag</button>' +
          (flags[flagKey] ? '<button class="fe-remove" type="button">Remove Flag</button>' : '') +
          '<button class="fe-cancel" type="button">Cancel</button>' +
        '</div>';

      editor.querySelector('.fe-save').onclick = async function () {
        var comment = editor.querySelector('textarea').value.trim();
        if (!comment) { alert('Please write a note before saving.'); return; }
        flags[flagKey] = { label: field.label, section: field.section, comment: comment, flaggedBy: STAFF_NAME, flaggedAt: new Date().toISOString() };
        btn.className = 'tdot-flag-btn flagged';
        btn.innerHTML = '\ud83d\udea9 Flagged';
        editor.remove(); editor = null;
        renderNote();
        updateFlagCount();
        await persistFlags();
      };

      var removeBtn = editor.querySelector('.fe-remove');
      if (removeBtn) {
        removeBtn.onclick = async function () {
          if (!confirm('Remove this flag?')) return;
          delete flags[flagKey];
          btn.className = 'tdot-flag-btn';
          btn.innerHTML = '\ud83d\udea9 Flag';
          editor.remove(); editor = null;
          if (note) { note.remove(); note = null; }
          group.classList.remove('tdot-flagged');
          updateFlagCount();
          await persistFlags();
        };
      }

      editor.querySelector('.fe-cancel').onclick = function () { editor.remove(); editor = null; };
      group.appendChild(editor);
    }

    btn.onclick = openEditor;
    renderNote();
  }

  /* ── Review bar ── */

  function createReviewBar() {
    var bar = document.createElement('div');
    bar.id  = 'tdot-review-bar';
    bar.innerHTML =
      '<div class="rb-left">' +
        '<div class="rb-title">\ud83d\udd0d Questionnaire Review \u2014 ' + CASE_REF + '</div>' +
        '<div class="rb-sub">Reviewing as ' + STAFF_NAME + '</div>' +
      '</div>' +
      '<div class="rb-right">' +
        '<span id="tdot-flag-count">0 flags</span>' +
        '<span id="tdot-notify-msg"></span>' +
        '<button id="tdot-export-btn" type="button" ' +
          'style="padding:7px 16px;border:1px solid rgba(255,255,255,.35);border-radius:6px;background:transparent;color:#fff;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">' +
          '\u2b07 Export PDF' +
        '</button>' +
        '<button id="tdot-notify-btn" type="button">Send Correction Request (0)</button>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);

    document.getElementById('tdot-export-btn').onclick = function () {
      window.open('/q/' + encodeURIComponent(CASE_REF) + '/export-pdf?formKey=' + encodeURIComponent(FORM_KEY), '_blank');
    };

    document.getElementById('tdot-notify-btn').onclick = async function () {
      var n = Object.keys(flags).length;
      if (!n) { alert('Flag at least one field before sending.'); return; }
      if (!confirm('Send a correction request email to the client?\\n\\n' + n + ' flag' + (n !== 1 ? 's' : '') + ' will be included.')) return;
      var btn = document.getElementById('tdot-notify-btn');
      var msg = document.getElementById('tdot-notify-msg');
      btn.disabled = true;
      try {
        if (IS_MULTI_REVIEW) {
          /* Multi-member: collect unique member keys and send ONE consolidated email */
          var memberKeys = {};
          for (var fk in flags) {
            if (!flags.hasOwnProperty(fk)) continue;
            var match = fk.match(/^__([^_]+(?:-[^_]+)*)__(.+)$/);
            var mk = match ? match[1] : 'primary';
            memberKeys[mk] = true;
          }
          var keys = Object.keys(memberKeys);
          var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/notify-all', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ memberKeys: keys, formKeySuffix: REVIEW_KEY_SUFFIX }),
            credentials: 'same-origin',
          });
          if (!res.ok) {
            var errBody = await res.json().catch(function() { return {}; });
            throw new Error(errBody.error || 'Server error ' + res.status);
          }
        } else {
          var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/notify', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ formKey: FORM_KEY }),
            credentials: 'same-origin',
          });
          if (!res.ok) {
            var errBody = await res.json().catch(function() { return {}; });
            throw new Error(errBody.error || 'Server error ' + res.status);
          }
        }
        if (msg) { msg.textContent = '\u2713 Email sent'; msg.style.color = '#86efac'; }
      } catch (err) {
        alert('Failed to send: ' + err.message);
        btn.disabled = false;
      }
    };
  }

  /* ── Init ── */

  /* ── Multi-member review DOM setup ── */

  var MEMBER_ICONS = {
    'Principal Applicant':        '👤',
    'Spouse / Common-Law Partner': '💑',
    'Dependent Child':            '👶',
    'Sponsor':                    '🏠',
    'Worker Spouse':              '👷',
    'Parent':                     '👨‍👩‍👧',
    'Sibling':                    '👫',
  };

  var KEEP_SECTIONS_FOR = {
    'Dependent Child': ['profile', 'personal', 'passport', 'flagged'],
    'Parent':          ['profile', 'personal', 'passport', 'address', 'contact', 'flagged'],
    'Sibling':         ['profile', 'personal', 'passport', 'flagged'],
  };

  function setupMultiMemberReview() {
    var topSections = document.querySelectorAll('.top-accordion, .applicant-accordion');
    topSections = Array.prototype.slice.call(topSections);
    if (topSections.length === 0) return;

    var primarySection = topSections[0];
    primarySection.setAttribute('data-member-key', 'primary');

    /* Clone the dependent section as blueprint, remove all dependent sections */
    var blueprint = topSections.length > 1 ? topSections[1].cloneNode(true) : primarySection.cloneNode(true);
    for (var i = 1; i < topSections.length; i++) topSections[i].remove();

    /* Create sections for each non-primary member */
    var insertRef = primarySection;
    for (var mi = 0; mi < REVIEW_MEMBERS.length; mi++) {
      var m = REVIEW_MEMBERS[mi];
      if (m.key === 'primary') continue;

      var section = blueprint.cloneNode(true);
      section.setAttribute('data-member-key', m.key);
      section.style.position = 'relative';

      /* Update header */
      var header = section.querySelector('.top-accordion-header, .applicant-header');
      if (header) {
        var chevron = header.querySelector('.chevron');
        var icon = MEMBER_ICONS[m.type] || '👤';
        header.textContent = '';
        header.appendChild(document.createTextNode(icon + '  ' + m.label));
        var typeBadge = document.createElement('span');
        typeBadge.className = 'mm-review-section-label';
        typeBadge.textContent = m.type.split(' / ')[0];
        header.appendChild(typeBadge);
        if (chevron) header.appendChild(chevron.cloneNode(true));
      }

      /* Adjust sub-sections for member type */
      var keepList = KEEP_SECTIONS_FOR[m.type];
      if (keepList) {
        var subs = section.querySelectorAll('.sub-accordion, .accordion');
        for (var si = 0; si < subs.length; si++) {
          var subH = subs[si].querySelector('.sub-accordion-header, .accordion-header');
          if (!subH) continue;
          var text = (subH.textContent || '').toLowerCase();
          var keep = false;
          for (var k = 0; k < keepList.length; k++) {
            if (text.indexOf(keepList[k]) !== -1) { keep = true; break; }
          }
          if (!keep) subs[si].style.display = 'none';
        }
      }

      /* Deduplicate IDs */
      var idEls = section.querySelectorAll('[id]');
      for (var ii = 0; ii < idEls.length; ii++) idEls[ii].id = m.key + '-' + idEls[ii].id;
      var ocEls = section.querySelectorAll('[onchange]');
      for (var oi = 0; oi < ocEls.length; oi++) {
        var oc = ocEls[oi].getAttribute('onchange') || '';
        if (oc.indexOf('toggleConditional') !== -1) {
          ocEls[oi].setAttribute('onchange',
            oc.replace(/toggleConditional\\(this,\\s*'([^']+)'\\)/,
              "toggleConditional(this,'" + m.key + "-$1')"));
        }
      }

      insertRef.parentNode.insertBefore(section, insertRef.nextSibling);
      insertRef = section;
    }
  }

  function prefillMultiMemberReview() {
    for (var mi = 0; mi < REVIEW_MEMBERS.length; mi++) {
      var m = REVIEW_MEMBERS[mi];
      var memberSection = document.querySelector('[data-member-key="' + m.key + '"]');
      if (!memberSection || !m.fields || !m.fields.length) continue;

      /* Collect fields only within this member section */
      var allFields = collectFields();
      var memberFields = allFields.filter(function(f) {
        return getMemberKeyForEl(f.el) === m.key;
      });

      /* Build lookup maps from member's saved data */
      var byKey = {}, byLabel = {};
      for (var i = 0; i < m.fields.length; i++) {
        var sf = m.fields[i];
        if (!sf.value || !sf.value.trim()) continue;
        byKey[sf.key] = sf.value;
        var lbl = (sf.label || '').trim().toLowerCase();
        if (!byLabel[lbl]) byLabel[lbl] = [];
        byLabel[lbl].push(sf.value);
      }

      var matched = 0, lblOcc = {};
      for (var fi = 0; fi < memberFields.length; fi++) {
        var f = memberFields[fi];
        var val = byKey[f.key];
        if (!val) {
          var fLbl = (f.label || '').trim().toLowerCase();
          var occ = lblOcc[fLbl] || 0;
          lblOcc[fLbl] = occ + 1;
          if (byLabel[fLbl] && byLabel[fLbl][occ]) val = byLabel[fLbl][occ];
        }
        if (val) { setValue(f.el, val); matched++; }
      }
      console.log('[TDOT Review] Pre-filled ' + m.key + ': ' + matched + ' fields');

      /* Merge member flags into the global flags map (prefixed) */
      if (m.flags) {
        for (var fk in m.flags) {
          if (m.flags.hasOwnProperty(fk)) {
            flags['__' + m.key + '__' + fk] = m.flags[fk];
          }
        }
      }
    }
  }

  function init() {
    if (IS_MULTI_REVIEW) {
      setupMultiMemberReview();
    }
    expandAll();
    var fields = collectFields();

    if (IS_MULTI_REVIEW) {
      prefillMultiMemberReview();
    } else {
      prefill(fields);
    }

    makeReadOnly();
    fields.forEach(attachFlagUI);
    createReviewBar();
    updateFlagCount();
    setupAccordionToggles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
`;
}

/**
 * Serve the actual HTML questionnaire form in read-only staff-review mode.
 * Staff can flag individual fields with comments and send correction requests.
 * Uses the same field-collection logic as the client script so flag keys match exactly.
 */
function buildReviewFormPage({ formFile, caseRef, formKey, staffName, savedFields, savedFlags, members, formKeySuffix }) {
  const filePath = path.join(FORMS_DIR, formFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Form file not found: ${formFile}`);
  }

  const html   = fs.readFileSync(filePath, 'utf8');
  const script = buildReviewInjectionScript({ caseRef, formKey, staffName, savedFields, savedFlags, members, formKeySuffix });

  if (html.includes('</body>')) {
    return html.replace('</body>', script + '\n</body>');
  }
  return html + script;
}

// ─── PDF Export page ─────────────────────────────────────────────────────────
//
// Generates a clean, printer-friendly HTML report from saved field data.
// Opened in a new tab by the "Export PDF" button on the review bar; the
// browser's native print / Save as PDF dialog is triggered automatically.
// No external libraries are required.

function buildPrintPage({ caseRef, clientName, caseType, caseSubType, savedFields, savedFlags, staffName }) {

  // ── Group fields by section (preserving insertion order) ─────────────────
  const sectionMap = new Map();
  for (const f of savedFields) {
    const sec = (f.section || 'General').trim();
    if (!sectionMap.has(sec)) sectionMap.set(sec, []);
    sectionMap.get(sec).push(f);
  }

  const totalFields    = savedFields.length;
  const answeredFields = savedFields.filter(f => f.value && f.value.trim()).length;
  const pct            = totalFields > 0 ? Math.round(answeredFields / totalFields * 100) : 0;
  const flagCount      = savedFlags ? Object.keys(savedFlags).length : 0;
  const caseLabel      = caseSubType ? `${caseType} — ${caseSubType}` : caseType;
  const exportedAt     = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true, dateStyle: 'long', timeStyle: 'short' });

  // ── Build sections HTML ───────────────────────────────────────────────────
  let sectionsHtml = '';
  let fieldIndex   = 0;

  for (const [sectionName, fields] of sectionMap) {
    const rowsHtml = fields.map(f => {
      fieldIndex++;
      const isFlagged    = savedFlags && savedFlags[f.key];
      const flagComment  = isFlagged ? (savedFlags[f.key].comment || '') : '';
      const hasValue     = f.value && f.value.trim();
      const displayValue = hasValue ? f.value.trim() : '';

      // Format multi-line values (e.g. addresses, notes)
      const formattedValue = displayValue
        ? displayValue.split(/\n/).map(l => `<span>${escHtml(l)}</span>`).join('<br>')
        : '<span class="no-answer">— Not provided —</span>';

      return `
        <tr class="${isFlagged ? 'row-flagged' : (hasValue ? '' : 'row-empty')}">
          <td class="q-num">${fieldIndex}</td>
          <td class="q-label">${escHtml(f.label || f.key || '')}</td>
          <td class="q-answer">
            ${formattedValue}
            ${isFlagged ? `<div class="flag-note">⚑ Officer note: ${escHtml(flagComment)}</div>` : ''}
          </td>
        </tr>`;
    }).join('');

    sectionsHtml += `
      <div class="section">
        <div class="section-header">${escHtml(sectionName)}</div>
        <table class="field-table">
          <colgroup>
            <col style="width:40px">
            <col style="width:42%">
            <col>
          </colgroup>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
  }

  if (!sectionsHtml) {
    sectionsHtml = '<p class="no-data">No field data found for this questionnaire.</p>';
  }

  // ── Status pill ───────────────────────────────────────────────────────────
  const pillClass = pct >= 80 ? 'pill-green' : (pct >= 40 ? 'pill-amber' : 'pill-red');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Questionnaire Export — ${escHtml(caseRef)}</title>
  <style>
    /* ── Base ──────────────────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
      color: #1f2937;
      background: #f8fafc;
      margin: 0;
      padding: 0;
    }
    a { color: #1e40af; }

    /* ── Screen-only toolbar ───────────────────────────────────────────────── */
    #print-toolbar {
      position: fixed; top: 0; left: 0; right: 0; height: 50px;
      background: #1e3a5f; color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 24px; z-index: 9999;
      font-size: 13px; gap: 16px;
    }
    #print-toolbar .tb-title { font-weight: 700; }
    #print-toolbar .tb-sub   { font-size: 11px; color: rgba(255,255,255,.65); margin-top: 1px; }
    #print-toolbar .tb-btns  { display: flex; gap: 10px; flex-shrink: 0; }
    .btn-print {
      padding: 7px 18px; background: #059669; color: #fff;
      border: none; border-radius: 6px; font-size: 13px; font-weight: 600;
      cursor: pointer;
    }
    .btn-print:hover { background: #047857; }
    .btn-close {
      padding: 7px 14px; background: transparent; color: rgba(255,255,255,.8);
      border: 1px solid rgba(255,255,255,.3); border-radius: 6px; font-size: 13px;
      cursor: pointer;
    }
    .btn-close:hover { background: rgba(255,255,255,.1); }

    /* ── Page wrapper ──────────────────────────────────────────────────────── */
    .page-wrapper {
      max-width: 820px; margin: 70px auto 40px; padding: 0 20px;
    }

    /* ── Report header ─────────────────────────────────────────────────────── */
    .report-header {
      background: #1e3a5f; color: #fff;
      border-radius: 12px; padding: 28px 32px; margin-bottom: 24px;
    }
    .report-header .org-name {
      font-size: 11px; font-weight: 600; letter-spacing: 1.2px;
      text-transform: uppercase; color: rgba(255,255,255,.6); margin-bottom: 6px;
    }
    .report-header h1 {
      font-size: 22px; font-weight: 700; margin: 0 0 14px;
    }
    .meta-grid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 32px;
      font-size: 12px;
    }
    .meta-grid dt { color: rgba(255,255,255,.55); margin-bottom: 1px; }
    .meta-grid dd { color: #fff; font-weight: 600; margin: 0; }

    /* ── Summary bar ───────────────────────────────────────────────────────── */
    .summary-bar {
      display: flex; gap: 14px; margin-bottom: 24px; flex-wrap: wrap;
    }
    .summary-card {
      flex: 1; min-width: 130px;
      background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
      padding: 14px 18px; text-align: center;
    }
    .summary-card .sc-value { font-size: 26px; font-weight: 700; color: #1e3a5f; }
    .summary-card .sc-label { font-size: 11px; color: #6b7280; margin-top: 2px; }
    .pill {
      display: inline-block; padding: 3px 10px; border-radius: 20px;
      font-size: 11px; font-weight: 700;
    }
    .pill-green  { background: #d1fae5; color: #065f46; }
    .pill-amber  { background: #fef3c7; color: #92400e; }
    .pill-red    { background: #fee2e2; color: #991b1b; }
    ${flagCount > 0 ? `.flag-warning {
      background: #fff7ed; border: 1px solid #fde68a; border-radius: 10px;
      padding: 12px 18px; margin-bottom: 20px; font-size: 13px; color: #92400e;
      display: flex; align-items: center; gap: 10px;
    }` : ''}

    /* ── Sections ──────────────────────────────────────────────────────────── */
    .section { margin-bottom: 24px; }
    .section-header {
      background: #1e3a5f; color: #fff;
      font-size: 12px; font-weight: 700; letter-spacing: .5px;
      padding: 8px 16px; border-radius: 8px 8px 0 0;
      text-transform: uppercase;
    }
    .field-table {
      width: 100%; border-collapse: collapse;
      background: #fff;
      border: 1px solid #e5e7eb; border-top: none;
      border-radius: 0 0 8px 8px; overflow: hidden;
    }
    .field-table td {
      padding: 9px 12px;
      border-bottom: 1px solid #f3f4f6;
      vertical-align: top;
      font-size: 12.5px;
      line-height: 1.5;
    }
    .field-table tbody tr:last-child td { border-bottom: none; }
    .q-num {
      color: #9ca3af; font-size: 11px; text-align: right;
      padding-right: 6px; white-space: nowrap;
    }
    .q-label { color: #374151; font-weight: 600; }
    .q-answer { color: #111827; }
    .no-answer { color: #9ca3af; font-style: italic; }
    .row-flagged { background: #fffbeb !important; }
    .row-empty   { background: #fafafa; }
    .flag-note {
      margin-top: 6px; font-size: 11.5px; color: #92400e;
      background: #fef3c7; border-left: 3px solid #f59e0b;
      padding: 4px 8px; border-radius: 0 5px 5px 0;
    }
    .no-data { color: #6b7280; font-style: italic; text-align: center; padding: 40px; }

    /* ── Footer ────────────────────────────────────────────────────────────── */
    .report-footer {
      margin-top: 32px; padding-top: 16px;
      border-top: 1px solid #e5e7eb;
      font-size: 11px; color: #9ca3af; text-align: center; line-height: 1.7;
    }

    /* ── Print overrides ───────────────────────────────────────────────────── */
    @media print {
      body { background: white; font-size: 11pt; }
      #print-toolbar { display: none !important; }
      .page-wrapper { margin-top: 0; max-width: 100%; padding: 0; }
      .report-header { border-radius: 0; padding: 18px 20px; }
      .report-header h1 { font-size: 17pt; }
      .summary-bar { break-inside: avoid; }
      .summary-card { border: 1px solid #d1d5db; }
      .section { break-inside: avoid; page-break-inside: avoid; }
      .section-header { border-radius: 0; }
      .field-table { border-left: none; border-right: none; border-radius: 0; }
      .field-table td { font-size: 10pt; }
      .report-footer { font-size: 9pt; }
    }
  </style>
</head>
<body>

<!-- Screen-only toolbar -->
<div id="print-toolbar">
  <div>
    <div class="tb-title">Questionnaire Export — ${escHtml(caseRef)}</div>
    <div class="tb-sub">${escHtml(clientName)}</div>
  </div>
  <div class="tb-btns">
    <button class="btn-print" onclick="window.print()">⬇ Save as PDF / Print</button>
    <button class="btn-close" onclick="window.close()">Close</button>
  </div>
</div>

<div class="page-wrapper">

  <!-- Report header -->
  <div class="report-header">
    <div class="org-name">TDOT Immigration</div>
    <h1>Questionnaire Submission Report</h1>
    <dl class="meta-grid">
      <dt>Case Reference</dt><dd>${escHtml(caseRef)}</dd>
      <dt>Client Name</dt><dd>${escHtml(clientName)}</dd>
      <dt>Case Type</dt><dd>${escHtml(caseLabel)}</dd>
      <dt>Exported By</dt><dd>${escHtml(staffName)}</dd>
      <dt>Export Date &amp; Time</dt><dd>${escHtml(exportedAt)}</dd>
      <dt>Completion</dt><dd><span class="pill ${pillClass}">${pct}%</span></dd>
    </dl>
  </div>

  <!-- Summary cards -->
  <div class="summary-bar">
    <div class="summary-card">
      <div class="sc-value">${answeredFields}</div>
      <div class="sc-label">Fields Answered</div>
    </div>
    <div class="summary-card">
      <div class="sc-value">${totalFields - answeredFields}</div>
      <div class="sc-label">Fields Not Provided</div>
    </div>
    <div class="summary-card">
      <div class="sc-value">${pct}%</div>
      <div class="sc-label">Completion Rate</div>
    </div>
    <div class="summary-card">
      <div class="sc-value" style="color:${flagCount > 0 ? '#b45309' : '#059669'}">${flagCount}</div>
      <div class="sc-label">Officer Flags</div>
    </div>
  </div>

  ${flagCount > 0 ? `<div class="flag-warning">
    ⚑ &nbsp; <strong>${flagCount} field${flagCount === 1 ? '' : 's'} flagged for correction.</strong>
    These are highlighted below in amber and include officer notes.
  </div>` : ''}

  <!-- Questionnaire sections -->
  ${sectionsHtml}

  <!-- Footer -->
  <div class="report-footer">
    <p>Generated on ${escHtml(exportedAt)} by ${escHtml(staffName)} — TDOT Immigration Internal Use Only</p>
    <p>This document contains confidential client information. Do not distribute outside authorised staff.</p>
  </div>

</div>

<script>
  // Auto-open print dialog after a short delay so the page is fully rendered
  window.addEventListener('load', function () {
    setTimeout(function () { window.print(); }, 800);
  });
</script>

</body>
</html>`;
}

// ─── HTML escape helper (shared) ─────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  validateAccess,
  resolveForm,
  loadFormData,
  saveFormData,
  markSubmitted,
  markAllSubmitted,
  // Member manifest management
  loadMembers,
  addMember,
  removeMember,
  getMemberStatuses,
  markMemberSubmitted,
  // Page builders
  buildFormPage,
  buildReviewFormPage,
  buildPrintPage,
  buildOverviewPage,
  buildPlaceholderPage,
  buildErrorPage,
};
