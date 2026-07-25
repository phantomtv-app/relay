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
// (127.x, 10/172.16/192.168, 169.254 cloud metadata, IPv6 ULA/link-local). Redirects are re-checked.
//
// FAIL-CLOSED: if the VPN drops (interface gone), /p refuses to forward anything (HTTP 503).
//
// Configuration (all optional, via ENV):
//   PORT=8787
//   RELAY_VPN_IF=wg0        VPN interface. Recommended to set explicitly (unambiguous fail-closed).
//   RELAY_AUTH=open|ip|basic  Access control (default: open).
//     ip:    RELAY_ALLOW=1.2.3.4,5.6.7.8   allowed client IPs
//     basic: RELAY_USER=... RELAY_PASS=...  username/password (WITHOUT them, EVERYTHING is blocked)
//   RELAY_EGRESS_LOOKUP=1   show the relay's own exit IP in /health, looked up via RELAY_EGRESS_URL
//                           (own endpoint, default https://phantomtv.app/api/my-ip). Default ON
//                           (opt-out with =0); enables the app's own-IP-vs-relay-IP comparison.
//
// No runtime dependencies (Node 18+ with global fetch).

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const {Readable} = require('node:stream');

const PORT = process.env.PORT || 8787;
const UPSTREAM_TIMEOUT = 20000; // do not let the upstream fetch hang forever (DoS protection)
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024; // playlists are read into memory -> cap the size

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
	return true; // open
}

// --- SSRF protection: target validation ---------------------------------------
/**
 * True if the IP is in a private/loopback/link-local/reserved range the relay must never reach.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIp (ip) {
	if (!ip) return true;
	const s = String(ip).replace(/^::ffff:/i, '').toLowerCase();
	const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (m) {
		const a = +m[1]; const b = +m[2];
		if (a === 127 || a === 0 || a === 10) return true;          // loopback / "this" / RFC1918
		if (a === 172 && b >= 16 && b <= 31) return true;           // RFC1918
		if (a === 192 && b === 168) return true;                    // RFC1918
		if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
		if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
		if (a >= 224) return true;                                  // multicast / reserved
		return false;
	}
	if (s === '::1' || s === '::' || s === '') return true;         // IPv6 loopback / unspecified
	if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // link-local / ULA
	return false;
}

/**
 * Only allows http/https to public targets. Resolves hostnames and checks EVERY address.
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function targetAllowed (target) {
	let u;
	try { u = new URL(target); } catch (_e) { return false; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
	const host = u.hostname.replace(/^\[|\]$/g, '');
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return !isBlockedIp(host);
	try {
		const addrs = await dns.lookup(host, {all: true});
		return addrs.length > 0 && addrs.every((a) => !isBlockedIp(a.address));
	} catch (_e) {
		return false;
	}
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
 * Current state of the expected VPN interface.
 * @returns {{known: boolean, up: boolean, iface: string|null}}
 */
function vpnState () {
	if (!EXPECTED_IF) return {known: false, up: false, iface: null};
	const addrs = os.networkInterfaces()[EXPECTED_IF];
	const up = !!(addrs && addrs.some((a) => !a.internal));
	return {known: true, up, iface: EXPECTED_IF};
}

// --- Exit IP (through the VPN); OFF by default (privacy) -----------------------
// Default ON: /health meldet die eigene Ausgangs-IP, damit die App den IP-Vergleich (eigene IP
// vs. Relay-Ausgangs-IP) zuverlässig zeigen kann, ohne den unzuverlässigen /p-Stream-Proxy. Der
// Abruf geht DURCH den Tunnel an den eigenen /api/my-ip-Endpunkt (kein Dritt-Dienst, keine
// Nutzerdaten). Opt-out mit RELAY_EGRESS_LOOKUP=0.
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

