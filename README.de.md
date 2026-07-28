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
  --restart unless-stopped ghcr.io/phantomtv-app/relay:1.0.0
```

Der Image-Tag ist auf eine feste Version (`:1.0.0`) gepinnt statt auf das bewegliche `:latest`, damit
ein Neustart/Rebuild kein unerwartetes Image zieht. Für eine neuere Version bewusst hochsetzen. **Maximal
reproduzierbar** wird es mit einem **Digest** statt eines Tags (ein Tag kann neu gepusht werden, ein
Digest nie): `…/relay@sha256:<digest>`. Den Digest ermittelst du mit
`docker buildx imagetools inspect ghcr.io/phantomtv-app/relay:1.0.0` (oder nach `docker pull` via
`docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/phantomtv-app/relay:1.0.0`).

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

**Supply-Chain / reproduzierbare Installation.** Der Einzeiler oben lädt `install.sh` vom **beweglichen**
Branch `main` — bequem, aber nicht reproduzierbar (ein Force-Push könnte den Inhalt ändern). Für eine
feste, überprüfbare Installation:

1. Beide Quellen an einen **unveränderlichen Ref** binden — den Pfad `…/main/install.sh` durch einen
   vollen Commit-SHA (oder, sobald veröffentlicht, einen **signierten Release-Tag**) ersetzen **und**
   `install.sh` per `RELAY_REF` denselben Ref für `server.js` mitgeben:
   ```bash
   REF=<commit-sha-oder-tag>
   sudo RELAY_REF="$REF" bash -c "$(wget -qLO - "https://raw.githubusercontent.com/phantomtv-app/relay/$REF/install.sh")"
   ```
2. Vor dem Ausführen **prüfen**: `install.sh` erst in eine Datei laden (`wget -O install.sh …`), Inhalt
   sichten und die **SHA-256-Prüfsumme** gegen den Wert aus den Release-Notes abgleichen
   (`sha256sum install.sh`). Nach der Installation ebenso `sha256sum /opt/phantom-relay/server.js`.

Standard bleibt `main`, solange noch kein signierter Tag veröffentlicht ist.

---

## Zugangsschutz

Drei Modi über `RELAY_AUTH`. **Es gibt keinen `open`-Standard mehr:** ist `RELAY_AUTH` nicht (oder
ungültig) gesetzt, **blockt der Relay `/p` komplett** (Fail-Closed) — du musst einen Modus **aktiv
wählen**. Der `install.sh` legt beim ersten Lauf automatisch `basic` mit einem **starken Zufalls-
Passwort** an.

| Modus | Setzt du | Wirkung |
|---|---|---|
| _(nicht gesetzt)_ | – | **Deny.** `/p` wird blockiert (Fail-Closed). Sicherer Standard. |
| `ip` | `RELAY_ALLOW=1.2.3.4,5.6.7.8` | Nur diese Client-IPs dürfen `/p`. |
| `basic` | `RELAY_USER=…` `RELAY_PASS=…` | Benutzer/Passwort. Per `Authorization: Basic` **und** (für `<video>` ohne Header) als `?k=<base64(user:pass)>` in der URL. |
| `open` | – (ausdrücklich setzen) | Kein Schutz. **Nur** im eigenen/vertrauten Netz. |

`/health` bleibt offen (nur Liveness/Status, keine Inhalte).

**Hinter einem Reverse Proxy `basic` (Token) statt `ip` bevorzugen.** Die `ip`-Allowlist prüft die echte
TCP-Peer-Adresse (`X-Forwarded-For` wird nie vertraut); hinter einem Proxy ist dieser Peer die IP des
*Proxys* — sie freizugeben würde **alle** Clients hinter dem Proxy autorisieren. Token-Auth (`basic`) ist
davon nicht betroffen. Der Relay warnt beim Start, wenn `RELAY_AUTH=ip` mit `RELAY_TRUSTED_PROXIES`
kombiniert ist.

---

## Datenschutz – kein Logging

Der Relay schreibt **nichts** über den Verkehr mit: **keine** Zugriffslogs, **keine** URLs,
**keine** Client-IPs, **keine** Stream-Daten – weder in Dateien noch in eine Datenbank. Einzige
Ausgabe ist Start-**Status**: eine Banner-Zeile (Port, VPN-Interface, `protected`/`fail-closed`-Zustand,
Auth-Modus, Limits) sowie – wo relevant – Konfigurationswarnungen (z. B. schwaches/fehlendes Passwort,
VPN nicht verifiziert, `RELAY_AUTH=ip`-Caveats). Nichts davon enthält Nutzerdaten oder Verkehr — lesbar
per `journalctl -u phantom-relay` (systemd) bzw. `docker logs phantom-relay`.

Der **einzige** mögliche zusätzliche ausgehende Aufruf ist der Egress-Lookup, und er ist
**standardmäßig aus**: ohne dein Opt-in verlässt nichts den Relay. Aktiviert (`RELAY_EGRESS_LOOKUP=1`)
fragt der Relay seine **eigene** Egress-IP **durch den Tunnel** über **phantom_'s Endpunkt**
(`RELAY_EGRESS_URL`, Standard `https://phantomtv.app/api/my-ip` — eigene Infrastruktur, kein Dritter)
für die `/health`-Anzeige ab (nur die VPN-IP des Relays, keine Nutzerdaten). Aus gelassen (Standard)
macht der Relay **keinerlei** zusätzliche ausgehende Aufrufe — das `protected`-Attest kommt ohne ihn
aus (über den Routing-Beweis).

