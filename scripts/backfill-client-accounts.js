/**
 * One-off — backfill CLIENT ACCOUNTS from existing Client Master cases.
 *
 * Clusters CM rows by (normalized email → normalized name): one Clients-board
 * account per PERSON. Each account is stamped onto its CM rows
 * (clientAccountId + Client relation) and their leads. NEVER merges: a
 * multi-name email cluster gets one account PER NAME (spouses sharing an
 * email are two people) and is listed in the report for staff review —
 * possible typo'd duplicates of one person are a human call.
 *
 * Idempotent: CM rows that already carry a clientAccountId are skipped, and
 * account creation goes through clientAccountService.findOrCreate (which
 * reuses an exact email+name match), so re-running never duplicates.
 *
 * Output: backfill-client-accounts-report.md (repo root, gitignored-adjacent —
 * inspect + delete after review).
 *
 * Safety: default DRY-RUN (writes the report only). Pass --write to create
 * accounts + stamp links.
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');
const accounts  = require('../src/services/clientAccountService');
const { clientMasterBoardId } = require('../config/monday');

const WRITE = process.argv.includes('--write');
const REPORT_PATH = path.join(__dirname, '..', 'backfill-client-accounts-report.md');

const CM_EMAIL_COL = 'text_mm0xw6bp';
const CM_PHONE_COL = 'phone_mm33zr0c';
const CM_REF_COL   = 'text_mm142s49';
const CM_STAGE_COL = 'color_mm0x8faa';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PURE — clustering name key. CM item names carry decorations — parenthesized
 * file numbers "(2726)", case refs, passport-like tokens "e004397122" — and
 * spacing variants, all of which are the SAME person. Strip those for the
 * clustering key only (the runtime matcher stays strict): genuinely different
 * names still cluster apart and get reported.
 */
function clusterNormName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // parenthesized decorations
    .replace(/\b[a-z]{0,2}\d{4,}\b/g, ' ') // passport/file-number tokens
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * PURE — cluster CM rows into person groups.
 * @param {Array<{id,name,email,phone,caseRef,stage,existingAccountId}>} rows
 * @returns {{ clusters: Array<{email,name,rows:[]}>, skippedNoEmail: [], skippedStamped: [], multiNameEmails: Array<{email,names:[]}> }}
 */
function clusterRows(rows) {
  const skippedNoEmail = [];
  const skippedStamped = [];
  const byKey = new Map(); // `${email}|${normName}` → rows
  const namesByEmail = new Map();

  for (const r of rows) {
    if (r.existingAccountId) { skippedStamped.push(r); continue; }
    const email = accounts.normalizeEmail(r.email);
    if (!email) { skippedNoEmail.push(r); continue; }
    const nameKey = clusterNormName(r.name);
    const key = `${email}|${nameKey}`;
    if (!byKey.has(key)) byKey.set(key, { email, name: r.name, rows: [] });
    const cluster = byKey.get(key);
    cluster.rows.push(r);
    // The newest row's name becomes the account name (usually the cleanest).
    if (Number(r.id) > Number(cluster.rows[0].id)) cluster.name = r.name;
    if (!namesByEmail.has(email)) namesByEmail.set(email, new Set());
    namesByEmail.get(email).add(nameKey);
  }

  const multiNameEmails = [...namesByEmail.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([email, names]) => ({ email, names: [...names] }));

  return { clusters: [...byKey.values()], skippedNoEmail, skippedStamped, multiNameEmails };
}

async function fetchAllCmRows(accountColId) {
  const rows = [];
  let cursor = null;
  do {
    const page = cursor
      ? await mondayApi.query(
          'query($c:String!){ next_items_page(limit:100, cursor:$c){ cursor items{ id name column_values{ id text } } } }',
          { c: cursor })
      : await mondayApi.query(
          'query($b:ID!){ boards(ids:[$b]){ items_page(limit:100){ cursor items{ id name column_values{ id text } } } } }',
          { b: String(clientMasterBoardId) });
    const p = cursor ? page.next_items_page : page.boards[0].items_page;
    for (const it of p.items) {
      const g = (colId) => ((it.column_values || []).find((c) => c.id === colId) || {}).text || '';
      rows.push({
        id: String(it.id), name: it.name,
        email: g(CM_EMAIL_COL), phone: g(CM_PHONE_COL),
        caseRef: g(CM_REF_COL), stage: g(CM_STAGE_COL),
        existingAccountId: accountColId ? g(accountColId).trim() : '',
      });
    }
    cursor = p.cursor;
    await sleep(150);
  } while (cursor);
  return rows;
}

