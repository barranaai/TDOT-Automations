'use strict';

/**
 * Sponsor onboarding — the in-Canada partner's own portal email.
 *
 * A SOWP, spousal-sponsorship, Supervisa or visitor case names a second person
 * whose documents and answers the application needs: the worker spouse, the
 * sponsoring spouse, the inviter. Until now only the principal applicant was
 * emailed; the sponsor found out second-hand, and their document lines sat
 * "Missing" under a heading nobody had explained to them.
 *
 * This service sends that person the SAME portal link the client received,
 * with their own document list and which questionnaire section is theirs, and
 * — where the form has a per-member section — makes sure the section exists:
 * a Family Members row (so the checklist seeder and the manifest seed agree)
 * and, when the questionnaire manifest already exists, a manifest member.
 *
 * Shape (the paymentUndoService pattern):
 *   - resolveSponsor / existingPartner / planEnsure / buildSponsorEmail — PURE.
 *     Every judgement lives here, so the tests can pin it without Monday.
 *   - io — every side effect behind ONE seam the tests replace wholesale.
 *   - ensureSponsor — all reads first; any read failure returns
 *     { reason:'transient' } and touches nothing. Writes in this order: lead
 *     (a typed inviter) → row → manifest member → marker 'pending' (a lock) →
 *     email → marker 'sent' → note. The automatic path creates the row and the
 *     member only on the pass that sends; before payment that is 'prepare'.
 *   - describe — the cockpit's read-only view.
 *
 * Identity (D1): the SINGLE claiming lead's Inviter / Sponsor name and email.
 * Zero leads or a shared case (two leads on one case) fails closed — the
 * sponsor cannot be identified safely, so nothing is created or sent.
 *
 * Never a pronoun in anything the sponsor reads — names only.
 */

const crypto            = require('crypto');
const leadService       = require('./leadService');
const mondayApi         = require('./mondayApi');
const mail              = require('./microsoftMailService');   // module reference, so tests can stub sendEmail
const oneDrive          = require('./oneDriveService');
const caseSchemaService = require('./caseSchemaService');
const { resolveMemberTypes, formEmbedsMembers } = require('../../config/questionnaireFormMap');
const { BASE_URL, EMAIL_REPLY_TO, STAGES_REQUIRING_RESEND, maskAddr } = require('./emailService');
const { LOGO_URL } = require('../branding');

const CM = {
  caseRef:                  'text_mm142s49',
  caseType:                 'dropdown_mm0xd1qn',
  caseSubType:              'dropdown_mm0x4t91',
  clientEmail:              'text_mm0xw6bp',
  accessToken:              'text_mm0x6haq',
  caseStage:                'color_mm0x8faa',
  paymentStatus:            'color_mm0x9fnn',
  checklistTemplateApplied: 'color_mm0xs7kp',
};

const MARKER_VERSION          = 1;
const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';          // same subfolder as the member manifest
const PENDING_STALE_MS        = 10 * 60 * 1000;           // a 'pending' older than this is a crashed send, not a lock
const STAFF_COOLDOWN_MS       = 60 * 1000;                // the route's per-case cool-down on staff sends
const EMAIL_RE                = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;   // the retainer panel's regex
const NAME_MAX                = 80;
const MODES                   = ['prepare', 'onboard', 'staff'];

// Schema role → the Family Members board type / the questionnaire manifest type
// (D4). The board type follows the ROLE, never the label: 'Worker Spouse' is a
// role no schema has.
const ROLE_TO_BOARD_TYPE  = { Sponsor: 'Sponsor', Spouse: 'Spouse' };
const ROLE_TO_MEMBER_KEY  = { Sponsor: 'sponsor', Spouse: 'spouse' };
const ROLE_TO_PORTAL_TYPE = { Sponsor: 'Sponsor', Spouse: 'Spouse / Common-Law Partner' };
// A board member that already IS the sponsor (D5), by role → the generic label
// used when its row still carries the intake placeholder name.
const ROLE_GENERIC_LABEL  = { Sponsor: 'Sponsor', Spouse: 'Spouse', WorkerSpouse: 'Worker Spouse' };

const s = (v) => String(v == null ? '' : v).trim();
const lower = (v) => s(v).toLowerCase();
const clean = (v) => leadService.stripInvisibles(v).trim();
// A fingerprint of the address for the marker (never the address itself): two
// sponsors can share a mask ('f***@example.com'), never a key.
const emailKeyOf = (email) => crypto.createHash('sha256').update(lower(email)).digest('hex').slice(0, 16);
// The board roles the questionnaire manifest seeds a section for (the
// questionnaire service's ROLE_TO_PORTAL_TYPE keys).
const PORTAL_ROLES = new Set(['Spouse', 'DependentChild', 'Sponsor', 'WorkerSpouse', 'Parent', 'Sibling']);
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const markerFilename = (caseRef) => `sponsor-onboarding-${caseRef}.json`;

function isEnabled() {
  const v = lower(process.env.SPONSOR_ONBOARDING);
  return v === 'true' || v === '1';
}

