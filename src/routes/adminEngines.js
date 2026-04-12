/**
 * Admin — Engine Controls
 * Served at GET /admin/engines
 * Requires authentication (redirects to /admin if no key in sessionStorage).
 */

const express = require('express');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS } = require('./adminShared');

function buildEnginesHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — Engine Controls</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
    ${SHARED_CSS_VARS}
    ${NAV_CSS}

    /* ── Page layout ──────────────────────────────── */
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px 72px;
    }

    /* ── Stat strip ───────────────────────────────── */
    .stat-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 28px;
    }

    .stat-card {
      background: var(--card);
      border-radius: var(--r);
      padding: 18px 20px;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
    }

    .stat-label {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1px;
      color: var(--light); margin-bottom: 10px;
    }

    .stat-value {
      font-size: 22px; font-weight: 800;
      color: var(--navy); letter-spacing: -.5px;
      line-height: 1;
    }

    .stat-value.green  { color: var(--green); }
    .stat-value.muted  { font-size: 14px; font-weight: 600; color: var(--muted); }

    /* ── Section heading ──────────────────────────── */
    .sec-hd {
      display: flex; align-items: baseline; gap: 10px;
      margin-bottom: 18px;
    }

    .sec-title {
      font-size: 17px; font-weight: 800;
      color: var(--navy); letter-spacing: -.3px;
    }

    .sec-hint { font-size: 12px; color: var(--muted); }

    /* ── Run-all banner ───────────────────────────── */
    .run-all-banner {
      background: linear-gradient(135deg, var(--navy-dark) 0%, var(--navy-light) 100%);
      border-radius: var(--r);
      padding: 20px 24px;
      display: flex; align-items: center; gap: 18px;
      margin-bottom: 28px;
      box-shadow: var(--shadow-md);
    }

    .run-all-icon { font-size: 28px; flex-shrink: 0; }

    .run-all-text { flex: 1; }

    .run-all-title {
      font-size: 15px; font-weight: 800;
      color: white; letter-spacing: -.2px; margin-bottom: 3px;
    }

    .run-all-sub { font-size: 12px; color: rgba(255,255,255,.58); }

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
      box-shadow: 0 4px 14px rgba(230,81,0,.38);
    }

    .run-all-btn:hover { background: var(--orange-light); transform: scale(1.02); }
    .run-all-btn:active { transform: scale(.98); }
    .run-all-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }

    /* ── Engine grid ──────────────────────────────── */
    .engines-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 28px;
    }

    .engine-card {
      background: var(--card);
      border-radius: var(--r);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      overflow: hidden;
      display: flex; flex-direction: column;
      transition: box-shadow .2s, transform .2s;
    }

    .engine-card:hover {
      box-shadow: var(--shadow-md);
      transform: translateY(-2px);
    }

    .engine-hd {
      padding: 15px 18px 13px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: flex-start; gap: 12px;
    }

    .engine-icon {
      width: 44px; height: 44px;
      border-radius: 11px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; flex-shrink: 0;
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
      color: var(--navy); line-height: 1.25;
    }

    .engine-body {
      padding: 13px 18px;
      flex: 1;
    }

    .engine-desc {
      font-size: 12px; color: var(--muted);
      line-height: 1.65; margin-bottom: 12px;
    }

    .e-status-row { display: flex; align-items: center; gap: 7px; }

    .e-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #cbd5e0;
      flex-shrink: 0;
    }

    .e-dot.running { background: var(--orange); animation: dot-pulse 1s infinite; }
    .e-dot.success { background: var(--green); }
    .e-dot.error   { background: var(--red); }

    @keyframes dot-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

    .e-status-txt {
      font-size: 11px; font-weight: 500;
      color: var(--muted);
    }

    .engine-ft {
      padding: 11px 18px;
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
    .run-btn:disabled  { opacity: .45; cursor: not-allowed; }
    .run-btn.running   { background: #92400e; }
    .run-btn.success   { background: var(--green); }
    .run-btn.error     { background: var(--red); }

    /* ── Utilities ────────────────────────────────── */
    .utils-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 28px;
    }

    .util-card {
      background: var(--card);
      border-radius: var(--r);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      padding: 22px 22px 20px;
    }

    .util-title {
      font-size: 14px; font-weight: 700;
      color: var(--navy); margin-bottom: 5px;
    }

    .util-desc {
      font-size: 12px; color: var(--muted);
      margin-bottom: 16px; line-height: 1.6;
    }

    .util-row { display: flex; gap: 8px; align-items: center; }

    .util-input {
      flex: 1;
      padding: 9px 12px;
      border: 2px solid var(--border);
      border-radius: 7px;
      font-size: 13px; font-family: inherit;
      outline: none; background: #fafbfc;
      transition: border-color .15s;
    }

    .util-input:focus { border-color: var(--navy); background: white; }

    .btn-sm {
      padding: 9px 18px;
      background: var(--navy);
      color: white; border: none;
      border-radius: 7px;
      font-size: 13px; font-weight: 700;
      font-family: inherit; cursor: pointer;
      transition: background .15s;
      white-space: nowrap;
    }

    .btn-sm:hover:not(:disabled) { background: var(--navy-light); }
    .btn-sm:disabled { opacity: .5; cursor: not-allowed; }
    .btn-sm.success  { background: var(--green); }
    .btn-sm.error    { background: var(--red); }

    .util-result {
      font-size: 12px; margin-top: 10px;
      color: var(--muted); min-height: 18px;
    }

    /* ── Activity log ─────────────────────────────── */
    .log-card {
      background: var(--card);
      border-radius: var(--r);
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
      overflow: hidden;
    }

    .log-hd {
      padding: 15px 22px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }

    .log-hd-title {
      font-size: 15px; font-weight: 800;
      color: var(--navy); letter-spacing: -.2px;
    }

    .clear-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 4px 11px; border-radius: 6px;
      font-size: 11px; font-weight: 500;
      cursor: pointer; font-family: inherit;
      transition: all .15s;
    }

    .clear-btn:hover { border-color: var(--red); color: var(--red); }

    .log-body { max-height: 380px; overflow-y: auto; }

    .log-empty {
      padding: 40px 22px;
      text-align: center; color: var(--light); font-size: 13px;
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
      color: var(--light); white-space: nowrap;
      margin-top: 2px; min-width: 42px;
      font-variant-numeric: tabular-nums;
    }

    .log-ico { font-size: 13px; margin-top: 1px; }

    .log-msg { flex: 1; font-size: 13px; color: var(--text); }
    .log-msg.success { color: var(--green); }
    .log-msg.error   { color: var(--red); }
    .log-msg.info    { color: var(--blue); }
    .log-msg.running { color: var(--amber); }

    /* ── Footer ───────────────────────────────────── */
    .site-footer {
      text-align: center; padding: 24px;
      font-size: 11px; color: var(--light);
      border-top: 1px solid var(--border); margin-top: 48px;
    }

    /* ── Responsive ───────────────────────────────── */
    @media (max-width: 960px) {
      .engines-grid { grid-template-columns: 1fr 1fr; }
      .stat-strip   { grid-template-columns: 1fr 1fr; }
    }

    @media (max-width: 600px) {
      .engines-grid, .stat-strip, .utils-grid { grid-template-columns: 1fr; }
      .wrap { padding: 16px 12px 48px; }
    }
  </style>
