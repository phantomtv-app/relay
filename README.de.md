<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/phantom-logo-dark.svg">
    <img src="brand/phantom-logo-light.svg" alt="phantom_" width="260">
  </picture>
</p>

<p align="center"><a href="README.md">English</a> · <b>Deutsch</b></p>

# phantom_ Relay

Ein winziger, selbst betriebener Proxy, der den Anbieter-Verkehr von **phantom_** (Streams,
Xtream-API, EPG, Logos) **durch dein eigenes VPN** schickt. Dein IPTV-Anbieter sieht dann die
Ausgangs-IP deines Relays statt der öffentlichen IP deines Zuhauses.

- **Optional** – phantom_ läuft auch ohne Relay.
- **Selbst gehostet** – es gibt keinen geteilten Server von uns. Du betreibst ihn hinter deinem VPN.
- **Kein Logging** – der Relay schreibt **nichts** über den Verkehr mit (keine Zugriffslogs, keine
  URLs, keine IPs). Details unten.
- **Herstellerneutral** – egal welches VPN (WireGuard, OpenVPN, dein Anbieter deiner Wahl).
- **Winzig** – `server.js` ist reines Node mit **null Laufzeit-Abhängigkeiten**; typgeprüft per
  `// @ts-check` + JSDoc (TypeScript nur als Dev-Abhängigkeit, kein Build-Schritt — die Datei, die du liest, läuft auch).

---

## ⚖️ Nutzung & Haftungsausschluss

Der phantom_ Relay ist ein **allgemeines Datenschutz-Werkzeug** (ein Proxy). Er stellt **keine
Inhalte** bereit – keine Sender, Playlists oder Streams.

Du bist **allein verantwortlich**, ihn nur mit Quellen zu nutzen, für die du die Rechte hast, und
alle **geltenden Gesetze** sowie die Nutzungsbedingungen deiner Anbieter einzuhalten. Nutze ihn
**nicht** für rechtswidrige Zwecke. Die Software wird „wie besehen", **ohne Gewähr**, bereitgestellt.

---

## Was du brauchst

- **Einen Server, der immer läuft:** VPS, NAS, Mini-PC, Proxmox-LXC, Raspberry Pi …
- **Ein VPN auf diesem Server** – dein eigener WireGuard-Server oder die Client-Config (`.conf`)
  deines Anbieters. Der Relay bringt **kein** VPN mit; er nutzt deins.
- **Docker** (einfachster Weg) **oder Node.js 18+** (Standalone).

---

## Installation

Wähle **einen** Weg. Kein Klonen nötig.

### A) Docker – ein Container (empfohlen)

Das veröffentlichte Image bündelt WireGuard + Relay. Config rein, ENV setzen, starten.

```bash
docker run -d --name phantom-relay \
  --cap-add NET_ADMIN --device /dev/net/tun \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -v "$PWD/wg0.conf:/etc/wireguard/wg0.conf:ro" \
  -e RELAY_VPN_IF=wg0 -p 8787:8787 \
  --restart unless-stopped ghcr.io/phantomtv-app/relay:latest
```

Lieber compose? Nur die Datei holen – auch ohne Klonen:
```bash
curl -O https://raw.githubusercontent.com/phantomtv-app/relay/main/docker-compose.yml
cp /pfad/zu/deiner/wg0.conf .        # deine VPN-Config daneben
docker compose up -d
```

ENV ändern → `docker compose up -d`. Neustart → `docker restart phantom-relay`. Prüfen →
`docker exec phantom-relay node server.js --check`.

*Host fährt schon ein VPN?* Dann ohne Config-Mount + Caps, dafür `--network host` und
`-e RELAY_VPN_IF=<dein-if>`.

### B) Proxmox VE (LXC) – ein Befehl

**Auf dem Proxmox-Host** ausführen. Legt einen Debian-LXC an und installiert WireGuard + Relay:
```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/proxmox-lxc.sh)"
```

### C) Standalone (Debian/Ubuntu, ohne Docker) – ein Befehl

