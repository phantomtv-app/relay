// SPDX-License-Identifier: AGPL-3.0-or-later
// phantom_ Relay – Integrationstests der Auth-/Fail-closed-/SSRF-Matrix (ohne Test-Framework).
//
//   node tests/run.mjs
//
// Startet server.js je Szenario als Kindprozess mit gesetzten ENV auf einem eigenen Port und
// prüft das nach-außen sichtbare Verhalten von /p und /health. Alle Fälle sind OFFLINE und
// deterministisch: keiner löst einen echten Upstream-Request aus (Auth-/VPN-/SSRF-Riegel
// greifen jeweils VOR dem Verbindungsaufbau). RELAY_VPN_IF zeigt bewusst auf ein nicht
// existierendes Interface -> „kein aktives VPN" ist reproduzierbar; RELAY_EGRESS_LOOKUP=0
// unterbindet jeden ausgehenden /health-Call.

import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.js');

let pass = 0;
let fail = 0;
/** @type {string[]} */
const logLines = [];

/**
 * @param {string} name
 * @param {boolean} cond
 * @param {string} [detail]
 */
function check (name, cond, detail = '') {
	if (cond) { pass++; logLines.push(`  PASS  ${name}`); }
	else { fail++; logLines.push(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextPort = 18787;

/**
 * server.js als Kindprozess starten und auf Erreichbarkeit von /health warten.
 * @param {Record<string,string>} env
 * @returns {Promise<{child: import('node:child_process').ChildProcess, port: number, base: string}>}
 */
async function startServer (env) {
	const port = nextPort++;
	const child = spawn(process.execPath, [SERVER], {
		env: {...process.env, PORT: String(port), ...env},
		stdio: ['ignore', 'ignore', 'ignore']
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 60; i++) {
		if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
		try {
			const r = await fetch(`${base}/health`);
			if (r.status > 0) { await r.text(); return {child, port, base}; }
		} catch (_e) { /* noch nicht bereit */ }
		await sleep(100);
	}
	throw new Error(`server on ${port} not ready`);
}

/** @param {import('node:child_process').ChildProcess} child */
function stopServer (child) {
	return new Promise((resolve) => {
		if (child.exitCode !== null) { resolve(undefined); return; }
		child.once('exit', () => resolve(undefined));
		child.kill('SIGTERM');
		setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* noop */ } }, 2000);
	});
}

// Gemeinsame Basis-ENV: kein reales VPN-Interface, kein ausgehender Egress-Lookup.
const NO_VPN = {RELAY_VPN_IF: 'wg-test-none', RELAY_EGRESS_LOOKUP: '0'};

/**
 * Ein Szenario: Server mit ENV starten, Assertions ausführen, Server stoppen.
 * @param {Record<string,string>} env
 * @param {(ctx: {base: string}) => Promise<void>} body
 */
async function scenario (env, body) {
	const {child, base} = await startServer(env);
	try {
		await body({base});
	} finally {
		await stopServer(child);
	}
}

async function main () {
	// (a) RELAY_AUTH unset -> /p wird verweigert (deny, fail-closed). Auth-Riegel VOR VPN-Guard -> 403.
	await scenario({...NO_VPN}, async ({base}) => {
		const r = await fetch(`${base}/p?u=${encodeURIComponent('http://example.com/')}`);
		check('(a) AUTH unset -> /p 403', r.status === 403, `status=${r.status}`);
	});

	// (b) RELAY_AUTH=open ohne VPN -> /p 503 (Fail-closed greift, da kein aktives Interface).
	await scenario({...NO_VPN, RELAY_AUTH: 'open'}, async ({base}) => {
		const r = await fetch(`${base}/p?u=${encodeURIComponent('http://example.com/')}`);
		const body = await r.text();
		check('(b) AUTH=open, kein VPN -> /p 503', r.status === 503, `status=${r.status}`);
		check('(b) 503-Text nennt fail-closed', /fail-closed/.test(body), body);
	});

	// (c) +RELAY_ALLOW_UNPROTECTED=1 -> /p passiert den VPN-Guard. Ziel 127.0.0.1 wird danach
	//     vom SSRF-Schutz mit 403 „target not allowed" abgelehnt -> beweist die Guard-Passage
	//     (ohne Opt-out käme zuerst der 503-Fail-closed).
	await scenario({...NO_VPN, RELAY_AUTH: 'open', RELAY_ALLOW_UNPROTECTED: '1'}, async ({base}) => {
		const r = await fetch(`${base}/p?u=${encodeURIComponent('http://127.0.0.1/')}`);
		const body = await r.text();
		check('(c) ALLOW_UNPROTECTED -> VPN-Guard passiert (kein 503)', r.status !== 503, `status=${r.status}`);
		check('(c) danach SSRF-Riegel: 403 target not allowed', r.status === 403 && /not allowed/.test(body), `status=${r.status} body=${body}`);
	});

	// (d) RELAY_AUTH=basic ohne Credentials -> alles blockiert: 401 + WWW-Authenticate.
	await scenario({...NO_VPN, RELAY_AUTH: 'basic'}, async ({base}) => {
		const r = await fetch(`${base}/p?u=${encodeURIComponent('http://example.com/')}`);
		await r.text();
		check('(d) basic ohne Credentials -> 401', r.status === 401, `status=${r.status}`);
		check('(d) 401 sendet WWW-Authenticate', !!r.headers.get('www-authenticate'), 'header fehlt');
	});

	// (e) SSRF-Matrix: private/loopback/link-local/metadata-Ziele + Nicht-HTTP-Schema -> 403.
	//     Auth offen + VPN-Guard aus, damit der SSRF-Schutz isoliert getestet wird.
	await scenario({...NO_VPN, RELAY_AUTH: 'open', RELAY_ALLOW_UNPROTECTED: '1'}, async ({base}) => {
		const targets = [
			'http://127.0.0.1/',
			'http://169.254.169.254/latest/meta-data/', // Cloud-Metadata
			'http://[::1]/',
			'http://192.168.0.1/',
			'http://10.0.0.1/',
			'file:///etc/passwd' // Nicht-HTTP-Schema
		];
		let allBlocked = true;
		let firstBad = '';
		for (const t of targets) {
			const r = await fetch(`${base}/p?u=${encodeURIComponent(t)}`);
			await r.text();
			if (r.status !== 403) { allBlocked = false; firstBad = `${t} -> ${r.status}`; break; }
		}
		check('(e) SSRF: private/metadata/nicht-http-Ziele -> 403', allBlocked, firstBad);
	});

	// (e2) SSRF (FIX 1): IANA-Sonder-/Dokumentationsnetze (TEST-NET-1/2/3) sind nicht global routbar und
	//      müssen ebenso mit 403 blockiert werden. Gleiches Muster wie (e).
	await scenario({...NO_VPN, RELAY_AUTH: 'open', RELAY_ALLOW_UNPROTECTED: '1'}, async ({base}) => {
		const targets = [
			'http://192.0.2.1/',    // TEST-NET-1 192.0.2.0/24
			'http://198.51.100.1/', // TEST-NET-2 198.51.100.0/24
			'http://203.0.113.1/'   // TEST-NET-3 203.0.113.0/24
		];
		let allBlocked = true;
		let firstBad = '';
		for (const t of targets) {
			const r = await fetch(`${base}/p?u=${encodeURIComponent(t)}`);
			await r.text();
			if (r.status !== 403) { allBlocked = false; firstBad = `${t} -> ${r.status}`; break; }
		}
		check('(e2) SSRF: TEST-NET-Dokumentationsnetze -> 403', allBlocked, firstBad);
	});

	// (f) /health liefert protected:false ohne RELAY_REAL_IP (Schutz nicht attestierbar).
	await scenario({...NO_VPN, RELAY_AUTH: 'open'}, async ({base}) => {
		const r = await fetch(`${base}/health`);
		const j = /** @type {any} */ (await r.json());
		check('(f) /health -> ok:true', j.ok === true, JSON.stringify(j));
		check('(f) /health -> protected:false ohne RELAY_REAL_IP', j.protected === false, JSON.stringify(j));
	});

	// (g) CORS-Preflight: OPTIONS /health -> 204 mit den Preflight-Headern (sonst blockt Chromium den
	//     eigentlichen GET mit dem Authorization-Header im Basic-Modus -> Guard bekäme keinen Status).
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: 'phantom', RELAY_PASS: 'Zuf4ll-Str0ng-Pass'}, async ({base}) => {
		const r = await fetch(`${base}/health`, {method: 'OPTIONS'});
		await r.text();
		check('(g) OPTIONS /health -> 204', r.status === 204, `status=${r.status}`);
		check('(g) Allow-Headers enthält Authorization', /authorization/i.test(r.headers.get('access-control-allow-headers') || ''), r.headers.get('access-control-allow-headers') || '(fehlt)');
		check('(g) Allow-Methods enthält GET', /GET/.test(r.headers.get('access-control-allow-methods') || ''), r.headers.get('access-control-allow-methods') || '(fehlt)');
		check('(g) Max-Age gesetzt', !!r.headers.get('access-control-max-age'), 'header fehlt');
	});

	// (h) GET /health OHNE Auth -> 200, anonym-minimales (nicht-identifizierendes) Objekt mit vpn+protected.
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: 'phantom', RELAY_PASS: 'Zuf4ll-Str0ng-Pass'}, async ({base}) => {
		const r = await fetch(`${base}/health`);
		const j = /** @type {any} */ (await r.json());
		check('(h) GET /health ohne Auth -> 200', r.status === 200, `status=${r.status}`);
		check('(h) /health -> ok:true', j.ok === true, JSON.stringify(j));
		check('(h) /health hat Feld vpn', 'vpn' in j, JSON.stringify(j));
		check('(h) /health hat Feld protected', 'protected' in j, JSON.stringify(j));
	});

	// (i) GET /health MIT gültigem Authorization: Basic -> 200 (Basic-Modus, gesetzte Credentials).
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: 'phantom', RELAY_PASS: 'Zuf4ll-Str0ng-Pass'}, async ({base}) => {
		const cred = Buffer.from('phantom:Zuf4ll-Str0ng-Pass').toString('base64');
		const r = await fetch(`${base}/health`, {headers: {authorization: `Basic ${cred}`}});
		const j = /** @type {any} */ (await r.json());
		check('(i) GET /health mit gültigem Basic -> 200', r.status === 200, `status=${r.status}`);
		check('(i) /health -> ok:true', j.ok === true, JSON.stringify(j));
	});

	// (j) Platzhalter-Ablehnung (FIX 2): basic mit RELAY_PASS=change-me (bekannter Platzhalter). Der Server
	//     macht AUTH_K leer -> fail-closed. Selbst ein /p-Request MIT genau diesen Platzhalter-Credentials
	//     wird mit 401 abgelehnt (die Credentials „funktionieren" nicht, obwohl sie exakt passen).
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: 'phantom', RELAY_PASS: 'change-me'}, async ({base}) => {
		const cred = Buffer.from('phantom:change-me').toString('base64');
		const r = await fetch(`${base}/p?u=${encodeURIComponent('http://example.com/')}`, {headers: {authorization: `Basic ${cred}`}});
		await r.text();
		check('(j) Platzhalter-Passwort change-me -> /p 401 (fail-closed)', r.status === 401, `status=${r.status}`);
	});

	// (k) /health-Auth-Erkennung (Audit-#7 Befund 1): ein FALSCHER Authorization-Header muss 401 liefern,
	//     damit die App (useRelayGuard) falsche Basic-Zugangsdaten erkennt. OHNE Header bleibt die anonyme
	//     Liveness-200 (credential-free), MIT gültigem Header die Detailantwort.
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: 'phantom', RELAY_PASS: 'Zuf4ll-Str0ng-Pass'}, async ({base}) => {
		const rNone = await fetch(`${base}/health`);
		const jNone = /** @type {any} */ (await rNone.json());
		check('(k) /health OHNE Authorization -> 200', rNone.status === 200, `status=${rNone.status}`);
		check('(k) /health OHNE Authorization -> ok:true', jNone.ok === true, JSON.stringify(jNone));

		const bad = Buffer.from('phantom:falsches-Passwort').toString('base64');
		const rBad = await fetch(`${base}/health`, {headers: {authorization: `Basic ${bad}`}});
		const jBad = /** @type {any} */ (await rBad.json());
		check('(k) /health mit FALSCHEM Authorization -> 401', rBad.status === 401, `status=${rBad.status}`);
		check('(k) 401 sendet KEIN www-authenticate (kein Browser-Auth-Dialog)', !rBad.headers.get('www-authenticate'), 'header vorhanden');
		check('(k) 401-Body ok:false', jBad.ok === false, JSON.stringify(jBad));

		const good = Buffer.from('phantom:Zuf4ll-Str0ng-Pass').toString('base64');
		const rGood = await fetch(`${base}/health`, {headers: {authorization: `Basic ${good}`}});
		const jGood = /** @type {any} */ (await rGood.json());
		check('(k) /health mit RICHTIGEM Authorization -> 200', rGood.status === 200, `status=${rGood.status}`);
		check('(k) /health-Detailantwort enthält clientIp', 'clientIp' in jGood, JSON.stringify(jGood));
	});

	// (m) /health meldet `authorized` (R-#7): darf dieser Aufrufer /p nutzen? So erkennt die App eine
	//     irreführende Einrichtung (App-Auth 'open', Relay aber 'deny'/'basic'), bei der /health lebt,
	//     /p aber mit 403 scheitert – statt fälschlich „geschützt" anzuzeigen.
	await scenario({...NO_VPN, RELAY_AUTH: 'open'}, async ({base}) => {
		const j = /** @type {any} */ (await (await fetch(`${base}/health`)).json());
		check('(m) open -> /health authorized:true', j.authorized === true, JSON.stringify(j));
	});
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: 'phantom', RELAY_PASS: 'Zuf4ll-Str0ng-Pass'}, async ({base}) => {
		const jNo = /** @type {any} */ (await (await fetch(`${base}/health`)).json());
		check('(m) basic OHNE Header -> /health authorized:false', jNo.authorized === false, JSON.stringify(jNo));
		const good = Buffer.from('phantom:Zuf4ll-Str0ng-Pass').toString('base64');
		const jOk = /** @type {any} */ (await (await fetch(`${base}/health`, {headers: {authorization: `Basic ${good}`}})).json());
		check('(m) basic mit gültigem Header -> /health authorized:true', jOk.authorized === true, JSON.stringify(jOk));
	});

	// (o) Trim von RELAY_USER/RELAY_PASS (RC-Fix): eine EnvironmentFile-Zeile schleppt je nach Editor/
	//     Zeilenende leicht Rand-Whitespace oder ein CR mit. Der Relay trimmt beide (wie die App die
	//     Eingabe in SettingsPanel), sonst wäre base64('user:pass\r') != base64('user:pass') -> stilles
	//     401 trotz „korrekter" Daten. Env absichtlich mit umgebendem Whitespace + Trailing-CR gesetzt;
	//     der Header trägt exakt den sauberen Token, den der TV baut -> muss authorized:true ergeben.
	await scenario({...NO_VPN, RELAY_AUTH: 'basic', RELAY_USER: '  phantom  ', RELAY_PASS: 'Zuf4ll-Str0ng-Pass\r'}, async ({base}) => {
		const clean = Buffer.from('phantom:Zuf4ll-Str0ng-Pass').toString('base64');
		const jOk = /** @type {any} */ (await (await fetch(`${base}/health`, {headers: {authorization: `Basic ${clean}`}})).json());
		check('(o) Env mit Rand-Whitespace/CR -> getrimmte Credentials authorized:true', jOk.authorized === true, JSON.stringify(jOk));
	});

	// (n) HTTP-END-TO-END des /p-Body-Pfads über einen test-only Mock-Upstream (Reaudit Finding 4).
	// RELAY_TEST_UPSTREAM liefert kanonische Upstream-Antworten OHNE DNS/Route/Socket -> der komplette
	// /p-Pfad läuft ECHT über HTTP: Auth, Modus-Vertrag (raw/media), Dekompression (gzip), Body-Sniff,
	// Rewrite, Streaming, Größenlimit, Chunk-Grenzen, Redirect-Folge, Client-Abbruch. SSRF/VPN sind in
	// (a)-(e) abgedeckt und hier bewusst per RELAY_ALLOW_UNPROTECTED=1 + RELAY_AUTH=open ausgeklammert.
	const mediaManifest =
		'#EXTM3U\n#EXT-X-VERSION:3\n' +
		'#EXT-X-KEY:METHOD=AES-128,URI="https://provider.example/key"\n' +
		'#EXT-X-MAP:URI="init.mp4"\n' +
		'#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg-1.ts\n' +
		'#EXTINF:10,\nhttps://provider.example/abs-2.ts\n#EXT-X-ENDLIST\n';
	const masterManifest =
		'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant-800.m3u8\n' +
		'#EXT-X-STREAM-INF:BANDWIDTH=1600000\nhttps://provider.example/variant-1600.m3u8\n';
	const sourceList =
		'#EXTM3U\n#EXTINF:-1 tvg-id="a",Sender A\nhttp://provider.example/live/a.ts\n' +
		'#EXTINF:-1 tvg-id="b",Sender B\nhttp://provider.example/live/b.ts\n';
	const bigManifest = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + 'seg-xxxxxxxxxxxxxxxxxxxxxxxxxxxx.ts\n'.repeat(120); // > 2 KiB

	const spec = {
		'http://up.test/media.m3u8':         {status: 200, headers: {'content-type': 'application/vnd.apple.mpegurl'}, body: mediaManifest},
		'http://up.test/media-chunked.m3u8': {status: 200, headers: {'content-type': 'application/vnd.apple.mpegurl'}, body: mediaManifest, chunkSize: 5},
		'http://up.test/media.gz':           {status: 200, headers: {'content-type': 'application/vnd.apple.mpegurl', 'content-encoding': 'gzip'}, bodyB64: gzipSync(Buffer.from(mediaManifest)).toString('base64')},
		'http://up.test/master.m3u8':        {status: 200, headers: {'content-type': 'application/vnd.apple.mpegurl'}, body: masterManifest},
		'http://up.test/list.m3u':           {status: 200, headers: {'content-type': 'application/vnd.apple.mpegurl'}, body: sourceList},
		'http://up.test/redir':              {status: 302, headers: {location: 'http://up.test/media.m3u8'}},
		'http://up.test/big.m3u8':           {status: 200, headers: {'content-type': 'application/vnd.apple.mpegurl'}, body: bigManifest},
		'http://up.test/slow.bin':           {status: 200, headers: {'content-type': 'application/octet-stream'}, body: 'X'.repeat(4000), chunkSize: 200, chunkDelayMs: 40},
		// Reaudit-1: gültiges Manifest, aber vom Anbieter als octet-stream ausgeliefert.
		'http://up.test/octet.m3u8':         {status: 200, headers: {'content-type': 'application/octet-stream'}, body: mediaManifest},
		// Reaudit-2: 206-Manifest-FRAGMENT (beginnt NICHT mit #EXTM3U) + echtes binäres 206-Segment.
		'http://up.test/frag206.m3u8':       {status: 206, headers: {'content-type': 'application/vnd.apple.mpegurl', 'content-range': 'bytes 20-70/100'}, body: '#EXTINF:10,\nhttps://provider.example/seg.ts\n'},
		'http://up.test/seg206.ts':          {status: 206, headers: {'content-type': 'application/octet-stream', 'content-range': 'bytes 0-15/1000'}, body: 'BINARYSEGMENTNOEXTTAGS-1234567890'}
	};
	const specPath = join(tmpdir(), `phantom_relay_upstream_${process.pid}.json`);
	writeFileSync(specPath, JSON.stringify(spec));
	const E2E = {...NO_VPN, RELAY_AUTH: 'open', RELAY_ALLOW_UNPROTECTED: '1', RELAY_TEST_UPSTREAM: specPath};
	const P = (t, mode) => `/p?u=${encodeURIComponent(t)}${mode ? `&mode=${mode}` : ''}`;
	const relayed = (t) => '/p?u=' + encodeURIComponent(t) + '&mode=media';   // erwartete umgeschriebene Referenz
	const noBareProvider = (b) => !/(^|\n)https?:\/\/provider\.example/.test(b) && !/(^|\n)seg-1\.ts/.test(b);

	await scenario(E2E, async ({base}) => {
		// media: HLS-Manifest wird umgeschrieben – Segment/KEY/MAP/absolutes Segment -> /p&mode=media.
		const r = await fetch(`${base}${P('http://up.test/media.m3u8', 'media')}`);
		const b = await r.text();
		check('(n) media: Status 200', r.status === 200, `status=${r.status}`);
		check('(n) media: relatives Segment -> /p&mode=media', b.includes(relayed('http://up.test/seg-1.ts')), b);
		check('(n) media: absolutes Segment -> /p&mode=media', b.includes(relayed('https://provider.example/abs-2.ts')), b);
		check('(n) media: EXT-X-KEY URI -> /p&mode=media', b.includes('URI="') && b.includes(relayed('https://provider.example/key')), b);
		check('(n) media: EXT-X-MAP URI -> /p&mode=media', b.includes(relayed('http://up.test/init.mp4')), b);
		check('(n) media: keine nackte Provider-/Segment-URL bleibt', noBareProvider(b), b);

		// Reaudit-1: body-erkanntes HLS bekommt IMMER den HLS-MIME (auch wenn der Anbieter octet-stream
		// liefert) – sonst könnte der native webOS-Player das korrekt geroutete Manifest ablehnen.
		const ro = await fetch(`${base}${P('http://up.test/octet.m3u8', 'media')}`);
		const bo = await ro.text();
		check('(n) Reaudit-1: octet-stream-Manifest wird umgeschrieben', bo.includes(relayed('http://up.test/seg-1.ts')), bo);
		check('(n) Reaudit-1: Response-MIME ist HLS (nicht octet-stream)', (ro.headers.get('content-type') || '').includes('mpegurl'), ro.headers.get('content-type') || '');

		// Reaudit-2: ein 206-Manifest-FRAGMENT (kein #EXTM3U am Start) darf NICHT unumgeschrieben durch
		// -> fail-closed 502 (die enthaltene Segment-URL würde sonst direkt beim Anbieter laden = IP-Leak).
		const rf = await fetch(`${base}${P('http://up.test/frag206.m3u8', 'media')}`);
		const bf = await rf.text();
		check('(n) Reaudit-2: 206-Manifest-Fragment -> 502 (fail-closed)', rf.status === 502, `status=${rf.status}`);
		check('(n) Reaudit-2: 206-Fragment leakt KEINE Provider-URL', !bf.includes('provider.example/seg.ts'), bf);

		// Reaudit-2 Gegenprobe: ein echtes (binäres) 206-Segment ist KEIN Playlist-Fragment -> passiert
		// unverändert durch (Range/Seeking bleibt erhalten), KEIN 502.
		const rs = await fetch(`${base}${P('http://up.test/seg206.ts', 'media')}`);
		const bs = await rs.text();
		check('(n) Reaudit-2: binäres 206-Segment passiert (kein 502)', rs.status !== 502 && bs.includes('BINARYSEGMENT'), `status=${rs.status}`);

		// mode=raw auf DEMSELBEN Manifest: unveränderter Durchsatz (Modus-Vertrag). Bytegleich.
		const rr = await fetch(`${base}${P('http://up.test/media.m3u8', 'raw')}`);
		const br = await rr.text();
		check('(n) raw: HLS-Manifest UNVERÄNDERT durchgereicht (bytegleich)', br === mediaManifest, br);
		check('(n) raw: content-type erhalten', (rr.headers.get('content-type') || '').includes('mpegurl'), rr.headers.get('content-type') || '');

		// Quell-Senderliste über raw: unverändert (kein doppeltes /p-Routing beim Import).
		const rl = await fetch(`${base}${P('http://up.test/list.m3u', 'raw')}`);
		const bl = await rl.text();
		check('(n) raw: Quell-M3U-Liste unverändert durchgereicht', bl === sourceList, bl);

		// gzip: Upstream komprimiert -> Relay dekomprimiert, sniffet, schreibt um.
		const rg = await fetch(`${base}${P('http://up.test/media.gz', 'media')}`);
		const bg = await rg.text();
		check('(n) gzip: dekomprimiert + umgeschrieben', rg.status === 200 && bg.includes(relayed('http://up.test/seg-1.ts')), bg);
		check('(n) gzip: Antwort NICHT mehr gzip-codiert', !(rg.headers.get('content-encoding') || '').includes('gzip'), rg.headers.get('content-encoding') || '');

		// verschachtelte Manifeste (Master-Playlist): Varianten-URLs -> /p&mode=media (re-entry ins Relay).
		const rm = await fetch(`${base}${P('http://up.test/master.m3u8', 'media')}`);
		const bm = await rm.text();
		check('(n) master: relative Variante -> /p&mode=media', bm.includes(relayed('http://up.test/variant-800.m3u8')), bm);
		check('(n) master: absolute Variante -> /p&mode=media', bm.includes(relayed('https://provider.example/variant-1600.m3u8')), bm);

		// Redirect: 302 -> media.m3u8. Basis für relative URLs ist die FINALE URL (nach dem Hop).
		const rd = await fetch(`${base}${P('http://up.test/redir', 'media')}`);
		const bd = await rd.text();
		check('(n) redirect: gefolgt + umgeschrieben (Basis = Ziel nach Hop)', rd.status === 200 && bd.includes(relayed('http://up.test/seg-1.ts')), bd);

		// Teil-Chunks: Manifest in 5-Byte-Chunks -> Sniff muss über Chunk-Grenzen erkennen.
		const rc = await fetch(`${base}${P('http://up.test/media-chunked.m3u8', 'media')}`);
		const bc = await rc.text();
		check('(n) chunked: Sniff über Chunk-Grenzen -> erkannt + umgeschrieben', rc.status === 200 && bc.includes(relayed('http://up.test/seg-1.ts')), bc);

		// unbekanntes Ziel im Testmodus -> 403 (schlägt nie aufs echte Netz durch).
		const ru = await fetch(`${base}${P('http://up.test/does-not-exist', 'raw')}`);
		await ru.text();
		check('(n) unbekanntes Ziel im Testmodus -> 403 (kein echtes Netz)', ru.status === 403, `status=${ru.status}`);

		// Client-Abbruch mitten im Stream: Server muss überleben (Slot frei, kein Crash).
		const ctrl = new AbortController();
		try {
			const rs = await fetch(`${base}${P('http://up.test/slow.bin', 'raw')}`, {signal: ctrl.signal});
			const reader = /** @type {any} */ (rs.body).getReader();
			await reader.read();
			ctrl.abort();
		} catch (_e) { /* AbortError erwartet */ }
		const h = await fetch(`${base}/health`);
		check('(n) Server überlebt Client-Abbruch: /health 200', h.status === 200, `status=${h.status}`);
		await h.text();
		const r2 = await fetch(`${base}${P('http://up.test/list.m3u', 'raw')}`);
		const b2 = await r2.text();
		check('(n) nach Abbruch: frischer /p-Request funktioniert', r2.status === 200 && b2.startsWith('#EXTM3U'), `status=${r2.status}`);
	});

	// Größenlimit: eigener Serverstart mit kleinem Cap -> Manifest > Cap -> 502 „playlist too large".
	await scenario({...E2E, RELAY_MAX_PLAYLIST_BYTES: '2048'}, async ({base}) => {
		const r = await fetch(`${base}${P('http://up.test/big.m3u8', 'media')}`);
		const b = await r.text();
		check('(n) Größenlimit: Manifest > Cap -> 502', r.status === 502 && /too large/.test(b), `status=${r.status} body=${b.slice(0, 60)}`);
	});

	unlinkSync(specPath);

	// (l) HLS-Body-Erkennung + Rewrite (PRIV, P0). Unit-Test der reinen Helfer: ein lokaler Mock-
	// Upstream ist über /p NICHT erreichbar (SSRF blockiert alle privaten/loopback-IPs), deshalb wird
	// die Kern-Logik direkt geprüft. server.js wird mit RELAY_NO_LISTEN importiert (kein Serverstart);
	// das Flag wird sofort wieder entfernt, damit die scenario()-Kindprozesse es NICHT erben.
	process.env.RELAY_NO_LISTEN = '1';
	const relay = /** @type {any} */ ((await import(pathToFileURL(SERVER).href)).default);
	delete process.env.RELAY_NO_LISTEN;
	const bomM3U = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n')]);
	// looksLikeM3U erkennt JEDE Playlist, die nach optionalem UTF-8-BOM + fuehrendem Whitespace mit
	// #EXTM3U beginnt (KEIN #EXT-X--Erfordernis mehr). Im media-Modus kommt keine Quell-Senderliste mehr
	// (die laeuft ueber mode=raw) -> kein Falschpositiv-Konflikt; und da #EXTM3U immer die ERSTE Zeile ist,
	// entfaellt der fruehere 8-KiB-Bypass (kein Suchen weit hinten im Body).
	check('(l) looksLikeM3U: Media-Playlist (#EXT-X-TARGETDURATION)', relay.looksLikeM3U(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg.ts')), '');
	check('(l) looksLikeM3U: #EXTM3U hinter UTF-8-BOM', relay.looksLikeM3U(bomM3U), '');
	check('(l) looksLikeM3U: #EXTM3U hinter fuehrendem Whitespace', relay.looksLikeM3U(Buffer.from('  \n\t#EXTM3U\n#EXT-X-VERSION:3\n')), '');
	// P0-FIX (8-KiB-Bypass): #EXTM3U am Anfang + ~9000 Zeichen Kommentar + spaetes #EXT-X-. Frueher wurde
	// das #EXT-X- ausserhalb der 8-KiB-Sniffzone nicht gefunden -> unerkannt -> Leak. Jetzt genuegt das
	// #EXTM3U ganz vorn -> erkannt.
	const lateTag = '#EXTM3U\n' + '#comment\n'.repeat(1000) + '#EXT-X-TARGETDURATION:10\nseg.ts';
	check('(l) looksLikeM3U TRUE bei #EXTM3U + langem Kommentar + spaetem #EXT-X- [8-KiB-Bypass-Fix]', relay.looksLikeM3U(Buffer.from(lateTag)) && lateTag.length > 9000, `len=${lateTag.length}`);
	check('(l) looksLikeM3U FALSE bei HTML', !relay.looksLikeM3U(Buffer.from('<!DOCTYPE html>')), '');
	check('(l) looksLikeM3U FALSE bei binaerem TS (0x47)', !relay.looksLikeM3U(Buffer.from([0x47, 0x40, 0x00, 0x10])), '');
	check('(l) looksLikeM3U FALSE bei zu kurzem Body', !relay.looksLikeM3U(Buffer.from('#EXT')), '');
	// Body beginnt NICHT mit #EXTM3U (auch wenn #EXT-X- spaeter vorkommt) -> FALSE (kein Falschpositiv).
	check('(l) looksLikeM3U FALSE wenn Body nicht mit #EXTM3U beginnt', !relay.looksLikeM3U(Buffer.from('#EXTINF:-1,Sender\n#EXT-X-IRGENDWAS\nhttp://provider.example/1.ts')), '');
	// looksLikePlaylistFragment (Reaudit-2): erkennt ein 206-Manifest-Fragment an #EXTINF/#EXT-X- im
	// Body ODER an Playlist-URL/-MIME; ein binäres Segment (kein #EXT, .ts, octet-stream) ist FALSE.
	check('(l) Fragment: #EXTINF im Body -> true', relay.looksLikePlaylistFragment(Buffer.from('#EXTINF:10,\nhttp://x/s.ts'), 'http://x/frag', ''), '');
	check('(l) Fragment: #EXT-X- im Body -> true', relay.looksLikePlaylistFragment(Buffer.from('#EXT-X-KEY:METHOD=AES-128\n'), 'http://x/frag', ''), '');
	check('(l) Fragment: .m3u8-URL -> true (auch ohne #EXT)', relay.looksLikePlaylistFragment(Buffer.from('binary'), 'http://x/play.m3u8', 'application/octet-stream'), '');
	check('(l) Fragment: mpegurl-MIME -> true', relay.looksLikePlaylistFragment(Buffer.from('binary'), 'http://x/opaque', 'application/vnd.apple.mpegurl'), '');
	check('(l) Fragment: binaeres Segment (.ts, octet, kein #EXT) -> false', !relay.looksLikePlaylistFragment(Buffer.from('BINARYDATA-no-tags'), 'http://x/seg.ts', 'application/octet-stream'), '');
	const pl = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://provider.example/key"\n#EXT-X-MAP:URI="init.mp4"\nseg-1.ts\nhttps://provider.example/abs-2.ts';
	const rw = relay.rewritePlaylist(pl, 'https://provider.example/live/index.m3u8', 'http://relay.local');
	// Segment-/Key-/Map-URLs -> /p?u=... und tragen &mode=media (verschachtelte Manifeste bleiben HLS-erkannt).
	check('(l) rewrite: relatives Segment -> /p?u=&mode=media', rw.includes('/p?u=' + encodeURIComponent('https://provider.example/live/seg-1.ts') + '&mode=media'), rw);
	check('(l) rewrite: absolutes Segment -> /p?u=&mode=media', rw.includes('/p?u=' + encodeURIComponent('https://provider.example/abs-2.ts') + '&mode=media'), rw);
	check('(l) rewrite: EXT-X-KEY URI -> /p?u=&mode=media', rw.includes('URI="http://relay.local/p?u=' + encodeURIComponent('https://provider.example/key') + '&mode=media"'), rw);
	check('(l) rewrite: EXT-X-MAP URI -> /p?u=&mode=media', rw.includes('URI="http://relay.local/p?u=' + encodeURIComponent('https://provider.example/live/init.mp4') + '&mode=media"'), rw);
	check('(l) rewrite: alle 4 umgeschriebenen URLs tragen &mode=media', (rw.match(/&mode=media/g) || []).length === 4, rw);
	check('(l) rewrite: keine nackte Provider-URL bleibt uebrig', !/(^|\n)https:\/\/provider\.example/.test(rw), rw);

	console.log('phantom_ Relay-Integrationstests\n');
	console.log(logLines.join('\n'));
	console.log(`\nErgebnis: ${pass} bestanden, ${fail} fehlgeschlagen`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error('Testlauf abgebrochen:', e);
	process.exit(2);
});
