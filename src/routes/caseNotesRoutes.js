'use strict';

/**
 * The case page's Consultation notes panel — its two routes (switch CASE_NOTES_PANEL, off until Faran's live check):
 *   GET  /admin/case-notes/:caseRef                     → the consultations of the case with their notes
 *   POST /admin/case-notes/:caseRef  { leadId, body }   → one new "📝 Consultation notes" entry on that lead
 *
 * Not /api routes: staff signed in only with Monday use them (the Updates tab's /api read needs the shared key).
 * server.js registers them and hands in its own helpers (resolveViewer, staffActor); the handlers live here so
 * tests run them with fakes.
 *
 * The access check is LIGHT: the case lookup + the Client Master people columns (and the consultation copy's
 * Record link, in the same read) → resolveViewer / viewerCanSee. Never the full case read. The 503 rule is
 * /admin/case-data's: when the case row cannot be read, a viewer who is not an admin hears 503 — never 403,
 * never let through.
 *
 * Writing needs a Monday sign-in (the name on the note comes from it, never from a typed field). The lead set is
 * read again LIVE for every write: a leadId outside it is refused, and every write is refused while the case is
 * linked to records that name different people — or while part of that check failed (`partial`: 503, nothing
 * saved). The same note anywhere in the entries the panel shows is answered "already". Then
 * updatesService.postConsultNotes, unchanged (its own guards catch a double click, a retry and an entry already
 * there among the newest 100 updates).
 *
 * Every answer: Cache-Control private, no-store. Logs: ids and counts only — never note text or names.
 */

const svcOf = (deps) => (deps && deps.service) || require('../services/caseNotesService');
const updates = require('../services/updatesService');
const caseAccess = require('../services/caseAccessService');
const { recordingCode } = require('../utils/recordingCode');
const { shownId } = require('../services/clientIdDisplay');

const MAX = updates.MAX_CONSULT_NOTES;
const REF_RE = /^[A-Za-z0-9\- ]{1,100}$/;
const LOGIN = (caseRef) => '/q/auth/monday?returnTo=' + encodeURIComponent('/admin/case/' + caseRef);
const OFF = { ok: false, off: true, error: 'Consultation notes on the case page are not switched on.' };

const lookupCase = (deps) => (deps && deps.lookupCase) || ((caseRef) => require('../services/htmlQuestionnaireService').validateAccessForStaff(caseRef, { skipFormVersioning: true }));

/**
 * Who is asking and may they see this case — the light read. Answers the refusal itself and returns null,
 * or { viewer, itemId, recordUrl } (recordUrl undefined when the row could not be read by an admin).
 */
async function access(req, res, caseRef, deps) {
  const viewer = deps.resolveViewer(req);
  if (!viewer) { res.status(401).json({ ok: false, error: 'Sign in to see the consultation notes.', loginUrl: LOGIN(caseRef) }); return null; }
  if (!REF_RE.test(caseRef)) { res.status(404).json({ ok: false, error: 'Case not found.' }); return null; }
  let found;
  try { found = await lookupCase(deps)(caseRef); }
  catch (err) {
    if (/not found/i.test(String(err && err.message))) { res.status(404).json({ ok: false, error: 'Case not found.' }); return null; }
    console.warn(`[CaseNotes] ${caseRef}: the case lookup failed`);
    res.status(503).json({ ok: false, error: 'temporarily-unavailable', message: 'Could not load notes — retry in a moment.' }); return null;
  }
  const itemId = String((found && found.itemId) || '');
  let row = null;
  try { row = await svcOf(deps).readCaseRow(itemId); }
  catch (err) { row = null; console.warn(`[CaseNotes] ${caseRef}: the case row could not be read`); }
  // /admin/case-data's rule: no row → no RBAC check against empty assignees; a non-admin hears 503
  if (!row && !viewer.isAdmin) { res.status(503).json({ ok: false, error: 'temporarily-unavailable', message: 'Case data is temporarily unavailable. Please reload in a moment.' }); return null; }
  if (!viewer.isAdmin && !caseAccess.viewerCanSee(row.assignees, viewer)) { res.status(403).json({ ok: false, error: 'not-assigned', message: 'You are not assigned to this case.' }); return null; }
  return { viewer, itemId, recordUrl: row ? row.recordUrl : undefined };
}

/** PURE: one consultation as the card shows it. */
function cardOf(l) {
  return {
    leadId: l.leadId, clientName: l.clientName, kind: l.kind,
    bookedSlot: l.bookedSlot, consultationHeld: l.consultationHeld, consultant: l.consultant,
    recordingCode: l.kind === 'direct-retainer' ? '' : recordingCode(l.leadId),
    // what to type as the Otter title: the Client ID when the client has one (Faran 2026-11-26), else the code above
    clientId: l.kind === 'direct-retainer' ? '' : shownId(l.clientId),
    recordUrl: '/admin/consultation/' + encodeURIComponent(l.leadId),
  };
}

