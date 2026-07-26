<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/phantom-logo-dark.svg">
    <img src="brand/phantom-logo-light.svg" alt="phantom_" width="260">
  </picture>
</p>

<p align="center"><b>English</b> · <a href="README.de.md">Deutsch</a></p>

# phantom_ Relay

A tiny, self-hosted proxy that routes **phantom_**'s provider traffic (streams, Xtream API, EPG,
logos) **through your own VPN**. Your IPTV provider then sees your relay's exit IP instead of your
home's public IP.

- **Optional** – phantom_ works without a relay.
- **Self-hosted** – there is no shared server from us. You run it behind your own VPN.
- **No logging** – the relay records **nothing** about your traffic (no access logs, no URLs, no
  IPs). See below.
- **Vendor-neutral** – any VPN (WireGuard, OpenVPN, your provider of choice).
- **Tiny** – `server.js` is plain Node with **zero runtime dependencies**; type-checked via
  `// @ts-check` + JSDoc (TypeScript is dev-only, no build step — the file you read is the file that runs).

---

## ⚖️ Use & disclaimer

The phantom_ Relay is a **general-purpose privacy tool** (a proxy). It provides **no content** – no
channels, playlists or streams.

**You are solely responsible** for using it only with sources you are entitled to, and for
complying with all **applicable laws** and your providers' terms. Do **not** use it for unlawful
purposes. The software is provided **"as is", without warranty** (see License).

---

## What you need

- **A server that stays on:** VPS, NAS, mini-PC, Proxmox LXC, Raspberry Pi …
- **A VPN on that server** – your own WireGuard server or your provider's client config (`.conf`).
  The relay ships **no** VPN; it uses yours.
- **Docker** (easiest) **or Node.js 18+** (standalone).

---

## Install

Pick **one** way. No cloning required.

### A) Docker – one container (recommended)

The published image bundles WireGuard + the relay. Mount your config, set env, run.

```bash
docker run -d --name phantom-relay \
  --cap-add NET_ADMIN --device /dev/net/tun \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -v "$PWD/wg0.conf:/etc/wireguard/wg0.conf:ro" \
  -e RELAY_VPN_IF=wg0 -p 8787:8787 \
  --restart unless-stopped ghcr.io/phantomtv-app/relay:latest
```

Prefer compose? Grab just the file – still no clone:
```bash
curl -O https://raw.githubusercontent.com/phantomtv-app/relay/main/docker-compose.yml
cp /path/to/your/wg0.conf .        # your VPN config next to it
docker compose up -d
```

Change env → `docker compose up -d`. Restart → `docker restart phantom-relay`. Check →
`docker exec phantom-relay node server.js --check`.

*Host already runs a VPN?* Drop the config mount + caps and add `--network host` with
`-e RELAY_VPN_IF=<your-if>`.

### B) Proxmox VE (LXC) – one command

Run **on the Proxmox host**. Creates a Debian LXC and installs WireGuard + the relay:
```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/proxmox-lxc.sh)"
```

### C) Standalone (Debian/Ubuntu, no Docker) – one command

```bash
sudo bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/install.sh)"
```
Installs Node (if needed), the relay to `/opt/phantom-relay` and a `phantom-relay` systemd service.
Config in `/etc/phantom-relay.env`.

---

## Access control

Three modes via `RELAY_AUTH`. **There is no `open` default any more:** if `RELAY_AUTH` is unset (or
invalid), the relay **blocks `/p` entirely** (fail-closed) — you must pick a mode **on purpose**. On
first run `install.sh` automatically sets up `basic` with a **strong random password**.

