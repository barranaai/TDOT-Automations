'use strict';
/**
 * Email → lead (Faran 2026-10-27): every new email that reaches the office
 * inbox (info@tdotimm.com) is stored in the app.
 *
 *   • someone NEW            → a lead on the Lead Board (Source "Email"), the
 *                              email saved on it as a note;
 *   • someone we already know → no new lead — the email is added as a note on
 *                              their open case (else their newest case or lead);
 *   • junk / automatic mail  → skipped (our own staff and addresses, no-reply
 *                              senders, newsletters, auto-replies, read receipts,
 *                              bounces, the app's own services, government and
 *                              payment notices).
 *
 * Faran's choices: that inbox; known people get a note; no AI — simple rules
 * only; on straight away. Only email that arrives AFTER the app can first list
 * the inbox is taken — never the backlog. The app only READS the mailbox: it
 * never moves, marks or deletes anything in Outlook.
 *
 * How: every 5 minutes, Microsoft Graph lists the messages received since the
 * last run (all folders except Junk, Drafts, Sent, Deleted, Outbox); emails a
 * person rescued from Junk into the Inbox are looked for too, and emails still
 * to finish are fetched again by their internet message id. What was done with
 * each email is kept in a small JSON file in the app's OneDrive
 * (TDOT System/email-leads-state.json), written with its eTag:
 *   • an email is known by a key made from its internet message id, sender,
 *     reply-to and subject — the same for a moved email and for two copies of
 *     one email, different for two web-form messages that share a message id;
 *   • "pending" is a short LOCK (LEASE_MS), renewed — and so re-checked against
 *     the record — right before anything is created: a run that meets another
 *     instance's live lock stops, and a run whose lock was taken over stops
 *     before acting; two app instances during a deploy never both create the
 *     lead; a crashed instance's lock expires within one cycle; this instance's
 *     own lock from an earlier run (a lost save) is taken back at once — what it
 *     already did is remembered in memory, and every note is checked first;
 *   • an email that could not be stored (a Monday blip) is retried next run, in
 *     order (the watermark waits); after MAX_TRIES it is SET ASIDE (with every
 *     later email from the same sender) — the watermark moves on and it is
 *     retried on its own every run; given up only after a day, and then shown
 *     on the status page;
 *   • every note carries "Email ref <key>", the item's notes are read before
 *     posting, notes and the lead are created WITHOUT Monday's automatic
 *     re-send — the same email is never noted twice, nor a lead made twice;
 *   • a failed Monday search never reads as "a new person" — it stops the run.
 *
 * Review rules (2026-10-27, two rounds) not to undo: the key above, never the
 * Graph id, never the email's text (it can change in place); the run cap
 * counts only emails still to do; forwards are never trimmed and only quotes
 * of OUR emails are; "Submitted" is an open case; a Reply-To is taken as the
 * person ONLY from a configured form sender (EMAIL_LEADS_FORM_SENDERS) — a
 * generic "no-reply + Reply-To" rule let phishing and help desks through;
 * never our own reply-to / sending address; message ids in their default form
 * (parentFolderId must match the folder ids — no ImmutableId); the Junk-rescue
 * look reads oldest-change first and always moves its cursor forward.
 *
 * SETUP: the app needs Microsoft Graph permission to READ that mailbox — see
 * docs/email-leads-setup.md. Until then every run stops at the access check
 * (logged once an hour) and the status page says what is missing.
 * Switches: EMAIL_LEADS=off (switched back on, it catches up on what came in
 * meanwhile); EMAIL_LEADS_MAILBOX (default info@tdotimm.com);
 * EMAIL_LEADS_SKIP_DOMAINS / EMAIL_LEADS_SKIP_ADDRESSES (more to skip);
 * EMAIL_LEADS_FORM_SENDERS (our website form's sending address — its Reply-To is the visitor).
 */

const axios     = require('axios');
const crypto    = require('crypto');
const mondayApi = require('./mondayApi');

const GRAPH            = 'https://graph.microsoft.com/v1.0';
const STATE_PATH       = 'TDOT System/email-leads-state.json';
const OVERLAP_MS       = 2 * 60 * 1000;          // re-list the last 2 minutes — the record makes it harmless
const PAGE_SIZE        = 25;
const MAX_PER_RUN      = 100;                    // emails STILL TO DO per run; the rest wait (in order)
const MAX_PAGES        = 40;
const MAX_RETRY_FETCH  = 20;                     // parked / rescued emails fetched again per run
const LEASE_MS         = 5 * 60 * 1000;          // a pending email's lock — renewed right before anything is created
const MAX_TRIES        = 5;                      // then it is parked (the others move on)
const GIVE_UP_AFTER_MS = 24 * 3600 * 1000;       // …and given up only after a day — an outage never drops an email
const MAX_OPEN_CASES   = 3;                      // notes on at most this many open cases of one person
const KEEP_SEEN_MS     = 7 * 24 * 3600 * 1000;
const KEEP_RECENT_MS   = 30 * 60 * 1000;         // senders we just made a lead for (Monday's search can lag)
const KEEP_LOG         = 50;
const NOTE_LOOKBACK    = 100;                    // a retry reads this many of the item's latest notes
const FOLDER_TTL_MS    = 6 * 3600 * 1000;
const GRAPH_TIMEOUT_MS = 20000;
const BODY_NOTE_MAX    = 4000;
const SITUATION_MAX    = 1900;                   // a long-text column holds 2,000 characters
/** Case stages where the work is over — "Submitted" is NOT one (the client still waits on IRCC). */
const FINISHED_STAGES  = new Set(['Approved', 'Refused', 'Closed', 'Withdrawn', 'Cancelled', 'Archived']);
/** This app instance — tells "my own earlier run" from "another instance at work". */
const INSTANCE = crypto.randomUUID();
/** What THIS instance created, kept in memory: a lost save never makes a second lead
 *  (made: email key → lead id; recent: sender → the lead made for them). */
const _memo = { made: new Map(), recent: new Map() };

const mailbox = () => String(process.env.EMAIL_LEADS_MAILBOX || 'info@tdotimm.com').trim().toLowerCase();
const enabled = () => !/^(0|off|false|no|disabled?)$/i.test(String(process.env.EMAIL_LEADS || '').trim());
const envList = (name) => String(process.env[name] || '').split(',').map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

// ─── What is never a lead ─────────────────────────────────────────────────────

