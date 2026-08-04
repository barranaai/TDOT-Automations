'use strict';

// Backfill clustering: one account per PERSON. Name decorations (file numbers,
// passport tokens, spacing) must not split one person into two accounts, while
// genuinely different names sharing an email (families) must stay separate.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { clusterRows } = require('../scripts/backfill-client-accounts');

const row = (id, name, email, extra = {}) => ({ id, name, email, phone: '', caseRef: `R-${id}`, stage: '', existingAccountId: '', ...extra });

test('decorated name variants of ONE person cluster together', () => {
  const { clusters, multiNameEmails } = clusterRows([
    row('1', 'Amritpal Kaur (2726)', 'a@x.com'),
    row('2', 'Amritpal Kaur(2726)', 'a@x.com'),
    row('3', 'Sahebjot Kaur e004397122 (1594)', 'b@x.com'),
    row('4', 'Sahebjot Kaur', 'b@x.com'),
  ]);
  assert.equal(clusters.length, 2, 'two people, two clusters');
  assert.equal(clusters.find((c) => c.email === 'a@x.com').rows.length, 2);
  assert.equal(multiNameEmails.length, 0, 'no false review flags');
});

test('a family sharing one email stays SEPARATE and is flagged for review', () => {
  const { clusters, multiNameEmails } = clusterRows([
    row('1', 'Jane Doe', 'family@x.com'),
    row('2', 'John Doe', 'family@x.com'),
  ]);
  assert.equal(clusters.length, 2, 'two people — never merged');
  assert.equal(multiNameEmails.length, 1);
  assert.equal(multiNameEmails[0].email, 'family@x.com');
});

test('already-stamped and email-less rows are skipped and reported', () => {
  const { clusters, skippedStamped, skippedNoEmail } = clusterRows([
    row('1', 'Stamped Person', 's@x.com', { existingAccountId: '42' }),
    row('2', 'No Email Person', ''),
    row('3', 'Fresh Person', 'f@x.com'),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(skippedStamped.length, 1);
  assert.equal(skippedNoEmail.length, 1);
});

test('a multi-case client forms ONE cluster with all their cases', () => {
  const { clusters } = clusterRows([
    row('10', 'Repeat Client', 'r@x.com'),
    row('11', 'Repeat Client', 'r@x.com'),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].rows.length, 2);
});
