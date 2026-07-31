// Backfill: copy lead.phone onto Client Master "Client Contact Number" where the
// CM value is blank. Fills blanks ONLY — existing values are never touched.
require('dotenv').config();

const leadService = require('../src/services/leadService');
const handoff     = require('../src/services/handoffService');
const mondayApi   = require('../src/services/mondayApi');

(async () => {
  const leads = await leadService.listAllLeads();
  const linked = leads.filter((l) => (l.clientMasterItemId || '').trim() && (l.phone || '').trim());
  console.log(`${leads.length} leads, ${linked.length} with a case + a phone on file`);
  const ids = linked.map((l) => String(l.clientMasterItemId));
  // read current CM phone values in chunks
  const current = {};
  for (let i = 0; i < ids.length; i += 25) {
    const d = await mondayApi.query(
      `query($i: [ID!]){ items(ids: $i){ id column_values(ids: ["phone_mm33zr0c"]){ text } } }`,
      { i: ids.slice(i, i + 25) });
    for (const it of d.items || []) current[it.id] = (it.column_values[0] && it.column_values[0].text) || '';
  }
  let filled = 0, skippedHasValue = 0, unusable = 0;
  for (const l of linked) {
    const cmId = String(l.clientMasterItemId);
    if (!(cmId in current)) continue; // deleted case
    if ((current[cmId] || '').trim()) { skippedHasValue++; continue; }
    const before = filled;
    await handoff.setClientPhone(cmId, l); // best-effort; logs its own warnings
    // verify it landed (setClientPhone swallows errors)
    const d = await mondayApi.query(
      `query($i: [ID!]){ items(ids: $i){ column_values(ids: ["phone_mm33zr0c"]){ text } } }`, { i: [cmId] });
    const now = (d.items[0].column_values[0] && d.items[0].column_values[0].text) || '';
    if (now.trim()) { filled++; console.log(`filled ${cmId} (${l.fullName}): ${now}`); }
    else { unusable++; console.log(`NOT filled ${cmId} (${l.fullName}) — phone on lead: "${l.phone}"`); }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`DONE: filled=${filled} alreadyHad=${skippedHasValue} unusable=${unusable}`);
})().catch((e) => { console.error('SWEEP FAILED:', e.message); process.exit(1); });
