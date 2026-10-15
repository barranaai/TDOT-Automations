'use strict';

// TEMPORARY (2026-10-15): the guard on the switch-on test of the automatic
// consultation package. With the switch OFF, only the allow-listed test lead,
// only while armed, and only to the armed inbox. Removed with the test route.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const cs          = require('../src/services/consultationService');
const leadService = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('switch OFF: an un-armed lead, a non-allow-listed lead and an armed lead with another inbox are all refused; nothing is read or sent for the first two', async () => {
  const prev = process.env.CONSULT_PACKAGE_AUTO_SEND; delete process.env.CONSULT_PACKAGE_AUTO_SEND;
  let reads = 0, sends = 0;
  const restore = [
    stub(leadService, 'getLead', async (id) => { reads++; return { id, email: 'Kamal@tdotimm.com', bookingStatus: 'Booked' }; }),
    stub(cs, 'sendConsultationPackage', async () => { sends++; return { ok: true }; }),
  ];
  try {
    cs._resetSentMemory();
    assert.deepEqual(await cs.autoSendConsultationPackage('12641191022', { trigger: 'payment' }), { status: 'disabled' }, 'not armed');
    assert.deepEqual(await cs.autoSendConsultationPackage('999', { trigger: 'payment' }), { status: 'disabled' });
    assert.equal(reads, 0);
    assert.throws(() => cs.armPackageTest('999', 'x@y.co'), /not a package test lead/);
    cs.armPackageTest('12641191022', 'faran.test@example.com');
    const r = await cs.autoSendConsultationPackage('12641191022', { trigger: 'payment' });
    assert.deepEqual(r, { status: 'disabled', reason: 'test inbox mismatch' }, 'the lead still points at another inbox');
    assert.equal(sends, 0);
  } finally { cs.disarmPackageTest('12641191022'); restore.forEach((x) => x()); if (prev !== undefined) process.env.CONSULT_PACKAGE_AUTO_SEND = prev; }
});

test('switch OFF, armed, the lead points at the armed inbox: the normal path runs (a blank address HOLDS); disarm stops it again', async () => {
  const prev = process.env.CONSULT_PACKAGE_AUTO_SEND; delete process.env.CONSULT_PACKAGE_AUTO_SEND;
  const writes = [];
  const future = new Date(Date.now() + 5 * 86400000);
  const slot = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(future)} 11:00`;
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, email: 'Faran.Test@Example.com', bookingStatus: 'Booked', bookedSlot: slot, meetingType: 'In-person', residentialAddress: '' })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(require('../src/services/mondayApi'), 'query', async () => ({})),
  ];
  try {
    cs._resetSentMemory();
    cs.armPackageTest('12641191022', 'faran.test@example.com');
    const r = await cs.autoSendConsultationPackage('12641191022', { trigger: 'payment' });
    assert.deepEqual(r, { status: 'held', reason: 'blank-address' });
    assert.match(writes[0].consultCountersign, /"packageHeld":"blank-address"/);
    cs.disarmPackageTest('12641191022');
    assert.deepEqual(await cs.autoSendConsultationPackage('12641191022', { trigger: 'address' }), { status: 'disabled' });
  } finally { cs.disarmPackageTest('12641191022'); restore.forEach((x) => x()); if (prev !== undefined) process.env.CONSULT_PACKAGE_AUTO_SEND = prev; }
});

test('the test route: admin key only, the allow-listed lead only, the inbox checked before the trigger; restore clears what the package writes', () => {
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const i = src.indexOf("app.post('/admin/test/consult-package/:leadId'");
  assert.ok(i > 0);
  const block = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(block, /if \(!viewer \|\| !viewer\.isAdmin\) return res\.status\(401\)/);
  assert.match(block, /if \(!cs\.PACKAGE_TEST_LEADS\.has\(leadId\)\) return res\.status\(403\)/);
  assert.match(block, /String\(lead\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== want\) return res\.status\(409\)/);
  assert.match(block, /clearKeys: \['bookingStatus', 'bookedSlot', 'meetingType', 'consultAgreementSent', 'consultCountersign'\]/);
  assert.ok(!/confirmSlot|onSlotConfirmed|createSquareBooking|createTeams/.test(block), 'never the payment chain (Square appointment / Teams)');
  // review: never a time a real client holds; a signed / submitted test stops the cleanup with a manual list
  assert.match(block, /bs\.claimsOnSlot\(await bs\.readSlotClaims\(\{ strict: true \}\), fields\.bookedSlot/);
  assert.match(block, /if \(\(action === 'void-envelope' \|\| action === 'restore'\) && manual\.length\) return res\.status\(409\)/);
  assert.match(block, /if \(status\.includes\('COMPLET'\)\) return res\.status\(409\)/);
  assert.deepEqual([...cs.PACKAGE_TEST_LEADS], ['12641191022']);
});
