'use strict';
// The Client ID as the Otter recording title (Faran 2026-11-26: "this same client id should be used for otter
// to get the consultation recording, instead of the recording code" — and "Keep TD- code as backup" for the
// clients who have no Client ID). The title reader, how a Client ID finds the consultation (the same same-day
// rule as a code), the conflicts, the reader's own read of the Lead Board copy, and what staff see.
// PURE or stubbed — no network. All names, emails, ids and Client IDs are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const M = require('../src/services/otterMatch');
const { recordingCode, otterTitleOf } = require('../src/utils/recordingCode');
const D = require('../src/services/clientIdDisplay');
const mondayApi = require('../src/services/mondayApi');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const LONG = 'x'.repeat(400);
const at = (wall) => String(Math.round(M.wallToMs(wall) / 1000));
const rec = (title, wall = '2026-11-12 14:03', extra = {}) => ({ otterId: 'ot_CID111', title, startTime: at(wall), summary: LONG, transcript: LONG, ...extra });
const NOW = M.wallToMs('2026-11-12 18:00');
const run = (r, list, opts = {}) => M.match(r, list, { now: NOW, ...opts });
const C = (id, name, email, bookedSlot, clientId = '') => ({ id: String(id), name, email, clientId, bookedSlot, createdAt: '2026-11-01T12:00:00Z', consultant: 'Consultant One' });
function stub(obj, key, fn) { const keep = obj[key]; obj[key] = fn; return () => { obj[key] = keep; }; }

// Priya has a Client ID and two consultations (today and last week); Omar has one, booked today too; Lena has none.
const PRIYA = C('9100012345', 'Priya Example', 'priya@example.com', '2026-11-12 14:00', 'CL-2026-00042');
const PRIYA_OLD = C('9100054321', 'Priya Example', 'priya@example.com', '2026-11-05 10:00', 'CL-2026-00042');
const OMAR = C('9100022222', 'Omar Sample', 'omar@example.com', '2026-11-12 15:00', 'CL-2026-00077');
const LENA = C('9100033333', 'Lena Test', 'lena@example.com', '2026-11-12 16:00', '');
const ALL = [PRIYA, PRIYA_OLD, OMAR, LENA];

// ── the title reader ─────────────────────────────────────────────────────────
test('the title reader: a Client ID in every typed form (parseClientId rules), with or without the year', () => {
  const y = { n: 42, year: 2026 }, n = { n: 42, year: null };
  const cases = [
    ['CL-2026-00042', y], ['cl-2026-00042', y], ['CL 2026 42', y], ['CL2026-00042', y], ['CL-2026-42', y], ['CL–2026–00042', y],
    ['CL42', n], ['cl 42', n], ['CL-00042', n], ['Cl#42', n], ['Consultation CL-2026-00042 today', y], ['CL-2026-00042.txt', y],
  ];
  for (const [t, want] of cases) {
    const r = M.readTitle(t);
    assert.deepEqual(r.clientId, want, t);
    assert.equal(r.kinds[0], 'clientId', t);
    assert.equal(r.code, '', t + ': a Client ID is never a TD code');
  }
  // not a Client ID: other letters, a letter before, a number of 0 or of 8 digits, an email holding "cl42"
  for (const t of ['CLIENT 42', 'Clara 42', 'MCL 42', 'CL 0', 'CL 12345678', 'TD-00042', 'cl42@example.com', '2026-CL-00042']) {
    assert.equal(M.readTitle(t).clientId, null, t);
  }
  assert.equal(M.readTitle('cl42@example.com').email, 'cl42@example.com', 'an email stays an email');
  // a name beside it is still read as the name; a TD code beside it is still read as the code
  assert.deepEqual(M.readTitle('CL-2026-00042 Priya Example'), { clientId: y, code: '', email: '', name: 'priya example', kinds: ['clientId', 'name'] });
  assert.deepEqual(M.readTitle('cl 42 TD-12345').kinds, ['clientId', 'code']);
  // the same number typed twice is one token (the year kept); a second number, or a second year, is a second token
  assert.deepEqual(M.readTokens('CL 42 CL-2026-00042').clientIds, [y]);
  assert.deepEqual(M.readTokens('CL 42 CL 77').clientIds, [n, { n: 77, year: null }]);
  assert.deepEqual(M.readTokens('CL-2025-00042 CL-2026-00042').clientIds, [{ n: 42, year: 2025 }, y]);
});

