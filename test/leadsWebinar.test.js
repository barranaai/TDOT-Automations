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
  const rows = [{ id: '1', webinar: true }, { id: '2', webinar: false }, { id: '3' }, { id: '4', webinar: true, webinarEmailDay: '2026-11-12' }];
  const on = LT.emptyState(); on.sel.webinar = ['yes'];
  assert.deepEqual(LT.filterRows(rows, on).map((r) => r.id), ['1', '4']);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'webinar').map((x) => [x.label, x.count]), [['Webinar', 2], ['Not webinar', 2]]);
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

// The Webinar email (Faran 2026-11-12): on a Webinar lead the lead page's card is "Webinar Email", not the booking invite.
const web = require('../src/services/webinarEmailService');
function withWebIo(fn) {
  const sent = [], notes = [], orig = { ...web.io };
  web.io.sendEmail = async (m) => { sent.push(m); };
  web.io.note = async (id, body) => { notes.push([id, body]); };
  web.io.leadNotes = async (id) => notes.filter((n) => n[0] === id).map((n) => ({ text_body: n[1].replace(/<[^>]+>/g, '') })).reverse();
  web.io.now = () => new Date('2026-11-12T17:00:00Z');
  const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
  return Promise.resolve().then(() => fn({ sent, notes })).finally(() => { Object.assign(web.io, orig); console.log = log; console.error = err; });
}

