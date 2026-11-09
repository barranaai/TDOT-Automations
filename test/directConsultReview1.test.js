'use strict';

// Direct consultation — review round 1 (step 2, 2026-11-09). One test (or more) per finding:
//  1/5 Record payment on a direct row: no booking, no meeting, no package question;
//  2/8 Change time shows only for a viewer the endpoint accepts; a list-switch 401 stays in the pop-up;
//  3   "Use this lead": the marker write carries the booking (never on neither list);
//  4   Retain refusal / retainer hold for ANY non-RCIC name on a direct row;
//  6   Otter: a summary pasted before ticking is never cut;
//  7   "Change consultant" on the record page for a direct non-RCIC row;
//  9   only an upcoming booking is "the same consultation";
//  10  the recorded HST follows the location typed in the pop-up;
//  11  a server error / a closed pop-up never loses or misstates the answer.
// Every Monday, Square, OneDrive, meeting and mail seam is stubbed (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const portal      = require('../src/services/consultantPortalService');
const dcs         = require('../src/services/directConsultService');
const snap        = require('../src/services/leadSnapshot');
const blacklist   = require('../src/services/blacklistService');
const booking     = require('../src/services/bookingService');
const prices      = require('../src/services/consultPriceService');
const consultSvc  = require('../src/services/consultationService');
const meeting     = require('../src/services/meetingService');
const tokens      = require('../src/services/leadTokenService');
const oneDrive    = require('../src/services/oneDriveService');
const retainer2   = require('../src/services/retainerService2');
const cp          = require('../src/services/consultPaymentService');
const routing     = require('../config/consultantRouting');
const C           = require('../src/data/newLeadsBoard.json').columns;
const ADM         = require('../src/routes/adminConsultation');
const DQ          = require('../src/routes/directConsultUi');
const UW          = require('../src/routes/updatesWidget');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function quiet() { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; }
function torontoIn(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const DAY = 86400000;
const futureDay = (d = 3) => torontoIn(d * DAY).slice(0, 10);
const COL_ID = 'text_test_directc';
const FARAN = { name: 'Faran Test', email: 'faran@example.com', verified: true };
const SHARED = { name: 'Unidentified (shared admin key)', email: '', verified: false };
const SHAFOLI = routing.CONSULTANTS.shafoli.name, SHERMIN = routing.CONSULTANTS.shermin.name, GAURI = 'Gauri Berde';
const MARK = (kind = 'New', inSquare = true) => JSON.stringify({ directConsult: { kind, inSquare } });

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function withColumn(fn) {
  const col = C.directConsult; C.directConsult = COL_ID; dcs._resetForTests();
  try { return await fn(); } finally { C.directConsult = col; dcs._resetForTests(); }
}
async function live(fn, { sw = '1' } = {}) { return withColumn(() => withEnv({ DIRECT_CONSULTATION: sw }, fn)); }

function entry(over = {}) {
  return {
    choice: 'new', fullName: 'Asha Example', email: 'asha@example.com', phone: '416 555 0101',
    consultant: SHAFOLI, meetingType: 'In-person', date: futureDay(), time: '11:00', durationMin: 30,
    payment: { kind: 'square', amountCents: 30000 }, about: 'Study permit for her son', bookedBy: 'Melanie',
    sourceChannel: 'Phone', inSquare: true,
    ...over,
  };
}

/** The direct-create world (the same stubs as directConsultServer.test.js). */
function world({ matches = {}, getLead = null } = {}) {
  dcs._resetForTests();
  const calls = { creates: [], updates: [], notes: [], meetings: 0, pkg: [] };
  const r = [
    quiet(),
    stub(mondayApi, 'query', async (q, v = {}) => {
      if (/create_item/.test(q)) { calls.creates.push(JSON.parse(v.cols)); return { create_item: { id: '900' } }; }
      if (/items_page\(limit:1\)/.test(q)) return { boards: [{ groups: [{ items_page: { items: [] } }] }] };
      if (/change_multiple_column_values/.test(q)) { calls.updates.push({ id: String(v.itemId), cols: JSON.parse(v.cols) }); return { change_multiple_column_values: { id: v.itemId } }; }
      if (/create_update/.test(q)) { calls.notes.push({ id: String(v.id || v.i), body: String(v.b) }); return { create_update: { id: 'u1' } }; }
      return {};
    }),
    stub(portal, 'findClientMatches', async () => ({ leads: [], cases: [], clients: [], rawLeads: [], ...matches })),
    stub(snap, 'leads', async () => []),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
    stub(blacklist, 'noteOnLead', async () => true),
    stub(booking, 'readSlotClaims', async () => []),
    stub(prices, 'ensureFresh', async () => {}),
    stub(consultSvc, 'autoSendConsultationPackage', async (id, opts) => { calls.pkg.push({ id, opts }); return { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async () => { calls.meetings++; throw new Error('no meeting may be made'); }),
    stub(tokens, 'ensureToken', async () => 'tok'),
    stub(oneDrive, 'ensureLeadFolder', async () => ({ id: 'f', url: 'u' })),
    stub(portal, 'getDirectClientOptions', async () => ({ caseTypes: ['Study Permit'] })),
    ...(getLead ? [stub(leadService, 'getLead', getLead)] : []),
  ];
  return { calls, restore: () => r.reverse().forEach((x) => x()) };
}

/* ── 1 / 5: Record payment on a direct row ── */

const ON = { CONSULT_PACKAGE_AUTO_SEND: '1', CONSULT_PACKAGE_ON_RECORD: '1' };
function recordWorld(lead) {
  const writes = [], notes = [], autoCalls = [], meetings = [];
  const state = { lead: { id: '901', fullName: 'Test Client', email: 't@c.co', phone: '4165550000', residentialAddress: '1 Main St', ...lead } };
  const restore = [
    quiet(),
    stub(leadService, 'getLead', async () => ({ ...state.lead })),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ id, fields, opts }); Object.assign(state.lead, fields); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
    stub(booking, 'readSlotClaims', async () => []),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false, entries: [] })),
    stub(consultSvc, 'autoSendConsultationPackage', async (id, opts) => { autoCalls.push({ id, opts }); return { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async (l, slot, dur) => { meetings.push({ slot, dur }); return { meetingId: 'm', joinUrl: 'https://teams.example/j', provider: 'teams' }; }),
  ];
  return { writes, notes, autoCalls, meetings, state, done: () => restore.reverse().forEach((r) => r()) };
}
const recordApply = (value) => portal.applyAction({ leadId: '901', action: 'recordConsultPayment', value, staffName: 'Melanie', actor: { name: 'Melanie', email: '', verified: false } });

