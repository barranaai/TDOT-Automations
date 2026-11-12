/**
 * Owner / Management Dashboard
 * Served at GET /admin/dashboard
 * Fetches live data from /api/dashboard/stats (requires ADMIN_API_KEY).
 * Uses Chart.js for charts; all rendering is client-side.
 */

const express = require('express');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS, DELETE_UI_CSS, DELETE_UI_JS, STATUS_TONE_JS } = require('./adminShared');
const { listCore, listTableScript, LIST_TABLE_CSS } = require('./listFilters');   // one filter look for every list (2026-11-05)
const { casesListSpec, casesListOpts } = require('./listSpecs');
// The Client Master view tabs (block 3): the Monday views as data, and the page's pure helpers (injected with toString).
const clientMasterViews = require('../services/clientMasterViews');
const { clientMasterWindows } = require('./clientMasterWindows');
const { clientMasterUi } = require('./clientMasterUi');
const { DEADLINE_CHANGE_CSS, DEADLINE_CHANGE_HTML, DEADLINE_CHANGE_JS } = require('./deadlineChangeUi');   // Change… on the Deadlines tab (2026-11-10)

// ─── View bodies ──────────────────────────────────────────────────────────
// The dashboard renders ONE of these (user directive 2026-08-05): /admin/dashboard
// is the Client Master table only (renamed from "All Cases", block 3); everything
// else lives on /admin/dashboard/summary.
// Hoisted verbatim as static markup (neither block interpolates) so the split is
// a swap, not a rewrite — and so the two views can never drift apart in the shell.
const SUMMARY_BODY_HTML = `
    <!-- ── KPI Groups ── -->
    <div class="kpi-group">
      <div class="kpi-group-label">Case Health</div>
      <div class="kpi-strip">
        <div class="kpi navy">
          <div class="kpi-num" id="kpi-total">—</div>
          <div class="kpi-label">Total Cases</div>
        </div>
        <div class="kpi green">
          <div class="kpi-num" id="kpi-green">—</div>
          <div class="kpi-label">Healthy</div>
        </div>
        <div class="kpi amber">
          <div class="kpi-num" id="kpi-orange">—</div>
          <div class="kpi-label">At Risk</div>
        </div>
        <div class="kpi red">
          <div class="kpi-num" id="kpi-red">—</div>
          <div class="kpi-label">Critical</div>
        </div>
        <div class="kpi orange">
          <div class="kpi-num" id="kpi-blocked">—</div>
          <div class="kpi-label">Client Blocked</div>
        </div>
        <div class="kpi purple">
          <div class="kpi-num" id="kpi-escalation">—</div>
          <div class="kpi-label">Escalations Open</div>
        </div>
      </div>
      <div class="kpi-group-label" style="margin-top:18px">Operations</div>
      <div class="kpi-strip">
        <div class="kpi rose">
          <div class="kpi-num" id="kpi-unassigned">—</div>
          <div class="kpi-label">Unassigned Cases</div>
        </div>
        <div class="kpi indigo">
          <div class="kpi-num" id="kpi-behind">—</div>
          <div class="kpi-label">Behind Schedule</div>
        </div>
        <div class="kpi red">
          <div class="kpi-num" id="kpi-blocking">—</div>
          <div class="kpi-label">Cases w/ Blockers</div>
        </div>
        <div class="kpi slate">
          <div class="kpi-num" id="kpi-inactive">—</div>
          <div class="kpi-label">Inactive 14d+</div>
        </div>
        <div class="kpi blue">
          <div class="kpi-num" id="kpi-expiry">—</div>
          <div class="kpi-label">Expiry Flagged</div>
        </div>
        <div class="kpi teal">
          <div class="kpi-num" id="kpi-deadline">—</div>
          <div class="kpi-label">Due This Month</div>
        </div>
      </div>
    </div>

    <!-- ── Reporting (the monthly consultation and retainer figures — from the Consultations page until 2026-11-05) ── -->
    <div class="sec-hd" id="reporting">📈 Reporting</div>
    <div class="rp-head">
      <p class="rp-intro">Consultations and retainers by month. Each figure counts by its own date, so one month's steps are not always the same clients.</p>
      <div class="rp-period"><label for="kpi-month">Period</label><select id="kpi-month" class="filter-sel"><option value="">All time</option></select></div>
    </div>
    <div id="kpi-body" aria-live="polite"><div class="rp-muted">Loading the figures…</div></div>

    <!-- ── Reporting charts (2026-11-10). Top row: always the last 12 months. Bottom row: follows the Period box. ── -->
    <div class="rp-charts" id="rp-charts">
      <div class="chart-row chart-row-2" style="margin-bottom:18px">
        <div class="chart-card">
          <div class="chart-title">Month by month — last 12 months</div>
          <div class="rp-chart-wrap" style="height:290px"><canvas id="chart-rp-trend" role="img" aria-label="Leads, booked, consulted, retained and paid this month, month by month"></canvas><div class="rp-empty" id="chart-rp-trend-empty">Loading the chart…</div></div>
          <div class="rp-chart-note">Leads, Booked, Consulted and Retained are the same numbers as the row above for each month. Paid this month = retainer payments received in that month: the same number as the "Paid this month" card. It is not the "Paid" step in the row above, which counts how many of the month's signers have paid.</div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Retained — where they came from</div>
          <div class="rp-chart-wrap" style="height:290px"><canvas id="chart-rp-retained" role="img" aria-label="Retained clients each month, by where they came from"></canvas><div class="rp-empty" id="chart-rp-retained-empty">Loading the chart…</div></div>
          <div class="rp-chart-note">Each bar is one month's signed retainers: from a booked consultation, from a lead turned into a direct retainer, or a walk-in.</div>
        </div>
      </div>
      <div class="rp-chart-note" style="margin:0 0 10px">The three charts below follow the Period box above. The two charts above always show the last 12 months.</div>
      <div class="chart-row chart-row-3" style="margin-bottom:28px">
        <div class="chart-card">
          <div class="chart-title"><span>Leads by source</span><span class="rp-cm" data-rp-period></span></div>
          <div class="rp-chart-wrap" style="height:320px"><canvas id="chart-rp-source" role="img" aria-label="Leads by source"></canvas><div class="rp-empty" id="chart-rp-source-empty">Loading the chart…</div></div>
        </div>
        <div class="chart-card">
          <div class="chart-title"><span>Consultations by consultant</span><span class="rp-cm" data-rp-period></span></div>
          <div class="rp-chart-wrap" style="height:320px"><canvas id="chart-rp-consultant" role="img" aria-label="Consultations booked, by consultant"></canvas><div class="rp-empty" id="chart-rp-consultant-empty">Loading the chart…</div></div>
        </div>
        <div class="chart-card">
          <div class="chart-title"><span>Retainers signed by consultant</span><span class="rp-cm" data-rp-period></span></div>
          <div class="rp-chart-wrap" style="height:320px"><canvas id="chart-rp-signed" role="img" aria-label="Retainers signed, by consultant"></canvas><div class="rp-empty" id="chart-rp-signed-empty">Loading the chart…</div></div>
        </div>
      </div>
    </div>

    <!-- ── Action Required ── -->
    <div class="sec-hd">⚡ Action Required</div>
    <div class="chart-row chart-row-3" style="margin-bottom:28px">

      <div class="action-card border-red">
        <div class="action-card-hd">
          <span>🗓 Deadline ≤7 Days</span>
          <span class="action-badge red" id="act-count-deadline">0</span>
        </div>
        <div class="action-list" id="act-list-deadline"></div>
      </div>

      <div class="action-card border-indigo">
        <div class="action-card-hd">
          <span>📉 Behind Schedule</span>
          <span class="action-badge indigo" id="act-count-behind">0</span>
        </div>
        <div class="action-list" id="act-list-behind"></div>
      </div>

      <div class="action-card border-slate">
        <div class="action-card-hd">
          <span>🔕 No Activity 14d+</span>
          <span class="action-badge slate" id="act-count-stale">0</span>
        </div>
        <div class="action-list" id="act-list-stale"></div>
      </div>

    </div>

    <!-- ── Charts Row 1 ── -->
    <div class="sec-hd">📊 Portfolio Overview</div>
    <div class="chart-row chart-row-3" style="margin-bottom:28px">

      <div class="chart-card">
        <div class="chart-title">🟢 Case Health Distribution</div>
        <div class="chart-wrap donut">
          <canvas id="chart-health"></canvas>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-title">⏱️ SLA Risk Band</div>
        <div class="chart-wrap donut">
          <canvas id="chart-sla"></canvas>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-title">📋 Cases by Stage</div>
        <div class="chart-wrap" style="height:220px">
          <canvas id="chart-stage"></canvas>
        </div>
      </div>

    </div>

    <!-- ── Charts Row 2 ── -->
    <div class="chart-row chart-row-2" style="margin-bottom:28px">

      <div class="chart-card">
        <div class="chart-title">📁 Cases by Immigration Type</div>
        <div class="chart-wrap" style="height:240px">
          <canvas id="chart-type"></canvas>
        </div>
      </div>

      <div class="chart-card rd-card">
        <div class="chart-title">📈 Case Readiness Breakdown</div>
        <div class="rd-cols">

          <div class="rd-col">
            <div class="rd-lbl">Questionnaire</div>
            <div class="rd-num" id="readiness-q">—</div>
            <div class="rd-bar">
              <div id="readiness-q-bar" style="height:100%;border-radius:3px;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .8s ease;width:0%"></div>
            </div>
            <div class="rd-cap">avg questionnaire</div>
          </div>

          <div class="rd-col" style="background:#f9fbff">
            <div class="rd-lbl" style="color:var(--navy)">Overall</div>
            <div class="rd-num" id="readiness-overall">—</div>
            <div class="rd-bar">
              <div id="readiness-overall-bar" style="height:100%;border-radius:3px;background:linear-gradient(90deg,#7c3aed,#a78bfa);transition:width .8s ease;width:0%"></div>
            </div>
            <div class="rd-cap">avg overall</div>
          </div>

          <div class="rd-col">
            <div class="rd-lbl">Documents</div>
            <div class="rd-num" id="readiness-doc">—</div>
            <div class="rd-bar">
              <div id="readiness-doc-bar" style="height:100%;border-radius:3px;background:linear-gradient(90deg,#059669,#34d399);transition:width .8s ease;width:0%"></div>
            </div>
            <div class="rd-cap">avg documents</div>
          </div>

        </div>
        <div style="border-top:1px solid var(--border);padding:9px 20px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:11px;color:var(--muted);background:#fafbfc">
          <span>⚠️ Missing required documents across all active cases:</span>
          <span style="font-weight:800;color:var(--red)" id="readiness-missing">0</span>
        </div>
      </div>

    </div>

    <!-- ── Chasing Stage Row ── -->
    <div class="chart-row chart-row-1" style="margin-bottom:28px">
      <div class="chart-card" style="grid-column:1/-1">
        <div class="chart-title">📬 Chasing Stage Breakdown — retired (replaced by Document reminders; the column is no longer updated)</div>
        <div class="chart-wrap" style="height:180px">
          <canvas id="chart-chasing"></canvas>
        </div>
      </div>
    </div>

    <!-- ── Delay Level + Readiness vs Target Row ── -->
    <div class="chart-row chart-row-dl" style="margin-bottom:28px">

      <div class="chart-card">
        <div class="chart-title">⏳ Client Delay Level</div>
        <div class="chart-wrap donut">
          <canvas id="chart-delay"></canvas>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-title">🎯 Readiness vs Expected — by Stage</div>
        <div class="chart-wrap" style="height:220px">
          <canvas id="chart-readiness-target"></canvas>
        </div>
      </div>

    </div>

    <!-- ── Team Workload ── -->
    <div class="sec-hd">👥 Team Workload &amp; Performance</div>
    <div class="mgr-grid" id="mgr-grid"></div>

    <!-- ── At-Risk Cases ── -->
    <div class="sec-hd">🚨 Cases Requiring Attention</div>
    <div class="table-card" id="atrisk-card">
      <table class="data-table" id="atrisk-table">
        <thead>
          <tr>
            <th>Case Ref</th>
            <th>Client</th>
            <th>Type</th>
            <th>Stage</th>
            <th>Health</th>
            <th>SLA Risk</th>
            <th>Manager</th>
            <th>Readiness</th>
            <th>Days</th>
            <th>Blocking Q</th>
            <th>Blocking Doc</th>
            <th>Last Active</th>
            <th>Deadline</th>
          </tr>
        </thead>
        <tbody id="atrisk-body"></tbody>
      </table>
    </div>
`;

// The needs-attention list (needsAttentionService: 07:00 Toronto daily + "Check
// now"). Summary view only, and OUTSIDE #content: it comes from the server's
// memory, so it shows even while the figures below load slowly or fail.
const NEEDS_ATTENTION_HTML = `
  <section class="na" id="na-panel" aria-labelledby="na-title">
    <div class="na-hd">
      <div>
        <h2 class="na-title" id="na-title" tabindex="-1">Needs attention <span class="na-total" id="na-total" hidden></span></h2>
        <p class="na-sub" id="na-sub">Cases where a step was missed. Checked every morning at 7:00.</p>
        <p class="na-flash" id="na-flash" role="status" aria-live="polite"></p>
      </div>
      <button type="button" class="na-check" id="na-check" onclick="naCheckNow()">Check now</button>
    </div>
    <div role="status" aria-live="polite"><div class="na-note" id="na-note" hidden></div></div>
    <div class="na-body" id="na-body"><div class="na-empty">Loading…</div></div>
  </section>
`;

const ALL_CASES_BODY_HTML = `
    <!-- ── Client Master table (was "All Cases"), with the Monday views as tabs (block 3) ── -->
    <div class="sec-hd">📋 Client Master</div>
    <div class="lt-tabs" id="cs-quick" role="tablist" aria-label="Client Master views"></div>
    <!-- On a view tab: the data time, Print, the counts (Assigning) or the half-month windows (Deadlines). -->
    <div id="cm-head" class="cm-head"></div>
    <div class="table-card">
      <!-- The filters are in the column headers, like every list (2026-11-05): listSpecs.js casesListSpec/Opts. -->
      <div class="table-toolbar">
        <input type="search" class="search-box" id="search-box" placeholder="Search by client, case ref, type, officer, email, phone…" aria-label="Search cases by client, case reference, type, Support Officer, client email, contact number or dependents" autocomplete="off" />
        <!-- Every tab's rows sit under group headings that open and close (2026-11-12): these two act on all of them. -->
        <span class="cm-oc" id="cm-oc" role="group" aria-label="Groups in the table">
          <button type="button" class="cm-oc-b" id="cm-open-all" onclick="cmGrpAll(true)" title="Open every group in the table">Open all</button>
          <button type="button" class="cm-oc-b" id="cm-close-all" onclick="cmGrpAll(false)" title="Close every group: only the headings and their counts stay">Close all</button>
        </span>
        <span class="table-count" id="table-count" aria-live="polite"></span>
      </div>
      <div id="cs-chips" class="q-chips cs-chips" style="display:none" aria-live="polite"></div>
      <div class="tbl-wrap">
      <table class="data-table" id="all-cases-table">
        <thead>
          <tr id="cs-headrow"><th>Case Ref</th><th>Client</th><th>Type</th><th>Stage</th><th>Phase</th><th>Deadline</th><th>Promised</th><th>Health</th><th>SLA Risk</th><th>Support Officer</th><th>Manager</th><th>Readiness</th><th>Days</th><th>Status</th><th></th></tr>
        </thead>
        <tbody id="all-cases-body"></tbody>
      </table>
      </div>
    </div>
`;

/** The column ids of each Client Master tab: { '': the All tab, assigning: […], deadlines: […], eeita: […] }. */
function cmTabCols() {
  const views = clientMasterViews.pageViews(), cols = casesListOpts({ views }).cols, on = listCore({}).colsOnTab;
  const out = { '': on(cols, '').map((c) => c.id) };
  for (const v of views) out[v.key] = on(cols, v.key).map((c) => c.id);
  return out;
}

