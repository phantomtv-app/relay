// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 phantom_
// @ts-check
//
// phantom_ Relay – minimal stream proxy with VPN fail-closed and optional access control.
//
// Purpose: The webOS app cannot bring up a VPN itself. Running this relay behind a VPN
// (WireGuard/OpenVPN on a VPS, NAS, LXC …) makes ALL of the app's requests (streams, Xtream API,
// EPG, logos) leave the house via the relay's VPN IP. The app rewrites every provider URL to /p?u=<URL>.
//
// PRIVACY – NO LOGGING: writes NOTHING about the traffic (no access logs, no URLs, no client IPs).
// The only console.log is a startup banner (port + auth mode). Nothing else is ever logged.
//
// SSRF PROTECTION: /p only proxies http/https and NEVER private/loopback/link-local targets
// (127.x, 10/172.16/192.168, 169.254 cloud metadata, IPv6 ULA/link-local/multicast/site-local).
// The resolved address is PINNED: the socket connects to exactly the IP we validated (no second,
// unchecked DNS lookup between check and connect -> no DNS-rebinding / TOCTOU). Host header + TLS
// SNI keep the original hostname. Every redirect target is re-checked and re-pinned.
//
// FAIL-CLOSED: /p forwards ONLY while an expected VPN interface is present AND up. If no VPN
// interface is known/active (missing, gone, or none detected at all), /p refuses everything
// (HTTP 503) - unless RELAY_ALLOW_UNPROTECTED=1 is set (dev opt-out). NOTE: this is an
// INTERFACE-PRESENCE guard, not a true OS kill switch. For a real kill switch add an
// nftables/namespace OUTPUT-deny for everything except the tunnel (see README.de.md "Kill-Switch").
//
// RESOURCE LIMITS: global concurrency cap, simple per-client rate limit, playlist size cap enforced
// while reading, idle + connect timeouts, abort on client disconnect. See the RELAY_* ENV below.
//
// Configuration (all optional, via ENV):
//   PORT=8787
//   RELAY_VPN_IF=wg0        VPN interface. Recommended to set explicitly (unambiguous fail-closed).
//   RELAY_ALLOW_UNPROTECTED=1  DEV ONLY: disable the VPN fail-closed guard (forward without a VPN).
//   RELAY_AUTH=ip|basic|open  Access control. NO default -> if unset (or invalid), /p is DENIED.
//     ip:    RELAY_ALLOW=1.2.3.4,5.6.7.8   allowed client IPs
//     basic: RELAY_USER=... RELAY_PASS=...  username/password (WITHOUT them, EVERYTHING is blocked)
//     open:  no access control (trusted LAN only) - must be set EXPLICITLY.
//   RELAY_PUBLIC_URL=https://relay.example   fixed public base for HLS rewriting (recommended when
//                           behind a reverse proxy; otherwise the Host header is used).
//   RELAY_TRUSTED_PROXIES=  comma list of proxy IPs whose X-Forwarded-Proto/-Host are honored.
//   RELAY_CORS_ORIGIN=*     Access-Control-Allow-Origin (default *; narrow it if you can).
//   RELAY_REAL_IP=          the host's real (non-VPN) public IP; if the measured egress equals it,
//                           the tunnel is not effective -> /health reports vpn:false (active check).
//                           OPTIONAL extra leak veto on top of the routing proof (see below).
//   RELAY_MAX_CONCURRENT=128   global in-flight /p cap (0 = unlimited).
//   RELAY_MAX_PLAYLIST_BYTES=8388608  HLS manifests are buffered in memory to rewrite them -> size cap.
//   RELAY_RATE_MAX=600         per-client /p requests per window (0 = disabled).
//   RELAY_RATE_WINDOW_MS=60000 rate-limit window.
//   RELAY_IDLE_TIMEOUT_MS=30000 abort an upstream that stops sending data.
//   RELAY_MAX_STREAM_MS=0      hard cap for a single stream (0 = unlimited; keep 0 for live TV).
//   RELAY_EGRESS_LOOKUP=1   show the relay's own exit IP in /health, looked up via RELAY_EGRESS_URL
//                           (phantom_'s endpoint, default https://phantomtv.app/api/my-ip). Default
//                           OFF (opt-in with =1); enables the app's own-IP-vs-relay-IP comparison and
//                           the extra RELAY_REAL_IP leak veto. The 'protected' attest does NOT need it
//                           (it rests on the interface-name + routing proof).
//
// No runtime dependencies (Node 18+ with global fetch).

const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const dns = require('node:dns').promises;
const child_process = require('node:child_process');
const {pipeline, Readable} = require('node:stream');

/**
 * Non-negative integer from ENV, or a default.
 * @param {string} name
 * @param {number} def
 * @returns {number}
 */
function intEnv (name, def) {
	const v = parseInt(process.env[name] || '', 10);
	return Number.isFinite(v) && v >= 0 ? v : def;
}

const PORT = process.env.PORT || 8787;
const UPSTREAM_TIMEOUT = intEnv('RELAY_UPSTREAM_TIMEOUT_MS', 20000); // connect + time-to-headers cap
const IDLE_TIMEOUT = intEnv('RELAY_IDLE_TIMEOUT_MS', 30000);         // no-data-for-this-long -> abort
const MAX_STREAM_MS = intEnv('RELAY_MAX_STREAM_MS', 0);             // 0 = unlimited (live TV runs long)
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = intEnv('RELAY_MAX_PLAYLIST_BYTES', 8 * 1024 * 1024); // manifests are read into memory -> cap the size
// Content-sniff prefix (media mode only): enough to skip a UTF-8 BOM + leading whitespace and read the
// "#EXTM3U" header marker, which is ALWAYS the first line of any M3U/HLS manifest. A tiny prefix
// suffices (there is no need to search deep into the body) -> no "comment before the first tag" bypass.
// On a hit the full body is buffered (up to MAX_PLAYLIST_BYTES) and rewritten anyway.
const SNIFF_BYTES = 1024;
const MAX_CONCURRENT = intEnv('RELAY_MAX_CONCURRENT', 128);          // global in-flight /p cap (0=off)
const RATE_MAX = intEnv('RELAY_RATE_MAX', 600);                      // per-client /p per window (0=off)
const RATE_WINDOW_MS = intEnv('RELAY_RATE_WINDOW_MS', 60000);

