'use strict';

/**
 * directConsultService — "＋ Direct consultation" (step 2, 2026-11-09).
 *
 * Melanie books most consultations in Square, and the app never saw them (189 in
 * 40 days). Staff now add each one by hand on the Consultations page: ONE Lead
 * Board row per consultation, created already Booked, with its marker:
 *   - the "Direct Consultation" column: New / Follow-up / Existing client — the
 *     SERVER works it out from the two buttons staff pick;
 *   - consultOption.directConsult: { kind, inSquare, followUpOf, caseRef, by, at }.
 *
 * What it never does: write to Square (no squareBookingId, no order, no invoice),
 * make a Teams meeting or send the client anything — except the consultation
 * package, only when staff tick it and the one existing gate passes.
 *
 * Switch DIRECT_CONSULTATION (ships unset = off): '1' on for all staff; a comma list
 * of emails = only those Monday sign-ins (the shared key is refused). It controls
 * ONLY the button and these endpoints — the reminder / chase / nudge skips read the
 * row's own marker (utils/directConsult), so rows made while it was on stay quiet.
 * The marker column not made yet (its id is "") → 503 "not set up yet", nothing written.
 *
 * Order of the checks (plan §4): validate (pure, the whole entry) → re-submit guard
 * (15-minute memory + the board) → Not Wanted → match (live booking default,
 * follow-up, existing case) → "Use this lead" guard → clash. Then the writes: create
 * (or the reused lead), the follow-up update, the fee record, the booking (no
 * meeting), the package if ticked, the notes. A later step that fails undoes
 * nothing: the reply lists what is left.
 */

const leadService = require('./leadService');
const mondayApi   = require('./mondayApi');
const DC          = require('../utils/directConsult');

const s = (v) => String(v == null ? '' : v).trim();
const oneLine = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const portal = () => require('./consultantPortalService');
const routing = () => require('../../config/consultantRouting');

const BACK_DAYS = 30;               // a consultation up to 30 days ago may be entered (question 6's default)
const AHEAD_DAYS = 365;
const LIVE_WINDOW_DAYS = 30;        // a live Booked consultation within ±30 days is "this is that consultation"
const RESUBMIT_MS = 15 * 60 * 1000; // the re-submit memory
const MIN_LEN = 15, MAX_LEN = 120, LEN_STEP = 15;
const MAX_ABOUT = 200;
const CHOICES = ['new', 'existing'];
// The pop-up's payment choices: four kinds the fee record knows, and "Not paid yet" (no record).
const PAY_KINDS = ['square', 'cash', 'e-transfer', 'waived', 'none'];
const PAY_LABELS = { square: 'Paid in Square', cash: 'Cash', 'e-transfer': 'E-transfer', waived: 'Free', none: 'Not paid yet' };
const EXISTING_SOURCE = 'Existing Client';
// A case at one of these stages is finished: the person is a PREVIOUS client. (A submitted
// application still waits for a decision — that is an active one.)
const CLOSED_STAGES = ['Approved', 'Refused', 'Closed', 'Withdrawn', 'Cancelled', 'Archived', 'Task Done'];

/* ─────────────────────────────── the switch ─────────────────────────────── */

function switchValue() { return s(process.env.DIRECT_CONSULTATION); }

/**
 * May this person use Direct consultation? { ok } or { ok: false, status, error, loginUrl? }.
 * Off → 404 (the endpoints do not exist). PURE apart from the environment.
 * @param {?{ name?, email?, verified? }} actor  staffActor(req) — verified = a Monday sign-in
 */
function gate(actor) {
  const v = switchValue();
  const off = { ok: false, status: 404, error: 'Not found' };
  if (!v || /^(0|false|off|no)$/i.test(v)) return off;
  if (/^(1|true|on|yes)$/i.test(v)) return { ok: true };
  const list = v.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'));
  if (!list.length) return off;
  const email = actor && actor.verified === true ? s(actor.email).toLowerCase() : '';
  if (!email) return { ok: false, status: 401, error: 'Sign in with Monday to add a direct consultation — the shared key does not say who you are.', loginUrl: '/q/auth/monday' };
  return list.includes(email) ? { ok: true } : off;
}
/** The button shows only for someone the endpoints accept. */
function enabledFor(actor) { return gate(actor).ok; }

/** Switch first (off = 404 whatever the column), then the column (503). Throws err.status. */
function assertUsable(actor) {
  const g = gate(actor);
  if (!g.ok) { const e = new Error(g.error); e.status = g.status; if (g.loginUrl) e.loginUrl = g.loginUrl; throw e; }
  DC.assertSetUp();
}

/* ─────────────────────────────── consultants ─────────────────────────────── */

/** Every consultant the direct path accepts: the RCICs, then the direct-only ones. */
function consultantList() {
  const r = routing();
  const rcics = Object.values(r.CONSULTANTS).map((c) => {
    const opts = r.consultOptionsFor(c);
    const def = opts.find((o) => o.default) || opts[0] || {};
    return { name: c.name, rcic: true, defaultMin: def.durationMin || 30, options: opts.map((o) => ({ durationMin: o.durationMin, feeCents: o.feeCents })) };
  });
  const others = r.DIRECT_ONLY_CONSULTANTS.map((name) => ({ name, rcic: false, defaultMin: 30, options: [] }));
  return [...rcics, ...others];
}
const isRcicName = (name) => Object.values(routing().CONSULTANTS).some((c) => c.name === name);

