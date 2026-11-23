'use strict';

// "Follow-Up needs a date" (Gauri's answers H2 b + H4, built 2026-11-23) — the SERVER half.
//
// The switch FOLLOWUP_DATE_REQUIRED ships OFF (unset = off; on only for 1 / true / on / yes).
//   off = exactly as before: a bare 'Follow-Up' saves in one write of the Outcome column, a date may be removed
//         from a Follow-Up client, changing the outcome leaves the date alone, any real day is taken.
//   on  = Follow-Up is refused without a date and with a day before today (Toronto); the date cannot be removed
//         while the outcome is Follow-Up; Follow-Up → Newsletter / Not Wanted / Webinar removes the date in the
//         SAME write (Retain keeps it).
//   always = a Follow-Up value that carries a date is written with the outcome in ONE updateLead call; an emptied
//         "Follow-up date" box removes the saved date only with the page's explicit mark (removeFollowUpDate);
//         the detail reads tell the pages the switch, and the lead detail carries the date.
//
// Every test that sets the switch puts the environment back afterwards.

const test   = require('node:test');
const assert = require('node:assert/strict');

const outcomes    = require('../config/outcomes');
const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const bl          = require('../src/services/blacklistService');
const snap        = require('../src/services/leadSnapshot');
const COLS        = require('../src/data/newLeadsBoard.json').columns;

const SWITCH = 'FOLLOWUP_DATE_REQUIRED';
function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
/** Run fn with environment variables set (undefined = unset), then put every one back as it was. */
async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const switchOn  = (fn) => withEnv({ [SWITCH]: '1' }, fn);
const switchOff = (fn) => withEnv({ [SWITCH]: undefined }, fn);

// 12:00 in Toronto on Monday 23 November 2026 — the "today" the past-date rule is checked against.
const NOON = new Date('2026-11-23T17:00:00Z');
const TODAY = '2026-11-23', YESTERDAY = '2026-11-22', LATER = '2026-11-27';

const NEEDED = 'Follow-Up needs a follow-up date (the day to call the client back). Choose the date and save again. If you see no date box, reload this page first.';
const PAST   = 'The follow-up date cannot be in the past. Choose today or a later day.';
const KEPT   = "This client's outcome is Follow-Up, so the follow-up date cannot be removed. Choose a new date, or change the outcome first.";

const LEAD = { id: '901', fullName: 'Test Client', email: 'test.client@example.com', phone: '4165550101', outcome: '', followUpDate: '', bookingStatus: 'Booked', bookedSlot: '2020-01-01 10:00' };

/** A lead behind fakes: every write, note, email and Not Wanted list add is recorded, in order. Nothing leaves the process. */
function world(lead) {
  const calls = { writes: [], notes: [], notified: [], listed: [], order: [] };
  const restore = [
    stub(leadService, 'getLead', async (id) => (String(id) === String(lead.id) ? { ...lead } : null)),
    stub(leadService, 'updateLead', async (...args) => { calls.order.push('write'); calls.writes.push(args); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) { calls.order.push('note'); calls.notes.push(vars.b); } return {}; }),
    stub(portal, 'notifyOutcomeChange', async (o) => { calls.order.push('email'); calls.notified.push(o); return { sent: false }; }),
    stub(bl, 'enabled', () => true),
    stub(bl, 'addFromLead', async (o) => { calls.order.push('list'); calls.listed.push(o); return { ok: true, result: 'created', entryId: '777' }; }),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}
const act = (value, extra = {}) => portal.applyAction({ leadId: LEAD.id, action: 'outcome', value, staffName: 'Staff One', now: NOON, ...extra });
const refusedWith = (text) => (e) => { assert.equal(e.badRequest, true, 'a 400, never a 500'); assert.equal(e.message, text); return true; };
const nothingHappened = (w) => assert.deepEqual([w.calls.writes.length, w.calls.notes.length, w.calls.notified.length, w.calls.listed.length], [0, 0, 0, 0], 'no column write, no note, no email, no list add');

/* ── the switch ── */