/** "12 Sep 2026, 2:03 pm" in Toronto — the wording the notes and the cockpit share. */
function torontoTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d)) parts[p.type] = p.value;
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${lower(parts.dayPeriod)}`;
}

/* ─────────────────────────────── PURE ─────────────────────────────── */

/**
 * The schema role that is the in-Canada partner (D2): a REQUIRED non-PA role
 * that is 'Sponsor', or 'Spouse' labelled "Worker Spouse" (SOWP inland). Study
 * Permit's optional Sponsor (includeWhen) is not one — that is a funds
 * supporter, not a co-applicant.
 */
function sponsorRoleOf(schema) {
  if (!schema || !Array.isArray(schema.roles)) return null;
  return schema.roles.find((r) => r && r.required === true && r.role !== 'PrincipalApplicant' &&
    (r.role === 'Sponsor' || (r.role === 'Spouse' && /worker spouse/i.test(r.label || '')))) || null;
}

/**
 * PURE. Who the sponsor is, what the schema wants from them, and how the
 * questionnaire places them.
 *
 * @returns {{ status:'none', reason:string, claimantCount:number } | { status:'ok', ... }}
 *   reasons: 'sub-type-missing' | 'no-schema' | 'not-applicable' | 'no-lead' |
 *            'shared-case' | 'no-inviter' | 'same-as-client'
 */
function resolveSponsor({ claimants, clientEmail = null, caseType, caseSubType, schema, memberTypes, embedsAllMembers } = {}) {
  const claimantCount = Array.isArray(claimants) ? claimants.length : 0;
  const none = (reason) => ({ status: 'none', reason, claimantCount });

  // The case type first: a type with no sponsor role has nothing to say about
  // leads or inviters, and the cockpit hides the card on 'not-applicable' —
  // a CEC case with no inviter must not show a "no sponsor on file" form.
  if (schema == null) return none(s(caseSubType) ? 'no-schema' : 'sub-type-missing');
  const roleDef = sponsorRoleOf(schema);
  if (!roleDef) return none('not-applicable');

  if (claimantCount === 0) return none('no-lead');
  if (claimantCount > 1) return none('shared-case');
  const lead = claimants[0] || {};
  const name  = clean(lead.inviterName);
  const email = clean(lead.inviterEmail);
  if (!name || !EMAIL_RE.test(email)) return none('no-inviter');
  const client = clean(clientEmail);
  if (client && email.toLowerCase() === client.toLowerCase()) return none('same-as-client');

  const roleLabel = s(roleDef.label) || roleDef.role;
  const docs = (roleDef.documents || []).filter((d) => d && !d.includeWhen).map((d) => ({ name: d.name, category: d.category || 'Other' }));
  const types = Array.isArray(memberTypes) ? memberTypes : [];
  const sectionMode = embedsAllMembers ? 'shared-form'
    : (types.includes('Worker Spouse') || types.includes('Sponsor')) ? 'section'
    : 'documents-only';
  return {
    status: 'ok',
    leadId: s(lead.id),
    name: name.slice(0, NAME_MAX),
    email,
    emailMasked: maskAddr(email),
    emailKey: emailKeyOf(email),
    phone: clean(lead.inviterPhone),
    role: roleDef.role,
    roleLabel,
    docs,
    sectionMode,
    boardMemberType: ROLE_TO_BOARD_TYPE[roleDef.role],
    memberKey: ROLE_TO_MEMBER_KEY[roleDef.role],
    manifestType: ROLE_TO_PORTAL_TYPE[roleDef.role],
    sponsorIsSpouse: /spouse|partner/i.test(roleLabel),
    caseType: s(caseType),
    caseSubType: s(caseSubType),
    claimantCount,
  };
}

/**
 * PURE. The Family Members row that already represents the sponsor, or null
 * (D5): same role; the legacy 'Worker Spouse' type; or — only when the sponsor
 * IS the spouse — the intake's Spouse row OR a Sponsor row (a Sub Type
 * corrected from Outland to Inland leaves the same person typed 'Sponsor';
 * no SOWP inland schema has a Sponsor role, so that row can only be them).
 * For a sponsor who is not the spouse (a child in Canada inviting parents) a
 * Spouse row is the PA's spouse.
 */
function existingPartner(sponsor, composition) {
  const members = (composition && Array.isArray(composition.members)) ? composition.members : [];
  return members.find((m) => m && m.role === sponsor.role)
    || members.find((m) => m && m.role === 'WorkerSpouse')
    || (sponsor.sponsorIsSpouse ? members.find((m) => m && (m.role === 'Spouse' || m.role === 'Sponsor')) : null)
    || null;
}

/** The manifest member that already is the sponsor's section, or null. */
function manifestMember(sponsor, manifest) {
  if (!Array.isArray(manifest)) return null;
  return manifest.find((m) => m && (m.type === 'Sponsor' || m.type === 'Worker Spouse' ||
    (sponsor.sponsorIsSpouse && m.type === 'Spouse / Common-Law Partner'))) || null;
}

/** The heading the sponsor's questionnaire section carries (or will carry). */
function sectionLabelFor(sponsor, composition, manifest) {
  const mm = manifestMember(sponsor, manifest);
  if (mm && s(mm.label)) return s(mm.label);
  const partner = existingPartner(sponsor, composition);
  if (partner) {
    const name = s(partner.name);
    if (name && !/\(from intake\)/i.test(name)) return name;
    return ROLE_GENERIC_LABEL[partner.role] || sponsor.boardMemberType;
  }
  return sponsor.name;
}

/**
 * The mark the sponsor's section carries on the questionnaire page — the
 * engine prints the member TYPE's first word ('Spouse' for 'Spouse /
 * Common-Law Partner'). So the badge follows the section that actually exists:
 * the manifest member, else the board row that is the sponsor (the intake's
 * Spouse row seeds a 'Spouse' section even on SOWP Outland), else the type the
 * sponsor's own section will carry.
 */
function badgeFor(sponsor, composition, manifest) {
  const mm = manifestMember(sponsor, manifest);
  if (mm && s(mm.type)) return s(mm.type).split(' / ')[0];
  const partner = existingPartner(sponsor, composition);
  if (partner) return ROLE_GENERIC_LABEL[partner.role] || sponsor.boardMemberType;
  return sponsor.boardMemberType;
}

/**
 * PURE. Whether the marker's sends went to a DIFFERENT person than the lead
 * now names (the sponsor was replaced in the retainer panel after a send).
 * That person was never emailed: no "resend", no "Emailed …" on the card.
 * Compared by the address fingerprint; older markers without one fall back to
 * the mask.
 */
function addressChanged(sponsor, marker) {
  const prev = marker && marker.sponsor;
  if (!prev || !sponsor) return false;
  if (s(prev.emailKey)) return s(prev.emailKey) !== s(sponsor.emailKey);
  return !!s(prev.emailMasked) && s(prev.emailMasked) !== s(sponsor.emailMasked);
}

/**
 * PURE. What one ensureSponsor pass should do.
 *
 * @param {object}  p.sponsor      resolveSponsor() 'ok' result
 * @param {object}  p.composition  compositionAdapter shape { members }
 * @param {?Array}  p.manifest     the questionnaire member manifest, or null when the file does not exist
 * @param {?object} p.marker       the OneDrive marker, or null when absent
 * @param {string}  p.mode         'prepare' | 'onboard' | 'staff'
 * @param {number}  p.now          ms
 * @param {object}  p.gates        { ok, reason }
 * @param {boolean} [p.createOnly] staff pressed "Add sponsor now" / "Save sponsor": never a send, whatever the case reads NOW
 * @returns {{ createRow, addMember, send, variant, sectionLabel, badge, skipReason, replaced }}
 */
function planEnsure({ sponsor, composition, manifest = null, marker = null, mode, now, gates = { ok: false, reason: 'not-started' }, createOnly = false } = {}) {
  const section = sponsor.sectionMode === 'section';
  const sectionLabel = sectionLabelFor(sponsor, composition, manifest);
  const badge = badgeFor(sponsor, composition, manifest);

  const status = marker && marker.status;
  const pendingAge = status === 'pending' ? (Number(now) - Date.parse(marker.startedAt || '')) : NaN;
  const pendingFresh = status === 'pending' && !(pendingAge > PENDING_STALE_MS);   // unparseable age = fresh (fail closed)
  // A resend that failed leaves status 'failed' but keeps the count: the
  // sponsor already holds the link, so the next send is still a resend. A
  // replaced sponsor holds nothing: the first email to the new address is an
  // onboarding, and the automatic path may still send it once.
  const replaced = addressChanged(sponsor, marker);
  const sentBefore = !replaced && (status === 'sent' || (Number(marker && marker.sendCount) || 0) > 0);
  const variant = sentBefore ? 'resend' : 'onboarding';

  let send = false;
  let skipReason = null;
  if (mode === 'prepare') {
    skipReason = 'prepare';
  } else if (pendingFresh) {
    skipReason = 'in-progress';
  } else if (createOnly) {
    // The page promised no email when staff confirmed; the case may have
    // been paid since the page loaded, so the promise is kept here.
    skipReason = 'create-only';
  } else if (mode === 'onboard') {
    if (sentBefore) skipReason = 'already-sent';                 // the automatic path sends once, ever
    else if (!gates.ok) skipReason = gates.reason || 'not-started';
    else send = true;
  } else if (mode === 'staff') {
    if (sentBefore) send = true;                                 // a resend, any stage (the route's cool-down applies)
    else if (!gates.ok) skipReason = gates.reason || 'not-started';
    else send = true;
  } else {
    skipReason = 'bad-mode';
  }
  // The automatic path creates the row / the section only on the pass that
  // sends. Before payment that is 'prepare' — which runs AFTER the intake's
  // family rows by construction — so a Sub Type webhook landing mid-chain can
  // no longer put a Sponsor row on the board first and make the intake's
  // Spouse/Child rows look "already curated". It also keeps a Sub Type edit on
  // an old, already-onboarded case from growing the board.
  const mayCreate = mode !== 'onboard' || send;
  const createRow = section && mayCreate && existingPartner(sponsor, composition) == null;
  const addMember = section && mayCreate && Array.isArray(manifest) && manifestMember(sponsor, manifest) == null;
  return { createRow, addMember, send, variant, sectionLabel, badge, skipReason, replaced };
}

/**
 * PURE. The sponsor's email. Every value goes through escHtml; the token
 * travels in the link only. Names only — never a pronoun.
 */
function buildSponsorEmail({ variant = 'onboarding', sponsorName, clientName, caseRef, caseType, roleLabel, docs = [], sectionMode, sectionLabel, badge, portalUrl } = {}) {
  const resend = variant === 'resend';
  const paFullName = s(clientName) || 'The client';
  const paFirst = escHtml(paFullName.split(' ')[0] || paFullName);
  const pa = escHtml(paFullName);
  const spFirst = escHtml(s(sponsorName).split(' ')[0] || 'there');
  const ref = escHtml(s(caseRef));
  const type = escHtml(s(caseType) || 'immigration');
  const role = escHtml(s(roleLabel) || 'sponsor');
  const url = escHtml(s(portalUrl));

  const subject = resend
    ? `Your portal link for ${paFullName}'s application — ${s(caseRef)}`
    : `Action Required — Your part in ${paFullName}'s ${s(caseType) || 'immigration'} application (${s(caseRef)})`;
  const title = resend ? 'Your portal link' : 'Your part in this application — Action Required';

  const intro = resend
    ? `Here is the portal link for ${pa}'s ${type} application (case ${ref}) again. You are named on it as the ${role}. The list below is what we need from you, in case it helps.`
    : `${pa} has retained TDOT Immigration for a ${type} application (case ${ref}), and you are named on it as the ${role}. Some of the documents and answers have to come from you. Here is exactly what we need and where to do it.`;

  const docItems = docs.map((d) => `<li style="margin:0 0 6px;">${escHtml(d.name)} — <span style="color:#64748b;">${escHtml(d.category || 'Other')}</span></li>`).join('\n');
  const docsBlock = docs.length
    ? `<p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 10px;">On the portal these are listed under "<strong>${role}</strong>". Please upload each one against its own line, and leave ${paFirst}'s lines to ${paFirst}.</p>
        <ul style="font-size:14px;color:#1e293b;line-height:1.5;margin:0 0 4px;padding-left:20px;">
${docItems}
        </ul>`
    : `<p style="font-size:14px;color:#475569;line-height:1.6;margin:0;">The portal lists the documents we need from you under "<strong>${role}</strong>".</p>`;

  let qBlock;
  if (sectionMode === 'section') {
    qBlock = `The questionnaire has a section headed "<strong>${escHtml(s(sectionLabel) || s(sponsorName))}</strong>" (marked "${escHtml(s(badge) || 'Sponsor')}"). That section is yours. ${paFirst} completes the rest; please leave those sections as they are.`;
  } else if (sectionMode === 'shared-form') {
    qBlock = `The questionnaire is one form for both of you. The questions that ask about the sponsor are yours; the rest are ${paFirst}'s. You can fill it in together.`;
  } else {
    qBlock = 'There is no questionnaire section for you on this case type — we only need the documents listed above.';
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#FAF8F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Header -->
      <tr><td style="background:#0B1D32;border-radius:12px 12px 0 0;padding:28px 32px 26px;text-align:center;border-bottom:3px solid #C9A84C;">
        <img src="${LOGO_URL}" alt="TDOT Immigration" style="height:42px;object-fit:contain;display:inline-block;margin-bottom:10px;background:#fff;padding:3px 6px;border-radius:6px;">
        <div style="font-size:11px;letter-spacing:.18em;color:#C9A84C;text-transform:uppercase;font-weight:700;">Client Portal</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#fff;padding:36px 32px;">

        <p style="font-size:18px;font-weight:700;color:#1e293b;margin:0 0 8px;">Hi ${spFirst},</p>
        <p style="font-size:15px;color:#475569;line-height:1.65;margin:0 0 24px;">
          ${intro}
        </p>

        <!-- Single portal CTA -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:28px;">
          <tr><td style="padding:24px;text-align:center;">
            <div style="font-size:32px;margin-bottom:8px;">🏠</div>
            <div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:6px;">The case portal</div>
            <p style="font-size:14px;color:#64748b;margin:0 0 18px;line-height:1.6;">
              You and ${paFirst} share one portal for this case. Open it to upload your documents
              and complete your part of the questionnaire. Save your progress at any time and
              return whenever you're ready.
            </p>
            <a href="${url}" style="display:inline-block;background:#8B0000;color:#fff;font-size:15px;font-weight:700;padding:13px 28px;border-radius:8px;text-decoration:none;">
              Open the case portal →
            </a>
          </td></tr>
        </table>

        <!-- Documents -->
        <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Documents we need from you</div>
        ${docsBlock}

        <!-- Questionnaire -->
        <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin:24px 0 10px;">Your part of the questionnaire</div>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 24px;">
          ${qBlock}
        </p>

        <!-- Good to know -->
        <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Good to know</div>
        <ul style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 28px;padding-left:20px;">
          <li>This is the same portal link ${paFirst} received. You can both see the whole case — including each other's answers and uploads — and so can your consultant.</li>
          <li>Please do not forward this email. The link opens ${paFirst}'s application as well as your part of it.</li>
        </ul>

        <!-- Case details -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin-bottom:28px;">
          <tr><td style="padding:16px 20px;">
            <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Your Case Details</div>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Reference</td>
                <td style="font-size:13px;font-weight:700;color:#1e293b;">${ref}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Type</td>
                <td style="font-size:13px;font-weight:600;color:#1e293b;">${type}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Principal applicant</td>
                <td style="font-size:13px;font-weight:600;color:#1e293b;">${pa}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Your role</td>
                <td style="font-size:13px;font-weight:600;color:#1e293b;">${role}</td>
              </tr>
            </table>
          </td></tr>
        </table>

        <p style="font-size:14px;color:#64748b;line-height:1.65;margin:0;">
          If you have any questions, please reply to this email (quoting the case reference <strong>${ref}</strong>)
          or contact the assigned consultant.
        </p>

      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
        <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.6;">
          TDOT Immigration Services<br>
          This email was sent to you because you are named on ${pa}'s application.<br>
          Please do not forward this email — the link is specific to this case.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>

</body>
</html>`;
  return { subject, title, html };
}

/* ─────────────────────────────── I/O ─────────────────────────────── */

/**
 * ONE Monday query on the Client Master item. Given a caseRef only, the item is
 * resolved through the questionnaire service's staff lookup first. Returns null
 * when the item does not exist.
 */
async function readCase({ itemId, caseRef } = {}) {
  let id = s(itemId);
  if (!id) {
    const htmlQ = require('./htmlQuestionnaireService');
    const entry = await htmlQ.validateAccessForStaff(s(caseRef), { skipFormVersioning: true });
    id = s(entry && entry.itemId);
  }
  const cols = JSON.stringify(Object.values(CM));
  const d = await mondayApi.query(
    `query($ids:[ID!]){ items(ids:$ids){ id name state column_values(ids:${cols}){ id text } } }`,
    { ids: [id] });
  const item = d && d.items && d.items[0];
  if (!item || item.state === 'deleted') return null;
  const cv = {};
  for (const c of item.column_values || []) cv[c.id] = s(c.text).replace(/\s+/g, ' ');
  return {
    itemId: String(item.id),
    clientName: s(item.name) || 'Client',
    caseRef: cv[CM.caseRef] || '',
    caseType: cv[CM.caseType] || '',
    caseSubType: cv[CM.caseSubType] || '',
    clientEmail: cv[CM.clientEmail] || '',
    accessToken: cv[CM.accessToken] || '',
    caseStage: cv[CM.caseStage] || '',
    paymentStatus: cv[CM.paymentStatus] || '',
    checklistTemplateApplied: cv[CM.checklistTemplateApplied] || '',
  };
}

async function readMarker({ clientName, caseRef }) {
  const buf = await oneDrive.readFile({ clientName, caseRef, subfolder: QUESTIONNAIRE_SUBFOLDER, filename: markerFilename(caseRef) });
  if (!buf) return null;
  const data = JSON.parse(buf.toString('utf8'));
  return (data && typeof data === 'object') ? data : null;
}

async function writeMarker({ clientName, caseRef, marker }) {
  const buffer = Buffer.from(JSON.stringify(marker, null, 2), 'utf8');
  await oneDrive.ensureClientFolder({ clientName, caseRef });
  await oneDrive.uploadFile({ clientName, caseRef, category: QUESTIONNAIRE_SUBFOLDER, filename: markerFilename(caseRef), buffer, mimeType: 'application/json' });
}

async function postNote(itemId, body) {
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(itemId), b: body });
}

/** The side effects, behind one seam — the tests replace all of it. */
const io = {
  readCase:          (args) => readCase(args),
  findClaimants:     (itemId) => leadService.findAllByColumnValue('clientMasterItemId', String(itemId)),
  readComposition:   (caseRef) => require('./compositionAdapter').readForCase(caseRef),
  readManifest:      (args) => require('./htmlQuestionnaireService').readMembersManifest(args),
  loadMembers:       (args) => require('./htmlQuestionnaireService').loadMembers(args),
  addMember:         (args) => require('./htmlQuestionnaireService').addMember(args),
  createFamilyRow:   (args) => require('./familyCompositionService').createFamilyRow(args),
  createIntakeRows:  (args) => require('./familyCompositionService').createFamilyRowsForItem(args),   // the intake's own rows; 0 once any row exists
  readMarker:        (args) => readMarker(args),
  writeMarker:       (args) => writeMarker(args),
  ensureAccessToken: (itemId) => require('./accessTokenService').ensureAccessToken(itemId),
  sendEmail:         (msg) => mail.sendEmail(msg),
  postNote:          (itemId, body) => postNote(itemId, body),
  updateLead:        (leadId, fields) => leadService.updateLead(leadId, fields),   // two arguments only — a partial update never blanks a column
  now:               () => Date.now(),
};

/* ─────────────────────────── ensureSponsor ─────────────────────────── */

/** The automatic gates (D6): the same ones the PA's intake email passes. */
function gatesFor({ mode, cm, claimants, today }) {
  if (mode === 'prepare') return { ok: false, reason: 'prepare' };
  if (cm.paymentStatus !== 'Paid') return { ok: false, reason: 'not-started' };
  if (!STAGES_REQUIRING_RESEND.has(cm.caseStage)) return { ok: false, reason: 'not-started' };
  if (mode === 'staff') return { ok: true, reason: null };
  // 'onboard': first onboarding only, and the activation gate must hold with
  // the payment counted as landed (mondayWebhook's DCS pattern). Each closed
  // gate has its own reason: 'already-onboarded' is permanent (only the case
  // page can send now), 'not-started' is not.
  if (lower(cm.checklistTemplateApplied) === 'yes') return { ok: false, reason: 'already-onboarded' };
  const lead = claimants[0] || {};
  const gate = require('./caseGateService').signatureGateForLead({ ...lead, retainerPaid: s(lead.retainerPaid) || today });
  if (!gate.complete) return { ok: false, reason: 'signature-incomplete' };
  return { ok: true, reason: null };
}

function whoDidIt(actor, trigger) {
  return actor && s(actor.name) ? s(actor.name).slice(0, 60) : `auto:${s(trigger) || 'unknown'}`;
}

/** Whether the case already reads Paid + a Document Collection stage. */
function caseStarted(cm) {
  return cm.paymentStatus === 'Paid' && STAGES_REQUIRING_RESEND.has(cm.caseStage);
}

/**
 * What happens to the portal email after a row / section was created WITHOUT
 * a send — said from the SAME gates the automatic path applies, so the note
 * never promises an email that path then refuses (the agreement not fully
 * executed, the checklist already applied, the client's own address, the
 * switch off, no portal link). With the switch on and every gate open, the
 * email follows on its own only from 'prepare' on a case paid before its type
 * was set (the resume sends seconds later); from the case page no automatic
 * trigger is due, so staff send it.
 *
 * @param {?string} p.gateReason  gatesFor({ mode:'onboard' }).reason — null when the automatic email would go
 */
function nextStepSentence({ mode, cm, gateReason = null, sameAsClient = false, noToken = false, autoEnabled = isEnabled() }) {
  const fromPage = 'Send the portal email from the case page (Send sponsor link)';
  if (noToken) return 'No portal link could be made just now, so nothing was emailed — send it from the case page (Send sponsor link).';
  if (!autoEnabled) return caseStarted(cm) ? `${fromPage}.` : `${fromPage} once the case is paid and at Document Collection.`;
  if (sameAsClient) return 'Send it from the case page (Send sponsor link) — the address is the client’s, so it is never emailed automatically.';
  if (gateReason === 'signature-incomplete') return 'The agreement is not fully executed yet, so nothing is emailed automatically — send it from the case page (Send sponsor link).';
  if (gateReason === 'already-onboarded') return 'This case was onboarded before the sponsor was added, so nothing is emailed automatically — send it from the case page (Send sponsor link).';
  if (gateReason) return 'The portal email goes out automatically when Document Collection starts.';
  return mode === 'prepare' ? 'The portal email follows automatically.' : `${fromPage}.`;
}

/** The note for a row / section created WITHOUT a send. */
function createdNote({ sponsor, sectionLabel, actor, mode, cm, gateReason = null, sameAsClient = false, noToken = false, autoEnabled = isEnabled() }) {
  const next = nextStepSentence({ mode, cm, gateReason, sameAsClient, noToken, autoEnabled });
  return `🤝 Sponsor ${escHtml(sponsor.name)} added to the case by ${actor && s(actor.name) ? escHtml(s(actor.name)) : 'the system'} — ` +
    `questionnaire section "${escHtml(sectionLabel)}" created. ${next}`;
}

function sentNote({ sponsor, sectionLabel, created, variant, actor, when }) {
  const head = actor && s(actor.name)
    ? `🤝 Sponsor portal email ${variant === 'resend' ? 're-sent' : 'sent'} by ${escHtml(s(actor.name))} to ${escHtml(sponsor.emailMasked)} (${escHtml(sponsor.roleLabel)})`
    : `🤝 Sponsor portal email sent automatically to ${escHtml(sponsor.emailMasked)} (${escHtml(sponsor.roleLabel)})`;
  return `${head} — ${escHtml(when)} (Toronto). Same portal link as the client; the sponsor's documents are listed under "${escHtml(sponsor.roleLabel)}".` +
    ((created.row || created.member) ? ` Questionnaire section "${escHtml(sectionLabel)}" created.` : '');
}

