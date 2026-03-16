/**
 * Escalation Routing Service
 *
 * Runs daily AFTER the Case Health Engine, when all risk bands and health
 * statuses are already finalised. For each active case it:
 *
 *   1. Finds the best matching rule from the Escalation Routing Matrix Board.
 *      Matching key: Case Stage + Risk Band + (optional) Primary Case Type.
 *      Specific case-type rules take priority over general fallback rules.
 *
 *   2. Checks the cooldown window (Escalation Last Notified + rule's cooldown days).
 *      Skips if the case was already processed within the cooldown period.
 *
 *   3. Applies every action configured on the matching rule:
 *        - Notify Primary Ops Supervisor (rule-defined person or case's assigned supervisor)
 *        - Notify Secondary Director (rule-defined person, if set)
 *        - Notify Case Support Officer   (if rule says Yes)
 *        - Notify Assigned Case Manager  (if rule says Yes)
 *        - Increase Priority Score       (additive)
 *        - Lock Stage Movement           (Automation Lock = Locked)
 *        - Reassign Case To Supervisor   (copy Ops Supervisor → Case Manager)
 *        - Create Supervisor Task        (Monday.com in-app notification)
 *        - Send Client Reminder          (email using Client Message Template)
 *        - Send Final Notice             (email using Final Notice template)
 *        - Add SLA Extension             (increase SLA Total Days)
 *        - Change Escalation Status      (Yes / No / No Change)
 *        - Change Case Status            (new stage / No Change)
 *
 *   4. Writes Escalation Last Notified = today to record cooldown.
 *
 * Column IDs
 * ─────────────────────────────────────────────────────────────────────────────
 * Escalation Routing Matrix Board:
 *   dropdown_mm13ptxn  — Primary Case Type  (empty = applies to all types)
 *   dropdown_mm13gryx  — Case Stage
 *   color_mm13q1rs     — Risk Band          (Orange / Red)
 *   multiple_person_mm13mrnv — Escalate To (Primary Ops Supervisor)
 *   multiple_person_mm13m168 — Escalate To (Secondary Director)
 *   color_mm135wzd     — Notify Case Support Officer (Yes/No)
 *   color_mm14v7kv     — Notify Assigned Case Manager (Yes/No)
 *   color_mm14bqmp     — Supervisor Takeover Required (Yes/No)
 *   numeric_mm14638p   — Increase Priority Score
 *   color_mm14fyg2     — Lock Stage Movement (Yes/No)
 *   color_mm148mre     — Reassign Case To Supervisor (Yes/No)
 *   color_mm149mnb     — Create Supervisor Task (Yes/No)
 *   color_mm144ggm     — Send Client Reminder (Yes/No)
 *   color_mm146t4k     — Send Final Notice (Yes/No)
 *   long_text_mm14ecxn — Client Message Template
 *   numeric_mm14ga2t   — Add SLA Extension (Days)
 *   numeric_mm14mwr5   — Escalation Cooldown (Days)
 *   color_mm14v59d     — Rule Active? (Yes/No)
 *   date_mm14yfsr      — Effective From
 *   date_mm14h0pn      — Effective To
 *   color_mm1ae8w8     — Change Escalation Status To (Yes / No / No Change)
 *   color_mm1atxer     — Change Case Status To (stage name / No Change)
 *
 * Client Master Board (new columns added for this engine):
 *   numeric_mm1g7sax   — Priority Score
 *   date_mm1gqbd       — Escalation Last Notified
 */

const mondayApi             = require('./mondayApi');
const { sendEmail }         = require('./microsoftMailService');
const { clientMasterBoardId } = require('../../config/monday');

const ESC_BOARD_ID   = process.env.MONDAY_ESCALATION_BOARD_ID || '18402406604';
const BASE_URL       = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

// ─── Column IDs — Escalation Routing Matrix Board ────────────────────────────

