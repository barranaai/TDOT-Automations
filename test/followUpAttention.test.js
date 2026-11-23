'use strict';

// "Needs attention" lines for follow-up dates (Gauri's answer H4, built 2026-11-23): the consultant sets a
// follow-up date with the outcome Follow-Up; the person doing retainers calls the client back on that day.
//
//   followup-due      the outcome is Follow-Up (or the old label that reads as it), the client is not retained
//                     and not a test record, and the follow-up date is BEFORE today (Toronto day). Always on.
//   followup-no-date  the same client with no follow-up date at all — listed ONLY while the switch
//                     FOLLOWUP_DATE_REQUIRED is on (read when the check runs).
//
// The owner's decision: EVERY signed-in staff member sees these two lines (every other line keeps its own
// rule). They carry the client's name and the date — nothing else of the record. A viewer limited to their
// own cases sees them without "Mark handled"; the mark is a note on the client's record (the Lead Board row).
// The link to the client's record goes only to a tab that can open it (the team key); everyone else gets
// the line without a link and is told to tell the person who does the retainers.
//
// Made-up people only ("Dana Example" — "Test Client" is a test record by name, so it can never be a listed one). Every test that sets the switch puts the environment back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const NA = require('../src/services/needsAttentionService');
const REAL_IO = { ...NA.io };   // the real seams, before any test replaces them (two tests below run one of them offline)
const outcomes = require('../config/outcomes');
const portal = require('../src/services/consultantPortalService');

const SWITCH = 'FOLLOWUP_DATE_REQUIRED';
async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const switchOn  = (fn) => withEnv({ [SWITCH]: '1' }, fn);
const switchOff = (fn) => withEnv({ [SWITCH]: undefined }, fn);

const H = 3600 * 1000;
// 10:00 in Toronto on Monday 23 November 2026.
const NOW = Date.parse('2026-11-23T15:00:00Z');
const TODAY = '2026-11-23', YESTERDAY = '2026-11-22', TOMORROW = '2026-11-24';

/** A client record as the shared lead list carries it (leadSnapshot) — with things the line must never show. */
const lead = (over = {}) => ({
  id: 'L1', name: 'Dana Example', fullName: 'Dana Example', outcome: 'Follow-Up', followUpDate: '2026-11-20',
  outcomeChangedAt: '2026-11-13T16:00:00.000Z', conversionStatus: '', bookingStatus: 'Booked', bookedSlot: '2026-11-13 11:00',
  retainerSent: '', retainerSigned: '', retainerPaid: '', retainerFee: '4321', clientMasterItemId: '', caseDeleted: '',
  hasEmail: true, leadOwner: 'Owner Person', assignedConsultant: 'Consultant Person', sourceChannel: 'Website', ...over,
});
/** A Cases-board item as Monday returns it. */
function item({ id, name = 'Case Person', group = 'group_mm6sykds', groupTitle = 'November 2026', ref = '2026-SV-050', stage = 'Internal Review', payment = 'Paid', people = null } = {}) {
  const cv = [['text_mm142s49', ref], ['dropdown_mm0xd1qn', 'Visitor Visa'], ['dropdown_mm0x4t91', ''], ['color_mm0x8faa', stage], ['color_mm0x9fnn', payment],
    ['date_mm0xgk76', ''], ['multiple_person_mm0xhmgk', ''], ['multiple_person_mm2nhsx1', '']].map(([cid, text]) => ({ id: cid, text, value: null }));
  if (people) cv.push({ id: 'multiple_person_mm0xgpt', text: 'Someone', value: JSON.stringify({ personsAndTeams: people }) });
  return { id, name, created_at: new Date(NOW - 90 * 24 * H).toISOString(), group: { id: group, title: groupTitle }, column_values: cv, updates: [] };
}
const FU_KINDS = ['followup-due', 'followup-no-date'];
const fu = (entries) => entries.filter((e) => FU_KINDS.includes(e.kind));
/** The pure rule, on these leads. `needsDate` undefined = the switch as the environment has it. */
const run = (leads, { now = NOW, items = [], needsDate } = {}) => fu(NA.detect({ cases: items.map(NA.parseCase), leads, now, ...(needsDate === undefined ? {} : { followUpNeedsDate: needsDate }) }));

/** The check's seams, offline: nothing here reaches Monday or OneDrive. */
function harness({ items = () => [], leads = () => [], deep = new Map(), deepFail = [], templates = () => [] } = {}) {
  const calls = { notes: [], deep: [] };
  NA.io.readCases = async () => items();
  NA.io.hasChecklist = async () => true;
  NA.io.listRootFolders = async () => [];
  NA.io.workFoldersPresent = async () => true;
  NA.io.readDeepNotes = async (ids) => { calls.deep.push(ids); return { notes: new Map([...deep].filter(([id]) => ids.includes(id) && !deepFail.includes(id))), failed: ids.filter((id) => deepFail.includes(id)) }; };
  NA.io.newestChecklistRowAt = async () => 0;
  NA.io.familyTypes = async () => new Set();
  NA.io.checklistMemberTypes = async () => new Set();
  NA.io.manifestMemberTypes = async () => new Set();
  NA.io.leadBalances = async () => [];
  NA.io.postNote = async (itemId, body) => { calls.notes.push({ itemId, body }); };
  NA.io.reminderTemplateProblems = async () => templates();
  NA.io.leads = async () => leads();
  return calls;
}
const ADMIN = { isAdmin: true, scope: 'all', name: 'Admin' };
const SEES_ALL = { userId: '9', teamIds: [], isAdmin: false, scope: 'all' };
const LIMITED = { userId: '77', teamIds: [], isAdmin: false, scope: 'assigned' };
const asNote = (body, id = 'h1') => ({ id, created_at: new Date(NOW - H).toISOString(), text_body: body.replace(/<[^>]+>/g, '') });

test.beforeEach(() => { NA.io.now = () => NOW; NA._resetForTests(); });

// ── The rule ────────────────────────────────────────────────────────────────

test('a Follow-Up client whose follow-up date has passed is ONE line about the client record: the name, the date, what to do, the link — nothing else', async () => {
  await switchOff(async () => {
    const out = run([lead()]);
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.kind, 'followup-due');
    assert.match(e.key, /^NA-[0-9a-f]{10}$/);
    assert.equal(e.why, 'Follow-up date passed (20 Nov): Dana Example was to be called back on that day. The outcome is still Follow-Up.');
    assert.equal(e.todo, 'Call Dana Example back, then set a new follow-up date or change the outcome: open the client\'s record — "Follow-up date" is under Attribution & follow-up (press "Save attribution"), the outcome is under "Record outcome". The line then leaves this list at the next check (07:00, or Check now).');
    assert.deepEqual([e.client, e.leadId, e.link, e.linkLabel, e.followUpDate], ['Dana Example', 'L1', '/admin/consultation/L1?from=retainers', 'Client record', '2026-11-20']);
    assert.equal(e.since, '2026-11-20T12:00:00.000Z', 'the page says "Since 20 Nov · 3 days"');
    // about the client record alone: no case row, no case number, no stage, payment or manager
    assert.deepEqual([e.rows, e.itemIds, e.caseRef, e.stage, e.payment, e.manager], [[], [], '', '', '', '']);
    // exactly these fields — nothing else of the record can ride along
    assert.deepEqual(Object.keys(e).sort(), ['caseRef', 'client', 'followUpDate', 'itemIds', 'key', 'kind', 'leadId', 'link', 'linkLabel', 'manager', 'payment', 'rows', 'since', 'stage', 'todo', 'why']);
    const sent = JSON.stringify(e);
    for (const secret of ['4321', 'Owner Person', 'Consultant Person', 'Website', '11:00', 'hasEmail']) assert.ok(!sent.includes(secret), `${secret} is not on the line`);
    // a date in another year is said with its year
    assert.match(run([lead({ followUpDate: '2025-12-30' })])[0].why, /^Follow-up date passed \(30 Dec 2025\): /);
    // a record with no name still reads as a sentence
    const [anon] = run([lead({ fullName: '', name: '' })]);
    assert.match(anon.why, /: the client was to be called back on that day\./);
    assert.match(anon.todo, /^Call the client back, /);
    // an id is made safe for the link
    assert.equal(run([lead({ id: '12 3/4' })])[0].link, '/admin/consultation/12%203%2F4?from=retainers');
  });
});

