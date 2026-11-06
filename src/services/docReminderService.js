'use strict';

/**
 * Document-collection reminders (team meeting 2026-11-05, block 2):
 * the missing-documents list and the reminder email itself.
 *
 * Two halves. The first is pure building — the list and the email, no Monday writes,
 * no sending. The second (step B) is the RECORD and the staff send: the case's notes
 * are the only record of a reminder (the booking-reminders pattern — no column), the
 * three cockpit buttons preview, edit and send through sendStaffReminder, and the
 * automatic daily email (a later step) reuses the same guards. Every outbound call —
 * notes read/post/delete, the email — goes through the `io` seam so tests replace it.
 * The Monday READS of the first half are the case's checklist
 * (documentFormService.getCaseSummary) and, when the templates board is set, the
 * templates (docReminderTemplates, cached).
 *
 * Rules that must not be undone:
 *  - the list is DOCUMENT checklist rows only, never questionnaire items (Faran, L64);
 *  - computed fresh from getCaseSummary(ref).items — never a stored list, never the raw
 *    board label (a never-uploaded row's status is EMPTY on the board; only the code's
 *    'Missing' default makes it listable);
 *  - Not Applicable, optional-not-sent and Rework Required rows are never listed (the
 *    client already got the rework email; the reminder only counts them);
 *  - no token → no email at all (never a bare link); every client link carries ?t=;
 *  - the portal button and the "email us" closing line are added OUTSIDE the template;
 *  - no nested <p>; never "just reply" (src/utils/clientContact.js);
 *  - the claim note is posted BEFORE the email, the failure note after; a hidden
 *    DOCREM:<origin>:<Toronto day> marker is the once-per-day key (auto never follows
 *    a staff send the same day); the marker is matched in BOTH the raw body and
 *    Monday's rendered text (the held-onboarding-resume lesson);
 *  - earliest open claim wins across two app instances; at most 3 failed tries a day;
 *  - a failure is worded neutrally for staff (never "spam", never "credits").
 */

const documentFormService = require('./documentFormService');
const clientPortalService = require('./clientPortalService');
const templates = require('./docReminderTemplates');
const { LOGO_URL } = require('../branding');
const { memberTypeOfLabel } = require('../utils/familyRoleLabels');
const { torontoTime } = require('../utils/torontoTime');

const BASE_URL       = process.env.RENDER_URL    || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

/** DOC_REMINDERS_AUTO — the automatic daily email. OFF unless exactly "1"/"true", read at call time. Ships OFF. */
function isAutoEnabled() {
  const v = String(process.env.DOC_REMINDERS_AUTO || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

// ─── The missing list ────────────────────────────────────────────────────────

// Statuses that mean the client has done their part (or the row does not exist for
// them). 'Under Review' has no board label today; kept so a future label is safe.
const NOT_MISSING = new Set(['Reviewed', 'Received', 'Under Review', 'Rework Required', 'Not Applicable']);
const IN_PIPELINE = new Set(['Reviewed', 'Received', 'Under Review', 'Rework Required']);

// The portal's order (src/routes/documentUploadForm.js MEMBER_ORDER / CATEGORY_ORDER):
// the principal applicant first, then the family in the portal's order; categories as
// the portal shows them. Copied, not required — the route module loads express + multer.
const MEMBER_ORDER   = ['Principal Applicant', 'Spouse / Common-Law Partner', 'Dependent Child', 'Sponsor', 'Worker Spouse'];
const CATEGORY_ORDER = ['Identity', 'Personal', 'Financial', 'Employment', 'Education', 'Travel', 'Legal', 'Medical', 'Supporting', 'General', 'Other'];

function memberRank(label, type) {
  const own = MEMBER_ORDER.indexOf(label);
  if (own >= 0) return own * 2;
  const stands = MEMBER_ORDER.indexOf(memberTypeOfLabel(label));
  if (stands >= 0) return stands * 2 + 1;
  const byType = MEMBER_ORDER.indexOf(type);
  return byType >= 0 ? byType * 2 + 1 : MEMBER_ORDER.length * 2;
}
const categoryRank = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i >= 0 ? i : CATEGORY_ORDER.length; };

/** The first line of the template's client instructions, short enough for an email line. */
function oneLine(s, max = 160) {
  const line = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  const first = line.split(/(?<=[.!?])\s/)[0];
  return first.length > max ? `${first.slice(0, max - 1).trim()}…` : first;
}

/**
 * Pure: the missing required documents among a case's summary items, grouped by
 * family member (as shown to the client) then category, the principal applicant
 * first. Also what a progress line needs: received = rows the client has sent,
 * total = rows that exist for this client (N/A out; an optional row only once sent).
 *
 * @returns {{ groups: Array<{ member: string, categories: Array<{ category: string, items: Array<{ id, name, documentCode, instruction }> }> }>,
 *             count: number, rework: number, progress: { received: number, total: number } }}
 */
function missingFromItems(items) {
  const rows = Array.isArray(items) ? items : [];
  const missing = rows.filter((it) => it && it.status === 'Missing' && !it.optional && !NOT_MISSING.has(it.status));
  let received = 0, total = 0, rework = 0;
  for (const it of rows) {
    if (!it || it.status === 'Not Applicable') continue;
    const sent = IN_PIPELINE.has(it.status);
    if (it.optional && !sent) continue;
    total++;
    if (sent) received++;
    if (it.status === 'Rework Required') rework++;
  }
  const byMember = new Map();
  for (const it of missing) {
    const member = it.applicantLabel || it.applicantType || 'Principal Applicant';
    if (!byMember.has(member)) byMember.set(member, { member, type: it.applicantType || 'Principal Applicant', items: [] });
    byMember.get(member).items.push(it);
  }
  const groups = [...byMember.values()]
    .sort((a, b) => memberRank(a.member, a.type) - memberRank(b.member, b.type) || a.member.localeCompare(b.member))
    .map((g) => {
      const byCat = new Map();
      for (const it of g.items) {
        const cat = it.category || 'General';
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push({ id: it.id, name: it.name, documentCode: it.documentCode || '', instruction: oneLine(it.clientInstructions) });
      }
      const categories = [...byCat.entries()]
        .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
        .map(([category, list]) => ({ category, items: list }));
      return { member: g.member, categories };
    });
  return { groups, count: missing.length, rework, progress: { received, total } };
}

/** The case's missing documents, read fresh (the client-visible member filter and labels applied). */
async function missingDocuments(caseRef) {
  const summary = await documentFormService.getCaseSummary(caseRef);
  return missingFromItems(summary && summary.items);
}

// ─── The email ───────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** '2026-12-16' → '16 Dec 2026' (what the client reads); anything else as given. */
function fmtDay(d) {
  const s = String(d == null ? '' : d).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(d == null ? '' : d).trim();
  return new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** A text's single newlines → <br>; blank lines → separate <p>. The two rich tokens are swapped in AFTER escaping. */
function paragraphsHtml(text, rich) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    let h = esc(p).replace(/\n/g, '<br>');
    for (const [token, html] of Object.entries(rich)) h = h.split(esc(token)).join(html);
    return `<p style="font-size:15px;color:#475569;line-height:1.65;margin:0 0 16px;">${h}</p>`;
  }).join('\n');
}

