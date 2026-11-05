'use strict';

/**
 * The consultation copy on the Client Master row (team meeting point 8, Faran 2026-11-05):
 * "the consultation record is kept forever, and Client Master gets a COPY of that person".
 *
 * Eight columns on the case row, filled from the consultation record (the lead) when the case opens, and kept
 * up to date by the app afterwards (the lead is the truth — a recording or a fee recorded later reaches the copy
 * within the hour; a hand edit on the copy is put back). Faran chose NEW CASES ONLY: cases opened before this
 * existed are never filled in — the hourly refresh touches only rows that already carry a copy.
 *
 *   Consultation Date · Consultant · Consultation Outcome · Consultation Fee · Source / Reference
 *   Consultation Record (link to the app's record) · Consultation Recording · Pre-consult Answers
 *
 * The "Consultation Record" link names the lead the copy comes from (its id is in the link's path): that is the
 * copy's anchor. A case whose anchor lead no longer points at it (the case was deleted and the record kept, or the
 * lead was moved to another case) is left exactly as it is — never cleared, never re-pointed by the refresh.
 *
 * Never on the critical path: every entry point is best-effort, never throws, and a case opens whether or not the
 * copy could be written. The column ids live in src/data/clientMasterBoard.json (consultColumns) — without them
 * this does nothing. CONSULT_COPY=off stops it.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const { canonicalOutcome } = require('../../config/outcomes');
const { isDirectClient, shownSource } = require('../utils/directClient');

const s = (v) => String(v == null ? '' : v).trim();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = ['date', 'consultant', 'outcome', 'fee', 'source', 'record', 'recording', 'preConsult'];
const LINK_TEXT = { record: 'Open consultation record', recording: 'Consultation recording', preConsult: 'Pre-consult answers (PDF)' };
const SWEEP_WRITE_CAP = 50;      // writes per hourly run (a few a day are expected — this only bounds a surprise)
const SWEEP_PACE_MS = 300;

/** The eight column ids, or null (not set up → the copy is dormant). */
function columns() {
  try {
    const c = require('../data/clientMasterBoard.json').consultColumns;
    return c && KEYS.every((k) => s(c[k])) ? c : null;
  } catch (_) { return null; }
}
/** On unless CONSULT_COPY says off (read at call time). */
function enabled() { return !['0', 'off', 'false', 'no'].includes(s(process.env.CONSULT_COPY).toLowerCase()); }

