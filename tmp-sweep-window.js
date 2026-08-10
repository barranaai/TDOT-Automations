'use strict';
/** READ-ONLY pull of all records created since Fri Jul 31 + cross-system state. */
process.chdir('/Users/faran/TDOT-Automations');
require('dotenv').config();
const monday = require('./src/services/mondayApi');
const sq = require('./src/services/squareBookingsService');
const R = require('./src/services/retainerStatusReconciler');
const L = require('./src/data/newLeadsBoard.json').columns;
const LEAD_BOARD = require('./config/monday').leadBoardId;
const FROM = '2026-07-31T00:00:00Z';
const CM = { ref:'text_mm142s49', pay:'color_mm0x9fnn', stage:'color_mm0x8faa', type:'dropdown_mm0xd1qn', sub:'dropdown_mm0x4t91',
             email:'text_mm0xw6bp', checklist:'color_mm0xs7kp', quest:'color_mm0x3tpw', account:'text_mm5xmeka', payDate:'date_mm0xgk76' };

async function page(boardId, colIds) {
  const out = []; let cursor = null;
  do {
    const q = `query($b:ID!,$c:String){ boards(ids:[$b]){ items_page(limit:100, cursor:$c){ cursor items{ id name created_at group{title} column_values(ids:${JSON.stringify(colIds)}){ id text } } } } }`;
    const d = await monday.query(q, { b: boardId, c: cursor });
    const p = d.boards[0].items_page;
    for (const it of p.items) {
      const g = {}; for (const cv of it.column_values) g[cv.id] = (cv.text || '').trim();
      out.push({ id: String(it.id), name: it.name, at: it.created_at, group: it.group && it.group.title, c: g });
    }
    cursor = p.cursor;
  } while (cursor);
  return out;
}