/** The missing list as the email shows it (member heading only when there is more than one member). */
function missingListHtml(missing) {
  const multi = missing.groups.length > 1;
  const blocks = missing.groups.map((g) => {
    const cats = g.categories.map((c) => `
            <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px;">${esc(c.category)}</div>
            <ul style="margin:0;padding-left:20px;">
${c.items.map((it) => `              <li style="font-size:14px;color:#1e293b;line-height:1.55;margin:0 0 4px;"><strong>${esc(it.name)}</strong>${it.instruction ? ` <span style="color:#64748b;">— ${esc(it.instruction)}</span>` : ''}</li>`).join('\n')}
            </ul>`).join('');
    return `${multi ? `<div style="font-size:14px;font-weight:700;color:#1e293b;margin:14px 0 2px;">${esc(g.member)}</div>` : ''}${cats}`;
  }).join('');
  const rework = missing.rework > 0
    ? `<div style="font-size:13px;color:#64748b;margin:12px 0 0;">…and ${missing.rework} document${missing.rework === 1 ? ' is' : 's are'} waiting for a new copy (see the note on each in your portal).</div>`
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border-radius:10px;border:1px solid #fed7aa;margin:4px 0 20px;">
          <tr><td style="padding:14px 20px 16px;">
            <div style="font-size:13px;font-weight:700;color:#9a3412;">Still missing (${missing.count}):</div>${blocks}${rework}
          </td></tr>
        </table>`;
}

function missingListText(missing) {
  const multi = missing.groups.length > 1;
  const lines = [];
  for (const g of missing.groups) {
    if (multi) lines.push(`${g.member}:`);
    for (const c of g.categories) {
      lines.push(`${multi ? '  ' : ''}${c.category}`);
      for (const it of c.items) lines.push(`${multi ? '  ' : ''}  - ${it.name}${it.instruction ? ` — ${it.instruction}` : ''}`);
    }
  }
  if (missing.rework > 0) lines.push(`...and ${missing.rework} document${missing.rework === 1 ? ' is' : 's are'} waiting for a new copy (see the note on each in your portal).`);
  return lines.join('\n');
}

/** The {Token} values of one email; the two rich tokens are placeholders filled at render. */
function fillTokens(text, values) {
  return String(text || '').replace(/\{([A-Za-z]+)\}/g, (m, t) => (t in values ? values[t] : m));
}

const LEVEL_NAMES = { 1: 'Reminder 1', 2: 'Reminder 2', 3: 'Final reminder', auto: 'Document reminder' };

/**
 * The reminder email, ready to send: { subject, html, text, to (masked), recipient, warnings, template }.
 * Never sends. Throws when it cannot be a safe email (no token, no email, no last day on the
 * final, a body that tells the client to reply).
 *
 * @param {object} o
 * @param {1|2|3|'auto'} o.level
 * @param {string} o.caseRef
 * @param {string} o.clientName        the case's client (the overview fields)
 * @param {string} o.clientEmail
 * @param {string} o.caseType
 * @param {string} o.accessToken       the Case Access Token — required
 * @param {object} o.missing           missingDocuments()'s answer
 * @param {object} [o.deadline]        the stored answer: { type, actualDeadline, promisedSubmissionDate } (deadlineService.fromLead)
 * @param {string} [o.lastDay]         YYYY-MM-DD — the final reminder's last day (required for level 3)
 * @param {string} [o.staffName]       the sender's name (Monday identity); 'TDOT Immigration' when none
 * @param {string} [o.extraLine]       the staff's free-text line, added as its own paragraph
 * @param {string} [o.subjectOverride] the edited subject (staff dialog)
 * @param {string} [o.bodyOverride]    the edited body (staff dialog) — plain text, same tokens
 * @param {{received:number,total:number}} [o.progress]  when known; defaults to missing.progress
 */
async function buildReminderEmail(o = {}) {
  const level = o.level;
  if (!LEVEL_NAMES[level]) throw new Error(`Unknown reminder level: ${level}`);
  const caseRef = String(o.caseRef || '').trim();
  if (!caseRef) throw new Error('A reminder needs the case reference.');
  const accessToken = String(o.accessToken || '').trim();
  if (!accessToken) throw new Error(`Case ${caseRef} has no access code — the reminder cannot be sent (a link without the code would not open).`);
  const clientEmail = String(o.clientEmail || '').trim();
  if (!clientEmail) throw new Error(`Case ${caseRef} has no client email.`);
  const missing = o.missing && Array.isArray(o.missing.groups) ? o.missing : { groups: [], count: 0, rework: 0, progress: null };
  if (level === 3 && !o.lastDay) throw new Error('The final reminder needs the last day you will wait for the documents.');

  const base = await templates.templateFor(level);
  const warnings = [];   // unknown tokens are found once, on the final text (board or edited)
  let subject = base.subject, body = base.body;
  if (o.subjectOverride != null && String(o.subjectOverride).trim()) subject = templates.stripHtml(o.subjectOverride).replace(/\s*\n\s*/g, ' ');
  let listAppended = false;
  if (o.bodyOverride != null && String(o.bodyOverride).trim()) {
    // checked again at send: the dialog's text is the staff's, the rules are not editable
    const v = templates.validate({ subject, body: o.bodyOverride });
    const hard = v.problems.filter((p) => !/\{MissingList\}/.test(p));
    if (hard.length) throw new Error(`The reminder text cannot be sent: ${hard.join('; ')}.`);
    body = v.body;
    if (!body.includes('{MissingList}')) { body += '\n\n{MissingList}'; listAppended = true; warnings.push('the edited text had no {MissingList} — the missing documents were added at the end'); }
    // (v.warnings — unknown tokens — are found again below on the final text, once)
  }

  const dl = o.deadline || {};
  const portalUrl    = clientPortalService.buildPortalUrl({ caseRef, accessToken });
  const encodedRef   = encodeURIComponent(caseRef);
  const documentsUrl = `${BASE_URL}/documents/${encodedRef}?t=${encodeURIComponent(accessToken)}`;   // the page checks the code (2026-10-31)
  const values = {
    ClientName:   String(o.clientName || '').trim() || 'Client',
    CaseRef:      caseRef,
    CaseType:     String(o.caseType || '').trim() || 'immigration',
    MissingCount: String(missing.count),
    Deadline:     dl.actualDeadline ? fmtDay(dl.actualDeadline) : 'not set',
    PromisedDate: dl.promisedSubmissionDate ? fmtDay(dl.promisedSubmissionDate) : 'not set',
    LastDay:      o.lastDay ? fmtDay(o.lastDay) : '',
    StaffName:    String(o.staffName || '').trim() || 'TDOT Immigration',
  };
  const unknown = templates.unknownTokens(`${subject}\n${body}`);
  if (unknown.length) warnings.push(`unknown merge field${unknown.length === 1 ? '' : 's'} left as typed: ${unknown.map((t) => `{${t}}`).join(', ')}`);
  if (!dl.actualDeadline && /\{Deadline\}/.test(body)) warnings.push('the text names the deadline, but this case has no actual deadline — it reads "not set"');

  const subjectOut = fillTokens(subject, { ...values, MissingList: `${missing.count} documents`, PortalLink: '' }).replace(/\s+/g, ' ').trim();
  const bodyFilled = fillTokens(body, { ...values, MissingList: '{MissingList}', PortalLink: '{PortalLink}' });
  const extra = String(o.extraLine || '').replace(/<[^>]*>/g, '').trim();
  const progress = o.progress || missing.progress;
  const progressLine = progress && progress.total > 0 ? `${progress.received} of ${progress.total} documents received` : '';

  // HTML: the template's paragraphs, the list block where {MissingList} sits (its own block,
  // never inside a <p>), the staff's own line right under the list ("we are still looking for…")
  const extraHtml = extra ? `\n        <p style="font-size:15px;color:#1e293b;line-height:1.65;margin:0 0 16px;background:#f8fafc;border-left:3px solid #C9A84C;padding:10px 14px;">${esc(extra).replace(/\n/g, '<br>')}</p>` : '';
  const listHtml = missingListHtml(missing) + extraHtml;
  const portalA  = `<a href="${esc(portalUrl)}" style="color:#8B0000;word-break:break-all;">${esc(portalUrl)}</a>`;
  const bodyHtml = bodyFilled.split('{MissingList}').map((part) => paragraphsHtml(part, { '{PortalLink}': portalA })).join(`\n${listHtml}\n`);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subjectOut)}</title>
</head>
<body style="margin:0;padding:0;background:#FAF8F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Header -->
      <tr><td style="background:#0B1D32;border-radius:12px 12px 0 0;padding:28px 32px 26px;text-align:center;border-bottom:3px solid #C9A84C;">
        <img src="${LOGO_URL}" alt="TDOT Immigration" style="height:42px;object-fit:contain;display:inline-block;margin-bottom:10px;background:#fff;padding:3px 6px;border-radius:6px;">
        <div style="font-size:11px;letter-spacing:.18em;color:#C9A84C;text-transform:uppercase;font-weight:700;">${esc(LEVEL_NAMES[level])}</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#fff;padding:36px 32px;">
${bodyHtml}
${progressLine ? `        <p style="font-size:13px;color:#64748b;margin:0 0 20px;">${esc(progressLine)}</p>\n` : ''}
        <!-- Portal button (added by the app, outside the template) -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;margin:8px 0 24px;">
          <tr><td style="padding:22px;text-align:center;">
            <a href="${esc(portalUrl)}" style="display:inline-block;background:#8B0000;color:#fff;font-size:15px;font-weight:700;padding:13px 28px;border-radius:8px;text-decoration:none;">
              Open your portal →
            </a>
            <div style="font-size:12px;color:#64748b;margin-top:12px;">Upload page: <a href="${esc(documentsUrl)}" style="color:#64748b;word-break:break-all;">${esc(documentsUrl)}</a></div>
          </td></tr>
        </table>

        <p style="font-size:14px;color:#64748b;line-height:1.65;margin:0;">
          Questions? Please ${require('../utils/clientContact').EMAIL_US} and include your case reference <strong>${esc(caseRef)}</strong>. ${require('../utils/clientContact').NO_REPLY}
        </p>

      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
        <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.6;">
          TDOT Immigration Services<br>
          Please do not forward this email — the links are specific to your case.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>

</body>
</html>`;

  const contact = require('../utils/clientContact');
  const text = [
    fillTokens(bodyFilled, { MissingList: missingListText(missing) + (extra ? `\n\n${extra}` : ''), PortalLink: portalUrl }),
    progressLine,
    `Open your portal: ${portalUrl}\nUpload page: ${documentsUrl}`,
    `Questions? Please email us at ${contact.CLIENT_CONTACT_EMAIL} and include your case reference ${caseRef}. ${contact.NO_REPLY}`,
  ].filter(Boolean).join('\n\n');

  return {
    subject: subjectOut,
    html,
    text,
    to: clientPortalService.maskEmail(clientEmail),
    recipient: clientEmail,
    replyTo: EMAIL_REPLY_TO || undefined,
    warnings,
    template: { name: base.name, source: base.source, edited: Boolean(o.bodyOverride || o.subjectOverride), listAppended },
    links: { portalUrl, documentsUrl },
  };
}


