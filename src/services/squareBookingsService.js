/**
 * Square Bookings Service — client for the Square Appointments / Bookings API.
 *
 * This is the foundation for the live-calendar integration (Level 1 + Level 2).
 * It is a pure API client: it does NOT change the booking flow on its own.
 * bookingService wires these calls in behind the USE_SQUARE_CALENDAR flag.
 *
 *   Level 1 (read):  searchAvailability() → real open times from the seller's
 *                    actual Appointments calendar (no paid plan needed).
 *   Level 2 (write): ensureCustomer() + createBooking() → write the paid
 *                    appointment onto the real calendar (needs Appointments
 *                    Plus/Premium for seller-level writes).
 *
 * Capability/shape facts below were verified against developer.squareup.com:
 *   - SearchAvailability window must be ≥24h and ≤32 days.
 *   - CreateBooking requires location_id, start_at, and an appointment segment
 *     with team_member_id + service_variation_id + service_variation_version.
 *   - The customer MUST have a phone number or CreateBooking 400s.
 *   - Service variations with a non-zero cancellation/no-show fee can't be
 *     booked via the API at all.
 *   - The Booking object carries NO order_id/payment_id, so payment↔booking
 *     correlation is synthesized in OUR system (squareBookingId on the lead).
 */

'use strict';

const axios = require('axios');

const TZ = 'America/Toronto';
const SQUARE_VERSION = '2025-01-23';

function base() {
  return process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}
function headers() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Square-Version': SQUARE_VERSION,
    'Content-Type': 'application/json',
    // Square's Bookings endpoints reject axios's default Accept ("*/*") with a
    // 406 — they require an explicit application/json. Must be set on every call.
    Accept: 'application/json',
  };
}
function locationId() { return process.env.SQUARE_LOCATION_ID; }

// ─── Pure helpers (no I/O — unit-tested) ──────────────────────────────────────

/**
 * Normalize a phone to E.164 (+1XXXXXXXXXX for CA/US). Returns null if it can't
 * form a plausible number. CreateBooking requires a phone, so callers must have
 * a fallback when this returns null.
 */
function toE164(phone, countryShort = 'CA') {
  if (!phone) return null;
  const raw = String(phone).trim();
  if (/^\+\d{8,15}$/.test(raw)) return raw;            // already E.164
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if ((countryShort === 'CA' || countryShort === 'US')) {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null; // wrong length for NANP — don't guess
  }
  // Other countries: strip a leading "00" international dialing prefix, then
  // accept 8–15 digits with a leading +.
  const intl = digits.replace(/^00/, '');
  if (intl.length >= 8 && intl.length <= 15) return `+${intl}`;
  return null;
}