test('"passed" is strictly before today (Toronto day): yesterday is listed, today and a later day are not — switch on or off', async () => {
  for (const sw of [switchOff, switchOn]) {
    await sw(async () => {
      assert.deepEqual(run([lead({ followUpDate: YESTERDAY })]).map((e) => e.kind), ['followup-due']);
      assert.deepEqual(run([lead({ followUpDate: TODAY })]), [], 'today\'s calls are today\'s work');
      assert.deepEqual(run([lead({ followUpDate: TOMORROW })]), []);
      assert.deepEqual(run([lead({ followUpDate: '2027-01-05' })]), []);
    });
  }
  // a date cell that carries a time still reads as its day; text that is no day makes no claim either way
  assert.deepEqual(run([lead({ followUpDate: '2026-11-20 09:30' })], { needsDate: true }).map((e) => [e.kind, e.followUpDate]), [['followup-due', '2026-11-20']]);
  assert.deepEqual(run([lead({ followUpDate: 'soon' })], { needsDate: true }), []);
  for (const notADay of ['2026-13-45', '2026-02-31', '2026-00-10', '2026-11-2', '20/11/2026']) assert.deepEqual(run([lead({ followUpDate: notADay })], { needsDate: true }), [], `${notADay} is not a real day`);
});

test('no follow-up date: listed ONLY while "Follow-Up needs a date" is switched on — and the switch is read when the check runs', async () => {
  const noDate = lead({ followUpDate: '' });
  await switchOff(async () => assert.deepEqual(run([noDate]), [], 'switched off, nobody is asked for dates yet'));
  for (const off of ['', '0', 'off', 'false', 'no']) await withEnv({ [SWITCH]: off }, async () => assert.deepEqual(run([noDate]), [], `"${off}" is off`));
  await switchOn(async () => {
    const out = run([noDate]);
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.kind, 'followup-no-date');
    assert.equal(e.why, 'Follow-Up with no follow-up date: Dana Example has the outcome Follow-Up, but no day is set to call them back.');
    assert.equal(e.todo, 'Choose the day to call Dana Example back: open the client\'s record, type it in "Follow-up date" under Attribution & follow-up and press "Save attribution". If no call is planned, change the outcome under "Record outcome". The line then leaves this list at the next check (07:00, or Check now).');
    assert.deepEqual([e.client, e.leadId, e.link, e.linkLabel, e.rows, e.caseRef], ['Dana Example', 'L1', '/admin/consultation/L1?from=retainers', 'Client record', [], '']);
    assert.equal(e.since, '2026-11-13T16:00:00.000Z', 'since the day the outcome was set, as Monday says it');
    assert.ok(!('followUpDate' in e));
    assert.equal(run([lead({ followUpDate: '', outcomeChangedAt: '' })])[0].since, '', 'not known when: no "since"');
    assert.equal(run([lead({ followUpDate: '   ' })]).length, 1, 'blanks are no date');
  });
  for (const on of ['1', 'true', 'on', 'yes', 'ON']) await withEnv({ [SWITCH]: on }, async () => assert.equal(run([noDate]).length, 1, `"${on}" is on`));
  // read at check time, never cached: the same loaded module, the environment changed between two checks
  harness({ leads: () => [noDate] });
  await switchOff(async () => assert.deepEqual(fu((await NA.buildSnapshot()).entries), []));
  await switchOn(async () => assert.deepEqual(fu((await NA.buildSnapshot()).entries).map((e) => e.kind), ['followup-no-date']));
  await switchOff(async () => assert.deepEqual(fu((await NA.buildSnapshot()).entries), []));
  // the passed-date line has no switch
  await switchOff(async () => assert.equal(run([lead()], { needsDate: false }).length, 1));
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.ok(src.includes('followUpNeedsDate = outcomes.followUpDateRequired(),'), 'the one switch helper, as the check\'s default');
});

test('a retained client is never listed (the Retained tab\'s own rule); a retainer under way without it still is', async () => {
  await switchOn(async () => {
    const retained = lead({ conversionStatus: 'Retained', retainerSigned: '2026-11-15', retainerPaid: '2026-11-16' });
    assert.equal(portal.retainerTab(retained), portal.RETAINED_TAB);
    assert.deepEqual(run([retained]), []);
    assert.deepEqual(run([{ ...retained, followUpDate: '' }]), []);
    // a retainer sent / signed / paid but not yet "Retained": the Follow-Up tab still has this client, so the line stays
    for (const under of [{ retainerSent: '2026-11-18' }, { retainerSigned: '2026-11-18' }, { retainerPaid: '2026-11-18' }]) {
      const l = lead(under);
      assert.equal(portal.retainerTab(l), 'Follow-Up');
      assert.equal(run([l]).length, 1);
    }
    // the rule is the lists' own function, not a second copy of it
    const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
    assert.ok(src.includes("classifyLead = require('./consultantPortalService').classifyLead;"));
    assert.ok(src.includes("if (classifyLead(lead) === 'gone') continue;"));
  });
});

test('a test record is never listed: by its name, or because its case sits in the TEST group — a case in the Cancel or Leads group is a real client and IS listed', async () => {
  await switchOn(async () => {
    assert.deepEqual(run([lead({ fullName: 'TEST CLIENT - E2E 1790000000000' })]), []);
    assert.deepEqual(run([lead({ fullName: 'Test Client', followUpDate: '' })]), []);
    assert.deepEqual(run([lead({ fullName: 'E2E Person' })]), []);
    const testCase = item({ id: 't1', group: 'group_mm3842s', groupTitle: 'TEST' });
    assert.deepEqual(run([lead({ clientMasterItemId: 't1' })], { items: [testCase] }), []);
    assert.deepEqual(run([lead({ clientMasterItemId: 't1', followUpDate: '' })], { items: [testCase] }), []);
    // the TEST group by its title alone (the group was re-made), and a case named as a test record in a live group
    assert.deepEqual(run([lead({ clientMasterItemId: 't2' })], { items: [item({ id: 't2', group: 'group_new', groupTitle: 'Test' })] }), []);
    assert.deepEqual(run([lead({ clientMasterItemId: 't3' })], { items: [item({ id: 't3', name: 'TEST CLIENT - E2E 1790000000000' })] }), []);
    // NOT the other two groups that are not live cases: a client whose case row was moved to "Cancel / Did not retained",
    // or is kept in "Leads", is still on the Follow-Up tab of Retainers & follow-ups — and is the person to call back
    for (const [group, groupTitle] of [['group_mm3b9tap', 'Cancel /Did not retained'], ['group_mm2tz8e1', 'Leads'], ['group_remade', 'Cancel / Did not retained'], ['group_remade2', 'Leads']]) {
      const row = item({ id: 'c1', group, groupTitle });
      assert.equal(require('../src/utils/caseGroups').isCaseGroup({ id: group, title: groupTitle }), false, `${groupTitle}: not a live-case group`);
      for (const l of [lead({ clientMasterItemId: 'c1' }), lead({ clientMasterItemId: 'c1', retainerSent: '2026-11-10', retainerSigned: '2026-11-11' })]) {
        assert.equal(portal.retainerTab(l), 'Follow-Up', 'the Retainers page has this client under Follow-Up');
        const out = run([l], { items: [row] });
        assert.deepEqual(out.map((e) => [e.kind, e.client, e.followUpDate]), [['followup-due', 'Dana Example', '2026-11-20']], `${groupTitle}: listed`);
        assert.deepEqual([out[0].rows, out[0].itemIds, out[0].caseRef, out[0].stage, out[0].payment], [[], [], '', '', ''], 'still about the client record alone — nothing of the case row');
      }
      assert.deepEqual(run([lead({ clientMasterItemId: 'c1', followUpDate: '' })], { items: [row] }).map((e) => e.kind), ['followup-no-date']);
      assert.deepEqual(run([lead({ clientMasterItemId: 'c1', followUpDate: '' })], { items: [row], needsDate: false }), [], 'the switch still decides the no-date line');
    }
    // the same key as without the case row: a handled mark is not lost when the row is moved to another group
    assert.equal(run([lead({ clientMasterItemId: 'c1' })], { items: [item({ id: 'c1', group: 'group_mm3b9tap', groupTitle: 'Cancel /Did not retained' })] })[0].key, run([lead()])[0].key);
    // the rule beside it keeps its own: a payment without a signed date on a cancelled case is still not listed
    const paid = { id: 'P1', fullName: 'Paid Person', outcome: 'Retain', followUpDate: '', retainerPaid: '2026-11-10', retainerSigned: '', retainerSent: '', clientMasterItemId: 'c1', caseDeleted: '' };
    assert.deepEqual(NA.detect({ cases: [item({ id: 'c1', group: 'group_mm3b9tap', groupTitle: 'Cancel /Did not retained' })].map(NA.parseCase), leads: [paid], now: NOW }).map((e) => e.kind), []);
    const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
    assert.ok(src.includes('if (c && (isTestGroup({ id: c.groupId, title: c.groupTitle }) || TEST_NAME_RE.test(c.name))) continue;'), 'the TEST group alone, by the shared helper');
    // a live case, or a case that is not on the board any more, changes nothing: still a line about the client record alone
    const [onCase] = run([lead({ clientMasterItemId: 'live1' })], { items: [item({ id: 'live1', ref: '2026-SV-077', stage: 'Internal Review' })] });
    assert.deepEqual([onCase.kind, onCase.rows, onCase.itemIds, onCase.caseRef, onCase.stage], ['followup-due', [], [], '', '']);
    assert.equal(run([lead({ clientMasterItemId: 'gone' })]).length, 1);
    // rows that are no record at all
    assert.deepEqual(run([null, undefined, lead({ id: '' })]), []);
  });
});

