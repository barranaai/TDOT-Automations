'use strict';

// Lead group placement (found live 2026-08-17): create_item WITHOUT group_id
// drops the item into the board's TOP group. Since the "Direct retainer
// clients" group was added at the top (2026-07-30), every website and staff
// lead was filed among the walk-in retainer clients — exactly what staff were
// looking at when they reported the leads board. Funnel leads must always name
// the funnel group; only an explicit groupId (the direct-retainer flow) wins.

const test   = require('node:test');
const assert = require('node:assert/strict');

const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const boardCfg    = require('../src/data/newLeadsBoard.json');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

async function createCapturingGroup(opts) {
  const calls = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      calls.push({ q, v });
      if (/create_item/.test(q)) return { create_item: { id: '999' } };
      return {};
    }),
    stub(require('../src/services/leadTokenService'), 'ensureToken', async () => 'LEAD-x'),
  ];
  try {
    await leadService.createLead({ fullName: 'T', email: 't@x.com' }, opts);
    const create = calls.find((c) => /create_item/.test(c.q));
    return { usesGroup: /group_id: \$groupId/.test(create.q), groupId: create.v.groupId };
  } finally { restore.reverse().forEach((r) => r()); }
}

test('the funnel group is recorded and is NOT the direct-retainer group', () => {
  assert.ok(boardCfg.funnelGroupId, 'funnelGroupId must be configured');
  assert.notEqual(boardCfg.funnelGroupId, boardCfg.directRetainerGroupId,
    'funnel leads and walk-in retainer clients must not share a group');
});

test('a plain lead (website / staff Add-lead) lands in the FUNNEL group', async () => {
  const r = await createCapturingGroup(undefined);
  assert.equal(r.usesGroup, true, 'create_item must name a group — never rely on the board default');
  assert.equal(r.groupId, boardCfg.funnelGroupId);
});

test('an explicit groupId still wins (direct-retainer flow)', async () => {
  const r = await createCapturingGroup({ groupId: boardCfg.directRetainerGroupId });
  assert.equal(r.groupId, boardCfg.directRetainerGroupId);
});
