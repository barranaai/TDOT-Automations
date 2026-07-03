/**
 * compositionAdapter — reads family composition from the "Family Members" board
 * and returns the { caseFlags, members } object that seedPlanner consumes.
 *
 * This is the seam between Monday and the pure planner. The intake form (later)
 * and a case officer (today) both write to the SAME Family Members board; this
 * adapter is the only thing that reads it. Neither the form nor the planner need
 * to know the other exists.
 *
 * Split, like the planner, into:
 *   - mapRowsToComposition(rows)  — PURE. Board rows → composition. Unit-tested.
 *   - readForCase(caseRef)        — thin I/O: fetch this case's member rows, map.
 */

'use strict';

const mondayApi = require('./mondayApi');
const boardCfg  = require('../data/familyMembersBoard.json');

// Family Members "Member Type" label → schema role name.
const MEMBER_TYPE_TO_ROLE = {
  'Principal Applicant': 'PrincipalApplicant',
  'Spouse':              'Spouse',
  'Dependent Child':     'DependentChild',
  'Sponsor':             'Sponsor',
  'Worker Spouse':       'WorkerSpouse',
  'Parent':              'Parent',
  'Sibling':             'Sibling',
};

// Family Members "Flags" dropdown label → schema memberFlag key.
const FLAG_LABEL_TO_KEY = {
  'Name Changed':           'nameChanged',
  'Married More Than Once': 'marriedMultipleTimes',
  'Common-Law':             'commonLaw',
  'Previously Sponsored':   'previouslySponsored',
  'Former Spouse Deceased': 'formerSpouseDeceased',
};

/**
 * PURE. Map raw board rows to a composition object.
 *
 * @param {Array<{ memberType, flagsText, name, memberKey }>} rows
 *   memberType — the Member Type label text (e.g. "Spouse")
 *   flagsText  — the Flags column text, comma-separated labels (e.g. "Name Changed, Common-Law")
 * @returns {{ caseFlags: object, members: Array<{ role, name, memberKey, flags }> }}
 */
function mapRowsToComposition(rows) {
  const members = [];

  for (const row of rows || []) {
    const rawType = (row.memberType || '').trim();
    const role = MEMBER_TYPE_TO_ROLE[rawType];
    if (!role) {
      // Skip but make it visible — a blank/mistyped Member Type silently dropped
      // a family member (no checklist + no questionnaire) with no signal before.
      console.warn(`[Composition] Family row "${(row.name || '').trim() || '(unnamed)'}" has an unmapped Member Type "${rawType || '(blank)'}" — skipped (no role to seed).`);
      continue;
    }

    const flags = {};
    for (const label of String(row.flagsText || '').split(',')) {
      const trimmed = label.trim();
      if (!trimmed) continue;
      const key = FLAG_LABEL_TO_KEY[trimmed];
      if (key) flags[key] = true;
      else console.warn(`[Composition] Family row "${(row.name || '').trim() || '(unnamed)'}" has an unrecognised flag "${trimmed}" — ignored.`);
    }

    members.push({
      role,
      name:               (row.name || '').trim(),
      memberKey:          (row.memberKey || '').trim(),
      dateOfBirth:        (row.dateOfBirth || '').trim(),
      currentStatus:      (row.currentStatus || '').trim(),
      countryOfResidence: (row.countryOfResidence || '').trim(),
      flags,
    });
  }

  // Case-level flags are DERIVED from member presence — no separate board field.
  const has = (r) => members.some((m) => m.role === r);
  const caseFlags = {
    spouseIncluded:    has('Spouse'),
    childrenIncluded:  has('DependentChild'),
    parentsIncluded:   has('Parent'),
    siblingsIncluded:  has('Sibling'),
    // Was referenced by 5 Study Permit schemas but never derived (dead flag) →
    // the "Supporting Family Member (funds)" doc set could never seed. Derive it
    // like its siblings: a Sponsor member (now addable in the consultant family
    // editor) turns the supporter document set on.
    supporterIncluded: has('Sponsor'),
  };

  return { caseFlags, members };
}

/**
 * I/O. Fetch the member rows for a case from the Family Members board and map
 * them to a composition object.
 *
 * @param {string} caseRef e.g. "2026-SV-002"
 * @returns {Promise<{ caseFlags, members }>}
 */
async function readForCase(caseRef) {
  const C = boardCfg.columns;
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 100, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items {
           name
           column_values(ids: ["${C.memberType}", "${C.flags}", "${C.memberKey}", "${C.dateOfBirth}", "${C.currentStatus}", "${C.countryOfResidence}"]) { id text }
         }
       }
     }`,
    { boardId: String(boardCfg.boardId), colId: C.caseReference, val: caseRef }
  );

  const items = data?.items_page_by_column_values?.items || [];
  const rows = items.map((it) => {
    const cv = {};
    for (const c of it.column_values) cv[c.id] = c.text || '';
    return {
      name:               it.name,
      memberType:         cv[C.memberType],
      flagsText:          cv[C.flags],
      memberKey:          cv[C.memberKey],
      dateOfBirth:        cv[C.dateOfBirth],
      currentStatus:      cv[C.currentStatus],
      countryOfResidence: cv[C.countryOfResidence],
    };
  });

  return mapRowsToComposition(rows);
}

module.exports = {
  readForCase,
  mapRowsToComposition,
  _maps: { MEMBER_TYPE_TO_ROLE, FLAG_LABEL_TO_KEY },
};
