'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const { detectPlatform, detectMediaType, isValidUrl, normalizeUrl } = require('./platformDetector');
const { extractInfo, downloadMedia, generateThumbnail, autoUpdateYtDlp, cleanupTemp } = require('./downloader');
const { saveCookie, getCookiesForPlatform, analyzeCookieHealth, deleteCookie, enableCookie, parseCookieFile } = require('./cookieManager');
const { cleanup: cacheCleanup } = require('./cacheManager');
const { cookieOps, downloadOps, statsOps } = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const API_KEY = process.env.API_KEY || '';
const TEMP_PATH = process.env.TEMP_PATH || '/data/temp';

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// ── API Key middleware ─────────────────────────────────────────────────────

function apiKeyAuth(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  next();
}

app.use('/api/', apiKeyAuth);

// ── Helpers ────────────────────────────────────────────────────────────────

function validateUrl(url) {
  if (!url || typeof url !== 'string') return { valid: false, error: 'URL is required' };
  const normalized = normalizeUrl(url.trim());
  if (!isValidUrl(normalized)) return { valid: false, error: 'Invalid URL format' };
  const platform = detectPlatform(normalized);
  if (platform === 'unknown') return { valid: false, error: 'Unsupported platform. Supported: YouTube, TikTok, Instagram, Facebook' };
  return { valid: true, url: normalized, platform };
}

// ── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'API running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ── POST /api/extract ──────────────────────────────────────────────────────

app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    return res.json({ success: true, ...meta });
  } catch (err) {
    console.error('[extract]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/preview ───────────────────────────────────────────────────────

app.get('/api/preview', async (req, res) => {
  const url = req.query.url;
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    const preview = {
      success: true,
      platform: meta.platform,
      media_type: meta.media_type,
      preview_type: meta.preview_type,
      title: meta.title,
      thumbnail: meta.thumbnail,
      preview_url: meta.preview_url,
      duration: meta.duration,
      uploader: meta.uploader,
    };

    if (meta.media_type === 'carousel' && meta.items) {
      preview.items = meta.items.map(item => ({
        type: item.type,
        preview_url: item.preview_url,
      }));
      preview.total_items = meta.total_items;
    }

    return res.json(preview);
  } catch (err) {
    // Try thumbnail fallback
    console.warn('[preview] Full extract failed, returning minimal preview:', err.message);
    return res.json({
      success: true,
      platform: validation.platform,
      media_type: detectMediaType(validation.url, validation.platform),
      preview_type: 'video',
      title: null,
      thumbnail: null,
      preview_url: null,
    });
  }
});

// ── POST /api/download ─────────────────────────────────────────────────────

app.post('/api/download', async (req, res) => {
  const { url, format = 'best' } = req.body;
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const downloadId = uuidv4();
  downloadOps.insert(downloadId, validation.url, validation.platform, null, format);

  try {
    const result = await downloadMedia(
      downloadId,
      validation.url,
      format,
      validation.platform,
      null
    );

    const filePath = result.file_path;
    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ success: false, error: 'Downloaded file not found' });
    }

    const stat = fs.statSync(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).slice(1) || 'mp4';
    const mimeMap = { mp4: 'video/mp4', mp3: 'audio/mpeg', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webm: 'video/webm' };

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Download-ID', downloadId);
    res.setHeader('X-From-Cache', result.from_cache ? 'true' : 'false');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on('error', err => {
      console.error('[download] Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Stream error' });
    });

  } catch (err) {
    console.error('[download]', err.message);
    downloadOps.updateError(downloadId, err.message);
    return res.status(500).json({ success: false, error: err.message, download_id: downloadId });
  }
});

// ── GET /api/download/progress/:id ────────────────────────────────────────

app.get('/api/download/progress/:id', (req, res) => {
  const download = downloadOps.getById(req.params.id);
  if (!download) {
    return res.status(404).json({ success: false, error: 'Download not found' });
  }
  res.json({
    success: true,
    id: download.id,
    status: download.status,
    progress: download.progress,
    speed: download.speed,
    downloaded_size: download.downloaded_size,
    eta: download.eta,
    error: download.error,
    file_path: download.status === 'complete' ? path.basename(download.file_path || '') : null,
  });
});

// ── POST /api/cookies/upload ───────────────────────────────────────────────