(async () => {
  const [leads, cms, consults, clients] = await Promise.all([
    page(LEAD_BOARD, [L.fullName,L.email,L.phone,L.sourceChannel,L.confirmedCaseType,L.caseTypeInterest,L.bookingStatus,L.bookedSlot,
      L.meetingType,L.squareBookingId,L.preConsultSubmitted,L.consultationHeld,L.outcome,L.conversionStatus,L.retainerSent,L.retainerSigned,
      L.retainerPaid,L.retainerFee,L.clientMasterItemId,L.oneDriveFolderId,L.leadToken,L.assignedConsultant,L.retainerCountersign,
      L.consultCountersign,L.clientAccountId,L.tier,L.milestonePayments,L.inviteSentAt]),
    page('18401523447', Object.values(CM)),
    page('18419177981', ['text_mm4mgrad','email_mm4mj3wh']),
    page('18425020416', []),
  ]);
  const wLeads = leads.filter((r) => r.at >= FROM);
  const wCms = cms.filter((r) => r.at >= FROM);
  const cmById = new Map(cms.map((r) => [r.id, r]));

  // checklist counts for window cases with refs
  const checklistByRef = {};
  for (const r of wCms) {
    const ref = r.c[CM.ref];
    if (!ref) continue;
    const d = await monday.query(`query($v:String!){ items_page_by_column_values(limit:100, board_id:18401875593, columns:[{column_id:"text_mm0z2cck", column_values:[$v]}]){ items{ id } } }`, { v: ref }).catch(() => null);
    checklistByRef[ref] = d ? (d.items_page_by_column_values.items || []).length : -1;
  }
  // Square status for window leads with bookings
  const squareByLead = {};
  for (const l of wLeads) {
    if (!l.c[L.squareBookingId]) continue;
    try { const b = await sq.retrieveBooking(l.c[L.squareBookingId]); squareByLead[l.id] = b ? { status: b.status, start: b.start_at } : 'NOT_FOUND'; }
    catch (e) { squareByLead[l.id] = `read-failed: ${e.message}`; }
  }
  // drift verdicts
  const drift = [];
  for (const l of wLeads) {
    const cm = cmById.get(l.c[L.clientMasterItemId]);
    const v = R.classifyDrift({ id: l.id, retainerSigned: l.c[L.retainerSigned], retainerPaid: l.c[L.retainerPaid], clientMasterItemId: l.c[L.clientMasterItemId] },
      l.c[L.clientMasterItemId] ? (cm ? cm.c[CM.pay] : null) : '');
    if (v.action !== 'none') drift.push({ lead: l.id, name: l.name, ...v });
  }
  // duplicate emails (window vs all)
  const dupes = [];
  for (const l of wLeads) {
    const em = (l.c[L.email] || '').toLowerCase();
    if (!em) continue;
    const others = leads.filter((o) => o.id !== l.id && (o.c[L.email] || '').toLowerCase() === em).map((o) => ({ id: o.id, at: o.at.slice(0,10) }));
    if (others.length) dupes.push({ lead: l.id, name: l.name, email: em, others });
  }
  // duplicate case refs across the whole board
  const refCount = {};
  for (const r of cms) { const ref = r.c[CM.ref]; if (ref) { (refCount[ref] = refCount[ref] || []).push(`${r.id}:${r.name}`); } }
  const dupRefs = Object.entries(refCount).filter(([, v]) => v.length > 1);

  const dump = {
    from: FROM,
    leads: wLeads.map((l) => ({ id: l.id, name: l.name, at: l.at, group: l.group,
      src: l.c[L.sourceChannel], type: l.c[L.confirmedCaseType] || l.c[L.caseTypeInterest], tier: l.c[L.tier], conv: l.c[L.conversionStatus],
      outcome: l.c[L.outcome], consultant: l.c[L.assignedConsultant], email: l.c[L.email], phone: l.c[L.phone],
      booking: l.c[L.bookingStatus], slot: l.c[L.bookedSlot], meet: l.c[L.meetingType], squareBookingId: l.c[L.squareBookingId],
      preConsult: l.c[L.preConsultSubmitted], held: l.c[L.consultationHeld], invite: l.c[L.inviteSentAt],
      sent: l.c[L.retainerSent], signed: l.c[L.retainerSigned], paid: l.c[L.retainerPaid], fee: l.c[L.retainerFee],
      retCS: l.c[L.retainerCountersign], milestones: l.c[L.milestonePayments],
      token: !!l.c[L.leadToken], folderId: !!l.c[L.oneDriveFolderId], account: l.c[L.clientAccountId], cmId: l.c[L.clientMasterItemId] })),
    cases: wCms.map((r) => ({ id: r.id, name: r.name, at: r.at, ref: r.c[CM.ref], type: r.c[CM.type], sub: r.c[CM.sub],
      pay: r.c[CM.pay], payDate: r.c[CM.payDate], stage: r.c[CM.stage], checklist: r.c[CM.checklist], quest: r.c[CM.quest],
      account: !!r.c[CM.account], email: r.c[CM.email],
      leads: leads.filter((l) => l.c[L.clientMasterItemId] === r.id).map((l) => l.id),
      checklistRows: checklistByRef[r.c[CM.ref]] })),
    consultForms: consults.filter((r) => r.at >= FROM).map((r) => ({ at: r.at, name: r.name, email: r.c.email_mm4mj3wh })),
    accounts: clients.filter((r) => r.at >= FROM).map((r) => ({ at: r.at, id: r.id, name: r.name })),
    squareByLead, drift, dupes, dupRefs,
  };
  require('fs').writeFileSync('/private/tmp/claude-501/-Users-faran-TDOT-Automations/d225e220-9718-4f45-984c-31128241b0e0/scratchpad/window-dump.json', JSON.stringify(dump, null, 1));
  console.log(`window ${FROM.slice(0,10)}→now: leads=${dump.leads.length} cases=${dump.cases.length} consultForms=${dump.consultForms.length} accounts=${dump.accounts.length}`);
  console.log(`drift=${drift.length} dupeEmails=${dupes.length} dupRefs=${dupRefs.length} squareChecked=${Object.keys(squareByLead).length}`);
  console.log('dump written to scratchpad/window-dump.json');
})().catch((e) => { console.error('FAILED', e.stack || e.message); process.exit(1); });
