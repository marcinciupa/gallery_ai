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

**Build APK i QA — jedną komendą** (bliźniaki skryptów z `rec_ai/mobile/tools`, ta sama konwencja wersji):
- `npm run build` → tsc → testy → prebuild (gdy trzeba) → **re-pin Gradle 8.14.3 + `local.properties`**
  (`expo prebuild` je kasuje) → `assembleRelease` → sprawdzenie, że numer wersji NAPRAWDĘ jest w bundlu
  (gradle bywa no-op i zostawia stary APK) → `tools/deliver-apk.sh`. Flagi: `--bump` (+0.001),
  `--half` (+0.0005), `--verify a,b` (napisy do sprawdzenia w bundlu), `--no-deliver`, `--release`.
  Procedury NIE odtwarzać ręcznie — skrypt po to jest.
- `npm run check` → `typecheck` + `test`. Runner testów (`tools/run-tests.mjs`) jest gotowy, ale
  `tools/test-*.mjs` jeszcze nie ma: `src/lib/*` w tym projekcie ciągnie react-native/expo, więc testowalna
  offline jest dopiero logika wydzielona do czystych modułów (wzorzec: `rec_ai/mobile/src/lib/prompts.ts`).

## Kolejność budowy (z DESIGN_SYSTEM.md §11d)
1. Warstwa 0 + rama+slot + device/fullscreen (§1, §2, §2b) — postaw „martwy" korpus z pustym ekranem.
2. Kontekstowa klawiatura + kompozytor `App.tsx` (§4, §8), tryby BROWSE / VIEWER / SETTINGS (mock).
3. Siatka miniatur na `expo-media-library` (§11b.2) — pierwszy realny content (WIRTUALIZACJA!).
4. Viewer pełnoekranowy + gesty (§11c) — uwaga na konflikt pinch (zoom vs device/fullscreen).
5. Settings + **motywy parametryczne** (§11b.4).
6. AI (§11b.5) — proxy vision, per-kafel status, na końcu.