async function main() {
  const cfg = accounts.loadBoard();
  if (!cfg) { console.error('src/data/clientsBoard.json missing — run create-clients-board.js --write first.'); process.exit(1); }
  const accountCol = (cfg.cmLinkColumns || {}).clientAccountId || '';
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN (report only)'}\n`);

  console.log('Fetching Client Master rows…');
  const rows = await fetchAllCmRows(accountCol);
  console.log(`  ${rows.length} rows`);

  const { clusters, skippedNoEmail, skippedStamped, multiNameEmails } = clusterRows(rows);
  console.log(`  ${clusters.length} person clusters · ${skippedStamped.length} already stamped · ${skippedNoEmail.length} without email`);

  // Leads indexed by clientMasterItemId — one pass, matches deletionService's linkage model.
  const leadService = require('../src/services/leadService');
  let leadsByCm = new Map();
  try {
    const allLeads = await leadService.listAllLeads();
    for (const l of allLeads) {
      const cm = String(l.clientMasterItemId || '').trim();
      if (cm) { if (!leadsByCm.has(cm)) leadsByCm.set(cm, []); leadsByCm.get(cm).push(l); }
    }
  } catch (err) { console.warn(`  ⚠ lead index failed (${err.message}) — lead stamping skipped`); }

  const lines = [
    '# Client-accounts backfill report', '',
    `Generated ${new Date().toISOString()} · mode: ${WRITE ? 'WRITE' : 'DRY-RUN'}`, '',
    `- Client Master rows: ${rows.length}`,
    `- Person clusters (one account each): ${clusters.length}`,
    `- Already stamped (skipped): ${skippedStamped.length}`,
    `- No email (skipped — link manually if needed): ${skippedNoEmail.length}`, '',
  ];

  if (multiNameEmails.length) {
    lines.push('## ⚠ Emails shared by MULTIPLE names — review these', '');
    lines.push('Each name gets its OWN account (spouses = two people). If two entries are');
    lines.push('actually the same person (typo / name variant), merge manually in Monday', '(set the extra account Status=Merged + Merged Into).', '');
    for (const m of multiNameEmails) lines.push(`- ${m.email}: ${m.names.join('  ·  ')}`);
    lines.push('');
  }

  lines.push('## Clusters', '');
  let created = 0, linkedCases = 0, linkedLeads = 0;
  for (const c of clusters) {
    const enrich = c.rows.map((r) => r.caseRef || `(item ${r.id})`).join(', ');
    lines.push(`- **${c.name}** <${c.email}> — ${c.rows.length} case(s): ${enrich}`);
    if (!WRITE) continue;

    const newest = c.rows.sort((a, b) => Number(b.id) - Number(a.id))[0];
    const leads = c.rows.flatMap((r) => leadsByCm.get(r.id) || []);
    const enrichLead = leads.sort((a, b) => Number(b.id) - Number(a.id))[0];
    const result = await accounts.findOrCreate({
      email: c.email,
      phone: newest.phone || (enrichLead && enrichLead.phone) || '',
      fullName: c.name,
      residentialAddress: (enrichLead && enrichLead.residentialAddress) || '',
      source: 'backfill',
    });
    if (!result) continue;
    if (result.created) created++;
    for (const r of c.rows) {
      try { await accounts.linkCase(result.clientId, { cmItemId: r.id }); linkedCases++; }
      catch (err) { lines.push(`  - ⚠ case link failed for ${r.caseRef || r.id}: ${err.message}`); }
      await sleep(150);
    }
    for (const l of leads) {
      try { await accounts.linkLead(result.clientId, l.id); linkedLeads++; }
      catch (_) { /* logged inside */ }
      await sleep(100);
    }
  }

  if (WRITE) {
    lines.push('', `## Write summary`, '',
      `- Accounts created: ${created}`, `- Cases stamped: ${linkedCases}`, `- Leads stamped: ${linkedLeads}`);
  }

  fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
  console.log(`\nReport → ${path.relative(process.cwd(), REPORT_PATH)}`);
  if (!WRITE) console.log('(Dry-run. Review the report, then re-run with --write.)');
  console.log('Done.');
}

module.exports = { clusterRows };
if (require.main === module) main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
