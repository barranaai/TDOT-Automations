'use strict';

// Shared guidance formatter (user report 2026-08-01): raw instruction strings
// must render as readable structure on ALL surfaces (portal, upload page,
// staff review page) — never a wall of text, never unescaped HTML.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { formatInstructions } = require('../src/services/instructionFormatter');

test('multi-sentence prose splits into bullets (the income guidance shape)', () => {
  const html = formatInstructions('Bank statement for the last 3 months with good funds. If salaried: job letter on letterhead, at least 3 pay slips, Form 16 or other tax proof. If self-employed: business establishment proof, tax payment proof.');
  assert.match(html, /^<ul>/);
  assert.equal((html.match(/<li>/g) || []).length, 3, 'one bullet per sentence');
  assert.match(html, /If salaried:/);
});

test('a single sentence enumerating with semicolons splits into bullets (the IACD shape)', () => {
  const html = formatInstructions('Marriage certificate; final divorce or annulment certificates; death certificate of former spouse; legal name change documents — whichever apply.');
  assert.match(html, /^<ul>/);
  assert.equal((html.match(/<li>/g) || []).length, 4);
});

test('short single sentences stay a plain span', () => {
  const html = formatInstructions('Complete the questionnaire with full and accurate details.');
  assert.match(html, /^<span>/);
  assert.doesNotMatch(html, /<li>/);
});

test('URLs become links; HTML in the source is escaped', () => {
  const html = formatInstructions('See https://www.canada.ca/photo-specs.html for details.');
  assert.match(html, /<a href="https:\/\/www\.canada\.ca\/photo-specs\.html"/);
  const hostile = formatInstructions('Upload <script>alert(1)</script> now.');
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;/);
});

test('pre-bulleted text keeps its bullets', () => {
  const html = formatInstructions('• First item\n• Second item');
  assert.equal((html.match(/<li>/g) || []).length, 2);
});
