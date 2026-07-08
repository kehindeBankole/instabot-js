# instabot-js

Node.js rewrite of the Instagram DM assistant.

## Features
- `GET /ig-webhook` for Meta webhook verification
- `POST /ig-webhook` for Instagram messaging events
- Signature verification via `X-Hub-Signature-256` (when `IG_APP_SECRET` is set)
- Per-sender conversation memory
- Automatic follow-up worker
- Public pages for `/`, `/health`, `/privacy`, `/data-deletion`
- Local JSON persistence via `DATA_FILE`

## Quick start
```bash
cp .env.example .env
npm install
npm start
```

## Meta webhook setup
- Callback URL: `https://<your-domain>/ig-webhook`
- Verify token: `IG_VERIFY_TOKEN`

## Environment variables
See `.env.example`.
