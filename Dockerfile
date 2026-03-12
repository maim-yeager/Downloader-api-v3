FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages yt-dlp || \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Verify installations
RUN yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create data directories
RUN mkdir -p /data/cookies /data/cache /data/temp /data/logs

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Start server
CMD ["node", "server.js"]