### Reverse-Proxy: Access-Logs für `/p` abschalten oder Querystring redigieren

Der Relay selbst loggt **keine** Request-URLs. Setzt du aber einen **Reverse Proxy** (Nginx/Apache) für
TLS davor, schreibt **dessen** Access-Log standardmäßig die volle URL mit — und `/p?u=…&k=…` enthält im
Klartext die **Anbieter-URL** (`u=`) sowie deine **Relay-Zugangsdaten** (`k=` = `base64(user:pass)`).
Schalte das Logging für `/p` daher ab oder redigiere den Querystring.

**Nginx** — Logging für `/p` komplett aus (einfachster, sicherster Weg):
```nginx
location /p {
    access_log off;
    proxy_pass http://127.0.0.1:8787;
}
```
Oder das Log behalten, aber den Querystring redigieren (`$uri` statt `$request` loggen — ohne Args):
```nginx
log_format noqs '$remote_addr - [$time_local] "$request_method $uri" $status $body_bytes_sent';
location /p {
    access_log /var/log/nginx/relay.log noqs;   # loggt nur den Pfad, nie u=/k=
    proxy_pass http://127.0.0.1:8787;
}
```

**Apache** (`httpd`) — Logging für `/p` aus (per Umgebungsvariable + `env=!…`):
```apache
SetEnvIf Request_URI "^/p" no_log
CustomLog "logs/relay_access.log" combined env=!no_log
```
Oder den Querystring redigieren (`%U` = Pfad ohne Query statt `%r` = volle Request-Zeile):
```apache
LogFormat "%h %l %u %t \"%m %U\" %>s %b" noqs
CustomLog "logs/relay_access.log" noqs
```

Prüfe zusätzlich weitere Stellen, die URLs mitschreiben könnten (z. B. `error_log` bei hohem Loglevel,
Metrik-/APM-Tools, Shell-History bei `curl`-Tests).

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
bestimmen, kann das starke `protected`-Attest nie bestehen, also blockt der Relay `/p` komplett
(Fail-Closed) — deshalb auf einen echten Tunnel setzen.

### `RELAY_AUTH`
Zugangsschutz-Modus. **Kein Standard** — ohne (oder bei ungültigem) Wert blockt der Relay `/p`
komplett (Fail-Closed, damit nichts versehentlich offen ist):
- `ip` — nur die Client-IPs aus `RELAY_ALLOW` dürfen `/p`.
- `basic` — Benutzer/Passwort (`RELAY_USER` / `RELAY_PASS`). Der `install.sh` generiert das beim
  ersten Lauf automatisch.
- `open` — kein Schutz, **ausdrücklich** zu setzen. Nur im eigenen/vertrauten Netz.

### `RELAY_ALLOW_UNPROTECTED`
Nur für **lokale Entwicklung**. Standardmäßig blockt der Relay `/p`, solange **kein aktives
VPN-Interface** vorhanden ist (Fail-Closed, siehe unten). Mit `RELAY_ALLOW_UNPROTECTED=1` wird dieser
Wächter **abgeschaltet** und der Relay leitet auch **ohne VPN** weiter (der Verkehr läuft dann über
die echte IP). **Niemals in Produktion setzen.**

### `RELAY_ALLOW`
Nur bei `RELAY_AUTH=ip`. Kommagetrennte erlaubte Client-IPs, z. B. `1.2.3.4,5.6.7.8`. Nutzt die
echte Socket-Peer-Adresse (`x-forwarded-for` wird nie vertraut). Leere Liste = nichts erlaubt.

