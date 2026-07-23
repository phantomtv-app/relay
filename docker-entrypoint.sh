#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 phantom_
set -e
# Is a WireGuard config mounted? If so, bring up the VPN INSIDE the container.
# (Start the container with  --cap-add NET_ADMIN --device /dev/net/tun  for this.)
if [ -f /etc/wireguard/wg0.conf ]; then
  echo "-> starting WireGuard (wg0) …"
  wg-quick up wg0 || echo "WARN: WireGuard start failed – check config / NET_ADMIN / /dev/net/tun."
fi
# Without a mounted config: relay only (uses e.g. a host VPN via --network host).
exec node /app/server.js
