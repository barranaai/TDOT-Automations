/**
 * HTML Questionnaire Service
 *
 * Handles all server-side logic for the new HTML-form questionnaire system:
 *   • Validating client access via token
 *   • Loading / saving questionnaire data as CSV files in OneDrive
 *   • Updating Monday.com Q readiness when the client submits
 *   • Building the injection script that makes each static HTML file dynamic
 *   • Assembling the final HTML sent to the browser
 */

'use strict';

const fs               = require('fs');
const path             = require('path');
const mondayApi        = require('./mondayApi');
const oneDrive         = require('./oneDriveService');
const stageGateService = require('./stageGateService');
const { loadThresholds } = require('./caseReadinessService');
const { clientMasterBoardId } = require('../../config/monday');
const { FORMS_DIR, resolveForm } = require('../../config/questionnaireFormMap');

// ─── Column IDs — Client Master Board ────────────────────────────────────────

const BASE_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

const CM = {
  caseRef:           'text_mm142s49',
  caseType:          'dropdown_mm0xd1qn',
  caseSubType:       'dropdown_mm0x4t91',
  accessToken:       'text_mm0x6haq',
  clientName:        'text_mm0x1zdk',
  qReadiness:        'numeric_mm0x9dea',
  qCompletionStatus: 'color_mm0x9s08',   // labels: Done / Working on it
  // Extra columns read during stage-gate check (not written)
  caseStage:         'color_mm0x8faa',
  docReadiness:      'numeric_mm0x5g9x',
  blockingDocCount:  'numeric_mm0xje6p', // written by daily readiness scan
  automationLock:    'color_mm0x3x1x',
};

const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';

// ─── RFC 4180 CSV helpers ─────────────────────────────────────────────────────

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  // Always quote — handles commas, newlines, and quotes inside values safely
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCsv(fields) {
  const header = 'section,label,key,value\r\n';
  const rows   = fields
    .map(f => [f.section, f.label, f.key, f.value].map(csvEscape).join(','))
    .join('\r\n');
  return header + rows;
}

/** RFC 4180 parser — correctly handles multi-line quoted fields. */
function parseCsv(text) {
  const result = [];
  let i = 0;

  function parseField() {
    let field = '';
    if (i < text.length && text[i] === '"') {
      i++; // skip opening quote
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; }
          else { i++; break; }
        } else {
          field += text[i++];
        }
      }
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
        field += text[i++];
      }
    }
    return field;
  }

  function parseRecord() {
    const fields = [];
    while (i < text.length) {
      fields.push(parseField());
      if (i < text.length && text[i] === ',') { i++; } else { break; }
    }
    if (i < text.length && text[i] === '\r') i++;
    if (i < text.length && text[i] === '\n') i++;
    return fields;
  }

  parseRecord(); // skip CSV header row

  while (i < text.length) {
    if (text[i] === '\r' || text[i] === '\n') { i++; continue; }
    const rec = parseRecord();
    if (rec.length >= 4 && rec[2]) {
      result.push({ section: rec[0], label: rec[1], key: rec[2], value: rec[3] || '' });
    }
  }

  return result;
}

// ─── Monday.com helpers ───────────────────────────────────────────────────────

/**
 * Look up a Client Master item by case reference number.
 * Returns { itemId, clientName, caseType, caseSubType, accessToken } or null.
 */
async function lookupCase(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 1, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items {
           id
           column_values(ids: [
             "${CM.caseRef}", "${CM.caseType}", "${CM.caseSubType}",
             "${CM.accessToken}", "${CM.clientName}"
           ]) { id text }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM.caseRef, val: caseRef }
  );

  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return null;

  const col = (id) => item.column_values.find(c => c.id === id)?.text?.trim() || '';

  return {
    itemId:      item.id,
    clientName:  col(CM.clientName),
    caseType:    col(CM.caseType),
    caseSubType: col(CM.caseSubType) || null,
    accessToken: col(CM.accessToken),
  };
}

// ─── Access validation ────────────────────────────────────────────────────────

/**
 * Validate that caseRef exists and the provided token matches the stored token.
 *
 * @returns {{ itemId, clientName, caseType, caseSubType, formFiles }}
 * @throws  Error with a user-safe message on invalid access
 */