const CORS_ORIGIN = process.env.RELAY_CORS_ORIGIN || '*';
const PUBLIC_URL = (process.env.RELAY_PUBLIC_URL || '').replace(/\/+$/, '');
const TRUSTED_PROXIES = (process.env.RELAY_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
const REAL_IP = (process.env.RELAY_REAL_IP || '').trim();

// Dev opt-out for the VPN fail-closed guard. When set, /p forwards even WITHOUT an active VPN
// interface (traffic may leave via the real IP). NEVER set this in production.
const ALLOW_UNPROTECTED = /^(1|on|true|yes)$/i.test(process.env.RELAY_ALLOW_UNPROTECTED || '');

// --- Access control: ip | basic | open (NO default -> unset means deny) --------
// SECURITY: there is deliberately NO 'open' default. If RELAY_AUTH is unset (or invalid), the mode
// is 'deny' and every /p request is refused (fail-closed). 'open' (no protection) must be opted in.
const AUTH_MODE = (process.env.RELAY_AUTH || 'deny').toLowerCase();
const ALLOW_IPS = (process.env.RELAY_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUTH_USER = process.env.RELAY_USER || '';
const AUTH_PASS = process.env.RELAY_PASS || '';
// Bekannte Platzhalter-/Schwachpasswörter (aus .env.example, Anleitungen, üblichen Defaults). Wer
// .env.example kopiert und den Port öffnet, hätte sonst ein Relay mit ÖFFENTLICH bekannten Zugangs-
// daten. Nur das PASSWORT wird geprüft (der User 'phantom' ist unbedenklich). Case-insensitiv.
const KNOWN_WEAK_PASS = ['change-me', 'changeme', 'change-me-please', 'changemeplease', 'password',
	'passwort', 'admin', 'phantom', 'secret', 'geheim', 'test', '1234', 'changeme123'];
const PASS_IS_WEAK = !AUTH_PASS || KNOWN_WEAK_PASS.includes(AUTH_PASS.toLowerCase());
// FAIL-CLOSED bei bekanntem Platzhalter: im basic-Modus wird AUTH_K geleert -> authOk() liefert wegen
// !AUTH_K immer false, also blockiert /p ALLES (statt mit öffentlich bekannten Credentials zu öffnen).
// Der vom install.sh erzeugte 48-Hex-Zufallswert ist davon NICHT betroffen.
const AUTH_K = (AUTH_MODE === 'basic' && PASS_IS_WEAK)
	? ''
	: ((AUTH_USER || AUTH_PASS) ? Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64') : '');
if (AUTH_MODE === 'basic' && PASS_IS_WEAK) {
	// eslint-disable-next-line no-console
	console.error('RELAY_PASS ist ein bekannter Platzhalter/leer -> Basic-Auth fail-closed; bitte ein echtes Passwort setzen (der Installer erzeugt eins automatisch).');
}

/**
 * Constant-time string comparison (guards the length first, since timingSafeEqual throws on mismatch).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual (a, b) {
	const ba = Buffer.from(String(a));
	const bb = Buffer.from(String(b));
	return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * The client's source IP (x-forwarded-for is NOT trusted). Normalizes IPv4-mapped IPv6.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function clientIp (req) {
	const ra = (req.socket && req.socket.remoteAddress) || '';
	return ra.replace(/^::ffff:/, '');
}

/**
 * Loopback client (same host) – trusted for /health details even without credentials.
 * @param {string} ip
 * @returns {boolean}
 */
function isLoopback (ip) {
	return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

/**
 * Is this request authorized for /p? open -> always; ip -> allowlist; basic -> credentials.
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @returns {boolean}
 */
function authOk (req, url) {
	// ip mode matches the REAL TCP peer (clientIp never trusts X-Forwarded-For). Behind a reverse proxy
	// the peer is the proxy IP -> allowlisting it authorizes every client behind it; prefer basic there.
	if (AUTH_MODE === 'ip') return ALLOW_IPS.length > 0 && ALLOW_IPS.includes(clientIp(req));
	if (AUTH_MODE === 'basic') {
		// FAIL-CLOSED: basic without configured credentials blocks EVERYTHING (rather than accidentally open).
		if (!AUTH_K) return false;
		const h = req.headers.authorization || '';
		if (h.startsWith('Basic ') && safeEqual(h.slice(6).trim(), AUTH_K)) return true;
		const k = url.searchParams.get('k');
		return !!(k && safeEqual(k, AUTH_K));
	}
	if (AUTH_MODE === 'open') return true;
	// 'deny' (unset RELAY_AUTH) or an unknown/typo'd mode (e.g. RELAY_AUTH=bsic) -> FAIL-CLOSED,
	// never accidentally open.
	return false;
}

// --- SSRF protection: target validation ---------------------------------------
/**
 * Parse a strict dotted-quad IPv4 literal to four octets, or null.
 * @param {string} s
 * @returns {number[]|null}
 */
function parseIPv4 (s) {
	const m = String(s).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const b = [+m[1], +m[2], +m[3], +m[4]];
	return b.every((x) => x <= 255) ? b : null;
}

/**
 * Parse an IPv6 literal (incl. embedded IPv4 and `::` compression) to 16 bytes, or null.
 * Normalizes unusual textual forms so IPv4-mapped/compatible tricks cannot slip past the blocklist.
 * @param {string} input
 * @returns {Uint8Array|null}
 */
function parseIPv6 (input) {
	let s = String(input).toLowerCase();
	const pct = s.indexOf('%');
	if (pct !== -1) s = s.slice(0, pct); // strip zone id
	if (s === '' || s === ':' || /[^0-9a-f:.]/.test(s)) return null;
	// Embedded IPv4 in the last group (e.g. ::ffff:1.2.3.4) -> rewrite to two hex groups.
	const lastColon = s.lastIndexOf(':');
	const tail = lastColon >= 0 ? s.slice(lastColon + 1) : s;
	if (tail.includes('.')) {
		const v4 = parseIPv4(tail);
		if (!v4 || lastColon < 0) return null;
		const g1 = ((v4[0] << 8) | v4[1]).toString(16);
		const g2 = ((v4[2] << 8) | v4[3]).toString(16);
		s = s.slice(0, lastColon + 1) + g1 + ':' + g2;
	}
	const halves = s.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const tailArr = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
	/** @type {string[]} */
	let groups;
	if (tailArr === null) {
		if (head.length !== 8) return null; // no '::' -> must be exactly 8 groups
		groups = head;
	} else {
		const missing = 8 - (head.length + tailArr.length);
		if (missing < 1) return null; // '::' must stand for at least one group
		groups = head.concat(new Array(missing).fill('0'), tailArr);
	}
	if (groups.length !== 8) return null;
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		const g = groups[i];
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		const v = parseInt(g, 16);
		bytes[i * 2] = (v >> 8) & 0xff;
		bytes[i * 2 + 1] = v & 0xff;
	}
	return bytes;
}

/**
 * True if the IPv4 octets fall into a private/reserved/special range.
 * @param {number} a @param {number} b @param {number} c @param {number} d
 * @returns {boolean}
 */
function blockedV4 (a, b, c, d) {
	if (a === 0 || a === 127 || a === 10) return true;      // "this" / loopback / RFC1918
	if (a === 172 && b >= 16 && b <= 31) return true;       // RFC1918
	if (a === 192 && b === 168) return true;                // RFC1918
	if (a === 169 && b === 254) return true;                // link-local + cloud metadata
	if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT (RFC6598)
	if (a === 192 && b === 0 && c === 0) return true;       // 192.0.0.0/24 IETF protocol assignments
	if (a === 192 && b === 0 && c === 2) return true;       // 192.0.2.0/24 TEST-NET-1 (documentation)
	if (a === 198 && b === 51 && c === 100) return true;    // 198.51.100.0/24 TEST-NET-2 (documentation)
	if (a === 203 && b === 0 && c === 113) return true;     // 203.0.113.0/24 TEST-NET-3 (documentation)
	if (a === 198 && (b === 18 || b === 19)) return true;   // 198.18.0.0/15 benchmarking
	if (a >= 224) return true;                              // multicast / 240/4 reserved / 255.255.255.255 broadcast
	return false;
}

/**
 * True if the 16-byte IPv6 address falls into a blocked/special range (incl. embedded-IPv4 tricks).
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function blockedV6 (b) {
	const b0 = b[0]; const b1 = b[1];
	// IPv4-mapped ::ffff:0:0/96 -> validate the embedded IPv4.
	let z10 = true; for (let i = 0; i < 10; i++) { if (b[i] !== 0) { z10 = false; break; } }
	if (z10 && b[10] === 0xff && b[11] === 0xff) return blockedV4(b[12], b[13], b[14], b[15]);
	// ::/96 (unspecified, loopback, IPv4-compatible – all special/deprecated) -> block.
	let z12 = true; for (let i = 0; i < 12; i++) { if (b[i] !== 0) { z12 = false; break; } }
	if (z12) return true;
	// NAT64 well-known prefix 64:ff9b::/96 -> validate the embedded IPv4.
	if (b0 === 0x00 && b1 === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
		let z = true; for (let i = 4; i < 12; i++) { if (b[i] !== 0) { z = false; break; } }
		if (z) return blockedV4(b[12], b[13], b[14], b[15]);
	}
	if (b0 === 0x20 && b1 === 0x02) return blockedV4(b[2], b[3], b[4], b[5]); // 6to4 2002::/16 -> embedded v4
	if (b0 === 0x20 && b1 === 0x01 && b[2] === 0x00 && b[3] === 0x00) {      // Teredo 2001::/32 -> de-XOR embedded v4
		return blockedV4(b[12] ^ 0xff, b[13] ^ 0xff, b[14] ^ 0xff, b[15] ^ 0xff);
	}
	if (b0 === 0x20 && b1 === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
	if ((b0 & 0xfe) === 0xfc) return true;                    // fc00::/7 ULA
	if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;     // fe80::/10 link-local
	if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true;     // fec0::/10 site-local (deprecated)
	if (b0 === 0xff) return true;                             // ff00::/8 multicast
	if (b0 === 0x01 && b1 === 0x00) {                         // 100::/64 discard-only
		let z = true; for (let i = 2; i < 8; i++) { if (b[i] !== 0) { z = false; break; } }
		if (z) return true;
	}
	return false;
}

/**
 * True if the IP is in a private/loopback/link-local/reserved range the relay must never reach.
 * Unparseable literals are blocked (fail-safe). Callers pass IP literals or resolved addresses.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIp (ip) {
	if (!ip) return true;
	let s = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '');
	const pct = s.indexOf('%');
	if (pct !== -1) s = s.slice(0, pct);
	const v4 = parseIPv4(s);
	if (v4) return blockedV4(v4[0], v4[1], v4[2], v4[3]);
	if (s.includes(':')) {
		const bytes = parseIPv6(s);
		return bytes ? blockedV6(bytes) : true;
	}
	return true; // not an IP literal -> block (only IPs are passed here)
}

/** @typedef {{ip: string, family: number}} Pin */

/**
 * Whether a URL host is an IP literal (used to skip SNI for IPs).
 * @param {string} host
 * @returns {boolean}
 */
function isIpLiteral (host) {
	return !!parseIPv4(host) || host.includes(':');
}

/**
 * Resolve a URL's host to a SINGLE validated IP to pin the connection to. Returns null if the target
 * is blocked. For hostnames, EVERY resolved address must be public (prevents split-horizon rebinding),
 * and the first is pinned. This is the only resolution that happens – the socket connects to this IP.
 * @param {URL} u
 * @returns {Promise<Pin|null>}
 */
async function resolvePinned (u) {
	const host = u.hostname.replace(/^\[|\]$/g, '');
	// In protected mode (the default) ONLY IPv4 is proven to leave via the tunnel: the routing proof
	// uses `ip route get 1.1.1.1` (IPv4). Native IPv6 egress could bypass an IPv4-only tunnel and leak
	// the host's real IPv6 despite protected:true. So restrict the proxy to IPv4 unless the operator
	// explicitly opted out (dev). A target that resolves ONLY to IPv6 is then deliberately unreachable
	// (fail-closed) rather than a potential leak.
	const allowV6 = ALLOW_UNPROTECTED;
	if (isIpLiteral(host)) {
		if (isBlockedIp(host)) return null;
		const family = host.includes(':') ? 6 : 4;
		if (family === 6 && !allowV6) return null;
		return {ip: host, family};
	}
	let addrs;
	try {
		addrs = await dns.lookup(host, {all: true});
	} catch (_e) {
		return null;
	}
	if (!addrs.length) return null;
	if (!addrs.every((a) => !isBlockedIp(a.address))) return null;
	const a = allowV6 ? addrs[0] : (addrs.find((x) => x.family === 4) || null);
	if (!a) return null;
	return {ip: a.address, family: a.family};
}

// --- Determine & monitor the VPN interface ------------------------------------
const VPN_IF_RE = /^(wg[-\d]|tun\d|vpn\d|wireguard)/i;

/**
 * Auto-detect a common VPN interface name (WireGuard `wg0`/`wg-…`, OpenVPN `tun0`).
 * @returns {string|null}
 */
function detectVpnIf () {
	const ifs = os.networkInterfaces();
	return Object.keys(ifs).find((n) => VPN_IF_RE.test(n) && (ifs[n] || []).some((a) => !a.internal)) || null;
}
const EXPECTED_IF = process.env.RELAY_VPN_IF || detectVpnIf();

/**
 * Is this interface name a plausible VPN TUNNEL (WireGuard/OpenVPN/…)? An ordinary uplink like
 * eth0/enp3s0/wlan0 must NEVER count as a VPN, otherwise the fail-closed guard could be satisfied by
 * routing over the real link. Reuses VPN_IF_RE (wg / tun / vpn / wireguard) so name rules live in one place.
 * @param {string|null} iface
 * @returns {boolean}
 */
function isTunnelName (iface) {
	return !!iface && VPN_IF_RE.test(iface);
}

/**
 * Current state of the expected VPN interface. NOTE: this only proves the interface EXISTS and has a
 * non-internal address – it is not proof that egress traffic actually leaves through the tunnel.
 * @returns {{known: boolean, up: boolean, iface: string|null}}
 */
function vpnState () {
	if (!EXPECTED_IF) return {known: false, up: false, iface: null};
	const addrs = os.networkInterfaces()[EXPECTED_IF];
	const up = !!(addrs && addrs.some((a) => !a.internal));
	return {known: true, up, iface: EXPECTED_IF};
}

// --- Routing proof: does traffic to a public target actually leave via the tunnel? -------------
// The interface merely EXISTING (vpnState) proves nothing about routing. We ask the kernel which
// device the route to an IP uses (`ip route get <ip>` -> `... dev <iface> ...`) and require that
// device to be the expected tunnel. If `ip` is missing or the route does NOT go over the tunnel, we
// FAIL CLOSED. The check is a cheap (~1ms) kernel query, no network. `ip` may live in sbin dirs a
// DynamicUser PATH omits, so a few well-known locations are tried.
//
// Two callers, two caching policies:
//   - GENERIC (1.1.1.1/v4): the /health + startup STATUS attest. Globally cached ~20s (routeCache).
//   - PER-TARGET (the concrete pinned destination IP, incl. v6): enforced at connect time in
//     fetchChecked. Under split-/policy-routing the concrete target can leave via eth0 while 1.1.1.1
//     goes over wg0 -> the generic proof would MISS that leak. This per-target check is NOT cached:
//     a positive result was previously cached ~5s, but a route failover inside that window could
//     briefly send the concrete target over the real uplink while the cache still said "ok" (a
//     TOCTOU leak). Since `ip route get` is ~1ms we simply re-probe on EVERY connect. This minimizes
//     the residual leak window; the absolute guarantee remains the OS kill-switch (nftables/namespace).
const IP_BIN_CANDIDATES = ['ip', '/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'];
const GENERIC_ROUTE_TARGET = '1.1.1.1';
/** @type {{ts: number, ok: boolean}} */
let routeCache = {ts: 0, ok: false};

/**
 * Extract the `dev <name>` device from an `ip route get` output line.
 * @param {string} out
 * @returns {string|null}
 */
function routeDev (out) {
	const m = /\bdev\s+(\S+)/.exec(out || '');
	return m ? m[1] : null;
}

/**
 * True if the kernel route to `targetIp` provably leaves via `iface`. Fail-closed on any error
 * (no `ip`, lookup failure, or a different device). The generic 1.1.1.1/v4 probe is globally cached
 * ~20s (status attest); every other (per-target, connect-time) probe is NOT cached, so the check
 * always reflects the current routing table and a mid-window route failover cannot slip through.
 * @param {string|null} iface
 * @param {string} [targetIp]  destination to probe; defaults to the generic status target 1.1.1.1
 * @param {number} [family]    4 (default) or 6 -> selects `ip route get` vs. `ip -6 route get`
 * @returns {boolean}
 */
function routeOverIface (iface, targetIp = GENERIC_ROUTE_TARGET, family = 4) {
	if (!iface) return false;
	const now = Date.now();
	const generic = targetIp === GENERIC_ROUTE_TARGET && family === 4;
	// Only the generic status probe is cached. The per-target connect-time check is always fresh.
	if (generic && (now - routeCache.ts) < 20000) return routeCache.ok;
	const args = family === 6 ? ['-6', 'route', 'get', targetIp] : ['route', 'get', targetIp];
	let ok = false;
	for (const bin of IP_BIN_CANDIDATES) {
		try {
			const out = child_process.execFileSync(bin, args, {timeout: 2000, encoding: 'utf8'});
			ok = routeDev(out) === iface; // route resolved -> this device decides it; trust nothing else
			break;                        // `ip` ran (even if the device differs) -> no need to try more paths
		} catch (_e) {
			// ENOENT for this path (try the next) or a real failure (leave ok=false -> fail-closed).
		}
	}
	if (generic) routeCache = {ts: now, ok};
	return ok;
}

// --- Exit IP (through the VPN); OFF by default (opt-in) ------------------------
// Default OFF: no periodic outbound call unless the operator opts in with RELAY_EGRESS_LOOKUP=1.
// When ON, /health reports the relay's own exit IP so the app can show the IP comparison (own IP vs.
// relay exit IP) and the extra RELAY_REAL_IP leak veto becomes possible. The lookup goes THROUGH the
// tunnel to phantom_'s own /api/my-ip endpoint (no third-party service, no user data). The 'protected'
// attest does NOT depend on this – it rests on the interface-name + routing proof.
const EGRESS_LOOKUP = /^(1|on|true|yes)$/i.test(process.env.RELAY_EGRESS_LOOKUP || '');
// Own "what is my IP" endpoint, reached THROUGH the tunnel - NOT a third-party service.
// Defaults to phantom_'s endpoint; override via RELAY_EGRESS_URL for another deployment.
// Expected response: {"ip":"…","country":"XX"}.
const EGRESS_URL = process.env.RELAY_EGRESS_URL || 'https://phantomtv.app/api/my-ip';
/** @type {{ts: number, data: {ip: string, country: string, isp: string}|null}} */
let egressCache = {ts: 0, data: null};

/**
 * Look up the relay's own exit IP via EGRESS_URL (only if enabled); short-cached. No user data and
 * no third party - the request goes through the VPN to our own /api/my-ip endpoint.
 * @returns {Promise<{ip: string, country: string, isp: string}|null>}
 */
async function getEgress () {
	if (!EGRESS_LOOKUP) return null; // no outbound call unless explicitly requested
	const now = Date.now();
	if (egressCache.data && (now - egressCache.ts) < 30000) return egressCache.data;
	try {
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), 3000);
		const r = await fetch(EGRESS_URL, {signal: ctrl.signal}).finally(() => clearTimeout(to));
		const j = /** @type {any} */ (await r.json());
		egressCache = {ts: now, data: j.ip ? {ip: j.ip, country: j.country || '', isp: ''} : null};
	} catch (_e) {
		egressCache = {ts: now, data: null};
	}
	return egressCache.data;
}

/**
 * Honest protection status. The `vpn` field means "the expected tunnel interface is present". As an
 * ACTIVE self-check, if RELAY_REAL_IP is configured and the measured egress equals it, the tunnel is
 * NOT effective (traffic leaves via the real IP) -> report vpn:false regardless of interface state.
 * @param {{ip: string, country: string, isp: string}|null} eg
 * @returns {{vpn: boolean|null, iface: string|null}}
 */
function protectionStatus (eg) {
	const st = vpnState();
	if (REAL_IP && eg && eg.ip && eg.ip === REAL_IP) return {vpn: false, iface: st.iface};
	return {vpn: st.known ? st.up : null, iface: st.iface};
}

/**
 * Strong protection attest (fail-closed). Reports `true` ONLY when ALL hold:
 *   (a) the expected interface is present AND up AND its NAME is a plausible tunnel (wg / tun / vpn /
 *       wireguard) - an ordinary uplink (eth0 / enp… / wlan…) is NEVER accepted as a VPN;
 *   (b) ROUTING PROOF: the kernel route to a public target provably leaves via that tunnel
 *       (`ip route get` -> `dev <iface>`); if `ip` is unavailable or the route uses another device,
 *       the attest FAILS (fail-closed);
 *   (c) EXTRA leak veto (only when measurable): if RELAY_REAL_IP is set and the measured egress IP
 *       equals it, the tunnel is not effective -> FAIL. Without RELAY_REAL_IP / without an egress
 *       lookup this veto simply cannot fire, and the attest rests on (a)+(b).
 * This is the signal the app trusts to claim real protection and the same gate /p enforces by default.
 * @param {{ip: string, country: string, isp: string}|null} eg
 * @returns {boolean}
 */
function protectedAttest (eg) {
	const st = vpnState();
	if (!(st.known && st.up)) return false;             // (a) interface present + up
	if (!isTunnelName(st.iface)) return false;          // (a) name must be a real tunnel, not eth0/…
	if (!routeOverIface(st.iface)) return false;        // (b) route to a public target uses the tunnel
	if (REAL_IP && eg && eg.ip && eg.ip === REAL_IP) return false; // (c) measured egress == real IP -> leak
	return true;                                        // all gates passed -> provably protected
}

// --- Playlist rewriting (HLS) -------------------------------------------------
/**
 * Public base for rewritten /p URLs. Prefer the explicitly configured RELAY_PUBLIC_URL. Otherwise
 * fall back to the Host header; X-Forwarded-Proto/-Host are honored ONLY from configured trusted
 * proxies (so an attacker cannot forge the rewrite base via forwarded headers).
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function selfBase (req) {
	if (PUBLIC_URL) return PUBLIC_URL;
	const trusted = TRUSTED_PROXIES.includes(clientIp(req));
	const xfp = req.headers['x-forwarded-proto'];
	const xfh = req.headers['x-forwarded-host'];
	const proto = (trusted && xfp) ? String(xfp).split(',')[0].trim() : 'http';
	const host = (trusted && xfh) ? String(xfh).split(',')[0].trim() : req.headers.host;
	return `${proto}://${host}`;
}

/**
 * Wrap a target URL into a relay `/p` URL, appending the access token in basic mode.
 * @param {string} base
 * @param {string} target
 * @returns {string}
 */
function relayUrl (base, target) {
	// mode=media: rewritten segment/key/map URLs are stream/media requests -> keep HLS detection+rewrite
	// active for NESTED manifests (master -> media playlist). Order: u=...&mode=media[&k=...].
	// In basic mode append the access token to the (rewritten) URLs so that HLS segments,
	// which are loaded by <video> without headers, are authorized too.
	const k = (AUTH_MODE === 'basic' && AUTH_K) ? `&k=${encodeURIComponent(AUTH_K)}` : '';
	return `${base}/p?u=${encodeURIComponent(target)}&mode=media${k}`;
}

// #EXTM3U: der M3U-Header, immer die ERSTE Zeile jeder M3U-/HLS-Playlist.
const M3U_MARKER = Buffer.from('#EXTM3U');
/**
 * Body-basierte M3U-/HLS-Erkennung (PRIV) – NUR im media-Modus. Erkannt wird, wenn der (dekomprimierte)
 * Body-Anfang nach optionalem UTF-8-BOM + führendem Whitespace mit "#EXTM3U" beginnt. KEIN #EXT-X--
 * Erfordernis: im media-Modus kommt KEINE Quell-Senderliste mehr (die läuft über mode=raw), deshalb
 * gibt es keinen Falschpositiv-Konflikt mit einer gewöhnlichen IPTV-M3U und der frühere
 * "#EXT-X- steckt weit hinten"-Bypass entfällt (das Marker steht immer ganz vorn). Ein Manifest unter
 * opaker URL / falschem MIME (application/octet-stream) wird so zuverlässig erkannt und umgeschrieben,
 * sonst laden Segment-/Key-URLs direkt beim Anbieter -> IP-Leak. Case-sensitiv.
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksLikeM3U (buf) {
	let i = 0;
	if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) i = 3; // BOM
	while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0A || buf[i] === 0x0D)) i++; // WS
	return buf.length - i >= M3U_MARKER.length && buf.subarray(i, i + M3U_MARKER.length).equals(M3U_MARKER);
}

/**
 * Heuristik für ein möglicherweise als HTTP-206 range-abgerufenes Manifest-FRAGMENT (media-Modus,
 * Reaudit-Befund 2). Ein Fragment kann mitten im Manifest beginnen -> es trägt NICHT zwingend "#EXTM3U"
 * am Anfang, looksLikeM3U schlägt dann fehl. Ein solches Fragment darf trotzdem NICHT unumgeschrieben
 * durchgereicht werden (die enthaltenen Segment-/Key-URLs würden direkt beim Anbieter laden -> IP-Leak).
 * Signale: eine echte HLS-Tag-Zeile im Prefix (#EXTINF / #EXT-X-), eine Playlist-URL (.m3u8/.m3u) ODER
 * ein Playlist-MIME (…mpegurl…). Binäre Mediensegmente – der Normalfall eines 206 – treffen keines
 * davon und bleiben unverändert (Range/Seeking erhalten).
 * @param {Buffer} prefix
 * @param {string} url
 * @param {string} contentType
 * @returns {boolean}
 */
function looksLikePlaylistFragment (prefix, url, contentType) {
	const head = prefix.toString('latin1');
	if (head.includes('#EXTINF') || head.includes('#EXT-X-')) return true;
	if ((contentType || '').toLowerCase().includes('mpegurl')) return true;
	try {
		const p = new URL(url).pathname.toLowerCase();
		if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return true;
	} catch (_e) { /* keine gültige URL -> kein URL-Signal */ }
	return false;
}

/**
 * Rewrite an HLS playlist so segment/key URLs go through /p again.
 * @param {string} text
 * @param {string} playlistUrl
 * @param {string} base
 * @returns {string}
 */
function rewritePlaylist (text, playlistUrl, base) {
	return text.split(/\r?\n/).map((line) => {
		const t = line.trim();
		if (t === '') return line;
		if (t.startsWith('#')) {
			return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
				const abs = new URL(uri, playlistUrl).toString();
				return `URI="${relayUrl(base, abs)}"`;
			});
		}
		const abs = new URL(t, playlistUrl).toString();
		return relayUrl(base, abs);
	}).join('\n');
}