test('the switch FOLLOWUP_DATE_REQUIRED ships OFF: unset, empty, 0, off, no, false and anything else are off; only 1 / true / on / yes (any case, spaces trimmed) are on; it is read at call time', async () => {
  await withEnv({ [SWITCH]: undefined }, async () => {
    assert.equal(outcomes.followUpDateRequired(), false, 'unset = off');
    for (const v of ['', ' ', '0', 'off', 'no', 'false', 'OFF', '2', 'enabled', 'y', 'required', 'null', 'undefined']) {
      process.env[SWITCH] = v;
      assert.equal(outcomes.followUpDateRequired(), false, JSON.stringify(v) + ' is off');
    }
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', 'On', ' YES ', '\ttrue\n']) {
      process.env[SWITCH] = v;
      assert.equal(outcomes.followUpDateRequired(), true, JSON.stringify(v) + ' is on');
    }
    delete process.env[SWITCH];
    assert.equal(outcomes.followUpDateRequired(), false, 'never cached: off again as soon as the variable is gone');
  });
  assert.equal(portal.followUpDateRequired, outcomes.followUpDateRequired, 'the service hands on the same function');
  assert.deepEqual([portal.FOLLOW_UP_DATE_NEEDED, portal.FOLLOW_UP_DATE_PAST, portal.FOLLOW_UP_DATE_KEPT], [NEEDED, PAST, KEPT], 'the three refusals, word for word');
});

/* ── validateAction: pure, and the same whatever the switch says ── */

test('validateAction outcome: Follow-Up with a real date passes and hands the date on as its own field; `normalized` stays the plain label; a bare Follow-Up answers exactly as before', async () => {
  const v = (x) => portal.validateAction('outcome', x);
  const both = async (fn) => { await switchOff(fn); await switchOn(fn); await withEnv({ [SWITCH]: '0' }, fn); };
  await both(async () => {
    assert.deepEqual(v({ label: 'Follow-Up', followUpDate: LATER }), { ok: true, normalized: 'Follow-Up', reason: '', followUpDate: LATER });
    assert.deepEqual(v(JSON.stringify({ label: 'Follow-Up', followUpDate: LATER })), { ok: true, normalized: 'Follow-Up', reason: '', followUpDate: LATER }, 'JSON text, the way the Not Wanted reason travels');
    assert.deepEqual(v({ label: 'Follow-Up', followUpDate: ` ${LATER} ` }), { ok: true, normalized: 'Follow-Up', reason: '', followUpDate: LATER }, 'spaces around the date are dropped');
    assert.deepEqual(v({ label: 'Follow-Up', followUpDate: '2020-01-01', reason: 'ignored' }), { ok: true, normalized: 'Follow-Up', reason: '', followUpDate: '2020-01-01' }, 'a past day is a real day — today-or-later is not decided here (no clock in a pure check)');
    // no date: the answer of before, key for key (the switch is not looked at here)
    for (const bare of ['Follow-Up', { label: 'Follow-Up' }, { label: 'Follow-Up', followUpDate: '' }, { label: 'Follow-Up', followUpDate: null }, { label: 'Follow-Up', followUpDate: '   ' }, '{"label":"Follow-Up"}']) {
      assert.deepEqual(v(bare), { ok: true, normalized: 'Follow-Up', reason: '' }, JSON.stringify(bare));
    }
  });
});

test('validateAction outcome: a date that does not exist or has the wrong shape is refused with the words of the "Follow-up date" box', () => {
  const v = (fu) => portal.validateAction('outcome', { label: 'Follow-Up', followUpDate: fu });
  for (const unreal of ['2026-02-30', '2026-13-01', '2026-00-10', '2027-02-29', '2026-11-31']) {
    assert.deepEqual(v(unreal), { ok: false, error: 'That follow-up date doesn’t exist.' }, unreal);
    assert.deepEqual(portal.validateAction('saveAttribution', { followUpDate: unreal }), { ok: false, error: 'That follow-up date doesn’t exist.' }, 'the same words as the box: ' + unreal);
  }
  for (const shape of ['27/11/2026', '2026-11-27T10:00', '2026-1-5', 'tomorrow', '20261127', 20261127, { date: LATER }, [LATER, LATER], true]) {
    assert.deepEqual(v(shape), { ok: false, error: 'Follow-up date must be YYYY-MM-DD.' }, JSON.stringify(shape));
  }
  assert.deepEqual(portal.validateAction('saveAttribution', { followUpDate: '27/11/2026' }), { ok: false, error: 'Follow-up date must be YYYY-MM-DD.' });
  assert.equal(portal.validateAction('outcome', '{"label":"Follow-Up","followUpDate":"2026-11-27"').ok, false, 'broken JSON is still refused');
  assert.equal(portal.validateAction('outcome', { label: 'Follow-up', followUpDate: LATER }).ok, false, 'a near-miss label is still refused: no junk label in Monday');
});