```bash
sudo bash -c "$(wget -qLO - https://raw.githubusercontent.com/phantomtv-app/relay/main/install.sh)"
```
Installiert Node (falls nötig), den Relay nach `/opt/phantom-relay` und den systemd-Dienst
`phantom-relay`. Konfiguration in `/etc/phantom-relay.env`.

---

## Zugangsschutz

Drei Modi über `RELAY_AUTH` (die App bekommt demnächst passende Felder):

| Modus | Setzt du | Wirkung |
|---|---|---|
| `open` (Standard) | – | Kein Schutz. Nur im eigenen/vertrauten Netz. |
| `ip` | `RELAY_ALLOW=1.2.3.4,5.6.7.8` | Nur diese Client-IPs dürfen `/p`. |
| `basic` | `RELAY_USER=…` `RELAY_PASS=…` | Benutzer/Passwort. Per `Authorization: Basic` **und** (für `<video>` ohne Header) als `?k=<base64(user:pass)>` in der URL. |

`/health` bleibt offen (nur Liveness/Status, keine Inhalte).

---

## Datenschutz – kein Logging

Der Relay schreibt **nichts** über den Verkehr mit: **keine** Zugriffslogs, **keine** URLs,
**keine** Client-IPs, **keine** Stream-Daten – weder in Dateien noch in eine Datenbank. Einzige
Ausgabe ist **ein** Start-Banner (Port + Auth-Modus, keine Nutzerdaten).

Der **einzige** zusätzliche ausgehende Aufruf ist der Egress-Lookup: der Relay fragt seine **eigene**
Egress-IP über **deinen eigenen Endpunkt** (`RELAY_EGRESS_URL`, Standard `https://phantomtv.app/api/my-ip`
— kein Dritter) für die `/health`-Anzeige ab (nur die VPN-IP des Relays, keine Nutzerdaten). Dieser
Lookup ist **standardmäßig an** (damit die App den IP-Vergleich zeigen kann); abschalten mit
`RELAY_EGRESS_LOOKUP=0` — dann macht der Relay **keinerlei** zusätzliche ausgehende Aufrufe.

---

## Konfiguration — alle Parameter

Alles wird über Umgebungsvariablen gesetzt (Docker `-e` / compose `environment`, oder
`/etc/phantom-relay.env` bei der systemd-Installation). Alle optional.

### `PORT`
Standard `8787`. TCP-Port, auf dem der Relay lauscht. Die Adresse in der App ist
`http://<server>:<PORT>`.

### `RELAY_VPN_IF`
Name des VPN-Interfaces, das der Relay für den Fail-Closed-Check überwacht (z. B. `wg0`, `tun0`).
**Explizit setzen empfohlen.** Ohne Angabe wird beim Start ein gängiges Interface automatisch
erkannt und festgehalten; verschwindet es später, gilt das VPN als down. Lässt sich KEIN Interface
bestimmen, ist Fail-Closed inaktiv (der Relay warnt beim Start) und der Schutz hängt am
Egress-Vergleich der App — also setzen.

### `RELAY_AUTH`
Zugangsschutz-Modus:
- `open` (Standard) — kein Schutz. Nur im eigenen/vertrauten Netz.
- `ip` — nur die Client-IPs aus `RELAY_ALLOW` dürfen `/p`.
- `basic` — Benutzer/Passwort (`RELAY_USER` / `RELAY_PASS`).

### `RELAY_ALLOW`
Nur bei `RELAY_AUTH=ip`. Kommagetrennte erlaubte Client-IPs, z. B. `1.2.3.4,5.6.7.8`. Nutzt die
echte Socket-Peer-Adresse (`x-forwarded-for` wird nie vertraut). Leere Liste = nichts erlaubt.

### `RELAY_USER` / `RELAY_PASS`
Nur bei `RELAY_AUTH=basic`. Benutzername und Passwort. Akzeptiert per `Authorization: Basic` **und**
(für `<video>`, das keine Header setzen kann) als `?k=<base64(user:pass)>` in der URL — die App
hängt das automatisch an. Bei `basic` OHNE hinterlegte Zugangsdaten werden **alle** `/p`-Anfragen
blockiert (Fail-Closed, damit eine Fehlkonfiguration nie versehentlich öffnet).

