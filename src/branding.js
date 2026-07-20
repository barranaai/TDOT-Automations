/**
 * TDOT Branding constants
 *
 * Single source of truth for brand colors + logo so client-facing pages
 * (portal, questionnaire form, document upload, review pages) and emails
 * stay visually consistent.
 *
 * Colors:
 *   #8B0000 — primary (deep brand red / burgundy)
 *   #6B0000 — primary hover (darker)
 *   #C9A84C — premium accent (gold)
 *   #0B1D32 — dark panels (header bars, footers)
 *   #FAF8F4 — light-mode background (warm off-white)
 *
 * Logo: official inverted (white) TDOT logo served from tdotimm.com — works
 *       on dark panels. Use TDOT_LOGO_DARK on light-mode hero backgrounds
 *       (same image; light = same image but rendered in a styled container).
 */

'use strict';

const BRAND = Object.freeze({
  primary:        '#8B0000',
  primaryHover:   '#6B0000',
  accent:         '#C9A84C',
  accentSoft:     '#E2C97A',
  darkPanel:      '#0B1D32',
  darkPanelSoft:  '#152F4F',
  lightBg:        '#FAF8F4',
  lightCard:      '#FFFFFF',
  textOnDark:     '#FFFFFF',
  textOnLight:    '#1F2937',
  mutedOnLight:   '#6B7280',
  border:         '#E7E2D6',  // warm border to match lightBg
});

// TDOT logo — SELF-HOSTED at /assets/tdot-logo.png (public/tdot-logo.png). The old
// tdotimm.com/_next/image URL now 404s (site moved to WordPress); self-hosting on
// our own domain means it never breaks again AND loads in email clients (Gmail/
// Outlook block data-URI images, but a normal HTTPS URL is fine). The official logo
// is colour-on-white, so it sits on a white "chip" to read on dark email headers.
const LOGO_URL = `${process.env.RENDER_URL || 'https://tdot-automations.onrender.com'}/assets/tdot-logo.png`;
const TDOT_LOGO_LIGHT_HTML = `<img src="${LOGO_URL}" alt="TDOT Immigration" style="height:36px;background:#fff;padding:5px 9px;border-radius:7px;object-fit:contain;display:inline-block">`;
const TDOT_LOGO_LIGHT_HTML_LARGE = `<img src="${LOGO_URL}" alt="TDOT Immigration" style="height:46px;background:#fff;padding:6px 11px;border-radius:8px;object-fit:contain;display:inline-block">`;

module.exports = { BRAND, TDOT_LOGO_LIGHT_HTML, TDOT_LOGO_LIGHT_HTML_LARGE };
