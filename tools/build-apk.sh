#!/usr/bin/env bash
# Jedna komenda: bump wersji → bramki (typy + testy) → prebuild → gradle → weryfikacja APK → dostawa.
# Bliźniak skryptu z rec_ai/mobile — ta sama procedura, ścieżki wyprowadzane z lokalizacji skryptu.
#
#   ./tools/build-apk.sh                  → build bieżącej wersji (iteracja testowa)
#   ./tools/build-apk.sh --bump           → +0.001 (zmiana normalna) i build
#   ./tools/build-apk.sh --half           → +0.0005 (mała zmiana) i build
#   ./tools/build-apk.sh --verify a,b     → dodatkowo sprawdź, że napisy „a" i „b" są w bundlu APK
#   ./tools/build-apk.sh --no-deliver     → zbuduj, ale nie kopiuj na udział
#   ./tools/build-apk.sh --skip-checks    → pomiń tsc i testy (tylko gdy naprawdę wiesz, po co)
#   ./tools/build-apk.sh --release        → nazwa wydaniowa przy dostawie (patrz deliver-apk.sh)
#
# Po co to istnieje: procedura była odtwarzana z pamięci przy każdym buildzie (~30 komend na sesję),
# a jej kroki łatwo pominąć — i wtedy build „przechodzi", tylko nie zawiera zmiany. Trzy pułapki,
# które ten skrypt zamyka na stałe:
#   1. `expo prebuild` NADPISUJE pin Gradle i kasuje `local.properties` → re-pin robimy PO prebuildzie.
#   2. Gradle bywa no-op i zostawia stary APK → sprawdzamy, że numer wersji naprawdę jest w bundlu.
#   3. Bump wersji musi trafić w trzy miejsca naraz (version.ts, app.json ×2), inaczej deliver odmówi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GRADLE_VER="8.14.3"   # Expo 56 / RN 0.85 daje 9.3.1 → psuje build. Pin per-projekt.
SDK_DIR="${ANDROID_HOME:-$HOME/Android/Sdk}"

BUMP=""; VERIFY=""; DELIVER=1; CHECKS=1; PREBUILD=0; DELIVER_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bump)        BUMP=10 ;;
    --half)        BUMP=5 ;;
    --verify)      VERIFY="$2"; shift ;;
    --no-deliver)  DELIVER=0 ;;
    --skip-checks) CHECKS=0 ;;
    --prebuild)    PREBUILD=1 ;;
    --release|--test) DELIVER_ARG="$1" ;;
    *) echo "Nieznany argument: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { echo -e "\n▸ $*"; }
T0=$(date +%s)

[ -f "$HOME/tools/android-env.sh" ] && . "$HOME/tools/android-env.sh"

# ── 1. bramki: typy i testy ──────────────────────────────────────────────────────────────────
# Przed buildem, nie po — błąd typu wyłapany tu kosztuje 6 sekund, wyłapany na telefonie: 6 minut
# plus przeklikanie apki.
if [ "$CHECKS" = 1 ]; then
  step "typy (tsc --noEmit)"
  npx tsc --noEmit
  if node -e "process.exit(require('./package.json').scripts?.test ? 0 : 1)"; then
    step "testy (npm test)"
    LOG="$(mktemp)"
    if npm test --silent > "$LOG" 2>&1; then tail -1 "$LOG"; else cat "$LOG"; rm -f "$LOG"; exit 1; fi
    rm -f "$LOG"
  fi
fi

