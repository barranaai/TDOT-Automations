'use strict';
// Otter recordings → the consultation they belong to (Faran 2026-11-14): the recording code, the
// title reader and every matching rule. PURE — no network. All names, emails and ids are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordingCode } = require('../src/utils/recordingCode');
const M = require('../src/services/otterMatch');

const LONG = 'x'.repeat(400);
/** Unix seconds (as the file carries them) of a Toronto wall clock. */
const at = (wall) => String(Math.round(M.wallToMs(wall) / 1000));
const rec = (title, wall, extra = {}) => ({ otterId: 'ot_AAA111', title, startTime: at(wall), summary: LONG, transcript: LONG, ...extra });
const NOW = M.wallToMs('2026-11-12 18:00');
const run = (r, list, opts = {}) => M.match(r, list, { now: NOW, ...opts });
const C = (id, name, email, bookedSlot, consultant = 'Consultant One') => ({ id: String(id), name, email, bookedSlot, createdAt: '2026-11-01T12:00:00Z', consultant });

test('the recording code: "TD-" + the last five digits of the Lead Board item id — one pure function', () => {
  assert.equal(recordingCode('9100012345'), 'TD-12345');
  assert.equal(recordingCode(18435600042), 'TD-00042');
  assert.equal(recordingCode('1'), 'TD-00001');
  assert.equal(recordingCode(''), '');
  assert.equal(recordingCode(null), '');
  assert.equal(recordingCode('9100012345'), recordingCode('9200012345'), 'two leads can share a code — the matcher never files on the code alone');
});

test('the title reader: a code in every typed form, an email, the rest as a name', () => {
  for (const t of ['TD-12345', 'td 12345', 'TD12345', 'TD - 12345', 'Td–12345', 'td_12345', 'TD#12345', 'Consultation TD-12345 today', 'TD-12345.txt']) {
    assert.equal(M.readTitle(t).code, 'TD-12345', t);
  }
  for (const t of ['TD-1234', 'TD-123456', 'STD-12345', 'ltd 12345', '12345', 'T D 12345']) assert.equal(M.readTitle(t).code, '', t);
  assert.deepEqual(M.readTitle('Priya.Example@Example.com'), { code: '', email: 'priya.example@example.com', name: '', kinds: ['email'] });
  assert.deepEqual(M.readTitle('TD-12345 Priya Example'), { code: 'TD-12345', email: '', name: 'priya example', kinds: ['code', 'name'] });
  assert.deepEqual(M.readTitle('Consultation with Priya Example — priya@example.com'), { code: '', email: 'priya@example.com', name: 'priya example', kinds: ['email', 'name'] });
  for (const t of ['', '   ', 'Note', 'Meeting', 'Consultation', '2026-11-12', '---', null]) assert.deepEqual(M.readTitle(t).kinds, [], String(t));
});

test('names are compared without case, accents, extra spaces, punctuation, "consultation with" and honorifics', () => {
  const same = ['Renée  O’Brien-Núñez', 'renee obrien nunez', 'Consultation with Mrs. Renee O\'Brien Nunez', 'DR RENÉE O`BRIEN – NÚÑEZ', 'Meeting with Ms Renee OBrien, Nunez (call)'];
  for (const n of same) assert.equal(M.normName(n), 'renee obrien nunez', n);
  assert.notEqual(M.normName('Renee Nunez'), M.normName('Renee OBrien Nunez'));
  assert.equal(M.normName(''), '');
});

test('the Toronto wall clock: both ways, across midnight and both clock changes', () => {
  assert.equal(M.torontoWall(Date.UTC(2026, 10, 12, 17, 5)), '2026-11-12 12:05');           // EST
  assert.equal(M.torontoWall(Date.UTC(2026, 10, 13, 1, 0)), '2026-11-12 20:00', 'an evening recording is the same Toronto day');
  assert.equal(M.torontoWall(Date.UTC(2026, 6, 1, 3, 59)), '2026-06-30 23:59');             // EDT
  assert.equal(M.wallToMs('2026-11-12 14:00'), Date.UTC(2026, 10, 12, 19, 0));
  assert.equal(M.wallToMs('2026-03-08 09:00'), Date.UTC(2026, 2, 8, 13, 0), 'the morning after the clocks went forward is already EDT');
  assert.equal(M.wallToMs('2026-03-07 09:00'), Date.UTC(2026, 2, 7, 14, 0));
  assert.equal(M.wallToMs('2026-11-01 09:00'), Date.UTC(2026, 10, 1, 14, 0), 'the morning after the clocks went back is already EST');
  assert.equal(M.wallToMs('2026-10-31 09:00'), Date.UTC(2026, 9, 31, 13, 0));
  assert.ok(Number.isNaN(M.wallToMs('2026-11-12')) && Number.isNaN(M.wallToMs('')), 'a day with no time is not a booked time');
  assert.equal(M.torontoWall(null), '');
});

