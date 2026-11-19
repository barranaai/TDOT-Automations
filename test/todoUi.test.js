'use strict';

// The To-do tab on the Client Master page — stage 1, READ-ONLY (Faran 2026-11-19): the page's pure helpers
// (src/routes/todoUi.js). Who has a list, which cases are on it, the order ("soonest deadline first"), the groups
// under the headings and the names in the "With" pill. No DOM here; the page wiring is in test/todoPage.test.js.
// Only Case Support Officer and Case Manager ever put a case on a list.
// All made-up data (Officer One, Reviewer One, Test Client 1 …); the one real-shape check uses the capture fixture,
// which holds ids only (no names) — and prints none of it.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const { todoUi } = require('../src/routes/todoUi');
const CMW  = require('../src/routes/clientMasterWindows');
const CMU  = require('../src/routes/clientMasterUi');
const cmv  = require('../src/services/clientMasterViews');
const dash = require('../src/services/dashboardService');
const svc  = require('../src/services/todoListService');
const META_FIX = require('./fixtures/client-master-board-meta.json');
const CAPTURE  = require('./fixtures/client-master-capture.json');

const T = todoUi(CMW, CMU);
const STAGE_COL = 'color_mm0x8faa', PHASE_COL = 'color_mm3tf1ys';
// the real board meta (group order + label positions; no client data), through the service's own parser
const META = dash._casesIo.parseMeta({ groups: META_FIX.groups, columns: [STAGE_COL, PHASE_COL].map((id) => ({ id, settings_str: JSON.stringify(META_FIX.columns[id].settings) })) });

/* People and teams: [Monday id, name]. */
const ONE = ['111', 'Officer One'], TWO = ['112', 'Officer Two'], THREE = ['113', 'Officer Three'];
const REV = ['211', 'Reviewer One'], REV2 = ['212', 'Reviewer Two'];
const TEAM9 = ['9', 'Team Nine'], TEAM8 = ['8', 'Team Eight'];
const TODAY = '2026-11-19';

/** A Client Master row as the page has it (dashboardService.parseItem), open unless said otherwise. */
function mk(id, o = {}) {
  const { officers = [], officerTeams = [], managers = [], managerTeams = [], open = true, ...rest } = o;
  const text = (people, teams) => people.concat(teams).map((x) => x[1]).join(', ');
  return {
    id: String(id), caseRef: '2026-EE-' + String(id).padStart(3, '0'), clientName: 'Test Client ' + id,
    views: open ? ['assigning', 'todo'] : ['deadlines'],
    officer: text(officers, officerTeams), officerIds: { personIds: officers.map((x) => x[0]), teamIds: officerTeams.map((x) => x[0]) },
    manager: text(managers, managerTeams) || 'Unassigned', managerIds: { personIds: managers.map((x) => x[0]), teamIds: managerTeams.map((x) => x[0]) },
    stageIdx: 1, caseStage: 'Internal Review', deadlineType: '', actualDeadline: '', promisedDate: '',
    ...rest,
  };
}
const idsOf = (rows) => rows.map((r) => r.id).join(',');
const me = (p, teamIds = []) => ({ id: p[0], name: p[1], teamIds });

test('the helper is one function of (CMW, CMU) that returns the agreed functions — and nothing else that could reach outside', () => {
  assert.deepEqual(Object.keys(require('../src/routes/todoUi')), ['todoUi']);
  assert.equal(todoUi.name, 'todoUi');
  assert.equal(todoUi.length, 2);
  for (const f of ['normWho', 'names', 'open', 'people', 'resolveWho', 'has', 'dueDate', 'duePassed', 'order', 'listFor', 'withNames', 'nameOf', 'sizeOf', 'dueField']) assert.equal(typeof T[f], 'function', f);
  assert.equal(T.TAG, svc.PAGE_VIEW.key, 'the mark it looks for is the one the server puts on the open rows');
});

test('the injected-code rule: no backslash, backtick or dollar-brace anywhere in todoUi.js; no request and no write; pasted as text into a bare page it works with the page\'s CMW and CMU', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/todoUi'), 'utf8');
  assert.ok(!/[`\\]|\$\{/.test(src), 'the whole file, comments too');
  assert.ok(!/[`\\]|\$\{/.test(todoUi.toString()));
  assert.ok(!src.includes('fetch(') && !/\bmutation\b/.test(src) && !/XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.|window\./.test(src), 'no request, nothing kept, no page object');
  assert.ok(!/require\(/.test(todoUi.toString()));
  // as the page gets it: var TDU = (todoUi.toString())(CMW, CMU) — with nothing else in scope
  const page = vm.runInNewContext('var CMW = (' + CMW.clientMasterWindows.toString() + ')(); var CMU = (' + CMU.clientMasterUi.toString() + ')(CMW); var TDU = (' + todoUi.toString() + ')(CMW, CMU); TDU');
  const rows = [mk(1, { officers: [ONE], managers: [REV], deadlineType: 'Deadline', actualDeadline: '2026-11-01' }), mk(2, { stageIdx: 12, caseStage: 'Pre-Onboarding' })];
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(page.people(rows, me(REV), 'all')), plain(T.people(rows, me(REV), 'all')));
  const o = { me: me(REV), names: T.names(rows), meta: META, today: TODAY };
  for (const who of ['me', 'p:111', 'nobody', '']) assert.deepEqual(plain(page.listFor(page.order(rows), who, o)), plain(T.listFor(T.order(rows), who, o)), who);
  assert.equal(page.resolveWho('p:999', page.people(rows, me(REV), 'all')), 'me');
});

test('normWho(): exactly "me", "nobody", "p:<digits>" or "t:<digits>" — anything else is no list', () => {
  for (const ok of ['me', 'nobody', 'p:1', 'p:12345678', 't:9', 't:00012', 'p:' + '9'.repeat(20)]) assert.equal(T.normWho(ok), ok);
  for (const bad of ['', ' ', 'Me', 'ME', ' me', 'me ', 'everyone', 'all', 'p:', 't:', 'p:12a', 'p: 12', 'p:-1', 'p:1.5', 'x:12', 'P:12', 'p12', '12', 'p:12,p:13', 'p:12|mine', 'p:' + '9'.repeat(21),
    'Officer One', 'officer.one@example.com', '<b>me</b>', null, undefined, 0, 12, true, {}, [], ['me'], { toString: () => 'me' }]) assert.equal(T.normWho(bad), '', JSON.stringify(bad));
});

/* ── names ── */