// --- Test-only upstream transport (NEVER active in production) ------------------
// Gated hard on RELAY_TEST_UPSTREAM (a JSON file mapping target-URL -> canned response). When unset
// (every shipped .env / systemd unit) this is null and fetchChecked never consults it -> a dead branch
// with zero effect on the real forwarding path. It exists so the /p BODY pipeline (decompress, sniff,
// rewrite, stream, size-limit, chunk boundaries, redirect-following) is testable end-to-end over HTTP
// without any DNS/route/socket - exactly the "test-process-only mock transport" the audit asked for.
// The SSRF / VPN-fail-closed / routing riegel are covered by the separate offline scenarios and are
// intentionally bypassed here (a mock is not a real target). Same env-hook convention as
// RELAY_NO_LISTEN / RELAY_ALLOW_UNPROTECTED / RELAY_EGRESS_LOOKUP.
/** @returns {Record<string, any>|null} */
function loadTestUpstream () {
	const p = process.env.RELAY_TEST_UPSTREAM;
	if (!p) return null;
	try {
		const map = JSON.parse(require('node:fs').readFileSync(p, 'utf8'));
		return (map && typeof map === 'object') ? map : null;
	} catch (_e) { return null; }
}
const TEST_UPSTREAM = loadTestUpstream();

/**
 * Build a canned IncomingMessage-like response for a target from the test spec (or null if none).
 * Spec: {status, headers, body|bodyB64, chunkSize?, chunkDelayMs?}. bodyB64 carries pre-encoded bytes
 * (e.g. gzip); chunkSize splits the body to exercise chunk-boundary handling; chunkDelayMs drips slowly
 * so a client can abort mid-stream.
 * @param {string} target
 * @returns {{reqUp: {destroy: () => void}, resp: import('node:stream').Readable & {statusCode: number, headers: Record<string,string>}}|null}
 */
