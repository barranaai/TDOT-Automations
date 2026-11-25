'use strict';

/**
 * Which consultation does an Otter recording belong to? (Faran 2026-11-14.) PURE — no network,
 * nothing logged. Staff type a title before they stop the recording: the client's CLIENT ID
 * (Faran 2026-11-26: "CL-2026-00042", "CL 42" — utils/clientId.parseClientId), or — for a client
 * with no Client ID yet — the consultation's code (recordingCode.js), or the client's email, or the
 * client's name. NOTHING is ever filed on a guess:
 *
 *   0. a CLIENT ID in the title → that person's consultations (the Lead Board "Client ID" copy of
 *                             each consultation, c.clientId; a typed year must be the year of the
 *                             person's ID); filed only when exactly ONE of them is booked on the
 *                             recording's own Toronto day — the same rule as a code. A Client ID on
 *                             no consultation is never filed (a mistyped number is another person);
 *   a. a CODE in the title  → the consultations with that code; filed only when exactly ONE of them
 *                             is booked on the recording's own Toronto day;
 *   b. an EMAIL in the title → the consultations with EXACTLY that email (same-day rule). An email
 *                             that is nobody's is never filed (review 2, 2026-11-14 — "li@" two
 *                             slips from "lu@" is another person, not a typo): the clients whose
 *                             email is at most two typing slips away are suggested first, and a
 *                             person chooses;
 *   c. a NAME in the title  → the consultations with that name whose booked time is inside the
 *                             window (the recording began from 45 minutes before the booked time
 *                             to 120 minutes after it); filed only when exactly one;
 *   d. no usable title      → never filed; the consultations inside the window are suggested;
 *   e. never filed by itself: a recording first seen more than 30 days after it was made, and a
 *      very short one (summary + transcript under 200 characters). A recording already on a
 *      consultation is never matched again.
 * The FIRST kind of token in the title decides (Client ID, then code, then email, then name); the
 * later ones only add suggestions — a code that does not fit is never overruled by a name that does.
 *   f. the title must not point at two clients (review 2026-11-14): when the deciding token finds
 *      one consultation and ANOTHER token in the same title (a TD code, a second email, the name) is
 *      exactly some other consultation's and not this one's, nothing is filed — both are suggested.
 *      Two different codes, or two different Client IDs (another number, or the same number with
 *      two different years), in one title are never filed either. A token that matches nobody does
 *      not block (a nickname, "follow up", a mistyped second word).
 */

const { recordingCode } = require('../utils/recordingCode');
const { parseClientId, isClientId } = require('../utils/clientId');
const R = require('./otterRecordingFile');

const EARLY_MIN = 45, LATE_MIN = 120, MAX_AGE_DAYS = 30, SHORT_CHARS = 200, MAX_CANDIDATES = 5;
const s = (v) => String(v == null ? '' : v).trim();

