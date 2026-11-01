# Build stage
FROM node:26-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev deps for building)
RUN npm ci

# Copy source code
COPY . .

# Build the TypeScript code
RUN npm run build

# Runtime stage - Using slim instead of alpine for better SSL support
FROM node:26-slim

# Install dumb-init for proper signal handling and update certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/README.md ./
COPY --from=builder /app/LICENSE ./

# Run as a non-root user that cannot modify the installed application
RUN useradd -M -d /app -s /usr/sbin/nologin appuser
USER appuser

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Expose port
EXPOSE 3000

# Set environment variables
ENV REDDIT_BUDDY_HTTP=true
# The server binds loopback by default. Inside a container that would make the
# published port unreachable, so bind all interfaces here — the container
# boundary (and whatever you publish with -p) is the real access control.
ENV REDDIT_BUDDY_HOST=0.0.0.0
ENV NODE_ENV=production

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/cli.js"]
