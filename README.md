# instabot-js

Node.js Instagram DM assistant with SQLite memory, product-sheet integration, image-aware replies, and follow-ups.

## Core capabilities
- receives Instagram DM webhooks
- replies in a human-like tone
- remembers recent conversation context
- loads products from a strict sheet format (Excel / Google Sheet / CSV / JSON)
- uses product image URLs as reference material
- can inspect inbound customer images/screenshots with a vision-capable model
- can send product images back to the customer
- escalates payment, delivery, returns, and unclear cases to a human
- sends follow-ups when appropriate

## Product sheet
Provide a strict structured sheet with columns like:
- `product_name`
- `sku`
- `description`
- `price`
- `stock`
- `variant`
- `category`
- `image_url`
- `image_url_2`
- `image_url_3`

The stricter the sheet, the less guesswork the model has to do.

## Supported sheet sources
- local `.xlsx`
- local `.csv`
- local `.json`
- remote URL to a CSV / XLSX / JSON file
- Google Sheet exported as CSV URL

Set it with:
```bash
PRODUCT_SHEET_PATH=/opt/instabot-js/products.xlsx
```
or a URL:
```bash
PRODUCT_SHEET_PATH=https://example.com/products.csv
```

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
Example Caddy snippet:
```caddy
winsta.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

## Meta webhook setup
- Callback URL: `https://<your-domain>/ig-webhook`
- Verify token: `IG_VERIFY_TOKEN`

## Environment variables
See `.env.example`.
