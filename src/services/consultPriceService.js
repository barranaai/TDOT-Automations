'use strict';

/**
 * Consultation prices from Square (Faran 2026-11-05).
 *
 * The price of each consultation option — the amount the booking page shows and the
 * payment link / invoice charges — is what the option's "(TDOT Automation)" Square
 * service says, read live. The figures in config/consultantRouting.js are the record
 * of today's rates and the fallback: used until Square has answered once after a
 * start, when Square is down, or when its answer is not usable.
 *
 * How it is read: one POST /v2/catalog/batch-retrieve for every option's variation
 * id, at start-up, every 15 minutes (scheduler), and before any page quotes or
 * charges a price (ensureFresh — a bounded wait, so a slow Square never holds up a
 * client). A reading is kept until the next good one; a failed read changes nothing.
 *
 * What counts as usable: a CAD price, a whole positive number of cents, on a service
 * that is not deleted — and within a sanity band of the code's figure (more than a
 * quarter, less than four times): a price typed wrongly in Square — one zero too many
 * or too few ($3,000 or $30 for $300) — is refused with a warning rather than charged,
 * and the app's own figure is used until Square or the list is corrected. (A real rate
 * change beyond the band: update the list in the code first.) Every earlier price seen
 * is remembered (knownFeeCents), so a payment made at a price that changed meanwhile
 * still maps to its option.
 *
 * After a failed read, no new read is started for a minute (the scheduled read excepted):
 * a Square outage never makes every page wait the bound again and again.
 *
 * Switch: CONSULT_PRICES_FROM_SQUARE=off → the code's prices only (also when there is
 * no Square token; and in a test process unless the test sets it to 'on' — a test must
 * never read production). Status: /phase2/health (summary) and /admin/consult-prices (full).
 */

const axios = require('axios');

const SQUARE_VERSION = '2025-01-23';
const FRESH_MS       = 15 * 60 * 1000;   // a reading older than this is refreshed before a quote
const QUOTE_WAIT_MS  = 4000;             // a page waits at most this long for that refresh
const READ_TIMEOUT_MS = 10000;
const BAND_LOW = 0.25, BAND_HIGH = 4;    // Square price ÷ code price must sit strictly inside this band
const FAIL_COOLDOWN_MS = 60 * 1000;      // after a failed read, no new read for this long (the scheduled read excepted)