### `RELAY_EGRESS_LOOKUP`
**Standard `1` (an).** Der Relay fragt seine **eigene** Egress-IP über deinen eigenen Endpunkt (siehe
`RELAY_EGRESS_URL`) ab und zeigt sie in `/health` (nur die VPN-IP, keine Nutzerdaten, kein Dritter),
damit die App den IP-Vergleich zuverlässig anzeigen kann. Opt-out mit `RELAY_EGRESS_LOOKUP=0` — dann
macht der Relay keinen zusätzlichen ausgehenden Aufruf und die App verifiziert den Schutz selbst.

### `RELAY_EGRESS_URL`
Nur relevant, solange `RELAY_EGRESS_LOOKUP` an ist. Der „Was ist meine IP"-Endpunkt, den der Relay
**durch den Tunnel** abfragt, um seine Egress-IP zu erfahren. Standard `https://phantomtv.app/api/my-ip`
(eigene Infrastruktur, kein Dritter); erwartete Antwort `{"ip":"…","country":"XX"}`. Überschreibbar.

### `RELAY_PUBLIC_URL`
Feste öffentliche Basis-URL für das HLS-Umschreiben, z. B. `https://relay.example`. **Hinter einem
Reverse Proxy setzen** — dann werden Segment-/Key-URLs korrekt umgeschrieben und lassen sich **nicht
über einen gefälschten `Host`-Header verbiegen**. Ohne Angabe wird der `Host`-Header verwendet.

### `RELAY_TRUSTED_PROXIES`
Kommagetrennte Proxy-IPs, deren `X-Forwarded-Proto`/`X-Forwarded-Host` der Relay beim HLS-Umschreiben
berücksichtigt. Leer (Standard) = **keinem** Forwarded-Header trauen. Nur nötig ohne `RELAY_PUBLIC_URL`.

### `RELAY_CORS_ORIGIN`
`Access-Control-Allow-Origin` der Antworten. Standard `*` (die App läuft unter `file://`). Teilen sich
alle Clients einen bekannten Origin, hier eng setzen.

### `RELAY_REAL_IP`
Aktive Leak-Selbstprüfung: die **echte** (Nicht-VPN-)öffentliche IP deines Hosts. Stimmt die gemessene
Egress-IP damit überein, wirkt der Tunnel **nicht** → `/health` meldet ehrlich `vpn:false` (statt nur
dem Vorhandensein des Interfaces zu vertrauen). Erfordert `RELAY_EGRESS_LOOKUP` an.

### Ressourcengrenzen (DoS-Härtung)
Alle mit sinnvollen Standards; `0` schaltet die Concurrency-/Rate-Grenze ab.
- `RELAY_MAX_CONCURRENT` (Standard `128`) — gleichzeitige `/p`-Anfragen insgesamt.
- `RELAY_RATE_MAX` (Standard `600`) / `RELAY_RATE_WINDOW_MS` (Standard `60000`) — pro-Client-Ratelimit.
- `RELAY_IDLE_TIMEOUT_MS` (Standard `30000`) — bricht einen Upstream ab, der keine Daten mehr sendet.
- `RELAY_MAX_STREAM_MS` (Standard `0` = unbegrenzt) — harte Obergrenze je Stream; für lange Live-Streams bei `0` lassen.

---

## Fail-Closed (Kill-Switch)

Fällt das VPN aus, darf der Relay **nichts** mehr weiterleiten – sonst ginge der Verkehr über die
echte IP (Leak). Zwei Ebenen, **am besten beide** — die zweite ist der einzige *echte* Kill-Switch:

1. **Im Relay (Interface-Wächter, kein echter Kill-Switch):** Ist `RELAY_VPN_IF` gesetzt und das
   Interface verschwindet, gibt `/p` **HTTP 503** und `/health` meldet `vpn:false`. Das prüft nur, ob
   das Tunnel-**Interface vorhanden** ist — **nicht**, ob der Verkehr wirklich hindurchgeht. Ehrliche
   Zusatzprüfung: mit `RELAY_REAL_IP` (deine echte Nicht-VPN-IP) vergleicht der Relay die gemessene
   Egress-IP; stimmt sie mit der echten überein, meldet er `vpn:false`, auch wenn das Interface „da" ist.
