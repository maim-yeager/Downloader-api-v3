// downloader.js
'use strict';

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
require('dotenv').config();

const { detectPlatform, detectMediaType, extractorToPlatform } = require('./platformDetector');
const { getCookiesForPlatform, buildCookieArgs, recordCookieResult } = require('./cookieManager');
const { getMetadataCache, setMetadataCache, getFileCache, setFileCache } = require('./cacheManager');
const { downloadOps, statsOps } = require('./db');

const TEMP_PATH = process.env.TEMP_PATH || path.join(os.tmpdir(), 'social-downloader');
const CACHE_PATH = process.env.CACHE_PATH || '/data/cache';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 1024 * 1024 * 1024; // 1GB default

// Ensure directories exist
for (const dir of [TEMP_PATH, CACHE_PATH]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}

// ── User-Agent pool for bypass ─────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Android 13; Mobile; rv:122.0) Gecko/122.0 Firefox/122.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Format quality map ─────────────────────────────────────────────────────
const FORMAT_SELECTORS = {
  best:    'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
  '4k':    'bestvideo[height>=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height>=2160]+bestaudio/best',
  '2k':    'bestvideo[height>=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height>=1440]+bestaudio/best',
  '1080p': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720p':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480p':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
  '360p':  'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]',
  'mp3':   'bestaudio[ext=m4a]/bestaudio/best',
  'audio': 'bestaudio[ext=m4a]/bestaudio/best',
  'worst': 'worstvideo+worstaudio/worst',
};

// ── Base yt-dlp args ───────────────────────────────────────────────────────
function baseArgs(extraUA = true) {
  const args = [
    '--no-playlist',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '5',
    '--concurrent-fragments', '4',
    '--no-warnings',
    '--no-call-home',
    '--no-check-certificate',
  ];
  if (extraUA) args.push('--user-agent', randomUA());
  return args;
}

// ── Parse yt-dlp JSON info ─────────────────────────────────────────────────

function parseFormats(info) {
  const formats = info.formats || [];

  // Filter out unwanted formats
  const validFormats = formats.filter(f => 
    f.protocol !== 'm3u8' || f.protocol !== 'm3u8_native' // Skip HLS streams
  );

  const seen = new Set();
  const result = [];

  // Best quality first
  const ordered = [
    { label: 'Best Quality', selector: 'best', type: 'video' },
    { label: '4K',    height: 2160, type: 'video' },
    { label: '2K',    height: 1440, type: 'video' },
    { label: '1080p', height: 1080, type: 'video' },
    { label: '720p',  height: 720, type: 'video' },
    { label: '480p',  height: 480, type: 'video' },
    { label: '360p',  height: 360, type: 'video' },
    { label: '240p',  height: 240, type: 'video' },
    { label: '144p',  height: 144, type: 'video' },
  ];

  // Add video formats
  for (const q of ordered) {
    if (q.selector === 'best') {
      const best = validFormats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      
      if (best && !seen.has('best')) {
        seen.add('best');
        result.push({
          format_id: best.format_id || 'best',
          format: 'Best Quality',
          resolution: best.height ? `${best.height}p` : 'N/A',
          fps: best.fps || null,
          ext: best.ext || 'mp4',
          type: 'video',
          size: formatBytes(best.filesize || best.filesize_approx),
          size_bytes: best.filesize || best.filesize_approx || 0,
          tbr: best.tbr || null,
          has_audio: true,
          has_video: true,
          url: best.url || null,
        });
      }
      continue;
    }

    // Find formats for specific resolution
    const matches = validFormats
      .filter(f => f.vcodec !== 'none' && f.height && f.height <= q.height && f.height > (q.height - 200) && f.url)
      .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));

    const match = matches[0];
    const audioMatch = validFormats.find(f => f.acodec !== 'none' && f.vcodec === 'none' && f.url);

    if (match && !seen.has(q.label)) {
      seen.add(q.label);
      result.push({
        format_id: match.format_id || q.label.toLowerCase(),
        format: q.label,
        resolution: `${match.height}p`,
        fps: match.fps || null,
        ext: match.ext || 'mp4',
        type: 'video',
        size: formatBytes(match.filesize || match.filesize_approx),
        size_bytes: match.filesize || match.filesize_approx || 0,
        tbr: match.tbr || null,
        has_audio: !!audioMatch,
        has_video: true,
        url: match.url || null,
      });
    }
  }

  // Add audio formats
  const audioFormats = validFormats
    .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url)
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));

  if (audioFormats.length > 0) {
    const bestAudio = audioFormats[0];
    result.push({
      format_id: bestAudio.format_id || 'audio',
      format: 'Audio',
      resolution: 'audio only',
      fps: null,
      ext: 'mp3',
      type: 'audio',
      size: formatBytes(bestAudio.filesize || bestAudio.filesize_approx),
      size_bytes: bestAudio.filesize || bestAudio.filesize_approx || 0,
      tbr: bestAudio.tbr || null,
      has_audio: true,
      has_video: false,
      url: bestAudio.url || null,
    });

    // Add MP3 as separate if available
    if (bestAudio.tbr > 64) {
      result.push({
        format_id: 'mp3',
        format: 'MP3',
        resolution: 'audio only',
        fps: null,
        ext: 'mp3',
        type: 'audio',
        size: formatBytes(bestAudio.filesize || bestAudio.filesize_approx),
        size_bytes: bestAudio.filesize || bestAudio.filesize_approx || 0,
        tbr: bestAudio.tbr || null,
        has_audio: true,
        has_video: false,
        url: bestAudio.url || null,
      });
    }
  }

  return result;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return 'Unknown';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function buildMetadata(info, platform) {
  const detectedPlatform = platform || extractorToPlatform(info.extractor_key || info.extractor);

  // Detect media type
  let mediaType = 'video';
  let items = null;

  if (info._type === 'playlist' || (info.entries && info.entries.length > 0)) {
    mediaType = 'carousel';
    items = (info.entries || []).map(e => ({
      type: e.formats && e.formats.some(f => f.vcodec !== 'none') ? 'video' : 'image',
      preview_url: e.thumbnail || null,
      download_url: e.url || e.webpage_url || null,
      title: e.title || null,
      duration: e.duration || null,
    }));
  } else if (info.is_live) {
    mediaType = 'live';
  } else if (!info.formats || info.formats.every(f => f.vcodec === 'none')) {
    mediaType = 'photo';
  }

  const formats = mediaType !== 'carousel' ? parseFormats(info) : [];

  return {
    platform: detectedPlatform,
    media_type: mediaType,
    title: info.title || info.fulltitle || 'Unknown',
    description: info.description || info.caption || null,
    duration: info.duration || null,
    duration_str: info.duration_string || null,
    uploader: info.uploader || info.channel || info.creator || null,
    upload_date: info.upload_date || null,
    view_count: info.view_count || null,
    like_count: info.like_count || null,
    comment_count: info.comment_count || null,
    thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[info.thumbnails.length - 1]?.url) || null,
    preview_url: info.url || info.manifest_url || null,
    preview_type: mediaType === 'carousel' ? 'carousel' : (mediaType === 'photo' ? 'image' : 'video'),
    total_items: items ? items.length : null,
    items,
    formats,
    webpage_url: info.webpage_url || null,
    extractor: info.extractor_key || info.extractor || null,
    timestamp: info.timestamp || null,
  };
}

