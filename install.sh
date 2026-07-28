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
# Supply-chain: server.js is fetched from this git ref. 'main' is a MOVING branch - a force-push or a
# compromised repo could silently change what you install. For a REPRODUCIBLE install, pin RELAY_REF to
# an immutable ref before running:
#   - a full commit SHA (strongest, always immutable): RELAY_REF=<40-char-sha> ./install.sh
#   - a signed release tag once published:             RELAY_REF=v1.0.0        ./install.sh
# Verify the download out-of-band, e.g. compare a known-good checksum:
#   sha256sum /opt/phantom-relay/server.js   # then match it against the value from the release notes
# Default stays 'main' (no tag is published yet); switch it to a signed tag as soon as one exists.
RELAY_REF="${RELAY_REF:-main}"
RAW="https://raw.githubusercontent.com/phantomtv-app/relay/${RELAY_REF}"
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /tmp)"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)."; exit 1; }
echo "== phantom_ Relay – Installer =="

# 1) Ensure Node 18+
# Supply-chain note: the NodeSource bootstrap below is the vendor's official 'curl | bash' from
# deb.nodesource.com (served over HTTPS, provenance = NodeSource). It ADDS an APT repo + its signing
# key; subsequent 'apt-get install nodejs' packages are then GPG-verified by APT. If you prefer not to
# run a piped script, install Node from your distro (apt-get install -y nodejs) or nodejs.org and skip
# this block - the relay only needs Node 18+. To pin/audit it, fetch the script to a file first and
# review/checksum it before running:  curl -fsSL https://deb.nodesource.com/setup_lts.x -o ns.sh
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
#     IMPORTANT: installing resolvconf REPLACES /etc/resolv.conf with a managed file that is
#     initially EMPTY -> DNS would break for EVERY step after this (e.g. downloading server.js,
#     or the very next command in a wrapping installer). So capture the current nameservers first
#     and feed them straight back into resolvconf, then rebuild resolv.conf.
if command -v apt-get >/dev/null 2>&1 && ! command -v resolvconf >/dev/null 2>&1; then
  echo "-> Installing resolvconf (for wg-quick DNS) …"
  _NS="$(grep -E '^nameserver ' /etc/resolv.conf 2>/dev/null || true)"
  [ -n "$_NS" ] || _NS='nameserver 1.1.1.1'
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y resolvconf || true
  # keep DNS working: seed resolvconf's base with the nameservers we had, then rebuild resolv.conf
  [ -d /etc/resolvconf/resolv.conf.d ] && printf '%s\n' "$_NS" > /etc/resolvconf/resolv.conf.d/base || true
  command -v resolvconf >/dev/null 2>&1 && resolvconf -u 2>/dev/null || true
  # last resort: if resolv.conf still has no nameserver, write one directly so the next step resolves
  grep -qE '^nameserver ' /etc/resolv.conf 2>/dev/null || printf '%s\n' "$_NS" > /etc/resolv.conf
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
  # NO 'open' default: generate a STRONG random password so the relay is protected out of the box.
  # The operator can still override RELAY_AUTH/RELAY_USER/RELAY_PASS via ENV before running. Prefer
  # openssl, fall back to /dev/urandom; hex keeps the ?k= URL token clean.
  GEN_PASS="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENV_FILE" <<EOF