app.post('/api/cookies/upload', async (req, res) => {
  const { platform, account_name, cookies: cookieContent, priority = 3 } = req.body;

  if (!platform || !['youtube', 'tiktok', 'instagram', 'facebook'].includes(platform)) {
    return res.status(400).json({ success: false, error: 'Invalid platform. Use: youtube, tiktok, instagram, facebook' });
  }
  if (!account_name || !account_name.trim()) {
    return res.status(400).json({ success: false, error: 'account_name is required' });
  }
  if (!cookieContent || !cookieContent.trim()) {
    return res.status(400).json({ success: false, error: 'cookies content is required' });
  }

  try {
    const stats = parseCookieFile(cookieContent);
    const saved = await saveCookie(platform, account_name.trim(), cookieContent, parseInt(priority, 10));

    return res.json({
      success: true,
      id: saved.id,
      platform: saved.platform,
      account_name: saved.account_name,
      status: saved.status,
      total_cookies: stats.total,
      valid_cookies: stats.valid,
      expired_cookies: stats.expired,
      invalid_cookies: stats.invalid,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/cookies ───────────────────────────────────────────────────────

app.get('/api/cookies', (req, res) => {
  const all = cookieOps.getAll();
  const sanitized = all.map(c => ({
    id: c.id,
    platform: c.platform,
    account_name: c.account_name,
    status: c.status,
    priority: c.priority,
    fail_count: c.fail_count,
    total_uses: c.total_uses,
    success_uses: c.success_uses,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
  res.json({ success: true, cookies: sanitized, total: sanitized.length });
});

// ── DELETE /api/cookies/:id ────────────────────────────────────────────────

app.delete('/api/cookies/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid ID' });

  const deleted = deleteCookie(id);
  if (!deleted) return res.status(404).json({ success: false, error: 'Cookie not found' });

  res.json({ success: true, message: `Cookie ${id} deleted` });
});

// ── POST /api/cookies/:id/enable ──────────────────────────────────────────

app.post('/api/cookies/:id/enable', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid ID' });
  enableCookie(id);
  res.json({ success: true, message: `Cookie ${id} re-enabled` });
});

// ── GET /api/cookies/health ────────────────────────────────────────────────

app.get('/api/cookies/health', (req, res) => {
  const results = analyzeCookieHealth();
  const summary = {
    total: results.length,
    active: results.filter(c => c.health_status === 'active').length,
    expired: results.filter(c => c.health_status === 'expired').length,
    invalid: results.filter(c => c.health_status === 'invalid').length,
    disabled: results.filter(c => c.status === 'disabled').length,
  };
  res.json({ success: true, summary, cookies: results });
});

// ── GET /api/stats ─────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const stats = statsOps.getSummary();
  res.json({ success: true, ...stats });
});

// ── GET /api/formats ──────────────────────────────────────────────────────

app.get('/api/formats', async (req, res) => {
  const url = req.query.url;
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    return res.json({
      success: true,
      platform: meta.platform,
      media_type: meta.media_type,
      title: meta.title,
      formats: meta.formats || [],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/thumbnail ─────────────────────────────────────────────────────

app.get('/api/thumbnail', async (req, res) => {
  const url = req.query.url;
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    if (meta.thumbnail) {
      return res.json({ success: true, thumbnail: meta.thumbnail, source: 'platform' });
    }

    // Fallback: generate from video (requires a temp download snippet)
    return res.json({ success: true, thumbnail: null, source: 'none', message: 'No thumbnail available' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Static file serving for temp downloads ────────────────────────────────

app.use('/files', express.static(TEMP_PATH, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
  },
}));

// ── 404 handler ────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// ── Error handler ──────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Cron jobs ──────────────────────────────────────────────────────────────

// Temp file cleanup every 30 minutes
cron.schedule('*/30 * * * *', () => {
  const deleted = cleanupTemp(1);
  if (deleted > 0) console.log(`[Cron] Cleaned ${deleted} temp file(s)`);
});

// Cache cleanup every 6 hours
cron.schedule('0 */6 * * *', () => {
  cacheCleanup();
  console.log('[Cron] Cache cleanup complete');
});

// Cookie health check every hour
cron.schedule('0 * * * *', () => {
  analyzeCookieHealth();
  console.log('[Cron] Cookie health check complete');
});

// ── Startup ────────────────────────────────────────────────────────────────

async function startup() {
  // Ensure data directories
  const dirs = [
    process.env.TEMP_PATH || '/data/temp',
    process.env.CACHE_PATH || '/data/cache',
    process.env.COOKIE_PATH || '/data/cookies',
    process.env.LOG_PATH || '/data/logs',
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Auto-update yt-dlp
  autoUpdateYtDlp().catch(console.warn);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Social Media Downloader API running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Docs:   POST /api/extract | POST /api/download | GET /api/stats`);
    if (API_KEY) console.log(`   Auth:   X-Api-Key header required`);
    console.log('');
  });
}

startup().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

module.exports = app;