test('names(): ids are paired with the cell\'s names only in a cell of ONE kind with as many names as ids; learned from every row and both cells', () => {
  const rows = [
    mk(1, { officers: [ONE, TWO], managers: [REV] }),
    mk(2, { officerTeams: [TEAM9], managerTeams: [TEAM8], open: false }),            // not open: its names still count
    mk(3, { officers: [THREE], officerTeams: [TEAM9], managers: [REV2], managerTeams: [TEAM8] }),   // people and teams together: the order between them is not known
  ];
  assert.deepEqual(T.names(rows), { 'p:111': 'Officer One', 'p:112': 'Officer Two', 'p:211': 'Reviewer One', 't:9': 'Team Nine', 't:8': 'Team Eight' });
  // the mixed cell alone teaches nothing
  assert.deepEqual(T.names([rows[2]]), {});
  // as many names as ids, or nothing: a name with a comma in it, a name missing, a name too many
  assert.deepEqual(T.names([mk(4, { officers: [ONE, TWO], officer: 'One, Officer, Officer Two' })]), {});
  assert.deepEqual(T.names([mk(5, { officers: [ONE, TWO], officer: 'Officer One' })]), {});
  assert.deepEqual(T.names([mk(6, { officers: [ONE], officer: 'Officer One, Officer Two' })]), {});
  assert.deepEqual(T.names([mk(7, { officers: [ONE], officer: '' })]), {});
  // spaces around the names do not matter; an empty piece is not a name
  assert.deepEqual(T.names([mk(8, { officers: [ONE, TWO], officer: '  Officer One ,Officer Two  ' })]), { 'p:111': 'Officer One', 'p:112': 'Officer Two' });
  assert.deepEqual(T.names([mk(9, { officers: [ONE, TWO], officer: 'Officer One,, Officer Two' })]), { 'p:111': 'Officer One', 'p:112': 'Officer Two' });
  // an id that is not a plain Monday id teaches nothing — and neither does the rest of its cell (the places no longer line up)
  assert.deepEqual(T.names([mk(10, { officer: 'Officer One, Odd Person', officerIds: { personIds: ['111', 'abc'], teamIds: [] } })]), {});
  // nothing to learn from: no rows, rows without the cells, junk
  assert.deepEqual(T.names([]), {});
  assert.deepEqual(T.names(null), {});
  assert.deepEqual(T.names([null, {}, { officer: 'Officer One' }, { officerIds: { personIds: ['111'] } }, { officerIds: 'x', officer: 'Officer One' }]), {});
});

test('names(): "Unassigned" is never a name; the other people columns are never read; one id with different names — the most frequent wins, the first seen on a tie', () => {
  // an empty Case Manager cell reads "Unassigned" on the row: never learned, whatever ids sit beside it
  assert.deepEqual(T.names([mk(1, { manager: 'Unassigned', managerIds: { personIds: ['211'], teamIds: [] } })]), {});
  assert.deepEqual(T.names([mk(2, { officers: [ONE] })]), { 'p:111': 'Officer One' });
  assert.ok(!Object.values(T.names([mk(3, { officers: [ONE] }), mk(4)])).includes('Unassigned'));
  // Retained by, Stage Owner, Ops Supervisor … are on the row too (assignees, retainedBy, supervisor): not a word of them is learned
  const other = mk(5, { retainedBy: 'Staff Nine', supervisor: 'Staff Ten', assignees: { personIds: ['311', '312'], teamIds: ['31'] } });
  assert.deepEqual(T.names([other]), {});
  // the same id under two names (a person renamed in Monday between two reads of a cell)
  const a = (name) => mk(6, { officers: [ONE], officer: name });
  assert.equal(T.names([a('Officer One'), a('O. One'), a('O. One')])['p:111'], 'O. One', 'the most frequent');
  assert.equal(T.names([a('O. One'), a('Officer One'), a('Officer One'), a('O. One')])['p:111'], 'O. One', 'a tie: the one seen first');
  assert.equal(T.names([a('Officer One'), a('O. One')])['p:111'], 'Officer One');
  // a person and a team with the same number are two different entries
  assert.deepEqual(T.names([mk(7, { officers: [['9', 'Person Nine']], managerTeams: [TEAM9] })]), { 'p:9': 'Person Nine', 't:9': 'Team Nine' });
  // names that look like object internals are just names
  assert.deepEqual(T.names([mk(8, { officers: [['1', 'constructor'], ['2', 'toString']] })]), { 'p:1': 'constructor', 'p:2': 'toString' });
});

test('nameOf(): the learned name; an id never resolved reads "Monday user <id>" / "Monday team <id>"; anything that is not a person or a team has no name', () => {
  const nm = { 'p:111': 'Officer One', 't:9': 'Team Nine', 'p:5': '   ' };
  assert.equal(T.nameOf('p:111', nm), 'Officer One');
  assert.equal(T.nameOf('t:9', nm), 'Team Nine');
  assert.equal(T.nameOf('p:999', nm), 'Monday user 999');
  assert.equal(T.nameOf('t:77', nm), 'Monday team 77');
  assert.equal(T.nameOf('p:5', nm), 'Monday user 5', 'a blank is not a name');
  assert.equal(T.nameOf('p:111', null), 'Monday user 111');
  for (const none of ['me', 'nobody', '', 'x', null, 'p:abc', 'toString', '__proto__']) assert.equal(T.nameOf(none, nm), '', String(none));
});

/* ── who has a list ── */

test('open(): the rows the server marked — nothing else decides what an open case is', () => {
  const rows = [mk(1), mk(2, { open: false }), { id: '3', views: ['assigning'] }, { id: '4', views: ['todo'] }, { id: '5' }, null, { id: '7', views: 'todo' }];
  assert.equal(idsOf(T.open(rows)), '1,4');
  assert.deepEqual(T.open(null), []);
  assert.deepEqual(T.open([]), []);
});

test('people(): officers and managers of open rows, each with mine / review / total; two officers in one cell are both listed; officer and manager the same person counts once', () => {
  const rows = [
    mk(1, { officers: [ONE], managers: [REV] }),
    mk(2, { officers: [ONE, TWO] }),                       // two officers: on both lists
    mk(3, { officers: [TWO], managers: [TWO] }),           // officer and manager the same person: one case, under "mine"
    mk(4, { officers: [THREE], managers: [REV, REV2] }),   // two managers
    mk(5, { managers: [REV] }),                            // a manager and no officer
    mk(6),                                                 // nobody
    mk(7, { officers: [THREE], managers: [REV], open: false }),   // not open: on no list
  ];
  const p = T.people(rows, null, 'all');
  assert.equal(p.me, null, 'no Monday sign-in: nobody is "me"');
  assert.deepEqual(p.list, [
    { key: 'p:111', name: 'Officer One', mine: 2, review: 0, total: 2 },
    { key: 'p:113', name: 'Officer Three', mine: 1, review: 0, total: 1 },
    { key: 'p:112', name: 'Officer Two', mine: 2, review: 0, total: 2 },
    { key: 'p:211', name: 'Reviewer One', mine: 0, review: 3, total: 3 },
    { key: 'p:212', name: 'Reviewer Two', mine: 0, review: 1, total: 1 },
  ], 'A to Z by name');
  assert.deepEqual(p.nobody, { key: 'nobody', total: 1 });
  // each number is what has() gives, row by row
  for (const e of p.list) assert.equal(rows.filter((r) => T.has(r, e.key, null)).length, e.total, e.key);
  assert.equal(rows.filter((r) => T.has(r, 'nobody', null)).length, p.nobody.total);
  // every open row is on at least one list, or under "No one assigned" — never both, never neither
  for (const r of T.open(rows)) {
    const onSome = p.list.some((e) => T.has(r, e.key, null));
    assert.equal(onSome, !T.has(r, 'nobody', null), r.id);
  }
});

