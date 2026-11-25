'use strict';

/**
 * Feature flags — env-driven, default OFF. Two separate flags for the client
 * accounts rollout so registry stamping can stay on even if the multi-case
 * behavior change has to be rolled back:
 *
 *   clientAccountsEnabled  — handoff + direct-client creation find-or-create a
 *                            Clients-board row and stamp clientAccountId on the
 *                            lead + Client Master case. Pure bookkeeping; no
 *                            user-visible behavior changes.
 *   clientMultiCaseEnabled — the repeat-client fix: a returning client's new
 *                            application creates a NEW Client Master case
 *                            (decideCaseReuse) instead of silently reusing and
 *                            overwriting the old one. Off = byte-for-byte
 *                            legacy handoff behavior.
 *
 * And one three-way switch for the readable Client ID ("CL-2026-00042"):
 *
 *   CLIENT_IDS = off | report | on   (anything else, or unset, is off)
 *     off    — nothing new happens: no number is made, nothing is written.
 *              A page may still SHOW an ID a person already has.
 *     report — the healer / audit work out and log what they WOULD do;
 *              nothing is written.
 *     on     — new people get a number (and the healer writes).
 *   Read on every call (not at load), so a Render env change and the tests
 *   both take effect without a reload.
 *
 * And the switch for changing the Case Stage from the Client Master page
 * (caseStageService, 2026-11-26):
 *
 *   STAGE_EDIT = off | on   (anything else, or unset, is off)
 *     off — staff see nothing new: no Change… button by the stage, and the
 *           two stage endpoints answer 404 "not switched on".
 *     on  — the button shows for the people who may Assign on that row.
 *   Read on every call, like CLIENT_IDS.
 */

const on = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

/** 'off' | 'report' | 'on' — the CLIENT_IDS switch; anything else is off. */
function clientIdsMode() {
  const v = String(process.env.CLIENT_IDS == null ? '' : process.env.CLIENT_IDS).trim().toLowerCase();
  return v === 'on' ? 'on' : v === 'report' ? 'report' : 'off';
}

/** 'off' | 'on' — the STAGE_EDIT switch; anything else is off. */
function stageEditMode() {
  const v = String(process.env.STAGE_EDIT == null ? '' : process.env.STAGE_EDIT).trim().toLowerCase();
  return v === 'on' ? 'on' : 'off';
}

module.exports = {
  // Default ON (user decision 2026-08-04: accounts accrete from future
  // applications; no backfill). Set CLIENT_ACCOUNTS_ENABLED=false to kill.
  clientAccountsEnabled:  process.env.CLIENT_ACCOUNTS_ENABLED === undefined
    ? true
    : on(process.env.CLIENT_ACCOUNTS_ENABLED),
  // Default ON (user approved the flip 2026-08-04 after the flag-off deploy):
  // a returning client's new application creates a NEW case instead of
  // overwriting their old one. CLIENT_MULTI_CASE_ENABLED=false to kill.
  clientMultiCaseEnabled: process.env.CLIENT_MULTI_CASE_ENABLED === undefined
    ? true
    : on(process.env.CLIENT_MULTI_CASE_ENABLED),
  // Client IDs (2026-11-25). Default OFF.
  clientIdsMode,
  /** 'on': new people get a number and the healer writes. */
  clientIdsOn:     () => clientIdsMode() === 'on',
  /** 'report' or 'on': the healer / audit work out what to do ('report' only logs it). */
  clientIdsActive: () => clientIdsMode() !== 'off',
  // Change the Case Stage from the Client Master page (2026-11-26). Default OFF.
  stageEditMode,
  stageEditOn: () => stageEditMode() === 'on',
};
