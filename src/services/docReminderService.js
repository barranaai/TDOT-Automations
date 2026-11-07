'use strict';

/**
 * Document-collection reminders (team meeting 2026-11-05, block 2):
 * the missing-documents list and the reminder email itself.
 *
 * Two halves. The first is pure building — the list and the email, no Monday writes,
 * no sending. The second (step B) is the RECORD and the staff send: the case's notes
 * are the only record of a reminder (the booking-reminders pattern — no column), the
 * three cockpit buttons preview, edit and send through sendStaffReminder, and the
 * automatic daily email (step C: runDocReminders, at the end) reuses the same
 * guards. Every outbound call —
 * notes read/post/delete, the email — goes through the `io` seam so tests replace it.
 * The Monday READS of the first half are the case's checklist
 * (documentFormService.getCaseSummary) and, when the templates board is set, the
 * templates (docReminderTemplates, cached).
 *
 * Rules that must not be undone:
 *  - {MissingList} is DOCUMENT checklist rows only, never questionnaire items (Faran, L64);
 *    the questionnaire is its OWN block ({QuestionnaireList}, Gauri's texts 2026-11-07):
 *    one line per family member who has not submitted, from the saved answers
 *    (deriveQuestionnaireProgress over getMemberStatuses — a pre-fill-only file is not
 *    the client's work), never a section list (which sections apply is decided only in
 *    the browser — a server list would tell a single applicant to fill the spouse
 *    section), never written to Monday; progress that could not be read is left out of
 *    the email (never a nudge on a blip — the portal's qUnavailable rule);
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
      return { member: g.member, type: g.type, categories };
    });
  // rows = every checklist row, N/A and optional ones too: "no checklist rows" is judged on this,
  // never on progress.total (an all-N/A checklist has rows — review round 1 of Gauri's texts [4])
  return { groups, count: missing.length, rework, progress: { received, total }, rows: rows.length };
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

/**
 * Whether a group's member heading is printed: always when the list has more than one
 * member, and for a lone group whose member is NOT the principal applicant — a
 * spouse-only list must say whose passport is missing (review 2026-11-07).
 */
const showMember = (missing, g) => missing.groups.length > 1 || (g.type || 'Principal Applicant') !== 'Principal Applicant';

/** Whether the documents block prints: a missing row, or a row waiting for a new copy (Rework Required — review round 2 of Gauri's texts [2]). */
const docsOpen = (missing) => Boolean(missing) && (missing.count > 0 || missing.rework > 0);
const reworkSentence = (n, lead) => `${lead ? '' : '...and '}${n} document${n === 1 ? ' is' : 's are'} waiting for a new copy (see the note on each in your portal).`;
/** The documents block's lead line: the missing count, or — nothing missing, only new copies due — "Documents to upload again (N):". */
const docsLead = (missing) => (missing.count > 0 ? `Documents still needed (${missing.count}):` : `Documents to upload again (${missing.rework}):`);

/** The missing list as the email shows it, under its lead line "Documents still needed (N):" (member heading only when there is more than one member, or the one member is not the principal applicant). */
function missingListHtml(missing) {
  const blocks = missing.groups.map((g) => {
    const multi = showMember(missing, g);
    const cats = g.categories.map((c) => `
            <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px;">${esc(c.category)}</div>
            <ul style="margin:0;padding-left:20px;">
${c.items.map((it) => `              <li style="font-size:14px;color:#1e293b;line-height:1.55;margin:0 0 4px;"><strong>${esc(it.name)}</strong>${it.instruction ? ` <span style="color:#64748b;">— ${esc(it.instruction)}</span>` : ''}</li>`).join('\n')}
            </ul>`).join('');
    return `${multi ? `<div style="font-size:14px;font-weight:700;color:#1e293b;margin:14px 0 2px;">${esc(g.member)}</div>` : ''}${cats}`;
  }).join('');
  const rework = missing.rework > 0
    ? (missing.count > 0
      ? `<div style="font-size:13px;color:#64748b;margin:12px 0 0;">…and ${esc(reworkSentence(missing.rework, true))}</div>`
      : `<div style="font-size:14px;color:#1e293b;line-height:1.55;margin:8px 0 0;">${esc(reworkSentence(missing.rework, true))}</div>`)
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border-radius:10px;border:1px solid #fed7aa;margin:4px 0 20px;">
          <tr><td style="padding:14px 20px 16px;">
            <div style="font-size:13px;font-weight:700;color:#9a3412;">${esc(docsLead(missing))}</div>${blocks}${rework}
          </td></tr>
        </table>`;
}

function missingListText(missing) {
  const lines = [];
  for (const g of missing.groups) {
    const multi = showMember(missing, g);
    if (multi) lines.push(`${g.member}:`);
    for (const c of g.categories) {
      lines.push(`${multi ? '  ' : ''}${c.category}`);
      for (const it of c.items) lines.push(`${multi ? '  ' : ''}  - ${it.name}${it.instruction ? ` — ${it.instruction}` : ''}`);
    }
  }
  if (missing.rework > 0) lines.push(reworkSentence(missing.rework, missing.count === 0));
  return lines.join('\n');
}

// ─── The questionnaire list ({QuestionnaireList}) ─────────────────────────────

const pctOf = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0; };

/**
 * Pure: what is unfinished in the client's questionnaire, one line per family member
 * who has not submitted. Input = the members as getMemberStatuses (+ decorateMembers)
 * hand them over — { key, type, label, badge?, status, hasData, completionPct, submittedAt } —
 * plus `unavailable` (the member list or a member file could not be read),
 * `mondayDone` (the Client Master questionnaire status reads Done), `notApplicable` (the case
 * type has no questionnaire form — done, nothing listed) and `embedsAllMembers` (one form holds
 * every member — spousal F10 — so only the principal's submission counts).
 *
 * "Done" is the portal's rule (clientPortalService): every member submitted, OR the
 * board says Done and the manifest has no evidence either way (a pre-manifest case, a
 * submission whose manifest write failed, a read failure). An empty member list is
 * UNKNOWN, never done. null in → null out ("not given": no block, no warning).
 *
 * @returns {null | { unavailable: boolean, done: boolean, pct: number|null, total: number,
 *                    pending: Array<{ label: string, line: string, pct: number, started: boolean }> }}
 */
function questionnaireFromMembers(q) {
  if (!q || typeof q !== 'object') return null;
  // a case type with no questionnaire form (CEC, ETA, Child Sponsorship…): the client's link shows
  // only a placeholder page — there is nothing to chase, so it reads as done, no block, no warning
  // (review round 1 of Gauri's texts [0])
  if (q.notApplicable === true) return { unavailable: false, done: true, notApplicable: true, pct: null, total: 0, pending: [] };
  const htmlQ = require('./htmlQuestionnaireService');
  let list = (Array.isArray(q.members) ? q.members : []).filter((m) => m && typeof m === 'object');
  // a form that holds every member (spousal F10, embedsAllMembers): the client fills and submits ONE
  // form — the principal's; the other rows have no questionnaire of their own, so only the principal
  // is judged (no principal row: the whole list, as before) (review round 1 [1])
  if (q.embedsAllMembers === true && list.some((m) => m.key === 'primary')) list = list.filter((m) => m.key === 'primary');
  const unread = q.unavailable === true || list.length === 0;
  const stamps = list.some((m) => m.submittedAt);
  const d = htmlQ.deriveQuestionnaireProgress({ members: list, mondayPct: 0 });
  const done = (!unread && d.submitted) || (q.mondayDone === true && (unread || !stamps));
  if (done) return { unavailable: false, done: true, pct: unread ? null : d.pct, total: list.length, pending: [] };
  if (unread) return { unavailable: true, done: false, pct: null, total: 0, pending: [] };
  // one member who is the principal applicant: "Your questionnaire" (the documents list hides that heading too)
  const lone = list.length === 1 && (list[0].type || 'Principal Applicant') === 'Principal Applicant';
  const pending = list.filter((m) => !m.submittedAt).map((m) => {
    const pct = pctOf(m.completionPct);
    const started = Boolean(m.hasData || m.hasAdditionalData) || pct > 0;
    const name = s(m.label) || s(m.type) || 'Family member';
    const badge = s(m.badge);
    const label = lone ? 'Your questionnaire' : (badge && badge.toLowerCase() !== name.toLowerCase() ? `${name} (${badge})` : name);
    // started with 0 % stored (a legacy CSV / plain-array file, answers only in the second form): "started", never "0% complete" (review round 1 [2])
    const state = !started ? 'not started yet' : (pct >= 100 ? 'all filled in, not submitted yet' : (pct > 0 ? `${pct}% complete, not submitted yet` : 'started, not submitted yet'));
    return { label, line: `${label} — ${state}`, pct, started };
  });
  return { unavailable: false, done: false, pct: d.pct, total: list.length, pending };
}

/** Is there something to list ({QuestionnaireList} has content)? */
const questionnaireOpen = (q) => Boolean(q && !q.unavailable && !q.done && q.pending.length);

/** The questionnaire block as the email shows it — its own block, never inside a <p>; '' when there is nothing to list. */
function questionnaireListHtml(q) {
  if (!questionnaireOpen(q)) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border-radius:10px;border:1px solid #bfdbfe;margin:4px 0 20px;">
          <tr><td style="padding:14px 20px 16px;">
            <div style="font-size:13px;font-weight:700;color:#1e3a8a;">Questionnaire still to finish:</div>
            <ul style="margin:8px 0 0;padding-left:20px;">
${q.pending.map((m) => `              <li style="font-size:14px;color:#1e293b;line-height:1.55;margin:0 0 4px;">${esc(m.line)}</li>`).join('\n')}
            </ul>
          </td></tr>
        </table>`;
}

