/**
 * HTML Questionnaire Routes  —  /q
 *
 * ── Client routes ──────────────────────────────────────────────────────────
 * GET  /q/:caseRef              Serve the form (or overview / placeholder)
 * GET  /q/:caseRef/data         Return saved field data as JSON (for pre-fill)
 * POST /q/:caseRef/save         Save form data to OneDrive
 * POST /q/:caseRef/submit       Submit form data and update Monday.com
 * GET  /q/:caseRef/flags        Return active correction flags (for inline display)
 * GET  /q/:caseRef/members      Return member manifest for the case
 * POST /q/:caseRef/add-member   Add a new member (spouse/child/parent/sibling)
 * POST /q/:caseRef/remove-member Remove an unsubmitted member
 *
 * ── Staff OAuth routes (MUST be registered before /:caseRef) ──────────────
 * GET  /q/auth/monday           Start Monday OAuth flow
 * GET  /q/auth/monday/callback  Handle Monday OAuth callback
 *
 * ── Staff review routes (behind requireStaffAuth) ─────────────────────────
 * GET  /q/:caseRef/review       Staff review page
 * GET  /q/:caseRef/export-pdf   Export questionnaire as printable PDF report
 * POST /q/:caseRef/flag         Save/update correction flags
 * POST /q/:caseRef/notify       Send correction email to client
 */

'use strict';

const express  = require('express');
const axios    = require('axios');
const router   = express.Router();

const svc    = require('../services/htmlQuestionnaireService');
const review = require('../services/htmlQuestionnaireReviewService');
const { requireStaffAuth, createStaffToken, setStaffCookie } = require('../middleware/staffAuth');
const { FORMS_DIR, resolveMemberTypes } = require('../../config/questionnaireFormMap');

// ─── Monday OAuth config ──────────────────────────────────────────────────────

const MONDAY_CLIENT_ID     = process.env.MONDAY_OAUTH_CLIENT_ID     || '';
const MONDAY_CLIENT_SECRET = process.env.MONDAY_OAUTH_CLIENT_SECRET || '';
const STAFF_EMAIL_DOMAIN   = process.env.STAFF_EMAIL_DOMAIN         || 'tdotimm.com';
const BASE_URL             = process.env.RENDER_URL                  || 'https://tdot-automations.onrender.com';
const REDIRECT_URI         = `${BASE_URL}/q/auth/monday/callback`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitiseCaseRef(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 40);
}

function buildOAuthNotConfiguredPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Setup Required</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#f0f4f8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{background:#fff;border-radius:14px;padding:40px;max-width:540px;box-shadow:0 2px 20px rgba(0,0,0,.09)}
h1{color:#1e3a5f;font-size:20px;margin-bottom:14px}code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}
p{color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:10px}</style></head>
<body><div class="box">
<h1>🔧 Monday OAuth Not Configured</h1>
<p>The staff login requires a Monday OAuth app. Please set the following environment variables on Render:</p>
<ul style="color:#374151;font-size:14px;line-height:2;padding-left:20px">
  <li><code>MONDAY_OAUTH_CLIENT_ID</code></li>
  <li><code>MONDAY_OAUTH_CLIENT_SECRET</code></li>
  <li><code>STAFF_SESSION_SECRET</code></li>
  <li><code>STAFF_EMAIL_DOMAIN</code> (default: tdotimm.com)</li>
</ul>
<p>See the setup instructions in the project README for how to create the Monday app and retrieve these values.</p>
</div></body></html>`;
}

// ─── Staff OAuth — /q/auth/monday  (MUST be before /:caseRef) ───────────────

router.get('/auth/monday', (req, res) => {
  if (!MONDAY_CLIENT_ID || !MONDAY_CLIENT_SECRET) {
    return res.status(503).type('html').send(buildOAuthNotConfiguredPage());
  }

  // State = base64(timestamp + returnTo) — simple CSRF protection
  const returnTo  = (req.query.returnTo || '/').slice(0, 200);
  const state     = Buffer.from(JSON.stringify({ ts: Date.now(), returnTo })).toString('base64url');

  // Store state in a short-lived cookie for verification on callback
  res.cookie('tdot_oauth_state', state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   5 * 60 * 1000, // 5 minutes
  });

  const url = new URL('https://auth.monday.com/oauth2/authorize');
  url.searchParams.set('client_id',     MONDAY_CLIENT_ID);
  url.searchParams.set('redirect_uri',  REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state',         state);

  return res.redirect(url.toString());
});

// ─── Staff OAuth callback — /q/auth/monday/callback ──────────────────────────

router.get('/auth/monday/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[StaffAuth] OAuth error from Monday:', error);
    return res.status(403).type('html').send(
      svc.buildErrorPage('Monday login was cancelled or denied. Please try again.')
    );
  }

  // Verify state cookie to prevent CSRF
  const savedState = req.cookies?.tdot_oauth_state;
  if (!savedState || savedState !== state) {
    return res.status(403).type('html').send(
      svc.buildErrorPage('Invalid login state — please try again.')
    );
  }

  let returnTo = '/';
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
    returnTo = parsed.returnTo || '/';
  } catch (_) {}

  res.clearCookie('tdot_oauth_state');

  // Exchange code for access token
  let accessToken;
  try {
    const tokenRes = await axios.post(
      'https://auth.monday.com/oauth2/token',
      new URLSearchParams({
        client_id:     MONDAY_CLIENT_ID,
        client_secret: MONDAY_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        code:          String(code),
        grant_type:    'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    accessToken = tokenRes.data.access_token;
  } catch (err) {
    console.error('[StaffAuth] Token exchange failed:', err.response?.data || err.message);
    return res.status(500).type('html').send(
      svc.buildErrorPage('Login failed — could not exchange code for token. Please try again.')
    );
  }

  // Fetch the authenticated Monday user's identity
  let me;
  try {
    const meRes = await axios.post(
      'https://api.monday.com/v2',
      { query: '{ me { id name email } }' },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    me = meRes.data?.data?.me;
  } catch (err) {
    console.error('[StaffAuth] Monday user lookup failed:', err.response?.data || err.message);
    return res.status(500).type('html').send(
      svc.buildErrorPage('Login failed — could not verify your Monday identity.')
    );
  }

  if (!me || !me.email) {
    return res.status(403).type('html').send(
      svc.buildErrorPage('Could not retrieve your Monday account details.')
    );
  }

  // Verify the user is from an allowed organisation.
  // STAFF_EMAIL_DOMAIN may be a comma-separated list, e.g. "tdotimm.com,gmail.com"
  if (STAFF_EMAIL_DOMAIN) {
    const allowedDomains = STAFF_EMAIL_DOMAIN.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const emailLower     = me.email.toLowerCase();
    const allowed        = allowedDomains.some(d => emailLower.endsWith('@' + d));
    if (!allowed) {
      console.warn(`[StaffAuth] Access denied — email ${me.email} not in [${allowedDomains.join(', ')}]`);
      return res.status(403).type('html').send(
        svc.buildErrorPage(`Access is restricted to: ${allowedDomains.join(', ')} accounts.`)
      );
    }
  }

  // Issue the staff session cookie
  const sessionToken = createStaffToken({ id: me.id, name: me.name, email: me.email });
  setStaffCookie(res, sessionToken);

  console.log(`[StaffAuth] Staff login — ${me.name} (${me.email})`);
  return res.redirect(decodeURIComponent(returnTo));
});

// ─── Staff review page — GET /q/:caseRef/review ──────────────────────────────

router.get('/:caseRef/review', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const formKey = (req.query.formKey || 'primary').trim();

  try {
    const caseDetails = await review.getCaseDetails(caseRef);
    if (!caseDetails) {
      return res.status(404).type('html').send(svc.buildErrorPage('Case not found.'));
    }

    const { clientName, caseType, caseSubType } = caseDetails;

    // Resolve form files and check for multi-member case
    const { resolveForm } = require('../../config/questionnaireFormMap');
    const formFiles   = resolveForm(caseType, caseSubType) || {};
    const memberTypes = resolveMemberTypes(caseType, caseSubType);
    const hasTwo      = Boolean(formFiles?.additional);
    const isMultiMember = memberTypes.length > 0 && !hasTwo;

    // ── Multi-member review: show all members in one page ──────────────────
    if (isMultiMember && (formKey === 'primary' || !req.query.formKey)) {
      const members = await svc.loadMembers({ clientName, caseRef });
      const allMembersData = [];
      for (const member of members) {
        const [mFields, mFlags] = await Promise.all([
          svc.loadFormData({ clientName, caseRef, formKey: member.key }),
          review.loadFlags({ clientName, caseRef, formKey: member.key }),
        ]);
        allMembersData.push({ ...member, fields: mFields, flags: mFlags });
      }

      const anyData = allMembersData.some(m =>
        m.fields.length > 0 && m.fields.some(f => f.value && f.value.trim())
      );
      if (!anyData) {
        return res.type('html').send(svc.buildErrorPage(
          'No submitted data found for this case. The client may not have completed the questionnaire yet.'
        ));
      }

      const formFile = formFiles.primary;
      if (!formFile) {
        return res.status(404).type('html').send(svc.buildErrorPage('Form file not found for this case type.'));
      }

      return res.type('html').send(svc.buildReviewFormPage({
        formFile,
        caseRef,
        formKey: 'primary',
        staffName:    req.staff.name,
        savedFields:  allMembersData[0].fields,
        savedFlags:   allMembersData[0].flags,
        members:      allMembersData,
      }));
    }

    // ── Single-member review (original logic) ──────────────────────────────
    const [fields, flags] = await Promise.all([
      svc.loadFormData({ clientName, caseRef, formKey }),
      review.loadFlags({ clientName, caseRef, formKey }),
    ]);

    const hasData = fields.some(f => f.value && f.value.trim() !== '');

    if (!fields.length || !hasData) {
      return res.type('html').send(svc.buildErrorPage(
        fields.length
          ? 'The client has opened the questionnaire but has not yet filled in any answers. Please ask them to complete and submit the form before reviewing.'
          : 'No submitted data found for this case. The client may not have opened the questionnaire yet.'
      ));
    }

    const formFile = (formKey === 'additional' || formKey.endsWith('-additional'))
      ? formFiles.additional
      : formFiles.primary;

    if (!formFile) {
      return res.status(404).type('html').send(svc.buildErrorPage('Form file not found for this case type.'));
    }

    const html = svc.buildReviewFormPage({
      formFile,
      caseRef,
      formKey,
      staffName:   req.staff.name,
      savedFields: fields,
      savedFlags:  flags,
    });

    return res.type('html').send(html);
  } catch (err) {
    console.error(`[/q/review] Error for ${caseRef}:`, err.message);
    return res.status(500).type('html').send(svc.buildErrorPage('An error occurred loading the review page.'));
  }
});

// ─── PDF export — GET /q/:caseRef/export-pdf ─────────────────────────────────
//
// Opens a clean, print-ready HTML report in a new tab with the browser's
// print / Save-as-PDF dialog triggered automatically.  No extra libraries.

router.get('/:caseRef/export-pdf', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const formKey = (req.query.formKey || 'primary').trim();

  try {
    const caseDetails = await review.getCaseDetails(caseRef);
    if (!caseDetails) {
      return res.status(404).type('html').send(svc.buildErrorPage('Case not found.'));
    }

    const { clientName, caseType, caseSubType } = caseDetails;

    const [fields, flags] = await Promise.all([
      svc.loadFormData({ clientName, caseRef, formKey }),
      review.loadFlags({ clientName, caseRef, formKey }),
    ]);

    if (!fields.length) {
      return res.type('html').send(svc.buildErrorPage(
        'No submitted data found for this case. The client may not have completed the questionnaire yet.'
      ));
    }

    const html = svc.buildPrintPage({
      caseRef,
      clientName,
      caseType,
      caseSubType,
      savedFields: fields,
      savedFlags:  flags,
      staffName:   req.staff.name,
    });

    return res.type('html').send(html);
  } catch (err) {
    console.error(`[/q/export-pdf] Error for ${caseRef}:`, err.message);
    return res.status(500).type('html').send(svc.buildErrorPage('An error occurred generating the PDF export.'));
  }
});

// ─── Save flags — POST /q/:caseRef/flag ──────────────────────────────────────

router.post('/:caseRef/flag', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const { formKey, flags } = req.body || {};

  if (!flags || typeof flags !== 'object') {
    return res.status(400).json({ error: 'flags must be an object' });
  }

  try {
    const caseDetails = await review.getCaseDetails(caseRef);
    if (!caseDetails) return res.status(404).json({ error: 'Case not found' });

    const { clientName } = caseDetails;

    // Attach flaggedBy info from the session
    const enrichedFlags = {};
    for (const [key, flag] of Object.entries(flags)) {
      enrichedFlags[key] = {
        ...flag,
        flaggedBy:      req.staff.name,
        flaggedByEmail: req.staff.email,
        flaggedAt:      new Date().toISOString(),
      };
    }

    await review.saveFlags({ clientName, caseRef, formKey: formKey || 'primary', flags: enrichedFlags });
    return res.json({ ok: true, count: Object.keys(enrichedFlags).length });
  } catch (err) {
    console.error(`[/q/flag] Error for ${caseRef}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Send correction notification — POST /q/:caseRef/notify ──────────────────

router.post('/:caseRef/notify', requireStaffAuth, async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const { formKey } = req.body || {};

  try {
    const caseDetails = await review.getCaseDetails(caseRef);
    if (!caseDetails) return res.status(404).json({ error: 'Case not found' });

    const { clientName } = caseDetails;
    const key = formKey || 'primary';

    const [flags, formFields] = await Promise.all([
      review.loadFlags({ clientName, caseRef, formKey: key }),
      svc.loadFormData({ clientName, caseRef, formKey: key }),
    ]);

    if (!Object.keys(flags).length) {
      return res.status(400).json({ error: 'No flags to send — flag at least one field first.' });
    }

    await review.sendCorrectionEmail({
      caseRef,
      formKey:    key,
      caseDetails,
      flags,
      formFields,
      staffName:  req.staff.name,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/q/notify] Error for ${caseRef}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Client flags endpoint — GET /q/:caseRef/flags ───────────────────────────
// Used by the injected client-side script to show inline flag notes.

router.get('/:caseRef/flags', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const token   = (req.query.t       || '').trim();
  const formKey = (req.query.formKey || 'primary').trim();

  try {
    const { clientName } = await svc.validateAccess(caseRef, token);
    const flags = await review.loadFlags({ clientName, caseRef, formKey });
    // Return only the comment per key — don't expose officer email/name to client
    const clientFlags = {};
    for (const [key, flag] of Object.entries(flags)) {
      clientFlags[key] = { comment: flag.comment };
    }
    return res.json({ flags: clientFlags });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// ─── Client: GET /q/:caseRef/data  — Return saved field data for pre-fill ────

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

// ─── Client: POST /q/:caseRef/save  — Save questionnaire data ────────────────

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

// ─── Client: POST /q/:caseRef/submit  — Submit and update Monday.com ─────────

router.post('/:caseRef/submit', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const { token, formKey, fields, completionPct } = req.body || {};

  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields must be an array' });
  }

  try {
    const { itemId, clientName, caseType, formFiles } = await svc.validateAccess(caseRef, token);

    const key       = formKey || 'primary';
    const formTitle = key === 'additional' && formFiles?.additional
      ? formFiles.additional.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim()
      : (formFiles?.primary || '').replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();

    await svc.saveFormData({ clientName, caseRef, itemId, formKey: key, fields, completionPct: completionPct || 0 });
    await svc.markSubmitted({ itemId, caseRef, caseType, formKey: key, formLabel: formTitle, completionPct: completionPct || 0, clientName });

    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/q] Submit error for ${caseRef}:`, err.message);
    return res.status(err.message.includes('token') ? 403 : 500).json({ error: err.message });
  }
});

// ─── Client: GET /q/:caseRef/members — Return member manifest ───────────────

router.get('/:caseRef/members', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const token   = (req.query.t || '').trim();

  try {
    const { clientName, caseType, caseSubType, formFiles } = await svc.validateAccess(caseRef, token);
    const members       = await svc.loadMembers({ clientName, caseRef });
    const memberTypes   = resolveMemberTypes(caseType, caseSubType);
    const withStatuses  = await svc.getMemberStatuses({ clientName, caseRef, members, formFiles });

    return res.json({
      members:          withStatuses,
      allowedMemberTypes: memberTypes,
    });
  } catch (err) {
    console.error(`[/q/members] Error for ${caseRef}:`, err.message);
    const is403 = err.message.includes('token') || err.message.includes('not found') || err.message.includes('Missing');
    return res.status(is403 ? 403 : 500).json({ error: err.message });
  }
});

// ─── Client: POST /q/:caseRef/add-member — Add a new member ────────────────

router.post('/:caseRef/add-member', async (req, res) => {
  const caseRef    = sanitiseCaseRef(req.params.caseRef);
  const { token, memberType } = req.body || {};

  if (!memberType) {
    return res.status(400).json({ error: 'memberType is required' });
  }

  try {
    const { clientName, caseType, caseSubType } = await svc.validateAccess(caseRef, token);

    // Validate that this member type is allowed for this case type
    const allowedTypes = resolveMemberTypes(caseType, caseSubType);
    if (!allowedTypes.includes(memberType)) {
      return res.status(400).json({
        error: `Member type "${memberType}" is not allowed for this case type.`,
        allowedTypes,
      });
    }

    const newMember = await svc.addMember({ clientName, caseRef, memberType });
    return res.json({ ok: true, member: newMember });
  } catch (err) {
    console.error(`[/q/add-member] Error for ${caseRef}:`, err.message);
    const status = err.message.includes('token') ? 403
                 : err.message.includes('already been added') ? 409
                 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// ─── Client: POST /q/:caseRef/remove-member — Remove an unsubmitted member ─

router.post('/:caseRef/remove-member', async (req, res) => {
  const caseRef    = sanitiseCaseRef(req.params.caseRef);
  const { token, memberKey } = req.body || {};

  if (!memberKey) {
    return res.status(400).json({ error: 'memberKey is required' });
  }

  try {
    const { clientName } = await svc.validateAccess(caseRef, token);
    await svc.removeMember({ clientName, caseRef, memberKey });
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[/q/remove-member] Error for ${caseRef}:`, err.message);
    const status = err.message.includes('token') ? 403
                 : err.message.includes('cannot be removed') || err.message.includes('Cannot remove') ? 409
                 : err.message.includes('not found') ? 404
                 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// ─── Client: GET /q/:caseRef  — Serve the questionnaire ──────────────────────
// NOTE: This catch-all MUST be the LAST route in this file.

router.get('/:caseRef', async (req, res) => {
  const caseRef = sanitiseCaseRef(req.params.caseRef);
  const token   = (req.query.t || '').trim();
  const fParam  = (req.query.f || '').trim();      // member key: 'primary', 'spouse', 'child-1', or legacy '1'/'2'
  const formParam = (req.query.form || '').trim();  // 'primary' or 'additional' (which form file for dual-form cases)

  try {
    const { clientName, caseType, caseSubType, formFiles } = await svc.validateAccess(caseRef, token);

    if (!formFiles) {
      return res.type('html').send(svc.buildPlaceholderPage(caseRef));
    }

    const hasTwo         = Boolean(formFiles.additional);
    const memberTypes    = resolveMemberTypes(caseType, caseSubType);
    const hasMembers     = memberTypes.length > 0;
    const needsOverview  = hasTwo || hasMembers;
    const overviewUrl    = needsOverview
      ? `/q/${encodeURIComponent(caseRef)}?t=${encodeURIComponent(token)}`
      : '';

    // ── No overview needed: single form, single member — serve directly ────
    if (!needsOverview) {
      const formTitle = formFiles.primary.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();
      return res.type('html').send(svc.buildFormPage({
        formFile:          formFiles.primary,
        caseRef, token,
        formKey:           'primary',
        formTitle,
        hasAdditionalForm: false,
        overviewUrl:       '',
      }));
    }

    // ── No f= param ───────────────────────────────────────────────────────
    if (!fParam) {
      const members      = await svc.loadMembers({ clientName, caseRef });
      const withStatuses = await svc.getMemberStatuses({ clientName, caseRef, members, formFiles });

      // ── Dual-form cases: still use overview page (two separate HTML files) ─
      if (hasTwo) {
        return res.type('html').send(
          svc.buildOverviewPage({
            caseRef, token,
            members:            withStatuses,
            formFiles,
            allowedMemberTypes: memberTypes,
          })
        );
      }

      // ── Single-form multi-member: serve form directly with all members ────
      const formTitle = formFiles.primary.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();
      return res.type('html').send(svc.buildFormPage({
        formFile:          formFiles.primary,
        caseRef, token,
        formKey:           'primary',
        formTitle,
        hasAdditionalForm: false,
        overviewUrl:       '',
        members:           withStatuses,
        allowedMemberTypes: memberTypes,
      }));
    }

    // ── f= param present: serve the specific form for the member ───────────

    // Legacy support: f=1 → primary, f=2 → additional (old dual-form URLs)
    let memberKey = fParam;
    let whichForm = formParam || 'primary';

    if (fParam === '1') { memberKey = 'primary'; whichForm = 'primary'; }
    if (fParam === '2') { memberKey = 'primary'; whichForm = 'additional'; }

    // Determine which HTML form file to serve
    const isAdditional = (whichForm === 'additional') && hasTwo;
    const formFile     = isAdditional ? formFiles.additional : formFiles.primary;

    // Build the formKey for data storage: combine member key + form type
    // e.g., primary form for spouse → formKey = 'spouse'
    // e.g., additional form for spouse → formKey = 'spouse-additional'
    const formKey = isAdditional ? `${memberKey}-additional` : memberKey;

    const formTitle = formFile.replace(/^\d+\.\s*/, '').replace(/\s*-\s*Questionnaire?.*$/i, '').trim();

    // Load member manifest to get the member's label for display
    const members    = await svc.loadMembers({ clientName, caseRef });
    const member     = members.find(m => m.key === memberKey);
    const memberLabel = member ? member.label : 'Primary Applicant';

    return res.type('html').send(svc.buildFormPage({
      formFile, caseRef, token,
      formKey,
      formTitle:          `${formTitle} — ${memberLabel}`,
      hasAdditionalForm:  hasTwo,
      overviewUrl,
      memberLabel,
    }));

  } catch (err) {
    console.error(`[/q] Access error for ${caseRef}:`, err.message);
    return res.status(403).type('html').send(svc.buildErrorPage(err.message));
  }
});

module.exports = router;
