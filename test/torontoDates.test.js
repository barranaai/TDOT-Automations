'use strict';

// Toronto time wherever a lead's arrival (Monday's created_at, a UTC instant)
// or another recorded instant is shown (2026-10-12, Soniya's "date a lead was
// received"): a lead that arrives at 9:30 pm Toronto is 01:30 the next day in
// UTC — the pages cut the UTC string and showed it on the wrong day, the KPI
// counted it in the wrong month at month end, the case timeline put it after
// the invite sent that same evening. Date-only values and booked slots are
// already Toronto and must never move.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const { torontoTime, torontoWallClock, torontoDay } = require('../src/utils/torontoTime');

test('torontoWallClock: instants with a zone become Toronto wall-clock — summer, winter, both DST changes, never "24"', () => {
  const cases = [
    ['2026-10-01T01:30:00Z', '2026-09-30 21:30'],        // EDT evening → the day before in Toronto
    ['2026-10-01T01:30:00.123Z', '2026-09-30 21:30'],    // a toISOString() stamp
    ['2026-09-30T21:30:00-04:00', '2026-09-30 21:30'],   // an offset
    ['2026-01-15T03:00:00Z', '2026-01-14 22:00'],        // EST
    ['2026-03-08T07:00:00Z', '2026-03-08 03:00'],        // spring forward
    ['2026-11-01T05:30:00Z', '2026-11-01 01:30'],        // fall back: the hour repeats
    ['2026-11-01T06:30:00Z', '2026-11-01 01:30'],
    ['2026-11-01T04:00:00Z', '2026-11-01 00:00'],        // midnight is 00, not 24
    ['2026-01-01T04:59:59Z', '2025-12-31 23:59'],        // year end
  ];
  for (const [v, want] of cases) assert.equal(torontoWallClock(v), want, v);
});

test('torontoWallClock: anything that is not a zoned instant comes back exactly as it was', () => {
  for (const v of ['2026-09-30', '2026-09-30 22:00', 'nope', '2026-09-30T22:00']) assert.equal(torontoWallClock(v), v, `${v} is already Toronto (or not a time)`);
  for (const v of ['', undefined, null, '  ']) assert.equal(torontoWallClock(v), '');
  assert.equal(torontoDay('2026-10-01T01:30:00Z'), '2026-09-30');
  assert.equal(torontoDay('2026-09-30'), '2026-09-30', 'a date-only value never moves to the evening before');
  assert.equal(torontoDay('2026-09-30 22:00'), '2026-09-30');
  assert.equal(torontoDay(''), '');
  assert.equal(torontoTime(Date.parse('2026-09-24T02:30:00Z')), '23 Sep 2026, 10:30 pm', 'the note wording is unchanged');
});

test('KPI: an evening lead counts in its Toronto month; date-only and slot dates unchanged', () => {
  const { monthKey, computeKpis, distinctMonths } = require('../src/services/kpiService');
  assert.equal(monthKey('2026-11-01T02:30:00Z'), '2026-10', '10:30 pm on 31 Oct in Toronto');
  assert.equal(monthKey('2026-07-01'), '2026-07');
  assert.equal(monthKey('2026-06-10 15:00'), '2026-06');
  assert.equal(monthKey(''), '');
  const leads = [{ createdAt: '2026-11-01T02:30:00Z' }, { createdAt: '2026-11-01T05:00:00Z' }];
  assert.equal(computeKpis(leads, '2026-10').funnel.leads, 1);
  assert.equal(computeKpis(leads, '2026-11').funnel.leads, 1);
  assert.deepEqual(distinctMonths(leads), ['2026-11', '2026-10']);
});

