'use strict';

/**
 * Staff attachments on a new client (Faran 2026-11-04): a screenshot / picture of
 * the client's details (often all Shafoli has is a WhatsApp screenshot) attached
 * on the Add lead and Direct retainer forms, or later on the lead page.
 *
 * WHO: only the people listed here, and only when signed in with Monday (the shared
 * team key alone is never enough). Default: Shafoli. STAFF_ATTACHMENT_EMAILS
 * (comma-separated) replaces the list — e.g. to add someone later without a release.
 */

const DEFAULT_EMAILS = ['shafoli@tdotimm.com'];

function allowedEmails() {
  const raw = String(process.env.STAFF_ATTACHMENT_EMAILS || '').trim();
  const list = raw ? raw.split(',') : DEFAULT_EMAILS;
  return list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
}

/** May this signed-in staff member (the Monday sign-in cookie's payload) attach files? */
function canAttach(staff) {
  const email = String((staff && staff.email) || '').trim().toLowerCase();
  return !!email && allowedEmails().includes(email);
}

/** Pictures and PDFs only — judged by the file NAME's extension, never the browser's type. */
const EXTENSIONS = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.webp': 'image/webp', '.pdf': 'application/pdf' });
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 5;   // per form; one upload request per file

function extensionOf(name) {
  const m = /\.[a-z0-9]{1,5}$/i.exec(String(name || '').trim());
  return m ? m[0].toLowerCase() : '';
}

module.exports = { allowedEmails, canAttach, EXTENSIONS, MAX_FILE_BYTES, MAX_FILES, extensionOf };
