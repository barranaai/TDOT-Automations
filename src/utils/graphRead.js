'use strict';

/**
 * Small shared pieces for READING mailboxes through Microsoft Graph (the client-mail check, Stage 1, and the
 * case page's Emails tab, Stage 2a). PURE apart from the io seam each caller passes in.
 *
 * Rules (do not undo):
 *  - A failed call is described by its HTTP status and Graph's SHORT error code only — never Graph's message
 *    (a refused $search / $filter can repeat the query, which holds client addresses) and never the URL.
 *  - A 401 (a revoked / drifted token) is retried ONCE with a fresh token — emailLeadsService's pattern.
 */

/** Status code + Graph's error code only — never its message, never the URL. */
function errorOf(err) {
  const status = (err && err.response && err.response.status) || 0;
  const raw = err && err.response && err.response.data && err.response.data.error && err.response.data.error.code;
  const code = /^[A-Za-z0-9_.-]{1,80}$/.test(String(raw || '')) ? String(raw) : (status ? 'graph-error' : 'no-answer');
  return { status, code };
}

/** An OData string literal: 'it''s'. */
const odataStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Run one Graph request with the bearer token; after a 401, once more with a fresh token.
 * @param {{ token: () => Promise<string>, dropToken: () => void }} io
 * @param {(headers: {Authorization: string}) => Promise<any>} call
 */
async function withToken(io, call) {
  const run = async () => call({ Authorization: `Bearer ${await io.token()}` });
  try { return await run(); }
  catch (err) {
    if (!(err && err.response && err.response.status === 401)) throw err;
    io.dropToken();
    return run();
  }
}

/** Seconds from a Retry-After header (a number, or an HTTP date), else null. */
function retryAfterSeconds(err, nowMs = Date.now()) {
  const h = err && err.response && err.response.headers;
  const raw = h && (typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] || h['Retry-After']));
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : null;
}

module.exports = { errorOf, odataStr, withToken, retryAfterSeconds };
