/**
 * Updates Service — the Monday.com "Updates" thread, surfaced in the platform.
 *
 * Staff asked (2026-08-19) for the same running notes section Monday shows on
 * every item, on each of the platform's detail pages: the system's audit notes
 * (deferrals, reissues, payments) and the team's own comments in one thread,
 * without switching to Monday.
 *
 *   getUpdatesForItem(itemId)        → one item's thread (lead/consult pages)
 *   getCaseThread(caseRef)           → case row + linked lead rows, merged
 *                                      chronologically and tagged by origin
 *   postUpdate(itemId, {body, staffName}) → posts as a normal Monday update,
 *                                      prefixed "[Name]" for attribution (the
 *                                      API always posts as the integration user)
 */

'use strict';

const mondayApi = require('./mondayApi');

const UPDATE_FIELDS = `id text_body body created_at creator{ name } replies{ id text_body created_at creator{ name } }`;

/**
 * PURE: the only addresses of an Otter entry that the page may show as links (review 2026-11-14) — the
 * line the app itself writes right above the machine line that ENDS the entry:
 *   "Recording in Otter: https://otter.ai/…"            above "Otter recording ref: <id>"  (the summary entry)
 *   "Full transcript (in the client's folder): https://<the firm's own host>/…"
 *                                                       above "Otter transcript ref: <id>" (the stored-transcript entry)
 * The Otter link: https and host EXACTLY otter.ai. The transcript link: https and a host in `hosts` — the
 * hosts the app's own OneDrive upload returned (otterReaderService.transcriptHosts). Review 2 (2026-11-14):
 * never "any *.sharepoint.com" — another tenant's site is an outsider's page; with no host known the
 * address stays text. Nothing from the written parts of the entry, nothing from any other entry.
 */
function otterLinksOf(text, hosts = []) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const kind = /^Otter recording ref: [A-Za-z0-9_-]{1,80}$/.test(last) ? 'recording' : /^Otter transcript ref: [A-Za-z0-9_-]{1,80}$/.test(last) ? 'transcript' : '';
  if (!kind || lines.length < 2) return [];
  const allowed = (hosts || []).map((h) => String(h).toLowerCase());
  const host = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.hostname.toLowerCase() : ''; } catch (_) { return ''; } };
  const line = lines[lines.length - 2];
  if (kind === 'recording') {
    const m = /^Recording in Otter: (https:\/\/otter\.ai\/[^\s"'<>\\]*)$/.exec(line);
    return m && host(m[1]) === 'otter.ai' ? [m[1]] : [];
  }
  const m = /^Full transcript \(in the client's folder\): (https:\/\/[^\s"'<>\\]+)$/.exec(line);
  const h = m ? host(m[1]) : '';
  return h && allowed.includes(h) ? [m[1]] : [];
}

/**
 * PURE: is this update an Otter entry THE APP FILED (review 2, 2026-11-14)? It starts with the Otter
 * heading — the same test postOtterEntry makes before it writes — AND carries a machine line. An email
 * note, a typed update or a pasted summary that merely CONTAINS "Otter recording ref: …" is not one:
 * it is read as before (Monday's text) and never gets a link.
 */
function isFiledOtterEntry(u) {
  const raw = String((u && u.body) || '');
  if (!/Otter (?:recording|transcript) ref: /.test(raw)) return false;
  return htmlToText(raw).trimStart().startsWith(htmlToText(OTTER_HEADER));
}

function shape(u, origin, hosts) {
  const otter = isFiledOtterEntry(u);
  const body = (otter ? htmlToText(u.body) : String(u.text_body || '')).trim();
  return {
    id:      String(u.id),
    // An Otter recording the app filed (2026-11-14) is read from its HTML: its line breaks are certain there
    // (Monday's text_body can hand them back collapsed) and each link shows as its address. Every other entry as before.
    // Only such an entry carries otter + links — the page shows links for those and nothing else (otterLinksOf).
    body,
    ...(otter ? { otter: true, links: otterLinksOf(body, hosts) } : {}),
    at:      String(u.created_at || ''),
    by:      (u.creator && u.creator.name) || '',
    origin,  // 'case' | 'lead'
    replies: (u.replies || []).map((r) => ({
      id: String(r.id), body: String(r.text_body || '').trim(),
      at: String(r.created_at || ''), by: (r.creator && r.creator.name) || '',
    })),
  };
}