const RULE = {
  caseType:           'dropdown_mm13ptxn',
  caseStage:          'dropdown_mm13gryx',
  riskBand:           'color_mm13q1rs',
  primarySupervisor:  'multiple_person_mm13mrnv',
  secondaryDirector:  'multiple_person_mm13m168',
  notifyCaseSupport:  'color_mm135wzd',
  notifyCaseManager:  'color_mm14v7kv',
  supervisorTakeover: 'color_mm14bqmp',
  priorityIncrease:   'numeric_mm14638p',
  lockStage:          'color_mm14fyg2',
  reassignToSup:      'color_mm148mre',
  createSupTask:      'color_mm149mnb',
  sendClientReminder: 'color_mm144ggm',
  sendFinalNotice:    'color_mm146t4k',
  clientMsgTemplate:  'long_text_mm14ecxn',
  slaExtensionDays:   'numeric_mm14ga2t',
  cooldownDays:       'numeric_mm14mwr5',
  ruleActive:         'color_mm14v59d',
  effectiveFrom:      'date_mm14yfsr',
  effectiveTo:        'date_mm14h0pn',
  changeEscStatus:    'color_mm1ae8w8',
  changeCaseStatus:   'color_mm1atxer',
};

// ─── Column IDs — Client Master Board ────────────────────────────────────────

const CM = {
  caseRef:            'text_mm142s49',
  clientName:         'text_mm0x1zdk',
  clientEmail:        'text_mm0xw6bp',
  accessToken:        'text_mm0x6haq',
  caseType:           'dropdown_mm0xd1qn',
  caseStage:          'color_mm0x8faa',
  slaRiskBand:        'color_mm0xszmm',
  automationLock:     'color_mm0x3x1x',
  manualOverride:     'color_mm0x975e',
  escalationRequired: 'color_mm0x7bje',
  escalationReason:   'text_mm0xvpr9',
  slaTotalDays:       'numeric_mm0x9mjz',
  priorityScore:      'numeric_mm1g7sax',
  escalationLastNotified: 'date_mm1gqbd',
  opsSupervisor:      'multiple_person_mm0xp0sq',
  caseManager:        'multiple_person_mm0xhmgk',
  caseSupportOfficer: 'multiple_person_mm0xm710',
};

