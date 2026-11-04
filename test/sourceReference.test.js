'use strict';

// "Source / Reference" (team meeting, Faran 2026-11-04): the lead source list grew
// (social sites, Website, the referral kinds, three named referrers); Employee
// Referral asks which employee, Existing Client / Client Referral ask which client
// (searched on the OLD Consultations board, or typed). The answer is saved in the
// lead's "Referred By" column AT creation. No network: stubs only.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const SRC         = require('../config/leadSources');
const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const blacklist   = require('../src/services/blacklistService');
const dir         = require('../src/services/oldClientDirectory');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// The Leads board "Source / Reference" dropdown (dropdown_mm44g4xg) labels, read live on 2026-11-04
// after the 9 new ones were added. Every staff choice MUST be one of them: create_item cannot add labels.
const BOARD_LABELS_2026_11_04 = ['Website', 'Email', 'WhatsApp', 'Instagram', 'Phone', 'Other', 'Direct Retainer',
  'Facebook', 'TikTok', 'LinkedIn', 'Client Referral', 'Employee Referral', 'Existing Client', 'Nasir Khan', 'Aman Galhotra', 'Shafoli Friend'];

test('the list: every choice is an existing board label (exact spelling), no duplicates, never Direct Retainer; 14 employees', () => {
  for (const s of SRC.LEAD_SOURCES) assert.ok(BOARD_LABELS_2026_11_04.includes(s), `"${s}" is not a label on the board — add it on Monday first`);
  assert.equal(new Set(SRC.LEAD_SOURCES).size, SRC.LEAD_SOURCES.length);
  assert.ok(!SRC.LEAD_SOURCES.includes('Direct Retainer'));
  assert.deepEqual(BOARD_LABELS_2026_11_04.filter((l) => l !== 'Direct Retainer').sort(), [...SRC.LEAD_SOURCES].sort(), 'every board label except Direct Retainer is offered');
  assert.equal(SRC.REFERRAL_EMPLOYEES.length, 14);
  assert.equal(new Set(SRC.REFERRAL_EMPLOYEES).size, 14);
  assert.ok(SRC.LEAD_SOURCES.includes(SRC.EMPLOYEE_REFERRAL));
  for (const c of SRC.CLIENT_REFERRAL_SOURCES) assert.ok(SRC.LEAD_SOURCES.includes(c));
  // the Added-by roster is a different list and is NOT changed
  assert.ok(!require('../config/portalStaff').staffRoster().includes('Ali Ashrafi'));
});

test('checkReferral: employee from the list only; a client name required (≤120); other sources ask nothing', () => {
  assert.deepEqual(SRC.checkReferral('Employee Referral', ' Gauri  Berde '), { ok: true, referredBy: 'Gauri Berde' });
  assert.equal(SRC.checkReferral('Employee Referral', '').ok, false);
  assert.equal(SRC.checkReferral('Employee Referral', 'Gauri').ok, false, 'must be the exact list name');
  assert.equal(SRC.checkReferral('Employee Referral', 'Somebody').ok, false);
  assert.deepEqual(SRC.checkReferral('Existing Client', 'Jane Doe'), { ok: true, referredBy: 'Jane Doe' });
  assert.deepEqual(SRC.checkReferral('Client Referral', 'Jane Doe'), { ok: true, referredBy: 'Jane Doe' });
  assert.equal(SRC.checkReferral('Existing Client', '   ').ok, false);
  assert.equal(SRC.checkReferral('Client Referral', 'x'.repeat(121)).ok, false);
  assert.deepEqual(SRC.checkReferral('Nasir Khan', 'ignored'), { ok: true, referredBy: '' });
  assert.deepEqual(SRC.checkReferral('Phone', 'ignored'), { ok: true, referredBy: '' });
  assert.equal(SRC.referralKind('Employee Referral'), 'employee');
  assert.equal(SRC.referralKind('Existing Client'), 'client');
  assert.equal(SRC.referralKind('Client Referral'), 'client');
  assert.equal(SRC.referralKind('Shafoli Friend'), '');
});

// ── Add lead ────────────────────────────────────────────────────────────────
const VALID = { fullName: 'New Caller', email: 'new@x.com', phone: '4165550001', sourceChannel: 'Phone', inCanada: 'Yes', addedBy: 'Melanie' };
function addWorld() {
  const calls = { created: [], updates: [], notes: [] };
  const restore = [
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
    stub(leadService, 'createLead', async (f) => { calls.created.push(f); return { id: '9300', ...f }; }),
    stub(leadService, 'updateLead', async (id, f) => { calls.updates.push({ id, f }); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.b); return {}; }),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}

