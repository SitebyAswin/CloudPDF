# CloudPDF Server

Backend for CloudPDF frontend. Provides endpoints:

- `GET /api/list` — returns JSON list of PDFs (id, title, category, source, date)
- `GET /api/file/:id` — streams the PDF (proxies Telegram if needed)
- `POST /upload` — admin file upload (multipart/form-data, field name `file`, optional `title` and `category`)
- `DELETE /api/delete/:id` — delete an item and cached file
- `POST /webhook` — Telegram webhook receiver (saves incoming `document` metadata)

## Quick start (local)

1. Clone repo
2. `npm install`
3. Create storage dir (optional — default `./storage` will be created automatically)
4. Start: `BOT_TOKEN=yourtoken npm start` (BOT_TOKEN optional if you want Telegram webhook support)

Uploaded files are stored in `storage/`. Metadata lives in `db.json`.

## Deploying

### Render
1. Create a new Web Service on Render, connect your GitHub repo.
2. Set `NODE_VERSION` to 18+.
3. Add environment variables:
   - `BOT_TOKEN` (optional)
   - `STORAGE_DIR` (optional)
   - `DB_FILE` (optional)
4. Deploy. After deploy, note the public URL (e.g. `https://your-app.onrender.com`)
5. In your CloudPDF frontend (Part 4), set `const SERVER_BASE = 'https://your-app.onrender.com'`.

Set Telegram webhook:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-app.onrender.com/webhook"
