'use strict';

/**
 * Staff attachments (Faran 2026-11-04): a picture / screenshot / PDF of a new
 * client's details, attached by the people in config/staffAttachments.js (Shafoli)
 * on the Add lead or Direct retainer form, or later on the lead page.
 *
 * Where it goes: the client's own OneDrive folder → "Intake", addressed by the
 * lead's FOLDER ID only (a name / case-reference write could mint a second folder
 * while the folder is being renamed — the split-folder rule). Never replaces a file.
 * Then a Monday note on the lead (and the case, when there is one) links each file,
 * so every staff member can open it. Clients never see these.
 */

const RULES = require('../../config/staffAttachments');

const io = {
  getLead: (id) => require('./leadService').getLead(String(id)),
  /** The case row's folder id ('' = none). Throws when it cannot be read — never guess. */
  caseFolderId: async (cmId) => {
    const C = require('../../config/monday').cmColumns.oneDriveFolderId;   // the case row's "OneDrive Folder Id"
    const d = await require('./mondayApi').query(`query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${C}"]) { text } } }`, { id: String(cmId) });
    return (((d && d.items) || [])[0]?.column_values || [])[0]?.text?.trim() || '';
  },
  /** A no-case lead's folder, made now if it is missing (idempotent; records the id on the lead). */
  ensureLeadFolder: (lead) => require('./handoffService').ensureLeadFolderNow(lead),
  upload: (args) => require('./oneDriveService').uploadToFolderIdAsNew(args),
  note: (itemId, body) => require('./mondayApi').query(
    'mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }', { id: String(itemId), b: body }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
};

const FOLDER_WAIT_TRIES = 4;
const FOLDER_WAIT_MS = 2000;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function fail(message, flag) { const e = new Error(message); e[flag] = true; throw e; }

/** "2026-11-04 1432" in Toronto — file names sort by when they were attached. */
function stamp(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}${p.minute}`;
}

/**
 * The stored name of a staff attachment — "2026-11-04 1432 - <staff> - <name>.<ext>" (no staff part when
 * the sign-in carries no name). `ext` comes with its dot, from config/staffAttachments.
 * parseStaffFileName below reads the same shape back: change the two TOGETHER (the lead page's
 * "Attachments" list — leadFilesService — shows and serves only names that parse).
 */
function staffFileName({ at, who, base, ext }) {
  return `${stamp(at)} - ${who ? `${who} - ` : ''}${base}${ext}`;
}

const STAFF_FILE_RE = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2})(\\d{2}) - (.+)\\.(${Object.keys(RULES.EXTENSIONS).map((e) => e.slice(1)).join('|')})$`, 'i');

/**
 * Is this stored file name one that attach() writes? Returns null when it is not, else
 * { date: '2026-11-04', time: '14:32', who, name, ext } — `name` is the file's own name as the staff
 * member uploaded it (cleaned, no extension), `ext` lower-case with no dot, `who` '' when the name
 * carries no staff part. (A file attached with no staff name whose own name holds " - " reads its
 * first part as `who` — the shape cannot tell the two apart.)
 */
function parseStaffFileName(stored) {
  const s = String(stored == null ? '' : stored);
  if (!s || s.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(s)) return null;
  const m = STAFF_FILE_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, rest, ext] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  const cut = rest.indexOf(' - ');
  const who = cut > 0 ? rest.slice(0, cut).trim() : '';
  const name = (cut > 0 ? rest.slice(cut + 3) : rest).trim() || rest.trim();
  if (!name) return null;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, who, name, ext: ext.toLowerCase() };
}

/**
 * The folder a staff file of this lead goes into, by its ID ('' = none on file): with a case, the CASE
 * row's folder (a second lead on a reused case, or a folder made / repaired on the case, can differ from
 * this lead's own); else — or when the case row carries none — the lead's own.
 * Throws when the case row cannot be read — never guess.
 * attach() below writes there; the lead page's "Attachments" list (leadFilesService) asks this SAME
 * function where to look, so the place a file is written and the place it is looked for cannot drift.
 */
