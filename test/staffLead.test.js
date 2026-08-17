'use strict';

// Staff-entered phone-in lead ("direct leads", meeting 2026-08-13): a normal
// funnel lead with the full intake wiring, NO case, NO retainer intent, with
// the direct-client modal's duplicate contract (409 + matches → allowDuplicate).

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc         = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const VALID = { fullName: 'Phone Caller', email: 'caller@x.com', phone: '4165550001', sourceChannel: 'Phone' };

test('validation: name/email/phone required; junk source falls back to Phone; case type must be canonical', async () => {
  const restore = [stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] }))];
  try {
    for (const bad of [
      { ...VALID, fullName: '' },
      { ...VALID, email: 'not-an-email' },
      { ...VALID, phone: '12' },
      { ...VALID, caseTypeInterest: 'Made Up Type' },
    ]) {
      await assert.rejects(svc.createStaffLead(bad), (e) => e.badRequest === true);
    }
  } finally { restore.reverse().forEach((x) => x()); }
});

test('duplicate contract: matches → 409-shaped conflict; allowDuplicate creates anyway', async () => {
  const created = [];
  const restore = [
    stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [{ id: '1', name: 'Existing' }] })),
    stub(leadService, 'createLead', async (f) => { created.push(f); return { id: '9100', ...f }; }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(svc.createStaffLead(VALID), (e) => e.conflict === true && e.matches.leads.length === 1);
    assert.equal(created.length, 0, 'nothing created without the explicit choice');
    const r = await svc.createStaffLead({ ...VALID, allowDuplicate: true });
    assert.equal(r.leadId, '9100');
    assert.equal(created.length, 1);
  } finally { restore.reverse().forEach((x) => x()); }
});

test('creates a NORMAL funnel lead: existing source label, no case, no consultant, note carried', async () => {
  let created = null; const updates = [];
  const restore = [
    stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { created = f; return { id: '9101', ...f }; }),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await svc.createStaffLead({ ...VALID, sourceChannel: 'WhatsApp', caseTypeInterest: 'Inland Spousal Sponsorship', note: 'Wants citizenship help' });
    assert.equal(r.leadId, '9101');
    assert.equal(created.sourceChannel, 'WhatsApp', 'existing board label only');
    assert.equal(created.caseTypeInterest, undefined,
      'canonical labels do NOT exist on the interest dropdown — create_item has no label minting, so the type must never ride the creation write');
    assert.ok(updates.some((u) => u.id === '9101' && u.f.caseTypeInterest === 'Inland Spousal Sponsorship'),
      'the type follows via updateLead (create_labels_if_missing — the sanctioned label path)');
    assert.equal(created.situationDescription, 'Wants citizenship help');
    assert.equal(created.confirmedCaseType, undefined, 'no case-type confirmation — this is a plain lead');
    assert.equal(created.assignedConsultant, undefined, 'no consultant pin');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('UI + route wiring (source contract)', () => {
  const fs = require('fs');
  const page = fs.readFileSync(require.resolve('../src/routes/adminLeads'), 'utf8');
  assert.match(page, /id="btn-add-lead"/);
  assert.match(page, /\/api\/leads\/create/);
  assert.match(page, /allowDuplicate=true/, '409 → create-anyway resubmit');
  assert.match(page, /AL_ALLOW=false; var m=alEl\('al-matches'\)/, 'identity edits disarm a stale create-anyway (different person must be re-scanned)');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /app\.post\('\/api\/leads\/create'/);
  assert.match(server, /err\.conflict\)\s+return res\.status\(409\)/, 'duplicate contract surfaces as 409 + matches');
});
