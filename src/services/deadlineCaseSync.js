'use strict';

/**
 * The deadline on the CASE row ↔ the lead (team meeting 2026-11-05; Faran's decisions 1 and 4):
 *  - writeToCase(cmItemId, answer): the lead's answer onto the case's Deadline Type / Actual Deadline /
 *    Internal Deadline — when the case opens, and on every edit in the app.
 *  - onCaseEdited(cmItemId): a staff edit of those columns on the Monday board is copied back to the
 *    linked lead (one truth; the lead is where the app asks and shows it). Nothing is sent or posted
 *    beyond one note on the lead. Never throws.
 */

const mondayApi = require('./mondayApi');
const leadService = require('./leadService');
const deadline = require('./deadlineService');
const { clientMasterBoardId } = require('../../config/monday');

const cols = () => require('../data/clientMasterBoard.json').deadlineColumns || {};
const colIds = () => Object.values(cols()).filter(Boolean);
const isDeadlineColumn = (columnId) => colIds().includes(String(columnId));

const io = {
  readCase: async (cmItemId) => {
    const c = cols();
    const d = await mondayApi.query('query($i:[ID!],$c:[String!]){ items(ids:$i, limit:1){ id column_values(ids:$c){ id text } } }', { i: [String(cmItemId)], c: [c.type, c.actual, c.promised].filter(Boolean) });
    const it = d && d.items && d.items[0];
    if (!it) return null;
    const t = (id) => (((it.column_values || []).find((x) => x.id === id) || {}).text || '').trim();
    return { type: t(c.type), actualDeadline: deadline.cleanDay(t(c.actual)), promisedSubmissionDate: deadline.cleanDay(t(c.promised)) };
  },
  writeCase: async (cmItemId, cells) => mondayApi.query(
    'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
    { b: String(clientMasterBoardId), i: String(cmItemId), c: JSON.stringify(cells) },
  ),
  findLeads: (cmItemId) => leadService.findAllByColumnValue('clientMasterItemId', String(cmItemId)),
  getLead: (id) => leadService.getLead(String(id)),
  updateLead: (id, fields, opts) => leadService.updateLead(String(id), fields, opts),
  note: (id, body) => mondayApi.query('mutation($id:ID!,$b:String!){ create_update(item_id:$id, body:$b){ id } }', { id: String(id), b: body }),
};

/** The answer onto the case row. Returns true when written. */
async function writeToCase(cmItemId, answer, { reason = '' } = {}) {
  const cells = deadline.caseCells(answer);
  if (!cmItemId || !Object.keys(cells).length) return false;
  try {
    await io.writeCase(cmItemId, cells);
    console.log(`[Deadline] case ${cmItemId}: ${deadline.describe(answer)}${reason ? ` (${reason})` : ''}`);
    return true;
  } catch (err) {
    console.warn(`[Deadline] case ${cmItemId} could not be written (${err.message})${reason ? ` — ${reason}` : ''}`);
    return false;
  }
}

/**
 * The Monday webhook: one of the three deadline columns changed on a case row. The case's values are read
 * fresh and, when they differ from the linked lead's, copied onto the lead with a note. A case value that is
 * not usable (a type without its date, a past date typed by hand) is copied as it is — the board is the
 * team's working tool — but the note says what is incomplete.
 */
async function onCaseEdited(cmItemId, { who = '' } = {}) {
  try {
    const onCase = await io.readCase(cmItemId);
    if (!onCase) return { skipped: 'no case' };
    // Every lead linked to this case (a consultation lead AND a later direct-retainer row can share one case —
    // review 2026-11-06): each one that differs is brought in step.
    const leads = ((await io.findLeads(cmItemId)) || []).filter(Boolean);
    if (!leads.length) return { skipped: 'no lead' };
    const fields = {}, clearKeys = [];
    for (const [k, key] of [['type', 'deadlineType'], ['actualDeadline', 'actualDeadline'], ['promisedSubmissionDate', 'promisedSubmissionDate']]) {
      if (onCase[k]) fields[key] = onCase[k]; else clearKeys.push(key);
    }
    const check = deadline.validate({ deadlineType: onCase.type, actualDeadline: onCase.actualDeadline, promisedSubmissionDate: onCase.promisedSubmissionDate }, { required: false });
    const done = [];
    for (const lead of leads) {
      const onLead = deadline.fromLead(lead);
      if (deadline.same(onCase, onLead)) continue;
      await io.updateLead(lead.id, fields, { clearKeys });
      await io.note(lead.id, `Deadline changed on the case row in Monday${who ? ` by ${who}` : ''}: ${deadline.describe(onCase)} (was ${deadline.describe(onLead)}).${check.ok ? '' : ` ⚠ ${check.error}`}`).catch(() => {});
      console.log(`[Deadline] case ${cmItemId} edited on the board → lead ${lead.id}: ${deadline.describe(onCase)}`);
      done.push(String(lead.id));
    }
    if (!done.length) return { skipped: 'same' };
    return { ok: true, leadId: done[0], leadIds: done };
  } catch (err) {
    console.warn(`[Deadline] board edit on case ${cmItemId} could not be copied to the lead: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { writeToCase, onCaseEdited, isDeadlineColumn, io };
