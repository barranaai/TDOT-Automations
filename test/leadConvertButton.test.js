'use strict';

// Lead → direct retainer conversion (team feedback 2026-08-13): an un-booked
// lead gets a one-click path into the direct-client modal, pre-filled and
// PRE-LINKED to that lead so no duplicate row is minted. Wiring is client-side
// (both pages are server-rendered JS) — these tests pin the load-bearing parts.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const leads  = fs.readFileSync(require.resolve('../src/routes/adminLeads.js'), 'utf8');
const consul = fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8');

test('leads page: convert link exists and targets ?convertLead=<id>', () => {
  assert.match(leads, /id="btn-convert"/);
  // /admin/retainers (its own page since 2026-11-05) runs the ?convertLead boot handler; the old
  // /admin/consultations?convertLead= link is redirected there (test/consultationsTabs.test.js).
  assert.match(leads, /\/admin\/retainers\?convertLead='\+encodeURIComponent\(d\.leadId\)/);
  // step 3 (2026-11-09): always on the lead page; greyed out with the reason when the server would refuse
  assert.match(leads, /var code=d\.convertBlock \? d\.convertBlock\.code : \(d\.directRetainer \? 'direct' : ''\);/);
  assert.match(leads, /renderConvert\(d\);/);
});

test('consultation page: ?convertLead boots the modal, prefills, and pre-links the lead', () => {
  assert.match(consul, /get\('convertLead'\)/);
  assert.match(consul, /function dcLoadConvertLead/);
  assert.match(consul, /\/api\/lead\/'\+encodeURIComponent\(leadId\)/, 'prefill comes from the lead API, not URL params');
  assert.match(consul, /else if\(DC_CONVERT_LEAD_ID\)\{[\s\S]{0,200}body\.linkLeadId=DC_CONVERT_LEAD_ID/,
    'submit pre-links the lead when no explicit duplicate-panel choice was made');
  assert.match(consul, /DC_PROFILE_REF=null; DC_CONVERT_LEAD_ID=null;/,
    'reopening the modal clears the conversion (stale link target hazard)');
});

test('lead detail API exposes the residential address for the prefill', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  assert.match(svc, /address:\s*lead\.residentialAddress \|\| ''/);
});

// Step 3 (Faran 2026-11-09, decision 7): "Convert to direct retainer" is ALWAYS on the lead page — also after
// booking and after the consultation — and nowhere else. When the server would refuse, it is greyed out with the reason.
const vm     = require('node:vm');
const portal = require('../src/services/consultantPortalService');

test('the button sits in Basic details (always shown), not in the booking-invite card; not on the list or consultation pages', () => {
  const html = require('../src/routes/adminLeads').buildLeadDetailHTML('5');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  const basic = html.slice(html.indexOf('id="basic-card"'), html.indexOf('id="la-att-card"'));
  assert.ok(basic.includes('id="btn-convert"') && basic.includes('id="convert-row"'));
  assert.ok(!/id="convert-row"[^>]*display:none/.test(html), 'never hidden');
  const invite = html.slice(html.indexOf('id="invite-card"'), html.indexOf('id="btn-invite"'));
  assert.ok(!invite.includes('btn-convert'));
  assert.ok(!require('../src/routes/adminLeads').buildLeadsQueueHTML().includes('btn-convert'));
  const C = require('../src/routes/adminConsultation');
  assert.ok(!C.buildDetailHTML('5').includes('btn-convert') && !C.buildQueueHTML().includes('btn-convert'));
});

test('the button: greyed with the reason for a case / a retainer / a booking not held; a link otherwise', () => {
  const html = require('../src/routes/adminLeads').buildLeadDetailHTML('5');
  const src = html.slice(html.indexOf('var CONVERT_WHY='), html.indexOf('function actMsg('));
  const mk = () => { const attrs = {}; const cls = new Set(); return { attrs, cls, href: '', title: '', textContent: '', removeAttribute(k) { delete attrs[k]; if (k === 'href') this.href = ''; }, setAttribute(k, v) { attrs[k] = v; }, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } }; };
  const b = mk(), why = mk();
  const ctx = { document: { getElementById: (id) => (id === 'btn-convert' ? b : id === 'convert-why' ? why : null) } };
  vm.runInNewContext(src + ';this.R=renderConvert;', ctx);
  ctx.R({ leadId: '5', convertBlock: { code: 'case', message: 'x' } });
  assert.equal(b.attrs['aria-disabled'], 'true'); assert.equal(b.href, ''); assert.equal(why.textContent, 'Has a case — open it');
  ctx.R({ leadId: '5', convertBlock: { code: 'retainer', message: 'x' } });
  assert.equal(why.textContent, 'A retainer is already in progress — continue on the Retainers page');
  ctx.R({ leadId: '5', convertBlock: null, bookingStatus: 'Booked', bookedSlot: '2026-01-01 10:00' });
  assert.equal(b.href, '/admin/retainers?convertLead=5'); assert.equal(b.attrs['aria-disabled'], undefined); assert.equal(why.textContent, '');
});

test('the server rule: a held / past consultation converts; a case, Retained, a retainer sent, a plan in progress, a future booking or a held time are refused', () => {
  const NOW = '2026-11-09 12:00';
  const r = (l) => portal.convertRefusal(l, NOW);
  assert.equal(r({}), null, 'a plain lead');
  assert.equal(r({ bookingStatus: 'Booked', bookedSlot: '2026-11-01 10:00', consultationHeld: '2026-11-01' }), null, 'consultation held');
  assert.equal(r({ bookingStatus: 'Booked', bookedSlot: '2026-11-08 10:00' }), null, 'booked time in the past');
  assert.equal(r({ clientMasterItemId: '9' }).code, 'case');
  assert.equal(r({ conversionStatus: 'Retained' }).code, 'case');
  assert.equal(r({ retainerSent: '2026-11-01' }).code, 'retainer');
  assert.equal(r({ retainerFee: '2000', consultationHeld: '2026-11-01' }).code, 'retainer');
  assert.equal(r({ selectedTemplate: 'x' }).code, 'retainer');
  assert.equal(r({ bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00' }).code, 'booked', 'a future consultation (Needs Faran — refused until he decides)');
  assert.equal(r({ bookingStatus: 'Slot Held', bookedSlot: '' }).code, 'booked');
  assert.equal(r({ bookingStatus: 'Booked', bookedSlot: '' }).code, 'booked');
  // the server's link path uses the same rule
  const svc = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  assert.match(svc, /const refusal = convertRefusal\(existing\);\n\s+if \(refusal\) bad\(refusal\.message\);/);
  assert.match(svc, /convertBlock: \(\(\) => \{ const r = convertRefusal\(lead\);/);
});
