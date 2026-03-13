'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'database.sqlite');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
}

let db;

function getDb() {
  if (!db) {
    try {
      db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
      initSchema();
      
      // Run cleanup on startup
      cacheOps.cleanup();
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }
  return db;
}

function initSchema() {
  const database = db;

  // Enable foreign key constraints
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS cookies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      cookie_file_path TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'expired')),
      priority INTEGER DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
      fail_count INTEGER DEFAULT 0,
      total_uses INTEGER DEFAULT 0,
      success_uses INTEGER DEFAULT 0,
      last_used DATETIME,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      platform TEXT,
      media_type TEXT,
      format TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'complete', 'error', 'cancelled')),
      progress INTEGER DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      speed TEXT,
      downloaded_size TEXT,
      eta TEXT,
      file_path TEXT,
      file_size INTEGER,
      error TEXT,
      cookie_id INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (cookie_id) REFERENCES cookies(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      media_type TEXT,
      success INTEGER DEFAULT 1,
      download_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_hash TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      platform TEXT,
      media_type TEXT,
      metadata TEXT,
      file_path TEXT,
      format TEXT,
      hits INTEGER DEFAULT 0,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cookie_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cookie_id INTEGER,
      platform TEXT,
      action TEXT NOT NULL,
      success INTEGER DEFAULT 1,
      error TEXT,
      response_time INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cookie_id) REFERENCES cookies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      requests INTEGER DEFAULT 1,
      window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ip_address, endpoint, window_start)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      rate_limit INTEGER DEFAULT 100,
      requests_today INTEGER DEFAULT 0,
      last_reset DATE DEFAULT CURRENT_DATE,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_cookies_platform ON cookies(platform, status, priority);
    CREATE INDEX IF NOT EXISTS idx_cookies_status ON cookies(status);
    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
    CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at);
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON cache(url_hash);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_stats_platform ON stats(platform, created_at);
    CREATE INDEX IF NOT EXISTS idx_cookie_logs_cookie ON cookie_logs(cookie_id);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON rate_limits(ip_address, window_start);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
  `);

  // Create triggers for automatic updated_at
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS update_cookies_timestamp 
    AFTER UPDATE ON cookies
    BEGIN
      UPDATE cookies SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS update_downloads_timestamp 
    AFTER UPDATE ON downloads
    BEGIN
      UPDATE downloads SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS update_cache_timestamp 
    AFTER UPDATE ON cache
    BEGIN
      UPDATE cache SET last_accessed = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS update_downloads_completed 
    AFTER UPDATE OF status ON downloads
    WHEN NEW.status = 'complete' AND OLD.status != 'complete'
    BEGIN
      UPDATE downloads SET completed_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);
}

// ── Utility functions ──────────────────────────────────────────────────────

function generateHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function validatePlatform(platform) {
  const validPlatforms = ['youtube', 'instagram', 'tiktok', 'facebook', 'twitter', 'pinterest'];
  return validPlatforms.includes(platform?.toLowerCase());
}

// ── Cookie operations ──────────────────────────────────────────────────────

const cookieOps = {
  insert(platform, accountName, filePath, priority = 3, expiresAt = null) {
    const database = getDb();
    
    if (!validatePlatform(platform)) {
      throw new Error('Invalid platform');
    }
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error('Cookie file does not exist');
    }
    
    const stmt = database.prepare(`
      INSERT INTO cookies (platform, account_name, cookie_file_path, status, priority, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `);
    
    const result = stmt.run(platform, accountName, filePath, priority, expiresAt);
    
    cookieLogOps.log(result.lastInsertRowid, platform, 'insert', true);
    return result;
  },

  getByPlatform(platform, limit = 10) {
    const database = getDb();
    
    if (!validatePlatform(platform)) {
      return [];
    }
    
    const stmt = database.prepare(`
      SELECT * FROM cookies
      WHERE platform = ? AND status = 'active' 
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      ORDER BY priority ASC, success_uses DESC, total_uses ASC
      LIMIT ?
    `);
    
    return stmt.all(platform.toLowerCase(), limit);
  },

  getAll(filters = {}) {
    const database = getDb();
    let query = 'SELECT * FROM cookies WHERE 1=1';
    const params = [];
    
    if (filters.platform) {
      query += ' AND platform = ?';
      params.push(filters.platform.toLowerCase());
    }
    
    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    
    query += ' ORDER BY platform, priority, success_uses DESC';
    
    return database.prepare(query).all(...params);
  },

  getById(id) {
    const database = getDb();
    return database.prepare('SELECT * FROM cookies WHERE id = ?').get(id);
  },

  updateStatus(id, status) {
    const database = getDb();
    const validStatuses = ['active', 'disabled', 'expired'];
    
    if (!validStatuses.includes(status)) {
      throw new Error('Invalid status');
    }
    
    const stmt = database.prepare(`
      UPDATE cookies SET status = ? WHERE id = ?
    `);
    
    const result = stmt.run(status, id);
    cookieLogOps.log(id, null, 'status_update', true, null, status);
    return result;
  },

  incrementFail(id, error = null) {
    const database = getDb();
    const cookie = database.prepare('SELECT fail_count, status FROM cookies WHERE id = ?').get(id);
    
    if (!cookie) return null;
    
    const threshold = parseInt(process.env.COOKIE_FAIL_THRESHOLD || '5');
    const newCount = (cookie.fail_count || 0) + 1;
    
    const stmt = database.prepare(`
      UPDATE cookies SET 
        fail_count = ?,
        status = CASE WHEN ? >= ? THEN 'disabled' ELSE status END,
        total_uses = total_uses + 1
      WHERE id = ?
    `);
    
    const result = stmt.run(newCount, newCount, threshold, id);
    cookieLogOps.log(id, null, 'fail', false, error);
    return result;
  },

  incrementSuccess(id) {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE cookies SET 
        fail_count = 0, 
        success_uses = success_uses + 1, 
        total_uses = total_uses + 1,
        last_used = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    
    const result = stmt.run(id);
    cookieLogOps.log(id, null, 'success', true);
    return result;
  },

  delete(id) {
    const database = getDb();
    
    // Get cookie info before deletion
    const cookie = database.prepare('SELECT cookie_file_path FROM cookies WHERE id = ?').get(id);
    
    // Delete from database
    const result = database.prepare('DELETE FROM cookies WHERE id = ?').run(id);
    
    // Optionally delete cookie file
    if (cookie && process.env.DELETE_COOKIE_FILES === 'true') {
      try {
        fs.unlinkSync(cookie.cookie_file_path);
      } catch (err) {
        console.warn('Failed to delete cookie file:', err.message);
      }
    }
    
    cookieLogOps.log(id, null, 'delete', true);
    return result;
  },

  resetFails(id) {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE cookies SET 
        fail_count = 0, 
        status = 'active',
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    
    const result = stmt.run(id);
    cookieLogOps.log(id, null, 'reset', true);
    return result;
  },

  checkExpired() {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE cookies SET status = 'expired' 
      WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP AND status = 'active'
    `);
    
    const result = stmt.run();
    return result.changes;
  }
};