# ── 2. bump wersji (version.ts + app.json ×2) ────────────────────────────────────────────────
OLD_VER="$(node -p "require('./app.json').expo.version")"
if [ -n "$BUMP" ]; then
  # ta sama formuła, którą waliduje deliver-apk.sh: versionName === versionCode/10000
  read -r NEW_VER NEW_CODE < <(node -e "const c=require('./app.json').expo.android.versionCode+$BUMP; const s=(c/10000).toFixed(4); const v=s.endsWith('0')?s.slice(0,-1):s; console.log(v, c)")
  OLD_CODE="$(node -p "require('./app.json').expo.android.versionCode")"
  sed -i "s/export const APP_VERSION = '$OLD_VER';/export const APP_VERSION = '$NEW_VER';/" src/version.ts
  sed -i "s/\"version\": \"$OLD_VER\"/\"version\": \"$NEW_VER\"/; s/\"versionCode\": $OLD_CODE/\"versionCode\": $NEW_CODE/" app.json
  grep -q "APP_VERSION = '$NEW_VER'" src/version.ts || { echo "BŁĄD: version.ts nie przyjął bumpu" >&2; exit 1; }
  [ "$(node -p "require('./app.json').expo.version")" = "$NEW_VER" ] || { echo "BŁĄD: app.json nie przyjął bumpu" >&2; exit 1; }
  step "wersja $OLD_VER → $NEW_VER (versionCode $NEW_CODE)"
  PREBUILD=1
  VER="$NEW_VER"
else
  VER="$OLD_VER"
  step "wersja bez zmian: $VER"
fi

# ── 3. prebuild (tylko gdy trzeba) + naprawa tego, co prebuild psuje ─────────────────────────
[ -d android ] || PREBUILD=1
if [ "$PREBUILD" = 1 ]; then
  step "expo prebuild"
  npx expo prebuild -p android --no-install 2>&1 | tail -2
fi

WRAPPER="android/gradle/wrapper/gradle-wrapper.properties"
if ! grep -q "gradle-${GRADLE_VER}-bin.zip" "$WRAPPER"; then
  sed -i "s#distributionUrl=.*#distributionUrl=https\\\\://services.gradle.org/distributions/gradle-${GRADLE_VER}-bin.zip#" "$WRAPPER"
  echo "   pin Gradle → $GRADLE_VER"
fi
echo "sdk.dir=$SDK_DIR" > android/local.properties

# ── 4. build ─────────────────────────────────────────────────────────────────────────────────
step "gradle assembleRelease"
( cd android && ./gradlew assembleRelease -x lint -x lintVitalRelease --no-daemon 2>&1 | tail -3 )

# ── 5. weryfikacja: czy w APK jest to, co zbudowaliśmy ───────────────────────────────────────
# Gradle potrafi uznać, że nie ma nic do roboty, i zostawić poprzedni APK. Numer wersji w bundlu
# jest najtańszym dowodem, że pakiet jest świeży; --verify dokłada napisy z konkretnej zmiany.
step "weryfikacja bundla"
VERIFY="$VER${VERIFY:+,$VERIFY}" python3 - <<'PY'
import os, sys, zipfile
apk = 'android/app/build/outputs/apk/release/app-release.apk'
raw = zipfile.ZipFile(apk).read('assets/index.android.bundle')
bad = []
for s in os.environ['VERIFY'].split(','):
    s = s.strip()
    if not s: continue
    hit = s.encode('utf8') in raw or s.encode('utf-16-le') in raw
    print(f'   {s:30} → {"jest" if hit else "BRAK"}')
    if not hit: bad.append(s)
if bad:
    print(f'❌ w bundlu brakuje: {", ".join(bad)} — APK jest nieświeży albo zmiana nie weszła', file=sys.stderr)
    sys.exit(1)
PY

# ── 6. dostawa ───────────────────────────────────────────────────────────────────────────────
if [ "$DELIVER" = 1 ]; then
  step "dostawa"
  ./tools/deliver-apk.sh ${DELIVER_ARG:+$DELIVER_ARG}
else
  echo -e "\n   (bez dostawy) $ROOT/android/app/build/outputs/apk/release/app-release.apk"
fi

echo "⏱  $(( ($(date +%s) - T0) / 60 ))m $(( ($(date +%s) - T0) % 60 ))s"