function isRealDay(d) { return require('./consultPaymentService').isRealDay(d); }
function money(cents) { return `$${(cents / 100).toFixed(2)}`; }
function webUrl(v) { const u = s(v); return /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : ''; }
function oneLine(v, max = 500) { return s(v).replace(/\s+/g, ' ').slice(0, max); }
function baseUrl() { return s(process.env.RENDER_URL || 'https://app.tdotimm.com').replace(/\/+$/, ''); }
function recordUrl(leadId) { return `${baseUrl()}/admin/consultation/${encodeURIComponent(String(leadId))}`; }
/** The lead id a Consultation Record link points at ('' when it is not one of ours). The host is ignored. */
function leadIdOfRecordUrl(url) {
  const m = /\/admin\/consultation\/(\d+)(?:[/?#]|$)/.exec(s(url));
  return m ? m[1] : '';
}

/* ── the facts, from the lead (PURE) ─────────────────────────────────────── */

/** The consultation day: Consultation Held, else the booked day of a Booked consultation; '' when none. */
function consultDate(lead) {
  const held = s(lead.consultationHeld).slice(0, 10);
  if (DAY_RE.test(held) && isRealDay(held)) return held;
  if (s(lead.bookingStatus) === 'Booked') {
    const d = s(lead.bookedSlot).slice(0, 10);
    if (DAY_RE.test(d) && isRealDay(d)) return d;
  }
  return '';
}
function outcomeText(lead) {
  if (isDirectClient(lead)) return 'Direct retainer client — no consultation';
  return canonicalOutcome(lead.outcome) || '';
}
/** The consultation fee in words — the same facts the record shows; '' when nothing is recorded. */
function feeText(lead) {
  const pay = require('./consultPaymentService');
  const ps = pay.paidState(lead);
  if (ps.paid === 'app') {
    const amt = ps.paidCents;
    return 'Paid online (booking link)' + (amt != null ? ` · ${money(amt)}${ps.feeCents != null && amt > ps.feeCents ? ' incl. HST' : ''}` : '');
  }
  const rec = ps.record;
  if (rec && rec.kind === 'waived') return `Waived${rec.on ? ` on ${rec.on}` : ''}${rec.by ? ` · by ${oneLine(rec.by, 60)}` : ''}`;
  if (rec) {
    const amount = rec.amountCents > 0 ? `${money(rec.amountCents)}${rec.hstCents > 0 ? ` + HST ${money(rec.hstCents)}` : ''}` : '(amount not recorded)';
    return `${pay.KINDS[rec.kind] || rec.kind} ${amount}${rec.on ? ` received ${rec.on}` : ''}${rec.by ? ` · recorded by ${oneLine(rec.by, 60)}` : ''}`;
  }
  if (isDirectClient(lead)) return 'n/a — direct retainer client (no consultation)';
  return '';
}
/** How the client reached us: the source (a direct client's real one), who referred them, the first channel. */
function sourceText(lead) {
  const parts = [];
  const src = isDirectClient(lead) ? (shownSource(lead) || 'Direct retainer client') : s(lead.sourceChannel);
  if (src) parts.push(src);
  if (s(lead.referredBy)) parts.push(`Referred by: ${oneLine(lead.referredBy, 120)}`);
  if (s(lead.originalChannel)) parts.push(`First came through: ${oneLine(lead.originalChannel, 60)}`);
  return oneLine(parts.join(' · '));
}

/** The eight facts for this lead (strings; '' = nothing to show). PURE. */
function factsFor(lead) {
  return {
    date: consultDate(lead),
    consultant: oneLine(lead.assignedConsultant, 120),
    outcome: outcomeText(lead),
    fee: oneLine(feeText(lead)),
    source: sourceText(lead),
    record: recordUrl(lead.id),
    recording: webUrl(lead.recordingLink),
    preConsult: webUrl(lead.preConsultPdf),
  };
}

/* ── the cells ───────────────────────────────────────────────────────────── */

/** What the row holds now, from column_values [{id, text, value}] → { key: string } (links → their url). */
function readCells(columnValues, cols) {
  const byId = new Map((columnValues || []).map((c) => [c.id, c]));
  const out = {};
  for (const k of KEYS) {
    const c = byId.get(cols[k]) || {};
    let v = '';
    if (k === 'record' || k === 'recording' || k === 'preConsult') {
      try { v = s((JSON.parse(c.value || 'null') || {}).url); } catch (_) { v = ''; }
    } else if (k === 'date') {
      try { v = s((JSON.parse(c.value || 'null') || {}).date); } catch (_) { v = ''; }
      if (!v) v = s(c.text).slice(0, 10);
    } else v = s(c.text);
    out[k] = v;
  }
  return out;
}
/** Only the cells that differ, as Monday values ('' clears). The record link counts as the same when it names the same lead. */
function diffCells(want, have, cols) {
  const out = {};
  for (const k of KEYS) {
    const w = s(want[k]), h = s(have[k]);
    if (k === 'record' ? leadIdOfRecordUrl(w) === leadIdOfRecordUrl(h) && !!h === !!w : w === h) continue;
    if (!w) { out[cols[k]] = ''; continue; }
    if (k === 'date') out[cols[k]] = { date: w };
    else if (LINK_TEXT[k]) out[cols[k]] = { url: w, text: LINK_TEXT[k] };
    else out[cols[k]] = w;
  }
  return out;
}

/* ── I/O ─────────────────────────────────────────────────────────────────── */

/** The case row's copy cells — null unless it is a live row on the Client Master board. */
async function readCaseRow(cmItemId, cols) {
  const ids = KEYS.map((k) => `"${cols[k]}"`).join(',');
  const d = await mondayApi.query(
    `query($i:[ID!]){ items(ids:$i, limit:1){ id state board{ id } column_values(ids:[${ids}]){ id text value } } }`,
    { i: [String(cmItemId)] }
  );
  const it = (d && d.items || [])[0];
  if (!it || it.state !== 'active' || !it.board || String(it.board.id) !== String(clientMasterBoardId)) return null;
  return readCells(it.column_values, cols);
}
/** One write of the changed cells; if Monday refuses the batch, one cell at a time so one bad value loses no other. */
async function writeCells(cmItemId, cells) {
  const q = `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`;
  const vars = (v) => ({ b: String(clientMasterBoardId), i: String(cmItemId), v: JSON.stringify(v) });
  try { await mondayApi.query(q, vars(cells)); return { written: Object.keys(cells).length, failed: [] }; } catch (err) {
    const failed = [];
    let written = 0;
    for (const [id, v] of Object.entries(cells)) {
      try { await mondayApi.query(q, vars({ [id]: v })); written++; } catch (e) { failed.push(`${id}: ${e.message}`); }
    }
    if (failed.length) console.warn(`[ConsultCopy] case ${cmItemId}: ${failed.length} cell(s) not written — ${failed.join(' | ')} (batch: ${err.message})`);
    return { written, failed };
  }
}

/**
 * The case just opened (handoffService._doHandoff): copy the consultation onto it. A NEW case gets the opening
 * lead's copy. A REUSED case (the same person's early case) gets it only when it has no copy yet — another
 * consultation's copy is never overwritten. Never throws.
 */
async function copyOnCaseOpen(cmItemId, lead, { reused = false } = {}) {
  try {
    const cols = columns();
    if (!cols || !enabled() || !cmItemId || !lead || !lead.id) return { skipped: 'off' };
    const want = factsFor(lead);
    let have = Object.fromEntries(KEYS.map((k) => [k, '']));
    if (reused) {
      const cur = await readCaseRow(cmItemId, cols);
      if (!cur) return { skipped: 'no-row' };
      if (cur.record && leadIdOfRecordUrl(cur.record) !== String(lead.id)) return { skipped: 'other-consultation' };
      have = cur;
    }
    const cells = diffCells(want, have, cols);
    if (!Object.keys(cells).length) return { unchanged: true };
    const r = await writeCells(cmItemId, cells);
    console.log(`[ConsultCopy] case ${cmItemId} ← consultation record ${lead.id} (${reused ? 'reused case' : 'case opened'}): ${r.written} cell(s)`);
    return r;
  } catch (err) {
    console.warn(`[ConsultCopy] case ${cmItemId}: the consultation copy was not written (${err.message}) — the hourly refresh does not fill a case that has none`);
    return { error: err.message };
  }
}

/**
 * Bring one case's copy up to date from its anchor lead, both read fresh. Left alone (never cleared): a row with
 * no copy (opened before this existed — new cases only), a row whose anchor lead is gone or points elsewhere.
 */
async function refreshCase(cmItemId) {
  const cols = columns();
  if (!cols) return { skipped: 'off' };
  const have = await readCaseRow(cmItemId, cols);
  if (!have) return { skipped: 'no-row' };
  const leadId = leadIdOfRecordUrl(have.record);
  if (!leadId) return { skipped: 'no-copy' };
  const lead = await require('./leadService').getLead(leadId);
  if (!lead) return { skipped: 'lead-gone' };
  if (s(lead.clientMasterItemId) !== String(cmItemId)) return { skipped: 'lead-moved' };
  const cells = diffCells(factsFor(lead), have, cols);
  if (!Object.keys(cells).length) return { unchanged: true };
  const r = await writeCells(cmItemId, cells);
  console.log(`[ConsultCopy] case ${cmItemId} ← consultation record ${leadId} (refresh): ${Object.keys(cells).length} cell(s) changed`);
  return r;
}

/** I/O seam (tests): every Client Master row with its copy cells, paged (never items(ids) without a limit). */
const io = {
  async listCaseRows(cols) {
    const ids = KEYS.map((k) => `"${cols[k]}"`).join(',');
    const out = [];
    let cursor = null, pages = 0;
    do {
      const d = await mondayApi.query(
        `query($b:ID!,$c:String){ boards(ids:[$b]){ items_page(limit:500, cursor:$c){ cursor items{ id state column_values(ids:[${ids}]){ id text value } } } } }`,
        { b: String(clientMasterBoardId), c: cursor || undefined }
      );
      const page = d && d.boards && d.boards[0] && d.boards[0].items_page;
      if (!page) break;
      for (const it of page.items || []) out.push({ id: String(it.id), state: it.state, cells: readCells(it.column_values, cols) });
      cursor = page.cursor || null;
      if (++pages > 40) throw new Error('the Client Master listing did not end');
    } while (cursor);
    return out;
  },
  leads: () => require('./leadSnapshot').leads(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let _running = false;
/**
 * Hourly: keep every copy up to date. Reads the case rows (copy cells only) and the shared lead snapshot; a row
 * whose copy differs from its anchor lead is re-read fresh (both sides) before anything is written. Only rows that
 * already carry a copy are ever touched. Returns counts; logs only when something was written or failed.
 */
async function sweep({ cap = SWEEP_WRITE_CAP } = {}) {
  const cols = columns();
  if (!cols || !enabled()) return { skipped: 'off' };
  if (_running) return { skipped: 'running' };
  _running = true;
  const res = { rows: 0, withCopy: 0, differing: 0, written: 0, unchanged: 0, skipped: {}, failed: 0, more: false };
  try {
    const [rows, leads] = await Promise.all([io.listCaseRows(cols), io.leads()]);
    const byId = new Map((leads || []).map((l) => [String(l.id), l]));
    res.rows = rows.length;
    for (const row of rows) {
      if (row.state && row.state !== 'active') continue;
      const leadId = leadIdOfRecordUrl(row.cells.record);
      if (!leadId) continue;                      // no copy: opened before this existed — new cases only
      res.withCopy++;
      const lead = byId.get(leadId);
      if (!lead || s(lead.clientMasterItemId) !== row.id) { res.skipped[lead ? 'lead-moved' : 'lead-not-listed'] = (res.skipped[lead ? 'lead-moved' : 'lead-not-listed'] || 0) + 1; continue; }
      if (!Object.keys(diffCells(factsFor(lead), row.cells, cols)).length) continue;
      res.differing++;
      if (res.written >= cap) { res.more = true; continue; }
      try {
        const r = await refreshCase(row.id);
        if (r && r.written) res.written++;
        else if (r && r.unchanged) res.unchanged++;
        else if (r && r.skipped) res.skipped[r.skipped] = (res.skipped[r.skipped] || 0) + 1;
        if (r && r.failed && r.failed.length) res.failed++;
      } catch (err) {
        res.failed++;
        console.warn(`[ConsultCopy] refresh of case ${row.id} failed: ${err.message}`);
      }
      await io.sleep(SWEEP_PACE_MS);
    }
    if (res.written || res.failed || res.more) console.log(`[ConsultCopy] hourly refresh: ${JSON.stringify(res)}`);
    return res;
  } finally {
    _running = false;
  }
}

module.exports = { copyOnCaseOpen, refreshCase, sweep, factsFor, diffCells, readCells, leadIdOfRecordUrl, recordUrl, columns, enabled, KEYS, io };
