'use strict';

/**
 * The case page's Emails tab (Stage 2a, Faran 2026-11-19) — the RULES, all PURE:
 *   which addresses are "this client", the Graph query texts (filter / expand / KQL), and the ONE match rule
 *   used both for the list and for opening one email (matchMessage).
 *
 * The match rule (spec "Match rule"; critique #4, #12):
 *  1. A STAMP (the app's own copy, utils/mailTag.js) decides alone: in only when TdotCaseItemId is this case, or
 *     (no case id) TdotCaseRef is this case, or (neither) TdotLeadId is one of this case's leads, or (no case /
 *     lead stamp at all) TdotTo is one of this client's addresses. A stamp naming another case / lead → OUT
 *     (counted "belong to other records"). What a Graph FILTER proved counts as read (the filter itself proves
 *     ownership); a copy found only by TdotTo whose other stamp fields could not be read → OUT ("not checked");
 *     so is an email the office mailbox sent, outside Sent Items, whose stamp was never read (the list's stamp
 *     look covers Sent Items only; opening it reads the stamp, so both views agree).
 *  2. No stamp, the subject names case refs (emailLeadsService.subjectCaseRefs): in only when THIS ref is one.
 *  3. No stamp, no ref: in when a participant (from, sender, to, cc, reply-to — NEVER bcc) is one of this
 *     client's addresses; a bulk mail (more than 10 to + cc) is out.
 *  4. Drafts / Outbox / isDraft out; Junk in (folded on the page); Deleted Items in (badged).
 *  5. Direction by the FROM address, never by folder: our own (tdotimm.com, the office / old mailboxes, the
 *     addresses emailLeadsService never takes as people) → "app" when stamped, else "staff"; anyone else →
 *     "client". The old no-reply inbox → "client-old" (and only its messages FROM a client address count).
 *  6. One entry per internet message id (the office copy first), newest first.
 */

const { propId, NS } = require('../utils/mailTag');
const { odataStr } = require('../utils/graphRead');
const { subjectCaseRefs } = require('./emailLeadsService');
const { textSegments } = require('../utils/caseEmailLinks');   // requires nothing itself — no cycle

/** The stamp fields read back on a message (TdotSendId is not needed to decide anything). */
const STAMP_NAMES = Object.freeze(['TdotCaseItemId', 'TdotCaseRef', 'TdotLeadId', 'TdotTo', 'TdotKind']);
const STAMP_KEY = { TdotCaseItemId: 'caseItemId', TdotCaseRef: 'caseRef', TdotLeadId: 'leadId', TdotTo: 'to', TdotKind: 'kind' };

/** List fields everywhere — never a body in a list. */
const SELECT = 'id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,sentDateTime,receivedDateTime,hasAttachments,parentFolderId,isDraft,webLink';

const MAX_ADDRESSES = 5;
const BULK_RECIPIENTS = 10;
const EQ_MAX = 120;   // Graph's eq-filter value limit
/** A case ref, whole value (emailLeadsService SUBJECT_REF_RE / mailTag). */
const REF_RE = /^\d{4}-[A-Z]+(?:-[A-Z]+)*-\d{3,}$/;
const ITEM_ID_RE = /^\d{1,20}$/;
/** An address we put into a KQL search or an OData filter: plain characters only (also blocks KQL / OData injection). */
const ADDR_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

const s = (v) => String(v == null ? '' : v).trim();
const low = (v) => s(v).toLowerCase();
const domainOf = (a) => low(String(a || '').split('@')[1]);
const onDomain = (a, domains) => { const d = domainOf(a); return !!d && domains.some((x) => d === x || d.endsWith('.' + x)); };

/** Usable as a search / filter value? */
function addressOk(a) { const v = low(a); return v.length <= EQ_MAX && ADDR_RE.test(v); }

