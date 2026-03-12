'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || '/data/database.sqlite';

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const database = db;

  database.exec(`
    CREATE TABLE IF NOT EXISTS cookies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      cookie_file_path TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 3,
      fail_count INTEGER DEFAULT 0,
      total_uses INTEGER DEFAULT 0,
      success_uses INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      platform TEXT,
      media_type TEXT,
      format TEXT,
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      speed TEXT,
      downloaded_size TEXT,
      eta TEXT,
      file_path TEXT,
      file_size INTEGER,
      error TEXT,
      cookie_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cookie_id) REFERENCES cookies(id)
    );

    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      media_type TEXT,
      success INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cookie_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cookie_id INTEGER,
      platform TEXT,
      action TEXT,
      success INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cookie_id) REFERENCES cookies(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cookies_platform ON cookies(platform, status, priority);
    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON cache(url_hash);
    CREATE INDEX IF NOT EXISTS idx_stats_platform ON stats(platform);
  `);
}

// ── Cookie operations ──────────────────────────────────────────────────────

const cookieOps = {
  insert(platform, accountName, filePath, priority = 3) {
    const database = getDb();
    return database.prepare(`
      INSERT INTO cookies (platform, account_name, cookie_file_path, status, priority)
      VALUES (?, ?, ?, 'active', ?)
    `).run(platform, accountName, filePath, priority);
  },

  getByPlatform(platform) {
    const database = getDb();
    return database.prepare(`
      SELECT * FROM cookies
      WHERE platform = ? AND status = 'active'
      ORDER BY priority ASC, success_uses DESC
    `).all(platform);
  },

  getAll() {
    const database = getDb();
    return database.prepare('SELECT * FROM cookies ORDER BY platform, priority').all();
  },

  getById(id) {
    const database = getDb();
    return database.prepare('SELECT * FROM cookies WHERE id = ?').get(id);
  },

  updateStatus(id, status) {
    const database = getDb();
    return database.prepare(`
      UPDATE cookies SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, id);
  },

  incrementFail(id) {
    const database = getDb();
    const cookie = database.prepare('SELECT fail_count FROM cookies WHERE id = ?').get(id);
    if (!cookie) return;
    const threshold = parseInt(process.env.COOKIE_FAIL_THRESHOLD || '5');
    const newCount = (cookie.fail_count || 0) + 1;
    if (newCount >= threshold) {
      database.prepare(`
        UPDATE cookies SET fail_count = ?, status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(newCount, id);
    } else {
      database.prepare(`
        UPDATE cookies SET fail_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(newCount, id);
    }
  },

  incrementSuccess(id) {
    const database = getDb();
    database.prepare(`
      UPDATE cookies SET fail_count = 0, success_uses = success_uses + 1, total_uses = total_uses + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(id);
  },

  delete(id) {
    const database = getDb();
    return database.prepare('DELETE FROM cookies WHERE id = ?').run(id);
  },

  resetFails(id) {
    const database = getDb();
    return database.prepare(`
      UPDATE cookies SET fail_count = 0, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(id);
  }
};

// ── Download operations ────────────────────────────────────────────────────

const downloadOps = {
  insert(id, url, platform, mediaType, format) {
    const database = getDb();
    return database.prepare(`
      INSERT INTO downloads (id, url, platform, media_type, format, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(id, url, platform, mediaType, format);
  },

  updateProgress(id, progress, speed, downloadedSize, eta) {
    const database = getDb();
    return database.prepare(`
      UPDATE downloads SET progress = ?, speed = ?, downloaded_size = ?, eta = ?,
      status = 'downloading', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(progress, speed, downloadedSize, eta, id);
  },

  updateComplete(id, filePath, fileSize) {
    const database = getDb();
    return database.prepare(`
      UPDATE downloads SET status = 'complete', progress = 100, file_path = ?,
      file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(filePath, fileSize, id);
  },

  updateError(id, error) {
    const database = getDb();
    return database.prepare(`
      UPDATE downloads SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(error, id);
  },

  getById(id) {
    const database = getDb();
    return database.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  }
};

// ── Stats operations ───────────────────────────────────────────────────────

const statsOps = {
  record(platform, mediaType, success = 1) {
    const database = getDb();
    return database.prepare(`
      INSERT INTO stats (platform, media_type, success) VALUES (?, ?, ?)
    `).run(platform, mediaType, success ? 1 : 0);
  },

  getSummary() {
    const database = getDb();
    const total = database.prepare('SELECT COUNT(*) as count FROM stats WHERE success = 1').get();
    const byPlatform = database.prepare(`
      SELECT platform, COUNT(*) as count FROM stats WHERE success = 1 GROUP BY platform
    `).all();

    const result = {
      total_downloads: total.count,
      youtube_downloads: 0,
      instagram_downloads: 0,
      tiktok_downloads: 0,
      facebook_downloads: 0
    };

    for (const row of byPlatform) {
      if (row.platform) {
        result[`${row.platform}_downloads`] = row.count;
      }
    }

    return result;
  }
};

// ── Cache operations ───────────────────────────────────────────────────────

const cacheOps = {
  get(urlHash) {
    const database = getDb();
    return database.prepare(`
      SELECT * FROM cache WHERE url_hash = ? AND expires_at > CURRENT_TIMESTAMP
    `).get(urlHash);
  },

  set(urlHash, url, platform, mediaType, metadata, filePath, format, ttlHours = 24) {
    const database = getDb();
    return database.prepare(`
      INSERT OR REPLACE INTO cache (url_hash, url, platform, media_type, metadata, file_path, format, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
    `).run(urlHash, url, platform, mediaType, JSON.stringify(metadata), filePath, format, ttlHours);
  },

  delete(urlHash) {
    const database = getDb();
    return database.prepare('DELETE FROM cache WHERE url_hash = ?').run(urlHash);
  },

  cleanup() {
    const database = getDb();
    return database.prepare("DELETE FROM cache WHERE expires_at <= CURRENT_TIMESTAMP").run();
  }
};

// ── Cookie log operations ──────────────────────────────────────────────────

const cookieLogOps = {
  log(cookieId, platform, action, success, error = null) {
    const database = getDb();
    return database.prepare(`
      INSERT INTO cookie_logs (cookie_id, platform, action, success, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(cookieId, platform, action, success ? 1 : 0, error);
  }
};

module.exports = {
  getDb,
  cookieOps,
  downloadOps,
  statsOps,
  cacheOps,
  cookieLogOps
};