function mockUpstream (target) {
	const spec = TEST_UPSTREAM && TEST_UPSTREAM[target];
	if (!spec) return null;
	/** @type {Record<string,string>} */
	const headers = {};
	for (const [k, v] of Object.entries(spec.headers || {})) headers[k.toLowerCase()] = String(v);
	const bytes = typeof spec.bodyB64 === 'string'
		? Buffer.from(spec.bodyB64, 'base64')
		: Buffer.from(spec.body || '', 'utf8');
	const chunkSize = spec.chunkSize > 0 ? spec.chunkSize : (bytes.length || 1);
	const delayMs = spec.chunkDelayMs > 0 ? spec.chunkDelayMs : 0;
	const resp = /** @type {any} */ (Readable.from((async function* () {
		for (let i = 0; i < bytes.length; i += chunkSize) {
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			yield bytes.subarray(i, i + chunkSize);
		}
	})()));
	resp.statusCode = spec.status || 200;
	resp.headers = headers;
	// reqUp: only .destroy() is ever called (MAX_STREAM_MS timeout path) -> a no-op suffices.
	return {reqUp: {destroy () {}}, resp};
}

// --- Upstream fetch with IP pinning + manual redirect re-checks ----------------
/**
 * One HTTP(S) request, pinning the socket to the pre-validated IP while keeping the original
 * hostname for the Host header and TLS SNI (cert validation stays against the real hostname).
 * @param {URL} u
 * @param {Pin} pin
 * @param {Record<string, string>} baseHeaders
 * @param {AbortSignal} signal
 * @returns {Promise<{reqUp: import('node:http').ClientRequest, resp: import('node:http').IncomingMessage}>}
 */
