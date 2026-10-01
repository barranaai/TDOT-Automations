'use strict';

// "Needs attention" on the Summary page (2026-10-01). The rules must show a
// problem only while it still holds, never touch a board except the one
// "handled" note, and keep each viewer to the cases they may see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const NA = require('../src/services/needsAttentionService');

const H = 3600 * 1000, D = 24 * H;
const NOW = Date.parse('2026-10-01T15:00:00Z');
let seq = 0;
const note = (text, agoMs, id) => ({ id: id || `u${++seq}`, created_at: new Date(NOW - agoMs).toISOString(), text_body: text });

/** A Cases-board item as Monday returns it. */
function item({ id = String(1000 + (++seq)), name = 'Client One', group = 'group_mm6sykds', groupTitle = 'September  2026', createdAgo = 30 * D,
  ref = '2026-SV-050', caseType = 'Visitor Visa', subType = '', stage = 'Document Collection Started', payment = 'Paid', paidDate = '',
  manager = '', submission = '', people = null, updates = [] } = {}) {
  const cv = [
    ['text_mm142s49', ref], ['dropdown_mm0xd1qn', caseType], ['dropdown_mm0x4t91', subType], ['color_mm0x8faa', stage],
    ['color_mm0x9fnn', payment], ['date_mm0xgk76', paidDate], ['multiple_person_mm0xhmgk', manager], ['multiple_person_mm2nhsx1', submission],
  ].map(([cid, text]) => ({ id: cid, text, value: null }));
  if (people) cv.push({ id: 'multiple_person_mm0xgpt', text: 'Someone', value: JSON.stringify({ personsAndTeams: people }) });
  return { id, name, created_at: new Date(NOW - createdAgo).toISOString(), group: { id: group, title: groupTitle }, column_values: cv, updates };
}
const parse = (it) => NA.parseCase(it);
function run(items, { checklist = {}, folders = null, workFolders = {} } = {}) {
  return NA.detect({
    cases: items.map(parse),
    checklist: new Map(Object.entries(checklist)),
    folders,
    workFolders: new Map(Object.entries(workFolders)),
    now: NOW,
  });
}
const kinds = (entries) => entries.map((e) => e.kind).sort();

test.beforeEach(() => { NA.io.now = () => NOW; NA._resetForTests(); });

// ── Which cases count ───────────────────────────────────────────────────────

test('TEST, Leads and Cancel/Did-not-retain rows, and "TEST CLIENT" names, are never listed', () => {
  const bad = [
    item({ group: 'group_mm3842s', groupTitle: 'TEST', caseType: '', ref: '' }),
    item({ group: 'group_mm2tz8e1', groupTitle: 'Leads', caseType: '', ref: '' }),
    item({ group: 'group_mm3b9tap', groupTitle: 'Cancel /Did not retained', caseType: '', ref: '' }),
    item({ group: 'group_new', groupTitle: 'Leads', caseType: '', ref: '' }),            // re-made group: by title
    item({ name: 'TEST CLIENT - E2E 1788536909757', ref: '2026-SP-015' }),
  ];
  assert.deepEqual(run(bad, { checklist: { '2026-SP-015': false } }), []);
});

test('clients retained before the app (legacy group) get only the case-number and folder checks', () => {
  const legacy = { group: 'group_mm3t4kda', groupTitle: 'Retainers before May 2026' };
  const out = run([
    item({ ...legacy, ref: '', caseType: '', stage: 'ADR' }),                                       // no number: fine there
    item({ ...legacy, ref: '2026-OLD-001', stage: DCS(), payment: 'Already Sent', updates: [note('Payment Received @Kamal', 2 * D)] }),
    item({ ...legacy, ref: '2026-OLD-002', payment: 'Paid' }),                                      // paid, no checklist: fine there
    item({ ...legacy, ref: '2394', id: '1', name: 'Meharjeet Singh' }), item({ ...legacy, ref: '2394', id: '2', name: 'Meharjeet Singh' }),
  ], { checklist: { '2026-OLD-001': false, '2026-OLD-002': false } });
  assert.deepEqual(kinds(out), ['ref-duplicate']);
});
function DCS() { return 'Document Collection Started'; }

// ── Case numbers ────────────────────────────────────────────────────────────

test('a number on two cases is ONE item naming both rows, with a key that does not depend on order', () => {
  const a = item({ id: '11', name: 'RUCHIKA', ref: '2026-CEC-EE-086', createdAgo: 20 * D, stage: 'Application Submitted' });
  const b = item({ id: '22', name: 'Chander Sharma', ref: '2026-CEC-EE-086', createdAgo: 2 * D });
  const one = run([a, b], { checklist: { '2026-CEC-EE-086': true } }).filter((e) => e.kind === 'ref-duplicate');
  const two = run([b, a], { checklist: { '2026-CEC-EE-086': true } }).filter((e) => e.kind === 'ref-duplicate');
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].itemIds, ['11', '22']);
  assert.match(one[0].why, /RUCHIKA.*Chander Sharma/);
  assert.equal(one[0].key, two[0].key);
  assert.match(one[0].key, /^NA-[0-9a-f]{10}$/);
});

test('no case number: only after the set-up window, never on a finished case', () => {
  const out = run([
    item({ id: 'a', ref: '', caseType: 'Visitor Visa', createdAgo: 2 * H }),                   // type set, 2 h: flagged
    item({ id: 'b', ref: '', caseType: 'Visitor Visa', createdAgo: 10 * 60 * 1000 }),          // 10 min: still being set up
    item({ id: 'c', ref: '', caseType: '', createdAgo: 1 * D }),                               // no type, 1 day: not yet
    item({ id: 'd', ref: '', caseType: '', createdAgo: 3 * D }),                               // no type, 3 days: flagged
    item({ id: 'e', ref: '', caseType: '', createdAgo: 30 * D, stage: 'Cancelled' }),
  ]);
  assert.deepEqual(out.filter((e) => e.kind === 'ref-missing').map((e) => e.itemIds[0]).sort(), ['a', 'd']);
  assert.match(out.find((e) => e.itemIds[0] === 'a').todo, /Clear the Primary Case Type and select it again/);
  assert.match(out.find((e) => e.itemIds[0] === 'd').todo, /Set the Primary Case Type/);
});

// ── Folders ─────────────────────────────────────────────────────────────────