/** The plain-text mirror of questionnaireListHtml ('' when there is nothing to list). */
function questionnaireListText(q) {
  if (!questionnaireOpen(q)) return '';
  return ['Questionnaire still to finish:', ...q.pending.map((m) => `  - ${m.line}`)].join('\n');
}

/** The lines the staff dialog shows read-only (the same lines the email prints). */
function questionnaireView(q) {
  if (!q) return null;
  return { unavailable: q.unavailable, done: q.done, notApplicable: q.notApplicable === true, pct: q.pct, pending: q.pending.map((m) => ({ label: m.label, line: m.line })) };
}

const Q_TOKEN = '{QuestionnaireList}';
// the closing paragraphs a list must never sit under ("Thank you for your cooperation.", "Kind regards,…")
const SIGN_OFF_RE = /^(?:thank you for your cooperation|(?:kind |best |warm )?regards\b|sincerely\b)/i;
/**
 * A text without {QuestionnaireList}: the token goes right after the first {MissingList}; a text
 * without either goes before the sign-off (never under the signature — review round 1 [6]), else at the end.
 */
function withQuestionnaireToken(body) {
  const b = String(body || '');
  if (b.includes(Q_TOKEN)) return b;
  if (b.includes('{MissingList}')) return b.replace('{MissingList}', `{MissingList}\n\n${Q_TOKEN}`);
  const paras = b.split(/\n\s*\n/);
  const i = paras.findIndex((p, k) => k > 0 && SIGN_OFF_RE.test(p.trim()));
  if (i < 0) return `${b}\n\n${Q_TOKEN}`;
  paras.splice(i, 0, Q_TOKEN);
  return paras.join('\n\n');
}
const Q_APPENDED_WARNING = 'the text had no {QuestionnaireList} — the unfinished questionnaire was added after the documents list';
/** The warning for a token the app placed: where it went (the documents list, the sign-off, the end). */
function qPlacedWarning(before, after) {
  if (before.includes('{MissingList}')) return Q_APPENDED_WARNING;
  return after.endsWith(Q_TOKEN) ? 'the text had no {QuestionnaireList} — the unfinished questionnaire was added at the end'
    : 'the text had no {QuestionnaireList} — the unfinished questionnaire was added before the sign-off';
}
const Q_UNAVAILABLE_WARNING = 'The questionnaire progress could not be read — the email will not mention it.';
// A case type with no questionnaire form (resolveForm → null): the list is left out, but the
// wording may still ask for one — Gauri's texts do — so staff are told to edit it (review round 2 [1][3])
const Q_NO_FORM_WARNING = 'This case type has no questionnaire, but the text still asks the client to complete one — edit it before sending.';
const mentionsQuestionnaire = (...texts) => texts.some((t) => /questionnaire/i.test(String(t || '').split(Q_TOKEN).join('')));

/** The {Token} values of one email; the two rich tokens are placeholders filled at render. */
function fillTokens(text, values) {
  return String(text || '').replace(/\{([A-Za-z]+)\}/g, (m, t) => (t in values ? values[t] : m));
}

const LEVEL_NAMES = { 1: 'Reminder 1', 2: 'Reminder 2', 3: 'Final reminder', auto: 'Document reminder' };

/** The case type as the email may print it: '' for the cockpit's display placeholders ('—', '-', 'Not set') and anything with no letter or digit. */
function caseTypeText(v) {
  const t = String(v == null ? '' : v).trim();
  if (!/[A-Za-z0-9]/.test(t) || /^not set$/i.test(t)) return '';
  return t;
}
const REPLY_REFUSAL = (what) => `The reminder text cannot be sent: the ${what} tells the client to reply — the sender is a no-reply mailbox; say "email us at info@tdotimm.com" instead.`;

// The imaginary-deadline variant of the automatic email (DOC_REMINDERS_IMAGINARY, ships
// OFF): the same "Automatic" template with its "must be submitted by {Deadline}" sentence
// swapped for a promised-date lead. The wording is a stand-in until Gauri settles "two
// weeks" vs "delayed" (plan §3a); the board template is not edited.
const IMAGINARY_LEAD = 'We plan to submit your {CaseType} application by {PromisedDate}. To keep that date we need the documents below as soon as possible — if they arrive later, your submission moves to the next window.';
function imaginaryBody(body) {
  const paras = String(body || '').split(/\n\s*\n/);
  const i = paras.findIndex((p) => p.includes('{Deadline}'));
  if (i < 0) { paras.splice(1, 0, IMAGINARY_LEAD); return paras.join('\n\n'); }   // after the greeting
  paras[i] = paras[i].split(/(?<=[.!?])\s+/).map((x) => (x.includes('{Deadline}') ? IMAGINARY_LEAD : x)).join(' ');
  return paras.join('\n\n');
}

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
 * @param {object} [o.questionnaire]   { members, unavailable, mondayDone, notApplicable?, embedsAllMembers? } (questionnaireFromMembers' input) —
 *                                     absent = not given: no questionnaire block, no warning
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
  const variant = level === 'auto' && o.variant === 'imaginary' ? 'imaginary' : 'real';
  if (variant === 'imaginary') body = imaginaryBody(body);
  if (o.subjectOverride != null && String(o.subjectOverride).trim()) subject = templates.stripHtml(o.subjectOverride).replace(/\s*\n\s*/g, ' ');
  // the subject is checked whatever its source (a subject-only edit used to slip past the body branch)
  if (templates.tellsToReply(subject)) throw new Error(REPLY_REFUSAL('subject'));
  let listAppended = false;
  if (o.bodyOverride != null && String(o.bodyOverride).trim()) {
    // checked again at send: the dialog's text is the staff's, the rules are not editable
    const v = templates.validate({ subject, body: o.bodyOverride });
    const hard = v.problems.filter((p) => !/\{MissingList\}/.test(p));
    if (hard.length) throw new Error(`The reminder text cannot be sent: ${hard.join('; ')}.`);
    body = v.body;
    // only when there IS a documents list: with every document in, nothing is added and nothing said (review round 1 [6])
    if (!body.includes('{MissingList}') && docsOpen(missing)) { body += '\n\n{MissingList}'; listAppended = true; warnings.push('the edited text had no {MissingList} — the missing documents were added at the end'); }
    // (v.warnings — unknown tokens — are found again below on the final text, once)
  }
  // the questionnaire: its block where {QuestionnaireList} sits; a text (board or edited) without
  // the token gets it after the documents list when there is something to list (decision 7)
  const q = questionnaireFromMembers(o.questionnaire);
  let questionnaireAppended = false;
  if (questionnaireOpen(q) && !body.includes(Q_TOKEN)) { const before = body; body = withQuestionnaireToken(body); questionnaireAppended = true; warnings.push(qPlacedWarning(before, body)); }
  if (q && q.unavailable) warnings.push('the questionnaire progress could not be read — the email does not mention it');
  if (q && q.notApplicable && mentionsQuestionnaire(subject, body)) warnings.push(Q_NO_FORM_WARNING);

  const dl = o.deadline || {};
  const portalUrl    = clientPortalService.buildPortalUrl({ caseRef, accessToken });
  const encodedRef   = encodeURIComponent(caseRef);
  const documentsUrl = `${BASE_URL}/documents/${encodedRef}?t=${encodeURIComponent(accessToken)}`;   // the page checks the code (2026-10-31)
  // the imaginary variant has no actual deadline: {Deadline} anywhere (a board subject, a second mention) is the promised date, never "not set"
  const imaginaryFill = variant === 'imaginary' && !dl.actualDeadline && Boolean(dl.promisedSubmissionDate);
  const values = {
    ClientName:   String(o.clientName || '').trim() || 'Client',
    CaseRef:      caseRef,
    CaseType:     caseTypeText(o.caseType) || 'immigration',
    MissingCount: String(missing.count),
    Deadline:     dl.actualDeadline ? fmtDay(dl.actualDeadline) : (imaginaryFill ? fmtDay(dl.promisedSubmissionDate) : 'not set'),
    PromisedDate: dl.promisedSubmissionDate ? fmtDay(dl.promisedSubmissionDate) : 'not set',
    LastDay:      o.lastDay ? fmtDay(o.lastDay) : '',
    StaffName:    String(o.staffName || '').trim() || 'TDOT Immigration',
  };
  const unknown = templates.unknownTokens(`${subject}\n${body}`);
  if (unknown.length) warnings.push(`unknown merge field${unknown.length === 1 ? '' : 's'} left as typed: ${unknown.map((t) => `{${t}}`).join(', ')}`);
  if (!dl.actualDeadline && !imaginaryFill && /\{Deadline\}/.test(`${subject}\n${body}`)) warnings.push('the text names the deadline, but this case has no actual deadline — it reads "not set"');
  if (imaginaryFill && /\{Deadline\}/.test(subject)) warnings.push('the subject named {Deadline} — this case has an imaginary deadline, so the promised date was used');

  const subjectOut = fillTokens(subject, { ...values, MissingList: `${missing.count} documents`, QuestionnaireList: 'questionnaire', PortalLink: '' }).replace(/\s+/g, ' ').trim();
  const bodyFilled = fillTokens(body, { ...values, MissingList: '{MissingList}', QuestionnaireList: Q_TOKEN, PortalLink: '{PortalLink}' });
  const extra = String(o.extraLine || '').replace(/<[^>]*>/g, '').trim();
  if (extra && templates.tellsToReply(extra)) throw new Error(REPLY_REFUSAL('extra line'));   // the staff's free line obeys the same rule as the template
  const progress = o.progress || missing.progress;
  // a Rework Required row counts as received (IN_PIPELINE) — the line says it still needs a new copy (review round 2 [2])
  const progressLine = progress && progress.total > 0
    ? `${progress.received} of ${progress.total} documents received${missing.rework > 0 ? ` — ${missing.rework} need${missing.rework === 1 ? 's' : ''} a new copy` : ''}` : '';

  // HTML: the template's paragraphs, the documents block where {MissingList} sits and the
  // questionnaire block where {QuestionnaireList} sits (each its own block, never inside a <p>;
  // an empty one is left out, heading and all), the staff's own line right under the last list
  // ("we are still looking for…") — also when the documents are all in
  const extraHtml = extra ? `        <p style="font-size:15px;color:#1e293b;line-height:1.65;margin:0 0 16px;background:#f8fafc;border-left:3px solid #C9A84C;padding:10px 14px;">${esc(extra).replace(/\n/g, '<br>')}</p>` : '';
  const portalA  = `<a href="${esc(portalUrl)}" style="color:#8B0000;word-break:break-all;">${esc(portalUrl)}</a>`;
  const docsHtml = docsOpen(missing) ? missingListHtml(missing) : '';
  const qHtml    = questionnaireListHtml(q);
  const docsText = docsOpen(missing) ? `${docsLead(missing)}\n${missingListText(missing)}` : '';
  const qText    = questionnaireListText(q);
  const parts    = bodyFilled.split(/(\{MissingList\}|\{QuestionnaireList\})/);
  const isList   = (p) => p === '{MissingList}' || p === Q_TOKEN;
  const blockOf  = (p, kind) => (p === '{MissingList}' ? (kind === 'html' ? docsHtml : docsText) : (kind === 'html' ? qHtml : qText));
  // the staff line follows the last list that printed something (else the last list token)
  let extraAt = -1;
  parts.forEach((p, i) => { if (isList(p) && blockOf(p, 'html')) extraAt = i; });
  if (extraAt < 0) parts.forEach((p, i) => { if (isList(p)) extraAt = i; });
  const bodyHtml = parts.map((p, i) => {
    const h = isList(p) ? blockOf(p, 'html') : paragraphsHtml(p, { '{PortalLink}': portalA });
    return i === extraAt && extraHtml ? [h, extraHtml].filter(Boolean).join('\n') : h;
  }).filter(Boolean).join('\n');
  const bodyText = parts.map((p, i) => {
    const t = isList(p) ? blockOf(p, 'text') : fillTokens(p, { PortalLink: portalUrl });
    return i === extraAt && extra ? (t ? `${t}\n\n${extra}` : extra) : t;
  }).join('').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
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
    bodyText,
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
    template: { name: base.name, source: base.source, edited: Boolean(o.bodyOverride || o.subjectOverride), listAppended, questionnaireAppended, variant },
    questionnaire: questionnaireView(q),
    links: { portalUrl, documentsUrl },
  };
}