function requestUpstream (u, pin, baseHeaders, signal) {
	return new Promise((resolve, reject) => {
		const isHttps = u.protocol === 'https:';
		const mod = isHttps ? https : http;
		const host = u.hostname.replace(/^\[|\]$/g, '');
		/** @type {import('node:https').RequestOptions} */
		const reqOpts = {
			protocol: u.protocol,
			hostname: host,
			port: Number(u.port) || (isHttps ? 443 : 80),
			path: (u.pathname || '/') + (u.search || ''),
			method: 'GET',
			headers: Object.assign({host: u.host}, baseHeaders),
			signal,
			// Pin: the socket connects to exactly the checked IP – no second, unchecked resolution.
			lookup: (_hostname, opts, cb) => {
				if (opts && opts.all) cb(null, [{address: pin.ip, family: pin.family}]);
				else cb(null, pin.ip, pin.family);
			}
		};
		if (isHttps && !isIpLiteral(host)) reqOpts.servername = host;
		const reqUp = mod.request(reqOpts);
		let settled = false;
		const connectTimer = setTimeout(() => {
			if (!settled) reqUp.destroy(new Error('upstream timeout (no response headers)'));
		}, UPSTREAM_TIMEOUT);
		reqUp.setTimeout(IDLE_TIMEOUT, () => reqUp.destroy(new Error('upstream idle timeout')));
		reqUp.once('response', (resp) => {
			settled = true;
			clearTimeout(connectTimer);
			resolve({reqUp, resp});
		});
		reqUp.once('error', (err) => {
			if (!settled) { settled = true; clearTimeout(connectTimer); reject(err); }
		});
		reqUp.end();
	});
}

/**
 * @typedef {{blocked?: boolean, tooManyRedirects?: boolean, leak?: boolean,
 *   reqUp?: import('node:http').ClientRequest, resp?: import('node:http').IncomingMessage,
 *   finalUrl?: string}} FetchResult
 */

/**
 * Fetch the upstream, follow redirects MANUALLY and re-check + re-pin every target (SSRF-safe).
 * @param {string} target
 * @param {Record<string, string>} headers
 * @param {AbortSignal} signal
 * @returns {Promise<FetchResult>}
 */
async function fetchChecked (target, headers, signal) {
	let current = target;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		// TEST-ONLY (RELAY_TEST_UPSTREAM): serve canned responses without DNS/route/socket. Redirects are
		// followed here exactly like the real path below (drain + re-loop). An unknown target never falls
		// through to the real network -> it is treated as blocked. Inert in production (TEST_UPSTREAM null).
		if (TEST_UPSTREAM) {
			const mock = mockUpstream(current);
			if (!mock) return {blocked: true};
			const st = mock.resp.statusCode || 0;
			const loc = mock.resp.headers.location;
			if (st >= 300 && st < 400 && loc) {
				mock.resp.resume();
				try { current = new URL(loc, current).toString(); } catch (_e) { return {blocked: true}; }
				continue;
			}
			return {reqUp: /** @type {any} */ (mock.reqUp), resp: /** @type {any} */ (mock.resp), finalUrl: current};
		}
		/** @type {URL} */
		let u;
		try { u = new URL(current); } catch (_e) { return {blocked: true}; }
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return {blocked: true};
		const pin = await resolvePinned(u);
		if (!pin) return {blocked: true};
		// TARGET-BOUND routing proof (RELAY-01): in protected mode the route to THIS pinned IP must
		// leave via the expected tunnel. The generic 1.1.1.1 attest can pass while split-/policy-routing
		// sends the concrete target over eth0 -> a leak despite protected:true. Enforced per hop (first
		// target AND every redirect, each re-pinned above), fail-closed if `ip` is missing or the route
		// uses another device. Skipped only under the explicit dev opt-out.
		if (!ALLOW_UNPROTECTED && !routeOverIface(EXPECTED_IF, pin.ip, pin.family)) return {leak: true};
		const {reqUp, resp} = await requestUpstream(u, pin, headers, signal);
		const status = resp.statusCode || 0;
		const loc = resp.headers.location;
		if (status >= 300 && status < 400 && loc) {
			resp.resume(); // drain & discard the redirect body
			try { current = new URL(loc, current).toString(); } catch (_e) { return {blocked: true}; }
			continue;
		}
		return {reqUp, resp, finalUrl: current};
	}
	return {tooManyRedirects: true};
}

/**
 * A single header value flattened to a string (join arrays such as set-cookie defensively).
 * @param {string|string[]|undefined} v
 * @returns {string|undefined}
 */
function strHeader (v) {
	if (v === undefined) return undefined;
	return Array.isArray(v) ? v.join(', ') : v;
}

/**
 * Transparently decompress a stream if the upstream applied a content-encoding.
 * @param {import('node:stream').Readable} stream
 * @param {string|undefined} encoding
 * @returns {import('node:stream').Readable}
 */
function maybeDecompress (stream, encoding) {
	const enc = (encoding || '').toLowerCase();
	if (enc.includes('br')) return stream.pipe(zlib.createBrotliDecompress());
	if (enc.includes('gzip')) return stream.pipe(zlib.createGunzip());
	if (enc.includes('deflate')) return stream.pipe(zlib.createInflate());
	return stream;
}

