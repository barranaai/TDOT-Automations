/**
 * One-time backfill — Client Portal link column on every existing Client
 * Master row that has a Case Reference Number assigned.
 *
 * Run on production (or anywhere with .env credentials):
 *   node scripts/backfill-portal-links.js
 *
 * What it does:
 *   1. Pages through every Client Master row
 *   2. For each row that has a Case Reference Number assigned, ensures an
 *      access token exists, builds the portal URL, and writes it to the
 *      "🏠 Client Portal" link column (id link_mm2vta5).
 *   3. Skips rows that already have a portal link with the same URL.
 *
 * Safe to run multiple times — idempotent. Never deletes or overwrites
 * unrelated data.
 */

'use strict';

require('dotenv').config();

const mondayApi = require('../src/services/mondayApi');
const { ensureAccessToken } = require('../src/services/accessTokenService');
const portalSvc = require('../src/services/clientPortalService');
const { clientMasterBoardId, cmColumns } = require('../config/monday');

const CASE_REF_COL    = 'text_mm142s49';
const PORTAL_LINK_COL = (cmColumns && cmColumns.portalLink) || 'link_mm2vta5';

async function* iterateClientMaster() {
  let cursor = null;
  while (true) {
    const data = cursor
      ? await mondayApi.query(
          `query($boardId: ID!, $cursor: String!) {
             boards(ids: [$boardId]) {
               items_page(limit: 100, cursor: $cursor) {
                 cursor
                 items {
                   id name
                   column_values(ids: ["${CASE_REF_COL}", "${PORTAL_LINK_COL}"]) { id text value }
                 }
               }
             }
           }`,
          { boardId: String(clientMasterBoardId), cursor }
        )
      : await mondayApi.query(
          `query($boardId: ID!) {
             boards(ids: [$boardId]) {
               items_page(limit: 100) {
                 cursor
                 items {
                   id name
                   column_values(ids: ["${CASE_REF_COL}", "${PORTAL_LINK_COL}"]) { id text value }
                 }
               }
             }
           }`,
          { boardId: String(clientMasterBoardId) }
        );

    const page = data?.boards?.[0]?.items_page;
    if (!page) return;
    for (const it of (page.items || [])) yield it;
    if (!page.cursor) return;
    cursor = page.cursor;
  }
}

(async () => {
  console.log('\n=== Client Portal Link Backfill ===\n');
  let scanned = 0, written = 0, skipped = 0, failed = 0;

  for await (const item of iterateClientMaster()) {
    scanned++;
    const cv      = (id) => item.column_values.find(c => c.id === id);
    const caseRef = (cv(CASE_REF_COL)?.text || '').trim();

    if (!caseRef) { skipped++; continue; }

    // Read existing portal link to skip no-op writes
    let existingUrl = '';
    try {
      const v = JSON.parse(cv(PORTAL_LINK_COL)?.value || '{}');
      existingUrl = v?.url || '';
    } catch { /* ignore */ }

    let token = '';
    try { token = await ensureAccessToken(item.id); } catch (err) {
      console.warn(`  [skip] No token for ${caseRef} (${item.id}): ${err.message}`);
      failed++; continue;
    }

    // staff:true → ?staff=1 in the URL so the route triggers Monday OAuth
    // when a staff member opens this link without a fresh cookie. The Monday
    // column is only seen by staff, never by clients.
    const url = portalSvc.buildPortalUrl({ caseRef, accessToken: token, staff: true });
    if (existingUrl === url) {
      console.log(`  [ok  ] ${caseRef} already has correct link`);
      skipped++;
      continue;
    }

    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
         }`,
        {
          boardId: String(clientMasterBoardId),
          itemId:  String(item.id),
          cols:    JSON.stringify({
            [PORTAL_LINK_COL]: { url, text: 'Open Client Portal' },
          }),
        }
      );
      console.log(`  [✓  ] ${caseRef} (${item.name}) — wrote portal link`);
      written++;
    } catch (err) {
      console.error(`  [fail] ${caseRef}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Done — scanned ${scanned}, written ${written}, skipped ${skipped}, failed ${failed} ===\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('\n[Fatal]', err.message);
  process.exit(1);
});
