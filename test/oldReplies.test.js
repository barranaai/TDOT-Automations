// Old no-reply replies (Faran 2026-11-19, "start with #1") — the read-only follow-up list against a FAKE Graph and a
// FAKE Monday: the skip rules and the grouping, the full board scans (paging, multi-address cells), case / lead /
// both, TEST / Cancel left out, answered yes / no / unknown, Monday failure → 503 (never partial), the inbox cap,
// the route gate, the CSV (formula injection) and no address or name in any log line.
// Offline (the no-network guard backs it). Every name, address and id here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('../src/services/oldRepliesService');
const emailLeads = require('../src/services/emailLeadsService');
const routes = require('../src/routes/clientMailRoutes');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const OFFICE = 'info@tdotimm.com', OLD = 'noreply@tdotimm.com';
const G = 'https://graph.microsoft.com/v1.0/users/';
const CM_BOARD = '7001', LEAD_BOARD = '7002';
const INBOX_URL = `${G}${OLD}/mailFolders/inbox/messages?$select=from,sender,receivedDateTime,hasAttachments,internetMessageId,isDraft&$top=100&$orderby=receivedDateTime desc`;

const addr = (a, name = '') => ({ emailAddress: { address: a, name } });
let _n = 0;
/** One old-inbox message from `a` at `at`. */
const OM = (a, at, o = {}) => ({ from: addr(a, 'Some Person'), sender: addr(a), receivedDateTime: at, hasAttachments: false, internetMessageId: `<m${++_n}@mail.example>`, isDraft: false, ...o });
const gErr = (status, code = 'ErrorX', headers = {}) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status, headers, data: { error: { code, message: 'Mailbox asha.sample@example.org in query to:asha.sample@example.org refused' } } },
});

/* ── fake Monday rows ── */
const cmItem = (id, name, { ref = '', email = '', stage = 'Document Collection Started', group = { id: 'group_live', title: 'Active' } } = {}) => ({
  id, name, group,
  column_values: [{ id: 'text_mm142s49', text: ref, value: ref ? JSON.stringify(ref) : null }, { id: 'text_mm0xw6bp', text: email, value: email ? JSON.stringify(email) : null }, { id: 'color_mm0x8faa', text: stage, value: stage ? '{"index":1}' : null }],
});
const leadItem = (id, name, { email = '', outcome = '', cm = '', created = '2026-10-01T12:00:00Z', emailValue } = {}) => ({
  id, name, created_at: created,
  column_values: [
    { id: 'text_mm44r6k2', text: name, value: JSON.stringify(name) },
    { id: 'email_mm44f4hm', text: email, value: emailValue !== undefined ? emailValue : (email ? JSON.stringify({ email, text: email }) : null) },
    { id: 'color_mm448h89', text: outcome || 'Follow-Up', value: outcome ? JSON.stringify({ index: 1, changed_at: '2026-10-05T10:00:00Z' }) : null },
    { id: 'text_mm44k4ha', text: cm, value: cm ? JSON.stringify(cm) : null },
  ],
});

/**
 * The harness: a fake Graph keyed by the DECODED url and a fake Monday. Records every Graph url, the Monday
 * queries, the most calls in flight per mailbox, and every log line (console and io).
 */
