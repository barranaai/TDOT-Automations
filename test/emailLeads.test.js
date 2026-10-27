'use strict';

// Email → lead (Faran 2026-10-27): new email to info@tdotimm.com becomes a lead
// (someone new) or a note on their case / lead (someone we know); junk and
// automatic mail is skipped; only email after the app can first LIST the inbox;
// nothing is ever taken twice (two app instances included), a failed step is
// retried in order, one stuck email is set aside instead of holding up the rest,
// a retry never posts the same email twice, an outage never drops an email, a
// burst never stalls the reader, an email rescued from Junk is taken (and
// retried if it fails). Everything runs against a fake inbox and fake boards
// (io stubs) — no network.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const EL = require('../src/services/emailLeadsService');

const T0 = Date.parse('2026-10-27T14:00:00Z');
const MIN = 60 * 1000, HOUR = 60 * MIN;
let seq = 0;
const made = {};
const msg = (over = {}) => {
  const id = over.id || `m${++seq}`;
  const m = {
    id: over.graphId || id,
    internetMessageId: over.internetMessageId || `<${id}@mail>`,
    receivedDateTime: over.receivedDateTime || '2026-10-27T14:10:00Z',
    subject: over.subject == null ? 'Study permit question' : over.subject,
    from: { emailAddress: { address: over.from || 'priya.shah@gmail.com', name: over.name == null ? 'Priya Shah' : over.name } },
    ...(over.replyTo ? { replyTo: over.replyTo.map((a) => ({ emailAddress: { address: a, name: '' } })) } : {}),
    body: { contentType: 'text', content: over.body == null ? 'Hello,\nI want to extend my study permit.\nThanks' : over.body },
    hasAttachments: !!over.hasAttachments,
    webLink: over.webLink || 'https://outlook.office365.com/owa/?ItemID=abc',
    parentFolderId: over.parentFolderId || 'F-inbox',
    isDraft: !!over.isDraft,
    internetMessageHeaders: over.headers || [],
    ...(over.odataType ? { '@odata.type': over.odataType } : {}),
  };
  made[id] = m;
  return m;
};
const key = (id) => EL.messageRef(made[id]);