// ── resolution: the same same-day rule as a code ────────────────────────────
test('a Client ID files on that person\'s ONE consultation booked on the recording\'s Toronto day — by its Lead Board copy', () => {
  for (const t of ['CL-2026-00042', 'cl 42', 'CL42', 'CL 2026 42', 'Consultation with Priya CL-2026-00042']) {
    const d = run(rec(t), ALL);
    assert.deepEqual([d.decision, d.leadId, d.by, d.reasonKey], ['file', PRIYA.id, 'clientId', 'matched'], t);
  }
  // the other consultation of the same person (another day) is a suggestion, never the one filed
  const d = run(rec('CL42'), ALL);
  assert.ok(d.candidates.includes(PRIYA_OLD.id));
  // an evening recording is still the same Toronto day
  assert.equal(run(rec('CL42', '2026-11-12 20:30'), ALL).leadId, PRIYA.id);
});

test('a Client ID never files on a guess: no consultation that day, two that day, nobody\'s number, a year that is not the person\'s', () => {
  // the next day: the person has no consultation booked then
  let d = run(rec('CL42', '2026-11-13 14:03'), ALL, { now: M.wallToMs('2026-11-13 18:00') });
  assert.deepEqual([d.decision, d.reasonKey, d.reason], ['needs', 'clientIdNone', 'The Client ID in the title has no consultation booked on the day of the recording']);
  assert.ok(d.candidates.includes(PRIYA.id), 'the person\'s consultations are suggested');
  // two consultations of the person on the same day
  const twice = [...ALL, C('9100099999', 'Priya Example', 'priya@example.com', '2026-11-12 17:00', 'CL-2026-00042')];
  d = run(rec('CL42'), twice);
  assert.deepEqual([d.decision, d.reasonKey], ['needs', 'clientIdMany']);
  assert.deepEqual(d.candidates.slice(0, 2).sort(), [PRIYA.id, '9100099999'].sort());
  // a number nobody has — a mistyped number is another person: never filed, even when a name or a time fits
  d = run(rec('CL 43 Priya Example'), ALL);
  assert.deepEqual([d.decision, d.reasonKey, d.reason], ['needs', 'clientIdUnknown', 'No consultation on the list has this Client ID — check the number, or choose the client below']);
  assert.ok(d.candidates.includes(PRIYA.id), 'the name and the time still suggest');
  // a typed year must be the year of the person's ID: never filed; the same number is suggested first
  d = run(rec('CL-2025-00042'), ALL);
  assert.deepEqual([d.decision, d.reasonKey, d.candidates[0]], ['needs', 'clientIdYear', PRIYA.id]);
  // a copy that is not a STORED Client ID ("cl 42" typed into the box by hand) never matches
  d = run(rec('CL42'), [{ ...PRIYA, clientId: 'cl 42' }]);
  assert.deepEqual([d.decision, d.reasonKey], ['needs', 'clientIdUnknown']);
  // no Client ID copy read at all (the column not made / not in the read): needs, never a guess
  d = run(rec('CL42'), ALL.map((c) => ({ ...c, clientId: '' })));
  assert.deepEqual([d.decision, d.reasonKey], ['needs', 'clientIdUnknown']);
  // the other holds still apply: a very short recording and one first seen a month later are never filed
  assert.deepEqual([run(rec('CL42', undefined, { summary: 'hi', transcript: '' }), ALL).decision], ['needs']);
  assert.equal(run(rec('CL42'), ALL, { firstSeen: NOW + 40 * 86400000 }).reasonKey, 'old');
  // a recording already on a consultation is never matched again
  assert.equal(run(rec('CL42'), [{ ...PRIYA, otherIds: [], otterIds: ['ot_CID111'] }, OMAR]).reasonKey, 'already');
});