test('1/5 Record payment on a direct VIDEO row: "No" with the prefilled booking makes NO meeting, writes no booking, sends no package', async () => {
  consultSvc._resetSentMemory();
  await withEnv(ON, async () => {
    const slot = `${futureDay()} 11:00`;
    const w = recordWorld({ bookingStatus: 'Booked', bookedSlot: slot, meetingType: 'Virtual', assignedConsultant: SHAFOLI, consultOption: MARK('New', true) });
    try {
      const r = await recordApply(JSON.stringify({ kind: 'square', amountCents: 30000, on: cp.torontoToday(), package: 'skip', packageNote: 'booked in Square',
        booking: { date: slot.slice(0, 10), time: '11:00', consultant: SHAFOLI, meetingType: 'Virtual', durationMin: 30 } }));
      assert.equal(r.ok, true, r.message);
      assert.equal(w.meetings.length, 0, 'no Teams meeting, no client invite');
      assert.equal(w.autoCalls.length, 0, 'no package');
      assert.deepEqual(w.writes.map((x) => Object.keys(x.fields)), [['consultPayment']], 'only the fee record is written');
      assert.match(r.message, /booking you entered was NOT saved — this is a direct consultation: change its time with "Change time"/);
      assert.match(r.message, /this box sends no package and makes no meeting/);
      assert.equal(JSON.parse(w.writes[0].fields.consultPayment).package, undefined, 'no package choice is stored');
    } finally { w.done(); }
  });
  consultSvc._resetSentMemory();
});