const ACTIVE_STAGES = new Set([
  'Document Collection Started',
  'Internal Review',
  'Submission Preparation',
  'Stuck',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(text) {
  const n = parseFloat((text || '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor((now - d) / 86400000);
}

function isDateInRange(from, to) {
  const now = today();
  if (from && now < from) return false;
  if (to   && now > to)   return false;
  return true;
}

function extractPersonIds(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return (parsed.personsAndTeams || [])
      .filter((p) => p.kind === 'person')
      .map((p) => String(p.id));
  } catch { return []; }
}

async function fetchUserEmails(userIds) {
  if (!userIds.length) return [];
  const data = await mondayApi.query(
    `query($ids: [ID!]!) { users(ids: $ids) { id name email } }`,
    { ids: userIds }
  );
  return data?.users || [];
}

async function sendMonNotification(userId, text, targetItemId) {
  try {
    await mondayApi.query(
      `mutation($userId: ID!, $text: String!, $targetId: ID!) {
         create_notification(user_id: $userId, target_id: $targetId, text: $text, target_type: Project) { text }
       }`,
      { userId: String(userId), text, targetId: String(targetItemId) }
    );
  } catch (err) {
    console.warn(`[EscRouting] Notification failed for user ${userId}:`, err.message);
  }
}

async function notifyAll(userIds, text, itemId) {
  for (const uid of [...new Set(userIds.filter(Boolean))]) {
    await sendMonNotification(uid, text, itemId);
  }
}

function renderTemplate(template, { clientName, caseType, caseRef }) {
  return (template || '')
    .replace(/\{ClientName\}/gi,  clientName || 'Client')
    .replace(/\{CaseType\}/gi,    caseType   || '')
    .replace(/\{CaseRef\}/gi,     caseRef    || '');
}

// ─── Load routing rules ───────────────────────────────────────────────────────

async function loadRules() {
  const data = await mondayApi.query(
    `{
       boards(ids: ["${ESC_BOARD_ID}"]) {
         items_page(limit: 200) {
           items {
             id name
             column_values(ids: [
               "${RULE.caseType}", "${RULE.caseStage}", "${RULE.riskBand}",
               "${RULE.primarySupervisor}", "${RULE.secondaryDirector}",
               "${RULE.notifyCaseSupport}", "${RULE.notifyCaseManager}",
               "${RULE.supervisorTakeover}", "${RULE.priorityIncrease}",
               "${RULE.lockStage}", "${RULE.reassignToSup}", "${RULE.createSupTask}",
               "${RULE.sendClientReminder}", "${RULE.sendFinalNotice}",
               "${RULE.clientMsgTemplate}", "${RULE.slaExtensionDays}",
               "${RULE.cooldownDays}", "${RULE.ruleActive}",
               "${RULE.effectiveFrom}", "${RULE.effectiveTo}",
               "${RULE.changeEscStatus}", "${RULE.changeCaseStatus}"
             ]) { id text value }
           }
         }
       }
     }`
  );

  const rules = [];
  for (const item of data.boards[0].items_page.items) {
    const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    const val = (id) => item.column_values.find((c) => c.id === id)?.value || '';

    if (col(RULE.ruleActive) !== 'Yes') continue;
    if (!isDateInRange(col(RULE.effectiveFrom), col(RULE.effectiveTo))) continue;

    rules.push({
      id:                item.id,
      name:              item.name,
      caseType:          col(RULE.caseType),          // empty = any case type
      caseStage:         col(RULE.caseStage),
      riskBand:          col(RULE.riskBand),
      primarySupervisorIds: extractPersonIds(val(RULE.primarySupervisor)),
      secondaryDirectorIds: extractPersonIds(val(RULE.secondaryDirector)),
      notifyCaseSupport: col(RULE.notifyCaseSupport)  === 'Yes',
      notifyCaseManager: col(RULE.notifyCaseManager)  === 'Yes',
      supervisorTakeover:col(RULE.supervisorTakeover) === 'Yes',
      priorityIncrease:  toNum(col(RULE.priorityIncrease)),
      lockStage:         col(RULE.lockStage)           === 'Yes',
      reassignToSup:     col(RULE.reassignToSup)       === 'Yes',
      createSupTask:     col(RULE.createSupTask)       === 'Yes',
      sendClientReminder:col(RULE.sendClientReminder)  === 'Yes',
      sendFinalNotice:   col(RULE.sendFinalNotice)     === 'Yes',
      clientMsgTemplate: col(RULE.clientMsgTemplate),
      slaExtensionDays:  toNum(col(RULE.slaExtensionDays)),
      cooldownDays:      toNum(col(RULE.cooldownDays)) || 1,
      changeEscStatus:   col(RULE.changeEscStatus),    // Yes / No / No Change
      changeCaseStatus:  col(RULE.changeCaseStatus),   // stage name / No Change
    });
  }

  console.log(`[EscRouting] Loaded ${rules.length} active routing rules`);
  return rules;
}

// ─── Rule matching ────────────────────────────────────────────────────────────

/**
 * Returns the best matching rule for a given case.
 * Specific case-type rules (non-empty caseType) take priority over general rules.
 */
function findRule(rules, { caseType, caseStage, riskBand }) {
  const specific = rules.filter(
    (r) => r.caseType && r.caseType === caseType &&
           r.caseStage === caseStage &&
           r.riskBand  === riskBand
  );
  if (specific.length) return specific[0];

  const general = rules.filter(
    (r) => !r.caseType &&
           r.caseStage === caseStage &&
           r.riskBand  === riskBand
  );
  return general.length ? general[0] : null;
}

// ─── Fetch active cases ───────────────────────────────────────────────────────

async function fetchCases() {
  const FETCH_IDS = [
    CM.caseRef, CM.clientName, CM.clientEmail, CM.accessToken,
    CM.caseType, CM.caseStage, CM.slaRiskBand,
    CM.automationLock, CM.manualOverride,
    CM.escalationRequired, CM.escalationReason,
    CM.slaTotalDays, CM.priorityScore, CM.escalationLastNotified,
    CM.opsSupervisor, CM.caseManager, CM.caseSupportOfficer,
  ];

  let items = [], cursor = null;
  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value } }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{ boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value } }
             }
           } }`
      );
    }
    const page = data.boards[0].items_page;
    items  = items.concat(page.items);
    cursor = page.cursor || null;
  } while (cursor);
  return items;
}

// ─── Apply one rule to one case ───────────────────────────────────────────────

async function applyRule(item, rule) {
  const col    = (id) => item.column_values.find((c) => c.id === id)?.text?.trim()  || '';
  const colVal = (id) => item.column_values.find((c) => c.id === id)?.value || '';

  const caseRef    = col(CM.caseRef)    || item.name;
  const clientName = col(CM.clientName);
  const clientEmail= col(CM.clientEmail);
  const caseType   = col(CM.caseType);
  const itemId     = item.id;

  const notificationText =
    `Escalation rule "${rule.name}" triggered for case ${caseRef} (${caseType}) — ` +
    `Stage: ${col(CM.caseStage)} | Risk: ${col(CM.slaRiskBand)}`;

  // ── 1. Notify Primary Ops Supervisor ────────────────────────────────────────
  // Prefer rule-defined supervisor; fall back to case's assigned supervisor
  const supIds = rule.primarySupervisorIds.length
    ? rule.primarySupervisorIds
    : extractPersonIds(colVal(CM.opsSupervisor));
  if (supIds.length) {
    await notifyAll(supIds, notificationText, itemId);
    console.log(`[EscRouting] Notified ${supIds.length} supervisor(s) for ${caseRef}`);
  }

  // ── 2. Notify Secondary Director ────────────────────────────────────────────
  if (rule.secondaryDirectorIds.length) {
    await notifyAll(rule.secondaryDirectorIds, notificationText, itemId);
    console.log(`[EscRouting] Notified ${rule.secondaryDirectorIds.length} director(s) for ${caseRef}`);
  }

  // ── 3. Notify Case Support Officer ──────────────────────────────────────────
  if (rule.notifyCaseSupport) {
    const ids = extractPersonIds(colVal(CM.caseSupportOfficer));
    if (ids.length) await notifyAll(ids, notificationText, itemId);
  }

  // ── 4. Notify Case Manager ───────────────────────────────────────────────────
  if (rule.notifyCaseManager) {
    const ids = extractPersonIds(colVal(CM.caseManager));
    if (ids.length) await notifyAll(ids, notificationText, itemId);
  }

  // ── 5. Build column updates ──────────────────────────────────────────────────
  const updates = {};

  // Priority Score — additive
  if (rule.priorityIncrease > 0) {
    const currentScore = toNum(col(CM.priorityScore));
    updates[CM.priorityScore] = currentScore + rule.priorityIncrease;
  }

  // Lock Stage Movement
  if (rule.lockStage) {
    updates[CM.automationLock] = { label: 'Yes' };
  }

  // Reassign Case To Supervisor — copy Ops Supervisor IDs to Case Manager
  if (rule.reassignToSup) {
    const supValue = colVal(CM.opsSupervisor);
    if (supValue) {
      updates[CM.caseManager] = JSON.parse(supValue);
      console.log(`[EscRouting] Reassigning case ${caseRef} to supervisor`);
    }
  }

  // SLA Extension
  if (rule.slaExtensionDays > 0) {
    const currentSla = toNum(col(CM.slaTotalDays));
    updates[CM.slaTotalDays] = currentSla + rule.slaExtensionDays;
    console.log(`[EscRouting] SLA extended by ${rule.slaExtensionDays} days for ${caseRef}`);
  }

  // Change Escalation Status
  if (rule.changeEscStatus && rule.changeEscStatus !== 'No Change') {
    updates[CM.escalationRequired] = { label: rule.changeEscStatus };
    updates[CM.escalationReason]   =
      `Escalation rule: ${rule.name} — ${col(CM.caseStage)} / ${col(CM.slaRiskBand)}`;
  }

  // Change Case Status
  if (rule.changeCaseStatus && rule.changeCaseStatus !== 'No Change') {
    updates[CM.caseStage] = { label: rule.changeCaseStatus };
    console.log(`[EscRouting] Case ${caseRef} stage → "${rule.changeCaseStatus}"`);
  }

  // Record escalation notified date (cooldown tracking)
  updates[CM.escalationLastNotified] = { date: today() };

  // Write all column updates
  if (Object.keys(updates).length) {
    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
       }`,
      {
        boardId:   String(clientMasterBoardId),
        itemId:    String(itemId),
        colValues: JSON.stringify(updates),
      }
    );
  }

  // ── 6. Create Supervisor Task (Monday.com notification) ─────────────────────
  if (rule.createSupTask && supIds.length) {
    const taskText =
      `Action Required — Case ${caseRef} (${caseType}) needs supervisor review.\n` +
      `Stage: ${col(CM.caseStage)} | Risk Band: ${col(CM.slaRiskBand)}\n` +
      `Rule applied: ${rule.name}`;
    await notifyAll(supIds, taskText, itemId);
  }

  // ── 7. Send Client Reminder email ────────────────────────────────────────────
  if (rule.sendClientReminder && clientEmail && rule.clientMsgTemplate) {
    const body = renderTemplate(rule.clientMsgTemplate, { clientName, caseType, caseRef });
    try {
      await sendEmail({
        to:      clientEmail,
        subject: `Important update regarding your case – ${caseRef}`,
        html:    buildClientEmailHtml(body, caseRef, clientName),
        replyTo: EMAIL_REPLY_TO || undefined,
      });
      console.log(`[EscRouting] ✉ Client reminder sent to ${clientEmail} for ${caseRef}`);
    } catch (err) {
      console.warn(`[EscRouting] Client reminder email failed for ${caseRef}:`, err.message);
    }
  }

  // ── 8. Send Final Notice email ───────────────────────────────────────────────
  if (rule.sendFinalNotice && clientEmail) {
    const body = rule.clientMsgTemplate
      ? renderTemplate(rule.clientMsgTemplate, { clientName, caseType, caseRef })
      : `This is a final notice for your case ${caseRef}. Immediate action is required.`;
    try {
      await sendEmail({
        to:      clientEmail,
        subject: `Final Notice — Immediate action required — ${caseRef}`,
        html:    buildClientEmailHtml(body, caseRef, clientName, true),
        replyTo: EMAIL_REPLY_TO || undefined,
      });
      console.log(`[EscRouting] ✉ Final notice sent to ${clientEmail} for ${caseRef}`);
    } catch (err) {
      console.warn(`[EscRouting] Final notice email failed for ${caseRef}:`, err.message);
    }
  }
}

