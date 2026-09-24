'use strict';

// Sponsor onboarding — planEnsure + existingPartner are PURE: what one pass
// should create and whether it should send, from the board, the manifest, the
// marker, the mode and the gates.

const test   = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/services/sponsorOnboardingService');

const NOW = Date.parse('2026-09-24T15:00:00Z');
const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();

// resolveSponsor 'ok' shapes for the three placements
const SOWP_OUTLAND = { status: 'ok', name: 'Faheem Khan', email: 'faheem@example.com', emailMasked: 'f***@example.com', role: 'Sponsor', roleLabel: 'Worker Spouse', sectionMode: 'section', boardMemberType: 'Sponsor', memberKey: 'sponsor', manifestType: 'Sponsor', sponsorIsSpouse: true, docs: [] };
const SOWP_INLAND  = { ...SOWP_OUTLAND, role: 'Spouse', boardMemberType: 'Spouse', memberKey: 'spouse', manifestType: 'Spouse / Common-Law Partner' };
const SUPERVISA    = { ...SOWP_OUTLAND, roleLabel: 'Sponsor / Inviter (in Canada)', sectionMode: 'documents-only', sponsorIsSpouse: false };
const SPOUSAL_F10  = { ...SOWP_OUTLAND, roleLabel: 'Sponsor (Canadian/PR Spouse)', sectionMode: 'shared-form' };

const GATES_OK = { ok: true, reason: null };
const GATES_NO = { ok: false, reason: 'not-started' };
const PRIMARY  = [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }];
const comp = (...members) => ({ caseFlags: {}, members });
const plan = (over = {}) => S.planEnsure({ sponsor: SOWP_OUTLAND, composition: comp(), manifest: null, marker: null, mode: 'onboard', now: NOW, gates: GATES_OK, ...over });

// ─── existingPartner (D5) ─────────────────────────────────────────────────────

test('existingPartner: a row of the sponsor role, or the legacy Worker Spouse type, IS the sponsor', () => {
  const sp = { role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor' };
  assert.equal(S.existingPartner(SOWP_OUTLAND, comp(sp)), sp);
  const ws = { role: 'WorkerSpouse', name: 'Faheem', memberKey: 'worker-spouse' };
  assert.equal(S.existingPartner(SOWP_OUTLAND, comp(ws)), ws);
  assert.equal(S.existingPartner(SOWP_OUTLAND, comp()), null);
  assert.equal(S.existingPartner(SOWP_OUTLAND, null), null);
});

test('existingPartner: the intake Spouse row is the sponsor ONLY when the sponsor is the spouse', () => {
  const spouse = { role: 'Spouse', name: 'Spouse (from intake)', memberKey: 'spouse' };
  assert.equal(S.existingPartner(SOWP_OUTLAND, comp(spouse)), spouse, 'SOWP Outland "Worker Spouse" is the spouse');
  assert.equal(S.existingPartner(SUPERVISA, comp(spouse)), null, 'on a Supervisa the Spouse row is the applicant\'s spouse');
});

test('existingPartner is symmetric for a spouse-type sponsor: a Sponsor row is the same person when the schema role is Spouse (Sub Type corrected Outland → Inland)', () => {
  const sponsorRow = { role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor' };
  assert.equal(S.existingPartner(SOWP_INLAND, comp(sponsorRow)), sponsorRow);
  const p = plan({ sponsor: SOWP_INLAND, composition: comp(sponsorRow) });
  assert.equal(p.createRow, false, 'no second row for the same person');
  assert.equal(p.sectionLabel, 'Faheem Khan');
  assert.equal(p.badge, 'Sponsor', 'the badge is the one the existing section carries');
  assert.equal(S.existingPartner({ ...SUPERVISA, role: 'Spouse' }, comp(sponsorRow)), null, 'a non-spouse Spouse-role sponsor still ignores a Sponsor row');
});

// ─── createRow / addMember ────────────────────────────────────────────────────

test('createRow: only in section mode and only when no row already represents the sponsor', () => {
  assert.equal(plan().createRow, true);
  assert.equal(plan({ composition: comp({ role: 'Sponsor', name: 'Faheem Khan' }) }).createRow, false, 'Sponsor row present');
  assert.equal(plan({ composition: comp({ role: 'WorkerSpouse', name: 'Faheem Khan' }) }).createRow, false, 'WorkerSpouse row present');
  assert.equal(plan({ composition: comp({ role: 'Spouse', name: 'Spouse (from intake)' }) }).createRow, false, 'the intake Spouse row on SOWP Outland');
  assert.equal(plan({ sponsor: SUPERVISA, composition: comp({ role: 'Spouse', name: 'Spouse (from intake)' }) }).createRow, false, 'documents-only: never a row');
  assert.equal(plan({ sponsor: { ...SUPERVISA, sectionMode: 'section' }, composition: comp({ role: 'Spouse', name: 'Spouse (from intake)' }) }).createRow, true, 'a non-spouse sponsor ignores the Spouse row');
  assert.equal(plan({ sponsor: SPOUSAL_F10 }).createRow, false, 'shared-form: never a row');
});

test('shared-form and documents-only never create a row or a member, whatever the manifest', () => {
  for (const sponsor of [SPOUSAL_F10, SUPERVISA]) {
    for (const manifest of [null, PRIMARY]) {
      const p = plan({ sponsor, manifest });
      assert.equal(p.createRow, false);
      assert.equal(p.addMember, false);
      assert.equal(p.send, true, 'the email still goes');
    }
  }
});

test('addMember: only when the manifest FILE exists and has no sponsor section yet', () => {
  assert.equal(plan({ manifest: null }).addMember, false, 'no file → seeded from the board later, row and all');
  assert.equal(plan({ manifest: PRIMARY }).addMember, true, 'primary-only');
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'sponsor', type: 'Sponsor', label: 'Faheem Khan' }] }).addMember, false);
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'worker-spouse', type: 'Worker Spouse', label: 'Faheem' }] }).addMember, false);
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Faheem Khan' }] }).addMember, false, 'a spouse-type sponsor already has the Spouse section');
  assert.equal(plan({ sponsor: { ...SUPERVISA, sectionMode: 'section' }, manifest: [...PRIMARY, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Wife' }] }).addMember, true, 'a non-spouse sponsor: the Spouse section is someone else');
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'child-1', type: 'Dependent Child', label: 'Child' }] }).addMember, true);
});

