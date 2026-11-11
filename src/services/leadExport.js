'use strict';

/**
 * leadExport — the Leads page's "Export" button (Faran 2026-11-11).
 *
 * The page sends the ids of the leads it is SHOWING (the open tab with the search and
 * filters applied, in the order shown) and gets back an Excel file with seven columns:
 * Lead Name, Email, Contact Number, Service, Source/Reference, Referred By, Current Status.
 *
 * The email and phone still never go to the Leads list itself (leadSnapshot keeps them
 * server-side): they leave the server only inside this file, on a deliberate press.
 * Faran's choices: any staff member may export; what is on screen; .xlsx.
 *
 * Only rows of the Leads list can be exported — an id that is not on that list
 * (a consultation, a case, a made-up number) is skipped, never looked up.
 */

const MAX_ROWS = 5000;
const CELL_MAX = 32767;   // Excel's limit for one cell — a longer value would fail the whole file
const HEADERS = ['Lead Name', 'Email', 'Contact Number', 'Service', 'Source/Reference', 'Referred By', 'Current Status'];
const WIDTHS  = [28, 34, 20, 30, 24, 26, 34];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const io = {
  queue:    () => require('./consultantPortalService').getLeadsQueue(),
  snapshot: () => require('./leadSnapshot').leads(),
};

function s(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

function shortDay(ms) {
  try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' }); } catch (_) { return ''; }
}

/** The Current status cell as the page shows it: the label, then when (or the booked slot). */
function statusText(st) {
  if (!st || !st.label) return '';
  let when = s(st.slot) || (st.at ? shortDay(st.at) : '');
  if (st.key === 'remark' && s(st.by)) when = when ? `${when} · ${s(st.by)}` : s(st.by);   // a remark: who wrote it, as on the page
  return when ? `${s(st.label)} · ${when}` : s(st.label);
}

/** The asked ids, as strings, once each, in the order asked, at most MAX_ROWS. */
function cleanIds(ids) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(ids) ? ids : []) {
    const id = s(x);
    if (!/^\d{1,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/** @returns {Promise<string[][]>} one array per lead, in the order asked (HEADERS order). */
async function buildRows(ids) {
  const want = cleanIds(ids);
  if (!want.length) return [];
  const { CONTACT } = require('./leadSnapshot');
  const [queue, leads] = await Promise.all([io.queue(), io.snapshot()]);
  const row = new Map(queue.map((r) => [String(r.id), r]));
  const contact = new Map(leads.map((l) => [String(l.id), l[CONTACT] || {}]));
  const out = [];
  for (const id of want) {
    const r = row.get(id);
    if (!r) continue;                      // not on the Leads list — never exported
    const c = contact.get(id) || {};
    out.push([s(r.name), s(c.email), s(c.phone), s(r.service), s(r.source), s(r.referredBy), statusText(r.status)]);
  }
  return out;
}

/** The workbook as a Buffer. Every cell is written as TEXT, so a phone keeps its "+" and a value starting "=" is never a formula. */
function toXlsx(rows) {
  const XLSX = require('xlsx');
  const ws = {};
  const all = [HEADERS].concat(rows);
  all.forEach((r, ri) => r.forEach((v, ci) => { ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 's', v: String(v == null ? '' : v).slice(0, CELL_MAX) }; }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: all.length - 1, c: HEADERS.length - 1 } });
  ws['!cols'] = WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** "Leads - Invite sent - 2026-11-11.xlsx" — the tab's name made safe for a file name. */
function fileName(tab, now = Date.now()) {
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  const t = s(tab).replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `Leads - ${t ? t + ' - ' : ''}${day}.xlsx`;
}

/**
 * POST /api/leads/export (under /api — the team key). Body { ids: [...], tab: 'Invite sent' }.
 * Never cached; per-IP limit; the log line says how many rows and who — never a name, phone or email.
 * `actorOf(req)` names the signed-in staff member when there is one.
 */
function httpHandler({ limit, actorOf } = {}) {
  const { rateLimiter, clientIp } = require('./leadSearch');
  const allow = limit || rateLimiter({ max: 20, windowMs: 60 * 1000 });
  return async function leadExportRoute(req, res) {
    res.set('Cache-Control', 'private, no-store');
    if (!allow(clientIp(req))) return res.status(429).json({ ok: false, error: 'Too many exports — wait a minute and try again.' });
    try {
      const body = req.body || {};
      if (!Array.isArray(body.ids)) return res.status(400).json({ ok: false, error: 'Nothing to export.' });
      // The size check lives here: the app-wide JSON reader (2 MB) has already read the body, so a per-route limit would never run.
      if (body.ids.length > MAX_ROWS) return res.status(413).json({ ok: false, error: `Too many leads for one file — ${MAX_ROWS} at most. Narrow the list with a tab or a filter.` });
      const rows = await buildRows(body.ids);
      if (!rows.length) return res.status(400).json({ ok: false, error: 'No leads to export — the list is empty.' });
      let who = '';
      try { who = s(actorOf && actorOf(req)); } catch (_) { who = ''; }
      console.log(`[Leads] export: ${rows.length} rows by ${who || 'shared key'}`);
      const buf = toXlsx(rows);
      res.set('Content-Type', XLSX_MIME);
      res.set('Content-Disposition', `attachment; filename="${fileName(body.tab)}"`);
      res.set('X-Export-Rows', String(rows.length));
      res.send(buf);
    } catch (err) {
      console.error('[Leads] export failed:', err.message);
      res.status(503).json({ ok: false, error: 'The export could not be made right now — try again in a moment.' });
    }
  };
}

module.exports = { buildRows, toXlsx, fileName, statusText, cleanIds, httpHandler, io, HEADERS, MAX_ROWS };
