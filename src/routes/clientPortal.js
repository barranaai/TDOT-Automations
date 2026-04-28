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

function sanitiseCaseRef(s) {
  return String(s || '').trim().slice(0, 100);
}

router.get('/:caseRef', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const token   = (req.query.t || '').trim();

  try {
    const validated = await htmlQ.validateAccess(caseRef, token);
    const snapshot  = await portalSvc.getPortalSnapshot({ caseRef, validatedCase: validated });
    const html      = portalSvc.buildPortalPage(snapshot);
    return res.type('html').send(html);
  } catch (err) {
    console.error(`[/client] Error for ${caseRef}:`, err.message);
    const status = /token/i.test(err.message) ? 403 : 500;
    return res.status(status).type('html').send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Client Portal</title></head>
      <body style="font-family:Segoe UI,Arial,sans-serif;background:#f0f4f8;padding:60px;text-align:center;color:#475569;">
        <h2>${status === 403 ? '🔒 Access denied' : '⚠️ Could not load your portal'}</h2>
        <p>${status === 403
          ? 'The link you followed is invalid or expired. Please use the most recent link from your case officer.'
          : 'Please try again in a moment, or contact your case officer.'
        }</p>
      </body></html>`);
  }
});

module.exports = router;