test('Add lead: every new choice is accepted; the referrer is written AT creation (never in the best-effort follow-up)', async () => {
  const w = addWorld();
  try {
    for (const s of ['Facebook', 'TikTok', 'LinkedIn', 'Website', 'Nasir Khan', 'Aman Galhotra', 'Shafoli Friend', 'Other']) {
      await portal.createStaffLead({ ...VALID, email: `${s.replace(/\W/g, '')}@x.com`, sourceChannel: s, referredBy: 'should be ignored' });
      const c = w.calls.created[w.calls.created.length - 1];
      assert.equal(c.sourceChannel, s);
      assert.equal('referredBy' in c, false, `${s}: no second question → nothing written`);
    }
    await portal.createStaffLead({ ...VALID, email: 'emp@x.com', sourceChannel: 'Employee Referral', referredBy: 'Shermin Teymouri Mofrad' });
    assert.equal(w.calls.created.at(-1).referredBy, 'Shermin Teymouri Mofrad');
    await portal.createStaffLead({ ...VALID, email: 'cli@x.com', sourceChannel: 'Existing Client', referredBy: 'Jane <b>Doe</b>', referredFrom: 'list' });
    assert.equal(w.calls.created.at(-1).referredBy, 'Jane <b>Doe</b>', 'stored as typed (a text column); escaped only where shown');
    await portal.createStaffLead({ ...VALID, email: 'ref@x.com', sourceChannel: 'Client Referral', referredBy: 'Old Client', referredFrom: 'typed' });
    assert.equal(w.calls.created.at(-1).referredBy, 'Old Client');
    for (const u of w.calls.updates) assert.equal('referredBy' in u.f, false, 'never in the follow-up write');
    // the note: escaped, says where the client name came from
    assert.ok(w.calls.notes.some((b) => /source \/ reference: Employee Referral \(referred by Shermin Teymouri Mofrad\)\./.test(b)));
    assert.ok(w.calls.notes.some((b) => b.includes('source / reference: Existing Client (referred by Jane &lt;b&gt;Doe&lt;/b&gt;, picked from the old Consultations board)')));
    assert.ok(w.calls.notes.some((b) => b.includes('source / reference: Client Referral (referred by Old Client, name typed by hand)')));
  } finally { w.done(); }
});

test('Add lead: the second question is required and checked on the server; nothing is created when it fails', async () => {
  const w = addWorld();
  try {
    const bad = [
      [{ sourceChannel: 'Employee Referral' }, /which employee/],
      [{ sourceChannel: 'Employee Referral', referredBy: 'Gauri' }, /employee from the list/],
      [{ sourceChannel: 'Existing Client' }, /client from the list, or type/],
      [{ sourceChannel: 'Client Referral', referredBy: '  ' }, /client from the list, or type/],
      [{ sourceChannel: 'Existing Client', referredBy: 'y'.repeat(121) }, /too long/],
    ];
    for (const [b, re] of bad) await assert.rejects(portal.createStaffLead({ ...VALID, ...b }), (e) => e.badRequest === true && re.test(e.message), JSON.stringify(b));
    assert.equal(w.calls.created.length, 0);
  } finally { w.done(); }
});

test('createLead writes Referred By in the create_item columns (text column, empty skipped)', async () => {
  const tok = require('../src/services/leadTokenService');
  const od = require('../src/services/oneDriveService');
  const cols = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_item/.test(q)) { cols.push(JSON.parse(v.cols)); return { create_item: { id: '555' } }; }
      return {};
    }),
    stub(tok, 'ensureToken', async () => 'tok'),
    stub(od, 'ensureLeadFolder', () => Promise.reject(new Error('no onedrive in tests'))),
  ];
  try {
    const C = require('../src/data/newLeadsBoard.json').columns;
    await leadService.createLead({ fullName: 'A B', sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde' });
    assert.equal(cols[0][C.referredBy], 'Gauri Berde');
    assert.deepEqual(cols[0][C.sourceChannel], { labels: ['Employee Referral'] });
    await leadService.createLead({ fullName: 'C D', sourceChannel: 'Phone' });
    assert.equal(C.referredBy in cols[1], false, 'nothing empty is written');
  } finally { restore.reverse().forEach((r) => r()); await new Promise((r) => setImmediate(r)); }
});

