/**
 * Case Type Registry — SINGLE SOURCE OF TRUTH for case types and sub types.
 *
 * The Client Master board's "Primary Case Type" and "Sub Type" dropdown labels
 * ARE the approved standard. Everything else in the system (the Lead Board's
 * "Confirmed Case Type" options, handoff validation, case-ref abbreviations,
 * config/caseTypes.js) FOLLOWS them — never the other way round.
 *
 *   getCaseTypes()            → live canonical case types (cached 10 min,
 *                               falls back to config/caseTypes.js if Monday
 *                               is unreachable — system never goes blind)
 *   isCanonicalCaseType(v)    → validation used by the handoff
 *   getSubTypes()             → live canonical Sub Type labels
 *   checkDrift()              → where the copies disagree with the canon
 *   syncLeadDropdownOptions() → adds missing canon types to the Lead Board's
 *                               Confirmed Case Type dropdown
 *
 * A daily cron runs checkDrift + sync and alerts staff (LEAD_ALERT_EMAIL) when
 * something needs a human: e.g. a new CM case type with no case-ref
 * abbreviation yet (refs would fall back to "MISC" until code learns it).
 */

'use strict';

const CM_CASE_TYPE_COL = 'dropdown_mm0xd1qn';
const CM_SUB_TYPE_COL  = 'dropdown_mm0x4t91';
const LEAD_CONFIRMED_COL = 'dropdown_mm46xv2y';

const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = { caseTypes: null, subTypes: null, at: 0 };

async function fetchDropdownLabels(boardId, colId) {
  const mondayApi = require('./mondayApi');
  const d = await mondayApi.query(
    `query($b: [ID!]) { boards(ids: $b) { columns(ids: ["${colId}"]) { settings_str } } }`,
    { b: [String(boardId)] }
  );
  const s = JSON.parse(d?.boards?.[0]?.columns?.[0]?.settings_str || '{}');
  const labels = s.labels
    ? (Array.isArray(s.labels) ? s.labels.map((l) => l?.name ?? l) : Object.values(s.labels))
    : [];
  return labels.map(String).filter(Boolean);
}

async function refreshCache() {
  const { clientMasterBoardId } = require('../../config/monday');
  const [caseTypes, subTypes] = await Promise.all([
    fetchDropdownLabels(clientMasterBoardId, CM_CASE_TYPE_COL),
    fetchDropdownLabels(clientMasterBoardId, CM_SUB_TYPE_COL),
  ]);
  if (caseTypes.length) {
    _cache.caseTypes = caseTypes;
    _cache.subTypes = subTypes;
    _cache.at = Date.now();
  }
  return _cache;
}

