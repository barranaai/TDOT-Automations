require('dotenv').config();
const path       = require('path');
const express    = require('express');
const cookieParser = require('cookie-parser');
const mondayWebhookRouter       = require('./routes/mondayWebhook');
const questionnaireFormRouter    = require('./routes/questionnaireForm');
const documentUploadRouter       = require('./routes/documentUploadForm');
const htmlQuestionnaireRouter    = require('./routes/htmlQuestionnaireForm');
const documentReviewRouter       = require('./routes/documentReviewForm');
const clientPortalRouter         = require('./routes/clientPortal');
const adminLoginRouter           = require('./routes/adminLogin');
const adminDashboardRouter       = require('./routes/adminDashboard');
const adminEnginesRouter         = require('./routes/adminEngines');
const adminCaseRouter            = require('./routes/adminCase');
const adminConsultationRouter    = require('./routes/adminConsultation');
const adminLeadsRouter           = require('./routes/adminLeads');
const mondayApi = require('./services/mondayApi');
const dashboardService           = require('./services/dashboardService');
const caseCockpitService         = require('./services/caseCockpitService');
const consultantPortalService    = require('./services/consultantPortalService');
const consultationFormService    = require('./services/consultationFormService');
const clientMasterService = require('./services/clientMasterService');
const boardService = require('./services/boardService');
const webhookManager  = require('./services/webhookManager');
const { startScheduler } = require('./services/scheduler');
const caseReadinessService = require('./services/caseReadinessService');
const caseAccess = require('./services/caseAccessService');
const { tryStaffAuth } = require('./middleware/staffAuth');
const slaRiskEngine        = require('./services/slaRiskEngine');
const expiryRiskEngine     = require('./services/expiryRiskEngine');
const caseHealthEngine     = require('./services/caseHealthEngine');
const chasingLoopService          = require('./services/chasingLoopService');
const escalationRoutingService    = require('./services/escalationRoutingService');
const emailService                = require('./services/emailService');
const checklistService            = require('./services/checklistService');
const docCodeGenerator            = require('./scripts/generateDocumentCodes');
const { templateBoardId, executionBoardId, clientMasterBoardId } = require('../config/monday');

const app = express();
const PORT = process.env.PORT || 5050;

// Capture the RAW request bytes alongside JSON parsing: webhook signature
// verification (Square, Zoom) must HMAC the exact bytes Square/Zoom sent.
// Route-level express.raw() never runs once this global parser has consumed
// the body — without this hook, handlers end up hashing "[object Object]".
// limit: the default is 100kb, and a filled long-form questionnaire (368
// fields on the spousal form, case 2026-ISS-010) crosses it — every save and
// submit then died as a bare 500 (found live 2026-08-20). 2mb is ~20x the
// largest real payload seen; multipart uploads go through multer separately.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// ── Canonical host ───────────────────────────────────────────────────────────
// The service answers on BOTH its Render hostname and the branded domain, but
// the Monday OAuth callback is registered on the branded one only. Starting a
// staff login from a Render-host link therefore set the CSRF state cookie on
// one domain and returned to the other — the cookie never arrived and the
// login died with "Invalid login state" (reported live 2026-08-18 from the
// board's Client Portal links, 315 of which still carry the old host).
//
// Redirecting page GETs to the canonical host makes every stale link — board
// columns, old emails, bookmarks — work permanently. Deliberately NOT applied
// to webhooks (senders don't follow redirects), the API, or the health check.
const CANONICAL_HOST = (() => {
  try { return new URL(process.env.RENDER_URL || '').host; } catch (_) { return ''; }
})();
const NO_REDIRECT = /^\/(webhook|api|phase2\/health)\b/;
app.use((req, res, next) => {
  if (!CANONICAL_HOST) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (NO_REDIRECT.test(req.path)) return next();
  const host = String(req.headers.host || '');
  if (!host || host === CANONICAL_HOST) return next();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  console.log(`[Canonical] ${host}${req.originalUrl} → ${CANONICAL_HOST}`);
  return res.redirect(302, `${proto}://${CANONICAL_HOST}${req.originalUrl}`);
});

app.use('/webhook/monday', mondayWebhookRouter);
app.use('/questionnaire',  questionnaireFormRouter);
app.use('/documents',      documentUploadRouter);
app.use('/q',              htmlQuestionnaireRouter);
app.use('/d',              documentReviewRouter);   // staff document review page
app.use('/client',         clientPortalRouter);     // unified client landing page
// Admin routes — order matters (most specific first)
app.use('/admin/dashboard', adminDashboardRouter);  // landing page after login
app.use('/admin/engines',   adminEnginesRouter);    // engine control panel
app.use('/admin/case',      adminCaseRouter);        // per-case staff cockpit
app.use('/admin',           adminConsultationRouter); // consultant portal (/admin/consultations, /admin/consultation/:id)
app.use('/admin',           adminLeadsRouter);        // leads tab (/admin/leads, /admin/lead/:id)
app.use('/admin',           adminLoginRouter);       // TDOT-branded login + auto-redirect

app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));
// Self-hosted static assets (brand logo, etc.). Self-hosting the logo means it no
// longer 404s when the marketing site rebuilds/moves its image URLs, and it works
// in emails (unlike data URIs, which Gmail/Outlook block). Long cache — it rarely changes.
app.use('/assets', express.static(path.join(__dirname, '..', 'public'), { maxAge: '30d' }));

// Phase 2 routes — all in one router (lead capture, booking, consult, retainer, webhooks)
const phase2Router = require('./routes/phase2');
app.use('/', phase2Router);

app.get('/', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Standalone public consultation form (independent of the lead/intake pipeline).
app.get('/consultation', (_req, res) => res.type('html').send(consultationFormService.buildFormHtml()));
app.post('/consultation/submit', express.urlencoded({ extended: true, limit: '256kb' }), async (req, res) => {
  try {
    await consultationFormService.processSubmission(req.body || {});
    res.type('html').send(consultationFormService.buildThanksHtml());
  } catch (err) {
    if (err.badRequest) return res.status(400).type('html').send(consultationFormService.buildErrorHtml(err.errors || [err.message]));
    console.error('[ConsultForm] submit failed:', err.stack || err.message);
    res.status(500).type('html').send(consultationFormService.buildErrorHtml(['Something went wrong on our end — please try again shortly.']));
  }
});

// ─── API key middleware for manual trigger endpoints ─────────────────────────
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!ADMIN_API_KEY) {
    console.warn('[Auth] ADMIN_API_KEY not set — all /api/* requests are blocked');
    return res.status(503).json({ error: 'API key not configured on server' });
  }
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

app.use('/api', requireApiKey);

