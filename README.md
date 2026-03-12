# 🎬 Social Media Downloader API

A production-ready, high-performance API to download media from **YouTube, TikTok, Instagram, and Facebook** — built with Node.js, Express, yt-dlp, FFmpeg, and SQLite.

---

## ✨ Features

| Feature | Details |
|---------|---------|
| **Platforms** | YouTube, TikTok, Instagram, Facebook |
| **Media Types** | Video, Photo, Carousel, Story, Reels, Shorts |
| **Formats** | Best Quality, 4K, 2K, 1080p, 720p, 480p, 360p, MP3 |
| **Video+Audio Merge** | Auto FFmpeg merge for YouTube |
| **Cookie System** | Multi-cookie fallback + rotation + health monitoring |
| **Caching** | File + metadata cache to avoid re-downloads |
| **Progress Tracking** | Real-time percentage, speed, ETA |
| **Temp Cleanup** | Auto-delete temp files after 1 hour |
| **yt-dlp Auto-Update** | Checks for updates on startup |
| **Deployment** | Ready for Fly.io with persistent `/data` volume |

---

## 🚀 Quick Start

### Local

```bash
git clone <repo>
cd social-media-downloader-api
npm install
cp .env .env.local   # edit as needed
node server.js
```

### Docker

```bash
docker build -t smda .
docker run -p 3002:3002 -v $(pwd)/data:/data --env-file .env smda
```

### Fly.io

```bash
fly launch
fly volumes create social_media_data --size 10
fly secrets set API_KEY="your-secret-key"
fly deploy
```

---

## 🔑 Authentication

All `/api/*` endpoints require the `X-Api-Key` header (if `API_KEY` is set in `.env`).

```
X-Api-Key: mdmaim@#098
```

---

## 📡 API Reference

### Health Check
```
GET /health
```
Response:
```json
{ "status": "API running", "uptime": 123 }
```

---

### Extract Media Info
```
POST /api/extract
Content-Type: application/json
X-Api-Key: <key>

{ "url": "https://youtube.com/watch?v=dQw4w9WgXcQ" }
```

Response includes: `platform`, `media_type`, `title`, `description`, `duration`, `uploader`, `upload_date`, `view_count`, `like_count`, `thumbnail`, `preview_url`, `formats[]`, `items[]` (carousel).

---

### Preview (Fast, No Download)
```
GET /api/preview?url=<media_url>
```

---

### Download Media
```
POST /api/download
Content-Type: application/json
X-Api-Key: <key>

{ "url": "https://...", "format": "1080p" }
```

`format` options: `best`, `4k`, `2k`, `1080p`, `720p`, `480p`, `360p`, `mp3`

Returns the file as a binary stream with `Content-Disposition` header.

---

### Track Download Progress
```
GET /api/download/progress/:download_id
```

---

### List Available Formats
```
GET /api/formats?url=<media_url>
```

---

### Upload Cookies
```
POST /api/cookies/upload
Content-Type: application/json

{
  "platform": "instagram",
  "account_name": "main",
  "cookies": "<Netscape cookie file content>",
  "priority": 1
}
```

---

### List Cookies
```
GET /api/cookies
```

---

### Delete Cookie
```
DELETE /api/cookies/:id
```

---

### Re-enable Disabled Cookie
```
POST /api/cookies/:id/enable
```

---

### Cookie Health Check
```
GET /api/cookies/health
```

---

### Statistics
```
GET /api/stats
```

---

## 🍪 Cookie System

The API supports **multi-cookie fallback** with automatic rotation:

1. For each download, cookies are sorted by **priority** (1 = highest)
2. If a download fails due to auth error → automatically tries next cookie
3. After **5 consecutive failures**, a cookie is **auto-disabled**
4. Use `POST /api/cookies/:id/enable` to re-enable manually
5. Round-robin **rotation** distributes requests across accounts

### How to get cookies

Use a browser extension like [EditThisCookie](https://www.editthiscookie.com/) or [cookies.txt](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) to export cookies in Netscape format.

---

## 🗂 Project Structure

```
social-media-downloader-api/
├── server.js           # Express app + all routes
├── downloader.js       # yt-dlp + FFmpeg engine
├── platformDetector.js # URL → platform/media_type
├── cookieManager.js    # Cookie CRUD + rotation + health
├── cacheManager.js     # Metadata + file caching
├── db.js               # SQLite schema + queries
├── package.json
├── .env
├── Dockerfile
├── fly.toml
└── data/
    ├── cookies/        # Cookie .txt files
    ├── cache/          # Cached media files
    ├── temp/           # In-progress downloads (auto-cleaned)
    └── logs/           # Cookie usage logs
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Server port |
| `API_KEY` | — | Auth key for all `/api/` routes |
| `DB_PATH` | `/data/database.sqlite` | SQLite DB location |
| `CACHE_PATH` | `/data/cache` | Cache directory |
| `COOKIE_PATH` | `/data/cookies` | Cookie files directory |
| `TEMP_PATH` | `/data/temp` | Temp download directory |
| `LOG_PATH` | `/data/logs` | Log directory |
| `CACHE_TTL_HOURS` | `24` | Cache expiry in hours |
| `TEMP_CLEANUP_HOURS` | `1` | Temp file max age |
| `COOKIE_FAIL_THRESHOLD` | `5` | Failures before auto-disable |

---

## 📦 Tech Stack

- **Runtime**: Node.js 20
- **Framework**: Express.js
- **Downloader**: yt-dlp (auto-updated on startup)
- **Media Processing**: FFmpeg
- **Database**: SQLite via better-sqlite3
- **Scheduler**: node-cron
- **Deployment**: Fly.io (persistent volume at `/data`)
