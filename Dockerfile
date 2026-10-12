# syntax=docker/dockerfile:1

# ------------------------------------------------------------
# Backend build
# ------------------------------------------------------------
FROM golang:1.25-alpine AS backend-builder

WORKDIR /build/backend

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./

RUN CGO_ENABLED=0 GOOS=linux \
    go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/skyacs \
    ./cmd/server


# ------------------------------------------------------------
# Frontend build
# ------------------------------------------------------------
FROM node:24-alpine AS frontend-builder

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json ./frontend/

RUN cd frontend && \
    npm ci --include=dev --no-audit --no-fund

COPY frontend/ ./frontend/

WORKDIR /build/frontend

ARG VITE_APP_NAME
RUN printf 'VITE_API_URL=/api\nVITE_APP_NAME=%s\n' "${VITE_APP_NAME:-}" > .env.production && \
    npm run build


# ------------------------------------------------------------
# Backend runtime
# ------------------------------------------------------------
FROM alpine:3.23 AS backend

RUN apk add --no-cache \
    ca-certificates \
    tzdata

RUN addgroup -S -g 10001 skyacs && \
    adduser -S -D -H -u 10001 -G skyacs skyacs

WORKDIR /app

COPY --from=backend-builder /out/skyacs /app/skyacs

RUN mkdir -p /var/lib/skyacs/firmware /var/lib/skyacs/template-images && \
    chown -R skyacs:skyacs /var/lib/skyacs

USER skyacs

ENV PORT=7547 \
    API_PORT=7548 \
    CWMP_BIND_ADDR=0.0.0.0 \
    API_BIND_ADDR=0.0.0.0 \
    FIRMWARE_UPLOAD_DIR=/var/lib/skyacs/firmware

EXPOSE 7547 7548

HEALTHCHECK \
    --interval=30s \
    --timeout=5s \
    --start-period=20s \
    --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1:7548/health || exit 1

ENTRYPOINT ["/app/skyacs"]


# ------------------------------------------------------------
# Web / reverse proxy runtime
# ------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:alpine AS web

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-builder /build/frontend/dist /usr/share/nginx/html

EXPOSE 8080 7547

HEALTHCHECK \
    --interval=30s \
    --timeout=5s \
    --start-period=10s \
    --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
