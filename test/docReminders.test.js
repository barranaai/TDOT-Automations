'use strict';

// Document-collection reminders (team meeting 2026-11-05, block 2) — step A:
// the templates (code defaults + the optional Monday board), the missing-
// documents list and the reminder email builder. Nothing here sends or writes:
// mondayApi.query is stubbed wherever a module would read, and the no-network
// guard (test/helpers/noNetwork.js) refuses anything that slips past.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const mondayApi = require('../src/services/mondayApi');
const cfg       = require('../config/reminderTemplates');
const tpl       = require('../src/services/docReminderTemplates');
const docForm   = require('../src/services/documentFormService');
const svc       = require('../src/services/docReminderService');

const TOKEN   = 'tok-ABC123';
const REF     = '2026-TEST-001';
const PORTAL  = /\/client\/2026-TEST-001\?t=tok-ABC123/;
const DOCS    = /\/documents\/2026-TEST-001\?t=tok-ABC123/;

// A checklist as getCaseSummary(ref).items hands it over — deliberately out of
// order (child first, principal last) so the grouping has to sort.
const ITEMS = [
  { id: '9', name: 'Birth certificate',      status: 'Missing',         category: 'Identity',  applicantType: 'Dependent Child',             applicantLabel: 'Dependent Child 1',          optional: false, clientInstructions: '' },
  { id: '8', name: 'Passport (spouse)',      status: 'Missing',         category: 'Identity',  applicantType: 'Spouse / Common-Law Partner', applicantLabel: 'Spouse / Common-Law Partner', optional: false, clientInstructions: 'All pages with stamps. Scan in colour.' },
  { id: '7', name: 'Optional letter',        status: 'Missing',         category: 'Supporting', applicantType: 'Principal Applicant',       applicantLabel: 'Principal Applicant',        optional: true,  clientInstructions: '' },
  { id: '6', name: 'Medical exam',           status: 'Not Applicable',  category: 'Medical',   applicantType: 'Principal Applicant',        applicantLabel: 'Principal Applicant',        optional: false, clientInstructions: '' },
  { id: '5', name: 'Employment letter',      status: 'Rework Required', category: 'Employment', applicantType: 'Principal Applicant',       applicantLabel: 'Principal Applicant',        optional: false, clientInstructions: '' },
  { id: '4', name: 'Proof of funds',         status: 'Received',        category: 'Financial', applicantType: 'Principal Applicant',        applicantLabel: 'Principal Applicant',        optional: false, clientInstructions: '' },
  { id: '3', name: 'Photo',                  status: 'Reviewed',        category: 'Identity',  applicantType: 'Principal Applicant',        applicantLabel: 'Principal Applicant',        optional: false, clientInstructions: '' },
  { id: '2', name: 'Bank statement <6 mo>',  status: 'Missing',         category: 'Financial', applicantType: 'Principal Applicant',        applicantLabel: 'Principal Applicant',        optional: false, clientInstructions: 'Last 6 months & all accounts. Statements must show your name.' },
  { id: '1', name: 'Passport',               status: 'Missing',         category: 'Identity',  applicantType: 'Principal Applicant',        applicantLabel: 'Principal Applicant',        optional: false, clientInstructions: '' },
];

const baseOpts = (over = {}) => ({
  level: 1, caseRef: REF, clientName: 'Asha Client', clientEmail: 'asha.client@example.com', caseType: 'Super Visa',
  accessToken: TOKEN, missing: svc.missingFromItems(ITEMS), deadline: { type: 'Deadline', actualDeadline: '2026-12-16', promisedSubmissionDate: '' },
  staffName: 'Mahesh Sharma', ...over,
});

/** Run with the templates board env set and mondayApi.query answering `rows`; restores everything. */
async function withBoard(rows, fn, { columns, fail } = {}) {
  const keepEnv = process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID, keepQ = mondayApi.query;
  const calls = [];
  process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID = '777';
  mondayApi.query = async (q, v) => {
    calls.push({ q, v });
    if (fail) throw new Error('monday down');
    return { boards: [{
      columns: columns || [{ id: 'name', title: 'Name', type: 'name' }, { id: 'text_s', title: 'Subject', type: 'text' }, { id: 'long_b', title: 'Body', type: 'long_text' }, { id: 'color_a', title: 'Active', type: 'status' }],
      items_page: { items: rows.map((r) => ({ name: r.name, column_values: [
        { id: 'text_s', text: r.subject || '', value: r.subject ? '"x"' : null },
        { id: 'long_b', text: r.body || '', value: r.body ? '{}' : null },
        { id: 'color_a', text: r.active === undefined ? 'Yes' : r.active, value: r.active === '' ? null : '{"index":1}' },
      ] })) },
    }] };
  };
  tpl._resetForTests();
  try { return await fn(calls); }
  finally {
    mondayApi.query = keepQ;
    if (keepEnv === undefined) delete process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID; else process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID = keepEnv;
    tpl._resetForTests();
  }
}

/** Every href in the HTML (mailto: aside). */
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('mailto:'));

// ─── templates ───────────────────────────────────────────────────────────────

test('the code defaults: four rows, every body valid, every body has {MissingList}, the final names {LastDay} and its consequence, the automatic names {Deadline}', () => {
  assert.deepEqual(cfg.ROW_NAMES, ['Reminder 1', 'Reminder 2', 'Final', 'Automatic']);
  assert.deepEqual(cfg.LEVEL_ROWS, { 1: 'Reminder 1', 2: 'Reminder 2', 3: 'Final', auto: 'Automatic' });
  for (const name of cfg.ROW_NAMES) {
    const v = tpl.validate(cfg.DEFAULTS[name]);
    assert.deepEqual(v.problems, [], `${name}: ${v.problems.join('; ')}`);
    assert.deepEqual(v.warnings, [], `${name}: no unknown tokens`);
    assert.ok(cfg.DEFAULTS[name].body.includes('{MissingList}'), name);
    assert.ok(cfg.DEFAULTS[name].body.includes('{PortalLink}'), `${name} points at the portal`);
    assert.doesNotMatch(cfg.DEFAULTS[name].body, /<[a-z]/i, `${name} is plain text`);
  }
  assert.match(cfg.DEFAULTS['Reminder 2'].body, /still missing/);
  const fin = cfg.DEFAULTS.Final.body;
  assert.match(fin, /We will wait until \{LastDay\}/);
  assert.match(fin, /moved out of document collection/);
  assert.match(fin, /refund the fee paid, less the non-refundable administration fee/);
  assert.match(fin, /stuck applications until you are ready/);
  assert.match(cfg.DEFAULTS.Automatic.body, /must be submitted by \{Deadline\}/);
  assert.deepEqual(cfg.TOKENS, ['ClientName', 'CaseRef', 'CaseType', 'MissingList', 'MissingCount', 'Deadline', 'PromisedDate', 'LastDay', 'PortalLink', 'StaffName']);
});

test('validate: tags are stripped, a body without {MissingList} or with "reply" wording is refused, an unknown {Token} is a warning only', () => {
  const v = tpl.validate({ subject: 'Hi <b>there</b>', body: '<p>Dear {ClientName},</p><p>Send {MissingList} &amp; more <script>alert(1)</script></p>' });
  assert.equal(v.ok, true);
  assert.equal(v.subject, 'Hi there');
  assert.equal(v.body, 'Dear {ClientName},\n\nSend {MissingList} & more alert(1)');
  assert.equal(tpl.validate({ subject: '', body: 'Dear {ClientName}, send the papers.' }).problems[0], 'the body has no {MissingList} — the missing documents would not be listed');
  for (const bad of ['Just reply to this message with {MissingList}', 'Reply to this email with {MissingList}', 'Please reply with it attached {MissingList}']) {
    assert.match(tpl.validate({ subject: '', body: bad }).problems.join(' '), /tells the client to reply/, bad);
  }
  assert.match(tpl.validate({ subject: 'Reply to the email', body: 'x {MissingList}' }).problems.join(' '), /tells the client to reply/, 'the subject too');
  const w = tpl.validate({ subject: '', body: '{MissingList} by {Deadlne} for {ClientName}' });
  assert.equal(w.ok, true);
  assert.deepEqual(w.warnings, ['unknown merge field left as typed: {Deadlne}']);
  assert.equal(tpl.validate({ subject: '', body: '   ' }).problems[0], 'the body is empty');
});

test('no board env → the defaults, with no Monday read at all', async () => {
  const keepEnv = process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID, keepQ = mondayApi.query;
  delete process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID;
  let reads = 0; mondayApi.query = async () => { reads++; return {}; };
  tpl._resetForTests();
  try {
    const t = await tpl.templateFor(1);
    assert.equal(t.source, 'default');
    assert.equal(t.body, cfg.DEFAULTS['Reminder 1'].body);
    assert.equal((await tpl.templateFor('auto')).name, 'Automatic');
    assert.equal(reads, 0);
    assert.deepEqual(tpl.diagnostics(), []);
    await assert.rejects(tpl.templateFor(4), /Unknown reminder level/);
  } finally { mondayApi.query = keepQ; if (keepEnv !== undefined) process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID = keepEnv; tpl._resetForTests(); }
});

test('a board row overrides its default (columns found by title); the others stay default; one read, then the cache', async () => {
  await withBoard([{ name: 'reminder 2', subject: 'Second notice — {CaseRef}', body: 'Dear {ClientName},\n\nStill missing:\n{MissingList}\n\nThanks' }], async (calls) => {
    const t2 = await tpl.templateFor(2);
    assert.equal(t2.source, 'board');
    assert.equal(t2.subject, 'Second notice — {CaseRef}');
    assert.equal(t2.body, 'Dear {ClientName},\n\nStill missing:\n{MissingList}\n\nThanks');
    assert.equal((await tpl.templateFor(1)).source, 'default');
    assert.equal((await tpl.templateFor(3)).source, 'default');
    assert.equal((await tpl.templateFor('auto')).source, 'default');
    assert.equal(calls.length, 1, 'cached for 30 minutes');
    assert.equal(calls[0].v.boardId, '777');
    assert.match(calls[0].q, /items_page\(limit: 50\)/, 'an explicit limit');
    assert.match(calls[0].q, /columns \{ id title type \}/, 'columns by title, not by id');
    assert.deepEqual(tpl.diagnostics(), []);
  });
});

test('a board row with no Subject keeps the default subject; a row switched off (Active = No, or an empty cell) is the default without a diagnostic', async () => {
  await withBoard([
    { name: 'Reminder 1', subject: '', body: 'Hi {ClientName} {MissingList}' },
    { name: 'Final', body: 'Off {MissingList} {LastDay}', active: 'No' },
    { name: 'Automatic', body: 'Empty cell {MissingList}', active: '' },
  ], async () => {
    const t1 = await tpl.templateFor(1);
    assert.equal(t1.source, 'board');
    assert.equal(t1.subject, cfg.DEFAULTS['Reminder 1'].subject);
    assert.equal((await tpl.templateFor(3)).source, 'default');
    assert.equal((await tpl.templateFor('auto')).source, 'default');
    assert.deepEqual(tpl.diagnostics(), []);
  });
});

test('an invalid board row → its code default + a diagnostic naming the row and the fault; the valid rows still come from the board', async () => {
  await withBoard([
    { name: 'Reminder 1', body: 'Dear {ClientName}, please send the papers.' },                       // no {MissingList}
    { name: 'Final', body: 'Just reply to this message with everything {MissingList} {LastDay}' },      // reply wording
    { name: 'Reminder 2', body: 'Fine {MissingList} {Deadlne}' },                                       // unknown token = warning only
  ], async () => {
    assert.equal((await tpl.templateFor(1)).source, 'default');
    assert.equal((await tpl.templateFor(3)).source, 'default');
    const t2 = await tpl.templateFor(2);
    assert.equal(t2.source, 'board');
    assert.deepEqual(t2.warnings, ['unknown merge field left as typed: {Deadlne}']);
    const d = tpl.diagnostics();
    assert.deepEqual(d.map((x) => x.row), ['Reminder 1', 'Final']);
    assert.match(d[0].problems[0], /board template "Reminder 1" is invalid — the body has no \{MissingList\}.*the code default is used/);
    assert.match(d[1].problems[0], /tells the client to reply/);
    d[0].problems.push('mutated'); assert.equal(tpl.diagnostics()[0].problems.length, 1, 'the getter hands out copies');
  });
});

test('a board that cannot be read, or has no Body column → every default + a diagnostic per row; the failure is cached briefly, not retried per send', async () => {
  await withBoard([], async (calls) => {
    assert.equal((await tpl.templateFor(1)).source, 'default');
    assert.equal((await tpl.templateFor(2)).source, 'default');
    assert.equal(calls.length, 1);
    assert.equal(tpl.diagnostics().length, 4);
    assert.match(tpl.diagnostics()[0].problems[0], /could not be read \(monday down\)/);
  }, { fail: true });
  await withBoard([{ name: 'Reminder 1', body: 'x {MissingList}' }], async () => {
    assert.equal((await tpl.templateFor(1)).source, 'default');
    assert.match(tpl.diagnostics()[0].problems[0], /has no Body column/);
  }, { columns: [{ id: 'text_s', title: 'Subject', type: 'text' }] });
});

// ─── the missing list ────────────────────────────────────────────────────────

