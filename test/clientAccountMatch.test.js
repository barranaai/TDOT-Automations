'use strict';

// Client-account identity matching. The rules protect real people's files:
// auto-link ONLY on email + name + compatible DOB; spouses sharing an email
// stay two people; conflicting DOBs veto; phone-only is a weak candidate;
// ambiguity always creates a new account rather than merging.

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc       = require('../src/services/clientAccountService');
const mondayApi = require('../src/services/mondayApi');

const cfg = require('../src/data/clientsBoard.json');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// Build a Clients-board row in the wire shape findMatches parses.
function accountRow({ id, name, email = '', phone = '', dob = '', status = 'Active' }) {
  return { id, name, column_values: [
    { id: cfg.columns.primaryEmail, text: email },
    { id: cfg.columns.phone, text: phone },
    { id: cfg.columns.dateOfBirth, text: dob },
    { id: cfg.columns.status, text: status },
  ] };
}

// ─── Pure normalizers ─────────────────────────────────────────────────────────

test('normalizeEmail: folds case, trims, rejects non-emails', () => {
  assert.equal(svc.normalizeEmail('  Jane.Doe@Example.COM '), 'jane.doe@example.com');
  assert.equal(svc.normalizeEmail('not-an-email'), '');
  assert.equal(svc.normalizeEmail(''), '');
});

test('normalizePhone: digits-only, NA 11-digit leading-1 stripped, short numbers unusable', () => {
  assert.equal(svc.normalizePhone('+1 (416) 555-0100'), '4165550100');
  assert.equal(svc.normalizePhone('416-555-0100'), '4165550100');
  assert.equal(svc.normalizePhone('+44 20 7946 0958'), '442079460958');
  assert.equal(svc.normalizePhone('12345'), '', 'too short to be a match key');
});

// ─── classifyMatch ────────────────────────────────────────────────────────────

const JANE = { email: 'jane@x.com', phone: '4165550100', fullName: 'Jane Doe', dob: '1990-01-01' };

test('exact: email + normalized name match, DOB compatible (absent on one side is fine)', () => {
  assert.equal(svc.classifyMatch(JANE, { email: 'JANE@X.COM', phone: '', name: ' jane  doe ', dob: '' }).confidence, 'exact');
  assert.equal(svc.classifyMatch(JANE, { email: 'jane@x.com', phone: '', name: 'Jane Doe', dob: '1990-01-01' }).confidence, 'exact');
});

test('spouse trap: same email, DIFFERENT name → review (never auto-link)', () => {
  const r = svc.classifyMatch(JANE, { email: 'jane@x.com', phone: '', name: 'John Doe', dob: '' });
  assert.equal(r.confidence, 'review');
  assert.ok(r.reasons.some((x) => /different name/.test(x)));
});

test('Sr/Jr veto: email + name match but BOTH DOBs present and different → review, not exact', () => {
  const r = svc.classifyMatch(JANE, { email: 'jane@x.com', phone: '', name: 'Jane Doe', dob: '2015-06-06' });
  assert.equal(r.confidence, 'review');
  assert.ok(r.reasons.some((x) => /DIFFERENT date of birth/.test(x)));
});

test('phone-only: candidate for staff, never exact', () => {
  const r = svc.classifyMatch(JANE, { email: 'other@y.com', phone: '+14165550100', name: 'Jane Doe', dob: '' });
  assert.equal(r.confidence, 'review');
  assert.ok(r.reasons.some((x) => /phone-only/.test(x)));
});

test('none: nothing shared', () => {
  assert.equal(svc.classifyMatch(JANE, { email: 'a@b.co', phone: '9055551234', name: 'Jane Doe', dob: '' }).confidence, 'none');
});

// ─── findMatches / findOrCreate (stubbed Monday) ──────────────────────────────

test('findMatches: merged rows are excluded; email + phone hits dedupe', async () => {
  const rows = [
    accountRow({ id: '1', name: 'Jane Doe', email: 'jane@x.com', phone: '+14165550100' }),
    accountRow({ id: '2', name: 'Old Jane', email: 'jane@x.com', status: 'Merged' }),
  ];
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: rows } };
    return {};
  });
  try {
    const m = await svc.findMatches({ email: 'jane@x.com', phone: '4165550100', fullName: 'Jane Doe' });
    assert.deepEqual(m.map((x) => x.id), ['1'], 'merged row dropped, duplicate hit deduped');
    assert.equal(m[0].confidence, 'exact');
  } finally { restore(); }
});

test('findOrCreate: exact match links WITHOUT creating', async () => {
  let created = 0;
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/create_item/.test(q)) { created++; return { create_item: { id: '99' } }; }
    if (/items_page_by_column_values/.test(q)) {
      return { items_page_by_column_values: { items: [accountRow({ id: '7', name: 'Jane Doe', email: 'jane@x.com' })] } };
    }
    return {};
  });
  try {
    const r = await svc.findOrCreate({ email: 'jane@x.com', fullName: 'Jane Doe', source: 'direct' });
    assert.equal(r.clientId, '7');
    assert.equal(r.created, false);
    assert.equal(created, 0);
  } finally { restore(); }
});