/* ─────────────────────────────── the validator ─────────────────────────────── */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNum = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
const intOf = (v) => (typeof v === 'number' ? v : (/^\d+$/.test(s(v)) ? Number(s(v)) : NaN));

/**
 * The consultation's time, consultant, type and length. PURE.
 * Up to 30 days back (it happened and is being entered late) and a year ahead; any
 * length from 15 to 120 minutes in 15-minute steps (Square lengths vary — the fee
 * comes from the record, never from the length).
 */
function validateBooking(b, { nowWall }) {
  const bad = (error) => ({ ok: false, error });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Enter the consultation date and time.');
  const date = s(b.date), time = s(b.time);
  const cp = require('./consultPaymentService');
  if (!cp.isRealDay(date)) return bad('Enter the consultation date.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return bad('Enter the consultation time (HH:MM, Toronto time).');
  const slot = `${date} ${time}`;
  const today = String(nowWall).slice(0, 10);
  const diff = dayNum(date) - dayNum(today);
  if (diff < -BACK_DAYS) return bad(`That consultation is more than ${BACK_DAYS} days ago — only the last ${BACK_DAYS} days can be added here.`);
  if (diff > AHEAD_DAYS) return bad('That consultation date looks wrong (more than a year ahead).');
  const consultant = oneLine(b.consultant);
  if (!consultantList().some((c) => c.name === consultant)) return bad('Choose the consultant.');
  const meetingType = s(b.meetingType);
  if (!cp.MEETING_TYPES.includes(meetingType)) return bad('Choose how the consultation happens: in person, video or phone.');
  const durationMin = intOf(b.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < MIN_LEN || durationMin > MAX_LEN || durationMin % LEN_STEP) {
    return bad(`Choose the length: ${MIN_LEN} to ${MAX_LEN} minutes, in steps of ${LEN_STEP}.`);
  }
  return { ok: true, booking: { slot, date, time, consultant, meetingType, durationMin, past: slot <= nowWall } };
}

/**
 * The whole pop-up, before anything is read or written. PURE apart from the clock.
 * @returns {{ ok: true, n: object } | { ok: false, error: string }}
 */
function validateDirectConsult(p, { nowWall = require('./consultPaymentService').torontoNowWall(), actor = null } = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!p || typeof p !== 'object' || Array.isArray(p)) return bad('Invalid entry.');
  const choice = s(p.choice);
  if (!CHOICES.includes(choice)) return bad('Choose "New client / new matter" or "Existing client: about their current file".');
  const existing = choice === 'existing';
  const fullName = oneLine(p.fullName).slice(0, 121);
  if (fullName.length < 2) return bad('Enter the client’s full name.');
  if (fullName.length > 120) return bad('The name is too long (max 120 characters).');
  const email = s(p.email).slice(0, 201);
  const phone = oneLine(p.phone).slice(0, 41);
  if (!email && !phone) return bad('Enter an email or a phone number — one of the two is required.');
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return bad('That email doesn’t look right — fix it or leave it empty.');
  const digits = phone.replace(/\D/g, '');
  if (phone && (!/^[\d\s()+.\-]+$/.test(phone) || digits.length < 7 || digits.length > 15)) return bad('Enter a valid phone number (7 to 15 digits).');

  const bk = validateBooking({ date: p.date, time: p.time, consultant: p.consultant, meetingType: p.meetingType, durationMin: p.durationMin }, { nowWall });
  if (!bk.ok) return bk;
  const booking = bk.booking;

  // The fee: one of the pop-up's five answers; a paid kind needs the fee before HST.
  const kind = s(p.payment && p.payment.kind);
  if (!PAY_KINDS.includes(kind)) return bad('Choose the payment: Paid in Square, Cash, E-transfer, Free or Not paid yet.');
  let payment = null;
  if (kind !== 'none') {
    const pay = p.payment;
    const v = require('./consultPaymentService').validateRecord({ kind, amountCents: pay.amountCents, on: pay.on, reference: pay.reference, note: pay.note }, { nowWall });
    if (!v.ok) return v;
    payment = { kind: v.normalized.kind, amountCents: v.normalized.amountCents, on: v.normalized.on, reference: v.normalized.reference, note: v.normalized.note };
  }

  const about = oneLine(p.about);
  if (about.length < 3) return bad('Say in one short line what the consultation is about.');
  if (about.length > MAX_ABOUT) return bad(`Keep "what it is about" under ${MAX_ABOUT} characters.`);
  const caseType = oneLine(p.caseType).slice(0, 101);

  // Who booked it: preset to the person signed in; with the shared key staff must pick.
  const roster = require('../../config/portalStaff');
  const signedIn = !!(actor && actor.verified && s(actor.name));
  const bookedBy = oneLine(p.bookedBy).slice(0, 61) || (signedIn ? roster.rosterNameFor(actor.name) : '');
  if (!bookedBy) return bad('Choose who booked it.');
  if (!roster.onRoster(bookedBy) && !(signedIn && bookedBy === roster.rosterNameFor(actor.name))) return bad('Choose who booked it from the list.');

  // Source and referral: a new matter only. About their current file: "Existing Client", no referral asked.
  let sourceChannel = EXISTING_SOURCE, referredBy = '';
  if (!existing) {
    const LS = require('../../config/leadSources');
    sourceChannel = oneLine(p.sourceChannel);
    if (!LS.LEAD_SOURCES.includes(sourceChannel)) return bad('Choose the source / reference from the list.');
    const ref = LS.checkReferral(sourceChannel, p.referredBy);
    if (!ref.ok) return bad(ref.error);
    referredBy = ref.referredBy;
  }
  const referredFrom = p.referredFrom === 'list' ? 'list' : 'typed';

  // "Already booked in Square?" — asked for a time still ahead (it decides the client reminders).
  let inSquare = null;
  if (!booking.past) {
    if (p.inSquare !== true && p.inSquare !== false) return bad('Answer "Already booked in Square?" — Yes or No.');
    inSquare = p.inSquare;
  }

  // Where the client is now (optional here): it sets the HST on the fee.
  let loc = { insideCanada: '', country: '' };
  if (s(p.inCanada)) {
    const r = portal().normalizeLeadLocation({ inCanada: p.inCanada, country: p.currentCountry });
    if (!r.ok) return bad(r.error);
    loc = r;
  }

  const address = String(p.residentialAddress == null ? '' : p.residentialAddress)
    .replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).slice(0, 4).join('\n');
  if (address && address.length < 5) return bad('That address looks too short — enter the full address or leave it empty.');
  if (address.length > 500) return bad('The address is too long (max 500 characters).');

  // The consultation package: only a NEW client, a time still ahead, an email, an RCIC, a fee record.
  // (Video too is refused: no Teams meeting is made here, and the package needs its link.)
  const pkg = p.package === true;
  if (pkg) {
    if (existing) return bad('The consultation package is only for a new client — untick it.');
    if (booking.past) return bad('The consultation time has passed, so the package cannot be emailed — untick it.');
    if (!email) return bad('There is no email, so the package cannot be emailed — add the email or untick it.');
    if (!isRcicName(booking.consultant)) return bad(`${booking.consultant} is not an RCIC, so no consultation agreement can be sent — untick the package.`);
    if (!payment) return bad('The package goes with a recorded fee — choose how it was paid (or Free), or untick it.');
    if (booking.meetingType === 'Virtual') return bad('The package cannot go with a video consultation added here (the app makes no Teams link for it) — untick it.');
  }

  const useLeadId = s(p.useLeadId).replace(/\D/g, '').slice(0, 20);
  if (useLeadId && existing) return bad('"Use this lead" is for a new client or a new matter only.');
  const clientAccountId = s(p.clientAccountId).replace(/\D/g, '').slice(0, 20);

  return {
    ok: true,
    n: {
      choice, existing, fullName, email, phone, booking, payment, about, caseType, bookedBy,
      sourceChannel, referredBy, referredFrom, inSquare, insideCanada: loc.insideCanada, country: loc.country,
      residentialAddress: address, package: pkg, useLeadId, clientAccountId,
      differentConsultation: p.differentConsultation === true,
      blacklistAck: p.blacklistAck === true,
      clashAck: p.clashAck === true,
    },
  };
}