test('missingFromItems: only Missing + required rows; N/A, optional, Rework Required, Reviewed, Received excluded; grouped by member then category, the principal applicant first', () => {
  const m = svc.missingFromItems(ITEMS);
  assert.equal(m.count, 4);
  assert.deepEqual(m.groups.map((g) => g.member), ['Principal Applicant', 'Spouse / Common-Law Partner', 'Dependent Child 1']);
  assert.deepEqual(m.groups[0].categories.map((c) => c.category), ['Identity', 'Financial'], 'the portal\'s category order');
  assert.deepEqual(m.groups[0].categories[0].items.map((i) => i.name), ['Passport']);
  assert.deepEqual(m.groups[0].categories[1].items, [{ id: '2', name: 'Bank statement <6 mo>', documentCode: '', instruction: 'Last 6 months & all accounts.' }], 'one line of instruction');
  assert.deepEqual(m.groups[1].categories[0].items[0].instruction, 'All pages with stamps.');
  assert.equal(m.rework, 1, 'the rework row is counted, not listed');
  assert.deepEqual(m.progress, { received: 3, total: 7 }, 'N/A out, optional-not-sent out; Reviewed + Received + Rework = received');
  const names = JSON.stringify(m.groups);
  for (const gone of ['Medical exam', 'Optional letter', 'Employment letter', 'Proof of funds', 'Photo']) assert.ok(!names.includes(gone), `${gone} not listed`);
});

test('missingFromItems: 0 rows → an empty list; a Super Visa "Second parent" sorts as the spouse; a stray status is not "Missing"', () => {
  assert.deepEqual(svc.missingFromItems([]), { groups: [], count: 0, rework: 0, progress: { received: 0, total: 0 } });
  assert.deepEqual(svc.missingFromItems(undefined).count, 0);
  const m = svc.missingFromItems([
    { id: 'c', name: 'C', status: 'Missing', category: 'Identity', applicantType: 'Dependent Child', applicantLabel: 'Dependent Child' },
    { id: 'b', name: 'B', status: 'Missing', category: 'Identity', applicantType: 'Spouse / Common-Law Partner', applicantLabel: 'Second parent' },
    { id: 'a', name: 'A', status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', applicantLabel: 'First parent (principal applicant)' },
    { id: 'x', name: 'X', status: 'Under Review', category: 'Identity', applicantType: 'Principal Applicant', applicantLabel: 'First parent (principal applicant)' },
  ]);
  assert.deepEqual(m.groups.map((g) => g.member), ['First parent (principal applicant)', 'Second parent', 'Dependent Child']);
  assert.equal(m.count, 3);
});

test('missingDocuments(ref) reads the case summary once (the client-visible items) and never the raw board', async () => {
  const keep = docForm.getCaseSummary;
  const asked = [];
  docForm.getCaseSummary = async (ref) => { asked.push(ref); return { items: ITEMS.slice(0, 2), clientName: 'Asha' }; };
  try {
    const m = await svc.missingDocuments(REF);
    assert.deepEqual(asked, [REF]);
    assert.equal(m.count, 2);
    docForm.getCaseSummary = async () => ({ items: [] });
    assert.equal((await svc.missingDocuments(REF)).count, 0);
  } finally { docForm.getCaseSummary = keep; }
});

// ─── the email ───────────────────────────────────────────────────────────────

test('buildReminderEmail: every token filled for every level; the list sits where {MissingList} was; progress line; masked address; Reply-To', async () => {
  for (const level of [1, 2, 3, 'auto']) {
    const r = await svc.buildReminderEmail(baseOpts({ level, lastDay: '2026-11-14' }));
    assert.doesNotMatch(r.html, /\{[A-Za-z]+\}/, `level ${level}: no token left in the html`);
    assert.doesNotMatch(r.text, /\{[A-Za-z]+\}/, `level ${level}: no token left in the text`);
    assert.doesNotMatch(r.subject, /\{[A-Za-z]+\}/, `level ${level}: subject`);
    assert.match(r.html, /Dear Asha Client,/);
    assert.match(r.html, /Still missing \(4\):/);
    assert.match(r.html, /<strong>Passport<\/strong>/);
    assert.match(r.html, /3 of 7 documents received/);
    assert.match(r.text, /3 of 7 documents received/);
    assert.match(r.text, /  - Passport\n/);
    assert.equal(r.to, 'a***@example.com');
    assert.equal(r.recipient, 'asha.client@example.com');
    assert.equal(r.replyTo, process.env.EMAIL_REPLY_TO || undefined);
    assert.deepEqual(r.warnings, [], `level ${level}`);
    assert.equal(r.template.source, 'default');
  }
  const r1 = await svc.buildReminderEmail(baseOpts({ level: 1 }));
  assert.equal(r1.subject, 'Documents still needed for your Super Visa application — 2026-TEST-001');
  assert.match(r1.html, /Mahesh Sharma/);
  const r2 = await svc.buildReminderEmail(baseOpts({ level: 2 }));
  assert.equal(r2.subject, 'Second reminder: 4 documents still missing — 2026-TEST-001');
  const r3 = await svc.buildReminderEmail(baseOpts({ level: 3, lastDay: '2026-11-14' }));
  assert.equal(r3.subject, 'Final reminder: documents required by 14 Nov 2026 — 2026-TEST-001');
  assert.match(r3.html, /We will wait until 14 Nov 2026/);
  assert.match(r3.html, /moved out of document collection/);
  const ra = await svc.buildReminderEmail(baseOpts({ level: 'auto' }));
  assert.match(ra.html, /must be submitted by 16 Dec 2026\./);
  assert.match(ra.text, /must be submitted by 16 Dec 2026\./);
  assert.ok(!/Mahesh/.test(ra.html), 'the automatic email carries no staff name');
  // the member headings only on a multi-member case; the rework count line
  assert.match(r1.html, /Spouse \/ Common-Law Partner<\/div>/);
  assert.match(r1.html, /1 document is waiting for a new copy/);
  const single = await svc.buildReminderEmail(baseOpts({ missing: svc.missingFromItems(ITEMS.filter((i) => i.applicantType === 'Principal Applicant')) }));
  assert.doesNotMatch(single.html, /Principal Applicant<\/div>/, 'no member heading for one member');
});

test('buildReminderEmail: the layout — logo header like the intake email, the EMAIL_US closing line and the no-reply line OUTSIDE the template, no nested <p>, ?t= on every link, the portal button + the plain documents link', async () => {
  const r = await svc.buildReminderEmail(baseOpts());
  const { EMAIL_US, NO_REPLY } = require('../src/utils/clientContact');
  assert.ok(r.html.includes(EMAIL_US), 'EMAIL_US');
  assert.ok(r.html.includes(NO_REPLY), 'NO_REPLY');
  assert.ok(r.text.includes('email us at info@tdotimm.com'));
  assert.ok(r.text.includes(NO_REPLY));
  assert.ok(!cfg.DEFAULTS['Reminder 1'].body.includes('info@tdotimm.com'), 'the closing line is not in the template');
  assert.match(r.html, /<img src="[^"]+\/assets\/tdot-logo\.png" alt="TDOT Immigration"/);
  assert.match(r.html, /Open your portal →/);
  assert.doesNotMatch(r.html, /<p[^>]*>(?:(?!<\/p>)[\s\S])*<p\b/, 'no <p> inside a <p>');
  assert.doesNotMatch(r.html, /<p[^>]*>(?:(?!<\/p>)[\s\S])*<(?:table|ul|div)\b/, 'no block inside a <p>');
  const links = hrefs(r.html);
  assert.equal(links.length, 3, 'the portal link where {PortalLink} sits, the button, the upload-page link');
  for (const u of links) assert.match(u, /\?t=tok-ABC123$/, u);
  assert.ok(links.some((u) => PORTAL.test(u)) && links.some((u) => DOCS.test(u)));
  assert.doesNotMatch(r.html, /staff=1/);
  assert.doesNotMatch(r.html, /\/questionnaire\//);
  assert.match(r.text, PORTAL); assert.match(r.text, DOCS);
  assert.deepEqual(r.links, { portalUrl: r.links.portalUrl, documentsUrl: r.links.documentsUrl });
  assert.match(r.links.portalUrl, PORTAL); assert.match(r.links.documentsUrl, DOCS);
  assert.doesNotMatch(r.html, /just reply|reply to this email(?!.*isn)/i);
});

test('buildReminderEmail: HTML in a board template, a document name or the staff line is stripped or escaped — never rendered', async () => {
  await withBoard([{ name: 'Reminder 1', subject: 'Docs <b>now</b> — {CaseRef}', body: 'Dear {ClientName},<br><script>alert(1)</script>\n\n{MissingList}\n\nTom &amp; Jerry <3' }], async () => {
    const r = await svc.buildReminderEmail(baseOpts({ clientName: 'Asha <i>Client</i>', extraLine: 'We still need <b>the lease</b> & the letter' }));
    assert.equal(r.subject, 'Docs now — 2026-TEST-001');
    assert.doesNotMatch(r.html, /<script|<i>|<b>the lease/);
    assert.match(r.html, /Dear Asha &lt;i&gt;Client&lt;\/i&gt;,<br>alert\(1\)/);
    assert.match(r.html, /Tom &amp; Jerry &lt;3/);
    assert.match(r.html, /<strong>Bank statement &lt;6 mo&gt;<\/strong>/);
    assert.match(r.html, /Last 6 months &amp; all accounts\./);
    assert.match(r.html, /We still need the lease &amp; the letter/);
    // the staff's line sits right under the missing list, before the template's closing text
    const at = (re) => r.html.search(re);
    assert.ok(at(/Still missing \(4\)/) < at(/We still need the lease/) && at(/We still need the lease/) < at(/Tom &amp; Jerry/), 'list → staff line → rest of the template');
    assert.match(r.text, /    - Birth certificate\n\.\.\.and 1 document is waiting for a new copy[^\n]*\n\nWe still need the lease & the letter\n\nTom & Jerry <3/);
    assert.equal(r.template.source, 'board');
  });
});

test('buildReminderEmail: the staff edits — subject and body overrides are re-checked at send; reply wording throws; a body without {MissingList} gets the list appended + a warning; unknown tokens and a missing deadline are flagged', async () => {
  const r = await svc.buildReminderEmail(baseOpts({ subjectOverride: 'Hello {ClientName} <b>!</b>', bodyOverride: 'Dear {ClientName}, here is what we need:\n{MissingList}\nBy {Deadline} please, {Deadlne}.' }));
  assert.equal(r.subject, 'Hello Asha Client !');
  assert.match(r.html, /here is what we need:<\/p>\n<table/);
  assert.match(r.html, /By 16 Dec 2026 please, \{Deadlne\}\./, 'unknown token left visible');
  assert.deepEqual(r.warnings, ['unknown merge field left as typed: {Deadlne}']);
  assert.equal(r.template.edited, true);
  const r2 = await svc.buildReminderEmail(baseOpts({ bodyOverride: 'Dear {ClientName}, please send everything by {Deadline}.', deadline: { type: '', actualDeadline: '', promisedSubmissionDate: '' } }));
  assert.ok(r2.html.indexOf('Still missing (4)') > r2.html.indexOf('please send everything'), 'the list follows the text');
  assert.equal(r2.template.listAppended, true);
  assert.deepEqual(r2.warnings, [
    'the edited text had no {MissingList} — the missing documents were added at the end',
    'the text names the deadline, but this case has no actual deadline — it reads "not set"',
  ]);
  assert.match(r2.html, /by not set\./);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ bodyOverride: 'Just reply to this message with {MissingList}' })), /cannot be sent: the text tells the client to reply/);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ bodyOverride: '{MissingList}', subjectOverride: 'Reply to the email' })), /tells the client to reply/);
});

test('buildReminderEmail refuses what cannot be a safe email: no token (never a bare link), no client email, no case ref, no last day on the final, an unknown level', async () => {
  await assert.rejects(svc.buildReminderEmail(baseOpts({ accessToken: '' })), /has no access code/);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ accessToken: undefined })), /has no access code/);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ clientEmail: ' ' })), /has no client email/);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ caseRef: '' })), /needs the case reference/);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ level: 3 })), /final reminder needs the last day/);
  await assert.rejects(svc.buildReminderEmail(baseOpts({ level: 4 })), /Unknown reminder level/);
  await assert.rejects(svc.buildReminderEmail({}), /Unknown reminder level/);
});

test('buildReminderEmail with an empty list still builds (the callers decide not to send); progress only when the totals are known', async () => {
  const r = await svc.buildReminderEmail(baseOpts({ missing: svc.missingFromItems([]) }));
  assert.match(r.html, /Still missing \(0\):/);
  assert.doesNotMatch(r.html, /documents received/);
  const r2 = await svc.buildReminderEmail(baseOpts({ missing: undefined, progress: { received: 2, total: 9 } }));
  assert.match(r2.html, /2 of 9 documents received/);
  assert.equal(r2.subject, 'Documents still needed for your Super Visa application — 2026-TEST-001');
});

test('the helpers: dates read "16 Dec 2026"; one instruction line; the automatic switch is OFF unless exactly 1/true', () => {
  const { fmtDay, oneLine } = svc._internal;
  assert.equal(fmtDay('2026-12-16'), '16 Dec 2026');
  assert.equal(fmtDay('2026-12-16T05:00:00Z'), '16 Dec 2026');
  assert.equal(fmtDay(''), ''); assert.equal(fmtDay('soon'), 'soon');
  assert.equal(oneLine('<p>Colour scan.</p> All pages!  Even blank ones.'), 'Colour scan.');
  assert.equal(oneLine('x'.repeat(200)).length, 160);
  const keep = process.env.DOC_REMINDERS_AUTO;
  try {
    for (const v of [undefined, '', '0', 'false', 'yes', 'on', ' 1 ', 'TRUE ']) { if (v === undefined) delete process.env.DOC_REMINDERS_AUTO; else process.env.DOC_REMINDERS_AUTO = v; assert.equal(svc.isAutoEnabled(), /^(1|true)$/.test(String(v || '').trim().toLowerCase()), JSON.stringify(v)); }
    process.env.DOC_REMINDERS_AUTO = '1'; assert.equal(svc.isAutoEnabled(), true);
    process.env.DOC_REMINDERS_AUTO = 'true'; assert.equal(svc.isAutoEnabled(), true);
  } finally { if (keep === undefined) delete process.env.DOC_REMINDERS_AUTO; else process.env.DOC_REMINDERS_AUTO = keep; }
});

