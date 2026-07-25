#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 phantom_
#
# phantom_ Relay - Proxmox VE installer (community-scripts style).
# Run on the PROXMOX HOST as root:
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/proxmox-lxc.sh)"
#
# Interactive: choose "Default" or "Advanced" (CTID/VMID, CPU, RAM, disk, storage, network/IP,
# gateway, root password, verbose yes/no). Creates an unprivileged, WireGuard-capable Debian LXC
# and installs the phantom_ relay + systemd.
#
# In non-verbose mode ALL command output is hidden (only the progress spinner + result show);
# turn Verbose on (or VERBOSE=yes) to see everything.
#
# Non-interactive (no TTY, e.g. CI): uses defaults, overridable via ENV
#   CTID CT_HOSTNAME CORES RAM DISK BRIDGE NET_IP NET_GW PASSWORD VERBOSE ROOT_STORE TMPL_STORE
set -euo pipefail

RAW="https://raw.githubusercontent.com/phantomtv-app/relay/main"
LOGFILE="$(mktemp 2>/dev/null || echo "/tmp/phantom-relay.$$.log")"
VERBOSE="${VERBOSE:-no}"; SPIN_PID=""

# fd 3 is the console: progress, spinner, banner and the final summary always go here. In
# non-verbose mode stdout/stderr are later redirected into $LOGFILE, so raw command output vanishes.
exec 3>&1