// ─── Email template ───────────────────────────────────────────────────────────

function buildClientEmailHtml(bodyText, caseRef, clientName, isFinal = false) {
  const colour    = isFinal ? '#dc2626' : '#f97316';
  const badge     = isFinal ? 'Final Notice' : 'Important Update';
  const qLink     = `${BASE_URL}/questionnaire/${encodeURIComponent(caseRef)}`;
  const docLink   = `${BASE_URL}/documents/${encodeURIComponent(caseRef)}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;max-width:560px;margin:0 auto;padding:36px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .badge{display:inline-block;background:${colour};color:#fff;font-size:.72rem;font-weight:700;
         padding:.25rem .7rem;border-radius:20px;margin-bottom:16px;letter-spacing:.5px;text-transform:uppercase}
  h2{font-size:1.2rem;color:#111;margin:0 0 16px}
  p{color:#374151;line-height:1.65;margin:0 0 14px;font-size:.94rem}
  .btn-row{margin:24px 0}
  .btn{display:inline-block;padding:11px 22px;border-radius:8px;font-size:.9rem;font-weight:600;text-decoration:none;margin-right:10px;margin-bottom:10px}
  .btn-q{background:#2563eb;color:#fff}
  .btn-d{background:#059669;color:#fff}
  hr{border:none;border-top:1px solid #e5e7eb;margin:24px 0}
  .footer{font-size:.78rem;color:#9ca3af;text-align:center}
  strong{color:#111}
</style></head><body><div class="card">
  <span class="badge">${badge}</span>
  <h2>Hi ${clientName || 'Client'},</h2>
  <p>${bodyText.replace(/\n/g, '<br>')}</p>
  <div class="btn-row">
    <a href="${qLink}"  class="btn btn-q">Complete Questionnaire</a>
    <a href="${docLink}" class="btn btn-d">Upload Documents</a>
  </div>
  <hr>
  <p style="font-size:.84rem;color:#4b5563">
    Need help? Reply to this email or contact your case officer directly.<br>
    Case Reference: <strong>${caseRef}</strong>
  </p>
  <p class="footer">TDOT Immigration &nbsp;|&nbsp; This email was sent regarding your active immigration case.</p>
</div></body></html>`;
}