// ── conflicts ───────────────────────────────────────────────────────────────
test('the title must not point at two people: a Client ID and a TD code / email / name of someone else → a person decides', () => {
  const omarCode = recordingCode(OMAR.id), priyaCode = recordingCode(PRIYA.id), priyaOldCode = recordingCode(PRIYA_OLD.id);
  // Priya's Client ID + Omar's code / email / name
  for (const t of [`CL42 ${omarCode}`, `${omarCode} CL42`, 'CL42 omar@example.com', 'CL42 Omar Sample']) {
    const d = run(rec(t), ALL);
    assert.deepEqual([d.decision, d.reasonKey], ['needs', 'titleDisagrees'], t);
    assert.ok(d.candidates.includes(PRIYA.id) && d.candidates.includes(OMAR.id), t + ': both suggested');
  }
  // two different Client IDs, or the same number with two different years
  for (const t of ['CL42 CL77', 'CL-2025-00042 CL-2026-00042']) assert.deepEqual([run(rec(t), ALL).decision, run(rec(t), ALL).reasonKey], ['needs', 'titleDisagrees'], t);
  // the same person, said twice: files
  for (const t of [`CL42 ${priyaCode}`, `${priyaCode} CL-2026-00042`, 'CL42 priya@example.com', 'CL-2026-00042 Priya Example', 'CL 42 CL-2026-00042']) {
    const d = run(rec(t), ALL);
    assert.deepEqual([d.decision, d.leadId], ['file', PRIYA.id], t);
  }
  // the person's OTHER consultation's code: another consultation — kept to the old rule (a person decides)
  assert.equal(run(rec(`CL42 ${priyaOldCode}`), ALL).reasonKey, 'titleDisagrees');
  // a token that is nobody's does not block
  assert.equal(run(rec('CL42 follow up'), ALL).decision, 'file');
  // the Client ID decides: a Client ID that does not fit is never overruled by a code that does
  const d = run(rec(`CL 43 ${omarCode}`), ALL);
  assert.deepEqual([d.decision, d.reasonKey], ['needs', 'clientIdUnknown']);
  assert.ok(d.candidates.includes(OMAR.id), 'the code still suggests');
});