// ── Download operations ────────────────────────────────────────────────────

const downloadOps = {
  insert(id, url, platform, mediaType, format, ipAddress = null, userAgent = null) {
    const database = getDb();
    
    const stmt = database.prepare(`
      INSERT INTO downloads (id, url, platform, media_type, format, status, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    
    return stmt.run(id, url, platform?.toLowerCase(), mediaType, format, ipAddress, userAgent);
  },

  updateProgress(id, progress, speed, downloadedSize, eta) {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE downloads SET 
        progress = ?, 
        speed = ?, 
        downloaded_size = ?,
        eta = ?,
        status = CASE WHEN ? >= 100 THEN 'complete' ELSE 'downloading' END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    
    return stmt.run(progress, speed, downloadedSize, eta, progress, id);
  },

  updateComplete(id, filePath, fileSize) {
    const database = getDb();
    
    const tx = database.transaction(() => {
      const stmt = database.prepare(`
        UPDATE downloads SET 
          status = 'complete', 
          progress = 100, 
          file_path = ?,
          file_size = ?,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(filePath, fileSize, id);
      
      // Record stats
      const download = database.prepare('SELECT platform, media_type FROM downloads WHERE id = ?').get(id);
      if (download) {
        statsOps.record(download.platform, download.media_type, true, id);
      }
      
      return result;
    });
    
    return tx();
  },

  updateError(id, error) {
    const database = getDb();
    
    const tx = database.transaction(() => {
      const stmt = database.prepare(`
        UPDATE downloads SET 
          status = 'error', 
          error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(error, id);
      
      // Record failed stats
      const download = database.prepare('SELECT platform, media_type FROM downloads WHERE id = ?').get(id);
      if (download) {
        statsOps.record(download.platform, download.media_type, false, id);
      }
      
      return result;
    });
    
    return tx();
  },

  updateCancelled(id) {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE downloads SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    return stmt.run(id);
  },

  getById(id) {
    const database = getDb();
    return database.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  },

  getActiveDownloads(limit = 10) {
    const database = getDb();
    return database.prepare(`
      SELECT * FROM downloads 
      WHERE status IN ('pending', 'downloading')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  },

  cleanupOldDownloads(days = 7) {
    const database = getDb();
    const stmt = database.prepare(`
      DELETE FROM downloads 
      WHERE status IN ('complete', 'error', 'cancelled') 
        AND created_at < datetime('now', '-' || ? || ' days')
    `);
    return stmt.run(days);
  }
};

// ── Stats operations ───────────────────────────────────────────────────────

const statsOps = {
  record(platform, mediaType, success = true, downloadId = null) {
    const database = getDb();
    const stmt = database.prepare(`
      INSERT INTO stats (platform, media_type, success, download_id) 
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(platform?.toLowerCase(), mediaType, success ? 1 : 0, downloadId);
  },

  getSummary() {
    const database = getDb();
    
    const total = database.prepare(`
      SELECT COUNT(*) as count FROM stats WHERE success = 1
    `).get();
    
    const byPlatform = database.prepare(`
      SELECT platform, COUNT(*) as count 
      FROM stats 
      WHERE success = 1 AND platform IS NOT NULL
      GROUP BY platform
    `).all();
    
    const today = database.prepare(`
      SELECT COUNT(*) as count FROM stats 
      WHERE success = 1 AND date(created_at) = date('now')
    `).get();
    
    const successRate = database.prepare(`
      SELECT 
        ROUND(100.0 * SUM(success) / COUNT(*), 2) as rate
      FROM stats 
      WHERE created_at > datetime('now', '-7 days')
    `).get();

    const result = {
      total_downloads: total.count || 0,
      today_downloads: today.count || 0,
      success_rate: successRate?.rate || 0,
      youtube_downloads: 0,
      instagram_downloads: 0,
      tiktok_downloads: 0,
      facebook_downloads: 0,
      twitter_downloads: 0,
      pinterest_downloads: 0
    };

    for (const row of byPlatform) {
      if (row.platform) {
        const key = `${row.platform}_downloads`;
        if (key in result) {
          result[key] = row.count;
        }
      }
    }

    return result;
  },

  getDetailedStats(days = 30) {
    const database = getDb();
    return database.prepare(`
      SELECT 
        date(created_at) as date,
        platform,
        COUNT(*) as total,
        SUM(success) as successful,
        COUNT(*) - SUM(success) as failed
      FROM stats 
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at), platform
      ORDER BY date DESC, platform
    `).all(days);
  }
};

// ── Cache operations ───────────────────────────────────────────────────────

const cacheOps = {
  get(url) {
    const urlHash = generateHash(url);
    const database = getDb();
    
    const stmt = database.prepare(`
      SELECT * FROM cache 
      WHERE url_hash = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `);
    
    const result = stmt.get(urlHash);
    
    if (result) {
      // Update hit count
      database.prepare(`
        UPDATE cache SET hits = hits + 1, last_accessed = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(result.id);
      
      // Parse metadata if exists
      if (result.metadata) {
        try {
          result.metadata = JSON.parse(result.metadata);
        } catch (e) {
          // Ignore parse error
        }
      }
    }
    
    return result;
  },

  set(url, platform, mediaType, metadata, filePath, format, ttlHours = 24) {
    const urlHash = generateHash(url);
    const database = getDb();
    
    const expiresAt = ttlHours ? `datetime('now', '+' || ? || ' hours')` : null;
    
    const stmt = database.prepare(`
      INSERT OR REPLACE INTO cache (url_hash, url, platform, media_type, metadata, file_path, format, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${expiresAt || 'NULL'})
    `);
    
    const params = [
      urlHash, 
      url, 
      platform?.toLowerCase(), 
      mediaType, 
      JSON.stringify(metadata), 
      filePath, 
      format
    ];
    
    if (ttlHours) {
      params.push(ttlHours);
    }
    
    return stmt.run(...params);
  },

  delete(url) {
    const urlHash = generateHash(url);
    const database = getDb();
    return database.prepare('DELETE FROM cache WHERE url_hash = ?').run(urlHash);
  },

  cleanup(olderThanHours = 24) {
    const database = getDb();
    return database.prepare(`
      DELETE FROM cache 
      WHERE expires_at <= CURRENT_TIMESTAMP 
         OR (expires_at IS NULL AND created_at < datetime('now', '-' || ? || ' hours'))
    `).run(olderThanHours);
  },

  getStats() {
    const database = getDb();
    return database.prepare(`
      SELECT 
        COUNT(*) as total_entries,
        SUM(hits) as total_hits,
        AVG(hits) as avg_hits,
        COUNT(CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 1 END) as expired
      FROM cache
    `).get();
  }
};

// ── Cookie log operations ──────────────────────────────────────────────────

const cookieLogOps = {
  log(cookieId, platform, action, success = true, error = null, metadata = null) {
    const database = getDb();
    const stmt = database.prepare(`
      INSERT INTO cookie_logs (cookie_id, platform, action, success, error, response_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const responseTime = metadata?.responseTime || null;
    
    return stmt.run(
      cookieId, 
      platform?.toLowerCase(), 
      action, 
      success ? 1 : 0, 
      error?.substring(0, 500), // Truncate long errors
      responseTime
    );
  },

  getByCookieId(cookieId, limit = 50) {
    const database = getDb();
    return database.prepare(`
      SELECT * FROM cookie_logs 
      WHERE cookie_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(cookieId, limit);
  },

  getStats(platform = null, days = 7) {
    const database = getDb();
    let query = `
      SELECT 
        platform,
        COUNT(*) as total,
        SUM(success) as successful,
        ROUND(100.0 * SUM(success) / COUNT(*), 2) as success_rate,
        AVG(response_time) as avg_response_time
      FROM cookie_logs 
      WHERE created_at > datetime('now', '-' || ? || ' days')
    `;
    
    const params = [days];
    
    if (platform) {
      query += ' AND platform = ?';
      params.push(platform.toLowerCase());
    }
    
    query += ' GROUP BY platform';
    
    return database.prepare(query).all(...params);
  }
};

// ── Rate limit operations ──────────────────────────────────────────────────

const rateLimitOps = {
  check(ipAddress, endpoint, maxRequests = 60, windowMinutes = 1) {
    const database = getDb();
    
    // Clean old entries
    database.prepare(`
      DELETE FROM rate_limits 
      WHERE window_start < datetime('now', '-' || ? || ' minutes')
    `).run(windowMinutes);
    
    // Get or create window
    const window = database.prepare(`
      INSERT OR IGNORE INTO rate_limits (ip_address, endpoint, window_start)
      VALUES (?, ?, datetime('now', 'start of minute'))
    `).run(ipAddress, endpoint);
    
    // Increment counter
    const result = database.prepare(`
      UPDATE rate_limits 
      SET requests = requests + 1 
      WHERE ip_address = ? AND endpoint = ? 
        AND window_start = datetime('now', 'start of minute')
      RETURNING requests
    `).get(ipAddress, endpoint);
    
    return {
      allowed: result.requests <= maxRequests,
      current: result.requests,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - result.requests)
    };
  },

  reset(ipAddress = null) {
    const database = getDb();
    if (ipAddress) {
      return database.prepare('DELETE FROM rate_limits WHERE ip_address = ?').run(ipAddress);
    } else {
      return database.prepare('DELETE FROM rate_limits').run();
    }
  }
};

// ── API Key operations ─────────────────────────────────────────────────────

const apiKeyOps = {
  generate(name, rateLimit = 100) {
    const database = getDb();
    const key = crypto.randomBytes(32).toString('hex');
    
    const stmt = database.prepare(`
      INSERT INTO api_keys (key, name, rate_limit) VALUES (?, ?, ?)
    `);
    
    return stmt.run(key, name, rateLimit);
  },

  validate(key) {
    const database = getDb();
    
    // Reset daily counters if needed
    database.prepare(`
      UPDATE api_keys 
      SET requests_today = 0 
      WHERE last_reset < CURRENT_DATE
    `).run();
    
    const apiKey = database.prepare(`
      SELECT * FROM api_keys 
      WHERE key = ? AND active = 1
    `).get(key);
    
    if (!apiKey) return null;
    
    // Check rate limit
    if (apiKey.requests_today >= apiKey.rate_limit) {
      return { valid: false, reason: 'Rate limit exceeded' };
    }
    
    // Increment counter
    database.prepare(`
      UPDATE api_keys 
      SET requests_today = requests_today + 1,
          last_reset = CURRENT_DATE
      WHERE id = ?
    `).run(apiKey.id);
    
    return { valid: true, key: apiKey };
  },

  revoke(key) {
    const database = getDb();
    return database.prepare('UPDATE api_keys SET active = 0 WHERE key = ?').run(key);
  },

  list() {
    const database = getDb();
    return database.prepare(`
      SELECT id, name, rate_limit, requests_today, active, created_at 
      FROM api_keys 
      ORDER BY created_at DESC
    `).all();
  }
};

module.exports = {
  getDb,
  cookieOps,
  downloadOps,
  statsOps,
  cacheOps,
  cookieLogOps,
  rateLimitOps,
  apiKeyOps,
  
  // Utility exports
  generateHash,
  validatePlatform
};