test('case timeline: the inquiry and the questionnaire submit are Toronto wall-clock, and an evening inquiry sorts BEFORE the invite sent that night', () => {
  const { buildTimeline } = require('../src/services/caseCockpitService');
  const ev = buildTimeline({ lead: { createdAt: '2026-10-01T01:30:00Z', inviteSentAt: '2026-09-30', bookedSlot: '2026-10-02 10:00' }, qMembers: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-10-03T00:15:00.000Z' }] });
  const by = Object.fromEntries(ev.map((e) => [e.title, e.date]));
  assert.equal(by['Inquiry received'], '2026-09-30 21:30');
  assert.equal(by['Booking invite sent'], '2026-09-30', 'date-only unchanged');
  assert.equal(by['Consultation scheduled'], '2026-10-02 10:00', 'slot unchanged');
  assert.ok(ev.findIndex((e) => e.title === 'Inquiry received') < ev.findIndex((e) => e.title === 'Booking invite sent'));
  const q = ev.find((e) => /^Questionnaire submitted/.test(e.title));
  assert.equal(q.date, '2026-10-02 20:15');
});

test('Leads queue: each row carries the Toronto day it arrived; the raw instant stays for sorting', async () => {
  const portal = require('../src/services/consultantPortalService');
  const leadService = require('../src/services/leadService');
  const orig = leadService.listAllLeads;
  leadService.listAllLeads = async () => ([
    { id: '1', fullName: 'Evening Lead', createdAt: '2026-10-01T01:30:00Z' },
    { id: '2', fullName: 'Morning Lead', createdAt: '2026-09-30T14:00:00Z' },
    { id: '3', fullName: 'Legacy Lead' },
  ]);
  try {
    const rows = await portal.getLeadsQueue();
    const r = (id) => rows.find((x) => x.id === id);
    assert.deepEqual([r('1').createdDay, r('1').createdAt], ['2026-09-30', '2026-10-01T01:30:00Z']);
    assert.equal(r('2').createdDay, '2026-09-30');
    assert.equal(r('3').createdDay, '', 'no date → empty, never "Invalid"');
    assert.deepEqual(rows.map((x) => x.id), ['1', '2', '3'], 'newest first, by the raw instant');
  } finally { leadService.listAllLeads = orig; }
});

test('lead detail: when it arrived (Toronto, with the time) and the intake/consent stamps as Toronto days', () => {
  const src = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /createdWhen: torontoWallClock\(lead\.createdAt\),/);
  assert.match(src, /intakeSubmittedAt: torontoWallClock\(intake && intake\.submittedAt\),/);
  assert.match(src, /consentsAt: torontoWallClock\(intake && intake\.consents && intake\.consents\.at\),/);
});

test('pages: the Leads list, its month filter and the detail chip use the Toronto values; the KPI page and the follow-up "due" use Toronto today', () => {
  const leads = fs.readFileSync(require.resolve('../src/routes/adminLeads'), 'utf8');
  assert.match(leads, /function createdOf\(r\)\{ return String\(r\.createdDay\|\|''\); \}/);
  assert.match(leads, /function monthOf\(r\)\{ return String\(r\.createdDay\|\|''\)\.slice\(0,7\); \}/);
  assert.match(leads, /<th title="The day the lead arrived, Toronto time">Received<\/th>/);
  assert.match(leads, /'<span class="pk">Received<\/span> '\+escHtml\(d\.createdWhen \? d\.createdWhen\+' \(Toronto\)' : '—'\)/);
  assert.ok(!/String\(r\.createdAt\|\|''\)\.slice\(0,10\)|String\(d\.createdAt\|\|''\)\.slice\(0,10\)/.test(leads), 'no UTC cut of the arrival left');
  const consult = fs.readFileSync(require.resolve('../src/routes/adminConsultation'), 'utf8');
  assert.match(consult, /function todayStr\(\)\{ return new Intl\.DateTimeFormat\('en-CA',\{timeZone:'America\/Toronto'\}\)\.format\(new Date\(\)\); \}/);
  assert.match(consult, /new Intl\.DateTimeFormat\('en-CA',\{timeZone:'America\/Toronto',year:'numeric',month:'2-digit'\}\)\.format\(new Date\(\)\)/);
  // what those page expressions produce, run here
  const d = new Date('2026-11-01T02:30:00Z');
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(d), '2026-10-31');
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit' }).format(d), '2026-10');
  // the pages still parse
  for (const html of [require('../src/routes/adminLeads').buildLeadsQueueHTML(), require('../src/routes/adminLeads').buildLeadDetailHTML('123')]) {
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) assert.doesNotThrow(() => new Function(m[1]));
  }
});

test('the case timeline and the client journey say the times are Toronto time', () => {
  assert.match(fs.readFileSync(require.resolve('../src/routes/adminCase'), 'utf8'), /document uploads\. Times are Toronto \(Eastern\) time\.<\/div>/);
  assert.match(fs.readFileSync(require.resolve('../src/services/clientPortalService'), 'utf8'), /Everything that has happened on your file so far\. Times are Toronto \(Eastern\) time\./);
});