// ── review 2026-11-26 (HIGH): a Client ID is never read SHORTER than it was typed ──
test('REVIEW: only part of a Client ID read is never filed — "CL-26-00042" is not client 26; the whole title waits', () => {
  // the people a short read would land on, each with a consultation booked that same day
  const P26 = C('9100026026', 'Kofi Sample', 'kofi@example.com', '2026-11-12 13:00', 'CL-2026-00026');
  const P2026 = C('9100020260', 'Mei Sample', 'mei@example.com', '2026-11-12 13:30', 'CL-2026-02026');
  const P416 = C('9100041600', 'Ana Sample', 'ana@example.com', '2026-11-12 14:30', 'CL-2026-00416');
  const list = [...ALL, P26, P2026, P416];
  const titles = ['CL-26-00042', 'CL-2026/00042', 'CL 2026, 00042', 'CL 2026 / 42', 'CL-2026-12345678', 'CL 416-555-1234',
    'Client CL 416 555 1234', 'CL 12345678', 'CL−2026−00042', 'Consultation CL-26-00042 today'];
  for (const t of titles) {
    const tk = M.readTokens(t);
    assert.deepEqual(tk.clientIds, [], t + ': no shorter Client ID is read');
    assert.equal(tk.clientIdUnreadable, 1, t + ': counted as unreadable');
    const d = run(rec(t), list);
    assert.notEqual(d.decision, 'file', t);
    assert.deepEqual([d.decision, d.reasonKey], ['needs', 'clientIdUnreadable'], t);
    assert.equal(d.reason, M.REASONS.clientIdUnreadable);
  }
  // another token in the same title never decides instead: an exact email, a code, a name that would each file alone
  for (const t of ['CL-26-00042 omar@example.com', `CL-2026/00042 ${recordingCode(OMAR.id)}`, 'Omar Sample CL 2026, 00042', 'CL 12345678 omar@example.com']) {
    assert.deepEqual([run(rec(t), list).decision, run(rec(t), list).reasonKey], ['needs', 'clientIdUnreadable'], t);
  }
  // an unreadable piece never becomes part of a name
  assert.equal(M.readTokens('Priya CL-26-00042').name, 'priya');
  // still read as before: a case number after a space, a full ID, a year-less ID, a case number alone
  assert.deepEqual(M.readTokens('cl 42 2026-VV-006').clientIds, [{ n: 42, year: null }]);
  assert.deepEqual(M.readTokens('CL-2026-00042 2026-VV-006').clientIds, [{ n: 42, year: 2026 }]);
  assert.deepEqual([run(rec('CL-2026-00042 2026-VV-006'), list).decision, run(rec('CL-2026-00042 2026-VV-006'), list).leadId], ['file', PRIYA.id]);
  assert.deepEqual([M.readTokens('2026-CL-42').clientIdUnreadable, M.readTokens('ref 2026-CL-00042').clientIdUnreadable], [0, 0]);
  assert.deepEqual(M.readTokens('CL 42 CL 77').clientIdUnreadable, 0);
  // the strip says why in plain words (PLAIN spreads M.REASONS)
  assert.match(M.REASONS.clientIdUnreadable, /could not be read/);
});

// ── no Client ID: the TD- code is the backup ────────────────────────────────
test('a client with no Client ID: the TD- code (and email, name) work exactly as before', () => {
  let d = run(rec(recordingCode(LENA.id), '2026-11-12 16:02'), ALL);
  assert.deepEqual([d.decision, d.leadId, d.by], ['file', LENA.id, 'code']);
  // and for a client WITH an ID the code still works too
  d = run(rec(recordingCode(PRIYA.id)), ALL);
  assert.deepEqual([d.decision, d.leadId, d.by], ['file', PRIYA.id, 'code']);
  d = run(rec('lena@example.com', '2026-11-12 16:02'), ALL);
  assert.deepEqual([d.decision, d.leadId, d.by], ['file', LENA.id, 'email']);
  d = run(rec('Lena Test', '2026-11-12 16:02'), ALL);
  assert.deepEqual([d.decision, d.leadId, d.by], ['file', LENA.id, 'name']);
  d = run(rec(''), ALL);
  assert.deepEqual([d.decision, d.reason], ['needs', 'No Client ID, code, email or name was typed as the title']);
});

// ── what staff type: one rule ───────────────────────────────────────────────
test('otterTitleOf: the stored Client ID when there is one, else the TD- code; anything else in the box falls back to the code', () => {
  assert.equal(otterTitleOf('9100012345', 'CL-2026-00042'), 'CL-2026-00042');
  assert.equal(otterTitleOf('9100012345', ''), 'TD-12345');
  assert.equal(otterTitleOf('9100012345', null), 'TD-12345');
  for (const junk of ['cl 42', 'CL-26-42', '18435600042', 'undefined']) assert.equal(otterTitleOf('9100012345', junk), 'TD-12345', junk);
  assert.equal(otterTitleOf('', ''), '');
  // what the matcher reads back from what was shown: the shown Client ID files on that consultation
  assert.equal(run(rec(otterTitleOf(PRIYA.id, PRIYA.clientId)), ALL).leadId, PRIYA.id);
  assert.equal(run(rec(otterTitleOf(LENA.id, LENA.clientId), '2026-11-12 16:02'), ALL).leadId, LENA.id);
});

