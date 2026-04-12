/**
 * TDOT Admin — Login page
 * Served at GET /admin
 * If the user is already authenticated (key in sessionStorage),
 * the page immediately redirects to /admin/dashboard.
 * On successful login, stores key and redirects to /admin/dashboard.
 */

const express = require('express');
const router  = express.Router();
const { TDOT_LOGO_SVG_LARGE, SHARED_CSS_VARS } = require('./adminShared');

function buildLoginHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT Immigration — Admin Login</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
    ${SHARED_CSS_VARS}

    html, body {
      height: 100%;
      margin: 0;
    }

    body {
      background: var(--navy-dark);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
    }

    /* ── Background pattern ─────────────────────────── */
    .bg-pattern {
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse at 20% 50%, rgba(230,81,0,.12) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 20%, rgba(255,255,255,.04) 0%, transparent 40%),
        linear-gradient(135deg, #111f35 0%, #1a3558 50%, #224472 100%);
      z-index: 0;
    }

    /* Subtle grid lines */
    .bg-pattern::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
      background-size: 60px 60px;
    }

    /* Orange accent glow (bottom left) */
    .bg-glow {
      position: fixed;
      bottom: -120px;
      left: -80px;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(230,81,0,.18) 0%, transparent 65%);
      z-index: 0;
      pointer-events: none;
    }

    /* ── Login card ─────────────────────────────────── */
    .login-wrap {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 440px;
      padding: 20px;
    }

    .login-card {
      background: rgba(255,255,255,.97);
      border-radius: 20px;
      box-shadow:
        0 0 0 1px rgba(255,255,255,.08),
        0 24px 64px rgba(0,0,0,.35),
        0 8px 24px rgba(0,0,0,.2);
      overflow: hidden;
    }

    /* Orange top stripe */
    .card-stripe {
      height: 5px;
      background: linear-gradient(90deg, var(--orange) 0%, var(--orange-light) 100%);
    }

    .card-body {
      padding: 40px 40px 36px;
      text-align: center;
    }

    /* Logo */
    .logo-wrap {
      margin-bottom: 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }

    .logo-icon {
      filter: drop-shadow(0 8px 20px rgba(230,81,0,.35));
    }

    .logo-wordmark {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }

    .logo-name {
      font-size: 26px;
      font-weight: 900;
      color: var(--navy);
      letter-spacing: -1px;
      line-height: 1;
    }

    .logo-sub {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 3px;
      text-transform: uppercase;
    }

    /* Divider */
    .card-divider {
      height: 1px;
      background: var(--border);
      margin: 0 0 28px;
    }

    /* Heading */
    .login-heading {
      font-size: 18px;
      font-weight: 800;
      color: var(--navy);
      letter-spacing: -.4px;
      margin-bottom: 6px;
    }

    .login-sub {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 28px;
      line-height: 1.5;
    }

    /* Form */
    .field-wrap {
      position: relative;
      margin-bottom: 14px;
      text-align: left;
    }

    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .8px;
      margin-bottom: 6px;
    }

    .field-input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid var(--border);
      border-radius: var(--r-sm);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      color: var(--text);
      background: #fafbfc;
      transition: border-color .15s, box-shadow .15s, background .15s;
    }

    .field-input:focus {
      border-color: var(--navy);
      background: white;
      box-shadow: 0 0 0 3px rgba(26,53,88,.1);
    }

    .field-input::placeholder { color: var(--light); }

    .btn-login {
      width: 100%;
      padding: 13px 24px;
      background: linear-gradient(135deg, var(--orange) 0%, var(--orange-light) 100%);
      color: white;
      border: none;
      border-radius: var(--r-sm);
      font-size: 15px;
      font-weight: 800;
      font-family: inherit;
      cursor: pointer;
      transition: opacity .15s, transform .1s;
      letter-spacing: -.2px;
      box-shadow: 0 4px 16px rgba(230,81,0,.35);
      margin-top: 6px;
    }

    .btn-login:hover { opacity: .92; }
    .btn-login:active { transform: scale(.98); }
    .btn-login:disabled {
      opacity: .55;
      cursor: not-allowed;
      transform: none;
    }

    .error-box {
      display: none;
      margin-top: 14px;
      padding: 10px 14px;
      background: var(--red-bg);
      border: 1px solid #fca5a5;
      border-radius: var(--r-sm);
      color: var(--red);
      font-size: 13px;
      text-align: left;
    }

    /* Footer */
    .card-footer {
      padding: 14px 40px 20px;
      text-align: center;
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--light);
    }

    .card-footer strong { color: var(--muted); }
  </style>
</head>
<body>

<div class="bg-pattern"></div>
<div class="bg-glow"></div>

<div class="login-wrap">
  <div class="login-card">
    <div class="card-stripe"></div>

    <div class="card-body">

      <!-- Logo -->
      <div class="logo-wrap">
        <div class="logo-icon">${TDOT_LOGO_SVG_LARGE}</div>
        <div class="logo-wordmark">
          <div class="logo-name">TDOT</div>
          <div class="logo-sub">Immigration</div>
        </div>
      </div>

      <div class="card-divider"></div>

      <div class="login-heading">Admin Portal</div>
      <div class="login-sub">Sign in with your admin key to access<br>the management dashboard</div>

      <!-- Form -->
      <div class="field-wrap">
        <label class="field-label" for="api-key">Admin API Key</label>
        <input
          type="password"
          id="api-key"
          class="field-input"
          placeholder="Enter your admin key"
          autocomplete="off"
          autofocus
        />
      </div>

      <button class="btn-login" id="login-btn" onclick="handleLogin()">
        Sign In →
      </button>

      <div class="error-box" id="error-box"></div>

    </div><!-- /card-body -->

    <div class="card-footer">
      <strong>TDOT Immigration</strong> &nbsp;·&nbsp; Admin Management Portal &nbsp;·&nbsp; v2.0
    </div>
  </div><!-- /login-card -->
</div><!-- /login-wrap -->

<script>
  /* If already authenticated, skip straight to dashboard */
  (function() {
    var k = sessionStorage.getItem('tdot_admin_key');
    if (k) { window.location.replace('/admin/dashboard'); }
  })();

  function handleLogin() {
    var key  = document.getElementById('api-key').value.trim();
    var btn  = document.getElementById('login-btn');
    var errEl = document.getElementById('error-box');

    errEl.style.display = 'none';

    if (!key) {
      errEl.textContent = 'Please enter your admin API key.';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Verifying\u2026';

    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) {
        if (r.status === 401 || r.status === 403 || r.status === 503) {
          return r.json().then(function(d) {
            throw new Error(d.error || 'Invalid API key. Please check and try again.');
          });
        }
        return r.json();
      })
      .then(function(d) {
        if (!d.connected) throw new Error('Monday.com API is not reachable. Try again shortly.');
        sessionStorage.setItem('tdot_admin_key', key);
        btn.textContent = '\u2713 Success! Redirecting\u2026';
        window.location.replace('/admin/dashboard');
      })
      .catch(function(e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign In \u2192';
      });
  }

  /* Enter key support */
  document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('api-key').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleLogin();
    });
  });
</script>

</body>
</html>`;
}

router.get('/', (_req, res) => {
  res.type('html').send(buildLoginHTML());
});

module.exports = router;
