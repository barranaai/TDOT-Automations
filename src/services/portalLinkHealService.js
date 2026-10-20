'use strict';

/**
 * Client Portal link self-heal (2026-10-20, case 2026-CEC-PS-080).
 *
 * The staff "Client Portal" link column on the Client Master board is written
 * once — when the app gives a case its number (caseRefService
 * .writePortalLinkForItem). It goes missing when a row is moved to another
 * board and back (Monday wipes every column the other board lacks) or is
 * cleared by hand, and nothing ever wrote it again. This sweep puts it back.
 *
 * Only rows with a current-format case number AND an access code AND no link.
 * It never creates an access code: a new one would silently stop every link the
 * client was already emailed (that is a decision for staff, with a re-send).
 * Each row is re-read right before its write — still active, still on this
 * board, still the same case, still a code and no link — or it is left alone.
 * The hourly run heals only a row that was ALSO missing its link on the run
 * before, so a brand-new case whose own link write is a moment behind never
 * gets a false "link was lost" note; staff's "heal now" acts at once.
 * Off with PORTAL_LINK_HEAL=0.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId, cmColumns } = require('../../config/monday');

const CASE_REF_COL    = 'text_mm142s49';
const TOKEN_COL       = 'text_mm0x6haq';
const PORTAL_LINK_COL = (cmColumns && cmColumns.portalLink) || 'link_mm2vta5';
const CURRENT_REF     = /^\d{4}-[A-Z]+(?:-[A-Z]+)*-\d{3}$/;   // 2026-CEC-PS-080 — never the old "2165"-style numbers
const PER_RUN         = 25;

function isEnabled() {
  return !/^(0|off|false|no)$/i.test(String(process.env.PORTAL_LINK_HEAL || '').trim());
}

/** The URL in a link column's raw value ('' when empty or unreadable). */
function linkUrl(value) {
  try { const v = JSON.parse(value || 'null'); return (v && typeof v.url === 'string' && v.url.trim()) || ''; } catch (_) { return ''; }
}

/** PURE. A Client Master item ({ id, column_values }) → { id, caseRef, token, link }. */
function readRow(item) {
  const col = (id) => (item.column_values || []).find((c) => c.id === id) || {};
  return {
    id: String(item.id),
    caseRef: String(col(CASE_REF_COL).text || '').trim(),
    token: String(col(TOKEN_COL).text || '').trim(),
    link: linkUrl(col(PORTAL_LINK_COL).value) || String(col(PORTAL_LINK_COL).text || '').trim(),
  };
}

/** PURE. The rows the sweep heals: a current-format case number, an access code, no link. */
function rowsToHeal(rows) {
  return (rows || []).filter((r) => CURRENT_REF.test(r.caseRef) && r.token && !r.link);
}

const COLS = JSON.stringify([CASE_REF_COL, TOKEN_COL, PORTAL_LINK_COL]);

