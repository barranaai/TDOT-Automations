/**
 * Staff Authentication Middleware
 *
 * Validates the tdot_staff JWT cookie set during the Monday OAuth callback.
 * If the cookie is missing or invalid, redirects to the Monday OAuth login flow.
 *
 * Usage:
 *   router.get('/some-staff-route', requireStaffAuth, handler);
 *
 * The JWT payload is attached to req.staff:
 *   { id, name, email }
 */

'use strict';

const jwt = require('jsonwebtoken');

const STAFF_SESSION_SECRET  = process.env.STAFF_SESSION_SECRET;
if (!STAFF_SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('STAFF_SESSION_SECRET must be set in production — refusing to start with insecure default.');
}
const _SECRET = STAFF_SESSION_SECRET || 'dev-staff-secret-ONLY-FOR-LOCAL-DEV';
const COOKIE_NAME           = 'tdot_staff';
const MONDAY_AUTH_START_URL = '/q/auth/monday';

/**
 * Express middleware — requires a valid staff JWT cookie.
 * Preserves the original URL so the OAuth callback can redirect back after login.
 */
function requireStaffAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return redirectToLogin(req, res);
  }

  try {
    req.staff = jwt.verify(token, _SECRET);
    return next();
  } catch (_err) {
    // Expired or tampered — clear the bad cookie and start fresh
    res.clearCookie(COOKIE_NAME);
    return redirectToLogin(req, res);
  }
}

function redirectToLogin(req, res) {
  // Encode the original URL as the post-login destination
  const returnTo = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`${MONDAY_AUTH_START_URL}?returnTo=${returnTo}`);
}

/**
 * Create a signed JWT for a successfully authenticated Monday user.
 * Call this in the OAuth callback handler after verifying the user.
 *
 * @param {{ id, name, email }} staffInfo
 * @returns {string} Signed JWT
 */
function createStaffToken({ id, name, email }) {
  return jwt.sign({ id, name, email }, _SECRET, { expiresIn: '8h' });
}

/**
 * Set the staff session cookie on the response.
 *
 * @param {import('express').Response} res
 * @param {string} token  Signed JWT from createStaffToken()
 */
function setStaffCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
  });
}

/**
 * Non-redirecting staff auth probe.
 * Returns the decoded JWT payload if a valid staff cookie is present,
 * or null otherwise. Use this on routes that serve BOTH staff and clients
 * and need to branch on role without forcing a login redirect.
 *
 * @param {import('express').Request} req
 * @returns {{ id, name, email } | null}
 */
function tryStaffAuth(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, _SECRET);
  } catch {
    return null;
  }
}

module.exports = { requireStaffAuth, tryStaffAuth, createStaffToken, setStaffCookie };
