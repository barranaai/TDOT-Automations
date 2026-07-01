'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { routeConsultant } = require('../config/consultantRouting');

test('Express Entry → Shafoli when CRS > 470', () => {
  const r = routeConsultant({ serviceRequired: 'Express Entry profile', crsScore: '475' });
  assert.equal(r.key, 'shafoli');
});

test('Express Entry → Shermin when CRS ≤ 470', () => {
  assert.equal(routeConsultant({ serviceRequired: 'Express Entry ITA and eAPR', crsScore: '460' }).key, 'shermin');
  assert.equal(routeConsultant({ serviceRequired: 'Express Entry profile', crsScore: '470' }).key, 'shermin'); // not strictly >
});

test('Express Entry with no CRS → Shermin, flagged for verification', () => {
  const r = routeConsultant({ serviceRequired: 'Express Entry profile' });
  assert.equal(r.key, 'shermin');
  assert.equal(r.needsVerify, true);
});

test('PNP / H&C / Refugee → always Shafoli (no score involved)', () => {
  assert.equal(routeConsultant({ serviceRequired: 'PNP or OINP' }).key, 'shafoli');
  assert.equal(routeConsultant({ serviceRequired: 'Humanitarian and compassionate' }).key, 'shafoli');
  assert.equal(routeConsultant({ serviceRequired: 'Refugee claim' }).key, 'shafoli');
});

test('everything else → Shermin', () => {
  assert.equal(routeConsultant({ serviceRequired: 'Study permit' }).key, 'shermin');
  assert.equal(routeConsultant({ serviceRequired: 'Work permit' }).key, 'shermin');
  assert.equal(routeConsultant({ serviceRequired: 'Visitor visa or TRV' }).key, 'shermin');
  assert.equal(routeConsultant({}).key, 'shermin'); // nothing known
});

test('falls back to case type when no intake service', () => {
  // CEC = Express Entry family → CRS-gated: no CRS → Shermin; CRS > 470 → Shafoli
  assert.equal(routeConsultant({ confirmedCaseType: 'CEC' }).key, 'shermin');
  assert.equal(routeConsultant({ confirmedCaseType: 'CEC', crsScore: '480' }).key, 'shafoli');
  // PNP / H&C case types → Shafoli (no score)
  assert.equal(routeConsultant({ confirmedCaseType: 'OINP' }).key, 'shafoli');
  assert.equal(routeConsultant({ confirmedCaseType: 'H & C' }).key, 'shafoli');
  // other types → Shermin
  assert.equal(routeConsultant({ confirmedCaseType: 'Inland Spousal Sponsorship' }).key, 'shermin');
  assert.equal(routeConsultant({ confirmedCaseType: 'LMIA Based WP' }).key, 'shermin');
});

test('removal / enforcement order → always Shafoli, overriding case type + CRS', () => {
  // would normally be Shermin (EE low CRS / generic service / no signal) — override wins
  assert.equal(routeConsultant({ serviceRequired: 'Express Entry profile', crsScore: '400', removalOrder: 'Yes' }).key, 'shafoli');
  assert.equal(routeConsultant({ serviceRequired: 'Study permit', removalOrder: 'Yes' }).key, 'shafoli');
  assert.equal(routeConsultant({ removalOrder: 'Yes' }).key, 'shafoli');
  assert.match(routeConsultant({ removalOrder: 'Yes' }).reason, /removal|enforcement/i);
  // only an explicit "Yes" triggers it
  assert.equal(routeConsultant({ serviceRequired: 'Study permit', removalOrder: 'No' }).key, 'shermin');
  assert.equal(routeConsultant({ serviceRequired: 'Study permit', removalOrder: 'Not sure' }).key, 'shermin');
});

test('result carries the Square team-member id', () => {
  assert.ok(routeConsultant({ serviceRequired: 'PNP or OINP' }).teamMemberId);
  assert.match(routeConsultant({ serviceRequired: 'Study permit' }).reason, /general/i);
});