</head>
<body>

${buildNavHeader('engines')}

<main class="wrap">

  <!-- Stat strip -->
  <div class="stat-strip">
    <div class="stat-card">
      <div class="stat-label">Daily Schedule</div>
      <div class="stat-value" style="font-size:18px;font-weight:700">07:00 daily</div>
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
      <div class="stat-label">Monday API</div>
      <div class="stat-value muted" id="stat-monday">—</div>
    </div>
  </div>

  <!-- Run all -->
  <div class="run-all-banner">
    <div class="run-all-icon">⚡</div>
    <div class="run-all-text">
      <div class="run-all-title">Run Full Daily Sequence</div>
      <div class="run-all-sub">Triggers all 6 engines in order: Readiness → SLA → Expiry → Health → Escalation → Chasing</div>
    </div>
    <button class="run-all-btn" id="run-all-btn" onclick="runAll()">▶ Run All</button>
  </div>

  <!-- Engines section -->
  <div class="sec-hd">
    <h2 class="sec-title">Automation Engines</h2>
    <span class="sec-hint">Engines run sequentially every morning at 07:00 — trigger individually for immediate execution</span>
  </div>

  <div class="engines-grid">

    <div class="engine-card">
      <div class="engine-hd">
        <div class="engine-icon" style="background:#eff6ff">📋</div>
        <div>
          <div class="engine-badge">Step 1 of 6</div>
          <div class="engine-name">Case Readiness Engine</div>
        </div>
      </div>
      <div class="engine-body">
        <p class="engine-desc">Calculates Q + Doc readiness scores, writes to Client Master Board, and triggers stage gates (Internal Review / Submission Prep).</p>
        <div class="e-status-row">
          <div class="e-dot" id="dot-readiness"></div>
          <span class="e-status-txt" id="txt-readiness">Ready</span>
        </div>
      </div>
      <div class="engine-ft">
        <button class="run-btn" id="btn-readiness" onclick="triggerEngine('/api/readiness/run','Case Readiness Engine','readiness')">▶ Run Now</button>
      </div>
    </div>

    <div class="engine-card">
      <div class="engine-hd">
        <div class="engine-icon" style="background:#fff7ed">⏱️</div>
        <div>
          <div class="engine-badge">Step 2 of 6</div>
          <div class="engine-name">SLA &amp; Risk Engine</div>
        </div>
      </div>
      <div class="engine-body">
        <p class="engine-desc">Sets Risk Band (Green / Orange / Red), Days Elapsed, and Expiry Flag. Forces band to Orange/Red when deadlines or expiry dates are near.</p>
        <div class="e-status-row">
          <div class="e-dot" id="dot-sla"></div>
          <span class="e-status-txt" id="txt-sla">Ready</span>
        </div>
      </div>
      <div class="engine-ft">
        <button class="run-btn" id="btn-sla" onclick="triggerEngine('/api/sla/run','SLA \u0026 Risk Engine','sla')">▶ Run Now</button>
      </div>
    </div>

    <div class="engine-card">
      <div class="engine-hd">
        <div class="engine-icon" style="background:#fef2f2">⚠️</div>
        <div>
          <div class="engine-badge">Step 3 of 6</div>
          <div class="engine-name">Expiry Risk Engine</div>
        </div>
      </div>
      <div class="engine-body">
        <p class="engine-desc">Detects new and escalating expiry flags (passport, IELTS, medical). Sets Escalation Required and emails the assigned supervisor.</p>
        <div class="e-status-row">
          <div class="e-dot" id="dot-expiry"></div>
          <span class="e-status-txt" id="txt-expiry">Ready</span>
        </div>
      </div>
      <div class="engine-ft">
        <button class="run-btn" id="btn-expiry" onclick="triggerEngine('/api/expiry/run','Expiry Risk Engine','expiry')">▶ Run Now</button>
      </div>
    </div>

    <div class="engine-card">
      <div class="engine-hd">
        <div class="engine-icon" style="background:#f0fdf4">❤️</div>
        <div>
          <div class="engine-badge">Step 4 of 6</div>
          <div class="engine-name">Case Health Engine</div>
        </div>
      </div>
      <div class="engine-body">
        <p class="engine-desc">Synthesises all signals into Case Health Status, Client Delay Level, Client Responsiveness Score, and Client-Blocked Status.</p>
        <div class="e-status-row">
          <div class="e-dot" id="dot-health"></div>
          <span class="e-status-txt" id="txt-health">Ready</span>
        </div>
      </div>
      <div class="engine-ft">
        <button class="run-btn" id="btn-health" onclick="triggerEngine('/api/health/run','Case Health Engine','health')">▶ Run Now</button>
      </div>
    </div>

    <div class="engine-card">
      <div class="engine-hd">
        <div class="engine-icon" style="background:#fdf4ff">🔔</div>
        <div>
          <div class="engine-badge">Step 5 of 6</div>
          <div class="engine-name">Escalation Routing</div>
        </div>
      </div>
      <div class="engine-body">
        <p class="engine-desc">Matches Orange/Red cases to Escalation Matrix rules. Notifies supervisors and directors. Applies stage and SLA override actions.</p>
        <div class="e-status-row">
          <div class="e-dot" id="dot-escalation"></div>
          <span class="e-status-txt" id="txt-escalation">Ready</span>
        </div>
      </div>
      <div class="engine-ft">
        <button class="run-btn" id="btn-escalation" onclick="triggerEngine('/api/escalation/run','Escalation Routing','escalation')">▶ Run Now</button>
      </div>
    </div>

    <div class="engine-card">
      <div class="engine-hd">
        <div class="engine-icon" style="background:#fffbeb">📧</div>
        <div>
          <div class="engine-badge">Step 6 of 6</div>
          <div class="engine-name">Client Chasing Loop</div>
        </div>
      </div>
      <div class="engine-body">
        <p class="engine-desc">Sends timed reminder emails based on SLA offsets (R1 → R2 → Final Notice). Advances stage and sets Client Blocked when unresponsive.</p>
        <div class="e-status-row">
          <div class="e-dot" id="dot-chasing"></div>
          <span class="e-status-txt" id="txt-chasing">Ready</span>
        </div>
      </div>
      <div class="engine-ft">
        <button class="run-btn" id="btn-chasing" onclick="triggerEngine('/api/chasing/run','Client Chasing Loop','chasing')">▶ Run Now</button>
      </div>
    </div>

  </div><!-- /engines-grid -->

  <!-- Utilities -->
  <div class="sec-hd">
    <h2 class="sec-title">Utilities</h2>
  </div>

  <div class="utils-grid">

    <div class="util-card">
      <div class="util-title">🔗 Monday.com API Connection</div>
      <div class="util-desc">Verify the Monday.com integration is live and confirm which account the automation is authenticated as.</div>
      <div class="util-row">
        <button class="btn-sm" id="btn-api-test" onclick="testMonday()">Test Connection</button>
        <span id="api-test-inline" style="font-size:12px;color:var(--muted);margin-left:8px"></span>
      </div>
      <div class="util-result" id="api-test-result"></div>
    </div>

    <div class="util-card">
      <div class="util-title">📬 Resend Intake Email</div>
      <div class="util-desc">Resend the intake questionnaire email for a specific Client Master item. Use when a token was missing or a link was broken.</div>
      <div class="util-row">
        <input type="text" class="util-input" id="intake-id" placeholder="Monday.com Item ID (e.g. 1234567890)" />
        <button class="btn-sm" id="btn-resend" onclick="resendIntake()">Send</button>
      </div>
      <div class="util-result" id="resend-result"></div>
    </div>

  </div>

  <!-- Activity Log -->
  <div class="sec-hd">
    <h2 class="sec-title">Activity Log</h2>
    <span class="sec-hint">Session only — clears on sign out</span>
  </div>

  <div class="log-card">
    <div class="log-hd">
      <span class="log-hd-title">Recent Actions</span>
      <button class="clear-btn" onclick="clearLog()">Clear</button>
    </div>
    <div class="log-body" id="log-body">
      <div class="log-empty" id="log-empty">No activity yet — trigger an engine above to get started</div>
    </div>
  </div>

