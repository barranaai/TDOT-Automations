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
const mondayApi = require('./services/mondayApi');
const dashboardService           = require('./services/dashboardService');
const caseCockpitService         = require('./services/caseCockpitService');
const consultantPortalService    = require('./services/consultantPortalService');
const clientMasterService = require('./services/clientMasterService');
const boardService = require('./services/boardService');
const webhookManager  = require('./services/webhookManager');
const { startScheduler } = require('./services/scheduler');
const caseReadinessService = require('./services/caseReadinessService');
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
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

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
app.use('/admin',           adminLoginRouter);       // TDOT-branded login + auto-redirect

app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));

// Phase 2 routes — all in one router (lead capture, booking, consult, retainer, webhooks)
const phase2Router = require('./routes/phase2');
app.use('/', phase2Router);

app.get('/', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
    const { action, value } = req.body || {};
    const result = await consultantPortalService.applyAction({
      leadId: (req.params.leadId || '').trim(), action, value,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  webhookManager.ensureWebhookRegistered().catch(err =>
    console.error('[Server] Webhook registration failed:', err.message)
  );
  startScheduler();
});
