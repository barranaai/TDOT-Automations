/**
 * Lead Priority Service (V2 step 3) — the deterministic rules engine from
 * TDOT's intake brief, sections 4 ("Internal Appointment and Lead Priority
 * Rules") and 5 ("Suggested IT Scoring Logic").
 *
 *   evaluatePriority(fields)  → PURE: { priority, tier, reasons[] }
 *   applyPriority(leadId, f)  → writes Priority / Tier / Priority Reasons,
 *                               fires the Critical internal alert
 *
 * Rules decide the priority; the AI is a second opinion only (leadService
 * .qualifyLead writes its tier to "AI Tier Opinion" and flags disagreement).
 *
 * Priority → tier mapping (tiers drive the existing booking machinery):
 *   Critical → T0 (urgent slots, no consult fee)   High → T1
 *   Medium   → T2                                  Low  → T3
 *   Existing Client → no tier (routed out of the lead funnel)
 */

'use strict';

const PRIORITY_TO_TIER = { Critical: 'T0', High: 'T1', Medium: 'T2', Low: 'T3' };
const BAND = { Critical: 4, High: 3, Medium: 2, Low: 1 };
// AI tier → equivalent band, for disagreement detection.
const AI_TIER_BAND = { T0: 4, T1: 3, T2: 2, T3: 1, T4: 1, Newsletter: 0, Decline: 0 };

/** Whole days from today (UTC date-only) until a YYYY-MM-DD date. null if absent/invalid. */
function daysUntil(dateStr, now = new Date()) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86400000);
}

/** Days SINCE a date (positive = in the past). null if absent/invalid. */
function daysSince(dateStr, now = new Date()) {
  const d = daysUntil(dateStr, now);
  return d == null ? null : -d;
}

/**
 * PURE rules evaluation over the intake fields (same camelCase keys as the
 * Lead Board columns). Every trigger that fires is recorded in reasons[] so
 * staff can audit exactly why a lead got its flag.
 *
 * @param {object} f    intake/lead fields
 * @param {Date}  [now] injectable clock for tests
 * @returns {{ priority: string, tier: string|null, reasons: string[] }}
 */
