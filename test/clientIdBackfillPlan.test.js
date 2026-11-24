'use strict';

// The Client ID backfill plan (step 6, 2026-11-25) — PURE: who is one person, the bucket,
// the year they first came, and the order of the numbers. Plan section 4 as corrected by
// review #3 #7 #8 #15 #16: spouses sharing an email are a question (AMBER), never joined on
// their own; a decorated Client Master name is only a proposal; TEST rows are out; the year
// comes from the case number / consultation record, not a bulk-import date; placeholder
// emails and phones count as blank; Merged records fold into their target; a number already
// given is never changed.

const test   = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/services/clientIdBackfillPlan');
const accounts = require('../src/services/clientAccountService');

const NOW = Date.parse('2026-11-25T15:00:00Z');
const LIVE = { id: 'group_live', title: 'November 2026' };
const OLD  = { id: 'group_old', title: 'Retainers before May 2026' };
const TEST_G = { id: 'group_mm3842s', title: 'TEST' };
const CANCEL = { id: 'group_mm3b9tap', title: 'Cancel /Did not retained' };
const LEADS_G = { id: 'group_mm2tz8e1', title: 'Leads' };
const BULK = '2026-04-02T10:00:00Z';   // the day the old rows were imported

const kase = (id, name, o = {}) => ({ id: String(id), name, createdAt: o.created || BULK, group: o.group || LIVE, caseRef: o.ref === undefined ? `2026-VV-${String(id).padStart(3, '0')}` : o.ref, caseStage: o.stage || '', email: o.email || '', phone: o.phone || '', accountId: o.account === undefined ? '' : o.account, copy: o.copy === undefined ? '' : o.copy });
const client = (id, name, o = {}) => ({ id: String(id), name, createdAt: o.created || '2026-08-10T12:00:00Z', email: o.email || '', phone: o.phone || '', dob: o.dob || '', status: o.status || 'Active', mergedInto: o.mergedInto || '', clientIdText: o.cid === undefined ? '' : o.cid });
const lead = (id, fullName, o = {}) => ({ id: String(id), name: fullName, fullName, createdAt: o.created || '2026-03-01T15:00:00Z', email: o.email || '', phone: o.phone || '', cmItemId: o.cm ? String(o.cm) : '', accountId: o.account === undefined ? '' : o.account, retainerSigned: o.signed || '', residentialAddress: '', copy: '' });

const plan = (rows, opts = {}) => P.buildPlan({ clients: [], cases: [], leads: [], ...rows }, { now: NOW, counterLast: 0, ...opts });
const personWith = (pl, caseId) => pl.people.find((p) => p.cases.some((c) => c.id === String(caseId)));
const rowOf = (pl, caseId) => pl.rows.find((r) => r.people.some((p) => p.cases.some((c) => c.id === String(caseId))));

test('spouses sharing one email are an AMBER question: blank = two people, two IDs; Y = one', () => {
  const rows = { cases: [kase(1, 'John Doe', { email: 'fam@x.com' }), kase(2, 'Jane Doe', { email: 'fam@x.com' })] };
  const a = plan(rows);
  assert.equal(a.rows.length, 1);
  assert.equal(a.rows[0].bucket, 'AMBER');
  assert.equal(a.rows[0].key, 'G:1+2');
  assert.match(a.rows[0].reasons.join(' '), /same email under different names/);
  assert.equal(a.counts.newIds, 2, 'unanswered = different people');
  assert.deepEqual(a.people.map((p) => p.name).sort(), ['Jane Doe', 'John Doe']);

  const y = plan(rows, { decisions: { 'G:1+2': { same: 'Y', give: '' } } });
  assert.equal(y.counts.newIds, 1);
  assert.equal(y.people.length, 1);
  assert.equal(y.people[0].cases.length, 2);
  const n = plan(rows, { decisions: { 'G:1+2': { same: 'N', give: '' } } });
  assert.equal(n.counts.newIds, 2);
});

