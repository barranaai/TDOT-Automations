'use strict';

/**
 * oldClientDirectory — the people on the team's OLD "Consultations" Monday board
 * (5821353829, ~4,400 rows since January 2024), for the "Which client?" search
 * on Add lead when the Source / Reference is "Existing Client" or "Client
 * Referral" (team meeting, Faran 2026-11-04).
 *
 * READ-ONLY: the app never writes to that board. Same shape as leadSnapshot:
 * one in-memory copy, one in-flight read shared by every caller, the last good
 * copy kept (and served) when a refresh fails, warmed by the scheduler at boot
 * and every hour. Dormant when src/data/oldConsultationsBoard.json is missing.
 *
 * The board is a consultation LOG: one row per consultation, so one person can
 * have many rows, and different people can share a name. Rows become PEOPLE:
 * grouped by name, and inside one name joined when they share a phone or an
 * email. Two DIFFERENT names are never joined, even on a shared phone or email
 * (spouses share them — clientAccountService.js).
 *
 * Privacy: search() returns the name, the LAST 3 digits of the phone, the month
 * of the latest consultation, the number of consultations and whether any was
 * retained — never a full phone or email. Only the name is ever saved on a lead.
 */

const fs = require('fs');
const path = require('path');
const mondayApi = require('./mondayApi');
const { statusText } = require('../utils/mondayStatus');

const CFG_PATH  = path.join(__dirname, '..', 'data', 'oldConsultationsBoard.json');
const TTL_MS    = 60 * 60 * 1000;   // served as is below this age; older → served AND refreshed in the background
const PAGE      = 500;              // Monday's items_page maximum
const MAX_PAGES = 40;               // 20,000 rows — far beyond plausible
const WAIT_MS   = 15 * 1000;        // a search with no copy yet waits this long for the first read
const MAX_RESULTS = 10;
const MAX_Q     = 60;
const RETAINED_LABELS = ['yes', 'already retained'];

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (_) { return null; }
}

