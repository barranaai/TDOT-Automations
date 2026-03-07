const express = require('express');
const router = express.Router();
const checklistService = require('../services/checklistService');

router.post('/', async (req, res) => {
  const { event } = req.body;

  // Monday.com challenge handshake
  if (req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  if (!event) {
    return res.status(400).json({ error: 'No event payload received' });
  }

  try {
    await checklistService.handleEvent(event);
    res.json({ status: 'received' });
  } catch (err) {
    console.error('Error handling Monday webhook:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
