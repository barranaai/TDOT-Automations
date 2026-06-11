/**
 * Re-seed Checklist Button — makes the additive checklist re-seed a one-click
 * Monday action (previously an admin API call only staff with a terminal
 * could use).
 *
 *   Staff flip "Re-seed Checklist" → "Run" on a Client Master case
 *     → checklistService.reseedByCaseRef(caseRef) runs (ADDITIVE: existing
 *       rows are never touched; only missing rows — e.g. for a newly added
 *       family member or a just-set Sub Type — are created)
 *     → column flips to "Done ✓" (or "Failed ⚠") and a note on the case
 *       records exactly what happened.
 *
 * Loop/abuse safety: only the exact "Run" label acts (our own "Done ✓" /
 * "Failed ⚠" writes and clears are ignored); an in-flight set collapses
 * duplicate webhook deliveries; every outcome — including failures like a
 * missing Sub Type — is reported to staff on the case, never silently lost.
 */

'use strict';

const { clientMasterBoardId, cmColumns } = require('../../config/monday');

const RESEED_COL   = (cmColumns && cmColumns.reseedChecklist) || 'color_mm47h11c';
const CASE_REF_COL = 'text_mm142s49';

const LABEL_RUN    = 'Run';
const LABEL_DONE   = 'Done ✓';
const LABEL_FAILED = 'Failed ⚠';

const _inFlight = new Set();

async function setButton(itemId, label) {
  const mondayApi = require('./mondayApi');
  await mondayApi.query(
    `mutation($b: ID!, $i: ID!, $c: JSON!) {
       change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c, create_labels_if_missing: true) { id }
     }`,
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify({ [RESEED_COL]: { label } }) }
  );
}

async function postNote(itemId, body) {
  const mondayApi = require('./mondayApi');
  await mondayApi.query(
    `mutation($i: ID!, $body: String!){ create_update(item_id: $i, body: $body){ id } }`,
    { i: String(itemId), body }
  ).catch((err) => console.warn(`[Reseed] Note failed for ${itemId}: ${err.message}`));
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Entry point for the Monday webhook: Re-seed Checklist column changed. */
async function onReseedButton(itemId) {
  const key = String(itemId);
  if (_inFlight.has(key)) return; // duplicate delivery while a run is in progress
  _inFlight.add(key);
  try {
    const mondayApi = require('./mondayApi');
    const d = await mondayApi.query(
      `query($i: [ID!]) { items(ids: $i) { column_values(ids: ["${CASE_REF_COL}"]) { text } } }`,
      { i: [String(itemId)] }
    );
    const caseRef = (d?.items?.[0]?.column_values?.[0]?.text || '').trim();

    if (!caseRef) {
      await setButton(itemId, LABEL_FAILED);
      await postNote(itemId,
        '⚠ <b>Re-seed failed:</b> this case has no Case Reference Number yet. ' +
        'Set the Primary Case Type first (the reference generates automatically), then run the re-seed again.');
      return;
    }

    console.log(`[Reseed] Button run for ${caseRef} (item ${itemId})`);
    const checklistService = require('./checklistService');
    const result = await checklistService.reseedByCaseRef(caseRef);

    await setButton(itemId, LABEL_DONE);
    const members = (result.members || []).length ? result.members.join(', ') : 'Principal Applicant only';
    await postNote(itemId,
      `✅ <b>Checklist re-seed complete</b> for ${esc(caseRef)}<br>` +
      `Schema: ${esc(result.caseType)}${result.subType ? ` / ${esc(result.subType)}` : ''}<br>` +
      `Family members detected: ${esc(members)}<br>` +
      `<b>${result.created} new row(s) added</b> · ${result.skipped} already existed (untouched) · ${result.failed} failed`);
    console.log(`[Reseed] ${caseRef}: created ${result.created}, skipped ${result.skipped}, failed ${result.failed}`);
  } catch (err) {
    await setButton(itemId, LABEL_FAILED).catch(() => {});
    const hint = err.code === 'NO_SCHEMA'
      ? ' Check that the <b>Sub Type</b> column is set to one of the values in the Sub Type hint — the re-seed needs it to pick the right document schema.'
      : err.code === 'NOT_FOUND'
        ? ' The case reference on this item did not match any case — check the Case Reference Number column.'
        : '';
    await postNote(itemId, `⚠ <b>Re-seed failed:</b> ${esc(err.message)}.${hint}`);
    console.error(`[Reseed] Failed for item ${itemId}: ${err.message}`);
  } finally {
    _inFlight.delete(key);
  }
}

module.exports = { onReseedButton, RESEED_COL, LABEL_RUN };
