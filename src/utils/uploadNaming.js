'use strict';

/**
 * The name a CLIENT CHECKLIST upload is stored under in OneDrive:
 *
 *   <Document> – <Member> – <YYYY-MM-DD HH-mm> – <client's stem><ext>
 *   Passport – PA – 2026-09-30 14-32 – passport.pdf
 *
 * Why a built name at all: until 2026-09-30 a re-upload was stored under the
 * client's own filename, so a second "passport.pdf" REPLACED the first (41
 * same-name re-uploads since 1 Sep, and 35 where one document overwrote a
 * different one in the same folder). Under this name nothing is ever replaced,
 * and a category folder sorts by document, then member, then time — every
 * copy of one document sits together with the newest last. The client's own
 * stem at the end says which scan it was without opening it.
 *
 * Why the ISO date rather than "30 Sep 2026": a folder of 30–90 files must
 * sort, and "01 Oct" sorts before "30 Sep". The form is one constant in
 * torontoStamp if the owner prefers the other. ":" is illegal in a name, so
 * the minute reads 14-32.
 *
 * This module is PURE (no I/O, no clock of its own — the caller passes `now`)
 * and applies to client checklist uploads only. Every other file the app
 * writes to OneDrive keeps its exact name (replace-in-place + version history).
 */

const path = require('path');

const SEP = ' – ';                 // space, EN DASH (U+2013), space — legal on OneDrive, survives NFC
const MAX_STORED_NAME  = 180;      // Graph allows 255; room for a " 12" clash suffix and a long path
const MAX_DOCUMENT     = 60;
const MAX_MEMBER       = 25;
const MAX_STEM         = 40;
const MIN_STEM         = 10;       // how far the stem is cut before the document gives way
const MIN_DOCUMENT     = 20;

/**
 * A name segment OneDrive will keep exactly as given. Counts by CODE POINTS
 * (an emoji is one character, not two), so a cut can never leave half a
 * surrogate pair behind — that half throws in encodeURIComponent and the
 * upload would fail with the file already read into memory.
 *
 * @param {*}      s    any value; coerced to a string
 * @param {number} [max]  cap in code points; absent = no cap
 */