/** Square start_at (UTC ISO) → our { date:'YYYY-MM-DD', time:'HH:MM' } in Toronto. */
function utcToTorontoSlot(utcIso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(utcIso));
  const m = {}; for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === '24' ? '00' : m.hour; // Intl can emit 24 at midnight
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${hour}:${m.minute}` };
}

/** Build the SearchAvailability request body. teamMemberId optional (any bookable staff). */
function buildAvailabilitySearch({ serviceVariationId, teamMemberId, startAtIso, endAtIso, locId }) {
  const segmentFilter = { service_variation_id: serviceVariationId };
  if (teamMemberId) segmentFilter.team_member_id_filter = { any: [teamMemberId] };
  return {
    query: {
      filter: {
        start_at_range: { start_at: startAtIso, end_at: endAtIso },
        location_id: locId,
        segment_filters: [segmentFilter],
      },
    },
  };
}

/** Build the CreateBooking request body. */
function buildCreateBookingBody({ customerId, serviceVariationId, serviceVariationVersion, teamMemberId, startAtIso, durationMinutes, sellerNote, locId }) {
  const segment = {
    team_member_id: teamMemberId,
    service_variation_id: serviceVariationId,
    service_variation_version: serviceVariationVersion,
  };
  if (durationMinutes) segment.duration_minutes = durationMinutes;
  const booking = {
    location_id: locId,
    customer_id: customerId,
    start_at: startAtIso,
    appointment_segments: [segment],
  };
  if (sellerNote) booking.seller_note = sellerNote;
  return { booking };
}

/** Map a SearchAvailability response into our slot shape, tagging each with the source data. */
function mapAvailabilities(availabilities, pool) {
  return (availabilities || []).map((a) => {
    const seg = (a.appointment_segments || [])[0] || {};
    const { date, time } = utcToTorontoSlot(a.start_at);
    return {
      date, time, pool,
      startAt: a.start_at,                                  // canonical UTC
      teamMemberId: seg.team_member_id,
      serviceVariationId: seg.service_variation_id,
      serviceVariationVersion: seg.service_variation_version,
      durationMinutes: seg.duration_minutes,
    };
  });
}

// ─── I/O wrappers ─────────────────────────────────────────────────────────────

async function _post(path, body) { return (await axios.post(base() + path, body, { headers: headers() })).data; }
async function _get(path)         { return (await axios.get(base() + path, { headers: headers() })).data; }
async function _put(path, body)   { return (await axios.put(base() + path, body, { headers: headers() })).data; }

/** Read the seller's booking profile — tells us booking_enabled + support_seller_level_writes (≈ paid plan). */
async function retrieveBusinessBookingProfile() {
  return (await _get('/v2/bookings/business-booking-profile')).business_booking_profile;
}

/** List bookable team members. */
async function listTeamMemberBookingProfiles() {
  return (await _get('/v2/bookings/team-member-booking-profiles')).team_member_booking_profiles || [];
}

/** List Appointments service items + their bookable variations (id, version, duration, price). */
async function listAppointmentServices() {
  const data = await _post('/v2/catalog/search-catalog-items', { product_types: ['APPOINTMENTS_SERVICE'] });
  const items = data.items || [];
  const out = [];
  for (const it of items) {
    for (const v of (it.item_data?.variations || [])) {
      const vd = v.item_variation_data || {};
      out.push({
        itemName: it.item_data?.name,
        variationId: v.id,
        variationVersion: v.version,
        variationName: vd.name,
        durationMinutes: vd.service_duration ? Math.round(vd.service_duration / 60000) : null,
        priceCents: vd.price_money?.amount,
        bookable: vd.available_for_booking,
      });
    }
  }
  return out;
}

/** Level 1: real open slots for a tier's service (and optional staff). startAtIso/endAtIso ≤32 days apart. */
async function searchAvailability({ serviceVariationId, teamMemberId, startAtIso, endAtIso, pool }) {
  const body = buildAvailabilitySearch({ serviceVariationId, teamMemberId, startAtIso, endAtIso, locId: locationId() });
  const data = await _post('/v2/bookings/availability/search', body);
  return mapAvailabilities(data.availabilities, pool);
}

/**
 * All bookings at our location in a window (cursor-paginated, capped). Used by
 * the booking page's belt-and-braces conflict filter — live probing showed
 * Square's availability search can offer slots that overlap staff-created
 * ACCEPTED appointments, so we re-check offered slots against the real
 * calendar ourselves.
 */
async function listBookings({ startAtIso, endAtIso, maxPages = 4 }) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      location_id: locationId(), start_at_min: startAtIso, start_at_max: endAtIso, limit: '100',
      ...(cursor ? { cursor } : {}),
    });
    const data = await _get(`/v2/bookings?${qs}`);
    out.push(...(data.bookings || []));
    cursor = data.cursor || '';
    if (!cursor) break;
  }
  return out;
}

/** Find a Square customer by email, or create one. Requires a phone (E.164) for booking. */
async function ensureCustomer({ email, fullName, phoneE164 }) {
  if (email) {
    const found = await _post('/v2/customers/search', { query: { filter: { email_address: { exact: email } } }, limit: 1 });
    const existing = (found.customers || [])[0];
    if (existing) return existing.id;
  }
  const [given, ...rest] = String(fullName || '').trim().split(/\s+/);
  const body = { given_name: given || 'Lead', family_name: rest.join(' ') || undefined, email_address: email || undefined, phone_number: phoneE164 || undefined };
  const created = await _post('/v2/customers', body);
  return created.customer?.id;
}

/** Level 2: write the appointment onto the real calendar. idempotencyKey dedupes retries. */
async function createBooking({ customerId, serviceVariationId, serviceVariationVersion, teamMemberId, startAtIso, durationMinutes, sellerNote, idempotencyKey }) {
  const body = buildCreateBookingBody({ customerId, serviceVariationId, serviceVariationVersion, teamMemberId, startAtIso, durationMinutes, sellerNote, locId: locationId() });
  body.idempotency_key = idempotencyKey;
  const data = await _post('/v2/bookings', body);
  return { bookingId: data.booking?.id, startAt: data.booking?.start_at, status: data.booking?.status };
}

/**
 * Should this booking be cancelled when its consultation record is deleted?
 * Pure — the judgement is separated from the HTTP so it can be tested flat.
 *
 * Cancel only what still occupies the calendar: a booking already cancelled,
 * declined or no-showed is terminal, and a booking whose start time has passed
 * cannot be freed (Square rejects cancelling the past — the slot was consumed).
 * An UNKNOWN future status errs toward cancelling: worst case Square refuses
 * and the failure surfaces; skipping silently would leave the slot occupied,
 * which is the exact hole this exists to close.
 *
 * @param {object} booking  Square booking ({status, start_at, version})
 * @param {number} nowMs    injected clock (Date.now() at the call site)
 * @returns {{act:'cancel'|'skip', reason:string}}
 */
function classifyBookingForCancel(booking, nowMs) {
  const TERMINAL = ['CANCELLED_BY_BUYER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW'];
  const status = String((booking && booking.status) || '').toUpperCase();
  if (TERMINAL.includes(status)) return { act: 'skip', reason: `already ${status.toLowerCase().replace(/_/g, ' ')}` };
  const startMs = Date.parse((booking && booking.start_at) || '');
  if (Number.isFinite(startMs) && startMs <= nowMs) return { act: 'skip', reason: 'the appointment time has already passed' };
  return { act: 'cancel', reason: status ? `status ${status}` : 'status unknown — attempting cancel' };
}

/**
 * Human-readable text for a Square API failure. Axios reports any non-2xx as
 * the useless "Request failed with status code NNN"; the actual cause sits in
 * err.response.data.errors (code + detail: VERSION_MISMATCH, UNAUTHORIZED, …)
 * — and which code it is decides whether a retry can ever work.
 */
function squareErrorText(err) {
  const errors = err && err.response && err.response.data && err.response.data.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e) => [e.code, e.detail].filter(Boolean).join(': ')).join('; ') || err.message;
  }
  return (err && err.message) || String(err);
}

/**
 * Move an existing appointment to a different staff member (same time/service).
 * Square requires the booking's current version for optimistic concurrency;
 * the customer is notified per the seller's notification settings — the same
 * behaviour as editing the appointment in the Square UI.
 * @returns {{ ok: boolean, teamMemberId?: string, error?: string }}
 */
async function updateBookingTeamMember(bookingId, newTeamMemberId) {
  const booking = await retrieveBooking(bookingId);
  if (!booking) return { ok: false, error: 'booking not found' };
  const segs = (booking.appointment_segments || []).map((seg) => ({ ...seg, team_member_id: newTeamMemberId }));
  if (!segs.length) return { ok: false, error: 'booking has no appointment segments' };
  const data = await _put(`/v2/bookings/${encodeURIComponent(bookingId)}`, {
    booking: { version: booking.version, appointment_segments: segs },
  });
  const got = data.booking && data.booking.appointment_segments && data.booking.appointment_segments[0];
  return { ok: true, teamMemberId: got && got.team_member_id };
}

/** One booking by id, or null when Square no longer knows it. */
async function retrieveBooking(bookingId) {
  try {
    return (await _get(`/v2/bookings/${encodeURIComponent(bookingId)}`)).booking || null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

/**
 * Cancel a booking iff it still occupies the calendar. Idempotent by
 * construction: not-found, already-cancelled and already-past all resolve to
 * "nothing to free", so a re-run after a partial failure is harmless.
 * Throws only on a genuine failure (auth, network, Square 5xx) — the caller
 * decides whether that blocks what it was doing.
 * @returns {{cancelled:boolean, reason:string}}
 */
async function cancelBookingIfActive(bookingId) {
  const booking = await retrieveBooking(bookingId);
  if (!booking) return { cancelled: false, reason: 'not found in Square — nothing to free' };
  const verdict = classifyBookingForCancel(booking, Date.now());
  if (verdict.act === 'skip') return { cancelled: false, reason: verdict.reason };
  await _post(`/v2/bookings/${encodeURIComponent(bookingId)}/cancel`, {
    booking_version: booking.version,
    idempotency_key: `cancel-${bookingId}`,   // deterministic — retries collapse in Square
  });
  return { cancelled: true, reason: 'cancelled' };
}

/** Stamp our lead id onto the Square booking as an audit attribute (best-effort; not queryable). */
async function upsertBookingCustomAttribute(bookingId, key, value) {
  const data = await axios.put(
    `${base()}/v2/bookings/${bookingId}/custom-attributes/${encodeURIComponent(key)}`,
    { custom_attribute: { value: String(value) } },
    { headers: headers() }
  );
  return data.data?.custom_attribute;
}

/**
 * Readiness check for the appointment WRITE-BACK. Reports the exact Square plan
 * flag (support_seller_level_writes) so you can see when writes turn on, and
 * verifies the rest of the config. When ready=true, new paid bookings start
 * creating Square appointments automatically (createSquareBooking is already
 * wired). Run: POST /api/square-booking-preflight.
 */
async function preflightSquareBooking() {
  const checks = {};
  let profile;
  try { profile = await retrieveBusinessBookingProfile(); }
  catch (e) {
    const d = e.response && e.response.data;
    return { ok: false, step: 'business-booking-profile', error: d ? JSON.stringify(d.errors || d) : e.message };
  }
  checks.bookingEnabled     = !!profile.booking_enabled;
  checks.sellerLevelWrites  = !!profile.support_seller_level_writes; // ← the plan flag that gates writes
  checks.locationIdSet      = !!process.env.SQUARE_LOCATION_ID;

  const svId = process.env.SQUARE_CONSULT_SERVICE_VARIATION_ID;
  checks.serviceVariationIdSet = !!svId;
  if (svId) {
    try {
      const v = (await listAppointmentServices()).find((s) => s.variationId === svId);
      checks.serviceVariationFound    = !!v;
      checks.serviceVariationBookable = !!(v && v.bookable);
      if (v) { checks.serviceVariationVersion = v.variationVersion; checks.serviceName = `${v.itemName} / ${v.variationName}`; }
    } catch (e) { checks.serviceLookupError = e.message; }
  }
  try {
    const tms = await listTeamMemberBookingProfiles();
    checks.bookableTeamMembers = tms.filter((t) => t.is_bookable !== false).map((t) => t.team_member_id);
  } catch (e) { checks.teamMemberError = e.message; }

  const ready = checks.bookingEnabled && checks.sellerLevelWrites && checks.serviceVariationIdSet
    && checks.serviceVariationFound && checks.serviceVariationBookable && checks.locationIdSet;
  const message = ready
    ? 'READY — Square appointment write-back is active; new paid bookings will create Square appointments automatically.'
    : !checks.sellerLevelWrites
      ? 'Waiting on Square: seller-level writes are NOT enabled on the plan yet. Everything else below shows what is/ isn\'t configured — it activates automatically once the plan supports writes.'
      : 'Config incomplete — see the checks below (service variation / location / bookable staff).';
  return { ok: true, ready, message, checks };
}

module.exports = {
  updateBookingTeamMember,
  // pure
  toE164, utcToTorontoSlot, buildAvailabilitySearch, buildCreateBookingBody, mapAvailabilities,
  preflightSquareBooking, classifyBookingForCancel, squareErrorText,
  // I/O
  retrieveBusinessBookingProfile, listTeamMemberBookingProfiles, listAppointmentServices,
  searchAvailability, listBookings, ensureCustomer, createBooking, upsertBookingCustomAttribute,
  retrieveBooking, cancelBookingIfActive,
  // constants
  SQUARE_VERSION, TZ,
};
