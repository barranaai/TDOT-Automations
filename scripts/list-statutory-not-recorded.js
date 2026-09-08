#!/usr/bin/env node
/**
 * Which cases hold statutory Yes/No answers the old form never captured?
 * (Gauri 2026-09-04, point 02 — READ-ONLY, for the consultants' re-confirm list.)
 *
 * Until 2026-09-09 the questionnaire engine saved the option labels ("yes" /
 * "no") for every statutory row of the Visitor-extension (F12) and TRV (F13)
 * forms instead of the client's click, so those answers do not exist on file.
 * The fixed app keeps ONE "not recorded" marker per such row on the review
 * page; the client's next save replaces the rows with real answers (or
 * blanks). This sweep lists the cases that still carry the placeholder pairs
 * (or the markers), plus whether the Q5 refusal-details box is filled — the
 * one signal that the client had really answered Yes to question 5.
 *
 * Reads the Client Master board for candidate cases (Visitor Record /
 * Extension, TRV, Visitor Visa "Change of Status") and the live review page
 * for each (admin key), and writes a JSON + CSV report. Never writes.
 *
 *   node scripts/list-statutory-not-recorded.js [--base https://app.tdotimm.com] [--out report.json]
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const mondayApi = require('../src/services/mondayApi');
const { clientMasterBoardId } = require('../config/monday');
const { LEGACY_SUFFIX } = require('../src/utils/statutoryLegacy');

const argv = process.argv.slice(2);
const opt  = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = opt('--base', 'https://app.tdotimm.com').replace(/\/$/, '');
const OUT  = opt('--out', '') || `statutory-not-recorded-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const KEY  = process.env.ADMIN_API_KEY || '';
const CM_BOARD_ID = clientMasterBoardId || process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refOk = (s) => /^[A-Za-z0-9_-]{3,40}$/.test(String(s || '').trim());

async function candidates() {
  const rows = []; let cursor = null;
  do {
    const cols = 'column_values(ids:["text_mm142s49","dropdown_mm0xd1qn","dropdown_mm0x4t91","color_mm0x8faa","color_mm0x9s08","numeric_mm0x9dea"]) { id text }';
    const q = cursor ? `query { next_items_page(limit:200, cursor:"${cursor}") { cursor items { id name ${cols} } } }`
                     : `query { boards(ids:${CM_BOARD_ID}) { items_page(limit:200) { cursor items { id name ${cols} } } } }`;
    const d = await mondayApi.query(q); const ip = cursor ? d.next_items_page : d.boards[0].items_page;
    for (const it of ip.items || []) {
      const c = {}; for (const v of it.column_values) c[v.id] = (v.text || '').trim();
      rows.push({ id: String(it.id), firstName: String(it.name || '').split(/\s+/)[0], caseRef: c.text_mm142s49, caseType: c.dropdown_mm0xd1qn, subType: c.dropdown_mm0x4t91, stage: c.color_mm0x8faa, qStatus: c.color_mm0x9s08, qPct: c.numeric_mm0x9dea });
    }
    cursor = ip.cursor; if (cursor) await sleep(200);
  } while (cursor);
  return rows.filter((r) => refOk(r.caseRef) && (r.caseType === 'Visitor Record / Extension' || r.caseType === 'TRV' || /change of status/i.test(r.subType || '')));
}

/** The review page embeds SAVED_DATA (+ REVIEW_MEMBERS for family cases) — parse, never execute. */
function embedded(html, name) {
  const m = html.match(new RegExp(name + '\\s*=\\s*(\\[[\\s\\S]*?\\]);\\n'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { try { return JSON.parse(m[1].replace(/\\u003c/g, '<')); } catch (e) { return null; } }
}
/** Every member's saved fields on the page: [{ memberKey, fields }] (single-member pages → one entry). */
function memberFilesFrom(html) {
  const members = embedded(html, 'REVIEW_MEMBERS');
  if (Array.isArray(members) && members.length) return members.map((m) => ({ memberKey: m.key || 'primary', fields: Array.isArray(m.fields) ? m.fields : [] }));
  const saved = embedded(html, 'SAVED_DATA');
  return saved ? [{ memberKey: 'primary', fields: saved }] : null;
}
/** After the fix, a placeholder-only file gets an error page carrying the count instead of a review. */
function noteCountFrom(html) {
  const m = html.match(/its (\d+) statutory Yes\/No rows were not captured/);
  return m ? Number(m[1]) : 0;
}

function analyse(data) {
  const byKey = new Map(data.filter((f) => f && f.key).map((f) => [f.key, f]));
  let placeholders = 0, markers = 0;
  for (const [k, f] of byKey) {
    if (f.notRecorded) markers++;
    if (k.endsWith(LEGACY_SUFFIX) && String(f.value).toLowerCase() === 'yes') {
      const b = byKey.get(k + '-2'); if (b && String(b.value).toLowerCase() === 'no') placeholders++;
    }
  }
  const statutory = data.filter((f) => /statutory/i.test(f.section || ''));
  const refusalDetailsFilled = statutory.filter((f) => /refusal|visa type|country|how many/i.test(f.label || '') && f.value && String(f.value).trim()).length;
  const realAnswers = statutory.filter((f) => f.key && f.key.endsWith(LEGACY_SUFFIX) && !f.notRecorded && !byKey.has(f.key + '-2') && f.value).length;
  return { notRecorded: placeholders + markers, refusalDetailsFilled, realStatutoryAnswers: realAnswers, fields: data.length };
}

(async () => {
  if (!KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }
  const cand = await candidates();
  console.log(`Candidates (Visitor Record / Extension, TRV, Change of Status): ${cand.length}\n`);
  const out = [];
  for (const [i, r] of cand.entries()) {
    let html = '';
    try {
      const res = await fetch(`${BASE}/q/${encodeURIComponent(r.caseRef)}/review`, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(90000) });
      if (res.status === 401 || res.status === 403) { console.error(`AUTH FAILURE ${res.status}`); process.exit(2); }
      html = await res.text();
    } catch (err) { out.push({ ...r, error: err.message }); continue; }
    const members = memberFilesFrom(html);
    if (!members) {
      // No review page: either nothing saved, or (after the fix) a placeholder-only
      // file that the route now answers with a note carrying the lost-row count.
      const lost = noteCountFrom(html);
      if (lost) { out.push({ ...r, memberKey: 'primary', notRecorded: lost, refusalDetailsFilled: 0, realStatutoryAnswers: 0, fields: 0, placeholderOnly: true }); console.log(`[${i + 1}/${cand.length}] ${r.caseRef.padEnd(16)} ${(r.stage || '').padEnd(28)} not recorded: ${String(lost).padStart(2)}  (placeholder-only file)`); }
      else out.push({ ...r, noData: true });
      continue;
    }
    for (const mf of members) {
      const a = analyse(mf.fields);
      out.push({ ...r, memberKey: mf.memberKey, ...a });
      console.log(`[${i + 1}/${cand.length}] ${r.caseRef.padEnd(16)} ${mf.memberKey.padEnd(8)} ${(r.stage || '').padEnd(28)} not recorded: ${String(a.notRecorded).padStart(2)}  refusal details filled: ${a.refusalDetailsFilled ? 'YES (Q5 was really Yes)' : 'no'}`);
    }
    await sleep(150);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const csvPath = OUT.replace(/\.json$/, '') + '.csv';
  fs.writeFileSync(csvPath, ['caseRef,member,firstName,caseType,stage,qStatus,notRecordedRows,q5RefusalDetailsFilled,realStatutoryAnswers']
    .concat(out.filter((o) => !o.noData && !o.error).map((o) => [o.caseRef, o.memberKey, o.firstName, o.caseType, o.stage, o.qStatus, o.notRecorded, o.refusalDetailsFilled ? 'yes' : 'no', o.realStatutoryAnswers].join(','))).join('\n'));
  const affected = out.filter((o) => o.notRecorded);
  console.log(`\nAffected: ${affected.length} of ${cand.length} candidates; with Q5 refusal details filled: ${affected.filter((o) => o.refusalDetailsFilled).length}`);
  console.log(`Report → ${OUT}\nCSV    → ${csvPath}`);
})().catch((err) => { console.error('FAILED:', err.stack || err.message); process.exit(1); });
