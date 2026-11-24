'use strict';
process.env.DIRECT_ONLY_CONSULTANTS = 'Gauri Berde';

// Client ID step 3 (2026-11-25): "＋ Direct consultation" with a fee (paid or Free) starts the
// client-account step (account + Client ID) right after the fee record — in the background, with
// the lead as written (a just-made row may not read back) and the account staff chose kept.
// "Not paid yet" starts nothing (it is not a paid consultation). The harness is the one of
// test/directConsultServer.test.js (every Monday / Square / OneDrive seam stubbed).

const test   = require('node:test');
const assert = require('node:assert/strict');

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
const updates     = require('../src/services/updatesService');
const routing     = require('../config/consultantRouting');
const C           = require('../src/data/newLeadsBoard.json').columns;

// Money first (CONSULT_MONEY_FIRST, 2026-11-20) ships off: these tests are the switched-off app whatever the machine's
// environment or its .env file says. The tests of the switch set it themselves.
// This line must stay AFTER the requires above: the first require of app code loads .env (config/monday.js calls
// dotenv), and dotenv fills in any variable that is not set — a delete placed before the requires is undone.
delete process.env.CONSULT_MONEY_FIRST;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function quiet() { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; }
/** Toronto 'YYYY-MM-DD HH:MM', ms from now. */
function torontoIn(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const DAY = 86400000;
const COL_ID = 'text_test_directc';
const FARAN = { name: 'Faran Test', email: 'faran@example.com', verified: true };
const SHAFOLI = routing.CONSULTANTS.shafoli.name, SHERMIN = routing.CONSULTANTS.shermin.name, GAURI = 'Gauri Berde';

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** The column made + the switch on (as for Faran's live test), then the shipped state back. */
async function live(fn, { sw = '1' } = {}) {
  const col = C.directConsult;
  C.directConsult = COL_ID;
  dcs._resetForTests();
  try { return await withEnv({ DIRECT_CONSULTATION: sw }, fn); } finally { C.directConsult = col; dcs._resetForTests(); }
}

/** A future consultation 3 days ahead at 11:00 Toronto. */
function futureDay(days = 3) { return torontoIn(days * DAY).slice(0, 10); }
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
 * The stubbed world: Monday (create / update / notes), the matcher, the snapshot, the Not
 * Wanted list, the slot claims, prices, the package, meetings, tokens, OneDrive folders.
 */
function world({ matches = {}, snapRows = [], hit = false, claims = [], getLead = null, pkg = null } = {}) {
  dcs._resetForTests();   // each world starts with an empty re-submit memory
  const calls = { monday: [], creates: [], updates: [], notes: [], folders: 0, meetings: 0, pkg: [], claimsRead: 0, lookups: 0 };
  const r = [
    quiet(),
    stub(mondayApi, 'query', async (q, v = {}) => {
      calls.monday.push({ q, v });
      if (/create_item/.test(q)) { calls.creates.push(JSON.parse(v.cols)); return { create_item: { id: '900' } }; }
      if (/items_page\(limit:1\)/.test(q)) return { boards: [{ groups: [{ items_page: { items: [] } }] }] };
      if (/change_multiple_column_values/.test(q)) { calls.updates.push({ id: String(v.itemId), cols: JSON.parse(v.cols) }); return { change_multiple_column_values: { id: v.itemId } }; }
      if (/create_update/.test(q)) { calls.notes.push({ id: String(v.id || v.i), body: String(v.b) }); return { create_update: { id: 'u1' } }; }
      return {};
    }),
    stub(portal, 'findClientMatches', async () => { calls.lookups++; return { leads: [], cases: [], clients: [], rawLeads: [], ...matches }; }),
    stub(snap, 'leads', async () => snapRows),
    stub(blacklist, 'check', async () => (hit ? { checked: true, hit: true, matchedOn: 'email', entries: [{ name: 'X' }] } : { checked: true, hit: false })),
    stub(blacklist, 'noteOnLead', async () => true),
    stub(booking, 'readSlotClaims', async () => { calls.claimsRead++; return claims; }),
    stub(prices, 'ensureFresh', async () => {}),
    stub(consultSvc, 'autoSendConsultationPackage', async (id, opts) => { calls.pkg.push({ id, opts }); return pkg || { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async () => { calls.meetings++; throw new Error('no meeting may be made'); }),
    stub(tokens, 'ensureToken', async () => 'tok'),
    stub(oneDrive, 'ensureLeadFolder', async () => { calls.folders++; return { id: 'f', url: 'u' }; }),
    stub(portal, 'getDirectClientOptions', async () => ({ caseTypes: ['Study Permit', 'Visitor Visa'] })),
    ...(getLead ? [stub(leadService, 'getLead', getLead)] : []),
  ];
  return { calls, restore: () => r.reverse().forEach((x) => x()) };
}
/** The column values written to one item, merged in order. */
function written(calls, id) { return Object.assign({}, ...calls.updates.filter((u) => u.id === String(id)).map((u) => u.cols)); }

const accounts = require('../src/services/clientAccountService');

test('direct consultation with a fee: the account step starts once, with the lead as written; a pop-up account choice is kept; "Not paid yet" starts nothing', async () => {
  await live(async () => {
    for (const [over, expectCall] of [
      [{}, true],
      [{ payment: { kind: 'waived', note: 'returning client' } }, true],
      [{ clientAccountId: '4242' }, true],
      [{ payment: { kind: 'none' } }, false],
    ]) {
      const calls = [];
      const w = world();
      const r0 = stub(accounts, 'queueConsultationPaid', (id, o) => { calls.push({ id: String(id), o }); return Promise.resolve({}); });
      try {
        const r = await dcs.createDirectConsult(entry(over), { actor: FARAN });
        assert.equal(r.ok, true, JSON.stringify(over));
        if (!expectCall) { assert.equal(calls.length, 0, 'not paid: nothing'); continue; }
        assert.equal(calls.length, 1, JSON.stringify(over));
        assert.equal(calls[0].id, '900');
        assert.equal(calls[0].o.via, 'direct consultation');
        assert.equal(calls[0].o.lead.fullName, 'Asha Example');
        assert.equal(calls[0].o.lead.email, 'asha@example.com');
        assert.equal(calls[0].o.lead.phone, '416 555 0101');
        assert.equal(calls[0].o.lead.id, '900');
        if (over.clientAccountId) assert.equal(calls[0].o.lead.clientAccountId, '4242');
        else assert.equal(calls[0].o.lead.clientAccountId, undefined);
      } finally { r0(); w.restore(); }
    }
  });
});

test('direct consultation: the account step failing to start never fails the save', async () => {
  await live(async () => {
    const w = world();
    const r0 = stub(accounts, 'queueConsultationPaid', () => { throw new Error('boom'); });
    try {
      const r = await dcs.createDirectConsult(entry(), { actor: FARAN });
      assert.equal(r.ok, true);
      assert.ok(!r.left.length, r.left.join(' | '));
    } finally { r0(); w.restore(); }
  });
});