test('a leftover test folder carrying a live case number is listed, even on a submitted case', () => {
  const sp = item({ id: 'sp', name: 'Satyatej Koganti', ref: '2026-SP-004', stage: 'Application Submitted' });
  const folders = [
    { id: 'f1', name: 'TEST CLIENT - E2E 1780224413906 - 2026-SP-004', childCount: 3, createdAt: '2026-06-01T00:00:00Z' },
    { id: 'f2', name: 'ZZ Folder E2E - 2026-SP-004', childCount: 0, createdAt: '2026-06-02T00:00:00Z' },
    { id: 'f3', name: 'ZZ-TEST Praj (was 2026-VV-008)', childCount: 9, createdAt: '2026-06-03T00:00:00Z' },   // renamed: no longer ends with a number
    { id: 'f4', name: 'Ameena Begum - 2026-VV-008', childCount: 9, createdAt: '2026-06-03T00:00:00Z' },
  ];
  const vv = item({ id: 'vv', name: 'Ameena Begum', ref: '2026-VV-008' });
  const out = run([sp, vv], { folders, checklist: { '2026-VV-008': true } });
  assert.deepEqual(kinds(out), ['folder-test']);
  assert.equal(out[0].caseRef, '2026-SP-004');
  assert.match(out[0].why, /TEST CLIENT - E2E 1780224413906 - 2026-SP-004.*ZZ Folder E2E - 2026-SP-004/);
});

test('two folders for one ACTIVE case are listed; a finished case or a single folder is not', () => {
  const folders = [
    { id: 'a1', name: 'Jane Roe - 2026-SV-050', childCount: 12, createdAt: '2026-08-01T00:00:00Z' },
    { id: 'a2', name: 'Jane - 2026-SV-050', childCount: 1, createdAt: '2026-08-02T00:00:00Z' },
    { id: 'b1', name: 'Old Client - 2026-SV-051', childCount: 4, createdAt: '2026-05-01T00:00:00Z' },
    { id: 'b2', name: 'Old - 2026-SV-051', childCount: 2, createdAt: '2026-05-02T00:00:00Z' },
    { id: 'c1', name: 'Solo - 2026-SV-052', childCount: 2, createdAt: '2026-05-02T00:00:00Z' },
  ];
  const out = run([
    item({ ref: '2026-SV-050' }), item({ ref: '2026-SV-051', stage: 'Application Submitted' }), item({ ref: '2026-SV-052' }),
  ], { folders, checklist: { '2026-SV-050': true, '2026-SV-052': true } });
  assert.deepEqual(out.map((e) => [e.kind, e.caseRef]), [['folder-split', '2026-SV-050']]);
  assert.match(out[0].why, /"Jane Roe - 2026-SV-050" \(12 items\), "Jane - 2026-SV-050" \(1 item\)/);
});

test('when OneDrive could not be listed there are no folder items, and an unchecked-number warning still shows', () => {
  const c = item({ ref: '2026-SV-050', updates: [note('⚠ Case number 2026-SV-050 was assigned while OneDrive could not be checked (timeout). If a folder…', 3 * D)] });
  assert.deepEqual(kinds(run([c], { folders: null, checklist: { '2026-SV-050': true } })), ['other-warning']);
  assert.deepEqual(kinds(run([c], { folders: [], checklist: { '2026-SV-050': true } })), []);   // the listing IS that check
});

// ── Payment noted but not marked Paid ───────────────────────────────────────

test('a STAFF note saying the client paid, while Payment Status is not Paid, is listed before documents start', () => {
  const pay = (over) => item({ stage: DCS(), payment: 'Already Sent', ...over });
  const out = run([
    pay({ id: 'p1', updates: [note('Payment Received @Kamalpreet K Grewal @Deeksha Sharma', 70 * D)] }),
    pay({ id: 'p2', stage: 'Pre-Onboarding', payment: 'Signed (Unpaid)', updates: [note('[Gauri Berde] e-Transfer received today', 1 * D)] }),
    pay({ id: 'p3', updates: [note('No payment received yet, follow up Friday', 1 * D)] }),           // negated
    pay({ id: 'p4', updates: [note('✅ Payment received — milestone 1', 1 * D)] }),                   // the app's own note
    pay({ id: 'p5', updates: [note('📋 Conversation history imported from the lead record (3 update(s)) … Payment Received', 1 * D)] }),
    pay({ id: 'p6', payment: 'Paid', updates: [note('Payment Received', 1 * D)] }),
    pay({ id: 'p7', payment: 'Pro Bono', updates: [note('Payment Received', 1 * D)] }),
    pay({ id: 'p8', stage: 'Profile Created', updates: [note('Payment Received', 1 * D)] }),          // moved on by staff
  ], { checklist: { '2026-SV-050': true } });
  const listed = out.filter((e) => e.kind === 'payment-noted');
  assert.deepEqual(listed.map((e) => e.itemIds[0]).sort(), ['p1', 'p2']);
  const p1 = listed.find((e) => e.itemIds[0] === 'p1');
  assert.match(p1.why, /says "Payment Received @Kamalpreet K Grewal @Deeksha Sharma", but Payment Status is "Already Sent"/);
  assert.match(p1.todo, /set Payment Status to Paid/);
  assert.equal(p1.since, new Date(NOW - 70 * D).toISOString());
});

// ── Document checklist / onboarding ─────────────────────────────────────────

test('paid at Document Collection with no checklist rows → "no checklist" (re-seed); with rows or unknown → nothing', () => {
  const c = item({ ref: '2026-LMIA-017', stage: DCS(), payment: 'Paid', createdAgo: 9 * D });
  assert.deepEqual(kinds(run([c], { checklist: { '2026-LMIA-017': true } })), []);
  assert.deepEqual(kinds(run([c], { checklist: { '2026-LMIA-017': null } })), []);
  const out = run([c], { checklist: { '2026-LMIA-017': false } });
  assert.deepEqual(kinds(out), ['no-checklist']);
  assert.match(out[0].todo, /Re-seed Checklist → Run/);
  const early = run([item({ ref: '2026-X-1', stage: 'Pre-Onboarding', payment: 'Paid' })], { checklist: { '2026-X-1': false } });
  assert.match(early[0].todo, /Set the Case Stage to Document Collection Started/);
});