test('source rules: the closing line is the shared EMAIL_US expression, the documents link carries the code, the templates never write, and the service writes/sends ONLY through its io seam', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const svcSrc = read('src/services/docReminderService.js'), tplSrc = read('src/services/docReminderTemplates.js');
  assert.match(svcSrc, /\$\{require\('\.\.\/utils\/clientContact'\)\.EMAIL_US\}/);
  assert.match(svcSrc, /documentsUrl = `\$\{BASE_URL\}\/documents\/\$\{encodedRef\}\?t=\$\{encodeURIComponent\(accessToken\)\}`/);
  assert.doesNotMatch(tplSrc, /mutation\s*[({]/, 'no Monday write'); assert.doesNotMatch(tplSrc, /sendEmail\(/, 'nothing sends here');
  assert.match(tplSrc, /items_page\(limit: 50\)/);
  // step B (the record + the staff send): every write and the email live inside `const io = {…}` — tests replace it, nothing else reaches Monday or Graph
  const a = svcSrc.indexOf('const io = {'), b = svcSrc.indexOf('\n};', a);
  assert.ok(a > 0 && b > a, 'the io seam exists');
  const outside = svcSrc.slice(0, a) + svcSrc.slice(b);
  assert.doesNotMatch(outside, /mutation\s*[({]/, 'no Monday write outside io');
  assert.doesNotMatch(outside, /(?<!\bio)\.sendEmail\(/, 'no send outside io (io.sendEmail is the seam)');
  assert.doesNotMatch(outside, /require\('\.\/microsoftMailService'\)|require\('\.\/mondayApi'\)/, 'the mail and Monday modules are reached only through io');
  assert.match(svcSrc.slice(a, b), /items\(ids:\$ids, limit:1\)/, 'every items(ids:) read carries an explicit limit');
});


// ═══════════════════════════ step B: the record, the guards, the staff send, the routes ═══════════════════════════
//
// The record is the case's notes: a claim note BEFORE the email, a failure note after,
// a hidden DOCREM:<origin>:<Toronto day> marker (matched in the raw body AND Monday's
// rendered text), earliest open claim wins, at most 3 failed tries a day. Every write
// and the email go through svc.io — replaced here; nothing reaches Monday or Graph.

const T0 = Date.parse('2026-11-07T15:14:00Z');   // 7 Nov 2026, 10:14 am Toronto (EST)
const DAY_MS = 24 * 3600 * 1000;
const stub = (obj, key, fn) => { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; };
const OV = (over = {}) => ({
  caseRef: REF, itemId: '4001', clientName: 'Asha Client', clientEmail: 'asha.client@example.com', caseType: 'Super Visa', accessToken: TOKEN,
  cmUnavailable: false, group: { id: 'group_sv', title: 'Super Visa' }, automationLock: 'No', escalationLastNotified: '',
  clientDeadlineRaw: { type: 'Deadline', actualDeadline: '2026-12-16', promisedSubmissionDate: '' }, ...over,
});
/** Monday renders a note's HTML into text_body (tags stripped); the API also hands back the raw body. */
const rendered = (id, at, html) => ({ id: String(id), created_at: new Date(at).toISOString(), text_body: html.replace(/<[^>]*>/g, ''), body: '' });
const raw      = (id, at, html) => ({ id: String(id), created_at: new Date(at).toISOString(), text_body: '', body: html });

test('note builders: the claim note names the level, tone, masked address, actor, count, the final\'s last day, the Toronto time and the hidden marker; the automatic one its deadline and %; the failure note its reason + the FAIL marker', () => {
  const c1 = svc.claimNote({ level: 1, to: 'a***@example.com', actor: 'Mahesh <Sharma>', count: 5, now: T0 });
  assert.equal(c1, '📨 <b>Document reminder 1 sent</b> (friendly) to a***@example.com by Mahesh Sharma — 5 documents missing — 7 Nov 2026, 10:14 am (Toronto)<span style="display:none">DOCREM:btn1:2026-11-07</span>');
  const c3 = svc.claimNote({ level: 3, to: 'a***@example.com', actor: 'Mahesh Sharma', count: 1, lastDay: '2026-11-14', now: T0 });
  assert.equal(c3, '📨 <b>Document reminder 3 sent</b> (final) to a***@example.com by Mahesh Sharma — 1 document missing — last day 14 Nov 2026 — 7 Nov 2026, 10:14 am (Toronto)<span style="display:none">DOCREM:btn3:2026-11-07</span>');
  assert.match(svc.claimNote({ level: 2, to: 'a***@x.com', actor: '', count: 2, now: T0 }), /^📨 <b>Document reminder 2 sent<\/b> \(firm\) to a\*\*\*@x\.com by staff — 2 documents missing — 7 Nov 2026, 10:14 am \(Toronto\)<span style="display:none">DOCREM:btn2:2026-11-07<\/span>$/);
  const auto = svc.claimNote({ level: 'auto', to: 'a***@example.com', count: 5, deadline: '16 Dec 2026', pct: 15, now: T0 });
  assert.equal(auto, '📨 <b>Document reminder (automatic)</b> emailed to a***@example.com — deadline 16 Dec 2026, 5 documents missing (15 % uploaded) — 7 Nov 2026, 10:14 am (Toronto)<span style="display:none">DOCREM:auto:2026-11-07</span>');
  const f = svc.failureNote({ level: 1, reason: 'the email could not be sent', now: T0 + 60000 });
  assert.equal(f, '📨 <b>Document reminder did not go out</b> — the email could not be sent — 7 Nov 2026, 10:15 am (Toronto)<span style="display:none">DOCREM-FAIL:btn1:2026-11-07</span>');
  for (const n of [c1, c3, auto, f]) assert.ok(n.startsWith(svc.NOTE_HEAD), 'every note starts with the stable head');
  assert.throws(() => svc.claimNote({ level: 4, now: T0 }), /Unknown reminder level/);
  // the Toronto day in the marker is the Toronto day, not the UTC one (11:30 pm Toronto = 04:30 UTC next day)
  assert.match(svc.claimNote({ level: 1, to: 'a@b', actor: 'x', count: 1, now: Date.parse('2026-11-08T04:30:00Z') }), /DOCREM:btn1:2026-11-07/);
});

test('parseNote reads the marker and the facts from BOTH forms of a note: the raw body and Monday\'s rendered text', () => {
  const html = svc.claimNote({ level: 3, to: 'a***@example.com', actor: 'Mahesh Sharma', count: 5, lastDay: '2026-11-14', now: T0 });
  for (const u of [rendered(11, T0, html), raw(11, T0, html)]) {
    const [n] = svc.rawNotes([u]);
    const p = svc.parseNote(n);
    assert.deepEqual([p.kind, p.origin, p.level, p.day, p.by, p.to, p.lastDay, p.id, p.at], ['claim', 'btn3', 3, '2026-11-07', 'Mahesh Sharma', 'a***@example.com', '14 Nov 2026', '11', T0]);
  }
  const autoHtml = svc.claimNote({ level: 'auto', to: 'a***@example.com', count: 5, deadline: '16 Dec 2026', pct: 15, now: T0 });
  const pa = svc.parseNote(svc.rawNotes([rendered(12, T0, autoHtml)])[0]);
  assert.deepEqual([pa.kind, pa.origin, pa.level, pa.day, pa.to, pa.by], ['claim', 'auto', 'auto', '2026-11-07', 'a***@example.com', '']);
  const fail = svc.failureNote({ level: 1, reason: 'the email could not be sent', now: T0 });
  for (const u of [rendered(13, T0, fail), raw(13, T0, fail)]) {
    const p = svc.parseNote(svc.rawNotes([u])[0]);
    assert.deepEqual([p.kind, p.origin, p.day, p.reason], ['fail', 'btn1', '2026-11-07', 'the email could not be sent']);
  }
  assert.equal(svc.parseNote({ id: '1', at: T0, text: '🔄 Document Flagged for Client Rework' }).kind, null);
  assert.equal(svc.parseNote({ id: '2', at: T0, text: 'DOCREM:btn9:2026-11-07' }).kind, null, 'an unknown origin is not a marker');
  assert.deepEqual(svc.rawNotes(null), []);
});

test('readReminderHistory: a failure cancels the newest open claim of the same origin + day above it; latest per level; auto days; sentOn / openClaims / failedTries', () => {
  const N = (id, at, html) => svc.rawNotes([rendered(id, at, html)])[0];
  const notes = [
    N(10, T0 - 4 * DAY_MS, svc.claimNote({ level: 1, to: 'a***@x', actor: 'Mahesh Sharma', count: 6, now: T0 - 4 * DAY_MS })),   // 3 Nov: reminder 1 sent
    N(20, T0 - 2 * DAY_MS, svc.claimNote({ level: 2, to: 'a***@x', actor: 'Mahesh Sharma', count: 5, now: T0 - 2 * DAY_MS })),   // 5 Nov: reminder 2 claim …
    N(21, T0 - 2 * DAY_MS + 5000, svc.failureNote({ level: 2, reason: 'the email could not be sent', now: T0 - 2 * DAY_MS + 5000 })),   // … did not go out
    N(22, T0 - 2 * DAY_MS + 3600e3, svc.claimNote({ level: 2, to: 'a***@x', actor: 'Deeksha Sharma', count: 5, now: T0 - 2 * DAY_MS + 3600e3 })),   // 5 Nov: reminder 2 sent (the retry)
    N(30, T0 - DAY_MS, svc.claimNote({ level: 'auto', to: 'a***@x', count: 5, deadline: '16 Dec 2026', pct: 15, now: T0 - DAY_MS })),   // 6 Nov: automatic
    N(40, T0, svc.claimNote({ level: 3, to: 'a***@x', actor: 'Mahesh Sharma', count: 4, lastDay: '2026-11-14', now: T0 })),          // 7 Nov: final claim …
    N(41, T0 + 5000, svc.failureNote({ level: 3, reason: 'the email could not be sent', now: T0 + 5000 })),                            // … did not go out
    { id: '5', at: T0 - 9 * DAY_MS, text: 'Intake email sent to the client' },
  ].reverse();   // Monday hands them newest first; the reader must not care
  const h = svc.readReminderHistory(notes);
  assert.deepEqual(h.sends.map((x) => x.id), ['30', '22', '10'], 'the two failed claims are tries, never sends');
  assert.deepEqual(h.claims.map((x) => [x.id, x.failed]), [['40', true], ['30', false], ['22', false], ['20', true], ['10', false]]);
  assert.deepEqual(h.failures.map((x) => x.id), ['41', '21']);
  assert.deepEqual([h.latest[1].day, h.latest[1].by, h.latest[2].day, h.latest[2].by, h.latest[3]], ['2026-11-03', 'Mahesh Sharma', '2026-11-05', 'Deeksha Sharma', null]);
  assert.deepEqual(h.auto, ['2026-11-06']);
  assert.deepEqual(svc.sentOn(h, '2026-11-05').map((x) => x.id), ['22']);
  assert.deepEqual(svc.sentOn(h, '2026-11-07'), [], 'the failed final does not count as sent today');
  assert.deepEqual(svc.openClaims(h, 'btn2', '2026-11-05').map((x) => x.id), ['22'], 'the failed claim is not open');
  assert.equal(svc.failedTries(h, 'btn3', '2026-11-07'), 1);
  assert.equal(svc.failedTries(h, 'btn2', '2026-11-05'), 1);
  assert.equal(svc.failedTries(h, 'btn1', '2026-11-03'), 0);
  const v = svc.historyView(h);
  assert.deepEqual(v.sent[1], { day: '2026-11-03', label: '3 Nov 2026', by: 'Mahesh Sharma', at: new Date(T0 - 4 * DAY_MS).toISOString(), lastDay: '' });
  assert.equal(v.sent[3], null);
  assert.deepEqual(v.auto, [{ day: '2026-11-06', label: '6 Nov 2026' }]);
  assert.equal(v.lastFailed, true, 'the newest attempt (the final) did not go out');
  assert.equal(v.failures[0].reason, 'the email could not be sent');
  assert.equal(svc.historyView(svc.readReminderHistory([])).lastFailed, false);
  // a failure never cancels a claim BELOW it (posted later) or of another level
  const h2 = svc.readReminderHistory([N(50, T0, svc.failureNote({ level: 1, reason: 'x', now: T0 })), N(51, T0 + 1000, svc.claimNote({ level: 1, to: 'a@b', actor: 'x', count: 1, now: T0 + 1000 }))]);
  assert.deepEqual(h2.sends.map((x) => x.id), ['51']);
});

test('readCaseNotes pages past the 50-note window: full pages are followed while the oldest note is inside 90 days; a short page or an old page stops; bounded; de-duplicated', async () => {
  const calls = [];
  const page = (n, count, startAt, step = 3600e3) => Array.from({ length: count }, (_, i) => rendered(n * 1000 + i, startAt - i * step, `note ${n}-${i}`));
  const restore = stub(svc.io, 'readNotes', async (itemId, p) => { calls.push([itemId, p]); return svc.rawNotes(PAGES[p - 1] || []); });
  let PAGES;
  try {
    PAGES = [page(1, 50, T0), page(2, 50, T0 - 3 * DAY_MS), page(3, 20, T0 - 6 * DAY_MS)];
    let notes = await svc.readCaseNotes('4001', { now: T0 });
    assert.deepEqual(calls, [['4001', 1], ['4001', 2], ['4001', 3]], 'three pages: the third was short');
    assert.equal(notes.length, 120);
    calls.length = 0;
    PAGES = [page(1, 50, T0, 2 * DAY_MS), page(2, 50, T0 - 100 * DAY_MS)];   // page 1 already reaches 98 days back
    notes = await svc.readCaseNotes('4001', { now: T0 });
    assert.deepEqual(calls, [['4001', 1]], 'the first page is older than the window — no second read');
    assert.equal(notes.length, 50);
    calls.length = 0;
    PAGES = Array.from({ length: 20 }, (_, i) => page(i + 1, 50, T0 - i * 3600e3 * 50));   // endless, all fresh
    notes = await svc.readCaseNotes('4001', { now: T0 });
    assert.equal(calls.length, svc.NOTES_MAX_PAGES, 'never more than NOTES_MAX_PAGES reads');
    assert.equal(notes.length, svc.NOTES_MAX_PAGES * 50);
    calls.length = 0;
    PAGES = [page(1, 50, T0), [...page(1, 10, T0), ...page(9, 10, T0 - DAY_MS)]];   // a note shifted pages between reads
    notes = await svc.readCaseNotes('4001', { now: T0 });
    assert.equal(notes.length, 60, 'the same id is never counted twice');
    assert.equal(svc.NOTES_PAGE, 50);
  } finally { restore(); }
});

test('recentClientSend + autoSkipReasons: a reminder, a rework batch note, the portal email or the escalation engine within 24 h; the once-per-day guard sees auto AND button markers', () => {
  const N = (id, at, html) => svc.rawNotes([rendered(id, at, html)])[0];
  const none = [{ id: '1', at: T0 - 3 * DAY_MS, text: '🔄 Document Flagged for Client Rework' }];
  assert.equal(svc.recentClientSend(none, { now: T0 }), '');
  assert.deepEqual(svc.autoSkipReasons(none, { now: T0 }), []);
  assert.match(svc.recentClientSend([N(2, T0 - 2 * 3600e3, svc.claimNote({ level: 2, to: 'a@b', actor: 'x', count: 1, now: T0 - 2 * 3600e3 }))], { now: T0 }), /^a document reminder went \(reminder 2\) at 7 Nov 2026, 8:14 am$/);
  assert.match(svc.recentClientSend([N(3, T0 - 3600e3, svc.claimNote({ level: 'auto', to: 'a@b', count: 1, now: T0 - 3600e3 }))], { now: T0 }), /went automatically at/);
  assert.equal(svc.recentClientSend([N(4, T0 - 3600e3, svc.claimNote({ level: 1, to: 'a@b', actor: 'x', count: 1, now: T0 - 3600e3 })), N(5, T0 - 3500e3, svc.failureNote({ level: 1, reason: 'x', now: T0 - 3500e3 }))], { now: T0 }), '', 'a failed try is not a send');
  assert.match(svc.recentClientSend([{ id: '6', at: T0 - 5 * 3600e3, text: '🔄 Document Flagged for Client Rework\n\nDocument: Passport' }], { now: T0 }), /emailed about a document to redo at 7 Nov 2026, 5:14 am/);
  assert.match(svc.recentClientSend([{ id: '7', at: T0 - 23 * 3600e3, text: '✉️ Intake email sent to a***@x' }], { now: T0 }), /the portal email went to the client/);
  assert.equal(svc.recentClientSend([{ id: '8', at: T0 - 25 * 3600e3, text: 'Intake email resent — client email address was corrected.' }], { now: T0 }), '', '25 h ago is outside the window');
  assert.match(svc.recentClientSend([], { now: T0, escalationLastNotified: '2026-11-06' }), /escalation engine emailed the client on 6 Nov 2026/);
  assert.match(svc.recentClientSend([], { now: T0, escalationLastNotified: '2026-11-07' }), /on 7 Nov 2026/);
  assert.equal(svc.recentClientSend([], { now: T0, escalationLastNotified: '2026-11-05' }), '');
  assert.equal(svc.recentClientSend([], { now: T0, escalationLastNotified: 'soon' }), '');
  // the once-per-day guard: any marker for today, from the buttons or the automatic email
  const today = [N(9, T0 - 3600e3, svc.claimNote({ level: 3, to: 'a@b', actor: 'x', count: 1, lastDay: '2026-11-14', now: T0 - 3600e3 }))];
  assert.deepEqual(svc.autoSkipReasons(today, { now: T0 }), ['a document reminder already went today (reminder 3)', 'another email reached the client in the last 24 hours: a document reminder went (reminder 3) at 7 Nov 2026, 9:14 am']);
  const yesterdayLate = [N(10, T0 - 11 * 3600e3, svc.claimNote({ level: 'auto', to: 'a@b', count: 1, now: T0 - 11 * 3600e3 }))];   // 11:14 pm Toronto the day before
  assert.deepEqual(svc.autoSkipReasons(yesterdayLate, { now: T0 }), ['another email reached the client in the last 24 hours: a document reminder went automatically at 6 Nov 2026, 11:14 pm'], 'yesterday\'s marker is not today\'s — only the 24-hour rule holds it');
});

test('previewWarnings: already went, skipped levels, out of order, automatic / a reminder today, the client emailed in 24 h, the deadline close or passed — amber words, never a block', () => {
  const N = (id, at, html) => svc.rawNotes([rendered(id, at, html)])[0];
  const h0 = svc.readReminderHistory([]);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, deadline: { actualDeadline: '2026-12-16' } }), []);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 2, now: T0 }), ['Reminder 1 skipped — this is the first reminder the client gets']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 3, now: T0 }), ['Reminders 1 and 2 skipped — the client has had no reminder yet']);
  const h1 = svc.readReminderHistory([N(1, T0 - 4 * DAY_MS, svc.claimNote({ level: 1, to: 'a@b', actor: 'Mahesh Sharma', count: 1, now: T0 - 4 * DAY_MS }))]);
  assert.deepEqual(svc.previewWarnings({ history: h1, level: 1, now: T0 }), ['Reminder 1 already went on 3 Nov 2026 (Mahesh Sharma)']);
  assert.deepEqual(svc.previewWarnings({ history: h1, level: 2, now: T0 }), []);
  assert.deepEqual(svc.previewWarnings({ history: h1, level: 3, now: T0 }), ['Reminder 2 skipped']);
  const h2 = svc.readReminderHistory([N(2, T0 - 2 * DAY_MS, svc.claimNote({ level: 2, to: 'a@b', actor: '', count: 1, now: T0 - 2 * DAY_MS }))]);
  assert.deepEqual(svc.previewWarnings({ history: h2, level: 1, now: T0 }), ['Reminder 2 already went on 5 Nov 2026 (staff) — this reminder 1 would come after it'], 'a note posted with no actor reads "by staff"');
  const h3 = svc.readReminderHistory([N(3, T0 - DAY_MS, svc.claimNote({ level: 3, to: 'a@b', actor: 'x', count: 1, lastDay: '2026-11-14', now: T0 - DAY_MS }))]);
  assert.deepEqual(svc.previewWarnings({ history: h3, level: 1, now: T0 }), ['The final reminder already went on 6 Nov 2026 (x)']);
  const hAuto = svc.readReminderHistory([N(4, T0 - 3600e3, svc.claimNote({ level: 'auto', to: 'a@b', count: 1, now: T0 - 3600e3 }))]);
  assert.deepEqual(svc.previewWarnings({ history: hAuto, level: 1, now: T0, recent: 'a document reminder went automatically at …' }), ['Automatic reminder went today'], 'the 24-h line is not repeated when the same fact is already shown');
  const hBtn = svc.readReminderHistory([N(5, T0 - 3600e3, svc.claimNote({ level: 1, to: 'a@b', actor: 'x', count: 1, now: T0 - 3600e3 }))]);
  assert.deepEqual(svc.previewWarnings({ history: hBtn, level: 2, now: T0 }), ['A reminder already went today (reminder 1)']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, recent: 'the portal email went to the client at 7 Nov 2026, 9:00 am' }), ['The client was emailed in the last 24 hours: the portal email went to the client at 7 Nov 2026, 9:00 am']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, deadline: { actualDeadline: '2026-11-09' } }), ['Deadline in 2 days (9 Nov 2026)']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, deadline: { actualDeadline: '2026-11-08' } }), ['Deadline in 1 day (8 Nov 2026)']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, deadline: { actualDeadline: '2026-11-07' } }), ['Deadline is today (7 Nov 2026)']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, deadline: { actualDeadline: '2026-11-01' } }), ['Deadline passed on 1 Nov 2026']);
  assert.deepEqual(svc.previewWarnings({ history: h0, level: 1, now: T0, deadline: { actualDeadline: '2026-11-15' } }), [], '8 days away is not "close"');
});