async function attachFolderId(lead) {
  const cmId = String((lead && lead.clientMasterItemId) || '').trim();
  const ofCase = cmId ? String((await io.caseFolderId(cmId)) || '').trim() : '';
  return ofCase || String((lead && lead.oneDriveFolderId) || '').trim();
}

/**
 * @param {{ leadId: string, file: { originalname: string, buffer: Buffer, size: number }, staff: { name?: string, email?: string } }} p
 * @returns {Promise<{ ok: true, name: string, url: string, notedOn: string[] }>}
 * @throws .badRequest | .notFound | .forbidden | .retry (try again later) | .noFolder (an admin must make the folder)
 */
async function attach({ leadId, file, staff } = {}) {
  if (!RULES.canAttach(staff)) fail('Only the staff members allowed to attach files can do this (signed in with Monday).', 'forbidden');
  const id = String(leadId || '').replace(/\D/g, '');
  if (!id) fail('Which client? (no lead id)', 'badRequest');
  if (!file || !file.buffer || !file.size) fail('Choose a file to attach.', 'badRequest');
  const ext = RULES.extensionOf(file.originalname);
  if (!RULES.EXTENSIONS[ext]) fail('Only pictures (JPG, PNG, HEIC, WEBP) or a PDF can be attached.', 'badRequest');
  if (file.size > RULES.MAX_FILE_BYTES) fail(`That file is too big — the limit is ${Math.round(RULES.MAX_FILE_BYTES / 1048576)} MB.`, 'badRequest');

  let lead = await io.getLead(id);
  if (!lead) fail('That client could not be found — refresh the page.', 'notFound');
  const cmId = String(lead.clientMasterItemId || '').trim();
  // With a case, the CASE row's folder is the client's folder; else the lead's own (attachFolderId).
  let folderId = '';
  try { folderId = await attachFolderId(lead); }
  catch (err) { fail('The client’s case could not be read just now — try again in a minute.', 'retry'); }
  // A brand-new client's lead folder is made in the background: wait for its id, briefly.
  for (let i = 0; !folderId && i < FOLDER_WAIT_TRIES; i++) {
    await io.sleep(FOLDER_WAIT_MS);
    lead = (await io.getLead(id)) || lead;
    folderId = String(lead.oneDriveFolderId || '').trim();
  }
  if (!folderId && !cmId) {
    // No case: the lead folder cannot have been renamed yet, so making / finding it now is safe.
    const f = await io.ensureLeadFolder(lead).catch(() => null);
    folderId = String((f && f.id) || '').trim();
  }
  if (!folderId) {
    if (cmId) fail('This client has no OneDrive folder on file — an admin can make it with “Case folder…” on the case page; then attach again.', 'noFolder');
    fail('The client’s folder is still being created — attach the file again in a minute from the client’s lead page.', 'retry');
  }

  const who = String((staff && staff.name) || '').trim().slice(0, 40);
  const base = String(file.originalname || 'attachment').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'attachment';
  const filename = staffFileName({ at: io.now(), who, base, ext });
  const up = await io.upload({ folderId, subfolder: 'Intake', filename, buffer: file.buffer, mimeType: RULES.EXTENSIONS[ext] });

  const body = `📎 <b>Attachment added${who ? ` by ${esc(who)}` : ''}</b>: <a href="${esc(up.url)}">${esc(up.name)}</a> ` +
    '(saved in the client’s OneDrive folder → Intake; staff only).';
  const notedOn = [];
  for (const itemId of [id, String(lead.clientMasterItemId || '').trim()].filter(Boolean)) {
    try { await io.note(itemId, body); notedOn.push(itemId); }
    catch (err) { console.warn(`[Attach] note on item ${itemId} failed: ${err.message}`); }
  }
  console.log(`[Attach] lead ${id}: "${up.name}" stored (${file.size} bytes)`);
  return { ok: true, name: up.name, url: up.url, notedOn };
}

module.exports = { attach, attachFolderId, io, stamp, staffFileName, parseStaffFileName, FOLDER_WAIT_TRIES, FOLDER_WAIT_MS };