// ─── The record: the case's notes ────────────────────────────────────────────

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const NOTE_HEAD      = '📨 <b>Document reminder';          // the stable head of every reminder note (sent, automatic, did not go out)
const NOTE_HEAD_TEXT = '📨 Document reminder';             // the same head as Monday renders it (tags stripped)
const MARKER_RE      = /DOCREM:(btn1|btn2|btn3|auto):(\d{4}-\d{2}-\d{2})/;        // a send's claim (its origin + Toronto day)
const FAIL_RE        = /DOCREM-FAIL:(btn1|btn2|btn3|auto):(\d{4}-\d{2}-\d{2})/;   // the failure that cancels the claim above it
const ORIGIN_OF      = { 1: 'btn1', 2: 'btn2', 3: 'btn3', auto: 'auto' };
const LEVEL_OF       = { btn1: 1, btn2: 2, btn3: 3, auto: 'auto' };
const TONE           = { 1: 'friendly', 2: 'firm', 3: 'final' };
const NOTES_PAGE     = 50;                 // one Monday page of notes (newest first) — the Needs-attention reader's window
const NOTES_MAX_PAGES = 8;                 // never more than 400 notes per case (6,082 updates / 45 days board-wide)
const HISTORY_WINDOW_MS = 90 * DAY;        // older notes do not change the "Sent:" line or any guard
const MAX_TRIES      = 3;                  // failed sends of one reminder on one day before the app stops trying
const FINAL_DEFAULT_DAYS = 7;              // the final reminder's "last day we will wait" default: today + 7
// Other client-facing sends the 24-hour check looks for (their note heads as posted today).
const REWORK_NOTE_RE = /🔄 Document Flagged for Client Rework/;
const INTAKE_NOTE_RE = /Intake email sent\b|Intake email resent\b|Portal access email re-sent|Portal link email re-sent/i;
// The board groups that are not live cases — the same list as needsAttentionService.js (pinned by a test).
const NOT_CASE_GROUPS = [
  { id: 'group_mm3842s',  title: /^test$/i },                   // TEST
  { id: 'group_mm2tz8e1', title: /^leads$/i },                  // Leads
  { id: 'group_mm3b9tap', title: /cancel|did not retain/i },    // Cancel / Did not retained
];