### `RELAY_USER` / `RELAY_PASS`
Nur bei `RELAY_AUTH=basic`. Benutzername und Passwort. Akzeptiert per `Authorization: Basic` **und**
(für `<video>`, das keine Header setzen kann) als `?k=<base64(user:pass)>` in der URL — die App
hängt das automatisch an. Bei `basic` OHNE hinterlegte Zugangsdaten werden **alle** `/p`-Anfragen
blockiert (Fail-Closed, damit eine Fehlkonfiguration nie versehentlich öffnet).

**Passwort setzen / ändern.** Der `install.sh` erzeugt beim ersten Lauf ein starkes Zufallspasswort —
normalerweise musst du hier also nichts anfassen. Zum selbst Setzen/Rotieren zuerst ein echtes Geheimnis
erzeugen (nicht von Hand ausdenken):
```bash
openssl rand -hex 24
```
Dann je nach Betriebsart anwenden:
- **systemd (install.sh):** Env-Datei bearbeiten und neu starten —
  ```bash
  sudo nano /etc/phantom-relay.env      # RELAY_USER=… und RELAY_PASS=… setzen
  sudo systemctl restart phantom-relay  # oder: phantom-relay restart
  ```
- **Docker:** `RELAY_USER`/`RELAY_PASS` unter `environment:` in der `docker-compose.yml` setzen, dann
  mit `docker compose up -d` anwenden.

> ⚠️ **Schwache Passwörter werden abgelehnt (Fail-Closed).** Bekannte Platzhalter — `change-me`,
> `changeme`, `change-me-please`, `password`, `passwort`, `admin`, `phantom`, `secret`, `geheim`,
> `test`, `1234`, `changeme123` — werden verweigert: bei `basic`-Auth mit einem solchen Wert (oder
> keinem) wird **jede** `/p`-Anfrage blockiert und der Relay loggt `RELAY_PASS ist ein bekannter
> Platzhalter/leer -> Basic-Auth fail-closed`. Das ist Absicht, damit ein kopiertes Beispiel nie mit
> öffentlich bekannten Zugangsdaten online geht. **Docker erzeugt KEIN Passwort automatisch** (nur der
> `install.sh` tut das) — du musst selbst ein echtes setzen, sonst liefert `/p` nichts aus.

### `RELAY_EGRESS_LOOKUP`
**Standard `0` (aus — Opt-in).** Mit `RELAY_EGRESS_LOOKUP=1` fragt der Relay seine **eigene** Egress-IP
durch den Tunnel über phantom_'s Endpunkt (siehe `RELAY_EGRESS_URL`) ab und zeigt sie in `/health` (nur
die VPN-IP, keine Nutzerdaten), damit die App den IP-Vergleich zeigen kann und das `RELAY_REAL_IP`-Veto
möglich wird. Aus gelassen (Standard) macht der Relay **keinen** zusätzlichen ausgehenden Aufruf; das
`protected`-Attest braucht ihn nicht — es stützt sich auf den Interface-Namen plus den Routing-Beweis.

