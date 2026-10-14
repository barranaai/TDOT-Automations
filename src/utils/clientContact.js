'use strict';

/**
 * How a client reaches us from an app email (Gauri 2026-10-08; Faran 2026-10-15).
 *
 * The app's emails are sent from a no-reply mailbox: a client who replies gets
 * "this email is not available" back. So no client email may say "just reply" —
 * each one points at the office inbox instead, and says plainly that replies
 * are not read. One place for the wording, so every email says the same thing.
 */

const CLIENT_CONTACT_EMAIL = 'info@tdotimm.com';

/** "email us at info@tdotimm.com" (the address as a mail link; inherits the line's colour). */
const EMAIL_US = `email us at <a href="mailto:${CLIENT_CONTACT_EMAIL}" style="color:inherit">${CLIENT_CONTACT_EMAIL}</a>`;

/** The sentence that tells a client not to reply. */
const NO_REPLY = 'Please don\'t reply to this email — this inbox isn\'t monitored.';

module.exports = { CLIENT_CONTACT_EMAIL, EMAIL_US, NO_REPLY };