async function getUpdatesForItem(itemId, { limit = 50, origin = 'lead' } = {}) {
  const d = await mondayApi.query(
    `query($id:[ID!], $n:Int!){ items(ids:$id, limit:1){ updates(limit:$n){ ${UPDATE_FIELDS} } } }`,
    { id: [String(itemId)], n: limit }
  );
  const item = d && d.items && d.items[0];
  const updates = (item && item.updates) || [];
  // the firm's own file host is asked for only when an entry the app filed links a stored transcript
  let hosts = [];
  if (updates.some((u) => isFiledOtterEntry(u) && String(u.body).includes('Full transcript (in the client'))) {
    try { hosts = await require('./otterReaderService').transcriptHosts(); } catch (_) { hosts = []; }
  }
  return updates.map((u) => shape(u, origin, hosts)).filter((u) => u.body);
}

/**
 * The case cockpit's merged thread: the Client Master row's updates plus every
 * linked lead row's (pre-retainer history — consultation, retainer sends).
 * Newest first. Each entry carries its origin so the UI can label it.
 */
async function getCaseThread(caseRef) {
  const htmlQ = require('./htmlQuestionnaireService');
  const { itemId, clientName } = await htmlQ.validateAccessForStaff(String(caseRef).trim(), { skipFormVersioning: true });

  const leadService = require('./leadService');
  const leads = await leadService.findAllByColumnValue('clientMasterItemId', String(itemId)).catch(() => []);

  const threads = await Promise.all([
    getUpdatesForItem(itemId, { origin: 'case' }).catch(() => []),
    ...leads.map((l) => getUpdatesForItem(l.id, { origin: 'lead' }).catch(() => [])),
  ]);
  const merged = threads.flat().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { caseRef: String(caseRef).trim(), cmItemId: String(itemId), clientName, leadIds: leads.map((l) => String(l.id)), updates: merged };
}

// The normal cap, and the "Consultation summary (Otter)" one (step 2, 2026-11-09): an Otter
// summary of a consultation runs to several thousand characters and must show in full.
const MAX_UPDATE = 4000;
const MAX_OTTER = 20000;
const OTTER_HEADER = '🎙 <b>Consultation summary (Otter)</b>';