test('only the outcome Follow-Up: a date on a Newsletter, Not Wanted, Retain, Webinar or undecided client is never listed', async () => {
  await switchOn(async () => {
    for (const outcome of ['Newsletter', 'Not Wanted', 'Retain', '', 'Follow-up', 'follow-up', 'Followup', 'Don’t Retain — Not Wanted', 'Something else']) {
      assert.deepEqual(run([lead({ outcome })]), [], `"${outcome}" with a passed date`);
      assert.deepEqual(run([lead({ outcome, followUpDate: '' })]), [], `"${outcome}" with no date`);
    }
    // Webinar: the lead reader takes it off `outcome` (lead.webinar = 'Yes'), so it is never a Follow-Up
    const leadService = require('../src/services/leadService');
    const COLS = require('../src/data/newLeadsBoard.json').columns;
    const webinar = leadService.parseItem({ id: 'W1', name: 'Webinar Person', column_values: [
      { id: COLS.outcome, text: 'Webinar', value: JSON.stringify({ index: 9, changed_at: '2026-11-12T10:00:00Z' }) },
      { id: COLS.followUpDate, text: '2026-11-15', value: '{"date":"2026-11-15"}' }] });
    assert.deepEqual([webinar.outcome, webinar.webinar, webinar.followUpDate], ['', 'Yes', '2026-11-15']);
    assert.deepEqual(run([webinar]), []);
    // …and the same reader's Follow-Up row IS listed (the shape the shared lead list really carries)
    const real = leadService.parseItem({ id: 'F1', name: 'Followup Person', column_values: [
      { id: COLS.outcome, text: 'Follow-Up', value: JSON.stringify({ index: 1, changed_at: '2026-11-12T10:00:00Z' }) },
      { id: COLS.followUpDate, text: '2026-11-15', value: '{"date":"2026-11-15"}' }] });
    assert.deepEqual(run([real]).map((e) => [e.kind, e.client, e.leadId, e.followUpDate]), [['followup-due', 'Followup Person', 'F1', '2026-11-15']]);
  });
});

test('the old label that reads as Follow-Up is listed like Follow-Up', async () => {
  const OLD = 'Don’t Retain — Ineligible';
  assert.equal(outcomes.canonicalOutcome(OLD), 'Follow-Up');
  await switchOn(async () => {
    assert.deepEqual(run([lead({ outcome: OLD })]).map((e) => e.kind), ['followup-due']);
    assert.match(run([lead({ outcome: OLD })])[0].why, /^Follow-up date passed \(20 Nov\): Dana Example /);
    assert.deepEqual(run([lead({ outcome: OLD, followUpDate: '' })]).map((e) => e.kind), ['followup-no-date']);
    assert.deepEqual(run([lead({ outcome: OLD, followUpDate: TODAY })]), []);
  });
  await switchOff(async () => assert.deepEqual(run([lead({ outcome: OLD, followUpDate: '' })]), []));
});

test('one line per client record, keyed on the record and the date: a new date is a new line, the same date the same line', async () => {
  await switchOn(async () => {
    const [a] = run([lead()]);
    assert.equal(run([lead()])[0].key, a.key, 'the same record and date: the same line (a handled mark keeps covering it)');
    assert.equal(run([lead({ fullName: 'Dana E. Example', leadOwner: 'Someone Else', outcome: 'Don’t Retain — Ineligible' })])[0].key, a.key, 'the key is the record and the date, not the name or the label');
    const [later] = run([lead({ followUpDate: '2026-11-21' })]);
    assert.notEqual(later.key, a.key, 'a new date that is missed in turn is a new line');
    const [other] = run([lead({ id: 'L2' })]);
    assert.notEqual(other.key, a.key, 'another client with the same date');
    const [none] = run([lead({ followUpDate: '' })]);
    assert.notEqual(none.key, a.key);
    assert.equal(run([lead({ followUpDate: '', outcomeChangedAt: '2026-11-01T10:00:00Z' })])[0].key, none.key, 'no date: one line per record, whenever the outcome was set');
    // the date moved to a later day, or the outcome changed: the line is gone at the next check by itself
    assert.deepEqual(run([lead({ followUpDate: TOMORROW })]), []);
    assert.deepEqual(run([lead({ outcome: 'Newsletter' })]), []);
    assert.deepEqual(run([lead({ followUpDate: '', outcome: 'Not Wanted' })]), []);
    // never two lines for one record, never both kinds for one record
    assert.equal(run([lead(), lead()]).length, 1);
    assert.equal(run([lead(), lead({ followUpDate: '' })]).length, 1);
    // two records, two lines
    assert.deepEqual(run([lead({ id: 'L1' }), lead({ id: 'L2', fullName: 'Robin Example', followUpDate: '' })]).map((e) => [e.kind, e.client]), [['followup-due', 'Dana Example'], ['followup-no-date', 'Robin Example']]);
  });
});

// ── Toronto day ─────────────────────────────────────────────────────────────

test('the day is the Toronto day: at 23:30 the date of that day has not passed; half an hour later it has — also across both clock changes', () => {
  const at = (date, when) => run([lead({ followUpDate: date })], { now: Date.parse(when), needsDate: false }).length;
  // an ordinary night (EST, UTC-5): 23:30 on 20 November is 04:30 UTC on the 21st
  assert.equal(at('2026-11-20', '2026-11-21T04:30:00Z'), 0, '23:30 Toronto on the day itself');
  assert.equal(at('2026-11-19', '2026-11-21T04:30:00Z'), 1, 'the day before has passed');
  assert.equal(at('2026-11-20', '2026-11-21T05:30:00Z'), 1, '00:30 the next day');
  assert.equal(at('2026-11-21', '2026-11-21T05:30:00Z'), 0);
  // the 07:00 check (12:00 UTC in winter)
  assert.equal(at('2026-11-20', '2026-11-20T12:00:30Z'), 0, 'on the morning of the day: today\'s call');
  assert.equal(at('2026-11-20', '2026-11-21T12:00:30Z'), 1, 'the next morning\'s list');
  // clocks go back on Sunday 1 November 2026 (EDT, UTC-4 → EST, UTC-5)
  assert.equal(at('2026-10-31', '2026-11-01T03:30:00Z'), 0, '23:30 EDT on 31 October');
  assert.equal(at('2026-10-31', '2026-11-01T04:30:00Z'), 1, '00:30 EDT on 1 November');
  assert.equal(at('2026-11-01', '2026-11-02T04:30:00Z'), 0, '23:30 EST on 1 November — the 25-hour day is still that day');
  assert.equal(at('2026-11-01', '2026-11-02T05:30:00Z'), 1, '00:30 EST on 2 November');
  // clocks go forward on Sunday 14 March 2027 (EST → EDT)
  assert.equal(at('2027-03-13', '2027-03-14T04:30:00Z'), 0, '23:30 EST on 13 March');
  assert.equal(at('2027-03-13', '2027-03-14T05:30:00Z'), 1, '00:30 EST on 14 March');
  assert.equal(at('2027-03-14', '2027-03-15T03:30:00Z'), 0, '23:30 EDT on 14 March — the 23-hour day is still that day');
  assert.equal(at('2027-03-14', '2027-03-15T04:30:00Z'), 1, '00:30 EDT on 15 March');
});

// ── The check: one shared read, "handled", what could not be checked ────────

test('the check reads the shared lead list (never a board read of its own) and the notes of the listed records only', async () => {
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.equal(src.split("require('./leadSnapshot')").length - 1, 2, 'the shared lead list — the seam the paid-not-signed rule already had — and the question "is this an older copy?"; nothing else');
  assert.ok(src.includes("leads: () => require('./leadSnapshot').leads(),"));
  assert.ok(src.includes("leadsOldCopyAt: (list) => require('./leadSnapshot').servedStale(list),"));
  assert.ok(require('../src/services/leadSnapshot').SNAPSHOT_KEYS.includes('followUpDate') && require('../src/services/leadSnapshot').SNAPSHOT_KEYS.includes('outcome') && require('../src/services/leadSnapshot').SNAPSHOT_KEYS.includes('conversionStatus'), 'the list carries what the rule reads');
  await switchOff(async () => {
    const calls = harness({ leads: () => [lead({ id: 'L1' }), lead({ id: 'L2', followUpDate: TOMORROW }), lead({ id: 'L3', outcome: 'Newsletter' })] });
    const snap = await NA.buildSnapshot();
    assert.deepEqual(snap.entries.map((e) => [e.kind, e.leadId]), [['followup-due', 'L1']]);
    assert.deepEqual([snap.partial, snap.partialAlso], [[], []]);
    assert.deepEqual(calls.deep, [['L1']], 'only the listed record\'s notes are read (for a "handled" note)');
    assert.equal(calls.notes.length, 0, 'a check never writes');
  });
});

