require('dotenv').config();
const express = require('express');
const mondayWebhookRouter = require('./routes/mondayWebhook');
const mondayApi = require('./services/mondayApi');

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
