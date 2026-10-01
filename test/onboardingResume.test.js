'use strict';

// Held-onboarding resume (Fix 1, 2026-09-30): a case set to "Paid" by hand
// before the agreement was fully signed is HELD; when the last signature lands
// on it, onboarding must start exactly once — and never for a case that shows
// any sign it was already onboarded (the intake email cannot be recalled).
// Every side effect goes through R.io, replaced wholesale per test.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const R = require('../src/services/onboardingResumeService');

const D = '2026-09-29';
const ITEM = '13119556000';
const rc = (o) => JSON.stringify(o);
// Mehak-shaped lead: signed via Documenso + paid; countersign pending unless given.
const lead = (over = {}) => ({ id: '13119556872', fullName: 'Mehak', clientMasterItemId: ITEM, retainerSigned: D, retainerPaid: D,
  retainerCountersign: rc({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', envelopeId: 'rc1', sentAt: D, ...(over.rc || {}) }), ...over });
const countersigned = (over = {}) => lead({ ...over, rc: { signedAt: '2026-09-30' } });
const cm = (over = {}) => ({ paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'No', caseRef: '2026-SV-021', clientEmail: 'mehak@example.com', ...over });
// The two real hold notes, as posted (retainerService.js / mondayWebhook.js).
const HOLD_PAID = { id: '1', created_at: '2026-09-29T20:01:10Z', body: '⛔ <b>Payment marked, but onboarding is on hold</b> — missing: RCIC countersignature. The document checklist…', text_body: '⛔ Payment marked, but onboarding is on hold — missing: RCIC countersignature. The document checklist…' };
const HOLD_DCS  = { id: '2', created_at: '2026-09-29T20:01:12Z', body: '⛔ <b>Onboarding deferred:</b> missing RCIC countersignature. The intake email and checklist start automatically…', text_body: '⛔ Onboarding deferred: missing RCIC countersignature. The intake email and checklist start automatically…' };
const note = (text, at = '2026-09-29T21:00:00Z', id = String(Math.random())) => ({ id, created_at: at, body: text, text_body: text.replace(/<[^>]+>/g, '') });
const HELD_AT = Date.parse(HOLD_DCS.created_at);

const NOW = Date.parse('2026-09-30T12:00:00Z');
const decide = (over = {}) => R.decide({ cm: cm(), updates: [HOLD_PAID, HOLD_DCS], claimants: [countersigned()], rows: 0, changes: [], now: NOW, ...over });

/* ─────────────────────────────── decide ─────────────────────────────── */

test('Mehak after the countersign: held, fully signed, no trace of onboarding → resume', () => {
  assert.deepEqual(decide(), { action: 'resume' });
});

test('Mehak today (countersign pending) → waiting, silently', () => {
  const v = decide({ claimants: [lead()] });
  assert.equal(v.action, 'none');
  assert.equal(v.code, 'waiting');
  assert.match(v.detail, /RCIC countersignature/);
});

test('reads are asked for lazily, cheapest decision first', () => {
  assert.deepEqual(R.decide({ cm: cm() }), { action: 'need', what: 'updates' });
  assert.deepEqual(R.decide({ cm: cm(), updates: [HOLD_PAID] }), { action: 'need', what: 'claimants' });
  assert.deepEqual(R.decide({ cm: cm(), updates: [HOLD_PAID], claimants: [countersigned()] }), { action: 'need', what: 'rows' });
  const v = R.decide({ cm: cm(), updates: [HOLD_PAID, HOLD_DCS], claimants: [countersigned()], rows: 0 });
  assert.equal(v.action, 'need');
  assert.equal(v.what, 'changes');
  assert.equal(v.since, HELD_AT, 'history is read from the NEWEST hold note');
  // not Paid / gone: nothing read at all
  assert.equal(R.decide({ cm: cm({ paymentStatus: 'Signed (Unpaid)' }) }).code, 'not-paid');
  assert.equal(R.decide({ cm: null }).code, 'no-case');
});

test('a case that was never held is never touched (Anita, Kulwant, Purshotam, Aquib, Amrit; the benign second-trigger race)', () => {
  // box reset to "No" by the board automation, rows exist — but no hold note
  assert.equal(decide({ updates: [note('7 questionnaire fields were pre-filled from the client\'s intake')] }).code, 'not-held');
  // LMIA: box No, 0 rows, no notes at all
  assert.equal(decide({ updates: [] }).code, 'not-held');
  // the "not Paid" deferral is NOT a signature hold
  assert.equal(decide({ updates: [note('⏸ <b>Onboarding deferred:</b> this case was moved to Document Collection Started, but Payment Status is not "Paid".')] }).code, 'not-held');
  // lead-side notes are on the lead, and don't match either
  assert.equal(decide({ updates: [note('💵 <b>Retainer payment recorded.</b> Onboarding is on hold until the RCIC countersignature is in')] }).code, 'not-held');
});

test('at most one automatic start per case, ever', () => {
  const started = note(R.RESUMED_NOTE, '2026-09-30T10:00:00Z');
  const sent = note('✉️ <b>Intake email sent</b> ("Your case is ready") to m***@example.com.', '2026-09-30T10:00:05Z');
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, started, sent] }).code, 'already-resumed');
  // outcome not noted yet, but the start is recent: pending (never memoised by the sync)
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, started], now: Date.parse('2026-09-30T10:20:00Z') }).code, 'resume-pending');
});

