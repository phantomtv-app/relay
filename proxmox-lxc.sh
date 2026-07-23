#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 phantom_
#
# phantom_ Relay – Proxmox VE installer. Run on the PROXMOX HOST as root.
# Creates a Debian LXC and installs WireGuard + the relay + systemd service.
#
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/proxmox-lxc.sh)"
#
# Overridable defaults (ENV):
#   CTID=<id>            (default: next free ID)
#   HOSTNAME=phantom-relay  CORES=1  RAM=512  DISK=2  BRIDGE=vmbr0  STORAGE=local-lvm
#   PASSWORD=<container root-pw>   (default: random, printed out)
#
# NOTE: Test on your own environment. WireGuard in the (unprivileged) LXC needs /dev/net/tun
# (set below) and the wireguard module on the HOST: `modprobe wireguard`.
set -euo pipefail

RAW="https://raw.githubusercontent.com/phantomtv-app/relay/main"
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME="${HOSTNAME:-phantom-relay}"
CORES="${CORES:-1}"; RAM="${RAM:-512}"; DISK="${DISK:-2}"
BRIDGE="${BRIDGE:-vmbr0}"; STORAGE="${STORAGE:-local-lvm}"
PASSWORD="${PASSWORD:-$(openssl rand -base64 12)}"
TMPL_STORE="${TMPL_STORE:-local}"

command -v pct >/dev/null || { echo "This script belongs on the PROXMOX HOST (pct is missing)."; exit 1; }
echo "== phantom_ Relay – Proxmox-LXC =="

# 1) Ensure Debian 12 template
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/{print $2}' | sort | tail -1)"
if ! pveam list "$TMPL_STORE" | grep -q "$TEMPLATE"; then
  echo "-> Downloading template $TEMPLATE …"
  pveam update >/dev/null || true
  pveam download "$TMPL_STORE" "$TEMPLATE"
fi

# 2) Create container
echo "-> Creating CT $CTID ($HOSTNAME) …"
pct create "$CTID" "$TMPL_STORE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME" --cores "$CORES" --memory "$RAM" \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 \
  --password "$PASSWORD" --onboot 1

# 3) Enable WireGuard in the LXC: pass through /dev/net/tun
CONF="/etc/pve/lxc/$CTID.conf"
grep -q "dev/net/tun" "$CONF" 2>/dev/null || cat >> "$CONF" <<EOF
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF

# 4) Start + install
pct start "$CTID"
sleep 5
echo "-> Installing WireGuard + relay in the container …"
pct exec "$CTID" -- bash -c "apt-get update -y && apt-get install -y wireguard curl && curl -fsSL $RAW/install.sh | bash"

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "== Done =="
echo "Container:    CT $CTID  ($HOSTNAME)   root password: $PASSWORD"
echo "IP:           ${IP:-<via DHCP, see 'pct exec $CTID -- ip a'>}"
echo "Next steps IN the container ('pct enter $CTID'):"
echo "  1. Create WireGuard config:   /etc/wireguard/wg0.conf   (your VPN client config)"
echo "  2. Start VPN:                 systemctl enable --now wg-quick@wg0"
echo "  3. Check relay:               node /opt/phantom-relay/server.js --check"
echo "In the app:   http://${IP:-<container-ip>}:8787"
