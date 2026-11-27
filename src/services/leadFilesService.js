'use strict';

/**
 * The lead page's "Attachments" (Faran 2026-11-27): the files of ONE lead that staff may open in the app —
 *   · the client's own letters from the intake form (at most four, fixed names), and
 *   · the files a staff member attached (leadAttachmentService).
 * Read-only. Both kinds sit in the client's OneDrive folder → "Intake".
 *
 * WHERE: the lead's candidate folders from utils/clientFolderRefs (the case folder first, then "LEAD-<id>") —
 * a lead's folder is renamed when its case reference is assigned, and a split / reused case leaves files
 * under both names. Each candidate's Intake is LISTED (never created); a same-named file in two folders is
 * shown once, from the first candidate.
 *
 * WHAT IS NEVER LISTED OR SERVED: everything else in Intake — intake-submission.json and
 * pre-consult-submission.json (the client's full answers), pre-consultation-summary.pdf, any other name or
 * type. The two allow-lists below are the whole rule; a name that matches neither does not exist here.
 *
 * HONEST STATES: "no files" is answered only after a clean look. A storage error, a folder held during a
 * repair, or a case reference that could not be read with nothing found → state 'unchecked' (the page says
 * "could not check"), never a false 0.
 *
 * A FILE IS NAMED BY A KEY, never by its name: the key is a hash of (lead id, folder reference, stored
 * name). To open a file the folder is listed AGAIN and the key matched against that fresh listing; the name
 * read from storage is then the one that listing returned. Nothing the browser sends is ever used as a file
 * name or a path part, and no file name is written to a log.
 */

const crypto = require('crypto');
const { parseStaffFileName } = require('./leadAttachmentService');

const io = {
  getLead: (id) => require('./leadService').getLead(String(id)),
  folderState: (lead) => require('../utils/clientFolderRefs').candidateFolderState(lead),
  listChildren: (args) => require('./oneDriveService').listChildren(args),
  readFile: (args) => require('./oneDriveService').readFile(args),
};

const SUBFOLDER = 'Intake';
const LEAD_ID_RE = /^\d{5,20}$/;
const KEY_RE = /^[a-f0-9]{16,64}$/;
const KEY_LENGTH = 24;

/**
 * The client's letters, in the order they are shown. The stored names are the ones intakeFormService
 * writes ("<base>.<pdf|jpg|jpeg|png>"); the labels follow the intake form's own questions.
 */
const CLIENT_LETTERS = Object.freeze([
  Object.freeze({ base: 'enforcement-letter', label: 'Enforcement letter or notice' }),
  Object.freeze({ base: 'refusal-letter', label: 'Refusal letter' }),
  Object.freeze({ base: 'refusal-review-letter', label: 'Refusal letter (refusal review)' }),
  Object.freeze({ base: 'reference-letter', label: 'Relevant letter or screenshot' }),
]);
const CLIENT_LETTER_RE = /^(enforcement-letter|refusal-letter|refusal-review-letter|reference-letter)\.(pdf|jpe?g|png)$/i;

/** Content type by extension ONLY — never what was uploaded; nothing a browser would run (no html, no svg). */
const MIME = Object.freeze({
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
});
/** Types a browser shows in a tab; the rest (heic) are saved as a download. */
const TAB_TYPES = Object.freeze(['pdf', 'jpg', 'jpeg', 'png', 'webp']);
/** Uploads stop at 15 MB; a larger file put there by hand is never read into memory. */
const MAX_READ_BYTES = 20 * 1024 * 1024;

const viewOf = (ext) => (TAB_TYPES.includes(ext) ? 'tab' : 'download');

/** Opaque id of one stored file of one lead (hex; says nothing about the name). */
function keyOf(leadId, folderRef, storedName) {
  return crypto.createHash('sha256').update(`${leadId}\n${folderRef}\n${storedName}`).digest('hex').slice(0, KEY_LENGTH);
}

/**
 * Is this stored name one of the two kinds that may be shown? null = no (never listed, never served).
 * @returns {null | { kind: 'client'|'staff', ext: string, label: string, order: number, addedBy?: string, addedAt?: string }}
 */
function classify(storedName) {
  const name = String(storedName == null ? '' : storedName);
  const m = CLIENT_LETTER_RE.exec(name);
  if (m) {
    const at = CLIENT_LETTERS.findIndex((l) => l.base === m[1].toLowerCase());
    const ext = m[2].toLowerCase();
    return MIME[ext] ? { kind: 'client', ext, label: CLIENT_LETTERS[at].label, order: at } : null;
  }
  const s = parseStaffFileName(name);
  if (s && MIME[s.ext]) {
    return { kind: 'staff', ext: s.ext, label: `${s.name}.${s.ext}`, order: 0, addedBy: s.who, addedAt: `${s.date} ${s.time}` };
  }
  return null;
}

/** A file name for the browser's "save" box: plain ASCII, from the label — never the client's name. */
function downloadNameOf(entry) {
  const stem = entry.kind === 'client'
    ? CLIENT_LETTERS[entry.order].base
    : String(entry.label || '').replace(/\.[a-z0-9]{1,5}$/i, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ._()-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 60).trim();
  return `${stem || 'attachment'}.${entry.ext}`;
}

/** Why a look failed, as one fixed word — the storage error's own text (it can hold a folder name) is never passed on. */
const reasonOf = (err) => (err && err.held ? 'folder-busy' : 'storage');