test('edit distance: counts single-character slips and stops past the limit', () => {
  assert.equal(M.editDistance('priya@example.com', 'priya@example.com'), 0);
  assert.equal(M.editDistance('priya@example.com', 'prya@example.com'), 1);
  assert.equal(M.editDistance('priya@example.com', 'pirya@example.com'), 2);
  assert.ok(M.editDistance('priya@example.com', 'someone.else@example.org', 2) > 2);
});

// ── rule a: a code ────────────────────────────────────────────────────────────
test('a code files only when exactly ONE consultation with that code is booked on the recording\'s Toronto day', () => {
  const list = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-12 14:00'), C(9100099999, 'Omar Sample', 'omar@example.com', '2026-11-12 14:00')];
  const r = run(rec('TD-12345', '2026-11-12 14:03'), list);
  assert.deepEqual([r.decision, r.leadId, r.by, r.reasonKey], ['file', '9100012345', 'code', 'matched']);
  // a code is not tied to the hour: the consultation ran late in the day
  assert.equal(run(rec('td 12345', '2026-11-12 21:30'), list).decision, 'file');
});

test('a code on the wrong day is never filed — the day before or after is not enough', () => {
  const list = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-11 14:00')];
  for (const wall of ['2026-11-12 14:00', '2026-11-10 14:00', '2026-11-12 00:05']) {
    const r = run(rec('TD-12345', wall), list);
    assert.deepEqual([r.decision, r.by, r.reasonKey, r.candidates], ['needs', '', 'codeNone', ['9100012345']], wall);
    assert.equal(r.leadId, undefined);
  }
});

test('the same last five digits on two leads: one booked that day files; both booked that day needs a person', () => {
  const a = C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-12 10:00');
  const b = C(9200012345, 'Omar Sample', 'omar@example.com', '2026-11-05 10:00');
  const one = run(rec('TD-12345', '2026-11-12 10:02'), [a, b]);
  assert.deepEqual([one.decision, one.leadId], ['file', '9100012345']);
  const both = run(rec('TD-12345', '2026-11-12 10:02'), [a, { ...b, bookedSlot: '2026-11-12 15:00' }]);
  assert.deepEqual([both.decision, both.reasonKey], ['needs', 'codeMany']);
  assert.deepEqual(both.candidates, ['9100012345', '9200012345'], 'both are offered, the nearest first');
});

test('a code that fits nothing is never overruled by a name that does (the first token decides)', () => {
  const list = [C(9100055555, 'Priya Example', 'priya@example.com', '2026-11-12 14:00')];
  const r = run(rec('TD-12345 Priya Example', '2026-11-12 14:00'), list);
  assert.deepEqual([r.decision, r.reasonKey], ['needs', 'codeNone']);
  assert.deepEqual(r.candidates, ['9100055555'], 'the name still makes a suggestion');
});

test('a direct consultation with no booked time: the code alone never files', () => {
  const r = run(rec('TD-12345', '2026-11-12 14:00'), [C(9100012345, 'Priya Example', 'priya@example.com', '')]);
  assert.deepEqual([r.decision, r.reasonKey, r.candidates], ['needs', 'codeNone', ['9100012345']]);
  const n = run(rec('Priya Example', '2026-11-12 14:00'), [C(9100012345, 'Priya Example', 'priya@example.com', '')]);
  assert.deepEqual([n.decision, n.reasonKey], ['needs', 'nameNone']);
});