test('a start whose email outcome was never noted (restart / outage mid-start) is reported once after 30 min — never re-sent', () => {
  const started = note(R.RESUMED_NOTE, '2026-09-30T10:00:00Z');
  const v = decide({ updates: [HOLD_PAID, HOLD_DCS, started], now: Date.parse('2026-09-30T10:31:00Z') });
  assert.equal(v.action, 'report');
  assert.equal(v.code, 'unconfirmed');
  assert.equal(v.quiet, false);
  const reported = note(R.reportNote('unconfirmed'), '2026-09-30T10:31:30Z');
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, started, reported], now: Date.parse('2026-09-30T11:00:00Z') }).quiet, true);
  // the failure note counts as an outcome too
  const failed = note('⚠️ <b>The client\'s intake email did not go out</b> (graph down).', '2026-09-30T10:00:09Z');
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, started, failed], now: Date.parse('2026-09-30T11:00:00Z') }).code, 'already-resumed');
});

test('after a "not restarted — it already ran another way" note, a held case is never started automatically (until a newer hold)', () => {
  const finalNote = note(R.reportNote('changed'), '2026-09-30T09:00:00Z');
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, finalNote] }).code, 'reported');
  const newerHold = { ...HOLD_DCS, id: '9', created_at: '2026-09-30T11:00:00Z' };
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, finalNote, newerHold] }).action, 'resume');
  // an ACTION report (something to fix first) is not final
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, note(R.reportNote('no-email'), '2026-09-30T09:00:00Z')] }).action, 'resume');
});

test('no linked lead (legacy/manual case) is never cold-started', () => {
  assert.equal(decide({ claimants: [] }).code, 'no-lead');
});

test('shared case: one fully executed claimant is enough', () => {
  assert.equal(decide({ claimants: [lead({ id: 'a' }), countersigned({ id: 'b' })] }).action, 'resume');
  assert.equal(decide({ claimants: [lead({ id: 'a' }), lead({ id: 'b' })] }).code, 'waiting');
});

test('paper signing (no envelope chain) held for the client signature, then signed → resume', () => {
  const paper = { id: 'p1', clientMasterItemId: ITEM, retainerSigned: D, retainerPaid: D };
  assert.equal(decide({ claimants: [paper] }).action, 'resume');
  // board Paid but the lead not back-stamped yet: the board IS the payment record
  assert.equal(decide({ claimants: [{ ...paper, retainerPaid: '' }] }).action, 'resume');
});