test('describeForCase (the card\'s facts): hidden with its reason when the CM read failed / no email / no code / no rows / nothing missing; buttons off when locked or not a live case; otherwise the Sent line', () => {
  const N = (id, at, html) => svc.rawNotes([rendered(id, at, html)])[0];
  const base = { overview: OV(), items: ITEMS, notes: [] };
  const ok = svc.describeForCase(base);
  assert.deepEqual([ok.available, ok.reason, ok.canSend, ok.blocked, ok.missingCount, ok.sent[1], ok.auto, ok.lastFailed], [true, '', true, '', 4, null, [], false]);
  assert.deepEqual(svc.describeForCase({ ...base, overview: OV({ cmUnavailable: true }) }), { ...svc.describeForCase({ ...base, overview: OV({ cmUnavailable: true }) }), available: false, reason: 'cm-unavailable', canSend: false });
  assert.match(svc.describeForCase({ ...base, overview: OV({ cmUnavailable: true }) }).message, /temporarily unavailable/);
  assert.deepEqual([svc.describeForCase({ ...base, overview: OV({ clientEmail: ' ' }) }).reason, svc.describeForCase({ ...base, overview: OV({ accessToken: '' }) }).reason], ['no-email', 'no-token']);
  const noRows = svc.describeForCase({ ...base, items: [] });
  assert.deepEqual([noRows.available, noRows.reason, noRows.message], [false, 'no-rows', 'No checklist rows yet — there is nothing to remind the client about.']);
  const allIn = svc.describeForCase({ ...base, items: ITEMS.map((it) => ({ ...it, status: it.status === 'Missing' ? 'Received' : it.status })) });
  assert.deepEqual([allIn.available, allIn.reason, allIn.message], [false, 'no-rows', 'Nothing is missing — every required document is in.']);
  const locked = svc.describeForCase({ ...base, overview: OV({ automationLock: 'Yes' }) });
  assert.deepEqual([locked.available, locked.canSend], [true, false]); assert.match(locked.blocked, /Automation Lock is on/);
  for (const group of [{ id: 'group_mm3842s', title: 'TEST' }, { id: 'group_x', title: 'Cancel / Did not retained' }, { id: 'group_mm2tz8e1', title: 'Leads' }]) {
    const g = svc.describeForCase({ ...base, overview: OV({ group }) });
    assert.equal(g.canSend, false, group.title); assert.match(g.blocked, /not a live case/);
  }
  assert.equal(svc.isCaseGroup({ id: 'group_mm3t4kda', title: 'Retainers before May 2026' }), true, 'legacy cases are live cases');
  assert.equal(svc.isCaseGroup(null), true, 'no group read (older stub) is not a refusal — the server gate reads it fresh');
  const withHistory = svc.describeForCase({ ...base, notes: [N(1, T0 - 4 * DAY_MS, svc.claimNote({ level: 1, to: 'a***@x', actor: 'Mahesh Sharma', count: 4, now: T0 - 4 * DAY_MS }))] });
  assert.deepEqual([withHistory.sent[1].label, withHistory.sent[1].by], ['3 Nov 2026', 'Mahesh Sharma']);
  assert.ok(!JSON.stringify(withHistory).includes('asha.client'), 'the card facts never carry the client address');
});

/** The staff flow, fully stubbed: the checklist read, a notes store (pages of 50), the note posts, the email. */
function staffStubs({ items = ITEMS, notes = [], sendFail = null, postFail = null, raceWith = null } = {}) {
  const store = notes.map((u) => ({ itemId: '4001', u }));   // Monday updates per case row, any order; readNotes hands them newest first
  let nextId = 1000;
  const sent = [], posted = [], deleted = [];
  const restores = [
    stub(docForm, 'getCaseSummary', async () => ({ items })),
    stub(svc.io, 'now', () => T0),
    stub(svc.io, 'readNotes', async (itemId, page) => {
      if (raceWith && posted.length && !store.some((e) => e.u.id === 'race')) store.push({ itemId: String(itemId), u: rendered('race', T0 - 1, raceWith) });   // another instance's claim with a LOWER id, seen only after ours
      const num = (u) => Number(u.id === 'race' ? 999 : u.id);
      const newest = store.filter((e) => e.itemId === String(itemId)).map((e) => e.u).sort((a, b) => num(b) - num(a));
      return svc.rawNotes(newest.slice((page - 1) * 50, page * 50));
    }),
    stub(svc.io, 'postNote', async (itemId, body) => { if (postFail) throw new Error(postFail); const id = String(nextId++); store.push({ itemId: String(itemId), u: rendered(id, T0 + posted.length, body) }); posted.push({ itemId, body, id }); return id; }),
    stub(svc.io, 'deleteNote', async (id) => { deleted.push(id); const i = store.findIndex((e) => e.u.id === String(id)); if (i >= 0) store.splice(i, 1); }),
    stub(svc.io, 'sendEmail', async (msg) => { if (sendFail) throw new Error(sendFail); sent.push(msg); }),
    stub(svc.io, 'log', () => {}), stub(svc.io, 'warn', () => {}),
  ];
  tpl._resetForTests();
  const keepEnv = process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID; delete process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID;
  return { store, sent, posted, deleted, restore: () => { restores.reverse().forEach((r) => r()); if (keepEnv === undefined) delete process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID; else process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID = keepEnv; tpl._resetForTests(); } };
}

