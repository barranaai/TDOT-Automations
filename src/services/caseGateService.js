'use strict';

/**
 * Case-activation gate (meeting decision 2026-08-13):
 * a case may ACTIVATE — Payment Status → Paid, onboarding (intake email,
 * checklist, questionnaire), and the move onto the active Cases-board group —
 * only when ALL of:
 *   1. the client signed the retainer          (lead.retainerSigned)
 *   2. the RCIC countersigned it               (retainerCountersign.signedAt)
 *   3. the retainer payment landed             (lead.retainerPaid)
 *
 * Countersign forward-compatibility rule: the countersign condition applies
 * ONLY when the client signature came through Documenso (clientEnvelopeId is
 * recorded) — that flow auto-issues the RCIC countersign envelope the moment
 * the client signs, so the gate always becomes satisfiable. Manually-marked
 * signings (staff "Mark retainer signed", legacy paper flow) have no envelope
 * chain to wait on and keep the pre-2026-08-17 signed+paid behaviour — gating
 * them would freeze real cases on a document that will never arrive.
 *
 * Group placement: rows are created in the PENDING group (see
 * scripts/add-cm-pending-group.js → src/data/clientMasterBoard.json) and moved
 * to the active group by paymentService.advanceCaseToPaid once the gate holds.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

function _rc(lead) {
  try {
    const v = JSON.parse(String((lead && lead.retainerCountersign) || ''));
    return (v && typeof v === 'object') ? v : {};
  } catch (_) { return {}; }
}

/**
 * PURE — evaluate the activation gate for a lead.
 * @returns {{ complete: boolean, missing: string[], countersignRequired: boolean }}
 */
function signatureGateForLead(lead = {}) {
  const rc = _rc(lead);
  const clientSigned = !!(lead.retainerSigned && String(lead.retainerSigned).trim());
  const paid         = !!(lead.retainerPaid && String(lead.retainerPaid).trim());
  // Countersign is required only when the wait is SATISFIABLE: the client
  // signature completed through Documenso (clientSignedVia — the completion
  // webhook auto-issues the countersign envelope) or a countersign envelope
  // already exists. clientEnvelopeId alone is NOT enough — it is recorded at
  // envelope SEND time, and a client who then signs on paper (staff "Mark
  // retainer signed") has no countersign chain to wait on.
  const countersignRequired = rc.clientSignedVia === 'documenso'
    || !!String(rc.envelopeId || '').trim()
    || !!String(rc.signedAt || '').trim();
  const countersigned = !!String(rc.signedAt || '').trim();

  const missing = [];
  if (!clientSigned) missing.push('client signature');
  if (countersignRequired && !countersigned) missing.push('RCIC countersignature');
  if (!paid) missing.push('payment');
  return { complete: missing.length === 0, missing, countersignRequired };
}

/** The stored PENDING group id ('' when the one-off script has not run). */
function pendingGroupId() {
  try { return String(require('../data/clientMasterBoard.json').pendingGroupId || ''); }
  catch (_) { return ''; }
}

/** The stored ACTIVE (main) group id ('' when not recorded). */
function activeGroupId() {
  try { return String(require('../data/clientMasterBoard.json').activeGroupId || ''); }
  catch (_) { return ''; }
}

/**
 * Best-effort group move — never throws (group placement is presentation;
 * a failed move must not break payment/onboarding writes).
 */
async function moveCaseToGroup(cmItemId, groupId, label) {
  if (!cmItemId || !groupId) return false;
  try {
    await mondayApi.query(
      `mutation($i: ID!, $g: String!){ move_item_to_group(item_id: $i, group_id: $g){ id } }`,
      { i: String(cmItemId), g: String(groupId) }
    );
    console.log(`[CaseGate] CM ${cmItemId} → ${label || 'group'} (${groupId})`);
    return true;
  } catch (err) {
    console.warn(`[CaseGate] Could not move CM ${cmItemId} to ${label || groupId}: ${err.message}`);
    return false;
  }
}

async function moveCaseToActiveGroup(cmItemId) { return moveCaseToGroup(cmItemId, activeGroupId(), 'active group'); }

module.exports = { signatureGateForLead, pendingGroupId, activeGroupId, moveCaseToGroup, moveCaseToActiveGroup };
