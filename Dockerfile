# Dockerfile
FROM node:20-slim AS base

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    wget \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install yt-dlp || \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Production stage
FROM base AS production

WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies - ফিক্সড ভার্সন
RUN npm install --production --no-audit --no-fund || \
    npm ci --only=production --no-audit --no-fund || \
    npm install --production

# Copy application files
COPY . .

# Create data directories
RUN mkdir -p /data/cookies /data/cache /data/temp /data/logs /data/backups && \
    chmod -R 755 /data

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Start server
CMD ["node", "server.js"]