const _inFlight = new Set();   // caseRef — collapses concurrent callers (webhook + sub-type + staff) into one send

/**
 * Make sure the sponsor exists on the case and — when the gates hold — has been
 * emailed. Reads first; a failed read returns { done:false, reason:'transient' }
 * and nothing is written.
 *
 * @param {object}  p
 * @param {string}  [p.itemId]    Client Master item (or resolve it from caseRef)
 * @param {string}  [p.caseRef]
 * @param {string}  p.mode        'prepare' (row/section only) | 'onboard' (automatic, env-gated) | 'staff' (the cockpit button)
 * @param {?object} [p.actor]     { name, email } for staff sends
 * @param {string}  p.trigger     'case-ref' | 'dcs' | 'retainer-paid' | 'resume' | 'sub-type' | 'staff'
 * @param {?object} [p.override]  { name, email } — staff entered the inviter on the case page (single-lead cases only)
 * @param {boolean} [p.createOnly] staff mode: "Add sponsor now" / "Save sponsor" — the row, the section, the lead; never an email
 */
async function ensureSponsor({ itemId, caseRef, mode = 'onboard', actor = null, trigger = 'unknown', override, createOnly = false } = {}) {
  if (!MODES.includes(mode)) return { done: false, reason: 'bad-mode' };
  if (mode !== 'staff' && !isEnabled()) return { done: false, reason: 'disabled' };
  // What this pass has written so far travels on every early return: a
  // failure AFTER the lead or the row was saved is still 'transient', but the
  // route must not say "nothing was changed".
  let inviterSaved = false;
  const created = { row: false, member: false };
  const transient = (err) => ({ done: false, reason: 'transient', error: s(err && err.message).slice(0, 200), inviterSaved, created: { ...created } });

  let cm;
  try { cm = await io.readCase({ itemId, caseRef }); } catch (err) { return transient(err); }
  if (!cm) return { done: false, reason: 'no-case' };
  if (!cm.caseRef) return { done: false, reason: 'no-case-ref' };
  const key = cm.caseRef;
  if (_inFlight.has(key)) return { done: false, reason: 'in-flight' };
  _inFlight.add(key);
  try {
    // ── Reads ──
    let claimants;
    try { claimants = await io.findClaimants(cm.itemId); } catch (err) { return transient(err); }
    claimants = Array.isArray(claimants) ? claimants : [];

    const inputs = {
      clientEmail: mode === 'staff' ? null : cm.clientEmail,   // the same-as-client block is for the automatic path only
      caseType: cm.caseType, caseSubType: cm.caseSubType,
      schema: caseSchemaService.lookup(cm.caseType, cm.caseSubType),
      memberTypes: resolveMemberTypes(cm.caseType, cm.caseSubType),
      embedsAllMembers: formEmbedsMembers(cm.caseType, cm.caseSubType),
    };
    // Resolve BEFORE any write: a case type with no sponsor role, a blank Sub
    // Type, no lead or a shared case is refused here, so a typed inviter is
    // never saved to a lead the route then answers 400 for.
    let sponsor = resolveSponsor({ claimants, ...inputs });
    const overriding = !!override && claimants.length === 1;
    if (overriding && sponsor.status === 'ok') {
      // The lead already names a valid inviter: replacing that person from here
      // would resend the link to a stranger as a "resend". Change it in the
      // retainer panel's Inviter / Sponsor block instead.
      return { done: false, reason: 'inviter-exists', claimantCount: 1, current: { name: sponsor.name, emailMasked: sponsor.emailMasked } };
    }
    if (sponsor.status !== 'ok' && !(overriding && sponsor.reason === 'no-inviter')) {
      return { done: false, reason: sponsor.reason, claimantCount: sponsor.claimantCount };
    }
    let typed = null;
    if (overriding) {
      const name = clean(override.name).slice(0, NAME_MAX);
      const email = clean(override.email);
      if (!name || !EMAIL_RE.test(email)) return { done: false, reason: 'no-inviter', claimantCount: 1 };
      typed = { name, email };
    }

    // The remaining reads come BEFORE the lead write, so a read failure really
    // has changed nothing (the route says so).
    let composition;
    try { composition = await io.readComposition(cm.caseRef); } catch (err) { return transient(err); }
    let marker;
    try { marker = await io.readMarker({ clientName: cm.clientName, caseRef: cm.caseRef }); } catch (err) { return transient(err); }

    if (typed) {
      try { await io.updateLead(claimants[0].id, { inviterName: typed.name, inviterEmail: typed.email }); } catch (err) { return transient(err); }
      inviterSaved = true;
      claimants = [{ ...claimants[0], inviterName: typed.name, inviterEmail: typed.email }];
      sponsor = resolveSponsor({ claimants, ...inputs });
      const who = actor && s(actor.name) ? escHtml(s(actor.name)) : 'staff';
      await io.postNote(cm.itemId, `🤝 Sponsor / inviter ${escHtml(typed.name)} (${escHtml(maskAddr(typed.email))}) entered from the case page by ${who} — saved to the client record.`).catch(() => {});
      if (sponsor.status !== 'ok') return { done: false, reason: sponsor.reason, claimantCount: sponsor.claimantCount, inviterSaved };
    }

    const nowMs = io.now();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const gates = gatesFor({ mode, cm, claimants, today });
    // For the notes only: whether the address is the client's own (staff mode
    // resolves without that check) — the automatic path never emails it.
    const sameAsClient = !!(clean(cm.clientEmail) && lower(sponsor.email) === lower(clean(cm.clientEmail)));

    // ── Writes, in order: the row, then the manifest member, then the email ──
    const stamps = {};
    let plan = planEnsure({ sponsor, composition, manifest: null, marker, mode, now: nowMs, gates, createOnly });
    if (plan.createRow && mode === 'onboard' && !((composition && composition.members) || []).length) {
      // The automatic path can land mid case-ref chain: a Sub Type picked
      // seconds after the Case Type on a case paid before its type was set,
      // while the chain is still renaming the folder and the intake's
      // Spouse/Child rows are not on the board yet. Put them there FIRST —
      // createFromLead creates nothing once any row exists, so a Sponsor row
      // written now would make the intake's children disappear for good —
      // then look again: the intake's Spouse row may be this person (D5).
      let intakeRows = 0;
      try { intakeRows = await io.createIntakeRows({ itemId: cm.itemId, caseRef: cm.caseRef }); } catch (err) { return transient(err); }
      if (intakeRows > 0) {
        try { composition = await io.readComposition(cm.caseRef); } catch (err) { return transient(err); }
        plan = planEnsure({ sponsor, composition, manifest: null, marker, mode, now: nowMs, gates, createOnly });
      }
    }
    if (plan.createRow) {
      try {
        await io.createFamilyRow({ caseRef: cm.caseRef, cmItemId: cm.itemId, row: { memberType: sponsor.boardMemberType, name: sponsor.name, memberKey: sponsor.memberKey } });
      } catch (err) { return transient(err); }
      created.row = true;
      stamps.rowCreatedAt = new Date(io.now()).toISOString();
      composition = { ...composition, members: [...((composition && composition.members) || []), { role: sponsor.role, name: sponsor.name, memberKey: sponsor.memberKey, flags: {} }] };
    }
    // The manifest AFTER the row exists: an EXISTING file gets the member. In
    // staff mode an absent file is seeded by loadMembers from the now-updated
    // board (its saveMembers drops the 60 s seed cache); on the automatic path
    // it is left for the first questionnaire read to seed, row and all.
    let manifest = null;
    try {
      manifest = await io.readManifest({ clientName: cm.clientName, caseRef: cm.caseRef });
      if (manifest == null && mode === 'staff') {
        manifest = await io.loadMembers({ clientName: cm.clientName, caseRef: cm.caseRef });
        // A seed that comes back primary-only while the board has family rows
        // (our own row included) is a board read that failed INSIDE the seed —
        // loadMembers degrades to the default list. Adding the sponsor to that
        // would save a manifest without the other family members, for good.
        const boardHasSections = ((composition && composition.members) || []).some((m) => m && PORTAL_ROLES.has(m.role));
        if (boardHasSections && (!Array.isArray(manifest) || manifest.length <= 1)) {
          return transient(new Error('manifest seed incomplete — the family board could not be read'));
        }
      }
    } catch (err) { return transient(err); }
    plan = planEnsure({ sponsor, composition, manifest, marker, mode, now: nowMs, gates, createOnly });
    if (plan.addMember) {
      try {
        await io.addMember({ clientName: cm.clientName, caseRef: cm.caseRef, memberType: sponsor.manifestType, label: sponsor.name });
      } catch (err) { return transient(err); }
      created.member = true;
      stamps.memberAddedAt = new Date(io.now()).toISOString();
      plan.sectionLabel = sponsor.name;
      plan.badge = sponsor.boardMemberType;
    }
    const sectionLabel = plan.sectionLabel;

    // Something was created but nothing goes out on this pass: the note says
    // what happens next from the automatic path's OWN gates.
    const noteCreated = (extra = {}) => io.postNote(cm.itemId, createdNote({
      sponsor, sectionLabel, actor, mode, cm, sameAsClient, gateReason: gatesFor({ mode: 'onboard', cm, claimants, today }).reason, ...extra,
    })).catch((err) => console.warn(`[Sponsor] Note failed for ${cm.caseRef}: ${err.message}`));

    if (!plan.send) {
      if (created.row || created.member) await noteCreated();
      return { done: true, sent: false, reason: plan.skipReason || gates.reason, created, inviterSaved, sectionLabel, to: sponsor.emailMasked };
    }

    const token = cm.accessToken || await io.ensureAccessToken(cm.itemId).catch((err) => {
      console.error(`[Sponsor] Could not ensure access token for ${cm.caseRef}: ${err.message}`);
      return '';
    });
    if (!token) {
      if (created.row || created.member) await noteCreated({ noToken: true });
      return { done: true, sent: false, reason: 'no-token', created, inviterSaved, sectionLabel, to: sponsor.emailMasked };
    }

    const prior = (marker && typeof marker === 'object') ? marker : {};
    // A replaced sponsor starts a count of their own; the earlier sends stay
    // in the history, and the next entry says whom they went to.
    const replacedFrom = plan.replaced ? s(prior.sponsor && prior.sponsor.emailMasked) : '';
    const base = {
      ...prior, version: MARKER_VERSION, caseRef: cm.caseRef, leadId: sponsor.leadId,
      sponsor: { name: sponsor.name, emailMasked: sponsor.emailMasked, emailKey: sponsor.emailKey },
      role: sponsor.role, roleLabel: sponsor.roleLabel, sectionMode: sponsor.sectionMode, sectionLabel,
      sendCount: plan.replaced ? 0 : (Number(prior.sendCount) || 0), sends: Array.isArray(prior.sends) ? prior.sends : [],
      ...stamps,
    };
    const startedAt = new Date(io.now()).toISOString();
    // 'pending' is a lock, not a claim: a second instance reading it within 10
    // minutes stands down; a crash leaves it to expire.
    try { await io.writeMarker({ clientName: cm.clientName, caseRef: cm.caseRef, marker: { ...base, status: 'pending', startedAt } }); }
    catch (err) { return transient(err); }

    const portalUrl = `${BASE_URL}/client/${encodeURIComponent(cm.caseRef)}?t=${encodeURIComponent(token)}`;
    const { subject, html } = buildSponsorEmail({
      variant: plan.variant, sponsorName: sponsor.name, clientName: cm.clientName, caseRef: cm.caseRef, caseType: cm.caseType,
      roleLabel: sponsor.roleLabel, docs: sponsor.docs, sectionMode: sponsor.sectionMode, sectionLabel, badge: plan.badge, portalUrl,
    });
    try {
      await io.sendEmail({ to: sponsor.email, subject, html, replyTo: EMAIL_REPLY_TO || undefined });
    } catch (err) {
      await io.writeMarker({ clientName: cm.clientName, caseRef: cm.caseRef, marker: { ...base, status: 'failed', startedAt, failedAt: new Date(io.now()).toISOString(), error: s(err.message).slice(0, 200) } })
        .catch((e2) => console.error(`[Sponsor] Marker write after a failed send also failed for ${cm.caseRef}: ${e2.message}`));
      throw err;
    }
    const sentAt = new Date(io.now()).toISOString();
    const by = whoDidIt(actor, trigger);
    const { error: _e, failedAt: _f, ...kept } = base;   // eslint-disable-line no-unused-vars — a re-send clears an earlier failure
    const sent = { ...kept, status: 'sent', startedAt, sentAt,
      sendCount: base.sendCount + 1, sends: [...base.sends, { variant: plan.variant, at: sentAt, to: sponsor.emailMasked, by, ...(replacedFrom ? { replacedFrom } : {}) }] };
    try { await io.writeMarker({ clientName: cm.clientName, caseRef: cm.caseRef, marker: sent }); }
    catch (err) { console.error(`[Sponsor] SENT but marker write failed for ${cm.caseRef}: ${err.message}`); }
    console.log(`[Sponsor] ${plan.variant === 'resend' ? 'Portal link re-sent' : 'Onboarding email sent'} to ${sponsor.emailMasked} for ${cm.caseRef} (${by})`);
    await io.postNote(cm.itemId, sentNote({ sponsor, sectionLabel, created, variant: plan.variant, actor, when: torontoTime(io.now()) }))
      .catch((err) => console.warn(`[Sponsor] Note failed for ${cm.caseRef}: ${err.message}`));
    return { done: true, sent: true, to: sponsor.emailMasked, emailedAt: sentAt, variant: plan.variant, created, inviterSaved, sectionLabel };
  } finally {
    _inFlight.delete(key);
  }
}

