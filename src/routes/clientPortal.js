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

const path      = require('path');
const express   = require('express');
const multer    = require('multer');
const router    = express.Router();
const htmlQ     = require('../services/htmlQuestionnaireService');
const portalSvc = require('../services/clientPortalService');
const { tryStaffAuth } = require('../middleware/staffAuth');

function sanitiseCaseRef(s) {
  return String(s || '').trim().slice(0, 100);
}

// Upload constraints — identical to the standalone /documents page, so both
// entry points accept exactly the same files.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx',
  '.jpg', '.jpeg', '.png', '.heic', '.webp',
  '.xlsx', '.xls', '.csv',
  '.zip',
]);

/** Query/body values can arrive as arrays (?t=a&t=b) — never .trim() blind. */
function oneStr(v) {
  return String(Array.isArray(v) ? v[0] : (v == null ? '' : v)).trim();
}

// Per-IP rate limit (same sliding-window pattern as POST /lead/new, JSON
// flavour). Multer buffers the whole body into memory BEFORE any in-handler
// auth can run, so this limiter is the practical guard against
// unauthenticated 20MB spray.
const _uploadHits = new Map();
function uploadRateLimit(req, res, next) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const hits = (_uploadHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (hits.length >= 60) { // generous: a real client uploading a whole checklist stays well under
    return res.status(429).json({ success: false, error: 'Too many uploads from this connection — please wait a few minutes and try again.' });
  }
  hits.push(now);
  _uploadHits.set(ip, hits);
  if (_uploadHits.size > 5000) _uploadHits.clear(); // bound memory
  next();
}

// Multer errors (file too big etc.) must come back as the JSON the portal's
// upload script expects — not fall through to the global 500 handler.
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    console.warn('[/client upload] multer error:', err.code || err.message);
    res.status(tooBig ? 413 : 400).json({
      success: false,
      error: tooBig ? 'That file is over 20 MB — please compress it or send a smaller scan.' : 'There was a problem with that upload — please try again.',
    });
  });
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
  const token      = oneStr(req.query.t);
  const wantsStaff = oneStr(req.query.staff) === '1';
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

/**
 * POST /client/:caseRef/document/:itemId/upload?t=<token>
 *
 * Token-gated document upload from the portal's Documents card. Reuses the
 * exact upload machinery of the standalone /documents page (OneDrive write +
 * mark Received + housekeeping), with two protections that page lacks:
 *   1. the caller must hold the case's access token (or a staff cookie);
 *   2. the target item must BELONG to this case — a valid token for your own
 *      case can never push files onto another case's checklist row.
 */
router.post('/:caseRef/document/:itemId/upload', uploadRateLimit, uploadSingle, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const itemId  = oneStr(req.params.itemId);
  const token   = oneStr(req.query.t) || oneStr(req.body && req.body.t);
  const file    = req.file;

  if (!/^\d+$/.test(itemId)) return res.status(400).json({ success: false, error: 'Invalid item id.' });
  if (!file)                 return res.status(400).json({ success: false, error: 'No file provided.' });

  try {
    // Auth FIRST: staff cookie OR the case's client token — same rule as the
    // page. Nothing (not even the extension check) is answered pre-auth.
    if (!tryStaffAuth(req)) await htmlQ.validateAccess(caseRef, token);
  } catch (err) {
    return res.status(403).json({ success: false, error: 'Access denied — please use the most recent link from your case officer.' });
  }

  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({ success: false, error: `File type "${ext}" is not allowed.` });
  }

  try {
    const docSvc = require('../services/documentFormService');
    // Ownership check against the UNFILTERED checklist: cross-case isolation
    // only needs "this item belongs to this case". getCaseSummary's
    // applicant-type manifest filter is display-only and fails CLOSED on a
    // transient OneDrive read — using it here would 404 a spouse's legitimate
    // document whenever the manifest read degrades.
    const items = await docSvc.getCaseDocuments(caseRef);
    const item = (items || []).find((it) => String(it.id) === itemId);
    if (!item) return res.status(404).json({ success: false, error: 'That document is not on this case.' });

    await docSvc.uploadFileToOneDrive(itemId, caseRef, file.buffer, file.originalname, file.mimetype);
    await docSvc.markDocumentReceived(itemId);
    res.json({ success: true });

    // Non-blocking post-upload housekeeping (same as /documents).
    require('../services/clientMasterService').updateLastActivityDate(caseRef).catch((e) =>
      console.error('[/client upload] updateLastActivityDate failed:', e.message));
    require('../services/caseReadinessService').calculateForCaseRef(caseRef).catch((e) =>
      console.error('[/client upload] calculateForCaseRef failed:', e.message));
  } catch (err) {
    console.error(`[/client upload] failed for item ${itemId} (${caseRef}):`, err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Upload failed. Please try again.' });
  }
});

module.exports = router;
