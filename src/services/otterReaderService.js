'use strict';

/**
 * Otter recordings file themselves on the consultation (Faran 2026-11-14, "ok build it").
 *
 * The consultants record a consultation in Otter by hand; a Zap writes one .txt per finished
 * recording into "/Otter Recordings" (otterFilesService / otterRecordingFile). This service reads
 * that folder, decides — with the pure rules of otterMatch.js — which consultation each recording
 * belongs to, and files it there as ONE update on the lead (the same place staff paste an Otter
 * summary). A recording it cannot place with certainty goes on the "to match" list of the
 * Consultations page, where a named staff member saves it to the right client or marks it
 * "not a consultation".
 *
 * Switch — OTTER_READER:  unset / off = nothing runs;  report = the timer does nothing, the admin
 * preview works (files nothing, writes nothing) — and the staff list is hidden, Save / Not a
 * consultation / the admin restore all refuse: 'report' is truly read-only (review 2, 2026-11-14);
 * on = every 10 minutes (scheduler.js).
 *
 * What it never does: change, move or delete an Otter file; overwrite or delete a note; email
 * anyone; change an outcome, a status or any column; log or return a title, a name, an email or
 * any recording text (logs carry counts and Otter ids only; errors carry a status, never a message
 * — a Graph error can quote the file name, and the file name holds the typed title).
 *
 * Proof: the lead's own updates. Each filed entry ends with "Otter recording ref: <id>"
 * (updatesService.getOtterFiled) and that is read before anything is posted. The JSON in OneDrive
 * (STATE_PATH, written with its eTag like the email → lead state) is only the index of what was
 * decided. WHICH leads are read before a post (review 2, 2026-11-14): the ones the saved list names
 * (filed on, suggested, a save started), the ones the title and time point at now — and the ones in
 * the recording's own TRACE: one small file per recording (TRACE_DIR, ids only, a lead is only ever
 * added) written BEFORE anything is posted, by a staff save and by the run alike. So when the saved
 * list is lost, the lead a person chose — which no title or time points at — is still read first,
 * and the recording is never put on a second client. No trace written → nothing is posted.
 *
 * Patterns reused: emailLeadsService (state file in "TDOT System" with readJsonFile/writeJsonFile
 * and the eTag, the io seam, runOnce + "already running", the cron tick), the Teams transcript
 * (uploadToLeadFolderAndLink into the client's folder + a link on the update), bookingReminders
 * (the read-only preview), updatesService (OTTER_HEADER, the escaping, MAX_OTTER, send once).
 */

const R = require('./otterRecordingFile');
const M = require('./otterMatch');
const { recordingCode } = require('../utils/recordingCode');
const { torontoTime } = require('../utils/torontoTime');

const STATE_PATH = 'TDOT System/otter-recordings-state.json';
const TRACE_DIR = 'TDOT System/Otter recording traces';   // one "<Otter id>.json" per recording: { leads: [ids] } — never a title, a name or text
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_FILE_BYTES = 3 * 1024 * 1024;   // the cap io.getText already has
const MAX_PER_RUN = 30;                   // new recordings looked at in one run (the rest wait for the next)
const MAX_REPORT = 100;                   // files the preview opens
const MAX_TRIES = 5;                      // a file that cannot be read / saved is tried this many runs
const MAX_LIST = 50;                      // rows on the "to match" list
const LIST_PAGES = 25;                    // × 200 files, newest first; more than that is SAID in the run result (never a silent stop)
const MAX_PROOF_LEADS = 8;                // SUGGESTED leads whose updates are read before a recording is posted (a lead of a started save or of the trace is always read)
const MAX_TRIED = 10;                     // leads a staff save was started on, kept on the waiting entry (ids only)
const MAX_HEAL = 5;                       // waiting entries with a started save that one run checks against the leads
const VIEW_TTL_MS = 30 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const SNIPPET = 200;

const s = (v) => String(v == null ? '' : v).trim();
const oneLine = (v) => s(v).replace(/\s+/g, ' ');

/** 'off' | 'report' | 'on' — anything else is off. */
function mode() {
  const v = s(process.env.OTTER_READER).toLowerCase();
  return v === 'on' ? 'on' : v === 'report' ? 'report' : 'off';
}

// ─── The side effects, behind one seam (tests replace these) ─────────────────
const io = {
  now: () => Date.now(),
  /** The Zap's files: [{ id, name, size, createdDateTime }] (folders left out). Read-only. */
  /**
   * NEWEST FIRST (review 2026-11-14): the folder only grows, and without an order Graph lists by name —
   * oldest first — so a page limit would drop the newest recordings. The order is the one the Otter
   * file check already uses on this drive (lastModifiedDateTime desc; the Zap writes a file once and
   * nothing changes it); should the drive refuse it, the listing is read unordered instead. When the
   * folder holds more than LIST_PAGES pages the array says so: .capped = true and .notListed = how many
   * entries were left out (null when the folder's own count could not be read) — run() reports it.
   */
  async listFiles() {
    const F = require('./otterFilesService');
    const folder = s(process.env.OTTER_RECORDINGS_FOLDER || 'Otter Recordings');
    const base = `${GRAPH}/users/${encodeURIComponent(F.driveUser())}/drive/root:/${encodeURIComponent(folder)}:`;
    const first = `${base}/children?$top=200&$select=id,name,size,file,folder,createdDateTime`;
    let url = `${first}&$orderby=${encodeURIComponent('lastModifiedDateTime desc')}`;
    const out = [];
    let entries = 0;
    for (let page = 0; page < LIST_PAGES && url; page++) {
      let d;
      try { d = await F.io.get(url); }
      catch (err) {
        if (page !== 0 || url === first || !(err && err.response && err.response.status === 400)) throw err;
        url = first; page = -1; continue;   // the order was refused: the same listing, unordered
      }
      for (const f of d.value || []) { entries++; if (!f.folder) out.push({ id: f.id, name: f.name, size: f.size || 0, createdDateTime: f.createdDateTime || '' }); }
      url = d['@odata.nextLink'] || '';
    }
    if (url) {
      out.capped = true; out.notListed = null;
      try {
        const info = await F.io.get(`${base}?$select=id,folder`);
        const total = Number(info && info.folder && info.folder.childCount);
        if (Number.isFinite(total) && total >= entries) out.notListed = total - entries;
      } catch (_) { /* the run still says the listing was cut short */ }
    }
    return out;
  },
  /** One file's NAME by its id ("<start> - <Otter id> - <title>.txt"). Read-only; never logged, never saved. */
  async fileName(fileId) {
    const F = require('./otterFilesService');
    const d = await F.io.get(`${GRAPH}/users/${encodeURIComponent(F.driveUser())}/drive/items/${encodeURIComponent(fileId)}?$select=id,name`);
    return s(d && d.name);
  },
  /** One file's text (capped at 3 MB by otterFilesService.io.getText). Read-only. */
  async readFile(fileId) {
    const F = require('./otterFilesService');
    return F.io.getText(`${GRAPH}/users/${encodeURIComponent(F.driveUser())}/drive/items/${encodeURIComponent(fileId)}/content`);
  },
  /** Every consultation (upcoming, waiting for an outcome, completed): id, name, email, bookedSlot, createdAt, consultant. */
  async consultations() {
    const snapMod = require('./leadSnapshot');
    const [board, snap] = await Promise.all([
      require('./consultantPortalService').getConsultationsBoard({ withCompleted: true }),
      snapMod.getLeadSnapshot(),
    ]);
    if (board.stale || snap.stale) { const e = new Error('stale'); e.code = 'STALE_COPY'; throw e; }   // never decide on an old copy of the board
    const email = new Map();
    for (const l of snap.leads || []) email.set(String(l.id), s((l[snapMod.CONTACT] || {}).email));
    const seen = new Set(), out = [];
    for (const c of [...(board.consultations || []), ...(board.completed || [])]) {
      const id = String(c.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: s(c.name), email: email.get(id) || '', bookedSlot: s(c.bookedSlot), createdAt: s(c.createdAt), consultant: s(c.consultant) });
    }
    return out;
  },
  readState: () => require('./oneDriveService').readJsonFile(STATE_PATH),
  writeState: (data, etag) => require('./oneDriveService').writeJsonFile(STATE_PATH, data, { etag }),
  /** One recording's trace file → { data, etag } | null when there is none yet. Throws when it cannot be read. */
  readTrace: (otterId) => require('./oneDriveService').readJsonFile(`${TRACE_DIR}/${otterId}.json`),
  writeTrace: (otterId, data, etag) => require('./oneDriveService').writeJsonFile(`${TRACE_DIR}/${otterId}.json`, data, { etag }),
  /** The Otter recordings already on a lead, from its own updates: { recordings:Set, transcripts:Set }. */
  filedOn: (leadId) => require('./updatesService').getOtterFiled(leadId),
  postEntry: (leadId, html) => require('./updatesService').postOtterEntry(leadId, html),
  /** The client's OneDrive folder as recorded on the lead ('' when there is none). */
  async leadFolder(leadId) {
    const lead = await require('./leadService').getLead(leadId);
    return { folderId: s(lead && lead.oneDriveFolderId), fullName: s(lead && (lead.fullName || lead.name)) };
  },
  /** The full transcript into the client's folder, the way the Teams transcript is stored. → { url } */
  saveTranscript: ({ folderId, leadId, fullName, filename, text }) => require('./oneDriveService').uploadToLeadFolderAndLink({
    fullName, leadId, folderId, filename, buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain; charset=utf-8',
  }),
};

