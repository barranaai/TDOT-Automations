/**
 * Template board — Required Type = "Optional" for optional-worded documents
 * (readiness item 2, cut 2, 2026-10-02).
 *
 * Template-seeded checklists carry optionality in ONE column the engine reads on
 * the Document Checklist Template Board 18401624183: Required Type
 * (dropdown_mm0x9v5q) — never set to Optional/Conditional on any item. This
 * tool sets "Optional" on items whose NAME reads as optional / conditional
 * (src/utils/documentNameMarkers.js — the same classifier the schema flags
 * are pinned to) plus the "One and same name affidavit" (no name-change gate
 * exists on the template path), when the current value is blank or Mandatory.
 * Nothing else is written: Counts Toward Readiness stays as it is (with the
 * switch on, an uploaded optional document counts whatever Counts says), and
 * an item with Blocking Flag = Yes is never touched (an optional blocking
 * document is a contradiction) — it is reported instead.
 *
 *   node scripts/template-required-type-optional.js                 # dry-run: the list, nothing written
 *   node scripts/template-required-type-optional.js --write         # saves the before-state, then writes
 *   node scripts/template-required-type-optional.js --undo <file>   # restores every item from a before-state file
 *
 * RUN ORDER: the switch and this tool are ONE change. Required Type on the
 * template is read whether the switch is on or off (an Optional row leaves
 * Missing Required at once), so run --write in the same window as setting
 * DOC_OPTIONAL=1, and roll back with BOTH the switch OFF and --undo.
 *
 * The before-state (item id → previous Required Type) is saved under
 * scripts/data/ BEFORE the first write (never overwritten), so every run can
 * be undone exactly.
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { isOptionalName, AFFIDAVIT_RE, normName } = require('../src/utils/documentNameMarkers');

const BOARD_ID     = '18401624183';
const REQ_COL      = 'dropdown_mm0x9v5q';   // Required Type
const COUNTS_COL   = 'color_mm0x78rc';      // Counts Toward Readiness
const BLOCKING_COL = 'color_mm0xmrw';       // Blocking Flag (read only — never touched)
const LABEL        = 'Optional';
const DATA_DIR     = path.join(__dirname, 'data');
const WRITE_DELAY_MS = 150;

const argv  = process.argv.slice(2);
const WRITE = argv.includes('--write');
const UNDO  = argv.includes('--undo') ? argv[argv.indexOf('--undo') + 1] : '';

/**
 * PURE: what the tool would write, per template item.
 *   { id, name, counts, previous: { required }, writes: { required: 'Optional' } }
 * or { id, name, skipped: <reason> } for a selected item it refuses to touch.
 */
function planTemplateWrites(items) {
  const plan = [];
  for (const it of items || []) {
    const name = String(it.name || '');
    const required = String(it.requiredType || '').trim();
    const counts   = String(it.counts || '').trim();
    const blocking = String(it.blocking || '').trim();
    if (!(required === '' || required === 'Mandatory')) continue;
    if (!(isOptionalName(name) || AFFIDAVIT_RE.test(name))) continue;
    if (blocking === 'Yes') { plan.push({ id: String(it.id), name, skipped: 'Blocking Flag = Yes — an optional blocking document is a contradiction; decide by hand' }); continue; }
    plan.push({ id: String(it.id), name, counts, previous: { required }, writes: { required: LABEL } });
  }
  return plan;
}

