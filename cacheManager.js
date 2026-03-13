// cacheManager.js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { cacheOps } = require('./db');
require('dotenv').config();

const CACHE_PATH = process.env.CACHE_PATH || '/data/cache';
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '24', 10);
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '500', 10); // 500MB default
const MAX_CACHE_FILES = parseInt(process.env.MAX_CACHE_FILES || '1000', 10); // 1000 files default

// Cache statistics
let cacheStats = {
  hits: 0,
  misses: 0,
  size: 0,
  files: 0,
  lastCleanup: null
};

// In-memory cache for hot items (optional, for performance)
const memoryCache = new Map();
const MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Ensure cache directory exists with proper permissions
if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH, { recursive: true, mode: 0o755 });
}

/**
 * Periodic memory cache cleanup
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of memoryCache.entries()) {
    if (now - value.timestamp > MEMORY_CACHE_TTL) {
      memoryCache.delete(key);
    }
  }
}, 60 * 1000);

/**
 * Generate a deterministic hash for a URL + format combo
 */
function makeHash(url, format = '') {
  if (!url) throw new Error('URL is required for hash generation');
  return crypto.createHash('sha256')
    .update(`${url}|${format}|${CACHE_TTL_HOURS}`)
    .digest('hex');
}

/**
 * Get cached metadata for a URL
 * @returns {object|null}
 */
function getMetadataCache(url) {
  if (!url) return null;
  
  const hash = makeHash(url, 'meta');
  
  // Check memory cache first
  const memCached = memoryCache.get(hash);
  if (memCached && Date.now() - memCached.timestamp < MEMORY_CACHE_TTL) {
    cacheStats.hits++;
    return memCached.data;
  }
  
  // Check database cache
  const row = cacheOps.get(hash);
  if (!row) {
    cacheStats.misses++;
    return null;
  }

  try {
    const metadata = JSON.parse(row.metadata);
    
    // Store in memory cache
    memoryCache.set(hash, {
      data: metadata,
      timestamp: Date.now()
    });
    
    cacheStats.hits++;
    return metadata;
  } catch (err) {
    console.warn('[Cache] Failed to parse metadata:', err.message);
    cacheOps.delete(hash);
    cacheStats.misses++;
    return null;
  }
}

/**
 * Store metadata in cache
 */
function setMetadataCache(url, platform, mediaType, metadata) {
  if (!url || !metadata) return;
  
  const hash = makeHash(url, 'meta');
  
  // Store in database
  cacheOps.set(hash, url, platform, mediaType, metadata, null, 'meta', CACHE_TTL_HOURS);
  
  // Store in memory cache
  memoryCache.set(hash, {
    data: metadata,
    timestamp: Date.now()
  });
}

/**
 * Get cached file path for a URL + format download
 * Returns path only if file still exists on disk
 */
function getFileCache(url, format) {
  if (!url || !format) return null;
  
  const hash = makeHash(url, format);
  
  // Check database
  const row = cacheOps.get(hash);
  if (!row || !row.file_path) {
    cacheStats.misses++;
    return null;
  }

  // Check if file exists and is not corrupted
  try {
    if (!fs.existsSync(row.file_path)) {
      cacheOps.delete(hash);
      cacheStats.misses++;
      return null;
    }

    // Check file age
    const stat = fs.statSync(row.file_path);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    
    if (ageHours > CACHE_TTL_HOURS) {
      fs.unlinkSync(row.file_path);
      cacheOps.delete(hash);
      cacheStats.misses++;
      return null;
    }

    // Check if file is corrupted (size too small)
    if (stat.size < 1024) { // Less than 1KB
      fs.unlinkSync(row.file_path);
      cacheOps.delete(hash);
      cacheStats.misses++;
      return null;
    }

    cacheStats.hits++;
    return row.file_path;
  } catch (err) {
    console.warn('[Cache] Failed to access cached file:', err.message);
    cacheOps.delete(hash);
    cacheStats.misses++;
    return null;
  }
}

/**
 * Store file path in cache
 */