test('1/5 Record payment on a direct EXISTING-CLIENT row: "Yes" is never asked or acted on — no package, no meeting', async () => {
  consultSvc._resetSentMemory();
  await withEnv(ON, async () => {
    const slot = `${futureDay()} 11:00`;
    const w = recordWorld({ bookingStatus: 'Booked', bookedSlot: slot, meetingType: 'In-person', assignedConsultant: SHAFOLI, consultOption: MARK('Existing client', true) });
    try {
      const r = await recordApply(JSON.stringify({ kind: 'cash', amountCents: 30000, on: cp.torontoToday(), package: 'send',
        booking: { date: slot.slice(0, 10), time: '11:00', consultant: SHAFOLI, meetingType: 'In-person', durationMin: 45 } }));
      assert.equal(r.ok, true, r.message);
      assert.equal(w.autoCalls.length, 0); assert.equal(w.meetings.length, 0);
      assert.deepEqual(w.writes.map((x) => Object.keys(x.fields)), [['consultPayment']], 'the booked length is not overwritten');
    } finally { w.done(); }
  });
  consultSvc._resetSentMemory();
});

test('1/5 the record dialog view: a direct row is not asked (why "direct-consult"); a normal lead and the pop-up\'s own package gate are unchanged', async () => {
  await withEnv(ON, async () => {
    const slot = `${futureDay()} 11:00`;
    const direct = { id: '901', email: 't@c.co', bookingStatus: 'Booked', bookedSlot: slot, meetingType: 'Virtual', assignedConsultant: SHAFOLI, consultOption: MARK() };
    const v = portal._recordPackageView(direct, { record: null });
    assert.equal(v.applicable, false); assert.equal(v.why, 'direct-consult');
    const normal = { ...direct, consultOption: '' };
    assert.equal(portal._recordPackageView(normal, { record: null }).applicable, true, 'a normal lead still asks');
    assert.equal(consultSvc.packageApplicable(direct).ok, true, 'packageApplicable itself is unchanged (the pop-up\'s package goes through it)');
    const html = ADM.buildDetailHTML('555');
    assert.ok(html.includes("'direct-consult':'A direct consultation"), 'the page says why');
  });
});

/* ── 2 / 8: Change time only for a viewer the endpoint accepts ── */

test('2/8 directView.canChangeTime: off, a list switch with the shared key or an unlisted person, or the column not made → false; a listed Monday sign-in → true', async () => {
  const lead = { id: '1', bookedSlot: `${futureDay()} 10:00`, assignedConsultant: SHAFOLI, consultOption: MARK() };
  await withColumn(async () => {
    await withEnv({ DIRECT_CONSULTATION: '0' }, () => assert.equal(dcs.directView(lead, { actor: FARAN }).canChangeTime, false));
    await withEnv({ DIRECT_CONSULTATION: undefined }, () => assert.equal(dcs.directView(lead, { actor: FARAN }).canChangeTime, false));
    await withEnv({ DIRECT_CONSULTATION: 'faran@example.com' }, () => {
      assert.equal(dcs.directView(lead, { actor: SHARED }).canChangeTime, false, 'the shared key under a list switch');
      assert.equal(dcs.directView(lead, { actor: { name: 'O', email: 'other@example.com', verified: true } }).canChangeTime, false);
      assert.equal(dcs.directView(lead, { actor: FARAN }).canChangeTime, true);
    });
    await withEnv({ DIRECT_CONSULTATION: '1' }, () => {
      assert.equal(dcs.directView(lead, { actor: SHARED }).canChangeTime, true);
      assert.equal(dcs.directView(lead).canChangeTime, false, 'no viewer given → never shown');
    });
  });
  { const col = C.directConsult; C.directConsult = ''; dcs._resetForTests();
    try { await withEnv({ DIRECT_CONSULTATION: '1' }, () => assert.equal(dcs.directView(lead, { actor: FARAN }).canChangeTime, false, 'the column not set up')); }
    finally { C.directConsult = col; dcs._resetForTests(); } }
});

