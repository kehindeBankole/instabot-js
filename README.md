# instabot-js

Node.js rewrite of the Instagram DM assistant, hardened for VPS deployment.

## What changed from the first port
- SQLite persistence instead of a flat JSON file
- duplicate webhook message detection by Meta message id
- request timeouts for OpenAI and Graph API calls
- quieter logging by default (`LOG_PAYLOADS=false`)
- systemd service file for long-running VPS use
- safer default port (`8081`) so it can sit beside the Go bot

## Features
- `GET /ig-webhook` for Meta webhook verification
- `POST /ig-webhook` for Instagram messaging events
- Signature verification via `X-Hub-Signature-256` (when `IG_APP_SECRET` is set)
- Per-sender conversation memory in SQLite
- Automatic follow-up worker
- Public pages for `/`, `/health`, `/privacy`, `/data-deletion`
- Duplicate delivery protection for webhook events

## Why not markdown for persistence?
Markdown is fine for human notes. It is a lousy runtime datastore for a webhook bot because you need:
- reliable structured reads/writes
- concurrent access safety
- duplicate detection
- compact per-thread state updates

For model memory in a live bot, SQLite is the sane floor.

## Quick start
```bash
cp .env.example .env
npm install
npm start
```

## VPS deployment
```bash
sudo mkdir -p /opt/instabot-js
sudo rsync -av --delete ./ /opt/instabot-js/
cd /opt/instabot-js
npm install --omit=dev
sudo cp instabot-js.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now instabot-js
sudo systemctl status instabot-js
```

Logs:
```bash
journalctl -u instabot-js -f
```

## Reverse proxy
Put it behind Caddy or Nginx and point a subdomain to port `8081`.

Example Caddy snippet:
```caddy
instabotjs.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

## Meta webhook setup
- Callback URL: `https://<your-domain>/ig-webhook`
- Verify token: `IG_VERIFY_TOKEN`

## Environment variables
See `.env.example`.
