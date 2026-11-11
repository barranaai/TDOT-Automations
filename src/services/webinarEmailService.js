'use strict';

/**
 * The Webinar email (Faran 2026-11-12) — a lead whose Outcome is "Webinar" is invited to the webinar from its lead
 * page, where the "Webinar Email" card takes the place of the booking invite.
 *
 * The body is ONE standard text, pre-filled on the page and editable before sending. It carries no case commentary
 * and no promises (the firm's rule for the booking invite, 2026-07-31) and never says "reply" (the app's mailbox is
 * not read — utils/clientContact). There is NO joining link or date in it yet: the webinar is paid, and the link and
 * time will come from the Microsoft Teams meeting once the client has paid — a later piece of work.
 *
 * Proof of sending is the note on the lead ("Webinar email sent to … on …"). The lead page and the send itself read
 * THAT LEAD'S OWN notes (lastSent — no time limit, nothing kept in memory), so "already sent" survives a restart and
 * never expires. The Leads list shows "Email sent <day>" from the board-wide notes copy (leadStatusService, 45 days)
 * when it knows — and says nothing when it does not: it never claims "not sent" (review 2026-11-12).
 */

const SENT_NOTE = 'Webinar email sent';
/** The app's own "sent" note, and nothing a person would type: "📧 Webinar email sent to <address> on YYYY-MM-DD…" (HTML already stripped). */
const SENT_RE = /^\s*(?:📧\s*)?Webinar email sent to \S+ on (\d{4}-\d{2}-\d{2})\b/;
const FAILED_NOTE = 'Webinar email NOT sent';
const SUBJECT = 'Your invitation to the TDOT Immigration webinar';
const MAX_LEN = 2000;

const STANDARD_TEXT = [
  'Thank you for your interest in TDOT Immigration.',
  'We would like to invite you to our upcoming immigration webinar. In this online session our team explains the main Canadian immigration pathways and how each process works in general, and answers common questions.',
  'The webinar is a paid group session. Once your registration and payment are confirmed, we will email you the date, the time and your personal link to join.',
  'If you would like to attend, or if you have any questions, please email us at info@tdotimm.com and our team will help you with the next steps.',
].join('\n\n');

const io = {
  sendEmail: (m) => require('./microsoftMailService').sendEmail(m),
  note: (leadId, body) => require('./mondayApi').query(
    'mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }', { id: String(leadId), b: body }),
  /** This lead's own notes, newest first: [{ text_body }]. */
  async leadNotes(leadId) {
    const d = await require('./mondayApi').query('query($i:[ID!]){ items(ids:$i){ updates(limit: 100){ created_at text_body } } }', { i: [String(leadId)] });
    return (d && d.items && d.items[0] && d.items[0].updates) || [];
  },
  now: () => new Date(),
};

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The text that goes out: what staff wrote, or the standard text when the box was left empty. */
function bodyText(message) {
  const m = String(message == null ? '' : message).replace(/\r\n/g, '\n').trim();
  return m || STANDARD_TEXT;
}

