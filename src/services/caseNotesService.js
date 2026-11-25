'use strict';

/**
 * Consultation notes on the CASE page (plan scratchpad case-notes/plan.md, Faran's answers 2026-11-15).
 *
 * One store: the lead's Monday Updates — the same "📝 Consultation notes" entries the consultation record
 * writes (updatesService.postConsultNotes, unchanged). The case page reads the LIVE lead entries, never the
 * frozen "Conversation history imported" copy on the case row. Add only: a note is a new entry.
 *
 *   caseLeadSet(itemId, caseRef)  → the consultations (leads) of one case — the Updates tab uses the SAME set
 *   readLeadEntries(leadId)       → one lead's consultation notes + the Otter entries the app filed (+ pasted
 *                                   Otter summaries), one paged read
 *   readCaseRow(itemId)           → the light access read: the people columns + the consultation copy's
 *                                   Record link, nothing else
 *
 * What it shows (Faran, answer 3): consultation notes and Otter entries ONLY — never lead remarks
 * ("📝 [Remark · …]"), never direct-client "📝 [Note · …]" entries, never system notes.
 * Logs carry ids and counts only — never note text, names or titles.
 */

const mondayApi = require('./mondayApi');
const updates   = require('./updatesService');
const caseAccess = require('./caseAccessService');
const { clientMasterBoardId } = require('../../config/monday');

const s = (v) => String(v == null ? '' : v).trim();
const PAGE = 100;        // Monday's ceiling for one page of an item's updates
const MAX_PAGES = 5;     // 500 entries per lead; past that the card says older entries were not loaded
const MAX_SNAPSHOT_CANDIDATES = 10;

/** On only when CASE_NOTES_PANEL is "on" (read at call time). Off = the case page is exactly as before. */
function enabled() { return s(process.env.CASE_NOTES_PANEL).toLowerCase() === 'on'; }

/* ── the side effects (tests replace them) ──────────────────────────────── */
const io = {
  /** Every lead whose Client Master Item ID is this case — a LIVE Monday query. Throws when Monday fails. */
  findLinked: (itemId) => require('./leadService').findAllByColumnValue('clientMasterItemId', String(itemId)),
  getLead: (id) => require('./leadService').getLead(String(id)),
  /** The shared Lead Board copy as it is (never waits; null when there is none yet). */
  snapshotLeads() { const p = require('./leadSnapshot').peek(); return p ? p.leads : null; },
  query: (q, v) => mondayApi.query(q, v),
  transcriptHosts: () => require('./otterReaderService').transcriptHosts(),
};

/* ── the consultation copy's anchor ─────────────────────────────────────── */
function recordColumnId() {
  try { const c = require('./consultCopyService').columns(); return c ? s(c.record) : ''; } catch (_) { return ''; }
}

/**
 * The light read behind the access check: the case row's people columns and (when the consultation copy is
 * set up) its Record link. Never the questionnaire, the checklist or the notes. Throws when it cannot be read.
 * `extraColumns` (the Emails tab: the client email and the case ref) come back as `texts`, from the SAME read.
 * @returns {Promise<{ assignees: {personIds:string[], teamIds:string[]}, recordUrl: string, texts?: Object<string,string> }>}
 */
async function readCaseRow(itemId, { extraColumns = [] } = {}) {
  if (!/^\d+$/.test(s(itemId))) throw new Error('Invalid item id.');
  const rec = recordColumnId();
  const extra = (Array.isArray(extraColumns) ? extraColumns : []).map(s).filter((c) => /^[a-z0-9_]{1,64}$/.test(c));
  const ids = [...caseAccess.PEOPLE_COLUMNS, ...(rec ? [rec] : []), ...extra.filter((c) => !caseAccess.PEOPLE_COLUMNS.includes(c) && c !== rec)];
  const d = await io.query(
    `query($i:[ID!]){ items(ids:$i, limit:1){ id state board{ id } column_values(ids:${JSON.stringify(ids)}){ id text value } } }`,
    { i: [s(itemId)] }
  );
  const it = d && d.items && d.items[0];
  if (!it) throw new Error('The case row could not be read.');
  const valueByColId = {};
  const textByColId = {};
  for (const c of it.column_values || []) { valueByColId[c.id] = c.value; textByColId[c.id] = c.text; }
  let recordUrl = '';
  // the anchor counts only on a live Client Master row (the same rule as consultCopyService.readCaseRow)
  const live = it.state === 'active' && it.board && s(it.board.id) === s(clientMasterBoardId);
  if (rec && live) { try { recordUrl = s((JSON.parse(valueByColId[rec] || 'null') || {}).url); } catch (_) { recordUrl = ''; } }
  const out = { assignees: caseAccess.assigneesFromColumnValues(valueByColId), recordUrl };
  if (extra.length) out.texts = Object.fromEntries(extra.map((c) => [c, s(textByColId[c])]));   // only when asked (the Emails tab)
  return out;
}