// ─── sectionLabel ─────────────────────────────────────────────────────────────

test('sectionLabel: the manifest member wins, then the board row name, then the sponsor name; "Spouse (from intake)" reads "Spouse"', () => {
  assert.equal(plan().sectionLabel, 'Faheem Khan');
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Faheem K.' }] }).sectionLabel, 'Faheem K.');
  assert.equal(plan({ composition: comp({ role: 'Spouse', name: 'Faheem Khan Sr' }) }).sectionLabel, 'Faheem Khan Sr');
  assert.equal(plan({ composition: comp({ role: 'Spouse', name: 'Spouse (from intake)' }) }).sectionLabel, 'Spouse');
  assert.equal(plan({ composition: comp({ role: 'Sponsor', name: '' }) }).sectionLabel, 'Sponsor');
  assert.equal(plan({ composition: comp({ role: 'WorkerSpouse', name: '' }) }).sectionLabel, 'Worker Spouse');
});

// ─── badge (what the section is marked on the questionnaire page) ────────────

test('badge: the manifest member\'s type, else the board row that is the sponsor, else the sponsor\'s own type — the engine prints the first word of the type', () => {
  assert.equal(plan().badge, 'Sponsor');
  assert.equal(plan({ sponsor: SOWP_INLAND }).badge, 'Spouse');
  assert.equal(plan({ composition: comp({ role: 'Spouse', name: 'Spouse (from intake)' }) }).badge, 'Spouse', 'D5 on SOWP Outland: the intake Spouse row seeds a "Spouse" section — never "Sponsor"');
  assert.equal(plan({ composition: comp({ role: 'WorkerSpouse', name: 'Faheem' }) }).badge, 'Worker Spouse');
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Faheem K.' }] }).badge, 'Spouse');
  assert.equal(plan({ manifest: [...PRIMARY, { key: 'worker-spouse', type: 'Worker Spouse', label: 'Faheem' }] }).badge, 'Worker Spouse');
  assert.equal(plan({ sponsor: SOWP_INLAND, manifest: [...PRIMARY, { key: 'sponsor', type: 'Sponsor', label: 'Faheem Khan' }] }).badge, 'Sponsor');
  assert.equal(S.badgeFor(SOWP_OUTLAND, comp(), null), 'Sponsor');
});

// ─── send ─────────────────────────────────────────────────────────────────────

