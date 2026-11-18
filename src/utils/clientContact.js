'use strict';

/**
 * How a client reaches us from an app email (reply-thread change, Faran 2026-11-18).
 *
 * Until 2026-11 the app's emails said "Please don't reply — this inbox isn't
 * monitored". Now every CLIENT-facing email the app sends through
 * microsoftMailService.sendEmail carries Reply-To: info@tdotimm.com, so a reply
 * lands in the office inbox, and the email reader (emailLeadsService) files it on
 * the case named in the subject as a "📧 Email received" note. Each client email
 * shows one highlighted notice asking the client to reply to THIS email (not to
 * start a new one) so the whole conversation stays on their file.
 *
 * Rules (do not undo):
 *  - CLIENT_REPLY_TO is a code constant, never the EMAIL_REPLY_TO env value (that
 *    value is unknown on Render and an old non-tdotimm address locally).
 *    emailLeadsService still reads EMAIL_REPLY_TO to SKIP that old address.
 *  - There is no default Reply-To inside sendEmail: staff-only alerts keep theirs.
 *    Every client send site passes `replyTo: CLIENT_REPLY_TO` explicitly
 *    (test/replyThread.test.js scans for it).
 *  - The three notice texts are Faran's approved wording, verbatim.
 */

const CLIENT_CONTACT_EMAIL = 'info@tdotimm.com';

/** The Reply-To on every client email: the office inbox the email reader watches. */
const CLIENT_REPLY_TO = CLIENT_CONTACT_EMAIL;

/** "email us at info@tdotimm.com" (the address as a mail link; inherits the line's colour). Pages only. */
const EMAIL_US = `email us at <a href="mailto:${CLIENT_CONTACT_EMAIL}" style="color:inherit">${CLIENT_CONTACT_EMAIL}</a>`;

/**
 * The notice texts, after the bold "Important:" (Faran approved verbatim, 2026-11-18).
 *  items — a case email that asks the client for something (documents, corrections, …)
 *  case  — a case email that asks for nothing (receipt, signed copy, portal link, payment request)
 *  lead  — an email before a case exists (inquiry, booking, consultation, agreement, …)
 */
const NOTICE_TEXT = Object.freeze({
  items: 'Please reply directly to this email rather than starting a new one, so that all correspondence stays on your file. Documents should be uploaded through your secure portal link, not sent as attachments. Not providing the items requested, or writing to us in a separate email, may delay your case.',
  case:  'If you need to contact us about this email, please reply directly to it rather than starting a new one, so that all correspondence stays on your file. Writing to us in a separate email may delay your case.',
  lead:  'If you need to contact us about this email, please reply directly to it rather than starting a new one, so that all correspondence stays on your file. Writing to us in a separate email may delay our response.',
});

const NOTICE_KINDS = Object.freeze(Object.keys(NOTICE_TEXT));

function noticeKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(NOTICE_TEXT, kind)) {
    throw new Error(`Unknown reply-notice kind "${kind}" (expected ${NOTICE_KINDS.join(' | ')})`);
  }
  return kind;
}

/** The plain-text notice ("Important: …"), for text parts. */
function replyNoticeText(kind) {
  return `Important: ${NOTICE_TEXT[noticeKind(kind)]}`;
}

/**
 * The highlighted notice as an inline-styled HTML block. A one-cell table with
 * bgcolor + inline styles: renders as a box in Outlook (Word engine) and Gmail,
 * which both ignore <style> blocks and most div backgrounds. Block-level — put
 * it between paragraphs, never inside a <p>.
 * @param {'items'|'case'|'lead'} kind
 * @param {{ margin?: string }} [opts] outer margin (CSS shorthand), default '20px 0 0'
 */
function replyNoticeHtml(kind, opts = {}) {
  const text = NOTICE_TEXT[noticeKind(kind)];
  const margin = typeof opts.margin === 'string' && /^[0-9a-z .%-]+$/i.test(opts.margin) ? opts.margin : '20px 0 0';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;margin:${margin};">
  <tr><td bgcolor="#FFF7E0" style="background:#FFF7E0;border:1px solid #E8C96A;border-left:4px solid #C9A84C;border-radius:6px;padding:12px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.55;color:#3D2E00;text-align:left;">
    <strong>Important:</strong> ${text}
  </td></tr>
</table>`;
}

module.exports = {
  CLIENT_CONTACT_EMAIL, CLIENT_REPLY_TO, EMAIL_US,
  NOTICE_TEXT, NOTICE_KINDS, replyNoticeText, replyNoticeHtml,
};
