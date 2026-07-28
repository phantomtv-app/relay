# All-in-one image: WireGuard + relay in ONE container.
# Drop in a config, set the ENV, start it - no clone, no build needed.
# Base pinned to a FIXED Node major (supply-chain: no moving 'lts'/'latest' tag that could pull an
# unexpected image on rebuild). Bump this deliberately (e.g. node:24-alpine) when moving to a new LTS.
# MOST reproducible: pin the base by DIGEST as well (a tag like '22-alpine' can be re-pushed, a digest
# cannot). Look up the current digest with:
#   docker buildx imagetools inspect node:22-alpine        # -> "Digest: sha256:<...>"
# then reference it here, e.g.:
#   FROM node:22-alpine@sha256:REPLACE_WITH_REAL_DIGEST
# (Digest intentionally left as a placeholder; fill in the value you verified for your build.)
FROM node:22-alpine

# WireGuard tools so the container can bring up the VPN itself (when a wg0.conf is mounted).
RUN apk add --no-cache wireguard-tools bash iptables iproute2 openresolv

WORKDIR /app
COPY server.js package.json docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV PORT=8787
EXPOSE 8787

# ONLY a status light for `docker ps`/monitoring - NOT the leak protection! The fail-closed guard
# kicks in per request in server.js (immediate 503 as soon as the routing proof fails); on top of
# that the app pings /health every 3 seconds. This uses --liveness (process reachable?) on purpose,
# NOT --check: --check exits non-zero when no VPN is verified, which would flag the container unhealthy
# before the tunnel is even set up. The real protection is enforced per request, not by this light.
HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=2 \
  CMD node /app/server.js --liveness || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