test('one email and one name across 3 cases is ONE person (GREEN), with one ID', () => {
  const a = plan({ cases: [kase(1, 'Repeat Client', { email: 'R@X.com ' }), kase(2, 'repeat  client', { email: 'r@x.com' }), kase(3, 'Repeat Client', { email: 'r@x.com', group: CANCEL })] });
  assert.equal(a.people.length, 1);
  assert.equal(a.rows[0].bucket, 'GREEN');
  assert.equal(a.people[0].cases.length, 3);
  assert.equal(a.counts.newIds, 1);
  assert.equal(a.people[0].proposedId, 'CL-2026-00001');
  assert.ok(a.people[0].cases.some((c) => c.standing === 'Cancelled'), 'the Cancel group row is labelled, never "open"');
});

test('phone-only rows: same phone + same name join; the same phone with different emails is a question', () => {
  const a = plan({ cases: [kase(1, 'Walk In', { phone: '+1 (416) 555-0101' }), kase(2, 'Walk In', { phone: '4165550101' })] });
  assert.equal(a.people.length, 1, 'phone + name, no email on either = one person (the app rule)');
  assert.equal(a.rows[0].bucket, 'GREEN');

  const b = plan({ cases: [kase(1, 'Sam Lee', { phone: '4165550102', email: 'sam1@x.com' }), kase(2, 'Sam Lee', { phone: '4165550102', email: 'sam2@x.com' })] });
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].bucket, 'AMBER', 'both have an email and they differ: the email decides — not the same on its own');
  assert.match(b.rows[0].reasons.join(' '), /same phone with different emails/);

  const c = plan({ cases: [kase(1, 'Mia Roy', { phone: '4165550103' }), kase(2, 'Mia Roy', { phone: '4165550103', email: 'mia@x.com' })] });
  assert.equal(c.people.length, 1, 'one side without an email: phone + name is the same person');
});

test('a decorated Client Master name is only a PROPOSAL; the consultation record\'s clean name joins', () => {
  const noLead = plan({ cases: [kase(1, 'Amritpal Kaur (2726)', { email: 'a@x.com' }), kase(2, 'Amritpal Kaur', { email: 'a@x.com' })] });
  assert.equal(noLead.rows[0].bucket, 'AMBER', 'never joined on the loosened name alone');
  assert.match(noLead.rows[0].reasons.join(' '), /match once extra bits/);
  const lone = plan({ cases: [kase(1, 'Sahebjot Kaur e004397122 (1594)', { email: 'b@x.com' })] });
  assert.equal(lone.people[0].name, 'Sahebjot Kaur', 'the proposed record name is cleaned');
  assert.match(lone.people[0].nameFrom, /proposal/);

  const withLead = plan({
    cases: [kase(1, 'Amritpal Kaur (2726)', { email: 'a@x.com' }), kase(2, 'Amritpal Kaur', { email: 'a@x.com' })],
    leads: [lead(50, 'Amritpal Kaur', { cm: 1, email: 'a@x.com' })],
  });
  assert.equal(withLead.people.length, 1, 'the lead gives the clean name: the strict rule joins');
  assert.equal(withLead.people[0].name, 'Amritpal Kaur');
  assert.equal(withLead.people[0].nameFrom, 'consultation record');
  assert.deepEqual(withLead.people[0].leads.map((l) => l.id), ['50']);
});

test('TEST group, test-looking rows and Archived records are EXCLUDED; the Leads group is in, labelled', () => {
  const a = plan({
    clients: [client(9, 'Old Archive', { status: 'Archived', email: 'arch@x.com' })],
    cases: [kase(1, 'Real Person', { group: TEST_G, email: 'p@x.com' }), kase(2, 'ZZ-TEST Person', { email: 'z@x.com' }), kase(3, 'Staff Try', { email: 'faran@tdotimm.com' }),
      kase(4, 'Template Row'), kase(5, 'Enquiry Person', { group: LEADS_G, email: 'e@x.com', ref: '' })],
  });
  assert.deepEqual(a.excluded.map((x) => x.id).sort(), ['1', '2', '3', '4', '9']);
  assert.equal(a.people.length, 1);
  assert.equal(a.people[0].cases[0].standing, 'Lead only');
  assert.match(a.people[0].notes.join(' '), /no case number/);
  assert.equal(a.counts.buckets.EXCLUDED, 5);
});