test('validateAction outcome: Retain, Newsletter, Not Wanted (with its reason) and Webinar answer as before, with or without a date sent — a date on another outcome is ignored, even a bad one', () => {
  const v = (x) => portal.validateAction('outcome', x);
  for (const label of ['Retain', 'Newsletter', 'Webinar']) {
    const was = { ok: true, normalized: label, reason: '' };
    assert.deepEqual(v(label), was);
    assert.deepEqual(v({ label, followUpDate: LATER }), was, label + ': a date sent is ignored');
    assert.deepEqual(v({ label, followUpDate: '2026-02-30' }), was, label + ': even one that does not exist');
    assert.deepEqual(v(JSON.stringify({ label, followUpDate: 'junk' })), was);
  }
  const nw = { ok: true, normalized: 'Not Wanted', reason: 'abusive on the call' };
  assert.deepEqual(v({ label: 'Not Wanted', reason: 'abusive on the call' }), nw);
  assert.deepEqual(v({ label: 'Not Wanted', reason: 'abusive on the call', followUpDate: LATER }), nw);
  assert.equal(v({ label: 'Not Wanted', followUpDate: LATER }).ok, false, 'the reason is still required');
});

/* ── applyAction: the outcome Follow-Up ── */

test('switch ON: Follow-Up without a date is refused with the exact words and NOTHING is written — the bare label of a page left open, an object and JSON text alike', async () => {
  await switchOn(async () => {
    for (const lead of [LEAD, { ...LEAD, outcome: 'Follow-Up', followUpDate: LATER }, { ...LEAD, followUpDate: LATER }]) {
      const w = world(lead);
      try {
        for (const value of ['Follow-Up', { label: 'Follow-Up' }, { label: 'Follow-Up', followUpDate: '' }, '{"label":"Follow-Up"}']) {
          await assert.rejects(act(value), refusedWith(NEEDED), JSON.stringify(value));
        }
        nothingHappened(w);   // a date already on the record does not stand in for the one the save must carry
      } finally { w.done(); }
    }
  });
});

test('switch ON: Follow-Up with a date makes exactly ONE updateLead call carrying the outcome and the date; the note and the page message name the date', async () => {
  await switchOn(async () => {
    for (const value of [{ label: 'Follow-Up', followUpDate: LATER }, JSON.stringify({ label: 'Follow-Up', followUpDate: LATER })]) {
      const w = world(LEAD);
      try {
        const r = await act(value);
        assert.deepEqual(r, { ok: true, message: `Outcome recorded: Follow-Up. Follow-up date: ${LATER}.` });
        assert.deepEqual(w.calls.writes, [['901', { outcome: 'Follow-Up', followUpDate: LATER }]], 'one write, both columns, no clear list');
        assert.equal(w.calls.notes.length, 1);
        assert.match(w.calls.notes[0], new RegExp(`Outcome set to “Follow-Up” by Staff One — follow-up date: ${LATER}\\.$`));
        assert.deepEqual(w.calls.notified.map((n) => [n.from, n.to, n.staffName]), [['', 'Follow-Up', 'Staff One']], 'the staff email as before');
        assert.equal(w.calls.listed.length, 0);
        assert.deepEqual(w.calls.order, ['write', 'note', 'email']);
      } finally { w.done(); }
    }
    // pressing Follow-Up again to change the date: the same single write
    const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: TODAY });
    try {
      await act({ label: 'Follow-Up', followUpDate: LATER });
      assert.deepEqual(w.calls.writes, [['901', { outcome: 'Follow-Up', followUpDate: LATER }]]);
      assert.ok(!/removed/.test(w.calls.notes[0]), 'Follow-Up to Follow-Up removes nothing');
    } finally { w.done(); }
  });
});

test('the write as Monday receives it: one mutation with the Outcome label byte for byte and the Follow-Up Date as a date', async () => {
  const sent = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...LEAD })),
    stub(mondayApi, 'query', async (q, vars) => { if (/change_multiple_column_values/.test(q)) sent.push(JSON.parse(vars.cols)); return {}; }),
    stub(portal, 'notifyOutcomeChange', async () => ({ sent: false })),
  ];
  try {
    await switchOn(() => act({ label: 'Follow-Up', followUpDate: LATER }));
    assert.deepEqual(sent, [{ [COLS.outcome]: { label: 'Follow-Up' }, [COLS.followUpDate]: { date: LATER } }]);
  } finally { restore.reverse().forEach((r) => r()); snap._reset(); }
});

test('switch OFF (unset, 0, off, an unknown word): a bare Follow-Up saves as it always did — one write of the Outcome column only, the old note and the old message', async () => {
  for (const setting of [undefined, '0', 'off', '', 'maybe']) {
    await withEnv({ [SWITCH]: setting }, async () => {
      const w = world({ ...LEAD, followUpDate: LATER });
      try {
        const r = await act('Follow-Up');
        assert.deepEqual(r, { ok: true, message: 'Outcome recorded: Follow-Up.' });
        assert.deepEqual(w.calls.writes, [['901', { outcome: 'Follow-Up' }]], 'two arguments, as before: ' + JSON.stringify(setting));
        assert.match(w.calls.notes[0], /Outcome set to “Follow-Up” by Staff One\.$/);
        assert.deepEqual(w.calls.order, ['write', 'note', 'email']);
      } finally { w.done(); }
    });
  }
});