/**
 * "This client" (decision 3): the Client Master email (split like emailLeadsService.isCaseClient) + the email of
 * every consultation/lead in `leadEmails`, lower-cased, de-duplicated, at most MAX_ADDRESSES, Client Master first.
 * Never one of our own (an address on `skipDomains` or in `skipAddresses`).
 * @returns {{ addresses: string[], droppedOwn: number, droppedOdd: number, droppedOver: number }}
 */
function clientAddresses({ cmEmail = '', leadEmails = [], skipDomains = [], skipAddresses = [] } = {}) {
  const own = new Set(skipAddresses.map(low).filter(Boolean));
  const out = [];
  let droppedOwn = 0, droppedOdd = 0, droppedOver = 0;
  const raw = [...String(cmEmail || '').split(/[\s,;]+/), ...leadEmails.flatMap((e) => String(e || '').split(/[\s,;]+/))];
  for (const r of raw) {
    const a = low(r);
    if (!a || out.includes(a)) continue;
    if (!addressOk(a)) { droppedOdd++; continue; }
    if (own.has(a) || onDomain(a, skipDomains)) { droppedOwn++; continue; }
    if (out.length >= MAX_ADDRESSES) { droppedOver++; continue; }
    out.push(a);
  }
  return { addresses: out, droppedOwn, droppedOdd, droppedOver };
}

/* ── the Graph query texts ─────────────────────────────────────────────── */

/** $filter on one stamp field's value (store-side, exact, case-insensitive). */
function stampFilter(name, value) {
  if (!STAMP_KEY[name] && name !== 'TdotSendId') throw new Error('unknown stamp field');
  return `singleValueExtendedProperties/Any(ep: ep/id eq ${odataStr(propId(name))} and ep/value eq ${odataStr(value)})`;
}

/** $expand that reads the stamp fields back on each message (critique #4: the filter alone does not return them). */
function stampExpand(names = STAMP_NAMES) {
  return `singleValueExtendedProperties($filter=${names.map((n) => `id eq ${odataStr(propId(n))}`).join(' or ')})`;
}

/**
 * The $search value (with its outer double quotes) for the office mailbox: every client address as a
 * participant, OR the case ref in the subject. `quoted` puts the ref in escaped quotes (critique #23; KQL's
 * handling of hyphens is undocumented — the unquoted form is the fallback). THROWS on an address or a ref that
 * does not pass the plain-character checks — nothing else ever reaches the query.
 */
function searchValue(addresses, ref, { quoted = true } = {}) {
  const parts = [];
  for (const a of addresses || []) {
    if (!addressOk(a)) throw new Error('An address is not usable in a search.');
    parts.push(`participants:${low(a)}`);
  }
  if (ref) {
    if (!REF_RE.test(ref)) throw new Error('The case reference is not usable in a search.');
    parts.push(quoted ? `subject:\\"${ref}\\"` : `subject:${ref}`);
  }
  return parts.length ? `"${parts.join(' OR ')}"` : '';
}

/** $filter for the old no-reply inbox: FROM this one address only (decision 6). THROWS on an unusable address. */
function fromFilter(address) {
  if (!addressOk(address)) throw new Error('An address is not usable in a filter.');
  return `from/emailAddress/address eq ${odataStr(low(address))}`;
}

/* ── reading a message ─────────────────────────────────────────────────── */

/**
 * The stamp fields that came back on a message ($expand), or null when the message carries no expanded list.
 * Graph may answer the GUID upper-cased: ids compare without case.
 */
function parseStamp(msg) {
  const list = msg && msg.singleValueExtendedProperties;
  if (!Array.isArray(list)) return null;
  const out = { caseItemId: '', caseRef: '', leadId: '', to: '', kind: '' };
  const ns = NS.toLowerCase();
  for (const p of list) {
    const id = low(p && p.id);
    const at = id.indexOf(' name ');
    if (at === -1 || !id.includes(ns)) continue;
    const name = s(String(p.id).slice(at + 6));
    const key = STAMP_KEY[Object.keys(STAMP_KEY).find((n) => n.toLowerCase() === name.toLowerCase())];
    if (key) out[key] = s(p.value);
  }
  out.caseRef = out.caseRef.toUpperCase();
  out.to = out.to.toLowerCase();
  return out;
}