async function setFileCache(url, platform, mediaType, format, filePath) {
  if (!url || !format || !filePath) return;
  
  // Check file validity
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist');
    }

    const stat = fs.statSync(filePath);
    
    // Don't cache very large files
    if (stat.size > MAX_CACHE_SIZE_MB * 1024 * 1024) {
      console.log('[Cache] File too large, skipping cache');
      return;
    }

    // Check cache size limit
    const currentSize = await getCacheSize();
    if (currentSize + stat.size > MAX_CACHE_SIZE_MB * 1024 * 1024) {
      await enforceCacheLimits();
    }

    // Check number of files limit
    const fileCount = await getFileCount();
    if (fileCount >= MAX_CACHE_FILES) {
      await enforceCacheLimits();
    }

    const hash = makeHash(url, format);
    const ext = path.extname(filePath);
    const cachedPath = path.join(CACHE_PATH, `${hash}${ext}`);

    // Copy file to cache (don't move, keep original)
    await fsPromises.copyFile(filePath, cachedPath);
    
    // Store in database
    cacheOps.set(hash, url, platform, mediaType, {}, cachedPath, format, CACHE_TTL_HOURS);
    
    console.log(`[Cache] Cached: ${hash}${ext} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.warn('[Cache] Failed to cache file:', err.message);
  }
}

/**
 * Get current cache size in bytes
 */
async function getCacheSize() {
  try {
    const files = await fsPromises.readdir(CACHE_PATH);
    let totalSize = 0;
    
    for (const file of files) {
      if (file === '.gitkeep' || file === 'metadata_cache.json') continue;
      const stat = await fsPromises.stat(path.join(CACHE_PATH, file));
      totalSize += stat.size;
    }
    
    cacheStats.size = totalSize;
    return totalSize;
  } catch (err) {
    console.error('[Cache] Failed to calculate size:', err.message);
    return 0;
  }
}

/**
 * Get number of files in cache
 */
async function getFileCount() {
  try {
    const files = await fsPromises.readdir(CACHE_PATH);
    const count = files.filter(f => f !== '.gitkeep' && f !== 'metadata_cache.json').length;
    cacheStats.files = count;
    return count;
  } catch (err) {
    return 0;
  }
}

/**
 * Enforce cache size and file limits
 */
async function enforceCacheLimits() {
  try {
    const files = await fsPromises.readdir(CACHE_PATH);
    const fileStats = [];
    
    for (const file of files) {
      if (file === '.gitkeep' || file === 'metadata_cache.json') continue;
      const filePath = path.join(CACHE_PATH, file);
      const stat = await fsPromises.stat(filePath);
      fileStats.push({
        path: filePath,
        mtime: stat.mtimeMs,
        size: stat.size,
        name: file
      });
    }

    // Sort by last modified time (oldest first)
    fileStats.sort((a, b) => a.mtime - b.mtime);

    // Calculate total size
    let totalSize = fileStats.reduce((sum, f) => sum + f.size, 0);
    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

    // Delete oldest files until under limits
    let deleted = 0;
    for (const file of fileStats) {
      if (totalSize <= maxSizeBytes && fileStats.length - deleted <= MAX_CACHE_FILES) {
        break;
      }
      
      try {
        await fsPromises.unlink(file.path);
        totalSize -= file.size;
        deleted++;
        
        // Also delete from database
        const hash = path.basename(file.name, path.extname(file.name));
        cacheOps.delete(hash);
      } catch (err) {
        console.warn('[Cache] Failed to delete file during cleanup:', err.message);
      }
    }

    if (deleted > 0) {
      console.log(`[Cache] Cleanup removed ${deleted} files to enforce limits`);
    }
  } catch (err) {
    console.error('[Cache] Failed to enforce limits:', err.message);
  }
}

/**
 * Invalidate all cache entries for a URL
 */
function invalidate(url) {
  if (!url) return;
  
  const metaHash = makeHash(url, 'meta');
  cacheOps.delete(metaHash);
  memoryCache.delete(metaHash);
  
  // Note: We don't delete file caches here as they might still be valid
  // They will expire naturally
}

/**
 * Run DB + disk cleanup for expired entries
 */
async function cleanup() {
  const startTime = Date.now();
  let dbDeleted = 0;
  let fileDeleted = 0;
  
  try {
    // Remove expired DB records
    dbDeleted = cacheOps.cleanup();

    // Remove orphaned and expired cache files
    const files = await fsPromises.readdir(CACHE_PATH);
    const now = Date.now();
    
    for (const file of files) {
      if (file === '.gitkeep' || file === 'metadata_cache.json') continue;
      
      const filePath = path.join(CACHE_PATH, file);
      try {
        const stat = await fsPromises.stat(filePath);
        const ageHours = (now - stat.mtimeMs) / 3600000;
        
        // Check if file is expired
        if (ageHours > CACHE_TTL_HOURS) {
          await fsPromises.unlink(filePath);
          fileDeleted++;
          continue;
        }
        
        // Check if file has corresponding DB entry
        const hash = path.basename(file, path.extname(file));
        const dbEntry = cacheOps.get(hash);
        
        if (!dbEntry) {
          // Orphaned file (no DB record)
          await fsPromises.unlink(filePath);
          fileDeleted++;
        }
      } catch (err) {
        console.warn('[Cache] Failed to process file during cleanup:', err.message);
      }
    }

    // Enforce size limits
    await enforceCacheLimits();
    
    // Update stats
    await getCacheSize();
    await getFileCount();
    cacheStats.lastCleanup = new Date().toISOString();

    const duration = Date.now() - startTime;
    console.log(`[Cache] Cleanup completed in ${duration}ms: ${dbDeleted} DB entries, ${fileDeleted} files removed`);
    
    return { dbDeleted, fileDeleted };
  } catch (err) {
    console.error('[Cache] Cleanup error:', err.message);
    return { dbDeleted: 0, fileDeleted: 0 };
  }
}

/**
 * Get cache statistics
 */
async function getStats() {
  await getCacheSize();
  await getFileCount();
  
  return {
    ...cacheStats,
    path: CACHE_PATH,
    ttl_hours: CACHE_TTL_HOURS,
    max_size_mb: MAX_CACHE_SIZE_MB,
    max_files: MAX_CACHE_FILES,
    size_mb: (cacheStats.size / (1024 * 1024)).toFixed(2),
    hit_rate: cacheStats.hits + cacheStats.misses > 0 
      ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(2) + '%'
      : '0%'
  };
}

/**
 * Clear entire cache (dangerous!)
 */
async function clearAll() {
  try {
    // Clear database
    const files = await fsPromises.readdir(CACHE_PATH);
    
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = path.join(CACHE_PATH, file);
      await fsPromises.unlink(filePath).catch(() => {});
    }
    
    // Clear database
    // Note: You might want to implement a bulk delete in cacheOps
    // For now, we'll rely on individual cleanup
    
    // Clear memory cache
    memoryCache.clear();
    
    // Reset stats
    cacheStats = {
      hits: 0,
      misses: 0,
      size: 0,
      files: 0,
      lastCleanup: new Date().toISOString()
    };
    
    console.log('[Cache] All cache cleared');
    return true;
  } catch (err) {
    console.error('[Cache] Failed to clear cache:', err.message);
    return false;
  }
}

/**
 * Warm up cache with frequently accessed items
 */
async function warmUp(urls) {
  if (!Array.isArray(urls)) return;
  
  console.log(`[Cache] Warming up with ${urls.length} URLs...`);
  let warmed = 0;
  
  for (const url of urls) {
    try {
      const metadata = getMetadataCache(url);
      if (metadata) warmed++;
    } catch (err) {
      // Ignore errors during warm-up
    }
  }
  
  console.log(`[Cache] Warm-up complete: ${warmed}/${urls.length} items in cache`);
  return warmed;
}

module.exports = {
  makeHash,
  getMetadataCache,
  setMetadataCache,
  getFileCache,
  setFileCache,
  invalidate,
  cleanup,
  getStats,
  clearAll,
  warmUp,
  enforceCacheLimits,
  getCacheSize,
  getFileCount
};
