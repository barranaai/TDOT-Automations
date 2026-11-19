'use strict';

/**
 * The automation checklist, shared with the TDOT management team by a private
 * link that needs no sign-in (Faran 2026-11-19).
 *
 *   GET /share/checklist/<token>  → src/share/checklist.html
 *
 * Rules (do not undo):
 *  - The token itself is NOT in the code or the repo: only its SHA-256 is. The
 *    link was given to Faran. A wrong token answers the same plain 404 as a page
 *    that does not exist, so the path reveals nothing.
 *  - Never linked from the dashboard, the nav bar or any other page (Faran: "do
 *    not add its link to the dashboard"). test/shareChecklist.test.js checks it.
 *  - Kept out of search engines (X-Robots-Tag + robots meta) and never leaks the
 *    link to the font host (Referrer-Policy: no-referrer + referrer meta).
 *  - The page holds no client names or case numbers. Section L of the process
 *    review (private) never goes in it.
 *  - To change the page: edit src/share/checklist.html and deploy. To retire the
 *    link: change TOKEN_SHA256 (a new link) and deploy.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_SHA256 = '2d7b3060e6a68b3178b644227d415d880e2e7e3b2b1a054a2ba6f78fa31d8be4';
const FILE = path.join(__dirname, '..', 'share', 'checklist.html');

const HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

/** True only for the shared token (constant-time compare of the hashes). */
function tokenOk(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false;
  const got = crypto.createHash('sha256').update(token).digest();
  const want = Buffer.from(TOKEN_SHA256, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

let cache = null;
function page() {
  if (cache === null) { try { cache = fs.readFileSync(FILE, 'utf8'); } catch (_) { cache = ''; } }
  return cache;
}

/** Express handler. */
function serve(req, res) {
  const html = tokenOk(req.params && req.params.token) ? page() : '';
  if (!html) return res.status(404).type('text').send('Not found');
  res.set(HEADERS).type('html').send(html);
}

module.exports = { tokenOk, page, serve, HEADERS, FILE, TOKEN_SHA256 };
