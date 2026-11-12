/**
 * Consultant Portal
 *   GET /admin/consultations          — the consultant's booked-consultation queue
 *   GET /admin/consultation/:leadId    — one consultation, fully assembled
 *
 * Static pages (like the dashboard / case cockpit); data comes from
 * /api/consultations and /api/consultation/:leadId (behind ADMIN_API_KEY, key
 * in sessionStorage). Phase A is read-only — the outcome/retainer action
 * controls are added in Phase B.
 */

const express = require('express');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS, DELETE_UI_CSS, DELETE_UI_JS, PAYMENT_UI_CSS, PAYMENT_UI_JS, BLACKLIST_UI_CSS, BLACKLIST_UI_JS, DIALOG_UI_JS, REPORTING_LINK_HTML } = require('./adminShared');
const { OUTCOME_NOT_WANTED } = require('../../config/outcomes');
const { UPDATES_WIDGET_CSS, updatesWidgetHtml, UPDATES_WIDGET_JS } = require('./updatesWidget');
const { CONSULT_NOTES_CSS, consultNotesHtml, CONSULT_NOTES_JS } = require('./consultNotesWidget');   // the Consultation notes box (2026-11-10)
const { OUTCOME_LABELS, REMARK_PRESETS, RETAINER_TABS, RETAINED_TAB } = require('../services/consultantPortalService');
const { REMARKS_CSS, remarksHtml, REMARKS_JS } = require('./leadRemarksWidget');
const { REFERRAL_CSS, REFERRAL_UI_JS, referralFieldsHtml, sourceOptionsHtml } = require('./referralPicker');   // the walk-in form's Source / Reference (2026-11-04)
const { ATTACH_CSS, ATTACH_UI_JS, attachFieldHtml } = require('./attachUi');   // Shafoli's screenshot attachments (2026-11-04)
const { deadlineBoxHtml, DEADLINE_BOX_JS, DEADLINE_BOX_CSS } = require('./deadlineBox');   // the deadline box (2026-11-05)
const { listTableScript, LIST_TABLE_CSS } = require('./listFilters');   // one filter look for every list (2026-11-05)
const { consultListSpec, consultListOpts, retainerListSpec, retainerListOpts } = require('./listSpecs');
const { DQ_CSS, DQ_JS, DQ_BUTTON_HTML, DQ_DONE_HTML, dqFormHtml } = require('./directConsultUi');   // "＋ Direct consultation" (step 2, 2026-11-09)

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Inline icon set (stroke, currentColor — inherits size/colour) ───────────────
// Replaces emoji as structural icons. `${I.name}` bakes the SVG markup into the
// page at render time; for icons needed inside client-side string-building, the
// same markup is shipped as a JSON ICONS object (see buildDetailHTML).
const _svg = (p) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:none;vertical-align:-.15em">${p}</svg>`;
const I = {
  back:      _svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  video:     _svg('<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>'),
  file:      _svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  dollar:    _svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v12"/><path d="M15 9.5a2.5 2.5 0 0 0-2.5-1.7h-1A2 2 0 0 0 9.5 10c0 1.1.9 1.8 2 2h1a2 2 0 0 1 0 4h-1a2.5 2.5 0 0 1-2.5-1.7"/>'),
  mail:      _svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  disc:      _svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>'),
  clip:      _svg('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  cap:       _svg('<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 2.5 9 2.5 12 0v-5"/>'),
  cpu:       _svg('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
  bolt:      _svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>'),
  flag:      _svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><line x1="4" x2="4" y1="22" y2="15"/>'),
  userCheck: _svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>'),
  check:     _svg('<polyline points="20 6 9 17 4 12"/>'),
  send:      _svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
  refresh:   _svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
  eye:       _svg('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  save:      _svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
  plus:      _svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  cols:      _svg('<rect width="7" height="18" x="3" y="3" rx="1"/><rect width="7" height="18" x="14" y="3" rx="1"/>'),
  clock:     _svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
};
// Serialise leadId / labels / icons into a <script> safely: JSON.stringify does
// NOT escape `</script>`, so neutralise every `<` to its < escape.
const jsLit = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// Team roster for the attribution dropdowns (lead owner / booked-by / reviewer):
// config/portalStaff.js (PORTAL_STAFF on Render + the consultants), built in adminShared.
const { STAFF_OPTS } = require('./adminShared');

// ─── The Consultations and Retainers pages ─────────────────────────────────────
// Two pages since 2026-11-05 (team meeting: "the Consultations page shows consultations only"):
//   /admin/consultations — booked consultations: the date range, the "Needs outcome" and "No date" folds;
//   /admin/retainers     — Retainers & follow-ups, with the "＋ Direct retainer client" pop-up.
// Both read /api/consultations-board (one read, cached on the server) and share their look and row
// helpers below. The Reporting figures live on the Summary page (adminDashboard.js). The old
// /admin/consultations?tab=… and ?outcome= / ?convertLead= / ?newAppFrom= links are redirected (the routes).

const LIST_PAGE_CSS = `
  body { background:#f1f5f9; }
  /* Full width (staff request 2026-09-09): the lists are wide tables — every
     column gets the screen, with just enough side padding to clear the edge. */
  .wrap { max-width:none; margin:0; padding:22px 14px 80px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .muted { color:var(--light); font-size:13px; }
  #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:14px 18px; border-radius:12px; margin:24px auto; max-width:520px; text-align:center; }
  #content { display:none; }
  .page-h { font-size:22px; font-weight:800; color:var(--navy); letter-spacing:-.5px; margin:0 0 4px; }
  .page-h .cnt { font-size:14px; font-weight:500; color:#94a3b8; margin-left:4px; }
  .page-sub { font-size:12px; color:#94a3b8; margin:0 0 14px; font-weight:500; line-height:1.5; }
  .card { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:var(--th-bg); text-align:left; padding:11px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:var(--th-fg); border-bottom:2px solid var(--th-line); }
  td { padding:12px 14px; border-bottom:1px solid #f8fafc; }
  tr.row { cursor:pointer; }
  tr.row:hover td { background:#f8faff; }
  tr.row:hover td:first-child { box-shadow:inset 3px 0 0 var(--st-blue-solid); }   /* the row under the pointer: a blue bar at its start */
  .pill { display:inline-flex; align-items:center; padding:2px 9px; border-radius:20px; font-size:10px; font-weight:700; }
  .pill.green { background:var(--st-green-bg); color:var(--st-green-fg); } .pill.grey { background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .pill.amber { background:var(--st-amber-bg); color:var(--st-amber-fg); } .pill.blue { background:var(--st-blue-bg); color:var(--st-blue-fg); }
  .pill.red { background:var(--st-red-bg); color:var(--st-red-fg); }
  .case-lnk { color:#2563eb; font-weight:600; text-decoration:none; white-space:nowrap; } .case-lnk:hover { text-decoration:underline; }
  .tier { font-weight:700; color:var(--navy); }
  .empty { padding:40px; text-align:center; color:#94a3b8; }
  .sec-h { font-size:15px; font-weight:800; color:var(--navy); margin:0; }
  /* The lists: the shared filter look (listFilters.js, 2026-11-05) — filters in the column headers, chips, one search box. */
  ${LIST_TABLE_CSS}
  /* The outcome tabs' counts in the outcome's colour (the same colours as the Outcome pills; Retained = purple). */
  #r-quick .lt-tab[data-quick="Retain"] { --tn-bg:var(--st-green-bg); --tn-fg:var(--st-green-fg); --tn-solid:var(--st-green-solid); }
  #r-quick .lt-tab[data-quick="Follow-Up"] { --tn-bg:var(--st-amber-bg); --tn-fg:var(--st-amber-fg); --tn-solid:var(--st-amber-solid); }
  #r-quick .lt-tab[data-quick="Not Wanted"] { --tn-bg:var(--st-red-bg); --tn-fg:var(--st-red-fg); --tn-solid:var(--st-red-solid); }
  #r-quick .lt-tab[data-quick="Retained"] { --tn-bg:var(--st-purple-bg); --tn-fg:var(--st-purple-fg); --tn-solid:var(--st-purple-solid); }
  .tbl-wrap table { min-width:1000px; }
  .page-top { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 4px; }
  /* "Updated n s ago · refresh": how old the copy of the board is */
  .age { font-size:11.5px; color:#94a3b8; }
  .age button { background:none; border:0; color:#2563eb; cursor:pointer; font:inherit; font-size:11.5px; padding:0 2px; }
  .q-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin:6px 0 10px; }
  .sec-sub { font-size:12px; color:#94a3b8; margin:0 0 10px; }
`;

const CONSULT_PAGE_CSS = `
  /* One table, five tabs: the Now column only on Completed and All; Completed has no delete button (deleting stays on the other tabs). */
  #cq-table:not(.tab-done):not(.tab-all) th:nth-child(11), #cq-table:not(.tab-done):not(.tab-all) td.c-now { display:none; }
  #cq-table.tab-done th:nth-child(12), #cq-table.tab-done td.c-del { display:none; }
  /* The Date filter narrows the booked consultations only (the Booked tab, and the booked rows of All): its chip is not shown on the other three tabs. */
  #content:not([data-ctab="booked"]):not([data-ctab="all"]) #cq-chips .q-chip:has([data-chip="date"]) { display:none; }
  /* …so there the Date column has no filter button, and a chip row holding nothing but the Date chip is not shown at all */
  #content:not([data-ctab="booked"]):not([data-ctab="all"]) #cq-headrow th:first-child .th-f { display:none; }
  #content:not([data-ctab="booked"]):not([data-ctab="all"]) #cq-chips:not(:has(.q-chip:not(:has([data-chip="date"])))) { display:none !important; }
  /* The Completed tab's month chooser */
  .cq-month { align-items:center; gap:6px; flex-wrap:wrap; margin:0 0 10px; }
  .cq-month .cm-l { font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:#64748b; margin-right:2px; }
  .cq-month select { border:1px solid #e2e8f0; border-radius:8px; padding:7px 10px; font:inherit; font-size:13px; font-weight:700; color:var(--navy); background:#fff; min-width:190px; }
  .cq-month .cm-b { border:1px solid #e2e8f0; border-radius:8px; background:#fff; color:var(--navy); padding:7px 10px; font:inherit; font-size:12px; cursor:pointer; line-height:1; }
  .cq-month .cm-b:hover:not(:disabled) { background:#f8fafc; }
  .cq-month .cm-b:disabled { opacity:.4; cursor:default; }
  .cq-month select:focus-visible, .cq-month .cm-b:focus-visible { outline:2px solid var(--st-focus); outline-offset:1px; }
  .time { font-variant-numeric:tabular-nums; white-space:nowrap; font-weight:600; color:var(--navy); }
  .time .d { font-weight:500; color:#64748b; }
`;

const RETAINERS_PAGE_CSS = `
  .btn-direct { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border:1px solid var(--navy); background:var(--navy); color:#fff; border-radius:9px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
  .btn-direct:hover { filter:brightness(1.12); }
  /* The outcome tabs (team meeting 2026-11-05, like the Leads page) use the shared tab look (listFilters.js .lt-tabs); the search sits under them, on the right. */
  .q-head.r-tools { justify-content:flex-end; margin-top:0; }
  /* New direct retainer client: the shared pop-up (dialogUi.js); the field look matches Add lead. */
  .dc-sub { font-size:12.5px; color:#64748b; margin:0 0 12px; line-height:1.45; }
  #dc-modal label { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:12px 0 4px; }
  #dc-modal textarea { width:100%; padding:8px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; color:var(--navy); background:#fff; box-sizing:border-box; resize:vertical; min-height:64px; }
  #dc-modal input, #dc-modal select { width:100%; padding:8px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; color:var(--navy); background:#fff; box-sizing:border-box; }
  .dc-hint { font-weight:500; text-transform:none; letter-spacing:0; }
  #dc-matches { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:10px 12px; margin-top:12px; font-size:12.5px; }
  #dc-matches .dcm-title { font-weight:700; color:#92400e; margin-bottom:6px; }
  /* .dcm-row also neutralises the #dc-modal label styling these radio labels would otherwise inherit */
  #dc-matches .dcm-row { display:flex; align-items:flex-start; gap:7px; padding:3px 0; color:#334155; text-transform:none; letter-spacing:0; font-weight:400; font-size:12.5px; margin:0; }
  #dc-matches .dcm-row input { margin-top:2px; flex:none; width:auto; }  /* the #dc-modal input width:100% must not stretch the radios */
  #dc-matches .dcm-info { color:#64748b; padding:2px 0 2px 21px; }
  #dc-matches .dcm-badge { display:inline-block; background:var(--st-red-bg); color:var(--st-red-fg); border-radius:6px; padding:0 6px; font-size:11px; font-weight:700; margin-left:4px; }
  #dc-matches a { color:#1d4ed8; }
  #dc-profile { background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:10px 12px; margin-top:12px; font-size:12.5px; color:#1e3a8a; }
  #dc-profile .dcp-title { font-weight:700; margin-bottom:4px; }
  #dc-profile .dcp-fact { color:#7c2d12; background:#fff7ed; border:1px solid #fed7aa; border-radius:6px; padding:6px 9px; margin-top:6px; }
  #dc-profile label.dcp-confirm { display:flex; align-items:flex-start; gap:7px; margin:8px 0 0; text-transform:none; letter-spacing:0; font-weight:600; font-size:12.5px; color:#1e3a8a; }
  #dc-profile label.dcp-confirm input { width:auto; margin-top:2px; flex:none; }
  /* The walk-in form's Source / Reference picker + attachments (shared pieces, 2026-11-04) */
  ${REFERRAL_CSS}
  ${ATTACH_CSS}
  ${DEADLINE_BOX_CSS}
  #dc-modal .dlx .al-l { display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#64748b; margin:12px 0 4px; font-weight:700; }
  #dc-modal .dlx .al-yn { display:flex; gap:18px; font-size:13.5px; margin:2px 0; }
  #dc-modal .dlx .al-yn label { display:flex; gap:6px; align-items:center; cursor:pointer; text-transform:none; letter-spacing:0; font-weight:400; margin:0; }
  #dc-modal .dlx input[type=date] { width:auto; }
  #dc-modal .dlx .al-yn input { width:auto; padding:0; border:0; border-radius:0; background:none; flex:none; }  /* the #dc-modal input width:100% must not stretch the radios */
  #dc-modal .al-hint, #dc-modal .dc-note { font-size:12px; color:#64748b; margin-top:3px; }
  #dc-modal .att-row input[type=file] { border:0; padding:6px 0; }
`;

// The "New direct retainer client" pop-up (the shared pop-up, dialogUi.js).
const DIRECT_CLIENT_HTML = `
  <!-- Direct retainer client (walk-in / referral — enters at the retainer stage) -->
  <div id="dc-overlay" class="tdlg-ov" hidden>
    <div id="dc-modal" class="tdlg" role="dialog" aria-modal="true" aria-labelledby="dc-title">
      <button type="button" class="tdlg-x" aria-label="Close">&times;</button>
      <div class="tdlg-body">
      <h3 id="dc-title">New direct retainer client</h3>
      <p class="dc-sub">Walk-in / referral entering at the retainer stage — no booking or consultation. Creates the client fully wired (case type → case reference &amp; checklist, consultant → agreement signatory &amp; case visibility), then opens the retainer panel.</p>
      <label for="dc-name">Full legal name *</label><input id="dc-name" type="text" maxlength="120" autocomplete="off">
      <label for="dc-email">Email</label><input id="dc-email" type="email" maxlength="200" autocomplete="off">
      <label for="dc-phone">Phone</label><input id="dc-phone" type="tel" maxlength="40" autocomplete="off">
      <div class="dc-note">An email <b>or</b> a phone number — one of the two is enough. Without an email the retainer agreement can’t be emailed until one is added.</div>
      <label for="dc-address">Residential address <span class="dc-hint">(optional now — it is printed on the retainer agreement, so add it before sending)</span></label><input id="dc-address" type="text" maxlength="500" autocomplete="off">
      <label for="dc-casetype">Case type *</label><select id="dc-casetype"><option value="">Choose…</option></select>
      <label for="dc-subtype">Case sub-type</label><select id="dc-subtype"><option value="">— (can be set later)</option></select>
      <label for="dc-consultant">Consultant *</label><select id="dc-consultant"><option value="">Choose…</option></select>
      <label for="dc-source">Source / Reference *</label>
      <select id="dc-source">${sourceOptionsHtml({ blank: true })}</select>${referralFieldsHtml('dc')}
      <label for="dc-notes">Notes * <span class="dc-hint">(what the client needs + the amount quoted · saved as an update on the client and their case in Monday)</span></label><textarea id="dc-notes" rows="3" maxlength="2000" placeholder="What the client needs, the amount quoted, documents mentioned, next steps…"></textarea>${attachFieldHtml('dc')}
      ${deadlineBoxHtml('dc', { required: true, title: 'Deadline', hint: 'Real: the actual deadline date. Imaginary: no real deadline — the submission date you promised the client (documents are needed 10–15 days before it). Lands on the case.' })}
      <div id="dc-profile" style="display:none" role="region" aria-label="Carried from previous application"></div>
      <div id="dc-blacklist" style="display:none"></div>
      <div id="dc-matches" style="display:none" role="region" aria-label="Possible existing records"></div>
      <div id="dc-err" class="tdlg-err" role="alert"></div>
      <div class="dc-actions">
        <button class="dc-btn" id="dc-cancel" type="button" data-x>Cancel</button>
        <button class="dc-btn primary" id="dc-create" type="button">Create &amp; open retainer</button>
      </div>
      </div>
    </div>
  </div>
`;

// Browser code the two pages share: escaping, the pills, the Toronto day, the "Updated … · refresh" line.
// Plain template text inside the pages' own template literals: no backtick, no dollar-brace; regexes double their backslashes.
const LIST_PAGE_JS = `
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function qpill(cls,txt){ return '<span class="pill '+cls+'">'+escHtml(txt)+'</span>'; }
function todayStr(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date()); }   // the Toronto day
/* Filters (the date range too) are kept only until this browser tab is closed (Faran 2026-11-05); Sign Out forgets them. */
function ssGet(k){ try { return sessionStorage.getItem(k)||''; } catch(e){ return ''; } }
function ssSet(k,v){ if(window.TDOT_SIGNED_OUT) return; try { sessionStorage.setItem(k,v); } catch(e){} }
/* The old one-page tabs (before 2026-11-05) kept these on the computer; nothing reads them now. */
try { ['tdot_consult_tab','tdot_consult_range','tdot_ret_outcomes'].forEach(function(k){ localStorage.removeItem(k); }); } catch(e){}
/* Paid: the booking link's own payment ("app", incl. HST), or what staff recorded on the
   consultation page — cash / e-transfer / invoice / other (the fee before HST) or waived. */
var PAID_LABELS={cash:'Cash','e-transfer':'E-transfer',square:'Paid in Square',invoice:'Invoice',other:'Paid (other)',waived:'Waived'};
function paidPill(c){
  var amt=(c.paidCents!=null&&c.paidCents>0)?' $'+(c.paidCents/100).toFixed(0):'';
  if(c.paid==='app') return qpill('green','Paid (app)'+amt);
  if(!c.paid) return '<span class="pill grey">—</span>';
  var label=Object.prototype.hasOwnProperty.call(PAID_LABELS,c.paid)?PAID_LABELS[c.paid]:String(c.paid);
  var who=c.paidBy?(' · recorded by '+c.paidBy+(c.paidVerified?'':' (name as typed)')+(c.paidOn?(' on '+c.paidOn):'')):'';
  return '<span class="pill '+(c.paid==='waived'?'grey':'green')+'" title="'+escHtml(label+who)+'">'+escHtml(label+amt)+'</span>';
}
function outcomeCell(c){
  var o=c.outcome, cls=o==='Retain'?'green':o==='Follow-Up'?'amber':o==='Not Wanted'?'red':'grey';
  var h=o?qpill(cls,o):'<span class="pill grey">—</span>';
  if(c.followUpDate) h+=' '+qpill(c.followUpDate<=todayStr()?'amber':'grey','follow-up '+c.followUpDate);
  return h;
}
function bindRowClicks(root,suffix){
  Array.prototype.forEach.call(root.querySelectorAll('tr.row'),function(tr){
    /* a link inside the row (the Retained tab's case number) goes where it says, not to the record */
    tr.onclick=function(e){ if(e && e.target && e.target.closest && e.target.closest('a')) return; window.location.href='/admin/consultation/'+encodeURIComponent(tr.getAttribute('data-id'))+(suffix||''); };
  });
}
function showAge(d){
  var el=document.getElementById('snap-age'); if(!el) return;
  var secs=Math.round((d.ageMs||0)/1000);
  el.innerHTML=(d.stale?'<span style="color:#b45309">Monday could not be read — showing the last copy, ':'<span>Updated ')+(secs<90?secs+' s ago':Math.round(secs/60)+' min ago')+'</span> · <button type="button" id="btn-refresh">refresh</button>';
  var b=document.getElementById('btn-refresh'); if(b) b.onclick=function(){ load(true); };
}
`;

// The Consultations page's own browser code: the calendar helpers, the date range, the three lists.
const CONSULT_PAGE_JS = `
/* ── Calendar-date helpers: 'YYYY-MM-DD' strings only, never a local Date (TZ-safe) ── */
function dParts(d){ var m=String(d||'').match(/^(\\d{4})-(\\d{2})-(\\d{2})/); return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null; }
function dAdd(d,n){ var p=dParts(d); if(!p) return d; var t=new Date(Date.UTC(p[0],p[1]-1,p[2]+n)); return t.toISOString().slice(0,10); }
function dDow(d){ var p=dParts(d); return p?new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay():0; }   // 0=Sun
function dMonthAdd(d,n){ var p=dParts(d); var t=new Date(Date.UTC(p[0],p[1]-1+n,1)); return t.toISOString().slice(0,10); }
function dLabel(d,withYear){ var p=dParts(d); if(!p) return ''; var t=new Date(Date.UTC(p[0],p[1]-1,p[2])); var o={timeZone:'UTC',weekday:'short',day:'numeric',month:'short'}; if(withYear) o.year='numeric'; return new Intl.DateTimeFormat('en-CA',o).format(t); }
/* The Date and Time cells (2026-11-11: the day has its own column, with the date filter in its header). */
function dateCell(c){
  var d=String(c.bookedSlot||'').slice(0,10); if(!dParts(d)) return '<span class="pill grey">no date</span>';
  var t=todayStr(), tag=d===t?'Today':d===dAdd(t,1)?'Tomorrow':'';
  return '<span class="time">'+escHtml(dLabel(d,d.slice(0,4)!==t.slice(0,4)))+'</span>'+(tag?' <span class="pill blue">'+tag+'</span>':'');
}
function timeCell(c){
  var slot=String(c.bookedSlot||''); var t=dParts(slot)?slot.slice(11,16):'';
  return t?'<span class="time">'+escHtml(t)+'</span>':'<span class="muted">—</span>';
}
/* A consultation added by hand with "＋ Direct consultation" (step 2): the "direct" pill, who booked it and its kind on hover. */
function directPill(c){
  if(!c.direct) return '';
  var tip=(c.bookedBy?'Booked by '+c.bookedBy+' · ':'')+(c.direct==='?'?'Direct consultation':c.direct);
  return ' <span class="pill grey dq-pill" title="'+escHtml(tip)+'" aria-label="Direct consultation: '+escHtml(tip)+'">direct</span>';
}
function rowHtml(c){
  var pc=c.preConsultSubmitted?qpill('green','Submitted'):qpill('amber','Pending');
  var oc=outcomeCell(c);   // the outcome, and a follow-up date amber once it is due (today or earlier)
  var ag=c.agreementSigned?qpill('green','Signed '+c.agreementSigned):c.agreementSent?qpill('blue','Sent '+c.agreementSent):'<span class="pill grey">—</span>';
  var pd=paidPill(c);
  return '<tr class="row" data-id="'+escHtml(c.id)+'">'+
    '<td>'+dateCell(c)+'</td><td>'+timeCell(c)+'</td>'+
    '<td style="font-weight:600;color:var(--navy)">'+escHtml(c.name)+directPill(c)+'</td>'+
    '<td style="color:var(--muted)">'+escHtml(c.service||'—')+'</td>'+
    '<td>'+escHtml(c.consultant||'—')+'</td>'+
    '<td>'+(c.meetingType?escHtml(c.meetingType):'—')+'</td>'+
    '<td>'+ag+'</td><td>'+pc+'</td><td>'+pd+'</td><td>'+oc+'</td><td class="c-now">'+(c.done?nowCell(c):'')+'</td>'+
    /* a completed consultation has no delete button here (the All tab too): a client with a case is deleted from the Retainers page */
    '<td class="c-del">'+(c.done?'':'<button class="del-btn" type="button" data-del-lead="'+escHtml(c.id)+'"'+(c.adminDelete?' data-del-admin-only="1"':'')+' title="Delete this record (careful — removes Monday rows and the OneDrive folder; if there is a case, the case and its folder go too)">'+TDOT_DEL_SVG+'</button>')+'</td></tr>';
}
/* The Consultations list (Faran 2026-11-12): four tabs — Booked · Needs outcome · Completed · No date — over ONE table,
   like the Leads page. The shared engine (listSpecs.js consultListSpec) owns the tabs, the header filters, the search
   and the sorting, and hands over the rows of the tab shown. This page adds: the Completed tab's month chooser (one
   month at a time, opening on the current month), the words above the table, and the latest-first order of the two
   tabs that look back. The Date filter narrows the Booked tab only (its chip is hidden on the other tabs). */
var TAB_TEXT={
  booked:{ h:'Booked consultations', sub:'Still to happen. The page opens on today — the Date column chooses other days; the × on the Date chip shows every date.', none:'No booked consultations right now.' },
  needs:{ h:'Needs outcome', sub:'The consultation day has passed and no outcome is recorded. Open each and set Retain / Follow-Up / Newsletter / Not Wanted.', none:'Nothing is waiting for an outcome.' },
  done:{ h:'Completed consultations', sub:'Every consultation stays here once it has an outcome — also after the client is retained and has a case. One month at a time, by the consultation day.', none:'No completed consultations yet.' },
  nodate:{ h:'No date', sub:'Marked Booked by hand with no consultation time. Open one to set its time, or delete it.', none:'No consultation is without a time.' },
  all:{ h:'All consultations', sub:'The four lists together, the latest first — every month, or one month from the Month list. The Date filter narrows the booked ones only; the × on the Date chip shows every booked consultation too.', none:'No consultations yet.' }
};
function consultTab(st){ var l=(st&&st.sel&&st.sel.tab)||[]; return !l.length?'all':(TAB_TEXT[l[0]]&&l[0]!=='all'?l[0]:'booked'); }
function monthOf(r){ var d=String(r.bookedSlot||'').slice(0,10); return dParts(d)?d.slice(0,7):'none'; }
function monthLabel(m){ var p=String(m).split('-'); if(p.length!==2) return 'No date'; return new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',month:'long',year:'numeric'}).format(new Date(Date.UTC(Number(p[0]),Number(p[1])-1,1))); }
function nowCell(c){
  var h='<span class="pill '+escHtml(c.nowTone||'grey')+'">'+escHtml(c.now||'—')+'</span>';
  if(c.caseRef) h+=' <a class="case-lnk" href="/admin/case/'+encodeURIComponent(c.caseRef)+'" title="Open the case">'+escHtml(c.caseRef)+'</a>';
  return h;
}
/* The Completed tab's month: the one chosen (kept for the browser tab), else the current month, else the latest with rows. */
/* The month chooser is on two tabs, each with its own kept choice (Faran 2026-11-12):
   Completed — one month at a time, opening on the current month; All — "All months" first, a month when chosen. */
var MONTH_PICK={ done:'', all:'' }, MONTH_KEY={ done:'tdot_list_consult_month', all:'tdot_list_consult_month_all' };
function tabMonths(tab){   /* every month with a consultation on that tab, newest first; the ones with no time last */
  var seen={}, out=[];
  ALLROWS.forEach(function(r){ if(tab==='done'&&!r.done) return; var m=monthOf(r); if(!seen[m]){ seen[m]=true; out.push(m); } });
  return out.sort(function(a,b){ return a==='none'?1:b==='none'?-1:b.localeCompare(a); });
}
function pickMonth(tab,months){
  if(!MONTH_PICK[tab]) MONTH_PICK[tab]=ssGet(MONTH_KEY[tab]);
  if(months.indexOf(MONTH_PICK[tab])>=0) return MONTH_PICK[tab];
  if(tab==='all') return 'all';   /* nothing chosen (or a month that has gone): every month */
  var cur=todayStr().slice(0,7);
  return months.indexOf(cur)>=0?cur:(months[0]||cur);
}
function setMonth(tab,m){ if(!MONTH_KEY[tab]) return; MONTH_PICK[tab]=m; ssSet(MONTH_KEY[tab],m); if(window.ConsultTable) ConsultTable.apply('data'); }
/* The month the table is showing now ('' = every month): the numbers inside a filter panel count that month only,
   so a choice's number is the number of rows ticking it leaves on screen (Faran 2026-11-12). */
var SHOWN_MONTH='';
function consultPanelRow(r){ return !SHOWN_MONTH||monthOf(r)===SHOWN_MONTH; }
function renderMonthBar(tab,months,month,counts,total){
  var bar=document.getElementById('cq-month'); if(!bar) return;
  if(!MONTH_KEY[tab]||!months.length){ bar.style.display='none'; bar.innerHTML=''; return; }
  var i=months.indexOf(month);   /* -1 on "All months" */
  var earlier=i<0?months[0]:(i<months.length-1?months[i+1]:''), later=i>0?months[i-1]:'';
  bar.style.display='flex';
  bar.innerHTML='<span class="cm-l" id="cq-month-l">Month</span>'+
    '<button type="button" class="cm-b" data-m="'+escHtml(earlier)+'"'+(earlier?'':' disabled')+' aria-label="Earlier month" title="Earlier month">&#9664;</button>'+
    '<select id="cq-month-sel" aria-labelledby="cq-month-l">'+(tab==='all'?'<option value="all"'+(month==='all'?' selected':'')+'>All months ('+total+')</option>':'')+
      months.map(function(m){ return '<option value="'+escHtml(m)+'"'+(m===month?' selected':'')+'>'+escHtml(monthLabel(m))+' ('+(counts[m]||0)+')</option>'; }).join('')+'</select>'+
    '<button type="button" class="cm-b" data-m="'+escHtml(later)+'"'+(later?'':' disabled')+' aria-label="Later month" title="Later month">&#9654;</button>';
  Array.prototype.forEach.call(bar.querySelectorAll('.cm-b'),function(b){ b.onclick=function(){ var m=b.getAttribute('data-m'); if(m) setMonth(tab,m); var again=document.querySelector('#cq-month .cm-b[aria-label="'+b.getAttribute('aria-label')+'"]'); if(again&&!again.disabled) again.focus(); else { var sel=document.getElementById('cq-month-sel'); if(sel) sel.focus(); } }; });
  var s=document.getElementById('cq-month-sel'); s.onchange=function(){ setMonth(tab,s.value); var again=document.getElementById('cq-month-sel'); if(again) again.focus(); };
}
/* Two filters belong to some tabs only, and are not on view on the others (review 2026-11-12) — so they must not act there:
   - "Now" is the Completed / All column: leaving for another tab takes its choice off (it would silently empty that tab).
   - the Date filter is the Booked / All one: on the other tabs its chip is hidden, so "Clear filters" there must not
     take it off unseen — it is put back as it was. */
var KEPT_DATE=null;
function consultOnChange(st){
  var tab=consultTab(st), again=false;
  if(tab==='booked'||tab==='all'||!KEPT_DATE) KEPT_DATE={ from:st.from||'', to:st.to||'' };
  else if((st.from||'')!==KEPT_DATE.from||(st.to||'')!==KEPT_DATE.to){ st.from=KEPT_DATE.from; st.to=KEPT_DATE.to; again=true; }
  if(tab!=='done'&&tab!=='all'&&st.sel&&st.sel.now){ delete st.sel.now; again=true; }
  if(again&&window.ConsultTable) ConsultTable.apply('data');   /* 'data': redraw and keep, without coming back here */
}
function renderConsultList(keep,why,st,h){
  var tab=consultTab(st), T=TAB_TEXT[tab], t=todayStr();
  if(!KEPT_DATE&&(tab==='booked'||tab==='all')) KEPT_DATE={ from:st.from||'', to:st.to||'' };
  var rows=keep, inTab=tab==='all'?ALLROWS.slice():ALLROWS.filter(function(r){ return window.ConsultTable?ConsultTable.core.valuesOf('tab',r)[0]===tab:true; });
  var months=[], month='', counts={};
  var total=keep.length;
  if(tab==='done'||tab==='all'){
    months=tabMonths(tab); month=pickMonth(tab,months);
    keep.forEach(function(r){ var m=monthOf(r); counts[m]=(counts[m]||0)+1; });
    /* The search or a filter finds nothing in the month on view but something in another: show the newest month that
       has a match (for now — the chosen month is kept), so a past client searched by name is never "not found". */
    if(month!=='all' && !counts[month] && keep.length){ var hit=months.filter(function(m){ return counts[m]; })[0]; if(hit) month=hit; }
    if(month!=='all'){
      rows=keep.filter(function(r){ return monthOf(r)===month; });
      inTab=inTab.filter(function(r){ return monthOf(r)===month; });
    }
  }
  /* the two tabs that look back: the latest consultation first — unless a column sort is chosen in the header */
  if((tab==='done'||tab==='needs'||tab==='all') && !(st&&st.sort&&st.sort.key)) rows=rows.slice().sort(function(a,b){ var x=String(a.bookedSlot||''), y=String(b.bookedSlot||''); return (x&&y)?y.localeCompare(x):x?-1:y?1:0; });   /* no time: last */
  var tbl=document.getElementById('cq-table'); if(tbl) tbl.className='tab-'+tab;
  var wrap=document.getElementById('content'); if(wrap) wrap.setAttribute('data-ctab',tab);
  var hd=document.getElementById('cq-title'); if(hd) hd.textContent=T.h+(month&&month!=='all'?' — '+monthLabel(month):'');
  var sb=document.getElementById('cq-sub'); if(sb) sb.textContent=T.sub;
  SHOWN_MONTH=(month&&month!=='all')?month:'';
  renderMonthBar(tab,months,month,counts,total);
  var tb=document.getElementById('qbody');
  if(!rows.length){
    /* Say why it is empty: nothing in this tab at all / nothing on the chosen day(s) or month / nothing passing the filters. */
    var dated=(tab==='booked')&&!!(st&&(st.from||st.to)), onlyToday=dated&&st.from===t&&st.to===t;
    var msg=!inTab.length?((tab==='done'||(tab==='all'&&month!=='all'))&&months.length?'No '+(tab==='done'?'completed ':'')+'consultations in '+monthLabel(month)+'.':tab==='booked'&&ALLROWS.some(function(r){ return ConsultTable.core.valuesOf('tab',r)[0]==='booked'; })&&dated?(onlyToday?'No consultations today. Remove the Date filter (the × on the Date chip above) to see every date.':'No consultations on these dates.'):T.none)
      :onlyToday?'No consultations today match — the Date filter is on Today. Remove it (the × on the Date chip above) to see every date.'
      :dated?'No consultations on these dates match your filters.'
      :(tab==='done'||(tab==='all'&&month!=='all'))?'No '+(tab==='done'?'completed ':'')+'consultations in '+monthLabel(month)+' match your filters.'
      :'Nothing here matches your filters.';
    tb.innerHTML='<tr><td colspan="12" class="empty">'+escHtml(msg)+'</td></tr>';
  }
  else tb.innerHTML=rows.map(rowHtml).join('');
  bindRowClicks(tb, (tab==='done'||tab==='all')?'?from=consultations':'');   /* a completed record's back link returns here */
  return { shown: rows.length, total: inTab.length };
}
`;

// The Retainers page's own browser code: the outcome buttons' link + address, the list, the pop-up.
const RETAINERS_PAGE_JS = `
function dParts(d){ var m=String(d||'').match(/^(\\d{4})-(\\d{2})-(\\d{2})/); return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null; }
/* The Retainers outcome tabs (above the table, like the Leads page — team meeting 2026-11-05) are the shared engine's
   "quick" facet in tabs mode (listSpecs.js retainerListOpts): one at a time, counts from the other filters, "All" last.
   A new browser tab opens on Retain and the tab shown is kept until it is closed — a tab opened from a link too, so the
   way back from a client's record returns to it. A link opens a tab (/admin/retainers?outcome=Follow-Up; ?outcome=All or
   a bare ?outcome= opens All; an old link naming several opens the first); a link naming no outcome we know is not a link.
   The address always names the tab shown (All too), so a saved or shared address opens the same tab.
   Retained (2026-11-05, point 8) comes after All and is never counted in it: All = everyone still being worked. */
function cleanOutcomes(list){ var out=[]; (list||[]).forEach(function(v){ v=String(v||'').trim(); if(RET_TABS.indexOf(v)>=0 && out.indexOf(v)<0) out.push(v); }); return out; }
function retInitial(st){ var p=new URLSearchParams(window.location.search).get('outcome'); if(p===null) return false; var t=String(p).trim(); if(!t || t.toLowerCase()==='all'){ delete st.sel.outcome; return true; } var l=cleanOutcomes(t.split(',')); if(!l.length) return false; st.sel.outcome=[l[0]]; return true; }
function retOnChange(st){
  var l=(st.sel&&st.sel.outcome)||[];
  try { var u=new URL(window.location.href); u.searchParams.set('outcome',l.length?l[0]:'All'); history.replaceState(null,'',u.toString()); } catch(e){}
}
/* The Retainers list: the shared engine hands over the rows that pass (the header filters, the search, the outcome tab).
   The count beside the heading is out of the rows of that kind: the retained ones on the Retained tab, everyone
   still being worked on the others. */
function retCase(c){
  /* The Retained tab's Case column: the case number (a link to the case), else what is known. */
  if(c.caseDeleted) return '<span class="pill amber" title="The case was deleted on '+escHtml(c.caseDeleted)+' — this consultation record was kept">Case deleted</span>';
  if(c.caseRef) return '<a class="case-lnk" href="/admin/case/'+encodeURIComponent(c.caseRef)+'" title="Open the case">'+escHtml(c.caseRef)+'</a>';
  if(c.caseFound===false) return '<span class="pill grey" title="This client is linked to a case row that is not on the Cases board any more">Case not found</span>';
  if(c.caseOpen) return qpill('green','Open');
  return '<span class="pill amber" title="Retained, but no case is linked — check the Client Master page">No case</span>';
}
function renderRetainerList(rows,why,st,h){
  var t=todayStr(), tp=dParts(t);
  var rout=(st&&st.sel&&st.sel.outcome)||[], base=h?h.without('outcome'):rows.length;
  var onRetained=rout.indexOf(RET_APART[0])>=0;
  var kindTotal=RETAINERS.filter(function(r){ return !!r.retained===onRetained; }).length;
  var tb=document.getElementById('rbody');
  if(!rows.length){ tb.innerHTML='<tr><td colspan="12" class="empty">'+(!RETAINERS.length?'Nobody here right now.':(rout.length && base)?'Nobody in “'+escHtml(rout.join(' or '))+'”'+(base!==RETAINERS.length?' with these filters':'')+' right now.':'No clients match your filters.')+'</td></tr>'; return { shown: 0, total: kindTotal }; }
  function age(d){ var p=dParts(d); if(!p||!tp) return ''; var days=Math.round((Date.UTC(tp[0],tp[1]-1,tp[2])-Date.UTC(p[0],p[1]-1,p[2]))/86400000); return days>0?' <span class="muted">('+days+'d)</span>':''; }
  tb.innerHTML=rows.map(function(c){
    var stc=(c.stage==='Paid'||c.stage==='Signed')?'green':c.stage==='Sent'?'blue':'amber';   /* signed = done (green), as on the case page; sent = blue */
    var cs=c.retained?retCase(c):c.caseDeleted?retCase(c):c.caseOpen?qpill('green','Open'):c.stage?qpill('grey','Pending'):'<span class="pill grey">—</span>';   // no retainer under way: no case coming yet
    return '<tr class="row" data-id="'+escHtml(c.id)+'">'+
      '<td style="font-weight:600;color:var(--navy)">'+escHtml(c.name)+(c.kind==='direct'?(c.originalChannel?' <span class="pill grey" title="Converted from a '+escHtml(c.originalChannel)+' lead — no consultation">direct · '+escHtml(c.originalChannel)+'</span>':(c.directSource?' <span class="pill grey" title="Direct retainer client — came through '+escHtml(c.directSource)+'; no consultation">direct · '+escHtml(c.directSource)+'</span>':' <span class="pill grey" title="Walk-in / referral — no consultation">direct</span>')):'')+
        /* No email (2026-11-04): the retainer agreement cannot go out until one is added — shown until it is sent. */
        ((c.hasEmail===false && !c.retainerSent)?' <span class="pill amber" title="No email address — the retainer agreement cannot be emailed until one is added on the lead page">No email</span>':'')+'</td>'+
      '<td style="color:var(--muted)">'+escHtml(c.caseType||'—')+'</td>'+
      '<td>'+escHtml(c.consultant||'—')+'</td>'+
      '<td>'+outcomeCell(c)+'</td>'+
      '<td>'+((c.kind==='direct' && !c.paid)?'<span class="pill grey" title="Direct retainer client — no consultation">n/a</span>':paidPill(c))+'</td>'+
      '<td>'+(c.fee?'$'+escHtml(c.fee):'—')+'</td>'+
      '<td>'+(c.retainerSent?escHtml(c.retainerSent)+(c.retainerSigned?'':age(c.retainerSent)):'—')+'</td>'+
      '<td>'+(c.retainerSigned?escHtml(c.retainerSigned):'—')+'</td>'+
      '<td>'+(c.retainerPaid?escHtml(c.retainerPaid):'—')+'</td>'+
      '<td>'+(c.stage?qpill(stc,c.stage):'<span class="pill grey">—</span>')+'</td><td>'+cs+'</td>'+
      /* No bin on a retained client WITH a case (that is deleted on the Client Master page, which keeps this record); one whose
         case is gone (deleted — the record kept — or never opened) has it: the explicit "delete the record" (review 2026-11-05). */
      '<td>'+((c.retained && c.clientMasterItemId && c.caseFound!==false)?'':'<button class="del-btn" type="button" data-del-lead="'+escHtml(c.id)+'"'+(c.adminDelete?' data-del-admin-only="1"':'')+(c.retained?' data-del-record-only="1" title="Delete this consultation record and its OneDrive folder (careful — a folder carrying a case number is kept; refused while the client’s case is still on the Cases board: delete the case there first)"':' title="Delete this client, their consultation record and their OneDrive folder (careful — if there is a case, the case and its checklist go too)"')+'>'+TDOT_DEL_SVG+'</button>')+'</td></tr>';
  }).join('');
  bindRowClicks(tb,'?from=retainers');   /* the record's back link comes back here */
  return { shown: rows.length, total: kindTotal };
}
/* ── Direct retainer client (walk-in / referral) ── */
var DC_OPTS=null;
${BLACKLIST_UI_JS}
function dcEl(id){ return document.getElementById(id); }
var DC_DLG=null;   /* the shared pop-up (dialogUi.js): ×, Cancel, Escape; an outside click only while nothing is typed; no closing while saving */
function dcDlg(){ if(!DC_DLG) DC_DLG=tdotDialog(dcEl('dc-overlay'),{ slowText:'Still waiting for an answer. You can close this window, but check the Retainers list before trying again, so the client is not added twice.' }); return DC_DLG; }
/* The Not Wanted list (point 5): the server answers 409 with the warning; with no duplicate
   panel to choose from, an explicit tick is the "create anyway". A warning only. */
var DC_BL_HIT=false;
function dcRenderBlacklist(r){
  var box=dcEl('dc-blacklist'); if(!box) return;
  DC_BL_HIT=!!(r&&r.hit);
  var html=tdotBlacklistHtml(r,{leadLinks:true});
  if(!html){ box.style.display='none'; box.innerHTML=''; return; }
  box.innerHTML=html+(DC_BL_HIT?'<label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#991b1b;margin:-6px 0 12px"><input type="checkbox" id="dc-bl-ack" style="margin-top:2px"> I have read the warning — set this person up as a direct retainer client anyway</label>':'');
  box.style.display='block';
}
function openDirectClient(){
  dcEl('dc-err').textContent='';
  // Clear every field FIRST — the modal is a singleton, and a carried
  // ?newAppFrom / ?convertLead prefill or a prior walk-in's typed values would
  // otherwise persist into the next opening and be saved on the wrong client
  // (a stale address prints on their retainer). The boot prefill runs AFTER
  // this and re-populates intentionally.
  ['dc-name','dc-email','dc-phone','dc-address','dc-notes'].forEach(function(id){ var e=dcEl(id); if(e) e.value=''; });
  ['dc-casetype','dc-subtype','dc-consultant','dc-source'].forEach(function(id){ var e=dcEl(id); if(e) e.selectedIndex=0; });
  DC_REF.reset(); DC_ATT.reset(); DC_ATT.refresh(); DC_PROFILE_ADDR=''; DC_DL.reset();
  DC_MATCHES=null; DC_MATCH_SEQ++; var mb=dcEl('dc-matches'); if(mb){ mb.style.display='none'; mb.innerHTML=''; }   /* the seq: a lookup still out for the last person never lands here */
  var cb=dcEl('dc-create'); if(cb){ cb.disabled=false; cb.textContent='Create & open retainer'; }
  DC_BL_HIT=false; var blb=dcEl('dc-blacklist'); if(blb){ blb.style.display='none'; blb.innerHTML=''; }
  // A carried profile / lead conversion belongs to ONE opening of the modal —
  // reopening it for a different walk-in must never stamp the previous
  // client's case/family or link the previous lead.
  // (The ?newAppFrom / ?convertLead boots call openDirectClient FIRST.)
  DC_PROFILE_REF=null; DC_CONVERT_LEAD_ID=null;
  var pb=dcEl('dc-profile'); if(pb){ pb.style.display='none'; pb.innerHTML=''; }
  dcDlg().open();
  var first=dcEl('dc-name'); if(first) first.focus();
  if(DC_OPTS) return;
  var key=getKey(); if(!key) return;
  fetch('/api/consultation/direct-client/options',{headers:{'X-Api-Key':key}})
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(o){
      DC_OPTS=o;
      dcEl('dc-casetype').innerHTML='<option value="">Choose…</option>'+(o.caseTypes||[]).map(function(c){return '<option value="'+escHtml(c)+'">'+escHtml(c)+'</option>';}).join('');
      dcEl('dc-consultant').innerHTML='<option value="">Choose…</option>'+(o.consultants||[]).map(function(c){return '<option value="'+escHtml(c)+'">'+escHtml(c)+'</option>';}).join('');
    })
    .catch(function(){ dcEl('dc-err').textContent='Could not load the case-type list — close and reopen to retry.'; });
}
function dcSubtypes(){
  var ct=dcEl('dc-casetype').value;
  var subs=(DC_OPTS&&DC_OPTS.subTypesByCase&&DC_OPTS.subTypesByCase[ct])||[];
  // Required when the case type has variants — a blank sub-type blocks the
  // document checklist, so it must be chosen up front.
  dcEl('dc-subtype').innerHTML='<option value="">'+(subs.length?'Choose… (required)':'— (none for this case type)')+'</option>'+subs.map(function(s){return '<option value="'+escHtml(s)+'">'+escHtml(s)+'</option>';}).join('');
}
/* ── Warn-and-link: surface existing records for this email/phone ── */
var DC_MATCHES=null;
function dcRenderMatches(m){
  // Converting a lead (Leads page, Convert to direct retainer): THAT lead is the
  // record being kept, so it is never shown as a duplicate of itself (Gauri
  // 2026-10-08: the "already exists, merge?" prompt about the very lead being
  // converted). A client account for the same person is expected. Anything else
  // found (another lead, an open case) is shown as a note only; the conversion
  // stays linked to this lead and no choice is asked for.
  if(m && DC_CONVERT_LEAD_ID){
    var conv=String(DC_CONVERT_LEAD_ID);
    var otherLeads=(m.leads||[]).filter(function(l){ return String(l.id)!==conv; });
    var cbox=dcEl('dc-matches');
    DC_MATCHES=null;
    if(!otherLeads.length && !(m.cases&&m.cases.length)){ cbox.style.display='none'; cbox.innerHTML=''; return; }
    var notes=[];
    (m.cases||[]).forEach(function(c){
      notes.push('<div class="dcm-info">Open case: <a href="/admin/case/'+encodeURIComponent(c.caseRef)+'" target="_blank" rel="noopener">'+escHtml(c.caseRef||'(ref pending)')+'</a> — '+escHtml(c.name)+(c.caseStage?' · '+escHtml(c.caseStage):'')+'. If this is the same matter, work in the case instead.</div>');
    });
    otherLeads.forEach(function(l){
      notes.push('<div class="dcm-info">Another lead: '+escHtml(l.name)+(l.email?' &middot; '+escHtml(l.email):'')+(l.sourceChannel?' ('+escHtml(l.sourceChannel)+')':'')+'</div>');
    });
    cbox.innerHTML='<div class="dcm-title">This email/phone also appears below — check it is not the same matter. The conversion keeps lead '+escHtml(conv)+' as the one record.</div>'+notes.join('');
    cbox.style.display='block';
    return;
  }
  DC_MATCHES=m;
  var box=dcEl('dc-matches');
  var any=m && ((m.leads&&m.leads.length)||(m.cases&&m.cases.length)||(m.clients&&m.clients.length));
  if(!any){ box.style.display='none'; box.innerHTML=''; DC_MATCHES=null; return; }
  var rows=[];
  (m.clients||[]).forEach(function(c){
    rows.push('<div class="dcm-info">Client account: '+escHtml(c.name)+(c.reasons&&c.reasons.length?' <span class="dcm-badge">'+escHtml(c.reasons.join(', '))+'</span>':'')+'</div>');
  });
  (m.cases||[]).forEach(function(c){
    rows.push('<div class="dcm-info">Open case: <a href="/admin/case/'+encodeURIComponent(c.caseRef)+'" target="_blank" rel="noopener">'+escHtml(c.caseRef||'(ref pending)')+'</a> — '+escHtml(c.name)+(c.caseStage?' · '+escHtml(c.caseStage):'')+'. If this is the same matter, work in the case instead of creating a new client.</div>');
  });
  (m.leads||[]).forEach(function(l){
    var linkable=!l.hasCase && !l.retainerSent && !l.booked && !l.planInProgress && l.conversionStatus!=='Retained';
    var ident=escHtml(l.name)+(l.email?' &middot; '+escHtml(l.email):'')+(l.sourceChannel?' ('+escHtml(l.sourceChannel)+')':'')+(l.direct?' &middot; direct retainer client':'');
    if(linkable){
      rows.push('<label class="dcm-row"><input type="radio" name="dcm-choice" value="link:'+escHtml(l.id)+'"><span>Link to existing lead — <b>'+ident+'</b> — keeps ONE record for this person</span></label>');
    } else {
      var why=l.hasCase?'already has a case':l.retainerSent?'retainer already sent':l.booked?'has a consultation booked — manage it from the Consultations page':l.planInProgress?'retainer plan in progress':'retained';
      rows.push('<div class="dcm-info">Existing lead: '+ident+' — '+why+'</div>');
    }
  });
  rows.push('<label class="dcm-row"><input type="radio" name="dcm-choice" value="new"><span>Create a new client anyway (I checked — this is a different person or a genuinely new matter)</span></label>');
  box.innerHTML='<div class="dcm-title">&#9888; This email/phone already exists in the system — choose how to proceed:</div>'+rows.join('');
  box.style.display='block';
  // The duplicate panel takes precedence over a boot-time lead conversion —
  // exactly ONE link-choosing UI may be visible, so drop the pre-link and its
  // banner; the converting lead reappears above as an explicit radio option.
  if(DC_CONVERT_LEAD_ID){
    DC_CONVERT_LEAD_ID=null;
    var pb=dcEl('dc-profile'); if(pb){ pb.style.display='none'; pb.innerHTML=''; }
  }
}
/* ── "New application" prefill (?newAppFrom=CASE-REF) ── */
var DC_PROFILE_REF=null;
function dcApplyProfile(ref,p){
  DC_PROFILE_REF=ref;
  var id=p.identity||{};
  var set=function(elId,v){ var el=dcEl(elId); if(el && v && !el.value) el.value=v; };
  set('dc-name', id.fullName||'');
  set('dc-email', id.email||'');
  set('dc-phone', id.phone||'');
  set('dc-address', id.address||'');
  var meta=(p.fieldMeta&&p.fieldMeta.address)||null;
  // Count only the roles the retainer draft actually carries (server filters
  // to the retainer family types) — the shown number must match what lands.
  var famN=(p.family||[]).filter(function(m){ return ['Spouse','DependentChild','Parent','Sibling','Sponsor'].indexOf(m.role)>=0; }).length;
  var rows=['<div class="dcp-title">Carried from previous application '+escHtml(ref)+' — review everything before creating</div>'];
  if(meta){
    rows.push('<div>Address from '+escHtml(meta.origin)+(meta.savedAt?' (saved '+escHtml(String(meta.savedAt).slice(0,10))+')':'')+(meta.stale?' — <b>over a year old</b>':'')+'</div>');
  }
  if(famN) rows.push('<div>'+famN+' family member'+(famN>1?'s':'')+' carried — confirm the roster in the retainer panel before sending.</div>');
  rows.push('<div>Immigration status and expiry are NEVER carried — they must be re-asked in the new questionnaire.</div>');
  var pf=p.priorFacts||{};
  if(pf.hadRefusal) rows.push('<div class="dcp-fact">⚠ Refusal on file'+(pf.refusalType?' ('+escHtml(pf.refusalType)+(pf.refusalDate?', '+escHtml(pf.refusalDate):'')+')':'')+' — ensure the new application discloses it.</div>');
  (pf.openCases||[]).forEach(function(c){ rows.push('<div class="dcp-fact">This client also has open case '+escHtml(c.caseRef)+(c.caseStage?' ('+escHtml(c.caseStage)+')':'')+'.</div>'); });
  /* as the one-line box holds it: line breaks dropped, or a carried two-line address would never ask for the tick */
  DC_PROFILE_ADDR=String(id.address||'').split(String.fromCharCode(13)).join('').split(String.fromCharCode(10)).join('');
  if(id.address) rows.push('<label class="dcp-confirm"><input type="checkbox" id="dcp-addr-ok"><span>I confirmed the residential address is CURRENT with the client (it prints on the retainer agreement)</span></label>');
  var box=dcEl('dc-profile'); box.innerHTML=rows.join(''); box.style.display='block';
}
function dcLoadProfile(ref){
  var key=sessionStorage.getItem('tdot_admin_key'); if(!key) return;
  var run=dcDlg().openId;
  fetch('/api/consultation/client-profile?caseRef='+encodeURIComponent(ref),{headers:{'X-Api-Key':key}})
    .then(function(r){ return r.ok?r.json():null; })
    .then(function(p){ if(!dcDlg().still(run)) return; if(p){ dcApplyProfile(ref,p); dcCheckMatches(); } })
    .catch(function(){ /* staff can still fill the form by hand */ });
}
var DC_MATCH_SEQ=0;
function dcClearMatches(){
  // Any edit to the identity fields invalidates the panel AND the chosen
  // radio — a stale "link" choice must never target the previous person.
  DC_MATCHES=null; DC_MATCH_SEQ++;
  var box=dcEl('dc-matches'); if(box){ box.style.display='none'; box.innerHTML=''; }
  DC_BL_HIT=false; var blb=dcEl('dc-blacklist'); if(blb){ blb.style.display='none'; blb.innerHTML=''; }
  // Same rule for a lead conversion: editing email/phone may mean a different
  // person — drop the pre-linked lead and let the duplicate check re-offer it.
  if(DC_CONVERT_LEAD_ID){
    DC_CONVERT_LEAD_ID=null;
    var pb=dcEl('dc-profile'); if(pb){ pb.style.display='none'; pb.innerHTML=''; }
  }
}
/* ── Lead → direct retainer conversion (?convertLead=<leadId>) ── */
var DC_CONVERT_LEAD_ID=null;
function dcLoadConvertLead(leadId){
  var key=getKey(); if(!key) return;
  var run=dcDlg().openId;
  fetch('/api/lead/'+encodeURIComponent(leadId),{headers:{'X-Api-Key':key}})
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(d){
      if(!dcDlg().still(run)) return;   /* closed or reopened for someone else meanwhile */
      var set=function(elId,v){ var el=dcEl(elId); if(el && v && !el.value) el.value=v; };
      set('dc-name', d.name||'');
      set('dc-email', d.email||'');
      set('dc-phone', d.phone||'');
      set('dc-address', d.address||'');
      /* How they first reached us carries over as the Source / Reference (and its referrer) — staff can change it. */
      var srcSel=dcEl('dc-source'), lsrc=String(d.sourceChannel||'');
      if(srcSel && !srcSel.value && lsrc && [].some.call(srcSel.options,function(o){ return o.value===lsrc; })){ srcSel.value=lsrc; DC_REF.load(lsrc, d.referredBy||''); }
      /* The deadline the lead already holds is shown in the box — staff confirm or change it, never retype it blind. */
      if(d.deadline && d.deadline.set && DC_DL.blank()) DC_DL.set(d.deadline);
      DC_CONVERT_LEAD_ID=String(leadId);
      var box=dcEl('dc-profile');
      if(box){
        box.innerHTML='<div class="dcp-title">Converting lead '+escHtml(String(leadId))+' ('+escHtml(d.name||'')+') to a direct retainer client</div>'
          +'<div>The EXISTING lead row is reused — no duplicate is created. Pick the case type and consultant, then create; the retainer panel opens next.</div>';
        box.style.display='block';
      }
    })
    .catch(function(){ if(!dcDlg().still(run)) return; var err=dcEl('dc-err'); if(err) err.textContent='Could not load that lead — fill the fields manually (the duplicate check will still offer to link it).'; });
}
function dcCheckMatches(){
  var email=(dcEl('dc-email').value||'').trim(), phone=(dcEl('dc-phone').value||'').trim();
  if(!email && !phone) return;
  var key=sessionStorage.getItem('tdot_admin_key'); if(!key) return;
  var seq=++DC_MATCH_SEQ;
  fetch('/api/consultation/client-matches?email='+encodeURIComponent(email)+'&phone='+encodeURIComponent(phone),{headers:{'X-Api-Key':key}})
    .then(function(r){ return r.ok?r.json():null; })
    .then(function(m){ if(m && seq===DC_MATCH_SEQ){ dcRenderMatches(m); dcRenderBlacklist(m.blacklist); } })
    .catch(function(){ /* the server-side 409 guard still protects the submit */ });
}
function dcChosen(){
  var sel=document.querySelector('input[name="dcm-choice"]:checked');
  return sel?sel.value:null;
}
function submitDirectClient(){
  var err=dcEl('dc-err'); err.textContent='';
  var body={ fullName:dcEl('dc-name').value, email:dcEl('dc-email').value, phone:dcEl('dc-phone').value,
             residentialAddress:dcEl('dc-address').value, caseType:dcEl('dc-casetype').value,
             caseSubType:dcEl('dc-subtype').value, consultant:dcEl('dc-consultant').value,
             sourceChannel:dcEl('dc-source').value, referredBy:DC_REF.value(), referredFrom:DC_REF.from(),
             notes:dcEl('dc-notes').value };
  var dlv=DC_DL.read(); body.deadlineType=dlv.deadlineType; body.actualDeadline=dlv.actualDeadline; body.promisedSubmissionDate=dlv.promisedSubmissionDate;
  /* Required (Faran 2026-11-04): the name, an email OR a phone, the case type, the consultant, the source / reference
     (+ who referred them, for a referral) and a note. The address is optional now. The server checks the same. */
  if(body.fullName.trim().length<2){ err.textContent='Enter the client'+String.fromCharCode(8217)+'s full legal name.'; dcEl('dc-name').focus(); return; }
  if(!body.email.trim() && !body.phone.trim()){ err.textContent='Enter an email or a phone number — one of the two is required.'; dcEl('dc-email').focus(); return; }
  if(body.email.trim() && !/^[^ @]+@[^ @]+[.][^ @]+$/.test(body.email.trim())){ err.textContent='That email doesn'+String.fromCharCode(8217)+'t look right — fix it or leave it empty.'; dcEl('dc-email').focus(); return; }
  if(body.phone.trim() && body.phone.replace(/[^0-9]/g,'').length<7){ err.textContent='That phone number is too short — fix it or leave it empty.'; dcEl('dc-phone').focus(); return; }
  if(body.residentialAddress.trim() && body.residentialAddress.trim().length<5){ err.textContent='That address looks too short — enter the full address or leave it empty.'; dcEl('dc-address').focus(); return; }
  if(!body.caseType){ err.textContent='Choose the case type.'; dcEl('dc-casetype').focus(); return; }
  if(!body.consultant){ err.textContent='Choose the consultant.'; dcEl('dc-consultant').focus(); return; }
  if(!body.sourceChannel){ err.textContent='Choose the source / reference.'; dcEl('dc-source').focus(); return; }
  var refErr=DC_REF.check(); if(refErr){ err.textContent=refErr; DC_REF.focus(); return; }
  if(body.notes.trim().length<3){ err.textContent='Add a note — what the client needs and the amount quoted.'; dcEl('dc-notes').focus(); return; }
  var dlErr=DC_DL.check(!DC_OPTS || DC_OPTS.deadlineRequired!==false); if(dlErr){ err.textContent=dlErr; DC_DL.focus(); return; }
  var attErr=DC_ATT.check(); if(attErr){ err.textContent=attErr; return; }
  var subOpts=(DC_OPTS&&DC_OPTS.subTypesByCase&&DC_OPTS.subTypesByCase[body.caseType])||[];
  if(subOpts.length && !body.caseSubType){
    err.textContent='This case type has checklist variants — choose the Case Sub Type.'; return;
  }
  // Carried-profile flow: the address prints on the retainer — an explicit
  // confirmation is mandatory before a carried address may be used.
  if(DC_PROFILE_REF){
    var ok=dcEl('dcp-addr-ok');
    /* Asked only while the box still shows the CARRIED address: cleared = nothing to confirm; retyped = typing it is the confirmation. */
    var carriedShown=!!DC_PROFILE_ADDR && body.residentialAddress.trim()===DC_PROFILE_ADDR.trim();
    if(ok && carriedShown && !ok.checked){ err.textContent='Confirm the residential address is current with the client (checkbox above) — it prints on the retainer agreement.'; return; }
    body.profileSourceCaseRef=DC_PROFILE_REF;
  }
  // Duplicate panel showing → a choice is mandatory before submitting.
  if(DC_MATCHES){
    var choice=dcChosen();
    if(!choice){ err.textContent='Possible existing records found — choose "link to existing" or "create new anyway" above.'; return; }
    if(choice.indexOf('link:')===0) body.linkLeadId=choice.slice(5);
    else body.allowDuplicate=true;
  } else if(DC_CONVERT_LEAD_ID){
    // Boot-time conversion (?convertLead): the link target was chosen by the
    // staff member on the Leads page; an explicit radio only overrides it.
    body.linkLeadId=DC_CONVERT_LEAD_ID;
  } else if(DC_BL_HIT){
    body.allowDuplicate=true;   /* the list hit is the only reason for the stop — no duplicate panel to choose from */
  }
  if(DC_BL_HIT){
    var ack=dcEl('dc-bl-ack');
    if(!(ack&&ack.checked)){ err.textContent='This person is on the Not Wanted list — tick the box above if you mean to set them up anyway.'; return; }
    body.blacklistAck=true;
  }
  var key=getKey(); if(!key) return;
  var dlg=dcDlg(), run=dlg.openId;   /* this opening — a late answer for an earlier client is never painted into the form */
  var who=body.fullName.trim(), hadFiles=DC_ATT.files().length;
  var btn=dcEl('dc-create'); btn.disabled=true; btn.textContent='Creating…'; dlg.setBusy(true);
  fetch('/api/consultation/direct-client',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
    .then(function(res){
      if(!dlg.still(run)){   /* closed after the long wait: never painted into a later opening — but the outcome is told, not lost */
        if(res.s!==200 || !res.j) return;
        if(res.j.warning) window.alert(who+': '+res.j.warning);
        else if(res.j.linked) window.alert(who+': linked to the existing lead — one record for this person, now set up as a direct retainer client.');
        else if(res.j.reused) window.alert(who+': already exists as a direct retainer lead — no duplicate was created.');
        if(hadFiles && dlg.openId===run && DC_ATT.files().length){   /* closed, not reopened: the files picked are still this client's */
          DC_ATT.upload(res.j.leadId).then(function(o){ if(o.failed.length) window.alert(who+' was created. '+o.failed.length+' file(s) were not attached — add them from the client'+String.fromCharCode(8217)+'s lead page:'+String.fromCharCode(10)+o.failed.map(function(x){ return '• '+x.name+' — '+x.error; }).join(String.fromCharCode(10))); load(true); });
          return;
        }
        if(hadFiles) window.alert(who+' was created, but the attached file(s) were not saved — add them from the client'+String.fromCharCode(8217)+'s lead page.');
        load(true); return;
      }
      if(res.s!==200) dlg.setBusy(false);
      if(res.s===409 && res.j && res.j.matches){
        // The server found matches the modal hadn't fetched yet — show them (and the Not Wanted warning, if any).
        dcRenderMatches(res.j.matches);
        dcRenderBlacklist(res.j.blacklist);
        btn.disabled=false; btn.textContent='Create & open retainer';
        err.textContent=res.j.error||'This client may already exist — choose an option above.';
        return;
      }
      if(res.s!==200) throw new Error((res.j&&res.j.error)||('HTTP '+res.s));
      // warning = created but the tagging write failed (a note on the lead has
      // the manual steps); reused = an identical un-retained direct lead already
      // existed. Either way, land on the lead — never invite a re-create.
      if(res.j.warning) window.alert(res.j.warning);
      else if(res.j.linked) window.alert('Linked to the existing lead — one record for this person, now set up as a direct retainer client.');
      else if(res.j.reused) window.alert('This client already exists as a direct retainer lead — opening it instead of creating a duplicate.');
      /* The client exists: attach the chosen files now (a failed file never undoes the client), then open it. */
      /* Saved: the window closes BEFORE the page moves on — Back must never bring this client's filled form back. */
      var go=function(){ if(!dlg.still(run)){ load(true); return; } dlg.close(true); window.location.href='/admin/consultation/'+encodeURIComponent(res.j.leadId)+'?from=retainers'; };
      if(!DC_ATT.files().length) return go();
      btn.textContent='Attaching…';
      return DC_ATT.upload(res.j.leadId).then(function(o){
        if(o.failed.length) window.alert(who+' was created. '+o.failed.length+' file(s) were not attached — add them from the client'+String.fromCharCode(8217)+'s lead page:'+String.fromCharCode(10)+o.failed.map(function(x){ return '• '+x.name+' — '+x.error; }).join(String.fromCharCode(10)));
        go();
      });
    })
    .catch(function(e){ if(!dlg.still(run)) return; dlg.setBusy(false); btn.disabled=false; btn.textContent='Create & open retainer'; err.textContent=e.message||'Creation failed — try again.'; });
}
(function initDirectClient(){
  var b=dcEl('btn-direct-client'); if(b) b.onclick=openDirectClient;
  function closeDc(){ dcDlg().close(); }   /* focus goes back to the button that opened it (the shared pop-up) */
  var c=dcEl('dc-cancel'); if(c) c.onclick=closeDc;
  /* ×, Escape and the outside click are the shared pop-up's (dcDlg). */
  var ct=dcEl('dc-casetype'); if(ct) ct.onchange=dcSubtypes;
  var cr=dcEl('dc-create'); if(cr) cr.onclick=submitDirectClient;
  // Duplicate check fires when staff finish typing the identity fields; any
  // EDIT invalidates the current panel + choice (stale link target hazard).
  var em=dcEl('dc-email'); if(em){ em.addEventListener('blur',dcCheckMatches); em.addEventListener('input',dcClearMatches); }
  var ph=dcEl('dc-phone'); if(ph){ ph.addEventListener('blur',dcCheckMatches); ph.addEventListener('input',dcClearMatches); }
  // "New application" entry from a case cockpit: open the modal pre-filled
  // from the previous case's profile.
  var newAppFrom=new URLSearchParams(window.location.search).get('newAppFrom');
  if(newAppFrom){ openDirectClient(); dcLoadProfile(newAppFrom); }
  // Lead conversion from the Leads page (team feedback 2026-08-13): open the
  // modal pre-filled from the lead and pre-linked to it (no duplicate row).
  var convertLead=new URLSearchParams(window.location.search).get('convertLead');
  if(convertLead && !newAppFrom){ openDirectClient(); dcLoadConvertLead(convertLead); }
})();

`;

function listPageHead(title) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — ${title}</title><style>
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  ${LIST_PAGE_CSS}`;
}

// ─── Consultations page ────────────────────────────────────────────────────────
function buildQueueHTML() {
  return `${listPageHead('Consultations')}
  ${CONSULT_PAGE_CSS}
  ${DELETE_UI_CSS}
  ${BLACKLIST_UI_CSS}
  ${REFERRAL_CSS}
  ${DQ_CSS}
</style></head><body>
${buildNavHeader('consultations')}
<main class="wrap">
  <div id="loading"><div class="spinner"></div><div class="muted">Loading consultations…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <div class="page-top">
      <h1 class="page-h" style="margin:0">Consultations</h1>
      <span class="top-r"><span class="age" id="snap-age"></span>${REPORTING_LINK_HTML}${DQ_BUTTON_HTML}</span>
    </div>
    ${DQ_DONE_HTML}
    <p class="page-sub">Every consultation, in four tabs (and All). Once an outcome is set, the consultation moves to the Completed tab and stays there; the client is worked from <a href="/admin/retainers">Retainers &amp; follow-ups</a>.</p>
    <div class="lt-tabs" id="cq-tabs" role="tablist" aria-label="Consultations by list"></div>
    <div class="q-head">
      <div><h2 class="sec-h"><span id="cq-title">Booked consultations</span> <span id="cq-count" class="muted" style="font-weight:500" aria-live="polite"></span></h2>
        <p class="page-sub" id="cq-sub" style="margin:4px 0 0"></p></div>
      <div class="q-search"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2a5 5 0 0 1 3.96 8.05l3 3-.92.92-3-3A5 5 0 1 1 7 2zm0 1.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4z"/></svg><input id="cq-search" type="search" placeholder="Search by name, phone or email…" aria-label="Search consultations by name, phone or email" autocomplete="off"></div>
    </div>
    <div id="cq-month" class="cq-month" style="display:none"></div>
    <div id="cq-chips" class="q-chips" style="display:none" aria-live="polite"></div>
    <div class="card"><div class="tbl-wrap">
      <table id="cq-table" class="tab-booked">
        <thead><tr id="cq-headrow"><th>Date</th><th>Time</th><th>Client</th><th>Service</th><th>Consultant</th><th>Mode</th><th>Agreement</th><th>Pre-consult</th><th>Paid</th><th>Outcome</th><th>Now</th><th></th></tr></thead>
        <tbody id="qbody"></tbody>
      </table>
    </div></div>
  </div>
</main>
<script>
${SHARED_AUTH_JS}
var ALLROWS=[];
${LIST_PAGE_JS}
${CONSULT_PAGE_JS}
function load(force){
  var key=getKey(); if(!key) return;
  fetch('/api/consultations-board?completed=1'+(force?'&fresh=1':''),{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error||('HTTP '+r.status)); }); } return r.json(); })
   .then(function(d){
     ALLROWS=(d.consultations||[]).concat(d.completed||[]);   /* the completed ones carry done:true — their own month groups */
     ConsultTable.setRows(ALLROWS); showAge(d);   // the filters stay as they were (a refresh never clears them)
     document.getElementById('loading').style.display='none';
     document.getElementById('content').style.display='block';
   })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}
