'use strict';

// Sponsor onboarding — ensureSponsor, driven through its I/O seam.
// Every side effect goes through S.io, which each test replaces wholesale with
// a fake store, so nothing here can reach Monday, OneDrive or an inbox.

const test   = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/services/sponsorOnboardingService');

const CM = (over = {}) => ({
  itemId: '4001', clientName: 'Aisha Khan', caseRef: '2026-SOWP-017', caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)',
  clientEmail: 'aisha@example.com', accessToken: 'TDOT-abc', caseStage: 'Document Collection Started', paymentStatus: 'Paid', checklistTemplateApplied: 'No',
  ...over,
});
const LEAD = (over = {}) => ({ id: '9001', fullName: 'Aisha Khan', clientMasterItemId: '4001', inviterName: 'Faheem Khan', inviterEmail: 'faheem@example.com', retainerSigned: '2026-09-01', retainerPaid: '2026-09-02', retainerCountersign: '', ...over });
const PRIMARY = () => [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }];
const ROLE_OF = { Sponsor: 'Sponsor', Spouse: 'Spouse' };
const TYPE_OF = { Sponsor: 'Sponsor', Spouse: 'Spouse / Common-Law Partner' };

/** A fake Monday + OneDrive: one case, its leads, the family board, the manifest, the marker, and a log. */
function withFakeIo(fn, { cm = CM(), claimants = [LEAD()], members = [], manifest = null, marker = null, env = 'true', ...hooks } = {}) {
  const real = { ...S.io };
  const prevEnv = process.env.SPONSOR_ONBOARDING;
  if (env === null) delete process.env.SPONSOR_ONBOARDING; else process.env.SPONSOR_ONBOARDING = env;   // null = the switch is absent
  const store = { cm: { ...cm }, claimants: claimants.map((l) => ({ ...l })), composition: { caseFlags: {}, members: members.map((m) => ({ ...m })) }, manifest: manifest && manifest.map((m) => ({ ...m })), marker: marker && { ...marker }, leadWrites: [] };
  const calls = [];
  const log = (name, ...a) => calls.push([name, ...a]);
  let t = Date.parse('2026-09-24T15:00:00Z');
  const seedFromBoard = () => {
    const extra = store.composition.members.filter((m) => TYPE_OF[m.role] || m.role === 'WorkerSpouse');
    if (!extra.length) return PRIMARY();
    const out = PRIMARY();
    for (const m of extra) {
      const type = m.role === 'WorkerSpouse' ? 'Worker Spouse' : TYPE_OF[m.role];
      out.push({ key: m.memberKey || 'x', type, label: (m.name && !/\(from intake\)/i.test(m.name)) ? m.name : (type === 'Spouse / Common-Law Partner' ? 'Spouse' : type), source: 'family-board' });
    }
    store.manifest = out;   // seeding persists, as the real loadMembers does
    return out;
  };
  Object.assign(S.io, {
    readCase:        async (args) => { log('readCase', args); if (hooks.caseThrows) throw new Error('monday down'); return { ...store.cm }; },
    findClaimants:   async (id) => { log('findClaimants', id); if (hooks.claimantsThrow) throw new Error('monday down'); return store.claimants.map((l) => ({ ...l })); },
    readComposition: async (ref) => { log('readComposition', ref); if (hooks.compositionThrows) throw new Error('monday down'); return { caseFlags: {}, members: store.composition.members.map((m) => ({ ...m })) }; },
    readMarker:      async (args) => { log('readMarker', args.caseRef); if (hooks.markerThrows) throw new Error('graph down'); return store.marker && { ...store.marker }; },
    readManifest:    async (args) => { log('readManifest', args.caseRef); if (hooks.manifestThrows) throw new Error('graph down'); return store.manifest ? store.manifest.map((m) => ({ ...m })) : null; },
    // seedFails: the board read INSIDE the seed fails — the real loadMembers then degrades to the default primary-only list without saving it
    loadMembers:     async (args) => { log('loadMembers', args.caseRef); if (hooks.manifestThrows) throw new Error('graph down'); return store.manifest ? store.manifest.map((m) => ({ ...m })) : hooks.seedFails ? PRIMARY() : seedFromBoard(); },
    // intakeRows: what the lead's intake answers would put on the board (createFromLead creates nothing once any row exists)
    createIntakeRows: async (args) => {
      log('createIntakeRows', args);
      if (hooks.intakeRowsThrow) throw new Error('monday down');
      if (!Array.isArray(hooks.intakeRows) || store.composition.members.length) return 0;
      for (const m of hooks.intakeRows) store.composition.members.push({ ...m });
      return hooks.intakeRows.length;
    },
    addMember:       async (args) => {
      log('addMember', { memberType: args.memberType, label: args.label });
      if (hooks.addMemberThrows) throw new Error('graph down');
      if (!store.manifest) store.manifest = PRIMARY();
      if (store.manifest.some((m) => m.type === args.memberType)) throw new Error(`A ${args.memberType.split(' / ')[0]} has already been added to this case.`);
      const m = { key: args.memberType === 'Sponsor' ? 'sponsor' : 'spouse', type: args.memberType, label: args.label };
      store.manifest.push(m);
      return m;
    },
    createFamilyRow: async (args) => {
      log('createFamilyRow', { memberType: args.row.memberType, memberKey: args.row.memberKey, name: args.row.name, caseRef: args.caseRef, cmItemId: args.cmItemId });
      if (hooks.rowThrows) throw new Error('monday down');
      store.composition.members.push({ role: ROLE_OF[args.row.memberType], name: args.row.name, memberKey: args.row.memberKey, flags: {} });
      return '777';
    },
    writeMarker:     async ({ marker: m }) => {
      log('writeMarker', m.status, m);
      if (hooks.markerWriteThrows === true || hooks.markerWriteThrows === m.status) throw new Error('graph down');
      store.marker = { ...m };
    },
    sendEmail:       async (msg) => { log('sendEmail', msg.to, msg.subject, msg.html); if (hooks.sendThrows) throw new Error('Graph 503'); },
    postNote:        async (item, body) => { log('postNote', item, body); if (hooks.noteThrows) throw new Error('monday down'); },
    updateLead:      async (...args) => { log('updateLead', ...args); store.leadWrites.push(args); if (hooks.updateLeadThrows) throw new Error('monday down'); Object.assign(store.claimants[0], args[1]); },
    ensureAccessToken: async (id) => { log('ensureAccessToken', id); if (hooks.noToken) throw new Error('monday down'); return 'TDOT-new'; },
    now:             () => (t += 1000),
    scheduleRetry:   (fn, ms) => { log('scheduleRetry', ms); store.retry = fn; },   // the test fires it by hand
  });
  S._retried.clear();
  S._noted.clear();
  const names = () => calls.map((c) => c[0]);
  return Promise.resolve(fn({ store, calls, names })).finally(() => {
    Object.assign(S.io, real);
    if (prevEnv === undefined) delete process.env.SPONSOR_ONBOARDING; else process.env.SPONSOR_ONBOARDING = prevEnv;
  });
}

const onboard = (over = {}) => S.ensureSponsor({ itemId: '4001', mode: 'onboard', trigger: 'dcs', ...over });
const staff   = (over = {}) => S.ensureSponsor({ itemId: '4001', caseRef: '2026-SOWP-017', mode: 'staff', actor: { name: 'Gauri', email: 'gauri@example.com', verified: true }, trigger: 'staff', ...over });
const WRITES  = ['createFamilyRow', 'addMember', 'writeMarker', 'sendEmail', 'postNote', 'updateLead'];
// The writes that change the CASE (a staff note is a message, not data): a pass
// that could not send on a one-shot trigger still posts a note saying so.
const DATA_WRITES = ['createFamilyRow', 'addMember', 'writeMarker', 'sendEmail', 'updateLead'];

/** Everything a pass leaves behind that is not the email itself. */
const LEAK = /faheem@example\.com|rahim@example\.com|TDOT-abc|TDOT-new/;
function leaks({ store, calls, r, logs = [] }) {
  return JSON.stringify([store.marker, calls.filter((c) => c[0] === 'postNote'), calls.filter((c) => c[0] === 'writeMarker'), r, logs]);
}

// ─── The happy path ───────────────────────────────────────────────────────────

test('SOWP-017 end to end (onboard): reads, then row → manifest → pending → email → sent → note, in that order', () => withFakeIo(async ({ store, calls, names }) => {
  const r = await onboard();
  assert.equal(r.done, true); assert.equal(r.sent, true); assert.equal(r.to, 'f***@example.com'); assert.equal(r.variant, 'onboarding');
  assert.deepEqual(r.created, { row: true, member: false });
  assert.equal(r.sectionLabel, 'Faheem Khan');
  const n = names();
  // On an empty board the intake's own rows are asked for BEFORE the sponsor's row (the case-ref chain may still be on its way).
  const order = ['readCase', 'findClaimants', 'readComposition', 'readMarker', 'createIntakeRows', 'createFamilyRow', 'readManifest', 'writeMarker', 'sendEmail', 'writeMarker', 'postNote'];
  assert.deepEqual(n, order);
  assert.ok(n.indexOf('readManifest') > n.indexOf('createFamilyRow'), 'the manifest is read AFTER the row exists');
  assert.deepEqual(calls.find((c) => c[0] === 'createIntakeRows')[1], { itemId: '4001', caseRef: '2026-SOWP-017' });
  const row = calls.find((c) => c[0] === 'createFamilyRow')[1];
  assert.deepEqual(row, { memberType: 'Sponsor', memberKey: 'sponsor', name: 'Faheem Khan', caseRef: '2026-SOWP-017', cmItemId: '4001' });
  const markers = calls.filter((c) => c[0] === 'writeMarker').map((c) => c[1]);
  assert.deepEqual(markers, ['pending', 'sent']);
  assert.ok(names().indexOf('sendEmail') > names().indexOf('writeMarker'), 'pending is written BEFORE the send');
  const email = calls.find((c) => c[0] === 'sendEmail');
  assert.equal(email[1], 'faheem@example.com');
  assert.match(email[2], /^Action Required — Your part in Aisha Khan's SOWP application \(2026-SOWP-017\)$/);
  const m = store.marker;
  assert.equal(m.status, 'sent'); assert.equal(m.version, 1); assert.equal(m.caseRef, '2026-SOWP-017'); assert.equal(m.leadId, '9001');
  assert.deepEqual(m.sponsor, { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') }, 'the address fingerprint, never the address');
  assert.equal(m.role, 'Sponsor'); assert.equal(m.roleLabel, 'Worker Spouse'); assert.equal(m.sectionMode, 'section'); assert.equal(m.sectionLabel, 'Faheem Khan');
  assert.equal(m.sendCount, 1); assert.equal(m.sends.length, 1); assert.equal(m.sends[0].by, 'auto:dcs'); assert.equal(m.sends[0].variant, 'onboarding'); assert.equal(m.sends[0].to, 'f***@example.com');
  assert.ok(m.rowCreatedAt && m.startedAt && m.sentAt);
  assert.ok(!JSON.stringify(m).includes('faheem@example.com'), 'the marker never carries the raw address');
  const note = calls.find((c) => c[0] === 'postNote');
  assert.equal(note[1], '4001');
  assert.match(note[2], /Sponsor portal email sent automatically to f\*\*\*@example\.com \(Worker Spouse\) — \d{1,2} Sep 2026, \d{1,2}:\d{2} [ap]m \(Toronto\)/);
  assert.match(note[2], /Questionnaire section "Faheem Khan" created\./);
  assert.doesNotMatch(leaks({ store, calls, r }), LEAK, 'the marker, the notes, the log and the result never carry the raw address or the token');
  assert.equal((email[3].match(/TDOT-abc/g) || []).length, 1, 'the token appears exactly once in the email — inside the link');
  assert.ok(!email[2].includes('TDOT-abc'), 'never in the subject');
}));

test('manifest already on file, primary-only → the sponsor section is added ONCE, with the real name, before the pending marker', () => withFakeIo(async ({ store, calls, names }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.deepEqual(r.created, { row: true, member: true });
  const adds = calls.filter((c) => c[0] === 'addMember');
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0][1], { memberType: 'Sponsor', label: 'Faheem Khan' });
  assert.ok(names().indexOf('addMember') < names().indexOf('writeMarker'));
  assert.ok(store.marker.memberAddedAt);
  assert.deepEqual(store.manifest.map((m) => m.type), ['Principal Applicant', 'Sponsor']);
}, { manifest: PRIMARY() }));

test('a second onboard call after a send: zero writes, zero sends (already-sent)', () => withFakeIo(async ({ names, calls }) => {
  await onboard();
  const before = calls.length;
  const r = await onboard({ trigger: 'sub-type' });
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'already-sent');
  assert.deepEqual(names().slice(before).filter((n) => WRITES.includes(n)), []);
}));

test('two concurrent calls (DCS webhook + sub-type webhook): exactly one send', () => withFakeIo(async ({ names }) => {
  const [a, b] = await Promise.all([onboard({ trigger: 'dcs' }), onboard({ trigger: 'sub-type' })]);
  assert.equal([a, b].filter((r) => r.sent).length, 1);
  assert.equal([a, b].filter((r) => r.reason === 'in-flight').length, 1);
  assert.equal(names().filter((n) => n === 'sendEmail').length, 1);
  assert.equal(names().filter((n) => n === 'createFamilyRow').length, 1);
}));

// ─── Failures ─────────────────────────────────────────────────────────────────

