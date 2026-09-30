#!/usr/bin/env node
/**
 * The tenant gate for UPLOAD_UNIQUE_NAMES.
 *
 * Graph's `@microsoft.graph.conflictBehavior=rename` on a simple upload PUT is
 * documented but was never exercised in THIS tenant, and with the switch ON a
 * hard rejection would fail every client upload. So before the switch is
 * flipped, this script proves the behaviour once, in a scratch folder:
 *
 *   1. uploads a 10-byte check.txt under
 *        Client Documents/_verify - <YYYYMMDD>/General/
 *      through the SAME function the app uses (oneDriveService.uploadFileAsNew)
 *      and expects a CREATE (replaced=false) named "check.txt";
 *   2. uploads the same bytes under the same name again and expects a CREATE
 *      named "check 1.txt" — the clash was renamed, nothing was replaced;
 *   3. deletes both files and the scratch folder (Graph moves them to the
 *      drive's recycle bin).
 *
 * Touches no Monday board, no case folder, no client file. Exits 0 only when
 * both expectations hold; then set UPLOAD_UNIQUE_NAMES=1 on Render.
 *
 *   node scripts/verify-upload-rename.js --yes
 */
'use strict';

require('dotenv').config();

const argv = process.argv.slice(2);
if (!argv.includes('--yes')) {
  console.log('This writes two 10-byte files under "Client Documents/_verify - <date>/General/" in the noreply drive and deletes them again (no Monday, no case folder).');
  console.log('Run again with --yes to proceed.');
  process.exit(2);
}

const od = require('../src/services/oneDriveService');

const stamp      = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const clientName = '_verify';
const caseRef    = stamp;                                 // folder = "_verify - 20260930"
const folderName = od.caseFolderName({ clientName, caseRef });
const category   = 'General';
const buffer     = Buffer.from('0123456789');             // 10 bytes
const mimeType   = 'text/plain';

async function main() {
  const created = [];
  let failed = false;
  const expect = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failed = true; console.error(`  FAIL ${msg}`); } };

  try {
    console.log(`Scratch folder: Client Documents/${folderName}/${category}`);

    const first = await od.uploadFileAsNew({ clientName, caseRef, category, filename: 'check.txt', buffer, mimeType });
    created.push(first);
    console.log(`1st PUT → name="${first.name}" replaced=${first.replaced} id=${first.id}`);
    expect(first.replaced === false, 'first upload was a CREATE (201), not a replace');
    expect(first.name === 'check.txt', 'first upload kept its name');

    const second = await od.uploadFileAsNew({ clientName, caseRef, category, filename: 'check.txt', buffer, mimeType });
    created.push(second);
    console.log(`2nd PUT → name="${second.name}" replaced=${second.replaced} id=${second.id}`);
    expect(second.replaced === false, 'second upload was a CREATE (201) — nothing replaced');
    expect(second.name === 'check 1.txt', 'second upload was renamed to "check 1.txt" by Graph');
    expect(second.id && second.id !== first.id, 'two distinct files exist');
  } catch (err) {
    failed = true;
    console.error(`  FAIL ${err.message}`);
  }

  // Clean up: the files, then the scratch folder. Best effort, always reported.
  for (const f of created) {
    if (!f || !f.id) continue;
    try { await od.deleteDriveItem(f.id); console.log(`  deleted file "${f.name}"`); }
    catch (err) { console.error(`  could not delete file "${f.name}": ${err.message}`); }
  }
  try {
    const folder = await od.getClientFolderByName(folderName);
    if (folder) { await od.deleteDriveItem(folder.id); console.log(`  deleted folder "${folderName}"`); }
    else console.log(`  folder "${folderName}" already gone`);
  } catch (err) {
    console.error(`  could not delete folder "${folderName}": ${err.message} — remove it by hand from the noreply drive`);
  }

  console.log(failed
    ? '\nRESULT: FAILED — leave UPLOAD_UNIQUE_NAMES unset (OFF) and investigate before flipping it.'
    : '\nRESULT: PASSED — conflictBehavior=rename works in this tenant. Set UPLOAD_UNIQUE_NAMES=1 on Render.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
