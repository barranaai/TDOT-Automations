'use strict';

// Regression: a client who has already SIGNED / been RETAINED must never be sent
// a fresh retainer agreement — even when `retainerSent` was never stamped (manual
// signing, a failed stamp, or a legacy path). This is the server-side twin of the
// consultant-portal button lock. See the "Retain & send still enabled after
// retained" report.

const test   = require('node:test');
const assert = require('node:assert/strict');

const portal      = require('../src/services/consultantPortalService');
const retainer2   = require('../src/services/retainerService2');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// A lead that is fully retained but whose retainerSent is EMPTY (the bug shape).
function retainedLead(extra = {}) {
  return {
    id: '1', email: 'c@example.com', fullName: 'Test Client', outcome: 'Retain',
    retainerFee: 2500, retainerSent: '', // ← never stamped
    retainerSigned: '2026-07-20', retainerPaid: '2026-07-20', conversionStatus: 'Retained',
    ...extra,
  };
}

test('retainAndSend: refuses (locked) when the client is already signed/paid/Retained, even with retainerSent empty', async () => {
  for (const shape of [
    { retainerSigned: '2026-07-20', retainerPaid: '', conversionStatus: 'Retained — Awaiting Payment' },
    { retainerSigned: '', retainerPaid: '2026-07-20', conversionStatus: 'Retained — Awaiting Payment' },
    { retainerSigned: '2026-07-20', retainerPaid: '2026-07-20', conversionStatus: 'Retained' },
    { retainerSigned: '', retainerPaid: '', conversionStatus: 'Retained' },
  ]) {
    let sendCalled = false;
    const restore = [
      stub(leadService, 'getLead', async () => retainedLead(shape)),
      stub(retainer2, 'maybeSendRetainerAgreement', async () => { sendCalled = true; return { status: 'sent' }; }),
      stub(mondayApi, 'query', async () => ({})),
    ];
    try {
      await assert.rejects(
        () => portal.applyAction({ leadId: '1', action: 'retainAndSend', value: null }),
        (err) => { assert.equal(err.badRequest, true); assert.equal(err.locked, true); assert.match(err.message, /already been retained/i); return true; },
        `shape ${JSON.stringify(shape)} must be refused`);
      assert.equal(sendCalled, false, 'the agreement send must NOT be reached for a retained client');
    } finally { restore.forEach((x) => x()); }
  }
});

test('maybeSendRetainerAgreement: no-op ("already") for a signed/retained lead with retainerSent empty', async () => {
  for (const shape of [
    { retainerSigned: '2026-07-20' },
    { retainerPaid: '2026-07-20' },
    { conversionStatus: 'Retained' },
  ]) {
    const restore = [
      stub(leadService, 'getLead', async () => retainedLead({ retainerSigned: '', retainerPaid: '', conversionStatus: '', ...shape })),
      stub(leadService, 'updateLead', async () => { throw new Error('must not write'); }),
      stub(mondayApi, 'query', async () => ({})),
    ];
    try {
      const r = await retainer2.maybeSendRetainerAgreement('1');
      assert.equal(r.status, 'already', `shape ${JSON.stringify(shape)} → already (no send)`);
    } finally { restore.forEach((x) => x()); }
  }
});