const s = (v) => String(v == null ? '' : v).trim();
const idNum = (x) => Number(x && x.id) || 0;
const stripTags = (v) => String(v == null ? '' : v).replace(/<[^>]*>/g, '');
const marker = (origin, day) => `<span style="display:none">DOCREM:${origin}:${day}</span>`;
const failMarker = (origin, day) => `<span style="display:none">DOCREM-FAIL:${origin}:${day}</span>`;

/** Toronto calendar day (YYYY-MM-DD) of an instant. */
function torontoDay(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
/** A YYYY-MM-DD day plus n days (calendar arithmetic, no zone). */
function dayPlus(day, n) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from Toronto `today` to a YYYY-MM-DD day (negative = past). */
function daysUntil(day, today) { return Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY); }
/** True when a board row sits in a group that is not a live case (TEST, Leads, Cancel). */
function isCaseGroup(group) {
  const g = group || {};
  return !NOT_CASE_GROUPS.some((x) => s(g.id) === x.id || x.title.test(s(g.title)));
}

/** The side effects behind one seam (tests replace them). */
const io = {
  now: () => Date.now(),
  /** One page of the case's notes, newest first; [] when the row has none. Explicit limit on the items read. */
  async readNotes(itemId, page = 1) {
    const d = await require('./mondayApi').query(
      `query($ids:[ID!], $p:Int!){ items(ids:$ids, limit:1){ id updates(limit:${NOTES_PAGE}, page:$p){ id created_at text_body body } } }`,
      { ids: [String(itemId)], p: page });
    const item = d && d.items && d.items[0];
    return rawNotes(item && item.updates);
  },
  async postNote(itemId, body) {
    const d = await require('./mondayApi').query(
      'mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }', { i: String(itemId), b: body });
    const id = d && d.create_update && d.create_update.id;
    if (!id) throw new Error('the note was not saved');
    return s(id);
  },
  deleteNote: (id) => require('./mondayApi').query('mutation($i: ID!){ delete_update(id: $i){ id } }', { i: String(id) }),
  sendEmail: (msg) => require('./microsoftMailService').sendEmail(msg),
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

/** Monday updates → notes [{ id, at, text }]; text = the rendered text AND the raw body (tags stripped) — a marker is found in either. */
function rawNotes(updates) {
  return (Array.isArray(updates) ? updates : []).map((u) => ({
    id: s(u.id), at: Date.parse(s(u.created_at)),
    text: `${s(u.text_body)}\n${stripTags(s(u.body))}`,
  }));
}

// ─── Note builders ───────────────────────────────────────────────────────────

/** "Mahesh Sharma" → safe for a note (one line, tags out). */
const noteEsc = (v) => s(v).replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, 120);

