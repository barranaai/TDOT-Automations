// The case page's Emails tab (Stage 2a, Faran 2026-11-19) — the PURE rules: who "this client" is, the Graph
// query texts, the ONE match rule (list and open), dedupe + order, and link hiding in the plain text.
// Every name, address and id here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../src/services/caseEmailsRules');
const L = require('../src/utils/caseEmailLinks');

const NSU = '{EA1CFD10-69D2-41C0-A9FC-1FC4288E039E}';   // Graph may answer the GUID upper-cased
const addr = (a, name = '') => ({ emailAddress: { address: a, name } });
const prop = (name, value) => ({ id: `String ${NSU} Name ${name}`, value });
const FOLDERS = { inbox: 'F-IN', sentitems: 'F-SENT', junkemail: 'F-JUNK', deleteditems: 'F-DEL', drafts: 'F-DRAFT', outbox: 'F-OUT' };
const CLIENT = 'asha.sample@example.org';

function keys(o = {}) {
  return {
    itemId: '900', caseRef: '2026-SPE-016', leadIds: ['11'], addresses: [CLIENT],
    officeBox: 'info@tdotimm.com', oldBox: 'noreply@tdotimm.com', ownDomains: ['tdotimm.com'],
    ownAddresses: ['info@tdotimm.com', 'noreply@tdotimm.com', 'payments@example.net'],
    folders: FOLDERS, shared: {}, q1Complete: true, ...o,
  };
}
function msg(o = {}) {
  return {
    id: 'AAMk-1', internetMessageId: '<m1@example.org>', subject: 'Question about my file', bodyPreview: 'Hi',
    from: addr(CLIENT, 'Asha Sample'), sender: addr(CLIENT), toRecipients: [addr('info@tdotimm.com')], ccRecipients: [], bccRecipients: [], replyTo: [],
    sentDateTime: '2026-11-20T10:00:00Z', receivedDateTime: '2026-11-20T10:00:02Z', hasAttachments: false, parentFolderId: 'F-IN', isDraft: false,
    _src: 'office', _proved: {}, _stampKnown: false, ...o,
  };
}
/** An app copy in the office Sent Items. */
const appCopy = (o = {}) => msg({ from: addr('info@tdotimm.com'), sender: addr('info@tdotimm.com'), toRecipients: [addr(CLIENT)], parentFolderId: 'F-SENT', subject: 'Documents still needed — 2026-SPE-016 · Document Collection Started', ...o });

/* ══ the match table ══════════════════════════════════════════════════════════ */

test('stamp: this case (proved by the filter) → in, "app"; another case (read back) → out, counted as another record', () => {
  let m = R.matchMessage(appCopy({ _proved: { caseItemId: '900' } }), keys());
  assert.equal(m.include, true); assert.equal(m.how, 'stamp'); assert.equal(m.direction, 'app'); assert.equal(m.stamped, true);
  m = R.matchMessage(appCopy({ _proved: { to: CLIENT }, _stampKnown: true, singleValueExtendedProperties: [prop('TdotCaseItemId', '901'), prop('TdotTo', CLIENT)] }), keys());
  assert.deepEqual([m.include, m.out], [false, 'other-record'], 'a copy to this address stamped for ANOTHER case never shows (critique #4)');
  // the subject naming THIS case does not rescue a stamp for another case
  m = R.matchMessage(appCopy({ _stampKnown: true, singleValueExtendedProperties: [prop('TdotCaseItemId', '901')] }), keys());
  assert.equal(m.out, 'other-record');
});

