// The case page's Emails tab (Stage 2a, Faran 2026-11-19) — the Graph read service against a FAKE Graph and a
// fake Monday: the exact requests per source, the old inbox's from-address rule, partial sources, the shared
// address, re-matching on open, a moved email, attachments, throttling, and no client address in any log line.
// Offline (the no-network guard backs it). Every name, address and id here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/caseEmailsService');
const R = require('../src/services/caseEmailsRules');

const NS = '{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e}';
const NSU = NS.toUpperCase();
const CLIENT = 'asha.sample@example.org';
const OFFICE = 'info@tdotimm.com', OLD = 'noreply@tdotimm.com';
const FOLDERS = { inbox: 'F-IN', sentitems: 'F-SENT', junkemail: 'F-JUNK', deleteditems: 'F-DEL', drafts: 'F-DRAFT', outbox: 'F-OUT' };
const addr = (a, name = '') => ({ emailAddress: { address: a, name } });
const prop = (name, value) => ({ id: `String ${NSU} Name ${name}`, value });
const ROW = { assignees: { personIds: ['42'], teamIds: [] }, recordUrl: '', texts: { text_mm0xw6bp: 'Asha.Sample@example.org', text_mm142s49: '2026-SPE-016' } };

function M(id, o = {}) {
  return {
    id, internetMessageId: `<${id}@mail.example>`, conversationId: 'c1', subject: 'Question about my file', bodyPreview: 'Hi there',
    from: addr(CLIENT, 'Asha Sample'), sender: addr(CLIENT), toRecipients: [addr(OFFICE)], ccRecipients: [], bccRecipients: [], replyTo: [],
    sentDateTime: '2026-11-20T10:00:00Z', receivedDateTime: '2026-11-20T10:00:02Z', hasAttachments: false, parentFolderId: 'F-IN', isDraft: false,
    webLink: `https://outlook.office365.com/owa/?ItemID=${id}`, ...o,
  };
}
const APP = (id, o = {}) => M(id, { from: addr(OFFICE), sender: addr(OFFICE), toRecipients: [addr(CLIENT)], parentFolderId: 'F-SENT', subject: 'Documents still needed — 2026-SPE-016 · Document Collection Started', ...o });
const gErr = (status, code = 'ErrorX', headers = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers, data: { error: { code, message: `Mailbox ${CLIENT} in query participants:${CLIENT} refused` } } } });

/**
 * A fake Graph keyed by the DECODED url. `routes` answers each kind of request; unknown → throws.
 * Records every url (decoded), the headers, and the highest number of calls in flight per mailbox.
 */
