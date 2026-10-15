'use strict';

/**
 * The staff roster for the pickers: "Added by" on Add lead, the lead owner on
 * the lead page, and the consultation page's attribution dropdowns (lead
 * owner / booked by / payment reviewed by). PORTAL_STAFF on Render overrides
 * the default without a deploy. The consultants are always on it (Faran
 * 2026-10-15: Shafoli assigns leads to follow up — herself included).
 */
const PORTAL_STAFF = (process.env.PORTAL_STAFF || 'Gauri,Kamal,Asmita,Prajwal,Melanie,Diksha')
  .split(',').map((s) => s.trim()).filter(Boolean);

const first = (n) => String(n || '').trim().split(/\s+/)[0].toLowerCase();

/** PORTAL_STAFF plus each consultant whose first name is not already on it. */
function staffRoster() {
  let consultants = [];
  try { consultants = Object.values(require('./consultantRouting').CONSULTANTS).map((c) => c.name).filter(Boolean); } catch (_) { /* config optional */ }
  const out = PORTAL_STAFF.slice();
  for (const c of consultants) if (!out.some((s) => first(s) === first(c))) out.push(c);
  return out;
}

/**
 * The roster name for someone signed in with Monday ("Melanie Smith" →
 * "Melanie"), so the same person is never counted under two spellings.
 * No unique first-name match → their Monday name as it is.
 */
function rosterNameFor(mondayName) {
  const n = String(mondayName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) return '';
  const hits = staffRoster().filter((s) => first(s) === first(n));
  return hits.length === 1 ? hits[0] : n;
}

const onRoster = (name) => staffRoster().includes(String(name || '').trim());

module.exports = { PORTAL_STAFF, staffRoster, rosterNameFor, onRoster };
