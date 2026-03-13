// cookieManager.js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cookieOps, cookieLogOps } = require('./db');
require('dotenv').config();

const COOKIE_PATH = process.env.COOKIE_PATH || '/data/cookies';
const MAX_COOKIE_AGE_DAYS = parseInt(process.env.MAX_COOKIE_AGE_DAYS) || 30; // 30 days default

// Ensure cookie directory exists with proper permissions
if (!fs.existsSync(COOKIE_PATH)) {
  fs.mkdirSync(COOKIE_PATH, { recursive: true, mode: 0o755 });
}

// Round-robin index per platform
const rotationIndex = {};

// Cache for parsed cookies to avoid repeated file reads
const cookieCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Clear expired cache entries
 */
function cleanupCookieCache() {
  const now = Date.now();
  for (const [key, value] of cookieCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cookieCache.delete(key);
    }
  }
}

// Run cache cleanup every minute
setInterval(cleanupCookieCache, 60 * 1000);

/**
 * Parse Netscape cookie file content
 * Returns stats: { total, valid, expired, invalid, session, domains }
 */
function parseCookieFile(content) {
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const now = Math.floor(Date.now() / 1000);

  let valid = 0, expired = 0, invalid = 0, session = 0;
  const domains = new Set();

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) {
      invalid++;
      continue;
    }

    const domain = parts[0];
    const expiry = parseInt(parts[4], 10);
    
    // Add domain to set
    if (domain && !domain.startsWith('#')) {
      domains.add(domain);
    }

    if (isNaN(expiry) || expiry === 0) {
      session++; // session cookie
      valid++;
    } else if (expiry < now) {
      expired++;
    } else {
      valid++;
    }
  }

  return { 
    total: lines.length, 
    valid, 
    expired, 
    invalid, 
    session,
    domains: Array.from(domains),
    unique_domains: domains.size
  };
}

/**
 * Determine cookie status from parse result
 */
function determineCookieStatus(stats) {
  if (stats.valid === 0) return 'invalid';
  if (stats.expired > stats.valid) return 'expired';
  if (stats.valid < 3) return 'weak'; // Few valid cookies
  return 'active';
}

/**
 * Validate cookie content format
 */
function validateCookieContent(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Cookie content must be a string');
  }

  // Check if it's Netscape format
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  
  if (lines.length === 0) {
    throw new Error('Cookie file is empty');
  }

  // Check first valid line format
  const firstLine = lines[0];
  const parts = firstLine.split('\t');
  
  if (parts.length < 7) {
    throw new Error('Invalid cookie format. Must be Netscape format with 7 tab-separated fields');
  }

  return true;
}

/**
 * Save cookie content to file and upsert DB record
 */
async function saveCookie(platform, accountName, cookieContent, priority = 3) {
  // Validate inputs
  if (!platform || !['youtube', 'instagram', 'tiktok', 'facebook', 'twitter'].includes(platform)) {
    throw new Error('Invalid platform');
  }
  
  if (!accountName || typeof accountName !== 'string') {
    throw new Error('Account name is required');
  }

  // Validate cookie content
  validateCookieContent(cookieContent);

  // Sanitize filename
  const safeAccountName = accountName
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 50);
  
  const timestamp = Date.now();
  const filename = `${platform}_${safeAccountName}_${timestamp}.txt`;
  const filePath = path.join(COOKIE_PATH, filename);

  // Parse stats
  const stats = parseCookieFile(cookieContent);
  const status = determineCookieStatus(stats);

  // Write file atomically
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, cookieContent, 'utf8');
  fs.renameSync(tempPath, filePath);

  // Save to DB
  const result = cookieOps.insert(platform, accountName, filePath, priority);

  // Update status based on health
  if (status !== 'active') {
    cookieOps.updateStatus(result.lastInsertRowid, status);
  }

  // Log the action
  await cookieLogOps.log(result.lastInsertRowid, platform, 'save', true);

  // Clear cache for this platform
  clearPlatformCache(platform);

  return {
    id: result.lastInsertRowid,
    platform,
    account_name: accountName,
    cookie_file_path: filePath,
    status,
    priority,
    stats,
    created_at: new Date().toISOString()
  };
}

/**
 * Clear platform cache
 */
function clearPlatformCache(platform) {
  for (const key of cookieCache.keys()) {
    if (key.startsWith(`cookies_${platform}`)) {
      cookieCache.delete(key);
    }
  }
}

/**
 * Get ALL active cookies for a platform (for fallback chain)
 * Sorted by priority, then success rate
 */
function getCookiesForPlatform(platform) {
  const cacheKey = `cookies_${platform}`;
  const cached = cookieCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const cookies = cookieOps.getByPlatform(platform);
  
  // Filter out expired cookies
  const now = Math.floor(Date.now() / 1000);
  const validCookies = cookies.filter(cookie => {
    if (!fs.existsSync(cookie.cookie_file_path)) return false;
    
    try {
      const content = fs.readFileSync(cookie.cookie_file_path, 'utf8');
      const stats = parseCookieFile(content);
      return stats.valid > 0 && stats.expired < stats.valid;
    } catch {
      return false;
    }
  });

  cookieCache.set(cacheKey, {
    data: validCookies,
    timestamp: Date.now()
  });

  return validCookies;
}

/**
 * Get next cookie for platform using round-robin rotation
 * Returns the cookie row or null
 */
function getNextCookie(platform) {
  const cookies = getCookiesForPlatform(platform);
  if (!cookies || cookies.length === 0) return null;

  if (!rotationIndex[platform]) rotationIndex[platform] = 0;

  const idx = rotationIndex[platform] % cookies.length;
  rotationIndex[platform] = (idx + 1) % cookies.length;

  return cookies[idx];
}