// ── the Toronto day ───────────────────────────────────────────────────────────
test('the same-day rule is the TORONTO day: midnight and the clock-change days', () => {
  const lead = (slot) => [C(9100012345, 'Priya Example', 'priya@example.com', slot)];
  // 23:50 on the 12th is 04:50 UTC on the 13th — still the 12th in Toronto
  assert.equal(run(rec('TD-12345', '2026-11-12 23:50'), lead('2026-11-12 23:30')).decision, 'file');
  assert.equal(run(rec('TD-12345', '2026-11-12 23:50'), lead('2026-11-13 00:10')).decision, 'needs', 'ten minutes later, but the next day');
  assert.equal(run(rec('TD-12345', '2026-11-13 00:05'), lead('2026-11-12 23:30')).decision, 'needs', 'ran past midnight: a person decides');
  // the day the clocks go back (1 Nov 2026) and forward (8 Mar 2026)
  assert.equal(run(rec('TD-12345', '2026-11-01 00:30'), lead('2026-11-01 09:00')).decision, 'file');
  assert.equal(run(rec('TD-12345', '2026-10-31 23:30'), lead('2026-11-01 09:00')).decision, 'needs');
  assert.equal(M.match(rec('TD-12345', '2026-03-08 23:45'), lead('2026-03-08 09:00'), { now: M.wallToMs('2026-03-09 09:00') }).decision, 'file');
  assert.equal(M.match(rec('TD-12345', '2026-03-09 00:15'), lead('2026-03-08 09:00'), { now: M.wallToMs('2026-03-09 09:00') }).decision, 'needs');
});

// ── rule b: an email ──────────────────────────────────────────────────────────
test('an email files on the one consultation with that email booked that day (any case)', () => {
  const list = [C(9100012345, 'Priya Example', 'Priya.Example@example.com', '2026-11-12 14:00'), C(9100022222, 'Omar Sample', 'omar@example.com', '2026-11-12 14:00')];
  const r = run(rec('PRIYA.EXAMPLE@EXAMPLE.COM', '2026-11-12 19:00'), list);
  assert.deepEqual([r.decision, r.leadId, r.by], ['file', '9100012345', 'email']);
  assert.deepEqual([run(rec('priya.example@example.com', '2026-11-13 09:00'), list).reasonKey], ['emailNone'], 'the wrong day');
  // the same person booked twice that day
  const twice = [...list, C(9100033333, 'Priya Example', 'priya.example@example.com', '2026-11-12 16:00')];
  const t = run(rec('priya.example@example.com', '2026-11-12 14:00'), twice);
  assert.deepEqual([t.decision, t.reasonKey, t.candidates.slice(0, 2)], ['needs', 'emailMany', ['9100012345', '9100033333']]);
});

test('an email that is nobody\'s is NEVER filed — not one slip away, not two; the client with the near email is suggested first (second review 2026-11-14)', () => {
  const list = [C(9100012345, 'Priya Example', 'priya.example@example.com', '2026-11-12 14:00'), C(9100022222, 'Omar Sample', 'omar@example.com', '2026-11-12 14:00')];
  const d1 = run(rec('prya.example@example.com', '2026-11-12 14:05'), list);
  assert.deepEqual([d1.decision, d1.leadId, d1.by, d1.reasonKey, d1.candidates[0]], ['needs', undefined, '', 'emailUnknown', '9100012345'], 'distance 1: a person decides');
  const d2 = run(rec('pirya.example@example.com', '2026-11-12 14:05'), list);
  assert.deepEqual([d2.decision, d2.leadId, d2.by, d2.reasonKey, d2.candidates[0]], ['needs', undefined, '', 'emailUnknown', '9100012345'], 'distance 2');
  const d3 = run(rec('pirya.exmple@example.com', '2026-11-12 14:05'), list);
  assert.deepEqual([d3.decision, d3.reasonKey], ['needs', 'emailUnknown'], 'distance 3');
  const late = run(rec('prya.example@example.com', '2026-11-12 18:00'), list);
  assert.deepEqual([late.decision, late.reasonKey, late.candidates], ['needs', 'emailUnknown', ['9100012345']]);
  // two different clients are both within two slips: never a guess
  const twins = [C(9100012345, 'Priya Example', 'priya.example@example.com', '2026-11-12 14:00'), C(9100044444, 'Priyo Example', 'priyo.example@example.com', '2026-11-20 14:00')];
  assert.equal(run(rec('priye.example@example.com', '2026-11-12 14:05'), twins).decision, 'needs');
  // the scenarios of the review: a short address two characters from a neighbour's is another person
  const lu = run(rec('li@qq.com', '2026-11-12 10:05'), [C(9100055555, 'Lu Invented', 'lu@qq.com', '2026-11-12 10:00')]);
  assert.deepEqual([lu.decision, lu.leadId, lu.candidates], ['needs', undefined, ['9100055555']]);
  const cd = run(rec('ab@x.ca', '2026-11-12 10:05'), [C(9100055556, 'Cd Invented', 'cd@x.ca', '2026-11-12 10:00')]);
  assert.deepEqual([cd.decision, cd.leadId], ['needs', undefined]);
  // the recorded client's lead carries another address; a neighbour booked an hour earlier has a numbered look-alike
  const pair = [C(9100066661, 'Jas Invented', 'jas.home@example.org', '2026-11-12 10:00'), C(9100066662, 'Jot Invented', 'jsingh12@example.com', '2026-11-12 09:00')];
  const js = run(rec('jsingh1@example.com', '2026-11-12 10:05'), pair);
  assert.deepEqual([js.decision, js.leadId, js.reasonKey, js.candidates], ['needs', undefined, 'emailUnknown', ['9100066662', '9100066661']], 'never filed on the look-alike by itself; both are offered');
  // the exact email still files, under its own rule
  const exact = run(rec('jsingh12@example.com', '2026-11-12 10:05'), pair);
  assert.deepEqual([exact.decision, exact.leadId, exact.by], ['file', '9100066662', 'email']);
});