test('the standard webinar text: no promises, no "reply", no link or date; staff text replaces it; an empty box means the standard text', () => {
  const t = web.STANDARD_TEXT;
  assert.ok(t.length > 200 && t.length < web.MAX_LEN);
  assert.ok(!/\breply\b/i.test(t), 'the mailbox is not read — never "reply"');
  assert.ok(!/https?:|guarantee|will be approved|eligible/i.test(t));
  assert.match(t, /info@tdotimm\.com/);
  assert.match(t, /paid/i);
  assert.equal(web.bodyText('  '), t);
  assert.equal(web.bodyText(' Hello\r\nthere '), 'Hello\nthere');
  const html = web.emailHtml({ firstName: '<Asha>', text: 'One & two\n\nThree <b>' });
  assert.ok(html.includes('Hi &lt;Asha&gt;,') && html.includes('<p>One &amp; two</p><p>Three &lt;b&gt;</p>'));
  assert.ok(!/Choose your consultation time|consultation fee|\/book\//i.test(html), 'no booking button, no fee, no booking link');
  assert.ok(html.includes("Please don't reply to this email"));
});

test('send: only to a lead whose outcome is Webinar and that has an email; the email goes first, then the note that the Leads list reads back', async () => {
  await withWebIo(async ({ sent, notes }) => {
    await assert.rejects(web.send({ leadId: '5', lead: { email: 'a@x.co', fullName: 'Asha Rao' } }), (e) => e.badRequest && /Outcome is “Webinar”/.test(e.message));
    await assert.rejects(web.send({ leadId: '5', lead: { webinar: 'Yes', email: ' ' } }), (e) => e.badRequest && /No client email/.test(e.message));
    assert.equal(sent.length + notes.length, 0);
    const r = await web.send({ leadId: '5', lead: { webinar: 'Yes', email: 'a@x.co', fullName: 'Asha Rao' }, message: '', by: 'Melanie' });
    assert.deepEqual(r, { ok: true, to: 'a@x.co', day: '2026-11-12', noted: true });
    assert.deepEqual([sent[0].to, sent[0].subject], ['a@x.co', web.SUBJECT]);
    assert.ok(sent[0].html.includes('Hi Asha,') && sent[0].html.includes('upcoming immigration webinar'));
    assert.deepEqual(notes, [['5', '📧 <b>Webinar email sent</b> to a@x.co on 2026-11-12 by Melanie.']]);
    assert.deepEqual(status.classify(notes[0][1].replace(/<[^>]+>/g, '')), { kind: 'webinar' });
    await assert.rejects(web.send({ leadId: '5', lead: { webinar: 'Yes', email: 'a@x.co' }, message: 'x'.repeat(web.MAX_LEN + 1) }), (e) => e.badRequest);
    // review 2026-11-12: "already sent" is read from THIS lead's own notes — a second send needs the person's "again"
    assert.equal(await web.lastSent('5'), '2026-11-12');
    assert.equal(await web.lastSent('77'), '');
    await assert.rejects(web.send({ leadId: '5', lead: { webinar: 'Yes', email: 'a@x.co', fullName: 'Asha Rao' } }), (e) => e.badRequest && e.alreadySent === '2026-11-12' && /already sent to this client on 2026-11-12/.test(e.message));
    assert.equal(sent.length, 1, 'nothing went the second time');
    await web.send({ leadId: '5', lead: { webinar: 'Yes', email: 'a@x.co', fullName: 'Asha Rao' }, again: true });
    assert.equal(sent.length, 2);
    // the board's "Unnamed Lead" placeholder is never a greeting
    await web.send({ leadId: '8', lead: { webinar: 'Yes', email: 'u@x.co', fullName: '', name: 'Unnamed Lead' } });
    assert.ok(sent[2].html.includes('Hi there,'));
    // the notes cannot be read: not known — never "not sent"
    web.io.leadNotes = async () => { throw new Error('monday down'); };
    const w = console.warn; console.warn = () => {};
    try { assert.equal(await web.lastSent('5'), null); } finally { console.warn = w; }
  });
});

test('only the app\'s own note counts as a send: a remark or typed update that mentions the words does not', () => {
  for (const yes of ['📧 Webinar email sent to a@x.co on 2026-11-12 by Melanie.', 'Webinar email sent to a@x.co on 2026-11-12.']) assert.deepEqual(status.classify(yes), { kind: 'webinar' }, yes);
  for (const no of ['📝 [Remark · Melanie] Client says no webinar email sent to her, please check', 'webinar email sent', 'I think the Webinar email sent to a@x.co on Monday bounced', '⚠️ Webinar email NOT sent — the email could not be sent.', '⚠️ Webinar email: not confirmed — the email system did not answer'])
    assert.notEqual(status.classify(no).kind, 'webinar', no);
  assert.equal(status.classify('📝 [Remark · Melanie] Client says no webinar email sent to her, please check').kind, 'remark');
});

test('send: the note cannot be saved — the email still went, staff are told to add a note; no answer from the email system is "not confirmed", never "nothing went"', async () => {
  await withWebIo(async ({ sent, notes }) => {
    let tries = 0; web.io.note = async () => { tries++; throw new Error('monday down'); };
    const w = console.warn; console.warn = () => {};
    try {
      const r = await web.send({ leadId: '9', lead: { webinar: 'Yes', email: 'n@x.co', fullName: 'Nia' }, again: true });
      assert.deepEqual([r.noted, tries, sent.length], [false, 2, 1]);
    } finally { console.warn = w; }
    web.io.note = async (id, body) => { notes.push([id, body]); };
    web.io.sendEmail = async () => { throw new Error('timeout of 30000ms exceeded'); };   // no .response: the outcome is not known
    await assert.rejects(web.send({ leadId: '10', lead: { webinar: 'Yes', email: 't@x.co', fullName: 'Tom' }, again: true }),
      (e) => e.sendFailed && /not known whether the Webinar email went out/.test(e.message) && !/nothing went/.test(e.message));
    assert.match(notes[0][1], /Webinar email: not confirmed/);
  });
});

test('send: an email that could not go out says so plainly, leaves a "NOT sent" note, and never a "sent" one', async () => {
  await withWebIo(async ({ notes }) => {
    web.io.sendEmail = async () => { throw Object.assign(new Error('Payment Required'), { response: { status: 402 } }); };   // the mail service answered no
    await assert.rejects(web.send({ leadId: '6', lead: { webinar: 'Yes', email: 'b@x.co', fullName: 'Bo' }, by: 'Soniya' }),
      (e) => e.sendFailed && !e.badRequest && /could not be sent right now — nothing went to the client/.test(e.message) && !/Payment Required|credit/i.test(e.message));
    assert.equal(notes.length, 1);
    assert.match(notes[0][1], /Webinar email NOT sent/);
    assert.equal(status.classify(notes[0][1].replace(/<[^>]+>/g, '')).kind, '', 'a failed send is not read as sent');
  });
});

test('the action and the pages: webinarEmail is validated; the route says a failed send plainly; the lead page has the Webinar Email card and hides the booking part', () => {
  assert.deepEqual(portal.validateAction('webinarEmail', ' Hi \r\n there '), { ok: true, normalized: { text: 'Hi \n there', again: false } });
  assert.deepEqual(portal.validateAction('webinarEmail', null), { ok: true, normalized: { text: '', again: false } });
  assert.deepEqual(portal.validateAction('webinarEmail', JSON.stringify({ text: 'Hi', again: true })), { ok: true, normalized: { text: 'Hi', again: true } });
  assert.deepEqual(portal.validateAction('webinarEmail', '{not json').normalized.text, '{not json', 'plain text that starts with a brace is text');
  assert.equal(portal.validateAction('webinarEmail', JSON.stringify({ text: 5 })).ok, false);
  assert.deepEqual(portal.validateAction('webinarEmail', { text: 'Yo', again: true }).normalized, { text: 'Yo', again: true });
  assert.equal(portal.validateAction('webinarEmail', ['x']).ok, false);
  assert.equal(portal.validateAction('webinarEmail', 'x'.repeat(2001)).ok, false);
  const server = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.ok(server.includes('if (err.sendFailed) return res.status(502).json({ error: err.message });'));
  const lead = require('../src/routes/adminLeads').buildLeadDetailHTML('1');
  for (const s of ['id="inv-webinar"', 'id="inv-booking"', 'id="webinar-msg"', 'id="btn-webinar-send"', "document.getElementById('inv-booking').style.display=WEBINAR?'none':'block';",
    "document.getElementById('inv-title').textContent=WEBINAR?'Webinar Email':'Booking invite email';", "doAction(this,'webinarEmail',ask,JSON.stringify({ text:document.getElementById('webinar-msg').value, again:!!(sent||unknown) }),'web-msg')"]) assert.ok(lead.includes(s), s);
  // the booking part (consultant, booking message, record payment, the booking buttons, the reminders line) all sit inside the hidden wrapper
  const a = lead.indexOf('<div id="inv-booking">'), b = lead.indexOf('<div class="card-t">', a);
  for (const s of ['id="inv-consultant"', 'id="invite-msg"', 'id="record-pay-row"', 'id="btn-save-msg"', 'id="btn-invite"', 'a reminder 48 hours and 5 days']) { const i = lead.indexOf(s); assert.ok(i > a && i < b, s); }
  assert.ok(lead.indexOf('id="inv-webinar"') < a);
  for (const m of lead.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(m[1]);
  const list = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(list.includes('Email sent ') && !list.includes('Email not sent yet'), 'the list says when it knows a send — it never claims "not sent"');
});

test('the Leads list and the lead page read the send back from the notes copy', () => {
  const row = (id) => ({ id, webinar: 'Yes', webinarAt: '2026-11-10T15:00:00Z' });
  status.record('901', 'Webinar email sent to a@x.co on 2026-11-11.', Date.parse('2026-11-11T16:00:00Z'));
  status.record('901', 'Webinar email sent to a@x.co on 2026-11-12 by Melanie.', Date.parse('2026-11-12T16:00:00Z'));
  const a = status.activityFor('901');
  assert.equal(a.webinars.length, 2);
  assert.equal(status.activityFor('902'), null);
  assert.deepEqual(row('901').webinar, 'Yes');
});
