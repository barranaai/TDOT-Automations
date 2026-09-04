'use strict';

// Consultant note #8 (2026-09-03): outcome / remark BUTTONS for leads. Every
// remark lands as an Update on the lead's Monday row so the team knows what
// was done; the outcome note says who set it. Shared widget on the lead page
// and the consultation view; nothing is best-effort for the remark itself.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const { REMARK_PRESETS } = require('../config/leadRemarks');

function freshPortal({ lead = { id: '1', retainerSent: '', retainerFee: '' } } = {}) {
  const calls = { updates: [], leadUpdates: [] };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/mondayApi', { query: async (q, vars) => { if (q.includes('create_update')) { calls.updates.push(vars.b); return { create_update: { id: '9' } }; } return {}; } });
  const realLead = require('../src/services/leadService');
  set('../src/services/leadService', { ...realLead, getLead: async () => lead, updateLead: async (id, u) => { calls.leadUpdates.push(u); } });
  set('../src/services/retainerService2', { feeToCents: () => 0 });
  const p = require.resolve('../src/services/consultantPortalService');
  delete require.cache[p];
  return { svc: require(p), calls };
}

test('presets are well-formed and include the Aug-13 conventions', () => {
  assert.ok(REMARK_PRESETS.length >= 5);
  for (const r of REMARK_PRESETS) { assert.match(r.key, /^[a-z0-9-]+$/); assert.ok(r.label.length > 3); }
  assert.deepEqual(new Set(REMARK_PRESETS.map((r) => r.key)).size, REMARK_PRESETS.length, 'keys unique');
  for (const must of ['Notes sent to client', 'Notes not sent', 'Retain — no fees quoted']) assert.ok(REMARK_PRESETS.some((r) => r.label === must), must);
});

test('validateAction("remark"): preset alone ok, text alone ok, unknown preset / empty / too long rejected; JSON string accepted', () => {
  const { svc } = freshPortal();
  const v = (value) => svc.validateAction('remark', value);
  assert.deepEqual(v({ preset: 'notes-sent' }), { ok: true, normalized: { preset: 'notes-sent', presetLabel: 'Notes sent to client', text: '' } });
  assert.deepEqual(v({ text: '  Called, will revert Monday  ' }), { ok: true, normalized: { preset: '', presetLabel: '', text: 'Called, will revert Monday' } });
  assert.equal(v(JSON.stringify({ preset: 'fees-quoted', text: 'x' })).ok, true);
  assert.equal(v({ preset: 'nope' }).ok, false);
  assert.equal(v({}).ok, false);
  assert.equal(v({ text: 'a'.repeat(2001) }).ok, false);
  assert.equal(v('{bad').ok, false);
  assert.equal(v(null).ok, false);
});

test('applyAction("remark") posts ONE escaped update naming the staffer + preset + text; the outcome note says who', async () => {
  const { svc, calls } = freshPortal();
  const r = await svc.applyAction({ leadId: '1', action: 'remark', value: { preset: 'notes-not-sent', text: 'Client <asked> for a & summary\nSecond line' }, staffName: 'Shafoli <x>' });
  assert.equal(r.ok, true); assert.match(r.message, /Notes not sent/);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0], '📝 <b>[Remark · Shafoli &lt;x&gt;]</b> <b>Notes not sent</b> — Client &lt;asked&gt; for a &amp; summary<br>Second line');
  assert.equal(calls.leadUpdates.length, 0, 'a remark never edits board columns');

  const r2 = await svc.applyAction({ leadId: '1', action: 'remark', value: { preset: 'no-answer' } });
  assert.equal(calls.updates[1], '📝 <b>[Remark]</b> <b>No answer / voicemail</b>');
  assert.equal(r2.ok, true);

  await svc.applyAction({ leadId: '1', action: 'outcome', value: 'Follow-Up', staffName: 'Kamal' });
  assert.deepEqual(calls.leadUpdates, [{ outcome: 'Follow-Up' }]);
  assert.match(calls.updates[2], /Outcome set to “Follow-Up” by Kamal\./);
});

test('remark is not blocked by the retainer-terms lock; a Monday failure surfaces (not best-effort)', async () => {
  const { svc } = freshPortal({ lead: { id: '1', retainerSent: '2026-08-01', retainerFee: '2500' } });
  const r = await svc.applyAction({ leadId: '1', action: 'remark', value: { preset: 'fees-quoted' } });
  assert.equal(r.ok, true);
  const odPath = require.resolve('../src/services/mondayApi');
  require.cache[odPath].exports.query = async () => { throw new Error('Monday down'); };
  delete require.cache[require.resolve('../src/services/consultantPortalService')];
  const svc2 = require('../src/services/consultantPortalService');
  await assert.rejects(() => svc2.applyAction({ leadId: '1', action: 'remark', value: { preset: 'fees-quoted' } }), /Monday down/);
});

