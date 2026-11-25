'use strict';

// The readable Client ID (2026-11-25): "CL-2026-00042" — format, the strict
// reader of what staff type (review #14), and the CLIENT_IDS switch.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { formatClientId, parseClientId, isClientId, clientIdNumber, CLIENT_ID_RE } = require('../src/utils/clientId');
const features = require('../config/features');

test('formatClientId: CL-<year>-<5 digits>, 6+ digits after 99999; anything unusable is blank', () => {
  assert.equal(formatClientId(2026, 42), 'CL-2026-00042');
  assert.equal(formatClientId('2026', '7'), 'CL-2026-00007');
  assert.equal(formatClientId(2026, 99999), 'CL-2026-99999');
  assert.equal(formatClientId(2027, 100000), 'CL-2027-100000');
  for (const [y, n] of [[2026, 0], [2026, -1], [2026, 1.5], [26, 42], [20260, 42], ['x', 1], [2026, 'abc'], [null, 1], [2026, 10000000]]) {
    assert.equal(formatClientId(y, n), '', `${y}/${n}`);
  }
});

test('isClientId: only the exact stored form', () => {
  assert.ok(isClientId('CL-2026-00042'));
  assert.ok(isClientId('CL-2027-100000'));
  for (const v of ['cl-2026-00042', 'CL-2026-42', ' CL-2026-00042', 'CL-2026-00042 ', 'CL-26-00042', 'CL2026-00042', 'CL-2026-00000', '2026-CL-00042', 'TD-00042', '', null, undefined]) {
    assert.equal(isClientId(v), false, String(v));
  }
  assert.ok(CLIENT_ID_RE.test('CL-2026-00042'));
});

test('parseClientId: CL + optional 4-digit year + the number — every way staff type it', () => {
  const ok = {
    'CL-2026-00042': { n: 42, year: 2026 },
    'cl 2026 42':    { n: 42, year: 2026 },
    'CL-2026-42':    { n: 42, year: 2026 },
    'CL2026-00042':  { n: 42, year: 2026 },
    'CL 2026-00042': { n: 42, year: 2026 },
    'cl.2026.42':    { n: 42, year: 2026 },
    'CL—2026—42':    { n: 42, year: 2026 },
    '  CL-2026-00042  ': { n: 42, year: 2026 },
    'CL42':          { n: 42, year: null },
    'CL 42':         { n: 42, year: null },
    'cl-00042':      { n: 42, year: null },
    'CL#42':         { n: 42, year: null },
    'CL-2027-100000': { n: 100000, year: 2027 },
  };
  for (const [input, want] of Object.entries(ok)) assert.deepEqual(parseClientId(input), want, input);
});

test('parseClientId: a lone digit group after CL is ALWAYS the number (never a year)', () => {
  assert.deepEqual(parseClientId('CL 2026'), { n: 2026, year: null });
  assert.deepEqual(parseClientId('CL2026'), { n: 2026, year: null });
});

test('parseClientId refuses everything else: 2-digit years, three groups, other letters, TD- codes, 0, too long', () => {
  for (const v of ['cl-26-42', 'CL 26 42', 'CL-2026-00042-1', 'CL 2026 42 7', 'TD-12345', 'td 12345', 'TDOT-12345-M1',
    'CLIENT 42', 'CL', 'CL-', 'CL-2026-', 'CL 0', 'CL-2026-0', 'CL202600042', 'CL 12345678', '2026-CL-00042', '42', '00042',
    'Jane CL-2026-00042', 'CL-2026-00042 Jane', 'CL-12345-42', '', null, undefined, {}, 'C L 42']) {
    assert.equal(parseClientId(v), null, String(v));
  }
});

test('clientIdNumber: the number of any readable form, 0 otherwise', () => {
  assert.equal(clientIdNumber('CL-2026-00042'), 42);
  assert.equal(clientIdNumber('cl 2026 42'), 42);
  assert.equal(clientIdNumber('2026-VV-00042'), 0);
  assert.equal(clientIdNumber(''), 0);
});

test('the CLIENT_IDS switch: off unless exactly "report" or "on"; read on every call', () => {
  const was = process.env.CLIENT_IDS;
  try {
    for (const [v, mode] of [[undefined, 'off'], ['', 'off'], ['off', 'off'], ['true', 'off'], ['1', 'off'], ['yes', 'off'], ['report', 'report'], [' REPORT ', 'report'], ['on', 'on'], ['On', 'on']]) {
      if (v === undefined) delete process.env.CLIENT_IDS; else process.env.CLIENT_IDS = v;
      assert.equal(features.clientIdsMode(), mode, String(v));
      assert.equal(features.clientIdsOn(), mode === 'on', String(v));
      assert.equal(features.clientIdsActive(), mode !== 'off', String(v));
    }
  } finally {
    if (was === undefined) delete process.env.CLIENT_IDS; else process.env.CLIENT_IDS = was;
  }
});

test('the Client ID column ids ship configured: three distinct Monday TEXT column ids (made 2026-11-25 by scripts/add-client-id-columns.js --apply)', () => {
  const cfg = require('../src/data/clientsBoard.json');
  const ids = [cfg.columns.clientId, cfg.cmLinkColumns.clientId, cfg.leadLinkColumns && cfg.leadLinkColumns.clientId];
  for (const id of ids) assert.match(String(id), /^text_[a-z0-9]+$/, 'a text column id');
  assert.equal(new Set(ids).size, 3, 'one column per board');
  assert.deepEqual(ids, ['text_mm9ewm14', 'text_mm9ep9bw', 'text_mm9etdaj'], 'Clients (the source of truth), Client Master and Lead Board copies');
  // never one of the item-id / secret columns
  for (const id of ids) assert.ok(!['text_mm5xmeka', 'text_mm5x5dab', 'text_mm0x6haq', 'text_mm47y540'].includes(id));
  // the old item-id columns are untouched — never reused for the readable ID
  assert.equal(cfg.cmLinkColumns.clientAccountId, 'text_mm5xmeka');
  assert.equal(require('../src/data/newLeadsBoard.json').columns.clientAccountId, 'text_mm5x5dab');
  assert.ok(!('clientId' in require('../src/data/newLeadsBoard.json').columns), 'no null id in a column map other code iterates');
});
