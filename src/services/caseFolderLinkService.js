'use strict';

/**
 * The OneDrive folder a case's Monday row links ("OneDrive Folder Id",
 * text_mm47y540) — used ONLY when two root folders carry the same case
 * reference, to pick the one Monday points at (2026-10-01: a leftover test
 * folder beside the client's real one used to win on item count alone).
 * Filled for cases created since 2026-09-08; older cases answer [] and the
 * old tie-break applies. Cached briefly; a failed read answers the last good
 * answer (or [] when there is none: the tie-break then decides, as before) —
 * never blocks an upload.
 */
const mondayApi = require('./mondayApi');
const { clientMasterBoardId, cmColumns } = require('../../config/monday');

const CM_REF_COL = 'text_mm142s49';
const FOLDER_ID_COL = (cmColumns && cmColumns.oneDriveFolderId) || 'text_mm47y540';
const TTL_MS = 5 * 60 * 1000;
const _cache = new Map();   // ref → { at, ids }
const _lastGood = new Map();   // ref → ids — the last answer Monday actually gave, kept for the life of the process

const io = {
  async rows(ref) {
    const d = await mondayApi.query(
      `query($b:ID!,$v:String!){ items_page_by_column_values(limit:10, board_id:$b, columns:[{column_id:"${CM_REF_COL}", column_values:[$v]}]){ items{ id column_values(ids:["${FOLDER_ID_COL}"]){ text } } } }`,
      { b: String(clientMasterBoardId), v: ref }, 1);
    return ((d.items_page_by_column_values || {}).items || []).map((it) => String(((it.column_values || [])[0] || {}).text || '').trim());
  },
  now: () => Date.now(),
};

/** Folder ids the Cases board links for this reference — [] when none or when rows disagree; null when it could not be read (and was never read before). */
async function linkedFolderIds(caseRef) {
  const ref = String(caseRef || '').trim();
  if (!ref) return [];
  const hit = _cache.get(ref);
  if (hit && io.now() - hit.at < TTL_MS) return hit.ids;
  let ids = [];
  try {
    const all = [...new Set((await io.rows(ref)).filter(Boolean))];
    ids = all.length === 1 ? all : [];   // two rows linking two folders: no authority — let the tie-break decide
    if (all.length > 1) console.warn(`[CaseFolderLink] ${ref}: Cases-board rows link ${all.length} different folders — not choosing between them`);
  } catch (err) {
    // A failed read must not undo a link Monday has already given: the folder
    // choice would flip back to the tie-break (the leftover folder) for 10 min.
    if (_lastGood.has(ref)) {
      console.warn(`[CaseFolderLink] ${ref}: could not read the linked folder (${err.message}) — using the last answer`);
      return _lastGood.get(ref);
    }
    console.warn(`[CaseFolderLink] ${ref}: could not read the linked folder (${err.message}) — the usual tie-break decides, briefly`);
    return null;   // unknown (not "no link"): the caller keeps its guess only briefly; not cached here
  }
  _cache.set(ref, { at: io.now(), ids });
  _lastGood.set(ref, ids);
  return ids;
}

function _resetForTests() { _cache.clear(); _lastGood.clear(); }

module.exports = { linkedFolderIds, io, _resetForTests };
