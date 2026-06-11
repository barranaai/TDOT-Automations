/**
 * Payment Reconciler — the safety net under the Square webhook.
 *
 * Webhooks are best-effort: a signature misconfiguration, an outage, or a
 * missed delivery can silently strand a REAL payment (observed in production:
 * a paid consultation stuck at "Slot Held" because the webhook secret on the
 * server didn't match). This cron closes that hole for good:
 *
 *   every 5 minutes → list recent COMPLETED Square payments → any whose
 *   reference note ("lead-<id>" / "retainer-<id>") points at a lead that has
 *   NOT registered the payment yet → process it through the same idempotent
 *   handlers the webhook uses.
 *
 * Fully idempotent: confirmSlot skips already-Booked leads and
 * onSquareRetainerPaymentReceived skips already-paid retainers, so the
 * webhook (when healthy) and this reconciler can both fire harmlessly.
 */

'use strict';

const axios = require('axios');

const SQUARE_API_BASE = process.env.SQUARE_ENVIRONMENT === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';
const SQUARE_VERSION = '2025-01-23';
const LOOKBACK_MS = 6 * 60 * 60 * 1000; // re-scan the last 6h each run (idempotent, cheap)

const NOTE_RE = /^(lead|retainer)-(\d+)$/;

async function listRecentCompletedPayments() {
  const begin = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const res = await axios.get(
    `${SQUARE_API_BASE}/v2/payments?begin_time=${encodeURIComponent(begin)}&sort_order=DESC&limit=100`,
    { headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': SQUARE_VERSION, Accept: 'application/json' } }
  );
  return (res.data.payments || []).filter((p) => p.status === 'COMPLETED');
}

/** Cron entry point. Returns the number of payments recovered (for tests/logs). */
async function reconcilePayments() {
  if (!process.env.SQUARE_ACCESS_TOKEN) return 0;

  let payments;
  try {
    payments = await listRecentCompletedPayments();
  } catch (err) {
    console.warn(`[Reconciler] Square payment list failed: ${err.message}`);
    return 0;
  }

  const leadService = require('./leadService');
  let recovered = 0;

  for (const payment of payments) {
    const m = NOTE_RE.exec(String(payment.note || '').trim());
    if (!m) continue; // not one of our checkouts
    const [, kind, leadId] = m;

    try {
      const lead = await leadService.getLead(leadId);
      if (!lead) continue; // lead deleted (e.g. test data) — nothing to do

      if (kind === 'lead') {
        if (lead.bookingStatus === 'Booked') continue; // already registered
        console.warn(`[Reconciler] Recovering unregistered CONSULT payment ${payment.id} for lead ${leadId} (status was "${lead.bookingStatus}")`);
        await require('./bookingService').confirmSlot(leadId, payment.id);
        recovered++;
      } else {
        if (lead.retainerPaid) continue; // already registered
        console.warn(`[Reconciler] Recovering unregistered RETAINER payment ${payment.id} for lead ${leadId}`);
        await require('./paymentService').onSquareRetainerPaymentReceived(
          { type: 'payment.updated', data: { type: 'payment', id: payment.id, object: { payment } } },
          { fallbackLeadId: leadId }
        );
        recovered++;
      }
    } catch (err) {
      console.error(`[Reconciler] Failed to recover payment ${payment.id} (${kind}-${leadId}): ${err.message}`);
    }
  }

  if (recovered) console.log(`[Reconciler] Recovered ${recovered} payment(s) the webhook missed`);
  return recovered;
}

module.exports = { reconcilePayments, NOTE_RE };
