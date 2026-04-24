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
const { requireStaffAuth } = require('../middleware/staffAuth');

// ─── Light validation ────────────────────────────────────────────────────────

function sanitiseCaseRef(s) {
  return String(s || '').trim().slice(0, 100);
}

function sanitiseItemId(s) {
  return String(s || '').replace(/[^0-9]/g, '').slice(0, 20);
}

// ─── GET /d/:caseRef/review — the review page ────────────────────────────────

router.get('/:caseRef/review', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);

  try {
    const summary = await docFormSvc.getCaseSummary(caseRef);
    const items   = summary?.items || [];

    if (!items.length) {
      return res.status(404).type('html').send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>No documents</title></head>
        <body style="font-family:Segoe UI,Arial,sans-serif;background:#f0f4f8;padding:60px;text-align:center;color:#475569;">
          <h2>No documents found</h2>
          <p>Case reference <strong>${caseRef}</strong> has no document checklist items on the Execution Board yet.</p>
        </body></html>
      `);
    }

    const itemIds     = items.map(it => it.id);
    const folderLinks = await reviewFormSvc.getFolderLinks(itemIds).catch(() => ({}));

    const html = reviewFormSvc.buildReviewPage({
      caseRef,
      clientName: summary.clientName,
      staffName:  req.staff?.name || 'Staff',
      items,
      folderLinks,
    });

    return res.type('html').send(html);
  } catch (err) {
    console.error(`[/d/review] Error for ${caseRef}:`, err.message);
    return res.status(500).type('html').send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head>
      <body style="font-family:Segoe UI,Arial,sans-serif;background:#f0f4f8;padding:60px;text-align:center;color:#991b1b;">
        <h2>Error loading review page</h2>
        <p>${err.message}</p>
      </body></html>
    `);
  }
});

// ─── GET /d/:caseRef/review/updates — Client replies (async enrichment) ─────

router.get('/:caseRef/review/updates', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);

  try {
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
  if (action !== 'reviewed' && action !== 'rework') {
    return res.status(400).json({ ok: false, error: 'action must be "reviewed" or "rework"' });
  }
  if (action === 'rework' && !(notes && notes.trim())) {
    return res.status(400).json({ ok: false, error: 'notes are required for rework' });
  }

  try {
    if (action === 'reviewed') {
      await reviewFormSvc.markReviewed(itemId);
    } else {
      await reviewFormSvc.requestRework(itemId, notes);
    }

    console.log(`[/d/review] ${req.staff?.name || 'Staff'} → item ${itemId} (${caseRef}): ${action}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/d/review] Action ${action} failed for item ${itemId}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