test('previewStaffReminder: the template with the merge fields filled except the three the app inserts; the final\'s last day defaults to today + 7 (Toronto); warnings and the record ride along; nothing is written or sent', async () => {
  const S = staffStubs({ notes: [rendered(10, T0 - 4 * DAY_MS, svc.claimNote({ level: 1, to: 'a***@example.com', actor: 'Mahesh Sharma', count: 6, now: T0 - 4 * DAY_MS }))] });
  try {
    const p = await svc.previewStaffReminder({ overview: OV(), level: '1', actor: { name: 'Mahesh Sharma', verified: true } });
    assert.equal(p.level, 1);
    assert.match(p.body, /\nMahesh Sharma\n/, '{StaffName} = the verified sign-in');
    const shared = await svc.previewStaffReminder({ overview: OV(), level: '1', actor: { name: 'Unidentified (shared admin key)', verified: false } });
    assert.doesNotMatch(shared.body, /Unidentified/, 'the shared-key placeholder never signs a client email');
    assert.match(shared.body, /\nTDOT Immigration\n/);
    assert.equal(svc.senderName(null), 'TDOT Immigration');
    assert.equal(p.to, 'a***@example.com');
    assert.equal(p.subject, 'Documents still needed for your Super Visa application — 2026-TEST-001');
    assert.match(p.body, /Dear Asha Client,/);
    assert.ok(p.body.includes('{MissingList}') && p.body.includes('{PortalLink}'), 'the two app-inserted tokens stay');
    assert.ok(!/\{(ClientName|CaseRef|CaseType|MissingCount|Deadline|PromisedDate|StaffName)\}/.test(p.body), 'every other merge field is filled');
    assert.deepEqual(p.tokensLeft, ['{MissingList}', '{PortalLink}']);
    assert.equal(p.missingCount, 4);
    assert.match(p.missingList, /Passport\n/);
    assert.equal(p.deadlineLine, 'Deadline 16 Dec 2026');
    assert.equal(p.lastDay, '');
    assert.deepEqual(p.warnings, ['Reminder 1 already went on 3 Nov 2026 (Mahesh Sharma)']);
    assert.equal(p.history.sent[1].label, '3 Nov 2026');
    assert.deepEqual([p.template.name, p.template.source], ['Reminder 1', 'default']);
    const f = await svc.previewStaffReminder({ overview: OV(), level: 3 });
    assert.equal(f.lastDay, '2026-11-14', 'today (7 Nov Toronto) + 7');
    assert.equal(f.minLastDay, '2026-11-07');
    assert.ok(f.body.includes('{LastDay}'), 'the final keeps {LastDay} for the date box');
    assert.deepEqual(f.tokensLeft, ['{MissingList}', '{PortalLink}', '{LastDay}']);
    assert.equal((await svc.previewStaffReminder({ overview: OV(), level: 3, lastDay: '2026-11-20' })).lastDay, '2026-11-20', 'a chosen last day is kept');
    const nodl = await svc.previewStaffReminder({ overview: OV({ clientDeadlineRaw: { type: '', actualDeadline: '', promisedSubmissionDate: '' } }), level: 2 });
    assert.equal(nodl.deadlineLine, 'No deadline on the case');
    assert.deepEqual(nodl.warnings, [], 'reminder 1 went, so reminder 2 is in order; no deadline means no deadline warning');
    assert.equal(S.sent.length + S.posted.length + S.deleted.length, 0, 'a preview writes and sends nothing');
    await assert.rejects(svc.previewStaffReminder({ overview: OV(), level: 4 }), (e) => e.status === 400 && e.reason === 'bad-level');
    await assert.rejects(svc.previewStaffReminder({ overview: OV({ cmUnavailable: true }), level: 1 }), (e) => e.status === 503 && e.reason === 'cm-unavailable');
    await assert.rejects(svc.previewStaffReminder({ overview: OV({ group: { id: 'group_mm3b9tap', title: 'Cancel / Did not retained' } }), level: 1 }), (e) => e.status === 409 && e.reason === 'not-a-case' && /Cancel/.test(e.message));
    await assert.rejects(svc.previewStaffReminder({ overview: OV({ automationLock: 'Yes' }), level: 1 }), (e) => e.status === 409 && e.reason === 'locked');
    await assert.rejects(svc.previewStaffReminder({ overview: OV({ clientEmail: '' }), level: 1 }), (e) => e.status === 409 && e.reason === 'no-email');
    await assert.rejects(svc.previewStaffReminder({ overview: OV({ accessToken: '' }), level: 1 }), (e) => e.status === 409 && e.reason === 'no-token');
  } finally { S.restore(); }
  const empty = staffStubs({ items: [] });
  try { await assert.rejects(svc.previewStaffReminder({ overview: OV(), level: 1 }), (e) => e.status === 409 && e.reason === 'no-rows'); } finally { empty.restore(); }
});

test('sendStaffReminder: the claim note goes BEFORE the email, to the real address (never the masked one), with the staff\'s edits, the extra line escaped, the final\'s last day; the answer carries the masked address', async () => {
  const S = staffStubs();
  try {
    const r = await svc.sendStaffReminder({ overview: OV(), level: 3, subject: 'Final notice — {CaseRef}', body: 'Dear {ClientName},\n\nLast call.\n\n{MissingList}\n\nWe wait until {LastDay}. {PortalLink}\n\n{StaffName}', extra: 'We are still <b>looking</b> for the lease & the letter', lastDay: '2026-11-21', actor: { name: 'Mahesh Sharma', verified: true } });
    assert.deepEqual([r.ok, r.noted, r.to, r.level, r.day, r.lastDay, r.noteId], [true, true, 'a***@example.com', 3, '2026-11-07', '2026-11-21', '1000']);
    assert.equal(S.posted.length, 1, 'one note: the claim');
    assert.equal(S.posted[0].itemId, '4001');
    assert.equal(S.posted[0].body, '📨 <b>Document reminder 3 sent</b> (final) to a***@example.com by Mahesh Sharma — 4 documents missing — last day 21 Nov 2026 — 7 Nov 2026, 10:14 am (Toronto)<span style="display:none">DOCREM:btn3:2026-11-07</span>');
    assert.equal(S.sent.length, 1);
    const m = S.sent[0];
    assert.equal(m.to, 'asha.client@example.com', 'the email goes to the real address');
    assert.equal(m.subject, 'Final notice — 2026-TEST-001');
    assert.match(m.html, /Last call\./);
    assert.match(m.html, /We wait until 21 Nov 2026\./);
    assert.match(m.html, /We are still looking for the lease &amp; the letter/, 'the free text is tag-stripped and escaped');
    assert.match(m.html, /Mahesh Sharma/, '{StaffName} = the verified sender');
    assert.doesNotMatch(m.html, /<b>looking/);
    assert.match(m.html, /Still missing \(4\)/);
    assert.match(m.html, PORTAL); assert.match(m.html, DOCS);
    assert.ok(!('replyTo' in m) || m.replyTo, 'no empty Reply-To');
    // the claim is in the record before the email went: readNotes saw it when the race was checked
    assert.ok(S.posted[0].id < String(nextIdAfter(S)), 'claim posted first');
    const h = svc.readReminderHistory(svc.rawNotes(S.store.map((e) => e.u)));
    assert.equal(h.latest[3].day, '2026-11-07');
    assert.equal(h.latest[3].lastDay, '21 Nov 2026');
  } finally { S.restore(); }
  function nextIdAfter() { return 1001; }
});

test('sendStaffReminder refusals (nothing posted, nothing sent): bad level, the final without a last day or with one in the past, the staff\'s text telling the client to reply, the gate, 0 missing rows, 3 failed tries today', async () => {
  const S = staffStubs();
  try {
    const nothing = () => assert.equal(S.posted.length + S.sent.length, 0);
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 0, subject: 'x', body: '{MissingList}' }), (e) => e.status === 400 && e.reason === 'bad-level'); nothing();
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 3, subject: 'x', body: '{MissingList}', lastDay: '' }), (e) => e.status === 400 && e.reason === 'bad-last-day'); nothing();
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 3, subject: 'x', body: '{MissingList}', lastDay: '2026-11-06' }), (e) => e.status === 400 && /is in the past/.test(e.message)); nothing();
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 3, subject: 'x', body: '{MissingList}', lastDay: 'next week' }), (e) => e.status === 400 && e.reason === 'bad-last-day'); nothing();
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: 'Just reply to this email with {MissingList}' }), (e) => e.status === 400 && e.reason === 'bad-text' && /tells the client to reply/.test(e.message)); nothing();
    await assert.rejects(svc.sendStaffReminder({ overview: OV({ automationLock: 'Yes' }), level: 1, subject: 'x', body: '{MissingList}' }), (e) => e.status === 409 && e.reason === 'locked'); nothing();
    await assert.rejects(svc.sendStaffReminder({ overview: OV({ group: { id: '', title: 'TEST' } }), level: 1, subject: 'x', body: '{MissingList}' }), (e) => e.reason === 'not-a-case'); nothing();
  } finally { S.restore(); }
  const empty = staffStubs({ items: ITEMS.filter((it) => it.status !== 'Missing') });
  try { await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: '{MissingList}' }), (e) => e.status === 409 && e.reason === 'no-rows'); assert.equal(empty.posted.length, 0); } finally { empty.restore(); }
  const tries = [];
  for (let i = 0; i < 3; i++) { tries.push(rendered(100 + 2 * i, T0 - 3600e3 + i * 60e3, svc.claimNote({ level: 1, to: 'a@b', actor: 'x', count: 1, now: T0 - 3600e3 + i * 60e3 }))); tries.push(rendered(101 + 2 * i, T0 - 3600e3 + i * 60e3 + 5e3, svc.failureNote({ level: 1, reason: 'x', now: T0 - 3600e3 + i * 60e3 + 5e3 }))); }
  const maxed = staffStubs({ notes: tries });
  try {
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: '{MissingList}' }), (e) => e.status === 409 && e.reason === 'max-tries' && /3 times today/.test(e.message) && !/spam|credit/i.test(e.message));
    assert.equal(maxed.posted.length + maxed.sent.length, 0);
    const r2 = await svc.sendStaffReminder({ overview: OV(), level: 2, subject: 'x', body: '{MissingList}' });   // another level is not capped by reminder 1's tries
    assert.equal(r2.ok, true);
  } finally { maxed.restore(); }
});

test('sendStaffReminder: a send failure posts the failure note after the claim, answers 502 with neutral wording, and the record then reads "not sent" (a try, no sent note)', async () => {
  const S = staffStubs({ sendFail: 'Graph 503 MailboxQuotaExceeded spam filter credits' });
  try {
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: '{MissingList}', actor: { name: 'Mahesh Sharma' } }), (e) => e.status === 502 && e.sendFailed && e.message === 'The email could not be sent — please try again in a moment.');
    assert.equal(S.posted.length, 2, 'the claim, then the failure note');
    assert.match(S.posted[0].body, /^📨 <b>Document reminder 1 sent<\/b>/);
    assert.equal(S.posted[1].body, '📨 <b>Document reminder did not go out</b> — the email could not be sent — 7 Nov 2026, 10:14 am (Toronto)<span style="display:none">DOCREM-FAIL:btn1:2026-11-07</span>');
    assert.ok(!/spam|credit|Graph|Quota/i.test(S.posted[1].body), 'the note never carries the provider\'s words');
    const h = svc.readReminderHistory(svc.rawNotes(S.store.map((e) => e.u)));
    assert.equal(h.latest[1], null, 'no sent record');
    assert.equal(svc.failedTries(h, 'btn1', '2026-11-07'), 1);
    assert.equal(svc.historyView(h).lastFailed, true);
  } finally { S.restore(); }
  const P = staffStubs({ postFail: 'monday down' });
  try {
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: '{MissingList}' }), (e) => e.status === 503 && e.reason === 'note-failed' && /nothing was sent/.test(e.message));
    assert.equal(P.sent.length, 0, 'no note = no email (the record comes first)');
  } finally { P.restore(); }
});

test('sendStaffReminder: two instances — the earliest open claim wins; the loser deletes its own note and answers 409 without sending', async () => {
  const other = svc.claimNote({ level: 1, to: 'a***@example.com', actor: 'Deeksha Sharma', count: 4, now: T0 - 1 });
  const S = staffStubs({ raceWith: other });
  try {
    await assert.rejects(svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: '{MissingList}', actor: { name: 'Mahesh Sharma' } }), (e) => e.status === 409 && e.reason === 'lost-race' && /nothing was sent twice/.test(e.message));
    assert.equal(S.posted.length, 1, 'our claim was posted …');
    assert.deepEqual(S.deleted, ['1000'], '… and withdrawn');
    assert.equal(S.sent.length, 0);
  } finally { S.restore(); }
  // the same other-instance claim but FAILED (its failure note is there) is not open: ours sends
  const S2 = staffStubs({ notes: [rendered(900, T0 - 60e3, other), rendered(901, T0 - 59e3, svc.failureNote({ level: 1, reason: 'x', now: T0 - 59e3 }))] });
  try {
    const r = await svc.sendStaffReminder({ overview: OV(), level: 1, subject: 'x', body: '{MissingList}' });
    assert.equal(r.ok, true); assert.equal(S2.sent.length, 1); assert.deepEqual(S2.deleted, []);
  } finally { S2.restore(); }
});

// ─── The routes (src/routes/docReminderRoutes.js), run with fakes ────────────