/* ─────────────────────────────── identity helpers ─────────────────────────────── */

const normName = (n) => require('./handoffService').normName(n);
const normEmail = (e) => s(e).toLowerCase();
const phoneKey = (p) => { const d = s(p).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const samePerson = (a, b) => (!!a.email && !!b.email && normEmail(a.email) === normEmail(b.email))
  || (phoneKey(a.phone).length >= 7 && phoneKey(a.phone) === phoneKey(b.phone))
  || (!!normName(a.fullName) && normName(a.fullName) === normName(b.fullName));
const slotDay = (slot) => (s(slot).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const durationOf = (lead) => { try { const n = parseInt((JSON.parse(s(lead.consultOption)) || {}).durationMin, 10); return Number.isFinite(n) && n > 0 ? n : 30; } catch (_) { return 30; } };

/* ─────────────────────────────── the re-submit memory + per-person lock ─────────────────────────────── */

const _recent = [];   // { at, leadId, consultant, slot, durationMin, email, phone, fullName, bookedBy }
function rememberCreate(e) { _recent.push({ ...e, at: Date.now() }); }
function recentHit(n) {
  const now = Date.now();
  for (let i = _recent.length - 1; i >= 0; i--) if (now - _recent[i].at >= RESUBMIT_MS) _recent.splice(i, 1);
  return _recent.find((r) => r.consultant === n.booking.consultant
    && portal().slotsOverlap(n.booking.slot, n.booking.durationMin, r.slot, r.durationMin)
    && samePerson(r, n)) || null;
}

const _locks = new Map();
async function withPersonLock(key, fn) {
  while (_locks.has(key)) await _locks.get(key).catch(() => {});
  const p = (async () => fn())();
  _locks.set(key, p);
  try { return await p; } finally { if (_locks.get(key) === p) _locks.delete(key); }
}

function conflict(code, message, extra = {}) {
  const e = new Error(message); e.conflict = true; e.status = 409; e.code = code; Object.assign(e, extra); return e;
}
function badRequest(message) { const e = new Error(message); e.badRequest = true; e.status = 400; return e; }

const recordLink = (id) => `/admin/consultation/${encodeURIComponent(String(id))}`;

/* ─────────────────────────────── the options for the pop-up ─────────────────────────────── */

async function getOptions({ actor = null } = {}) {
  assertUsable(actor);
  const roster = require('../../config/portalStaff');
  const signedIn = !!(actor && actor.verified && s(actor.name));
  const opts = await portal().getDirectClientOptions().catch(() => ({ caseTypes: [] }));
  return {
    consultants: consultantList(),
    lengths: Array.from({ length: (MAX_LEN - MIN_LEN) / LEN_STEP + 1 }, (_, i) => MIN_LEN + i * LEN_STEP),
    meetingTypes: require('./consultPaymentService').MEETING_TYPES,
    payments: PAY_KINDS.map((k) => ({ kind: k, label: PAY_LABELS[k] })),
    hstPct: require('./bookingService').consultHstPctForLead({}),   // in Canada (or not known): HST on top of the fee
    staff: roster.staffRoster(),
    bookedBy: signedIn ? roster.rosterNameFor(actor.name) : '',
    signedIn,
    sources: require('../../config/leadSources').LEAD_SOURCES,
    caseTypes: opts.caseTypes || [],
    backDays: BACK_DAYS,
  };
}

/* ─────────────────────────────── the create ─────────────────────────────── */

/**
 * "＋ Direct consultation" → Save.
 * @returns {{ ok, leadId, kind, reused, message, lines, left, link }}
 * @throws err.status 404/401 (switch), 503 (not set up), 400 (badRequest), 409 (conflict: code
 *   'already' | 'not-wanted' | 'same-consultation' | 'clash', with what the pop-up shows)
 */
async function createDirectConsult(payload = {}, { actor = null } = {}) {
  assertUsable(actor);
  const v = validateDirectConsult(payload, { actor });
  if (!v.ok) throw badRequest(v.error);
  const n = v.n;
  if (n.caseType) {
    const labels = await portal().getDirectClientOptions().catch(() => null);
    if (labels && Array.isArray(labels.caseTypes) && labels.caseTypes.length && !labels.caseTypes.includes(n.caseType)) {
      throw badRequest('Choose the case type from the list, or leave it empty.');
    }
  }
  // One save at a time per person: a double click waits, then meets the re-submit guard.
  return withPersonLock(`p:${normName(n.fullName)}`, () => createLocked(n, actor));
}

async function createLocked(n, actor) {
  const verified = !!(actor && actor.verified);
  const recorder = verified && s(actor.name) ? oneLine(actor.name).slice(0, 60) : n.bookedBy;
  const b = n.booking;

  // 2) Re-submit guard — BEFORE the match: the memory, then the board.
  const mem = recentHit(n);
  if (mem) {
    throw conflict('already', `Already in the app: ${mem.fullName}, ${mem.slot}, ${mem.consultant}, added by ${mem.bookedBy || 'staff'}.`, { leadId: mem.leadId, link: recordLink(mem.leadId) });
  }
  // The person's own rows (by email / phone) — read ONCE, used by every check below.
  let matches;
  try {
    matches = await portal().findClientMatches({ email: n.email, phone: n.phone, withLeads: true });
  } catch (err) {
    throw badRequest('Could not look this person up just now — nothing was saved. Try again in a minute.');
  }
  const rawLeads = (matches && matches.rawLeads) || [];
  const shown = { clients: matches.clients || [], cases: matches.cases || [], leads: matches.leads || [] };
  {
    let snapRows = [];
    try { snapRows = await require('./leadSnapshot').leads(); } catch (_) { snapRows = []; }
    const byId = new Map();
    for (const l of [...snapRows, ...rawLeads]) byId.set(String(l.id), l);
    const dup = [...byId.values()].find((l) => DC.isDirectConsult(l)
      && s(l.assignedConsultant) === b.consultant
      && portal().slotsOverlap(b.slot, b.durationMin, s(l.bookedSlot), durationOf(l))
      && (rawLeads.some((r) => String(r.id) === String(l.id)) || normName(l.fullName || l.name) === normName(n.fullName)));
    if (dup) {
      throw conflict('already', `Already in the app: ${oneLine(dup.fullName || dup.name)}, ${s(dup.bookedSlot)}, ${s(dup.assignedConsultant)}, added by ${s(dup.bookedBy) || 'staff'}.`, { leadId: String(dup.id), link: recordLink(dup.id) });
    }
  }

  // 3) The Not Wanted list — a warning; it needs the tick.
  const bl = require('./blacklistService');
  const blacklist = await bl.check({ email: n.email, phone: n.phone }).catch(() => ({ hit: false }));
  if (blacklist && blacklist.hit && !n.blacklistAck) {
    throw conflict('not-wanted', 'This person is on the Not Wanted list — read the warning and tick the box if you mean to add the consultation anyway.', { matches: shown, blacklist });
  }

  // 4) The match.
  const today = String(require('./consultPaymentService').torontoNowWall()).slice(0, 10);
  const others = rawLeads.filter((l) => String(l.id) !== n.useLeadId);
  if (!n.differentConsultation) {
    const live = others.filter((l) => s(l.bookingStatus) === 'Booked' && !s(l.outcome) && slotDay(l.bookedSlot)
      && Math.abs(dayNum(slotDay(l.bookedSlot)) - dayNum(b.date)) <= LIVE_WINDOW_DAYS);
    if (live.length) {
      const first = live.sort((x, y) => s(x.bookedSlot).localeCompare(s(y.bookedSlot)))[0];
      throw conflict('same-consultation',
        `This looks like the consultation already in the app: ${oneLine(first.fullName || first.name)}, ${s(first.bookedSlot)}${s(first.assignedConsultant) ? `, ${s(first.assignedConsultant)}` : ''}. `
        + 'If it moved, open its record and change the time there. If this is another consultation, choose "This is a different consultation".',
        { liveBooking: live.map((l) => ({ leadId: String(l.id), name: oneLine(l.fullName || l.name), slot: s(l.bookedSlot), consultant: s(l.assignedConsultant), link: recordLink(l.id) })), matches: shown });
    }
  }
  const cases = shown.cases;
  const openCases = cases.filter((c) => !CLOSED_STAGES.includes(s(c.caseStage)));
  const hasFile = cases.length > 0 || rawLeads.some((l) => s(l.clientMasterItemId));
  const R = require('./intakeFormService').RELATIONSHIPS;   // exact board labels
  const caseLabel = openCases.length ? R[1] : R[2];
  let kind, relationship, followUpOf = '', caseRef = '', caseItemId = '';
  if (n.existing) {
    kind = DC.EXISTING;
    relationship = caseLabel;
    if (openCases.length === 1) { caseRef = s(openCases[0].caseRef); caseItemId = s(openCases[0].id); }
  } else {
    const held = others.filter((l) => s(l.bookingStatus) === 'Booked' && DAY_RE.test(s(l.consultationHeld))
      && s(l.consultationHeld) < b.date && s(l.consultationHeld) <= today)
      .sort((x, y) => s(y.consultationHeld).localeCompare(s(x.consultationHeld)));
    if (held.length && !hasFile) { kind = 'Follow-up'; relationship = R[0]; followUpOf = String(held[0].id); }
    else { kind = 'New'; relationship = hasFile ? caseLabel : R[0]; }
  }

  // 5) "Use this lead" (a new matter): its own guard.
  const lines = [];
  let reuse = null;
  if (n.useLeadId) {
    reuse = await leadService.getLead(n.useLeadId);
    if (!reuse) throw badRequest('The lead you chose no longer exists — refresh and try again.');
    const why = reuseRefusal(reuse, n);
    if (why) throw badRequest(why);
    if (!s(reuse.squareConsultTxnId) && (s(reuse.squareConsultOrderId) || s(optionOf(reuse).invoiceId))) {
      lines.push('⚠ A booking-page payment link or Square invoice was made for this client earlier — cancel it in Square so they are not charged.');
    }
  }

  // 6) A clash for this consultant: a warning ("Save anyway"), never a refusal — family members share a time.
  if (!n.clashAck) {
    let claims;
    try { claims = await require('./bookingService').readSlotClaims({ strict: true }); }
    catch (_) { throw badRequest('Could not check the consultant’s other bookings in the app just now — nothing was saved. Try again in a minute.'); }
    const clash = (claims || []).filter((c) => String(c.leadId) !== n.useLeadId
      && (!c.consultant || c.consultant === b.consultant)
      && portal().slotsOverlap(b.slot, b.durationMin, c.slot));
    if (clash.length) {
      const c = clash[0];
      throw conflict('clash',
        `${c.consultant || 'Someone (no consultant set)'} already has a consultation at ${c.slot} (${oneLine(c.name) || `lead ${c.leadId}`}), which overlaps ${b.slot}. `
        + 'If this is a different client at the same time (family members can share one), choose "Save anyway (different client)".',
        { clash: clash.map((x) => ({ leadId: String(x.leadId), name: oneLine(x.name), slot: x.slot, consultant: x.consultant, status: x.status, link: recordLink(x.leadId) })) });
    }
  }

  // ── The writes. From here nothing is undone: what fails is listed for staff. ──
  const left = [];
  const marker = {
    kind, inSquare: n.inSquare, ...(followUpOf ? { followUpOf } : {}), ...(caseRef ? { caseRef } : {}),
    by: recorder, at: new Date().toISOString(),
  };

  // 1) The row: created already Booked with its marker (or the reused lead turned into it).
  let leadId, base;
  if (reuse) {
    leadId = String(reuse.id);
    const head = { directConsult: kind, conversionStatus: 'Booked', bookedBy: n.bookedBy, fullName: n.fullName,
      ...(n.email ? { email: n.email } : {}), ...(n.residentialAddress ? { residentialAddress: n.residentialAddress } : {}),
      ...(n.country ? { country: n.country } : {}) };
    await leadService.updateLead(leadId, head);   // a failure here leaves the lead as it was — the error reaches staff
    base = { ...reuse, ...head };
  } else {
    const created = await leadService.createLead({
      fullName: n.fullName,
      ...(n.email ? { email: n.email } : {}),
      sourceChannel: n.sourceChannel,
      ...(n.referredBy ? { referredBy: n.referredBy } : {}),
      leadOwner: n.bookedBy,
      situationDescription: n.about,
      ...(n.residentialAddress ? { residentialAddress: n.residentialAddress } : {}),
      ...(n.country ? { country: n.country } : {}),
      directConsult: kind,
      bookedSlot: b.slot, consultationHeld: b.date, assignedConsultant: b.consultant, meetingType: b.meetingType, bookedBy: n.bookedBy,
    }, { groupId: require('../data/newLeadsBoard.json').funnelGroupId || undefined, createRetries: 0, skipFolder: kind !== 'New' });
    leadId = String(created.id);
    base = { id: leadId, fullName: n.fullName, email: n.email, sourceChannel: n.sourceChannel, referredBy: n.referredBy, leadOwner: n.bookedBy,
      situationDescription: n.about, residentialAddress: n.residentialAddress, country: n.country, directConsult: kind,
      bookingStatus: 'Booked', conversionStatus: 'Booked', bookedSlot: b.slot, consultationHeld: b.date, assignedConsultant: b.consultant,
      meetingType: b.meetingType, bookedBy: n.bookedBy, consultOption: '' };
  }
  rememberCreate({ leadId, consultant: b.consultant, slot: b.slot, durationMin: b.durationMin, email: n.email, phone: n.phone, fullName: n.fullName, bookedBy: n.bookedBy });
  try { portal().invalidateLeadsQueue(); } catch (_) { /* a list cache only */ }

  // 2) The follow-up write (dropdowns and statuses add their labels here), retried once.
  const follow = {
    ...(n.phone ? { phone: n.phone } : {}),
    relationshipWithTdot: relationship,
    ...(n.insideCanada ? { insideCanada: n.insideCanada } : {}),
    ...(n.clientAccountId ? { clientAccountId: n.clientAccountId } : {}),
    ...(n.caseType ? { caseTypeInterest: n.caseType } : {}),
    // A reused lead keeps how it first reached us (its source and referrer); the form fills only what is empty.
    ...(reuse && !s(reuse.sourceChannel) ? { sourceChannel: n.sourceChannel } : {}),
    ...(reuse && !s(reuse.referredBy) && n.referredBy ? { referredBy: n.referredBy } : {}),
  };
  let followOk = false;
  for (let i = 0; i < 2 && !followOk; i++) {
    try { await leadService.updateLead(leadId, follow); followOk = true; }
    catch (err) { if (i === 1) { console.warn(`[DirectConsult] follow-up write failed for lead ${leadId}: ${err.message}`); left.push(`The phone, the relationship${n.caseType ? ', the case type' : ''}${n.insideCanada ? ', where the client is' : ''} could not be saved — set them on the record.`); } }
  }
  const lead = { ...base, ...(followOk ? follow : {}) };
  // The marker in consultOption (keeping what a reused lead's option holds, e.g. an invoice id).
  lead.consultOption = JSON.stringify({ ...optionOf(reuse || {}), directConsult: marker });

  // 3–5) The fee, the booking and the package: one save at a time per lead (the record lock).
  let rec = null, pkg = null, bookingOk = false;
  await portal().withRecordLock(leadId, async () => {
    if (n.payment) {
      try {
        const before = reuse ? require('./consultPaymentService').parseConsultPayment(reuse) : null;
        rec = portal().buildConsultPaymentRecord({
          n: n.payment, lead, before, name: recorder, verified,
          pkgChoice: n.package ? 'send' : 'skip', pkgNote: n.package ? '' : 'Direct consultation — booked outside the app',
        });
        await leadService.updateLead(leadId, { consultPayment: JSON.stringify(rec) });
        lead.consultPayment = JSON.stringify(rec);
        try { require('./consultAgreementService').evictCache(leadId); } catch (_) { /* a cached preview only */ }
      } catch (err) {
        rec = null;
        left.push(`The payment (${PAY_LABELS[n.payment.kind]}) could not be recorded (${err.message}) — use "Record payment" on the record.`);
      }
    }
    let overrides = {};
    try {
      // staffName = who BOOKED it, and the lead as just written (bookedBy on it) — the recorder never replaces it.
      const w = await portal().writeRecordedBooking(leadId, lead, b, n.bookedBy, lines, { meeting: 'none' });
      overrides = w.overrides; bookingOk = true;
    } catch (err) {
      left.push(`The booking details (length, time) could not be saved in full (${err.message}) — check the record and save the time again.`);
    }
    if (n.package && rec) {
      if (!bookingOk) {
        left.push('The consultation package was NOT emailed, because the booking could not be saved.');
      } else {
        const cs = require('./consultationService');
        pkg = await cs.autoSendConsultationPackage(leadId, { trigger: 'recorded', overrides: { consultPayment: JSON.stringify(rec), ...overrides } })
          .catch((err) => ({ status: 'failed', reason: err.message }));
        const line = portal()._packageResultLine(pkg, { pkgChoice: 'send', pkgNote: '', kind: rec.kind, alreadySent: false, applicable: { ok: true }, onRecord: cs.packageOnRecordEnabled(leadId), hasTime: true });
        if (line) lines.push(line);   // e.g. "waiting for the client's residential address" when it was left blank
        else if (!cs.packageOnRecordEnabled(leadId)) lines.push('The package is not emailed automatically (switched off) — use "Review & send" on the record.');
      }
    }
  });

  // 6) The notes.
  const pay = rec ? require('./consultPaymentService').describe(rec) : (n.payment ? `${PAY_LABELS[n.payment.kind]} (not recorded)` : 'Not paid yet');
  const tail = followUpOf ? ` · follow-up of lead ${followUpOf}` : caseRef ? ` · case ${caseRef}` : '';
  const square = n.inSquare === true ? ' · in Square: yes (the app sends no reminders)' : n.inSquare === false ? ' · in Square: no (the app sends the reminders)' : '';
  try {
    await mondayApi.query('mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }', {
      id: leadId,
      b: `🧑‍💼 <b>[Consultant portal]</b> 📅 Direct consultation added by ${esc(recorder)}${verified ? '' : ' (name as typed)'} — booked by ${esc(n.bookedBy)} · ${esc(b.slot)} · ${esc(b.consultant)} · ${esc(b.meetingType)} · ${b.durationMin} min · ${esc(pay)} · ${esc(kind)}${esc(tail)}${square}. `
        + `About: ${esc(n.about)}.${reuse ? ` (Added on this existing lead — "Use this lead".)` : ''}${lines.length ? ' ' + esc(lines.join(' ')) : ''}`,
    });
  } catch (err) { left.push('The note on the record could not be posted.'); console.warn(`[DirectConsult] note failed for lead ${leadId}: ${err.message}`); }
  if (kind === DC.EXISTING) {
    if (caseItemId) {
      try {
        await mondayApi.query('mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }', {
          id: caseItemId,
          b: `📅 <b>Consultation about this file</b> (internal): ${esc(b.slot)} with ${esc(b.consultant)} (${esc(b.meetingType)}) — booked by ${esc(n.bookedBy)}, added by ${esc(recorder)}. About: ${esc(n.about)}. Record: lead ${esc(leadId)}.`,
        });
      } catch (err) { left.push(`The note on case ${caseRef} could not be posted.`); }
    } else if (openCases.length > 1) {
      lines.push(`This person has ${openCases.length} open cases, so no case note was added — add one on the right case if needed.`);
    }
  }
  if (blacklist && blacklist.hit) await bl.noteOnLead(leadId, blacklist, 'Staff saw the warning and added this direct consultation anyway.').catch(() => false);
  try { portal().invalidateLeadsQueue(); } catch (_) { /* a list cache only */ }
  console.log(`[DirectConsult] lead ${leadId} — ${kind}${reuse ? ' (reused lead)' : ''}, ${b.consultant}, ${b.slot}, by ${recorder}`);

  const message = `Saved: ${n.fullName}, ${b.slot}, ${b.consultant} (${kind}).`
    + (lines.length ? ` ${lines.join(' ')}` : '')
    + (left.length ? ` Still to do: ${left.join(' ')}` : '');
  return { ok: true, leadId, kind, reused: !!reuse, relationship, message, lines, left, link: recordLink(leadId), ...(pkg ? { package: pkg.status } : {}) };
}

/** consultOption as an object ({} when blank or unreadable). */
function optionOf(lead) {
  try { const o = JSON.parse(s(lead && lead.consultOption)); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (_) { return {}; }
}

/**
 * "Use this lead" (a new matter): why this lead may NOT become the direct consultation,
 * or '' when it may. Refuses anything further along — an outcome, a case, a retainer,
 * a plan in progress, a booking, a live online hold — and a lead that is not the person
 * typed. Allows an abandoned or expired hold. PURE apart from the clock.
 */
function reuseRefusal(lead, n, now = Date.now()) {
  const R = (why) => `That lead can’t be used: ${why}`;
  if (DC.isDirectConsult(lead)) return R('it is already a direct consultation — open its record instead.');
  if (require('../utils/directClient').isDirectClient(lead)) return R('it is a direct retainer client.');
  if (s(lead.outcome)) return R(`it already has an outcome (${s(lead.outcome)}) — add this as a new row instead (leave "Use this lead" off).`);
  if (s(lead.clientMasterItemId) || s(lead.conversionStatus) === 'Retained') return R('it already has a case.');
  if (s(lead.retainerSent) || s(lead.retainerSigned)) return R('a retainer is already under way.');
  if ([lead.retainerMilestones, lead.selectedTemplate, lead.retainerFee].some((x) => s(x))) return R('a retainer plan is in progress.');
  if (s(lead.squareConsultTxnId)) return R('it paid through the booking link — open its record instead.');
  const st = s(lead.bookingStatus);
  if (st === 'Booked') return R('it already has a booked consultation — open its record instead.');
  const heldUntil = Date.parse(s(lead.slotHeldUntil));
  if (st === 'Slot Held' && Number.isFinite(heldUntil) && heldUntil > now) return R('the client is booking online right now (their time is held) — wait until the hold ends.');
  const sameEmail = !!(n.email && s(lead.email) && normEmail(lead.email) === normEmail(n.email));
  const samePhone = phoneKey(n.phone).length >= 7 && phoneKey(lead.phone) === phoneKey(n.phone);
  const sameName = normName(lead.fullName) === normName(n.fullName);
  if (!sameEmail && !samePhone && !sameName) return R('it does not match the name, email or phone you typed.');
  if (!n.email && s(lead.email)) return R(`it has the email ${s(lead.email)} — keep it in the Email box, or type the client’s new email.`);
  return '';
}

/* ─────────────────────────────── Change time (record page, direct rows only) ─────────────────────────────── */

/**
 * A wrongly typed time on a direct consultation otherwise blocks a real public slot
 * (readSlotClaims). Same validator, no meeting. Called by applyAction('changeDirectTime').
 */
async function changeTime({ leadId, lead, value, actor = null, who = '' }) {
  assertUsable(actor);
  const bad = (m) => { throw badRequest(m); };
  if (!DC.isDirectConsult(lead)) bad('Change time is only for a direct consultation — change this booking in Monday.');
  if (s(lead.outcome)) bad('An outcome is set, so the consultation has happened — the time is kept.');
  if (require('./consultationService').packageAlreadySent(lead)) bad('The consultation package already went out with the old time — change it in Monday and tell the client.');
  let o = value; try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { o = null; }
  if (!o || typeof o !== 'object') bad('Enter the new date and time.');
  const v = validateBooking({
    date: o.date, time: o.time,
    consultant: s(lead.assignedConsultant), meetingType: s(lead.meetingType),
    durationMin: o.durationMin != null && s(o.durationMin) !== '' ? o.durationMin : durationOf(lead),
  }, { nowWall: require('./consultPaymentService').torontoNowWall() });
  if (!v.ok) bad(v.error);
  const b = v.booking;
  if (b.slot === s(lead.bookedSlot) && b.durationMin === durationOf(lead)) return { ok: true, message: 'No change.' };
  if (o.clashAck !== true) {
    let claims;
    try { claims = await require('./bookingService').readSlotClaims({ strict: true }); }
    catch (_) { bad('Could not check the consultant’s other bookings in the app just now — nothing was saved. Try again in a minute.'); }
    const clash = (claims || []).find((c) => String(c.leadId) !== String(leadId) && (!c.consultant || c.consultant === b.consultant) && portal().slotsOverlap(b.slot, b.durationMin, c.slot));
    if (clash) throw conflict('clash', `${clash.consultant || 'Someone (no consultant set)'} already has a consultation at ${clash.slot}, which overlaps ${b.slot}. If this is a different client at the same time, choose "Save anyway".`, { clash: [{ leadId: String(clash.leadId), slot: clash.slot, consultant: clash.consultant }] });
  }
  const lines = [];
  const byName = actor && actor.verified && s(actor.name) ? oneLine(actor.name).slice(0, 60) : oneLine(who).slice(0, 60);
  await portal().withRecordLock(leadId, () => portal().writeRecordedBooking(leadId, lead, b, s(lead.bookedBy) || byName, lines, { meeting: 'none' }));
  await portal().postPortalNote(leadId, `🕒 Direct consultation time changed${byName ? ` by ${esc(byName)}` : ''}: ${esc(b.slot)} (${b.durationMin} min), was ${esc(s(lead.bookedSlot) || '—')}.${lines.length ? ' ' + esc(lines.join(' ')) : ''}`);
  try { portal().invalidateLeadsQueue(); } catch (_) { /* a list cache only */ }
  return { ok: true, message: `Time changed to ${b.slot}.${lines.length ? ' ' + lines.join(' ') : ''}`, bookedSlot: b.slot };
}

/** What the record page and the list show about a direct consultation (null when it is not one). PURE. */
function directView(lead) {
  if (!DC.isDirectConsult(lead)) return null;
  const d = DC.optionMarker(lead).detail || {};
  return {
    kind: DC.kindOf(lead), bookedBy: s(lead.bookedBy),
    inSquare: d.inSquare === true ? true : d.inSquare === false ? false : null,
    followUpOf: s(d.followUpOf), caseRef: s(d.caseRef), by: s(d.by),
    durationMin: durationOf(lead),   // the record page's "Change time" starts from it
  };
}

function _resetForTests() { _recent.length = 0; _locks.clear(); }

module.exports = {
  gate, enabledFor, assertUsable, consultantList, validateBooking, validateDirectConsult,
  getOptions, createDirectConsult, changeTime, directView, reuseRefusal,
  PAY_KINDS, PAY_LABELS, BACK_DAYS, CLOSED_STAGES,
  _resetForTests,
};