/** Live canonical case types; cached; config fallback on Monday failure. */
async function getCaseTypes() {
  if (_cache.caseTypes && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.caseTypes;
  try {
    await refreshCache();
    return _cache.caseTypes;
  } catch (err) {
    console.warn(`[CaseTypes] Live fetch failed (${err.message}) — using ${_cache.caseTypes ? 'stale cache' : 'config fallback'}`);
    if (_cache.caseTypes) return _cache.caseTypes;
    return require('../../config/caseTypes').CASE_TYPE_LABELS;
  }
}

async function getSubTypes() {
  if (_cache.subTypes && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.subTypes;
  try {
    await refreshCache();
    return _cache.subTypes || [];
  } catch (_) {
    return _cache.subTypes || [];
  }
}

async function isCanonicalCaseType(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const types = await getCaseTypes();
  return types.includes(v);
}

/** Per-case sub-type guidance stays config-defined (CM Sub Type list is flat). */
function subTypesFor(caseType) {
  const { SUB_TYPES_BY_CASE } = require('../../config/caseTypes');
  return SUB_TYPES_BY_CASE[caseType] || [];
}

/** Compare every copy of the list against the canon. */
async function checkDrift() {
  const canon = await getCaseTypes();
  const { CASE_TYPE_LABELS } = require('../../config/caseTypes');
  const { CASE_TYPE_ABBR } = require('./caseRefService');
  const { leadBoardId } = require('../../config/monday');
  const leadOpts = await fetchDropdownLabels(leadBoardId, LEAD_CONFIRMED_COL);

  const diff = (a, b) => a.filter((x) => !b.includes(x));
  return {
    canonCount: canon.length,
    missingFromConfig:       diff(canon, CASE_TYPE_LABELS),
    removedFromCanon:        diff(CASE_TYPE_LABELS, canon),   // types code knows but CM dropped
    missingAbbreviation:     canon.filter((t) => !CASE_TYPE_ABBR[t]),
    missingFromLeadDropdown: diff(canon, leadOpts),
    extraInLeadDropdown:     diff(leadOpts, canon),
  };
}

/**
 * Add canon types missing from the Lead Board's "Confirmed Case Type" options.
 * Monday has no direct "add dropdown option" mutation — options are created by
 * writing the value with create_labels_if_missing on a throwaway item, which
 * is removed immediately after.
 */
async function syncLeadDropdownOptions(missing) {
  if (!missing || !missing.length) return 0;
  const mondayApi = require('./mondayApi');
  const { leadBoardId } = require('../../config/monday');

  const d = await mondayApi.query(
    `mutation($b: ID!) { create_item(board_id: $b, item_name: "zz-case-type-sync (auto-removed)") { id } }`,
    { b: String(leadBoardId) }
  );
  const tempId = d.create_item.id;
  let added = 0;
  try {
    for (const label of missing) {
      await mondayApi.query(
        `mutation($b: ID!, $i: ID!, $c: JSON!) {
           change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c, create_labels_if_missing: true) { id }
         }`,
        { b: String(leadBoardId), i: String(tempId), c: JSON.stringify({ [LEAD_CONFIRMED_COL]: { labels: [label] } }) }
      );
      added++;
      console.log(`[CaseTypes] Lead dropdown option added: "${label}"`);
    }
  } finally {
    await mondayApi.query(`mutation($i: ID!){ delete_item(item_id: $i){ id } }`, { i: String(tempId) })
      .catch((err) => console.warn(`[CaseTypes] Temp sync item ${tempId} cleanup failed: ${err.message}`));
  }
  return added;
}

/** Daily cron: keep followers in line with the canon, alert on what needs a human. */
async function dailyDriftCheck() {
  const drift = await checkDrift();
  const human = [];

  if (drift.missingFromLeadDropdown.length) {
    try {
      await syncLeadDropdownOptions(drift.missingFromLeadDropdown);
    } catch (err) {
      console.warn(`[CaseTypes] Lead dropdown sync failed: ${err.message}`);
      human.push(`Lead "Confirmed Case Type" is missing options (auto-sync failed): ${drift.missingFromLeadDropdown.join(', ')}`);
    }
  }
  if (drift.missingAbbreviation.length) {
    human.push(`New Client Master case type(s) with NO case-reference abbreviation — references will read "MISC" until the code learns them: ${drift.missingAbbreviation.join(', ')}`);
  }
  if (drift.missingFromConfig.length) {
    human.push(`config/caseTypes.js fallback list is stale (missing: ${drift.missingFromConfig.join(', ')})`);
  }
  if (drift.removedFromCanon.length) {
    human.push(`Case type(s) removed from the Client Master dropdown but still known to the code: ${drift.removedFromCanon.join(', ')}`);
  }

  if (human.length) {
    console.warn(`[CaseTypes] DRIFT detected:\n - ${human.join('\n - ')}`);
    const to = process.env.LEAD_ALERT_EMAIL;
    if (to) {
      const microsoftMail = require('./microsoftMailService');
      await microsoftMail.sendEmail({
        to, subject: 'TDOT automation: case-type list drift needs attention',
        html: `<p>The Client Master board's case types are the approved standard. These follower copies disagree:</p>
               <ul>${human.map((h) => `<li>${h}</li>`).join('')}</ul>`,
      }).catch((err) => console.warn(`[CaseTypes] Drift alert email failed: ${err.message}`));
    }
  } else {
    console.log('[CaseTypes] Daily drift check: all copies aligned with the Client Master canon ✓');
  }
  return drift;
}

module.exports = {
  getCaseTypes, getSubTypes, isCanonicalCaseType, subTypesFor,
  checkDrift, syncLeadDropdownOptions, dailyDriftCheck,
};