test('stamp: case ref only (no item id) this / other; lead this / other; TdotTo only — read back vs not checked', () => {
  const k = keys();
  assert.equal(R.matchMessage(appCopy({ _stampKnown: true, singleValueExtendedProperties: [prop('TdotCaseRef', '2026-spe-016')] }), k).include, true);
  assert.equal(R.matchMessage(appCopy({ _stampKnown: true, singleValueExtendedProperties: [prop('TdotCaseRef', '2026-SPE-017')] }), k).out, 'other-record');
  assert.equal(R.matchMessage(appCopy({ _proved: { leadId: '11' } }), k).how, 'stamp');
  assert.equal(R.matchMessage(appCopy({ _stampKnown: true, singleValueExtendedProperties: [prop('TdotLeadId', '12'), prop('TdotTo', CLIENT)] }), k).out, 'other-record');
  // a pre-lead copy (no case, no lead) to this client's address: in — but only when its other fields WERE read
  let m = R.matchMessage(appCopy({ _proved: { to: CLIENT }, _stampKnown: true, singleValueExtendedProperties: [prop('TdotTo', CLIENT), prop('TdotKind', 'consult-form')] }), k);
  assert.deepEqual([m.include, m.how, m.kind, m.matchedAddress], [true, 'stamp', 'consult-form', CLIENT]);
  m = R.matchMessage(appCopy({ _proved: { to: CLIENT } }), k);
  assert.deepEqual([m.include, m.out], [false, 'unverified'], 'found by TdotTo, case/lead fields not read back → not shown');
  // read back, and nothing of ours on it → not an app copy: the ordinary rules
  m = R.matchMessage(appCopy({ _stampKnown: true, singleValueExtendedProperties: [], subject: 'Re: your passport' }), k);
  assert.deepEqual([m.include, m.how, m.direction], [true, 'address', 'staff']);
});

test('no stamp, a ref in the subject: this ref → in; only other refs → out even when the address matches; both → in', () => {
  const k = keys();
  let m = R.matchMessage(msg({ subject: 'Re: Documents — 2026-SPE-016 · Document Collection Started', from: addr('sponsor@example.net') }), k);
  assert.deepEqual([m.include, m.how, m.direction], [true, 'ref', 'client']);
  assert.deepEqual(m.warnings, [R.WARN.notOnFile], 'by ref from an address not on file → the warning');
  m = R.matchMessage(msg({ subject: 'Re: Documents — 2026-SPE-017' }), k);
  assert.deepEqual([m.include, m.out], [false, 'other-case-ref'], 'one person, two applications: the other case\'s email stays there');
  m = R.matchMessage(msg({ subject: 'About 2026-SPE-017 and 2026-spe-016' }), k);
  assert.equal(m.include, true); assert.equal(m.how, 'ref'); assert.deepEqual(m.warnings, []);
});

test('no stamp, no ref: a participant (from, sender, to, cc, reply-to) → in; bcc only → out; more than 10 to+cc → out', () => {
  const k = keys();
  assert.equal(R.matchMessage(msg(), k).how, 'address');
  assert.equal(R.matchMessage(msg({ from: addr('form@example.net'), sender: addr('form@example.net'), replyTo: [addr(CLIENT)] }), k).how, 'address', 'a web form (reply-to)');
  assert.equal(R.matchMessage(msg({ from: addr('staff.one@tdotimm.com'), sender: addr('staff.one@tdotimm.com'), toRecipients: [addr('x@example.net')], ccRecipients: [addr(CLIENT)] }), k).direction, 'staff');
  let m = R.matchMessage(msg({ from: addr('news@example.net'), sender: addr('news@example.net'), toRecipients: [addr('x@example.net')], bccRecipients: [addr(CLIENT)] }), k);
  assert.deepEqual([m.include, m.out], [false, 'bcc-only'], 'bcc is never used for matching');
  const many = Array.from({ length: 11 }, (_, i) => addr(`p${i}@example.net`));
  m = R.matchMessage(msg({ from: addr('news@example.net'), sender: addr('news@example.net'), toRecipients: many.slice(0, 6), ccRecipients: [...many.slice(6), addr(CLIENT)] }), k);
  assert.deepEqual([m.include, m.out], [false, 'bulk']);
  assert.equal(R.matchMessage(msg({ from: addr('someone@example.net'), sender: addr('someone@example.net'), toRecipients: [addr('info@tdotimm.com')] }), k).out, 'no-match');
});

