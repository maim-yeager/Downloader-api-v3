# Dockerfile
FROM node:20-slim

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

# Install yt-dlp with fallback methods
RUN pip3 install --break-system-packages yt-dlp || \
    pip3 install yt-dlp || \
    (curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp)

# Verify installations and create symlink if needed
RUN yt-dlp --version || ln -s /usr/local/bin/yt-dlp /usr/bin/yt-dlp || true && \
    ffmpeg -version | head -1

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install Node dependencies with clean install
RUN npm ci --only=production --no-audit --no-fund

# Copy application files
COPY . .

# Create data directories with proper permissions
RUN mkdir -p /data/cookies /data/cache /data/temp /data/logs /data/backups && \
    chmod -R 755 /data && \
    chown -R node:node /data || true

# Copy and setup init script
RUN node init-folders.js || true

# Set non-root user for security (optional)
# USER node

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Use tini for better signal handling
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

# Start server with tini
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

# Add metadata
LABEL maintainer="Maim Islam" \
      version="1.0.0" \
      description="Social Media Downloader API"
