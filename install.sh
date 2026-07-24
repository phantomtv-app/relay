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
# Privacy: RELAY_EGRESS_LOOKUP=0 disables the egress display (ipwho.is).
EOF
  chmod 600 "$ENV_FILE"
  echo "-> Configuration: $ENV_FILE (edit -> 'systemctl restart phantom-relay')"
fi

# 4) systemd service
cat > "$SERVICE" <<EOF
[Unit]
Description=phantom_ Relay
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now phantom-relay

# 5) convenience CLI wrapper so one-shot commands don't need the raw node path.
#    The relay itself runs as the systemd service above; this is only for e.g. `phantom-relay --check`
#    (it sources $ENV_FILE so --check talks to the configured PORT).
cat > /usr/local/bin/phantom-relay <<EOF
#!/usr/bin/env bash
set -a; [ -r "$ENV_FILE" ] && . "$ENV_FILE" 2>/dev/null; set +a
exec /usr/bin/node "$APP_DIR/server.js" "\$@"
EOF
chmod +x /usr/local/bin/phantom-relay

PORT_EFF="$(grep -oE '^PORT=[0-9]+' "$ENV_FILE" | cut -d= -f2)"
echo ""
echo "== Done =="
echo "Status:  systemctl status phantom-relay"
echo "Check:   phantom-relay --check"
echo "Config:  $ENV_FILE   (then: systemctl restart phantom-relay)"
echo "In the app:  http://<this-server>:${PORT_EFF:-8787}"
