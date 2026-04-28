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

// Inverted (white) logo for dark headers
const TDOT_LOGO_LIGHT_HTML = `<img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration" style="height:36px;object-fit:contain;display:block">`;
const TDOT_LOGO_LIGHT_HTML_LARGE = `<img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=192&q=75" alt="TDOT Immigration" style="height:46px;object-fit:contain;display:block">`;

module.exports = { BRAND, TDOT_LOGO_LIGHT_HTML, TDOT_LOGO_LIGHT_HTML_LARGE };
