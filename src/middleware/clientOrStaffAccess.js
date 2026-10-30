'use strict';

/**
 * Who may open a client's case page that lives outside the portal — the
 * documents page (/documents/<case>) and the old questionnaire page
 * (/questionnaire/<case>). Faran 2026-10-31.
 *
 * Until then these pages opened with the case number alone — guessable, and
 * they showed the client's name, answers and document list. Now:
 *  - a Monday staff sign-in (the staff cookie), with the review pages' rule:
 *    every signed-in staffer by default; with CASE_VISIBILITY=assigned only
 *    the case's assignees (and admins); or
 *  - the case's own access code — the ?t= in the links we email, the same
 *    check the portal (/client) and the questionnaire (/q) make.
 * The shared team key does not count: a page visit cannot carry it.
 *
 * Module objects are called through (staffAuth.tryStaffAuth, htmlQ.…,
 * mondayApi.query) so tests can stub them.
 */

const mondayApi = require('../services/mondayApi');
const staffAuth = require('./staffAuth');
const htmlQ     = require('../services/htmlQuestionnaireService');

const oneStr = (v) => (Array.isArray(v) ? v[0] : v) == null ? '' : String(Array.isArray(v) ? v[0] : v);
const safeDecode = (s) => { try { return decodeURIComponent(String(s || '')); } catch (_) { return String(s || ''); } };
const validCaseRef = (caseRef) => !!caseRef && caseRef.length <= 50 && /^[A-Za-z0-9\- ]+$/.test(caseRef);
// validateAccess's own refusals — anything else is a backend problem, never shown as a bad link.
const ACCESS_ERRORS = new Set(['Missing case reference or access token.', 'Case not found.', 'Invalid or expired access token.']);

const tokenOf = (req) => oneStr(req.query && req.query.t) || oneStr(req.body && req.body.t);

/**
 * @returns {Promise<{ok:true, staff:boolean, token:string} | {ok:false, status:number, reason:'token'|'backend'|'assigned'|'notfound'}>}
 */
async function authorise(req, caseRef, { logTag = '[CaseAccess]' } = {}) {
  const staff = staffAuth.tryStaffAuth(req);
  if (staff) {
    const caseAccess = require('../services/caseAccessService');
    const viewer = caseAccess.viewerFromStaff(staff);
    if (viewer.isAdmin || caseAccess.caseVisibilityPolicy() === 'all') return { ok: true, staff: true, token: '' };
    try {
      const { itemId } = await htmlQ.validateAccessForStaff(caseRef, { skipFormVersioning: true });
      const ids = caseAccess.PEOPLE_COLUMNS.map((c) => `"${c}"`).join(', ');
      const data = await mondayApi.query(`query($itemId: ID!) { items(ids: [$itemId]) { column_values(ids: [${ids}]) { id value } } }`, { itemId: String(itemId) });
      const valueByColId = {};
      for (const c of (data && data.items && data.items[0] && data.items[0].column_values) || []) valueByColId[c.id] = c.value;
      if (!caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues(valueByColId), viewer)) return { ok: false, status: 403, reason: 'assigned' };
      return { ok: true, staff: true, token: '' };
    } catch (err) {
      if (String(err.message || '').trim() === 'Case not found.') return { ok: false, status: 404, reason: 'notfound' };
      console.error(`${logTag} staff access check failed for ${caseRef}:`, err.message);
      return { ok: false, status: 503, reason: 'backend' };
    }
  }
  const token = tokenOf(req);
  try {
    // Auth-only: never let a questionnaire-era storage read fail the page.
    await htmlQ.validateAccess(caseRef, token, { skipFormVersioning: true });
    return { ok: true, staff: false, token };
  } catch (err) {
    if (ACCESS_ERRORS.has(String(err.message || '').trim())) return { ok: false, status: 403, reason: 'token' };
    console.error(`${logTag} access check backend error for ${caseRef}:`, err.message);
    return { ok: false, status: 503, reason: 'backend' };
  }
}

/**
 * The same check as a gate for a page's POSTs (JSON answers). Put it BEFORE
 * any body or upload parsing, so a stranger never costs the server anything.
 */
function requireClientOrStaff({ logTag } = {}) {
  return async function requireClientOrStaffGate(req, res, next) {
    const caseRef = safeDecode(req.params.caseRef).trim();
    if (!validCaseRef(caseRef)) return res.status(400).json({ success: false, error: 'Invalid case reference format.' });
    const a = await authorise(req, caseRef, { logTag });
    if (a.ok) return next();
    if (a.reason === 'backend')  return res.status(503).json({ success: false, error: 'We could not verify your link just now — please try again in a moment.' });
    if (a.reason === 'assigned') return res.status(403).json({ success: false, error: 'You are not assigned to this case.' });
    if (a.reason === 'notfound') return res.status(404).json({ success: false, error: 'No case with this number.' });
    if (!tokenOf(req))           return res.status(401).json({ success: false, error: 'Your Monday sign-in has expired — reload this page and sign in again.' });
    return res.status(403).json({ success: false, error: 'Access denied — please use the most recent link from your case officer.' });
  };
}

module.exports = { authorise, requireClientOrStaff, oneStr, safeDecode, validCaseRef, ACCESS_ERRORS };