// ─── I/O seam (tests stub this) ──────────────────────────────────────────────
const io = {
  /** Every Client Master row (paged). */
  allRows: async () => {
    const sel = `items{ id column_values(ids:${COLS}){ id text value } }`;
    let r = await mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ cursor ${sel} } } }`, { b: [String(clientMasterBoardId)] });
    const page = r && r.boards && r.boards[0] && r.boards[0].items_page;
    if (!page) throw new Error('the case board could not be read');
    const items = [...page.items];
    let cursor = page.cursor;
    while (cursor) {
      r = await mondayApi.query(`query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor ${sel} } }`, { c: cursor });
      items.push(...r.next_items_page.items);
      cursor = r.next_items_page.cursor;
    }
    return items.map(readRow);
  },
  /** One row as it is now — null when gone, archived/deleted, or no longer on this board (items(ids:) is account-wide). */
  oneRow: async (id) => {
    const d = await mondayApi.query(`query($i:[ID!]){ items(ids:$i, limit:1){ id state board{ id } column_values(ids:${COLS}){ id text value } } }`, { i: [String(id)] });
    const it = d && d.items && d.items[0];
    if (!it) return null;
    if (it.state && it.state !== 'active') return null;
    if (!it.board || String(it.board.id) !== String(clientMasterBoardId)) return null;
    return readRow(it);
  },
  writeLink: async (id, url) => {
    const d = await mondayApi.query(
      'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
      { b: String(clientMasterBoardId), i: String(id), c: JSON.stringify({ [PORTAL_LINK_COL]: { url, text: 'Open Client Portal' } }) }
    );
    if (!(d && d.change_multiple_column_values && d.change_multiple_column_values.id)) throw new Error('Monday did not confirm the write');
  },
  postNote: async (id, body) => {
    await mondayApi.query('mutation($i:ID!,$b:String!){ create_update(item_id:$i, body:$b){ id } }', { i: String(id), b: body });
  },
  /** The same URL the app writes when it gives a case its number (staff flag: Monday sign-in for staff). */
  portalUrl: ({ caseRef, accessToken }) => require('./clientPortalService').buildPortalUrl({ caseRef, accessToken, staff: true }),
};

const NOTE = '🔗 <b>Client Portal link put back</b> — the link column was empty (moving a row to another board and back, or clearing the cell, loses it). '
  + 'Nothing else was changed; the links the client was emailed are not affected.';

let _running = false;
let _dueLastRun = new Set();   // item ids missing their link on the previous hourly run

/**
 * @param {{ dryRun?: boolean, limit?: number, now?: boolean }} [opts]  now: staff asked — heal at once (no wait for a second run)
 * @returns {Promise<{ checked, due, healed: string[], skipped: Array<{caseRef, why}>, failed: Array<{caseRef, error}>, more, dryRun?, off? }>}
 */
async function healMissingPortalLinks({ dryRun = false, limit = PER_RUN, now = false } = {}) {
  if (!dryRun && !isEnabled()) return { off: true, checked: 0, due: 0, healed: [], skipped: [], failed: [], more: 0 };
  if (_running) return { busy: true, checked: 0, due: 0, healed: [], skipped: [], failed: [], more: 0 };
  _running = true;
  try {
    const rows = await io.allRows();
    const missing = rowsToHeal(rows);
    // the hourly run: only rows ALSO missing their link last time (never a case still being created)
    const due = (now || dryRun) ? missing : missing.filter((r) => _dueLastRun.has(r.id));
    if (!dryRun && !now) _dueLastRun = new Set(missing.map((r) => r.id));
    const batch = due.slice(0, Math.max(0, limit));
    const out = { checked: rows.length, due: due.length, healed: [], skipped: [], failed: [], more: due.length - batch.length, waiting: missing.length - due.length };
    if (dryRun) return { ...out, dryRun: true, wouldHeal: batch.map((r) => r.caseRef) };
    for (const r of batch) {
      try {
        const cur = await io.oneRow(r.id);                     // as it is NOW — never write on a stale read
        if (!cur) { out.skipped.push({ caseRef: r.caseRef, why: 'row gone' }); continue; }
        if (cur.caseRef !== r.caseRef) { out.skipped.push({ caseRef: r.caseRef, why: 'case number changed' }); continue; }
        if (!cur.token) { out.skipped.push({ caseRef: r.caseRef, why: 'no access code' }); continue; }
        if (cur.link) { out.skipped.push({ caseRef: r.caseRef, why: 'already has a link' }); continue; }
        await io.writeLink(r.id, io.portalUrl({ caseRef: cur.caseRef, accessToken: cur.token }));
        out.healed.push(r.caseRef);
        await io.postNote(r.id, NOTE).catch((err) => console.warn(`[PortalLink] note on ${r.caseRef} failed: ${err.message}`));
      } catch (err) {
        out.failed.push({ caseRef: r.caseRef, error: err.message });
        console.warn(`[PortalLink] ${r.caseRef}: could not put the link back: ${err.message}`);
      }
    }
    if (out.healed.length || out.failed.length) {
      console.log(`[PortalLink] put back ${out.healed.length} Client Portal link(s)${out.healed.length ? ': ' + out.healed.join(', ') : ''}${out.failed.length ? `; ${out.failed.length} failed` : ''}${out.more ? `; ${out.more} more next run` : ''}`);
    }
    return out;
  } finally {
    _running = false;
  }
}

module.exports = { healMissingPortalLinks, rowsToHeal, readRow, linkUrl, isEnabled, io, CURRENT_REF, PER_RUN, NOTE,
  _resetForTests: () => { _dueLastRun = new Set(); _running = false; } };