async function validateAccess(caseRef, token) {
  if (!caseRef || !token) throw new Error('Missing case reference or access token.');

  const entry = await lookupCase(caseRef);
  if (!entry) throw new Error('Case not found.');

  if (!entry.accessToken || entry.accessToken !== token) {
    throw new Error('Invalid or expired access token.');
  }

  const formFiles = resolveForm(entry.caseType, entry.caseSubType);

  return { ...entry, formFiles };
}

// ─── OneDrive data operations ─────────────────────────────────────────────────

function csvFilename(caseRef, formKey) {
  return `questionnaire-${caseRef}-${formKey}.csv`;
}

/**
 * Load previously saved questionnaire data for a given form.
 * Returns an array of { section, label, key, value } objects, or [] if none saved.
 */
async function loadFormData({ clientName, caseRef, formKey }) {
  try {
    const buf = await oneDrive.readFile({
      clientName,
      caseRef,
      subfolder: QUESTIONNAIRE_SUBFOLDER,
      filename:  csvFilename(caseRef, formKey),
    });
    if (!buf) return [];
    return parseCsv(buf.toString('utf8'));
  } catch (err) {
    console.error(`[HtmlQ] loadFormData failed for ${caseRef}/${formKey}:`, err.message);
    return [];
  }
}

/**
 * Save questionnaire data to OneDrive, replacing any previous file.
 *
 * @param {{ clientName, caseRef, itemId, formKey, fields, completionPct }} params
 *   fields: [{ section, label, key, value }]
 */
async function saveFormData({ clientName, caseRef, itemId, formKey, fields, completionPct }) {
  const csvContent = toCsv(fields);
  const buffer     = Buffer.from(csvContent, 'utf8');
  const filename   = csvFilename(caseRef, formKey);

  // Ensure the client folder exists (safe to call even if it was already created)
  await oneDrive.ensureClientFolder({ clientName, caseRef });

  await oneDrive.uploadFile({
    clientName,
    caseRef,
    category: QUESTIONNAIRE_SUBFOLDER,
    filename,
    buffer,
    mimeType: 'text/csv',
  });

  console.log(`[HtmlQ] Saved ${fields.length} fields for ${caseRef}/${formKey} (${completionPct}%)`);
}

/**
 * Mark a questionnaire form as submitted.
 * Updates Q readiness on Monday.com, posts an audit comment, and
 * triggers stage gates if the completion threshold has been crossed.
 *
 * @param {{ itemId, caseRef, caseType, formKey, formLabel, completionPct }} params
 *   caseType is required for threshold lookup and stage gate calls.
 */
