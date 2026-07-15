'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildTimeline, summariseDocuments, pickLeadFields } = require('../src/services/caseCockpitService');

// ─── buildTimeline ────────────────────────────────────────────────────────────

test('buildTimeline: assembles the full journey in chronological order', () => {
  const ev = buildTimeline({
    lead: {
      createdAt: '2026-06-01T10:00:00Z', inviteSentAt: '2026-06-02',
      bookedSlot: '2026-06-10 15:00', meetingType: 'Virtual',
      consultationHeld: '2026-06-10', assignedConsultant: 'Shermin Teymouri Mofrad',
      consultAgreementSent: '2026-06-05',
      retainerSent: '2026-06-12', retainerSigned: '2026-06-15', retainerPaid: '2026-06-16',
    },
    milestones: [
      { index: 0, label: 'Milestone 1', requestedAt: '2026-06-15T18:00:00Z', paidAt: '2026-06-16', reference: 'CA1ETRF' },
      { index: 1, label: 'Milestone 2', requestedAt: '', paidAt: '' },
    ],
    qMembers: [ { key: 'primary', label: 'Principal Applicant', submittedAt: '2026-06-20T12:00:00Z' }, { key: 'spouse', label: 'Spouse' } ],
    docItems: [ { name: 'Passport', lastUpload: '2026-06-18', applicantType: 'Principal Applicant' }, { name: 'IELTS', lastUpload: '' } ],
  });

  const titles = ev.map((e) => e.title);
  assert.deepEqual(titles, [
    'Inquiry received',                            // Jun 1
    'Booking invite sent',                         // Jun 2
    'Consultation agreement emailed',              // Jun 5
    'Consultation scheduled',                      // Jun 10 15:00
    'Consultation held',                           // Jun 10 (date-only → end of day, after the slot)
    'Retainer agreement sent',                     // Jun 12
    'e-Transfer requested — Milestone 1',          // Jun 15 18:00Z
    'Retainer signed — case opened',               // Jun 15 (date-only → end of day)
    'First retainer payment recorded',             // Jun 16 (insertion order on tie)
    'Paid — Milestone 1',                          // Jun 16
    'Document received — Passport',                // Jun 18
    'Questionnaire submitted — Principal Applicant', // Jun 20
  ]);
  // dateless sources are skipped: milestone 2, spouse questionnaire, IELTS doc
  assert.ok(!titles.some((t) => t.includes('Milestone 2') || t.includes('Spouse') || t.includes('IELTS')));
});

test('buildTimeline: same-day ordering works across "YYYY-MM-DD HH:mm" and ISO formats', () => {
  const ev = buildTimeline({
    lead: { createdAt: '2026-06-10T09:00:00Z', bookedSlot: '2026-06-10 15:00' },
  });
  assert.deepEqual(ev.map((e) => e.title), ['Inquiry received', 'Consultation scheduled']);
});

test('buildTimeline: no lead → events still assemble from the other sources', () => {
  const ev = buildTimeline({
    lead: null,
    docItems: [ { name: 'Passport', lastUpload: '2026-06-18', applicantType: 'Spouse' } ],
    qMembers: [ { key: 'primary', label: 'PA', submittedAt: '2026-06-20' } ],
  });
  assert.equal(ev.length, 2);
  assert.equal(ev[0].title, 'Document received — Passport');
  assert.equal(ev[0].detail, 'Spouse');
});

test('buildTimeline: empty input → empty timeline', () => {
  assert.deepEqual(buildTimeline({}), []);
});

// ─── summariseDocuments: inline-action fields pass through ────────────────────

test('summariseDocuments: byCategory items carry id / lastUpload / reviewNotes for inline actions', () => {
  const out = summariseDocuments([
    { id: '111', name: 'Passport', status: 'Received', category: 'Identity', applicantType: 'Principal Applicant', lastUpload: '2026-06-18', reviewNotes: '' },
    { id: '222', name: 'Bank letter', status: 'Rework Required', category: 'Financial', applicantType: 'Principal Applicant', reviewNotes: 'Statement must show 6 months' },
  ]);
  const identity = out.byCategory.find((c) => c.category === 'Identity');
  assert.equal(identity.items[0].id, '111');
  assert.equal(identity.items[0].lastUpload, '2026-06-18');
  const fin = out.byCategory.find((c) => c.category === 'Financial');
  assert.equal(fin.items[0].reviewNotes, 'Statement must show 6 months');
  assert.equal(out.counts.received, 1);
  assert.equal(out.counts.rework, 1);
});

// ─── pickLeadFields ───────────────────────────────────────────────────────────

test('pickLeadFields: null-safe and maps the cockpit fields', () => {
  assert.equal(pickLeadFields(null), null);
  const f = pickLeadFields({
    id: '77', bookedSlot: '2026-06-10 15:00', meetingType: 'Virtual', meetingLink: 'https://x',
    retainerSigned: '2026-06-15', squareConsultTxnId: 'TX1', assignedConsultant: ' Shafoli Kapur ',
  });
  assert.equal(f.leadId, '77');
  assert.equal(f.meetingLink, 'https://x');
  assert.equal(f.retainerSigned, '2026-06-15');
  assert.equal(f.consultPaid, true);
  assert.equal(f.assignedConsultant, 'Shafoli Kapur');
});