// ── Edit basics on the lead page ─────────────────────────────────────────────
const BASE = { id: '5', fullName: 'Asha Rao', name: 'Asha Rao', email: 'asha@example.com', phone: '4165550101', sourceChannel: 'Website', caseTypeInterest: '', referredBy: '', bookingInvite: '', bookingStatus: 'Not Yet' };
const BODY = { fullName: 'Asha Rao', email: 'asha@example.com', phone: '4165550101', sourceChannel: 'Website', caseTypeInterest: '' };
function editWorld(lead = {}) {
  const calls = { updates: [], notes: [] };
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ ...BASE, ...lead, id })),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(leadService, 'renameLead', async () => {}),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.b); return {}; }),
    stub(portal, 'findClientMatches', async () => ({ leads: [], cases: [], clients: [] })),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
  ];
  const act = (body) => portal.applyAction({ leadId: '5', action: 'saveBasicInfo', value: JSON.stringify({ ...BODY, ...body }), staffName: 'Gauri' });
  return { calls, act, done: () => restore.reverse().forEach((r) => r()) };
}

test('Edit basics: switching to a referral source needs the second answer; it is saved and noted', async () => {
  const w = editWorld();
  try {
    await assert.rejects(w.act({ sourceChannel: 'Employee Referral' }), /which employee/);
    await assert.rejects(w.act({ sourceChannel: 'Employee Referral', referredBy: 'Not Staff' }), /employee from the list/);
    await assert.rejects(w.act({ sourceChannel: 'Existing Client', referredBy: '' }), /client from the list, or type/);
    assert.equal(w.calls.updates.length, 0);
    const r = await w.act({ sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde' });
    assert.deepEqual(w.calls.updates[0].f, { sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde' });
    assert.match(w.calls.notes[0], /Source \/ reference “Employee Referral” \(was “Website”\); Referred by “Gauri Berde” \(was \(empty\)\)\./);
    assert.match(r.message, /^Saved: source \/ reference, referred by\.$/);
  } finally { w.done(); }
});

test('Edit basics: moving AWAY from a referral source clears the staff pick; other sources leave Referred By alone', async () => {
  let w = editWorld({ sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde' });
  try {
    await w.act({ sourceChannel: 'Phone' });   // the page sends no referredBy for a non-referral source
    assert.deepEqual(w.calls.updates[0].f, { sourceChannel: 'Phone' });
    assert.deepEqual(w.calls.updates[0].o, { clearKeys: ['referredBy'] });
  } finally { w.done(); }
  // a website lead whose public form said who referred them: untouched by an unrelated edit, even if '' is sent
  w = editWorld({ sourceChannel: 'Website', referredBy: 'Friend From Form' });
  try {
    await w.act({ fullName: 'Asha K Rao', referredBy: '' });
    assert.deepEqual(w.calls.updates[0].f, { fullName: 'Asha K Rao' });
    assert.deepEqual(w.calls.updates[0].o, { clearKeys: [] });
    await w.act({ sourceChannel: 'Phone' });
    assert.deepEqual(w.calls.updates[1].o, { clearKeys: [] }, 'Website was not a staff referral — nothing cleared');
  } finally { w.done(); }
});

test('Edit basics: an unchanged referral passes (even an old off-list value, or an empty one); a page from before the release (no key) changes nothing', async () => {
  let w = editWorld({ sourceChannel: 'Employee Referral', referredBy: 'Former Staff' });
  try {
    await w.act({ sourceChannel: 'Employee Referral', referredBy: 'Former Staff', fullName: 'Asha R' });
    assert.deepEqual(w.calls.updates[0].f, { fullName: 'Asha R' });
    await w.act({ sourceChannel: 'Employee Referral', fullName: 'Asha R2' });   // no referredBy key at all
    assert.deepEqual(w.calls.updates[1].f, { fullName: 'Asha R2' });
    assert.deepEqual(w.calls.updates[1].o, { clearKeys: [] });
    await assert.rejects(w.act({ sourceChannel: 'Employee Referral', referredBy: 'Also Not Staff' }), /employee from the list/, 'a CHANGED answer is checked');
  } finally { w.done(); }
  w = editWorld({ sourceChannel: 'Existing Client', referredBy: '' });   // set by hand on Monday, never answered
  try {
    await w.act({ sourceChannel: 'Existing Client', referredBy: '', fullName: 'Asha R' });
    assert.deepEqual(w.calls.updates[0].f, { fullName: 'Asha R' }, 'an unrelated fix is not blocked');
  } finally { w.done(); }
});

test('the lead detail carries referredBy; staffAdded stays false for Website (archive line reads "Not found")', () => {
  const src = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /referredBy:\s+\(lead\.referredBy \|\| ''\)\.trim\(\)/);
  assert.match(src, /staffAdded:\s+isStaffSource\(lead\.sourceChannel\)/);
  assert.match(src, /const isStaffSource = \(src\) => \{ const s = String\(src \|\| ''\)\.trim\(\); return s !== 'Website' && STAFF_LEAD_SOURCES\.includes\(s\); \};/);
});

// ── Walk-in (direct retainer) link keeps a saved referrer ────────────────────
test('linking a lead as a direct retainer client keeps a saved Referred By; fills it only when empty', async () => {
  const registry = require('../src/services/caseTypeRegistryService');
  const handoff = require('../src/services/handoffService');
  const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  const CASE_TYPE = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
  const run = async (existing, referredBy) => {
    const updates = [], notes = [];
    const restore = [
      stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
      stub(leadService, 'getLead', async () => ({ id: '300', fullName: 'Same Person', sourceChannel: 'Phone', clientMasterItemId: '', conversionStatus: '', retainerSent: '', ...existing })),
      stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
      stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
      stub(handoff, 'openCaseEarly', async () => 'CM-300'),
      stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
      stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b); return {}; }),
    ];
    try {
      await portal.createDirectClient({ fullName: 'Same Person', email: 'dup@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: 'Shermin Teymouri Mofrad', linkLeadId: '300', referredBy });
      return { f: updates.find((u) => u.id === '300').f, notes };
    } finally { restore.reverse().forEach((x) => x()); }
  };
  const a = await run({ referredBy: 'Gauri Berde' }, 'Someone <i>Else</i>');
  assert.equal('referredBy' in a.f, false, 'the saved referrer is kept');
  assert.ok(a.notes.some((b) => b.includes('Referred by kept as “Gauri Berde” (the form said “Someone &lt;i&gt;Else&lt;/i&gt;”).')));
  const b = await run({ referredBy: '' }, 'Walk-in Friend');
  assert.equal(b.f.referredBy, 'Walk-in Friend', 'empty → filled from the form');
  const c = await run({ referredBy: 'Gauri Berde' }, 'Gauri Berde');
  assert.ok(!c.notes.some((n) => /Referred by kept as/.test(n)), 'same name → no note');
  assert.equal('referredBy' in c.f, false);
});

// ── The old Consultations board directory ───────────────────────────────────
const ROWS = [
  { id: '1', name: 'Harpreet Kaur', phone: '+1 416 555 0101', email: 'hk1@x.com', date: '2024-03-02', retained: 'No' },
  { id: '2', name: 'harpreet  kaur', phone: '4165550101', email: '', date: '2025-07-10', retained: 'Yes' },     // same person (same phone)
  { id: '3', name: 'Harpreet Kaur', phone: '6475550202', email: 'hk2@x.com', date: '2025-01-05', retained: '' }, // a DIFFERENT Harpreet Kaur
  { id: '4', name: 'Raj Singh', phone: '9055550303', email: 'fam@x.com', date: '2026-10-01', retained: 'already retained' },
  { id: '5', name: 'Simran Singh', phone: '9055550303', email: 'fam@x.com', date: '2026-09-01', retained: 'No' },   // spouse: shared phone + email, other name
  { id: '6', name: 'José Álvarez', phone: '', email: '', date: '2025-02-02', retained: '' },
  { id: '7', name: 'Lone Name', phone: '', email: '', date: '2024-01-01', retained: '' },
  { id: '8', name: 'Lone Name', phone: '2895550404', email: '', date: '2024-05-01', retained: '' },                // keyless row joins the only person of that name
];

test('directory: rows become people — same name + same phone/email joined; same name, other phone kept apart; different names never joined', () => {
  const people = dir.buildPeople(ROWS);
  const hk = people.filter((p) => p.nameKey === 'harpreet kaur');
  assert.equal(hk.length, 2);
  const a = hk.find((p) => p.phones.includes('4165550101'));
  assert.deepEqual([a.id, a.consults, a.lastConsult, a.retained, a.phoneLast3], ['2', 2, '2025-07', true, '101'], 'newest row id; retained if any row was');
  assert.equal(people.filter((p) => p.phones.includes('9055550303')).length, 2, 'spouses stay two people');
  const lone = people.filter((p) => p.nameKey === 'lone name');
  assert.equal(lone.length, 1); assert.equal(lone[0].consults, 2);
  assert.equal(people.find((p) => p.name === 'José Álvarez').nameKey, 'jose alvarez', 'accents folded');
});

test('directory search: name words, phone digits, email start; never returns a full phone or email; max 10', () => {
  const people = dir.buildPeople(ROWS);
  const n = dir.searchPeople(people, 'harp ka');
  assert.equal(n.mode, 'name'); assert.equal(n.results.length, 2);
  assert.deepEqual(Object.keys(n.results[0]).sort(), ['consults', 'id', 'lastConsult', 'matchedOn', 'name', 'phoneLast3', 'retained']);
  assert.ok(!JSON.stringify(n).includes('4165550101') && !JSON.stringify(n).includes('@'), 'no full phone / email');
  assert.equal(dir.searchPeople(people, 'kaur harpreet').results.length, 2, 'word order free');
  assert.equal(dir.searchPeople(people, 'jose').results.length, 1, 'accent-insensitive');
  assert.equal(dir.searchPeople(people, 'arpreet').results.length, 0, 'words match from their start');
  assert.equal(dir.searchPeople(people, 'h').mode, 'short');
  const p = dir.searchPeople(people, '647 555');
  assert.equal(p.mode, 'phone'); assert.deepEqual(p.results.map((r) => r.id), ['3']);
  assert.equal(dir.searchPeople(people, '555').mode, 'short', 'under 4 digits');
  const e = dir.searchPeople(people, 'fam@');
  assert.equal(e.mode, 'email'); assert.equal(e.results.length, 2);
  const many = dir.buildPeople(Array.from({ length: 25 }, (_, i) => ({ id: String(100 + i), name: `Test Person${i}`, phone: `41655510${String(i).padStart(2, '0')}`, date: '2025-01-01' })));
  const m = dir.searchPeople(many, 'test');
  assert.equal(m.results.length, 10); assert.equal(m.more, true);
});

test('directory cache: dormant without config; no copy + failed read → unavailable; a later failure serves the last good copy; reads are shared', async () => {
  const saved = { ...dir.io };
  try {
    dir._reset();
    dir.io.config = () => null;
    assert.equal((await dir.search('harp')).unavailable, true);

    dir._reset();
    dir.io.config = () => ({ boardId: '1', columns: {} });
    dir.io.fetchRows = async () => { throw new Error('monday down'); };
    assert.equal((await dir.search('harp')).unavailable, true);

    dir._reset();
    let t = 1000, reads = 0;
    dir.io.now = () => t;
    dir.io.fetchRows = async () => { reads++; return ROWS; };
    const [r1, r2] = await Promise.all([dir.search('harp'), dir.search('raj')]);
    assert.equal(reads, 1, 'one read shared');
    assert.equal(r1.results.length, 2); assert.equal(r2.results.length, 1);
    dir.io.fetchRows = async () => { reads++; throw new Error('monday down'); };
    t += dir.TTL_MS + 1;
    const r3 = await dir.search('harp');   // served from the copy; the background refresh fails quietly
    assert.equal(r3.ok, true); assert.equal(r3.results.length, 2);
    await new Promise((r) => setImmediate(r));
    assert.equal(reads, 2);
    t += 3 * dir.TTL_MS;
    assert.equal((await dir.search('harp')).stale, true, 'flagged when hours old');
    await new Promise((r) => setImmediate(r));   // let that background refresh settle before the reset
  } finally { Object.assign(dir.io, saved); dir._reset(); }
});

test('directory read: items_page with limit 500 + cursor, the configured columns only, empty status cells read as empty', async () => {
  const qs = [];
  const restore = stub(mondayApi, 'query', async (q, v) => {
    qs.push({ q, v });
    if (!v.cursor) return { boards: [{ items_page: { cursor: 'c2', items: [{ id: '10', name: 'A A', column_values: [
      { id: 'contact_number__1', text: '4165550000', value: '{}' }, { id: 'status1', text: 'Follow-Up', value: null }, { id: 'date4', text: '2025-01-01', value: '{}' }] }] } }] };
    return { boards: [{ items_page: { cursor: null, items: [{ id: '11', name: 'B B', column_values: [{ id: 'status1', text: 'Yes', value: '{"index":1}' }] }] } }] };
  });
  try {
    const cfg = require('../src/data/oldConsultationsBoard.json');
    assert.equal(cfg.boardId, '5821353829');
    const rows = await dir.io.fetchRows(cfg);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].retained, '', 'an empty status cell is empty, not Monday\'s id-5 label');
    assert.equal(rows[1].retained, 'Yes');
    assert.match(qs[0].q, /items_page\(limit: 500, cursor: \$cursor\)/);
    assert.ok(!/mutation/i.test(qs[0].q), 'read-only');
    assert.equal(qs[1].v.cursor, 'c2');
  } finally { restore(); }
});

test('search route: POST, behind the /api team key, never cached, the search text never logged', () => {
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const i = server.indexOf("app.post('/api/old-clients/search'");
  assert.ok(i > server.indexOf("app.use('/api', requireApiKey)"), 'registered after the /api key gate');
  const body = server.slice(i, server.indexOf('\n});', i));
  assert.match(body, /res\.set\('Cache-Control', 'private, no-store'\)/);
  assert.ok(!/console\.(log|warn|error)\([^)]*\bq\b/.test(body), 'q is never logged');
  assert.match(body, /res\.status\(503\)/);
  const sched = fs.readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  assert.match(sched, /oldClientDirectory\.warm\(\)/);
});

// ── The pages ──────────────────────────────────────────────────────────────
test('pages: Source / Reference with all choices; the two second questions; scripts parse; Escape in the results never closes the pop-up', () => {
  const { REFERRAL_UI_JS } = require('../src/routes/referralPicker');
  assert.ok(!REFERRAL_UI_JS.includes('\\'), 'no backslash in browser code inside a template literal');
  const al = require('../src/routes/adminLeads');
  const q = al.buildLeadsQueueHTML(), d = al.buildLeadDetailHTML('7');
  for (const html of [q, d]) {
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
    for (const s of SRC.LEAD_SOURCES) assert.ok(html.includes(`<option>${s}</option>`), s);
    for (const e of SRC.REFERRAL_EMPLOYEES) assert.ok(html.includes(`<option>${e}</option>`), e);
    assert.ok(!html.includes('<option>Direct Retainer</option>'));
    assert.match(html, /if \(e\.key === 'Escape' && mode === 'search' && \(!list\.hidden \|\| state\.textContent === SEARCHING\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); stopSearch\(\); return; \}/);
    assert.match(html, /fetch\('\/api\/old-clients\/search', \{ method: 'POST'/);
  }
  for (const id of ['al-ref-emp', 'al-ref-cli', 'al-ref-list', 'al-ref-mode']) assert.ok(q.includes(`id="${id}"`), id);
  for (const id of ['bd-ref-emp', 'bd-ref-cli', 'bd-ref-list', 'bd-ref-mode']) assert.ok(d.includes(`id="${id}"`), id);
  assert.match(q, /referredBy:AL_REF\.value\(\), referredFrom:AL_REF\.from\(\)/);
  assert.match(q, /AL_REF\.reset\(\);/);
  assert.match(d, /BD_REF\.load\(src\.value, d\.referredBy\|\|''\)/);
  assert.match(d, /kv\('Referred by', d\.referredBy\)/);
});

// ── Review round 1 (2026-11-04): fixes pinned ───────────────────────────────
test('review: a phone typed the usual way (+1, 1-, country code) finds the person; one number with/without a country code is one person', () => {
  const people = dir.buildPeople([
    { id: '1', name: 'Pat Lee', phone: '+1 416 555 0101', date: '2025-01-01' },
    { id: '2', name: 'Amit Shah', phone: '+91 98765 43210', date: '2024-01-01' },
    { id: '3', name: 'Amit Shah', phone: '98765 43210', date: '2025-01-01', retained: 'Yes' },
  ]);
  for (const q of ['+1 416 555 0101', '1-416-555-0101', '14165550101', '416 555 0101', '+1 416 5', '5550101']) {
    assert.deepEqual(dir.searchPeople(people, q).results.map((r) => r.id), ['1'], q);
  }
  assert.equal(people.filter((p) => p.nameKey === 'amit shah').length, 1, 'with and without +91: one person');
  const a = dir.searchPeople(people, '+91 98765 43210').results;
  assert.deepEqual([a.length, a[0].id, a[0].retained, a[0].consults], [1, '3', true, 2]);
});

test('review: names — periods and apostrophes, initials, exact name first; an email cell with two addresses', () => {
  const rows = [
    { id: '1', name: "Maria D'Souza", phone: '4165550101', email: 'neha@gmail.com, neha.work@corp.ca', date: '2025-01-01' },
    { id: '2', name: 'Maria Dsouza', phone: '4165550101', date: '2025-03-01' },
    { id: '3', name: 'A.K. Sharma', date: '2025-01-01' },
    { id: '4', name: 'Mohd. Ali', phone: '6475550000', date: '2025-01-01' },
    { id: '5', name: 'Mohd Ali', phone: '6475550000', date: '2025-02-01' },
    { id: '6', name: "Sean O'Brien", date: '2025-01-01' },
    { id: '7', name: 'Gurpreet', phone: '2895550000', date: '2024-01-01' },
    ...Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i), name: `Gurpreet Singh${i}`, phone: `90555500${String(i).padStart(2, '0')}`, date: '2026-01-01' })),
  ];
  const people = dir.buildPeople(rows);
  assert.equal(people.filter((p) => p.nameKey === 'maria dsouza').length, 1, "D'Souza and Dsouza with one phone: one person");
  assert.equal(people.filter((p) => p.nameKey === 'mohd ali').length, 1, 'Mohd. Ali and Mohd Ali: one person');
  const ids = (q) => dir.searchPeople(people, q).results.map((r) => r.id);
  for (const q of ['dsouza', "D'Souza", 'D’Souza', 'souza', 'maria d']) assert.deepEqual(ids(q), ['2'], q);
  for (const q of ['AK Sharma', 'A K Sharma', 'A.K. Sharma', 'sharma']) assert.deepEqual(ids(q), ['3'], q);
  for (const q of ['OBrien', "O'Brien", 'brien']) assert.deepEqual(ids(q), ['6'], q);
  assert.deepEqual(ids('Mohd. Ali'), ['5']);
  assert.equal(ids('gurpreet')[0], '7', 'the exact one-word name comes first, before 12 newer longer names');
  assert.deepEqual(ids('neha.work@'), ['2'], 'the second address in a cell counts');
});

