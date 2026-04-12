/**
 * Shared admin layout primitives.
 * Used by adminLogin, adminDashboard, and adminEngines.
 */

// ─── TDOT Logo SVG (inline, adapts to context via fill param) ────────────────
const TDOT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 52" height="40" role="img" aria-label="TDOT Immigration">
  <!-- Icon box -->
  <rect width="52" height="52" rx="11" fill="#e65100"/>
  <!-- "T" lettermark -->
  <rect x="14" y="14" width="24" height="5" rx="2.5" fill="white"/>
  <rect x="23" y="14" width="6" height="24" rx="2.5" fill="white"/>
  <!-- Wordmark -->
  <text x="66" y="23" font-family="'Inter','Helvetica Neue',Arial,sans-serif" font-size="17" font-weight="800" fill="white" letter-spacing="-0.5">TDOT</text>
  <text x="66" y="39" font-family="'Inter','Helvetica Neue',Arial,sans-serif" font-size="9.5" font-weight="600" fill="rgba(255,255,255,0.55)" letter-spacing="2.5">IMMIGRATION</text>
</svg>`;

// ─── Dark variant for login page (coloured background) ───────────────────────
const TDOT_LOGO_SVG_LARGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" height="80" role="img" aria-label="TDOT Immigration">
  <!-- Icon box -->
  <rect width="80" height="80" rx="18" fill="#e65100"/>
  <!-- "T" lettermark -->
  <rect x="18" y="20" width="44" height="9" rx="4.5" fill="white"/>
  <rect x="35.5" y="20" width="9" height="40" rx="4.5" fill="white"/>
</svg>`;

// ─── Shared CSS variables + reset ────────────────────────────────────────────
const SHARED_CSS_VARS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --navy:         #1a3558;
    --navy-dark:    #111f35;
    --navy-light:   #224472;
    --navy-mid:     #1e3a5f;
    --orange:       #e65100;
    --orange-light: #ff6d00;
    --orange-pale:  #fff3ee;
    --green:        #16a34a;
    --green-bg:     #f0fdf4;
    --red:          #dc2626;
    --red-bg:       #fef2f2;
    --amber:        #d97706;
    --amber-bg:     #fffbeb;
    --blue:         #2563eb;
    --bg:           #f0f4f8;
    --card:         #ffffff;
    --border:       #e2e8f0;
    --text:         #1a202c;
    --muted:        #64748b;
    --light:        #94a3b8;
    --sidebar-w:    220px;
    --header-h:     60px;
    --shadow-sm:    0 1px 3px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04);
    --shadow-md:    0 4px 8px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05);
    --shadow-lg:    0 12px 28px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06);
    --r:            12px;
    --r-sm:         8px;
  }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
`;

// ─── Shared top navigation bar ────────────────────────────────────────────────
//  activePage: 'dashboard' | 'engines'
function buildNavHeader(activePage) {
  const isDash = activePage === 'dashboard';
  const isEng  = activePage === 'engines';

  return `<header class="admin-hdr">
  <div class="admin-hdr-left">
    <div class="admin-brand">
      ${TDOT_LOGO_SVG}
    </div>
    <div class="admin-divider"></div>
    <nav class="admin-nav">
      <a href="/admin/dashboard" class="nav-lnk${isDash ? ' active' : ''}">
        <span class="nav-icon">📊</span> Dashboard
      </a>
      <a href="/admin/engines" class="nav-lnk${isEng ? ' active' : ''}">
        <span class="nav-icon">⚙️</span> Engine Controls
      </a>
    </nav>
  </div>
  <div class="admin-hdr-right">
    <div class="status-pill" id="status-pill">
      <div class="status-dot pulse" id="sys-dot"></div>
      <span id="sys-text">Checking…</span>
    </div>
    <span class="hdr-clock" id="hdr-time"></span>
    <button class="sign-out-btn" onclick="signOut()">Sign Out</button>
  </div>
