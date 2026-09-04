# Plan wdrożenia: FOTO DO DOKUMENTÓW („ID PHOTO") w gallery_ai

Data: 2026-08-06. Punkt odniesienia: analiza całego serwisu photoaid.com/pl (strona główna,
podstrony dokumentów + osadzone dane geometryczne, „Jak to działa", dostawa/szablon druku,
zdjęcie do CV, kioski) + mapa aktualnego kodu (HEAD 53aff11, v0.967).

---

## 1. Co robi PhotoAiD i co z tego replikujemy

Ich przepływ (web + aplikacja):
1. Wybór dokumentu z katalogu (~70 typów: dowód, paszport, wizy, legitymacje, CV…).
2. Wgranie/zrobienie zdjęcia (wskazówki: 50 cm–1,2 m, na wprost, światło dzienne, tło obojętne).
3. AI: detekcja twarzy → **auto-kadr wg geometrii dokumentu** → **wymiana tła na jednolite**
   → docelowa rozdzielczość (druk mm @ 600 dpi + wariant cyfrowy w px).
4. Auto-weryfikacja: twarz rozpoznana, kadr, tło, wymiary, oświetlenie, cienie, czerwone oczy.
5. Płatność (24–29 zł cyfrowe / 34–39 zł odbitki) → **weryfikacja przez człowieka-eksperta**
   (24/7, kilka minut) → dostawa: plik na e-mail + **szablon do druku** (arkusz do samodzielnego
   wydruku w drogerii/domu) lub wysyłka odbitek; gwarancja 200% zwrotu przy odrzuceniu.

**Kluczowe znalezisko — ich model geometrii per dokument** (z osadzonego JSON-a stron):

```
{ bgColor, size {w,h,unit}, resolution(dpi), online(bool), printable(bool),
  params: { headHeight, photoTopToHairTop | photoBottomToEyeLine } }
```

Przykłady realnych wartości:
| Dokument | Rozmiar | Tło | Głowa | Pozycjonowanie |
|---|---|---|---|---|
| PL dowód/paszport/prawo jazdy/PKK/legitymacje/dziecko | 35×45 mm, 600 dpi | `#FCFCFC` | 36 mm | 3 mm od górnej krawędzi do szczytu włosów |
| PL dowód online (ePUAP) | 492×633 px | `#FCFCFC` | j.w. | j.w. |
| Karta pobytu | 684×883 px (~497 dpi) | `#FCFCFC` | 36 mm | 3 mm |
| Wiza USA / DV Lottery | 2×2 in (600×600 px) | `#FFFFFF` | 1,13–1,29 in | linia oczu 1,18 in od dołu |
| CV | 35×45 mm (tylko druk/plik) | `#FCFCFC` | 34 mm | 3 mm |

Czyli: **cała „magia" to detekcja twarzy + prosta geometria + wycinka tła + resize/DPI + arkusz.**
Wszystko poza detekcją twarzy już potrafimy (Ben2 + sharp na proxy).

**Replikujemy (kroki 1–4 + szablon druku):** katalog dokumentów, auto-kadr z geometrii,
białe/jednolite tło, dokładne wymiary i DPI, auto-checklista jakości, zapis pliku cyfrowego
i arkusza do druku do galerii.

**Świadomie NIE replikujemy:** płatności, weryfikacji przez człowieka, gwarancji akceptacji,
wysyłki odbitek, kiosków. Konsekwencja: **musimy uczciwie komunikować**, że to „pre-check", a
ostateczna akceptacja należy do urzędu (disclaimer w UI). Nasza przewaga: w PhotoAiD każde
zdjęcie kosztuje 24–29 zł — u nas funkcja jest wbudowana w galerię i darmowa.

---

## 2. Przepływ w naszej apce (zgodny z design systemem)

Wejście: VIEWER → EDIT → zakładka **AI EDIT** → nowa pozycja **`ID PHOTO`** w `AI_FUNCS`
(`src/screens/EditorScreen.tsx:38`), wstawiona przed `FILTERS` (indeksy `AI_TEXT2IMG=1`,
`AI_UPSCALE=2` bez zmian). Nowy `EditView: 'idPhoto'` z wewnętrzną maszyną 3 kroków:

**Krok 1 — DOCUMENT (katalog):** lista w stylu sub-widoku folderów
(`SettingsScreen.tsx` — wzorzec `FolderFilterRow`, nawigacja joystickiem, wybór klawiszem).
Wiersze = wpisy katalogu (label + wymiar po prawej). Klawisze: `SELECT` / `BACK`.

**Krok 2 — FRAME (kadr z prowadnicami):** **reużywamy `CropStage`**
(`src/screens/CropStage.tsx` — ramka, uchwyty, blokada proporcji, obrót, EXIF już działają)
z nowymi opcjonalnymi propsami:
- `lockedAspect` (np. 35:45 — bez paska ASPECTS),
- `guides` — nakładka SVG w kolorze HUD motywu: klamra wysokości głowy (od szczytu włosów po
  brodę), linia oczu, margines górny; rysowane z geometrii dokumentu,
- `initialWindow` — okno startowe wyliczone przez serwer z detekcji twarzy (auto-kadr);
  bez sieci użytkownik ustawia ręcznie wg prowadnic (pełny fallback offline).
Klawisze: `BG ON/OFF` (podmiana tła) / `APPLY`. Joystick = precyzyjne przesuwanie okna.

**Krok 3 — RESULT (podgląd + checklista + eksport):** podgląd wyniku z serwera + lista
kontrolna (wiersze jak w Settings; statusy `OK` / `CHECK` w akcencie motywu — zgodnie z zasadą
„HUD nigdy nie alarmuje czerwienią"). Klawisze: `FORMAT [CYCLE]` (PRINT / ONLINE / SHEET) /
`REDO`; slot metal `SAVE` (jak w edytorze — `infoSlot`) zapisuje aktywny format do albumu
`DOCUMENTS` (`src/lib/mediaOps.ts`, nazwa przechodzi `ALBUM_NAME_RE`). Pod spodem stały
disclaimer (patrz §6).

Haptyka/labeling wg systemu: labele Kode Mono, łamanie `ID\nPHOTO` niepotrzebne (mieści się),
hold-y tam gdzie akcje niszczące. Tryb IMMERSIVE wyświetli podgląd w zielonym monochromie —
to cecha ekranu, nie pliku; w kroku RESULT dodać dopisek `PREVIEW TINTED — FILE IS COLOR`
(albo wymusić podgląd CLEAN w tym jednym widoku — decyzja designerska, patrz §7).

---

## 3. Architektura techniczna

### Podział odpowiedzialności (2 wywołania, 1 płatny job deAPI)

```
APKA                                  SERWER (Railway, Node/Express/sharp)
────                                  ────────────────────────────────────
[1] upload zdjęcia (bake EXIF,        POST /api/v1/id-photo-analyze
    cap 1536 jak dziś)          ───▶  detekcja twarzy (lokalnie, darmowa):
                                      landmarki (broda, oczy) + sugestia okna kadru
                                      z geometrii dokumentu + ostrzeżenia
    CropStage z initialWindow   ◀───  { faceBox, chin, eyes, suggestedWindow, warnings[] }
    użytkownik akceptuje/poprawia
    crop CLIENT-side (manipulator)
[2] upload wykadrowanego PNG    ───▶  POST /api/v1/id-photo  (finalize)
    + spec {w,h,unit,dpi,bgColor,     bg=1: Ben2 (deAPI) → cutout z alfą → feather
    headHeight,topMargin/eyeLine}     krawędzi (softenMask) → flatten na bgColor
    + flagi bg / formaty              bg=0: pomiń deAPI
                                      → resize do celów (lanczos) → JPEG q95, sRGB,
                                      metadata density=600dpi → opcjonalnie arkusz
    zapis do galerii            ◀───  { print_base64, online_base64?, sheet_base64?, checks[] }
```

- Kadr robimy **po stronie klienta** (użytkownik widzi dokładnie to, co wytnie), więc serwer
  nigdy nie kadruje — tylko liczy sugestię. Upload nr 2 to już wycinek, więc cap 1536 px
  praktycznie nie zjada rozdzielczości (wycinek ~60% kadru z aparatu i tak > 1063 px celu).
- `analyze` jest tani (bez deAPI) — można wołać przy każdym wejściu; kredyty pali dopiero
  `finalize` z `bg=1` (1× Ben2, jak dzisiejsze REMOVE BG; trasa `background-removals` już
  istnieje w `server/src/index.ts:457-464`, tu dokładamy kompozycję, której dziś nie ma).

### Detekcja twarzy na serwerze (jedyny nowy „duży" klocek)

- **Wybór: `@vladmandic/face-api`** (utrzymywany fork face-api.js) + `@tensorflow/tfjs-node`;
  modele TinyFaceDetector + 68 landmarków (~0,5 MB, commit do repo `server/models/`).
  68 punktów daje **precyzyjną brodę (punkt 8)** i linie oczu — dokładnie to, czego wymaga
  geometria. Inference CPU ~100–300 ms.
- **Szczyt włosów NIE z landmarków** (żaden model twarzy nie zna fryzury), tylko — jak
  najpewniej robi to PhotoAiD — **z kanału alfa wycinki Ben2**: najwyższy wiersz z alfą > progu
  = szczyt głowy. W `analyze` (przed Ben2) przybliżamy szczyt z proporcji twarzy
  (czubek ≈ faceBox.top − ~0,45×wysokości twarzy), a w `finalize` (po Ben2) mamy dokładny
  z alfy → serwer może zwrócić ostrzeżenie `HEAD SIZE OFF`, jeśli po wycięciu tła geometria
  ucieka z tolerancji.
- **Plan B** (gdyby `tfjs-node` nie zbudował się na Railway): backend `@tensorflow/tfjs` (WASM,
  wolniejszy ~1–2 s, zero natywnych zależności) albo `onnxruntime-node` + YuNet. Ryzyko
  sprawdzamy w Etapie 1 pierwszym deployem.
- Zero nowych natywnych zależności w APCE (bez ML Kit) — bundle bez zmian, fallback offline
  zostaje ręczny (prowadnice).

### Geometria kadru (czysta matematyka, testowalna offline)

Dla specu `{photoW, photoH, headHeight, topMargin | eyeFromBottom}`:
```
scale:  headHeight_px_na_zdjęciu / (headHeight/photoH)  →  wysokość okna kadru
pion:   topMargin → szczyt_włosów − (topMargin/photoH)×okno
        eyeFromBottom → linia_oczu + (eyeFromBottom/photoH)×okno − okno
poziom: środek oczu na osi; szerokość = okno × (photoW/photoH)
```
Wyjście poza obraz → przy `bg=1` dosztukowujemy tło (`sharp.extend` kolorem tła — niewidoczne,
bo tło i tak wymieniamy), przy `bg=0` → ostrzeżenie + tryb ręczny.

### Pipeline sharp (reużycie `server/src/compose.ts`)

Gotowe: `readImage`, `maskFromAlpha:65`, `softenMask:89` (feather krawędzi wycinki),
`cropRegion:99`, resize (`upscaleForModel:210`), `composite` + JPEG (`compositeThroughMask:265`).
Do dopisania (nowy moduł `server/src/idphoto.ts`): `flatten` na kolor tła, `extend`,
`sharp({create})` dla arkusza, zapis `density` (DPI) w metadanych, auto-layout arkusza.

### Formaty wyjściowe

| Format | Zawartość | Przykład (PL 35×45) |
|---|---|---|
| PRINT | dokładne mm @ 600 dpi, JPEG q95, density w metadanych | 827×1063 px |
| ONLINE | dokładne px specu, limit rozmiaru pliku (ePUAP ≤ 2,5 MB — u nas i tak ~0,3 MB) | 492×633 px |
| SHEET | arkusz **10×15 cm @ 600 dpi** (2362×3543), auto-layout kopii + cienkie znaczniki cięcia | 6 kopii 35×45 |

Layout arkusza liczony per spec (maks. kopii przy marginesach ≥ 1 cm zewn. / ~3 mm między
zdjęciami + linie cięcia 1 px szarości). Dla speców, gdzie na 10×15 mieści się < 2 kopie
(np. US 2×2″), SHEET pomijamy lub dajemy 300 dpi wariant — do rozstrzygnięcia w implementacji.

### Degradacja bez backendu (AI_STUB)

Bez `EXPO_PUBLIC_API_URL` lub offline: katalog + prowadnice + ręczny kadr + resize do px
po stronie klienta (`expo-image-manipulator`) — bez wymiany tła, bez DPI w metadanych, bez
arkusza; klawisz `BG` wygaszony z dopiskiem. Czyli funkcja nadal robi poprawny KADR i WYMIAR.

---

## 4. Katalog dokumentów v1 (apka = źródło prawdy, serwer bezstanowy)

Nowy `src/lib/docSpecs.ts` — apka wysyła pełny spec w `finalize`, więc dodanie dokumentu nie
wymaga zmiany serwera. Start (6 pozycji, nie kopiujemy 70):

| ID | Label w UI | Geometria | Eksporty |
|---|---|---|---|
| `pl-35x45` | `PL ID / PASSPORT 35×45` | 35×45 mm, głowa 36 mm, top 3 mm, tło `#FCFCFC` | PRINT 827×1063 / ONLINE 492×633 / SHEET |
| `pl-online` | `PL E-APPLICATION 492×633` | j.w., cel px | ONLINE |
| `pl-pobyt` | `PL RESIDENCE CARD` | 684×883 px (~497 dpi), reszta j.w. | ONLINE / PRINT |
| `us-visa` | `US VISA / DV 2×2″` | 51×51 mm, głowa 1,13–1,29″, oczy 1,18″ od dołu, tło `#FFFFFF` | ONLINE 600×600 / PRINT 1200×1200 |
| `schengen` | `SCHENGEN VISA 35×45` | 35×45 mm, głowa 32–36 mm, jasne tło | PRINT / ONLINE |
| `cv` | `CV / RESUME 35×45` | 35×45 mm, głowa 34 mm, luźniejsze reguły (uśmiech OK) | PRINT / ONLINE |

Etap 0 weryfikuje wartości ze źródeł urzędowych (obywatel.gov.pl — reqUrl PhotoAiD wskazuje
właśnie tam, travel.state.gov dla USA); mLegitymacja/ISIC — dopiszemy po weryfikacji px.
Opcja `CUSTOM w×h mm` — poza v1 (decyzja designerska).

## 5. Auto-checklista (nasza „weryfikacja AI" — bez obietnic ponad stan)

Z landmarków + obrazu, jako WARN (nigdy hard-block):
`FACE FOUND` / `ONE FACE ONLY` / `HEAD STRAIGHT` (kąt linii oczu > ~3°) / `LOOKING AHEAD`
(symetria landmarków, zgrubnie) / `EYES OPEN` (EAR z landmarków) / `MOUTH CLOSED` /
`LIGHT EVEN` (histogram lewa vs prawa połowa twarzy) / `SOURCE RES OK` (wycinek ≥ cel px)
/ `HEAD SIZE OK` (po Ben2, z alfy). Cieni ani czerwonych oczu **nie poprawiamy** (PhotoAiD też
tylko częściowo) — tylko sygnalizujemy.

## 6. Uczciwość i prywatność (wymagane w UI)

- Disclaimer w kroku RESULT + pierwszym uruchomieniu funkcji (wzorzec `WelcomeDialog`):
  „AUTOMATED PRE-CHECK ONLY. FINAL ACCEPTANCE IS UP TO THE ISSUING OFFICE." — bez słowa
  „gwarancja".
- Nota prywatności jak przy innych funkcjach AI: zdjęcie przetwarzane na naszym proxy + deAPI
  (Ben2) wyłącznie na czas operacji; serwer bezstanowy (multer w pamięci — tak już jest).

---

## 7. Etapy wdrożenia (każdy z QA — working agreement §1)

**Etap 0 — katalog + geometria „na sucho" (S)**
`src/lib/docSpecs.ts` + moduł geometrii na serwerze (`idphoto.ts`, czysta matematyka).
QA: tabela speców skonfrontowana ze źródłami urzędowymi; testy jednostkowe geometrii
(znane wejścia → znane okna kadru + fuzz jak w `selftest.ts:87-121`).

**Etap 1 — serwer: detekcja + `id-photo-analyze` (M)** ⚠ najpierw ryzyko
face-api + tfjs-node, trasa analyze, sugestia okna, ostrzeżenia. Selftest ze wstrzykniętym
stub-detektorem (offline, bez modeli); smoke na realnych portretach (wygenerujemy sobie
syntetyczne portrety naszym TEXT TO IMAGE — zero kwestii prywatności). **Od razu `railway up`**,
żeby zweryfikować build tfjs-node; jak nie — plan B (WASM).
QA: 3 portrety (dorosły / dziecko / okulary), sugestia kadru wzrokowo poprawna, < 2 s.

**Etap 2 — serwer: `id-photo` finalize (M)**
Ben2 → feather → flatten na kolor tła → resize/DPI → ONLINE px → arkusz z auto-layoutem
i znacznikami. Rozszerzenie selftestu: flatten/feather na syntetycznej alfie, dokładność px
(492×633 co do piksela), obecność density, layout arkusza (brak nachodzenia, marginesy).
QA: lokalny e2e (pali kredyty świadomie) — ocena wzrokowa krawędzi wycinki i bieli tła.

**Etap 3 — apka: pełny przepływ (L)**
`ID PHOTO` w `AI_FUNCS` + `EditView 'idPhoto'` + picker dokumentów (wzorzec listy z Settings)
+ `CropStage` z `lockedAspect`/`guides`/`initialWindow` + wywołania analyze/finalize
(`src/lib/deapi.ts` — dwie nowe funkcje na wzorcu `postImage`) + RESULT z cyklem formatów
+ SAVE do albumu `DOCUMENTS` + pełna degradacja STUB/offline.
QA: web (podgląd) + emulator: happy path, offline, wyjście kadru poza obraz, zdjęcie bez
twarzy, regresja `pm trim-caches` między APPLY a SAVE (pliki robocze!).

**Etap 4 — checklista + copy (S)**
Wiersze checków w RESULT, disclaimer, dialog pierwszego uruchomienia, dopisek o tintowanym
podglądzie w IMMERSIVE. QA: przegląd copy przez Ciebie (designer).

**Etap 5 — wydanie (S, na Twoją prośbę — working agreement §4)**
Kolejność jak zawsze: `railway up --service gallery-ai-backend` → e2e po produkcyjnym URL →
bump wersji (+0.001 → trzy miejsca: `app.json` ×2, `src/version.ts`) → AAB na EAS → test
bundletool na emulatorze Pixel 7 → Google Play + „What's new". Aktualizacja CLAUDE.md.

Szacunkowy rozmiar: serwer ~600–900 linii + ~0,5 MB modeli; apka ~500–700 linii; zero nowych
zależności w apce, dwie na serwerze.

---

## 8. Ryzyka i decyzje

**Ryzyka techniczne:**
1. Build `tfjs-node` na Railway — sprawdzany od razu w Etapie 1; plan B: WASM / onnxruntime.
2. Jakość wycinki Ben2 na włosach — feather + ostrzeżenie; nie obiecujemy efektu fotografa.
3. Czapki/przedmioty nad głową zawyżą „szczyt włosów" z alfy — warn, gdy szczyt daleko nad
   faceBox → sugestia trybu ręcznego.
4. Zgodność urzędowa — mierzymy geometrię wg oficjalnych wartości, ale bez gwarancji (stąd §6).

**Decyzje do potwierdzenia przez Ciebie (designerskie, nie blokują Etapów 0–2):**
1. Nazwa funkcji na klawiszu/menu: `ID PHOTO` (moja rekomendacja) vs `DOC PHOTO` vs `DOKUMENT`.
2. Zestaw dokumentów v1 (proponuję 6 z §4) i czy dokładać `CUSTOM w×h`.
3. RESULT w IMMERSIVE: dopisek o tincie (rekomendacja) czy wymuszony podgląd CLEAN.
4. Arkusz: tylko 10×15 (rekomendacja) czy też 13×18 / A4.
5. Album docelowy: `DOCUMENTS` (rekomendacja) czy zapis luzem do galerii.
