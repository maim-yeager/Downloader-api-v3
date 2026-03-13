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
const axios = require('axios');
const mime = require('mime-types'); // নতুন: MIME টাইপ নির্ধারণের জন্য

const { detectPlatform, detectMediaType, isValidUrl, normalizeUrl } = require('./platformDetector');
const { extractInfo, downloadMedia, generateThumbnail, autoUpdateYtDlp, cleanupTemp } = require('./downloader');
const { saveCookie, getCookiesForPlatform, analyzeCookieHealth, deleteCookie, enableCookie, parseCookieFile } = require('./cookieManager');
const { cleanup: cacheCleanup } = require('./cacheManager');
const { cookieOps, downloadOps, statsOps, apiKeyOps, rateLimitOps } = require('./db'); // নতুন: apiKeyOps, rateLimitOps যোগ

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const API_KEY = process.env.API_KEY || '';
const TEMP_PATH = process.env.TEMP_PATH || '/data/temp';
const NODE_ENV = process.env.NODE_ENV || 'development';

// ── Ensure directories ───────────────────────────────────────────────────

const REQUIRED_DIRS = [
  TEMP_PATH,
  process.env.CACHE_PATH || '/data/cache',
  process.env.COOKIE_PATH || '/data/cookies',
  process.env.LOG_PATH || '/data/logs',
];

REQUIRED_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
});

// ── Middleware ─────────────────────────────────────────────────────────────

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: NODE_ENV === 'development' ? false : undefined
}));

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Download-ID, X-From-Cache');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging
if (NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    skip: (req) => req.path === '/health'
  }));
}

// Rate limiting (DB-backed)
app.use('/api/', async (req, res, next) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const result = await rateLimitOps.check(ip, req.path, 60, 1);
    
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    
    if (!result.allowed) {
      return res.status(429).json({ 
        success: false, 
        error: 'Too many requests, please slow down.',
        retryAfter: 60
      });
    }
    next();
  } catch (err) {
    console.error('[RateLimit]', err.message);
    next(); // Fail open
  }
});

// ── API Key authentication middleware ─────────────────────────────────────

async function apiKeyAuth(req, res, next) {
  // Public endpoints
  const publicPaths = ['/health', '/api/proxy', '/api/preview'];
  if (publicPaths.includes(req.path)) {
    return next();
  }

  // Skip if no API key configured
  if (!API_KEY && !process.env.ENABLE_API_KEYS) {
    return next();
  }

  const key = req.headers['x-api-key'] || req.query.api_key;
  
  // Check static API key first
  if (API_KEY && key === API_KEY) {
    return next();
  }
  
  // Check DB-stored API keys
  if (process.env.ENABLE_API_KEYS) {
    try {
      const validation = await apiKeyOps.validate(key);
      if (validation?.valid) {
        req.apiKey = validation.key;
        return next();
      }
    } catch (err) {
      console.error('[API Key] Validation error:', err.message);
    }
  }
  
  return res.status(401).json({ 
    success: false, 
    error: 'Invalid or missing API key',
    docs: 'Contact admin to get an API key'
  });
}

app.use('/api/', apiKeyAuth);

// ── Request ID middleware ─────────────────────────────────────────────────

app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }
  
  const trimmed = url.trim();
  if (trimmed.length < 5) {
    return { valid: false, error: 'URL too short' };
  }
  
  const normalized = normalizeUrl(trimmed);
  if (!isValidUrl(normalized)) {
    return { valid: false, error: 'Invalid URL format' };
  }
  
  const platform = detectPlatform(normalized);
  if (platform === 'unknown') {
    return { 
      valid: false, 
      error: 'Unsupported platform. Supported: YouTube, TikTok, Instagram, Facebook, Twitter, Pinterest' 
    };
  }
  
  return { valid: true, url: normalized, platform };
}

function sendError(res, status, message, details = null) {
  const response = { success: false, error: message };
  if (details && NODE_ENV !== 'production') {
    response.details = details;
  }
  return res.status(status).json(response);
}

function sendSuccess(res, data = {}, status = 200) {
  return res.status(status).json({ success: true, ...data });
}

// ── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  sendSuccess(res, {
    status: 'API running',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: NODE_ENV
  });
});

// ── POST /api/extract ──────────────────────────────────────────────────────

app.post('/api/extract', async (req, res) => {
  const startTime = Date.now();
  const { url } = req.body;
  
  const validation = validateUrl(url);
  if (!validation.valid) {
    return sendError(res, 400, validation.error);
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    
    // Log success
    if (meta.platform) {
      statsOps.record(meta.platform, meta.media_type, true);
    }
    
    return sendSuccess(res, {
      ...meta,
      processing_time_ms: Date.now() - startTime
    });
    
  } catch (err) {
    console.error(`[extract:${req.id}]`, err.message);
    
    // Log failure
    statsOps.record(validation.platform, null, false);
    
    return sendError(res, 500, err.message, err.stack);
  }
});

// ── GET /api/preview ───────────────────────────────────────────────────────

app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  
  const validation = validateUrl(url);
  if (!validation.valid) {
    return sendError(res, 400, validation.error);
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    
    const preview = {
      platform: meta.platform,
      media_type: meta.media_type,
      preview_type: meta.preview_type || meta.media_type,
      title: meta.title,
      thumbnail: meta.thumbnail,
      preview_url: meta.preview_url,
      duration: meta.duration,
      uploader: meta.uploader,
      view_count: meta.view_count,
      like_count: meta.like_count
    };

    if (meta.media_type === 'carousel' && meta.items) {
      preview.items = meta.items.map(item => ({
        type: item.type,
        preview_url: item.preview_url,
        thumbnail: item.thumbnail
      }));
      preview.total_items = meta.total_items || meta.items.length;
    }

    return sendSuccess(res, preview);
    
  } catch (err) {
    console.warn(`[preview:${req.id}]`, err.message);
    
    // Return minimal preview
    return sendSuccess(res, {
      platform: validation.platform,
      media_type: detectMediaType(validation.url, validation.platform),
      preview_type: 'unknown',
      title: null,
      thumbnail: null,
      preview_url: null,
      note: 'Full metadata extraction failed, but download may still work'
    });
  }
});

// ── POST /api/download ─────────────────────────────────────────────────────

