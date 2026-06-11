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

// ─── WS2 — Lead capture (V2 intake form, TDOT brief sections A–G) ────────────

const intakeFormService = require('../services/intakeFormService');
const multer = require('multer');
const intakeUpload = multer({
  storage: multer.memoryStorage(),
  // Tight limits — this is a public unauthenticated endpoint. fields/fieldSize/
  // parts caps prevent memory-exhaustion via flooded multipart bodies.
  limits: { fileSize: 15 * 1024 * 1024, files: 4, fields: 120, fieldSize: 64 * 1024, parts: 140 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|jpe?g|png)$/i.test(file.originalname || '');
    if (!ok) { // dropped files are surfaced to staff in the digest, not lost silently
      req.body._rejectedUploads = req.body._rejectedUploads || [];
      req.body._rejectedUploads.push(file.originalname || '(unnamed file)');
    }
    cb(null, ok);
  },
});

// Light per-IP rate limit (in-memory sliding window). Keyed on the first
// X-Forwarded-For hop (Render sits behind a proxy); generous enough that a
// shared office IP never hits it, tight enough to stop scripted abuse.
const _intakeHits = new Map();
function intakeRateLimit(req, res, next) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const hits = (_intakeHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (hits.length >= 15) {
    return res.status(429).type('html').send('Too many submissions from this connection — please try again in a few minutes.');
  }
  hits.push(now);
  _intakeHits.set(ip, hits);
  if (_intakeHits.size > 5000) _intakeHits.clear(); // bound memory
  next();
}

// GET /lead/new — render the public intake form
router.get('/lead/new', (req, res) => {
  res.type('html').send(intakeFormService.buildIntakeFormHtml());
});