/** Did the expanded list carry this stamp field? (A message found BY that field must show it — else the expand was ignored.) */
function hasStampField(msg, name) {
  const list = msg && msg.singleValueExtendedProperties;
  return Array.isArray(list) && list.some((p) => low(p && p.id) === propId(name).toLowerCase());
}

const addrOf = (r) => low(r && r.emailAddress && r.emailAddress.address);
const nameOf = (r) => s(r && r.emailAddress && r.emailAddress.name).replace(/\s+/g, ' ');

/** The addresses on a message, lower-case. */
function participants(msg) {
  const list = (k) => ((msg && msg[k]) || []).map(addrOf).filter(Boolean);
  return { from: addrOf(msg && msg.from), sender: addrOf(msg && msg.sender), to: list('toRecipients'), cc: list('ccRecipients'), bcc: list('bccRecipients'), replyTo: list('replyTo') };
}

const FOLDER_KEYS = ['inbox', 'sentitems', 'junkemail', 'deleteditems', 'drafts', 'outbox'];
function folderOf(msg, folders) {
  const id = s(msg && msg.parentFolderId);
  if (!id || !folders) return 'other';
  return FOLDER_KEYS.find((k) => folders[k] && folders[k] === id) || 'other';
}

const FOLDER_LABEL = { inbox: 'Inbox', sentitems: 'Sent Items', junkemail: 'Junk', deleteditems: 'Deleted Items', drafts: 'Drafts', outbox: 'Outbox', other: 'Another folder', 'old-inbox': 'Old no-reply inbox' };

const KIND_LABEL = {
  'case-ready': 'Case ready (portal link)', 'portal-link': 'Portal link', sponsor: 'Sponsor email', 'q-correction': 'Questionnaire correction',
  revision: 'Revision request', 'missing-fields': 'Missing questionnaire answers', 'doc-reminder': 'Document reminder', 'doc-reminder-auto': 'Document reminder (automatic)',
  escalation: 'Reminder (escalation)', 'final-notice': 'Final notice', 'payment-request': 'Payment request', receipt: 'Payment receipt',
  'retainer-signed': 'Signed retainer', retainer: 'Retainer', 'intake-ack': 'Inquiry received', 'consult-form': 'Consultation form received',
  'booking-invite': 'Booking invite', 'booking-reminder': 'Booking reminder', webinar: 'Webinar', 'consult-links': 'Consultation links',
  'consult-package': 'Consultation package', 'consult-reminder': 'Consultation reminder', 'preconsult-chase': 'Pre-consultation reminder',
  'consult-agreement': 'Consultation agreement', 'consult-agreement-signed': 'Signed consultation agreement', test: 'Test email',
};
const kindLabel = (k) => (k ? (KIND_LABEL[k] || k.replace(/-/g, ' ')) : '');

/** Is this address one of ours (staff, the office / old mailboxes, the app's own addresses)? */
function isOwn(address, keys) {
  const a = low(address);
  if (!a) return false;
  if ((keys.ownAddresses || []).includes(a) || a === low(keys.officeBox) || a === low(keys.oldBox)) return true;
  return onDomain(a, keys.ownDomains || []);
}

const WARN = {
  notOnFile: '⚠ Not from the client email on file.',
  shared: (refs) => `⚠ This address is also on ${refs.join(', ')} — this email may belong there.`,
  sharedUnknown: '⚠ Could not check whether this address is used on other cases.',
};

/**
 * THE match rule — the same function for the list and for opening one email. PURE.
 * @param {object} msg  a Graph message (+ _src 'office'|'old', _proved {caseItemId, leadId, to}, _stampKnown)
 * @param {object} keys { itemId, caseRef, leadIds[], addresses[], officeBox, oldBox, ownDomains[], ownAddresses[],
 *                        folders {inbox,sentitems,…}, shared {addr: {cases[], failed}}, q1Complete }
 * @returns {{ include: boolean, out?: string, how?: 'stamp'|'ref'|'address', direction?: string, folder: string,
 *             junk?: boolean, deleted?: boolean, matchedAddress?: string, warnings?: string[], sharedRisk?: boolean,
 *             stamped?: boolean, kind?: string }}
 */
