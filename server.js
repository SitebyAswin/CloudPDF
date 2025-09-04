/**
 * CloudPDF S3 Server (presigned upload + presigned download)
 * Endpoints:
 *  - POST /api/get-upload-url       -> { uploadUrl, key, contentType }
 *  - POST /api/register             -> body: { id?, key, title, category, size? } -> { ok, id }
 *  - GET  /api/list                 -> [ { id, title, category, key, date, size } ]
 *  - GET  /api/file/:id             -> { url } (presigned GET for viewing/downloading)
 *  - DELETE /api/delete/:id         -> { ok }
 *
 * Notes:
 * - Presigned GET honors Range; PDF.js can fetch partial bytes directly from S3.
 * - Keep your AWS creds in .env (never expose to frontend).
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { join } = require('path');
const morgan = require('morgan');
const { nanoid } = require('nanoid');

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.S3_BUCKET;
const PUBLIC_BASE = process.env.PUBLIC_BASE || ''; // optional note string
const DB_FILE = process.env.DB_FILE || join(__dirname, 'db.json');
const PRESIGN_PUT_EXPIRE = parseInt(process.env.PRESIGN_PUT_EXPIRE || '900', 10);  // seconds
const PRESIGN_GET_EXPIRE = parseInt(process.env.PRESIGN_GET_EXPIRE || '120', 10);  // seconds
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// Minimal checks
if (!AWS_REGION || !S3_BUCKET) {
  console.warn('[WARN] Missing AWS_REGION or S3_BUCKET. Set them in .env');
}

// ====== S3 client ======
const s3 = new S3Client({ region: AWS_REGION });

// ====== Simple JSON "DB" ======
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function getAll() {
  const db = loadDB();
  return db.items || [];
}
function byId(id) {
  return getAll().find(x => x.id === id);
}
function upsert(item) {
  const db = loadDB();
  db.items = db.items || [];
  const i = db.items.findIndex(x => x.id === item.id);
  if (i >= 0) db.items[i] = item; else db.items.push(item);
  saveDB(db);
}
function remove(id) {
  const db = loadDB();
  db.items = (db.items || []).filter(x => x.id !== id);
  saveDB(db);
}

// ====== Server ======
const app = express();
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  }
}));

// Health
app.get('/health', (req, res) => res.json({ ok: true, region: AWS_REGION, bucket: S3_BUCKET, publicBase: PUBLIC_BASE }));

/**
 * POST /api/get-upload-url
 * Body: { filename, contentType? }
 * Returns: { uploadUrl, key, contentType }
 */
app.post('/api/get-upload-url', async (req, res) => {
  try {
    const { filename, contentType } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const cleanName = filename.replace(/[^\w.\-]/g, '_');
    const id = nanoid(10);
    const key = `uploads/${id}-${cleanName}`;
    const ct = contentType || 'application/pdf';

    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: ct,
      ACL: 'private',
      // Optionally add metadata:
      // Metadata: { uploadedBy: 'cloudpdf' }
    });
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: PRESIGN_PUT_EXPIRE });

    res.json({ uploadUrl, key, contentType: ct });
  } catch (err) {
    console.error('get-upload-url error', err);
    res.status(500).json({ error: 'failed to create upload url' });
  }
});

/**
 * POST /api/register
 * Body: { key, title, category, size? , id? }
 * - After client uploads to S3 using the presigned PUT, it calls this to save metadata.
 * Returns: { ok, id }
 */
app.post('/api/register', async (req, res) => {
  try {
    const { key, title, category, size, id } = req.body || {};
    if (!key || !title) return res.status(400).json({ error: 'key and title required' });

    // Optionally confirm object exists / get size, content-type
    let objectSize = size;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      objectSize = head.ContentLength || objectSize;
    } catch (e) {
      console.warn('HEAD object failed (maybe not public yet):', e?.name || e);
    }

    const doc = {
      id: id || nanoid(12),
      key,
      title,
      category: category || 'Uncategorized',
      size: objectSize || null,
      source: 's3',
      date: Date.now()
    };
    upsert(doc);
    res.json({ ok: true, id: doc.id });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'register failed' });
  }
});

/**
 * GET /api/list
 * Returns array of items (safe fields only)
 */
app.get('/api/list', (req, res) => {
  const items = getAll().map(({ id, title, category, key, size, date, source }) => ({
    id, title, category, key, size, date, source: source || 's3'
  }));
  res.json(items);
});

/**
 * GET /api/file/:id
 * Returns: { url } -> presigned GET URL to S3 (short-lived)
 */
app.get('/api/file/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const item = byId(id);
    if (!item) return res.status(404).json({ error: 'not found' });

    const getCmd = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: item.key,
      ResponseContentType: 'application/pdf',
      // Optionally set filename:
      // ResponseContentDisposition: `inline; filename="${(item.title || id).replace(/"/g,'')}.pdf"`
    });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: PRESIGN_GET_EXPIRE });
    res.json({ url, expiresIn: PRESIGN_GET_EXPIRE });
  } catch (err) {
    console.error('file presign error', err);
    res.status(500).json({ error: 'failed to presign' });
  }
});

/**
 * DELETE /api/delete/:id
 * Deletes S3 object and DB record
 */
app.delete('/api/delete/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const item = byId(id);
    if (!item) return res.status(404).json({ error: 'not found' });

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: item.key }));
    } catch (e) {
      console.warn('S3 delete failed (may already be gone):', e?.name || e);
    }
    remove(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete error', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`CloudPDF S3 server listening on :${PORT}`);
  if (ALLOWED_ORIGINS) console.log('CORS allowed origins:', ALLOWED_ORIGINS);
});
