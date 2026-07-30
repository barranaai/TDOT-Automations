'use strict';

// Warn-before-invite for non-booking intents (user decision 2026-07-30):
// every intake lead answers "What would you like to do?" — when it is anything
// other than "Book consultation" (Start new application / Request quote /
// Existing file update / General information), the funnel stays the same but
// the portal must SAY SO: an amber pill on the queue row, an "Asked for" chip
// + warning banner on the detail page, and an explicit are-you-sure that names
// the client's actual request before the paid-consultation invite goes out.

const test   = require('node:test');
const assert = require('node:assert/strict');

const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const { buildLeadsQueueHTML, buildLeadDetailHTML } = require('../src/routes/adminLeads');

const BOOKING = 'Book consultation';

test('getLeadsQueue rows carry wantsTo from the intake intent', async () => {
  const orig = leadService.listAllLeads;
  leadService.listAllLeads = async () => ([
    { id: '1', fullName: 'Quote Seeker', whatDoYouWant: 'Request quote' },
    { id: '2', fullName: 'Booker',       whatDoYouWant: BOOKING },
    { id: '3', fullName: 'Legacy Lead' },                       // pre-dates the question
  ]);
  try {
    const rows = await portal.getLeadsQueue();
    assert.equal(rows.find((r) => r.id === '1').wantsTo, 'Request quote');
    assert.equal(rows.find((r) => r.id === '2').wantsTo, BOOKING);
    assert.equal(rows.find((r) => r.id === '3').wantsTo, '', 'missing intent → empty, never undefined');
  } finally { leadService.listAllLeads = orig; }
});

test('queue page: amber intent pill only for non-booking intents', () => {
  const html = buildLeadsQueueHTML();
  // The client-side gate: pill only when wantsTo exists AND is not the booking intent.
  assert.ok(html.includes("c.wantsTo&&c.wantsTo!=='Book consultation'"),
    'queue rows must gate the intent pill on non-booking intents');
});

test('detail page: "Asked for" chip, warning banner, and intent-aware confirm', () => {
  const html = buildLeadDetailHTML('12345');

  // Chip in the pills row.
  assert.ok(html.includes('Asked for'), 'detail pills must label the client’s stated intent');
  assert.ok(html.includes("d.wantsTo && d.wantsTo!=='Book consultation'"),
    'chip must not render for booking intents');

  // Persistent warning banner inside the invite card, populated in render().
  assert.ok(html.includes('id="invite-warn"'), 'invite card carries the warning banner container');
  assert.ok(html.includes('they did not ask to book a consultation'),
    'banner text must state the mismatch plainly');

  // The confirm dialog names the actual request before staff can send anyway.
  assert.ok(html.includes('THIS CLIENT ASKED FOR'),
    'non-booking intents get an explicit are-you-sure that quotes the intent');
  assert.ok(html.includes('Send the paid-consultation booking invite anyway?'),
    'confirm must make clear the invite is for a PAID consultation');
  assert.ok(html.includes('Email this client their consultation booking link with this message?'),
    'booking intents keep the standard confirmation');
});
