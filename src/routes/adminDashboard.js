/**
 * Owner / Management Dashboard
 * Served at GET /admin/dashboard
 * Fetches live data from /api/dashboard/stats (requires ADMIN_API_KEY).
 * Uses Chart.js for charts; all rendering is client-side.
 */

const express = require('express');
const router  = express.Router();

function buildDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — Owner Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --navy:       #1e3a5f;
      --navy-dark:  #152b47;
      --navy-light: #2d5282;
      --orange:     #e65100;
      --green:      #16a34a;
      --green-bg:   #f0fdf4;
      --red:        #dc2626;
      --red-bg:     #fef2f2;
      --amber:      #d97706;
      --amber-bg:   #fffbeb;
      --blue:       #2563eb;
      --bg:         #f0f4f8;
      --card:       #ffffff;
      --border:     #e2e8f0;
      --text:       #1a202c;
      --muted:      #718096;
      --light:      #a0aec0;
      --shadow-sm:  0 1px 3px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04);
      --shadow-md:  0 4px 8px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05);
      --r:          12px;
      --r-sm:       8px;
    }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
    }

    /* ── Header ─────────────────────────────────────────────────── */
    .hdr {
      background: linear-gradient(90deg, var(--navy-dark) 0%, var(--navy) 100%);
      height: 64px;
      padding: 0 32px;
      display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 200;
      box-shadow: 0 2px 12px rgba(0,0,0,.2);
    }

    .hdr-left { display: flex; align-items: center; gap: 14px; }

    .hdr-logo {
      width: 38px; height: 38px;
      background: rgba(255,255,255,.15);
      border-radius: 9px;
      border: 1px solid rgba(255,255,255,.2);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }

    .hdr-title  { font-size: 16px; font-weight: 800; color: white; letter-spacing: -.3px; }
    .hdr-sub    { font-size: 10px; color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: 1.2px; margin-top: 1px; }

    .hdr-right { display: flex; align-items: center; gap: 12px; }

    .hdr-btn {
      padding: 6px 15px;
      border-radius: 7px;
      font-size: 12px; font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.1);
      color: white;
      transition: background .15s;
      text-decoration: none;
      display: inline-flex; align-items: center; gap: 5px;
    }
    .hdr-btn:hover { background: rgba(255,255,255,.2); }
    .hdr-btn.orange { background: var(--orange); border-color: transparent; }
    .hdr-btn.orange:hover { background: #ff6d00; }

    .hdr-updated {
      font-size: 11px;
      color: rgba(255,255,255,.5);
    }

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
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 14px;
      margin-bottom: 28px;
    }

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

    .kpi-label {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .8px;
      color: var(--light);
    }

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

    .chart-row-3 { grid-template-columns: 1fr 1fr 1fr; }
    .chart-row-2 { grid-template-columns: 3fr 2fr; }

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
      .kpi-strip   { grid-template-columns: repeat(4, 1fr); }
    }

    @media (max-width: 760px) {
      .chart-row-3, .chart-row-2 { grid-template-columns: 1fr; }
      .kpi-strip { grid-template-columns: repeat(2, 1fr); }
      .hdr { padding: 0 16px; }
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

<!-- ── HEADER ─────────────────────────────────────────────────────── -->
<header class="hdr">
  <div class="hdr-left">
    <div class="hdr-logo">🏢</div>
    <div>
      <div class="hdr-title">TDOT Immigration</div>
      <div class="hdr-sub">Owner &amp; Management Dashboard</div>
    </div>
  </div>
  <div class="hdr-right">
    <span class="hdr-updated" id="hdr-updated"></span>
    <button class="hdr-btn orange" id="refresh-btn" onclick="loadData()">↻ Refresh</button>
    <a class="hdr-btn" href="/admin">← Engine Controls</a>
  </div>
</header>

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

    <!-- ── KPI Strip ── -->
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
      <div class="kpi blue">
        <div class="kpi-num" id="kpi-expiry">—</div>
        <div class="kpi-label">Expiry Flagged</div>
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
        <div class="chart-title">📈 Avg Readiness</div>
        <div style="display:flex;align-items:center;justify-content:center;height:200px;flex-direction:column;gap:8px">
          <div style="font-size:64px;font-weight:800;color:var(--navy);letter-spacing:-2px" id="readiness-big">—</div>
          <div style="font-size:13px;color:var(--muted)">Average overall case readiness</div>
          <div style="width:80%;height:8px;background:var(--border);border-radius:4px;overflow:hidden;margin-top:8px">
            <div id="readiness-bar-fill" style="height:100%;border-radius:4px;background:linear-gradient(90deg,var(--green),#4ade80);transition:width .8s ease;width:0%"></div>
          </div>
          <div style="font-size:11px;color:var(--light);margin-top:4px">Questionnaire + Document readiness combined</div>
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
            <th>Days Elapsed</th>
            <th>Escalation</th>
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
var _sortDir  = -1;
var _page     = 1;
var PAGE_SIZE = 25;

var HEALTH_ORDER = { Red: 0, Orange: 1, Green: 2 };

/* ── Auth check ──────────────────────────────────────────────────── */
function getKey() {
  var k = sessionStorage.getItem('tdot_admin_key');
  if (!k) { window.location.href = '/admin'; }
  return k;
}

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
      if (r.status === 401 || r.status === 403) { window.location.href = '/admin'; }
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
  renderHealthChart(data.byHealth);
  renderSlaChart(data.bySlaRisk);
  renderStageChart(data.byStage);
  renderTypeChart(data.byType);
  renderReadiness(data.summary.avgReadiness);
  renderManagerCards(data.byManager);
  renderAtRisk(data.cases);
  initAllCasesTable(data);
}