function harness({ inbox = [[]], inboxFail, sent = {}, wrote = {}, sentFail = {}, wroteFail = {}, cm = [[]], leads = [[]], mondayFail, delay = 0, env = {}, nextLink, clock } = {}) {
  const h = { urls: [], monday: [], logs: [], inFlight: {}, maxInFlight: {}, sleeps: [], drops: 0, clock: clock || { t: Date.parse('2026-11-19T15:00:00Z') } };
  const keepIo = { ...svc.io };
  const keepEnv = {};
  const allEnv = { MS_FROM_EMAIL: OLD, CLIENT_MAIL_FROM: undefined, EMAIL_LEADS_MAILBOX: undefined, EMAIL_REPLY_TO: undefined, ETRANSFER_EMAIL: undefined,
    EMAIL_LEADS_SKIP_ADDRESSES: undefined, EMAIL_LEADS_SKIP_DOMAINS: undefined, ...env };
  for (const k of Object.keys(allEnv)) { keepEnv[k] = process.env[k]; if (allEnv[k] === undefined) delete process.env[k]; else process.env[k] = allEnv[k]; }
  const con = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...a) => h.logs.push(a.join(' '));
  const pageUrl = (i) => `${G}${OLD}/mailFolders/inbox/messages?$skiptoken=p${i}`;
  const answer = (u) => {
    let m;
    if (u === INBOX_URL || (m = u.match(/\/mailFolders\/inbox\/messages\?\$skiptoken=p(\d+)$/))) {
      const i = m ? Number(m[1]) : 0;
      if (inboxFail && inboxFail.at === i) throw inboxFail.err;
      const value = inbox[i] || [];
      const next = nextLink ? nextLink(i) : (i + 1 < inbox.length ? pageUrl(i + 1) : undefined);
      return { value, ...(next ? { '@odata.nextLink': next } : {}) };
    }
    if ((m = u.match(/^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/info@tdotimm\.com\/mailFolders\/sentitems\/messages\?\$search="to:([^"]+)"&\$top=10&\$select=sentDateTime$/))) {
      if (sentFail[m[1]]) throw sentFail[m[1]];
      return { value: (sent[m[1]] || []).map((t) => ({ sentDateTime: t })) };
    }
    if ((m = u.match(/^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/info@tdotimm\.com\/messages\?\$search="from:([^"]+)"&\$top=10&\$select=receivedDateTime$/))) {
      if (wroteFail[m[1]]) throw wroteFail[m[1]];
      return { value: (wrote[m[1]] || []).map((t) => ({ receivedDateTime: t })) };
    }
    throw new Error('unexpected ' + u);
  };
  const boardPages = { [CM_BOARD]: cm, [LEAD_BOARD]: leads };
  Object.assign(svc.io, {
    token: async () => 'tok',
    dropToken: () => { h.drops++; },
    sleep: async (ms) => { h.sleeps.push(ms); },
    now: () => h.clock.t,
    get: async (url) => {
      const u = decodeURIComponent(url);
      const box = (u.match(/\/users\/([^/]+)\//) || [])[1] || '?';
      h.urls.push(u);
      h.inFlight[box] = (h.inFlight[box] || 0) + 1;
      h.maxInFlight[box] = Math.max(h.maxInFlight[box] || 0, h.inFlight[box]);
      try { if (delay) await new Promise((r) => setTimeout(r, delay)); return { data: await answer(u) }; }
      finally { h.inFlight[box]--; }
    },
    boards: () => ({ cm: CM_BOARD, lead: LEAD_BOARD }),
    monday: async (gql, vars) => {
      h.monday.push({ gql, vars });
      if (mondayFail) { const r = mondayFail(gql, vars, h.monday.length); if (r) throw r; }
      let board, i;
      if (vars.b) { board = vars.b[0]; i = 0; }
      else { const m = String(vars.c).match(/^(\d+):(\d+)$/); board = m[1]; i = Number(m[2]); }
      const pages = boardPages[board];
      if (!pages) throw new Error('unknown board');
      const p = { cursor: i + 1 < pages.length ? `${board}:${i + 1}` : null, items: pages[i] || [] };
      return vars.b ? { boards: [{ items_page: p }] } : { next_items_page: p };
    },
  });
  svc._reset();
  h.done = () => {
    Object.assign(svc.io, keepIo); Object.assign(console, con); svc._reset();
    for (const k of Object.keys(keepEnv)) { if (keepEnv[k] === undefined) delete process.env[k]; else process.env[k] = keepEnv[k]; }
  };
  return h;
}
async function run(opts, fn) { const h = harness(opts); try { return await fn(h); } finally { h.done(); } }

/* ══ 2. + 3. the skip rules and the grouping ═══════════════════════════════════ */

test('grouping: one group per lower-cased sender — count, newest, oldest, with attachments; drafts, the same email twice and unusable addresses dropped', () => {
  const env = { EMAIL_LEADS_MAILBOX: undefined, EMAIL_REPLY_TO: undefined, ETRANSFER_EMAIL: undefined, MS_FROM_EMAIL: OLD, CLIENT_MAIL_FROM: undefined };
  const keep = {}; for (const k of Object.keys(env)) { keep[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try {
    const dup = OM('asha.sample@example.org', '2026-10-02T10:00:00Z');
    const msgs = [
      OM('Asha.Sample@Example.org', '2026-10-01T10:00:00Z', { hasAttachments: true }),
      dup, { ...dup },                                                                 // the same email twice (internet message id)
      OM('asha.sample@example.org', '2026-09-20T08:00:00Z'),
      OM('asha.sample@example.org', '2026-10-03T10:00:00Z', { isDraft: true }),       // a draft
      { sender: addr('ben.example@example.net'), receivedDateTime: '2026-08-01T00:00:00Z', internetMessageId: '<s1@x>' },   // no From: the sender
      OM('', '2026-10-01T10:00:00Z'), OM('not an address', '2026-10-01T10:00:00Z'), OM("o'brien@example.com", '2026-10-01T10:00:00Z'),
      null, 'junk',
    ];
    const { groups, counts } = svc.groupSenders(msgs, svc.ownContext(OFFICE, OLD));
    assert.deepEqual([...groups.keys()].sort(), ['asha.sample@example.org', 'ben.example@example.net']);
    const a = groups.get('asha.sample@example.org');
    assert.equal(a.count, 3);
    assert.equal(new Date(a.newestMs).toISOString(), '2026-10-02T10:00:00.000Z');
    assert.equal(new Date(a.oldestMs).toISOString(), '2026-09-20T08:00:00.000Z');
    assert.equal(a.withAttachments, 1);
    assert.equal(counts.drafts, 1);
    assert.equal(counts.duplicates, 1);
    assert.equal(counts.invalid, 3);
    assert.equal(counts.read, 9, 'null / non-objects are not emails');
  } finally { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
});

test('skip rules: our own domains and addresses, the services on the skip list and automatic senders are dropped (counted as senders); the OLD mailbox\'s domain is never a skip domain', () => {
  const keep = { MS_FROM_EMAIL: process.env.MS_FROM_EMAIL, ETRANSFER_EMAIL: process.env.ETRANSFER_EMAIL, EMAIL_LEADS_SKIP_DOMAINS: process.env.EMAIL_LEADS_SKIP_DOMAINS, EMAIL_LEADS_MAILBOX: process.env.EMAIL_LEADS_MAILBOX };
  try {
    delete process.env.ETRANSFER_EMAIL; delete process.env.EMAIL_LEADS_SKIP_DOMAINS; delete process.env.EMAIL_LEADS_MAILBOX;
    process.env.MS_FROM_EMAIL = 'oldbox@gmail.com';   // a personal-mail domain must not drop every gmail sender
    const ctx = svc.ownContext(OFFICE, 'oldbox@gmail.com');
    const kinds = Object.fromEntries([
      'staff.one@tdotimm.com', 'info@tdotimm.com', 'oldbox@gmail.com', 'admstdot@gmail.com', 'billing@messaging.squareup.com',
      'no-reply@otter.ai', 'noreply@example.com', 'donotreply@bank.example', 'notifications@example.com', 'mailer-daemon@example.com', 'postmaster@example.com', 'newsletter@shop.example',
      'client.person@gmail.com', 'notification.fan@example.com', 'bad address',
    ].map((a) => [a, svc.skipKind(a.toLowerCase(), ctx)]));
    assert.deepEqual(kinds, {
      'staff.one@tdotimm.com': 'own', 'info@tdotimm.com': 'own', 'oldbox@gmail.com': 'own', 'admstdot@gmail.com': 'own', 'billing@messaging.squareup.com': 'own',
      'no-reply@otter.ai': 'automated', 'noreply@example.com': 'automated', 'donotreply@bank.example': 'automated', 'notifications@example.com': 'automated',
      'mailer-daemon@example.com': 'automated', 'postmaster@example.com': 'automated', 'newsletter@shop.example': 'automated',
      'client.person@gmail.com': '', 'notification.fan@example.com': '', 'bad address': 'invalid',
    });
    const { groups, counts } = svc.groupSenders([
      OM('staff.one@tdotimm.com', '2026-10-01T00:00:00Z'), OM('staff.one@tdotimm.com', '2026-10-02T00:00:00Z'), OM('no-reply@otter.ai', '2026-10-01T00:00:00Z'),
      OM('client.person@gmail.com', '2026-10-01T00:00:00Z'),
    ], ctx);
    assert.deepEqual([...groups.keys()], ['client.person@gmail.com']);
    assert.equal(counts.skippedSenders, 2, 'distinct senders');
    assert.equal(counts.ownSkipped, 1); assert.equal(counts.automatedSkipped, 1);
  } finally { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
  // the shared rule is emailLeadsService's own (exported, not copied)
  assert.ok(emailLeads.AUTOMATED_LOCAL instanceof RegExp);
  assert.match(read('src/services/oldRepliesService.js'), /emailLeads\.AUTOMATED_LOCAL\.test\(/);
});

test('cell addresses: several in one cell (spaces, commas, semicolons, angle brackets, mailto:), lower-cased, de-duplicated; words and junk ignored', () => {
  assert.deepEqual(svc.cellAddresses('Asha.Sample@Example.org, second@example.net;third@example.com   <Fourth@Example.com> mailto:fifth@example.com asha.sample@example.org'),
    ['asha.sample@example.org', 'second@example.net', 'third@example.com', 'fourth@example.com', 'fifth@example.com']);
  assert.deepEqual(svc.cellAddresses('Asha Sample (no email)'), []);
  assert.deepEqual(svc.cellAddresses(null), []);
  assert.deepEqual(svc.cellAddresses('end.dot@example.com.'), ['end.dot@example.com']);
});

/* ══ 1. the Graph requests ═════════════════════════════════════════════════════ */

test('Graph: the old inbox ALL pages (exact first request, next links followed), never a subject or body; the office mailbox\'s two $search reads per MATCHED sender — never $filter / $orderby with $search; nothing for unmatched people', async () => {
  const A = 'asha.sample@example.org', U = 'stranger@example.com';
  await run({
    inbox: [[OM(A, '2026-10-02T10:00:00Z')], [OM(U, '2026-10-01T10:00:00Z')], [OM(A, '2026-09-01T10:00:00Z')]],
    cm: [[cmItem('5001', 'Asha Sample', { ref: '2026-SPE-016', email: A })]],
  }, async (h) => {
    const out = await svc.list();
    assert.equal(out.rows.length, 1);
    const expected = [
      INBOX_URL,
      `${G}${OLD}/mailFolders/inbox/messages?$skiptoken=p1`,
      `${G}${OLD}/mailFolders/inbox/messages?$skiptoken=p2`,
      `${G}${OFFICE}/mailFolders/sentitems/messages?$search="to:${A}"&$top=10&$select=sentDateTime`,
      `${G}${OFFICE}/messages?$search="from:${A}"&$top=10&$select=receivedDateTime`,
    ];
    assert.deepEqual(h.urls.slice().sort(), expected.slice().sort());
    for (const u of h.urls) assert.doesNotMatch(u.split('$select=')[1] || '', /subject|body|bodyPreview|uniqueBody/i, 'never a subject or a body');
    for (const u of h.urls.filter((x) => x.includes('$search='))) assert.doesNotMatch(u, /\$filter|\$orderby/);
    assert.ok(!h.urls.some((u) => u.includes(U)), 'an unmatched person is never searched for');
    assert.equal(out.summary.sendersTotal, 2);
    assert.equal(out.summary.unmatchedSenders, 1);
    assert.equal(out.summary.mailbox, 'old no-reply inbox');
    assert.equal(out.summary.capped, false);
  });
});

test('Graph: the inbox stops at 50 pages and SAYS so (capped: true + a note) — never silent', async () => {
  const pages = Array.from({ length: 60 }, (_, i) => [OM(`p${i}.person@example.com`, `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00Z`)]);
  await run({ inbox: pages }, async (h) => {
    const out = await svc.list();
    assert.equal(h.urls.filter((u) => u.includes('/mailFolders/inbox/')).length, 50);
    assert.equal(out.summary.capped, true);
    assert.equal(out.summary.emailsRead, 50);
    assert.ok(out.notes.some((n) => /only the newest 5000 were read/.test(n)));
    assert.equal(svc.INBOX_MAX_PAGES, 50);
  });
});

test('Graph: a next link off graph.microsoft.com is never followed — and no list is made (503), never a partial one', async () => {
  for (const bad of ['https://evil.example/v1.0/users/x/messages?$skip=1', 'http://graph.microsoft.com/v1.0/users/x', 'https://graph.microsoft.com.evil.example/v1.0/x', 'https://graph.microsoft.com/beta/users/x', 'not a url']) {
    await run({ inbox: [[OM('a.person@example.com', '2026-10-01T10:00:00Z')], []], nextLink: (i) => (i === 0 ? bad : undefined) }, async (h) => {
      await assert.rejects(svc.list(), (e) => e.publicStatus === 503 && /old no-reply inbox could not be read/.test(e.publicError));
      assert.equal(h.urls.length, 1, bad);
      assert.equal(h.monday.length, 0, 'Monday is not read for a list that cannot be made');
    });
  }
  assert.equal(svc.isGraphLink('https://graph.microsoft.com/v1.0/users/x/messages?$skiptoken=1'), true);
});

test('Graph: a failed inbox page → 503 with the status and short code only (never Graph\'s message), nothing kept; 401 → one fresh token; 429 with Retry-After ≤ 5 s waits once', async () => {
  await run({ inbox: [[OM('a.person@example.com', '2026-10-01T10:00:00Z')], []], inboxFail: { at: 1, err: gErr(403, 'ErrorAccessDenied') } }, async (h) => {
    await assert.rejects(svc.list(), (e) => {
      assert.equal(e.publicStatus, 503);
      assert.match(e.publicError, /\(403 ErrorAccessDenied\)/);
      assert.match(e.publicError, /may not be allowed to read that mailbox/);
      assert.doesNotMatch(e.publicError, /@example/);
      return true;
    });
    assert.ok(h.logs.some((l) => /\[OldReplies\] the old no-reply inbox could not be read \(403 ErrorAccessDenied\)/.test(l)));
  });
  // 401 once → a fresh token, then fine
  let calls = 0;
  await run({ inbox: [[]] }, async (h) => {
    const get = svc.io.get;
    svc.io.get = async (url, hd) => { if (++calls === 1) throw gErr(401, 'InvalidAuthenticationToken'); return get(url, hd); };
    const out = await svc.list();
    assert.equal(h.drops, 1);
    assert.equal(out.ok, true);
  });
  // 429 Retry-After 2 → waits 2 s once; Retry-After 30 → not waited, the list fails
  for (const [ra, ok] of [['2', true], ['30', false]]) {
    let n = 0;
    await run({ inbox: [[]] }, async (h) => {
      const get = svc.io.get;
      svc.io.get = async (url, hd) => { if (++n === 1) throw gErr(429, 'TooManyRequests', { 'retry-after': ra }); return get(url, hd); };
      if (ok) { await svc.list(); assert.deepEqual(h.sleeps, [2000]); }
      else { await assert.rejects(svc.list(), (e) => e.publicStatus === 503 && /429 TooManyRequests/.test(e.publicError)); assert.deepEqual(h.sleeps, []); }
    });
  }
});

test('Graph: at most 2 calls at once per mailbox', async () => {
  const people = Array.from({ length: 6 }, (_, i) => `person${i}@example.com`);
  await run({
    delay: 5,
    inbox: [people.map((a, i) => OM(a, `2026-10-0${i + 1}T10:00:00Z`))],
    cm: [people.map((a, i) => cmItem(String(6000 + i), `Person ${i}`, { ref: `2026-SPE-1${i}0`, email: a }))],
  }, async (h) => {
    const out = await svc.list();
    assert.equal(out.rows.length, 6);
    assert.equal(h.urls.filter((u) => u.includes('$search=')).length, 12);
    assert.ok(h.maxInFlight[OFFICE] <= 2, `office: ${h.maxInFlight[OFFICE]}`);
    assert.equal(h.maxInFlight[OFFICE], 2, 'the two reads of a row run together');
  });
});

/* ══ 4. who is it — the full board scans ══════════════════════════════════════ */

test('Monday: two FULL scans — items_page(limit:500) then next_items_page with the cursor until done, the configured board ids, only the needed columns', async () => {
  const A = 'asha.sample@example.org', B = 'ben.example@example.net';
  await run({
    inbox: [[OM(A, '2026-10-02T10:00:00Z'), OM(B, '2026-10-01T10:00:00Z')]],
    cm: [[cmItem('5001', 'Someone Else', { ref: '2026-SPE-001', email: 'other@example.com' })], [], [cmItem('5003', 'Asha Sample', { ref: '2026-SPE-016', email: `x@example.com; ${A.toUpperCase()}` })]],
    leads: [[leadItem('801', 'Nobody', { email: 'nobody@example.com' })], [leadItem('802', 'Ben Example', { email: B })]],
  }, async (h) => {
    const out = await svc.list();
    const firsts = h.monday.filter((q) => q.vars.b);
    assert.deepEqual(firsts.map((q) => q.vars.b).sort(), [[CM_BOARD], [LEAD_BOARD]]);
    for (const q of firsts) assert.match(q.gql, /^query\(\$b:\[ID!\]\)\{ boards\(ids:\$b\)\{ items_page\(limit:500\)\{ cursor items\{ id name /);
    const nexts = h.monday.filter((q) => q.vars.c);
    assert.deepEqual(nexts.map((q) => q.vars.c).sort(), [`${CM_BOARD}:1`, `${CM_BOARD}:2`, `${LEAD_BOARD}:1`]);
    for (const q of nexts) assert.match(q.gql, /^query\(\$c:String!\)\{ next_items_page\(limit:500, cursor:\$c\)\{ cursor items\{ id name /);
    const cmQ = firsts.find((q) => q.vars.b[0] === CM_BOARD).gql;
    assert.ok(cmQ.includes('group{ id title } column_values(ids:["text_mm142s49","text_mm0xw6bp","color_mm0x8faa"]){ id text value }'));
    const leadQ = firsts.find((q) => q.vars.b[0] === LEAD_BOARD).gql;
    assert.ok(leadQ.includes('created_at column_values(ids:['));
    for (const col of ['email_mm44f4hm', 'color_mm448h89', 'text_mm44k4ha', 'text_mm44r6k2']) assert.ok(leadQ.includes(`"${col}"`), col);
    assert.deepEqual(out.rows.map((r) => [r.name, r.kind]).sort(), [['Asha Sample', 'case'], ['Ben Example', 'lead']], 'the match on the LAST page of each board and in a multi-address cell');
    assert.equal(h.monday.length, 5);
  });
  // the boards come from the existing config — never a hard-coded id (the old 18401510522 board is not the case board)
  const src = read('src/services/oldRepliesService.js');
  assert.match(src, /require\('\.\.\/\.\.\/config\/monday'\); return \{ cm: s\(c\.clientMasterBoardId\), lead: s\(c\.leadBoardId\) \}/);
  assert.doesNotMatch(src, /1840\d{7}|18416845157/);
});

test('match: case / lead / case+lead; a lead\'s Client Master link adds its case; two cases on one address = shared; TEST / Cancel / Leads groups left out and counted; unmatched counted, never listed', async () => {
  const P = {
    caseOnly: 'case.only@example.org', leadOnly: 'lead.only@example.org', both: 'both.person@example.org', linked: 'linked.lead@example.org',
    shared: 'family.shared@example.org', testOnly: 'test.only@example.org', cancelLead: 'cancel.lead@example.org', nobody: 'nobody.known@example.org', leadsGroup: 'cm.leads.group@example.org',
  };
  const inbox = [Object.values(P).map((a, i) => OM(a, `2026-10-1${i}T10:00:00Z`))];
  await run({
    inbox,
    cm: [[
      cmItem('5001', 'Casey Only', { ref: '2026-SPE-101', email: P.caseOnly, stage: 'Submitted' }),
      cmItem('5002', 'Bo Both', { ref: '2026-SPE-102', email: P.both }),
      cmItem('5003', 'Linda Linked', { ref: '2026-SPE-103', email: 'linda.other@example.org', stage: 'Document Review' }),
      cmItem('5004', 'Fam One', { ref: '2026-SPE-104', email: P.shared }),
      cmItem('5005', 'Fam Two', { ref: '2026-SPE-105', email: `${P.shared}, extra@example.org` }),
      cmItem('5006', 'Tess Test', { ref: '2026-SPE-106', email: P.testOnly, group: { id: 'group_mm3842s', title: 'TEST' } }),
      cmItem('5007', 'Cass Cancel', { ref: '2026-SPE-107', email: P.cancelLead, group: { id: 'group_mm3b9tap', title: 'Cancel' } }),
      cmItem('5008', 'Lee Group', { ref: '', email: P.leadsGroup, group: { id: 'group_mm2tz8e1', title: 'Leads' } }),
      cmItem('5009', 'Gone Case', { ref: '2026-SPE-109', email: 'x@example.org', group: { id: 'group_new', title: 'Did not retain' } }),
    ]],
    leads: [[
      leadItem('901', 'Lea Lead', { email: P.leadOnly, outcome: 'Follow-Up', created: '2026-09-01T00:00:00Z' }),
      leadItem('902', 'Lea Lead (new)', { email: P.leadOnly.toUpperCase(), outcome: '', created: '2026-10-01T00:00:00Z' }),
      leadItem('903', 'Bo Both (lead)', { email: P.both, outcome: 'Retain', cm: '5002' }),
      leadItem('904', 'Linda Linked (lead)', { email: P.linked, outcome: 'Retain', cm: '5003' }),
      leadItem('905', 'Cass (lead)', { email: P.cancelLead, cm: '5007' }),
    ]],
  }, async (h) => {
    const out = await svc.list();
    const byName = Object.fromEntries(out.rows.map((r) => [r.name, r]));
    assert.deepEqual(Object.keys(byName).sort(), ['Bo Both', 'Casey Only', 'Cass (lead)', 'Fam One', 'Lea Lead (new)', 'Linda Linked'].sort());
    assert.equal(byName['Casey Only'].kind, 'case');
    assert.deepEqual(byName['Casey Only'].caseRefs, ['2026-SPE-101']);
    assert.deepEqual(byName['Casey Only'].caseStages, ['Submitted']);
    assert.deepEqual(byName['Casey Only'].leadIds, []);
    assert.equal(byName['Casey Only'].leadOutcome, '');
    // a lead only: newest lead first, its outcome (empty) — not an older lead's
    const lo = byName['Lea Lead (new)'];
    assert.equal(lo.kind, 'lead'); assert.deepEqual(lo.leadIds, ['902', '901']); assert.equal(lo.leadOutcome, ''); assert.deepEqual(lo.caseRefs, []);
    // both: the case by its email AND by the lead's link — listed once; the CASE name
    assert.equal(byName['Bo Both'].kind, 'case+lead'); assert.deepEqual(byName['Bo Both'].caseRefs, ['2026-SPE-102']); assert.equal(byName['Bo Both'].leadOutcome, 'Retain');
    // a lead whose Client Master Item ID is a live case with ANOTHER email: the case joins the row
    assert.equal(byName['Linda Linked'].kind, 'case+lead'); assert.deepEqual(byName['Linda Linked'].caseRefs, ['2026-SPE-103']); assert.deepEqual(byName['Linda Linked'].caseStages, ['Document Review']);
    // a lead linked to a CANCELLED case: still a lead, the cancelled case never joins
    assert.equal(byName['Cass (lead)'].kind, 'lead'); assert.deepEqual(byName['Cass (lead)'].caseRefs, []);
    // one address on two cases
    assert.equal(byName['Fam One'].sharedAddress, true); assert.deepEqual(byName['Fam One'].caseRefs, ['2026-SPE-104', '2026-SPE-105']);
    assert.equal(byName['Casey Only'].sharedAddress, false);
    assert.ok(out.notes.some((n) => /"Shared address"/.test(n)));
    // counted, never listed
    assert.equal(out.summary.testOrCancelled, 2, 'TEST only + the Client Master Leads group only');
    assert.equal(out.summary.unmatchedSenders, 1);
    assert.equal(out.summary.sendersTotal, 9);
    assert.equal(out.summary.matchedCases, 4);
    assert.equal(out.summary.matchedLeads, 4);
    assert.ok(out.notes.some((n) => /2 people are only on Client Master rows in the TEST, Leads or Cancel groups — left out/.test(n)));
    assert.ok(out.notes.some((n) => /match no case and no lead are counted \(1\), never listed/.test(n)));
    const json = JSON.stringify(out);
    for (const a of Object.values(P)) assert.ok(!json.toLowerCase().includes(a), 'no address in the answer: ' + a);
    assert.ok(!/Tess Test|Lee Group|Gone Case/.test(json));
    for (const r of out.rows) assert.deepEqual(Object.keys(r).sort(), ['answeredFromInfoAfter', 'caseRefs', 'caseStages', 'kind', 'leadIds', 'leadOutcome', 'leadStatus', 'name', 'newest', 'oldReplies', 'oldest', 'sharedAddress', 'withAttachments', 'wroteToInfoAfter', 'wroteToInfoAfterAtLeast'].sort());
  });
});

test('match: the lead email is read from the stored value too (a label in the text), a Webinar mark reads as the outcome, an empty Outcome cell is never "Follow-Up", the Current status label comes along', async () => {
  const A = 'web.person@example.org', B = 'label.person@example.org';
  await run({
    inbox: [[OM(A, '2026-10-02T10:00:00Z'), OM(B, '2026-10-01T10:00:00Z')]],
    leads: [[
      leadItem('911', 'Web Person', { email: A, outcome: 'Webinar' }),
      leadItem('912', 'Label Person', { email: 'Label Person', emailValue: JSON.stringify({ email: B, text: 'Label Person' }) }),
    ]],
  }, async () => {
    const out = await svc.list();
    const byName = Object.fromEntries(out.rows.map((r) => [r.name, r]));
    assert.equal(byName['Web Person'].leadOutcome, 'Webinar');
    assert.equal(byName['Label Person'].kind, 'lead');
    assert.equal(byName['Label Person'].leadOutcome, '', 'the empty Outcome cell (value null) shows Monday\'s label as text — never an outcome');
    assert.equal(typeof byName['Label Person'].leadStatus, 'string');
    assert.ok(byName['Label Person'].leadStatus.length > 0);
  });
});

test('Monday failure → 503, never a partial list: a failed page, a page with no items, either board — no Graph search made, nothing kept (the next call reads again)', async () => {
  const A = 'asha.sample@example.org';
  const cases = [
    (gql, vars) => (vars.c === `${CM_BOARD}:1` ? new Error('Monday 500 for asha.sample@example.org') : null),
    (gql, vars) => (vars.b && vars.b[0] === LEAD_BOARD ? new Error('rate limited') : null),
  ];
  for (const mondayFail of cases) {
    await run({
      inbox: [[OM(A, '2026-10-02T10:00:00Z')]],
      cm: [[cmItem('5001', 'Asha Sample', { ref: '2026-SPE-016', email: A })], [cmItem('5002', 'Another', { email: 'b@example.org' })]],
      leads: [[leadItem('801', 'Lead', { email: 'c@example.org' })]],
      mondayFail,
    }, async (h) => {
      await assert.rejects(svc.list(), (e) => e.publicStatus === 503 && /Monday could not be read/.test(e.publicError) && /never|partial/.test(e.publicError) && !/@/.test(e.publicError));
      assert.equal(h.urls.filter((u) => u.includes('$search=')).length, 0);
      assert.ok(h.logs.some((l) => /\[OldReplies\] the (Client Master board|Lead Board) could not be read — no list made/.test(l)));
      // not kept: the next call reads Monday again
      const before = h.monday.length;
      await assert.rejects(svc.list());
      assert.ok(h.monday.length > before);
    });
  }
  // an odd page (no items array) is a failure too, never "no rows"
  await run({ inbox: [[OM(A, '2026-10-02T10:00:00Z')]] }, async (h) => {
    const m = svc.io.monday;
    svc.io.monday = async (gql, vars) => (vars.b && vars.b[0] === CM_BOARD ? { boards: [{ items_page: { cursor: null } }] } : m(gql, vars));
    await assert.rejects(svc.list(), (e) => e.publicStatus === 503);
  });
  // a board id that is not configured
  await run({ inbox: [[OM(A, '2026-10-02T10:00:00Z')]] }, async () => {
    svc.io.boards = () => ({ cm: '', lead: LEAD_BOARD });
    await assert.rejects(svc.list(), (e) => e.publicStatus === 503);
  });
  // no sender at all: Monday is not read
  await run({ inbox: [[OM('staff.one@tdotimm.com', '2026-10-02T10:00:00Z')]] }, async (h) => {
    const out = await svc.list();
    assert.equal(h.monday.length, 0);
    assert.deepEqual(out.rows, []);
    assert.equal(out.summary.automatedSkipped, 1);
  });
});

/* ══ 5. answered after? ═══════════════════════════════════════════════════════ */

test('answered: yes (info@ sent after the newest old reply) / no (only before) / unknown (the search failed — never a guess); wrote again counted (10 = at least 10); rows unanswered first, then newest first', async () => {
  const P = { yes: 'yes.person@example.org', no: 'no.person@example.org', unk: 'unknown.person@example.org', no2: 'no.two@example.org', none: 'never.answered@example.org' };
  const after = '2026-10-20T10:00:00Z', before = '2026-09-01T10:00:00Z';
  await run({
    inbox: [[
      OM(P.yes, '2026-10-15T10:00:00Z'), OM(P.yes, '2026-10-01T10:00:00Z'),
      OM(P.no, '2026-10-15T10:00:00Z'), OM(P.no, '2026-10-10T10:00:00Z', { hasAttachments: true }),
      OM(P.unk, '2026-10-18T10:00:00Z'),
      OM(P.no2, '2026-10-17T10:00:00Z'),
      OM(P.none, '2026-10-16T10:00:00Z'),
    ]],
    cm: [Object.entries(P).map(([k, a], i) => cmItem(String(5100 + i), `Name ${k}`, { ref: `2026-SPE-2${i}0`, email: a }))],
    sent: {
      [P.yes]: [after, before],
      [P.no]: ['2026-10-12T10:00:00Z', before],   // between the old replies: still not an answer to the newest
      [P.no2]: [],
      [P.none]: ['2026-10-16T10:00:00Z'],          // the same instant is not "after"
    },
    sentFail: { [P.unk]: gErr(503, 'ServiceUnavailable') },
    wrote: { [P.yes]: [after, before], [P.no]: Array.from({ length: 10 }, () => after), [P.no2]: [before] },
    wroteFail: { [P.none]: gErr(500, 'ErrorInternalServerError') },
  }, async (h) => {
    const out = await svc.list();
    const by = Object.fromEntries(out.rows.map((r) => [r.name, r]));
    assert.equal(by['Name yes'].answeredFromInfoAfter, 'yes');
    assert.equal(by['Name no'].answeredFromInfoAfter, 'no');
    assert.equal(by['Name unk'].answeredFromInfoAfter, 'unknown');
    assert.equal(by['Name no2'].answeredFromInfoAfter, 'no');
    assert.equal(by['Name none'].answeredFromInfoAfter, 'no');
    assert.equal(by['Name yes'].wroteToInfoAfter, 1); assert.equal(by['Name yes'].wroteToInfoAfterAtLeast, false);
    assert.equal(by['Name no'].wroteToInfoAfter, 10); assert.equal(by['Name no'].wroteToInfoAfterAtLeast, true);
    assert.equal(by['Name no2'].wroteToInfoAfter, 0);
    assert.equal(by['Name none'].wroteToInfoAfter, null, 'a failed count is unknown, never 0');
    assert.equal(by['Name unk'].wroteToInfoAfter, 0);
    assert.equal(by['Name no'].oldReplies, 2); assert.equal(by['Name no'].withAttachments, 1);
    assert.equal(by['Name no'].newest, '2026-10-15T10:00:00.000Z'); assert.equal(by['Name no'].oldest, '2026-10-10T10:00:00.000Z');
    // unanswered first ('no', then 'unknown', then 'yes'), then the newest old reply first
    assert.deepEqual(out.rows.map((r) => r.name), ['Name no2', 'Name none', 'Name no', 'Name unk', 'Name yes']);
    assert.deepEqual(out.summary.answers, { yes: 1, no: 3, unknown: 1 });
    assert.ok(out.notes.some((n) => /staff member sent from their own mailbox cannot be seen here/.test(n)));
    // the log line: counts and codes only
    const line = h.logs.find((l) => l.startsWith('[OldReplies] list:'));
    assert.match(line, /senders=5 cases=5 leads=0 unmatched=0 .* answered yes=1 no=3 unknown=1 failed: (503 ServiceUnavailable x1, 500 ErrorInternalServerError x1|500 ErrorInternalServerError x1, 503 ServiceUnavailable x1)/);
  });
});

test('answered: the checks stop STARTING after 4 minutes — the rest read "unknown", counted and noted; the newest old replies are checked first', async () => {
  const clock = { t: Date.parse('2026-11-19T15:00:00Z') };
  const people = ['first.p@example.org', 'second.p@example.org', 'third.p@example.org'];
  await run({
    clock,
    inbox: [people.map((a, i) => OM(a, `2026-10-1${i}T10:00:00Z`))],
    cm: [people.map((a, i) => cmItem(String(5200 + i), `P${i}`, { ref: `2026-SPE-3${i}0`, email: a }))],
  }, async (h) => {
    const get = svc.io.get;
    svc.io.get = async (url, hd) => { const r = await get(url, hd); if (url.includes('%24search') || url.includes('$search')) clock.t += 90 * 1000; return r; };   // 3 minutes per row
    const out = await svc.list();
    const by = Object.fromEntries(out.rows.map((r) => [r.name, r]));
    assert.equal(by.P2.answeredFromInfoAfter, 'no', 'the newest is checked first');
    assert.equal(by.P1.answeredFromInfoAfter, 'no', 'started at 3 minutes: still inside the budget');
    assert.equal(by.P0.answeredFromInfoAfter, 'unknown');
    assert.equal(by.P0.wroteToInfoAfter, null);
    assert.equal(h.urls.filter((u) => u.includes('first.p@')).length, 0, 'never asked');
    assert.equal(out.summary.answerChecksNotStarted, 1);
    assert.ok(out.notes.some((n) => /stopped after 4 minutes: 1 row shows "unknown"/.test(n)));
  });
});

/* ══ the cache, the mailboxes ═════════════════════════════════════════════════ */

test('kept 10 minutes; refresh reads again but at most once a minute; two calls at once share one read', async () => {
  const A = 'asha.sample@example.org';
  await run({ inbox: [[OM(A, '2026-10-02T10:00:00Z')]], cm: [[cmItem('5001', 'Asha Sample', { ref: '2026-SPE-016', email: A })]], delay: 2 }, async (h) => {
    const [x, y] = await Promise.all([svc.list(), svc.list()]);
    assert.equal(x, y);
    const reads = () => h.urls.filter((u) => u === INBOX_URL).length;
    assert.equal(reads(), 1);
    assert.equal((await svc.list()).cached, true);
    h.clock.t += 30 * 1000;
    assert.equal((await svc.list({ refresh: true })).cached, true, 'refresh within a minute: the kept list');
    h.clock.t += 31 * 1000;
    assert.equal((await svc.list({ refresh: true })).cached, false);
    assert.equal(reads(), 2);
    h.clock.t += 9 * 60 * 1000;
    assert.equal((await svc.list()).cached, true);
    h.clock.t += 2 * 60 * 1000;
    assert.equal((await svc.list()).cached, false);
    assert.equal(reads(), 3);
  });
});

test('mailboxes: the old one is MS_FROM_EMAIL, else noreply@tdotimm.com; the office one is caseEmailsService\'s; the same mailbox twice → 409, nothing read', async () => {
  await run({ env: { MS_FROM_EMAIL: undefined } }, async (h) => {
    assert.equal(svc.oldMailbox(), 'noreply@tdotimm.com');
    assert.equal(svc.officeMailbox(), require('../src/services/caseEmailsService').officeMailbox());
    await svc.list();
    assert.equal(h.urls[0], INBOX_URL);
  });
  await run({ env: { MS_FROM_EMAIL: 'Old.Box@TDOTIMM.com' } }, async () => { assert.equal(svc.oldMailbox(), 'old.box@tdotimm.com'); });
  await run({ env: { MS_FROM_EMAIL: 'info@tdotimm.com' } }, async (h) => {
    await assert.rejects(svc.list(), (e) => e.publicStatus === 409);
    assert.equal(h.urls.length, 0);
  });
});

/* ══ no address, no name in any log line ══════════════════════════════════════ */

test('logs: counts and codes only — no address, no name, no Graph or Monday message text, on the good path and on every failure path', async () => {
  const A = 'asha.sample@example.org', B = 'ben.example@example.net', C = 'carla.unknown@example.com';
  const names = ['Asha Sample', 'Ben Example', 'Some Person'];
  const opts = {
    inbox: [[OM(A, '2026-10-02T10:00:00Z'), OM(B, '2026-10-01T10:00:00Z'), OM(C, '2026-10-01T09:00:00Z')]],
    cm: [[cmItem('5001', 'Asha Sample', { ref: '2026-SPE-016', email: A })]],
    leads: [[leadItem('801', 'Ben Example', { email: B, cm: 'not-a-number' })]],
    sentFail: { [A]: gErr(429, 'TooManyRequests', { 'retry-after': '60' }) },
    wroteFail: { [B]: gErr(403, 'ErrorAccessDenied') },
  };
  const check = (h) => {
    assert.ok(h.logs.length > 0);
    for (const l of h.logs) {
      for (const a of [A, B, C, 'example.org', 'example.net', 'example.com']) assert.ok(!l.toLowerCase().includes(a), `a log line names ${a}: ${l}`);
      for (const n of names) assert.ok(!l.includes(n), `a log line names ${n}: ${l}`);
      assert.doesNotMatch(l, /refused|Mailbox /, 'never Graph\'s message text');
    }
  };
  await run(opts, async (h) => { await svc.list(); check(h); });
  await run({ ...opts, mondayFail: () => new Error('Monday says asha.sample@example.org Asha Sample') }, async (h) => { await assert.rejects(svc.list()); check(h); });
  await run({ ...opts, inboxFail: { at: 0, err: gErr(500, 'ErrorInternalServerError') } }, async (h) => { await assert.rejects(svc.list()); check(h); });
});

/* ══ 7. the CSV ═══════════════════════════════════════════════════════════════ */

test('CSV: the columns in order, Toronto dates (YYYY-MM-DD HH:mm), every text quoted, quotes doubled, one line per row, formula prefixes neutralised (= + - @, full-width, after spaces, a tab), BOM + CRLF', () => {
  const rows = [
    { kind: 'case+lead', name: 'Asha "AJ" Sample, Jr.', caseRefs: ['2026-SPE-016', '2026-SPE-017'], caseStages: ['Submitted', 'Document Review'], leadIds: ['901', '902'], leadOutcome: 'Retain',
      oldReplies: 3, newest: '2026-11-20T01:30:00.000Z', oldest: '2026-07-01T16:05:00.000Z', withAttachments: 1, answeredFromInfoAfter: 'no', wroteToInfoAfter: 10, wroteToInfoAfterAtLeast: true, sharedAddress: true },
    { kind: 'lead', name: '=HYPERLINK("http://evil.example","x")', caseRefs: [], caseStages: [], leadIds: ['903'], leadOutcome: '+cmd', oldReplies: 1,
      newest: '2026-10-01T12:00:00.000Z', oldest: '2026-10-01T12:00:00.000Z', withAttachments: 0, answeredFromInfoAfter: 'unknown', wroteToInfoAfter: null, wroteToInfoAfterAtLeast: false, sharedAddress: false },
    { kind: 'case', name: '-2+3', caseRefs: ['@SUM(1)'], caseStages: ['  =1+1'], leadIds: [], leadOutcome: '\tTab', oldReplies: 2,
      newest: '', oldest: '', withAttachments: 0, answeredFromInfoAfter: 'yes', wroteToInfoAfter: 0, wroteToInfoAfterAtLeast: false, sharedAddress: false },
    { kind: 'case', name: '＝1+1', caseRefs: ['x'], caseStages: [''], leadIds: [], leadOutcome: '', oldReplies: 1, newest: '', oldest: '', withAttachments: 0,
      answeredFromInfoAfter: 'no', wroteToInfoAfter: 2, wroteToInfoAfterAtLeast: false, sharedAddress: false },
    { kind: 'lead', name: 'Two\nLines\r\nName', caseRefs: [], caseStages: [], leadIds: ['1'], leadOutcome: '', oldReplies: 1, newest: '', oldest: '', withAttachments: 0,
      answeredFromInfoAfter: 'no', wroteToInfoAfter: 0, wroteToInfoAfterAtLeast: false, sharedAddress: false },
  ];
  const csv = svc.toCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, rows.length + 2);
  assert.equal(lines[0], '"Name","Kind","Case number(s)","Stage(s)","Lead id(s)","Lead outcome","Old replies","Newest","Oldest","With attachments","Answered from info@ after","Wrote to info@ after","Shared address"');
  assert.equal(lines[1], '"Asha ""AJ"" Sample, Jr.","Case + lead","2026-SPE-016; 2026-SPE-017","Submitted; Document Review","901; 902","Retain",3,"2026-11-19 20:30","2026-07-01 12:05",1,"no","10+","yes"');
  assert.equal(lines[2], '"\'=HYPERLINK(""http://evil.example"",""x"")","Lead","","","903","\'+cmd",1,"2026-10-01 08:00","2026-10-01 08:00",0,"unknown","unknown",""');
  assert.equal(lines[3], '"\'-2+3","Case","\'@SUM(1)","\'  =1+1","","\'\tTab",2,"","",0,"yes",0,""');
  assert.equal(lines[4], '"\'＝1+1","Case","x","","","",1,"","",0,"no",2,""');
  assert.equal(lines[5], '"Two Lines Name","Lead","","","1","",1,"","",0,"no",0,""');
  for (const v of ['=x', '+x', '-x', '@x', ' =x', '\t=x', '\tx', '＋x', '－x', '＠x']) assert.match(svc.csvCell(v), /^"'/, JSON.stringify(v));
  for (const v of ['Asha', '2026-SPE-016', 'a=b', 'x-y']) assert.doesNotMatch(svc.csvCell(v), /^"'/, v);
  assert.equal(svc.csvCell(-3), '-3', 'a number is a number');
  assert.deepEqual([...svc.CSV_HEAD], ['Name', 'Kind', 'Case number(s)', 'Stage(s)', 'Lead id(s)', 'Lead outcome', 'Old replies', 'Newest', 'Oldest', 'With attachments', 'Answered from info@ after', 'Wrote to info@ after', 'Shared address']);
  assert.equal(svc.csvFileName({ summary: { readAt: '2026-11-20T03:00:00.000Z' } }), 'old-noreply-replies-2026-11-19.csv', 'the Toronto day');
});

/* ══ the route ════════════════════════════════════════════════════════════════ */

const ADMIN = { email: 'boss@tdotimm.com', name: 'Boss' };
const STAFF = { email: 'staff@tdotimm.com', name: 'Staff' };
const isAdminEmail = (e) => e === ADMIN.email;
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, sent: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.sent = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}

test('route: NAMED admins only — the shared team key alone (no Monday sign-in) → 401 with the sign-in link; staff → 403; nothing read for either; every answer private, no-store', async () => {
  let calls = 0;
  const oldReplies = { list: async () => { calls++; return { ok: true, summary: {}, rows: [], notes: [] }; }, toCsv: () => '', csvFileName: () => 'x.csv' };
  let res = fakeRes();
  await routes.oldReplies({ query: {} }, res, { staff: () => null, isAdminEmail, oldReplies });
  assert.equal(res.statusCode, 401); assert.equal(res.body.loginUrl, '/q/auth/monday');
  assert.match(res.body.error, /Sign in with Monday to see who wrote to the old no-reply address — the shared admin key doesn’t say who you are/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  res = fakeRes();
  await routes.oldReplies({ query: {} }, res, { staff: () => STAFF, isAdminEmail, oldReplies });
  assert.equal(res.statusCode, 403); assert.equal(res.body.error, 'Only admins can see who wrote to the old no-reply address.');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(calls, 0, 'nothing is read for a refused viewer');
  // wiring: outside /api (the team key is not the gate), the Monday sign-in and the admin list handed in
  assert.ok(read('src/server.js').includes("app.get('/admin/client-mail/old-replies', (req, res) => require('./routes/clientMailRoutes').oldReplies(req, res, { staff: tryStaffAuth, isAdminEmail: caseAccess.isAdminEmail }));"));
});

test('route: JSON by default; ?format=csv → the same rows as a download (attachment, nosniff, text/csv); refresh passed on; a bad format → 400; no list → the service\'s 503 words, anything else → a plain 500 (no leak)', async () => {
  const got = [];
  const OUT = { ok: true, summary: { readAt: '2026-11-19T15:00:00.000Z' }, rows: [{ name: 'Asha', kind: 'case', caseRefs: [], caseStages: [], leadIds: [], oldReplies: 1, withAttachments: 0, answeredFromInfoAfter: 'no', wroteToInfoAfter: 0 }], notes: [] };
  const oldReplies = { list: async (o) => { got.push(o); return OUT; }, toCsv: svc.toCsv, csvFileName: svc.csvFileName };
  let res = fakeRes();
  await routes.oldReplies({ query: {} }, res, { staff: () => ADMIN, isAdminEmail, oldReplies });
  assert.equal(res.statusCode, 200); assert.equal(res.body, OUT);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  res = fakeRes();
  await routes.oldReplies({ query: { format: 'CSV', refresh: '1' } }, res, { staff: () => ADMIN, isAdminEmail, oldReplies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="old-noreply-replies-2026-11-19.csv"');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.sent, svc.toCsv(OUT.rows));
  assert.deepEqual(got, [{ refresh: false }, { refresh: true }]);
  res = fakeRes();
  await routes.oldReplies({ query: { format: ['csv', 'json'], refresh: ['1'] } }, res, { staff: () => ADMIN, isAdminEmail, oldReplies });
  assert.equal(res.statusCode, 200); assert.equal(res.body, OUT, 'a repeated parameter is ignored');
  assert.deepEqual(got.at(-1), { refresh: false });
  res = fakeRes();
  await routes.oldReplies({ query: { format: 'xml' } }, res, { staff: () => ADMIN, isAdminEmail, oldReplies });
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await routes.oldReplies({ query: { format: 'csv' } }, res, { staff: () => ADMIN, isAdminEmail, oldReplies: { list: async () => { throw Object.assign(new Error('x'), { publicStatus: 503, publicError: 'Monday could not be read (the Lead Board), so no list was made.' }); } } });
  assert.equal(res.statusCode, 503); assert.deepEqual(res.body, { error: 'Monday could not be read (the Lead Board), so no list was made.' });
  assert.equal(res.sent, undefined, 'never an empty CSV that looks complete');
  res = fakeRes();
  await routes.oldReplies({ query: {} }, res, { staff: () => ADMIN, isAdminEmail, oldReplies: { list: async () => { throw new Error('boom asha.sample@example.org'); } } });
  assert.equal(res.statusCode, 500); assert.deepEqual(res.body, { error: 'The old no-reply list could not be made.' });
});

test('route + service end to end (fakes): a named admin gets the JSON rows and the CSV of the SAME read', async () => {
  const A = 'asha.sample@example.org';
  await run({ inbox: [[OM(A, '2026-10-02T10:00:00Z')]], cm: [[cmItem('5001', 'Asha Sample', { ref: '2026-SPE-016', email: A })]] }, async (h) => {
    let res = fakeRes();
    await routes.oldReplies({ query: {} }, res, { staff: () => ADMIN, isAdminEmail });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.rows[0].name, 'Asha Sample');
    assert.equal(res.body.cached, false);
    res = fakeRes();
    await routes.oldReplies({ query: { format: 'csv' } }, res, { staff: () => ADMIN, isAdminEmail });
    assert.match(res.sent, /"Asha Sample","Case","2026-SPE-016","Document Collection Started","","",1,"2026-10-02 06:00"/);
    assert.equal(h.urls.filter((u) => u === INBOX_URL).length, 1, 'the CSV is the kept read');
    assert.ok(!res.sent.includes(A));
  });
});
