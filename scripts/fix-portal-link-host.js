/**
 * Repair the Client Master "Client Portal" link column: rewrite any link still
 * pointing at the old Render hostname to the branded canonical host.
 *
 * WHY: staff clicking a stale-host portal link start the Monday OAuth flow on
 * that host, but the callback is registered on the branded host — the CSRF
 * state cookie is set on one domain and read on the other, so the login dies
 * with "Invalid login state" (reported live 2026-08-18). The app now also
 * redirects page GETs to the canonical host, so old links work either way;
 * this cleans the stored data so the board itself is correct.
 *
 * Only the HOST is rewritten — case ref, token and ?staff=1 are preserved.
 *
 *   node scripts/fix-portal-link-host.js            # dry-run (default)
 *   node scripts/fix-portal-link-host.js --write    # apply
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../src/services/mondayApi');
const { clientMasterBoardId } = require('../config/monday');

const WRITE = process.argv.includes('--write');
const PORTAL_LINK_COL = 'link_mm2vta5';
const CANONICAL = (() => {
  try { return new URL(process.env.RENDER_URL || 'https://app.tdotimm.com').origin; }
  catch (_) { return 'https://app.tdotimm.com'; }
})();

async function allRows() {
  const out = [];
  const q = `{ id name column_values(ids:["${PORTAL_LINK_COL}"]){ text value } }`;
  let d = await mondayApi.query(
    `query($b:[ID!]){ boards(ids:$b){ items_page(limit:100){ cursor items ${q} } } }`,
    { b: [String(clientMasterBoardId)] });
  let page = d?.boards?.[0]?.items_page;
  out.push(...(page?.items || []));
  let cursor = page?.cursor, guard = 0;
  while (cursor && ++guard < 40) {
    const n = await mondayApi.query(
      `query($c:String!){ next_items_page(limit:100, cursor:$c){ cursor items ${q} } }`, { c: cursor });
    out.push(...(n?.next_items_page?.items || []));
    cursor = n?.next_items_page?.cursor;
  }
  return out;
}

function currentUrl(cv) {
  if (!cv) return '';
  try { const v = JSON.parse(cv.value || '{}'); if (v && v.url) return String(v.url); } catch (_) { /* fall through */ }
  const m = /(https?:\/\/\S+)/.exec(cv.text || '');
  return m ? m[1] : '';
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  canonical: ${CANONICAL}`);
  const rows = await allRows();
  const stale = [];
  for (const it of rows) {
    const url = currentUrl(it.column_values && it.column_values[0]);
    if (!url) continue;
    let parsed; try { parsed = new URL(url); } catch (_) { continue; }
    if (parsed.origin === CANONICAL) continue;
    stale.push({ id: it.id, name: it.name, from: url, to: CANONICAL + parsed.pathname + parsed.search });
  }
  console.log(`Rows: ${rows.length} | stale-host portal links: ${stale.length}`);
  for (const s of stale.slice(0, 5)) console.log(`  e.g. ${s.name}: ${s.from}\n        → ${s.to}`);
  if (!WRITE) { console.log('(Dry-run. Re-run with --write to apply.)'); return; }

  let done = 0, failed = 0;
  for (const s of stale) {
    try {
      await mondayApi.query(
        `mutation($b: ID!, $i: ID!, $cols: JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$cols){ id } }`,
        { b: String(clientMasterBoardId), i: String(s.id),
          cols: JSON.stringify({ [PORTAL_LINK_COL]: { url: s.to, text: 'Open Client Portal' } }) });
      done++;
      if (done % 25 === 0) console.log(`  …${done}/${stale.length}`);
    } catch (err) {
      failed++;
      console.warn(`  FAILED ${s.name} (${s.id}): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 120));   // gentle on the API
  }
  console.log(`✅ repaired ${done}${failed ? ` | ${failed} failed` : ''}`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
