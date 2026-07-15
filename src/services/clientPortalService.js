/**
 * Client Portal Service
 *
 * Builds the unified client-facing landing page at /client/:caseRef?t=<token>.
 * One URL, one bookmarkable view that surfaces:
 *   - Case header (name, ref, current stage)
 *   - Pending actions banner (rework docs, missing Q fields)
 *   - Questionnaire card (completion %, last saved, "Continue" button)
 *   - Documents card (received/total, "Manage Documents" button)
 *   - Contact strip
 *
 * All state is queried LIVE from Monday + OneDrive on every page load — no
 * caching. The portal never writes; it's a read-only aggregator over data
 * the existing services own. That means:
 *   - Webhook automation logic is untouched
 *   - The questionnaire and document upload flows continue to work as the
 *     authoritative entry points; the portal just routes clients to them
 *
 * Token security mirrors /q/<caseRef> exactly — uses
 * htmlQuestionnaireService.validateAccess so a stale or wrong token returns
 * the same error as the Q page would.
 */

'use strict';

const mondayApi    = require('./mondayApi');
const docFormSvc   = require('./documentFormService');
const htmlQ        = require('./htmlQuestionnaireService');
const { clientMasterBoardId } = require('../../config/monday');

const BASE_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

// Reuse the same column IDs the rest of the system uses.
const CM = {
  caseRef:           'text_mm142s49',
  caseType:          'dropdown_mm0xd1qn',
  caseStage:         'color_mm0x8faa',
  qReadiness:        'numeric_mm0x9dea',
  qCompletionStatus: 'color_mm0x9s08',
  caseManager:       'multiple_person_mm0xhmgk',
  clientEmail:       'text_mm0xw6bp',
};

// ─── HTML escaping ──────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Client journey stepper ─────────────────────────────────────────────────
//
// Clients shouldn't decode internal ops stages ("Internal Review", "Stuck").
// Map every Case Stage onto a warm five-step journey. Unrecognised stages are
// active ops labels, so they read as "we're working on it" (step 3) rather
// than guessing precisely and being wrong.

const JOURNEY_STEPS = [
  'Case opened',
  'Your questionnaire & documents',
  'We prepare your application',
  'Application submitted',
  'Decision',
];

const STAGE_TO_STEP = {
  'not started': 0, 'pre-onboarding': 0, 'unknown': 0, '': 0,
  'document collection started': 1,
  'internal review': 2, 'submission preparation': 2, 'stuck': 2,
  'submitted': 3, 'application submitted': 3,
  'approved': 4, 'refused': 4, 'closed': 4, 'withdrawn': 4, 'cancelled': 4, 'archived': 4,
};

// Decision-step outcomes get their own client-facing label + tone.
const DECISION_LABEL = {
  approved:  { label: 'Approved 🎉', tone: 'good' },
  refused:   { label: 'Decision received', tone: 'end' },
  closed:    { label: 'Case closed', tone: 'end' },
  withdrawn: { label: 'Case withdrawn', tone: 'end' },
  cancelled: { label: 'Case cancelled', tone: 'end' },
  archived:  { label: 'Case archived', tone: 'end' },
};

/**
 * PURE: internal Case Stage → the client journey position.
 * @returns {{ step: number, steps: string[], label: string, tone: 'good'|'active'|'end' }}
 */
function clientStage(caseStage) {
  const key = String(caseStage || '').trim().toLowerCase();
  const step = (key in STAGE_TO_STEP) ? STAGE_TO_STEP[key] : 2; // unrecognised = in progress with TDOT
  if (step === 4) {
    const d = DECISION_LABEL[key] || { label: 'Decision', tone: 'end' };
    return { step, steps: JOURNEY_STEPS, label: d.label, tone: d.tone };
  }
  return { step, steps: JOURNEY_STEPS, label: JOURNEY_STEPS[step], tone: step === 3 ? 'good' : 'active' };
}

// ─── Client timeline ────────────────────────────────────────────────────────
//
// The cockpit's buildTimeline speaks staff shorthand. Re-voice each event for
// the client ("We received your document: Passport"), and drop anything that
// isn't theirs to see — unknown titles are dropped rather than leaked.

const CLIENT_TITLE_MAP = [
  [/^Inquiry received$/,                 () => 'We received your inquiry'],
  [/^Booking invite sent$/,              () => 'Consultation invitation sent to you'],
  [/^Consultation scheduled$/,           () => 'Your consultation was booked'],
  [/^Consultation held$/,                () => 'Your consultation took place'],
  [/^Consultation agreement emailed$/,   () => 'Consultation agreement sent to you'],
  [/^Retainer agreement sent$/,          () => 'Your retainer agreement was sent'],
  [/^Retainer signed — case opened$/,    () => 'Retainer signed — your case opened'],
  [/^First retainer payment recorded$/,  () => 'Your first payment was received — thank you'],
  [/^e-Transfer requested — (.+)$/,      (m) => `Payment requested — ${m[1]}`],
  [/^Paid — (.+)$/,                      (m) => `Payment received — ${m[1]} — thank you`],
  [/^Document received — (.+)$/,         (m) => `We received your document: ${m[1]}`],
  [/^Questionnaire submitted — (.+)$/,   (m) => `Questionnaire submitted — ${m[1]}`],
];