// ── Run yt-dlp with cookie fallback ────────────────────────────────────────

async function runYtDlpWithFallback(url, args, platform) {
  const cookies = getCookiesForPlatform(platform);

  // Try without cookies first for public content
  const attempts = [null, ...cookies];

  let lastError = null;

  for (const cookie of attempts) {
    const cookieArgs = cookie ? buildCookieArgs(cookie.cookie_file_path) : [];
    const fullArgs = [...args, ...cookieArgs, '--user-agent', randomUA()];

    try {
      const result = await execFileAsync(YTDLP_PATH, fullArgs, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120000,
        killSignal: 'SIGKILL',
      });

      if (cookie) {
        await recordCookieResult(cookie.id, platform, true);
      }

      return result;
    } catch (err) {
      lastError = err;
      if (cookie) {
        await recordCookieResult(cookie.id, platform, false, err.message);
      }

      // Don't retry on non-auth errors
      const msg = (err.stderr || err.message || '').toLowerCase();
      if (!msg.includes('login') && !msg.includes('auth') && !msg.includes('private') &&
          !msg.includes('cookie') && !msg.includes('403') && !msg.includes('sign in') &&
          !msg.includes('member') && !msg.includes('unavailable')) {
        throw err;
      }
    }
  }

  throw lastError || new Error('All download attempts failed');
}

// ── Extract media info ─────────────────────────────────────────────────────

async function extractInfo(url, platform = null) {
  // Check metadata cache
  const cached = getMetadataCache(url);
  if (cached) return cached;

  const args = [
    ...baseArgs(false),
    '--dump-json',
    '--no-download',
    '--flat-playlist',
    '--ignore-errors',
    url,
  ];

  try {
    const { stdout } = await runYtDlpWithFallback(url, args, platform);

    // yt-dlp may output multiple JSON lines for playlists
    const lines = stdout.trim().split('\n').filter(Boolean);
    let info;

    if (lines.length > 1) {
      // Carousel / playlist — build aggregate
      const entries = lines.map(l => { 
        try { return JSON.parse(l); } 
        catch { return null; } 
      }).filter(Boolean);
      
      info = {
        _type: 'playlist',
        title: entries[0]?.title || 'Carousel',
        entries,
        thumbnail: entries[0]?.thumbnail || null,
        extractor_key: entries[0]?.extractor_key || null,
        extractor: entries[0]?.extractor || null,
      };
    } else {
      info = JSON.parse(lines[0]);
    }

    const meta = buildMetadata(info, platform);

    // Cache it (24 hours)
    setMetadataCache(url, meta.platform, meta.media_type, meta, 24);

    return meta;

  } catch (error) {
    console.error('[extractInfo]', error.message);
    throw new Error(`Failed to extract info: ${error.message}`);
  }
}

