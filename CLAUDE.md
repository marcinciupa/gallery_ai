# gallery_ai — project guide for Claude

Skeuomorficzna **galeria zdjęć na Androida** z funkcjami AI. Interfejs inspirowany aparatami
cyfrowymi (viewfinder, mode dial, spust migawki), ale nowoczesny w użyciu, mocno customizowalny,
z motywami. Zbudowana na tym samym design systemie co siostrzany projekt `rec_ai` (dyktafon).

Stack: Expo SDK 56 (RN 0.85, React 19, TypeScript) — te same wersje co rec_ai, żeby portowany
kod działał bez zmian. **Zawsze sprawdzaj wersjonowane docsy: https://docs.expo.dev/versions/v56.0.0/**

## ⭐ NAJPIERW przeczytaj `DESIGN_SYSTEM.md`
To przenośne notatki całego skeuomorficznego systemu (obudowa, ekran, klawiatura kontekstowa,
knob, settings, listy, tryb device/fullscreen) + **§11 = adaptacja pod galerię-aparat**
(rozjazdy vs dyktafon, decyzje, kolejność startu). To jest mapa drogowa tego projektu.

## Co jest już w repo (Warstwa 0 — fundament, przeniesione 1:1 z rec_ai)
- `src/theme/tokens.ts` — kolory, `Gradient`, konwencja bevela RAISED/RECESSED, palety motywów,
  `dims`, `font`, cienie. Serce systemu.
- `src/theme/{ThemeContext,BlinkContext,TiltContext}.tsx` — konteksty.
- `src/lib/haptics.ts` — haptyka (PWM na Vibration).
- `src/hooks/useTilt.ts` — parallax (akcelerometr/mysz).
- `src/components/chrome/primitives.tsx` — `Bevel`, `MicGrille`.
- `assets/figma/{body_texture.png, screen_matrix.png}` — tekstura metalu + matryca (jedyne binaria,
  których nie da się odtworzyć z kodu).
- `App.tsx` — **stub** (płytka testowa: dowodzi, że tokeny+prymitywy+fonty działają). Do wymiany.

## Pierwsze uruchomienie
```
npm install
npm run web        # podgląd w przeglądarce (http://localhost:8081)
```
Realny skeuomorfizm (tekstura, haptyka, tilt) tylko natywnie (Expo Go / dev build). Web = podgląd UI.

## Kolejność budowy (z DESIGN_SYSTEM.md §11d)
1. Warstwa 0 + rama+slot + device/fullscreen (§1, §2, §2b) — postaw „martwy" korpus z pustym ekranem.
2. Kontekstowa klawiatura + kompozytor `App.tsx` (§4, §8), tryby BROWSE / VIEWER / SETTINGS (mock).
3. Siatka miniatur na `expo-media-library` (§11b.2) — pierwszy realny content (WIRTUALIZACJA!).
4. Viewer pełnoekranowy + gesty (§11c) — uwaga na konflikt pinch (zoom vs device/fullscreen).
5. Settings + **motywy parametryczne** (§11b.4).
6. AI (§11b.5) — proxy vision, per-kafel status, na końcu.

## AI + backend + publikacja — ZBUDOWANE (stan 2026-07-11)
- **`server/`** — cienki backend-proxy (Node/Express + OpenAI SDK) do deAPI (OpenAI-compat `https://oai.deapi.ai/v1`).
  Endpointy: `POST /api/v1/image-edits` (obraz+prompt), `/api/v1/image-fills`. Model `Flux_2_Klein_4B_BF16`, `enhance_prompt=1`.
  Klucz deAPI TYLKO w `server/.env` (gitignored) — nigdy w apce/repo/pamięci. Deploy: Railway (patrz `server/README.md`).
  **WDROŻONY (2026-07-13)**: Railway projekt `gallery-ai-backend` (workspace Pietrus914), URL
  `https://gallery-ai-backend-production.up.railway.app`. Deploy przez CLI `railway up` z folderu `server/`
  (repo należy do `marcinciupa`, więc nie GitHub-integration). Zmienne (`DEAPI_API_KEY`, `APP_KEY`, `DEAPI_MODEL`,
  `DEAPI_STEPS`) ustawione w Railway Variables. `/health` OK, `image-edits` przetestowany end-to-end — AI działa naprawdę.