test('the send throws at DCS: the marker reads failed, the error is rethrown — and staff are told on the case, ONE retry is scheduled, and the retry sends exactly once', () => withFakeIo(async ({ store, names, calls }) => {
  await assert.rejects(onboard(), /Graph 503/);
  assert.equal(store.marker.status, 'failed');
  assert.match(store.marker.error, /Graph 503/);
  assert.ok(store.marker.failedAt);
  assert.ok(!JSON.stringify(store.marker).includes('faheem@example.com'), 'the failed marker never carries the raw address either');
  // the outcome is visible: a note on the case, and a retry through the seam
  const notes = calls.filter((c) => c[0] === 'postNote');
  assert.equal(notes.length, 1);
  assert.equal(notes[0][1], '4001');
  assert.equal(notes[0][2], '🤝 Sponsor portal email could not be sent just now (Graph 503). One more attempt follows in about 90 seconds; if the Sponsor / inviter card still shows "Last attempt failed" after that, send it from the case page (Send sponsor link).');
  assert.doesNotMatch(notes[0][2], /faheem@example\.com|TDOT-abc/, 'no address, no token in the note');
  assert.deepEqual(calls.filter((c) => c[0] === 'scheduleRetry').map((c) => c[1]), [90 * 1000]);
  // Graph is back: the retry sends once (a failed marker is not a lock), as an onboarding email, recorded as auto:dcs-retry
  S.io.sendEmail = async (msg) => { calls.push(['sendEmail', msg.to, msg.subject, msg.html]); };
  const before = calls.length;
  await store.retry();
  assert.equal(calls.slice(before).filter((c) => c[0] === 'sendEmail').length, 1);
  assert.equal(store.marker.status, 'sent');
  assert.equal(store.marker.sends[0].by, 'auto:dcs-retry');
  assert.equal(store.marker.sends[0].variant, 'onboarding');
  assert.ok(!names().slice(before).includes('scheduleRetry'), 'a retry never schedules another');
  // the staff button's failure is unchanged: rethrown, no note, no retry (the route answers 502 and the card shows "Last attempt failed")
  await withFakeIo(async ({ names: n2 }) => {
    await assert.rejects(staff(), /Graph 503/);
    assert.ok(!n2().includes('postNote') && !n2().includes('scheduleRetry'));
  }, { sendThrows: true });
  // a send that fails on the RETRY itself, or on the sub-type trigger, logs only
  await withFakeIo(async ({ names: n3 }) => {
    await assert.rejects(onboard({ trigger: 'dcs-retry' }), /Graph 503/);
    await assert.rejects(onboard({ trigger: 'sub-type' }), /Graph 503/);
    assert.ok(!n3().includes('postNote') && !n3().includes('scheduleRetry'));
  }, { sendThrows: true });
}, { sendThrows: true }));

test('a one-shot "not sent" note is posted ONCE per case within ten minutes — a re-drag or a duplicate delivery repeats the log line, not the note', () => withFakeIo(async ({ calls, names }) => {
  assert.equal((await onboard()).reason, 'no-inviter');
  assert.equal((await onboard()).reason, 'no-inviter');                              // Monday redelivered the event
  assert.equal((await onboard({ trigger: 'retainer-paid' })).reason, 'no-inviter');   // another one-shot trigger, same case
  assert.equal(calls.filter((c) => c[0] === 'postNote').length, 1, 'one note');
  assert.equal(calls.filter((c) => c[0] === 'readCase').length, 3, 'every pass still ran');
  // after the window the note may go again (the time is the seam's: age the memory by hand)
  for (const [k, t] of S._noted) S._noted.set(k, t - S.NOTE_ONCE_MS - 1);
  assert.equal((await onboard()).reason, 'no-inviter');
  assert.equal(calls.filter((c) => c[0] === 'postNote').length, 2);
  // a DIFFERENT note on the same case is not held back by it
  await withFakeIo(async ({ calls: c2, store: s2 }) => {
    assert.equal((await onboard()).reason, 'no-inviter');
    s2.claimants.push(LEAD({ id: '9002' }));
    assert.equal((await onboard({ trigger: 'retainer-paid' })).reason, 'shared-case', 'the duplicate appeared meanwhile');
    const posted = c2.filter((c) => c[0] === 'postNote').map((c) => c[2]);
    assert.equal(posted.length, 2);
    assert.match(posted[0], /no sponsor \/ inviter email is on the client record/);
    assert.match(posted[1], /this case is linked to 2 client records/);
  }, { claimants: [LEAD({ inviterEmail: '' })] });
  assert.ok(names().length);
}, { claimants: [LEAD({ inviterEmail: '' })] }));

test('after a failed send the next pass sends (the failed marker is not a lock)', () => withFakeIo(async ({ store, names }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.equal(store.marker.status, 'sent');
  assert.equal(store.marker.error, undefined, 'the earlier failure is cleared');
  assert.equal(names().filter((n) => n === 'sendEmail').length, 1);
}, { marker: { version: 1, status: 'failed', error: 'Graph 503', startedAt: '2026-09-24T13:00:00Z', failedAt: '2026-09-24T13:00:01Z', sendCount: 0, sends: [] } }));

for (const [label, hooks] of [['the marker', { markerThrows: true }], ['the family board', { compositionThrows: true }], ['the manifest', { manifestThrows: true }], ['the leads', { claimantsThrow: true }], ['the case', { caseThrows: true }]]) {
  test(`${label} cannot be read → transient: nothing written, nothing sent — staff are told on the case and ONE retry is scheduled`, () => withFakeIo(async ({ names, calls }) => {
    const r = await onboard();
    assert.equal(r.done, false); assert.equal(r.reason, 'transient');
    assert.deepEqual(names().filter((n) => ['addMember', 'writeMarker', 'sendEmail', 'updateLead'].includes(n)), []);
    const note = calls.find((c) => c[0] === 'postNote');
    assert.ok(note, 'a note on the case');
    assert.equal(note[1], '4001');
    assert.match(note[2], /Sponsor portal email not sent automatically — the case could not be read or updated just now \((monday|graph) down\)\. One more attempt follows in about 90 seconds; if the Sponsor \/ inviter card still shows no email after that, send it from the case page \(Send sponsor link\)\./);
    assert.deepEqual(calls.filter((c) => c[0] === 'scheduleRetry').map((c) => c[1]), [90 * 1000]);
  }, hooks));
}

test('the manifest read fails AFTER the row was created: transient, no send — a retry finds the row and does not create another', () => withFakeIo(async ({ names, store }) => {
  const r = await onboard();
  assert.equal(r.reason, 'transient');
  assert.equal(names().filter((n) => n === 'createFamilyRow').length, 1);
  assert.ok(!names().includes('sendEmail'));
  S.io.readManifest = async () => null;
  const again = await onboard();
  assert.equal(again.sent, true);
  assert.equal(names().filter((n) => n === 'createFamilyRow').length, 1, 'the row from the first pass is recognised');
  assert.equal(store.composition.members.length, 1);
}, { manifestThrows: true }));

test('the pending marker cannot be written → transient, no send', () => withFakeIo(async ({ names }) => {
  const r = await onboard();
  assert.equal(r.reason, 'transient');
  assert.ok(!names().includes('sendEmail'));
}, { markerWriteThrows: 'pending' }));

test('SENT but the marker write failed: still reported sent, logged, and the note is posted (the trail that makes a later double visible)', () => withFakeIo(async ({ names, store }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.equal(store.marker.status, 'pending', 'the sent marker never landed');
  assert.ok(names().includes('postNote'));
}, { markerWriteThrows: 'sent' }));

test('no access token and none can be made → nothing sent, no marker', () => withFakeIo(async ({ names }) => {
  const r = await onboard();
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'no-token');
  assert.ok(!names().includes('writeMarker') && !names().includes('sendEmail'));
}, { cm: CM({ accessToken: '' }), noToken: true }));

test('a missing token is minted through accessTokenService and used in the link', () => withFakeIo(async ({ calls }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.ok(calls.some((c) => c[0] === 'ensureAccessToken' && c[1] === '4001'));
}, { cm: CM({ accessToken: '' }) }));

// ─── Identity + gates ─────────────────────────────────────────────────────────

test('2 claimants (a shared case) → nothing created, nothing sent; at DCS a note tells staff what to fix', () => withFakeIo(async ({ names, calls }) => {
  const r = await onboard();
  assert.equal(r.done, false); assert.equal(r.reason, 'shared-case'); assert.equal(r.claimantCount, 2);
  assert.deepEqual(names().filter((n) => DATA_WRITES.includes(n)), []);
  const note = calls.find((c) => c[0] === 'postNote');
  assert.match(note[2], /Sponsor portal email not sent automatically — this case is linked to 2 client records, so the sponsor can’t be identified safely\. Fix the duplicate on the Consultations page, then send it from the case page \(Send sponsor link\)\./);
  assert.ok(!names().includes('scheduleRetry'), 'no retry: a duplicate does not fix itself');
}, { claimants: [LEAD(), LEAD({ id: '9002' })] }));

test('no lead / no inviter / no case ref → nothing; only the missing inviter gets a note (the others the case page explains)', () => withFakeIo(async ({ names, calls }) => {
  assert.equal((await onboard()).reason, 'no-lead');
  assert.ok(!names().includes('postNote'), 'no lead: nowhere to store a sponsor, nothing to ask of staff');
  S.io.findClaimants = async () => [LEAD({ inviterEmail: '' })];
  assert.equal((await onboard()).reason, 'no-inviter');
  const note = calls.find((c) => c[0] === 'postNote');
  assert.equal(note[2], '🤝 Sponsor portal email not sent automatically — no sponsor / inviter email is on the client record. Add it on the case page (Sponsor / inviter card) and press Send sponsor link.');
  S.io.readCase = async () => CM({ caseRef: '' });
  assert.equal((await onboard()).reason, 'no-case-ref');
  S.io.readCase = async () => null;
  assert.equal((await onboard()).reason, 'no-case');
  assert.deepEqual(names().filter((n) => DATA_WRITES.includes(n)), []);
  assert.equal(names().filter((n) => n === 'postNote').length, 1, 'one note, for the missing inviter only');
}, { claimants: [] }));

test('switch OFF: the automatic path does nothing at all; the staff button ignores the switch', () => withFakeIo(async ({ names }) => {
  const r = await onboard();
  assert.equal(r.done, false); assert.equal(r.reason, 'disabled');
  assert.deepEqual(names(), [], 'not even a read');
  const s = await staff();
  assert.equal(s.sent, true);
}, { env: null }));

test('switch values: "true" and "1" enable; anything else does not', () => {
  const prev = process.env.SPONSOR_ONBOARDING;
  try {
    for (const [v, want] of [['true', true], ['TRUE', true], ['1', true], ['false', false], ['0', false], ['', false], ['yes', false]]) {
      process.env.SPONSOR_ONBOARDING = v;
      assert.equal(S.isEnabled(), want, `SPONSOR_ONBOARDING=${v}`);
    }
    delete process.env.SPONSOR_ONBOARDING;
    assert.equal(S.isEnabled(), false);
  } finally { if (prev === undefined) delete process.env.SPONSOR_ONBOARDING; else process.env.SPONSOR_ONBOARDING = prev; }
});

for (const [label, reason, opts] of [
  ['unpaid',                    'not-started',          { cm: CM({ paymentStatus: 'Already Sent' }) }],
  ["stage 'Retainer Signed'",   'not-started',          { cm: CM({ caseStage: 'Retainer Signed' }) }],
  ["checklist applied 'Yes'",   'already-onboarded',    { cm: CM({ checklistTemplateApplied: 'Yes' }) }],
  ['signature gate incomplete', 'signature-incomplete', { claimants: [LEAD({ retainerSigned: '' })] }],
  ['countersign outstanding',   'signature-incomplete', { claimants: [LEAD({ retainerCountersign: JSON.stringify({ clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: '' }) })] }],
]) {
  test(`gate (${label}): the automatic path creates NOTHING and sends nothing — reason ${reason}, no note`, () => withFakeIo(async ({ names, store }) => {
    const r = await onboard({ trigger: 'sub-type' });
    assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, reason);
    assert.deepEqual(r.created, { row: false, member: false });
    assert.deepEqual(names().filter((n) => WRITES.includes(n)), [], 'no row, no member, no marker, no note — an old onboarded case is not grown by a Sub Type edit');
    assert.equal(store.marker, null);
    assert.deepEqual(store.composition.members, []);
    assert.deepEqual(store.manifest.map((m) => m.label), ['Primary Applicant']);
  }, { manifest: PRIMARY(), ...opts }));
}

test("gate closed in 'staff' mode (Add sponsor now): the row and the section are created, nothing is sent, and the note says what happens next", () => withFakeIo(async ({ names, store, calls }) => {
  const r = await staff();
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'not-started');
  assert.deepEqual(r.created, { row: true, member: true });
  assert.ok(!names().includes('sendEmail') && !names().includes('writeMarker'));
  assert.equal(store.marker, null);
  assert.match(store.manifest.map((m) => m.label).join('|'), /Faheem Khan/);
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /Sponsor Faheem Khan added to the case by Gauri — questionnaire section "Faheem Khan" created\. The portal email goes out automatically when Document Collection starts\./);
}, { manifest: PRIMARY(), cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) }));

test('switch OFF, staff adds the sponsor before payment: the note tells staff to send it from the case page — never a promise the switch cannot keep', () => withFakeIo(async ({ calls }) => {
  const r = await staff();
  assert.equal(r.sent, false); assert.deepEqual(r.created, { row: true, member: true });
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /questionnaire section "Faheem Khan" created\. Send the portal email from the case page \(Send sponsor link\) once the case is paid and at Document Collection\./);
  assert.doesNotMatch(note, /automatically/);
}, { manifest: PRIMARY(), cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }), env: null }));

// ─── The Sub Type webhook vs the case-ref chain (ordering) ───────────────────
// Case Type set → chain: rename folder → createFamilyRowsForItem (the intake's
// Spouse/Child rows) → 'prepare' → resume. Staff pick the Sub Type seconds
// later, while the chain is still renaming the folder. That webhook must not
// put a Sponsor row on the board first: createFromLead then reads "1 member,
// already curated" and the intake's children are never created.

test('a Sub Type webhook landing BEFORE the chain has written the intake rows creates nothing (unpaid case), so createFromLead still creates the Spouse + 2 Child rows', () => withFakeIo(async ({ names, store }) => {
  const b = await onboard({ trigger: 'sub-type' });
  assert.equal(b.sent, false); assert.equal(b.reason, 'not-started');
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), [], 'the webhook wrote nothing');
  assert.deepEqual(store.composition.members, [], 'the board is still empty for the chain');

  // The chain's createFromLead, for real, over the same (stubbed) board.
  const fam = require('../src/services/familyCompositionService');
  const compositionAdapter = require('../src/services/compositionAdapter');
  const mondayApi = require('../src/services/mondayApi');
  const realRead = compositionAdapter.readForCase, realQuery = mondayApi.query;
  const mutations = [];
  compositionAdapter.readForCase = async () => ({ caseFlags: {}, members: store.composition.members.map((m) => ({ ...m })) });
  mondayApi.query = async (q, vars) => {
    mutations.push(q.includes('create_item') ? `create_item:${vars.n}` : q.includes('create_update') ? 'create_update' : 'other');
    if (q.includes('create_item')) { store.composition.members.push({ role: vars.n.startsWith('Spouse') ? 'Spouse' : 'DependentChild', name: vars.n, flags: {} }); return { create_item: { id: '5' } }; }
    return { create_update: { id: '6' } };
  };
  try {
    const created = await fam.createFromLead({ lead: { hasSpouse: 'Yes', childrenCount: '2' }, caseRef: '2026-SOWP-017', cmItemId: '4001' });
    assert.equal(created, 3);
    assert.deepEqual(mutations, ['create_item:Spouse (from intake)', 'create_item:Child 1 (from intake)', 'create_item:Child 2 (from intake)', 'create_update'], 'three rows, then the staff note (the note used to throw a ReferenceError after the extraction)');
  } finally { compositionAdapter.readForCase = realRead; mondayApi.query = realQuery; }

  // The chain's 'prepare' pass then recognises the intake's Spouse row as the sponsor (D5) — no second person.
  const p = await S.ensureSponsor({ itemId: '4001', caseRef: '2026-SOWP-017', mode: 'prepare', trigger: 'case-ref' });
  assert.deepEqual(p.created, { row: false, member: false });
  assert.equal(p.sectionLabel, 'Spouse');
  assert.equal(store.composition.members.length, 3);
}, { cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) }));

