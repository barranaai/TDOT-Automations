'use strict';

/**
 * leadSnapshot — ONE shared, cached copy of the Lead Board for the list pages.
 *
 * Before (2026-10-15 review of Gauri point 4): the Leads page, the direct-retainer
 * section and the KPIs each paged the WHOLE board on their own (685 rows × 110
 * columns, 100 per page, ~28 s cold), and the booking page's taken-times check
 * read it again. Now every list reads this snapshot: the columns the lists use
 * (SNAPSHOT_KEYS), 500 rows per page, one in-flight read shared by all callers,
 * served while a refresh runs in the background (stale-while-revalidate), kept
 * warm by the scheduler.
 *
 * What it is NOT: a source for writes or for per-lead decisions. Anything that
 * writes to a lead, pays, signs, holds a time or reconciles reads Monday fresh
 * (leadService.getLead / listAllLeads) — a list may be a few minutes behind.
 *
 * Freshness: a copy younger than TTL_MS is served as is; older, it is served AND
 * refreshed in the background. invalidate() — every lead write goes through
 * leadService.updateLead / createLead, which call it — makes the next read wait
 * for data read AFTER the write: an invalidation is stamped with a generation,
 * and a read that began before it never satisfies it (review 2026-10-15: a
 * deleted lead was served alive by the page's own reload while a background
 * refresh that began before the delete was in flight).
 */

const leadService = require('./leadService');
const mondayApi   = require('./mondayApi');
const { leadBoardId } = require('../../config/monday');
const COLS = require('../data/newLeadsBoard.json').columns;

const TTL_MS      = 3 * 60 * 1000;    // served as is below this age
const HARD_MAX_MS = 20 * 60 * 1000;   // older than this: wait for a refresh (the copy is too old to show)
const PAGE        = 500;              // Monday's items_page maximum
const MAX_PAGES   = 40;               // 20,000 leads — far beyond plausible

/** The lead fields the list pages, the KPIs and the booking-page slot check read. */
const SNAPSHOT_KEYS = [
  'fullName', 'sourceChannel', 'caseTypeInterest', 'tier', 'priority',
  'bookingStatus', 'slotHeldUntil', 'bookedSlot', 'squareConsultTxnId', 'squareBookingId',
  'preConsultSubmitted', 'consultationHeld', 'zoomMeetingId', 'meetingLink', 'meetingType',
  'outcome', 'followUpDate', 'consultAgreementSent', 'consultAgreementSigned', 'consultOption',
  'retainerSent', 'retainerSigned', 'retainerPaid', 'retainerFee', 'clientMasterItemId', 'conversionStatus', 'consultPayment',
  'confirmedCaseType', 'serviceRequired', 'whatDoYouWant', 'deadlineDate', 'removalOrder', 'enforcementLetter',
  'relationshipWithTdot', 'existingFileType', 'assignedConsultant', 'leadOwner', 'bookingInvite', 'inviteSentAt',
];
const SNAPSHOT_IDS = SNAPSHOT_KEYS.map((k) => COLS[k]).filter(Boolean);

let _copy = null;          // { leads, at, gen }  gen: the invalidation generation the read began at
let _inFlight = null;      // { promise, gen }
let _gen = 0;              // bumped by every invalidate()
let _invalidatedAt = 0;    // the generation of the latest invalidation (0 = none outstanding)