async function postUpdate(itemId, { body, staffName, kind } = {}) {
  if (kind === 'consultNotes') return postConsultNotes(itemId, { body, staffName });
  const text = String(body == null ? '' : body).trim();
  const name = String(staffName == null ? '' : staffName).trim().slice(0, 60);
  const otter = kind === 'otter';
  const bad = (m) => { const e = new Error(m); e.badRequest = true; throw e; };
  if (!text) bad('Write something first.');
  if (otter && text.length > MAX_OTTER) bad(`A consultation summary is limited to ${MAX_OTTER.toLocaleString('en-CA')} characters.`);
  if (!otter && text.length > MAX_UPDATE) bad(`Updates are limited to ${MAX_UPDATE} characters.`);
  if (!/^\d+$/.test(String(itemId))) bad('Invalid item id.');

  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const prefixed = (name ? `<b>[${esc(name)}]</b> ` : '') + (otter ? `${OTTER_HEADER}<br>` : '') + esc(text).replace(/\r?\n/g, '<br>');
  await mondayApi.query(
    `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(itemId), b: prefixed }
  );
  return { ok: true };
}

// ── Consultation notes (2026-11-10) ─────────────────────────────────────────
// The consultant types notes on the consultation record; "Save notes" posts them as ONE
// labelled update on the lead, the same way as the Otter summary (same cap, same escaping,
// same [Name]). A later correction is a NEW entry headed "Consultation notes (updated)" —
// decided HERE from what is already on the item, never trusted from the page.
// Monday gives no id-based idempotency, so a repeat is caught three ways:
//   1. a save of the same text for the same item still in flight → the second waits for the first;
//   2. the same text saved a moment ago in this process (a Monday read can lag a new update);
//   3. the item's updates already hold a notes entry with the same text ("cannot check → post").
// Do NOT bracket the header ("[Notes…]" / "[Remark…]"): leadStatusService's remark reader and the
// direct-client Notes guard both key on those.
const MAX_CONSULT_NOTES = MAX_OTTER;
const NOTES_LABEL = 'Consultation notes';
const NOTES_UPDATED_LABEL = 'Consultation notes (updated)';
// A notes entry as text: "[Name] 📝 Consultation notes\n…". Read tolerantly: Monday can hand the text back
// with the line breaks collapsed (to a space, or to nothing), so the heading may run straight into the notes.
const NOTES_RE = /^\s*(?:\[([^\]\n]{0,80})\]\s*)?📝[\s️]*Consultation notes( ?\(updated\))?[ \t ]*\r?\n?/;
// Staff-typed entries (these notes, and the Otter summary): free text, so the automations that look for
// marker phrases in a lead's updates ("Consultation held", "Booking invite emailed", …) must skip them.
const STAFF_TYPED_RE = /^\s*(?:\[[^\]\n]{0,80}\]\s*)?(?:📝[\s️]*Consultation notes|🎙[\s️]*Consultation summary \(Otter\))/;
const NOTES_READ_LIMIT = 100;          // Monday's ceiling for an item's updates
const NOTES_RECENT_MS = 2 * 60 * 1000; // the same text again within this = the same save
const NOTES_ITEM_MS = 10 * 60 * 1000;  // "this item got notes a moment ago" (covers a lagging read)
const notesInFlight = new Map();       // item|text → promise
const notesRecent = new Map();         // item|text → ms
const notesItemSaved = new Map();      // item → ms
let notesRetryMs = 1500;               // the wait before looking whether an unanswered save landed (tests set 0)

const escUpdate = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const decodeEntities = (s) => String(s == null ? '' : s)
  .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#(?:39|x27);|&apos;/gi, "'").replace(/&amp;/gi, '&');
/** An update's HTML body as plain text: <br> and block ends are line breaks, tags go, entities are decoded. */
function htmlToText(html) {
  return decodeEntities(String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, ''));
}
// What two texts are compared by: entities decoded and ALL white space dropped — a line break that came back
// as a space, or as nothing, still compares equal. (Two notes that differ only in spacing count as the same.)
const notesKey = (s) => decodeEntities(s).replace(/[\s ﻿]+/g, '');

/** PURE: is this update (text or HTML) a staff-typed consultation entry — notes or the Otter summary? */
function isStaffTypedEntry(textOrHtml) {
  const raw = String(textOrHtml == null ? '' : textOrHtml);
  return STAFF_TYPED_RE.test(raw) || (raw.includes('<') && STAFF_TYPED_RE.test(htmlToText(raw)));
}

function parseNotesEntry(u) {
  // Two readings of the same entry: the HTML body (we wrote it, so its line breaks are certain) and Monday's
  // text_body. The body is preferred; the other is kept for the duplicate check.
  const fromBody = u && u.body ? htmlToText(u.body) : '';
  const fromText = String((u && u.text_body) || '');
  const readings = [fromBody, fromText].map((raw) => { const m = raw && NOTES_RE.exec(raw); return m ? { m, body: raw.slice(m[0].length).trim() } : null; }).filter(Boolean);
  if (!readings.length) return null;
  const { m, body } = readings[0];
  return {
    id: String(u.id || ''),
    by: (m[1] || '').trim(),
    updated: !!m[2],
    body,
    at: String(u.created_at || ''),
    _keys: readings.map((r) => notesKey(r.body)),
  };
}

async function readNotesEntries(itemId) {
  const d = await mondayApi.query(
    `query($id:[ID!], $n:Int!){ items(ids:$id, limit:1){ updates(limit:$n){ id text_body body created_at } } }`,
    { id: [String(itemId)], n: NOTES_READ_LIMIT }
  );
  const item = d && d.items && d.items[0];
  return ((item && item.updates) || []).map(parseNotesEntry).filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** The saved consultation-notes entries on one item, newest first. */
async function getConsultNotes(itemId) {
  return (await readNotesEntries(itemId)).map(({ _keys, ...n }) => n);
}

// The name goes inside "[…]" on the entry, and the reader finds the entry by that shape: a square bracket
// or a line break typed in the name would hide the saved notes from the page and from the duplicate check.
const notesName = (v) => String(v == null ? '' : v).replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim().slice(0, 60);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Posts the entry ONCE per attempt (mondayApi's own retry is switched off: it re-sends a mutation Monday
 * may already have stored). When the answer never came (timeout, dropped connection, 5xx) the record is
 * read before anything is sent again; if it cannot be read, the save fails rather than risk a second copy.
 */
async function sendNotesEntry(id, html, wantKey) {
  for (let attempt = 0; ; attempt++) {
    try {
      await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`, { i: id, b: html }, 0);
      return;
    } catch (err) {
      const status = err && err.response && err.response.status;
      const refused = status === 429 || (!status && !(err && (err.code || err.request || err.isAxiosError)) && /rate|complexity/i.test(String(err && err.message)));
      const unanswered = !refused && (status >= 500 || (!status && !!(err && (err.code || err.request || err.isAxiosError))));
      if (attempt >= 2 || (!refused && !unanswered)) throw err;
      await sleep(notesRetryMs * (attempt + 1));
      if (refused) continue;   // Monday said no: nothing was stored
      let now;
      try { now = await readNotesEntries(id); }
      catch (_) { throw err; }
      if (now.some((n) => n._keys.includes(wantKey))) { console.warn('[Updates] consultation notes: the save was not answered but the entry is on the record — not sent again'); return; }
      console.warn(`[Updates] consultation notes: save not answered and not on the record — sending again (${attempt + 1}/2)`);
    }
  }
}