/* ─────────────────────────────── describe ─────────────────────────────── */

/**
 * PURE. The cockpit's view of the sponsor (overview.sponsor, §6).
 * The same-as-client address is reported as status 'ok' with reason
 * 'same-as-client': staff may still send (the dialog says so); only the
 * automatic path is blocked.
 */
function describeFromInputs({ claimants, marker = null, markerUnavailable = false, caseType, caseSubType, clientEmail = null, cmUnavailable = false, caseStage, paymentStatus, composition, qMembers, now = Date.now(), autoEnabled = isEnabled() } = {}) {
  const inputs = {
    claimants, caseType, caseSubType,
    schema: caseSchemaService.lookup(caseType, caseSubType),
    memberTypes: resolveMemberTypes(caseType, caseSubType),
    embedsAllMembers: formEmbedsMembers(caseType, caseSubType),
  };
  // autoEnabled: whether the automatic senders are switched on — the card
  // must not promise an email the switch never sends.
  const out = {
    available: true, status: 'none', reason: null, name: '', emailMasked: '', roleLabel: '', docCount: 0,
    sectionMode: null, sectionLabel: '', sectionExists: false, rowExists: false,
    emailedAt: null, sentCount: 0, lastError: null, markerUnavailable: !!markerUnavailable,
    canSend: false, sendBlockedReason: null, claimantCount: Array.isArray(claimants) ? claimants.length : 0,
    autoEnabled: !!autoEnabled,
    replacedFrom: null,   // the masked address the earlier sends went to, when the lead now names someone else
  };
  const st = marker && marker.status;
  const started = paymentStatus === 'Paid' && STAGES_REQUIRING_RESEND.has(caseStage);
  let sponsor = resolveSponsor({ ...inputs, clientEmail: cmUnavailable ? null : clientEmail });
  if (sponsor.status === 'none' && sponsor.reason === 'same-as-client') {
    out.reason = 'same-as-client';
    sponsor = resolveSponsor({ ...inputs, clientEmail: null });
  }
  if (sponsor.status !== 'ok') {
    out.reason = sponsor.reason;
    // A sponsor typed on the case page before payment is saved, not emailed —
    // the card words its button from this.
    out.sendBlockedReason = sponsor.reason === 'shared-case' ? 'shared-case' : (!started && st !== 'sent') ? 'not-started' : null;
    return out;
  }
  out.status = 'ok';
  out.name = sponsor.name;
  out.emailMasked = sponsor.emailMasked;
  out.roleLabel = sponsor.roleLabel;
  out.docCount = sponsor.docs.length;
  out.sectionMode = sponsor.sectionMode;
  out.sectionLabel = sectionLabelFor(sponsor, composition, Array.isArray(qMembers) ? qMembers : null);
  out.sectionExists = sponsor.sectionMode === 'section' && manifestMember(sponsor, Array.isArray(qMembers) ? qMembers : null) != null;
  out.rowExists = existingPartner(sponsor, composition) != null;
  // A failed RESEND keeps the earlier delivery on record: the last successful
  // send is still the "Emailed …" fact, next to the failure. A sponsor
  // replaced after a send was never emailed: the marker's history belongs to
  // the earlier address, which the card names instead.
  const replaced = addressChanged(sponsor, marker);
  const sends = Array.isArray(marker && marker.sends) ? marker.sends : [];
  const lastSend = sends.length ? sends[sends.length - 1] : null;
  out.replacedFrom = replaced ? (s(marker.sponsor.emailMasked) || null) : null;
  out.emailedAt = replaced ? null : st === 'sent' ? (marker.sentAt || null) : (st === 'failed' && lastSend && lastSend.at) ? lastSend.at : null;
  out.sentCount = replaced ? 0 : (Number(marker && marker.sendCount) || 0);
  out.lastError = (!replaced && st === 'failed') ? (s(marker.error) || 'send failed') : null;
  const pendingFresh = st === 'pending' && !((Number(now) - Date.parse(marker.startedAt || '')) > PENDING_STALE_MS);
  if (markerUnavailable) { out.canSend = false; out.sendBlockedReason = 'marker-unavailable'; }
  else if (pendingFresh) { out.canSend = false; out.sendBlockedReason = 'in-progress'; }
  else if ((!replaced && st === 'sent') || out.sentCount > 0 || started) { out.canSend = true; }
  else { out.canSend = false; out.sendBlockedReason = 'not-started'; }
  return out;
}