function seg(s, max) {
  let t = String(s == null ? '' : s).normalize('NFC')
    .replace(/\//g, ' - ')                       // a document name must never become a sub-folder ("Employment/ Source" → "Employment - Source")
    .replace(/[\\|]/g, '-')
    .replace(/[*:?"<>\u0000-\u001F\u007F]/g, '') // illegal on OneDrive, or invisible
    .replace(/\s+/g, ' ')
    .trim();
  t = stripEdges(t);
  if (Number.isFinite(max) && max > 0) {
    const cps = Array.from(t);
    if (cps.length > max) {
      // Prefer a word boundary in the second half of the allowance; else hard cut.
      const head  = cps.slice(0, max);
      const space = head.lastIndexOf(' ');
      t = (space >= Math.floor(max / 2) ? head.slice(0, space) : head).join('');
      t = stripEdges(t);
    }
  }
  return dropLoneSurrogates(t);
}

/** Graph trims leading/trailing dots and spaces itself — do it first so the name we record is the name it keeps. */
function stripEdges(t) { return t.replace(/^[\s.]+|[\s.]+$/g, ''); }

function dropLoneSurrogates(t) {
  return t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
}

/**
 * The checklist row's name, shortened to what a person scanning a folder needs:
 * the part before a bracketed aside ("Proof of language proficiency (IELTS-G/…)"
 * → "Proof of language proficiency"), at most 60 characters, no dangling
 * punctuation.
 */
function documentSegment(name) {
  let t = seg(name);
  const paren = t.indexOf(' (');
  if (paren >= 12) t = t.slice(0, paren);
  t = seg(t, MAX_DOCUMENT).replace(/[\s\-–,;(]+$/g, '');
  return t || 'Document';
}

/**
 * Which family member the row is for, in a short fixed vocabulary. Always
 * present (J2): visitor cases still carry Inviter rows, and a folder mixing
 * tagged and untagged names is harder to scan than a uniform one.
 *
 * Two sources, in the order the pages themselves use:
 *   • resolved: a schema-seeded "code:" row (seedPlanner.resolveDocumentCode)
 *     — the role KEY decides, its display label only tells Sponsor from Inviter;
 *   • otherwise the text of the Template/execution Applicant Type column
 *     ("Spouse / Common-Law Partner", "Dependent Child 2", "Worker Spouse"…).
 */
function memberSegment({ resolved, applicantType, applicantLabel } = {}) {
  if (resolved && resolved.role && resolved.role.role) {
    const role  = String(resolved.role.role);
    const label = String(resolved.role.label || '');
    const idx   = Number(resolved.memberIndex) > 0 ? Number(resolved.memberIndex) : 1;
    switch (role) {
      case 'PrincipalApplicant':    return 'PA';
      case 'Spouse':                return 'Spouse';
      case 'DependentChild':        return `Child ${idx}`;
      case 'NonAccompanyingSpouse': return 'Non-Acc Spouse';
      case 'NonAccompanyingChild':  return `Non-Acc Child ${idx}`;
      case 'Sponsor':               return /inviter/i.test(label) ? 'Inviter' : 'Sponsor';
      case 'Parent':
      case 'Sibling':               return idx > 1 ? `${role} ${idx}` : role;
      default:                      return seg(applicantLabel || label || role, MAX_MEMBER) || 'PA';
    }
  }
  const text = String(applicantType || applicantLabel || 'Principal Applicant').trim() || 'Principal Applicant';
  const m    = /(\d+)\s*$/.exec(text);
  const n    = m ? Number(m[1]) : 1;
  const low  = text.toLowerCase();
  // Order matters: "Worker Spouse" and "Non Accompanying Spouse" both contain
  // "spouse"; "Sponsor (Canadian/PR Spouse)" does too, and must stay Sponsor.
  if (/^principal applicant/.test(low))       return 'PA';
  if (/worker spouse/.test(low))              return 'Worker Spouse';
  if (/non.?accompanying spouse/.test(low))   return 'Non-Acc Spouse';
  if (/non.?accompanying child/.test(low))    return `Non-Acc Child ${n}`;
  if (/inviter/.test(low))                    return 'Inviter';
  if (/sponsor/.test(low))                    return /inviter/i.test(String(applicantLabel || '')) ? 'Inviter' : 'Sponsor';
  if (/spouse|partner/.test(low))             return 'Spouse';
  if (/child/.test(low))                      return `Child ${n}`;
  if (/^parent/.test(low))                    return n > 1 ? `Parent ${n}` : 'Parent';
  if (/^sibling/.test(low))                   return n > 1 ? `Sibling ${n}` : 'Sibling';
  return seg(text, MAX_MEMBER) || 'PA';
}

/**
 * Toronto wall-clock parts of a moment. Never toLocaleString for a NAME: ICU
 * short months vary between versions ("Sept" / "Sep.") and hour12:false can
 * yield "24:00" at midnight — formatToParts with hourCycle h23 does not.
 */
function torontoParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) parts[p.type] = p.value;
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

/** "2026-09-30 14-32" in Toronto. Minute precision on purpose: readable; same-minute twins are Graph's job (" 1"). */
function torontoStamp(date) {
  const p = torontoParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}`;
}

/** "2026-09-30" in Toronto — the date a person in the office would write on the row. */
function torontoDate(date) {
  const p = torontoParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The client's extension, lower-cased, when it looks like one; else none. The routes already allow-list it. */
function extensionOf(originalName) {
  const ext = path.extname(String(originalName || ''));
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * The stored name. Capped at MAX_STORED_NAME: the client's stem gives way
 * first (down to 10), then the document (down to 20), then a hard cut of the
 * body — the extension always survives.
 *
 * @param {{ docName: string, member: string, originalName: string, now: Date }} p
 * @returns {string}
 */
function buildStoredName({ docName, member, originalName, now }) {
  const ext   = extensionOf(originalName);
  const base  = ext ? String(originalName).slice(0, -ext.length) : String(originalName || '');
  let doc     = documentSegment(docName);
  let mem     = seg(member, MAX_MEMBER) || 'PA';
  let stem    = seg(base, MAX_STEM) || 'file';
  const stamp = torontoStamp(now || new Date());

  const assemble = () => `${doc}${SEP}${mem}${SEP}${stamp}${SEP}${stem}${ext}`;
  const length   = (s) => Array.from(s).length;
  let name = assemble();
  if (length(name) <= MAX_STORED_NAME) return name;

  const over = () => length(assemble()) - MAX_STORED_NAME;
  const cutTo = (s, n) => stripEdges(Array.from(s).slice(0, n).join(''));
  if (over() > 0) stem = dropLoneSurrogates(cutTo(stem, Math.max(MIN_STEM, length(stem) - over()))) || 'file';
  if (over() > 0) doc  = dropLoneSurrogates(cutTo(doc,  Math.max(MIN_DOCUMENT, length(doc) - over()))) || 'Document';
  name = assemble();
  if (length(name) > MAX_STORED_NAME) {
    const body = name.slice(0, name.length - ext.length);
    name = dropLoneSurrogates(cutTo(body, MAX_STORED_NAME - length(ext))) + ext;
  }
  return name;
}

/**
 * The kill switch, read at call time. OFF until UPLOAD_UNIQUE_NAMES=1 (or
 * true) for this release: Graph's conflictBehavior=rename on a simple upload is
 * documented but unverified in this tenant, so the switch goes on only after
 * scripts/verify-upload-rename.js has passed. OFF = today's behaviour exactly.
 */
function isUniqueNamesEnabled() {
  return /^(1|true)$/i.test(String(process.env.UPLOAD_UNIQUE_NAMES || '').trim());
}

module.exports = {
  seg, documentSegment, memberSegment, torontoStamp, torontoDate, buildStoredName, isUniqueNamesEnabled,
  MAX_STORED_NAME, SEP,
};