test('2/8 the detail route passes the viewer; the action route forwards loginUrl; the pop-up keeps a list-switch 401 in the dialog', () => {
  const src = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(src, /getConsultationDetail\(\(req\.params\.leadId \|\| ''\)\.trim\(\), \{ actor: staffActor\(req, ''\) \}\)/);
  assert.match(src, /error: err\.status === 404 \? 'Not found' : err\.message, \.\.\.\(err\.loginUrl \? \{ loginUrl: err\.loginUrl \} : \{\}\)/);
  const html = ADM.buildDetailHTML('555');
  const i = html.indexOf('function openChangeTime(d){');
  const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
  const login = body.indexOf('if(res.s===401 && j.loginUrl)'), redirect = body.indexOf("if(res.s===401||res.s===403){ window.location.href='/admin'");
  assert.ok(login > 0 && redirect > login, 'the sign-in answer is handled before the bad-key redirect');
  assert.match(body, /Sign in with Monday/);
});

/* ── 3: "Use this lead" — the marker write is a Booked consultation ── */

test('3 "Use this lead": the first write carries the marker AND the booking, so a failed booking write leaves a consultation (never on neither list)', async () => {
  await live(async () => {
    const base = { id: '321', fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101', bookingStatus: 'Abandoned', bookedSlot: '2026-10-01 10:00', sourceChannel: 'Website' };
    const w = world({ getLead: async (id) => (String(id) === '321' ? { ...base } : null) });
    const r0 = stub(portal, 'writeRecordedBooking', async () => { throw new Error('Monday 500'); });
    try {
      const b = entry({ useLeadId: '321' });
      const r = await dcs.createDirectConsult(b, { actor: FARAN });
      assert.equal(r.ok, true);
      assert.ok(r.left.some((l) => /booking details/.test(l)), 'the failure is listed');
      const first = w.calls.updates.find((u) => u.id === '321').cols;
      assert.equal(first[COL_ID], 'New');
      assert.equal(first[C.bookedSlot], `${b.date} 11:00`);
      const merged = { ...base, directConsult: 'New', bookingStatus: 'Booked', bookedSlot: `${b.date} 11:00`, consultationHeld: b.date, assignedConsultant: SHAFOLI };
      assert.ok(JSON.stringify(first[C.bookingStatus]).includes('Booked'), 'Booked in the same write');
      assert.equal(portal.classifyLead(merged), 'consultation');
    } finally { r0(); w.restore(); }
  });
});

test('3 "Use this lead": a stale video link left from the abandoned hold is still dropped (the booking write compares the OLD booking)', async () => {
  await live(async () => {
    const slotDay = futureDay();
    const base = { id: '321', fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101', bookingStatus: 'Abandoned', bookedSlot: `${slotDay} 11:00`,
      assignedConsultant: SHAFOLI, meetingType: 'Virtual', meetingLink: 'https://old.example/j/1', sourceChannel: 'Website' };
    const w = world({ getLead: async (id) => (String(id) === '321' ? { ...base } : null) });
    try {
      const r = await dcs.createDirectConsult(entry({ useLeadId: '321', meetingType: 'Virtual', date: slotDay, package: false }), { actor: FARAN });
      assert.equal(r.ok, true, r.message);
      assert.ok(r.lines.some((l) => /An earlier video meeting .* is no longer used/.test(l)), r.lines.join(' | '));
      assert.equal(w.calls.meetings, 0, 'and no new meeting');
    } finally { w.restore(); }
  });
});

/* ── 4: any non-RCIC name on a direct row ── */

test('4 isUnknownConsultant: blank → false; the RCICs → false; Gauri, a spelling variant, a typed name → true', () => {
  assert.equal(routing.isUnknownConsultant(''), false);
  assert.equal(routing.isUnknownConsultant('  '), false);
  assert.equal(routing.isUnknownConsultant(SHAFOLI), false);
  assert.equal(routing.isUnknownConsultant(` ${SHERMIN} `), false);
  for (const n of [GAURI, 'Gauri', 'gauri berde', 'Someone Typed']) assert.equal(routing.isUnknownConsultant(n), true, n);
});

test('4 Retain on a direct row: refused for any non-RCIC name (with the "Change consultant" pointer); the retainer is HELD; a normal lead is unchanged', async () => {
  for (const name of ['Gauri', 'gauri berde', 'Someone Typed']) {
    const lead = { id: '800', fullName: 'Asha', email: 'a@b.co', assignedConsultant: name, bookingStatus: 'Booked', retainerFee: '2000', outcome: '', consultOption: MARK() };
    const writes = [];
    const r = [quiet(), stub(leadService, 'getLead', async () => ({ ...lead })), stub(leadService, 'updateLead', async (id, f) => { writes.push(f); })];
    try {
      await assert.rejects(portal.applyAction({ leadId: '800', action: 'outcome', value: 'Retain', actor: FARAN }),
        (e) => e.badRequest && /is not one of our RCICs \(name not recognised\)/.test(e.message) && /Change consultant/.test(e.message));
      assert.equal(writes.length, 0);
    } finally { r.reverse().forEach((x) => x()); }
    const notes = [];
    const r2 = [quiet(), stub(leadService, 'getLead', async () => ({ ...lead, outcome: 'Retain' })),
      stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(String(v.body || v.b || JSON.stringify(v))); return { create_update: { id: 'n' } }; })];
    try {
      const res = await retainer2.maybeSendRetainerAgreement('800', { notifyIfMissing: true });
      assert.equal(res.status, 'non-rcic', name);
      assert.ok(notes.some((n) => /name not recognised/.test(n)));
    } finally { r2.reverse().forEach((x) => x()); }
  }
  // a direct row with an RCIC or a blank name, and a NORMAL lead with a typed name, go past this check (to the fee check)
  for (const lead of [{ assignedConsultant: SHAFOLI, consultOption: MARK() }, { assignedConsultant: '', consultOption: MARK() }, { assignedConsultant: 'Someone Typed' }]) {
    const r3 = [quiet(), stub(leadService, 'getLead', async () => ({ id: '801', email: 'a@b.co', outcome: 'Retain', ...lead })), stub(mondayApi, 'query', async () => ({ create_update: { id: 'n' } }))];
    try {
      const res = await retainer2.maybeSendRetainerAgreement('801', { notifyIfMissing: false });
      assert.equal(res.status, 'no-fee', JSON.stringify(lead));
    } finally { r3.reverse().forEach((x) => x()); }
  }
});

