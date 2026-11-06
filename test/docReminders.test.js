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

test('source rules: the closing line is the shared EMAIL_US expression, the documents link carries the code, nothing in these files writes to Monday', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const svcSrc = read('src/services/docReminderService.js'), tplSrc = read('src/services/docReminderTemplates.js');
  assert.match(svcSrc, /\$\{require\('\.\.\/utils\/clientContact'\)\.EMAIL_US\}/);
  assert.match(svcSrc, /documentsUrl = `\$\{BASE_URL\}\/documents\/\$\{encodedRef\}\?t=\$\{encodeURIComponent\(accessToken\)\}`/);
  for (const src of [svcSrc, tplSrc]) { assert.doesNotMatch(src, /mutation\s*[({]/, 'no Monday write'); assert.doesNotMatch(src, /sendEmail\(/, 'nothing sends here'); }
  assert.match(tplSrc, /items_page\(limit: 50\)/);
});