// ── Download progress tracking ─────────────────────────────────────────────

function parseProgress(line) {
  // Example: [download]  42.3% of 85.50MiB at 2.50MiB/s ETA 00:28
  const match = line.match(
    /\[download\]\s+(\d+\.?\d*)%\s+of\s+([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)(?:\s+ETA\s+([\d:]+))?/
  );
  if (!match) return null;
  
  return {
    percentage: parseFloat(match[1]),
    total_size: match[2],
    speed: match[3],
    eta: match[4] || null,
  };
}

// ── Main download function ─────────────────────────────────────────────────

async function downloadMedia(downloadId, url, format = 'best', platform, onProgress = null) {
  const formatKey = format.toLowerCase().replace(/\s+/g, '');
  const isAudio = formatKey === 'mp3' || formatKey === 'audio';

  // Check file cache
  const cachedFile = getFileCache(url, formatKey);
  if (cachedFile && fs.existsSync(cachedFile)) {
    const size = fs.statSync(cachedFile).size;
    downloadOps.updateComplete(downloadId, cachedFile, size);
    statsOps.record(platform, isAudio ? 'audio' : 'video', true);
    return { file_path: cachedFile, from_cache: true, size };
  }

  const outputFilename = `${downloadId}.%(ext)s`;
  const outputTemplate = path.join(TEMP_PATH, outputFilename);

  let formatSelector = FORMAT_SELECTORS[formatKey] || FORMAT_SELECTORS['best'];

  const args = [
    ...baseArgs(false),
    '--format', formatSelector,
    '--merge-output-format', 'mp4',
    '--output', outputTemplate,
    '--newline',
    '--no-part',
    '--no-playlist',
    '--concurrent-fragments', '4',
    '--buffer-size', '16K',
    '--http-chunk-size', '10M',
  ];

  if (isAudio) {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  // FFmpeg post-processor for fast start (moov atom at front)
  if (!isAudio) {
    args.push('--postprocessor-args', 'ffmpeg:-movflags +faststart');
  }

  args.push(url);

  // Spawn process to track progress
  return new Promise((resolve, reject) => {
    const cookies = getCookiesForPlatform(platform);
    let cookieIndex = -1; // start with no cookie
    let currentProcess = null;
    let cancelled = false;

    const tryDownload = () => {
      cookieIndex++;
      const cookie = cookieIndex === 0 ? null : cookies[cookieIndex - 1];

      if (cookieIndex > 0 && cookieIndex > cookies.length) {
        return reject(new Error('All cookies failed'));
      }

      const cookieArgs = cookie ? buildCookieArgs(cookie.cookie_file_path) : [];
      const fullArgs = [...args, ...cookieArgs, '--user-agent', randomUA()];

      const proc = spawn(YTDLP_PATH, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      currentProcess = proc;

      let stderr = '';
      let lastProgress = null;

      proc.stdout.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const progress = parseProgress(line);
          if (progress) {
            lastProgress = progress;
            downloadOps.updateProgress(
              downloadId,
              progress.percentage,
              progress.speed,
              progress.total_size,
              progress.eta
            );
            if (onProgress) onProgress(progress);
          }
        }
      });

      proc.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      proc.on('close', async code => {
        if (cancelled) return;

        if (code === 0) {
          // Find output file
          const files = fs.readdirSync(TEMP_PATH).filter(f => f.startsWith(downloadId));
          if (files.length === 0) {
            return reject(new Error('Output file not found'));
          }

          const ext = isAudio ? 'mp3' : 'mp4';
          let outFile = files.find(f => f.endsWith(`.${ext}`)) || files[0];
          const finalPath = path.join(TEMP_PATH, outFile);

          if (!fs.existsSync(finalPath)) {
            return reject(new Error('Output file missing'));
          }

          const size = fs.statSync(finalPath).size;
          
          // Check file size limit
          if (size > MAX_FILE_SIZE) {
            fs.unlinkSync(finalPath);
            return reject(new Error(`File too large: ${formatBytes(size)} > ${formatBytes(MAX_FILE_SIZE)}`));
          }

          downloadOps.updateComplete(downloadId, finalPath, size);
          statsOps.record(platform, isAudio ? 'audio' : 'video', true);

          if (cookie) await recordCookieResult(cookie.id, platform, true);

          // Cache the file (copy to cache dir for longevity)
          const cacheKey = crypto.createHash('sha256').update(`${url}|${formatKey}`).digest('hex');
          const extCache = isAudio ? 'mp3' : (ext || 'mp4');
          const cachedPath = path.join(CACHE_PATH, `${cacheKey}.${extCache}`);

          try {
            // Don't cache if file is too large
            if (size < 100 * 1024 * 1024) { // Only cache files < 100MB
              fs.copyFileSync(finalPath, cachedPath);
              setFileCache(url, platform, isAudio ? 'audio' : 'video', formatKey, cachedPath);
            }
          } catch (cacheErr) {
            console.warn('[cache] Failed to cache file:', cacheErr.message);
          }

          resolve({ file_path: finalPath, size, from_cache: false });
        } else {
          if (cookie) await recordCookieResult(cookie.id, platform, false, stderr);

          const msg = stderr.toLowerCase();
          const isAuthError = msg.includes('login') || msg.includes('auth') ||
            msg.includes('private') || msg.includes('cookie') ||
            msg.includes('403') || msg.includes('sign in') ||
            msg.includes('member');

          if (isAuthError && cookieIndex <= cookies.length) {
            return tryDownload(); // try next cookie
          }

          statsOps.record(platform, isAudio ? 'audio' : 'video', false);
          downloadOps.updateError(downloadId, stderr.slice(0, 500));
          reject(new Error(stderr.slice(0, 300) || `yt-dlp exited with code ${code}`));
        }
      });

      proc.on('error', err => {
        reject(new Error(`yt-dlp spawn error: ${err.message}`));
      });
    };

    // Allow cancellation
    const cancelHandler = () => {
      cancelled = true;
      if (currentProcess) {
        currentProcess.kill('SIGKILL');
      }
    };

    tryDownload();

    // Return cancel function
    return cancelHandler;
  });
}

