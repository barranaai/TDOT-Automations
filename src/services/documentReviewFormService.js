/**
 * Document Review Form Service
 *
 * Builds the staff-facing document review page (parallel to the questionnaire
 * review page in htmlQuestionnaireReviewService).
 *
 * What it does:
 *   - Renders all documents for a case grouped by Applicant Member → Category
 *   - Each row shows: name, status badge, last upload date, review notes,
 *     the upload trail (every copy the client sent, newest first, each with
 *     its own OneDrive link — filled in after load from /review/updates),
 *     "Open in OneDrive" button (links to the category folder), and the
 *     Mark Reviewed / Request Rework actions
 *   - Each row carries id="doc-<itemId>" so the cockpit can deep-link to it
 *   - Actions post to /d/:caseRef/review/:itemId/status which updates the
 *     Document Status + Review Notes columns on Monday — the existing
 *     webhook handler (documentReviewService.onColumnChange) then fires
 *     all downstream notifications + escalations + readiness recalc
 *
 * Per the operational decisions made with the supervisor:
 *   - "Open in OneDrive" button per file (no inline preview)
 *   - Every document requires an individual click — no batch "mark all reviewed"
 *     to preserve reviewer accountability
 */

'use strict';

const mondayApi = require('./mondayApi');
const { LOGO_URL } = require('../branding');  // self-hosted logo on the CURRENT public domain

// ─── Column IDs — Document Execution Board ───────────────────────────────────
const EXEC_BOARD_ID    = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const DOC_STATUS_COL   = 'color_mm0zwgvr';
const REVIEW_NOTES_COL = 'long_text_mm0zbpr';
const UPLOAD_DATE_COL     = 'date_mm0zyw0m';     // Last Upload Date — "was a file ever uploaded?"
const CASE_REF_COL     = 'text_mm0z2cck';     // the row's own case — the case note goes nowhere else
const REVIEW_REQUIRED_COL = 'color_mm0z796e';
const DOC_FOLDER_COL   = 'link_mm1yrnz1';

