/**
 * Booking Service (Phase 2 — WS3)
 *
 * Lead picks a consultation slot → pays the consultation fee via Square →
 * booking is confirmed. Writes ONLY to the Lead Board.
 *
 *   getAvailableSlots(tier, weeksAhead) → tier-filtered open slots
 *   holdSlot(leadId, date, time)        → tentatively reserve a slot
 *   releaseExpiredSlots()               → cron: free slots past their hold expiry
 *   createCheckout({...})               → Square payment link (stores order id)
 *   handleSquarePaymentWebhook(event)   → entry for POST /webhook/square
 *   confirmSlot(leadId, txnId)          → mark Booked after payment
 *
 * BUSINESS VALUES TO CONFIRM (safe defaults from the Build Brief):
 *   - Consultation fee: env SQUARE_CONSULT_FEE_CENTS (default 20000 = $200 CAD)
 *   - Slot schedule: SLOT_TEMPLATE below (Shafoli's pattern)
 */

'use strict';

const crypto      = require('crypto');
const axios       = require('axios');
const leadService = require('./leadService');

const SQUARE_API_BASE = process.env.SQUARE_ENVIRONMENT === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';
const SQUARE_VERSION = '2025-01-23';
// $200 CAD default. An EXPLICIT 0 is honored (free consults for everyone —
// deliberate config escape hatch); unset/invalid falls back to the default.
const _feeEnv = parseInt(process.env.SQUARE_CONSULT_FEE_CENTS, 10);
const CONSULT_FEE_CENTS = (Number.isFinite(_feeEnv) && _feeEnv >= 0) ? _feeEnv : 20000;

// Consultation checkouts charge HST ON TOP of the fee (meeting decision
// 2026-08-13: the checkout collected a flat $200 while the team expected
// $226). Percentage; an explicit 0 disables the tax line. Ontario HST default.
const _hstEnv = Number(process.env.SQUARE_CONSULT_HST_PCT);
const CONSULT_HST_PCT = (Number.isFinite(_hstEnv) && _hstEnv >= 0) ? _hstEnv : 13;
/** The all-in amount a client pays for a consult option's fee. */
const consultTotalWithTax = (feeCents) => Math.round(Number(feeCents || 0) * (1 + CONSULT_HST_PCT / 100));

// Weekly availability (times are Toronto local). Empty day = no slots.
const SLOT_TEMPLATE = {
  1: { newClient: ['10:45', '11:15', '11:45'], urgency: ['13:00', '13:15', '13:30', '13:45'] }, // Mon
  2: { newClient: ['10:45', '11:15', '11:45'], urgency: ['13:00', '13:15', '13:30', '13:45'] }, // Tue
  3: {},                                                                                          // Wed — off
  4: { newClient: ['10:45', '11:15', '11:45'], urgency: ['13:00', '13:15', '13:30', '13:45'] }, // Thu
  5: {},                                                                                          // Fri — spillover only
};

const TIER_TO_POOLS = {
  T0: ['urgency'],
  T1: ['urgency', 'newClient'],
  T2: ['newClient'],
  T3: ['newClient'],
  T4: ['newClient'],
};