test('review: the browser code cancels pending searches and late answers; results are not Tab stops; Edit basics never drops a typed-but-unpicked name', () => {
  const { REFERRAL_UI_JS } = require('../src/routes/referralPicker');
  assert.match(REFERRAL_UI_JS, /function cancel\(\)\{ clearTimeout\(timer\); seq\+\+; \}/);
  assert.match(REFERRAL_UI_JS, /function setMode\(m\)\{\s+cancel\(\);/);
  assert.match(REFERRAL_UI_JS, /if \(k !== 'client'\) stopSearch\(\);/);
  assert.match(REFERRAL_UI_JS, /var x = results\[i\]; if \(!x\) return;\s+cancel\(\);/);
  assert.match(REFERRAL_UI_JS, /\{ cancel\(\); closeList\(\); setState\(q \? 'Keep typing/);
  assert.match(REFERRAL_UI_JS, /if \(my !== seq \|\| mode !== 'search' \|\| tdotRefKind\(srcEl\.value\) !== 'client'\) return;/);
  assert.match(REFERRAL_UI_JS, /class="ref-opt" role="option" tabindex="-1"/);
  assert.match(REFERRAL_UI_JS, /pending: function\(\)\{ return tdotRefKind\(srcEl\.value\) === 'client' && mode === 'search' && !picked && !!cli\.value/);
  const d = require('../src/routes/adminLeads').buildLeadDetailHTML('7');
  assert.match(d, /body\.referredBy!==BD_LOADED\.ref \|\| BD_REF\.pending\(\)\)\{ var re=BD_REF\.check\(\);/);
});

// ── Review round 2 (2026-11-04): fixes pinned ───────────────────────────────
test('review 2: spaced and apostrophe spellings find each other and group as one person; non-Latin names stay searchable by phone/email; Ø Ł fold', () => {
  const people = dir.buildPeople([
    { id: '1', name: 'Sean O Brien', phone: '4165550111', date: '2025-01-01' },
    { id: '2', name: 'Maria D Souza', phone: '4165550101', date: '2025-01-01' },
    { id: '3', name: "Maria D'Souza", phone: '416 555 0101', date: '2025-03-01' },
    { id: '4', name: 'Maria Dsouza', phone: '+1 416 555 0101', date: '2025-05-01' },
    { id: '5', name: 'ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ', phone: '4165559999', email: 'g@x.com', date: '2025-01-01' },
    { id: '6', name: 'Øyvind Łukasz', date: '2025-01-01' },
  ]);
  const ids = (q) => dir.searchPeople(people, q).results.map((r) => r.id);
  for (const q of ["O'Brien", 'O’Brien', 'O Brien', 'OBrien', 'brien']) assert.deepEqual(ids(q), ['1'], q);
  for (const q of ["D'Souza", 'D Souza', 'Dsouza', 'souza']) assert.deepEqual(ids(q), ['4'], q);
  const maria = people.filter((p) => p.groupKey === 'mariadsouza');
  assert.deepEqual([maria.length, maria[0].consults], [1, 3], 'three spellings, one phone: one person with 3 consultations');
  assert.deepEqual(ids('g@x'), ['5']); assert.deepEqual(ids('4165559999'), ['5']);
  assert.deepEqual(ids('oyvind'), ['6']); assert.deepEqual(ids('lukasz'), ['6']);
});

test('review 2: phones — partial +91, +1 typed one digit short, "+1 416" by area code only, no false +1 guesses for plain digits', () => {
  const people = dir.buildPeople([
    { id: '1', name: 'Ravi Kumar', phone: '+919876543210', date: '2025-01-01' },
    { id: '2', name: 'Maria Lee', phone: '+1 416 555 0101', date: '2025-01-01' },
    { id: '3', name: 'Quinn Roe', phone: '647-141-6000', date: '2026-01-01' },
    { id: '4', name: 'Pat Lee', phone: '905-861-6475', date: '2024-01-01' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: String(200 + i), name: `Filler ${i}`, phone: `6475${String(i).padStart(6, '0')}`, date: '2026-02-01' })),
  ]);
  const ids = (q) => dir.searchPeople(people, q).results.map((r) => r.id);
  for (const q of ['+91 9876', '+91 98765', '91 98765', '+91 98765 4321', '+91 98765 43210', '98765']) assert.deepEqual(ids(q), ['1'], q);
  for (const q of ['+1 416 555 010', '+1 416 555 0101', '+1416555', '1-416-555-0101', '1 (416) 555', '14165550101']) assert.deepEqual(ids(q), ['2'], q);
  assert.deepEqual(ids('+1 416'), ['2'], '"+1 416" is the area code, not the digits 1416 anywhere');
  assert.deepEqual(ids('16475'), ['4'], 'plain digits are matched as typed, never as "+1 6475…"');
});

test('review 2: Edit basics — clearing a junk-only contact is allowed; clearing a usable last contact is refused', async () => {
  const w = editWorld({ email: '', phone: '12345' });
  try {
    await w.act({ email: '', phone: '' });
    assert.deepEqual(w.calls.updates[0].o, { clearKeys: ['phone'] }, 'the junk phone can be cleaned');
  } finally { w.done(); }
  const w2 = editWorld({ email: '', phone: '416 555 0101' });
  try { await assert.rejects(w2.act({ email: '', phone: '' }), /email or a phone number/); } finally { w2.done(); }
  const w3 = editWorld({ email: 'not-an-email', phone: '' });
  try { await w3.act({ email: '', phone: '' }); assert.deepEqual(w3.calls.updates[0].o, { clearKeys: ['email'] }); } finally { w3.done(); }
  const d = require('../src/routes/adminLeads').buildLeadDetailHTML('7');
  assert.match(d, /if\(contactEdited && hadContact && !body\.email\.trim\(\) && !body\.phone\.trim\(\)\)/);
});

test('review 2: the search box stops a late answer on Escape and on leaving the box; coming back to the box searches the text again', () => {
  const { REFERRAL_UI_JS } = require('../src/routes/referralPicker');
  assert.match(REFERRAL_UI_JS, /function stopSearch\(\)\{ cancel\(\); closeList\(\); if \(state\.textContent === SEARCHING\) setState\(''\); \}/);
  assert.match(REFERRAL_UI_JS, /state\.textContent === SEARCHING\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); stopSearch\(\); return; \}/);
  assert.match(REFERRAL_UI_JS, /if \(document\.activeElement !== cli\) stopSearch\(\); \}, 150\);/);
  assert.match(REFERRAL_UI_JS, /cli\.addEventListener\('focus', function\(\)\{ if \(mode === 'search' && !picked && list\.hidden && cli\.value\.replace\(\/ \/g, ''\)\) \{ clearTimeout\(timer\); timer = setTimeout\(search, 0\); \} \}\);/);
  assert.ok(!REFERRAL_UI_JS.includes('\\'));
});

