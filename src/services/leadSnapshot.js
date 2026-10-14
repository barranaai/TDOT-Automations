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
 * refreshed in the background; invalidate() (after a staff create/delete/convert,
 * a hold, a booking) makes the next read wait for fresh data so the page the
 * staff member reloads shows the change.
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
  'retainerSent', 'retainerSigned', 'retainerPaid', 'retainerFee', 'clientMasterItemId', 'conversionStatus',
  'confirmedCaseType', 'serviceRequired', 'whatDoYouWant', 'deadlineDate', 'removalOrder', 'enforcementLetter',
  'relationshipWithTdot', 'existingFileType', 'assignedConsultant', 'leadOwner', 'bookingInvite', 'inviteSentAt',
];
const SNAPSHOT_IDS = SNAPSHOT_KEYS.map((k) => COLS[k]).filter(Boolean);

let _copy = null;        // { leads, at }
let _inFlight = null;    // Promise<{ leads, at }>
let _invalidated = false;

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

function _refresh() {
  if (_inFlight) return _inFlight;
  const started = io.now();
  _inFlight = io.fetchLeads()
    .then((leads) => { _copy = { leads, at: io.now() }; _invalidated = false; console.log(`[LeadSnapshot] ${leads.length} leads in ${io.now() - started} ms`); return _copy; })
    .finally(() => { _inFlight = null; });
  return _inFlight;
}

/**
 * The snapshot. `fresh: true` always waits for a new read.
 * @returns {Promise<{ leads: object[], at: number, ageMs: number }>}
 */
async function getLeadSnapshot({ fresh = false } = {}) {
  const age = _copy ? io.now() - _copy.at : Infinity;
  const mustWait = fresh || _invalidated || !_copy || age > HARD_MAX_MS;
  if (mustWait) {
    try { const c = await _refresh(); return { leads: c.leads, at: c.at, ageMs: io.now() - c.at }; }
    catch (err) {
      // A read that fails: an old copy is better than no page — unless it was
      // invalidated (it would show a deleted lead alive / hide a new one).
      if (_copy && !_invalidated && !fresh) { console.warn(`[LeadSnapshot] refresh failed, serving the copy from ${Math.round(age / 1000)} s ago: ${err.message}`); return { leads: _copy.leads, at: _copy.at, ageMs: age, stale: true }; }
      throw err;
    }
  }
  if (age > TTL_MS) _refresh().catch((err) => console.warn(`[LeadSnapshot] background refresh failed: ${err.message}`));
  return { leads: _copy.leads, at: _copy.at, ageMs: age };
}

/** Just the leads (the common call). */
async function leads(opts) { return (await getLeadSnapshot(opts)).leads; }

/** The next read waits for fresh data (after a write the lists must show). */
function invalidate() { _invalidated = true; }

/** Scheduler: keep it warm — a refresh in the background, never a throw. */
async function warm() {
  try { await _refresh(); } catch (err) { console.warn(`[LeadSnapshot] warm-up failed: ${err.message}`); }
}

/** For tests only. */
function _reset() { _copy = null; _inFlight = null; _invalidated = false; }

module.exports = { getLeadSnapshot, leads, invalidate, warm, io, SNAPSHOT_KEYS, SNAPSHOT_IDS, TTL_MS, HARD_MAX_MS, _reset };