test('4 setConsultant: a direct row held by any non-RCIC name may move to an RCIC', async () => {
  const writes = [];
  const lead = { id: '802', assignedConsultant: 'Gauri', bookingStatus: 'Booked', bookedSlot: '2026-11-01 10:00', consultOption: MARK() };
  const r = [quiet(), stub(leadService, 'getLead', async () => ({ ...lead })), stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }), stub(mondayApi, 'query', async () => ({}))];
  try {
    const out = await portal.applyAction({ leadId: '802', action: 'setConsultant', value: SHERMIN, actor: FARAN });
    assert.equal(out.ok, true);
    assert.deepEqual(writes, [{ assignedConsultant: SHERMIN }]);
  } finally { r.reverse().forEach((x) => x()); }
});

/* ── 6: the Otter box ── */

test('6 Otter: the box on the record page takes 20,000 characters from the start; pages without the tick keep 4,000', () => {
  assert.match(UW.updatesWidgetHtml('updw', { otter: true }), /<textarea id="updw-text" maxlength="20000"/);
  assert.match(UW.updatesWidgetHtml('x'), /<textarea id="x-text" maxlength="4000"/);
  assert.match(UW.UPDATES_WIDGET_JS, /ta\.maxLength = 20000;/);
  assert.doesNotMatch(UW.UPDATES_WIDGET_JS, /ta\.maxLength = on \?/, 'unticking never shrinks the box');
  assert.match(UW.UPDATES_WIDGET_JS, /if \(!otter && text\.length > 4000\)/, 'an unticked post over 4,000 is still refused on the page');
});