/* ── KPIs ─────────────────────────────────────────────────────────── */
function renderKPIs(s) {
  document.getElementById('kpi-total').textContent      = s.total;
  document.getElementById('kpi-green').textContent      = s.green;
  document.getElementById('kpi-orange').textContent     = s.orange;
  document.getElementById('kpi-red').textContent        = s.red;
  document.getElementById('kpi-blocked').textContent    = s.clientBlocked;
  document.getElementById('kpi-escalation').textContent = s.escalationOpen;
  document.getElementById('kpi-expiry').textContent     = s.expiryFlagged;
}

/* ── Readiness meter ──────────────────────────────────────────────── */
function renderReadiness(pct) {
  document.getElementById('readiness-big').textContent = pct + '%';
  document.getElementById('readiness-bar-fill').style.width = pct + '%';
  var fill = document.getElementById('readiness-bar-fill');
  if (pct < 40)      fill.style.background = 'linear-gradient(90deg,var(--red),#f87171)';
  else if (pct < 70) fill.style.background = 'linear-gradient(90deg,var(--amber),#fbbf24)';
  else               fill.style.background = 'linear-gradient(90deg,var(--green),#4ade80)';
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
  var cols   = ['#22c55e', '#f97316', '#ef4444'];
  var labels = [], vals = [];
  order.forEach(function(k) {
    if (byHealth[k]) { labels.push(k); vals.push(byHealth[k]); }
  });
  makeDonut('chart-health', labels, vals, cols.slice(0, labels.length));
}

function renderSlaChart(bySla) {
  var order = ['Green', 'Orange', 'Red'];
  var cols  = ['#22c55e', '#f97316', '#ef4444'];
  var labels = [], vals = [];
  order.forEach(function(k) {
    if (bySla[k]) { labels.push(k); vals.push(bySla[k]); }
  });
  makeDonut('chart-sla', labels, vals, cols.slice(0, labels.length));
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

    var greenPct  = m.total > 0 ? Math.round(m.green / m.total * 100)  : 0;
    var orangePct = m.total > 0 ? Math.round(m.orange / m.total * 100) : 0;
    var redPct    = m.total > 0 ? Math.round(m.red / m.total * 100)    : 0;

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
      '</div>';

    grid.appendChild(card);
  });
}

/* ── At-Risk Table ────────────────────────────────────────────────── */
function renderAtRisk(cases) {
  var atRisk = cases.filter(function(c) {
    return c.health === 'Red' || c.slaRisk === 'Red' || c.health === 'Orange';
  }).sort(function(a, b) {
    return (HEALTH_ORDER[a.health] || 2) - (HEALTH_ORDER[b.health] || 2);
  });

  var tbody = document.getElementById('atrisk-body');
  tbody.innerHTML = '';

  if (atRisk.length === 0) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="9" style="text-align:center;color:var(--muted);padding:32px">No cases are currently at risk 🎉</td>';
    tbody.appendChild(tr);
    return;
  }

  atRisk.forEach(function(c) {
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
      '<td style="text-align:center;font-weight:600">' + (c.daysElapsed || 0) + '</td>' +
      '<td>' + (c.escalationRequired ? '<span class="badge red">Yes</span>' : '<span class="badge grey">No</span>') + '</td>';
    tbody.appendChild(tr);
  });
}

/* ── All Cases Table ──────────────────────────────────────────────── */
function initAllCasesTable(data) {
  var stages   = Object.keys(data.byStage).sort();
  var managers = Object.keys(data.byManager).sort();

  var stageEl = document.getElementById('filter-stage');
  stages.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    stageEl.appendChild(opt);
  });

  var mgrEl = document.getElementById('filter-manager');
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
    if (mgr    && !c.manager.includes(mgr)) return false;
    return true;
  });

  _page = 1;
  applySortAndRender();
}

function sortTable(col, silent) {
  if (!silent) {
    if (_sortCol === col) { _sortDir *= -1; }
    else                  { _sortCol = col; _sortDir = col === 'health' || col === 'slaRisk' ? 1 : 1; }
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
    var r = c.overallReadiness;
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
  return t.length > 22 ? t.slice(0, 20) + '…' : t;
}

/* ── Boot ─────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  getKey();
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