/**
 * Read a stream into text, enforcing a hard byte cap AS IT READS (not just via Content-Length).
 * @param {import('node:stream').Readable} stream
 * @param {number} cap
 * @returns {Promise<string>}
 */
async function readTextCapped (stream, cap) {
	let size = 0;
	/** @type {Buffer[]} */
	const chunks = [];
	for await (const chunk of stream) {
		const buf = /** @type {Buffer} */ (chunk);
		size += buf.length;
		if (size > cap) {
			stream.destroy();
			const e = /** @type {any} */ (new Error('capacity exceeded'));
			e.code = 'ECAP';
			throw e;
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function errMsg (e) {
	return (e && /** @type {any} */ (e).message) ? /** @type {any} */ (e).message : String(e);
}

/**
 * Write a short text response, guarding against a socket that is already closed/finished.
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string} msg
 * @param {Record<string, string>} [extra]
 */
function endText (res, code, msg, extra) {
	if (res.headersSent || res.writableEnded || res.destroyed) return;
	res.writeHead(code, Object.assign(
		{'content-type': 'text/plain', 'access-control-allow-origin': CORS_ORIGIN, 'cache-control': 'no-store'},
		extra || {}
	));
	res.end(msg);
}

// --- Resource limits: concurrency + simple per-client rate limit ---------------
let inFlight = 0;
/** @type {Map<string, {count: number, reset: number}>} */
const rateBuckets = new Map();

/**
 * Fixed-window per-client rate limit. Returns true if the client is over the limit.
 * @param {string} ip
 * @returns {boolean}
 */
function rateLimited (ip) {
	if (RATE_MAX <= 0) return false;
	const now = Date.now();
	let e = rateBuckets.get(ip);
	if (!e || now >= e.reset) { e = {count: 0, reset: now + RATE_WINDOW_MS}; rateBuckets.set(ip, e); }
	e.count++;
	return e.count > RATE_MAX;
}
if (RATE_MAX > 0) {
	// Prune expired buckets so the map cannot grow unbounded. unref() so it never keeps us alive.
	setInterval(() => {
		const now = Date.now();
		for (const [k, v] of rateBuckets) { if (now >= v.reset) rateBuckets.delete(k); }
	}, RATE_WINDOW_MS).unref();
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || '/', 'http://localhost');

	// CORS-Preflight: die App fragt /health im Basic-Modus mit `Authorization: Basic`-Header ab. Ein
	// Nicht-Simple-Header (Authorization) zwingt Chromium zu einem OPTIONS-Preflight. Ohne
	// Allow-Methods/-Headers blockiert der Browser das eigentliche GET -> der Guard bekäme KEINEN Status.
	// Max-Age cached den Preflight ~24h (kein Dauer-Overhead pro Request).
	if (req.method === 'OPTIONS') {
		res.writeHead(204, {
			'access-control-allow-origin': CORS_ORIGIN,
			'access-control-allow-methods': 'GET, OPTIONS',
			'access-control-allow-headers': 'Authorization',
			'access-control-max-age': '86400',
			'content-length': '0'
		});
		res.end();
		return;
	}

	if (url.pathname === '/' || url.pathname === '/health') {
		const headers = {
			'content-type': 'application/json',
			'access-control-allow-origin': CORS_ORIGIN,
			'cache-control': 'no-store'
		};
		// Anonymous liveness is minimal AND non-identifying. `vpn` is a boolean the app polls
		// credential-free (fail-closed signal) – no IP. The identifying egress details
		// (iface/ip/clientIp/country/isp) are disclosed ONLY to an authorized caller (valid ?k=/Basic,
		// allowlisted IP, or open mode) or a loopback caller (local --check).
		const eg = await getEgress();
		const {vpn, iface} = protectionStatus(eg);
		// Strong attest: true ONLY with a real tunnel interface AND a routing proof that traffic leaves
		// via it (plus the optional egress leak veto). See protectedAttest(); same gate /p enforces.
		const isProt = protectedAttest(eg);
		// authOk EINMAL auswerten (timingSafeEqual ist nicht gratis) und für beide Zwecke nutzen:
		// Detail-Freigabe UND die 401-Weiche unten.
		const isAuthorized = authOk(req, url);
		const detailed = isAuthorized || isLoopback(clientIp(req));
		// Vorhandener, aber ungültiger Authorization-Header -> 401 statt anonymer 200, damit die App
		// falsche Basic-Zugangsdaten erkennt (useRelayGuard wertet 401/403 als authError). CORS-Header
		// bleiben, damit der Browser die Antwort lesen kann; KEIN www-authenticate (sonst nativer
		// Browser-Auth-Dialog beim fetch). Ein Aufruf OHNE Authorization-Header bleibt die anonyme
		// Liveness-200 (credential-free) – nur ein FALSCHER Header wird abgelehnt.
		const hasAuthHeader = typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;
		if (hasAuthHeader && !isAuthorized) {
			res.writeHead(401, headers);
			res.end(JSON.stringify({ok: false, error: 'unauthorized'}));
			return;
		}
		res.writeHead(200, headers);
		// `authorized`: darf dieser konkrete Aufrufer /p überhaupt nutzen (Auth-Modus/Creds/IP passen)?
		// Non-identifying (nur Boolean). Nutzen: die App erkennt eine irreführende Einrichtung, bei der
		// /health zwar lebt/„protected" meldet, /p aber später mit 403 scheitert (z. B. App-Auth 'open',
		// Relay-Default 'deny'). Loopback (--check) fließt hier NICHT ein – nur die echte /p-Berechtigung.
		if (!detailed) {
			res.end(JSON.stringify({ok: true, vpn, protected: isProt, authorized: isAuthorized}));
			return;
		}
		res.end(JSON.stringify({
			ok: true,
			vpn,
			protected: isProt,
			authorized: isAuthorized,
			iface,
			ip: (eg && eg.ip) || null,
			// Die IP, die DAS RELAY vom Client sieht (die es ohnehin im TCP-Header hat). Damit kann die
			// App den Vergleich „eigene IP vs. Relay-Ausgangs-IP" bilden, OHNE die reale IP an einen
			// externen Endpunkt zu schicken.
			clientIp: clientIp(req),
			country: (eg && eg.country) || '',
			isp: (eg && eg.isp) || ''
		}));
		return;
	}

	if (url.pathname !== '/p') {
		res.writeHead(404, {'content-type': 'text/plain', 'access-control-allow-origin': CORS_ORIGIN});
		res.end('not found');
		return;
	}

	// ACCESS CONTROL (only /p; /health stays reachable for the app's liveness check).
	if (!authOk(req, url)) {
		res.writeHead(AUTH_MODE === 'basic' ? 401 : 403, Object.assign(
			{'content-type': 'text/plain', 'access-control-allow-origin': CORS_ORIGIN, 'cache-control': 'no-store'},
			AUTH_MODE === 'basic' ? {'www-authenticate': 'Basic realm="phantom relay"'} : {}
		));
		res.end('relay: unauthorized');
		return;
	}

	// MODUS-VERTRAG (identisch zur App-Seite): mode=raw = Quell-Abruf (M3U-Listen, EPG, API, Logos) OHNE
	// HLS-Rewrite, nur durchreichen. mode=media (oder FEHLENDER mode) = Medienstream MIT HLS-Erkennung +
	// Rewrite. Alle Sicherheitsriegel davor (Auth, SSRF/VPN-Guard, Redirect-Prüfung, Limits) bleiben in
	// BEIDEN Modi unverändert; 'mode' steuert AUSSCHLIESSLICH das Sniff-/Rewrite-Verhalten des Bodys.
	const isRaw = url.searchParams.get('mode') === 'raw';

	// FAIL-CLOSED: forward ONLY when the SAME strong attest /health reports holds - a real tunnel
	// interface that is up AND a routing proof that traffic to a public target leaves via it (plus the
	// optional egress leak veto). Interface presence alone is NOT enough. Uses the already-cached egress
	// (never forces an outbound lookup on the request path). Without a solid attest -> 503, unless the
	// operator explicitly opted out for local dev via RELAY_ALLOW_UNPROTECTED=1.
	if (!protectedAttest(egressCache.data) && !ALLOW_UNPROTECTED) {
		endText(res, 503, 'relay blocked: VPN protection not verified (fail-closed)');
		return;
	}

	// RESOURCE LIMITS (before doing any upstream work).
	const cip = clientIp(req);
	if (rateLimited(cip)) {
		endText(res, 429, 'relay: rate limit', {'retry-after': String(Math.ceil(RATE_WINDOW_MS / 1000))});
		return;
	}
	if (MAX_CONCURRENT > 0 && inFlight >= MAX_CONCURRENT) {
		endText(res, 503, 'relay: too many concurrent requests', {'retry-after': '2'});
		return;
	}

	inFlight++;
	let released = false;
	const release = () => { if (!released) { released = true; inFlight = Math.max(0, inFlight - 1); } };
	const ac = new AbortController();
	/** @type {ReturnType<typeof setTimeout>|null} */
	let totalTimer = null;
	// Client disconnect -> abort the upstream, free the slot, clear timers.
	res.on('close', () => {
		ac.abort();
		if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
		release();
	});

	const target = url.searchParams.get('u');
	if (!target) {
		endText(res, 400, 'missing ?u=');
		return;
	}

	try {
		/** @type {Record<string, string>} */
		const headers = {};
		if (req.headers.range) headers.range = String(req.headers.range);
		if (req.headers['user-agent']) headers['user-agent'] = String(req.headers['user-agent']);

		const r = await fetchChecked(target, headers, ac.signal);
		if (r.blocked) {
			endText(res, 403, 'relay: target not allowed');
			return;
		}
		if (r.leak) {
			// Route to the concrete target does NOT leave via the tunnel (or `ip` missing) -> no connect.
			endText(res, 503, 'relay blocked: target route not over VPN (fail-closed)');
			return;
		}
		if (r.tooManyRedirects || !r.resp || !r.reqUp) {
			endText(res, 502, 'relay: too many redirects');
			return;
		}
		const resp = r.resp;
		const reqUp = r.reqUp;
		const finalUrl = r.finalUrl || target;
		const ct = strHeader(resp.headers['content-type']) || '';
		const base = selfBase(req);

		// HLS-Erkennung REIN BODY-BASIERT (looksLikeM3U) und NUR im media-Modus: URL/MIME sind mehrdeutig
		// (application/x-mpegURL nutzen auch Quell-M3U-Listen) und werden bewusst NICHT als Ausloeser
		// verwendet. Dazu wird der (dekomprimierte) Stream angezapft und der Anfang (SNIFF_BYTES) gelesen.
		// So kann kein HLS-Manifest mehr wegen opaker URL / falschem MIME unumgeschrieben passieren (kein
		// direkter Segment-/Key-Abruf, PRIV). Im raw-Modus (M3U-Listen/EPG/API/Logos) wird NICHT gesnifft
		// und NICHT umgeschrieben -> der Body geht unveraendert durch (kein doppeltes /p-Routing beim
		// Import). Content-Length wird nicht vorab genutzt; MAX_PLAYLIST_BYTES greift beim Lesen und nur
		// fuer echte HLS-Manifeste (raw/Nicht-Manifest wird unveraendert durchgestreamt).
		const ce = strHeader(resp.headers['content-encoding']);
		const decompressed = maybeDecompress(resp, ce);
		const it = decompressed[Symbol.asyncIterator]();
		/** @type {Buffer[]} */
		const sniff = [];
		let sniffLen = 0;
		let streamDone = false;
		if (!isRaw) try {
			while (sniffLen < SNIFF_BYTES) {
				const nx = await it.next();
				if (nx.done) { streamDone = true; break; }
				const buf = /** @type {Buffer} */ (nx.value);
				sniff.push(buf);
				sniffLen += buf.length;
			}
		} catch (e) {
			if (ac.signal.aborted) { try { res.destroy(); } catch (_e) { /* noop */ } return; }
			endText(res, 502, `relay: upstream read error`);
			return;
		}
		const prefix = Buffer.concat(sniff);

		if (!isRaw && looksLikeM3U(prefix)) {
			// HLS-Manifest: gesamten Body (Prefix + Rest) puffern (gecappt) und Segment-/Key-URLs umschreiben.
			/** @type {Buffer[]} */
			const parts = [prefix];
			let total = prefix.length;
			// Cap AUCH auf den Prefix anwenden: kommt das ganze Manifest schon im ersten (evtl.
			// dekomprimierten) Chunk an, würde die Folge-Schleife den Cap sonst nie prüfen -> ein
			// einzelner Riesen-Chunk / eine Zip-Bomb könnte den Speicher-Cap umgehen (fail-closed).
			if (total > MAX_PLAYLIST_BYTES) {
				try { resp.destroy(); } catch (_e) { /* noop */ }
				endText(res, 502, 'relay: playlist too large');
				return;
			}
			try {
				while (!streamDone) {
					const nx = await it.next();
					if (nx.done) break;
					const buf = /** @type {Buffer} */ (nx.value);
					total += buf.length;
					if (total > MAX_PLAYLIST_BYTES) {
						try { resp.destroy(); } catch (_e) { /* noop */ }
						endText(res, 502, 'relay: playlist too large');
						return;
					}
					parts.push(buf);
				}
			} catch (e) {
				if (ac.signal.aborted) { try { res.destroy(); } catch (_e) { /* noop */ } return; }
				endText(res, 502, 'relay: playlist read error');
				return;
			}
			const body = rewritePlaylist(Buffer.concat(parts).toString('utf8'), finalUrl, base);
			if (res.headersSent || res.writableEnded) return;
			res.writeHead(resp.statusCode || 200, {
				// Nach dem Rewrite ist der Body garantiert ein M3U-Manifest -> IMMER den HLS-Type setzen
				// (Reaudit-Befund 1). Ein vom Anbieter mitgeschickter generischer Typ (z. B.
				// application/octet-stream) würde den nativen webOS-Player sonst evtl. das korrekt
				// geroutete Manifest ablehnen lassen.
				'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
				'access-control-allow-origin': CORS_ORIGIN,
				'cache-control': 'no-cache'
			});
			res.end(body);
			return;
		}

		// 206-PLAYLIST-FRAGMENT (media, PRIV, Reaudit-Befund 2): looksLikeM3U war negativ, aber ein
		// Partial-Content-Response (206) kann ein MID-Manifest-Fragment sein, das nicht mit #EXTM3U
		// beginnt. Sieht Body/URL/MIME nach einem Manifest-Fragment aus, wird es NICHT unumgeschrieben
		// durchgereicht (Segment-/Key-URLs würden direkt beim Anbieter laden -> IP-Leak), sondern
		// fail-closed mit 502 abgelehnt. Ein Manifest wird normal vollständig ab Byte 0 geladen (dann
		// greift looksLikeM3U); ein solcher Range-Teilabruf ist anomal. Echte (binäre) Segment-206
		// treffen keines der Signale und passieren unten unverändert (Range/Seeking bleibt erhalten).
		if (!isRaw && resp.statusCode === 206 && looksLikePlaylistFragment(prefix, finalUrl, ct)) {
			try { resp.destroy(); } catch (_e) { /* noop */ }
			endText(res, 502, 'relay: refusing partial HLS manifest fragment (fail-closed)');
			return;
		}

		// Kein Manifest: unveränderter Durchsatz. Der bereits gelesene Prefix darf NICHT verloren gehen,
		// deshalb wird er dem Rest des Streams vorangestellt. Gesendet wird vom (evtl.) dekomprimierten
		// Stream -> content-encoding entfällt; Länge/Range-Header sind nur ohne Dekompression gültig.
		/** @type {Record<string, string>} */
		const out = {'access-control-allow-origin': CORS_ORIGIN};
		const ctv = strHeader(resp.headers['content-type']);
		if (ctv) out['content-type'] = ctv;
		if (!ce) {
			// Passthrough (nicht dekomprimiert): Original-Länge + Range-Header bleiben korrekt.
			for (const h of ['content-length', 'accept-ranges', 'content-range']) {
				const v = strHeader(resp.headers[h]);
				if (v) out[h] = v;
			}
		}
		if (res.headersSent || res.writableEnded) { try { resp.destroy(); } catch (_e) { /* noop */ } return; }
		res.writeHead(resp.statusCode || 200, out);
		if (MAX_STREAM_MS > 0) {
			totalTimer = setTimeout(() => { ac.abort(); reqUp.destroy(new Error('total stream timeout')); }, MAX_STREAM_MS);
		}
		if (streamDone) {
			res.end(prefix);
			if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
			return;
		}
		// Prefix + verbleibender Stream (derselbe Iterator) als EIN Readable an res pipen (Backpressure/
		// Cleanup via pipeline). Ein Abbruch (Client-Disconnect -> ac.abort) beendet den Generator still.
		const merged = Readable.from((async function* () {
			yield prefix;
			try {
				while (true) {
					const nx = await it.next();
					if (nx.done) return;
					yield nx.value;
				}
			} catch (e) {
				if (!ac.signal.aborted) throw e;
			}
		})());
		pipeline(merged, res, (err) => {
			if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
			if (err) {
				try { resp.destroy(); } catch (_e) { /* noop */ }
				try { if (!res.writableEnded) res.destroy(); } catch (_e) { /* noop */ }
			}
		});
	} catch (e) {
		// A client-disconnect abort is expected – don't try to write to a dead socket.
		if (ac.signal.aborted) { try { res.destroy(); } catch (_e) { /* noop */ } return; }
		endText(res, 502, `relay error: ${errMsg(e)}`);
	}
});

// --- Self-check as a standalone command ---------------------------------------
// `node server.js --check [url]` -> plain-text verdict + exit code. Exit 0 is claimed ONLY on the
// strong attest (protected===true). A bare "interface up but protection not verified" is exit 1, so a
// caller can never mistake mere interface presence for real protection. Exit codes:
//   0 = PROTECTED (attest passed) · 1 = not verified / VPN down · 2 = relay unreachable.
/** @returns {Promise<void>} */
async function runCheck () {
	const arg = process.argv[process.argv.indexOf('--check') + 1];
	const url = (arg && /^https?:\/\//.test(arg)) ? arg : `http://localhost:${PORT}/health`;
	try {
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), 4000);
		const res = await fetch(url, {signal: ctrl.signal});
		clearTimeout(to);
		const j = /** @type {any} */ (await res.json());
		// Only the strong attest counts as PROTECTED. `vpn:true` without `protected` means the interface
		// is up but the routing proof did NOT confirm egress via the tunnel -> report unverified, exit 1.
		let state; let code;
		if (j.protected === true) { state = 'PROTECTED (tunnel + routing proof)'; code = 0; }
		else if (j.vpn === true) { state = 'interface up, protection NOT verified (no routing proof)'; code = 1; }
		else if (j.vpn === false) { state = 'UNPROTECTED – VPN down (fail-closed engaged)'; code = 1; }
		else { state = 'protection NOT verified (unknown)'; code = 1; }
		// eslint-disable-next-line no-console
		console.log(`Relay: ${j.ok ? 'running' : '?'} · Protection: ${state}${j.ip ? ' · Egress: ' + j.ip : ''}`);
		process.exit(code);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error(`Relay unreachable (${url}): ${errMsg(e)}`);
		process.exit(2);
	}
}

