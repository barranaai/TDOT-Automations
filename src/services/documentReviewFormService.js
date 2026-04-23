/**
 * Document Review Form Service
 *
 * Builds the staff-facing document review page (parallel to the questionnaire
 * review page in htmlQuestionnaireReviewService).
 *
 * What it does:
 *   - Renders all documents for a case grouped by Applicant Member → Category
 *   - Each row shows: name, status badge, last upload date, review notes,
 *     "Open in OneDrive" button (links to the category folder), and the
 *     Mark Reviewed / Request Rework actions
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

// ─── Column IDs — Document Execution Board ───────────────────────────────────
const EXEC_BOARD_ID    = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const DOC_STATUS_COL   = 'color_mm0zwgvr';
const REVIEW_NOTES_COL = 'long_text_mm0zbpr';
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

  const data = await mondayApi.query(
    `query($ids: [ID!]!) {
       items(ids: $ids) { id column_values(ids: ["${DOC_FOLDER_COL}"]) { id value text } }
     }`,
    { ids: itemIds.map(String) }
  );

  for (const it of (data?.items || [])) {
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

// ─── Server actions called from the page (POST handlers in routes file) ─────

/**
 * Mark a document as Reviewed.
 * Updates Document Status on Monday — the existing webhook handler in
 * documentReviewService.onColumnChange picks it up, posts notifications,
 * and triggers a live readiness recalc.
 */