test('switch OFF: a Follow-Up that arrives WITH a date (a page left open across a switch change) still writes both in one call — and a past day is taken, the today-or-later rule belongs to the switch', async () => {
  await switchOff(async () => {
    for (const day of [LATER, TODAY, YESTERDAY, '2020-01-01']) {
      const w = world(LEAD);
      try {
        const r = await act({ label: 'Follow-Up', followUpDate: day });
        assert.equal(r.message, `Outcome recorded: Follow-Up. Follow-up date: ${day}.`);
        assert.deepEqual(w.calls.writes, [['901', { outcome: 'Follow-Up', followUpDate: day }]]);
        assert.match(w.calls.notes[0], new RegExp(`by Staff One — follow-up date: ${day}\\.$`));
      } finally { w.done(); }
    }
    // a date that does not exist is refused either way, before the lead is even read
    const w = world(LEAD);
    try {
      await assert.rejects(act({ label: 'Follow-Up', followUpDate: '2026-02-30' }), refusedWith('That follow-up date doesn’t exist.'));
      nothingHappened(w);
    } finally { w.done(); }
  });
});

/* ── decision 3: today or later ── */

test('switch ON, today or later (Toronto day): a day before today is refused with the exact words and nothing is written; today and later days pass; late in the evening "today" is still the Toronto day, not the UTC one', async () => {
  await switchOn(async () => {
    let w = world(LEAD);
    try {
      for (const day of [YESTERDAY, '2026-10-31', '2020-01-01']) await assert.rejects(act({ label: 'Follow-Up', followUpDate: day }), refusedWith(PAST), day);
      nothingHappened(w);
      for (const day of [TODAY, '2026-11-24', LATER, '2027-01-04']) assert.equal((await act({ label: 'Follow-Up', followUpDate: day })).message, `Outcome recorded: Follow-Up. Follow-up date: ${day}.`);
      assert.equal(w.calls.writes.length, 4);
    } finally { w.done(); }
    // 22:30 in Toronto on the 23rd is already the 24th in UTC: the 23rd is still today
    const evening = new Date('2026-11-24T03:30:00Z');
    w = world(LEAD);
    try {
      assert.equal((await act({ label: 'Follow-Up', followUpDate: TODAY }, { now: evening })).ok, true, 'today (Toronto) passes although the UTC day has moved on');
      await assert.rejects(act({ label: 'Follow-Up', followUpDate: YESTERDAY }, { now: evening }), refusedWith(PAST));
      assert.equal(w.calls.writes.length, 1);
    } finally { w.done(); }
    // 00:30 in Toronto on the 24th: the 23rd is now yesterday
    w = world(LEAD);
    try {
      await assert.rejects(act({ label: 'Follow-Up', followUpDate: TODAY }, { now: new Date('2026-11-24T05:30:00Z') }), refusedWith(PAST));
      nothingHappened(w);
    } finally { w.done(); }
  });
});

test('today or later is asked only at the Follow-Up save: "Save attribution" keeps taking any real day, switch on or off', async () => {
  for (const setting of ['1', undefined]) {
    await withEnv({ [SWITCH]: setting }, async () => {
      const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
      try {
        const r = await portal.applyAction({ leadId: '901', action: 'saveAttribution', value: JSON.stringify({ followUpDate: '2020-01-01', leadOwner: 'Staff One' }), now: NOON });
        assert.deepEqual(r, { ok: true, message: 'Attribution saved.' });
        assert.deepEqual(w.calls.writes, [['901', { followUpDate: '2020-01-01', leadOwner: 'Staff One', bookedBy: '', paymentReviewedBy: '' }]]);
      } finally { w.done(); }
    });
  }
});

/* ── decision 2: leaving Follow-Up removes the date ── */

test('switch ON: Follow-Up → Newsletter removes the follow-up date in the SAME write (the clear list) and the note and the message say which date', async () => {
  await switchOn(async () => {
    const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
    try {
      const r = await act('Newsletter');
      assert.deepEqual(w.calls.writes, [['901', { outcome: 'Newsletter' }, { clearKeys: ['followUpDate'] }]], 'one write: the outcome and the clear together');
      assert.match(w.calls.notes[0], new RegExp(`Outcome set to “Newsletter” by Staff One — follow-up date ${LATER} removed\\.$`));
      assert.equal(r.message, `Outcome recorded: Newsletter. The follow-up date ${LATER} was removed.`);
      assert.equal(w.calls.notes.length, 1);
    } finally { w.done(); }
  });
});