// The Client Master page's own look (block 3): the view tabs' header box, the group headings,
// the deadline cells and flags, and print (landscape, the groups with their counts, no controls).
const CM_CSS = `
    #all-cases-table { min-width:1260px; }   /* 15 columns: the table scrolls sideways inside its box on a narrow screen */
    /* the header's hidden "Actions" words are position:absolute: without this they are placed against the page, at the table's
       far right, and the whole page scrolls sideways on a phone (found by the 375 px check) */
    .table-card .tbl-wrap { position:relative; }
    #cs-quick { margin:0 0 10px; }
    .cm-head { margin:0 0 12px; display:flex; flex-direction:column; gap:8px; }
    .cm-head:empty { display:none; }
    .cm-top { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .cm-title { font-size:15px; font-weight:800; color:var(--navy); }
    .cm-dataat { font-size:12px; color:#64748b; font-weight:600; }
    .cm-print { margin-left:auto; border:1px solid #e2e8f0; background:#fff; color:var(--navy); border-radius:8px; padding:6px 12px; font:inherit; font-size:12.5px; font-weight:700; cursor:pointer; }
    .cm-print:hover { border-color:var(--navy); }
    .cm-filtered { font-size:12.5px; color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:6px 10px; display:flex; align-items:center; flex-wrap:wrap; gap:4px; }
    .cm-clear { border:none; background:none; color:#92400e; font:inherit; font-weight:700; text-decoration:underline; cursor:pointer; padding:2px 4px; }
    .cm-note { font-size:12px; color:#64748b; }
    .cm-strip { display:flex; flex-wrap:wrap; gap:6px; }
    .cm-st { background:#fff; border:1px solid #e2e8f0; border-radius:999px; padding:3px 11px; font-size:12px; color:#334155; }
    /* a stage count on Assigning is a button: it opens that stage's group and goes to it */
    button.cm-st { font-family:inherit; line-height:inherit; cursor:pointer; border-color:#94a3b8; font-weight:600; }
    button.cm-st::after { content:'›'; margin-left:6px; color:var(--navy); font-weight:700; }   /* reads as a button without hover (phones): the 'waiting for' pills beside it are not */
    button.cm-st:hover { border-color:var(--navy); background:#f8fafc; }
    button.cm-st:focus-visible, .cm-oc-b:focus-visible, .cm-grp-b:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }
    .cm-oc { display:inline-flex; gap:6px; }
    .cm-oc-b { border:1px solid #e2e8f0; background:#fff; color:var(--navy); border-radius:8px; padding:6px 11px; font:inherit; font-size:12.5px; font-weight:700; cursor:pointer; white-space:nowrap; }
    .cm-oc-b:hover { border-color:var(--navy); background:#f8fafc; }
    .cm-st b { color:var(--navy); margin-left:2px; font-variant-numeric:tabular-nums; }
    .cm-line { font-size:12.5px; color:#334155; }
    /* Pre-Onboarding "Waiting for" (2026-11-10): the count strip above Assigning and the second line in the Stage cell.
       The words carry the meaning; the left bar on "Ready" and "Not clear" is only an extra cue. */
    .cm-waitstrip { align-items:center; }
    .cm-wait-lead { font-size:12.5px; color:#334155; font-weight:700; }
    .cm-wait-at { font-size:11.5px; color:#64748b; }
    .cm-wait { margin-top:3px; font-size:11px; line-height:1.35; color:#334155; min-width:128px; }
    .cm-wait b { color:var(--navy); }
    .cm-wait-n { display:block; color:#64748b; }
    .cm-wait.flag { border-left:3px solid var(--st-amber-solid); padding-left:5px; }
    .cm-wait.dim, .cm-wait.dim b { color:#64748b; font-weight:500; }
    .cm-wins { display:flex; flex-wrap:wrap; gap:8px; }
    .cm-win-box { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:7px 11px; font-size:12px; color:#334155; }
    .cm-win-box.now { border-color:var(--st-blue-solid); background:var(--st-blue-bg); }
    .cm-win-box.rest { align-self:stretch; display:flex; align-items:center; color:#64748b; }
    .cm-win-l { font-weight:700; color:var(--navy); }
    .cm-win-l b, .cm-win-n b { font-variant-numeric:tabular-nums; }
    .cm-win-n { font-size:11.5px; color:#64748b; }
    /* A group heading carries a coloured bar at its start, the way Monday colours its groups: the stage's status colour on a view grouped by stage, navy where the group is not a status. */
    .data-table tr.cm-grp td { background:#f8fafc; padding:7px 14px; font-size:12px; color:#334155; border-top:1px solid #e2e8f0; border-bottom:1px solid #e2e8f0; box-shadow:inset 4px 0 0 var(--grp, var(--navy)); cursor:pointer; }
    .cm-grp.tone-green, .cm-in.tone-green, .cm-st.tone-green { --grp:var(--st-green-solid); } .cm-grp.tone-amber, .cm-in.tone-amber, .cm-st.tone-amber { --grp:var(--st-amber-solid); }
    .cm-grp.tone-red, .cm-in.tone-red, .cm-st.tone-red { --grp:var(--st-red-solid); } .cm-grp.tone-blue, .cm-in.tone-blue, .cm-st.tone-blue { --grp:var(--st-blue-solid); }
    .cm-grp.tone-grey, .cm-in.tone-grey, .cm-st.tone-grey { --grp:var(--st-grey-solid); } .cm-grp.tone-purple, .cm-in.tone-purple, .cm-st.tone-purple { --grp:var(--st-purple-solid); }
    /* Groups open and close (2026-11-12). A CLOSED heading is quiet: a thin grey line, a light background, the chevron pointing right.
       An OPEN group is marked as one block: its heading has a navy line above and below and a stronger background, the chevron points
       down, the group's colour runs down the start of every one of its rows, and a navy line closes it under its last row.
       The chevron and aria-expanded say it too, so it never rests on colour alone. */
    .data-table tr.cm-grp.open td { background:#e2e8f0; border-top:2px solid var(--navy); border-bottom:1px solid var(--navy); color:var(--navy); }
    .data-table tr.cm-in td:first-child { box-shadow:inset 4px 0 0 var(--grp, var(--navy)); }
    .data-table tr.cm-in:hover td:first-child { box-shadow:inset 4px 0 0 var(--grp, var(--navy)), inset 7px 0 0 var(--st-blue-solid); }
    #all-cases-table tr.cm-in.cm-last td { border-bottom:2px solid var(--navy); }
    .cm-grp-b { display:inline-flex; align-items:center; gap:8px; border:0; background:none; color:inherit; font:inherit; padding:3px 8px 3px 2px; margin:-3px 0; border-radius:6px; cursor:pointer; white-space:nowrap; }
    .cm-grp:hover .cm-grp-b b, .cm-grp-b:hover b { text-decoration:underline; }
    .cm-chev { display:inline-block; width:0; height:0; border-top:5px solid transparent; border-bottom:5px solid transparent; border-left:7px solid #64748b; transition:transform .15s; }
    .cm-grp.open .cm-chev { transform:rotate(90deg); border-left-color:var(--navy); }
    @media (prefers-reduced-motion: reduce) { .cm-chev { transition:none; } }
    /* the same colour as a dot in front of the group's count pill above the table */
    .cm-st[class*=tone-]::before { content:''; display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--grp); margin-right:6px; }
    .data-table tr.cm-grp:hover td { background:#f1f5f9; }
    .data-table tr.cm-grp.open:hover td { background:#e2e8f0; }
    /* the heading's words stay in view when the table is scrolled sideways (sticky on the td itself does nothing: it is as wide as the table) */
    .cm-grp-t { position:sticky; left:14px; display:inline-block; white-space:nowrap; }
    .cm-grp-t b { color:var(--navy); }
    .cm-grp-c { color:#475569; font-weight:500; }
    .cm-type { display:inline-block; border-radius:6px; padding:1px 6px; font-size:10px; font-weight:700; }
    .cm-type.real { background:var(--st-red-bg); color:var(--st-red-fg); }
    .cm-type.imag { background:var(--st-purple-bg); color:var(--st-purple-fg); }
    .cm-date { white-space:nowrap; }
    .cm-win { display:inline-block; border-radius:6px; padding:1px 6px; font-size:10px; font-weight:600; background:var(--st-grey-bg); color:var(--st-grey-fg); white-space:nowrap; }
    .cm-flag { display:inline-block; border-radius:6px; padding:1px 6px; font-size:10px; font-weight:700; white-space:nowrap; }
    .cm-flag.slide { background:var(--st-amber-bg); color:var(--st-amber-fg); border:1px solid var(--st-amber-solid); }
    .cm-flag.passed { background:var(--st-red-bg); color:var(--st-red-fg); border:1px solid var(--st-red-solid); }
    .cm-assign { margin-left:4px; border:1px solid #cbd5e1; background:#fff; color:var(--navy); border-radius:6px; padding:1px 7px; font:inherit; font-size:11px; font-weight:700; cursor:pointer; }
    .cm-assign:hover { border-color:var(--navy); background:#f8fafc; }
    .cm-asg-ok { margin-left:4px; font-size:11px; font-weight:700; color:var(--st-green-fg); }
    .cm-asg-case { font-size:13px; color:#334155; margin:2px 0 8px; }
    .cm-asg-now { font-size:13px; color:#334155; margin-bottom:12px; }
    .cm-asg-lbl { display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px; }
    .cm-asg-sel { width:100%; min-height:38px; border:1px solid #cbd5e1; border-radius:8px; padding:6px 10px; font:inherit; font-size:14px; background:#fff; color:#0f172a; }
    .cm-asg-what { font-size:12.5px; color:#475569; margin-top:10px; }
    .cm-asg-rm { font-size:12.5px; color:#92400e; margin-top:6px; }
    .cm-asg-rm:empty { display:none; }
    .cm-asg-tell { font-size:12.5px; color:#475569; margin-top:6px; }
    /* ── The view tabs' own columns (team meeting 2026-11-10, item 12; layout chosen 2026-11-12: one column each, like Monday).
       One wide table that scrolls sideways INSIDE its box (.tbl-wrap) — the page itself never does — with Case Ref and Client
       staying in view at the start (in the header and in every row) and a soft shadow on their edge. The All tab is not wide. */
    .cm-none td { text-align:center; color:var(--muted); padding:32px; }
    #search-box { max-width:430px; }   /* room for the longer hint: client, case ref, type, officer, email, phone */
    #all-cases-table.cm-wide { width:max-content; min-width:100%; }
    #all-cases-table.cm-wide .cm-none td { text-align:left; }
    #all-cases-table.cm-wide .cm-none-t { position:sticky; left:14px; display:inline-block; }
    #all-cases-table.cm-wide td { font-size:11.5px; white-space:nowrap; }
    #all-cases-table.cm-wide tr.cm-grp td { font-size:12px; }
    #all-cases-table.cm-wide #cs-headrow th:nth-child(1), #all-cases-table.cm-wide td.cm-pin1 { position:sticky; left:0; z-index:2; box-sizing:border-box; width:126px; min-width:126px; max-width:126px; }
    #all-cases-table.cm-wide #cs-headrow th:nth-child(2), #all-cases-table.cm-wide td.cm-pin2 { position:sticky; left:126px; z-index:2; box-sizing:border-box; width:172px; min-width:172px; max-width:172px; }
    /* the soft shadow on the pinned edge: drawn as its own strip just past the Client column (a cell's box-shadow is not painted over its neighbours in this table) */
    #all-cases-table.cm-wide #cs-headrow th:nth-child(2)::after, #all-cases-table.cm-wide td.cm-pin2::after { content:''; position:absolute; top:0; bottom:0; left:100%; width:9px; pointer-events:none;
      background:linear-gradient(to right, rgba(15,23,42,.22), rgba(15,23,42,.07) 2px, rgba(15,23,42,0)); }
    #all-cases-table.cm-wide #cs-headrow th:nth-child(-n+2) { z-index:3; }
    #all-cases-table.cm-wide td.cm-pin { background:#fff; }
    #all-cases-table.cm-wide td.cm-pin1 { font-weight:600; color:var(--navy); overflow:hidden; text-overflow:ellipsis; }
    #all-cases-table.cm-wide td.cm-pin1 .badge { white-space:normal; }
    /* the pinned cells carry the row's tint and its hover themselves (a sticky cell must not be see-through) */
    #all-cases-table.cm-wide tr.row-red td.cm-pin { background:#fff8f8; }
    #all-cases-table.cm-wide tr.row-orange td.cm-pin { background:#fffdf5; }
    #all-cases-table.cm-wide tr:hover td.cm-pin { background:#f8faff; }
    #all-cases-table.cm-wide tr.row-red:hover td.cm-pin { background:#ffeef0; }
    #all-cases-table.cm-wide tr.row-orange:hover td.cm-pin { background:#fff8e6; }
    /* the sideways scroll box is a named region the keyboard can stop on (arrow keys scroll it); a control that is focused never lands
       under the two pinned columns: the padding is their width (126 + 172; 100 + 112 on a phone) */
    .table-card .tbl-wrap:focus-visible { outline:2px solid var(--navy); outline-offset:-2px; }
    .table-card .tbl-wrap.cm-scroll { scroll-padding-left:298px; }
    .cm-ell { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* long text (dependents, email, case type): two lines at most, the whole text in the cell's title */
    .cm-clip { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
    #all-cases-table.cm-wide td.cm-c-dep, #all-cases-table.cm-wide td.cm-c-email { min-width:150px; max-width:220px; white-space:normal; }
    #all-cases-table.cm-wide td.cm-c-type, #all-cases-table.cm-wide td.cm-c-sub { min-width:120px; max-width:200px; white-space:normal; }
    #all-cases-table.cm-wide td.cm-c-stage { min-width:150px; white-space:normal; }
    #all-cases-table.cm-wide td.cm-off, #all-cases-table.cm-wide td.cm-c-mgr, #all-cases-table.cm-wide td.cm-c-ret { min-width:120px; max-width:220px; white-space:normal; }
    #all-cases-table.cm-wide td.cm-c-rs, #all-cases-table.cm-wide td.cm-c-pay, #all-cases-table.cm-wide td.cm-c-phase, #all-cases-table.cm-wide td.cm-c-phone { min-width:96px; }
    #all-cases-table.cm-wide td.cm-dl, #all-cases-table.cm-wide td.cm-pr { min-width:120px; }
    .cm-pct { font-variant-numeric:tabular-nums; font-weight:600; color:var(--navy); }
    .cm-portal { display:inline-block; color:var(--st-blue-fg); font-weight:700; text-decoration:underline; padding:3px 4px; margin:-3px -4px; border-radius:5px; }
    .cm-portal:hover { background:var(--st-blue-bg); }
    .cm-portal:focus-visible { outline:2px solid var(--navy); outline-offset:1px; }
    @media (max-width: 640px) {   /* a phone: the two pinned columns are narrower, so more of the rest shows beside them */
      #all-cases-table.cm-wide #cs-headrow th:nth-child(1), #all-cases-table.cm-wide td.cm-pin1 { width:100px; min-width:100px; max-width:100px; padding-left:10px; padding-right:6px; }
      #all-cases-table.cm-wide #cs-headrow th:nth-child(2), #all-cases-table.cm-wide td.cm-pin2 { left:100px; width:112px; min-width:112px; max-width:112px; padding-left:8px; padding-right:8px; }
      /* the whole reference always shows: a long one goes onto a second line at its hyphen instead of being cut (its title has it too) */
      #all-cases-table.cm-wide td.cm-pin1 { white-space:normal; overflow-wrap:anywhere; text-overflow:clip; line-height:1.25; }
      .table-card .tbl-wrap.cm-scroll { scroll-padding-left:212px; }
    }
    @media (max-width: 760px) { .cm-print { font-size:16px; } .cm-asg-sel, .cm-asg-dlg .tdlg-btn { font-size:16px; } .cm-oc-b { font-size:14px; padding:8px 12px; } .cm-grp-b { padding-top:6px; padding-bottom:6px; margin:-6px 0; } }
    /* Print (every tab): landscape; the tab name, the data time, the counts or windows, and the groups as they are on screen —
       an open group with its rows, a closed group as its heading line with its count —
       without the top bar, the tabs, the filters, the delete column or any button. */
    @page { size: landscape; margin: 10mm; }
    @media print {
      body { background:#fff; }
      .admin-hdr, .refresh-bar, .view-switch, .dash-subtitle, #cs-quick, .table-toolbar, #cs-chips, .site-footer, #loading, #error-msg, .cm-print, .cm-clear-w, .th-f, .lt-pop, .cm-assign, .cm-asg-ok, .dlc-btn, .dlc-ok { display:none !important; }
      #all-cases-table:not(.cm-wide) #cs-headrow th:last-child, #all-cases-table td.cm-del { display:none; }
      .wrap { padding:0; }
      .dash-header { margin:0 0 6px; }
      .sec-hd { display:none; }
      .table-card { box-shadow:none; border:0; overflow:visible; margin:0; }
      .tbl-wrap { overflow:visible; }
      #all-cases-table { min-width:0; font-size:10pt; }
      .data-table th, .data-table td { padding:3px 5px; }
      .data-table th { font-size:8pt; }
      .data-table tr.row-red, .data-table tr.row-orange { background:none; }
      tr.cm-grp { break-after:avoid; page-break-after:avoid; }
      .cm-grp-t { position:static; }
      .cm-chev { display:none; }
      .cm-grp-b { padding:0; margin:0; }
      .data-table tr.cm-grp td { cursor:auto; }
      button.cm-st { border-color:#e2e8f0; font-weight:inherit; }
      button.cm-st::after { content:none; }
      .cm-head { gap:4px; }
      /* a view tab on paper: the same columns as on screen, nothing pinned, the text wraps so all twenty fit the landscape page */
      #all-cases-table.cm-wide { width:100%; min-width:0; font-size:7pt; }
      #all-cases-table.cm-wide th { font-size:6pt; letter-spacing:0; white-space:normal; }
      #all-cases-table.cm-wide th .th-in { white-space:normal; }
      #all-cases-table.cm-wide td, #all-cases-table.cm-wide tr.cm-grp td { font-size:7pt; white-space:normal; overflow-wrap:break-word; }
      #all-cases-table.cm-wide #cs-headrow th, #all-cases-table.cm-wide td { position:static !important; box-shadow:none !important; width:auto !important; min-width:0 !important; max-width:none !important; }
      #all-cases-table.cm-wide td.cm-pin { background:none !important; }
      #all-cases-table.cm-wide #cs-headrow th:nth-child(2)::after, #all-cases-table.cm-wide td.cm-pin2::after { display:none; }
      .cm-clip, .cm-ell { display:block; overflow:visible; white-space:normal; }
      /* whole words on paper: a word is broken only when it cannot fit its column at all (the email keeps a floor and may break anywhere) */
      #all-cases-table.cm-wide .cm-clip { overflow-wrap:break-word; }
      #all-cases-table.cm-wide td.cm-c-email .cm-clip { overflow-wrap:anywhere; }
      #all-cases-table.cm-wide td.cm-c-email { min-width:26mm !important; }
      /* the header row repeated on pages 2+ prints its column names (Chrome leaves a button out of a repeated header; as plain text it prints) */
      #all-cases-table th .th-sortbtn { display:contents; }
      .cm-none-t { position:static !important; }
      .cm-portal { color:inherit; text-decoration:none; }
    }
`;