// ─── The record: the case's notes ────────────────────────────────────────────

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const NOTE_HEAD      = '📨 <b>Document reminder';          // the stable head of every reminder note (sent, automatic, did not go out)
const NOTE_HEAD_TEXT = '📨 Document reminder';             // the same head as Monday renders it (tags stripped)
const MARKER_RE      = /DOCREM:(btn1|btn2|btn3|auto):(\d{4}-\d{2}-\d{2})/;        // a send's claim (its origin + Toronto day)
const FAIL_RE        = /DOCREM-FAIL:(btn1|btn2|btn3|auto):(\d{4}-\d{2}-\d{2})(?::(\d+))?/;   // the failure that cancels its claim — by the claim note's id when present (notes before 2026-11-07 have none)
const RACE_WINDOW_MS = 3 * 60 * 1000;      // a claim older than this has finished (a send takes seconds; a failed one has its failure note) — not a competitor
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
// The board groups that are not live cases — the ONE list shared with needsAttentionService (src/utils/caseGroups.js).
const { NOT_CASE_GROUPS, isCaseGroup, isTestGroup } = require('../utils/caseGroups');
// A TEST-group row (the office's own test records, their mailbox ours) may be used by the
// staff buttons, and by the automatic run only when its ref is on DOC_REMINDERS_ONLY —
// that is how the plan's live check (§8 step 13) runs without a real client. Leads and
// Cancel rows are never let through by anything.
const liveOrTest = (group) => isCaseGroup(group) || isTestGroup(group);

// The automatic run (step C): the Client Master columns it reads, one page of rows.
const DCS_STAGE = 'Document Collection Started';
const AUTO_PAGE = 100;
const AUTO_COLS = {
  ref: 'text_mm142s49', caseType: 'dropdown_mm0xd1qn', stage: 'color_mm0x8faa', payment: 'color_mm0x9fnn',
  lock: 'color_mm0x3x1x', override: 'color_mm0x975e',
  deadlineType: 'color_mm6w7cdd', actualDeadline: 'date_mm33sj6t', promised: 'date_mm3t66pa',   // the client's deadline (block 1)
  docUploaded: 'numeric_mm2njqk1',                                                              // Documents Uploaded % (Faran: the 50 % line)
  email: 'text_mm0xw6bp', token: 'text_mm0x6haq',
  stageStart: 'date_mm0xjm1z', lastActivity: 'date_mm1amqyr',
  qStatus: 'color_mm0x9s08',                                                                    // questionnaire status — Done = submitted (the portal's fallback when the manifest has no stamps); read only
  // not read: Escalation Last Notified (date_mm1gqbd) — the engine stamps it on every matched rule, not only on a client email
};

const s = (v) => String(v == null ? '' : v).trim();
const idNum = (x) => Number(x && x.id) || 0;
const stripTags = (v) => String(v == null ? '' : v).replace(/<[^>]*>/g, '');
const marker = (origin, day) => `<span style="display:none">DOCREM:${origin}:${day}</span>`;
const failMarker = (origin, day, claimId) => `<span style="display:none">DOCREM-FAIL:${origin}:${day}${/^\d+$/.test(s(claimId)) ? `:${s(claimId)}` : ''}</span>`;

/** Toronto calendar day (YYYY-MM-DD) of an instant. */
function torontoDay(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
/** A YYYY-MM-DD day plus n days (calendar arithmetic, no zone). */
function dayPlus(day, n) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from Toronto `today` to a YYYY-MM-DD day (negative = past). */
function daysUntil(day, today) { return Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY); }
/** '14 Nov 2026' / '30 Sept 2026' (as a note prints a day — en-GB writes "Sept") → '2026-11-14'; '' when it is not such a date. */
function dayFromWords(words) {
  const m = /^(\d{1,2}) ([A-Za-z]{3,4}) (\d{4})$/.exec(s(words));
  if (!m) return '';
  const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].slice(0, 3).toLowerCase());
  if (mi < 0) return '';
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
/** Is it this hour in Toronto now? (the daily automatic run comes from an hourly tick — see scheduler.js) */
function isTorontoHour(hour, ms = io.now()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
  return h === hour;
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
  /**
   * The automatic run's ONE list read: the Cases-board rows at Document Collection
   * Started (the stage column filtered on the board, explicit limit, cursor followed),
   * with the columns the selector reads — never the whole board with its notes.
   */
  async listDcsRows() {
    const q = require('./mondayApi');
    const { clientMasterBoardId } = require('../../config/monday');
    const cols = JSON.stringify(Object.values(AUTO_COLS));
    const FIELDS = `cursor items { id name group { id title } column_values(ids:${cols}) { id text } }`;
    const first = await q.query(
      `query($b:ID!,$v:String!){ items_page_by_column_values(limit:${AUTO_PAGE}, board_id:$b, columns:[{column_id:"${AUTO_COLS.stage}", column_values:[$v]}]) { ${FIELDS} } }`,
      { b: String(clientMasterBoardId), v: DCS_STAGE });
    let page = first && first.items_page_by_column_values;
    if (!page) throw new Error('the Cases board could not be read');
    const rows = [...(page.items || [])];
    let pages = 0;
    while (page && page.cursor && ++pages < 20) {
      const d = await q.query(`query($c:String!){ next_items_page(limit:${AUTO_PAGE}, cursor:$c) { ${FIELDS} } }`, { c: page.cursor });
      page = d && d.next_items_page;
      rows.push(...((page && page.items) || []));
    }
    return rows;
  },
  /** The Documents Uploaded % recounted now from the checklist (the readiness engine's own formula, dry run — nothing written); null when the case has no rows. */
  async liveUploadedPct(caseRef, itemId) {
    const r = await require('./caseReadinessService')._internal.refreshDocNumbers({ masterItemId: itemId, caseRef, dryRun: true });
    return r && r.after && r.after.uploadedPct != null ? Number(r.after.uploadedPct) : null;
  },
  /**
   * The questionnaire's state for one case — READ ONLY (the automatic run's one extra read per
   * candidate): the case lookup (one Monday read, limit 1, no form versioning), the members
   * manifest WITHOUT seeding it (readMembersManifest never writes; no file = the principal
   * applicant alone), then every member's saved file (getMemberStatuses — a pre-fill-only file
   * is not the client's work). Decorated as the pages show members. Any read failure →
   * { unavailable: true } — the email then leaves the questionnaire out. Never writes Monday.
   */
  async questionnaireState(caseRef) {
    const htmlQ = require('./htmlQuestionnaireService');
    try {
      const v = await htmlQ.validateAccessForStaff(caseRef, { skipFormVersioning: true });
      // no form for this case type: no questionnaire to chase — and no OneDrive read (review round 1 [0])
      if (!v.formFiles) return { members: [], notApplicable: true, unavailable: false };
      const clientName = v.clientName;
      const manifest = await htmlQ.readMembersManifest({ clientName, caseRef });
      const members = manifest || [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }];
      const qMembers = await htmlQ.getMemberStatuses({ clientName, caseRef, members, formFiles: v.formFiles });
      return { members: require('../utils/familyRoleLabels').decorateMembers(v.caseType, qMembers, v.caseSubType), unavailable: false,
        embedsAllMembers: require('../../config/questionnaireFormMap').formEmbedsMembers(v.caseType, v.caseSubType) };   // spousal F10: the principal's form is the whole questionnaire
    } catch (err) {
      return { members: [], unavailable: true, error: s(err && err.message).slice(0, 160) };
    }
  },
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
 * @param {object} o  { level: 1|2|3|'auto', to (masked), actor (name), count, lastDay?, deadline?, pct?, questionnaire?, now, day? }
 *                    questionnaire = true when the email listed an unfinished questionnaire (", questionnaire not finished"
 *                    goes right after the count — parseNote reads "by X — N documents missing" and "— last day D —")
 *                    day = the marker's Toronto day (the caller's "today"); taken from `now` when not given
 */