test('many follow-up lines: ONE notes read for all the listed records — 10 records a query, three queries at a time, never one after another; a failed query costs only its own ten', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const realQuery = mondayApi.query;
  const many = Array.from({ length: 25 }, (_, i) => lead({ id: `L${i + 1}`, fullName: `Person ${i + 1}` }));
  const allIds = many.map((l) => l.id);
  try {
    await switchOff(async () => {
      // 1. what the check asks for: every listed record in ONE call, to be read three queries at a time
      harness({ leads: () => many });
      const asked = [];
      NA.io.readDeepNotes = async (ids, opts) => { asked.push([ids, opts]); return { notes: new Map(), failed: [] }; };
      let snap = await NA.buildSnapshot();
      assert.equal(snap.entries.length, 25);
      assert.deepEqual(asked, [[allIds, { parallel: 3 }]]);
      const l3 = snap.entries.find((e) => e.leadId === 'L3');

      // 2. the real read, with Monday replaced by a counter: 3 queries (10 + 10 + 5), all three under way together
      NA.io.readDeepNotes = REAL_IO.readDeepNotes;
      let running = 0, most = 0, queries = [];
      mondayApi.query = async (q, vars) => {
        running++; most = Math.max(most, running); queries.push({ q, ids: vars.ids });
        await new Promise((r) => setImmediate(r));
        running--;
        if (vars.ids.includes('L11')) throw new Error('Monday could not answer');
        return { items: vars.ids.map((id) => ({ id, updates: id === 'L3' ? [asNote(NA.handledNoteBody(l3, 'Retainer Person'))] : [] })) };
      };
      snap = await NA.buildSnapshot();
      assert.deepEqual(queries.map((x) => x.ids), [allIds.slice(0, 10), allIds.slice(10, 20), allIds.slice(20)], 'one query per 10 listed records');
      assert.equal(most, 3, 'the three queries run together');
      for (const x of queries) assert.match(x.q, /^query\(\$ids:\[ID!\]\)\{ items\(ids:\$ids, limit:(10|5)\)\{ id updates\(limit:200\)\{ id created_at text_body \} \} \}$/, 'the notes only — no column of the record — and as far back as for a case');
      assert.deepEqual([snap.entries.length, snap.handledCount], [24, 1], 'the handled note is found');
      assert.ok(!snap.entries.some((e) => e.leadId === 'L3'));
      assert.equal(snap.entries.filter((e) => allIds.slice(10, 20).includes(e.leadId)).length, 10, 'the ten whose notes could not be read still show');
      assert.deepEqual(snap.partial, ['Notes on 10 client records could not be read, so an item marked handled may show again.']);

      // 3. a caller that does not ask for it reads one query after another, as before (the cases' older notes)
      running = 0; most = 0; queries = [];
      const r = await REAL_IO.readDeepNotes(allIds);
      assert.deepEqual([queries.length, most, r.failed.length, r.notes.size], [3, 1, 10, 15]);
      for (const odd of [0, -2, 'x', null]) { most = 0; await REAL_IO.readDeepNotes(allIds, { parallel: odd }); assert.equal(most, 1, `parallel ${odd}: one at a time`); }
      // a list that fits one query is one query
      queries = [];
      await REAL_IO.readDeepNotes(['L1', 'L2'], { parallel: 3 });
      assert.deepEqual(queries.map((x) => x.ids), [['L1', 'L2']]);
      queries = [];
      assert.deepEqual(await REAL_IO.readDeepNotes([], { parallel: 3 }), { notes: new Map(), failed: [] });
      assert.equal(queries.length, 0);
    });
    const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
    assert.ok(src.includes('const LEAD_NOTES_PARALLEL = 3;'));
    assert.ok(src.includes('await io.readDeepNotes(leadOnly, { parallel: LEAD_NOTES_PARALLEL });'));
    assert.ok(src.includes('const needDeep = cases.filter') && src.includes('await io.readDeepNotes(needDeep);') && src.includes('await io.readDeepNotes(deep);'), 'the cases\' own reads are as they were');
  } finally { mondayApi.query = realQuery; }
});

test('Mark handled: a note on the CLIENT RECORD naming the date; it hides that date only — a later missed date shows again', async () => {
  await switchOff(async () => {
    const deep = new Map();
    let leads = [lead()];
    const calls = harness({ leads: () => leads, deep });
    let snap = await NA.refresh();
    assert.equal(snap.entries.length, 1);
    const key = snap.entries[0].key;
    assert.deepEqual(await NA.markHandled({ key, viewer: ADMIN, actor: 'Retainer Person' }), { ok: true });
    assert.equal(calls.notes.length, 1, 'one note');
    assert.equal(calls.notes[0].itemId, 'L1', 'on the client\'s record (the Lead Board row) — there is no case row');
    assert.match(calls.notes[0].body, /Marked as handled<\/b> on the Summary page by Retainer Person — .* \(Toronto\)\. Item: Follow-up date passed \(2026-11-20\)\. It stays off the "Needs attention" list unless the problem comes back\. Ref NA-[0-9a-f]{10}$/);
    assert.ok(calls.notes[0].body.endsWith(`Ref ${key}`));
    assert.ok(!calls.notes[0].body.includes('Dana'), 'the note needs no name: it is on the record');
    assert.equal(NA.view(ADMIN).entries.length, 0, 'off the list at once');
    assert.equal(NA.view(LIMITED).entries.length, 0, '…for everybody');
    assert.deepEqual(await NA.markHandled({ key, viewer: ADMIN, actor: 'x' }), { ok: true, already: true });
    assert.equal(calls.notes.length, 1, 'no second note');

    // the next check reads the note back from the record: still off
    deep.set('L1', [asNote(calls.notes[0].body)]);
    NA._resetForTests();
    snap = await NA.refresh();
    assert.deepEqual([snap.entries.length, snap.handledCount], [0, 1]);

    // a new date is set and missed in turn: a NEW line, although the old date's note is still on the record
    leads = [lead({ followUpDate: '2026-11-22' })];
    NA._resetForTests();
    snap = await NA.refresh();
    assert.deepEqual(snap.entries.map((e) => [e.kind, e.followUpDate]), [['followup-due', '2026-11-22']]);
    assert.equal(snap.handledCount, 0);
    assert.notEqual(snap.entries[0].key, key);

    // the date moved back to the handled one: handled again (the mark covers exactly that date)
    leads = [lead()];
    NA._resetForTests();
    snap = await NA.refresh();
    assert.deepEqual([snap.entries.length, snap.handledCount], [0, 1]);
  });

  // a "no date" line is handled the same way, and the mark does not hide a date that is later set and missed
  await switchOn(async () => {
    const deep = new Map();
    let leads = [lead({ followUpDate: '' })];
    const calls = harness({ leads: () => leads, deep });
    NA._resetForTests();
    let snap = await NA.refresh();
    assert.deepEqual(snap.entries.map((e) => e.kind), ['followup-no-date']);
    assert.deepEqual(await NA.markHandled({ key: snap.entries[0].key, viewer: SEES_ALL, actor: 'Staff Person' }), { ok: true }, 'staff who see every case may mark it too');
    assert.equal(calls.notes[0].itemId, 'L1');
    assert.match(calls.notes[0].body, /Item: Follow-Up with no follow-up date\. It stays off/);
    deep.set('L1', [asNote(calls.notes[0].body)]);
    NA._resetForTests();
    snap = await NA.refresh();
    assert.deepEqual([snap.entries.length, snap.handledCount], [0, 1]);
    leads = [lead({ followUpDate: YESTERDAY })];
    NA._resetForTests();
    snap = await NA.refresh();
    assert.deepEqual(snap.entries.map((e) => e.kind), ['followup-due']);
  });
});