function sortEntries(list) {
  const rank = (e) => (e.kind === 'client' ? 0 : 1);
  return list.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.kind === 'client') return (a.order - b.order) || a.ext.localeCompare(b.ext);
    // staff files: newest first — by the time in the name, then the storage date, then the name
    return String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
      || String(b.modified || '').localeCompare(String(a.modified || ''))
      || a.label.localeCompare(b.label);
  });
}

/**
 * The fresh look both public functions share. Entries carry the folder reference and the stored name
 * (`_ref`, `_name`) — those two never leave this module.
 * @returns {Promise<{ state: 'ok', entries: object[], partial: boolean } | { state: 'unchecked', reason: string } | { state: 'not-found' }>}
 */
async function look(leadId) {
  const id = String(leadId == null ? '' : leadId).trim();
  if (!LEAD_ID_RE.test(id)) return { state: 'not-found' };
  let lead;
  try { lead = await io.getLead(id); }
  catch (_) { return { state: 'unchecked', reason: 'lead-unreadable' }; }
  if (!lead) return { state: 'not-found' };

  let refs, caseRefKnown;
  try { ({ refs, caseRefKnown } = await io.folderState({ ...lead, id })); }
  catch (_) { return { state: 'unchecked', reason: 'lead-unreadable' }; }

  const entries = [];
  const seen = new Set();
  for (const ref of refs || []) {
    let kids;
    try { kids = await io.listChildren({ clientName: ref.clientName, caseRef: ref.caseRef, subfolder: SUBFOLDER }); }
    catch (err) { return { state: 'unchecked', reason: reasonOf(err) }; }
    for (const k of kids || []) {
      if (!k || k.isFolder) continue;
      const stored = String(k.name == null ? '' : k.name);
      const kind = classify(stored);
      if (!kind) continue;
      const clash = stored.toLowerCase();
      if (seen.has(clash)) continue;        // the same name in a later folder: the first candidate wins
      seen.add(clash);
      entries.push({
        ...kind,
        key: keyOf(id, ref.caseRef, stored),
        size: Number.isFinite(Number(k.size)) ? Number(k.size) : null,
        modified: String(k.lastModifiedDateTime || ''),
        view: viewOf(kind.ext),
        _ref: { clientName: ref.clientName, caseRef: ref.caseRef },
        _name: stored,
      });
    }
  }
  // The case reference could not be read, so the renamed case folder was never looked at: finding nothing
  // then proves nothing.
  if (caseRefKnown === false && !entries.length) return { state: 'unchecked', reason: 'case-unreadable' };
  return { state: 'ok', entries: sortEntries(entries), partial: caseRefKnown === false };
}

const publicFile = (e) => ({
  key: e.key, label: e.label, kind: e.kind, ext: e.ext, size: e.size, modified: e.modified, view: e.view,
  ...(e.kind === 'staff' ? { addedBy: e.addedBy || '', addedAt: e.addedAt || '' } : {}),
});

/**
 * The files of one lead.
 * @returns {Promise<
 *   { state: 'ok', files: Array<{ key, label, kind: 'client'|'staff', ext, size, modified, view: 'tab'|'download', addedBy?, addedAt? }>, partial?: true }
 *   | { state: 'unchecked', files: [], reason: 'storage'|'folder-busy'|'case-unreadable'|'lead-unreadable' }
 *   | { state: 'not-found', files: [] }>}
 *   `partial: true` — the case reference could not be read, so only the lead-stage folder was looked at:
 *   the files shown are real, but there may be more.
 */
async function listLeadFiles(leadId) {
  const r = await look(leadId);
  if (r.state !== 'ok') return { state: r.state, files: [], ...(r.reason ? { reason: r.reason } : {}) };
  return { state: 'ok', files: r.entries.map(publicFile), ...(r.partial ? { partial: true } : {}) };
}

/**
 * One file's bytes, named by its key.
 * @returns {Promise<
 *   { buffer: Buffer, mime: string, ext: string, downloadName: string, view: 'tab'|'download', kind: 'client'|'staff' }
 *   | { refused: 'not-found' | 'unchecked' | 'too-big', reason?: string }>}
 */
async function readLeadFile(leadId, key) {
  const k = String(key == null ? '' : key);
  if (!KEY_RE.test(k)) return { refused: 'not-found' };
  const r = await look(leadId);
  if (r.state === 'not-found') return { refused: 'not-found' };
  if (r.state !== 'ok') return { refused: 'unchecked', reason: r.reason };
  const entry = r.entries.find((e) => e.key === k);
  // Not in a look that could not see every folder: "could not check", not "gone".
  if (!entry) return r.partial ? { refused: 'unchecked', reason: 'case-unreadable' } : { refused: 'not-found' };
  if (entry.size != null && entry.size > MAX_READ_BYTES) return { refused: 'too-big' };
  let buffer;
  try { buffer = await io.readFile({ clientName: entry._ref.clientName, caseRef: entry._ref.caseRef, subfolder: SUBFOLDER, filename: entry._name }); }
  catch (err) { return { refused: 'unchecked', reason: reasonOf(err) }; }
  if (!buffer) return { refused: 'not-found' };   // removed between the look and the read
  if (buffer.length > MAX_READ_BYTES) return { refused: 'too-big' };
  return { buffer, mime: MIME[entry.ext], ext: entry.ext, downloadName: downloadNameOf(entry), view: entry.view, kind: entry.kind };
}

module.exports = {
  listLeadFiles, readLeadFile, io,
  classify, keyOf, downloadNameOf,
  CLIENT_LETTERS, CLIENT_LETTER_RE, MIME, TAB_TYPES, MAX_READ_BYTES, LEAD_ID_RE, KEY_RE, SUBFOLDER,
};