test('the payment counted as landed today: a lead whose Retainer Paid is blank but whose case reads Paid passes the signature gate', () => withFakeIo(async () => {
  const r = await onboard();
  assert.equal(r.sent, true);
}, { claimants: [LEAD({ retainerPaid: '' })] }));

test("'prepare': the row (and section) only; never a send, whatever the gates; a note tells staff", () => withFakeIo(async ({ names, calls }) => {
  const r = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'prepare');
  assert.deepEqual(r.created, { row: true, member: false });
  assert.ok(!names().includes('sendEmail') && !names().includes('writeMarker') && !names().includes('readManifest') === false);
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /Sponsor Faheem Khan added to the case by the system — questionnaire section "Faheem Khan" created\. The portal email goes out automatically when Document Collection starts\./);
}, { cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) }));

test("'prepare' on a case paid BEFORE its type was set (already at Document Collection): the note does not promise a future start — the resume sends seconds later", () => withFakeIo(async ({ calls, store }) => {
  const p = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
  assert.deepEqual(p.created, { row: true, member: false });
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /questionnaire section "Faheem Khan" created\. The portal email follows automatically\./);
  assert.doesNotMatch(note, /when Document Collection starts/);
  const r = await onboard({ trigger: 'resume' });
  assert.equal(r.sent, true); assert.deepEqual(r.created, { row: false, member: false });
  assert.equal(store.composition.members.length, 1, 'one row, one person');
}));

test("'prepare' on a case whose Sub Type is still blank: sub-type-missing, nothing written", () => withFakeIo(async ({ names }) => {
  const r = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
  assert.equal(r.reason, 'sub-type-missing');
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), []);
}, { cm: CM({ caseSubType: '' }) }));

test('nothing to create and gates closed → no note (nothing happened)', () => withFakeIo(async ({ names }) => {
  const r = await onboard();
  assert.equal(r.sent, false); assert.equal(r.reason, 'not-started');
  assert.deepEqual(r.created, { row: false, member: false });
  assert.ok(!names().includes('postNote'));
}, { cm: CM({ paymentStatus: 'Not Paid' }), members: [{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }] }));

// ─── Staff ────────────────────────────────────────────────────────────────────

test("'staff' with the marker sent: one more send, sends.length 2, variant resend, note says re-sent by Gauri", () => withFakeIo(async ({ store, calls }) => {
  await onboard();
  const r = await staff();
  assert.equal(r.sent, true); assert.equal(r.variant, 'resend');
  assert.equal(store.marker.sendCount, 2);
  assert.equal(store.marker.sends.length, 2);
  assert.deepEqual(store.marker.sends.map((x) => x.by), ['auto:dcs', 'Gauri']);
  assert.deepEqual(store.marker.sends.map((x) => x.variant), ['onboarding', 'resend']);
  const emails = calls.filter((c) => c[0] === 'sendEmail');
  assert.match(emails[1][2], /^Your portal link for Aisha Khan's application — 2026-SOWP-017$/);
  const notes = calls.filter((c) => c[0] === 'postNote');
  assert.match(notes[1][2], /Sponsor portal email re-sent by Gauri to f\*\*\*@example\.com \(Worker Spouse\)/);
  assert.ok(!/Questionnaire section .* created/.test(notes[1][2]), 'nothing was created on the resend');
  assert.doesNotMatch(leaks({ store, calls, r }), LEAK, 'two sends: still no raw address or token in the marker, the notes or the result');
}));

test('a RESEND that failed: the next staff send is still a resend (the sponsor holds the link), noted as re-sent; the earlier delivery stays on the card', () => withFakeIo(async ({ store, calls }) => {
  await onboard();
  const deliver = S.io.sendEmail;
  S.io.sendEmail = async () => { throw new Error('Graph 503'); };
  await assert.rejects(staff(), /Graph 503/);
  S.io.sendEmail = deliver;
  assert.equal(store.marker.status, 'failed'); assert.equal(store.marker.sendCount, 1);
  const card = S.describeFromInputs({ claimants: [LEAD()], marker: store.marker, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Submitted', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() });
  assert.equal(card.lastError, 'Graph 503'); assert.equal(card.sentCount, 1);
  assert.equal(card.emailedAt, store.marker.sends[0].at, 'the delivery that DID happen is still shown');
  assert.equal(card.canSend, true, 'a resend is allowed at any stage');
  const r = await staff();
  assert.equal(r.sent, true); assert.equal(r.variant, 'resend');
  const emails = calls.filter((c) => c[0] === 'sendEmail');
  assert.match(emails[emails.length - 1][2], /^Your portal link for Aisha Khan's application — 2026-SOWP-017$/, 'not the "has retained TDOT" onboarding wording again');
  assert.match(calls.filter((c) => c[0] === 'postNote').pop()[2], /re-sent by Gauri/);
  assert.deepEqual(store.marker.sends.map((x) => x.variant), ['onboarding', 'resend']);
}));

test("'staff' resends at ANY stage once the marker is sent; a first staff send still needs Paid + Document Collection", () => withFakeIo(async ({ store }) => {
  const first = await staff();
  assert.equal(first.sent, false); assert.equal(first.reason, 'not-started');
  assert.deepEqual(first.created, { row: true, member: false });
  store.marker = { version: 1, status: 'sent', sentAt: '2026-09-20T10:00:00Z', startedAt: '2026-09-20T09:59:59Z', sendCount: 1, sends: [{ variant: 'onboarding', at: '2026-09-20T10:00:00Z', to: 'f***@example.com', by: 'auto:dcs' }] };
  const again = await staff();
  assert.equal(again.sent, true); assert.equal(again.variant, 'resend');
}, { cm: CM({ caseStage: 'Submitted', paymentStatus: 'Paid' }) }));

test("'staff' with no manifest file: loadMembers seeds it from the now-updated board (after the file read said absent); no double add", () => withFakeIo(async ({ names, store }) => {
  const r = await staff();
  assert.equal(r.sent, true);
  assert.ok(names().includes('loadMembers') && names().includes('readManifest'));
  assert.ok(names().indexOf('readManifest') > names().indexOf('createFamilyRow'), 'the file is read AFTER the row exists');
  assert.ok(names().indexOf('loadMembers') > names().indexOf('readManifest'), 'the seed runs only once the file read said absent');
  assert.ok(!names().includes('addMember'), 'the seed already carries the sponsor row → no second add');
  assert.deepEqual(store.manifest.map((m) => [m.type, m.label]), [['Principal Applicant', 'Primary Applicant'], ['Sponsor', 'Faheem Khan']]);
  assert.equal(r.sectionLabel, 'Faheem Khan');
}));

test("'staff' with the manifest file on file: no seed (loadMembers is never called) — the file's members get the section", () => withFakeIo(async ({ names, store }) => {
  const r = await staff();
  assert.equal(r.sent, true);
  assert.ok(names().includes('readManifest') && !names().includes('loadMembers'));
  assert.deepEqual(store.manifest.map((m) => m.type), ['Principal Applicant', 'Dependent Child', 'Sponsor'], 'the child section is still there');
}, { manifest: [...PRIMARY(), { key: 'child-1', type: 'Dependent Child', label: 'Child 1' }] }));

test("'staff' send while the board read INSIDE the seed fails: transient (row created, nothing sent) — a primary-only seed is never frozen as the manifest", () => withFakeIo(async ({ names, store }) => {
  const r = await staff();
  assert.equal(r.done, false); assert.equal(r.reason, 'transient');
  assert.deepEqual(r.created, { row: true, member: false }, 'the row that WAS created is reported');
  assert.ok(!names().includes('addMember') && !names().includes('sendEmail') && !names().includes('writeMarker'));
  assert.equal(store.manifest, null, 'no manifest was saved without the family');
  assert.equal(store.composition.members.length, 2, 'the child row and the sponsor row');
}, { members: [{ role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} }], seedFails: true }));

test("'staff' with a frozen primary-only manifest: the section is added with the sponsor's name", () => withFakeIo(async ({ calls, store }) => {
  const r = await staff();
  assert.equal(r.sent, true);
  assert.deepEqual(r.created, { row: true, member: true });
  assert.deepEqual(calls.find((c) => c[0] === 'addMember')[1], { memberType: 'Sponsor', label: 'Faheem Khan' });
  assert.equal(store.manifest.length, 2);
}, { manifest: PRIMARY() }));

test("a fresh 'pending' marker (another instance is sending): staff and automatic both stand down", () => withFakeIo(async ({ names }) => {
  const a = await onboard();
  assert.equal(a.sent, false); assert.equal(a.reason, 'in-progress');
  const b = await staff();
  assert.equal(b.sent, false); assert.equal(b.reason, 'in-progress');
  assert.ok(!names().includes('sendEmail'));
}, { marker: { version: 1, status: 'pending', startedAt: new Date(Date.parse('2026-09-24T15:00:00Z') - 2 * 60 * 1000).toISOString(), sendCount: 0, sends: [] }, members: [{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }] }));

test('override (staff typed the inviter): updateLead is called WITHOUT clearKeys, before the send, and the typed person is emailed; a note records it', () => withFakeIo(async ({ calls, names, store }) => {
  const r = await staff({ override: { name: '⁠Rahim Ali ', email: ' rahim@example.com⁠' } });
  assert.equal(r.sent, true); assert.equal(r.to, 'r***@example.com');
  const up = calls.find((c) => c[0] === 'updateLead');
  assert.deepEqual(up.slice(1), ['9001', { inviterName: 'Rahim Ali', inviterEmail: 'rahim@example.com' }], 'exactly two arguments — no clearKeys, no option bag');
  assert.equal(up.length, 3);
  assert.ok(names().indexOf('updateLead') < names().indexOf('sendEmail'));
  assert.equal(calls.find((c) => c[0] === 'sendEmail')[1], 'rahim@example.com');
  assert.equal(calls.find((c) => c[0] === 'createFamilyRow')[1].name, 'Rahim Ali');
  assert.match(calls.find((c) => c[0] === 'postNote')[2], /Sponsor \/ inviter Rahim Ali \(r\*\*\*@example\.com\) entered from the case page by Gauri — saved to the client record\./);
  assert.equal(store.claimants[0].inviterEmail, 'rahim@example.com');
  assert.equal(r.inviterSaved, true);
  assert.doesNotMatch(leaks({ store, calls, r }), LEAK);
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })] }));

test('override with a bad address is refused before any write; override on a shared case is ignored (shared-case)', () => withFakeIo(async ({ names }) => {
  const bad = await staff({ override: { name: 'Rahim', email: 'rahim[at]x' } });
  assert.equal(bad.reason, 'no-inviter');
  S.io.findClaimants = async () => [LEAD(), LEAD({ id: '9002' })];
  const shared = await staff({ override: { name: 'Rahim', email: 'rahim@example.com' } });
  assert.equal(shared.reason, 'shared-case');
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), []);
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })] }));

test('override before payment (Save sponsor): the lead is written, the section created, nothing emailed — inviterSaved tells the card what happened', () => withFakeIo(async ({ names, store }) => {
  const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'not-started'); assert.equal(r.inviterSaved, true);
  assert.deepEqual(r.created, { row: true, member: false });
  assert.ok(names().includes('updateLead') && !names().includes('sendEmail') && !names().includes('writeMarker'));
  assert.equal(store.claimants[0].inviterName, 'Rahim Ali');
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })], cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) }));

test('override: every read comes BEFORE the lead write — a board or marker outage is "transient, nothing was changed" and the lead really is unchanged', async () => {
  for (const hooks of [{ compositionThrows: true }, { markerThrows: true }]) {
    await withFakeIo(async ({ names, store }) => {
      const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
      assert.equal(r.done, false); assert.equal(r.reason, 'transient');
      assert.deepEqual(names().filter((n) => WRITES.includes(n)), [], `${JSON.stringify(hooks)}: no updateLead, no note`);
      assert.equal(store.claimants[0].inviterEmail, '', 'the lead still has no inviter');
      assert.ok(names().indexOf('readComposition') !== -1, 'the board was read');
    }, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })], ...hooks });
  }
});