/**
 * The claim note — the record that this reminder is going out (posted BEFORE the email).
 * @param {object} o  { level: 1|2|3|'auto', to (masked), actor (name), count, lastDay?, deadline?, pct?, now }
 */
function claimNote(o) {
  const level = o.level, origin = ORIGIN_OF[level];
  if (!origin) throw new Error(`Unknown reminder level: ${level}`);
  const day = torontoDay(o.now), when = `${torontoTime(o.now)} (Toronto)`;
  const docs = `${Number(o.count) || 0} document${Number(o.count) === 1 ? '' : 's'} missing`;
  if (level === 'auto') {
    const pct = o.pct == null || o.pct === '' ? '' : ` (${Number(o.pct)} % uploaded)`;
    return `${NOTE_HEAD} (automatic)</b> emailed to ${noteEsc(o.to)} — deadline ${noteEsc(o.deadline) || 'not set'}, ${docs}${pct} — ${when}${marker(origin, day)}`;
  }
  const last = level === 3 && o.lastDay ? ` — last day ${fmtDay(o.lastDay)}` : '';
  return `${NOTE_HEAD} ${level} sent</b> (${TONE[level]}) to ${noteEsc(o.to)} by ${noteEsc(o.actor) || 'staff'} — ${docs}${last} — ${when}${marker(origin, day)}`;
}

/** The failure note — after a send that did not go out; cancels the claim above it. */
function failureNote(o) {
  const origin = ORIGIN_OF[o.level];
  if (!origin) throw new Error(`Unknown reminder level: ${o.level}`);
  const day = torontoDay(o.now);
  return `${NOTE_HEAD} did not go out</b> — ${noteEsc(o.reason).slice(0, 200) || 'the email could not be sent'} — ${torontoTime(o.now)} (Toronto)${failMarker(origin, day)}`;
}

// ─── Reading the record ──────────────────────────────────────────────────────

/** One note → what the record needs ({ kind: 'claim'|'fail'|null, origin, level, day, by, to, lastDay, reason }). */
function parseNote(note) {
  const text = s(note && note.text);
  const base = { id: s(note && note.id), at: Number(note && note.at) };
  const m = MARKER_RE.exec(text);
  if (m) {
    const origin = m[1];
    const by = (/\bby (.+?) — \d+ documents? missing/.exec(text) || [])[1] || '';
    const to = (/\b(?:to|emailed to) (\S+@\S+?)(?: by | —)/.exec(text) || [])[1] || '';
    const lastDay = (/— last day (.+?) —/.exec(text) || [])[1] || '';
    return { ...base, kind: 'claim', origin, level: LEVEL_OF[origin], day: m[2], by: s(by), to: s(to), lastDay: s(lastDay) };
  }
  const f = FAIL_RE.exec(text);
  if (f) {
    const reason = (/did not go out(?:<\/b>)? — (.+?) — \d{1,2} \w{3} \d{4}/.exec(text) || [])[1] || '';
    return { ...base, kind: 'fail', origin: f[1], level: LEVEL_OF[f[1]], day: f[2], reason: s(reason) };
  }
  return { ...base, kind: null };
}

/**
 * The reminder record from a case's notes (any order; raw or rendered text).
 * A failure note cancels the newest uncancelled claim of the same origin + day
 * above it — so a claim followed by "did not go out" is a try, never a send.
 *
 * @returns {{ sends: object[], claims: object[], failures: object[], latest: { 1, 2, 3 }, auto: string[] }}
 *          sends/claims/failures newest first; latest[n] = the newest real send of level n (or null); auto = Toronto days
 */
function readReminderHistory(notes) {
  const parsed = (Array.isArray(notes) ? notes : []).map(parseNote).filter((n) => n.kind).sort((a, b) => idNum(a) - idNum(b));
  const claims = [], failures = [];
  for (const n of parsed) {
    if (n.kind === 'claim') { claims.push({ ...n, failed: false }); continue; }
    failures.push(n);
    const open = [...claims].reverse().find((c) => !c.failed && c.origin === n.origin && c.day === n.day && idNum(c) < idNum(n));
    if (open) open.failed = true;
  }
  const newestFirst = (list) => [...list].sort((a, b) => idNum(b) - idNum(a));
  const sends = newestFirst(claims.filter((c) => !c.failed));
  const latest = {};
  for (const lv of [1, 2, 3]) latest[lv] = sends.find((x) => x.level === lv) || null;
  return { sends, claims: newestFirst(claims), failures: newestFirst(failures), latest, auto: [...new Set(sends.filter((x) => x.level === 'auto').map((x) => x.day))] };
}

/** The sends (auto or button) recorded for a Toronto day — the once-per-day guard's input. */
const sentOn = (history, day) => history.sends.filter((x) => x.day === day);
/** Claims of one origin on one day, in id order — the race reads the earliest open one. */
const openClaims = (history, origin, day) => [...history.claims].filter((c) => c.origin === origin && c.day === day && !c.failed).sort((a, b) => idNum(a) - idNum(b));
/** Failed tries of one origin on one day. */
const failedTries = (history, origin, day) => history.claims.filter((c) => c.origin === origin && c.day === day && c.failed).length;

