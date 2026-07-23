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

Three modes via `RELAY_AUTH` (the app will get matching fields soon):

| Mode | You set | Effect |
|---|---|---|
| `open` (default) | – | No protection. Only for your own/trusted network. |
| `ip` | `RELAY_ALLOW=1.2.3.4,5.6.7.8` | Only these client IPs may use `/p`. |
| `basic` | `RELAY_USER=…` `RELAY_PASS=…` | Username/password. Accepted via `Authorization: Basic` **and** (for `<video>`, which can't set headers) as `?k=<base64(user:pass)>` in the URL. |

`/health` stays open (liveness/status only, no content).

---

## Privacy – no logging

The relay writes **nothing** about your traffic: **no** access logs, **no** requested URLs, **no**
client IPs, **no** stream data – not to files, not to a database. The only console output is **one**
startup banner (port + auth mode, no user data).

By default the relay makes **no** extra outbound calls at all. Optionally, `RELAY_EGRESS_LOOKUP=1`
has it look up its **own** exit IP via `ipwho.is` for the `/health` display (reveals only the
relay's VPN IP, no user data).

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
Access control mode:
- `open` (default) — no protection. Only for your own/trusted network.
- `ip` — only the client IPs in `RELAY_ALLOW` may use `/p`.
- `basic` — username/password (`RELAY_USER` / `RELAY_PASS`).

### `RELAY_ALLOW`
Only for `RELAY_AUTH=ip`. Comma-separated allowed client IPs, e.g. `1.2.3.4,5.6.7.8`. Uses the real
socket peer address (`x-forwarded-for` is never trusted). Empty list = nothing allowed.

### `RELAY_USER` / `RELAY_PASS`
Only for `RELAY_AUTH=basic`. Username and password. Accepted via `Authorization: Basic` **and**
(for `<video>`, which can't set headers) as `?k=<base64(user:pass)>` in the URL — the app appends
this automatically. With `basic` but no credentials set, **all** `/p` requests are blocked
(fail-closed, so a misconfiguration never accidentally opens the relay).

### `RELAY_EGRESS_LOOKUP`
Default `0` (off, for privacy). Set to `1` to have the relay look up its **own** exit IP via
`ipwho.is` and show it in `/health` (reveals only the VPN IP, no user data). With it off, the app
verifies protection itself via egress comparison.

---

## Fail-closed (kill switch)

If the VPN drops, the relay must forward **nothing** – otherwise traffic would leave via the real
IP (a leak). Two layers, best use both:

1. **In the relay:** if `RELAY_VPN_IF` is set and the interface disappears, `/p` returns **HTTP 503**
   and `/health` reports `vpn:false`. phantom_ blocks within seconds.
2. **At OS level:** a WireGuard kill switch (`PostUp`/`PreDown` iptables/nft rules in the `wg`
   config) that drops any non-VPN traffic.

---

## In the app & checking

**Settings → Relay**: enter the address (`http://<server>:8787`), save, **"Check relay"**. Green
"Protected" only shows when the exit IP differs from your direct IP – trust by **measurement**.

One command instead of curl juggling:
```bash
docker exec phantom-relay node server.js --check   # or: node server.js --check  /  npm run check
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
Liveness + protection status as JSON (with `Access-Control-Allow-Origin: *`):

```json
{ "ok": true, "vpn": true, "iface": "wg0", "ip": "203.0.113.10", "country": "Germany", "isp": "Example VPN" }
```

- `vpn`: `true` = interface up, `false` = expected interface **gone** (= unprotected),
  `null` = unknown (the app then decides via egress comparison).
- `ip`/`country`/`isp`: the relay's current **exit IP** (only present with `RELAY_EGRESS_LOOKUP=1`).

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

- **SSRF-safe:** `/p` only proxies `http`/`https` to **public** hosts. Private, loopback and
  link-local targets (incl. cloud metadata `169.254.169.254`, `127.0.0.1`, `10/172.16/192.168`) are
  blocked; redirects are re-checked. So it can't be abused to reach internal services.
- **Access:** without `RELAY_AUTH` there is no access control – run it only on your own network.
  Internet-facing → set **`RELAY_AUTH=ip` or `basic`** and put **TLS** in front (a reverse proxy),
  since credentials/`?k` otherwise travel in clear text.
- Your WireGuard `.conf` (private key) must **never** be committed – it is excluded via `.gitignore`.

## License

AGPL-3.0-or-later. Copyright © 2026 phantom_. Full text: [`LICENSE`](./LICENSE). Run a modified
version – even as a network service – and you must make its source available to users.
