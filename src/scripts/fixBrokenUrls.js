/**
 * fixBrokenUrls.js
 *
 * Scans the Document Checklist Template Board for broken/split URLs in the
 * "Description" and "Client-Facing Instructions" long-text columns, then
 * reassembles them into single, valid URLs.
 *
 * Background:
 *   During the initial PDF → Monday.com import, URLs that wrapped across
 *   multiple lines in the PDF were split into fragments with spaces injected
 *   in the middle (e.g. "https://www.canada.ca/en/immigration-refugees-citiz
 *   enship/services/…").  The URL regex in the document upload form only
 *   captures up to the first space, so clients see broken, non-clickable links.
 *
 * What this script does:
 *   1. Fetches all items from every group on the Template Board.
 *   2. Reads the Description and Client-Facing Instructions columns.
 *   3. Detects broken URLs using heuristics:
 *      a) A URL fragment followed by space then a path-like continuation
 *         (starts with lowercase letter, slash, or dash — no space expected).
 *      b) A known canada.ca domain split across fragments.
 *   4. Reassembles the fragments into a single valid URL.
 *   5. Optionally writes the corrected text back to Monday.com.
 *
 * Usage:
 *   DRY RUN (scan only, no changes):
 *     node src/scripts/fixBrokenUrls.js
 *
 *   APPLY FIXES:
 *     node src/scripts/fixBrokenUrls.js --apply
 *
 * The script always prints a full report before making any changes.
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

// ─── Config ──────────────────────────────────────────────────────────────────

const TEMPLATE_BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';

// Long-text columns that may contain URLs
const COLUMNS_TO_SCAN = [
  { id: 'long_text_mm0zmb7j', label: 'Description' },
  { id: 'long_text_mm0z10mg', label: 'Client-Facing Instructions' },
];

const APPLY_MODE = process.argv.includes('--apply');
const RATE_LIMIT_MS = 250; // delay between Monday API writes

// ─── URL repair logic ────────────────────────────────────────────────────────

/**
 * Detects and reassembles broken URLs in a text string.
 *
 * Broken URL pattern (from PDF line wrapping):
 *   "https://www.canada.ca/en/immigration-refugees-citiz enship/services/application/medical- certificates/how.html"
 *
 * The spaces inside the URL were injected when PDF lines were joined.
 * This function finds a URL, then greedily absorbs subsequent space-separated
 * fragments that look like URL continuations (path segments, not natural English).
 */
function fixBrokenUrls(text) {
  if (!text) return { text, fixed: false, fixes: [] };

  const fixes = [];
  let result = text;

  // Strategy 1: Find URLs followed by space + path-like fragments
  // A "path-like fragment" is something that:
  //   - Starts with a lowercase letter, slash, dash, dot, or tilde
  //   - Contains slashes, dots, or dashes (looks like URL path)
  //   - Does NOT look like a normal English word/sentence continuation
  //
  // We repeatedly match: (URL-so-far) SPACE (fragment-that-looks-like-URL-continuation)

  const urlStart = /https?:\/\/\S+/g;
  let match;

  while ((match = urlStart.exec(result)) !== null) {
    const urlStartIdx = match.index;
    let urlEnd = urlStartIdx + match[0].length;
    let currentUrl = match[0];
    let wasFixed = false;

    // Look ahead: is the URL followed by " <fragment>" that should be part of it?
    while (urlEnd < result.length) {
      // Must be followed by exactly one space
      if (result[urlEnd] !== ' ') break;

      // Grab the next word/fragment after the space
      const remaining = result.substring(urlEnd + 1);
      const fragMatch = remaining.match(/^(\S+)/);
      if (!fragMatch) break;

      const fragment = fragMatch[1];

      // Heuristics to decide if this fragment is a URL continuation:
      if (isUrlContinuation(currentUrl, fragment)) {
        // Remove the space — merge fragment into the URL
        currentUrl += fragment;
        wasFixed = true;

        // Update result: remove the space between URL and fragment
        result = result.substring(0, urlEnd) + result.substring(urlEnd + 1);
        // urlEnd now points to where fragment starts (space was removed)
        urlEnd += fragment.length;
      } else {
        break;
      }
    }

    if (wasFixed) {
      // Clean trailing punctuation that might have been absorbed
      const cleaned = cleanTrailingPunctuation(currentUrl);
      if (cleaned !== currentUrl) {
        const diff = currentUrl.length - cleaned.length;
        result = result.substring(0, urlEnd - diff) + currentUrl.substring(cleaned.length) + result.substring(urlEnd);
        currentUrl = cleaned;
        urlEnd -= diff;
      }

      const originalChunk = text.substring(urlStartIdx, urlStartIdx + (currentUrl.length + (text.length - result.length)));
      fixes.push({
        original: text.substring(match.index, match.index + 200).split('\n')[0] + '…',
        fixed: currentUrl,
      });
    }

    // Move regex past the current URL to avoid infinite loop
    urlStart.lastIndex = urlEnd;
  }

  return {
    text: result,
    fixed: fixes.length > 0,
    fixes,
  };
}