/**
 * A client-facing send about documents in the last 24 hours, from the notes and the
 * escalation engine's column: '' when none, else the reason (what and when).
 * @param {object[]} notes           [{ id, at, text }]
 * @param {object}   o               { now, escalationLastNotified: 'YYYY-MM-DD'|'' }
 */
function recentClientSend(notes, o = {}) {
  const now = o.now || io.now();
  const since = now - DAY;
  const fresh = (n) => Number.isFinite(n.at) && n.at >= since;
  const h = readReminderHistory(notes);
  const rem = h.sends.find((x) => fresh(x));
  if (rem) return `a document reminder went ${rem.level === 'auto' ? 'automatically' : `(reminder ${rem.level})`} at ${torontoTime(rem.at)}`;
  const rework = (notes || []).find((n) => fresh(n) && REWORK_NOTE_RE.test(n.text));
  if (rework) return `the client was emailed about a document to redo at ${torontoTime(rework.at)}`;
  const intake = (notes || []).find((n) => fresh(n) && INTAKE_NOTE_RE.test(n.text));
  if (intake) return `the portal email went to the client at ${torontoTime(intake.at)}`;
  const esc = s(o.escalationLastNotified).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(esc)) {
    const today = torontoDay(now);
    if (esc === today || esc === dayPlus(today, -1)) return `the escalation engine emailed the client on ${fmtDay(esc)}`;
  }
  return '';
}

/**
 * Why the AUTOMATIC email must not go today, from the record alone: a reminder of
 * any origin already recorded for today, or any client send in the last 24 h.
 * [] = clear. (The other automatic conditions — stage, %, deadline — are the tick's.)
 */
function autoSkipReasons(notes, o = {}) {
  const now = o.now || io.now();
  const out = [];
  const today = sentOn(readReminderHistory(notes), torontoDay(now));
  if (today.length) out.push(`a document reminder already went today (${today.map((x) => (x.level === 'auto' ? 'automatic' : `reminder ${x.level}`)).join(', ')})`);
  const recent = recentClientSend(notes, { now, escalationLastNotified: o.escalationLastNotified });
  if (recent) out.push(`another email reached the client in the last 24 hours: ${recent}`);
  return out;
}

/**
 * The case's notes, paged: the first page always; more pages while the oldest
 * note read is still inside the 90-day window and the page was full — so the
 * "Sent:" history and the 24-hour check never stop at the Needs-attention
 * reader's 50-note window on a busy case. Bounded at NOTES_MAX_PAGES.
 */
async function readCaseNotes(itemId, { now } = {}) {
  const t = now || io.now();
  const seen = new Map();
  for (let page = 1; page <= NOTES_MAX_PAGES; page++) {
    const batch = await io.readNotes(itemId, page);
    for (const n of batch) if (n.id && !seen.has(n.id)) seen.set(n.id, n);
    if (batch.length < NOTES_PAGE) break;
    const oldest = Math.min(...batch.map((n) => (Number.isFinite(n.at) ? n.at : Infinity)));
    if (oldest < t - HISTORY_WINDOW_MS) break;
  }
  return [...seen.values()];
}

// ─── Warnings the staff dialog shows (amber, never a block) ──────────────────

/**
 * @param {object} o  { history, level: 1|2|3, now, deadline: { actualDeadline }, recent: '' | reason }
 * @returns {string[]}
 */
function previewWarnings(o) {
  const h = o.history || readReminderHistory([]), level = o.level, now = o.now || io.now();
  const today = torontoDay(now);
  const when = (x) => `${fmtDay(x.day)}${x.by ? ` (${x.by})` : ''}`;
  const out = [];
  const mine = h.latest[level];
  if (mine) out.push(`Reminder ${level} already went on ${when(mine)}`);
  if (level >= 2 && !h.latest[1] && !h.latest[2] && level === 3) out.push('Reminders 1 and 2 skipped — the client has had no reminder yet');
  else if (level >= 2 && !h.latest[level - 1]) out.push(`Reminder ${level - 1} skipped${level === 2 && !h.latest[1] ? ' — this is the first reminder the client gets' : ''}`);
  if (level === 1 && h.latest[2]) out.push(`Reminder 2 already went on ${when(h.latest[2])} — this reminder 1 would come after it`);
  if (level <= 2 && h.latest[3]) out.push(`The final reminder already went on ${when(h.latest[3])}`);
  const autoToday = h.auto.includes(today);
  if (autoToday) out.push('Automatic reminder went today');
  const btnToday = sentOn(h, today).filter((x) => x.level !== 'auto');
  if (btnToday.length) out.push(`A reminder already went today (reminder ${btnToday.map((x) => x.level).join(', ')})`);
  if (o.recent && !autoToday && !btnToday.length) out.push(`The client was emailed in the last 24 hours: ${o.recent}`);
  const dl = o.deadline && o.deadline.actualDeadline;
  if (dl) {
    const n = daysUntil(dl, today);
    if (n < 0) out.push(`Deadline passed on ${fmtDay(dl)}`);
    else if (n === 0) out.push(`Deadline is today (${fmtDay(dl)})`);
    else if (n <= 7) out.push(`Deadline in ${n} day${n === 1 ? '' : 's'} (${fmtDay(dl)})`);
  }
  return out;
}