test('any sign onboarding already ran → a staff note, never an email', () => {
  const ev = (over) => decide(over);
  assert.equal(ev({ cm: cm({ applied: 'Yes' }) }).code, 'evidence');                      // Kapil after his toggle
  // Stage Start Date: written only by the app, only when onboarding goes ahead (never on a hold) —
  // Amrit (LMIA, no rows, box No) has one from 09-22; Mehak (held) has none
  assert.equal(ev({ cm: cm({ stageStart: '2026-09-22' }) }).code, 'evidence');
  assert.equal(ev({ rows: 3 }).code, 'evidence');                                        // checklist rows exist
  for (const text of [
    '7 questionnaire fields were pre-filled from the client\'s intake & pre-consult answers.',
    '1 questionnaire field were pre-filled from the client\'s intake',
    '✅ <b>Document checklist created</b> (variant: Parents).',
    '⚠️ <b>Document checklist auto-seed FAILED</b> for 2026-SV-021 after 2 attempts',
    '✅ <b>Checklist re-seed complete</b> for 2026-SV-021',
    '⚠ <b>Re-seed failed:</b> no schema.',
    '⚠️ <b>Family members not covered by this checklist.</b>',
    '<span style="display:none">checklist-blocked-no-subtype</span> Choose the Sub Type',
    '<span style="display:none">checklist-blocked-wrong-subtype:oinp:x;</span> Wrong Sub Type',
    'Intake email resent — client email address was corrected.',
  ]) {
    const v = ev({ updates: [HOLD_PAID, HOLD_DCS, note(text)] });
    assert.equal(v.action, 'report', text);
    assert.equal(v.code, 'evidence', text);
  }
});

test('a portal-link resend is NOT the intake email and does not block the start', () => {
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, note('✉️ Portal access email re-sent to m***@example.com')] }).action, 'resume');
});

test('stage moved off Document Collection, no case ref, no client email → reported with the fix', () => {
  assert.deepEqual([decide({ cm: cm({ stage: 'Pre-Onboarding' }) }).code, decide({ cm: cm({ stage: 'Pre-Onboarding' }) }).detail], ['stage', 'Pre-Onboarding']);
  assert.equal(decide({ cm: cm({ stage: '' }) }).code, 'stage');
  // moved ON (staff worked the case): never told to move it back to Document Collection
  for (const st of ['Internal Review', 'Submission Preparation', 'Application Submitted', 'Closed']) {
    const v = decide({ cm: cm({ stage: st }) });
    assert.equal(v.code, 'moved-on', st);
    assert.doesNotMatch(R.reportNote(v.code, v.detail), /set the Case Stage to/);
  }
  assert.equal(decide({ cm: cm({ caseRef: '' }) }).code, 'no-case-ref');
  assert.equal(decide({ cm: cm({ clientEmail: '' }) }).code, 'no-email');
});

test('unreadable rows / history: no start and no note (the sync tries again)', () => {
  assert.equal(decide({ rows: null }).code, 'unreadable');
  assert.equal(decide({ changes: null }).code, 'unreadable');
});

test('waiting carries whether the case shows signs it was onboarded (the email-change path needs it)', () => {
  assert.equal(decide({ claimants: [lead()] }).evidence, false);
  assert.equal(decide({ claimants: [lead()], cm: cm({ stageStart: '2026-09-22' }) }).evidence, true, 'Anita-type: onboarded, box reset, clock set');
  assert.equal(decide({ claimants: [lead()], cm: cm({ applied: 'Yes' }) }).evidence, true);
  assert.equal(decide({ claimants: [lead()], updates: [HOLD_PAID, HOLD_DCS, note('8 questionnaire fields were pre-filled')] }).evidence, true);
});

