'use strict';

// "Webinar" (Faran 2026-11-11): a lead-only outcome set from the lead page, and a Webinar column at the end of the Leads list.

const test   = require('node:test');
const assert = require('node:assert/strict');

const O      = require('../config/outcomes');
const portal = require('../src/services/consultantPortalService');
const status = require('../src/services/leadStatusService');
const LTF    = require('../src/routes/leadsTableFilters');

test('Webinar is a lead outcome, not a consultation outcome', () => {
  assert.deepEqual(O.LEAD_OUTCOME_LABELS, ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted', 'Webinar']);
  assert.deepEqual(O.OUTCOME_LABELS, ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted'], 'the consultation outcomes and the Retainers tabs are unchanged');
  assert.ok(!portal.RETAINER_TABS.includes('Webinar'));
  assert.equal(O.canonicalOutcome('Webinar'), '', 'read as blank wherever a consultation outcome is meant');
  assert.ok(O.isWebinar(' Webinar ') && !O.isWebinar('webinar') && !O.isWebinar('Newsletter') && !O.isWebinar(''));
  assert.equal(O.consultOutcomeText('Webinar'), '');
  assert.equal(O.consultOutcomeText(' Follow-Up '), 'Follow-Up');
});

test('the outcome action accepts Webinar (no reason asked); junk is still refused', () => {
  assert.deepEqual(portal.validateAction('outcome', 'Webinar'), { ok: true, normalized: 'Webinar', reason: '' });
  assert.deepEqual(portal.validateAction('outcome', JSON.stringify({ label: 'Webinar', reason: 'x' })), { ok: true, normalized: 'Webinar', reason: '' });
  assert.equal(portal.validateAction('outcome', 'webinar').ok, false);
  assert.equal(portal.validateAction('outcome', 'Webinars').ok, false);
});

test('a booked consultation is never decided by Webinar: not done, not completed, still upcoming and still asking for its outcome', () => {
  const l = { bookingStatus: 'Booked', bookedSlot: '2026-11-05 10:00', outcome: 'Webinar', outcomeChangedAt: '2026-11-01T15:00:00Z' };
  assert.equal(portal.classifyLead(l), 'consultation');
  assert.equal(portal.consultationDone(l, '2026-11-11'), false);
  assert.equal(portal.completedConsultation(l, '2026-11-11'), null);
  assert.equal(portal.listFor(l, new Date('2026-11-11T17:00:00Z')), 'consultations');
  assert.equal(portal.classifyLead({ bookingStatus: 'Not Yet', outcome: 'Webinar' }), 'lead', 'an unbooked lead stays on the Leads list');
});

test('the Leads list: Current status reads "Outcome: Webinar" (blue); the Webinar column filters; it is the last column before delete', () => {
  const st = status.leadStatus({ outcome: 'Webinar', outcomeChangedAt: '2026-11-10T15:00:00Z' }, null, Date.parse('2026-11-11T17:00:00Z'));
  assert.equal(st.label, 'Outcome: Webinar'); assert.equal(st.tone, 'blue'); assert.equal(st.key, 'outcome');
  const LT = LTF.leadsTableCore();
  const rows = [{ id: '1', webinar: true }, { id: '2', webinar: false }, { id: '3' }];
  const on = LT.emptyState(); on.sel.webinar = ['yes'];
  assert.deepEqual(LT.filterRows(rows, on).map((r) => r.id), ['1']);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'webinar').map((x) => [x.label, x.count]), [['Webinar', 1], ['Not webinar', 2]]);
  assert.deepEqual(LTF.leadsTableOpts().cols.slice(-2).map((c) => c.id), ['webinar', 'del']);
  const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(html.includes("c.webinar?qpill('blue','Webinar')"));
  const lead = require('../src/routes/adminLeads').buildLeadDetailHTML('1');
  assert.ok(lead.includes('var OUTCOMES=["Retain","Follow-Up","Newsletter","Not Wanted","Webinar"];'));
  const rec = require('../src/routes/adminConsultation').buildDetailHTML('1');
  assert.ok(rec.includes('var OUTCOMES=["Retain","Follow-Up","Newsletter","Not Wanted"];'), 'the consultation record keeps its four');
});

// review 2026-11-11: the mark is taken off `outcome` where every lead is read, so no reader can take it for a decided consultation.
test('parseItem: a Webinar cell becomes lead.webinar (+ when); `outcome` reads blank; every other outcome is untouched; the snapshot keeps the mark', async () => {
  const leadService = require('../src/services/leadService');
  const C = require('../src/data/newLeadsBoard.json').columns;
  const item = (label) => ({ id: '5', name: 'N', column_values: [{ id: C.outcome, type: 'status', text: label, value: label ? JSON.stringify({ index: 7, changed_at: '2026-11-10T15:00:00Z' }) : null }] });
  const w = leadService.parseItem(item('Webinar'));
  assert.deepEqual([w.outcome, w.outcomeChangedAt, w.webinar, w.webinarAt], ['', '', 'Yes', '2026-11-10T15:00:00Z']);
  const f = leadService.parseItem(item('Follow-Up'));
  assert.deepEqual([f.outcome, f.outcomeChangedAt, f.webinar], ['Follow-Up', '2026-11-10T15:00:00Z', undefined]);
  assert.equal(leadService.parseItem(item('')).webinar, undefined);

  const snap = require('../src/services/leadSnapshot'), mondayApi = require('../src/services/mondayApi');
  snap._reset();
  const orig = mondayApi.query, log = console.log; console.log = () => {};
  mondayApi.query = async () => ({ boards: [{ items_page: { cursor: null, items: [Object.assign(item('Webinar'), { created_at: '2026-11-01T10:00:00Z' })] } }] });
  try {
    const [l] = await snap.leads();
    assert.deepEqual([l.outcome, l.webinar, l.webinarAt], ['', 'Yes', '2026-11-10T15:00:00Z']);
    const st = status.leadStatus(l, null, Date.parse('2026-11-11T17:00:00Z'));
    assert.deepEqual([st.label, st.tone, st.at], ['Outcome: Webinar', 'blue', Date.parse('2026-11-10T15:00:00Z')]);
  } finally { mondayApi.query = orig; console.log = log; snap._reset(); }
});

test('as read, a Webinar lead is "no outcome" for the consultation side — and still a lead outcome for the Leads side', () => {
  const lead = { id: '5', bookingStatus: 'Booked', bookedSlot: '2026-11-05 10:00', outcome: '', webinar: 'Yes', webinarAt: '2026-11-01T15:00:00Z' };
  assert.equal(require('../src/services/consultationService').packageApplicable(lead).why !== 'outcome', true, 'the consultation package is not refused for "an outcome is set"');
  assert.equal(portal.completedConsultation(lead, '2026-11-11'), null);
  const br = require('../src/services/bookingRemindersService');
  const reason = (br.progressReason || br._internal.progressReason)({ bookingStatus: 'Not Yet', webinar: 'Yes' });
  assert.equal(reason, 'the Outcome is set (Webinar)', 'booking reminders stop, as for any outcome set on a lead');
});