function claimNote(o) {
  const level = o.level, origin = ORIGIN_OF[level];
  if (!origin) throw new Error(`Unknown reminder level: ${level}`);
  // The marker's Toronto day is taken at CLAIM time. A send that straddles midnight (claim
  // 23:59:58, email 00:00:02) is accepted as that day's send — the next day's run may then
  // email again, which is one extra reminder, never a lost one (review 2026-11-07, left as is).
  // The callers pass their own `today` so the claim and its failure note carry ONE day.
  const day = o.day || torontoDay(o.now), when = `${torontoTime(o.now)} (Toronto)`;
  const docs = `${Number(o.count) || 0} document${Number(o.count) === 1 ? '' : 's'} missing`;
  const qPart = o.questionnaire ? ', questionnaire not finished' : '';
  if (level === 'auto') {
    const pct = o.pct == null || o.pct === '' ? '' : ` (${Number(o.pct)} % uploaded)`;
    return `${NOTE_HEAD} (automatic)</b> emailed to ${noteEsc(o.to)} — deadline ${noteEsc(o.deadline) || 'not set'}, ${docs}${pct}${qPart} — ${when}${marker(origin, day)}`;
  }
  const last = level === 3 && o.lastDay ? ` — last day ${fmtDay(o.lastDay)}` : '';
  return `${NOTE_HEAD} ${level} sent</b> (${TONE[level]}) to ${noteEsc(o.to)} by ${noteEsc(o.actor) || 'staff'} — ${docs}${qPart}${last} — ${when}${marker(origin, day)}`;
}

/**
 * The failure note — after a send that did not go out; cancels its claim (named by `claimId` —
 * the note id the claim post answered). `day` = the claim's Toronto day (the caller's "today"),
 * so a send that fails after midnight still pairs with its claim; taken from `now` when not given.
 */
function failureNote(o) {
  const origin = ORIGIN_OF[o.level];
  if (!origin) throw new Error(`Unknown reminder level: ${o.level}`);
  const day = o.day || torontoDay(o.now);
  return `${NOTE_HEAD} did not go out</b> — ${noteEsc(o.reason).slice(0, 200) || 'the email could not be sent'} — ${torontoTime(o.now)} (Toronto)${failMarker(origin, day, o.claimId)}`;
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
    // what the reminder was about: the document count (null on a note that names none) and whether
    // the questionnaire was listed — a final sent for the questionnaire alone is judged on it (review round 1 [3])
    const docs = /— (\d+) documents? missing/.exec(text);
    return { ...base, kind: 'claim', origin, level: LEVEL_OF[origin], day: m[2], by: s(by), to: s(to), lastDay: s(lastDay), lastDayIso: dayFromWords(lastDay),
      docsMissing: docs ? Number(docs[1]) : null, questionnaire: /, questionnaire not finished/.test(text) };
  }
  const f = FAIL_RE.exec(text);
  if (f) {
    const reason = (/did not go out(?:<\/b>)? — (.+?) — \d{1,2} \w{3,4} \d{4}/.exec(text) || [])[1] || '';
    return { ...base, kind: 'fail', origin: f[1], level: LEVEL_OF[f[1]], day: f[2], claimId: s(f[3]), reason: s(reason) };
  }
  return { ...base, kind: null };
}

/**
 * The reminder record from a case's notes (any order; raw or rendered text).
 * A failure note cancels the claim it names (the claim note's id in its marker);
 * an older failure note with no id cancels the newest uncancelled claim of the
 * same origin + day above it — so a claim followed by "did not go out" is a try,
 * never a send.
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
    const open = n.claimId
      ? claims.find((c) => c.id === n.claimId && !c.failed && c.origin === n.origin && idNum(c) < idNum(n))   // by id (unique): never another instance's claim; no day test — a send that fails after midnight still cancels its claim (review round 2 [0])
      : [...claims].reverse().find((c) => !c.failed && c.origin === n.origin && c.day === n.day && idNum(c) < idNum(n));         // old notes: the newest open one
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
/** Claims of one origin on one day, in id order. */
const openClaims = (history, origin, day) => [...history.claims].filter((c) => c.origin === origin && c.day === day && !c.failed).sort((a, b) => idNum(a) - idNum(b));
/** Open claims of EVERY origin on one day, in id order — the race reads the earliest one. */
const openClaimsAnyOrigin = (history, day) => [...history.claims].filter((c) => c.day === day && !c.failed).sort((a, b) => idNum(a) - idNum(b));
/**
 * The race's competitors: our own claim plus the open claims OF ANY ORIGIN posted within
 * RACE_WINDOW_MS of now — a staff send and the automatic run in the same seconds are one
 * race, and the lower note id wins (review round 2 [1]). An older open claim today is a
 * FINISHED send (the preview already warns "already went today") — a deliberate second
 * send the same day is not a lost race.
 */
const racingClaims = (history, day, mine, now) => {
  const all = openClaimsAnyOrigin(history, day);
  const me = all.find((c) => c.id === mine);
  // Two DIFFERENT button levels never race: a person who sent reminder 1 and then, on the
  // same call, chooses reminder 2 a minute later meant both (the preview warned them).
  // The same level twice, or a button against the automatic run, is one race.
  const rival = (c) => !me || c.origin === me.origin || c.origin === 'auto' || me.origin === 'auto';
  return all.filter((c) => c.id === mine || (rival(c) && Number.isFinite(c.at) && c.at >= now - RACE_WINDOW_MS));
};
/** Failed tries of one origin on one day. */
const failedTries = (history, origin, day) => history.claims.filter((c) => c.origin === origin && c.day === day && c.failed).length;

/**
 * A client-facing send about documents in the last 24 hours, from the notes:
 * '' when none, else the reason (what and when). A staff-button reminder, the
 * rework batch email and the portal/intake email count. The AUTOMATIC reminder
 * never does — the once-per-day guard (the Toronto-day marker) governs it; counting
 * yesterday's 09:00 claim here made the "daily" email go every other day (review
 * 2026-11-07). "Escalation Last Notified" is not read here either: the escalation
 * engine stamps it on every matched rule (staff notifications, priority bumps), not
 * only on a client email — it is a preview warning for the buttons (previewWarnings).
 * @param {object[]} notes           [{ id, at, text }]
 * @param {object}   o               { now }
 */
function recentClientSend(notes, o = {}) {
  const now = o.now || io.now();
  const since = now - DAY;
  const fresh = (n) => Number.isFinite(n.at) && n.at >= since;
  const h = readReminderHistory(notes);
  const rem = h.sends.find((x) => fresh(x) && x.level !== 'auto');
  if (rem) return `a document reminder went (reminder ${rem.level}) at ${torontoTime(rem.at)}`;
  const rework = (notes || []).find((n) => fresh(n) && REWORK_NOTE_RE.test(n.text));
  if (rework) return `the client was emailed about a document to redo at ${torontoTime(rework.at)}`;
  const intake = (notes || []).find((n) => fresh(n) && INTAKE_NOTE_RE.test(n.text));
  if (intake) return `the portal email went to the client at ${torontoTime(intake.at)}`;
  return '';
}

