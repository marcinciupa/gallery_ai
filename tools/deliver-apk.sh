#!/usr/bin/env bash
# Dostarcza zbudowany APK na udział sieciowy z POPRAWNĄ, UNIKALNĄ nazwą i sprząta stare buildy.
#
# Powód istnienia: konwencja nazewnicza była zapisana tylko w notatkach i wielokrotnie ją gubiłem —
# w jednej sesji powstało 5 buildów o tej samej nazwie, nadpisujących się nawzajem, przez co pomiary
# między buildami stały się nieporównywalne. Skrypt sprawia, że nazwa nie zależy od niczyjej pamięci.
#
#   ./tools/deliver-apk.sh           → build testowy: gallery_ai-<wersja>-t<N>.apk (N samo rośnie)
#   ./tools/deliver-apk.sh --release → build wydaniowy: gallery_ai-<wersja>.apk
#   APK_KEEP=5 ./tools/deliver-apk.sh → zostaw 5 ostatnich buildów testowych (domyślnie 3)
#
# Cel = udział SMB. Nie montujemy go (to wymagałoby sudo) — kopiujemy przez PowerShell, któremu
# ścieżkę źródłową podajemy w formie widocznej z Windows (`wslpath -w` → \\wsl.localhost\...).
# Gdy udział jest nieosiągalny, spadamy na Downloads, żeby build nie przepadł.
#
# Weryfikuje ŚWIEŻOŚĆ APK — gradle potrafi zwrócić BUILD SUCCESSFUL bez przepakowania pliku
# (patrz: czyszczenie android/app/build/generated/res/react przed buildem).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
SHARE='\\5600G\@5600g'
FALLBACK_DIR="/mnt/c/Users/glue0/Downloads"
KEEP="${APK_KEEP:-3}"

[ -f "$APK" ] || { echo "BŁĄD: brak APK — czy build się wykonał? ($APK)" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/app.json').expo.version")"

AGE=$(( $(date +%s) - $(stat -c %Y "$APK") ))
if [ "$AGE" -gt 600 ]; then
  echo "⚠️  UWAGA: APK ma $((AGE / 60)) min. Gradle mógł nie przepakować."
fi

ps() { powershell.exe -NoProfile -Command "$1" 2>/dev/null | tr -d '\r'; }

USE_SHARE=0
[ "$(ps "Test-Path '$SHARE'")" = "True" ] && USE_SHARE=1
[ "$USE_SHARE" = 1 ] || echo "⚠️  Udział $SHARE nieosiągalny — zapisuję do $FALLBACK_DIR"

# Spis istniejących plików w miejscu docelowym (do licznika i sprzątania).
if [ "$USE_SHARE" = 1 ]; then
  LISTING="$(ps "Get-ChildItem -LiteralPath '$SHARE' -Filter 'gallery_ai-*.apk' | Select-Object -ExpandProperty Name")"
else
  LISTING="$(ls "$FALLBACK_DIR" 2>/dev/null | grep '^gallery_ai-.*\.apk$' || true)"
fi

if [ "${1:-}" = "--release" ]; then
  NAME="gallery_ai-${VERSION}.apk"
  echo "$LISTING" | grep -qx "$NAME" && { echo "BŁĄD: $NAME już istnieje — bumpnij wersję zamiast nadpisywać." >&2; exit 1; }
else
  # Licznik MONOTONICZNY, trzymany w PLIKU — nie odgadywany wyłącznie z listy plików, bo stare buildy
  # są kasowane (ręcznie lub przez sprzątanie niżej) i licznik by się cofał, dając dwa różne buildy
  # o tej samej nazwie (zdarzyło się 2026-07-21).
  COUNTER="$ROOT/tools/.apk-counter"
  LAST_FILE=$(cat "$COUNTER" 2>/dev/null || echo 0)
  LAST_SEEN=$(echo "$LISTING" | sed -n 's/^gallery_ai-.*-t\([0-9]\+\)\.apk$/\1/p' | sort -n | tail -1)
  N=$(( ( LAST_FILE > ${LAST_SEEN:-0} ? LAST_FILE : ${LAST_SEEN:-0} ) + 1 ))
  echo "$N" > "$COUNTER"
  NAME="gallery_ai-${VERSION}-t${N}.apk"
fi

SRC_WIN="$(wslpath -w "$APK")"
if [ "$USE_SHARE" = 1 ]; then
  ps "Copy-Item -LiteralPath '$SRC_WIN' -Destination '$SHARE\\$NAME' -Force" >/dev/null
  WHERE="$SHARE"
else
  cp "$APK" "$FALLBACK_DIR/$NAME"
  WHERE="$FALLBACK_DIR"
fi
echo "✅ $NAME → $WHERE  ($(du -h "$APK" | cut -f1), zbudowany $(date -d "@$(stat -c %Y "$APK")" '+%H:%M'))"

# Sprzątanie: zostaw KEEP najnowszych buildów TESTOWYCH (każdy ~83 MB). Wydaniowych (bez `-t<N>`)
# nie ruszamy — mogą być potrzebne później.
OLD=$(echo "$LISTING" | sed -n 's/^\(gallery_ai-.*-t\([0-9]\+\)\.apk\)$/\2 \1/p' | sort -rn | tail -n +"$KEEP" | cut -d' ' -f2)
for f in $OLD; do
  [ "$f" = "$NAME" ] && continue
  if [ "$USE_SHARE" = 1 ]; then ps "Remove-Item -LiteralPath '$SHARE\\$f' -Force" >/dev/null; else rm -f "$FALLBACK_DIR/$f"; fi
  echo "   🗑  usunięto $f"
done
