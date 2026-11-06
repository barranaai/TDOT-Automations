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
  const na = read('src/services/needsAttentionService.js');
  const ids = [...na.slice(na.indexOf('const NOT_CASE_GROUPS = ['), na.indexOf('];', na.indexOf('const NOT_CASE_GROUPS = ['))).matchAll(/\{ id: (TEST_GROUP_ID|'[^']+'),\s+title: (\/[^\n]+?\/i) \}/g)]
    .map((m) => [m[1] === 'TEST_GROUP_ID' ? (na.match(/const TEST_GROUP_ID = '([^']+)'/) || [])[1] : m[1].slice(1, -1), m[2]]);
  assert.deepEqual(svc.NOT_CASE_GROUPS.map((x) => [x.id, String(x.title)]), ids, 'the same three groups as the Needs-attention reader');
  assert.equal(ids.length, 3);
});
