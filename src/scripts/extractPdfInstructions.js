/**
 * extractPdfInstructions.js
 *
 * Reads all Document Checklist PDFs, extracts the exact instruction text for
 * each document item, and outputs a consolidated map of:
 *   documentName → instruction
 *
 * Where the same document appears in multiple PDFs, all variants are logged.
 * Run this first to review before running the update script.
 *
 * Run with: node src/scripts/extractPdfInstructions.js
 */

require('dotenv').config();
const pdfParse = require('pdf-parse');
const fs   = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '../../Document Checklist Items');

// ─── Get all PDFs (skip Templates subfolders) ─────────────────────────────────

function getAllPdfs(dir) {
  const results = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (f !== 'Templates') results.push(...getAllPdfs(full));
    } else if (f.endsWith('.pdf')) {
      results.push(full);
    }
  }
  return results.sort();
}

// ─── Boilerplate line detector ────────────────────────────────────────────────

function isBoilerplate(line) {
  const l = line.toLowerCase().trim();
  return (
    l.startsWith('documents for the') ||
    l.startsWith('documents for') ||
    l.startsWith('disclaimer:') ||
    l.startsWith('disclaimer') ||
    l.startsWith('your application') ||
    l.startsWith('20 de boers') ||
    l.startsWith('www.tdot') ||
    l.startsWith('document checklist:') ||
    /^page \d+ of \d+$/.test(l) ||
    l.startsWith('► documents for') ||
    l.includes('tdotimm.com') ||
    l.startsWith('north york') ||
    l.startsWith('suite')
  );
}

// ─── Parse a single PDF → array of { name, instruction } ─────────────────────

async function parsePdf(filePath) {
  const buf  = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  const text = data.text;

  // Split into lines, clean whitespace
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const items = [];
  let i = 0;

  // Skip header boilerplate (everything before the first ☐)
  while (i < lines.length && !lines[i].includes('☐')) i++;

  while (i < lines.length) {
    const line = lines[i];

    // A document item starts with ☐
    if (!line.includes('☐')) { i++; continue; }

    // Extract name — may be on same line as ☐ or next line
    let name = line.replace('☐', '').trim();
    i++;

    // If name was empty, pick it up from next non-empty line
    if (!name && i < lines.length) {
      name = lines[i].trim();
      i++;
    }

    // Skip boilerplate / section headers
    if (!name || isBoilerplate(name)) continue;

    // Collect instruction lines until next ☐ or boilerplate section header
    const instrLines = [];
    while (i < lines.length) {
      const next = lines[i];

      // Stop at next checkbox item
      if (next.includes('☐')) break;

      // Stop at boilerplate section headers
      if (isBoilerplate(next)) break;

      instrLines.push(next);
      i++;
    }

    const instruction = instrLines.join('\n').trim();

    if (name) {
      items.push({ name: name.trim(), instruction });
    }
  }

  return items;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pdfs = getAllPdfs(BASE_DIR);
  console.log(`Found ${pdfs.length} PDFs\n`);

  // Map: name → Set of unique instructions seen
  const map = {};

  for (const pdf of pdfs) {
    const relPath = path.relative(BASE_DIR, pdf);
    let items;
    try {
      items = await parsePdf(pdf);
    } catch (err) {
      console.error(`ERROR parsing ${relPath}: ${err.message}`);
      continue;
    }

    for (const { name, instruction } of items) {
      if (!map[name]) map[name] = new Set();
      if (instruction) map[name].add(instruction);
    }
  }

  // Output report
  console.log(`\nExtracted ${Object.keys(map).length} unique document names\n`);
  console.log('='.repeat(80));

  for (const [name, variants] of Object.entries(map).sort()) {
    const arr = [...variants];
    console.log(`\n📄 ${name}`);
    if (arr.length === 1) {
      console.log(`   ✅ Single instruction (consistent across all PDFs):`);
      console.log(`   ${arr[0].replace(/\n/g, '\n   ')}`);
    } else {
      console.log(`   ⚠️  ${arr.length} VARIANTS found:`);
      arr.forEach((v, idx) => {
        console.log(`\n   --- Variant ${idx + 1} ---`);
        console.log(`   ${v.replace(/\n/g, '\n   ')}`);
      });
    }
    console.log('-'.repeat(80));
  }

  // Also output as JSON for use in the update script
  const jsonMap = {};
  for (const [name, variants] of Object.entries(map)) {
    const arr = [...variants];
    // Score each variant: prefer longer text, penalise ones that end with
    // what looks like a section header bleed-over (e.g. "Documents for the")
    const scored = arr.map(v => {
      const lastLine = v.split('\n').filter(l => l.trim()).pop() || '';
      const penalty  = isBoilerplate(lastLine) ? 5000 : 0;
      return { v, score: v.length - penalty };
    });
    scored.sort((a, b) => b.score - a.score);
    jsonMap[name] = scored[0].v;
  }

  const outPath = path.join(__dirname, '../../src/data/pdfInstructionsMap.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(jsonMap, null, 2));
  console.log(`\n✅ JSON map saved to src/data/pdfInstructionsMap.json (${Object.keys(jsonMap).length} entries)`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
