'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cookieOps, cookieLogOps } = require('./db');
require('dotenv').config();

const COOKIE_PATH = process.env.COOKIE_PATH || '/data/cookies';

// Ensure cookie directory exists
if (!fs.existsSync(COOKIE_PATH)) {
  fs.mkdirSync(COOKIE_PATH, { recursive: true });
}

// Round-robin index per platform
const rotationIndex = {};

/**
 * Parse Netscape cookie file content
 * Returns stats: { total, valid, expired, invalid }
 */
function parseCookieFile(content) {
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const now = Math.floor(Date.now() / 1000);

  let valid = 0, expired = 0, invalid = 0;

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) {
      invalid++;
      continue;
    }
    const expiry = parseInt(parts[4], 10);
    if (isNaN(expiry) || expiry === 0) {
      valid++; // session cookie
    } else if (expiry < now) {
      expired++;
    } else {
      valid++;
    }
  }

  return { total: lines.length, valid, expired, invalid };
}

/**
 * Determine cookie status from parse result
 */
function determineCookieStatus(stats) {
  if (stats.valid === 0) return 'invalid';
  if (stats.expired > stats.valid) return 'expired';
  return 'active';
}

/**
 * Save cookie content to file and upsert DB record
 */
async function saveCookie(platform, accountName, cookieContent, priority = 3) {
  const filename = `${platform}_${accountName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.txt`;
  const filePath = path.join(COOKIE_PATH, filename);

  // Write file
  fs.writeFileSync(filePath, cookieContent, 'utf8');

  // Parse stats
  const stats = parseCookieFile(cookieContent);
  const status = determineCookieStatus(stats);

  // Save to DB
  const result = cookieOps.insert(platform, accountName, filePath, priority);

  // Update status based on health
  if (status !== 'active') {
    cookieOps.updateStatus(result.lastInsertRowid, status);
  }

  return {
    id: result.lastInsertRowid,
    platform,
    account_name: accountName,
    cookie_file_path: filePath,
    status,
    stats,
  };
}

/**
 * Get next cookie for platform using round-robin rotation
 * Returns the cookie row or null
 */
function getNextCookie(platform) {
  const cookies = cookieOps.getByPlatform(platform);
  if (!cookies || cookies.length === 0) return null;

  if (!rotationIndex[platform]) rotationIndex[platform] = 0;

  const idx = rotationIndex[platform] % cookies.length;
  rotationIndex[platform] = (idx + 1) % cookies.length;

  return cookies[idx];
}

/**
 * Get ALL active cookies for a platform (for fallback chain)
 * Sorted by priority, then success rate
 */
function getCookiesForPlatform(platform) {
  return cookieOps.getByPlatform(platform);
}

/**
 * Build yt-dlp cookie args for a given cookie file path
 */
function buildCookieArgs(cookieFilePath) {
  if (!cookieFilePath || !fs.existsSync(cookieFilePath)) return [];
  return ['--cookies', cookieFilePath];
}

/**
 * Record cookie success/failure in logs and update DB
 */
function recordCookieResult(cookieId, platform, success, error = null) {
  if (!cookieId) return;
  cookieLogOps.log(cookieId, platform, 'download', success, error);
  if (success) {
    cookieOps.incrementSuccess(cookieId);
  } else {
    cookieOps.incrementFail(cookieId);
  }
}

/**
 * Analyze cookie health for all cookies
 */
function analyzeCookieHealth() {
  const all = cookieOps.getAll();
  const results = [];

  for (const cookie of all) {
    if (!fs.existsSync(cookie.cookie_file_path)) {
      cookieOps.updateStatus(cookie.id, 'invalid');
      results.push({ ...cookie, health_status: 'invalid', reason: 'File not found' });
      continue;
    }

    const content = fs.readFileSync(cookie.cookie_file_path, 'utf8');
    const stats = parseCookieFile(content);
    const newStatus = determineCookieStatus(stats);

    if (newStatus !== cookie.status) {
      cookieOps.updateStatus(cookie.id, newStatus);
    }

    results.push({
      ...cookie,
      health_status: newStatus,
      cookie_stats: stats,
    });
  }

  return results;
}

/**
 * Delete cookie by ID (removes file + DB row)
 */
function deleteCookie(id) {
  const cookie = cookieOps.getById(id);
  if (!cookie) return false;

  if (fs.existsSync(cookie.cookie_file_path)) {
    fs.unlinkSync(cookie.cookie_file_path);
  }

  cookieOps.delete(id);
  return true;
}

/**
 * Re-enable a disabled cookie
 */
function enableCookie(id) {
  cookieOps.resetFails(id);
}

module.exports = {
  saveCookie,
  parseCookieFile,
  getCookiesForPlatform,
  getNextCookie,
  buildCookieArgs,
  recordCookieResult,
  analyzeCookieHealth,
  deleteCookie,
  enableCookie,
};