// POST /lead/new — validate, create the lead, archive to OneDrive, AI second opinion
const intakeUploadFields = intakeUpload.fields([
  { name: 'enforcementLetterFile', maxCount: 1 }, { name: 'refusalLetterFile', maxCount: 1 },
  { name: 'f9LetterFile', maxCount: 1 }, { name: 'f10LetterFile', maxCount: 1 },
]);
router.post('/lead/new', intakeRateLimit,
  (req, res, next) => intakeUploadFields(req, res, (err) => {
    if (!err) return next();
    // Multer errors (file too big etc.) must NOT fall to the global JSON 500 —
    // give the person a friendly page instead of silently losing their submission.
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    console.warn('[Lead] /lead/new upload error:', err.code || err.message);
    res.status(tooBig ? 413 : 400).type('html').send(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Upload problem</title></head>
       <body style="font-family:-apple-system,sans-serif;padding:48px;max-width:560px;margin:0 auto">
       <h2>${tooBig ? 'That file is too large' : 'There was a problem with your upload'}</h2>
       <p>${tooBig ? 'Uploaded files must be under 15 MB each. Please compress the file or take a smaller photo/scan.' : 'Please check the uploaded files and try again.'}</p>
       <p><a href="javascript:history.back()">← Go back to the form</a> — your answers are still there.</p></body></html>`);
  }),
  async (req, res) => {
    try {
      const result = await intakeFormService.processIntakeSubmission(req.body || {}, req.files || {});
      res.status(result.ok ? 200 : 400).type('html').send(result.html);
    } catch (err) {
      console.error('[Lead] /lead/new POST failed:', err.message);
      res.status(500).type('html').send(buildErrorHtml(err.message));
    }
  });


function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

    // Everyone pays the consult fee — per the intake brief, even Critical (T0)
    // leads are "recommend paid consultation" (T0 only widens the SLOT pools).
    // The rules engine sets T0 from public form answers, so a free-T0 branch
    // would let anyone mint a free consult by ticking "removal order".
    // Escape hatch: setting SQUARE_CONSULT_FEE_CENTS=0 makes consults free for
    // everyone (deliberate config, not reachable from the form).
    const fee = bookingService.CONSULT_FEE_CENTS;
    if (fee === 0) {
      await bookingService.confirmSlot(leadId, 'free-config');
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
    // req.rawBody = exact bytes captured by the global JSON parser (server.js);
    // req.body is only a Buffer here when that parser skipped (non-JSON CT).
    const raw = (req.rawBody || req.body).toString();
    const sig = req.headers['x-square-hmacsha256-signature'];
    // Square signs (notificationUrl + rawBody) with the EXACT URL configured
    // on the subscription — normalize trailing slashes so an env-var quirk
    // (RENDER_URL ending in "/") can't break every signature.
    const base = String(process.env.RENDER_URL || '').replace(/\/+$/, '');
    const url = `${base}/webhook/square`;
    if (!bookingService.verifySquareSignature(raw, sig, url)) {
      console.warn(`[Square Webhook] Bad signature — ignoring (url used: "${url}", sig present: ${!!sig}, secret set: ${!!process.env.SQUARE_WEBHOOK_SECRET})`);
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
    .slot:hover:not(:disabled){border-color:${BRAND.primary};background:${BRAND.primary};color:#fff;}
    .slot:disabled{opacity:.45;cursor:not-allowed;}
    .slot.picked{border-color:${BRAND.primary};background:${BRAND.primary};color:#fff;opacity:1;}
    .empty{color:${BRAND.mutedOnLight};padding:24px 0;text-align:center;}
    #redirecting{display:none;margin-top:18px;padding:14px;border-radius:8px;background:${BRAND.darkPanel};color:${BRAND.textOnDark};text-align:center;font-size:15px;}
    .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;vertical-align:-2px;margin-right:8px;animation:spin .8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body><div class="container">
    <div class="header">${TDOT_LOGO_LIGHT_HTML}<h1 style="margin:12px 0 4px;">Book Your Consultation</h1>
    <p style="margin:0;opacity:0.85;font-size:14px;">Choose a time that works for you.</p></div>
    <form class="card" method="POST" action="/book/${lead.id}?t=${encodeURIComponent(token)}" onsubmit="return prep(event)">
      <input type="hidden" name="slotDate" id="slotDate"><input type="hidden" name="slotTime" id="slotTime">
      ${dateBlocks || '<div class="empty">No open times in the next few weeks — we will reach out to schedule.</div>'}
      <div id="redirecting"><span class="spin"></span>Reserving your time — taking you to secure payment…</div>
    </form>
    <script>
      function lockSlots(picked){
        var btns = document.querySelectorAll('.slot');
        for (var i = 0; i < btns.length; i++) { btns[i].disabled = true; }
        if (picked) picked.classList.add('picked');
        document.getElementById('redirecting').style.display = 'block';
      }
      function prep(e){const b=e.submitter;if(!b||!b.value){e.preventDefault();return false;}
        if (document.getElementById('slotDate').value) { e.preventDefault(); return false; } // double-submit guard
        const [d,t]=b.value.split('|');document.getElementById('slotDate').value=d;document.getElementById('slotTime').value=t;
        lockSlots(b);
        return true;}
      // Coming back (e.g. cancelled on the payment page) must re-enable everything.
      window.addEventListener('pageshow', function(){
        var btns = document.querySelectorAll('.slot');
        for (var i = 0; i < btns.length; i++) { btns[i].disabled = false; btns[i].classList.remove('picked'); }
        document.getElementById('slotDate').value = ''; document.getElementById('slotTime').value = '';
        document.getElementById('redirecting').style.display = 'none';
      });
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
    res.type('html').send(await consultationService.buildPreConsultFormHtml(lead));
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

// POST /webhook/zoom — Zoom event subscription (meeting.ended, recording.completed).
// Raw body: Zoom's x-zm-signature is an HMAC over the exact bytes. The URL-
// validation handshake must be answered synchronously; real events are 200'd
// fast and processed async (Zoom retries on slow/non-200 responses).
router.post('/webhook/zoom', express.raw({ type: '*/*' }), (req, res) => {
  const zoomWebhookService = require('../services/zoomWebhookService');
  try {
    const raw = (req.rawBody || req.body).toString();
    const check = zoomWebhookService.verifyZoomSignature(
      raw, req.headers['x-zm-signature'], req.headers['x-zm-request-timestamp']);
    if (!check.ok) {
      console.warn(`[Zoom Webhook] Rejected (${check.reason})${check.reason === 'no-secret'
        ? ' — set ZOOM_WEBHOOK_SECRET_TOKEN on the server, then click Validate in the Zoom app' : ''}`);
      return res.status(401).json({ error: 'signature verification failed' });
    }
    const event = JSON.parse(raw);

    // Zoom's endpoint validation handshake — must answer with the token math.
    if (event.event === 'endpoint.url_validation') {
      return res.json(zoomWebhookService.buildValidationResponse(event.payload?.plainToken));
    }

    res.json({ status: 'received' }); // ack fast, then process
    zoomWebhookService.handleZoomEvent(event).catch((err) =>
      console.error('[Zoom Webhook] Handler error:', err.message));
  } catch (err) {
    console.error('[Zoom Webhook] Error:', err.message);
    if (!res.headersSent) res.status(400).json({ error: 'bad request' });
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
    } else if (event.columnId === C.bookingInvite) {
      // The board "button": staff flip Booking Invite → "Send" and the client
      // is emailed their personal booking link (column flips to "Sent").
      // Only the explicit "Send" label acts — "Sent" (our own write), clears,
      // and anything else are ignored, so no loops and no misfires.
      if (event.value?.label?.text === 'Send') {
        bookingService.sendBookingInvite(String(event.pulseId), { force: true }).catch((e) =>
          console.error('[Lead Webhook] sendBookingInvite:', e.message));
      }
    }
  } catch (err) {
    console.error('[Lead Webhook] Error:', err.message);
  }
});

module.exports = router;