${DELETE_UI_JS}
tdotBindDelete(function(){ load(true); });
startClock(); checkApiStatus();
</script>
<script>
${BLACKLIST_UI_JS}
${REFERRAL_UI_JS}
var DQ_FORM=${jsLit(dqFormHtml())};
${DQ_JS}
dqInitButton();
</script>
<script>${listTableScript(consultListSpec, consultListOpts, '{ onChange: consultOnChange }')}</script>
<script>load(); window.addEventListener('pageshow',function(e){ if(e.persisted) load(); });   /* Back to this page from memory: read the list again */</script></body></html>`;
}

// ─── Retainers & follow-ups page ───────────────────────────────────────────────
function buildRetainersHTML() {
  return `${listPageHead('Retainers & follow-ups')}
  ${RETAINERS_PAGE_CSS}
  ${DELETE_UI_CSS}
  ${BLACKLIST_UI_CSS}
</style></head><body>
${buildNavHeader('retainers')}
<main class="wrap">
  <div id="loading"><div class="spinner"></div><div class="muted">Loading retainers &amp; follow-ups…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <div class="page-top">
      <h1 class="page-h" style="margin:0">Retainers &amp; follow-ups <span id="r-count" class="cnt" aria-live="polite"></span></h1>
      <span style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">${REPORTING_LINK_HTML}<button class="btn-direct" id="btn-direct-client" type="button" title="Walk-in / referral entering at the retainer stage — no booking or consultation">＋ Direct retainer client</button></span>
    </div>
    <p class="page-sub">What the team does after a consultation — <b>Retain</b>: send the retainer · <b>Follow-Up</b>: call the client back (not retained) · <b>Newsletter</b> · <b>Not Wanted</b> — and direct retainer clients. A client shows here as soon as an outcome is set for their consultation; once retained (signed and paid) they move to the <b>Retained</b> tab, and the case is on the Client Master page. <b>All</b> = everyone still being worked (not Retained). <span class="age" id="snap-age"></span></p>
    <div class="lt-tabs" id="r-quick" role="tablist" aria-label="Retainers &amp; follow-ups by outcome"></div>
    <div class="q-head r-tools">
      <div class="q-search"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2a5 5 0 0 1 3.96 8.05l3 3-.92.92-3-3A5 5 0 1 1 7 2zm0 1.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4z"/></svg><input id="rq-search" type="search" placeholder="Search by name, phone or email…" aria-label="Search retainers and follow-ups by name, phone or email" autocomplete="off"></div>
    </div>
    <div id="rq-chips" class="q-chips" style="display:none" aria-live="polite"></div>
    <div class="card"><div class="tbl-wrap">
      <table>
        <thead><tr id="rq-headrow"><th>Client</th><th>Case type</th><th>Consultant</th><th>Outcome</th><th>Consult fee</th><th>Retainer fee</th><th>Sent</th><th>Signed</th><th>Paid</th><th>Stage</th><th>Case</th><th></th></tr></thead>
        <tbody id="rbody"></tbody>
      </table>
    </div></div>
  </div>
