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
// FAIL-CLOSED: if the VPN drops (interface gone), /p refuses to forward anything (HTTP 503). NOTE:
// this is an INTERFACE-PRESENCE guard, not a true OS kill switch. For a real kill switch add an
// nftables/namespace OUTPUT-deny for everything except the tunnel (see README.de.md "Kill-Switch").
//
// RESOURCE LIMITS: global concurrency cap, simple per-client rate limit, playlist size cap enforced
// while reading, idle + connect timeouts, abort on client disconnect. See the RELAY_* ENV below.
//
// Configuration (all optional, via ENV):
//   PORT=8787
//   RELAY_VPN_IF=wg0        VPN interface. Recommended to set explicitly (unambiguous fail-closed).
//   RELAY_AUTH=open|ip|basic  Access control (default: open).
//     ip:    RELAY_ALLOW=1.2.3.4,5.6.7.8   allowed client IPs
//     basic: RELAY_USER=... RELAY_PASS=...  username/password (WITHOUT them, EVERYTHING is blocked)
//   RELAY_PUBLIC_URL=https://relay.example   fixed public base for HLS rewriting (recommended when
//                           behind a reverse proxy; otherwise the Host header is used).
//   RELAY_TRUSTED_PROXIES=  comma list of proxy IPs whose X-Forwarded-Proto/-Host are honored.
//   RELAY_CORS_ORIGIN=*     Access-Control-Allow-Origin (default *; narrow it if you can).
//   RELAY_REAL_IP=          the host's real (non-VPN) public IP; if the measured egress equals it,
//                           the tunnel is not effective -> /health reports vpn:false (active check).
//   RELAY_MAX_CONCURRENT=128   global in-flight /p cap (0 = unlimited).
//   RELAY_RATE_MAX=600         per-client /p requests per window (0 = disabled).
//   RELAY_RATE_WINDOW_MS=60000 rate-limit window.
//   RELAY_IDLE_TIMEOUT_MS=30000 abort an upstream that stops sending data.
//   RELAY_MAX_STREAM_MS=0      hard cap for a single stream (0 = unlimited; keep 0 for live TV).
//   RELAY_EGRESS_LOOKUP=1   show the relay's own exit IP in /health, looked up via RELAY_EGRESS_URL
//                           (own endpoint, default https://phantomtv.app/api/my-ip). Default ON
//                           (opt-out with =0); enables the app's own-IP-vs-relay-IP comparison.
//
// No runtime dependencies (Node 18+ with global fetch).

const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const dns = require('node:dns').promises;
const {pipeline} = require('node:stream');

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
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024; // playlists are read into memory -> cap the size
const MAX_CONCURRENT = intEnv('RELAY_MAX_CONCURRENT', 128);          // global in-flight /p cap (0=off)
const RATE_MAX = intEnv('RELAY_RATE_MAX', 600);                      // per-client /p per window (0=off)
const RATE_WINDOW_MS = intEnv('RELAY_RATE_WINDOW_MS', 60000);

