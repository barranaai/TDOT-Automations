'use strict';

// Booking-invite body policy (user directive 2026-07-31): the invite says
// NOTHING about the client's case condition — no situation summaries, no
// eligibility opinions, no hopeful thoughts, no promises. It is the ONE fixed
// consultation-booking paragraph, personalized only by the service name (the
// email template adds the greeting/button/fee). Deterministic — no AI call.

const test   = require('node:test');
const assert = require('node:assert/strict');

const leadService = require('../src/services/leadService');

const EXPECTED = (svc) =>
  `A paid consultation will let us review your specific situation in detail, assess your eligibility factors, and map out the right strategy for your ${svc} journey. To book your consultation with one of our Regulated Canadian Immigration Consultants, please use the button below.`;

test('invite body is EXACTLY the fixed paragraph, service-personalized', async () => {
  assert.equal(
    await leadService.generateInviteMessage({ confirmedCaseType: 'Study permit' }),
    EXPECTED('Study permit'));
  assert.equal(
    await leadService.generateInviteMessage({ serviceRequired: 'Express Entry profile' }),
    EXPECTED('Express Entry'), 'EE-family labels normalize to "Express Entry"');
  assert.equal(
    await leadService.generateInviteMessage({}),
    EXPECTED('immigration'), 'no service on file → generic phrasing');
});

test('invite body NEVER carries case-condition content — even for a lead full of it', async () => {
  const msg = await leadService.generateInviteMessage({
    fullName: 'Risky Lead', serviceRequired: 'Work permit',
    situationDescription: 'My visa was refused twice and I overstayed, am I eligible? Please help, deadline next week!',
    recentRefusal: 'Yes', refusalType: 'TRV', deadlineDate: '2026-08-05', crsScore: 512,
    currentStatus: 'Out of status',
  });
  for (const banned of ['refus', 'overstay', 'deadline', 'eligible for', 'CRS', '512', 'status',
                        'good news', 'confident', 'strong case', 'promise', 'guarantee']) {
    assert.ok(!msg.toLowerCase().includes(banned.toLowerCase()),
      `invite must not mention "${banned}" (got: ${msg})`);
  }
  assert.equal(msg, EXPECTED('Work permit'), 'identical paragraph regardless of the case details');
});

test('generation is deterministic and needs no API key', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const a = await leadService.generateInviteMessage({ serviceRequired: 'PGWP' });
    const b = await leadService.generateInviteMessage({ serviceRequired: 'PGWP' });
    assert.equal(a, b);
    assert.ok(a && a.length > 100, 'real paragraph, not null — no AI dependency');
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});