- **Apka**: `src/lib/deapi.ts` woła proxy (`EXPO_PUBLIC_API_URL` + nagłówek `X-App-Key`); `src/lib/localFile.ts` sprowadza
  zdalny wynik do `file://` (upload/zapis/edycja łańcuchowa). AI działa TYLKO gdy `EXPO_PUBLIC_API_URL` wskazuje wdrożony
  backend; bez tego `AI_STUB` (echo obrazu). Dodano `expo-file-system`.
- **⚠️ PUŁAPKA buildu EAS (powód, czemu 9240 wyszło STUB)**: `.env` jest gitignored → chmura EAS go NIE wysyła, więc
  `EXPO_PUBLIC_*` nie trafiały do AAB. Rozwiązanie: zmienne muszą być w **EAS Environment `production`**
  (`eas env:create --environment production --name EXPO_PUBLIC_API_URL --value <URL> --visibility plaintext`, tak samo
  `EXPO_PUBLIC_APP_KEY`). Ustawione 2026-07-13. NIE wpisywać ich do `eas.json` (repo jest publiczne). Lokalny `.env`
  zostaje do dev (Expo Go / web).
- **Google Play**: konto `pietrus914`, EAS `@pietrus914/gallery-ai`, pakiet `com.glue010.galleryai`, `eas.json` (profil
  `production` → AAB). Pierwszy AAB: v0.924 / vc 9240 (AI w trybie STUB — backend jeszcze nie na Railway). Grafiki + opisy
  EN w `store_assets/`. Polityka prywatności = publiczny Google Doc. Ikona launchera: zielony obiektyw (podmiana z placeholdera).
- **NASTĘPNY KROK**: proxy na Railway ✅, `EXPO_PUBLIC_API_URL` w `.env` + w EAS env `production` ✅, bump 0.925/vc 9241 ✅,
  testy (tsc + expo-doctor 21/21) ✅, build AAB v0.925/vc 9241 z AI produkcyjnym w toku na EAS.
  Zostało: pobrać AAB i **wysłać na Google Play** (ew. `eas submit -p android --profile production`).

## Kluczowe decyzje designowe (podjęte)
- **Tryb wyświetlania ekranu = wybór użytkownika, 3 poziomy** (§11b.1): IMMERSIVE (B&W+fosfor+matryca),
  RETRO (matryca+fosfor, zdjęcia kolorowe), CLEAN (czyste zdjęcia). Filtr na realnych zdjęciach →
  potrzebny Skia (native) / CSS filter (web).
- **Motywy mocno customizowalne** — rozszerzyć `ThemeName` z enuma na parametryczny (kolor metalu/
  akcentu). Konwencja bevela (półprzezroczyste 25%) jest theme-agnostic → działa dla dowolnego koloru.

## Zależności do dołożenia w miarę potrzeb (użyj `npx expo install`, dobierze wersje pod SDK 56)
- `@react-native-async-storage/async-storage` — persystencja Settings (wzorzec `label→value`).
- `expo-media-library` — dostęp do zdjęć (uprawnienia!).
- `expo-image` — miniatury + cache w siatce.
- `@shopify/flash-list` — wirtualizacja siatki (setki/tysiące zdjęć — NIE ScrollView+map).
- `@shopify/react-native-skia` — filtr fosfor/B&W na zdjęciach (tryb IMMERSIVE/RETRO).
- `expo-sqlite` (+ `expo-file-system`) — indeks/cache mediów (store jak `useRecordings`).
- `expo-keep-awake`, `expo-sharing` — jak w rec_ai, gdy potrzebne.

## Working agreement (przeniesione z rec_ai, ustalenia użytkownika)
1. **QA po każdym etapie** — realny run/test, nie tylko „kompiluje się".
2. **Code review tylko na wyraźną prośbę** użytkownika (nie z automatu).
3. **Bugi z QA/review naprawiać od razu** — nic nie odkładać jako TODO.
4. **Commit / build tylko na prośbę** — użytkownik sam inicjuje.
5. **Sekrety tylko w `.env` (gitignored)** — nigdy w kodzie/CLAUDE.md/pamięci.
6. Użytkownik jest **designerem, nie developerem** — prowadzić za rękę, decyzje techniczne
   podejmować samodzielnie i je krótko uzasadniać.

## Izolacja
`rec_ai` (siostrzany projekt w `~/projects/rec_ai`) traktować **tylko do odczytu** jako wzorzec —
nie modyfikować go z tego projektu. Portować pliki przez kopię, nie referencje.
