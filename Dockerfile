# All-in-one image: WireGuard + relay in ONE container.
# Drop in a config, set the ENV, start it - no clone, no build needed.
FROM node:20-alpine

# WireGuard tools so the container can bring up the VPN itself (when a wg0.conf is mounted).
RUN apk add --no-cache wireguard-tools bash iptables iproute2 openresolv

WORKDIR /app
COPY server.js package.json docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV PORT=8787
EXPOSE 8787

# ONLY a status light for `docker ps`/monitoring - NOT the leak protection! The fail-closed guard
# kicks in per request in server.js (immediate 503 as soon as the VPN interface is gone); on top
# of that the app pings /health every 3 seconds. Still tightly timed here so the light flips quickly.
HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=2 \
  CMD node /app/server.js --check || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