// ── rule c: a name ────────────────────────────────────────────────────────────
test('a name files only inside the window: the recording began from 45 minutes before the booked time to 120 minutes after', () => {
  const list = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-12 14:00')];
  const d = (wall) => run(rec('Consultation with Priya Example', wall), list);
  assert.deepEqual([d('2026-11-12 13:16').decision, d('2026-11-12 13:16').by], ['file', 'name'], '44 minutes early');
  assert.equal(d('2026-11-12 13:15').decision, 'file', 'exactly 45 minutes early');
  assert.equal(d('2026-11-12 13:14').decision, 'needs', '46 minutes early');
  assert.equal(d('2026-11-12 15:59').decision, 'file', '119 minutes late');
  assert.equal(d('2026-11-12 16:00').decision, 'file', 'exactly 120 minutes late');
  assert.equal(d('2026-11-12 16:01').decision, 'needs', '121 minutes late');
  assert.deepEqual([d('2026-11-12 16:01').reasonKey, d('2026-11-12 16:01').candidates], ['nameNone', ['9100012345']], 'the same name is still suggested');
  // the window is measured in real minutes on the clock-change day (9:00 EDT, not 9:00 EST)
  const march = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-03-08 09:00')];
  const mNow = { now: M.wallToMs('2026-03-08 18:00') };
  assert.equal(M.match({ ...rec('Priya Example', '2026-03-08 08:16') }, march, mNow).decision, 'file');
  assert.equal(M.match({ otterId: 'ot_AAA111', title: 'Priya Example', startTime: String(Date.UTC(2026, 2, 8, 12, 16) / 1000), summary: LONG, transcript: LONG }, march, mNow).decision, 'file', '12:16 UTC is 44 minutes before 9:00 EDT');
  assert.equal(M.match({ otterId: 'ot_AAA111', title: 'Priya Example', startTime: String(Date.UTC(2026, 2, 8, 12, 14) / 1000), summary: LONG, transcript: LONG }, march, mNow).decision, 'needs');
});

test('two consultations with the same name in the same hour: never a guess', () => {
  const list = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-12 14:00', 'Consultant One'), C(9100022222, 'priya  EXAMPLE', 'p2@example.com', '2026-11-12 14:30', 'Consultant Two')];
  const r = run(rec('Priya Example', '2026-11-12 14:10'), list);
  assert.deepEqual([r.decision, r.by, r.reasonKey], ['needs', '', 'nameMany']);
  assert.deepEqual(r.candidates, ['9100012345', '9100022222'], 'the nearest booked time first');
  // a different name is not "close enough"
  assert.equal(run(rec('Priya Exampl', '2026-11-12 14:10'), [list[0]]).decision, 'needs');
});