/* ── which consultations belong to the case ─────────────────────────────── */
const sameRef = (a, b) => !!s(a) && s(a).toUpperCase() === s(b).toUpperCase();
function directConsultCaseRef(lead) {
  try { const d = require('../utils/directConsult').optionMarker(lead).detail; return d ? s(d.caseRef) : ''; } catch (_) { return ''; }
}
/** PURE: how a lead reads on the card. */
function kindOf(lead) {
  if (require('../utils/directClient').isDirectClient(lead)) return 'direct-retainer';
  try { if (require('../utils/directConsult').isDirectConsult(lead)) return 'direct-consult'; } catch (_) { /* unreadable marker: an ordinary booking */ }
  return 'booked';
}
/** PURE: the name as compared between claimants — accents, case, punctuation and spacing do not count. */
function nameKey(v) {
  return s(v).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
/**
 * PURE: the anchor lead counts for the case only when it still points at this case — or points at no case
 * and names no other one (its direct-consultation case, or the "Case deleted" mark of another case).
 */
function anchorBelongs(lead, itemId, caseRef) {
  if (!lead) return false;
  const cm = s(lead.clientMasterItemId);
  if (cm) return cm === s(itemId);
  const dc = directConsultCaseRef(lead);
  if (dc && !sameRef(dc, caseRef)) return false;
  const del = s(lead.caseDeleted);
  if (del && !sameRef(del, caseRef)) return false;
  return true;
}
/** PURE: a snapshot lead found by its direct-consultation case, re-checked on the live read. */
function directBelongs(lead, itemId, caseRef) {
  if (!lead || !sameRef(directConsultCaseRef(lead), caseRef)) return false;
  const cm = s(lead.clientMasterItemId);
  return !cm || cm === s(itemId);
}
const whenKey = (l) => s(l.bookedSlot) || s(l.consultationHeld) || s(l.createdAt);

/** `withEmail` (the Emails tab only) adds the lead's email — the notes panel never asks, so it never carries one. */
function shapeLead(lead, via, withEmail = false) {
  return {
    leadId: s(lead.id),
    clientName: s(lead.fullName || lead.name),
    kind: kindOf(lead),
    bookedSlot: s(lead.bookedSlot),
    consultationHeld: s(lead.consultationHeld),
    consultant: s(lead.assignedConsultant),
    clientId: s(lead.clientId),   // the Lead Board "Client ID" copy ('' when none): typed as the Otter title (2026-11-26)
    via,
    ...(withEmail ? { email: s(lead.email) } : {}),
    _when: whenKey(lead),
  };
}

/**
 * PURE: the set's verdict. Two records that name DIFFERENT people may be a mistake (2026-OINP-059), not two
 * consultations — every write is refused then. A record with no name cannot be shown to be the same person.
 */
function claimantsOf(leads) {
  const keys = new Set(leads.map((l) => nameKey(l.clientName) || ('#' + l.leadId)));
  return { multipleClaimants: keys.size > 1, claimantCount: leads.length };
}

/**
 * The consultations of one case, newest first:
 *   1. leads whose Client Master Item ID is this case (LIVE query — a failure throws);
 *   2. leads whose direct-consultation marker names this case (found in the Lead Board copy, which can be
 *      minutes old, then each one read LIVE and kept only if it still names this case and no other case);
 *   3. the lead the consultation copy's Record link names — only while it points at this case, or at no
 *      case and names no other one (the copy keeps its link after a lead moves).
 * Duplicates are removed. `recordUrl` (optional) is the Record link already read with the access check;
 * when it is not given it is read here (one extra read). `withEmail` (the Emails tab only): each lead also
 * carries its `email` — the notes panel never asks for it (and its card whitelists fields anyway).
 * @returns {Promise<{ leads: object[], multipleClaimants: boolean, claimantCount: number, partial: boolean }>}
 */
async function caseLeadSet(itemId, caseRef, { recordUrl, withEmail = false } = {}) {
  const shape = (lead, via) => shapeLead(lead, via, !!withEmail);
  const id = s(itemId);
  if (!/^\d+$/.test(id)) throw new Error('Invalid item id.');
  const out = new Map();
  let partial = false;
  for (const l of (await io.findLinked(id)) || []) if (l && l.id && !out.has(s(l.id))) out.set(s(l.id), shape(l, 'link'));

  // 2. direct consultations for this case
  try {
    const snap = io.snapshotLeads();
    const cands = (snap || []).filter((l) => l && l.id && !out.has(s(l.id)) && sameRef(directConsultCaseRef(l), caseRef)).slice(0, MAX_SNAPSHOT_CANDIDATES);
    for (const c of cands) {
      const live = await io.getLead(c.id);
      if (directBelongs(live, id, caseRef) && !out.has(s(live.id))) out.set(s(live.id), shape(live, 'direct'));
    }
  } catch (err) { partial = true; console.warn(`[CaseNotes] case item ${id}: the direct consultations could not be checked (${err && err.message ? 'read failed' : 'error'})`); }

  // 3. the consultation copy's anchor
  try {
    let url = recordUrl;
    if (url === undefined) url = (await readCaseRow(id)).recordUrl;
    const anchorId = require('./consultCopyService').leadIdOfRecordUrl(url);
    if (anchorId && !out.has(anchorId)) {
      const lead = await io.getLead(anchorId);
      if (lead && s(lead.id) === anchorId && anchorBelongs(lead, id, caseRef)) out.set(anchorId, shape(lead, 'anchor'));
    }
  } catch (err) { partial = true; console.warn(`[CaseNotes] case item ${id}: the consultation copy's record link could not be checked`); }

  const leads = [...out.values()].sort((a, b) => b._when.localeCompare(a._when) || b.leadId.localeCompare(a.leadId))
    .map(({ _when, ...l }) => l);
  return { leads, ...claimantsOf(leads), partial };
}

/* ── one lead's entries ─────────────────────────────────────────────────── */
const PASTED_RE = /^\s*(?:\[([^\]\n]{0,80})\]\s*)?🎙[\s\ufe0f]*Consultation summary \(Otter\)[ \t\u00a0]*\r?\n?/;
const FILED_HEAD_RE = /^🎙[\s\ufe0f]*Consultation summary \(Otter\)(?: \((transcript)(?:, part (\d+) of (\d+))?\))?\s*(?:—\s*(.*))?$/;
const REF_RE = /^Otter (recording|transcript) ref: ([A-Za-z0-9_-]{1,80})$/;