### `RELAY_EGRESS_URL`
Nur relevant, solange `RELAY_EGRESS_LOOKUP` an ist (Opt-in). Der „Was ist meine IP"-Endpunkt, den der
Relay **durch den Tunnel** abfragt, um seine Egress-IP zu erfahren. Standard
`https://phantomtv.app/api/my-ip` (phantom_'s eigene Infrastruktur, kein Dritter); erwartete Antwort
`{"ip":"…","country":"XX"}`. Überschreibbar.

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

> Mit **`RELAY_AUTH=ip` und `RELAY_CORS_ORIGIN=*`** kann **jeder** Browser-Origin auf einem
> freigeschalteten Gerät den Relay für **beliebige öffentliche** Ziele nutzen — eine IP-Freigabe ist
> **keine** Origin-/App-Authentifizierung. Der Relay warnt beim Start davor. Übers Internet besser
> **`RELAY_AUTH=basic`** (ein Token, das nur die App kennt) und/oder `RELAY_CORS_ORIGIN` explizit setzen.

### `RELAY_REAL_IP`
**Optionales** zusätzliches Leak-Veto: die **echte** (Nicht-VPN-)öffentliche IP deines Hosts. Stimmt
die gemessene Egress-IP damit überein, wirkt der Tunnel **nicht** → `/health` meldet ehrlich
`vpn:false`. Das **ergänzt** nur das Routing-Beweis-Attest (es ist **nicht** Voraussetzung für
`protected:true`) und wirkt nur mit `RELAY_EGRESS_LOOKUP=1`. `phantom-relay setup` bietet an, diese IP
zu ermitteln (und schaltet den Egress-Lookup ein).

### Ressourcengrenzen (DoS-Härtung)
Alle mit sinnvollen Standards; `0` schaltet die Concurrency-/Rate-Grenze ab.
- `RELAY_MAX_CONCURRENT` (Standard `128`) — gleichzeitige `/p`-Anfragen insgesamt.
- `RELAY_RATE_MAX` (Standard `600`) / `RELAY_RATE_WINDOW_MS` (Standard `60000`) — pro-Client-Ratelimit.
- `RELAY_IDLE_TIMEOUT_MS` (Standard `30000`) — bricht einen Upstream ab, der keine Daten mehr sendet.
- `RELAY_MAX_STREAM_MS` (Standard `0` = unbegrenzt) — harte Obergrenze je Stream; für lange Live-Streams bei `0` lassen.
- `RELAY_UPSTREAM_TIMEOUT_MS` (Standard `20000`) — Obergrenze für Verbindungsaufbau + Zeit bis zu den Headern des Upstreams.
- `RELAY_MAX_PLAYLIST_BYTES` (Standard `8388608` = 8 MiB) — HLS-Manifeste werden zum Umschreiben der
  Segment-/Key-URLs im Speicher gepuffert; ein größeres Manifest wird abgelehnt statt gepuffert.

### Nur-Test-Variablen (niemals in Produktion)
Ausschließlich vom Test-Harness genutzt; beide **umgehen** echte Netz-/Routing-/VPN-Prüfungen und dürfen
auf einem Live-Relay **nie** gesetzt sein (der Relay warnt beim Start, falls doch):
- `RELAY_TEST_UPSTREAM` — Pfad zu einer JSON-Datei, die Ziel-URL → vorgefertigte Antwort abbildet; liefert
  diese ohne echtes DNS/Routing/Socket aus.
- `RELAY_NO_LISTEN=1` — lädt das Modul, ohne einen Port zu binden (zum Importieren der reinen Helfer).

---

## Fail-Closed (Kill-Switch)

Fällt das VPN aus, darf der Relay **nichts** mehr weiterleiten – sonst ginge der Verkehr über die
echte IP (Leak). Zwei Ebenen, **am besten beide** — die zweite ist der einzige *echte* Kill-Switch:

1. **Im Relay (Attest-Wächter):** `/p` leitet **nur** weiter, solange das starke `protected`-Attest
   gilt: (a) das erwartete Interface ist aktiv **und** sein Name ist ein echter Tunnel
   (`wg*`/`tun*`/`vpn*`/`wireguard`, nie `eth0`/`wlan0`), **und** (b) ein **Routing-Beweis** — die
   Kernel-Route zu einem öffentlichen Ziel (`ip route get 1.1.1.1`) verlässt den Host nachweislich über
   diesen Tunnel. Fehlt das `ip`-Werkzeug oder läuft die Route über ein anderes Gerät, **scheitert** das
   Attest. Gilt das Attest **nicht**, gibt `/p` **HTTP 503** und `/health` meldet `protected:false` —
   der Relay leitet dann **gar nichts** weiter (hartes Fail-Closed). Ausnahme nur für die lokale
   Entwicklung per `RELAY_ALLOW_UNPROTECTED=1`. Optionales Zusatz-Veto: mit `RELAY_REAL_IP` +
   `RELAY_EGRESS_LOOKUP=1` vergleicht der Relay zusätzlich die gemessene Egress-IP; stimmt sie mit der
   echten überein, meldet er einen Leak, auch wenn das Interface „da" ist.
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
   Alternativ den Relay in einem eigenen **Netzwerk-Namespace** betreiben, in dem außer `lo` (Loopback)
   NUR `wg0` existiert (kein Default-Interface) — dann gibt es gar keinen Nicht-VPN-Ausgang. Der standalone
   `install.sh` weist am Ende ebenfalls auf diese Regel hin (und `phantom-relay setup` bietet an, die
   nftables-Regeln für dich einzurichten).

   **DNS mit in den Tunnel zwingen (wichtig):** Beide Referenzstandards oben decken nur die *Route* der
   Pakete ab — die **Namensauflösung** läuft standardmäßig weiter über den OS-Resolver und damit womöglich
   über den DNS deines ISPs. Dann sieht der ISP zwar keine IP-Payload, aber die **Ziel-Hostnamen** deiner
   Anfragen. Führe DNS deshalb ebenfalls über den VPN: im Netzwerk-Namespace einen eigenen
   `/etc/netns/<ns>/resolv.conf` mit einem Resolver **hinter** dem Tunnel setzen (z. B. dem DNS deines
   VPN-Anbieters); bei der nftables-Variante zusätzlich ausgehendes DNS (UDP/TCP 53 sowie DoT 853) über
   `wg0` erzwingen oder auf einen Resolver im Tunnel umbiegen. Erst dann verlässt **kein** Hostname mehr
   den Host am VPN vorbei.

> **Reichweite — was der relay-eigene Check *nicht* abdeckt:** Der Routing-Beweis prüft nur die
> Egress-Route des **HTTP-Sockets** zur Ziel-IP. Er kontrolliert **kein DNS** — der Relay löst
> Hostnamen über den OS-Resolver auf, und diese DNS-Anfragen können weiterhin über den Resolver deines
> ISPs am Tunnel vorbei laufen. `protected:true` heißt also „die HTTP-Egress-Route ist der Tunnel",
> **nicht** „jedes Paket (inkl. DNS) läuft durch den Tunnel". Vollständiger Schutz — DNS inbegriffen —
> kommt nur vom OS-Kill-Switch oder dem Netzwerk-Namespace oben.

---

## In der App & Prüfen

**Einstellungen → Relay**: Adresse eintragen (`http://<server>:8787`), speichern, **„Relay prüfen"**.
Die App authentisiert sich an `/health` und zeigt **„Geschützt"** nur, wenn das starke
`protected`-Attest des Relays gilt (echtes Tunnel-Interface **plus** Routing-Beweis) — der Relay misst
das selbst; die App vergleicht **keine** IPs clientseitig.

Ein Befehl statt curl-Bastelei:
```bash
phantom-relay --check                                # Standalone / Proxmox-LXC-Installation
docker exec phantom-relay node server.js --check     # Docker
# -> Relay: läuft · Schutz: GESCHÜTZT (Tunnel + Routing-Beweis)
```
Exit-Code: `0` **nur** wenn das starke Attest besteht (`protected:true`) · `1` Interface da, aber Schutz
nicht verifiziert / VPN weg · `2` nicht erreichbar. Der Docker-HEALTHCHECK nutzt stattdessen
`node server.js --liveness` (Prozess erreichbar? Exit `0`/`1`), damit ein Container nicht schon
unhealthy ist, nur weil noch kein Tunnel steht — der echte Schutz greift pro Anfrage, nicht über dieses
Lämpchen.

---

## Protokoll — Eigenbau

Der Relay ist **kein Muss** — er ist nur ein winziger Zwei-Endpunkt-HTTP-Vertrag. Du vertraust
unserem Binary nicht? Bau ihn in beliebiger Sprache nach oder nimm einen vorhandenen Proxy.

**Vertrags-Version `v1`.** Die App erwartet die unten beschriebenen Endpunkte in dieser Fassung. Baust
du einen eigenen Relay, halte dich an genau diesen `v1`-Vertrag; erweitere ihn nur additiv (neue Felder),
nie brechend. Der minimale, für die App ausreichende `/health`-Körper ist:

```json
{ "ok": true, "vpn": true, "protected": true }
```

**Technische Garantie hinter `protected: true`.** Melde `protected: true` NUR, wenn dein Relay wirklich
beweist, dass der Verkehr durch den Tunnel geht — nicht nur, dass ein Interface „da" ist. Konkret müssen
**beide** Bedingungen gelten: (1) das erwartete Tunnel-Interface (`wg*`/`tun*`/`vpn*`) ist **UP** und hat
eine nicht-interne Adresse, **und** (2) ein **zielbezogener Routing-Beweis** — die Kernel-Route zum
konkreten Ziel (`ip route get <ziel-ip>`) verlässt den Host nachweislich über **genau dieses Interface**
(`dev == <tunnel>`). Kannst du (2) nicht beweisen (kein `ip`, andere `dev`), gib `protected: false` und
lehne den Forward fail-closed ab. Ein bloßer Interface-Existenz-Check erfüllt den Vertrag **nicht**.

### `GET /p?u=<url-encoded target url>`
Holt `target` serverseitig (über die IP/das VPN des Relays) und reicht die Antwort 1:1 durch.
- `Access-Control-Allow-Origin: *` setzen (die App läuft unter `file://`).
- `Range`-Header durchreichen (Seeking).
- HLS-Playlists (`.m3u8`) so umschreiben, dass Segment-/Key-URLs **wieder über `/p`** laufen (sonst
  brechen HLS-Streams am VPN vorbei aus). Für reine `.ts`/`mp4` nicht nötig.
- Statuscodes: fehlt `u` → `400`, Upstream-Fehler → `502`, Schutz nicht verifiziert → `503`
  (Fail-Closed: kein Tunnel-Interface oder kein Routing-Beweis), nicht autorisiert → `401` (basic) /
  `403` (ip), geblocktes Ziel → `403`.

### `GET /health`
Liveness + Schutz-Status als JSON. **Anonym** wird nur ein minimales, nicht-identifizierendes
Objekt geliefert:

```json
{ "ok": true, "vpn": true, "protected": true }
```

Die **identifizierenden Detailfelder** (`iface`/`ip`/`clientIp`/`country`/`isp`) liefert der Relay
**nur an autorisierte Aufrufer**: gültiges `?k=`/`Authorization` (bei `basic`), erlaubte Client-IP
(bei `ip`), im `open`-Modus (bewusst „vertrautes Netz") oder an einen **Loopback**-Aufruf (lokales
`--check`). So verrät `/health` die Egress-IP/das Interface nicht mehr an beliebige Aufrufer:

```json
{ "ok": true, "vpn": true, "protected": true, "iface": "wg0", "ip": "203.0.113.10", "clientIp": "…", "country": "Germany", "isp": "" }
```

- `vpn`: `true` = Tunnel-Interface **vorhanden** (bzw. Egress ≠ `RELAY_REAL_IP`), `false` = Interface
  **weg** oder Egress = echte IP (= ungeschützt), `null` = unbekannt. **Ehrlich gelesen:** `vpn:true`
  heißt „Interface da", nicht „Verkehr geht durch den Tunnel" — diesen Beweis trägt `protected`.
- `protected`: **starkes Schutz-Attest** und genau das Tor, das `/p` durchsetzt. Nur `true`, wenn
  **alles** gilt: (a) das erwartete Interface ist aktiv **und** sein Name ist ein echter Tunnel
  (`wg*`/`tun*`/`vpn*`/`wireguard`, nie `eth0`/`wlan0`); (b) der **Routing-Beweis** besteht —
  `ip route get 1.1.1.1` zeigt die Route über diesen Tunnel (fehlt `ip` oder anderes Gerät → `false`,
  Fail-Closed); und (c) das optionale Egress-Veto schlägt nicht an (mit `RELAY_REAL_IP` +
  `RELAY_EGRESS_LOOKUP=1` muss die gemessene Egress-IP ungleich der echten sein). Es braucht **kein**
  `RELAY_REAL_IP` — der Routing-Beweis allein trägt es.
- `ip`/`country`/`isp`: aktuelle **Egress-IP** des Relays (nur bei `RELAY_EGRESS_LOOKUP` an).
- Die App fragt `/health` ab (und schickt bei `basic` den Token mit) und stützt sich auf das
  `protected`-Attest; die Egress-**Anzeige** (Ausgangs-IP) erscheint nur bei aktivem
  `RELAY_EGRESS_LOOKUP` und autorisiertem Aufruf.

**Kompatibilität:** Ein generischer Proxy, der nur `/p` kann und bei `/health` z. B. `404` liefert,
funktioniert trotzdem — phantom_ wertet **jede HTTP-Antwort als „erreichbar"**; ohne
`protected`-Attest lässt sich lediglich das starke Schutz-Abzeichen nicht anzeigen.

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
- **Zugang:** Standard ist **Deny** — ohne gültiges `RELAY_AUTH` (`ip`/`basic`/`open`) wird `/p`
  komplett blockiert (Fail-Closed); `install.sh` legt beim ersten Lauf `basic` mit starkem Zufalls-
  Passwort an. Übers Internet **`RELAY_AUTH=ip` oder `basic` setzen** und **TLS** davorsetzen (Reverse
  Proxy), sonst laufen Zugangsdaten/`?k` im Klartext über die Leitung.
- Deine WireGuard-`.conf` (privater Schlüssel!) gehört **niemals** ins Repo – per `.gitignore` aus.

## Lizenz

AGPL-3.0-or-later. Copyright © 2026 phantom_. Volltext: [`LICENSE`](./LICENSE). Betreibst du eine
geänderte Fassung – auch als Netzwerkdienst –, musst du deren Quellcode den Nutzern zugänglich machen.