/** The email. No booking button, no fee line, no link — the greeting, the text, how to reach us. */
function emailHtml({ firstName, text }) {
  const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');
  const C = require('../utils/clientContact');
  const paras = bodyText(text).split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
        <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
          <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">You are invited to our webinar</h1></div>
        <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
          <p>Hi ${esc(firstName || 'there')},</p>
          ${paras}
          <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Questions? Please ${C.EMAIL_US}. ${C.NO_REPLY}</p>
        </div></div>`;
}

/**
 * The day the Webinar email last went to this lead, from the lead's own notes: 'YYYY-MM-DD', '' = never,
 * null = could not be read just now (never treated as "not sent").
 */
async function lastSent(leadId) {
  try {
    let best = '';
    for (const u of await io.leadNotes(leadId)) { const m = SENT_RE.exec(String((u && u.text_body) || '')); if (m && m[1] > best) best = m[1]; }
    return best;
  } catch (err) { console.warn(`[Webinar] could not read the notes of lead ${leadId}: ${err.message}`); return null; }
}

/** Why the Webinar email cannot go to this lead ('' = it can). The page shows the card on the same rule. */
function refusal(lead) {
  const s = (v) => String(v == null ? '' : v).trim();
  if (!lead) return 'Lead not found.';
  if (lead.webinar !== 'Yes') return 'The Webinar email is for leads whose Outcome is “Webinar” — set that outcome first.';
  if (!s(lead.email)) return 'No client email on file — add an email address to the lead before sending the Webinar email.';
  return '';
}

/**
 * Send it. Sends first, notes after (a note must never claim an email that did not go). Throws a plain,
 * staff-readable error when the email could not be sent — and leaves a note saying so.
 * `again`: the person was shown that it had already gone and asked to send it again. Without it, a send is refused
 * when this lead's notes show one already (two people, two tabs, a page opened before the first send).
 * @returns {{ ok: true, to: string, day: string, noted: boolean }}
 */
async function send({ leadId, lead, message, by = '', again = false }) {
  const why = refusal(lead);
  if (why) { const e = new Error(why); e.badRequest = true; throw e; }
  const text = bodyText(message);
  if (text.length > MAX_LEN) { const e = new Error(`The Webinar email is too long (max ${MAX_LEN} characters).`); e.badRequest = true; throw e; }
  if (!again) {
    const prior = await lastSent(leadId);
    if (prior) { const e = new Error(`The Webinar email was already sent to this client on ${prior}. Reload the page — it will ask before sending it again.`); e.badRequest = true; e.alreadySent = prior; throw e; }
  }
  const firstName = String(lead.fullName || '').trim().split(/\s+/)[0] || 'there';   // fullName only: the board's "Unnamed Lead" placeholder is never a greeting
  const who = String(by || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const day = io.now().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  try {
    await io.sendEmail({ to: lead.email, subject: SUBJECT, html: emailHtml({ firstName, text }) });
  } catch (err) {
    // The mail service answered "no" = nothing went. No answer at all (a timeout, a dropped line) = not known:
    // it may have gone, so never tell staff to simply press again.
    const refused = !!(err && err.response);
    console.error(`[Webinar] email ${refused ? 'FAILED' : 'UNCONFIRMED'} for ${leadId}: ${err.message}`);
    const tried = who ? ` (tried by ${esc(who)})` : '';
    await Promise.resolve(io.note(leadId, refused
      ? `⚠️ <b>${FAILED_NOTE}</b> — the email could not be sent${tried}. Please try again from the lead page.`
      : `⚠️ <b>Webinar email: not confirmed</b> — the email system did not answer, so it is not known whether the email went out${tried}. Check with the client before sending it again.`)).catch(() => {});
    const e = new Error(refused
      ? 'The Webinar email could not be sent right now — nothing went to the client. Please try again in a few minutes.'
      : 'The email system did not answer, so it is not known whether the Webinar email went out. Check with the client before sending it again.');
    e.sendFailed = true; throw e;
  }
  const plain = `${SENT_NOTE} to ${lead.email} on ${day}${who ? ` by ${who}` : ''}.`;
  const note = `📧 <b>${SENT_NOTE}</b> to ${esc(lead.email)} on ${day}${who ? ` by ${esc(who)}` : ''}.`;
  let noted = false;
  for (let i = 0; i < 2 && !noted; i++) {
    try { await io.note(leadId, note); noted = true; }
    catch (err) { console.warn(`[Webinar] sent, but the note failed for ${leadId} (try ${i + 1}): ${err.message}`); }
  }
  try { require('./leadStatusService').record(leadId, plain); } catch (_) { /* display only */ }
  console.log(`[Webinar] email sent for lead ${leadId}${noted ? '' : ' (NOT noted on the lead)'}`);
  return { ok: true, to: lead.email, day, noted };
}

module.exports = { send, lastSent, SENT_RE, refusal, emailHtml, bodyText, STANDARD_TEXT, SUBJECT, SENT_NOTE, FAILED_NOTE, MAX_LEN, io };