/** The "Sent:" facts the case page shows (dates pre-formatted; never an address beyond the masked one). */
function historyView(history) {
  const h = history || readReminderHistory([]);
  const one = (x) => (x ? { day: x.day, label: fmtDay(x.day), by: x.by || '', at: Number.isFinite(x.at) ? new Date(x.at).toISOString() : '', lastDay: x.lastDay || '' } : null);
  return {
    sent: { 1: one(h.latest[1]), 2: one(h.latest[2]), 3: one(h.latest[3]) },
    auto: h.auto.map((d) => ({ day: d, label: fmtDay(d) })),
    failures: h.failures.slice(0, 3).map((f) => ({ day: f.day, label: fmtDay(f.day), reason: f.reason || '', at: Number.isFinite(f.at) ? new Date(f.at).toISOString() : '' })),
    // the newest attempt did not go out (no send since): the card says so
    lastFailed: Boolean(h.failures[0] && (!h.sends[0] || idNum(h.failures[0]) > idNum(h.sends[0]))),
  };
}

// ─── The staff buttons: preview + send ───────────────────────────────────────

const refuse = (status, reason, message) => Object.assign(new Error(message), { status, reason, refused: true });

/**
 * The gate the server applies to a staff send, from the case overview
 * (caseCockpitService.getCaseOverview — a fresh read on every request): the row
 * is a live case, not locked, has a client email and an access code. Throws a
 * refusal (status + reason) — the % and the deadline are the staff's call.
 */
function gateStaff(overview) {
  const o = overview || {};
  if (o.cmUnavailable) throw refuse(503, 'cm-unavailable', 'Case data is temporarily unavailable — nothing was sent. Reload in a moment.');
  if (!isCaseGroup(o.group)) throw refuse(409, 'not-a-case', `This row is in the "${s(o.group && o.group.title) || 'non-case'}" group, not a live case — no reminder is sent from here.`);
  if (/^yes$/i.test(s(o.automationLock))) throw refuse(409, 'locked', 'Automation Lock is on for this case — reminders are off until it is cleared in Monday.');
  if (!s(o.clientEmail)) throw refuse(409, 'no-email', 'This case has no client email — nothing to send to.');
  if (!s(o.accessToken)) throw refuse(409, 'no-token', 'This case has no access code, so no portal link can be made — nothing was sent.');
}

/** What the card needs to decide whether the buttons show (pure; the overview builds it). */
function describeForCase({ overview, items, notes }) {
  const o = overview || {};
  const h = readReminderHistory(notes || []);
  const base = { available: true, reason: '', message: '', canSend: true, blocked: '', ...historyView(h) };
  if (o.cmUnavailable) return { ...base, available: false, reason: 'cm-unavailable', message: 'Case data is temporarily unavailable — reload in a moment.', canSend: false };
  if (!s(o.clientEmail)) return { ...base, available: false, reason: 'no-email', message: 'No client email on the case — reminders cannot be sent.', canSend: false };
  if (!s(o.accessToken)) return { ...base, available: false, reason: 'no-token', message: 'No access code on the case — no portal link can be made, so no reminder.', canSend: false };
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { ...base, available: false, reason: 'no-rows', message: 'No checklist rows yet — there is nothing to remind the client about.', canSend: false };
  const missing = missingFromItems(rows);
  if (!missing.count) return { ...base, available: false, reason: 'no-rows', message: 'Nothing is missing — every required document is in.', canSend: false };
  if (!isCaseGroup(o.group)) return { ...base, canSend: false, blocked: `This row is in the "${s(o.group && o.group.title) || 'non-case'}" group, not a live case.` };
  if (/^yes$/i.test(s(o.automationLock))) return { ...base, canSend: false, blocked: 'Automation Lock is on for this case — reminders are off until it is cleared in Monday.' };
  return { ...base, missingCount: missing.count };
}

/** The name a client email signs with: the VERIFIED Monday sign-in, else the office — never the shared-key placeholder. */
const senderName = (actor) => (actor && actor.verified && s(actor.name) ? s(actor.name) : 'TDOT Immigration');

/** The level from a request (1 | 2 | 3) or a 400 refusal. */
function parseLevel(v) {
  const n = Number(s(v));
  if (![1, 2, 3].includes(n)) throw refuse(400, 'bad-level', 'Choose reminder 1, 2 or the final reminder.');
  return n;
}

/** The common first half of a preview and a send: the gate, the fresh list, the record. */
async function prepareStaff({ overview, level, now }) {
  gateStaff(overview);
  const caseRef = s(overview.caseRef);
  const missing = await missingDocuments(caseRef);
  if (!missing.count) throw refuse(409, 'no-rows', 'Nothing is missing on the checklist — there is nothing to remind the client about.');
  const notes = await readCaseNotes(overview.itemId, { now });
  const history = readReminderHistory(notes);
  const recent = recentClientSend(notes, { now, escalationLastNotified: overview.escalationLastNotified });
  const deadline = overview.clientDeadlineRaw || {};
  return { caseRef, missing, notes, history, recent, deadline, warnings: previewWarnings({ history, level, now, deadline, recent }) };
}

/**
 * GET preview: the template with every merge field filled except the three the app
 * inserts itself ({MissingList}, {PortalLink}, and on the final {LastDay} — the date
 * box in the dialog). Never sends, never writes.
 */
