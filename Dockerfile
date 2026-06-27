# Stage 1: Build the Angular frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Create the production image
FROM node:20-alpine AS runner
WORKDIR /app

# Install unzip for server-side archive extraction
RUN apk add --no-cache unzip

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy Tailscale CLI binary from the official image
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy compiled frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy backend server files
COPY --from=builder /app/server ./server

# Create required directories for file transfers
RUN mkdir -p uploads received

# Expose server port
EXPOSE 3000

# Run Express server
CMD ["node", "server/server.js"]