// ── rule d: no usable title ───────────────────────────────────────────────────
test('no usable title is never filed; the consultations inside the window are suggested, nearest first, five at most', () => {
  const list = [
    C(1, 'A One', 'a@example.com', '2026-11-12 15:30'), C(2, 'B Two', 'b@example.com', '2026-11-12 14:00'), C(3, 'C Three', 'c@example.com', '2026-11-12 13:00'),
    C(4, 'D Four', 'd@example.com', '2026-11-12 09:00'), C(5, 'E Five', 'e@example.com', '2026-11-12 14:15'), C(6, 'F Six', 'f@example.com', '2026-11-12 14:30'),
    C(7, 'G Seven', 'g@example.com', '2026-11-12 14:40'), C(8, 'H Eight', 'h@example.com', ''),
  ];
  for (const title of ['', 'Note', '   ']) {
    const r = run(rec(title, '2026-11-12 14:05'), list);
    assert.deepEqual([r.decision, r.by, r.reasonKey], ['needs', '', 'noTitle'], JSON.stringify(title));
    assert.deepEqual(r.candidates, ['2', '5', '6', '7', '3'], 'nearest first; 15:30 is outside (the recording would be 85 min early), 09:00 and no-time are out');
  }
  assert.deepEqual(run(rec('', '2026-11-12 14:05'), []).candidates, []);
  const noStart = run({ otterId: 'ot_AAA111', title: 'TD-00002', startTime: 'soon', summary: LONG, transcript: LONG }, list);
  assert.deepEqual([noStart.decision, noStart.reasonKey, noStart.candidates], ['needs', 'noStart', ['2']]);
});