## AI + backend + publikacja — ZBUDOWANE (backend przepisany na v2 REST, 2026-07-14)
- **`server/`** — cienki backend-proxy (Node/Express) do **deAPI natywny REST v2** (`https://api.deapi.ai`).
  Endpointy: `POST /api/v1/{image-edits, image-fills, remove-background, upscale, image-erase}` + `prompt-boost`
  (passthrough) + `POST /webhooks/deapi` (odbiornik callbacków). Modele: edycja `Flux_2_Klein_4B_BF16` (img2img,
  wymaga `seed`), usuwanie tła **dedykowany `Ben2`** (alt. `RMBG-1.4`), upscale **dedykowany `RealESRGAN_x4`**.
  UI apki (EditorScreen): AI_FUNCS = MAGIC ERASE (remove-bg/erase), TEXT TO IMAGE (edit), UPSCALE, FILTERS
  (wciąż stub „SOON"). deAPI v2 jest ASYNC: submit→`request_id`→wynik przez
  **webhook (HMAC) z fallbackiem na polling** `GET /api/v2/jobs/{id}`; proxy trzyma połączenie apki synchronicznie.
- **⚠️ KLUCZ deAPI — dwa realmy auth (łatwo się pomylić)**: format `<id>|<token>` (np. `13660|…`). OpenAI-compat
  (`oai.deapi.ai/v1`, stary backend) WYMAGAŁ prefiksu `dpn-sk-`; **REST v2 (`api.deapi.ai`) prefiksu NIE przyjmuje**
  (401). Serwer odcina `dpn-sk-` na potrzeby v2, więc `DEAPI_API_KEY` może być z prefiksem lub bez.
- Klucz deAPI + `DEAPI_WEBHOOK_SECRET` TYLKO w `server/.env` (gitignored) / Railway Variables — nigdy w apce/repo/pamięci.
  **WDROŻONY**: Railway `gallery-ai-backend` (Pietrus914), URL `https://gallery-ai-backend-production.up.railway.app`,
  deploy `railway up` z `server/` (repo `marcinciupa`, więc nie GitHub-integration). Railway auto-wstrzykuje `PORT`
  i `RAILWAY_PUBLIC_DOMAIN` (→ webhook_url). Zmienne: `DEAPI_API_KEY`, `APP_KEY`, `DEAPI_MODEL`, `DEAPI_STEPS`,
  `DEAPI_BG_MODEL`, `DEAPI_WEBHOOK_SECRET`. Wszystkie 4 trasy obrazów przetestowane end-to-end (Ben2 tło, Flux edycja).
- **Apka**: `src/lib/deapi.ts` woła proxy (`EXPO_PUBLIC_API_URL` + nagłówek `X-App-Key`); `src/lib/localFile.ts` sprowadza
  zdalny wynik do `file://` (upload/zapis/edycja łańcuchowa). AI działa TYLKO gdy `EXPO_PUBLIC_API_URL` wskazuje wdrożony
  backend; bez tego `AI_STUB` (echo obrazu). Dodano `expo-file-system`.
- **⚠️ MASKA / INPAINTING (2026-07-31, v0.963)** — deAPI **nie ma maskowanego inpaintingu** (docs `images/edits`:
  „Inpainting (`mask` parameter) is not supported"), więc model regeneruje CAŁY obraz i edycja rozlewała się daleko
  poza zaznaczenie (zgłoszenia: MAGIC ERASE, TEXT TO IMAGE, GENERATIVE FILL). Rozwiązanie = **kompozycja z maską
  po stronie proxy**: apka wysyła maskę WEKTOROWO (pole multipart `mask_paths`, współrzędne 0…1 względem pola
  obrazu — `MaskCanvas.getMask()`), a serwer rasteryzuje ją w rozdzielczości zdjęcia (`server/src/mask.ts`),
  kadruje ROI wokół zaznaczenia, puszcza edycję, dopasowuje ton i wkleja wynik przez rozmytą maskę
  (`server/src/compose.ts`). Poza zaznaczeniem piksele zostają nietknięte. Odpowiedź to wtedy `{ image_base64, mime }`
  (JPEG), a nie `{ uri }` — proxy oddaje własną kompozycję. **Bez `mask_paths` trasy działają po staremu**, żeby
  już wydane wersje apki nie przestały działać.
  - GENERATIVE FILL nie potrzebuje maski z apki — bierze ją z **kanału alfa** (przezroczyste rogi po obrocie kadru).
    Dziury są **zalepiane przed wysyłką** (kolor najbliższego sąsiada + rozmycie): deAPI spłaszcza przezroczystość
    do CZERNI, więc model dostawał czarny kwadrat i grzecznie go zostawiał.
  - **⚠️ PUŁAPKA sharpa (kosztowała pół debugowania)**: operacje w JEDNYM łańcuchu wykonują się w stałej kolejności
    WEWNĘTRZNEJ, nie w kolejności wywołań — `.blur(s).threshold(1)` odpalało próg PRZED rozmyciem. Każdy etap
    zmiękczania maski musi być OSOBNYM wywołaniem sharpa. Druga pułapka: bufor raw 1-kanałowy jest promowany do
    3 kanałów, trzeba wymusić `.toColourspace('b-w')`. Obie pilnuje `npm test` w `server/`.
  - Testy: `npm test` w `server/` = selftest offline (maska, ROI, kompozycja — bez sieci i kredytów);
    `npm run e2e` = pełny przebieg na ŻYWYM deAPI (**pali kredyty**, wymaga działającego `npm start`).
- **⚠️ PUŁAPKA buildu EAS (powód, czemu 9240 wyszło STUB)**: `.env` jest gitignored → chmura EAS go NIE wysyła, więc
  `EXPO_PUBLIC_*` nie trafiały do AAB. Rozwiązanie: zmienne muszą być w **EAS Environment `production`**
  (`eas env:create --environment production --name EXPO_PUBLIC_API_URL --value <URL> --visibility plaintext`, tak samo
  `EXPO_PUBLIC_APP_KEY`). Ustawione 2026-07-13. NIE wpisywać ich do `eas.json` (repo jest publiczne). Lokalny `.env`
  zostaje do dev (Expo Go / web).
- **⛔ NIGDY nie dodawać `MANAGE_EXTERNAL_STORAGE` („dostęp do wszystkich plików") — usunięte w 0.969.**
  Google Play odrzuciło je DWA RAZY (2026-09-02) z dwóch tytułów naraz: (1) galeria nie jest na liście
  dozwolonych zastosowań (menedżer plików, backup, antywirus, zarządzanie dokumentami, wyszukiwanie plików,
  szyfrowanie dysku, migracja urządzeń), (2) apce operującej na samych zdjęciach polityka NAKAZUJE MediaStore.
  Uprawnienie nigdy nie odblokowywało tu żadnej funkcji — służyło WYŁĄCZNIE do wyciszenia systemowego okna
  zgody, więc jego usunięcie niczego nie zepsuło. Nie próbować bronić go deklaracją: poprzednia próba
  (przemianowanie apki na „menedżer plików" w opisie sklepowym) była ślepą uliczką i została skasowana razem
  z `store_assets/all_files_access_declaration.md`. Usunięto też `src/lib/allFilesAccess.ts`, nakładkę
  „ALLOW FILE ACCESS?" i zależność `expo-intent-launcher`.
  - **Jak kasowanie działa teraz** (`mediaOps.ts` → `deleteCore`): najpierw `File.delete()` po ścieżce — to
    przechodzi BEZ OKNA dla plików, których właścicielem jest nasza apka (kopie z COPY/MOVE, zapisy po edycji
    AI; Android 11+ pozwala pisać po ścieżce do własnych plików bez uprawnień specjalnych). Reszta (zdjęcia
    z aparatu i innych apek) idzie przez `Asset.delete` → `MediaStore.createDeleteRequest` = JEDNO okno na
    CAŁĄ paczkę, niezależnie czy kasujesz 1 zdjęcie czy 300.
  - **Odmowa w oknie jest normalnym wynikiem** i musi być obsłużona: `deleteAssets`/`deleteItems`/`deleteForever`
    zwracają klucze, które FAKTYCZNIE zniknęły. Nie wolno czyścić stanu apki (kosza) bezwarunkowo — wcześniej
    odmowa kasowała wpis z kosza, więc zdjęcie wracało do galerii jako „nieskasowane, ale i nie w koszu".
    Przy MOVE odmowa jest CZĘŚCIOWA (nasze pliki już zniknęły) — rollback kasuje tylko kopie, których oryginał
    PRZEŻYŁ, inaczej traci się zdjęcie.
  - Auto-czyszczenie kosza po 30 dniach odpala się **przy wejściu do kosza**, nie przy starcie apki — inaczej
    okno zgody wyskakiwałoby użytkownikowi na powitanie, bez kontekstu.
  - **„Zero okien" = `MANAGE_MEDIA` (0.970)** — „Aplikacje do zarządzania multimediami", Android 12+. Z włączonym
    przełącznikiem system SAM zatwierdza createDeleteRequest/createWriteRequest (trwałe DELETE i MOVE bez okna;
    zweryfikowane na emulatorze 2026-09-21: OFF → okno, ON → brak okna, pliki realnie skasowane/przeniesione).
    Nie jest na liście uprawnień ograniczonych Play (bez formularza). Stan i ekran ustawień daje lokalny moduł
    natywny `modules/media-manage` (`src/lib/mediaManage.ts`); prośba = panel „ALLOW MEDIA MANAGEMENT?" +
    ALLOW/SKIP przed pierwszym MOVE / trwałym kasowaniem, raz na uruchomienie. Android 11 dalej pyta.
  - `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` ZOSTAJĄ i mają własną deklarację „Photo and Video Permissions"
    w Play Console — galeria jest tu przypadkiem kanonicznym (systemowy Photo Picker nie daje funkcji galerii).
- **Google Play**: konto `pietrus914`, EAS `@pietrus914/gallery-ai`, pakiet `com.glue010.galleryai`, `eas.json` (profil
  `production` → AAB). Pierwszy AAB: v0.924 / vc 9240 (AI w trybie STUB — backend jeszcze nie na Railway). Grafiki + opisy
  EN w `store_assets/`. Polityka prywatności = publiczny Google Doc. Ikona launchera: zielony obiektyw (podmiana z placeholdera).
- **⚠️ Backend i apka wydają się RAZEM**: kompozycja z maską żyje w `server/`, więc sam AAB jej nie przyniesie.
  Kolejność: `railway up --service gallery-ai-backend` z `server/` → dopiero potem publikacja AAB (apka bez
  świeżego proxy dostanie po prostu starą, nielokalizowaną edycję — nie wywali się, ale bug wróci).
- **⚠️ PLIKI ROBOCZE NIE MOGĄ LEŻEĆ W CACHE** (znalezione testem na emulatorze, v0.963 → 0.9635): wynik edycji
  wracał jako `data:` i lądował w `cacheDirectory`, a Android kasuje cache aplikacji przy braku miejsca
  (`pm trim-caches`; urządzenie testowe miało /data zajęte w 93%). Objaw mylący: obraz był WIDOCZNY (siedział
  w cache'u `expo-image`), ale SAVE padał z `FileNotFoundException` — czyli „edycja jest, tylko nie da się jej
  zachować". `localFile.ts` używa teraz `documentDirectory/gai-work/` + sprzątanie po dobie, a `persistWorkFile()`
  przenosi tam też wynik `expo-image-manipulator` (kadr). Regresja-test: `pm trim-caches 4G` między APPLY a SAVE.
- **STAN 2026-07-31 (v0.9635 / vc 9635)**: backend z maską WDROŻONY na Railway i sprawdzony e2e po produkcyjnym
  URL-u (`/health` → `masking: true, webhooks: true`; trasy 9–17 s, mieszczą się w 90 s limitu apki). AAB
  zbudowany na EAS i PRZETESTOWANY na emulatorze (Pixel 7 API 34, AAB → bundletool → APK): start, galeria,
  malowanie maski, MAGIC ERASE przez produkcyjny backend, SAVE do galerii, CROP → SAVE.
  **Zostało: wysłać AAB na Google Play** + wkleić „What's new" ze `store_assets/release_notes_en.md`.
- **Jak przetestować AAB bez telefonu**: `bundletool build-apks --mode=universal` → `adb install`; emulator
  `Pixel_7_API_34` jest w SDK. Uwaga: AVD bywa na granicy miejsca — `INSTALL_FAILED_INSUFFICIENT_STORAGE`
  leczy `pm trim-caches`.
- **Emulator stoi po stronie WINDOWS — odpalać przez `~/tools/android-emu-win.sh`** (globalny, wspólny
  z rec_ai; `--apk <plik>` instaluje i startuje, `--metro` robi `adb reverse 8081`, `--no-window`,
  `--cold`, `--stop`). `adb` z WSL wołamy przez **`~/tools/adbw.sh`** — to windowsowe `adb.exe` z tłumaczeniem
  ścieżek WSL→Windows (`install`, `push`, `pull`); `exec-out screencap` działa normalnie.
  SDK: `C:\Users\<user>\Android\Sdk`, AVD: `C:\Users\<user>\.android\avd\Pixel_7_API_34.avd` (6 rdzeni, 4 GB, `hw.gpu.mode=host`).
  **Dlaczego przeniesione (pomiary 2026-08-06, ten sam AVD i APK — rec_ai 0.972):**
  - **WSL/WSLg: GPU nieosiągalne.** `-gpu host` (Mesa/D3D12 przez `/dev/dxg`) startuje, ale proces **pada**
    zaraz po starcie systemu; Vulkan → `VK_ERROR_INCOMPATIBLE_DRIVER` (brak `/dev/dri`). Zostawał
    `swangle_indirect` = rendering na CPU: **~550 ms/klatkę** nawet w pół-rozdzielczości → ~2 fps.
    Do tego okno X11 pod RDP **kradło fokus** (dwa kliknięcia w terminal).
  - **Windows: WHPX + `-gpu host` → realny GPU** („Android Emulator OpenGL ES Translator (NVIDIA GeForce
    RTX 3070 Ti Laptop GPU)"): **20–34 ms/klatkę w natywnym 1080x2400**, GPU p50 = 9 ms. ~20× szybciej,
    bez kradzenia fokusu, bez trybu pół-rozdzielczości i bez hacków na `libpulse`.
  - Warunek: `HypervisorPlatform` (WHPX) włączony w Windowsie (`dism … /FeatureName:HypervisorPlatform`
    z admina + restart). Weryfikacja: `emulator.exe -accel-check`.
  - `--metro` działa: reverse rejestruje windowsowy serwer adb → `localhost:8081` Windowsa → (localhostForwarding
    WSL2) → Metro w WSL. Sprawdzone e2e requestem z emulatora do serwera HTTP w WSL.
  Wariant WSL-owy (`~/tools/android-emu.sh`, obrazy systemu w WSL, `~/.local/lib/emu-deps`) został **skasowany**
  (odzyskane ~9 GB). Emulator nadal służy do **layoutu i logiki**; ocena haptyki/płynności — telefon.

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
`rec_ai` (siostrzany projekt w `~/projects/rec_ai`, apka w `mobile/`) traktować **domyślnie tylko do
odczytu** jako wzorzec — kodu (ekrany, komponenty, logika) nie modyfikować z tego projektu. Portować
pliki przez kopię, nie referencje.

**Wyjątek: wspólny branding/design.** Apki są bliźniacze i dzielą jeden system wizualny, więc zmiany
w assetach (ikony, splash, adaptive icon) i w tokenach designu wolno robić w obu naraz — ale tylko na
wyraźną prośbę użytkownika i zawsze symetrycznie (co w gallery, to i w rec_ai).

**Aktualny zestaw ikon (rebrand „+" 2026-07-24, Figma section `gallery_plus_icons` #504:29803 /
`rec_plus_icons` #504:29802).** Nazwane frame'y w Figmie → assety (identyczne mapowanie w obu apkach):
- `*_icon` (128, kafel: tło `#1A1A1A` + matryca + circular vignette) → `icon.png` **=** `android-icon-foreground.png` (render 512).
- `*_splash_icon` (128, GLIF na PRZEZROCZYSTYM tle — nie kafel!) → `splash-icon.png` **=** `android-icon-monochrome.png`
  (render 512; monochrome bierze sam kształt z alfy, Android tintuje).
- `*_favicon` (96) → `favicon.png` (render 384).
- `*_icon_google_play` (512, kafel) → `store_assets/app_icon_512.png` (scale 1) + `app_icon_1024.png` (scale 2).
- `*_icon_variant` (zielony/czerwony kafel) — alternatywa, NIE używana w apkach.

Stałe: brak `backgroundImage`; `adaptiveIcon.backgroundColor` = `#1A1A1A`; splash `backgroundColor` =
`#1A1A1A` i `imageWidth: 128`. Figma renderuje maks `pngScale: 4`, stąd 512 px z frame'a 128.
(Poprzednia konwencja 2026-07-21 miała splash = pełny kafel; nowy zestaw zmienił splash i monochrome na glif.)