${DIRECT_CLIENT_HTML}
</main>
<script>
${SHARED_AUTH_JS}
${DIALOG_UI_JS}
var RETAINERS=[];
${LIST_PAGE_JS}
${REFERRAL_UI_JS}
${ATTACH_UI_JS}
${DEADLINE_BOX_JS}
var DC_REF=tdotRef('dc');      /* the walk-in form's Source / Reference second question (2026-11-04) */
var DC_DL=window.tdotDeadlineBox('dc');   /* the deadline (2026-11-05): required here — this client is being retained */
var DC_ATT=tdotAttach('dc');   /* "Attach a screenshot": only for the staff allowed to (Shafoli), signed in with Monday */
var DC_PROFILE_ADDR='';        /* the carried address — its "is it current?" tick is asked only while the box still shows it */
var RET_TABS=${jsLit(RETAINER_TABS)};   // the Retainers tabs: one per outcome, Retain first, then Retained (the shared list engine keeps which is on)
var RET_APART=${jsLit([RETAINED_TAB])};   // never counted under All: shown only on its own tab, after All
var RET_HINTS={ 'Retain':'Outcome Retain, direct retainer clients, and anyone whose retainer is under way with no outcome set — until retained', 'Follow-Up':'The team calls the client back — not retained', 'Newsletter':'Nothing to do now — the client gets the newsletter', 'Not Wanted':'On the Not Wanted list — staff are warned if they come back', 'Retained':'Signed and paid (a part-payment of the first milestone counts) — the case is on the Client Master page. Not counted under All.' };
${RETAINERS_PAGE_JS}
function load(force){
  var key=getKey(); if(!key) return;
  fetch('/api/consultations-board?retained=1'+(force?'&fresh=1':''),{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error||('HTTP '+r.status)); }); } return r.json(); })
   .then(function(d){
     RETAINERS=(d.retainers||[]).concat(d.retained||[]);   /* the Retained tab's rows ride along (kept apart from All) */
     RetainerTable.setRows(RETAINERS); showAge(d);   // the filters stay as they were (a refresh never clears them)
     document.getElementById('loading').style.display='none';
     document.getElementById('content').style.display='block';
   })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}
