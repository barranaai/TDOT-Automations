/**
 * HTML Questionnaire Routes  —  /q
 *
 * GET  /q/:caseRef              Serve the form (or overview/placeholder)
 * GET  /q/:caseRef/data         Return saved field data as JSON (for pre-fill)
 * POST /q/:caseRef/save         Save form data to OneDrive
 * POST /q/:caseRef/submit       Submit form data and update Monday.com
 */

'use strict';

const express = require('express');
const router  = express.Router();
const svc     = require('../services/htmlQuestionnaireService');
const { FORMS_DIR } = require('../../config/questionnaireFormMap');

// ─── Helper: sanitise caseRef from URL param ──────────────────────────────────

function sanitiseCaseRef(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 40);
}

// ─── GET /q/:caseRef  — Serve the questionnaire ───────────────────────────────

router.get('/:caseRef', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const token   = (req.query.t || '').trim();
  const fParam  = (req.query.f || '').trim();  // '1' | '2' | ''

  try {
    const { clientName, caseType, caseSubType, formFiles } = await svc.validateAccess(caseRef, token);

    /* No form available for this case type → placeholder page (Option B) */
    if (!formFiles) {
      return res.type('html').send(svc.buildPlaceholderPage(caseRef));
    }

    const hasTwo     = Boolean(formFiles.additional);
    const overviewUrl = hasTwo
      ? `/q/${encodeURIComponent(caseRef)}?t=${encodeURIComponent(token)}`
      : '';

    /* ── Two-form case ── */
    if (hasTwo) {
      if (!fParam) {
        /* No form selected → show the overview / launcher page */
        const primaryTitle    = formFiles.primary.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();
        const additionalTitle = formFiles.additional.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();
        return res.type('html').send(
          svc.buildOverviewPage({ caseRef, token, primaryTitle, additionalTitle })
        );
      }

      const isAdditional = (fParam === '2');
      const formFile     = isAdditional ? formFiles.additional : formFiles.primary;
      const formKey      = isAdditional ? 'additional' : 'primary';
      const formTitle    = formFile.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();

      const html = svc.buildFormPage({
        formFile, caseRef, token, formKey, formTitle,
        hasAdditionalForm: true,
        overviewUrl,
      });
      return res.type('html').send(html);
    }

    /* ── Single-form case ── */
    const formTitle = formFiles.primary.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();
    const html = svc.buildFormPage({
      formFile:          formFiles.primary,
      caseRef, token,
      formKey:           'primary',
      formTitle,
      hasAdditionalForm: false,
      overviewUrl:       '',
    });
    return res.type('html').send(html);

  } catch (err) {
    console.error(`[/q] Access error for ${caseRef}:`, err.message);
    return res.status(403).type('html').send(svc.buildErrorPage(err.message));
  }
});

// ─── GET /q/:caseRef/data  — Return saved field data for pre-fill ─────────────

router.get('/:caseRef/data', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const token   = (req.query.t       || '').trim();
  const formKey = (req.query.formKey || 'primary').trim();

  try {
    const { clientName } = await svc.validateAccess(caseRef, token);
    const fields = await svc.loadFormData({ clientName, caseRef, formKey });
    return res.json({ fields });
  } catch (err) {
    console.error(`[/q] Data load error for ${caseRef}:`, err.message);
    return res.status(403).json({ error: err.message });
  }
});

// ─── POST /q/:caseRef/save  — Save questionnaire data ────────────────────────

router.post('/:caseRef/save', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const { token, formKey, fields, completionPct } = req.body || {};

  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields must be an array' });
  }

  try {
    const { itemId, clientName } = await svc.validateAccess(caseRef, token);
    await svc.saveFormData({ clientName, caseRef, itemId, formKey: formKey || 'primary', fields, completionPct: completionPct || 0 });
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/q] Save error for ${caseRef}:`, err.message);
    return res.status(err.message.includes('token') ? 403 : 500).json({ error: err.message });
  }
});

// ─── POST /q/:caseRef/submit  — Submit and update Monday.com ─────────────────

router.post('/:caseRef/submit', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const { token, formKey, fields, completionPct } = req.body || {};

  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields must be an array' });
  }

  try {
    const { itemId, clientName, formFiles } = await svc.validateAccess(caseRef, token);

    const key       = formKey || 'primary';
    const formTitle = key === 'additional' && formFiles?.additional
      ? formFiles.additional.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim()
      : (formFiles?.primary || '').replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();

    /* Save the final data snapshot */
    await svc.saveFormData({ clientName, caseRef, itemId, formKey: key, fields, completionPct: completionPct || 0 });

    /* Update Monday and post audit comment */
    await svc.markSubmitted({ itemId, caseRef, formKey: key, formLabel: formTitle, completionPct: completionPct || 0 });

    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/q] Submit error for ${caseRef}:`, err.message);
    return res.status(err.message.includes('token') ? 403 : 500).json({ error: err.message });
  }
});

module.exports = router;