const base = () => (process.env.SQUARE_ENVIRONMENT === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com');

// variationId → { feeCents, durationMin, name, readAt, version }
const _live = new Map();
// variationId → every distinct price (cents) this process has seen or listed for it
const _known = new Map();
// variationId → { feeCents, why, at } — the last Square figure refused by the sanity band / validation
const _rejected = new Map();
let _lastOkAt = 0, _lastError = '', _lastErrorAt = 0, _inFlight = null, _reads = 0;

function enabled() {
  const sw = String(process.env.CONSULT_PRICES_FROM_SQUARE || '').trim().toLowerCase();
  if (sw === 'off') return false;
  // A test process reads Square only when it says so — under node --test (NODE_TEST_CONTEXT) or a test file run directly.
  if ((process.env.NODE_TEST_CONTEXT || /(^|[\\/])test[\\/][^\\/]+\.test\.js$/.test(String(process.argv[1] || ''))) && sw !== 'on') return false;
  return !!String(process.env.SQUARE_ACCESS_TOKEN || '').trim();
}

/** Every priced option in the registry, flattened: { consultant, key, durationMin, variationId, codeCents }. */
function listedOptions() {
  const { CONSULTANTS } = require('../../config/consultantRouting');
  const out = [];
  for (const c of Object.values(CONSULTANTS)) {
    for (const o of c.consultOptions || []) {
      if (!o.variationId) continue;
      out.push({ consultant: c.name, key: c.key, durationMin: o.durationMin, variationId: String(o.variationId), codeCents: Number(o.feeCents) });
    }
  }
  return out;
}

const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const remember = (id, cents) => {
  if (!Number.isInteger(cents) || cents <= 0) return;
  const set = _known.get(id) || new Set();
  set.add(cents);
  _known.set(id, set);
};

/** The live reading for a variation, or null (disabled, never read, or refused). */
function priceFor(variationId) {
  if (!enabled()) return null;
  return _live.get(String(variationId)) || null;
}

/** Every price (cents) a payment for this variation may legitimately carry: live, listed, and earlier readings. */
function knownFeesFor(variationId, codeCents, formerCents = []) {   // formerCents: the former rates that apply (caller-bounded)
  const out = new Set();
  if (Number.isInteger(codeCents) && codeCents > 0) out.add(codeCents);
  for (const c of formerCents || []) if (Number.isInteger(c) && c > 0) out.add(c);
  const live = priceFor(variationId);
  if (live) out.add(live.feeCents);
  for (const c of _known.get(String(variationId)) || []) out.add(c);
  return [...out];
}

/**
 * One usable price from a Square ITEM_VARIATION object, or { reject: why }.
 */
function readVariation(obj, codeCents) {
  const v = (obj && obj.item_variation_data) || {};
  const pm = v.price_money || {};
  if (obj && obj.is_deleted) return { reject: 'the service is deleted in Square' };
  if (!pm || pm.amount == null) return { reject: 'no price on the service in Square' };
  const amount = Number(pm.amount);
  if (!Number.isInteger(amount) || amount <= 0) return { reject: `an unusable price in Square (${JSON.stringify(pm.amount)})` };
  if (String(pm.currency || '').toUpperCase() !== 'CAD') return { reject: `a price in ${pm.currency || 'an unknown currency'}, not CAD` };
  if (Number.isInteger(codeCents) && codeCents > 0) {
    const ratio = amount / codeCents;
    if (ratio <= BAND_LOW || ratio >= BAND_HIGH) {
      return { reject: `a price of ${money(amount)} in Square, too far from the ${money(codeCents)} in the app's own list (a typo?) — the app keeps ${money(codeCents)} until Square or the list is corrected` };
    }
  }
  return {
    feeCents: amount,
    durationMin: v.service_duration ? Math.round(Number(v.service_duration) / 60000) : null,
    name: String(v.name || ''),
    version: obj.version,
  };
}

/**
 * Read every option's price from Square. One read at a time; a second caller shares the
 * read in flight. Never throws: a failed read keeps the previous readings and records the
 * error. Returns { ok, read, changed[], rejected[], error }.
 */
async function refresh({ reason = 'manual', force = false } = {}) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'off' };
  if (_inFlight) return _inFlight;
  if (!force && _lastErrorAt && Date.now() - _lastErrorAt < FAIL_COOLDOWN_MS) return { ok: false, skipped: true, reason: 'cooling down after a failed read' };
  _inFlight = (async () => {
    const opts = listedOptions();
    const ids = opts.map((o) => o.variationId);
    const result = { ok: false, read: 0, changed: [], rejected: [], missing: [], error: '' };
    if (!ids.length) { result.ok = true; return result; }
    try {
      // Deleted objects are asked for: a service deleted in Square must be SEEN as deleted (refused → the
      // list price), not go missing from the answer with its last reading kept.
      const res = await axios.post(`${base()}/v2/catalog/batch-retrieve`, { object_ids: ids, include_deleted_objects: true }, {
        headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: READ_TIMEOUT_MS,
      });
      const objects = (res.data && res.data.objects) || [];
      const now = Date.now();
      for (const o of opts) {
        const obj = objects.find((x) => x && String(x.id) === o.variationId && x.type === 'ITEM_VARIATION');
        const label = `${o.consultant} ${o.durationMin} min`;
        if (!obj) {
          result.missing.push(label);
          console.warn(`[ConsultPrice] ${label}: service ${o.variationId} not in Square's answer — ${_live.has(o.variationId) ? 'keeping the last reading' : `using the app's own ${money(o.codeCents)}`}`);
          continue;
        }
        const r = readVariation(obj, o.codeCents);
        if (r.reject) {
          // A refused figure means the app's own price — also after a good reading (what the
          // warning, the status and the guide say): the reading is dropped, its price stays known.
          _rejected.set(o.variationId, { feeCents: Number((obj.item_variation_data || {}).price_money && obj.item_variation_data.price_money.amount) || null, why: r.reject, at: now });
          _live.delete(o.variationId);
          result.rejected.push(`${label}: ${r.reject}`);
          console.warn(`[ConsultPrice] ${label}: ${r.reject}`);
          continue;
        }
        _rejected.delete(o.variationId);
        const prev = _live.get(o.variationId);
        const entry = { ...r, readAt: now };
        _live.set(o.variationId, entry);
        remember(o.variationId, o.codeCents);
        remember(o.variationId, r.feeCents);
        result.read++;
        if (!prev || prev.feeCents !== r.feeCents) {
          result.changed.push(`${label}: ${prev ? money(prev.feeCents) : money(o.codeCents) + ' (app list)'} → ${money(r.feeCents)}`);
          if (prev || r.feeCents !== o.codeCents) {
            console.warn(`[ConsultPrice] ${label}: price from Square ${money(r.feeCents)}${prev ? ` (was ${money(prev.feeCents)})` : ` — the app's own list says ${money(o.codeCents)}`}${r.feeCents === o.codeCents ? '' : ' — the Square price is used'}`);
          }
        }
        if (r.durationMin && r.durationMin !== o.durationMin) {
          console.warn(`[ConsultPrice] ${label}: Square's service lasts ${r.durationMin} min, the app's list says ${o.durationMin} — the list's length is used; align them`);
        }
      }
      _lastOkAt = now; _lastError = ''; _reads++;
      result.ok = true;
      if (_reads === 1 || result.changed.length) console.log(`[ConsultPrice] ${reason}: ${result.read}/${opts.length} price(s) read from Square${result.changed.length ? ` — ${result.changed.join('; ')}` : ''}`);
    } catch (err) {
      const status = err.response && err.response.status;
      _lastError = `${status ? `HTTP ${status}` : err.code || 'error'}: ${err.message}`; _lastErrorAt = Date.now();
      result.error = _lastError;
      console.warn(`[ConsultPrice] ${reason}: Square could not be read (${_lastError}) — ${_live.size ? 'keeping the last readings' : "using the app's own prices"}`);
    }
    return result;
  })();
  try { return await _inFlight; } finally { _inFlight = null; }
}

/**
 * Before a price is quoted or charged: a reading no older than maxAgeMs, if Square answers
 * within waitMs. Never throws; a slow or failed read leaves the caller with the last
 * reading (or the app's own price). Returns { fresh, ageMs }.
 */
async function ensureFresh({ maxAgeMs = FRESH_MS, waitMs = QUOTE_WAIT_MS, reason = 'quote' } = {}) {
  if (!enabled()) return { fresh: false, ageMs: null, off: true };
  const age = _lastOkAt ? Date.now() - _lastOkAt : null;
  if (age != null && age < maxAgeMs) return { fresh: true, ageMs: age };
  let timer;
  const wait = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), waitMs); if (timer.unref) timer.unref(); });
  const r = await Promise.race([refresh({ reason }).catch(() => ({ ok: false })), wait]);
  clearTimeout(timer);
  if (r && r.skipped) return { fresh: false, ageMs: age, skipped: r.reason };
  if (r && r.timedOut) console.warn(`[ConsultPrice] ${reason}: Square has not answered within ${waitMs} ms — ${_live.size ? 'the last readings are used' : "the app's own prices are used"} (the read goes on in the background)`);
  const ageNow = _lastOkAt ? Date.now() - _lastOkAt : null;
  return { fresh: !!(r && r.ok), ageMs: ageNow };
}