/** PURE: staff timeline events → client-voiced events (unknown titles dropped). */
function toClientTimeline(events) {
  const out = [];
  for (const ev of events || []) {
    for (const [re, fmt] of CLIENT_TITLE_MAP) {
      const m = re.exec(ev.title || '');
      if (m) { out.push({ date: ev.date, title: fmt(m), detail: ev.detail || '', kind: ev.kind }); break; }
    }
  }
  return out;
}

// ─── Live data fetch ────────────────────────────────────────────────────────

/**
 * Fetch every piece of live state needed to render the portal in ONE
 * Monday round-trip + parallel OneDrive/document calls.
 */
async function getPortalSnapshot({ caseRef, validatedCase }) {
  // validatedCase already has: itemId, clientName, caseType, caseSubType, accessToken, formFiles
  const itemId = validatedCase.itemId;

  // 1. Pull stage + Q readiness directly off the CM row
  const cmData = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: [
           "${CM.caseStage}", "${CM.qReadiness}", "${CM.qCompletionStatus}"
         ]) { id text value }
       }
     }`,
    { itemId: String(itemId) }
  ).catch(() => null);
  const cmCols = cmData?.items?.[0]?.column_values || [];
  const colTxt = (id) => (cmCols.find(c => c.id === id)?.text || '').trim();

  const caseStage         = colTxt(CM.caseStage)         || 'Not Started';
  const qReadinessRaw     = colTxt(CM.qReadiness);
  const qReadinessPct     = qReadinessRaw ? Math.max(0, Math.min(100, Math.round(Number(qReadinessRaw)))) : 0;
  const qCompletionStatus = colTxt(CM.qCompletionStatus) || '';

  // 2. Document summary + Q members in parallel
  const [docSummary, members] = await Promise.all([
    docFormSvc.getCaseSummary(caseRef).catch(() => ({ items: [] })),
    htmlQ.loadMembers({ clientName: validatedCase.clientName, caseRef }).catch(() => []),
  ]);

  // 3. Compute document counts
  const docItems = docSummary?.items || [];
  const docCounts = { total: docItems.length, received: 0, reviewed: 0, rework: 0, missing: 0 };
  const reworkDocs = [];
  for (const it of docItems) {
    const s = it.status || 'Missing';
    if (s === 'Received')               docCounts.received++;
    else if (s === 'Reviewed')          docCounts.reviewed++;
    else if (s === 'Rework Required') { docCounts.rework++; reworkDocs.push(it); }
    else                                docCounts.missing++;
  }

  // 3b. Client-shaped checklist rows for the portal's Documents card — the id
  //     powers the token-gated per-document upload endpoint.
  const clientDocs = docItems.map((it) => ({
    id:             it.id,
    name:           it.name,
    status:         it.status || 'Missing',
    category:       it.category || 'General',
    applicantType:  it.applicantType || 'Principal Applicant',
    reviewNotes:    it.reviewNotes || '',
    clientInstructions: it.clientInstructions || '',
    lastUpload:     it.lastUpload || '',
  }));

  // 4. Questionnaire status — submitted member count from manifest
  const totalMembers     = members.length || 1;
  const submittedMembers = members.filter(m => m.submittedAt).length;

  // 5. Lead-linked extras (payments + case history) — the SAME helper the
  //    staff cockpit uses, so both portals read identical shapes. Best-effort:
  //    legacy cases without a linked lead simply get an empty journey.
  const cockpit = require('./caseCockpitService');
  const { lead, payments } = await cockpit.getLeadExtras(itemId, caseRef)
    .catch(() => ({ lead: null, payments: null }));
  const timeline = toClientTimeline(cockpit.buildTimeline({
    lead,
    milestones: (payments && payments.milestones) || [],
    qMembers:   members || [],
    docItems,
  }));

  return {
    clientName: validatedCase.clientName,
    caseRef,
    caseType:    validatedCase.caseType,
    caseSubType: validatedCase.caseSubType,
    caseStage,
    accessToken: validatedCase.accessToken,
    qReadinessPct,
    qCompletionStatus,
    docCounts,
    reworkDocs,
    docItems: clientDocs,
    totalMembers,
    submittedMembers,
    journey: clientStage(caseStage),
    timeline,
    payments,
  };
}

// ─── Page builder ───────────────────────────────────────────────────────────

/**
 * @param {object} snap     — output of getPortalSnapshot()
 * @param {object} [opts]
 * @param {'client'|'staff'} [opts.mode='client']  — which role the page is for
 * @param {string} [opts.staffName]                — shown in the staff badge when mode=staff
 */
function buildPortalPage(snap, opts) {
  const mode      = (opts && opts.mode === 'staff') ? 'staff' : 'client';
  const staffName = (opts && opts.staffName) || '';
  const isStaff   = mode === 'staff';

  const tokenParam = snap.accessToken ? `?t=${encodeURIComponent(snap.accessToken)}` : '';
  const encodedRef = encodeURIComponent(snap.caseRef);

  // URL targets differ by role:
  //   client → goes to the client-facing form/upload pages
  //   staff  → goes to the staff review pages (auth-gated themselves)
  const qUrl   = isStaff
    ? `${BASE_URL}/q/${encodedRef}/review`
    : `${BASE_URL}/q/${encodedRef}${tokenParam}`;
  const docUrl = isStaff
    ? `${BASE_URL}/d/${encodedRef}/review`
    : `${BASE_URL}/documents/${encodedRef}`;

  // Q card colour cue based on readiness
  const qPct      = snap.qReadinessPct;
  const qDone     = snap.submittedMembers === snap.totalMembers && qPct >= 100;
  const qLabel    = qDone ? 'Submitted' : (qPct > 0 ? 'In Progress' : 'Not Started');

  // Button copy is role-aware
  const qBtnText = isStaff
    ? 'Open Review Form →'
    : (qDone ? 'Review Your Answers →' : (qPct > 0 ? 'Continue Filling →' : 'Start Questionnaire →'));

  // Doc card status
  const docTotal      = snap.docCounts.total;
  const docDone       = docTotal > 0 ? (snap.docCounts.received + snap.docCounts.reviewed) : 0;
  const docPct        = docTotal > 0 ? Math.round(docDone / docTotal * 100) : 0;
  const docBtnText    = isStaff
    ? 'Open Document Review →'
    : (docTotal === 0 ? 'View Your Documents →' : (docPct === 100 ? 'Review Documents →' : 'Continue Uploading →'));

  // Pending actions list — role-aware copy
  const pending = [];
  if (snap.docCounts.rework > 0) {
    pending.push(isStaff
      ? `📂 ${snap.docCounts.rework} document${snap.docCounts.rework === 1 ? '' : 's'} flagged for rework — awaiting client re-upload`
      : `📂 ${snap.docCounts.rework} document${snap.docCounts.rework === 1 ? '' : 's'} need${snap.docCounts.rework === 1 ? 's' : ''} re-upload (rework requested)`);
  }
  if (!qDone && qPct < 100) {
    pending.push(isStaff
      ? `📝 Questionnaire is ${qPct}% complete — client still has fields to finish`
      : `📝 Questionnaire is ${qPct}% complete — please finish remaining fields`);
  }
  if (snap.totalMembers > 1 && snap.submittedMembers < snap.totalMembers) {
    const remaining = snap.totalMembers - snap.submittedMembers;
    pending.push(isStaff
      ? `👥 ${remaining} of ${snap.totalMembers} family member${snap.totalMembers === 1 ? '' : 's'} have not submitted yet`
      : `👥 ${remaining} family member${remaining === 1 ? '' : 's'} still need${remaining === 1 ? 's' : ''} their questionnaire submitted`);
  }
  if (snap.docCounts.received > 0) {
    if (isStaff) pending.push(`🟡 ${snap.docCounts.received} document${snap.docCounts.received === 1 ? '' : 's'} awaiting your review`);
  }
  if (!pending.length) {
    pending.push(isStaff
      ? '✅ Nothing pending — case is on track.'
      : '✅ Nothing pending right now — your case officer will be in touch.');
  }

  const pendingHtml = pending.map(p => `<li style="margin:6px 0;">${escHtml(p)}</li>`).join('');

  // ── Journey stepper (from the pure clientStage mapping) ────────────────────
  const journey = snap.journey || clientStage(snap.caseStage);
  const stepperHtml = `<section class="journey" aria-label="Your case progress">
      <div class="j-steps">
        ${journey.steps.map((label, i) => {
          const cls = i < journey.step ? 'done' : (i === journey.step ? 'cur' : 'todo');
          const tone = (i === journey.step && journey.tone === 'good') ? ' good' : '';
          const dot = i < journey.step ? '✓' : String(i + 1);
          const lbl = i === journey.step ? journey.label : label;
          return `<div class="j-step ${cls}${tone}"><div class="j-dot">${dot}</div><div class="j-lbl">${escHtml(lbl)}</div></div>`;
        }).join('')}
      </div>
    </section>`;

  // ── Payments card (view + how-to-pay; never a processor) ──────────────────
  // Rendered only when a milestone schedule exists. Paid rows show their date
  // and reference; a requested milestone gets the e-Transfer instructions with
  // the reference code the client must include; a due-but-not-yet-requested
  // milestone is announced honestly without instructions (the request email
  // carries them). Amounts are the HST-inclusive totals from the schedule.
  const pay = snap.payments;
  const payMilestones = (pay && pay.milestones) || [];
  let paymentsHtml = '';
  if (payMilestones.length) {
    const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
    const paidCents = payMilestones.filter((m) => m.status === 'paid').reduce((s, m) => s + (m.totalCents || 0), 0);
    const totalCents = payMilestones.reduce((s, m) => s + (m.totalCents || 0), 0);
    const rows = payMilestones.map((m) => {
      const label = m.label || `Milestone ${Number(m.index) + 1}`;
      let badge, when = '', how = '';
      if (m.status === 'paid') {
        badge = '<span class="pay-badge paid">✓ Paid</span>';
        when = `<span class="pay-when">${escHtml(m.paidAt || '')}${m.reference ? ' · ref ' + escHtml(m.reference) : ''}</span>`;
      } else if (m.status === 'requested') {
        badge = '<span class="pay-badge duenow">Due now</span>';
        how = `<div class="howpay">Please pay by <b>Interac e-Transfer</b> to <b>${escHtml(pay.etransferEmail || '')}</b> and include the reference
               <span class="refcode">${escHtml(m.reference || '')}</span> in the message — it links your payment to this milestone.
               We confirm by email once it arrives.</div>`;
      } else if (m.due) {
        badge = '<span class="pay-badge duenow">Due now</span>';
        how = `<div class="howpay">This milestone is now due — a payment request with the e-Transfer details is on its way to your inbox.</div>`;
      } else {
        badge = '<span class="pay-badge soon">Not due yet</span>';
      }
      return `<div class="pay-row"><span class="pay-name">${escHtml(label)}</span>${badge}${when}<span class="pay-amt">${money(m.totalCents)}</span>${how}</div>`;
    }).join('');
    paymentsHtml = `<section class="card">
      <div class="card-head">
        <div>
          <h3>💳 Payments</h3>
          <div class="sub">Your retainer milestones — amounts include HST. We only ever ask for payment by Interac e-Transfer${pay.etransferEmail ? ` to <b>${escHtml(pay.etransferEmail)}</b>` : ''}.</div>
        </div>
        <span class="badge ${paidCents >= totalCents ? 'badge-ok' : 'badge-prog'}">${payMilestones.filter((m) => m.status === 'paid').length} of ${payMilestones.length} paid</span>
      </div>
      ${rows}
      <div class="pay-total"><span>Paid so far</span><span>${money(paidCents)} of ${money(totalCents)}</span></div>
    </section>`;
  }

  // ── "Your case journey" timeline (client-voiced, chronological) ───────────
  const CTL_DOT = { lead: '#0B1D32', meeting: '#0B1D32', retainer: '#C9A84C', payment: '#1F7A4D', doc: '#9AA3AF', questionnaire: '#B7791F' };
  const tlEvents = snap.timeline || [];
  const timelineHtml = tlEvents.length ? `<section class="card">
      <div class="card-head">
        <div>
          <h3>🕓 Your case journey</h3>
          <div class="sub">Everything that has happened on your file so far.</div>
        </div>
      </div>
      <div class="ctl">
        ${tlEvents.map((e) => {
          const dt = String(e.date || '').replace('T', ' ').slice(0, 16); // date, plus time when the source recorded one
          return `<div class="ctl-ev"><span class="ctl-dot" style="background:${CTL_DOT[e.kind] || '#9AA3AF'}"></span>
            <div class="ctl-date">${escHtml(dt)}</div>
            <div class="ctl-title">${escHtml(e.title)}</div>
            ${e.detail ? `<div class="ctl-detail">${escHtml(e.detail)}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </section>` : '';

  // ── Documents checklist: per-doc rows with status + inline client upload ──
  // Missing / Rework rows get an Upload control (token-gated endpoint);
  // Received / Reviewed rows show their state. Staff mode is read-only here —
  // staff act on the /d review page (or the case cockpit).
  const DOC_DOT = { Reviewed: '#1F7A4D', Received: '#0B1D32', 'Rework Required': '#B42318', Missing: '#C9CDD4' };
  const docsByCat = new Map();
  for (const it of (snap.docItems || [])) {
    if (!docsByCat.has(it.category)) docsByCat.set(it.category, []);
    docsByCat.get(it.category).push(it);
  }
  const showTag = snap.totalMembers > 1;
  const docListHtml = [...docsByCat.entries()].map(([cat, items]) => {
    const rows = items.map((it) => {
      const uploadable = !isStaff && (it.status === 'Missing' || it.status === 'Rework Required');
      const statusLine = it.status === 'Missing'
        ? 'Not uploaded yet'
        : `${escHtml(it.status === 'Rework Required' ? 'Needs a new copy' : it.status)}${it.lastUpload ? ` · uploaded ${escHtml(it.lastUpload)}` : ''}`;
      const note = (it.status === 'Rework Required' && it.reviewNotes)
        ? `<div class="doc-note"><strong>From your case officer:</strong> ${escHtml(it.reviewNotes)}</div>` : '';
      const right = uploadable
        ? `<span class="up-wrap"><label class="up-btn${it.status === 'Rework Required' ? '' : ' re'}">${it.status === 'Rework Required' ? 'Upload new copy' : 'Upload'}<input type="file" data-item="${escHtml(it.id)}" data-name="${escHtml(it.name)}"></label><span class="up-state" data-state="${escHtml(it.id)}"></span></span>`
        : `<span class="doc-ok">${it.status === 'Reviewed' ? '✓ Reviewed' : (it.status === 'Received' ? '✓ Received' : '')}</span>`;
      return `<div class="doc-row"><span class="doc-dot" style="background:${DOC_DOT[it.status] || '#C9CDD4'}"></span>
        <div class="doc-main">
          <div class="doc-name">${escHtml(it.name)}${showTag ? `<span class="doc-tag">${escHtml(it.applicantType)}</span>` : ''}</div>
          <div class="doc-meta">${statusLine}</div>
          ${note}
        </div>${right}</div>`;
    }).join('');
    return `<div class="doc-cat">${escHtml(cat)}</div>${rows}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isStaff ? 'Case Review' : 'Client Portal'} — ${escHtml(snap.caseRef)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #FAF8F4; color: #1F2937; }

    /* Dark brand header */
    .top {
      background:#0B1D32; color:#fff; padding:18px 28px;
      box-shadow:0 2px 8px rgba(0,0,0,.18);
      border-bottom:3px solid #C9A84C;        /* gold accent stripe */
      display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;
    }
    .top-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .top-brand img { height:38px; object-fit:contain; }
    .top h1 { font-size:18px; font-weight:700; line-height:1.25; }
    .top p  { font-size:12px; color:rgba(255,255,255,.65); margin-top:3px; }
    .stage-pill {
      display:inline-block; background:rgba(201,168,76,.18); color:#C9A84C;
      border:1px solid rgba(201,168,76,.35);
      font-size:11px; font-weight:700; padding:3px 10px; border-radius:999px;
      letter-spacing:.04em; margin-left:8px; vertical-align:middle;
    }

    .content { max-width: 760px; margin: 24px auto; padding: 0 18px 60px; }

    /* Journey stepper */
    .journey { background:#fff; border:1px solid #EAE3D5; border-radius:10px; padding:18px 16px 14px; margin-bottom:20px; }
    .j-steps { display:flex; align-items:flex-start; }
    .j-step { flex:1; display:flex; flex-direction:column; align-items:center; text-align:center; position:relative; min-width:0; }
    .j-step::before { content:""; position:absolute; top:13px; left:-50%; width:100%; height:3px; background:#EAE3D5; z-index:0; }
    .j-step:first-child::before { display:none; }
    .j-step.done::before, .j-step.cur::before { background:#C9A84C; }
    .j-dot { position:relative; z-index:1; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center;
             font-size:12px; font-weight:800; background:#fff; border:2.5px solid #EAE3D5; color:#B9AE97; }
    .j-step.done .j-dot { background:#C9A84C; border-color:#C9A84C; color:#fff; }
    .j-step.cur  .j-dot { background:#0B1D32; border-color:#0B1D32; color:#fff; box-shadow:0 0 0 4px rgba(11,29,50,.12); }
    .j-step.cur.good .j-dot, .j-step.done.good .j-dot { background:#1F7A4D; border-color:#1F7A4D; }
    .j-lbl { font-size:10.5px; font-weight:600; color:#B9AE97; margin-top:7px; line-height:1.3; padding:0 4px; }
    .j-step.done .j-lbl { color:#7A5F1F; }
    .j-step.cur  .j-lbl { color:#0B1D32; font-weight:800; }
    @media (max-width:520px){ .j-lbl { font-size:9px; } }

    /* Documents checklist rows */
    .doc-cat { font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; color:#B9AE97; margin:14px 0 2px; }
    .doc-row { display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-top:1px solid #F4EFE4; }
    .doc-row:first-of-type { border-top:none; }
    .doc-dot { width:9px; height:9px; border-radius:50%; flex:none; margin-top:5px; }
    .doc-main { flex:1; min-width:0; }
    .doc-name { font-size:13.5px; font-weight:700; color:#0B1D32; }
    .doc-tag { display:inline-block; font-size:10px; font-weight:700; color:#8A7B57; background:#F6F1E4; border-radius:999px; padding:1px 8px; margin-left:6px; vertical-align:middle; }
    .doc-meta { font-size:11.5px; color:#9AA3AF; margin-top:1px; }
    .doc-note { font-size:12px; color:#7f1d1d; background:#fef2f2; border-left:3px solid #fca5a5; border-radius:6px; padding:7px 10px; margin-top:6px; }
    .up-wrap { flex:none; display:flex; flex-direction:column; align-items:flex-end; gap:4px; }
    .up-btn { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:#fff; background:#8B0000; border-radius:8px; padding:7px 14px; cursor:pointer; }
    .up-btn.re { background:#0B1D32; }
    .up-btn input { display:none; }
    .up-state { font-size:10.5px; color:#9AA3AF; max-width:150px; text-align:right; }
    .doc-ok { flex:none; font-size:12px; font-weight:700; color:#1F7A4D; padding-top:3px; white-space:nowrap; }

    /* Payments */
    .pay-row { display:flex; align-items:flex-start; gap:10px; padding:11px 0; border-top:1px solid #F4EFE4; flex-wrap:wrap; }
    .pay-row:first-of-type { border-top:none; }
    .pay-name { font-size:13.5px; font-weight:700; color:#0B1D32; flex:1; min-width:180px; }
    .pay-amt { font-size:14px; font-weight:800; color:#0B1D32; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .pay-badge { font-size:10.5px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; border-radius:999px; padding:3px 10px; white-space:nowrap; }
    .pay-badge.paid { background:#EAF6EF; color:#1F7A4D; }
    .pay-badge.duenow { background:#FDEBE7; color:#B42318; }
    .pay-badge.soon { background:#F6F1E4; color:#8A7B57; }
    .pay-when { font-size:11.5px; color:#9AA3AF; white-space:nowrap; }
    .howpay { flex-basis:100%; background:#FBF7EC; border:1px solid #EAD9A8; border-left:4px solid #C9A84C; border-radius:8px; padding:11px 14px; margin-top:6px; font-size:13px; color:#5C4716; line-height:1.55; }
    .howpay b { color:#3F3110; }
    .howpay .refcode { display:inline-block; font-family:ui-monospace, Menlo, Consolas, monospace; font-weight:700; background:#fff; border:1px dashed #C9A84C; border-radius:6px; padding:2px 9px; color:#7A5F1F; }
    .pay-total { display:flex; justify-content:space-between; font-size:13px; font-weight:700; color:#0B1D32; border-top:2px solid #EFE9DC; padding-top:10px; margin-top:6px; }

    /* Case journey timeline */
    .ctl { position:relative; padding-left:22px; margin-top:4px; }
    .ctl::before { content:""; position:absolute; left:6px; top:6px; bottom:6px; width:2px; background:#EFE9DC; border-radius:1px; }
    .ctl-ev { position:relative; padding:0 0 14px 8px; }
    .ctl-ev:last-child { padding-bottom:2px; }
    .ctl-dot { position:absolute; left:-22px; top:3px; width:11px; height:11px; border-radius:50%; border:2.5px solid #fff; box-shadow:0 0 0 1.5px #E4DCCB; }
    .ctl-date { font-size:10px; font-weight:700; color:#B9AE97; text-transform:uppercase; letter-spacing:.05em; }
    .ctl-title { font-size:13.5px; font-weight:700; color:#0B1D32; margin-top:1px; }
    .ctl-detail { font-size:12px; color:#6B7280; margin-top:1px; }

    .pending {
      background:#FFF8E6; border:1px solid #F0D98A; border-radius:10px;
      padding:14px 18px; margin-bottom:20px;
      border-left:4px solid #C9A84C;
    }
    .pending h2 { font-size:13px; font-weight:700; color:#7A5F1F; margin-bottom:6px;
                  text-transform:uppercase; letter-spacing:.06em; }
    .pending ul { list-style:none; padding-left:0; font-size:14px; color:#5C4716; line-height:1.6; }

    .card {
      background:#FFFFFF; border-radius:12px; padding:22px 26px;
      box-shadow:0 1px 8px rgba(11,29,50,.06);
      border:1px solid #E7E2D6; margin-bottom:18px;
    }
    .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }
    .card h3 { font-size:16px; color:#0B1D32; margin-bottom:4px; }
    .card .sub { font-size:12px; color:#6B7280; }
    .badge { display:inline-block; padding:3px 10px; border-radius:999px;
             font-size:11px; font-weight:700; letter-spacing:.03em; }
    .badge-ok      { background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; }
    .badge-prog    { background:#FFF8E6; color:#7A5F1F; border:1px solid #F0D98A; }
    .badge-todo    { background:#F4F0E6; color:#6B7280; border:1px solid #E7E2D6; }
    .badge-warn    { background:#fef2f2; color:#991b1b; border:1px solid #fca5a5; }

    .progress-row { margin-top:14px; }
    .progress-bar { height:8px; background:#E7E2D6; border-radius:999px; overflow:hidden; }
    .progress-fill { height:100%; background:#8B0000; border-radius:999px; transition:width .3s; }
    .progress-meta { font-size:12px; color:#6B7280; margin-top:6px; display:flex; justify-content:space-between; }

    .btn {
      display:inline-block; margin-top:14px;
      background:#8B0000; color:#fff; padding:10px 20px;
      border-radius:8px; font-size:14px; font-weight:700; text-decoration:none;
      transition: background .15s;
    }
    .btn:hover { background:#6B0000; }
    .btn-light { background:#FFFFFF; color:#8B0000; border:1px solid #8B0000; }
    .btn-light:hover { background:#FAF1F1; }

    .case-meta {
      background:#FFFFFF; border:1px solid #E7E2D6; border-radius:10px;
      padding:12px 18px; margin-bottom:18px;
      display:flex; flex-wrap:wrap; gap:18px 24px; font-size:13px; color:#6B7280;
    }
    .case-meta strong { color:#0B1D32; }

    .footer {
      margin-top:24px; text-align:center; font-size:12px; color:#6B7280; line-height:1.6;
      padding-top:18px; border-top:1px solid #E7E2D6;
    }
    .footer-brand { color:#8B0000; font-weight:700; letter-spacing:.04em; }
  </style>
</head>
<body>
  <header class="top">
    <div class="top-brand">
      <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration">
      <div>
        <h1>${escHtml(snap.clientName)}<span class="stage-pill">${escHtml(isStaff ? snap.caseStage : journey.label)}</span></h1>
        <p>Case ${escHtml(snap.caseRef)} · ${escHtml(snap.caseType || '')}${snap.caseSubType ? ' / ' + escHtml(snap.caseSubType) : ''}</p>
      </div>
    </div>
    ${isStaff ? `<div style="font-size:11px;font-weight:700;padding:5px 14px;border-radius:999px;background:rgba(201,168,76,.18);color:#C9A84C;border:1px solid rgba(201,168,76,.35);letter-spacing:.04em;">Reviewing as ${escHtml(staffName || 'Staff')}</div>` : ''}
  </header>

  <main class="content">

    <div class="case-meta">
      <div>📋 <strong>Case:</strong> ${escHtml(snap.caseRef)}</div>
      <div>📌 <strong>Stage:</strong> ${escHtml(isStaff ? snap.caseStage : journey.label)}</div>
      ${snap.totalMembers > 1 ? `<div>👥 <strong>Applicants:</strong> ${snap.submittedMembers} / ${snap.totalMembers} submitted</div>` : ''}
    </div>

    ${stepperHtml}

    <section class="pending">
      <h2>📌 ${isStaff ? 'Case status' : "What's pending"}</h2>
      <ul>${pendingHtml}</ul>
    </section>

    <!-- Questionnaire card -->
    <section class="card">
      <div class="card-head">
        <div>
          <h3>📝 Questionnaire</h3>
          <div class="sub">${isStaff
            ? 'Open the staff review form to flag fields, leave feedback, or request corrections.'
            : 'Tell us about your background, history, and details for your case.'}</div>
        </div>
        <span class="badge ${qDone ? 'badge-ok' : (qPct > 0 ? 'badge-prog' : 'badge-todo')}">${escHtml(qLabel)}</span>
      </div>
      <div class="progress-row">
        <div class="progress-bar"><div class="progress-fill" style="width:${qPct}%;"></div></div>
        <div class="progress-meta">
          <span>${qPct}% complete</span>
          ${snap.totalMembers > 1 ? `<span>${snap.submittedMembers} of ${snap.totalMembers} family members submitted</span>` : ''}
        </div>
      </div>
      <a href="${escHtml(qUrl)}" class="btn">${escHtml(qBtnText)}</a>
    </section>

    <!-- Documents card -->
    <section class="card">
      <div class="card-head">
        <div>
          <h3>📂 Documents</h3>
          <div class="sub">${isStaff
            ? `${docTotal} document${docTotal === 1 ? '' : 's'} on this case — open the review page to mark them as reviewed or request rework.`
            : `${docTotal} document${docTotal === 1 ? '' : 's'} requested for this case.`}</div>
        </div>
        <span class="badge ${snap.docCounts.rework > 0 ? 'badge-warn' : (docPct === 100 ? 'badge-ok' : (docDone > 0 ? 'badge-prog' : 'badge-todo'))}">${docPct}% uploaded</span>
      </div>
      <div class="progress-row">
        <div class="progress-bar"><div class="progress-fill" style="width:${docPct}%;background:${snap.docCounts.rework > 0 ? '#8B0000' : '#0B1D32'};"></div></div>
        <div class="progress-meta">
          <span>${docDone} of ${docTotal} ready</span>
          ${snap.docCounts.rework > 0 ? `<span style="color:#991b1b;font-weight:700;">${snap.docCounts.rework} need re-upload</span>` : ''}
        </div>
      </div>
      ${docListHtml || '<div class="doc-meta" style="margin-top:8px">No documents have been requested yet — your checklist appears here as soon as your case officer prepares it.</div>'}
      ${isStaff
        ? `<a href="${escHtml(docUrl)}" class="btn" style="margin-top:14px">${escHtml(docBtnText)}</a>`
        : (docListHtml ? `<div style="margin-top:12px;font-size:12px;color:#9AA3AF;">Files upload securely straight from this page. Prefer the full page with detailed instructions? <a href="${escHtml(docUrl)}" style="color:#8B0000;font-weight:700;">Open it here</a>.</div>` : '')}
    </section>

    ${paymentsHtml}

    ${timelineHtml}

    <p class="footer">
      ${isStaff
        ? `Linked from the Client Master Board · ${escHtml(snap.caseRef)}<br>This portal mirrors the live state — every load queries Monday + OneDrive.`
        : `If you have questions, simply reply to the email your case officer sent you.<br>Please include your <strong>Case Reference Number</strong> in any correspondence.`}<br>
      <span class="footer-brand">TDOT IMMIGRATION SERVICES</span>
    </p>

  </main>
  ${!isStaff && (snap.docItems || []).some((d) => d.status === 'Missing' || d.status === 'Rework Required') ? `<script>
  (function () {
    var CASE_REF = ${JSON.stringify(snap.caseRef)};
    var TOKEN    = ${JSON.stringify(snap.accessToken || '')};
    var MAX      = 20 * 1024 * 1024;
    function state(id, msg, isErr) {
      var el = document.querySelector('[data-state="' + id + '"]');
      if (el) { el.textContent = msg; el.style.color = isErr ? '#B42318' : '#9AA3AF'; }
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[type="file"][data-item]'), function (input) {
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var id = input.getAttribute('data-item');
        if (file.size > MAX) { state(id, 'File is over 20 MB — please send a smaller copy.', true); input.value = ''; return; }
        var label = input.closest('label'); if (label) { label.style.opacity = '.55'; label.style.pointerEvents = 'none'; }
        state(id, 'Uploading ' + file.name + '…');
        var fd = new FormData();
        fd.append('file', file, file.name);
        fetch('/client/' + encodeURIComponent(CASE_REF) + '/document/' + encodeURIComponent(id) + '/upload?t=' + encodeURIComponent(TOKEN), {
          method: 'POST', body: fd
        })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.success, j: j }; }); })
        .then(function (res) {
          if (res.ok) { state(id, 'Uploaded ✓ — refreshing…'); setTimeout(function () { window.location.reload(); }, 900); }
          else {
            state(id, (res.j && res.j.error) || 'Upload failed — please try again.', true);
            if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
            input.value = '';
          }
        })
        .catch(function () {
          state(id, 'Upload failed — please check your connection and try again.', true);
          if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
          input.value = '';
        });
      });
    });
  })();
  </script>` : ''}
</body>
</html>`;
}

// ─── Helper used by caseRefService and backfill script ──────────────────────

/**
 * Build the URL for the unified portal page.
 *
 * @param {object}  opts
 * @param {string}  opts.caseRef
 * @param {string?} opts.accessToken Client access token (omit for staff-only links)
 * @param {boolean} [opts.staff]     If true, append ?staff=1 to indicate the
 *                                   link is intended for staff. The route
 *                                   uses this flag to redirect to Monday OAuth
 *                                   when no staff cookie is present, so a
 *                                   staff member clicking the link from
 *                                   Monday lands on the staff view rather
 *                                   than the client view. Email links should
 *                                   NOT set this flag — clients without a
 *                                   Monday account would otherwise hit a
 *                                   broken OAuth flow.
 */
function buildPortalUrl({ caseRef, accessToken, staff = false }) {
  const params = [];
  if (accessToken) params.push(`t=${encodeURIComponent(accessToken)}`);
  if (staff)       params.push('staff=1');
  const query = params.length ? `?${params.join('&')}` : '';
  return `${BASE_URL}/client/${encodeURIComponent(caseRef)}${query}`;
}

module.exports = {
  getPortalSnapshot,
  buildPortalPage,
  buildPortalUrl,
  // pure — exported for tests
  clientStage,
  toClientTimeline,
};
