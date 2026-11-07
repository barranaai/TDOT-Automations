'use strict';

/**
 * Document-collection reminder templates — the CODE defaults (team meeting
 * 2026-11-05, block 2). The team's own wording lives on the Monday board
 * "Reminder Templates" (env MONDAY_REMINDER_TEMPLATES_BOARD_ID, read by
 * src/services/docReminderTemplates.js); a row that is missing, switched off
 * or invalid falls back to the matching default here, so the reminders work
 * before the board exists and keep working when a board edit goes wrong.
 *
 * Reminder 1 / Reminder 2 / Final are Gauri's texts (2026-11-07), personalised:
 * "Hello {ClientName}," and the client's own lists. Changed from her drafts only
 * where a rule forces it — the second reminder's "Please reply to this email
 * once…" became "Please let us know once…" (the sender is a no-reply mailbox),
 * the final names {LastDay} in its "immediately" sentence (the Needs-attention
 * rule 'final-last-day-passed' reads that date), two grammar fixes in the final
 * ("and/or your completed questionnaire", "started again, and additional charges
 * will apply"), her first reminder's lines 3 and 4 joined into one paragraph,
 * a "Your client portal:" line after the lists and the "Kind regards" sign-off.
 *
 * Plain text only. Blank line = new paragraph. Merge tokens, exact spelling:
 *   {ClientName} {CaseRef} {CaseType} {MissingList} {QuestionnaireList}
 *   {MissingCount} {Deadline} {PromisedDate} {LastDay} {PortalLink} {StaffName}
 * {MissingList} is required in every body — the app puts the client's missing
 * documents there, under its own lead line "Documents still needed (N):".
 * {QuestionnaireList} is where the app puts what is unfinished in the client's
 * questionnaire — one line per family member who has not submitted yet, under
 * "Questionnaire still to finish:" — filled per client by the app. Both blocks
 * are left out cleanly (heading and all) when there is nothing to list; the
 * questionnaire block is also left out when its progress could not be read.
 * A text without {QuestionnaireList} gets it added after the documents list
 * (with a warning) when the client's questionnaire is unfinished. Keep each
 * list token on its own paragraph. The portal button and the "email us"
 * closing line are added by the app OUTSIDE the template, so they cannot be
 * edited away. Never write "just reply" / "reply to this email": the sender is
 * a no-reply mailbox (src/utils/clientContact.js).
 */

const TOKENS = Object.freeze(['ClientName', 'CaseRef', 'CaseType', 'MissingList', 'QuestionnaireList', 'MissingCount', 'Deadline', 'PromisedDate', 'LastDay', 'PortalLink', 'StaffName']);

/** Board row names (and the keys here); the staff levels 1/2/3 and the automatic email map onto them. */
const ROW_NAMES = Object.freeze(['Reminder 1', 'Reminder 2', 'Final', 'Automatic']);
const LEVEL_ROWS = Object.freeze({ 1: 'Reminder 1', 2: 'Reminder 2', 3: 'Final', auto: 'Automatic' });

const DEFAULTS = Object.freeze({
  'Reminder 1': {
    subject: 'Reminder: documents and questionnaire for your {CaseType} application — {CaseRef}',
    body: `Hello {ClientName},

I hope you are doing well.

Please ensure that you complete the questionnaire to 100% and upload at least 80% of the required documents to your client portal. Please note that both requirements must be fulfilled before we can assign your application to an officer for further processing.

{MissingList}

{QuestionnaireList}

Your client portal:
{PortalLink}

We kindly request you to complete the questionnaire and upload the pending documents as soon as possible to avoid any delays in your application process.

If you have any questions or require assistance with uploading the documents or completing the questionnaire, please feel free to contact us.

Thank you for your cooperation.

Kind regards,
{StaffName}
TDOT Immigration Services`,
  },

  'Reminder 2': {
    subject: 'Second reminder: documents and questionnaire for your {CaseType} application — {CaseRef}',
    body: `Hello {ClientName},

Please let us know once you have uploaded your documents and completed the questionnaire.

To assign your application to a Case Officer and begin the review process, at least 80% of the requested documents and information must be completed and available in your file.

{MissingList}

{QuestionnaireList}

Your client portal:
{PortalLink}

If your current immigration status is approaching expiry, please keep track of the expiry date and inform our office well in advance. Please do not wait until the last minute, as sufficient time is required to review and prepare your application.

If you have any questions regarding the document checklist or questionnaire, please feel free to contact us. We will be happy to assist.

Thank you for your cooperation.

Kind regards,
{StaffName}
TDOT Immigration Services`,
  },

  // The consequence is WORDING only (plan §3c): the app closes nothing, charges
  // nothing and starts no timer after {LastDay} — staff decide, by hand. Gauri's
  // text (2026-11-07) replaced the earlier refund / stuck-applications wording.
  'Final': {
    subject: 'Final reminder: please complete your documents and questionnaire by {LastDay} — {CaseRef}',
    body: `Hello {ClientName},

This is the final reminder regarding your pending documents and questionnaire required to proceed with your application.

Despite previous reminders, we have not yet received all the required documents and/or your completed questionnaire. Please note that no further processing can begin until all outstanding requirements are submitted.

{MissingList}

{QuestionnaireList}

Your client portal:
{PortalLink}

You are requested to complete the questionnaire and upload all pending documents immediately, and no later than {LastDay}. Failure to do so may result in your file being closed or marked inactive.

If the file is closed due to non-submission, any future request to proceed may require the application to be started again, and additional charges will apply.

Please treat this as your final opportunity to complete the requirements without further delay. If you have already submitted the documents, kindly inform us so we can verify and update your file.

We strongly recommend completing all pending requirements promptly to avoid delays, file closure, or additional charges.

Kind regards,
{StaffName}
TDOT Immigration Services`,
  },

  // Sent by the app itself (real deadline, under 50 % uploaded) — no staff name.
  'Automatic': {
    subject: 'Documents needed for your {CaseType} application — {CaseRef}',
    body: `Dear {ClientName},

Your {CaseType} application must be submitted by {Deadline}. We can only proceed once we have the documents below, which are still missing:

{MissingList}

{QuestionnaireList}

Please upload them through your client portal as soon as you can:
{PortalLink}

If any document is not available yet, let us know when you expect to have it, so we can plan around the deadline.

Regards,
TDOT Immigration Services`,
  },
});

module.exports = { TOKENS, ROW_NAMES, LEVEL_ROWS, DEFAULTS };