test('switch ON: Follow-Up → Not Wanted removes the date in the same write — and the person is still added to the Not Wanted list BEFORE the outcome is written', async () => {
  await switchOn(async () => {
    const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
    try {
      const r = await act({ label: 'Not Wanted', reason: 'abusive on the call' });
      assert.deepEqual(w.calls.order.slice(0, 2), ['list', 'write'], 'the list first, then the one write');
      assert.deepEqual(w.calls.writes, [['901', { outcome: 'Not Wanted' }, { clearKeys: ['followUpDate'] }]]);
      assert.equal(w.calls.listed.length, 1);
      assert.equal(w.calls.listed[0].reason, 'abusive on the call');
      assert.match(w.calls.notes[0], new RegExp(`Outcome set to “Not Wanted” by Staff One — reason: abusive on the call — follow-up date ${LATER} removed\\.$`));
      assert.equal(r.message, `Outcome recorded: Not Wanted. They are now on the Not Wanted list — staff will be warned if they come back. The follow-up date ${LATER} was removed.`);
    } finally { w.done(); }
  });
});

test('switch ON: Follow-Up → Webinar (the lead page) removes the date too; the old label that reads as Follow-Up counts as Follow-Up', async () => {
  await switchOn(async () => {
    let w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
    try {
      const r = await act('Webinar');
      assert.deepEqual(w.calls.writes, [['901', { outcome: 'Webinar' }, { clearKeys: ['followUpDate'] }]]);
      assert.equal(r.message, `Outcome recorded: Webinar. The follow-up date ${LATER} was removed.`);
    } finally { w.done(); }
    const legacy = Object.keys(outcomes.LEGACY_OUTCOMES).find((k) => outcomes.LEGACY_OUTCOMES[k] === 'Follow-Up');
    assert.ok(legacy, 'there is an old label that means Follow-Up');
    w = world({ ...LEAD, outcome: legacy, followUpDate: LATER });
    try {
      await act('Newsletter');
      assert.deepEqual(w.calls.writes, [['901', { outcome: 'Newsletter' }, { clearKeys: ['followUpDate'] }]]);
      assert.match(w.calls.notes[0], new RegExp(`follow-up date ${LATER} removed\\.$`));
    } finally { w.done(); }
  });
});

test('switch ON: Retain keeps the date; nothing is cleared when there was no date, or when the old outcome was not Follow-Up (Newsletter → Not Wanted, a blank outcome with a date)', async () => {
  await withEnv({ [SWITCH]: '1', DEADLINE_REQUIRED: '0' }, async () => {
    const plain = (label) => [['901', { outcome: label }]];
    // Follow-Up → Retain: the date stays (a client sent an agreement may still need a call)
    let w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
    try {
      await act('Retain');
      assert.deepEqual(w.calls.writes, plain('Retain'), 'no clear list');
      assert.ok(!/follow-up/.test(w.calls.notes[0]));
    } finally { w.done(); }
    // Follow-Up with no date → Newsletter: nothing to remove
    w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: '' });
    try {
      const r = await act('Newsletter');
      assert.deepEqual(w.calls.writes, plain('Newsletter'));
      assert.equal(r.message, 'Outcome recorded: Newsletter.');
      assert.match(w.calls.notes[0], /Outcome set to “Newsletter” by Staff One\.$/);
    } finally { w.done(); }
    // Newsletter (with a date typed by hand) → Not Wanted: not a Follow-Up client, the date is left alone
    w = world({ ...LEAD, outcome: 'Newsletter', followUpDate: LATER });
    try {
      const r = await act({ label: 'Not Wanted', reason: 'abusive on the call' });
      assert.deepEqual(w.calls.writes, plain('Not Wanted'));
      assert.ok(!/removed/.test(r.message) && !/removed/.test(w.calls.notes[0]));
    } finally { w.done(); }
    // no outcome yet, a date on the record → Newsletter: left alone
    for (const from of ['', 'Retain', 'Not Wanted']) {
      w = world({ ...LEAD, outcome: from, followUpDate: LATER });
      try { await act('Newsletter'); assert.deepEqual(w.calls.writes, plain('Newsletter'), 'from ' + JSON.stringify(from)); } finally { w.done(); }
    }
  });
});

