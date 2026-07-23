#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 phantom_
#
# phantom_ Relay - Proxmox VE installer (community-scripts style).
# Run on the PROXMOX HOST as root:
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/proxmox-lxc.sh)"
#
# Interactive: choose "Default" or "Advanced" (CTID/VMID, CPU, RAM, disk, storage,
# root password, verbose yes/no). Creates an unprivileged, WireGuard-capable Debian LXC
# and installs the phantom_ relay + systemd.
#
# Non-interactive (no TTY, e.g. CI): uses defaults, overridable via ENV
#   CTID CT_HOSTNAME CORES RAM DISK BRIDGE PASSWORD VERBOSE ROOT_STORE TMPL_STORE
set -euo pipefail

RAW="https://raw.githubusercontent.com/phantomtv-app/relay/main"
LOGFILE="$(mktemp 2>/dev/null || echo "/tmp/phantom-relay.$$.log")"
VERBOSE="${VERBOSE:-no}"; SPIN_PID=""; STD=""   # VERBOSE honours the environment (CI / non-interactive)

# ---- colours ----------------------------------------------------------------
if [ -t 1 ]; then
  YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'; DIM=$'\033[2m'; CL=$'\033[m'
else
  YW=''; GN=''; RD=''; BL=''; DIM=''; CL=''
fi
CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"; INFO="${BL}➜${CL}"

# ---- spinner + verbose-aware messages ($STD mirrors community-scripts) -------
silent()   { "$@" >>"$LOGFILE" 2>&1; }
_spin()    { local f='-\|/' i=0; while :; do i=$(((i+1)%4)); printf "\r ${BL}%s${CL} ${YW}%s…${CL}" "${f:$i:1}" "$1"; sleep 0.15; done; }
_spin_on() { { [ -t 1 ] && [ "$VERBOSE" = no ]; } || return 0; _spin "$1" & SPIN_PID=$!; disown 2>/dev/null || true; }
_spin_off(){ [ -n "$SPIN_PID" ] && { kill "$SPIN_PID" 2>/dev/null || true; SPIN_PID=""; printf "\r\033[K"; }; return 0; }
msg_info() { if [ -t 1 ] && [ "$VERBOSE" = no ]; then _spin_on "$1"; else echo -e " ${INFO} ${YW}$1…${CL}"; fi; }
msg_ok()   { _spin_off; echo -e " ${CM} ${GN}$1${CL}"; }
msg_error(){ _spin_off; echo -e " ${CROSS} ${RD}$1${CL}"; }
trap 'rc=$?; _spin_off; msg_error "Aborted (line ${LINENO}, code ${rc})."; { [ "${VERBOSE}" = no ] && [ -s "${LOGFILE:-/dev/null}" ]; } && { echo "---- last output ----"; tail -n 20 "${LOGFILE}"; }; exit "${rc}"' ERR

header_info() {
  clear 2>/dev/null || true
  echo -e "${BL}"
  cat <<'EOF'
       _                 _
 _ __ | |__   __ _ _ __ | |_ ___  _ __ ___
| '_ \| '_ \ / _` | '_ \| __/ _ \| '_ ` _ \
| |_) | | | | (_| | | | | || (_) | | | | | |
| .__/|_| |_|\__,_|_| |_|\__\___/|_| |_| |_|
|_|   R E L A Y
EOF
  echo -e "${CL}${DIM}   privacy-first stream relay · LXC installer${CL}\n"
}

# ---- preconditions ----------------------------------------------------------
command -v pct >/dev/null 2>&1 || { echo "This script belongs on the Proxmox VE host (pct is missing)." >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

# ---- prompt helpers (whiptail, falling back to read) ------------------------
HAS_WHIP=0; command -v whiptail >/dev/null 2>&1 && HAS_WHIP=1
abort() { msg_error "Aborted."; rm -f "$LOGFILE" 2>/dev/null || true; exit 1; }

wt_input() { # title prompt default
  local v
  if [ "$HAS_WHIP" = 1 ]; then v=$(whiptail --title "$1" --inputbox "$2" 9 64 "$3" 3>&1 1>&2 2>&3) || abort
  else read -r -p "$2 [$3]: " v </dev/tty || abort; v="${v:-$3}"; fi
  printf '%s' "$v"
}
wt_pass() { # title prompt
  local v
  if [ "$HAS_WHIP" = 1 ]; then v=$(whiptail --title "$1" --passwordbox "$2" 9 64 3>&1 1>&2 2>&3) || abort
  else read -r -s -p "$2: " v </dev/tty || abort; echo >/dev/tty; fi
  printf '%s' "$v"
}
wt_yesno() { # title prompt   (returns 0 = yes)
  if [ "$HAS_WHIP" = 1 ]; then whiptail --title "$1" --yesno "$2" 9 64
  else local a; read -r -p "$2 [y/N]: " a </dev/tty || return 1; [[ "$a" =~ ^[yYjJ] ]]; fi
}
wt_menu() { # title prompt tag1 item1 tag2 item2 ...   -> echoes chosen tag
  local title="$1" prompt="$2"; shift 2; local v
  if [ "$HAS_WHIP" = 1 ]; then v=$(whiptail --title "$title" --menu "$prompt" 18 66 8 "$@" 3>&1 1>&2 2>&3) || abort
  else
    echo "$prompt" >/dev/tty; local i=1 tags=()
    while [ $# -gt 0 ]; do echo "  $i) $1 — $2" >/dev/tty; tags+=("$1"); shift 2; i=$((i+1)); done
    local s; read -r -p "Choice [1]: " s </dev/tty || abort; s="${s:-1}"; v="${tags[$((s-1))]:-${tags[0]}}"
  fi
  printf '%s' "$v"
}

# ---- storage -----------------------------------------------------------------
# First active storage that supports content type $1 (rootdir | vztmpl).
pick_storage() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}'; }
# Space-separated "tag item tag item …" (items are space-free) for wt_menu.
storage_menu() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active"{printf "%s type:%s,free:%dGiB ", $1, $2, $6/1048576}'; }

# ---- settings ----------------------------------------------------------------
default_settings() {
  CTID="${CTID:-$(pvesh get /cluster/nextid)}"
  CT_HOSTNAME="${CT_HOSTNAME:-phantom-relay}"
  CORES="${CORES:-1}"; RAM="${RAM:-512}"; DISK="${DISK:-2}"
  PASSWORD="${PASSWORD:-$(openssl rand -base64 12)}"
  VERBOSE="${VERBOSE:-no}"
  ROOT_STORE="${ROOT_STORE:-$(pick_storage rootdir)}"
}
advanced_settings() {
  CTID="$(wt_input 'Container ID (VMID)' 'Container / VM ID' "$(pvesh get /cluster/nextid)")"
  CT_HOSTNAME="$(wt_input 'Hostname' 'Container hostname' 'phantom-relay')"
  CORES="$(wt_input 'CPU' 'Number of CPU cores' '1')"
  RAM="$(wt_input 'RAM' 'Memory in MiB' '512')"
  DISK="$(wt_input 'Disk' 'Disk size in GiB' '2')"
  PASSWORD="$(wt_pass 'Root / SSH password' 'Password (leave empty to auto-generate)')"
  [ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 12)"
  if wt_yesno 'Verbose' 'Enable verbose output?'; then VERBOSE="yes"; else VERBOSE="no"; fi
  local sm; sm="$(storage_menu rootdir)"
  [ -n "$sm" ] || { msg_error "No active storage for the container found."; exit 1; }
  # shellcheck disable=SC2086
  ROOT_STORE="$(wt_menu 'Storage' 'Which storage should hold the container?' $sm)"
}

header_info

if [ -t 0 ] && [ -t 1 ]; then
  case "$(wt_menu 'phantom_ Relay – LXC installer' 'Installation mode' \
            default  'Use default settings' \
            advanced 'Configure manually (ID, CPU, RAM, storage, password, verbose)')" in
    advanced) advanced_settings ;;
    default)  default_settings ;;
    *)        abort ;;
  esac
  header_info   # whiptail cleared the screen - redraw the banner above the build log