const CODE_RE = /(?:^|[^a-z0-9])td[\s\-‐-―_#:.]{0,5}(\d{5})(?!\d)/i;
// A Client ID typed in a title: "CL", then an optional 4-digit year, then the number (the separators
// parseClientId allows). Every piece found is then read by parseClientId itself — the ONE rule for
// what a typed Client ID is; a piece it refuses (number 0, 8+ digits) is not a Client ID.
const CID_SEP = '[\\s\\-\\u2010-\\u2015_.#:]';
const CID_RE = new RegExp(`(?:^|[^a-z0-9])(cl${CID_SEP}*\\d{4}${CID_SEP}+\\d{1,7}|cl${CID_SEP}*\\d{1,7})(?![0-9])`, 'gi');
const CASE_HEAD_RE = /(?:^|[^0-9])\d{4}[-\u2010-\u2015]$/;   // "2026-" right before "CL": a case number's head
const EMAIL_RE = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/i;
const HONORIFICS = ['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'sir', 'madam', 'mister', 'prof'];
const NOISE = ['consultation', 'consult', 'consulting', 'meeting', 'call', 'with', 'client', 'recording', 'otter', 'notes', 'note', 're'];

/** A name as it is compared: no case, accents, punctuation, extra spaces, "consultation with", honorifics. */
function normName(v) {
  const words = s(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’'`]/g, '')            // O'Brien = OBrien
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.filter((w) => !HONORIFICS.includes(w) && !NOISE.includes(w)).join(' ');
}

/**
 * The Client IDs typed in a text → { ids: [{ n, year }], rest } — each number once, in the order typed;
 * the same number typed with and without its year is one token (the year kept). The same number with
 * two DIFFERENT years is two tokens (they disagree).
 */
function takeClientIds(text) {
  const ids = [];
  let rest = '', last = 0;
  CID_RE.lastIndex = 0;
  for (let m, i = 0; i < 20 && (m = CID_RE.exec(text)); i++) {
    const start = m.index + m[0].length - m[1].length;
    // "2026-CL-00042" (a year joined to "CL" by a dash) is the shape of a CASE number, never a Client ID
    if (CASE_HEAD_RE.test(text.slice(Math.max(0, start - 6), start))) continue;
    const p = parseClientId(m[1]);
    if (!p) continue;
    rest += text.slice(last, start) + ' ';
    last = start + m[1].length;
    const same = ids.find((x) => x.n === p.n && (!x.year || !p.year || x.year === p.year));
    if (same) { if (!same.year && p.year) same.year = p.year; } else ids.push({ n: p.n, year: p.year });
  }
  CID_RE.lastIndex = 0;
  return { ids, rest: rest + text.slice(last) };
}

/** Is this consultation's stored Client ID the typed one ({ n, year })? The number is the person; a typed year must match too. */
function idIs(c, tok) {
  const v = s(c && c.clientId);
  if (!tok || !isClientId(v)) return false;
  const p = parseClientId(v);
  return !!p && p.n === tok.n && (!tok.year || p.year === tok.year);
}

/** EVERY token of a typed title: { clientIds: [{ n, year }], codes: [], emails: [], name } — each once, in the order typed. */
function readTokens(title) {
  let rest = s(title).replace(/\.txt$/i, '');
  const codes = [], emails = [];
  for (let em, i = 0; i < 10 && (em = EMAIL_RE.exec(rest)); i++) {
    const e = em[0].toLowerCase().replace(/[.]+$/, '');
    if (!emails.includes(e)) emails.push(e);
    rest = rest.slice(0, em.index) + ' ' + rest.slice(em.index + em[0].length);
  }
  // a Client ID ("CL-2026-00042", "CL 42") — after the emails (cl42@… is an email), before the codes
  const cid = takeClientIds(rest);
  rest = cid.rest;
  // a second code is read as a code too — it never falls into the name as "td 54321"
  for (let cm, i = 0; i < 10 && (cm = CODE_RE.exec(rest)); i++) {
    const c = 'TD-' + cm[1];
    if (!codes.includes(c)) codes.push(c);
    rest = rest.slice(0, cm.index) + ' ' + rest.slice(cm.index + cm[0].length);
  }
  const n = normName(rest);
  return { clientIds: cid.ids, codes, emails, name: /[a-z]{2}/.test(n) ? n : '' };
}

/**
 * What a typed title holds: { clientId, code, email, name, kinds } — clientId is { n, year } (year null
 * when none was typed) or null; the others '' when not there (the FIRST Client ID / code / email).
 */
function readTitle(title) {
  const t = readTokens(title);
  const clientId = t.clientIds[0] || null, code = t.codes[0] || '', email = t.emails[0] || '', name = t.name;
  return { clientId, code, email, name, kinds: [clientId && 'clientId', code && 'code', email && 'email', name && 'name'].filter(Boolean) };
}

const PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** An instant → the Toronto wall clock 'YYYY-MM-DD HH:MM' ('' when it is not a time). */
function torontoWall(ms) {
  const d = new Date(Number(ms));
  if (ms == null || Number.isNaN(d.getTime())) return '';
  const p = {}; for (const x of PARTS.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
/** A Toronto wall clock 'YYYY-MM-DD HH:MM' → the instant (NaN when there is no time of day). */
function wallToMs(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s(wall));
  if (!m) return NaN;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = want;
  for (let i = 0; i < 3; i++) {   // settle across a clock change
    const w = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(torontoWall(guess));
    if (!w) return NaN;
    const shown = Date.UTC(+w[1], +w[2] - 1, +w[3], +w[4], +w[5]);
    if (shown === want) break;
    guess += want - shown;
  }
  return guess;
}

/** How many single-character slips apart two short texts are (stops counting past `max`). */
function editDistance(a, b, max = 3) {
  a = s(a); b = s(b);
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < low) low = cur[j];
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const REASONS = {
  matched: 'Matched',
  clientIdNone: 'The Client ID in the title has no consultation booked on the day of the recording',
  clientIdMany: 'The Client ID in the title has more than one consultation booked that day',
  clientIdUnknown: 'The Client ID in the title is not on any consultation — check the number',
  clientIdYear: 'The year in the Client ID does not match that client\'s Client ID',
  already: 'This recording is already saved on a consultation',
  noStart: 'The recording has no readable start time',
  codeNone: 'The code in the title matches no consultation booked on the day of the recording',
  codeMany: 'The code in the title matches more than one consultation booked that day',
  emailNone: 'The email in the title matches no consultation booked on the day of the recording',
  emailMany: 'The email in the title matches more than one consultation booked that day',
  emailUnknown: 'The email in the title is not the email of any consultation',
  nameNone: 'The name in the title matches no consultation booked around the time of the recording',
  nameMany: 'The name in the title matches more than one consultation booked around that time',
  titleDisagrees: 'The title points at two different consultations',
  noTitle: 'No Client ID, code, email or name was typed as the title',
  old: 'The recording is more than 30 days old',
  short: 'Very short recording',
};

/**
 * @param {{ otterId, title, startTime, summary, transcript }} rec   one parsed recording (otterRecordingFile fields)
 * @param {Array<{ id, name, email, clientId?, bookedSlot, createdAt, consultant, otterIds? }>} consultations
 *        clientId: the Lead Board "Client ID" copy of that consultation ('' when the person has none)
 * @param {{ now?: number, firstSeen?: number }} [opts]
 * @returns {{ decision: 'file'|'needs', leadId?: string, by: 'clientId'|'code'|'email'|'name'|'', reason: string, reasonKey: string, candidates: string[], kinds: string[], already?: boolean }}
 */
function match(rec, consultations, { now = Date.now(), firstSeen } = {}) {
  rec = rec || {};
  const title = readTitle(rec.title), tokens = readTokens(rec.title);
  const out = (decision, key, by, candidates, leadId) => ({
    decision, ...(leadId ? { leadId: String(leadId) } : {}), by: by || '', reason: REASONS[key], reasonKey: key,
    candidates: [...new Set((candidates || []).map((c) => String(c.id == null ? c : c.id)))].slice(0, MAX_CANDIDATES), kinds: title.kinds,
  });
  const otterId = s(rec.otterId);
  const all = (consultations || []).filter((c) => c && s(c.id));
  if (otterId && all.some((c) => Array.isArray(c.otterIds) && c.otterIds.includes(otterId))) return { ...out('needs', 'already', '', []), already: true };

  const startMs = R.startMs(rec.startTime);
  const wall = startMs ? torontoWall(startMs) : '';
  const day = wall.slice(0, 10);
  const slotMs = (c) => wallToMs(c.bookedSlot);
  const gap = (c) => { const t = slotMs(c); return Number.isNaN(t) || !startMs ? Infinity : Math.abs(startMs - t); };
  const nearest = (list) => list.slice().sort((a, b) => gap(a) - gap(b) || Number(b.id) - Number(a.id));
  const sameDay = (c) => !!day && s(c.bookedSlot).slice(0, 10) === day;
  const inWindow = (c) => { const t = slotMs(c); return !!startMs && !Number.isNaN(t) && startMs >= t - EARLY_MIN * 60000 && startMs <= t + LATE_MIN * 60000; };
  const around = nearest(all.filter(inWindow));

  const byCid = title.clientId ? all.filter((c) => idIs(c, title.clientId)) : [];
  const byCode = title.code ? all.filter((c) => recordingCode(c.id) === title.code) : [];
  const byEmail = title.email ? all.filter((c) => s(c.email).toLowerCase() === title.email) : [];
  const byName = title.name ? all.filter((c) => normName(c.name) === title.name) : [];
  const others = [...nearest(byCid), ...nearest(byCode), ...nearest(byEmail), ...nearest(byName), ...around];

  // every token of the title and the consultations it is EXACTLY (rule f)
  const cidGroups = tokens.clientIds.map((tok) => all.filter((c) => idIs(c, tok)));
  const groups = [
    ...cidGroups,
    ...tokens.codes.map((code) => all.filter((c) => recordingCode(c.id) === code)),
    ...tokens.emails.map((email) => all.filter((c) => s(c.email).toLowerCase() === email)),
    byName,
  ];
  const pointed = (list) => [...list.filter(sameDay), ...list.filter(inWindow), ...list].sort((a, b) => gap(a) - gap(b));

  let res;
  if (!startMs) res = out('needs', 'noStart', '', others);
  else if (tokens.clientIds.length > 1) res = out('needs', 'titleDisagrees', '', [...cidGroups.flatMap((g) => nearest(g).slice(0, 2)), ...others]);
  else if (title.clientId) {
    if (byCid.length) {
      const hit = byCid.filter(sameDay);
      res = hit.length === 1 ? out('file', 'matched', 'clientId', [hit[0], ...others], hit[0].id)
        : out('needs', hit.length ? 'clientIdMany' : 'clientIdNone', '', [...nearest(hit), ...others]);
    } else {
      // nobody's Client ID: NEVER filed (a mistyped number is another person). The same number with
      // another year (a mistyped year) is suggested first, and a person chooses.
      const sameNumber = all.filter((c) => idIs(c, { n: title.clientId.n, year: null }));
      res = out('needs', sameNumber.length ? 'clientIdYear' : 'clientIdUnknown', '', [...nearest(sameNumber), ...others]);
    }
  } else if (tokens.codes.length > 1) res = out('needs', 'titleDisagrees', '', [...groups.slice(cidGroups.length, cidGroups.length + tokens.codes.length).flatMap((g) => nearest(g).slice(0, 2)), ...others]);
  else if (title.code) {
    const hit = byCode.filter(sameDay);
    res = hit.length === 1 ? out('file', 'matched', 'code', [hit[0], ...others], hit[0].id)
      : out('needs', hit.length ? 'codeMany' : 'codeNone', '', [...nearest(hit), ...others]);
  } else if (title.email) {
    if (byEmail.length) {
      const hit = byEmail.filter(sameDay);
      res = hit.length === 1 ? out('file', 'matched', 'email', [hit[0], ...others], hit[0].id)
        : out('needs', hit.length ? 'emailMany' : 'emailNone', '', [...nearest(hit), ...others]);
    } else {
      // nobody's email: NEVER filed (review 2, 2026-11-14 — a near email is a guess, and a short or numbered
      // address two slips away is another person). The clients with a near email are suggested first.
      const near = all.filter((c) => s(c.email) && editDistance(s(c.email).toLowerCase(), title.email, 2) <= 2);
      res = out('needs', 'emailUnknown', '', [...nearest(near), ...others]);
    }
  } else if (title.name) {
    const hit = byName.filter(inWindow);
    res = hit.length === 1 ? out('file', 'matched', 'name', [hit[0], ...others], hit[0].id)
      : out('needs', hit.length ? 'nameMany' : 'nameNone', '', [...nearest(hit), ...others]);
  } else res = out('needs', 'noTitle', '', around);

  // rule f: another token in the same title is exactly a different consultation's → a person decides
  if (res.decision === 'file') {
    const against = groups.filter((g) => g.length && !g.some((c) => String(c.id) === res.leadId));
    if (against.length) res = out('needs', 'titleDisagrees', '', [res.leadId, ...against.flatMap((g) => pointed(g).slice(0, 2)), ...others]);
  }

  // never filed by itself: a very short recording, or one first seen long after it was made
  const chars = s(rec.summary).length + s(rec.transcript).length;
  const seen = Number(firstSeen) || now;
  const hold = chars < SHORT_CHARS ? 'short' : (startMs && seen - startMs > MAX_AGE_DAYS * 86400000) ? 'old' : '';
  if (hold && res.decision === 'file') res = out('needs', hold, '', [res.leadId, ...res.candidates]);
  else if (hold === 'short') res = { ...res, reason: REASONS.short, reasonKey: 'short' };
  return res;
}

module.exports = { match, readTitle, readTokens, takeClientIds, normName, torontoWall, wallToMs, editDistance, REASONS, EARLY_MIN, LATE_MIN, MAX_AGE_DAYS, SHORT_CHARS, MAX_CANDIDATES };