/** The escalation engine's stamp is today or yesterday (Toronto)? '' when not, else the day. It may or may not have emailed the client. */
function recentEscalationStamp(escalationLastNotified, now) {
  const esc = s(escalationLastNotified).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(esc)) return '';
  const today = torontoDay(now);
  return esc === today || esc === dayPlus(today, -1) ? esc : '';
}

/**
 * Why the AUTOMATIC email must not go today, from the record alone: a reminder of
 * any origin already recorded for today, or another client send in the last 24 h
 * (a button reminder, the rework email, the portal email — never yesterday's own
 * automatic reminder). [] = clear. (The other automatic conditions — stage, %,
 * deadline — are the tick's.)
 */
function autoSkipReasons(notes, o = {}) {
  const now = o.now || io.now();
  const out = [];
  const today = sentOn(readReminderHistory(notes), torontoDay(now));
  if (today.length) out.push(`a document reminder already went today (${today.map((x) => (x.level === 'auto' ? 'automatic' : `reminder ${x.level}`)).join(', ')})`);
  const recent = recentClientSend(notes, { now });
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
 * @param {object} o  { history, level: 1|2|3, now, deadline: { actualDeadline }, recent: '' | reason, escalationLastNotified: 'YYYY-MM-DD'|'' }
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
  const escDay = recentEscalationStamp(o.escalationLastNotified, now);
  if (escDay) out.push(`The escalation engine ran on this case on ${fmtDay(escDay)} — it may have emailed the client`);
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
    // the newest automatic day + how many so far: a daily-chased case has one day per day, so the card can print "last <day> (n so far)" instead of the whole list
    autoLast: h.auto[0] ? { day: h.auto[0], label: fmtDay(h.auto[0]) } : null,
    autoCount: h.auto.length,
    failures: h.failures.slice(0, 3).map((f) => ({ day: f.day, label: fmtDay(f.day), reason: f.reason || '', at: Number.isFinite(f.at) ? new Date(f.at).toISOString() : '' })),
    // the newest attempt did not go out (no send since): the card says so
    lastFailed: Boolean(h.failures[0] && (!h.sends[0] || idNum(h.failures[0]) > idNum(h.sends[0]))),
  };
}

// ─── The staff buttons: preview + send ───────────────────────────────────────

const refuse = (status, reason, message) => Object.assign(new Error(message), { status, reason, refused: true });

/**
 * Plan §3b conditions 1–4 as the buttons apply them (one wording for the gate and the
 * card): a live case, not locked, not under Manual Override, at Document Collection
 * Started, Paid. { reason, message } of the first that fails, or null.
 */
function caseGateProblem(o) {
  if (!liveOrTest(o.group)) return { reason: 'not-a-case', message: `This row is in the "${s(o.group && o.group.title) || 'non-case'}" group, not a live case — no reminder is sent from here.` };
  if (/^yes$/i.test(s(o.automationLock))) return { reason: 'locked', message: 'Automation Lock is on for this case — reminders are off until it is cleared in Monday.' };
  if (/^yes$/i.test(s(o.manualOverride))) return { reason: 'override', message: 'Manual Override is on for this case — reminders are off until it is cleared in Monday.' };
  if (s(o.caseStage) !== DCS_STAGE) return { reason: 'not-dcs', message: `This case is at ${s(o.caseStage) || 'no stage'}, not Document Collection — reminders are for cases collecting documents.` };
  if (s(o.paymentStatus) !== 'Paid') return { reason: 'not-paid', message: `Payment Status is ${s(o.paymentStatus) || 'blank'}, not Paid — no reminder until the case is paid.` };
  return null;
}

/**
 * The gate the server applies to a staff send, from the case overview
 * (caseCockpitService.getCaseOverview — a fresh read on every request): the row
 * is a live case, not locked, not overridden, at Document Collection Started, Paid,
 * has a client email and an access code. Throws a refusal (status + reason) — the %
 * and the deadline are the staff's call.
 */
function gateStaff(overview) {
  const o = overview || {};
  if (o.cmUnavailable) throw refuse(503, 'cm-unavailable', 'Case data is temporarily unavailable — nothing was sent. Reload in a moment.');
  const problem = caseGateProblem(o);
  if (problem) throw refuse(409, problem.reason, problem.message);
  if (!s(o.clientEmail)) throw refuse(409, 'no-email', 'This case has no client email — nothing to send to.');
  if (!s(o.accessToken)) throw refuse(409, 'no-token', 'This case has no access code, so no portal link can be made — nothing was sent.');
}

/**
 * What the card needs to decide whether the buttons show (pure; the overview builds it).
 * notesLimit = how many notes the caller read (the newest N): the card then says
 * "Sent (recent notes)" — `recentNotes` — because an older send may sit beyond them.
 * docsUnavailable = the checklist read failed: named as such, never "no rows".
 * questionnaire = the overview's questionnaire facts ({ members, unavailable, mondayDone } — read
 * with the case, never a second read): the buttons also work when every document is in but the
 * questionnaire is unfinished; they are off only when both are complete.
 */
function describeForCase({ overview, items, notes, notesLimit, docsUnavailable, questionnaire }) {
  const o = overview || {};
  const h = readReminderHistory(notes || []);
  const base = { available: true, reason: '', message: '', canSend: true, blocked: '', recentNotes: Number(notesLimit) > 0 ? Number(notesLimit) : 0, ...historyView(h) };
  if (o.cmUnavailable) return { ...base, available: false, reason: 'cm-unavailable', message: 'Case data is temporarily unavailable — reload in a moment.', canSend: false };
  if (docsUnavailable) return { ...base, available: false, reason: 'docs-unavailable', message: 'The checklist could not be read just now — reload in a moment.', canSend: false };
  if (!s(o.clientEmail)) return { ...base, available: false, reason: 'no-email', message: 'No client email on the case — reminders cannot be sent.', canSend: false };
  if (!s(o.accessToken)) return { ...base, available: false, reason: 'no-token', message: 'No access code on the case — no portal link can be made, so no reminder.', canSend: false };
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { ...base, available: false, reason: 'no-rows', message: 'No checklist rows yet — there is nothing to remind the client about.', canSend: false };
  const missing = missingFromItems(rows);
  const q = questionnaireFromMembers(questionnaire !== undefined ? questionnaire : o.questionnaire);
  const qFacts = q ? { questionnaire: { done: q.done, unavailable: q.unavailable, notApplicable: q.notApplicable === true, pct: q.pct, pending: q.pending.length } } : {};
  if (!docsOpen(missing) && q && q.unavailable) return { ...base, ...qFacts, available: false, reason: 'q-unavailable', message: Q_UNREAD_ALL_IN, canSend: false };
  if (!docsOpen(missing) && !questionnaireOpen(q)) return { ...base, ...qFacts, available: false, reason: 'no-rows', message: q ? nothingToRemind(q) : 'Nothing is missing — every required document is in.', canSend: false };
  const problem = caseGateProblem(o);   // the same five checks as the send gate: the card shows the line, the buttons are off
  if (problem) return { ...base, ...qFacts, canSend: false, blocked: problem.message, missingCount: missing.count };
  return { ...base, ...qFacts, missingCount: missing.count };
}
const NOTHING_TO_REMIND = 'Every document is in and the questionnaire is complete — there is nothing to remind the client about.';
const NOTHING_NO_FORM = 'Every document is in, and this case type has no questionnaire — there is nothing to remind the client about.';
const nothingToRemind = (q) => (q && q.notApplicable ? NOTHING_NO_FORM : NOTHING_TO_REMIND);
const Q_UNREAD_ALL_IN = 'Every document is in, and the questionnaire progress could not be read just now — reload in a moment.';

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
  // the questionnaire facts came with the overview (a fresh case read on every request — no second read)
  const q = questionnaireFromMembers(overview.questionnaire);
  if (!docsOpen(missing)) {   // a row waiting for a new copy is something to remind about (review round 2 [2])
    // the card's own test (describeForCase): rows at all, N/A and optional ones included (review round 1 [4])
    if (!missing.rows) throw refuse(409, 'no-rows', 'No checklist rows yet — there is nothing to remind the client about.');
    if (q && q.unavailable) throw refuse(503, 'q-unavailable', 'Every document is in, and the questionnaire progress could not be read just now — nothing was sent. Reload in a moment.');
    if (!questionnaireOpen(q)) throw refuse(409, 'no-rows', q ? nothingToRemind(q) : 'Nothing is missing on the checklist — there is nothing to remind the client about.');
  }
  const notes = await readCaseNotes(overview.itemId, { now });
  const history = readReminderHistory(notes);
  const recent = recentClientSend(notes, { now });
  const deadline = overview.clientDeadlineRaw || {};
  const warnings = previewWarnings({ history, level, now, deadline, recent, escalationLastNotified: overview.escalationLastNotified });
  if (q && q.unavailable) warnings.push(Q_UNAVAILABLE_WARNING);
  return { caseRef, missing, q, notes, history, recent, deadline, warnings };
}

/**
 * GET preview: the template with every merge field filled except the ones the app
 * inserts itself ({MissingList}, {QuestionnaireList}, {PortalLink}, and on the final
 * {LastDay} — the date box in the dialog). A text without {QuestionnaireList} gets it
 * after {MissingList} when the questionnaire is unfinished (a warning says so).
 * Never sends, never writes.
 */
