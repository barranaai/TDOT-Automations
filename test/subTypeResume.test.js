'use strict';

// Late sub-type resume (user directive 2026-08-11): a paid case whose Case Sub
// Type arrives AFTER the payment trigger was stranded forever — the multi-
// variant gate correctly refused to seed with a blank sub-type, but nothing
// re-ran seeding when the sub-type was set (live: 2026-CEC-PS-064, paid Aug 6,
// sub-type Aug 7, discovered with an empty checklist Aug 11). The Case Sub
// Type webhook now resumes seeding — but ONLY in that exact stranded state.

const test   = require('node:test');
const assert = require('node:assert/strict');

const checklistService = require('../src/services/checklistService');
const mondayApi        = require('../src/services/mondayApi');
const { resumeDeps }   = checklistService._internal;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// Monday stub: answers the state read, records notes, echoes the applied flag.
function mondayStub({ pay = 'Paid', stage = 'Document Collection Started', applied = 'No', appliedAfter = 'Yes', caseRef = '2026-TEST-001', missing = false, failRead = false }) {
  const notes = [];
  const fn = async (q, vars) => {
    if (/create_update/.test(q)) { notes.push(vars.b); return { create_update: { id: '1' } }; }
    if (failRead) throw new Error('monday down');
    if (missing) return { items: [] };
    if (/color_mm0x9fnn/.test(q)) {
      return { items: [{ column_values: [
        { id: 'color_mm0x9fnn', text: pay }, { id: 'color_mm0x8faa', text: stage },
        { id: 'color_mm0xs7kp', text: applied }, { id: 'text_mm142s49', text: caseRef },
      ] }] };
    }
    // the post-seed verification read (applied flag + current sub-type)
    return { items: [{ column_values: [
      { id: 'color_mm0xs7kp', text: appliedAfter }, { id: 'dropdown_mm0x4t91', text: 'CEC Single Applicant' },
    ] }] };
  };
  return { fn, notes };
}

async function run(state) {
  const m = mondayStub(state);
  const seeded = [];
  const restores = [
    stub(mondayApi, 'query', m.fn),
    stub(resumeDeps, 'seed', async (args) => seeded.push(args)),
  ];
  try {
    const r = await checklistService.resumeSeedingAfterSubType({ itemId: '555' });
    return { r, seeded, notes: m.notes };
  } finally { restores.forEach((x) => x()); }
}

test('THE GAP: paid + document collection + no checklist ⇒ seeding resumes', async () => {
  const { r, seeded, notes } = await run({});
  assert.equal(seeded.length, 1, 'seeding runs exactly once');
  assert.equal(String(seeded[0].itemId), '555');
  assert.deepEqual(r, { resumed: true, seeded: true });
  assert.ok(notes.some((n) => /checklist created/i.test(n)), 'staff see that it resumed');
});

test('a join-absorbed first attempt is RETRIED against the settled state', async () => {
  // Payment marked and sub-type set within the same seconds: the first seed
  // call can join an in-flight run that read the PRE-sub-type state and was
  // cleanly gate-blocked. The resume must try once more, not give up silently.
  const { r, seeded } = await run({ appliedAfter: 'No' });
  assert.equal(seeded.length, 2, 'one retry after a non-applied first attempt');
  assert.deepEqual(r, { resumed: true, seeded: false });
});

test('honest reporting: if the seed does not flip the flag, no success note', async () => {
  const { r, notes } = await run({ appliedAfter: 'No' });
  assert.equal(r.seeded, false);
  assert.equal(notes.length, 0, 'no false "created" note');
});

test('the success note names the seeded variant and the correction path', async () => {
  const { notes } = await run({});
  const note = notes.find((n) => /checklist created/i.test(n));
  assert.ok(note);
  assert.match(note, /variant: CEC Single Applicant/, 'staff can spot a wrong-variant seed at a glance');
  assert.match(note, /Re-seed Checklist/, 'and are pointed at the fix');
});

test('never fires outside the stranded state', async () => {
  for (const [state, why] of [
    [{ pay: 'Signed (Unpaid)' }, 'unpaid'],
    [{ pay: 'Alreaday Sent' }, 'automation default ≠ paid'],
    [{ stage: 'Pre-Onboarding' }, 'not in document collection'],
    [{ stage: 'Internal Review' }, 'past document collection'],
    [{ applied: 'Yes' }, 'checklist already seeded — a sub-type EDIT must not auto-pile a second variant'],
    [{ applied: '' }, 'blank applied flag = manually-managed legacy case, never went through the payment flow'],
    [{ caseRef: '' }, 'no case ref yet — the case-type chain owns onboarding (family rows + intake email)'],
    [{ missing: true }, 'item gone'],
  ]) {
    const { r, seeded } = await run(state);
    assert.equal(seeded.length, 0, `must not seed when ${why}`);
    assert.ok(r.skipped, `reports the skip (${why})`);
  }
});

test('fails CLOSED when the state cannot be read', async () => {
  const { r, seeded } = await run({ failRead: true });
  assert.equal(seeded.length, 0);
  assert.match(r.skipped, /read failed/);
});

test('the webhook only reacts to a REAL sub-type arrival', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/mondayWebhook'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const i = code.indexOf('CASE_SUB_TYPE_COL_ID) {');
  assert.ok(i > 0, 'the sub-type branch exists');
  const branch = code.slice(i, i + 700);
  assert.match(branch, /newSub && newSub !== prevSub/, 'blank writes and same-value re-saves are ignored');
  assert.match(branch, /resumeSeedingAfterSubType/, 'and it calls the guarded resume');
  assert.match(code, /CASE_SUB_TYPE_COL_ID\s*=\s*'dropdown_mm0x4t91'/, 'pinned to the real column id');
});

test('the Re-seed button shares the in-flight collapse with automatic seeding', () => {
  // The old staff instruction "set the Sub Type, then flip Re-seed → Run" now
  // races the automatic resume — two concurrent reconciles would each read
  // "no rows" and both create the full checklist.
  const src = require('fs').readFileSync(require.resolve('../src/services/checklistService'), 'utf8');
  const fn = src.slice(src.indexOf('async function reseedByCaseRef'), src.indexOf('// ─── Late sub-type resume'));
  assert.match(fn, /_dcsInFlight\.has\(flightKey\)/, 'the button waits out an in-flight automatic seed');
  assert.match(fn, /_dcsInFlight\.set\(flightKey/, 'and registers its own run so the automatic path joins it');
});

test('the resume never sends the intake email (already sent by the payment path)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/checklistService'), 'utf8');
  const fn = src.slice(src.indexOf('async function resumeSeedingAfterSubType'), src.indexOf('module.exports'));
  assert.ok(!/sendIntakeEmail|emailService/.test(fn), 'no client email from the resume — double-emailing is worse than none');
});