// ── the Lead Board copy, read where the record and the lists read the lead ──
test('leadService.parseItem carries the Lead Board Client ID copy — only when the read had that column, a stored ID only; the shared lead copy keeps its shape', async () => {
  const leadService = require('../src/services/leadService');
  const snap = require('../src/services/leadSnapshot');
  const COL = 'text_cid_lead_t';
  D._resetForTests(); D._setConfigForTests({ boardId: '1', columns: { clientId: 'x' }, cmLinkColumns: {}, leadLinkColumns: { clientId: COL } });
  try {
    assert.equal(leadService.parseItem({ id: '1', name: 'A', column_values: [{ id: COL, text: 'CL-2026-00042' }] }).clientId, 'CL-2026-00042');
    assert.equal(leadService.parseItem({ id: '1', name: 'A', column_values: [{ id: COL, text: 'cl 42' }] }).clientId, '', 'not a stored ID: nothing');
    assert.equal('clientId' in leadService.parseItem({ id: '1', name: 'A', column_values: [] }), false, 'a read without the column never makes a blank');
    // the shared lead copy: the ID in the server-only part, never a key on the lead (its shape is as before)
    const back = stub(mondayApi, 'query', async () => ({ boards: [{ items_page: { cursor: null, items: [{ id: '11', name: 'Ann', created_at: '2026-11-01T00:00:00Z', column_values: [{ id: COL, text: 'CL-2026-00042', value: null }] }] } }] }));
    try {
      const leads = await snap.io.fetchLeads();
      assert.equal(leads[0][snap.CONTACT].clientId, 'CL-2026-00042');
      assert.equal(Object.keys(leads[0]).includes('clientId'), false);
    } finally { back(); }
  } finally { D._resetForTests(); }
  D._resetForTests(); D._setConfigForTests({ boardId: '1', columns: {}, cmLinkColumns: {}, leadLinkColumns: { clientId: null } });
  try {
    assert.equal('clientId' in leadService.parseItem({ id: '1', name: 'A', column_values: [{ id: COL, text: 'CL-2026-00042' }] }), false, 'column not made: nothing');
  } finally { D._resetForTests(); }
});

test('the reader\'s consultations carry each one\'s Client ID from the same board read as the email (no extra Monday call)', async () => {
  const S = require('../src/services/otterReaderService');
  const portal = require('../src/services/consultantPortalService');
  const snap = require('../src/services/leadSnapshot');
  const lead = (id, email, clientId) => { const l = { id }; Object.defineProperty(l, snap.CONTACT, { value: { email, phone: '', clientId }, enumerable: false }); return l; };
  const back = [
    stub(portal, 'getConsultationsBoard', async () => ({ consultations: [{ id: '1', name: 'Priya Example', bookedSlot: '2026-11-12 14:00' }], completed: [{ id: '2', name: 'Lena Test', bookedSlot: '2026-11-11 10:00' }] })),
    stub(snap, 'getLeadSnapshot', async () => ({ leads: [lead('1', 'priya@example.com', 'CL-2026-00042'), lead('2', 'lena@example.com', '')] })),
    stub(mondayApi, 'query', async () => { throw new Error('no Monday call expected'); }),
  ];
  try {
    const list = await S.io.consultations();
    assert.deepEqual(list.map((c) => [c.id, c.email, c.clientId]), [['1', 'priya@example.com', 'CL-2026-00042'], ['2', 'lena@example.com', '']]);
  } finally { back.reverse().forEach((r) => r()); }
});

test('the entry on the lead says "matched by Client ID"', () => {
  const S = require('../src/services/otterReaderService');
  const html = S.buildSummaryEntry({ otterId: 'ot_CID111', startTime: at('2026-11-12 14:02'), summary: 'Spoke about options.' }, { by: 'clientId' });
  assert.ok(html.includes('· matched by Client ID'), html.slice(0, 160));
  assert.ok(!html.includes('CL-'), 'the entry never carries the typed title');
});