test('findOrCreate: shared-email spouse creates a NEW account and reports the review candidate', async () => {
  let createdCols = null;
  const spouseRow = accountRow({ id: '7', name: 'John Doe', email: 'family@x.com' });
  const restore = stub(mondayApi, 'query', async (q, vars) => {
    if (/create_item/.test(q)) { createdCols = JSON.parse(vars.c); return { create_item: { id: '42' } }; }
    if (/items_page_by_column_values/.test(q)) {
      // both before-create and reconcile queries see the spouse + (post-create) our row
      const items = [spouseRow];
      if (createdCols) items.push(accountRow({ id: '42', name: 'Jane Doe', email: 'family@x.com' }));
      return { items_page_by_column_values: { items } };
    }
    return {};
  });
  try {
    const r = await svc.findOrCreate({ email: 'family@x.com', fullName: 'Jane Doe', source: 'handoff' });
    assert.equal(r.clientId, '42', 'a NEW account — never merged into the spouse');
    assert.equal(r.created, true);
    assert.equal(r.reviewCandidates.length, 1);
    assert.equal(r.reviewCandidates[0].id, '7');
    assert.equal(createdCols[cfg.columns.primaryEmail].email, 'family@x.com', 'email stored lowercased');
    assert.equal(createdCols[cfg.columns.source], 'handoff');
  } finally { restore(); }
});

test('findOrCreate: concurrent double-call for the same person resolves to ONE account', async () => {
  let created = 0;
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/create_item/.test(q)) { created++; return { create_item: { id: String(100 + created) } }; }
    if (/items_page_by_column_values/.test(q)) {
      return { items_page_by_column_values: { items: created ? [accountRow({ id: String(100 + created), name: 'Jane Doe', email: 'jane@x.com' })] : [] } };
    }
    return {};
  });
  try {
    const [a, b] = await Promise.all([
      svc.findOrCreate({ email: 'jane@x.com', fullName: 'Jane Doe' }),
      svc.findOrCreate({ email: 'jane@x.com', fullName: 'Jane Doe' }),
    ]);
    assert.equal(created, 1, 'the in-flight map coalesced the second call');
    assert.equal(a.clientId, b.clientId);
  } finally { restore(); }
});

// ─── stampClientAccount (Phase 2 forward-only stamping) ──────────────────────

const handoff = require('../src/services/handoffService');

test('stampClientAccount: finds-or-creates the account and links case + lead', async () => {
  const calls = [];
  const restore = [
    stub(svc, 'findOrCreate', async (a) => { calls.push(['foc', a.email, a.source]); return { clientId: '55', created: true }; }),
    stub(svc, 'linkCase', async (id, o) => calls.push(['case', id, o.cmItemId])),
    stub(svc, 'linkLead', async (id, leadId) => calls.push(['lead', id, leadId])),
  ];
  try {
    await handoff.stampClientAccount({ id: '500', fullName: 'Jane Doe', email: 'jane@x.com', phone: '4165550100' }, '900');
    assert.deepEqual(calls, [['foc', 'jane@x.com', 'handoff'], ['case', '55', '900'], ['lead', '55', '500']]);
  } finally { restore.forEach((x) => x()); }
});

test('stampClientAccount: a staff-chosen account on the lead is RESPECTED (no findOrCreate, no re-stamp)', async () => {
  const calls = [];
  const restore = [
    stub(svc, 'findOrCreate', async () => { throw new Error('must not run — staff already chose'); }),
    stub(svc, 'linkCase', async (id, o) => calls.push(['case', id, o.cmItemId])),
    stub(svc, 'linkLead', async () => { throw new Error('lead already stamped by the modal'); }),
  ];
  try {
    await handoff.stampClientAccount({ id: '500', fullName: 'Jane Doe', email: 'jane@x.com', clientAccountId: '77' }, '900');
    assert.deepEqual(calls, [['case', '77', '900']]);
  } finally { restore.forEach((x) => x()); }
});

test('stampClientAccount: NEVER throws — a registry failure must not block the handoff', async () => {
  const restore = [stub(svc, 'findOrCreate', async () => { throw new Error('monday down'); })];
  try {
    await handoff.stampClientAccount({ id: '500', fullName: 'X', email: 'x@x.com' }, '900');
  } finally { restore.forEach((x) => x()); }
});

test('linkLead: stamps the lead AND appends the account\'s Leads relation (existing links kept)', async () => {
  const leadService = require('../src/services/leadService');
  const writes = [];
  const restore = [
    stub(leadService, 'updateLead', async (id, f) => writes.push(['stamp', id, f.clientAccountId])),
    stub(mondayApi, 'query', async (q, vars) => {
      if (/items\(ids/.test(q)) return { items: [{ column_values: [{ value: JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 111 }] }) }] }] };
      if (/change_multiple_column_values/.test(q)) { writes.push(['relation', JSON.parse(vars.c)]); return {}; }
      return {};
    }),
  ];
  try {
    await svc.linkLead('55', '222');
    assert.deepEqual(writes[0], ['stamp', '222', '55']);
    const rel = writes.find((w) => w[0] === 'relation')[1];
    const ids = rel[cfg.columns.leads].item_ids.sort();
    assert.deepEqual(ids, [111, 222], 'the new lead is APPENDED — the existing link survives');
  } finally { restore.forEach((x) => x()); }
});
