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
│   │   ├── checklistService.js # Automation business logic
│   │   └── clientMasterService.js # Client Master board queries
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

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```
   MONDAY_API_KEY=your_api_key
   MONDAY_CLIENT_MASTER_BOARD_ID=your_client_master_board_id
   PORT=5050
   ```
   To find your Client Master board ID: open the board in Monday.com and check the URL (e.g. `.../boards/1234567890`).

3. Start the server:
   ```bash
   npm run dev   # development (nodemon)
   npm start     # production
   ```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/monday` | Receives Monday.com events |
| GET | `/health` | Health check |
| GET | `/api/monday-test` | Test Monday.com API connection |
| GET | `/api/client-master/document-collection-started` | Items on Client Master where Case Stage = "Document Collection Started" |
