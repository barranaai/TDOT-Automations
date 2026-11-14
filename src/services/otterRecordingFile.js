'use strict';

/**
 * One Otter recording as the Zap writes it to OneDrive (Faran 2026-11-12): a .txt file in
 * "Otter Recordings", named "<start time> - <Otter id> - <title>.txt", holding 16 labelled
 * parts. PURE: text in, fields out — no network, nothing logged.
 *
 *   Otter ID: … / Record ID: … / Title: … / Start time: <unix seconds> / Created at: … /
 *   Owner: … / Owner email: … / Guest emails: … / Guest names: … / Meeting link: … /
 *   Otter link: …            (one line each)
 *   Abstract summary: … / Summary: … / Outline: … / Action items: … / Transcript: …
 *                            (each may run over many lines, up to the next label)
 *
 * A label only counts at the START of a line and only in this order, so the same words
 * inside a transcript ("Summary: we agreed…") never cut a part short.
 */

const FIELDS = [
  ['otterId', 'Otter ID'], ['recordId', 'Record ID'], ['title', 'Title'], ['startTime', 'Start time'], ['createdAt', 'Created at'],
  ['owner', 'Owner'], ['ownerEmail', 'Owner email'], ['guestEmails', 'Guest emails'], ['guestNames', 'Guest names'],
  ['meetingLink', 'Meeting link'], ['otterLink', 'Otter link'],
  ['abstractSummary', 'Abstract summary'], ['summary', 'Summary'], ['outline', 'Outline'], ['actionItems', 'Action items'], ['transcript', 'Transcript'],
];
const NAME_RE = /^(\d{9,11}) - (\S+) - (.*)\.txt$/i;
const EMAIL_RE = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/gi;

/** @returns {{ fields: {key: string}, found: string[], missing: string[] }} — every key present ('' when empty or missing). */
function parse(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const fields = {}, found = [];
  for (const [k] of FIELDS) fields[k] = '';
  let next = 0, cur = null, buf = [];
  const close = () => { if (cur) fields[cur] = buf.join('\n').trim(); buf = []; };
  for (const line of lines) {
    let hit = -1;
    // the next label in the list, or a later one (a part the Zap left out is skipped, never an earlier one)
    for (let i = next; i < FIELDS.length; i++) { if (line.startsWith(FIELDS[i][1] + ':')) { hit = i; break; } }
    if (hit >= 0) {
      close();
      cur = FIELDS[hit][0]; found.push(cur); next = hit + 1;
      buf.push(line.slice(FIELDS[hit][1].length + 1));
    } else if (cur) buf.push(line);
  }
  close();
  return { fields, found, missing: FIELDS.map((f) => f[0]).filter((k) => !found.includes(k)) };
}

/** The emails in a "Guest emails" value (Zapier joins a list with commas), lower-cased, once each. */
function emailsOf(v) {
  const out = [];
  for (const m of String(v || '').match(EMAIL_RE) || []) { const e = m.toLowerCase().replace(/[.]+$/, ''); if (!out.includes(e)) out.push(e); }
  return out;
}

/** "Start time" is unix seconds; null when it is not a believable time (2015–2100). */
function startMs(v) {
  const s = String(v || '').trim();
  if (!/^\d{9,13}$/.test(s)) return null;
  const n = Number(s), ms = s.length > 11 ? n : n * 1000;
  return ms > Date.UTC(2015, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

/** The three parts of the file name, or null when it is not one of the Zap's files. */
function nameParts(name) {
  const m = NAME_RE.exec(String(name || ''));
  return m ? { start: m[1], otterId: m[2], title: m[3].trim() } : null;
}

module.exports = { parse, emailsOf, startMs, nameParts, FIELDS };