test('direction is by the FROM address, never the folder (critique #12); the folder is only a badge', () => {
  const k = keys();
  // a client email someone moved into Sent Items, or an Archive folder → still "client"
  assert.equal(R.matchMessage(msg({ parentFolderId: 'F-SENT' }), k).direction, 'client');
  assert.equal(R.matchMessage(msg({ parentFolderId: 'F-ARCHIVE' }), k).folder, 'other');
  assert.equal(R.matchMessage(msg({ parentFolderId: 'F-ARCHIVE' }), k).direction, 'client');
  // a staff member's own mailbox copying info@ lands in the Inbox → "staff"
  assert.equal(R.matchMessage(msg({ from: addr('staff.one@tdotimm.com'), sender: addr('staff.one@tdotimm.com'), toRecipients: [addr(CLIENT)], parentFolderId: 'F-IN' }), k).direction, 'staff');
  // one of our own addresses outside our domain → not "client"
  assert.equal(R.matchMessage(msg({ from: addr('payments@example.net'), sender: addr('payments@example.net'), toRecipients: [addr(CLIENT)] }), k).direction, 'staff');
});

test('folders: drafts / outbox / isDraft out; Junk in (flagged); Deleted Items in (badged)', () => {
  const k = keys();
  for (const o of [{ isDraft: true }, { parentFolderId: 'F-DRAFT' }, { parentFolderId: 'F-OUT' }]) assert.equal(R.matchMessage(msg(o), k).out, 'draft');
  let m = R.matchMessage(msg({ parentFolderId: 'F-JUNK' }), k);
  assert.deepEqual([m.include, m.junk, m.deleted, m.folder], [true, true, false, 'junkemail']);
  m = R.matchMessage(msg({ parentFolderId: 'F-DEL' }), k);
  assert.deepEqual([m.include, m.junk, m.deleted], [true, false, true]);
});

test('shared address: "also on case X" on address-only matches (and pre-lead TdotTo copies); a failed check says so — never "not shared"', () => {
  let m = R.matchMessage(msg(), keys({ shared: { [CLIENT]: { cases: ['2026-SPE-017'], failed: false } } }));
  assert.deepEqual(m.warnings, ['⚠ This address is also on 2026-SPE-017 — this email may belong there.']); assert.equal(m.sharedRisk, true);
  m = R.matchMessage(msg(), keys({ shared: { [CLIENT]: { cases: [], failed: true } } }));
  assert.deepEqual(m.warnings, [R.WARN.sharedUnknown]); assert.equal(m.sharedRisk, true);
  m = R.matchMessage(msg(), keys({ shared: { [CLIENT]: { cases: [], failed: false } } }));
  assert.deepEqual([m.warnings, m.sharedRisk], [[], false]);
  // matched by ref or by the case stamp: the shared flag does not apply
  m = R.matchMessage(msg({ subject: 'Re: 2026-SPE-016' }), keys({ shared: { [CLIENT]: { cases: ['2026-SPE-017'] } } }));
  assert.equal(m.sharedRisk, false);
  m = R.matchMessage(appCopy({ _proved: { to: CLIENT }, _stampKnown: true, singleValueExtendedProperties: [prop('TdotTo', CLIENT)] }), keys({ shared: { [CLIENT]: { cases: ['2026-SPE-017'] } } }));
  assert.equal(m.sharedRisk, true, 'a pre-lead app copy found by address carries the shared flag too');
});

test('an office-sent copy found only by the search, while the TdotTo look was incomplete → not shown (its stamp could not be ruled out)', () => {
  const staffAnswer = msg({ from: addr('info@tdotimm.com'), sender: addr('info@tdotimm.com'), toRecipients: [addr(CLIENT)], parentFolderId: 'F-SENT', subject: 'Re: question' });
  assert.equal(R.matchMessage(staffAnswer, keys({ q1Complete: false })).out, 'unverified');
  const m = R.matchMessage(staffAnswer, keys({ q1Complete: true }));
  assert.deepEqual([m.include, m.direction], [true, 'staff']);
});