test('the year: the case number / consultation record, never a bulk-import date; numbers in first-seen order', () => {
  const a = plan({
    cases: [
      kase(1, 'Imported Only', { email: 'i@x.com', ref: '2394', group: OLD }),                 // no year anywhere but the import date
      kase(2, 'Ref Year', { email: 'r@x.com', ref: '2024-SP-007', group: OLD }),               // the case number says 2024
      kase(3, 'Lead Year', { email: 'l@x.com', ref: 'Supervisa', group: OLD }),                // the consultation record says 2025
      kase(4, 'New Person', { email: 'n@x.com', ref: '2026-VV-010', created: '2026-10-01T12:00:00Z' }),
    ],
    leads: [lead(40, 'Lead Year', { cm: 3, email: 'l@x.com', created: '2025-06-01T12:00:00Z' })],
  });
  const by = (id) => personWith(a, id);
  assert.equal(by(1).year, 2026); assert.equal(by(1).yearFrom, 'Client Master row made');
  assert.equal(by(2).year, 2024); assert.equal(by(2).yearFrom, 'case number');
  assert.equal(by(3).year, 2025); assert.equal(by(3).yearFrom, 'consultation record');
  assert.equal(by(4).year, 2026);
  assert.deepEqual([2, 3, 1, 4].map((id) => by(id).proposedId), ['CL-2024-00001', 'CL-2025-00002', 'CL-2026-00003', 'CL-2026-00004'],
    'earliest first; within 2026 the April import before the October case');
  assert.deepEqual(a.yearCounts, { 2024: 1, 2025: 1, 2026: 2 });
  assert.match(by(1).notes.join(' '), /unusual case number "2394"/);
});

test('the Toronto year boundary: 31 Dec 23:30 Toronto is still that year; a date-only Retainer Signed keeps its own year', () => {
  const a = plan({
    cases: [kase(1, 'Late Night', { email: 'ln@x.com', ref: '' }), kase(2, 'New Year', { email: 'ny@x.com', ref: '' })],
    leads: [
      lead(10, 'Late Night', { cm: 1, email: 'ln@x.com', created: '2026-01-01T04:30:00Z' }),   // 31 Dec 2025, 23:30 Toronto
      lead(11, 'New Year', { cm: 2, email: 'ny@x.com', created: '2026-03-01T12:00:00Z', signed: '2026-01-01' }),
    ],
  });
  assert.equal(personWith(a, 1).year, 2025);
  assert.equal(personWith(a, 2).year, 2026, 'never moved back to 31 Dec by a UTC reading');
  assert.deepEqual(P.timeInfo('2026-01-01'), { ms: Date.parse('2026-01-01T12:00:00Z'), year: 2026 });
  assert.equal(P.timeInfo('2027-01-01T05:00:00Z').year, 2027);
  assert.equal(P.timeInfo('2027-01-01T04:59:59Z').year, 2026);
  // never a future year
  const f = plan({ cases: [kase(3, 'Typo Year', { email: 'f@x.com', ref: '2031-VV-001' })] }, { now: NOW });
  assert.equal(personWith(f, 3).year, 2026);
});

test('placeholder guard: an email or phone with more than 3 names is blank for matching, listed, never anyone\'s email', () => {
  const agent = 'agent@x.com';
  const a = plan({ cases: ['Ann A', 'Bob B', 'Cat C', 'Dan D'].map((n, i) => kase(i + 1, n, { email: agent })) });
  assert.equal(a.placeholders.emails.length, 1);
  assert.equal(a.placeholders.emails[0].value, agent);
  assert.equal(a.rows.filter((r) => r.bucket === 'AMBER').length, 0, 'no giant AMBER group');
  assert.equal(a.people.length, 4);
  assert.ok(a.people.every((p) => p.email === ''), 'never written as primaryEmail');
  assert.ok(a.rows.every((r) => r.bucket === 'RED'), 'no other contact: each its own person, flagged');
  assert.ok(P.leftOutRows(a).some((r) => r[1] === agent));

  const family = plan({ cases: ['Ann A', 'Bob B', 'Cat C'].map((n, i) => kase(i + 1, n, { email: 'fam3@x.com' })) });
  assert.equal(family.placeholders.emails.length, 0, '3 names is a family, not a placeholder');
  assert.equal(family.rows[0].bucket, 'AMBER');

  const looks = plan({ cases: [kase(1, 'Solo One', { email: 'noemail@gmail.com', phone: '0000000000' })] });
  assert.equal(looks.placeholders.emails.length, 1);
  assert.equal(looks.placeholders.phones.length, 1);
  assert.equal(looks.rows[0].bucket, 'RED');
  assert.equal(P.PLACEHOLDER_NAMES, 3);
});

