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

const express     = require('express');
const router      = express.Router();
const leadService = require('../services/leadService');
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

module.exports = router;