// ── what staff see ──────────────────────────────────────────────────────────
test('Consultations rows carry the Client ID from the shared lead copy (the code stays as the backup)', async () => {
  const portal = require('../src/services/consultantPortalService');
  const snap = require('../src/services/leadSnapshot');
  snap._reset();
  const L = (id, clientId) => {
    const l = { id: String(id), name: `Lead ${id}`, fullName: `Lead ${id}`, createdAt: '2026-11-01T12:00:00Z', bookingStatus: 'Booked', bookedSlot: '2026-12-20 11:00' };
    Object.defineProperty(l, snap.CONTACT, { value: { email: '', phone: '', clientId }, enumerable: false });
    return l;
  };
  const back = stub(snap.io, 'fetchLeads', async () => [L(9100012345, 'CL-2026-00042'), L(9100033333, '')]);
  try {
    const b = await portal.getConsultationsBoard({ now: new Date('2026-11-12T16:00:00Z') });
    const rows = Object.fromEntries(b.consultations.map((r) => [r.id, r]));
    assert.deepEqual([rows['9100012345'].clientId, rows['9100012345'].recCode], ['CL-2026-00042', 'TD-12345']);
    assert.deepEqual([rows['9100033333'].clientId, rows['9100033333'].recCode], ['', 'TD-33333']);
  } finally { back(); snap._reset(); }
});

test('the consultation record, the Consultations list, the case notes panel and the Otter strip show the Client ID first, else the code', () => {
  const { buildDetailHTML, buildQueueHTML } = require('../src/routes/adminConsultation');
  const detail = buildDetailHTML('9100012345');
  assert.ok(detail.includes('<span class="rc-l" id="c-code-l">Type in Otter</span>'));
  assert.ok(detail.includes("var otterText=String(d.clientId||d.recordingCode||'');"));
  assert.ok(detail.includes("d.clientId?'Type in Otter':'Type in Otter (no Client ID yet)'"));
  const queue = buildQueueHTML();
  assert.ok(queue.includes("(c.clientId?'<span class=\"rec-code\" title=\"Client ID: type it as the Otter recording title"));
  // the case notes panel: the card carries the Client ID beside the code; a direct retainer has neither
  const { cardOf } = require('../src/routes/caseNotesRoutes');
  assert.deepEqual([cardOf({ leadId: '11', kind: 'booked', clientId: 'CL-2026-00042' }).clientId, cardOf({ leadId: '11', kind: 'booked', clientId: 'CL-2026-00042' }).recordingCode], ['CL-2026-00042', 'TD-00011']);
  assert.equal(cardOf({ leadId: '11', kind: 'booked', clientId: 'junk' }).clientId, '');
  assert.deepEqual([cardOf({ leadId: '13', kind: 'direct-retainer', clientId: 'CL-2026-00042' }).clientId, cardOf({ leadId: '13', kind: 'direct-retainer' }).recordingCode], ['', '']);
  const widget = require('../src/routes/caseNotesWidget').CASE_NOTES_JS;
  assert.ok(widget.includes('var otter = String(c.clientId || c.recordingCode);'));
  // the Otter strip: the suggestion shows what to type for that client; the search finds a Client ID too
  const strip = read('src/routes/otterMatchWidget.js');
  assert.ok(strip.includes('cid.toLowerCase().indexOf(q) < 0') && strip.includes('code: cid || code'));
  assert.ok(read('src/services/otterReaderService.js').includes('code: otterTitleOf(c.id, c.clientId)'));
  // never on a page a client opens
  for (const f of fs.readdirSync(path.join(__dirname, '../src/routes')).filter((x) => /^(client|booking|public|portal|lead|consultationForm|intake)/i.test(x))) {
    assert.ok(!/otterTitleOf|Type in Otter/.test(read('src/routes/' + f)), f);
  }
});

test('the reader logs no Client ID typed in a title (ids and counts only)', () => {
  const src = read('src/services/otterReaderService.js') + read('src/services/otterMatch.js');
  for (const m of src.matchAll(/console\.(?:log|warn|error)\(([^;]*)\);/g)) {
    assert.ok(!/clientId|title\.|tokens\./.test(m[1]), m[1]);
  }
});