async function markReviewed(itemId) {
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
async function requestRework(itemId, notes) {
  if (!notes || !notes.trim()) {
    throw new Error('Review notes are required when requesting rework.');
  }
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

// ─── HTML page builder ───────────────────────────────────────────────────────

/**
 * @param {Object}   params
 * @param {string}   params.caseRef
 * @param {string}   params.clientName
 * @param {string}   params.staffName
 * @param {Array}    params.items       — from documentFormService.getCaseDocuments()
 * @param {Object}   params.folderLinks — { itemId: oneDriveUrl }
 */
function buildReviewPage({ caseRef, clientName, staffName, items, folderLinks }) {
  // Group: applicant member → category → items
  const groups = {};
  for (const it of items) {
    const member = it.applicantType || 'Principal Applicant';
    const cat    = it.category      || 'General';
    if (!groups[member])           groups[member]      = {};
    if (!groups[member][cat])      groups[member][cat] = [];
    groups[member][cat].push(it);
  }

  // Counters for the summary strip
  const total      = items.length;
  const counts     = { received: 0, reviewed: 0, rework: 0, missing: 0, underReview: 0 };
  for (const it of items) {
    const s = it.status || 'Missing';
    if (s === 'Received')        counts.received++;
    else if (s === 'Reviewed')   counts.reviewed++;
    else if (s === 'Rework Required') counts.rework++;
    else if (s === 'Under Review')    counts.underReview++;
    else                         counts.missing++;
  }

  const memberOrder = Object.keys(groups).sort((a, b) =>
    a === 'Principal Applicant' ? -1 : b === 'Principal Applicant' ? 1 : a.localeCompare(b)
  );

  const memberBlocks = memberOrder.map(member => {
    const cats = groups[member];
    const catKeys = Object.keys(cats).sort();

    const catBlocks = catKeys.map(cat => {
      const rows = cats[cat].map(it => rowHtml(it, folderLinks[it.id] || '')).join('');
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
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; color: #1e293b; }

    /* Top bar */
    .top-bar {
      position: sticky; top: 0; z-index: 100;
      background: #1e3a5f; color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 28px; gap: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.2);
    }
    .top-bar-left h1 { font-size: 16px; font-weight: 700; }
    .top-bar-left p  { font-size: 12px; color: rgba(255,255,255,.65); margin-top: 2px; }
    .staff-badge     { font-size: 12px; color: rgba(255,255,255,.7); }

    /* Content */
    .content { max-width: 1100px; margin: 28px auto; padding: 0 20px 80px; }

    .summary-card {
      background: #fff; border-radius: 12px; padding: 18px 24px;
      box-shadow: 0 1px 8px rgba(0,0,0,.07); margin-bottom: 24px;
      display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
    }
    .summary-stat { text-align: center; min-width: 80px; }
    .summary-stat .num { font-size: 26px; font-weight: 800; color: #1e3a5f; line-height: 1.1; }
    .summary-stat .lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; }
    .summary-stat.received .num { color: #92400e; }
    .summary-stat.reviewed .num { color: #166534; }
    .summary-stat.rework   .num { color: #991b1b; }
    .summary-stat.missing  .num { color: #6b7280; }
    .summary-divider { width: 1px; height: 36px; background: #e5e7eb; }

    /* Filter strip */
    .filter-strip {
      display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px;
    }
    .filter-btn {
      padding: 6px 14px; font-size: 12px; font-weight: 600; border: 1px solid #cbd5e1;
      background: #fff; color: #475569; border-radius: 999px; cursor: pointer;
      transition: all .12s;
    }
    .filter-btn:hover { background: #f1f5f9; }
    .filter-btn.active { background: #1e3a5f; color: #fff; border-color: #1e3a5f; }

    /* Member + category blocks */
    .member-block { margin-bottom: 28px; }
    .member-heading {
      font-size: 17px; font-weight: 700; color: #1e3a5f;
      padding-bottom: 8px; margin-bottom: 14px;
      border-bottom: 2px solid #1e3a5f;
    }
    .category-block {
      background: #fff; border-radius: 12px; margin-bottom: 16px;
      box-shadow: 0 1px 8px rgba(0,0,0,.07); overflow: hidden;
    }
    .category-heading {
      font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #475569;
      background: #f8fafc; border-bottom: 1px solid #e5e7eb;
      padding: 10px 18px; display: flex; align-items: center; justify-content: space-between;
    }
    .cat-count {
      font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: none; letter-spacing: 0;
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
    .doc-meta .review-notes {
      margin-top: 8px; padding: 8px 10px;
      background: #fef2f2; border-left: 3px solid #fca5a5;
      border-radius: 4px; font-size: 12px; color: #7f1d1d;
      line-height: 1.5; max-width: 600px;
    }
    .doc-meta .review-notes strong { color: #991b1b; }
    .doc-meta .client-reply {
      margin-top: 6px; padding: 8px 10px;
      background: #eff6ff; border-left: 3px solid #93c5fd;
      border-radius: 4px; font-size: 12px; color: #1e3a8a; line-height: 1.5;
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
      background: #fff; color: #dc2626; border-color: #dc2626;
    }
    .btn-rework:hover:not(:disabled) { background: #fef2f2; }

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
    .modal h3 { font-size: 16px; color: #1e3a5f; margin-bottom: 4px; }
    .modal .sub { font-size: 12px; color: #64748b; margin-bottom: 14px; }
    .modal textarea {
      width: 100%; min-height: 110px; resize: vertical;
      border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px;
      font-family: inherit; font-size: 13px; line-height: 1.5;
    }
    .modal textarea:focus { outline: none; border-color: #1e3a5f; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .btn-cancel { background: #fff; color: #475569; border-color: #cbd5e1; padding: 8px 16px; }
    .btn-confirm { background: #dc2626; color: #fff; border-color: #dc2626; padding: 8px 16px; }

    /* Toast */
    #toast {
      position: fixed; bottom: 24px; right: 24px; z-index: 300;
      padding: 12px 18px; border-radius: 8px;
      background: #1e3a5f; color: #fff; font-size: 13px;
      box-shadow: 0 10px 30px rgba(0,0,0,.3);
      transform: translateY(100px); opacity: 0; transition: all .25s;
      max-width: 360px;
    }
    #toast.show { transform: translateY(0); opacity: 1; }
    #toast.error { background: #991b1b; }

    @media (max-width: 800px) {
      .doc-row { grid-template-columns: 1fr; gap: 10px; }
      .actions-cell { flex-direction: row; flex-wrap: wrap; }
    }
  </style>
</head>
<body>

  <header class="top-bar">
    <div class="top-bar-left">
      <h1>📂 Document Review — ${escHtml(caseRef)}</h1>
      <p>${escHtml(clientName || 'Unknown Client')}</p>
    </div>
    <div class="staff-badge">Reviewing as ${escHtml(staffName || 'Staff')}</div>
  </header>

  <main class="content">

    <div class="summary-card">
      <div class="summary-stat"><div class="num">${total}</div><div class="lbl">Total</div></div>
      <div class="summary-divider"></div>
      <div class="summary-stat received"><div class="num">${counts.received}</div><div class="lbl">Received</div></div>
      <div class="summary-stat reviewed"><div class="num">${counts.reviewed}</div><div class="lbl">Reviewed</div></div>
      <div class="summary-stat rework"><div class="num">${counts.rework}</div><div class="lbl">Rework</div></div>
      <div class="summary-stat missing"><div class="num">${counts.missing + counts.underReview}</div><div class="lbl">Pending</div></div>
    </div>

    <div class="filter-strip">
      <button class="filter-btn active" data-filter="all">All (${total})</button>
      <button class="filter-btn" data-filter="Received">Received (${counts.received})</button>
      <button class="filter-btn" data-filter="Reviewed">Reviewed (${counts.reviewed})</button>
      <button class="filter-btn" data-filter="Rework Required">Rework (${counts.rework})</button>
      <button class="filter-btn" data-filter="Missing">Missing (${counts.missing})</button>
    </div>

    ${memberBlocks || '<p style="text-align:center;color:#94a3b8;padding:60px;">No documents found for this case.</p>'}

  </main>

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
        // Update DOM in place — the row state, status pill, and button states
        var row = btn.closest('.doc-row');
        if (row) {
          row.setAttribute('data-status', 'Reviewed');
          var pill = row.querySelector('.status-pill');
          if (pill) {
            pill.textContent = 'Reviewed';
            pill.style.background = '#f0fdf4';
            pill.style.color = '#166534';
            pill.style.borderColor = '#bbf7d0';
          }
          // Disable both action buttons after success
          row.querySelectorAll('.btn-reviewed, .btn-rework').forEach(function (b) { b.disabled = true; });
        }
      } catch (err) {
        btn.disabled = false;
        showToast('✗ ' + (err.message || 'Failed to mark reviewed'), true);
      }
    }

    /* ── Open Rework Modal ── */
    function openRework(itemId, docName) {
      _modalItemId = itemId;
      document.getElementById('rework-notes').value = '';
      document.getElementById('modal-sub').textContent = 'Document: ' + docName;
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
          row.setAttribute('data-status', 'Rework Required');
          var pill = row.querySelector('.status-pill');
          if (pill) {
            pill.textContent = 'Rework Required';
            pill.style.background = '#fef2f2';
            pill.style.color = '#991b1b';
            pill.style.borderColor = '#fca5a5';
          }
          row.querySelectorAll('.btn-reviewed, .btn-rework').forEach(function (b) { b.disabled = true; });
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
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });
  </script>

</body>
</html>`;
}

/**
 * Render a single document row.
 */
function rowHtml(it, folderUrl) {
  const status = it.status || 'Missing';
  // Buttons disabled when in a terminal state OR when there's nothing to review
  const isReviewed = status === 'Reviewed';
  const isRework   = status === 'Rework Required';
  const noUpload   = status === 'Missing';

  const reviewedDisabled = isReviewed || noUpload ? 'disabled' : '';
  const reworkDisabled   = isRework   || noUpload ? 'disabled' : '';

  const folderBtn = folderUrl
    ? `<a class="btn btn-onedrive" href="${escHtml(folderUrl)}" target="_blank" rel="noopener">📁 Open in OneDrive</a>`
    : `<button class="btn btn-onedrive" disabled title="No OneDrive folder linked yet">📁 Open in OneDrive</button>`;

  const noteBlock = it.reviewNotes
    ? `<div class="review-notes"><strong>📝 Existing review note:</strong> ${escHtml(it.reviewNotes)}</div>`
    : '';

  const dateBlock = it.lastUpload
    ? `<div class="upload-date">Last upload: ${fmtDate(it.lastUpload)}</div>`
    : '';

  const descBlock = it.description
    ? `<div class="desc">${escHtml(it.description)}</div>`
    : '';

  return `
    <div class="doc-row" data-item-id="${escHtml(it.id)}" data-status="${escHtml(status)}">
      <div class="doc-meta">
        <div class="name">${escHtml(it.name)}</div>
        ${descBlock}
        ${dateBlock}
        ${noteBlock}
      </div>
      <div class="status-cell">
        ${statusBadge(status)}
      </div>
      <div class="actions-cell">
        ${folderBtn}
        <button class="btn btn-reviewed" ${reviewedDisabled}
                onclick="markReviewed('${escJs(it.id)}', this)">✓ Mark Reviewed</button>
        <button class="btn btn-rework" ${reworkDisabled}
                onclick="openRework('${escJs(it.id)}', '${escJs(it.name)}')">⟲ Request Rework</button>
      </div>
    </div>`;
}

module.exports = {
  buildReviewPage,
  getFolderLinks,
  markReviewed,
  requestRework,
};