async function previewStaffReminder({ overview, level, lastDay, actor, now } = {}) {
  const t = now || io.now();
  const lv = parseLevel(level);
  const p = await prepareStaff({ overview, level: lv, now: t });
  const base = await templates.templateFor(lv);
  const dl = p.deadline;
  const values = {
    ClientName: s(overview.clientName) || 'Client', CaseRef: p.caseRef, CaseType: caseTypeText(overview.caseType) || 'immigration',
    MissingCount: String(p.missing.count), Deadline: dl.actualDeadline ? fmtDay(dl.actualDeadline) : 'not set',
    PromisedDate: dl.promisedSubmissionDate ? fmtDay(dl.promisedSubmissionDate) : 'not set', StaffName: senderName(actor),
  };
  const today = torontoDay(t);
  const last = lv === 3 ? (require('./deadlineService').cleanDay(lastDay) || dayPlus(today, FINAL_DEFAULT_DAYS)) : '';
  const tokensLeft = ['{MissingList}', Q_TOKEN, '{PortalLink}', ...(lv === 3 ? ['{LastDay}'] : [])];
  if (lv !== 3) values.LastDay = '';
  const qWarn = [];
  let body = base.body;
  if (questionnaireOpen(p.q) && !body.includes(Q_TOKEN)) { body = withQuestionnaireToken(body); qWarn.push(`The ${base.name} text has no {QuestionnaireList} — the unfinished questionnaire was added after the documents list.`); }
  if (p.q && p.q.notApplicable && mentionsQuestionnaire(base.subject, body)) qWarn.push(Q_NO_FORM_WARNING);
  return {
    level: lv,
    to: clientPortalService.maskEmail(overview.clientEmail),
    subject: fillTokens(base.subject, values).replace(/\s+/g, ' ').trim(),
    body: fillTokens(body, values),
    tokensLeft,
    missing: p.missing,
    missingList: missingListText(p.missing),
    missingCount: p.missing.count,
    questionnaire: questionnaireView(p.q),          // the dialog's read-only list (null = not given)
    questionnaireList: questionnaireListText(p.q),
    deadlineLine: dl.actualDeadline ? `Deadline ${fmtDay(dl.actualDeadline)}` : (dl.promisedSubmissionDate ? `Promised submission ${fmtDay(dl.promisedSubmissionDate)}` : 'No deadline on the case'),
    lastDay: last,
    minLastDay: today,
    // a board row that could not be used is said so (review 2026-11-07 [23]) — the dialog's amber line, never a silent fallback
    warnings: [...p.warnings, ...base.warnings, ...qWarn, ...(base.source === 'default' ? [templates.boardProblemFor(base.name)].filter(Boolean) : [])],
    template: { name: base.name, source: base.source },
    history: historyView(p.history),
  };
}

/** The final's "last day we will wait" as the send checks it ('' for reminders 1 and 2), or a 400 refusal. */
function finalLastDay(lv, lastDay, today) {
  if (lv !== 3) return '';
  const last = require('./deadlineService').cleanDay(lastDay);
  if (!last) throw refuse(400, 'bad-last-day', 'Enter the last day you will wait for the documents (a date).');
  if (last < today) throw refuse(400, 'bad-last-day', `The last day ${fmtDay(last)} is in the past.`);
  return last;
}

/**
 * The ONE place a staff reminder's email inputs are put together — the send and the
 * pop-up's live view (renderStaffReminder) both use it, so what staff see is the email.
 * The sign-off is the VERIFIED Monday sign-in (senderName), never a typed name.
 */
function staffEmailOptions({ overview, p, level, lastDay, subject, body, extra, actor, accessToken }) {
  return {
    level, caseRef: p.caseRef, clientName: overview.clientName, clientEmail: overview.clientEmail, caseType: overview.caseType,
    accessToken, missing: p.missing, deadline: p.deadline, lastDay,
    staffName: senderName(actor), extraLine: extra, subjectOverride: subject, bodyOverride: body,
    questionnaire: overview.questionnaire,
  };
}

// ─── The pop-up's live view of the email (Faran 2026-11-07) ──────────────────
// "display the email in the popup so that Mahesh or any team member who is sending
// it can review or edit it before sending". The view is built by the SAME code as the
// send, from the same fresh list — but with a stand-in access code, and every link
// switched off, so the page never holds the client's working link.

const PREVIEW_TOKEN = 'preview-only';
const LINK_NOTE = 'switched off in this preview';

/**
 * The email html made safe to show staff: the client's code (if it ever got in) replaced by
 * the stand-in, every link address taken out (data-link-note says why), and anything that could
 * run or navigate taken out — scripts, on* handlers, forms, frames, base, meta refresh. The
 * email has none of these (the tests assert it); this is the belt to the iframe's braces.
 * Attributes are only touched INSIDE tags: the staff's own text is escaped, so a typed
 * "one=two" is text and stays as typed.
 */
function previewSafeHtml(html, { token } = {}) {
  let h = String(html == null ? '' : html);
  const tk = s(token);
  if (tk.length >= 6) h = h.split(encodeURIComponent(tk)).join(PREVIEW_TOKEN).split(tk).join(PREVIEW_TOKEN);
  h = h.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?(?:script|iframe|frame|object|embed|base|form)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '');
  return h.replace(/<[a-z][^>]*>/gi, (tag) => tag
    .replace(/\s(?:on[a-z]+|action|formaction|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // the href is taken OUT (not set to "#"): a link with no address cannot be tabbed to inside the frame.
    // That alone is not enough — a mouse click in the email still moves the keyboard into the frame, so
    // the pop-up hands focus straight back when the frame gets it (adminCase.js remDialog, review round 2)
    .replace(/\shref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ` data-link-note="${LINK_NOTE}"`));
}

/**
 * POST render: the finished email for the pop-up — read-only (no note, no email, no
 * cool-down; it reads the case's list and notes exactly as a preview does). The gate keeps
 * its refusals (409 / 503); a text that cannot go yet — reply wording, the final's last day
 * blank or past, an unknown level, an empty subject or text — is an answer, not an error:
 * { ok: true, html: '', problems: [...] }, so the pop-up shows it while staff type.
 */
async function renderStaffReminder({ overview, level, subject, body, extra, lastDay, actor, now } = {}) {
  const t = now || io.now();
  gateStaff(overview);
  const problem = (message) => ({ ok: true, html: '', subject: '', warnings: [], problems: [message] });
  let lv, last;
  try { lv = parseLevel(level); last = finalLastDay(lv, lastDay, torontoDay(t)); }
  catch (err) { if (err.refused && err.status === 400) return problem(err.message); throw err; }
  // the dialog never sends an empty box (remSend says so) — the view says it too, never the board text in its place
  if (!s(subject)) return problem('The subject is empty.');
  if (!s(body)) return problem('The text is empty.');
  const p = await prepareStaff({ overview, level: lv, now: t });
  let email;
  try { email = await buildReminderEmail(staffEmailOptions({ overview, p, level: lv, lastDay: last, subject, body, extra, actor, accessToken: PREVIEW_TOKEN })); }
  catch (err) { return problem(err.message); }
  return { ok: true, html: previewSafeHtml(email.html, { token: overview.accessToken }), subject: email.subject, warnings: email.warnings || [], problems: [] };
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
  const last = finalLastDay(lv, lastDay, today);
  const p = await prepareStaff({ overview, level: lv, now: t });
  const origin = ORIGIN_OF[lv];
  if (failedTries(p.history, origin, today) >= MAX_TRIES) throw refuse(409, 'max-tries', `This reminder did not go out ${MAX_TRIES} times today — the email system is having a temporary problem. Please try again tomorrow, or email the client by hand.`);
  let email;
  try {
    email = await buildReminderEmail(staffEmailOptions({ overview, p, level: lv, lastDay: last, subject, body, extra, actor, accessToken: overview.accessToken }));
  } catch (err) { throw refuse(400, 'bad-text', err.message); }

  // 1. The claim — the record that this reminder is going out (before the email).
  let mine;
  try {
    mine = await io.postNote(overview.itemId, claimNote({ level: lv, to: email.to, actor: actor && actor.name, count: p.missing.count, questionnaire: questionnaireOpen(p.q), lastDay: last, now: t, day: today }));
  } catch (err) { throw refuse(503, 'note-failed', `The note could not be saved on the case (${s(err.message).slice(0, 120)}) — nothing was sent. Try again in a minute.`); }

  // 2. Only the earliest open claim of the last few minutes sends (a second app
  //    instance, a second person, or the automatic run may have claimed a reminder
  //    for this client in the same seconds — any origin counts). An earlier FINISHED
  //    send today is not a competitor — a deliberate second send goes out (the preview warned).
  try {
    const after = readReminderHistory(await io.readNotes(overview.itemId, 1));
    const open = racingClaims(after, today, mine, io.now());
    if (open.length && open[0].id !== mine && open.some((x) => x.id === mine)) {
      await Promise.resolve(io.deleteNote(mine)).catch(() => {});
      throw refuse(409, 'lost-race', 'A document reminder is going to this client right now (someone else, or the automatic run) — nothing was sent twice. Reload the page in a moment.');
    }
  } catch (err) { if (err.refused) throw err; /* cannot re-read: our claim stands, send */ }

  // 3. The email.
  try {
    await io.sendEmail({ to: email.recipient, subject: email.subject, html: email.html, ...(email.replyTo ? { replyTo: email.replyTo } : {}) });
  } catch (err) {
    io.warn(`[DocReminders] ${p.caseRef}: reminder ${lv} did not go out: ${err.message}`);
    await Promise.resolve(io.postNote(overview.itemId, failureNote({ level: lv, reason: 'the email could not be sent', now: io.now(), day: today, claimId: mine })))
      .catch((e) => io.warn(`[DocReminders] failure note also failed for ${p.caseRef}: ${e.message}`));
    throw Object.assign(new Error('The email could not be sent — please try again in a moment.'), { status: 502, reason: 'send-failed', sendFailed: true });
  }
  io.log(`[DocReminders] ${p.caseRef}: reminder ${lv} sent to ${email.to} by ${s(actor && actor.name) || 'staff'}`);
  return { ok: true, noted: true, noteId: mine, to: email.to, warnings: email.warnings, level: lv, day: today, lastDay: last };
}

// ─── The automatic daily email (step C) ──────────────────────────────────────
//
// Plan §3a: once a day, at DOC_REMINDERS_HOUR Toronto, every live case at Document
// Collection Started that is Paid, not locked, has a REAL deadline at least 4 days
// away, documents under 50 % (the stored number AND a live recount), at least one
// missing document, an email and an access code, no reminder of any origin today,
// no other client email in 24 h, documents started 3+ days ago and no upload today
// or yesterday — gets the "Automatic" template with the missing list. The record is
// the same claim / failure note pair as the buttons (origin "auto"). The switch
// DOC_REMINDERS_AUTO ships OFF, and OFF means no read at all from the tick;
// DOC_REMINDERS_ONLY (comma list of case refs) is the first-days allow-list;
// DOC_REMINDERS_IMAGINARY adds the imaginary-deadline branch (every 3rd day).

const envFlag = (name) => { const v = s(process.env[name]).toLowerCase(); return v === '1' || v === 'true'; };
/** DOC_REMINDERS_IMAGINARY — the imaginary-deadline branch. OFF unless exactly "1"/"true". */
function isImaginaryEnabled() { return envFlag('DOC_REMINDERS_IMAGINARY'); }
/** DOC_REMINDERS_ONLY — case refs allowed to be emailed (empty = every case). */
function allowList() { return s(process.env.DOC_REMINDERS_ONLY).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); }
/** DOC_REMINDERS_HOUR — the Toronto hour of the daily run (0–23), default 9. */
function autoHour() { const raw = s(process.env.DOC_REMINDERS_HOUR); const n = Number(raw); return /^\d{1,2}$/.test(raw) && n <= 23 ? n : 9; }
const FIRST_AUTO_AFTER_DAYS = 3;     // no automatic reminder in the first days after documents start (the portal email just went)
const DEADLINE_MIN_DAYS = 4;         // 3 days or less (or past) is a phone call, not an email (listed under Needs attention)
const IMAGINARY_EVERY_DAYS = 3;      // the imaginary branch's cadence (nobody set one — never daily)
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** One Cases-board row as the selector reads it. */
function parseAutoRow(item) {
  const cv = {};
  for (const c of (item && item.column_values) || []) cv[c.id] = s(c.text);
  const col = (k) => s(cv[AUTO_COLS[k]]);
  return {
    id: s(item && item.id), name: s(item && item.name), group: (item && item.group) || null,
    ref: col('ref'), caseType: col('caseType'), stage: col('stage'), payment: col('payment'),
    lock: col('lock'), override: col('override'),
    deadlineType: col('deadlineType'), actualDeadline: col('actualDeadline').slice(0, 10), promised: col('promised').slice(0, 10),
    docUploaded: col('docUploaded'), email: col('email'), token: col('token'),
    stageStart: col('stageStart').slice(0, 10), lastActivity: col('lastActivity').slice(0, 10),
    qStatus: col('qStatus'),
  };
}

