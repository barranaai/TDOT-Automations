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
 */

const on = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

module.exports = {
  // Default ON (user decision 2026-08-04: accounts accrete from future
  // applications; no backfill). Set CLIENT_ACCOUNTS_ENABLED=false to kill.
  clientAccountsEnabled:  process.env.CLIENT_ACCOUNTS_ENABLED === undefined
    ? true
    : on(process.env.CLIENT_ACCOUNTS_ENABLED),
  clientMultiCaseEnabled: on(process.env.CLIENT_MULTI_CASE_ENABLED),
};