/** A fake world: inbox pages, a mailbox to fetch from, a OneDrive record with eTags, the boards. */
function world({ access = 200, listAccess = 200, leads = [], cases = [], failCreate = 0, failCreateFor = [], failSearch = 0, failNote = 0, failSaveAt = [], blacklisted = [], junkSample = null, rescueRefused = false } = {}) {
  const w = { now: T0, gets: [], creates: [], createCalls: 0, notes: [], marks: [], warns: [], logs: [], blNotes: [], record: null, etag: 0, leads: leads.slice(), cases: cases.slice(), pages: [], rescuePages: [], list400: '' };
  let saveN = 0, runN = 0;
  const fail = (status, code, message) => { const e = new Error(message); e.response = { status, data: { error: { code, message } } }; return e; };
  const all = () => [...w.pages.flat(), ...w.rescuePages.flat(), ...Object.values(made)];
  Object.assign(EL.io, {
    now: () => w.now,
    runId: () => `run-${++runN}`,
    token: async () => 'tok',
    dropToken: () => {},
    get: async (url, headers) => {
      w.gets.push({ url, headers });
      const d = decodeURIComponent(url);
      if (access !== 200) throw fail(access, 'ErrorAccessDenied', 'Access is denied.');
      const f = url.match(/mailFolders\/(\w+)\?/);
      if (f) return { data: { id: `F-${f[1]}` } };
      if (listAccess !== 200) throw fail(listAccess, 'ErrorAccessDenied', 'Access is denied.');
      if (url.includes('/mailFolders/junkemail/messages')) return { data: { value: junkSample ? [junkSample] : [] } };
      if (w.list400 && url.includes('internetMessageHeaders')) {
        const m = w.list400; if (m === 'once-generic') w.list400 = '';
        throw fail(400, 'BadRequest', m === 'headers' ? "Could not find a property named 'internetMessageHeaders' on type 'microsoft.graph.message'." : 'Something else was wrong.');
      }
      const byId = d.match(/internetMessageId eq '(.*)'&\$top/);
      if (byId) { const imid = byId[1].replace(/''/g, "'"); return { data: { value: Object.values(made).filter((m) => m.internetMessageId === imid).slice(-1) } }; }
      const isRescue = url.includes('/mailFolders/inbox/messages') || url.includes('rescuenext');
      if (isRescue && rescueRefused) throw fail(400, 'ErrorInvalidRestriction', 'The restriction or sort order is too complex.');
      if (isRescue && w.inbox) {   // a real-like Inbox: filter, oldest change first, $skip paging
        const ge = (d.match(/lastModifiedDateTime ge (\S+)/) || [])[1], le = (d.match(/receivedDateTime le (\S+?)(&|$)/) || [])[1];
        const skip = Number((d.match(/[?&]\$?skip=(\d+)/) || [])[1] || 0);
        w.rescueCalls = (w.rescueCalls || 0) + 1;
        if (w.onRescuePage) w.onRescuePage(w.rescueCalls);
        const hits = w.inbox.filter((m) => Date.parse(m.lastModifiedDateTime) >= Date.parse(ge) && Date.parse(m.receivedDateTime) <= Date.parse(le))
          .sort((a, b) => Date.parse(a.lastModifiedDateTime) - Date.parse(b.lastModifiedDateTime));
        const value = hits.slice(skip, skip + 25);
        return { data: { value, ...(skip + 25 < hits.length ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/rescuenext?$filter=lastModifiedDateTime ge ${ge} and receivedDateTime le ${le}&skip=${skip + 25}` } : {}) } };
      }
      const queue = isRescue ? w.rescuePages : w.pages;
      if (url.includes('$top=1&') && !isRescue) return { data: { value: [] } };   // the start / check probe
      const value = queue.length ? queue.shift() : [];
      return { data: { value, ...(queue.length ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/${isRescue ? 'rescuenext' : 'nextpage'}` } : {}) } };
    },
    readState: async () => (w.record ? { data: JSON.parse(JSON.stringify(w.record)), etag: String(w.etag) } : null),
    writeState: async (data, etag) => {
      saveN++;
      if (failSaveAt.includes(saveN)) throw new Error('OneDrive 503');
      if ((!etag && w.record) || (etag && etag !== String(w.etag))) { const e = new Error('changed meanwhile'); e.conflict = true; throw e; }
      w.record = JSON.parse(JSON.stringify(data)); w.etag++;
      return { etag: String(w.etag) };
    },
    leadsByEmail: async (email) => { if (failSearch > 0) { failSearch--; throw new Error('Monday 500'); } return w.leads.filter((l) => l.email === email); },
    casesByEmail: async (email) => w.cases.filter((c) => c.email.toLowerCase() === String(email).toLowerCase()),
    createLead: async (fields) => {
      w.createCalls++;
      if (w.failCreateFor.includes(fields.email)) throw new Error('Monday refused a column value');
      if (failCreate > 0) { failCreate--; throw new Error('Monday 502'); }
      const id = String(900000 + w.creates.length + 1);
      w.creates.push({ id, ...fields });
      w.leads.push({ id, email: fields.email });
      return { id };
    },
    markLead: async (id, fields) => { w.marks.push({ id, ...fields }); },
    postNote: async (id, body) => {
      if (failNote > 0) { failNote--; throw new Error('Monday 503'); }
      w.notes.push({ id: String(id), body });
    },
    noteBodies: async (id) => w.notes.filter((n) => n.id === String(id)).map((n) => n.body.replace(/<[^>]+>/g, ' ')),
    blacklistCheck: async (email) => (blacklisted.includes(email) ? { hit: true, entries: [{ email }] } : { hit: false }),
    blacklistNote: async (id) => { w.blNotes.push(id); return true; },
    leadsChanged: () => {},
    log: (...a) => w.logs.push(a.join(' ')),
    warn: (...a) => w.warns.push(a.join(' ')),
  });
  EL._reset();
  w.failCreateFor = failCreateFor.slice();
  w.queue = (...p) => { w.pages.push(...p); };
  w.all = all;
  return w;
}
const real = { ...EL.io };
const restore = () => { Object.assign(EL.io, real); EL._reset(); };
const startedWorld = async (opts) => { const w = world(opts); const r = await EL.runOnce(); assert.match(r.outcome, /^started/); w.now += 5 * MIN; return w; };
const run = () => EL.runOnce();
const withEnv = async (vars, fn) => {
  const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

// ─── the rules ───────────────────────────────────────────────────────────────

test('classify: a person on any personal or business domain is taken; our own domain and addresses, the inbox itself, no-reply senders, mail-system names, newsletters, auto-replies, read receipts, delivery notices, meeting mail, drafts, Junk/Sent/Deleted and the skip-list domains are not', () => {
  const box = 'info@tdotimm.com', excludedFolders = new Set(['F-junkemail', 'F-sentitems']);
  const r = (o) => EL.skipReason(msg(o), { box, excludedFolders });
  for (const from of ['priya.shah@gmail.com', 'raj@outlook.com', 'Mona@Hotmail.com', 'a.b@yahoo.co.in', 'info@smallbusiness.ca', 'karan@company.com', 'support.team@gmail.com',
    'marketing@acme-hr.com', 'news.desk@paper.com', 'alerts.raj@gmail.com', 'notify.me@gmail.com', 'hr@employer.ca']) assert.equal(r({ from }), '', from);
  assert.match(r({ from: 'gauri@tdotimm.com' }), /skip list \(tdotimm\.com\)/);
  assert.match(r({ from: 'INFO@tdotimm.com' }), /inbox itself/);
  assert.match(r({ from: 'admstdot@gmail.com' }), /our own addresses/, 'the e-transfer inbox');
  for (const from of ['noreply@bank.com', 'noreply1@bank.com', 'noreplyxyz@x.io', 'no-reply@x.io', 'do_not_reply@x.io', 'donotreply@x.io', 'MAILER-DAEMON@x.com', 'postmaster@x.com', 'bounces+123@x.com', 'notifications@x.com', 'newsletter@shop.com', 'notification2@x.com']) assert.match(r({ from }), /automatic sender/, from);
  for (const from of ['messenger@squareup.com', 'x@documensomail.com', 'notify@payments.interac.ca', 'officer@cic.gc.ca', 'no@ircc.canada.ca', 'oinp@ontario.ca', 'pnp@gov.bc.ca', 'aaip@alberta.ca', 'docs@wes.org', 'help@vfsglobal.com', 'someone@linkedin.com', 'cal@google.com']) assert.match(r({ from }), /skip list/, from);
  assert.match(r({ headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }), /automatic email/);
  assert.equal(r({ headers: [{ name: 'Auto-Submitted', value: 'no' }] }), '', '"no" means a person sent it');
  assert.match(r({ headers: [{ name: 'Precedence', value: 'bulk' }] }), /bulk/);
  assert.match(r({ headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] }), /mailing list/);
  assert.match(r({ headers: [{ name: 'X-Autoreply', value: 'yes' }] }), /automatic reply/);
  for (const subject of ['Automatic reply: hello', 'Out of Office: back Monday', 'Undeliverable: your message', 'Delivery Status Notification (Failure)', 'Mail delivery failed: returning message']) assert.match(r({ subject }), /automatic reply or delivery/, subject);
  for (const subject of ['Re: my documents', 'Accepted: offer from University of Toronto', 'Read: the letter I attached', 'Out of office hours – can I call?', 'Tentative: plans for my PR']) assert.equal(r({ subject }), '', subject);
  assert.match(r({ subject: 'Read: Documents needed for your case', body: 'Your message\n  To: Priya\n  Subject: Documents needed\nwas read on Monday, 27 October 2026.' }), /read receipt/);
  assert.match(r({ subject: 'Not read: Documents', body: 'Your message was deleted without being read on …' }), /read receipt/);
  assert.match(r({ headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=disposition-notification' }] }), /read receipt/);
  assert.match(r({ odataType: '#microsoft.graph.eventMessageRequest' }), /meeting/);
  assert.match(r({ isDraft: true }), /draft/);
  assert.match(r({ parentFolderId: 'F-junkemail' }), /Junk/);
  assert.match(r({ from: 'not-an-address' }), /no sender/);
  assert.ok(!EL.DEFAULT_SKIP_DOMAINS.some((d) => /^(gmail|outlook|hotmail|live|yahoo|icloud)\./.test(d)), 'no personal mail domain on the list');
});

test('classify / Reply-To: ONLY a configured form sender hands over to the visitor — never a no-reply with someone in Reply-To (phishing, help desks, a company\'s own support), a staff mailbox, our app\'s reply-to address, or two Reply-Tos', () => {
  const c = (o, opts = {}) => EL.classify(msg(o), { box: 'info@tdotimm.com', ...opts });
  let v = c({ from: 'wordpress@tdotimm.com', replyTo: ['Visitor.One@gmail.com'] }, { formSenders: ['wordpress@tdotimm.com'] });
  assert.deepEqual([v.reason, v.viaReplyTo, v.person.raw], ['', true, 'Visitor.One@gmail.com']);
  assert.match(c({ from: 'wordpress@tdotimm.com', replyTo: ['visitor@gmail.com'] }).reason, /skip list/, 'not configured: our domain is never handed over');
  assert.match(c({ from: 'gauri@tdotimm.com', replyTo: ['gauri.personal@gmail.com'] }).reason, /skip list/, 'a staff mailbox with a personal reply-to');
  v = c({ from: 'no-reply@forms.example.com', replyTo: ['visitor@yahoo.com'] }, { formSenders: ['no-reply@forms.example.com'] });
  assert.deepEqual([v.reason, v.person.email], ['', 'visitor@yahoo.com'], 'a configured form service');
  assert.match(c({ from: 'no-reply@forms.example.com', replyTo: ['visitor@yahoo.com'] }).reason, /automatic sender/, 'not configured: skipped');
  assert.match(c({ from: 'noreply@payroll-alerts.biz', replyTo: ['claims.desk2026@gmail.com'] }).reason, /automatic sender/, 'the phishing pattern');
  assert.match(c({ from: 'no-reply@rogers.com', replyTo: ['support@rogers.zendesk.com'] }).reason, /automatic sender/, 'a help desk');
  assert.match(c({ from: 'noreply@email.rbc.ca', replyTo: ['help@rbc.ca'] }).reason, /automatic sender/);
  assert.match(c({ from: 'no-reply@canva.com', replyTo: ['support@canva.com'] }).reason, /automatic sender/, 'a company\'s own notice');
  assert.match(c({ from: 'noreply@mail.rogers.com', replyTo: ['billing@rogers.com'] }).reason, /automatic sender/, 'same company, a sub-domain');
  assert.match(c({ from: 'messenger@squareup.com', replyTo: ['client@gmail.com'] }).reason, /skip list/, 'a service notice about a client');
  assert.match(c({ from: 'noreply@x.com', replyTo: ['ops.team@gmail.com'] }, { addresses: new Set(['ops.team@gmail.com']) }).reason, /automatic sender/, 'our own reply-to address is never a person');
  assert.match(c({ from: 'no-reply@forms.example.com', replyTo: ['a@gmail.com', 'b@gmail.com'] }, { formSenders: ['no-reply@forms.example.com'] }).reason, /automatic sender/, 'two Reply-Tos');
  assert.equal(c({ from: 'person@gmail.com', replyTo: ['other@gmail.com'] }).person.raw, 'person@gmail.com', 'a person\'s own email stays theirs');
});

test('the app\'s own reply-to and sending addresses (EMAIL_REPLY_TO, MS_FROM_EMAIL) are skipped as our own', () => withEnv({ EMAIL_REPLY_TO: 'office.team@gmail.com', MS_FROM_EMAIL: 'noreply@tdotimm.com' }, () => {
  assert.match(EL.skipReason(msg({ from: 'office.team@gmail.com' })), /our own addresses/);
  assert.match(EL.skipReason(msg({ from: 'noreply@tdotimm.com', replyTo: ['office.team@gmail.com'] })), /our own|skip list/);
}));

test('bodyText trims only a reply\'s quote of OUR email; a forward and a client\'s own letter are kept whole; noteHtml shows the email as text, never as markup', () => {
  const b = (body, subject) => EL.bodyText(msg({ body, subject }));
  assert.equal(b('Yes I will send it.\n\nOn Mon, 27 Oct 2026 at 10:00, TDOT <info@tdotimm.com> wrote:\n> old'), 'Yes I will send it.');
  assert.equal(b('Yes.\nOn Mon, 27 Oct 2026 at 10:00 TDOT Immigration <info@tdotimm.com>\nwrote:\n> old'), 'Yes.', 'Gmail wraps "wrote:" onto the next line');
  assert.equal(b('Thanks\n-----Original Message-----\nFrom: TDOT <info@tdotimm.com>\nSent: Monday'), 'Thanks');
  assert.equal(b('Ok\n________________________________\nFrom: TDOT <noreply@tdotimm.com>\nSent: Monday'), 'Ok');
  assert.equal(b('Hi\nFrom: Gauri <gauri@tdotimm.com>\nSent: Friday, 24 Oct\nTo: me'), 'Hi');
  assert.equal(b('Hi\nFrom: my cousin\nSent: last week\nhe says hello'), 'Hi\nFrom: my cousin\nSent: last week\nhe says hello', 'not a quote of ours');
  assert.equal(b('Dear Sir,\nFrom: Priya Shah\nDate: 26 October 2026\nI request an extension.'), 'Dear Sir,\nFrom: Priya Shah\nDate: 26 October 2026\nI request an extension.', 'a letter heading is not a quote');
  assert.equal(b('Hello\nFrom: India, I want a visitor visa.\nThanks'), 'Hello\nFrom: India, I want a visitor visa.\nThanks');
  const fwd = 'Please see the letter below.\n\n---------- Forwarded message ---------\nFrom: IRCC <x@cic.gc.ca>\nDate: Mon, 27 Oct 2026\nSubject: Procedural fairness\nDear applicant, …';
  assert.equal(b(fwd), fwd, 'a forward is kept whole');
  assert.equal(b('FYI\nOn Mon TDOT <info@tdotimm.com> wrote:\n> our letter', 'Fwd: your letter'), 'FYI\nOn Mon TDOT <info@tdotimm.com> wrote:\n> our letter', 'Fw/Fwd subject: whole');
  assert.equal(b('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');

  const m = msg({ name: 'Eve <script>', subject: '<b>hi</b> & bye', body: 'line1\n<img src=x onerror=alert(1)>\nline3', hasAttachments: true });
  const html = EL.noteHtml(m, { isNewLead: true, box: 'info@tdotimm.com' });
  assert.doesNotMatch(html, /<script>|<img|<b>hi/);
  assert.match(html, /^📧 <b>New lead from an email<\/b> to info@tdotimm\.com — /);
  assert.match(html, /From: Eve &lt;script&gt; &lt;priya\.shah@gmail\.com&gt;<br>Subject: &lt;b&gt;hi&lt;\/b&gt; &amp; bye/);
  assert.match(html, /line1<br>&lt;img src=x onerror=alert\(1\)&gt;<br>line3/);
  assert.match(html, /📎 This email has attachments/);
  assert.match(html, /<a href="https:\/\/outlook\.office365\.com\/owa\/\?ItemID=abc">Open this email in Outlook<\/a>/);
  assert.match(html, /set "In Canada now\?" on the lead page/);
  assert.match(html, new RegExp(`Email ref ${EL.messageRef(m)}</span>$`));
  const form = EL.noteHtml(msg({ from: 'wordpress@tdotimm.com' }), { person: { raw: 'v@gmail.com', email: 'v@gmail.com', name: '' }, viaReplyTo: true });
  assert.match(form, /From: v@gmail\.com \(sent through wordpress@tdotimm\.com — a web form\)/);
  const known = EL.noteHtml(msg({ webLink: 'javascript:alert(1)', body: 'x'.repeat(5000) }), { box: 'info@tdotimm.com' });
  assert.match(known, /^📧 <b>Email received<\/b> at info@tdotimm\.com/);
  assert.doesNotMatch(known, /javascript:|In Canada now/);
  assert.match(known, /x{4000}<br>… \(the rest is in the email\)/);
  assert.match(EL.noteHtml(msg({ body: '' }), {}), /\(the email has no text\)/);
});

test('messageRef: the same for a moved email, a copy, and an email whose text changed in place; different for two web-form messages that reuse one message id', () => {
  const a = msg({ id: 'r1', internetMessageId: '<same@x>' });
  assert.equal(EL.messageRef(a), EL.messageRef({ ...a, id: 'moved-graph-id', parentFolderId: 'F-clients', receivedDateTime: '2026-10-27T14:10:01Z' }));
  assert.equal(EL.messageRef(a), EL.messageRef({ ...a, body: { contentType: 'text', content: '[EXTERNAL] ' + a.body.content } }), 'a banner added in place');
  assert.notEqual(EL.messageRef(msg({ internetMessageId: '<form@x>', from: 'no-reply@forms.example.com', replyTo: ['a@gmail.com'], body: 'Name: A' })),
                  EL.messageRef(msg({ internetMessageId: '<form@x>', from: 'no-reply@forms.example.com', replyTo: ['b@gmail.com'], body: 'Name: B' })));
});

test('leadNameFor / situationText / pickTargets ("Submitted" is still an open case)', () => {
  assert.equal(EL.leadNameFor({ name: ' "Priya  Shah" ', raw: 'p@x.com', email: 'p@x.com' }), 'Priya Shah');
  assert.equal(EL.leadNameFor({ name: 'p@x.com', raw: 'P@x.com', email: 'p@x.com' }), 'P@x.com');
  assert.equal(EL.leadNameFor({ name: '', raw: 'P@x.com', email: 'p@x.com' }), 'P@x.com');
  assert.match(EL.situationText(msg({ subject: '' }), 'info@tdotimm.com'), /^Email to info@tdotimm\.com — \(no subject\)\n\nHello,/);
  assert.ok(EL.situationText(msg({ body: 'y'.repeat(5000) })).length <= 1900);
  assert.deepEqual(EL.pickTargets({ cases: [{ id: '5', caseStage: 'Cancelled' }, { id: '7', caseStage: 'Document Collection Started' }, { id: '6', caseStage: 'Internal Review' }], leads: [{ id: '9' }] }), { kind: 'case', ids: ['7', '6'] });
  assert.equal(EL.pickTargets({ cases: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), caseStage: 'Paid' })) }).ids.length, 3);
  assert.deepEqual(EL.pickTargets({ cases: [{ id: '5', caseStage: 'Submitted' }], leads: [{ id: '8' }] }), { kind: 'case', ids: ['5'] });
  assert.deepEqual(EL.pickTargets({ cases: [{ id: '5', caseStage: 'Cancelled' }], leads: [{ id: '8' }, { id: '4' }] }), { kind: 'lead', ids: ['8'] });
  assert.deepEqual(EL.pickTargets({ cases: [{ id: '50', caseStage: 'Closed' }], leads: [{ id: '8' }] }), { kind: 'case', ids: ['50'] });
  assert.deepEqual(EL.pickTargets({}), { kind: 'none', ids: [] });
});