test('after the hold, a staff Paid flip or stage move means "can\'t tell" → report; the automation\'s own stage move does not', () => {
  const after = HELD_AT + 60000;
  const PAY = 'color_mm0x9fnn', STAGE = 'color_mm0x8faa';
  assert.equal(decide({ changes: [{ column: PAY, userId: '79975533', at: after }] }).code, 'changed');
  assert.equal(decide({ changes: [{ column: STAGE, userId: '79975533', at: after }] }).code, 'changed');
  assert.equal(decide({ changes: [{ column: STAGE, userId: '-4', at: after }] }).action, 'resume');
  // 2026-10-02: the app itself writes stage + flags right BEFORE posting the hold note. Monday times a
  // note to the second and a change to the millisecond, so a change inside the note's own second is the
  // hold's own setup — never a person's action.
  assert.equal(decide({ changes: [{ column: STAGE, userId: '98668063', at: HELD_AT + 800 }] }).action, 'resume');
  assert.equal(decide({ changes: [{ column: STAGE, userId: '98668063', at: HELD_AT + 999 }] }).action, 'resume');
  assert.equal(decide({ changes: [{ column: STAGE, userId: '98668063', at: HELD_AT + 1000 }] }).code, 'changed');
  // changes at or before the newest hold were themselves held again (Mehak: her Paid flip precedes both notes)
  assert.equal(decide({ changes: [{ column: PAY, userId: '79975533', at: HELD_AT - 5000 }] }).action, 'resume');
  // every path reads the history — including the last signature (a start made in the countersign
  // window, or one that went ahead on an unreadable signature check, leaves no newer hold)
  assert.deepEqual([decide({ changes: undefined }).action, decide({ changes: undefined }).what], ['need', 'changes']);
});

test('a report is posted once per hold: quiet when one is already on the case', () => {
  const reported = note(R.reportNote('stage', 'Pre-Onboarding'), '2026-09-30T09:00:00Z');
  assert.equal(decide({ cm: cm({ stage: 'Pre-Onboarding' }) }).quiet, false);
  assert.equal(decide({ cm: cm({ stage: 'Pre-Onboarding' }), updates: [HOLD_PAID, HOLD_DCS, reported] }).quiet, true);
  // a NEWER hold re-arms the report
  const newerHold = { ...HOLD_DCS, id: '9', created_at: '2026-09-30T12:00:00Z' };
  assert.equal(decide({ cm: cm({ stage: 'Pre-Onboarding' }), updates: [HOLD_PAID, HOLD_DCS, reported, newerHold] }).quiet, false);
});