test('people(): the other people columns never put a case on a list — a case with somebody only in Retained by / Stage Owner / Ops Supervisor is "No one assigned"', () => {
  const rows = [
    mk(1, { retainedBy: 'Staff Nine', supervisor: 'Staff Ten', assignees: { personIds: ['311', '312', '313'], teamIds: ['31'] } }),
    mk(2, { officers: [ONE], retainedBy: 'Staff Nine', assignees: { personIds: ['111', '311'], teamIds: [] } }),
  ];
  const p = T.people(rows, me(['311', 'Staff Nine'], ['31']), 'all');
  assert.deepEqual(p.me, { key: 'me', name: 'Staff Nine', mine: 0, review: 0, total: 0 }, 'the person in Retained by has no case on their own list');
  assert.deepEqual(p.list.map((e) => e.key), ['p:111']);
  assert.deepEqual(p.nobody, { key: 'nobody', total: 1 });
  assert.equal(T.has(rows[0], 'me', me(['311', 'Staff Nine'], ['31'])), false);
  assert.equal(T.has(rows[0], 'p:311', null), false);
  assert.equal(T.has(rows[0], 't:31', null), false);
  assert.equal(T.has(rows[0], 'nobody', null), true);
});

test('people(): me = my own id and every team I am in; always there, also with no case; my own entry is not repeated in the list; a team I am in still shows as itself', () => {
  const rows = [
    mk(1, { officers: [ONE] }),
    mk(2, { officerTeams: [TEAM9] }),                       // my team is officer
    mk(3, { officers: [TWO], managerTeams: [TEAM9] }),      // my team is manager
    mk(4, { officers: [ONE], managers: [ONE] }),            // I am both: once, under mine
    mk(5, { officerTeams: [TEAM8], managers: [ONE] }),      // another team is officer, I am manager
    mk(6, { officers: [TWO] }),
  ];
  const p = T.people(rows, me(ONE, ['9']), 'all');
  assert.deepEqual(p.me, { key: 'me', name: 'Officer One', mine: 3, review: 2, total: 5 });
  assert.deepEqual(p.list.map((e) => [e.key, e.name, e.mine, e.review, e.total]), [['p:112', 'Officer Two', 2, 0, 2], ['t:8', 'Team Eight', 1, 0, 1], ['t:9', 'Team Nine', 1, 1, 2]], 'no second entry for me; my team is there as a team');
  assert.equal(rows.filter((r) => T.has(r, 'me', me(ONE, ['9']))).length, 5);
  // the team's list for someone who is not in it is the same list (a team is one entry for everybody)
  const other = T.people(rows, me(TWO), 'all');
  assert.deepEqual(other.me, { key: 'me', name: 'Officer Two', mine: 2, review: 0, total: 2 });
  assert.deepEqual(other.list.map((e) => [e.key, e.total]), [['p:111', 3], ['t:8', 1], ['t:9', 2]]);
  // me with no case at all: still "My list", at 0
  const none = T.people(rows, me(['777', 'New Starter']), 'all');
  assert.deepEqual(none.me, { key: 'me', name: 'New Starter', mine: 0, review: 0, total: 0 });
  assert.equal(none.list.length, 4);
  // the name: the sign-in's own; without one, the name the rows know for my id; else ''
  assert.equal(T.people(rows, { id: '111', name: '', teamIds: [] }, 'all').me.name, 'Officer One');
  assert.equal(T.people(rows, { id: '111', name: 'One (signed in)', teamIds: [] }, 'all').me.name, 'One (signed in)');
  assert.equal(T.people(rows, { id: '777', name: '', teamIds: [] }, 'all').me.name, '');
  // a sign-in without a plain Monday id is nobody
  for (const bad of [null, undefined, {}, { id: '' }, { id: 'abc', name: 'X' }, { name: 'Officer One' }]) assert.equal(T.people(rows, bad, 'all').me, null);
});

test('people(): nobody = no Case Support Officer AND no Case Manager, person or team; offered also at 0; a team counts as somebody', () => {
  const rows = [mk(1), mk(2, { officerTeams: [TEAM9] }), mk(3, { managerTeams: [TEAM8] }), mk(4, { managers: [REV] }), mk(5), mk(6, { open: false })];
  const p = T.people(rows, null, 'all');
  assert.deepEqual(p.nobody, { key: 'nobody', total: 2 });
  assert.equal(idsOf(rows.filter((r) => T.has(r, 'nobody', null))), '1,5');
  assert.deepEqual(T.people([mk(1, { officers: [ONE] })], null, 'all').nobody, { key: 'nobody', total: 0 }, 'always offered');
  assert.deepEqual(T.people([], null, 'all'), { me: null, list: [], nobody: { key: 'nobody', total: 0 } });
  assert.deepEqual(T.people(null, null, undefined), { me: null, list: [], nobody: { key: 'nobody', total: 0 } });
  // a row that came without managerIds (an answer without the tab's fields) is read by the cell's text: never called empty by mistake
  const bare = mk(7, { manager: 'Reviewer One' }); delete bare.managerIds;
  assert.equal(T.has(bare, 'nobody', null), false);
  const bareEmpty = mk(8); delete bareEmpty.managerIds;
  assert.equal(T.has(bareEmpty, 'nobody', null), true);
});

test('people() with scope "assigned" (the viewer gets only their own cases): only "My list" is offered — no other names, no "No one assigned"', () => {
  const rows = [mk(1, { officers: [ONE], managers: [REV] }), mk(2, { officers: [TWO], managers: [ONE] }), mk(3)];
  const p = T.people(rows, me(ONE), 'assigned');
  assert.deepEqual(p, { me: { key: 'me', name: 'Officer One', mine: 1, review: 1, total: 2 }, list: [], nobody: null });
  assert.deepEqual(T.people(rows, null, 'assigned'), { me: null, list: [], nobody: null });
  // so a kept other list falls back to mine
  for (const kept of ['nobody', 'p:112', 'p:211', 't:9', 'me', '']) assert.equal(T.resolveWho(kept, p), 'me', kept);
});

