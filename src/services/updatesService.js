/**
 * Updates Service — the Monday.com "Updates" thread, surfaced in the platform.
 *
 * Staff asked (2026-08-19) for the same running notes section Monday shows on
 * every item, on each of the platform's detail pages: the system's audit notes
 * (deferrals, reissues, payments) and the team's own comments in one thread,
 * without switching to Monday.
 *
 *   getUpdatesForItem(itemId)        → one item's thread (lead/consult pages)
 *   getCaseThread(caseRef)           → case row + linked lead rows, merged
 *                                      chronologically and tagged by origin
 *   postUpdate(itemId, {body, staffName}) → posts as a normal Monday update,
 *                                      prefixed "[Name]" for attribution (the
 *                                      API always posts as the integration user)
 */

'use strict';

const mondayApi = require('./mondayApi');

const UPDATE_FIELDS = `id text_body created_at creator{ name } replies{ id text_body created_at creator{ name } }`;

function shape(u, origin) {
  return {
    id:      String(u.id),
    body:    String(u.text_body || '').trim(),
    at:      String(u.created_at || ''),
    by:      (u.creator && u.creator.name) || '',
    origin,  // 'case' | 'lead'
    replies: (u.replies || []).map((r) => ({
      id: String(r.id), body: String(r.text_body || '').trim(),
      at: String(r.created_at || ''), by: (r.creator && r.creator.name) || '',
    })),
  };
}

async function getUpdatesForItem(itemId, { limit = 50, origin = 'lead' } = {}) {
  const d = await mondayApi.query(
    `query($id:[ID!], $n:Int!){ items(ids:$id, limit:1){ updates(limit:$n){ ${UPDATE_FIELDS} } } }`,
    { id: [String(itemId)], n: limit }
  );
  const item = d && d.items && d.items[0];
  return ((item && item.updates) || []).map((u) => shape(u, origin)).filter((u) => u.body);
}

/**
 * The case cockpit's merged thread: the Client Master row's updates plus every
 * linked lead row's (pre-retainer history — consultation, retainer sends).
 * Newest first. Each entry carries its origin so the UI can label it.
 */
async function getCaseThread(caseRef) {
  const htmlQ = require('./htmlQuestionnaireService');
  const { itemId, clientName } = await htmlQ.validateAccessForStaff(String(caseRef).trim(), { skipFormVersioning: true });

  const leadService = require('./leadService');
  const leads = await leadService.findAllByColumnValue('clientMasterItemId', String(itemId)).catch(() => []);

  const threads = await Promise.all([
    getUpdatesForItem(itemId, { origin: 'case' }).catch(() => []),
    ...leads.map((l) => getUpdatesForItem(l.id, { origin: 'lead' }).catch(() => [])),
  ]);
  const merged = threads.flat().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { caseRef: String(caseRef).trim(), cmItemId: String(itemId), clientName, leadIds: leads.map((l) => String(l.id)), updates: merged };
}

// The normal cap, and the "Consultation summary (Otter)" one (step 2, 2026-11-09): an Otter
// summary of a consultation runs to several thousand characters and must show in full.
const MAX_UPDATE = 4000;
const MAX_OTTER = 20000;
const OTTER_HEADER = '🎙 <b>Consultation summary (Otter)</b>';

async function postUpdate(itemId, { body, staffName, kind } = {}) {
  const text = String(body == null ? '' : body).trim();
  const name = String(staffName == null ? '' : staffName).trim().slice(0, 60);
  const otter = kind === 'otter';
  const bad = (m) => { const e = new Error(m); e.badRequest = true; throw e; };
  if (!text) bad('Write something first.');
  if (otter && text.length > MAX_OTTER) bad(`A consultation summary is limited to ${MAX_OTTER.toLocaleString('en-CA')} characters.`);
  if (!otter && text.length > MAX_UPDATE) bad(`Updates are limited to ${MAX_UPDATE} characters.`);
  if (!/^\d+$/.test(String(itemId))) bad('Invalid item id.');

  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const prefixed = (name ? `<b>[${esc(name)}]</b> ` : '') + (otter ? `${OTTER_HEADER}<br>` : '') + esc(text).replace(/\r?\n/g, '<br>');
  await mondayApi.query(
    `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(itemId), b: prefixed }
  );
  return { ok: true };
}

module.exports = { getUpdatesForItem, getCaseThread, postUpdate, MAX_UPDATE, MAX_OTTER };