test('the old no-reply inbox: only messages FROM a client address (decision 6), labelled client-old; another case\'s ref stays out', () => {
  const k = keys();
  let m = R.matchMessage(msg({ _src: 'old', toRecipients: [addr('noreply@tdotimm.com')] }), k);
  assert.deepEqual([m.include, m.direction, m.folder], [true, 'client-old', 'old-inbox']);
  m = R.matchMessage(msg({ _src: 'old', from: addr('notifications@otter.example'), sender: addr('notifications@otter.example'), toRecipients: [addr('noreply@tdotimm.com')], ccRecipients: [addr(CLIENT)] }), k);
  assert.deepEqual([m.include, m.out], [false, 'old-not-client'], 'a client in cc is not enough — never anything else from that mailbox');
  m = R.matchMessage(msg({ _src: 'old', subject: 'Re: 2026-SPE-016' , from: addr('sponsor@example.net'), sender: addr('sponsor@example.net') }), k);
  assert.equal(m.out, 'old-not-client', 'even with this case\'s ref, a non-client sender is not read from the old mailbox');
  m = R.matchMessage(msg({ _src: 'old', subject: 'Re: 2026-SPE-017' }), k);
  assert.equal(m.out, 'other-case-ref');
});

test('dedupe by internet message id (office copy first; Inbox before Junk / Deleted), newest first (sent items by send time)', () => {
  const k = keys();
  const e = (o) => { const m = msg(o); return { msg: m, m: R.matchMessage(m, k) }; };
  const out = R.dedupeSort([
    e({ id: 'old-1', _src: 'old', internetMessageId: '<A@x>', receivedDateTime: '2026-11-21T09:00:00Z' }),
    e({ id: 'del-1', parentFolderId: 'F-DEL', internetMessageId: '<a@X>', receivedDateTime: '2026-11-21T09:00:00Z' }),
    e({ id: 'in-1', internetMessageId: '<a@x>', receivedDateTime: '2026-11-21T09:00:00Z' }),
    e({ id: 'in-2', internetMessageId: '<b@x>', receivedDateTime: '2026-11-19T09:00:00Z' }),
    e({ id: 'sent-1', internetMessageId: '<c@x>', from: addr('info@tdotimm.com'), toRecipients: [addr(CLIENT)], parentFolderId: 'F-SENT', sentDateTime: '2026-11-20T08:00:00Z', receivedDateTime: '2026-11-25T08:00:00Z' }),
  ]);
  assert.deepEqual(out.map((x) => x.msg.id), ['in-1', 'sent-1', 'in-2']);
});

test('listItem: no body, a short preview, Outlook link for office mail only, the kind as words', () => {
  const k = keys();
  const m = appCopy({ _proved: { caseItemId: '900' }, _stampKnown: true, singleValueExtendedProperties: [prop('TdotKind', 'doc-reminder')], bodyPreview: 'x'.repeat(500), webLink: 'https://outlook.office365.com/owa/?ItemID=1', body: { content: 'SECRET BODY' } });
  const it = R.listItem(m, R.matchMessage(m, k));
  assert.equal(it.preview.length, 200); assert.equal(it.kind, 'Document reminder'); assert.equal(it.webLink, 'https://outlook.office365.com/owa/?ItemID=1');
  assert.ok(!JSON.stringify(it).includes('SECRET BODY'));
  const o = msg({ _src: 'old', webLink: 'https://outlook.office365.com/owa/?ItemID=2' });
  assert.equal(R.listItem(o, R.matchMessage(o, k)).webLink, '', 'nobody opens the old mailbox in Outlook');
});

/* ══ who "this client" is ═════════════════════════════════════════════════════ */

test('clientAddresses: Client Master first (split on , ; space), leads after, lower-cased, de-duplicated, at most 5; never ours; odd characters dropped', () => {
  const r = R.clientAddresses({
    cmEmail: ' Asha.Sample@Example.org ; second@example.org',
    leadEmails: ['asha.sample@example.org', 'staff.one@tdotimm.com', 'payments@example.net', 'we"ird@example.org', 'a(b)@example.org', 'l1@example.org', 'l2@example.org', 'l3@example.org', 'l4@example.org'],
    skipDomains: ['tdotimm.com'], skipAddresses: ['payments@example.net'],
  });
  assert.deepEqual(r.addresses, ['asha.sample@example.org', 'second@example.org', 'l1@example.org', 'l2@example.org', 'l3@example.org']);
  assert.deepEqual([r.droppedOwn, r.droppedOdd, r.droppedOver], [2, 2, 1]);
  assert.deepEqual(R.clientAddresses({ cmEmail: 'info@tdotimm.com', skipDomains: ['tdotimm.com'] }).addresses, []);
});

