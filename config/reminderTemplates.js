'use strict';

/**
 * Document-collection reminder templates — the CODE defaults (team meeting
 * 2026-11-05, block 2). The team's own wording lives on the Monday board
 * "Reminder Templates" (env MONDAY_REMINDER_TEMPLATES_BOARD_ID, read by
 * src/services/docReminderTemplates.js); a row that is missing, switched off
 * or invalid falls back to the matching default here, so the reminders work
 * before the board exists and keep working when a board edit goes wrong.
 *
 * Plain text only. Blank line = new paragraph. Merge tokens, exact spelling:
 *   {ClientName} {CaseRef} {CaseType} {MissingList} {MissingCount}
 *   {Deadline} {PromisedDate} {LastDay} {PortalLink} {StaffName}
 * {MissingList} is required in every body — the app puts the missing-documents
 * list there. The portal button and the "email us" closing line are added by
 * the app OUTSIDE the template, so they cannot be edited away. Never write
 * "just reply" / "reply to this email": the sender is a no-reply mailbox
 * (src/utils/clientContact.js).
 */

const TOKENS = Object.freeze(['ClientName', 'CaseRef', 'CaseType', 'MissingList', 'MissingCount', 'Deadline', 'PromisedDate', 'LastDay', 'PortalLink', 'StaffName']);

/** Board row names (and the keys here); the staff levels 1/2/3 and the automatic email map onto them. */
const ROW_NAMES = Object.freeze(['Reminder 1', 'Reminder 2', 'Final', 'Automatic']);
const LEVEL_ROWS = Object.freeze({ 1: 'Reminder 1', 2: 'Reminder 2', 3: 'Final', auto: 'Automatic' });

const DEFAULTS = Object.freeze({
  'Reminder 1': {
    subject: 'Documents still needed for your {CaseType} application — {CaseRef}',
    body: `Dear {ClientName},

Thank you for starting your document upload. To move your {CaseType} application forward, we still need the following documents from you:

{MissingList}

Please upload them through your client portal:
{PortalLink}

If any document is not available yet, let us know when you expect to have it.

Kind regards,
{StaffName}
TDOT Immigration Services`,
  },

  'Reminder 2': {
    subject: 'Second reminder: {MissingCount} documents still missing — {CaseRef}',
    body: `Dear {ClientName},

This is our second reminder about your {CaseType} application. We cannot continue preparing your file until we receive the documents below, which are still missing:

{MissingList}

Please upload them as soon as possible through your client portal:
{PortalLink}

If you are having difficulty obtaining any of these documents, tell us right away so we can plan the next step with you.

Regards,
{StaffName}
TDOT Immigration Services`,
  },

  // The consequence is WORDING only (plan §3c): the app moves nothing, refunds
  // nothing and starts no timer after {LastDay} — staff decide, by hand.
  'Final': {
    subject: 'Final reminder: documents required by {LastDay} — {CaseRef}',
    body: `Dear {ClientName},

This is our final reminder about your {CaseType} application. Despite our earlier reminders, the following documents are still missing:

{MissingList}

We will wait until {LastDay} for these documents. Please upload them through your client portal before then:
{PortalLink}

If we have not received them by {LastDay}, your file will be moved out of document collection. TDOT Immigration may then refund the fee paid, less the non-refundable administration fee, or place your file with our stuck applications until you are ready to continue. You are welcome to come back to us whenever you are ready.

Regards,
{StaffName}
TDOT Immigration Services`,
  },

  // Sent by the app itself (real deadline, under 50 % uploaded) — no staff name.
  'Automatic': {
    subject: 'Documents needed for your {CaseType} application — {CaseRef}',
    body: `Dear {ClientName},

Your {CaseType} application must be submitted by {Deadline}. We can only proceed once we have the documents below, which are still missing:

{MissingList}

Please upload them through your client portal as soon as you can:
{PortalLink}

If any document is not available yet, let us know when you expect to have it, so we can plan around the deadline.

Regards,
TDOT Immigration Services`,
  },
});

module.exports = { TOKENS, ROW_NAMES, LEVEL_ROWS, DEFAULTS };