test('the hold patterns match the notes the code actually posts (source pins)', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const paidNote = src('services/retainerService.js').match(/⛔ <b>Payment marked, but onboarding is on hold<\/b>[^`]*/);
  const dcsNote  = src('routes/mondayWebhook.js').match(/⛔ <b>Onboarding deferred:<\/b> missing[^`]*/);
  assert.ok(paidNote && dcsNote, 'both hold notes still exist in the code');
  for (const t of [paidNote[0], dcsNote[0]]) {
    const strip = t.replace(/<[^>]+>/g, '');
    assert.ok(R.HELD_PATTERNS.some((re) => re.test(strip)), `pattern matches: ${strip.slice(0, 60)}`);
  }
  // the "not Paid" deferral in the same file must NOT match
  const notPaid = src('routes/mondayWebhook.js').match(/⏸ <b>Onboarding deferred:<\/b> this case[^']*/);
  assert.ok(notPaid);
  assert.ok(!R.HELD_PATTERNS.some((re) => re.test(notPaid[0].replace(/<[^>]+>/g, ''))));
  // the evidence phrases still exist where the code posts them
  assert.match(src('services/htmlQuestionnaireService.js'), /questionnaire field\$\{count === 1 \? '' : 's'\} were pre-filled/);
  assert.match(src('services/checklistService.js'), /Document checklist created<\/b>/);
  assert.match(src('services/checklistService.js'), /Document checklist auto-seed FAILED<\/b>/);
  assert.match(src('services/reseedButtonService.js'), /Checklist re-seed complete<\/b>/);
  assert.match(src('services/emailService.js'), /Intake email resent — /);
});

/* ─────────────────────────── the start itself ─────────────────────────── */

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function withFakeIo(fn, { store: s0 = {}, ...hooks } = {}) {
  const real = { ...R.io };
  const saved = process.env.ONBOARDING_RESUME;
  R._resetForTests();
  const store = { cm: cm(), updates: [HOLD_PAID, HOLD_DCS], claimants: [countersigned()], rows: 0, changes: [], ...s0 };
  const calls = [];
  const log = (name, ...a) => calls.push([name, ...a]);
  Object.assign(R.io, {
    readCase: async (id) => { log('readCase', id); const n = calls.filter((c) => c[0] === 'readCase').length; return hooks.caseOnRecheck && n > 1 ? hooks.caseOnRecheck : store.cm && { ...store.cm }; },
    readUpdates: async (id) => { log('readUpdates', id); return [...store.updates]; },
    findClaimants: async (id) => { log('findClaimants', id); return store.claimants; },
    countRows: async (ref) => { log('countRows', ref); if (hooks.rowsThrow) throw new Error('rows down'); return store.rows; },
    readChanges: async (id, since) => { log('readChanges', id, since); return store.changes; },
    postNote: async (id, body) => {
      log('postNote', id, body);
      if (hooks.noteLandsThenThrows) { store.updates.push(note(body, '2026-09-30T12:00:00Z')); hooks.noteLandsThenThrows = false; throw new Error('429'); }
      if (hooks.noteThrows) throw new Error('note failed');
      store.updates.push(note(body, '2026-09-30T12:00:00Z'));
      return 'u1';
    },
    writeCols: async (id, cols) => { log('writeCols', id, cols); },
    sendIntakeEmail: async (id) => { log('sendIntakeEmail', id); if (hooks.emailThrows) throw new Error('graph down'); return hooks.emailResult || { sent: true, to: 'mehak@example.com' }; },
    ensureSponsor: async (args) => { log('ensureSponsor', args); },
    seedChecklist: async (id) => { log('seedChecklist', id); },
  });
  if ('switch' in hooks) process.env.ONBOARDING_RESUME = hooks.switch; else delete process.env.ONBOARDING_RESUME;
  return Promise.resolve(fn({ store, calls, names: () => calls.map((c) => c[0]), notes: () => calls.filter((c) => c[0] === 'postNote').map((c) => c[2]) }))
    .finally(() => { Object.assign(R.io, real); if (saved === undefined) delete process.env.ONBOARDING_RESUME; else process.env.ONBOARDING_RESUME = saved; R._resetForTests(); });
}

test('start: the record note FIRST, then the chasing restart, then email + sponsor + checklist — never payment, date or stage', () =>
  withFakeIo(async ({ calls, names, notes }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    await flush();
    assert.equal(r.action, 'resumed');
    const n = names();
    assert.ok(n.indexOf('postNote') < n.indexOf('writeCols'), 'record before any write');
    assert.ok(n.indexOf('writeCols') < n.indexOf('sendIntakeEmail'), 'chasing restart before the email (as onRetainerPaid)');
    assert.deepEqual(n.filter((x) => ['sendIntakeEmail', 'ensureSponsor', 'seedChecklist'].includes(x)).sort(), ['ensureSponsor', 'seedChecklist', 'sendIntakeEmail']);
    assert.ok(n.indexOf('readChanges') < n.indexOf('postNote'), 'the history is read before anything is written');
    assert.match(notes()[0], /Onboarding started automatically/);
    assert.equal(notes().length, 2);
    assert.match(notes()[1], /Intake email sent<\/b> \("Your case is ready"\) to m\*\*\*@example\.com/, 'the outcome is noted (masked address)');
    const cols = calls.find((c) => c[0] === 'writeCols')[2];
    assert.deepEqual(Object.keys(cols).sort(), ['color_mm1abve4', 'date_mm0xjm1z', 'numeric_mm1a4e8r']);
    for (const forbidden of ['color_mm0x9fnn', 'date_mm0xgk76', 'color_mm0x8faa']) assert.ok(!(forbidden in cols));
    assert.deepEqual(calls.find((c) => c[0] === 'ensureSponsor')[1], { itemId: ITEM, mode: 'onboard', trigger: 'signature-resume' });
  }));

test('start: a blank checklist flag is set to the explicit "No" (a later Sub Type can then seed)', () =>
  withFakeIo(async ({ calls }) => {
    await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    assert.deepEqual(calls.find((c) => c[0] === 'writeCols')[2].color_mm0xs7kp, { label: 'No' });
  }, { store: { cm: cm({ applied: '' }) } }));

test('the source never writes Payment Status, the payment date or the Case Stage', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'onboardingResumeService.js'), 'utf8');
  const writes = src.slice(src.indexOf('const cols = {'), src.indexOf('try { await io.writeCols'));
  assert.ok(writes.length > 0);
  for (const k of ['paymentStatus', 'COLS.stage]', 'date_mm0xgk76', 'color_mm0x9fnn', 'color_mm0x8faa']) assert.ok(!writes.includes(k), k);
});

