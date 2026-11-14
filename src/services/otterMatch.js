'use strict';

/**
 * Which consultation does an Otter recording belong to? (Faran 2026-11-14.) PURE — no network,
 * nothing logged. Staff type a title before they stop the recording: the consultation's code
 * (recordingCode.js), or the client's email, or the client's name. NOTHING is ever filed on a guess:
 *
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
 * The FIRST kind of token in the title decides (code, then email, then name); the later ones only
 * add suggestions — a code that does not fit is never overruled by a name that does.
 *   f. the title must not point at two clients (review 2026-11-14): when the deciding token finds
 *      one consultation and ANOTHER token in the same title (a second email, the name) is exactly
 *      some other consultation's and not this one's, nothing is filed — both are suggested. Two
 *      different codes in one title are never filed either. A token that matches nobody does not
 *      block (a nickname, "follow up", a mistyped second word).
 */

const { recordingCode } = require('../utils/recordingCode');
const R = require('./otterRecordingFile');

const EARLY_MIN = 45, LATE_MIN = 120, MAX_AGE_DAYS = 30, SHORT_CHARS = 200, MAX_CANDIDATES = 5;
const s = (v) => String(v == null ? '' : v).trim();

const CODE_RE = /(?:^|[^a-z0-9])td[\s\-‐-―_#:.]{0,5}(\d{5})(?!\d)/i;
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

/** EVERY token of a typed title: { codes: [], emails: [], name } — each code and email once, in the order typed. */
function readTokens(title) {
  let rest = s(title).replace(/\.txt$/i, '');
  const codes = [], emails = [];
  for (let em, i = 0; i < 10 && (em = EMAIL_RE.exec(rest)); i++) {
    const e = em[0].toLowerCase().replace(/[.]+$/, '');
    if (!emails.includes(e)) emails.push(e);
    rest = rest.slice(0, em.index) + ' ' + rest.slice(em.index + em[0].length);
  }
  // a second code is read as a code too — it never falls into the name as "td 54321"
  for (let cm, i = 0; i < 10 && (cm = CODE_RE.exec(rest)); i++) {
    const c = 'TD-' + cm[1];
    if (!codes.includes(c)) codes.push(c);
    rest = rest.slice(0, cm.index) + ' ' + rest.slice(cm.index + cm[0].length);
  }
  const n = normName(rest);
  return { codes, emails, name: /[a-z]{2}/.test(n) ? n : '' };
}

/** What a typed title holds: { code, email, name, kinds } — each '' when not there (the FIRST code / email). */
function readTitle(title) {
  const t = readTokens(title);
  const code = t.codes[0] || '', email = t.emails[0] || '', name = t.name;
  return { code, email, name, kinds: [code && 'code', email && 'email', name && 'name'].filter(Boolean) };
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
  noTitle: 'No code, email or name was typed as the title',
  old: 'The recording is more than 30 days old',
  short: 'Very short recording',
};

/**
 * @param {{ otterId, title, startTime, summary, transcript }} rec   one parsed recording (otterRecordingFile fields)
 * @param {Array<{ id, name, email, bookedSlot, createdAt, consultant, otterIds? }>} consultations
 * @param {{ now?: number, firstSeen?: number }} [opts]
 * @returns {{ decision: 'file'|'needs', leadId?: string, by: 'code'|'email'|'name'|'', reason: string, reasonKey: string, candidates: string[], kinds: string[], already?: boolean }}
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

  const byCode = title.code ? all.filter((c) => recordingCode(c.id) === title.code) : [];
  const byEmail = title.email ? all.filter((c) => s(c.email).toLowerCase() === title.email) : [];
  const byName = title.name ? all.filter((c) => normName(c.name) === title.name) : [];
  const others = [...nearest(byCode), ...nearest(byEmail), ...nearest(byName), ...around];

  // every token of the title and the consultations it is EXACTLY (rule f)
  const groups = [
    ...tokens.codes.map((code) => all.filter((c) => recordingCode(c.id) === code)),
    ...tokens.emails.map((email) => all.filter((c) => s(c.email).toLowerCase() === email)),
    byName,
  ];
  const pointed = (list) => [...list.filter(sameDay), ...list.filter(inWindow), ...list].sort((a, b) => gap(a) - gap(b));

  let res;
  if (!startMs) res = out('needs', 'noStart', '', others);
  else if (tokens.codes.length > 1) res = out('needs', 'titleDisagrees', '', [...groups.slice(0, tokens.codes.length).flatMap((g) => nearest(g).slice(0, 2)), ...others]);
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

module.exports = { match, readTitle, readTokens, normName, torontoWall, wallToMs, editDistance, REASONS, EARLY_MIN, LATE_MIN, MAX_AGE_DAYS, SHORT_CHARS, MAX_CANDIDATES };
