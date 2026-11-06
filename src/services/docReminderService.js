'use strict';

/**
 * Document-collection reminders (team meeting 2026-11-05, block 2):
 * the missing-documents list and the reminder email itself.
 *
 * This half is pure building — no Monday writes, no sending. The staff buttons
 * (one click per level, preview, edit, send) and the automatic daily email under
 * 50 % uploaded for a real deadline sit on top of it in later steps; the proof-by-
 * notes record is theirs too. The one Monday READ here is the case's checklist
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
 *  - no nested <p>; never "just reply" (src/utils/clientContact.js).
 */

const documentFormService = require('./documentFormService');
const clientPortalService = require('./clientPortalService');
const templates = require('./docReminderTemplates');
const { LOGO_URL } = require('../branding');
const { memberTypeOfLabel } = require('../utils/familyRoleLabels');

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

module.exports = {
  isAutoEnabled,
  missingDocuments,
  missingFromItems,
  buildReminderEmail,
  // pure — exported for tests
  _internal: { fmtDay, oneLine, fillTokens, missingListText, missingListHtml, LEVEL_NAMES },
};