test('Merged records fold into their target (a chain is followed); a loop or a missing target is EXCLUDED', () => {
  const clients = [
    client(10, 'Keep Me', { email: 'k@x.com', cid: 'CL-2026-00007' }),
    client(11, 'Keep Me', { email: 'k@x.com', status: 'Merged', mergedInto: '12' }),
    client(12, 'Keep Me', { email: 'k@x.com', status: 'Merged', mergedInto: 'CL-2026-00007' }),
    client(20, 'Loop A', { status: 'Merged', mergedInto: '21' }),
    client(21, 'Loop B', { status: 'Merged', mergedInto: '20' }),
  ];
  const a = plan({ clients, cases: [kase(1, 'Keep Me', { email: 'k@x.com', account: '11' }), kase(2, 'Loop A', { account: '20' }), kase(3, 'Gone', { account: '999', email: 'g@x.com' })] }, { counterLast: 7 });
  const p = personWith(a, 1);
  assert.equal(p.accountId, '10');
  assert.equal(p.existingId, 'CL-2026-00007', 'kept — never renumbered');
  assert.deepEqual(p.moves, ['1'], 'the case is moved to the record it was merged into');
  assert.equal(a.merged.length, 2);
  assert.ok(a.excluded.some((x) => x.id === '2' && /loop/.test(x.reason)));
  assert.ok(a.excluded.some((x) => x.id === '3' && /not on the Clients board/.test(x.reason)));
  assert.ok(a.excluded.some((x) => x.id === '20') && a.excluded.some((x) => x.id === '21'));
  assert.equal(a.counts.newIds, 0);
  assert.equal(P.resolveRow('20', new Map(clients.map((r) => [r.id, r])), new Map()).reason, 'cycle');
});

test('an existing ID is kept; new numbers start after the counter and skip numbers already typed', () => {
  const a = plan({
    clients: [client(10, 'Has One', { email: 'h@x.com', cid: 'CL-2026-00004' })],
    cases: [kase(1, 'Has One', { email: 'h@x.com', account: '10' }), kase(2, 'Typed Copy', { email: 't@x.com', copy: 'CL-2026-00006' }), kase(3, 'Third', { email: 'th@x.com' }), kase(4, 'Fourth', { email: 'f@x.com' })],
  }, { counterLast: 4 });
  assert.equal(personWith(a, 1).existingId, 'CL-2026-00004');
  assert.equal(personWith(a, 1).gets, false);
  assert.equal(a.counts.newIds, 3);
  assert.equal(a.counts.firstNumber, 7, 'block 5–7 holds the typed 6: it starts after it (allocateBlock does the same)');
  assert.deepEqual(a.takers.map((p) => p.proposedN), [7, 8, 9]);
  assert.equal(P.blockStart(4, 3, new Set([6])), 7);
  assert.equal(P.blockStart(4, 3, new Set([9])), 5);
  assert.equal(P.blockStart(0, 2, new Set()), 1);
});

test('NO-CASE: a client record with no Client Master row, or a test-looking one, gets an ID only with a Y', () => {
  const rows = {
    clients: [client(10, 'Consult Only', { email: 'c@x.com' }), client(11, 'Real Name', { email: 'e2e@x.com' })],
    cases: [kase(1, 'Real Name', { account: '11' })],
    leads: [lead(30, 'Consult Only', { email: 'c@x.com', account: '10' })],
  };
  const a = plan(rows);
  assert.deepEqual(a.rows.map((r) => r.bucket), ['NO-CASE', 'NO-CASE']);
  assert.match(a.rows.find((r) => r.key === 'A10').reasons[0], /consultation only/);
  assert.match(a.rows.find((r) => r.key === 'C1').reasons[0], /looks like a test/);
  assert.equal(a.counts.newIds, 0);
  const y = plan(rows, { decisions: { A10: { same: '', give: 'Y' } } });
  assert.equal(y.counts.newIds, 1);
  assert.equal(y.people.find((p) => p.accountId === '10').proposedId, 'CL-2026-00001');
  assert.equal(y.counts.noCaseAnsweredGive, 1);
});

