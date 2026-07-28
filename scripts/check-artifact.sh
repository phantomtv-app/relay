#!/usr/bin/env bash
#
# phantom_ Relay – Release-Allowlist / Secret-Scan.
#
# ZIEL: das FINALE, zu bauende Artefakt prüfen – NICHT nur den Git-Baum. In CI soll der GEPACKTE
# Stand gescannt werden (das, was per `docker build` / `COPY . .` tatsächlich ins Image gerät),
# inklusive der von .gitignore/.dockerignore ausgeschlossenen LAUFZEITDATEIEN. Ein reiner
# `git ls-files`-Scan ist blind für genau diese ignorierten Secrets (.env, WireGuard-*.conf mit
# PRIVATE KEY, /wireguard/, Logs) und würde fälschlich "OK" melden, obwohl sie bei `COPY . .`
# mitgebaut würden. Deshalb: FILESYSTEM-Scan per `find` ab Repo-Wurzel, der ignorierte Dateien
# EINSCHLIESST.
#
# Bricht HART ab (exit 1) bei Geheimnissen/Laufzeitdaten:
#   - SQLite-DBs (*.sqlite / *.sqlite3 / *.sqlite-wal / *.sqlite-shm)
#   - private Schlüssel (*.pem / *.key)
#   - Umgebungsdateien (.env / *.env)
#   - WireGuard-Configs (*.conf) und das /wireguard/-Verzeichnis (enthält den PRIVATE KEY!)
#   - Logs (*.log)
# Versionierte *.example-Vorlagen bleiben erlaubt (exakter Basename-Match: '.env' matcht NICHT
# '.env.example'). node_modules/ und .git/ werden ausgenommen.
#
# CI-Einhängung (GitHub Actions), z. B. als eigener Schritt vor Build/Push:
#   - name: Secret-/Artefakt-Scan
#     run: bash scripts/check-artifact.sh
# Lokal einfach:  bash scripts/check-artifact.sh

set -euo pipefail

# Immer am Repo verankern, in dem dieses Skript liegt – unabhängig vom Aufruf-Verzeichnis.
cd "$(cd "$(dirname "$0")/.." && pwd)"

# Filesystem-Denylist ab Repo-Wurzel. `find` sieht auch von .gitignore/.dockerignore ignorierte
# Dateien – genau das ist der Zweck (den gebauten Stand prüfen, nicht den Git-Baum).
hits="$(find . \
	\( -path './.git' -o -path './node_modules' \) -prune -o \
	-type f \( \
		   -name '*.sqlite' -o -name '*.sqlite3' \
		-o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \
		-o -name '*.pem' -o -name '*.key' \
		-o -name '*.env' \
		-o -name '*.conf' \
		-o -path './wireguard/*' \
		-o -name '*.log' \
	\) -print | sed 's#^\./##' | sort -u)"

if [ -n "$hits" ]; then
	echo "FAIL: verbotene Dateien im Paketierungsstand gefunden:" >&2
	echo "$hits" | sed 's/^/  - /' >&2
	echo "-> Aus dem Artefakt entfernen und/oder .gitignore + .dockerignore ergänzen." >&2
	exit 1
fi

echo "OK: keine Geheimnisse/Laufzeitdaten im Paketierungsstand."