function buildDashboardHTML(view = 'cases') {
  const isSummary = view === 'summary';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — ${isSummary ? 'Summary' : 'Client Master'}</title>
  ${isSummary ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>' : '<!-- Chart.js: summary view only. `Chart` is referenced ONLY inside the chart renderers, which the cases view never calls — keep it that way, or this page throws on load. -->'}
  <style>
    ${SHARED_CSS_VARS}
    ${NAV_CSS}

    /* ── Base ──────────────────────────────────────────────────── */
    body { background: #f1f5f9; }

    /* Full width (staff request 2026-09-09): the Cases hub is KPI strips + a
       wide table — both stretch, with just enough side padding to clear the edge. */
    .wrap {
      max-width: none;
      margin: 0;
      padding: 26px 14px 80px;
    }

    /* ── Loading ─────────────────────────────────────────────────── */
    #loading {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 60vh; gap: 20px;
    }

    .spinner {
      width: 48px; height: 48px;
      border: 3px solid #e2e8f0;
      border-top-color: var(--navy);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-text { color: var(--muted); font-size: 13px; font-weight: 600; letter-spacing: .3px; }

    #error-msg {
      display: none;
      background: #fff1f2; border: 1px solid #fda4af; color: #dc2626;
      padding: 16px 20px; border-radius: 12px; margin: 32px auto;
      max-width: 600px; text-align: center; font-size: 14px;
    }

    /* ── Content fade-in ──────────────────────────────────────────── */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    #content { display: none; animation: fadeUp .45s ease both; }

    /* ── Page header ─────────────────────────────────────────────── */
    .dash-header {
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid #e2e8f0;
      display: flex; align-items: flex-end; justify-content: space-between;
    }
    .dash-title {
      font-size: 26px; font-weight: 800; color: var(--navy);
      letter-spacing: -.6px; margin: 0 0 4px;
    }
    .dash-subtitle { font-size: 12px; color: #94a3b8; margin: 0; font-weight: 500; }
    /* Switch between the two dashboard views (Client Master ⇄ Summary). */
    .view-switch {
      align-self: center; text-decoration: none; white-space: nowrap;
      padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 700;
      background: #fff; color: var(--navy); border: 1px solid #e2e8f0;
    }
    .view-switch:hover { background: #f8fafc; }
    .dash-gen { font-size: 11px; color: #94a3b8; }

    /* ── KPI Strip ───────────────────────────────────────────────── */
    .kpi-group { margin-bottom: 32px; }

    .kpi-group-label {
      font-size: 10px; font-weight: 800; text-transform: uppercase;
      letter-spacing: 1px; color: #94a3b8;
      margin-bottom: 10px; padding-left: 2px;
      display: flex; align-items: center; gap: 10px;
    }
    .kpi-group-label::after {
      content: ''; flex: 1; height: 1px;
      background: linear-gradient(to right, #e2e8f0, transparent);
    }

    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 14px;
    }
    .kpi-strip + .kpi-strip { margin-top: 12px; }

    .kpi {
      background: white;
      border-radius: 14px;
      padding: 20px 18px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      border: 1px solid rgba(241,245,249,.8);
      text-align: center;
      position: relative; overflow: hidden;
      transition: transform .18s ease, box-shadow .18s ease;
      cursor: default;
    }

    .kpi:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 32px rgba(0,0,0,.11), 0 4px 8px rgba(0,0,0,.06);
    }

    /* A figure's colour is its status colour (the shared scale): a flat bar across the top of the tile and the number.
       The old names stay on the tiles; each maps to one of the six hues (rose = red, orange = amber, teal = blue, indigo = purple, slate = grey). */
    .kpi::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--kpi, var(--navy)); pointer-events: none; }
    .kpi-num { color: var(--kpi, var(--navy)); }
    .kpi.navy   { --kpi: var(--navy); }
    .kpi.green  { --kpi: var(--st-green-solid); }
    .kpi.red    { --kpi: var(--st-red-solid); }
    .kpi.rose   { --kpi: var(--st-red-solid); }
    .kpi.amber  { --kpi: var(--st-amber-solid); }
    .kpi.orange { --kpi: var(--st-amber-solid); }
    .kpi.blue   { --kpi: var(--st-blue-solid); }
    .kpi.teal   { --kpi: var(--st-blue-solid); }
    .kpi.purple { --kpi: var(--st-purple-solid); }
    .kpi.indigo { --kpi: var(--st-purple-solid); }
    .kpi.slate  { --kpi: var(--st-grey-solid); }

    .kpi-num {
      font-size: 34px; font-weight: 800;
      letter-spacing: -1.5px; line-height: 1;
      margin-bottom: 6px;
    }

    .kpi-label {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .9px;
      color: var(--th-fg);
    }

    /* ── Needs attention (top of the Summary view) ────────────────── */
    .na {
      background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      margin-bottom: 32px; overflow: hidden;
    }
    .na-hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 22px 14px; border-bottom: 1px solid #f1f5f9; }
    .na-title { margin: 0; font-size: 17px; font-weight: 800; color: var(--navy); letter-spacing: -.3px; display: flex; align-items: center; gap: 10px; }
    .na-total { font-size: 12px; font-weight: 800; padding: 2px 10px; border-radius: 20px; background: var(--st-red-bg); color: var(--st-red-fg); font-variant-numeric: tabular-nums; }
    .na-total.zero { background: var(--st-green-bg); color: var(--st-green-fg); }
    .na-sub { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
    .na-flash { margin: 0; font-size: 12.5px; font-weight: 600; color: #15803d; }
    .na-flash:not(:empty) { margin-top: 4px; }   /* stays rendered when empty: it is a live region */
    .na-flash.err { color: #b91c1c; }
    .na-title:focus { outline: none; }
    .na-check {
      flex-shrink: 0; min-height: 36px; padding: 0 16px; border-radius: 8px;
      border: 1px solid #cbd5e1; background: #fff; color: var(--navy);
      font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
    }
    .na-check:hover:not(:disabled) { background: #f8fafc; border-color: #94a3b8; }
    .na-check:disabled { opacity: .55; cursor: default; }
    .na-note { margin: 12px 22px 0; padding: 10px 14px; border-radius: 8px; font-size: 12.5px; line-height: 1.5; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
    .na-note.err { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
    .na-body { padding: 6px 0 2px; }
    .na-empty { padding: 28px 22px; text-align: center; color: var(--muted); font-size: 13px; }
    .na-empty.all-clear { color: var(--st-green-fg); font-weight: 600; }
    .na-group { border-top: 1px solid #f1f5f9; }
    .na-group:first-child { border-top: none; }
    .na-group-hd { display: flex; align-items: center; gap: 10px; padding: 11px 22px; border-left: 4px solid var(--st-grey-solid); background: var(--head-bg); }
    .na-group.sev-high   .na-group-hd { border-left-color: var(--st-red-solid); }
    .na-group.sev-medium .na-group-hd { border-left-color: var(--st-amber-solid); }
    .na-sev { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; padding: 2px 8px; border-radius: 4px; background: #e2e8f0; color: #334155; }
    .na-group.sev-high   .na-sev { background: var(--st-red-bg); color: var(--st-red-fg); }
    .na-group.sev-medium .na-sev { background: var(--st-amber-bg); color: var(--st-amber-fg); }
    .na-group-title { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--navy); flex: 1; min-width: 0; }
    .na-count { font-size: 12px; font-weight: 800; color: #475569; font-variant-numeric: tabular-nums; }
    .na-list { list-style: none; margin: 0; padding: 0; }
    .na-item {
      display: grid; grid-template-columns: minmax(170px, 230px) 1fr minmax(150px, auto);
      gap: 6px 20px; padding: 14px 22px; border-top: 1px solid #f1f5f9; align-items: start;
      transition: opacity .2s ease;
    }
    .na-list .na-item:first-child { border-top: none; }
    .na-item.gone { opacity: 0; }
    .na-who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .na-ref { font-size: 13px; font-weight: 800; color: #1d4ed8; text-decoration: none; font-variant-numeric: tabular-nums; align-self: flex-start; }
    .na-ref:hover { text-decoration: underline; }
    .na-noref { font-size: 11px; font-weight: 800; color: #9a3412; text-transform: uppercase; letter-spacing: .04em; }
    .na-client { font-size: 13px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
    .na-meta { font-size: 11.5px; color: var(--muted); }
    .na-text p { margin: 0; font-size: 13px; line-height: 1.55; color: #334155; max-width: 80ch; overflow-wrap: anywhere; }
    .na-text .na-todo { margin-top: 6px; color: var(--text); }
    .na-todo-lbl { font-weight: 700; color: var(--navy); }
    .na-side { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; text-align: right; }
    .na-since { font-size: 12px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .na-since b { color: #334155; font-weight: 700; }
    .na-act { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .na-btn {
      min-height: 32px; padding: 0 12px; border-radius: 7px; border: 1px solid #cbd5e1;
      background: #fff; color: #334155; font: inherit; font-size: 12px; font-weight: 700;
      cursor: pointer; white-space: nowrap;
    }
    .na-btn:hover:not(:disabled) { background: #f1f5f9; }
    .na-btn.primary { background: var(--navy); border-color: var(--navy); color: #fff; }
    .na-btn.primary:hover:not(:disabled) { background: var(--navy-light); }
    .na-btn:disabled { opacity: .55; cursor: default; }
    .na-confirm-q { font-size: 11.5px; color: #475569; max-width: 230px; line-height: 1.4; }
    .na-confirm-row { display: flex; gap: 6px; }
    .na-err { font-size: 11.5px; color: #b91c1c; max-width: 240px; line-height: 1.4; }
    .na-more {
      display: block; width: 100%; padding: 10px 22px; border: none; border-top: 1px solid #f1f5f9;
      background: #fafbfc; color: #1d4ed8; font: inherit; font-size: 12.5px; font-weight: 700;
      text-align: left; cursor: pointer;
    }
    .na-more:hover { background: #f1f5f9; }
    .na-check:focus-visible, .na-btn:focus-visible, .na-more:focus-visible, .na-ref:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
    @media (max-width: 860px) {
      .na-hd { flex-direction: column; }
      .na-item { grid-template-columns: 1fr; }
      .na-side { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; text-align: left; }
      .na-act { align-items: flex-start; }
    }
    @media (prefers-reduced-motion: reduce) { .na-item { transition: none; } }

    /* ── Section header ──────────────────────────────────────────── */
    .sec-hd {
      display: flex; align-items: center; gap: 12px;
      font-size: 15px; font-weight: 800;
      color: var(--navy); letter-spacing: -.3px;
      margin-bottom: 18px;
    }
    .sec-hd::before {
      content: '';
      display: block; flex-shrink: 0;
      width: 4px; height: 20px; border-radius: 2px;
      background: linear-gradient(180deg, var(--navy) 0%, #3b82f6 100%);
    }
    .sec-hd::after {
      content: ''; flex: 1; height: 1px;
      background: linear-gradient(to right, #e2e8f0, transparent);
    }

    /* ── Chart Grid ──────────────────────────────────────────────── */
    .chart-row { display: grid; gap: 18px; margin-bottom: 32px; }
    .chart-row-1  { grid-template-columns: 1fr; }
    .chart-row-3  { grid-template-columns: 1fr 1fr 1fr; }
    .chart-row-2  { grid-template-columns: 3fr 2fr; }
    .chart-row-dl { grid-template-columns: 1fr 2fr; }

    .chart-card {
      min-width: 0;   /* a chart inside may shrink with its column (a drawn canvas otherwise holds the column at its old width) */
      background: white;
      border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      border: 1px solid #f1f5f9;
      padding: 22px 22px 18px;
      transition: box-shadow .2s ease, transform .2s ease;
    }
    /* Case Readiness Breakdown: three figures side by side; when the CARD is narrow (tablet, phone, a slim
       column) each figure becomes its own row, so the card never pushes the page wider than the screen (2026-11-10). */
    .rd-card { container-type: inline-size; }
    .rd-cols { display:flex; align-items:stretch; justify-content:center; height:190px; }
    .rd-col  { flex:1 1 0; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:0 16px; border-right:1px solid var(--border); }
    .rd-col:last-child { border-right:0; }
    .rd-lbl  { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; }
    .rd-num  { font-size:46px; font-weight:800; letter-spacing:-2px; }
    .rd-bar  { width:90%; height:6px; background:var(--border); border-radius:3px; overflow:hidden; }
    .rd-cap  { font-size:11px; color:var(--light); }
    @container (max-width: 500px) {
      .rd-cols { flex-direction:column; height:auto; }
      .rd-col  { flex:0 0 auto; flex-direction:row; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 12px; padding:12px 16px; border-right:0; border-bottom:1px solid var(--border); }
      .rd-col:last-child { border-bottom:0; }
      .rd-num  { font-size:32px; letter-spacing:-1px; line-height:1.1; }
      .rd-bar, .rd-cap { width:100%; }
    }

    .chart-card:hover {
      box-shadow: 0 8px 26px rgba(0,0,0,.09), 0 3px 6px rgba(0,0,0,.05);
      transform: translateY(-2px);
    }

    .chart-title {
      font-size: 13px; font-weight: 700; color: var(--navy);
      margin-bottom: 16px;
      display: flex; align-items: center; gap: 6px;
      padding-bottom: 12px;
      border-bottom: 1px solid #f1f5f9;
    }

    .chart-wrap { position: relative; }
    .chart-wrap.donut { max-width: 260px; margin: 0 auto; }

    /* ── Action Cards ───────────────────────────────────────────── */
    .action-card {
      background: white; border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      border: 1px solid #f1f5f9;
      overflow: hidden; display: flex; flex-direction: column;
      transition: box-shadow .2s ease, transform .2s ease;
    }
    .action-card:hover {
      box-shadow: 0 8px 26px rgba(0,0,0,.09);
      transform: translateY(-2px);
    }

    .action-card-hd {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px 12px;
      font-size: 12px; font-weight: 700; color: var(--navy);
      border-bottom: 1px solid #f1f5f9;
    }
    .action-card.border-red    .action-card-hd { background: var(--head-bg); border-left: 4px solid var(--st-red-solid); }
    .action-card.border-indigo .action-card-hd { background: var(--head-bg); border-left: 4px solid var(--st-purple-solid); }
    .action-card.border-slate  .action-card-hd { background: var(--head-bg); border-left: 4px solid var(--st-grey-solid); }

    .action-badge {
      font-size: 11px; font-weight: 800; padding: 3px 10px;
      border-radius: 20px; min-width: 26px; text-align: center;
    }
    .action-badge.red    { background: var(--st-red-bg); color: var(--st-red-fg); }
    .action-badge.indigo { background: var(--st-purple-bg); color: var(--st-purple-fg); }
    .action-badge.slate  { background: var(--st-grey-bg); color: var(--st-grey-fg); }

    .action-list { flex: 1; overflow-y: auto; max-height: 260px; }
    .action-item {
      padding: 9px 16px; border-top: 1px solid #f8fafc;
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; font-size: 11px;
      transition: background .12s;
    }
    .action-item:first-child { border-top: none; }
    .action-item:hover { background: #f8faff; }
    .action-name { font-weight: 600; color: var(--navy); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
    .action-meta { flex-shrink: 0; font-size: 10px; font-weight: 700; white-space: nowrap; }
    .action-empty { padding: 32px 16px; text-align: center; color: #94a3b8; font-size: 12px; }
    .action-more { padding: 8px 16px; font-size: 11px; color: #94a3b8; text-align: center; border-top: 1px solid #f1f5f9; font-style: italic; background: #fafbfc; }

    /* ── Manager Grid ────────────────────────────────────────────── */
    .mgr-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
      gap: 16px; margin-bottom: 32px;
    }

    .mgr-card {
      background: white; border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      border: 1px solid #f1f5f9;
      padding: 20px 22px 18px;
      display: flex; flex-direction: column; gap: 14px;
      transition: box-shadow .2s ease, transform .2s ease;
      position: relative; overflow: hidden;
    }
    .mgr-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: var(--navy);
      border-radius: 14px 14px 0 0;
    }
    .mgr-card.score-amber::before { background: var(--st-amber-solid); }
    .mgr-card.score-red::before   { background: var(--st-red-solid); }
    .mgr-card:hover {
      box-shadow: 0 8px 26px rgba(0,0,0,.09);
      transform: translateY(-2px);
    }

    .mgr-head { display: flex; align-items: center; gap: 12px; }

    .mgr-avatar {
      width: 44px; height: 44px; border-radius: 12px;
      background: linear-gradient(135deg, var(--navy) 0%, #2d5282 100%);
      color: white;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: 800; flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(30,58,95,.22);
    }

    .mgr-name { font-size: 14px; font-weight: 700; color: var(--navy); }
    .mgr-cases { font-size: 11px; color: #94a3b8; margin-top: 2px; }

    .mgr-score-row { display: flex; align-items: center; gap: 10px; }
    .mgr-score-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: #94a3b8; flex-shrink: 0; }

    .score-bar-wrap { flex: 1; height: 7px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
    .score-bar-fill {
      height: 100%; border-radius: 4px;
      background: linear-gradient(90deg, #059669, #34d399);
      transition: width .7s cubic-bezier(.4,0,.2,1);
    }
    .score-bar-fill.amber { background: linear-gradient(90deg, #d97706, #fbbf24); }
    .score-bar-fill.red   { background: linear-gradient(90deg, #dc2626, #f87171); }

    .mgr-score-val { font-size: 13px; font-weight: 800; color: var(--navy); min-width: 30px; text-align: right; }

    .mgr-pills { display: flex; gap: 6px; flex-wrap: wrap; }

    .pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px; border-radius: 20px;
      font-size: 10px; font-weight: 700; letter-spacing: .3px;
    }
    .pill.red    { background: var(--st-red-bg); color: var(--st-red-fg); }
    .pill.orange { background: var(--st-amber-bg); color: var(--st-amber-fg); }
    .pill.green  { background: var(--st-green-bg); color: var(--st-green-fg); }
    .pill.blue   { background: var(--st-blue-bg); color: var(--st-blue-fg); }

    .mgr-readiness-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
    .mgr-readiness-label { color: #94a3b8; font-weight: 600; }
    .mgr-readiness-val   { font-weight: 800; color: var(--navy); }

    /* ── At-Risk / Client Master Tables ─────────────────────────── */
    .table-card {
      background: white; border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      border: 1px solid #f1f5f9;
      overflow: hidden; margin-bottom: 32px;
    }

    .table-toolbar {
      padding: 16px 20px; border-bottom: 1px solid #f1f5f9;
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      background: #fafbfc;
    }

    .search-box {
      flex: 1; min-width: 200px; max-width: 340px;
      padding: 9px 12px 9px 36px;
      border: 1.5px solid #e2e8f0; border-radius: 9px;
      font-size: 13px; font-family: inherit; outline: none;
      background: white url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E") no-repeat 11px center;
      transition: border-color .15s, box-shadow .15s;
      color: var(--navy);
    }
    .search-box:focus { border-color: var(--navy); box-shadow: 0 0 0 3px rgba(30,58,95,.08); }

    /* ── Reporting (monthly figures) ── */
    #reporting { scroll-margin-top: calc(var(--header-h) + 12px); }   /* under the sticky top bar when scrolled to */
    .rp-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin:0 0 12px; }
    .rp-intro { font-size:12.5px; color:#64748b; margin:0; max-width:640px; line-height:1.5; }
    .rp-period { display:flex; align-items:center; gap:8px; font-size:12.5px; font-weight:600; color:#64748b; }
    .rp-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:14px; }
    .rp-card { background:#fff; border:1px solid #eef2f7; border-radius:12px; padding:13px 15px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
    .rp-card .rp-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:#94a3b8; }
    .rp-card .rp-num { font-size:23px; font-weight:800; color:var(--navy); margin-top:3px; font-variant-numeric:tabular-nums; }
    .rp-card .rp-sub { font-size:11px; color:#64748b; margin-top:2px; }
    .rp-funnel { background:#fff; border:1px solid #eef2f7; border-radius:12px; padding:14px 16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,.06); display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
    .rp-funnel .rp-step { text-align:center; min-width:64px; }
    .rp-funnel .rp-n { font-size:19px; font-weight:800; color:var(--navy); font-variant-numeric:tabular-nums; }
    .rp-funnel .rp-l { font-size:9.5px; text-transform:uppercase; color:#94a3b8; letter-spacing:.5px; }
    .rp-funnel .rp-arrow { color:#cbd5e1; font-weight:700; font-size:12px; }
    .rp-funnel .rp-arrow b { display:block; color:var(--st-green-fg); font-size:10px; font-weight:800; }
    .rp-2col { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-bottom:28px; }
    .rp-mini { background:#fff; border:1px solid #eef2f7; border-radius:12px; padding:13px 15px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
    .rp-mini h4 { font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#94a3b8; margin:0 0 8px; }
    .rp-mini .rp-row { display:flex; justify-content:space-between; font-size:13px; padding:3px 0; color:#33425a; }
    .rp-mini .rp-row b { color:var(--navy); font-variant-numeric:tabular-nums; }
    .rp-muted { font-size:12.5px; color:#64748b; margin-bottom:28px; }
    .rp-muted a { color:#2563eb; }
    /* Reporting charts: the height is reserved, so the page does not move while a chart loads or redraws */
    .rp-chart-wrap { position:relative; width:100%; min-width:0; }
    .rp-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:0 16px; font-size:12.5px; color:#64748b; background:#fff; }
    .rp-chart-note { font-size:11.5px; color:#64748b; line-height:1.45; margin-top:10px; }
    .rp-cm { margin-left:auto; font-size:11.5px; font-weight:600; color:#64748b; }
    .filter-sel {
      padding: 9px 12px; border: 1.5px solid #e2e8f0; border-radius: 9px;
      font-size: 13px; font-family: inherit; outline: none;
      background: white; cursor: pointer;
      transition: border-color .15s; color: var(--navy);
    }
    .filter-sel:focus { border-color: var(--navy); }

    .table-count { font-size: 12px; color: #94a3b8; margin-left: auto; white-space: nowrap; font-weight: 600; }

    .data-table { width: 100%; border-collapse: collapse; font-size: 12px; }

    .data-table th {
      background: var(--th-bg); padding: 10px 14px;
      text-align: left; font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .8px; color: var(--th-fg);
      border-bottom: 2px solid var(--th-line);
      cursor: pointer; user-select: none; white-space: nowrap;
      transition: color .12s, background .12s;
    }
    .data-table th:hover { color: var(--navy); background: var(--border); }
    .data-table th.sorted { color: var(--navy); background: var(--st-blue-bg); }
    .data-table th .sort-arrow { margin-left: 4px; opacity: .4; font-size: 10px; }
    .data-table th.sorted .sort-arrow { opacity: 1; }

    .data-table td {
      padding: 11px 14px; border-bottom: 1px solid #f8fafc;
      vertical-align: middle; transition: background .1s;
    }
    .data-table tr:last-child td { border-bottom: none; }
    .data-table tr.row-red    { background: #fff8f8; }
    .data-table tr.row-orange { background: #fffdf5; }
    .data-table tr:hover td            { background: #f8faff; }
    .data-table tr:not(.cm-grp):hover td:first-child { box-shadow: inset 3px 0 0 var(--st-blue-solid); }   /* the row under the pointer */
    .data-table tr.row-red:hover td    { background: #ffeef0; }
    .data-table tr.row-orange:hover td { background: #fff8e6; }

    /* ── Badges ──────────────────────────────────────────────────── */
    .health-dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; margin-right: 5px; flex-shrink: 0;
    }
    .health-dot.red    { background: var(--st-red-solid); }
    .health-dot.orange { background: var(--st-amber-solid); }
    .health-dot.green  { background: var(--st-green-solid); }

    .badge {
      display: inline-flex; align-items: center;
      padding: 2px 9px; border-radius: 20px;
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .4px;
    }
    .badge.red    { background: var(--st-red-bg); color: var(--st-red-fg); }
    .badge.orange { background: var(--st-amber-bg); color: var(--st-amber-fg); }
    .badge.green  { background: var(--st-green-bg); color: var(--st-green-fg); }
    .badge.blue   { background: var(--st-blue-bg); color: var(--st-blue-fg); }
    .badge.grey   { background: var(--st-grey-bg); color: var(--st-grey-fg); }

    /* ── Readiness bar ────────────────────────────────────────────── */
    .readiness-bar { display: flex; align-items: center; gap: 8px; }
    .r-bar-bg { flex: 1; height: 6px; background: #f1f5f9; border-radius: 4px; overflow: hidden; min-width: 60px; }
    .r-bar-fill { height: 100%; border-radius: 4px; background: var(--st-green-solid); }
    .r-bar-fill.mid { background: var(--st-amber-solid); }
    .r-bar-fill.low { background: var(--st-red-solid); }
    .r-bar-pct { font-size: 11px; font-weight: 700; color: var(--navy); min-width: 30px; }

    /* ── Refresh bar ─────────────────────────────────────────────── */
    .refresh-bar {
      background: linear-gradient(135deg, #1a3358 0%, #2d5282 100%);
      padding: 10px 32px;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid rgba(255,255,255,.07);
      box-shadow: 0 2px 10px rgba(0,0,0,.14);
    }
    .refresh-bar-left { display: flex; align-items: center; gap: 10px; }
    .refresh-bar-right { display: flex; align-items: center; gap: 16px; }
    .live-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #4ade80;
      box-shadow: 0 0 0 0 rgba(74,222,128,.5);
      animation: livePulse 2.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes livePulse {
      0%   { box-shadow: 0 0 0 0 rgba(74,222,128,.5); }
      60%  { box-shadow: 0 0 0 7px rgba(74,222,128,.0); }
      100% { box-shadow: 0 0 0 0 rgba(74,222,128,.0); }
    }
    .live-label { font-size: 11px; font-weight: 700; color: rgba(255,255,255,.55); letter-spacing: .6px; text-transform: uppercase; }
    .refresh-updated { font-size: 11px; color: rgba(255,255,255,.4); }
    .refresh-btn {
      padding: 6px 18px;
      background: rgba(255,255,255,.11); color: white;
      border: 1px solid rgba(255,255,255,.2); border-radius: 8px;
      font-size: 12px; font-weight: 700; font-family: inherit; cursor: pointer;
      transition: background .15s, border-color .15s;
    }
    .refresh-btn:hover { background: rgba(255,255,255,.2); border-color: rgba(255,255,255,.38); }
    .refresh-btn:disabled { opacity: .5; cursor: not-allowed; }

    /* ── Responsive ───────────────────────────────────────────────── */
    @media (max-width: 1100px) {
      .chart-row-3  { grid-template-columns: 1fr 1fr; }
      .chart-row-dl { grid-template-columns: 1fr; }
      .kpi-strip    { grid-template-columns: repeat(3, 1fr); }
    }

    @media (max-width: 760px) {
      .chart-row-3, .chart-row-2, .chart-row-dl { grid-template-columns: 1fr; }
      .kpi-strip { grid-template-columns: repeat(2, 1fr); }
      .wrap { padding: 16px 14px 56px; }
      .refresh-bar { padding: 10px 16px; }
      .dash-title { font-size: 20px; }
    }

    /* ── Footer ───────────────────────────────────────────────────── */
    .site-footer {
      text-align: center; padding: 28px;
      font-size: 11px; font-weight: 600; color: #94a3b8;
      border-top: 1px solid #e2e8f0; margin-top: 56px; letter-spacing: .3px;
    }
    ${DELETE_UI_CSS}
    /* The Cases list: the shared filter look (listFilters.js) — header funnels, chips, sort by the column name. */
    ${LIST_TABLE_CSS}
    ${DEADLINE_CHANGE_CSS}
    /* Headers sort through their name buttons now (Cases) — and the Summary at-risk table never sorted: no pointer, no hover. */
    .data-table th { cursor:default; }
    .data-table th:hover { background:#f8fafc; color:#94a3b8; }
    .cs-chips { padding:10px 20px 0; margin:0; }
    ${isSummary ? '' : CM_CSS}
  </style>
</head>
<body>

${buildNavHeader(isSummary ? 'summary' : 'dashboard')}

<!-- ── Refresh bar ──────────────────────────────────────────────── -->
<div class="refresh-bar">
  <div class="refresh-bar-left">
    <span class="live-dot"></span>
    <span class="live-label">Live Dashboard</span>
  </div>
  <div class="refresh-bar-right">
    <span id="hdr-updated" class="refresh-updated"></span>
    <button id="refresh-btn" class="refresh-btn" onclick="loadData(true)" title="Read Monday again (when the data shown is more than 30 seconds old)">↻ Refresh</button>
  </div>
</div>

<!-- ── MAIN ───────────────────────────────────────────────────────── -->
<main class="wrap">

  <!-- ── Page Header (shown at once, not only after the figures load) ── -->
  <div class="dash-header">
    <div>
      <h1 class="dash-title">${isSummary ? 'Summary' : 'Client Master'}</h1>
      <p class="dash-subtitle">${isSummary
        ? 'Portfolio overview, workload and cases needing attention · TDOT Immigration Platform'
        : 'The Client Master board, with its Monday views as tabs'}</p>
    </div>
    <a class="view-switch" href="${isSummary ? '/admin/dashboard' : '/admin/dashboard/summary'}">${isSummary ? '📋 Client Master' : '📊 Summary'}</a>
  </div>

  ${isSummary ? NEEDS_ATTENTION_HTML : ''}

  <!-- Loading -->
  <div id="loading">
    <div class="spinner"></div>
    <div class="loading-text">Loading live case data from Monday.com…</div>
  </div>

  <!-- Error -->
  <div id="error-msg"></div>

  <!-- Content -->
  <div id="content">

    ${isSummary ? SUMMARY_BODY_HTML : ALL_CASES_BODY_HTML}

  </div><!-- /content -->

</main>

<footer class="site-footer">
  TDOT Immigration Automation Platform &nbsp;·&nbsp; Owner Dashboard &nbsp;·&nbsp; Live from Monday.com
</footer>

<script>
var _data     = null;
// Which view this page is — emitted by the server, never sniffed from the DOM.
var VIEW = ${JSON.stringify(view)};
// Newest case first (user directive 2026-08-05) — the list's default sort, in
// listSpecs.js casesListSpec (createdAt, descending): on the All tab that is the order
// inside each board group. Clicking a column name still re-sorts; the filters are in
// the column headers (2026-11-05). No pages: every tab is grouped (2026-11-12).

var HEALTH_ORDER = { Red: 0, Orange: 1, Green: 2 };
// The Client Master view tabs (block 3) — from clientMasterViews.pageViews(): key, label, hint, grouping, order.
var CM_VIEWS = ${JSON.stringify(clientMasterViews.pageViews())};
var CM_PRE_ONBOARDING = ${clientMasterViews.PRE_ONBOARDING_INDEX};   // Case Stage "Pre-Onboarding" (label index)
// The table's columns per tab — '' = All, then one list per view tab (listSpecs casesListOpts: a column's tabs; the same
// rule the header is drawn by, listCore colsOnTab). The rows and the full-width rows follow it.
var CM_TABCOLS = ${JSON.stringify(cmTabCols())};
${isSummary ? '' : 'var CMW = (' + clientMasterWindows.toString() + ')(); var CMU = (' + clientMasterUi.toString() + ')(CMW);'}

/* ── Count-up animation ──────────────────────────────────────────── */
function countUp(id, target) {
  var el = document.getElementById(id);
  if (!el) return;
  if (isNaN(target) || target < 0) target = 0;
  var duration = 650;
  var startTime = null;
  function step(ts) {
    if (!startTime) startTime = ts;
    var p = Math.min((ts - startTime) / duration, 1);
    var eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(eased * target);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ── Shared auth + clock ────────────────────────────────────────── */
${SHARED_AUTH_JS}
${STATUS_TONE_JS}

/* ── Load data ───────────────────────────────────────────────────── */
// fresh: the Refresh button — the server asks Monday again when its copy is more than 30 s old
// (the first load and a reload after a delete use the copy as usual).
function loadData(fresh) {
  var key = getKey();
  if (VIEW === 'summary') naLoad();   // the needs-attention list loads on its own
  var btn = document.getElementById('refresh-btn');
  btn.textContent = '↻ Loading…';
  btn.disabled = true;

  document.getElementById('loading').style.display = 'flex';
  document.getElementById('content').style.display = 'none';
  document.getElementById('error-msg').style.display = 'none';

  // Identity-aware endpoint: send the admin key if we have one (→ see all),
  // otherwise the Monday staff cookie is sent automatically (→ your cases).
  var headers = key ? { 'X-Api-Key': key } : {};
  // contact=1 (the client's email, phone and portal link for the view tabs' columns) is asked for by the Client Master list only — never by the Summary
  var qs = [];
  if (fresh === true) qs.push('fresh=1');
  if (VIEW !== 'summary') qs.push('contact=1');
  fetch('/admin/dashboard-stats' + (qs.length ? '?' + qs.join('&') : ''), { headers: headers, credentials: 'same-origin' })
    .then(function(r) {
      if (r.status === 401) {
        return r.json().then(function(j) {
          document.getElementById('loading').style.display = 'none';
          var el = document.getElementById('error-msg');
          el.innerHTML = 'Please sign in to view the dashboard. ' +
            '<a href="' + (j.loginUrl || '/q/auth/monday') + '" style="color:#fff;text-decoration:underline">Sign in with Monday</a>' +
            ' — or enter the team admin key on the <a href="/admin" style="color:#fff;text-decoration:underline">sign-in page</a>.';
          el.style.display = 'block';
          throw new Error('Unauthorized');
        });
      }
      /* Any other failed read is said — never drawn as an empty list over the filters on screen (2026-11-05). */
      return r.json().catch(function() { return {}; }).then(function(j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    })
    .then(function(data) {
      /* a bad answer never replaces the data the rows on screen came from (the tab counts and headings read _data) */
      if (VIEW !== 'summary' && (!data || !Array.isArray(data.cases))) throw new Error('the case list did not come back');
      _data = data;
      window.TDOT_IS_ADMIN = !!(data.viewer && data.viewer.isAdmin);
      render(data);
      document.getElementById('loading').style.display = 'none';
      document.getElementById('content').style.display = 'block';
      if (VIEW !== 'summary') cmWaitLater();   // "Not checked yet" labels are filled in once, quietly, a little later
      /* An old Reporting link lands on #reporting: the browser could not scroll to it while #content was hidden — once, on the first load. */
      if (VIEW === 'summary' && !window.__tdotHashDone && location.hash) {
        window.__tdotHashDone = true;
        var frag = document.getElementById(location.hash.slice(1));
        if (frag) requestAnimationFrame(function() { frag.scrollIntoView({ block: 'start' }); });
      }
      var gen = new Date(data.generatedAt);
      var scope = '';
      if (data.viewer && data.viewer.scope === 'assigned') {
        scope = ' · 👤 Your assigned cases (' + (data.summary ? data.summary.total : 0) + ')' +
          (data.viewer.name ? ' — ' + data.viewer.name : '');
      } else if (data.viewer && data.viewer.scope === 'all') {
        scope = ' · 🗂️ All cases' + (data.viewer.name && data.viewer.name !== 'Admin' ? ' — ' + data.viewer.name : '');
      }
      /* The Client Master page says when MONDAY was read (dataAt), not when this answer was made: the copy can be up to 20 min old. */
      document.getElementById('hdr-updated').textContent = VIEW === 'summary'
        ? 'Updated: ' + gen.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + scope
        : (cmDataTimeText(data) || 'Monday data') + scope;
    })
    .catch(function(e) {
      if (e.message === 'Unauthorized') return; // page is navigating away — suppress error flash
      document.getElementById('loading').style.display = 'none';
      var el = document.getElementById('error-msg');
      el.textContent = 'Failed to load data: ' + e.message + '. Make sure you are logged in.';
      el.style.display = 'block';
    })
    .finally(function() {
      btn.textContent = '↻ Refresh';
      btn.disabled = false;
    });
}

/* ── Reporting: the monthly consultation and retainer figures (moved here from the Consultations page, 2026-11-05) ── */
function kpiMoney(n){ return '$'+Number(n||0).toLocaleString('en-CA'); }
function kpiCard(label,num,sub){ return '<div class="rp-card"><div class="rp-label">'+label+'</div><div class="rp-num">'+num+'</div>'+(sub?'<div class="rp-sub">'+sub+'</div>':'')+'</div>'; }
function kpiByList(obj){ var ks=Object.keys(obj||{}); if(!ks.length) return '<div class="rp-muted">None</div>'; return ks.sort(function(a,b){return obj[b]-obj[a];}).map(function(k){ return '<div class="rp-row"><span>'+escHtml(k)+'</span><b>'+obj[k]+'</b></div>'; }).join(''); }
function renderKpis(d){
  var c=d.consultations||{}, r=d.retainers||{}, f=d.funnel||{}, rt=(f.rates||{});
  var cards = kpiCard('Consultations booked', c.booked||0, (c.virtual||0)+' virtual · '+(c.inPerson||0)+' in-person'+((c.phone||0)?' · '+c.phone+' phone':'')+' · Abandoned holds: '+(c.abandonedHolds||0)+((c.holdsInProgress||0)?' · '+c.holdsInProgress+' on hold now':''))
    + kpiCard('Consultations held', c.held||0, 'Upcoming: '+(c.upcoming||0))
    + kpiCard('Consultation revenue', kpiMoney(c.revenue||0), 'paid consults, fees before HST'+((c.paidByStaff||0)?' · '+c.paidByStaff+' recorded by staff':'')+((c.waived||0)?' · '+c.waived+' waived':''))
    + kpiCard('Retainers signed', r.signed||0, (r.sent||0)+' sent')
    + kpiCard('Paid this month', f.paid||0, 'Of this month&#39;s signers: '+(f.signersPaid||0)+' of '+(f.retained||0)+' paid'+(rt.paidOfSigners!=null?' ('+rt.paidOfSigners+'%)':''))
    + kpiCard('Retainer value', kpiMoney(r.feeValue||0), 'signed this period')
    + kpiCard('New / existing', (c.newClients||0)+' / '+(c.existingClients||0), 'clients booked');
  var arrow=function(rate){ return '<span class="rp-arrow">→'+(rate!=null?'<b>'+rate+'%</b>':'')+'</span>'; };
  var step=function(n,l){ return '<div class="rp-step"><div class="rp-n">'+n+'</div><div class="rp-l">'+l+'</div></div>'; };
  var funnel = '<div class="rp-funnel">'
    + step(f.leads||0,'Leads') + arrow(rt.bookedFromLeads)
    + step(f.booked||0,'Booked') + '<span class="rp-arrow">→</span>'
    + step(f.consulted||0,'Consulted') + '<span class="rp-arrow">→</span>'
    + step(f.retained||0,'Retained') + arrow(rt.paidOfSigners)
    + step(f.signersPaid||0,'Paid')
    + '</div>';
  var rf=f.retainedFrom||{};
  var split = '<div class="rp-muted" style="margin-top:6px">Retained: '+(rf.booked||0)+' from a booked consultation · '+(rf.converted||0)+' from a lead turned into a direct retainer · '+(rf.walkIn||0)+' walk-in (direct)'
    + (rt.retainedFromBooked!=null?' · '+rt.retainedFromBooked+'% of booked consultations became a retainer':'')+'</div>'
    + '<div class="rp-muted" style="margin-top:4px">Counting changed on 9 Nov 2026: abandoned holds and future consultations no longer count, and retained now includes walk-ins. Earlier months are shown the new way.</div>';
  var unclassified=(r.signed||0)-(r.tr||0)-(r.pr||0);
  var mini = '<div class="rp-2col">'
    + '<div class="rp-mini"><h4>Retainers by type</h4>'
      + '<div class="rp-row"><span>Temporary (TR)</span><b>'+(r.tr||0)+'</b></div>'
      + '<div class="rp-row"><span>Permanent (PR)</span><b>'+(r.pr||0)+'</b></div>'
      + (unclassified>0 ? '<div class="rp-muted" style="margin-top:4px">'+unclassified+' unclassified (case type not mapped)</div>' : '')
      + '</div>'
    + '<div class="rp-mini"><h4>By consultant (booked)</h4>'+kpiByList(c.byConsultant)+'</div>'
    + '<div class="rp-mini"><h4>Bookings by owner</h4>'+kpiByList(c.byLeadOwner)+'</div>'
    + '<div class="rp-mini"><h4>Retainers signed by consultant</h4>'+kpiByList(r.byConsultant)+'</div>'
    + '</div>';
  document.getElementById('kpi-body').innerHTML = '<div class="rp-grid">'+cards+'</div>' + funnel + split + mini;
}
function fillMonths(months, sel){
  var el=document.getElementById('kpi-month'); if(el.getAttribute('data-filled')) return; el.setAttribute('data-filled','1');
  var list=(months||[]).slice(); if(sel && list.indexOf(sel)<0) list.unshift(sel);
  el.innerHTML='<option value="">All time</option>'+list.map(function(m){ return '<option value="'+m+'">'+m+'</option>'; }).join('');
  el.value=sel||'';
  el.onchange=function(){ loadKpis(el.value); };
}
function loadKpis(month){
  /* The figures need the team key (the /api routes). The Summary page itself needs it too (loadData's getKey sends a
     visitor without one to the sign-in page), so this branch is only a safety net for a key removed mid-session. */
  var key = peekKey();
  var body = document.getElementById('kpi-body');
  var sel = document.getElementById('kpi-month');
  if (!key) { body.innerHTML = '<div class="rp-muted">The monthly figures need the team key — sign in on the <a href="/admin">sign-in page</a> to see them.</div>'; if (sel) sel.disabled = true; rpMonthChartsFailed(); return; }
  var m = (month===undefined) ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit'}).format(new Date()) : month;   // the Toronto month
  body.innerHTML='<div class="rp-muted">Loading the figures…</div>';
  fetch('/api/kpis'+(m?('?month='+encodeURIComponent(m)):''),{headers:{'X-Api-Key':key}})
   .then(function(r){
     if(r.status===401||r.status===403){ throw new Error('the team key was not accepted — sign in again on the sign-in page'); }
     /* A failed read is said — never drawn as all-zero figures (review 2026-11-05). */
     return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; });
   })
   .then(function(d){
     fillMonths(d.months, m); renderKpis(d);
     /* the charts that follow the Period box: same answer, same numbers. A chart that fails never takes the figures down with it. */
     try { renderMonthCharts(d); } catch (e) { rpMonthChartsFailed(); }
   })
   .catch(function(e){
     body.innerHTML='<div class="rp-muted">The figures could not be read: '+escHtml(e.message)+' — choose a period again, or reload the page.</div>';
     rpMonthChartsFailed();
     /* the Period box stays usable: choosing again is the retry */
     if (sel && !sel.getAttribute('data-filled')) { sel.innerHTML='<option value="">All time</option>'+(m?'<option value="'+m+'" selected>'+m+'</option>':''); sel.onchange=function(){ loadKpis(sel.value); }; }
   });
}

/* ── Reporting charts (2026-11-10) ──
   Top row (last 12 months) reads /api/kpis/trend once per page load. Bottom row is drawn from the SAME /api/kpis
   answer as the cards, so a chart can never show a different number from the card beside it.
   Chart is used only inside rpDraw, and only after a typeof check: figures still show if the chart library did not load. */
var RP_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function rpMonthName(mk){ var m=/^([0-9]{4})-([0-9]{2})$/.exec(String(mk||'')); return m ? (RP_MON[Number(m[2])-1]||m[2])+' '+m[1] : 'All time'; }
/* Show (text) or clear (no text) the message that sits over a chart's reserved space. */
function rpNote(id, text){
  var e=document.getElementById(id+'-empty'), c=document.getElementById(id);
  if (e) { e.textContent=text||''; e.style.display=text?'flex':'none'; }
  if (c) c.style.visibility=text?'hidden':'visible';
}
function rpDraw(id, config, summary){
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
  var canvas=document.getElementById(id); if (!canvas) return;
  if (typeof Chart === 'undefined') { rpNote(id, 'The chart could not be drawn — reload the page. The figures above are complete.'); return; }
  rpNote(id, '');
  if (summary) canvas.setAttribute('aria-label', summary);
  _charts[id] = new Chart(canvas.getContext('2d'), config);
}
function rpClear(id, text){ if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; } rpNote(id, text); }
var RP_FONT = { size: 11, family: 'Inter' };
function rpWhole(v){ return Number(v)===Math.round(v) ? v : ''; }
function renderTrendCharts(t){
  var pts=(t&&t.trend)||[];
  var labels=pts.map(function(p){ return rpMonthName(p.month); });
  var pick=function(k){ return pts.map(function(p){ return Number(p[k])||0; }); };
  var from=function(k){ return pts.map(function(p){ return Number((p.retainedFrom||{})[k])||0; }); };
  var sum=function(a){ return a.reduce(function(x,y){ return x+y; },0); };
  /* colour is never the only cue: each line has its own point shape and dash, named in the legend */
  var series=[
    { label:'Leads',     data:pick('leads'),         color:'#3b82f6', shape:'circle',   dash:[] },
    { label:'Booked',    data:pick('booked'),        color:'#8b5cf6', shape:'rect',     dash:[6,3] },
    { label:'Consulted', data:pick('consulted'),     color:'#06b6d4', shape:'triangle', dash:[2,3] },
    { label:'Retained',  data:pick('retained'),      color:'#16a34a', shape:'rectRot',  dash:[] },
    { label:'Paid this month', data:pick('paidThisMonth'), color:'#f97316', shape:'star',     dash:[8,3,2,3] }
  ];
  var any=series.some(function(s){ return sum(s.data)>0; });
  if (!pts.length || !any) rpClear('chart-rp-trend', 'Nothing to show for the last 12 months');
  else rpDraw('chart-rp-trend', {
    type:'line',
    data:{ labels:labels, datasets:series.map(function(s){ return { label:s.label, data:s.data, borderColor:s.color, backgroundColor:s.color, pointStyle:s.shape, pointRadius:4, pointHoverRadius:6, borderDash:s.dash, borderWidth:2, tension:0.25, fill:false }; }) },
    options:{ responsive:true, maintainAspectRatio:false, interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ position:'bottom', labels:{ font:RP_FONT, padding:12, usePointStyle:true } } },
      scales:{ x:{ grid:{ display:false }, ticks:{ font:{ size:10, family:'Inter' }, maxRotation:35 } }, y:{ beginAtZero:true, grid:{ color:'#f0f4f8' }, ticks:{ font:{ size:10 }, callback:rpWhole } } } }
  }, 'Month by month, last 12 months. Latest month '+(labels[labels.length-1]||'')+': '+series.map(function(s){ return s.label+' '+s.data[s.data.length-1]; }).join(', ')+'.');
  var parts=[
    { label:'From a booked consultation', data:from('booked'),    color:'#3b82f6' },
    { label:'From a converted lead',      data:from('converted'), color:'#8b5cf6' },
    { label:'Walk-in',                    data:from('walkIn'),    color:'#f97316' }
  ];
  if (!pts.length || !parts.some(function(s){ return sum(s.data)>0; })) rpClear('chart-rp-retained', 'Nothing to show for the last 12 months');
  else rpDraw('chart-rp-retained', {
    type:'bar',
    data:{ labels:labels, datasets:parts.map(function(s){ return { label:s.label, data:s.data, backgroundColor:s.color, borderColor:'#fff', borderWidth:1, borderRadius:3 }; }) },
    options:{ responsive:true, maintainAspectRatio:false, interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ position:'bottom', labels:{ font:RP_FONT, padding:12, usePointStyle:true, pointStyle:'rect' } },
        tooltip:{ callbacks:{ footer:function(items){ var n=0; items.forEach(function(i){ n+=Number(i.raw)||0; }); return 'Retained in the month: '+n; } } } },
      scales:{ x:{ stacked:true, grid:{ display:false }, ticks:{ font:{ size:10, family:'Inter' }, maxRotation:35 } }, y:{ stacked:true, beginAtZero:true, grid:{ color:'#f0f4f8' }, ticks:{ font:{ size:10 }, callback:rpWhole } } } }
  }, 'Retained by where they came from, last 12 months. Latest month '+(labels[labels.length-1]||'')+': '+parts.map(function(s){ return s.label+' '+s.data[s.data.length-1]; }).join(', ')+'.');
}
var _rpTrendAsked=false;
function loadTrend(){
  if (_rpTrendAsked) return; _rpTrendAsked=true;
  var key=peekKey();
  var fail=function(text){ rpClear('chart-rp-trend', text); rpClear('chart-rp-retained', text); };
  if (!key) { fail('Sign in on the sign-in page to see this chart.'); return; }
  fetch('/api/kpis/trend',{headers:{'X-Api-Key':key}})
   .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); })
   .then(renderTrendCharts)
   .catch(function(){ _rpTrendAsked=false; fail('This chart could not be read — reload the page to try again.'); });
}
/* A name → count list as rows for a bar chart: biggest first; past max rows the rest are added up as "Other". */
function rpRows(obj, max){
  var ks=Object.keys(obj||{}).filter(function(k){ return Number(obj[k])>0; });
  ks.sort(function(a,b){ return (obj[b]-obj[a]) || (a<b?-1:a>b?1:0); });
  var rows=ks.map(function(k){ return { name:k, n:Number(obj[k]) }; });
  if (max && rows.length>max) {
    var rest=rows.slice(max), other=0; rest.forEach(function(r){ other+=r.n; });
    rows=rows.slice(0,max); rows.push({ name:'Other ('+rest.length+' more)', n:other });
  }
  return rows;
}
function rpBars(id, title, period, obj, color, unit, max){
  var rows=rpRows(obj, max);
  if (!rows.length) { rpClear(id, period==='All time' ? 'Nothing to show yet' : 'Nothing to show for this month'); return; }
  rpDraw(id, {
    type:'bar',
    data:{ labels:rows.map(function(r){ return r.name; }), datasets:[{ label:unit, data:rows.map(function(r){ return r.n; }), backgroundColor:color, borderRadius:4, maxBarThickness:26 }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(c){ return ' '+c.raw+' '+unit; } } } },
      scales:{ x:{ beginAtZero:true, grid:{ color:'#f0f4f8' }, ticks:{ font:{ size:10 }, callback:rpWhole } }, y:{ grid:{ display:false }, ticks:{ font:RP_FONT } } } }
  }, title+', '+period+': '+rows.map(function(r){ return r.name+' '+r.n; }).join(', ')+'.');
}
/* The three charts that follow the Period box — from the same answer as the cards (d = /api/kpis). */
function renderMonthCharts(d){
  var period=rpMonthName(d && d.month);
  var tags=document.querySelectorAll('[data-rp-period]');
  for (var i=0;i<tags.length;i++) tags[i].textContent=period;
  rpBars('chart-rp-source',     'Leads by source',                period, ((d&&d.funnel)||{}).leadsBySource,       '#3b82f6', 'leads', 10);
  rpBars('chart-rp-consultant', 'Consultations by consultant',    period, ((d&&d.consultations)||{}).byConsultant, '#06b6d4', 'consultations booked', 10);
  rpBars('chart-rp-signed',     'Retainers signed by consultant', period, ((d&&d.retainers)||{}).byConsultant,     '#16a34a', 'retainers signed', 10);
}
function rpMonthChartsFailed(){ ['chart-rp-source','chart-rp-consultant','chart-rp-signed'].forEach(function(id){ rpClear(id, 'This chart could not be read — choose a period again, or reload the page.'); }); }

/* ── Render all ──────────────────────────────────────────────────── */
// Each view renders ONLY its own section. This branch is load-bearing: several
// summary renderers dereference their container without a null check (e.g.
// renderActionCards → getElementById('act-count-deadline').textContent), so
// running them on the cases page would throw BEFORE initAllCasesTable and
// leave the table empty behind a stuck spinner.
function render(data) {
  if (VIEW === 'summary') {
    renderKPIs(data.summary);
    renderActionCards(data.cases);
    renderHealthChart(data.byHealth);
    renderSlaChart(data.bySlaRisk);
    renderStageChart(data.byStage);
    renderTypeChart(data.byType);
    renderReadiness(data.summary);
    renderChasingChart(data.byChasingStage);
    renderDelayChart(data.byDelayLevel);
    renderReadinessVsTargetChart(data.readinessByStage);
    renderManagerCards(data.byManager);
    renderAtRisk(data.cases);
    return;
  }
  initAllCasesTable(data);
}

/* ── KPIs ─────────────────────────────────────────────────────────── */
function renderKPIs(s) {
  countUp('kpi-total',      s.total);
  countUp('kpi-green',      s.green);
  countUp('kpi-orange',     s.orange);
  countUp('kpi-red',        s.red);
  countUp('kpi-blocked',    s.clientBlocked);
  countUp('kpi-escalation', s.escalationOpen);
  countUp('kpi-unassigned', s.unassignedCount     || 0);
  countUp('kpi-behind',     s.behindScheduleCount || 0);
  countUp('kpi-blocking',   s.casesWithBlocking   || 0);
  countUp('kpi-inactive',   s.inactiveCount       || 0);
  countUp('kpi-expiry',     s.expiryFlagged       || 0);
  countUp('kpi-deadline',   s.deadlineSoonCount   || 0);
}

/* ── Readiness meter ──────────────────────────────────────────────── */
function renderReadiness(s) {
  var qPct       = s.avgQReadiness   || 0;
  var docPct     = s.avgDocReadiness || 0;
  var overallPct = s.avgReadiness    || 0;

  var qEl       = document.getElementById('readiness-q');
  var docEl     = document.getElementById('readiness-doc');
  var overallEl = document.getElementById('readiness-overall');
  if (qEl)       qEl.textContent       = qPct + '%';
  if (docEl)     docEl.textContent     = docPct + '%';
  if (overallEl) overallEl.textContent = overallPct + '%';

  var qColor       = qPct       >= 80 ? 'var(--green)' : qPct       >= 50 ? 'var(--amber)' : 'var(--red)';
  var docColor     = docPct     >= 80 ? 'var(--green)' : docPct     >= 50 ? 'var(--amber)' : 'var(--red)';
  var overallColor = overallPct >= 80 ? 'var(--green)' : overallPct >= 50 ? 'var(--amber)' : 'var(--red)';
  if (qEl)       qEl.style.color       = qColor;
  if (docEl)     docEl.style.color     = docColor;
  if (overallEl) overallEl.style.color = overallColor;

  var qBar       = document.getElementById('readiness-q-bar');
  var docBar     = document.getElementById('readiness-doc-bar');
  var overallBar = document.getElementById('readiness-overall-bar');
  if (qBar)       qBar.style.width       = qPct       + '%';
  if (docBar)     docBar.style.width     = docPct     + '%';
  if (overallBar) overallBar.style.width = overallPct + '%';

  var missingEl = document.getElementById('readiness-missing');
  if (missingEl) missingEl.textContent = (s.totalMissingDocs || 0);
}

/* ── Chart helpers ────────────────────────────────────────────────── */
var _charts = {};

function makeDonut(canvasId, labels, values, colors) {
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  _charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 4 }] },
    options: {
      responsive: true,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11, family: 'Inter' }, padding: 12, usePointStyle: true, pointStyleWidth: 8 } },
        tooltip: { callbacks: { label: function(ctx) { return ' ' + ctx.label + ': ' + ctx.raw + ' cases'; } } }
      }
    }
  });
}

function makeHBar(canvasId, labels, values, color, maxVal) {
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  _charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return ' ' + ctx.raw + ' cases'; } } } },
      scales: {
        x: { beginAtZero: true, max: maxVal || undefined, grid: { color: '#f0f4f8' }, ticks: { font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { font: { size: 11, family: 'Inter' } } }
      }
    }
  });
}

function makeVBar(canvasId, labels, values, colors) {
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  _charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return ' ' + ctx.raw + ' cases'; } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10, family: 'Inter' }, maxRotation: 35, minRotation: 20 } },
        y: { beginAtZero: true, grid: { color: '#f0f4f8' }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

/* ── Individual charts ────────────────────────────────────────────── */
function renderHealthChart(byHealth) {
  var order  = ['Green', 'Orange', 'Red'];
  var COLS   = { Green: statusColour('green-solid'), Orange: statusColour('amber-solid'), Red: statusColour('red-solid') };
  var labels = [], vals = [], colors = [];
  order.forEach(function(k) {
    if (byHealth[k]) { labels.push(k); vals.push(byHealth[k]); colors.push(COLS[k]); }
  });
  makeDonut('chart-health', labels, vals, colors);
}

function renderSlaChart(bySla) {
  var order  = ['Green', 'Orange', 'Red'];
  var COLS   = { Green: statusColour('green-solid'), Orange: statusColour('amber-solid'), Red: statusColour('red-solid') };
  var labels = [], vals = [], colors = [];
  order.forEach(function(k) {
    if (bySla[k]) { labels.push(k); vals.push(bySla[k]); colors.push(COLS[k]); }
  });
  makeDonut('chart-sla', labels, vals, colors);
}

function renderStageChart(byStage) {
  var stageOrder = [
    'Document Collection Started',
    'Internal Review',
    'Submission Preparation',
    'Submitted',
    'Stuck',
    'Unknown',
  ];
  var stageColors = {
    'Document Collection Started': '#3b82f6',
    'Internal Review':             '#8b5cf6',
    'Submission Preparation':      '#06b6d4',
    'Submitted':                   '#22c55e',
    'Stuck':                       '#ef4444',
    'Unknown':                     '#94a3b8',
  };
  var all    = Object.keys(byStage).sort(function(a, b) {
    var ia = stageOrder.indexOf(a), ib = stageOrder.indexOf(b);
    if (ia === -1) ia = 99; if (ib === -1) ib = 99;
    return ia - ib;
  });
  var labels = all.map(function(k) {
    return k.replace('Document Collection Started', 'Doc Collection').replace('Submission Preparation', 'Sub Prep');
  });
  var vals   = all.map(function(k) { return byStage[k]; });
  var colors = all.map(function(k) { return statusColour(stageTone(k) + '-solid'); });   // a stage's bar in the stage's status colour, as on the case page
  makeHBar('chart-stage', labels, vals, colors);
}

function renderTypeChart(byType) {
  var entries = Object.entries(byType).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 12);
  var palette = ['#1e3a5f','#2d5282','#3b82f6','#0284c7','#0891b2','#0d9488','#059669','#65a30d','#ca8a04','#b45309','#b91c1c','#7c3aed'];
  var labels = entries.map(function(e) {
    var s = e[0];
    return s.length > 26 ? s.slice(0, 24) + '…' : s;
  });
  var vals   = entries.map(function(e) { return e[1]; });
  var colors = entries.map(function(_, i) { return palette[i % palette.length]; });
  makeVBar('chart-type', labels, vals, colors);
}

/* ── Chasing Stage Chart ──────────────────────────────────────────── */
function renderChasingChart(byChasingStage) {
  var CHASING_ORDER = ['Pending', 'R1 Sent', 'R2 Sent', 'Final Notice Sent', 'Client Blocked', 'Resolved', 'Cleared'];
  var CHASING_COLORS = {
    'Pending':           '#94a3b8',
    'R1 Sent':           '#fb923c',
    'R2 Sent':           '#f97316',
    'Final Notice Sent': '#dc2626',
    'Client Blocked':    '#7f1d1d',
    'Resolved':          '#059669',
    'Cleared':           '#10b981',
  };

  var allKeys = Object.keys(byChasingStage || {});
  var ordered = CHASING_ORDER.filter(function(k) { return allKeys.indexOf(k) !== -1; });
  var extra   = allKeys.filter(function(k) { return CHASING_ORDER.indexOf(k) === -1; });
  var labels  = ordered.concat(extra);
  var values  = labels.map(function(k) { return byChasingStage[k] || 0; });
  var colors  = labels.map(function(k) { return CHASING_COLORS[k] || '#64748b'; });

  var ctx = document.getElementById('chart-chasing');
  if (!ctx) return;
  if (_charts['chart-chasing']) { _charts['chart-chasing'].destroy(); }
  _charts['chart-chasing'] = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function(ctx) { return ' ' + ctx.parsed.x + ' cases'; } } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { precision: 0 } },
        y: { grid: { display: false } }
      }
    }
  });
}

/* ── Client Delay Level Chart ─────────────────────────────────────── */
function renderDelayChart(byDelayLevel) {
  var ORDER  = ['Low', 'Medium', 'High'];
  var COLORS = { Low: statusColour('green-solid'), Medium: statusColour('amber-solid'), High: statusColour('red-solid') };
  // Exclude 'None' / empty entries — they add no actionable signal
  var keys   = ORDER.filter(function(k) { return byDelayLevel[k]; });
  var extra  = Object.keys(byDelayLevel).filter(function(k) {
    return ORDER.indexOf(k) === -1 && k && k !== 'None' && byDelayLevel[k];
  });
  var labels = keys.concat(extra);
  var vals   = labels.map(function(k) { return byDelayLevel[k] || 0; });
  var colors = labels.map(function(k) { return COLORS[k] || '#94a3b8'; });
  if (!labels.length) {
    // No actionable delay data — destroy any previous chart so canvas is blank
    if (_charts['chart-delay']) { _charts['chart-delay'].destroy(); delete _charts['chart-delay']; }
    return;
  }
  makeDonut('chart-delay', labels, vals, colors);
}

/* ── Readiness vs Expected by Stage Chart ─────────────────────────── */
function renderReadinessVsTargetChart(readinessByStage) {
  var STAGE_ORDER = [
    'Document Collection Started', 'Internal Review',
    'Submission Preparation', 'Submitted', 'Stuck',
  ];
  var all     = Object.keys(readinessByStage || {});
  var ordered = STAGE_ORDER.filter(function(s) { return all.indexOf(s) !== -1; });
  var extra   = all.filter(function(s) { return STAGE_ORDER.indexOf(s) === -1; });
  var stages  = ordered.concat(extra);

  if (!stages.length) {
    if (_charts['chart-readiness-target']) { _charts['chart-readiness-target'].destroy(); delete _charts['chart-readiness-target']; }
    return;
  }

  var labels   = stages.map(function(s) {
    return s.replace('Document Collection Started', 'Doc Collection')
             .replace('Submission Preparation', 'Sub Prep');
  });
  var actuals   = stages.map(function(s) { return readinessByStage[s].avgActual; });
  var expected  = stages.map(function(s) { return readinessByStage[s].avgExpected; });

  if (_charts['chart-readiness-target']) _charts['chart-readiness-target'].destroy();
  var ctx = document.getElementById('chart-readiness-target');
  if (!ctx) return;
  _charts['chart-readiness-target'] = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Actual Readiness %',
          data:  actuals,
          backgroundColor: 'rgba(59,130,246,0.8)',
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Expected Readiness %',
          data:  expected,
          backgroundColor: 'rgba(16,185,129,0.5)',
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 } },
        tooltip: { callbacks: { label: function(ctx) { return ' ' + ctx.dataset.label + ': ' + ctx.raw + '%'; } } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, max: 100, grid: { color: '#f0f4f8' }, ticks: { callback: function(v) { return v + '%'; }, font: { size: 10 } } },
      },
    },
  });
}

/* ── Action Required Cards ────────────────────────────────────────── */
function renderActionCards(cases) {
  // ── Deadline ≤7 days (or overdue) ───────────────────────────────
  var deadlineCases = cases.filter(function(c) {
    if (!c.hardDeadline) return false;
    var d = new Date(c.hardDeadline);
    if (isNaN(d)) return false;
    return Math.floor((d.getTime() - Date.now()) / 86400000) <= 7;
  }).sort(function(a, b) { return new Date(a.hardDeadline) - new Date(b.hardDeadline); });
  document.getElementById('act-count-deadline').textContent = deadlineCases.length;
  _fillActionList('act-list-deadline', deadlineCases, function(c) {
    var daysUntil = Math.floor((new Date(c.hardDeadline) - Date.now()) / 86400000);
    var label = daysUntil < 0 ? 'Overdue ' + Math.abs(daysUntil) + 'd'
              : daysUntil === 0 ? 'Due today' : 'In ' + daysUntil + 'd';
    var style = daysUntil < 0 ? 'color:#dc2626;font-weight:700'
              : daysUntil <= 3 ? 'color:#ea580c;font-weight:700' : 'color:#b45309;font-weight:600';
    return { name: c.clientName || c.caseRef || '—', meta: label, metaStyle: style };
  });

  // ── Behind schedule ──────────────────────────────────────────────
  var behindCases = cases.filter(function(c) { return c.behindSchedule; })
    .sort(function(a, b) {
      return (b.expectedReadiness - b.overallReadiness) - (a.expectedReadiness - a.overallReadiness);
    });
  document.getElementById('act-count-behind').textContent = behindCases.length;
  _fillActionList('act-list-behind', behindCases, function(c) {
    var gap = c.expectedReadiness - c.overallReadiness;
    return {
      name:      c.clientName || c.caseRef || '—',
      meta:      c.overallReadiness + '% / ' + c.expectedReadiness + '% (−' + gap + ')',
      metaStyle: 'color:#4f46e5;font-weight:600',
    };
  });

  // ── No activity 14d+ ─────────────────────────────────────────────
  var staleCases = cases.filter(function(c) {
    if (!c.lastActivity) return true;
    var d = new Date(c.lastActivity);
    if (isNaN(d)) return true;
    return Math.floor((Date.now() - d.getTime()) / 86400000) >= 14;
  }).sort(function(a, b) {
    var ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    var tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    if (isNaN(ta)) ta = 0;   // guard: invalid date string → treat as never
    if (isNaN(tb)) tb = 0;
    return ta - tb;   // oldest first
  });
  document.getElementById('act-count-stale').textContent = staleCases.length;
  _fillActionList('act-list-stale', staleCases, function(c) {
    return {
      name:      c.clientName || c.caseRef || '—',
      meta:      c.lastActivity ? daysAgoLabel(c.lastActivity) : 'Never',
      metaStyle: 'color:#64748b',
    };
  });
}

function _fillActionList(listId, cases, rowFn) {
  var el = document.getElementById(listId);
  if (!el) return;
  el.innerHTML = '';
  if (!cases.length) {
    el.innerHTML = '<div class="action-empty">All clear ✓</div>';
    return;
  }
  cases.slice(0, 8).forEach(function(c) {
    var row = rowFn(c);
    var div = document.createElement('div');
    div.className = 'action-item';
    div.innerHTML =
      '<span class="action-name" title="' + escHtml(row.name) + '">' + escHtml(row.name) + '</span>' +
      '<span class="action-meta" style="' + (row.metaStyle || '') + '">' + escHtml(row.meta) + '</span>';
    el.appendChild(div);
  });
  if (cases.length > 8) {
    var more = document.createElement('div');
    more.className = 'action-more';
    more.textContent = '+ ' + (cases.length - 8) + ' more — see table below';
    el.appendChild(more);
  }
}

/* ── Manager Cards ────────────────────────────────────────────────── */
function renderManagerCards(byManager) {
  var grid = document.getElementById('mgr-grid');
  if (!grid) return;
  grid.innerHTML = '';

  var managers = Object.keys(byManager).sort(function(a, b) {
    return byManager[b].score - byManager[a].score;
  });

  if (managers.length === 0) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px">No case manager data available — ensure cases have an assigned Case Manager on the Client Master Board.</div>';
    return;
  }

  managers.forEach(function(name, idx) {
    var m  = byManager[name];
    var initials = name.split(' ').map(function(p) { return p[0] || ''; }).join('').slice(0, 2).toUpperCase() || '?';
    var score = m.score || 0;
    var scoreColor = score >= 70 ? '' : (score >= 40 ? ' amber' : ' red');

    var rankBadge = idx === 0 ? ' 🥇' : (idx === 1 ? ' 🥈' : (idx === 2 ? ' 🥉' : ''));

    var card = document.createElement('div');
    card.className = 'mgr-card' + (score < 40 ? ' score-red' : score < 70 ? ' score-amber' : '');
    card.innerHTML =
      '<div class="mgr-head">' +
        '<div class="mgr-avatar">' + escHtml(initials) + '</div>' +
        '<div>' +
          '<div class="mgr-name">' + escHtml(name) + escHtml(rankBadge) + '</div>' +
          '<div class="mgr-cases">' + m.total + ' active case' + (m.total !== 1 ? 's' : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mgr-pills">' +
        (m.green  > 0 ? '<span class="pill green">'  + m.green  + ' Green</span>'  : '') +
        (m.orange > 0 ? '<span class="pill orange">' + m.orange + ' Orange</span>' : '') +
        (m.red    > 0 ? '<span class="pill red">'    + m.red    + ' Red</span>'    : '') +
      '</div>' +
      '<div class="mgr-score-row">' +
        '<span class="mgr-score-label">Performance</span>' +
        '<div class="score-bar-wrap"><div class="score-bar-fill' + scoreColor + '" style="width:' + score + '%"></div></div>' +
        '<span class="mgr-score-val">' + score + '</span>' +
      '</div>' +
      '<div class="mgr-readiness-row">' +
        '<span class="mgr-readiness-label">Avg Readiness</span>' +
        '<span class="mgr-readiness-val">' + m.avgReadiness + '%</span>' +
      '</div>' +
      ((m.behindCount > 0 || m.blockingCount > 0) ?
        '<div style="display:flex;gap:6px;flex-wrap:wrap;padding-top:4px;border-top:1px solid var(--border)">' +
          (m.behindCount  > 0 ? '<span style="font-size:10px;font-weight:700;background:var(--st-purple-bg);color:var(--st-purple-fg);border-radius:5px;padding:2px 8px">' + m.behindCount  + ' behind schedule</span>' : '') +
          (m.blockingCount > 0 ? '<span style="font-size:10px;font-weight:700;background:var(--st-red-bg);color:var(--st-red-fg);border-radius:5px;padding:2px 8px">' + m.blockingCount + ' w/ blockers</span>'    : '') +
        '</div>'
      : '');

    grid.appendChild(card);
  });
}

/* ── At-Risk Table ────────────────────────────────────────────────── */
function renderAtRisk(cases) {
  var atRisk = cases.filter(function(c) {
    return c.health === 'Red' || c.slaRisk === 'Red' || c.health === 'Orange';
  }).sort(function(a, b) {
    var ao = HEALTH_ORDER[a.health] !== undefined ? HEALTH_ORDER[a.health] : 2;
    var bo = HEALTH_ORDER[b.health] !== undefined ? HEALTH_ORDER[b.health] : 2;
    return ao - bo;
  });

  var tbody = document.getElementById('atrisk-body');
  tbody.innerHTML = '';

  if (atRisk.length === 0) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="13" style="text-align:center;color:var(--muted);padding:32px">No cases are currently at risk 🎉</td>';
    tbody.appendChild(tr);
    return;
  }

  atRisk.forEach(function(c) {
    var r       = c.overallReadiness || 0;
    var exp     = c.expectedReadiness || 0;
    var rColor  = (exp > 0 && r < exp - 15) ? 'color:#dc2626;font-weight:700' : (r >= 70 ? 'color:var(--green)' : r >= 40 ? 'color:var(--amber)' : 'color:var(--red)');
    var rLabel  = r + '%' + (exp > 0 ? ' / ' + exp + '%' : '');

    var bqCell  = c.blockingQ  > 0
      ? '<span class="badge red">' + c.blockingQ  + '</span>'
      : '<span style="color:var(--light);font-size:11px">—</span>';
    var bdCell  = c.blockingDoc > 0
      ? '<span class="badge red">' + c.blockingDoc + '</span>'
      : '<span style="color:var(--light);font-size:11px">—</span>';

    var tr = document.createElement('tr');
    tr.className = c.health === 'Red' ? 'row-red' : (c.health === 'Orange' ? 'row-orange' : '');
    // Same ref-less treatment as the All-Cases table: say what unblocks the
    // cockpit instead of a silent dash — and give ref'd rows the same
    // click-through, so both tables behave identically.
    var refCell;
    if (c.caseRef) {
      refCell = escHtml(c.caseRef);
      tr.style.cursor = 'pointer';
      tr.title = 'Open case cockpit';
      tr.onclick = function() { window.location.href = '/admin/case/' + encodeURIComponent(c.caseRef); };
    } else if (!c.caseType || c.caseType === 'Unknown') {
      refCell = '<span class="badge orange">Needs Case Type</span>';
      tr.title = 'No case reference yet — set the Case Type on this item in Monday and the reference (and cockpit) is created automatically.';
    } else {
      refCell = '<span class="badge blue">Ref pending</span>';
      tr.title = 'Case Type is set — the case reference is assigned automatically; refresh shortly.';
    }
    tr.innerHTML =
      '<td style="font-weight:600;color:var(--navy)">' + refCell + '</td>' +
      '<td>' + escHtml(c.clientName) + '</td>' +
      '<td style="color:var(--muted)">' + shortType(c.caseType) + '</td>' +
      '<td><span style="font-size:11px">' + escHtml(c.caseStage) + '</span></td>' +
      '<td>' + healthBadge(c.health) + '</td>' +
      '<td>' + healthBadge(c.slaRisk) + '</td>' +
      '<td style="color:var(--muted)">' + escHtml(c.manager) + '</td>' +
      '<td style="font-size:11px;' + rColor + '">' + rLabel + '</td>' +
      '<td style="text-align:center;font-weight:600">' + (c.daysElapsed || 0) + '</td>' +
      '<td style="text-align:center">' + bqCell + '</td>' +
      '<td style="text-align:center">' + bdCell + '</td>' +
      '<td style="font-size:11px;color:var(--muted)">' + daysAgoLabel(c.lastActivity) + '</td>' +
      '<td style="font-size:11px">' + formatDeadline(c.hardDeadline) + '</td>';
    tbody.appendChild(tr);
  });
}

/* ── Client Master table (was "All Cases") ───────────────────────── */
// New data (the first load, Refresh, after a delete): the search, the header
// filters, the sort, the tab AND the page stay as they were — the list never
// shows every case while a filter is still on screen.
function initAllCasesTable(data) {
  if (!data || !Array.isArray(data.cases)) throw new Error('the case list did not come back');   // the rows on screen stay
  CasesTable.setRows(data.cases);
}

/* ── The view tabs (block 3) ──────────────────────────────────────
   All = every case you may see, grouped like Monday's main table (by board group, in the
   board's order; newest first inside a group). The other tabs are exact copies of three
   Monday views on the Client Master board (the same rows, grouping and order — worked out
   on the server, clientMasterViews.js). No tab has pages. Every group opens and closes
   (the groups code is further down). The counts above the table come from the rows that
   match — in an open group or a closed one — and never change them.
   A link opens a tab: /admin/dashboard?view=assigning (deadlines, eeita; all).
   A tab taken off the page (CM_GONE: Mahesh, 2026-11-12) opens its nearest tab instead: an old
   link, and a browser tab that was left on it (the kept tab in sessionStorage). */
var CM_GONE = { mahesh: 'deadlines' };
var CM_TAB_KEY = 'tdot_list_cases_tab';   // the list's quick.storeKey (listSpecs.js casesListOpts)
function cmViewDef(key) { for (var i = 0; i < CM_VIEWS.length; i++) if (CM_VIEWS[i].key === key) return CM_VIEWS[i]; return null; }
function cmView(st) { var v = st && st.sel && st.sel.view; return v && v.length ? cmViewDef(v[0]) : null; }
function cmInitial(st) {
  var p = null;
  try { p = new URLSearchParams(window.location.search).get('view'); } catch (e) { return false; }
  if (p === null) {   // no link: a browser tab left on a tab that is gone opens the nearest one (and that is kept)
    var kept = null;
    try { kept = window.sessionStorage.getItem(CM_TAB_KEY); } catch (e) { return false; }
    var near = kept !== null && Object.prototype.hasOwnProperty.call(CM_GONE, kept) ? CM_GONE[kept] : null;
    if (!near || !cmViewDef(near)) return false;
    st.sel.view = [near];
    return true;
  }
  var t = String(p).trim().toLowerCase();
  if (!t || t === 'all') { delete st.sel.view; return true; }
  if (Object.prototype.hasOwnProperty.call(CM_GONE, t) && cmViewDef(CM_GONE[t])) {   // an old link: the nearest tab, and the address says so
    t = CM_GONE[t];
    try { var g = new URL(window.location.href); g.searchParams.set('view', t); history.replaceState(null, '', g.toString()); } catch (e) {}
  }
  if (!cmViewDef(t)) {   // a tab we do not have: not a link — and the address stops naming it
    try { var u = new URL(window.location.href); u.searchParams.delete('view'); history.replaceState(null, '', u.toString()); } catch (e) {}
    return false;
  }
  st.sel.view = [t];
  return true;
}
function cmOnChange(st) {
  var v = cmView(st);
  try { var u = new URL(window.location.href); if (v) u.searchParams.set('view', v.key); else u.searchParams.delete('view'); history.replaceState(null, '', u.toString()); } catch (e) {}
}
function cmToday() { return CMW.torontoToday(Date.now()); }
function cmDay(day) { var t = CMW.shortDay(day); return t ? t + ', ' + String(day).slice(0, 4) : ''; }
function cmHm(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
/* when MONDAY was read (dataAt) — never when the answer was made (generatedAt): that would make an old copy look new */
function cmDataTimeText(data) { var t = cmHm((data && data.dataAt) || ''); return t ? 'Monday data from ' + t : ''; }
/* The rows of a view this person may see (after RBAC on the server, before their own search and filters). */
function cmInView(key) { return ((_data && _data.cases) || []).filter(function(c) { return (c.views || []).indexOf(key) >= 0; }).length; }
function cmNoneDash() { return '<span style="color:var(--light)">—</span>'; }
/* "Not checked yet" (2026-11-10): the client records were not in memory when the page loaded (just after a restart).
   ONCE, a little later, the labels are asked for again quietly and filled in on the rows already on screen —
   no spinner, the search, filters and tab stay; a failure leaves the page as it is (Refresh still works).
   It asks WITHOUT contact=1 and copies only c.waiting onto the rows on screen, so their email, phone and portal link stay as loaded. */
var _cmWaitAsked = false;
function cmWaitLater() {
  if (_cmWaitAsked || !_data || _data.waitingAt) return;
  if (!(_data.cases || []).some(function(c) { return c.waiting && c.waiting.code === 'unchecked'; })) return;
  _cmWaitAsked = true;
  setTimeout(function() {
    var key = getKey();
    fetch('/admin/dashboard-stats', { headers: key ? { 'X-Api-Key': key } : {}, credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(j) {
        if (!j || !j.waitingAt || !Array.isArray(j.cases) || !_data || !Array.isArray(_data.cases)) return;
        var byId = {};
        j.cases.forEach(function(c) { if (c.waiting) byId[String(c.id)] = c.waiting; });
        _data.cases.forEach(function(c) { if (c.waiting && byId[String(c.id)]) c.waiting = byId[String(c.id)]; });
        _data.waitingAt = j.waitingAt;
        CasesTable.setRows(_data.cases);
      })
      .catch(function() {});
  }, 45000);
}

// The shared engine hands over the filtered, sorted cases. Every tab is drawn in groups, with no pages.
function renderCasesList(rows, why, st, h) {
  var v = cmView(st);
  if (v) return renderViewTable(v, rows, st, !(h && h.defaultSort === false));
  // All: the board's own groups; inside a group the engine's order (newest first, or the column sort chosen)
  return renderViewTable(CMU.ALL_VIEW, rows, st, false, h && typeof h.total === 'number' ? h.total : rows.length);
}

/* ── Groups that open and close (team meeting 2026-11-10, items 10 and 11) ──
   What a person opens or closes is kept per tab for this browser tab (Sign Out forgets it, with the lists' filters),
   by the group's key — never its title. With a search or a filter on, every group with a match is open; what is
   closed or opened then is only for that search (CM_TEMP) and the kept choices are left alone. The rules are
   in clientMasterUi.js (openMap); this is only the keeping and the redraw. */
var CM_GRP_KEY = 'tdot_list_cases_groups';
var CM_OPEN = null;                       // { tab key: { group id: true | false } } — the kept choices
var CM_TEMP = { sig: null, map: {} };     // the choices under the search / filter now on
var CM_LAST = null;                       // the last draw: what a redraw after open / close needs
function cmKept() {
  if (CM_OPEN) return CM_OPEN;
  var raw = null;
  try { raw = JSON.parse(window.sessionStorage.getItem(CM_GRP_KEY) || 'null'); } catch (e) { raw = null; }
  CM_OPEN = CMU.normalizeKept(raw);
  return CM_OPEN;
}
function cmKeptSave() {
  if (window.TDOT_SIGNED_OUT) return;
  try { window.sessionStorage.setItem(CM_GRP_KEY, JSON.stringify(CM_OPEN || {})); } catch (e) {}
}
function cmGroupState(v, groups, st) {
  var filtered = CMU.hasUserFilter(st, 'view');
  var sig = filtered ? CMU.filterSig(st, 'view', v.key) : null;
  if (CM_TEMP.sig !== sig) CM_TEMP = { sig: sig, map: {} };   // another search or filter (or none): the temporary choices go
  return { filtered: filtered, open: CMU.openMap(v, groups, { kept: cmKept()[v.key], filtered: filtered, temp: CM_TEMP.map, today: cmToday() }) };
}
function cmSetOpen(ids, open) {
  var L = CM_LAST;
  if (!L) return;
  if (L.filtered) CM_TEMP.map = CMU.setOpen(CM_TEMP.map, ids, open);
  else { var k = cmKept(); k[L.v.key] = CMU.setOpen(k[L.v.key], ids, open); cmKeptSave(); }
  renderViewTable(L.v, L.rows, L.st, L.mondayOrder, L.total);
}
function cmGrpToggle(id) { var L = CM_LAST; if (L) cmSetOpen([String(id)], L.open[String(id)] !== true); }
function cmGrpAll(open) { var L = CM_LAST; if (L) cmSetOpen(L.ids, open === true); }
function cmGrpButton(id) {
  var list = document.querySelectorAll('#all-cases-body .cm-grp-b');
  for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-gk') === String(id)) return list[i];
  return null;
}
/* A stage count above Assigning: open that stage's group if it is closed, bring its heading into view, put the focus on it. */
function cmGrpGo(id) {
  var L = CM_LAST;
  if (!L) return;
  if (L.open[String(id)] !== true) cmSetOpen([String(id)], true);
  var b = cmGrpButton(id);
  if (!b) return;
  var calm = false;
  try { calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { calm = true; }
  try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
  try { b.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' }); } catch (e) { b.scrollIntoView(); }
}

/* The coloured bar on a group heading (the look only): the stage's status colour where the view groups by Case Stage;
   on the board's own groups, amber for the pending group and grey for the cancelled one; otherwise none (navy). */
function cmGroupTone(v, g) {
  var t = String((g && g.title) || '');
  if (v && v.by === 'stage') return ' tone-' + stageTone(t);
  if (/pending/i.test(t)) return ' tone-amber';
  if (/cancel/i.test(t)) return ' tone-grey';
  return '';
}

/* A tab's table: the groups (Monday's grouping; on All the board's own groups), each under a heading that opens and closes it.
   Inside a group: Monday's order on a view tab (unless a column sort is chosen — mondayOrder false), the engine's order on All.
   No pages. Only the rows of OPEN groups are drawn; the counts are of every matching row, open or closed.
   total (All only) = every case this person may see. */
function renderViewTable(v, rows, st, mondayOrder, total) {
  var isAll = v === CMU.ALL_VIEW;
  var ordered = mondayOrder ? CMU.viewOrder(v, rows) : rows;
  var groups = CMU.groupRows(v, ordered, (_data && _data.meta) || null);
  var tbody = document.getElementById('all-cases-body');
  // a view tab has its own, wider column set (2026-11-12): the table says so (Case Ref and Client stay in view while it scrolls sideways)
  var span = cmColIds(isAll ? null : v).length, tbl = document.getElementById('all-cases-table');
  if (tbl) tbl.className = 'data-table' + (isAll ? '' : ' cm-wide');
  // a redraw must not take the focus off a heading someone is on (open / close with the keyboard, new data)
  var act = document.activeElement, back = act && act.getAttribute && act.className === 'cm-grp-b' ? act.getAttribute('data-gk') : null;
  tbody.innerHTML = '';
  var inView = isAll ? total : cmInView(v.key);
  var gs = cmGroupState(v, groups, st);
  CM_LAST = { v: v, rows: rows, st: st, mondayOrder: mondayOrder, total: total, filtered: gs.filtered, open: gs.open,
    ids: groups.map(function(g) { return CMU.groupId(g.key); }) };
  renderCmHead(isAll ? null : v, rows, st, groups, inView);
  var oc = document.getElementById('cm-oc');
  if (oc) oc.style.display = rows.length ? '' : 'none';
  if (!rows.length) {
    var tr = document.createElement('tr');
    tr.className = 'cm-none';
    tr.innerHTML = '<td colspan="' + span + '"><span class="cm-none-t">' +
      (inView || isAll ? 'No cases match the current filters.' : 'No cases in the ' + escHtml(v.label) + ' view right now.') + '</span></td>';
    tbody.appendChild(tr);
    cmScrollBox(isAll);
    return { shown: 0, total: inView };
  }
  var today = cmToday(), deadlineTab = !!v.deadlineBox, rowView = isAll ? null : v;
  groups.forEach(function(g) {
    var gid = CMU.groupId(g.key), open = gs.open[gid] === true, tone = cmGroupTone(v, g), n = g.rows.length;
    var h = document.createElement('tr');
    h.className = 'cm-grp ' + (open ? 'open' : 'shut') + tone;
    var extra = '';
    if (deadlineTab) {
      var tc = CMU.typeCounts(g.rows);
      extra = ' <span class="cm-grp-c">— Real ' + tc.real + ' · Imaginary ' + tc.imaginary + ' · Not recorded ' + tc.none + '</span>';
    }
    h.innerHTML = '<td colspan="' + span + '"><span class="cm-grp-t">' +
      '<button type="button" class="cm-grp-b" data-gk="' + escHtml(gid) + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-label="' + escHtml(CMU.groupLabel(g.title, n, open)) + '">' +
      '<span class="cm-chev" aria-hidden="true"></span><span><b>' + escHtml(g.title) + '</b> · <span class="cm-grp-n">' + n + '</span></span></button>' + extra + '</span></td>';
    h.onclick = function() { cmGrpToggle(gid); };   // the whole heading line; Enter / Space on its button arrive here as a click too
    tbody.appendChild(h);
    if (!open) return;
    g.rows.forEach(function(c, i) {
      var r = caseRow(c, rowView, today);
      r.className = (r.className ? r.className + ' ' : '') + 'cm-in' + tone + (i === n - 1 ? ' cm-last' : '');
      tbody.appendChild(r);
    });
  });
  if (back !== null) { var nb = cmGrpButton(back); if (nb) { try { nb.focus({ preventScroll: true }); } catch (e) { nb.focus(); } } }
  cmScrollBox(isAll);
  return { shown: rows.length, total: inView };
}

/* The table's sideways scroll box as a keyboard stop (2026-11-12): on a view tab (the wide table) it is a named region that
   Tab reaches and the arrow keys scroll; on All only while the table is wider than its box. Otherwise it is a plain box again. */
function cmScrollBox(isAll) {
  var tbl = document.getElementById('all-cases-table'), w = tbl && tbl.parentNode;
  if (!w || !w.classList || !w.classList.contains('tbl-wrap')) return;
  w.classList.toggle('cm-scroll', !isAll);   // the room kept clear for the two pinned columns (view tabs only)
  if (!isAll || w.scrollWidth > w.clientWidth + 1) {
    w.setAttribute('tabindex', '0');
    w.setAttribute('role', 'region');
    w.setAttribute('aria-label', 'Cases table, scrolls sideways');
  } else {
    w.removeAttribute('tabindex');
    w.removeAttribute('role');
    w.removeAttribute('aria-label');
  }
}

/* Above the table, on a view tab only: the tab name + the data time + Print, the Filtered line,
   then Assigning's stage counts (buttons that go to the stage's group) and no-officer line, or the half-month windows (Deadlines). */
function renderCmHead(v, rows, st, groups, inView) {
  var el = document.getElementById('cm-head');
  if (!el) return;
  if (!v) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  var h = '<div class="cm-top"><span class="cm-title">' + escHtml(v.label) + '</span>' +
    '<span class="cm-dataat" id="cm-dataat">' + escHtml(cmDataTimeText(_data)) + '</span>' +
    '<button type="button" class="cm-print" id="cm-print" onclick="window.print()" title="Print this view (landscape)">🖨 Print</button></div>';
  var fl = CMU.filteredLine(rows.length, inView, CMU.hasUserFilter(st, 'view'));
  if (fl) h += '<div class="cm-filtered" id="cm-filtered">' + escHtml(fl.text) + '<span class="cm-clear-w"> · <button type="button" class="cm-clear" id="cm-clear" onclick="CasesTable.clearFilters()">Clear filters</button></span></div>';
  if (_data && _data.viewer && _data.viewer.scope === 'assigned') h += '<div class="cm-note">Showing only your cases; ask an admin to see everyone’s.</div>';
  if (v.stageStrip) {
    // each stage count is a button (2026-11-12): it opens that stage's group and goes to its heading
    h += '<div class="cm-strip" id="cm-strip" role="group" aria-label="Cases by stage: press a stage to go to its group">' + (groups || []).map(function(g) {
      return '<button type="button" class="cm-st' + (typeof cmGroupTone === 'function' ? cmGroupTone(v, g) : '') + '" data-go="' + escHtml(CMU.groupId(g.key)) + '" onclick="cmGrpGo(this.dataset.go)" title="Go to this group in the table (opens it if it is closed)">' + escHtml(g.title) + ' <b>' + g.rows.length + '</b></button>';
    }).join('') + '</div>';
    var no = CMU.noOfficerCount(rows, CM_PRE_ONBOARDING);
    h += '<div class="cm-line" id="cm-noofficer">No Support Officer: <b>' + no.n + '</b>' + (no.preOnboarding ? ' (' + no.preOnboarding + ' of them Pre-Onboarding)' : '') + '</div>';
    // Pre-Onboarding — waiting for (2026-11-10): counted from the rows on screen, like the stage counts; read-only
    var wc = CMU.waitingCounts(rows, CM_PRE_ONBOARDING);
    if (wc.total) {
      var wAt = cmHm((_data && _data.waitingAt) || '');
      h += '<div class="cm-strip cm-waitstrip" id="cm-waiting" role="group" aria-label="Pre-Onboarding cases: what each is waiting for">' +
        '<span class="cm-wait-lead">Pre-Onboarding — waiting for:</span>' + wc.list.map(function(x) {
          return '<span class="cm-st" data-wait="' + escHtml(x.code) + '">' + escHtml(x.label) + ' <b>' + x.n + '</b></span>';
        }).join('') +
        (wc.partPaid ? '<span class="cm-wait-at">' + wc.partPaid + ' with a part-payment recorded</span>' : '') +
        (wAt ? '<span class="cm-wait-at" id="cm-waiting-at" title="When the client records (signatures and payments) were last read. They can be a few minutes behind Monday.">Client records from ' + escHtml(wAt) + '</span>' : '') +
        '</div>';
    }
  }
  if (v.deadlineBox) {
    var box = CMW.windowsBox(rows, cmToday());
    if (box) {
      h += '<div class="cm-wins" id="cm-wins" role="group" aria-label="Half-month windows">' + box.windows.map(function(w, i) {
        return '<div class="cm-win-box' + (i === 0 ? ' now' : '') + '" data-win="' + escHtml(w.key) + '"><div class="cm-win-l">' + (i === 0 ? 'Now · ' : '') + escHtml(w.label) + ' · <b>' + w.total + '</b></div>' +
          '<div class="cm-win-n">Real ' + w.real + ' · Imaginary ' + w.imaginary + ' · Not recorded ' + w.none + '</div></div>';
      }).join('') +
      '<div class="cm-win-box rest"><div class="cm-win-n">Later <b data-n="later">' + box.later + '</b> · Earlier dates <b data-n="earlier">' + box.earlier + '</b> · No date <b data-n="nodate">' + box.noDate + '</b></div></div>' +
      '</div>';
    }
  }
  el.innerHTML = h;
}

/* The columns of a tab, in order: v = the view tab, null on All. */
function cmColIds(v) { return CM_TABCOLS[v ? v.key : ''] || CM_TABCOLS['']; }
/* A view-tab cell of plain text: "—" when blank; clip = long text is cut to two lines (the whole text is in the title). */
function cmTextCell(cls, text, clip) {
  var t = String(text == null ? '' : text).trim();
  if (!t) return '<td class="' + cls + '">' + cmNoneDash() + '</td>';
  return '<td class="' + cls + '"' + (clip ? ' title="' + escHtml(t) + '"' : '') + '>' + (clip ? '<span class="cm-clip">' + escHtml(t) + '</span>' : escHtml(t)) + '</td>';
}
/* A view-tab percentage: "—" when the board cell is empty (never a made-up 0%). */
function cmPctCell(cls, n) {
  return '<td class="' + cls + ' cm-pct">' + (typeof n === 'number' && isFinite(n) ? Math.round(n) + '%' : cmNoneDash()) + '</td>';
}
/* Client portal: a short link that opens the client's own portal page in a new tab. The address carries the client's
   access token, so it is never shown as text, never logged and never asked for by this page — it is only the link's target,
   and the new tab is told nothing about this page (noopener noreferrer). Anything that is not a web address shows "—". */
function cmPortalCell(c) {
  var u = String(c.portalLink == null ? '' : c.portalLink).trim();
  if (!/^https?:[/][/]/i.test(u)) return '<td class="cm-c-portal">' + cmNoneDash() + '</td>';
  return '<td class="cm-c-portal"><a class="cm-portal" href="' + escHtml(u) + '" target="_blank" rel="noopener noreferrer" title="Open this client’s portal in a new tab" aria-label="Open the client portal of ' + escHtml(c.clientName || c.caseRef || 'this case') + ' in a new tab">Open</a></td>';
}

/* One case row. v = the view tab (null on All): there an empty Case Stage and an empty Manager show "—",
   as Monday shows a blank, and the Deadlines tab shows the two flags with the Internal deadline.
   All keeps the columns it has always had; a view tab draws the agreed list, one column each (cmColIds). */
function caseRow(c, v, today) {
  var r = c.overallReadiness || 0;
  var barCls = r >= 70 ? '' : (r >= 40 ? ' mid' : ' low');
  var tr = document.createElement('tr');
  tr.className = c.health === 'Red' ? 'row-red' : (c.health === 'Orange' ? 'row-orange' : '');
  if (c.caseRef) {
    tr.style.cursor = 'pointer';
    tr.title = 'Open case cockpit';
    tr.onclick = function() { window.location.href = '/admin/case/' + encodeURIComponent(c.caseRef); };
  } else {
    tr.title = 'No case reference yet — set the Case Type on this item in Monday and the reference (and cockpit) is created automatically.';
  }
  // No reference = the cockpit can't open. Say WHY and what unblocks it,
  // instead of a silent dash: missing Case Type is the usual cause (the
  // reference is derived from it); if the type IS set, assignment is just
  // pending (caseRefService runs off the Case Type webhook).
  var refCell;
  if (c.caseRef) {
    refCell = escHtml(c.caseRef);
  } else if (!c.caseType || c.caseType === 'Unknown') {
    refCell = '<span class="badge orange">Needs Case Type</span>';
  } else {
    refCell = '<span class="badge blue">Ref pending</span>';
  }
  var stage = v && (typeof c.stageIdx !== 'number' || c.stageIdx === CMU.EMPTY) ? cmNoneDash() : escHtml(c.caseStage);
  // Waiting for (2026-11-10): on Assigning only, and only on a Pre-Onboarding row (the server sends it for no other stage).
  // A second line under the stage, in words; what comes after is visible too (a phone has no hover).
  if (v && v.stageStrip && c.waiting) {
    var ww = CMU.waitingWords(c.waiting);
    stage += '<div class="cm-wait' + (ww.code === 'ready' || ww.code === 'unclear' ? ' flag' : ww.code === 'unchecked' ? ' dim' : '') + '" data-wait="' + escHtml(ww.code) + '" title="' + escHtml(ww.tip) + '">' +
      (ww.lead ? escHtml(ww.lead) + ' ' : '') + '<b>' + escHtml(ww.label) + '</b>' +
      (ww.then ? '<span class="cm-wait-n">' + escHtml(ww.then) + '</span>' : '') +
      (ww.extra ? '<span class="cm-wait-n">' + escHtml(ww.extra) + '</span>' : '') + '</div>';
  }
  var mgr = v && (!c.manager || c.manager === 'Unassigned') ? cmNoneDash() : escHtml(c.manager);
  // Deadline: the type (Real / Imaginary), the Actual Deadline, and the half-month window the row is counted in
  var t = CMW.typeOf(c);
  var typeTag = t === 'real' ? '<span class="cm-type real" title="Deadline Type: Deadline (a real deadline)">Real</span>'
    : t === 'imaginary' ? '<span class="cm-type imag" title="Deadline Type: Imaginary (a date we promised, not a real deadline)">Imaginary</span>' : '';
  var win = CMW.windowOf(CMW.bucketDate(c));
  var dl = typeTag + (c.actualDeadline ? ' <span class="cm-date">' + escHtml(cmDay(c.actualDeadline)) + '</span>' : '') +
    (win ? ' <span class="cm-win" title="Counted in this half-month window' + (t === 'imaginary' ? ' (by the promised date)' : '') + '">' + escHtml(win.label) + '</span>' : '');
  // Change… (2026-11-10): on the Deadlines tab only, and only where the server says the write is allowed
  // (a Monday sign-in who may see the case). An offer on the row — nothing asks for old cases to be filled.
  var dlBtn = (v && v.key === 'deadlines' && c.canChangeDeadline)
    ? ' <button type="button" class="dlc-btn" data-dl="' + escHtml(String(c.id)) + '" title="Change this case’s deadline (a reason is needed; a note is added on the case)">Change…</button>' : '';
  var dlOk = cmDlFlashText(c.id) ? ' <span class="dlc-ok" data-dl-ok="' + escHtml(String(c.id)) + '" role="status">' + escHtml(cmDlFlashText(c.id)) + '</span>' : '';
  // Promised: the Internal Deadline, and on Deadlines the flag (display only — nothing is changed)
  var pr = c.promisedDate ? '<span class="cm-date">' + escHtml(cmDay(c.promisedDate)) + '</span>' : '';
  if (v && v.deadlineBox) {
    var f = CMW.flagOf(c, today);
    if (f) pr += ' <span class="cm-flag ' + f.kind + '" data-flag="' + f.kind + '" title="' + escHtml(f.tip) + '">' + escHtml(f.label) + '</span>';
  }
  var off = (c.officer ? escHtml(c.officer) : '<span style="color:var(--light);font-size:11px">Nobody</span>') +
    // Assign… (block 3): only where the server says the write is allowed (a Monday sign-in; the access check on that person)
    (c.canAssign ? ' <button type="button" class="cm-assign" data-assign="' + escHtml(String(c.id)) + '" title="Set the Case Support Officer in Monday (replaces who is there now; a note is added on the case)">Assign…</button>' : '') +
    (cmFlashText(c.id) ? ' <span class="cm-asg-ok" data-asg-ok="' + escHtml(String(c.id)) + '" role="status">' + escHtml(cmFlashText(c.id)) + '</span>' : '');
  var del = '<td class="cm-del">' + (window.TDOT_IS_ADMIN && c.caseRef
      ? '<button class="del-btn" type="button" data-del-case="' + escHtml(c.caseRef) + '" title="Delete this case (careful — removes its Monday rows; the consultation record and the OneDrive folder are kept)">' + TDOT_DEL_SVG + '</button>'
      : '') + '</td>';
  var cells = v ? {
    // ── a view tab: Case Ref and Client stay in view while the table scrolls sideways (cm-pin) ──
    caseRef: '<td class="cm-pin cm-pin1"' + (c.caseRef ? ' title="' + escHtml(c.caseRef) + '"' : '') + '>' + refCell + '</td>',
    clientName: '<td class="cm-pin cm-pin2" title="' + escHtml(c.clientName) + '"><span class="cm-ell">' + escHtml(c.clientName) + '</span></td>',
    dependents: cmTextCell('cm-c-dep', c.dependents, true),
    clientEmail: cmTextCell('cm-c-email', c.clientEmail, true),
    clientPhone: cmTextCell('cm-c-phone', c.clientPhone, false),
    caseTypeV: cmTextCell('cm-c-type', c.caseType === 'Unknown' ? '' : c.caseType, true),
    subType: cmTextCell('cm-c-sub', c.caseSubType, true),
    // the Actual Deadline with its half-month window; Change… on Deadlines
    actualDeadline: '<td class="cm-dl">' + ((c.actualDeadline ? '<span class="cm-date">' + escHtml(cmDay(c.actualDeadline)) + '</span>' : '') +
      (win ? ' <span class="cm-win" title="Counted in this half-month window' + (t === 'imaginary' ? ' (by the promised date)' : '') + '">' + escHtml(win.label) + '</span>' : '') || cmNoneDash()) + dlBtn + dlOk + '</td>',
    deadlineType: '<td class="cm-c-dt">' + (typeTag || cmNoneDash()) + '</td>',
    internalDeadline: '<td class="cm-pr">' + (pr || cmNoneDash()) + '</td>',
    phaseV: cmTextCell('cm-c-phase', c.phase, false),
    retainedBy: cmTextCell('cm-c-ret', c.retainedBy, false),
    retainerStatus: cmTextCell('cm-c-rs', c.retainerStatus, false),
    paymentStatus: cmTextCell('cm-c-pay', c.paymentStatus, false),
    stageV: '<td class="cm-c-stage">' + stage + '</td>',
    portal: cmPortalCell(c),
    officerV: '<td class="cm-off">' + off + '</td>',
    managerV: '<td class="cm-c-mgr">' + mgr + '</td>',
    qPct: cmPctCell('cm-c-q', c.qReadinessPct),
    docPct: cmPctCell('cm-c-doc', c.docUploadedPct)
  } : {
    // ── the All tab: as it has always been ──
    caseRef: '<td style="font-weight:600;color:var(--navy);white-space:nowrap">' + refCell + '</td>',
    clientName: '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(c.clientName) + '</td>',
    caseType: '<td style="color:var(--muted);font-size:11px">' + shortType(c.caseType) + '</td>',
    caseStage: '<td style="font-size:11px">' + stage + '</td>',
    phase: '<td style="font-size:11px;white-space:nowrap">' + (c.phase ? escHtml(c.phase) : cmNoneDash()) + '</td>',
    deadline: '<td class="cm-dl" style="font-size:11px">' + (dl || cmNoneDash()) + dlBtn + dlOk + '</td>',
    promised: '<td class="cm-pr" style="font-size:11px">' + (pr || cmNoneDash()) + '</td>',
    health: '<td>' + healthBadge(c.health) + '</td>',
    slaRisk: '<td>' + healthBadge(c.slaRisk) + '</td>',
    officer: '<td class="cm-off" style="font-size:11px">' + off + '</td>',
    manager: '<td style="color:var(--muted);font-size:11px">' + mgr + '</td>',
    overallReadiness: '<td>' +
      '<div class="readiness-bar">' +
        '<div class="r-bar-bg"><div class="r-bar-fill' + barCls + '" style="width:' + r + '%"></div></div>' +
        '<span class="r-bar-pct">' + r + '%</span>' +
      '</div>' +
    '</td>',
    daysElapsed: '<td style="text-align:center;font-weight:600;color:var(--muted)">' + (c.daysElapsed || 0) + '</td>',
    status: '<td>' +
      (c.clientBlocked      ? '<span class="badge orange" style="margin-right:3px">Blocked</span>' : '') +
      (c.escalationRequired ? '<span class="badge red" style="margin-right:3px">Esc</span>'       : '') +
      (c.expiryFlagged      ? '<span class="badge blue">Expiry</span>'                            : '') +
      (!c.clientBlocked && !c.escalationRequired && !c.expiryFlagged ? '<span style="color:var(--light);font-size:11px">—</span>' : '') +
    '</td>',
    // Delete is ADMIN-ONLY (the server enforces it; hiding it here keeps the
    // control honest for assigned-scope staff) and needs a case reference.
    del: del
  };
  tr.innerHTML = cmColIds(v).map(function(id) { return cells[id] || '<td></td>'; }).join('');
  // the portal link never opens the case (the row's own click does that)
  var pl = tr.querySelector('.cm-portal');
  if (pl) pl.onclick = function(e) { e.stopPropagation(); };
  var ab = tr.querySelector('.cm-assign');
  // the button never opens the case (the row's own click does that)
  if (ab) ab.onclick = function(e) { e.stopPropagation(); cmAssignDlg(String(c.id)); };
  var db = tr.querySelector('.dlc-btn');
  if (db) db.onclick = function(e) { e.stopPropagation(); cmDeadlineDlg(String(c.id)); };
  return tr;
}

/* ── Assign the Case Support Officer (block 3) ───────────────────────
   The standard pop-up: who is there now, the staff list (people usually assigned first), what will happen.
   The server writes ONE Monday column (Case Support Officer), replacing it, and adds a note on the case.
   The row is updated in place: the tab, the filters, the page and the scroll stay. */
var CM_STAFF = null;     // the staff list, read once for this page (the server keeps it an hour)
var CM_FLASH = {};       // item id → { text, until }: "✓ Assigned" beside the name for a few seconds
function cmFlashText(id) { var f = CM_FLASH[String(id)]; return f && f.until > Date.now() ? f.text : ''; }
function cmFlash(id, text) {
  id = String(id);
  CM_FLASH[id] = { text: text, until: Date.now() + 6000 };
  setTimeout(function() {
    if (CM_FLASH[id] && CM_FLASH[id].until <= Date.now()) delete CM_FLASH[id];
    var e = document.querySelector('.cm-asg-ok[data-asg-ok="' + id + '"]');
    if (e && !cmFlashText(id) && e.parentNode) e.parentNode.removeChild(e);
  }, 6100);
}
function cmRowById(id) { var a = (_data && _data.cases) || []; for (var i = 0; i < a.length; i++) if (String(a[i].id) === String(id)) return a[i]; return null; }
function cmIdsOf(c) { var o = (c && c.officerIds) || {}; return { personIds: (o.personIds || []).map(String), teamIds: (o.teamIds || []).map(String) }; }
function cmNamesOf(c) { return String((c && c.officer) || '').split(',').map(function(x) { return x.trim(); }).filter(Boolean); }
function cmAnd(list) { return list.length < 2 ? (list[0] || '') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]; }
function cmAsgHeaders(json) { var k = peekKey(), h = k ? { 'X-Api-Key': k } : {}; if (json) h['Content-Type'] = 'application/json'; return h; }
function cmAsgSignIn(j) {
  var login = ((j && j.loginUrl) || '/q/auth/monday').split('?')[0] + '?returnTo=' + encodeURIComponent(location.pathname + location.search);
  return escHtml((j && j.error) || 'Please sign in with Monday.') + ' <a href="' + escHtml(login) + '">Sign in with Monday</a>';
}
/* The row's officer, from the server's answer (the read-back, or the value now on Monday); the list redraws in place.
   canAssign false = this person may no longer assign this case (they took themselves off it while only their cases are shown). */
function cmAsgApply(itemId, off, canAssign) {
  var row = cmRowById(itemId);
  if (!row || !off) return;
  row.officer = (off.names || []).join(', ');
  row.officerIds = { personIds: (off.personIds || []).map(String), teamIds: (off.teamIds || []).map(String) };
  if (canAssign === false) row.canAssign = false;
  CasesTable.setRows(_data.cases);
}
function cmAssignDlg(itemId) {
  var row = cmRowById(itemId);
  if (!row) return;
  var st = { itemId: String(itemId), expected: cmIdsOf(row), names: cmNamesOf(row) };
  var c = tdotDialogNew({ cls: 'cm-asg-dlg', group: 'cm-asg', labelledBy: 'cm-asg-h' });
  c.box.innerHTML = '<h3 id="cm-asg-h">Assign a Case Support Officer</h3>' +
    '<div class="cm-asg-case"><b>' + escHtml(row.caseRef || 'No case number yet') + '</b> · ' + escHtml(row.clientName || '') + '</div>' +
    '<div class="cm-asg-now" id="cm-asg-now"></div>' +
    '<label class="cm-asg-lbl" for="cm-asg-sel">New Case Support Officer</label>' +
    '<select id="cm-asg-sel" class="cm-asg-sel" disabled><option value="">Loading the staff list…</option></select>' +
    '<div class="cm-asg-what">Replaces the Case Support Officer in Monday and adds a note on the case. Nothing else changes.</div>' +
    '<div class="cm-asg-rm" id="cm-asg-rm"></div>' +
    '<div class="cm-asg-tell" id="cm-asg-tell"></div>' +
    '<div class="tdlg-err" id="cm-asg-err" role="alert"></div>' +
    '<div class="tdlg-actions" id="cm-asg-acts"><button type="button" class="tdlg-btn" data-x="1" id="cm-asg-cancel">Cancel</button><button type="button" class="tdlg-btn primary" id="cm-asg-go">Assign</button></div>';
  var sel = c.box.querySelector('#cm-asg-sel');
  st.sel = sel;
  c.box.querySelector('#cm-asg-cancel').onclick = function() { c.tryClose('cancel'); };
  c.box.querySelector('#cm-asg-go').onclick = function() { cmAsgSend(c, st); };
  sel.onchange = function() { cmAsgSync(c, st); };
  cmAsgSync(c, st);
  var id = c.openId;
  if (CM_STAFF) { cmAsgFill(c, st); return; }
  fetch('/admin/client-master/assignable-users', { headers: cmAsgHeaders(false), credentials: 'same-origin' })
    .then(function(r) { return r.json().catch(function() { return {}; }).then(function(j) { return { ok: r.ok && j.ok, status: r.status, j: j }; }); })
    .then(function(res) {
      if (!c.still(id)) return;
      if (!res.ok) {
        sel.innerHTML = '<option value="">The staff list could not be loaded</option>';
        c.box.querySelector('#cm-asg-err').innerHTML = res.status === 401 ? cmAsgSignIn(res.j) : escHtml((res.j && res.j.error) || 'The staff list could not be loaded. Close this and try again.');
        cmAsgSync(c, st);
        return;
      }
      CM_STAFF = res.j.users || [];
      cmAsgFill(c, st);
    })
    .catch(function() {
      if (!c.still(id)) return;
      sel.innerHTML = '<option value="">The staff list could not be loaded</option>';
      c.box.querySelector('#cm-asg-err').textContent = 'The staff list could not be loaded (no answer). Close this and try again.';
      cmAsgSync(c, st);
    });
}
/* The list: people who are Support Officers on other cases first ("usually assigned"), then everyone else; A → Z in each. */
function cmAsgFill(c, st) {
  var usual = {};
  ((_data && _data.cases) || []).forEach(function(r) { cmIdsOf(r).personIds.forEach(function(p) { usual[p] = true; }); });
  var a = [], b = [];
  (CM_STAFF || []).forEach(function(u) { (usual[String(u.id)] ? a : b).push(u); });
  var opt = function(u) { return '<option value="' + escHtml(String(u.id)) + '">' + escHtml(u.name) + '</option>'; };
  st.sel.innerHTML = '<option value="">Choose a person…</option>' +
    (a.length ? '<optgroup label="Usually assigned">' + a.map(opt).join('') + '</optgroup>' : '') +
    (b.length ? '<optgroup label="' + (a.length ? 'Everyone else' : 'Staff') + '">' + b.map(opt).join('') + '</optgroup>' : '');
  st.sel.disabled = false;
  cmAsgSync(c, st);
  try { st.sel.focus(); } catch (e) {}
}
function cmAsgChosen(st) {
  var v = st.sel && st.sel.value;
  if (!v) return null;
  for (var i = 0; i < (CM_STAFF || []).length; i++) if (String(CM_STAFF[i].id) === v) return CM_STAFF[i];
  return null;
}
/* The Now line, who will be removed (two or more there now), who Monday will tell, and the Assign button. */
function cmAsgSync(c, st) {
  var box = c.box, ch = cmAsgChosen(st), n = st.expected.personIds.length + st.expected.teamIds.length;
  box.querySelector('#cm-asg-now').innerHTML = 'Now: <b>' + escHtml(st.names.length ? st.names.join(', ') : 'Nobody') + '</b>';
  var rm = '';
  if (n >= 2) {
    if (!ch) rm = 'There are ' + n + ' on this case now. The one you choose replaces all of them.';
    else {
      // who stays is decided by the id; the names are Monday's own text for the cell
      var at = st.expected.personIds.indexOf(String(ch.id)), keep = at >= 0;
      var gone = st.names.filter(function(x) { return x !== ch.name; });
      if (keep && gone.length === st.names.length && !st.expected.teamIds.length && st.names.length === st.expected.personIds.length) {
        gone = st.names.filter(function(x, i) { return i !== at; });   // the name is spelled differently on the cell: drop it by its place
      }
      rm = 'This removes ' + cmAnd(gone) + (keep ? ' and keeps ' : ' and sets ') + ch.name + '.';
    }
  }
  box.querySelector('#cm-asg-rm').textContent = rm;
  box.querySelector('#cm-asg-tell').textContent = ch ? 'Monday will tell ' + ch.name + ' they were assigned.' : 'Monday will tell the person you choose that they were assigned.';
  // not a data-x button: the long-wait timer that lets Cancel and × close the pop-up must never let Assign be sent twice
  var go = box.querySelector('#cm-asg-go');
  if (go) go.disabled = !!c.busy || !ch;
}
function cmAsgSend(c, st) {
  var ch = cmAsgChosen(st), err = c.box.querySelector('#cm-asg-err');
  if (!ch) { err.textContent = 'Choose a person first.'; return; }
  err.textContent = '';
  c.setBusy(true);
  st.sel.disabled = true;
  cmAsgSync(c, st);
  var id = c.openId, itemId = st.itemId;
  var done = function() { if (!c.still(id)) return false; c.setBusy(false); st.sel.disabled = false; cmAsgSync(c, st); return true; };
  fetch('/admin/client-master/assign', { method: 'POST', headers: cmAsgHeaders(true), credentials: 'same-origin',
    body: JSON.stringify({ itemId: itemId, userId: String(ch.id), expected: st.expected }) })
    .then(function(r) { return r.json().catch(function() { return {}; }).then(function(j) { return { ok: r.ok && j.ok, status: r.status, j: j }; }); })
    .then(function(res) {
      var j = res.j || {};
      if (res.ok) {
        // the row follows what Monday kept, even when the pop-up was closed after the long wait
        cmFlash(itemId, j.unchanged ? 'No change needed' : '✓ Assigned');
        cmAsgApply(itemId, j.officer, j.canAssign);
        if (!c.still(id)) return;
        if (j.noteFailed) {
          c.setBusy(false);
          c.box.querySelector('#cm-asg-sel').disabled = true;
          err.textContent = 'Assigned. The note may not have been added — check the case’s updates before adding it by hand.';
          c.box.querySelector('#cm-asg-acts').innerHTML = '<button type="button" class="tdlg-btn primary" id="cm-asg-close">Close</button>';
          c.box.querySelector('#cm-asg-close').onclick = function() { c.tryClose('cancel'); };
          return;
        }
        c.close(true, 'done');
        // focus goes back to the row's (redrawn) Assign button
        var nb = document.querySelector('.cm-assign[data-assign="' + itemId + '"]');
        if (nb) { try { nb.focus(); } catch (e) {} }
        return;
      }
      if (res.status === 409 && j.code === 'changed' && j.current) {
        // Monday has someone else now: the row and the pop-up show it, and Assign asks again with the new value
        cmAsgApply(itemId, j.current);
        if (!c.still(id)) return;
        st.expected = { personIds: (j.current.personIds || []).map(String), teamIds: (j.current.teamIds || []).map(String) };
        st.names = (j.current.names || []).slice();
        done();
        err.textContent = (j.error || 'This changed since your page loaded.') + ' Press Assign again to replace it.';
        return;
      }
      if (!done()) return;
      if (res.status === 401) { err.innerHTML = cmAsgSignIn(j); return; }
      err.textContent = j.error || ('Something went wrong (' + res.status + '). The result is unknown — check the case before trying again.');
    })
    .catch(function() {
      if (!done()) return;
      err.textContent = 'No answer — the result is unknown. Check the case before trying again.';
    });
}

/* ── Change the client deadline (2026-11-10) ─────────────────────────
   The shared pop-up (deadlineChangeUi.js). The server writes the case's three deadline cells and the linked
   lead, and adds a note on the case. The row is updated in place and the list redraws from the rows, so the
   window, the Real / Imaginary / Not recorded counts and the "May slide" flag follow at once — no board re-read. */
var CM_DL_FLASH = {};    // item id → { text, until }: "✓ Deadline saved" in the Deadline cell for a few seconds
function cmDlFlashText(id) { var f = CM_DL_FLASH[String(id)]; return f && f.until > Date.now() ? f.text : ''; }
function cmDlFlash(id, text) {
  id = String(id);
  CM_DL_FLASH[id] = { text: text, until: Date.now() + 6000 };
  setTimeout(function() {
    if (CM_DL_FLASH[id] && CM_DL_FLASH[id].until <= Date.now()) delete CM_DL_FLASH[id];
    var e = document.querySelector('.dlc-ok[data-dl-ok="' + id + '"]');
    if (e && !cmDlFlashText(id) && e.parentNode) e.parentNode.removeChild(e);
  }, 6100);
}
/* The row's deadline from the server's answer (the row's field for the promised date is promisedDate). */
function cmDlApply(itemId, d) {
  var row = cmRowById(itemId);
  if (!row || !d) return;
  row.deadlineType = String(d.type || '');
  row.actualDeadline = String(d.actualDeadline || '');
  row.promisedDate = String(d.promisedSubmissionDate || '');
  CasesTable.setRows(_data.cases);
}
function cmDeadlineDlg(itemId) {
  var row = cmRowById(itemId);
  if (!row || typeof tdotDeadlineChange !== 'function') return;
  tdotDeadlineChange({
    url: '/admin/client-master/deadline',
    itemId: String(itemId),
    caseLine: (row.caseRef || 'No case number yet') + ' · ' + (row.clientName || ''),
    current: { type: row.deadlineType || '', actualDeadline: row.actualDeadline || '', promisedSubmissionDate: row.promisedDate || '' },
    onSaved: function(d, j) { cmDlFlash(itemId, j && j.unchanged && !j.noted ? 'No change needed' : '✓ Deadline saved'); cmDlApply(itemId, d); },
    onCurrent: function(cur) { cmDlApply(itemId, cur); },
    focusBack: function() { var nb = document.querySelector('.dlc-btn[data-dl="' + String(itemId) + '"]'); if (nb) nb.focus(); }
  });
}

/* ── Helpers ──────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function healthBadge(h) {
  var cls = h === 'Red' ? 'red' : (h === 'Orange' ? 'orange' : 'green');
  return '<span class="badge ' + cls + '">' + escHtml(h || 'Green') + '</span>';
}

function daysAgoLabel(dateStr) {
  if (!dateStr) return '—';
  var d = new Date(dateStr);
  if (isNaN(d)) return '—';
  var days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return '1d ago';
  return days + 'd ago';
}

function formatDeadline(dateStr) {
  if (!dateStr) return '—';
  var d = new Date(dateStr);
  if (isNaN(d)) return '—';
  var daysUntil = Math.floor((d.getTime() - Date.now()) / 86400000);
  var label = escHtml(d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }));
  if (daysUntil < 0)   return '<span style="color:#dc2626;font-weight:700">' + label + ' \u26a0</span>';
  if (daysUntil <= 7)  return '<span style="color:#ea580c;font-weight:700">' + label + '</span>';
  if (daysUntil <= 30) return '<span style="color:#b45309">' + label + '</span>';
  return label;
}

function shortType(t) {
  if (!t) return '—';
  var map = {
    'Canadian Experience Class': 'CEC',
    'Federal Skilled Worker':    'FSW',
    'Visitor Visa':              'Visitor Visa',
    'Study Permit':              'Study Permit',
    'Work Permit':               'Work Permit',
    'Spousal Sponsorship':       'Spousal Spon.',
    'Provincial Nominee':        'PNP',
    'Permanent Resident':        'PR',
    'Citizenship':               'Citizenship',
  };
  for (var k in map) { if (t.startsWith(k)) return map[k]; }
  // Fallback: truncate then HTML-escape so raw case type can't inject markup
  var s = t.length > 22 ? t.slice(0, 20) + '…' : t;
  return escHtml(s);
}

/* ── Needs attention (Summary view only) ──────────────────────────── */
// The list is worked out on the server (07:00 Toronto daily, or "Check now");
// this only shows it. No backslashes, backticks or dollar-braces in here: the
// whole script sits inside the page's template literal.
var _na = null, _naTimer = null, _naShowAll = {}, _naFlashTimer = null;
var _naBusy = {};      // keys with an open "Mark handled" confirm: a poll never redraws over them
var _naDone = {};      // keys marked handled on this page (kept off the list until the server agrees)
var _naSig = '';       // the list last drawn (check time + keys): an unchanged poll leaves the rows alone
var _naDirty = false;  // a redraw is waiting for the open confirm to close
var NA_SEV = { high: 'Urgent', medium: 'To do', low: 'Check' };

function naHeaders(json) {
  var k = peekKey();
  var h = k ? { 'X-Api-Key': k } : {};
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function naBusyCount() {
  var n = 0;
  for (var k in _naBusy) if (_naBusy[k]) n++;
  return n;
}

function naLoad() {
  if (_naTimer) { clearTimeout(_naTimer); _naTimer = null; }
  return fetch('/admin/needs-attention', { headers: naHeaders(false), credentials: 'same-origin' })
    .then(function(r) {
      if (r.status === 401) throw new Error('please sign in again');
      if (!r.ok) throw new Error('the server answered ' + r.status);
      return r.json();
    })
    .then(function(d) {
      d.entries = (d.entries || []).filter(function(e) { return !_naDone[e.key]; });
      _na = d;
      naRender(false);
      if (d.running) _naTimer = setTimeout(naLoad, 5000);
    })
    .catch(function(e) {
      var btn = document.getElementById('na-check');
      if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }
      naSetNote('err', ['The list could not be loaded (' + e.message + '). Press Refresh to try again.']);
      if (!_na) document.getElementById('na-body').innerHTML = '<div class="na-empty">No list yet.</div>';
    });
}

// Only touches the DOM when the text changes, so a screen reader is not told
// the same thing every five seconds while a check runs.
function naSetNote(kind, lines) {
  var el = document.getElementById('na-note');
  if (!el) return;
  var html = lines.map(function(l) { return '<div>' + escHtml(l) + '</div>'; }).join('');
  var cls = 'na-note' + (kind ? ' ' + kind : '');
  if (el.innerHTML === html && el.className === cls && el.hidden === !lines.length) return;
  el.className = cls;
  el.innerHTML = html;
  el.hidden = !lines.length;
}

function naFlash(text, kind) {
  var el = document.getElementById('na-flash');
  if (!el) return;
  el.className = 'na-flash' + (kind === 'err' ? ' err' : '');
  el.textContent = text;
  if (_naFlashTimer) clearTimeout(_naFlashTimer);
  _naFlashTimer = null;
  if (kind !== 'err') _naFlashTimer = setTimeout(function() { el.textContent = ''; }, 8000);
}

function naDay(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/Toronto' }); }
// Whole Toronto calendar days since 1970 (so "yesterday at 23:30" is 1 day ago, not "today").
function naDayNumber(d) {
  var p = d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).split('-');
  return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}

function naWhen(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
  return (naDayNumber(d) === naDayNumber(new Date()) ? 'today' : naDay(d)) + ' at ' + time;
}

function naSince(iso) {
  var t = Date.parse(iso || '');
  if (!t) return null;
  var d = new Date(t);
  var days = naDayNumber(new Date()) - naDayNumber(d);
  return {
    day: naDay(d),
    full: d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' }) + ' (Toronto)',
    age: days <= 0 ? 'today' : (days === 1 ? '1 day' : days + ' days')
  };
}

function naItemHtml(e) {
  var who = e.caseRef
    ? '<a class="na-ref" href="/admin/case/' + encodeURIComponent(e.caseRef) + '" title="Open the case page">' + escHtml(e.caseRef) + '</a>'
    : '<span class="na-noref">No case number</span>';
  var meta = [];
  if (e.stage) meta.push(e.stage);
  if (e.manager) meta.push('Case manager: ' + e.manager);
  var since = naSince(e.since);
  return '<li class="na-item" data-na-key="' + escHtml(e.key) + '">' +
    '<div class="na-who">' + who + '<span class="na-client">' + escHtml(e.client) + '</span>' +
      (meta.length ? '<span class="na-meta">' + escHtml(meta.join(' · ')) + '</span>' : '') + '</div>' +
    '<div class="na-text"><p class="na-why">' + escHtml(e.why) + '</p>' +
      '<p class="na-todo"><span class="na-todo-lbl">What to do:</span> ' + escHtml(e.todo) + '</p></div>' +
    '<div class="na-side">' +
      (since ? '<span class="na-since" title="' + escHtml(since.full) + '">Since <b>' + escHtml(since.day) + '</b> · ' + escHtml(since.age) + '</span>' : '') +
      '<span class="na-act"><button type="button" class="na-btn" onclick="naAskHandled(this)">Mark handled</button></span>' +
    '</div>' +
  '</li>';
}

// The header, the note and the Check now button: safe to redraw on every poll.
function naRenderStatus(d) {
  var btn = document.getElementById('na-check');
  var total = document.getElementById('na-total');
  var entries = d.entries || [];
  var when = d.checkedAt ? naWhen(d.checkedAt) : '';
  btn.disabled = !!d.running;
  btn.textContent = d.running ? 'Checking…' : 'Check now';
  document.getElementById('na-sub').textContent = d.checkedAt
    ? 'Checked ' + when + ' across ' + d.casesChecked + ' cases. Checked again every morning at 7:00.'
    : 'Cases where a step was missed. Checked every morning at 7:00.';

  var lines = [], kind = '';
  if (d.running) {
    lines.push((d.error ? 'The previous check did not finish; checking every case again now.' : 'Checking every case.') +
      ' This takes about a minute and a half' + (d.checkedAt ? '; the list below is from the last check.' : '.'));
  } else if (d.error) {
    kind = 'err';
    lines.push('The last check did not finish (' + d.error.message + ').' +
      (d.checkedAt ? ' The list below is from ' + when + '.' : '') + ' You can press Check now to try again.');
  }
  if (d.partial && d.partial.length) lines.push('Not everything could be checked: ' + d.partial.join(' '));
  naSetNote(kind, lines);

  if (d.checkedAt) {
    total.hidden = false;
    total.textContent = entries.length;
    total.className = 'na-total' + (entries.length ? '' : ' zero');
  } else {
    total.hidden = true;
  }
}

// The rows. Not redrawn while someone has a "Mark handled" confirm open, and
// not redrawn at all when a poll brings the same list.
function naRender(force) {
  var d = _na;
  if (!d) return;
  naRenderStatus(d);
  var sig = (d.checkedAt || '') + '|' + (d.running ? 'r' : '') + '|' + (d.entries || []).map(function(e) { return e.key; }).join(',');
  if (!force && sig === _naSig) return;
  if (!force && naBusyCount()) { _naDirty = true; return; }
  // Every row is redrawn: no confirm stays open (a save in flight finishes on its own).
  _naBusy = {};
  _naSig = sig;
  _naDirty = false;
  naRenderBody(d);
}

function naRenderBody(d) {
  var body = document.getElementById('na-body');
  var entries = d.entries || [];
  if (!d.checkedAt) {
    body.innerHTML = '<div class="na-empty">' + (d.running ? 'Checking…' : 'No list yet.') + '</div>';
    return;
  }
  if (!entries.length) {
    body.innerHTML = '<div class="na-empty all-clear">Nothing needs attention right now.</div>';
    return;
  }
  var kinds = d.kinds || {}, groups = {}, order = [];
  entries.forEach(function(e) {
    if (!groups[e.kind]) { groups[e.kind] = []; order.push(e.kind); }
    groups[e.kind].push(e);
  });
  order.sort(function(a, b) { return ((kinds[a] || {}).order || 99) - ((kinds[b] || {}).order || 99); });
  body.innerHTML = order.map(function(kind) {
    var k = kinds[kind] || { label: kind, severity: 'low' };
    // Longest-waiting first; an item without a date goes last.
    var list = groups[kind].slice().sort(function(a, b) { return (a.since || 'z') < (b.since || 'z') ? -1 : 1; });
    var shown = _naShowAll[kind] ? list : list.slice(0, 5);
    return '<div class="na-group sev-' + escHtml(k.severity) + '" data-na-kind="' + escHtml(kind) + '">' +
      '<div class="na-group-hd"><span class="na-sev">' + escHtml(NA_SEV[k.severity] || 'Check') + '</span>' +
        '<h3 class="na-group-title">' + escHtml(k.label) + '</h3><span class="na-count">' + list.length + '</span></div>' +
      '<ul class="na-list">' + shown.map(naItemHtml).join('') + '</ul>' +
      (list.length > shown.length ? '<button type="button" class="na-more" onclick="naShowAll(this)">Show all ' + list.length + '</button>' : '') +
    '</div>';
  }).join('');
}

function naShowAll(btn) {
  var group = btn.closest('.na-group');
  var kind = group.getAttribute('data-na-kind');
  _naShowAll[kind] = true;
  naRender(true);
  // Keyboard users carry on at the first item that was hidden.
  var items = document.querySelectorAll('.na-group[data-na-kind="' + kind + '"] .na-item');
  var next = items[5] && (items[5].querySelector('.na-ref') || items[5].querySelector('.na-btn'));
  if (next) next.focus();
}

function naCheckNow() {
  var btn = document.getElementById('na-check');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  fetch('/admin/needs-attention/refresh', { method: 'POST', headers: naHeaders(true), credentials: 'same-origin', body: '{}' })
    .then(function(r) {
      if (r.status === 401) throw new Error('please sign in again');
      if (!r.ok) throw new Error('the server answered ' + r.status);
      return r.json();
    })
    .then(function(j) {
      if (j.retryInSec) {
        naFlash(j.lastFailed
          ? 'The last check failed a moment ago. You can try again in ' + j.retryInSec + ' seconds.'
          : 'Checked a moment ago. You can check again in ' + j.retryInSec + ' seconds.');
      } else {
        naFlash('');
      }
      return naLoad();
    })
    .catch(function(e) {
      btn.disabled = false;
      btn.textContent = 'Check now';
      naFlash('The check could not start (' + e.message + ').', 'err');
    });
}

function naAskHandled(btn) {
  var act = btn.closest('.na-act');
  var li = btn.closest('.na-item');
  var refEl = li.querySelector('.na-ref');
  _naBusy[li.getAttribute('data-na-key')] = true;
  act.innerHTML = '<span class="na-confirm-q">Adds a note on ' + escHtml(refEl ? refEl.textContent : 'the case') +
      ' in Monday and takes it off this list.</span>' +
    '<span class="na-confirm-row"><button type="button" class="na-btn primary" onclick="naMarkHandled(this)">Mark handled</button>' +
      '<button type="button" class="na-btn" onclick="naCancelHandled(this)">Cancel</button></span>';
  act.querySelector('.primary').focus();
}

function naCancelHandled(btn) {
  var li = btn.closest('.na-item');
  var key = li.getAttribute('data-na-key');
  delete _naBusy[key];
  if (_naDirty && !naBusyCount()) {
    var focusKey = naFocusAfter(key);
    naRender(true);
    var again = document.querySelector('[data-na-key="' + key + '"] .na-btn') ||
      (focusKey && document.querySelector('[data-na-key="' + focusKey + '"] .na-btn'));
    (again || document.getElementById('na-title')).focus();
    return;
  }
  var act = btn.closest('.na-act');
  act.innerHTML = '<button type="button" class="na-btn" onclick="naAskHandled(this)">Mark handled</button>';
  act.querySelector('button').focus();
}

// Where focus goes once an item leaves the list: the next item, else the one
// before, else the list's heading.
function naFocusAfter(key) {
  var all = Array.prototype.slice.call(document.querySelectorAll('.na-item'));
  var i = all.map(function(li) { return li.getAttribute('data-na-key'); }).indexOf(key);
  var to = all[i + 1] || all[i - 1];
  return to ? to.getAttribute('data-na-key') : '';
}

function naMarkHandled(btn) {
  var li = btn.closest('.na-item');
  var act = btn.closest('.na-act');
  var key = li.getAttribute('data-na-key');
  var refEl = li.querySelector('.na-ref');
  var buttons = act.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  btn.textContent = 'Saving…';
  var old = act.querySelector('.na-err');
  if (old) old.parentNode.removeChild(old);
  // The item leaves this page's list (saved, or already gone on the server).
  var drop = function(message) {
    var focusKey = naFocusAfter(key);
    _naDone[key] = true;
    delete _naBusy[key];
    _na.entries = (_na.entries || []).filter(function(e) { return e.key !== key; });
    li.classList.add('gone');
    setTimeout(function() {
      naRender(true);
      var next = focusKey && document.querySelector('[data-na-key="' + focusKey + '"] .na-btn');
      (next || document.getElementById('na-title')).focus();
      naFlash(message);
    }, 200);
  };
  fetch('/admin/needs-attention/handled', { method: 'POST', headers: naHeaders(true), credentials: 'same-origin', body: JSON.stringify({ key: key }) })
    .then(function(r) {
      return r.json().catch(function() { return {}; }).then(function(j) {
        if (r.status === 503) naLoad();   // the server restarted: it is working the list out again
        if (r.status === 404) { var gone = new Error(j.error || 'gone'); gone.gone = true; throw gone; }
        if (!r.ok) throw new Error(j.error || ('The server answered ' + r.status + '.'));
        return j;
      });
    })
    .then(function() {
      drop('Marked handled' + (refEl ? '. A note was added to ' + refEl.textContent + '.' : '.'));
    })
    .catch(function(e) {
      if (e.gone) {   // no longer on the server's list: nothing was written; show the current list
        drop('That item is no longer on the list, so no note was added.');
        naLoad();
        return;
      }
      if (!document.body.contains(li)) {   // the list was redrawn meanwhile: say it where it can be seen
        naFlash('The note for ' + (refEl ? refEl.textContent : 'that item') + ' could not be saved (' + e.message + ').', 'err');
        return;
      }
      btn.textContent = 'Mark handled';
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
      var err = document.createElement('span');
      err.className = 'na-err';
      err.setAttribute('role', 'alert');
      err.textContent = e.message;
      act.appendChild(err);
    });
}

/* ── Boot ─────────────────────────────────────────────────────────── */
${DELETE_UI_JS}
${DEADLINE_CHANGE_JS}
tdotBindDelete(function(){ loadData(); });
document.addEventListener('DOMContentLoaded', function() {
  // No admin key is fine — a Monday-logged-in staffer is authed by cookie and
  // loadData()'s endpoint resolves identity (or shows a Sign-in prompt on 401).
  startClock();
  if (getKey()) checkApiStatus();
  loadData();
  if (VIEW === 'summary') { loadKpis(); loadTrend(); }   // the monthly figures and the 12-month charts load on their own, beside the case data
});
</script>
${isSummary ? '' : '<script>' + listTableScript(casesListSpec, casesListOpts, '{ healthOrder: HEALTH_ORDER, views: CM_VIEWS, initial: cmInitial, onChange: cmOnChange, meta: function() { return (_data && _data.meta) || null; }, typeOf: CMW.typeOf }') + '</script>'}
${DEADLINE_CHANGE_HTML}
</body>
</html>`;
}

// The landing view is the Client Master table (user directive 2026-08-05; renamed from All Cases, block 3).
router.get('/', (_req, res) => {
  res.type('html').send(buildDashboardHTML('cases'));
});

// Everything the dashboard used to carry above the table — KPIs, Action
// Required, portfolio charts, team workload, cases needing attention.
router.get('/summary', (_req, res) => {
  res.type('html').send(buildDashboardHTML('summary'));
});

// /admin/client-master (and with a slash) opens the page (block 3), keeping the query (?view=…).
// Mounted in server.js as a plain app.get (not under this router), so it can never catch /admin/dashboard/summary.
function clientMasterAlias(req, res) {
  const url = String(req.originalUrl || req.url || '');
  const q = url.indexOf('?');
  res.redirect(302, '/admin/dashboard' + (q >= 0 ? url.slice(q) : ''));
}

module.exports = router;
module.exports.clientMasterAlias = clientMasterAlias;
