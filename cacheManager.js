'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cacheOps } = require('./db');
require('dotenv').config();

const CACHE_PATH = process.env.CACHE_PATH || '/data/cache';
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '24', 10);

if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH, { recursive: true });
}

/**
 * Generate a deterministic hash for a URL + format combo
 */
function makeHash(url, format = '') {
  return crypto.createHash('sha256').update(`${url}|${format}`).digest('hex');
}

/**
 * Get cached metadata for a URL
 * @returns {object|null}
 */
function getMetadataCache(url) {
  const hash = makeHash(url, 'meta');
  const row = cacheOps.get(hash);
  if (!row) return null;

  try {
    return JSON.parse(row.metadata);
  } catch {
    return null;
  }
}

/**
 * Store metadata in cache
 */
function setMetadataCache(url, platform, mediaType, metadata) {
  const hash = makeHash(url, 'meta');
  cacheOps.set(hash, url, platform, mediaType, metadata, null, 'meta', CACHE_TTL_HOURS);
}

/**
 * Get cached file path for a URL + format download
 * Returns path only if file still exists on disk
 */
function getFileCache(url, format) {
  const hash = makeHash(url, format);
  const row = cacheOps.get(hash);
  if (!row || !row.file_path) return null;

  if (!fs.existsSync(row.file_path)) {
    cacheOps.delete(hash);
    return null;
  }

  return row.file_path;
}

/**
 * Store file path in cache
 */
function setFileCache(url, platform, mediaType, format, filePath) {
  const hash = makeHash(url, format);
  cacheOps.set(hash, url, platform, mediaType, {}, filePath, format, CACHE_TTL_HOURS);
}

/**
 * Invalidate all cache entries for a URL
 */
function invalidate(url) {
  const metaHash = makeHash(url, 'meta');
  cacheOps.delete(metaHash);
}

/**
 * Run DB + disk cleanup for expired entries
 */
function cleanup() {
  // Remove expired DB records
  cacheOps.cleanup();

  // Remove orphaned cache files
  try {
    const files = fs.readdirSync(CACHE_PATH);
    for (const file of files) {
      const filePath = path.join(CACHE_PATH, file);
      const stat = fs.statSync(filePath);
      const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
      if (ageHours > CACHE_TTL_HOURS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    console.error('[Cache] Cleanup error:', err.message);
  }
}

module.exports = {
  makeHash,
  getMetadataCache,
  setMetadataCache,
  getFileCache,
  setFileCache,
  invalidate,
  cleanup,
};