test('just paid or just started: the checklist is still being built, so nothing is listed yet', () => {
  const today = new Date(NOW).toISOString().slice(0, 10);
  assert.deepEqual(run([item({ ref: 'R1', createdAgo: 20 * 60 * 1000 })], { checklist: { R1: false } }), []);
  assert.deepEqual(run([item({ ref: 'R2', paidDate: today })], { checklist: { R2: false } }), []);
  assert.deepEqual(run([item({ ref: 'R3', updates: [note('▶️ Onboarding started automatically. The retainer…', 30 * 60 * 1000)] })], { checklist: { R3: false } }), []);
  const late = run([item({ ref: 'R4', updates: [note('▶️ Onboarding started automatically. The retainer…', 5 * H)] })], { checklist: { R4: false } });
  assert.deepEqual(kinds(late), ['no-checklist']);
  assert.match(late[0].why, /the app noted on/);
});

test('Case Sub Type notes become a "Sub Type needed" item while the case has no checklist, whatever the stage', () => {
  const subNote = note('⚠️ Document checklist NOT created yet — Case Sub Type required. “OINP” has more than one checklist variant…', 27 * D);
  const c = item({ ref: '2026-OINP-018', caseType: 'OINP', stage: 'Profile Created', payment: 'Paid', updates: [subNote] });
  const out = run([c], { checklist: { '2026-OINP-018': false } });
  assert.deepEqual(kinds(out), ['subtype']);
  assert.match(out[0].why, /Case Sub Type is blank, and OINP has more than one checklist/);
  assert.deepEqual(run([c], { checklist: { '2026-OINP-018': true } }), []);   // fixed: rows exist
  const wrong = item({ ref: 'W1', caseType: 'OINP', subType: 'CEC Single', payment: 'Paid', updates: [note('⚠️ Document checklist NOT created — the Case Sub Type doesn’t match this case type. …', D)] });
  assert.match(run([wrong], { checklist: { W1: false } })[0].why, /"CEC Single" does not fit OINP/);
});

test('onboarding on hold: waiting for signatures, worded by what is missing and by where the case is now', () => {
  const hold = (missing) => note(`⛔ Payment marked, but onboarding is on hold — missing: ${missing}. The document checklist and client emails start automatically…`, 5 * D);
  const early = run([item({ ref: 'H1', stage: 'Pre-Onboarding', updates: [hold('RCIC countersignature')] })], { checklist: { H1: false } });
  assert.deepEqual(kinds(early), ['on-hold']);
  assert.match(early[0].why, /waiting for: RCIC countersignature/);
  assert.match(early[0].todo, /Sign retainer as consultant/);
  const both = run([item({ ref: 'H2', stage: DCS(), updates: [note('⛔ Onboarding deferred: missing client signature and RCIC countersignature. The intake email…', D)] })], { checklist: { H2: false } });
  assert.match(both[0].todo, /^Remind the client to sign the retainer agreement, and the consultant countersigns it/);
  const moved = run([item({ ref: 'H3', stage: 'Profile Created', updates: [hold('client signature')] })], { checklist: { H3: false } });
  assert.match(moved[0].why, /moved on to "Profile Created"/);
  assert.deepEqual(run([item({ ref: 'H4', payment: 'Not Paid', updates: [hold('client signature')] })], { checklist: { H4: false } }), []);
  assert.deepEqual(run([item({ ref: 'H5', stage: 'Pre-Onboarding', updates: [hold('client signature')] })], { checklist: { H5: true } }), []);
});

test('the resume service\'s "did not start" note becomes an item with that note\'s own instruction', () => {
  const t = '⚠️ Fully signed and paid, but onboarding did not start automatically — the Case Stage is "Profile Created". To start it, set the Case Stage to Document Collection Started…';
  const out = run([item({ ref: 'A1', stage: 'Profile Created', updates: [note(t, 2 * D)] })], { checklist: { A1: false } });
  assert.deepEqual(kinds(out), ['not-started']);
  assert.match(out[0].todo, /Set the Case Stage to Document Collection Started/);
});

test('a finished case is never listed for payment or checklist', () => {
  const c = item({ ref: 'F1', stage: 'Application Submitted', payment: 'Already Sent', updates: [note('Payment Received', 2 * D), note('⚠️ Document checklist auto-seed FAILED for F1 after 2 attempts', 3 * D)] });
  assert.deepEqual(run([c], { checklist: { F1: false } }), []);
});

// ── The app's other warnings ────────────────────────────────────────────────

test('intake email: "not confirmed" and "did not go out" stay until a send is recorded', () => {
  const un = note('⚠️ Please check: automatic onboarding may not have finished — it was started automatically, but…', 2 * D);
  assert.deepEqual(kinds(run([item({ updates: [un] })], { checklist: { '2026-SV-050': true } })), ['intake-email']);
  assert.deepEqual(run([item({ updates: [note('✉️ Intake email sent ("Your case is ready") to j***@x.com.', D), un] })], { checklist: { '2026-SV-050': true } }), []);
  const failed = note('⚠️ The client\'s intake email did not go out (bounced). The document checklist…', 2 * D);
  assert.deepEqual(kinds(run([item({ updates: [failed] })], { checklist: { '2026-SV-050': true } })), ['intake-email']);
  assert.deepEqual(run([item({ updates: [note('✉️ Portal access email re-sent by Gauri to j***@x.com — 2 Oct', D), failed] })], { checklist: { '2026-SV-050': true } }), []);
});

test('sponsor email: listed after the automatic retry window, and gone once it is sent', () => {
  const ns = (ago) => note('🤝 Sponsor portal email not sent automatically — no sponsor / inviter email is on the client record. Add it…', ago);
  assert.deepEqual(run([item({ updates: [ns(2 * 60 * 1000)] })], { checklist: { '2026-SV-050': true } }), []);
  assert.deepEqual(kinds(run([item({ updates: [ns(2 * D)] })], { checklist: { '2026-SV-050': true } })), ['sponsor-email']);
  assert.deepEqual(run([item({ updates: [note('🤝 Sponsor portal email sent by Gauri to s***@x.com (Sponsor) — 1 Oct', D), ns(2 * D)] })], { checklist: { '2026-SV-050': true } }), []);
});