test('the handled notes for these lines read as none of the app\'s own notes — on a case or on a client record', () => {
  const resume = require('../src/services/onboardingResumeService');
  const leadStatus = require('../src/services/leadStatusService');
  for (const kind of FU_KINDS) {
    const entry = { key: 'NA-0123456789', kind, caseRef: '', itemIds: [], rows: [], leadId: 'L1', followUpDate: kind === 'followup-due' ? '2026-11-20' : undefined };
    const body = NA.handledNoteBody(entry, 'Staff <b>Person</b>');
    assert.ok(body.includes(`Item: ${NA.CLIENT_KINDS[kind].label}`), 'the line\'s own name, not its key');
    assert.ok(!body.includes('<b>Person</b>'), 'the name is escaped');
    const plain = body.replace(/<[^>]+>/g, '');
    assert.deepEqual([...NA.handledKeys(NA.caseNotes([{ id: 'x', created_at: new Date(NOW).toISOString(), text_body: plain }]))], ['NA-0123456789'], 'read back by its key');
    for (const [name, re] of Object.entries(NA.NOTE)) if (name !== 'handled') assert.ok(!re.test(plain) && !re.test(body), `${kind}: must not read as "${name}"`);
    const r = resume.readNotes([{ created_at: new Date(NOW).toISOString(), text_body: plain, body }]);
    assert.deepEqual([r.heldAt, r.resumedAt, r.evidence], [0, 0, []], `${kind}: no onboarding evidence`);
    assert.equal(NA.newestPaymentNote(NA.caseNotes([{ id: 'y', created_at: new Date(NOW).toISOString(), text_body: plain }])), null);
    // on the Lead Board: not a booking invite, a reminder, a Webinar email or a remark
    assert.equal(leadStatus.classify(plain).kind, '', `${kind}: nothing the Leads list's "Current status" reads`);
    assert.ok(!/checklist-blocked|tdot-onb-report|Conversation history imported|Document Uploaded by Client|post-consult-nudge|Booking invite|Webinar email sent/i.test(body));
  }
});

test('the lead list cannot be read: nothing is invented, the rest of the check runs, and the page is told follow-up dates were not checked', async () => {
  harness({ leads: () => { throw new Error('the Lead Board could not be read'); } });
  const snap = await NA.refresh();
  assert.deepEqual(snap.entries, []);
  assert.deepEqual(snap.partial, ['The client records could not be checked for a payment without a signed date (the Lead Board could not be read).'], 'the line the failed read always had, word for word');
  assert.deepEqual(snap.partialAlso, ['Follow-up dates could not be checked either, so a missed follow-up may be missing from the list.']);
  for (const viewer of [ADMIN, SEES_ALL, LIMITED]) {
    assert.deepEqual(NA.view(viewer).partial, [
      'The client records could not be checked for a payment without a signed date (the Lead Board could not be read).',
      'Follow-up dates could not be checked either, so a missed follow-up may be missing from the list.',
    ], 'the page shows both, in this order');
  }
  // a later good check: both lines are gone
  harness({ leads: () => [lead()] });
  NA._resetForTests();
  await switchOff(async () => { await NA.refresh(); });
  assert.deepEqual(NA.view(ADMIN).partial, []);
  assert.equal(NA.view(ADMIN).entries.length, 1);
});

test('the Lead Board cannot be RE-read and the shared list hands out an older copy: the lines are worked out from it, and the page is told — never a list that reads as checked', async () => {
  const shared = require('../src/services/leadSnapshot');
  const real = { fetchLeads: shared.io.fetchLeads, now: shared.io.now, warn: console.warn, log: console.log };
  const OLD = 'The client records could not be read just now, so an older copy (from 22 Nov 2026, 10:00 pm) was used: a payment without a signed date or a follow-up date changed since then may be missing, or still listed.';
  const down = async () => { throw new Error('the Lead Board could not be read'); };
  console.warn = () => {}; console.log = () => {};
  try {
    harness();
    NA.io.leads = REAL_IO.leads;                       // the real shared list; its board read is the stand-in below
    assert.equal(NA.io.leadsOldCopyAt, REAL_IO.leadsOldCopyAt);
    shared._reset();
    await switchOff(async () => {
      // a good read at 22:00 the evening before
      shared.io.now = () => NOW - 12 * H;
      shared.io.fetchLeads = async () => [lead()];
      let snap = await NA.buildSnapshot();
      assert.deepEqual([snap.entries.map((e) => e.kind), snap.partial, snap.partialAlso], [['followup-due'], [], []], 'a current list: nothing is said');

      // the morning check: the board cannot be read — the old copy is used, and the page says so
      shared.io.now = () => NOW;
      shared.io.fetchLeads = down;
      snap = await NA.refresh();
      assert.deepEqual(snap.entries.map((e) => [e.kind, e.leadId]), [['followup-due', 'L1']], 'the old list is better than none');
      assert.deepEqual([snap.partial, snap.partialAlso], [[OLD], []]);
      for (const viewer of [ADMIN, SEES_ALL, LIMITED]) assert.deepEqual(NA.view(viewer).partial, [OLD], 'everybody who sees the lines is told');
      // still down at the next check: said again
      assert.deepEqual((await NA.buildSnapshot()).partial, [OLD]);

      // the board reads again: the new list, and the sentence is gone
      shared.io.fetchLeads = async () => [lead({ followUpDate: TOMORROW })];
      snap = await NA.buildSnapshot();
      assert.deepEqual([snap.entries, snap.partial, snap.partialAlso], [[], [], []]);

      // a copy a few minutes old is a current list (any list may be a few minutes behind): nothing is said, even if the read behind it fails
      shared.io.now = () => NOW + 5 * 60 * 1000;
      shared.io.fetchLeads = down;
      snap = await NA.buildSnapshot();
      assert.deepEqual([snap.entries, snap.partial], [[], []]);
      await new Promise((r) => setImmediate(r));

      // no copy at all and no read: the two sentences this always had — nothing invented
      shared._reset();
      snap = await NA.buildSnapshot();
      assert.deepEqual(snap.entries, []);
      assert.deepEqual(snap.partial, ['The client records could not be checked for a payment without a signed date (the Lead Board could not be read).']);
      assert.deepEqual(snap.partialAlso, ['Follow-up dates could not be checked either, so a missed follow-up may be missing from the list.']);
    });
    // the question itself: only a list handed out after a FAILED re-read, and when that list was read
    for (const none of [[], [lead()], null, undefined, 'x', 0]) assert.equal(shared.servedStale(none), 0);
    shared._reset();
    shared.io.now = () => NOW - 12 * H;
    shared.io.fetchLeads = async () => [lead()];
    const first = await shared.getLeadSnapshot();
    assert.equal(shared.servedStale(first.leads), 0);
    shared.io.now = () => NOW;
    shared.io.fetchLeads = down;
    const second = await shared.getLeadSnapshot();
    assert.deepEqual([second.stale, second.leads === first.leads, shared.servedStale(second.leads)], [true, true, NOW - 12 * H]);
    assert.equal(await shared.leads(), first.leads, 'leads() hands out the same list — the caller asks servedStale about it');
    // a list given by a test stand-in (or any other list) is never called old
    harness({ leads: () => [lead()] });
    assert.deepEqual((await switchOff(() => NA.buildSnapshot())).partial, []);
  } finally {
    shared.io.fetchLeads = real.fetchLeads; shared.io.now = real.now; console.warn = real.warn; console.log = real.log;
    shared._reset();
  }
});

test('the record\'s notes cannot be read: the line shows (a handled mark may be missed), and the page says so', async () => {
  await switchOff(async () => {
    harness({ leads: () => [lead({ id: 'L1' }), lead({ id: 'L2' })], deepFail: ['L2'] });
    const snap = await NA.buildSnapshot();
    assert.deepEqual(snap.entries.map((e) => e.leadId), ['L1', 'L2']);
    assert.match(snap.partial.join(' '), /^Notes on 1 client record could not be read, so an item marked handled may show again\.$/);
  });
});

// ── Who sees it ─────────────────────────────────────────────────────────────