/**
 * The cockpit read: claimants + marker, then the pure description. A marker
 * read failure degrades to markerUnavailable (the button is disabled); a
 * claimants read failure means the sponsor cannot be described at all.
 * A case type with no sponsor role (most cases) is answered from the schema
 * alone — no Monday or OneDrive read for a card that is hidden anyway.
 */
async function describe({ itemId, caseRef, clientName, caseType, caseSubType, clientEmail = null, cmUnavailable = false, caseStage, paymentStatus, composition, qMembers } = {}) {
  if (!sponsorRoleOf(caseSchemaService.lookup(caseType, caseSubType))) {
    return describeFromInputs({ claimants: [], caseType, caseSubType, clientEmail, cmUnavailable, caseStage, paymentStatus, composition, qMembers, now: io.now() });
  }
  let claimants;
  try { claimants = await io.findClaimants(itemId); } catch (err) {
    console.warn(`[Sponsor] describe: lead lookup failed for ${caseRef}: ${err.message}`);
    return { available: false };
  }
  let marker = null, markerUnavailable = false;
  try { marker = await io.readMarker({ clientName, caseRef }); } catch (err) {
    console.warn(`[Sponsor] describe: marker read failed for ${caseRef}: ${err.message}`);
    markerUnavailable = true;
  }
  return describeFromInputs({ claimants, marker, markerUnavailable, caseType, caseSubType, clientEmail, cmUnavailable, caseStage, paymentStatus, composition, qMembers, now: io.now() });
}

module.exports = {
  ensureSponsor, describe, describeFromInputs,
  // pure planners (tests)
  resolveSponsor, existingPartner, planEnsure, buildSponsorEmail, sectionLabelFor, badgeFor, sponsorRoleOf, gatesFor, createdNote, nextStepSentence, addressChanged, emailKeyOf,
  io, isEnabled, readCase, torontoTime,
  EMAIL_RE, NAME_MAX, PENDING_STALE_MS, STAFF_COOLDOWN_MS, MARKER_VERSION, QUESTIONNAIRE_SUBFOLDER, ROLE_TO_PORTAL_TYPE,
  _inFlight,
};
