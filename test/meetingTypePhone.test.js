'use strict';

// "Phone Call" as a third consultation type alongside Virtual and In-person:
// booking page offers it, no video meeting is created for it, client emails say
// "we will call you", and KPIs count it separately.

const test   = require('node:test');
const assert = require('node:assert/strict');

const consultationService = require('../src/services/consultationService');
const consultAgreementSvc = require('../src/services/consultAgreementService');
const kpi                 = require('../src/services/kpiService');
const leadService         = require('../src/services/leadService');
const microsoftMail       = require('../src/services/microsoftMailService');
const mondayApi           = require('../src/services/mondayApi');
const phase2              = require('../src/routes/phase2');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

function phoneLead(extra = {}) {
  return { id: '600', fullName: 'Phone Client', email: 'p@example.com', phone: '+1 416 555 0100',
    leadToken: 'tok', bookedSlot: '2026-08-01 10:00', meetingType: 'Phone Call', meetingLink: '', ...extra };
}

test('booking page: offers the Phone Call option and still parses', () => {
  const html = phase2.buildBookingPageHtml(phoneLead(), [{ display: '2026-08-01 10:00' }], 'tok', { name: 'Shafoli Kapur' });
  assert.match(html, /value="Phone Call"/, 'Phone Call radio present');
  assert.match(html, /Phone call/, 'visible label present');
  assert.match(html, /value="In-person"/, 'In-person still offered');
  assert.match(html, /value="Virtual"/, 'Virtual still offered');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const m of blocks) new Function(m[1]); // throws on a syntax error
});

test('booking confirmation email: phone consultation says we will CALL, no office/join link', async () => {
  const mails = [];
  const restore = stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); });
  try {
    // internal send helper is not exported — go through resendConsultationLinks,
    // which uses the identical where-block logic.
    const restore2 = stub(leadService, 'getLead', async () => phoneLead());
    try { await consultationService.resendConsultationLinks('600'); } finally { restore2(); }
    assert.equal(mails.length, 1);
    assert.match(mails[0].html, /we will call you at/i);
    assert.match(mails[0].html, /\+1 416 555 0100/);
    assert.ok(!/In person at our office/.test(mails[0].html), 'no office address for a phone consult');
    assert.ok(!/Join the call/.test(mails[0].html), 'no join link for a phone consult');
  } finally { restore(); }
});

test('consultation package email: phone consultation carries the call-you line', async () => {
  const mails = [];
  const restore = [
    stub(leadService, 'getLead', async () => phoneLead()),
    stub(leadService, 'updateLead', async () => {}),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: phoneLead(), url: 'https://x/agreement' })),
    stub(consultAgreementSvc, 'maybeSendConsultEsign', async () => null),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await consultationService.sendConsultationPackage('600');
    assert.equal(mails.length, 1);
    assert.match(mails[0].html, /we will call you at/i);
    assert.ok(!/Join the video call/.test(mails[0].html));
    assert.ok(!/In person at our office/.test(mails[0].html));
  } finally { restore.forEach((x) => x()); }
});

test('computeKpis: phone consultations counted separately from virtual and in-person', () => {
  const leads = [
    { createdAt: '2026-08-01', bookedSlot: '2026-08-02 10:00', meetingType: 'Virtual' },
    { createdAt: '2026-08-01', bookedSlot: '2026-08-03 10:00', meetingType: 'In-person' },
    { createdAt: '2026-08-01', bookedSlot: '2026-08-04 10:00', meetingType: 'Phone Call' },
  ];
  const K = kpi.computeKpis(leads, '2026-08');
  assert.equal(K.consultations.virtual, 1);
  assert.equal(K.consultations.inPerson, 1);
  assert.equal(K.consultations.phone, 1, 'phone gets its own bucket');
  assert.equal(K.consultations.booked, 3);
});