// ── Updates thread (the Monday "Updates" section, in the platform) ───────────
// GET one item's thread (lead/consultation pages), the merged case thread
// (cockpit), and POST a staff update. All behind the /api admin-key gate.
app.get('/api/updates/:itemId', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.itemId)) return res.status(400).json({ error: 'numeric item id required' });
    res.json({ updates: await require('./services/updatesService').getUpdatesForItem(req.params.itemId) });
  } catch (err) {
    console.error('[Updates] read failed:', err.message);
    res.status(500).json({ error: 'Could not load the updates thread.' });
  }
});

app.get('/api/case-updates/:caseRef', async (req, res) => {
  try {
    res.json(await require('./services/updatesService').getCaseThread(req.params.caseRef));
  } catch (err) {
    if (/not found/i.test(err.message || '')) return res.status(404).json({ error: 'Case not found.' });
    console.error('[Updates] case thread failed:', err.message);
    res.status(500).json({ error: 'Could not load the updates thread.' });
  }
});

app.post('/api/updates/:itemId', express.json(), async (req, res) => {
  try {
    res.json(await require('./services/updatesService').postUpdate(req.params.itemId, req.body || {}));
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    console.error('[Updates] post failed:', err.message);
    res.status(500).json({ error: 'Could not post the update.' });
  }
});

// Manual trigger — resend intake email for a specific Client Master item ID
// Usage: POST /api/resend-intake/<itemId>
// Useful when a token was missing or an email was sent with a broken link.
app.post('/api/resend-intake/:itemId', async (req, res) => {
  const { itemId } = req.params;
  if (!itemId || !/^\d+$/.test(itemId)) {
    return res.status(400).json({ error: 'itemId must be a numeric Monday item ID' });
  }
  res.json({ status: 'triggered', message: `Resending intake email for item ${itemId}…` });
  emailService.sendIntakeEmail(itemId).catch((err) =>
    console.error(`[ResendIntake] Failed for item ${itemId}:`, err.message)
  );
});

// Manual re-seed — schema-driven checklist seeding for one case, with NO intake
// email and NO stage change. Use after populating/correcting the Family Members
// board, or to safely verify schema seeding without the webhook cascade.
// Idempotent (only adds missing rows). Schema-driven case types only.
// Usage: POST /api/checklist/reseed/<caseRef>
app.post('/api/checklist/reseed/:caseRef', async (req, res) => {
  const { caseRef } = req.params;
  try {
    const result = await checklistService.reseedByCaseRef(caseRef);
    res.json({ status: 'ok', ...result });
  } catch (err) {
    const map = { BAD_REQUEST: 400, NOT_FOUND: 404, NO_SCHEMA: 422 };
    const status = map[err.code] || 500;
    console.error(`[Reseed] ${caseRef}: ${err.message}`);
    res.status(status).json({ status: 'error', code: err.code || 'ERROR', error: err.message });
  }
});

