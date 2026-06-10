/**
 * Phase 2 Routes
 *
 * All Phase 2 client-facing pages and webhook receivers live in this one router.
 * Routes are added per workstream:
 *   WS1: /phase2/health
 *   WS2: /lead/new
 *   WS3: /book/:leadId, /webhook/square
 *   WS4: /consult/:leadId
 *   WS5: /retainer/:leadId, /webhook/adobesign, /webhook/lead
 *   WS6: (handoff is server-side only — no new routes)
 *   WS7: (payment route is /webhook/square, already added in WS3)
 */

'use strict';

const express          = require('express');
const router           = express.Router();
const leadService      = require('../services/leadService');
const leadTokenService = require('../services/leadTokenService');
const bookingService   = require('../services/bookingService');
const consultationService = require('../services/consultationService');
const retainerService2 = require('../services/retainerService2');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

// WS1 — health check for Phase 2 wiring
router.get('/phase2/health', (req, res) => res.json({ status: 'phase2 ok' }));

// ─── WS2 — Lead capture ───────────────────────────────────────────────────────

// GET /lead/new — render the public intake form
router.get('/lead/new', (req, res) => {
  res.type('html').send(buildLeadFormHtml());
});

// POST /lead/new — create the lead, fire AI qualification, show thank-you
router.post('/lead/new', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const lead = await leadService.createLead(req.body);

    // Fire-and-forget AI qualification — pass the form data so it doesn't race a board read.
    leadService.qualifyLead(lead.id, lead).catch((err) =>
      console.error(`[Lead] Qualification failed for ${lead.id}:`, err.message)
    );

    res.type('html').send(buildThankYouHtml(lead));
  } catch (err) {
    console.error('[Lead] /lead/new POST failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

function buildLeadFormHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Get Help With Your Immigration Case — TDOT Immigration</title>
  <style>
    body { background: ${BRAND.lightBg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; color: ${BRAND.textOnLight}; }
    .container { max-width: 600px; margin: 0 auto; padding: 32px 24px; }
    .header { background: ${BRAND.darkPanel}; color: ${BRAND.textOnDark}; padding: 28px; border-radius: 12px 12px 0 0; text-align: center; }
    .form-card { background: ${BRAND.lightCard}; padding: 32px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    label { display: block; font-weight: 600; color: ${BRAND.textOnLight}; margin-bottom: 6px; margin-top: 16px; }
    input, select, textarea { width: 100%; padding: 12px; border: 1px solid ${BRAND.border}; border-radius: 8px; font-size: 15px; box-sizing: border-box; }
    button { background: ${BRAND.primary}; color: white; padding: 14px 28px; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 24px; width: 100%; }
    button:hover { background: ${BRAND.primaryHover}; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${TDOT_LOGO_LIGHT_HTML}
      <h1 style="margin: 12px 0 4px;">Tell Us About Your Case</h1>
      <p style="margin: 0; opacity: 0.85; font-size: 14px;">We'll review and reach out within 24 hours.</p>
    </div>
    <form class="form-card" method="POST" action="/lead/new">
      <label>Full Name *</label>
      <input name="fullName" required>

      <label>Email *</label>
      <input type="email" name="email" required>

      <label>Phone (with country code) *</label>
      <input type="tel" name="phone" required placeholder="+1 416 555 1234">

      <label>Country of Residence *</label>
      <input name="country" required>

      <label>Preferred Contact Method *</label>
      <select name="preferredContact" required>
        <option value="">Choose...</option>
        <option value="Email">Email</option>
        <option value="Phone">Phone</option>
        <option value="WhatsApp">WhatsApp</option>
      </select>

      <label>What type of immigration case? *</label>
      <select name="caseTypeInterest" required>
        <option value="">Choose...</option>
        <option value="Study Permit">Study Permit</option>
        <option value="Work Permit">Work Permit (any type)</option>
        <option value="Permanent Residence">Permanent Residence / Express Entry</option>
        <option value="Spousal Sponsorship">Spousal Sponsorship</option>
        <option value="Visitor Visa">Visitor Visa / TRV</option>
        <option value="Citizenship">Citizenship</option>
        <option value="Other">Other / I'm not sure</option>
      </select>

      <label>Tell us about your situation *</label>
      <textarea name="situationDescription" rows="5" required placeholder="Brief description: where you are now, what you're trying to achieve, any deadlines..."></textarea>

      <label>How did you hear about us?</label>
      <input name="howHeard" placeholder="(optional)">

      <button type="submit">Submit My Case for Review</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildThankYouHtml(lead) {
  const firstName = escapeHtml((lead.fullName || 'there').split(' ')[0]);
  const contact   = escapeHtml(lead.preferredContact || 'email');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Thank You</title>
  <style>body{font-family:-apple-system,sans-serif;background:${BRAND.lightBg};padding:48px;text-align:center;color:${BRAND.textOnLight};}
  .box{background:${BRAND.lightCard};padding:48px;border-radius:12px;max-width:500px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.08);}</style></head>
  <body><div class="box"><h1 style="color:${BRAND.primary}">Thank you, ${firstName}.</h1>
  <p>We've received your case details and our team will be in touch within 24 hours by ${contact}.</p>
  <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:32px;">Reference: ${escapeHtml(lead.id)}</p></div></body></html>`;
}

function buildErrorHtml(message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head>
  <body style="font-family:-apple-system,sans-serif;padding:48px;color:${BRAND.textOnLight};">
  <h1>Something went wrong</h1><p>Please try again, or email us at info@tdotimm.com.</p></body></html>`;
}

// ─── WS3 — Booking ────────────────────────────────────────────────────────────

// GET /book/:leadId — show tier-filtered slots (token-protected)
router.get('/book/:leadId', async (req, res) => {
  const { leadId } = req.params;
  if (!await leadTokenService.validateToken(leadId, req.query.t)) {
    return res.status(403).type('html').send('Invalid or expired link.');
  }
  try {
    const lead  = await leadService.getLead(leadId);
    const slots = await bookingService.getAvailableSlots(lead.tier || 'T2', 4);
    res.type('html').send(buildBookingPageHtml(lead, slots, req.query.t));
  } catch (err) {
    console.error('[Book] GET failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

// POST /book/:leadId — hold the slot, create Square checkout, redirect to pay
router.post('/book/:leadId', express.urlencoded({ extended: true }), async (req, res) => {
  const { leadId } = req.params;
  if (!await leadTokenService.validateToken(leadId, req.query.t)) {
    return res.status(403).type('html').send('Invalid token');
  }
  try {
    const { slotDate, slotTime } = req.body;
    if (!slotDate || !slotTime) return res.status(400).type('html').send('Please choose a slot.');

    const lead = await leadService.getLead(leadId);
    await bookingService.holdSlot(leadId, slotDate, slotTime);

    const fee = (lead.tier === 'T0') ? 0 : bookingService.CONSULT_FEE_CENTS;
    if (fee === 0) {
      // Free (emergency) — confirm immediately, no payment.
      await bookingService.confirmSlot(leadId, 'free-t0');
      return res.type('html').send(buildBookingDoneHtml(lead, slotDate, slotTime));
    }

    const checkoutUrl = await bookingService.createCheckout({
      leadId, amount: fee,
      description: `Consultation with TDOT Immigration — ${slotDate} ${slotTime}`,
    });
    res.redirect(checkoutUrl);
  } catch (err) {
    console.error('[Book] POST failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

// POST /webhook/square — Square payment webhook (raw body for signature check)
router.post('/webhook/square', express.raw({ type: '*/*' }), async (req, res) => {
  res.status(200).send('OK'); // acknowledge immediately
  try {
    const raw = req.body.toString();
    const sig = req.headers['x-square-hmacsha256-signature'];
    const url = `${process.env.RENDER_URL || ''}/webhook/square`;
    if (!bookingService.verifySquareSignature(raw, sig, url)) {
      console.warn('[Square Webhook] Bad signature — ignoring');
      return;
    }
    await bookingService.handleSquarePaymentWebhook(JSON.parse(raw));
  } catch (err) {
    console.error('[Square Webhook] Error:', err.message);
  }
});

function buildBookingPageHtml(lead, slots, token) {
  const byDate = {};
  for (const s of slots) (byDate[s.date] = byDate[s.date] || []).push(s);
  const dateBlocks = Object.keys(byDate).sort().map((date) => {
    const d = new Date(`${date}T12:00:00`);
    const label = d.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
    const btns = byDate[date].map((s) =>
      `<button type="submit" name="pick" value="${s.date}|${s.time}" class="slot">${s.time}</button>`).join('');
    return `<div class="day"><div class="day-label">${label}</div><div class="slots">${btns}</div></div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1"><title>Book Your Consultation — TDOT Immigration</title>
  <style>
    body{background:${BRAND.lightBg};font-family:-apple-system,sans-serif;margin:0;color:${BRAND.textOnLight};}
    .container{max-width:640px;margin:0 auto;padding:32px 24px;}
    .header{background:${BRAND.darkPanel};color:${BRAND.textOnDark};padding:28px;border-radius:12px 12px 0 0;text-align:center;}
    .card{background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);}
    .day{margin-bottom:20px;} .day-label{font-weight:700;margin-bottom:8px;}
    .slots{display:flex;flex-wrap:wrap;gap:8px;}
    .slot{background:#fff;border:1.5px solid ${BRAND.border};border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer;}
    .slot:hover{border-color:${BRAND.primary};background:${BRAND.primary};color:#fff;}
    .empty{color:${BRAND.mutedOnLight};padding:24px 0;text-align:center;}
  </style></head><body><div class="container">
    <div class="header">${TDOT_LOGO_LIGHT_HTML}<h1 style="margin:12px 0 4px;">Book Your Consultation</h1>
    <p style="margin:0;opacity:0.85;font-size:14px;">Choose a time that works for you.</p></div>
    <form class="card" method="POST" action="/book/${lead.id}?t=${encodeURIComponent(token)}" onsubmit="return prep(event)">
      <input type="hidden" name="slotDate" id="slotDate"><input type="hidden" name="slotTime" id="slotTime">
      ${dateBlocks || '<div class="empty">No open times in the next few weeks — we will reach out to schedule.</div>'}
    </form>
    <script>
      function prep(e){const b=e.submitter;if(!b||!b.value){e.preventDefault();return false;}
        const [d,t]=b.value.split('|');document.getElementById('slotDate').value=d;document.getElementById('slotTime').value=t;return true;}
    </script>
  </div></body></html>`;
}

function buildBookingDoneHtml(lead, date, time) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Booked</title>
  <style>body{font-family:-apple-system,sans-serif;background:${BRAND.lightBg};padding:48px;text-align:center;color:${BRAND.textOnLight};}
  .box{background:#fff;padding:48px;border-radius:12px;max-width:500px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.08);}</style></head>
  <body><div class="box"><h1 style="color:${BRAND.primary}">You're booked.</h1>
  <p>${escapeHtml(date)} at ${escapeHtml(time)}. We'll email your meeting details shortly.</p></div></body></html>`;
}

// ─── WS4 — Pre-consult form ───────────────────────────────────────────────────

// GET /consult/:leadId — render the pre-consult form (token-protected)
router.get('/consult/:leadId', async (req, res) => {
  const { leadId } = req.params;
  if (!await leadTokenService.validateToken(leadId, req.query.t)) {
    return res.status(403).type('html').send('Invalid or expired link.');
  }
  try {
    const lead = await leadService.getLead(leadId);
    res.type('html').send(consultationService.buildPreConsultFormHtml(lead));
  } catch (err) {
    console.error('[Consult] GET failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

// POST /consult/:leadId — save pre-consult answers
router.post('/consult/:leadId', express.urlencoded({ extended: true }), async (req, res) => {
  const { leadId } = req.params;
  if (!await leadTokenService.validateToken(leadId, req.query.t)) {
    return res.status(403).type('html').send('Invalid token');
  }
  try {
    await consultationService.savePreConsultData(leadId, req.body);
    res.redirect(`/consult/${leadId}/thanks`);
  } catch (err) {
    console.error('[Consult] POST failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

router.get('/consult/:leadId/thanks', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Thank You</title>
  <style>body{font-family:-apple-system,sans-serif;background:${BRAND.lightBg};padding:48px;text-align:center;color:${BRAND.textOnLight};}
  .box{background:#fff;padding:48px;border-radius:12px;max-width:500px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.08);}</style></head>
  <body><div class="box"><h1 style="color:${BRAND.primary}">Thank you.</h1><p>We have your information. See you on the call!</p></div></body></html>`);
});

// ─── WS5 — Retainer ───────────────────────────────────────────────────────────

// GET /retainer/:leadId — stream the filled retainer PDF (token-protected)
router.get('/retainer/:leadId', async (req, res) => {
  const { leadId } = req.params;
  if (!await leadTokenService.validateToken(leadId, req.query.t)) {
    return res.status(403).type('html').send('Invalid or expired link.');
  }
  try {
    const lead = await leadService.getLead(leadId);
    const pdf  = await retainerService2.buildRetainerPdf(lead);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="TDOT-Retainer.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('[Retainer] GET failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

// POST /webhook/lead — Monday webhook on the Lead Board (Outcome + Retainer Signed)
router.post('/webhook/lead', express.json(), async (req, res) => {
  if (req.body && req.body.challenge) return res.json({ challenge: req.body.challenge });
  res.json({ status: 'received' });

  try {
    const event = req.body.event;
    if (!event) return;
    const C = require('../data/newLeadsBoard.json').columns;

    if (event.columnId === C.outcome) {
      const outcome = event.value?.label?.text || '';
      if (outcome === 'Retain') {
        retainerService2.onOutcomeRetain(String(event.pulseId)).catch((e) =>
          console.error('[Lead Webhook] onOutcomeRetain:', e.message));
      } else {
        console.log(`[Lead Webhook] Outcome '${outcome}' for lead ${event.pulseId} — no Phase 2 v1 action`);
      }
    } else if (event.columnId === C.retainerSigned) {
      // Monday also fires this event when the date is CLEARED (value null/empty).
      // Acting on a clear would re-set the date and re-run the signed flow —
      // staff could never un-sign a lead. Only act when a real date is present.
      if (!event.value || !event.value.date) {
        console.log(`[Lead Webhook] Retainer Signed cleared for lead ${event.pulseId} — no action`);
      } else {
        retainerService2.onRetainerSigned(String(event.pulseId)).catch((e) =>
          console.error('[Lead Webhook] onRetainerSigned:', e.message));
      }
    } else if (event.columnId === C.retainerFee) {
      // Staff filled in the per-client fee — send the payment link if the
      // retainer is already signed (no-op otherwise; signing will send it).
      // Skip clears (value null) so erasing/retyping the fee can't misfire.
      if (!event.value) {
        console.log(`[Lead Webhook] Retainer Fee cleared for lead ${event.pulseId} — no action`);
      } else {
        retainerService2.maybeSendRetainerPaymentLink(String(event.pulseId), { warnIfSent: true }).catch((e) =>
          console.error('[Lead Webhook] maybeSendRetainerPaymentLink:', e.message));
      }
    }
  } catch (err) {
    console.error('[Lead Webhook] Error:', err.message);
  }
});

module.exports = router;