</main>

<footer class="site-footer">
  TDOT Immigration Automation Platform &nbsp;·&nbsp; Engine Controls &nbsp;·&nbsp; v2.0
</footer>

<script>
  var LOG_KEY = 'tdot_admin_log';

  ${SHARED_AUTH_JS}

  /* ── Init ──────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function() {
    if (!getKey()) return;
    startClock();
    checkApiStatus();
    restoreLog();
    updateMondayStatBadge();
    document.getElementById('intake-id').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') resendIntake();
    });
  });

  function updateMondayStatBadge() {
    var key = getKey(); if (!key) return;
    var el = document.getElementById('stat-monday');
    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.connected) {
          el.textContent = '\u2713 Connected';
          el.style.color = 'var(--green)';
          el.style.fontSize = '14px';
        } else throw new Error();
      })
      .catch(function() {
        el.textContent = '\u2717 Offline';
        el.style.color = 'var(--red)';
        el.style.fontSize = '14px';
      });
  }

  /* ── Engine trigger ─────────────────────────────────────────────── */
  function triggerEngine(endpoint, label, id) {
    var btn = document.getElementById('btn-' + id);
    var dot = document.getElementById('dot-' + id);
    var txt = document.getElementById('txt-' + id);
    var key = getKey(); if (!key) return Promise.resolve();

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
    .then(function(r) {
      return r.json().then(function(d) {
        if (!r.ok) throw new Error(d.error || 'Failed (' + r.status + ')');
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
      addLog('success', label + ' \u2014 triggered successfully.');
      document.getElementById('stat-last').textContent =
        new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      setTimeout(function() {
        btn.classList.remove('success'); btn.disabled = false;
        btn.textContent = '\u25b6 Run Now';
        dot.classList.remove('success');
        txt.textContent = 'Last triggered: ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      }, 4000);
    })
    .catch(function(e) {
      btn.classList.remove('running'); btn.classList.add('error');
      btn.textContent = '\u2717 Failed';
      dot.classList.remove('running'); dot.classList.add('error');
      txt.textContent = 'Error: ' + e.message;
      addLog('error', label + ' \u2014 ' + e.message);
      setTimeout(function() {
        btn.classList.remove('error'); btn.disabled = false;
        btn.textContent = '\u25b6 Run Now';
        dot.classList.remove('error'); txt.textContent = 'Ready';
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

  function runAll() {
    var btn = document.getElementById('run-all-btn');
    btn.disabled = true;
    btn.textContent = '\u27f3 Running sequence\u2026';
    addLog('info', 'Full daily sequence started \u2014 triggering all 6 engines\u2026');
    var chain = Promise.resolve();
    ENGINES.forEach(function(eng) {
      chain = chain
        .then(function() { return triggerEngine(eng.ep, eng.label, eng.id); })
        .then(function() { return new Promise(function(r) { setTimeout(r, 700); }); });
    });
    chain.then(function() {
      btn.disabled = false; btn.textContent = '\u25b6 Run All';
      addLog('success', 'Full sequence complete \u2014 all 6 engines triggered.');
    }).catch(function() {
      btn.disabled = false; btn.textContent = '\u25b6 Run All';
    });
  }

  /* ── Utilities ──────────────────────────────────────────────────── */
  function testMonday() {
    var btn = document.getElementById('btn-api-test');
    var inl = document.getElementById('api-test-inline');
    var res = document.getElementById('api-test-result');
    var key = getKey(); if (!key) return;
    btn.disabled = true; btn.textContent = '\u27f3 Testing\u2026';
    inl.textContent = ''; res.textContent = ''; res.style.color = 'var(--muted)';
    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.connected) throw new Error('Not connected');
        btn.classList.add('success'); btn.textContent = '\u2713 Connected';
        inl.style.color = 'var(--green)';
        inl.textContent = d.account.name + ' \u2014 ' + d.account.email;
        res.style.color = 'var(--green)'; res.textContent = 'Monday API connection is healthy.';
        addLog('success', 'Monday API \u2014 ' + d.account.name + ' (' + d.account.email + ')');
      })
      .catch(function(e) {
        btn.classList.add('error'); btn.textContent = '\u2717 Failed';
        res.style.color = 'var(--red)'; res.textContent = 'Connection failed: ' + e.message;
        addLog('error', 'Monday API test failed \u2014 ' + e.message);
      })
      .finally(function() {
        setTimeout(function() {
          btn.classList.remove('success', 'error'); btn.disabled = false; btn.textContent = 'Test Connection';
        }, 5000);
      });
  }

  function resendIntake() {
    var itemId = document.getElementById('intake-id').value.trim();
    var btn    = document.getElementById('btn-resend');
    var res    = document.getElementById('resend-result');
    var key    = getKey(); if (!key) return;
    res.style.color = 'var(--muted)'; res.textContent = '';
    if (!itemId || !/^[0-9]+$/.test(itemId)) {
      res.style.color = 'var(--red)';
      res.textContent = 'Please enter a valid numeric Monday.com item ID.';
      return;
    }
    btn.disabled = true; btn.textContent = '\u27f3 Sending\u2026';
    fetch('/api/resend-intake/' + itemId, { method: 'POST', headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); })
      .then(function() {
        btn.classList.add('success'); btn.textContent = '\u2713 Sent';
        res.style.color = 'var(--green)'; res.textContent = 'Intake email queued for item ' + itemId + '.';
        addLog('success', 'Resend intake \u2014 item ' + itemId + ' queued.');
      })
      .catch(function(e) {
        btn.classList.add('error'); btn.textContent = '\u2717 Failed';
        res.style.color = 'var(--red)'; res.textContent = 'Error: ' + e.message;
        addLog('error', 'Resend intake failed \u2014 ' + e.message);
      })
      .finally(function() {
        setTimeout(function() {
          btn.classList.remove('success', 'error'); btn.disabled = false; btn.textContent = 'Send';
        }, 4000);
      });
  }

  /* ── Activity log ───────────────────────────────────────────────── */
  function addLog(type, msg) {
    var body  = document.getElementById('log-body');
    var empty = document.getElementById('log-empty');
    if (empty) empty.remove();
    var icons = { success: '\u2713', error: '\u2717', info: 'i', running: '\u27f3' };
    var ts    = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    var entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = '<span class="log-ts">' + ts + '</span><span class="log-ico">' + (icons[type] || '\u2022') + '</span><span class="log-msg ' + type + '">' + msg + '</span>';
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
      var e = document.createElement('div'); e.className = 'log-entry';
      e.innerHTML = '<span class="log-ts">' + item.ts + '</span><span class="log-ico">' + (icons[item.type] || '\u2022') + '</span><span class="log-msg ' + item.type + '">' + item.msg + '</span>';
      body.appendChild(e);
    });
  }

  function clearLog() {
    sessionStorage.removeItem(LOG_KEY);
    document.getElementById('log-body').innerHTML = '<div class="log-empty" id="log-empty">No activity yet \u2014 trigger an engine above to get started</div>';
  }
</script>

</body>
</html>`;
}

router.get('/', (_req, res) => {
  res.type('html').send(buildEnginesHTML());
});

module.exports = router;