async function postConsultNotes(itemId, { body, staffName } = {}) {
  // Counted the way the page counts: line ends as one character, outer blanks dropped.
  const text = String(body == null ? '' : body).replace(/\r\n?/g, '\n').trim();
  const name = notesName(staffName);
  const bad = (m) => { const e = new Error(m); e.badRequest = true; throw e; };
  if (!text) bad('Type the consultation notes first.');
  if (text.length > MAX_CONSULT_NOTES) {
    bad(`Consultation notes are limited to ${MAX_CONSULT_NOTES.toLocaleString('en-CA')} characters — this is ${(text.length - MAX_CONSULT_NOTES).toLocaleString('en-CA')} over. Nothing was saved.`);
  }
  if (!/^\d+$/.test(String(itemId))) bad('Invalid item id.');

  const id = String(itemId);
  const want = notesKey(text);
  const key = id + '|' + want;
  const running = notesInFlight.get(key);
  if (running) { await running; return { ok: true, already: true }; }   // the first save's failure is this one's too

  const work = (async () => {
    const now = Date.now();
    for (const [k, t] of notesRecent) if (now - t > NOTES_RECENT_MS) notesRecent.delete(k);
    for (const [k, t] of notesItemSaved) if (now - t > NOTES_ITEM_MS) notesItemSaved.delete(k);
    if (notesRecent.has(key)) return { ok: true, already: true };

    let earlier = null;   // null = could not check → post (a missing entry is worse than a repeated one)
    try { earlier = await readNotesEntries(id); }
    catch (err) { console.warn('[Updates] consultation notes: could not read earlier entries:', err.message); }
    if (earlier && earlier.some((n) => n._keys.includes(want))) {
      notesRecent.set(key, now);
      return { ok: true, already: true };
    }
    const updated = !!(earlier && earlier.length) || notesItemSaved.has(id);
    const header = `📝 <b>${updated ? NOTES_UPDATED_LABEL : NOTES_LABEL}</b>`;
    const prefixed = (name ? `<b>[${escUpdate(name)}]</b> ` : '') + `${header}<br>` + escUpdate(text).replace(/\n/g, '<br>');
    await sendNotesEntry(id, prefixed, want);
    notesRecent.set(key, Date.now());
    notesItemSaved.set(id, Date.now());
    return { ok: true, updated };
  })();
  notesInFlight.set(key, work);
  try { return await work; } finally { notesInFlight.delete(key); }
}