async function markSubmitted({ itemId, caseRef, caseType, formKey, formLabel, completionPct }) {
  const pct = Math.round(completionPct);

  // ── Step 1: Update Q Readiness and Q Completion Status ────────────────────
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
     }`,
    {
      boardId: String(clientMasterBoardId),
      itemId:  String(itemId),
      cols:    JSON.stringify({
        [CM.qReadiness]:        pct,
        [CM.qCompletionStatus]: { label: pct >= 100 ? 'Done' : 'Working on it' },
      }),
    }
  );

  // ── Step 2: Audit comment with staff review link ───────────────────────────
  const label       = formLabel ? `"${formLabel}"` : `(${formKey})`;
  const submittedAt = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true });
  const reviewUrl   = `${BASE_URL}/q/${encodeURIComponent(caseRef)}/review?formKey=${encodeURIComponent(formKey)}`;
  const comment     = `📋 Questionnaire Submitted\n\nForm: ${label}\nCase: ${caseRef}\nCompletion: ${pct}%\nSubmitted: ${submittedAt} (Toronto)\n\nData saved to client OneDrive folder.\n\n🔍 Staff Review Link:\n${reviewUrl}`;

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: comment }
  );

  console.log(`[HtmlQ] Marked submitted — ${caseRef}/${formKey} at ${pct}%`);

  // ── Step 3: Stage gate check ───────────────────────────────────────────────
  // Fire-and-forget: errors here must not block the submit response to the client.
  checkStageGate({ itemId, caseRef, caseType, qPct: pct }).catch((err) =>
    console.error(`[HtmlQ] Stage gate check failed for ${caseRef}:`, err.message)
  );
}

/**
 * Check whether the form submission has crossed the readiness threshold
 * and fire the appropriate stage gate if so.
 *
 * Reads the current case stage, doc readiness, and automation lock from Monday
 * so it can make the same decision the daily readiness scan would make.
 */
async function checkStageGate({ itemId, caseRef, caseType, qPct }) {
  // Fetch current case state — we need stage, doc readiness, and automation lock
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: [
           "${CM.caseStage}", "${CM.docReadiness}",
           "${CM.blockingDocCount}", "${CM.automationLock}"
         ]) { id text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const cols        = data?.items?.[0]?.column_values || [];
  const col         = (id) => cols.find(c => c.id === id)?.text?.trim() || '';
  const stage       = col(CM.caseStage);
  const docPct      = parseFloat(col(CM.docReadiness)) || 0;
  const blockingDoc = parseInt(col(CM.blockingDocCount), 10) || 0;
  const locked      = col(CM.automationLock) === 'Yes';

  if (locked) {
    console.log(`[HtmlQ] Stage gate skipped — automation locked for ${caseRef}`);
    return;
  }

  // Only eligible stages can advance via stage gates
  const eligibleStages = new Set(['Document Collection Started', 'Internal Review']);
  if (!eligibleStages.has(stage)) {
    console.log(`[HtmlQ] Stage gate skipped — stage "${stage}" not eligible for ${caseRef}`);
    return;
  }

  // Load the SLA threshold for this case type (cached, ~30-min TTL)
  const thresholds    = await loadThresholds();
  const minThreshold  = thresholds[caseType] || 80;

  // Mirror the daily scan logic exactly: blocking docs prevent gate advancement
  const thresholdMet  = qPct >= minThreshold && docPct >= minThreshold && blockingDoc === 0;
  const fullyComplete = qPct >= 100 && docPct >= 100 && blockingDoc === 0;

  console.log(
    `[HtmlQ] Stage gate check — ${caseRef} | Q:${qPct}% Doc:${docPct}% ` +
    `BlockingDocs:${blockingDoc} Threshold:${minThreshold}% Stage:"${stage}" | ` +
    (fullyComplete ? 'FULLY COMPLETE' : thresholdMet ? 'THRESHOLD MET' : 'below threshold / blocking')
  );

  if (fullyComplete && stage === 'Internal Review') {
    stageGateService.onFullyComplete({ masterItemId: itemId, caseRef, caseType })
      .catch(err => console.error(`[HtmlQ] onFullyComplete failed for ${caseRef}:`, err.message));
    return;
  }

  if (thresholdMet && stage === 'Document Collection Started') {
    stageGateService.onThresholdMet({ masterItemId: itemId, caseRef, caseType })
      .catch(err => console.error(`[HtmlQ] onThresholdMet failed for ${caseRef}:`, err.message));
  }
}

// ─── Injection script builder ─────────────────────────────────────────────────

/**
 * Build the <style> + <script> block that is injected before </body> in each HTML form.
 *
 * The injected script adds a floating toolbar (save / submit / progress) and
 * handles all data persistence via the /q/:caseRef API endpoints.
 *
 * @param {{ caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl }} params
 * @returns {string}  HTML string ready to splice into the form HTML
 */
function buildInjectionScript({ caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl }) {
  return `