test('switch OFF: changing the outcome away from Follow-Up never touches the date — the write, the note and the message are those of before', async () => {
  await switchOff(async () => {
    for (const [value, label] of [['Newsletter', 'Newsletter'], [{ label: 'Not Wanted', reason: 'abusive on the call' }, 'Not Wanted'], ['Webinar', 'Webinar']]) {
      const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
      try {
        const r = await act(value);
        assert.deepEqual(w.calls.writes, [['901', { outcome: label }]], label + ': the Outcome column only, no clear list');
        assert.ok(!/follow-up date/i.test(r.message) && !/follow-up date/.test(w.calls.notes[0]), label);
      } finally { w.done(); }
    }
  });
});

/* ── "Save attribution": the date box ── */

const attribution = (o) => portal.applyAction({ leadId: '901', action: 'saveAttribution', value: JSON.stringify(o), staffName: 'Staff One', now: NOON });
const BOXES = { leadOwner: 'Staff One', bookedBy: 'Staff Two', paymentReviewedBy: 'Staff Three' };

test('validateAction saveAttribution: the remove mark is taken only as the boolean true, and only with an empty date box — a date in the box wins', () => {
  const v = (o) => portal.validateAction('saveAttribution', o).normalized;
  assert.deepEqual(v({ ...BOXES, followUpDate: '' }), { followUpDate: '', ...BOXES, removeFollowUpDate: false });
  assert.deepEqual(v({ ...BOXES, followUpDate: '', removeFollowUpDate: true }), { followUpDate: '', ...BOXES, removeFollowUpDate: true });
  assert.deepEqual(v(JSON.stringify({ ...BOXES, removeFollowUpDate: true })), { followUpDate: '', ...BOXES, removeFollowUpDate: true });
  assert.equal(v({ followUpDate: LATER, removeFollowUpDate: true }).removeFollowUpDate, false, 'a date in the box: the mark means nothing');
  for (const notTrue of ['true', 1, 'yes', {}, [], null, undefined, false]) assert.equal(v({ removeFollowUpDate: notTrue }).removeFollowUpDate, false, JSON.stringify(notTrue));
});

test('Save attribution, an EMPTY date box WITHOUT the mark changes nothing for the date (switch on or off): no clear list, and the note names the date that stays', async () => {
  for (const setting of ['1', undefined]) {
    await withEnv({ [SWITCH]: setting }, async () => {
      for (const outcome of ['Follow-Up', 'Newsletter', '']) {
        const w = world({ ...LEAD, outcome, followUpDate: LATER });
        try {
          const r = await attribution({ ...BOXES, followUpDate: '' });
          assert.deepEqual(r, { ok: true, message: 'Attribution saved.' });
          assert.deepEqual(w.calls.writes, [['901', { followUpDate: '', ...BOXES }]], 'the empty value is skipped by updateLead; no clear list is passed');
          assert.match(w.calls.notes[0], new RegExp(`Attribution saved — owner: Staff One, booked by: Staff Two, payment reviewed by: Staff Three, follow-up: ${LATER}\\.$`));
        } finally { w.done(); }
      }
      // no date saved and none typed: the note keeps the dash
      const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: '' });
      try {
        await attribution({ ...BOXES });
        assert.equal(w.calls.writes[0].length, 2);
        assert.match(w.calls.notes[0], /follow-up: —\.$/);
      } finally { w.done(); }
    });
  }
});

test('Save attribution WITH the mark removes the saved date through the clear list (switch on or off) and the note says "removed (was …)"; the other three boxes are never in the clear list', async () => {
  for (const setting of ['1', undefined]) {
    await withEnv({ [SWITCH]: setting }, async () => {
      for (const outcome of ['Newsletter', 'Not Wanted', 'Retain', '']) {
        const w = world({ ...LEAD, outcome, followUpDate: LATER, leadOwner: 'Staff Nine', bookedBy: 'Staff Nine', paymentReviewedBy: 'Staff Nine' });
        try {
          // the three name boxes left empty: they are skipped (never cleared), only the date goes
          const r = await attribution({ followUpDate: '', leadOwner: '', bookedBy: '', paymentReviewedBy: '', removeFollowUpDate: true });
          assert.deepEqual(r, { ok: true, message: `Attribution saved. The follow-up date ${LATER} was removed.` });
          assert.deepEqual(w.calls.writes, [['901', { followUpDate: '', leadOwner: '', bookedBy: '', paymentReviewedBy: '' }, { clearKeys: ['followUpDate'] }]], JSON.stringify(outcome));
          assert.match(w.calls.notes[0], new RegExp(`Attribution saved — owner: —, booked by: —, payment reviewed by: —, follow-up: removed \\(was ${LATER}\\)\\.$`));
        } finally { w.done(); }
      }
      // the mark on a record with no saved date: nothing to remove, no clear list, the dash
      const w = world({ ...LEAD, outcome: 'Newsletter', followUpDate: '' });
      try {
        const r = await attribution({ ...BOXES, removeFollowUpDate: true });
        assert.deepEqual(r, { ok: true, message: 'Attribution saved.' });
        assert.deepEqual(w.calls.writes, [['901', { followUpDate: '', ...BOXES }]]);
        assert.match(w.calls.notes[0], /follow-up: —\.$/);
      } finally { w.done(); }
    });
  }
});

