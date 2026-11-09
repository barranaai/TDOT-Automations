'use strict';

// Staff roster (Faran 2026-11-09, step 3 decisions 2-3): "Prajawal" and
// "Deeksha" are the right spellings, Arpit/Monica/Anna join the list, and the
// Monday name "Kamalpreet K Grewal" saves as "Kamal". No free text.

const test   = require('node:test');
const assert = require('node:assert/strict');

function fresh(env) {
  const saved = process.env.PORTAL_STAFF;
  if (env === undefined) delete process.env.PORTAL_STAFF; else process.env.PORTAL_STAFF = env;
  delete require.cache[require.resolve('../config/portalStaff')];
  const m = require('../config/portalStaff');
  if (saved === undefined) delete process.env.PORTAL_STAFF; else process.env.PORTAL_STAFF = saved;
  delete require.cache[require.resolve('../config/portalStaff')];
  return m;
}

test('the default list has the new spellings and the three new owners', () => {
  const m = fresh(undefined);
  assert.deepEqual(m.PORTAL_STAFF, ['Gauri', 'Kamal', 'Asmita', 'Prajawal', 'Melanie', 'Deeksha', 'Arpit', 'Monica', 'Anna']);
  assert.equal(m.onRoster('Prajwal'), false);
  assert.equal(m.onRoster('Diksha'), false);
  for (const n of ['Prajawal', 'Deeksha', 'Arpit', 'Monica', 'Anna']) assert.equal(m.onRoster(n), true, n);
  assert.equal(m.onRoster('someone typed'), false);
});

test('Monday names map to the roster name', () => {
  const m = fresh(undefined);
  assert.equal(m.rosterNameFor('Kamalpreet K Grewal'), 'Kamal');
  assert.equal(m.rosterNameFor('Prajawal Gurung'), 'Prajawal');
  assert.equal(m.rosterNameFor('Deeksha Sharma'), 'Deeksha');
  assert.equal(m.rosterNameFor('Arpit X'), 'Arpit');
  assert.equal(m.rosterNameFor('Monica Paola'), 'Monica');
  assert.equal(m.rosterNameFor('Nobody Here'), 'Nobody Here');
});

test('the Kamal alias only fires when Kamal is on the roster', () => {
  const m = fresh('Gauri,Melanie');
  assert.equal(m.rosterNameFor('Kamalpreet K Grewal'), 'Kamalpreet K Grewal');
});

test('consultants are still added once', () => {
  const m = fresh(undefined);
  const r = m.staffRoster();
  assert.equal(new Set(r).size, r.length);
  assert.ok(r.length >= m.PORTAL_STAFF.length);
});