/**
 * Build yt-dlp cookie args for a given cookie file path
 */
function buildCookieArgs(cookieFilePath) {
  if (!cookieFilePath || typeof cookieFilePath !== 'string') return [];
  
  try {
    if (fs.existsSync(cookieFilePath)) {
      return ['--cookies', cookieFilePath];
    }
  } catch (err) {
    console.warn('[cookie] Failed to access cookie file:', err.message);
  }
  
  return [];
}

/**
 * Record cookie success/failure in logs and update DB
 */
async function recordCookieResult(cookieId, platform, success, error = null) {
  if (!cookieId) return;
  
  try {
    await cookieLogOps.log(cookieId, platform, 'download', success, error);
    
    if (success) {
      cookieOps.incrementSuccess(cookieId);
    } else {
      cookieOps.incrementFail(cookieId);
    }

    // Clear cache on failure (might need fresh cookies)
    if (!success) {
      clearPlatformCache(platform);
    }
  } catch (err) {
    console.error('[cookie] Failed to record result:', err.message);
  }
}

/**
 * Analyze cookie health for all cookies
 */
function analyzeCookieHealth() {
  const all = cookieOps.getAll();
  const results = [];

  for (const cookie of all) {
    let health_status = cookie.status;
    let stats = null;
    let reason = null;

    try {
      // Check if file exists
      if (!fs.existsSync(cookie.cookie_file_path)) {
        health_status = 'invalid';
        reason = 'File not found';
        cookieOps.updateStatus(cookie.id, 'invalid');
      } else {
        // Read and parse cookie file
        const content = fs.readFileSync(cookie.cookie_file_path, 'utf8');
        stats = parseCookieFile(content);
        
        // Check file age
        const fileStat = fs.statSync(cookie.cookie_file_path);
        const ageDays = (Date.now() - fileStat.mtimeMs) / (24 * 60 * 60 * 1000);
        
        if (ageDays > MAX_COOKIE_AGE_DAYS) {
          health_status = 'expired';
          reason = `Cookie file older than ${MAX_COOKIE_AGE_DAYS} days`;
        } else {
          health_status = determineCookieStatus(stats);
        }

        // Update status if changed
        if (health_status !== cookie.status) {
          cookieOps.updateStatus(cookie.id, health_status);
        }
      }
    } catch (err) {
      health_status = 'error';
      reason = err.message;
    }

    results.push({
      id: cookie.id,
      platform: cookie.platform,
      account_name: cookie.account_name,
      status: cookie.status,
      health_status,
      priority: cookie.priority,
      fail_count: cookie.fail_count,
      total_uses: cookie.total_uses,
      success_uses: cookie.success_uses,
      last_used: cookie.last_used,
      created_at: cookie.created_at,
      updated_at: cookie.updated_at,
      cookie_stats: stats,
      health_reason: reason,
      file_exists: fs.existsSync(cookie.cookie_file_path),
      file_path: cookie.cookie_file_path
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

  try {
    // Delete file if exists
    if (fs.existsSync(cookie.cookie_file_path)) {
      fs.unlinkSync(cookie.cookie_file_path);
    }

    // Delete from DB
    cookieOps.delete(id);
    
    // Clear cache
    clearPlatformCache(cookie.platform);
    
    return true;
  } catch (err) {
    console.error('[cookie] Failed to delete cookie:', err.message);
    return false;
  }
}

/**
 * Re-enable a disabled cookie
 */
function enableCookie(id) {
  const cookie = cookieOps.getById(id);
  if (!cookie) return false;

  try {
    cookieOps.resetFails(id);
    cookieOps.updateStatus(id, 'active');
    
    // Clear cache
    clearPlatformCache(cookie.platform);
    
    return true;
  } catch (err) {
    console.error('[cookie] Failed to enable cookie:', err.message);
    return false;
  }
}

/**
 * Get cookie statistics
 */
function getCookieStats() {
  const all = cookieOps.getAll();
  
  const stats = {
    total: all.length,
    by_platform: {},
    by_status: {},
    active: 0,
    expired: 0,
    invalid: 0,
    disabled: 0,
    total_uses: 0,
    success_rate: 0
  };

  let totalSuccess = 0;
  let totalAttempts = 0;

  for (const cookie of all) {
    // Count by platform
    stats.by_platform[cookie.platform] = (stats.by_platform[cookie.platform] || 0) + 1;
    
    // Count by status
    stats.by_status[cookie.status] = (stats.by_status[cookie.status] || 0) + 1;
    
    // Count specific status
    if (cookie.status === 'active') stats.active++;
    else if (cookie.status === 'expired') stats.expired++;
    else if (cookie.status === 'invalid') stats.invalid++;
    else if (cookie.status === 'disabled') stats.disabled++;

    // Calculate success rate
    stats.total_uses += cookie.total_uses || 0;
    totalSuccess += cookie.success_uses || 0;
    totalAttempts += cookie.total_uses || 0;
  }

  stats.success_rate = totalAttempts > 0 
    ? Math.round((totalSuccess / totalAttempts) * 100) 
    : 0;

  return stats;
}

/**
 * Refresh all cookies health
 */
function refreshAllCookies() {
  const results = analyzeCookieHealth();
  cookieCache.clear(); // Clear entire cache
  return results;
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
  getCookieStats,
  refreshAllCookies,
  validateCookieContent,
  determineCookieStatus
};