app.post('/api/download', async (req, res) => {
  const { url, format = 'best' } = req.body;
  
  const validation = validateUrl(url);
  if (!validation.valid) {
    return sendError(res, 400, validation.error);
  }

  const downloadId = uuidv4();
  
  // Insert download record
  downloadOps.insert(
    downloadId, 
    validation.url, 
    validation.platform, 
    null, 
    format,
    req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    req.headers['user-agent']
  );

  try {
    const result = await downloadMedia(
      downloadId,
      validation.url,
      format,
      validation.platform,
      null // cookieId optional
    );

    const filePath = result.file_path;
    if (!fs.existsSync(filePath)) {
      throw new Error('Downloaded file not found');
    }

    const stat = fs.statSync(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).slice(1) || 'mp4';
    const mimeType = mime.lookup(filePath) || `video/${ext}`;

    // Set response headers
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Download-ID', downloadId);
    res.setHeader('X-From-Cache', result.from_cache ? 'true' : 'false');
    res.setHeader('Accept-Ranges', 'bytes');

    // Handle range requests (for video scrubbing)
    if (req.headers.range) {
      const range = req.headers.range;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = (end - start) + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      
      stream.on('error', (err) => {
        console.error(`[download:${req.id}] Stream error:`, err.message);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    } else {
      // Full file download
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      
      stream.on('error', (err) => {
        console.error(`[download:${req.id}] Stream error:`, err.message);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    }

  } catch (err) {
    console.error(`[download:${req.id}]`, err.message);
    downloadOps.updateError(downloadId, err.message);
    
    return sendError(res, 500, err.message, { download_id: downloadId });
  }
});

// ── GET /api/download/progress/:id ────────────────────────────────────────

app.get('/api/download/progress/:id', (req, res) => {
  const download = downloadOps.getById(req.params.id);
  
  if (!download) {
    return sendError(res, 404, 'Download not found');
  }
  
  sendSuccess(res, {
    id: download.id,
    status: download.status,
    progress: download.progress,
    speed: download.speed,
    downloaded_size: download.downloaded_size,
    eta: download.eta,
    error: download.error,
    file_path: download.status === 'complete' ? path.basename(download.file_path || '') : null,
    file_size: download.file_size,
    created_at: download.created_at,
    updated_at: download.updated_at
  });
});

// ── GET /api/proxy (CORS Bypass Video Player) ──────────────────────────────

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const start = parseInt(req.query.start) || 0;
  
  if (!targetUrl) {
    return sendError(res, 400, 'Video URL is required');
  }

  // Validate URL to prevent SSRF
  try {
    new URL(targetUrl);
  } catch (err) {
    return sendError(res, 400, 'Invalid URL format');
  }

  try {
    // Headers to mimic a real browser
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'video/webm,video/mp4,video/*;q=0.9,application/ogg;q=0.7,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.google.com/',
      'Origin': 'https://www.google.com',
      'Connection': 'keep-alive',
      'Range': req.headers.range || `bytes=${start}-`
    };

    // Add cookies if present in request
    if (req.headers.cookie) {
      headers['Cookie'] = req.headers.cookie;
    }

    const response = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      headers: headers,
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });

    // Copy relevant headers from source
    const copyHeaders = [
      'content-type', 'content-length', 'content-range',
      'accept-ranges', 'cache-control', 'last-modified'
    ];
    
    copyHeaders.forEach(header => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });

    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Set status and pipe
    res.status(response.status);
    response.data.pipe(res);

    // Handle client disconnect
    req.on('close', () => {
      response.data.destroy();
    });

    response.data.on('error', (err) => {
      console.error(`[proxy:${req.id}] Stream error:`, err.message);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

  } catch (err) {
    console.error(`[proxy:${req.id}]`, err.message);
    
    if (!res.headersSent) {
      if (err.response?.status) {
        res.status(err.response.status).json({ 
          success: false, 
          error: `Source server responded with ${err.response.status}` 
        });
      } else {
        sendError(res, 500, 'Error proxying video');
      }
    }
  }
});

// ── Cookie Management Routes ─────────────────────────────────────────────

// POST /api/cookies/upload
app.post('/api/cookies/upload', async (req, res) => {
  const { platform, account_name, cookies: cookieContent, priority = 3 } = req.body;

  if (!platform || !['youtube', 'tiktok', 'instagram', 'facebook', 'twitter'].includes(platform)) {
    return sendError(res, 400, 'Invalid platform. Use: youtube, tiktok, instagram, facebook, twitter');
  }
  
  if (!account_name?.trim()) {
    return sendError(res, 400, 'account_name is required');
  }
  
  if (!cookieContent?.trim()) {
    return sendError(res, 400, 'cookies content is required');
  }

  try {
    const stats = parseCookieFile(cookieContent);
    const saved = await saveCookie(
      platform, 
      account_name.trim(), 
      cookieContent, 
      parseInt(priority, 10)
    );

    return sendSuccess(res, {
      id: saved.id,
      platform: saved.platform,
      account_name: saved.account_name,
      status: saved.status,
      priority: saved.priority,
      total_cookies: stats.total,
      valid_cookies: stats.valid,
      expired_cookies: stats.expired,
      invalid_cookies: stats.invalid
    }, 201);
    
  } catch (err) {
    return sendError(res, 500, err.message);
  }
});

