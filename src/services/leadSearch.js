'use strict';

/**
 * leadSearch — the Leads, Consultations and Retainers search boxes find a lead by
 * name, phone or email (Faran 2026-11-09, step 3 decision 1).
 *
 * The phone and email never go to the browser: the page POSTs the typed text and
 * gets back ONLY the matching lead ids. Matching is oldClientDirectory's
 * (matchPeople): "@" → email (any case), 4+ digits and no letters → phone (last
 * 10 digits, +1 / a leading 1 allowed), otherwise name words in any order. A Client ID ("CL 42") is
 * looked for first, on the Lead Board's Client ID copy (mode 'clientId').
 * Reads the shared snapshot (leadSnapshot.contactIndex) — no Monday call when warm.
 */

const MAX_IDS = 2000;

const io = {
  contactIndex: (opts) => require('./leadSnapshot').contactIndex(opts),
};

/** @returns {Promise<{ ok: true, mode: string, ids: string[], stale?: true }>} */
async function search(q) {
  const { matchPeople } = require('./oldClientDirectory');
  const { index, stale } = await io.contactIndex();
  // A Client ID FIRST (build step 5, review #5): "CL 42", "CL-2026-00042" → the leads carrying that ID (the Lead Board
  // copy). Typed as an ID it is never a name search; bare digits are never an ID (they stay the phone search).
  const D = require('./clientIdDisplay');
  const asId = D.searchQuery(q);
  if (asId) {
    const ids = [...new Set(index.filter((e) => D.entryMatches(e, asId)).map((e) => String(e.id)))].slice(0, MAX_IDS);
    return { ok: true, mode: 'clientId', ids, ...(stale ? { stale: true } : {}) };
  }
  const { hits, mode } = matchPeople(index, String(q == null ? '' : q));
  if (mode === 'short') return { ok: true, mode: 'short', ids: [] };
  const ids = [...new Set(hits.map((h) => String(h.id)))].slice(0, MAX_IDS);
  return { ok: true, mode, ids, ...(stale ? { stale: true } : {}) };
}

/**
 * Per-IP sliding-window limit (in memory). `hit(ip)` → true when allowed.
 * The map is pruned as it is used.
 */
function rateLimiter({ max = 600, windowMs = 60 * 1000, now = () => Date.now() } = {}) {
  const seen = new Map();
  return function hit(ip) {
    const t = now();
    const key = String(ip || '?');
    const list = (seen.get(key) || []).filter((x) => t - x < windowMs);
    if (seen.size > 5000) for (const [k, v] of seen) if (!v.length || t - v[v.length - 1] >= windowMs) seen.delete(k);
    if (list.length >= max) { seen.set(key, list); return false; }
    list.push(t);
    seen.set(key, list);
    return true;
  };
}

/**
 * The caller's address: the LAST X-Forwarded-For hop (Render's proxy appends the real peer; the first entry is
 * client-supplied) — as phase2.js's intake limit. Without it every request counts as the proxy's address. The whole
 * office still shares one address, so the limit (600 a minute) sits far above normal office typing (review 2026-11-09).
 */
function clientIp(req) {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || (req && req.ip) || 'unknown';
}

/**
 * The POST /api/leads/search handler (mounted under /api — the team key). Body { q } only; the text is
 * never logged; never cached; per-IP limit; the answer is { ok, mode, ids } — never a phone or email.
 */
function httpHandler(limit = rateLimiter()) {
  return async function leadSearchRoute(req, res) {
    res.set('Cache-Control', 'private, no-store');
    if (!limit(clientIp(req))) return res.status(429).json({ ok: false, error: 'Too many searches — wait a moment.' });
    try {
      const q = String((req.body && req.body.q) || '').slice(0, 100);
      const r = await search(q);
      res.json({ ok: true, mode: r.mode, ids: r.ids });
    } catch (err) {
      console.error('[Leads] search failed:', err.message);
      res.status(503).json({ ok: false, error: 'Search by phone and email is not available right now.' });
    }
  };
}

module.exports = { search, rateLimiter, httpHandler, clientIp, io, MAX_IDS };