<!-- TDOT Dynamic Questionnaire — injected by server -->
<style>
#tdot-toolbar {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: #1e3a5f; color: #fff;
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 24px; z-index: 9999;
  box-shadow: 0 -3px 16px rgba(0,0,0,0.25);
  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
  gap: 12px;
}
#tdot-progress { color: rgba(255,255,255,0.75); white-space: nowrap; }
#tdot-actions  { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
#tdot-saved-msg { font-size: 12px; color: #86efac; min-width: 100px; text-align: right; }
.tdot-btn {
  padding: 7px 16px; border: none; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background 0.15s;
}
.tdot-btn-save   { background: #374151; color: #fff; }
.tdot-btn-save:hover   { background: #4b5563; }
.tdot-btn-submit { background: #059669; color: #fff; }
.tdot-btn-submit:hover { background: #047857; }
.tdot-btn:disabled { opacity: 0.45; cursor: not-allowed; }
body { padding-bottom: 68px !important; }
${hasAdditionalForm ? `
.tdot-nav-bar {
  display: flex; background: #f8fafc; border-bottom: 2px solid #dde3ea;
  padding: 0 20px; position: sticky; top: 0; z-index: 90;
}
.tdot-nav-tab {
  padding: 11px 22px; font-size: 14px; font-weight: 600;
  cursor: pointer; border-bottom: 3px solid transparent;
  color: #6b7280; text-decoration: none; display: block;
}
.tdot-nav-tab.active { color: #1e3a5f; border-bottom-color: #1e3a5f; }
` : ''}
</style>
<script>
(function () {
  'use strict';

  /* ── Config injected by server ── */
  var CASE_REF       = ${JSON.stringify(String(caseRef))};
  var TOKEN          = ${JSON.stringify(String(token))};
  var FORM_KEY       = ${JSON.stringify(String(formKey))};
  var OVERVIEW_URL   = ${JSON.stringify(overviewUrl || '')};

  /* ── Utilities ── */

  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/, '')
      .slice(0, 90);
  }

  function getHeadingText(el) {
    return Array.from(el.childNodes)
      .filter(function (n) {
        return n.nodeType === 3 ||
               (n.nodeType === 1 && !n.classList.contains('chevron') && n.tagName !== 'SPAN');
      })
      .map(function (n) { return n.textContent.trim(); })
      .join(' ')
      .trim();
  }

  function getSectionContext(el) {
    var parts   = [];
    var current = el.parentElement;
    while (current && current !== document.body) {
      var prev = current.previousElementSibling;
      if (prev) {
        var onclick = prev.getAttribute('onclick') || '';
        if (onclick.indexOf('toggleTop') !== -1 || onclick.indexOf('toggleSub') !== -1) {
          var text = getHeadingText(prev);
          if (text) parts.unshift(text);
        }
      }
      current = current.parentElement;
    }
    return parts.join(' › ');
  }

  function isVisible(el) {
    var node = el;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  }

  /* ── Field collection ── */

  var _fieldCache = null;
  var _cacheStale = true;

  function invalidateCache() { _cacheStale = true; }

  function collectFields() {
    if (!_cacheStale && _fieldCache) return _fieldCache;

    var fields  = [];
    var seen    = [];
    var keyMap  = {};

    function makeKey(section, label) {
      var base = slugify(section + '__' + label);
      if (!keyMap[base]) { keyMap[base] = 0; return base; }
      keyMap[base]++;
      return base + '-' + keyMap[base];
    }

    /* 1 — Standard form-group inputs */
    var groups = document.querySelectorAll('.form-group');
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      var lbl   = group.querySelector('label');
      var inp   = group.querySelector('input, select, textarea');
      if (!lbl || !inp || seen.indexOf(inp) !== -1) continue;
      seen.push(inp);
      var labelText = lbl.textContent.trim();
      var section   = getSectionContext(group);
      fields.push({ section: section, label: labelText, key: makeKey(section, labelText), el: inp });
    }

    /* 2 — Dynamic table rows */
    var tables = document.querySelectorAll('.dynamic-table');
    for (var ti = 0; ti < tables.length; ti++) {
      var table   = tables[ti];
      var tableId = table.id || ('table-' + ti);
      var headers = [];
      var ths     = table.querySelectorAll('thead th');
      for (var hi = 0; hi < ths.length; hi++) {
        var h = ths[hi].textContent.trim();
        if (h && h.toLowerCase() !== 'remove' && h !== '') headers.push(h);
      }
      var tbody = table.querySelector('tbody');
      if (!tbody) continue;
      var rows = tbody.querySelectorAll('tr');
      for (var ri = 0; ri < rows.length; ri++) {
        var row       = rows[ri];
        var rowInputs = row.querySelectorAll('input, select');
        for (var ci = 0; ci < headers.length; ci++) {
          var cell = rowInputs[ci];
          if (!cell || seen.indexOf(cell) !== -1) continue;
          seen.push(cell);
          var section2 = getSectionContext(table);
          /* Embed tableId so pre-fill can identify and expand this table */
          var labelText2 = headers[ci] + ' — Row ' + (ri + 1);
          var key2       = slugify(section2 + '--tbl-' + slugify(tableId) + '--r' + (ri + 1) + '--' + headers[ci]);
          fields.push({ section: section2 + ' › Table', label: labelText2, key: key2, el: cell, _tableId: tableId, _col: ci });
        }
      }
    }

    _fieldCache = fields;
    _cacheStale = false;
    return fields;
  }

  /* ── Progress ── */

  function getProgress() {
    var fields = collectFields();
    var total  = 0;
    var filled = 0;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (!isVisible(f.el)) continue;
      total++;
      var val = (f.el.value || '').trim();
      if (val && val !== 'Select...' && val !== '') filled++;
    }
    var pct = total > 0 ? Math.round(filled / total * 100) : 0;
    return { total: total, filled: filled, pct: pct };
  }

  function getSerializableFields() {
    var fields = collectFields();
    var result = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      result.push({ section: f.section, label: f.label, key: f.key, value: f.el.value || '' });
    }
    return result;
  }

  function updateProgressUI() {
    var bar = document.getElementById('tdot-progress');
    if (!bar) return;
    var p = getProgress();
    bar.textContent = p.filled + ' / ' + p.total + ' fields completed (' + p.pct + '%)';
    var pctBar = document.getElementById('tdot-pct-fill');
    if (pctBar) pctBar.style.width = p.pct + '%';
  }

  /* ── Save ── */

  var _saveTimeout = null;

  async function doSave(silent) {
    var saveBtn = document.getElementById('tdot-save-btn');
    var msg     = document.getElementById('tdot-saved-msg');
    if (!silent && saveBtn) saveBtn.disabled = true;

    try {
      var p = getProgress();
      var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/save', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          token:         TOKEN,
          formKey:       FORM_KEY,
          fields:        getSerializableFields(),
          completionPct: p.pct,
        }),
      });
      if (!res.ok) throw new Error('Save failed (' + res.status + ')');
      if (msg) {
        msg.textContent = '✓ Saved at ' + new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
        setTimeout(function () { if (msg) msg.textContent = ''; }, 8000);
      }
    } catch (err) {
      console.error('[TDOT] Save error:', err);
      if (msg) { msg.textContent = '⚠ Save failed — check connection'; msg.style.color = '#fca5a5'; }
    } finally {
      if (!silent && saveBtn) saveBtn.disabled = false;
    }
  }

  /* ── Submit ── */

  async function doSubmit() {
    var p = getProgress();
    var confirmed = confirm(
      'Submit your questionnaire?\n\n' +
      'Completion: ' + p.pct + '% (' + p.filled + ' of ' + p.total + ' fields)\n\n' +
      (p.pct < 100 ? 'Note: some fields are still empty. You can still submit — your consultant will follow up.\n\n' : '') +
      'Click OK to submit.'
    );
    if (!confirmed) return;

    var submitBtn = document.getElementById('tdot-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

    try {
      var res = await fetch('/q/' + encodeURIComponent(CASE_REF) + '/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          token:         TOKEN,
          formKey:       FORM_KEY,
          fields:        getSerializableFields(),
          completionPct: p.pct,
        }),
      });
      if (!res.ok) throw new Error('Submit failed (' + res.status + ')');

      /* Show a success message and disable further editing */
      document.body.innerHTML =
        '<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:80px auto;text-align:center;padding:40px 24px">' +
        '<div style="font-size:56px;margin-bottom:20px">✅</div>' +
        '<h2 style="color:#1e3a5f;margin-bottom:12px">Questionnaire Submitted</h2>' +
        '<p style="color:#6b7280;font-size:15px">Thank you! Your answers have been saved and your consultant has been notified.</p>' +
        (OVERVIEW_URL ? '<p style="margin-top:28px"><a href="' + OVERVIEW_URL + '" style="color:#1e3a5f;font-weight:600">← Back to questionnaire overview</a></p>' : '') +
        '</div>';
    } catch (err) {
      console.error('[TDOT] Submit error:', err);
      alert('Submission failed. Please try again or contact your consultant.\n\nError: ' + err.message);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '✅ Submit Questionnaire'; }
    }
  }

  /* ── Flags (correction notes from consultant) ── */

  async function loadAndApplyFlags() {
    try {
      var res = await fetch(
        '/q/' + encodeURIComponent(CASE_REF) + '/flags' +
        '?t=' + encodeURIComponent(TOKEN) + '&formKey=' + encodeURIComponent(FORM_KEY),
        { method: 'GET' }
      );
      if (!res.ok) return;
      var data = await res.json();
      if (!data.flags || !Object.keys(data.flags).length) return;

      var fields = collectFields();
      for (var fi = 0; fi < fields.length; fi++) {
        var f    = fields[fi];
        var flag = data.flags[f.key];
        if (!flag) continue;

        /* Highlight the input */
        f.el.style.borderColor = '#f97316';
        f.el.style.outline     = '2px solid #fed7aa';

        /* Insert a note below the input */
        var note = document.createElement('div');
        note.setAttribute('data-tdot-flag', f.key);
        note.style.cssText =
          'margin-top:6px;padding:8px 12px;background:#fff7ed;border:1px solid #fed7aa;' +
          'border-radius:6px;font-size:13px;color:#92400e;line-height:1.5;';
        note.innerHTML = '<strong>💬 Consultant note:</strong> ' +
          escHtml(flag.comment);

        var parent = f.el.parentElement;
        if (parent) {
          var existing = parent.querySelector('[data-tdot-flag="' + f.key + '"]');
          if (existing) existing.remove();
          parent.appendChild(note);
        }
      }

      /* Banner at top of page */
      var flagCount = Object.keys(data.flags).length;
      var banner = document.createElement('div');
      banner.style.cssText =
        'position:sticky;top:0;z-index:91;background:#fff7ed;border-bottom:2px solid #fed7aa;' +
        'padding:10px 24px;font-family:Segoe UI,sans-serif;font-size:14px;color:#92400e;' +
        'display:flex;align-items:center;gap:10px;';
      banner.innerHTML =
        '<span style="font-size:18px">🚩</span>' +
        '<strong>Your consultant has flagged ' + flagCount + ' item' + (flagCount !== 1 ? 's' : '') +
        ' for correction.</strong> Scroll down to see the highlighted fields, update your answers, then click Save.';
      document.body.insertBefore(banner, document.body.firstChild);
    } catch (err) {
      console.error('[TDOT] Flags load error:', err);
    }
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── Pre-fill ── */

  async function expandTableRows(savedFields) {
    /* Build a map: tableId slug → max row index found in saved data */
    var tableMaxRow = {};
    for (var i = 0; i < savedFields.length; i++) {
      var key   = savedFields[i].key;
      var match = key.match(/--tbl-([a-z0-9-]+)--r(\d+)--/);
      if (match) {
        var tblSlug = match[1];
        var rowNum  = parseInt(match[2], 10);
        if (!tableMaxRow[tblSlug] || tableMaxRow[tblSlug] < rowNum) {
          tableMaxRow[tblSlug] = rowNum;
        }
      }
    }

    var tables = document.querySelectorAll('.dynamic-table');
    for (var ti = 0; ti < tables.length; ti++) {
      var table   = tables[ti];
      var tblSlug = slugify(table.id || ('table-' + ti));
      var maxRow  = tableMaxRow[tblSlug];
      if (!maxRow) continue;

      var currentRows = table.querySelectorAll('tbody tr').length;
      var needed      = maxRow - currentRows;
      if (needed <= 0) continue;

      /* Find the "Add Row" / "Add Entry" button associated with this table */
      var container = table.closest('.sub-accordion-body') || table.parentElement;
      var addBtn    = null;
      if (container) {
        var btns = container.querySelectorAll('button, .btn-add');
        for (var bi = 0; bi < btns.length; bi++) {
          var onclick = btns[bi].getAttribute('onclick') || '';
          if (onclick.indexOf(table.id) !== -1 || onclick.indexOf('addRow') !== -1) {
            addBtn = btns[bi]; break;
          }
        }
      }
      if (!addBtn) continue;
      for (var ri = 0; ri < needed; ri++) { addBtn.click(); }
    }
  }

  async function loadAndPrefill() {
    try {
      var res = await fetch(
        '/q/' + encodeURIComponent(CASE_REF) + '/data' +
        '?t=' + encodeURIComponent(TOKEN) + '&formKey=' + encodeURIComponent(FORM_KEY),
        { method: 'GET' }
      );
      if (!res.ok) return;
      var data = await res.json();
      if (!data.fields || !data.fields.length) return;

      /* Expand dynamic tables first, then fill */
      await expandTableRows(data.fields);

      /* Invalidate cache — rows may have been added */
      invalidateCache();

      var saved   = {};
      for (var i = 0; i < data.fields.length; i++) {
        saved[data.fields[i].key] = data.fields[i].value;
      }

      var fields = collectFields();
      for (var fi = 0; fi < fields.length; fi++) {
        var f = fields[fi];
        if (saved[f.key] !== undefined && saved[f.key] !== '') {
          f.el.value = saved[f.key];
          try { f.el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        }
      }

      updateProgressUI();
    } catch (err) {
      console.error('[TDOT] Pre-fill error:', err);
    }
  }

  /* ── Toolbar ── */

  function createToolbar() {
    var bar = document.createElement('div');
    bar.id  = 'tdot-toolbar';
    bar.innerHTML =
      '<div>' +
        '<div id="tdot-progress">Loading saved data…</div>' +
      '</div>' +
      '<div id="tdot-actions">' +
        '<span id="tdot-saved-msg"></span>' +
        '<button class="tdot-btn tdot-btn-save"   id="tdot-save-btn"   onclick="tdotSave()">💾 Save Progress</button>' +
        '<button class="tdot-btn tdot-btn-submit" id="tdot-submit-btn" onclick="tdotSubmit()">✅ Submit Questionnaire</button>' +
      '</div>';
    document.body.appendChild(bar);
  }

  /* ── Navigation tabs (two-form cases) ── */
  ${overviewUrl ? `
  function createNavTab() {
    var nav = document.createElement('div');
    nav.className = 'tdot-nav-bar';
    nav.innerHTML = '<a href="' + OVERVIEW_URL + '" class="tdot-nav-tab">← All Forms</a>';
    document.body.insertBefore(nav, document.body.firstChild);
  }
  ` : '/* single-form case — no nav tab */'}

  /* ── Auto-save ── */

  function scheduleAutoSave() {
    setInterval(function () { doSave(true); }, 3 * 60 * 1000); // every 3 min
  }

  /* ── Expose globals for inline button handlers ── */

  window.tdotSave   = function () { doSave(false); };
  window.tdotSubmit = doSubmit;

  /* ── Initialise ── */

  async function init() {
    createToolbar();
    ${overviewUrl ? 'createNavTab();' : ''}

    /* Listen for any field change to update progress and invalidate cache */
    document.addEventListener('change', function () { invalidateCache(); updateProgressUI(); });
    document.addEventListener('input',  function () { invalidateCache(); updateProgressUI(); });

    await loadAndPrefill();
    await loadAndApplyFlags();
    updateProgressUI();
    scheduleAutoSave();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
`;
}

// ─── HTML page builders ───────────────────────────────────────────────────────

/**
 * Read an HTML form file from disk and inject the dynamic script block.
 *
 * @param {{ formFile, caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl }} params
 * @returns {string} Complete HTML ready to send to the browser
 */
function buildFormPage({ formFile, caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl }) {
  const filePath = path.join(FORMS_DIR, formFile);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Form file not found: ${formFile}`);
  }

  const html   = fs.readFileSync(filePath, 'utf8');
  const script = buildInjectionScript({ caseRef, token, formKey, formTitle, hasAdditionalForm, overviewUrl });

  // Inject immediately before </body>
  if (html.includes('</body>')) {
    return html.replace('</body>', script + '\n</body>');
  }
  // Fallback: append to end
  return html + script;
}