test('override on a lead that ALREADY has a valid inviter is refused (inviter-exists) — no lead write, no send to a new address as a "resend"', () => withFakeIo(async ({ names, store }) => {
  await onboard();
  const before = names().length;
  const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
  assert.equal(r.done, false); assert.equal(r.reason, 'inviter-exists');
  assert.deepEqual(r.current, { name: 'Faheem Khan', emailMasked: 'f***@example.com' });
  assert.deepEqual(names().slice(before).filter((n) => WRITES.includes(n)), []);
  assert.equal(store.claimants[0].inviterEmail, 'faheem@example.com');
  assert.deepEqual(store.marker.sponsor, { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') });
}));

test('override on a case type with no sponsor role, or with the Sub Type blank: refused BEFORE the lead is written — no updateLead, no note', async () => {
  for (const [cm, reason] of [
    [CM({ caseType: 'Canadian Experience Class (EE after ITA)', caseSubType: 'CEC Single Applicant' }), 'not-applicable'],
    [CM({ caseSubType: '' }), 'sub-type-missing'],
    [CM({ caseSubType: 'Nope' }), 'no-schema'],
  ]) {
    await withFakeIo(async ({ names, store }) => {
      const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
      assert.equal(r.done, false); assert.equal(r.reason, reason);
      assert.deepEqual(names().filter((n) => WRITES.includes(n)), [], `${reason}: nothing written`);
      assert.equal(store.claimants[0].inviterName, '');
    }, { cm, claimants: [LEAD({ inviterName: '', inviterEmail: '' })] });
  }
});

// ─── Placements ───────────────────────────────────────────────────────────────

test('SOWP inland: a Spouse row with the spouse key, and a Spouse / Common-Law Partner section', () => withFakeIo(async ({ calls }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.deepEqual(calls.find((c) => c[0] === 'createFamilyRow')[1], { memberType: 'Spouse', memberKey: 'spouse', name: 'Faheem Khan', caseRef: '2026-SOWP-017', cmItemId: '4001' });
  assert.deepEqual(calls.find((c) => c[0] === 'addMember')[1], { memberType: 'Spouse / Common-Law Partner', label: 'Faheem Khan' });
  assert.match(calls.find((c) => c[0] === 'sendEmail')[2], /SOWP application/);
}, { cm: CM({ caseSubType: 'Inland - Established Relationship' }), manifest: PRIMARY() }));

test('SOWP inland with the intake Spouse row already there: no row, the section keeps its label "Spouse"', () => withFakeIo(async ({ names, calls }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.ok(!names().includes('createFamilyRow') && !names().includes('addMember'));
  assert.equal(r.sectionLabel, 'Spouse');
  assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Spouse<\/strong>" \(marked "Spouse"\)/);
}, { cm: CM({ caseSubType: 'Inland - Established Relationship' }), members: [{ role: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse', flags: {} }], manifest: [...PRIMARY(), { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }] }));

test('SOWP Outland with the intake Spouse row (D5): the email names the badge that section really carries — "Spouse", not the schema role "Sponsor"', async () => {
  const members = [{ role: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse', flags: {} }];
  for (const manifest of [null, [...PRIMARY(), { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }]]) {
    await withFakeIo(async ({ names, calls }) => {
      const r = await onboard();
      assert.equal(r.sent, true); assert.deepEqual(r.created, { row: false, member: false }); assert.equal(r.sectionLabel, 'Spouse');
      assert.ok(!names().includes('createFamilyRow') && !names().includes('addMember'));
      const html = calls.find((c) => c[0] === 'sendEmail')[3];
      assert.match(html, /section headed "<strong>Spouse<\/strong>" \(marked "Spouse"\)/, `manifest ${manifest ? 'seeded' : 'absent'}`);
      assert.doesNotMatch(html, /marked "Sponsor"/);
    }, { members, manifest });
  }
  // A named Spouse row / a legacy Worker Spouse member likewise.
  await withFakeIo(async ({ calls }) => {
    await onboard();
    assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Priya Sharma<\/strong>" \(marked "Spouse"\)/);
  }, { members: [{ role: 'Spouse', name: 'Priya Sharma', memberKey: 'spouse', flags: {} }] });
  await withFakeIo(async ({ calls }) => {
    await onboard();
    assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Faheem<\/strong>" \(marked "Worker Spouse"\)/);
  }, { members: [{ role: 'WorkerSpouse', name: 'Faheem', memberKey: 'worker-spouse', flags: {} }], manifest: [...PRIMARY(), { key: 'worker-spouse', type: 'Worker Spouse', label: 'Faheem' }] });
  // And with no partner at all the sponsor's own section is marked "Sponsor".
  await withFakeIo(async ({ calls }) => {
    await onboard();
    assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Faheem Khan<\/strong>" \(marked "Sponsor"\)/);
  }, { manifest: PRIMARY() });
});

test('Sub Type corrected Outland → Inland: the Sponsor row from the first pass IS the same person — no second row, no second section', () => withFakeIo(async ({ names, store, calls }) => {
  const r = await onboard();
  assert.equal(r.sent, true); assert.deepEqual(r.created, { row: false, member: false });
  assert.ok(!names().includes('createFamilyRow') && !names().includes('addMember'));
  assert.equal(r.sectionLabel, 'Faheem Khan');
  assert.equal(store.composition.members.length, 1);
  assert.deepEqual(store.manifest.map((m) => m.type), ['Principal Applicant', 'Sponsor']);
  assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Faheem Khan<\/strong>" \(marked "Sponsor"\)/);
}, { cm: CM({ caseSubType: 'Inland - Established Relationship' }), members: [{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }], manifest: [...PRIMARY(), { key: 'sponsor', type: 'Sponsor', label: 'Faheem Khan' }] }));

test('F10 (Inland Spousal Sponsorship): the email only — no row, no member, shared-form wording', () => withFakeIo(async ({ names, calls }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.deepEqual(r.created, { row: false, member: false });
  assert.ok(!names().includes('createFamilyRow') && !names().includes('addMember'));
  assert.match(calls.find((c) => c[0] === 'sendEmail')[2], /Inland Spousal Sponsorship/);
}, { cm: CM({ caseType: 'Inland Spousal Sponsorship', caseSubType: 'Marriage' }), manifest: PRIMARY() }));

test('Supervisa (documents-only): the email only — even with a manifest on file and a Spouse row on the board', () => withFakeIo(async ({ names }) => {
  const r = await onboard();
  assert.equal(r.sent, true);
  assert.deepEqual(r.created, { row: false, member: false });
  assert.ok(!names().includes('createFamilyRow') && !names().includes('addMember'));
}, { cm: CM({ caseType: 'Supervisa', caseSubType: 'Parents' }), members: [{ role: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse', flags: {} }], manifest: PRIMARY() }));

test('same address as the client: the automatic path skips; the staff button sends', () => withFakeIo(async ({ names }) => {
  const a = await onboard();
  assert.equal(a.done, false); assert.equal(a.reason, 'same-as-client');
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), []);
  const s = await staff();
  assert.equal(s.sent, true);
}, { claimants: [LEAD({ inviterEmail: 'Aisha@Example.com' })] }));

test('a case type with no sponsor (CEC) is not-applicable — no reads past the leads, nothing written', () => withFakeIo(async ({ names }) => {
  const r = await onboard();
  assert.equal(r.done, false); assert.equal(r.reason, 'not-applicable');
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), []);
}, { cm: CM({ caseType: 'Canadian Experience Class (EE after ITA)', caseSubType: 'CEC Single Applicant' }) }));

test('an unknown mode is refused', () => withFakeIo(async ({ names }) => {
  const r = await S.ensureSponsor({ itemId: '4001', mode: 'send-now' });
  assert.equal(r.reason, 'bad-mode');
  assert.deepEqual(names(), []);
}));

// ─── Forbidden seams ──────────────────────────────────────────────────────────

test('it never calls the client\'s intake email or the checklist seeder', () => {
  const trap = (name) => async () => { throw new Error(`FORBIDDEN: ${name} was called`); };
  const targets = [
    [require('../src/services/emailService'), ['sendIntakeEmail', 'onClientEmailChanged']],
    [require('../src/services/checklistService'), ['onDocumentCollectionStarted', 'reseedByCaseRef', 'resumeSeedingAfterSubType']],
  ];
  const restore = [];
  for (const [mod, keys] of targets) for (const k of keys) { const orig = mod[k]; mod[k] = trap(k); restore.push(() => { mod[k] = orig; }); }
  return withFakeIo(async () => {
    const r = await onboard();
    assert.equal(r.sent, true, JSON.stringify(r));
    const s = await staff();
    assert.equal(s.sent, true, JSON.stringify(s));
  }, { manifest: PRIMARY() }).finally(() => restore.forEach((r) => r()));
});

test('the mail service is held as a module reference (a test stub of sendEmail takes effect)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/sponsorOnboardingService'), 'utf8');
  assert.ok(src.includes("require('./microsoftMailService')"));
  assert.ok(!/const \{\s*sendEmail\s*\}/.test(src));
  assert.ok(!/findByColumnValue\(/.test(src), 'never the first-hit lead lookup');
  assert.ok(!/clearKeys/.test(src));
});

// ─── describe (the cockpit view) ──────────────────────────────────────────────

test('describeFromInputs: the shapes the cockpit renders', () => {
  const base = { caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', clientEmail: 'aisha@example.com', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY(), now: Date.parse('2026-09-24T15:00:00Z') };
  const shared = S.describeFromInputs({ ...base, claimants: [LEAD(), LEAD({ id: '9002' })] });
  assert.equal(shared.available, true); assert.equal(shared.status, 'none'); assert.equal(shared.reason, 'shared-case'); assert.equal(shared.canSend, false); assert.equal(shared.sendBlockedReason, 'shared-case'); assert.equal(shared.claimantCount, 2);

  const sent = S.describeFromInputs({ ...base, claimants: [LEAD()], marker: { status: 'sent', sentAt: '2026-09-12T18:03:00Z', sendCount: 2 } });
  assert.equal(sent.status, 'ok'); assert.equal(sent.reason, null); assert.equal(sent.emailedAt, '2026-09-12T18:03:00Z'); assert.equal(sent.sentCount, 2);
  assert.equal(sent.canSend, true); assert.equal(sent.sectionLabel, 'Faheem Khan'); assert.equal(sent.sectionExists, false); assert.equal(sent.rowExists, false);
  assert.equal(sent.docCount, 5); assert.equal(sent.roleLabel, 'Worker Spouse'); assert.equal(sent.sectionMode, 'section');
  assert.ok(!sent.emailMasked.includes('faheem'), 'never the local part');

  const early = S.describeFromInputs({ ...base, claimants: [LEAD()], caseStage: 'Retainer Signed' });
  assert.equal(early.canSend, false); assert.equal(early.sendBlockedReason, 'not-started'); assert.equal(early.emailedAt, null);

  const unavailable = S.describeFromInputs({ ...base, claimants: [LEAD()], markerUnavailable: true });
  assert.equal(unavailable.markerUnavailable, true); assert.equal(unavailable.canSend, false); assert.equal(unavailable.sendBlockedReason, 'marker-unavailable');

  const cec = S.describeFromInputs({ ...base, caseType: 'Canadian Experience Class (EE after ITA)', caseSubType: 'CEC Single Applicant', claimants: [LEAD()] });
  assert.equal(cec.status, 'none'); assert.equal(cec.reason, 'not-applicable');

  const same = S.describeFromInputs({ ...base, claimants: [LEAD({ inviterEmail: 'aisha@example.com' })] });
  assert.equal(same.status, 'ok'); assert.equal(same.reason, 'same-as-client'); assert.equal(same.canSend, true); assert.equal(same.name, 'Faheem Khan');

  const cmDown = S.describeFromInputs({ ...base, cmUnavailable: true, claimants: [LEAD({ inviterEmail: 'aisha@example.com' })] });
  assert.equal(cmDown.reason, null, 'the same-as-client check is skipped when the client email is unknown');

  const withSection = S.describeFromInputs({ ...base, claimants: [LEAD()], composition: { members: [{ role: 'Sponsor', name: 'Faheem Khan' }] }, qMembers: [...PRIMARY(), { key: 'sponsor', type: 'Sponsor', label: 'Faheem Khan' }] });
  assert.equal(withSection.sectionExists, true); assert.equal(withSection.rowExists, true);

  const failed = S.describeFromInputs({ ...base, claimants: [LEAD()], marker: { status: 'failed', error: 'Graph 503', sendCount: 0 } });
  assert.equal(failed.lastError, 'Graph 503'); assert.equal(failed.canSend, true);

  const pending = S.describeFromInputs({ ...base, claimants: [LEAD()], marker: { status: 'pending', startedAt: '2026-09-24T14:58:00Z' } });
  assert.equal(pending.canSend, false); assert.equal(pending.sendBlockedReason, 'in-progress');

  const noInviter = S.describeFromInputs({ ...base, claimants: [LEAD({ inviterEmail: '' })] });
  assert.equal(noInviter.reason, 'no-inviter'); assert.equal(noInviter.claimantCount, 1); assert.equal(noInviter.sendBlockedReason, null, 'at Document Collection a typed sponsor is emailed');
  const noInviterEarly = S.describeFromInputs({ ...base, claimants: [LEAD({ inviterEmail: '' })], caseStage: 'Retainer Signed' });
  assert.equal(noInviterEarly.reason, 'no-inviter'); assert.equal(noInviterEarly.sendBlockedReason, 'not-started', 'before payment a typed sponsor is saved, not emailed — the card says so');

  const sameEarly = S.describeFromInputs({ ...base, claimants: [LEAD({ inviterEmail: 'aisha@example.com' })], paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' });
  assert.equal(sameEarly.reason, 'same-as-client'); assert.equal(sameEarly.canSend, false); assert.equal(sameEarly.sendBlockedReason, 'not-started');

  const failedResend = S.describeFromInputs({ ...base, claimants: [LEAD()], caseStage: 'Submitted', marker: { status: 'failed', error: 'Graph 503', sendCount: 1, sends: [{ variant: 'onboarding', at: '2026-09-12T18:03:00Z', to: 'f***@example.com', by: 'auto:dcs' }] } });
  assert.equal(failedResend.emailedAt, '2026-09-12T18:03:00Z'); assert.equal(failedResend.lastError, 'Graph 503'); assert.equal(failedResend.canSend, true);

  // The switch: the card must know whether the automatic email exists at all.
  const prev = process.env.SPONSOR_ONBOARDING;
  try {
    delete process.env.SPONSOR_ONBOARDING;
    assert.equal(S.describeFromInputs({ ...base, claimants: [LEAD()] }).autoEnabled, false);
    process.env.SPONSOR_ONBOARDING = 'true';
    assert.equal(S.describeFromInputs({ ...base, claimants: [LEAD()] }).autoEnabled, true);
    assert.equal(S.describeFromInputs({ ...base, claimants: [LEAD({ inviterEmail: '' })] }).autoEnabled, true, 'reported in every state');
  } finally { if (prev === undefined) delete process.env.SPONSOR_ONBOARDING; else process.env.SPONSOR_ONBOARDING = prev; }
});

test('describe: a case type with no sponsor role is answered from the schema alone — no lead lookup, no marker read', () => withFakeIo(async ({ names }) => {
  const args = { itemId: '4001', caseRef: '2026-CEC-EE-001', clientName: 'Aisha Khan', clientEmail: 'aisha@example.com', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() };
  for (const [caseType, caseSubType, reason] of [
    ['Canadian Experience Class (EE after ITA)', 'CEC Single Applicant', 'not-applicable'],
    ['SOWP', '', 'sub-type-missing'],
    ['SOWP', 'Nope', 'no-schema'],
  ]) {
    const r = await S.describe({ ...args, caseType, caseSubType });
    assert.equal(r.available, true); assert.equal(r.status, 'none'); assert.equal(r.reason, reason);
  }
  assert.deepEqual(names(), [], 'not a single read');
  const ok = await S.describe({ ...args, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)' });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(names(), ['findClaimants', 'readMarker'], 'a case with a sponsor role still reads both');
}));

// ─── The default io wiring (the seam every other test replaces) ──────────────
// A wrong lead-column key or Client Master column id makes the feature silently
// dead — every case 'no-lead', or paymentStatus '' so the gates never open —
// with the seam-based tests still green. So drive the REAL io over a stubbed
// Monday query and pin what it asks for.

test('io.findClaimants asks Monday for EVERY lead whose Client Master link is the item (the lead board\'s clientMasterItemId text column, limit 50), and a Monday failure propagates (fail closed)', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const COLS = require('../src/data/newLeadsBoard.json').columns;
  const real = mondayApi.query;
  const seen = [];
  mondayApi.query = async (q, vars) => {
    seen.push({ q, vars });
    return { items_page_by_column_values: { items: [
      { id: '9001', name: 'Aisha Khan', created_at: '2026-08-01T00:00:00Z', column_values: [{ id: COLS.inviterName, text: 'Faheem Khan', value: '"Faheem Khan"' }, { id: COLS.inviterEmail, text: 'faheem@example.com', value: '"faheem@example.com"' }] },
      { id: '9002', name: 'Aisha Khan (dup)', created_at: '2026-08-02T00:00:00Z', column_values: [] },
    ] } };
  };
  try {
    const leads = await S.io.findClaimants('4001');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].vars.colId, COLS.clientMasterItemId, 'the lead board\'s Client Master link column');
    assert.equal(seen[0].vars.colId, 'text_mm44k4ha');
    assert.equal(seen[0].vars.val, '4001');
    assert.equal(seen[0].vars.limit, 50, 'a page, not the first hit — duplicates must surface as shared-case');
    assert.match(seen[0].q, /items_page_by_column_values\(limit: \$limit/);
    assert.deepEqual(leads.map((l) => l.id), ['9001', '9002'], 'ALL matches come back (shared-case detection)');
    assert.equal(leads[0].inviterName, 'Faheem Khan'); assert.equal(leads[0].inviterEmail, 'faheem@example.com');
    mondayApi.query = async () => { throw new Error('monday down'); };
    await assert.rejects(S.io.findClaimants('4001'), /monday down/, 'an outage throws — it is never an empty list');
  } finally { mondayApi.query = real; }
});

test('readCase asks Monday for exactly the eight Client Master columns the gates and the email need, and parses them by id', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const real = mondayApi.query;
  const IDS = ['text_mm142s49', 'dropdown_mm0xd1qn', 'dropdown_mm0x4t91', 'text_mm0xw6bp', 'text_mm0x6haq', 'color_mm0x8faa', 'color_mm0x9fnn', 'color_mm0xs7kp'];
  const seen = [];
  mondayApi.query = async (q, vars) => {
    seen.push({ q, vars });
    return { items: [{ id: '4001', name: ' Aisha Khan ', state: 'active', column_values: [
      { id: 'text_mm142s49', text: '2026-SOWP-017' }, { id: 'dropdown_mm0xd1qn', text: 'SOWP' }, { id: 'dropdown_mm0x4t91', text: 'Outland (Spouse or Child)' },
      { id: 'text_mm0xw6bp', text: 'aisha@example.com' }, { id: 'text_mm0x6haq', text: 'TDOT-abc' }, { id: 'color_mm0x8faa', text: 'Document Collection Started' },
      { id: 'color_mm0x9fnn', text: 'Paid' }, { id: 'color_mm0xs7kp', text: 'No' },
    ] }] };
  };
  try {
    const cm = await S.readCase({ itemId: '4001' });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].vars, { ids: ['4001'] });
    const requested = JSON.parse(/column_values\(ids:(\[[^\]]*\])\)/.exec(seen[0].q)[1]);
    assert.deepEqual([...requested].sort(), [...IDS].sort(), 'every column the service reads is requested — none silently blank');
    assert.deepEqual(cm, {
      itemId: '4001', clientName: 'Aisha Khan', caseRef: '2026-SOWP-017', caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)',
      clientEmail: 'aisha@example.com', accessToken: 'TDOT-abc', caseStage: 'Document Collection Started', paymentStatus: 'Paid', checklistTemplateApplied: 'No',
    });
    mondayApi.query = async () => ({ items: [{ id: '4001', name: 'Gone', state: 'deleted', column_values: [] }] });
    assert.equal(await S.readCase({ itemId: '4001' }), null, 'a deleted item reads as no case');
  } finally { mondayApi.query = real; }
});

test('describe: reads claimants + marker; a marker outage degrades to markerUnavailable, a lead outage to available:false', () => withFakeIo(async () => {
  const args = { itemId: '4001', caseRef: '2026-SOWP-017', clientName: 'Aisha Khan', caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', clientEmail: 'aisha@example.com', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() };
  const ok = await S.describe(args);
  assert.equal(ok.status, 'ok'); assert.equal(ok.markerUnavailable, false); assert.equal(ok.canSend, true);
  S.io.readMarker = async () => { throw new Error('graph down'); };
  const deg = await S.describe(args);
  assert.equal(deg.status, 'ok'); assert.equal(deg.markerUnavailable, true); assert.equal(deg.canSend, false);
  S.io.findClaimants = async () => { throw new Error('monday down'); };
  assert.deepEqual(await S.describe(args), { available: false });
}));

// ─── Round 2: what the first review found ─────────────────────────────────────

// (1) A Sub Type webhook landing mid case-ref chain on a case PAID before its
// type was set: the gates hold, so the automatic path would send — and create
// the Sponsor row on a board the chain has not written the intake rows to yet.
// createFromLead then reads "1 member, already curated" and the children are
// never created. The intake's rows are asked for first, and the intake's
// Spouse row IS this person (D5), so no second row.
const INTAKE_ROWS = [
  { role: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse', flags: {} },
  { role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} },
  { role: 'DependentChild', name: 'Child 2 (from intake)', memberKey: 'child-2', flags: {} },
];

test('paid-before-type + Sub Type webhook before the chain wrote the intake rows: the intake rows are created FIRST, the sponsor is recognised as the intake Spouse, and the email names that section', () => withFakeIo(async ({ names, calls, store }) => {
  const r = await onboard({ trigger: 'sub-type' });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.deepEqual(r.created, { row: false, member: false }, 'the Spouse row from the intake is the sponsor — no row of their own');
  assert.equal(r.sectionLabel, 'Spouse');
  const n = names();
  assert.ok(n.includes('createIntakeRows') && !n.includes('createFamilyRow'));
  assert.equal(n.filter((x) => x === 'readComposition').length, 2, 'the board is read again after the intake rows landed');
  assert.ok(n.indexOf('createIntakeRows') < n.lastIndexOf('readComposition') && n.lastIndexOf('readComposition') < n.indexOf('writeMarker'));
  assert.deepEqual(store.composition.members.map((m) => m.name), ['Spouse (from intake)', 'Child 1 (from intake)', 'Child 2 (from intake)']);
  assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Spouse<\/strong>" \(marked "Spouse"\)/);
}, { intakeRows: INTAKE_ROWS }));

test('paid-before-type, a lead with NO spouse (children only): the intake rows land, then the sponsor row is added — the children are never lost', () => withFakeIo(async ({ names, store }) => {
  const r = await onboard({ trigger: 'sub-type' });
  assert.equal(r.sent, true);
  assert.deepEqual(r.created, { row: true, member: false });
  const n = names();
  assert.ok(n.indexOf('createIntakeRows') < n.indexOf('createFamilyRow'), 'the intake rows come BEFORE the sponsor row');
  assert.deepEqual(store.composition.members.map((m) => m.role), ['DependentChild', 'DependentChild', 'Sponsor']);
}, { intakeRows: INTAKE_ROWS.slice(1) }));

test('the intake rows are asked for only when the board is EMPTY and a row is planned; a failure there is transient (nothing sent)', () => withFakeIo(async ({ names }) => {
  const withRow = await onboard();
  assert.equal(withRow.sent, true);
  assert.ok(!names().includes('createIntakeRows'), 'a board with a row on it is the chain\'s finished work');
  await withFakeIo(async ({ names: n2 }) => {
    const r = await onboard();
    assert.equal(r.reason, 'transient');
    assert.ok(!n2().includes('createFamilyRow') && !n2().includes('sendEmail'));
  }, { intakeRowsThrow: true });
  await withFakeIo(async ({ names: n3 }) => {
    const r = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
    assert.deepEqual(r.created, { row: true, member: false });
    assert.ok(!n3().includes('createIntakeRows'), "'prepare' runs after the chain's own family rows — it never asks");
    const st = await staff();
    assert.ok(!n3().includes('createIntakeRows'), 'nor does the staff button');
    assert.equal(st.sent, true);
  });
}, { members: [{ role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} }] }));

test('io.createIntakeRows is the real createFamilyRowsForItem: idempotent on a board with rows, and two concurrent callers (chain + webhook) share ONE run — no duplicate intake rows', async () => {
  const fam = require('../src/services/familyCompositionService');
  const compositionAdapter = require('../src/services/compositionAdapter');
  const mondayApi = require('../src/services/mondayApi');
  const leadService = require('../src/services/leadService');
  const realRead = compositionAdapter.readForCase, realQuery = mondayApi.query, realFind = leadService.findByColumnValue;
  const board = [];
  let reads = 0, creates = 0;
  compositionAdapter.readForCase = async () => { reads++; await new Promise((r) => setTimeout(r, 5)); return { caseFlags: {}, members: board.map((m) => ({ ...m })) }; };
  mondayApi.query = async (q, vars) => {
    if (q.includes('create_item')) { creates++; board.push({ role: vars.n.startsWith('Spouse') ? 'Spouse' : 'DependentChild', name: vars.n, flags: {} }); return { create_item: { id: '5' } }; }
    return { create_update: { id: '6' } };
  };
  leadService.findByColumnValue = async () => ({ id: '9001', hasSpouse: 'Yes', childrenCount: '2' });
  fam._createdRecently.clear();   // an earlier test created rows for this case ref in this process
  try {
    const [a, b] = await Promise.all([
      S.io.createIntakeRows({ itemId: '4001', caseRef: '2026-SOWP-017' }),
      fam.createFamilyRowsForItem({ itemId: '4001', caseRef: '2026-SOWP-017' }),
    ]);
    assert.deepEqual([a, b], [3, 3], 'both callers get the one run\'s answer');
    assert.equal(creates, 3, 'three rows, once');
    assert.equal(reads, 1, 'one board read');
    assert.equal(await S.io.createIntakeRows({ itemId: '4001', caseRef: '2026-SOWP-017' }), 0, 'a board with rows: nothing more');
    assert.equal(creates, 3);
  } finally { compositionAdapter.readForCase = realRead; mondayApi.query = realQuery; leadService.findByColumnValue = realFind; }
});

// (2) A failure AFTER the lead write / the row: still transient, but the pass
// reports what it wrote, so the route never says "nothing was changed".
test('override, then the row / the manifest / the member write fails: transient WITH inviterSaved (and the row when it landed) — the card learns what exists', async () => {
  for (const [hooks, created] of [
    [{ rowThrows: true }, { row: false, member: false }],
    [{ manifestThrows: true }, { row: true, member: false }],
    [{ addMemberThrows: true }, { row: true, member: false }],
  ]) {
    await withFakeIo(async ({ names, store }) => {
      const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
      assert.equal(r.done, false); assert.equal(r.reason, 'transient');
      assert.equal(r.inviterSaved, true, `${JSON.stringify(hooks)}: the lead WAS written`);
      assert.deepEqual(r.created, created, JSON.stringify(hooks));
      assert.equal(store.claimants[0].inviterEmail, 'rahim@example.com');
      assert.ok(!names().includes('sendEmail') && !names().includes('writeMarker'));
      assert.doesNotMatch(JSON.stringify(r), LEAK);
    }, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })], manifest: hooks.addMemberThrows ? PRIMARY() : null, ...hooks });
  }
});

test('a read failure BEFORE any write still reports inviterSaved false and nothing created', () => withFakeIo(async () => {
  const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
  assert.equal(r.reason, 'transient'); assert.equal(r.inviterSaved, false); assert.deepEqual(r.created, { row: false, member: false });
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })], compositionThrows: true }));