// ─── Process one case ─────────────────────────────────────────────────────────

async function processCase(item, rules) {
  const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';

  const caseStage = col(CM.caseStage);
  if (!ACTIVE_STAGES.has(caseStage))        return 'skipped';
  if (col(CM.manualOverride) === 'Yes')     return 'override';
  // Automation Lock check: locked cases skip rule application (except for Stuck movement)
  if (col(CM.automationLock) === 'Yes' && caseStage !== 'Stuck') return 'locked';

  const caseType   = col(CM.caseType);
  const riskBand   = col(CM.slaRiskBand);
  const caseRef    = col(CM.caseRef) || item.name;

  // Only process cases that are Orange or Red — Green is healthy, no escalation needed
  if (riskBand === 'Green') return 'green-skip';

  const rule = findRule(rules, { caseType, caseStage, riskBand });
  if (!rule) return 'no-rule';

  // Cooldown check
  const lastNotified = col(CM.escalationLastNotified);
  if (lastNotified && daysSince(lastNotified) < rule.cooldownDays) {
    return 'cooldown';
  }

  await applyRule(item, rule);
  console.log(`[EscRouting] ✓ Applied rule "${rule.name}" to case ${caseRef}`);
  return 'applied';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function runEscalationRouting() {
  console.log('[EscRouting] Starting escalation routing engine…');
  const startTime = Date.now();

  const [rules, items] = await Promise.all([
    loadRules(),
    fetchCases(),
  ]);

  const tally = {};
  for (const item of items) {
    try {
      const result = await processCase(item, rules);
      tally[result] = (tally[result] || 0) + 1;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      tally['error'] = (tally['error'] || 0) + 1;
      const caseRef = item.column_values?.find((c) => c.id === CM.caseRef)?.text || item.id;
      console.error(`[EscRouting] ✗ Case ${caseRef}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[EscRouting] Done in ${elapsed}s | ` +
    `Applied: ${tally['applied'] || 0} | ` +
    `Cooldown: ${tally['cooldown'] || 0} | ` +
    `No rule: ${tally['no-rule'] || 0} | ` +
    `Details: ${JSON.stringify(tally)}`
  );
  return tally;
}

module.exports = { runEscalationRouting };
