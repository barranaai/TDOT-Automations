'use strict';

/**
 * The "which case is this email about" stamp on a client email (Stage 1, Faran 2026-11-19). PURE.
 *
 * Client emails go from the office mailbox (CLIENT_MAIL_FROM, info@) and Microsoft keeps a copy in its
 * Sent Items. Each copy carries these named MAPI single-value extended properties, so the case page can
 * later find the app's emails for a case with an exact Graph filter (Stage 2):
 *
 *   TdotCaseItemId  Client Master item id        ^\d{1,20}$
 *   TdotCaseRef     case ref, upper-case          2026-SPE-016, 2026-CEC-EE-110 (the whole value)
 *   TdotLeadId      Lead Board item id            ^\d{1,20}$
 *   TdotTo          first recipient, lower-case   a valid address, at most 120 characters (Graph's eq-filter limit)
 *   TdotKind        what the email is             ^[a-z0-9-]{1,40}$ — e.g. doc-reminder
 *   TdotSendId      crypto.randomUUID()           always — handed back so one test send can be found
 *
 * Rules (do not undo):
 *  - OUR OWN fixed GUID namespace, generated once and never changed. NEVER PS_INTERNET_HEADERS
 *    {00020386-0000-0000-C000-000000000046}: that namespace is turned into x- headers on the wire and would
 *    hand our ids to the client.
 *  - Fixed property NAMES. A value never goes into a name: every mailbox has a quota of named properties.
 *  - An invalid value is DROPPED, never thrown — a stamp can never block a client email.
 */

const crypto = require('crypto');

/** Our namespace — fixed forever (a new GUID would orphan every copy already stamped). */
const NS = '{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e}';
/** The namespace that must never be used (x- headers on the wire). */
const PS_INTERNET_HEADERS = '{00020386-0000-0000-C000-000000000046}';

const NAMES = Object.freeze(['TdotCaseItemId', 'TdotCaseRef', 'TdotLeadId', 'TdotTo', 'TdotKind', 'TdotSendId']);

/** Graph's id for one of our properties: "String {GUID} Name <name>". */
const propId = (name) => `String ${NS} Name ${name}`;

const ID_RE    = /^\d{1,20}$/;
const REF_RE   = /^\d{4}-[A-Z]+(?:-[A-Z]+)*-\d{3,}$/;   // the case-ref shape (emailLeadsService SUBJECT_REF_RE, whole value)
const KIND_RE  = /^[a-z0-9-]{1,40}$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;  // emailLeadsService EMAIL_RE
const REF_MAX = 40, TO_MAX = 120;

const str = (v) => { try { return (v == null ? '' : String(v)).trim(); } catch (_) { return ''; } };   // never throws

function itemId(v) { const s = str(v); return ID_RE.test(s) ? s : ''; }
function caseRef(v) { const s = str(v).toUpperCase(); return s.length <= REF_MAX && REF_RE.test(s) ? s : ''; }
function kind(v) { const s = str(v); return KIND_RE.test(s) ? s : ''; }
function firstRecipient(recipients) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const first = list.map((r) => (r && typeof r === 'object' ? r.emailAddress && r.emailAddress.address : r)).find((a) => str(a));
  const s = str(first).toLowerCase();
  return s.length <= TO_MAX && EMAIL_RE.test(s) ? s : '';
}

/**
 * The stamp for one send.
 * @param {?{caseItemId?, caseRef?, leadId?, kind?}} tag
 * @param {string|string[]|object[]} recipients  the `to` the caller passed (or Graph recipients)
 * @returns {{ props: {id:string, value:string}[], sendId: string }}  never throws
 */
function buildTagProps(tag, recipients) {
  const t = tag && typeof tag === 'object' ? tag : {};
  const sendId = crypto.randomUUID();
  let to = '';
  try { to = firstRecipient(recipients); } catch (_) { to = ''; }
  const values = {
    TdotCaseItemId: itemId(t.caseItemId),
    TdotCaseRef:    caseRef(t.caseRef),
    TdotLeadId:     itemId(t.leadId),
    TdotTo:         to,
    TdotKind:       kind(t.kind),
    TdotSendId:     sendId,
  };
  const props = NAMES.filter((n) => values[n]).map((n) => ({ id: propId(n), value: values[n] }));
  return { props, sendId };
}

module.exports = { buildTagProps, propId, NS, NAMES, PS_INTERNET_HEADERS };