function matchMessage(msg, keys) {
  const src = msg && msg._src === 'old' ? 'old' : 'office';
  const folder = src === 'old' ? 'old-inbox' : folderOf(msg, keys.folders);
  const out = (why) => ({ include: false, out: why, folder });
  if (!msg) return out('empty');
  if (msg.isDraft || folder === 'drafts' || folder === 'outbox') return out('draft');

  const I = s(keys.itemId), R = s(keys.caseRef).toUpperCase();
  const L = new Set((keys.leadIds || []).map(s));
  const A = new Set((keys.addresses || []).map(low));
  const p = participants(msg);
  const fromAddr = p.from || p.sender;

  // 1. the stamp: what the expand read back, and what a filter proved
  const exp = parseStamp(msg);
  const proved = msg._proved || {};
  const known = !!msg._stampKnown;
  let stamp = null;
  if (known || proved.caseItemId || proved.leadId || proved.to) {
    stamp = {
      caseItemId: s(proved.caseItemId) || (exp ? exp.caseItemId : ''),
      caseRef: exp ? exp.caseRef : '',
      leadId: s(proved.leadId) || (exp ? exp.leadId : ''),
      to: low(proved.to) || (exp ? exp.to : ''),
      kind: exp ? exp.kind : '',
    };
    if (!Object.values(stamp).some(Boolean)) stamp = null;   // read, and none there: not an app copy
  }

  let how = '', matched = '', addrBased = false;
  if (stamp) {
    if (stamp.caseItemId) { if (stamp.caseItemId !== I) return out('other-record'); how = 'stamp'; }
    else if (stamp.caseRef) { if (stamp.caseRef !== R) return out('other-record'); how = 'stamp'; }
    else if (stamp.leadId) { if (!L.has(stamp.leadId)) return out('other-record'); how = 'stamp'; }
    else if (!known) return out('unverified');           // found by TdotTo only — its case / lead fields were not read
    else if (stamp.to && A.has(stamp.to)) { how = 'stamp'; matched = stamp.to; addrBased = true; }
    else return out('no-match');
  } else {
    if (src === 'old' && !A.has(p.from)) return out('old-not-client');   // decision 6: from a client address only
    const refs = subjectCaseRefs(msg.subject);
    if (refs.length) {
      if (!refs.includes(R)) return out('other-case-ref');
      how = 'ref';
    } else {
      if (p.to.length + p.cc.length > BULK_RECIPIENTS) return out('bulk');
      const hit = [p.from, p.sender, ...p.to, ...p.cc, ...p.replyTo].find((a) => a && A.has(a));
      if (!hit) return out(p.bcc.some((a) => A.has(a)) ? 'bcc-only' : 'no-match');
      // an email the office mailbox SENT whose stamp was never read: in Sent Items while the stamp look failed / was
      // cut, or anywhere else at all (the stamp look reads Sent Items only — an app copy moved to Deleted Items /
      // Archive may be another record's). Fail closed. Opening reads the stamp itself (_stampKnown), so list and
      // open agree; the cost is a staff answer moved out of Sent Items counts as "not checked" in the list.
      if (src === 'office' && fromAddr === low(keys.officeBox) && !known && (folder !== 'sentitems' || !keys.q1Complete)) return out('unverified');
      how = 'address'; matched = hit; addrBased = true;
    }
  }

  const own = isOwn(fromAddr, keys);
  const direction = src === 'old' ? 'client-old' : own ? (stamp ? 'app' : 'staff') : 'client';
  const warnings = [];
  if ((direction === 'client' || direction === 'client-old') && how !== 'address' && !A.has(fromAddr)) warnings.push(WARN.notOnFile);
  let sharedRisk = false;
  if (addrBased) {
    const sh = (keys.shared || {})[matched];
    if (sh && sh.cases && sh.cases.length) { warnings.push(WARN.shared(sh.cases.slice(0, 3))); sharedRisk = true; }
    else if (sh && sh.failed) { warnings.push(WARN.sharedUnknown); sharedRisk = true; }
  }
  return {
    include: true, how, direction, folder, junk: folder === 'junkemail', deleted: folder === 'deleteditems',
    matchedAddress: matched, warnings, sharedRisk, stamped: !!stamp, kind: stamp ? stamp.kind : '',
  };
}

