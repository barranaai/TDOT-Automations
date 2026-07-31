'use strict';

// Signature-field anchoring (Praj incident 2026-07-31): the retainer's static
// y=36% put the CLIENT's signature field on the RCIC's line — the execution
// block's vertical position shifts with preceding content. Fields are now
// placed relative to the document's actual "Signature of …" label.
//
// The matching rules are tested on anchorHitFromPages (pure, extracted-items
// input). The PDF-extraction leg is deliberately NOT fixture-tested: pdf-parse's
// bundled pdf.js rejects synthetic PDFs nondeterministically ("bad XRef entry"),
// while the real CloudConvert renders it processes in production parse reliably
// (verified live on the actual retainer, anchor found at 35.3%).

const test   = require('node:test');
const assert = require('node:assert/strict');

const { anchorHitFromPages, findAnchorPosition } = require('../src/services/documensoService');

// Mirrors the measured execution page of the real 'pa' retainer.
const EXEC_PAGE = [
  { str: 'IN WITNESS THEREOF this  Agreement has  been duly executed', yTopPct: 24.3 },
  { str: '_________________________________________________', yTopPct: 33.5 },
  { str: 'Signature of Praj', yTopPct: 35.3 },
  { str: 'Date July 31, 2026', yTopPct: 35.6 },
  { str: '__________________________________', yTopPct: 42.7 },
  { str: 'Signature of RCIC', yTopPct: 44.5 },
];
const PAGES = [[{ str: 'page one filler', yTopPct: 10 }], EXEC_PAGE];

const NAME_ANCHOR    = new RegExp('^signature of\\s+Praj', 'i');
const GENERIC_ANCHOR = /^signature of\s+(?!rcic)/i;

test('anchorHitFromPages: the client-name anchor finds the client label, with the page', () => {
  const hit = anchorHitFromPages(PAGES, [NAME_ANCHOR, GENERIC_ANCHOR]);
  assert.equal(hit.page, 2);
  assert.equal(hit.yTopPct, 35.3);
});

test('anchorHitFromPages: the generic anchor skips the RCIC line (employer template — rep signs first)', () => {
  const employerPage = [
    { str: 'Signature of Emp Rep Name', yTopPct: 30 },
    { str: 'Signature of RCIC', yTopPct: 40 },
  ];
  const hit = anchorHitFromPages([employerPage], [GENERIC_ANCHOR]);
  assert.equal(hit.yTopPct, 30, 'first NON-RCIC signature line wins');
  // RCIC-only page → the generic anchor must not bite at all.
  assert.equal(anchorHitFromPages([[{ str: 'Signature of RCIC', yTopPct: 40 }]], [GENERIC_ANCHOR]), null);
});

test('anchorHitFromPages: priority order — a no-match first anchor falls through to the next', () => {
  const hit = anchorHitFromPages(PAGES, [/^signature of\s+nobody/i, GENERIC_ANCHOR]);
  assert.equal(hit.yTopPct, 35.3);
});

test('anchorHitFromPages: no match / empty input → null (caller keeps the static fallback)', () => {
  assert.equal(anchorHitFromPages(PAGES, [/^signature of\s+nobody/i]), null);
  assert.equal(anchorHitFromPages([], [GENERIC_ANCHOR]), null);
  assert.equal(anchorHitFromPages(null, null), null);
});

test('findAnchorPosition: unparsable input never throws — returns null', async () => {
  assert.equal(await findAnchorPosition(Buffer.from('not a pdf'), [/x/]), null);
});

test('the computed field sits ABOVE the client line, clear of the RCIC block (Praj geometry)', () => {
  // The createEnvelope math: fieldY = anchorY - height - gap.
  const hit = anchorHitFromPages(PAGES, [NAME_ANCHOR]);
  const height = 6, gap = 2;
  const fieldTop = hit.yTopPct - height - gap;
  const fieldBottom = fieldTop + height;
  assert.ok(fieldTop > 24.3, 'field starts below the IN WITNESS THEREOF heading');
  assert.ok(Math.abs(fieldBottom - 33.5) < 0.5, 'field bottom lands on the client’s own line');
  assert.ok(fieldBottom < 42.7 - 5, 'field is well clear of the RCIC line (the old y=36 box ended at 42%)');
});