const routes = require('../src/routes/docReminderRoutes');
function fakeRes() { const r = { statusCode: 200, body: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, set(k, v) { r.headers[k] = v; return r; } }; return r; }
/** The server's gate helpers as fakes: `who` = 'none' (401) | 'other' (403) | 'staff' | 'admin'. */
function deps(who, { overview = OV() } = {}) {
  return {
    resolveCaseForWrite: async (req, res) => {
      if (who === 'none') { res.status(401).json({ ok: false, error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' }); return null; }
      if (who === 'other') { res.status(403).json({ ok: false, error: 'You are not assigned to this case.' }); return null; }
      return { viewer: { isAdmin: who === 'admin', email: who === 'admin' ? '' : 'mahesh@tdotimm.com' }, overview };
    },
    staffActor: () => (who === 'admin' ? { name: 'Unidentified (shared admin key)', email: '', verified: false } : { name: 'Mahesh Sharma', email: 'mahesh@tdotimm.com', verified: true }),
  };
}
const req = (o = {}) => ({ params: { caseRef: REF }, query: {}, body: {}, ...o });

test('routes: 401 carries loginUrl, 403 says not assigned, the admin key and an assigned staffer go through; the preview is read-only and no-store', async () => {
  const S = staffStubs();
  try {
    for (const fn of [routes.preview, routes.send]) {
      let res = fakeRes(); await fn(req({ query: { level: '1' }, body: { level: 1, subject: 'x', body: '{MissingList}' } }), res, deps('none'));
      assert.equal(res.statusCode, 401); assert.equal(res.body.loginUrl, '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard');
      res = fakeRes(); await fn(req({ query: { level: '1' }, body: { level: 1, subject: 'x', body: '{MissingList}' } }), res, deps('other'));
      assert.equal(res.statusCode, 403); assert.match(res.body.error, /not assigned/);
    }
    assert.equal(S.posted.length + S.sent.length, 0);
    let res = fakeRes(); await routes.preview(req({ query: { level: '2' } }), res, deps('staff'));
    assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true); assert.equal(res.body.level, 2); assert.equal(res.body.to, 'a***@example.com');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body.warnings, ['Reminder 1 skipped — this is the first reminder the client gets']);
    assert.ok(res.body.body.includes('{MissingList}'));
    assert.equal(S.posted.length + S.sent.length, 0, 'a preview never writes or sends');
    res = fakeRes(); await routes.preview(req({ query: { level: 'x' } }), res, deps('admin'));
    assert.equal(res.statusCode, 400);
    routes._resetForTests();
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'Docs — {CaseRef}', body: 'Dear {ClientName},\n{MissingList}\n{PortalLink}', extra: '', lastDay: '', actor: 'Evil Name', staffName: 'Evil' } }), res, deps('admin'));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.ok, res.body.noted, res.body.to, res.body.level, res.body.day], [true, true, 'a***@example.com', 1, '2026-11-07']);
    assert.match(S.posted[0].body, /by Unidentified \(shared admin key\) —/, 'the actor is the sign-in (here the shared key), never a name from the body');
    assert.doesNotMatch(S.posted[0].body, /Evil/);
    assert.doesNotMatch(S.sent[0].html, /Unidentified|Evil/, 'the client email signs as the office when the sender is the shared key');
    assert.equal(S.sent[0].to, 'asha.client@example.com');
  } finally { S.restore(); routes._resetForTests(); }
});

test('routes: a second send for the same case within 60 s is refused (429) before the service runs; another case is not; the cool-down starts only on a real send', async () => {
  const S = staffStubs();
  try {
    routes._resetForTests();
    const body = { level: 1, subject: 'x', body: '{MissingList}' };
    let res = fakeRes(); await routes.send(req({ body }), res, deps('staff')); assert.equal(res.statusCode, 200);
    res = fakeRes(); await routes.send(req({ params: { caseRef: REF.toLowerCase() }, body }), res, deps('staff'));
    assert.equal(res.statusCode, 429); assert.equal(res.body.reason, 'cooldown'); assert.match(res.body.error, /less than a minute ago/);
    assert.equal(S.posted.length, 1, 'the service did not run again');
    res = fakeRes(); await routes.send(req({ params: { caseRef: '2026-TEST-002' }, body }), res, deps('staff', { overview: OV({ caseRef: '2026-TEST-002', itemId: '4002' }) }));
    assert.equal(res.statusCode, 200, 'another case has its own slot');
    assert.equal(routes.COOLDOWN_MS, 60000);
  } finally { S.restore(); routes._resetForTests(); }
  const F = staffStubs({ sendFail: 'boom' });
  try {
    routes._resetForTests();
    let res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: '{MissingList}' } }), res, deps('staff'));
    assert.equal(res.statusCode, 502); assert.deepEqual(res.body, { ok: false, reason: 'send-failed', error: 'The email could not be sent — please try again in a moment.' });
    assert.ok(!/spam|credit/i.test(res.body.error));
    assert.equal(F.posted.length, 2, 'claim + failure note');
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: '{MissingList}' } }), res, deps('staff'));
    assert.notEqual(res.statusCode, 429, 'a failed send starts no cool-down — staff may try again');
  } finally { F.restore(); routes._resetForTests(); }
});

test('routes: the service\'s refusals keep their status and reason; the text limits; the extra line reaches the email escaped', async () => {
  const S = staffStubs();
  try {
    routes._resetForTests();
    let res = fakeRes(); await routes.send(req({ body: { level: 3, subject: 'x', body: '{MissingList}', lastDay: '' } }), res, deps('staff'));
    assert.equal(res.statusCode, 400); assert.equal(res.body.reason, 'bad-last-day');
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: 'please reply to this email {MissingList}' } }), res, deps('staff'));
    assert.equal(res.statusCode, 400); assert.equal(res.body.reason, 'bad-text');
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x'.repeat(201), body: '{MissingList}' } }), res, deps('staff'));
    assert.equal(res.statusCode, 400); assert.match(res.body.error, /subject is too long/);
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: '{MissingList}' + 'y'.repeat(6000) } }), res, deps('staff'));
    assert.equal(res.statusCode, 400); assert.match(res.body.error, /text is too long/);
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: '{MissingList}', extra: 'e'.repeat(1001) } }), res, deps('staff'));
    assert.equal(res.statusCode, 400); assert.match(res.body.error, /extra line is too long/);
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: '{MissingList}' } }), res, deps('staff', { overview: OV({ automationLock: 'Yes' }) }));
    assert.equal(res.statusCode, 409); assert.equal(res.body.reason, 'locked');
    res = fakeRes(); await routes.send(req({ body: { level: 1, subject: 'x', body: '{MissingList}' } }), res, deps('staff', { overview: OV({ cmUnavailable: true }) }));
    assert.equal(res.statusCode, 503);
    assert.equal(S.posted.length + S.sent.length, 0);
    res = fakeRes(); await routes.send(req({ body: { level: 2, subject: 'x', body: '{MissingList}', extra: '<img src=x onerror=alert(1)> still "waiting"' } }), res, deps('staff'));
    assert.equal(res.statusCode, 200);
    assert.match(S.sent[0].html, /still &quot;waiting&quot;/);
    assert.doesNotMatch(S.sent[0].html, /<img src=x/);
  } finally { S.restore(); routes._resetForTests(); }
});

