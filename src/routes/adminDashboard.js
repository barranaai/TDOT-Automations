/**
 * Owner / Management Dashboard
 * Served at GET /admin/dashboard
 * Fetches live data from /api/dashboard/stats (requires ADMIN_API_KEY).
 * Uses Chart.js for charts; all rendering is client-side.
 */

const express = require('express');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS } = require('./adminShared');

function buildDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — Owner Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    ${SHARED_CSS_VARS}
    ${NAV_CSS}

    /* ── Main ───────────────────────────────────────────────────── */
    .wrap {
      max-width: 1440px;
      margin: 0 auto;
      padding: 28px 24px 72px;
    }

    /* ── Loading ─────────────────────────────────────────────────── */
    #loading {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 60vh;
      gap: 16px;
    }

    .spinner {
      width: 44px; height: 44px;
      border: 4px solid var(--border);
      border-top-color: var(--navy);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-text { color: var(--muted); font-size: 14px; }

    #error-msg {
      display: none;
      background: var(--red-bg);
      border: 1px solid #fca5a5;
      color: var(--red);
      padding: 16px 20px;
      border-radius: var(--r);
      margin: 32px auto;
      max-width: 600px;
      text-align: center;
      font-size: 14px;
    }

    #content { display: none; }

    /* ── KPI Strip ───────────────────────────────────────────────── */
    .kpi-group { margin-bottom: 28px; }
    .kpi-group-label {
      font-size: 10px; font-weight: 800; text-transform: uppercase;
      letter-spacing: .9px; color: var(--light);
      margin-bottom: 8px; padding-left: 2px;
    }
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 14px;
    }
    .kpi-strip + .kpi-strip { margin-top: 10px; }

    .kpi {
      background: var(--card);
      border-radius: var(--r);
      padding: 18px 16px;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      border-top: 3px solid var(--border);
      text-align: center;
    }

    .kpi.navy   { border-top-color: var(--navy); }
    .kpi.green  { border-top-color: var(--green); }
    .kpi.red    { border-top-color: var(--red); }
    .kpi.amber  { border-top-color: var(--amber); }
    .kpi.orange { border-top-color: var(--orange); }
    .kpi.blue   { border-top-color: var(--blue); }
    .kpi.purple { border-top-color: #7c3aed; }
    .kpi.slate  { border-top-color: #64748b; }
    .kpi.teal   { border-top-color: #0891b2; }
    .kpi.rose   { border-top-color: #e11d48; }
    .kpi.indigo { border-top-color: #4f46e5; }

    .kpi-num {
      font-size: 30px; font-weight: 800;
      letter-spacing: -1px; line-height: 1;
      margin-bottom: 6px;
    }

    .kpi.navy   .kpi-num { color: var(--navy); }
    .kpi.green  .kpi-num { color: var(--green); }
    .kpi.red    .kpi-num { color: var(--red); }
    .kpi.amber  .kpi-num { color: var(--amber); }
    .kpi.orange .kpi-num { color: var(--orange); }
    .kpi.blue   .kpi-num { color: var(--blue); }
    .kpi.purple .kpi-num { color: #7c3aed; }
    .kpi.slate  .kpi-num { color: #64748b; }
    .kpi.teal   .kpi-num { color: #0891b2; }
    .kpi.rose   .kpi-num { color: #e11d48; }
    .kpi.indigo .kpi-num { color: #4f46e5; }

    .kpi-label {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .8px;
      color: var(--light);
    }

    /* ── Action Cards ───────────────────────────────────────────── */
    .action-card { background:var(--card); border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid var(--border); border-left:4px solid var(--border); overflow:hidden; display:flex; flex-direction:column; }
    .action-card.border-red    { border-left-color: var(--red); }
    .action-card.border-indigo { border-left-color: #4f46e5; }
    .action-card.border-slate  { border-left-color: #64748b; }
    .action-card-hd { display:flex; align-items:center; justify-content:space-between; padding:14px 16px 10px; font-size:12px; font-weight:700; color:var(--navy); border-bottom:1px solid var(--border); }
    .action-badge { font-size:11px; font-weight:800; padding:2px 9px; border-radius:10px; min-width:22px; text-align:center; }
    .action-badge.red    { background:var(--red-bg);  color:var(--red);   }
    .action-badge.indigo { background:#ede9fe;         color:#4f46e5;      }
    .action-badge.slate  { background:#f1f5f9;         color:#64748b;      }
    .action-list { flex:1; overflow-y:auto; max-height:260px; }
    .action-item { padding:8px 16px; border-top:1px solid #f7f8fa; display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11px; }
    .action-item:first-child { border-top:none; }
    .action-item:hover { background:#f8faff; }
    .action-name { font-weight:600; color:var(--navy); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; }
    .action-meta { flex-shrink:0; font-size:10px; font-weight:600; white-space:nowrap; }
    .action-empty { padding:32px 16px; text-align:center; color:var(--light); font-size:12px; }
    .action-more { padding:7px 16px; font-size:11px; color:var(--muted); text-align:center; border-top:1px solid var(--border); font-style:italic; background:#fafbfc; }

    /* ── Section header ──────────────────────────────────────────── */
    .sec-hd {
      font-size: 16px; font-weight: 800;
      color: var(--navy);
      letter-spacing: -.3px;
      margin-bottom: 16px;
      padding-bottom: 10px;
      border-bottom: 2px solid var(--border);
      display: flex; align-items: center; gap: 8px;
    }

    /* ── Chart Grid ──────────────────────────────────────────────── */
    .chart-row {
      display: grid;
      gap: 16px;
      margin-bottom: 28px;
    }

    .chart-row-1 { grid-template-columns: 1fr; }
    .chart-row-3 { grid-template-columns: 1fr 1fr 1fr; }
    .chart-row-2 { grid-template-columns: 3fr 2fr; }
    .chart-row-dl { grid-template-columns: 1fr 2fr; }

    .chart-card {
      background: var(--card);
      border-radius: var(--r);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      padding: 20px 20px 16px;
    }

    .chart-title {
      font-size: 13px; font-weight: 700;
      color: var(--navy);
      margin-bottom: 16px;
      display: flex; align-items: center; gap: 6px;
    }

    .chart-wrap {
      position: relative;
    }

    .chart-wrap.donut { max-width: 260px; margin: 0 auto; }

    /* ── Manager Grid ────────────────────────────────────────────── */
    .mgr-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }

    .mgr-card {
      background: var(--card);
      border-radius: var(--r);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      padding: 18px 20px;
      display: flex; flex-direction: column; gap: 12px;
    }

    .mgr-head {
      display: flex; align-items: center; gap: 10px;
    }

    .mgr-avatar {
      width: 40px; height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--navy) 0%, var(--navy-light) 100%);
      color: white;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; font-weight: 800;
      flex-shrink: 0;
    }

    .mgr-name { font-size: 14px; font-weight: 700; color: var(--navy); }
    .mgr-cases { font-size: 11px; color: var(--muted); }

    .mgr-score-row {
      display: flex; align-items: center; gap: 8px;
    }

    .mgr-score-label { font-size: 11px; color: var(--muted); flex-shrink: 0; }

    .score-bar-wrap {
      flex: 1;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }

    .score-bar-fill {
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--green) 0%, #4ade80 100%);
      transition: width .6s ease;
    }

    .score-bar-fill.amber { background: linear-gradient(90deg, var(--amber) 0%, #fbbf24 100%); }
    .score-bar-fill.red   { background: linear-gradient(90deg, var(--red) 0%, #f87171 100%); }

    .mgr-score-val { font-size: 12px; font-weight: 700; color: var(--navy); min-width: 28px; text-align: right; }

    .mgr-pills {
      display: flex; gap: 6px; flex-wrap: wrap;
    }

    .pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 9px;
      border-radius: 20px;
      font-size: 11px; font-weight: 700;
    }

    .pill.red    { background: var(--red-bg);   color: var(--red);   }
    .pill.orange { background: var(--amber-bg); color: var(--amber); }
    .pill.green  { background: var(--green-bg); color: var(--green); }
    .pill.blue   { background: #eff6ff;         color: var(--blue);  }

    .mgr-readiness-row {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 11px;
    }
    .mgr-readiness-label { color: var(--muted); }
    .mgr-readiness-val   { font-weight: 700; color: var(--navy); }

    /* ── At-Risk Table ───────────────────────────────────────────── */
    .table-card {
      background: var(--card);
      border-radius: var(--r);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      overflow: hidden;
      margin-bottom: 28px;
    }

    .table-toolbar {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }

    .search-box {
      flex: 1; min-width: 200px; max-width: 340px;
      padding: 8px 12px 8px 34px;
      border: 2px solid var(--border);
      border-radius: 7px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      background: #fafbfc url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a0aec0' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E") no-repeat 10px center;
      transition: border-color .15s;
    }
    .search-box:focus { border-color: var(--navy); background-color: white; }

    .filter-sel {
      padding: 8px 12px;
      border: 2px solid var(--border);
      border-radius: 7px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      background: #fafbfc;
      cursor: pointer;
      transition: border-color .15s;
    }
    .filter-sel:focus { border-color: var(--navy); }

    .table-count {
      font-size: 12px; color: var(--muted);
      margin-left: auto;
      white-space: nowrap;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .data-table th {
      background: #f8fafc;
      padding: 9px 14px;
      text-align: left;
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .7px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }

    .data-table th:hover { color: var(--navy); }
    .data-table th.sorted { color: var(--navy); }
    .data-table th .sort-arrow { margin-left: 4px; opacity: .5; }
    .data-table th.sorted .sort-arrow { opacity: 1; }

    .data-table td {
      padding: 10px 14px;
      border-bottom: 1px solid #f7f8fa;
      vertical-align: middle;
    }

    .data-table tr:last-child td { border-bottom: none; }

    .data-table tr.row-red    { background: #fffafa; }
    .data-table tr.row-orange { background: #fffdf7; }

    .data-table tr:hover td { background: #f8faff; }
    .data-table tr.row-red:hover td    { background: #fff0f0; }
    .data-table tr.row-orange:hover td { background: #fff8ee; }

    .health-dot {
      display: inline-block;
      width: 9px; height: 9px;
      border-radius: 50%;
      margin-right: 5px;
      flex-shrink: 0;
    }

    .health-dot.red    { background: var(--red); }
    .health-dot.orange { background: var(--amber); }
    .health-dot.green  { background: var(--green); }

    .badge {
      display: inline-flex;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .5px;
    }

    .badge.red    { background: var(--red-bg);   color: var(--red);   }
    .badge.orange { background: var(--amber-bg); color: var(--amber); }
    .badge.green  { background: var(--green-bg); color: var(--green); }
    .badge.blue   { background: #eff6ff;         color: var(--blue);  }
    .badge.grey   { background: #f1f5f9;         color: var(--muted); }

    .readiness-bar {
      display: flex; align-items: center; gap: 8px;
    }

    .r-bar-bg {
      flex: 1; height: 5px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
      min-width: 60px;
    }

    .r-bar-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--green);
    }
    .r-bar-fill.mid { background: var(--amber); }
    .r-bar-fill.low { background: var(--red); }

    .r-bar-pct { font-size: 11px; font-weight: 600; color: var(--navy); min-width: 28px; }

    /* ── Pagination ───────────────────────────────────────────────── */
    .pagination {
      display: flex; align-items: center; justify-content: center;
      gap: 8px;
      padding: 16px;
      border-top: 1px solid var(--border);
    }

    .pg-btn {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px; font-weight: 600;
      background: var(--card);
      cursor: pointer;
      font-family: inherit;
      transition: all .15s;
    }
    .pg-btn:hover:not(:disabled) { border-color: var(--navy); color: var(--navy); }
    .pg-btn:disabled { opacity: .4; cursor: not-allowed; }
    .pg-btn.active { background: var(--navy); color: white; border-color: var(--navy); }

    .pg-info { font-size: 12px; color: var(--muted); }

    /* ── Responsive ───────────────────────────────────────────────── */
    @media (max-width: 1100px) {
      .chart-row-3 { grid-template-columns: 1fr 1fr; }
      .kpi-strip   { grid-template-columns: repeat(3, 1fr); }
    }

    @media (max-width: 760px) {
      .chart-row-3, .chart-row-2, .chart-row-dl { grid-template-columns: 1fr; }
      .kpi-strip { grid-template-columns: repeat(2, 1fr); }
      .wrap { padding: 16px 12px 48px; }
    }

    /* ── Footer ───────────────────────────────────────────────────── */
    .site-footer {
      text-align: center;
      padding: 24px;
      font-size: 11px;
      color: var(--light);
      border-top: 1px solid var(--border);
      margin-top: 48px;
    }
  </style>
</head>
<body>

${buildNavHeader('dashboard')}

<!-- ── Refresh bar ──────────────────────────────────────────────── -->
<div style="background:var(--navy-dark);padding:6px 28px;display:flex;align-items:center;justify-content:flex-end;gap:14px;border-bottom:1px solid rgba(255,255,255,.08)">
  <span id="hdr-updated" style="font-size:11px;color:rgba(255,255,255,.45)"></span>
  <button id="refresh-btn" onclick="loadData()" style="padding:5px 16px;background:var(--orange);color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;transition:background .15s" onmouseover="this.style.background='#ff6d00'" onmouseout="this.style.background='var(--orange)'">↻ Refresh</button>
</div>

<!-- ── MAIN ───────────────────────────────────────────────────────── -->
<main class="wrap">

  <!-- Loading -->
  <div id="loading">
    <div class="spinner"></div>
    <div class="loading-text">Loading live case data from Monday.com…</div>
  </div>

  <!-- Error -->
  <div id="error-msg"></div>

  <!-- Content -->
  <div id="content">

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

      <div class="chart-card">
        <div class="chart-title">📈 Case Readiness Breakdown</div>
        <div style="display:flex;align-items:stretch;justify-content:center;height:190px;gap:0">

          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-right:1px solid var(--border);padding:0 16px">
            <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Questionnaire</div>
            <div style="font-size:46px;font-weight:800;letter-spacing:-2px" id="readiness-q">—</div>
            <div style="width:90%;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
              <div id="readiness-q-bar" style="height:100%;border-radius:3px;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .8s ease;width:0%"></div>
            </div>
            <div style="font-size:11px;color:var(--light)">avg questionnaire</div>
          </div>

          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-right:1px solid var(--border);padding:0 16px;background:#f9fbff">
            <div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.08em">Overall</div>
            <div style="font-size:46px;font-weight:800;letter-spacing:-2px" id="readiness-overall">—</div>
            <div style="width:90%;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
              <div id="readiness-overall-bar" style="height:100%;border-radius:3px;background:linear-gradient(90deg,#7c3aed,#a78bfa);transition:width .8s ease;width:0%"></div>
            </div>
            <div style="font-size:11px;color:var(--light)">avg overall</div>
          </div>

          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:0 16px">
            <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Documents</div>
            <div style="font-size:46px;font-weight:800;letter-spacing:-2px" id="readiness-doc">—</div>
            <div style="width:90%;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
              <div id="readiness-doc-bar" style="height:100%;border-radius:3px;background:linear-gradient(90deg,#059669,#34d399);transition:width .8s ease;width:0%"></div>
            </div>
            <div style="font-size:11px;color:var(--light)">avg documents</div>
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
        <div class="chart-title">📬 Client Engagement — Chasing Stage Breakdown</div>
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

    <!-- ── All Cases Table ── -->
    <div class="sec-hd">📋 All Cases</div>
    <div class="table-card">
      <div class="table-toolbar">
        <input type="text" class="search-box" id="search-box" placeholder="Search by client, case ref, type…" oninput="filterTable()" />
        <select class="filter-sel" id="filter-stage" onchange="filterTable()">
          <option value="">All Stages</option>
        </select>
        <select class="filter-sel" id="filter-health" onchange="filterTable()">
          <option value="">All Health</option>
          <option value="Red">Red</option>
          <option value="Orange">Orange</option>
          <option value="Green">Green</option>
        </select>
        <select class="filter-sel" id="filter-manager" onchange="filterTable()">
          <option value="">All Managers</option>
        </select>
        <span class="table-count" id="table-count"></span>
      </div>
      <table class="data-table" id="all-cases-table">
        <thead>
          <tr>
            <th onclick="sortTable('caseRef')"    data-col="caseRef">Case Ref <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('clientName')" data-col="clientName">Client <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('caseType')"   data-col="caseType">Type <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('caseStage')"  data-col="caseStage">Stage <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('health')"     data-col="health">Health <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('slaRisk')"    data-col="slaRisk">SLA Risk <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('manager')"    data-col="manager">Manager <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('overallReadiness')" data-col="overallReadiness">Readiness <span class="sort-arrow">↕</span></th>
            <th onclick="sortTable('daysElapsed')"      data-col="daysElapsed">Days <span class="sort-arrow">↕</span></th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="all-cases-body"></tbody>
      </table>
      <div class="pagination" id="pagination"></div>
    </div>

  </div><!-- /content -->

</main>

<footer class="site-footer">
  TDOT Immigration Automation Platform &nbsp;·&nbsp; Owner Dashboard &nbsp;·&nbsp; Live from Monday.com
</footer>

<script>
var _data     = null;
var _filtered = [];
var _sortCol  = 'health';
var _sortDir  = 1;   // ascending on health = Red(0) first by default
var _page     = 1;
var PAGE_SIZE = 25;

var HEALTH_ORDER = { Red: 0, Orange: 1, Green: 2 };

/* ── Shared auth + clock ────────────────────────────────────────── */
${SHARED_AUTH_JS}

/* ── Load data ───────────────────────────────────────────────────── */
function loadData() {
  var key = getKey();
  var btn = document.getElementById('refresh-btn');
  btn.textContent = '↻ Loading…';
  btn.disabled = true;

  document.getElementById('loading').style.display = 'flex';
  document.getElementById('content').style.display = 'none';
  document.getElementById('error-msg').style.display = 'none';

  fetch('/api/dashboard/stats', { headers: { 'X-Api-Key': key } })
    .then(function(r) {
      if (r.status === 401 || r.status === 403) { window.location.href = '/admin'; throw new Error('Unauthorized'); }
      return r.json();
    })
    .then(function(data) {
      _data = data;
      render(data);
      document.getElementById('loading').style.display = 'none';
      document.getElementById('content').style.display = 'block';
      var gen = new Date(data.generatedAt);
      document.getElementById('hdr-updated').textContent =
        'Updated: ' + gen.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

/* ── Render all ──────────────────────────────────────────────────── */
function render(data) {
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
  initAllCasesTable(data);
}

/* ── KPIs ─────────────────────────────────────────────────────────── */
function renderKPIs(s) {
  // Case Health row
  document.getElementById('kpi-total').textContent      = s.total;
  document.getElementById('kpi-green').textContent      = s.green;
  document.getElementById('kpi-orange').textContent     = s.orange;
  document.getElementById('kpi-red').textContent        = s.red;
  document.getElementById('kpi-blocked').textContent    = s.clientBlocked;
  document.getElementById('kpi-escalation').textContent = s.escalationOpen;
  // Operations row
  document.getElementById('kpi-unassigned').textContent = s.unassignedCount    || 0;
  document.getElementById('kpi-behind').textContent     = s.behindScheduleCount || 0;
  document.getElementById('kpi-blocking').textContent   = s.casesWithBlocking  || 0;
  document.getElementById('kpi-inactive').textContent   = s.inactiveCount      || 0;
  document.getElementById('kpi-expiry').textContent     = s.expiryFlagged    || 0;
  document.getElementById('kpi-deadline').textContent   = s.deadlineSoonCount  || 0;
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
  var ctx = document.getElementById(canvasId).getContext('2d');
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
  var ctx = document.getElementById(canvasId).getContext('2d');
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
  var ctx = document.getElementById(canvasId).getContext('2d');
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
  var COLS   = { Green: '#22c55e', Orange: '#f97316', Red: '#ef4444' };
  var labels = [], vals = [], colors = [];
  order.forEach(function(k) {
    if (byHealth[k]) { labels.push(k); vals.push(byHealth[k]); colors.push(COLS[k]); }
  });
  makeDonut('chart-health', labels, vals, colors);
}

function renderSlaChart(bySla) {
  var order  = ['Green', 'Orange', 'Red'];
  var COLS   = { Green: '#22c55e', Orange: '#f97316', Red: '#ef4444' };
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
  var colors = all.map(function(k) { return stageColors[k] || '#94a3b8'; });
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
  var COLORS = { Low: '#22c55e', Medium: '#f97316', High: '#ef4444' };
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
    var initials = name.split(' ').map(function(p) { return p[0] || ''; }).join('').slice(0, 2).toUpperCase();
    var score = m.score || 0;
    var scoreColor = score >= 70 ? '' : (score >= 40 ? ' amber' : ' red');

    var rankBadge = idx === 0 ? ' 🥇' : (idx === 1 ? ' 🥈' : (idx === 2 ? ' 🥉' : ''));

    var card = document.createElement('div');
    card.className = 'mgr-card';
    card.innerHTML =
      '<div class="mgr-head">' +
        '<div class="mgr-avatar">' + initials + '</div>' +
        '<div>' +
          '<div class="mgr-name">' + escHtml(name) + rankBadge + '</div>' +
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
          (m.behindCount  > 0 ? '<span style="font-size:10px;font-weight:700;background:#ede9fe;color:#4f46e5;border-radius:5px;padding:2px 8px">' + m.behindCount  + ' behind schedule</span>' : '') +
          (m.blockingCount > 0 ? '<span style="font-size:10px;font-weight:700;background:#fee2e2;color:#dc2626;border-radius:5px;padding:2px 8px">' + m.blockingCount + ' w/ blockers</span>'    : '') +
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
    tr.innerHTML =
      '<td style="font-weight:600;color:var(--navy)">' + escHtml(c.caseRef || '—') + '</td>' +
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

/* ── All Cases Table ──────────────────────────────────────────────── */
function initAllCasesTable(data) {
  var stages   = Object.keys(data.byStage).sort();
  var managers = Object.keys(data.byManager).sort();

  var stageEl = document.getElementById('filter-stage');
  stageEl.innerHTML = '<option value="">All Stages</option>';
  stages.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    stageEl.appendChild(opt);
  });

  var mgrEl = document.getElementById('filter-manager');
  mgrEl.innerHTML = '<option value="">All Managers</option>';
  managers.forEach(function(m) {
    var opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    mgrEl.appendChild(opt);
  });

  _filtered = data.cases.slice();
  sortTable('health', true);
}

function filterTable() {
  var q    = document.getElementById('search-box').value.toLowerCase();
  var stage = document.getElementById('filter-stage').value;
  var health = document.getElementById('filter-health').value;
  var mgr   = document.getElementById('filter-manager').value;

  _filtered = (_data.cases || []).filter(function(c) {
    if (q && !(
      (c.clientName || '').toLowerCase().includes(q) ||
      (c.caseRef    || '').toLowerCase().includes(q) ||
      (c.caseType   || '').toLowerCase().includes(q)
    )) return false;
    if (stage  && c.caseStage !== stage)  return false;
    if (health && c.health    !== health) return false;
    if (mgr    && !(c.manager || '').includes(mgr)) return false;
    return true;
  });

  _page = 1;
  applySortAndRender();
}

function sortTable(col, silent) {
  if (!silent) {
    if (_sortCol === col) { _sortDir *= -1; }
    else                  { _sortCol = col; _sortDir = col === 'health' || col === 'slaRisk' ? 1 : -1; }
  }

  document.querySelectorAll('[data-col]').forEach(function(th) {
    th.classList.toggle('sorted', th.dataset.col === _sortCol);
    var arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      if (th.dataset.col === _sortCol) arrow.textContent = _sortDir > 0 ? '↑' : '↓';
      else arrow.textContent = '↕';
    }
  });

  _filtered.sort(function(a, b) {
    var av = a[_sortCol], bv = b[_sortCol];
    if (_sortCol === 'health' || _sortCol === 'slaRisk') {
      av = HEALTH_ORDER[av] !== undefined ? HEALTH_ORDER[av] : 2;
      bv = HEALTH_ORDER[bv] !== undefined ? HEALTH_ORDER[bv] : 2;
    } else if (typeof av === 'number') {
      // numeric: higher = first by default
    } else {
      av = (av || '').toLowerCase();
      bv = (bv || '').toLowerCase();
    }
    if (av < bv) return -1 * _sortDir;
    if (av > bv) return  1 * _sortDir;
    return 0;
  });

  renderTablePage();
}

function applySortAndRender() {
  sortTable(_sortCol, true);
}

function renderTablePage() {
  var start = (_page - 1) * PAGE_SIZE;
  var end   = start + PAGE_SIZE;
  var page  = _filtered.slice(start, end);

  document.getElementById('table-count').textContent =
    _filtered.length + ' case' + (_filtered.length !== 1 ? 's' : '');

  var tbody = document.getElementById('all-cases-body');
  tbody.innerHTML = '';

  if (page.length === 0) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="10" style="text-align:center;color:var(--muted);padding:32px">No cases match the current filters.</td>';
    tbody.appendChild(tr);
    renderPagination(0);
    return;
  }

  page.forEach(function(c) {
    var r = c.overallReadiness || 0;
    var barCls = r >= 70 ? '' : (r >= 40 ? ' mid' : ' low');
    var tr = document.createElement('tr');
    tr.className = c.health === 'Red' ? 'row-red' : (c.health === 'Orange' ? 'row-orange' : '');
    tr.innerHTML =
      '<td style="font-weight:600;color:var(--navy);white-space:nowrap">' + escHtml(c.caseRef || '—') + '</td>' +
      '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(c.clientName) + '</td>' +
      '<td style="color:var(--muted);font-size:11px">' + shortType(c.caseType) + '</td>' +
      '<td style="font-size:11px">' + escHtml(c.caseStage) + '</td>' +
      '<td>' + healthBadge(c.health) + '</td>' +
      '<td>' + healthBadge(c.slaRisk) + '</td>' +
      '<td style="color:var(--muted);font-size:11px">' + escHtml(c.manager) + '</td>' +
      '<td>' +
        '<div class="readiness-bar">' +
          '<div class="r-bar-bg"><div class="r-bar-fill' + barCls + '" style="width:' + r + '%"></div></div>' +
          '<span class="r-bar-pct">' + r + '%</span>' +
        '</div>' +
      '</td>' +
      '<td style="text-align:center;font-weight:600;color:var(--muted)">' + (c.daysElapsed || 0) + '</td>' +
      '<td>' +
        (c.clientBlocked      ? '<span class="badge orange" style="margin-right:3px">Blocked</span>' : '') +
        (c.escalationRequired ? '<span class="badge red" style="margin-right:3px">Esc</span>'       : '') +
        (c.expiryFlagged      ? '<span class="badge blue">Expiry</span>'                            : '') +
        (!c.clientBlocked && !c.escalationRequired && !c.expiryFlagged ? '<span style="color:var(--light);font-size:11px">—</span>' : '') +
      '</td>';
    tbody.appendChild(tr);
  });

  renderPagination(_filtered.length);
}

function renderPagination(total) {
  var pages = Math.ceil(total / PAGE_SIZE);
  var el    = document.getElementById('pagination');
  el.innerHTML = '';
  if (pages <= 1) return;

  var prev = document.createElement('button');
  prev.className = 'pg-btn';
  prev.textContent = '← Prev';
  prev.disabled = _page <= 1;
  prev.onclick = function() { _page--; renderTablePage(); };
  el.appendChild(prev);

  var start = Math.max(1, _page - 2);
  var end   = Math.min(pages, _page + 2);
  for (var i = start; i <= end; i++) {
    (function(pi) {
      var btn = document.createElement('button');
      btn.className = 'pg-btn' + (pi === _page ? ' active' : '');
      btn.textContent = pi;
      btn.onclick = function() { _page = pi; renderTablePage(); };
      el.appendChild(btn);
    })(i);
  }

  var info = document.createElement('span');
  info.className = 'pg-info';
  info.textContent = 'Page ' + _page + ' of ' + pages;
  el.appendChild(info);

  var next = document.createElement('button');
  next.className = 'pg-btn';
  next.textContent = 'Next →';
  next.disabled = _page >= pages;
  next.onclick = function() { _page++; renderTablePage(); };
  el.appendChild(next);
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
  var label = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
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

/* ── Boot ─────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  if (!getKey()) return;
  startClock();
  checkApiStatus();
  loadData();
});
</script>

</body>
</html>`;
}

router.get('/', (_req, res) => {
  res.type('html').send(buildDashboardHTML());
});

module.exports = router;