# ---- colours (based on the console, fd 3) -----------------------------------
if [ -t 3 ]; then
  YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'; DIM=$'\033[2m'; CL=$'\033[m'
else
  YW=''; GN=''; RD=''; BL=''; DIM=''; CL=''
fi
CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"; INFO="${BL}➜${CL}"

# ---- console output + spinner + messages ------------------------------------
con()      { echo -e "$1" >&3; }
_spin()    { local f='-\|/' i=0; while :; do i=$(((i+1)%4)); printf "\r ${BL}%s${CL} ${YW}%s…${CL}" "${f:$i:1}" "$1" >&3; sleep 0.15; done; }
_spin_on() { { [ -t 3 ] && [ "$VERBOSE" = no ]; } || return 0; _spin "$1" & SPIN_PID=$!; disown 2>/dev/null || true; }
_spin_off(){ [ -n "$SPIN_PID" ] && { kill "$SPIN_PID" 2>/dev/null || true; SPIN_PID=""; printf "\r\033[K" >&3; }; return 0; }
msg_info() { if [ -t 3 ] && [ "$VERBOSE" = no ]; then _spin_on "$1"; else con " ${INFO} ${YW}$1…${CL}"; fi; }
msg_ok()   { _spin_off; con " ${CM} ${GN}$1${CL}"; }
msg_error(){ _spin_off; con " ${CROSS} ${RD}$1${CL}"; }
trap 'rc=$?; _spin_off; con " ${CROSS} ${RD}Aborted (line ${LINENO}, code ${rc}).${CL}"; { [ "${VERBOSE}" = no ] && [ -s "${LOGFILE:-/dev/null}" ]; } && { con "---- last output ----"; tail -n 20 "${LOGFILE}" >&3; }; exit "${rc}"' ERR

header_info() {
  { clear 2>/dev/null || true
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
  } >&3
}

# ---- preconditions ----------------------------------------------------------
command -v pct >/dev/null 2>&1 || { echo "This script belongs on the Proxmox VE host (pct is missing)." >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

# ---- prompts (plain text via /dev/tty - NO ncurses/whiptail, so no rendering artifacts anywhere) --
abort() { msg_error "Aborted."; rm -f "$LOGFILE" 2>/dev/null || true; exit 1; }

# ask "question" "default"  -> echoes the answer (the default when the input is empty)
ask() {
  local a
  printf " ${BL}?${CL} %s ${DIM}[%s]${CL}: " "$1" "$2" >/dev/tty
  read -r a </dev/tty || abort
  printf '%s' "${a:-$2}"
}
# ask_pass "question"  -> echoes the answer (input hidden; may be empty)
ask_pass() {
  local a
  printf " ${BL}?${CL} %s ${DIM}(empty = auto-generate)${CL}: " "$1" >/dev/tty
  read -r -s a </dev/tty || abort; printf '\n' >/dev/tty
  printf '%s' "$a"
}
# ask_yesno "question" y|n  -> returns 0 for yes
ask_yesno() {
  local a hint
  [ "$2" = y ] && hint='Y/n' || hint='y/N'
  printf " ${BL}?${CL} %s ${DIM}[%s]${CL}: " "$1" "$hint" >/dev/tty
  read -r a </dev/tty || abort; a="${a:-$2}"
  [[ "$a" =~ ^[yYjJ] ]]
}
# ask_menu "question" tag1 label1 tag2 label2 ...  -> echoes the chosen tag
ask_menu() {
  local prompt="$1"; shift
  local tags=() labels=()
  while [ "$#" -ge 2 ]; do tags+=("$1"); labels+=("$2"); shift 2; done
  printf " ${BL}?${CL} %s\n" "$prompt" >/dev/tty
  local i
  for i in "${!tags[@]}"; do printf "     ${GN}%s${CL}) %s\n" "$((i + 1))" "${labels[i]}" >/dev/tty; done
  local s
  printf "   ${DIM}Selection [1]${CL}: " >/dev/tty
  read -r s </dev/tty || abort; s="${s:-1}"
  { [[ "$s" =~ ^[0-9]+$ ]] && [ "$s" -ge 1 ] && [ "$s" -le "${#tags[@]}" ]; } || s=1
  printf '%s' "${tags[$((s - 1))]}"
}

# ---- storage -----------------------------------------------------------------
# First active storage that supports content type $1 (rootdir | vztmpl).
pick_storage() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}'; }

# ---- settings ----------------------------------------------------------------
default_settings() {
  CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null)}"
  CT_HOSTNAME="${CT_HOSTNAME:-phantom-relay}"
  CORES="${CORES:-1}"; RAM="${RAM:-512}"; DISK="${DISK:-2}"
  NET_IP="${NET_IP:-dhcp}"; NET_GW="${NET_GW:-}"
  PASSWORD="${PASSWORD:-$(openssl rand -base64 12)}"
  VERBOSE="${VERBOSE:-no}"
  ROOT_STORE="${ROOT_STORE:-$(pick_storage rootdir)}"
}
advanced_settings() {
  CTID="$(ask 'Container ID (VMID)' "$(pvesh get /cluster/nextid 2>/dev/null)")"
  CT_HOSTNAME="$(ask 'Hostname' 'phantom-relay')"
  CORES="$(ask 'CPU cores' '1')"
  RAM="$(ask 'Memory in MiB' '512')"
  DISK="$(ask 'Disk size in GiB' '2')"
  # Storage picker: build "tag label" pairs from the active rootdir storages.
  local args=() tag typ av
  while read -r tag typ _ _ _ av _; do
    av="${av//[!0-9]/}"
    args+=("$tag" "$tag  (${typ}, $(( ${av:-0} / 1048576 )) GiB free)")
  done < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"')
  [ "${#args[@]}" -gt 0 ] || { msg_error "No active storage for the container found."; exit 1; }
  ROOT_STORE="$(ask_menu 'Which storage should hold the container?' "${args[@]}")"
  NET_IP="$(ask 'IPv4 as CIDR (e.g. 192.168.1.50/24) or "dhcp"' 'dhcp')"
  NET_GW=""
  [ "$NET_IP" = dhcp ] || NET_GW="$(ask 'Gateway IP' '')"
  PASSWORD="$(ask_pass 'Root / SSH password')"
  [ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 12)"
  if ask_yesno 'Show full output (verbose)?' n; then VERBOSE="yes"; else VERBOSE="no"; fi
}

# Plain-text banner + menu (no ncurses). Safe to draw the banner first now.
header_info

if [ -t 0 ] && [ -t 1 ]; then
  case "$(ask_menu 'Installation mode:' \
            default  'Use default settings' \
            advanced 'Configure manually (ID, CPU, RAM, storage, IP, password, verbose)')" in
    advanced) advanced_settings ;;
    *)        default_settings ;;
  esac
else
  default_settings
fi