// (4) "Add sponsor now" / "Save sponsor": the page promised no email. The case
// may have been paid since — the promise is kept whatever the case reads now.
test('createOnly on a case that NOW reads Paid + Document Collection: the row and the section are created, nothing is sent, reason create-only', () => withFakeIo(async ({ names, calls }) => {
  const r = await staff({ createOnly: true });
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'create-only');
  assert.deepEqual(r.created, { row: true, member: true });
  assert.ok(!names().includes('sendEmail') && !names().includes('writeMarker'));
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /questionnaire section "Faheem Khan" created\. Send the portal email from the case page \(Send sponsor link\)\./, 'no automatic trigger is due on a case already at Document Collection');
  assert.doesNotMatch(note, /automatically/);
}, { manifest: PRIMARY() }));

test('createOnly with a typed sponsor (Save sponsor) on a case paid meanwhile: the lead is saved, nothing is sent; createOnly with the marker already sent: still no resend', () => withFakeIo(async ({ names, store }) => {
  const r = await staff({ override: { name: 'Rahim Ali', email: 'rahim@example.com' }, createOnly: true });
  assert.equal(r.sent, false); assert.equal(r.inviterSaved, true); assert.equal(r.reason, 'create-only');
  assert.ok(!names().includes('sendEmail'));
  store.marker = { version: 1, status: 'sent', sentAt: '2026-09-20T10:00:00Z', startedAt: '2026-09-20T09:59:59Z', sendCount: 1, sends: [], sponsor: { name: 'Rahim Ali', emailMasked: 'r***@example.com' } };
  const again = await staff({ createOnly: true });
  assert.equal(again.sent, false); assert.equal(again.reason, 'create-only');
  assert.ok(!names().includes('sendEmail'));
  assert.equal(names().filter((n) => n === 'createFamilyRow').length, 1);
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })] }));

test('createOnly is a staff flag: the automatic path ignores it (nothing changes for onboard)', () => withFakeIo(async () => {
  const r = await onboard({ createOnly: true });
  assert.equal(r.sent, false); assert.equal(r.reason, 'create-only', 'if a caller ever passed it, still never a send');
  const p = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref', createOnly: true });
  assert.equal(p.reason, 'prepare');
}));

// (5) A row / section created, then no portal link: the note still says so.
test('no access token AFTER the row and the section were created: no send, no marker — but the note records the section and says nothing was emailed', () => withFakeIo(async ({ names, calls }) => {
  const r = await onboard();
  assert.equal(r.sent, false); assert.equal(r.reason, 'no-token');
  assert.deepEqual(r.created, { row: true, member: true });
  assert.ok(!names().includes('writeMarker') && !names().includes('sendEmail'));
  const note = calls.find((c) => c[0] === 'postNote');
  assert.ok(note, 'a note was posted');
  assert.match(note[2], /Sponsor Faheem Khan added to the case by the system — questionnaire section "Faheem Khan" created\. No portal link could be made just now, so nothing was emailed — send it from the case page \(Send sponsor link\)\./);
}, { cm: CM({ accessToken: '' }), noToken: true, manifest: PRIMARY() }));

