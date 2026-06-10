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
const CONSULT_FEE_CENTS = parseInt(process.env.SQUARE_CONSULT_FEE_CENTS, 10) || 20000; // $200 CAD

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
async function getAvailableSlots(tier, weeksAhead = 4) {
  if (squareCalendarEnabled()) {
    try {
      return await getSquareAvailableSlots(weeksAhead);
    } catch (err) {
      console.warn(`[Booking] Square availability failed — falling back to static template: ${err.message}`);
    }
  }
  return getStaticAvailableSlots(tier, weeksAhead);
}

/**
 * Level 1: pull real open times from Square for the configured consult service.
 * Square already excludes conflicts on the real calendar; we additionally
 * subtract OUR own in-flight holds/bookings so two leads can't grab the same
 * time during the pay window (which Level 1 doesn't yet write back to Square).
 */
async function getSquareAvailableSlots(weeksAhead = 4) {
  const squareBookings = require('./squareBookingsService');
  const startAt = new Date(Date.now() + 25 * 3600 * 1000);                 // Square requires ≥24h
  const maxDays = Math.min(weeksAhead * 7, 31);                            // Square max window is 32 days
  const endAt = new Date(Date.now() + maxDays * 24 * 3600 * 1000);

  const slots = await squareBookings.searchAvailability({
    serviceVariationId: process.env.SQUARE_CONSULT_SERVICE_VARIATION_ID,
    teamMemberId: process.env.SQUARE_CONSULT_TEAM_MEMBER_ID || undefined,  // optional; service is staff-scoped
    startAtIso: startAt.toISOString(),
    endAtIso: endAt.toISOString(),
    pool: 'consult',
  });

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

/** Create a Square payment link and store its order id on the lead. */
async function createCheckout({ leadId, amount, description, type = 'lead' }) {
  const referenceId = `${type}-${leadId}`;
  const res = await axios.post(
    `${SQUARE_API_BASE}/v2/online-checkout/payment-links`,
    {
      idempotency_key: `${referenceId}-${crypto.randomBytes(6).toString('hex')}`,
      quick_pay: {
        name: description,
        price_money: { amount, currency: 'CAD' },
        location_id: process.env.SQUARE_LOCATION_ID,
      },
      payment_note: referenceId,
    },
    { headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' } }
  );

  const link = res.data.payment_link;
  const orderId = link.order_id;
  if (orderId) {
    await leadService.updateLead(leadId, type === 'lead' ? { squareConsultOrderId: orderId } : { squareRetainerOrderId: orderId });
  }
  return link.url;
}

/** Verify Square webhook HMAC signature. */
function verifySquareSignature(rawBody, signature, notificationUrl) {
  const secret = process.env.SQUARE_WEBHOOK_SECRET;
  if (!secret) return true; // not configured yet (pre-deploy) — allow
  const hmac = crypto.createHmac('sha256', secret).update(notificationUrl + rawBody).digest('base64');
  return hmac === signature;
}

/** Entry point for POST /webhook/square. */
async function handleSquarePaymentWebhook(event) {
  if (event.type !== 'payment.created' && event.type !== 'payment.updated') return;
  const payment = event.data?.object?.payment;
  if (!payment || payment.status !== 'COMPLETED') return;

  const orderId = payment.order_id;
  const txnId   = payment.id;
  if (!orderId) { console.warn(`[Square] Payment ${txnId} has no order_id`); return; }

  // Route by which lead+column holds this order id.
  const C = require('../data/newLeadsBoard.json').columns;
  const consultLead  = await leadService.findByColumnValue('squareConsultOrderId', orderId);
  if (consultLead) return confirmSlot(consultLead.id, txnId);

  const retainerLead = await leadService.findByColumnValue('squareRetainerOrderId', orderId);
  if (retainerLead) return require('./paymentService').onSquareRetainerPaymentReceived(event);

  console.warn(`[Square] Order ${orderId} (txn ${txnId}) not matched to any lead`);
}

/** Mark a booking confirmed after the consultation fee is paid. */
async function confirmSlot(leadId, txnId) {
  const lead = await leadService.getLead(leadId);
  if (lead && lead.bookingStatus === 'Booked') {
    console.log(`[Booking] Lead ${leadId} already booked — skipping (idempotent)`);
    return;
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
    if (consultationService.onSlotConfirmed) await consultationService.onSlotConfirmed(leadId);
  } catch (_) { /* WS4 not built yet */ }
}

module.exports = {
  getAvailableSlots, getSquareAvailableSlots, getStaticAvailableSlots, squareCalendarEnabled,
  holdSlot, releaseExpiredSlots, createCheckout,
  handleSquarePaymentWebhook, confirmSlot, verifySquareSignature,
  CONSULT_FEE_CENTS,
};