PORT=${PORT:-8787}
RELAY_VPN_IF=${RELAY_VPN_IF:-wg0}
# Access protection. NO 'open' default: a strong random password was generated so the relay is not
# open. Change RELAY_USER/RELAY_PASS as you like, then 'systemctl restart phantom-relay'.
#   RELAY_AUTH=ip     + RELAY_ALLOW=1.2.3.4,5.6.7.8   (allowed client IPs)
#   RELAY_AUTH=open   (no protection - ONLY on a trusted LAN)
RELAY_AUTH=${RELAY_AUTH:-basic}
RELAY_USER=${RELAY_USER:-phantom}
RELAY_PASS=${RELAY_PASS:-$GEN_PASS}
# Egress display is OFF by default (no periodic outbound call). OPT-IN to let the relay look up its
# OWN exit IP through the tunnel via phantom_'s endpoint https://phantomtv.app/api/my-ip (no third
# party, no user data) so the app can show the IP comparison and enable the extra RELAY_REAL_IP veto:
#   RELAY_EGRESS_LOOKUP=1
# Behind a reverse proxy set a fixed public base (else the Host header is used):
#   RELAY_PUBLIC_URL=https://relay.example
#   RELAY_TRUSTED_PROXIES=1.2.3.4     (only these proxy IPs may set X-Forwarded-*)
# The strong /health 'protected' attest does NOT need this - it rests on the tunnel-interface name +
# a routing proof (ip route get). RELAY_REAL_IP only ADDS an egress leak veto (requires the egress
# lookup above). 'phantom-relay setup' can fill it in for you:
#   RELAY_REAL_IP=203.0.113.9
# Local dev without a VPN (disables the fail-closed guard -> forwards UNPROTECTED, dev only):
#   RELAY_ALLOW_UNPROTECTED=1
EOF
  chmod 600 "$ENV_FILE"
  echo "-> Configuration: $ENV_FILE (edit -> 'systemctl restart phantom-relay')"
  echo "-> Access protection: mode=${RELAY_AUTH:-basic}  user='${RELAY_USER:-phantom}'  pass='${RELAY_PASS:-$GEN_PASS}'"
  echo "   Note these credentials (also stored in $ENV_FILE) - enter them in the app under Settings -> Relay."
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
# The relay itself runs as the 'phantom-relay' systemd service. This wrapper NEVER starts a second
# copy of server.js for control commands (that would fight the service for port \${PORT:-8787} ->
# EADDRINUSE). Service control goes through systemctl; only --check runs node, in CLIENT mode
# (it talks to the already-running relay and exits, it does not listen).
cmd="\${1:-help}"
case "\$cmd" in
  setup)
    echo "== phantom_ relay setup =="
    echo "1) Paste your VPN provider's WireGuard config into the editor."
    echo "   Keep ONLY the [Interface] / [Peer] block - no editor title bars or extra text."
    read -rp "   Press Enter to open the editor ... " _
    "\${EDITOR:-nano}" /etc/wireguard/wg0.conf
    # Configs pasted from web portals often carry CRLF line endings or a leading BOM. 'wg setconf'
    # then rejects those lines ("Line unrecognized: PrivateKey=..."). Strip a BOM + all CR so the
    # config parses no matter where it was copied from; tighten perms (it holds the private key).
    sed -i '1s/^\xEF\xBB\xBF//; s/\r\$//' /etc/wireguard/wg0.conf 2>/dev/null || true
    chmod 600 /etc/wireguard/wg0.conf 2>/dev/null || true
    echo ""
    echo "2) OPTIONAL egress leak veto: detecting your REAL (non-VPN) public IP ..."
    echo "   The 'protected' attest already works via the routing proof (ip route). This step ADDS an"
    echo "   extra check: it enables the egress lookup (a periodic call THROUGH the tunnel to phantom_'s"
    echo "   https://phantomtv.app/api/my-ip - no third party, no user data) and flags a leak if the exit"
    echo "   IP ever equals your real one. Detected NOW, before the VPN starts. Leave empty to skip."
    _realip="\$(curl -fsSL --max-time 8 https://phantomtv.app/api/my-ip 2>/dev/null | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}' | head -1)"
    if [ -n "\$_realip" ]; then
      read -rp "   Detected \$_realip - press Enter to use it, type a different IP, or 'n' to skip: " _override
      [ "\$_override" = "n" ] && _realip=""
      [ -n "\$_override" ] && [ "\$_override" != "n" ] && _realip="\$_override"
    else
      read -rp "   Could not auto-detect. Enter your real non-VPN public IP (empty = skip): " _realip
    fi
    if [ -n "\$_realip" ]; then
      sed -i '/^RELAY_REAL_IP=/d; /^RELAY_EGRESS_LOOKUP=/d' "$ENV_FILE" 2>/dev/null || true
      echo "RELAY_REAL_IP=\$_realip" >> "$ENV_FILE"
      # The RELAY_REAL_IP veto needs the egress lookup; enable it here as the explicit opt-in.
      echo "RELAY_EGRESS_LOOKUP=1" >> "$ENV_FILE"
      echo "   -> saved RELAY_REAL_IP=\$_realip + RELAY_EGRESS_LOOKUP=1 to $ENV_FILE"
    fi
    echo "3) Starting the VPN (wg-quick@wg0) ..."
    if systemctl enable --now wg-quick@wg0; then
      wg show
      echo ""
      echo "4) RECOMMENDED kill switch (nftables OUTPUT-deny) ..."
      echo "   Drops ALL outbound traffic except via the tunnel (wg0) + the WireGuard handshake, so"
      echo "   nothing can leak over the real link if the VPN ever drops (a REAL kill switch)."
      echo "   Why recommended: WITHOUT it the app-side guard is only a best-effort route check with a"
      echo "   TOCTOU residual window (it verifies the interface/route, not every packet, and not at the"
      echo "   instant a packet leaves). nftables (packet-level, or a network namespace) is the ONLY hard"
      echo "   guarantee that nothing but loopback and wg0 ever gets egress. Enable it unless you have a"
      echo "   specific reason not to."
      echo "   WARNING: a wrong VPN port can lock this box out of the network (SSH included)."
      echo "            Proceed ONLY with console access to recover. Default is YES (recommended)."
      read -rp "   Install the nftables kill switch now? [Y/n] " _ks
      if [ -z "\$_ks" ] || [ "\$_ks" = "y" ] || [ "\$_ks" = "Y" ]; then
        # WireGuard ENDPOINT (host:port) from wg0.conf. A real kill switch must permit ONLY the handshake
        # to THIS endpoint over the real uplink - not any UDP to that port, and NOT arbitrary pre-existing
        # (non-VPN) connections. So resolve the endpoint host to its IP(s) and pin the exception to
        # <egress-if> + endpoint-IP + UDP-port, per address family (ip/ip6). NOTE: the most robust reference
        # variant is a VPN-only network namespace (the relay would get NO route to the real uplink at all);
        # consider it for high-assurance setups. This nftables switch is the pragmatic single-host approximation.
        _ep="\$(grep -iE '^[[:space:]]*Endpoint' /etc/wireguard/wg0.conf 2>/dev/null | head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]].*\$//')"
        _wgport="\$(printf '%s' "\$_ep" | sed -E 's/.*:([0-9]+)\$/\1/')"
        _ephost="\$(printf '%s' "\$_ep" | sed -E 's/:[0-9]+\$//; s/^\[//; s/\]\$//')"
        case "\$_wgport" in ''|*[!0-9]*) _wgport=51820 ;; esac
        # Resolve endpoint host -> IP(s). getent handles literals and names; dig is a fallback. If it stays
        # unresolvable, WARN and fall back to a looser port-only exception (so we never lock out the handshake).
        _epips=""
        if [ -n "\$_ephost" ]; then
          _epips="\$(getent ahosts "\$_ephost" 2>/dev/null | awk '{print \$1}' | sort -u)"
          [ -n "\$_epips" ] || _epips="\$(dig +short "\$_ephost" 2>/dev/null | grep -E '^[0-9A-Fa-f:.]+\$')"
        fi
        _epfallback=0
        [ -n "\$_epips" ] || { _epfallback=1; echo "   WARNING: endpoint '\$_ephost' did not resolve to an IP - using a looser PORT-ONLY handshake exception. Pin the endpoint IP by hand for a tighter rule."; }
        command -v nft >/dev/null 2>&1 || apt-get install -y nftables >/dev/null 2>&1 || true
        if ! command -v nft >/dev/null 2>&1; then
          echo "   nft not available - skipping the kill switch."
        elif ! command -v curl >/dev/null 2>&1; then
          echo "   curl not available for the post-apply safety test - skipping the kill switch."
        else
          # Back up the current ruleset so a failed connectivity test can be rolled back cleanly.
          _ksbak="/root/phantom-killswitch-backup-\$(date +%s).nft"
          nft list ruleset > "\$_ksbak" 2>/dev/null || true
          mkdir -p /etc/nftables.d
          _ksfile="/etc/nftables.d/phantom-killswitch.nft"
          # Static head: only lo + the tunnel (wg0) may egress unconditionally.
          cat > "\$_ksfile" <<KSEOF