${DELETE_UI_JS}
tdotBindDelete(function(){ load(true); });
startClock(); checkApiStatus();
</script>
<script>${listTableScript(retainerListSpec, retainerListOpts, '{ outcomes: RET_TABS, apart: RET_APART, today: todayStr, hints: RET_HINTS, initial: retInitial, onChange: retOnChange }')}
retOnChange(RetainerTable.state());   /* the address names the tab shown from the start (a saved address opens the same tab) */</script>
<script>load(); window.addEventListener('pageshow',function(e){ if(e.persisted) load(); });   /* Back to this page from memory: read the list again */</script></body></html>`;
}

// ─── Detail page ────────────────────────────────────────────────────────────────
// opts.from = 'retainers' when the record was opened from the Retainers & follow-ups page (2026-11-05): the top bar
// and the back link point there. Opened any other way, the page works out the right list once the record has loaded.
function buildDetailHTML(leadId, opts) {
  const fromRetainers = !!(opts && opts.from === 'retainers');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Consultation</title><style>
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  ${PAYMENT_UI_CSS}
  ${BLACKLIST_UI_CSS}
  /* Record payment: the consultation booking + the package choice (2026-10-16) */
  .paym .cp-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 10px; }
  .paym .cp-grid > div { min-width:0; }
  .paym select.cp-sel { width:100%; padding:8px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; box-sizing:border-box; background:#fff; }
  .paym label.cp-choice { display:flex; align-items:flex-start; gap:8px; font-weight:600; font-size:13px; margin:8px 0 0; cursor:pointer; }
  .paym label.cp-choice input { width:auto; margin:2px 0 0; flex:none; }
  .paym label.cp-choice.off { opacity:.5; cursor:not-allowed; }
  .paym .cp-preview { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#14532d; margin:10px 0 0; }
  @media (max-width:520px){ .paym .cp-grid { grid-template-columns:1fr; } }
  body { background:var(--bg); }
  /* Full width, like the listing pages and the lead page (2026-11-10). */
  .wrap { max-width:none; margin:0; padding:20px var(--page-gutter) 90px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .muted { color:var(--light); font-size:12px; }
  #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:14px 18px; border-radius:12px; margin:24px auto; max-width:520px; text-align:center; }
  #content { display:none; }
  .back-lnk { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--muted); text-decoration:none; margin-bottom:12px; }
  .back-lnk:hover { color:var(--navy); }

  /* sticky context header */
  .ctx { position:sticky; top:var(--header-h); z-index:20; background:var(--card); border:1px solid #eef2f7; border-radius:var(--r); box-shadow:var(--shadow-sm); padding:16px 20px; margin-bottom:14px; }
  .ctx-top { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; }
  .ctx-id { display:flex; gap:13px; align-items:center; min-width:0; }
  .avatar { width:46px; height:46px; border-radius:50%; background:var(--navy); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; letter-spacing:.5px; flex:none; }
  .cname { font-size:21px; font-weight:800; color:var(--navy); letter-spacing:-.4px; margin:0; line-height:1.2; }
  .csub { font-size:12.5px; color:var(--muted); margin-top:2px; font-weight:500; }
  .ctx-acts { display:flex; gap:7px; align-items:center; flex-wrap:wrap; }
  .iconbtn { width:36px; height:36px; border-radius:var(--r-sm); border:1px solid var(--border); background:#fff; color:var(--muted); display:inline-flex; align-items:center; justify-content:center; font-size:17px; cursor:pointer; text-decoration:none; transition:all .15s; }
  .iconbtn:hover { border-color:var(--navy); color:var(--navy); background:#f5f8fc; }
  .ctx-meta { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:14px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:5px 11px; border-radius:20px; background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .chip svg { font-size:13px; }
  .chip.blue { background:var(--st-blue-bg); color:var(--st-blue-fg); } .chip.green { background:var(--st-green-bg); color:var(--st-green-fg); }
  .chip.amber { background:var(--st-amber-bg); color:var(--st-amber-fg); } .chip.grey { background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .chip .pk { font-weight:500; opacity:1; }   /* the key word: lighter weight, full colour (a faded word fell under 4.5:1 on the tint) */
  .chip-reason { font-size:11px; color:var(--light); font-weight:500; }

  /* lifecycle stepper */
  .stepper { display:flex; gap:4px; background:var(--card); border:1px solid #eef2f7; border-radius:var(--r); box-shadow:var(--shadow-sm); padding:14px 12px; margin-bottom:14px; overflow-x:auto; }
  .step { display:flex; flex-direction:column; align-items:center; gap:6px; flex:1; min-width:62px; }
  .step .dot { width:24px; height:24px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; border:1.5px solid var(--border); color:var(--light); background:#fff; }
  .step .dot svg { font-size:13px; }
  .step.done .dot { background:var(--green); border-color:var(--green); color:#fff; }
  .step.cur .dot { background:var(--navy); border-color:var(--navy); color:#fff; box-shadow:0 0 0 4px rgba(26,53,88,.12); }
  .step .lbl { font-size:10.5px; font-weight:600; color:var(--light); text-align:center; white-space:nowrap; }
  .step.done .lbl { color:var(--muted); } .step.cur .lbl { color:var(--navy); font-weight:700; }

  /* two-column working area */
  .cols { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:16px; align-items:start; }
  @media (max-width:900px){ .cols{ grid-template-columns:1fr; } .ctx{ position:static; } }
  /* Retainer config: short inputs flow into an even, aligned grid instead of a long stack. */
  .rp-config { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px 16px; align-items:start; }
  /* Group captions split the plan into "Case & agreement" (what is being retained)
     and "Fees" (what it costs) — the two read as separate rows. */
  .rp-group-t { font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.8px; color:#94a3b8; border-bottom:1px solid #eef2f7; padding-bottom:5px; margin-bottom:10px; }
  /* Every control in a row must sit on ONE baseline: labels stay single-line
     (explanatory text lives in .rp-hint UNDER the control, where its wrapping
     cannot push the control down), and the field is a flex column so the label
     row is a fixed height regardless of label length. */
  .rp-config .rp-field { display:flex; flex-direction:column; }
  .rp-config .subhead { white-space:nowrap; line-height:1.2; }
  .rp-hint { font-size:11px; font-weight:500; color:#94a3b8; line-height:1.35; margin-top:5px; text-transform:none; letter-spacing:0; }
  .rp-config .rp-field { margin-top:0; }
  .rp-config .frow { gap:6px; } .rp-config .frow input { width:auto; flex:1 1 90px; min-width:0; }
  .rp-pay-block { background:#f8fafc; border:1px solid #eef2f7; border-radius:10px; padding:12px 14px; margin-top:8px; }
  .col { display:flex; flex-direction:column; gap:14px; }
  .card { background:var(--card); border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:16px 18px; }
  .card-t { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:800; color:var(--navy); margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f1f5f9; }
  /* a card's heading: a slightly tinted band across the top of the card (only when the heading is the card's first thing) */
  .card > .card-t:first-child { margin:-16px -18px 12px; padding:11px 18px 10px; background:var(--head-bg); border-bottom:1px solid var(--border); border-radius:var(--r) var(--r) 0 0; }
  ${UPDATES_WIDGET_CSS}
  ${CONSULT_NOTES_CSS}
  .card-t svg { font-size:15px; color:var(--navy); }
  .card-t .when { margin-left:auto; font-weight:500; font-size:11px; color:var(--muted); }
  .kv { display:flex; padding:6px 0; font-size:13px; border-top:1px solid #f8fafc; gap:10px; }
  .kv:first-child { border-top:none; }
  .kv .k { color:var(--muted); min-width:150px; flex-shrink:0; }
  .kv .v { color:var(--navy); font-weight:600; }
  /* Flow dense key/value rows into responsive columns so wide cards use the
     horizontal space; subheads, free-text and rrows still span the full width. */
  .kvgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); column-gap:30px; align-items:start; }
  .kvgrid > *:not(.kv) { grid-column:1 / -1; }
  .kvgrid .kv .k { min-width:130px; }
  .kvgrid .kv { border-top:none; border-bottom:1px solid #f5f8fc; padding:6px 0; }
  .subhead { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin:0 0 6px; }
  .kvgrid .subhead { margin-top:12px; }
  .kvgrid > .subhead:first-child { margin-top:0; }
  .rrow { border:1px dashed var(--border); border-radius:8px; padding:9px 12px; margin-top:8px; font-size:12.5px; color:var(--navy); line-height:1.55; }
  .notyet { color:#94a3b8; font-size:13px; font-style:italic; padding:8px 0; }
  .attr-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:9px 10px; }
  @media(max-width:520px){ .attr-grid{ grid-template-columns:1fr; } }
  .attr-f { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .attr-f input, .attr-f select { min-width:0; width:100%; }
  .attr-f span { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:#94a3b8; }
  .attr-f input, .attr-f select { padding:7px 9px; border:1px solid var(--border); border-radius:8px; font-size:13px; font-family:inherit; color:var(--navy); background:#fff; }

  /* action groups */
  .agroup { padding-top:13px; margin-top:13px; border-top:1px solid #f1f5f9; }
  .obtns { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:2px; }
  /* Comms + agreement buttons: compact 2-per-row grid instead of a tall stack. */
  .btn-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:7px; }
  .btn-grid2 .btn { padding:9px 10px; text-align:center; }
  .obtn { padding:9px 10px; border:1px solid var(--border); border-radius:8px; background:white; font-size:12.5px; font-weight:600; cursor:pointer; color:var(--navy); font-family:inherit; text-align:center; transition:all .12s; }
  .obtn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
  .obtn.active { background:var(--navy); color:white; border-color:var(--navy); box-shadow:var(--shadow-sm); }
${REMARKS_CSS}
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:9px 13px; border-radius:8px; font-size:12.5px; font-weight:700; text-decoration:none; border:1px solid var(--border); color:var(--navy); background:white; cursor:pointer; font-family:inherit; transition:all .12s; }
  .btn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
  .btn.primary { background:var(--navy); color:white; border-color:var(--navy); } .btn.primary:hover:not(:disabled) { background:var(--navy-light); }
  .frow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .frow input { width:150px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:14px; font-family:inherit; }
  .act-msg { display:none; padding:9px 12px; border-radius:8px; font-size:12.5px; margin:10px 0 0; font-weight:600; }
  .act-msg.info { background:var(--st-blue-bg); color:var(--st-blue-fg); display:block; }
  .act-msg.ok { background:var(--st-green-bg); color:var(--st-green-fg); display:block; }
  .act-msg.err { background:var(--st-red-bg); color:var(--st-red-fg); display:block; }
  button:disabled { opacity:.55; cursor:not-allowed; }

  /* retainer plan */
  .rp-field { margin-top:4px; }
  .rp-field select, .rp-field input { width:100%; max-width:420px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:13px; font-family:inherit; }
  .rp-grid2 { display:flex; gap:10px; flex-wrap:wrap; }
  .rp-grid2 .rp-field { flex:1; min-width:200px; }
  .rp-check { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--navy); margin-top:8px; align-self:flex-start; white-space:nowrap; }
  /* The full-width rule above is for text/number inputs — a checkbox must stay a
     checkbox (unconstrained it stretches and wraps its own label). */
  .rp-field input[type=checkbox] { width:15px; height:15px; max-width:none; flex:0 0 15px; margin:0; }
  .rp-sugg { font-size:12px; color:#475569; background:#f8fafc; border:1px solid #eef2f7; border-radius:8px; padding:9px 12px; line-height:1.55; }
  .rp-flag { display:inline-block; font-size:9.5px; font-weight:800; padding:1px 7px; border-radius:10px; margin-left:6px; text-transform:uppercase; letter-spacing:.4px; }
  .rp-flag.high { background:var(--st-green-bg); color:var(--st-green-fg); } .rp-flag.verify { background:var(--st-amber-bg); color:var(--st-amber-fg); }
  .email-warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; padding:11px 14px; border-radius:10px; font-size:13px; margin:0 0 14px; line-height:1.5; }
  .email-warn a { color:#92400e; font-weight:700; }
  .rp-warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; padding:9px 12px; border-radius:8px; font-size:12px; margin:10px 0; line-height:1.5; }
  .rp-warn ul { margin:5px 0 0; padding-left:18px; }
  .rp-sv { background:#f8fafc; border:1px solid var(--border); border-radius:8px; padding:9px 12px; margin:8px 0; font-size:13px; }
  .rp-sv > b { display:block; margin-bottom:4px; }
  .rp-sv .rp-sv-hint { font-size:12px; margin-top:4px; color:#64748b; }
  .rp-sv .rp-sv-hint.need { color:#92400e; font-weight:600; }
  .dynamic-table { width:100%; border-collapse:collapse; margin-top:6px; font-size:12.5px; }
  .dynamic-table th { background:#f8fafc; text-align:left; padding:7px 9px; font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; }
  .dynamic-table td { padding:5px 6px; border-bottom:1px solid #f5f7fa; vertical-align:middle; }
  .dynamic-table input { width:100%; padding:7px 9px; border:1px solid var(--border); border-radius:7px; font-size:12.5px; font-family:inherit; }
  .dynamic-table input:disabled { background:#f8fafc; color:#64748b; }
  /* Phone: a wide table scrolls inside its own card instead of pushing the page sideways. */
  @media (max-width:640px){ .dynamic-table { display:block; overflow-x:auto; } }
  .rm-btn { padding:5px 9px; border:1px solid var(--border); border-radius:7px; background:white; cursor:pointer; color:#dc2626; font-size:12px; font-family:inherit; }
  .rp-sum { font-weight:700; font-size:12px; }
  .rp-sum.ok { color:#16a34a; } .rp-sum.bad { color:#dc2626; }
  .m-due { display:inline-block; font-size:9px; font-weight:800; padding:1px 6px; border-radius:9px; background:var(--st-red-bg); color:var(--st-red-fg); text-transform:uppercase; letter-spacing:.4px; vertical-align:middle; margin-left:6px; }
  .rp-stage { font-weight:700; color:var(--navy); }
  .rp-fs { border:0; padding:0; margin:0; min-width:0; }
  .rp-fs:disabled { opacity:.82; }
  /* One-line retainer action bar. Tight 8px gap WITHIN a group, wider 18px gap
     BETWEEN groups — so the three stages (edit · review/save · sign) read as a
     sequence. Groups wrap as whole units on narrow screens. */
  /* Tight enough that all eight actions sit on ONE line at desktop widths
     (wrap stays on as the narrow-screen safety net). */
  .rp-actionbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin-top:16px; padding-top:14px; border-top:1px solid var(--border); }
  .rp-actiongroup { display:inline-flex; align-items:center; gap:6px; }
  .rp-actionbar .btn { padding:8px 10px; font-size:12px; }
  /* A disabled action must LOOK disabled — without this, "Mark retainer signed"
     was correctly disabled on completed retentions but appeared clickable. */
  .btn:disabled { opacity:.45; cursor:not-allowed; }
  .rp-lock { display:flex; align-items:center; gap:12px; justify-content:space-between; background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:10px 14px; margin-bottom:12px; font-size:13px; color:#92400e; }
  .rp-lock.amending { background:#eff6ff; border-color:#bfdbfe; color:#1e40af; }
  .rp-lock #rp-amend { flex:none; }
  .ms-row { display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid #f1f5f9; flex-wrap:wrap; }
  .ms-row:last-child { border-bottom:0; }
  .ms-label { flex:1; min-width:150px; font-size:13px; font-weight:600; color:#33425a; }
  .ms-amt { font-size:13px; font-weight:700; color:var(--navy); font-variant-numeric:tabular-nums; }
  .ms-badge { display:inline-block; font-size:9.5px; font-weight:800; padding:2px 8px; border-radius:10px; text-transform:uppercase; letter-spacing:.4px; }
  .ms-badge.paid { background:var(--st-green-bg); color:var(--st-green-fg); }
  .ms-badge.sent { background:var(--st-blue-bg); color:var(--st-blue-fg); }
  .ms-badge.due { background:var(--st-amber-bg); color:var(--st-amber-fg); }
  .ms-badge.pending { background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .ms-badge.partial { background:var(--st-amber-bg); color:var(--st-amber-fg); }
  .ms-meta { font-size:11px; color:#64748b; font-variant-numeric:tabular-nums; }
  .ms-row button { padding:6px 12px; font-size:12px; }

  ${DEADLINE_BOX_CSS}
  .dlx .al-l { display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#64748b; margin:10px 0 4px; font-weight:700; }
  .dlx .al-yn { display:flex; gap:18px; font-size:13.5px; margin:2px 0; }
  .dlx .al-yn label { display:flex; gap:6px; align-items:center; cursor:pointer; }
  .dlx .al-hint { font-size:12px; color:#64748b; margin-top:4px; }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }
  /* A direct consultation (step 2): the chip's tooltip, and the Change time / Retain-confirm pop-ups (dialogUi.js) */
  .chip.direct { background:var(--st-grey-bg); color:var(--st-grey-fg); cursor:help; }
  .dqt label.dqt-l { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:12px 0 4px; }
  .dqt input, .dqt select { width:100%; padding:9px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:16px; font-family:inherit; color:var(--navy); background:#fff; box-sizing:border-box; min-height:42px; }
  .dqt p { margin:6px 0; color:#334155; line-height:1.5; }
  .dqt .dqt-warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:8px; padding:9px 12px; font-size:13px; margin-top:10px; line-height:1.45; }
  .dqt .dqt-warn a { color:#1d4ed8; }
</style></head><body>
${buildNavHeader(fromRetainers ? 'retainers' : 'consultations')}
<main class="wrap">
  <a href="${fromRetainers ? '/admin/retainers' : '/admin/consultations'}" class="back-lnk" id="back-lnk">${I.back} <span id="back-lnk-txt">${fromRetainers ? 'Retainers &amp; follow-ups' : 'All consultations'}</span></a>
  <div id="loading"><div class="spinner"></div><div class="muted">Loading consultation…</div></div>
  <div id="error-msg"></div>
  <div id="content">

    <div class="ctx">
      <div class="ctx-top">
        <div class="ctx-id">
          <div class="avatar" id="c-avatar">—</div>
          <div><h1 class="cname" id="c-name">—</h1><div class="csub" id="c-sub">—</div></div>
        </div>
        <div class="ctx-acts" id="c-acts"></div>
      </div>
      <div class="ctx-meta">
        <span id="c-pills" style="display:contents"></span>
        <span id="c-consultant" style="display:contents"></span>
      </div>
    </div>
    <div id="bl-banner"></div>
    <div id="email-warn"></div>

    <div class="stepper" id="c-stepper"></div>

    <!-- Consultation notes (2026-11-10): static markup above the columns, so it is first on a phone too and
         the page's render() never rewrites the box. NOT an .actions card: disableActions() must not touch Save notes. -->
    <div class="card cnw-card" style="margin-bottom:16px"><div class="card-t">📝 Consultation notes</div>${consultNotesHtml('cnw')}</div>

    <div class="cols">
      <div class="col">
        <div class="card"><div class="card-t">${I.clip} Intake context</div><div id="c-intake" class="kvgrid"></div></div>
        <div class="card"><div class="card-t">${I.cap} Eligibility profile <span class="when" id="c-elig-when"></span></div><div id="c-elig" class="kvgrid"></div></div>
        <div class="card"><div class="card-t">${I.cpu} AI triage notes</div><div id="c-ai"></div></div>
        <div class="card"><div class="card-t">💬 Updates</div>${updatesWidgetHtml('updw', { otter: true })}</div>
      </div>

      <div class="col">
        <div class="card actions">
          <div class="card-t">${I.bolt} Consultation</div>
          <div class="subhead">Record outcome</div>
          <div class="obtns" id="obtns"></div>
          <div id="act-msg" class="act-msg"></div>
          <div class="agroup">
            <div class="subhead">Remarks <span class="muted">— what was done for this lead</span></div>
            ${remarksHtml('rmk')}
          </div>
          <div class="agroup">
            <div class="subhead">Communications &amp; agreement <span class="muted" id="ca-sent"></span></div>
            <div id="ca-warn"></div>
            <!-- Residential address (Gauri 2026-09-04, point 07): editable here because it prints on the
                 consultation agreement and the retainer — leads created before 2026-09-04 had no way to fix it. -->
            <div class="attr-f" style="margin:6px 0 12px">
              <span>Client residential address <span class="muted">(prints on the agreement and retainer)</span></span>
              <textarea id="ca-address" rows="2" maxlength="500" placeholder="Street, city, province/state, postal code, country" style="width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;resize:vertical"></textarea>
              <div class="frow" style="margin-top:8px"><button class="btn" id="btn-addr-save" title="Save the residential address on the lead">Save address</button></div>
            </div>
            <div class="btn-grid2">
              <button class="btn" id="btn-invite" title="Send booking invite">${I.send} Send booking invite</button>
              <button class="btn" id="btn-resend" title="Resend meeting + pre-consult links">${I.refresh} Resend links</button>
              <button class="btn" id="btn-consult-preview" title="Preview the consultation agreement">${I.eye} Preview agreement</button>
              <button class="btn" id="btn-consult-send" title="Send consultation email: booking + form + agreement">${I.send} Review &amp; send</button>
              <button class="btn" id="btn-consult-signed-view" style="display:none" title="View the signed consultation agreement">${I.eye} View signed agreement</button>
              <button class="btn" id="btn-consult-countersign" style="display:none" title="Add the consultant (RCIC) signature to the client-signed agreement">${I.send} <span class="btn-label">Sign as consultant</span></button>
            </div>
          </div>
        </div>
        <div class="card actions">
          <div class="card-t">${I.userCheck} Attribution &amp; follow-up <span class="muted" id="attr-saved" style="margin-left:auto;font-weight:500"></span></div>
          <div class="attr-grid">
            <label class="attr-f"><span>Follow-up date</span><input id="at-followup" type="date"></label>
            <label class="attr-f"><span>Lead owner</span><select id="at-owner">${STAFF_OPTS}</select></label>
            <label class="attr-f"><span>Booked by</span><select id="at-bookedby">${STAFF_OPTS}</select></label>
            <label class="attr-f"><span>Payment reviewed by</span><select id="at-reviewer">${STAFF_OPTS}</select></label>
          </div>
          <div class="frow" style="margin-top:12px"><button class="btn primary" id="btn-attr-save">${I.save} Save attribution</button></div>
        </div>
        <!-- Consultation fee (Gauri point 4, part 2): the booking link records its own payment; a fee paid
             another way (cash, e-transfer, an invoice the team sent) or waived is recorded here — a record
             only, so the Consultations list and the KPIs count it. No email or automatic step runs from it. -->
        <div class="card actions">
          <div class="card-t">${I.dollar} Consultation fee <span class="muted" id="cp-state" style="margin-left:auto;font-weight:500"></span></div>
          <div id="cp-body" class="kvgrid"></div>
          <div class="frow" style="margin-top:12px">
            <button class="btn" id="btn-cp-record" title="The fee was paid by cash, e-transfer, an invoice the team sent, or another way — or waived">${I.dollar} Record payment / Waived</button>
            <button class="btn" id="btn-cp-clear" style="display:none" title="Remove a record made by mistake (the lead keeps a note)">Remove record</button>
          </div>
        </div>
        <div class="card"><div class="card-t">${I.flag} Case status</div><div id="c-status" class="kvgrid"></div></div>
        <!-- The client's deadline (team meeting 2026-11-05): asked at retain (Retain & send refuses without it);
             real (its date) or imaginary (the date promised to the client); kept in step with the case row. -->
        <div class="card actions" id="c-dl-card">
          <div class="card-t">${I.flag} Deadline <span class="muted">(required to retain · lands on the case)</span></div>
          ${deadlineBoxHtml('cd', { required: true, title: 'Deadline', hint: 'Real: the actual deadline date. Imaginary: no real deadline — the submission date promised to the client (documents are needed 10–15 days before it).' })}
          <div class="frow" style="margin-top:10px"><button class="btn" id="btn-cd-save">${I.save} Save deadline</button></div>
          <div id="cd-msg" class="act-msg"></div>
        </div>
      </div>
    </div>

    <div class="card retainer actions" style="margin-top:14px">
      <div class="card-t">${I.dollar} Retainer plan</div>
      <div id="rp-msg" class="act-msg" style="margin-top:0;margin-bottom:10px"></div>

      <div id="rp-lock" class="rp-lock" style="display:none">
        <span id="rp-lock-msg"></span>
        <button class="btn" id="rp-amend" type="button">✎ Amend</button>
        <button class="btn" id="rp-reissue" type="button" style="display:none" title="Void the un-signed agreement and email a fresh one with the CURRENT fee, milestones and signer emails">🔄 Void &amp; re-issue</button>
      </div>
      <fieldset id="rp-lock-fs" class="rp-fs">
      <div class="rp-group-t">Case &amp; agreement</div>
      <div class="rp-config">
        <div class="rp-field">
          <div class="subhead">Signatory template</div>
          <select id="rp-template"></select>
        </div>
        <div class="rp-field">
          <div class="subhead">Case type</div>
          <select id="rp-casetype"><option value="">Loading case types…</option></select>
          <div class="rp-hint">Confirms the client-stated interest</div>
        </div>
        <div class="rp-field">
          <div class="subhead">Sub-type</div>
          <select id="rp-subtype"><option value=""></option></select>
          <div class="rp-hint">Drives the checklist + questionnaire</div>
        </div>
        <div class="rp-field">
          <div class="subhead">Scope annex</div>
          <select id="rp-annex"></select>
        </div>
      </div>
      <div class="rp-group-t" style="margin-top:16px">Fees</div>
      <div class="rp-config">
        <div class="rp-field">
          <div class="subhead">Retainer fee</div>
          <div class="frow"><input id="fee" type="number" min="1" step="1" placeholder="Fee (CAD $)"><button class="btn" id="btn-fee">${I.check} Set fee</button></div>
        </div>
        <div class="rp-field">
          <div class="subhead">Government fee (CAD)</div>
          <input id="rp-govfee" type="number" min="0" step="0.01" placeholder="0.00">
          <label class="rp-check"><input id="rp-rprf" type="checkbox"> Include RPRF</label>
        </div>
        <div class="rp-field" id="rp-adfee-field" style="display:none">
          <div class="subhead">Advertisement fee (CAD) <span class="muted">(LMIA recruitment)</span></div>
          <input id="rp-adfee" type="number" min="0" step="0.01" placeholder="0.00">
        </div>
        <div class="rp-field">
          <div class="subhead">HST rate (%) <span class="muted">(13% default)</span></div>
          <input id="rp-hst" type="number" min="0" step="0.5" value="13">
        </div>
      </div>
      <div id="rp-suggestion" style="margin-top:12px"></div>
      <div id="rp-warnings"></div>

      <div class="subhead" style="margin-top:14px">${I.userCheck} Family members <span class="muted">(consultant-set · only “accompanying” members get a checklist + questionnaire · date of birth / status / residence are optional and pre-fill the member’s questionnaire)</span></div>
      <div class="rp-sv" id="rp-sv" style="display:none">
        <b id="rp-sv-title">Super Visa — both parents applying?</b>
        <div class="rp-sv-hint" id="rp-sv-hint"></div>
        <button class="btn" id="rp-sv-add" type="button" style="display:none;margin-top:6px">${I.plus} <span id="rp-sv-add-txt">Add the second parent</span></button>
      </div>
      <table class="dynamic-table" id="family-table">
        <thead><tr><th style="width:15%">Type</th><th style="width:19%">Full name</th><th style="width:15%">Date of birth</th><th style="width:16%">Current status</th><th style="width:16%">Residence country</th><th style="width:11%">Accomp.</th><th style="width:4%"></th></tr></thead>
        <tbody id="family-body"></tbody>
      </table>
      <button class="btn" id="rp-add-family" type="button" style="margin-top:8px">${I.plus} Add family member</button>

      <div id="rp-inviter" style="display:none;margin-top:8px">
        <div class="subhead">Inviter / Sponsor / Dependent <span style="color:#c0392b;font-weight:600">— co-signer, all fields required</span></div>
        <div class="rp-hint" style="font-size:12px;color:#666;margin:2px 0 6px">This person signs the retainer alongside the client — both are emailed the agreement at once, and it completes only when both have signed.</div>
        <div class="rp-grid2">
          <div class="rp-field"><input id="rp-inviterName" type="text" placeholder="Name (required)"></div>
          <div class="rp-field"><input id="rp-inviterEmail" type="email" placeholder="Email (required — receives the signing request)"></div>
        </div>
        <div class="rp-grid2" style="margin-top:6px">
          <div class="rp-field"><input id="rp-inviterPhone" type="text" placeholder="Phone (required)"></div>
          <div class="rp-field"><input id="rp-inviterAddress" type="text" placeholder="Address (required — printed in the agreement)"></div>
        </div>
        <div class="rp-err" id="rp-inviter-err" role="alert" style="display:none;color:#c0392b;font-size:12px;margin-top:6px"></div>
      </div>

      <div id="rp-employer" style="display:none;margin-top:8px">
        <div class="subhead">Employer / legal representative</div>
        <div class="rp-grid2">
          <div class="rp-field"><input id="rp-empRepName" type="text" placeholder="Legal rep name"></div>
          <div class="rp-field"><input id="rp-empRepEmail" type="text" placeholder="Rep email"></div>
        </div>
        <div class="rp-grid2" style="margin-top:6px">
          <div class="rp-field"><input id="rp-empRepPhone" type="text" placeholder="Rep phone"></div>
          <div class="rp-field"><input id="rp-empCompanyName" type="text" placeholder="Company / legal entity"></div>
        </div>
        <div class="rp-grid2" style="margin-top:6px">
          <div class="rp-field"><input id="rp-empCompanyPhone" type="text" placeholder="Company phone"></div>
          <div class="rp-field"><input id="rp-empCompanyAddress" type="text" placeholder="Company address"></div>
        </div>
      </div>

      <div class="subhead" style="margin-top:12px">Fees (auto-calculated)</div>
      <div id="rp-fee-breakdown" class="rp-sugg" style="margin-top:4px"></div>

      <div class="subhead" style="margin-top:12px">Milestone schedule <span id="rp-mile-sum" class="rp-sum"></span> <span id="rp-case-stage" class="muted" style="font-weight:500"></span></div>
      <table class="dynamic-table" id="milestone-table">
        <thead><tr><th style="width:32%">Label</th><th style="width:16%">Amount (CAD)</th><th style="width:13%">HST</th><th style="width:13%">Total</th><th style="width:18%">Trigger</th><th></th></tr></thead>
        <tbody id="milestone-body"></tbody>
      </table>
      </fieldset>

      <!-- Retainer action bar: one line, left→right in the order the workflow runs
           (edit milestones → review → save → sign). The plan-editing buttons live
           OUTSIDE the lock fieldset so "Mark retainer signed" stays clickable after
           the agreement is sent + locked; applyRetainerLock() disables the rest. -->
      <div class="rp-actionbar">
        <span class="rp-actiongroup">
          <button class="btn" id="rp-add-mile" type="button">${I.plus} Add milestone</button>
          <button class="btn" id="rp-split-mile" type="button">${I.cols} Split fee evenly</button>
        </span>
        <span class="rp-actiongroup">
          <button class="btn" id="btn-retainer-preview" type="button">${I.eye} Preview retainer agreement</button>
          <button class="btn" id="btn-retainer-save" type="button">${I.save} Save retainer plan</button>
          <button class="btn primary" id="btn-retain-send" type="button">${I.send} Retain &amp; send agreement</button>
        </span>
        <span class="rp-actiongroup">
          <button class="btn" id="btn-signed" type="button">${I.userCheck} Mark retainer signed</button>
          <button class="btn" id="btn-retainer-countersign" type="button" style="display:none" title="Add the consultant (RCIC) signature to the client-signed retainer">${I.send} <span class="btn-label">Sign retainer as consultant</span></button>
          <button class="btn" id="btn-retainer-signed-view" type="button" style="display:none" title="View the signed retainer agreement">${I.eye} View signed retainer</button>
        </span>
      </div>

      <div class="rp-pay-block">
        <div class="subhead" style="margin-top:0">${I.dollar} Milestone payments <span class="muted" style="font-weight:500">(e-transfer)</span></div>
        <div id="rp-milestone-pay"><span class="muted">Payment status appears here once the retainer plan is set. Collected by <b>e-transfer</b>: at retain the client is emailed the first milestone’s e-transfer request; later milestones show a “Send e-transfer request” button once they’re due. Record each payment with <b>Mark paid</b> when the e-transfer arrives.</span></div>
      </div>
    </div>
  </div>
</main>
<script>
var LEAD_ID=${jsLit(leadId)};
${DEADLINE_BOX_JS}
${UPDATES_WIDGET_JS}
${CONSULT_NOTES_JS}
var OUTCOMES=${jsLit(OUTCOME_LABELS)};
var OUTCOME_NOT_WANTED=${jsLit(OUTCOME_NOT_WANTED)};
var REMARKS=${jsLit(REMARK_PRESETS)};
${REMARKS_JS}
var ICONS=${jsLit({ video: I.video, file: I.file, disc: I.disc, mail: I.mail, userCheck: I.userCheck, clock: I.clock, check: I.check, dollar: I.dollar })};
${SHARED_AUTH_JS}
${PAYMENT_UI_JS}
${BLACKLIST_UI_JS}
tdotUpdatesMount({ prefix: 'updw', threadUrl: '/api/updates/' + encodeURIComponent(LEAD_ID), itemId: LEAD_ID });
tdotConsultNotesMount({ prefix: 'cnw', itemId: LEAD_ID, updatesPrefix: 'updw' });
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeUrl(u){ u=String(u==null?'':u).trim(); return /^(https?:|mailto:)/i.test(u)?u:'#'; } // block javascript:/data: in href
var RP_HYDRATED=false; // hydrate the retainer panel from the detail payload only once (don't clobber edits)
// Lock state: once the retainer agreement is sent — OR the client has already
// signed / been retained — fee + plan are read-only and no NEW agreement can be
// sent, unless the consultant "Amend"s. RP_SENT (sent specifically) vs RP_RETAINED
// (signed/paid/Retained) only differ in the wording of the lock message.
var RP_LOCKED=false, RP_AMEND=false, RP_SENT=false, RP_RETAINED=false, RP_SIGNED=false, RP_RC_DONE=false, RP_RC_SENT=false;
var RP_SIGNED_WHY='';   /* why "Mark retainer signed" is greyed out — never "the case is open" when no case is (point 8 review) */
// The family list has been used: the client signed (or was retained) AND the case is open — it was read when the case
// was set up, and an edit here no longer reaches the case (the case page's ➕ Add family member does).
var RP_LIST_USED=false;
// Consultation-agreement countersign state (same three-state button contract).
var CS_RC_DONE=false, CS_RC_SENT=false;
// Progressive-enablement state for the retainer send flow: you must Set fee →
// Save plan → Retain & send, in order. Each disabled button explains the due step.
var RP_FEE_SET=false, RP_PLAN_SAVED=false, PERSISTED_FEE='';
function kv(k,v){ return v&&String(v).trim()?'<div class="kv"><span class="k">'+escHtml(k)+'</span><span class="v">'+escHtml(v)+'</span></div>':''; }
function scores(arr){ var p=(arr||[]).map(function(v){return String(v||'').trim();}); return p.some(Boolean)?p.map(function(v){return v||'—';}).join(' / '):''; }
function initials(n){ var p=String(n||'').trim().split(/\\s+/).filter(Boolean); return (p.length?(p[0][0]+(p.length>1?p[p.length-1][0]:'')):'?').toUpperCase(); }

// Read-only lifecycle stepper, derived from the consultation's current columns.
function buildStepper(d){
  var steps=[
    { k:'Booked',   done:!!(d.bookedSlot||d.bookingStatus==='Booked'||d.bookingStatus==='Slot Held') },
    { k:'Consult',  done:!!(d.consultationHeld||d.outcome) },
    { k:'Outcome',  done:!!d.outcome },
    { k:'Retainer', done:!!(d.retainerSent && String(d.retainerSent).trim()) },
    { k:'Signed',   done:!!d.retainerSigned },
    { k:'Paid',     done:!!d.retainerPaid },
    { k:(d.caseDeleted?'Case deleted':'Case'), done:!!d.clientMasterItemId }
  ];
  var cur=-1; for(var i=0;i<steps.length;i++){ if(!steps[i].done){ cur=i; break; } } if(cur<0) cur=steps.length-1;
  return steps.map(function(s,i){
    var cls=s.done?'done':(i===cur?'cur':'');
    var dot=s.done?ICONS.check:String(i+1);
    return '<div class="step '+cls+'"><span class="dot">'+dot+'</span><span class="lbl">'+s.k+'</span></div>';
  }).join('');
}

function setAttrSel(id,val){ var el=document.getElementById(id); if(!el) return; if(val && ![].some.call(el.options,function(o){return o.value===val;})){ var o=document.createElement('option'); o.value=val; o.textContent=val; el.appendChild(o); } el.value=val||''; }
function hydrateAttribution(d){
  var fu=document.getElementById('at-followup'); if(fu) fu.value=d.followUpDate||'';
  setAttrSel('at-owner', d.leadOwner||''); setAttrSel('at-bookedby', d.bookedBy||''); setAttrSel('at-reviewer', d.paymentReviewedBy||'');
}
// ── Consultation fee (Gauri point 4, part 2) ──────────────────────────────
// paid 'app' = the booking link's Square payment (nothing to record, no button);
// a kind = staff recorded it (change / remove); '' = the record button.
var CP_LABELS={cash:'Cash','e-transfer':'E-transfer',square:'Paid in Square',invoice:'Invoice sent by the team',other:'Other',waived:'Waived'};
function cpMoney(c){ return '$'+(Number(c||0)/100).toFixed(2); }
function cpTodayStr(){ try { return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); } catch(e){ return new Date().toISOString().slice(0,10); } }
function hydrateConsultPayment(d){
  var cp=d.consultPayment||{};
  var body=document.getElementById('cp-body'), st=document.getElementById('cp-state'), rec=document.getElementById('btn-cp-record'), clr=document.getElementById('btn-cp-clear');
  if(!body||!st||!rec||!clr) return;
  var h='';
  if(cp.paid==='app'){
    st.textContent='Paid through the booking link';
    h+=kv('Paid','Through the booking link (Square)'+(cp.paidCents!=null?' · '+cpMoney(cp.paidCents)+' incl. HST':''));
    if(cp.alsoRecorded) h+=kv('Also recorded by staff',cp.alsoRecorded);
    h+='<div class="muted" style="font-size:12px;margin-top:6px">Nothing to record here. A refund is done in Square.</div>';
    rec.style.display='none'; clr.style.display='none';
  } else if(cp.paid){
    st.textContent=cp.paid==='waived'?'Waived':('Paid — '+(CP_LABELS[cp.paid]||cp.paid));
    h+=kv('How',CP_LABELS[cp.paid]||cp.paid);
    if(cp.paid!=='waived') h+=kv('Fee received',(cp.paidCents!=null?cpMoney(cp.paidCents):'amount not recorded')+' (before HST)');
    h+=kv(cp.paid==='waived'?'Waived on':'Received on',cp.on)+kv('Recorded by',(cp.by||'')+(cp.by&&!cp.verified?' (name as typed)':''))+kv('Reference',cp.reference)+kv('Note',cp.note);
    rec.style.display=''; rec.innerHTML=ICONS.dollar+' Change record'; clr.style.display='';
  } else {
    st.textContent='Not recorded';
    h+='<div class="muted" style="font-size:12px">The booking link records its own payment. Paid another way — cash, e-transfer, an invoice the team sent — or waived? Record it here so the Consultations list and the KPIs count it.'+(cpRecOn(d)?' You can also enter the booking and email the client the consultation agreement and pre-consultation form.':((cp.onRecord&&cp.onRecord.enabled)?'':' A record only: no email or automatic step runs from it.'))+'</div>';
    rec.style.display=''; rec.innerHTML=ICONS.dollar+' Record payment / Waived'; clr.style.display='none';
  }
  body.innerHTML=h;
}
/* The consultation package on a recorded payment (2026-10-16): the booking staff
   made by hand + email the agreement and form, yes or no. Waived starts with no
   answer; a NEW paid record starts on "yes"; a change keeps what was stored. */
var CP_WHY={ outcome:'An outcome is already set — the consultation has happened, so no consultation package is sent.', 'case':'This client already has a case — no consultation package is sent.', retainer:'A retainer is already under way — no consultation package is sent.', direct:'A direct retainer client has no consultation — no consultation package is sent.', 'direct-consult':'A direct consultation — this box records the fee only: no booking, no meeting and no package.' };
/* The time pointer names "Change time" only when that button is on this page (review round 2). */
function cpDirectWhy(d){
  var t=CP_WHY['direct-consult'];
  if(d&&d.outcome) return t;
  if(d&&d.direct&&d.direct.canChangeTime) return t+' Change its time with Change time.';
  return t+' If its time is wrong, change it in Monday.';
}
/* ?record=1 (the lead page's "Record payment / Waived" button): open the box once, then
   drop the flag from the address so a reload does not open it again. */
var CP_OPEN_FROM_LINK=(function(){ try { return new URLSearchParams(window.location.search).get('record')==='1'; } catch(e){ return false; } })();
function cpOpenFromLink(d){
  if(!CP_OPEN_FROM_LINK) return; CP_OPEN_FROM_LINK=false;
  try { var u=new URL(window.location.href); u.searchParams.delete('record'); history.replaceState(null,'',u.toString()); } catch(e){}
  var cp=(d&&d.consultPayment)||{};
  if(cp.paid==='app') return;   // paid online: nothing to record
  openConsultPaymentModal(d,false);
}
/* The record box can send the package for this client (switch on, the package is for them, none sent). */
function cpRecOn(d){ var o=(d&&d.consultPayment&&d.consultPayment.onRecord)||{}; return !!(o.enabled&&o.applicable&&!o.alreadySent); }
function cpLooksTaxed(c,orc){
  var pct=Number((orc&&orc.hstPct)||0); if(!(pct>0)||!(c>0)) return false;
  var hit=false;
  ((orc&&orc.consultants)||[]).forEach(function(k){ (k.options||[]).forEach(function(o){ if(Math.round(o.feeCents*(1+pct/100))===c) hit=true; }); });
  return hit;
}
function cpPackageSection(orc, asks){
  if(!orc||!orc.enabled) return '';
  if(orc.alreadySent) return '<div class="paym-info">The consultation package already went out'+(orc.sentOn?' on '+payEsc(orc.sentOn):'')+' — recording the fee does not send it again.</div>';
  if(!asks) return '<div class="paym-info">'+payEsc((orc.why==='direct-consult'?cpDirectWhy(LAST_DETAIL):CP_WHY[orc.why])||'No consultation package is sent for this client.')+'</div>';
  var pf=orc.prefill||{};
  var cons=(pf.consultant?'':'<option value="">Choose…</option>')+(orc.consultants||[]).map(function(k){ return '<option value="'+payEsc(k.name)+'"'+(k.name===pf.consultant?' selected':'')+'>'+payEsc(k.name)+'</option>'; }).join('');
  var types=[['','Choose…'],['In-person','In person (at the office)'],['Virtual','Video (Teams)'],['Phone Call','Phone call']];
  return '<div class="paym-sec">Consultation booking</div>'+
    '<div class="paym-muted">The time you booked with the client — the email and the agreement state it. Toronto time.</div>'+
    (orc.heldOnline?'<div class="paym-warn">The client is booking online right now (their time is held). Wait until the hold ends, or ask them not to pay online — the app will not record over it.</div>':'')+
    '<div class="cp-grid"><div><label for="cp-bk-date">Date</label><input id="cp-bk-date" type="date" min="'+cpTodayStr()+'" value="'+payEsc(pf.date||'')+'"></div>'+
    '<div><label for="cp-bk-time">Time</label><input id="cp-bk-time" type="time" step="300" value="'+payEsc(pf.time||'')+'"></div></div>'+
    '<div class="cp-grid"><div><label for="cp-bk-cons">Consultant</label><select id="cp-bk-cons" class="cp-sel">'+cons+'</select>'+(pf.suggested?'<div class="paym-hint">Suggested by the case type: '+payEsc(pf.suggested)+'</div>':'')+'</div>'+
    '<div><label for="cp-bk-len">Length</label><select id="cp-bk-len" class="cp-sel"></select></div></div>'+
    '<label for="cp-bk-type">How</label><select id="cp-bk-type" class="cp-sel">'+types.map(function(t){ return '<option value="'+t[0]+'"'+(t[0]===(pf.meetingType||'')?' selected':'')+'>'+payEsc(t[1])+'</option>'; }).join('')+'</select>'+
    '<div class="paym-hint" id="cp-bk-hint"></div>'+
    '<div class="paym-sec" id="cp-pkg-q">Email the client the consultation agreement and pre-consultation form?</div>'+
    '<div role="radiogroup" aria-labelledby="cp-pkg-q">'+
    '<label class="cp-choice'+(orc.hasEmail?'':' off')+'" id="cp-pkg-send-l"><input type="radio" name="cp-pkg" value="send"'+(orc.hasEmail?'':' disabled')+'><span id="cp-pkg-send-t">Yes — email them now</span></label>'+
    '<label class="cp-choice"><input type="radio" name="cp-pkg" value="skip"><span id="cp-pkg-skip-t">No — don’t email them</span></label>'+
    '</div>'+
    '<div id="cp-pkg-note-w" style="display:none"><label for="cp-pkg-note" id="cp-pkg-note-l">Why not?</label><input id="cp-pkg-note" type="text" maxlength="200" autocomplete="off" value="'+payEsc(orc.recordNote||'')+'"></div>'+
    '<div class="paym-hint" id="cp-pkg-hint" aria-live="polite"></div>'+
    '<div class="cp-preview" id="cp-preview" style="display:none"></div>';
}
function cpPackageBind(box, orc, cur, kindEl, amtEl, onSend){
  var q=function(sel){ return box.querySelector(sel); };
  var consEl=q('#cp-bk-cons'), lenEl=q('#cp-bk-len'), typeEl=q('#cp-bk-type'), dateEl=q('#cp-bk-date'), timeEl=q('#cp-bk-time');
  var sendEl=q('input[name="cp-pkg"][value="send"]'), skipEl=q('input[name="cp-pkg"][value="skip"]'), noteW=q('#cp-pkg-note-w'), noteEl=q('#cp-pkg-note'), noteL=q('#cp-pkg-note-l');
  var bkHint=q('#cp-bk-hint'), pkHint=q('#cp-pkg-hint'), prev=q('#cp-preview');
  var touched=false, pf=orc.prefill||{};
  function optsFor(name){ var k=(orc.consultants||[]).filter(function(c){ return c.name===name; })[0]; return (k&&k.options)||[]; }
  function fillLen(keep){
    var opts=optsFor(consEl.value), want=keep?Number(lenEl.value||pf.durationMin||0):Number(pf.durationMin||0);
    lenEl.innerHTML=opts.map(function(o){ return '<option value="'+o.durationMin+'">'+o.durationMin+' minutes</option>'; }).join('');
    if(opts.some(function(o){ return o.durationMin===want; })) lenEl.value=String(want);
  }
  function choice(){ return sendEl&&sendEl.checked?'send':(skipEl&&skipEl.checked?'skip':''); }
  function waived(){ return kindEl&&kindEl.value==='waived'; }
  function sync(){
    var c=choice(), w=waived();
    q('#cp-pkg-send-t').textContent=w?'Yes — email them':'Yes — email them now';
    noteW.style.display=(c==='skip')?'':'none';
    noteL.textContent=w?'Why not? (optional)':'Why not? (e.g. given to them in person, or the consultation already happened)';
    var willBook=!!(dateEl.value&&timeEl.value);
    bkHint.textContent=(typeEl.value==='Virtual'&&(c==='send'||willBook))?'A Teams meeting is created — the client and the consultant get its invite.':'';
    pkHint.textContent=!orc.hasEmail?'There is no email for this client, so the package cannot be emailed.':(c==='send'&&!orc.hasAddress?'There is no residential address on this lead — the package waits until you add it on this page (the agreement prints it).':(c==='skip'?'Leave the date and time empty if the consultation has already happened. The booking reminders still go out for a time ahead.':''));
    onSend(c==='send');
    preview();
  }
  function preview(){
    if(choice()!=='send'){ prev.style.display='none'; return; }
    var t;
    if(waived()) t='The agreement will say the consultation fee was waived.';
    else {
      var c=payParseCents(amtEl?amtEl.value:''), pct=Number(orc.hstPct||0), st=orc.stored;
      if(isNaN(c)||c<=0){ prev.style.display='none'; return; }
      // the server keeps the HST fixed when the fee was first recorded if the amount is unchanged
      var total=(st&&st.kind!=='waived'&&st.amountCents===c&&typeof st.hstCents==='number')?(c+st.hstCents):Math.round(c*(1+pct/100));
      if(total>c) pct=Math.max(pct,1);
      t='The agreement will say the client has paid '+cpMoney(total)+(pct>0?' (incl. HST)':'')+'.';
    }
    prev.textContent=t; prev.style.display='';
  }
  function kindChanged(){
    // A NEW record follows the kind until staff pick: waived = no answer, paid = yes.
    // A record being changed keeps its stored choice — unless the kind crosses
    // waived <-> paid, which asks again (waived never starts with an answer).
    if(!touched){
      var w=waived();
      if(!cur){ if(sendEl) sendEl.checked=!w&&!!orc.hasEmail; if(skipEl) skipEl.checked=false; }
      else if((cur.paid==='waived')!==w){ if(sendEl) sendEl.checked=false; if(skipEl) skipEl.checked=false; }
      else { if(sendEl) sendEl.checked=(orc.record==='send'&&!!orc.hasEmail); if(skipEl) skipEl.checked=(orc.record==='skip'); }
    }
    sync();
  }
  if(cur){ if(orc.record==='send'&&sendEl&&orc.hasEmail) sendEl.checked=true; else if(orc.record==='skip'&&skipEl) skipEl.checked=true; }
  fillLen(false);
  consEl.onchange=function(){ fillLen(true); };
  typeEl.onchange=sync; dateEl.onchange=sync; timeEl.onchange=sync;
  [sendEl,skipEl].forEach(function(el){ if(el) el.onchange=function(){ touched=true; sync(); }; });
  kindChanged();
  function collect(kind){
    var c=choice();
    if(!c) return { error:'Choose whether to email the consultation agreement and form to the client.', focus:(sendEl&&!sendEl.disabled)?sendEl:skipEl };
    var note=(noteEl.value||'').trim();
    if(c==='skip'&&kind!=='waived'&&note.length<3) return { error:'Say why the client is not being emailed the agreement and form.', focus:noteEl };
    // "No": a booking is saved only when a date AND a time are entered (the How box alone is not a booking).
    var any=(c==='skip')?!!(dateEl.value||timeEl.value):true, bk=null;
    if(c==='send'||any){
      if(!dateEl.value) return { error:'Enter the consultation date.', focus:dateEl };
      if(!timeEl.value) return { error:'Enter the consultation time.', focus:timeEl };
      if(!consEl.value) return { error:'Choose the consultant.', focus:consEl };
      if(!typeEl.value) return { error:'Choose how the consultation happens: in person, video or phone.', focus:typeEl };
      if(!lenEl.value) return { error:'Choose the length.', focus:lenEl };
      bk={ date:dateEl.value, time:String(timeEl.value).slice(0,5), consultant:consEl.value, meetingType:typeEl.value, durationMin:Number(lenEl.value) };
    }
    return { package:c, packageNote:c==='skip'?note:'', booking:bk };
  }
  return { kindChanged:kindChanged, preview:preview, collect:collect };
}
function openConsultPaymentModal(d, clear){
  tdotPayViewer(function(v){
    var cp=(d&&d.consultPayment)||{};
    var cur=(cp.paid&&cp.paid!=='app')?cp:null;
    if(clear&&!cur) return;
    var dlg=payOverlay();
    var feeDefault=(cur&&cur.paid!=='waived'&&cur.paidCents)?cur.paidCents:(cp.feeCents||null);
    var kinds=[['cash','Cash'],['e-transfer','E-transfer'],['square','Paid in Square (booked by the team, not the booking link)'],['invoice','Invoice sent by the team (not the booking link)'],['other','Other'],['waived','Waived — no fee']];
    var orc=cp.onRecord||{};
    var asks=!clear && !!(orc.enabled && orc.applicable && !orc.alreadySent);
    var h=payTitle(clear?'Remove the payment record':(cur?'Change the consultation payment record':'Record the consultation payment'), clear)+
      '<div class="paym-client">For <b>'+payEsc(d.name||'this client')+'</b>'+((d.bookedSlot&&d.bookingStatus==='Booked')?' · consultation '+payEsc(d.bookedSlot):(d.bookedSlot?' · not booked in the app (an online hold for '+payEsc(d.bookedSlot)+' expired)':''))+'</div>';
    if(clear){
      h+='<div class="paym-warn">This removes the record that the fee was '+(cur.paid==='waived'?'waived':('paid — '+payEsc(CP_LABELS[cur.paid]||cur.paid)+(cur.paidCents?' '+cpMoney(cur.paidCents):'')))+'. The lead keeps a note of it. Use this for a record made by mistake.'+
        ((cp.onRecord&&cp.onRecord.enabled&&d.bookingStatus==='Booked'&&d.bookedSlot)?' It does NOT cancel the booking ('+payEsc(d.bookedSlot)+') — change Booking Status in Monday if that was a mistake too.':'')+'</div>';
    } else {
      h+=(orc.enabled?'':'<div class="paym-info">A record only — the client gets no email and no automatic step runs. A payment made through the booking link records itself.</div>')+
        '<label for="cp-kind">How was the fee settled?</label>'+
        '<select id="cp-kind" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;font-family:inherit;box-sizing:border-box">'+
          kinds.map(function(k){ return '<option value="'+k[0]+'"'+(((cur?cur.paid:'cash')===k[0])?' selected':'')+'>'+payEsc(k[1])+'</option>'; }).join('')+
        '</select>'+
        '<div id="cp-amt-wrap"><label for="cp-amt">Fee received <span class="paym-muted">(CAD, before HST — the way the KPIs count booking-link payments)</span></label>'+
        '<input id="cp-amt" type="text" inputmode="decimal" autocomplete="off" value="'+(feeDefault?(feeDefault/100).toFixed(2):'')+'"><div class="paym-hint" id="cp-amt-hint"></div></div>'+
        '<label for="cp-on">Date received</label><input id="cp-on" type="date" max="'+cpTodayStr()+'" value="'+payEsc((cur&&cur.on)?cur.on:cpTodayStr())+'">'+
        '<label for="cp-ref">Reference <span class="paym-muted">(optional — e-transfer or invoice number)</span></label><input id="cp-ref" type="text" maxlength="120" autocomplete="off" value="'+payEsc(cur?(cur.reference||''):'')+'">'+
        '<label for="cp-note">Note <span class="paym-muted">(optional — e.g. why the fee was waived)</span></label><input id="cp-note" type="text" maxlength="200" autocomplete="off" value="'+payEsc(cur?(cur.note||''):'')+'">'+
        cpPackageSection(orc, asks);
    }
    h+=(v.signedIn
        ? '<div class="paym-muted" style="margin-top:10px">Recorded as <b>'+payEsc(v.name)+'</b> (signed in with Monday).</div>'
        : '<label for="cp-by">Your name</label><input id="cp-by" type="text" maxlength="60" value="'+payEsc(payTypedName())+'">')+
      '<div class="paym-err" role="alert"></div>'+
      '<div class="paym-actions"><button type="button" class="paym-btn" data-x>Cancel</button>'+
      '<button type="button" class="paym-btn '+(clear?'danger':'primary')+'" data-go>'+(clear?'Remove record':(cur?'Save change':'Record'))+'</button></div>';
    var goLabel=clear?'Remove record':(cur?'Save change':'Record');
    dlg.box.innerHTML=h;
    dlg.box.querySelector('[data-x]').onclick=dlg.close;
    var kindEl=dlg.box.querySelector('#cp-kind'), amtWrap=dlg.box.querySelector('#cp-amt-wrap'), amtEl=dlg.box.querySelector('#cp-amt'), hint=dlg.box.querySelector('#cp-amt-hint');
    var pk=asks?cpPackageBind(dlg.box, orc, cur, kindEl, amtEl, function(send){ dlg.box.querySelector('[data-go]').textContent=send?(cur?'Save & email':'Record & email'):goLabel; }):null;
    function syncKind(){ if(!kindEl||!amtWrap) return; amtWrap.style.display=(kindEl.value==='waived')?'none':''; if(pk) pk.kindChanged(); }
    function refreshHint(){
      if(!amtEl||!hint) return;
      var c=payParseCents(amtEl.value);
      hint.textContent=(isNaN(c)||c<=0)?'Enter the fee received, before HST.':(cpLooksTaxed(c,orc)?('This looks like the total WITH HST — enter the fee before HST (the agreement adds the HST).'):((cp.feeCents&&c!==cp.feeCents)?('The booking fee for this consultation is '+cpMoney(cp.feeCents)+'.'):''));
      if(pk) pk.preview();
    }
    if(kindEl){ kindEl.onchange=syncKind; syncKind(); }
    if(amtEl){ amtEl.oninput=refreshHint; refreshHint(); }
    dlg.box.querySelector('[data-go]').onclick=function(){
      var err=dlg.box.querySelector('.paym-err');
      var byEl=dlg.box.querySelector('#cp-by'); var by=byEl?byEl.value.trim():(v.name||'');
      if(!by){ err.textContent='Enter your name — it is recorded with the payment.'; if(byEl) byEl.focus(); return; }
      var payload;
      if(clear){ payload={kind:'clear'}; }
      else {
        var kind=kindEl.value, cents=null;
        if(kind!=='waived'){ cents=payParseCents(amtEl.value); if(isNaN(cents)||cents<=0){ err.textContent='Enter the fee received, in dollars and cents.'; amtEl.focus(); return; } }
        var on=dlg.box.querySelector('#cp-on').value; if(!on){ err.textContent='Enter the date received.'; return; }
        payload={kind:kind, amountCents:cents, on:on, reference:dlg.box.querySelector('#cp-ref').value.trim(), note:dlg.box.querySelector('#cp-note').value.trim()};
        if(pk){ var pr=pk.collect(kind); if(pr.error){ err.textContent=pr.error; if(pr.focus) pr.focus.focus(); return; } payload.package=pr.package; payload.packageNote=pr.packageNote; if(pr.booking) payload.booking=pr.booking; }
      }
      if(byEl) paySaveName(by);
      dlg.close();
      doAction('recordConsultPayment', JSON.stringify(payload), null, by);
    };
    setTimeout(function(){ var f=kindEl||dlg.box.querySelector('#cp-by')||dlg.box.querySelector('[data-go]'); if(f) f.focus(); },30);
  });
}
// The Not Wanted list (point 5): the staff-only warning under the header; named admins get "Remove from the list…".
function renderBlacklist(d){
  var el=document.getElementById('bl-banner'); if(!el) return;
  var r=d.blacklist;
  if(!r||(r.checked!==false&&!r.hit)){ el.innerHTML=''; return; }
  el.innerHTML=tdotBlacklistHtml(r,{leadLinks:true});
  tdotBlViewer(function(v){
    if(!(v&&v.canUndo)) return;
    el.innerHTML=tdotBlacklistHtml(r,{leadLinks:true, canRemove:true});
    tdotBlacklistBind(el,function(res){ setMsg((res&&res.message)||'Removed from the Not Wanted list.','ok'); load(); });
  });
}
var LAST_DETAIL=null; // the detail last rendered — the send button's confirm text reads the package state from it
/* Opened without ?from=: the way back is the list the client is on right now — the server says which (d.onList, the
   lists' own rule): Retainers & follow-ups, the case (once retained) or the lead page; the top bar follows. */
function pointBackAtList(d){
  var bl=document.getElementById('back-lnk'), txt=document.getElementById('back-lnk-txt');
  if(!bl||/[?&]from=(retainers|consultations)(&|$)/.test(window.location.search)) return;   /* opened from a list page: the plain link returns to it */
  var list=String(d.onList||''), href='', label='', nav='';
  /* Opened from elsewhere (Consultations, the lead page, an email): back to the tab the client is under (point 7).
     From the Retainers page itself (?from=retainers, above) the plain link returns to the tab the person was on. */
  if(list==='retainers'){ href='/admin/retainers?outcome='+encodeURIComponent(d.onListTab||'All'); label='Retainers & follow-ups'; nav='/admin/retainers'; }
  else if(list==='cases'){ var ref=(d.retainerPlan&&d.retainerPlan.caseRef)||''; href=ref?'/admin/case/'+encodeURIComponent(ref):'/admin/dashboard'; label=ref?'Case '+ref:'Client Master'; nav='/admin/dashboard'; }
  else if(list==='leads'){ href='/admin/lead/'+encodeURIComponent(d.leadId||''); label='Lead page'; nav='/admin/leads'; }
  if(!href) return;
  bl.href=href; if(txt) txt.textContent=label;
  Array.prototype.forEach.call(document.querySelectorAll('.admin-nav .nav-lnk'),function(a){
    var on=a.getAttribute('href')===nav;
    a.classList.toggle('active',on); if(on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
  });
}
var CD_DIRTY=false, CD_DL=null;
function hydrateDeadline(d){
  if(!CD_DL){ CD_DL=window.tdotDeadlineBox('cd'); Array.prototype.forEach.call(document.querySelectorAll('#cd-dl input'),function(i){ i.addEventListener('change',function(){ CD_DIRTY=true; }); }); }
  if(!CD_DIRTY) CD_DL.set(d.deadline||{});
}
function render(d){
  LAST_DETAIL=d;
  pointBackAtList(d);
  hydrateDeadline(d);
  document.getElementById('c-avatar').textContent=initials(d.name||d.leadId);
  document.getElementById('c-name').textContent=d.name||d.leadId;
  document.getElementById('c-sub').textContent=(d.serviceRequired||'—')+'  ·  '+(d.tier?('Tier '+d.tier):'')+'  ·  lead '+d.leadId;

  var acts='';
  if(d.meetingLink) acts+='<a class="btn primary" href="'+escHtml(safeUrl(d.meetingLink))+'" target="_blank" rel="noopener">'+ICONS.video+' Join meeting</a>';
  if(d.preConsultPdf) acts+='<a class="iconbtn" title="Dossier PDF" aria-label="Dossier PDF" href="'+escHtml(safeUrl(d.preConsultPdf))+'" target="_blank" rel="noopener">'+ICONS.file+'</a>';
  if(d.recordingLink) acts+='<a class="iconbtn" title="Recording" aria-label="Recording" href="'+escHtml(safeUrl(d.recordingLink))+'" target="_blank" rel="noopener">'+ICONS.disc+'</a>';
  if(d.transcriptLink) acts+='<a class="iconbtn" title="Transcript" aria-label="Transcript" href="'+escHtml(safeUrl(d.transcriptLink))+'" target="_blank" rel="noopener">'+ICONS.file+'</a>';
  if(d.email) acts+='<a class="iconbtn" title="Email client" aria-label="Email client" href="'+escHtml(safeUrl('mailto:'+d.email))+'">'+ICONS.mail+'</a>';
  /* A direct consultation (step 2): a wrongly typed time would block a real slot on the booking page — change it here (until an outcome is set). */
  /* Only for someone the server accepts (the switch, a list switch's Monday sign-in, the column made): never a button that always fails. */
  if(d.direct && d.direct.canChangeTime && !d.outcome) acts+='<button type="button" class="btn" id="btn-dq-time" title="Change the date, time or length of this direct consultation (no email goes to the client)">'+ICONS.clock+' Change time</button>';
  /* The consultant is not an RCIC (Gauri, or a name typed on Monday): Retain needs an RCIC — choose one here. */
  if(d.direct && d.direct.needsRcic && !d.outcome) acts+='<button type="button" class="btn" id="btn-dq-cons" title="Retain needs an RCIC as the consultant — choose one">'+ICONS.userCheck+' Change consultant</button>';
  document.getElementById('c-acts').innerHTML=acts;
  var dqtBtn=document.getElementById('btn-dq-time'); if(dqtBtn) dqtBtn.onclick=function(){ openChangeTime(LAST_DETAIL||d); };
  var dqcBtn=document.getElementById('btn-dq-cons'); if(dqcBtn) dqcBtn.onclick=function(){ openChangeConsultant(LAST_DETAIL||d); };

  var pills='';
  pills+='<span class="chip blue">'+ICONS.clock+'<span class="pk">Slot</span> '+escHtml(d.bookedSlot||'—')+'</span>';
  pills+='<span class="chip '+(d.preConsultSubmitted?'green':'amber')+'"><span class="pk">Pre-consult</span> '+(d.preConsultSubmitted?'Submitted':'Pending')+'</span>';
  pills+='<span class="chip '+(d.outcome==='Retain'?'green':d.outcome==='Follow-Up'?'amber':d.outcome==='Not Wanted'?'red':'grey')+'"><span class="pk">Outcome</span> '+escHtml(d.outcome||'Not set')+'</span>';
  if(d.retainerFee) pills+='<span class="chip grey"><span class="pk">Fee</span> $'+escHtml(d.retainerFee)+'</span>';
  if(d.direct){ var dqTip=(d.direct.bookedBy?'Booked by '+d.direct.bookedBy+' · ':'')+(d.direct.kind||'Direct consultation'); pills+='<span class="chip direct" title="'+escHtml(dqTip)+'" aria-label="Direct consultation: '+escHtml(dqTip)+'">direct</span>'; }
  document.getElementById('c-pills').innerHTML=pills;

  var ac=d.assignedConsultant||{};
  document.getElementById('c-consultant').innerHTML = ac.name
    ? '<span class="chip green">'+ICONS.userCheck+escHtml(ac.name)+(ac.needsVerify?' <span class="rp-flag verify">verify</span>':'')+'</span>'+(ac.reason?'<span class="chip-reason">routed: '+escHtml(ac.reason)+'</span>':'')
    : '';

  /* This queue is booked-only, so the booking invite is moot here — sending
     would be rejected server-side anyway; pre-booking invites live on the
     Leads page (with the personalized-message editor). */
  var inviteBtn=document.getElementById('btn-invite');
  if(inviteBtn && d.bookingStatus==='Booked') inviteBtn.style.display='none';

  document.getElementById('c-stepper').innerHTML=buildStepper(d);

  highlightOutcome(d.outcome||'');
  hydrateAttribution(d);
  hydrateConsultPayment(d);
  renderBlacklist(d);
  // No email (2026-11-04: a walk-in may come with a phone only). This page cannot edit the email — the lead page can.
  (function(){
    var w=document.getElementById('email-warn'); if(!w) return;
    if(String(d.email||'').trim()){ w.innerHTML=''; return; }
    var id=d.leadId||d.id||'';
    w.innerHTML='<div class="email-warn" role="status"><b>No email address on file.</b> The retainer agreement, payment links and receipts are sent by email, so the system can'+String.fromCharCode(8217)+'t send them to this client. '+
      'Add the client'+String.fromCharCode(8217)+'s email on the <a href="/admin/lead/'+encodeURIComponent(id)+'">lead page</a> (Basic details)'+(d.phone?' — phone: '+escHtml(d.phone):'')+'.</div>';
  })();
  var fee=document.getElementById('fee'); if(fee && !fee.value && d.retainerFee) fee.value=d.retainerFee;
  // Hydrate the retainer panel from the detail payload ONCE (saves a second
  // getLead round-trip); later renders (after an action) keep in-progress edits.
  if(!RP_HYDRATED){
    if(d.retainerPlan){ hydrateRetainer(d.retainerPlan); RP_HYDRATED=true; }
    else { loadRetainerPlan(); } // fallback: separate fetch (older payload)
  } else { updateMileSum(); } // keep the milestone sum in step with the fee
  // Lock fee+plan once the agreement is sent — OR the client has already signed /
  // been retained — so a fresh agreement is never re-sent to a retained client
  // (mirrors the server guard). Reset amend on every render so the panel re-locks
  // after any action, not just a committed one.
  var _retSent   = !!(d.retainerSent   && String(d.retainerSent).trim());
  var _retSigned = !!(d.retainerSigned && String(d.retainerSigned).trim());
  var _retained  = String(d.conversionStatus||'').trim()==='Retained';
  var _caseOpen  = !!(d.clientMasterItemId && String(d.clientMasterItemId).trim());
  // NOTE: retainerPaid alone does NOT lock — walk-in clients often prepay their
  // first milestone before the agreement is sent; the send must stay available.
  RP_SENT = _retSent; RP_RETAINED = _retSigned || _retained;
  // "Mark retainer signed" disables once the deal is DONE — the case is open or the
  // client is retained — but STAYS enabled for a signed lead whose handoff failed
  // (no case yet), so staff can retry per the failed-handoff recovery note.
  RP_SIGNED = (_retSigned && _caseOpen) || _retained;
  RP_SIGNED_WHY = d.caseDeleted ? 'Retainer already signed — this client’s case was deleted (see “Case deleted”); no case opens by itself'
    : _caseOpen ? 'Retainer already signed — the case is open' : 'Retainer already signed — the client is retained';
  RP_LIST_USED = (_retSigned || _retained) && _caseOpen;
  RP_LOCKED = _retSent || RP_RETAINED; RP_AMEND = false; applyRetainerLock();

  var ca=d.consultAgreement||{};
  var cactr=ca.countersign||{};
  var caSigned=Boolean(ca.signed);
  document.getElementById('ca-sent').textContent=
    cactr.signedAt?('· fully signed '+cactr.signedAt):
    caSigned?('· client signed '+ca.signed+(cactr.sentAt?(' · countersign sent '+cactr.sentAt):'')):
    ca.sent?('· sent '+ca.sent):
    ca.pending?'· being sent right now — reload in a minute before doing anything':
    ca.emailedAt?'· emailed to the client, but the Sent date could not be saved — set "Consult Agreement Sent" by hand; do NOT re-send':
    ca.stalled?'· automatic send was interrupted — check the client\\'s inbox and Documenso, then "Review & send" if needed':
    ca.expired?'· not sent automatically — the consultation time had already passed or begun; "Review & send" if still needed':
    (ca.held==='slot-clash')?'· HELD — another client is booked for the same time; sort out the time, then "Review & send"':
    (ca.held==='late-payment')?'· HELD — the client paid after the slot hold expired; confirm the time with the client, then "Review & send"':
    (ca.held&&ca.attempts>=3)?'· HELD — the automatic release failed 3 times; use "Review & send"':
    (ca.held==='blank-address'&&ca.heldBy==='recorded'&&!ca.recordOn)?'· HELD — sending from the fee record is switched off; use "Review & send"':
    ca.held?(ca.autoSend?'· HELD — no residential address; enter it below and the package sends itself':'· HELD by the automatic package, which is now switched off — use "Review & send"'):
    (ca.autoSend&&d.bookingStatus!=='Booked')?('· not sent yet — sends automatically when the consultation is paid'+(cpRecOn(d)?' online, or when you record the fee with the booking ("Record payment / Waived")':'')):
    ca.skipped?('· not sent — staff chose not to email it when recording the fee ('+ca.skipped+')'):
    (ca.autoSend&&cpRecOn(d)&&!(d.consultPayment&&d.consultPayment.paid))?'· not sent — record the fee with the booking ("Record payment / Waived") to email it, or use "Review & send"':
    ca.autoSend?'· not sent — this booking predates automatic sending, or the send did not run; use "Review & send"':'';
  var caw=document.getElementById('ca-warn');
  // The editable address — never overwrite a value the consultant is typing.
  var cad=document.getElementById('ca-address');
  if(cad && !ADDR_DIRTY && document.activeElement!==cad) cad.value=d.residentialAddress||'';
  // Pre-send warnings (blank address etc.) are moot once the client has signed.
  caw.innerHTML=(!caSigned&&ca.warnings&&ca.warnings.length)
    ? '<div class="rp-warn"><b>Before sending:</b><ul>'+ca.warnings.map(function(w){return '<li>'+escHtml(w)+'</li>';}).join('')+'</ul></div>' : '';
  // Once the client signs, the document of record is the SIGNED copy — preview /
  // Review & send are redundant and hide. In their place: view the signed
  // agreement, and (until the RCIC countersigns) sign as the consultant.
  // Resend links stays — it re-sends the MEETING + pre-consult form links,
  // which a signed-but-form-pending client still needs.
  document.getElementById('btn-consult-preview').style.display=caSigned?'none':'';
  document.getElementById('btn-consult-send').style.display=caSigned?'none':'';
  document.getElementById('btn-consult-signed-view').style.display=caSigned?'':'none';
  // Mirrors the retainer row (user directive 2026-08-04): the envelope is now
  // issued automatically when the client signs, so this button STAYS VISIBLE
  // and reports state — 'Sign as consultant' → 'Open countersign link' (already
  // emailed; re-opens the same page) → 'Countersigned' (disabled) — instead of
  // vanishing and leaving staff unsure whether anything happened.
  CS_RC_DONE=Boolean(cactr.signedAt);
  CS_RC_SENT=Boolean(cactr.sentAt)&&!CS_RC_DONE;
  var csBtn=document.getElementById('btn-consult-countersign');
  csBtn.style.display=caSigned?'':'none';
  csBtn.disabled=CS_RC_DONE;
  csBtn.title=CS_RC_DONE ? 'Agreement already countersigned by the consultant'
    : CS_RC_SENT ? 'Already emailed to the consultant — click to open the signing page again'
    : 'Add the consultant (RCIC) signature to the client-signed agreement';
  var csLbl=csBtn.querySelector('.btn-label');
  if(csLbl) csLbl.textContent=CS_RC_DONE ? 'Countersigned'
    : CS_RC_SENT ? 'Open countersign link' : 'Sign as consultant';

  document.getElementById('c-status').innerHTML=
    kv('Booking status',d.bookingStatus)+kv('Consultation held',d.consultationHeld)+
    kv('Outcome',d.outcome||'Not set')+kv('Retainer fee',d.retainerFee?('$'+d.retainerFee):'')+
    kv('Retainer sent',d.retainerSent)+kv('Retainer signed',d.retainerSigned)+
    kv('Retainer countersigned',(d.retainerCountersign||{}).signedAt)+
    kv('Retainer paid',d.retainerPaid)+
    kv('Deadline',(d.deadline&&d.deadline.text)||'Not set')+
    (d.clientMasterItemId?kv('Case created','Yes (handed off)'):'')+
    /* point 8 (2026-11-05): its case was deleted and this consultation record kept */
    (d.caseDeleted?kv('Case deleted',d.caseDeleted+' — this consultation record was kept; no new case opens by itself (clear “Case deleted” on the lead in Monday to allow one)'):'')+
    (d.direct?kv('Added as','Direct consultation · '+(d.direct.kind||'?')+(d.direct.followUpOf?' (follow-up of lead '+d.direct.followUpOf+')':'')+(d.direct.caseRef?' · case '+d.direct.caseRef:''))+
      kv('In Square',d.direct.inSquare===true?'Yes — the app sends the client no reminders':d.direct.inSquare===false?'No — the app sends the reminders':'')+
      kv('Added by',d.direct.by):'');
  // RCIC countersign of the retainer: both buttons appear once the CLIENT has
  // signed. After the countersign completes, "Sign retainer as consultant"
  // stays visible but DISABLED (applyRetainerLock owns the disabled state so
  // it survives disableActions round-trips); "View signed retainer" — last in
  // the row — is the one action that stays live.
  var rcs=d.retainerCountersign||{};
  var rSigned=Boolean(d.retainerSigned);
  RP_RC_DONE=Boolean(rcs.signedAt);
  RP_RC_SENT=Boolean(rcs.sentAt)&&!RP_RC_DONE;   // envelope out, awaiting the consultant
  document.getElementById('btn-retainer-signed-view').style.display=rSigned?'':'none';
  document.getElementById('btn-retainer-countersign').style.display=rSigned?'':'none';
  applyRetainerLock();

  document.getElementById('c-intake').innerHTML=
    kv('Email',d.email)+kv('Phone',d.phone)+kv('Country',d.country)+
    kv('Service',d.serviceRequired)+kv('Inside Canada',d.insideCanada)+kv('Current status',d.currentStatus)+
    kv('Spouse',d.hasSpouse)+kv('Children',d.childrenCount)+
    (d.situationDescription?'<div class="subhead" style="margin-top:10px">Their inquiry</div><div style="font-size:13px;color:var(--navy);line-height:1.6;max-width:var(--read-max)">'+escHtml(d.situationDescription)+'</div>':'');

  // Eligibility profile
  var e=d.eligibility||{};
  var el=document.getElementById('c-elig');
  document.getElementById('c-elig-when').textContent=e.submitted&&e.submittedAt?('· submitted '+new Date(e.submittedAt).toLocaleDateString()):'';
  if(!e.submitted){ el.innerHTML='<div class="notyet">The client hasn\\'t submitted the pre-consultation form yet.</div>'; }
  else {
    var p=e.personal||{}, l=e.language||{}, fam=e.family||{};
    var h='<div class="subhead">Personal</div>'+
      kv('Age',p.age)+kv('In Canada',p.inCanada)+kv('Entered Canada',p.entryDate)+kv('Entry visa',p.entryVisa)+
      kv('Current status',p.currentStatus)+kv('Permit expiry',p.permitExpiry)+kv('Marital status',p.marital)+
      kv('Children',p.children)+kv('Relatives in Canada (PR/citizen)',p.relatives);
    h+='<div class="subhead" style="margin-top:10px">Education</div>'+kv('Highest education',e.highestEducation);
    (e.education||[]).forEach(function(r,i){ h+='<div class="rrow"><b>Education '+(i+1)+':</b> '+escHtml([r.program,r.school,r.location,(r.start||r.end)?((r.start||'?')+'–'+(r.end||'?')):'',r.completed].filter(Boolean).join(' · '))+'</div>'; });
    h+='<div class="subhead" style="margin-top:10px">Employment</div>'+kv('Paid TEER 0–3 work (last 5y)',e.teer);
    (e.employment||[]).forEach(function(r,i){ h+='<div class="rrow"><b>Job '+(i+1)+':</b> '+escHtml([r.title,r.company,r.country,(r.start||r.end)?((r.start||'?')+'–'+(r.end||'?')):'',r.type,r.hours?(r.hours+'h/wk'):'',r.duties].filter(Boolean).join(' · '))+'</div>'; });
    h+=kv('Employer earned > $1M (PNP)',e.employerRevenue);
    h+='<div class="subhead" style="margin-top:10px">Language</div>'+kv('English test',l.englishTest)+kv('English type',l.englishType)+kv('English (L/R/W/S)',scores(l.english))+kv('French test',l.frenchTest)+kv('French (L/R/W/S)',scores(l.french));
    h+='<div class="subhead" style="margin-top:10px">Family for assessment</div>'+kv('Spouse / common-law',fam.hasSpouse)+kv('Consider spouse profile',fam.spouseConsider)+kv('Adult child (18+) to consider',fam.adultChild);
    if(e.finalNote) h+='<div class="subhead" style="margin-top:10px">Client note</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(e.finalNote)+'</div>';
    el.innerHTML=h;
  }

  var ai='';
  if(d.aiTalkingPoints) ai+='<div class="subhead">Talking points</div><div style="font-size:13px;color:var(--navy);line-height:1.6;white-space:pre-wrap">'+escHtml(d.aiTalkingPoints)+'</div>';
  if(d.aiComplianceFlags) ai+='<div class="subhead" style="margin-top:10px">Compliance flags</div><div style="font-size:13px;color:#b45309;line-height:1.6;white-space:pre-wrap">'+escHtml(d.aiComplianceFlags)+'</div>';
  if(d.priorityReasons) ai+='<div class="subhead" style="margin-top:10px">Priority reasons</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(d.priorityReasons)+'</div>';
  document.getElementById('c-ai').innerHTML=ai||'<div class="notyet">No AI notes on this lead.</div>';
}

function load(){
  var key=getKey(); if(!key) return;
  fetch('/api/consultation/'+encodeURIComponent(LEAD_ID),{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); }
     if(r.status===404) throw new Error('Consultation not found'); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
   .then(function(d){ render(d); document.getElementById('loading').style.display='none'; document.getElementById('content').style.display='block'; cpOpenFromLink(d); })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}

// ── Phase B: write actions ────────────────────────────────────────────────
function setMsg(text,kind){ var el=document.getElementById('act-msg'); el.className='act-msg '+kind; el.textContent=text; }
function cdMsg(text,kind){ var el=document.getElementById('cd-msg'); if(el){ el.className='act-msg '+kind; el.textContent=text; } }   /* the Deadline card's own line */
function actButtons(){ return Array.prototype.slice.call(document.querySelectorAll('.actions button:not(.rmk-chip):not(#rmk-post)')); } // the remarks widget manages its own busy state
function disableActions(on){
  actButtons().forEach(function(b){ b.disabled=on; });
  // Re-enabling blanket-clears disabled — reapply the gated states so a failed
  // action can't leave "Mark retainer signed"/"Sign retainer as consultant"
  // (and the progressive fee/save/send gates) falsely clickable.
  if(!on && typeof applyRetainerLock==='function') applyRetainerLock();
}
function highlightOutcome(cur){ Array.prototype.forEach.call(document.querySelectorAll('.obtn'),function(b){ b.classList.toggle('active', b.getAttribute('data-outcome')===cur); }); }

// fetch with a hard timeout so a hung request (e.g. a stalled CloudConvert
// render) can't leave the action buttons disabled forever.
function fetchT(url,opts,ms){ var ac=new AbortController(); var to=setTimeout(function(){ac.abort();},ms||60000); opts=opts||{}; opts.signal=ac.signal; return fetch(url,opts).finally(function(){clearTimeout(to);}); }
function netErr(e){ return e&&e.name==='AbortError' ? 'Timed out — please try again.' : ('Failed: '+(e&&e.message||e)); }

var ADDR_DIRTY=false;   // the residential-address box has unsaved typing (render() leaves it alone)
function doAction(action,value,confirmMsg,staffNameOverride,confirmed){
  if(confirmMsg && !window.confirm(confirmMsg)) return;
  var key=getKey(); if(!key) return;
  setMsg('Working…','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{
    method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'},
    body: JSON.stringify({ action:action, value:value, amend: RP_AMEND, confirm: confirmed===true, staffName: (staffNameOverride || (window.tdotRemarksName_rmk ? window.tdotRemarksName_rmk() : '')) })
  }).then(function(r){ return r.json().then(function(j){ return {status:r.status,j:j}; }); })
   .then(function(res){
     disableActions(false);
     if(res.status===401||res.status===403){ window.location.href='/admin'; return; }
     /* The server asks first (a direct consultation added as Follow-up / Existing client, step 2): nothing changed yet. */
     if(res.status===409 && res.j && res.j.needsConfirm && confirmed!==true){
       setMsg('Not done yet — read the question.','info');
       dqAskFirst(res.j.error||'Are you sure?', function(){ doAction(action,value,null,staffNameOverride,true); });
       return;
     }
     if(res.status!==200) throw new Error((res.j&&res.j.error)||('HTTP '+res.status));
     setMsg(res.j.message||'Done.','ok');
     if(action==='saveDeadline'){ CD_DIRTY=false; cdMsg(res.j.message||'Done.','ok'); }   // saved — the box may follow the server again
     if(action==='saveRetainerSelections'||action==='sendMilestoneEtransferRequest'||action==='markMilestonePaid'||action==='retainAndSend') RP_HYDRATED=false; // re-hydrate the panel (fresh plan / send state)
     // Setting the fee doesn't re-hydrate (keeps in-progress plan edits) — flip the gate here.
     if(action==='retainerFee'){ RP_FEE_SET=true; PERSISTED_FEE=String(value==null?'':value); }
     load(); // refresh consultation state (pills, status, outcome highlight) — render() re-locks + resets amend
   }).catch(function(e){ disableActions(false); setMsg(netErr(e),'err'); if(action==='saveDeadline') cdMsg(netErr(e),'err'); });
}

/* ── Direct consultation (step 2): the shared pop-up (dialogUi.js tdotDialogNew) for "asks first" and "Change time" ── */
function dqAskFirst(text, onYes){
  var dlg=tdotDialogNew({ cls:'dqt tdlg-narrow', labelledBy:'dqa-title' });
  dlg.box.innerHTML='<h3 id="dqa-title">Open a new case from this row?</h3><p>'+escHtml(text)+'</p>'+
    '<div class="tdlg-actions"><button type="button" class="tdlg-btn" data-x>Cancel</button><button type="button" class="tdlg-btn primary" data-go>Yes, go ahead</button></div>';
  dlg.box.querySelector('[data-x]').onclick=function(){ dlg.tryClose('cancel'); setMsg('Nothing was changed.','info'); };
  dlg.box.querySelector('[data-go]').onclick=function(){ dlg.close(true); onYes(); };
  setTimeout(function(){ var b=dlg.box.querySelector('[data-x]'); if(b) b.focus(); },30);
}
function openChangeTime(d){
  var dv=(d&&d.direct)||{}, cur=String(d.bookedSlot||''), len=Number(dv.durationMin||30);
  var lens=[]; for(var n=15;n<=120;n+=15) lens.push(n);
  var dlg=tdotDialogNew({ cls:'dqt tdlg-narrow', labelledBy:'dqt-title' }), run=dlg.openId;
  dlg.box.innerHTML='<h3 id="dqt-title">Change the consultation time</h3>'+
    '<p>For <b>'+escHtml(d.name||'this client')+'</b>'+(cur?' · now '+escHtml(cur):'')+'. Toronto time. No email goes to the client — if it is booked in Square, change it there too.</p>'+
    '<label class="dqt-l" for="dqt-when">New date and time</label><input id="dqt-when" type="datetime-local" step="300" value="'+escHtml(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}/.test(cur)?cur.slice(0,10)+'T'+cur.slice(11,16):'')+'">'+
    '<label class="dqt-l" for="dqt-len">Length</label><select id="dqt-len">'+lens.map(function(n){ return '<option value="'+n+'"'+(n===len?' selected':'')+'>'+n+' minutes</option>'; }).join('')+'</select>'+
    '<div id="dqt-clash"></div><div class="tdlg-err" role="alert"></div>'+
    '<div class="tdlg-actions"><button type="button" class="tdlg-btn" data-x>Cancel</button><button type="button" class="tdlg-btn primary" data-go>Save time</button></div>';
  var err=dlg.box.querySelector('.tdlg-err'), go=dlg.box.querySelector('[data-go]'), when=dlg.box.querySelector('#dqt-when'), lenEl=dlg.box.querySelector('#dqt-len');
  var clashAck=false;
  function edited(){ clashAck=false; dlg.box.querySelector('#dqt-clash').innerHTML=''; }
  when.addEventListener('input',edited); lenEl.addEventListener('change',edited);
  dlg.box.querySelector('[data-x]').onclick=function(){ dlg.tryClose('cancel'); };
  /* One save at a time (review round 2): a double click on Save time or Save anyway sends once. */
  var saving=false;
  function anyway(on){ var a=dlg.box.querySelector('#dqt-anyway'); if(a) a.disabled=on; }
  function done(){ saving=false; anyway(false); }
  function send(){
    if(saving||dlg.busy) return;
    err.textContent='';
    var v=String(when.value||'');
    if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/.test(v)){ err.textContent='Enter the new date and time.'; when.focus(); return; }
    var key=getKey(); if(!key) return;
    var staffName=(window.tdotRemarksName_rmk ? window.tdotRemarksName_rmk() : '');
    saving=true; anyway(true); go.disabled=true; go.textContent='Saving…'; dlg.setBusy(true);
    fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{ method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'},
      body: JSON.stringify({ action:'changeDirectTime', value: JSON.stringify({ date:v.slice(0,10), time:v.slice(11,16), durationMin:Number(lenEl.value), clashAck:clashAck }), staffName: staffName }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {s:r.status,j:j}; }); })
      .then(function(res){
        var j=res.j||{};
        done();
        if(!dlg.still(run)){ if(res.s===200){ setMsg(j.message||'Time changed.','ok'); load(); } return; }
        dlg.setBusy(false); go.disabled=false; go.textContent='Save time';
        if(res.s===200){ dlg.close(true); setMsg(j.message||'Time changed.','ok'); load(); return; }
        /* The switch is a list of Monday sign-ins and this is the shared key: say so here, keep the typed time. */
        if(res.s===401 && j.loginUrl){ err.innerHTML=escHtml(j.error||'Sign in with Monday first.')+' <a href="'+escHtml(j.loginUrl+'?returnTo='+encodeURIComponent(location.pathname))+'">Sign in with Monday</a>'; return; }
        if(res.s===401||res.s===403){ window.location.href='/admin'; return; }
        if(res.s===409 && j.code==='clash'){
          dlg.box.querySelector('#dqt-clash').innerHTML='<div class="dqt-warn">'+escHtml(j.error||'The consultant already has a consultation at that time.')+'<div style="margin-top:8px"><button type="button" class="tdlg-btn" id="dqt-anyway">Save anyway (different client)</button></div></div>';
          dlg.box.querySelector('#dqt-anyway').onclick=function(){ clashAck=true; send(); };
          return;
        }
        if(res.s===404){ err.textContent='Direct consultation is not available to you (or is switched off) — the time was not changed.'; return; }
        err.textContent=j.error||('Could not change the time (HTTP '+res.s+').');
      })
      .catch(function(e){ done(); if(!dlg.still(run)) return; dlg.setBusy(false); go.disabled=false; go.textContent='Save time'; err.textContent=netErr(e); });
  }
  go.onclick=send;
  setTimeout(function(){ if(dlg.still(run)) when.focus(); },30);
}

/* "Change consultant" on a direct row whose consultant is not an RCIC (review round 1): the RCICs only, through setConsultant. */
function openChangeConsultant(d){
  var dv=(d&&d.direct)||{}, names=dv.rcics||[];
  var dlg=tdotDialogNew({ cls:'dqt tdlg-narrow', labelledBy:'dqc-title' }), run=dlg.openId;
  var cur=String((d.assignedConsultant&&d.assignedConsultant.name)||'');
  dlg.box.innerHTML='<h3 id="dqc-title">Change the consultant</h3>'+
    '<p>'+(cur?escHtml(cur)+' is not an RCIC. ':'')+'Retain needs an RCIC — the agreements name them. No email goes to the client.</p>'+
    '<label class="dqt-l" for="dqc-sel">RCIC</label><select id="dqc-sel"><option value="">Choose…</option>'+names.map(function(n){ return '<option value="'+escHtml(n)+'">'+escHtml(n)+'</option>'; }).join('')+'</select>'+
    '<div class="tdlg-err" role="alert"></div>'+
    '<div class="tdlg-actions"><button type="button" class="tdlg-btn" data-x>Cancel</button><button type="button" class="tdlg-btn primary" data-go>Save consultant</button></div>';
  var err=dlg.box.querySelector('.tdlg-err'), go=dlg.box.querySelector('[data-go]'), sel=dlg.box.querySelector('#dqc-sel');
  dlg.box.querySelector('[data-x]').onclick=function(){ dlg.tryClose('cancel'); };
  go.onclick=function(){
    err.textContent='';
    if(!sel.value){ err.textContent='Choose the RCIC.'; sel.focus(); return; }
    var key=getKey(); if(!key) return;
    var staffName=(window.tdotRemarksName_rmk ? window.tdotRemarksName_rmk() : '');
    go.disabled=true; go.textContent='Saving…'; dlg.setBusy(true);
    fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{ method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'},
      body: JSON.stringify({ action:'setConsultant', value: sel.value, staffName: staffName }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {s:r.status,j:j}; }); })
      .then(function(res){
        var j=res.j||{};
        if(!dlg.still(run)){ if(res.s===200){ setMsg(j.message||'Consultant changed.','ok'); load(); } return; }
        dlg.setBusy(false); go.disabled=false; go.textContent='Save consultant';
        if(res.s===200){ dlg.close(true); setMsg(j.message||'Consultant changed.','ok'); load(); return; }
        if(res.s===401||res.s===403){ window.location.href='/admin'; return; }
        err.textContent=j.error||('Could not change the consultant (HTTP '+res.s+').');
      })
      .catch(function(e){ if(!dlg.still(run)) return; dlg.setBusy(false); go.disabled=false; go.textContent='Save consultant'; err.textContent=netErr(e); });
  };
  setTimeout(function(){ if(dlg.still(run)) sel.focus(); },30);
}

// Lock/unlock the retainer fee + plan once the agreement is sent. A disabled
// <fieldset> also disables dynamically-rebuilt milestone/family rows. "Amend"
// re-enables it for a deliberate, logged change (the server records a note).
function applyRetainerLock(){
  var fs=document.getElementById('rp-lock-fs'), banner=document.getElementById('rp-lock'),
      msg=document.getElementById('rp-lock-msg'), amendBtn=document.getElementById('rp-amend');
  var locked = RP_LOCKED && !RP_AMEND;
  if(fs) fs.disabled = locked;
  // Milestone-editing buttons live OUTSIDE the fieldset, so lock them explicitly.
  ['rp-add-mile','rp-split-mile'].forEach(function(id){ var b=rpEl(id); if(b) b.disabled = locked; });
  // "Mark retainer signed" (manual/email flow) stays clickable after the agreement
  // is SENT (that's when you'd use it) AND for a signed-but-handoff-failed lead (so
  // staff can retry the case creation), but must NOT stay clickable once the deal is
  // done — the case is open / client retained — re-clicking re-fires the whole
  // signed→handoff→payment-link chain on a completed retention.
  var signedBtn=document.getElementById('btn-signed');
  if(signedBtn){ signedBtn.disabled = RP_SIGNED; signedBtn.title = RP_SIGNED ? RP_SIGNED_WHY : ''; }
  // "Sign retainer as consultant": the envelope now goes to the consultant
  // automatically when the client signs, so the button is mostly a way to
  // RE-OPEN that signing page (or to issue it if the auto-send failed). It
  // locks once the countersign completes.
  var rcBtn=document.getElementById('btn-retainer-countersign');
  if(rcBtn){
    rcBtn.disabled = RP_RC_DONE;
    rcBtn.title = RP_RC_DONE ? 'Retainer already countersigned by the consultant'
      : RP_RC_SENT ? 'Already emailed to the consultant — click to open the signing page again'
      : 'Add the consultant (RCIC) signature to the client-signed retainer';
    var rcLbl = rcBtn.querySelector('.btn-label');
    if(rcLbl) rcLbl.textContent = RP_RC_DONE ? 'Countersigned'
      : RP_RC_SENT ? 'Open countersign link' : 'Sign retainer as consultant';
  }

  // Progressive gating — Set fee → Save plan → Retain & send, in order. Each
  // disabled button's tooltip names the step you still owe.
  function gate(id, disabled, hint){ var b=rpEl(id); if(!b) return; b.disabled=!!disabled; b.title=disabled?(hint||''):''; }
  var feeEl=rpEl('fee'), feeChanged = feeEl ? (String(feeEl.value)!==String(PERSISTED_FEE)) : false;
  // Set fee: done (disabled) once a fee is saved and unchanged; re-enables on an edit.
  gate('btn-fee', locked || (RP_FEE_SET && !feeChanged), '');
  // Preview + Save: need the fee first.
  gate('btn-retainer-preview', locked || !RP_FEE_SET, 'Set the retainer fee first');
  gate('btn-retainer-save',    locked || !RP_FEE_SET, 'Set the retainer fee first');
  // Retain & send: need fee AND a saved plan; never re-sendable once the agreement
  // is sent OR the client has already signed / been retained.
  // …and an email to send it to (2026-11-04: the server refuses the same, before changing anything).
  var rpNoEmail = !!(LAST_DETAIL && !String(LAST_DETAIL.email||'').trim());
  gate('btn-retain-send',
       RP_LOCKED || !RP_FEE_SET || !RP_PLAN_SAVED || rpNoEmail,
       RP_RETAINED ? 'Client already retained — no new agreement needed'
         : RP_SENT ? 'Agreement already sent'
         : (!RP_FEE_SET ? 'Set the retainer fee first' : !RP_PLAN_SAVED ? 'Save the retainer plan first'
           : 'Add the client'+String.fromCharCode(8217)+'s email first (on the lead page) — the agreement is sent by email'));

  if(banner){ banner.style.display = RP_LOCKED ? 'flex' : 'none'; banner.className = 'rp-lock' + (RP_AMEND ? ' amending' : ''); }
  if(msg) msg.innerHTML = RP_AMEND
    ? '✎ <b>Amending a sent agreement.</b> Changes are recorded as a note — the client may hold the original terms.'
    : RP_RETAINED
      ? '🔒 <b>This client has already been retained.</b> The fee &amp; milestones are locked — no new agreement will be sent.'
      : '🔒 <b>The retainer agreement has been sent.</b> The fee &amp; milestones are locked.';
  if(amendBtn) amendBtn.style.display = (RP_LOCKED && !RP_AMEND) ? 'inline-flex' : 'none';
  // Void & re-issue: only for a SENT but not-yet-signed agreement (a signed
  // one is a legal document — the server refuses it too). Stays visible while
  // amending: Amend → change fee/details → Save → re-issue is THE renegotiation
  // and wrong-email recovery flow (meeting 2026-08-13).
  var reissueBtn=document.getElementById('rp-reissue');
  if(reissueBtn) reissueBtn.style.display = (RP_SENT && !RP_RETAINED) ? 'inline-flex' : 'none';
  rpUpdateSvQuestion();   // the signed state is known only after hydration — the Super Visa question follows it
}
function startAmend(){
  if(!window.confirm('The retainer agreement has already been emailed to the client. Amending the fee or milestones will NOT re-send it, and the client may hold an agreement stating the original terms — a staff note will record the change. Continue?')) return;
  RP_AMEND=true; applyRetainerLock();
}

// ── Retainer plan panel ──────────────────────────────────────────────────
var RP_TPL_LABELS={ 'pa':'Principal Applicant only', 'pa-inviter':'PA + Inviter / Sponsor / Dependent', 'employer':'Employer / Legal Rep' };
var FAMILY_TYPES=['Spouse','Dependent Child','Parent','Sibling','Sponsor'];
// Curated case-stage triggers + the case's live stage (both hydrated from the
// retainer-plan payload). A milestone shows "DUE" when its trigger == CUR_CASE_STAGE.
var MILE_TRIGGER_STAGES=['Pre-Onboarding','Retainer Confirmed','Document Collection Started','Internal Review','Submission Preparation','Submission Ready','Application Submitted'];
var CUR_CASE_STAGE='';
var RP_CASE_REF='';   // the case reference from the retainer-plan payload — the Mark-paid dialog names it (the lead detail has none)
var RP_BLOCK_FIELDS=['inviterName','inviterAddress','inviterPhone','inviterEmail','empRepName','empCompanyName','empCompanyAddress','empCompanyPhone','empRepPhone','empRepEmail'];
function rpEl(id){ return document.getElementById(id); }
function escA(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function rpMsg(t,k){ var el=rpEl('rp-msg'); el.className='act-msg '+k; el.textContent=t; }

function loadRetainerPlan(){
  var key=getKey(); if(!key) return;
  fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/retainer-plan',{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
   .then(function(d){ hydrateRetainer(d); RP_HYDRATED=true; })
   .catch(function(e){ if(e.message==='x')return; rpEl('rp-suggestion').innerHTML='<div class="rp-sugg">Could not load retainer plan: '+escHtml(e.message)+'</div>'; });
}

function hydrateRetainer(d){
  var plan=d.plan||{}, annex=plan.annex||{};
  // Gating state from the persisted plan: fee set? plan saved?
  RP_FEE_SET=!!d.feeSet; RP_PLAN_SAVED=!!d.saved; PERSISTED_FEE=String(d.retainerFee||'');
  var tsel=rpEl('rp-template');
  tsel.innerHTML=(d.templateOptions||['pa','pa-inviter','employer']).map(function(t){ return '<option value="'+escA(t)+'">'+escHtml(RP_TPL_LABELS[t]||t)+'</option>'; }).join('');
  tsel.value=plan.template||'pa';
  var groups={};
  (d.annexOptions||[]).forEach(function(a){ if(!groups[a.group])groups[a.group]=[]; groups[a.group].push(a); });
  var html='<option value="">— select scope annex —</option>';
  [['permanent','Permanent'],['temporary','Temporary']].forEach(function(g){ var list=groups[g[0]]; if(list&&list.length){ html+='<optgroup label="'+g[1]+'">'+list.map(function(a){ return '<option value="'+escA(a.code)+'">['+escHtml(a.code)+'] '+escHtml(a.label)+'</option>'; }).join('')+'</optgroup>'; } });
  var asel=rpEl('rp-annex'); asel.innerHTML=html; asel.value=annex.code||'';
  // Case type + sub-type: canonical dropdowns (same options endpoint as the
  // direct-client form) so the vocabulary matches Client Master + the checklist/
  // questionnaire seeders end to end. Until the options arrive the stored values
  // show as inert placeholders (value="" — never submitted), so a slow/failed
  // fetch still displays what is on file without risking a destructive save.
  RP_PLAN_CT=plan.caseType||''; RP_PLAN_ST=plan.subType||'';
  if(RP_CT_OPTS){ rpPopulateCaseTypes(); }
  else {
    var ctI=rpEl('rp-casetype'); if(ctI) ctI.innerHTML='<option value="">'+(RP_PLAN_CT?escHtml(RP_PLAN_CT)+' (loading list…)':'Loading case types…')+'</option>';
    var stI=rpEl('rp-subtype'); if(stI) stI.innerHTML='<option value="">'+(RP_PLAN_ST?escHtml(RP_PLAN_ST)+' (loading list…)':'')+'</option>';
    rpFetchCaseTypeOpts();
  }
  var gov=plan.govFee||{}; rpEl('rp-govfee').value=(gov.dollars!=null)?gov.dollars:'';
  var adf=plan.adFee||{}; rpEl('rp-adfee').value=(adf.dollars!=null)?adf.dollars:'';
  rpUpdateAdFeeVisibility();
  rpEl('rp-rprf').checked=(gov.withRprf!==false);
  if(rpEl('rp-hst')) rpEl('rp-hst').value=(plan.hstRate!=null)?(Math.round(plan.hstRate*1000)/10):13;
  var m=plan.mergeData||{};
  RP_BLOCK_FIELDS.forEach(function(k){ var el=rpEl('rp-'+k); if(el) el.value=m[k]||''; });
  if(d.milestoneTriggerStages&&d.milestoneTriggerStages.length) MILE_TRIGGER_STAGES=d.milestoneTriggerStages;
  CUR_CASE_STAGE=d.currentCaseStage||'';
  RP_CASE_REF=d.caseRef||'';
  var cs=rpEl('rp-case-stage'); if(cs) cs.innerHTML=CUR_CASE_STAGE?('· case is at <span class="rp-stage">'+escHtml(CUR_CASE_STAGE)+'</span>'):'';
  rebuildMilestones(plan.milestones||[]);
  if(d.familyMemberTypes&&d.familyMemberTypes.length) FAMILY_TYPES=d.familyMemberTypes;
  rebuildFamily(d.familyMembers||[]);
  rpUpdateSvQuestion();
  renderMilestonePayments(d.milestonePayments||[]);
  var flag=annex.code?(annex.needsVerify?'<span class="rp-flag verify">verify</span>':'<span class="rp-flag high">high</span>'):'';
  rpEl('rp-suggestion').innerHTML='<div class="rp-sugg"><b>Suggested:</b> '+escHtml(RP_TPL_LABELS[plan.template]||plan.template||'—')+' · '+(annex.code?('['+escHtml(annex.code)+'] '+escHtml(annex.label||'')):'no annex auto-selected')+flag+(annex.basis?('<br><span class="muted">'+escHtml(annex.basis)+'</span>'):'')+(d.saved?' <span class="muted">· saved plan loaded</span>':'')+'</div>';
  renderRpWarnings(plan.warnings||[]);
  toggleTemplateBlocks();
  updateMileSum();
}

function renderRpWarnings(ws){
  var el=rpEl('rp-warnings');
  if(!ws||!ws.length){ el.innerHTML=''; return; }
  el.innerHTML='<div class="rp-warn"><b>Before sending, please check:</b><ul>'+ws.map(function(w){ return '<li>'+escHtml(w)+'</li>'; }).join('')+'</ul></div>';
}
function toggleTemplateBlocks(){
  var t=rpEl('rp-template').value;
  rpEl('rp-inviter').style.display=(t==='pa-inviter')?'block':'none';
  rpEl('rp-employer').style.display=(t==='employer')?'block':'none';
  var err=rpEl('rp-inviter-err'); if(err && t!=='pa-inviter') err.style.display='none';
}
// Which co-signer details are still missing for a pa-inviter agreement.
// Returns [] when complete or when the template has no co-signer.
function inviterGaps(){
  if(rpEl('rp-template').value!=='pa-inviter') return [];
  var gaps=[];
  var name=(rpEl('rp-inviterName').value||'').trim();
  var email=(rpEl('rp-inviterEmail').value||'').trim();
  if(!name) gaps.push('name');
  if(!email) gaps.push('email');
  else if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) gaps.push('valid email');
  if(!(rpEl('rp-inviterPhone').value||'').trim()) gaps.push('phone');
  if(!(rpEl('rp-inviterAddress').value||'').trim()) gaps.push('address');
  return gaps;
}
function mileTriggerCell(m){
  var trig=m.trigger||'';
  // Curated case-stage dropdown. Keep any legacy / off-list value as a selectable
  // option so an older free-text trigger is never silently dropped.
  var stages=MILE_TRIGGER_STAGES.slice();
  if(trig&&stages.indexOf(trig)<0) stages.unshift(trig);
  var opts='<option value="">— when due —</option>'+stages.map(function(s){ return '<option value="'+escA(s)+'"'+(s===trig?' selected':'')+'>'+escHtml(s)+'</option>'; }).join('');
  return '<td><select class="m-trigger">'+opts+'</select><span class="m-due" style="display:none">Due</span></td>';
}
function mileRowHtml(m,locked){
  return '<td><input class="m-label" type="text" value="'+escA(m.label||'')+'"'+(locked?' disabled':'')+'></td>'+
    '<td><input class="m-amount" type="number" min="0" step="0.01" value="'+(m.amountCents!=null?(m.amountCents/100):'')+'"></td>'+
    '<td class="m-hst muted" style="text-align:right;white-space:nowrap"></td>'+
    '<td class="m-total" style="text-align:right;white-space:nowrap;font-weight:600;color:var(--navy)"></td>'+
    mileTriggerCell(m)+
    '<td>'+(locked?'<span class="muted">locked</span>':'<button type="button" class="rm-btn" data-rm="1">✕</button>')+'</td>';
}
// Show "Due" on the milestone whose trigger stage the case has currently reached.
function updateDue(tr){
  var sel=tr.querySelector('.m-trigger'), badge=tr.querySelector('.m-due');
  if(!sel||!badge) return;
  badge.style.display=(CUR_CASE_STAGE&&sel.value&&sel.value===CUR_CASE_STAGE)?'inline-block':'none';
}
// Milestone payments panel (outside the locked plan editor — collecting a payment
// isn't editing the contract). A "Generate payment link" button shows on a
// pending milestone once it's due; status shows Paid / Link sent otherwise.
function renderMilestonePayments(list){
  var el=rpEl('rp-milestone-pay'); if(!el) return;
  if(!list||!list.length){ el.innerHTML='<span class="muted">No milestones set yet.</span>'; return; }
  // Undo… / Flag as wrong depend on who is looking — load that once, then render.
  if(!TDOT_PAY.viewer){ tdotPayViewer(function(){ renderMilestonePayments(list); }); }
  var D=LAST_DETAIL||{};
  var signed=!!(D.retainerSigned&&String(D.retainerSigned).trim());
  el.innerHTML=list.map(function(m){
    var badge = m.status==='paid' ? '<span class="ms-badge paid">Paid</span>'
              : m.status==='partial' ? '<span class="ms-badge partial">Part-paid</span>'
              : m.status==='requested' ? '<span class="ms-badge sent">Requested</span>'
              : (m.due ? '<span class="ms-badge due">Due</span>' : '<span class="ms-badge pending">Pending</span>');
    var amt='$'+(Number(m.totalCents||0)/100).toFixed(2);
    var lastPart=(m.payments||[]).slice(-1)[0]||null;
    var meta = (m.status==='paid'
        ? '<span class="ms-meta">paid '+escHtml(m.paidAt||'')+(m.reference?(' · ref '+escHtml(m.reference)):'')+'</span>'
        : m.status==='partial'
        ? '<span class="ms-meta">paid '+payDollars(m.paidCents)+' of '+amt+' · <b>balance '+payDollars(m.balanceCents)+'</b>'+(lastPart?(' · last '+escHtml(lastPart.paidAt||'')+(lastPart.reference?(' ref '+escHtml(lastPart.reference)):'')):'')+(m.reference?(' · ref '+escHtml(m.reference)):'')+'</span>'
        : (m.status==='requested'&&m.reference ? '<span class="ms-meta">ref '+escHtml(m.reference)+'</span>' : '')) + tdotPayAuditHtml(m);
    // Milestone 1 is due at signing even while the case is still Pre-Onboarding.
    var reqBtn=(((m.status==='pending'&&(m.due||(m.index===0&&signed)))||m.legacySent)&&!(m.index===0&&D.retainerPaid))?'<button class="btn" type="button" data-msp-req="'+m.index+'">'+ICONS.mail+' '+(m.legacySent?'Send e-transfer details':'Send e-transfer request')+'</button>':'';
    var paidBtn=(m.status!=='paid')?'<button class="btn primary" type="button" data-msp-paid="'+m.index+'">'+ICONS.check+' '+(m.status==='partial'?'Record balance / part-payment':'Record payment')+'</button>':'';
    var fixBtn=TDOT_PAY.viewer?tdotPayRowActions(m,{ retainerPaid: D.retainerPaid },'btn'):'';
    return '<div class="ms-row"><span class="ms-label">'+escHtml(m.label||('Milestone '+(m.index+1)))+'</span><span class="ms-amt">'+amt+'</span>'+badge+meta+reqBtn+paidBtn+fixBtn+'</div>';
  }).join('');
  tdotPayBind(el,{ leadId: LEAD_ID, clientName: D.name||'', rows: list, reload: function(){ RP_HYDRATED=false; load(); } });
  Array.prototype.forEach.call(el.querySelectorAll('[data-msp-req]'),function(b){
    b.onclick=function(){ doAction('sendMilestoneEtransferRequest', b.getAttribute('data-msp-req'), 'Email the e-transfer payment request for this milestone to the client now?'); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-msp-paid]'),function(b){
    b.onclick=function(){
      // A dialog showing WHICH client, the amount, the reference they were asked
      // to use, and a warning when no request was ever sent (2026-09-22).
      var i=Number(b.getAttribute('data-msp-paid'));
      var row=list.filter(function(r){ return r.index===i; })[0]||{index:i};
      tdotOpenMarkPaidModal({ clientName: D.name||'', caseRef: RP_CASE_REF, m: row, started: !!(D.retainerPaid&&String(D.retainerPaid).trim()), onConfirm: function(ref,by,amountCents,settle){
        doAction('markMilestonePaid', JSON.stringify({index:i, reference:ref, amountCents:amountCents, settle:settle===true}), null, by);
      } });
    };
  });
}
function rebuildMilestones(rows){
  var tb=rpEl('milestone-body'); tb.innerHTML='';
  if(!rows||!rows.length) rows=[{label:'Milestone 1 – Admin Fee (Non-Refundable)',amountCents:0,locked:true}];
  rows.forEach(function(m,i){ var tr=document.createElement('tr'); tr.innerHTML=mileRowHtml(m,i===0); tb.appendChild(tr); });
  bindMile();
}
function addMile(){ var tr=document.createElement('tr'); tr.innerHTML=mileRowHtml({label:'',amountCents:null,trigger:''},false); rpEl('milestone-body').appendChild(tr); bindMile(); }
function bindMile(){
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body .m-amount'),function(i){ i.oninput=updateMileSum; });
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body [data-rm]'),function(b){ b.onclick=function(){ var tb=rpEl('milestone-body'); if(tb.rows.length>1){ b.closest('tr').remove(); updateMileSum(); } }; });
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body tr'),function(tr){ var s=tr.querySelector('.m-trigger'); if(s) s.onchange=function(){ updateDue(tr); }; updateDue(tr); });
}
// ── Family members (consultant-set; materialised to the board at handoff) ──
/* On a Super Visa the "Spouse" row IS the second parent (the principal applicant's spouse) — the list says so. */
function svWho(){ var st=(rpEl('rp-subtype')&&rpEl('rp-subtype').value)||RP_PLAN_ST||''; return /grandparent/i.test(st)?'grandparent':'parent'; }
function famTypeLabel(t){ return (t==='Spouse'&&rpIsSuperVisa())?('Second '+svWho()+' (spouse of the applicant)'):t; }
function famRowHtml(m){
  var opts=FAMILY_TYPES.map(function(t){ return '<option value="'+escA(t)+'"'+(m.type===t?' selected':'')+'>'+escHtml(famTypeLabel(t))+'</option>'; }).join('');
  return '<td><select class="f-type">'+opts+'</select></td>'+
    '<td><input class="f-name" type="text" value="'+escA(m.name||'')+'" placeholder="Full name (optional)"></td>'+
    '<td><input class="f-dob" type="date" value="'+escA(m.dateOfBirth||'')+'"></td>'+
    '<td><input class="f-status" type="text" value="'+escA(m.currentStatus||'')+'" placeholder="e.g. Visitor"></td>'+
    '<td><input class="f-residence" type="text" value="'+escA(m.countryOfResidence||'')+'" placeholder="e.g. Canada"></td>'+
    '<td style="text-align:center"><input class="f-acc" type="checkbox"'+(m.accompanying?' checked':'')+'></td>'+
    '<td><button type="button" class="rm-btn" data-rmf="1">✕</button></td>';
}
function rebuildFamily(rows){ var tb=rpEl('family-body'); if(!tb) return; tb.innerHTML=''; (rows||[]).forEach(function(m){ var tr=document.createElement('tr'); tr.innerHTML=famRowHtml(m); tb.appendChild(tr); }); bindFamily(); }
function addFamily(){ var tr=document.createElement('tr'); tr.innerHTML=famRowHtml({type:'Spouse',name:'',accompanying:true}); rpEl('family-body').appendChild(tr); bindFamily(); }
function bindFamily(){ Array.prototype.forEach.call(document.querySelectorAll('#family-body [data-rmf]'),function(b){ b.onclick=function(){ b.closest('tr').remove(); }; }); }
function collectFamily(){
  return Array.prototype.map.call(document.querySelectorAll('#family-body tr'),function(tr){
    return { type:((tr.querySelector('.f-type')||{}).value||'').trim(), name:((tr.querySelector('.f-name')||{}).value||'').trim(),
      dateOfBirth:((tr.querySelector('.f-dob')||{}).value||'').trim(), currentStatus:((tr.querySelector('.f-status')||{}).value||'').trim(),
      countryOfResidence:((tr.querySelector('.f-residence')||{}).value||'').trim(), accompanying:!!((tr.querySelector('.f-acc')||{}).checked) };
  }).filter(function(m){ return m.type; });
}
// ── Super Visa: both parents? (2026-10-24 — on 2026-10-23 none of the 21 Super
// Visa cases had the second parent, so one parent got no questionnaire and no
// documents). The second parent is ONE accompanying Spouse row; "Parent" has no
// Super Visa documents. The box above the list says what the list holds; the
// question itself is asked at Retain & send. Nothing is stored or remembered:
// the list is the only truth.
function rpIsSuperVisa(){ var ct=(rpEl('rp-casetype')&&rpEl('rp-casetype').value)||RP_PLAN_CT||''; return /^super\\s*visa$/i.test(String(ct).trim()); }
function svCounts(fam){
  var c={ spouse:0, parent:0, name:'' };
  (fam||[]).forEach(function(m){ if(!m.accompanying) return; if(m.type==='Spouse'){ c.spouse++; if(!c.name) c.name=m.name||''; } if(m.type==='Parent') c.parent++; });
  return c;
}
/* Something wrong in the list ('' when not). Shared by the box and the send check. */
function svProblem(c){
  var W=svWho();
  if(c.spouse>1) return 'Two rows are marked “Second '+W+'” and ticked “Accomp.” — a Super Visa has one second '+W+'. Remove one.';
  if(c.parent&&c.spouse) return 'Both a “Second '+W+'” and a “Parent” row are ticked “Accomp.” — if they are the same person, remove the “Parent” row (a Super Visa has no documents for that type).';
  if(c.parent) return 'A family member is listed as “Parent” — a Super Visa has no documents for that type. Change that row’s Type to “Second '+W+'”.';
  return '';
}
function rpUpdateSvQuestion(){
  var box=rpEl('rp-sv'); if(!box) return;
  var sv=rpIsSuperVisa();
  box.style.display=sv?'':'none';
  // the Type options follow the case type ("Spouse" reads "Second parent" on a Super Visa)
  Array.prototype.forEach.call(document.querySelectorAll('#family-body .f-type option'),function(o){ o.textContent=famTypeLabel(o.value); });
  if(!sv) return;
  var W=svWho();
  var title=rpEl('rp-sv-title'); if(title) title.textContent='Super Visa — both '+W+'s applying?';
  var c=svCounts(collectFamily()), problem=svProblem(c), one=(c.spouse===1&&!problem);
  var status=problem||(one?('Second '+W+' listed: '+(c.name||'no name yet')+'.'):'Only one '+W+' is listed. If both '+W+'s are applying, add the second '+W+' (Type “Second '+W+'”, ticked “Accomp.”).');
  var editable=!(RP_LOCKED&&!RP_AMEND), text;
  if(RP_LIST_USED){
    // signed and the case is open: the list was read when the case was set up
    text='The client has signed — this list was read when the case was set up, and changes here no longer reach the case. '+(
      one ? 'Check that the case page’s Family card shows the second '+W+' as “Second '+W+'” (not “Parent”) — if they show as Parent, ask an admin to change them; do not add them again.'
      : (c.parent&&!c.spouse) ? 'If the second '+W+' is on the case as “Parent”, ask an admin to change them to “Second '+W+'” — do not add them again.'
      : problem ? 'Check the case page’s Family card and ask an admin to fix it.'
      : 'If both '+W+'s are applying, add the second '+W+' on the case page: Family card → ➕ Add family member → “Second '+W+'”.');
  } else if(RP_RETAINED){
    // signed, but no case yet: this list is what the case gets when it opens
    text='The client has signed but the case is not open yet — '+(one ? 'this list reaches the case when it opens. ' : editable ? '' : 'press ✎ Amend, fix the list and Save so the case gets it. ')+status;
  } else if(RP_SENT&&!editable){
    text='The agreement is sent — press ✎ Amend to change this list (it reaches the case when the client signs). '+status;
  } else {
    text=status;
  }
  var hint=rpEl('rp-sv-hint');
  hint.className='rp-sv-hint'+(one?'':' need');
  hint.textContent=text;
  var add=rpEl('rp-sv-add');
  if(add) add.style.display=(!RP_LIST_USED&&editable&&!c.spouse&&!c.parent)?'':'none';
  var addTxt=rpEl('rp-sv-add-txt'); if(addTxt) addTxt.textContent='Add the second '+W;
}
function svAddSecondParent(){
  addFamily();
  var rows=document.querySelectorAll('#family-body tr'), tr=rows[rows.length-1];
  var nm=tr&&tr.querySelector('.f-name');
  if(nm){ nm.placeholder='Second '+svWho()+'’s full name'; nm.focus(); }
  RP_PLAN_SAVED=false; applyRetainerLock();
}
/** Before Retain & send: '' when fine, else the question to confirm (Super Visa only). */
function svSendCheck(){
  if(!rpIsSuperVisa()) return '';
  var c=svCounts(collectFamily()), problem=svProblem(c);
  if(problem) return problem;
  var W2=svWho();
  if(!c.spouse) return 'This Super Visa lists ONE '+W2+'. Are both '+W2+'s applying? If so, Cancel and add the second '+W2+' (Type “Second '+W2+'”, ticked “Accomp.”) — otherwise they get no questionnaire and no documents.';
  return '';
}
function feeCentsNow(){ var fe=rpEl('fee'); var f=Number(String((fe&&fe.value)||'').replace(/[^0-9.]/g,'')); return f>0?Math.round(f*100):0; }
function collectMilestones(){
  return Array.prototype.map.call(document.querySelectorAll('#milestone-body tr'),function(tr,i){
    return { label:(tr.querySelector('.m-label').value||'').trim(), amountCents:Math.round((Number(tr.querySelector('.m-amount').value)||0)*100), trigger:(tr.querySelector('.m-trigger').value||'').trim(), locked:i===0 };
  });
}
function fmtC(c){ return '$'+(c/100).toFixed(2); }
function hstRateNow(){ var el=rpEl('rp-hst'); var v=Number((el&&el.value)||'13'); return (Number.isFinite(v)&&v>=0)?v/100:0.13; }
function updateMileSum(){
  var fee=feeCentsNow(), rate=hstRateNow(), rpct=Math.round(rate*1000)/10;
  // Per-milestone HST + total (auto), and running sums.
  var sum=0, hstSum=0;
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body tr'),function(tr){
    var amt=Math.round((Number(tr.querySelector('.m-amount').value)||0)*100);
    var h=Math.round(amt*rate); sum+=amt; hstSum+=h;
    var hc=tr.querySelector('.m-hst'), tc=tr.querySelector('.m-total');
    if(hc) hc.textContent=fmtC(h); if(tc) tc.textContent=fmtC(amt+h);
  });
  var fb=rpEl('rp-fee-breakdown');
  if(fb){
    fb.innerHTML = fee>0
      ? ('Professional fee <b>'+fmtC(sum)+'</b> &nbsp;·&nbsp; HST ('+rpct+'%) <b>'+fmtC(hstSum)+'</b> &nbsp;·&nbsp; <b>Total (incl. HST) '+fmtC(sum+hstSum)+'</b>'
         + (rate===0?' &nbsp;<span class="muted">(HST-exempt)</span>':''))
      : '<span class="muted">Set the retainer fee (above) — HST &amp; totals calculate automatically per milestone.</span>';
  }
  var el=rpEl('rp-mile-sum'); if(!el) return;
  var ok=(fee>0 && sum===fee); el.className='rp-sum '+(ok?'ok':'bad');
  el.textContent='— milestones total '+fmtC(sum)+(fee>0?(' / fee '+fmtC(fee)+(ok?' ✓':(' (off by '+fmtC(Math.abs(sum-fee))+')'))):' (set the fee first)');
}
// Distribute the professional fee evenly across the current milestone rows
// (remainder on the last) so the schedule auto-sums to the fee.
function splitMilestones(){
  var rows=document.querySelectorAll('#milestone-body .m-amount');
  var n=rows.length, fee=feeCentsNow();
  if(n && fee>0){ var base=Math.floor(fee/n);
    Array.prototype.forEach.call(rows,function(inp,i){ var cents=base+(i===n-1?(fee-base*n):0); inp.value=(cents/100).toFixed(2); });
  }
  updateMileSum();
}
// Canonical case-type / sub-type pickers. RP_PLAN_CT/ST carry the values to
// select (from the saved plan or the staff's in-progress choice) so the async
// options fetch can populate late without losing them.
var RP_CT_OPTS=null, RP_CT_FETCHING=false, RP_PLAN_CT='', RP_PLAN_ST='';
function rpFetchCaseTypeOpts(){
  if(RP_CT_OPTS||RP_CT_FETCHING) return;
  var key=getKey(); if(!key) return;
  RP_CT_FETCHING=true;
  fetchT('/api/consultation/direct-client/options',{headers:{'X-Api-Key':key}})
   .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
   .then(function(o){ RP_CT_OPTS=o; RP_CT_FETCHING=false; rpPopulateCaseTypes(); })
   .catch(function(){ RP_CT_FETCHING=false; var s=rpEl('rp-casetype'); if(s) s.innerHTML='<option value="">'+(RP_PLAN_CT?escHtml(RP_PLAN_CT)+' (list unavailable — reload to edit)':'— could not load case types (reload to retry) —')+'</option>'; });
}
function rpPopulateCaseTypes(){
  var sel=rpEl('rp-casetype'); if(!sel||!RP_CT_OPTS) return;
  var list=RP_CT_OPTS.caseTypes||[], cur=RP_PLAN_CT||'';
  var html='<option value="">— select case type —</option>';
  // A legacy value outside the canon stays VISIBLE (staff see what is on file)
  // but is flagged so collectSelections never sends it — the server would
  // reject it, which must not block unrelated plan edits (e.g. an amend).
  if(cur&&list.indexOf(cur)<0) html+='<option data-noncanon="1" value="'+escA(cur)+'">'+escHtml(cur)+' (legacy — pick a canonical type to confirm)</option>';
  html+=list.map(function(c){ return '<option value="'+escA(c)+'">'+escHtml(c)+'</option>'; }).join('');
  sel.innerHTML=html; sel.value=cur;
  rpPopulateSubtypes();
}
function rpUpdateAdFeeVisibility(){
  // LMIA-family case types get the advertisement-fee input (feedback
  // 2026-08-13). A stored amount stays VISIBLE regardless of case type — the
  // value always rides along on save, so it must never be hidden while set.
  var f=rpEl('rp-adfee-field'); if(!f) return;
  var ct=(rpEl('rp-casetype')&&rpEl('rp-casetype').value)||RP_PLAN_CT||'';
  var hasValue=rpEl('rp-adfee')&&rpEl('rp-adfee').value!=='';
  f.style.display=(/lmia/i.test(ct)||hasValue)?'':'none';
}
function rpPopulateSubtypes(){
  rpUpdateAdFeeVisibility();
  rpUpdateSvQuestion();
  var sel=rpEl('rp-subtype'); if(!sel) return;
  var ct=rpEl('rp-casetype')?rpEl('rp-casetype').value:'';
  var subs=(RP_CT_OPTS&&RP_CT_OPTS.subTypesByCase&&RP_CT_OPTS.subTypesByCase[ct])||[];
  var cur=RP_PLAN_ST||'';
  var html;
  if(!subs.length){
    html='<option value="">— (none for this case type) —</option>';
    if(cur) html+='<option data-noncanon="1" value="'+escA(cur)+'">'+escHtml(cur)+' (legacy)</option>';
  } else {
    html='<option value="">Choose… (required for the checklist)</option>';
    if(cur&&subs.indexOf(cur)<0) html+='<option data-noncanon="1" value="'+escA(cur)+'">'+escHtml(cur)+' (legacy — pick from the list)</option>';
    html+=subs.map(function(s){ return '<option value="'+escA(s)+'">'+escHtml(s)+'</option>'; }).join('');
  }
  sel.innerHTML=html; sel.value=cur;
}
function rpSelectedNonCanon(el){
  var o=el&&el.selectedOptions&&el.selectedOptions[0];
  return !!(o&&o.getAttribute('data-noncanon'));
}
function collectSelections(){
  var sel={ template:rpEl('rp-template').value, annexCode:rpEl('rp-annex').value,
    feeCents:feeCentsNow(), govFeeDollars: rpEl('rp-govfee').value!==''?Number(rpEl('rp-govfee').value):undefined,
    adFeeDollars: rpEl('rp-adfee').value!==''?Number(rpEl('rp-adfee').value):undefined,
    hstRate: Math.round(hstRateNow()*1000)/10, withRprf: rpEl('rp-rprf').checked, milestones:collectMilestones(), familyMembers:collectFamily() };
  // Case type / sub-type ride along ONLY when the canon options actually loaded —
  // an omitted field leaves the stored value untouched server-side, so a slow or
  // failed options fetch can never wipe what is on file. A displayed legacy
  // (non-canonical) selection is likewise not sent: case type falls back to
  // "no change" and the sub-type is omitted, so unrelated edits still save.
  if(RP_CT_OPTS){
    var ctEl=rpEl('rp-casetype'), stEl=rpEl('rp-subtype');
    sel.caseType=rpSelectedNonCanon(ctEl)?'':((ctEl&&ctEl.value)||'');
    if(!rpSelectedNonCanon(stEl)) sel.subType=((stEl&&stEl.value)||'').trim();
  }
  RP_BLOCK_FIELDS.forEach(function(k){ var el=rpEl('rp-'+k); if(el) sel[k]=(el.value||'').trim(); });
  return sel;
}
function previewRetainer(){
  var key=getKey(); if(!key) return;
  rpMsg('Rendering preview… (a few seconds)','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/retainer-preview',{ method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'}, body:JSON.stringify({value:collectSelections()}) })
   .then(function(r){ disableActions(false); if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().then(function(j){ throw new Error((j&&j.error)||('HTTP '+r.status)); }); } return r.blob(); })
   .then(function(blob){ window.open(URL.createObjectURL(blob),'_blank'); rpMsg('Preview opened in a new tab.','ok'); })
   .catch(function(e){ disableActions(false); if(e.message==='x')return; rpMsg(netErr(e),'err'); });
}
function saveRetainer(){ doAction('saveRetainerSelections', JSON.stringify(collectSelections()), 'Save this retainer plan (template, scope annex, fees, milestones)? This does not send anything to the client.'); }

// Shared by the consultation + retainer agreements — identical flows, different endpoints.
function viewSignedAgreement(endpoint){
  var key=getKey(); if(!key) return;
  // Pre-open the tab synchronously (inside the click) so popup blockers allow it.
  var w=window.open('','_blank');
  setMsg('Fetching the signed agreement…','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/'+endpoint,{ method:'POST', headers:{'X-Api-Key':key} })
   .then(function(r){ disableActions(false); if(r.status===401||r.status===403){ if(w)w.close(); window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().then(function(j){ throw new Error((j&&j.error)||('HTTP '+r.status)); }); } return r.blob(); })
   .then(function(blob){ var u=URL.createObjectURL(blob); if(w){ w.location=u; } else { window.open(u,'_blank'); } setMsg('Signed agreement opened in a new tab.','ok'); })
   .catch(function(e){ disableActions(false); if(w)try{w.close();}catch(_){} if(e.message==='x')return; setMsg(netErr(e),'err'); });
}
function countersignAgreement(action,confirmTxt){
  if(!window.confirm(confirmTxt)) return;
  var key=getKey(); if(!key) return;
  // Open the tab synchronously (inside the click) so popup blockers allow it,
  // then point it at the Documenso signing page once the envelope is issued.
  var w=window.open('','_blank');
  setMsg('Issuing the countersign envelope…','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{
    method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'},
    body: JSON.stringify({ action:action, value:null })
  }).then(function(r){ return r.json().then(function(j){ return {status:r.status,j:j}; }); })
   .then(function(res){
     disableActions(false);
     if(res.status===401||res.status===403){ if(w)w.close(); window.location.href='/admin'; return; }
     if(res.status!==200){ if(w)w.close(); throw new Error((res.j&&res.j.error)||('HTTP '+res.status)); }
     if(res.j.signUrl){ if(w){ w.location=res.j.signUrl; } else { window.open(res.j.signUrl,'_blank'); } }
     // No direct signing link available — land the tab on the Documenso
     // dashboard (where the pending request lives) instead of silently
     // closing it, which read as "the button did nothing".
     else if(w){ w.location='https://app.documenso.com/documents'; }
     setMsg(res.j.message||'Done.','ok');
     load();
   }).catch(function(e){ disableActions(false); if(w)try{w.close();}catch(_){} setMsg(netErr(e),'err'); });
}
function viewSignedConsult(){ viewSignedAgreement('consult-agreement-signed'); }
function countersignConsult(){
  // Normally already issued automatically at client signature — this click
  // just RE-OPENS that signing page; say which it is.
  countersignAgreement('consultantSignAgreement', CS_RC_SENT
    ? 'Open the countersign signing page again? This agreement was already emailed to the consultant — no new request is sent.'
    : 'Add the consultant (RCIC) signature to this agreement now? The client has already signed. Your signature completes the agreement, and the fully signed copy is emailed to the client automatically.');
}
function viewSignedRetainer(){ viewSignedAgreement('retainer-agreement-signed'); }
function countersignRetainer(){
  // The envelope is normally issued automatically when the client signs, so
  // this click usually just RE-OPENS that signing page — say which it is.
  countersignAgreement('consultantSignRetainer', RP_RC_SENT
    ? 'Open the countersign signing page again? This retainer was already emailed to the consultant — no new request is sent.'
    : 'Add the consultant (RCIC) signature to the retainer now? The client has already signed. Your signature completes the agreement, and the fully signed copy is emailed to the client automatically.');
}

function previewConsult(){
  var key=getKey(); if(!key) return;
  setMsg('Rendering consultation agreement…','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/consult-agreement-preview',{ method:'POST', headers:{'X-Api-Key':key} })
   .then(function(r){ disableActions(false); if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().then(function(j){ throw new Error((j&&j.error)||('HTTP '+r.status)); }); } return r.blob(); })
   .then(function(blob){ window.open(URL.createObjectURL(blob),'_blank'); setMsg('Consultation agreement preview opened in a new tab.','ok'); })
   .catch(function(e){ disableActions(false); if(e.message==='x')return; setMsg(netErr(e),'err'); });
}

function initActions(){
  tdotRemarksMount({ prefix:'rmk', leadId: LEAD_ID, presets: REMARKS, updatesPrefix:'updw' });
  var obtns=document.getElementById('obtns');
  OUTCOMES.forEach(function(label){
    // "Retain" is handled by the guided "Retain & send agreement" button in the
    // retainer panel (set fee → save plan → send), so it's not a quick-outcome here.
    if(label==='Retain') return;
    var b=document.createElement('button'); b.type='button'; b.className='obtn'; b.textContent=label; b.setAttribute('data-outcome',label);
    // "Not Wanted" asks for the reason first — it goes on the lead and on the Not Wanted list.
    b.onclick=function(){
      if(label===OUTCOME_NOT_WANTED){ tdotOpenNotWantedModal({ name:(LAST_DETAIL&&LAST_DETAIL.name)||'', onConfirm:function(reason){ doAction('outcome', JSON.stringify({label:label, reason:reason})); } }); return; }
      doAction('outcome',label);
    };
    obtns.appendChild(b);
  });
  document.getElementById('btn-fee').onclick=function(){
    var fee=document.getElementById('fee').value;
    if(!fee||Number(fee)<=0){ setMsg('Enter a fee amount in CAD dollars first.','err'); return; }
    doAction('retainerFee', fee, 'Set the retainer fee to $'+fee+'? If the retainer is already signed, this emails the payment link to the client.');
  };
  document.getElementById('btn-signed').onclick=function(){
    doAction('retainerSigned','', 'Mark the retainer SIGNED? This creates the client case and emails the payment link to the client.');
  };
  document.getElementById('btn-invite').onclick=function(){
    doAction('bookingInvite',null,'Email the client their booking invite now?');
  };
  document.getElementById('btn-resend').onclick=function(){
    doAction('resendLinks',null,'Re-send the meeting and pre-consultation links to the client now?');
  };
  // Retainer panel
  var amendBtn=document.getElementById('rp-amend'); if(amendBtn) amendBtn.onclick=startAmend;
  var reissueBtn=document.getElementById('rp-reissue'); if(reissueBtn) reissueBtn.onclick=function(){
    doAction('reissueRetainer', null,
      'Void the un-signed agreement and send a FRESH one now?\\n\\n'
      +'• The old signing links stop working for every signer.\\n'
      +'• The new agreement uses the CURRENT fee, milestones and signer emails — save any changes first.\\n'
      +'• The client (and co-signer, if any) receive a new signing email immediately.');
  };
  rpEl('rp-template').onchange=toggleTemplateBlocks;
  var ctSel=rpEl('rp-casetype'); if(ctSel) ctSel.onchange=function(){ RP_PLAN_CT=this.value; RP_PLAN_ST=''; rpPopulateSubtypes(); };
  var stSel=rpEl('rp-subtype'); if(stSel) stSel.onchange=function(){ RP_PLAN_ST=this.value; rpUpdateSvQuestion(); };
  rpEl('rp-add-mile').onclick=addMile;
  rpEl('rp-add-family').onclick=function(){ addFamily(); rpUpdateSvQuestion(); };
  var svAdd=rpEl('rp-sv-add'); if(svAdd) svAdd.onclick=svAddSecondParent;
  var famBody=rpEl('family-body');
  if(famBody){ famBody.addEventListener('change', rpUpdateSvQuestion); famBody.addEventListener('click', function(e){ if(e.target&&e.target.getAttribute&&e.target.getAttribute('data-rmf')) setTimeout(rpUpdateSvQuestion,0); }); }
  rpEl('rp-split-mile').onclick=splitMilestones;
  rpEl('rp-hst').oninput=updateMileSum;
  rpEl('btn-retainer-preview').onclick=previewRetainer;
  rpEl('btn-retainer-save').onclick=saveRetainer;
  var cdBtn=document.getElementById('btn-cd-save');
  if(cdBtn) cdBtn.onclick=function(){
    if(!CD_DL) CD_DL=window.tdotDeadlineBox('cd');
    var e=CD_DL.check(false); if(e){ cdMsg(e,'err'); CD_DL.focus(); return; }
    /* CD_DIRTY stays on until the server has saved — a refused save must not let the next load() wipe the typed answer. */
    doAction('saveDeadline', JSON.stringify(CD_DL.read()));
  };
  rpEl('btn-retain-send').onclick=function(){
    // The pa-inviter agreement is CO-SIGNED: the inviter/sponsor/dependent is a
    // named signatory, so their details are compulsory before anything is sent.
    // (The server holds the send anyway — this catches it while staff are here.)
    var gaps=inviterGaps();
    var errEl=rpEl('rp-inviter-err');
    if(gaps.length){
      if(errEl){ errEl.textContent='Cannot send — the co-signer’s '+gaps.join(', ')+' '+(gaps.length>1?'are':'is')+' required for this agreement.'; errEl.style.display='block'; }
      var first=rpEl(gaps[0]==='valid email'?'rp-inviterEmail':('rp-inviter'+gaps[0].charAt(0).toUpperCase()+gaps[0].slice(1)));
      if(first){ first.focus(); }
      return;
    }
    if(errEl) errEl.style.display='none';
    // The deadline (2026-11-05): a client is retained only once it is known — the server refuses too.
    if(!CD_DL) CD_DL=window.tdotDeadlineBox('cd');
    var dlInfo=(LAST_DETAIL&&LAST_DETAIL.deadline)||null;
    if(!(dlInfo && dlInfo.required===false)){   /* the switch, as the server reports it on this record */
      if(CD_DIRTY){ setMsg('Click "Save deadline" first — the deadline in the box is not saved yet.','err'); CD_DL.focus(); return; }
      if(!(dlInfo && dlInfo.set)){
        setMsg('Set the deadline first (the Deadline box): a real deadline with its date, or imaginary with the submission date promised to the client — then Save deadline.','err');
        CD_DL.focus(); return;
      }
    }
    var svMsg=svSendCheck();
    if(svMsg && !window.confirm(svMsg+'\\n\\nOK sends the agreement as it is. Cancel to change the family list first.')){
      var box=rpEl('rp-sv'); if(box&&box.scrollIntoView) box.scrollIntoView({block:'center'});
      return;
    }
    var confirmMsg = rpEl('rp-template').value==='pa-inviter'
      ? 'Retain this client and email the retainer agreement to BOTH signers now — the client and the Inviter/Sponsor/Dependent? It completes only when both have signed.'
      : 'Retain this client and email the retainer agreement (stating the fee) to them now?';
    doAction('retainAndSend', null, confirmMsg);
  };
  // Live re-validation: the co-signer error must clear ITSELF the moment the
  // fields become valid — a fixed email showing a stale "Cannot send" cost the
  // team a real send (Sanjib Biswas, 2026-08-15).
  ['rp-inviterName','rp-inviterEmail','rp-inviterPhone','rp-inviterAddress'].forEach(function(id){
    var el=rpEl(id); if(el) el.addEventListener('input', function(){
      var errEl=rpEl('rp-inviter-err');
      if(errEl && errEl.style.display!=='none' && !inviterGaps().length) errEl.style.display='none';
    });
  });
  // Any edit in the plan means it must be re-saved before it can be sent — reset the
  // "saved" gate (and re-evaluate the Set-fee "done" state) on any change in the fieldset.
  var rpfs=rpEl('rp-lock-fs'); if(rpfs){ ['input','change'].forEach(function(ev){ rpfs.addEventListener(ev,function(){ RP_PLAN_SAVED=false; applyRetainerLock(); }); }); }
  var feeInput=document.getElementById('fee'); if(feeInput) feeInput.addEventListener('input', updateMileSum);
  document.getElementById('btn-consult-preview').onclick=previewConsult;
  document.getElementById('btn-consult-signed-view').onclick=viewSignedConsult;
  document.getElementById('btn-consult-countersign').onclick=countersignConsult;
  document.getElementById('btn-retainer-signed-view').onclick=viewSignedRetainer;
  document.getElementById('btn-retainer-countersign').onclick=countersignRetainer;
  document.getElementById('btn-consult-send').onclick=function(){
    var ca=(LAST_DETAIL&&LAST_DETAIL.consultAgreement)||{};
    var sentOn=ca.sent||(ca.emailedAt?String(ca.emailedAt).slice(0,10):'')||(ca.alreadySent?'an earlier date (a signing request is on record)':'');
    doAction('sendConsultationPackage', JSON.stringify({again:!!(sentOn||ca.alreadySent)}), sentOn
      ? 'This client already received the consultation package on '+sentOn+'. Send it AGAIN? They get the same email once more; the agreement they were already asked to sign is reused — no second signing request is issued.'
      : 'Send the client ONE consultation email now — booking details, meeting link, the pre-consultation form, and the consultation agreement (sent for e-signature when e-sign is enabled) — with a note to complete both before the consultation? Preview the agreement first and make sure the client\\'s address is filled in.');
  };
  document.getElementById('btn-attr-save').onclick=function(){
    doAction('saveAttribution', JSON.stringify({ followUpDate: document.getElementById('at-followup').value, leadOwner: document.getElementById('at-owner').value, bookedBy: document.getElementById('at-bookedby').value, paymentReviewedBy: document.getElementById('at-reviewer').value }), null);
  };
  // Consultation fee: record / change / remove — the dialog collects the facts, doAction posts them.
  document.getElementById('btn-cp-record').onclick=function(){ openConsultPaymentModal(LAST_DETAIL||{}, false); };
  document.getElementById('btn-cp-clear').onclick=function(){ openConsultPaymentModal(LAST_DETAIL||{}, true); };
  // Address box: typed-but-unsaved text survives the re-render every other action
  // triggers (same guard as the invite draft); cleared once the save succeeds.
  document.getElementById('ca-address').addEventListener('input',function(){ ADDR_DIRTY=true; });
  document.getElementById('btn-addr-save').onclick=function(){
    ADDR_DIRTY=false;
    doAction('saveResidentialAddress', document.getElementById('ca-address').value, null); // load() re-renders → the blank-address warning clears
  };
}

initActions();
startClock(); checkApiStatus(); load(); // render() hydrates the retainer panel from the detail payload
</script></body></html>`;
}

