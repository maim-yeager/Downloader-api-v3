'use strict';

/**
 * Detects platform and media type from a URL.
 */

const PLATFORM_PATTERNS = {
  youtube: [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=[\w-]+/i,
    /(?:https?:\/\/)?youtu\.be\/[\w-]+/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/[\w-]+/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/[\w-]+/i,
    /(?:https?:\/\/)?(?:m\.)?youtube\.com\//i,
    /(?:https?:\/\/)?music\.youtube\.com\//i,
  ],
  tiktok: [
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.]+\/video\/\d+/i,
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/t\/[\w]+/i,
    /(?:https?:\/\/)?vt\.tiktok\.com\/[\w]+/i,
    /(?:https?:\/\/)?vm\.tiktok\.com\/[\w]+/i,
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\//i,
  ],
  instagram: [
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/reel\/[\w-]+/i,
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/p\/[\w-]+/i,
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/tv\/[\w-]+/i,
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/stories\/[\w.]+\/\d+/i,
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\//i,
  ],
  facebook: [
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(?:watch|video)\/?\?(?:.*&)?v=\d+/i,
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[\w.]+\/videos\/\d+/i,
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/reel\/\d+/i,
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/stories\//i,
    /(?:https?:\/\/)?fb\.watch\/[\w-]+/i,
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\//i,
  ],
};

const MEDIA_TYPE_PATTERNS = {
  story: [
    /instagram\.com\/stories\//i,
    /facebook\.com\/stories\//i,
  ],
  reel: [
    /instagram\.com\/reel\//i,
    /facebook\.com\/reel\//i,
    /youtube\.com\/shorts\//i,
    /tiktok\.com\/@[\w.]+\/video\//i,
    /vt\.tiktok\.com\//i,
  ],
  photo: [
    /instagram\.com\/p\//i,
  ],
  video: [
    /youtube\.com\/watch/i,
    /youtu\.be\//i,
    /facebook\.com\/.*\/videos\//i,
    /facebook\.com\/watch/i,
    /fb\.watch\//i,
    /instagram\.com\/tv\//i,
  ],
};

/**
 * Detect platform from URL
 * @param {string} url
 * @returns {string} platform name or 'unknown'
 */
function detectPlatform(url) {
  if (!url || typeof url !== 'string') return 'unknown';

  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(url)) {
        return platform;
      }
    }
  }
  return 'unknown';
}

/**
 * Detect media type from URL (preliminary — yt-dlp confirms final type)
 * @param {string} url
 * @param {string} platform
 * @returns {string}
 */
function detectMediaType(url, platform) {
  if (!url) return 'video';

  // Story check first
  if (MEDIA_TYPE_PATTERNS.story.some(p => p.test(url))) return 'story';

  // Photo/carousel (Instagram /p/)
  if (MEDIA_TYPE_PATTERNS.photo.some(p => p.test(url))) return 'photo'; // may upgrade to carousel

  // Reel / short
  if (MEDIA_TYPE_PATTERNS.reel.some(p => p.test(url))) return 'video';

  // Explicit video
  if (MEDIA_TYPE_PATTERNS.video.some(p => p.test(url))) return 'video';

  // Default by platform
  switch (platform) {
    case 'youtube': return 'video';
    case 'tiktok': return 'video';
    case 'instagram': return 'video';
    case 'facebook': return 'video';
    default: return 'video';
  }
}

/**
 * Validate URL format
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Normalize / clean URL
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  if (!url) return url;
  url = url.trim();
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }
  return url;
}

/**
 * Map yt-dlp extractor_key to our platform names
 * @param {string} extractorKey
 * @returns {string}
 */
function extractorToPlatform(extractorKey) {
  if (!extractorKey) return 'unknown';
  const key = extractorKey.toLowerCase();
  if (key.includes('youtube')) return 'youtube';
  if (key.includes('tiktok')) return 'tiktok';
  if (key.includes('instagram')) return 'instagram';
  if (key.includes('facebook') || key.includes('fb')) return 'facebook';
  return key;
}

module.exports = {
  detectPlatform,
  detectMediaType,
  isValidUrl,
  normalizeUrl,
  extractorToPlatform,
};
