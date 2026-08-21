/**
 * Document Review Routes — /d/:caseRef
 *
 * Staff-facing pages and actions for reviewing documents on a case.
 * All routes are gated by requireStaffAuth (same pattern as /q/:caseRef/review).
 *
 * Routes
 * ──────
 *   GET  /d/:caseRef/review                       Renders the review page
 *   POST /d/:caseRef/review/:itemId/status        JSON: { action: 'reviewed' | 'rework', notes? }
 */

'use strict';

const express = require('express');
const router  = express.Router();

const docFormSvc       = require('../services/documentFormService');
const reviewFormSvc    = require('../services/documentReviewFormService');
const qReview          = require('../services/htmlQuestionnaireReviewService');
const caseAccess       = require('../services/caseAccessService');
const { requireStaffAuth } = require('../middleware/staffAuth');

// Per-case RBAC: a Monday-authenticated staffer may only open a case they're
// assigned to (mirrors /admin/case-data and /q/:caseRef/review). Admins (email
// allowlist) see all. Returns true when allowed; otherwise sends the response
// and returns false. `json` selects a JSON body vs an HTML error page.
async function enforceCaseAccess(req, res, caseRef, { json = false } = {}) {
  const viewer = caseAccess.viewerFromStaff(req.staff);
  if (viewer && viewer.isAdmin) return true;
  let assignees;
  try {
    assignees = await qReview.getCaseAssignees(caseRef);
  } catch (err) {
    console.error(`[/d] assignee read failed for ${caseRef}:`, err.message);
    const status = err.transient ? 503 : 500;
    if (json) res.status(status).json({ ok: false, error: 'Could not verify case access — please try again shortly.' });
    else res.status(status).type('html').send('<h2 style="font-family:sans-serif;color:#991b1b;text-align:center;padding:60px">Could not verify your access to this case — please try again shortly.</h2>');
    return false;
  }
  if (caseAccess.viewerCanSee(assignees, viewer)) return true;
  if (json) res.status(403).json({ ok: false, error: 'You are not assigned to this case.' });
  else res.status(403).type('html').send('<h2 style="font-family:sans-serif;color:#991b1b;text-align:center;padding:60px">You are not assigned to this case, so you cannot view it.</h2>');
  return false;
}

// ─── Light validation ────────────────────────────────────────────────────────

function sanitiseCaseRef(s) {
  return String(s || '').trim().slice(0, 100);
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitiseItemId(s) {
  return String(s || '').replace(/[^0-9]/g, '').slice(0, 20);
}

// ─── GET /d/:caseRef/review — the review page ────────────────────────────────

router.get('/:caseRef/review', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);

  try {
    if (!(await enforceCaseAccess(req, res, caseRef))) return;
    const summary = await docFormSvc.getCaseSummary(caseRef);
    const items   = summary?.items || [];

    if (!items.length) {
      return res.status(404).type('html').send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>No documents</title></head>
        <body style="font-family:Segoe UI,Arial,sans-serif;background:#f0f4f8;padding:60px;text-align:center;color:#475569;">
          <h2>No documents found</h2>
          <p>Case reference <strong>${escHtml(caseRef)}</strong> has no document checklist items on the Execution Board yet.</p>
        </body></html>
      `);
    }

    const itemIds     = items.map(it => it.id);
    // Distinguish a transient fetch failure from genuinely-absent links: on
    // failure, flag it so the page shows a 'links temporarily unavailable —
    // reload' banner rather than rendering every folder as "not linked yet".
    let folderLinks = {}, folderLinksUnavailable = false;
    try { folderLinks = await reviewFormSvc.getFolderLinks(itemIds); }
    catch (e) { folderLinksUnavailable = true; console.warn(`[/d/review] folder-link read failed for ${caseRef}: ${e.message}`); }

    const html = reviewFormSvc.buildReviewPage({
      caseRef,
      clientName: summary.clientName,
      staffName:  req.staff?.name || 'Staff',
      items,
      folderLinks,
      folderLinksUnavailable,
    });

    return res.type('html').send(html);
  } catch (err) {
    console.error(`[/d/review] Error for ${caseRef}:`, err.message);
    return res.status(500).type('html').send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head>
      <body style="font-family:Segoe UI,Arial,sans-serif;background:#f0f4f8;padding:60px;text-align:center;color:#991b1b;">
        <h2>Error loading review page</h2>
        <p>${escHtml(err.message)}</p>
      </body></html>
    `);
  }
});

// ─── GET /d/:caseRef/review/updates — Client replies (async enrichment) ─────

router.get('/:caseRef/review/updates', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);

  try {
    if (!(await enforceCaseAccess(req, res, caseRef, { json: true }))) return;
    const summary = await docFormSvc.getCaseSummary(caseRef);
    const items   = summary?.items || [];
    if (!items.length) return res.json({ ok: true, replies: {} });

    const itemIds = items.map(it => it.id);
    const replies = await reviewFormSvc.getClientReplies(itemIds);
    return res.json({ ok: true, replies });
  } catch (err) {
    console.error(`[/d/review/updates] Error for ${caseRef}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /d/:caseRef/review/:itemId/status — Mark Reviewed / Request Rework ─

router.post('/:caseRef/review/:itemId/status', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const itemId  = sanitiseItemId(req.params.itemId);
  const { action, notes } = req.body || {};

  if (!itemId) return res.status(400).json({ ok: false, error: 'Invalid item id' });
  if (action !== 'reviewed' && action !== 'rework' && action !== 'received') {
    return res.status(400).json({ ok: false, error: 'action must be "reviewed", "rework", or "received"' });
  }
  if (action === 'rework' && !(notes && notes.trim())) {
    return res.status(400).json({ ok: false, error: 'notes are required for rework' });
  }

  try {
    if (!(await enforceCaseAccess(req, res, caseRef, { json: true }))) return;
    if (action === 'reviewed') {
      await reviewFormSvc.markReviewed(itemId);
    } else if (action === 'rework') {
      await reviewFormSvc.requestRework(itemId, notes);
    } else {
      await reviewFormSvc.reopenDoc(itemId); // 'received' — undo / reopen to pending
    }

    console.log(`[/d/review] ${req.staff?.name || 'Staff'} → item ${itemId} (${caseRef}): ${action}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/d/review] Action ${action} failed for item ${itemId}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