/** What may be said about a failure: a status or a code — never the message (it can quote a file name). */
function safeErr(err) {
  const st = err && err.response && err.response.status;
  if (st) return `status ${st}`;
  const code = s(err && err.code);
  return /^[A-Z_0-9]{2,40}$/.test(code) ? code : 'error';
}

// ─── The entry on the lead (PURE) ────────────────────────────────────────────
const esc = (v) => String(v == null ? '' : v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const br = (v) => esc(v).replace(/\r\n?|\n/g, '<br>');
const filled = (v) => { const t = s(v).replace(/\r\n?/g, '\n'); return /^(no data|none|n\/a|null|undefined)$/i.test(t) ? '' : t; };
const header = () => require('./updatesService').OTTER_HEADER;
const maxOtter = () => require('./updatesService').MAX_OTTER;

/** Only a plain https://otter.ai/… address is ever linked. */
function otterLinkOf(v) {
  const t = s(v);
  if (!/^https:\/\/otter\.ai\/[^\s"'<>\\]*$/i.test(t) || t.length > 300) return '';
  try { const u = new URL(t); return u.protocol === 'https:' && u.hostname === 'otter.ai' && !u.username && !u.password ? t : ''; } catch (_) { return ''; }
}
const httpsLink = (v) => { const t = s(v); return /^https:\/\/[^\s"'<>\\]+$/i.test(t) && t.length <= 1500 ? t : ''; };

/** "matched by code" / "assigned by Name" — the name on one line, no brackets (the notes reader keys on "[…]"). */
function howLine({ by, who } = {}) {
  const name = oneLine(who).replace(/[[\]]/g, '').slice(0, 60);
  if (name) return `assigned by ${name}`;
  return ['code', 'email', 'name'].includes(by) ? `matched by ${by}` : 'matched';
}
function whenLine(f) {
  const ms = R.startMs(f && f.startTime);
  return ms ? `recorded ${torontoTime(ms)} (Toronto)` : 'recording time not known';
}

/** Minutes of talk, from the last time stamp in the transcript (null when there is none). */
function minutesLong(transcript) {
  let last = null;
  const re = /(?:^|\s)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?=\s|$)/gm;
  for (let m; (m = re.exec(String(transcript || '')));) last = (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
  return last == null ? null : Math.max(1, Math.round(last / 60));
}

/**
 * The summary entry: heading, the four written parts, the links, the machine line. The written
 * parts together stay inside the cap the pasted Otter summary has (updatesService.MAX_OTTER);
 * a part that does not fit is cut and says so — the whole text stays in Otter.
 */
function buildSummaryEntry(f, { by, who } = {}) {
  const id = s(f.otterId);
  const parts = [['In short', filled(f.abstractSummary)], ['Action items', filled(f.actionItems)], ['Summary', filled(f.summary)], ['Outline', filled(f.outline)]];
  let left = maxOtter() - 600;   // room for the heading, the links and the machine line
  const CUT = '\n… (cut here — the full text is in Otter)';
  const text = {};
  for (const [label, v] of parts) {
    if (!v) continue;
    if (left <= CUT.length + 50) { text[label] = ''; continue; }
    text[label] = v.length > left ? v.slice(0, left - CUT.length) + CUT : v;
    left -= text[label].length;
  }
  const out = [`${header()} — ${esc(whenLine(f))} · ${esc(howLine({ by, who }))}`];
  for (const label of ['In short', 'Summary', 'Outline', 'Action items']) if (text[label]) out.push(`<br><b>${label}</b><br>${br(text[label])}`);
  if (!Object.values(text).some(Boolean)) out.push('<br>Otter wrote no summary for this recording.');
  const link = otterLinkOf(f.otterLink);
  if (link) out.push(`<br>Recording in Otter: <a href="${esc(link)}">${esc(link)}</a>`);
  out.push(`Otter recording ref: ${esc(id)}`);
  return out.join('<br>');
}

/**
 * The entry that follows the summary when the transcript was stored in the client's folder (review 2,
 * 2026-11-14): the upload happens only AFTER the summary entry is on the lead, so the link cannot ride
 * on the summary — it is this short entry of its own. '' when the address is not a plain https link.
 */
function buildTranscriptLinkEntry(f, transcriptUrl) {
  const id = s(f.otterId), tUrl = httpsLink(transcriptUrl);
  if (!tUrl) return '';
  return `${header()} (transcript) — ${esc(whenLine(f))}<br>Full transcript (in the client's folder): <a href="${esc(tUrl)}">${esc(tUrl)}</a><br>Otter transcript ref: ${esc(id)}`;
}

/** The second entry, when the client has no folder: as much of the transcript as one update holds. */
function buildTranscriptEntry(f) {
  const id = s(f.otterId);
  const all = filled(f.transcript);
  const room = maxOtter() - 400;
  const parts = Math.max(1, Math.ceil(all.length / room));
  const head = `${header()} (transcript, part 1 of ${parts}) — ${esc(whenLine(f))}`;
  const tail = parts > 1 ? '<br><br>The rest of the transcript is in Otter.' : '';
  return `${head}<br>${br(all.slice(0, room))}${tail}<br>Otter transcript ref: ${esc(id)}`;
}

/** "Otter transcript 2026-11-12 <otter id>.txt" */
function transcriptFileName(f) {
  const ms = R.startMs(f.startTime);
  return `Otter transcript ${ms ? M.torontoWall(ms).slice(0, 10) : 'undated'} ${s(f.otterId)}.txt`;
}

// ─── Filing ──────────────────────────────────────────────────────────────────
/**
 * Puts one recording on one lead. Reads the lead's updates FIRST (cannot read → throws, nothing is
 * posted). The SUMMARY entry is posted first; only when it is on the lead does the transcript go into
 * the client's OneDrive folder (review 2, 2026-11-14 — a transcript file is never in a client's folder
 * without the recording's mark on that same lead; before, a failed post left the file behind and the
 * recording could then be saved to another client). The stored file is linked from a short second
 * entry; with no folder — or when the folder cannot be written — as much of the transcript as fits is
 * the second entry. A retry adds only what is missing (the same file name replaces itself).
 * @returns {{ ok: true, posted: number, already: boolean, transcript: 'folder'|'update'|'none'|'kept' }}
 */
async function fileOn(leadId, f, { by, who } = {}) {
  const id = s(f.otterId);
  if (!ID_RE.test(id) || !/^\d+$/.test(String(leadId))) throw Object.assign(new Error('bad ids'), { code: 'BAD_IDS' });
  const have = await io.filedOn(leadId);
  const transcript = filled(f.transcript);
  let posted = 0, how = transcript ? 'kept' : 'none';
  if (!have.recordings.has(id)) {
    await io.postEntry(leadId, buildSummaryEntry(f, { by, who }));
    posted++;
  }
  if (transcript && !have.transcripts.has(id)) {
    let linkEntry = '';
    try {
      const folder = await io.leadFolder(leadId);
      if (folder && folder.folderId) {
        const up = await io.saveTranscript({ folderId: folder.folderId, leadId: String(leadId), fullName: folder.fullName, filename: transcriptFileName(f), text: transcript });
        linkEntry = buildTranscriptLinkEntry(f, up && up.url);
        if (linkEntry) trustHostOf(up.url);
      }
    } catch (err) { console.warn(`[Otter] ${id}: the transcript could not go into the client folder (${safeErr(err)}) — posting it as an entry instead`); }
    await io.postEntry(leadId, linkEntry || buildTranscriptEntry(f));
    posted++; how = linkEntry ? 'folder' : 'update';
  }
  return { ok: true, posted, already: posted === 0, transcript: how };
}

// ─── The firm's own file host (for the transcript link on the Updates page) ──
// Review 2 (2026-11-14): the page links a transcript only on the host the app's OWN upload returned —
// never "any *.sharepoint.com". The host is learnt from that upload, kept in the saved list (the app's
// own file) and read back after a restart. None known → the address shows as text, not as a link.
const HOST_RE = /^[a-z0-9-]+\.sharepoint\.com$/;
const _hosts = new Set();
let _hostsAsked = 0;
function trustHostOf(url) {
  try { const u = new URL(s(url)); const h = u.hostname.toLowerCase(); if (u.protocol === 'https:' && !u.username && !u.password && HOST_RE.test(h)) _hosts.add(h); } catch (_) { /* not an address */ }
}
const hostsIn = (data) => (Array.isArray(data && data.transcriptHosts) ? data.transcriptHosts : []).map((h) => s(h).toLowerCase()).filter((h) => HOST_RE.test(h));
/** The hosts a stored transcript may be linked on ([] when none is known). Reads the saved list once after a restart; never throws. */
async function transcriptHosts() {
  if (!_hosts.size && io.now() - _hostsAsked > 5 * 60 * 1000) {
    _hostsAsked = io.now();
    try { await loadState(); } catch (_) { /* not known now: the address stays text */ }
  }
  return [..._hosts];
}

// ─── The saved list (state) ──────────────────────────────────────────────────
const freshState = () => ({ version: 1, recs: {} });
async function loadState() {
  const got = await io.readState();
  const data = got && got.data && typeof got.data.recs === 'object' && got.data.recs ? got.data : freshState();
  for (const h of hostsIn(data)) _hosts.add(h);
  return { data, etag: (got && got.etag) || '', exists: !!got };
}
/** Read-modify-write with the eTag; a change made meanwhile is read again and the edit re-applied. */
async function saveState(edit) {
  for (let attempt = 0; ; attempt++) {
    const st = await loadState();
    const r = edit(st.data);
    if (r === false) return st.data;   // nothing to write
    st.data.savedAt = new Date(io.now()).toISOString();
    if (_hosts.size) st.data.transcriptHosts = [...new Set([...hostsIn(st.data), ..._hosts])].slice(0, 5);
    try { await io.writeState(st.data, st.etag); return st.data; }
    catch (err) { if (!(err && err.conflict) || attempt >= 3) throw err; }
  }
}
const decided = (e) => !!e && (e.d === 'filed' || e.d === 'needs' || e.d === 'dismissed');

// ─── The reader ──────────────────────────────────────────────────────────────
let _running = false;
const _busy = new Set();          // Otter ids being filed right now (a run, or a staff "Save to this client")
const _view = new Map();          // Otter id → what the "to match" list shows (read from the file; never in the saved list)
// Otter id → the "filed" entry of a recording that IS on a lead while the saved list could not be written.
// Until it is written (every run and every staff save tries again) the recording is treated as filed:
// it is not on the "to match" list and cannot be saved to another client.
const _pending = Object.create(null);
const pendingIds = () => Object.keys(_pending);
let _last = { at: null, mode: 'off', ok: null, outcome: 'not run yet', totals: null };

const leadIdOk = (v) => /^\d{4,20}$/.test(String(v));
/**
 * Proof BEFORE posting (review 2026-11-14): is this recording already on a DIFFERENT lead? Reads the
 * updates of every other lead that could hold it. `must` = the leads a save was started on or that the
 * recording's trace names: every one is read. `maybe` = the suggestions (the saved list's and the
 * matcher's): the first MAX_PROOF_LEADS. → that lead's id, or ''. A lead that cannot be read THROWS:
 * nothing is posted blind. ONE exception (review 2): a lead Monday says is NOT THERE (deleted, archived —
 * the explicit notFound of getOtterFiled, never a guess from a message) cannot hold the recording and
 * counts as "not there"; before, one deleted suggestion blocked every save of that recording for good.
 */
async function onAnotherLead(id, target, must, maybe) {
  const clean = (list) => [...new Set((list || []).map(String))].filter((l) => leadIdOk(l) && l !== String(target));
  const first = clean(must);
  const rest = clean(maybe).filter((l) => !first.includes(l)).slice(0, MAX_PROOF_LEADS);
  for (const l of [...first, ...rest]) {
    let have;
    try { have = await io.filedOn(l); }
    catch (err) { if (err && err.notFound === true) continue; throw err; }
    if (have.recordings.has(id) || have.transcripts.has(id)) return l;
  }
  return '';
}

// ─── The recording's own trace (review 2, 2026-11-14) ────────────────────────
/** → { leads, dismissed, etag }. No file yet = no leads. THROWS when it cannot be read (the caller then posts nothing). */
async function readTrace(id) {
  const got = await io.readTrace(id);
  const d = (got && got.data) || {};
  return { leads: [...new Set((Array.isArray(d.leads) ? d.leads : []).map(String).filter(leadIdOk))], dismissed: d.dismissed === true, etag: (got && got.etag) || '' };
}
/** Read-modify-write of one trace file with its eTag. THROWS when it cannot be written. */
async function editTrace(id, edit) {
  for (let attempt = 0; ; attempt++) {
    const t = await readTrace(id);
    const next = { version: 1, otterId: id, leads: t.leads.slice(), dismissed: t.dismissed };
    if (edit(next) === false) return;
    try { await io.writeTrace(id, next, t.etag); return; }
    catch (err) { if (!(err && err.conflict) || attempt >= 3) throw err; }
  }
}
/** "This recording is about to be put on this lead" — written BEFORE the post; a lead is only ever added. */
const traceLead = (id, lead) => editTrace(id, (t) => { if (t.leads.includes(String(lead))) return false; t.leads.push(String(lead)); });
/** "Not a consultation" (or back on the list) — best effort: it only saves a person pressing the button again after the saved list was lost. */
async function traceDismissed(id, yes) {
  try { await editTrace(id, (t) => { if (t.dismissed === yes) return false; t.dismissed = yes; }); }
  catch (err) { console.warn(`[Otter] ${id}: the recording's trace could not be written (${safeErr(err)})`); }
}
const triedOf = (e) => [...new Set([...((e && Array.isArray(e.tried) && e.tried) || []), ...((e && e.was && Array.isArray(e.was.tried) && e.was.tried) || [])].map(String))].filter(leadIdOk);
const PERMANENT = new Set(['TOO_LARGE', 'NOT_A_RECORDING', 'ID_MISMATCH']);   // a fault of the file itself: trying again changes nothing
/** How a saved entry's file is opened again: one given up on as too large is refused without downloading it. */
const fileOfEntry = (e) => ({ id: e.fileId, size: e.fault === 'TOO_LARGE' ? MAX_FILE_BYTES + 1 : 0 });

/** Writes the "filed" entries the saved list is still missing (best effort; what could not be written stays in memory). */
async function flushPending() {
  if (!pendingIds().length) return true;
  const mine = Object.entries(_pending);
  try {
    await saveState((data) => {
      let changed = false;
      for (const [id, entry] of mine) { const cur = data.recs[id]; if (!(cur && cur.d === 'filed')) { data.recs[id] = entry; changed = true; } }
      return changed ? undefined : false;
    });
    for (const [id, entry] of mine) if (_pending[id] === entry) delete _pending[id];
    return true;
  } catch (_) { return false; }
}

/** The file-name parts of a saved file id (the fallback for the title and the start time); blanks when the name cannot be read. */
async function namePartsOf(fileId, id) {
  const blank = { otterId: id, start: '', title: '' };
  if (!fileId) return blank;
  try {
    const np = R.nameParts(await io.fileName(fileId));
    return np && np.otterId === id ? np : blank;
  } catch (_) { return blank; }
}

/** The parts of one file the rules need; throws (with a code, no text) when it is not a readable recording. */
async function readRecording(file, np) {
  if (Number(file.size) > MAX_FILE_BYTES) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
  const p = R.parse(await io.readFile(file.id));
  const f = p.fields;
  if (!p.found.length) throw Object.assign(new Error('not a recording'), { code: 'NOT_A_RECORDING' });
  if (f.otterId && f.otterId !== np.otterId) throw Object.assign(new Error('id mismatch'), { code: 'ID_MISMATCH' });
  f.otterId = np.otterId;
  if (!R.startMs(f.startTime)) f.startTime = np.start;
  if (!f.title) f.title = np.title;
  return f;
}

/** The first words of the summary. Whether anything was CUT is decided here, never guessed from the length on the page. */
function snippetOf(f) {
  const all = oneLine(filled(f.abstractSummary) || filled(f.summary));
  if (all.length <= SNIPPET) return { snippet: all, snippetCut: false };
  return { snippet: all.slice(0, SNIPPET).replace(/[\s.,;:!?]+$/, ''), snippetCut: true };   // the page adds the "…" — never after a full stop
}
function viewFrom(f, fileRead) {
  const ms = R.startMs(f.startTime);
  return {
    at: io.now(), fileRead, title: oneLine(f.title).slice(0, 200), startTime: f.startTime, when: ms ? M.torontoWall(ms) : '',
    ...snippetOf(f),
    minutes: minutesLong(f.transcript), chars: s(f.summary).length + s(f.transcript).length,
  };
}
function remember(id, f) { _view.set(id, viewFrom(f, true)); }

async function run(m) {
  const nowMs = io.now(), nowIso = new Date(nowMs).toISOString();
  const totals = { file: 0, filed: 0, needs: 0, unreadable: 0, failed: 0 };
  const out = { ok: true, mode: m, at: nowIso, filesInFolder: 0, otherFiles: 0, alreadyDecided: 0, gaveUp: 0, waiting: 0, duplicates: 0, onAnotherConsultation: 0, totals, files: [] };
  const stop = (outcome, err) => ({ ...out, ok: false, outcome, problem: safeErr(err) });

  let st, files, consults;
  try { st = await loadState(); } catch (err) { return stop('The saved list of recordings could not be read — nothing was done.', err); }
  try { files = await io.listFiles(); } catch (err) { return stop('The recordings folder could not be read — nothing was done.', err); }
  try { consults = await io.consultations(); } catch (err) { return stop('The consultations could not be read — nothing was done.', err); }
  const recs = st.data.recs;
  // the saved list's own memory of what is filed where — the matcher never offers a recording to a consultation that has it
  const onLead = new Map();
  for (const [oid, e] of Object.entries(recs)) if (e && e.d === 'filed' && e.leadId) onLead.set(String(e.leadId), [...(onLead.get(String(e.leadId)) || []), oid]);
  const pool = consults.map((c) => (onLead.has(String(c.id)) ? { ...c, otterIds: onLead.get(String(c.id)) } : c));

  out.filesInFolder = files.length;
  if (files.capped) {   // the folder is larger than one run lists: said, with the count, never silently
    out.listCapped = true;
    out.filesNotListed = files.notListed == null ? null : Number(files.notListed);
  }
  const changes = {};
  if (m === 'on') {
    // "filed" entries an earlier write could not save: written with this run's changes, and decided meanwhile
    for (const [pid, entry] of Object.entries(_pending)) { if (recs[pid] && recs[pid].d === 'filed') delete _pending[pid]; else changes[pid] = entry; }
    // a staff save that was started (the lead is noted on the waiting entry) but never recorded as done:
    // the lead's own updates say whether it happened — then the recording is filed there and leaves the list
    let healed = 0;
    for (const [hid, e] of Object.entries(recs)) {
      if (healed >= MAX_HEAL) break;
      if (!e || e.d !== 'needs' || !Array.isArray(e.tried) || !e.tried.length || changes[hid] || _busy.has(hid) || !ID_RE.test(hid)) continue;
      healed++;
      try {
        const at = await onAnotherLead(hid, '', e.tried);
        if (at) changes[hid] = { d: 'filed', leadId: at, by: 'found', at: nowIso };
      } catch (_) { /* not readable now: the next run looks again */ }
    }
  }
  let looked = 0;
  // ONE file per Otter id in a run (review 2026-11-14). When the automation wrote a recording twice — the
  // title was changed after the first file — the LATER file is the one acted on: it carries the title as
  // it was last typed. The other is counted (duplicates) and never read, matched or filed.
  const newest = new Map();
  files.forEach((file, i) => {
    const np = R.nameParts(file.name);
    if (!np || !ID_RE.test(np.otterId)) return;
    const cur = newest.get(np.otterId);
    if (!cur || String(file.createdDateTime) > String(cur.file.createdDateTime) || (String(file.createdDateTime) === String(cur.file.createdDateTime) && (file.name > cur.file.name || (file.name === cur.file.name && i > cur.i)))) newest.set(np.otterId, { file, i });
  });
  const ordered = files.slice().sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)));
  if (m === 'report') ordered.reverse();   // the preview shows the newest first
  for (const file of ordered) {
    const np = R.nameParts(file.name);
    if (!np || !ID_RE.test(np.otterId)) { out.otherFiles++; continue; }
    const id = np.otterId, known = recs[id];
    if (newest.get(id).file !== file) { out.duplicates++; continue; }
    if (m === 'on') {
      if (changes[id]) { out.alreadyDecided++; continue; }   // decided a moment ago (see above)
      // a file given up on is on the "to match" list now (it used to vanish) — still counted here
      if (known && known.d === 'needs' && known.reasonKey === 'unreadable') { out.gaveUp++; continue; }
      if (decided(known)) { out.alreadyDecided++; continue; }
      if (known && known.d === 'failed' && known.tries >= MAX_TRIES) { out.gaveUp++; continue; }
      if (_busy.has(id)) { out.waiting++; continue; }
    }
    if (looked >= (m === 'on' ? MAX_PER_RUN : MAX_REPORT)) { out.waiting++; continue; }
    looked++;
    const firstSeen = (known && Number(known.firstSeen)) || nowMs;
    const tries = (known && known.d === 'failed' && Number(known.tries)) || 0;
    const row = { created: file.createdDateTime || '', ...(m === 'report' && known ? { saved: known.d } : {}) };
    let f;
    try { f = await readRecording(file, np); }
    catch (err) {
      // one bad file never stops the others; it is tried again on the next runs (MAX_TRIES) — and after
      // the last try a person takes over: it goes on the "to match" list, it is never given up silently
      totals.unreadable++;
      out.files.push({ ...row, decision: 'unreadable', problem: safeErr(err) });
      if (m === 'on') {
        changes[id] = tries + 1 >= MAX_TRIES
          ? { d: 'needs', reasonKey: 'unreadable', candidates: [], tries: tries + 1, firstSeen, fileId: file.id, ...(PERMANENT.has(err && err.code) ? { fault: err.code } : {}) }
          : { d: 'failed', what: 'read', tries: tries + 1, firstSeen, last: nowIso, fileId: file.id };
      }
      continue;
    }
    const d = M.match(f, pool, { now: nowMs, firstSeen });
    Object.assign(row, {
      decision: d.decision, by: d.by, reason: d.reason, candidates: d.candidates.length,
      summaryChars: s(f.summary).length, transcriptChars: s(f.transcript).length,
      titlePresent: !!s(f.title), titleHolds: d.kinds,
    });
    // the recording's own trace (review 2): the leads a save of it was ever started on — read before
    // anything is decided. It cannot be read → nothing is posted and nothing is listed; tried again.
    let traced = { leads: [], dismissed: false };
    if (m === 'on' && !d.already) {
      try { traced = await readTrace(id); }
      catch (err) {
        totals.failed++; row.filed = false; row.problem = safeErr(err);
        changes[id] = tries + 1 >= MAX_TRIES
          ? { d: 'needs', reasonKey: d.decision === 'file' ? 'saveFailed' : d.reasonKey, candidates: d.candidates, firstSeen, fileId: file.id }
          : { d: 'failed', what: 'save', tries: tries + 1, firstSeen, last: nowIso, fileId: file.id };
        out.files.push(row);
        continue;
      }
      // a person marked it "Not a consultation" and the saved list forgot: it stays off the list
      if (traced.dismissed && !known) {
        changes[id] = { d: 'dismissed', who: '', by: 'found', at: nowIso, why: '', was: { reasonKey: d.decision === 'file' ? 'saveFailed' : d.reasonKey, candidates: d.candidates, firstSeen, fileId: file.id, ...(traced.leads.length ? { tried: traced.leads.slice(-MAX_TRIED) } : {}) } };
        out.alreadyDecided++;
        continue;
      }
    }
    if (d.decision === 'file') totals.file++; else totals.needs++;
    if (m === 'report') {
      if (d.decision === 'file') { try { row.alreadyOnRecord = (await io.filedOn(d.leadId)).recordings.has(id); } catch (_) { row.alreadyOnRecord = null; } }
    } else if (d.decision === 'file') {
      _busy.add(id);
      try {
        // proof first: is it already on ANOTHER consultation (an earlier filing the saved list lost, a booking moved since, a person's save)?
        const elsewhere = await onAnotherLead(id, d.leadId,
          [known && known.leadId, ...triedOf(known), ...traced.leads],
          [...((known && known.candidates) || []), ...d.candidates]);
        if (elsewhere) {
          changes[id] = { d: 'filed', leadId: elsewhere, by: 'found', at: nowIso };
          out.onAnotherConsultation++; row.filed = false; row.alreadyOnRecord = true; row.onAnotherConsultation = true;
        } else {
          await traceLead(id, d.leadId);   // the trace BEFORE the post — it cannot be written → nothing is posted
          const r = await fileOn(d.leadId, f, { by: d.by });
          changes[id] = { d: 'filed', leadId: String(d.leadId), by: d.by, at: nowIso };
          totals.filed++; row.filed = true; row.alreadyOnRecord = r.already; row.transcript = r.transcript;
        }
      } catch (err) {
        totals.failed++; row.filed = false; row.problem = safeErr(err);
        changes[id] = tries + 1 >= MAX_TRIES
          ? { d: 'needs', reasonKey: 'saveFailed', candidates: d.candidates, firstSeen, fileId: file.id }
          : { d: 'failed', what: 'save', tries: tries + 1, firstSeen, last: nowIso, fileId: file.id };
      } finally { _busy.delete(id); }
    } else if (!d.already) {
      // the trace names a lead (the saved list was lost after a person's save): that lead's own updates say
      // whether the recording is there — then it is filed there and never comes back on the list
      let at = '';
      if (traced.leads.length) { try { at = await onAnotherLead(id, '', traced.leads); } catch (_) { /* not readable now: the leads are noted on the entry; the next run and every Save read them first */ } }
      if (at) {
        changes[id] = { d: 'filed', leadId: at, by: 'found', at: nowIso };
        totals.needs--; out.onAnotherConsultation++; row.decision = 'file'; row.filed = false; row.alreadyOnRecord = true; row.onAnotherConsultation = true;
      } else {
        changes[id] = { d: 'needs', reasonKey: d.reasonKey, candidates: d.candidates, firstSeen, fileId: file.id, ...(traced.leads.length ? { tried: traced.leads.slice(-MAX_TRIED) } : {}) };
        remember(id, f);
      }
    }
    out.files.push(row);
  }

  if (m === 'on' && Object.keys(changes).length) {
    try {
      await saveState((data) => {
        for (const [id, c] of Object.entries(changes)) {
          const cur = data.recs[id];
          // what a person decided meanwhile (saved to a client, not a consultation) stands
          if (cur && (cur.d === 'filed' || cur.d === 'dismissed') && c.d !== 'filed') continue;
          // a started save noted on the entry meanwhile is never lost by a run that rewrites it (review 2)
          const keep = c.d === 'needs' || c.d === 'failed' ? [...new Set([...triedOf(cur), ...triedOf(c)])] : [];
          data.recs[id] = keep.length ? { ...c, tried: keep.slice(-MAX_TRIED) } : c;
        }
      });
      for (const [id, c] of Object.entries(changes)) if (_pending[id] === c) delete _pending[id];
    } catch (err) {
      // the entries are on the leads (the proof); the next run reads them there and posts nothing twice —
      // and what was filed is remembered here, so the next write carries it and no other client can get it meanwhile
      out.ok = false; out.stateSaved = false; out.problem = safeErr(err);
      for (const [id, c] of Object.entries(changes)) if (c.d === 'filed') _pending[id] = c;
    }
  }
  const cut = out.listCapped
    ? ` The recordings folder holds more files than one run lists — ${out.filesNotListed == null ? 'some older files' : out.filesNotListed + ' older file(s)'} were not looked at.`
    : '';
  if (out.listCapped) console.warn(`[Otter] the recordings folder is larger than one run lists: ${files.length} file(s) listed, ${out.filesNotListed == null ? 'an unknown number' : out.filesNotListed} not listed`);
  out.outcome = m === 'report'
    ? `Preview only — nothing was saved. ${totals.file} would be saved to a consultation, ${totals.needs} would wait to be matched, ${totals.unreadable} could not be read.${cut}`
    : `${totals.filed} saved to a consultation, ${totals.needs} to match, ${totals.unreadable} could not be read, ${totals.failed} could not be saved.${cut}`;
  if (m === 'on' && looked) console.log(`[Otter] ${looked} new recording(s): ${totals.filed} saved, ${totals.needs} to match, ${totals.unreadable} unreadable, ${totals.failed} not saved${out.stateSaved === false ? ' — the saved list could not be written' : ''}`);
  return out;
}

/**
 * One pass over the folder. mode 'on' files what is certain and lists the rest; mode 'report' files
 * NOTHING and writes NOTHING (not even the saved list) and returns what it would do. One at a time.
 */
async function runOnce({ mode: m = mode() } = {}) {
  if (m !== 'on' && m !== 'report') return { ok: null, mode: 'off', outcome: 'Switched off (OTTER_READER is not "report" or "on") — nothing was read.' };
  if (_running) return { ok: false, mode: m, outcome: 'already running' };
  _running = true;
  try {
    const r = await run(m);
    _last = { at: r.at, mode: m, ok: r.ok, outcome: r.outcome, totals: r.totals, ...(r.listCapped ? { listCapped: true, filesNotListed: r.filesNotListed } : {}) };
    return r;
  } catch (err) {
    _last = { at: new Date(io.now()).toISOString(), mode: m, ok: false, outcome: 'failed', totals: null };
    return { ok: false, mode: m, outcome: 'The run failed — nothing more was done.', problem: safeErr(err) };
  } finally { _running = false; }
}

/** The timer's call (scheduler.js): only when the switch is on. */
async function tick() {
  if (mode() !== 'on') return null;
  return runOnce({ mode: 'on' });
}

// ─── The "to match" list and what staff do with it ───────────────────────────
const PLAIN = {
  ...M.REASONS,
  saveFailed: 'It could not be saved by itself — choose the client and save it',
  unreadable: 'The recording file could not be opened — look at it in the recordings folder. If it opens later you can choose the client; otherwise press Not a consultation',
  // a fault of the file itself (not a recording, another recording inside, too large): Save can never work — it is not offered
  unreadableForGood: 'The recording file cannot be opened, so it cannot be saved to a client from here — look at it in the recordings folder; if it was a consultation, add the notes to the client by hand. Then press Not a consultation',
};
const CANNOT_OPEN = 'This recording file cannot be opened, so it cannot be saved to a client from here. If it was a consultation, add the notes to the client by hand — then press Not a consultation.';
const httpErr = (status, message) => Object.assign(new Error(message), { status });

async function viewOf(id, e, faults) {
  const hit = _view.get(id);
  if (hit && io.now() - hit.at < VIEW_TTL_MS) return hit;
  if (!e.fileId) return null;
  // the file name is the fallback for the title and the start time, as in the run (it is fetched by the
  // file's id — the typed title is never put into the saved list)
  const np = await namePartsOf(e.fileId, id);
  try {
    const f = await readRecording(fileOfEntry(e), np);
    remember(id, f);
    return _view.get(id);
  } catch (err) {
    if (faults && PERMANENT.has(err && err.code)) faults.add(id);   // the file itself is at fault: Save is not offered for this row
    // the file cannot be opened: the row still shows what its name says (not kept — the next look tries again)
    return np.start || np.title ? viewFrom({ title: np.title, startTime: np.start }, false) : null;
  }
}

/** The recordings waiting for a person: what staff need to recognise the client, and the suggestions. */
async function needsList() {
  // only while switched ON (review 2): in 'report' the strip is hidden and nothing is written
  if (mode() !== 'on') return { on: false, items: [] };
  // the held "filed" entries are written BEFORE the list is read (review 2) — read first, a recording
  // saved a moment ago showed once more as waiting
  if (pendingIds().length) await flushPending();
  const st = await loadState();
  const open = Object.entries(st.data.recs).filter(([id, e]) => e && e.d === 'needs' && ID_RE.test(id) && !_pending[id])
    .sort((a, b) => Number(b[1].firstSeen || 0) - Number(a[1].firstSeen || 0)).slice(0, MAX_LIST);
  if (!open.length) return { on: true, items: [] };
  let consults = [];
  try { consults = await io.consultations(); } catch (_) { /* the list still shows; the picker has no suggestions */ }
  const byId = new Map(consults.map((c) => [String(c.id), c]));
  const items = [], faults = new Set();
  for (let i = 0; i < open.length; i += 4) {   // a few files at a time
    const views = await Promise.all(open.slice(i, i + 4).map(([id, e]) => viewOf(id, e, faults)));
    open.slice(i, i + 4).forEach(([id, e], k) => {
      const v = views[k];
      let ids = Array.isArray(e.candidates) ? e.candidates.map(String) : [];
      const dead = faults.has(id);
      if (dead) ids = [];
      else if (v && consults.length) {
        const d = M.match({ otterId: id, title: v.title, startTime: v.startTime, summary: 'x'.repeat(Math.min(v.chars, M.SHORT_CHARS)), transcript: '' }, consults, { now: io.now(), firstSeen: e.firstSeen });
        const fresh = d.leadId ? [d.leadId, ...d.candidates] : d.candidates;
        if (fresh.length) ids = [...new Set(fresh)];
      }
      items.push({
        otterId: id,
        when: v ? v.when : '', minutes: v ? v.minutes : null,
        title: v ? v.title : '', snippet: v ? v.snippet : '', snippetCut: !!(v && v.snippetCut),
        fileRead: !!(v && v.fileRead),
        reason: dead ? PLAIN.unreadableForGood : (PLAIN[e.reasonKey] || 'It could not be matched to a consultation'),
        saveable: !dead,   // false = only "Not a consultation" is offered
        candidates: ids.map((cid) => byId.get(cid)).filter(Boolean).slice(0, M.MAX_CANDIDATES)
          .map((c) => ({ id: c.id, name: c.name, bookedSlot: c.bookedSlot, consultant: c.consultant, code: recordingCode(c.id) })),
      });
    });
  }
  items.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  return { on: true, items };
}

async function withBusy(id, fn) {
  if (_busy.has(id)) throw httpErr(409, 'This recording is being saved right now — try again in a moment.');
  _busy.add(id);
  try { return await fn(); } finally { _busy.delete(id); }
}
// Save, Not a consultation and the admin restore work ONLY while the switch is 'on' (review 2): 'report' and 'off' write nothing, anywhere.
const checkMode = () => { if (mode() !== 'on') throw httpErr(409, 'Otter recordings are not switched on yet.'); };
const actorName = (actor) => {
  if (!actor || actor.verified !== true || !s(actor.name)) throw httpErr(401, 'Sign in with Monday first — the shared admin key does not say who you are.');
  return oneLine(actor.name).slice(0, 60);
};

/** "Save to this client": a NAMED staff member files a waiting recording on the consultation they chose. */
async function assign({ otterId, leadId, actor } = {}) {
  checkMode();
  const who = actorName(actor);
  const id = s(otterId), lead = s(leadId);
  if (!ID_RE.test(id)) throw httpErr(404, 'This recording is not on the list.');
  if (!/^\d{4,20}$/.test(lead)) throw httpErr(400, 'Choose the client first.');
  return withBusy(id, async () => {
    const ELSEWHERE = 'This recording is already saved on another consultation.';
    // it IS on a lead and only the saved list is behind: write the list again; never a second client
    const held = _pending[id];
    if (held) {
      const written = await flushPending();
      if (String(held.leadId) !== lead) throw httpErr(409, ELSEWHERE);
      return { ok: true, already: true, ...(written ? {} : { warning: 'Saved. The list may still show it for a few minutes.' }) };
    }
    const st = await loadState();
    const e = st.data.recs[id];
    if (e && e.d === 'filed') {
      if (String(e.leadId) === lead) return { ok: true, already: true };
      throw httpErr(409, ELSEWHERE);
    }
    if (!e || e.d !== 'needs') throw httpErr(404, 'This recording is not on the list any more — refresh the page.');
    let consults;
    try { consults = await io.consultations(); } catch (_) { throw httpErr(503, 'The consultations could not be read just now — nothing was saved. Try again in a minute.'); }
    if (!consults.some((c) => String(c.id) === lead)) throw httpErr(404, 'That consultation was not found — refresh the page and choose again.');
    let f;
    try { f = await readRecording(fileOfEntry(e), await namePartsOf(e.fileId, id)); }
    catch (err) {
      // a fault of the file itself never mends by pressing again: said plainly, with no "try again" (review 2)
      if (PERMANENT.has(err && err.code)) throw httpErr(422, CANNOT_OPEN);
      throw httpErr(502, 'The recording file could not be read just now — nothing was saved. Try again in a minute.');
    }

    // Proof BEFORE posting (review 2026-11-14) — a recording already on client A is never put on client B:
    // 1. the lead this save is for is NOTED on the waiting entry first. If the note cannot be written,
    //    nothing is posted — so a save that does post always leaves a trace of where, even when the final
    //    write fails or the server restarts, and the next save (to any client) reads that lead first;
    let noted = null;
    try {
      await saveState((data) => {
        const cur = data.recs[id];
        if (!cur || cur.d !== 'needs') { noted = cur && cur.d === 'filed' ? { filedOn: String(cur.leadId) } : { gone: true }; return false; }
        noted = { tried: Array.isArray(cur.tried) ? cur.tried.map(String) : [], candidates: Array.isArray(cur.candidates) ? cur.candidates.map(String) : [] };
        if (noted.tried.includes(lead)) return false;
        cur.tried = [...noted.tried, lead].slice(-MAX_TRIED);
      });
    } catch (_) { throw httpErr(503, 'It could not be saved just now — nothing was added to any client. Try again in a minute.'); }
    if (noted.filedOn) { if (noted.filedOn === lead) return { ok: true, already: true }; throw httpErr(409, ELSEWHERE); }
    if (noted.gone) throw httpErr(404, 'This recording is not on the list any more — refresh the page.');
    // 2. every other lead that could hold it is read: the ones noted by an earlier save, the suggestions
    //    saved with the entry and the ones the title and time point at now. One that cannot be read → nothing is posted.
    //    — and the leads in the recording's own trace (review 2): they are there even when the saved list was lost.
    const fresh = M.match(f, consults, { now: io.now(), firstSeen: e.firstSeen });
    const NOT_CHECKED = 'It could not be checked just now whether this recording is already on another client — nothing was saved. Try again in a minute.';
    let traced;
    try { traced = await readTrace(id); } catch (_) { throw httpErr(502, NOT_CHECKED); }
    let elsewhere;
    try { elsewhere = await onAnotherLead(id, lead, [...noted.tried, ...traced.leads], [...noted.candidates, fresh.leadId, ...fresh.candidates]); }
    catch (_) { throw httpErr(502, NOT_CHECKED); }
    if (elsewhere) {
      const found = { d: 'filed', leadId: elsewhere, by: 'found', at: new Date(io.now()).toISOString() };
      _pending[id] = found;
      await flushPending();
      _view.delete(id);
      console.log(`[Otter] ${id}: it was already on another consultation — nothing was added`);
      throw httpErr(409, ELSEWHERE);
    }

    // 3. the lead goes into the recording's trace — a file of its own, so losing the saved list does not lose it.
    //    It cannot be written → nothing is posted.
    try { await traceLead(id, lead); }
    catch (_) { throw httpErr(503, 'It could not be saved just now — nothing was added to any client. Try again in a minute.'); }

    let r;
    try { r = await fileOn(lead, f, { who }); }
    catch (_) { throw httpErr(502, 'The recording could not be saved to the client just now. Try again in a minute — it will not be saved twice.'); }
    const entry = { d: 'filed', leadId: lead, by: 'staff', who, at: new Date(io.now()).toISOString() };
    // it is on the lead now: the saved list is written — and written AGAIN (now, then on every run, list
    // view and save) until it holds; meanwhile the recording is off the list and cannot go to another client
    _pending[id] = entry;
    let listed = await flushPending();
    if (!listed) listed = await flushPending();
    if (!listed) console.warn(`[Otter] ${id}: saved to a consultation, but the saved list could not be written — it will be written again`);
    _view.delete(id);
    console.log(`[Otter] ${id}: saved to a consultation by a staff member${r.already ? ' (it was already there)' : ''}`);
    // the consultation already had this recording: nothing was added a second time
    return { ok: true, already: r.already, transcript: r.transcript, ...(listed ? {} : { warning: 'Saved. The list may still show it for a few minutes.' }) };
  });
}

/** "Not a consultation": off the list (nothing is deleted; an admin can bring it back). */
async function dismiss({ otterId, why, actor } = {}) {
  checkMode();
  const who = actorName(actor);
  const id = s(otterId);
  if (!ID_RE.test(id)) throw httpErr(404, 'This recording is not on the list.');
  return withBusy(id, async () => {
    if (_pending[id]) { await flushPending(); throw httpErr(409, 'This recording is already saved on a consultation.'); }
    let result = null;
    await saveState((data) => {
      const e = data.recs[id];
      if (e && e.d === 'dismissed') { result = { ok: true, already: true }; return false; }
      if (!e || e.d !== 'needs') { result = httpErr(e && e.d === 'filed' ? 409 : 404, e && e.d === 'filed' ? 'This recording is already saved on a consultation.' : 'This recording is not on the list any more — refresh the page.'); return false; }
      data.recs[id] = { d: 'dismissed', who, at: new Date(io.now()).toISOString(), why: oneLine(why).slice(0, 200), was: { reasonKey: e.reasonKey, candidates: e.candidates, firstSeen: e.firstSeen, fileId: e.fileId, ...(e.tries ? { tries: e.tries } : {}), ...(e.fault ? { fault: e.fault } : {}), ...(Array.isArray(e.tried) && e.tried.length ? { tried: e.tried } : {}) } };
      result = { ok: true, fresh: true };
    });
    if (result instanceof Error) throw result;
    _view.delete(id);
    if (result.fresh) { await traceDismissed(id, true); result = { ok: true }; }
    return result;
  });
}

/**
 * Admin: bring a recording back — a dismissed one returns to the list; one given up on is tried again.
 * Review 2 (2026-11-14): only while the switch is 'on' (it writes the saved list), one at a time with a
 * save of the same recording, and it NEVER erases a started save: the leads noted on the entry (and in
 * the recording's trace) are read first — the recording is on one of them → it is filed there and the
 * restore is refused; one cannot be read → refused, nothing changed; otherwise the note stays on the entry.
 */
async function restore({ otterId } = {}) {
  checkMode();
  const id = s(otterId);
  if (!ID_RE.test(id)) throw httpErr(404, 'Unknown recording.');
  return withBusy(id, async () => {
    const SAVED = 'This recording is saved on a consultation — it cannot be brought back to the list.';
    if (_pending[id]) { await flushPending(); throw httpErr(409, SAVED); }
    const st = await loadState();
    const e = st.data.recs[id];
    if (!e) throw httpErr(404, 'Unknown recording.');
    if (e.d === 'filed') throw httpErr(409, SAVED);
    const NOT_CHECKED = 'It could not be checked just now whether this recording is already on a client — nothing was changed. Try again in a minute.';
    let started;
    try { started = [...new Set([...triedOf(e), ...(await readTrace(id)).leads])]; } catch (_) { throw httpErr(502, NOT_CHECKED); }
    if (started.length) {
      let at;
      try { at = await onAnotherLead(id, '', started); } catch (_) { throw httpErr(502, NOT_CHECKED); }
      if (at) {
        _pending[id] = { d: 'filed', leadId: at, by: 'found', at: new Date(io.now()).toISOString() };
        await flushPending();
        _view.delete(id);
        throw httpErr(409, SAVED);
      }
    }
    let result = null;
    await saveState((data) => {
      const cur = data.recs[id];
      if (!cur) { result = httpErr(404, 'Unknown recording.'); return false; }
      if (cur.d === 'filed') { result = httpErr(409, SAVED); return false; }
      const tried = [...new Set([...started, ...triedOf(cur)])].slice(-MAX_TRIED);
      const was = cur.d === 'dismissed' ? (cur.was || {}) : cur;
      if (cur.d === 'dismissed' && was.fileId) {
        data.recs[id] = { d: 'needs', ...was, ...(tried.length ? { tried } : {}) };
        result = { ok: true, now: 'on the list to match', undismissed: true };
      } else if (tried.length) {
        // read again on the next run — and the leads a save was started on stay noted
        data.recs[id] = { d: 'failed', what: 'read', tries: 0, firstSeen: was.firstSeen, fileId: was.fileId, last: new Date(io.now()).toISOString(), tried };
        result = { ok: true, now: 'will be read again on the next run' };
      } else { delete data.recs[id]; result = { ok: true, now: 'will be read again on the next run' }; }
    });
    if (result instanceof Error) throw result;
    _view.delete(id);
    if (result.undismissed || e.d === 'dismissed') await traceDismissed(id, false);
    delete result.undismissed;
    return result;
  });
}

function status() { return { mode: mode(), running: _running, lastRun: _last }; }

module.exports = {
  mode, runOnce, tick, needsList, assign, dismiss, restore, status, fileOn,
  buildSummaryEntry, buildTranscriptEntry, buildTranscriptLinkEntry, transcriptFileName, transcriptHosts, minutesLong, otterLinkOf, safeErr,
  io, STATE_PATH, TRACE_DIR, MAX_TRIES, MAX_PER_RUN, LIST_PAGES, SNIPPET,
  _reset: () => { _running = false; _busy.clear(); _view.clear(); _hosts.clear(); _hostsAsked = 0; for (const k of pendingIds()) delete _pending[k]; _last = { at: null, mode: 'off', ok: null, outcome: 'not run yet', totals: null }; },
  _busy,
};