// ── rule e ────────────────────────────────────────────────────────────────────
test('a consultation that already has this recording is never matched again', () => {
  const list = [{ ...C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-12 14:00'), otterIds: ['ot_AAA111'] }];
  const r = run(rec('TD-12345', '2026-11-12 14:00'), list);
  assert.deepEqual([r.decision, r.reasonKey, r.already, r.candidates, r.leadId], ['needs', 'already', true, [], undefined]);
  // another recording on the same consultation still files
  assert.equal(run({ ...rec('TD-12345', '2026-11-12 14:00'), otterId: 'ot_BBB222' }, list).decision, 'file');
});

test('a recording first seen more than 30 days after it was made is never filed by itself', () => {
  const list = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-10-01 14:00')];
  const r = rec('TD-12345', '2026-10-01 14:00');
  const start = M.wallToMs('2026-10-01 14:00');
  const old = M.match(r, list, { now: start + 31 * 86400000 });
  assert.deepEqual([old.decision, old.by, old.reasonKey, old.candidates], ['needs', '', 'old', ['9100012345']]);
  assert.equal(M.match(r, list, { now: start + 29 * 86400000 }).decision, 'file');
  // "when first seen": a file seen on day 1 and retried on day 40 is not held for its age
  assert.equal(M.match(r, list, { now: start + 40 * 86400000, firstSeen: start + 86400000 }).decision, 'file');
});

test('a very short recording (summary + transcript under 200 characters) is never filed by itself', () => {
  const list = [C(9100012345, 'Priya Example', 'priya@example.com', '2026-11-12 14:00')];
  const short = run(rec('TD-12345', '2026-11-12 14:00', { summary: 'x'.repeat(99), transcript: 'y'.repeat(100) }), list);
  assert.deepEqual([short.decision, short.by, short.reason, short.candidates], ['needs', '', 'Very short recording', ['9100012345']]);
  assert.equal(run(rec('TD-12345', '2026-11-12 14:00', { summary: '', transcript: '' }), list).reason, 'Very short recording');
  assert.equal(run(rec('TD-12345', '2026-11-12 14:00', { summary: 'x'.repeat(100), transcript: 'y'.repeat(100) }), list).decision, 'file', '200 characters is enough');
  assert.equal(run(rec('', '2026-11-12 14:00', { summary: '', transcript: 'hi' }), list).reasonKey, 'short');
});

test('the answer never carries the title, a name or an email — reasons are fixed sentences; junk input does not throw', () => {
  const list = [C(9100012345, 'Priya Example', 'priya.example@example.com', '2026-11-12 14:00'), C(9100022222, 'Omar Sample', 'omar@example.com', '2026-11-12 14:30')];
  for (const title of ['TD-12345', 'TD-99999', 'priya.example@example.com', 'nobody@example.org', 'Priya Example', 'Omar Sample', 'Zed Unknown', '']) {
    const out = JSON.stringify(run(rec(title, '2026-11-12 14:05'), list));
    for (const leak of ['Priya', 'Omar', 'Zed', '@example', 'TD-', 'Example', 'Sample']) assert.ok(!out.includes(leak), `${title}: ${leak}`);
  }
  assert.ok(Object.values(M.REASONS).every((t) => !/\b(API|Zap|state|reader)\b/i.test(t)));
  for (const bad of [null, undefined, {}, { title: 5, startTime: {} }]) assert.equal(M.match(bad, null).decision, 'needs');
  assert.equal(M.match(rec('TD-12345', '2026-11-12 14:00'), [null, {}, { id: '' }]).decision, 'needs');
});

// ── rule f (review 2026-11-14): a title that points at two clients ────────────
test('REVIEW: a title whose tokens point at two different clients is never filed — both are suggested; tokens that match nobody do not block', () => {
  const A = C(9000012345, 'Alma Reyes', 'alma@example.com', '2026-11-12 10:00');
  const B = C(9000054321, 'Boris Quint', 'boris@example.com', '2026-11-12 14:00');
  const go = (title) => run(rec(title, '2026-11-12 14:02'), [A, B]);
  // the consultant had the 10:00 client's record open and typed the 14:00 client's name / email / code with it
  for (const title of ['TD-12345 boris@example.com', 'TD-12345 Boris Quint', 'Boris Quint TD-12345', 'alma@example.com Boris Quint', 'TD-12345 TD-54321', 'alma@example.com boris@example.com']) {
    const r = go(title);
    assert.deepEqual([r.decision, r.by, r.reasonKey, r.leadId], ['needs', '', 'titleDisagrees', undefined], title);
    assert.equal(r.reason, 'The title points at two different consultations');
    assert.deepEqual(r.candidates.slice(0, 2).sort(), ['9000012345', '9000054321'], title + ': both are offered');
  }
  // the control: each token by itself is certain
  assert.deepEqual([go('Boris Quint').leadId, go('TD-12345').leadId, go('alma@example.com').leadId], ['9000054321', '9000012345', '9000012345']);
  // tokens that AGREE still file
  for (const title of ['TD-12345 Alma Reyes', 'Alma Reyes — TD-12345 alma@example.com', 'TD-12345 TD 12345', 'alma@example.com Alma Reyes']) {
    assert.deepEqual([go(title).decision, go(title).leadId], ['file', '9000012345'], title);
  }
  // a token that matches NOBODY does not block: a nickname, extra words, an email nobody has
  for (const title of ['TD-12345 follow up', 'TD-12345 Ally', 'TD-12345 someone@example.org', 'alma@example.com second session']) {
    assert.deepEqual([go(title).decision, go(title).leadId], ['file', '9000012345'], title);
  }
  // two DIFFERENT codes are never filed, even when the second is nobody's: a code is one consultation
  assert.deepEqual([go('TD-12345 TD-99999').decision, go('TD-12345 TD-99999').reasonKey], ['needs', 'titleDisagrees']);
  // the name of a client with the same name as the deciding one (two people called the same) is not a disagreement
  const twin = C(9000077777, 'Alma Reyes', 'other@example.com', '2026-10-01 10:00');
  assert.equal(run(rec('TD-12345 Alma Reyes', '2026-11-12 10:05'), [A, B, twin]).decision, 'file');
  // a second code is read as a code — it never becomes a "name"
  assert.deepEqual(M.readTokens('TD-12345 td 54321 Boris'), { codes: ['TD-12345', 'TD-54321'], emails: [], name: 'boris' });
  assert.deepEqual(M.readTitle('TD-12345 TD-54321'), { code: 'TD-12345', email: '', name: '', kinds: ['code'] });
  const out = JSON.stringify(go('TD-12345 Boris Quint'));
  for (const leak of ['Boris', 'Quint', 'Alma', '@example', 'TD-']) assert.ok(!out.includes(leak), leak);
});
