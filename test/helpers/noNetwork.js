'use strict';
/**
 * Loaded by `npm test` (NODE_OPTIONS=--require) BEFORE any module of the app.
 *
 * config/monday.js loads .env on import, so every test process carries the
 * PRODUCTION credentials for Square, Monday, Microsoft Graph, Documenso and
 * CloudConvert. A test that drives a real code path without stubbing every
 * outbound seam therefore reaches production — on 2026-09-13 two unit tests
 * created real appointments on the Square calendar this way.
 *
 * This guard makes that impossible to do silently: any HTTP call to a live
 * service from a test THROWS with a message naming the caller's job — stub
 * the seam. Both transports the app uses are covered: axios (default adapter,
 * inherited by axios.create() instances made after this loads) and the global
 * fetch (Documenso, CloudConvert downloads).
 *
 * Only `npm test` installs this. Running `node --test <file>` directly does NOT —
 * prefix it with NODE_OPTIONS="--require ./test/helpers/noNetwork.js".
 */
const DENY = /(^|\.)(squareup\.com|squareupsandbox\.com|monday\.com|microsoft\.com|microsoftonline\.com|live\.com|office\.com|documenso\.com|cloudconvert\.com|zoom\.us|sharepoint\.com|onedrive\.com|anthropic\.com|onrender\.com|googleapis\.com)$/i;

function hostOf(url) { try { return new URL(String(url)).hostname; } catch (_) { return ''; } }
function refuse(url, via) {
  const err = new Error(`[test no-network guard] refused ${via} call to ${url} — a test reached a LIVE service; stub the seam (see test/helpers/noNetwork.js)`);
  err.code = 'E_TEST_NETWORK';
  return err;
}

const axios = require('axios');
const realAdapter = axios.defaults.adapter;
axios.defaults.adapter = function guardedAdapter(config) {
  const url = (config.baseURL || '') + (config.url || '');
  if (DENY.test(hostOf(url) || hostOf(config.url))) return Promise.reject(refuse(url, 'axios'));
  return (typeof realAdapter === 'function' ? realAdapter : axios.getAdapter(realAdapter))(config);
};

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (DENY.test(hostOf(url))) return Promise.reject(refuse(url, 'fetch'));
    return realFetch(input, init);
  };
}