if (argv.includes('--undo') && (!UNDO || UNDO.startsWith('--'))) { console.error('--undo needs the before-state file: --undo scripts/data/<file>.json'); process.exit(2); }
if (UNDO && WRITE) { console.error('--undo and --write cannot be combined.'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllItems(mondayApi) {
  const items = [];
  let cursor = null;
  do {
    const ca = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(`query { boards(ids: [${BOARD_ID}]) { items_page(limit: 500${ca}) { cursor items { id name column_values(ids: ["${REQ_COL}", "${COUNTS_COL}", "${BLOCKING_COL}"]) { id text } } } } }`);
    const page = data?.boards?.[0]?.items_page;
    if (!page) break;
    for (const it of page.items || []) {
      const cv = Object.fromEntries((it.column_values || []).map((c) => [c.id, (c.text || '').trim()]));
      items.push({ id: String(it.id), name: it.name, requiredType: cv[REQ_COL] || '', counts: cv[COUNTS_COL] || '', blocking: cv[BLOCKING_COL] || '' });
    }
    cursor = page.cursor || null;
  } while (cursor);
  return items;
}

/** The label must exist on the dropdown before any write — a missing label fails every write, slowly. A dropdown's settings_str holds labels: [{id, name}]. */
function dropdownLabelNames(settingsStr) {
  const s = JSON.parse(settingsStr || '{}');
  const raw = Array.isArray(s.labels) ? s.labels : Object.values(s.labels || {});
  return raw.map((l) => (typeof l === 'string' ? l : (l && l.name))).filter(Boolean);
}
async function assertLabelsExist(mondayApi) {
  const d = await mondayApi.query(`query { boards(ids: [${BOARD_ID}]) { columns(ids: ["${REQ_COL}"]) { id settings_str } } }`);
  const names = dropdownLabelNames(d?.boards?.[0]?.columns?.[0]?.settings_str);
  if (!names.includes(LABEL)) throw new Error(`Required Type has no "${LABEL}" label (has: ${names.join(', ') || 'none readable'}) — add it in Monday first.`);
}

/** One mutation per item, one column: a dropdown takes { labels: [...] }; an empty list clears it. */
function colValues({ required }) {
  return { [REQ_COL]: required ? { labels: [required] } : { labels: [] } };
}
async function writeItem(mondayApi, itemId, values) {
  await mondayApi.query(
    `mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
    { b: BOARD_ID, i: String(itemId), c: JSON.stringify(colValues(values)) });
}

async function readBack(mondayApi, ids) {
  const by = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const d = await mondayApi.query(`query($ids: [ID!]!, $lim: Int!) { items(ids: $ids, limit: $lim) { id column_values(ids: ["${REQ_COL}"]) { id text } } }`, { ids: batch, lim: batch.length });
    for (const it of d?.items || []) by[String(it.id)] = { required: (it.column_values?.[0]?.text || '').trim() };
  }
  return by;
}

function report(plan) {
  const groups = new Map();
  for (const p of plan.filter((x) => !x.skipped)) {
    const k = normName(p.name);
    const g = groups.get(k) || { name: p.name, n: 0, prev: {}, countsNo: 0 };
    g.n++; const key = p.previous.required || '(blank)'; g.prev[key] = (g.prev[key] || 0) + 1; if (p.counts === 'No') g.countsNo++;
    groups.set(k, g);
  }
  for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) {
    console.log(`  ${String(g.n).padStart(3)} × ${g.name}   [Required now: ${Object.entries(g.prev).map(([k, v]) => `${k} ${v}`).join(', ')}${g.countsNo ? `; Counts = No on ${g.countsNo} (left as is — counts once uploaded under the rule)` : ''}]`);
  }
  const skipped = plan.filter((x) => x.skipped);
  if (skipped.length) { console.log(`\nSKIPPED (${skipped.length}):`); for (const s of skipped) console.log(`  ${s.id} ${s.name} — ${s.skipped}`); }
}

async function main() {
  const mondayApi = require('../src/services/mondayApi');
  console.log(`Mode: ${UNDO ? '↩  UNDO ' + UNDO : WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  Template board ${BOARD_ID}, column ${REQ_COL}`);

  if (UNDO) {
    const saved = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
    if (String(saved.boardId) !== BOARD_ID || saved.column !== REQ_COL) throw new Error('That before-state file is for a different board/column.');
    console.log(`Restoring ${saved.items.length} item(s) to their previous Required Type…`);
    let n = 0; const failed = [];
    for (const it of saved.items) {
      try { await writeItem(mondayApi, it.id, { required: it.previous.required || '' }); n++; }
      catch (err) { failed.push(`${it.id} (${err.message})`); }
      await sleep(WRITE_DELAY_MS);
    }
    const back = await readBack(mondayApi, saved.items.map((i) => String(i.id)));
    const wrong = saved.items.filter((i) => { const b = back[String(i.id)]; return !b || b.required !== (i.previous.required || ''); }).map((i) => i.id);
    console.log(`Restored ${n}/${saved.items.length}; ${wrong.length} not matching the before-state${wrong.length ? ': ' + wrong.join(', ') : ''}.`);
    if (failed.length) console.log(`FAILED (${failed.length}): ${failed.join('; ')}`);
    return;
  }

  const all  = await fetchAllItems(mondayApi);
  const plan = planTemplateWrites(all);
  const todo = plan.filter((p) => !p.skipped);
  const alreadyOptional = all.filter((it) => it.requiredType === LABEL || it.requiredType === 'Conditional').length;
  console.log(`Template items: ${all.length}; already Optional/Conditional: ${alreadyOptional}; to set Optional: ${todo.length}`);
  if (alreadyOptional) console.log(`NOTE: ${alreadyOptional} item(s) already read Optional/Conditional — an earlier run's before-state file under scripts/data/ holds their previous values; undo that first if you mean to start over.`);
  report(plan);
  if (!WRITE) { console.log('\n(Dry-run. Re-run with --write to apply — the before-state is saved first.)'); return; }
  if (!todo.length) { console.log('Nothing to do.'); return; }

  await assertLabelsExist(mondayApi);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);   // to the second
  const beforePath = path.join(DATA_DIR, `template-required-type-optional.before-${stamp}.json`);
  // 'wx': never overwrite an earlier run's record
  fs.writeFileSync(beforePath, JSON.stringify({ boardId: BOARD_ID, column: REQ_COL, writtenAt: new Date().toISOString(), items: todo.map((p) => ({ id: p.id, name: p.name, previous: p.previous, writes: p.writes })) }, null, 2) + '\n', { flag: 'wx' });
  console.log(`\nBefore-state saved: ${path.relative(process.cwd(), beforePath)}`);

  let n = 0; const failed = [];
  for (const p of todo) {
    try { await writeItem(mondayApi, p.id, p.writes); n++; }
    catch (err) { failed.push(`${p.id} (${err.message})`); }
    await sleep(WRITE_DELAY_MS);
  }
  const back = await readBack(mondayApi, todo.map((p) => p.id));
  const wrong = todo.filter((p) => { const b = back[p.id]; return !b || b.required !== LABEL; }).map((p) => p.id);
  console.log(`Written ${n}/${todo.length}; verified ${Object.keys(back).length} read, ${wrong.length} not reading as written${wrong.length ? ': ' + wrong.join(', ') : ''}.`);
  if (failed.length) console.log(`FAILED (${failed.length}): ${failed.join('; ')}`);
  console.log(`Undo at any time: node scripts/template-required-type-optional.js --undo ${path.relative(process.cwd(), beforePath)}`);
}

module.exports = { planTemplateWrites, colValues, dropdownLabelNames, BOARD_ID, REQ_COL, COUNTS_COL, BLOCKING_COL, LABEL };
if (require.main === module) main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