/**
 * PURE — the column-only conditions (plan §3a 1–6a, 8, 11, 12 and the allow-list),
 * in the order that costs nothing. Returns { decision: 'skip'|'attention'|'candidate',
 * reason, variant }; the notes, the checklist and the live recount come after.
 */
function selectByColumns(row, { today, imaginary = false, only = [] } = {}) {
  const skip = (reason) => ({ decision: 'skip', reason });
  const yes = (v) => /^yes$/i.test(s(v));
  if (!row.ref) return skip('no case number');
  const listed = only.length > 0 && only.includes(row.ref.toUpperCase());
  if (only.length && !listed) return skip('not on the allow-list (DOC_REMINDERS_ONLY)');
  if (!isCaseGroup(row.group) && !(listed && isTestGroup(row.group))) return skip(`in the "${s(row.group && row.group.title) || 'non-case'}" group, not a live case`);
  if (row.stage !== DCS_STAGE) return skip(`not at Document Collection Started (${row.stage || 'blank'})`);
  if (row.payment !== 'Paid') return skip(`Payment Status is ${row.payment || 'blank'}, not Paid`);
  if (yes(row.lock)) return skip('Automation Lock is Yes');
  if (yes(row.override)) return skip('Manual Override is Yes');
  if (!row.email) return skip('no client email');
  if (!row.token) return skip('no access code — no portal link can be made');
  const pct = row.docUploaded === '' ? null : Number(row.docUploaded);
  if (pct == null || !Number.isFinite(pct)) return skip('Documents Uploaded % has never been computed');
  if (pct >= 50) return skip(`documents at ${pct} % (50 % or more)`);
  let variant;
  if (row.deadlineType === 'Deadline') {
    if (!isDay(row.actualDeadline)) return { decision: 'attention', reason: 'deadline type is Deadline but the date is blank — set the date on the case' };   // a person fixes the record; never a silent daily skip
    const n = daysUntil(row.actualDeadline, today);
    if (n < DEADLINE_MIN_DAYS) return { decision: 'attention', reason: n < 0 ? `deadline passed on ${fmtDay(row.actualDeadline)} — no email; a person should call (listed under Needs attention)` : `deadline in ${n} day${n === 1 ? '' : 's'} (${fmtDay(row.actualDeadline)}) — no email; a person should call (listed under Needs attention)` };
    variant = 'real';
  } else if (row.deadlineType === 'Imaginary') {
    if (!imaginary) return skip('imaginary deadline — the imaginary branch is off (DOC_REMINDERS_IMAGINARY)');
    if (!isDay(row.promised)) return skip('imaginary deadline with no promised submission date');
    const n = daysUntil(row.promised, today);   // a promised date that has gone, or is days away, is never emailed as a plan (review round 2 [3])
    if (n < DEADLINE_MIN_DAYS) return { decision: 'attention', reason: n < 0 ? `promised submission date passed on ${fmtDay(row.promised)} — no email; update the promised date on the client's record (listed under Needs attention)` : `promised submission date in ${n} day${n === 1 ? '' : 's'} (${fmtDay(row.promised)}) — no email; update the promised date on the client's record or call the client (listed under Needs attention)` };
    variant = 'imaginary';
  } else {
    return skip('no deadline recorded on the case (listed under Needs attention)');
  }
  if (!isDay(row.stageStart)) return skip('Stage Start Date is blank');
  const started = -daysUntil(row.stageStart, today);
  if (started < FIRST_AUTO_AFTER_DAYS) return skip(`documents started ${started} day${started === 1 ? '' : 's'} ago — the first automatic reminder waits ${FIRST_AUTO_AFTER_DAYS} days`);
  if (isDay(row.lastActivity) && (row.lastActivity === today || row.lastActivity === dayPlus(today, -1))) return skip(`the client uploaded ${row.lastActivity === today ? 'today' : 'yesterday'}`);
  return { decision: 'candidate', reason: '', variant, pct };
}