/* ══ the Graph query texts ════════════════════════════════════════════════════ */

const NS = '{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e}';
test('filter / expand texts are exact; the search refuses anything but plain addresses and a real ref (no KQL / OData injection)', () => {
  assert.equal(R.stampFilter('TdotCaseItemId', '900'), `singleValueExtendedProperties/Any(ep: ep/id eq 'String ${NS} Name TdotCaseItemId' and ep/value eq '900')`);
  assert.equal(R.stampFilter('TdotTo', "o'brien@example.org"), `singleValueExtendedProperties/Any(ep: ep/id eq 'String ${NS} Name TdotTo' and ep/value eq 'o''brien@example.org')`);
  assert.throws(() => R.stampFilter('Anything', 'x'));
  assert.equal(R.stampExpand(), `singleValueExtendedProperties($filter=${['TdotCaseItemId', 'TdotCaseRef', 'TdotLeadId', 'TdotTo', 'TdotKind'].map((n) => `id eq 'String ${NS} Name ${n}'`).join(' or ')})`);
  assert.equal(R.searchValue([CLIENT, 'b@example.org'], '2026-SPE-016'), '"participants:asha.sample@example.org OR participants:b@example.org OR subject:\\"2026-SPE-016\\""');
  assert.equal(R.searchValue([CLIENT], '2026-SPE-016', { quoted: false }), '"participants:asha.sample@example.org OR subject:2026-SPE-016"');
  assert.equal(R.searchValue([], ''), '');
  for (const bad of ['a b@example.org', 'a"@example.org', 'a@example.org) OR (x', 'x@y', '<a@example.org>', 'a\\b@example.org']) assert.throws(() => R.searchValue([bad], ''), bad);
  for (const bad of ['2026-SPE-016" OR "x', 'SPE-016', '2026-SPE-01']) assert.throws(() => R.searchValue([], bad), bad);
  assert.equal(R.fromFilter('Asha.Sample@Example.org'), "from/emailAddress/address eq 'asha.sample@example.org'");
  assert.throws(() => R.fromFilter("x' or 1 eq 1"));
});

test('parseStamp: ids compare without case; other namespaces ignored; no expanded list → null', () => {
  assert.equal(R.parseStamp({}), null);
  assert.deepEqual(R.parseStamp({ singleValueExtendedProperties: [prop('TdotCaseItemId', '900'), prop('TdotTo', 'A@Example.org'), prop('TdotCaseRef', '2026-spe-016'), { id: 'String {00020386-0000-0000-C000-000000000046} Name TdotLeadId', value: '5' }] }),
    { caseItemId: '900', caseRef: '2026-SPE-016', leadId: '', to: 'a@example.org', kind: '' });
  assert.equal(R.hasStampField({ singleValueExtendedProperties: [prop('TdotTo', 'x')] }, 'TdotTo'), true);
  assert.equal(R.hasStampField({ singleValueExtendedProperties: [prop('TdotTo', 'x')] }, 'TdotCaseItemId'), false);
});

/* ══ link hiding (critique #10) ═══════════════════════════════════════════════ */

function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
}
const PORTAL_CODE = 'f3c9a1b27d4e8f60a5b3c2d1e0f9a8b7';

test('our own hosts: the portal link is TEXT, never clickable, with the code hidden (render host, app host, BASE_URL / RENDER_URL hosts)', () => {
  withEnv({ BASE_URL: 'https://portal.example-firm.test', RENDER_URL: 'https://render-host.example-firm.test', DOCUMENSO_BASE_URL: null }, () => {
    for (const host of ['tdot-automations.onrender.com', 'app.tdotimm.com', 'portal.example-firm.test', 'render-host.example-firm.test']) {
      const segs = L.textSegments(`Open your portal: https://${host}/client/2026-SPE-016?t=${PORTAL_CODE} today.`);
      assert.deepEqual(segs, [{ t: `Open your portal: https://${host}/client/2026-SPE-016?t=…hidden today.` }], host);
    }
    // a long path segment on our host is hidden too (a code in the path)
    assert.deepEqual(L.shownLink(`https://app.tdotimm.com/x/${PORTAL_CODE}/y`), { t: 'https://app.tdotimm.com/x/…hidden/y' });
  });
});

