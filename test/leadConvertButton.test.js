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
  // PLURAL /admin/consultations — the queue page runs the ?convertLead boot
  // handler; the singular path matched no route and 404'd (fixed 2026-08-21).
  assert.match(leads, /\/admin\/consultations\?convertLead='\+encodeURIComponent\(d\.leadId\)/);
  assert.match(leads, /if\(cr && !d\.clientMasterItemId && d\.bookingStatus!=='Slot Held' && !d\.bookedSlot\)/,
    'never offered when a case exists, a slot is held, or a slot is booked — the server would refuse all three');
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
