'use strict';

/**
 * The reminder pop-up's short memory (Faran 2026-11-07: "the popup opening time is long").
 *
 * Every pause in typing asks the server for the email again (POST …/reminder/render).
 * Each ask used to read the whole case again — about 10 s — although nothing it shows
 * can have changed in the minute since the preview read it. So the preview keeps what it
 * prepared (the gate facts, the missing list, the questionnaire, the deadline) here, under
 * a random handle the pop-up sends back with each ask. An ask with a good handle builds
 * the email from these facts in milliseconds.
 *
 * Bounds: one entry per opened pop-up, 2 minutes after its last use (each use refreshes
 * it), never more than 10 minutes after the full case read that made it (steady typing
 * cannot keep old facts alive), at most 200 entries (the least recently used goes first).
 * In memory only: a restart forgets it, and the pop-up then simply reads the case again.
 *
 * A handle is tied to WHO opened the pop-up, the CASE and the LEVEL — any other person,
 * case or level is a miss (a full read, as before). The SEND never reads this cache.
 */

const crypto = require('crypto');

const TTL_MS = 2 * 60 * 1000;        // unused for 2 minutes → gone
const MAX_AGE_MS = 10 * 60 * 1000;   // 10 minutes after the full case read → gone, however often used
const MAX_ENTRIES = 200;

const io = { now: () => Date.now() };   // tests move the clock
const _entries = new Map();             // handle → entry; Map order = least recently used first

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/**
 * Who is asking, as the cache keys it: the Monday sign-in's email, or the shared admin
 * key. '' (never cached) for anything else — e.g. a sign-in without an email.
 * @param {object|null} viewer  server.js resolveViewer's answer
 */
function whoOf(viewer) {
  if (!viewer) return '';
  const email = String(viewer.email || '').trim().toLowerCase();
  if (email) return 'staff:' + email;
  return viewer.isAdmin ? 'key' : '';
}

/** The overview fields the email view needs (gate + email) — nothing else is kept. */
const OVERVIEW_FIELDS = ['caseRef', 'itemId', 'clientName', 'caseType', 'caseSubType', 'clientEmail', 'accessToken', 'cmUnavailable', 'group',
  'automationLock', 'manualOverride', 'caseStage', 'paymentStatus', 'clientDeadlineRaw', 'escalationLastNotified', 'questionnaire'];
function overviewSlice(overview) {
  const o = overview || {};
  const out = {};
  for (const k of OVERVIEW_FIELDS) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function expired(e, now) {
  return now - e.usedAt >= TTL_MS || now - e.createdAt >= MAX_AGE_MS;
}

function sweep(now) {
  for (const [h, e] of _entries) if (expired(e, now)) _entries.delete(h);
}

/**
 * Keep what a full read prepared. Returns the new handle ('' when `who` is empty — nothing kept).
 * @param {{ who, caseRef, level, assignees, overview, core }} o
 */
function put(o) {
  const who = String((o && o.who) || '');
  if (!who) return '';
  const now = io.now();
  sweep(now);
  while (_entries.size >= MAX_ENTRIES) _entries.delete(_entries.keys().next().value);   // the least recently used
  const handle = crypto.randomBytes(16).toString('hex');
  _entries.set(handle, {
    who, caseRef: upper(o.caseRef), level: Number(o.level),
    createdAt: now, usedAt: now,
    assignees: o.assignees || { personIds: [], teamIds: [] },
    overview: overviewSlice(o.overview),
    core: o.core,
  });
  return handle;
}

/**
 * The entry for a handle — only for the same person, case and level, inside both time
 * limits; null otherwise. A hit refreshes its 2 minutes and makes it the most recently used.
 * A miss for another person / case / level leaves the entry alone (it is not theirs to end).
 */
function take(handle, { who, caseRef, level } = {}) {
  const h = String(handle || '');
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  const e = _entries.get(h);
  if (!e) return null;
  const now = io.now();
  if (expired(e, now)) { _entries.delete(h); return null; }
  if (!who || e.who !== String(who) || e.caseRef !== upper(caseRef) || e.level !== Number(level)) return null;
  e.usedAt = now;
  _entries.delete(h); _entries.set(h, e);   // to the end: the most recently used
  return e;
}

/** End one entry. With `who`, only that person's own (a handle sent by someone else never ends another person's). */
function drop(handle, who) {
  const h = String(handle || '');
  const e = _entries.get(h);
  if (e && (who === undefined || e.who === String(who || ''))) _entries.delete(h);
}

/** Every entry for a case (after a send — the next pop-up starts from a fresh read). */
function dropCase(caseRef) {
  const ref = upper(caseRef);
  for (const [h, e] of _entries) if (e.caseRef === ref) _entries.delete(h);
}

module.exports = { put, take, drop, dropCase, whoOf, overviewSlice, OVERVIEW_FIELDS, TTL_MS, MAX_AGE_MS, MAX_ENTRIES, io,
  size: () => _entries.size, _entries, _resetForTests: () => _entries.clear() };
