'use strict';

// The retainer agreement must NEVER be emailed before the per-client fee is
// set, because the agreement states the fee. These tests stub the I/O and
// verify maybeSendRetainerAgreement's gating decisions.

const test   = require('node:test');
const assert = require('node:assert/strict');

const leadService   = require('../src/services/leadService');
const microsoftMail = require('../src/services/microsoftMailService');
const mondayApi     = require('../src/services/mondayApi');
const retainer      = require('../src/services/retainerService2');

function setup(lead) {
  const calls = { emails: [], updates: [], notes: [] };
  leadService.getLead    = async () => lead;
  leadService.updateLead = async (_id, fields) => { calls.updates.push(fields); };
  microsoftMail.sendEmail = async (m) => { calls.emails.push(m); };
  mondayApi.query = async (q, vars) => { if (/create_update/.test(q)) calls.notes.push(vars.body); return {}; };
  return calls;
}

test('Retain + fee set + not sent → emails the agreement and marks it sent', async () => {
  const calls = setup({ id: '1', fullName: 'A', email: 'a@x.com', outcome: 'Retain', retainerFee: '2500', retainerSent: '' });
  await retainer.maybeSendRetainerAgreement('1', { notifyIfMissing: true });
  assert.equal(calls.emails.length, 1);
  assert.match(calls.emails[0].subject, /retainer agreement/i);
  assert.ok(calls.updates.some((u) => u.retainerSent), 'should stamp Retainer Sent');
  assert.equal(calls.notes.length, 0);
});

test('Retain + NO fee → HELD: no email, not marked sent, posts a fee-needed note', async () => {
  const calls = setup({ id: '1', fullName: 'A', email: 'a@x.com', outcome: 'Retain', retainerFee: '', retainerSent: '' });
  await retainer.maybeSendRetainerAgreement('1', { notifyIfMissing: true });
  assert.equal(calls.emails.length, 0, 'must NOT email without a fee');
  assert.equal(calls.updates.length, 0, 'must NOT mark sent');
  assert.equal(calls.notes.length, 1);
  assert.match(calls.notes[0], /Retainer Fee/i);
});

test('not Retain (e.g. fee set on a Follow-Up lead) → no-op', async () => {
  const calls = setup({ id: '1', outcome: 'Follow-Up', retainerFee: '2500', retainerSent: '' });
  await retainer.maybeSendRetainerAgreement('1');
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.updates.length, 0);
});

test('already sent → idempotent no-op', async () => {
  const calls = setup({ id: '1', outcome: 'Retain', retainerFee: '2500', retainerSent: '2026-06-22' });
  await retainer.maybeSendRetainerAgreement('1');
  assert.equal(calls.emails.length, 0);
});