// ── Otter recordings filed by the app (2026-11-14) ──────────────────────────
// A recording the app files on a consultation is ONE update headed like the pasted Otter summary
// (OTTER_HEADER — so isStaffTypedEntry skips it too) that ends with a machine line "Otter recording
// ref: <id>"; a transcript stored or posted for it carries "Otter transcript ref: <id>". Those lines,
// read back from the item's own updates, are the proof that a recording is already there — never a cache.
const OTTER_REF_RE = /Otter (recording|transcript) ref: ([A-Za-z0-9_-]{3,80})/g;

/** PURE: the Otter ids an update's text or HTML carries → adds to { recordings:Set, transcripts:Set }. */
function otterRefsIn(textOrHtml, into = { recordings: new Set(), transcripts: new Set() }) {
  const raw = String(textOrHtml == null ? '' : textOrHtml);
  for (const text of [raw, raw.includes('<') ? htmlToText(raw) : '']) {
    OTTER_REF_RE.lastIndex = 0;
    for (let m; (m = OTTER_REF_RE.exec(text));) (m[1] === 'recording' ? into.recordings : into.transcripts).add(m[2]);
  }
  return into;
}

/** The Otter recordings already on one item, from its own updates. Throws when they cannot be read. */
async function getOtterFiled(itemId) {
  if (!/^\d+$/.test(String(itemId))) throw new Error('Invalid item id.');
  const d = await mondayApi.query(
    `query($id:[ID!], $n:Int!){ items(ids:$id, limit:1){ id updates(limit:$n){ id text_body body } } }`,
    { id: [String(itemId)], n: NOTES_READ_LIMIT }
  );
  const item = d && d.items && d.items[0];
  if (!item) { const e = new Error('The record was not found.'); e.notFound = true; throw e; }
  const out = { recordings: new Set(), transcripts: new Set() };
  for (const u of item.updates || []) { otterRefsIn(u.body, out); otterRefsIn(u.text_body, out); }
  return out;
}

/**
 * Posts one ready-made entry (HTML built and escaped by otterReaderService) ONCE: mondayApi's own retry is
 * off — it could store a second copy. A failure is the caller's to retry, after reading the item again.
 */
async function postOtterEntry(itemId, html) {
  if (!/^\d+$/.test(String(itemId))) throw new Error('Invalid item id.');
  const body = String(html == null ? '' : html);
  if (!body.startsWith(OTTER_HEADER)) throw new Error('Not an Otter entry.');
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`, { i: String(itemId), b: body }, 0);
  return { ok: true };
}

function _resetConsultNotesGuard({ retryMs } = {}) { notesInFlight.clear(); notesRecent.clear(); notesItemSaved.clear(); if (retryMs != null) notesRetryMs = retryMs; }

module.exports = { getUpdatesForItem, getCaseThread, postUpdate, getConsultNotes, isStaffTypedEntry, getOtterFiled, postOtterEntry, otterRefsIn, otterLinksOf, isFiledOtterEntry, htmlToText, MAX_UPDATE, MAX_OTTER, MAX_CONSULT_NOTES, OTTER_HEADER, _resetConsultNotesGuard };