const APOSTROPHES = /['’‘`´]/g;
const MARKS = /[̀-ͯ]/g;
// Letters NFD cannot split into a base letter + an accent mark.
const SPECIAL = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i', 'þ': 'th' };

/** Lower-case, accents folded ("José" → jose, "Øyvind" → oyvind); every other non-letter/digit — apostrophes and periods too — is a word break. */
function fold(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[øłđðßæœıþ]/g, (c) => SPECIAL[c])
    .normalize('NFD').replace(MARKS, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
/** A name's letters and digits only: "Maria D'Souza" = "Maria D Souza" = "Maria Dsouza" = "mariadsouza". People are grouped by it. */
function compact(s) { return fold(s).replace(/ /g, ''); }
/**
 * The ways a name (or a typed query) splits into words — a person is found when EVERY word of ANY
 * of the query's forms starts a word of the name:
 *   as written ("D'Souza" → d, souza);
 *   apostrophes and periods dropped ("D'Souza" → dsouza, "A.K. Sharma" → ak, sharma);
 *   apostrophes dropped, periods kept as breaks ("S.D'Souza" → s, dsouza);
 *   single letters joined to the next word ("D Souza" → dsouza, "O Brien" → obrien).
 */
function wordForms(s) {
  const raw = String(s == null ? '' : s);
  const split = fold(raw).split(' ').filter(Boolean);
  const joined = fold(raw.replace(APOSTROPHES, '').replace(/\./g, '')).split(' ').filter(Boolean);
  const aposOnly = fold(raw.replace(APOSTROPHES, '')).split(' ').filter(Boolean);   // "S.D'Souza" → s, dsouza
  const merged = [];
  let buf = '';
  for (const w of split) { if (w.length === 1) { buf += w; continue; } merged.push(buf + w); buf = ''; }
  if (buf) merged.push(buf);
  return [split, joined, aposOnly, merged].filter((f) => f.length);
}
/** Every digit of a phone cell (under 7 digits: not a phone). */
function phoneRaw(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 7 ? d : '';
}
/**
 * The number a phone is grouped by: its LAST 10 digits (7–10-digit numbers whole) — "+1 416 555 0101",
 * "14165550101" and "416 555 0101" are one number; so are "+91 98765 43210" and "98765 43210".
 */
function phoneDigits(raw) {
  const d = phoneRaw(raw);
  return d.length > 10 ? d.slice(-10) : d;
}
/** Every address in an email cell (a cell may hold two: "a@x.com, b@y.ca"). */
function emailKeys(raw) {
  return [...new Set(String(raw || '').toLowerCase().split(/[\s,;/]+/).filter((t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)))];
}

/**
 * PURE. Board rows → people.
 * @param {Array<{id, name, phone, email, date, retained, clientType}>} rows
 * @returns {Array<{id, name, nameKey, groupKey, words, phones, phoneRaw, emails, phoneLast3, lastConsult, consults, retained}>}
 */
function buildPeople(rows) {
  const byName = new Map();
  for (const r of rows || []) {
    if (!r || !String(r.name || '').trim()) continue;
    // A name with no Latin letters or digits (another script) is grouped by its own text, so rows of one
    // person still join on a shared phone / email and stay searchable by phone and email.
    const key = compact(r.name) || 'raw:' + String(r.name).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  const people = [];
  for (const [groupKey, group] of byName) {
    // Join rows of ONE name that share a phone or an email (union-find). Different names are never joined.
    const parent = group.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const seen = new Map();
    const keysOf = (r) => [phoneDigits(r.phone) && 'p:' + phoneDigits(r.phone), ...emailKeys(r.email).map((e) => 'e:' + e)].filter(Boolean);
    group.forEach((r, i) => {
      for (const k of keysOf(r)) { if (seen.has(k)) parent[find(i)] = find(seen.get(k)); else seen.set(k, i); }
    });
    const clusters = new Map();
    const keyless = [];
    group.forEach((r, i) => {
      if (!keysOf(r).length) { keyless.push(r); return; }
      const c = find(i);
      if (!clusters.has(c)) clusters.set(c, []);
      clusters.get(c).push(r);
    });
    const lists = [...clusters.values()];
    // Rows with no phone and no email: part of the person when the name has only one; else one entry of their own.
    if (keyless.length) { if (lists.length === 1) lists[0].push(...keyless); else lists.push(keyless); }
    for (const list of lists) {
      list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id));
      const newest = list[0];
      const withPhone = list.find((r) => phoneDigits(r.phone));
      people.push({
        id: String(newest.id),
        name: String(newest.name || '').replace(/\s+/g, ' ').trim(),
        nameKey: fold(newest.name),
        groupKey,
        words: [...new Set(list.flatMap((r) => wordForms(r.name).flat()))],
        phones: [...new Set(list.map((r) => phoneDigits(r.phone)).filter(Boolean))],
        phoneRaw: [...new Set(list.map((r) => phoneRaw(r.phone)).filter(Boolean))],
        emails: [...new Set(list.flatMap((r) => emailKeys(r.email)))],
        phoneLast3: withPhone ? phoneDigits(withPhone.phone).slice(-3) : '',
        lastConsult: (list.map((r) => String(r.date || '')).filter(Boolean).sort().pop() || '').slice(0, 7),
        consults: list.length,
        retained: list.some((r) => RETAINED_LABELS.includes(String(r.retained || '').trim().toLowerCase())),
      });
    }
  }
  return people;
}

/** What a search result shows — never a full phone or email. */
function publicView(p, matchedOn) {
  return { id: p.id, name: p.name, phoneLast3: p.phoneLast3, lastConsult: p.lastConsult, consults: p.consults, retained: p.retained, matchedOn };
}

/** A query typed with the +1 country code: "+1 416…", "+1416…", "1-416…", "1 (416)…", "1.416…". */
const PLUS_ONE = /^\s*(\+\s*1|1[\s\-.(])/;

/**
 * PURE. Search people.
 *  - 4+ digits and no letters → phone:
 *      typed with +1 ("+1 416 5…")  → the digits after the 1 start a number;
 *      otherwise                     → the digits appear anywhere in a number as stored ("+91 98765" finds "+91 98765 43210"),
 *                                      and a full number with any country code matches on its last 10 digits;
 *  - contains "@"             → email (starts with);
 *  - otherwise                → name: every word of one of the query's forms starts a word of the name (2+ letters in all).
 * Ranked: the exact name, then names starting with the query, then the newest consultation.
 */
function searchPeople(people, rawQ) {
  const q = String(rawQ == null ? '' : rawQ).trim().slice(0, MAX_Q);
  const hasLetters = /[a-z]/.test(fold(q));
  const digits = q.replace(/\D/g, '');
  let hits = [], mode = '';
  if (q.includes('@')) {
    const e = q.toLowerCase();
    if (e.length < 3) return { results: [], more: false, mode: 'short' };
    mode = 'email';
    hits = people.filter((p) => p.emails.some((x) => x.startsWith(e)));
  } else if (!hasLetters && digits.length >= 4) {
    mode = 'phone';
    if (PLUS_ONE.test(q)) {
      const rest = digits.slice(1);
      const last10 = digits.length > 10 ? digits.slice(-10) : '';
      hits = people.filter((p) => p.phones.some((x) => x.startsWith(rest) || (last10 && x === last10)));
    } else {
      const last10 = digits.length > 10 ? digits.slice(-10) : '';
      // "1416555" (a 1 with no space after it, 7–11 digits) also finds a number stored without the 1;
      // shorter digits ("16475") are never guessed as +1.
      const after1 = (digits[0] === '1' && digits.length >= 7 && digits.length <= 11) ? digits.slice(1) : '';
      hits = people.filter((p) => p.phoneRaw.some((x) => x.includes(digits)) || (last10 && p.phones.includes(last10)) || (after1 && p.phones.some((x) => x.startsWith(after1))));
    }
  } else {
    const forms = wordForms(q);
    const cq = compact(q);
    if (cq.replace(/[0-9]/g, '').length < 2) return { results: [], more: false, mode: 'short' };
    mode = 'name';
    hits = people.filter((p) => forms.some((ws) => ws.every((w) => p.words.some((pw) => pw.startsWith(w)))));
    hits.forEach((p) => { p._rank = p.groupKey === cq ? 2 : p.groupKey.startsWith(cq) ? 1 : 0; });
  }
  hits.sort((a, b) => ((b._rank || 0) - (a._rank || 0)) || String(b.lastConsult).localeCompare(String(a.lastConsult)) || a.name.localeCompare(b.name));
  const results = hits.slice(0, MAX_RESULTS).map((p) => publicView(p, mode));
  hits.forEach((p) => { delete p._rank; });
  return { results, more: hits.length > MAX_RESULTS, mode };
}

let _copy = null;      // { people, rows, at }
let _inFlight = null;

/** Side effects behind one seam (tests replace fetchRows / now / config). */
const io = {
  config: loadConfig,
  /** Page the WHOLE board (items_page limit 500 + cursor), the 5 columns only. Read-only. */
  async fetchRows(cfg) {
    const C = cfg.columns;
    const ids = [C.phone, C.email, C.consultDate, C.retained, C.clientType].map((id) => `"${id}"`).join(', ');
    const out = [];
    let cursor = null, pages = 0;
    do {
      const data = await mondayApi.query(
        `query($boardId: ID!, $cursor: String) {
           boards(ids: [$boardId]) {
             items_page(limit: ${PAGE}, cursor: $cursor) {
               cursor
               items { id name column_values(ids: [${ids}]) { id text value } }
             }
           }
         }`,
        { boardId: String(cfg.boardId), cursor }
      );
      const page = data?.boards?.[0]?.items_page;
      if (!page) throw new Error('the old Consultations board could not be read');
      for (const it of page.items || []) {
        const cv = (id) => (it.column_values || []).find((c) => c.id === id) || null;
        out.push({
          id: String(it.id), name: it.name || '',
          phone: (cv(C.phone) || {}).text || '',
          email: (cv(C.email) || {}).text || '',
          date: (cv(C.consultDate) || {}).text || '',
          retained: statusText(cv(C.retained)),      // an empty status cell is '' (not Monday's id-5 label)
          clientType: statusText(cv(C.clientType)),
        });
      }
      cursor = page.cursor || null;
      if (++pages > MAX_PAGES) throw new Error('the old Consultations board listing did not end');
    } while (cursor);
    return out;
  },
  now: () => Date.now(),
};

function _refresh() {
  if (_inFlight) return _inFlight;
  const cfg = io.config();
  if (!cfg || !cfg.boardId || !cfg.columns) return Promise.reject(Object.assign(new Error('the client list is not set up'), { dormant: true }));
  const started = io.now();
  const p = io.fetchRows(cfg)
    .then((rows) => {
      const people = buildPeople(rows);
      _copy = { people, rows: rows.length, at: io.now() };
      console.log(`[OldClients] ${rows.length} rows → ${people.length} people in ${io.now() - started} ms`);
      return _copy;
    })
    .finally(() => { if (_inFlight === p) _inFlight = null; });
  _inFlight = p;
  return p;
}

/**
 * Search the directory.
 * @returns {Promise<{ ok: true, results, more, mode, stale?: true } | { ok: false, unavailable: true, error: string }>}
 */
async function search(q) {
  const unavailable = { ok: false, unavailable: true, error: 'The client list is not available right now — use “Not in the list — type the name”.' };
  if (!_copy) {
    let timer;
    try {
      await Promise.race([_refresh(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), WAIT_MS); })]);
    } catch (err) {
      if (!err.dormant) console.warn(`[OldClients] first read not ready: ${err.message}`);
      return unavailable;
    } finally { clearTimeout(timer); }
  } else if (io.now() - _copy.at > TTL_MS) {
    const servedAt = _copy.at;   // captured: the message must not depend on the copy still being there
    _refresh().catch((err) => console.warn(`[OldClients] background refresh failed — serving the copy from ${Math.round((io.now() - servedAt) / 60000)} min ago: ${err.message}`));
  }
  if (!_copy) return unavailable;
  const r = searchPeople(_copy.people, q);
  return { ok: true, ...r, ...(io.now() - _copy.at > 3 * TTL_MS ? { stale: true } : {}) };
}

/** Scheduler: keep it warm — never throws. */
async function warm() {
  try { await _refresh(); } catch (err) { if (!err.dormant) console.warn(`[OldClients] warm-up failed: ${err.message}`); }
}

/** For tests only. */
function _reset() { _copy = null; _inFlight = null; }

module.exports = { search, warm, buildPeople, searchPeople, fold, compact, wordForms, io, TTL_MS, MAX_RESULTS, _reset };
