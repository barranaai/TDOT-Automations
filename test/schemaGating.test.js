'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/services/checklistService');
const { isSchemaDrivenEnabled } = _internal;

// Save/restore env around each assertion.
function withEnv(env, fn) {
  const saved = {
    SCHEMA_DRIVEN_SEEDING:   process.env.SCHEMA_DRIVEN_SEEDING,
    SCHEMA_DRIVEN_ALLOWLIST: process.env.SCHEMA_DRIVEN_ALLOWLIST,
  };
  Object.assign(process.env, env);
  // Ensure keys not in `env` are cleared, not inherited.
  for (const k of ['SCHEMA_DRIVEN_SEEDING', 'SCHEMA_DRIVEN_ALLOWLIST']) {
    if (!(k in env)) delete process.env[k];
  }
  try { fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('OFF by default — no env set', () => {
  withEnv({}, () => {
    assert.equal(isSchemaDrivenEnabled('Supervisa', 'Parents'), false);
  });
});

test('master switch alone enables all registered schemas', () => {
  withEnv({ SCHEMA_DRIVEN_SEEDING: 'true' }, () => {
    assert.equal(isSchemaDrivenEnabled('Supervisa', 'Parents'), true);
    assert.equal(isSchemaDrivenEnabled('Study Permit', 'Inside'), true);
  });
});

test('accepts "1" as the master switch too', () => {
  withEnv({ SCHEMA_DRIVEN_SEEDING: '1' }, () => {
    assert.equal(isSchemaDrivenEnabled('Supervisa', 'Parents'), true);
  });
});

test('allowlist restricts to listed pairs only', () => {
  withEnv({ SCHEMA_DRIVEN_SEEDING: 'true', SCHEMA_DRIVEN_ALLOWLIST: 'Supervisa:Parents' }, () => {
    assert.equal(isSchemaDrivenEnabled('Supervisa', 'Parents'), true);
    assert.equal(isSchemaDrivenEnabled('Study Permit', 'Inside'), false);
  });
});

test('allowlist is case-insensitive and space-tolerant', () => {
  withEnv({ SCHEMA_DRIVEN_SEEDING: 'true', SCHEMA_DRIVEN_ALLOWLIST: ' supervisa:parents , study permit:inside ' }, () => {
    assert.equal(isSchemaDrivenEnabled('Supervisa', 'Parents'), true);
    assert.equal(isSchemaDrivenEnabled('Study Permit', 'Inside'), true);
    assert.equal(isSchemaDrivenEnabled('TRV', 'Standard'), false);
  });
});

test('master switch OFF overrides any allowlist', () => {
  withEnv({ SCHEMA_DRIVEN_ALLOWLIST: 'Supervisa:Parents' }, () => {
    assert.equal(isSchemaDrivenEnabled('Supervisa', 'Parents'), false);
  });
});