// (7) The sponsor replaced in the retainer panel AFTER a send: that person was
// never emailed — not "already sent", not a "resend", not "Emailed …" on the card.
test('inviter changed after a send: the card says not emailed (and whom the earlier email went to); the staff send is an ONBOARDING to the new address, noted as sent, with its own count', () => withFakeIo(async ({ store, calls, names }) => {
  await onboard();
  assert.equal(store.marker.status, 'sent');
  assert.equal(store.marker.sponsor.emailKey, S.emailKeyOf('faheem@example.com'));
  store.claimants[0].inviterName = 'Rahim Ali'; store.claimants[0].inviterEmail = 'rahim@example.com';   // the retainer panel

  const card = S.describeFromInputs({ claimants: [store.claimants[0]], marker: store.marker, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: store.composition.members }, qMembers: PRIMARY() });
  assert.equal(card.name, 'Rahim Ali'); assert.equal(card.emailedAt, null); assert.equal(card.sentCount, 0); assert.equal(card.lastError, null);
  assert.equal(card.replacedFrom, 'f***@example.com'); assert.equal(card.canSend, true);
  const early = S.describeFromInputs({ claimants: [store.claimants[0]], marker: store.marker, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Retainer Signed', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() });
  assert.equal(early.canSend, false); assert.equal(early.sendBlockedReason, 'not-started', 'a first send to the new person needs Paid + Document Collection like any first send');

  const before = calls.length;
  const r = await staff();
  assert.equal(r.sent, true); assert.equal(r.variant, 'onboarding'); assert.equal(r.to, 'r***@example.com');
  const email = calls.slice(before).find((c) => c[0] === 'sendEmail');
  assert.equal(email[1], 'rahim@example.com');
  assert.match(email[2], /^Action Required — Your part in Aisha Khan's SOWP application \(2026-SOWP-017\)$/);
  assert.match(email[3], /Hi Rahim,/);
  assert.doesNotMatch(email[3], /\bagain\b/, 'a first email to this person, not "here is the link again"');
  assert.equal(store.marker.sendCount, 1, 'the new person\'s own count');
  assert.deepEqual(store.marker.sponsor, { name: 'Rahim Ali', emailMasked: 'r***@example.com', emailKey: S.emailKeyOf('rahim@example.com') });
  assert.equal(store.marker.sends.length, 2, 'the history keeps the earlier send');
  assert.equal(store.marker.sends[1].replacedFrom, 'f***@example.com');
  assert.equal(store.marker.sends[1].to, 'r***@example.com');
  assert.match(calls.slice(before).find((c) => c[0] === 'postNote')[2], /Sponsor portal email sent by Gauri to r\*\*\*@example\.com/);
  assert.doesNotMatch(leaks({ store, calls, r }), LEAK);
  const after = S.describeFromInputs({ claimants: [store.claimants[0]], marker: store.marker, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() });
  assert.equal(after.replacedFrom, null); assert.equal(after.sentCount, 1); assert.ok(after.emailedAt);
  assert.ok(!names().includes('updateLead'));
}));

test('inviter changed after a send: the automatic path sends ONCE more to the new person while its gates hold (never "already-sent" for someone never emailed)', () => withFakeIo(async ({ store, calls }) => {
  await onboard();
  store.claimants[0].inviterName = 'Rahim Ali'; store.claimants[0].inviterEmail = 'rahim@example.com';
  const r = await onboard({ trigger: 'sub-type' });
  assert.equal(r.sent, true); assert.equal(r.variant, 'onboarding');
  assert.deepEqual(calls.filter((c) => c[0] === 'sendEmail').map((c) => c[1]), ['faheem@example.com', 'rahim@example.com']);
  const third = await onboard({ trigger: 'sub-type' });
  assert.equal(third.sent, false); assert.equal(third.reason, 'already-sent');
}));

test('two addresses with the SAME mask (faheem@ / farah@ → f***@example.com) are still told apart — by the address fingerprint, never the address', () => withFakeIo(async ({ store }) => {
  await onboard();
  store.claimants[0].inviterEmail = 'farah@example.com';
  const card = S.describeFromInputs({ claimants: [store.claimants[0]], marker: store.marker, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() });
  assert.equal(card.replacedFrom, 'f***@example.com'); assert.equal(card.emailedAt, null);
  assert.ok(!JSON.stringify(store.marker).includes('faheem'), 'the fingerprint is not the address');
  // An older marker without a fingerprint falls back to the mask: a same-mask change is NOT detected there (documented), a different mask is.
  const legacy = { status: 'sent', sentAt: '2026-09-12T18:03:00Z', sendCount: 1, sponsor: { name: 'Faheem Khan', emailMasked: 'f***@example.com' } };
  assert.equal(S.describeFromInputs({ claimants: [LEAD({ inviterEmail: 'farah@example.com' })], marker: legacy, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Submitted', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() }).replacedFrom, null);
  assert.equal(S.describeFromInputs({ claimants: [LEAD({ inviterEmail: 'rahim@example.com' })], marker: legacy, caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', caseStage: 'Submitted', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() }).replacedFrom, 'f***@example.com');
}));

// (9) + (3) The "created, not sent" note says what the AUTOMATIC gates will do.
test("'prepare' on a paid-before-type case whose agreement is not fully executed: the note does not promise an email the resume then refuses", () => withFakeIo(async ({ calls, names }) => {
  const p = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
  assert.deepEqual(p.created, { row: true, member: false });
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /questionnaire section "Faheem Khan" created\. The agreement is not fully executed yet, so nothing is emailed automatically — send it from the case page \(Send sponsor link\)\./);
  assert.doesNotMatch(note, /follows automatically/);
  const r = await onboard({ trigger: 'resume' });
  assert.equal(r.sent, false); assert.equal(r.reason, 'signature-incomplete');
  assert.ok(!names().includes('sendEmail'));
}, { claimants: [LEAD({ retainerCountersign: JSON.stringify({ clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: '' }) })] }));

test("'prepare' on a case already onboarded (checklist applied): the note says so instead of promising an email", () => withFakeIo(async ({ calls }) => {
  await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /This case was onboarded before the sponsor was added, so nothing is emailed automatically — send it from the case page \(Send sponsor link\)\./);
}, { cm: CM({ checklistTemplateApplied: 'Yes' }) }));

test('staff adds a sponsor whose address is the client\'s own before payment: the note never promises the automatic email (that address is never emailed automatically)', () => withFakeIo(async ({ calls }) => {
  const r = await staff({ createOnly: true });
  assert.equal(r.sent, false); assert.deepEqual(r.created, { row: true, member: true });
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /created\. Send it from the case page \(Send sponsor link\) — the address is the client’s, so it is never emailed automatically\./);
  assert.doesNotMatch(note, /goes out automatically/);
}, { claimants: [LEAD({ inviterEmail: 'Aisha@Example.com' })], manifest: PRIMARY(), cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) }));

test('nextStepSentence: every wording, once', () => {
  const started = CM(), early = CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' });
  const t = (o) => S.nextStepSentence({ mode: 'staff', cm: early, autoEnabled: true, ...o });
  assert.equal(t({ noToken: true }), 'No portal link could be made just now, so nothing was emailed — send it from the case page (Send sponsor link).');
  assert.equal(t({ autoEnabled: false }), 'Send the portal email from the case page (Send sponsor link) once the case is paid and at Document Collection.');
  assert.equal(t({ autoEnabled: false, cm: started }), 'Send the portal email from the case page (Send sponsor link).');
  assert.equal(t({ sameAsClient: true }), 'Send it from the case page (Send sponsor link) — the address is the client’s, so it is never emailed automatically.');
  assert.equal(t({ gateReason: 'signature-incomplete' }), 'The agreement is not fully executed yet, so nothing is emailed automatically — send it from the case page (Send sponsor link).');
  assert.equal(t({ gateReason: 'already-onboarded' }), 'This case was onboarded before the sponsor was added, so nothing is emailed automatically — send it from the case page (Send sponsor link).');
  assert.equal(t({ gateReason: 'not-started' }), 'The portal email goes out automatically when Document Collection starts.');
  assert.equal(t({ gateReason: null, mode: 'prepare', cm: started }), 'The portal email follows automatically.');
  assert.equal(t({ gateReason: null, cm: started }), 'Send the portal email from the case page (Send sponsor link).');
  for (const o of [{}, { noToken: true }, { sameAsClient: true }, { gateReason: 'signature-incomplete' }]) assert.doesNotMatch(t(o), /\b(he|she|his|her)\b/i);
});

// ─── The Monday notes are HTML: every name in them is escaped ────────────────
// The inviter name is typed on the lead (WhatsApp paste, a retainer panel
// field), the actor name comes from the staff cookie — both land in a Monday
// update that renders HTML. A "<b>" or "<script>" in either must arrive as text.
test('the "added" and "sent" notes escape the sponsor name, the section label and the actor name', () => withFakeIo(async ({ calls }) => {
  const p = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
  assert.deepEqual(p.created, { row: true, member: false });
  const added = calls.find((c) => c[0] === 'postNote')[2];
  assert.ok(!/<b>|<script>/.test(added), `raw markup in the note: ${added}`);
  assert.match(added, /Sponsor &lt;b&gt;Faheem&lt;\/b&gt; &lt;script&gt;Khan added to the case by the system — questionnaire section "&lt;b&gt;Faheem&lt;\/b&gt; &lt;script&gt;Khan" created\./);

  const r = await staff({ actor: { name: '<i>Gauri</i>', email: 'gauri@example.com', verified: true } });
  assert.equal(r.sent, true, JSON.stringify(r));
  const sent = calls.filter((c) => c[0] === 'postNote').pop()[2];
  assert.ok(!/<i>|<b>|<script>/.test(sent), `raw markup in the note: ${sent}`);
  assert.match(sent, /Sponsor portal email sent by &lt;i&gt;Gauri&lt;\/i&gt; to f\*\*\*@example\.com \(Worker Spouse\)/);
}, { claimants: [LEAD({ inviterName: '<b>Faheem</b> <script>Khan' })] }));

test('the "entered from the case page" note escapes the typed inviter name and the actor name', () => withFakeIo(async ({ calls }) => {
  const r = await staff({ actor: { name: '<i>Gauri</i>', email: 'gauri@example.com', verified: true }, override: { name: '<u>Rahim</u> Ali', email: 'rahim@example.com' } });
  assert.equal(r.sent, true, JSON.stringify(r));
  const entered = calls.find((c) => c[0] === 'postNote')[2];
  assert.ok(!/<u>|<i>/.test(entered), `raw markup in the note: ${entered}`);
  assert.match(entered, /Sponsor \/ inviter &lt;u&gt;Rahim&lt;\/u&gt; Ali \(r\*\*\*@example\.com\) entered from the case page by &lt;i&gt;Gauri&lt;\/i&gt; — saved to the client record\./);
  const sent = calls.filter((c) => c[0] === 'postNote').pop()[2];
  assert.match(sent, /sent by &lt;i&gt;Gauri&lt;\/i&gt;/);
  assert.match(sent, /Questionnaire section "&lt;u&gt;Rahim&lt;\/u&gt; Ali" created\./);
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })], manifest: PRIMARY() }));

// ─── Ship review (2026-09-25): the automatic path is live ────────────────────

// (1) The Sub Type webhook lands on ANY case, months in. Its gate mirrors the
// checklist resume beside it: the EXPLICIT 'No' the payment flow writes, at
// Document Collection Started exactly. The payment-flow triggers keep theirs.
test("sub-type trigger on a legacy case (applied blank, stage 'Submission Preparation'): nothing created, nothing sent — the checklist resume beside it does nothing either", () => withFakeIo(async ({ names, store }) => {
  const r = await onboard({ trigger: 'sub-type' });
  assert.equal(r.done, true); assert.equal(r.sent, false); assert.equal(r.reason, 'stage-not-dcs');
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), [], 'no row, no section, no marker, no email, no note');
  assert.equal(store.marker, null);
  assert.deepEqual(store.composition.members, []);
}, { cm: CM({ checklistTemplateApplied: '', caseStage: 'Submission Preparation' }) }));

test("sub-type trigger: applied blank at DCS → not-payment-flow; applied 'No' at DCS → sends; the dcs / retainer-paid / resume triggers still send at 'Internal Review' with applied blank", async () => {
  await withFakeIo(async ({ names }) => {
    const r = await onboard({ trigger: 'sub-type' });
    assert.equal(r.sent, false); assert.equal(r.reason, 'not-payment-flow');
    assert.deepEqual(names().filter((n) => WRITES.includes(n)), []);
  }, { cm: CM({ checklistTemplateApplied: '' }) });
  await withFakeIo(async () => {
    const r = await onboard({ trigger: 'sub-type' });
    assert.equal(r.sent, true, JSON.stringify(r));
  }, { cm: CM({ checklistTemplateApplied: 'No' }) });
  for (const trigger of ['dcs', 'retainer-paid', 'resume']) {
    await withFakeIo(async () => {
      const r = await onboard({ trigger });
      assert.equal(r.sent, true, `${trigger}: ${JSON.stringify(r)}`);
    }, { cm: CM({ checklistTemplateApplied: '', caseStage: 'Internal Review' }) });
  }
  // The pure gate, once per rule.
  const cm = CM({ checklistTemplateApplied: 'No' });
  const lead = LEAD();
  assert.equal(S.gatesFor({ mode: 'onboard', cm, claimants: [lead], today: '2026-09-24', trigger: 'sub-type' }).ok, true);
  assert.equal(S.gatesFor({ mode: 'onboard', cm: { ...cm, caseStage: 'Internal Review' }, claimants: [lead], today: '2026-09-24', trigger: 'sub-type' }).reason, 'stage-not-dcs');
  assert.equal(S.gatesFor({ mode: 'onboard', cm: { ...cm, checklistTemplateApplied: '' }, claimants: [lead], today: '2026-09-24', trigger: 'sub-type' }).reason, 'not-payment-flow');
  assert.equal(S.gatesFor({ mode: 'onboard', cm: { ...cm, checklistTemplateApplied: 'Yes' }, claimants: [lead], today: '2026-09-24', trigger: 'sub-type' }).reason, 'already-onboarded', "'Yes' keeps its permanent reason");
  assert.equal(S.gatesFor({ mode: 'onboard', cm: { ...cm, checklistTemplateApplied: '', caseStage: 'Internal Review' }, claimants: [lead], today: '2026-09-24', trigger: 'dcs' }).ok, true);
  assert.equal(S.gatesFor({ mode: 'onboard', cm: { ...cm, checklistTemplateApplied: '', caseStage: 'Internal Review' }, claimants: [lead], today: '2026-09-24' }).ok, true, 'no trigger: the payment-flow rule');
  assert.equal(S.gatesFor({ mode: 'staff', cm: { ...cm, checklistTemplateApplied: '', caseStage: 'Internal Review' }, claimants: [lead], today: '2026-09-24', trigger: 'sub-type' }).ok, true, 'staff mode is never gated by the trigger');
});