/** Senders on these domains (or any sub-domain) are never leads or notes. Personal
 *  mail domains (gmail.com, outlook.com, hotmail.com, yahoo.com…) are NOT here. */
const DEFAULT_SKIP_DOMAINS = [
  'tdotimm.com',                                                         // our own staff and the app's own mailbox
  'squareup.com', 'square.com', 'documenso.com', 'documensomail.com',   // the app's own services
  'monday.com', 'microsoft.com', 'microsoftonline.com', 'sharepointonline.com', 'office.com',
  'proofpoint.com', 'ppe-hosted.com', 'godaddy.com', 'secureserver.net', 'google.com',
  'zoom.us', 'calendly.com', 'render.com', 'onrender.com', 'github.com',
  'linkedin.com', 'facebookmail.com', 'instagram.com', 'indeed.com',   // social / job-site notifications
  // government notices — about clients, not new clients (IRCC, the provinces' nominee programs)
  'gc.ca', 'canada.ca', 'ontario.ca', 'gov.bc.ca', 'alberta.ca', 'gov.ab.ca', 'saskatchewan.ca', 'gov.sk.ca',
  'gov.mb.ca', 'manitoba.ca', 'novascotia.ca', 'gnb.ca', 'gov.nl.ca', 'princeedwardisland.ca', 'gov.pe.ca',
  'yukon.ca', 'gov.yk.ca', 'gov.nt.ca', 'gov.nu.ca', 'quebec.ca', 'gouv.qc.ca',
  'wes.org', 'vfsglobal.com',                                            // credential assessment, visa centres
  'interac.ca', 'paypal.com', 'stripe.com',                              // payment notices
];

function skipDomains() {
  const own = mailbox().split('@')[1] || '';
  return [...new Set([...DEFAULT_SKIP_DOMAINS, ...(own ? [own] : []), ...envList('EMAIL_LEADS_SKIP_DOMAINS')])];
}