// ── Generate thumbnail from video ─────────────────────────────────────────

async function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      '-i', videoPath,
      '-ss', '00:00:02',
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      outputPath,
    ], { stdio: 'pipe' });

    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error('Thumbnail generation failed'));
      }
    });

    proc.on('error', reject);
  });
}

// ── Auto-update yt-dlp ─────────────────────────────────────────────────────

async function autoUpdateYtDlp() {
  console.log('[yt-dlp] Checking for updates...');
  try {
    const { stdout } = await execFileAsync(YTDLP_PATH, ['--update'], { timeout: 60000 });
    const line = stdout.trim().split('\n').pop();
    console.log('[yt-dlp] Update result:', line);
    
    // Get version
    const { stdout: versionOut } = await execFileAsync(YTDLP_PATH, ['--version']);
    console.log('[yt-dlp] Version:', versionOut.trim());
    
    return versionOut.trim();
  } catch (err) {
    console.warn('[yt-dlp] Update check failed:', err.message);
    return 'Update check failed';
  }
}

// ── Check if yt-dlp is installed ─────────────────────────────────────────

async function checkYtDlp() {
  try {
    const { stdout } = await execFileAsync(YTDLP_PATH, ['--version']);
    return { installed: true, version: stdout.trim() };
  } catch {
    return { installed: false, error: 'yt-dlp not found' };
  }
}

// ── Check if ffmpeg is installed ─────────────────────────────────────────

async function checkFfmpeg() {
  try {
    const { stdout } = await execFileAsync(FFMPEG_PATH, ['-version']);
    const version = stdout.split('\n')[0] || 'unknown';
    return { installed: true, version };
  } catch {
    return { installed: false, error: 'ffmpeg not found' };
  }
}

// ── Cleanup temp files ─────────────────────────────────────────────────────

function cleanupTemp(maxAgeHours = 1) {
  const now = Date.now();
  let deleted = 0;
  let totalSize = 0;

  try {
    const files = fs.readdirSync(TEMP_PATH);
    for (const file of files) {
      const fp = path.join(TEMP_PATH, file);
      try {
        const stat = fs.statSync(fp);
        const ageHours = (now - stat.mtimeMs) / 3600000;
        
        if (ageHours > maxAgeHours) {
          totalSize += stat.size;
          fs.unlinkSync(fp);
          deleted++;
        }
      } catch (err) {
        // Ignore errors
      }
    }
    
    if (deleted > 0) {
      console.log(`[cleanup] Removed ${deleted} temp files (${formatBytes(totalSize)})`);
    }
    
    return deleted;
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
    return 0;
  }
}

module.exports = {
  extractInfo,
  downloadMedia,
  generateThumbnail,
  autoUpdateYtDlp,
  checkYtDlp,
  checkFfmpeg,
  cleanupTemp,
  parseFormats,
  formatBytes,
};
