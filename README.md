# TDOT Automations

Express server that listens for Monday.com webhooks and runs automation logic.

## Project Structure

```
├── src/
│   ├── server.js               # Express app entry point
│   ├── routes/
│   │   └── mondayWebhook.js    # POST /webhook/monday
│   ├── services/
│   │   ├── mondayApi.js        # Monday GraphQL API wrapper
│   │   └── checklistService.js # Automation business logic
│   └── utils/
│       └── extractColumnValue.js
├── config/
│   └── monday.js               # API config loaded from .env
├── .env
├── package.json
└── README.md
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env` and fill in your credentials:
   ```
   MONDAY_API_KEY=your_api_key
   PORT=5050
   ```

3. Start the server:
   ```bash
   npm run dev   # development (nodemon)
   npm start     # production
   ```

## Webhook Endpoint

| Method | Path               | Description                  |
|--------|--------------------|------------------------------|
| POST   | `/webhook/monday`  | Receives Monday.com events   |
| GET    | `/health`          | Health check                 |
