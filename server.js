/**
 * server.js
 * Simple Node/Express backend for CloudPDF
 *
 * - Streams files to clients
 * - Accepts uploads (multipart/form-data field 'file')
 * - Integrates with Telegram via getFile (BOT_TOKEN required for Telegram features)
 * - Simple JSON file storage for metadata (db.json)
 *
 * NOTE: Do not expose BOT_TOKEN to clients. Keep it server-side only.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pump = promisify(pipeline);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- CONFIG via environment variables ---
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // Telegram bot token (optional)
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const CACHE_TG_FILES = process.env.CACHE_TG_FILES !== 'false'; // default true

// Ensure storage dir exists
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Simple JSON DB helpers (file-based)
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { items: [] };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function addItem(item) {
  const db = loadDB();
  db.items = db.items || [];
  db.items.push(item);
  saveDB(db);
}
function updateItem(id, patch) {
  const db = loadDB();
  db.items = (db.items || []).map(it => (it.id === id ? { ...it, ...patch } : it));
  saveDB(db);
}
function removeItem(id) {
  const db = loadDB();
  db.items = (db.items || []).filter(it => it.id !== id);
  saveDB(db);
}
function findItem(id) {
  const db = loadDB();
  return (db.items || []).find(it => it.id === id);
}

// Multer for admin uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, STORAGE_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      const id = (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8));
      cb(null, `${id}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDFs allowed'), false);
    cb(null, true);
  },
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB default max; adjust as needed
});

// Utility to stream a file path to response
async function streamFileToResponse(fsPath, res, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  // set a sensible filename for download
  if (filename) res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
  const readStream = fs.createReadStream(fsPath);
  await pump(readStream, res);
}

// --- ROUTES ---

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// List
app.get('/api/list', (req, res) => {
  const db = loadDB();
  // expose only safe fields
  const list = (db.items || []).map(it => ({
    id: it.id,
    title: it.title || it.name || null,
    name: it.name || null,
    category: it.category || null,
    date: it.date || null,
    source: it.source || 'upload',
    size: it.size || null
  }));
  res.json(list);
});

// Serve / proxy a file by id
app.get('/api/file/:id', async (req, res) => {
  const id = req.params.id;
  const item = findItem(id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  try {
    // If item has a local path cached or uploaded, serve it directly
    if (item.localPath && fs.existsSync(item.localPath)) {
      return streamFileToResponse(item.localPath, res, item.title || item.name || `${id}.pdf`);
    }

    // If item originates from Telegram, fetch via getFile -> file_path -> proxy and cache
    if (item.source === 'telegram') {
      if (!BOT_TOKEN) return res.status(500).json({ error: 'Server missing BOT_TOKEN for Telegram' });

      // Call getFile
      const gf = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(item.file_id)}`);
      const gfJson = await gf.json();
      if (!gfJson.ok || !gfJson.result || !gfJson.result.file_path) {
        return res.status(502).json({ error: 'Telegram getFile failed', info: gfJson });
      }
      const filePath = gfJson.result.file_path; // e.g. documents/file_123.pdf
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      // Stream the Telegram file to client and optionally cache to disk
      // Create temp path
      const tmpName = `${id}-${path.basename(filePath)}`;
      const cachePath = path.join(STORAGE_DIR, tmpName);

      // Stream from Telegram to both file and response
      const upstream = await fetch(fileUrl);
      if (!upstream.ok) return res.status(502).json({ error: 'Failed to download from Telegram', status: upstream.status });

      // If caching is enabled, pipe to a write stream and also stream to response by piping upstream.body twice is not possible.
      // We'll write to disk first (stream), then stream to client from disk to avoid double-stream complexity.
      // Note: this buffers the file on disk but avoids holding in memory.
      const dest = fs.createWriteStream(cachePath);
      await pump(upstream.body, dest);

      // update DB to save cached localPath
      updateItem(id, { localPath: cachePath, cachedAt: Date.now() });
      return streamFileToResponse(cachePath, res, item.title || item.name || `${id}.pdf`);
    }

    // If other sources planned (e.g., s3) implement similar logic here
    return res.status(501).json({ error: 'Source not implemented' });
  } catch (err) {
    console.error('file serve error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload (admin)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const title = req.body.title || req.file.originalname;
    const category = req.body.category || 'Uncategorized';
    const id = path.parse(req.file.filename).name; // derived from filename id
    const newItem = {
      id,
      source: 'upload',
      name: req.file.originalname,
      title,
      category,
      date: Date.now(),
      size: req.file.size,
      localPath: req.file.path
    };
    addItem(newItem);
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('upload err', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// Delete
app.delete('/api/delete/:id', async (req, res) => {
  const id = req.params.id;
  const item = findItem(id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  // remove file if localPath exists
  try {
    if (item.localPath && fs.existsSync(item.localPath)) {
      fs.unlinkSync(item.localPath);
    }
  } catch (err) {
    console.warn('failed to unlink', err);
  }
  removeItem(id);
  res.json({ ok: true });
});

// Telegram webhook: receive updates and store metadata
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message || update.channel_post || null;
    if (!msg) return res.status(200).send('no message');

    // If user uploaded a document, save metadata
    if (msg.document) {
      const doc = msg.document;
      const id = (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8));
      const item = {
        id,
        source: 'telegram',
        file_id: doc.file_id,
        name: doc.file_name || 'telegram_file.pdf',
        title: doc.file_name || ('Telegram ' + id),
        category: 'Telegram',
        date: Date.now(),
        size: doc.file_size || null
      };
      addItem(item);

      // optional: pre-cache immediately (download now) to avoid later Telegram link expiry
      if (CACHE_TG_FILES && BOT_TOKEN) {
        try {
          const gf = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(doc.file_id)}`);
          const gfJson = await gf.json();
          if (gfJson.ok && gfJson.result && gfJson.result.file_path) {
            const filePath = gfJson.result.file_path;
            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
            const upstream = await fetch(fileUrl);
            if (upstream.ok) {
              const tmpName = `${id}-${path.basename(filePath)}`;
              const cachePath = path.join(STORAGE_DIR, tmpName);
              const dest = fs.createWriteStream(cachePath);
              await pump(upstream.body, dest);
              updateItem(id, { localPath: cachePath, cachedAt: Date.now() });
            }
          }
        } catch (e) {
          console.warn('precache failed', e);
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('webhook error', err);
    res.status(500).json({ error: 'webhook failed' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`CloudPDF server listening on port ${PORT}`);
  if (BOT_TOKEN) console.log('BOT_TOKEN is set (Telegram enabled)');
  else console.log('BOT_TOKEN not set (Telegram disabled)');
});