// ─── starting ────────────────────────────────────────────────────────────────

test('no permission yet: nothing is recorded, the status says what to ask for, the warning comes once an hour', async () => {
  const w = world({ access: 403 });
  try {
    const r = await run();
    assert.equal(r.ok, false); assert.equal(r.outcome, 'no access');
    assert.match(r.hint, /not allowed to read info@tdotimm\.com yet[\s\S]*"Mail\.Read"[\s\S]*docs\/email-leads-setup\.md/);
    assert.equal(w.record, null);
    await run(); w.now += 30 * MIN; await run();
    assert.equal(w.warns.length, 1);
    w.now += 31 * MIN; await run();
    assert.equal(w.warns.length, 2);
    assert.ok(EL.accessHint(404, 'x@y.com').includes('no mailbox x@y.com'));
  } finally { restore(); }
});

test('folders readable but the LIST refused: still nothing recorded — the start waits until mail can really be read', async () => {
  const w = world({ listAccess: 403 });
  try { assert.equal((await run()).outcome, 'no access'); assert.equal(w.record, null); } finally { restore(); }
});

test('first run that can list the inbox: the record starts NOW and nothing is taken; an email from just before the start is never taken', async () => {
  const w = world();
  try {
    assert.match((await run()).outcome, /^started — reading info@tdotimm\.com from now on/);
    assert.equal(w.record.startedAt, new Date(T0).toISOString());
    w.now += 5 * MIN;
    w.queue([msg({ id: 'before', receivedDateTime: '2026-10-27T13:59:00Z' }), msg({ id: 'after', from: 'after@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['after@gmail.com']);
    assert.equal(w.record.seen[key('before')], undefined);
  } finally { restore(); }
});

// ─── taking email ────────────────────────────────────────────────────────────

test('a new person → ONE lead (Source "Email", name, address, message; Original channel "Email") + the email as a note; the list query: text bodies, oldest first, from the watermark minus 2 minutes', async () => {
  const w = await startedWorld();
  try {
    w.queue([msg({ id: 'a', from: 'Priya.Shah@Gmail.com' })]);
    const r = await run();
    assert.equal(r.ok, true); assert.equal(r.counts.lead, 1);
    assert.deepEqual(w.creates.map(({ id, ...f }) => f), [{ fullName: 'Priya Shah', email: 'Priya.Shah@Gmail.com', sourceChannel: 'Email', situationDescription: 'Email to info@tdotimm.com — Study permit question\n\nHello,\nI want to extend my study permit.\nThanks' }]);
    assert.deepEqual(w.marks, [{ id: w.creates[0].id, originalChannel: 'Email' }]);
    assert.equal(w.notes.length, 1); assert.equal(w.notes[0].id, w.creates[0].id); assert.match(w.notes[0].body, /New lead from an email/);
    const list = w.gets.find((g) => g.url.includes('%40tdotimm.com/messages?') && g.url.includes('$top=25'));
    assert.match(decodeURIComponent(list.url), /\/users\/info@tdotimm\.com\/messages\?\$filter=receivedDateTime ge 2026-10-27T13:58:00Z&\$orderby=receivedDateTime asc&\$top=25&\$select=id,internetMessageId,receivedDateTime,subject,from,sender,replyTo,body,hasAttachments,webLink,parentFolderId,isDraft,internetMessageHeaders$/);
    assert.equal(list.headers.Prefer, 'outlook.body-content-type="text"', 'default ids — the folder ids must match parentFolderId');
    assert.equal(w.record.seen[key('a')].o, 'lead'); assert.equal(w.record.since, '2026-10-27T14:10:00.000Z');
    w.queue([msg({ id: 'a', from: 'Priya.Shah@Gmail.com' })]);
    await run();
    assert.equal(w.creates.length, 1); assert.equal(w.notes.length, 1, 'the overlap re-list does nothing');
  } finally { restore(); }
});

test('the lead is created WITHOUT Monday\'s automatic re-send (a timed-out create that landed must not make two leads); other callers keep the re-sends', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const leadService = require('../src/services/leadService');
  const seenRetries = [];
  const realQ = mondayApi.query;
  mondayApi.query = async (q, vars, retries) => {
    if (/create_item/.test(q)) { seenRetries.push(retries); return { create_item: { id: '42' } }; }
    return { boards: [{ groups: [{ items_page: { items: [] } }] }] };
  };
  const ld = require('../src/services/leadTokenService'); const realTok = ld.ensureToken; ld.ensureToken = async () => {};
  const od = require('../src/services/oneDriveService'); const realLF = od.ensureLeadFolder; od.ensureLeadFolder = async () => ({ id: 'f', url: 'u' });
  try {
    await EL.io.createLead({ fullName: 'A', email: 'a@gmail.com', sourceChannel: 'Email' });
    await leadService.createLead({ fullName: 'B', email: 'b@gmail.com' });
    assert.deepEqual(seenRetries, [0, undefined]);
  } finally { mondayApi.query = realQ; ld.ensureToken = realTok; od.ensureLeadFolder = realLF; }
});

test('someone we know → no new lead: a note on their open case (a cancelled one passed over), else on their lead; two emails from one new person → one lead + one note', async () => {
  const w = await startedWorld({
    leads: [{ id: '700', email: 'known.lead@yahoo.com' }],
    cases: [{ id: '100', email: 'Client@Gmail.com', caseStage: 'Cancelled' }, { id: '200', email: 'client@gmail.com', caseStage: 'Document Collection Started' }],
  });
  try {
    w.queue([
      msg({ id: 'c', from: 'client@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' }),
      msg({ id: 'l', from: 'known.lead@yahoo.com', receivedDateTime: '2026-10-27T14:02:00Z' }),
      msg({ id: 'n1', from: 'new.person@icloud.com', name: 'New Person', receivedDateTime: '2026-10-27T14:03:00Z' }),
      msg({ id: 'n2', from: 'NEW.PERSON@icloud.com', name: 'New Person', subject: 'Forgot to attach', receivedDateTime: '2026-10-27T14:04:00Z' }),
    ]);
    const r = await run();
    assert.deepEqual([r.counts.lead, r.counts['lead-note'], r.counts['case-note']], [1, 2, 1]);
    assert.equal(w.creates.length, 1);
    assert.deepEqual(w.notes.map((n) => [n.id, /New lead/.test(n.body) ? 'new' : 'note']), [['200', 'note'], ['700', 'note'], [w.creates[0].id, 'new'], [w.creates[0].id, 'note']]);
    assert.deepEqual(w.record.seen[key('c')].ids, ['200']);
  } finally { restore(); }
});

test('the same email twice — moved to another folder (new Graph id), delivered as two copies, or its text changed in place — is taken ONCE; two web-form messages sharing a message id are two people', () => withEnv({ EMAIL_LEADS_FORM_SENDERS: 'no-reply@forms.example.com' }, async () => {
  const w = await startedWorld({ cases: [{ id: '200', email: 'client@gmail.com', caseStage: 'Paid' }] });
  try {
    w.queue([msg({ id: 'mv', from: 'client@gmail.com' }), msg({ id: 'mv', graphId: 'copy-2', from: 'client@gmail.com' })]);
    await run();
    w.queue([msg({ id: 'mv', graphId: 'moved-id', from: 'client@gmail.com', parentFolderId: 'F-clients', body: '[EXTERNAL] Hello' })]);
    await run();
    assert.equal(w.notes.length, 1);
    w.queue([msg({ id: 'f1', internetMessageId: '<form@site>', from: 'no-reply@forms.example.com', replyTo: ['first.visitor@gmail.com'], body: 'Name: First', receivedDateTime: '2026-10-27T14:11:00Z' }),
             msg({ id: 'f2', internetMessageId: '<form@site>', from: 'no-reply@forms.example.com', replyTo: ['second.visitor@gmail.com'], body: 'Name: Second', receivedDateTime: '2026-10-27T14:12:00Z' })]);
    await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['first.visitor@gmail.com', 'second.visitor@gmail.com']);
  } finally { restore(); }
}));

test('a configured web form (from our domain, the visitor in Reply-To) becomes the VISITOR\'s lead', () => withEnv({ EMAIL_LEADS_FORM_SENDERS: 'wordpress@tdotimm.com' }, async () => {
  const w = await startedWorld();
  try {
    w.queue([msg({ id: 'wf', from: 'wordpress@tdotimm.com', name: 'TDOT Website', replyTo: ['visitor@gmail.com'], subject: 'New contact form submission' })]);
    await run();
    assert.equal(w.creates.length, 1); assert.equal(w.creates[0].email, 'visitor@gmail.com');
    assert.match(w.notes[0].body, /sent through wordpress@tdotimm\.com — a web form/);
  } finally { restore(); }
}));

test('junk is skipped and recorded with its reason; nothing is created; the watermark still moves past it', async () => {
  const w = await startedWorld();
  try {
    w.queue([
      msg({ id: 'j1', from: 'noreply@bank.com', receivedDateTime: '2026-10-27T14:01:00Z' }),
      msg({ id: 'j2', headers: [{ name: 'List-Unsubscribe', value: '<x>' }], receivedDateTime: '2026-10-27T14:02:00Z' }),
      msg({ id: 'j3', from: 'asmita@tdotimm.com', receivedDateTime: '2026-10-27T14:03:00Z' }),
      msg({ id: 'j4', parentFolderId: 'F-junkemail', receivedDateTime: '2026-10-27T14:04:00Z' }),
    ]);
    const r = await run();
    assert.equal(r.counts.skipped, 4); assert.equal(w.creates.length + w.notes.length, 0);
    assert.match(w.record.log.find((e) => e.from === 'noreply@bank.com').reason, /automatic sender/);
    assert.equal(w.record.seen[key('j4')].folder, true, 'skipped for its folder only');
    assert.equal(w.record.since, '2026-10-27T14:04:00.000Z');
  } finally { restore(); }
});

// ─── rescued from Junk ───────────────────────────────────────────────────────

test('an email rescued from Junk into the Inbox is taken; one skipped for another reason, or never seen, is not; the look asks only for mail older than the watermark', async () => {
  const w = await startedWorld();
  try {
    w.queue([msg({ id: 'jk', from: 'first.timer@gmail.com', parentFolderId: 'F-junkemail', receivedDateTime: '2026-10-27T14:01:00Z' }),
             msg({ id: 'nr', from: 'noreply@shop.com', receivedDateTime: '2026-10-27T14:02:00Z' })]);
    await run();
    assert.equal(w.creates.length, 0);
    w.now += 3 * HOUR;
    w.rescuePages.push([msg({ id: 'jk', graphId: 'inbox-copy', from: 'first.timer@gmail.com', parentFolderId: 'F-inbox', receivedDateTime: '2026-10-27T14:01:00Z' }),
                        msg({ id: 'nr', from: 'noreply@shop.com', receivedDateTime: '2026-10-27T14:02:00Z' }),
                        msg({ id: 'old-unseen', from: 'old@gmail.com', receivedDateTime: '2026-09-01T10:00:00Z' })]);
    const r = await run();
    assert.equal(r.counts.rescued, 1);
    assert.deepEqual(w.creates.map((c) => c.email), ['first.timer@gmail.com']);
    assert.match(decodeURIComponent(w.gets.filter((g) => g.url.includes('/mailFolders/inbox/messages')).pop().url), /\$filter=lastModifiedDateTime ge 2026-10-27T14:03:00Z and receivedDateTime le 2026-10-27T14:02:00Z&\$orderby=lastModifiedDateTime asc&\$top=25&\$select=.*,lastModifiedDateTime$/);
  } finally { restore(); }
});

test('a rescued email whose first try fails is retried — fetched again by its message id — until it is stored', async () => {
  const w = await startedWorld({ failCreate: 1 });
  try {
    w.queue([msg({ id: 'jr', from: 'rescued@gmail.com', parentFolderId: 'F-junkemail', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    w.now += HOUR;
    w.rescuePages.push([msg({ id: 'jr', graphId: 'in-inbox', from: 'rescued@gmail.com', parentFolderId: 'F-inbox', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    assert.equal(w.creates.length, 0);
    assert.deepEqual([w.record.seen[key('jr')].o, w.record.seen[key('jr')].rescue], ['pending', true]);
    w.now += 5 * MIN;
    const r = await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['rescued@gmail.com']);
    assert.equal(r.counts.rescued, 1);
    assert.ok(w.gets.some((g) => decodeURIComponent(g.url).includes(`internetMessageId eq '<jr@mail>'`)), 'fetched by its message id');
  } finally { restore(); }
});

test('the rescue look reads oldest change first: a look cut short continues next run from where it stopped — a mass "mark all as read" of 1,100 old emails never stalls it, and the rescued email is taken', async () => {
  const w = await startedWorld();
  try {
    w.queue([msg({ id: 'jx', from: 'stuck.in.junk@gmail.com', parentFolderId: 'F-junkemail', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    const sinceBefore = w.record.rescueSince;
    // 15:00 — someone marks 1,100 old Inbox emails as read, then moves the junk email to the Inbox
    w.inbox = Array.from({ length: 1100 }, (_, i) => ({ ...msg({ id: `old${i}`, from: `o${i}@gmail.com`, receivedDateTime: '2026-10-20T10:00:00Z' }), lastModifiedDateTime: new Date(Date.parse('2026-10-27T15:00:00Z') + i * 10).toISOString() }));
    w.inbox.push({ ...msg({ id: 'jx', graphId: 'in-inbox', from: 'stuck.in.junk@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' }), lastModifiedDateTime: '2026-10-27T15:00:30Z' });
    w.now = Date.parse('2026-10-27T15:05:00Z');
    await run();
    assert.ok(w.record.rescueCursor, 'cut short at 1,000: a cursor, not a stuck "since"');
    assert.equal(w.record.rescueSince, sinceBefore);
    w.now += 5 * MIN;
    await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['stuck.in.junk@gmail.com']);
    assert.equal(w.record.rescueCursor, undefined, 'read to the end: back to the normal look');
    assert.notEqual(w.record.rescueSince, sinceBefore);
  } finally { restore(); }
});

test('the rescue look never jumps over an email when another changes while it reads (no skip-paging shift)', async () => {
  const w = await startedWorld();
  try {
    w.queue([msg({ id: 'js', from: 'shifted@gmail.com', parentFolderId: 'F-junkemail', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    w.inbox = Array.from({ length: 30 }, (_, i) => ({ ...msg({ id: `c${i}`, from: `c${i}@gmail.com`, receivedDateTime: '2026-10-20T10:00:00Z' }), lastModifiedDateTime: new Date(Date.parse('2026-10-27T15:00:00Z') + i * 1000).toISOString() }));
    // the rescued email is the first of page 2 (26th oldest change)
    w.inbox.splice(25, 0, { ...msg({ id: 'js', graphId: 'in-inbox', from: 'shifted@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' }), lastModifiedDateTime: '2026-10-27T15:00:24.500Z' });
    w.onRescuePage = (n) => { if (n === 2) w.inbox[0].lastModifiedDateTime = '2026-10-27T15:10:00Z'; };   // staff open the first one mid-look
    w.now = Date.parse('2026-10-27T15:12:00Z');
    await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['shifted@gmail.com']);
  } finally { restore(); }
});

test('the rescue look gets through more than 1,000 emails changed in the SAME second (a bulk "Not junk"): it counts its place within the second', async () => {
  const w = await startedWorld();
  try {
    w.queue([msg({ id: 'jb', from: 'bulk.rescued@gmail.com', parentFolderId: 'F-junkemail', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    w.inbox = Array.from({ length: 1100 }, (_, i) => ({ ...msg({ id: `s${i}`, from: `s${i}@gmail.com`, receivedDateTime: '2026-10-20T10:00:00Z' }), lastModifiedDateTime: '2026-10-27T15:00:00Z' }));
    w.inbox.push({ ...msg({ id: 'jb', graphId: 'in-inbox', from: 'bulk.rescued@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' }), lastModifiedDateTime: '2026-10-27T15:00:00Z' });
    w.now = Date.parse('2026-10-27T15:05:00Z');
    await run();
    assert.deepEqual([w.record.rescueCursor, w.record.rescueSkip], ['2026-10-27T15:00:00.000Z', 1000]);
    w.now += 5 * MIN;
    await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['bulk.rescued@gmail.com']);
  } finally { restore(); }
});

// ─── failures ────────────────────────────────────────────────────────────────

test('a Monday failure: the email stays "pending" (lock released), the run STOPS (later emails wait, the watermark holds), the next run takes it — in order', async () => {
  const w = await startedWorld({ failCreate: 1 });
  try {
    const both = () => w.queue([msg({ id: 'p1', from: 'first@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' }), msg({ id: 'p2', from: 'second@gmail.com', receivedDateTime: '2026-10-27T14:02:00Z' })]);
    both();
    const r = await run();
    assert.equal(r.ok, false); assert.match(r.outcome, /could not be stored yet \(Monday 502\) — it is retried next run/);
    assert.deepEqual([w.record.seen[key('p1')].o, w.record.seen[key('p1')].tries, w.record.seen[key('p1')].leaseUntil], ['pending', 1, 0]);
    assert.equal(w.record.seen[key('p2')], undefined);
    assert.equal(w.record.since, new Date(T0).toISOString());
    w.now += 5 * MIN; both();
    assert.equal((await run()).counts.lead, 2);
    assert.deepEqual(w.creates.map((c) => c.email), ['first@gmail.com', 'second@gmail.com']);
  } finally { restore(); }
});

test('one email Monday always refuses is SET ASIDE after 5 tries — the emails after it go through at once; it is retried on its own every run and given up only after a day', async () => {
  const w = await startedWorld({ failCreateFor: ['bad@gmail.com'], cases: [{ id: '200', email: 'client@gmail.com', caseStage: 'Paid' }] });
  try {
    const q = () => w.queue([msg({ id: 'bad', from: 'bad@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' }), msg({ id: 'urgent', from: 'client@gmail.com', subject: 'My permit expires tomorrow', receivedDateTime: '2026-10-27T14:02:00Z' })]);
    for (let i = 0; i < 4; i++) { q(); await run(); w.now += 5 * MIN; }
    assert.equal(w.notes.length, 0, 'still in order for the first four tries');
    q();
    const r = await run();
    assert.equal(r.counts.parked, 1); assert.equal(r.counts['case-note'], 1, 'the client\'s email went through in the same run');
    assert.deepEqual(w.notes.map((n) => n.id), ['200']);
    assert.equal(w.record.seen[key('bad')].parked, true);
    assert.equal((await EL.getStatus()).setAside, 1);
    const calls = w.createCalls;
    w.now += 5 * MIN; await run();
    assert.equal(w.createCalls, calls + 1, 'retried on its own (fetched again by its message id)');
    w.now += 24 * HOUR; await run();
    assert.equal(w.record.seen[key('bad')].o, 'failed');
    assert.match(w.record.log.find((e) => e.outcome === 'failed').reason, /gave up after \d+ tries over a day: Monday refused a column value/);
    assert.equal((await EL.getStatus()).failed, 1);
  } finally { restore(); }
});

test('a sender Monday keeps refusing: once one of their emails is set aside, their later emails join it at once — a known client is not held up behind them', async () => {
  const w = await startedWorld({ failCreateFor: ['refused@gmail.com'], cases: [{ id: '200', email: 'client@gmail.com', caseStage: 'Paid' }] });
  try {
    const first = () => msg({ id: 'rf0', from: 'refused@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' });
    for (let i = 0; i < 4; i++) { w.queue([first()]); await run(); w.now += 5 * MIN; }
    w.queue([first(), ...[1, 2, 3, 4, 5].map((i) => msg({ id: `rf${i}`, from: 'refused@gmail.com', subject: `follow-up ${i}`, receivedDateTime: `2026-10-27T14:0${1 + i}:30Z` })),
      msg({ id: 'cl', from: 'client@gmail.com', subject: 'urgent', receivedDateTime: '2026-10-27T14:09:00Z' })]);
    const r = await run();
    assert.equal(r.counts.parked, 6, 'the first after 5 tries, the other five at once');
    assert.deepEqual(w.notes.map((n) => n.id), ['200'], 'the client\'s email in the same run');
    assert.equal((await EL.getStatus()).setAside, 6);
  } finally { restore(); }
});

test('one sender\'s set-aside emails are retried in the order they came — the "New lead" note carries their FIRST email', async () => {
  const w = await startedWorld({ failCreateFor: ['ordered@gmail.com'] });
  try {
    const q = () => w.queue([0, 1, 2, 3].map((i) => msg({ id: `o${i}`, from: 'ordered@gmail.com', subject: `email ${i}`, receivedDateTime: `2026-10-27T14:0${1 + i}:00Z` })));
    for (let i = 0; i < 5; i++) { q(); await run(); w.now += 5 * MIN; }
    for (let i = 0; i < 3; i++) { await run(); w.now += 5 * MIN; }   // the lanes keep failing — their "last tried" times change
    w.failCreateFor = [];                                             // Monday takes the address again
    await run();
    assert.equal(w.creates.length, 1);
    const onLead = w.notes.filter((n) => n.id === w.creates[0].id);
    assert.match(onLead[0].body, /New lead from an email[\s\S]*Subject: email 0/);
    assert.deepEqual(onLead.map((n) => (n.body.match(/Subject: (email \d)/) || [])[1]), ['email 0', 'email 1', 'email 2', 'email 3']);
  } finally { restore(); }
});

test('a set-aside email is re-fetched even when Microsoft refuses the headers in that query', async () => {
  const w = await startedWorld({ failCreate: 5 });
  try {
    for (let i = 0; i < 5; i++) { w.queue([msg({ id: 'hf', from: 'hf@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' })]); await run(); w.now += 5 * MIN; }
    assert.equal(w.record.seen[key('hf')].parked, true);
    w.list400 = 'headers';
    await run();
    assert.deepEqual(w.creates.map((c) => c.email), ['hf@gmail.com']);
  } finally { restore(); }
});

test('a Monday OUTAGE never drops an email: nothing is given up within the day', async () => {
  const w = await startedWorld({ failCreate: 20 });
  try {
    for (let i = 0; i < 12; i++) { w.queue([msg({ id: 'o1', from: 'x@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' })]); await run(); w.now += 5 * MIN; }
    assert.equal(Object.values(w.record.seen).filter((e) => e.o === 'failed').length, 0);
    w.now += 2 * HOUR;
    for (let i = 0; i < 12; i++) { w.queue([msg({ id: 'o1', from: 'x@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' })]); await run(); w.now += 5 * MIN; }
    assert.deepEqual(w.creates.map((c) => c.email), ['x@gmail.com'], 'stored once Monday is back');
  } finally { restore(); }
});

test('a failed Monday SEARCH never reads as "a new person" — no lead is created, the email is retried', async () => {
  const w = await startedWorld({ failSearch: 1, leads: [{ id: '700', email: 'known@gmail.com' }] });
  try {
    w.queue([msg({ id: 's', from: 'known@gmail.com' })]);
    await run();
    assert.equal(w.creates.length, 0); assert.equal(w.record.seen[key('s')].o, 'pending');
    w.now += 5 * MIN; w.queue([msg({ id: 's', from: 'known@gmail.com' })]);
    await run();
    assert.equal(w.creates.length, 0); assert.deepEqual(w.notes.map((n) => n.id), ['700']);
  } finally { restore(); }
});

test('the note landed but the record was lost (both saves failed): this instance takes its own lock back at once — and finds "Email ref …" on the item: no second note, no 30-minute hold', async () => {
  const w = await startedWorld({ leads: [{ id: '700', email: 'known@gmail.com' }], failSaveAt: [4, 5] });   // saves: 1 start, 2 claim, 3 renew, 4 result, 5 end-of-run
  try {
    w.queue([msg({ id: 'r', from: 'known@gmail.com' })]);
    await run();
    assert.equal(w.notes.length, 1);
    assert.equal(w.record.seen[key('r')].o, 'pending', 'only the claim was saved');
    w.now += 5 * MIN; w.queue([msg({ id: 'r', from: 'known@gmail.com' }), msg({ id: 'r2', from: 'other@gmail.com', receivedDateTime: '2026-10-27T14:11:00Z' })]);
    const r = await run();
    assert.equal(r.ok, true);
    assert.equal(w.notes.length, 2, 'no second note on 700; the next email went through');
    assert.equal(w.record.seen[key('r')].o, 'lead-note');
  } finally { restore(); }
});

test('the LEAD was created but the record was lost: this instance remembers it — taken back at once, no second lead', async () => {
  const w = await startedWorld({ failSaveAt: [4, 5] });   // saves: 1 start, 2 claim, 3 renew, 4 renew after the create (lost), 5 end-of-run (lost)
  try {
    w.queue([msg({ id: 'nl', from: 'brand.new@gmail.com' })]);
    await run();
    assert.equal(w.creates.length, 1);
    assert.equal(w.record.seen[key('nl')].leadId, undefined, 'the record never heard of the lead');
    w.leads = [];   // and Monday's search does not show it yet
    w.now += 5 * MIN; w.queue([msg({ id: 'nl', from: 'brand.new@gmail.com' })]);
    await run();
    assert.equal(w.creates.length, 1, 'no second lead');
    assert.equal(w.record.seen[key('nl')].o, 'lead');
  } finally { restore(); }
});

test('taken over while looking up (this instance\'s lock expired and another instance claimed the email): the renewal right before creating is refused — nothing is created', async () => {
  const w = await startedWorld();
  try {
    const realLookup = EL.io.leadsByEmail;
    EL.io.leadsByEmail = async (e) => { w.etag++; return realLookup(e); };   // another instance writes the record meanwhile
    w.queue([msg({ id: 'tk', from: 'contested@gmail.com' })]);
    const r = await run();
    assert.match(r.outcome, /another app instance is working on the inbox/);
    assert.equal(w.creates.length + w.notes.length, 0);
  } finally { restore(); }
});

test('the lead was created but its note failed → the retry — even hours later — finishes it as a NEW lead on THAT lead; the Not Wanted warning is posted either way', async () => {
  const w = await startedWorld({ failNote: 1, blacklisted: ['fresh@gmail.com'] });
  try {
    w.queue([msg({ id: 'k', from: 'fresh@gmail.com' })]);
    await run();
    assert.equal(w.creates.length, 1); assert.equal(w.notes.length, 0);
    assert.deepEqual(w.blNotes, [w.creates[0].id], 'the warning does not wait for the note');
    assert.equal(w.record.seen[key('k')].leadId, w.creates[0].id, 'the new lead is kept on the email\'s record');
    w.now += 3 * HOUR;   // long after the 30-minute "recent" memory is gone
    w.queue([msg({ id: 'k', from: 'fresh@gmail.com' })]);
    const r = await run();
    assert.equal(w.creates.length, 1);
    assert.deepEqual(w.notes.map((n) => n.id), [w.creates[0].id]);
    assert.match(w.notes[0].body, /New lead from an email/);
    assert.equal(r.counts.lead, 1);
  } finally { restore(); }
});

test('the lead we just made was deleted by staff: the next email from them drops the memory and looks again — a fresh lead, not a stuck queue', async () => {
  const w = await startedWorld({});
  try {
    w.queue([msg({ id: 'd1', from: 'spam.like@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' })]);
    await run();
    const firstId = w.creates[0].id;
    w.leads = w.leads.filter((l) => l.id !== firstId);
    const realPost = EL.io.postNote;
    EL.io.postNote = async (id, body) => { if (id === firstId) throw new Error('Item not found'); return realPost(id, body); };
    w.now += 5 * MIN; w.queue([msg({ id: 'd2', from: 'spam.like@gmail.com', receivedDateTime: '2026-10-27T14:06:00Z' })]);
    await run();
    assert.equal(w.record.recent['spam.like@gmail.com'], undefined, 'forgotten');
    w.now += 5 * MIN; w.queue([msg({ id: 'd2', from: 'spam.like@gmail.com', receivedDateTime: '2026-10-27T14:06:00Z' })]);
    await run();
    assert.equal(w.creates.length, 2);
    assert.equal(w.record.seen[key('d2')].o, 'lead');
  } finally { restore(); }
});

test('two app instances (a deploy overlap): one that reads AFTER the other\'s claim sees the lock and stops; one whose claim races is refused by the eTag — never two leads', async () => {
  const w = await startedWorld();
  try {
    const m = msg({ id: 'z', from: 'z@gmail.com' });
    w.record.seen[EL.messageRef(m)] = { o: 'pending', at: new Date(w.now).toISOString(), run: 'other-run', inst: 'other-instance', leaseUntil: w.now + EL.LEASE_MS, tries: 1, first: new Date(w.now).toISOString() };
    w.etag++;
    w.queue([m]);
    const r = await run();
    assert.match(r.outcome, /another app instance is working on the inbox \(or stopped mid-way\) — looked at again within 5 minutes/); assert.equal(r.ok, true);
    assert.equal(w.creates.length + w.notes.length, 0);
    w.record.seen[EL.messageRef(m)].leaseUntil = 0;
    w.queue([m]);
    const realWrite = EL.io.writeState;
    let first = true;
    EL.io.writeState = async (d, e) => { if (first) { first = false; w.etag++; } return realWrite(d, e); };
    const r2 = await run();
    assert.match(r2.outcome, /another app instance is working on the inbox/);
    assert.equal(w.creates.length + w.notes.length, 0);
  } finally { restore(); }
});

test('a burst of 120 emails already handled within 2 minutes never stalls the reader: the client email after them is taken', async () => {
  const w = await startedWorld();
  try {
    const burst = Array.from({ length: 120 }, (_, i) => msg({ id: `b${i}`, from: 'noreply@shop.com', receivedDateTime: new Date(Date.parse('2026-10-27T14:01:00Z') + i * 400).toISOString() }));
    const qb = () => { for (let i = 0; i < burst.length; i += 25) w.queue(burst.slice(i, i + 25)); };
    qb(); assert.equal((await run()).counts.skipped, 100, 'at most 100 still-to-do emails per run');
    w.now += 5 * MIN; qb(); await run();
    assert.equal(Object.values(w.record.seen).filter((e) => e.o === 'skipped').length, 120);
    w.now += 5 * MIN; qb();
    w.queue([msg({ id: 'client', from: 'real.client@gmail.com', receivedDateTime: '2026-10-27T14:01:50Z' })]);
    assert.equal((await run()).counts.lead, 1);
    assert.deepEqual(w.creates.map((c) => c.email), ['real.client@gmail.com']);
  } finally { restore(); }
});

test('Microsoft refusing the HEADERS in a list (a 400 naming them): read on without them; any other 400 is an error, and the next run asks for headers again', async () => {
  const w = await startedWorld();
  w.list400 = 'headers';
  try {
    w.queue([msg({ id: 'g1', from: 'a1@gmail.com', receivedDateTime: '2026-10-27T14:01:00Z' })], [msg({ id: 'g2', from: 'a2@gmail.com', receivedDateTime: '2026-10-27T14:02:00Z' })]);
    const r = await run();
    assert.equal(r.counts.lead, 2);
    assert.ok(w.gets.some((g) => g.url.includes('nextpage')));
    assert.equal(w.warns.filter((x) => /refused the message headers/.test(x)).length, 1);
  } finally { restore(); }
  const w2 = await startedWorld();
  w2.list400 = 'once-generic';
  try {
    const r = await run();
    assert.equal(r.outcome, 'failed'); assert.match(r.error, /400 BadRequest: Something else/);
    w2.queue([msg({ id: 'n1', headers: [{ name: 'List-Unsubscribe', value: '<x>' }] })]);
    w2.now += 5 * MIN;
    assert.equal((await run()).counts.skipped, 1, 'the newsletter is still caught');
  } finally { restore(); }
});

test('switched off (EMAIL_LEADS=off): nothing is read', () => withEnv({ EMAIL_LEADS: 'off' }, async () => {
  const w = world();
  try { assert.match((await run()).outcome, /switched off/); assert.equal(w.gets.length, 0); } finally { restore(); }
}));

test('a changed mailbox (EMAIL_LEADS_MAILBOX) starts a fresh record for it, from now', async () => {
  const w = await startedWorld();
  await withEnv({ EMAIL_LEADS_MAILBOX: 'Leads@TDOTIMM.com' }, async () => {
    try {
      w.now = T0 + HOUR;
      assert.match((await run()).outcome, /^started — reading leads@tdotimm\.com/);
      assert.equal(w.record.mailbox, 'leads@tdotimm.com'); assert.equal(w.record.startedAt, new Date(w.now).toISOString());
    } finally { restore(); }
  });
});

test('status + access check: what an admin sees — access, headers, the Junk folder check, the rescue query', async () => {
  const w = await startedWorld({ junkSample: { id: 'j', parentFolderId: 'F-junkemail' } });
  try {
    w.queue([msg({ id: 'q', from: 'q@gmail.com' })]);
    await run();
    const s = await EL.getStatus();
    assert.deepEqual([s.enabled, s.mailbox, s.pending, s.setAside, s.failed], [true, 'info@tdotimm.com', 0, 0, 0]);
    assert.equal(s.recent[0].outcome, 'lead'); assert.equal(s.lastRun.counts.lead, 1);
    const ok = await EL.checkAccess();
    assert.deepEqual([ok.ok, ok.junkCheck, ok.rescueCheck], [true, 'ok', 'ok']);
    assert.match(ok.message, /^Access OK — the app can read info@tdotimm\.com\./);
  } finally { restore(); }
  world({ junkSample: { id: 'j', parentFolderId: 'SOMETHING-ELSE' }, rescueRefused: true });
  try {
    const odd = await EL.checkAccess();
    assert.equal(odd.ok, false); assert.match(odd.junkCheck, /MISMATCH/); assert.match(odd.rescueCheck, /refused/);
  } finally { restore(); }
  world({ access: 403 });
  try {
    const bad = await EL.checkAccess();
    assert.equal(bad.ok, false); assert.equal(bad.status, 403); assert.match(bad.hint, /Mail\.Read/);
  } finally { restore(); }
});

test('wiring: the 5-minute job, the admin-only routes, the setup guide, notes posted without Monday\'s automatic re-send, the lead page wording', () => {
  const sch = fs.readFileSync(require.resolve('../src/services/scheduler.js'), 'utf8');
  assert.match(sch, /cron\.schedule\('2-59\/5 \* \* \* \*', \(\) =>\n\s+require\('\.\/emailLeadsService'\)\.runOnce\(\)/);
  const srv = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  for (const [verb, path] of [['get', 'status'], ['get', 'check'], ['post', 'run']]) {
    assert.match(srv, new RegExp(`app\\.${verb}\\('/admin/email-leads/${path}', async \\(req, res\\) => \\{[^\\n]*\\n\\s+if \\(!resolveAdminOrReject\\(req, res,`), `${verb} ${path} is admin-only`);
  }
  assert.ok(fs.existsSync(require('path').join(__dirname, '..', 'docs', 'email-leads-setup.md')));
  const svc = fs.readFileSync(require.resolve('../src/services/emailLeadsService.js'), 'utf8');
  assert.match(svc, /create_update\(item_id: \$id, body: \$b\) \{ id \} \}', \{ id: String\(itemId\), b: body \}, 0\)/);
  assert.match(svc, /createLead\(fields, \{ createRetries: 0 \}\)/);
  const leads = fs.readFileSync(require.resolve('../src/routes/adminLeads.js'), 'utf8');
  assert.match(leads, /\(d\.originalChannel==='Email'&&!d\.leadOwner\)\?'None — came in by email':'None — added by staff'/);
});