/**
 * Determine if a text fragment is likely a continuation of a broken URL
 * rather than the start of a new sentence or phrase.
 */
function isUrlContinuation(urlSoFar, fragment) {
  // Must not be empty
  if (!fragment) return false;

  // If fragment starts with uppercase and doesn't contain slashes/dots,
  // it's likely a new sentence — not a URL part
  if (/^[A-Z][a-z]/.test(fragment) && !fragment.includes('/') && !fragment.includes('.')) {
    return false;
  }

  // Common keywords that are clearly not URL parts
  const nonUrlWords = [
    'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on',
    'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
    'we', 'us', 'our', 'you', 'your', 'he', 'she', 'him', 'her', 'his',
    'if', 'then', 'else', 'when', 'where', 'which', 'who', 'what', 'how',
    'not', 'no', 'yes', 'all', 'each', 'every', 'any', 'some', 'most',
    'please', 'provide', 'include', 'submit', 'ensure', 'must', 'note',
    'can', 'also', 'only', 'with', 'from', 'about', 'into', 'more',
  ];
  const lower = fragment.replace(/[.,;:!?)]+$/, '').toLowerCase();
  if (nonUrlWords.includes(lower)) return false;

  // Strong signals that it IS a URL continuation:

  // 1. Fragment contains slashes (path separator)
  if (fragment.includes('/')) return true;

  // 2. Fragment ends with known file extensions
  if (/\.(html?|php|aspx?|jsp|pdf|xml|json|do|action)$/i.test(fragment)) return true;

  // 3. Fragment starts with a path segment (lowercase + contains dots/dashes)
  if (/^[a-z]/.test(fragment) && (fragment.includes('.') || fragment.includes('-'))) {
    // Check it's not just a hyphenated English word
    const parts = fragment.split(/[.\-]/);
    const looksLikePath = parts.some(p => p.length > 0 && /[/.]/.test(fragment));
    if (looksLikePath) return true;
  }

  // 4. URL currently ends mid-path (with a dash or slash) — next fragment continues it
  if (/[\-\/]$/.test(urlSoFar)) return true;

  // 5. Fragment looks like a domain continuation (e.g., "enship" continuing "citiz")
  //    URL ends with a partial word (no trailing slash/dot/dash) and fragment
  //    starts with lowercase — likely a word split across lines
  if (/[a-z]$/.test(urlSoFar) && /^[a-z]/.test(fragment)) {
    // Additional check: the joined result should form a plausible URL path segment
    // Don't merge if the fragment looks like a standalone English word with spaces around it
    if (fragment.length <= 3) return false; // short words like "and", "the" already filtered
    // If the URL ends with a partial word that doesn't form a valid path boundary,
    // this is almost certainly a continuation
    if (!/[\-\/._~]/.test(urlSoFar.slice(-5))) return true;
  }

  return false;
}

/**
 * Remove trailing characters that were likely not part of the URL
 * (e.g., sentence-ending periods, commas, closing brackets).
 */
function cleanTrailingPunctuation(url) {
  return url.replace(/[.,;:!?)\]}>]+$/, '');
}

// ─── Monday.com fetch helpers ────────────────────────────────────────────────

/**
 * Fetch all groups on the board.
 */
