'use strict';

// The staff Client Portal link column comes back when a row loses it
// (2026-CEC-PS-080: moved to another board and back on 2026-10-05; three other
// cases: cleared by hand). Never a new access code; never old-format cases.

const test   = require('node:test');
const assert = require('node:assert/strict');

const heal = require('../src/services/portalLinkHealService');

const LINK = 'link_mm2vta5', TOKEN = 'text_mm0x6haq', REF = 'text_mm142s49';
const item = (id, ref, token, url) => ({ id, column_values: [
  { id: REF, text: ref, value: ref ? JSON.stringify(ref) : null },
  { id: TOKEN, text: token, value: token ? JSON.stringify(token) : null },
  { id: LINK, text: url ? 'Open Client Portal' : '', value: url ? JSON.stringify({ url, text: 'Open Client Portal' }) : null },
] });

function world(rows, { changeBeforeWrite = {}, failWrite = [] } = {}) {
  const board = new Map(rows.map((r) => [r.id, heal.readRow(r)]));
  const calls = { writes: [], notes: [] };
  const real = { ...heal.io };
  Object.assign(heal.io, {
    allRows: async () => [...board.values()].map((r) => ({ ...r })),
    oneRow: async (id) => { if (changeBeforeWrite[id]) Object.assign(board.get(id) || {}, changeBeforeWrite[id]); const r = board.get(id); return r ? { ...r } : null; },
    writeLink: async (id, url) => { if (failWrite.includes(id)) throw new Error('Monday 503'); calls.writes.push([id, url]); board.get(id).link = url; },
    postNote: async (id, body) => { calls.notes.push([id, body]); },
  });
  return { calls, board, restore: () => Object.assign(heal.io, real) };
}

test('picks only rows with a current-format case number, an access code and no link', () => {
  const rows = [
    item('1', '2026-CEC-PS-080', 'tok1', ''),              // the case: heal
    item('2', '2026-CEC-EE-058', 'tok2', ''),              // heal
    item('3', '2026-SCLWP-006', 'tok3', 'https://x/client/2026-SCLWP-006?t=tok3&staff=1'),   // has a link
    item('4', '2026-CEC-PS-030', '', ''),                  // no access code: never created here
    item('5', '2165', 'tok5', ''),                         // old-format number: left alone
    item('6', '', '', ''),                                  // a lead, not a case
  ].map(heal.readRow);
  assert.deepEqual(heal.rowsToHeal(rows).map((r) => r.caseRef), ['2026-CEC-PS-080', '2026-CEC-EE-058']);
  assert.equal(heal.linkUrl('{}'), ''); assert.equal(heal.linkUrl('not json'), '');
});

test('puts the link back with the SAME url the app writes at case creation, re-reading each row first; a note on the row', async () => {
  const w = world([item('101', '2026-CEC-PS-080', 'abc DEF', ''), item('102', '2026-SCLWP-006', 'xyz', '')]);
  try {
    const r = await heal.healMissingPortalLinks();
    assert.deepEqual(r.healed, ['2026-CEC-PS-080', '2026-SCLWP-006']);
    const want = require('../src/services/clientPortalService').buildPortalUrl({ caseRef: '2026-CEC-PS-080', accessToken: 'abc DEF', staff: true });
    assert.equal(w.calls.writes[0][1], want);
    assert.match(want, /\/client\/2026-CEC-PS-080\?t=abc%20DEF&staff=1$/);
    assert.equal(w.calls.notes.length, 2); assert.match(w.calls.notes[0][1], /Client Portal link put back/);
    const again = await heal.healMissingPortalLinks();
    assert.deepEqual([again.due, again.healed.length], [0, 0], 'nothing left to do');
  } finally { w.restore(); }
});

test('a row that changed between the scan and the write is left alone (got a link, lost its code, or a different case number)', async () => {
  const w = world([item('1', '2026-A-B-001', 't1', ''), item('2', '2026-A-B-002', 't2', ''), item('3', '2026-A-B-003', 't3', '')], {
    changeBeforeWrite: { '1': { link: 'https://already' }, '2': { token: '' }, '3': { caseRef: '2026-A-B-999' } },
  });
  try {
    const r = await heal.healMissingPortalLinks();
    assert.deepEqual(r.healed, []);
    assert.deepEqual(r.skipped.map((s) => s.why), ['already has a link', 'no access code', 'case number changed']);
    assert.equal(w.calls.writes.length, 0);
  } finally { w.restore(); }
});

test('a failed write is reported and the run carries on; at most 25 rows a run (the rest next run)', async () => {
  const many = Array.from({ length: 30 }, (_, i) => item(String(200 + i), `2026-CEC-PS-${String(100 + i).padStart(3, '0')}`, 't' + i, ''));
  const w = world(many, { failWrite: ['200'] });
  try {
    const r = await heal.healMissingPortalLinks();
    assert.equal(r.due, 30); assert.equal(r.more, 5);
    assert.equal(r.failed.length, 1); assert.equal(r.healed.length, 24);
  } finally { w.restore(); }
});

test('dry run lists what it would do and writes nothing; the switch off (PORTAL_LINK_HEAL=0) stops the real run', async () => {
  const w = world([item('1', '2026-CEC-PS-080', 't', '')]);
  try {
    const d = await heal.healMissingPortalLinks({ dryRun: true });
    assert.deepEqual(d.wouldHeal, ['2026-CEC-PS-080']); assert.equal(w.calls.writes.length, 0);
    process.env.PORTAL_LINK_HEAL = 'off';
    const off = await heal.healMissingPortalLinks();
    assert.equal(off.off, true); assert.equal(w.calls.writes.length, 0);
    const dryWhileOff = await heal.healMissingPortalLinks({ dryRun: true });
    assert.deepEqual(dryWhileOff.wouldHeal, ['2026-CEC-PS-080'], 'a dry run still reports');
  } finally { delete process.env.PORTAL_LINK_HEAL; w.restore(); }
});

test('wired: hourly in the scheduler, and POST /api/portal-links/heal (admin key, ?dry=1) in the server', () => {
  const fs = require('fs');
  const sch = fs.readFileSync(require.resolve('../src/services/scheduler.js'), 'utf8');
  assert.match(sch, /cron\.schedule\('27 \* \* \* \*', \(\) =>\s*require\('\.\/portalLinkHealService'\)\.healMissingPortalLinks\(\)/);
  const srv = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(srv, /app\.post\('\/api\/portal-links\/heal'/);
  assert.ok(srv.indexOf("app.use('/api', requireApiKey)") < srv.indexOf("app.post('/api/portal-links/heal'"), 'behind the admin key');
  const svc = fs.readFileSync(require.resolve('../src/services/portalLinkHealService.js'), 'utf8');
  assert.ok(!/ensureAccessToken|generateToken/.test(svc), 'never creates an access code');
});
