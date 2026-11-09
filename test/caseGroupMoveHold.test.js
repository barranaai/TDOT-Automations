'use strict';
// Faran 2026-11-09: no automatic move out of Pending while the monthly-group move is on hold.
// The old target "topics" was deleted from the board on 2026-08-21, so every move failed silently.
const test = require('node:test');
const assert = require('node:assert');

test('the active-group setting is empty (the deleted "topics" group is never targeted again)', () => {
  const cfg = require('../src/data/clientMasterBoard.json');
  assert.equal(cfg.activeGroupId, '', 'no active group while the monthly-group move is on hold');
  assert.notEqual(cfg.activeGroupId, 'topics');
  assert.equal(cfg.pendingGroupId, 'group_mm6a68f5', 'the Pending group is unchanged');
});

test('moveCaseToActiveGroup makes no Monday call, returns false and says so in the log', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const orig = mondayApi.query; let calls = 0;
  mondayApi.query = async () => { calls++; return {}; };
  const logs = []; const origLog = console.log; console.log = (m) => logs.push(String(m));
  try {
    const gate = require('../src/services/caseGateService');
    assert.equal(await gate.moveCaseToActiveGroup('12345'), false);
    assert.equal(calls, 0, 'no move_item_to_group is sent');
    assert.ok(logs.some((l) => /CM 12345: signed \+ paid — stays in Pending/.test(l)), 'the skip is logged, not silent');
  } finally { mondayApi.query = orig; console.log = origLog; }
});

test('moving a case BACK to Pending (undo of a payment) still works — only the forward move is held', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const orig = mondayApi.query; const sent = [];
  mondayApi.query = async (q, v) => { sent.push({ q, v }); return { move_item_to_group: { id: v.i } }; };
  const origLog = console.log; console.log = () => {};
  try {
    const gate = require('../src/services/caseGateService');
    assert.equal(await gate.moveCaseToGroup('999', gate.pendingGroupId(), 'pending group'), true);
    assert.equal(sent.length, 1); assert.match(sent[0].q, /move_item_to_group/); assert.equal(sent[0].v.g, 'group_mm6a68f5');
  } finally { mondayApi.query = orig; console.log = origLog; }
});
