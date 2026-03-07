require('dotenv').config();
const express = require('express');
const mondayWebhookRouter = require('./routes/mondayWebhook');
const mondayApi = require('./services/mondayApi');
const clientMasterService = require('./services/clientMasterService');

const app = express();
const PORT = process.env.PORT || 5050;

app.use(express.json());

app.use('/webhook/monday', mondayWebhookRouter);

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