// --- Playlist rewriting (HLS) -------------------------------------------------
/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function selfBase (req) {
	const proto = req.headers['x-forwarded-proto'] || 'http';
	return `${proto}://${req.headers.host}`;
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

/**
 * Fetch the upstream, follow redirects MANUALLY and re-check every target for SSRF.
 * @param {string} target
 * @param {Record<string, string>} headers
 * @returns {Promise<{blocked?: boolean, tooManyRedirects?: boolean, resp?: Response, finalUrl?: string}>}
 */
async function fetchChecked (target, headers) {
	let current = target;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!(await targetAllowed(current))) return {blocked: true};
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);
		const resp = await fetch(current, {headers, redirect: 'manual', signal: ctrl.signal}).finally(() => clearTimeout(to));
		const loc = resp.headers.get('location');
		if (resp.status >= 300 && resp.status < 400 && loc) {
			current = new URL(loc, current).toString();
			continue;
		}
		return {resp, finalUrl: current};
	}
	return {tooManyRedirects: true};
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || '/', 'http://localhost');

	if (url.pathname === '/' || url.pathname === '/health') {
		const vpn = vpnState();
		const eg = await getEgress();
		res.writeHead(200, {
			'content-type': 'application/json',
			'access-control-allow-origin': '*',
			'cache-control': 'no-store'
		});
		// Deliberately minimal: vpn status for the app's kill switch. Egress details ONLY if the
		// operator enabled the lookup. NO auth mode (avoid recon).
		res.end(JSON.stringify({
			ok: true,
			vpn: vpn.known ? vpn.up : null,
			iface: vpn.iface,
			ip: (eg && eg.ip) || null,
			country: (eg && eg.country) || '',
			isp: (eg && eg.isp) || ''
		}));
		return;
	}

	if (url.pathname !== '/p') {
		res.writeHead(404, {'content-type': 'text/plain', 'access-control-allow-origin': '*'});
		res.end('not found');
		return;
	}

	// ACCESS CONTROL (only /p; /health stays open for the app's check).
	if (!authOk(req, url)) {
		res.writeHead(AUTH_MODE === 'basic' ? 401 : 403, Object.assign(
			{'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store'},
			AUTH_MODE === 'basic' ? {'www-authenticate': 'Basic realm="phantom relay"'} : {}
		));
		res.end('relay: unauthorized');
		return;
	}

	// FAIL-CLOSED: if the expected VPN interface is gone, forward NOTHING.
	const vpn = vpnState();
	if (vpn.known && !vpn.up) {
		res.writeHead(503, {'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store'});
		res.end('relay blocked: VPN down (fail-closed)');
		return;
	}

	const target = url.searchParams.get('u');
	if (!target) {
		res.writeHead(400, {'content-type': 'text/plain', 'access-control-allow-origin': '*'});
		res.end('missing ?u=');
		return;
	}

	try {
		/** @type {Record<string, string>} */
		const headers = {};
		if (req.headers.range) headers.range = req.headers.range;
		if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

		const r = await fetchChecked(target, headers);
		if (r.blocked) {
			res.writeHead(403, {'content-type': 'text/plain', 'access-control-allow-origin': '*'});
			res.end('relay: target not allowed');
			return;
		}
		if (r.tooManyRedirects || !r.resp) {
			res.writeHead(502, {'content-type': 'text/plain', 'access-control-allow-origin': '*'});
			res.end('relay: too many redirects');
			return;
		}
		const upstream = r.resp;
		const finalUrl = r.finalUrl || target;
		const ct = upstream.headers.get('content-type') || '';
		const base = selfBase(req);

		if (isPlaylist(finalUrl, ct)) {
			const len = Number(upstream.headers.get('content-length') || 0);
			if (len > MAX_PLAYLIST_BYTES) {
				res.writeHead(502, {'content-type': 'text/plain', 'access-control-allow-origin': '*'});
				res.end('relay: playlist too large');
				return;
			}
			const text = await upstream.text();
			const body = rewritePlaylist(text, finalUrl, base);
			res.writeHead(upstream.status, {
				'content-type': ct || 'application/vnd.apple.mpegurl',
				'access-control-allow-origin': '*',
				'cache-control': 'no-cache'
			});
			res.end(body);
			return;
		}

		/** @type {Record<string, string>} */
		const out = {'access-control-allow-origin': '*'};
		for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
			const v = upstream.headers.get(h);
			if (v) out[h] = v;
		}
		res.writeHead(upstream.status, out);
		if (upstream.body) {
			Readable.fromWeb(upstream.body).pipe(res);
		} else {
			res.end();
		}
	} catch (e) {
		res.writeHead(502, {'content-type': 'text/plain', 'access-control-allow-origin': '*'});
		res.end(`relay error: ${e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : e}`);
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
		console.error(`Relay unreachable (${url}): ${e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : e}`);
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
		console.log(`phantom_ relay · port ${PORT} · VPN: ${vpn.iface || '(none)'} · fail-closed: ${vpn.known ? 'active' : 'off'} · auth: ${AUTH_MODE}`);
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
