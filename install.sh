#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 phantom_
#
# phantom_ Relay – standalone installer for Debian/Ubuntu (WITHOUT Docker).
# Run as root. Idempotent (a rerun updates server.js + service).
#
#   Direct:  bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/install.sh)"
#   Local:   sudo ./install.sh
#
# Installs ONLY the relay + systemd service. You set up your VPN (WireGuard/OpenVPN) separately
# (the relay uses its interface – default wg0). Fail-Closed ensures that without an active
# VPN nothing is forwarded.
set -euo pipefail

APP_DIR="/opt/phantom-relay"
ENV_FILE="/etc/phantom-relay.env"
SERVICE="/etc/systemd/system/phantom-relay.service"
RAW="https://raw.githubusercontent.com/phantomtv-app/relay/main"
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /tmp)"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)."; exit 1; }
echo "== phantom_ Relay – Installer =="

# 1) Ensure Node 18+
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
  echo "-> Installing the latest Node.js LTS …"
  apt-get update -y
  apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi

# 1b) resolvconf provider so wg-quick can apply a `DNS =` line if you run WireGuard on this host.
#     The relay sets up NO VPN itself - this only avoids the common wg-quick failure
#     ("resolvconf: command not found"). Skipped on non-apt hosts and when already present.
if command -v apt-get >/dev/null 2>&1 && ! command -v resolvconf >/dev/null 2>&1; then
  echo "-> Installing resolvconf (for wg-quick DNS) …"
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y resolvconf || true
fi

# 2) server.js to $APP_DIR (copy locally, otherwise download)
mkdir -p "$APP_DIR"
if [ -f "$SELF_DIR/server.js" ]; then
  cp "$SELF_DIR/server.js" "$APP_DIR/server.js"
  [ -f "$SELF_DIR/package.json" ] && cp "$SELF_DIR/package.json" "$APP_DIR/package.json"
else
  echo "-> Downloading server.js …"
  curl -fsSL "$RAW/server.js" -o "$APP_DIR/server.js"
fi

# 3) Configuration (overridable via ENV, otherwise defaults) – written only on first run
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=${PORT:-8787}
RELAY_VPN_IF=${RELAY_VPN_IF:-wg0}
RELAY_AUTH=${RELAY_AUTH:-open}
# Access protection:
#   RELAY_AUTH=ip     + RELAY_ALLOW=1.2.3.4,5.6.7.8   (allowed client IPs)
#   RELAY_AUTH=basic  + RELAY_USER=... RELAY_PASS=...  (username/password)
# Egress display is ON by default (uses your own /api/my-ip, not a third party):
#   RELAY_EGRESS_LOOKUP=0   disables it (no extra outbound call at all)
# Behind a reverse proxy set a fixed public base (else the Host header is used):
#   RELAY_PUBLIC_URL=https://relay.example
#   RELAY_TRUSTED_PROXIES=1.2.3.4     (only these proxy IPs may set X-Forwarded-*)
# Active leak self-check (report vpn:false if egress equals your real, non-VPN IP):
#   RELAY_REAL_IP=203.0.113.9
EOF
  chmod 600 "$ENV_FILE"
  echo "-> Configuration: $ENV_FILE (edit -> 'systemctl restart phantom-relay')"
fi

# Resolve the Node binary dynamically. NodeSource usually installs it at /usr/bin/node, but the
# path can differ per host/template. A wrong ExecStart path would make the service crash instantly
# and (under 'set -e') abort the rest of the installer -> the 'phantom-relay' wrapper would be
# missing ("command not found"). So always use the real path.
NODE_BIN="$(command -v node || echo /usr/bin/node)"

# 4) systemd service
cat > "$SERVICE" <<EOF
[Unit]
Description=phantom_ Relay
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
EOF

# 5) Create the 'phantom-relay' CLI wrapper FIRST - BEFORE starting the service.
#    Chicken-and-egg: on a fresh host no VPN is set up yet; the service is then fail-closed and
#    'systemctl start' may fail. But the wrapper is exactly the tool the user needs to set up the
#    VPN via 'phantom-relay setup'. So it MUST exist independently of the service start - otherwise
#    you're left without 'phantom-relay' (command not found).
cat > /usr/local/bin/phantom-relay <<EOF
#!/usr/bin/env bash
set -a; [ -r "$ENV_FILE" ] && . "$ENV_FILE" 2>/dev/null; set +a
if [ "\$1" = setup ]; then
  echo "== phantom_ relay setup =="
  echo "1) Paste your VPN provider's WireGuard config into the editor."
  echo "   Keep ONLY the [Interface] / [Peer] block - no editor title bars or extra text."
  read -rp "   Press Enter to open the editor ... " _
  "\${EDITOR:-nano}" /etc/wireguard/wg0.conf
  echo "2) Starting the VPN (wg-quick@wg0) ..."
  if systemctl enable --now wg-quick@wg0; then wg show; else
    echo "   VPN did not start - inspect with: journalctl -xeu wg-quick@wg0"; exit 1
  fi
  echo ""
  echo "3) Checking the relay ..."
  exec $NODE_BIN "$APP_DIR/server.js" --check
fi
exec $NODE_BIN "$APP_DIR/server.js" "\$@"
EOF
chmod +x /usr/local/bin/phantom-relay

# 6) Enable the service. Start deliberately TOLERANT: without an active VPN the relay is fail-closed
#    and the start may fail (depending on host) - this must NOT abort the installer, otherwise the
#    setup stays incomplete. The user then sets up the VPN via 'phantom-relay setup' and restarts.
systemctl daemon-reload
systemctl enable phantom-relay >/dev/null 2>&1 || true
systemctl start phantom-relay || echo "WARN: relay service not active yet (VPN missing? -> 'phantom-relay setup', then 'systemctl restart phantom-relay')."

PORT_EFF="$(grep -oE '^PORT=[0-9]+' "$ENV_FILE" | cut -d= -f2)"
echo ""
echo "== Done =="
echo "VPN setup:  phantom-relay setup   (paste your WireGuard config; starts + verifies the VPN)"
echo "Status:     systemctl status phantom-relay"
echo "Check:      phantom-relay --check"
echo "Config:     $ENV_FILE   (then: systemctl restart phantom-relay)"
echo "In the app: http://<this-server>:${PORT_EFF:-8787}"
echo ""
echo "== Real kill switch (STRONGLY recommended) =="
echo "The relay's fail-closed only checks that the tunnel INTERFACE exists - it is NOT a true kill"
echo "switch. Add an OS-level OUTPUT-deny so no packet can leave except via the tunnel (wg0). Example"
echo "(nftables; replace 51820 with your VPN provider's UDP port):"
cat <<'NFT'
  table inet killswitch {
    chain output {
      type filter hook output priority 0; policy drop;
      oifname "lo" accept
      oifname "wg0" accept
      udp dport 51820 accept          # WireGuard handshake to your VPN endpoint
      ct state established,related accept
    }
  }
NFT
echo "Save as /etc/nftables.conf (or an include) and: systemctl enable --now nftables"
echo "Optionally set RELAY_REAL_IP=<your real non-VPN IP> so /health reports vpn:false on a leak."
