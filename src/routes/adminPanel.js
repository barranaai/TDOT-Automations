/**
 * Admin Control Panel
 * Served at /admin — beautiful UI for triggering engines, system health,
 * and case management utilities.
 *
 * Auth: client-side only. The login form validates the ADMIN_API_KEY
 * by probing /api/monday-test. All API calls include the key in headers.
 * The HTML itself is public (no sensitive data in the markup).
 */

const express = require('express');
const router  = express.Router();

function buildAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — Admin Panel</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --navy:        #1e3a5f;
      --navy-dark:   #152b47;
      --navy-light:  #2d5282;
      --orange:      #e65100;
      --orange-light:#ff6d00;
      --green:       #1a7a4a;
      --green-bg:    #f0faf5;
      --red:         #c62828;
      --red-bg:      #fff5f5;
      --amber:       #b45309;
      --amber-bg:    #fffbeb;
      --blue:        #1a56db;
      --blue-bg:     #eff6ff;
      --bg:          #f0f4f8;
      --card:        #ffffff;
      --border:      #e2e8f0;
      --text:        #1a202c;
      --text-muted:  #718096;
      --text-light:  #a0aec0;
      --shadow-sm:   0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.04);
      --shadow-md:   0 4px 8px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05);
      --shadow-lg:   0 12px 24px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06);
      --radius:      12px;
      --radius-sm:   8px;
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 14px;
      line-height: 1.5;
    }

    /* ─── Login Overlay ──────────────────────────────────────────── */
    #login-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: linear-gradient(135deg, var(--navy-dark) 0%, var(--navy-light) 100%);
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    #login-overlay.hidden { display: none; }

    .login-card {
      background: var(--card);
      border-radius: 20px;
      box-shadow: var(--shadow-lg);
      padding: 48px 40px;
      width: 100%;
      max-width: 420px;
      text-align: center;
    }

    .login-logo {
      width: 72px; height: 72px;
      background: linear-gradient(135deg, var(--navy) 0%, var(--navy-light) 100%);
      border-radius: 18px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 30px; margin-bottom: 24px;
      box-shadow: 0 8px 20px rgba(30,58,95,.3);
    }

    .login-card h1 {
      font-size: 22px; font-weight: 800;
      color: var(--navy); margin-bottom: 6px; letter-spacing: -.4px;
    }

    .login-card .login-sub {
      color: var(--text-muted); font-size: 13px; margin-bottom: 32px;
    }

    .input-group {
      position: relative; margin-bottom: 14px;
    }

    .input-group input {
      width: 100%;
      padding: 13px 16px;
      border: 2px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color .15s, box-shadow .15s;
      background: #fafbfc;
    }

    .input-group input:focus {
      border-color: var(--navy);
      box-shadow: 0 0 0 3px rgba(30,58,95,.12);
      background: white;
    }

    .btn-login {
      width: 100%;
      padding: 13px 24px;
      background: linear-gradient(135deg, var(--navy) 0%, var(--navy-light) 100%);
      color: white;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 15px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: opacity .15s, transform .1s;
      box-shadow: 0 4px 12px rgba(30,58,95,.3);
      letter-spacing: -.1px;
    }

    .btn-login:hover { opacity: .9; }
    .btn-login:active { transform: scale(.98); }
    .btn-login:disabled { opacity: .6; cursor: not-allowed; transform: none; }

    .login-error {
      color: var(--red);
      font-size: 13px;
      margin-top: 12px;
      padding: 8px 12px;
      background: var(--red-bg);
      border-radius: 6px;
      display: none;
    }

    /* ─── Header ─────────────────────────────────────────────────── */
    .site-header {
      background: linear-gradient(90deg, var(--navy-dark) 0%, var(--navy) 100%);
      color: white;
      padding: 0 32px;
      height: 64px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 2px 12px rgba(0,0,0,.2);
      position: sticky; top: 0; z-index: 100;
    }

    .header-brand {
      display: flex; align-items: center; gap: 14px;
    }

    .header-logo {
      width: 38px; height: 38px;
      background: rgba(255,255,255,.15);
      border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
      border: 1px solid rgba(255,255,255,.2);
    }

    .header-title {
      font-size: 16px; font-weight: 800; letter-spacing: -.4px;
    }

    .header-subtitle {
      font-size: 10px; color: rgba(255,255,255,.55);
      text-transform: uppercase; letter-spacing: 1.2px; margin-top: 1px;
    }

    .header-right {
      display: flex; align-items: center; gap: 16px;
    }

    .status-pill {
      display: flex; align-items: center; gap: 7px;
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.15);
      padding: 5px 13px;
      border-radius: 20px;
      font-size: 12px; font-weight: 500;
    }

    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #4ade80;
    }

    .status-dot.pulse { animation: pulse 2s infinite; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: .4; }
    }

    .header-time {
      font-size: 12px;
      color: rgba(255,255,255,.55);
      font-variant-numeric: tabular-nums;
    }

    .logout-btn {
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.2);
      color: rgba(255,255,255,.8);
      padding: 5px 13px;
      border-radius: 7px;
      font-size: 12px; font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background .15s;
    }
    .logout-btn:hover { background: rgba(255,255,255,.2); color: white; }

    /* ─── Dashboard visibility ───────────────────────────────────── */
    #dashboard { display: none; }
    #dashboard.visible { display: block; }

    /* ─── Main container ─────────────────────────────────────────── */
    .container {
      max-width: 1240px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    /* ─── Stat Strip ─────────────────────────────────────────────── */
    .stat-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 28px;
    }

    .stat-card {
      background: var(--card);
      border-radius: var(--radius);
      padding: 20px 22px;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
    }

    .stat-label {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1px;
      color: var(--text-light);
      margin-bottom: 10px;
    }

    .stat-value {
      font-size: 26px; font-weight: 800;
      color: var(--navy);
      line-height: 1;
      letter-spacing: -.5px;
    }

    .stat-value.green  { color: var(--green); }
    .stat-value.orange { color: var(--orange); }
    .stat-value.muted  { font-size: 16px; font-weight: 600; color: var(--text-muted); }

    /* ─── Section Headers ────────────────────────────────────────── */
    .section-hd {
      display: flex; align-items: baseline; gap: 10px;
      margin-bottom: 18px;
    }

    .section-title {
      font-size: 17px; font-weight: 800;
      color: var(--navy); letter-spacing: -.3px;
    }

    .section-hint {
      font-size: 12px; color: var(--text-muted);
    }

    /* ─── Run All Banner ─────────────────────────────────────────── */
    .run-all-banner {
      background: linear-gradient(135deg, var(--navy-dark) 0%, var(--navy-light) 100%);
      border-radius: var(--radius);
      padding: 20px 24px;
      display: flex; align-items: center; gap: 16px;
      margin-bottom: 32px;
      box-shadow: var(--shadow-md);
    }

    .run-all-icon {
      font-size: 28px;
      flex-shrink: 0;
    }

    .run-all-text { flex: 1; }

    .run-all-title {
      font-size: 15px; font-weight: 800;
      color: white; letter-spacing: -.2px;
      margin-bottom: 3px;
    }

    .run-all-sub {
      font-size: 12px;
      color: rgba(255,255,255,.6);
    }

    .run-all-btn {
      padding: 11px 28px;
      background: var(--orange);
      color: white;
      border: none;
      border-radius: 9px;
      font-size: 14px; font-weight: 800;
      font-family: inherit;
      cursor: pointer;
      transition: background .15s, transform .1s;
      white-space: nowrap;
      letter-spacing: -.1px;
      box-shadow: 0 4px 12px rgba(230,81,0,.35);
    }
    .run-all-btn:hover { background: var(--orange-light); transform: scale(1.02); }
    .run-all-btn:active { transform: scale(.98); }
    .run-all-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }

    /* ─── Engine Grid ────────────────────────────────────────────── */
    .engines-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 32px;
    }

    .engine-card {
      background: var(--card);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      overflow: hidden;
      transition: box-shadow .2s, transform .2s;
      display: flex; flex-direction: column;
    }

    .engine-card:hover {
      box-shadow: var(--shadow-md);
      transform: translateY(-2px);
    }

    .engine-card-hd {
      padding: 16px 18px 14px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: flex-start; gap: 12px;
    }

    .engine-icon {
      width: 44px; height: 44px;
      border-radius: 11px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }

    .engine-badge {
      display: inline-flex; align-items: center;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 9px; font-weight: 800;
      text-transform: uppercase; letter-spacing: .7px;
      background: #eef2ff; color: #4338ca;
      margin-bottom: 4px;
    }

    .engine-name {
      font-size: 13px; font-weight: 700;
      color: var(--navy); line-height: 1.2;
    }

    .engine-body {
      padding: 14px 18px;
      flex: 1;
    }

    .engine-desc {
      font-size: 12px; color: var(--text-muted);
      line-height: 1.65;
      margin-bottom: 12px;
    }

    .engine-status-row {
      display: flex; align-items: center; gap: 7px;
    }

    .e-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #cbd5e0;
      flex-shrink: 0;
    }

    .e-dot.running { background: var(--orange); animation: pulse 1s infinite; }
    .e-dot.success { background: var(--green); }
    .e-dot.error   { background: var(--red);   }

    .engine-status-text {
      font-size: 11px; font-weight: 500;
      color: var(--text-muted);
    }

    .engine-ft {
      padding: 12px 18px;
      background: #fafbfd;
      border-top: 1px solid var(--border);
    }

    .run-btn {
      width: 100%;
      padding: 9px 14px;
      background: var(--navy);
      color: white;
      border: none;
      border-radius: 7px;
      font-size: 13px; font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: background .15s, opacity .15s;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      letter-spacing: -.1px;
    }

    .run-btn:hover:not(:disabled) { background: var(--navy-light); }
    .run-btn:disabled { opacity: .45; cursor: not-allowed; }
    .run-btn.running  { background: #92400e; }
    .run-btn.success  { background: var(--green); }
    .run-btn.error    { background: var(--red); }

    /* ─── Utilities ──────────────────────────────────────────────── */
    .utils-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 32px;
    }

    .util-card {
      background: var(--card);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      padding: 22px 22px 20px;
    }

    .util-title {
      font-size: 14px; font-weight: 700;
      color: var(--navy); margin-bottom: 5px;
    }

    .util-desc {
      font-size: 12px; color: var(--text-muted);
      margin-bottom: 16px; line-height: 1.6;
    }

    .util-row {
      display: flex; gap: 8px; align-items: center;
    }

    .util-input {
      flex: 1;
      padding: 9px 12px;
      border: 2px solid var(--border);
      border-radius: 7px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      transition: border-color .15s;
      background: #fafbfc;
    }
    .util-input:focus { border-color: var(--navy); background: white; }

    .btn-sm {
      padding: 9px 18px;
      background: var(--navy);
      color: white;
      border: none;
      border-radius: 7px;
      font-size: 13px; font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: background .15s;
      white-space: nowrap;
    }
    .btn-sm:hover:not(:disabled) { background: var(--navy-light); }
    .btn-sm:disabled { opacity: .5; cursor: not-allowed; }
    .btn-sm.success  { background: var(--green); }
    .btn-sm.error    { background: var(--red); }

    .util-result {
      font-size: 12px; margin-top: 10px;
      color: var(--text-muted);
      min-height: 18px;
    }

    /* ─── Activity Log ───────────────────────────────────────────── */
    .log-card {
      background: var(--card);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      overflow: hidden;
    }

    .log-card-hd {
      padding: 16px 22px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }

    .log-card-title {
      font-size: 15px; font-weight: 800;
      color: var(--navy); letter-spacing: -.2px;
    }

    .clear-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 4px 11px;
      border-radius: 6px;
      font-size: 11px; font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: all .15s;
    }
    .clear-btn:hover { border-color: var(--red); color: var(--red); }

    .log-body {
      max-height: 420px;
      overflow-y: auto;
    }

    .log-empty {
      padding: 44px 22px;
      text-align: center;
      color: var(--text-light);
      font-size: 13px;
    }

    .log-entry {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 11px 22px;
      border-bottom: 1px solid #f7f8fa;
      animation: fadeIn .2s ease;
    }
    .log-entry:last-child { border-bottom: none; }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-3px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .log-ts {
      font-size: 10px; font-weight: 600;
      color: var(--text-light);
      white-space: nowrap;
      margin-top: 2px;
      min-width: 44px;
      font-variant-numeric: tabular-nums;
    }

    .log-ico { font-size: 13px; margin-top: 1px; }

    .log-msg { flex: 1; font-size: 13px; color: var(--text); }
    .log-msg.success { color: var(--green); }
    .log-msg.error   { color: var(--red); }
    .log-msg.info    { color: var(--blue); }
    .log-msg.running { color: var(--amber); }

    /* ─── Responsive ─────────────────────────────────────────────── */
    @media (max-width: 960px) {
      .engines-grid { grid-template-columns: repeat(2, 1fr); }
      .stat-strip   { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 620px) {
      .engines-grid, .stat-strip, .utils-grid { grid-template-columns: 1fr; }
      .container { padding: 16px 14px 48px; }
      .site-header { padding: 0 16px; }
      .header-time { display: none; }
      .run-all-banner { flex-direction: column; text-align: center; }
    }

    /* ─── Footer ─────────────────────────────────────────────────── */
    .site-footer {
      text-align: center;
      padding: 24px;
      font-size: 11px;
      color: var(--text-light);
      border-top: 1px solid var(--border);
      margin-top: 48px;
    }
  </style>
</head>
<body>

<!-- ════════════════════════ LOGIN OVERLAY ════════════════════════ -->
<div id="login-overlay">
  <div class="login-card">
    <div class="login-logo">🏢</div>
    <h1>TDOT Immigration</h1>
    <p class="login-sub">Enter your admin key to access the control panel</p>
    <div class="input-group">
      <input type="password" id="api-key-input" placeholder="Admin API Key" autocomplete="off" />
    </div>
    <button class="btn-login" id="login-btn" onclick="handleLogin()">Unlock Dashboard</button>
    <div class="login-error" id="login-error"></div>
  </div>
</div>

<!-- ════════════════════════ DASHBOARD ═══════════════════════════ -->
<div id="dashboard">

  <header class="site-header">
    <div class="header-brand">
      <div class="header-logo">🏢</div>
      <div>
        <div class="header-title">TDOT Immigration</div>
        <div class="header-subtitle">Admin Control Panel</div>
      </div>
    </div>
    <div class="header-right">
      <div class="status-pill">
        <div class="status-dot pulse" id="sys-dot"></div>
        <span id="sys-text">Checking…</span>
      </div>
      <span class="header-time" id="hdr-time"></span>
      <button class="logout-btn" onclick="logout()">Sign Out</button>
    </div>
  </header>

  <main class="container">

    <!-- ── Stat Strip ── -->
    <div class="stat-strip">
      <div class="stat-card">
        <div class="stat-label">Daily Schedule</div>
        <div class="stat-value" style="font-size:20px;font-weight:700">07:00 daily</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Engines</div>
        <div class="stat-value green">6</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last Manual Trigger</div>
        <div class="stat-value muted" id="stat-last">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Monday API Status</div>
        <div class="stat-value muted" id="stat-monday">—</div>
      </div>
    </div>

    <!-- ── Run All Banner ── -->
    <div class="run-all-banner">
      <div class="run-all-icon">⚡</div>
      <div class="run-all-text">
        <div class="run-all-title">Run Full Daily Sequence</div>
        <div class="run-all-sub">Triggers all 6 engines in order: Readiness → SLA → Expiry → Health → Escalation → Chasing</div>
      </div>
      <button class="run-all-btn" id="run-all-btn" onclick="runFullSequence()">▶ Run All</button>
    </div>

    <!-- ── Engines Section ── -->
    <div class="section-hd">
      <h2 class="section-title">Automation Engines</h2>
      <span class="section-hint">Click Run Now to trigger immediately (engines run in background)</span>
    </div>

    <div class="engines-grid">

      <div class="engine-card">
        <div class="engine-card-hd">
          <div class="engine-icon" style="background:#eff6ff">📋</div>
          <div>
            <div class="engine-badge">Step 1 of 6</div>
            <div class="engine-name">Case Readiness Engine</div>
          </div>
        </div>
        <div class="engine-body">
          <p class="engine-desc">Calculates Q + Doc readiness scores, writes to Client Master Board, and triggers stage gates (Internal Review / Submission Prep).</p>
          <div class="engine-status-row">
            <div class="e-dot" id="dot-readiness"></div>
            <span class="engine-status-text" id="txt-readiness">Ready</span>
          </div>
        </div>
        <div class="engine-ft">
          <button class="run-btn" id="btn-readiness"
            onclick="triggerEngine('/api/readiness/run','Case Readiness Engine','readiness')">▶ Run Now</button>
        </div>
      </div>

      <div class="engine-card">
        <div class="engine-card-hd">
          <div class="engine-icon" style="background:#fff7ed">⏱️</div>
          <div>
            <div class="engine-badge">Step 2 of 6</div>
            <div class="engine-name">SLA &amp; Risk Engine</div>
          </div>
        </div>
        <div class="engine-body">
          <p class="engine-desc">Sets Risk Band (Green / Orange / Red), Days Elapsed, and Expiry Flag. Forces band to Orange/Red when a deadline or expiry is approaching.</p>
          <div class="engine-status-row">
            <div class="e-dot" id="dot-sla"></div>
            <span class="engine-status-text" id="txt-sla">Ready</span>
          </div>
        </div>
        <div class="engine-ft">
          <button class="run-btn" id="btn-sla"
            onclick="triggerEngine('/api/sla/run','SLA &amp; Risk Engine','sla')">▶ Run Now</button>
        </div>
      </div>

      <div class="engine-card">
        <div class="engine-card-hd">
          <div class="engine-icon" style="background:#fef2f2">⚠️</div>
          <div>
            <div class="engine-badge">Step 3 of 6</div>
            <div class="engine-name">Expiry Risk Engine</div>
          </div>
        </div>
        <div class="engine-body">
          <p class="engine-desc">Detects new and escalating expiry flags (passport, IELTS, medical). Sets Escalation Required and emails the assigned supervisor.</p>
          <div class="engine-status-row">
            <div class="e-dot" id="dot-expiry"></div>
            <span class="engine-status-text" id="txt-expiry">Ready</span>
          </div>
        </div>
        <div class="engine-ft">
          <button class="run-btn" id="btn-expiry"
            onclick="triggerEngine('/api/expiry/run','Expiry Risk Engine','expiry')">▶ Run Now</button>
        </div>
      </div>

      <div class="engine-card">
        <div class="engine-card-hd">
          <div class="engine-icon" style="background:#f0fdf4">❤️</div>
          <div>
            <div class="engine-badge">Step 4 of 6</div>
            <div class="engine-name">Case Health Engine</div>
          </div>
        </div>
        <div class="engine-body">
          <p class="engine-desc">Synthesises all signals into Case Health Status, Client Delay Level, Client Responsiveness Score, and Client-Blocked Status.</p>
          <div class="engine-status-row">
            <div class="e-dot" id="dot-health"></div>
            <span class="engine-status-text" id="txt-health">Ready</span>
          </div>
        </div>
        <div class="engine-ft">
          <button class="run-btn" id="btn-health"
            onclick="triggerEngine('/api/health/run','Case Health Engine','health')">▶ Run Now</button>
        </div>
      </div>

      <div class="engine-card">
        <div class="engine-card-hd">
          <div class="engine-icon" style="background:#fdf4ff">🔔</div>
          <div>
            <div class="engine-badge">Step 5 of 6</div>
            <div class="engine-name">Escalation Routing</div>
          </div>
        </div>
        <div class="engine-body">
          <p class="engine-desc">Matches Orange/Red cases to Escalation Matrix rules. Notifies supervisors and directors. Applies stage and SLA actions automatically.</p>
          <div class="engine-status-row">
            <div class="e-dot" id="dot-escalation"></div>
            <span class="engine-status-text" id="txt-escalation">Ready</span>
          </div>
        </div>
        <div class="engine-ft">
          <button class="run-btn" id="btn-escalation"
            onclick="triggerEngine('/api/escalation/run','Escalation Routing','escalation')">▶ Run Now</button>
        </div>
      </div>

      <div class="engine-card">
        <div class="engine-card-hd">
          <div class="engine-icon" style="background:#fffbeb">📧</div>
          <div>
            <div class="engine-badge">Step 6 of 6</div>
            <div class="engine-name">Client Chasing Loop</div>
          </div>
        </div>
        <div class="engine-body">
          <p class="engine-desc">Sends timed reminder emails based on SLA offsets (R1 → R2 → Final Notice). Advances stage and sets Client Blocked when unresponsive.</p>
          <div class="engine-status-row">
            <div class="e-dot" id="dot-chasing"></div>
            <span class="engine-status-text" id="txt-chasing">Ready</span>
          </div>
        </div>
        <div class="engine-ft">
          <button class="run-btn" id="btn-chasing"
            onclick="triggerEngine('/api/chasing/run','Client Chasing Loop','chasing')">▶ Run Now</button>
        </div>
      </div>

    </div><!-- /engines-grid -->

    <!-- ── Utilities ── -->
    <div class="section-hd">
      <h2 class="section-title">Utilities</h2>
    </div>

    <div class="utils-grid">

      <div class="util-card">
        <div class="util-title">🔗 Monday.com API Connection Test</div>
        <div class="util-desc">
          Verify the Monday.com integration is live and confirm which account the automation server is authenticated as.
        </div>
        <div class="util-row">
          <button class="btn-sm" id="btn-api-test" onclick="testMondayApi()">Test Connection</button>
          <span id="api-test-inline" style="font-size:12px;color:var(--text-muted);margin-left:8px"></span>
        </div>
        <div class="util-result" id="api-test-result"></div>
      </div>

      <div class="util-card">
        <div class="util-title">📬 Resend Intake Questionnaire Email</div>
        <div class="util-desc">
          Resend the intake email for a specific Client Master item. Use this when a token was missing or a link was broken.
        </div>
        <div class="util-row">
          <input type="text" class="util-input" id="intake-item-id" placeholder="Monday.com Item ID (e.g. 1234567890)" />
          <button class="btn-sm" id="btn-resend" onclick="resendIntake()">Send</button>
        </div>
        <div class="util-result" id="resend-result"></div>
      </div>

    </div>

    <!-- ── Activity Log ── -->
    <div class="section-hd">
      <h2 class="section-title">Activity Log</h2>
      <span class="section-hint">Persists for this browser session</span>
    </div>

    <div class="log-card">
      <div class="log-card-hd">
        <span class="log-card-title">Recent Actions</span>
        <button class="clear-btn" onclick="clearLog()">Clear log</button>
      </div>
      <div class="log-body" id="log-body">
        <div class="log-empty" id="log-empty">No activity yet — trigger an engine above to get started</div>
      </div>
    </div>

  </main>

  <footer class="site-footer">
    TDOT Immigration Automation Platform &nbsp;·&nbsp; Admin Control Panel &nbsp;·&nbsp; v2.0
  </footer>

</div><!-- /dashboard -->

<script>
  var LOG_KEY  = 'tdot_admin_log';
  var AUTH_KEY = 'tdot_admin_key';

  /* ── Auth ──────────────────────────────────────────────────────── */
  function checkAuth() {
    var key = sessionStorage.getItem(AUTH_KEY);
    if (key) { showDashboard(); } else { showLogin(); }
  }

  function showLogin() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('dashboard').classList.remove('visible');
    document.getElementById('api-key-input').value = '';
    document.getElementById('login-error').style.display = 'none';
  }

  function showDashboard() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('dashboard').classList.add('visible');
    initDashboard();
  }

  function handleLogin() {
    var key  = document.getElementById('api-key-input').value.trim();
    var btn  = document.getElementById('login-btn');
    var errEl = document.getElementById('login-error');
    if (!key) return;

    btn.disabled = true;
    btn.textContent = 'Verifying\u2026';
    errEl.style.display = 'none';

    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(res) {
        if (res.status === 401 || res.status === 403 || res.status === 503) {
          return res.json().then(function(d) { throw new Error(d.error || 'Invalid API key'); });
        }
        return res.json();
      })
      .then(function() {
        sessionStorage.setItem(AUTH_KEY, key);
        showDashboard();
      })
      .catch(function(e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      })
      .finally(function() {
        btn.disabled = false;
        btn.textContent = 'Unlock Dashboard';
      });
  }

  function logout() {
    sessionStorage.removeItem(AUTH_KEY);
    showLogin();
  }

  /* ── Dashboard Init ─────────────────────────────────────────────── */
  function initDashboard() {
    restoreLog();
    updateClock();
    setInterval(updateClock, 1000);
    checkSystemStatus();
  }

  function updateClock() {
    var now  = new Date();
    var time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    document.getElementById('hdr-time').textContent = date + '  \u00b7  ' + time;
  }

  function checkSystemStatus() {
    var dot  = document.getElementById('sys-dot');
    var txt  = document.getElementById('sys-text');
    var mon  = document.getElementById('stat-monday');
    var key  = sessionStorage.getItem(AUTH_KEY);

    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.connected) {
          dot.style.background = '#4ade80';
          txt.textContent = 'Online';
          mon.textContent = '\u2713 Connected';
          mon.style.color = 'var(--green)';
          mon.style.fontSize = '14px';
        } else { throw new Error('offline'); }
      })
      .catch(function() {
        dot.style.background = '#f87171';
        dot.style.animation  = 'none';
        txt.textContent = 'Monday API Offline';
        mon.textContent = '\u2717 Error';
        mon.style.color = 'var(--red)';
        mon.style.fontSize = '14px';
      });
  }

  /* ── Engine Triggers ───────────────────────────────────────────── */
  function triggerEngine(endpoint, label, id) {
    var btn  = document.getElementById('btn-' + id);
    var dot  = document.getElementById('dot-' + id);
    var txt  = document.getElementById('txt-' + id);
    var key  = sessionStorage.getItem(AUTH_KEY);

    btn.disabled = true;
    btn.classList.add('running');
    btn.textContent = '\u27f3 Triggering\u2026';
    dot.classList.add('running');
    txt.textContent = 'Triggering\u2026';
    addLog('running', label + ' \u2014 triggering\u2026');

    return fetch(endpoint, {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }
    })
    .then(function(res) {
      return res.json().then(function(d) {
        if (!res.ok) throw new Error(d.error || 'Request failed (' + res.status + ')');
        return d;
      });
    })
    .then(function() {
      btn.classList.remove('running');
      btn.classList.add('success');
      btn.textContent = '\u2713 Triggered';
      dot.classList.remove('running');
      dot.classList.add('success');
      txt.textContent = 'Running in background\u2026';
      addLog('success', label + ' \u2014 triggered. Running in background.');
      document.getElementById('stat-last').textContent =
        new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      setTimeout(function() {
        btn.classList.remove('success');
        btn.disabled = false;
        btn.textContent = '\u25b6 Run Now';
        dot.classList.remove('success');
        txt.textContent = 'Last run: ' +
          new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      }, 4000);
    })
    .catch(function(e) {
      btn.classList.remove('running');
      btn.classList.add('error');
      btn.textContent = '\u2717 Failed';
      dot.classList.remove('running', 'success');
      dot.classList.add('error');
      txt.textContent = 'Error: ' + e.message;
      addLog('error', label + ' \u2014 ' + e.message);

      setTimeout(function() {
        btn.classList.remove('error');
        btn.disabled = false;
        btn.textContent = '\u25b6 Run Now';
        dot.classList.remove('error');
        txt.textContent = 'Ready';
      }, 5000);
    });
  }

  var ENGINES = [
    { ep: '/api/readiness/run',  label: 'Case Readiness Engine', id: 'readiness'  },
    { ep: '/api/sla/run',        label: 'SLA & Risk Engine',     id: 'sla'        },
    { ep: '/api/expiry/run',     label: 'Expiry Risk Engine',    id: 'expiry'     },
    { ep: '/api/health/run',     label: 'Case Health Engine',    id: 'health'     },
    { ep: '/api/escalation/run', label: 'Escalation Routing',    id: 'escalation' },
    { ep: '/api/chasing/run',    label: 'Client Chasing Loop',   id: 'chasing'    },
  ];

  function runFullSequence() {
    var btn = document.getElementById('run-all-btn');
    btn.disabled = true;
    btn.textContent = '\u27f3 Running\u2026';
    addLog('info', 'Full daily sequence started \u2014 triggering all 6 engines\u2026');

    var chain = Promise.resolve();
    ENGINES.forEach(function(eng) {
      chain = chain
        .then(function() { return triggerEngine(eng.ep, eng.label, eng.id); })
        .then(function() { return new Promise(function(r) { setTimeout(r, 700); }); });
    });

    chain.then(function() {
      btn.disabled = false;
      btn.textContent = '\u25b6 Run All';
      addLog('success', 'Full sequence complete \u2014 all 6 engines triggered.');
    }).catch(function() {
      btn.disabled = false;
      btn.textContent = '\u25b6 Run All';
    });
  }

  /* ── Utilities ─────────────────────────────────────────────────── */
  function testMondayApi() {
    var btn    = document.getElementById('btn-api-test');
    var inline = document.getElementById('api-test-inline');
    var result = document.getElementById('api-test-result');
    var key    = sessionStorage.getItem(AUTH_KEY);

    btn.disabled = true;
    btn.textContent = '\u27f3 Testing\u2026';
    inline.textContent = '';
    result.textContent = '';
    result.style.color = 'var(--text-muted)';

    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.connected) throw new Error('Not connected');
        btn.classList.add('success');
        btn.textContent = '\u2713 Connected';
        inline.style.color = 'var(--green)';
        inline.textContent = d.account.name + ' \u2014 ' + d.account.email;
        result.style.color = 'var(--green)';
        result.textContent = 'Monday API connection is healthy.';
        addLog('success', 'Monday API connected \u2014 ' + d.account.name + ' (' + d.account.email + ')');
      })
      .catch(function(e) {
        btn.classList.add('error');
        btn.textContent = '\u2717 Failed';
        result.style.color = 'var(--red)';
        result.textContent = 'Connection failed: ' + e.message;
        addLog('error', 'Monday API test failed \u2014 ' + e.message);
      })
      .finally(function() {
        setTimeout(function() {
          btn.classList.remove('success', 'error');
          btn.disabled = false;
          btn.textContent = 'Test Connection';
        }, 5000);
      });
  }

  function resendIntake() {
    var itemId = document.getElementById('intake-item-id').value.trim();
    var btn    = document.getElementById('btn-resend');
    var result = document.getElementById('resend-result');
    var key    = sessionStorage.getItem(AUTH_KEY);

    result.style.color = 'var(--text-muted)';
    result.textContent = '';

    if (!itemId || !/^[0-9]+$/.test(itemId)) {
      result.style.color = 'var(--red)';
      result.textContent = 'Please enter a valid numeric Monday.com item ID.';
      return;
    }

    btn.disabled = true;
    btn.textContent = '\u27f3 Sending\u2026';

    fetch('/api/resend-intake/' + itemId, {
      method: 'POST',
      headers: { 'X-Api-Key': key }
    })
    .then(function(r) {
      return r.json().then(function(d) {
        if (!r.ok) throw new Error(d.error || 'Failed (' + r.status + ')');
        return d;
      });
    })
    .then(function() {
      btn.classList.add('success');
      btn.textContent = '\u2713 Sent';
      result.style.color = 'var(--green)';
      result.textContent = 'Intake email queued for item ' + itemId + '.';
      addLog('success', 'Resend intake email \u2014 item ' + itemId + ' queued.');
    })
    .catch(function(e) {
      btn.classList.add('error');
      btn.textContent = '\u2717 Failed';
      result.style.color = 'var(--red)';
      result.textContent = 'Error: ' + e.message;
      addLog('error', 'Resend intake failed for item ' + itemId + ' \u2014 ' + e.message);
    })
    .finally(function() {
      setTimeout(function() {
        btn.classList.remove('success', 'error');
        btn.disabled = false;
        btn.textContent = 'Send';
      }, 4000);
    });
  }

  /* ── Activity Log ──────────────────────────────────────────────── */
  function addLog(type, msg) {
    var body  = document.getElementById('log-body');
    var empty = document.getElementById('log-empty');
    if (empty) empty.remove();

    var icons = { success: '\u2713', error: '\u2717', info: 'i', running: '\u27f3' };
    var ts    = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    var entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML =
      '<span class="log-ts">' + ts + '</span>' +
      '<span class="log-ico">' + (icons[type] || '\u2022') + '</span>' +
      '<span class="log-msg ' + type + '">' + msg + '</span>';

    body.insertBefore(entry, body.firstChild);

    var stored = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    stored.unshift({ type: type, msg: msg, ts: ts });
    if (stored.length > 40) stored.length = 40;
    sessionStorage.setItem(LOG_KEY, JSON.stringify(stored));
  }

  function restoreLog() {
    var stored = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    if (!stored.length) return;
    var body  = document.getElementById('log-body');
    var empty = document.getElementById('log-empty');
    if (empty) empty.remove();
    var icons = { success: '\u2713', error: '\u2717', info: 'i', running: '\u27f3' };
    stored.forEach(function(item) {
      var entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.innerHTML =
        '<span class="log-ts">' + item.ts + '</span>' +
        '<span class="log-ico">' + (icons[item.type] || '\u2022') + '</span>' +
        '<span class="log-msg ' + item.type + '">' + item.msg + '</span>';
      body.appendChild(entry);
    });
  }

  function clearLog() {
    sessionStorage.removeItem(LOG_KEY);
    document.getElementById('log-body').innerHTML =
      '<div class="log-empty" id="log-empty">No activity yet \u2014 trigger an engine above to get started</div>';
  }

  /* ── Keyboard Support ──────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('api-key-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('intake-item-id').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') resendIntake();
    });
    checkAuth();
  });
</script>

</body>
</html>`;
}

router.get('/', (_req, res) => {
  res.type('html').send(buildAdminHTML());
});

module.exports = router;