else
  default_settings
fi

# ---- normalise + resolve storage --------------------------------------------
CTID="${CTID:-$(pvesh get /cluster/nextid)}"; CTID="${CTID//[!0-9]/}"
CORES="${CORES//[!0-9]/}"; CORES="${CORES:-1}"
RAM="${RAM//[!0-9]/}";     RAM="${RAM:-512}"
DISK="${DISK//[!0-9]/}";   DISK="${DISK:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
[ -n "${ROOT_STORE:-}" ] || ROOT_STORE="$(pick_storage rootdir)"
TMPL_STORE="${TMPL_STORE:-$(pick_storage vztmpl)}"
[ -n "$ROOT_STORE" ] || { msg_error "No storage for the container rootfs found."; exit 1; }
[ -n "$TMPL_STORE" ] || { msg_error "No storage for templates found."; exit 1; }
[ "$VERBOSE" = yes ] && STD="" || STD="silent"

echo -e "${DIM}   CTID ${CTID} · ${CT_HOSTNAME} · ${CORES} vCPU · ${RAM} MiB · ${DISK} GiB · storage ${ROOT_STORE} · verbose ${VERBOSE}${CL}\n"

# ---- 1) template -------------------------------------------------------------
msg_info "Refreshing template catalog"
$STD pveam update || true
TEMPLATE="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || TEMPLATE="debian-12-standard_12.7-1_amd64.tar.zst"
msg_ok "Template catalog ready"