// (2) Nothing the automatic path could not send is invisible any more.
function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return Promise.resolve().then(fn).finally(() => { console.log = real; }).then(() => lines);
}

test('every non-sent automatic pass logs ONE line — except the switch off, a case type with no sponsor, and a link the sponsor already holds', async () => {
  const notSent = /^\[Sponsor\] 2026-SOWP-017: not sent via /;
  const caseLog = async (opts, over = {}) => withFakeIo(({ store }) => captureLog(() => onboard(over)).then((lines) => ({ lines: lines.filter((l) => /^\[Sponsor\]/.test(l)), store })), opts);
  let { lines } = await caseLog({ cm: CM({ paymentStatus: 'Not Paid' }) }, { trigger: 'sub-type' });
  assert.deepEqual(lines, ['[Sponsor] 2026-SOWP-017: not sent via sub-type (not-started)']);
  ({ lines } = await caseLog({ claimants: [LEAD({ inviterEmail: '' })] }));
  assert.deepEqual(lines, ['[Sponsor] 2026-SOWP-017: not sent via dcs (no-inviter)']);
  ({ lines } = await caseLog({ claimants: [LEAD(), LEAD({ id: '9002' })] }, { trigger: 'retainer-paid' }));
  assert.deepEqual(lines, ['[Sponsor] 2026-SOWP-017: not sent via retainer-paid (shared-case)']);
  ({ lines } = await caseLog({ markerThrows: true }, { trigger: 'resume' }));
  assert.deepEqual(lines, ['[Sponsor] 2026-SOWP-017: not sent via resume (transient)']);
  ({ lines } = await caseLog({ caseThrows: true }));
  assert.deepEqual(lines, ['[Sponsor] 4001: not sent via dcs (transient)'], 'before the case is read, the item id names it');
  ({ lines } = await caseLog({ claimants: [LEAD({ inviterEmail: 'Aisha@Example.com' })] }));
  assert.deepEqual(lines, ['[Sponsor] 2026-SOWP-017: not sent via dcs (same-as-client)']);
  ({ lines } = await caseLog({ cm: CM({ accessToken: '' }), noToken: true }));
  assert.ok(lines.some((l) => notSent.test(l) && /\(no-token\)/.test(l)), lines.join('|'));
  ({ lines } = await caseLog({ marker: { version: 1, status: 'pending', startedAt: new Date(Date.parse('2026-09-24T15:00:00Z') - 2 * 60 * 1000).toISOString(), sendCount: 0, sends: [] } }));
  assert.deepEqual(lines, ['[Sponsor] 2026-SOWP-017: not sent via dcs (in-progress)']);
  // quiet: the switch, the case type, the link already held
  ({ lines } = await caseLog({ env: null }));
  assert.deepEqual(lines, []);
  ({ lines } = await caseLog({ cm: CM({ caseType: 'Canadian Experience Class (EE after ITA)', caseSubType: 'CEC Single Applicant' }) }));
  assert.deepEqual(lines, []);
  ({ lines } = await caseLog({ marker: { version: 1, status: 'sent', sentAt: '2026-09-20T10:00:00Z', startedAt: '2026-09-20T09:59:59Z', sendCount: 1, sends: [], sponsor: { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') } }, members: [{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }] }, { trigger: 'sub-type' }));
  assert.deepEqual(lines.filter((l) => notSent.test(l)), [], 'already-sent is quiet');
  // a send logs the send, not a "not sent"
  ({ lines } = await caseLog({}));
  assert.ok(!lines.some((l) => notSent.test(l)) && lines.some((l) => /Onboarding email sent/.test(l)));
  // 'prepare' and 'staff' never log a "not sent" line
  await withFakeIo(async () => {
    const lines = await captureLog(async () => { await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' }); await staff(); });
    assert.deepEqual(lines.filter((l) => notSent.test(l)), []);
  }, { cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) });
});

test('a read failure at DCS: the note says so, ONE retry is scheduled (90 s, through the seam) and, when the case reads again, the retry sends — recorded as auto:dcs-retry', () => withFakeIo(async ({ store, calls, names }) => {
  const r = await onboard();
  assert.equal(r.reason, 'transient');
  assert.equal(calls.filter((c) => c[0] === 'scheduleRetry').length, 1);
  assert.equal(typeof store.retry, 'function');
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /One more attempt follows in about 90 seconds/);
  // a second transient pass on the SAME case (another one-shot trigger) schedules no second retry, and its note says so
  const again = await onboard({ trigger: 'retainer-paid' });
  assert.equal(again.reason, 'transient');
  assert.equal(calls.filter((c) => c[0] === 'scheduleRetry').length, 1, 'one retry per case per process');
  const note2 = calls.filter((c) => c[0] === 'postNote').pop()[2];
  assert.match(note2, /not sent automatically — the case could not be read or updated just now \(graph down\)\. Please send it from the case page \(Send sponsor link\)\./);
  assert.doesNotMatch(note2, /One more attempt/);
  // the marker read recovers; the retry fires
  S.io.readMarker = async () => null;
  const before = calls.length;
  await store.retry();
  const sent = calls.slice(before).find((c) => c[0] === 'sendEmail');
  assert.ok(sent, 'the retry sent the email');
  assert.equal(store.marker.status, 'sent');
  assert.equal(store.marker.sends[0].by, 'auto:dcs-retry');
  assert.ok(!names().slice(before).includes('scheduleRetry'), 'a retry never schedules another');
}, { markerThrows: true }));

test('a retry that fails again logs only (no second note, no second retry); the sub-type trigger and the automatic no-lead case post no note', async () => {
  await withFakeIo(async ({ calls, names }) => {
    const lines = await captureLog(() => onboard({ trigger: 'dcs-retry' }));
    assert.deepEqual(lines.filter((l) => /^\[Sponsor\]/.test(l)), ['[Sponsor] 2026-SOWP-017: not sent via dcs-retry (transient)']);
    assert.ok(!names().includes('postNote') && !names().includes('scheduleRetry'), JSON.stringify(calls.map((c) => c[0])));
  }, { markerThrows: true });
  await withFakeIo(async ({ names }) => {
    const r = await onboard({ trigger: 'sub-type' });
    assert.equal(r.reason, 'transient');
    assert.ok(!names().includes('postNote') && !names().includes('scheduleRetry'), 'a Sub Type edit is not a one-shot trigger: staff just edited the case and can see the card');
  }, { compositionThrows: true });
  await withFakeIo(async ({ names }) => {
    const r = await onboard({ trigger: 'sub-type' });
    assert.equal(r.reason, 'no-inviter');
    assert.ok(!names().includes('postNote'));
  }, { claimants: [LEAD({ inviterEmail: '' })] });
});

test('the "not sent" note reaches the case even when the failure was the case read itself (the item id is known), and a note failure never changes the answer', () => withFakeIo(async ({ calls }) => {
  const r = await onboard();
  assert.equal(r.reason, 'transient');
  const note = calls.find((c) => c[0] === 'postNote');
  assert.equal(note[1], '4001');
  assert.match(note[2], /could not be read or updated just now \(monday down\)/);
  assert.equal(S.notSentNote({ reason: 'not-started' }), '', 'a closed gate is not a failure: no note');
  assert.equal(S.notSentNote({ reason: 'transient', error: '<b>x</b>', retryScheduled: false }), '🤝 Sponsor portal email not sent automatically — the case could not be read or updated just now (&lt;b&gt;x&lt;/b&gt;). Please send it from the case page (Send sponsor link).');
  for (const reason of ['no-inviter', 'shared-case', 'transient']) assert.doesNotMatch(S.notSentNote({ reason, claimantCount: 2, retryScheduled: true }), /\b(he|she|his|her)\b/i);
}, { caseThrows: true, noteThrows: true }));

// (3) A board search that lags the chain's create_item by seconds.
test('stale board read (the lead says hasSpouse = Yes, the search shows nothing, the intake rows were created moments ago): NO Sponsor row — the intake Spouse row IS this person; the email names that section', () => withFakeIo(async ({ names, calls, store }) => {
  const r = await onboard();
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.deepEqual(r.created, { row: false, member: false });
  assert.equal(r.sectionLabel, 'Spouse');
  assert.ok(names().includes('createIntakeRows'), 'the intake rows are still asked for (createFromLead skips them itself when this process just wrote them)');
  assert.ok(!names().includes('createFamilyRow'), 'never a second row for the spouse');
  assert.deepEqual(store.composition.members, [], 'nothing written to the board by this pass');
  assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Spouse<\/strong>" \(marked "Spouse"\)/);
}, { claimants: [LEAD({ hasSpouse: 'Yes', childrenCount: '1' })] }));

test('a CURATED board (rows present, no Spouse row) is trusted over the lead: the sponsor gets a row of their own, so the manifest never names a member the board lacks', async () => {
  const child = { role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} };
  const manifest = [...PRIMARY(), { key: 'child-1', type: 'Dependent Child', label: 'Child 1' }];
  // staff removed the intake's Spouse row; the lead still says hasSpouse = Yes
  await withFakeIo(async ({ names, store }) => {
    const r = await onboard();
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.deepEqual(r.created, { row: true, member: true });
    assert.ok(names().includes('createFamilyRow'));
    assert.deepEqual(store.composition.members.map((m) => m.role), ['DependentChild', 'Sponsor']);
    assert.deepEqual(store.manifest.map((m) => m.type), ['Principal Applicant', 'Dependent Child', 'Sponsor'], 'board and manifest agree');
  }, { members: [child], manifest, claimants: [LEAD({ hasSpouse: 'Yes' })] });
  // 'prepare' on the same board: the row, no section (no manifest yet), never a member without a row
  await withFakeIo(async ({ names }) => {
    const p = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
    assert.deepEqual(p.created, { row: true, member: false });
    assert.ok(names().includes('createFamilyRow'));
  }, { members: [child], claimants: [LEAD({ hasSpouse: 'Yes' })] });
  // an EMPTY read is still the lag the lead fallback is for
  await withFakeIo(async ({ names }) => {
    const r = await onboard();
    assert.deepEqual(r.created, { row: false, member: false });
    assert.ok(!names().includes('createFamilyRow'));
  }, { claimants: [LEAD({ hasSpouse: 'Yes' })] });
});

test("stale board read with the consultant's family list: the section carries the spouse's real name; a lead with no spouse still gets the Sponsor row; the staff button trusts the board it read", async () => {
  const retainerFamilyMembers = JSON.stringify([{ type: 'Spouse', name: 'Faheem Khan', accompanying: 'Yes' }]);
  await withFakeIo(async ({ names, calls }) => {
    const r = await onboard();
    assert.equal(r.sent, true); assert.equal(r.sectionLabel, 'Faheem Khan'); assert.deepEqual(r.created, { row: false, member: false });
    assert.ok(!names().includes('createFamilyRow'));
    assert.match(calls.find((c) => c[0] === 'sendEmail')[3], /section headed "<strong>Faheem Khan<\/strong>" \(marked "Spouse"\)/);
  }, { claimants: [LEAD({ hasSpouse: 'No', retainerFamilyMembers })] });
  await withFakeIo(async ({ names }) => {
    const r = await onboard();
    assert.equal(r.sent, true); assert.deepEqual(r.created, { row: true, member: false }, 'children only: the sponsor is a separate person');
    assert.ok(names().includes('createFamilyRow'));
  }, { claimants: [LEAD({ hasSpouse: 'No', childrenCount: '2' })] });
  await withFakeIo(async ({ names }) => {
    const p = await S.ensureSponsor({ itemId: '4001', mode: 'prepare', trigger: 'case-ref' });
    assert.deepEqual(p.created, { row: false, member: false }, "'prepare' (the chain, right after the intake rows) asks the lead too");
    assert.ok(!names().includes('createFamilyRow'));
    const st = await staff();
    assert.equal(st.sent, true); assert.deepEqual(st.created, { row: true, member: false }, 'the staff button reads a board nobody wrote to seconds before');
  }, { claimants: [LEAD({ hasSpouse: 'Yes' })] });
  // the pure planner
  const sp = { sponsorIsSpouse: true };
  assert.deepEqual(S.partnerFromLead(sp, { hasSpouse: 'Yes' }), { role: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse', flags: {}, fromLead: true });
  assert.equal(S.partnerFromLead(sp, { hasSpouse: 'No', childrenCount: '2' }), null);
  assert.equal(S.partnerFromLead(sp, { hasSpouse: 'Yes', retainerFamilyMembers: JSON.stringify([]) }), null, "the consultant's list is authoritative even when empty");
  assert.equal(S.partnerFromLead({ sponsorIsSpouse: false }, { hasSpouse: 'Yes' }), null, 'a child in Canada inviting parents: the Spouse row is the applicant\'s spouse');
  assert.equal(S.partnerFromLead(sp, null), null);
});

test('createFromLead: rows this process created in the last ten minutes are never created again, whatever the board search says (a lagging read)', async () => {
  const fam = require('../src/services/familyCompositionService');
  const compositionAdapter = require('../src/services/compositionAdapter');
  const mondayApi = require('../src/services/mondayApi');
  const realRead = compositionAdapter.readForCase, realQuery = mondayApi.query;
  let creates = 0, fail = false;
  compositionAdapter.readForCase = async () => ({ caseFlags: {}, members: [] });   // the search never catches up
  mondayApi.query = async (q, vars) => {
    if (q.includes('create_item')) { creates++; if (fail && creates === 2) throw new Error('monday 500'); return { create_item: { id: String(creates) } }; }
    return { create_update: { id: '6' } };
  };
  const lead = { hasSpouse: 'Yes', childrenCount: '2' };
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    fam._createdRecently.clear();
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-900', cmItemId: '4900' }), 3);
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-900', cmItemId: '4900' }), 0, 'the second run creates nothing');
    assert.equal(creates, 3);
    assert.ok(lines.some((l) => /\[Family\] 2026-SOWP-900: rows were created by this process \d+ s ago — intake auto-create skipped/.test(l)), lines.join('|'));
    assert.equal(await fam.createFamilyRowsForItem.length, 1);
    // another case is not affected
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-901', cmItemId: '4901' }), 3);
    // the SAME reference on a NEW case item (the newest case of a type was careful-deleted and
    // re-created minutes later, so generateCaseRef reissued it): the new case's rows are created
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-900', cmItemId: '4950' }), 3, 'a reissued reference is a new case');
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-900', cmItemId: '4900' }), 0, 'the old item is still remembered');
    assert.equal(fam.recentKey('4900', '2026-SOWP-900'), '4900:2026-SOWP-900');
    // the memory expires
    fam._createdRecently.set(fam.recentKey('4900', '2026-SOWP-900'), Date.now() - fam.RECENT_CREATE_WINDOW_MS - 1);
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-900', cmItemId: '4900' }), 3, 'after ten minutes the board search is trusted again');
    // a set that failed half-way is remembered too: the row that landed must not be doubled
    fam._createdRecently.clear(); creates = 0; fail = true;
    await assert.rejects(fam.createFromLead({ lead, caseRef: '2026-SOWP-902', cmItemId: '4902' }), /monday 500/);
    assert.equal(creates, 2);
    assert.ok(fam._createdRecently.has(fam.recentKey('4902', '2026-SOWP-902')));
    assert.equal(await fam.createFromLead({ lead, caseRef: '2026-SOWP-902', cmItemId: '4902' }), 0);
  } finally { compositionAdapter.readForCase = realRead; mondayApi.query = realQuery; console.log = realLog; fam._createdRecently.clear(); }
});

test("the chain's 'prepare' right after it wrote the intake rows (boardJustWritten): no row, no section, no note — the DCS pass re-checks", () => withFakeIo(async ({ names, store }) => {
  const p = await S.ensureSponsor({ itemId: '4001', caseRef: '2026-SOWP-017', mode: 'prepare', trigger: 'case-ref', boardJustWritten: true });
  assert.equal(p.done, true); assert.equal(p.sent, false); assert.equal(p.reason, 'prepare');
  assert.deepEqual(p.created, { row: false, member: false });
  assert.deepEqual(names().filter((n) => WRITES.includes(n)), []);
  assert.deepEqual(store.composition.members, []);
  const again = await S.ensureSponsor({ itemId: '4001', caseRef: '2026-SOWP-017', mode: 'prepare', trigger: 'case-ref', boardJustWritten: false });
  assert.deepEqual(again.created, { row: true, member: true }, 'without the flag the pass creates as before (a manifest is on file, so the section too)');
  // the planner: the flag closes createRow and addMember, nothing else
  const NOW = Date.parse('2026-09-24T15:00:00Z');
  const sponsor = { status: 'ok', name: 'Faheem Khan', sectionMode: 'section', role: 'Sponsor', boardMemberType: 'Sponsor', memberKey: 'sponsor', manifestType: 'Sponsor', sponsorIsSpouse: true, emailMasked: 'f***@example.com' };
  const withFlag = S.planEnsure({ sponsor, composition: { members: [] }, manifest: PRIMARY(), marker: null, mode: 'prepare', now: NOW, boardJustWritten: true });
  assert.equal(withFlag.createRow, false); assert.equal(withFlag.addMember, false); assert.equal(withFlag.skipReason, 'prepare');
  const without = S.planEnsure({ sponsor, composition: { members: [] }, manifest: PRIMARY(), marker: null, mode: 'prepare', now: NOW });
  assert.equal(without.createRow, true); assert.equal(without.addMember, true);
}, { manifest: PRIMARY(), cm: CM({ paymentStatus: 'Not Paid', caseStage: 'Retainer Signed' }) }));

// (4) The card is hidden on case types no variant of which has a sponsor.
test('describeFromInputs: a blank or mistyped Sub Type on CEC / OINP / Study Permit is not-applicable (the card stays hidden); "Set the Case Sub Type first" only for a type whose variants carry a sponsor', () => {
  const base = { claimants: [LEAD()], clientEmail: 'aisha@example.com', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY(), now: Date.parse('2026-09-24T15:00:00Z') };
  for (const [caseType, caseSubType] of [
    ['Canadian Experience Class (EE after ITA)', ''], ['Canadian Experience Class (EE after ITA)', 'Typo'],
    ['OINP', ''], ['OINP', 'Human Capital Priorities Streem'],
    ['Study Permit', ''], ['Study Permit', 'Nope'],
    ['PGWP', ''], ['LMIA', ''], ['Notary', 'x'], ['', ''],
  ]) {
    const r = S.describeFromInputs({ ...base, caseType, caseSubType });
    assert.equal(r.status, 'none', `${caseType}/${caseSubType}`);
    assert.equal(r.reason, 'not-applicable', `${caseType}/${caseSubType}: ${r.reason}`);
  }
  assert.equal(S.describeFromInputs({ ...base, caseType: 'SOWP', caseSubType: '' }).reason, 'sub-type-missing');
  assert.equal(S.describeFromInputs({ ...base, caseType: 'Supervisa', caseSubType: '' }).reason, 'sub-type-missing');
  assert.equal(S.describeFromInputs({ ...base, caseType: 'SOWP', caseSubType: 'Nope' }).reason, 'no-schema');
  assert.equal(S.describeFromInputs({ ...base, caseType: 'SCLPC WP', caseSubType: 'Nope' }).reason, 'no-schema', 'a sponsor type with one schema and a Sub Type that matches nothing');
  assert.equal(S.describeFromInputs({ ...base, caseType: 'SCLPC WP', caseSubType: '' }).status, 'ok');
  assert.equal(S.caseTypeHasSponsor('OINP'), false); assert.equal(S.caseTypeHasSponsor('sowp'), true); assert.equal(S.caseTypeHasSponsor(''), false);
  assert.equal(S.caseTypeHasSubTypeVariants('SOWP'), true); assert.equal(S.caseTypeHasSubTypeVariants('SCLPC WP'), false); assert.equal(S.caseTypeHasSubTypeVariants('Nope'), false);
});

test('describe: CEC / OINP / Study Permit with the Sub Type blank read nothing and hide the card', () => withFakeIo(async ({ names }) => {
  const args = { itemId: '4001', caseRef: '2026-OINP-001', clientName: 'Aisha Khan', clientEmail: 'aisha@example.com', caseStage: 'Document Collection Started', paymentStatus: 'Paid', composition: { members: [] }, qMembers: PRIMARY() };
  for (const caseType of ['Canadian Experience Class (EE after ITA)', 'OINP', 'Study Permit']) {
    const r = await S.describe({ ...args, caseType, caseSubType: '' });
    assert.equal(r.reason, 'not-applicable', caseType);
  }
  assert.deepEqual(names(), []);
  const onboardCec = await S.ensureSponsor({ itemId: '4001', mode: 'onboard', trigger: 'dcs' });
  assert.equal(onboardCec.reason, 'not-applicable', 'the automatic path agrees');
}, { cm: CM({ caseType: 'OINP', caseSubType: '' }) }));

// (6) Who sent it, honestly: a typed name is marked as typed, as the payment notes do.
test('staff notes: a Monday sign-in is named as is; an unverified name reads "(name as typed)"; the shared-key placeholder is printed without the mark', () => withFakeIo(async ({ calls, store }) => {
  const typed = await staff({ actor: { name: 'Faran', email: '', verified: false }, createOnly: true });
  assert.deepEqual(typed.created, { row: true, member: true });
  const added = calls.filter((c) => c[0] === 'postNote').pop()[2];
  assert.match(added, /Sponsor Faheem Khan added to the case by Faran \(name as typed\) — questionnaire section/);
  const r = await staff({ actor: { name: 'Faran', email: '', verified: false } });
  assert.equal(r.sent, true);
  const sent = calls.filter((c) => c[0] === 'postNote').pop()[2];
  assert.match(sent, /Sponsor portal email sent by Faran \(name as typed\) to f\*\*\*@example\.com/);
  assert.equal(store.marker.sends[0].by, 'Faran');
  const key = await staff({ actor: { name: 'Unidentified (shared admin key)', email: '', verified: false } });
  assert.equal(key.sent, true);
  const byKey = calls.filter((c) => c[0] === 'postNote').pop()[2];
  assert.match(byKey, /re-sent by Unidentified \(shared admin key\) to f\*\*\*@example\.com/);
  assert.doesNotMatch(byKey, /name as typed/);
  const signedIn = await staff();
  assert.match(calls.filter((c) => c[0] === 'postNote').pop()[2], /re-sent by Gauri to f\*\*\*@example\.com/);
  assert.equal(signedIn.sent, true);
  assert.equal(S.actorLabel({ name: '<b>X</b>', verified: false }), '&lt;b&gt;X&lt;/b&gt; (name as typed)');
  assert.equal(S.actorLabel({ name: 'Gauri', verified: true }), 'Gauri');
  assert.equal(S.actorLabel({ name: 'Gauri' }), 'Gauri (name as typed)', 'no verified flag = not verified');
}, { manifest: PRIMARY() }));

test('the "entered from the case page" note marks a typed actor too', () => withFakeIo(async ({ calls }) => {
  const r = await staff({ actor: { name: 'Faran', email: '', verified: false }, override: { name: 'Rahim Ali', email: 'rahim@example.com' } });
  assert.equal(r.sent, true);
  assert.match(calls.find((c) => c[0] === 'postNote')[2], /entered from the case page by Faran \(name as typed\) — saved to the client record\./);
}, { claimants: [LEAD({ inviterName: '', inviterEmail: '' })] }));

// (8) A process that dies between 'pending' and 'sent'.
test("the pending marker records that the send is next (attemptedAt); a 'sent' clears it", () => withFakeIo(async ({ calls, store }) => {
  await onboard();
  const pending = calls.find((c) => c[0] === 'writeMarker' && c[1] === 'pending')[2];
  assert.ok(pending.attemptedAt, 'written before the send');
  assert.equal(pending.attemptedAt, pending.startedAt);
  assert.ok(calls.findIndex((c) => c[0] === 'writeMarker') < calls.findIndex((c) => c[0] === 'sendEmail'));
  assert.equal(store.marker.status, 'sent');
  assert.equal(store.marker.attemptedAt, undefined, 'a recorded send needs no "may have reached" mark');
}));

test("a stale 'pending' that got as far as its send: the next automatic pass sends the link AGAIN (variant resend, never a second Action Required) and the note says the earlier email may have arrived", () => withFakeIo(async ({ calls, store }) => {
  const r = await onboard();
  assert.equal(r.sent, true); assert.equal(r.variant, 'resend');
  const email = calls.find((c) => c[0] === 'sendEmail');
  assert.match(email[2], /^Your portal link for Aisha Khan's application — 2026-SOWP-017$/);
  assert.doesNotMatch(email[2], /Action Required/);
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.match(note, /Sponsor portal email re-sent automatically to f\*\*\*@example\.com \(Worker Spouse\) — .* \(Toronto\)\./);
  assert.match(note, /An earlier send on 24 Sep 2026, \d{1,2}:\d{2} [ap]m \(Toronto\) was cut short before it could be recorded, so the sponsor may have received that email too — this one is the link again, not a second request\./);
  assert.equal(store.marker.status, 'sent'); assert.equal(store.marker.sendCount, 1);
  assert.deepEqual(store.marker.sends.map((x) => x.variant), ['resend']);
  assert.equal(store.marker.attemptedAt, undefined);
}, { marker: { version: 1, status: 'pending', startedAt: '2026-09-24T14:40:00Z', attemptedAt: '2026-09-24T14:40:00Z', sendCount: 0, sends: [], sponsor: { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') } }, members: [{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }] }));

test("a stale 'pending' WITHOUT attemptedAt (older marker, or a crash before the send) is still a first onboarding; a fresh one with it is still the lock; a replaced sponsor is never told 'again'", async () => {
  const base = { version: 1, status: 'pending', sendCount: 0, sends: [], sponsor: { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') } };
  const members = [{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }];
  await withFakeIo(async ({ calls }) => {
    const r = await onboard();
    assert.equal(r.sent, true); assert.equal(r.variant, 'onboarding');
    assert.match(calls.find((c) => c[0] === 'sendEmail')[2], /^Action Required/);
    assert.doesNotMatch(calls.find((c) => c[0] === 'postNote')[2], /earlier send/);
  }, { marker: { ...base, startedAt: '2026-09-24T14:40:00Z' }, members });
  await withFakeIo(async ({ names }) => {
    const r = await onboard();
    assert.equal(r.sent, false); assert.equal(r.reason, 'in-progress');
    assert.ok(!names().includes('sendEmail'));
  }, { marker: { ...base, startedAt: '2026-09-24T14:58:00Z', attemptedAt: '2026-09-24T14:58:00Z' }, members });
  await withFakeIo(async ({ calls }) => {
    const r = await onboard();
    assert.equal(r.sent, true); assert.equal(r.variant, 'onboarding', 'the stale attempt went to someone else');
    assert.match(calls.find((c) => c[0] === 'sendEmail')[2], /^Action Required/);
  }, { marker: { ...base, startedAt: '2026-09-24T14:40:00Z', attemptedAt: '2026-09-24T14:40:00Z', sponsor: { name: 'Rahim', emailMasked: 'r***@example.com', emailKey: S.emailKeyOf('rahim@example.com') } }, members });
  // the planner, once per rule
  const NOW = Date.parse('2026-09-24T15:00:00Z');
  const sponsor = { status: 'ok', name: 'Faheem Khan', sectionMode: 'section', role: 'Sponsor', boardMemberType: 'Sponsor', memberKey: 'sponsor', manifestType: 'Sponsor', sponsorIsSpouse: true, emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') };
  const plan = (marker, mode = 'onboard') => S.planEnsure({ sponsor, composition: { members }, manifest: null, marker, mode, now: NOW, gates: { ok: true, reason: null } });
  const stale = { status: 'pending', startedAt: '2026-09-24T14:40:00Z', attemptedAt: '2026-09-24T14:40:00Z', sendCount: 0 };
  assert.deepEqual([plan(stale).send, plan(stale).variant, plan(stale).maybeDelivered], [true, 'resend', true]);
  assert.deepEqual([plan({ ...stale, attemptedAt: undefined }).variant, plan({ ...stale, attemptedAt: undefined }).maybeDelivered], ['onboarding', false]);
  assert.equal(plan({ ...stale, startedAt: '2026-09-24T14:58:00Z' }).skipReason, 'in-progress');
  assert.deepEqual([plan(stale, 'staff').send, plan(stale, 'staff').variant], [true, 'resend']);
  const failedAfter = { status: 'failed', error: 'Graph 503', startedAt: '2026-09-24T14:50:00Z', attemptedAt: '2026-09-24T14:40:00Z', sendCount: 0 };
  assert.equal(plan(failedAfter).variant, 'resend', 'a resend that failed keeps the earlier attempt on record');
  assert.equal(plan({ status: 'failed', error: 'Graph 503', startedAt: '2026-09-24T14:50:00Z', sendCount: 0 }).variant, 'onboarding', 'a first send that failed outright is retried as onboarding');
});