// ─── Lightweight HTML escaping ───────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escJs(s) {
  return String(s == null ? '' : s).replace(/[\\"'`]/g, '\\$&').replace(/\r?\n/g, '\\n');
}

// ─── Status → colour map (matches Monday's labels) ───────────────────────────

const STATUS_STYLE = {
  'Missing':         { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
  'Received':        { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  'Under Review':    { bg: '#eff6ff', fg: '#1e40af', border: '#bfdbfe' },
  'Reviewed':        { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0' },
  'Rework Required': { bg: '#fef2f2', fg: '#991b1b', border: '#fca5a5' },
  'Not Applicable':  { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' },
};

function statusBadge(status) {
  const s   = status || 'Missing';
  const sty = STATUS_STYLE[s] || STATUS_STYLE.Missing;
  return `<span class="status-pill" style="background:${sty.bg};color:${sty.fg};border-color:${sty.border};">${escHtml(s)}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escHtml(iso);
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Look up the Document Folder URL per item (one query, batched) ──────────

/**
 * Fetch the Document Folder OneDrive sharing URL for a list of execution items.
 * Returns a map: itemId → url. Items without a folder link return ''.
 */
async function getFolderLinks(itemIds) {
  const map = {};
  if (!itemIds.length) return map;

  // CHUNKED + explicit limit: items(ids:) silently caps at 25 without one, so
  // a 30+ row checklist lost the folder links on every row past the 25th.
  const CHUNK = 100;
  const allIds = itemIds.map(String);
  const collected = [];
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const batch = allIds.slice(i, i + CHUNK);
    const data = await mondayApi.query(
      `query($ids: [ID!]!, $lim: Int!) {
         items(ids: $ids, limit: $lim) { id column_values(ids: ["${DOC_FOLDER_COL}"]) { id value text } }
       }`,
      { ids: batch, lim: batch.length }
    );
    collected.push(...((data && data.items) || []));
  }

  for (const it of collected) {
    const cv = it.column_values?.[0];
    let url = '';
    try {
      const parsed = JSON.parse(cv?.value || '{}');
      url = parsed?.url || '';
    } catch { /* ignore */ }
    map[it.id] = url || cv?.text || '';
  }
  return map;
}

// ─── Row updates (Monday Updates) — one batched fetch, two readers ──────────
//
// Every execution row carries its own thread of Monday updates: the client's
// replies from the upload form AND the "📄 Document Uploaded by Client" note the
// app posts on every upload. The page wants both, so the fetch is done once and
// each reader is a pure function over one row's updates (easy to test, no I/O).

/**
 * Fetch the most recent updates of many execution items in ONE GraphQL query
 * per chunk. Returns the raw Monday items: [{ id, updates: [...] }].
 */
async function fetchItemUpdates(itemIds, limitPerItem = 25) {
  const ids = (itemIds || []).map(String).filter(Boolean);
  if (!ids.length) return [];

  // Same 25-item cap applies here — chunk and pass an explicit items limit
  // alongside the per-item updates limit.
  const CHUNK = 100;
  const collected = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const data = await mondayApi.query(
      `query($ids: [ID!]!, $limit: Int!, $ilim: Int!) {
         items(ids: $ids, limit: $ilim) {
           id
           updates(limit: $limit) {
             id
             text_body
             created_at
             creator { id name }
           }
         }
       }`,
      { ids: batch, limit: limitPerItem, ilim: batch.length }
    );
    collected.push(...((data && data.items) || []));
  }
  return collected;
}

const REPLY_PREFIX = '\u2709\ufe0f Client Reply';
function isClientReply(u) {
  const t = (u.text_body || '').trim();
  return t.startsWith(REPLY_PREFIX) || t.startsWith('Client Reply');
}

/**
 * Client replies (posted via the upload form) out of one row's updates —
 * [{ id, body, createdAt, author }], most recent first. Only entries whose
 * text_body begins with "✉️ Client Reply" count, so our own auto-posted
 * "Document Uploaded" notes are left out.
 */
function parseReplies(updates) {
  return (updates || [])
    .filter(isClientReply)
    .map(u => {
      // Extract the quoted reply body — format: ... "<reply>" ...
      const raw = (u.text_body || '').trim();
      const m = raw.match(/"([\s\S]+?)"/);
      return {
        id:        u.id,
        body:      (m ? m[1] : raw).trim(),
        createdAt: u.created_at || '',
        author:    u.creator?.name || 'Client',
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// The upload note (documentFormService.postUploadUpdates). Notes from before
// the unique-name change carry only File: / Category: / Case: / Uploaded:;
// newer ones add For:, Named by client: and "🔗 Open this upload: <url>".
// Monday sometimes hands text_body back with the newlines collapsed to spaces,
// so every capture ends at a newline OR at the label that follows it — the
// same shape documentRefileService uses to read File:/Category:.
const UPLOAD_NOTE_RE = /Document Uploaded by Client/i;
const FILE_RE        = /File:\s*([\s\S]+?)\s*(?:\r?\n|Category:)/;
const MEMBER_RE      = /For:\s*([\s\S]+?)\s*(?:\r?\n|Named by client:)/;
const ORIGINAL_RE    = /Named by client:\s*([\s\S]+?)\s*(?:\r?\n|Note:|Warning:|Uploaded:)/;
const LINK_RE        = /Open this upload:\s*(https:\/\/\S+)/;

/**
 * The upload trail of one row out of its updates — every copy the client sent,
 * newest first: [{ id, storedName, originalName, member, url, createdAt }].
 * An old-format note yields url '' (the file was stored under the client's own
 * name, which is what File: carried then) and empty member/originalName.
 * A client reply is never an upload note, whatever the client typed in it.
 */
function parseUploadNotes(updates) {
  const out = [];
  for (const u of updates || []) {
    const body = String(u.text_body || '');
    if (isClientReply(u) || !UPLOAD_NOTE_RE.test(body)) continue;
    const pick = (re) => { const m = body.match(re); return m ? m[1].trim() : ''; };
    out.push({
      id:           u.id,
      storedName:   pick(FILE_RE),
      originalName: pick(ORIGINAL_RE),
      member:       pick(MEMBER_RE),
      url:          pick(LINK_RE),
      createdAt:    u.created_at || '',
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function mapByItem(items, parse) {
  const map = {};
  for (const it of items) map[it.id] = parse(it.updates);
  return map;
}

/**
 * Client replies for many rows: itemId → [{ body, createdAt, author }]
 * (most recent first). Kept for callers that want replies alone.
 */
async function getClientReplies(itemIds, limitPerItem = 25) {
  return mapByItem(await fetchItemUpdates(itemIds, limitPerItem), parseReplies);
}

/**
 * Replies AND the upload trail for many rows from ONE fetch:
 * { replies: { itemId → [...] }, uploads: { itemId → [...] } }.
 */
async function getRowUpdates(itemIds, limitPerItem = 25) {
  const items = await fetchItemUpdates(itemIds, limitPerItem);
  return { replies: mapByItem(items, parseReplies), uploads: mapByItem(items, parseUploadNotes) };
}

// ─── Server actions called from the page (POST handlers in routes file) ─────

/**
 * Mark a document as Reviewed.
 * Updates Document Status on Monday — the existing webhook handler in
 * documentReviewService.onColumnChange picks it up, posts notifications,
 * and triggers a live readiness recalc.
 */
async function markReviewed(itemId, caseRef = '') {
  await refuseIfNotApplicable(itemId, caseRef);
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(EXEC_BOARD_ID),
      itemId:  String(itemId),
      cols:    JSON.stringify({
        [DOC_STATUS_COL]: { label: 'Reviewed' },
      }),
    }
  );
}

/**
 * Mark a document as Rework Required + write the reviewer's notes.
 * Notes go into the Review Notes column; the webhook handler picks both up
 * and triggers (a) escalation to Client Master, (b) queued client revision
 * email, (c) increment of Rework Count, (d) live readiness recalc.
 */
async function requestRework(itemId, notes, caseRef = '') {
  if (!notes || !notes.trim()) {
    throw new Error('Review notes are required when requesting rework.');
  }
  await refuseIfNotApplicable(itemId, caseRef);
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(EXEC_BOARD_ID),
      itemId:  String(itemId),
      cols:    JSON.stringify({
        [REVIEW_NOTES_COL]: notes.trim(),
        [DOC_STATUS_COL]:   { label: 'Rework Required' },
      }),
    }
  );
}

/**
 * Reopen a document — revert a Reviewed / Rework Required back to "Received"
 * (uploaded, awaiting review). Lets a reviewer undo a mis-click WITHOUT emailing
 * the client: the status webhook only recalculates readiness for a "Received"
 * change (no client notification, unlike Rework). Silent, internal correction.
 */
async function reopenDoc(itemId, caseRef = '') {
  await refuseIfNotApplicable(itemId, caseRef);
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(EXEC_BOARD_ID),
      itemId:  String(itemId),
      cols:    JSON.stringify({ [DOC_STATUS_COL]: { label: 'Received' } }),
    }
  );
}

/**
 * Mark a document "Not Applicable" (2026-10-02): staff say it does not exist
 * for this client. Reason REQUIRED; label + reason + Review Required = No go in
 * ONE write, so the status webhook always finds the reason present. The row is
 * never hidden or deleted; a note on the row and on the case records who/why.
 */
/**
 * A Not Applicable row must come back through "Applies again" first — never
 * be overwritten by Mark Reviewed / Request Rework / Undo from a page that was
 * loaded before a colleague marked it (review 2026-10-02). Reads the live
 * status; when the read itself fails the writer proceeds as it always has.
 */
async function refuseIfNotApplicable(itemId, caseRef = '') {
  let cv = null;
  try {
    const d = await mondayApi.query(`query($ids:[ID!]){ items(ids:$ids, limit:1){ column_values(ids:["${DOC_STATUS_COL}","${CASE_REF_COL}"]){ id text } } }`, { ids: [String(itemId)] });
    const item = d?.items?.[0];
    if (!item) console.warn(`[DocReview] status pre-read returned no row for item ${itemId} — proceeding unguarded`);
    else cv = Object.fromEntries((item.column_values || []).map((c) => [c.id, (c.text || '').trim()]));
  } catch (err) { console.warn(`[DocReview] status pre-read failed for item ${itemId}: ${err.message}`); }
  if (!cv) return;
  // A row that names ANOTHER case is refused; a blank ref (legacy row) passes.
  if (caseRef && cv[CASE_REF_COL] && cv[CASE_REF_COL] !== String(caseRef).trim()) {
    throw Object.assign(new Error('That document is not on this case.'), { badRequest: true });
  }
  if (cv[DOC_STATUS_COL] === 'Not Applicable') {
    throw Object.assign(new Error('This document is marked Not Applicable — press "Applies again" first, then reload the page.'), { badRequest: true });
  }
}

/** The row's own case must be the case the caller named — the case note goes nowhere else. */
function assertRowOnCase(rowRef, caseRef) {
  if (!caseRef || String(rowRef || '').trim() !== String(caseRef).trim()) {
    throw Object.assign(new Error('That document is not on this case.'), { badRequest: true });
  }
}

async function markNotApplicable(itemId, reason, staffName, caseRef) {
  const na = require('./documentNotApplicable');
  if (!na.isReady()) throw Object.assign(new Error('"Not applicable" is switched off.'), { badRequest: true });
  const r = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
  if (!r) throw Object.assign(new Error('A reason is required to mark a document not applicable.'), { badRequest: true });
  if (r.length > 300) throw Object.assign(new Error('Keep the reason under 300 characters.'), { badRequest: true });
  // Current status decides: a Rework Required row carries an open escalation and
  // a queued client email — undo first; a Reviewed row is a finished decision.
  const d = await mondayApi.query(`query($ids:[ID!]){ items(ids:$ids, limit:1){ name column_values(ids:["${DOC_STATUS_COL}","${CASE_REF_COL}"]){ id text } } }`, { ids: [String(itemId)] });
  const item = d?.items?.[0];
  if (!item) throw Object.assign(new Error('Document row not found.'), { badRequest: true });
  const cv0 = Object.fromEntries((item.column_values || []).map((c) => [c.id, (c.text || '').trim()]));
  assertRowOnCase(cv0[CASE_REF_COL], caseRef);
  const status = cv0[DOC_STATUS_COL] || 'Missing';
  if (status === 'Rework Required') throw Object.assign(new Error('Press Undo first — this document has an open rework request.'), { badRequest: true });
  if (status === 'Reviewed') throw Object.assign(new Error('This document is already reviewed. Press Undo first if it really does not apply.'), { badRequest: true });
  if (status === na.LABEL) return { already: true };
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    { boardId: String(EXEC_BOARD_ID), itemId: String(itemId),
      cols: JSON.stringify({ [DOC_STATUS_COL]: { label: na.LABEL }, [na.reasonColumnId()]: na.reasonText(r, staffName), [REVIEW_REQUIRED_COL]: { label: 'No' } }) });
  await postDecisionNotes({ itemId, caseRef, docName: item.name, body: `⛔ <b>Document marked Not Applicable</b> — ${escNote(item.name)} — by ${escNote(staffName || 'staff')}, ${escNote(require('../utils/torontoTime').torontoTime(Date.now()))} (Toronto).<br>Reason: ${escNote(r)}${status === 'Received' ? '<br>(A file had been uploaded to this document; it stays in the folder.)' : ''}` });
  return { ok: true };
}

/**
 * "Applies again": undo a Not Applicable. Back to Received when a file was
 * ever uploaded (the reviewer looks again), else the literal "Missing" (the
 * label is on the board and every reader treats it as blank). Clears the
 * reason in the SAME write and posts its own row note, so it never depends
 * on the webhook (whose clean-up is for hand changes and client uploads, and
 * is idempotent: an empty reason means nothing to do).
 */
async function clearNotApplicable(itemId, staffName, caseRef) {
  const na = require('./documentNotApplicable');
  if (!na.isReady()) throw Object.assign(new Error('"Not applicable" is switched off.'), { badRequest: true });
  const d = await mondayApi.query(`query($ids:[ID!]){ items(ids:$ids, limit:1){ name column_values(ids:["${DOC_STATUS_COL}","${UPLOAD_DATE_COL}","${CASE_REF_COL}"]){ id text } } }`, { ids: [String(itemId)] });
  const item = d?.items?.[0];
  if (!item) throw Object.assign(new Error('Document row not found.'), { badRequest: true });
  const cv = Object.fromEntries((item.column_values || []).map((c) => [c.id, (c.text || '').trim()]));
  assertRowOnCase(cv[CASE_REF_COL], caseRef);
  if (cv[DOC_STATUS_COL] !== na.LABEL) return { already: true, status: cv[DOC_STATUS_COL] || 'Missing' };
  const back = cv[UPLOAD_DATE_COL] ? 'Received' : 'Missing';
  const cols = { [DOC_STATUS_COL]: { label: back }, [na.reasonColumnId()]: '' };
  if (back === 'Received') cols[REVIEW_REQUIRED_COL] = { label: 'Yes' };
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    { boardId: String(EXEC_BOARD_ID), itemId: String(itemId), cols: JSON.stringify(cols) });
  await postDecisionNotes({ itemId, caseRef, docName: item.name, body: `↩️ <b>Document applies again</b> — ${escNote(item.name)} — by ${escNote(staffName || 'staff')}, ${escNote(require('../utils/torontoTime').torontoTime(Date.now()))} (Toronto). It is back on the checklist as "${back}"${back === 'Received' ? ' (the file uploaded earlier goes back to the reviewer)' : ''}.` });
  return { ok: true, status: back };
}

const escNote = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** One note on the CASE (and, unless rowNote:false, one on the row). Best effort. */
async function postDecisionNotes({ itemId, caseRef, body, rowNote = true }) {
  const post = (id) => mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`, { i: String(id), b: body });
  if (rowNote) await post(itemId).catch((err) => console.warn(`[DocReview] N/A row note failed for ${itemId}: ${err.message}`));
  if (caseRef) {
    try {
      const cm = await mondayApi.query(
        `query($b:ID!,$v:String!){ items_page_by_column_values(limit:5, board_id:$b, columns:[{column_id:"text_mm142s49", column_values:[$v]}]){ items{ id } } }`,
        { b: String(require('../../config/monday').clientMasterBoardId), v: caseRef });
      for (const it of (cm?.items_page_by_column_values?.items || [])) await post(it.id).catch(() => {});
    } catch (err) { console.warn(`[DocReview] N/A case note failed for ${caseRef}: ${err.message}`); }
  }
}

// ─── HTML page builder ───────────────────────────────────────────────────────

/**
 * @param {Object}   params
 * @param {string}   params.caseRef
 * @param {string}   params.clientName
 * @param {string}   params.staffName
 * @param {Array}    params.items       — from documentFormService.getCaseDocuments()
 * @param {Object}   params.folderLinks — { itemId: oneDriveUrl }
 */
function buildReviewPage({ caseRef, clientName, staffName, items, folderLinks, folderLinksUnavailable }) {
  // Group: applicant member → category → items
  const groups = {};
  for (const it of items) {
    const member = it.applicantLabel || it.applicantType || 'Principal Applicant';
    const cat    = it.category      || 'General';
    if (!groups[member])           groups[member]      = {};
    if (!groups[member][cat])      groups[member][cat] = [];
    groups[member][cat].push(it);
  }

  // Counters for the summary strip
  const total      = items.length;
  const counts     = { received: 0, reviewed: 0, rework: 0, missing: 0, underReview: 0, na: 0 };
  for (const it of items) {
    const s = it.status || 'Missing';
    if (s === 'Received')        counts.received++;
    else if (s === 'Reviewed')   counts.reviewed++;
    else if (s === 'Rework Required') counts.rework++;
    else if (s === 'Under Review')    counts.underReview++;
    else if (s === 'Not Applicable')  counts.na++;
    else                         counts.missing++;
  }
  const naReady = require('./documentNotApplicable').isReady();

  const memberOrder = Object.keys(groups).sort((a, b) =>
    a === 'Principal Applicant' ? -1 : b === 'Principal Applicant' ? 1 : a.localeCompare(b)
  );

  const memberBlocks = memberOrder.map(member => {
    const cats = groups[member];
    const catKeys = Object.keys(cats).sort();

    const catBlocks = catKeys.map(cat => {
      const rows = cats[cat].map(it => rowHtml(it, folderLinks[it.id] || '', { naReady })).join('');
      return `
        <div class="category-block">
          <div class="category-heading">${escHtml(cat)} <span class="cat-count">${cats[cat].length} doc${cats[cat].length === 1 ? '' : 's'}</span></div>
          <div class="rows">${rows}</div>
        </div>`;
    }).join('');

    return `
      <section class="member-block" data-member="${escHtml(member)}">
        <h2 class="member-heading">${escHtml(member)}</h2>
        ${catBlocks}
      </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Review — ${escHtml(caseRef)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #FAF8F4; color: #1F2937; }

    /* Top bar — TDOT brand */
    .top-bar {
      position: sticky; top: 0; z-index: 100;
      background: #0B1D32; color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 28px; gap: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.25);
      border-bottom: 3px solid #C9A84C;
    }
    .top-bar-brand { display: flex; align-items: center; gap: 14px; }
    .top-bar-brand img { height: 34px; object-fit: contain; }
    .top-bar-left h1 { font-size: 16px; font-weight: 700; }
    .top-bar-left p  { font-size: 12px; color: rgba(255,255,255,.65); margin-top: 2px; }
    .staff-badge     {
      font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 999px;
      background: rgba(201,168,76,.18); color: #C9A84C; border: 1px solid rgba(201,168,76,.35);
      letter-spacing: .04em;
    }

    /* Content */
    .content { max-width: 1100px; margin: 28px auto; padding: 0 20px 80px; }

    .summary-card {
      background: #FFFFFF; border-radius: 12px; padding: 18px 24px;
      box-shadow: 0 1px 8px rgba(11,29,50,.06); margin-bottom: 24px;
      border: 1px solid #E7E2D6;
      display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
    }
    .summary-stat { text-align: center; min-width: 80px; }
    .summary-stat .num { font-size: 26px; font-weight: 800; color: #0B1D32; line-height: 1.1; }
    .summary-stat .lbl { font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; }
    .summary-stat.received .num { color: #92400e; }
    .summary-stat.reviewed .num { color: #166534; }
    .summary-stat.rework   .num { color: #8B0000; }
    .summary-stat.missing  .num { color: #6B7280; }
    .summary-stat.na       .num { color: #94a3b8; }
    .doc-row[data-status="Not Applicable"] { opacity: .72; }
    .doc-row[data-status="Not Applicable"] .name { color: #64748b; }
    .na-reason { margin-top: 6px; font-size: 12px; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; }
    .btn-na { background: #fff; color: #475569; border: 1px solid #cbd5e1; }
    .btn-na:hover:not(:disabled) { background: #f1f5f9; }
    .btn-applies { background: #fff; color: #1d4ed8; border: 1px solid #93c5fd; }
    .btn-applies:hover:not(:disabled) { background: #eff6ff; }
    #na-modal textarea { width: 100%; min-height: 72px; }
    .summary-divider { width: 1px; height: 36px; background: #E7E2D6; }

    /* Filter strip */
    .filter-strip {
      display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px;
    }
    .filter-btn {
      padding: 6px 14px; font-size: 12px; font-weight: 600; border: 1px solid #E7E2D6;
      background: #FFFFFF; color: #6B7280; border-radius: 999px; cursor: pointer;
      transition: all .12s;
    }
    .filter-btn:hover { background: #F4F0E6; }
    .filter-btn.active { background: #8B0000; color: #fff; border-color: #8B0000; }

    /* Member + category blocks */
    .member-block { margin-bottom: 28px; }
    .member-heading {
      font-size: 17px; font-weight: 700; color: #0B1D32;
      padding-bottom: 8px; margin-bottom: 14px;
      border-bottom: 2px solid #C9A84C;
    }
    .category-block {
      background: #FFFFFF; border-radius: 12px; margin-bottom: 16px;
      box-shadow: 0 1px 8px rgba(11,29,50,.06); border: 1px solid #E7E2D6; overflow: hidden;
    }
    .category-heading {
      font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #6B7280;
      background: #F4F0E6; border-bottom: 1px solid #E7E2D6;
      padding: 10px 18px; display: flex; align-items: center; justify-content: space-between;
    }
    .cat-count {
      font-size: 11px; font-weight: 600; color: #8B0000; text-transform: none; letter-spacing: 0;
    }

    /* Document row */
    .doc-row {
      display: grid; grid-template-columns: 1fr 140px 240px;
      gap: 16px; align-items: start; padding: 14px 18px;
      border-bottom: 1px solid #f1f5f9;
    }
    .doc-row:last-child { border-bottom: none; }
    .doc-row[data-status="Reviewed"]        { background: #f0fdf4; }
    .doc-row[data-status="Rework Required"] { background: #fef2f2; }
    /* A row opened by its #doc-<id> anchor (the cockpit's 📎 Files link) must
       clear the sticky top bar and stand out for a moment. */
    .doc-row { scroll-margin-top: 84px; }
    .doc-row:target { outline: 2px solid #C9A84C; outline-offset: -2px; }

    .doc-meta .name {
      font-size: 14px; font-weight: 600; color: #1e293b; line-height: 1.4;
    }
    .doc-meta .desc {
      font-size: 12px; color: #64748b; margin-top: 4px; line-height: 1.45;
      max-width: 600px;
    }
    .doc-meta .upload-date {
      font-size: 11px; color: #94a3b8; margin-top: 6px;
    }
    .doc-meta .doc-guide {
      margin-top: 8px; padding: 8px 10px;
      background: #f8fafc; border-left: 3px solid #cbd5e1;
      border-radius: 4px; font-size: 12px; color: #475569;
      line-height: 1.55; max-width: 640px;
    }
    .doc-meta .doc-guide ul { margin: 2px 0 0 16px; padding: 0; }
    .doc-meta .doc-guide li { margin: 3px 0; }
    .doc-meta .doc-guide a { color: #1d4ed8; }
    .doc-meta .review-notes {
      margin-top: 8px; padding: 8px 10px;
      background: #fef2f2; border-left: 3px solid #fca5a5;
      border-radius: 4px; font-size: 12px; color: #7f1d1d;
      line-height: 1.5; max-width: 600px;
    }
    .doc-meta .review-notes strong { color: #991b1b; }
    /* Upload trail — every copy the client sent, newest first */
    .doc-meta .upload-line {
      margin-top: 6px; font-size: 12px; color: #334155; line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .doc-meta .upload-line a { color: #1d4ed8; font-weight: 600; }
    .doc-meta .upload-line .upload-when, .doc-meta .upload-line .upload-sent { color: #64748b; }
    .doc-meta .upload-earlier { margin-top: 2px; }
    .doc-meta .upload-earlier summary {
      cursor: pointer; font-size: 11px; color: #64748b; font-weight: 600; list-style: none;
    }
    .doc-meta .upload-earlier summary::-webkit-details-marker { display: none; }
    .doc-meta .upload-earlier .upload-line { margin-left: 18px; color: #64748b; }
    .doc-meta .client-reply {
      margin-top: 6px; padding: 8px 10px;
      background: #eff6ff; border-left: 3px solid #93c5fd;
      border-radius: 4px; font-size: 12px; color: #1e3a8a; line-height: 1.5;
    }
    .doc-meta .client-reply + .client-reply { margin-top: 4px; }
    .doc-meta .client-reply .reply-meta {
      display: block; font-size: 10px; color: #64748b;
      margin-bottom: 4px; font-weight: 600;
    }
    .doc-meta .replies-placeholder {
      margin-top: 6px; padding: 8px 10px;
      background: #f8fafc; border-left: 3px solid #cbd5e1;
      border-radius: 4px; font-size: 11px; color: #94a3b8;
      font-style: italic;
    }
    .doc-meta .replies-placeholder::before {
      content: ''; display: inline-block; width: 10px; height: 10px;
      border: 2px solid #cbd5e1; border-top-color: #64748b;
      border-radius: 50%; margin-right: 6px; vertical-align: middle;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Replies status pill at top */
    .replies-status {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 14px; margin-bottom: 14px;
      background: #eff6ff; color: #1e3a8a;
      border: 1px solid #bfdbfe; border-radius: 999px;
      font-size: 12px; font-weight: 600;
    }
    .replies-status.error { background: #fef2f2; color: #991b1b; border-color: #fca5a5; }
    .replies-status.error .replies-spinner { display: none; }
    .replies-status .replies-retry {
      margin-left: 6px; color: #991b1b; text-decoration: underline; cursor: pointer;
      background: none; border: none; font: inherit; padding: 0;
    }
    .replies-spinner {
      width: 12px; height: 12px;
      border: 2px solid #bfdbfe; border-top-color: #1e3a8a;
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }

    .status-cell {
      text-align: center;
    }
    .status-pill {
      display: inline-block; padding: 4px 10px; border-radius: 999px;
      font-size: 11px; font-weight: 700; border: 1px solid;
    }

    .actions-cell {
      display: flex; flex-direction: column; gap: 6px; align-items: stretch;
    }
    .btn {
      padding: 7px 12px; border: 1px solid; border-radius: 6px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: all .12s; text-align: center; text-decoration: none;
      display: inline-flex; justify-content: center; align-items: center; gap: 6px;
    }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn-onedrive {
      background: #fff; color: #0078d4; border-color: #0078d4;
    }
    .btn-onedrive:hover { background: #eff6ff; }
    .btn-reviewed {
      background: #059669; color: #fff; border-color: #059669;
    }
    .btn-reviewed:hover:not(:disabled) { background: #047857; }
    .btn-rework {
      background: #fff; color: #8B0000; border-color: #8B0000;
    }
    .btn-rework:hover:not(:disabled) { background: #FAF1F1; }
    .btn-undo {
      background: #fff; color: #475569; border-color: #cbd5e1;
    }
    .btn-undo:hover:not(:disabled) { background: #f1f5f9; }

    /* Rework modal */
    .modal-bg {
      position: fixed; inset: 0; background: rgba(15,23,42,.5);
      display: none; align-items: center; justify-content: center; z-index: 200;
    }
    .modal-bg.open { display: flex; }
    .modal {
      background: #fff; border-radius: 12px; padding: 22px 24px;
      max-width: 520px; width: calc(100% - 32px);
      box-shadow: 0 20px 50px rgba(0,0,0,.3);
    }
    .modal h3 { font-size: 16px; color: #0B1D32; margin-bottom: 4px; }
    .modal .sub { font-size: 12px; color: #6B7280; margin-bottom: 14px; }
    .modal textarea {
      width: 100%; min-height: 110px; resize: vertical;
      border: 1px solid #E7E2D6; border-radius: 6px; padding: 10px;
      font-family: inherit; font-size: 13px; line-height: 1.5;
    }
    .modal textarea:focus { outline: none; border-color: #8B0000; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .btn-cancel { background: #fff; color: #6B7280; border-color: #E7E2D6; padding: 8px 16px; }
    .btn-confirm { background: #8B0000; color: #fff; border-color: #8B0000; padding: 8px 16px; }

    /* Toast */
    #toast {
      position: fixed; bottom: 24px; right: 24px; z-index: 300;
      padding: 12px 18px; border-radius: 8px;
      background: #0B1D32; color: #fff; font-size: 13px;
      box-shadow: 0 10px 30px rgba(0,0,0,.3);
      transform: translateY(100px); opacity: 0; transition: all .25s;
      max-width: 360px;
    }
    #toast.show { transform: translateY(0); opacity: 1; }
    #toast.error { background: #8B0000; }

    @media (max-width: 800px) {
      .doc-row { grid-template-columns: 1fr; gap: 10px; }
      .actions-cell { flex-direction: row; flex-wrap: wrap; }
    }
  </style>
</head>
<body>

  <header class="top-bar">
    <div class="top-bar-brand">
      <img style="background:#fff;padding:3px 6px;border-radius:6px;" src="${LOGO_URL}" alt="TDOT Immigration">
      <div class="top-bar-left">
        <h1>📂 Document Review — ${escHtml(caseRef)}</h1>
        <p>${escHtml(clientName || 'Unknown Client')}</p>
      </div>
    </div>
    <div class="staff-badge">Reviewing as ${escHtml(staffName || 'Staff')}</div>
  </header>

  <main class="content">
${folderLinksUnavailable ? '<div style="background:#fef3cd;border:1px solid #d97706;color:#7c2d12;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px">\u26a0\ufe0f The OneDrive folder links could not be loaded just now (temporary issue). Document review still works \u2014 reload the page to restore the “Open in OneDrive” buttons.</div>' : ''}
    <div class="summary-card">
      <div class="summary-stat"><div class="num">${total}</div><div class="lbl">Total</div></div>
      <div class="summary-divider"></div>
      <div class="summary-stat received"><div class="num">${counts.received}</div><div class="lbl">Received</div></div>
      <div class="summary-stat reviewed"><div class="num">${counts.reviewed}</div><div class="lbl">Reviewed</div></div>
      <div class="summary-stat rework"><div class="num">${counts.rework}</div><div class="lbl">Rework</div></div>
      <div class="summary-stat missing"><div class="num">${counts.missing + counts.underReview}</div><div class="lbl">Pending</div></div>
      <div class="summary-stat na"><div class="num">${counts.na}</div><div class="lbl">N/A</div></div>
    </div>

    <div class="filter-strip">
      <button class="filter-btn active" data-filter="all">All (${total})</button>
      <button class="filter-btn" data-filter="Received">Received (${counts.received})</button>
      <button class="filter-btn" data-filter="Reviewed">Reviewed (${counts.reviewed})</button>
      <button class="filter-btn" data-filter="Rework Required">Rework (${counts.rework})</button>
      <button class="filter-btn" data-filter="Missing">Missing (${counts.missing})</button>
      <button class="filter-btn" data-filter="Not Applicable">N/A (${counts.na})</button>
    </div>

    <div id="replies-status" class="replies-status" style="display:none;">
      <span class="replies-spinner"></span>
      <span id="replies-status-text">💬 Loading client replies and uploads…</span>
    </div>

    ${memberBlocks || '<p style="text-align:center;color:#94a3b8;padding:60px;">No documents found for this case.</p>'}

  </main>

  ${naReady ? `<!-- Not Applicable modal (staff only; reason required) -->
  <div class="modal-bg" id="na-modal">
    <div class="modal">
      <h3>Mark as Not Applicable</h3>
      <p class="sub" id="na-modal-sub"></p>
      <p class="sub">Only for a document that does not exist for this client (e.g. "client is single", "no previous refusal"). A file received by email is uploaded into the row instead. The client sees the document as "not needed".</p>
      <textarea id="na-reason" placeholder="Reason (required, shown to staff on the row)" maxlength="300"></textarea>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeNaModal()">Cancel</button>
        <button class="btn btn-na" id="na-confirm-btn" onclick="confirmNotApplicable()">⊘ Mark Not Applicable</button>
      </div>
    </div>
  </div>` : ''}

  <!-- Rework modal -->
  <div class="modal-bg" id="modal-bg">
    <div class="modal">
      <h3>Request Rework</h3>
      <p class="sub" id="modal-sub"></p>
      <textarea id="rework-notes" placeholder="Explain to the client what needs to be corrected. This text will be sent to them by email and shown in their upload form."></textarea>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn btn-confirm" id="confirm-btn" onclick="confirmRework()">Send Rework Request</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    var CASE_REF = ${JSON.stringify(caseRef)};
    var _modalItemId = null;

    function showToast(msg, isError) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.toggle('error', !!isError);
      t.classList.add('show');
      setTimeout(function () { t.classList.remove('show'); }, 3500);
    }

    /* ── Filter ── */
    document.querySelectorAll('.filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var f = btn.getAttribute('data-filter');
        document.querySelectorAll('.doc-row').forEach(function (row) {
          var s = row.getAttribute('data-status');
          if (f === 'all' || s === f || (f === 'Missing' && (!s || s === 'Missing'))) {
            row.style.display = '';
          } else {
            row.style.display = 'none';
          }
        });
        // Hide empty category/member blocks after filter
        document.querySelectorAll('.category-block').forEach(function (cb) {
          var visible = Array.from(cb.querySelectorAll('.doc-row')).some(function (r) { return r.style.display !== 'none'; });
          cb.style.display = visible ? '' : 'none';
        });
        document.querySelectorAll('.member-block').forEach(function (mb) {
          var visible = Array.from(mb.querySelectorAll('.category-block')).some(function (c) { return c.style.display !== 'none'; });
          mb.style.display = visible ? '' : 'none';
        });
      });
    });

    /* ── Shared: update a row's status pill + button states in place ── */
    var STATUS_STYLE = {
      'Reviewed':        { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0' },
      'Rework Required': { bg: '#fef2f2', fg: '#991b1b', border: '#fca5a5' },
      'Received':        { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
      'Missing':         { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' },
      'Not Applicable':  { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' }
    };
    function setRowStatus(row, status) {
      if (!row) return;
      row.setAttribute('data-status', status);
      var pill = row.querySelector('.status-pill');
      if (pill) {
        var c = STATUS_STYLE[status] || STATUS_STYLE['Received'];
        pill.textContent = status;
        pill.style.background = c.bg; pill.style.color = c.fg; pill.style.borderColor = c.border;
      }
      var isNA = status === 'Not Applicable';
      var isReviewed = status === 'Reviewed', isRework = status === 'Rework Required', noUpload = status === 'Missing' || isNA;
      var rv = row.querySelector('.btn-reviewed'), rw = row.querySelector('.btn-rework'), ud = row.querySelector('.btn-undo');
      if (rv) rv.disabled = isReviewed || noUpload;
      if (rw) rw.disabled = isRework   || noUpload;
      if (ud) ud.disabled = !(isReviewed || isRework);
      var na = row.querySelector('.btn-na'), ap = row.querySelector('.btn-applies');
      if (na) na.disabled = !(status === 'Missing' || status === 'Received');
      if (ap) ap.disabled = !isNA;
    }

    /* ── Not Applicable: reason required, staff only (2026-10-02) ── */
    var _naItemId = null;
    function openNaModal(btn) {
      _naItemId = btn.getAttribute('data-id');
      document.getElementById('na-reason').value = '';
      document.getElementById('na-modal-sub').textContent = 'Document: ' + (btn.getAttribute('data-name') || '');
      document.getElementById('na-modal').classList.add('open');
      setTimeout(function () { document.getElementById('na-reason').focus(); }, 60);
    }
    function closeNaModal() {
      document.getElementById('na-modal').classList.remove('open');
      _naItemId = null;
    }
    async function confirmNotApplicable() {
      if (!_naItemId) return;
      var reason = document.getElementById('na-reason').value.trim();
      if (!reason) { showToast('A reason is required.', true); return; }
      var b = document.getElementById('na-confirm-btn');
      b.disabled = true; b.textContent = 'Saving…';
      try {
        var res = await fetch('/d/' + encodeURIComponent(CASE_REF) + '/review/' + encodeURIComponent(_naItemId) + '/status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'not_applicable', reason: reason })
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');
        closeNaModal();
        location.reload();   // the row's reason block, buttons and counts come from the server
      } catch (err) {
        showToast('✗ ' + (err.message || 'Failed'), true);
      } finally {
        b.disabled = false; b.textContent = '⊘ Mark Not Applicable';
      }
    }
    async function appliesAgain(btn) {
      var itemId = btn.getAttribute('data-id');
      if (!window.confirm('Put this document back on the checklist? The client will see it as needed again (no email is sent).')) return;
      btn.disabled = true;
      try {
        var res = await fetch('/d/' + encodeURIComponent(CASE_REF) + '/review/' + encodeURIComponent(itemId) + '/status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'applies_again' })
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');
        showToast('↩ Back on the checklist as ' + (data.status || 'Missing'));
        location.reload();
      } catch (err) {
        btn.disabled = false;
        showToast('✗ ' + (err.message || 'Failed'), true);
      }
    }

    /* ── Undo / reopen to pending — reverts to Received, NO client email ── */
    async function undoReview(itemId, btn) {
      btn.disabled = true;
      try {
        var res = await fetch('/d/' + encodeURIComponent(CASE_REF) + '/review/' + encodeURIComponent(itemId) + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'received' }),
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');
        var row = btn.closest('.doc-row');
        setRowStatus(row, 'Received');
        if (row) { var n = row.querySelector('.review-notes'); if (n) n.remove(); }
        showToast('↺ Reopened — back to pending review');
      } catch (err) {
        btn.disabled = false;
        showToast('✗ ' + (err.message || 'Failed to reopen'), true);
      }
    }

    /* ── Mark Reviewed ── */
    async function markReviewed(itemId, btn) {
      btn.disabled = true;
      try {
        var res = await fetch('/d/' + encodeURIComponent(CASE_REF) + '/review/' + encodeURIComponent(itemId) + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reviewed' }),
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');
        showToast('✓ Marked as Reviewed');
        // Update DOM in place — status pill + button states (enables Undo).
        setRowStatus(btn.closest('.doc-row'), 'Reviewed');
      } catch (err) {
        btn.disabled = false;
        showToast('✗ ' + (err.message || 'Failed to mark reviewed'), true);
      }
    }

    /* ── Open Rework Modal ── */
    function openRework(btn) {
      _modalItemId = btn.getAttribute('data-id');
      document.getElementById('rework-notes').value = '';
      document.getElementById('modal-sub').textContent = 'Document: ' + (btn.getAttribute('data-name') || '');
      document.getElementById('modal-bg').classList.add('open');
      setTimeout(function () { document.getElementById('rework-notes').focus(); }, 60);
    }

    function closeModal() {
      document.getElementById('modal-bg').classList.remove('open');
      _modalItemId = null;
    }

    async function confirmRework() {
      if (!_modalItemId) return;
      var notes = document.getElementById('rework-notes').value.trim();
      if (!notes) { showToast('Notes are required for rework requests.', true); return; }

      var confirmBtn = document.getElementById('confirm-btn');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Sending…';

      try {
        var res = await fetch('/d/' + encodeURIComponent(CASE_REF) + '/review/' + encodeURIComponent(_modalItemId) + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rework', notes: notes }),
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');

        // Update the row in place
        var row = document.querySelector('.doc-row[data-item-id="' + _modalItemId + '"]');
        if (row) {
          setRowStatus(row, 'Rework Required'); // enables Undo, disables Request Rework
          // Inject the new review note inline
          var meta = row.querySelector('.doc-meta');
          if (meta) {
            var existing = meta.querySelector('.review-notes');
            if (existing) existing.remove();
            var note = document.createElement('div');
            note.className = 'review-notes';
            note.innerHTML = '<strong>📝 Your rework request:</strong> ' + notes.replace(/[<>&]/g, function (c) { return ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' })[c]; });
            meta.appendChild(note);
          }
        }
        closeModal();
        showToast('✓ Rework requested — client will be notified by email');
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Send Rework Request';
        showToast('✗ ' + (err.message || 'Failed to request rework'), true);
      }
    }

    // Close modal on outside click + Esc key
    document.getElementById('modal-bg').addEventListener('click', function (e) {
      if (e.target.id === 'modal-bg') closeModal();
    });
    var naModal = document.getElementById('na-modal');
    function naSaving() { var b = document.getElementById('na-confirm-btn'); return !!(b && b.disabled); }   // never discard a reason mid-save
    if (naModal) naModal.addEventListener('click', function (e) { if (e.target.id === 'na-modal' && !naSaving()) closeNaModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeModal(); if (naModal && !naSaving()) closeNaModal(); }
    });

    /* ── Client replies (progressive enrichment) ────────────────────────── */
    function escText(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtWhen(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var diffMs = Date.now() - d.getTime();
      var mins = Math.floor(diffMs / 60000);
      if (mins < 1)  return 'just now';
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24)  return hrs + 'h ago';
      var days = Math.floor(hrs / 24);
      if (days < 7)  return days + 'd ago';
      return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function showReplyPlaceholders() {
      document.querySelectorAll('.replies-slot').forEach(function (slot) {
        slot.innerHTML = '<div class="replies-placeholder">Checking for client replies…</div>';
      });
    }

    function clearReplyPlaceholders() {
      document.querySelectorAll('.replies-slot .replies-placeholder').forEach(function (p) { p.remove(); });
    }

    function renderReplies(repliesByItem) {
      document.querySelectorAll('.replies-slot').forEach(function (slot) {
        slot.innerHTML = '';
        var id = slot.getAttribute('data-item-id');
        var list = (repliesByItem && repliesByItem[id]) || [];
        if (!list.length) return;
        list.forEach(function (r) {
          var div = document.createElement('div');
          div.className = 'client-reply';
          div.innerHTML =
            '<span class="reply-meta">💬 ' + escText(r.author || 'Client') +
            (r.createdAt ? ' · ' + escText(fmtWhen(r.createdAt)) : '') + '</span>' +
            escText(r.body || '');
          slot.appendChild(div);
        });
      });
    }

    /* ── Upload trail: every copy the client sent, newest first ──────────
       Each entry is one "Document Uploaded by Client" note on the row. Only
       an https link becomes a hyperlink (the old notes carry none — that file
       is in the folder under the client's own name); every value is escaped. */
    function uploadLine(u) {
      var name = escText(u.storedName || '(file name not recorded)');
      var link = (typeof u.url === 'string' && u.url.indexOf('https://') === 0)
        ? '<a href="' + escText(u.url) + '" target="_blank" rel="noopener">' + name + '</a>'
        : name;
      var when = fmtWhen(u.createdAt);
      var sentAs = (u.originalName && u.originalName !== u.storedName)
        ? ' · <span class="upload-sent">sent as ' + escText(u.originalName) + '</span>'
        : '';
      return '<div class="upload-line">📎 ' + link +
        (when ? ' · <span class="upload-when">' + escText(when) + '</span>' : '') + sentAs + '</div>';
    }

    function renderUploads(uploadsByItem) {
      document.querySelectorAll('.uploads-slot').forEach(function (slot) {
        slot.innerHTML = '';
        var id = slot.getAttribute('data-item-id');
        var list = (uploadsByItem && uploadsByItem[id]) || [];
        if (!list.length) return;
        var html = uploadLine(list[0]);
        if (list.length > 1) {
          html += '<details class="upload-earlier"><summary>' + (list.length - 1) +
            ' earlier ▸</summary>' + list.slice(1).map(uploadLine).join('') + '</details>';
        }
        slot.innerHTML = html;
      });
    }

    function showRepliesError(msg) {
      var bar = document.getElementById('replies-status');
      var txt = document.getElementById('replies-status-text');
      if (!bar || !txt) return;
      bar.classList.add('error');
      txt.innerHTML = '⚠️ ' + escText(msg || 'Could not load replies.') +
        ' <button class="replies-retry" onclick="loadClientReplies()">Retry</button>';
      bar.style.display = 'inline-flex';
      // Also clear per-row placeholders so they don't spin forever
      clearReplyPlaceholders();
    }

    async function loadClientReplies() {
      var bar = document.getElementById('replies-status');
      var txt = document.getElementById('replies-status-text');
      if (bar) {
        bar.classList.remove('error');
        bar.style.display = 'inline-flex';
      }
      if (txt) txt.textContent = '💬 Loading client replies and uploads…';
      showReplyPlaceholders();
      try {
        var res = await fetch('/d/' + encodeURIComponent(CASE_REF) + '/review/updates', {
          headers: { 'Accept': 'application/json' },
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        renderReplies(data.replies || {});
        renderUploads(data.uploads || {});
        if (bar) bar.style.display = 'none';
      } catch (err) {
        showRepliesError(err && err.message ? err.message : 'Fetch failed');
      }
    }

    // Kick off on load — page stays fully interactive while this runs
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadClientReplies);
    } else {
      loadClientReplies();
    }
  </script>

</body>
</html>`;
}

/**
 * Render a single document row.
 */
function rowHtml(it, folderUrl, { naReady = false } = {}) {
  const status = it.status || 'Missing';
  // Buttons disabled when in a terminal state OR when there's nothing to review
  const isReviewed = status === 'Reviewed';
  const isRework   = status === 'Rework Required';
  const isNA       = status === 'Not Applicable';
  const noUpload   = status === 'Missing' || isNA;

  const reviewedDisabled = isReviewed || noUpload ? 'disabled' : '';
  const reworkDisabled   = isRework   || noUpload ? 'disabled' : '';
  // Undo is available only once a decision has been made (Reviewed / Rework);
  // it reverts to "Received" without emailing the client — a silent mis-click fix.
  const undoDisabled     = (isReviewed || isRework) ? '' : 'disabled';
  // "Doesn't apply": Missing or Received rows only (a Rework row has an open
  // escalation + a queued client email — Undo first; Reviewed is a decision).
  const naDisabled       = (status === 'Missing' || status === 'Received') ? '' : 'disabled';
  const na = require('./documentNotApplicable');
  const naBlock = isNA
    ? `<div class="na-reason">⊘ <strong>Not applicable:</strong> ${escHtml(na.reasonOnly(it.naReason) || '(no reason recorded — please add one in Monday)')}${na.reasonBy(it.naReason) ? ` <span style="color:#94a3b8">— ${escHtml(na.reasonBy(it.naReason))}</span>` : ''}</div>`
    : '';
  const naButtons = naReady
    ? (isNA
      ? `<button class="btn btn-applies" data-id="${escHtml(it.id)}" onclick="appliesAgain(this)" title="Put this document back on the checklist (no email to the client)">↩ Applies again</button>`
      : `<button class="btn btn-na" ${naDisabled} data-id="${escHtml(it.id)}" data-name="${escHtml(it.name)}" onclick="openNaModal(this)" title="This document does not exist for this client — a reason is required">⊘ Doesn't apply</button>`)
    : '';

  const folderBtn = folderUrl
    ? `<a class="btn btn-onedrive" href="${escHtml(folderUrl)}" target="_blank" rel="noopener">📁 Open in OneDrive</a>`
    : `<button class="btn btn-onedrive" disabled title="No OneDrive folder linked yet">📁 Open in OneDrive</button>`;

  // Review Notes are deliberately NOT cleared when the client uploads again —
  // the note is the reviewer's yardstick for the new copy. On a Received row
  // the note therefore predates at least one upload, but which one is not for
  // the label to claim: the 📎 upload trail under it is the evidence.
  const noteLabel = status === 'Received'
    ? '📝 Review note on file (row is Received — see the upload trail below):'
    : '📝 Existing review note:';
  const noteBlock = it.reviewNotes
    ? `<div class="review-notes"><strong>${noteLabel}</strong> ${escHtml(it.reviewNotes)}</div>`
    : '';

  const dateBlock = it.lastUpload
    ? `<div class="upload-date">Last upload: ${fmtDate(it.lastUpload)}</div>`
    : '';

  const descBlock = it.description
    ? `<div class="desc">${escHtml(it.description)}</div>`
    : '';

  // What the CLIENT was asked to provide — the reviewer needs the same
  // yardstick the client saw to judge whether the upload satisfies it.
  const guideBlock = it.clientInstructions
    ? `<div class="doc-guide">💡 ${require('./instructionFormatter').formatInstructions(it.clientInstructions)}</div>`
    : '';

  // id="doc-<id>" is the anchor the cockpit's "📎 Files" link lands on.
  // The uploads-slot is filled by renderUploads() once /review/updates answers;
  // it sits after the note block so "see the upload trail below" holds.
  return `
    <div class="doc-row" id="doc-${escHtml(it.id)}" data-item-id="${escHtml(it.id)}" data-status="${escHtml(status)}">
      <div class="doc-meta">
        <div class="name">${escHtml(it.name)}</div>
        ${descBlock}
        ${guideBlock}
        ${dateBlock}
        ${naBlock}
        ${noteBlock}
        <div class="uploads-slot" data-item-id="${escHtml(it.id)}"></div>
        <div class="replies-slot" data-item-id="${escHtml(it.id)}"></div>
      </div>
      <div class="status-cell">
        ${statusBadge(status)}
      </div>
      <div class="actions-cell">
        ${folderBtn}
        <button class="btn btn-reviewed" ${reviewedDisabled}
                onclick="markReviewed('${escJs(it.id)}', this)">✓ Mark Reviewed</button>
        <button class="btn btn-rework" ${reworkDisabled} data-id="${escHtml(it.id)}" data-name="${escHtml(it.name)}"
                onclick="openRework(this)">⟲ Request Rework</button>
        <button class="btn btn-undo" ${undoDisabled}
                onclick="undoReview('${escJs(it.id)}', this)" title="Revert to pending review (no email sent to the client)">↺ Undo</button>
        ${naButtons}
      </div>
    </div>`;
}

module.exports = {
  buildReviewPage,
  getFolderLinks,
  getClientReplies,
  getRowUpdates,
  fetchItemUpdates,
  parseReplies,
  parseUploadNotes,
  markReviewed,
  requestRework,
  reopenDoc,
  markNotApplicable,
  clearNotApplicable,
};
