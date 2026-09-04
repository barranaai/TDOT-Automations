'use strict';

// Team feedback 2026-08-13: notify staff (Kamal) when a lead's OUTCOME changes,
// so nobody has to read the board every morning. Same shape as the retainer
// signature notification: recipients in an env var, unset = off, best-effort.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

function fresh({ lead = { id: '1', fullName: 'Kamalpreet Kaur', outcome: '', confirmedCaseType: 'Study Permit', assignedConsultant: 'Shermin', retainerFee: '2500', retainerSent: '' }, mail } = {}) {
  const calls = { mails: [], updates: [], leadWrites: [] };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/mondayApi', { query: async (q, v) => { if (q.includes('create_update')) calls.updates.push(v.b); return {}; } });
  const realLead = require('../src/services/leadService');
  set('../src/services/leadService', { ...realLead, getLead: async () => lead, updateLead: async (id, u) => { calls.leadWrites.push(u); } });
  set('../src/services/retainerService2', { feeToCents: () => 250000, maybeSendRetainerAgreement: async () => ({ status: 'sent' }) });
  set('../src/services/microsoftMailService', { sendEmail: mail || (async (m) => { calls.mails.push(m); }) });
  const p = require.resolve('../src/services/consultantPortalService');
  delete require.cache[p];
  return { svc: require(p), calls };
}

const withEnv = async (val, fn) => {
  const prev = process.env.STAFF_OUTCOME_NOTIFY_EMAILS;
  if (val === undefined) delete process.env.STAFF_OUTCOME_NOTIFY_EMAILS; else process.env.STAFF_OUTCOME_NOTIFY_EMAILS = val;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.STAFF_OUTCOME_NOTIFY_EMAILS; else process.env.STAFF_OUTCOME_NOTIFY_EMAILS = prev; }
};

test('unset recipients = feature off; an unchanged outcome never emails', async () => {
  const { svc, calls } = fresh();
  await withEnv(undefined, async () => {
    assert.deepEqual(await svc.notifyOutcomeChange({ leadId: '1', lead: {}, from: '', to: 'Follow-Up' }), { sent: false, reason: 'no-recipients' });
  });
  await withEnv('kamal@tdotimm.com', async () => {
    assert.deepEqual(await svc.notifyOutcomeChange({ leadId: '1', lead: {}, from: 'Retain', to: 'Retain' }), { sent: false, reason: 'unchanged' });
    assert.deepEqual(await svc.notifyOutcomeChange({ leadId: '1', lead: {}, from: ' Retain ', to: 'Retain' }), { sent: false, reason: 'unchanged' }, 'whitespace is not a change');
    assert.deepEqual(await svc.notifyOutcomeChange({ leadId: '1', lead: {}, from: 'Retain', to: '' }), { sent: false, reason: 'unchanged' }, 'clearing is not announced');
  });
  assert.equal(calls.mails.length, 0);
});

test('a real change emails every recipient with who/what/where, HTML-escaped', async () => {
  const { svc, calls } = fresh();
  await withEnv(' kamal@tdotimm.com , ops@tdotimm.com ', async () => {
    const r = await svc.notifyOutcomeChange({ leadId: '77', lead: { fullName: 'Ana <Q> & Sons', confirmedCaseType: 'Spousal', assignedConsultant: 'Shafoli', retainerFee: '3500' }, from: 'Follow-Up', to: 'Retain', staffName: 'Shafoli <x>' });
    assert.deepEqual(r, { sent: true, recipients: 2 });
  });
  assert.equal(calls.mails.length, 1);
  const m = calls.mails[0];
  assert.deepEqual(m.to, ['kamal@tdotimm.com', 'ops@tdotimm.com']);
  assert.match(m.subject, /Outcome: Retain — Ana <Q> & Sons \(Spousal\)/);
  assert.match(m.html, /changed from <b>Follow-Up<\/b> to <b>Retain<\/b> by Shafoli &lt;x&gt;/);
  assert.match(m.html, /Ana &lt;Q&gt; &amp; Sons/, 'name escaped in the body');
  assert.doesNotMatch(m.html, /<Q>/, 'no raw angle brackets from data');
  assert.match(m.html, /\/admin\/consultation\/77/);
  assert.match(m.html, /Shafoli/); assert.match(m.html, /\$3500/);
});

test('first-time set reads "set to", not "changed from"', async () => {
  const { svc, calls } = fresh();
  await withEnv('kamal@tdotimm.com', () => svc.notifyOutcomeChange({ leadId: '5', lead: { fullName: 'X' }, from: '', to: 'Newsletter' }));
  assert.match(calls.mails[0].html, /outcome set to <b>Newsletter<\/b>/);
  assert.doesNotMatch(calls.mails[0].html, /changed from/);
});

test('a mail failure is swallowed — the outcome write is the record, the email is a nudge', async () => {
  const { svc } = fresh({ mail: async () => { throw new Error('Graph 503'); } });
  await withEnv('kamal@tdotimm.com', async () => {
    const r = await svc.notifyOutcomeChange({ leadId: '1', lead: {}, from: '', to: 'Retain' });
    assert.equal(r.sent, false); assert.equal(r.reason, 'error');
  });
});

test('both outcome writers notify: the outcome buttons and "Retain & send"', async () => {
  // outcome button: board write + audit note + one email, with the PREVIOUS value
  let h = fresh({ lead: { id: '1', fullName: 'Kamalpreet Kaur', outcome: 'Follow-Up', confirmedCaseType: 'Study Permit', retainerSent: '' } });
  await withEnv('kamal@tdotimm.com', () => h.svc.applyAction({ leadId: '1', action: 'outcome', value: 'Newsletter', staffName: 'Kamal' }));
  assert.deepEqual(h.calls.leadWrites, [{ outcome: 'Newsletter' }]);
  assert.equal(h.calls.mails.length, 1);
  assert.match(h.calls.mails[0].html, /changed from <b>Follow-Up<\/b> to <b>Newsletter<\/b> by Kamal/);

  // re-clicking the outcome the lead already has: still written + noted, but no email
  h = fresh({ lead: { id: '1', fullName: 'K', outcome: 'Newsletter', retainerSent: '' } });
  await withEnv('kamal@tdotimm.com', () => h.svc.applyAction({ leadId: '1', action: 'outcome', value: 'Newsletter', staffName: 'Kamal' }));
  assert.equal(h.calls.leadWrites.length, 1);
  assert.equal(h.calls.mails.length, 0, 'no email when nothing actually changed');

  // "Retain & send" sets Retain → notifies too
  h = fresh({ lead: { id: '1', fullName: 'K', outcome: 'Follow-Up', confirmedCaseType: 'Study Permit', selectedSubType: 'x', retainerFee: '2500', retainerSent: '', conversionStatus: '' } });
  await withEnv('kamal@tdotimm.com', () => h.svc.applyAction({ leadId: '1', action: 'retainAndSend', value: '' }).catch(() => {}));
  assert.equal(h.calls.mails.length, 1, '"Retain & send" announces the outcome too');
  assert.match(h.calls.mails[0].subject, /Outcome: Retain/);
});

test('source pins: env-gated, best-effort, called via module.exports so both writers are stubbable', () => {
  const src = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /STAFF_OUTCOME_NOTIFY_EMAILS/);
  assert.equal((src.match(/module\.exports\.notifyOutcomeChange\(/g) || []).length, 2, 'wired into both outcome writers');
  const i = src.indexOf('async function notifyOutcomeChange');
  const block = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(block, /catch \(err\)/, 'never throws into the action');
  assert.match(block, /before === after\) return/, 'no email when nothing changed');
});