function harness({ q1 = {}, search = [], searchFail, recent = [], recentFail, old = {}, oldFail, messages = {}, stamps = {}, attachments = {}, byImid = {}, folderFail, q1Fail = {}, expandRefused = false, quotedRefused = false, delay = 0,
  leadSet = { leads: [{ leadId: '11', via: 'link', email: CLIENT }, { leadId: '12', via: 'anchor', email: 'second@example.org' }], multipleClaimants: false, claimantCount: 2, partial: false },
  casesByEmail = async () => [], env = {} } = {}) {
  const h = { urls: [], headers: [], logs: [], inFlight: {}, maxInFlight: {}, sleeps: [], drops: 0, monday: [] };
  const keepIo = { ...svc.io };
  const keepEnv = {};
  const allEnv = { MS_FROM_EMAIL: OLD, CLIENT_MAIL_FROM: undefined, EMAIL_LEADS_MAILBOX: undefined, CASE_VISIBILITY: undefined, ADMIN_EMAILS: undefined, ...env };
  for (const k of Object.keys(allEnv)) { keepEnv[k] = process.env[k]; if (allEnv[k] === undefined) delete process.env[k]; else process.env[k] = allEnv[k]; }
  const con = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => h.logs.push(a.join(' '));
  const answer = (u) => {
    const box = (u.match(/\/users\/([^/]+)\//) || [])[1];
    let m;
    if ((m = u.match(/\/users\/info@tdotimm\.com\/mailFolders\/(\w+)\?\$select=id$/))) { if (folderFail) throw folderFail; return { id: FOLDERS[m[1]] }; }
    if (/\/users\/noreply@tdotimm\.com\/mailFolders\/inbox\?\$select=id$/.test(u)) return { id: 'O-IN' };
    if ((m = u.match(/\/mailFolders\/sentitems\/messages\?\$filter=singleValueExtendedProperties\/Any\(ep: ep\/id eq 'String \{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e\} Name (\w+)' and ep\/value eq '([^']*)'\)&\$top=50&\$select=([^&]+)(&\$expand=(.*))?$/))) {
      const k = `${m[1]}=${m[2]}`;
      if (q1Fail[k]) throw q1Fail[k];
      if (m[4] && expandRefused) throw gErr(400, 'ErrorInvalidProperty');
      const v = q1[k] || [];
      return { value: m[4] ? v : v.map(({ singleValueExtendedProperties, ...rest }) => rest) };
    }
    if ((m = u.match(/\/users\/info@tdotimm\.com\/messages\?\$search=(.*)&\$top=100&\$select=/))) {
      if (searchFail) throw searchFail;
      if (quotedRefused && m[1].includes('\\"')) throw gErr(400, 'ErrorInvalidSearch');
      return { value: search };
    }
    if (/\/users\/info@tdotimm\.com\/messages\?\$filter=receivedDateTime ge \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ&\$orderby=receivedDateTime desc&\$top=50&\$select=/.test(u)) { if (recentFail) throw recentFail; return { value: recent }; }
    if ((m = u.match(/\/users\/noreply@tdotimm\.com\/mailFolders\/inbox\/messages\?\$filter=from\/emailAddress\/address eq '([^']+)'&\$top=50&\$select=/))) { if (oldFail) throw oldFail; return { value: old[m[1]] || [] }; }
    if ((m = u.match(/\/users\/[^/]+\/messages\/([A-Za-z0-9_=-]+)\?\$select=id&\$expand=singleValueExtendedProperties\(\$filter=id eq 'String \{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e\} Name (\w+)'\)$/))) {
      const st = stamps[m[1]] || {};
      return { id: m[1], ...(st[m[2]] != null ? { singleValueExtendedProperties: [prop(m[2], st[m[2]])] } : {}) };
    }
    if ((m = u.match(/\/users\/[^/]+\/messages\/([A-Za-z0-9_=-]+)\/attachments\?\$select=id,name,contentType,size,isInline$/))) return { value: attachments[m[1]] || [] };
    if ((m = u.match(/\/users\/[^/]+\/messages\?\$filter=internetMessageId eq '([^']+)'&\$top=5&\$select=/))) return { value: byImid[m[1]] || [] };
    if ((m = u.match(/\/users\/([^/]+)\/messages\/([A-Za-z0-9_=-]+)\?\$select=/))) {
      const msg = messages[`${m[1]}/${m[2]}`];
      if (msg instanceof Error) throw msg;
      if (!msg) throw gErr(404, 'ErrorItemNotFound');
      return msg;
    }
    throw new Error('unexpected ' + u + ' ' + box);
  };
  Object.assign(svc.io, {
    token: async () => 'tok',
    dropToken: () => { h.drops++; },
    sleep: async (ms) => { h.sleeps.push(ms); },
    get: async (url, headers) => {
      const u = decodeURIComponent(url);
      const box = (u.match(/\/users\/([^/]+)\//) || [])[1] || '?';
      h.urls.push(u); h.headers.push(headers);
      h.inFlight[box] = (h.inFlight[box] || 0) + 1;
      h.maxInFlight[box] = Math.max(h.maxInFlight[box] || 0, h.inFlight[box]);
      try { if (delay) await new Promise((r) => setTimeout(r, delay)); return { data: await answer(u) }; }
      finally { h.inFlight[box]--; }
    },
    stream: async (url) => { const u = decodeURIComponent(url); h.urls.push(u); return { data: { kind: 'stream', url: u } }; },
    readCaseRow: async (id) => { h.monday.push(['row', id]); return ROW; },
    caseLeadSet: async (id, ref, o) => { h.monday.push(['leads', id, ref, o]); if (leadSet instanceof Error) throw leadSet; return leadSet; },
    casesByEmail: async (a) => { h.monday.push(['shared', a]); return casesByEmail(a); },
  });
  svc._reset();
  h.done = () => {
    Object.assign(svc.io, keepIo); Object.assign(console, con); svc._reset();
    for (const k of Object.keys(keepEnv)) { if (keepEnv[k] === undefined) delete process.env[k]; else process.env[k] = keepEnv[k]; }
  };
  return h;
}
async function run(opts, fn) { const h = harness(opts); try { return await fn(h); } finally { h.done(); } }
const LIST = { itemId: '900', caseRef: '2026-SPE-016', row: ROW };
const ADMIN = { isAdmin: true, email: 'boss@tdotimm.com' };
const STAFF = { isAdmin: false, email: 'staff.one@tdotimm.com', userId: '42', teamIds: [] };

/* ══ the exact Graph requests per source ══════════════════════════════════════ */

test('the list: the exact Graph requests per source — fixed mailboxes, the stamp filters with the read-back, one $search (no $filter/$orderby with it), the 30-minute look, the old inbox by FROM only', async () => {
  await run({}, async (h) => {
    const out = await svc.list(LIST);
    assert.equal(out.complete, true);
    const sel = R.SELECT;
    const exp = `singleValueExtendedProperties($filter=${['TdotCaseItemId', 'TdotCaseRef', 'TdotLeadId', 'TdotTo', 'TdotKind'].map((n) => `id eq 'String ${NS} Name ${n}'`).join(' or ')})`;
    const sf = (n, v) => `singleValueExtendedProperties/Any(ep: ep/id eq 'String ${NS} Name ${n}' and ep/value eq '${v}')`;
    const G = 'https://graph.microsoft.com/v1.0/users/';
    const expected = [
      ...['inbox', 'sentitems', 'junkemail', 'deleteditems', 'drafts', 'outbox'].map((f) => `${G}${OFFICE}/mailFolders/${f}?$select=id`),
      `${G}${OFFICE}/mailFolders/sentitems/messages?$filter=${sf('TdotCaseItemId', '900')}&$top=50&$select=${sel}&$expand=${exp}`,
      `${G}${OFFICE}/mailFolders/sentitems/messages?$filter=${sf('TdotLeadId', '11')}&$top=50&$select=${sel}&$expand=${exp}`,
      `${G}${OFFICE}/mailFolders/sentitems/messages?$filter=${sf('TdotLeadId', '12')}&$top=50&$select=${sel}&$expand=${exp}`,
      `${G}${OFFICE}/mailFolders/sentitems/messages?$filter=${sf('TdotTo', CLIENT)}&$top=50&$select=${sel}&$expand=${exp}`,
      `${G}${OFFICE}/mailFolders/sentitems/messages?$filter=${sf('TdotTo', 'second@example.org')}&$top=50&$select=${sel}&$expand=${exp}`,
      `${G}${OFFICE}/messages?$search="participants:${CLIENT} OR participants:second@example.org OR subject:\\"2026-SPE-016\\""&$top=100&$select=${sel}`,
      `${G}${OLD}/mailFolders/inbox/messages?$filter=from/emailAddress/address eq '${CLIENT}'&$top=50&$select=${sel}`,
      `${G}${OLD}/mailFolders/inbox/messages?$filter=from/emailAddress/address eq 'second@example.org'&$top=50&$select=${sel}`,
    ];
    for (const e of expected) assert.ok(h.urls.includes(e), 'missing: ' + e);
    const recent = h.urls.filter((u) => u.includes('receivedDateTime ge'));
    assert.equal(recent.length, 1);
    assert.match(recent[0], new RegExp(`^${G}${OFFICE}/messages\\?\\$filter=receivedDateTime ge \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ&\\$orderby=receivedDateTime desc&\\$top=50&\\$select=`));
    assert.equal(h.urls.length, expected.length + 1, 'nothing else is read');
    // the folder ids one at a time, in order, before anything else of the office mailbox
    assert.deepEqual(h.urls.filter((u) => u.includes(`/users/${OFFICE}/`)).slice(0, 6), expected.slice(0, 6));
    // only the two mailboxes, and $search is never mixed with $filter / $orderby
    assert.deepEqual([...new Set(h.urls.map((u) => u.match(/\/users\/([^/]+)\//)[1]))].sort(), [OFFICE, OLD]);
    for (const u of h.urls.filter((x) => x.includes('$search='))) assert.ok(!/\$filter|\$orderby/.test(u));
    assert.ok(h.headers.every((x) => x.Authorization === 'Bearer tok'));
    // Monday: the lead set asked WITH emails; each client address checked for other cases
    assert.deepEqual(h.monday.find((x) => x[0] === 'leads').slice(1, 3), ['900', '2026-SPE-016']);
    assert.equal(h.monday.find((x) => x[0] === 'leads')[3].withEmail, undefined, 'the io wrapper adds withEmail — see the wrapper test');
    assert.deepEqual(h.monday.filter((x) => x[0] === 'shared').map((x) => x[1]), [CLIENT, 'second@example.org']);
  });
});

test('the io wrapper asks caseLeadSet WITH emails and the row read with the client email + ref columns (the notes panel never does)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/caseEmailsService.js'), 'utf8');
  assert.ok(src.includes("caseLeadSet(itemId, caseRef, { ...o, withEmail: true })"));
  assert.ok(src.includes("readCaseRow(itemId, { extraColumns: [CM_EMAIL_COL, CM_REF_COL] })"));
  assert.equal(svc.CM_EMAIL_COL, 'text_mm0xw6bp'); assert.equal(svc.CM_REF_COL, 'text_mm142s49');
  const cm = require('fs').readFileSync(require.resolve('../src/services/clientMasterService.js'), 'utf8');
  assert.ok(cm.includes("const CM_EMAIL_COL   = 'text_mm0xw6bp';") && cm.includes("const CASE_REF_COL       = 'text_mm142s49';"), 'the same columns as clientMasterService');
});

test('mailboxes are fixed: office = CLIENT_MAIL_FROM when usable, else the email reader\'s mailbox; old = MS_FROM_EMAIL unless it is the office one', async () => {
  await run({ env: { CLIENT_MAIL_FROM: 'clients@tdotimm.com' } }, async () => {
    assert.equal(svc.officeMailbox(), 'clients@tdotimm.com'); assert.equal(svc.oldMailbox(), OLD);
    assert.deepEqual(Object.keys(svc.MAILBOX), ['office', 'old']);
  });
  await run({ env: { CLIENT_MAIL_FROM: 'someone@gmail.com', EMAIL_LEADS_MAILBOX: 'Office@TDOTimm.com' } }, async () => {
    assert.equal(svc.officeMailbox(), 'office@tdotimm.com', 'a CLIENT_MAIL_FROM outside our domain is ignored');
  });
  await run({ env: { MS_FROM_EMAIL: OFFICE } }, async () => { assert.equal(svc.oldMailbox(), '', 'the same mailbox is never read twice'); });
  await run({ env: { MS_FROM_EMAIL: undefined } }, async (h) => {
    assert.equal(svc.oldMailbox(), '');
    const out = await svc.list(LIST);
    assert.equal(out.sources.old.skipped, true); assert.equal(out.sources.old.ok, true);
    assert.ok(!h.urls.some((u) => u.includes('noreply')));
  });
});

/* ══ what shows ═══════════════════════════════════════════════════════════════ */

test('a full list: this case\'s app copy, a lead-stage copy, the client\'s reply, a staff answer, Junk, the old inbox — other records and unchecked copies left out (counted), duplicates once, newest first', async () => {
  const q1 = {
    'TdotCaseItemId=900': [APP('a1', { sentDateTime: '2026-11-21T09:00:00Z', singleValueExtendedProperties: [prop('TdotCaseItemId', '900'), prop('TdotKind', 'doc-reminder')] })],
    'TdotLeadId=11': [APP('a2', { subject: 'Your consultation is booked', sentDateTime: '2026-11-10T09:00:00Z', singleValueExtendedProperties: [prop('TdotLeadId', '11'), prop('TdotKind', 'booking-invite')] })],
    [`TdotTo=${CLIENT}`]: [
      APP('a1', { sentDateTime: '2026-11-21T09:00:00Z', singleValueExtendedProperties: [prop('TdotCaseItemId', '900'), prop('TdotTo', CLIENT)] }),
      APP('a3', { subject: 'Documents still needed — 2026-SPE-017', singleValueExtendedProperties: [prop('TdotCaseItemId', '901'), prop('TdotTo', CLIENT)] }),   // her OTHER case
      APP('a4', { subject: 'We received your form', sentDateTime: '2026-11-01T09:00:00Z', singleValueExtendedProperties: [prop('TdotTo', CLIENT), prop('TdotKind', 'consult-form')] }),
    ],
  };
  const search = [
    M('c1', { subject: 'Re: Documents still needed — 2026-SPE-016 · Document Collection Started', receivedDateTime: '2026-11-22T15:00:00Z' }),
    M('s1', { from: addr(OFFICE), sender: addr(OFFICE), toRecipients: [addr(CLIENT)], parentFolderId: 'F-SENT', subject: 'Re: question', sentDateTime: '2026-11-20T11:00:00Z' }),
    M('j1', { parentFolderId: 'F-JUNK', subject: 'hello', receivedDateTime: '2026-11-19T08:00:00Z' }),
    M('x1', { subject: 'Re: 2026-SPE-017 papers' }),                    // only the other case's ref
    M('d1', { isDraft: true, parentFolderId: 'F-DRAFT' }),
    APP('a3', { subject: 'Documents still needed — 2026-SPE-017' }),  // the same copy, found again by the search
  ];
  const old = { [CLIENT]: [M('o1', { toRecipients: [addr(OLD)], parentFolderId: 'O-IN', receivedDateTime: '2026-10-01T08:00:00Z' }), M('o2', { internetMessageId: '<c1@mail.example>', parentFolderId: 'O-IN' })] };
  await run({ q1, search, old }, async () => {
    const out = svc.forViewer(await svc.list(LIST), ADMIN);
    assert.deepEqual(out.items.map((i) => [i.id, i.direction, i.how]), [
      ['c1', 'client', 'ref'], ['a1', 'app', 'stamp'], ['s1', 'staff', 'address'], ['j1', 'client', 'address'], ['a2', 'app', 'stamp'], ['a4', 'app', 'stamp'], ['o1', 'client-old', 'address'],
    ]);
    assert.equal(out.counts.otherRecords, 1, 'the copy STAMPED for her other case ("belong to other records"); the email naming only the other case is simply not here');
    assert.equal(out.items.find((i) => i.id === 'j1').junk, true);
    assert.equal(out.items.find((i) => i.id === 'a1').kind, 'Document reminder');
    assert.equal(out.items.find((i) => i.id === 'o1').source, 'old');
    assert.ok(!out.items.some((i) => i.id === 'o2'), 'the old copy of an email already shown from the office mailbox is not shown twice');
    assert.equal(out._keys, undefined, 'the keys never leave the server');
    assert.deepEqual(out.keys.addresses, [{ address: CLIENT, sharedWith: [], checkFailed: false }, { address: 'second@example.org', sharedWith: [], checkFailed: false }]);
  });
});

test('the old no-reply inbox: anything that is not FROM a client address is never shown, whatever the fake returns', async () => {
  const old = { [CLIENT]: [
    M('o1', { parentFolderId: 'O-IN' }),
    M('o2', { from: addr('no-reply@otter.example'), sender: addr('no-reply@otter.example'), toRecipients: [addr(OLD)], ccRecipients: [addr(CLIENT)], subject: 'Your meeting notes', parentFolderId: 'O-IN' }),
    M('o3', { from: addr('mailer-daemon@outlook.example'), sender: addr('mailer-daemon@outlook.example'), subject: 'Undeliverable: Documents — 2026-SPE-016', parentFolderId: 'O-IN' }),
  ] };
  await run({ old }, async () => {
    const out = await svc.list(LIST);
    assert.deepEqual(out.items.map((i) => i.id), ['o1']);
  });
});

test('a lead set naming different people → only the Client Master email, only leads linked by Client Master id, a banner; the set unreadable → the same, its own banner', async () => {
  const leadSet = { leads: [{ leadId: '11', via: 'link', email: CLIENT }, { leadId: '12', via: 'anchor', email: 'ravi@example.net' }], multipleClaimants: true, claimantCount: 2, partial: false };
  await run({ leadSet }, async (h) => {
    const out = await svc.list(LIST);
    assert.deepEqual(out.keys.addresses.map((a) => a.address), [CLIENT]);
    assert.equal(out.keys.leadCount, 1);
    assert.ok(!h.urls.some((u) => u.includes('ravi@example.net') || u.includes("'12'")), 'the other person\'s address and lead are never read');
    assert.match(out.keys.banners[0], /linked to 2 client records that name different people, so only the Client Master email is used/);
  });
  await run({ leadSet: { ...leadSet, multipleClaimants: false, partial: true } }, async () => {
    const out = await svc.list(LIST);
    assert.deepEqual(out.keys.addresses.map((a) => a.address), [CLIENT]);
    assert.match(out.keys.banners[0], /Not every consultation linked to this case could be checked/);
  });
  await run({ leadSet: new Error('Monday down') }, async (h) => {
    const out = await svc.list(LIST);
    assert.deepEqual(out.keys.addresses.map((a) => a.address), [CLIENT]);
    assert.equal(out.keys.leadCount, 0);
    assert.match(out.keys.banners[0], /consultations linked to this case could not be read/);
    assert.ok(h.logs.some((l) => /\[CaseEmails\] 2026-SPE-016: the consultations of the case could not be read/.test(l)));
  });
});

test('shared address: another case found → "also on"; the check failing → "could not check" (never "not shared"); CASE_VISIBILITY=assigned hides all but subject/date for a non-admin', async () => {
  const search = [M('c1', { subject: 'hello', bodyPreview: 'my passport number is …', hasAttachments: true })];
  await run({ search, casesByEmail: async (a) => (a === CLIENT ? [{ id: '900', caseRef: '2026-SPE-016' }, { id: '901', caseRef: '2026-SPE-017' }] : []), env: { CASE_VISIBILITY: 'assigned' } }, async () => {
    const raw = await svc.list(LIST);
    assert.deepEqual(raw.keys.addresses[0], { address: CLIENT, sharedWith: ['2026-SPE-017'], checkFailed: false });
    const it = raw.items[0];
    assert.deepEqual(it.warnings, ['⚠ This address is also on 2026-SPE-017 — this email may belong there.']);
    const staffView = svc.forViewer(raw, STAFF).items[0];
    assert.equal(staffView.restricted, true);
    assert.deepEqual([staffView.preview, staffView.from.address, staffView.to, staffView.hasAttachments, staffView.webLink], ['', '', [], false, '']);
    assert.equal(staffView.subject, 'hello');
    assert.equal(svc.forViewer(raw, ADMIN).items[0].restricted, undefined, 'an admin sees it all');
  });
  await run({ search, casesByEmail: async () => { throw new Error(`monday down for ${CLIENT}`); } }, async (h) => {
    const out = await svc.list(LIST);
    assert.equal(out.keys.addresses[0].checkFailed, true);
    assert.deepEqual(out.items[0].warnings, ['⚠ Could not check whether this address is used on other cases.']);
    assert.ok(h.logs.every((l) => !l.includes('@example')), 'the failure is never logged with the address');
  });
});

/* ══ partial sources: never "no emails" ═══════════════════════════════════════ */

test('one source failing → a partial list with what was found, the failed part named with its hint; never complete; kept 15 s only (Retry reads again)', async () => {
  const q1 = { 'TdotCaseItemId=900': [APP('a1', { singleValueExtendedProperties: [prop('TdotCaseItemId', '900')] })] };
  await run({ q1, searchFail: gErr(503, 'ServiceUnavailable', { 'retry-after': '120' }), oldFail: gErr(403, 'ErrorAccessDenied') }, async (h) => {
    const out = await svc.list(LIST);
    assert.equal(out.complete, false);
    assert.deepEqual(out.items.map((i) => i.id), ['a1']);
    assert.equal(out.sources.office.ok, false);
    assert.deepEqual(out.sources.office.failed, [{ part: 'office mail search', status: 503, code: 'ServiceUnavailable', hint: 'Microsoft is busy — try again in 120 s.' }]);
    assert.equal(out.sources.old.ok, false);
    assert.match(out.sources.old.failed[0].hint, /not allowed to read this mailbox/);
    assert.ok(h.logs.some((l) => l.includes('[CaseEmails] 2026-SPE-016: office mail search could not be read (503 ServiceUnavailable)')));
    assert.ok(h.logs.every((l) => !l.includes('@example') && !/refused/.test(l)), 'never Graph\'s message (it repeats the query)');
    // kept 15 s only
    const n = h.urls.length;
    await svc.list(LIST);
    assert.equal(h.urls.length, n, 'within 15 s: the same answer');
    const now = Date.now(); const keep = svc.io.now; svc.io.now = () => now + 16000;
    try { await svc.list(LIST); assert.ok(h.urls.length > n, 'after 15 s an incomplete list is read again'); } finally { svc.io.now = keep; }
  });
  await run({ folderFail: gErr(401, 'InvalidAuthenticationToken') }, async (h) => {
    const out = await svc.list(LIST);
    assert.equal(out.sources.office.ok, false); assert.equal(out.complete, false);
    assert.equal(h.drops, 1, 'a 401 is retried once with a fresh token');
  });
});

test('a complete list is kept 90 s; Refresh reads again only after 15 s; two loads at once are read once', async () => {
  await run({ delay: 5 }, async (h) => {
    const [a, b] = await Promise.all([svc.list(LIST), svc.list(LIST)]);
    const n = h.urls.length;
    assert.equal(a.loadedAt, b.loadedAt);
    assert.equal(h.urls.filter((u) => u.endsWith('/mailFolders/inbox?$select=id') && u.includes(OFFICE)).length, 1, 'one build for both');
    await svc.list({ ...LIST, refresh: true });
    assert.equal(h.urls.length, n, 'Refresh within 15 s answers the same list');
    const t = Date.now(); const keep = svc.io.now;
    try {
      svc.io.now = () => t + 60000; await svc.list(LIST); assert.equal(h.urls.length, n, 'within 90 s: no new read');
      await svc.list({ ...LIST, refresh: true }); assert.ok(h.urls.length > n, 'Refresh after 15 s reads again');
    } finally { svc.io.now = keep; }
  });
});

test('Microsoft refusing the read-back ($expand) on a stamp list → once more without it: copies proved by case / lead show, TdotTo-only copies are "not checked"', async () => {
  const q1 = {
    'TdotCaseItemId=900': [APP('a1')],
    [`TdotTo=${CLIENT}`]: [APP('a1'), APP('a3', { subject: 'Documents — 2026-SPE-017' })],
  };
  await run({ q1, expandRefused: true }, async (h) => {
    const out = await svc.list(LIST);
    assert.deepEqual(out.items.map((i) => i.id), ['a1']);
    assert.equal(out.counts.unverified, 1);
    assert.ok(h.urls.some((u) => u.includes("Name TdotTo' and ep/value eq") && !u.includes('$expand')), 'retried without the expand');
  });
});

test('Microsoft refusing the quoted ref in $search → once more with the ref unquoted', async () => {
  await run({ quotedRefused: true, search: [M('c1', { subject: 'Re: 2026-SPE-016' })] }, async (h) => {
    const out = await svc.list(LIST);
    assert.equal(out.complete, true);
    assert.deepEqual(out.items.map((i) => i.id), ['c1']);
    assert.ok(h.urls.some((u) => u.includes('OR subject:2026-SPE-016"&$top=100')));
  });
});

test('throttling: Retry-After ≤ 5 s → wait and retry once; longer → that part fails with the wait in its hint; never more than 2 calls at once per mailbox', async () => {
  let n = 0;
  await run({ recentFail: undefined, delay: 3 }, async (h) => {
    const keep = svc.io.get;
    svc.io.get = async (url, headers) => { if (decodeURIComponent(url).includes('receivedDateTime ge') && ++n === 1) throw gErr(429, 'TooManyRequests', { 'retry-after': '2' }); return keep(url, headers); };
    try {
      const out = await svc.list(LIST);
      assert.equal(out.complete, true); assert.deepEqual(h.sleeps, [2000]);
      assert.ok(h.maxInFlight[OFFICE] <= 2, `office: ${h.maxInFlight[OFFICE]} at once`);
      assert.ok(h.maxInFlight[OLD] <= 2);
    } finally { svc.io.get = keep; }
  });
  await run({ recentFail: gErr(429, 'TooManyRequests', { 'retry-after': '30' }) }, async (h) => {
    const out = await svc.list(LIST);
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(out.sources.office.failed.map((f) => f.hint), ['Microsoft is busy — try again in 30 s.']);
  });
});

test('the app copies for this case are paged (next links on Graph only) up to a cap; past it the list says older app emails are not shown', async () => {
  const pages = Array.from({ length: 7 }, (_, i) => ({ value: [APP(`p${i}`, { singleValueExtendedProperties: [prop('TdotCaseItemId', '900')] })], '@odata.nextLink': `https://graph.microsoft.com/v1.0/users/${OFFICE}/mailFolders/sentitems/messages?page=${i + 1}` }));
  await run({}, async (h) => {
    const keep = svc.io.get;
    svc.io.get = async (url, headers) => {
      const u = decodeURIComponent(url);
      if (u.includes("Name TdotCaseItemId' and ep/value eq '900'")) return { data: pages[0] };
      const m = u.match(/sentitems\/messages\?page=(\d+)$/);
      if (m) return { data: pages[Number(m[1])] };
      return keep(url, headers);
    };
    try {
      const out = await svc.list(LIST);
      assert.equal(out.items.length, 6, 'six pages read');
      assert.equal(out.sources.office.cappedApp, true);
    } finally { svc.io.get = keep; }
  });
});

/* ══ one email: fetched again and matched again for THIS case ═════════════════ */

test('open: an email of ANOTHER case (stamp read field by field) is refused even with a valid id; this case\'s copy opens with its text, hidden app links, the whole thread on request, and the attachment list', async () => {
  const body = `Hello,\nUpload here: https://app.tdotimm.com/client/2026-SPE-016?t=f3c9a1b27d4e8f60a5b3c2d1e0f9a8b7\nThanks`;
  const messages = {
    [`${OFFICE}/a1`]: APP('a1', { hasAttachments: true, uniqueBody: { content: body }, body: { content: body + '\n\n> earlier' } }),
    [`${OFFICE}/a3`]: APP('a3', { subject: 'Documents — 2026-SPE-017', uniqueBody: { content: 'other case' }, body: { content: 'other case' } }),
  };
  const stamps = { a1: { TdotCaseItemId: '900', TdotKind: 'doc-reminder' }, a3: { TdotCaseItemId: '901', TdotTo: CLIENT } };
  const attachments = { a1: [
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-1', name: 'passport.pdf', contentType: 'application/pdf', size: 1258291, isInline: false },
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-2', name: 'form.HTML', contentType: 'text/html', size: 200, isInline: false },
    { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'AT-3', name: 'Shared file', contentType: '', size: 0, isInline: false },
    { '@odata.type': '#microsoft.graph.itemAttachment', id: 'AT-4', name: 'Forwarded email', contentType: '', size: 3000, isInline: false },
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-5', name: 'big.zip', contentType: 'application/zip', size: 40 * 1024 * 1024, isInline: false },
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-6', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true },
  ] };
  await run({ messages, stamps, attachments }, async (h) => {
    await assert.rejects(svc.open({ ...LIST, source: 'office', id: 'a3', viewer: ADMIN }), (e) => e.notFound && e.why === 'other-record');
    const r = await svc.open({ ...LIST, source: 'office', id: 'a1', viewer: ADMIN });
    assert.equal(r.item.direction, 'app'); assert.equal(r.item.how, 'stamp');
    assert.deepEqual(r.unique, [{ t: 'Hello,\nUpload here: https://app.tdotimm.com/client/2026-SPE-016?t=…hidden\nThanks' }]);
    assert.ok(r.whole && r.whole.length === 1 && r.whole[0].t.endsWith('> earlier'));
    assert.deepEqual(r.attachments.map((a) => [a.name, a.kind, a.downloadable, a.note]), [
      ['passport.pdf', 'file', true, ''],
      ['form.HTML', 'file', false, 'This file type can\'t be downloaded here — open it in Outlook.'],
      ['Shared file', 'reference', false, 'A link — open it in Outlook.'],
      ['Forwarded email.eml', 'item', true, ''],
      ['big.zip', 'file', false, 'Too large to download here — open it in Outlook.'],
    ]);
    assert.equal(r.inlineImages, 1);
    assert.match(r.imidHash, /^[0-9a-f]{10}$/);
    // the message GET asks for plain text; the stamp was read one documented field at a time
    const get = h.urls.findIndex((u) => u.includes(`/messages/a1?$select=${R.SELECT},uniqueBody,body`));
    assert.ok(get >= 0); assert.equal(h.headers[get].Prefer, 'outlook.body-content-type="text"');
    assert.equal(h.urls.filter((u) => u.includes('/messages/a1?$select=id&$expand=')).length, 5);
    assert.ok(h.urls.includes(`https://graph.microsoft.com/v1.0/users/${OFFICE}/messages/a1/attachments?$select=id,name,contentType,size,isInline`), 'never contentBytes');
  });
});

test('open: a client email outside this case\'s addresses / refs, an unknown id, and the old mailbox outside its Inbox are all "not on this case"', async () => {
  const messages = {
    [`${OFFICE}/n1`]: M('n1', { from: addr('stranger@example.net'), sender: addr('stranger@example.net'), uniqueBody: { content: 'x' }, body: { content: 'x' } }),
    [`${OLD}/o1`]: M('o1', { parentFolderId: 'O-SENT', uniqueBody: { content: 'x' }, body: { content: 'x' } }),
    [`${OLD}/o2`]: M('o2', { parentFolderId: 'O-IN', uniqueBody: { content: 'from the client' }, body: { content: 'from the client' } }),
  };
  await run({ messages }, async () => {
    await assert.rejects(svc.open({ ...LIST, source: 'office', id: 'n1', viewer: ADMIN }), (e) => e.notFound && e.why === 'no-match');
    await assert.rejects(svc.open({ ...LIST, source: 'office', id: 'zz', viewer: ADMIN }), (e) => e.notFound && e.why === 'gone');
    await assert.rejects(svc.open({ ...LIST, source: 'old', id: 'o1', viewer: ADMIN }), (e) => e.notFound && e.why === 'not-old-inbox');
    const r = await svc.open({ ...LIST, source: 'old', id: 'o2', viewer: ADMIN });
    assert.equal(r.item.direction, 'client-old');
    await assert.rejects(svc.open({ ...LIST, source: 'elsewhere', id: 'o2', viewer: ADMIN }), (e) => e.notFound && e.why === 'bad-request');
    await assert.rejects(svc.open({ ...LIST, source: 'office', id: 'a/b', viewer: ADMIN }), (e) => e.notFound && e.why === 'bad-request');
  });
});

test('open: a MOVED email (404 on its id) is found again by its internet message id — only if the list showed it — and matched again', async () => {
  const search = [M('c1', { subject: 'Re: 2026-SPE-016' })];
  const moved = M('c1-new', { internetMessageId: '<c1@mail.example>', subject: 'Re: 2026-SPE-016', parentFolderId: 'F-DEL', uniqueBody: { content: 'moved text' }, body: { content: 'moved text' }, hasAttachments: true });
  await run({ search, messages: { [`${OFFICE}/c1-new`]: moved }, byImid: { '<c1@mail.example>': [moved] }, attachments: { 'c1-new': [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-9', name: 'scan.pdf', contentType: 'application/pdf', size: 10, isInline: false }] } }, async (h) => {
    await svc.list(LIST);
    const r = await svc.open({ ...LIST, source: 'office', id: 'c1', viewer: ADMIN });
    assert.equal(r.item.id, 'c1-new'); assert.equal(r.item.deleted, true);
    assert.deepEqual(r.unique, [{ t: 'moved text' }]);
    assert.ok(h.urls.some((u) => u.includes("/messages?$filter=internetMessageId eq '<c1@mail.example>'&$top=5")));
    // its attachment downloads by the NEW id the pop-up was given
    const a = await svc.attachment({ ...LIST, source: 'office', id: 'c1-new', att: 'AT-9', viewer: ADMIN });
    assert.equal(a.name, 'scan.pdf'); assert.equal(a.stream.url, `https://graph.microsoft.com/v1.0/users/${OFFICE}/messages/c1-new/attachments/AT-9/$value`);
  });
  await run({ byImid: { '<c1@mail.example>': [moved] } }, async () => {
    await assert.rejects(svc.open({ ...LIST, source: 'office', id: 'c1', viewer: ADMIN }), (e) => e.notFound && e.why === 'gone', 'never listed → never looked for');
  });
});

test('attachment: matched again first; blocked types refused; after a move found again by name AND size (critique #22), else "reopen"', async () => {
  const atts = [
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-1', name: 'جواز السفر.pdf', contentType: 'application/pdf', size: 1000, isInline: false },
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-2', name: 'evil.svg', contentType: 'image/svg+xml', size: 10, isInline: false },
    { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'AT-3', name: 'link', size: 0, isInline: false },
  ];
  const messages = { [`${OFFICE}/c1`]: M('c1', { subject: 'Re: 2026-SPE-016', hasAttachments: true, uniqueBody: { content: 'x' }, body: { content: 'x' } }) };
  await run({ messages, attachments: { c1: atts } }, async () => {
    const ok = await svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-1', viewer: ADMIN });
    assert.equal(ok.name, 'جواز السفر.pdf');
    assert.deepEqual((await svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-2', viewer: ADMIN })).refused, { status: 415, error: 'This file type can\'t be downloaded here — open it in Outlook.' });
    assert.deepEqual((await svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-3', viewer: ADMIN })).refused, { status: 409, error: 'A link — open it in Outlook.' });
    await assert.rejects(svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-404', viewer: ADMIN }), (e) => e.notFound);
    await assert.rejects(svc.attachment({ ...LIST, source: 'office', id: 'c1', att: '../x', viewer: ADMIN }), (e) => e.notFound && e.why === 'bad-request');
  });
  // moved after the pop-up listed it: the old attachment id is gone; the same name + size is taken
  const moved = M('c1-new', { internetMessageId: '<c1@mail.example>', subject: 'Re: 2026-SPE-016', hasAttachments: true });
  await run({ messages, search: [M('c1', { subject: 'Re: 2026-SPE-016' })], attachments: { c1: atts, 'c1-new': [{ ...atts[0], id: 'AT-1-NEW' }, { ...atts[0], id: 'AT-1-COPY', size: 999 }] }, byImid: { '<c1@mail.example>': [moved] } }, async () => {
    await svc.list(LIST);
    await svc.open({ ...LIST, source: 'office', id: 'c1', viewer: ADMIN });   // lists AT-1 by its name + size
    delete messages[`${OFFICE}/c1`];                                      // …then the email is moved
    const r = await svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-1', viewer: ADMIN });
    assert.equal(r.stream.url, `https://graph.microsoft.com/v1.0/users/${OFFICE}/messages/c1-new/attachments/AT-1-NEW/$value`);
    await assert.rejects(svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-2', viewer: ADMIN }), (e) => e.notFound && e.why === 'attachment-gone');
  });
});

test('CASE_VISIBILITY=assigned: an address-only match on a shared address opens as subject/date only for a non-admin; its attachments are refused', async () => {
  const messages = { [`${OFFICE}/c1`]: M('c1', { subject: 'hello', hasAttachments: true, uniqueBody: { content: 'private text' }, body: { content: 'private text' } }) };
  await run({ messages, attachments: { c1: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'AT-1', name: 'a.pdf', size: 1 }] }, casesByEmail: async () => [{ id: '901', caseRef: '2026-SPE-017' }], env: { CASE_VISIBILITY: 'assigned' } }, async () => {
    const r = await svc.open({ ...LIST, source: 'office', id: 'c1', viewer: STAFF });
    assert.equal(r.restricted, true); assert.equal(r.unique, undefined); assert.equal(r.attachments, undefined);
    assert.ok(!JSON.stringify(r).includes('private text'));
    assert.equal((await svc.attachment({ ...LIST, source: 'office', id: 'c1', att: 'AT-1', viewer: STAFF })).refused.status, 403);
    const a = await svc.open({ ...LIST, source: 'office', id: 'c1', viewer: ADMIN });
    assert.deepEqual(a.unique, [{ t: 'private text' }]);
  });
});

test('no client address, subject or body in ANY log line (console spy), whatever fails', async () => {
  const q1 = { 'TdotCaseItemId=900': [APP('a1', { singleValueExtendedProperties: [prop('TdotCaseItemId', '900')] })] };
  const messages = { [`${OFFICE}/a1`]: APP('a1', { uniqueBody: { content: 'Body text' }, body: { content: 'Body text' } }) };
  await run({ q1, messages, stamps: { a1: { TdotCaseItemId: '900' } }, searchFail: gErr(400, 'ErrorInvalidSearch'), q1Fail: { [`TdotTo=${CLIENT}`]: gErr(500, 'ErrorInternal') }, oldFail: Object.assign(new Error(`connect ETIMEDOUT for ${CLIENT}`), { response: undefined }) }, async (h) => {
    await svc.list(LIST);
    await svc.open({ ...LIST, source: 'office', id: 'a1', viewer: ADMIN });
    assert.ok(h.logs.length >= 3);
    for (const l of h.logs) {
      assert.ok(!/@example|asha|second@|Documents still needed|Body text|participants:|refused/i.test(l), l);
    }
    assert.ok(h.logs.some((l) => /\[CaseEmails\] 2026-SPE-016: list office=\d+ \(part failed\) old=0 \(failed\) shown=\d+/.test(l)));
  });
});

test('attachmentView / safeName: control characters and path separators stripped; an attached email gets .eml; names capped', () => {
  assert.equal(svc.safeName('a/b\\c\u0000d.pdf', 'file'), 'a b c d.pdf');
  assert.equal(svc.safeName('', 'file'), 'attachment');
  assert.equal(svc.safeName('Re: hello', 'item'), 'Re: hello.eml');
  assert.equal(svc.safeName('x'.repeat(300), 'file').length, 150);
  for (const ext of ['html', 'htm', 'svg', 'js', 'vbs', 'hta', 'lnk', 'exe', 'bat', 'cmd', 'ps1', 'scr', 'msi', 'iso', 'img']) assert.ok(svc.BLOCKED_EXT.has(ext), ext);
  assert.equal(svc.attachmentView({ id: 'A', name: 'x.PS1', size: 1 }).downloadable, false);
  assert.equal(svc.attachmentView({ id: 'A', name: 'x', contentType: 'text/html', size: 1 }).downloadable, false);
  assert.equal(svc.attachmentView({ id: 'A/B', name: 'x.pdf', size: 1 }).downloadable, false, 'an id outside the safe characters is never offered');
});