</header>`;
}

// ─── Shared nav CSS ───────────────────────────────────────────────────────────
const NAV_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');

  .admin-hdr {
    height: var(--header-h);
    background: linear-gradient(90deg, var(--navy-dark) 0%, var(--navy-mid) 100%);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 28px;
    position: sticky; top: 0; z-index: 300;
    box-shadow: 0 2px 16px rgba(0,0,0,.25);
  }

  .admin-hdr-left {
    display: flex; align-items: center; gap: 0;
  }

  .admin-brand {
    display: flex; align-items: center;
    padding-right: 22px;
  }

  .admin-divider {
    width: 1px; height: 28px;
    background: rgba(255,255,255,.15);
    margin-right: 20px;
  }

  .admin-nav {
    display: flex; align-items: center; gap: 4px;
  }

  .nav-lnk {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 14px;
    border-radius: 8px;
    font-size: 13px; font-weight: 600;
    color: rgba(255,255,255,.65);
    text-decoration: none;
    transition: background .15s, color .15s;
    letter-spacing: -.1px;
  }

  .nav-lnk:hover { background: rgba(255,255,255,.1); color: white; }

  .nav-lnk.active {
    background: rgba(255,255,255,.14);
    color: white;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.15);
  }

  .nav-lnk.active::after {
    display: none;
  }

  .nav-icon { font-size: 14px; }

  .admin-hdr-right {
    display: flex; align-items: center; gap: 14px;
  }

  .status-pill {
    display: flex; align-items: center; gap: 7px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.14);
    padding: 5px 13px;
    border-radius: 20px;
    font-size: 12px; font-weight: 500;
    color: rgba(255,255,255,.8);
  }

  .status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #4ade80;
    flex-shrink: 0;
  }

  .status-dot.pulse { animation: dot-pulse 2s infinite; }
  .status-dot.offline { background: #f87171; animation: none; }

  @keyframes dot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .35; }
  }

  .hdr-clock {
    font-size: 11px;
    color: rgba(255,255,255,.45);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .sign-out-btn {
    background: rgba(255,255,255,.09);
    border: 1px solid rgba(255,255,255,.18);
    color: rgba(255,255,255,.75);
    padding: 6px 14px;
    border-radius: 7px;
    font-size: 12px; font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all .15s;
    letter-spacing: -.1px;
  }

  .sign-out-btn:hover {
    background: rgba(255,255,255,.18);
    color: white;
    border-color: rgba(255,255,255,.3);
  }

  @media (max-width: 700px) {
    .hdr-clock { display: none; }
    .admin-hdr { padding: 0 16px; }
    .nav-lnk span.nav-icon ~ * { display: none; }
  }
`;

// ─── Shared auth + clock JS (injected into every protected page) ──────────────
const SHARED_AUTH_JS = `
  function getKey() {
    var k = sessionStorage.getItem('tdot_admin_key');
    if (!k) { window.location.replace('/admin'); return null; }
    return k;
  }

  function signOut() {
    sessionStorage.removeItem('tdot_admin_key');
    window.location.replace('/admin');
  }

  function startClock() {
    function tick() {
      var el = document.getElementById('hdr-time');
      if (!el) return;
      var now = new Date();
      el.textContent =
        now.toLocaleDateString('en-GB',  { weekday: 'short', day: 'numeric', month: 'short' }) + '  ·  ' +
        now.toLocaleTimeString('en-GB',  { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    tick();
    setInterval(tick, 1000);
  }

  function checkApiStatus() {
    var key = getKey();
    if (!key) return;
    var dot = document.getElementById('sys-dot');
    var txt = document.getElementById('sys-text');
    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.connected) {
          dot.className = 'status-dot pulse';
          txt.textContent = 'Online';
        } else { throw new Error(); }
      })
      .catch(function() {
        if (dot) { dot.className = 'status-dot offline'; }
        if (txt) { txt.textContent = 'Monday API Offline'; }
      });
  }
`;

module.exports = {
  TDOT_LOGO_SVG,
  TDOT_LOGO_SVG_LARGE,
  SHARED_CSS_VARS,
  NAV_CSS,
  SHARED_AUTH_JS,
  buildNavHeader,
};