/**
 * Build the overview page shown for two-form cases.
 * Displays a card for each form with a link to open it.
 *
 * @param {{ caseRef, token, primaryTitle, additionalTitle }} params
 * @returns {string} HTML string
 */
function buildOverviewPage({ caseRef, token, primaryTitle, additionalTitle }) {
  const base = `/q/${encodeURIComponent(caseRef)}?t=${encodeURIComponent(token)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Questionnaire — ${caseRef}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex; flex-direction: column; align-items: center;
      padding: 40px 20px;
    }
    .header {
      text-align: center; margin-bottom: 36px;
    }
    .header h1 { font-size: 24px; color: #1e3a5f; font-weight: 700; }
    .header p  { color: #6b7280; font-size: 14px; margin-top: 6px; }
    .cards {
      display: flex; flex-wrap: wrap; gap: 20px;
      justify-content: center; width: 100%; max-width: 860px;
    }
    .card {
      background: #fff; border-radius: 12px; padding: 28px 28px 24px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      flex: 1 1 340px; min-width: 280px; max-width: 420px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .card-num  { font-size: 11px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: .06em; }
    .card h2   { font-size: 17px; font-weight: 700; color: #1e3a5f; }
    .card p    { font-size: 13px; color: #6b7280; flex: 1; }
    .card a {
      display: block; text-align: center; margin-top: 8px;
      padding: 10px 20px; background: #1e3a5f; color: #fff;
      border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;
    }
    .card a:hover { background: #2d5186; }
    @media (max-width: 600px) { .cards { flex-direction: column; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>Your Questionnaire</h1>
    <p>Case Reference: <strong>${caseRef}</strong></p>
    <p style="margin-top:8px;font-size:13px;color:#6b7280">
      This case requires two questionnaire forms. Please complete both.
    </p>
  </div>
  <div class="cards">
    <div class="card">
      <div class="card-num">Form 1 of 2</div>
      <h2>${primaryTitle}</h2>
      <p>Start here — complete this form first.</p>
      <a href="${base}&f=1">Open Form 1</a>
    </div>
    <div class="card">
      <div class="card-num">Form 2 of 2</div>
      <h2>${additionalTitle}</h2>
      <p>Complete this after finishing Form 1.</p>
      <a href="${base}&f=2">Open Form 2</a>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Build the placeholder page shown when no form is available for the case type.
 * (Option B: "Your questionnaire is being prepared.")
 */
function buildPlaceholderPage(caseRef) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Questionnaire — ${caseRef}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 40px 20px;
    }
    .box {
      background: #fff; border-radius: 14px; padding: 48px 40px;
      box-shadow: 0 2px 20px rgba(0,0,0,0.09); text-align: center;
      max-width: 520px; width: 100%;
    }
    .icon  { font-size: 52px; margin-bottom: 20px; }
    h1     { font-size: 22px; color: #1e3a5f; font-weight: 700; margin-bottom: 14px; }
    p      { font-size: 14px; color: #6b7280; line-height: 1.6; }
    .ref   { margin-top: 20px; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">📋</div>
    <h1>Your Questionnaire Is Being Prepared</h1>
    <p>
      Your consultant is currently finalising the questionnaire for your case.
      You will receive an email with a direct link as soon as it is ready.
    </p>
    <p class="ref">Case Reference: ${caseRef}</p>
  </div>
</body>
</html>`;
}

/**
 * Build an error / access-denied page.
 */
function buildErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Error</title>
  <style>
    body { font-family:'Segoe UI',sans-serif; background:#f0f4f8; display:flex;
           align-items:center; justify-content:center; min-height:100vh; padding:40px 20px; }
    .box { background:#fff; border-radius:14px; padding:48px 40px; text-align:center;
           box-shadow:0 2px 20px rgba(0,0,0,.09); max-width:480px; width:100%; }
    h1   { color:#dc2626; font-size:20px; margin-bottom:12px; }
    p    { color:#6b7280; font-size:14px; line-height:1.6; }
  </style>
</head>
<body>
  <div class="box">
    <div style="font-size:48px;margin-bottom:16px">🔒</div>
    <h1>Access Denied</h1>
    <p>${message || 'This link is invalid or has expired. Please contact your consultant.'}</p>
  </div>
</body>
</html>`;
}

module.exports = {
  validateAccess,
  resolveForm,
  loadFormData,
  saveFormData,
  markSubmitted,
  buildFormPage,
  buildOverviewPage,
  buildPlaceholderPage,
  buildErrorPage,
};