test('the removal as Monday receives it: the Follow-Up Date column gets the empty string (never {date:""}), and the name boxes left empty are not sent at all', async () => {
  const sent = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...LEAD, outcome: 'Newsletter', followUpDate: LATER, leadOwner: 'Staff Nine' })),
    stub(mondayApi, 'query', async (q, vars) => { if (/change_multiple_column_values/.test(q)) sent.push(JSON.parse(vars.cols)); return {}; }),
  ];
  try {
    await switchOn(() => attribution({ followUpDate: '', leadOwner: '', bookedBy: 'Staff Two', paymentReviewedBy: '', removeFollowUpDate: true }));
    assert.deepEqual(sent, [{ [COLS.followUpDate]: '', [COLS.bookedBy]: 'Staff Two' }]);
  } finally { restore.reverse().forEach((r) => r()); snap._reset(); }
});

test('switch ON: the date cannot be removed while the outcome is Follow-Up (or the old label that reads as it) — refused with the exact words and nothing is written; a changed date still saves', async () => {
  const legacy = Object.keys(outcomes.LEGACY_OUTCOMES).find((k) => outcomes.LEGACY_OUTCOMES[k] === 'Follow-Up');
  await switchOn(async () => {
    for (const outcome of ['Follow-Up', legacy]) {
      const w = world({ ...LEAD, outcome, followUpDate: LATER });
      try {
        await assert.rejects(attribution({ ...BOXES, followUpDate: '', removeFollowUpDate: true }), refusedWith(KEPT), outcome);
        nothingHappened(w);   // the other three boxes are not saved either: the page shows the refusal and the user saves again
        const r = await attribution({ ...BOXES, followUpDate: '2026-12-04' });
        assert.deepEqual(r, { ok: true, message: 'Attribution saved.' });
        assert.deepEqual(w.calls.writes, [['901', { followUpDate: '2026-12-04', ...BOXES }]], 'changing the date: as before');
        assert.match(w.calls.notes[0], /follow-up: 2026-12-04\.$/);
      } finally { w.done(); }
    }
    // an old Follow-Up record with NO date: the three boxes still save, with or without the mark
    const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: '' });
    try {
      assert.equal((await attribution({ ...BOXES })).ok, true);
      assert.equal((await attribution({ ...BOXES, removeFollowUpDate: true })).ok, true);
      assert.deepEqual(w.calls.writes, [['901', { followUpDate: '', ...BOXES }], ['901', { followUpDate: '', ...BOXES }]]);
    } finally { w.done(); }
  });
});

test('switch OFF: a date may be removed from a Follow-Up client (with the mark) — the refusal belongs to the switch', async () => {
  await switchOff(async () => {
    const w = world({ ...LEAD, outcome: 'Follow-Up', followUpDate: LATER });
    try {
      const r = await attribution({ ...BOXES, removeFollowUpDate: true });
      assert.equal(r.message, `Attribution saved. The follow-up date ${LATER} was removed.`);
      assert.deepEqual(w.calls.writes, [['901', { followUpDate: '', ...BOXES }, { clearKeys: ['followUpDate'] }]]);
    } finally { w.done(); }
  });
});

/* ── leadService.buildCols (through updateLead, its only door): how a date is written and cleared ── */

test('buildCols: clearKeys ["followUpDate"] sends the empty string for the Follow-Up Date column, never a typed empty; without the clear list an empty date is not sent; a date goes as { date }', async () => {
  const sent = [];
  const restore = stub(mondayApi, 'query', async (q, vars) => { if (/change_multiple_column_values/.test(q)) sent.push(JSON.parse(vars.cols)); return {}; });
  const build = async (fields, clearKeys) => { sent.length = 0; await leadService.updateLead('901', fields, clearKeys ? { clearKeys } : undefined); return sent.length ? sent[0] : {}; };
  try {
    assert.equal(COLS.followUpDate, 'date_mm4xah42');
    assert.deepEqual(await build({ outcome: 'Newsletter' }, ['followUpDate']), { [COLS.outcome]: { label: 'Newsletter' }, date_mm4xah42: '' }, 'a key in the clear list is cleared even when the fields leave it out');
    assert.deepEqual(await build({ followUpDate: '' }, ['followUpDate']), { date_mm4xah42: '' });
    assert.strictEqual((await build({ followUpDate: '' }, ['followUpDate'])).date_mm4xah42, '', 'the empty string itself, not { date: "" }');
    assert.deepEqual(await build({ followUpDate: '', leadOwner: '' }, []), {}, 'an empty box alone is never a clear (and nothing is sent at all)');
    assert.deepEqual(await build({ followUpDate: '', leadOwner: '' }), {});
    assert.deepEqual(await build({ outcome: 'Follow-Up', followUpDate: LATER }), { [COLS.outcome]: { label: 'Follow-Up' }, date_mm4xah42: { date: LATER } });
  } finally { restore(); snap._reset(); }
});