async function previewStaffReminder({ overview, level, lastDay, actor, now } = {}) {
  const t = now || io.now();
  const lv = parseLevel(level);
  const p = await prepareStaff({ overview, level: lv, now: t });
  const base = await templates.templateFor(lv);
  const dl = p.deadline;
  const values = {
    ClientName: s(overview.clientName) || 'Client', CaseRef: p.caseRef, CaseType: s(overview.caseType) || 'immigration',
    MissingCount: String(p.missing.count), Deadline: dl.actualDeadline ? fmtDay(dl.actualDeadline) : 'not set',
    PromisedDate: dl.promisedSubmissionDate ? fmtDay(dl.promisedSubmissionDate) : 'not set', StaffName: senderName(actor),
  };
  const today = torontoDay(t);
  const last = lv === 3 ? (require('./deadlineService').cleanDay(lastDay) || dayPlus(today, FINAL_DEFAULT_DAYS)) : '';
  const tokensLeft = ['{MissingList}', '{PortalLink}', ...(lv === 3 ? ['{LastDay}'] : [])];
  if (lv !== 3) values.LastDay = '';
  return {
    level: lv,
    to: clientPortalService.maskEmail(overview.clientEmail),
    subject: fillTokens(base.subject, values).replace(/\s+/g, ' ').trim(),
    body: fillTokens(base.body, values),
    tokensLeft,
    missing: p.missing,
    missingList: missingListText(p.missing),
    missingCount: p.missing.count,
    deadlineLine: dl.actualDeadline ? `Deadline ${fmtDay(dl.actualDeadline)}` : (dl.promisedSubmissionDate ? `Promised submission ${fmtDay(dl.promisedSubmissionDate)}` : 'No deadline on the case'),
    lastDay: last,
    minLastDay: today,
    warnings: [...p.warnings, ...base.warnings],
    template: { name: base.name, source: base.source },
    history: historyView(p.history),
  };
}

/**
 * POST send: the gate again, the staff's text re-checked, the claim note, the race,
 * the email, the failure note. Resolves { ok, noted, noteId, to, warnings, level, day }
 * or throws a refusal ({ status, reason }) / { status: 502 } after a failed send.
 */
async function sendStaffReminder({ overview, level, subject, body, extra, lastDay, actor, now } = {}) {
  const t = now || io.now();
  const lv = parseLevel(level);
  const today = torontoDay(t);
  let last = '';
  if (lv === 3) {
    last = require('./deadlineService').cleanDay(lastDay);
    if (!last) throw refuse(400, 'bad-last-day', 'Enter the last day you will wait for the documents (a date).');
    if (last < today) throw refuse(400, 'bad-last-day', `The last day ${fmtDay(last)} is in the past.`);
  }
  const p = await prepareStaff({ overview, level: lv, now: t });
  const origin = ORIGIN_OF[lv];
  if (failedTries(p.history, origin, today) >= MAX_TRIES) throw refuse(409, 'max-tries', `This reminder did not go out ${MAX_TRIES} times today — the email system is having a temporary problem. Please try again tomorrow, or email the client by hand.`);
  let email;
  try {
    email = await buildReminderEmail({
      level: lv, caseRef: p.caseRef, clientName: overview.clientName, clientEmail: overview.clientEmail, caseType: overview.caseType,
      accessToken: overview.accessToken, missing: p.missing, deadline: p.deadline, lastDay: last,
      staffName: senderName(actor), extraLine: extra, subjectOverride: subject, bodyOverride: body,
    });
  } catch (err) { throw refuse(400, 'bad-text', err.message); }

  // 1. The claim — the record that this reminder is going out (before the email).
  let mine;
  try {
    mine = await io.postNote(overview.itemId, claimNote({ level: lv, to: email.to, actor: actor && actor.name, count: p.missing.count, lastDay: last, now: t }));
  } catch (err) { throw refuse(503, 'note-failed', `The note could not be saved on the case (${s(err.message).slice(0, 120)}) — nothing was sent. Try again in a minute.`); }

  // 2. Only the earliest open claim sends (a second app instance, or a second
  //    person, may have claimed the same reminder in the same seconds).
  try {
    const after = readReminderHistory(await io.readNotes(overview.itemId, 1));
    const open = openClaims(after, origin, today);
    if (open.length && open[0].id !== mine && open.some((x) => x.id === mine)) {
      await Promise.resolve(io.deleteNote(mine)).catch(() => {});
      throw refuse(409, 'lost-race', 'This reminder is being sent right now by someone else — nothing was sent twice. Reload the page in a moment.');
    }
  } catch (err) { if (err.refused) throw err; /* cannot re-read: our claim stands, send */ }

  // 3. The email.
  try {
    await io.sendEmail({ to: email.recipient, subject: email.subject, html: email.html, ...(email.replyTo ? { replyTo: email.replyTo } : {}) });
  } catch (err) {
    io.warn(`[DocReminders] ${p.caseRef}: reminder ${lv} did not go out: ${err.message}`);
    await Promise.resolve(io.postNote(overview.itemId, failureNote({ level: lv, reason: 'the email could not be sent', now: io.now() })))
      .catch((e) => io.warn(`[DocReminders] failure note also failed for ${p.caseRef}: ${e.message}`));
    throw Object.assign(new Error('The email could not be sent — please try again in a moment.'), { status: 502, reason: 'send-failed', sendFailed: true });
  }
  io.log(`[DocReminders] ${p.caseRef}: reminder ${lv} sent to ${email.to} by ${s(actor && actor.name) || 'staff'}`);
  return { ok: true, noted: true, noteId: mine, to: email.to, warnings: email.warnings, level: lv, day: today, lastDay: last };
}

module.exports = {
  isAutoEnabled,
  missingDocuments,
  missingFromItems,
  buildReminderEmail,
  // the record
  io, claimNote, failureNote, parseNote, rawNotes, readReminderHistory, readCaseNotes, recentClientSend, autoSkipReasons, previewWarnings, historyView,
  sentOn, openClaims, failedTries, isCaseGroup, describeForCase,
  // the staff buttons
  gateStaff, parseLevel, senderName, previewStaffReminder, sendStaffReminder,
  NOTE_HEAD, NOTE_HEAD_TEXT, NOT_CASE_GROUPS, MAX_TRIES, NOTES_PAGE, NOTES_MAX_PAGES, FINAL_DEFAULT_DAYS,
  // pure — exported for tests
  _internal: { fmtDay, oneLine, fillTokens, missingListText, missingListHtml, LEVEL_NAMES, torontoDay, dayPlus, daysUntil, marker, failMarker },
};