test('a payment flagged in error is listed even on a finished case, until the record is removed', () => {
  const flag = note('🚩 Payment flagged as recorded in error — Retainer ($1,500), recorded 3 Sep. Flagged by Gauri: wrong client', 4 * D);
  assert.deepEqual(kinds(run([item({ stage: 'Application Submitted', updates: [flag] })])), ['payment-flag']);
  assert.deepEqual(run([item({ stage: 'Application Submitted', updates: [note('↩️ Payment record removed — …', D), flag] })]), []);
});

test('ready for review / submission with nobody assigned', () => {
  const ri = note('📋 *Case Ready for Internal Review* 2026-SV-050 (Jane) has met the readiness threshold.', 6 * D);
  assert.deepEqual(kinds(run([item({ stage: 'Internal Review', updates: [ri] })], { checklist: {} })), ['assign']);
  assert.deepEqual(run([item({ stage: 'Internal Review', manager: 'Gauri Berde', updates: [ri] })]), []);
});

test('other warnings: each one leaves when its own fix shows', () => {
  const ck = { '2026-SV-050': true };
  const fam = note('⚠️ Family members not covered by this checklist. 1 Spouse on the Family Members board, but the current Case Sub Type "CEC Single" has no matching document role — their documents were NOT seeded.', 3 * D);
  const done = note('✅ Checklist re-seed complete for 2026-SV-050 … 4 new row(s) added', 3 * D - 5000);   // the SAME run's success note
  assert.deepEqual(kinds(run([item({ subType: 'CEC Single', updates: [fam] })], { checklist: ck })), ['other-warning']);
  assert.deepEqual(kinds(run([item({ subType: 'CEC Single', updates: [done, fam] })], { checklist: ck })), ['other-warning'], 'its own run\'s success note does not settle it');
  assert.deepEqual(kinds(run([item({ subType: 'CEC Accompanying', updates: [fam] })], { checklist: ck })), ['other-warning'], 'a new Sub Type is not enough until a re-seed ran');
  assert.deepEqual(run([item({ subType: 'CEC Accompanying', updates: [note('✅ Checklist re-seed complete …', D), done, fam] })], { checklist: ck }), []);
  const wf = note('⚠ Could not create the working folders 1-Coordinator-Working in this client\'s OneDrive folder — please add it by hand. Reason: 503', 3 * D);
  assert.deepEqual(kinds(run([item({ updates: [wf] })], { checklist: ck, workFolders: { '2026-SV-050': null } })), ['other-warning']);
  assert.deepEqual(run([item({ updates: [wf] })], { checklist: ck, workFolders: { '2026-SV-050': true } }), []);
  const rn = note('⚠ Could not rename this client\'s OneDrive intake folder to "Jane - 2026-SV-050". Documents…', 3 * D);
  assert.deepEqual(kinds(run([item({ updates: [rn] })], { checklist: ck })), ['other-warning']);
  assert.deepEqual(run([item({ updates: [note('📁 Files copied into this client\'s own folder (4 file(s), by Faran).', D), rn] })], { checklist: ck }), []);
});

test('notes are matched on Monday\'s plain text_body, which drops tags but keeps entities decoded', () => {
  // A row with every family of note at once must still give one checklist item, not several.
  const c = item({ ref: 'M1', stage: DCS(), payment: 'Paid', updates: [
    note('⚠️ Document checklist NOT created yet — Case Sub Type required. …', 1 * D),
    note('⛔ Onboarding deferred: missing client signature. The intake…', 3 * D),
  ] });
  const out = run([c], { checklist: { M1: false } });
  assert.deepEqual(kinds(out), ['subtype'], 'the NEWEST onboarding note decides the one checklist item');
});

// ── "Mark handled" ──────────────────────────────────────────────────────────

test('the handled note carries the key, is read back, and reads as none of the app\'s own notes', () => {
  const entry = { key: 'NA-0123456789', kind: 'no-checklist', caseRef: '2026-SV-050', itemIds: ['1'] };
  const body = NA.handledNoteBody(entry, 'Gauri <b>Berde</b>');
  assert.match(body, /Marked as handled/);
  assert.match(body, /Ref NA-0123456789$/);
  assert.ok(!body.includes('<b>Berde</b>'), 'the name is escaped');
  const asText = body.replace(/<[^>]+>/g, '');
  assert.deepEqual([...NA.handledKeys(NA.caseNotes([{ id: 'x', created_at: new Date(NOW).toISOString(), text_body: asText }]))], ['NA-0123456789']);
  // Every label a handled note can carry, against every note reader in the app.
  const resume = require('../src/services/onboardingResumeService');
  for (const kind of Object.keys(NA.KINDS)) {
    const t = NA.handledNoteBody({ ...entry, kind }, 'Staff');
    const plain = t.replace(/<[^>]+>/g, '');
    for (const [name, re] of Object.entries(NA.NOTE)) if (name !== 'handled') assert.ok(!re.test(plain) && !re.test(t), `${kind}: must not read as "${name}"`);
    const r = resume.readNotes([{ created_at: new Date(NOW).toISOString(), text_body: plain, body: t }]);
    assert.equal(r.heldAt, 0); assert.equal(r.resumedAt, 0); assert.deepEqual(r.evidence, [], `${kind}: no onboarding evidence`);
    assert.ok(!/checklist-blocked|tdot-onb-report|Conversation history imported|Document Uploaded by Client|post-consult-nudge/i.test(t));
    assert.equal(NA.newestPaymentNote(NA.caseNotes([{ id: 'y', created_at: new Date(NOW).toISOString(), text_body: plain }])), null);
  }
});

function harness({ items, checklist = {}, folders = [], deep = new Map(), deepFail = [], newestRow = {} }) {
  const calls = { readCases: 0, notes: [], deep: [], hasChecklist: [] };
  NA.io.readCases = async () => { calls.readCases++; return items(); };
  NA.io.hasChecklist = async (ref) => { calls.hasChecklist.push(ref); if (checklist[ref] instanceof Error) throw checklist[ref]; return !!checklist[ref]; };
  NA.io.listRootFolders = async () => { if (folders instanceof Error) throw folders; return folders; };
  NA.io.workFoldersPresent = async () => true;
  NA.io.readDeepNotes = async (ids) => { calls.deep.push(ids); return { notes: new Map([...deep].filter(([id]) => ids.includes(id) && !deepFail.includes(id))), failed: ids.filter((id) => deepFail.includes(id)) }; };
  NA.io.newestChecklistRowAt = async (ref) => newestRow[ref] || 0;
  NA.io.postNote = async (itemId, body) => { calls.notes.push({ itemId, body }); };
  return calls;
}