function evaluatePriority(f, now = new Date()) {
  // ── Existing Client Route: never enters the lead/sales queue ──
  if (f.relationshipWithTdot === 'Existing client with active application') {
    return { priority: 'Existing Client', tier: null, reasons: ['Active client — route to assigned case team, not the lead queue.'] };
  }

  const critical = [];
  const high = [];
  const medium = [];

  const crs = Number(String(f.crsScore || '').trim());
  const hasCrs = Number.isFinite(crs) && String(f.crsScore || '').trim() !== '';

  // Date-based urgency only counts when the date is upcoming or VERY recently
  // passed (grace window). A months-old or typo'd past date must never mint a
  // Critical/T0 — those fall through to Medium with explicit wording.
  const GRACE = -7;
  const fresh = (d) => d != null && d >= GRACE;

  // Fold the E-section deadline into its matching specific signal (the brief's
  // reasons map 1:1 onto these), mirroring how ITA is folded.
  const deadlineDays = daysUntil(f.deadlineDate, now);
  const minOf = (...vals) => { const v = vals.filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  const itaDays = minOf(f.deadlineReason === 'ITA deadline' ? deadlineDays : null, daysUntil(f.itaDeadline, now));
  const restorationDays = minOf(f.deadlineReason === 'Restoration deadline' ? deadlineDays : null, daysUntil(f.restorationDeadline, now));
  const expiryDays = minOf(f.deadlineReason === 'Status expiry' ? deadlineDays : null, daysUntil(f.statusExpiry, now));
  // Refusals dated in the future are junk — ignore the date signal entirely.
  const refusalAgeRaw = daysSince(f.refusalDate, now);
  const refusalAgeDays = refusalAgeRaw != null && refusalAgeRaw >= 0 ? refusalAgeRaw : null;

  // ── CRITICAL (brief: immediate internal alert) ──
  if (f.removalOrder === 'Yes') critical.push('Removal / departure / exclusion / deportation order or enforcement action reported');
  if (f.enforcementLetter === 'Yes') critical.push('Letter/notice from CBSA, IRCC, or law enforcement received');
  if (['CBSA or removal matter', 'Hearing or appointment'].includes(f.deadlineReason) && fresh(deadlineDays)) {
    critical.push(`${f.deadlineReason} deadline in ${deadlineDays} day(s) (${f.deadlineDate})`);
  }
  // Restoration: being in a restoration period MEANS status is expired —
  // ≤14 days left is Critical (brief: "expired + restoration within 30 days"),
  // 15–30 days is High (brief's scoring table row). Grace-floored.
  if (fresh(restorationDays) && restorationDays <= 14 && (f.restorationPeriod === 'Yes' || f.currentStatus === 'No valid status')) {
    critical.push(`Status expired — restoration deadline in ${restorationDays} day(s)`);
  }
  if (fresh(itaDays) && itaDays <= 30) critical.push(`ITA deadline in ${itaDays} day(s)`);
  if (f.deadlineReason === 'Passport request deadline' && fresh(deadlineDays) && deadlineDays <= 7) {
    critical.push(`Passport request deadline in ${deadlineDays} day(s) (${f.deadlineDate})`);
  }
  if (hasCrs && crs > 500) critical.push(`CRS score ${crs} (above 500)`);

  // ── HIGH (brief: same business day) ──
  if (fresh(itaDays) && itaDays > 30 && itaDays <= 60) high.push(`ITA deadline in ${itaDays} day(s)`);
  if (expiryDays != null && expiryDays <= 30) {
    high.push(expiryDays < 0 ? `Status expired ${-expiryDays} day(s) ago (${f.statusExpiry})` : `Status expiry in ${expiryDays} day(s) (${f.statusExpiry})`);
  }
  if (fresh(restorationDays) && restorationDays > 14 && restorationDays <= 30) {
    high.push(`Restoration deadline in ${restorationDays} day(s) (${f.restorationDeadline})`);
  }
  if (f.recentRefusal === 'Yes' && refusalAgeDays != null && refusalAgeDays <= 60) {
    high.push(`Refusal ${refusalAgeDays} day(s) ago (${f.refusalType || 'type not given'})`);
  }
  if (f.deadlineReason === 'PNP deadline' && fresh(deadlineDays)) high.push(`PNP deadline in ${deadlineDays} day(s) (${f.deadlineDate})`);
  if (f.deadlineReason === 'Employer deadline' && fresh(deadlineDays)) high.push(`Employer deadline in ${deadlineDays} day(s) (${f.deadlineDate})`);
  if (f.deadlineReason === 'Passport request deadline' && fresh(deadlineDays) && deadlineDays > 7) {
    high.push(`Passport/VFS deadline in ${deadlineDays} day(s) (${f.deadlineDate})`);
  }
  if (hasCrs && crs > 470 && crs <= 500) high.push(`CRS score ${crs} (above 470)`);
  // Safety net: ANY confirmed upcoming deadline within 7 days is at least High.
  if (fresh(deadlineDays) && deadlineDays <= 7) high.push(`Deadline within ${deadlineDays} day(s): ${f.deadlineReason || 'reason not given'} (${f.deadlineDate})`);

  // ── MEDIUM signals (standard intake) ──
  if (f.recentRefusal === 'Yes' && refusalAgeDays != null && refusalAgeDays > 60) {
    medium.push(`Refusal ${refusalAgeDays} day(s) ago — older than 60 days`);
  }
  if (hasCrs && crs > 450 && crs <= 470) medium.push(`CRS score ${crs} (above 450)`);
  if (deadlineDays != null && deadlineDays > 7) medium.push(`Deadline in ${deadlineDays} day(s): ${f.deadlineReason || ''} (${f.deadlineDate})`);
  if (deadlineDays != null && deadlineDays < GRACE) medium.push(`Stated deadline already passed ${-deadlineDays} day(s) ago (${f.deadlineReason || ''} ${f.deadlineDate}) — verify with the client`);
  if (itaDays != null && itaDays > 60) medium.push(`ITA deadline in ${itaDays} day(s) — beyond the 60-day urgency window`);

  if (critical.length) return { priority: 'Critical', tier: 'T0', reasons: critical };
  if (high.length)     return { priority: 'High',     tier: 'T1', reasons: high };

  // ── LOW (brief: general/future planning, no deadline, or CRS ≤ 450) ──
  const noUrgency = f.urgentDeadline !== 'Yes' && f.recentRefusal !== 'Yes';
  if (hasCrs && crs <= 450 && noUrgency && !medium.length) {
    return { priority: 'Low', tier: 'T3', reasons: [`CRS score ${crs} (450 or below) — newsletter/standard response`] };
  }
  if (f.whatDoYouWant === 'General information' && noUrgency && !medium.length) {
    return { priority: 'Low', tier: 'T3', reasons: ['General information request with no deadline or risk signals'] };
  }

  // ── MEDIUM default: valid status + a service need, no immediate risk ──
  const reasons = medium.length ? medium : ['Service need with no immediate deadline or status risk — standard intake'];
  return { priority: 'Medium', tier: 'T2', reasons };
}

/** Should the AI's opinion be flagged to staff as a disagreement? */
function aiDisagreement(rulesPriority, aiTier) {
  const rulesBand = BAND[rulesPriority];
  const ai = String(aiTier || '').trim();
  const aiBand = AI_TIER_BAND[ai];
  if (rulesBand == null || aiBand == null) return false;
  // Flag when the AI is MORE alarmed than the rules (it may have read
  // something in the free text the structured fields missed); when it says
  // Decline while the rules queued the lead at all; or when it says
  // Newsletter against a Medium+ queue position.
  return aiBand > rulesBand
    || (ai === 'Decline' && rulesBand >= 1)
    || (ai === 'Newsletter' && rulesBand >= 2);
}

// ─── I/O wrappers ─────────────────────────────────────────────────────────────

/**
 * Evaluate + persist priority/tier/reasons on the lead, and fire the Critical
 * internal alert (Monday update always; email if LEAD_ALERT_EMAIL is set).
 * Returns the evaluation so callers can pass it to the AI second opinion.
 */
async function applyPriority(leadId, fields) {
  const leadService = require('./leadService');
  const result = evaluatePriority(fields);

  // The alert must survive a Monday column-write failure (the email channel is
  // exactly what still works during a Monday outage) — so write first, but
  // never let a write error short-circuit the alert.
  let writeError = null;
  try {
    const update = { priority: result.priority, priorityReasons: result.reasons.join('\n') };
    if (result.tier) update.tier = result.tier;
    await leadService.updateLead(leadId, update);
    console.log(`[Priority] Lead ${leadId} → ${result.priority}${result.tier ? ` (${result.tier})` : ''}: ${result.reasons[0]}`);
  } catch (err) {
    writeError = err;
    console.error(`[Priority] Column write failed for ${leadId} (alert still firing): ${err.message}`);
  }

  // Enforcement flags on an EXISTING client don't change their routing, but
  // a removal order on an active file still deserves the immediate alert.
  const enforcementOnExisting = result.priority === 'Existing Client'
    && (fields.removalOrder === 'Yes' || fields.enforcementLetter === 'Yes');
  if (result.priority === 'Critical' || enforcementOnExisting) {
    const alertReasons = enforcementOnExisting
      ? ['EXISTING CLIENT reporting enforcement: ' + [fields.removalOrder === 'Yes' ? 'removal/enforcement order' : '', fields.enforcementLetter === 'Yes' ? 'CBSA/IRCC letter' : ''].filter(Boolean).join(' + '), ...result.reasons]
      : result.reasons;
    await sendCriticalAlert(leadId, fields, { ...result, reasons: alertReasons }).catch((err) =>
      console.warn(`[Priority] Critical alert failed for ${leadId}: ${err.message}`));
  }

  if (writeError) throw writeError;
  return result;
}

async function sendCriticalAlert(leadId, fields, result) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 1. Monday update on the lead (always — visible wherever staff triage).
  const mondayApi = require('./mondayApi');
  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
    { itemId: String(leadId),
      body: `🚨 CRITICAL LEAD — immediate review required\n\n${result.reasons.map((r) => `• ${esc(r)}`).join('\n')}\n\n` +
            `Per intake policy: route to urgent review, do not give detailed advice over WhatsApp, recommend paid consultation or senior review.` }
  ).catch((err) => console.warn(`[Priority] Critical Monday note failed: ${err.message}`));

  // 2. Email alert (optional — set LEAD_ALERT_EMAIL on the server).
  const to = process.env.LEAD_ALERT_EMAIL;
  if (!to) return;
  const microsoftMail = require('./microsoftMailService');
  await microsoftMail.sendEmail({
    to,
    subject: `🚨 CRITICAL lead: ${fields.fullName || leadId} — ${result.reasons[0]}`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:560px">
      <h2 style="color:#8B0000">Critical lead — immediate review</h2>
      <p><b>${esc(fields.fullName || '')}</b> · ${esc(fields.email || '')} · ${esc(fields.phone || '')}</p>
      <ul>${result.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <p>Service: ${esc(fields.serviceRequired || '')} · Inside Canada: ${esc(fields.insideCanada || '')} · Status: ${esc(fields.currentStatus || '')}</p>
      <p>Open the lead in Monday (New Leads board) — full intake digest and uploaded letters are on the item.</p>
    </div>`,
  });
  console.log(`[Priority] Critical alert emailed to ${to} for lead ${leadId}`);
}

module.exports = { evaluatePriority, aiDisagreement, applyPriority, daysUntil, PRIORITY_TO_TIER };
