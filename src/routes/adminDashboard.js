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

    /* ── Base ──────────────────────────────────────────────────── */
    body { background: #f1f5f9; }

    .wrap {
      max-width: 1440px;
      margin: 0 auto;
      padding: 32px 28px 80px;
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

    /* decorative glow orb top-right */
    .kpi::before {
      content: '';
      position: absolute; top: -18px; right: -18px;
      width: 70px; height: 70px; border-radius: 50%;
      opacity: .09; pointer-events: none;
      transition: opacity .18s;
    }
    .kpi:hover::before { opacity: .14; }

    .kpi.navy   { background: linear-gradient(145deg,#fff 55%,#eef2ff); }
    .kpi.navy::before   { background: var(--navy); }
    .kpi.green  { background: linear-gradient(145deg,#fff 55%,#f0fdf4); }
    .kpi.green::before  { background: #16a34a; }
    .kpi.red    { background: linear-gradient(145deg,#fff 55%,#fff1f2); }
    .kpi.red::before    { background: #dc2626; }
    .kpi.amber  { background: linear-gradient(145deg,#fff 55%,#fffbeb); }
    .kpi.amber::before  { background: #d97706; }
    .kpi.orange { background: linear-gradient(145deg,#fff 55%,#fff7ed); }
    .kpi.orange::before { background: var(--orange); }
    .kpi.blue   { background: linear-gradient(145deg,#fff 55%,#eff6ff); }
    .kpi.blue::before   { background: #2563eb; }
    .kpi.purple { background: linear-gradient(145deg,#fff 55%,#f5f3ff); }
    .kpi.purple::before { background: #7c3aed; }
    .kpi.slate  { background: linear-gradient(145deg,#fff 55%,#f8fafc); }
    .kpi.slate::before  { background: #64748b; }
    .kpi.teal   { background: linear-gradient(145deg,#fff 55%,#f0fdfa); }
    .kpi.teal::before   { background: #0891b2; }
    .kpi.rose   { background: linear-gradient(145deg,#fff 55%,#fff1f2); }
    .kpi.rose::before   { background: #e11d48; }
    .kpi.indigo { background: linear-gradient(145deg,#fff 55%,#eef2ff); }
    .kpi.indigo::before { background: #4f46e5; }

    .kpi-num {
      font-size: 34px; font-weight: 800;
      letter-spacing: -1.5px; line-height: 1;
      margin-bottom: 6px;
    }

    .kpi.navy   .kpi-num { color: var(--navy); }
    .kpi.green  .kpi-num { color: #16a34a; }
    .kpi.red    .kpi-num { color: #dc2626; }
    .kpi.amber  .kpi-num { color: #d97706; }
    .kpi.orange .kpi-num { color: var(--orange); }
    .kpi.blue   .kpi-num { color: #2563eb; }
    .kpi.purple .kpi-num { color: #7c3aed; }
    .kpi.slate  .kpi-num { color: #475569; }
    .kpi.teal   .kpi-num { color: #0891b2; }
    .kpi.rose   .kpi-num { color: #e11d48; }
    .kpi.indigo .kpi-num { color: #4f46e5; }

    .kpi-label {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .9px;
      color: #94a3b8;
    }

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
      background: white;
      border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      border: 1px solid #f1f5f9;
      padding: 22px 22px 18px;
      transition: box-shadow .2s ease, transform .2s ease;
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
    .action-card.border-red    .action-card-hd { background: linear-gradient(135deg,#fff5f5,#fff); border-left: 4px solid #ef4444; }
    .action-card.border-indigo .action-card-hd { background: linear-gradient(135deg,#eef2ff,#fff); border-left: 4px solid #4f46e5; }
    .action-card.border-slate  .action-card-hd { background: linear-gradient(135deg,#f8fafc,#fff); border-left: 4px solid #64748b; }

    .action-badge {
      font-size: 11px; font-weight: 800; padding: 3px 10px;
      border-radius: 20px; min-width: 26px; text-align: center;
    }
    .action-badge.red    { background: #fef2f2; color: #dc2626; }
    .action-badge.indigo { background: #eef2ff; color: #4f46e5; }
    .action-badge.slate  { background: #f1f5f9; color: #475569; }

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
      background: linear-gradient(90deg, var(--navy), #3b82f6);
      border-radius: 14px 14px 0 0;
    }
    .mgr-card.score-amber::before { background: linear-gradient(90deg, #d97706, #fbbf24); }
    .mgr-card.score-red::before   { background: linear-gradient(90deg, #dc2626, #f87171); }
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
    .pill.red    { background: #fef2f2; color: #dc2626; }
    .pill.orange { background: #fffbeb; color: #d97706; }
    .pill.green  { background: #f0fdf4; color: #16a34a; }
    .pill.blue   { background: #eff6ff; color: #2563eb; }

    .mgr-readiness-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
    .mgr-readiness-label { color: #94a3b8; font-weight: 600; }
    .mgr-readiness-val   { font-weight: 800; color: var(--navy); }

    /* ── At-Risk / All Cases Tables ─────────────────────────────── */
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
      background: #f8fafc; padding: 10px 14px;
      text-align: left; font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .8px; color: #94a3b8;
      border-bottom: 2px solid #f1f5f9;
      cursor: pointer; user-select: none; white-space: nowrap;
      transition: color .12s, background .12s;
    }
    .data-table th:hover { color: var(--navy); background: #f0f4f8; }
    .data-table th.sorted { color: var(--navy); background: #eef2ff; }
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
    .data-table tr.row-red:hover td    { background: #ffeef0; }
    .data-table tr.row-orange:hover td { background: #fff8e6; }

    /* ── Badges ──────────────────────────────────────────────────── */
    .health-dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; margin-right: 5px; flex-shrink: 0;
    }
    .health-dot.red    { background: #dc2626; }
    .health-dot.orange { background: #d97706; }
    .health-dot.green  { background: #16a34a; }

    .badge {
      display: inline-flex; align-items: center;
      padding: 2px 9px; border-radius: 20px;
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .4px;
    }
    .badge.red    { background: #fef2f2; color: #dc2626; }
    .badge.orange { background: #fffbeb; color: #d97706; }
    .badge.green  { background: #f0fdf4; color: #16a34a; }
    .badge.blue   { background: #eff6ff; color: #2563eb; }
    .badge.grey   { background: #f1f5f9; color: #64748b; }

    /* ── Readiness bar ────────────────────────────────────────────── */
    .readiness-bar { display: flex; align-items: center; gap: 8px; }
    .r-bar-bg { flex: 1; height: 6px; background: #f1f5f9; border-radius: 4px; overflow: hidden; min-width: 60px; }
    .r-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #059669, #34d399); }
    .r-bar-fill.mid { background: linear-gradient(90deg, #d97706, #fbbf24); }
    .r-bar-fill.low { background: linear-gradient(90deg, #dc2626, #f87171); }
    .r-bar-pct { font-size: 11px; font-weight: 700; color: var(--navy); min-width: 30px; }

    /* ── Pagination ───────────────────────────────────────────────── */
    .pagination {
      display: flex; align-items: center; justify-content: center;
      gap: 6px; padding: 16px; border-top: 1px solid #f1f5f9; background: #fafbfc;
    }
    .pg-btn {
      padding: 6px 13px; border: 1.5px solid #e2e8f0; border-radius: 8px;
      font-size: 12px; font-weight: 600; background: white;
      cursor: pointer; font-family: inherit;
      transition: all .15s; color: #475569;
    }
    .pg-btn:hover:not(:disabled) { border-color: var(--navy); color: var(--navy); background: #f0f4f8; }
    .pg-btn:disabled { opacity: .35; cursor: not-allowed; }
    .pg-btn.active { background: var(--navy); color: white; border-color: var(--navy); }
    .pg-info { font-size: 12px; color: #94a3b8; font-weight: 600; }

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
      .chart-row-3 { grid-template-columns: 1fr 1fr; }
      .kpi-strip   { grid-template-columns: repeat(3, 1fr); }
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
  </style>
</head>
<body>

${buildNavHeader('dashboard')}

<!-- ── Refresh bar ──────────────────────────────────────────────── -->
<div class="refresh-bar">
  <div class="refresh-bar-left">
    <span class="live-dot"></span>
    <span class="live-label">Live Dashboard</span>
  </div>
  <div class="refresh-bar-right">
    <span id="hdr-updated" class="refresh-updated"></span>
    <button id="refresh-btn" class="refresh-btn" onclick="loadData()">↻ Refresh</button>
  </div>
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

    <!-- ── Page Header ── -->
    <div class="dash-header">
      <div>
        <h1 class="dash-title">Owner Dashboard</h1>
        <p class="dash-subtitle">Live case intelligence · TDOT Immigration Platform</p>
      </div>
    </div>

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

/* ── Count-up animation ──────────────────────────────────────────── */
function countUp(id, target) {
  var el = document.getElementById(id);
  if (!el) return;
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
    card.className = 'mgr-card' + (score < 40 ? ' score-red' : score < 70 ? ' score-amber' : '');
    card.innerHTML =
      '<div class="mgr-head">' +
        '<div class="mgr-avatar">' + escHtml(initials) + '</div>' +
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