test("'prepare' never sends, whatever the marker or the gates", () => {
  for (const marker of [null, { status: 'failed' }, { status: 'sent' }]) {
    const p = plan({ mode: 'prepare', marker, gates: GATES_OK });
    assert.equal(p.send, false);
    assert.equal(p.skipReason, 'prepare');
  }
});

test("'onboard': sends once — marker absent or failed; never when 'sent'", () => {
  assert.equal(plan({ marker: null }).send, true);
  assert.equal(plan({ marker: { status: 'failed', error: 'Graph 503' } }).send, true);
  const sent = plan({ marker: { status: 'sent', sentAt: minutesAgo(60) } });
  assert.equal(sent.send, false);
  assert.equal(sent.skipReason, 'already-sent');
  assert.equal(plan().variant, 'onboarding');
});

test("'staff': marker sent → sends again (variant resend), even when the gates no longer hold", () => {
  const p = plan({ mode: 'staff', marker: { status: 'sent', sentAt: minutesAgo(60) }, gates: GATES_NO });
  assert.equal(p.send, true);
  assert.equal(p.variant, 'resend');
  const first = plan({ mode: 'staff', marker: null, gates: GATES_OK });
  assert.equal(first.send, true);
  assert.equal(first.variant, 'onboarding');
});

test("a 'pending' marker is a lock for 10 minutes: 3 min → no send ('in-progress'); 15 min → the crashed send is retried", () => {
  for (const mode of ['onboard', 'staff']) {
    const fresh = plan({ mode, marker: { status: 'pending', startedAt: minutesAgo(3) } });
    assert.equal(fresh.send, false);
    assert.equal(fresh.skipReason, 'in-progress');
    assert.equal(plan({ mode, marker: { status: 'pending', startedAt: minutesAgo(15) } }).send, true);
  }
  const unparseable = plan({ marker: { status: 'pending', startedAt: 'not a date' } });
  assert.equal(unparseable.send, false, 'an unreadable start time is treated as fresh — fail closed');
});

test("gates.ok false → no send, with the gate reason; 'staff' still plans the row and the member (Add sponsor now), 'onboard' plans nothing", () => {
  const st = plan({ mode: 'staff', manifest: PRIMARY, gates: GATES_NO });
  assert.equal(st.send, false); assert.equal(st.skipReason, 'not-started');
  assert.equal(st.createRow, true); assert.equal(st.addMember, true);
  const ob = plan({ mode: 'onboard', manifest: PRIMARY, gates: GATES_NO });
  assert.equal(ob.send, false); assert.equal(ob.skipReason, 'not-started');
  assert.equal(ob.createRow, false, 'the automatic path creates the row only on the pass that sends — before payment that is prepare, after the intake rows');
  assert.equal(ob.addMember, false);
  assert.equal(plan({ mode: 'onboard', manifest: PRIMARY, gates: { ok: false, reason: 'already-onboarded' } }).createRow, false, 'a Sub Type edit on an old case grows nothing');
  assert.equal(plan({ mode: 'onboard', manifest: PRIMARY, marker: { status: 'sent' } }).createRow, false);
  assert.equal(plan({ mode: 'onboard', manifest: PRIMARY, marker: { status: 'pending', startedAt: minutesAgo(3) } }).createRow, false);
  const sending = plan({ mode: 'onboard', manifest: PRIMARY });
  assert.equal(sending.send, true); assert.equal(sending.createRow, true); assert.equal(sending.addMember, true);
  const prep = plan({ mode: 'prepare', manifest: PRIMARY, gates: GATES_NO });
  assert.equal(prep.createRow, true); assert.equal(prep.addMember, true);
});

test("a FAILED resend keeps the sponsor's history: sendCount > 0 → variant resend; 'staff' resends at any stage; 'onboard' never re-sends", () => {
  const failedResend = { status: 'failed', error: 'Graph 503', sendCount: 1, sends: [{ variant: 'onboarding', at: minutesAgo(60) }] };
  const st = plan({ mode: 'staff', marker: failedResend, gates: GATES_NO });
  assert.equal(st.send, true); assert.equal(st.variant, 'resend');
  const ob = plan({ mode: 'onboard', marker: failedResend });
  assert.equal(ob.send, false); assert.equal(ob.skipReason, 'already-sent');
  const failedFirst = plan({ mode: 'onboard', marker: { status: 'failed', error: 'Graph 503', sendCount: 0, sends: [] } });
  assert.equal(failedFirst.send, true); assert.equal(failedFirst.variant, 'onboarding', 'a first send that failed is retried as onboarding');
});