/* ── how the pages learn the switch ── */

test('the record detail and the lead detail say the switch (followUpDateRequired, a boolean) and the lead detail carries the follow-up date', async () => {
  const lead = { id: '901', fullName: 'Test Client', email: 'test.client@example.com', outcome: 'Follow-Up', followUpDate: LATER, inviteMessage: 'x', bookingStatus: 'Booked' };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(require('../src/services/consultPriceService'), 'ensureFresh', async () => {}),
    stub(bl, 'check', async () => ({ checked: false, hit: false, matchedOn: [], entries: [] })),
  ];
  try {
    for (const [setting, want] of [[undefined, false], ['0', false], ['1', true], ['yes', true]]) {
      await withEnv({ [SWITCH]: setting }, async () => {
        const rec = await portal.getConsultationDetail('901');
        assert.strictEqual(rec.followUpDateRequired, want, 'record detail, switch ' + JSON.stringify(setting));
        assert.equal(rec.followUpDate, LATER);
        const ld = await portal.getLeadDetail('901');
        assert.strictEqual(ld.followUpDateRequired, want, 'lead detail, switch ' + JSON.stringify(setting));
        assert.equal(ld.followUpDate, LATER, 'the lead page can show the date');
        assert.equal(ld.outcome, 'Follow-Up');
      });
    }
    lead.followUpDate = ''; lead.outcome = '';
    await switchOff(async () => {
      assert.strictEqual((await portal.getLeadDetail('901')).followUpDate, '', 'no date: the empty string');
      assert.strictEqual((await portal.getConsultationDetail('901')).followUpDate, '');
    });
  } finally { restore.reverse().forEach((r) => r()); }
});

test('the lists\' answer (/api/consultations-board) says the switch once, and ONLY when it is on — switched off the answer has exactly the parts it had', async () => {
  const leads = [
    { id: '1', fullName: 'Test Client', bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00', outcome: 'Follow-Up', followUpDate: '' },
    { id: '2', fullName: 'Test Client Two', bookingStatus: 'Booked', bookedSlot: '2026-11-20 11:00', outcome: 'Follow-Up', followUpDate: LATER },
    { id: '3', fullName: 'Test Client Three', bookingStatus: 'Booked', bookedSlot: '2026-11-30 11:00', outcome: '' },
  ];
  const restore = [stub(snap.io, 'fetchLeads', async () => JSON.parse(JSON.stringify(leads))), stub(require('../src/services/dashboardService'), 'fetchAllItems', async () => [])];
  try {
    for (const opts of [{}, { withRetained: true }, { withCompleted: true }]) {
      snap._reset();
      const off = await switchOff(() => portal.getConsultationsBoard({ now: NOON, ...opts }));
      assert.equal('followUpDateRequired' in off, false, 'off: the key is not there');
      snap._reset();
      const on = await switchOn(() => portal.getConsultationsBoard({ now: NOON, ...opts }));
      assert.strictEqual(on.followUpDateRequired, true);
      // nothing else differs: the rows are the same, and no row carries the switch
      const { followUpDateRequired, at: _a, ageMs: _b, ...restOn } = on;
      const { at: _c, ageMs: _d, ...restOff } = off;
      assert.deepEqual(restOn, restOff);
      assert.deepEqual(Object.keys(on).filter((k) => !(k in off)), ['followUpDateRequired']);
      for (const r of on.retainers.concat(on.consultations, on.retained || [], on.completed || [])) assert.equal('followUpDateRequired' in r, false);
      assert.deepEqual(on.retainers.map((r) => [r.id, r.outcome, r.followUpDate]), [['1', 'Follow-Up', ''], ['2', 'Follow-Up', LATER]], 'the rows the "no follow-up date" pill is drawn from');
    }
  } finally { restore.reverse().forEach((r) => r()); snap._reset(); }
});