function getExpirationHours(slotDate) {
  const daysOut = (slotDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysOut < 1)  return 15 / 60; // 15 min
  if (daysOut < 7)  return 24;      // 24 hours
  if (daysOut < 30) return 72;      // 72 hours
  return 24 * 7;                    // 7 days
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Level 1 is active when the flag is on AND a consult service variation is configured. */
function squareCalendarEnabled() {
  return (process.env.USE_SQUARE_CALENDAR === '1' || process.env.USE_SQUARE_CALENDAR === 'true')
    && !!process.env.SQUARE_CONSULT_SERVICE_VARIATION_ID;
}

/**
 * Generate open consult slots. When the live-calendar flag is on, slots come
 * straight from the seller's real Square Appointments availability (Level 1);
 * otherwise from the static SLOT_TEMPLATE. Any Square error falls back to the
 * template so the booking page never goes dark.
 */
async function getAvailableSlots(tier, weeksAhead = 4, teamMemberId, serviceVariationId) {
  if (squareCalendarEnabled()) {
    try {
      return await getSquareAvailableSlots(weeksAhead, teamMemberId, serviceVariationId);
    } catch (err) {
      console.warn(`[Booking] Square availability failed — falling back to static template: ${err.message}`);
    }
  }
  return getStaticAvailableSlots(tier, weeksAhead);
}

/**
 * Belt-and-braces buffer enforcement. Square's availability search SHOULD
 * already exclude booked time + the service's transition (buffer) time — but a
 * live probe (2026-07-29) caught it offering slots that overlap staff-created
 * ACCEPTED appointments (e.g. a slot at the exact start of an existing booking).
 * So we re-check every offered slot against the real Square booking list and
 * drop any that would collide with a same-team booking + its buffer.
 *
 * Occupancy model (matches Square's engine): an existing booking occupies
 * [start, start + duration + its transition_time); a new slot needs
 * [slotStart, slotStart + slotDuration + DEFAULT_TRANSITION_MIN) clear.
 * PURE — exported for tests.
 */
const DEFAULT_TRANSITION_MIN = 10; // the consult services' configured transition_time
const INACTIVE_BOOKING_STATUSES = new Set(['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW']);

// 30s micro-cache for the conflict re-check's booking list — one page view runs
// an availability search per duration option, all against the same calendar.
let _bookingsCache = null;
const BOOKINGS_CACHE_MS = 30 * 1000;
async function listBookingsCached(squareBookings, startAtIso, endAtIso) {
  const key = `${startAtIso.slice(0, 15)}|${endAtIso.slice(0, 15)}`; // same request window (minute granularity)
  if (_bookingsCache && _bookingsCache.key === key && (Date.now() - _bookingsCache.at) < BOOKINGS_CACHE_MS) {
    return _bookingsCache.data;
  }
  const data = await squareBookings.listBookings({ startAtIso, endAtIso });
  _bookingsCache = { key, at: Date.now(), data };
  return data;
}

function dropBufferConflicts(slots, bookings) {
  const occupied = []; // { teamMemberId, startMs, endMs (incl. transition) }
  for (const b of bookings || []) {
    if (INACTIVE_BOOKING_STATUSES.has(b.status)) continue;
    const seg = (b.appointment_segments || [])[0] || {};
    const startMs = Date.parse(b.start_at);
    if (!Number.isFinite(startMs)) continue;
    const durMin   = seg.duration_minutes ?? 30;
    const transMin = b.transition_time_minutes ?? DEFAULT_TRANSITION_MIN;
    occupied.push({ teamMemberId: seg.team_member_id, startMs, endMs: startMs + (durMin + transMin) * 60000 });
  }
  if (!occupied.length) return { slots, dropped: 0 };

  const kept = [];
  let dropped = 0;
  for (const s of slots) {
    const sStart = Date.parse(s.startAt);
    const sEnd   = sStart + ((s.durationMinutes ?? 30) + DEFAULT_TRANSITION_MIN) * 60000;
    const clash = occupied.some((o) =>
      o.teamMemberId && s.teamMemberId && o.teamMemberId === s.teamMemberId &&
      sStart < o.endMs && sEnd > o.startMs);
    if (clash) { dropped++; continue; }
    kept.push(s);
  }
  return { slots: kept, dropped };
}

/**
 * Level 1: pull real open times from Square for the configured consult service.
 * Square already excludes conflicts on the real calendar; we additionally
 * (a) re-verify against the real booking list (see dropBufferConflicts) and
 * (b) subtract OUR own in-flight holds/bookings so two leads can't grab the
 * same time during the pay window (which Level 1 doesn't yet write back to Square).
 */
async function getSquareAvailableSlots(weeksAhead = 4, teamMemberId, serviceVariationId) {
  const squareBookings = require('./squareBookingsService');
  const startAt = new Date(Date.now() + 25 * 3600 * 1000);                 // Square requires ≥24h
  const maxDays = Math.min(weeksAhead * 7, 31);                            // Square max window is 32 days
  const endAt = new Date(Date.now() + maxDays * 24 * 3600 * 1000);

  let slots = await squareBookings.searchAvailability({
    // Per-duration variation (the client's booking-page choice) or the legacy env default.
    serviceVariationId: serviceVariationId || process.env.SQUARE_CONSULT_SERVICE_VARIATION_ID,
    // The assigned consultant (from routing) scopes the calendar; falls back to
    // the env default, then to any bookable staff on the service.
    teamMemberId: teamMemberId || process.env.SQUARE_CONSULT_TEAM_MEMBER_ID || undefined,
    startAtIso: startAt.toISOString(),
    endAtIso: endAt.toISOString(),
    pool: 'consult',
  });

  // Best-effort conflict re-check — a listBookings failure must never take the
  // booking page down; we just fall back to trusting Square's availability.
  // Micro-cached (30s): a page view now runs one search PER duration option,
  // and the booking list is identical across them.
  try {
    const bookings = await listBookingsCached(squareBookings, startAt.toISOString(), endAt.toISOString());
    const res = dropBufferConflicts(slots, bookings);
    if (res.dropped) console.warn(`[Booking] Dropped ${res.dropped} Square-offered slot(s) that collide with existing bookings + buffer`);
    slots = res.slots;
  } catch (err) {
    console.warn(`[Booking] Conflict re-check skipped (listBookings failed): ${err.message}`);
  }

  const taken = await getTakenSlots();
  return slots.filter((s) => !taken.has(`${s.date} ${s.time}`));
}

/**
 * Static fallback: open slots from SLOT_TEMPLATE for the next `weeksAhead`
 * weeks, filtered to the lead's tier pools, excluding slots already held
 * (unexpired) or booked by any lead.
 */
async function getStaticAvailableSlots(tier, weeksAhead = 4) {
  const pools = TIER_TO_POOLS[tier] || ['newClient'];
  const taken = await getTakenSlots();

  const slots = [];
  const today = new Date();
  const end = new Date(); end.setDate(end.getDate() + weeksAhead * 7);

  for (let d = new Date(today); d <= end; d.setDate(d.getDate() + 1)) {
    if (d <= today) continue;                 // future days only (skip today — TZ-safe for v1)
    const dayTemplate = SLOT_TEMPLATE[d.getDay()];
    if (!dayTemplate) continue;
    const dateStr = ymd(d);
    for (const pool of pools) {
      for (const time of (dayTemplate[pool] || [])) {
        const key = `${dateStr} ${time}`;
        if (taken.has(key)) continue;
        slots.push({ date: dateStr, time, pool });
      }
    }
  }
  return slots;
}

/** Collect slot keys ("YYYY-MM-DD HH:MM") already booked or held (unexpired). */
async function getTakenSlots() {
  const taken = new Set();
  try {
    const C = require('../data/newLeadsBoard.json').columns;
    const { leadBoardId } = require('../../config/monday');
    const mondayApi = require('./mondayApi');
    const data = await mondayApi.query(
      `query($boardId: ID!) {
         boards(ids: [$boardId]) {
           items_page(limit: 200) {
             items { column_values(ids: ["${C.bookedSlot}", "${C.slotHeldUntil}", "${C.bookingStatus}"]) { id text } }
           }
         }
       }`,
      { boardId: String(leadBoardId) }
    );
    const items = data?.boards?.[0]?.items_page?.items || [];
    for (const it of items) {
      const cv = {}; it.column_values.forEach((c) => { cv[c.id] = c.text || ''; });
      const status = cv[C.bookingStatus];
      const booked = cv[C.bookedSlot];          // "YYYY-MM-DD HH:MM" or "YYYY-MM-DD"
      const heldUntil = cv[C.slotHeldUntil];
      if (status === 'Booked' && booked) taken.add(booked.trim());
      if (status === 'Slot Held' && booked && heldUntil) {
        // only block if the hold hasn't expired
        if (new Date(heldUntil).getTime() > Date.now()) taken.add(booked.trim());
      }
    }
  } catch (err) {
    console.warn('[Booking] getTakenSlots failed — proceeding without conflict filter:', err.message);
  }
  return taken;
}

/** Tentatively reserve a slot with an expiry based on how far out it is. */
async function holdSlot(leadId, slotDate, slotTime) {
  const dt = new Date(`${slotDate}T00:00:00`);
  const expHours = getExpirationHours(dt);
  const heldUntil = new Date(Date.now() + expHours * 3600 * 1000);

  // Stored as plain text (timezone-proof): bookedSlot = "YYYY-MM-DD HH:MM",
  // slotHeldUntil = ISO timestamp. Both round-trip exactly for matching/expiry.
  await leadService.updateLead(leadId, {
    bookingStatus: 'Slot Held',
    bookedSlot:    `${slotDate} ${slotTime}`,
    slotHeldUntil: heldUntil.toISOString(),
  });
  console.log(`[Booking] Held ${slotDate} ${slotTime} for lead ${leadId} (expires in ${expHours}h)`);
}

/** Cron: release holds whose Slot Held Until has passed. */
async function releaseExpiredSlots() {
  const C = require('../data/newLeadsBoard.json').columns;
  const { leadBoardId } = require('../../config/monday');
  const mondayApi = require('./mondayApi');

  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 200, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         items { id column_values(ids: ["${C.slotHeldUntil}"]) { text } }
       }
     }`,
    { boardId: String(leadBoardId), colId: C.bookingStatus, val: 'Slot Held' }
  );
  const items = data?.items_page_by_column_values?.items || [];
  let released = 0;
  for (const it of items) {
    const heldUntil = it.column_values?.[0]?.text;
    if (heldUntil && new Date(heldUntil).getTime() < Date.now()) {
      await leadService.updateLead(it.id, { bookingStatus: 'Abandoned' });
      released++;
    }
  }
  if (released) console.log(`[Booking] Released ${released} expired slot hold(s)`);
}

/**
 * Create a Square payment link. Returns { url, orderId }.
 *  - `reference` overrides the payment note (default "<type>-<leadId>"); the
 *    webhook routes by it. Milestones pass "milestone-<leadId>-<index>".
 *  - `storeOrderId` (default true) writes the order id to the consult/retainer
 *    column; milestones pass false and store the id in their own JSON instead.
 */
async function createCheckout({ leadId, amount, description, type = 'lead', idempotencyKey, reference, storeOrderId = true, taxPct = 0 }) {
  const referenceId = reference || `${type}-${leadId}`;
  // A deterministic key (e.g. per lead+slot) makes Square return the SAME
  // payment link on a duplicate submit instead of minting a second payable
  // link; callers that don't pass one get a fresh random key, as before.
  const idemKey = String(idempotencyKey || `${referenceId}-${crypto.randomBytes(6).toString('hex')}`).slice(0, 45);
  const payload = { idempotency_key: idemKey, payment_note: referenceId };
  if (taxPct > 0) {
    // An order with an ADDITIVE order-scope tax: the checkout itemizes
    // "fee + HST (13%) = total" instead of quick_pay's flat single amount.
    payload.order = {
      location_id: process.env.SQUARE_LOCATION_ID,
      line_items: [{ name: description, quantity: '1', base_price_money: { amount, currency: 'CAD' } }],
      taxes: [{ uid: 'hst', name: `HST (${taxPct}%)`, type: 'ADDITIVE', percentage: String(taxPct), scope: 'ORDER' }],
    };
  } else {
    payload.quick_pay = {
      name: description,
      price_money: { amount, currency: 'CAD' },
      location_id: process.env.SQUARE_LOCATION_ID,
    };
  }
  const res = await axios.post(
    `${SQUARE_API_BASE}/v2/online-checkout/payment-links`,
    payload,
    { headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' } }
  );

  const link = res.data.payment_link;
  const orderId = link.order_id;
  if (orderId && storeOrderId) {
    await leadService.updateLead(leadId, type === 'lead' ? { squareConsultOrderId: orderId } : { squareRetainerOrderId: orderId });
  }
  return { url: link.url, orderId: orderId || null };
}

/** Verify Square webhook HMAC signature (fail-closed, constant-time). */
/**
 * PURE — every public origin this app answers on, rendered as Square
 * notification URLs.
 *
 * Square signs (notificationUrl + body) with the EXACT URL configured on the
 * SUBSCRIPTION, which is independent of RENDER_URL. The app is reachable on
 * both the custom domain and the permanent .onrender.com one, so the webhook
 * accepts a signature computed over ANY of ours: otherwise pointing RENDER_URL
 * at the custom domain silently rejects every payment webhook until someone
 * also edits the Square subscription. The shared secret still gates the
 * request — this widens the URL, never the authentication.
 *
 * @param {object} env  defaults to process.env (injectable for tests)
 * @returns {string[]} de-duplicated candidate URLs, trailing slashes normalized
 */
function squareNotificationUrls(env = process.env) {
  return [...new Set(
    [env.SQUARE_NOTIFICATION_URL, env.RENDER_URL, 'https://tdot-automations.onrender.com']
      .filter(Boolean)
      .map((b) => `${String(b).replace(/\/+$/, '')}/webhook/square`)
  )];
}

function verifySquareSignature(rawBody, signature, notificationUrl) {
  const secret = process.env.SQUARE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail CLOSED: an unset secret used to accept everything, turning this into
    // an unauthenticated "confirm any lead as Booked" endpoint. Reject instead;
    // the paymentReconciler poll is the backstop if the secret is ever missing.
    console.error('[Square] SQUARE_WEBHOOK_SECRET is not set — rejecting webhook (fail closed). Set it to accept Square payment webhooks.');
    return false;
  }
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(notificationUrl + rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // Constant-time compare; unequal lengths can't match (and would throw).
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Entry point for POST /webhook/square. */
async function handleSquarePaymentWebhook(event) {
  if (event.type !== 'payment.created' && event.type !== 'payment.updated') return;
  const payment = event.data?.object?.payment;
  if (!payment || payment.status !== 'COMPLETED') return;

  const orderId = payment.order_id;
  const txnId   = payment.id;
  if (!orderId) { console.warn(`[Square] Payment ${txnId} has no order_id`); return; }

  // (Retainer + milestones are now collected by e-transfer, not Square, so there
  // is no milestone-note branch here anymore — those are reconciled manually.)

  // The amount actually charged — with per-duration pricing this is the MONEY
  // truth the recorded option must match (see reconcileConsultOptionWithPayment).
  const amountCents = Number(payment.amount_money && payment.amount_money.amount);

  // Route by which lead+column holds this order id.
  const C = require('../data/newLeadsBoard.json').columns;
  const consultLead  = await leadService.findByColumnValue('squareConsultOrderId', orderId);
  if (consultLead) return confirmSlot(consultLead.id, txnId, undefined, amountCents);

  const retainerLead = await leadService.findByColumnValue('squareRetainerOrderId', orderId);
  if (retainerLead) return require('./paymentService').onSquareRetainerPaymentReceived(event);

  // Fallback: the stored order id can be lost/overwritten (e.g. two links
  // issued by racing instances during a deploy, or a client paying a STALE
  // per-duration link after re-submitting with a different duration). Our
  // checkout sets the Square payment note to the reference id ("lead-<id>" /
  // "retainer-<id>") — route by it so a real payment is never dropped.
  const ref = String(payment.note || '').match(/^(lead|retainer)-(\d+)$/);
  if (ref) {
    console.warn(`[Square] Order ${orderId} not matched by order id — routing via payment note "${payment.note}"`);
    if (ref[1] === 'lead') return confirmSlot(ref[2], txnId, undefined, amountCents);
    return require('./paymentService').onSquareRetainerPaymentReceived(event, { fallbackLeadId: ref[2] });
  }

  console.warn(`[Square] Order ${orderId} (txn ${txnId}) not matched to any lead`);
}

/**
 * MONEY invariant: the option recorded on the lead (and everything downstream —
 * the Square appointment's variation/duration, the Teams meeting length, the
 * consult agreement's "amount paid", KPI revenue) must reflect what the client
 * ACTUALLY paid. A client can pay a STALE payment link (submit 45-min → back →
 * submit 30-min → pay the still-open 45-min tab), so the paid amount is the
 * source of truth: when it maps to a different option of the routed consultant,
 * the stored option is corrected before the booking confirms. A paid amount
 * matching NO option (legacy flat-fee links) keeps the stored/env behavior but
 * posts a loud staff note to verify the duration with the client.
 */
async function reconcileConsultOptionWithPayment(lead, paidCents) {
  let stored = null;
  try { stored = JSON.parse(lead.consultOption || ''); } catch (_) { /* legacy */ }
  // A payment matches an option at its pre-tax fee (links issued before HST,
  // 2026-08-14) OR at fee + HST (links issued after) — both eras stay valid.
  const matchesFee = (feeCents) => paidCents === Number(feeCents) || paidCents === consultTotalWithTax(feeCents);
  if (stored && matchesFee(stored.feeCents)) {
    // Recorded option is right — just remember the ACTUAL total collected
    // (the consult agreement states the amount paid; $226 must not print $200).
    if (Number(stored.paidCents) !== paidCents) {
      await leadService.updateLead(lead.id, { consultOption: JSON.stringify({ ...stored, paidCents }) });
    }
    return;
  }

  const routing = require('../../config/consultantRouting');
  const consultant = routing.resolveConsultant(lead);   // pinned override wins (2026-08-17)
  const paidOption = routing.consultOptionsFor(consultant).find((o) => matchesFee(o.feeCents));
  if (paidOption) {
    await leadService.updateLead(lead.id, {
      consultOption: JSON.stringify({
        durationMin: paidOption.durationMin, feeCents: paidOption.feeCents,
        variationId: paidOption.variationId, consultant: consultant.name, paidCents,
      }),
    });
    console.warn(`[Booking] Lead ${lead.id}: paid ${paidCents}c = the ${paidOption.durationMin}-min option — recorded option corrected (was ${stored ? `${stored.durationMin}min/${stored.feeCents}c` : 'none'})`);
  } else if (stored) {
    console.warn(`[Booking] Lead ${lead.id}: paid ${paidCents}c matches NO option (stored ${stored.durationMin}min/${stored.feeCents}c) — keeping stored, flagging staff`);
    await postInviteNote(lead.id,
      `⚠️ <b>Consultation payment amount needs a look:</b> the client paid <b>$${(paidCents / 100).toFixed(2)}</b>, ` +
      `but the recorded booking choice is <b>${stored.durationMin} minutes ($${(Number(stored.feeCents) / 100).toFixed(2)} + HST)</b>. ` +
      `Please confirm the intended duration with the client and adjust the Square appointment if needed.`).catch(() => {});
  }
}

/** Mark a booking confirmed after the consultation fee is paid. */
async function confirmSlot(leadId, txnId, meetingType, amountCents) {
  const lead = await leadService.getLead(leadId);
  if (lead && lead.bookingStatus === 'Booked') {
    console.log(`[Booking] Lead ${leadId} already booked — skipping (idempotent)`);
    return;
  }
  // Align the recorded option with the amount actually paid BEFORE anything
  // downstream reads it (onSlotConfirmed re-reads the lead). Best-effort — a
  // reconcile failure must not lose a real payment.
  if (lead && Number.isFinite(amountCents) && amountCents > 0) {
    try { await reconcileConsultOptionWithPayment(lead, amountCents); }
    catch (err) { console.warn(`[Booking] consultOption reconcile failed for ${leadId}: ${err.message}`); }
  }
  await leadService.updateLead(leadId, {
    bookingStatus:      'Booked',
    squareConsultTxnId: txnId,
    conversionStatus:   'Booked',
  });
  console.log(`[Booking] Confirmed booking for lead ${leadId} (txn ${txnId})`);

  // Hook for WS4 (Zoom + invite). Safe no-op until consultationService exists.
  try {
    const consultationService = require('./consultationService');
    if (consultationService.onSlotConfirmed) await consultationService.onSlotConfirmed(leadId, meetingType);
  } catch (_) { /* WS4 not built yet */ }
}

/**
 * Email the client their personal booking link. Staff-triggered only: the
 * portal (Leads / Consultations detail) or the board's "Booking Invite"
 * column flips to "Send" → the Monday webhook calls this with force:true
 * (a deliberate flip IS the intent, so re-sends are allowed). There is no
 * auto-send at intake — the intake submission gets an acknowledgment email
 * instead, and staff personalize this invite's body (lead.inviteMessage)
 * before sending.
 * The already-Sent guard below only applies to force:false callers (none
 * today) — a redelivered "Send" webhook still carries force:true, so exact
 * webhook redelivery can duplicate the email; acceptable for a staff action.
 *
 * @param {string} leadId
 * @param {{ force?: boolean }} [opts]  force skips the already-Sent guard.
 */
/** Best-effort staff-visible note on the lead (never blocks the send flow). */
async function postInviteNote(leadId, body) {
  try {
    await require('./mondayApi').query(
      `mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }`,
      { id: String(leadId), b: body }
    );
  } catch (err) { console.warn(`[Booking] invite note failed for ${leadId}: ${err.message}`); }
}

async function sendBookingInvite(leadId, { force = false } = {}) {
  const lead = await leadService.getLead(leadId);
  if (!lead) return;
  if (!lead.email) {
    console.warn(`[Booking] Invite skipped for ${leadId}: no email`);
    // The board-column path can reach this with no portal feedback — tell staff.
    await postInviteNote(leadId, '⚠️ <b>Booking invite NOT sent</b> — this lead has no email address on file. Add one, then flip Booking Invite to "Send" again.');
    return;
  }
  if (lead.bookingStatus === 'Booked') {
    console.log(`[Booking] Invite skipped for ${leadId}: already booked`);
    return;
  }
  if (!force && lead.bookingInvite === 'Sent') {
    console.log(`[Booking] Invite skipped for ${leadId}: already sent`);
    return;
  }

  const leadTokenService = require('./leadTokenService');
  const token = lead.leadToken || await leadTokenService.ensureToken(leadId);
  const base = String(process.env.RENDER_URL || 'https://tdot-automations.onrender.com').replace(/\/+$/, '');
  const url = `${base}/book/${leadId}?t=${encodeURIComponent(token)}`;

  const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');
  const microsoftMail = require('./microsoftMailService');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const first = esc(String(lead.fullName || 'there').split(' ')[0]);
  // Quote the ROUTED consultant's real pricing (per-duration options), not the
  // flat env fee — the booking page will offer exactly these.
  let feeLine = '';
  try {
    const routing = require('../../config/consultantRouting');
    const opts = routing.consultOptionsFor(routing.resolveConsultant(lead));   // invite quotes the PINNED consultant's fees
    const cad = (c) => (c / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    const priced = opts.filter((o) => o.feeCents > 0);
    // Totals shown WITH HST (team feedback 2026-08-13: a client charged $226
    // must never have been told "$200" with no mention of tax).
    const hst = CONSULT_HST_PCT > 0 ? ' (incl. HST)' : '';
    if (priced.length > 1) {
      feeLine = `The consultation fee is ${priced.map((o) => `<b>${cad(consultTotalWithTax(o.feeCents))}</b>${hst} for ${o.durationMin} minutes`).join(' or ')}, payable securely online when you book.`;
    } else if (priced.length === 1) {
      feeLine = `The consultation fee is <b>${cad(consultTotalWithTax(priced[0].feeCents))}</b>${hst}, payable securely online when you book.`;
    }
  } catch (_) {
    if (CONSULT_FEE_CENTS > 0) feeLine = `The consultation fee is <b>${(consultTotalWithTax(CONSULT_FEE_CENTS) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })}</b>${CONSULT_HST_PCT > 0 ? ' (incl. HST)' : ''}, payable securely online when you book.`;
  }

  // Body: the saved draft (the standard compliance-safe paragraph, possibly
  // staff-edited on the portal Leads tab) when set; otherwise the SAME standard
  // paragraph built fresh — per the 2026-07-31 directive the invite carries NO
  // case-condition commentary, hopeful thoughts, or promises in either path.
  // '[cleared]' is the staff-cleared sentinel (consultantPortalService
  // .saveInviteMessage) — it means "use the standard paragraph".
  const rawMsg = String(lead.inviteMessage || '').trim();
  const custom = rawMsg === '[cleared]' ? '' : rawMsg;
  const standardBody = await leadService.generateInviteMessage(lead);
  const bodyHtml = (custom || standardBody)
    .split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

  // Send FIRST, stamp after — the Leads UI treats "Sent + date" as authoritative,
  // so it must never assert a send that failed. (The old mark-Sent-first ordering
  // existed for a webhook-redelivery dedup that force:true made unreachable.)
  try {
    await microsoftMail.sendEmail({
      to: lead.email,
      subject: 'Book your consultation with TDOT Immigration',
      html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
        <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
          <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Book your consultation</h1></div>
        <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
          <p>Hi ${first},</p>
          ${bodyHtml}
          <p><a href="${url}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Choose your consultation time</a></p>
          <p>You'll see our real-time availability and can pick whatever works for you. ${feeLine}</p>
          <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">This link is personal to you — please don't share it. Questions? Just reply to this email.</p>
        </div></div>`,
    });
  } catch (err) {
    console.error(`[Booking] Invite email FAILED for ${leadId}: ${err.message}`);
    // Mark the column 'Failed' — a retry then writes 'Send' as a REAL label
    // transition, which reliably re-fires the Monday webhook (a same-value
    // 'Send'→'Send' write may not). Best-effort: the loud note is the backstop.
    await leadService.updateLead(leadId, { bookingInvite: 'Failed' }).catch((e) =>
      console.error(`[Booking] Could not mark invite Failed for ${leadId}: ${e.message}`));
    await postInviteNote(leadId, `⚠️ <b>Booking invite email FAILED to send</b> — please retry from the portal (or set Booking Invite to "Send" on the board). Error: ${String(err.message || err).slice(0, 200)}`);
    return;
  }

  // Stamp Sent + WHEN (Toronto date, matching how the portal displays lead
  // times). The email IS out at this point — if the stamp write fails, the
  // board would say "not sent" while the client already has the email, and the
  // natural staff reaction (resend) double-emails them. So: retry once, and on
  // persistent failure warn loudly instead of staying silent.
  const sentDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  try {
    await leadService.updateLead(leadId, { bookingInvite: 'Sent', inviteSentAt: sentDate });
  } catch (err) {
    console.error(`[Booking] Sent-stamp failed for ${leadId} (retrying once): ${err.message}`);
    try {
      await leadService.updateLead(leadId, { bookingInvite: 'Sent', inviteSentAt: sentDate });
    } catch (err2) {
      console.error(`[Booking] Sent-stamp retry failed for ${leadId}: ${err2.message}`);
      await postInviteNote(leadId, `⚠️ <b>Booking invite email WAS DELIVERED to the client</b>, but stamping it "Sent" on this lead failed twice. <b>Do NOT resend.</b> Please set Booking Invite to "Sent" manually.`).catch(() => {});
      return;
    }
  }
  await postInviteNote(leadId, `📧 <b>Booking invite emailed</b> to ${lead.email} on ${sentDate}.`).catch(() => {});
  console.log(`[Booking] Invite emailed to ${lead.email} for lead ${leadId}`);
}

module.exports = {
  getAvailableSlots, getSquareAvailableSlots, getStaticAvailableSlots, squareCalendarEnabled,
  holdSlot, releaseExpiredSlots, createCheckout,
  handleSquarePaymentWebhook, confirmSlot, verifySquareSignature, squareNotificationUrls, sendBookingInvite,
  dropBufferConflicts, reconcileConsultOptionWithPayment,
  CONSULT_FEE_CENTS, CONSULT_HST_PCT, consultTotalWithTax,
};
