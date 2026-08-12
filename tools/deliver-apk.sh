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
SHARE='\\5600G\@work'
FALLBACK_DIR="/mnt/c/Users/glue0/Downloads"
KEEP="${APK_KEEP:-3}"

[ -f "$APK" ] || { echo "BŁĄD: brak APK — czy build się wykonał? ($APK)" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/app.json').expo.version")"

# WALIDATOR KONWENCJI WERSJI — żeby dryf nie wyszedł na udział (patrz reguła bump-version-per-feature).
# versionCode = round(version×10000), kończy się na 0 (funkcja) lub 5 (POŁÓWKA = mniej znacząca zmiana);
# versionName = versionCode/10000 z obciętym zerem końcowym (3 cyfry normalnie, 4 z „5" dla połówki).
VCODE="$(node -p "require('$ROOT/app.json').expo.android.versionCode")"
EXP_NAME="$(node -p "(require('$ROOT/app.json').expo.android.versionCode/10000).toString()")"
[ "$VERSION" = "$EXP_NAME" ] || { echo "BŁĄD KONWENCJI: version '$VERSION' ≠ versionCode/10000 ('$EXP_NAME'). Ustaw version='$EXP_NAME' albo popraw versionCode." >&2; exit 1; }
[ $(( VCODE % 5 )) -eq 0 ] || { echo "BŁĄD KONWENCJI: versionCode $VCODE nie kończy się na 0 (funkcja) ani 5 (połówka). Wyrównaj do najbliższego kroku." >&2; exit 1; }

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

# Konwencja nazwy (ustalenie użytkownika 2026-07-24): sufiks `-t<N>` TYLKO gdy to iteracja testowa tej
# samej wersji (bez nowego ficzera). Pierwszy build ŚWIEŻO bumpniętej wersji (= z ficzerem, patrz reguła
# bump-version-per-feature) dostaje nazwę WYDANIOWĄ bez sufiksu. Wykrywamy to automatycznie: jeśli plik
# wydaniowy tej wersji jeszcze nie istnieje w miejscu docelowym → to ten pierwszy build. `--release`
# wymusza wydaniową (błąd, gdy istnieje), `--test` wymusza `-t`.
RELEASE_NAME="gallery_ai-${VERSION}.apk"
RELEASE_EXISTS=0
echo "$LISTING" | grep -qx "$RELEASE_NAME" && RELEASE_EXISTS=1

if [ "${1:-}" = "--release" ]; then
  [ "$RELEASE_EXISTS" = 1 ] && { echo "BŁĄD: $RELEASE_NAME już istnieje — bumpnij wersję zamiast nadpisywać." >&2; exit 1; }
  NAME="$RELEASE_NAME"
elif [ "${1:-}" != "--test" ] && [ "$RELEASE_EXISTS" = 0 ]; then
  # pierwszy build tej (bumpniętej) wersji → nazwa wydaniowa, bez -t
  NAME="$RELEASE_NAME"
else
  # iteracja testowa TEJ SAMEJ wersji. Licznik `-t<N>` RESETUJE SIĘ przy bumpie — każda wersja numeruje
  # testy od t1. Plik `.apk-counter` trzyma "VERSION N"; przy zmianie wersji zaczynamy od 0. Dodatkowo
  # bierzemy max -t widoczny na udziale DLA TEJ wersji (przetrwa utratę licznika; stare buildy bywają
  # skasowane, więc sam listing bywa niepełny → max(plik, listing)).
  COUNTER="$ROOT/tools/.apk-counter"
  read -r STORED_V STORED_N < "$COUNTER" 2>/dev/null || true
  STORED_V="${STORED_V:-}"; STORED_N="${STORED_N:-0}"
  [ "$STORED_V" = "$VERSION" ] || STORED_N=0
  SEEN=$(echo "$LISTING" | sed -n "s/^gallery_ai-${VERSION}-t\([0-9]\+\)\.apk$/\1/p" | sort -n | tail -1)
  BASE=$(( STORED_N > ${SEEN:-0} ? STORED_N : ${SEEN:-0} ))
  N=$(( BASE + 1 ))
  echo "$VERSION $N" > "$COUNTER"
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
# ── SPRZĄTANIE ──────────────────────────────────────────────────────────────────────────────────
# Zostaw KEEP najnowszych APK, resztę skasuj. Klucz sortowania: (wersja, numer -t). Plik wydaniowy
# danej wersji dostaje -t = 0, bo powstaje jako PIERWSZY build tej wersji — jej iteracje testowe są
# od niego nowsze. `sort -g` radzi sobie z różną liczbą cyfr (0.9635 < 0.971).
#
# ZMIANA 2026-08-12 (polecenie użytkownika — udział zarastał i przenosił pliki ręcznie): sprzątamy
# TAKŻE buildy wydaniowe. Wcześniej wzorzec łapał wyłącznie `-t<N>`, więc KAŻDY build wydaniowy
# zostawał na udziale na zawsze. Przy okazji naprawione dwa błędy starej wersji: sortowanie szło po
# samym numerze `-t` w poprzek wersji (`0.972-t5` wypadało nowsze niż `0.973-t1`, więc kasowany bywał
# świeższy plik), a `tail -n +$KEEP` zostawiał KEEP-1 plików zamiast KEEP.
#
# Wydaniowy build BIEŻĄCEJ wersji jest chroniony przed skasowaniem — inaczej seria buildów testowych
# wyparłaby go z listy i następny build tej samej wersji znów dostałby nazwę wydaniową.
# APK_KEEP=0 wyłącza sprzątanie.
if [ "$KEEP" -gt 0 ]; then
  # LISTING pobrano PRZED kopiowaniem — dokładamy świeżo dostarczony plik, żeby KEEP oznaczało
  # liczbę APK, która ZOSTANIE na udziale (inaczej zostawałoby KEEP+1).
  OLD=$(printf '%s\n%s\n' "$LISTING" "$NAME" | sed -n \
        -e "s/^gallery_ai-\([0-9.]\+\)-t\([0-9]\+\)\.apk$/\1 \2 &/p" \
        -e "s/^gallery_ai-\([0-9.]\+\)\.apk$/\1 0 &/p" \
      | sort -k1,1gr -k2,2nr | tail -n +$((KEEP + 1)) | awk '{print $3}')
  for f in $OLD; do
    [ "$f" = "$NAME" ] && continue
    [ "$f" = "$RELEASE_NAME" ] && continue # wydaniowy bieżącej wersji zostaje
    if [ "$USE_SHARE" = 1 ]; then ps "Remove-Item -LiteralPath '$SHARE\\$f' -Force" >/dev/null; else rm -f "$FALLBACK_DIR/$f"; fi
    echo "   🗑  usunięto $f"
  done
fi