test('a loose case joins the record its consultation record names, or the one it matches exactly', () => {
  const a = plan({
    clients: [client(10, 'Lead Named', { email: 'ln@x.com' }), client(11, 'Exact Match', { email: 'em@x.com' })],
    cases: [kase(1, 'Lead Named (99)', { email: 'other@x.com' }), kase(2, 'Exact Match', { email: 'EM@x.com' })],
    leads: [lead(40, 'Lead Named', { cm: 1, account: '10', email: 'ln@x.com' })],
  });
  assert.equal(personWith(a, 1).accountId, '10');
  assert.equal(personWith(a, 2).accountId, '11');
  assert.equal(a.counts.newAccounts, 0);
  assert.equal(a.counts.newIds, 2);
});

test('a group never holds two existing client records — joining those is the merge tool\'s job', () => {
  const a = plan({
    clients: [client(10, 'Ravi Kumar', { email: 'shared@x.com' }), client(11, 'Priya Kumar', { phone: '4165550199' })],
    cases: [kase(1, 'Ravi Kumar', { email: 'shared@x.com', account: '10' }), kase(2, 'Priya Kumar', { phone: '4165550199', account: '11' }),
      kase(3, 'Kid Kumar', { email: 'shared@x.com', phone: '4165550199' })],
  });
  const amber = a.rows.filter((r) => r.bucket === 'AMBER');
  assert.equal(amber.length, 1);
  assert.equal(amber[0].units.filter((u) => u.account).length, 1);
  assert.ok(a.people.some((p) => p.notes.some((n) => /two client records would be joined/.test(n))));
});

test('reads that did not come back: never treated as blank', () => {
  const a = plan({
    clients: [client(10, 'Unread Box', { email: 'u@x.com', cid: null }), client(11, 'Typed Junk', { email: 'j@x.com', cid: 'cl 12' })],
    cases: [kase(1, 'Unread Box', { email: 'u@x.com', account: '10' }), kase(2, 'Typed Junk', { email: 'j@x.com', account: '11' }), kase(3, 'Unread Link', { email: 'ul@x.com', account: null })],
  });
  assert.equal(personWith(a, 1).idBlocked, true);
  assert.equal(personWith(a, 2).idBlocked, true);
  assert.equal(a.counts.newIds, 0, 'no number over an unread or hand-typed box');
  assert.equal(a.unreadable.length, 1);
  assert.equal(a.unreadable[0].id, '3');
});

test('a consultation record pointing at ANOTHER record is left alone and noted', () => {
  const a = plan({
    clients: [client(10, 'Case Owner', { email: 'co@x.com' }), client(11, 'Someone Else', { email: 'se@x.com' })],
    cases: [kase(1, 'Case Owner', { email: 'co@x.com', account: '10' }), kase(2, 'Someone Else', { email: 'se@x.com', account: '11' })],
    leads: [lead(40, 'Case Owner', { cm: 1, account: '11' }), lead(41, 'Case Owner', { cm: 1, account: '' }), lead(42, 'Case Owner', { cm: 1, account: '777' })],
  });
  const p = personWith(a, 1);
  assert.deepEqual(p.leads.map((l) => l.id), ['41']);
  assert.ok(p.notes.some((n) => /points at another client record/.test(n)));
  assert.ok(p.notes.some((n) => /not on the Clients board/.test(n)));
});

