require('dotenv').config();
const express = require('express');
const mondayWebhookRouter    = require('./routes/mondayWebhook');
const questionnaireFormRouter = require('./routes/questionnaireForm');
const documentUploadRouter   = require('./routes/documentUploadForm');
const mondayApi = require('./services/mondayApi');
const clientMasterService = require('./services/clientMasterService');
const boardService = require('./services/boardService');
const webhookManager  = require('./services/webhookManager');
const { startScheduler } = require('./services/scheduler');
const slaRiskEngine      = require('./services/slaRiskEngine');
const chasingLoopService = require('./services/chasingLoopService');
const { templateBoardId, executionBoardId, clientMasterBoardId } = require('../config/monday');

const app = express();
const PORT = process.env.PORT || 5050;

app.use(express.json());

app.use('/webhook/monday', mondayWebhookRouter);
app.use('/questionnaire',  questionnaireFormRouter);
app.use('/documents',      documentUploadRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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

// Manual trigger — run SLA & Risk Engine immediately
app.post('/api/sla/run', async (req, res) => {
  res.json({ status: 'triggered', message: 'SLA & Risk Engine running in background…' });
  slaRiskEngine.runDailyCheck().catch((err) =>
    console.error('[SLAEngine] Manual run failed:', err.message)
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
