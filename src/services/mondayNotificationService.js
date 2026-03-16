/**
 * Monday Notification Service
 *
 * Sends Monday.com in-app notifications to the right people when key
 * events occur on the boards. Uses Monday.com's create_notification API
 * so the recipient sees an alert in their notification bell AND receives
 * Monday.com's own notification email — no external email credentials needed.
 *
 * Triggers handled (called from mondayWebhook.js):
 *
 *   Document Execution Board:
 *     onDocumentReceived         → notify Assigned Reviewer
 *     onDocumentReworkRequired   → notify Case Manager (via Client Master lookup)
 *
 *   Questionnaire Execution Board:
 *     onResponseAnswered         → notify Assigned Reviewer
 *     onNeedsClarificationNotify → notify Assigned Reviewer
 *
 *   Client Master Board:
 *     onCaseHealthRed            → notify Ops Supervisor
 *     onExpiryFlagged            → notify Ops Supervisor + Case Manager
 *     onClientBlocked            → notify Ops Supervisor + Case Manager
 *     onEscalationRequired       → notify Ops Supervisor
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const DOC_BOARD = process.env.MONDAY_EXECUTION_BOARD_ID               || '18401875593';
const Q_BOARD   = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';

// ─── Column IDs ───────────────────────────────────────────────────────────────

const DOC_COLS = {
  caseRef:          'text_mm0z2cck',
  assignedReviewer: 'multiple_person_mm0zsa92',
};

const Q_COLS = {
  caseRef:          'text_mm12dgy9',
  assignedReviewer: 'multiple_person_mm133n36',
};

const CM_COLS = {
  caseRef:      'text_mm142s49',
  opsSupervisor:'multiple_person_mm0xp0sq',
  caseManager:  'multiple_person_mm0xhmgk',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractPersonIds(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return (parsed.personsAndTeams || [])
      .filter((p) => p.kind === 'person')
      .map((p) => p.id);
  } catch { return []; }
}

async function sendNotification(userId, text, targetItemId) {
  try {
    await mondayApi.query(
      `mutation($userId: ID!, $text: String!, $targetId: ID!) {
         create_notification(
           user_id:     $userId,
           target_id:   $targetId,
           text:        $text,
           target_type: Project
         ) { text }
       }`,
      { userId: String(userId), text, targetId: String(targetItemId) }
    );
  } catch (err) {
    console.warn(`[Notify] Failed to notify user ${userId}:`, err.message);
  }
}

async function notifyAll(userIds, text, targetItemId) {
  const unique = [...new Set(userIds.map(String))].filter(Boolean);
  for (const uid of unique) {
    await sendNotification(uid, text, targetItemId);
  }
}

// Fetch reviewer person IDs directly from an execution item
async function getItemPeople(itemId, colId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) { column_values(ids: ["${colId}"]) { id value } }
     }`,
    { itemId: String(itemId) }
  );
  const val = data?.items?.[0]?.column_values?.[0]?.value;
  return extractPersonIds(val);
}

// Look up Ops Supervisor + Case Manager from Client Master by case reference
async function getCaseOwners(caseRef) {
  if (!caseRef) return { supervisorIds: [], managerIds: [] };
  const data = await mondayApi.query(
    `query($boardId: ID!, $caseRef: String!) {
       items_page_by_column_values(
         board_id: $boardId, limit: 1,
         columns: [{ column_id: "${CM_COLS.caseRef}", column_values: [$caseRef] }]
       ) {
         items {
           id
           column_values(ids: ["${CM_COLS.opsSupervisor}", "${CM_COLS.caseManager}"]) { id value }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), caseRef }
  );
  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return { supervisorIds: [], managerIds: [], masterItemId: null };
  const col = (id) => item.column_values.find((c) => c.id === id)?.value;
  return {
    masterItemId:  item.id,
    supervisorIds: extractPersonIds(col(CM_COLS.opsSupervisor)),
    managerIds:    extractPersonIds(col(CM_COLS.caseManager)),
  };
}

async function getCaseRefFromItem(itemId, caseRefColId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) { column_values(ids: ["${caseRefColId}"]) { id text } }
     }`,
    { itemId: String(itemId) }
  );
  return data?.items?.[0]?.column_values?.[0]?.text?.trim() || '';
}

// ─── Document Execution triggers ─────────────────────────────────────────────

async function onDocumentReceived(itemId, itemName) {
  const reviewerIds = await getItemPeople(itemId, DOC_COLS.assignedReviewer);
  if (!reviewerIds.length) {
    console.log(`[Notify] onDocumentReceived: no reviewer assigned for item ${itemId}`);
    return;
  }
  const text = `A new document has been uploaded and is ready for your review: "${itemName}"`;
  await notifyAll(reviewerIds, text, itemId);
  console.log(`[Notify] Document received — notified ${reviewerIds.length} reviewer(s) for item ${itemId}`);
}

async function onDocumentReworkRequired(itemId, itemName) {
  const caseRef = await getCaseRefFromItem(itemId, DOC_COLS.caseRef);
  const { managerIds, supervisorIds, masterItemId } = await getCaseOwners(caseRef);
  const ids = [...new Set([...managerIds, ...supervisorIds])];
  if (!ids.length) return;
  const text = `Document flagged for rework: "${itemName}" (Case: ${caseRef})`;
  await notifyAll(ids, text, masterItemId || itemId);
  console.log(`[Notify] Document rework — notified ${ids.length} person(s) for case ${caseRef}`);
}

// ─── Questionnaire Execution triggers ────────────────────────────────────────

async function onResponseAnswered(itemId, itemName) {
  const reviewerIds = await getItemPeople(itemId, Q_COLS.assignedReviewer);
  if (!reviewerIds.length) {
    console.log(`[Notify] onResponseAnswered: no reviewer assigned for item ${itemId}`);
    return;
  }
  const text = `A questionnaire response is ready for your review: "${itemName}"`;
  await notifyAll(reviewerIds, text, itemId);
  console.log(`[Notify] Response answered — notified ${reviewerIds.length} reviewer(s) for item ${itemId}`);
}

async function onNeedsClarificationNotify(itemId, itemName) {
  const reviewerIds = await getItemPeople(itemId, Q_COLS.assignedReviewer);
  if (!reviewerIds.length) return;
  const text = `Questionnaire item needs clarification follow-up: "${itemName}"`;
  await notifyAll(reviewerIds, text, itemId);
  console.log(`[Notify] Needs clarification — notified ${reviewerIds.length} reviewer(s) for item ${itemId}`);
}

// ─── Client Master Board triggers ────────────────────────────────────────────

async function onCaseHealthRed(masterItemId, itemName, caseRef) {
  const { supervisorIds } = await getCaseOwners(caseRef);
  if (!supervisorIds.length) return;
  const text = `Case Health is now RED and requires immediate attention: "${itemName}" (${caseRef})`;
  await notifyAll(supervisorIds, text, masterItemId);
  console.log(`[Notify] Case Health Red — notified supervisor(s) for ${caseRef}`);
}

async function onExpiryFlagged(masterItemId, itemName, caseRef) {
  const { supervisorIds, managerIds } = await getCaseOwners(caseRef);
  const ids = [...new Set([...supervisorIds, ...managerIds])];
  if (!ids.length) return;
  const text = `Expiry Risk Flag raised — a document is approaching its expiry date. Case: "${itemName}" (${caseRef})`;
  await notifyAll(ids, text, masterItemId);
  console.log(`[Notify] Expiry flagged — notified ${ids.length} person(s) for ${caseRef}`);
}

async function onClientBlocked(masterItemId, itemName, caseRef) {
  const { supervisorIds, managerIds } = await getCaseOwners(caseRef);
  const ids = [...new Set([...supervisorIds, ...managerIds])];
  if (!ids.length) return;
  const text = `Client has been blocked due to inactivity. Supervisor action required. Case: "${itemName}" (${caseRef})`;
  await notifyAll(ids, text, masterItemId);
  console.log(`[Notify] Client blocked — notified ${ids.length} person(s) for ${caseRef}`);
}

async function onEscalationRequired(masterItemId, itemName, caseRef) {
  const { supervisorIds } = await getCaseOwners(caseRef);
  if (!supervisorIds.length) return;
  const text = `Escalation Required has been triggered. Please review case: "${itemName}" (${caseRef})`;
  await notifyAll(supervisorIds, text, masterItemId);
  console.log(`[Notify] Escalation required — notified supervisor(s) for ${caseRef}`);
}

module.exports = {
  onDocumentReceived,
  onDocumentReworkRequired,
  onResponseAnswered,
  onNeedsClarificationNotify,
  onCaseHealthRed,
  onExpiryFlagged,
  onClientBlocked,
  onEscalationRequired,
};