async function get(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const svc = svcOf(deps);
  if (!svc.enabled()) return res.status(404).json(OFF);
  const caseRef = String((req.params && req.params.caseRef) || '').trim();
  const ctx = await access(req, res, caseRef, deps);
  if (!ctx) return;
  let set;
  try { set = await svc.caseLeadSet(ctx.itemId, caseRef, { recordUrl: ctx.recordUrl }); }
  catch (err) {
    console.warn(`[CaseNotes] ${caseRef}: the consultations of the case could not be read`);
    return res.status(503).json({ ok: false, error: 'Could not load notes — retry.' });
  }
  const actor = deps.staffActor(req);
  const signedIn = !!(actor && actor.verified);
  // partial: part of the check of which consultations belong to the case failed — a record naming a different
  // person may be the one that was not read, so Add note stays off until a full read (the 2026-OINP-059 rule)
  const partial = !!set.partial;
  const canAdd = signedIn && !set.multipleClaimants && !partial;
  let failed = 0, entries = 0;
  const consultations = await Promise.all(set.leads.map(async (l) => {
    const card = cardOf(l);
    try {
      const e = await svc.readLeadEntries(l.leadId);
      entries += e.notes.length + e.recordings.length;
      return { ...card, notes: e.notes, recordings: e.recordings, olderNotLoaded: !!e.olderNotLoaded, canAdd: canAdd && l.kind !== 'direct-retainer' };
    } catch (err) {
      failed++;
      return { ...card, error: 'Could not load notes — retry.', notes: [], recordings: [], canAdd: false };
    }
  }));
  console.log(`[CaseNotes] ${caseRef}: ${consultations.length} consultation(s), ${entries} entr${entries === 1 ? 'y' : 'ies'}${failed ? `, ${failed} could not be read` : ''}`);
  res.json({ ok: true, caseRef, signedIn, canAdd, signInUrl: LOGIN(caseRef), multipleClaimants: set.multipleClaimants, claimantCount: set.claimantCount, partial, max: MAX, consultations });
}

async function post(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const svc = svcOf(deps);
  if (!svc.enabled()) return res.status(404).json(OFF);
  const caseRef = String((req.params && req.params.caseRef) || '').trim();
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = String(b.leadId == null ? '' : b.leadId).trim();
  const text = String(typeof b.body === 'string' ? b.body : '').replace(/\r\n?/g, '\n').trim();
  if (!deps.resolveViewer(req)) return res.status(401).json({ ok: false, error: 'Sign in with Monday to add notes.', loginUrl: LOGIN(caseRef) });
  const actor = deps.staffActor(req);
  if (!actor || !actor.verified) return res.status(401).json({ ok: false, error: 'Sign in with Monday to add notes — the shared admin key does not say who you are. Nothing was saved.', loginUrl: LOGIN(caseRef) });
  if (!/^\d+$/.test(leadId)) return res.status(400).json({ ok: false, error: 'Nothing was saved: the consultation is missing. Reload the page.' });
  if (!text) return res.status(400).json({ ok: false, error: 'Type the note first.' });
  if (text.length > MAX) return res.status(400).json({ ok: false, error: `A note is limited to ${MAX.toLocaleString('en-CA')} characters — this is ${(text.length - MAX).toLocaleString('en-CA')} over. Nothing was saved.` });

  const ctx = await access(req, res, caseRef, deps);
  if (!ctx) return;
  let set;
  try { set = await svc.caseLeadSet(ctx.itemId, caseRef, { recordUrl: ctx.recordUrl }); }
  catch (err) {
    console.warn(`[CaseNotes] ${caseRef}: the consultations could not be checked before a save`);
    return res.status(503).json({ ok: false, error: 'Could not check which consultations belong to this case, so nothing was saved. Try again in a minute.' });
  }
  if (set.partial) {
    console.warn(`[CaseNotes] ${caseRef}: part of the consultations check failed — nothing saved`);
    return res.status(503).json({ ok: false, reason: 'partial', error: 'Could not check every consultation linked to this case, so nothing was saved. Try again in a minute.' });
  }
  if (set.multipleClaimants) {
    return res.status(409).json({ ok: false, reason: 'claimants', error: `This case is linked to ${set.claimantCount} client records, so notes cannot be added here. Nothing was saved. Fix the duplicate on the Consultations page first.` });
  }
  if (!set.leads.some((l) => l.leadId === leadId)) {
    return res.status(409).json({ ok: false, reason: 'not-on-case', error: 'That consultation is not linked to this case any more, so nothing was saved. Reload the page.' });
  }
  // The same note already on the lead, anywhere in the entries the panel shows (up to MAX_PAGES pages) —
  // postConsultNotes' own check reads only the newest 100 updates. Same rule as its check (updatesService.notesKey:
  // white space does not count). Could not read → postConsultNotes' own guards still run.
  const want = updates.notesKey(text);
  try {
    const e = await svc.readLeadEntries(leadId);
    const keys = Array.isArray(e && e.typedKeys) ? e.typedKeys
      : ((e && e.notes) || []).filter((n) => n.kind === 'typed').map((n) => updates.notesKey(n.body));
    if (keys.includes(want)) {
      console.log(`[CaseNotes] ${caseRef} lead ${leadId}: note already there (${text.length} characters)`);
      return res.json({ ok: true, already: true, updated: false });
    }
  } catch (err) { console.warn(`[CaseNotes] ${caseRef} lead ${leadId}: the earlier entries could not be read before a save`); }
  try {
    const r = await updates.postConsultNotes(leadId, { body: text, staffName: actor.name });
    console.log(`[CaseNotes] ${caseRef} lead ${leadId}: note ${r.already ? 'already there' : 'added'} (${text.length} characters)`);
    res.json({
      ok: true, already: !!r.already, updated: !!r.updated,
      entry: { kind: 'typed', by: updates.notesName(actor.name), updated: !!r.updated, body: text, at: new Date().toISOString() },
    });
  } catch (err) {
    if (err && err.badRequest) return res.status(400).json({ ok: false, error: err.message });
    console.error(`[CaseNotes] ${caseRef} lead ${leadId}: the save failed`);
    res.status(502).json({ ok: false, error: 'Monday did not take the note, so it may not be saved. Press Save note again — it never makes a second copy.' });
  }
}

module.exports = { get, post, access, cardOf, MAX };