/** When the email happened: sent items by their send time, the rest by arrival. */
function whenOf(msg, folder) {
  const sent = s(msg && msg.sentDateTime), recv = s(msg && msg.receivedDateTime);
  return folder === 'sentitems' ? (sent || recv) : (recv || sent);
}

/**
 * One entry per internet message id (lower-cased): the office copy before the old inbox's, an ordinary folder
 * before Junk / Deleted. Newest first. PURE.
 * @param {{msg, m}[]} entries   matched entries
 */
function dedupeSort(entries) {
  const rank = (e) => (e.msg._src === 'old' ? 4 : 0) + (e.m.deleted ? 2 : 0) + (e.m.junk ? 1 : 0);
  const byKey = new Map();
  for (const e of entries) {
    const k = low(e.msg.internetMessageId) || `${e.msg._src}:${e.msg.id}`;
    const have = byKey.get(k);
    if (!have || rank(e) < rank(have)) byKey.set(k, e);
  }
  return [...byKey.values()].sort((a, b) => whenOf(b.msg, b.m.folder).localeCompare(whenOf(a.msg, a.m.folder)) || s(b.msg.id).localeCompare(s(a.msg.id)));
}

const person = (r) => ({ name: nameOf(r), address: addrOf(r) });

/**
 * The list's short preview: Graph's bodyPreview through the SAME link-secret hiding as the opened email (critique
 * #10) — a pre-consult chase shows its link as text, so a portal / lead code would otherwise sit in the preview.
 * Hidden first, then cut: a link cut off at the end keeps its ?t= hidden.
 */
function previewOf(msg) {
  return textSegments(s(msg && msg.bodyPreview).replace(/\s+/g, ' ')).map((x) => (x.u != null ? x.u : x.t)).join('').slice(0, 200);
}

/** What the list shows for one email (no body; a short preview). PURE. */
function listItem(msg, m) {
  return {
    source: msg._src === 'old' ? 'old' : 'office',
    id: s(msg.id),
    direction: m.direction,
    folder: m.folder, folderLabel: FOLDER_LABEL[m.folder] || FOLDER_LABEL.other,
    junk: !!m.junk, deleted: !!m.deleted,
    when: whenOf(msg, m.folder),
    from: person(msg.from || msg.sender),
    to: ((msg.toRecipients || []).map(addrOf).filter(Boolean)).slice(0, 5),
    toMore: Math.max(0, (msg.toRecipients || []).length - 5),
    subject: s(msg.subject),
    preview: previewOf(msg),
    hasAttachments: !!msg.hasAttachments,
    how: m.how, kind: kindLabel(m.kind),
    warnings: m.warnings || [],
    sharedRisk: !!m.sharedRisk,
    webLink: msg._src !== 'old' && /^https:\/\//i.test(s(msg.webLink)) ? s(msg.webLink) : '',
  };
}

module.exports = {
  STAMP_NAMES, SELECT, MAX_ADDRESSES, BULK_RECIPIENTS, REF_RE, ITEM_ID_RE, FOLDER_KEYS, FOLDER_LABEL, WARN,
  addressOk, clientAddresses, stampFilter, stampExpand, searchValue, fromFilter, parseStamp, hasStampField,
  participants, folderOf, isOwn, matchMessage, whenOf, dedupeSort, listItem, kindLabel, person,
};