async function getGroups() {
  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         groups { id title }
       }
     }`,
    { boardId: TEMPLATE_BOARD_ID }
  );
  return data?.boards?.[0]?.groups || [];
}

/**
 * Fetch all items in a group with their long-text column values.
 */
async function getGroupItems(groupId) {
  const colIds = COLUMNS_TO_SCAN.map(c => `"${c.id}"`).join(', ');

  const allItems = [];
  let cursor = null;

  // First page
  const firstData = await mondayApi.query(
    `query($boardId: ID!, $groupId: String!) {
       boards(ids: [$boardId]) {
         groups(ids: [$groupId]) {
           items_page(limit: 500) {
             cursor
             items {
               id
               name
               column_values(ids: [${colIds}]) { id text }
             }
           }
         }
       }
     }`,
    { boardId: TEMPLATE_BOARD_ID, groupId }
  );

  const firstPage = firstData?.boards?.[0]?.groups?.[0]?.items_page;
  if (!firstPage) return [];

  allItems.push(...(firstPage.items || []));
  cursor = firstPage.cursor;

  // Subsequent pages
  while (cursor) {
    const nextData = await mondayApi.query(
      `query($cursor: String!) {
         next_items_page(limit: 500, cursor: $cursor) {
           cursor
           items {
             id
             name
             column_values(ids: [${colIds}]) { id text }
           }
         }
       }`,
      { cursor }
    );

    const page = nextData?.next_items_page;
    if (!page) break;

    allItems.push(...(page.items || []));
    cursor = page.cursor;
  }

  return allItems;
}

/**
 * Update a long-text column value on an item.
 */
async function updateColumnText(itemId, columnId, newText) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colId: String!, $value: JSON!) {
       change_column_value(board_id: $boardId, item_id: $itemId, column_id: $colId, value: $value) {
         id
       }
     }`,
    {
      boardId: TEMPLATE_BOARD_ID,
      itemId:  String(itemId),
      colId:   columnId,
      value:   JSON.stringify({ text: newText }),
    }
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Fix Broken URLs — Document Checklist Template Board     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Mode: ${APPLY_MODE ? '🔧 APPLY (will write changes)' : '👁  DRY RUN (scan only)'}`);
  console.log(`Board ID: ${TEMPLATE_BOARD_ID}`);
  console.log();

  // Step 1: Get all groups
  const groups = await getGroups();
  console.log(`Found ${groups.length} groups on the board.\n`);

  let totalScanned = 0;
  let totalBroken  = 0;
  let totalFixed   = 0;
  const allFindings = [];

  // Step 2: Scan each group
  for (const group of groups) {
    console.log(`━━━ ${group.title} ━━━`);
    const items = await getGroupItems(group.id);
    console.log(`  ${items.length} items`);

    let groupBroken = 0;

    for (const item of items) {
      totalScanned++;

      for (const colDef of COLUMNS_TO_SCAN) {
        const colVal = item.column_values.find(c => c.id === colDef.id);
        const text   = colVal?.text?.trim();
        if (!text) continue;

        // Check for any URL in the text
        if (!/https?:\/\//i.test(text)) continue;

        const { text: fixedText, fixed, fixes } = fixBrokenUrls(text);

        if (fixed) {
          groupBroken++;
          totalBroken++;

          allFindings.push({
            group:    group.title,
            itemId:   item.id,
            itemName: item.name,
            column:   colDef.label,
            columnId: colDef.id,
            original: text,
            fixedText,
            fixes,
          });

          console.log(`  ⚠ BROKEN — "${item.name}" [${colDef.label}]`);
          for (const f of fixes) {
            console.log(`    ↳ Fixed URL: ${f.fixed}`);
          }
        }
      }
    }

    if (groupBroken === 0) {
      console.log('  ✓ No broken URLs');
    }
    console.log();

    // Rate limit between groups
    await sleep(200);
  }

  // Step 3: Summary
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  Items scanned:    ${totalScanned}`);
  console.log(`  Broken URLs found: ${totalBroken}`);
  console.log('════════════════════════════════════════════════════════════════\n');

  if (totalBroken === 0) {
    console.log('🎉 No broken URLs found — nothing to fix!');
    return;
  }

  // Step 4: Detailed findings report
  console.log('─── Detailed Findings ────────────────────────────────────────\n');
  for (const f of allFindings) {
    console.log(`Item:   "${f.itemName}" (ID: ${f.itemId})`);
    console.log(`Group:  ${f.group}`);
    console.log(`Column: ${f.column}`);
    console.log(`Before: ${truncate(f.original, 200)}`);
    console.log(`After:  ${truncate(f.fixedText, 200)}`);
    for (const fix of f.fixes) {
      console.log(`  URL:  ${fix.fixed}`);
    }
    console.log();
  }

  // Step 5: Apply fixes if --apply flag is set
  if (!APPLY_MODE) {
    console.log('─── Dry Run Complete ─────────────────────────────────────────');
    console.log(`  ${totalBroken} items need fixing.`);
    console.log('  Run with --apply to write changes:');
    console.log('    node src/scripts/fixBrokenUrls.js --apply');
    console.log();
    return;
  }

  console.log('─── Applying Fixes ───────────────────────────────────────────\n');
  for (const f of allFindings) {
    try {
      await updateColumnText(f.itemId, f.columnId, f.fixedText);
      totalFixed++;
      console.log(`  ✓ Fixed: "${f.itemName}" [${f.column}]`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`  ✗ Failed: "${f.itemName}" [${f.column}] — ${err.message}`);
    }
  }

  console.log();
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  Fixed:  ${totalFixed} / ${totalBroken}`);
  console.log(`  Failed: ${totalBroken - totalFixed}`);
  console.log('════════════════════════════════════════════════════════════════');
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.substring(0, max) + '…';
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n❌ Script failed:', err.message);
  process.exit(1);
});
