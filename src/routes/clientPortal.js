/**
 * Client Portal Routes — /client/:caseRef
 *
 * Token-validated client-facing landing page that aggregates the
 * questionnaire and document upload progress in one view.
 *
 * Routes
 * ──────
 *   GET /client/:caseRef        Renders the portal (token via ?t=)
 *
 * Token validation reuses htmlQuestionnaireService.validateAccess so a stale
 * token returns the same error UX as the questionnaire.
 */

'use strict';

const express   = require('express');
const router    = express.Router();
const htmlQ     = require('../services/htmlQuestionnaireService');
const portalSvc = require('../services/clientPortalService');
const { tryStaffAuth } = require('../middleware/staffAuth');

function sanitiseCaseRef(s) {
  return String(s || '').trim().slice(0, 100);
}

/**
 * GET /client/:caseRef
 *
 * Role-aware:
 *   • If a valid staff session cookie is present (TDOT team opening from
 *     Monday) → render the staff review portal with links to /q/:ref/review
 *     and /d/:ref/review.
 *   • Otherwise → fall back to the access-token-validated client view.
 *
 * Staff view does NOT require ?t=, but staff still need a valid case lookup;
 * the case is resolved by caseRef alone (token bypassed for the staff path).
 */
router.get('/:caseRef', async (req, res) => {
  const caseRef    = sanitiseCaseRef(req.params.caseRef);
  const token      = (req.query.t || '').trim();
  const wantsStaff = req.query.staff === '1';
  const staff      = tryStaffAuth(req);

  // If the URL declares staff intent (?staff=1, used by the Monday Client
  // Portal link column) but the user has no valid staff cookie, route them
  // through the Monday OAuth flow first. After OAuth, the callback redirects
  // back to this URL with the cookie in place, and tryStaffAuth will succeed.
  // Email links never include ?staff=1, so clients without Monday accounts
  // are unaffected.
  if (wantsStaff && !staff) {
    const returnTo = encodeURIComponent(req.originalUrl || `/client/${caseRef}`);
    return res.redirect(`/q/auth/monday?returnTo=${returnTo}`);
  }

  try {
    let validatedCase;
    if (staff) {
      // Staff path — look up the case without token validation
      validatedCase = await htmlQ.validateAccessForStaff(caseRef);
    } else {
      // Client path — token must match
      validatedCase = await htmlQ.validateAccess(caseRef, token);
    }

    const snapshot = await portalSvc.getPortalSnapshot({ caseRef, validatedCase });
    const html     = portalSvc.buildPortalPage(snapshot, staff
      ? { mode: 'staff', staffName: staff.name }
      : { mode: 'client' });
    return res.type('html').send(html);
  } catch (err) {
    console.error(`[/client] Error for ${caseRef}:`, err.message);
    const status = /token/i.test(err.message) ? 403 : 500;
    return res.status(status).type('html').send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Client Portal</title></head>
      <body style="font-family:Segoe UI,Arial,sans-serif;background:#FAF8F4;padding:60px;text-align:center;color:#6B7280;">
        <h2 style="color:#8B0000;">${status === 403 ? '🔒 Access denied' : '⚠️ Could not load this case'}</h2>
        <p>${status === 403
          ? 'The link you followed is invalid or expired. Please use the most recent link from your case officer.'
          : 'Please try again in a moment.'
        }</p>
      </body></html>`);
  }
});

module.exports = router;