test('an unknown mode never sends', () => {
  const p = plan({ mode: 'yolo' });
  assert.equal(p.send, false);
  assert.equal(p.skipReason, 'bad-mode');
});

test('the SOWP inland sponsor plans a Spouse row with the spouse key', () => {
  const p = plan({ sponsor: SOWP_INLAND });
  assert.equal(p.createRow, true);
  assert.equal(SOWP_INLAND.boardMemberType, 'Spouse');
  assert.equal(SOWP_INLAND.memberKey, 'spouse');
  assert.equal(plan({ sponsor: SOWP_INLAND, composition: comp({ role: 'Spouse', name: 'Spouse (from intake)' }) }).createRow, false);
});

// ─── addressChanged (the sponsor replaced after a send) ───────────────────────

test('addressChanged: the marker\'s sends went to someone else — by fingerprint when the marker has one, by mask otherwise; never for the same person', () => {
  const sp = { ...SOWP_OUTLAND, emailKey: S.emailKeyOf('faheem@example.com') };
  assert.equal(S.addressChanged(sp, null), false);
  assert.equal(S.addressChanged(sp, { status: 'sent' }), false, 'no sponsor recorded (an old marker) → not a change');
  assert.equal(S.addressChanged(sp, { sponsor: { emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('Faheem@Example.com') } }), false, 'case-insensitive');
  assert.equal(S.addressChanged(sp, { sponsor: { emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('farah@example.com') } }), true, 'same mask, different address');
  assert.equal(S.addressChanged(sp, { sponsor: { emailMasked: 'f***@example.com' } }), false, 'legacy marker, same mask');
  assert.equal(S.addressChanged(sp, { sponsor: { emailMasked: 'r***@example.com' } }), true, 'legacy marker, different mask');
  assert.equal(S.emailKeyOf('faheem@example.com').length, 16);
  assert.ok(!S.emailKeyOf('faheem@example.com').includes('faheem'));
});

test('a replaced sponsor: the marker\'s history is not theirs — variant onboarding, and the automatic path may send once; the pending lock still holds', () => {
  const sp = { ...SOWP_OUTLAND, emailKey: S.emailKeyOf('rahim@example.com') };
  const sentToOther = { status: 'sent', sentAt: minutesAgo(60), sendCount: 1, sponsor: { name: 'Faheem Khan', emailMasked: 'f***@example.com', emailKey: S.emailKeyOf('faheem@example.com') } };
  const ob = plan({ sponsor: sp, marker: sentToOther });
  assert.equal(ob.send, true); assert.equal(ob.variant, 'onboarding'); assert.equal(ob.replaced, true);
  const st = plan({ sponsor: sp, marker: sentToOther, mode: 'staff', gates: GATES_NO });
  assert.equal(st.send, false, 'a FIRST send to the new person needs the gates like any first send'); assert.equal(st.skipReason, 'not-started');
  assert.equal(plan({ sponsor: sp, marker: sentToOther, mode: 'staff', gates: GATES_OK }).variant, 'onboarding');
  const pending = plan({ sponsor: sp, marker: { ...sentToOther, status: 'pending', startedAt: minutesAgo(3) } });
  assert.equal(pending.send, false); assert.equal(pending.skipReason, 'in-progress');
  assert.equal(plan({ marker: sentToOther, sponsor: { ...SOWP_OUTLAND, emailKey: S.emailKeyOf('faheem@example.com') } }).replaced, false);
});

// ─── createOnly (Add sponsor now / Save sponsor) ──────────────────────────────

test('createOnly: never a send — not with the gates open, not as a resend — but the row and the member are still planned', () => {
  const p = plan({ mode: 'staff', manifest: PRIMARY, gates: GATES_OK, createOnly: true });
  assert.equal(p.send, false); assert.equal(p.skipReason, 'create-only');
  assert.equal(p.createRow, true); assert.equal(p.addMember, true);
  const re = plan({ mode: 'staff', marker: { status: 'sent', sentAt: minutesAgo(60), sendCount: 1 }, gates: GATES_OK, createOnly: true });
  assert.equal(re.send, false); assert.equal(re.skipReason, 'create-only');
  assert.equal(plan({ mode: 'prepare', createOnly: true }).skipReason, 'prepare', "'prepare' keeps its own reason");
  assert.equal(plan({ mode: 'staff', marker: { status: 'pending', startedAt: minutesAgo(3) }, createOnly: true }).skipReason, 'in-progress', 'the lock is reported first');
});
