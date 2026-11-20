'use strict';

/**
 * Is the client READY for their consultation? One word per booked consultation,
 * for the "Ready" column of the Consultations page (Gauri A1, 2026-11-19: "Both
 * are required" — the signed consultation agreement and the filled
 * pre-consultation form).
 *
 *   ready     — the agreement is signed and the form is in
 *   form      — signed, the form is not in
 *   agreement — sent and not signed yet, the form is in
 *   both      — sent and not signed yet, the form is not in
 *   notsent   — the agreement was never sent, and nobody chose that (a package
 *               held or failed, a booking made by hand in Monday, not paid yet …)
 *   notasked  — never sent because staff chose not to send it
 *
 * "Staff chose not to send" (Faran 2026-11-20) is one of:
 *   - a direct consultation whose pop-up did not ask for the package (the box
 *     was left unticked — existing clients too). One corner: the box was ticked
 *     (the fee record says "send") and the booking save failed, so the tick itself
 *     was lost — staff did ask, so that row reads "not sent";
 *   - a fee record that says "No" (package 'skip') on a lead with NO online
 *     payment. A later payment through the booking link makes the app owe the
 *     package again (consultationService.recordedPackageWanted), so that row
 *     reads "not sent".
 *
 * DISPLAY ONLY. It reads the fields the list copy already holds (leadSnapshot)
 * and nothing else: no Monday call, nothing written, nothing blocked, nothing
 * emailed. A signature is the Signed date alone — a signed agreement with a
 * blank Sent date is still signed. The mark does not look at the consultation's
 * date: the page shows it for consultations still to happen only.
 * PURE. Never throws: text that cannot be read counts as not there.
 */

const WORDS = ['ready', 'form', 'agreement', 'both', 'notsent', 'notasked'];

const s = (v) => { try { return String(v == null ? '' : v).trim(); } catch (_) { return ''; } };

/** Did staff choose not to send the agreement and form? (see the header) */
function staffChoseNotToSend(lead) {
  let rec = null;
  try { rec = require('../services/consultPaymentService').parseConsultPayment(lead); } catch (_) { /* unreadable: no record */ }
  try {
    const dc = require('./directConsult');
    // A "send" on a direct row's fee record can only be its own pop-up's tick: not a choice to skip.
    if (dc.isDirectConsult(lead) && !dc.packageAsked(lead) && !(rec && rec.package === 'send')) return true;
  } catch (_) { /* unreadable: not a choice we can see */ }
  if (rec && rec.package === 'skip' && !s(lead && lead.squareConsultTxnId)) return true;
  return false;
}

/** 'ready' | 'form' | 'agreement' | 'both' | 'notsent' | 'notasked' */
function consultReady(lead) {
  const l = (lead && typeof lead === 'object') ? lead : {};
  const signed = !!s(l.consultAgreementSigned), sent = !!s(l.consultAgreementSent);
  const form = s(l.preConsultSubmitted) === 'Yes';
  if (signed) return form ? 'ready' : 'form';
  if (sent) return form ? 'agreement' : 'both';
  return staffChoseNotToSend(l) ? 'notasked' : 'notsent';
}

module.exports = { consultReady, WORDS };