test('a check reads only what it needs, says what it could not check, and never writes', async () => {
  const calls = harness({
    items: () => [item({ id: 'a', ref: 'R-A', payment: 'Paid' }), item({ id: 'b', ref: 'R-B', payment: 'Paid' }), item({ id: 'c', ref: 'R-C', stage: 'Internal Review', payment: 'Paid' })],
    checklist: { 'R-A': false, 'R-B': new Error('Monday 500') },
    folders: new Error('Graph down'),
  });
  const snap = await NA.buildSnapshot();
  assert.deepEqual(calls.hasChecklist.sort(), ['R-A', 'R-B'], 'a case past Document Collection is not asked');
  assert.deepEqual(snap.entries.map((e) => [e.kind, e.caseRef]), [['no-checklist', 'R-A']]);
  assert.equal(snap.partial.length, 2);
  assert.match(snap.partial.join(' '), /OneDrive folders could not be checked \(Graph down\)/);
  assert.match(snap.partial.join(' '), /1 case could not be checked for a document checklist/);
  assert.equal(calls.notes.length, 0);
});

test('an item marked handled stays off the list — also when the note is older than the notes first read', async () => {
  const handledFor = async () => {
    harness({ items: () => [item({ id: 'a', ref: 'R-A' })], checklist: { 'R-A': false } });
    return (await NA.buildSnapshot()).entries[0];
  };
  const entry = await handledFor();
  const handledNote = { id: 'h', created_at: new Date(NOW - D).toISOString(), text_body: NA.handledNoteBody(entry, 'Gauri').replace(/<[^>]+>/g, '') };
  // Within the first read
  harness({ items: () => [item({ id: 'a', ref: 'R-A', updates: [handledNote] })], checklist: { 'R-A': false } });
  let snap = await NA.buildSnapshot();
  assert.equal(snap.entries.length, 0); assert.equal(snap.handledCount, 1);
  // Beyond it: 50 newer notes, the handled one found by the deeper read
  const filler = Array.from({ length: 50 }, (_, i) => note(`Call ${i}`, i * 1000));
  const calls = harness({ items: () => [item({ id: 'a', ref: 'R-A', updates: filler })], checklist: { 'R-A': false }, deep: new Map([['a', [...filler, handledNote]]]) });
  snap = await NA.buildSnapshot();
  assert.deepEqual(calls.deep, [['a']]);
  assert.equal(snap.entries.length, 0);
  // A different problem on the same case later is a new item.
  harness({ items: () => [item({ id: 'a', ref: 'R-A', updates: [note('Payment Received', 2 * H), handledNote] , stage: DCS(), payment: 'Not Paid' })], checklist: { 'R-A': true } });
  snap = await NA.buildSnapshot();
  assert.deepEqual(snap.entries.map((e) => e.kind), ['payment-noted']);
});

test('one check at a time; "Check now" waits two minutes between checks', async () => {
  let release;
  const calls = harness({ items: () => [item({ ref: 'R-A' })], checklist: { 'R-A': true } });
  NA.io.readCases = async () => { calls.readCases++; await new Promise((r) => { release = r; }); return [item({ ref: 'R-A' })]; };
  const p1 = NA.refresh(); const p2 = NA.refresh();
  assert.equal(p1, p2);
  assert.deepEqual(NA.requestRefresh(), { started: false, running: true });
  await new Promise((r) => setImmediate(r));
  release();
  await p1;
  assert.equal(calls.readCases, 1);
  const again = NA.requestRefresh();
  assert.equal(again.started, false);
  assert.equal(again.retryInSec, 120);
  NA.io.now = () => NOW + 3 * 60 * 1000;
  assert.equal(NA.requestRefresh().started, true);
});

test('a failed check keeps the last list and says so', async () => {
  harness({ items: () => [item({ ref: 'R-A', payment: 'Paid' })], checklist: { 'R-A': false } });
  await NA.refresh();
  NA.io.readCases = async () => { throw new Error('Monday 503'); };
  await assert.rejects(NA.refresh(), /Monday 503/);
  const v = NA.view({ isAdmin: true, scope: 'all' });
  assert.equal(v.entries.length, 1);
  assert.match(v.error.message, /Monday 503/);
});

test('each viewer sees only the cases they may see, and assignee ids never leave the server', async () => {
  harness({
    items: () => [
      item({ id: 'mine', ref: 'R-MINE', payment: 'Paid', people: [{ id: 77, kind: 'person' }] }),
      item({ id: 'team', ref: 'R-TEAM', payment: 'Paid', people: [{ id: 5, kind: 'team' }] }),
      item({ id: 'other', ref: 'R-OTHER', payment: 'Paid', people: [{ id: 99, kind: 'person' }] }),
    ],
    checklist: { 'R-MINE': false, 'R-TEAM': false, 'R-OTHER': false },
  });
  await NA.refresh();
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    const staff = { userId: '77', teamIds: ['5'], isAdmin: false, scope: 'assigned' };
    assert.deepEqual(NA.view(staff).entries.map((e) => e.caseRef).sort(), ['R-MINE', 'R-TEAM']);
    assert.equal(NA.view({ userId: '1', teamIds: [], isAdmin: false, scope: 'assigned' }).entries.length, 0);
    assert.equal(NA.view({ isAdmin: true, scope: 'all' }).entries.length, 3);
    for (const e of NA.view({ isAdmin: true, scope: 'all' }).entries) assert.ok(!('assignees' in e));
  } finally {
    if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev;
  }
});

test('the first view after a restart starts the check; the page then sees it running', async () => {
  let release;
  harness({ items: () => [] });
  NA.io.readCases = async () => { await new Promise((r) => { release = r; }); return []; };
  const v = NA.view({ isAdmin: true, scope: 'all' }, { ensure: true });
  assert.equal(v.running, true);
  assert.equal(v.checkedAt, '');
  await new Promise((r) => setImmediate(r));
  release();
  await new Promise((r) => setTimeout(r, 5));
  const after = NA.view({ isAdmin: true, scope: 'all' }, { ensure: true });
  assert.equal(after.running, false);
  assert.ok(after.checkedAt);
});