// The Consultations page shows consultations only (2026-11-05). The old one-page links keep working:
// ?tab=retainers, ?outcome=, ?convertLead=, ?newAppFrom= → the Retainers page; ?tab=reporting → the Summary page.
router.get('/consultations', (req, res) => {
  const q = req.query || {};
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const tab = String(one(q.tab) || '');
  if (tab === 'retainers' || q.outcome !== undefined || q.convertLead !== undefined || q.newAppFrom !== undefined) {
    const u = new URLSearchParams();
    for (const k of ['outcome', 'convertLead', 'newAppFrom']) if (q[k] !== undefined) u.set(k, String(one(q[k]) || ''));
    const qs = u.toString();
    return res.redirect(302, '/admin/retainers' + (qs ? '?' + qs : ''));
  }
  if (tab === 'reporting') return res.redirect(302, '/admin/dashboard/summary#reporting');
  res.type('html').send(buildQueueHTML());
});
router.get('/retainers', (_req, res) => res.type('html').send(buildRetainersHTML()));
router.get('/consultation/:leadId', (req, res) =>
  res.type('html').send(buildDetailHTML((req.params.leadId || '').trim(), { from: String((req.query || {}).from || '') === 'retainers' ? 'retainers' : '' })));

module.exports = router;
module.exports.buildDetailHTML = buildDetailHTML;
module.exports.buildQueueHTML = buildQueueHTML;
module.exports.buildRetainersHTML = buildRetainersHTML;