2. **Auf OS-Ebene (echter Kill-Switch, dringend empfohlen):** eine `nftables`/`iptables`-OUTPUT-Regel,
   die **jeglichen** Verkehr außer über `wg0` (und den Handshake zum VPN-Endpunkt) **verwirft**. Damit
   kann bei einem VPN-Ausfall physisch kein Paket über die echte Leitung entkommen — unabhängig vom
   Relay-Prozess.

   Minimal-Beispiel (`nftables`, den Platzhalter durch deinen VPN-Endpunkt ersetzen):
   ```nft
   table inet killswitch {
     chain output {
       type filter hook output priority 0; policy drop;
       oifname "lo" accept
       oifname "wg0" accept
       # WireGuard-Handshake nach draußen zulassen (UDP-Port deines Anbieters):
       udp dport 51820 accept
       ct state established,related accept
       # alles andere (Nicht-VPN) fällt durch policy drop
     }
   }
   ```
   Alternativ den Relay in einem eigenen **Netzwerk-Namespace** betreiben, in dem NUR `wg0` existiert
   (kein Default-Interface) — dann gibt es gar keinen Nicht-VPN-Ausgang. Der standalone `install.sh`
   weist am Ende ebenfalls auf diese Regel hin.

---

## In der App & Prüfen

**Einstellungen → Relay**: Adresse eintragen (`http://<server>:8787`), speichern, **„Relay prüfen"**.
Grün „Geschützt" erscheint nur, wenn sich die Egress-IP von deiner direkten IP unterscheidet –
Vertrauen durch **Messung**.

Ein Befehl statt curl-Bastelei:
```bash
phantom-relay --check                                # Standalone / Proxmox-LXC-Installation
docker exec phantom-relay node server.js --check     # Docker
# -> Relay: läuft · Schutz: GESCHÜTZT (VPN aktiv) · Egress: 203.0.113.10 (Germany, …)
```
Exit-Code: `0` ok/geschützt · `1` VPN weg · `2` nicht erreichbar. (Auch der Docker-HEALTHCHECK nutzt das.)

---

## Protokoll — Eigenbau

Der Relay ist **kein Muss** — er ist nur ein winziger Zwei-Endpunkt-HTTP-Vertrag. Du vertraust
unserem Binary nicht? Bau ihn in beliebiger Sprache nach oder nimm einen vorhandenen Proxy.

### `GET /p?u=<url-encoded target url>`
Holt `target` serverseitig (über die IP/das VPN des Relays) und reicht die Antwort 1:1 durch.
- `Access-Control-Allow-Origin: *` setzen (die App läuft unter `file://`).
- `Range`-Header durchreichen (Seeking).
- HLS-Playlists (`.m3u8`) so umschreiben, dass Segment-/Key-URLs **wieder über `/p`** laufen (sonst
  brechen HLS-Streams am VPN vorbei aus). Für reine `.ts`/`mp4` nicht nötig.
- Statuscodes: fehlt `u` → `400`, Upstream-Fehler → `502`, VPN weg → `503`,
  nicht autorisiert → `401` (basic) / `403` (ip), geblocktes Ziel → `403`.

### `GET /health`
Liveness + Schutz-Status als JSON. **Anonym** wird nur ein minimales, nicht-identifizierendes
Objekt geliefert:

```json
{ "ok": true, "vpn": true }
```

Die **identifizierenden Detailfelder** (`iface`/`ip`/`clientIp`/`country`/`isp`) liefert der Relay
**nur an autorisierte Aufrufer**: gültiges `?k=`/`Authorization` (bei `basic`), erlaubte Client-IP
(bei `ip`), im `open`-Modus (bewusst „vertrautes Netz") oder an einen **Loopback**-Aufruf (lokales
`--check`). So verrät `/health` die Egress-IP/das Interface nicht mehr an beliebige Aufrufer:

```json
{ "ok": true, "vpn": true, "iface": "wg0", "ip": "203.0.113.10", "clientIp": "…", "country": "Germany", "isp": "" }
```