test('sweep path reads the history and reports instead of sending when staff acted after the hold', () =>
  withFakeIo(async ({ names, notes }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'sweep' });
    assert.equal(r.code, 'changed');
    assert.ok(names().includes('readChanges'));
    assert.ok(!names().includes('sendIntakeEmail'));
    assert.match(notes()[0], /Held onboarding not restarted automatically<\/b>/);
    assert.match(notes()[0], /Nothing was sent to the client/);
  }, { store: { changes: [{ column: 'color_mm0x9fnn', userId: '79975533', at: HELD_AT + 1000 }] } }));

test('switch OFF: no start — one "needs a manual start" note, never repeated', () =>
  withFakeIo(async ({ names, notes, store }) => {
    const r1 = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    assert.equal(r1.code, 'manual-start');
    assert.ok(!names().includes('sendIntakeEmail') && !names().includes('writeCols'));
    assert.match(notes()[0], /set the Case Stage to <b>Pre-Onboarding<\/b> and then back/);
    await R.resumeIfOwed({ itemId: ITEM, trigger: 'sweep' });
    assert.equal(notes().length, 1, 'not posted twice');
    assert.equal(store.updates.length, 3);
  }, { switch: 'off' }));

test('dry run: decides, writes nothing', () =>
  withFakeIo(async ({ names }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'sweep', dryRun: true });
    assert.equal(r.action, 'resume');
    for (const w of ['postNote', 'writeCols', 'sendIntakeEmail', 'ensureSponsor', 'seedChecklist']) assert.ok(!names().includes(w), w);
  }));

test('dry run of a case that would be REPORTED: the verdict comes back, no staff note is posted', () =>
  withFakeIo(async ({ names }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'sweep', dryRun: true });
    assert.equal(r.action, 'report');
    assert.equal(r.code, 'stage');
    assert.ok(!names().includes('postNote'));
  }, { store: { cm: cm({ stage: 'Pre-Onboarding' }) } }));

test('re-check right before starting: un-marked or moved case → nothing sent, no note', () =>
  withFakeIo(async ({ names }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    assert.equal(r.code, 'changed-before-start');
    assert.ok(!names().includes('postNote') && !names().includes('sendIntakeEmail'));
  }, { caseOnRecheck: cm({ paymentStatus: 'Not Paid' }) }));

test('the record note fails → nothing sent (the sync retries); it errored but landed → the start goes ahead', async () => {
  await withFakeIo(async ({ names }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    await flush();
    assert.equal(r.code, 'record-failed');
    assert.ok(!names().includes('sendIntakeEmail') && !names().includes('seedChecklist') && !names().includes('writeCols'));
  }, { noteThrows: true });
  await withFakeIo(async ({ names }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    await flush();
    assert.equal(r.action, 'resumed');
    assert.ok(names().includes('sendIntakeEmail'));
  }, { noteLandsThenThrows: true });
});