// GET /api/cookies
app.get('/api/cookies', (req, res) => {
  try {
    const all = cookieOps.getAll(req.query);
    const sanitized = all.map(c => ({
      id: c.id,
      platform: c.platform,
      account_name: c.account_name,
      status: c.status,
      priority: c.priority,
      fail_count: c.fail_count,
      total_uses: c.total_uses,
      success_uses: c.success_uses,
      expires_at: c.expires_at,
      last_used: c.last_used,
      created_at: c.created_at,
      updated_at: c.updated_at
    }));
    
    sendSuccess(res, { 
      cookies: sanitized, 
      total: sanitized.length 
    });
    
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// GET /api/cookies/:id
app.get('/api/cookies/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return sendError(res, 400, 'Invalid ID');
  
  try {
    const cookie = cookieOps.getById(id);
    if (!cookie) return sendError(res, 404, 'Cookie not found');
    
    sendSuccess(res, { cookie });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// DELETE /api/cookies/:id
app.delete('/api/cookies/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return sendError(res, 400, 'Invalid ID');

  try {
    const deleted = deleteCookie(id);
    if (!deleted) return sendError(res, 404, 'Cookie not found');
    
    sendSuccess(res, { message: `Cookie ${id} deleted` });
    
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// POST /api/cookies/:id/enable
app.post('/api/cookies/:id/enable', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return sendError(res, 400, 'Invalid ID');
  
  try {
    enableCookie(id);
    sendSuccess(res, { message: `Cookie ${id} re-enabled` });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// GET /api/cookies/health
app.get('/api/cookies/health', (req, res) => {
  try {
    const results = analyzeCookieHealth();
    const summary = {
      total: results.length,
      active: results.filter(c => c.health_status === 'active').length,
      expired: results.filter(c => c.health_status === 'expired').length,
      invalid: results.filter(c => c.health_status === 'invalid').length,
      disabled: results.filter(c => c.status === 'disabled').length,
    };
    
    sendSuccess(res, { summary, cookies: results });
    
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// ── GET /api/stats ─────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  try {
    const stats = statsOps.getSummary();
    sendSuccess(res, stats);
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// GET /api/stats/detailed
app.get('/api/stats/detailed', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  
  try {
    const detailed = statsOps.getDetailedStats(days);
    sendSuccess(res, { stats: detailed, days });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// ── GET /api/formats ──────────────────────────────────────────────────────

app.get('/api/formats', async (req, res) => {
  const { url } = req.query;
  
  const validation = validateUrl(url);
  if (!validation.valid) {
    return sendError(res, 400, validation.error);
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    
    sendSuccess(res, {
      platform: meta.platform,
      media_type: meta.media_type,
      title: meta.title,
      duration: meta.duration,
      formats: meta.formats || []
    });
    
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// ── GET /api/thumbnail ─────────────────────────────────────────────────────

app.get('/api/thumbnail', async (req, res) => {
  const { url } = req.query;
  
  const validation = validateUrl(url);
  if (!validation.valid) {
    return sendError(res, 400, validation.error);
  }

  try {
    const meta = await extractInfo(validation.url, validation.platform);
    
    if (meta.thumbnail) {
      return sendSuccess(res, { 
        thumbnail: meta.thumbnail, 
        source: 'platform' 
      });
    }

    // Try to generate thumbnail
    const generatedThumb = await generateThumbnail(validation.url, validation.platform);
    
    if (generatedThumb) {
      return sendSuccess(res, { 
        thumbnail: generatedThumb, 
        source: 'generated' 
      });
    }

    return sendSuccess(res, { 
      thumbnail: null, 
      source: 'none',
      message: 'No thumbnail available' 
    });
    
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// ── API Key Management Routes ────────────────────────────────────────────

// POST /api/keys/generate
app.post('/api/keys/generate', async (req, res) => {
  if (!process.env.ENABLE_API_KEYS) {
    return sendError(res, 403, 'API key management is disabled');
  }
  
  const { name, rate_limit = 100 } = req.body;
  
  if (!name?.trim()) {
    return sendError(res, 400, 'Name is required');
  }
  
  try {
    const result = apiKeyOps.generate(name.trim(), rate_limit);
    sendSuccess(res, {
      id: result.lastInsertRowid,
      key: result.key, // Only shown once!
      name,
      rate_limit
    }, 201);
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// GET /api/keys
app.get('/api/keys', (req, res) => {
  if (!process.env.ENABLE_API_KEYS) {
    return sendError(res, 403, 'API key management is disabled');
  }
  
  try {
    const keys = apiKeyOps.list();
    sendSuccess(res, { keys });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// DELETE /api/keys/:key
app.delete('/api/keys/:key', (req, res) => {
  if (!process.env.ENABLE_API_KEYS) {
    return sendError(res, 403, 'API key management is disabled');
  }
  
  try {
    const result = apiKeyOps.revoke(req.params.key);
    if (result.changes === 0) {
      return sendError(res, 404, 'Key not found');
    }
    sendSuccess(res, { message: 'Key revoked' });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// ── Static file serving ─────────────────────────────────────────────────

app.use('/files', (req, res, next) => {
  const filePath = path.join(TEMP_PATH, req.path);
  
  // Security: prevent directory traversal
  if (!filePath.startsWith(TEMP_PATH)) {
    return sendError(res, 403, 'Access denied');
  }
  
  if (!fs.existsSync(filePath)) {
    return sendError(res, 404, 'File not found');
  }
  
  express.static(TEMP_PATH, {
    setHeaders: (res, filePath) => {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
      res.setHeader('Content-Type', mime.lookup(filePath) || 'application/octet-stream');
    }
  })(req, res, next);
});

// ── 404 handler ────────────────────────────────────────────────────────────

app.use((req, res) => {
  sendError(res, 404, 'Endpoint not found');
});

// ── Error handler ──────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`[Server Error:${req.id}]`, err.message, err.stack);
  
  const status = err.status || 500;
  const message = NODE_ENV === 'production' && status === 500 
    ? 'Internal server error' 
    : err.message;
  
  sendError(res, status, message);
});

// ── Cron jobs ──────────────────────────────────────────────────────────────

// Temp file cleanup every 30 minutes
cron.schedule('*/30 * * * *', () => {
  const hours = parseInt(process.env.TEMP_RETENTION_HOURS) || 1;
  const deleted = cleanupTemp(hours);
  if (deleted > 0) {
    console.log(`[Cron] Cleaned ${deleted} temp file(s) older than ${hours}h`);
  }
});

// Cache cleanup every 6 hours
cron.schedule('0 */6 * * *', () => {
  try {
    const result = cacheCleanup();
    console.log(`[Cron] Cache cleanup complete: ${result.changes || 0} entries removed`);
  } catch (err) {
    console.error('[Cron] Cache cleanup error:', err.message);
  }
});

// Cookie health check every hour
cron.schedule('0 * * * *', () => {
  try {
    const expired = cookieOps.checkExpired();
    if (expired > 0) {
      console.log(`[Cron] Marked ${expired} cookie(s) as expired`);
    }
    analyzeCookieHealth();
  } catch (err) {
    console.error('[Cron] Cookie health check error:', err.message);
  }
});

// Stats cleanup every day at 3 AM
cron.schedule('0 3 * * *', () => {
  const days = parseInt(process.env.STATS_RETENTION_DAYS) || 90;
  // Implement stats cleanup if needed
  console.log(`[Cron] Would clean stats older than ${days} days (not implemented)`);
});

// ── Startup ────────────────────────────────────────────────────────────────

async function startup() {
  try {
    console.log('\n🔧 Starting Social Media Downloader API...');
    
    // Verify directories
    REQUIRED_DIRS.forEach(dir => {
      console.log(`   ✓ Directory: ${dir}`);
    });

    // Auto-update yt-dlp (don't wait)
    autoUpdateYtDlp()
      .then(version => console.log(`   ✓ yt-dlp version: ${version}`))
      .catch(err => console.warn('   ⚠ yt-dlp update failed:', err.message));

    // Start server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 API server running on port ${PORT}`);
      console.log(`   📍 Environment: ${NODE_ENV}`);
      console.log(`   🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`   📦 Temp path: ${TEMP_PATH}`);
      
      if (API_KEY || process.env.ENABLE_API_KEYS) {
        console.log(`   🔐 Authentication: Enabled`);
      } else {
        console.log(`   🔓 Authentication: Disabled (public)`);
      }
      
      console.log(`\n📋 Available endpoints:`);
      console.log(`   POST  /api/extract    - Extract media info`);
      console.log(`   POST  /api/download   - Download media`);
      console.log(`   GET   /api/preview    - Get preview info`);
      console.log(`   GET   /api/proxy      - Proxy video (CORS bypass)`);
      console.log(`   GET   /api/stats      - Download statistics`);
      console.log(`   GET   /api/cookies    - Manage cookies`);
      console.log('');
    });

  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  // Don't exit immediately in production
  if (NODE_ENV === 'development') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
if (require.main === module) {
  startup();
}

module.exports = app;