- `vpn`: `true` = Tunnel-Interface **vorhanden** (bzw. Egress ≠ `RELAY_REAL_IP`), `false` = Interface
  **weg** oder Egress = echte IP (= ungeschützt), `null` = unbekannt (dann entscheidet die App per
  Egress-Vergleich). **Ehrlich gelesen:** `vpn:true` heißt „Interface da", nicht „Verkehr geht
  garantiert durch den Tunnel" — den echten Beweis liefert der Egress-Vergleich (oder `RELAY_REAL_IP`).
- `ip`/`country`/`isp`: aktuelle **Egress-IP** des Relays (nur bei `RELAY_EGRESS_LOOKUP` an).
- Die App pollt `/health` ohne Zugangsdaten und stützt sich auf `vpn` — die Egress-**Anzeige** in der
  Statuskarte erscheint bei `basic`/`ip` nur, wenn die App den Token bzw. eine erlaubte IP mitschickt.

**Kompatibilität:** Ein generischer Proxy, der nur `/p` kann und bei `/health` z. B. `404` liefert,
funktioniert trotzdem — phantom_ wertet **jede HTTP-Antwort als „erreichbar"** und bestimmt den
Schutz per Egress-Vergleich (deine direkte IP vs. die IP durchs Relay).

## FAQ

**Brauche ich das Relay?** Nein. phantom_ läuft ohne. Es ist für alle, die ihren Anbieter-Verkehr
über einen eigenen Server hinter ihrem VPN leiten wollen.

**Welches VPN?** Egal – WireGuard, OpenVPN oder die Linux-Config deines Anbieters.

**Läuft das Relay bei euch?** Nein, bewusst nicht. Du betreibst es selbst.

**`/health` zeigt meine echte IP?** Dann geht der Verkehr am VPN vorbei. Prüfe, ob `wg0.conf`
gemountet ist und der Tunnel steht (`docker logs phantom-relay`).

**HLS-Streams brechen ab?** Segment-/Key-URLs müssen wieder über `/p` laufen – die mitgelieferte
`server.js` macht das automatisch (inkl. Zugangs-Token bei `basic`).

---

## Sicherheit

- **SSRF-sicher:** `/p` proxied nur `http`/`https` auf **öffentliche** Ziele. Private, Loopback-,
  Link-Local-, Multicast- und Site-Local-Ziele (inkl. Cloud-Metadaten `169.254.169.254`, `127.0.0.1`,
  `10/172.16/192.168`, IPv6 `::1`/`fc00::/7`/`fe80::/10`/`fec0::/10`/`ff00::/8`, IPv4-mapped/6to4/NAT64)
  werden blockiert. Die geprüfte IP wird **gepinnt**: die Verbindung geht an genau die validierte
  Adresse (keine zweite, ungeprüfte Auflösung → kein DNS-Rebinding/TOCTOU), Host-Header und TLS-SNI
  bleiben der Originalhost. Jedes Redirect-Ziel wird neu geprüft und neu gepinnt.
- **DoS-Härtung:** globale Concurrency-Grenze + Per-Client-Ratelimit, Playlist-Größe wird **beim Lesen**
  begrenzt, Idle-/Connect-Timeouts, und ein Client-Disconnect bricht den Upstream sofort ab
  (`RELAY_MAX_CONCURRENT`, `RELAY_RATE_*`, `RELAY_IDLE_TIMEOUT_MS`, `RELAY_MAX_STREAM_MS`).
- **Zugang:** Ohne `RELAY_AUTH` kein Schutz – dann nur im eigenen Netz. Übers Internet
  **`RELAY_AUTH=ip` oder `basic` setzen** und **TLS** davorsetzen (Reverse Proxy), sonst laufen
  Zugangsdaten/`?k` im Klartext über die Leitung.
- Deine WireGuard-`.conf` (privater Schlüssel!) gehört **niemals** ins Repo – per `.gitignore` aus.

## Lizenz

AGPL-3.0-or-later. Copyright © 2026 phantom_. Volltext: [`LICENSE`](./LICENSE). Betreibst du eine
geänderte Fassung – auch als Netzwerkdienst –, musst du deren Quellcode den Nutzern zugänglich machen.