// --- Liveness probe (for the container HEALTHCHECK) ---------------------------
// `node server.js --liveness` only checks that the relay PROCESS answers HTTP. It deliberately does
// NOT require a VPN, so a container is not flagged unhealthy merely because no tunnel is up yet (the
// per-request fail-closed guard already refuses to forward in that state). Exit 0 = reachable, 1 = not.
/** @returns {Promise<void>} */
async function runLiveness () {
	const url = `http://localhost:${PORT}/health`;
	try {
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), 4000);
		const res = await fetch(url, {signal: ctrl.signal});
		clearTimeout(to);
		// eslint-disable-next-line no-console
		console.log(`Relay liveness: reachable (HTTP ${res.status})`);
		process.exit(0);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error(`Relay liveness: unreachable (${url}): ${errMsg(e)}`);
		process.exit(1);
	}
}

if (process.env.RELAY_NO_LISTEN === '1') {
	// Test-Import (tests/run.mjs): reine Funktionen nutzbar machen, ohne den Server zu starten.
} else if (process.argv.includes('--liveness')) {
	runLiveness();
} else if (process.argv.includes('--check')) {
	runCheck();
} else {
	server.listen(PORT, () => {
		const vpn = vpnState();
		const failClosed = ALLOW_UNPROTECTED ? 'DISABLED (RELAY_ALLOW_UNPROTECTED)' : 'active';
		// Honest attest at startup: (a) tunnel-name + up and (b) routing proof, without the egress veto
		// (no lookup yet). Same gate /p and /health use, so the banner cannot over-promise.
		const attest = protectedAttest(null);
		// Startup banner (config only, NO user data). Nothing is logged afterwards.
		// eslint-disable-next-line no-console
		console.log(`phantom_ relay · port ${PORT} · VPN: ${vpn.iface || '(none)'} · protected: ${attest ? 'yes' : 'NO'} · fail-closed: ${failClosed} · auth: ${AUTH_MODE} · limits: conc=${MAX_CONCURRENT || 'off'} rate=${RATE_MAX ? RATE_MAX + '/' + Math.round(RATE_WINDOW_MS / 1000) + 's' : 'off'}`);
		if (TEST_UPSTREAM) {
			// eslint-disable-next-line no-console
			console.warn('WARN: RELAY_TEST_UPSTREAM is set -> a test-only mock upstream is active; canned responses are served for listed targets WITHOUT any real network fetch. NEVER set this in production.');
		}
		if (ALLOW_UNPROTECTED) {
			// eslint-disable-next-line no-console
			console.warn('WARN: RELAY_ALLOW_UNPROTECTED=1 -> the VPN fail-closed guard is OFF; /p may forward WITHOUT VPN protection. Dev only.');
		} else if (!attest) {
			// eslint-disable-next-line no-console
			console.warn(`WARN: protection NOT verified -> ALL /p requests are blocked (fail-closed). Need a tunnel interface (wg*/tun*/vpn*, currently '${vpn.iface || '(none)'}', up=${vpn.up}) AND a routing proof that traffic leaves via it (\`ip route get 1.1.1.1\` -> dev must be that interface; the 'ip' tool must be installed). For local dev without a VPN set RELAY_ALLOW_UNPROTECTED=1.`);
		}
		if (AUTH_MODE === 'ip' && TRUSTED_PROXIES.length > 0) {
			// The ip allowlist matches the REAL TCP peer address (never X-Forwarded-For). Behind a reverse
			// proxy that peer is the PROXY's IP - so allowlisting it authorizes EVERY client behind that
			// proxy, not just yours. RELAY_TRUSTED_PROXIES only affects the HLS-rewrite base here, not the
			// ip check, but its presence signals a proxy sits in front. Prefer token auth (RELAY_AUTH=basic).
			// eslint-disable-next-line no-console
			console.warn('WARN: RELAY_AUTH=ip with RELAY_TRUSTED_PROXIES set -> the ip check matches the real TCP peer, which behind a reverse proxy is the PROXY IP; allowlisting it authorizes ALL clients behind that proxy. Prefer RELAY_AUTH=basic (token) when behind a proxy.');
		}
		if (AUTH_MODE === 'ip' && CORS_ORIGIN === '*') {
			// Reaudit: IP-Allowlisting ist KEINE Origin-/App-Authentifizierung. Mit CORS '*' darf jede
			// Browser-Origin, die auf einem allowlisteten Gerät laeuft, das Relay fuer beliebige
			// OEFFENTLICHE Ziele nutzen (privates SSRF bleibt gesperrt, aber Bandbreite/VPN-Egress
			// koennen missbraucht werden). Fuer Browser-/Proxy-Betrieb RELAY_CORS_ORIGIN eng setzen und
			// 'basic' (Token) gegenueber 'ip' bevorzugen.
			// eslint-disable-next-line no-console
			console.warn('WARN: RELAY_AUTH=ip with RELAY_CORS_ORIGIN=* -> ANY browser origin on an allowlisted device can use the relay for arbitrary PUBLIC targets (IP allowlisting is not origin/app auth). Set RELAY_CORS_ORIGIN explicitly and prefer RELAY_AUTH=basic.');
		}
		if (AUTH_MODE === 'basic' && !AUTH_K) {
			// eslint-disable-next-line no-console
			console.warn('WARN: RELAY_AUTH=basic without RELAY_USER/RELAY_PASS -> ALL /p requests are blocked.');
		} else if (AUTH_MODE !== 'ip' && AUTH_MODE !== 'basic' && AUTH_MODE !== 'open') {
			// eslint-disable-next-line no-console
			console.warn(`WARN: RELAY_AUTH is unset/invalid ('${AUTH_MODE}') -> ALL /p requests are blocked (fail-closed). Set RELAY_AUTH=ip or basic (or 'open' only on a trusted network).`);
		}
	});
}

// Test-Only-Export der reinen HLS-Helfer (siehe RELAY_NO_LISTEN-Guard oben; kein Effekt im Betrieb).
module.exports = {looksLikeM3U, rewritePlaylist, looksLikePlaylistFragment};