test('Documenso: the signing link (secret in the PATH, on their host) is text with the secret hidden', () => {
  withEnv({ DOCUMENSO_BASE_URL: 'https://sign.example-esign.test/api/v2' }, () => {
    assert.deepEqual(L.shownLink('https://app.documenso.com/sign/AbCdEfGhIjKlMnOpQrStUvWx'), { t: 'https://app.documenso.com/sign/…hidden' });
    assert.deepEqual(L.shownLink('https://sign.example-esign.test/sign/AbCdEfGhIjKlMnOpQrStUvWx'), { t: 'https://sign.example-esign.test/sign/…hidden' });
  });
});

test('Safe Links are unwrapped first, then the rules apply; a third-party link stays clickable with its secrets hidden', () => {
  const inner = `https://app.tdotimm.com/client/2026-SPE-016?t=${PORTAL_CODE}`;
  const wrapped = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(inner)}&data=05%7C02%7Cabc&sdata=XYZ&reserved=0`;
  assert.deepEqual(L.shownLink(wrapped), { t: 'https://app.tdotimm.com/client/2026-SPE-016?t=…hidden' });
  assert.deepEqual(L.shownLink(`https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://www.canada.ca/en.html')}&data=1`), { u: 'https://www.canada.ca/en.html' });
  assert.deepEqual(L.shownLink('https://zoom.example.test/j/123?pwd=abc123&lang=en&token=zzz&access_token=q&X-Amz-Signature=s'), { u: 'https://zoom.example.test/j/123?pwd=…hidden&lang=en&token=…hidden&access_token=…hidden&X-Amz-Signature=…hidden' });
  assert.deepEqual(L.shownLink('https://example.test/a#access_token=abc&x=1'), { u: 'https://example.test/a#access_token=…hidden&x=1' });
  assert.deepEqual(L.shownLink('https://www.canada.ca/en/immigration.html'), { u: 'https://www.canada.ca/en/immigration.html' });
});

test('textSegments: only http, https and mailto become links; trailing punctuation and Outlook\'s <…> stay text; mailto keeps the address only', () => {
  assert.deepEqual(L.textSegments('See https://www.canada.ca/a. Or (https://www.canada.ca/b) or <https://www.canada.ca/c>'), [
    { t: 'See ' }, { u: 'https://www.canada.ca/a' }, { t: '. Or (' }, { u: 'https://www.canada.ca/b' }, { t: ') or <' }, { u: 'https://www.canada.ca/c' }, { t: '>' },
  ]);
  assert.deepEqual(L.textSegments('mail mailto:a@example.org?subject=x&body=y now'), [{ t: 'mail ' }, { u: 'mailto:a@example.org' }, { t: ' now' }]);
  assert.deepEqual(L.textSegments('javascript:alert(1) data:text/html,x ftp://x.example'), [{ t: 'javascript:alert(1) data:text/html,x ftp://x.example' }]);
  assert.deepEqual(L.textSegments(''), []);
  assert.deepEqual(L.textSegments('a\r\nb'), [{ t: 'a\nb' }]);
  const big = L.textSegments('x'.repeat(L.MAX_TEXT + 10));
  assert.equal(big.length, 1); assert.ok(big[0].t.endsWith('(the rest of this email is not shown — open it in Outlook)'));
});

/* ══ review fixes (2026-11-19) ════════════════════════════════════════════════ */