test('lead page: re-rendering after an outcome/remark click must NOT clobber an unsaved booking-invite draft', () => {
  // Regression (found by the post-ship verification pass): the outcome buttons
  // call load() → render(), and render() used to overwrite #invite-msg
  // unconditionally. The invite card sits directly under the outcome buttons on
  // exactly the leads those buttons are for, so a staffer mid-draft lost it.
  const html = require('../src/routes/adminLeads').buildLeadDetailHTML('12641191022');
  assert.match(html, /var INV_DIRTY=false;/, 'dirty flag declared');
  assert.match(html, /getElementById\('invite-msg'\)\.addEventListener\('input',function\(\)\{ INV_DIRTY=true; \}\)/, 'typing marks the draft dirty');
  assert.match(html, /if\(!INV_DIRTY\) document\.getElementById\('invite-msg'\)\.value=d\.inviteMessage\|\|'';/, 'render never clobbers an unsaved draft');
  assert.doesNotMatch(html, /\n\s*document\.getElementById\('invite-msg'\)\.value=d\.inviteMessage/, 'no unguarded assignment left');
  // …and the flag clears once that text is persisted, so later renders show the server's copy
  assert.match(html, /doAction\(this,'saveInviteMessage',null,document\.getElementById\('invite-msg'\)\.value,'inv-msg'\)\s*\n\s*\.then\(function\(res\)\{ if\(res&&res\.ok\) INV_DIRTY=false; \}\);/, 'save clears the flag');
  assert.match(html, /return doAction\(btn,'bookingInvite'[\s\S]{0,200}INV_DIRTY=false;/, 'sending the invite clears the flag');
});

test('endpoint forwards the page-sent (self-reported) name into the action; widget exposes a reload hook', () => {
  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = server.indexOf("app.post('/api/consultation/:leadId/action'");
  const block = server.slice(i, server.indexOf('app.', i + 10));
  assert.match(block, /typeof rawName === 'string' \? rawName\.trim\(\)\.slice\(0, 60\) : ''/, 'page-sent name validated as a string, capped');
  assert.match(block, /staffName,\s*\n\s*\}\)/, 'staffName forwarded to applyAction');
  assert.doesNotMatch(block, /resolveViewer/, 'no dead "signed-in staffer" branch — every /api call carries the shared key');
  const w = fs.readFileSync(require.resolve('../src/routes/updatesWidget.js'), 'utf8');
  assert.match(w, /window\["tdotUpdatesReload_" \+ p\] = load/);
});

test('both pages embed the remarks widget + outcome buttons, and every inline <script> still parses', () => {
  const leads = require('../src/routes/adminLeads');
  const cons  = require('../src/routes/adminConsultation');
  const leadHtml = leads.buildLeadDetailHTML('12641191022');
  const consHtml = cons.buildDetailHTML('12641191022');
  for (const [name, html] of [['lead page', leadHtml], ['consultation view', consHtml]]) {
    assert.match(html, /id="rmk-chips"/, `${name}: remarks chips`);
    assert.match(html, /function tdotRemarksMount/, `${name}: widget JS`);
    assert.match(html, /tdotRemarksMount\(\{ prefix:'rmk', leadId: LEAD_ID, presets: REMARKS, updatesPrefix:'updw' \}\)/, `${name}: mounted`);
    assert.match(html, /id="obtns"/, `${name}: outcome buttons`);
    assert.match(html, /"Notes sent to client"/, `${name}: presets injected`);
    const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, `${name}: has inline scripts`);
    for (const [k, src] of scripts.entries()) new vm.Script(src, { filename: `${name}-script-${k}.js` });
  }
  assert.match(leadHtml, /staffName:\(window\.tdotRemarksName_rmk/, 'lead page sends the name with outcome actions');
  assert.match(leadHtml, /p\.then\(function\(res\)\{\s*if\(!res\|\|!res\.ok\) return;[^\n]*\n\s*load\(\);/, 'lead page outcome click re-renders only on success (no timer)');
  assert.doesNotMatch(leadHtml, /setTimeout\(function\(\)\{ var r=window\.tdotUpdatesReload_updw/, 'no fixed-timer success');
  assert.match(consHtml, /\.actions button:not\(\.rmk-chip\):not\(#rmk-post\)/, 'consultation view leaves the widget\'s own busy state alone');
  assert.match(leadHtml, /function refreshAs\(\)/, 'the credited name is shown before a one-click post');
  assert.match(leadHtml, /\(other && other\.value\)/, 'falls back to the Updates box name');
  assert.match(consHtml, /staffName: \(window\.tdotRemarksName_rmk/, 'consultation view sends the name with actions');
});
