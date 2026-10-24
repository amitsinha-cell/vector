# syntax=docker/dockerfile:1
# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json ./

# Install all deps (including devDeps needed by the build)
RUN npm ci --ignore-scripts

# Copy source
COPY . .

# Build — outputs to .output/public (TanStack Start / Nitro static export)
# VITE_API_URL defaults to "" which routes API requests relatively to /api/*
# via Nginx reverse-proxy on the same host.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ── Stage 2: serve ───────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our Nginx config
COPY deploy/nginx.conf /etc/nginx/conf.d/vector.conf

# Copy the static build output from Stage 1
# TanStack Start / Vite builds to .output/public for static export
COPY --from=builder /app/.output/public /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