test('resolveWho(): the kept choice while it is still offered; otherwise "My list" with a Monday sign-in, else no list', () => {
  const rows = [mk(1, { officers: [ONE] }), mk(2, { officers: [TWO], managerTeams: [TEAM9] }), mk(3)];
  const signedIn = T.people(rows, me(ONE), 'all'), keyOnly = T.people(rows, null, 'all');
  const table = [
    // kept           signed in   key only
    ['me',            'me',       ''],
    ['nobody',        'nobody',   'nobody'],
    ['p:112',         'p:112',    'p:112'],
    ['t:9',           't:9',      't:9'],
    ['p:111',         'me',       'p:111'],     // my own id is "My list" when I am signed in; a name like any other when I am not
    ['p:999',         'me',       ''],          // a person who has no open case any more
    ['t:404',         'me',       ''],
    ['',              'me',       ''],
    [null,            'me',       ''],
    [undefined,       'me',       ''],
    ['everyone',      'me',       ''],
    ['p:112|mine',    'me',       ''],
    [' me',           'me',       ''],
  ];
  for (const [kept, a, b] of table) { assert.equal(T.resolveWho(kept, signedIn), a, 'signed in, kept ' + JSON.stringify(kept)); assert.equal(T.resolveWho(kept, keyOnly), b, 'key only, kept ' + JSON.stringify(kept)); }
  // no people at all (the data has not come yet)
  assert.equal(T.resolveWho('me', null), '');
  assert.equal(T.resolveWho('p:112', undefined), '');
  assert.equal(T.resolveWho('nobody', {}), '');
  // sizeOf(): the number beside a list's name — the list's size before any search or filter of the person's own
  assert.deepEqual(['me', 'nobody', 'p:112', 't:9', 'p:111', 'p:999', '', null, 'everyone'].map((w) => T.sizeOf(signedIn, w)), [1, 1, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(['me', 'nobody', 'p:111', 'p:112'].map((w) => T.sizeOf(keyOnly, w)), [0, 1, 1, 1]);
  for (const w of ['me', 'nobody', 'p:112', 't:9']) assert.equal(T.sizeOf(signedIn, w), rows.filter((r) => T.has(r, w, me(ONE))).length, w);
  assert.equal(T.sizeOf(null, 'me'), 0);
  assert.equal(T.sizeOf(T.people(rows, me(ONE), 'assigned'), 'nobody'), 0);
});

test('has(): only an OPEN row is ever on a list; a person or a team by officer or manager; "me" with my teams; no list = no row', () => {
  const r = mk(1, { officers: [ONE], officerTeams: [TEAM9], managers: [REV], managerTeams: [TEAM8] });
  for (const who of ['p:111', 't:9', 'p:211', 't:8']) assert.equal(T.has(r, who, null), true, who);
  for (const who of ['p:112', 't:7', 'nobody', '', 'me', 'everyone', null, undefined, 'p:111|mine']) assert.equal(T.has(r, who, null), false, String(who));
  assert.equal(T.has(r, 'me', me(ONE)), true);
  assert.equal(T.has(r, 'me', me(REV)), true);
  assert.equal(T.has(r, 'me', me(['555', 'In Team Nine'], ['9'])), true);
  assert.equal(T.has(r, 'me', me(['555', 'In Team Eight'], ['3', '8'])), true);
  assert.equal(T.has(r, 'me', me(['555', 'Elsewhere'], ['3'])), false);
  assert.equal(T.has(r, 'me', null), false, '"me" without a Monday sign-in is nobody');
  // a person id never matches a team of the same number, and the other way round
  assert.equal(T.has(r, 'p:9', null), false);
  assert.equal(T.has(r, 't:111', null), false);
  // not open: on no list, whoever is on the case
  const shut = mk(2, { officers: [ONE], open: false });
  for (const who of ['p:111', 'me', 'nobody']) assert.equal(T.has(shut, who, me(ONE)), false, who);
  assert.equal(T.has(mk(3, { open: false }), 'nobody', null), false);
  assert.equal(T.has(null, 'p:111', null), false);
  assert.equal(T.has({}, 'nobody', null), false);
});

/* ── the order ── */

test('dueDate(): Real and not recorded = Actual deadline, Imaginary = Internal deadline; when that one is blank, the other of the two; never Hard / Soft / Prep', () => {
  const d = (o) => T.dueDate(o), f = (o) => T.dueField(o);
  const A = '2026-12-01', I = '2026-11-10';
  assert.deepEqual([d({ deadlineType: 'Deadline', actualDeadline: A, promisedDate: I }), f({ deadlineType: 'Deadline', actualDeadline: A, promisedDate: I })], [A, 'actualDeadline']);
  assert.deepEqual([d({ deadlineType: 'Imaginary', actualDeadline: A, promisedDate: I }), f({ deadlineType: 'Imaginary', actualDeadline: A, promisedDate: I })], [I, 'internalDeadline']);
  assert.deepEqual([d({ deadlineType: '', actualDeadline: A, promisedDate: I }), f({ deadlineType: '', actualDeadline: A, promisedDate: I })], [A, 'actualDeadline'], 'not recorded: the Actual deadline');
  // each blank fallback: a row that shows a date is never ordered as having none
  assert.deepEqual([d({ deadlineType: 'Imaginary', actualDeadline: A, promisedDate: '' }), f({ deadlineType: 'Imaginary', actualDeadline: A, promisedDate: '' })], [A, 'actualDeadline']);
  assert.deepEqual([d({ deadlineType: 'Deadline', actualDeadline: '', promisedDate: I }), f({ deadlineType: 'Deadline', actualDeadline: '', promisedDate: I })], [I, 'internalDeadline']);
  assert.deepEqual([d({ deadlineType: '', actualDeadline: '', promisedDate: I }), f({ deadlineType: '', actualDeadline: '', promisedDate: I })], [I, 'internalDeadline']);
  // it is the team's own counting rule where that rule has a date (the Deadlines tab's windows)
  for (const r of [{ deadlineType: 'Deadline', actualDeadline: A, promisedDate: I }, { deadlineType: 'Imaginary', actualDeadline: A, promisedDate: I }, { deadlineType: '', actualDeadline: A }]) assert.equal(d(r), CMW.bucketDate(r));
  // no date
  for (const r of [{}, null, undefined, { deadlineType: 'Deadline' }, { deadlineType: 'Imaginary', actualDeadline: '', promisedDate: '' }, { actualDeadline: 'soon', promisedDate: '2026-13-45' }, { actualDeadline: '01/12/2026' }]) {
    assert.equal(d(r), '', JSON.stringify(r)); assert.equal(f(r), '', JSON.stringify(r));
  }
  // never the SLA dates
  assert.equal(d({ deadlineType: 'Deadline', hardDeadline: '2026-11-01', softDeadline: '2026-11-02', prepDeadline: '2026-11-03' }), '');
  // a date that carries a time is its day
  assert.equal(d({ deadlineType: 'Deadline', actualDeadline: '2026-12-01 09:30' }), '2026-12-01');
  const src = todoUi.toString();
  assert.ok(!/hardDeadline|softDeadline|prepDeadline/.test(src));
});

test('duePassed(): the due date is before today (the Toronto day); today itself has not passed; no date never has', () => {
  const real = (a) => ({ deadlineType: 'Deadline', actualDeadline: a }), imag = (i, a) => ({ deadlineType: 'Imaginary', promisedDate: i, actualDeadline: a || '' });
  assert.equal(T.duePassed(real('2026-11-18'), TODAY), true);
  assert.equal(T.duePassed(real('2026-11-19'), TODAY), false);
  assert.equal(T.duePassed(real('2026-11-20'), TODAY), false);
  assert.equal(T.duePassed(real('2019-01-01'), TODAY), true, 'long passed is still passed');
  assert.equal(T.duePassed(imag('2026-11-01', '2027-01-01'), TODAY), true, 'an Imaginary case is judged by its Internal deadline');
  assert.equal(T.duePassed(imag('2027-01-01', '2026-11-01'), TODAY), false);
  assert.equal(T.duePassed(imag('', '2026-11-01'), TODAY), true, 'the fallback date counts too');
  assert.equal(T.duePassed({}, TODAY), false);
  assert.equal(T.duePassed(real('2026-11-18'), ''), false, 'no today: nothing is called passed');
  assert.equal(T.duePassed(real('2026-11-18'), 'today'), false);
  assert.equal(T.duePassed(real('2026-11-18'), undefined), false);
});

test('order(): soonest deadline first — dates that have passed lead, no date last; the same date by case reference with its numbers as numbers; then the order given (stable)', () => {
  const r = (id, type, a, i, ref) => ({ id, deadlineType: type, actualDeadline: a || '', promisedDate: i || '', caseRef: ref === undefined ? '2026-EE-' + id : ref });
  const rows = [
    r('n1', 'Deadline', '', ''),                         // no date
    r('f', 'Deadline', '2027-02-01'),                    // far off
    r('p', 'Deadline', '2026-10-01'),                    // passed
    r('i', 'Imaginary', '2027-06-01', '2026-11-25'),     // Imaginary: by its Internal deadline (the Actual one would put it last)
    r('n2', '', '', ''),                                 // no date
    r('s', '', '2026-11-20'),                            // not recorded: by its Actual deadline
    r('b', 'Imaginary', '2026-11-22', ''),               // Imaginary with a blank Internal deadline: its Actual deadline
    r('pp', 'Imaginary', '', '2026-09-15'),              // the oldest
  ];
  assert.equal(idsOf(T.order(rows)), 'pp,p,s,b,i,f,n1,n2');
  // a new list: the rows given are not moved
  assert.equal(idsOf(rows), 'n1,f,p,i,n2,s,b,pp');
  // the same date: case reference, numbers as numbers (9 before 10 before 100), letters A to Z, capitals or not; no reference last
  const same = (id, ref) => r(id, 'Deadline', '2026-12-01', '', ref);
  assert.equal(idsOf(T.order([same('a', '2026-EE-100'), same('b', '2026-EE-9'), same('c', '2026-ee-10'), same('d', ''), same('e', '2026-AB-200'), same('f', '2025-ZZ-999')])), 'f,e,b,c,a,d');
  // the same date and the same reference: the order given stays (also among the rows with no date)
  const tie = [same('x1', 'R'), same('x2', 'R'), r('y1', '', '', '', 'Q'), same('x3', 'R'), r('y2', '', '', '', 'Q')];
  assert.equal(idsOf(T.order(tie)), 'x1,x2,x3,y1,y2');
  assert.deepEqual(T.order(null), []);
  assert.deepEqual(T.order([]), []);
  // it orders exactly by dueDate
  const due = T.order(rows).map((x) => T.dueDate(x)).filter(Boolean);
  assert.deepEqual(due, due.slice().sort());
});

/* ── the groups under the headings ── */

test('listFor() for a person: their own cases first ("<Name>\'s cases"), then the ones with them for review ("With <Name> for review"); empty groups are left out; the rows keep the order given', () => {
  const rows = [
    mk(1, { officers: [ONE], managers: [REV], deadlineType: 'Deadline', actualDeadline: '2026-11-01' }),              // passed
    mk(2, { officers: [TWO], managers: [ONE], deadlineType: 'Deadline', actualDeadline: '2026-12-24' }),              // One reviews
    mk(3, { officers: [ONE, TWO] }),                                                                                  // no date
    mk(4, { officers: [ONE], managers: [ONE], deadlineType: 'Imaginary', promisedDate: '2026-11-18' }),               // both: under mine, passed
    mk(5, { officers: [THREE], managers: [REV, ONE] }),                                                               // One reviews, no date
    mk(6, { officers: [THREE] }),                                                                                     // not on One's list
    mk(7, { officers: [ONE], open: false }),                                                                          // not open
  ];
  const o = { me: null, names: T.names(rows), meta: META, today: TODAY };
  const L = T.listFor(rows, 'p:111', o);
  assert.deepEqual([L.who, L.name, L.title], ['p:111', 'Officer One', 'To-do · Officer One']);
  assert.deepEqual(L.groups.map((g) => [g.key, g.title, g.section, idsOf(g.rows), g.passed, g.noDate]), [
    ['p:111|mine', "Officer One's cases", 'mine', '1,3,4', 2, 1],
    ['p:111|review', 'With Officer One for review', 'review', '2,5', 0, 1],
  ]);
  // a stable split: the caller's order (here: soonest first) is the order under each heading
  const sorted = T.listFor(T.order(rows), 'p:111', o);
  assert.deepEqual(sorted.groups.map((g) => idsOf(g.rows)), ['1,4,3', '2,5']);
  // only review cases: one group; only own cases: one group; none: no group
  assert.deepEqual(T.listFor(rows, 'p:211', o).groups.map((g) => [g.key, g.title, idsOf(g.rows)]), [['p:211|review', 'With Reviewer One for review', '1,5']]);
  assert.deepEqual(T.listFor(rows, 'p:113', o).groups.map((g) => [g.key, g.title, idsOf(g.rows)]), [['p:113|mine', "Officer Three's cases", '5,6']]);
  const gone = T.listFor(rows, 'p:999', o);
  assert.deepEqual([gone.who, gone.name, gone.title, gone.groups], ['p:999', 'Monday user 999', 'To-do · Monday user 999', []]);
  // every row under a heading is on that list, once
  for (const who of ['p:111', 'p:112', 'p:113', 'p:211']) {
    const all = T.listFor(rows, who, o).groups.flatMap((g) => g.rows);
    assert.equal(idsOf(all.slice().sort((a, b) => a.id - b.id)), idsOf(rows.filter((r) => T.has(r, who, null))), who);
    assert.equal(new Set(all).size, all.length);
  }
});

test('listFor() for me: "My cases" and "With me for review"; my teams\' cases are mine; the keys carry the list, so open / closed is remembered per list', () => {
  const rows = [
    mk(1, { officers: [ONE] }), mk(2, { officerTeams: [TEAM9] }), mk(3, { officers: [TWO], managers: [ONE] }), mk(4, { officers: [TWO], managerTeams: [TEAM9] }), mk(5, { officers: [TWO] }),
  ];
  const I = me(ONE, ['9']);
  const L = T.listFor(rows, 'me', { me: I, names: T.names(rows), meta: META, today: TODAY });
  assert.deepEqual([L.who, L.name, L.title], ['me', 'Officer One', 'To-do · Officer One'], 'the title says whose list it is (a printed list too)');
  assert.deepEqual(L.groups.map((g) => [g.key, g.title, g.section, idsOf(g.rows)]), [['me|mine', 'My cases', 'mine', '1,2'], ['me|review', 'With me for review', 'review', '3,4']]);
  // the same person opened by name by somebody else: the same split of their OWN cases, under other keys and other words
  const byName = T.listFor(rows, 'p:111', { me: me(TWO), names: T.names(rows), meta: META, today: TODAY });
  assert.deepEqual(byName.groups.map((g) => [g.key, g.title, idsOf(g.rows)]), [['p:111|mine', "Officer One's cases", '1'], ['p:111|review', 'With Officer One for review', '3']]);
  const keys = (who, m) => T.listFor(rows, who, { me: m, names: T.names(rows), meta: META, today: TODAY }).groups.map((g) => g.key);
  const all = [].concat(keys('me', I), keys('p:112', I), keys('t:9', I), keys('nobody', I));
  assert.equal(new Set(all).size, all.length, 'no two lists share a heading key');
  for (const k of all) assert.equal(CMU.groupId(k), k, 'a plain text key, as the page keeps it');
  // my name: the sign-in's; else the one the rows know; else "My list"
  const t = (m) => T.listFor(rows, 'me', { me: m, names: T.names(rows) }).title;
  assert.equal(t({ id: '111', name: '', teamIds: [] }), 'To-do · Officer One');
  assert.equal(t({ id: '777', name: '', teamIds: [] }), 'To-do · My list');
  assert.equal(t({ id: '777', name: 'New Starter', teamIds: [] }), 'To-do · New Starter');
  // "me" without a Monday sign-in is no list of anybody's
  assert.deepEqual(T.listFor(rows, 'me', { me: null, names: {} }).groups, []);
});

test('listFor() for a team: the team\'s own entry, with its name', () => {
  const rows = [mk(1, { officerTeams: [TEAM9] }), mk(2, { officers: [ONE], managerTeams: [TEAM9] }), mk(3, { officers: [ONE] })];
  const L = T.listFor(rows, 't:9', { me: null, names: T.names(rows), today: TODAY });
  assert.deepEqual([L.title, L.groups.map((g) => [g.key, g.title, idsOf(g.rows)])], ['To-do · Team Nine', [['t:9|mine', "Team Nine's cases", '1'], ['t:9|review', 'With Team Nine for review', '2']]]);
});

test('listFor("nobody"): grouped by Case Stage in the BOARD\'s stage order (as the Assigning tab), keys "nobody|<stage index>", titles = the stage names, with the passed / no-deadline counts', () => {
  const st = (id, idx, name, extra) => mk(id, { stageIdx: idx, caseStage: name, ...extra });
  const rows = [
    st(1, 16, 'ADR'), st(2, 2, 'Stuck', { deadlineType: 'Deadline', actualDeadline: '2026-10-01' }), st(3, 12, 'Pre-Onboarding'), st(4, 0, 'Document Collection Started', { deadlineType: 'Deadline', actualDeadline: '2027-01-05' }),
    st(5, 12, 'Pre-Onboarding', { deadlineType: 'Imaginary', promisedDate: '2026-11-18' }), st(6, 7, 'Submission Ready'), st(7, 1, 'Internal Review', { officers: [ONE] }), st(9, 12, 'Pre-Onboarding', { open: false }),
  ];
  const L = T.listFor(rows, 'nobody', { me: null, names: T.names(rows), meta: META, today: TODAY });
  assert.deepEqual([L.who, L.name, L.title], ['nobody', 'No one assigned', 'To-do · No one assigned']);
  assert.deepEqual(L.groups.map((g) => [g.key, g.title, g.section, g.stageIdx, idsOf(g.rows), g.passed, g.noDate]), [
    ['nobody|0', 'Document Collection Started', 'nobody', 0, '4', 0, 0],
    ['nobody|7', 'Submission Ready', 'nobody', 7, '6', 0, 1],
    ['nobody|2', 'Stuck', 'nobody', 2, '2', 1, 0],
    ['nobody|12', 'Pre-Onboarding', 'nobody', 12, '3,5', 1, 1],
    ['nobody|16', 'ADR', 'nobody', 16, '1', 0, 1],
  ], 'by label position: Submission Ready above Stuck, ADR after Pre-Onboarding');
  // a row with no stage (it cannot be in the Assigning view, but a heading must never be lost): its own group, titled with a dash
  assert.deepEqual(T.listFor([st(8, 5, 'Unknown')], 'nobody', { names: {}, meta: META, today: TODAY }).groups.map((g) => [g.key, g.title, idsOf(g.rows)]), [['nobody|5', '—', '8']]);
  // the same order the Assigning tab draws its headings in
  const assigning = cmv.pageViews().find((v) => v.key === 'assigning');
  assert.deepEqual(L.groups.map((g) => g.title), CMU.groupRows(assigning, rows.filter((r) => T.has(r, 'nobody', null)), META).map((g) => g.title));
  // without the board meta (a failed read): label-index order, never an error
  assert.deepEqual(T.listFor(rows, 'nobody', { names: {}, today: TODAY }).groups.map((g) => g.key), ['nobody|0', 'nobody|2', 'nobody|7', 'nobody|12', 'nobody|16']);
  // the tab's own definition is never what groupRows is given: its grouping is not one the page knows (every row would fall under one blank heading)
  assert.equal(CMU.groupRows(svc.PAGE_VIEW, rows.filter((r) => T.has(r, 'nobody', null)), META).length, 1);
  assert.ok(todoUi.toString().includes('CMU.groupRows(STAGE_VIEW, on, o.meta || null)'));
  // nobody left: no groups
  assert.deepEqual(T.listFor([mk(1, { officers: [ONE] })], 'nobody', { names: {}, today: TODAY }).groups, []);
});

test('listFor() with no list chosen: the title "To-do" and no groups; a row that is not on the list is never drawn under it', () => {
  const rows = [mk(1, { officers: [ONE] }), mk(2)];
  for (const who of ['', null, undefined, 'everyone', 'p:']) assert.deepEqual(T.listFor(rows, who, { names: T.names(rows), today: TODAY }), { who: '', name: '', title: 'To-do', groups: [] });
  assert.deepEqual(T.listFor(rows, 'p:111', {}).groups.map((g) => idsOf(g.rows)), ['1']);
  assert.deepEqual(T.listFor(null, 'p:111', null).groups, []);
  // no today given: nothing is counted as passed, the no-deadline count still works
  const g = T.listFor([mk(1, { officers: [ONE], deadlineType: 'Deadline', actualDeadline: '2020-01-01' }), mk(2, { officers: [ONE] })], 'p:111', {}).groups[0];
  assert.deepEqual([g.passed, g.noDate], [0, 1]);
});

/* ── the "With" pill ── */

test('withNames(): the Case Manager names, less the person whose list it is — "With …" in their own cases, "Also with …" in their review cases; an empty list is a dash', () => {
  const rows = [
    mk(1, { officers: [ONE], managers: [REV] }),
    mk(2, { officers: [ONE], managers: [REV, REV2] }),            // two managers
    mk(3, { officers: [ONE], managers: [ONE] }),                  // officer = manager
    mk(4, { officers: [ONE] }),                                   // nobody has it for review
    mk(5, { officers: [TWO], managers: [REV], managerTeams: [TEAM8] }),
  ];
  const nm = T.names(rows.concat([mk(90, { managerTeams: [TEAM8] })]));
  const w = (r, who, section, m) => T.withNames(r, who, section, nm, m || null);
  // the officer's own section: who has it for review
  assert.deepEqual(w(rows[0], 'p:111', 'mine'), { lead: 'With', list: ['Reviewer One'] });
  assert.deepEqual(w(rows[1], 'p:111', 'mine'), { lead: 'With', list: ['Reviewer One', 'Reviewer Two'] });
  assert.deepEqual(w(rows[2], 'p:111', 'mine'), { lead: 'With', list: [] }, 'the only manager is the person themself: a dash, never "With <own name>"');
  assert.deepEqual(w(rows[3], 'p:111', 'mine'), { lead: 'With', list: [] });
  // the reviewer's section: never their own name; the other managers read "Also with"
  assert.deepEqual(w(rows[0], 'p:211', 'review'), { lead: 'Also with', list: [] });
  assert.deepEqual(w(rows[1], 'p:211', 'review'), { lead: 'Also with', list: ['Reviewer Two'] });
  assert.deepEqual(w(rows[1], 'p:212', 'review'), { lead: 'Also with', list: ['Reviewer One'] });
  assert.deepEqual(w(rows[4], 'p:211', 'review'), { lead: 'Also with', list: ['Team Eight'] });
  assert.deepEqual(w(rows[4], 't:8', 'review'), { lead: 'Also with', list: ['Reviewer One'] });
  // my own list: me and my teams are left out
  assert.deepEqual(w(rows[0], 'me', 'review', me(REV)), { lead: 'Also with', list: [] });
  assert.deepEqual(w(rows[4], 'me', 'review', me(REV, ['8'])), { lead: 'Also with', list: [] });
  assert.deepEqual(w(rows[4], 'me', 'review', me(['555', 'In Team Eight'], ['8'])), { lead: 'Also with', list: ['Reviewer One'] });
  assert.deepEqual(w(rows[2], 'me', 'mine', me(ONE)), { lead: 'With', list: [] });
  assert.deepEqual(w(rows[0], 'me', 'mine', me(ONE)), { lead: 'With', list: ['Reviewer One'] });
  // "No one assigned", no list, another tab: "With" and every manager
  for (const [who, section] of [['nobody', 'nobody'], ['', ''], ['', undefined], ['p:211', ''], ['p:211', 'other'], [null, null]]) {
    assert.deepEqual(w(rows[1], who, section), { lead: 'With', list: ['Reviewer One', 'Reviewer Two'] }, JSON.stringify([who, section]));
    assert.deepEqual(w(rows[3], who, section), { lead: 'With', list: [] });
  }
});

test('withNames(): never "Unassigned"; an id with no name falls back to the cell\'s own names; a row without managerIds shows the cell\'s names', () => {
  const nm = { 'p:211': 'Reviewer One', 'p:111': 'Officer One' };
  // an empty Case Manager cell reads "Unassigned" on the row
  const empty = mk(1, { officers: [ONE] });
  assert.equal(empty.manager, 'Unassigned');
  for (const section of ['mine', 'review', 'nobody', '']) assert.deepEqual(T.withNames(empty, 'p:111', section, nm, null).list, []);
  const bare = mk(2, { officers: [ONE] }); delete bare.managerIds;
  assert.deepEqual(T.withNames(bare, 'p:111', 'mine', nm, null), { lead: 'With', list: [] });
  // people and a team together that never paired: the ids have no names, the cell's text has them all
  const mixed = mk(3, { officers: [ONE], managers: [REV, REV2], managerTeams: [TEAM8] });
  assert.deepEqual(T.withNames(mixed, 'p:111', 'mine', nm, null), { lead: 'With', list: ['Reviewer One', 'Reviewer Two', 'Team Eight'] });
  assert.deepEqual(T.withNames(mixed, 'p:211', 'review', nm, null), { lead: 'Also with', list: ['Reviewer Two', 'Team Eight'] }, 'the name of the person whose list it is is still left out');
  assert.deepEqual(T.withNames(mixed, 'me', 'review', {}, me(REV)), { lead: 'Also with', list: ['Reviewer Two', 'Team Eight'] }, 'my own name comes from the sign-in when the rows do not know it');
  // ids and no text at all: the stand-in name, never a blank pill
  const noText = mk(4, { officers: [ONE], manager: '', managerIds: { personIds: ['299'], teamIds: ['29'] } });
  assert.deepEqual(T.withNames(noText, 'p:111', 'mine', nm, null).list, ['Monday user 299', 'Monday team 29']);
  // a row that came without managerIds (the answer had no tab fields): the cell's names as they are
  const old = mk(5, { officers: [ONE], manager: 'Reviewer One, Reviewer Two' }); delete old.managerIds;
  assert.deepEqual(T.withNames(old, '', '', nm, null), { lead: 'With', list: ['Reviewer One', 'Reviewer Two'] });
  assert.deepEqual(T.withNames(old, 'p:211', 'review', nm, null), { lead: 'Also with', list: ['Reviewer Two'] });
  // a name is never repeated; nothing given = an empty pill, no error
  const twice = mk(6, { officers: [ONE], managers: [REV, ['213', 'Reviewer One']] });
  assert.deepEqual(T.withNames(twice, 'p:111', 'mine', { 'p:211': 'Reviewer One', 'p:213': 'Reviewer One' }, null).list, ['Reviewer One']);
  assert.deepEqual(T.withNames(null, null, null, null, null), { lead: 'With', list: [] });
  assert.deepEqual(T.withNames({}, 'me', 'mine', {}, null), { lead: 'With', list: [] });
});

/* ── names from Monday are text ── */

test('a name from Monday is handed on as it is, never built into markup here: through the page\'s own escaping it shows as text in the picker, the headings, the title and the pill', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const at = src.indexOf('function escHtml(s) {');
  const escHtml = vm.runInNewContext('(' + src.slice(at, src.indexOf('\n}\n', at) + 2) + ')');
  assert.equal(escHtml('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
  const EVIL = ['666', '<img src=x onerror="alert(1)">&amp;'], EVIL2 = ['667', '"><script>alert(2)</script>'];
  const rows = [mk(1, { officers: [EVIL], managers: [EVIL2] }), mk(2, { officers: [ONE], managers: [EVIL] })];
  const nm = T.names(rows);
  assert.equal(nm['p:666'], EVIL[1], 'kept letter for letter: the page escapes, this helper does not');
  const I = { id: '666', name: EVIL[1], teamIds: [] };
  const ppl = T.people(rows, null, 'all');
  const strings = []
    .concat(ppl.list.map((e) => e.name), [T.people(rows, I, 'all').me.name])
    .concat(['p:666', 'p:667', 'me'].flatMap((who) => { const L = T.listFor(rows, who, { me: I, names: nm, today: TODAY }); return [L.title, L.name].concat(L.groups.map((g) => g.title)); }))
    .concat(T.withNames(rows[0], 'p:666', 'mine', nm, null).list, T.withNames(rows[1], 'p:111', 'mine', nm, null).list, [T.nameOf('p:667', nm)]);
  assert.ok(strings.some((x) => x.includes('<img')) && strings.some((x) => x.includes('<script>')), 'the names really are in there');
  for (const x of strings) {
    const shown = escHtml(x);
    assert.ok(!/[<>"]/.test(shown), shown);
    assert.ok(!/<[a-z]/i.test(x.replace(EVIL[1], '').replace(EVIL2[1], '')), 'no markup of the helper\'s own around a name: ' + x);
  }
  // an aria-label built from a name and a count is escaped the same way
  assert.ok(!/[<>"]/.test(escHtml(ppl.list[0].name + ', ' + ppl.list[0].total + ' cases')));
});

/* ── real-shape rows ── */

test('on the real capture (ids only): every open case is on someone\'s list or under "No one assigned", never both; the numbers add up and agree with the Assigning tab\'s own count', () => {
  const title = Object.fromEntries(META.groups.map((g) => [g.id, g.title]));
  const rows = CAPTURE.rows.map((r, i) => dash.parseItem({ id: String(i), name: '', created_at: '', group: r.groupId ? { id: r.groupId, title: title[r.groupId] || '' } : null, column_values: r.cells }, i));
  // what the route does when the tab is on: mark the open rows
  const prev = process.env.TODO_TAB;
  process.env.TODO_TAB = 'on';
  try { assert.deepEqual(svc.forAnswer(rows, null, () => false), { me: null }); } finally { if (prev === undefined) delete process.env.TODO_TAB; else process.env.TODO_TAB = prev; }
  const open = T.open(rows), assigning = rows.filter((r) => r.views.includes('assigning'));
  assert.equal(open.length, assigning.length);
  assert.ok(open.length > 100, 'the capture has its open cases');
  const ppl = T.people(rows, null, 'all');
  // the capture has no Case Manager cells, so "No one assigned" is exactly the Assigning tab's "No Support Officer" number
  assert.equal(ppl.nobody.total, CMU.noOfficerCount(assigning, cmv.PRE_ONBOARDING_INDEX).n);
  let onLists = 0;
  for (const r of open) {
    const lists = ppl.list.filter((e) => T.has(r, e.key, null)).length, none = T.has(r, 'nobody', null);
    assert.equal(lists > 0, !none);
    if (lists) onLists++;
  }
  assert.equal(onLists + ppl.nobody.total, open.length);
  for (const e of ppl.list) {
    assert.equal(e.total, e.mine + e.review);
    assert.equal(open.filter((r) => T.has(r, e.key, null)).length, e.total);
    assert.ok(/^Monday (user|team) [0-9]+$/.test(e.name), 'no names in the capture: the stand-in');
    const L = T.listFor(T.order(open), e.key, { me: null, names: {}, meta: META, today: TODAY });
    assert.equal(L.groups.reduce((n, g) => n + g.rows.length, 0), e.total);
    for (const g of L.groups) { const due = g.rows.map((r) => T.dueDate(r) || '9999-99-99'); assert.deepEqual(due, due.slice().sort(), 'soonest first under each heading'); }
  }
  // the sum of the lists is at least the cases on them (a case with two officers is on both)
  assert.ok(ppl.list.reduce((n, e) => n + e.mine, 0) >= onLists);
  // "No one assigned" by stage: the same headings, in the same order, as the Assigning tab gives those rows
  const none = T.listFor(open, 'nobody', { me: null, names: {}, meta: META, today: TODAY });
  assert.equal(none.groups.reduce((n, g) => n + g.rows.length, 0), ppl.nobody.total);
  const view = cmv.pageViews().find((v) => v.key === 'assigning');
  assert.deepEqual(none.groups.map((g) => [g.title, g.rows.length]), CMU.groupRows(view, open.filter((r) => T.has(r, 'nobody', null)), META).map((g) => [g.title, g.rows.length]));
  // a row outside the Assigning view is on no list
  for (const r of rows.filter((x) => !x.views.includes('assigning')).slice(0, 50)) for (const e of ppl.list.slice(0, 3)) assert.equal(T.has(r, e.key, null), false);
});