const CORS_ORIGIN = process.env.RELAY_CORS_ORIGIN || '*';
const PUBLIC_URL = (process.env.RELAY_PUBLIC_URL || '').replace(/\/+$/, '');
const TRUSTED_PROXIES = (process.env.RELAY_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
const REAL_IP = (process.env.RELAY_REAL_IP || '').trim();

// --- Access control: open | ip | basic ----------------------------------------
const AUTH_MODE = (process.env.RELAY_AUTH || 'open').toLowerCase();
const ALLOW_IPS = (process.env.RELAY_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUTH_USER = process.env.RELAY_USER || '';
const AUTH_PASS = process.env.RELAY_PASS || '';
const AUTH_K = (AUTH_USER || AUTH_PASS) ? Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64') : '';

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
	// Unbekannter/vertippter Modus (z. B. RELAY_AUTH=bsic) -> FAIL-CLOSED, nicht versehentlich offen.
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
	if (a === 198 && (b === 18 || b === 19)) return true;   // 198.18.0.0/15 benchmarking
	if (a >= 224) return true;                              // multicast / reserved / broadcast
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
	if (isIpLiteral(host)) {
		if (isBlockedIp(host)) return null;
		return {ip: host, family: host.includes(':') ? 6 : 4};
	}
	let addrs;
	try {
		addrs = await dns.lookup(host, {all: true});
	} catch (_e) {
		return null;
	}
	if (!addrs.length) return null;
	if (!addrs.every((a) => !isBlockedIp(a.address))) return null;
	const a = addrs[0];
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

// --- Exit IP (through the VPN); ON by default ---------------------------------
// Default ON: /health reports the relay's own exit IP so the app can show the IP comparison (own IP
// vs. relay exit IP) reliably, without the unreliable /p stream proxy. The lookup goes THROUGH the
// tunnel to the own /api/my-ip endpoint (no third-party service, no user data). Opt-out with
// RELAY_EGRESS_LOOKUP=0.
const EGRESS_LOOKUP = /^(1|on|true|yes)$/i.test(process.env.RELAY_EGRESS_LOOKUP || '1');
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
	// In basic mode append the access token to the (rewritten) URLs so that HLS segments,
	// which are loaded by <video> without headers, are authorized too.
	const k = (AUTH_MODE === 'basic' && AUTH_K) ? `&k=${encodeURIComponent(AUTH_K)}` : '';
	return `${base}/p?u=${encodeURIComponent(target)}${k}`;
}

/**
 * @param {string} url
 * @param {string} contentType
 * @returns {boolean}
 */
function isPlaylist (url, contentType) {
	return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType || '');
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
 * @typedef {{blocked?: boolean, tooManyRedirects?: boolean,
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
		/** @type {URL} */
		let u;
		try { u = new URL(current); } catch (_e) { return {blocked: true}; }
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return {blocked: true};
		const pin = await resolvePinned(u);
		if (!pin) return {blocked: true};
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
		const detailed = authOk(req, url) || isLoopback(clientIp(req));
		res.writeHead(200, headers);
		if (!detailed) {
			res.end(JSON.stringify({ok: true, vpn}));
			return;
		}
		res.end(JSON.stringify({
			ok: true,
			vpn,
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

	// FAIL-CLOSED: if the expected VPN interface is gone, forward NOTHING.
	const vpn = vpnState();
	if (vpn.known && !vpn.up) {
		endText(res, 503, 'relay blocked: VPN down (fail-closed)');
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
		if (r.tooManyRedirects || !r.resp || !r.reqUp) {
			endText(res, 502, 'relay: too many redirects');
			return;
		}
		const resp = r.resp;
		const reqUp = r.reqUp;
		const finalUrl = r.finalUrl || target;
		const ct = strHeader(resp.headers['content-type']) || '';
		const base = selfBase(req);

		if (isPlaylist(finalUrl, ct)) {
			const len = Number(strHeader(resp.headers['content-length']) || 0);
			if (len > MAX_PLAYLIST_BYTES) {
				resp.destroy();
				endText(res, 502, 'relay: playlist too large');
				return;
			}
			let text;
			try {
				text = await readTextCapped(maybeDecompress(resp, strHeader(resp.headers['content-encoding'])), MAX_PLAYLIST_BYTES);
			} catch (e) {
				endText(res, 502, /** @type {any} */ (e) && /** @type {any} */ (e).code === 'ECAP' ? 'relay: playlist too large' : 'relay: playlist read error');
				return;
			}
			const body = rewritePlaylist(text, finalUrl, base);
			if (res.headersSent || res.writableEnded) return;
			res.writeHead(resp.statusCode || 200, {
				'content-type': ct || 'application/vnd.apple.mpegurl',
				'access-control-allow-origin': CORS_ORIGIN,
				'cache-control': 'no-cache'
			});
			res.end(body);
			return;
		}

		/** @type {Record<string, string>} */
		const out = {'access-control-allow-origin': CORS_ORIGIN};
		for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'content-encoding']) {
			const v = strHeader(resp.headers[h]);
			if (v) out[h] = v;
		}
		if (res.headersSent || res.writableEnded) { resp.destroy(); return; }
		res.writeHead(resp.statusCode || 200, out);
		if (MAX_STREAM_MS > 0) {
			totalTimer = setTimeout(() => { ac.abort(); reqUp.destroy(new Error('total stream timeout')); }, MAX_STREAM_MS);
		}
		pipeline(resp, res, (err) => {
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
// `node server.js --check [url]` -> plain-text verdict + exit code (0 ok, 1 VPN down, 2 unreachable).
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
		const state = j.vpn === true ? 'PROTECTED (VPN active)'
			: j.vpn === false ? 'UNPROTECTED – VPN down (fail-closed engaged)'
				: 'unknown – the app decides via egress comparison';
		// eslint-disable-next-line no-console
		console.log(`Relay: ${j.ok ? 'running' : '?'} · Protection: ${state}${j.ip ? ' · Egress: ' + j.ip : ''}`);
		process.exit(j.vpn === false ? 1 : 0);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error(`Relay unreachable (${url}): ${errMsg(e)}`);
		process.exit(2);
	}
}

if (process.argv.includes('--check')) {
	runCheck();
} else {
	server.listen(PORT, () => {
		const vpn = vpnState();
		// Startup banner (config only, NO user data). Nothing is logged afterwards.
		// eslint-disable-next-line no-console
		console.log(`phantom_ relay · port ${PORT} · VPN: ${vpn.iface || '(none)'} · fail-closed: ${vpn.known ? 'active' : 'off'} · auth: ${AUTH_MODE} · limits: conc=${MAX_CONCURRENT || 'off'} rate=${RATE_MAX ? RATE_MAX + '/' + Math.round(RATE_WINDOW_MS / 1000) + 's' : 'off'}`);
		if (!vpn.known) {
			// eslint-disable-next-line no-console
			console.warn('WARN: no VPN interface detected -> fail-closed inactive. Set RELAY_VPN_IF (e.g. wg0), otherwise the relay may forward unprotected.');
		}
		if (AUTH_MODE === 'basic' && !AUTH_K) {
			// eslint-disable-next-line no-console
			console.warn('WARN: RELAY_AUTH=basic without RELAY_USER/RELAY_PASS -> ALL /p requests are blocked.');
		}
	});
}