/** The side effects behind one seam (tests replace fetchLeads). */
const io = {
  /** Page the board, SNAPSHOT_KEYS only, parsed as leadService.parseItem does. */
  async fetchLeads() {
    const out = [];
    let cursor = null, pages = 0;
    const ids = SNAPSHOT_IDS.map((id) => `"${id}"`).join(', ');
    do {
      const data = await mondayApi.query(
        `query($boardId: ID!, $cursor: String) {
           boards(ids: [$boardId]) {
             items_page(limit: ${PAGE}, cursor: $cursor) {
               cursor
               items { id name created_at column_values(ids: [${ids}]) { id text value } }
             }
           }
         }`,
        { boardId: String(leadBoardId), cursor }
      );
      const page = data?.boards?.[0]?.items_page;
      if (!page) throw new Error('the Lead Board could not be read');
      for (const it of page.items || []) out.push(leadService.parseItem(it));
      cursor = page.cursor || null;
      if (++pages > MAX_PAGES) throw new Error('the Lead Board listing did not end');
    } while (cursor);
    return out;
  },
  now: () => Date.now(),
};

/** Start a read (or join the one in flight). The read is stamped with the generation it began at. */
function _refresh() {
  if (_inFlight) return _inFlight.promise;
  const gen = _gen, started = io.now();
  const promise = io.fetchLeads()
    .then((leads) => {
      _copy = { leads, at: io.now(), gen };
      // Only a read that began at (or after) the latest invalidation satisfies it.
      if (_invalidatedAt <= gen) _invalidatedAt = 0;
      console.log(`[LeadSnapshot] ${leads.length} leads in ${io.now() - started} ms`);
      return _copy;
    })
    .finally(() => { if (_inFlight && _inFlight.promise === promise) _inFlight = null; });
  _inFlight = { promise, gen };
  return promise;
}

/** A read that began after the current generation — waits out an older in-flight read first. */
async function _freshRead() {
  while (_inFlight && _inFlight.gen < _gen) await _inFlight.promise.catch(() => {});
  return _refresh();
}

/**
 * The snapshot. `fresh: true` always waits for a read that began after the call.
 * @returns {Promise<{ leads: object[], at: number, ageMs: number, stale?: true }>}
 */
async function getLeadSnapshot({ fresh = false } = {}) {
  if (fresh) _gen++;
  const age = _copy ? io.now() - _copy.at : Infinity;
  const outstanding = _invalidatedAt > 0 && !(_copy && _copy.gen >= _invalidatedAt);
  const mustWait = fresh || outstanding || !_copy || age > HARD_MAX_MS;
  if (mustWait) {
    try { const c = await _freshRead(); return { leads: c.leads, at: c.at, ageMs: io.now() - c.at }; }
    catch (err) {
      // A read that fails: an old copy, flagged stale (the page says Monday could
      // not be read), is better than no page — even after a write, where the copy
      // may still show the old state. Only a caller that insisted on fresh data,
      // or no copy at all, gets the error.
      if (_copy && !fresh) { console.warn(`[LeadSnapshot] refresh failed, serving the copy from ${Math.round(age / 1000)} s ago: ${err.message}`); return { leads: _copy.leads, at: _copy.at, ageMs: age, stale: true }; }
      throw err;
    }
  }
  if (age > TTL_MS) _refresh().catch((err) => console.warn(`[LeadSnapshot] background refresh failed: ${err.message}`));
  return { leads: _copy.leads, at: _copy.at, ageMs: age };
}

/** Just the leads (the common call). */
async function leads(opts) { return (await getLeadSnapshot(opts)).leads; }

/** After a lead write: the next read waits for data read after this moment. */
function invalidate() { _gen++; _invalidatedAt = _gen; }

/** Scheduler: keep it warm — a refresh in the background, never a throw. */
async function warm() {
  try { await _refresh(); } catch (err) { console.warn(`[LeadSnapshot] warm-up failed: ${err.message}`); }
}

/** For tests only. */
function _reset() { _copy = null; _inFlight = null; _gen = 0; _invalidatedAt = 0; }
function _state() { return { gen: _gen, invalidatedAt: _invalidatedAt, copyGen: _copy ? _copy.gen : null, inFlight: !!_inFlight }; }

module.exports = { getLeadSnapshot, leads, invalidate, warm, io, SNAPSHOT_KEYS, SNAPSHOT_IDS, TTL_MS, HARD_MAX_MS, _reset, _state };