/** PURE: an Otter entry the app filed → its parts (null when it is not one). */
function parseFiledOtter(u, hosts) {
  if (!updates.isFiledOtterEntry(u)) return null;
  const text = updates.htmlToText(u.body).replace(/\r\n?/g, '\n').trim();
  const lines = text.split('\n');
  const head = FILED_HEAD_RE.exec(lines[0].trim());
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last--;
  const ref = REF_RE.exec(lines[last].trim());
  if (!head || !ref) return null;
  const tail = s(head[4]);
  const cut = tail.indexOf(' · ');
  const recorded = cut === -1 ? tail : tail.slice(0, cut);
  const how = cut === -1 ? '' : tail.slice(cut + 3);
  const links = updates.otterLinksOf(text, hosts);
  // the written part: between the heading and the machine lines (the link line above the ref is the app's own)
  let end = last, linkLine = '';
  const above = s(lines[last - 1]);
  if (/^(?:Recording in Otter|Full transcript \(in the client's folder\)): /.test(above)) { end = last - 1; linkLine = above; }
  const body = lines.slice(1, end).join('\n').replace(/^\n+|\n+$/g, '').trim();
  const part = head[1] ? (head[2] ? 'transcript' : 'transcript-link') : 'summary';
  if (ref[1] === 'recording' && part !== 'summary') return null;
  if (ref[1] === 'transcript' && part === 'summary') return null;
  return { id: s(u.id), at: s(u.created_at), otterId: ref[2], part, recorded, how, body, links, linkLine, partNo: Number(head[2]) || 0, partOf: Number(head[3]) || 0 };
}

/** PURE: a summary someone pasted by hand ("[Name] 🎙 Consultation summary (Otter)" …) → { by, body } or null. */
function parsePasted(u) {
  if (updates.isFiledOtterEntry(u)) return null;
  for (const raw of [u && u.body ? updates.htmlToText(u.body) : '', s(u && u.text_body)]) {
    const m = raw && PASTED_RE.exec(raw);
    if (m) return { id: s(u.id), at: s(u.created_at), by: s(m[1]), body: raw.slice(m[0].length).trim() };
  }
  return null;
}

/**
 * PURE: one lead's updates → what the case page shows, oldest first. Notes (typed + pasted Otter summaries)
 * in one list; each Otter recording the app filed as one block (summary, transcript link, transcript part).
 * Every other entry is left out (remarks, direct-client notes, system notes).
 */
function classify(raw, hosts = []) {
  const notes = [];
  const recs = new Map();
  for (const u of raw) {
    const filed = parseFiledOtter(u, hosts);
    if (filed) {
      const r = recs.get(filed.otterId) || { otterId: filed.otterId, at: '', recorded: '', how: '', summary: null, transcriptLink: '', transcript: null };
      if (filed.part === 'summary') {
        r.summary = { id: filed.id, at: filed.at, body: filed.body, links: filed.links };
        r.how = filed.how || r.how;
      } else if (filed.part === 'transcript-link') {
        r.transcriptLink = filed.links[0] || '';
        if (!r.transcriptLink) r.transcriptText = filed.linkLine || filed.body;   // the address stays text when its host is not known
      } else {
        r.transcript = { id: filed.id, at: filed.at, body: filed.body, partNo: filed.partNo, partOf: filed.partOf };
      }
      r.recorded = r.recorded || filed.recorded;
      if (!r.at || filed.at < r.at) r.at = filed.at;
      recs.set(filed.otterId, r);
      continue;
    }
    const n = updates.parseNotesEntry(u);
    if (n) { notes.push({ id: n.id, kind: 'typed', by: n.by, updated: n.updated, body: n.body, at: n.at }); continue; }
    const p = parsePasted(u);
    if (p) notes.push({ id: p.id, kind: 'pasted', by: p.by, updated: false, body: p.body, at: p.at });
  }
  const byAt = (a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id || a.otterId).localeCompare(String(b.id || b.otterId));
  const recordings = [...recs.values()].sort(byAt).map((r) => { const o = { ...r }; if (!o.transcriptText) delete o.transcriptText; return o; });
  return { notes: notes.sort(byAt), recordings };
}

/**
 * One lead's consultation entries, read once (paged past 100, up to MAX_PAGES pages). Throws when the
 * first page cannot be read — the card then says "Could not load notes", never an empty list as if true.
 * @returns {Promise<{ notes: object[], recordings: object[], olderNotLoaded: boolean, read: number, typedKeys: string[] }>}
 */
async function readLeadEntries(leadId, { maxPages = MAX_PAGES } = {}) {
  const id = s(leadId);
  if (!/^\d+$/.test(id)) throw new Error('Invalid item id.');
  const seen = new Map();
  let lastFull = false, pages = 0;
  for (let p = 1; p <= maxPages; p++) {
    const d = await io.query(
      `query($id:[ID!], $p:Int!){ items(ids:$id, limit:1){ id updates(limit:${PAGE}, page:$p){ id text_body body created_at creator{ name } } } }`,
      { id: [id], p }
    );
    const item = d && d.items && d.items[0];
    if (!item) { if (p === 1) { const e = new Error('The consultation record was not found.'); e.notFound = true; throw e; } lastFull = false; break; }
    const ups = item.updates || [];
    pages = p;
    for (const u of ups) if (u && u.id != null && !seen.has(String(u.id))) seen.set(String(u.id), u);
    lastFull = ups.length >= PAGE;
    if (!lastFull) break;
  }
  const raw = [...seen.values()];
  let hosts = [];
  if (raw.some((u) => updates.isFiledOtterEntry(u) && String(u.body).includes('Full transcript (in the client'))) {
    try { hosts = await io.transcriptHosts(); } catch (_) { hosts = []; }
  }
  const out = classify(raw, hosts);
  // the duplicate check's keys of every typed note read (both readings, updatesService's own rule) — never sent to the page
  const typedKeys = raw.map(updates.parseNotesEntry).filter(Boolean).flatMap((n) => n._keys);
  return { ...out, olderNotLoaded: lastFull && pages >= maxPages, read: raw.length, typedKeys };
}

module.exports = {
  enabled, caseLeadSet, readLeadEntries, readCaseRow, classify, parseFiledOtter, parsePasted,
  claimantsOf, nameKey, kindOf, anchorBelongs, directBelongs, io, PAGE, MAX_PAGES,
};