test('source pins: server.js registers the two routes with its own gate helpers (after the sponsor route), the route module never trusts a name from the body, the overview reads the notes with the Client Master columns (explicit limits), and the not-a-case groups match needsAttentionService', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('src/server.js');
  const g = server.indexOf("app.get('/admin/case-action/:caseRef/reminder/preview'"), p = server.indexOf("app.post('/admin/case-action/:caseRef/reminder'");
  const sponsor = server.indexOf("app.post('/admin/case-action/:caseRef/sponsor'"), folder = server.indexOf("app.get('/admin/case-action/:caseRef/folder'");
  assert.ok(sponsor < g && g < p && p < folder, 'the two routes sit with the other cockpit actions');
  assert.match(server.slice(g, g + 200), /docReminderRoutes\.preview\(req, res, \{ resolveCaseForWrite, staffActor \}\)/);
  assert.match(server.slice(p, p + 220), /express\.json\(\), \(req, res\) => docReminderRoutes\.send\(req, res, \{ resolveCaseForWrite, staffActor \}\)/);
  const routesSrc = read('src/routes/docReminderRoutes.js');
  assert.doesNotMatch(routesSrc, /body\.(actor|staffName|name|itemId|clientEmail|to)\b/, 'who clicked and whom it goes to come from the sign-in and the case, never the body');
  assert.match(routesSrc, /actor: deps\.staffActor\(req\)/);
  assert.match(routesSrc, /const key = caseRef\.toUpperCase\(\);/, 'one cool-down slot per case whatever the letter case');
  const cockpit = read('src/services/caseCockpitService.js');
  assert.match(cockpit, /items\(ids: \[\$itemId\], limit: 1\) \{\n\s+group \{ id title \}\n\s+column_values\(ids: \[\$\{ids\}\]\) \{ id text value \}\n\s+updates\(limit: \$\{CM_NOTES_LIMIT\}\) \{ id created_at text_body body \}/, 'one read: group + columns + the newest notes');
  assert.match(cockpit, /const CM_NOTES_LIMIT = 50;/);
  assert.match(cockpit, /automationLock: 'color_mm0x3x1x'/);
  assert.match(cockpit, /escalationLastNotified: 'date_mm1gqbd'/);
  // step C: the list is no longer a copy — both modules read the ONE array in src/utils/caseGroups.js
  const NA = require('../src/services/needsAttentionService');
  assert.equal(svc.NOT_CASE_GROUPS, NA.NOT_CASE_GROUPS, 'the same array object as the Needs-attention reader');
  assert.equal(svc.NOT_CASE_GROUPS, require('../src/utils/caseGroups').NOT_CASE_GROUPS);
  assert.deepEqual(svc.NOT_CASE_GROUPS.map((x) => [x.id, String(x.title)]), [['group_mm3842s', '/^test$/i'], ['group_mm2tz8e1', '/^leads$/i'], ['group_mm3b9tap', '/cancel|did not retain/i']]);
  assert.doesNotMatch(read('src/services/needsAttentionService.js'), /const NOT_CASE_GROUPS = \[/, 'no second copy of the ids');
  assert.doesNotMatch(read('src/services/docReminderService.js'), /const NOT_CASE_GROUPS = \[/, 'no second copy of the ids');
});


// ═══════════════════════════ step C: the automatic daily email, the ladder retired, the scheduler ═══════════════════════════
//
// runDocReminders reads the Document Collection rows through svc.io.listDcsRows, the notes
// through svc.io.readNotes, the checklist through documentFormService.getCaseSummary and
// the live recount through svc.io.liveUploadedPct — all replaced here. The switch OFF
// means no read at all; a dry run reads but never writes or sends.

const AUTO = svc.AUTO_COLS;
const T9 = Date.parse('2026-11-10T14:05:00Z');   // 10 Nov 2026, 9:05 am Toronto (EST)
const day9 = (n) => svc._internal.dayPlus('2026-11-10', n);
/** A Cases-board row as the automatic run reads it (every column present; override what a test needs). */
function autoRow(over = {}) {
  const v = {
    id: '5001', name: 'Asha Client', group: { id: 'group_live', title: 'November 2026' },
    ref: '2026-ISS-009', caseType: 'Super Visa', stage: 'Document Collection Started', payment: 'Paid', lock: 'No', override: '',
    deadlineType: 'Deadline', actualDeadline: day9(30), promised: '', docUploaded: '15', email: 'asha.client@example.com', token: TOKEN,
    stageStart: day9(-10), lastActivity: day9(-4), escalationLastNotified: '', ...over,
  };
  const cv = Object.entries(AUTO).map(([k, id]) => ({ id, text: v[k] == null ? '' : String(v[k]) }));
  return { id: v.id, name: v.name, group: v.group, column_values: cv };
}
/** The whole run, stubbed: rows on the board, notes per row, the checklist per ref, the live recount per ref, the email. */
function autoStubs({ rows = [], notes = {}, items = ITEMS, itemsByRef = {}, live = {}, sendFail = null, env = {} } = {}) {
  const store = [];   // { itemId, u }
  for (const [itemId, list] of Object.entries(notes)) for (const u of list) store.push({ itemId, u });
  let nextId = 7000;
  const sent = [], posted = [], deleted = [], liveCalls = [], summaryCalls = [];
  const keepEnv = {};
  for (const k of ['DOC_REMINDERS_AUTO', 'DOC_REMINDERS_IMAGINARY', 'DOC_REMINDERS_ONLY', 'DOC_REMINDERS_HOUR', 'MONDAY_REMINDER_TEMPLATES_BOARD_ID']) { keepEnv[k] = process.env[k]; delete process.env[k]; }
  for (const [k, val] of Object.entries(env)) process.env[k] = val;
  const restores = [
    stub(docForm, 'getCaseSummary', async (ref) => { summaryCalls.push(ref); return { items: ref in itemsByRef ? itemsByRef[ref] : items }; }),
    stub(svc.io, 'now', () => T9),
    stub(svc.io, 'listDcsRows', async () => { if (rows instanceof Error) throw rows; return rows; }),
    stub(svc.io, 'readNotes', async (itemId, page) => {
      const newest = store.filter((e) => e.itemId === String(itemId)).map((e) => e.u).sort((a, b) => Number(b.id) - Number(a.id));
      return svc.rawNotes(newest.slice((page - 1) * 50, page * 50));
    }),
    stub(svc.io, 'postNote', async (itemId, body) => { const id = String(nextId++); store.push({ itemId: String(itemId), u: rendered(id, T9 + posted.length, body) }); posted.push({ itemId: String(itemId), body, id }); return id; }),
    stub(svc.io, 'deleteNote', async (id) => { deleted.push(id); const i = store.findIndex((e) => e.u.id === String(id)); if (i >= 0) store.splice(i, 1); }),
    stub(svc.io, 'liveUploadedPct', async (ref) => { liveCalls.push(ref); const x = live[ref]; if (x instanceof Error) throw x; return x === undefined ? 15 : x; }),
    stub(svc.io, 'sendEmail', async (msg) => { if (sendFail) throw new Error(sendFail); sent.push(msg); }),
    stub(svc.io, 'log', () => {}), stub(svc.io, 'warn', () => {}),
  ];
  tpl._resetForTests();
  return { store, sent, posted, deleted, liveCalls, summaryCalls, restore: () => {
    restores.reverse().forEach((r) => r());
    for (const [k, val] of Object.entries(keepEnv)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
    tpl._resetForTests();
  } };
}
const byRef = (r, ref) => r.candidates.find((c) => c.caseRef === ref);

test('AUTO: the switch OFF → a real run answers { off: true } before ANY read (no Monday query, no row read); the env helpers', async () => {
  const w = autoStubs({ rows: [autoRow()] });
  const q = stub(mondayApi, 'query', async () => { throw new Error('a read happened'); });
  let listed = 0;
  const l = stub(svc.io, 'listDcsRows', async () => { listed++; return []; });
  try {
    for (const v of [undefined, '', '0', 'false', 'yes', 'on', ' 1 ']) {
      if (v === undefined) delete process.env.DOC_REMINDERS_AUTO; else process.env.DOC_REMINDERS_AUTO = v;
      const r = await svc.runDocReminders();
      assert.equal(r.off, v === ' 1 ' ? undefined : true, JSON.stringify(v));
    }
    assert.equal(listed, 1, 'only " 1 " (trimmed) switches it on');
    delete process.env.DOC_REMINDERS_AUTO;
    assert.equal(svc.isImaginaryEnabled(), false);
    process.env.DOC_REMINDERS_IMAGINARY = 'true'; assert.equal(svc.isImaginaryEnabled(), true);
    process.env.DOC_REMINDERS_ONLY = ' 2026-oss-005, 2026-VV-006 ,,'; assert.deepEqual(svc.allowList(), ['2026-OSS-005', '2026-VV-006']);
    delete process.env.DOC_REMINDERS_ONLY; assert.deepEqual(svc.allowList(), []);
    assert.equal(svc.autoHour(), 9);
    process.env.DOC_REMINDERS_HOUR = '7'; assert.equal(svc.autoHour(), 7);
    process.env.DOC_REMINDERS_HOUR = '25'; assert.equal(svc.autoHour(), 9);
    process.env.DOC_REMINDERS_HOUR = 'nine'; assert.equal(svc.autoHour(), 9);
  } finally { l(); q(); w.restore(); }
});

test('AUTO selectByColumns: every column-only skip reason, the "deadline close" hand-off, the imaginary branch behind its switch, and the happy path', () => {
  const today = '2026-11-10';
  const sel = (over, opts) => svc.selectByColumns(svc.parseAutoRow(autoRow(over)), { today, ...opts });
  const reason = (over, opts) => { const r = sel(over, opts); assert.equal(r.decision, 'skip', JSON.stringify(over)); return r.reason; };
  assert.deepEqual(sel({}), { decision: 'candidate', reason: '', variant: 'real', pct: 15 });
  assert.match(reason({ ref: '' }), /no case number/);
  assert.match(reason({}, { only: ['2026-VV-006'] }), /allow-list/);
  assert.equal(sel({ ref: '2026-vv-006' }, { only: ['2026-VV-006'] }).decision, 'candidate', 'the allow-list ignores letter case');
  assert.match(reason({ group: { id: 'group_mm3b9tap', title: 'Cancel /Did not retained' } }), /"Cancel \/Did not retained" group, not a live case/);
  assert.match(reason({ group: { id: 'group_x', title: 'TEST' } }), /not a live case/);
  assert.match(reason({ stage: 'Internal Review' }), /not at Document Collection Started \(Internal Review\)/);
  assert.match(reason({ payment: 'Already Sent' }), /Payment Status is Already Sent, not Paid/);
  assert.match(reason({ lock: 'Yes' }), /Automation Lock is Yes/);
  assert.match(reason({ override: 'yes' }), /Manual Override is Yes/);
  assert.match(reason({ email: '' }), /no client email/);
  assert.match(reason({ token: '' }), /no access code/);
  assert.match(reason({ docUploaded: '' }), /never been computed/);
  assert.match(reason({ docUploaded: 'n/a' }), /never been computed/);
  assert.match(reason({ docUploaded: '50' }), /documents at 50 % \(50 % or more\)/);
  assert.equal(sel({ docUploaded: '49.6' }).decision, 'candidate');
  assert.match(reason({ deadlineType: 'Deadline', actualDeadline: '' }), /date is blank/);
  for (const n of [3, 1, 0]) { const r = sel({ actualDeadline: day9(n) }); assert.equal(r.decision, 'attention', `${n} days`); assert.match(r.reason, n === 0 ? /deadline in 0 days/ : new RegExp(`deadline in ${n} day`)); assert.match(r.reason, /a person should call/); }
  const past = sel({ actualDeadline: day9(-2) }); assert.equal(past.decision, 'attention'); assert.match(past.reason, /deadline passed on 8 Nov 2026/);
  assert.equal(sel({ actualDeadline: day9(4) }).decision, 'candidate', '4 days away is the first day an email may go');
  assert.match(reason({ deadlineType: 'Imaginary', actualDeadline: '', promised: day9(20) }), /imaginary branch is off \(DOC_REMINDERS_IMAGINARY\)/);
  assert.match(reason({ deadlineType: 'Imaginary', actualDeadline: '', promised: '' }, { imaginary: true }), /no promised submission date/);
  assert.deepEqual(sel({ deadlineType: 'Imaginary', actualDeadline: '', promised: day9(20) }, { imaginary: true }), { decision: 'candidate', reason: '', variant: 'imaginary', pct: 15 });
  assert.match(reason({ deadlineType: '', actualDeadline: '' }), /no deadline recorded/);
  assert.match(reason({ stageStart: '' }), /Stage Start Date is blank/);
  assert.match(reason({ stageStart: day9(-2) }), /started 2 days ago — the first automatic reminder waits 3 days/);
  assert.equal(sel({ stageStart: day9(-3) }).decision, 'candidate');
  assert.match(reason({ lastActivity: today }), /uploaded today/);
  assert.match(reason({ lastActivity: day9(-1) }), /uploaded yesterday/);
  assert.equal(sel({ lastActivity: day9(-2) }).decision, 'candidate');
  assert.equal(sel({ lastActivity: '' }).decision, 'candidate', 'no activity date is not a reason to skip');
});

test('AUTO run: one row is emailed (claim note BEFORE the email, to the real address, marker + % + deadline), the others skipped for the record, the live recount, the checklist, or handed to a person', async () => {
  const A = autoRow();
  const B = autoRow({ id: '5002', ref: '2026-ISS-014', email: 'b@example.com' });      // a button reminder already went today
  const C = autoRow({ id: '5003', ref: '2026-SPE-014', email: 'c@example.com', escalationLastNotified: day9(-1) });   // the escalation engine emailed yesterday
  const D = autoRow({ id: '5004', ref: '2026-SV-020', email: 'd@example.com' });       // stored 15 %, live 60 %
  const E = autoRow({ id: '5005', ref: '2026-VRE-048', email: 'e@example.com' });      // nothing missing
  const F = autoRow({ id: '5006', ref: '2026-LBW-004', email: 'f@example.com', actualDeadline: day9(1), docUploaded: '0' });   // deadline tomorrow
  const G = autoRow({ id: '5007', ref: '2026-APPL-002', email: 'g@example.com' });     // 0 checklist rows
  const w = autoStubs({
    rows: [A, B, C, D, E, F, G], env: { DOC_REMINDERS_AUTO: '1' },
    notes: { 5002: [rendered(10, T9 - 3600e3, svc.claimNote({ level: 2, to: 'b***@example.com', actor: 'Mahesh Sharma', count: 3, now: T9 - 3600e3 }))] },
    itemsByRef: { '2026-VRE-048': ITEMS.filter((it) => it.status !== 'Missing'), '2026-APPL-002': [] },
    live: { '2026-SV-020': 60 },
  });
  try {
    const r = await svc.runDocReminders({ reason: 'test' });
    assert.equal(r.ok, true); assert.equal(r.enabled, true); assert.equal(r.checked, 7);
    assert.deepEqual([r.sent, r.failed, r.attention], [1, 0, 1]);
    assert.equal(byRef(r, '2026-ISS-009').decision, 'sent');
    assert.match(byRef(r, '2026-ISS-014').reason, /already went today \(reminder 2\)/);
    assert.match(byRef(r, '2026-SPE-014').reason, /escalation engine emailed the client on 9 Nov 2026/);
    assert.match(byRef(r, '2026-SV-020').reason, /live recount says 60 % \(the board said 15 %\)/);
    assert.match(byRef(r, '2026-VRE-048').reason, /nothing missing on the checklist/);
    assert.equal(byRef(r, '2026-LBW-004').decision, 'attention');
    assert.match(byRef(r, '2026-APPL-002').reason, /no checklist rows/);
    // exactly one email, to the real address, with the list and the deadline
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].to, 'asha.client@example.com');
    assert.match(w.sent[0].subject, /Documents needed for your Super Visa application — 2026-ISS-009/);
    assert.match(w.sent[0].html, /must be submitted by <strong>10 Dec 2026<\/strong>|must be submitted by 10 Dec 2026/);
    assert.match(w.sent[0].html, /Still missing \(4\)/);
    assert.ok(w.sent[0].html.includes(`?t=${TOKEN}`));
    assert.doesNotMatch(w.sent[0].html, /just reply/i);
    assert.ok(w.sent[0].html.includes(require('../src/utils/clientContact').EMAIL_US), 'the shared "email us" closing line');
    // the claim note went first, on the right case, with the hidden marker, the %, the deadline and the masked address
    assert.equal(w.posted.length, 1);
    assert.equal(w.posted[0].itemId, '5001');
    assert.match(w.posted[0].body, /📨 <b>Document reminder \(automatic\)<\/b> emailed to a\*\*\*@example\.com — deadline 10 Dec 2026, 4 documents missing \(15 % uploaded\)/);
    assert.match(w.posted[0].body, /DOCREM:auto:2026-11-10/);
    assert.ok(!w.posted[0].body.includes('asha.client'), 'never the real address in the note');
    // the reads that cost: no notes, checklist or recount for a row the columns already settled
    assert.deepEqual(w.liveCalls.sort(), ['2026-ISS-009', '2026-SV-020', '2026-VRE-048'].sort().filter((x) => x !== '2026-VRE-048'), 'the recount is asked only after the checklist shows something missing');
    assert.ok(!w.summaryCalls.includes('2026-LBW-004') && !w.summaryCalls.includes('2026-ISS-014'), 'a hand-off or a record skip reads no checklist');
    // the second run the same day: the marker says no
    const r2 = await svc.runDocReminders();
    assert.match(byRef(r2, '2026-ISS-009').reason, /already went today \(automatic\)/);
    assert.equal(w.sent.length, 1);
  } finally { w.restore(); }
});

test('AUTO dry run (the Engine Controls preview): every row listed with its decision and reason, nothing sent, nothing written — also while the switch is OFF (and it says so)', async () => {
  const w = autoStubs({ rows: [autoRow(), autoRow({ id: '5002', ref: '2026-X-002', payment: 'Unpaid' })], env: {} });
  try {
    const r = await svc.runDocReminders({ dryRun: true });
    assert.equal(r.ok, true); assert.equal(r.enabled, false); assert.equal(r.dryRun, true); assert.equal(r.off, undefined);
    assert.equal(r.checked, 2); assert.equal(r.wouldSend, 1);
    assert.equal(byRef(r, '2026-ISS-009').decision, 'would-send');
    assert.match(byRef(r, '2026-ISS-009').reason, /4 missing, 15 % uploaded, deadline 10 Dec 2026/);
    assert.match(byRef(r, '2026-X-002').reason, /not Paid/);
    assert.equal(w.sent.length, 0); assert.equal(w.posted.length, 0); assert.equal(w.deleted.length, 0);
    process.env.DOC_REMINDERS_AUTO = '1';
    const on = await svc.runDocReminders({ dryRun: true });
    assert.equal(on.enabled, true); assert.equal(on.wouldSend, 1);
    assert.equal(w.sent.length, 0); assert.equal(w.posted.length, 0);
  } finally { w.restore(); }
});

test('AUTO: the allow-list (DOC_REMINDERS_ONLY) keeps every other case out; a board that cannot be read ends the run with ok:false and nothing sent', async () => {
  const w = autoStubs({ rows: [autoRow(), autoRow({ id: '5002', ref: '2026-VV-006', email: 'v@example.com' })], env: { DOC_REMINDERS_AUTO: 'true', DOC_REMINDERS_ONLY: '2026-vv-006' } });
  try {
    const r = await svc.runDocReminders();
    assert.equal(byRef(r, '2026-ISS-009').decision, 'skip'); assert.match(byRef(r, '2026-ISS-009').reason, /allow-list/);
    assert.equal(byRef(r, '2026-VV-006').decision, 'sent');
    assert.deepEqual(w.sent.map((m) => m.to), ['v@example.com']);
    assert.deepEqual(r.allowList, ['2026-VV-006']);
  } finally { w.restore(); }
  const bad = autoStubs({ rows: new Error('Monday 502'), env: { DOC_REMINDERS_AUTO: '1' } });
  try {
    const r = await svc.runDocReminders();
    assert.equal(r.ok, false); assert.match(r.error, /Monday 502/); assert.equal(bad.sent.length, 0);
  } finally { bad.restore(); }
});

test('AUTO: a send that fails posts the failure note after the claim (a try, not a send); after 3 failed tries today the case is left until tomorrow; a lost race deletes its own note', async () => {
  const w = autoStubs({ rows: [autoRow()], env: { DOC_REMINDERS_AUTO: '1' }, sendFail: 'Graph 503' });
  try {
    const r = await svc.runDocReminders();
    assert.equal(byRef(r, '2026-ISS-009').decision, 'failed'); assert.equal(r.failed, 1);
    assert.equal(w.posted.length, 2);
    assert.match(w.posted[0].body, /DOCREM:auto:2026-11-10/);
    assert.match(w.posted[1].body, /📨 <b>Document reminder did not go out<\/b> — the email could not be sent/);
    assert.match(w.posted[1].body, /DOCREM-FAIL:auto:2026-11-10/);
    assert.ok(!w.posted[1].body.includes('Graph'), 'the provider never appears in a note');
    const h = svc.readReminderHistory(await svc.io.readNotes('5001', 1));
    assert.equal(h.sends.length, 0); assert.equal(svc.failedTries(h, 'auto', '2026-11-10'), 1);
    // a failure does not count as "sent today": the run tries again, up to 3
    const r2 = await svc.runDocReminders(); assert.equal(byRef(r2, '2026-ISS-009').decision, 'failed');
    const r3 = await svc.runDocReminders(); assert.equal(byRef(r3, '2026-ISS-009').decision, 'failed');
    const r4 = await svc.runDocReminders();
    assert.equal(byRef(r4, '2026-ISS-009').decision, 'skip'); assert.match(byRef(r4, '2026-ISS-009').reason, /did not go out 3 times today/);
    assert.equal(w.posted.length, 6);
  } finally { w.restore(); }
  // the race: another instance's claim with a lower id shows up on the re-read
  const race = autoStubs({ rows: [autoRow()], env: { DOC_REMINDERS_AUTO: '1' } });
  const origPost = svc.io.postNote;
  const r1 = stub(svc.io, 'postNote', async (itemId, body) => { const id = await origPost(itemId, body); race.store.push({ itemId: String(itemId), u: rendered('6999', T9 - 1, svc.claimNote({ level: 'auto', to: 'a***@example.com', count: 4, now: T9 - 1 })) }); return id; });
  try {
    const r = await svc.runDocReminders();
    assert.equal(byRef(r, '2026-ISS-009').decision, 'lost-race');
    assert.equal(race.sent.length, 0);
    assert.deepEqual(race.deleted, [race.posted[0].id], 'the loser removes its own claim');
  } finally { r1(); race.restore(); }
});

test('AUTO imaginary branch: only with DOC_REMINDERS_IMAGINARY, every 3rd day, the "Automatic" template with the promised-date lead instead of the deadline sentence', async () => {
  const row = autoRow({ deadlineType: 'Imaginary', actualDeadline: '', promised: day9(25) });
  const twoDaysAgo = rendered(20, T9 - 2 * DAY_MS, svc.claimNote({ level: 'auto', to: 'a***@example.com', count: 4, now: T9 - 2 * DAY_MS }));
  const threeDaysAgo = rendered(21, T9 - 3 * DAY_MS, svc.claimNote({ level: 'auto', to: 'a***@example.com', count: 4, now: T9 - 3 * DAY_MS }));
  const off = autoStubs({ rows: [row], env: { DOC_REMINDERS_AUTO: '1' } });
  try { const r = await svc.runDocReminders(); assert.match(byRef(r, '2026-ISS-009').reason, /imaginary branch is off/); assert.equal(off.sent.length, 0); } finally { off.restore(); }
  const soon = autoStubs({ rows: [row], env: { DOC_REMINDERS_AUTO: '1', DOC_REMINDERS_IMAGINARY: '1' }, notes: { 5001: [twoDaysAgo] } });
  try { const r = await svc.runDocReminders(); assert.match(byRef(r, '2026-ISS-009').reason, /imaginary cadence: an automatic reminder went on 8 Nov 2026 \(every 3rd day\)/); assert.equal(soon.sent.length, 0); } finally { soon.restore(); }
  const due = autoStubs({ rows: [row], env: { DOC_REMINDERS_AUTO: '1', DOC_REMINDERS_IMAGINARY: '1' }, notes: { 5001: [threeDaysAgo] } });
  try {
    const r = await svc.runDocReminders();
    assert.equal(byRef(r, '2026-ISS-009').decision, 'sent'); assert.equal(byRef(r, '2026-ISS-009').variant, 'imaginary');
    assert.equal(due.sent.length, 1);
    const html = due.sent[0].html;
    assert.match(html, /We plan to submit your Super Visa application by 5 Dec 2026\. To keep that date we need the documents below as soon as possible/);
    assert.doesNotMatch(html, /must be submitted by/); assert.doesNotMatch(html, /\{Deadline\}|not set/);
    assert.match(html, /We can only proceed once we have the documents below/, 'the rest of the paragraph stays');
    assert.match(due.posted[0].body, /deadline 5 Dec 2026/);
    // the helper alone: no {Deadline} sentence → the lead goes after the greeting
    const b = svc._internal.imaginaryBody('Dear X,\n\nHere are the documents:\n\n{MissingList}');
    assert.equal(b.split('\n\n')[1], svc._internal.IMAGINARY_LEAD);
    // a staff level never gets the variant
    const e = await svc.buildReminderEmail(baseOpts({ level: 1, variant: 'imaginary' }));
    assert.equal(e.template.variant, 'real');
  } finally { due.restore(); }
});

test('AUTO: the daily hour — isTorontoHour hits exactly one hour a day across both clock changes; the scheduler ticks hourly, checks the switch BEFORE the hour, and never uses node-cron\'s timezone', () => {
  for (const day of ['2027-03-14', '2026-11-01', '2026-10-01', '2027-01-15']) {
    const hits = Array.from({ length: 24 }, (_, h) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`)).filter((ms) => svc.isTorontoHour(9, ms));
    assert.equal(hits.length, 1, day);
  }
  assert.equal(svc.isTorontoHour(9, Date.parse('2026-11-10T14:00:00Z')), true, '14:00 UTC = 09:00 EST');
  assert.equal(svc.isTorontoHour(9, Date.parse('2026-07-10T14:00:00Z')), false, '14:00 UTC = 10:00 EDT');
  const sched = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8');
  assert.match(sched, /cron\.schedule\('0 \* \* \* \*', \(\) => \{\s*const dr = require\('\.\/docReminderService'\);\s*if \(!dr\.isAutoEnabled\(\)\) return;\s*if \(!dr\.isTorontoHour\(dr\.autoHour\(\)\)\) return;\s*withTimeout\('Document reminders', \(\) => dr\.runDocReminders\(/);
  assert.ok(!/docReminderService[\s\S]{0,600}timezone:/.test(sched));
});

test('RETIRED: the daily chain no longer calls the chasing loop; runChasingLoop() answers { retired: true } at once with no Monday read; the :386 start test and the Chasing Stage writers are untouched', async () => {
  const sched = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8');
  assert.ok(!sched.includes('runChasingLoop'), 'step 6 is gone from the chain');
  assert.ok(!sched.includes("require('./chasingLoopService')"));
  const chasing = require('../src/services/chasingLoopService');
  let reads = 0;
  const q = stub(mondayApi, 'query', async () => { reads++; throw new Error('a read happened'); });
  const logs = [];
  const l = stub(console, 'log', (m) => logs.push(String(m)));
  try {
    const r = await chasing.runChasingLoop();
    assert.deepEqual(r, { retired: true, reason: 'replaced by document reminders (2026-11)' });
    assert.equal(reads, 0);
    assert.equal(logs.filter((m) => /\[ChasingLoop\] Retired/.test(m)).length, 1, 'one console line');
  } finally { l(); q(); }
  const src = fs.readFileSync(path.join(__dirname, '../src/services/chasingLoopService.js'), 'utf8');
  assert.match(src, /if \(\(chasingStage === '' \|\| chasingStage === 'Pending'\) && daysElapsed >= profile\.r1\)/, 'the start test is NOT repaired (a repair would fire a three-morning catch-up)');
  assert.match(src, /\[CM\.chasingStage\]:\s+\{ label: 'Reminder 1 Sent' \}/, 'the writers stay as they were (unreachable)');
  assert.ok(typeof chasing.buildChasingEmail === 'function');
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const i = server.indexOf("app.post('/api/chasing/run'");
  assert.match(server.slice(i, i + 400), /resolveNamedAdminViewerOrReject[\s\S]*status: 'retired'[\s\S]*Retired — replaced by Document reminders/);
  assert.doesNotMatch(server.slice(i, i + 400), /running in background/);
});

test('RETIRED wording + the new row: the Engine Controls page (emitted script parses; chasing button off, out of Run All; preview + run buttons on the document reminders row), the Summary chart title, the guide, .env.example', () => {
  const vm = require('vm');
  const html = require('../src/routes/adminEngines').buildEnginesHTML();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const sc of scripts) new vm.Script(sc);   // throws on a syntax error (the inline-script trap)
  assert.match(html, /<span class="e-status-txt" id="txt-chasing">Retired — replaced by Document reminders<\/span>/);
  assert.match(html, /<button class="run-btn" id="btn-chasing" disabled/);
  assert.doesNotMatch(html, /ep: '\/api\/chasing\/run'/, 'Run All no longer triggers it');
  assert.match(html, /Triggers the 5 overnight engines/);
  assert.match(html, /id="btn-docrem-preview"[^>]*onclick="docRemindersPreview\(\)"/);
  assert.match(html, /id="btn-docrem-run"[^>]*onclick="docRemindersRun\(\)"/);
  assert.match(html, /fetch\(ep, \{ method: method, headers: \{ 'X-Api-Key': key/);
  assert.match(html, /'\/api\/doc-reminders\/preview'/); assert.match(html, /'\/api\/doc-reminders\/run'/);
  assert.match(html, /if \(!confirm\(/, 'a run asks first');
  // the two routes: named admins only; the preview is read-only (dry run) and no-store
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const g = server.indexOf("app.get('/api/doc-reminders/preview'"), p = server.indexOf("app.post('/api/doc-reminders/run'");
  assert.ok(g > 0 && p > g);
  assert.match(server.slice(g, p), /resolveNamedAdminViewerOrReject\(req, res, 'preview the document reminders'\)[\s\S]*no-store[\s\S]*runDocReminders\(\{ dryRun: true/);
  assert.match(server.slice(p, p + 500), /resolveNamedAdminViewerOrReject\(req, res, 'run the document reminders by hand'\)[\s\S]*runDocReminders\(\{ reason: 'run by hand' \}\)/);
  const dash = fs.readFileSync(path.join(__dirname, '../src/routes/adminDashboard.js'), 'utf8');
  assert.match(dash, /Chasing Stage Breakdown — retired \(replaced by Document reminders/);
  assert.match(dash, /function renderChasingChart\(byChasingStage\)/, 'the chart logic is unchanged');
  const guide = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/staffGuide/guide-data.json'), 'utf8'));
  const NA = require('../src/services/needsAttentionService');
  for (const kind of ['deadline-close-under-50', 'final-last-day-passed', 'dcs-no-checklist-rows', 'auto-reminder-failed']) {
    assert.ok(guide.needs_attention.some((e) => e.problem === NA.KINDS[kind].label), `guide entry for ${kind}`);
  }
  assert.ok(guide.automatic.some((e) => e.id === 'auto-doc-reminder-daily' && e.switch === 'DOC_REMINDERS_AUTO'));
  assert.match(guide.automatic.find((e) => e.id === 'auto-night-chasing').name, /RETIRED/);
  assert.ok(!JSON.stringify(guide).includes('watch the Chasing Stage column on the Cases board and chase the client yourself'));
  const env = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
  for (const k of ['DOC_REMINDERS_AUTO=', 'DOC_REMINDERS_IMAGINARY=', 'DOC_REMINDERS_ONLY=', 'DOC_REMINDERS_HOUR=', 'MONDAY_REMINDER_TEMPLATES_BOARD_ID=']) assert.ok(env.includes(k), k);
});

test('AUTO source pins: the board read lives inside the io seam (the stage column filtered on the board, explicit limits, cursor followed); the live recount is the readiness engine\'s own dry run; parseNote hands back the final\'s last day as a date', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/docReminderService.js'), 'utf8');
  const a = src.indexOf('const io = {'), b = src.indexOf('\n};', a);
  const io = src.slice(a, b);
  assert.match(io, /items_page_by_column_values\(limit:\$\{AUTO_PAGE\}, board_id:\$b, columns:\[\{column_id:"\$\{AUTO_COLS\.stage\}", column_values:\[\$v\]\}\]\)/);
  assert.match(io, /next_items_page\(limit:\$\{AUTO_PAGE\}, cursor:\$c\)/);
  assert.match(io, /refreshDocNumbers\(\{ masterItemId: itemId, caseRef, dryRun: true \}\)/);
  assert.doesNotMatch(src.slice(0, a) + src.slice(b), /items_page_by_column_values|caseReadinessService/, 'no board read outside io');
  assert.equal(svc.AUTO_COLS.docUploaded, 'numeric_mm2njqk1'); assert.equal(svc.AUTO_COLS.actualDeadline, 'date_mm33sj6t'); assert.equal(svc.AUTO_COLS.lastActivity, 'date_mm1amqyr');
  const n = svc.parseNote({ id: '1', at: T9, text: svc.claimNote({ level: 3, to: 'a***@x', actor: 'Mahesh', count: 2, lastDay: '2026-11-17', now: T9 }).replace(/<[^>]*>/g, '') });
  assert.equal(n.lastDay, '17 Nov 2026'); assert.equal(n.lastDayIso, '2026-11-17');
  assert.equal(svc._internal.dayFromWords('3 Feb 2027'), '2027-02-03'); assert.equal(svc._internal.dayFromWords('30 Sept 2026'), '2026-09-30'); assert.equal(svc._internal.dayFromWords('tomorrow'), '');
});