test('the answers: Y/N/blank, the wrong column, a changed group', () => {
  const read = P.readDecisions([
    { Key: 'G:1+2', Bucket: 'AMBER', 'Same person? (Y/N)': ' yes ', 'Give a Client ID? (Y/N)': '' },
    { Key: 'A10', Bucket: 'NO-CASE', 'Same person? (Y/N)': 'Y', 'Give a Client ID? (Y/N)': 'n' },
    { Key: 'C5', Bucket: 'GREEN', 'Same person? (Y/N)': 'maybe' },
    { Key: 'nonsense', Bucket: 'GREEN' },
    { Key: 'C5', Bucket: 'GREEN' },
  ]);
  assert.deepEqual(read.decisions.get('G:1+2'), { same: 'Y', give: '' });
  assert.deepEqual(read.decisions.get('A10'), { same: '', give: 'N' }, 'a "same person" answer on a NO-CASE row is ignored');
  assert.deepEqual(read.order, ['G:1+2', 'A10', 'C5']);
  assert.equal(read.problems.length, 4);
  assert.equal(P.readAnswer('No'), 'N');
  assert.equal(P.readAnswer('?'), '?');

  // a third case joined the group since the sheet was made → changed (the apply refuses)
  const now3 = plan({ cases: [kase(1, 'John Doe', { email: 'fam@x.com' }), kase(2, 'Jane Doe', { email: 'fam@x.com' }), kase(3, 'June Doe', { email: 'fam@x.com' })] },
    { decisions: read.decisions });
  assert.ok(now3.changed.some((c) => c.key === 'G:1+2'));
  // already one person (a resumed apply): fine
  const joined = plan({ clients: [client(10, 'John Doe', { email: 'fam@x.com' })], cases: [kase(1, 'John Doe', { email: 'fam@x.com', account: '10' }), kase(2, 'Jane Doe', { email: 'fam@x.com', account: '10' })] },
    { decisions: new Map([['G:1+2', { same: 'Y', give: '' }]]) });
  assert.equal(joined.changed.length, 0);
  // a record answered Y that is gone
  const gone = plan({}, { decisions: new Map([['A10', { same: '', give: 'Y' }]]) });
  assert.equal(gone.changed.length, 1);
});

test('the sheet order is kept at the apply; people new since the dry run go last', () => {
  const rows = { cases: [kase(5, 'Early', { email: 'e@x.com', ref: '2026-VV-005' }), kase(6, 'Later', { email: 'l@x.com', ref: '2026-VV-006', created: '2026-09-01T12:00:00Z' })] };
  const dry = plan(rows);
  const order = P.sheetRows(dry).map((r) => r[0]);
  const live = plan({ cases: [kase(2, 'Brand New But Old Ref', { email: 'b@x.com', ref: '2024-VV-001' }), ...rows.cases] }, { order });
  assert.deepEqual(live.takers.map((p) => p.name), ['Early', 'Later', 'Brand New But Old Ref']);
});

test('the sheet: headers, one row per question, empty answer columns, a summary with the year counts', () => {
  const a = plan({
    clients: [client(10, 'Consult Only', { email: 'c@x.com' })],
    cases: [kase(1, 'John Doe', { email: 'fam@x.com' }), kase(2, 'Jane Doe', { email: 'fam@x.com' }), kase(3, 'Solo', { email: 's@x.com', ref: '2025-VV-003' })],
  });
  assert.deepEqual(P.SHEET_HEADERS.slice(12, 14), ['Same person? (Y/N)', 'Give a Client ID? (Y/N)']);
  const rows = P.sheetRows(a);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.length === P.SHEET_HEADERS.length));
  const amber = rows.find((r) => r[1] === 'AMBER');
  assert.equal(amber[12], '');
  assert.match(amber[2], /CL-2026-\d{5} \/ CL-2026-\d{5}/);
  assert.equal(rows.find((r) => r[1] === 'NO-CASE')[2], 'only with a Y');
  assert.equal(rows[0][2], 'CL-2025-00001', 'the sheet is in number order');
  const sum = P.summaryRows(a, { madeAt: 'x', counter: '0' });
  assert.ok(sum.some((r) => r[0] === '2025' && r[1] === 1));
  assert.ok(sum.some((r) => r[0] === 'New Client IDs' && r[1] === 3));
});

test('the plan uses the app\'s own matching rules (one definition, no drift)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/clientIdBackfillPlan'), 'utf8');
  assert.match(src, /require\('\.\/clientAccountService'\)/);
  assert.ok(!/function classifyMatch|function normalizeEmail|function normalizePhone/.test(src), 'never a copy of the matcher');
  assert.ok(!/mondayApi|oneDriveService|\.query\(/.test(src), 'pure: no I/O');
  // a DOB conflict on the client record keeps a case off it (classifyMatch is consulted)
  assert.equal(accounts.classifyMatch({ email: 'a@x.com', fullName: 'A B', dob: '1990-01-01' }, { email: 'a@x.com', name: 'A B', dob: '1980-01-01' }).confidence, 'review');
  assert.equal(P.emailOf('Jane - Jane@X.com'), 'jane@x.com');
  assert.equal(P.cleanDisplayName('Amritpal Kaur(2726)'), 'Amritpal Kaur');
});