/** Our own addresses outside our domain: the e-transfer inbox, the app's reply-to and sending addresses, any listed. */
function skipAddresses() {
  const list = [process.env.ETRANSFER_EMAIL || 'admstdot@gmail.com', process.env.EMAIL_REPLY_TO, process.env.MS_FROM_EMAIL, ...envList('EMAIL_LEADS_SKIP_ADDRESSES')];
  return new Set(list.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
}

/** no-reply / do-not-reply with anything after; the mail-system names exactly (a digit or +tag allowed). */
const AUTOMATED_LOCAL = /^(?:(?:no[-_.]?reply|do[-_.]?not[-_.]?reply).*|(?:mailer[-_.]?daemon|postmaster|bounces?|notifications?|newsletters?|automated|auto[-_.]?confirm)(?:\d+|\+.*)?)$/i;
/** Auto-replies and delivery notices only — meeting responses are caught by their message type. */
const AUTOMATED_SUBJECT = /^\s*(automatic reply\s*:|auto[- ]?reply\s*:|autoreply\s*:|out of (the )?office\s*:|undeliverable\s*:|undelivered mail|delivery status notification|delivery has failed|mail delivery (failed|subsystem)|returned mail\s*:)/i;
const READ_RECEIPT_SUBJECT = /^\s*(read|not read)\s*:/i;
const READ_RECEIPT_BODY = /\bwas read on\b|was deleted without being read|has been (read|displayed)\b/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const addrOf = (a) => {
  const e = (a && a.emailAddress) || {};
  const raw = String(e.address || '').trim();
  return { email: raw.toLowerCase(), raw, name: String(e.name || '').replace(/\s+/g, ' ').trim() };
};

/** The From address: { email (lower-case), raw (as written), name }. */
function senderOf(msg) { return addrOf(msg && (msg.from || msg.sender)); }

/** Message headers as { lower-case name: value }. */
function headerMap(msg) {
  const out = {};
  for (const h of (msg && msg.internetMessageHeaders) || []) {
    if (h && h.name) out[String(h.name).toLowerCase()] = String(h.value == null ? '' : h.value).trim();
  }
  return out;
}

const domainOf = (email) => String(String(email || '').split('@')[1] || '').toLowerCase();
const onDomain = (email, domains) => { const d = domainOf(email); return domains.some((s) => d === s || d.endsWith('.' + s)); };

/** Why this address is not a person to store ('' = it is one). PURE. */
function addressProblem(a, { box, domains, addresses }) {
  if (!EMAIL_RE.test(a.email)) return 'no sender address';
  if (a.email === box) return 'sent by the inbox itself';
  if (addresses.has(a.email)) return 'one of our own addresses';
  if (onDomain(a.email, domains)) return `sender's domain is on the skip list (${domainOf(a.email)})`;
  if (AUTOMATED_LOCAL.test(a.email.split('@')[0])) return 'an automatic sender (no-reply, notifications, newsletter…)';
  return '';
}

/**
 * The person an email is from, or why it is skipped. A web form's message is
 * the VISITOR's (their address alone in Reply-To) only when it comes from a
 * configured form sender (EMAIL_LEADS_FORM_SENDERS) — any other "no-reply with a
 * Reply-To" is a company's notice, a help desk, or phishing. Our own reply-to /
 * sending addresses are never a person. PURE.
 * @returns {{ person: {email, raw, name}|null, viaReplyTo: boolean, reason: string }}
 */
function classify(msg, { box = mailbox(), domains = skipDomains(), addresses = skipAddresses(), formSenders = envList('EMAIL_LEADS_FORM_SENDERS'), excludedFolders = new Set() } = {}) {
  const skip = (reason) => ({ person: null, viaReplyTo: false, reason });
  if (!msg) return skip('empty message');
  if (msg.isDraft) return skip('a draft');
  if (/eventMessage/i.test(String(msg['@odata.type'] || ''))) return skip('a meeting invitation or reply');
  if (msg.parentFolderId && excludedFolders.has(msg.parentFolderId)) return skip('in Junk, Drafts, Sent, Deleted or Outbox');
  const h = headerMap(msg);
  if (h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'])) return skip('an automatic email');
  if (/^(bulk|junk|list|auto_reply)$/i.test(h['precedence'] || '')) return skip('a bulk or list email');
  if (h['list-unsubscribe'] || h['list-id']) return skip('a mailing list or newsletter');
  if (h['x-autoreply'] || h['x-autorespond']) return skip('an automatic reply');
  if (AUTOMATED_SUBJECT.test(String(msg.subject || ''))) return skip('an automatic reply or delivery notice');
  if (/disposition-notification/i.test(h['content-type'] || '')
      || (READ_RECEIPT_SUBJECT.test(String(msg.subject || '')) && READ_RECEIPT_BODY.test(String((msg.body && msg.body.content) || '')))) return skip('a read receipt');
  const ctx = { box, domains, addresses };
  const from = senderOf(msg);
  const problem = addressProblem(from, ctx);
  if (!problem) return { person: from, viaReplyTo: false, reason: '' };
  const replyTo = (msg.replyTo || []).map(addrOf).filter((a) => a.email);
  if (formSenders.includes(from.email) && replyTo.length === 1 && !addressProblem(replyTo[0], ctx)) return { person: replyTo[0], viaReplyTo: true, reason: '' };
  return skip(problem);
}

/** Why this message is NOT a lead or a note — '' when it should be taken. PURE. */
function skipReason(msg, opts) { return classify(msg, opts).reason; }

// ─── What gets written ────────────────────────────────────────────────────────

/**
 * The email's key, printed on its notes as "Email ref": its internet message id,
 * sender, reply-to and subject — the same for a moved email and for two copies
 * of one email; different for two web-form messages that reuse one message id
 * (the visitor's Reply-To differs). Never the text: it can change in place. PURE.
 */
function messageRef(msg) {
  const parts = [
    (msg && (msg.internetMessageId || msg.id)) || '',
    senderOf(msg).email,
    ((msg && msg.replyTo) || []).map((a) => addrOf(a).email).join(','),
    String((msg && msg.subject) || ''),
  ];
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 12);
}

/** The lead's name: the person's display name, else their address. */
function leadNameFor(person) {
  const n = String(person.name || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  return (n && !n.includes('@') ? n : person.raw || person.email).slice(0, 120);
}

const isForward = (msg, text) => /^\s*(fw|fwd)\s*:/i.test(String((msg && msg.subject) || ''))
  || /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/im.test(text) || /^\s*begin forwarded message:/im.test(text);

/**
 * Where a reply's quote of OUR earlier email starts: "On … <…tdotimm.com> wrote:",
 * "-----Original Message-----", or Outlook's "From: … / Sent: …" block — only
 * when the next few lines name tdotimm (so a client's own letter with a
 * "From: / Date:" heading is never cut). -1 when there is none. PURE.
 */
function quoteStart(lines) {
  const ON = /^on\b.{0,200}/i, WROTE = /wrote:\s*$/i;
  const ORIGINAL = /^-{2,}\s*original message\s*-{2,}$/i;
  const FROM = /^from:\s.+/i, SENT = /^(sent|date):\s.+/i, RULE = /^_{8,}$/;
  const ours = (i) => /tdotimm/i.test(lines.slice(i, i + 6).join(' '));
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim(), next = String(lines[i + 1] || '').trim();
    const isQuote = (ON.test(l) && (WROTE.test(l) || WROTE.test(next))) || ORIGINAL.test(l)
      || (FROM.test(l) && SENT.test(next)) || (RULE.test(l) && FROM.test(next));
    if (isQuote && ours(i)) return i;
  }
  return -1;
}

/** The email's text — a reply without its quote of our earlier email; a forward whole. PURE. */
function bodyText(msg) {
  const text = String((msg && msg.body && msg.body.content) || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n');
  const lines = text.split('\n');
  const at = isForward(msg, text) ? -1 : quoteStart(lines);
  return (at > 0 ? lines.slice(0, at) : lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const cut = (s, n, tail) => (s.length > n ? s.slice(0, n).trimEnd() + tail : s);
const torontoTime = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true }) + ' (Toronto)' : '';
};

/** What the lead's "Situation" column holds: the subject and the start of the message. PURE. */
function situationText(msg, box = mailbox()) {
  const subject = String((msg && msg.subject) || '').trim() || '(no subject)';
  return cut(`Email to ${box} — ${subject}\n\n${bodyText(msg)}`, SITUATION_MAX - 1, '…').trim();
}

/** The note on the lead / case: who, when, the subject and the message (as text — Monday renders HTML). PURE. */
function noteHtml(msg, { isNewLead = false, box = mailbox(), person = null, viaReplyTo = false } = {}) {
  const p = person || senderOf(msg);
  const when = torontoTime(msg.receivedDateTime);
  const subject = String(msg.subject || '').trim() || '(no subject)';
  const body = bodyText(msg);
  const link = /^https:\/\//i.test(String(msg.webLink || '')) ? String(msg.webLink) : '';
  return [
    isNewLead
      ? `📧 <b>New lead from an email</b> to ${esc(box)}${when ? ` — ${esc(when)}` : ''}`
      : `📧 <b>Email received</b> at ${esc(box)}${when ? ` — ${esc(when)}` : ''}`,
    `From: ${esc(p.name || p.raw)}${p.name ? ` &lt;${esc(p.raw)}&gt;` : ''}${viaReplyTo ? ` (sent through ${esc(senderOf(msg).raw)} — a web form)` : ''}`,
    `Subject: ${esc(subject)}`,
    '',
    body ? esc(cut(body, BODY_NOTE_MAX, '\n… (the rest is in the email)')).replace(/\n/g, '<br>') : '<i>(the email has no text)</i>',
    ...(msg.hasAttachments ? ['', '📎 This email has attachments — open it in Outlook to see them.'] : []),
    ...(link ? ['', `<a href="${esc(link)}">Open this email in Outlook</a> (for staff with access to ${esc(box)})`] : []),
    ...(isNewLead ? ['', 'Before sending a booking invite, set "In Canada now?" on the lead page — it decides the HST on the consultation fee.'] : []),
    '',
    `<span style="color:#9AA3AF">Email ref ${messageRef(msg)}</span>`,
  ].join('<br>');
}

/**
 * Where a known person's email goes. PURE.
 *   • their OPEN cases (at most MAX_OPEN_CASES, newest first) — "Submitted" is open;
 *   • no open case → the newest of their cases and leads (Monday item ids grow over time);
 *   • nothing → a new lead.
 */
function pickTargets({ cases = [], leads = [] } = {}, finished = FINISHED_STAGES) {
  const byNewest = (a, b) => Number(b.id) - Number(a.id);
  const open = cases.filter((c) => c && c.id && !finished.has(String(c.caseStage || '').trim())).sort(byNewest);
  if (open.length) return { kind: 'case', ids: open.slice(0, MAX_OPEN_CASES).map((c) => String(c.id)) };
  const all = [...cases.filter((c) => c && c.id).map((c) => ({ id: String(c.id), kind: 'case' })),
               ...leads.filter((l) => l && l.id).map((l) => ({ id: String(l.id), kind: 'lead' }))].sort(byNewest);
  return all.length ? { kind: all[0].kind, ids: [all[0].id] } : { kind: 'none', ids: [] };
}

// ─── I/O (stubbed in tests) ───────────────────────────────────────────────────

const io = {
  now: () => Date.now(),
  runId: () => crypto.randomUUID(),
  token: () => require('./microsoftMailService').getAccessToken(),
  dropToken: () => require('./microsoftMailService').invalidateAccessToken(),
  get: (url, headers) => axios.get(url, { headers, timeout: GRAPH_TIMEOUT_MS }),
  readState: () => require('./oneDriveService').readJsonFile(STATE_PATH),
  writeState: (data, etag) => require('./oneDriveService').writeJsonFile(STATE_PATH, data, { etag }),
  // Monday look-ups that THROW on failure — a failed search must never read as "a new person"
  leadsByEmail: (email) => require('./leadService').findAllByColumnValue('email', email),
  casesByEmail: (email) => require('./clientMasterService').findCasesByEmail(email),
  // no automatic re-send: a timed-out create that did land must not make a second lead
  // (the retry, after the lock, finds it by the search above)
  createLead: (fields) => require('./leadService').createLead(fields, { createRetries: 0 }),
  markLead: (leadId, fields) => require('./leadService').updateLead(leadId, fields),
  // no automatic re-send either: the next run reads the item's notes for its "Email ref" first
  postNote: (itemId, body) => mondayApi.query('mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }', { id: String(itemId), b: body }, 0),
  noteBodies: async (itemId) => {
    const d = await mondayApi.query(`query($id: [ID!]) { items(ids: $id) { updates(limit: ${NOTE_LOOKBACK}) { text_body } } }`, { id: [String(itemId)] });
    return ((d && d.items && d.items[0] && d.items[0].updates) || []).map((u) => String(u.text_body || ''));
  },
  blacklistCheck: (email) => require('./blacklistService').check({ email }),
  blacklistNote: (leadId, result) => require('./blacklistService').noteOnLead(leadId, result, 'This lead came in by email.'),
  leadsChanged: () => require('./consultantPortalService').invalidateLeadsQueue(),
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
};

// ─── Microsoft Graph ──────────────────────────────────────────────────────────

const PREFER = { Prefer: 'outlook.body-content-type="text"' };
const SELECT_BASIC = 'id,internetMessageId,receivedDateTime,subject,from,sender,replyTo,body,hasAttachments,webLink,parentFolderId,isDraft';
const SELECT = SELECT_BASIC + ',internetMessageHeaders';
const odataStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

function listUrl(box, sinceIso, { top = PAGE_SIZE, select = SELECT } = {}) {
  return `${GRAPH}/users/${encodeURIComponent(box)}/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent('receivedDateTime asc')}&$top=${top}&$select=${select}`;
}
/** Inbox emails changed since the last look that arrived BEFORE the watermark — only those can be a rescue from Junk. */
function rescueUrl(box, changedSinceIso, receivedUpToIso, { select = SELECT, skip = 0 } = {}) {
  return `${GRAPH}/users/${encodeURIComponent(box)}/mailFolders/inbox/messages` +
    `?$filter=${encodeURIComponent(`lastModifiedDateTime ge ${changedSinceIso} and receivedDateTime le ${receivedUpToIso}`)}` +
    `&$orderby=${encodeURIComponent('lastModifiedDateTime asc')}&$top=${PAGE_SIZE}${skip > 0 ? `&$skip=${skip}` : ''}&$select=${select},lastModifiedDateTime`;
}
/** One email wherever it is now (moved or not), by its internet message id. */
function byMessageIdUrl(box, internetMessageId, { select = SELECT } = {}) {
  return `${GRAPH}/users/${encodeURIComponent(box)}/messages` +
    `?$filter=${encodeURIComponent(`internetMessageId eq ${odataStr(internetMessageId)}`)}&$top=5&$select=${select}`;
}

/** A Graph GET with one retry after a 401 (a revoked / drifted token). */
async function graphGet(url, extraHeaders = {}) {
  const call = async () => io.get(url, { Authorization: `Bearer ${await io.token()}`, ...extraHeaders });
  try { return (await call()).data; }
  catch (err) {
    if (!(err && err.response && err.response.status === 401)) throw err;
    io.dropToken();
    return (await call()).data;
  }
}

function graphError(err) {
  const status = err && err.response && err.response.status;
  const e = err && err.response && err.response.data && err.response.data.error;
  return { status: status || 0, message: e ? `${status} ${e.code}: ${e.message}` : (err && err.message) || String(err) };
}

/** What a failed mailbox call means, in plain words for the status page. */
function accessHint(status, box = mailbox()) {
  if (status === 401 || status === 403) return `The app is not allowed to read ${box} yet. A Microsoft 365 admin needs to give it the "Mail.Read" permission for that mailbox — see docs/email-leads-setup.md. (After the permission is given it can take up to an hour to work.)`;
  if (status === 404) return `Microsoft says there is no mailbox ${box}. Check the address (EMAIL_LEADS_MAILBOX).`;
  return '';
}

let _folders = { at: 0, box: '', ids: new Set(), junk: '' };
async function excludedFolderIds(box) {
  if (_folders.box === box && io.now() - _folders.at < FOLDER_TTL_MS) return _folders.ids;
  const names = ['junkemail', 'drafts', 'sentitems', 'deleteditems', 'outbox'];
  const got = await Promise.all(names.map((n) => graphGet(`${GRAPH}/users/${encodeURIComponent(box)}/mailFolders/${n}?$select=id`)));
  _folders = { at: io.now(), box, ids: new Set(got.map((f) => f && f.id).filter(Boolean)), junk: (got[0] && got[0].id) || '' };
  return _folders.ids;
}

const isoSecond = (ms) => new Date(Math.max(0, ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * GET a list page; if Graph refuses the HEADERS in a list query (a 400 that
 * names them), once more without them — for this call only (tried again next
 * time). The no-reply / subject / domain rules still apply without headers.
 */
async function listPage(urlFor) {
  try { return { page: await graphGet(urlFor(SELECT), PREFER), headers: true }; }
  catch (err) {
    const g = graphError(err);
    if (g.status !== 400 || !/internetMessageHeaders/i.test(g.message)) throw err;
    warnQuiet(`[EmailLeads] Microsoft refused the message headers in a list (${g.message}) — reading without them; the other junk rules still apply`, 'headers');
    return { page: await graphGet(urlFor(SELECT_BASIC), PREFER), headers: false };
  }
}

/**
 * The Junk-rescue look, page by page WITHOUT the next-page links: each page asks
 * again from the last change time read ("ge T"), skipping only the emails
 * already read within that same second — an email changing while the look runs
 * moves to the end and is read there, and no email is jumped over (a skip
 * paging would shift the rest back by one). Returns where it got to.
 */
async function listRescue(box, startMs, startSkip, receivedUpToIso) {
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000) * 1000;   // the query works in whole seconds
  const items = [];
  let t = Math.floor(startMs / 1000) * 1000, skip = startSkip;
  for (let pages = 1; ; pages++) {
    const { page } = await listPage((select) => rescueUrl(box, isoSecond(t), receivedUpToIso, { select, skip }));
    const vals = (page && page.value) || [];
    items.push(...vals);
    if (vals.length) {
      const last = sec(vals[vals.length - 1].lastModifiedDateTime);
      if (!Number.isFinite(last) || last <= t) skip += vals.length;      // still inside the same second
      else { t = last; skip = vals.filter((m) => sec(m.lastModifiedDateTime) === last).length; }
    }
    if (vals.length < PAGE_SIZE) return { items, complete: true, cursorMs: t, skip };
    if (pages >= MAX_PAGES) return { items, complete: false, cursorMs: t, skip };
  }
}

/** Follow a list's next pages: until `enough(out)` or the page cap. Returns { items, complete }. */
async function pageOn(first, enough = () => false, maxPages = MAX_PAGES) {
  const out = [];
  let page = first, pages = 0;
  for (;;) {
    pages++;
    out.push(...((page && page.value) || []));
    const next = page && page['@odata.nextLink'];
    if (!next) return { items: out, complete: true };
    if (enough(out) || pages >= maxPages) return { items: out, complete: false };
    page = await graphGet(next, PREFER);
  }
}

// ─── The run ──────────────────────────────────────────────────────────────────

let _running = false;
let _status = { at: null, ok: null, outcome: 'not run yet', error: '', hint: '', counts: null };
const _quietUntil = {};   // the same warning at most once an hour, not every 5 minutes
function warnQuiet(text, kind = 'access') {
  if (io.now() < (_quietUntil[kind] || 0)) return;
  io.warn(text); _quietUntil[kind] = io.now() + 3600 * 1000;
}

function freshState(box, nowMs) {
  const t = new Date(nowMs).toISOString();
  return { mailbox: box, since: t, startedAt: t, rescueSince: t, seen: {}, recent: {}, log: [] };
}

function prune(state, nowMs) {
  for (const [k, e] of Object.entries(state.seen || {})) {
    if (e && e.o !== 'pending' && nowMs - Date.parse(e.at || 0) > KEEP_SEEN_MS) delete state.seen[k];
  }
  for (const [k, r] of Object.entries(state.recent || {})) {
    if (!r || nowMs - Date.parse(r.at || 0) > KEEP_RECENT_MS) delete state.recent[k];
  }
  state.log = (state.log || []).slice(0, KEEP_LOG);
}

/** Look the person up on the Lead Board and the Client Master (exact, then lower-case). Throws on a failed search. */
async function knownPerson(person) {
  const forms = [...new Set([person.raw, person.email].filter(Boolean))];
  const leads = new Map();
  for (const f of forms) for (const l of (await io.leadsByEmail(f)) || []) leads.set(String(l.id), l);
  const cases = await io.casesByEmail(person.raw || person.email);
  return { leads: [...leads.values()], cases: cases || [] };
}

/** Post the note unless this email's note is already on the item (a retry, a copy, a crash). */
async function noteOnce(itemId, ref, html) {
  if ((await io.noteBodies(itemId)).some((t) => t.includes(`Email ref ${ref}`))) return false;
  await io.postNote(itemId, html);
  return true;
}

/**
 * Take one email: a new lead, or a note on what we already have. Throws to be
 * retried. `entry` is the email's pending record — the new lead's id is kept on
 * it at once, so a retry (however late) finishes it as a NEW lead.
 */
async function take(msg, state, entry, { person, viaReplyTo, box, renew }) {
  const ref = messageRef(msg);
  const nowIso = new Date(io.now()).toISOString();
  const memoRecent = _memo.recent.get(person.email);
  const recent = state.recent[person.email]
    || (memoRecent && io.now() - Date.parse(memoRecent.at) <= KEEP_RECENT_MS ? memoRecent : null);
  const madeLead = entry.leadId || _memo.made.get(ref) || (recent && recent.createdBy === ref ? recent.ids[0] : '');

  // This email already created its lead (its note failed, or its record was lost): finish it as a NEW lead.
  if (madeLead) {
    await renew();
    entry.leadId = String(madeLead);
    await noteOnce(madeLead, ref, noteHtml(msg, { isNewLead: true, box, person, viaReplyTo }));
    return { kind: 'lead', ids: [String(madeLead)] };
  }

  const target = recent ? { kind: recent.kind, ids: recent.ids } : pickTargets(await knownPerson(person));
  // The look-ups can be slow: renew the lock — and so check nobody took this
  // email over meanwhile — right before anything is created.
  await renew();

  if (target.kind === 'none') {
    const blacklist = await Promise.resolve().then(() => io.blacklistCheck(person.raw)).catch(() => ({ hit: false }));
    const lead = await io.createLead({ fullName: leadNameFor(person), email: person.raw, sourceChannel: 'Email', situationDescription: situationText(msg, box) });
    const leadId = String((lead && lead.id) || '');
    if (!leadId) throw new Error('the lead was not created (no id came back)');
    // Remembered at once — on this email (a retry finishes it as new) and on the
    // person (a second email before Monday's search shows the lead becomes a note on it).
    entry.leadId = leadId;
    _memo.made.set(ref, leadId);
    state.recent[person.email] = { kind: 'lead', ids: [leadId], at: nowIso, createdBy: ref };
    _memo.recent.set(person.email, state.recent[person.email]);
    try { io.leadsChanged(); } catch (_) { /* the page refreshes on its own soon */ }
    // the lead exists: its id goes into the record now, and the lock is renewed for the slower steps after
    await renew();
    await Promise.resolve().then(() => io.markLead(leadId, { originalChannel: 'Email' }))
      .catch((err) => io.warn(`[EmailLeads] lead ${leadId}: "Original channel" not written (${err.message})`));
    if (blacklist && blacklist.hit) await Promise.resolve().then(() => io.blacklistNote(leadId, blacklist)).catch(() => {});
    await noteOnce(leadId, ref, noteHtml(msg, { isNewLead: true, box, person, viaReplyTo }));
    return { kind: 'lead', ids: [leadId] };
  }

  for (const id of target.ids) {
    try { await noteOnce(id, ref, noteHtml(msg, { isNewLead: false, box, person, viaReplyTo })); }
    catch (err) {
      // the lead we just made may have been deleted (or become a case) — look again next time
      if (recent) { delete state.recent[person.email]; _memo.recent.delete(person.email); }
      throw err;
    }
  }
  return { kind: target.kind === 'case' ? 'case-note' : 'lead-note', ids: target.ids };
}

async function run() {
  const box = mailbox();
  const runId = io.runId();
  const counts = { lead: 0, 'lead-note': 0, 'case-note': 0, skipped: 0, failed: 0, pending: 0, parked: 0, rescued: 0 };
  const noAccess = (err) => {
    const g = graphError(err);
    const hint = accessHint(g.status, box);
    warnQuiet(`[EmailLeads] cannot read ${box}: ${g.message}${hint ? ' — ' + hint : ''}`);
    return { ok: false, outcome: hint ? 'no access' : 'mailbox unreachable', error: g.message, hint, counts };
  };

  // 1. Can the app reach the mailbox?
  let excluded;
  try { excluded = await excludedFolderIds(box); }
  catch (err) { return noAccess(err); }

  // 2. The record of what was done. A first record is written only after a
  //    LIST worked — "from now on" starts when the app can really read mail.
  let rec = await io.readState();
  if (!rec || !rec.data || rec.data.mailbox !== box) {
    try { await listPage((select) => listUrl(box, isoSecond(io.now() - 60 * 1000), { top: 1, select })); }
    catch (err) { return noAccess(err); }
    const data = freshState(box, io.now());
    try { await io.writeState(data, rec ? rec.etag : ''); }
    catch (err) { if (err && err.conflict) return { ok: true, outcome: 'another run started at the same time', counts }; throw err; }
    io.log(`[EmailLeads] started reading ${box} — emails received from now on become leads / notes`);
    return { ok: true, outcome: `started — reading ${box} from now on`, counts };
  }
  const state = rec.data;
  state.seen = state.seen || {}; state.recent = state.recent || {}; state.log = state.log || [];
  state.rescueSince = state.rescueSince || state.since;
  const startedAtMs = Date.parse(state.startedAt || state.since);
  let etag = rec.etag;
  const save = async () => { prune(state, io.now()); etag = (await io.writeState(state, etag)).etag; };
  /** Done for the main listing: handled, or pending in its own retry lane (parked / rescued). */
  const isDone = (m) => { const e = state.seen[messageRef(m)]; return !!e && (e.o !== 'pending' || !!e.parked || !!e.rescue); };
  const nowIso = () => new Date(io.now()).toISOString();
  const logEntry = (msg, outcome, extra = {}) => {
    const s = senderOf(msg);
    state.log.unshift({ at: nowIso(), received: msg.receivedDateTime, from: s.raw, name: s.name, subject: String(msg.subject || '').slice(0, 140), outcome, ...extra });
  };
  let dirty = false, stopped = '', conflict = false;
  const ANOTHER = 'another app instance is working on the inbox (or stopped mid-way) — looked at again within 5 minutes';
  const stopFor = (err) => { if (err && err.conflict) { conflict = true; return ANOTHER; } return `could not save the record: ${err.message}`; };
  const failedPersons = new Set();   // a sender whose email failed in this run: their later set-aside emails wait

  /**
   * One email, start to finish. mode: 'main' (the new-mail listing, in order),
   * 'rescue' (moved out of Junk by a person), 'retry' (a parked / rescued email
   * fetched again). Returns false when the run must stop.
   */
  const processOne = async (msg, { mode = 'main', advance = () => {} } = {}) => {
    const key = messageRef(msg);
    const before = state.seen[key];
    if (mode === 'main') {
      if (before && (before.o !== 'pending' || before.parked || before.rescue)) { advance(); return true; }
      if (Date.parse(msg.receivedDateTime) < startedAtMs) { advance(); return true; }   // from before the start: never taken
    } else if (mode === 'rescue') {
      if (!(before && before.o === 'skipped' && before.folder)) return true;
    } else if (!(before && before.o === 'pending')) return true;

    // Another instance's live lock: hands off. This instance's own lock comes from an
    // earlier run (runs never overlap here) that lost its save — taken back at once.
    if (before && before.o === 'pending' && Number(before.leaseUntil || 0) > io.now() && before.inst !== INSTANCE) {
      if (mode === 'retry') return true;
      conflict = true; stopped = ANOTHER;
      return false;
    }
    const c = classify(msg, { box, excludedFolders: excluded });
    if (c.reason) {
      if (mode === 'main' || mode === 'retry') {
        const folder = /^in Junk/.test(c.reason);
        state.seen[key] = { o: 'skipped', at: nowIso(), ...(folder ? { folder: true } : {}) };
        logEntry(msg, 'skipped', { reason: c.reason }); counts.skipped++; dirty = true;
      }
      advance(); return true;
    }
    const tries = ((before && before.o === 'pending' && before.tries) || 0) + 1;
    const first = (before && before.o === 'pending' && before.first) || nowIso();
    if (before && before.o === 'pending' && tries > MAX_TRIES && io.now() - Date.parse(first) >= GIVE_UP_AFTER_MS) {
      state.seen[key] = { o: 'failed', at: nowIso() };
      logEntry(msg, 'failed', { reason: `gave up after ${tries - 1} tries over a day${before.err ? `: ${before.err}` : ''}` });
      counts.failed++; dirty = true; advance();
      io.warn(`[EmailLeads] gave up on an email from ${senderOf(msg).raw} (${msg.receivedDateTime}) — ${before.err || 'it could not be stored'}`);
      return true;
    }
    // An earlier email from this sender is set aside: this one joins it at once
    // (the queue does not wait 5 tries per email, and their emails stay together).
    if (mode === 'main' && Object.values(state.seen).some((e) => e && e.o === 'pending' && e.parked && e.person === c.person.email)) {
      state.seen[key] = { o: 'pending', at: nowIso(), tries: 0, first: nowIso(), imid: msg.internetMessageId || '', person: c.person.email, parked: true, leaseUntil: 0, err: 'an earlier email from this sender is set aside' };
      logEntry(msg, 'set aside', { reason: 'an earlier email from this sender could not be stored — retried with it' });
      counts.parked++; dirty = true; advance();
      return true;
    }
    const lane = { ...((mode === 'rescue' || (before && before.rescue)) ? { rescue: true } : {}), ...((before && before.parked) ? { parked: true } : {}) };
    // Claim it (a lock for LEASE_MS) before acting: another instance's claim made
    // in between is refused by the eTag, and a run reading after this sees the lock.
    const entry = { o: 'pending', at: nowIso(), run: runId, inst: INSTANCE, leaseUntil: io.now() + LEASE_MS, tries, first,
      imid: msg.internetMessageId || '', person: c.person.email, ...lane, ...((before && before.leadId) ? { leadId: before.leadId } : {}) };
    state.seen[key] = entry;
    try { await save(); dirty = false; }
    catch (err) { stopped = stopFor(err); return false; }
    const renew = async () => { entry.leaseUntil = io.now() + LEASE_MS; await save(); };

    let result;
    try { result = await take(msg, state, entry, { person: c.person, viaReplyTo: c.viaReplyTo, box, renew }); }
    catch (err) {
      if (err && err.conflict) { stopped = stopFor(err); return false; }   // taken over: act on nothing, write nothing
      failedPersons.add(c.person.email);
      const why = String(err.message || err).slice(0, 200);
      const park = mode === 'main' && tries >= MAX_TRIES;
      state.seen[key] = { ...entry, at: nowIso(), leaseUntil: 0, err: why, ...(park ? { parked: true } : {}) };
      dirty = true;
      if (mode !== 'main' || park) {
        // its own lane: the others move on; it is fetched again every run
        counts[park ? 'parked' : 'pending']++;
        warnQuiet(`[EmailLeads] an email from ${c.person.raw} could not be stored (${why}) — it is set aside and retried every run`, 'parked');
        if (park) logEntry(msg, 'set aside', { reason: `${tries} tries failed (${why}) — retried on its own every run, given up after a day` });
        advance(); return true;
      }
      counts.pending++;
      stopped = `an email from ${c.person.raw} could not be stored yet (${why}) — it is retried next run`;
      io.warn(`[EmailLeads] ${stopped}`);
      return false;   // in order: the watermark never passes an email still to do
    }
    state.seen[key] = { o: result.kind, at: nowIso(), ids: result.ids };
    logEntry(msg, result.kind, { ids: result.ids, ...(mode === 'rescue' || lane.rescue ? { rescued: true } : {}), ...(c.viaReplyTo ? { person: c.person.raw } : {}) });
    counts[result.kind]++; if (mode === 'rescue' || lane.rescue) counts.rescued++;
    advance(); dirty = true;
    try { await save(); dirty = false; }
    catch (err) { stopped = stopFor(err); return false; }
    return true;
  };

  // 3. Emails set aside (parked) or rescued that are still to finish — fetched again
  //    wherever they are now; the longest-waiting first, so none is starved.
  //    Across senders the longest-waiting goes first; one sender's emails always in the order they came.
  const waiting = Object.entries(state.seen)
    .filter(([, e]) => e && e.o === 'pending' && (e.parked || e.rescue) && e.imid && (Number(e.leaseUntil || 0) <= io.now() || e.inst === INSTANCE));
  const bySender = new Map();
  for (const it of waiting) { const p = it[1].person || it[0]; if (!bySender.has(p)) bySender.set(p, []); bySender.get(p).push(it); }
  const groups = [...bySender.values()].map((g) => g.sort(([, a], [, b]) => Date.parse(a.first || a.at || 0) - Date.parse(b.first || b.at || 0)));
  groups.sort((a, b) => Math.min(...a.map(([, e]) => Date.parse(e.at || 0))) - Math.min(...b.map(([, e]) => Date.parse(e.at || 0))));
  const lanes = groups.flat().slice(0, MAX_RETRY_FETCH);
  for (const [key, e] of lanes) {
    if (stopped) break;
    if (e.person && failedPersons.has(e.person)) continue;   // their earlier email just failed: not this run
    let found;
    try { found = ((await listPage((select) => byMessageIdUrl(box, e.imid, { select }))).page || {}).value || []; }
    catch (err) { warnQuiet(`[EmailLeads] could not fetch a set-aside email again: ${graphError(err).message}`, 'refetch'); break; }
    const msg = found.find((m) => messageRef(m) === key);
    if (!msg) {
      if (io.now() - Date.parse(e.first || e.at) >= GIVE_UP_AFTER_MS) {
        state.seen[key] = { o: 'failed', at: nowIso() };
        state.log.unshift({ at: nowIso(), outcome: 'failed', reason: 'the email is no longer in the mailbox' }); counts.failed++; dirty = true;
      }
      continue;
    }
    await processOne(msg, { mode: 'retry' });
  }

  // 4. New email, oldest first.
  let messages = [];
  if (!stopped) {
    const sinceIso = isoSecond(Date.parse(state.since) - OVERLAP_MS);
    const { page } = await listPage((select) => listUrl(box, sinceIso, { select }));
    messages = (await pageOn(page, (items) => items.filter((m) => !isDone(m)).length >= MAX_PER_RUN)).items;
    let todo = 0;
    for (const msg of messages) {
      if (!isDone(msg) && ++todo > MAX_PER_RUN) break;
      const advance = () => { const t = Date.parse(msg.receivedDateTime); if (Number.isFinite(t) && t > Date.parse(state.since)) state.since = new Date(t).toISOString(); };
      if (!(await processOne(msg, { advance }))) break;
    }
  }

  // 5. Emails a person rescued from Junk into the Inbox (skipped only for their
  //    folder) — even when step 4 stopped on a Monday failure; never after a
  //    record conflict (another instance's record is the newer one).
  if (!conflict) {
    const lookedAt = io.now();
    // oldest change first; a look cut short continues next run from exactly where it stopped
    const startMs = state.rescueCursor ? Date.parse(state.rescueCursor) : Date.parse(state.rescueSince) - OVERLAP_MS;
    try {
      const { items, complete, cursorMs, skip } = await listRescue(box, startMs, state.rescueCursor ? Number(state.rescueSkip || 0) : 0, isoSecond(Date.parse(state.since)));
      let broke = false;
      for (const msg of items) {
        const e = state.seen[messageRef(msg)];
        if (!(e && e.o === 'skipped' && e.folder)) continue;
        if (!(await processOne(msg, { mode: 'rescue' }))) { broke = true; break; }
      }
      if (!broke && !conflict) {
        if (complete) { state.rescueSince = new Date(lookedAt).toISOString(); delete state.rescueCursor; delete state.rescueSkip; }
        else { state.rescueCursor = new Date(cursorMs).toISOString(); state.rescueSkip = skip; }   // the time + the place within that second
        dirty = true;
      }
    } catch (err) {
      warnQuiet(`[EmailLeads] the Junk-rescue look failed: ${graphError(err).message}`, 'rescue');
    }
  }

  if (dirty && !conflict) {
    try { await save(); }
    catch (err) { if (!stopped) stopped = stopFor(err); }
  }
  const did = counts.lead + counts['lead-note'] + counts['case-note'];
  if (did || counts.failed || counts.parked) io.log(`[EmailLeads] ${box}: ${counts.lead} new lead(s), ${counts['lead-note'] + counts['case-note']} note(s), ${counts.skipped} skipped, ${counts.parked} set aside, ${counts.failed} given up${stopped ? ` — stopped: ${stopped}` : ''}`);
  return { ok: !stopped || conflict, outcome: stopped ? `stopped: ${stopped}` : `${messages.length} email(s) looked at`, counts };
}

/** One pass (the 5-minute job, and the admin "run now"). Never throws. */
async function runOnce({ reason = 'schedule' } = {}) {
  if (!enabled()) return (_status = { at: new Date(io.now()).toISOString(), reason, ok: null, outcome: 'switched off (EMAIL_LEADS=off)', error: '', hint: '', counts: null });
  if (_running) return { ok: true, outcome: 'already running', counts: null };
  _running = true;
  try {
    const r = await run();
    _status = { at: new Date(io.now()).toISOString(), reason, ok: r.ok, outcome: r.outcome, error: r.error || '', hint: r.hint || '', counts: r.counts };
  } catch (err) {
    const g = graphError(err);
    warnQuiet(`[EmailLeads] run failed: ${g.message}`, 'run');
    _status = { at: new Date(io.now()).toISOString(), reason, ok: false, outcome: 'failed', error: g.message, hint: accessHint(g.status), counts: null };
  } finally { _running = false; }
  return _status;
}

/** The admin status: the last run and the most recent emails taken. */
async function getStatus() {
  let record = null, recordError = '';
  try { record = await io.readState(); } catch (err) { recordError = err.message; }
  const d = record && record.data;
  const seen = Object.values((d && d.seen) || {});
  return {
    enabled: enabled(), mailbox: mailbox(), running: _running, lastRun: _status,
    readingSince: d ? d.startedAt : null, watermark: d ? d.since : null,
    pending: seen.filter((e) => e && e.o === 'pending' && !e.parked).length,
    setAside: seen.filter((e) => e && e.o === 'pending' && e.parked).length,
    failed: seen.filter((e) => e && e.o === 'failed').length,
    recent: d ? (d.log || []).slice(0, KEEP_LOG) : [],
    ...(recordError ? { recordError } : {}),
  };
}

/**
 * Admin check: can the app read the mailbox right now — the very list query the
 * run makes — and does an email in Junk really show Junk's folder id (else the
 * Junk / Sent / Deleted rules could not work)? Read-only.
 */
async function checkAccess() {
  const box = mailbox();
  try {
    _folders = { at: 0, box: '', ids: new Set(), junk: '' };
    const excluded = await excludedFolderIds(box);
    const { page, headers } = await listPage((select) => listUrl(box, isoSecond(io.now() - 7 * 24 * 3600 * 1000), { top: 1, select }));
    const sample = ((page && page.value) || [])[0];
    const headersOk = headers && (!sample || Array.isArray(sample.internetMessageHeaders));
    let junk = 'no email in Junk to check';
    const j = ((await graphGet(`${GRAPH}/users/${encodeURIComponent(box)}/mailFolders/junkemail/messages?$top=1&$select=id,parentFolderId`)) || {}).value || [];
    if (j[0]) junk = excluded.has(j[0].parentFolderId) ? 'ok' : 'MISMATCH — Junk emails would not be recognised';
    // the Junk-rescue look's own query (two date conditions)
    let rescue = 'ok';
    try { await listPage((select) => rescueUrl(box, isoSecond(io.now() - 3600 * 1000), isoSecond(io.now()), { select })); }
    catch (err) { rescue = `refused (${graphError(err).message}) — emails moved out of Junk would not be picked up`; }
    const okAll = junk === 'ok' || junk === 'no email in Junk to check';
    return { ok: okAll, mailbox: box, headers: headersOk, junkCheck: junk, rescueCheck: rescue, sample: sample ? 1 : 0,
      message: okAll
        ? `Access OK — the app can read ${box}.${headersOk ? '' : ' (Microsoft did not return the message headers; the other junk rules still apply.)'}${rescue === 'ok' ? '' : ' (The look for emails moved out of Junk was refused — tell the developer.)'}`
        : `The app can read ${box}, but an email in Junk did not show Junk's folder — tell the developer before relying on it.` };
  } catch (err) {
    const g = graphError(err);
    return { ok: false, mailbox: box, status: g.status, error: g.message, hint: accessHint(g.status, box) };
  }
}

module.exports = {
  runOnce, getStatus, checkAccess,
  // pure helpers + seams (tests)
  classify, skipReason, senderOf, headerMap, leadNameFor, bodyText, situationText, noteHtml, messageRef, pickTargets, listUrl, rescueUrl, byMessageIdUrl, accessHint,
  DEFAULT_SKIP_DOMAINS, FINISHED_STAGES, STATE_PATH, MAX_TRIES, MAX_PER_RUN, LEASE_MS, GIVE_UP_AFTER_MS, INSTANCE, io,
  _reset: () => { _running = false; _status = { at: null, ok: null, outcome: 'not run yet', error: '', hint: '', counts: null }; for (const k of Object.keys(_quietUntil)) delete _quietUntil[k]; _folders = { at: 0, box: '', ids: new Set(), junk: '' }; },
};