table inet phantom_killswitch {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    oifname "wg0" accept
KSEOF
          # Endpoint handshake exception(s): egress-if + endpoint-IP + UDP-port, per family. established,related
          # is bound to the SAME endpoint IP so no pre-existing NON-VPN connection survives the switch.
          if [ "\$_epfallback" = "1" ]; then
            printf '    udp dport %s accept\n    ct state established,related accept\n' "\$_wgport" >> "\$_ksfile"
          else
            for _ip in \$_epips; do
              case "\$_ip" in
                *:*) _fam="ip6"; _if="\$(ip -6 route get "\$_ip" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -1)" ;;
                *)   _fam="ip";  _if="\$(ip route get "\$_ip" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -1)" ;;
              esac
              [ -n "\$_if" ] || _if="\$(ip route show default 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -1)"
              if [ -n "\$_if" ]; then
                printf '    oifname "%s" %s daddr %s udp dport %s accept\n' "\$_if" "\$_fam" "\$_ip" "\$_wgport" >> "\$_ksfile"
                printf '    oifname "%s" %s daddr %s ct state established,related accept\n' "\$_if" "\$_fam" "\$_ip" >> "\$_ksfile"
              else
                printf '    %s daddr %s udp dport %s accept\n' "\$_fam" "\$_ip" "\$_wgport" >> "\$_ksfile"
              fi
            done
          fi
          printf '  }\n}\n' >> "\$_ksfile"
          if nft -f "\$_ksfile"; then
            # Safety test: traffic must still flow THROUGH the tunnel. If not, the rules are wrong ->
            # roll back immediately so we never leave the box cut off from the network.
            if curl -fsS --max-time 8 https://phantomtv.app/api/my-ip >/dev/null 2>&1; then
              echo "   Kill switch active (handshake udp/\$_wgport). Tunnel connectivity OK."
              grep -qsF "\$_ksfile" /etc/nftables.conf 2>/dev/null || printf 'include "%s"\n' "\$_ksfile" >> /etc/nftables.conf
              systemctl enable nftables >/dev/null 2>&1 || true
              echo "   Persisted (included from /etc/nftables.conf; nftables service enabled)."
            else
              echo "   Connectivity test FAILED after applying the kill switch - rolling back."
              nft delete table inet phantom_killswitch 2>/dev/null || true
              rm -f "\$_ksfile"
              echo "   Removed. Previous ruleset backup: \$_ksbak"
            fi
          else
            echo "   Could not apply the kill switch (nft -f failed) - skipping."
            rm -f "\$_ksfile"
          fi
        fi
      else
        echo "   Skipped. You can add a kill switch later (see README 'Kill switch')."
      fi
      echo ""
      echo "5) Restarting the relay so it picks up the tunnel ..."
      systemctl restart phantom-relay
      echo "6) Verifying ..."
      exec $NODE_BIN "$APP_DIR/server.js" --check
    else
      echo ""
      echo "   VPN did NOT start. Most recent errors:"
      journalctl -u wg-quick@wg0 -n 20 --no-pager 2>/dev/null | sed 's/^/     /'
      echo "   Full log:  journalctl -xeu wg-quick@wg0"
      exit 1
    fi
    ;;
  --check|check) exec $NODE_BIN "$APP_DIR/server.js" --check ;;
  status)        exec systemctl --no-pager status phantom-relay ;;
  start)         exec systemctl start phantom-relay ;;
  stop)          exec systemctl stop phantom-relay ;;
  restart)       exec systemctl restart phantom-relay ;;
  logs)          exec journalctl -u phantom-relay -n 100 --no-pager ;;
  help|-h|--help)
    echo "phantom-relay <command>"
    echo "  setup      configure + start the VPN (wg0), then verify the relay"
    echo "  status     show the relay service status"
    echo "  start | stop | restart   control the relay systemd service"
    echo "  logs       show the last 100 relay log lines"
    echo "  --check    probe the RUNNING relay (VPN active? egress IP) - does NOT start a 2nd copy"
    exit 0 ;;
  *)
    echo "phantom-relay: unknown command '\$cmd'  (try: phantom-relay help)" >&2
    exit 2 ;;