test('intake email not sent / failed → a staff note says so (the checklist still goes)', async () => {
  await withFakeIo(async ({ notes, names }) => {
    await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    await flush();
    assert.match(notes()[1], /intake email did not go out<\/b> \(This case has no client email/);
    assert.ok(names().includes('seedChecklist'));
  }, { emailResult: { sent: false, reason: 'This case has no client email on the Client Master row.' } });
  await withFakeIo(async ({ notes }) => {
    await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    await flush();
    assert.match(notes()[1], /intake email did not go out<\/b> \(graph down\)/);
  }, { emailThrows: true });
});

test('two triggers at once (countersign webhook + sync) → one start', () =>
  withFakeIo(async ({ names }) => {
    const [a, b] = await Promise.all([
      R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' }),
      R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' }),
    ]);
    await flush();
    assert.equal(a.action, 'resumed');
    assert.equal(b.action, 'resumed');
    assert.equal(names().filter((n) => n === 'sendIntakeEmail').length, 1);
    // and a later trigger sees the record
    const c = await R.resumeIfOwed({ itemId: ITEM, trigger: 'sweep' });
    assert.equal(c.code, 'already-resumed');
    assert.equal(names().filter((n) => n === 'sendIntakeEmail').length, 1);
  }));

test('never throws: a failing read comes back as an error verdict', () =>
  withFakeIo(async () => {
    R.io.readCase = async () => { throw new Error('monday down'); };
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    assert.equal(r.action, 'error');
  }));

test('a case reference the caller just assigned is used when Monday\'s read lags', () =>
  withFakeIo(async ({ calls }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'case-ref', caseRef: '2026-SV-021' });
    assert.equal(r.action, 'resumed');
    assert.deepEqual(calls.find((c) => c[0] === 'countRows').slice(1), ['2026-SV-021']);
  }, { store: { cm: cm({ caseRef: '' }) } }));

/* ─────────────────────────── the 15-minute backstop ─────────────────────────── */

test('sweep candidates: Paid + Document Collection (or before it) + flag not Yes + an executed claimant, from data already in hand', () => {
  const cases = new Map([
    ['1', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'No' }],   // held, countersigned → candidate
    ['2', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'No' }],   // countersign pending → no
    ['3', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'Yes' }],  // onboarded → no
    ['4', { paymentStatus: 'Paid', stage: 'Internal Review', applied: 'No' }],               // moved on → no
    ['5', { paymentStatus: 'Signed (Unpaid)', stage: 'Document Collection Started', applied: 'No' }],
    ['6', { paymentStatus: 'Paid', stage: 'Pre-Onboarding', applied: 'No' }],                // staff moved it back → candidate (gets the "stage" note)
  ]);
  const leads = ['1', '2', '3', '4', '5', '6'].map((id) => (id === '2' ? lead({ id: 'L' + id, clientMasterItemId: id }) : countersigned({ id: 'L' + id, clientMasterItemId: id })));
  leads.push({ id: 'X', clientMasterItemId: '' });
  assert.deepEqual(R.sweepCandidates(leads, cases).map((c) => c.itemId), ['1', '6']);
});

test('sweep: sequential, memoised for a case that needs nothing, re-read when it changes', async () => {
  const real = R.resumeIfOwed;
  const seen = [];
  const cases = new Map([['1', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'No' }]]);
  const leads = [countersigned({ id: 'L1', clientMasterItemId: '1' })];
  R._resetForTests();
  // drive through the real resumeIfOwed with a fake io that says "not held"
  const io0 = { ...R.io };
  Object.assign(R.io, { readCase: async () => cm(), readUpdates: async () => { seen.push('read'); return []; } });
  try {
    const a = await R.sweepHeldOnboarding({ leads, cases });
    const b = await R.sweepHeldOnboarding({ leads, cases });
    assert.equal(seen.length, 1, 'second pass skipped by the memo');
    assert.deepEqual([a.resumed, b.resumed], [[], []]);
    cases.set('1', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: '' });
    await R.sweepHeldOnboarding({ leads, cases });
    assert.equal(seen.length, 2, 'a changed case is looked at again');
    await R.sweepHeldOnboarding({ leads, cases, dryRun: true });
    assert.equal(seen.length, 3, 'the audit always looks');
  } finally { Object.assign(R.io, io0); R._resetForTests(); assert.equal(R.resumeIfOwed, real); }
});

