/**
 * Square Invoices Service
 *
 * Consultation payments as REAL Square Invoices (team request 2026-08-25:
 * payments must appear under the Invoices tab, where the team confirms and
 * cross-checks, instead of only under All Orders).
 *
 * Design decisions (care-point analysis, 2026-08-25):
 *  - delivery_method SHARE_MANUALLY: Square sends NO invoice email and no
 *    reminders; the booking flow redirects the client straight to the
 *    invoice's public payment page — the pay-now UX is unchanged.
 *  - We create the ORDER ourselves (fee line + the per-lead HST line), so the
 *    existing payment webhook keeps matching by order id, and we stamp
 *    metadata.lead_id + metadata.booking_key on the order:
 *      lead_id      — the webhook's safety net when the stored order-id column
 *                     is lost (replaces the payment-note net, which invoice
 *                     payments don't carry);
 *      booking_key  — the deterministic slot/fee identity used to decide
 *                     reuse-vs-supersede on a re-submit.
 *  - invoice_number is NOT set: Square auto-assigns the next number in the
 *    team's existing sequence (they already issue manual invoices — ours must
 *    not collide or fork the numbering).
 *  - Due date = today (Toronto): it's a pay-now checkout, not a net-30 bill.
 */

const axios = require('axios');

const SQUARE_VERSION = '2026-07-16';

function base() {
  // Same convention as every other Square client in this repo: PRODUCTION only
  // when explicitly configured; anything else (unset included) is sandbox.
  return process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}
function headers() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION,
  };
}
function locationId() { return process.env.SQUARE_LOCATION_ID; }

async function _post(path, body) { return (await axios.post(base() + path, body, { headers: headers() })).data; }
async function _get(path)        { return (await axios.get(base() + path, { headers: headers() })).data; }
async function _put(path, body)  { return (await axios.put(base() + path, body, { headers: headers() })).data; }

/** Today's date in Toronto as YYYY-MM-DD (invoice due date = pay now). */
function torontoToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

/**
 * Create + publish a consultation invoice: customer → order (fee + HST line,
 * lead metadata) → invoice (SHARE_MANUALLY, due today, card only) → publish.
 *
 * @param {{
 *   leadId: string|number,
 *   amount: number,          // PRE-tax fee cents
 *   taxPct: number,          // effective per-lead HST % (0 = exempt)
 *   description: string,     // line item name shown on the invoice
 *   bookingKey: string,      // deterministic lead+slot+fee+tax identity
 *   customer: { email?: string, fullName?: string, phoneE164?: string },
 * }} params
 * @returns {Promise<{ invoiceId: string, orderId: string, publicUrl: string }>}
 */
async function createConsultInvoice({ leadId, amount, taxPct, description, bookingKey, customer }) {
  const { ensureCustomer } = require('./squareBookingsService');
  const customerId = await ensureCustomer(customer || {});
  if (!customerId) throw new Error('Square customer could not be resolved');

  const order = {
    location_id: locationId(),
    reference_id: `lead-${leadId}`,
    line_items: [{ name: description, quantity: '1', base_price_money: { amount, currency: 'CAD' } }],
    metadata: { lead_id: String(leadId), booking_key: String(bookingKey).slice(0, 255) },
  };
  if (taxPct > 0) {
    order.taxes = [{ uid: 'hst', name: `HST (${taxPct}%)`, type: 'ADDITIVE', percentage: String(taxPct), scope: 'ORDER' }];
  }
  const ord = await _post('/v2/orders', {
    idempotency_key: `ord-${bookingKey}`.slice(0, 128),
    order,
  });
  const orderId = ord.order && ord.order.id;
  if (!orderId) throw new Error('Square order creation returned no id');

  const inv = await _post('/v2/invoices', {
    idempotency_key: `inv-${bookingKey}`.slice(0, 128),
    invoice: {
      location_id: locationId(),
      order_id: orderId,
      primary_recipient: { customer_id: customerId },
      delivery_method: 'SHARE_MANUALLY',
      title: 'TDOT Immigration — Consultation',
      payment_requests: [{ request_type: 'BALANCE', due_date: torontoToday(), automatic_payment_source: 'NONE' }],
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
      store_payment_method_enabled: false,
    },
  });
  const invoice = inv.invoice;
  if (!invoice || !invoice.id) throw new Error('Square invoice creation returned no id');

  const pub = await _post(`/v2/invoices/${encodeURIComponent(invoice.id)}/publish`, {
    version: invoice.version,
    idempotency_key: `pub-${bookingKey}`.slice(0, 128),
  });
  const published = pub.invoice;
  if (!published || !published.public_url) throw new Error('Square invoice publish returned no public_url');

  console.log(`[SquareInv] Invoice ${published.invoice_number || published.id} published for lead ${leadId} (${amount}¢ + ${taxPct}% HST)`);
  return { invoiceId: published.id, orderId, publicUrl: published.public_url };
}

/** One invoice by id, or null when Square no longer knows it. */
async function retrieveInvoice(invoiceId) {
  try {
    return (await _get(`/v2/invoices/${encodeURIComponent(invoiceId)}`)).invoice || null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

/**
 * Cancel a published-but-unpaid invoice (already-paid / already-canceled /
 * missing are all fine — this is a cleanup path, not an invariant).
 * @returns {{ ok: boolean, status?: string, error?: string }}
 */
async function cancelInvoice(invoiceId) {
  const invoice = await retrieveInvoice(invoiceId);
  if (!invoice) return { ok: true, status: 'GONE' };
  if (['PAID', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(invoice.status)) {
    return { ok: true, status: invoice.status };
  }
  const data = await _post(`/v2/invoices/${encodeURIComponent(invoiceId)}/cancel`, { version: invoice.version });
  return { ok: true, status: (data.invoice && data.invoice.status) || 'CANCELED' };
}

/**
 * The lead id stamped on an order's metadata at creation — the payment
 * webhook's LAST-RESORT router when the stored order-id column was lost
 * (invoice payments carry Square's own note, so the "lead-<id>" payment-note
 * net doesn't exist for them). Returns null when unknown.
 */
async function retrieveOrderLeadMeta(orderId) {
  try {
    const data = await _get(`/v2/orders/${encodeURIComponent(orderId)}`);
    const meta = (data.order && data.order.metadata) || {};
    return /^\d+$/.test(String(meta.lead_id || '')) ? String(meta.lead_id) : null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null; // genuinely not ours
    // Transient (timeout/429/5xx): THROW. Returning null here would let the
    // reconciler permanently negative-cache OUR OWN order as foreign — a
    // missed-webhook payment on it would then never be recovered.
    throw err;
  }
}

module.exports = { createConsultInvoice, retrieveInvoice, cancelInvoice, retrieveOrderLeadMeta };