esac
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
echo "The relay's fail-closed verifies the tunnel interface is up AND proves per target that the route"
echo "leaves via it ('ip route get <target>' -> dev must be the tunnel) - but it is still NOT a true kill"
echo "switch: it governs only the relay's own HTTP sockets, not DNS or any other process, and cannot"
echo "physically stop a packet. Add an OS-level OUTPUT-deny so no packet can leave except via the tunnel"
echo "(wg0). 'phantom-relay setup' can generate a HARDENED variant for you (handshake pinned to the"
echo "resolved endpoint IP + egress interface, established/related scoped to that endpoint - NOT pauschal)."
echo "The strongest reference is a VPN-only network namespace (no route to the real uplink at all)."
echo "Minimal manual example (nftables; replace <endpoint-ip>/<uplink-if>/51820 with your values):"
cat <<'NFT'
  table inet killswitch {
    chain output {
      type filter hook output priority 0; policy drop;
      oifname "lo" accept
      oifname "wg0" accept
      # ONLY the handshake to your endpoint over the real uplink - not any UDP to that port:
      oifname "<uplink-if>" ip daddr <endpoint-ip> udp dport 51820 accept
      oifname "<uplink-if>" ip daddr <endpoint-ip> ct state established,related accept
    }
  }
NFT
echo "Save as /etc/nftables.conf (or an include) and: systemctl enable --now nftables"
echo "Optionally set RELAY_REAL_IP=<your real non-VPN IP> so /health reports vpn:false on a leak."