# ---- normalise + resolve storage + network ----------------------------------
CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null)}"; CTID="${CTID//[!0-9]/}"
CORES="${CORES//[!0-9]/}"; CORES="${CORES:-1}"
RAM="${RAM//[!0-9]/}";     RAM="${RAM:-512}"
DISK="${DISK//[!0-9]/}";   DISK="${DISK:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_IP="${NET_IP:-dhcp}";  NET_GW="${NET_GW:-}"
[ -n "${ROOT_STORE:-}" ] || ROOT_STORE="$(pick_storage rootdir)"
TMPL_STORE="${TMPL_STORE:-$(pick_storage vztmpl)}"
[ -n "$ROOT_STORE" ] || { msg_error "No storage for the container rootfs found."; exit 1; }
[ -n "$TMPL_STORE" ] || { msg_error "No storage for templates found."; exit 1; }

if [ "$NET_IP" = dhcp ]; then
  NET0="name=eth0,bridge=$BRIDGE,ip=dhcp"
else
  NET0="name=eth0,bridge=$BRIDGE,ip=$NET_IP"; [ -n "$NET_GW" ] && NET0="$NET0,gw=$NET_GW"
fi

# From here on: in non-verbose mode send everything to the log; the console keeps only fd 3.
[ "$VERBOSE" = yes ] || exec >>"$LOGFILE" 2>&1

con "${DIM}   CTID ${CTID} · ${CT_HOSTNAME} · ${CORES} vCPU · ${RAM} MiB · ${DISK} GiB · storage ${ROOT_STORE}"
con "${DIM}   net ${NET_IP}${NET_GW:+ gw ${NET_GW}} · bridge ${BRIDGE} · verbose ${VERBOSE}${CL}\n"

# ---- 1) pick the latest available Debian template ---------------------------
msg_info "Selecting the latest Debian template"
pveam update || true
# newest debian-<N>-standard from the catalog (major + point release compared naturally).
# '|| true' keeps an empty result from tripping set -e/pipefail so the checks below can react.
TEMPLATE="$(pveam available --section system 2>/dev/null | awk '$2 ~ /^debian-[0-9]+-standard/{print $2}' | sort -V | tail -1 || true)"
# otherwise the newest debian-standard already downloaded on the template storage
[ -n "$TEMPLATE" ] || TEMPLATE="$(pveam list "$TMPL_STORE" 2>/dev/null | grep -oE 'debian-[0-9]+-standard[^[:space:]]*' | sort -V | tail -1 || true)"
[ -n "$TEMPLATE" ] || { msg_error "No Debian standard template available (check network / run 'pveam update')."; exit 1; }
msg_ok "Latest template: $TEMPLATE"

if pveam list "$TMPL_STORE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_ok "Template already present"
else
  msg_info "Downloading template $TEMPLATE"
  pveam download "$TMPL_STORE" "$TEMPLATE"
  msg_ok "Template ready"
fi

# ---- 2) create the container -------------------------------------------------
msg_info "Creating LXC ${CTID} (${CT_HOSTNAME})"
pct create "$CTID" "$TMPL_STORE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$RAM" \
  --rootfs "$ROOT_STORE:$DISK" \
  --net0 "$NET0" \
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
pct start "$CTID"
for _ in $(seq 1 15); do pct exec "$CTID" -- test -e /etc/os-release 2>/dev/null && break; sleep 1; done
msg_ok "Container started"

# ---- 4) install WireGuard + the relay ---------------------------------------
# Two things matter here:
#  1) Run install.sh from a FILE, never piped as 'curl ... | bash'. With a pipe the script arrives
#     on STDIN; the moment apt/dpkg (or any sub-command) reads from stdin it swallows the REST of the
#     script text, so bash silently skips everything after that point (e.g. the phantom-relay CLI
#     wrapper) and STILL exits 0 -> "installed" but 'phantom-relay: command not found'. A file +
#     stdin from /dev/null makes the whole script execute deterministically.
#  2) Install ONLY wireguard + curl here - NOT resolvconf. Installing resolvconf replaces
#     /etc/resolv.conf with an initially EMPTY managed file, killing DNS; the very next 'curl' (to
#     fetch install.sh) would then fail with "Could not resolve host". install.sh installs resolvconf
#     itself and restores DNS immediately after, so DNS stays intact through this download.
msg_info "Installing WireGuard + phantom_ relay"
pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y wireguard curl && curl -fsSL $RAW/install.sh -o /root/phantom-install.sh && bash /root/phantom-install.sh </dev/null && rm -f /root/phantom-install.sh"
msg_ok "phantom_ relay installed"

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"

# ---- done --------------------------------------------------------------------
con ""
msg_ok "Completed successfully!"
con "${GN} Container:${CL}  CT ${CTID} (${CT_HOSTNAME})   root password: ${YW}${PASSWORD}${CL}"
con "${GN} Address:${CL}    http://${IP:-<container-ip>}:8787"
con ""
con " The phantom_ relay runs as the ${BL}phantom-relay${CL} systemd service. To add your VPN:"
con ""
con "     ${GN}pct enter ${CTID}${CL}   then   ${GN}phantom-relay setup${CL}"
con ""
con " That opens your WireGuard config, starts the VPN and verifies the relay."
con " Afterwards enter  ${BL}http://${IP:-<container-ip>}:8787${CL}  in the app."
con ""
rm -f "$LOGFILE" 2>/dev/null || true