| Mode | You set | Effect |
|---|---|---|
| _(unset)_ | – | **Deny.** `/p` is blocked (fail-closed). Safe default. |
| `ip` | `RELAY_ALLOW=1.2.3.4,5.6.7.8` | Only these client IPs may use `/p`. |
| `basic` | `RELAY_USER=…` `RELAY_PASS=…` | Username/password. Accepted via `Authorization: Basic` **and** (for `<video>`, which can't set headers) as `?k=<base64(user:pass)>` in the URL. |
| `open` | – (set explicitly) | No protection. **Only** for your own/trusted network. |

`/health` stays open (liveness/status only, no content).

---

## Privacy – no logging

The relay writes **nothing** about your traffic: **no** access logs, **no** requested URLs, **no**
client IPs, **no** stream data – not to files, not to a database. The only console output is **one**
startup banner (port + auth mode, no user data).

The **only** extra outbound call is the egress lookup: the relay looks up its **own** exit IP via
**your own endpoint** (`RELAY_EGRESS_URL`, default `https://phantomtv.app/api/my-ip` — no third party)
for the `/health` display (reveals only the relay's VPN IP, no user data). This lookup is **on by
default** (so the app can show the IP comparison); turn it off with `RELAY_EGRESS_LOOKUP=0` — then the
relay makes **no** extra outbound calls at all.

---

## Configuration — all parameters

Everything is set via environment variables (Docker `-e` / compose `environment`, or
`/etc/phantom-relay.env` for the systemd install). All are optional.

### `PORT`
Default `8787`. TCP port the relay listens on. The address you enter in the app is
`http://<server>:<PORT>`.

### `RELAY_VPN_IF`
Name of the VPN network interface the relay watches for the fail-closed check (e.g. `wg0`, `tun0`).
**Recommended to set explicitly.** If unset, a common interface is auto-detected at start and
pinned; if it later disappears the VPN counts as down. If NO interface can be determined,
fail-closed is inactive (the relay warns at startup) and protection relies on the app's egress
comparison — so set this.

### `RELAY_AUTH`
Access control mode. **No default** — if unset (or invalid) the relay blocks `/p` entirely
(fail-closed, so nothing is accidentally open):
- `ip` — only the client IPs in `RELAY_ALLOW` may use `/p`.
- `basic` — username/password (`RELAY_USER` / `RELAY_PASS`). `install.sh` generates this
  automatically on first run.
- `open` — no protection, must be set **explicitly**. Only for your own/trusted network.

### `RELAY_ALLOW_UNPROTECTED`
For **local development** only. By default the relay blocks `/p` while **no active VPN interface**
is present (fail-closed, see below). With `RELAY_ALLOW_UNPROTECTED=1` that guard is **disabled** and
the relay forwards even **without a VPN** (traffic then leaves via the real IP). **Never set this in
production.**

### `RELAY_ALLOW`
Only for `RELAY_AUTH=ip`. Comma-separated allowed client IPs, e.g. `1.2.3.4,5.6.7.8`. Uses the real
socket peer address (`x-forwarded-for` is never trusted). Empty list = nothing allowed.

### `RELAY_USER` / `RELAY_PASS`
Only for `RELAY_AUTH=basic`. Username and password. Accepted via `Authorization: Basic` **and**
(for `<video>`, which can't set headers) as `?k=<base64(user:pass)>` in the URL — the app appends
this automatically. With `basic` but no credentials set, **all** `/p` requests are blocked
(fail-closed, so a misconfiguration never accidentally opens the relay).

### `RELAY_EGRESS_LOOKUP`
**Default `1` (on).** The relay looks up its **own** exit IP via your own endpoint (see
`RELAY_EGRESS_URL`) and shows it in `/health` (reveals only the VPN IP, no user data, no third party)
so the app can reliably show the IP comparison. Opt out with `RELAY_EGRESS_LOOKUP=0` — then the relay
makes no extra outbound call and the app verifies protection itself via egress comparison.

### `RELAY_EGRESS_URL`
Only relevant while `RELAY_EGRESS_LOOKUP` is on. The "what is my IP" endpoint the relay queries
**through the tunnel** to learn its exit IP. Default `https://phantomtv.app/api/my-ip` (own
infrastructure, no third party); expected response `{"ip":"…","country":"XX"}`. Override for a different deployment.

### `RELAY_PUBLIC_URL`
Fixed public base URL for HLS rewriting, e.g. `https://relay.example`. **Set this behind a reverse
proxy** — then segment/key URLs are rewritten correctly and **cannot be forged via a spoofed `Host`
header**. Without it the `Host` header is used.

### `RELAY_TRUSTED_PROXIES`
Comma-separated proxy IPs whose `X-Forwarded-Proto`/`X-Forwarded-Host` the relay honors for HLS
rewriting. Empty (default) = trust **no** forwarded header. Only needed without `RELAY_PUBLIC_URL`.

### `RELAY_CORS_ORIGIN`
`Access-Control-Allow-Origin` for responses. Default `*` (the app runs under `file://`). Narrow it if
all your clients share a known origin.

### `RELAY_REAL_IP`
Active leak self-check: your host's **real** (non-VPN) public IP. If the measured egress equals it, the
tunnel is **not** effective → `/health` honestly reports `vpn:false` (instead of trusting the interface
presence). It is also the prerequisite for the strong `protected:true` attest in `/health` (only with
`RELAY_REAL_IP` set and the measured egress ≠ the real IP). Requires `RELAY_EGRESS_LOOKUP` on.
`phantom-relay setup` asks for this IP and writes it for you.

### Resource limits (DoS hardening)
All have sensible defaults; `0` disables the concurrency/rate caps.
- `RELAY_MAX_CONCURRENT` (default `128`) — total in-flight `/p` requests.
- `RELAY_RATE_MAX` (default `600`) / `RELAY_RATE_WINDOW_MS` (default `60000`) — per-client rate limit.
- `RELAY_IDLE_TIMEOUT_MS` (default `30000`) — abort an upstream that stops sending data.
- `RELAY_MAX_STREAM_MS` (default `0` = unlimited) — hard per-stream cap; keep `0` for long live streams.

---

## Fail-closed (kill switch)

If the VPN drops, the relay must forward **nothing** – otherwise traffic would leave via the real
IP (a leak). Two layers, **best use both** — the second is the only *real* kill switch:

1. **In the relay (interface guard, not a real kill switch):** `/p` forwards **only** while an
   expected VPN interface is **present and up**. If **no active VPN interface** is known (missing,
   gone, or none detected at all), `/p` returns **HTTP 503** and `/health` reports `vpn:false` — the
   relay forwards **nothing** (hard fail-closed). The only exception is local development via
   `RELAY_ALLOW_UNPROTECTED=1`. This only checks that the tunnel **interface is present** — **not**
   that traffic actually goes through it. Honest extra check: with `RELAY_REAL_IP` (your real non-VPN
   IP) the relay compares the measured egress; if it equals the real IP it reports `vpn:false` even
   when the interface is "up".
2. **At OS level (real kill switch, strongly recommended):** an `nftables`/`iptables` OUTPUT rule that
   **drops** any traffic except via `wg0` (and the handshake to the VPN endpoint). Then no packet can
   escape over the real link on a VPN failure, independent of the relay process.

   Minimal example (`nftables`, replace the placeholder with your VPN endpoint port):
   ```nft
   table inet killswitch {
     chain output {
       type filter hook output priority 0; policy drop;
       oifname "lo" accept
       oifname "wg0" accept
       # allow the WireGuard handshake out (your provider's UDP port):
       udp dport 51820 accept
       ct state established,related accept
       # everything else (non-VPN) hits policy drop
     }
   }
   ```
   Alternatively run the relay in a dedicated **network namespace** that contains ONLY `wg0` (no
   default interface) — then there is no non-VPN egress at all. The standalone `install.sh` also prints
   this recommendation at the end.

---

## In the app & checking

**Settings → Relay**: enter the address (`http://<server>:8787`), save, **"Check relay"**. Green
"Protected" only shows when the exit IP differs from your direct IP – trust by **measurement**.

One command instead of curl juggling:
```bash
phantom-relay --check                                # standalone / Proxmox LXC install
docker exec phantom-relay node server.js --check     # Docker
# -> Relay: running · Protection: PROTECTED (VPN active) · Egress: 203.0.113.10 (Germany, …)
```
Exit code: `0` ok/protected · `1` VPN down · `2` unreachable. (The Docker HEALTHCHECK uses it too.)

---

## Protocol — build your own

The relay is **not required** — it's just a tiny two-endpoint HTTP contract. Don't trust our
binary? Rebuild it in any language, or point phantom_ at any proxy that speaks it.

### `GET /p?u=<url-encoded target url>`
Fetches `target` server-side (through the relay's IP/VPN) and streams the response back 1:1.
- Set `Access-Control-Allow-Origin: *` (the app runs under `file://`).
- Pass the `Range` header through (seeking).
- Rewrite HLS playlists (`.m3u8`) so segment/key URLs go **through `/p` again** (otherwise HLS
  streams escape past the VPN). Not needed for plain `.ts`/`mp4`.
- Status codes: missing `u` → `400`, upstream error → `502`, VPN down → `503`,
  unauthorized → `401` (basic) / `403` (ip), blocked target → `403`.

### `GET /health`
Liveness + protection status as JSON. **Anonymous** callers get only a minimal, non-identifying object:

```json
{ "ok": true, "vpn": true, "protected": true }
```

The **identifying detail fields** (`iface`/`ip`/`clientIp`/`country`/`isp`) are returned **only to an
authorized caller**: valid `?k=`/`Authorization` (in `basic`), an allowlisted client IP (in `ip`), in
`open` mode (deliberately "trusted network"), or a **loopback** caller (local `--check`). So `/health`
no longer leaks the egress IP / interface to arbitrary callers:

```json
{ "ok": true, "vpn": true, "protected": true, "iface": "wg0", "ip": "203.0.113.10", "clientIp": "…", "country": "Germany", "isp": "" }
```

- `vpn`: `true` = tunnel interface **present** (or egress ≠ `RELAY_REAL_IP`), `false` = interface
  **gone** or egress equals the real IP (= unprotected), `null` = unknown (the app then decides via
  egress comparison). **Read honestly:** `vpn:true` means "interface present", not "traffic is
  guaranteed to go through the tunnel" — the real proof is the egress comparison (or `RELAY_REAL_IP`).
- `protected`: **strong protection attest.** `true` only when (a) a VPN interface is active **and**
  (b) the egress self-test passes: `RELAY_REAL_IP` is set **and** the measured egress IP **differs**
  from that real IP. Without `RELAY_REAL_IP`, `protected` stays `false` — the relay never claims
  protection it has not measured (the app then stays opt-out).
- `ip`/`country`/`isp`: the relay's current **exit IP** (only present with `RELAY_EGRESS_LOOKUP` on).
- The app polls `/health` without credentials and relies on `vpn`; the egress **display** in the status
  card appears in `basic`/`ip` mode only if the app sends the token / uses an allowlisted IP.

**Compatibility:** a generic proxy that only speaks `/p` and returns e.g. `404` on `/health` still
works — phantom_ treats **any HTTP response as "reachable"** and determines protection via the
egress comparison (your direct IP vs. the IP through the relay).

## FAQ

**Do I need the relay?** No. phantom_ works without it. It's for routing provider traffic through
your own server behind your VPN.

**Which VPN?** Any – WireGuard, OpenVPN, or your provider's Linux config.

**Is it hosted by you?** No, deliberately. You run it yourself.

**`/health` shows my real IP?** Then traffic bypasses the VPN. Check that `wg0.conf` is mounted and
the tunnel is up (`docker logs phantom-relay`).

**HLS streams break?** Segment/key URLs must go through `/p` again – the bundled `server.js` does
this automatically (including the auth token in `basic` mode).

---

## Security

- **SSRF-safe:** `/p` only proxies `http`/`https` to **public** hosts. Private, loopback, link-local,
  multicast and site-local targets (incl. cloud metadata `169.254.169.254`, `127.0.0.1`,
  `10/172.16/192.168`, IPv6 `::1`/`fc00::/7`/`fe80::/10`/`fec0::/10`/`ff00::/8`, IPv4-mapped/6to4/NAT64)
  are blocked. The checked IP is **pinned**: the connection goes to exactly the validated address (no
  second, unchecked resolution → no DNS rebinding / TOCTOU), with Host header and TLS SNI kept on the
  original host. Every redirect target is re-checked and re-pinned.
- **DoS hardening:** a global concurrency cap + per-client rate limit, playlist size capped **while
  reading**, idle/connect timeouts, and a client disconnect aborts the upstream immediately
  (`RELAY_MAX_CONCURRENT`, `RELAY_RATE_*`, `RELAY_IDLE_TIMEOUT_MS`, `RELAY_MAX_STREAM_MS`).
- **Access:** without `RELAY_AUTH` there is no access control – run it only on your own network.
  Internet-facing → set **`RELAY_AUTH=ip` or `basic`** and put **TLS** in front (a reverse proxy),
  since credentials/`?k` otherwise travel in clear text.
- Your WireGuard `.conf` (private key) must **never** be committed – it is excluded via `.gitignore`.

## License

AGPL-3.0-or-later. Copyright © 2026 phantom_. Full text: [`LICENSE`](./LICENSE). Run a modified
version – even as a network service – and you must make its source available to users.