test('Mark handled: only a listed item this viewer can see; one note on the case; off the list at once', async () => {
  const calls = harness({ items: () => [item({ id: 'a', ref: 'R-A', payment: 'Paid', people: [{ id: 99, kind: 'person' }] })], checklist: { 'R-A': false } });
  await assert.rejects(NA.markHandled({ key: 'NA-0000000000', viewer: { isAdmin: true }, actor: 'x' }), (e) => e.status === 503);
  await NA.refresh();
  const [entry] = NA.view({ isAdmin: true, scope: 'all' }).entries;
  await assert.rejects(NA.markHandled({ key: 'NA-0000000000', viewer: { isAdmin: true }, actor: 'x' }), (e) => e.status === 404);
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    await assert.rejects(NA.markHandled({ key: entry.key, viewer: { userId: '1', teamIds: [], scope: 'assigned' }, actor: 'x' }), (e) => e.status === 404);
  } finally { if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
  assert.deepEqual(await NA.markHandled({ key: entry.key, viewer: { isAdmin: true, scope: 'all' }, actor: 'Gauri Berde' }), { ok: true });
  assert.equal(calls.notes.length, 1);
  assert.equal(calls.notes[0].itemId, 'a');
  assert.match(calls.notes[0].body, new RegExp(`Gauri Berde[\\s\\S]*Ref ${entry.key}$`));
  assert.equal(NA.view({ isAdmin: true, scope: 'all' }).entries.length, 0);
  assert.deepEqual(await NA.markHandled({ key: entry.key, viewer: { isAdmin: true, scope: 'all' }, actor: 'x' }), { ok: true, already: true });
  assert.equal(calls.notes.length, 1, 'no second note');
});

test('Mark handled: a failed note leaves the item listed; two clicks at once give one note', async () => {
  const calls = harness({ items: () => [item({ id: 'a', ref: 'R-A', payment: 'Paid' })], checklist: { 'R-A': false } });
  await NA.refresh();
  const [entry] = NA.view({ isAdmin: true, scope: 'all' }).entries;
  NA.io.postNote = async () => { throw new Error('Monday 500'); };
  await assert.rejects(NA.markHandled({ key: entry.key, viewer: { isAdmin: true, scope: 'all' }, actor: 'x' }), /Monday 500/);
  assert.equal(NA.view({ isAdmin: true, scope: 'all' }).entries.length, 1);
  let release;
  NA.io.postNote = async (itemId, body) => { await new Promise((r) => { release = r; }); calls.notes.push({ itemId, body }); };
  const first = NA.markHandled({ key: entry.key, viewer: { isAdmin: true, scope: 'all' }, actor: 'x' });
  await assert.rejects(NA.markHandled({ key: entry.key, viewer: { isAdmin: true, scope: 'all' }, actor: 'y' }), (e) => e.status === 409);
  release();
  await first;
  assert.equal(calls.notes.length, 1);
});

test('an item marked during a check stays hidden until a check that started after it has read the note', async () => {
  const calls = harness({ items: () => [item({ id: 'a', ref: 'R-A', payment: 'Paid' })], checklist: { 'R-A': false } });
  await NA.refresh();
  const [entry] = NA.view({ isAdmin: true, scope: 'all' }).entries;
  // A check is running (it read the board before the note)…
  let release;
  NA.io.readCases = async () => { await new Promise((r) => { release = r; }); return [item({ id: 'a', ref: 'R-A', payment: 'Paid' })]; };
  NA.io.now = () => NOW + 3 * 60 * 1000;
  const running = NA.refresh();
  NA.io.now = () => NOW + 4 * 60 * 1000;
  await NA.markHandled({ key: entry.key, viewer: { isAdmin: true, scope: 'all' }, actor: 'x' });
  await new Promise((r) => setImmediate(r));
  release(); await running;
  assert.equal(NA.view({ isAdmin: true, scope: 'all' }).entries.length, 0, 'the stale check must not bring it back');
  // …the next check reads the note itself.
  const noteText = calls.notes[0].body.replace(/<[^>]+>/g, '');
  NA.io.readCases = async () => [item({ id: 'a', ref: 'R-A', payment: 'Paid', updates: [{ id: 'h', created_at: new Date(NOW).toISOString(), text_body: noteText }] })];
  NA.io.now = () => NOW + 10 * 60 * 1000;
  await NA.refresh();
  assert.equal(NA.view({ isAdmin: true, scope: 'all' }).entries.length, 0);
});

// ── Wiring (the server starts on import, so it is checked from the source) ──

test('routes: signed-in viewers only; the handled route takes only a well-formed key', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  for (const route of ["app.get('/admin/needs-attention'", "app.post('/admin/needs-attention/refresh'", "app.post('/admin/needs-attention/handled'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, route);
    assert.match(src.slice(at, at + 400), /const viewer = resolveViewer\(req\);\s*if \(!viewer\) return res\.status\(401\)/, `${route} is gated`);
  }
  assert.match(src, /if \(!\/\^NA-\[0-9a-f\]\{10\}\$\/\.test\(key\)\) return res\.status\(400\)/);
});