/* ── 7: Change consultant ── */

test('7 Change consultant: directView flags a non-RCIC consultant and lists the RCICs; the page wires the shared pop-up to setConsultant', () => {
  const v = dcs.directView({ id: '1', assignedConsultant: GAURI, consultOption: MARK() });
  assert.equal(v.needsRcic, true); assert.deepEqual(v.rcics, [SHAFOLI, SHERMIN]);
  assert.equal(dcs.directView({ id: '1', assignedConsultant: SHAFOLI, consultOption: MARK() }).needsRcic, false);
  const html = ADM.buildDetailHTML('555');
  const i = html.indexOf('function openChangeConsultant(d){');
  assert.ok(i > 0);
  const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
  assert.match(body, /tdotDialogNew\(/); assert.match(body, /action:'setConsultant', value: sel\.value/);
  assert.ok(!/[`\\]|\$\{/.test(body), 'inline-JS rules');
  for (const s of [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])) new vm.Script(s);
});

/* ── 9: only an upcoming booking is "the same consultation" ── */

test('9 an earlier Existing-client row and a past held row with no outcome are not "live"; an upcoming one still is', async () => {
  await live(async () => {
    const past = [
      { id: '61', fullName: 'Asha Example', bookingStatus: 'Booked', bookedSlot: `${torontoIn(-4 * DAY).slice(0, 10)} 10:00`, assignedConsultant: SHAFOLI, outcome: '', directConsult: 'Existing client', consultationHeld: torontoIn(-4 * DAY).slice(0, 10) },
      { id: '62', fullName: 'Asha Example', bookingStatus: 'Booked', bookedSlot: `${torontoIn(-1 * DAY).slice(0, 10)} 15:00`, assignedConsultant: SHERMIN, outcome: '' },
    ];
    const w = world({ matches: { rawLeads: past } });
    try {
      const r = await dcs.createDirectConsult(entry({ choice: 'existing', sourceChannel: '' }), { actor: FARAN });
      assert.equal(r.ok, true, 'saved without "different consultation"');
    } finally { w.restore(); }
    const w2 = world({ matches: { rawLeads: [{ ...past[1], id: '63', bookedSlot: `${futureDay(5)} 15:00` }] } });
    try {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.code === 'same-consultation');
    } finally { w2.restore(); }
  });
});

/* ── the pop-up, against a small fake page (as in directConsultPages.test.js) ── */

function fakeEl(id) {
  const l = {};
  return { id, value: '', textContent: '', innerHTML: '', style: {}, checked: false, disabled: false, maxLength: 4000, placeholder: '', className: '',
    classList: { toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, fire(t) { (l[t] || []).forEach((f) => f({ target: this })); if (this['on' + t]) this['on' + t]({}); }, focus() {} };
}
const OPTIONS = {
  consultants: [{ name: SHAFOLI, rcic: true, defaultMin: 30, options: [{ durationMin: 30, feeCents: 30000 }] }],
  lengths: [15, 30, 45, 60], meetingTypes: ['In-person', 'Virtual', 'Phone Call'],
  payments: [{ kind: 'square', label: 'Paid in Square' }, { kind: 'none', label: 'Not paid yet' }],
  hstPct: 13, staff: ['Melanie'], bookedBy: 'Melanie', signedIn: true, sources: ['Walk-in'], caseTypes: [], backDays: 30,
};
function popupWorld({ matches = null, answer, reject = false } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || fakeEl(id));
  const radios = { 'dq-choice': ['new', 'existing'], 'dq-how': OPTIONS.meetingTypes, 'dq-pay': ['square', 'none'], 'dq-inca': ['Yes', 'No', ''], 'dq-sq': ['yes', 'no'], 'dq-use': [] };
  const R = {};
  for (const [n, vals] of Object.entries(radios)) R[n] = vals.map((v) => Object.assign(fakeEl(n + ':' + v), { value: v, name: n }));
  R['dq-inca'][2].checked = true;
  const box = {
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    querySelector(sel) {
      let m = sel.match(/^#(.+)$/); if (m) return el(m[1]);
      m = sel.match(/^input\[name="([^"]+)"\]:checked$/); if (m) return (R[m[1]] || []).find((r) => r.checked) || null;
      m = sel.match(/^input\[name="([^"]+)"\]$/); if (m) return (R[m[1]] || [])[0] || null;
      if (sel === 'label[for="dq-fee"]') return el('label-dq-fee');
      if (sel === '[data-x]') return el('cancel');
      return null;
    },
    querySelectorAll(sel) { const m = sel.match(/^input\[name="([^"]+)"\]$/); return m ? (R[m[1]] || []) : []; },
  };
  el('dq-fees').querySelectorAll = () => [];
  const posts = [];
  const dlg = { box, openId: 1, still: () => true, setBusy() {}, close() { dlg.closed = true; return true; }, tryClose() { dlg.closed = true; } };
  const ctx = {
    DQ_FORM: DQ.dqFormHtml(), DQ_OPTS: null, Intl, Date, Math, Number, String, isFinite, isNaN, encodeURIComponent, JSON, setTimeout, clearTimeout,
    peekKey: () => 'k', getKey: () => 'k', tdotDialogNew: () => dlg,
    tdotRef: () => ({ check: () => '', value: () => '', from: () => 'typed', focus() {} }),
    tdotBlacklistHtml: () => '', load: () => {}, location: { pathname: '/admin/consultations' },
    document: { getElementById: (id) => el(id) },
    fetch: (url, o) => {
      if (String(url).startsWith('/api/consultation/client-matches')) return Promise.resolve({ ok: true, json: () => Promise.resolve(matches || { clients: [], cases: [], leads: [] }) });
      posts.push({ url, body: JSON.parse(o.body) });
      if (reject) return Promise.reject(new Error('network'));
      return Promise.resolve({ status: answer.s, json: () => Promise.resolve(answer.j) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DQ.DQ_JS + '\nDQ_OPTS=' + JSON.stringify(OPTIONS) + ';\nopenDirectConsult();', ctx);
  const pickRadio = (n, v) => { R[n].forEach((r) => { r.checked = r.value === v; }); const r = R[n].find((x) => x.value === v); if (r && r.onchange) r.onchange({}); };
  const type = (id, v, ev = 'input') => { el(id).value = v; el(id).fire(ev); };
  const fill = (when) => {
    type('dq-name', 'Asha Example'); type('dq-phone', '4165550101');
    pickRadio('dq-choice', 'existing'); el('dq-consultant').value = SHAFOLI; el('dq-consultant').onchange();
    pickRadio('dq-how', 'In-person'); type('dq-when', when, 'change');
    pickRadio('dq-pay', 'none'); type('dq-about', 'file question');
  };
  return { el, pickRadio, type, fill, posts, dlg, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

test('9 pop-up: a past booked lead for the person is not shown as "already in the app" and does not block Save', async () => {
  const past = torontoIn(-3 * DAY).slice(0, 10);
  const w = popupWorld({ matches: { clients: [], cases: [], leads: [{ id: '77', name: 'Asha Example', bookingStatus: 'Booked', bookedSlot: past + ' 09:00', consultant: SHAFOLI, outcome: '', directConsult: 'Existing client' }] },
    answer: { s: 200, j: { ok: true, message: 'Saved.', link: '/admin/consultation/9', left: [] } } });
  w.type('dq-email', 'asha@example.com'); w.el('dq-email').fire('blur');
  await w.settle();
  assert.doesNotMatch(String(w.el('dq-match').innerHTML), /A consultation for this person is already in the app/);
  w.fill(torontoIn(-1 * DAY).slice(0, 10) + 'T12:00');
  w.el('dq-save').onclick();
  await w.settle();
  assert.equal(w.posts.length, 1, 'saved without the "different consultation" tick');
});

test('11 pop-up: a 500 says "check the Consultations list" (never "nothing was saved"); a closed pop-up still tells a refusal, a 500 and a network failure', async () => {
  const when = torontoIn(-1 * DAY).slice(0, 10) + 'T12:00';
  const w = popupWorld({ answer: { s: 500, j: { error: 'Internal server error' } } });
  w.fill(when); w.el('dq-save').onclick(); await w.settle();
  assert.match(w.el('dq-err').textContent, /may or may not have been saved\. Check the Consultations list before trying again/);
  assert.doesNotMatch(w.el('dq-err').textContent, /Internal server error/);

  for (const [answer, re] of [[{ s: 409, j: { error: 'Already in the app: Asha.', code: 'already', link: '/admin/consultation/5' } }, /Not saved: Already in the app/], [{ s: 500, j: { error: 'Internal server error' } }, /Check the Consultations list/]]) {
    const w2 = popupWorld({ answer });
    w2.fill(when); w2.el('dq-save').onclick();
    w2.dlg.still = () => false;   // the user closed the pop-up during the long wait
    await w2.settle();
    assert.match(w2.el('dq-done').innerHTML, re);
    assert.equal(w2.el('dq-done').className, 'warn');
  }
  const w3 = popupWorld({ reject: true });
  w3.fill(when); w3.el('dq-save').onclick();
  w3.dlg.still = () => false;
  await w3.settle();
  assert.match(w3.el('dq-done').innerHTML, /Check the Consultations list/);

  const w4 = popupWorld({ answer: { s: 503, j: { error: 'Direct consultation is not set up yet: its Lead Board column has not been made. Nothing was saved.' } } });
  w4.fill(when); w4.el('dq-save').onclick(); await w4.settle();
  assert.match(w4.el('dq-err').textContent, /not set up yet/, 'a 503 keeps its own words');
});

/* ── 10: the recorded HST follows the pop-up ── */

test('10 "Use this lead" with a stored country (India) and "Not known": the recorded HST is what the pop-up showed (13 %)', async () => {
  await live(async () => {
    const base = { id: '321', fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101', bookingStatus: 'Abandoned', bookedSlot: '2026-10-01 10:00', country: 'India', sourceChannel: 'Website' };
    const w = world({ getLead: async (id) => (String(id) === '321' ? { ...base } : null) });
    try {
      const r = await dcs.createDirectConsult(entry({ useLeadId: '321' }), { actor: FARAN });
      assert.equal(r.ok, true, r.message);
      const recCol = w.calls.updates.filter((u) => u.id === '321').map((u) => u.cols[C.consultPayment]).find(Boolean);
      const rec = JSON.parse(recCol);
      assert.equal(rec.hstCents, Math.round(30000 * require('../src/services/bookingService').consultHstPctForLead({}) / 100));
      assert.ok(rec.hstCents > 0);
      assert.equal(w.calls.updates.some((u) => u.id === '321' && C.country && u.cols[C.country] !== undefined), false, 'the stored country is not changed');
    } finally { w.restore(); }
  });
});
