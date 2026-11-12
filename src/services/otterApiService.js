'use strict';

/**
 * Otter API key — READ-ONLY check (Faran 2026-11-12). The key sits in the server's
 * environment (OTTER_API_KEY); this asks Otter a few harmless GET questions with it and
 * reports ONLY what kind of answer came back: the HTTP status, the field NAMES and value
 * types, how many items — never a title, a transcript, a name, an email or the key itself.
 *
 * Why it exists: Otter's API reference is behind a sign-in, so before anything is built on
 * the key we look at what it can actually reach. Nothing is stored, nothing is written to
 * Otter (GET only, a fixed list of addresses on Otter's own host), nothing is logged.
 *
 * Admin: GET /admin/otter/api-check
 */

const KEY_NAMES = ['OTTER_API_KEY', 'OTTER_KEY', 'OTTERAI_API_KEY', 'OTTER_AI_API_KEY'];
const HOST = 'https://api.otter.ai';
// What is tried, in order. Paths come from what is publicly written about Otter's Public API
// (base /v1, Bearer key, "conversations", "workspace"); the rest are the usual spellings, so the
// answer tells us which exist (404 = no such address, 401/403 = the key is refused there).
const PROBES = [
  { path: '/v1/workspace' },
  { path: '/v1/conversations' },
  { path: '/v1/conversations?limit=3' },
  { path: '/v1/conversations?page_size=3&include=transcript,outline,insights' },
  { path: '/v1/channels' },
  { path: '/v1/members' },
  { path: '/v1/speeches' },
  { path: '/v1/me' },
];
const SCHEMES = [
  { name: 'bearer', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { name: 'x-api-key', headers: (k) => ({ 'X-API-Key': k }) },
];
const TIMEOUT_MS = 15000;

/** The side effects behind one seam (tests replace them). */
const io = {
  env: () => process.env,
  async get(url, headers) {
    const axios = require('axios');
    const r = await axios.get(url, { headers: { Accept: 'application/json', ...headers }, timeout: TIMEOUT_MS, validateStatus: () => true, maxRedirects: 0, responseType: 'text', transformResponse: [(d) => d] });
    return { status: r.status, contentType: String((r.headers && r.headers['content-type']) || ''), body: typeof r.data === 'string' ? r.data : '' };
  },
};

/** Which environment name holds the key (the first one that is set), or null. */
function keyInfo(env) {
  for (const name of KEY_NAMES) {
    const v = String((env && env[name]) || '').trim();
    if (v) return { name, key: v, length: v.length };
  }
  return null;
}

/** A value's SHAPE: types and field names only, to a small depth — never a value. */
function shapeOf(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth >= 3 ? `array(${v.length})` : { array: v.length, of: v.length ? shapeOf(v[0], depth + 1) : 'empty' };
  if (typeof v === 'object') {
    if (depth >= 3) return 'object';
    const out = {};
    for (const k of Object.keys(v).slice(0, 60)) out[k] = shapeOf(v[k], depth + 1);
    return out;
  }
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}

/** An error answer's own words, short, with anything that looks like the key taken out. */
function safeError(body, key) {
  let t = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (key) t = t.split(key).join('[key]');
  return t;
}

async function probe(path, scheme, key) {
  try {
    const r = await io.get(HOST + path, scheme.headers(key));
    const out = { path, auth: scheme.name, status: r.status, json: false };
    let parsed;
    try { parsed = JSON.parse(r.body); out.json = true; } catch (_) { parsed = undefined; }
    if (r.status >= 200 && r.status < 300) {
      if (out.json) out.shape = shapeOf(parsed);
      else out.note = `not JSON (${r.contentType.split(';')[0] || 'no content type'}, ${r.body.length} characters)`;
    } else {
      out.error = out.json ? shapeOf(parsed) : undefined;
      out.says = safeError(r.body, key);
    }
    return out;
  } catch (err) {
    return { path, auth: scheme.name, status: 0, says: safeError(err && (err.code || err.message), key) || 'no answer' };
  }
}

/**
 * @returns {Promise<{ keyFound, keyName?, keyLength?, host, results: [...], works: boolean, checkedAt }>}
 * Bearer is tried on every address; the second header style only where Bearer was refused (401/403).
 */
async function check({ now = Date.now() } = {}) {
  const info = keyInfo(io.env());
  if (!info) return { keyFound: false, looked: KEY_NAMES, note: 'No Otter key is set on the server. Add OTTER_API_KEY in the hosting environment and restart.', checkedAt: new Date(now).toISOString() };
  const results = [];
  for (const p of PROBES) {
    const first = await probe(p.path, SCHEMES[0], info.key);
    results.push(first);
    if (first.status === 401 || first.status === 403) results.push(await probe(p.path, SCHEMES[1], info.key));
  }
  return {
    keyFound: true, keyName: info.name, keyLength: info.length, host: HOST,
    works: results.some((r) => r.status >= 200 && r.status < 300 && r.json),
    results, checkedAt: new Date(now).toISOString(),
  };
}

module.exports = { check, keyInfo, shapeOf, safeError, io, KEY_NAMES, PROBES, HOST };
