const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const PORT = process.env.PORT || 5000;
const BUCKET = process.env.S3_BUCKET || 'media-vault';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://garage-s3.garage-s3.svc.cluster.local:3900';
const S3_REGION = process.env.S3_REGION || 'garage';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 } // 250MB max
});

// 1. Garage S3 Client (Least-Privilege Key)
const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  }
});

// 2. PostgreSQL Connection Pool
const pool = new Pool({
  host: process.env.DB_HOST || 'media-db.garage-s3.svc.cluster.local',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB
});

// Initialize PostgreSQL Schema on Startup
async function initDb() {
  const query = `
    CREATE TABLE IF NOT EXISTS media_assets (
      id UUID PRIMARY KEY,
      original_name TEXT NOT NULL,
      s3_bucket TEXT NOT NULL,
      s3_key TEXT UNIQUE NOT NULL,
      s3_uri TEXT NOT NULL,
      s3_endpoint TEXT NOT NULL,
      etag TEXT,
      mime_type TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query(query);
      console.log('[DB] PostgreSQL schema verified (table: media_assets)');
      return;
    } catch (err) {
      console.warn(`[DB] Waiting for PostgreSQL (attempt ${attempt}/10)...`, err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  process.exit(1);
}

// GET /api/media -> Fetch all uploaded media metadata from PostgreSQL
app.get('/api/media', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM media_assets ORDER BY created_at DESC'
    );
    const items = rows.map(row => ({
      ...row,
      size_bytes: Number(row.size_bytes),
      stream_url: `/api/stream/${row.id}`
    }));
    res.json({
      bucket: BUCKET,
      endpoint: S3_ENDPOINT,
      replication: 'RF=3 (3 Zones)',
      items
    });
  } catch (err) {
    console.error('[GET /api/media] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload -> Upload binary to Garage S3 + Save Metadata & Location in PostgreSQL
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const id = crypto.randomUUID();
  const cleanName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const s3Key = `${Date.now()}-${id.slice(0, 8)}-${cleanName}`;
  const s3Uri = `s3://${BUCKET}/${s3Key}`;
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const mediaType = mimeType.startsWith('video/') ? 'video' : 'photo';

  try {
    // Step 1: Write object to Garage S3
    const s3Resp = await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: mimeType
    }));

    const etag = (s3Resp.ETag || '').replace(/"/g, '');

    // Step 2: Store S3 Location & Metadata in PostgreSQL
    try {
      const insertSQL = `
        INSERT INTO media_assets
          (id, original_name, s3_bucket, s3_key, s3_uri, s3_endpoint, etag, mime_type, media_type, size_bytes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *;
      `;
      const { rows } = await pool.query(insertSQL, [
        id,
        req.file.originalname,
        BUCKET,
        s3Key,
        s3Uri,
        S3_ENDPOINT,
        etag,
        mimeType,
        mediaType,
        req.file.size
      ]);

      const created = rows[0];
      res.status(201).json({
        ...created,
        size_bytes: Number(created.size_bytes),
        stream_url: `/api/stream/${created.id}`
      });
    } catch (dbErr) {
      // Rollback S3 object if DB insert fails
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key })).catch(() => {});
      throw dbErr;
    }
  } catch (err) {
    console.error('[POST /api/upload] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stream/:id -> Lookup S3 location in PostgreSQL and stream from Garage S3 to Browser
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT s3_bucket, s3_key, mime_type FROM media_assets WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Media record not found in DB' });

    const { s3_bucket, s3_key, mime_type } = rows[0];
    const s3Params = { Bucket: s3_bucket, Key: s3_key };
    if (req.headers.range) s3Params.Range = req.headers.range;

    const s3Object = await s3.send(new GetObjectCommand(s3Params));
    res.status(req.headers.range ? 206 : 200);
    res.setHeader('Content-Type', mime_type || s3Object.ContentType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (s3Object.ContentLength !== undefined) res.setHeader('Content-Length', s3Object.ContentLength);
    if (s3Object.ContentRange) res.setHeader('Content-Range', s3Object.ContentRange);

    s3Object.Body.pipe(res);
  } catch (err) {
    console.error('[GET /api/stream/:id] Error:', err);
    res.status(404).json({ error: 'Failed to stream object from Garage S3' });
  }
});

// DELETE /api/media/:id -> Delete from Garage S3 AND PostgreSQL
app.delete('/api/media/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT s3_bucket, s3_key FROM media_assets WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const { s3_bucket, s3_key } = rows[0];

    // 1. Delete from Garage S3
    await s3.send(new DeleteObjectCommand({ Bucket: s3_bucket, Key: s3_key }));

    // 2. Delete metadata row from PostgreSQL
    await pool.query('DELETE FROM media_assets WHERE id = $1', [req.params.id]);

    res.json({ deleted_id: req.params.id, deleted_s3_key: s3_key });
  } catch (err) {
    console.error('[DELETE /api/media/:id] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Garage Media Vault listening on http://0.0.0.0:${PORT}`);
  });
});
