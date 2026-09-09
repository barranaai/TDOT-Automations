'use strict';

// Residential address on an EXISTING lead (Gauri 2026-09-04, point 07).
//
// Every new lead has required an address since 2026-09-04 (fd030b3); leads
// created before that — and any typo — had nowhere to be corrected, while the
// consultation agreement and the retainer print that line. The lead page and
// the consultation page now carry an address box wired to ONE action,
// saveResidentialAddress, through the existing /api/consultation/:id/action.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const cps         = require('../src/services/consultantPortalService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('validate: lines are kept (the agreement prints them), runs of spaces collapse; too short or too long is refused', () => {
  assert.deepEqual(cps.validateAction('saveResidentialAddress', '  12 Main St,\r\n  Toronto ON  M5V 1A1, Canada \n\n'), { ok: true, normalized: '12 Main St,\nToronto ON M5V 1A1, Canada' });
  assert.equal(cps.validateAction('saveResidentialAddress', 'abc').ok, false);
  assert.equal(cps.validateAction('saveResidentialAddress', '').ok, false);
  assert.equal(cps.validateAction('saveResidentialAddress', null).ok, false);
  const long = cps.validateAction('saveResidentialAddress', 'x'.repeat(600));
  assert.equal(long.ok, false, 'never silently truncated — a legal document line');
  assert.match(long.error, /too long/);
});

test('apply: writes the lead column and posts a note saying who added or corrected it', async () => {
  const writes = [], notes = [];
  let stored = '';
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Asmita Paudel', residentialAddress: stored })),
    stub(leadService, 'updateLead', async (id, fields) => { writes.push({ id, fields }); stored = fields.residentialAddress; }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
  ];
  try {
    const r1 = await cps.applyAction({ leadId: '12893195466', action: 'saveResidentialAddress', value: ' 45 King St W, Toronto ON, Canada ', staffName: 'Gauri Berde' });
    assert.deepEqual(r1, { ok: true, message: 'Residential address saved.', residentialAddress: '45 King St W, Toronto ON, Canada' });
    assert.deepEqual(writes, [{ id: '12893195466', fields: { residentialAddress: '45 King St W, Toronto ON, Canada' } }]);
    assert.match(notes[0], /Residential address added by Gauri Berde: 45 King St W/);
    assert.ok(!/was:/.test(notes[0]), 'no previous value when it was blank');
    const r2 = await cps.applyAction({ leadId: '12893195466', action: 'saveResidentialAddress', value: '46 King St W, Toronto ON, Canada' });
    assert.equal(r2.ok, true);
    assert.match(notes[1], /Residential address corrected: 46 King St W.*\(was: 45 King St W, Toronto ON, Canada\)/);
    assert.match(notes[1], /a retainer already sent and any signed copy keep the old address/);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('apply: the note is HTML-escaped, line breaks read as commas, and the unsigned agreement review copy is evicted', async () => {
  const cas = require('../src/services/consultAgreementService');
  const notes = []; const evicted = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, residentialAddress: '1 Old <Rd>' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
    stub(cas, 'evictCache', (id) => { evicted.push(String(id)); return true; }),
  ];
  try {
    await cps.applyAction({ leadId: '77', action: 'saveResidentialAddress', value: '55 Bay & Bloor <Unit 5>\nToronto ON', staffName: 'A <b>' });
    assert.match(notes[0], /by A &lt;b&gt;: 55 Bay &amp; Bloor &lt;Unit 5&gt;, Toronto ON \(was: 1 Old &lt;Rd&gt;\)/);
    assert.match(notes[0], /a retainer already sent and any signed copy keep the old address/);
    assert.deepEqual(evicted, ['77']);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('lead page sections: the "Residential address" row shows the CORRECTED column value, not the original intake answer', () => {
  const lead = { residentialAddress: '46 King St W, Toronto', email: 'a@b.co', phone: '4165551234' };
  const { sections } = cps.buildIntakeSections({ residentialAddress: '45 King St W, Toronto' }, lead);
  const addr = sections.flatMap((s) => s.rows || []).find((r) => r.label === 'Residential address');
  assert.ok(addr, 'the row renders');
  assert.equal(addr.value, '46 King St W, Toronto', 'column first — the archive keeps what the client originally typed');
  const blank = cps.buildIntakeSections({ residentialAddress: '45 King St W, Toronto' }, { ...lead, residentialAddress: '' });
  assert.equal(blank.sections.flatMap((s) => s.rows || []).find((r) => r.label === 'Residential address').value, '45 King St W, Toronto', 'archive only when the column is blank');
});

test('apply: a bad address is a 400-class error and writes nothing', async () => {
  const restore = [
    stub(leadService, 'getLead', async () => { throw new Error('must not be read'); }),
    stub(leadService, 'updateLead', async () => { throw new Error('must not write'); }),
  ];
  try {
    await assert.rejects(() => cps.applyAction({ leadId: '1', action: 'saveResidentialAddress', value: 'n/a' }), (e) => e.badRequest === true);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('pins: both pages carry the address box wired to the action; the consultation payload exposes the address', () => {
  const leads = require('../src/routes/adminLeads').buildLeadDetailHTML('12893195466');
  assert.match(leads, /id="lead-address"/);
  assert.match(leads, /doAction\(_addrBtn,'saveResidentialAddress'/);
  assert.match(leads, /la\.value=d\.address\|\|''/);
  const consult = require('../src/routes/adminConsultation').buildDetailHTML('12893195466');
  assert.match(consult, /id="ca-address"/);
  assert.match(consult, /doAction\('saveResidentialAddress', document\.getElementById\('ca-address'\)\.value/);
  assert.match(consult, /cad\.value=d\.residentialAddress\|\|''/);
  const svc = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  assert.match(svc, /residentialAddress: lead\.residentialAddress \|\| '',\s+\/\/ editable on the page/);
});
