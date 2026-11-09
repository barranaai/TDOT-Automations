'use strict';

// Direct consultation — review round 2 (step 2, 2026-11-09). One test (or more) per finding:
//  1 "Use this lead" never carries an old fee record's "send" (or a waiting package) into the
//    direct row: refused; a direct row acts on "send" only when its own pop-up ticked it
//    (Record payment, the address box, the 15-minute sweep);
//  2 the person look-up fails CLOSED on the direct path (a lead or case read error refuses the save);
//  3 a double click on Save / "Save anyway" sends one request (the pop-up and Change time);
//  4 the fee dialog and the server reply name "Change time" only where that button can be;
//  5 a 503 "not set up yet" is said in words, not only in a tooltip;
//  6 the record page's Change time, Change consultant, ask-first and doAction RUN in a fake page.
// Every Monday, Square, OneDrive, meeting and mail seam is stubbed (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const mondayApi    = require('../src/services/mondayApi');
const leadService  = require('../src/services/leadService');
const clientMaster = require('../src/services/clientMasterService');
const clientAccts  = require('../src/services/clientAccountService');
const portal       = require('../src/services/consultantPortalService');
const dcs          = require('../src/services/directConsultService');
const snap         = require('../src/services/leadSnapshot');
const blacklist    = require('../src/services/blacklistService');
const booking      = require('../src/services/bookingService');
const prices       = require('../src/services/consultPriceService');
const consultSvc   = require('../src/services/consultationService');
const meeting      = require('../src/services/meetingService');
const tokens       = require('../src/services/leadTokenService');
const oneDrive     = require('../src/services/oneDriveService');
const cp           = require('../src/services/consultPaymentService');
const DCU          = require('../src/utils/directConsult');
const routing      = require('../config/consultantRouting');
const C            = require('../src/data/newLeadsBoard.json').columns;
const ADM          = require('../src/routes/adminConsultation');
const DQ           = require('../src/routes/directConsultUi');

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
const SHAFOLI = routing.CONSULTANTS.shafoli.name;
const MARK = (kind = 'New', inSquare = true, extra = {}) => JSON.stringify({ directConsult: { kind, inSquare, ...extra } });
const ON = { CONSULT_PACKAGE_AUTO_SEND: '1', CONSULT_PACKAGE_ON_RECORD: '1' };
const rec = (over = {}) => JSON.stringify({ kind: 'cash', amountCents: 30000, hstCents: 3900, on: cp.torontoToday(), by: 'Melanie', at: new Date().toISOString(), verified: false, package: 'send', ...over });
const HOLD = JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: '2026-10-20T00:00:00Z', packageHeldBy: 'recorded' });

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function live(fn) {
  const col = C.directConsult; C.directConsult = COL_ID; dcs._resetForTests();
  try { return await withEnv({ DIRECT_CONSULTATION: '1' }, fn); } finally { C.directConsult = col; dcs._resetForTests(); }
}
function entry(over = {}) {
  return {
    choice: 'new', fullName: 'Asha Example', email: 'asha@example.com', phone: '416 555 0101',
    consultant: SHAFOLI, meetingType: 'In-person', date: futureDay(), time: '11:00', durationMin: 30,
    payment: { kind: 'square', amountCents: 30000 }, about: 'Study permit for her son', bookedBy: 'Melanie',
    sourceChannel: 'Phone', inSquare: true,
    ...over,
  };
}

/**
 * The direct-create world. lookups: what the REAL findClientMatches reads (lead / case
 * look-ups) — or matches: a stubbed findClientMatches answer.
 */