// ── Review round 3 (2026-11-04): fixes pinned ───────────────────────────────
test('review 3: "1416555" (no space after the 1) finds a number stored without the 1; "S.D\'Souza" is found by "Dsouza"; a non-Latin name joins its rows; the page uses the 7–15-digit rule', () => {
  const people = dir.buildPeople([
    { id: '1', name: 'Pat Lee', phone: '4165550101', date: '2025-01-01' },
    { id: '2', name: "S.D'Souza", date: '2025-01-01' },
    { id: '3', name: "J.O'Neil", date: '2025-01-01' },
    { id: '4', name: 'ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ', phone: '4165559999', email: 'g@x.com', date: '2025-01-01' },
    { id: '5', name: 'ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ', phone: '4165559999', date: '2025-02-01', retained: 'Yes' },
    { id: '6', name: 'ਗੁਰਪ੍ਰੀਤ  ਸਿੰਘ', email: 'g@x.com', date: '2025-03-01' },
    { id: '7', name: 'Pat Roe', phone: '905-861-6475', date: '2024-01-01' },
  ]);
  const ids = (q) => dir.searchPeople(people, q).results.map((r) => r.id);
  for (const q of ['1416555', '1416 555 01', '14165550101']) assert.ok(ids(q).includes('1'), q);
  assert.deepEqual(ids('16475'), ['7'], 'short digits still never guessed as +1');
  assert.deepEqual(ids('Dsouza'), ['2']); assert.deepEqual(ids('Oneil'), ['3']);
  const g = dir.searchPeople(people, '4165559999').results;
  assert.deepEqual([g.length, g[0].consults, g[0].retained], [1, 3, true], 'one person, 3 consultations, retained');
  const d = require('../src/routes/adminLeads').buildLeadDetailHTML('7');
  assert.match(d, /var hadContact=\(\/\^\[\^ @\]\+@\[\^ @\]\+\[\.\]\[\^ @\]\+\$\/\.test\(String\(BD_LOADED\.email\)\.trim\(\)\) \|\| \(pd>=7 && pd<=15\)\);/);
});
