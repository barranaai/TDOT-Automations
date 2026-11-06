'use strict';

/**
 * The Cases board groups that are NOT live cases — one list, shared by the
 * Needs-attention reader and the document reminders (block 2, 2026-11-06), so
 * the automatic email can never chase a row the Summary page would ignore (two
 * DCS + Paid rows sat in the Cancel group on 2026-11-06). By id, with the title
 * as a fallback should a group be re-made.
 */
const TEST_GROUP_ID = 'group_mm3842s';
const NOT_CASE_GROUPS = Object.freeze([
  { id: TEST_GROUP_ID,      title: /^test$/i },                          // TEST
  { id: 'group_mm2tz8e1',   title: /^leads$/i },                         // Leads (enquiries kept here by staff)
  { id: 'group_mm3b9tap',   title: /cancel|did not retain/i },           // Cancel / Did not retained
]);

const str = (v) => String(v == null ? '' : v).trim();

/** True when a row's group ({ id, title }) is a live-case group (no group read at all counts as live). */
function isCaseGroup(group) {
  const g = group || {};
  return !NOT_CASE_GROUPS.some((x) => str(g.id) === x.id || x.title.test(str(g.title)));
}

/** True for the TEST group only (the office's own test records — never Leads or Cancel). */
function isTestGroup(group) {
  const g = group || {};
  return str(g.id) === TEST_GROUP_ID || NOT_CASE_GROUPS[0].title.test(str(g.title));
}

module.exports = { TEST_GROUP_ID, NOT_CASE_GROUPS, isCaseGroup, isTestGroup };