test('the daily check runs at 07:00 TORONTO time (the server clock is UTC)', () => {
  const code = fs.readFileSync(require.resolve('../src/services/scheduler.js'), 'utf8');
  // node-cron 4's own timezone option skips the run on the days the clocks change: an hourly tick checks Toronto's hour.
  assert.match(code, /cron\.schedule\('0 \* \* \* \*', \(\) => \{\s*const na = require\('\.\/needsAttentionService'\);\s*if \(!na\.isTorontoHour\(7\)\) return;\s*na\.refresh\(/);
  assert.ok(!/needsAttention[\s\S]{0,400}timezone:/.test(code));
  // Exactly one 7 o'clock hour per Toronto day, across both clock changes.
  for (const day of ['2027-03-14', '2026-11-01', '2026-10-01', '2027-01-15']) {
    const hits = Array.from({ length: 24 }, (_, h) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`)).filter((ms) => NA.isTorontoHour(7, ms));
    assert.equal(hits.length, 1, day);
  }
});

// ── Review round 1 (2026-10-01): each confirmed finding pinned ───────────────

test('a re-seed tried before the Sub Type was set keeps the Sub Type item (and its key), not "flip Re-seed" again', () => {
  const sub = note('⚠️ Document checklist NOT created yet — Case Sub Type required. “OINP” has more than one…', 5 * D);
  const before = run([item({ id: 'S1', ref: 'S1', caseType: 'OINP', stage: 'Profile Created', updates: [sub] })], { checklist: { S1: false } });
  const failed = note('⚠ Re-seed failed: No code schema registered for "OINP / null" — re-seed only supports schema-driven case types. Check that the Sub Type column is set…', D);
  const after = run([item({ id: 'S1', ref: 'S1', caseType: 'OINP', stage: 'Profile Created', updates: [failed, sub] })], { checklist: { S1: false } });
  assert.deepEqual(kinds(after), ['subtype']);
  assert.equal(after[0].key, before[0].key, 'marked handled once, it stays handled');
});

test('the Sub Type item is worded from the case as it is now', () => {
  const sub = note('⚠️ Document checklist NOT created yet — Case Sub Type required. …', 5 * D);
  const now = run([item({ ref: 'S2', caseType: 'OINP', subType: 'Masters Graduate Stream', stage: 'Profile Created', updates: [sub] })], { checklist: { S2: false } });
  assert.match(now[0].why, /is now "Masters Graduate Stream", but the document checklist has not been built/);
  assert.match(now[0].todo, /^Flip Re-seed Checklist → Run/);
  const wrongNote = note('⚠️ Document checklist NOT created — the Case Sub Type doesn’t match this case type. “CEC Single” is not a Sub Type of “OINP” (the Sub Type list…', 5 * D);
  assert.match(run([item({ ref: 'S3', caseType: 'OINP', subType: 'CEC Single', updates: [wrongNote] })], { checklist: { S3: false } })[0].why, /"CEC Single" does not fit OINP/);
  assert.match(run([item({ ref: 'S4', caseType: 'OINP', subType: 'Masters Graduate Stream', updates: [wrongNote] })], { checklist: { S4: false } })[0].why, /is now "Masters Graduate Stream"/);
});

test('files left behind by a merge: settled by a later clean finish run', () => {
  const partialRun = note('📁 Files copied into this client\'s own folder (6 file(s), by Faran).\n\n⚠ 2 file(s) could NOT be copied and are only in "ZZ-TEST …": a.pdf, b.pdf', 3 * D);
  assert.deepEqual(kinds(run([item({ updates: [partialRun] })], { checklist: { '2026-SV-050': true } })), ['other-warning']);
  const finish = note('📁 Files copied into this client\'s own folder (2 file(s), by Faran).', D);
  assert.deepEqual(run([item({ updates: [finish, partialRun] })], { checklist: { '2026-SV-050': true } }), []);
});

test('a re-seed failure is settled once checklist rows newer than it exist (the normal build posts no note)', () => {
  const rf = note('⚠ Re-seed failed: this case has no Case Reference Number yet. Set the Primary Case Type first…', 10 * D);
  const c = () => item({ ref: 'R9', updates: [rf] });
  assert.deepEqual(kinds(run([c()], { checklist: { R9: true } })), ['other-warning']);
  assert.deepEqual(NA.detect({ cases: [parse(c())], checklist: new Map([['R9', true]]), checklistNewest: new Map([['R9', NOW - 2 * D]]), now: NOW }), []);
  assert.deepEqual(kinds(NA.detect({ cases: [parse(c())], checklist: new Map([['R9', true]]), checklistNewest: new Map([['R9', NOW - 20 * D]]), now: NOW })), ['other-warning'], 'older rows do not settle it');
});

test('every working-folder warning is re-checked (no cap)', async () => {
  const wf = '⚠ Could not create the working folders 1-Coordinator-Working in this client\'s OneDrive folder — please add it by hand. Reason: 503';
  const items = Array.from({ length: 30 }, (_, i) => item({ id: `w${i}`, ref: `2026-SV-1${String(i).padStart(2, '0')}`, updates: [note(wf, 3 * D)] }));
  const folders = items.map((it, i) => ({ id: `f${i}`, name: `Client - 2026-SV-1${String(i).padStart(2, '0')}`, childCount: 4, createdAt: '2026-08-01T00:00:00Z' }));
  harness({ items: () => items, folders, checklist: Object.fromEntries(items.map((_, i) => [`2026-SV-1${String(i).padStart(2, '0')}`, true])) });
  let asked = 0;
  NA.io.workFoldersPresent = async () => { asked++; return true; };
  const snap = await NA.buildSnapshot();
  assert.equal(asked, 30);
  assert.deepEqual(snap.entries, []);
});

test('notes beyond the first 50 are read for a live case: an older warning still shows, and a failed batch costs only its cases', async () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => note(`Call ${i}`, i * 1000));
  const sub = note('⚠️ Document checklist NOT created yet — Case Sub Type required. …', 9 * D);
  const mk = (id, ref) => item({ id, ref, caseType: 'OINP', stage: 'Profile Created', updates: filler(50) });
  harness({
    items: () => [mk('a', 'D-A'), mk('b', 'D-B')],
    checklist: { 'D-A': false, 'D-B': false },
    deep: new Map([['a', [...filler(50), sub]], ['b', [...filler(50), sub]]]),
    deepFail: ['b'],
  });
  const snap = await NA.buildSnapshot();
  assert.deepEqual(snap.entries.map((e) => [e.kind, e.caseRef]), [['subtype', 'D-A']]);
  assert.match(snap.partial.join(' '), /Older notes on 1 case could not be read/);
});

test('an item spanning several cases names only the cases a limited viewer may see', async () => {
  harness({
    items: () => [
      item({ id: 'old', name: 'Bob Other-Client', ref: '2026-EE-086', manager: 'Manager Of Bob', people: [{ id: 99, kind: 'person' }], createdAgo: 20 * D }),
      item({ id: 'new', name: 'Alice Mine', ref: '2026-EE-086', people: [{ id: 77, kind: 'person' }], createdAgo: 2 * D }),
    ],
    checklist: { '2026-EE-086': true },
  });
  await NA.refresh();
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    const alice = { userId: '77', teamIds: [], isAdmin: false, scope: 'assigned' };
    const [e] = NA.view(alice).entries;
    assert.equal(e.kind, 'ref-duplicate');
    assert.deepEqual(e.itemIds, ['new']);
    assert.equal(e.client, 'Alice Mine');
    assert.equal(e.manager, '');
    assert.ok(!/Bob/.test(JSON.stringify(e)), 'nothing about the other client');
    assert.ok(!('rows' in e));
    // Her "Mark handled" lands on HER case only.
    const calls = { notes: [] };
    NA.io.postNote = async (itemId, body) => { calls.notes.push(itemId); };
    await NA.markHandled({ key: e.key, viewer: alice, actor: 'Alice' });
    assert.deepEqual(calls.notes, ['new']);
    const admin = NA.view({ isAdmin: true, scope: 'all' });
    assert.equal(admin.entries.length, 0, 'handled for everyone');
  } finally { if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
});

test('after a restart, Mark handled starts the check it asks the user to wait for', async () => {
  let reads = 0;
  harness({ items: () => [] });
  NA.io.readCases = async () => { reads++; return []; };
  await assert.rejects(NA.markHandled({ key: 'NA-0123456789', viewer: { isAdmin: true, scope: 'all' }, actor: 'x' }), (e) => e.status === 503 && /restart/.test(e.message));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reads, 1);
});

test('after a FAILED check, Check now is allowed again after 20 seconds and says the last one failed', async () => {
  harness({ items: () => [] });
  NA.io.readCases = async () => { throw new Error('Monday 503'); };
  await assert.rejects(NA.refresh(), /Monday 503/);
  NA.io.now = () => NOW + 5000;
  assert.deepEqual(NA.requestRefresh(), { started: false, running: false, retryInSec: 15, lastFailed: true });
  NA.io.now = () => NOW + 21000;
  assert.equal(NA.requestRefresh().started, true);
});

test('more rules pinned: undo alarm, Submission Team, seed failed, held-onboarding report', () => {
  const ck = { '2026-SV-050': true };
  assert.deepEqual(kinds(run([item({ updates: [note('⚠️ Undo incomplete — 3 Sep. Monday didn’t confirm every change…', D)] })], { checklist: ck })), ['payment-flag']);
  assert.deepEqual(kinds(run([item({ stage: 'Submission Preparation', manager: 'X', updates: [note('✅ *Case Ready for Submission Preparation* …', D)] })], { checklist: ck })), ['assign']);
  assert.deepEqual(run([item({ stage: 'Submission Preparation', manager: 'X', submission: 'Team', updates: [note('✅ *Case Ready for Submission Preparation* …', D)] })], { checklist: ck }), []);
  const seed = run([item({ ref: 'Q1', stage: 'Profile Created', updates: [note('⚠️ Document checklist auto-seed FAILED for Q1 after 2 attempts — …', D)] })], { checklist: { Q1: false } });
  assert.deepEqual(kinds(seed), ['no-checklist']);
  const fin = run([item({ ref: 'Q2', stage: 'Internal Review', payment: 'Paid', updates: [note('ℹ️ Held onboarding not restarted automatically — the case has already moved on to "Internal Review". Nothing was sent…', D)] })], { checklist: { Q2: false } });
  assert.deepEqual(kinds(fin), ['no-checklist']);
  assert.match(fin[0].why, /did not restart onboarding/);
});

// ── Review round 2 (2026-10-01) ─────────────────────────────────────────────

test('family warning: a case type with no Sub Types ("(none)"), and the same run\'s note after a Sub Type change, do not settle it', () => {
  const ck = { '2026-SV-050': true };
  const famNone = note('⚠️ Family members not covered by this checklist. 1 Spouse on the Family Members board, but the current Case Sub Type "(none)" has no matching document role — …', 3 * D);
  const sameRun = note('✅ Checklist re-seed complete for 2026-SV-050 …', 3 * D - 5000);
  assert.deepEqual(kinds(run([item({ subType: '', updates: [sameRun, famNone] })], { checklist: ck })), ['other-warning']);
  const fam = note('⚠️ Family members not covered by this checklist. … the current Case Sub Type "CEC Single" has no matching document role — …', 3 * D);
  const created = note('✅ Document checklist created (variant: CEC Single). The Case Sub Type was set after payment…', 3 * D - 4000);
  assert.deepEqual(kinds(run([item({ subType: 'CEC Accompanying', updates: [created, fam] })], { checklist: ck })), ['other-warning'],
    'Sub Type changed but no re-seed since: the spouse still has no documents');
});

test('a re-seed that failed for another reason is its own item (not hidden under a handled Sub Type item)', () => {
  const sub = note('⚠️ Document checklist NOT created yet — Case Sub Type required. …', 5 * D);
  const base = run([item({ id: 'S5', ref: 'S5', caseType: 'OINP', stage: 'Profile Created', updates: [sub] })], { checklist: { S5: false } });
  const failed = note('⚠ Re-seed failed: Monday API error 500.', D);
  const out = run([item({ id: 'S5', ref: 'S5', caseType: 'OINP', subType: 'Masters Graduate Stream', stage: 'Profile Created', updates: [failed, sub] })], { checklist: { S5: false } });
  assert.deepEqual(kinds(out), ['no-checklist']);
  assert.notEqual(out[0].key, base[0].key);
});

test('a limited viewer\'s copy of a shared item shows their own case\'s stage, payment and date', async () => {
  harness({
    items: () => [
      item({ id: 'old', name: 'Bob', ref: '2026-EE-087', stage: 'Application Submitted', payment: 'Already Sent', people: [{ id: 99, kind: 'person' }], createdAgo: 2 * D }),
      item({ id: 'new', name: 'Alice', ref: '2026-EE-087', stage: 'Pre-Onboarding', payment: 'Not Paid', people: [{ id: 77, kind: 'person' }], createdAgo: 20 * D }),
    ],
    checklist: { '2026-EE-087': true },
  });
  await NA.refresh();
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    const [e] = NA.view({ userId: '77', teamIds: [], isAdmin: false, scope: 'assigned' }).entries;
    assert.equal(e.stage, 'Pre-Onboarding');
    assert.equal(e.payment, 'Not Paid');
    assert.equal(e.since, new Date(NOW - 20 * D).toISOString());
  } finally { if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
});

test('a case whose older notes fail in both reads is counted once', async () => {
  const filler = Array.from({ length: 50 }, (_, i) => note(`Call ${i}`, i * 1000));
  harness({ items: () => [item({ id: 'x', ref: 'X1', payment: 'Paid', updates: filler })], checklist: { X1: false }, deepFail: ['x'] });
  const snap = await NA.buildSnapshot();
  assert.match(snap.partial.join(' '), /Older notes on 1 case could not be read/);
});