// Teams migration preflight — proves organizer + Calendars.ReadWrite + Teams
// license in one shot with zero client impact (throwaway event, no attendees,
// auto-deleted). Run BEFORE flipping MEETING_PROVIDER=teams.
// Usage: POST /api/meeting-preflight
app.post('/api/meeting-preflight', async (req, res) => {
  try {
    const result = await require('./services/meetingService').preflightTeams();
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Verify the Teams TRANSCRIPT setup (Graph permission + application access
// policy) without needing a real transcribed meeting.
// Usage: POST /api/transcript-preflight
app.post('/api/transcript-preflight', async (req, res) => {
  try {
    const result = await require('./services/teamsTranscriptService').preflightTranscripts();
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Readiness of the Square appointment WRITE-BACK — shows the seller-level-writes
// plan flag + the rest of the config. ready=true → bookings create Square
// appointments automatically. Usage: POST /api/square-booking-preflight
app.post('/api/square-booking-preflight', async (req, res) => {
  try {
    const result = await require('./services/squareBookingsService').preflightSquareBooking();
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send a diagnostic email through the SAME Microsoft Graph path the retainer /
// consultation emails use, to isolate mailbox-delivery vs recipient-filtering.
// Usage: POST /api/test-email  { "to": "someone@example.com" }
app.post('/api/test-email', express.json(), async (req, res) => {
  try {
    const to = String((req.body && req.body.to) || '').trim();
    if (!to) return res.status(400).json({ ok: false, error: 'Provide "to" in the JSON body.' });
    const stamp = new Date().toISOString();
    await require('./services/microsoftMailService').sendEmail({
      to,
      subject: `TDOT mail delivery test — ${stamp}`,
      html: `<p>This is a delivery test from the TDOT app, sent via Microsoft Graph from <b>${process.env.MS_FROM_EMAIL || '(unset)'}</b>.</p><p>If you received this, the sending mailbox delivers to this address. Sent at ${stamp}.</p>`,
    });
    res.json({ ok: true, to, from: process.env.MS_FROM_EMAIL || null, sentAt: stamp, note: 'Graph accepted the message. Check the inbox (and spam).' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reporting/KPIs for the consultations dashboard — aggregates the Lead Board for a
// given month (?month=YYYY-MM; omit for all-time). Admin-gated like the other /api/*.
app.get('/api/kpis', async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : '';
    res.json(await require('./services/kpiService').getKpis(month));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monday-test', async (req, res) => {
  try {
    const data = await mondayApi.query('query { me { id name email } }');
    res.json({ connected: true, account: data.me });
  } catch (err) {
    res.status(500).json({
      connected: false,
      error: err.response?.data?.errors?.[0]?.message || err.message,
    });
  }
});

app.get('/api/client-master/document-collection-started', async (req, res) => {
  try {
    const items = await clientMasterService.getDocumentCollectionStartedItems();
    res.json({ count: items.length, items });
  } catch (err) {
    const message = err.response?.data?.errors?.[0]?.message || err.message;
    console.error('Error fetching document collection started items:', message);
    res.status(500).json({ error: message });
  }
});

// Board discovery endpoints (Step 1 — read-only)
app.get('/api/boards/template', async (req, res) => {
  try {
    const board = await boardService.getBoardStructure(templateBoardId);
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/boards/execution', async (req, res) => {
  try {
    const board = await boardService.getBoardStructure(executionBoardId);
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual trigger — run Case Readiness Engine immediately
app.post('/api/readiness/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'Case Readiness Engine running in background…' });
  caseReadinessService.runDailyReadinessCheck().catch((err) =>
    console.error('[Readiness] Manual run failed:', err.message)
  );
});

// Manual trigger — run SLA & Risk Engine immediately
app.post('/api/sla/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'SLA & Risk Engine running in background…' });
  slaRiskEngine.runDailyCheck().catch((err) =>
    console.error('[SLAEngine] Manual run failed:', err.message)
  );
});

// Manual trigger — run Case Health Engine immediately
app.post('/api/health/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'Case Health Engine running in background…' });
  caseHealthEngine.runHealthCheck().catch((err) =>
    console.error('[HealthEngine] Manual run failed:', err.message)
  );
});

// Manual trigger — run Expiry Risk Engine immediately
app.post('/api/expiry/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'Expiry Risk Engine running in background…' });
  expiryRiskEngine.runExpiryCheck().catch((err) =>
    console.error('[ExpiryEngine] Manual run failed:', err.message)
  );
});

// Manual trigger — run Escalation Routing Engine immediately
app.post('/api/escalation/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'Escalation Routing Engine running in background…' });
  escalationRoutingService.runEscalationRouting().catch((err) =>
    console.error('[EscRouting] Manual run failed:', err.message)
  );
});

// Manual trigger — run Client Chasing Loop immediately
app.post('/api/chasing/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'Client Chasing Loop running in background…' });
  chasingLoopService.runChasingLoop().catch((err) =>
    console.error('[ChasingLoop] Manual run failed:', err.message)
  );
});

// Document Code Generator — preview (dry run, returns counts + sample)
app.get('/api/utils/doc-codes/preview', async (req, res) => {
  try {
    const result = await docCodeGenerator.previewCodes();
    res.json(result);
  } catch (err) {
    console.error('[DocCodes] Preview failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Document Code Generator — write (fire-and-forget, generates missing codes)
app.post('/api/utils/doc-codes/generate', async (req, res) => {
  res.json({ status: 'triggered', message: 'Document Code Generator running in background…' });
  docCodeGenerator.generateCodes().catch((err) =>
    console.error('[DocCodes] Generate failed:', err.message)
  );
});

// Documenso e-sign self-test (admin-key gated via /api). Creates a DRAFT
// envelope from a tiny test PDF to verify the token + request shape WITHOUT
// emailing anyone. Pass ?distribute=1&email=you@x.com to also send a real test
// signature request. Used once during live calibration; safe to leave in place.
app.post('/api/documenso/selftest', express.json(), async (req, res) => {
  try {
    const documenso = require('./services/documensoService');
    const cfg = documenso._cfg();
    const email = (req.query.email || req.body?.email || 'signer@example.com').toString();
    const distribute = /^(1|true)$/i.test(String(req.query.distribute || ''));
    // externalId lets a controlled test target a real (disposable) lead, e.g.
    // "retainer-<leadId>" — signing it exercises the real capture → case-open.
    const externalId = (req.query.externalId || 'selftest').toString();

    // tiny 1-page PDF
    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'LETTER', margin: 72 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      doc.fontSize(18).text('TDOT Immigration — e-signature self-test', { align: 'left' });
      doc.moveDown().fontSize(11).text('This is a throwaway test document to calibrate the Documenso integration. Signature field is placed near the bottom of this page.');
      doc.moveDown(10).text('Signature: ______________________________');
      doc.end();
    });

    const env = await documenso.createEnvelope({
      pdfBuffer, title: 'TDOT e-sign self-test', externalId,
      signer: { email, name: 'Self Test' },
      subject: 'TDOT e-sign self-test', message: 'Calibration only — safe to ignore or delete.',
    });
    let distributed = false;
    if (distribute) { await documenso.distributeEnvelope(env.envelopeId); distributed = true; }

    // Fetch the created envelope so we can see its item id, recipients, and the
    // placed signature field (the create response is just { id }).
    let envelope = null;
    try { envelope = await documenso.getEnvelope(env.envelopeId); } catch (e) { envelope = { fetchError: e.message }; }

    res.json({
      ok: true,
      config: { baseUrl: cfg.baseUrl, tokenSet: Boolean(cfg.token), secretSet: Boolean(cfg.secret), enabled: cfg.enabled },
      envelopeId: env.envelopeId, envelopeItemId: env.envelopeItemId, distributed,
      envelope,
    });
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({
      ok: false, error: err.message,
      hint: 'Check DOCUMENSO_API_TOKEN / DOCUMENSO_BASE_URL, and that the create request shape matches the v2 API.',
    });
  }
});

// Documenso: the most recent inbound webhook (for live-calibration confirmation).
app.get('/api/documenso/last-webhook', (req, res) => {
  res.json({ last: require('./services/documensoService').lastWebhook() });
});

// Documenso: READ-ONLY envelope search (diagnostics — the API token lives only in
// this environment). Lists recent envelopes, optionally filtered by externalId
// substring (e.g. ?externalId=retainer-12641191022). Creates/changes nothing.
app.get('/api/documenso/envelopes', async (req, res) => {
  try {
    const documenso = require('./services/documensoService');
    const cfg = documenso._cfg();
    if (!cfg.token) return res.status(503).json({ ok: false, error: 'DOCUMENSO_API_TOKEN not set' });
    const wanted = String(req.query.externalId || '').trim();
    const perPage = Math.min(parseInt(req.query.perPage, 10) || 50, 100);
    const headers = { Authorization: cfg.token };
    // The v2 API's list shape has varied — try the known read endpoints in order.
    const attempts = [
      `${cfg.baseUrl}/envelope/find?page=1&perPage=${perPage}`,
      `${cfg.baseUrl}/envelope?page=1&perPage=${perPage}`,
      `${cfg.baseUrl.replace(/\/v2$/, '/v1')}/documents?page=1&perPage=${perPage}`,
    ];
    let list = null, used = null, lastErr = null;
    for (const url of attempts) {
      try {
        const r = await fetch(url, { headers });
        if (!r.ok) { lastErr = `${url} → ${r.status}`; continue; }
        const j = await r.json();
        list = j.envelopes || j.documents || j.data || (Array.isArray(j) ? j : null);
        if (list) { used = url; break; }
        lastErr = `${url} → unrecognized shape: ${JSON.stringify(j).slice(0, 200)}`;
      } catch (e) { lastErr = `${url} → ${e.message}`; }
    }
    if (!list) return res.status(502).json({ ok: false, error: `no list endpoint worked; last: ${lastErr}` });
    const compact = list.map((d) => ({
      id: d.id, envelopeId: d.envelopeId || d.id, externalId: d.externalId || null,
      title: d.title, status: d.status, createdAt: d.createdAt,
      recipients: (d.recipients || []).map((x) => ({ email: x.email, signingStatus: x.signingStatus || x.status || null, sendStatus: x.sendStatus || null })),
    })).filter((d) => !wanted || String(d.externalId || '').includes(wanted));
    res.json({ ok: true, endpoint: used, count: compact.length, envelopes: compact });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generate the REAL agreement PDF (server-side, so v2 templates apply) and stream
// it — used to calibrate the signature-field placement against the actual doc.
app.get('/api/documenso/preview-agreement', async (req, res) => {
  try {
    const type = String(req.query.type || 'retainer');
    const leadId = String(req.query.leadId || '').trim();
    if (!leadId) return res.status(400).json({ error: 'leadId required' });
    const leadService = require('./services/leadService');
    const lead = await leadService.getLead(leadId);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    let pdf;
    if (type === 'consult') pdf = await require('./services/consultAgreementService').getConsultAgreementDocument(lead);
    else                    pdf = await require('./services/retainerService2').getRetainerDocument(lead);
    res.type('application/pdf').send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Documenso: re-run capture for an already-completed envelope (calibration only).
// Idempotent — captureCompleted won't re-open a case whose Retainer Signed is
// already set; this validates the signed-PDF download + OneDrive store.
app.post('/api/documenso/recapture', express.json(), async (req, res) => {
  try {
    const documenso = require('./services/documensoService');
    const envelopeId = (req.query.envelopeId || req.body?.envelopeId || '').toString();
    if (!envelopeId) return res.status(400).json({ ok: false, error: 'envelopeId required' });
    const result = await documenso.captureCompleted({ event: 'DOCUMENT_COMPLETED', payload: { envelopeId } });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/boards/client-master', async (req, res) => {
  try {
    const board = await boardService.getBoardStructure(clientMasterBoardId);
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Owner dashboard stats — fetches and aggregates all Client Master cases
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const stats = await dashboardService.getDashboardStats();
    res.json(stats);
  } catch (err) {
    console.error('[Dashboard] Stats failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resolve who is asking: the shared admin key → see all; otherwise a Monday
// staff login → see only their assigned cases (unless their email is an admin).
// Deliberately NOT under app.use('/api', requireApiKey) so the staff cookie
// works without the shared key — and so staff-cookie access is scoped to THIS
// endpoint, not the whole /api surface.
function resolveViewer(req) {
  const key = req.headers['x-api-key'] || req.query.key || '';
  if (ADMIN_API_KEY && key === ADMIN_API_KEY) {
    return { isAdmin: true, scope: 'all', name: 'Admin', email: '' };
  }
  const staff = tryStaffAuth(req);
  if (staff) {
    const v = caseAccess.viewerFromStaff(staff);
    v.scope = v.isAdmin ? 'all' : 'assigned';
    return v;
  }
  return null;
}

// Identity-aware dashboard stats — filtered to the viewer's assigned cases.
app.get('/admin/dashboard-stats', async (req, res) => {
  const viewer = resolveViewer(req);
  if (!viewer) {
    return res.status(401).json({ error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' });
  }
  try {
    const stats = await dashboardService.getDashboardStats(viewer.isAdmin ? undefined : viewer);
    res.json({ ...stats, viewer: { name: viewer.name, email: viewer.email, scope: viewer.scope, isAdmin: viewer.isAdmin } });
  } catch (err) {
    console.error('[Dashboard] Identity stats failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Retainer/payment status audit — does every case's Payment Status agree with
// its lead's retainer dates? Read-only by default; ?repair=1 applies the same
// non-destructive fixes the 15-minute sync job makes, on demand.
app.get('/admin/status-audit', async (req, res) => {
  const viewer = resolveViewer(req);
  if (!viewer || !viewer.isAdmin) return res.status(403).json({ error: 'Admins only' });
  try {
    const repair = req.query.repair === '1' || req.query.repair === 'true';
    const result = await require('./services/retainerStatusReconciler')
      .sweepRetainerStatus({ dryRun: !repair, includeStalled: true });
    res.json({ mode: repair ? 'repair' : 'report', ...result });
  } catch (err) {
    console.error('[StatusSync] Audit failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Post-hoc co-signature: send the Inviter/Sponsor/Dependent their signature
// request over the CURRENT signed retainer — for pa-inviter agreements that
// were executed before parallel co-signing existed and went to the PA only.
// Admin-gated; idempotent (an already-issued envelope resumes, a captured
// co-signature refuses).
app.post('/admin/retainer/:leadId/send-inviter-signature', async (req, res) => {
  const viewer = resolveViewer(req);
  if (!viewer || !viewer.isAdmin) return res.status(403).json({ error: 'Admins only' });
  try {
    const result = await require('./services/retainerCountersignService')
      .sendInviterSignatureRequest(String(req.params.leadId || '').trim(),
        { reissue: req.query.reissue === '1' || req.query.reissue === 'true' });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    console.error('[RetainerCountersign] inviter send failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Staff case cockpit — unified single-case snapshot for /admin/case/:caseRef
app.get('/api/case/:caseRef', async (req, res) => {
  try {
    const overview = await caseCockpitService.getCaseOverview((req.params.caseRef || '').trim());
    res.json(overview);
  } catch (err) {
    const notFound = /not found/i.test(err.message || '');
    if (!notFound) console.error('[Cockpit] Overview failed:', err.stack || err.message);
    res.status(notFound ? 404 : 500).json({ error: err.message });
  }
});

// Identity-aware cockpit data — a Monday-logged-in staffer may only open a case
// they're assigned to (any people column); the admin key / allowlisted email
// sees any case. Not under /api so the staff cookie works without the key.
app.get('/admin/case-data/:caseRef', async (req, res) => {
  const viewer = resolveViewer(req);
  if (!viewer) return res.status(401).json({ error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' });
  try {
    const overview = await caseCockpitService.getCaseOverview((req.params.caseRef || '').trim());
    // If the Client Master read failed, `assignees` is empty — do NOT run the
    // RBAC check against it (an assigned staffer would get a misleading
    // 'not-assigned'). Surface the outage as 503 so the page shows a retry.
    if (overview.cmUnavailable && !viewer.isAdmin) {
      return res.status(503).json({ error: 'temporarily-unavailable', message: 'Case data is temporarily unavailable. Please reload in a moment.' });
    }
    if (!viewer.isAdmin && !caseAccess.viewerCanSee(overview.assignees, viewer)) {
      return res.status(403).json({ error: 'not-assigned', message: 'You are not assigned to this case, so you cannot view it.' });
    }
    res.json(overview);
  } catch (err) {
    const notFound = /not found/i.test(err.message || '');
    if (!notFound) console.error('[Cockpit] Identity overview failed:', err.stack || err.message);
    res.status(notFound ? 404 : 500).json({ error: err.message });
  }
});

// Shared gate for cockpit WRITE actions: resolve the viewer + confirm they're
// assigned to (or admin for) this case, returning the case overview so callers
// can derive the linked lead server-side (never trust a client-supplied leadId).
async function resolveCaseForWrite(req, res, caseRef) {
  const viewer = resolveViewer(req);
  if (!viewer) { res.status(401).json({ ok: false, error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' }); return null; }
  let overview;
  try { overview = await caseCockpitService.getCaseOverview(caseRef); }
  catch (err) { res.status(/not found/i.test(err.message || '') ? 404 : 500).json({ ok: false, error: err.message }); return null; }
  if (!viewer.isAdmin && !caseAccess.viewerCanSee(overview.assignees, viewer)) {
    res.status(403).json({ ok: false, error: 'You are not assigned to this case.' }); return null;
  }
  return { viewer, overview };
}

// ─── Careful delete (ADMIN ONLY) ─────────────────────────────────────────────
// Cascading removal of a lead/case across Monday boards + OneDrive. Preview
// first, then execute with a typed confirmation. Lives on the resolveViewer
// surface (NOT /api) because only viewer.isAdmin distinguishes admins from
// regular staff — possession of the page is not authorisation to delete.
function resolveAdminOrReject(req, res, message = 'Only an admin can delete records.') {
  const viewer = resolveViewer(req);
  if (!viewer) { res.status(401).json({ error: 'Sign in required', loginUrl: '/q/auth/monday' }); return null; }
  if (!viewer.isAdmin) { res.status(403).json({ error: 'admin-only', message }); return null; }
  return viewer;
}

app.get('/admin/delete/preview', async (req, res) => {
  if (!resolveAdminOrReject(req, res)) return;
  try {
    const preview = await require('./services/deletionService').previewDeletion({
      leadId: (req.query.leadId || '').trim() || undefined,
      caseRef: (req.query.caseRef || '').trim() || undefined,
    });
    res.json(preview);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    console.error('[Deletion] Preview failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/admin/delete/execute', express.json(), async (req, res) => {
  const viewer = resolveAdminOrReject(req, res);
  if (!viewer) return;
  const { leadId, caseRef, confirmText, kind } = req.body || {};
  try {
    const result = await require('./services/deletionService').executeDeletion({
      leadId: String(leadId || '').trim() || undefined,
      caseRef: String(caseRef || '').trim() || undefined,
      confirmText,
      expectedKind: kind === 'case' || kind === 'lead' ? kind : undefined,
      actor: viewer.email || viewer.name || 'admin-key',
    });
    consultantPortalService.invalidateDirectRetainerQueue(); // deleted clients must drop off the Direct section immediately
    consultantPortalService.invalidateLeadsQueue();          // …and off the funnel-leads queue (was showing deleted leads as alive)
    res.json(result);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    console.error('[Deletion] Execute failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Identity-gated document action (mark reviewed / request rework).
app.post('/admin/case-action/:caseRef/document/:itemId/status', express.json(), async (req, res) => {
  const ctx = await resolveCaseForWrite(req, res, (req.params.caseRef || '').trim());
  if (!ctx) return;
  const itemId = String(req.params.itemId || '').replace(/\D/g, '');
  const { action, notes } = req.body || {};
  if (!itemId) return res.status(400).json({ ok: false, error: 'Invalid item id' });
  if (action !== 'reviewed' && action !== 'rework') return res.status(400).json({ ok: false, error: 'action must be "reviewed" or "rework"' });
  if (action === 'rework' && !(typeof notes === 'string' && notes.trim())) return res.status(400).json({ ok: false, error: 'notes are required for rework' });
  try {
    const reviewFormSvc = require('./services/documentReviewFormService');
    if (action === 'reviewed') await reviewFormSvc.markReviewed(itemId);
    else await reviewFormSvc.requestRework(itemId, notes.trim());
    console.log(`[Cockpit] doc ${itemId} (${(req.params.caseRef || '').trim()}) ${action} by ${ctx.viewer.email || 'admin'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Cockpit] identity doc action failed:', err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Identity-gated milestone action — leadId is DERIVED from the assigned case,
// and only the two milestone actions are permitted (never arbitrary lead ops).
const COCKPIT_MS_ACTIONS = ['sendMilestoneEtransferRequest', 'markMilestonePaid'];
app.post('/admin/case-action/:caseRef/milestone', express.json(), async (req, res) => {
  const ctx = await resolveCaseForWrite(req, res, (req.params.caseRef || '').trim());
  if (!ctx) return;
  const leadId = ctx.overview.lead && ctx.overview.lead.id;
  if (!leadId) return res.status(400).json({ error: 'No linked lead for this case.' });
  const { action, value } = req.body || {};
  if (!COCKPIT_MS_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unsupported action.' });
  try {
    const result = await consultantPortalService.applyAction({ leadId: String(leadId), action, value });
    res.json(result);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.notFound) return res.status(404).json({ error: err.message });
    console.error('[Cockpit] identity milestone action failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cockpit Documents tab — inline mark-reviewed / request-rework. Same service
// functions the /d/:caseRef/review page uses, but behind the cockpit's
// ADMIN_API_KEY (the /d page uses the separate Monday-OAuth staff cookie).
app.post('/api/case/:caseRef/document/:itemId/status', async (req, res) => {
  const itemId = String(req.params.itemId || '').replace(/\D/g, '');
  const { action, notes } = req.body || {};
  if (!itemId) return res.status(400).json({ ok: false, error: 'Invalid item id' });
  if (action !== 'reviewed' && action !== 'rework') {
    return res.status(400).json({ ok: false, error: 'action must be "reviewed" or "rework"' });
  }
  if (action === 'rework' && !(typeof notes === 'string' && notes.trim())) {
    return res.status(400).json({ ok: false, error: 'notes are required for rework' });
  }
  try {
    const reviewFormSvc = require('./services/documentReviewFormService');
    if (action === 'reviewed') await reviewFormSvc.markReviewed(itemId);
    else await reviewFormSvc.requestRework(itemId, notes.trim());
    console.log(`[Cockpit] document ${itemId} (${(req.params.caseRef || '').trim()}): ${action}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[Cockpit] document action ${action} failed for ${itemId}:`, err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Leads tab — the whole Lead Board, newest first (pre-booking pipeline)
// Staff-entered phone-in lead ("direct leads", meeting 2026-08-13). Same
// duplicate contract as the direct-client modal: 409 + matches until staff
// explicitly re-submit with allowDuplicate.
// ── Questionnaire version recovery (admin) ───────────────────────────────────
// A saved questionnaire is one JSON file per member; any overwrite (a bad
// client save, an operator mistake — one happened 2026-08-19) replaces it.
// OneDrive keeps version history, so these expose list + restore.
// A form key becomes part of the OneDrive filename — allow only the shape the
// app actually generates (primary / <member-key> / …-additional). Anything
// else is a path-injection attempt, not a real key.
function sanitiseFormKeyParam(s) {
  return String(s || 'primary').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60) || 'primary';
}

app.get('/admin/questionnaire/:caseRef/versions', async (req, res) => {
  const caseRef = String(req.params.caseRef || '').trim();
  // Reading a client's questionnaire history (answers metadata, editor names,
  // timestamps) is case-scoped: only an assigned staffer or an admin may see it.
  const ctx = await resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  try {
    const svc = require('./services/htmlQuestionnaireService');
    const oneDrive = require('./services/oneDriveService');
    const formKey = sanitiseFormKeyParam(req.query.formKey);
    const { clientName } = await svc.validateAccessForStaff(caseRef, { skipFormVersioning: true });
    const versions = await oneDrive.listFileVersions({
      clientName, caseRef, subfolder: 'Questionnaire',
      filename: `questionnaire-${caseRef}-${formKey}.json`,
    });
    res.json({ caseRef, formKey, clientName, versions: versions.map((v) => ({
      id: v.id, size: v.size, lastModified: v.lastModifiedDateTime,
      by: (v.lastModifiedBy && v.lastModifiedBy.user && v.lastModifiedBy.user.displayName) || '',
    })) });
  } catch (err) {
    console.error('[QVersions] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Read ONE historical version's parsed content — the diagnostic half of the
// recovery toolkit (list tells you WHEN, this tells you WHAT, restore/repair
// fix it). Same gate as the list: assigned staff or admin.
app.get('/admin/questionnaire/:caseRef/versions/:versionId/content', async (req, res) => {
  const caseRef = String(req.params.caseRef || '').trim();
  const ctx = await resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  try {
    const svc = require('./services/htmlQuestionnaireService');
    const oneDrive = require('./services/oneDriveService');
    const formKey = sanitiseFormKeyParam(req.query.formKey);
    const versionId = String(req.params.versionId || '').trim();
    if (!/^[0-9.]{1,20}$/.test(versionId)) return res.status(400).json({ error: 'invalid versionId' });
    const { clientName } = await svc.validateAccessForStaff(caseRef, { skipFormVersioning: true });
    const buf = await oneDrive.readFileVersion({
      clientName, caseRef, subfolder: 'Questionnaire',
      filename: `questionnaire-${caseRef}-${formKey}.json`, versionId,
    });
    if (!buf) return res.status(404).json({ error: 'that version could not be read' });
    let parsed = null;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { return res.status(422).json({ error: 'version content is not valid JSON' }); }
    const fields = Array.isArray(parsed) ? parsed : (parsed.fields || []);
    res.json({ caseRef, formKey, versionId, savedAt: (parsed && parsed.savedAt) || null, fields });
  } catch (err) {
    console.error('[QVersions] content read failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Surgical field-level repair — patch INDIVIDUAL answers (by section+label)
// without touching the rest of the file. Built for the table-key smear class:
// a wholesale restore would discard everything typed since the smear, while
// only ~a dozen values are actually wrong. Admin-only, dryRun default; the
// pre-repair state stays recoverable in OneDrive version history.
app.post('/admin/questionnaire/:caseRef/repair', express.json(), async (req, res) => {
  const caseRef = String(req.params.caseRef || '').trim();
  const ctx = await resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  if (!ctx.viewer.isAdmin) return res.status(403).json({ error: 'Admins only — repair rewrites the client’s saved answers.' });
  try {
    const svc = require('./services/htmlQuestionnaireService');
    const oneDrive = require('./services/oneDriveService');
    const { patches, dryRun = true } = req.body || {};
    const formKey = sanitiseFormKeyParam((req.body || {}).formKey);
    if (!Array.isArray(patches) || !patches.length) return res.status(400).json({ error: 'patches must be a non-empty array of { section, label, value, expect? }' });
    if (patches.length > 100) return res.status(400).json({ error: 'too many patches (max 100)' });
    const { clientName } = await svc.validateAccessForStaff(caseRef, { skipFormVersioning: true });
    const filename = `questionnaire-${caseRef}-${formKey}.json`;
    const buf = await oneDrive.readFile({ clientName, caseRef, subfolder: 'Questionnaire', filename });
    if (!buf) return res.status(404).json({ error: 'no saved questionnaire file for this formKey' });
    let parsed = null;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { return res.status(422).json({ error: 'current file is not valid JSON — use restore, not repair' });
    }
    const current = Array.isArray(parsed) ? { fields: parsed } : parsed;
    const { fields, applied, errors } = svc.applyFieldPatches(current.fields || [], patches);
    if (errors.length) return res.status(409).json({ error: 'some patches could not be applied — nothing was written', applied: [], errors, dryRun });
    if (dryRun) return res.json({ dryRun: true, caseRef, formKey, wouldApply: applied });
    const content = JSON.stringify({ ...current, fields, repairedAt: new Date().toISOString(), repairedBy: ctx.viewer.email || ctx.viewer.name || 'admin' }, null, 2);
    await oneDrive.uploadFile({ clientName, caseRef, category: 'Questionnaire', filename, buffer: Buffer.from(content, 'utf8'), mimeType: 'application/json' });
    console.log(`[QRepair] ${caseRef}/${formKey}: ${applied.length} field(s) repaired by ${ctx.viewer.email || 'admin'}`);
    res.json({ ok: true, caseRef, formKey, applied });
  } catch (err) {
    console.error('[QRepair] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-time PDF layout refresh (ADMIN ONLY, dry-run by default): regenerate
// each saved form's questionnaire-{caseRef}-{formKey}.pdf from its JSON truth
// file. Only the PDFs are (over)written; JSON / manifest / Monday untouched.
// Driven per case by scripts/regenerate-questionnaire-pdfs.js.
app.post('/admin/questionnaire/:caseRef/regenerate-pdfs', express.json(), async (req, res) => {
  const viewer = resolveAdminOrReject(req, res);
  if (!viewer) return;
  const caseRef = String(req.params.caseRef || '').trim();
  if (!/^[A-Za-z0-9-]{3,40}$/.test(caseRef)) return res.status(400).json({ error: 'bad caseRef' });
  try {
    const svc = require('./services/htmlQuestionnaireService');
    const { dryRun = true, qCompletionStatus = '', updates = null, updatesTruncated = false, skipKeys = [], createMissing = false, editedAfterSubmission = 'skip' } = req.body || {};
    // skipFormVersioning: the recorded formFile wins for the label; the era resolver's extra reads are not needed here.
    const { clientName, formFiles } = await svc.validateAccessForStaff(caseRef, { skipFormVersioning: true });
    const result = await require('./services/questionnairePdfService').regenerateCasePdfs({
      clientName, caseRef, formFiles, qCompletionStatus: String(qCompletionStatus || ''),
      updates: Array.isArray(updates) ? updates.slice(0, 200) : null,
      updatesTruncated: updatesTruncated === true,
      skipKeys: Array.isArray(skipKeys) ? skipKeys.slice(0, 50).map(String) : [],
      dryRun: dryRun !== false, createMissing: createMissing === true,
      editedAfterSubmission: editedAfterSubmission === 'render' ? 'render' : 'skip',
    });
    if (!result.dryRun) console.log(`[QPdf] regenerate ${caseRef}: ${result.forms.filter((f) => f.action === 'regenerated').length} PDF(s) rewritten, ${result.failed} failed, by ${viewer.email || 'admin-key'}`);
    // Partial transient failure → 503 WITH the per-form results; the driver records what was done and
    // retries the case passing skipKeys for the forms already regenerated.
    if (result.transientFailures) return res.status(503).json({ ...result, error: 'some forms failed transiently', transient: true });
    res.json(result);
  } catch (err) {
    console.error(`[QPdf] regenerate failed for ${caseRef}:`, err.message);
    const status = err.transient ? 503 : (/not found/i.test(err.message || '') ? 404 : 500);
    res.status(status).json({ error: err.message, transient: !!err.transient });
  }
});

// Read-only OneDrive listing of one case sub-folder (ADMIN ONLY) — for audits
// such as "where did the client's uploads land". Never writes.
app.get('/admin/onedrive/list', async (req, res) => {
  if (!resolveAdminOrReject(req, res, 'Only an admin can list case folders.')) return;   // send the key as x-api-key, not ?key=
  const caseRef   = String(req.query.caseRef || '').trim();
  const subfolder = String(req.query.subfolder || '').trim();
  const wholeTree = subfolder === '*';   // every sub-folder of the case, with its files
  if (!/^[A-Za-z0-9-]{3,40}$/.test(caseRef) || (!wholeTree && !/^[A-Za-z0-9 _&()-]{1,60}$/.test(subfolder))) {
    return res.status(400).json({ error: 'caseRef and subfolder required' });
  }
  try {
    const oneDrive = require('./services/oneDriveService');
    const { clientName } = await require('./services/htmlQuestionnaireService').validateAccessForStaff(caseRef, { skipFormVersioning: true });
    if (req.query.find === '1') {
      // Diagnosis: what is this case's folder called, and does the expected name still match?
      const expected = oneDrive.caseFolderName({ clientName, caseRef });
      const [byName, byRef] = await Promise.all([
        oneDrive.getClientFolderByName(expected).catch((e) => ({ error: e.message })),
        oneDrive.findCaseFolderByRef(caseRef).catch((e) => ({ error: e.message })),
      ]);
      return res.json({ caseRef, clientName, expected, foundByName: byName || null, foundByRef: byRef || null,
        renamed: Boolean(byRef && byRef.name && byRef.name !== expected) });
    }
    if (wholeTree) {
      const kids = await oneDrive.listChildren({ clientName, caseRef, subfolder: '' });
      const folders = [];
      for (const f of kids.filter((k) => k.isFolder)) {
        folders.push({ folder: f.name, files: await oneDrive.listFiles({ clientName, caseRef, subfolder: f.name }) });
      }
      const rootFiles = kids.filter((k) => !k.isFolder).map((k) => ({ name: k.name, size: k.size, lastModifiedDateTime: k.lastModifiedDateTime }));
      return res.json({ caseRef, clientName, tree: folders, rootFiles, count: folders.reduce((n, f) => n + f.files.length, 0) + rootFiles.length });
    }
    const files = await oneDrive.listFiles({ clientName, caseRef, subfolder });
    res.json({ caseRef, clientName, subfolder, count: files.length, files });
  } catch (err) {
    console.error(`[OneDriveList] failed for ${caseRef}/${subfolder}:`, err.message);
    res.status(err.transient ? 503 : (/not found/i.test(err.message || '') ? 404 : 500)).json({ error: err.transient ? 'OneDrive temporarily unavailable' : err.message });
  }
});

// Re-file a case's "General" uploads into their category folders (ADMIN ONLY,
// dry-run by default). Only OneDrive moves — never deletes, never Monday.
// See documentRefileService; driven per case by scripts/refile-general-uploads.js.
app.post('/admin/onedrive/refile-general', express.json(), async (req, res) => {
  const viewer = resolveAdminOrReject(req, res, 'Only an admin can re-file case documents.');
  if (!viewer) return;
  const caseRef = String((req.body || {}).caseRef || '').trim();
  const dryRun  = (req.body || {}).dryRun !== false;
  if (!/^[A-Za-z0-9-]{3,40}$/.test(caseRef)) return res.status(400).json({ error: 'bad caseRef' });
  try {
    const { clientName } = await require('./services/htmlQuestionnaireService').validateAccessForStaff(caseRef, { skipFormVersioning: true });
    const result = await require('./services/documentRefileService').refileGeneralUploads({ caseRef, clientName, dryRun });
    if (!dryRun) console.log(`[Refile] ${caseRef}: ${result.moved.length} moved, ${result.failed.length} failed, by ${viewer.email || 'admin-key'}`);
    const transient = result.failed.some((f) => f.transient);
    res.status(transient ? 503 : 200).json(transient ? { ...result, error: 'some moves failed transiently', transient: true } : result);
  } catch (err) {
    console.error(`[Refile] failed for ${caseRef}:`, err.message);
    res.status(err.transient ? 503 : (/not found/i.test(err.message || '') ? 404 : 500)).json({ error: err.message, transient: !!err.transient });
  }
});

app.post('/admin/questionnaire/:caseRef/restore', express.json(), async (req, res) => {
  const caseRef = String(req.params.caseRef || '').trim();
  // Restore OVERWRITES the live questionnaire file — a destructive write, so
  // admin-only (matches the delete cascade). resolveCaseForWrite proves a
  // signed-in identity; the extra isAdmin check restricts the overwrite itself.
  const ctx = await resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  if (!ctx.viewer.isAdmin) return res.status(403).json({ error: 'Admins only — restore overwrites the client’s saved answers.' });
  try {
    const svc = require('./services/htmlQuestionnaireService');
    const oneDrive = require('./services/oneDriveService');
    const { versionId, dryRun = true } = req.body || {};
    const formKey = sanitiseFormKeyParam((req.body || {}).formKey);
    if (!versionId) return res.status(400).json({ error: 'versionId is required' });
    const { clientName, itemId } = await svc.validateAccessForStaff(caseRef, { skipFormVersioning: true });
    const filename = `questionnaire-${caseRef}-${formKey}.json`;
    const buf = await oneDrive.readFileVersion({ clientName, caseRef, subfolder: 'Questionnaire', filename, versionId });
    if (!buf) return res.status(404).json({ error: 'that version could not be read' });
    let parsed = null;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { return res.status(422).json({ error: 'version content is not valid JSON' }); }
    const fields = Array.isArray(parsed) ? parsed : (parsed.fields || []);
    const filled = fields.filter((f) => f && String(f.value || '').trim()).length;
    if (dryRun) return res.json({ dryRun: true, caseRef, formKey, versionId, wouldRestore: { fields: fields.length, filled } });
    await oneDrive.uploadFile({
      clientName, caseRef, category: 'Questionnaire', filename,
      buffer: buf, mimeType: 'application/json',
    });
    console.log(`[QVersions] RESTORED ${caseRef}/${formKey} from version ${versionId} (${fields.length} fields)`);
    res.json({ ok: true, caseRef, formKey, versionId, restored: { fields: fields.length, filled }, itemId });
  } catch (err) {
    console.error('[QVersions] restore failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/create', express.json(), async (req, res) => {
  try {
    res.json(await consultantPortalService.createStaffLead(req.body || {}));
  } catch (err) {
    if (err.conflict)   return res.status(409).json({ error: err.message, matches: err.matches });
    if (err.badRequest) return res.status(400).json({ error: err.message });
    console.error('[Leads] Staff lead create failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/leads', async (_req, res) => {
  try {
    const leads = await consultantPortalService.getLeadsQueue();
    res.json({ leads });
  } catch (err) {
    console.error('[Leads] Queue failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Leads tab — one lead with the complete intake submission
app.get('/api/lead/:leadId', async (req, res) => {
  try {
    const detail = await consultantPortalService.getLeadDetail((req.params.leadId || '').trim());
    res.json(detail);
  } catch (err) {
    if (err.notFound) return res.status(404).json({ error: err.message });
    console.error('[Leads] Detail failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — direct retainer client (walk-in/referral, no consultation):
// option lists for the form + creation. Creation is validated in the service
// (badRequest on missing name/email/case type/consultant).
app.get('/api/consultation/direct-client/options', async (_req, res) => {
  try {
    res.json(await consultantPortalService.getDirectClientOptions());
  } catch (err) {
    console.error('[Consultant] Direct client options failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — in-progress direct retainer clients (case-first; not yet Retained)
app.get('/api/direct-retainers', async (_req, res) => {
  try {
    res.json({ clients: await consultantPortalService.getDirectRetainerQueue() });
  } catch (err) {
    console.error('[Consultant] Direct queue failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/consultation/direct-client', express.json(), async (req, res) => {
  try {
    const result = await consultantPortalService.createDirectClient(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.conflict) return res.status(409).json({ error: err.message, matches: err.matches });
    if (err.badRequest) return res.status(400).json({ error: err.message });
    console.error('[Consultant] Direct client create failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// "New application": the reusable profile of a client's previous case —
// identity + slow-circumstance candidates (staff-confirmed in the modal),
// family roster, and read-only prior facts. Volatile fields never appear.
app.get('/api/consultation/client-profile', async (req, res) => {
  try {
    const profile = await require('./services/clientProfileService').gatherReusableProfile({
      sourceCaseRef: (req.query.caseRef || '').trim(),
    });
    if (!profile) return res.status(404).json({ error: 'No case found with that reference.' });
    res.json(profile);
  } catch (err) {
    console.error('[Consultant] client-profile failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Warn-and-link: everything that already exists for this email/phone (client
// accounts, open cases, leads) — feeds the duplicate panel in the modal.
app.get('/api/consultation/client-matches', async (req, res) => {
  try {
    const matches = await consultantPortalService.findClientMatches({
      email: (req.query.email || '').trim(),
      phone: (req.query.phone || '').trim(),
    });
    res.json(matches);
  } catch (err) {
    console.error('[Consultant] client-matches failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — booked-consultation queue
app.get('/api/consultations', async (_req, res) => {
  try {
    const consultations = await consultantPortalService.getConsultationQueue();
    res.json({ consultations });
  } catch (err) {
    console.error('[Consultant] Queue failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — one consultation, fully assembled
app.get('/api/consultation/:leadId', async (req, res) => {
  try {
    const detail = await consultantPortalService.getConsultationDetail((req.params.leadId || '').trim());
    res.json(detail);
  } catch (err) {
    if (err.notFound) return res.status(404).json({ error: err.message });
    console.error('[Consultant] Detail failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — write actions (outcome / fee / signed / invite / resend).
// Writes the lead column so Monday's existing webhook automation fires once —
// the consultant never touches the Monday frontend.
app.post('/api/consultation/:leadId/action', express.json(), async (req, res) => {
  try {
    const { action, value, amend } = req.body || {};
    // Who did it: every /api call carries the shared admin key (requireApiKey), so the
    // person is not identifiable server-side — the page sends the name they typed
    // (the same "Your name" the Updates box uses). Self-reported, shown on the note.
    const rawName = (req.body || {}).staffName;
    const staffName = typeof rawName === 'string' ? rawName.trim().slice(0, 60) : '';
    const result = await consultantPortalService.applyAction({
      leadId: (req.params.leadId || '').trim(), action, value, amend: amend === true, staffName,
    });
    res.json(result);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.notFound)   return res.status(404).json({ error: err.message });
    console.error('[Consultant] Action failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — retainer plan (read): system suggestion merged with saved
// selections + the option lists, for the retainer panel to hydrate.
app.get('/api/consultation/:leadId/retainer-plan', async (req, res) => {
  try {
    const r = await consultantPortalService.getRetainerPlan((req.params.leadId || '').trim());
    res.json(r);
  } catch (err) {
    if (err.notFound) return res.status(404).json({ error: err.message });
    console.error('[Consultant] Retainer plan failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — retainer PDF preview (read-only, non-mutating): renders the
// assembled retainer from the consultant's current selections. One CloudConvert
// conversion per call. Returns binary PDF (NOT json).
app.post('/api/consultation/:leadId/retainer-preview', express.json(), async (req, res) => {
  try {
    const value = (req.body && req.body.value !== undefined) ? req.body.value : req.body;
    const { buffer, filename } = await consultantPortalService.previewRetainerPdf((req.params.leadId || '').trim(), value);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${filename}"`).send(buffer);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.notFound)   return res.status(404).json({ error: err.message });
    console.error('[Consultant] Retainer preview failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — Initial Consultation agreement PDF preview (read-only).
app.post('/api/consultation/:leadId/consult-agreement-preview', async (req, res) => {
  try {
    const { buffer, filename } = await consultantPortalService.previewConsultAgreement((req.params.leadId || '').trim());
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${filename}"`).send(buffer);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.notFound)   return res.status(404).json({ error: err.message });
    console.error('[Consultant] Consult-agreement preview failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — the SIGNED consultation agreement PDF (client-signed, or
// fully signed once the RCIC countersigns — newest state wins).
app.post('/api/consultation/:leadId/consult-agreement-signed', async (req, res) => {
  try {
    const { buffer, filename } = await consultantPortalService.getSignedConsultAgreementPdf((req.params.leadId || '').trim());
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${filename}"`).send(buffer);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.notFound)   return res.status(404).json({ error: err.message });
    console.error('[Consultant] Signed consult-agreement fetch failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Consultant portal — the SIGNED retainer agreement PDF (same semantics).
app.post('/api/consultation/:leadId/retainer-agreement-signed', async (req, res) => {
  try {
    const { buffer, filename } = await consultantPortalService.getSignedRetainerAgreementPdf((req.params.leadId || '').trim());
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${filename}"`).send(buffer);
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.notFound)   return res.status(404).json({ error: err.message });
    console.error('[Consultant] Signed retainer fetch failed:', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Global error handler — catch unhandled route errors gracefully ──────────
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err.stack || err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Catch unhandled promise rejections — prevent silent crashes ──────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

// Body-parser failures (oversized/malformed JSON) must return an honest
// status + message, not the default bare 500 the questionnaire surfaced.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    console.warn(`[Body] ${req.method} ${req.path}: payload too large (${err.length || '?'} bytes)`);
    return res.status(413).json({ error: 'The form data is too large to save in one request — please contact your consultant.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body.' });
  }
  return next(err);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  webhookManager.ensureWebhookRegistered().catch(err =>
    console.error('[Server] Webhook registration failed:', err.message)
  );
  startScheduler();
});