/** What is in use right now, option by option (no secrets) — for /admin/consult-prices and the health check. */
function status() {
  const on = enabled();
  const options = listedOptions().map((o) => {
    const live = on ? _live.get(o.variationId) : null;
    const rej = _rejected.get(o.variationId) || null;
    return {
      consultant: o.consultant, durationMin: o.durationMin, variationId: o.variationId,
      codeCents: o.codeCents,
      squareCents: live ? live.feeCents : (rej ? rej.feeCents : null),
      squareDurationMin: live ? live.durationMin : null,
      inUseCents: live ? live.feeCents : o.codeCents,
      source: live ? 'square' : 'code',
      readAt: live ? new Date(live.readAt).toISOString() : null,
      rejected: rej ? rej.why : '',
    };
  });
  return {
    enabled: on,
    switch: on ? 'on' : (String(process.env.CONSULT_PRICES_FROM_SQUARE || '').toLowerCase() === 'off' ? 'off (CONSULT_PRICES_FROM_SQUARE=off)' : 'off (no Square token)'),
    environment: process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    lastOkAt: _lastOkAt ? new Date(_lastOkAt).toISOString() : null,
    ageMs: _lastOkAt ? Date.now() - _lastOkAt : null,
    lastError: _lastError || null,
    lastErrorAt: _lastErrorAt ? new Date(_lastErrorAt).toISOString() : null,
    reads: _reads,
    allFromSquare: on && options.length > 0 && options.every((x) => x.source === 'square'),
    options,
  };
}

/** One line for the health check: 'square 4/4 (3 min ago)' / 'code (never read)' / 'off'. */
function summary() {
  const st = status();
  if (!st.enabled) return st.switch;
  const n = st.options.filter((x) => x.source === 'square').length;
  const age = st.ageMs == null ? 'never read' : `${Math.round(st.ageMs / 60000)} min ago`;
  return `${n === st.options.length ? 'square' : n ? 'mixed' : 'code'} ${n}/${st.options.length} (${age}${st.lastError ? `; last error: ${st.lastError}` : ''})`;
}

/** Tests only: forget every reading. */
function _reset() { _live.clear(); _known.clear(); _rejected.clear(); _lastOkAt = 0; _lastError = ''; _lastErrorAt = 0; _inFlight = null; _reads = 0; }

module.exports = {
  enabled, refresh, ensureFresh, priceFor, knownFeesFor, status, summary, listedOptions,
  FRESH_MS, QUOTE_WAIT_MS, FAIL_COOLDOWN_MS, BAND_LOW, BAND_HIGH,
  _internal: { readVariation, _reset, _live },
};