function world({ matches = null, getLead = null, lookups = {} } = {}) {
  dcs._resetForTests();
  const calls = { creates: [], updates: [], notes: [], pkg: [] };
  const r = [
    quiet(),
    stub(mondayApi, 'query', async (q, v = {}) => {
      if (/create_item/.test(q)) { calls.creates.push(JSON.parse(v.cols)); return { create_item: { id: '900' } }; }
      if (/items_page\(limit:1\)/.test(q)) return { boards: [{ groups: [{ items_page: { items: [] } }] }] };
      if (/change_multiple_column_values/.test(q)) { calls.updates.push({ id: String(v.itemId), cols: JSON.parse(v.cols) }); return { change_multiple_column_values: { id: v.itemId } }; }
      if (/create_update/.test(q)) { calls.notes.push({ id: String(v.id || v.i), body: String(v.b) }); return { create_update: { id: 'u1' } }; }
      return {};
    }),
    ...(matches ? [stub(portal, 'findClientMatches', async () => ({ leads: [], cases: [], clients: [], rawLeads: [], ...matches }))] : [
      stub(leadService, 'findAllByColumnValue', lookups.leads || (async () => [])),
      stub(clientMaster, 'findCasesByEmail', lookups.casesByEmail || (async () => [])),
      stub(clientMaster, 'findCasesByPhone', lookups.casesByPhone || (async () => [])),
      stub(clientAccts, 'findMatches', async () => []),
    ]),
    stub(snap, 'leads', async () => []),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
    stub(blacklist, 'noteOnLead', async () => true),
    stub(booking, 'readSlotClaims', async () => []),
    stub(prices, 'ensureFresh', async () => {}),
    stub(consultSvc, 'autoSendConsultationPackage', async (id, opts) => { calls.pkg.push({ id, opts }); return { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async () => { throw new Error('no meeting may be made'); }),
    stub(tokens, 'ensureToken', async () => 'tok'),
    stub(oneDrive, 'ensureLeadFolder', async () => ({ id: 'f', url: 'u' })),
    stub(portal, 'getDirectClientOptions', async () => ({ caseTypes: ['Study Permit'] })),
    ...(getLead ? [stub(leadService, 'getLead', getLead)] : []),
  ];
  return { calls, restore: () => r.reverse().forEach((x) => x()) };
}

/* The Record-payment world on lead 901 (the same seams as directConsultReview1.test.js). */
function recordWorld(lead) {
  const writes = [], autoCalls = [];
  const state = { lead: { id: '901', fullName: 'Test Client', email: 't@c.co', phone: '4165550000', residentialAddress: '', ...lead } };
  const restore = [
    quiet(),
    stub(leadService, 'getLead', async () => ({ ...state.lead })),
    stub(leadService, 'updateLead', async (id, fields) => { writes.push({ id, fields }); Object.assign(state.lead, fields); }),
    stub(mondayApi, 'query', async () => ({})),
    stub(booking, 'readSlotClaims', async () => []),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false, entries: [] })),
    stub(consultSvc, 'autoSendConsultationPackage', async (id, opts) => { autoCalls.push({ id, opts }); return { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async () => { throw new Error('no meeting may be made'); }),
  ];
  return { writes, autoCalls, state, done: () => restore.reverse().forEach((r) => r()) };
}
const recordApply = (value) => portal.applyAction({ leadId: '901', action: 'recordConsultPayment', value, staffName: 'Melanie', actor: { name: 'Melanie', email: '', verified: false } });

/* ── 1: "Use this lead" and an old fee record's "send" ── */

test('1 reuseRefusal: a lead with a fee record, a waiting / held / sent package is refused; a clean abandoned lead is allowed', () => {
  const n = { fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101' };
  const base = { id: '321', fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101', bookingStatus: 'Abandoned', bookedSlot: '2026-10-01 10:00' };
  assert.equal(dcs.reuseRefusal(base, n), '', 'a clean abandoned lead may be used');
  const refused = (over) => dcs.reuseRefusal({ ...base, ...over }, n);
  assert.match(refused({ consultPayment: rec(), consultCountersign: HOLD }), /consultation fee or a consultation package is already recorded on it — add this as a new row instead/);
  assert.match(refused({ consultPayment: rec({ package: 'skip' }) }), /consultation fee/, 'any fee record');
  assert.match(refused({ consultCountersign: HOLD }), /consultation package/, 'a hold alone');
  for (const cs of [{ packagePending: '2026-10-20T00:00:00Z' }, { packageStalled: true }, { packageExpired: '2026-10-20' }, { packageEmailedAt: '2026-10-20T00:00:00Z' }, { clientEnvelopeId: 'env_1' }]) {
    assert.match(refused({ consultCountersign: JSON.stringify(cs) }), /consultation package/, JSON.stringify(cs));
  }
  assert.match(refused({ consultAgreementSent: '2026-10-20' }), /consultation package/);
  // countersign keys that are not package state, and an empty hold, do not block
  assert.equal(refused({ consultCountersign: JSON.stringify({ envKeep: 'x', packageAttempts: 0 }) }), '');
});

test('1 "Use this lead" on a lead with {package:"send"} and a blank-address hold: refused (400) before ANY write', async () => {
  await live(async () => {
    const base = { id: '321', fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101', bookingStatus: 'Abandoned', bookedSlot: '2026-10-01 10:00', consultPayment: rec(), consultCountersign: HOLD };
    const w = world({ matches: {}, getLead: async (id) => (String(id) === '321' ? { ...base } : null) });
    try {
      await assert.rejects(dcs.createDirectConsult(entry({ useLeadId: '321', payment: { kind: 'none' } }), { actor: FARAN }),
        (e) => e.status === 400 && /consultation fee or a consultation package/.test(e.message));
      assert.equal(w.calls.creates.length, 0); assert.equal(w.calls.updates.length, 0); assert.equal(w.calls.notes.length, 0); assert.equal(w.calls.pkg.length, 0);
    } finally { w.restore(); }
  });
});

test('1 the pop-up\'s tick is stored in the marker (package: true) — and only when ticked', async () => {
  await live(async () => {
    for (const ticked of [true, false]) {
      const w = world({ matches: {} });
      try {
        const r = await dcs.createDirectConsult(entry({ package: ticked, residentialAddress: '1 Main St' }), { actor: FARAN });
        assert.equal(r.ok, true, r.message);
        const opt = w.calls.updates.map((u) => u.cols[C.consultOption]).filter(Boolean).pop();
        assert.ok(opt, 'the marker is written with the booking');
        const m = JSON.parse(opt).directConsult;
        assert.equal(m.package, ticked ? true : undefined);
        assert.equal(w.calls.pkg.length, ticked ? 1 : 0);
      } finally { w.restore(); }
    }
  });
});

test('1 packageAsked / recordedPackageWanted: a direct row acts on "send" only with its own tick; other leads unchanged', () => {
  const want = consultSvc.recordedPackageWanted;
  const lead = (over) => ({ id: '901', email: 't@c.co', bookingStatus: 'Booked', consultPayment: rec(), ...over });
  assert.deepEqual(want(lead({})), { ok: true }, 'a normal lead: unchanged');
  assert.equal(DCU.packageAsked(lead({})), true);
  assert.equal(want(lead({ consultOption: MARK('New') })).why, 'not-chosen', 'a direct row whose pop-up did not tick');
  assert.equal(want(lead({ consultOption: MARK('New', true, { package: false }) })).why, 'not-chosen');
  assert.equal(want(lead({ directConsult: 'New' })).why, 'not-chosen', 'column marker only (no readable detail): fail closed');
  assert.equal(want(lead({ consultOption: '{directConsult: bad json' })).why, 'not-chosen', 'unreadable marker: fail closed');
  assert.deepEqual(want(lead({ consultOption: MARK('New', true, { package: true }) })), { ok: true }, 'the pop-up ticked it');
});

test('1 Record payment on a direct row that inherited {package:"send"} + a recorded hold: NO package run, the record is kept as "No"', async () => {
  consultSvc._resetSentMemory();
  await withEnv(ON, async () => {
    const slot = `${futureDay()} 11:00`;
    const w = recordWorld({ bookingStatus: 'Booked', bookedSlot: slot, meetingType: 'In-person', assignedConsultant: SHAFOLI,
      consultOption: MARK('New', false), consultPayment: rec(), consultCountersign: HOLD });
    try {
      const r = await recordApply(JSON.stringify({ kind: 'cash', amountCents: 30000, on: cp.torontoToday() }));
      assert.equal(r.ok, true, r.message);
      assert.equal(w.autoCalls.length, 0, 'no package run at all');
      const written = JSON.parse(w.writes.find((x) => x.fields.consultPayment).fields.consultPayment);
      assert.equal(written.package, 'skip', 'the inherited "send" is not kept');
      assert.match(r.message, /this box sends no package/);
    } finally { w.done(); }
    // the same row whose pop-up DID tick the package: the earlier behaviour (one gated run)
    consultSvc._resetSentMemory();
    const w2 = recordWorld({ bookingStatus: 'Booked', bookedSlot: slot, meetingType: 'In-person', assignedConsultant: SHAFOLI,
      consultOption: MARK('New', false, { package: true }), consultPayment: rec(), consultCountersign: HOLD });
    try {
      const r = await recordApply(JSON.stringify({ kind: 'cash', amountCents: 30000, on: cp.torontoToday() }));
      assert.equal(r.ok, true, r.message);
      assert.equal(w2.autoCalls.length, 1);
      assert.equal(w2.autoCalls[0].opts.trigger, 'recorded');
      assert.equal(JSON.parse(w2.autoCalls[0].opts.overrides.consultPayment).package, 'send');
    } finally { w2.done(); }
  });
  consultSvc._resetSentMemory();
});

test('1 the sweep and the address box: a direct row\'s inherited "send" + hold is retired, never sent', async () => {
  consultSvc._resetSentMemory();
  await withEnv(ON, async () => {
    const sends = [];
    let current = { id: '901', fullName: 'Test Client', email: 't@c.co', phone: '4165550000', residentialAddress: '1 Main St',
      bookingStatus: 'Booked', bookedSlot: `${futureDay()} 11:00`, meetingType: 'In-person', assignedConsultant: SHAFOLI,
      consultOption: MARK('New', false), consultPayment: rec(), consultCountersign: HOLD, leadToken: 'LEAD-test' };
    const r = [
      quiet(),
      stub(blacklist, 'check', async () => ({ checked: true, hit: false, entries: [] })),
      stub(leadService, 'getLead', async () => ({ ...current })),
      stub(leadService, 'updateLead', async (id, f) => { current = { ...current, ...f }; }),
      stub(leadService, 'findAllByColumnValue', async () => [{ ...current }]),
      stub(consultSvc, 'sendConsultationPackage', async (id, opts) => { sends.push({ id, opts }); return { ok: true, via: 'documenso' }; }),
      stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
    ];
    try {
      await consultSvc.sweepConsultPackages();
      assert.equal(sends.length, 0, 'the sweep sent nothing');
      assert.equal(JSON.parse(current.consultCountersign || '{}').packageHeld, undefined, 'the hold is retired');
      // the address box on the record page: the same gate
      current = { ...current, consultCountersign: HOLD };
      consultSvc._resetSentMemory();
      const out = await consultSvc.autoSendConsultationPackage('901', { trigger: 'address', overrides: { residentialAddress: '1 Main St' } });
      assert.notEqual(out.status, 'sent');
      assert.equal(sends.length, 0);
    } finally { r.reverse().forEach((x) => x()); }
  });
  consultSvc._resetSentMemory();
});

/* ── 2: the look-up fails closed on the direct path ── */

test('2 a failed lead or case look-up refuses the save (400 "nothing was saved"), with nothing created', async () => {
  await live(async () => {
    for (const lookups of [
      { leads: async () => { throw new Error('Monday timeout'); } },
      { casesByEmail: async () => { throw new Error('Monday 500'); } },
      { casesByPhone: async () => { throw new Error('Monday 500'); } },
    ]) {
      const w = world({ lookups });
      try {
        await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.status === 400 && /Could not look this person up just now — nothing was saved/.test(e.message));
        assert.equal(w.calls.creates.length, 0, 'no row'); assert.equal(w.calls.updates.length, 0); assert.equal(w.calls.notes.length, 0);
      } finally { w.restore(); }
    }
    // the look-ups answering: saved as before (the real findClientMatches, strict)
    const w = world();
    try { assert.equal((await dcs.createDirectConsult(entry(), { actor: FARAN })).ok, true); assert.equal(w.calls.creates.length, 1); } finally { w.restore(); }
  });
});

test('2 the warn-and-link panel keeps its best-effort look-up (strict is off by default); the registry stays best-effort under strict', async () => {
  const r = [
    quiet(),
    stub(leadService, 'findAllByColumnValue', async () => { throw new Error('Monday timeout'); }),
    stub(clientMaster, 'findCasesByEmail', async () => [{ id: 'c1', caseRef: 'EE-1' }]),
    stub(clientMaster, 'findCasesByPhone', async () => []),
    stub(clientAccts, 'findMatches', async () => { throw new Error('registry down'); }),
  ];
  try {
    const m = await portal.findClientMatches({ email: 'a@b.co', phone: '4165550101' });
    assert.deepEqual(m.leads, []); assert.equal(m.cases.length, 1);
    await assert.rejects(portal.findClientMatches({ email: 'a@b.co', phone: '4165550101', withLeads: true, strict: true }), /Monday timeout/);
  } finally { r.reverse().forEach((x) => x()); }
  const r2 = [quiet(), stub(leadService, 'findAllByColumnValue', async () => []), stub(clientMaster, 'findCasesByEmail', async () => []),
    stub(clientMaster, 'findCasesByPhone', async () => []), stub(clientAccts, 'findMatches', async () => { throw new Error('registry down'); })];
  try {
    const m = await portal.findClientMatches({ email: 'a@b.co', phone: '4165550101', withLeads: true, strict: true });
    assert.deepEqual(m.clients, [], 'the registry failing does not refuse the save');
  } finally { r2.reverse().forEach((x) => x()); }
});

/* ── the fake page ── */

function fakeEl(id) {
  const l = {};
  return { id, value: '', textContent: '', innerHTML: '', style: {}, checked: false, disabled: false, hidden: false, title: '', className: '', maxLength: 4000, placeholder: '',
    classList: { _s: new Set(), toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild() {}, addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, fire(t) { (l[t] || []).forEach((f) => f({ target: this })); if (this['on' + t]) this['on' + t]({}); }, focus() {} };
}
const OPTIONS = {
  consultants: [{ name: SHAFOLI, rcic: true, defaultMin: 30, options: [{ durationMin: 30, feeCents: 30000 }] }],
  lengths: [15, 30, 45, 60, 75, 90, 105, 120],
  meetingTypes: ['In-person', 'Virtual', 'Phone Call'],
  payments: [{ kind: 'square', label: 'Paid in Square' }, { kind: 'cash', label: 'Cash' }, { kind: 'e-transfer', label: 'E-transfer' }, { kind: 'waived', label: 'Free' }, { kind: 'none', label: 'Not paid yet' }],
  hstPct: 13, staff: ['Melanie'], bookedBy: 'Melanie', signedIn: true, sources: ['Walk-in', 'Existing Client'], caseTypes: [], backDays: 30,
};
/** The pop-up against a fake page; every POST waits until the test answers it (answer(i, status, json)). */
function popupWorld() {
  const els = {};
  const el = (id) => (els[id] = els[id] || fakeEl(id));
  const radios = { 'dq-choice': ['new', 'existing'], 'dq-how': OPTIONS.meetingTypes, 'dq-pay': OPTIONS.payments.map((p) => p.kind), 'dq-inca': ['Yes', 'No', ''], 'dq-sq': ['yes', 'no'], 'dq-use': [] };
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
  let open = true;
  const dlg = { box, openId: 1, busy: false, still: () => open, setBusy(on) { dlg.busy = !!on; }, close() { open = false; dlg.busy = false; dlg.closed = true; return true; }, tryClose() { open = false; dlg.closed = true; } };
  const ctx = {
    DQ_FORM: DQ.dqFormHtml(), DQ_OPTS: null, Intl, Date, Math, Number, String, isFinite, isNaN, encodeURIComponent, JSON, setTimeout, clearTimeout,
    peekKey: () => 'k', getKey: () => 'k', tdotDialogNew: () => dlg,
    tdotRef: () => ({ check: () => '', value: () => '', from: () => 'typed', focus() {} }),
    tdotBlacklistHtml: () => '', load: () => {}, location: { pathname: '/admin/consultations' },
    document: { getElementById: (id) => el(id) },
    fetch: (url, o) => {
      if (String(url).startsWith('/api/consultation/client-matches')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ clients: [], cases: [], leads: [] }) });
      return new Promise((resolve) => { posts.push({ url, body: JSON.parse(o.body), answer: (s, j) => resolve({ status: s, json: () => Promise.resolve(j) }) }); });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DQ.DQ_JS + '\nDQ_OPTS=' + JSON.stringify(OPTIONS) + ';\nopenDirectConsult();', ctx);
  const pickRadio = (n, v) => { R[n].forEach((r) => { r.checked = r.value === v; }); const r = R[n].find((x) => x.value === v); if (r && r.onchange) r.onchange({}); };
  const type = (id, v, ev = 'input') => { el(id).value = v; el(id).fire(ev); };
  const fill = () => {
    type('dq-name', 'Asha Example'); type('dq-phone', '4165550101');
    pickRadio('dq-choice', 'existing');
    el('dq-consultant').value = SHAFOLI; el('dq-consultant').onchange();
    pickRadio('dq-how', 'In-person'); type('dq-when', torontoIn(-1 * DAY).slice(0, 10) + 'T12:00', 'change');
    pickRadio('dq-pay', 'none'); type('dq-about', 'file question');
  };
  return { el, posts, dlg, fill, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

/* ── 3: one save at a time ── */

test('3 pop-up: a double click on Save sends ONE request', async () => {
  const w = popupWorld();
  w.fill();
  w.el('dq-save').onclick(); w.el('dq-save').onclick();
  await w.settle();
  assert.equal(w.posts.length, 1);
  w.posts[0].answer(200, { ok: true, message: 'Saved: Asha Example.', link: '/admin/consultation/9', left: [] });
  await w.settle();
  assert.match(w.el('dq-done').innerHTML, /Saved: Asha Example/);
});

test('3 pop-up: after a clash, a double click on "Save anyway" sends ONE request and the "Saved" line is never replaced by "Not saved"', async () => {
  const w = popupWorld();
  w.fill();
  w.el('dq-save').onclick();
  await w.settle();
  w.posts[0].answer(409, { error: 'Shafoli Kapur already has a consultation at …', code: 'clash', clash: [{ leadId: '5', name: 'Other', slot: 'x', consultant: SHAFOLI }] });
  await w.settle();
  assert.match(w.el('dq-server').innerHTML, /Save anyway \(different client\)/);
  const anyway = w.el('dq-anyway');
  anyway.onclick(); anyway.onclick();
  assert.equal(anyway.disabled, true, 'greyed while saving');
  await w.settle();
  assert.equal(w.posts.length, 2, 'the first save + ONE "Save anyway"');
  assert.equal(w.posts[1].body.clashAck, true);
  w.posts[1].answer(200, { ok: true, message: 'Saved: Asha Example.', link: '/admin/consultation/9', left: [] });
  await w.settle();
  assert.equal(w.dlg.closed, true);
  assert.match(w.el('dq-done').innerHTML, /Saved: Asha Example/);
  assert.doesNotMatch(w.el('dq-done').innerHTML, /Not saved/);
  assert.equal(w.posts.length, 2, 'nothing else went out');
});

test('3 pop-up: a refusal re-enables Save and "Save anyway", so staff can try again', async () => {
  const w = popupWorld();
  w.fill();
  w.el('dq-save').onclick();
  await w.settle();
  w.posts[0].answer(409, { error: 'clash', code: 'clash', clash: [{ leadId: '5', slot: 'x' }] });
  await w.settle();
  w.el('dq-anyway').onclick();
  await w.settle();
  w.posts[1].answer(400, { error: 'Could not look this person up just now — nothing was saved.' });
  await w.settle();
  assert.equal(w.el('dq-save').disabled, false); assert.equal(w.el('dq-anyway').disabled, false);
  assert.match(w.el('dq-err').textContent, /Could not look this person up/);
  w.el('dq-save').onclick();
  await w.settle();
  assert.equal(w.posts.length, 3, 'a new save is possible');
});

/* ── 5: 503 in words ── */

test('5 the button on 503: greyed, and the server\'s words are shown on the page (not only a tooltip)', async () => {
  const b = fakeEl('btn-direct-consult'); b.hidden = true;
  const done = fakeEl('dq-done');
  const ctx = {
    document: { getElementById: (id) => (id === 'btn-direct-consult' ? b : id === 'dq-done' ? done : id === 'dq-done-x' ? fakeEl('x') : null) }, peekKey: () => 'k', Intl, Date,
    fetch: () => Promise.resolve({ status: 503, json: () => Promise.resolve({ error: 'Direct consultation is not set up yet: its Lead Board column has not been made. Nothing was saved.' }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(DQ.DQ_JS + '\ndqInitButton();', ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.hidden, false); assert.equal(b.disabled, true);
  assert.match(b.title, /not set up yet/);
  assert.match(done.innerHTML, /Direct consultation is not set up yet/);
  assert.equal(done.style.display, 'block');
  assert.equal(done.className, 'warn');
  // 200 / 404 never show it
  for (const status of [200, 404]) {
    const d2 = fakeEl('dq-done'); const b2 = fakeEl('btn-direct-consult');
    const c2 = { document: { getElementById: (id) => (id === 'btn-direct-consult' ? b2 : id === 'dq-done' ? d2 : null) }, peekKey: () => 'k', Intl, Date,
      fetch: () => Promise.resolve({ status, json: () => Promise.resolve(status === 200 ? OPTIONS : { error: 'Not found' }) }) };
    vm.createContext(c2); vm.runInContext(DQ.DQ_JS + '\ndqInitButton();', c2);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(d2.innerHTML, '', `HTTP ${status}`);
  }
});

/* ── 4 + 6: the record page, run ── */

function scriptsOf(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]); }
const RECORD = scriptsOf(ADM.buildDetailHTML('555')).pop();
function pick(name) {
  const i = RECORD.indexOf(`function ${name}(`); assert.ok(i >= 0, name);
  let depth = 0, j = RECORD.indexOf('{', i);
  for (; j < RECORD.length; j++) { if (RECORD[j] === '{') depth++; else if (RECORD[j] === '}' && --depth === 0) break; }
  return RECORD.slice(i, j + 1);
}
function cpWhyDecl() { const m = RECORD.match(/var CP_WHY=\{[^\n]*\};/); assert.ok(m, 'CP_WHY'); return m[0]; }

test('4 the fee dialog names "Change time" only when the button is on the page; the server reply allows for it not being there', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(cpWhyDecl() + '\n' + pick('cpDirectWhy'), ctx);
  const can = ctx.cpDirectWhy({ direct: { canChangeTime: true } });
  assert.match(can, /Change its time with Change time\./);
  for (const d of [{ direct: { canChangeTime: false } }, { direct: {} }, null]) {
    const t = ctx.cpDirectWhy(d);
    assert.doesNotMatch(t, /with Change time/, JSON.stringify(d));
    assert.match(t, /change it in Monday/);
  }
  const done = ctx.cpDirectWhy({ outcome: 'Retain', direct: { canChangeTime: true } });
  assert.doesNotMatch(done, /Change time|Monday/, 'an outcome is set: nothing about the time');
  assert.match(RECORD, /orc\.why==='direct-consult'\?cpDirectWhy\(LAST_DETAIL\)/, 'the dialog uses it');
  // the server's words (no viewer there): true whether or not the button shows
  const line = portal._packageResultLine(null, { pkgChoice: '', applicable: { ok: false, why: 'direct-consult' }, onRecord: true });
  assert.match(line, /change its time with "Change time" on this page, or in Monday if that button is not shown/);
});

/** The record page's direct-consultation code in a fake page: a dialog per tdotDialogNew, fetchT scripted. */
function recordPage(answers) {
  const dialogs = [], requests = [], msgs = [];
  const ctx = {
    LEAD_ID: '555', JSON, String, Number, encodeURIComponent, setTimeout, clearTimeout, location: { pathname: '/admin/consultation/555' }, window: {},
    getKey: () => 'k',
    escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    netErr: (e) => 'Failed: ' + (e && e.message), setMsg: (t, k) => msgs.push([k, t]), load: () => { ctx.loaded = (ctx.loaded || 0) + 1; },
    disableActions: () => {}, RP_AMEND: false,
    tdotDialogNew: () => {
      const els = {};
      const el = (k) => (els[k] = els[k] || fakeEl(k));
      let open = true;
      const box = { innerHTML: '', querySelector: (sel) => el(sel) };
      const d = { box, els: el, openId: dialogs.length + 1, busy: false, still: (id) => open && id === d.openId, setBusy(on) { d.busy = !!on; },
        close() { open = false; d.busy = false; d.closed = true; return true; }, tryClose(how) { open = false; d.closed = how || true; return true; } };
      dialogs.push(d);
      return d;
    },
    fetchT: (url, o) => {
      const a = answers.shift() || { s: 200, j: { ok: true } };
      requests.push({ url, body: JSON.parse(o.body) });
      return a.hold ? new Promise((res) => { a.release = () => res({ status: a.s, json: () => Promise.resolve(a.j) }); requests[requests.length - 1].release = a.release; })
        : Promise.resolve({ status: a.s, json: () => Promise.resolve(a.j) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext([pick('dqAskFirst'), pick('openChangeTime'), pick('openChangeConsultant'), pick('doAction')].join('\n'), ctx);
  return { ctx, dialogs, requests, msgs, settle: () => new Promise((r) => setTimeout(r, 15)) };
}
const DETAIL = { name: 'Asha Example', bookedSlot: '2026-12-01 11:00', direct: { durationMin: 30, canChangeTime: true, rcics: ['Shafoli Kapur', 'Shermin Test'] }, assignedConsultant: { name: 'Gauri Berde' } };

test('6 Change time: posts changeDirectTime with date, time, length and clashAck:false; a clash offers "Save anyway" (clashAck:true); editing resets it', async () => {
  const p = recordPage([{ s: 409, j: { code: 'clash', error: 'Shafoli Kapur already has a consultation at 2026-12-02 10:00…' } }, { s: 200, j: { ok: true, message: 'Time changed to 2026-12-02 10:00.' } }]);
  p.ctx.openChangeTime(DETAIL);
  const d = p.dialogs[0];
  assert.equal(d.els('#dqt-when').value, '', 'the fake input starts empty');
  d.els('#dqt-when').value = '2026-12-02T10:00'; d.els('#dqt-len').value = '45';
  d.els('[data-go]').onclick();
  await p.settle();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url, '/api/consultation/555/action');
  assert.equal(p.requests[0].body.action, 'changeDirectTime');
  assert.deepEqual(JSON.parse(p.requests[0].body.value), { date: '2026-12-02', time: '10:00', durationMin: 45, clashAck: false });
  assert.match(d.els('#dqt-clash').innerHTML, /Save anyway \(different client\)/);
  assert.equal(d.closed, undefined, 'stays open on a clash');
  // editing the time after the warning clears it (the next save is checked again)
  d.els('#dqt-when').fire('input');
  assert.equal(d.els('#dqt-clash').innerHTML, '');
  // "Save anyway": clashAck true — a double click sends once
  d.els('#dqt-anyway').onclick(); d.els('#dqt-anyway').onclick();
  await p.settle();
  assert.equal(p.requests.length, 2);
  assert.equal(JSON.parse(p.requests[1].body.value).clashAck, true);
  assert.equal(d.closed, true);
  assert.deepEqual(p.msgs.pop(), ['ok', 'Time changed to 2026-12-02 10:00.']);
});

test('6 Change time: a double click on "Save time" sends once; a 401 with loginUrl shows the Monday sign-in link and does not leave the page', async () => {
  const p = recordPage([{ s: 401, j: { error: 'Sign in with Monday to add a direct consultation.', loginUrl: '/q/auth/monday' }, hold: true }]);
  p.ctx.openChangeTime(DETAIL);
  const d = p.dialogs[0];
  d.els('#dqt-when').value = '2026-12-02T10:00'; d.els('#dqt-len').value = '30';
  d.els('[data-go]').onclick(); d.els('[data-go]').onclick();
  assert.equal(p.requests.length, 1, 'one request while the first runs');
  p.requests[0].release();
  await p.settle();
  assert.match(d.els('.tdlg-err').innerHTML, /Sign in with Monday<\/a>$/);
  assert.match(d.els('.tdlg-err').innerHTML, /href="\/q\/auth\/monday\?returnTo=%2Fadmin%2Fconsultation%2F555"/);
  assert.equal(p.ctx.window.location, undefined, 'no redirect');
  assert.equal(d.busy, false); assert.equal(d.els('[data-go]').disabled, false);
});

test('6 Change consultant posts setConsultant with the chosen RCIC; nothing is posted without a choice', async () => {
  const p = recordPage([{ s: 200, j: { ok: true, message: 'Consultant changed to Shafoli Kapur.' } }]);
  p.ctx.openChangeConsultant(DETAIL);
  const d = p.dialogs[0];
  d.els('[data-go]').onclick();
  assert.equal(p.requests.length, 0);
  assert.equal(d.els('.tdlg-err').textContent, 'Choose the RCIC.');
  d.els('#dqc-sel').value = 'Shafoli Kapur';
  d.els('[data-go]').onclick();
  await p.settle();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].body.action, 'setConsultant'); assert.equal(p.requests[0].body.value, 'Shafoli Kapur');
  assert.equal(d.closed, true);
  assert.equal(p.ctx.loaded, 1);
});

test('6 ask first: Cancel changes nothing; "Yes, go ahead" re-posts with confirm:true; a second "asks first" never loops', async () => {
  // Cancel
  let p = recordPage([{ s: 409, j: { needsConfirm: true, error: 'This was added as a Follow-up. Open a new case from it?' } }]);
  p.ctx.doAction('retainAndSend', 'x');
  await p.settle();
  assert.equal(p.requests.length, 1); assert.equal(p.requests[0].body.confirm, false);
  assert.equal(p.dialogs.length, 1, 'the shared pop-up asks');
  p.dialogs[0].els('[data-x]').onclick();
  assert.deepEqual(p.msgs.pop(), ['info', 'Nothing was changed.']);
  assert.equal(p.requests.length, 1, 'nothing posted again');
  // Yes, go ahead → confirm:true; the server asking AGAIN is an error, not a second question
  p = recordPage([{ s: 409, j: { needsConfirm: true, error: 'Open a new case?' } }, { s: 409, j: { needsConfirm: true, error: 'Still asks.' } }]);
  p.ctx.doAction('retainAndSend', 'x');
  await p.settle();
  p.dialogs[0].els('[data-go]').onclick();
  await p.settle();
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1].body.confirm, true);
  assert.equal(p.requests[1].body.action, 'retainAndSend');
  assert.equal(p.dialogs.length, 1, 'no second question');
  assert.deepEqual(p.msgs.pop(), ['err', 'Failed: Still asks.']);
});
