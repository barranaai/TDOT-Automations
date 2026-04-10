require('dotenv').config();
const express    = require('express');
const cookieParser = require('cookie-parser');
const mondayWebhookRouter       = require('./routes/mondayWebhook');
const questionnaireFormRouter    = require('./routes/questionnaireForm');
const documentUploadRouter       = require('./routes/documentUploadForm');
const htmlQuestionnaireRouter    = require('./routes/htmlQuestionnaireForm');
const mondayApi = require('./services/mondayApi');
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
const { templateBoardId, executionBoardId, clientMasterBoardId } = require('../config/monday');

const app = express();
const PORT = process.env.PORT || 5050;

app.use(express.json());
app.use(cookieParser());

app.use('/webhook/monday', mondayWebhookRouter);
app.use('/questionnaire',  questionnaireFormRouter);
app.use('/documents',      documentUploadRouter);
app.use('/q',              htmlQuestionnaireRouter);

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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/boards/execution', async (req, res) => {
  try {
    const board = await boardService.getBoardStructure(executionBoardId);
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.get('/api/boards/client-master', async (req, res) => {
  try {
    const board = await boardService.getBoardStructure(clientMasterBoardId);
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  webhookManager.ensureWebhookRegistered();
  startScheduler();
});