/** The per-case reads and the send (or the dry-run answer) for one column-selected candidate. */
async function runCandidate(row, sel, { now, today, dryRun }) {
  const out = { caseRef: row.ref, itemId: row.id, client: row.name, variant: sel.variant, pct: sel.pct, deadline: sel.variant === 'imaginary' ? row.promised : row.actualDeadline };
  const skip = (reason) => ({ ...out, decision: 'skip', reason });
  // the record: once a day of any origin, no other client email in 24 h, the imaginary cadence, failed tries
  const notes = await readCaseNotes(row.id, { now });
  const blocks = autoSkipReasons(notes, { now });
  if (blocks.length) return skip(blocks.join('; '));
  const history = readReminderHistory(notes);
  if (sel.variant === 'imaginary' && history.auto[0] && -daysUntil(history.auto[0], today) < IMAGINARY_EVERY_DAYS) return skip(`imaginary cadence: an automatic reminder went on ${fmtDay(history.auto[0])} (every ${IMAGINARY_EVERY_DAYS}rd day)`);
  if (failedTries(history, 'auto', today) >= MAX_TRIES) return skip(`did not go out ${MAX_TRIES} times today — not tried again until tomorrow`);
  // the checklist: at least one missing required document
  const missing = await missingDocuments(row.ref);
  out.missing = missing.count;
  if (!missing.count) return skip(missing.progress.total ? `nothing missing on the checklist (${missing.progress.received} of ${missing.progress.total} received)` : 'no checklist rows — seed the checklist from the case page');
  // the live recount: the stored number may be stale
  let live;
  try { live = await io.liveUploadedPct(row.ref, row.id); }
  catch (err) { return skip(`the documents could not be recounted (${s(err.message).slice(0, 120)})`); }
  out.livePct = live;
  if (live == null) return skip('the checklist could not be recounted (no rows came back, though the list showed some missing) — tried again tomorrow');
  if (live >= 50) return skip(`the live recount says ${live} % (the board said ${sel.pct} %) — 50 % or more`);
  if (dryRun) return { ...out, decision: 'would-send', reason: `${missing.count} missing, ${live} % uploaded, ${sel.variant === 'imaginary' ? 'promised' : 'deadline'} ${fmtDay(out.deadline)}` };

  // the questionnaire (one read per candidate): a read failure never holds the email up — it goes without the questionnaire block
  const qState = await Promise.resolve().then(() => io.questionnaireState(row.ref)).catch((err) => ({ members: [], unavailable: true, error: s(err && err.message) }));
  const questionnaire = { members: (qState && qState.members) || [], unavailable: !qState || qState.unavailable === true, mondayDone: row.qStatus === 'Done',
    notApplicable: Boolean(qState && qState.notApplicable === true), embedsAllMembers: Boolean(qState && qState.embedsAllMembers === true) };
  if (questionnaire.unavailable && !(row.qStatus === 'Done')) io.warn(`[DocReminders] ${row.ref}: the questionnaire could not be read${qState && qState.error ? ` (${qState.error})` : ''} — the reminder goes without it`);
  const qOpen = questionnaireOpen(questionnaireFromMembers(questionnaire));

  // the email (built first — a text problem must never leave a claim note behind)
  let email;
  try {
    email = await buildReminderEmail({
      level: 'auto', variant: sel.variant, caseRef: row.ref, clientName: row.name, clientEmail: row.email, caseType: row.caseType, accessToken: row.token,
      missing, deadline: { type: row.deadlineType, actualDeadline: row.actualDeadline, promisedSubmissionDate: row.promised }, staffName: 'TDOT Immigration',
      questionnaire,
    });
  } catch (err) { return { ...out, decision: 'error', reason: `the email could not be built: ${s(err.message).slice(0, 160)}` }; }
  // 1. the claim (the record, before the email)
  let mine;
  try {
    mine = await io.postNote(row.id, claimNote({ level: 'auto', to: email.to, count: missing.count, deadline: fmtDay(out.deadline), pct: live, questionnaire: qOpen, now: io.now(), day: today }));
  } catch (err) { return { ...out, decision: 'error', reason: `the note could not be saved on the case — nothing sent (${s(err.message).slice(0, 120)})` }; }
  // 2. the earliest open claim of the last few minutes sends (two app instances, or a staff
  //    button pressed in the same seconds — any origin)
  try {
    const after = readReminderHistory(await io.readNotes(row.id, 1));
    const open = racingClaims(after, today, mine, io.now());
    if (open.length && open[0].id !== mine && open.some((x) => x.id === mine)) {
      await Promise.resolve(io.deleteNote(mine)).catch(() => {});
      return { ...out, decision: 'lost-race', reason: open[0].level === 'auto' ? 'another instance is sending this reminder right now — nothing sent twice' : `a staff reminder (reminder ${open[0].level}) is going to the client right now — nothing sent twice` };
    }
  } catch (_) { /* cannot re-read: our claim stands, send */ }
  // 3. the email
  try {
    await io.sendEmail({ to: email.recipient, subject: email.subject, html: email.html, ...(email.replyTo ? { replyTo: email.replyTo } : {}) });
  } catch (err) {
    io.warn(`[DocReminders] ${row.ref}: the automatic reminder did not go out: ${err.message}`);
    await Promise.resolve(io.postNote(row.id, failureNote({ level: 'auto', reason: 'the email could not be sent', now: io.now(), day: today, claimId: mine })))
      .catch((e) => io.warn(`[DocReminders] failure note also failed for ${row.ref}: ${e.message}`));
    return { ...out, decision: 'failed', reason: 'the email could not be sent (noted on the case; listed under Needs attention)' };
  }
  io.log(`[DocReminders] ${row.ref}: automatic reminder sent to ${email.to} (${missing.count} missing, ${live} %, ${sel.variant})`);
  return { ...out, decision: 'sent', reason: `${missing.count} missing, ${live} % uploaded`, noteId: mine };
}

let _running = false, _previewing = false;   // a preview never holds up the daily run

/**
 * The daily run (or, with dryRun, the preview: every row's decision and reason, nothing
 * sent, nothing written). With the switch OFF a real run returns { off: true } before
 * any read; a dry run still reads so the Engine Controls preview can be checked before
 * the switch is flipped.
 *
 * @returns {Promise<{ ok: boolean, off?: boolean, enabled: boolean, dryRun: boolean, skipped?: string, checked?: number,
 *   candidates?: object[], sent?: number, failed?: number, attention?: number, error?: string }>}
 */
async function runDocReminders({ dryRun = false, reason = '' } = {}) {
  const enabled = isAutoEnabled();
  if (!enabled && !dryRun) return { ok: true, off: true, enabled, dryRun, skipped: 'switched off (DOC_REMINDERS_AUTO)' };
  if (dryRun ? _previewing : _running) return { ok: true, enabled, dryRun, skipped: `a ${dryRun ? 'preview' : 'run'} is already in progress` };
  if (dryRun) _previewing = true; else _running = true;
  const startedAt = io.now();
  try {
    const now = io.now(), today = torontoDay(now);
    const opts = { today, imaginary: isImaginaryEnabled(), only: allowList() };
    let rows;
    try { rows = (await io.listDcsRows()).map(parseAutoRow); }
    catch (err) { io.warn(`[DocReminders] the Cases board could not be read: ${err.message}`); return { ok: false, enabled, dryRun, error: err.message }; }
    const candidates = [];
    for (const row of rows) {
      const sel = selectByColumns(row, opts);
      if (sel.decision !== 'candidate') { candidates.push({ caseRef: row.ref, itemId: row.id, client: row.name, decision: sel.decision, reason: sel.reason }); continue; }
      candidates.push(await runCandidate(row, sel, { now, today, dryRun }).catch((err) => ({ caseRef: row.ref, itemId: row.id, client: row.name, decision: 'error', reason: s(err.message).slice(0, 200) })));
    }
    // the Reminder Templates board's state rides on the answer (review 2026-11-07 [23]): a row that
    // could not be used is named in the Engine Controls preview — a cached load, no read when the env is unset
    await templates.loadTemplates().catch((err) => io.warn(`[DocReminders] templates: ${err.message}`));
    const templateProblems = templates.boardProblems();
    const count = (d) => candidates.filter((x) => x.decision === d).length;
    const sent = count('sent'), failed = count('failed') + count('error'), attention = count('attention');
    io.log(`[DocReminders] ${dryRun ? 'preview' : 'run'}${reason ? ` (${reason})` : ''}: ${rows.length} row(s) at Document Collection, ${dryRun ? `${count('would-send')} would be emailed` : `${sent} emailed`}, ${attention} for a person, ${failed} problem(s), ${Math.round((io.now() - startedAt) / 1000)}s`);
    return { ok: true, enabled, dryRun, imaginary: opts.imaginary, allowList: opts.only, hour: autoHour(), today, checked: rows.length, candidates, sent, failed, attention, wouldSend: count('would-send'), templateProblems, tookMs: io.now() - startedAt };
  } finally { if (dryRun) _previewing = false; else _running = false; }
}

module.exports = {
  isAutoEnabled,
  // the automatic run
  runDocReminders, selectByColumns, parseAutoRow, isImaginaryEnabled, allowList, autoHour, isTorontoHour, AUTO_COLS,
  missingDocuments,
  missingFromItems,
  questionnaireFromMembers,
  buildReminderEmail,
  // the record
  io, claimNote, failureNote, parseNote, rawNotes, readReminderHistory, readCaseNotes, recentClientSend, recentEscalationStamp, autoSkipReasons, previewWarnings, historyView,
  sentOn, openClaims, openClaimsAnyOrigin, racingClaims, failedTries, isCaseGroup, describeForCase, caseGateProblem,
  // the staff buttons
  gateStaff, parseLevel, senderName, previewStaffReminder, sendStaffReminder, renderStaffReminder, previewSafeHtml, PREVIEW_TOKEN,
  NOTE_HEAD, NOTE_HEAD_TEXT, NOT_CASE_GROUPS, MAX_TRIES, NOTES_PAGE, NOTES_MAX_PAGES, FINAL_DEFAULT_DAYS, RACE_WINDOW_MS,
  // pure — exported for tests
  _internal: { fmtDay, oneLine, fillTokens, missingListText, missingListHtml, LEVEL_NAMES, torontoDay, dayPlus, daysUntil, marker, failMarker, dayFromWords, imaginaryBody, IMAGINARY_LEAD, caseTypeText,
    questionnaireListHtml, questionnaireListText, questionnaireOpen, questionnaireView, withQuestionnaireToken, Q_UNAVAILABLE_WARNING, Q_NO_FORM_WARNING, mentionsQuestionnaire, NOTHING_TO_REMIND, NOTHING_NO_FORM },
};