test('sweep memo: an aborted or unreadable pass is never memoised (looked at again next pass)', async () => {
  const cases = new Map([['1', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'No' }]]);
  const leads = [countersigned({ id: 'L1', clientMasterItemId: '1' })];
  R._resetForTests();
  const io0 = { ...R.io };
  let reads = 0;
  Object.assign(R.io, {
    readCase: async () => cm(),
    readUpdates: async () => { reads++; return [HOLD_PAID, HOLD_DCS]; },
    findClaimants: async () => leads,
    countRows: async () => { throw new Error('rows down'); },
  });
  try {
    const r = await R.sweepHeldOnboarding({ leads, cases });
    assert.deepEqual(r.resumed, []);
    await R.sweepHeldOnboarding({ leads, cases });
    assert.equal(reads, 2, 'unreadable → not memoised');
  } finally { Object.assign(R.io, io0); R._resetForTests(); }
});

test('a "fix this first" note never silences a later "it already ran" note (per-kind throttle)', () => {
  const action = note(R.reportNote('no-case-ref'), '2026-09-30T09:00:00Z');
  const v = decide({ updates: [HOLD_PAID, HOLD_DCS, action], changes: [{ column: 'color_mm0x9fnn', userId: '79975533', at: HELD_AT + 60000 }] });
  assert.equal(v.code, 'changed');
  assert.equal(v.quiet, false);
  // the same ACTION code again is quiet; a different ACTION code is not
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, action], cm: cm({ caseRef: '' }) }).quiet, true);
  assert.equal(decide({ updates: [HOLD_PAID, HOLD_DCS, action], cm: cm({ clientEmail: '' }) }).quiet, false);
  // every report note carries its code
  for (const c of ['evidence', 'changed', 'moved-on', 'stage', 'no-case-ref', 'no-email', 'manual-start', 'unconfirmed']) {
    assert.match(R.reportNote(c, 'x'), new RegExp(`tdot-onb-report:${c};`), c);
  }
});

test('last look: a start that happened meanwhile (clock now set) → nothing sent', () =>
  withFakeIo(async ({ names }) => {
    const r = await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    assert.equal(r.code, 'changed-before-start');
    assert.ok(!names().includes('postNote') && !names().includes('sendIntakeEmail'));
  }, { caseOnRecheck: cm({ stageStart: '2026-09-30' }) }));

test('a good send whose "sent" note cannot be posted is NOT reported as "did not go out" (staff would email again)', () =>
  withFakeIo(async ({ notes, names }) => {
    const realPost = R.io.postNote;
    let n = 0;
    R.io.postNote = async (id, body) => { n++; if (n === 2) throw new Error('500'); return realPost(id, body); };
    await R.resumeIfOwed({ itemId: ITEM, trigger: 'last-signature' });
    await flush();
    assert.ok(names().includes('sendIntakeEmail'));
    assert.ok(!notes().some((b) => /did not go out/.test(b)), 'no false failure note');
  }));

test('sweep: a start whose outcome is still pending is not memoised — the "please check" note comes at 30 min, not 6 h', async () => {
  const cases = new Map([['1', { paymentStatus: 'Paid', stage: 'Document Collection Started', applied: 'No' }]]);
  const leads = [countersigned({ id: 'L1', clientMasterItemId: '1' })];
  const started = note(R.RESUMED_NOTE, '2026-09-30T10:00:00Z');
  const posted = [];
  const io0 = { ...R.io }, realNow = Date.now;
  R._resetForTests();
  Object.assign(R.io, {
    readCase: async () => cm(),
    readUpdates: async () => [HOLD_PAID, HOLD_DCS, started, ...posted.map((b) => note(b, '2026-09-30T10:40:30Z'))],
    postNote: async (id, b) => { posted.push(b); },
  });
  try {
    Date.now = () => Date.parse('2026-09-30T10:10:00Z');
    await R.sweepHeldOnboarding({ leads, cases });
    assert.equal(posted.length, 0);
    Date.now = () => Date.parse('2026-09-30T10:40:00Z');
    const r = await R.sweepHeldOnboarding({ leads, cases });
    assert.deepEqual(r.reported.map((x) => x.code), ['unconfirmed']);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /automatic onboarding may not have finished/);
    Date.now = () => Date.parse('2026-09-30T10:55:00Z');
    await R.sweepHeldOnboarding({ leads, cases });
    assert.equal(posted.length, 1, 'posted once');
  } finally { Date.now = realNow; Object.assign(R.io, io0); R._resetForTests(); }
});
