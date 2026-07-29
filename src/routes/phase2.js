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
// rev = deployed commit (Render sets RENDER_GIT_COMMIT) — lets us verify
// which build is actually serving instead of guessing at deploy timing.
router.get('/phase2/health', (req, res) => res.json({
  status: 'phase2 ok',
  rev: String(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
  // Ops diagnostics (no secrets): is the live Square calendar engaged, and which
  // consult service variation is configured (last 6 chars only, to eyeball it).
  squareCalendar: bookingService.squareCalendarEnabled(),
  consultVariation: String(process.env.SQUARE_CONSULT_SERVICE_VARIATION_ID || '').slice(-6) || null,
}));

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

// Light per-IP rate limit (in-memory sliding window). Keyed on the LAST
// X-Forwarded-For hop — Render's proxy APPENDS the true peer IP, while the
// first entry is client-supplied (spoofing it would mint a fresh bucket per
// request). Generous enough that a shared office IP never hits it, tight
// enough to stop scripted abuse.
const _intakeHits = new Map();
function intakeRateLimit(req, res, next) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = xff[xff.length - 1] || req.ip || 'unknown';
  const now = Date.now();
  const hits = (_intakeHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (hits.length >= 15) {
    return res.status(429).type('html').send('Too many submissions from this connection — please try again in a few minutes.');
  }
  hits.push(now);
  _intakeHits.set(ip, hits);
  if (_intakeHits.size > 5000) {
    // evict expired windows only — clear() would let a flood reset live counters
    for (const [k, v] of _intakeHits) {
      const live = v.filter((t) => now - t < 15 * 60 * 1000);
      if (live.length === 0) _intakeHits.delete(k); else _intakeHits.set(k, live);
    }
  }
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
    // Already booked → show the confirmation, not the slot picker (avoids a
    // re-submit / re-charge path entirely).
    if (lead && lead.bookingStatus === 'Booked') {
      const [bd, bt] = String(lead.bookedSlot || '').split(' ');
      return res.type('html').send(buildBookingDoneHtml(lead, bd || '', bt || ''));
    }
    const routing = require('../../config/consultantRouting');
    const consultant = routing.routeConsultant(lead);
    // One availability search per consultation option (duration ↔ Square
    // variation) — a 45-min consult needs a bigger clear window than a 30-min.
    // All-or-nothing: if ANY option's live search fails, EVERY option falls
    // back together to a single static-template set (no duration picker) —
    // never a mixed page where one duration shows real calendar availability
    // and the other shows unverified template times.
    const options = routing.consultOptionsFor(consultant);
    let sets = null;
    if (bookingService.squareCalendarEnabled()) {
      try {
        sets = await Promise.all(options.map(async (o) => ({
          ...o,
          slots: await bookingService.getSquareAvailableSlots(4, consultant.teamMemberId, o.variationId),
        })));
      } catch (err) {
        console.warn(`[Book] Live availability failed for lead ${leadId} — consistent static fallback: ${err.message}`);
        sets = null;
      }
    }
    if (!sets) {
      const def = options.find((o) => o.default) || options[0];
      sets = [{ ...def, slots: await bookingService.getStaticAvailableSlots(lead.tier || 'T2', 4) }];
    }
    res.type('html').send(buildBookingPageHtml(lead, { sets }, req.query.t, consultant));
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
    // In-person, phone, or virtual (defaults to Virtual if missing/invalid).
    const meetingType = ['In-person', 'Phone Call'].includes(req.body.meetingType) ? req.body.meetingType : 'Virtual';

    const lead = await leadService.getLead(leadId);
    // Double-submit guard: a lead that's already Booked must not be re-held or
    // re-charged (back button, retry, two tabs). Show their existing booking.
    if (lead && lead.bookingStatus === 'Booked') {
      const [bd, bt] = String(lead.bookedSlot || '').split(' ');
      return res.type('html').send(buildBookingDoneHtml(lead, bd || slotDate, bt || slotTime));
    }
    await bookingService.holdSlot(leadId, slotDate, slotTime);

    // Resolve the chosen consultation option (duration ↔ fee ↔ Square variation)
    // against the ROUTED consultant's list — the posted value is untrusted.
    // Missing/invalid → the consultant's default option.
    const routing = require('../../config/consultantRouting');
    const consultant = routing.routeConsultant(lead);
    const options = routing.consultOptionsFor(consultant);
    const wantedDur = parseInt(req.body.durationMin, 10);
    const option = options.find((o) => o.durationMin === wantedDur)
      || options.find((o) => o.default) || options[0];

    // Persist the meeting-type choice — drives the confirmation (Teams link vs
    // office address) and the Square appointment note.
    try { await leadService.updateLead(leadId, { meetingType }); }
    catch (e) { console.warn(`[Book] meetingType persist failed for ${leadId}: ${e.message}`); }
    // Persist the routed consultant so the assignment is durable — shown in the
    // panel, named in the meeting invite, and recorded on the case — instead of
    // being recomputed cosmetically on every render. Best-effort.
    try {
      if (consultant && consultant.name && lead.assignedConsultant !== consultant.name) {
        await leadService.updateLead(leadId, { assignedConsultant: consultant.name });
      }
    } catch (err) { console.warn(`[Book] consultant persist failed for lead ${leadId}: ${err.message}`); }

    // Everyone pays the consult fee — per the intake brief, even Critical (T0)
    // leads are "recommend paid consultation" (T0 only widens the SLOT pools).
    // The rules engine sets T0 from public form answers, so a free-T0 branch
    // would let anyone mint a free consult by ticking "removal order".
    // Escape hatch: setting SQUARE_CONSULT_FEE_CENTS=0 makes consults free for
    // everyone (deliberate config, not reachable from the form). Checked BEFORE
    // the option persists — a free consult must never record a paid option (the
    // agreement would state an amount that was never charged).
    if (bookingService.CONSULT_FEE_CENTS === 0) {
      await bookingService.confirmSlot(leadId, 'free-config', meetingType);
      return res.type('html').send(buildBookingDoneHtml(lead, slotDate, slotTime));
    }

    // Persist the chosen option — the confirm path books this exact Square
    // variation, the consult agreement states this fee/duration, and KPI
    // revenue counts it. A failed write must not block the paying client; the
    // downstream readers fall back to the env defaults (logged loudly here),
    // and the payment webhook re-verifies the option against the PAID amount.
    try {
      await leadService.updateLead(leadId, {
        consultOption: JSON.stringify({
          durationMin: option.durationMin, feeCents: option.feeCents,
          variationId: option.variationId, consultant: consultant.name,
        }),
      });
    } catch (e) { console.error(`[Book] consultOption persist FAILED for ${leadId} (fee/duration may fall back to defaults downstream): ${e.message}`); }

    const { url: checkoutUrl } = await bookingService.createCheckout({
      leadId, amount: option.feeCents,
      description: `Consultation (${option.durationMin} min) with TDOT Immigration — ${slotDate} ${slotTime}`,
      // Same lead + slot + duration + fee → same Square link (a re-submit can't
      // mint a second payable link). Duration AND fee are in the key: a changed
      // duration needs a new link, and a consultant re-route that changes the
      // fee for the same duration must not collide with the old key (Square
      // rejects idempotency reuse with a different amount).
      idempotencyKey: `lead-${leadId}-${slotDate}-${slotTime}-${option.durationMin}-${option.feeCents}`.replace(/[^A-Za-z0-9_-]/g, ''),
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

function buildBookingPageHtml(lead, slotsOrSets, token, consultant) {
  // Input: { sets: [{durationMin, feeCents, slots, default}] } (one per
  // consultation option) — or a plain slots array (legacy callers/tests),
  // rendered as a single set with no duration chooser.
  const sets = Array.isArray(slotsOrSets)
    ? [{ durationMin: null, feeCents: null, slots: slotsOrSets, default: true }]
    : ((slotsOrSets && slotsOrSets.sets) || []);
  const cad = (cents) => (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }).replace('CA', '');

  const renderDateBlocks = (slots) => {
    const byDate = {};
    for (const s of slots) (byDate[s.date] = byDate[s.date] || []).push(s);
    return Object.keys(byDate).sort().map((date) => {
      const d = new Date(`${date}T12:00:00`);
      const label = d.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
      const btns = byDate[date].map((s) =>
        `<button type="submit" name="pick" value="${s.date}|${s.time}" class="slot">${s.time}</button>`).join('');
      return `<div class="day"><div class="day-label">${label}</div><div class="slots">${btns}</div></div>`;
    }).join('');
  };

  const empty = '<div class="empty">No open times in the next few weeks — we will reach out to schedule.</div>';
  const multiDuration = sets.length > 1 && sets.every((s) => s.durationMin);
  // Duration chooser (only when the consultant offers a choice) + one slot list
  // per duration; the JS below shows the list matching the selected duration.
  const durationSection = multiDuration ? `
      <div class="mtype">
        <div class="mtype-q">Consultation length? <span style="color:${BRAND.primary}">*</span></div>
        ${sets.map((s) => `<label class="mtype-opt dur-opt${s.default ? ' sel' : ''}"><input type="radio" name="durationChoice" value="${s.durationMin}" ${s.default ? 'checked' : ''} required>
          <span class="mtype-t">⏱ ${s.durationMin} minutes</span><span class="mtype-s">${cad(s.feeCents)} CAD</span></label>`).join('')}
      </div>` : '';
  const slotSections = multiDuration
    ? sets.map((s) => `<div class="dur-slots" data-dur="${s.durationMin}" style="display:${s.default ? 'block' : 'none'}">${renderDateBlocks(s.slots) || empty}</div>`).join('')
    : (renderDateBlocks((sets[0] || {}).slots || []) || empty);
  const dateBlocks = slotSections;

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
    .mtype{margin-bottom:20px;}
    .mtype-q{font-weight:700;margin-bottom:10px;}
    .mtype-opt{display:inline-flex;flex-direction:column;gap:2px;border:1.5px solid ${BRAND.border};border-radius:10px;padding:12px 16px;margin:0 8px 8px 0;cursor:pointer;min-width:160px;user-select:none;}
    .mtype-opt.sel{border-color:${BRAND.primary};background:${BRAND.primary};color:#fff;}
    .mtype-opt input{position:absolute;opacity:0;pointer-events:none;}
    .mtype-t{font-weight:600;font-size:15px;}
    .mtype-s{font-size:12.5px;opacity:.75;}
    .pick-hint{font-weight:700;margin:6px 0 10px;}
    #redirecting{display:none;margin-top:18px;padding:14px;border-radius:8px;background:${BRAND.darkPanel};color:${BRAND.textOnDark};text-align:center;font-size:15px;}
    .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;vertical-align:-2px;margin-right:8px;animation:spin .8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body><div class="container">
    <div class="header">${TDOT_LOGO_LIGHT_HTML}<h1 style="margin:12px 0 4px;">Book Your Consultation</h1>
    <p style="margin:0;opacity:0.85;font-size:14px;">${consultant && consultant.name ? `Your consultation will be with <b>${consultant.name}</b>. ` : ''}Choose a time that works for you.</p></div>
    <form class="card" method="POST" action="/book/${lead.id}?t=${encodeURIComponent(token)}" onsubmit="return prep(event)">
      <input type="hidden" name="slotDate" id="slotDate"><input type="hidden" name="slotTime" id="slotTime">
      <input type="hidden" name="meetingType" id="meetingType"><input type="hidden" name="durationMin" id="durationMin">
      <div class="mtype" id="mtype-box">
        <div class="mtype-q">How would you like to meet? <span style="color:${BRAND.primary}">*</span></div>
        <label class="mtype-opt"><input type="radio" name="meetingTypeChoice" value="Virtual" required>
          <span class="mtype-t">💻 Virtual</span><span class="mtype-s">Online video call</span></label>
        <label class="mtype-opt"><input type="radio" name="meetingTypeChoice" value="In-person" required>
          <span class="mtype-t">🏢 In-person</span><span class="mtype-s">At our North York office</span></label>
        <label class="mtype-opt"><input type="radio" name="meetingTypeChoice" value="Phone Call" required>
          <span class="mtype-t">📞 Phone call</span><span class="mtype-s">We call you at your number</span></label>
      </div>
      ${durationSection}
      <div class="pick-hint">Then pick a time below:</div>
      ${dateBlocks}
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
        var mt=document.querySelector('input[name="meetingTypeChoice"]:checked');
        if(!mt){ e.preventDefault(); alert('Please choose Virtual, In-person, or Phone call first.'); return false; }
        var dc=document.querySelector('input[name="durationChoice"]:checked');
        // The clicked slot must belong to the SELECTED duration's list — an
        // implicit (Enter-key) submission would otherwise pick a hidden slot
        // from another duration's grid.
        var wrap=b.closest('.dur-slots');
        if(wrap && (!dc || wrap.getAttribute('data-dur')!==dc.value)){
          e.preventDefault(); alert('Please pick a time from the list for your selected consultation length.'); return false;
        }
        document.getElementById('meetingType').value=mt.value;
        if(dc) document.getElementById('durationMin').value=dc.value;
        const [d,t]=b.value.split('|');document.getElementById('slotDate').value=d;document.getElementById('slotTime').value=t;
        lockSlots(b);
        return true;}
      // Highlight the chosen option WITHIN its own group (meeting type and
      // duration are separate groups — selecting one must not clear the other).
      function bindGroup(name){
        Array.prototype.forEach.call(document.querySelectorAll('input[name="'+name+'"]'), function(r){
          r.addEventListener('change', function(){
            var box = r.closest('.mtype');
            Array.prototype.forEach.call(box.querySelectorAll('.mtype-opt'), function(o){ o.classList.remove('sel'); });
            var opt = r.closest('.mtype-opt'); if (r.checked && opt) opt.classList.add('sel');
          });
        });
      }
      bindGroup('meetingTypeChoice');
      bindGroup('durationChoice');
      // Duration switch: show that duration's availability (slot grids differ —
      // a 45-min consult needs a larger clear window than a 30-min).
      function syncDurationSlots(){
        var dc=document.querySelector('input[name="durationChoice"]:checked');
        var lists=document.querySelectorAll('.dur-slots');
        if(!dc || !lists.length) return;
        Array.prototype.forEach.call(lists, function(el){
          el.style.display = (el.getAttribute('data-dur')===dc.value) ? 'block' : 'none';
        });
      }
      Array.prototype.forEach.call(document.querySelectorAll('input[name="durationChoice"]'), function(r){
        r.addEventListener('change', syncDurationSlots);
      });
      // Card highlights must always mirror the actually-checked radios — a
      // history-restored page (Back from checkout) can desync them, and the
      // price the client expects comes from the highlighted card.
      function resyncHighlights(){
        Array.prototype.forEach.call(document.querySelectorAll('.mtype'), function(box){
          Array.prototype.forEach.call(box.querySelectorAll('.mtype-opt'), function(o){ o.classList.remove('sel'); });
          var checked = box.querySelector('input:checked');
          if(checked){ var opt=checked.closest('.mtype-opt'); if(opt) opt.classList.add('sel'); }
        });
      }
      // Coming back (e.g. cancelled on the payment page) must re-enable everything.
      window.addEventListener('pageshow', function(){
        var btns = document.querySelectorAll('.slot');
        for (var i = 0; i < btns.length; i++) { btns[i].disabled = false; btns[i].classList.remove('picked'); }
        document.getElementById('slotDate').value = ''; document.getElementById('slotTime').value = '';
        document.getElementById('meetingType').value = '';
        document.getElementById('durationMin').value = '';
        document.getElementById('redirecting').style.display = 'none';
        syncDurationSlots();
        resyncHighlights();
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
    const pdf  = await retainerService2.getRetainerDocument(lead);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="TDOT-Retainer.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('[Retainer] GET failed:', err.message);
    res.status(500).type('html').send(buildErrorHtml(err.message));
  }
});

// GET /consult-agreement/:leadId — stream the Initial Consultation agreement PDF
// (token-protected, mirrors /retainer/:leadId).
router.get('/consult-agreement/:leadId', async (req, res) => {
  const { leadId } = req.params;
  if (!await leadTokenService.validateToken(leadId, req.query.t)) {
    return res.status(403).type('html').send('Invalid or expired link.');
  }
  try {
    const lead = await leadService.getLead(leadId);
    const pdf  = await require('../services/consultAgreementService').getConsultAgreementDocument(lead);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="TDOT-Initial-Consultation.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('[ConsultAgreement] GET failed:', err.message);
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
      const outcome = (event.value?.label?.text || '').trim();
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
      // Staff filled in the per-client fee. Two things may now be unblocked:
      //  • the retainer AGREEMENT (held until the fee exists, since it states
      //    the fee) — sent if the lead is already Outcome=Retain;
      //  • the PAYMENT LINK — sent if the retainer is already signed.
      // Both are guarded/idempotent, so only the appropriate one fires.
      // Skip clears (value null) so erasing/retyping the fee can't misfire.
      if (!event.value) {
        console.log(`[Lead Webhook] Retainer Fee cleared for lead ${event.pulseId} — no action`);
      } else {
        retainerService2.maybeSendRetainerAgreement(String(event.pulseId)).catch((e) =>
          console.error('[Lead Webhook] maybeSendRetainerAgreement:', e.message));
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

// POST /webhook/documenso — e-signature completion (auto-capture signed agreements)
//
// Authenticated by the shared X-Documenso-Secret header (constant-time compare,
// fail-closed). On DOCUMENT_COMPLETED we download the signed PDF, store it to
// OneDrive, and set the "signed" state — for the retainer that opens the case,
// exactly as a manual "Mark retainer signed" would.
router.post('/webhook/documenso', express.json({ limit: '2mb' }), async (req, res) => {
  const documenso = require('../services/documensoService');
  if (!documenso.verifyWebhook(req.headers)) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  documenso.recordWebhook(req.body); // for live-calibration confirmation
  res.json({ status: 'received' }); // ack fast; process async
  try {
    const result = await documenso.captureCompleted(req.body);
    console.log('[Documenso Webhook]', JSON.stringify(result));
  } catch (err) {
    console.error('[Documenso Webhook] capture failed:', err.message);
  }
});

module.exports = router;
module.exports.buildBookingPageHtml = buildBookingPageHtml; // exported for tests / preview