test('EVERY signed-in staff member sees the follow-up lines — and only those: every other line keeps its own rule', async () => {
  const prevVis = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    await switchOn(async () => {
      harness({
        items: () => [
          // one case number on two cases: the limited viewer is assigned to the first only
          item({ id: 'mine', name: 'Mine Person', ref: '2026-SV-090', people: [{ id: 77, kind: 'person' }] }),
          item({ id: 'theirs', name: 'Other Person', ref: '2026-SV-090', people: [{ id: 99, kind: 'person' }] }),
        ],
        leads: () => [
          lead({ id: 'L1' }),                                                          // follow-up date passed
          lead({ id: 'L2', fullName: 'Robin Example', followUpDate: '' }),             // no date (switch on)
          { id: 'L3', fullName: 'Paid Person', outcome: 'Retain', followUpDate: '', retainerPaid: '2026-11-10', retainerSigned: '', retainerSent: '', clientMasterItemId: '', caseDeleted: '' },   // paid, no signed date — a line about a client record that is NOT for everybody
        ],
        templates: () => [{ row: 'Reminder 2', reason: 'no {MissingList}', board: false }],   // a line about no case at all
      });
      const snap = await NA.refresh();
      assert.deepEqual(snap.entries.map((e) => e.kind).sort(), ['followup-due', 'followup-no-date', 'paid-not-signed', 'ref-duplicate', 'reminder-template-invalid']);

      // an admin (or the team key) and staff who see every case: everything, with Mark handled
      for (const viewer of [ADMIN, SEES_ALL]) {
        for (const opensRecords of [true, false]) {
          const all = NA.view(viewer, { opensRecords }).entries;
          assert.equal(all.length, 5);
          for (const e of all) assert.ok(!('noHandle' in e), `${e.kind}: Mark handled is offered`);
        }
      }

      // a viewer limited to their own cases
      const mine = NA.view(LIMITED).entries;
      assert.deepEqual(mine.map((e) => e.kind).sort(), ['followup-due', 'followup-no-date', 'ref-duplicate'], 'the two follow-up lines and their own case — not the other client-record line, not the templates line');
      const due = mine.find((e) => e.kind === 'followup-due'), none = mine.find((e) => e.kind === 'followup-no-date');
      assert.deepEqual([due.client, due.leadId, due.linkLabel, due.noHandle], ['Dana Example', 'L1', 'Client record', true]);
      assert.deepEqual([none.client, none.leadId, none.linkLabel, none.noHandle], ['Robin Example', 'L2', 'Client record', true]);
      assert.ok(!('link' in due) && !('link' in none), 'no link: the record page opens with the team key only, and this viewer has none');
      assert.ok(!JSON.stringify(mine.filter((e) => FU_KINDS.includes(e.kind))).includes('/admin/consultation/'));
      assert.equal(due.why, 'Follow-up date passed (20 Nov): Dana Example was to be called back on that day. The outcome is still Follow-Up.', 'the name and the date, on purpose');
      assert.equal(due.todo, 'Tell the person who does the retainers. They call Dana Example back, then set a new follow-up date or change the outcome on the client\'s record; the line leaves this list at the next check after that (07:00, or Check now).');
      assert.equal(none.todo, 'Tell the person who does the retainers, or the consultant. They choose the day to call Robin Example back, or change the outcome, on the client\'s record; the line leaves this list at the next check after that (07:00, or Check now).');
      for (const e of [due, none]) assert.ok(!/open the client's record|Save attribution|Record outcome/.test(e.todo), 'never sent to a page they cannot open');
      for (const e of [due, none]) {
        assert.deepEqual(Object.keys(e).filter((k) => !['key', 'kind', 'itemIds', 'caseRef', 'client', 'stage', 'payment', 'manager', 'since', 'why', 'todo', 'leadId', 'link', 'linkLabel', 'followUpDate', 'noHandle'].includes(k)), [], 'no other field');
        assert.ok(!('rows' in e) && !('assignees' in e));
        const sent = JSON.stringify(e);
        for (const secret of ['4321', 'Owner Person', 'Consultant Person', 'Website', '11:00', 'hasEmail']) assert.ok(!sent.includes(secret), `${secret} is not sent`);
      }
      // the item that spans two cases still names only their own
      const dup = mine.find((e) => e.kind === 'ref-duplicate');
      assert.deepEqual([dup.client, dup.itemIds], ['Mine Person', ['mine']]);
      assert.ok(!JSON.stringify(mine).includes('Other Person'), 'never the other client');
      assert.ok(!JSON.stringify(mine).includes('Paid Person'), 'never the client of a line they may not see');

      // The link to the client's record follows the TAB, not the person: it is sent only when the request came with
      // the team key (the only thing that opens the record page). A Monday sign-in alone — an admin by email, or staff
      // who see every case — gets the line with Mark handled, no link, and words they can act on.
      for (const viewer of [ADMIN, SEES_ALL]) {
        const withKey = NA.view(viewer, { opensRecords: true }).entries.find((e) => e.kind === 'followup-due');
        assert.deepEqual([withKey.link, withKey.linkLabel], ['/admin/consultation/L1?from=retainers', 'Client record']);
        assert.match(withKey.todo, /^Call Dana Example back, then set a new follow-up date or change the outcome: open the client's record — /);
        for (const opts of [undefined, {}, { opensRecords: false }, { ensure: false }]) {
          const noKey = NA.view(viewer, opts).entries.filter((e) => FU_KINDS.includes(e.kind));
          assert.equal(noKey.length, 2);
          for (const e of noKey) {
            assert.ok(!('link' in e) && !('noHandle' in e) && e.linkLabel === 'Client record', 'no link, the label, Mark handled');
            assert.match(e.todo, /^Tell the person who does the retainers/);
          }
        }
      }
      // …and the team key never widens what a limited viewer sees or may do (it cannot happen — the key makes an admin — but the rule holds by itself)
      const odd = NA.view(LIMITED, { opensRecords: true }).entries;
      assert.deepEqual(odd.map((e) => e.kind).sort(), ['followup-due', 'followup-no-date', 'ref-duplicate']);
      assert.ok(odd.filter((e) => FU_KINDS.includes(e.kind)).every((e) => e.noHandle === true));
      // every other line is the same with or without the key: only the follow-up lines change
      for (const viewer of [ADMIN, SEES_ALL, LIMITED]) {
        const rest = (o) => NA.view(viewer, o).entries.filter((e) => !FU_KINDS.includes(e.kind));
        assert.deepEqual(rest({ opensRecords: true }), rest({ opensRecords: false }));
      }
      assert.equal(NA.view(ADMIN, { opensRecords: false }).entries.find((e) => e.kind === 'paid-not-signed').link, '/admin/consultation/L3?from=retainers', 'the other client-record line is sent as it always was');

      // someone assigned to no case at all still sees the two follow-up lines, and nothing else
      assert.deepEqual(NA.view({ userId: '1', teamIds: [], isAdmin: false, scope: 'assigned' }).entries.map((e) => e.kind).sort(), ['followup-due', 'followup-no-date']);
      // nobody signed in: nothing
      assert.deepEqual(NA.view(null).entries, []);
      assert.deepEqual(NA.view(undefined).entries, []);
    });
  } finally { if (prevVis === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prevVis; }
});

test('a viewer limited to their own cases cannot mark a follow-up line handled: refused in plain words, nothing written, the line stays', async () => {
  await switchOn(async () => {
    const calls = harness({ leads: () => [lead({ id: 'L1' }), lead({ id: 'L2', followUpDate: '' }), { id: 'L3', fullName: 'Paid Person', outcome: 'Retain', followUpDate: '', retainerPaid: '2026-11-10', retainerSigned: '', retainerSent: '', clientMasterItemId: '', caseDeleted: '' }] });
    const snap = await NA.refresh();
    const byKind = (k) => snap.entries.find((e) => e.kind === k);
    for (const kind of FU_KINDS) {
      await assert.rejects(NA.markHandled({ key: byKind(kind).key, viewer: LIMITED, actor: 'Limited Person' }),
        (e) => e.status === 403 && e.message === 'Only an admin, or staff who see every case, can mark this handled. It leaves the list by itself once a new follow-up date is set or the outcome is changed.');
    }
    // the other client-record line keeps its own answer for such a viewer: "not on the list" (they never saw it)
    await assert.rejects(NA.markHandled({ key: byKind('paid-not-signed').key, viewer: LIMITED, actor: 'x' }), (e) => e.status === 404);
    // nobody signed in: not on the list
    await assert.rejects(NA.markHandled({ key: byKind('followup-due').key, viewer: null, actor: 'x' }), (e) => e.status === 404);
    assert.equal(calls.notes.length, 0, 'nothing was written');
    assert.equal(NA.view(LIMITED).entries.length, 2, 'both lines are still there');
    assert.equal(NA.view(ADMIN).entries.length, 3);
    // an admin still can
    assert.deepEqual(await NA.markHandled({ key: byKind('followup-due').key, viewer: ADMIN, actor: 'Admin' }), { ok: true });
    assert.deepEqual(calls.notes.map((n) => n.itemId), ['L1']);
  });
});

test('the table: two kinds of their own, "To do", after the other To-do lines; the kinds every case line uses are untouched', () => {
  assert.deepEqual(NA.CLIENT_KINDS, {
    'followup-due':     { order: 67, severity: 'medium', label: 'Follow-up date passed' },
    'followup-no-date': { order: 68, severity: 'medium', label: 'Follow-Up with no follow-up date' },
  });
  for (const k of FU_KINDS) assert.ok(!(k in NA.KINDS), `${k} is not a case kind`);
  const taken = Object.values(NA.KINDS).map((k) => k.order);
  for (const k of FU_KINDS) assert.ok(!taken.includes(NA.CLIENT_KINDS[k].order), `${k}: an order of its own`);
  const labels = Object.values(NA.KINDS).map((k) => k.label);
  for (const k of FU_KINDS) assert.ok(!labels.includes(NA.CLIENT_KINDS[k].label));
  // what the page is sent: both tables, so it can name and order every group
  const sent = NA.view(ADMIN).kinds;
  assert.deepEqual(Object.keys(sent).sort(), [...Object.keys(NA.KINDS), ...FU_KINDS].sort());
  for (const k of Object.keys(NA.KINDS)) assert.deepEqual(sent[k], NA.KINDS[k]);
  for (const k of FU_KINDS) assert.deepEqual(sent[k], NA.CLIENT_KINDS[k]);
  // the visibility rule is the table: no other kind is shown to a limited viewer without a case row
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.ok(src.includes('const isForAllStaff = (entry) => !!(entry && CLIENT_KINDS[entry.kind] && !entry.rows.length);'));
  assert.ok(src.includes("const shaped = seesEveryCase(viewer) ? out : { ...out, noHandle: true };"));
  assert.ok(src.includes('if (opensRecords) return shaped;'), 'the link only for a tab that opens the record page');
  assert.ok(src.includes('function shapeFor(entry, viewer, { opensRecords = false } = {}) {') && src.includes('function view(viewer, { ensure = false, opensRecords = false } = {}) {'), 'no link unless the route says the tab can open it');
});

// OPEN ITEM (review 2026-11-23) — a "todo" test: it does NOT pass today and does not fail the suite; it is
// here so the open item shows in every test run instead of only in a comment. Every group staff can see under
// "Needs attention" is to be explained in the staff guide; test/needsAttention.test.js checks that for KINDS,
// and the two follow-up groups sit in CLIENT_KINDS, outside that check, until the guide has them (the guide's
// data file is rebuilt, not edited by hand). At the next guide rebuild: add the two entries, see this pass,
// then widen the guide check to { ...NA.KINDS, ...NA.CLIENT_KINDS } and delete this test.
test('OPEN ITEM — the staff guide explains the two follow-up groups (they come with the next guide rebuild)', { todo: 'add "Follow-up date passed" and "Follow-Up with no follow-up date" to the guide\'s Needs-attention table at the next guide rebuild' }, () => {
  const guide = JSON.parse(fs.readFileSync(require.resolve('../src/staffGuide/guide-data.json'), 'utf8'));
  for (const k of FU_KINDS) assert.ok(guide.needs_attention.some((e) => e.problem === NA.CLIENT_KINDS[k].label), `guide entry for ${k}`);
});

// ── The Summary page ────────────────────────────────────────────────────────

function renderSummary() {
  const router = require('../src/routes/adminDashboard');
  const layer = router.stack.find((l) => l.route && l.route.path === '/summary');
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
/** The page's own list code, run offline: the functions that draw the rows, with a stand-in for the page. */
async function pageList() {
  const html = await renderSummary();
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const s of scripts) new vm.Script(s);   // every emitted script parses
  const src = scripts.find((x) => x.includes('function naItemHtml('));
  // one function's text: up to the next function — or, for the last one of the list code, up to the page's boot section
  const pick = (name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); const j = src.indexOf('\nfunction ', i + 1), boot = src.indexOf('\n/* ── Boot', i + 1); return src.slice(i, boot > i && (j < 0 || boot < j) ? boot : j); };
  const body = { innerHTML: '' };
  const ctx = { document: { getElementById: () => body }, _naShowAll: {}, NA_SEV: { high: 'Urgent', medium: 'To do', low: 'Check' } };
  vm.createContext(ctx);
  vm.runInContext(['escHtml', 'naDay', 'naDayNumber', 'naSince', 'naIsRecord', 'naRecordLink', 'naNoteOn', 'naItemHtml', 'naRenderBody'].map(pick).join('\n'), ctx);
  return { html, src, pick, ctx, draw: (d) => { ctx.naRenderBody(d); return body.innerHTML; } };
}

test('the Summary page draws the two groups: the heading, the client, a link to the client\'s record (not "No case number"), the text, Mark handled', async () => {
  const page = await pageList();
  await switchOn(async () => {
    harness({ leads: () => [lead({ id: 'L1' }), lead({ id: 'L2', fullName: 'Robin <b>Example</b>', followUpDate: '' }),
      { id: 'L3', fullName: 'Paid Person', outcome: 'Retain', followUpDate: '', retainerPaid: '2026-11-10', retainerSigned: '', retainerSent: '', clientMasterItemId: '', caseDeleted: '' }] });
    await NA.refresh();
  });

  // an admin with the team key: both groups, in the table's order, each with its link and its button
  const admin = JSON.parse(JSON.stringify(NA.view(ADMIN, { opensRecords: true })));   // as the page receives it
  let out = page.draw(admin);
  const groups = [...out.matchAll(/data-na-kind="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['paid-not-signed', 'followup-due', 'followup-no-date'], 'Urgent first, then the two To-do groups');
  assert.match(out, /<div class="na-group sev-medium" data-na-kind="followup-due"><div class="na-group-hd"><span class="na-sev">To do<\/span><h3 class="na-group-title">Follow-up date passed<\/h3><span class="na-count">1<\/span>/);
  assert.match(out, /data-na-kind="followup-no-date"><div class="na-group-hd"><span class="na-sev">To do<\/span><h3 class="na-group-title">Follow-Up with no follow-up date<\/h3>/);
  const due = out.slice(out.indexOf('data-na-kind="followup-due"'), out.indexOf('data-na-kind="followup-no-date"'));
  assert.match(due, /<li class="na-item" data-na-key="NA-[0-9a-f]{10}" data-na-on="record">/);
  assert.match(due, /<a class="na-ref" href="\/admin\/consultation\/L1\?from=retainers" title="Open the client record">Client record<\/a><span class="na-client">Dana Example<\/span>/);
  assert.ok(!due.includes('No case number'));
  assert.ok(due.includes('<p class="na-why">Follow-up date passed (20 Nov): Dana Example was to be called back on that day. The outcome is still Follow-Up.</p>'));
  assert.ok(due.includes('<span class="na-todo-lbl">What to do:</span> Call Dana Example back, then set a new follow-up date or change the outcome:'));
  assert.match(due, /Since <b>20 Nov<\/b>/);
  assert.match(due, /<span class="na-act"><button type="button" class="na-btn" onclick="naAskHandled\(this\)">Mark handled<\/button><\/span>/);
  assert.ok(!due.includes('na-auto'));
  const none = out.slice(out.indexOf('data-na-kind="followup-no-date"'));
  assert.ok(none.includes('Robin &lt;b&gt;Example&lt;/b&gt;') && !none.includes('<b>Example</b>'), 'a name is text, never markup');
  assert.match(none, /href="\/admin\/consultation\/L2\?from=retainers"/);
  // the other client-record line is drawn as it always was
  const pns = out.slice(out.indexOf('data-na-kind="paid-not-signed"'), out.indexOf('data-na-kind="followup-due"'));
  assert.ok(pns.includes('<span class="na-noref">No case number</span>') && !pns.includes('data-na-on') && !pns.includes('Client record'));

  // a viewer limited to their own cases: the two groups, no Mark handled — a word on how the line leaves instead
  out = page.draw(JSON.parse(JSON.stringify(NA.view(LIMITED))));
  assert.deepEqual([...out.matchAll(/data-na-kind="([^"]+)"/g)].map((m) => m[1]), ['followup-due', 'followup-no-date']);
  assert.ok(!out.includes('Mark handled') && !out.includes('naAskHandled'));
  assert.equal(out.split('<span class="na-auto">Leaves this list once the follow-up date or the outcome is changed.</span>').length - 1, 2);
  // …and NO link: the record page opens with the team key only (it would throw them to the sign-in page). The label is plain words.
  assert.ok(!out.includes('href=') && !out.includes('/admin/consultation/') && !out.includes('No case number'));
  assert.equal(out.split('<li class="na-item" data-na-key="').length - 1, 2);
  assert.match(out, /<li class="na-item" data-na-key="NA-[0-9a-f]{10}" data-na-on="record"><div class="na-who"><span class="na-noref">Client record<\/span><span class="na-client">Dana Example<\/span>/);
  assert.ok(out.includes('<span class="na-todo-lbl">What to do:</span> Tell the person who does the retainers. They call Dana Example back, then set a new follow-up date or change the outcome on the client\'s record;'));

  // a Monday sign-in that sees every case, in a tab WITHOUT the team key: Mark handled, the plain label, no link
  out = page.draw(JSON.parse(JSON.stringify(NA.view(SEES_ALL))));
  const dueNoKey = out.slice(out.indexOf('data-na-kind="followup-due"'), out.indexOf('data-na-kind="followup-no-date"'));
  assert.match(dueNoKey, /data-na-on="record"><div class="na-who"><span class="na-noref">Client record<\/span><span class="na-client">Dana Example<\/span>/);
  assert.ok(!dueNoKey.includes('href=') && !dueNoKey.includes('na-auto'));
  assert.match(dueNoKey, /<span class="na-act"><button type="button" class="na-btn" onclick="naAskHandled\(this\)">Mark handled<\/button><\/span>/);
  assert.ok(dueNoKey.includes('What to do:</span> Tell the person who does the retainers.'));

  // only the client's record page is ever made into a link, and only when the server sends it; a record line without a usable link is the plain label
  const itemOf = (e) => page.ctx.naItemHtml({ key: 'NA-0000000000', client: 'Dana Example', why: 'w', todo: 't', since: '', ...e });
  assert.ok(itemOf({ link: '/admin/consultation/L1', linkLabel: 'Client record' }).includes('href="/admin/consultation/L1"'));
  for (const bad of [{ link: 'https://example.com/x', linkLabel: 'Client record' }, { link: 'javascript:alert(1)', linkLabel: 'Client record' }, { link: '//example.com/admin/consultation/L1', linkLabel: 'Client record' }, { linkLabel: 'Client record' }]) {
    const h = itemOf(bad);
    assert.ok(h.includes('<span class="na-noref">Client record</span>') && h.includes('data-na-on="record"') && !h.includes('href=') && !h.includes('No case number'), JSON.stringify(bad));
  }
  for (const bad of [{ link: '/admin/consultation/L1' }, {}]) {
    const h = itemOf(bad);
    assert.ok(h.includes('No case number') && !h.includes('href=') && !h.includes('data-na-on'), JSON.stringify(bad));
  }
  assert.ok(itemOf({ linkLabel: '<i>x</i>' }).includes('<span class="na-noref">&lt;i&gt;x&lt;/i&gt;</span>'), 'the plain label is escaped too');
  // a case line keeps its case link even if a record link rides along (paid, no signed date — on a case)
  const onCase = itemOf({ caseRef: '2026-SV-050', link: '/admin/consultation/L1?from=retainers', linkLabel: 'Client record' });
  assert.ok(onCase.includes('href="/admin/case/2026-SV-050"') && !onCase.includes('/admin/consultation/') && !onCase.includes('data-na-on'));
  assert.ok(itemOf({ link: '/admin/consultation/L"1', linkLabel: '<i>x</i>' }).includes('href="/admin/consultation/L&quot;1"'), 'the link and its label are escaped');
});

test('the Summary page says where the "Mark handled" note goes — the client\'s record for these lines, the case number as before — and stays inside the inline-script rules', async () => {
  const page = await pageList();
  const li = (on, ref) => ({ getAttribute: (a) => (a === 'data-na-on' ? on : null), querySelector: () => (ref ? { textContent: ref } : null) });
  assert.equal(page.ctx.naNoteOn(li('record', 'Client record'), 'the case'), "the client's record");
  assert.equal(page.ctx.naNoteOn(li(null, '2026-SV-050'), 'the case'), '2026-SV-050');
  assert.equal(page.ctx.naNoteOn(li(null, ''), 'the case'), 'the case');
  assert.equal(page.ctx.naNoteOn(li(null, ''), ''), '');
  // the real click: "Mark handled" asks first, in words that say where the note goes; the save then says the same
  const click = async (on, ref, answer) => {
    const flashes = [], posts = [];
    const act = { innerHTML: '', querySelector: (sel) => (sel === '.na-err' ? null : { focus() {} }), querySelectorAll: () => [], appendChild(el) { this.err = el; } };
    const item = { ...li(on, ref), classList: { add() {} } };
    item.getAttribute = (a) => (a === 'data-na-key' ? 'NA-0123456789' : a === 'data-na-on' ? on : null);
    const btn = { closest: (sel) => (sel === '.na-act' ? act : item), textContent: '' };
    const ctx = { _naBusy: {}, _naDone: {}, _na: { entries: [{ key: 'NA-0123456789' }] }, JSON,
      document: { getElementById: () => ({ focus() {} }), querySelector: () => null, body: { contains: () => true }, createElement: () => ({ setAttribute() {} }) },
      setTimeout: (fn) => fn(), naFocusAfter: () => '', naRender: () => {}, naLoad: () => {}, naHeaders: () => ({}), naFlash: (m, k) => flashes.push([m, k || '']),
      fetch: async (url, opts) => { posts.push([url, opts.method, opts.body]); return { ok: answer.status === 200, status: answer.status, json: async () => answer.body }; } };
    vm.createContext(ctx);
    vm.runInContext(['escHtml', 'naNoteOn', 'naAskHandled', 'naMarkHandled'].map(page.pick).join('\n'), ctx);
    ctx.naAskHandled(btn);
    const asked = act.innerHTML;
    ctx.naMarkHandled(btn);
    await new Promise((r) => setTimeout(r, 5));
    return { asked, flashes, posts, err: act.err && act.err.textContent };
  };
  let r = await click('record', 'Client record', { status: 200, body: { ok: true } });
  assert.ok(r.asked.startsWith('<span class="na-confirm-q">Adds a note on the client\'s record in Monday and takes it off this list.</span>'), r.asked);
  assert.deepEqual(r.posts, [['/admin/needs-attention/handled', 'POST', '{"key":"NA-0123456789"}']], 'only the key is sent');
  assert.deepEqual(r.flashes, [['Marked handled. A note was added to the client\'s record.', '']]);
  r = await click(null, '2026-SV-050', { status: 200, body: { ok: true } });
  assert.ok(r.asked.startsWith('<span class="na-confirm-q">Adds a note on 2026-SV-050 in Monday and takes it off this list.</span>'), 'a case line reads as before');
  assert.deepEqual(r.flashes, [['Marked handled. A note was added to 2026-SV-050.', '']]);
  r = await click(null, '', { status: 200, body: { ok: true } });
  assert.ok(r.asked.includes('Adds a note on the case in Monday'), 'a line with no case number reads as before');
  assert.deepEqual(r.flashes, [['Marked handled.', '']]);
  // the server's refusal (a stale page of a viewer who may not mark it) is shown in its own words, and the line stays
  r = await click('record', 'Client record', { status: 403, body: { error: 'Only an admin, or staff who see every case, can mark this handled.' } });
  assert.deepEqual([r.flashes, r.err], [[], 'Only an admin, or staff who see every case, can mark this handled.']);
  // the three places that name it use the one helper
  const ask = page.pick('naAskHandled'), mark = page.pick('naMarkHandled');
  assert.ok(ask.includes("'<span class=\"na-confirm-q\">Adds a note on ' + escHtml(naNoteOn(li, 'the case')) +"));
  assert.ok(mark.includes("var noteOn = naNoteOn(li, '');"));
  assert.ok(mark.includes("drop('Marked handled' + (noteOn ? '. A note was added to ' + noteOn + '.' : '.'));"));
  assert.ok(mark.includes("naFlash('The note for ' + (noteOn || 'that item') + ' could not be saved (' + e.message + ').', 'err');"));
  assert.ok(!ask.includes('refEl') && !mark.includes('refEl'));
  // every value from the server goes through escHtml before innerHTML
  const fn = page.pick('naItemHtml');
  for (const field of ['e.caseRef', 'e.client', 'e.why', 'e.todo', 'e.key', 'e.link', 'e.linkLabel']) assert.ok(fn.includes('escHtml(' + field + ')'), field + ' is escaped');
  // the script sits inside the page's template literal: no backtick, no dollar-brace, no backslash in what was added
  const added = page.src.slice(page.src.indexOf('// A line about a client record, not a case'), page.src.indexOf('// The header, the note and the Check now button'));
  assert.ok(added.includes('function naIsRecord(e)') && added.includes('function naRecordLink(e)') && added.includes('function naItemHtml(e)'));
  assert.ok(!added.includes('`') && !added.includes('${') && !added.includes('\\'));
  const file = fs.readFileSync(require.resolve('../src/routes/adminDashboard.js'), 'utf8');
  const raw = file.slice(file.indexOf('// A line about a client record, not a case'), file.indexOf('// The header, the note and the Check now button'));
  assert.ok(raw.length > 500 && !raw.includes('`') && !raw.includes('${') && !raw.includes('\\'), 'the source too: what is written is what is emitted');
  assert.ok(page.html.includes('.na-auto {'), 'the small grey line has its style');
});

test('the routes: the list, Check now and Mark handled answer every signed-in staff member through the one viewer rule; nothing the page sends but the key is used', () => {
  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const a = server.indexOf("app.get('/admin/needs-attention'"), b = server.indexOf('// Retainer/payment status audit');
  assert.ok(a > 0 && b > a);
  const routes = server.slice(a, b);
  assert.equal(routes.split('const viewer = resolveViewer(req);').length - 1, 3);
  assert.equal(routes.split("if (!viewer) return res.status(401).json({ error: 'Sign in required', loginUrl: SUMMARY_LOGIN_URL });").length - 1, 3, 'nobody signed in: no list');
  assert.ok(routes.includes("require('./services/needsAttentionService').view(viewer, { ensure: true, opensRecords: hasAdminKey(req) })"), 'the link to a client record only for a request that came with the team key');
  assert.ok(server.includes("app.use('/api', requireApiKey)"), 'the record page\'s data: the team key only');
  const recordPage = fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8');
  assert.ok(/getKey\(\)/.test(recordPage) && !/peekKey\(\)/.test(recordPage), 'the record page itself asks for the team key (a tab without it is sent to the sign-in page) — the reason the link follows the key');
  assert.ok(routes.includes("require('./services/needsAttentionService').markHandled({ key, viewer, actor })"));
  assert.ok(routes.includes("if (err.status) return res.status(err.status).json({ error: err.message });"), 'the 403 reaches the page with its words');
});