test('textSegments stays linear on a run of closing brackets — a crafted body (200,000 ")" / "]" / ").") is done in well under a second, never minutes', () => {
  for (const tail of [')', ']', ').', '].']) {
    const body = 'see https://www.canada.ca/a' + tail.repeat(Math.ceil(L.MAX_TEXT / tail.length));
    const t0 = process.hrtime.bigint();
    const segs = L.textSegments(body);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `${JSON.stringify(tail)}: ${ms.toFixed(0)} ms`);
    assert.deepEqual(segs[1], { u: 'https://www.canada.ca/a' }, tail);
  }
  // the same answers as before: a balanced bracket stays in the address, an unbalanced one and the punctuation do not
  assert.deepEqual(L.textSegments('(see https://en.example.org/wiki/A_(b)).'), [{ t: '(see ' }, { u: 'https://en.example.org/wiki/A_(b)' }, { t: ').' }]);
  assert.deepEqual(L.textSegments('[https://www.canada.ca/x?a=[1]]'), [{ t: '[' }, { u: 'https://www.canada.ca/x?a=[1]' }, { t: ']' }]);
});

test('the list preview hides link secrets exactly like the opened email (critique #10) — the pre-consult chase\'s lead code never shows', () => {
  const code = 'LEAD-' + 'a1b2c3d4'.repeat(4);
  const k = keys();
  const chase = appCopy({ _proved: { leadId: '11' }, subject: 'Please complete your pre-consultation form',
    bodyPreview: `Hi Asha, please complete your pre-consultation form before your call:\r\n\r\nhttps://tdot-automations.onrender.com/consult/11?t=${code}\r\n\r\nReply to this email if you have questions.` });
  const it = R.listItem(chase, R.matchMessage(chase, k));
  assert.ok(!it.preview.includes('a1b2c3d4'), it.preview);
  assert.ok(it.preview.includes('https://tdot-automations.onrender.com/consult/11?t=…hidden'));
  assert.ok(it.preview.length <= 200);
  // a link cut off at the end of Graph's preview keeps its secret hidden; a third-party token too
  const cut = msg({ bodyPreview: 'x '.repeat(70) + `https://tdot-automations.onrender.com/consult/11?t=${code.slice(0, 14)}` });
  const cutPrev = R.listItem(cut, R.matchMessage(cut, k)).preview;
  assert.ok(!cutPrev.includes('a1b2'), cutPrev); assert.ok(cutPrev.endsWith('?t=…hidden'), cutPrev);
  const third = msg({ bodyPreview: 'Join:  https://zoom.example.test/j/1?pwd=Secret123&lang=en' });
  assert.equal(R.listItem(third, R.matchMessage(third, k)).preview, 'Join: https://zoom.example.test/j/1?pwd=…hidden&lang=en');
});

test('an email the office mailbox SENT, outside Sent Items, whose stamp was never read → not shown ("not checked"); once its stamp is read (open) the stamp decides — list and open agree', () => {
  const k = keys({ q1Complete: true });
  for (const folder of ['F-DEL', 'F-JUNK', 'F-IN', 'F-ARCHIVE']) {
    const moved = appCopy({ parentFolderId: folder, subject: 'Your consultation is booked' });   // no ref in the subject
    assert.equal(R.matchMessage(moved, k).out, 'unverified', folder);
  }
  // opening reads the stamp field by field (_stampKnown): another lead's booking copy → another record
  const other = appCopy({ parentFolderId: 'F-DEL', subject: 'Your consultation is booked', _stampKnown: true, singleValueExtendedProperties: [prop('TdotLeadId', '999'), prop('TdotTo', CLIENT), prop('TdotKind', 'booking-invite')] });
  assert.equal(R.matchMessage(other, k).out, 'other-record');
  // a staff answer moved to Deleted Items: read, no stamp → shown when opened, "Staff", badged
  const staff = appCopy({ parentFolderId: 'F-DEL', subject: 'Re: question', _stampKnown: true, singleValueExtendedProperties: [] });
  const m = R.matchMessage(staff, k);
  assert.deepEqual([m.include, m.direction, m.deleted], [true, 'staff', true]);
  // in Sent Items with a complete stamp look: still a staff answer; the client's own mail in Deleted Items is unaffected
  assert.equal(R.matchMessage(appCopy({ subject: 'Re: question' }), k).direction, 'staff');
  const del = R.matchMessage(msg({ parentFolderId: 'F-DEL' }), k);
  assert.deepEqual([del.include, del.direction], [true, 'client']);
});