if pveam list "$TMPL_STORE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_ok "Template already present ($TEMPLATE)"
else
  msg_info "Downloading template $TEMPLATE"
  $STD pveam download "$TMPL_STORE" "$TEMPLATE"
  msg_ok "Template ready"
fi

# ---- 2) create the container -------------------------------------------------
msg_info "Creating LXC ${CTID} (${CT_HOSTNAME})"
$STD pct create "$CTID" "$TMPL_STORE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$RAM" \
  --rootfs "$ROOT_STORE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 \
  --password "$PASSWORD" --onboot 1
msg_ok "Created LXC ${CTID}"

# WireGuard in the (unprivileged) LXC needs /dev/net/tun passed through.
CONF="/etc/pve/lxc/$CTID.conf"
grep -q "dev/net/tun" "$CONF" 2>/dev/null || cat >> "$CONF" <<EOF
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF

# ---- 3) start + wait for network --------------------------------------------
msg_info "Starting container"
$STD pct start "$CTID"
for _ in $(seq 1 15); do pct exec "$CTID" -- test -e /etc/os-release 2>/dev/null && break; sleep 1; done
msg_ok "Container started"

# ---- 4) install WireGuard + the relay ---------------------------------------
msg_info "Installing WireGuard + phantom_ relay"
$STD pct exec "$CTID" -- bash -c "apt-get update -y && apt-get install -y wireguard curl && curl -fsSL $RAW/install.sh | bash"
msg_ok "phantom_ relay installed"

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
rm -f "$LOGFILE" 2>/dev/null || true

# ---- done --------------------------------------------------------------------
echo ""
msg_ok "Completed successfully!"
echo -e "${GN} Container:${CL}  CT ${CTID} (${CT_HOSTNAME})   root password: ${YW}${PASSWORD}${CL}"
echo -e "${GN} Address:${CL}    http://${IP:-<container-ip>}:8787"
echo ""
echo -e "${BL} Next steps${CL} inside the container (${DIM}pct enter ${CTID}${CL}):"
echo "   1. Put your VPN config in   /etc/wireguard/wg0.conf"
echo "   2. Start the VPN:           systemctl enable --now wg-quick@wg0"
echo "   3. Verify the relay:        node /opt/phantom-relay/server.js --check"
echo ""
