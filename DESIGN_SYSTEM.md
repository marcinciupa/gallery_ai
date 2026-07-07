# Design System — notatki przenośne (skeuomorficzny „sprzęt")

Notatki architektoniczne wyciągnięte z `rec_ai` (Expo SDK 56, RN 0.85, React 19), spisane
pod **drugą aplikację** opartą na tych samych założeniach designowych. Opisują JAK DZIAŁAJĄ
i CO JEST PRZENOŚNE: obudowa, ekran, klawiatura kontekstowa (klawisze ekranowe i metalowe),
knob, settings, listy.

Ścieżki odnoszą się do `mobile/src` w rec_ai. Wszystkie konkretne wartości (kolory, wymiary,
opacity) pochodzą z realnego kodu — można je odtworzyć 1:1.

---

## 0. Filozofia / metafora

Cała aplikacja to **jedno fizyczne urządzenie** (dyktafon). Nie ma routera ani nawigacji
ekranowej w klasycznym sensie — jest maszyna stanów trybów w `App.tsx`.

Trzy niezmienne zasady:

1. **Obudowa = stała rama, ekran = slot na treść.** Metalowa obudowa (`DeviceShell`) nigdy się
   nie zmienia; treść trybu wpada jako `children` do szklanego `Display`. Wszystkie efekty
   (połysk, poświata, matryca, bevel wpuszczenia) są NAD treścią i jej nie blokują
   (`pointerEvents:'none'`).
2. **Sprzęt jest kontekstowy, nie treść.** Jeden fizyczny slider (knob) i jedna fizyczna
   klawiatura są renderowane w obudowie. Każdy ekran to **hook** `useXScreen()` zwracający
   `{ content, keyboard, slider }`. `content` → slot ekranu; `keyboard`/`slider` → konfiguracje
   (dane, nie JSX) podpinane pod współdzielone kontrolki. Ten sam knob robi różne rzeczy
   zależnie od aktywnego ekranu.
3. **Fizyczne klawisze mają STAŁE nadrukowane labele; zmienia się tylko podświetlenie i akcja.**
   Jak na realnym sprzęcie: STOP/BACK i PLAY/PAUSE są zawsze widoczne, a to które słowo świeci
   (i co robi klik) zależy od trybu.

---

## 1. Fundament — tokeny, konwencja bevela, konteksty

To warstwa, którą przenosi się PIERWSZĄ i praktycznie 1:1. Reszta na niej stoi.

### 1a. `theme/tokens.ts` — serce systemu (zero zależności runtime poza `expo-linear-gradient`)

Typ gradientu (format zgodny z `expo-linear-gradient`):
```ts
type Gradient = { colors:[string,string,...]; locations?:number[]; start:{x,y}; end:{x,y} };
const DIR_135 = { start:{x:0,y:0}, end:{x:1,y:1} };  // TL→BR
const DIR_N45 = { start:{x:0,y:1}, end:{x:1,y:0} };  // BL→TR
```

**Konwencja światła (bevel) — fundament całego skeuomorfizmu:**
```ts
const BEVEL_LIGHT  = 'rgba(255,255,255,0.25)';   // biel 25%
const BEVEL_SHADOW = 'rgba(33,33,33,0.25)';      // #212121 @ 25%
const RAISED   = { colors:[BEVEL_LIGHT, BEVEL_SHADOW], ...DIR_135 };  // WYPUKŁY: jasno L-góra → ciemno P-dół
const RECESSED = { colors:[BEVEL_SHADOW, BEVEL_LIGHT], ...DIR_135 };  // WKLĘSŁY: odwrotnie
```
Konwencja wypukłości/wklęsłości jest zakodowana w KOLEJNOŚCI kolorów w tokenie, nie w
komponencie. Półprzezroczystość (25%) sprawia, że bevel działa na każdym motywie (nie hardcode
solid white — na jasnym motywie dawał brzydką białą kreskę).

**Palety motywów:**
```ts
type ThemeName = 'LIGHT' | 'DARK' | 'ORANGE' | 'NAVY';
type ThemePalette = {
  bodyMetal: Gradient; metal: string;
  raisedBevel: Gradient; recessedBevel: Gradient; pocketBevel: Gradient;
  printed: string; buttonActive: string; buttonInactive: string;
  recordRed: string; glow: string; shadow: string; casingDark: boolean;
};
```
Motyw przebarwia tylko elementy „metalowe/nadrukowane". **Ekran (szyba + fosfor) i ciemne
wnęki są STAŁE we wszystkich motywach.** Przykład LIGHT: `metal '#BABABA'`, `printed '#898989'`,
`buttonActive '#FFFFFF'`, `glow rgba(255,255,255,0.25)`. ORANGE: `bodyMetal #E95728→#E44F25`,
`buttonActive '#FFBF3E'`. DARK/NAVY: `casingDark:true`.

**Stałe kolory ekranu (niezależne od motywu):**
```ts
screen.bg    = '#1A1A1A'
screen.glow  = 'rgba(255,255,255,0.25)'
screen.olive = { primary:'#E2FFE4', secondary:'rgba(226,255,228,0.5)',
                 inactive:'rgba(226,255,228,0.25)', off:'rgba(226,255,228,0)' }  // FOSFOR
screen.red   = { primary:'#FF4C4C', secondary:..., inactive:..., off:... }
color.phosphor = '#E2FFE4'
```

**`dims` (layout):** `frame {390×844}`, `bodyRadius {tl:8, tr:8, br:32, bl:32}` (asymetryczne
rogi obudowy!), `statusBarHeight 40`, `upperMicHeight 40`, `screenPadding 16`, `screenGap 16`,
`screenRadius 4`, `screenFramePadding 2`, `sliderHeight 48`, oraz `keyboard`, `key {size:76,
padding:8, radius:4}`, `keyInner {size:60, offset:8, radius:32}`, `smallButton {32×20 r4}`,
`knob {64×20}`.

**`font` (role → rodzina+rozmiar):** `uiLabel Inter_500Medium/14`, `monoLabel KodeMono_700Bold/12`,
`monoCaption KodeMono_400/10`, `timer KodeMono_400/42`, `bodyLgBold Inter_700Bold/16`,
`caption Inter/10`. Dwie rodziny: **Inter** (UI/metal) + **Kode Mono** (ekran/labele klawiszy).

**Pochodne cieni:** `shadow.screenInset = 'inset 0 0 12px rgba(255,255,255,0.05)'`,
`knobShadow(t) = '8px 8px 6px shadow, -8px -8px 10px glow'` (cień P-dół + poświata L-góra),
`elevationShadow(t)`, gotowce `shadow.{knob,keyElevation,recordGlow,...}`,
`textShadow.phosphor = rgba(226,255,228,0.25)`.

### 1b. Konteksty (czyste, generyczne, kopiowalne 1:1)

- **`ThemeContext.tsx`** (16 linii): `createContext<ThemePalette>(themes.LIGHT)` + `useTheme()`.
  Wstrzykiwany RAZ w `DeviceShell` przez `<ThemeProvider value={themes[theme]}>`. Zmiana motywu
  = inny props `theme` do `DeviceShell`. Brak logiki przełączania — sterowane z góry.
- **`TiltContext.tsx`**: `{ tx, ty }: Animated.Value | null` (null = brak ruchu). Zasilany przez
  `useTilt(enabled)`. Opcjonalny — bez niego wszystkie efekty mają statyczny fallback.
- **`BlinkContext.tsx`**: wspólne miganie 1000 ms on/off (`active=false` → stałe `on`, brak
  interwału). Jedno źródło prawdy, żeby pigułka REC w szybie i dioda LED na obudowie migały RAZEM.

### 1c. `hooks/useTilt.ts` — parallax (opcjonalny, toggle „MOTION")

Zwraca `{ tx, ty }` w zakresie −1..1.
- `enabled=false` → animacja do 0, brak subskrypcji sensora.
- Web: fallback na `pointermove` (`nx = clientX/innerWidth*2-1`).
- Natywnie: lazy `require('expo-sensors')`, `Accelerometer` 20 Hz, `ty` odwrócone dla naturalnego
  parallaxu, pauza gdy apka w tle (`AppState`, oszczędność baterii).
- Świadomie `useNativeDriver:false` (wartości karmione `setValue` z JS).

### 1d. `components/chrome/primitives.tsx` — dwa prymitywy budulcowe

**`Bevel`** — metaliczny bevel bez SVG, przez border-kolory per-strona:
```ts
Bevel({ stroke: Gradient, width=1, radius, fill?, fillGradient?, style?, innerStyle?, children })
// tl = stroke.colors[0] → borderTop/LeftColor;  br = stroke.colors[1] → borderBottom/RightColor
```
Konwencja RAISED/RECESSED wynika z kolejności kolorów w `stroke`. To bazowy budulec klawiszy,
knoba, klawiatury.

**`MicGrille`** — rząd kropek grille mikrofonu jako jeden `Svg`:
```ts
MicGrille({ width, rows=1, pitch=8, r=1.75 })
```
Każda kropka `fill=url(#dotFill from gradient.darkSurface)`, `stroke=url(#dotStroke from
t.recessedBevel)`. Konwencja odwrócona (ciemno L-góra → jasno P-dół = wklęsły otwór).
`gradientUnits=objectBoundingBox` → każda kropka ma własny gradient.

---

## 2. Obudowa — `components/chrome/DeviceShell.tsx`

Publiczny komponent całej ramy. Wewnętrzny render robi `Body`.

```ts
DeviceShell({
  variant?: 'device' | 'fullscreen';   // 'device'
  recording?: boolean; muted?: boolean;
  theme?: ThemeName;                    // 'LIGHT' → wstrzykiwany do ThemeProvider
  motion?: boolean;                     // false → włącza parallax (useTilt)
  keyboard?: KeyboardConfig;
  slider?: SliderConfig;
  hideControls?: boolean;               // czat: dolna sekcja chowa się pod klawiaturę systemową
  onPinch?: (dir:'in'|'out') => void;
  children?: ReactNode;                 // treść aplikacji = „ekran"
})
```

### Drzewo / warstwy (od spodu do wierzchu w `Body`)

```
body  (BlinkProvider active=recording, TiltProvider value={tx,ty})
 ├─ Metal bazowy      LinearGradient bodyMetal, inset:0
 ├─ Tekstura brushed-metal  (opis niżej)
 ├─ UpperMic          (onLayout → micH)   logo+grille+dioda REC | fullscreen: pas statusbara
 ├─ Display (flex:1)  (onLayout → screenH) ← <Display>{children}</Display>
 ├─ Dolna sekcja      SeekSlider + Keyboard + LowerMic
 └─ Bevel obudowy     (rysowany na końcu, absolutne linie/ramki nad wszystkim)
```

Dwa warianty:
- **device**: `View bg:'#000000'` (pełna czerń za urządzeniem) → `padding:8` (margines wokół
  gadżetu) → `Body` z zaokrąglonymi rogami (`bodyRadius`).
- **fullscreen**: edge-to-edge, tło `gradient.appBg` pod status bar, kwadratowe rogi, górny pas
  „mic" dostaje wysokość status bara.

### Bevel obudowy — konwencja światła

Kolory z tokenu (theme-robust): `CASING_BEVEL_LIGHT = rgba(255,255,255,0.25)`,
`CASING_BEVEL_SHADOW = rgba(33,33,33,0.25)`.

- **Recess ekranu (wpuszczony ekran) — w OBU wariantach:** linia 1px CIENIA nad ekranem
  (`top: micH`), linia 1px ŚWIATŁA pod ekranem (`top: micH + screenH - 1`). Cień u góry +
  światło u dołu = wrażenie zagłębienia.
- **Boki + rogi — tylko device:** górna sekcja: `borderTop/Left = LIGHT`, `borderRight = SHADOW`
  (światło L-góra); dolna sekcja: `borderRight/Bottom = SHADOW` (cień P-dół). Środek (ekran) bez
  bocznych obrysów → ekran edge-to-edge, bevel widać na bokach obudowy.

### Tekstura brushed-metal

- Asset: `assets/figma/body_texture.png`.
- **Gotcha RNW**: NIE `Image` bezpośrednio (RNW nadaje intrinsic height i psuje `bottom:0`).
  Struktura = **wrapper `Animated.View`** rozciągnięty (`top:0, bottom:0`) z `Image` w środku
  (`width/height:'100%'`, `resizeMode:'cover'`).
- **Siła/blend**: `opacity: 0.5` + `mixBlendMode:'overlay'` NA WRAPPERZE (nie na dziecku — bo
  wrapper ma transform=stacking context; blend na dziecku byłby izolowany do wnętrza wrappera).
- **Overscan** `left:-24, right:-24` (zapas > przesuwu parallaxu ±16).
- **Parallax**: `translateX = tx.interpolate([-1,1]→[-16,16])`. Tylko poziomo.

### Gesty + pomiar

- Pinch (`PanResponder`, 2 palce): `ratio>1.25` → `onPinch('out')` (fullscreen), `<0.8` →
  `onPinch('in')` (device). Web: `wheel + ctrlKey`, throttle 500 ms.
- `micH`/`screenH` z `onLayout`; `kbH` z nasłuchu `RNKeyboard` (tryb czatu — dolna sekcja
  przyjmuje wysokość systemowej klawiatury, gdy `hideControls`).

---

## 2b. Tryb device ↔ fullscreen i jego przełączanie

Dwa warianty prezentacji tego samego urządzenia (`type Variant = 'device' | 'fullscreen'`):

- **device** — „gadżet": obudowa-urządzenie z marginesem, zaokrąglonymi rogami (`bodyRadius`),
  pełnymi bocznymi bevelami. Leży POD systemowym paskiem statusu (jest miejsce nad nim).
- **fullscreen** — edge-to-edge: kwadratowe rogi, BEZ bocznych beveli, tło `gradient.appBg`
  sięga pod status bar. Domyślny wariant (VIEW = FULLSCREEN).

### Co decyduje o wariancie (`App.tsx`)

```ts
const variant = settings.fullscreen || chatTyping ? 'fullscreen' : 'device';
```
Dwa źródła:
1. **Ustawienie użytkownika VIEW** (`settings.fullscreen`) — patrz niżej.
2. **Wymuszenie przez tryb pisania w czacie** (`chatTyping`): pisanie w czacie zawsze przechodzi
   w fullscreen + chowa dolną obudowę (`hideControls={chatTyping}` → slider/klawiatura/mic
   zwijają się pod systemową klawiaturę). Po wyjściu z pisania wraca ustawienie użytkownika.

### Źródło prawdy i persystencja — VIEW w Settings

To zwykły wiersz ustawień (sekcja OTHER), więc trzyma się tą samą drogą co reszta (AsyncStorage,
`recai.settings.v1`, mapa `label→value`):
```ts
{ label:'VIEW', options:['DEVICE','FULLSCREEN'], value:1 }   // domyślnie FULLSCREEN
```
`useSettingsScreen` wyprowadza z tego bool i publikuje setter:
```ts
const viewItem = flat.find(it => it.label === 'VIEW');
const fullscreen = viewItem ? viewItem.options[viewItem.value] === 'FULLSCREEN' : false;
// setFullscreen ustawia VIEW wprost — trzyma synchronizację przełącznika z gestem pinch:
const setFullscreen = (on:boolean) => /* set VIEW.value = on ? 1 : 0 */;
// hook zwraca m.in.: { ..., fullscreen, setFullscreen }
```

### Przełączanie gestem pinch (dwukierunkowa synchronizacja)

`DeviceShell` wykrywa pinch i woła `onPinch(dir)`; `App` mapuje to na `setFullscreen`, co zmienia
wiersz VIEW — więc **gest i przełącznik w ustawieniach są zawsze zsynchronizowane** (pinch
faktycznie przestawia opcję w Settings, nie osobny stan):
```ts
onPinch={(dir) => settings.setFullscreen(dir === 'out')}   // App.tsx
```
- Natywnie (`PanResponder`, 2 palce): rozsunięcie → `onPinch('out')` = fullscreen; zsunięcie →
  `onPinch('in')` = device.
- Web (trackpad): pinch = `wheel` z `ctrlKey`; `deltaY<0` (rozsuwanie) → 'out', `>0` → 'in',
  throttle 500 ms.

### Różnice renderu między wariantami

**W `DeviceShell`:**
- device: `View bg:'#000000'` → `padding:8` (margines gadżetu) → `Body` z `radius` (rogi
  `bodyRadius`), pełne boczne bevele (`variant === 'device' &&` sekcja boków/rogów).
- fullscreen: `LinearGradient gradient.appBg` sięgające pod status bar, kwadratowe rogi, BEZ
  bocznych beveli (tylko linie recess ekranu zostają — guard tylko na `screenH`, bo w fullscreen
  na web `micH=0`).

**Górny pas „mic" (`Mic.tsx UpperMic`, prop `variant`):**
- device: logo + grille + dioda REC.
- fullscreen: **pusty cienki pas o wysokości status bara** (`Platform.OS==='android' ?
  RNStatusBar.currentHeight : 0`), leżący ZA ikonami status bara (oś Z) — dzięki czemu treść
  ekranu startuje tuż pod ikonami systemowymi. Web/iOS: 0.

**Warstwa zewnętrzna w `App.tsx`:**
```ts
// device pod paskiem statusu (odstęp z zewnątrz); fullscreen — odstęp robi DeviceShell wewnątrz
const topInset = Platform.OS==='android' && variant==='device' ? RNStatusBar.currentHeight||0 : 0;
const barStyle = themes[settings.theme].casingDark ? 'light' : 'dark';   // kolor ikon status bara wg motywu
// <StatusBar style={barStyle} /> na końcu; RNStatusBar przezroczysty, treść pod spodem
```
`barStyle` (jasne/ciemne ikony systemowe) wynika z `casingDark` motywu — spójne w obu wariantach.
Podgląd web skaluje całe 390×844 do okna (`webScale`), niezależnie od wariantu.

### Ściąga
- Wariant = `fullscreen` gdy `settings.fullscreen || chatTyping`, inaczej `device`.
- Źródło prawdy VIEW: wiersz Settings (`['DEVICE','FULLSCREEN']`, domyślnie FULLSCREEN),
  persystowany w AsyncStorage; `setFullscreen` przestawia go wprost.
- Pinch ↔ przełącznik zsynchronizowane (pinch → `setFullscreen` → VIEW).
- fullscreen = edge-to-edge, kwadratowe rogi, bez boków, pusty pas = wysokość status bara ZA
  ikonami; device = margines, zaokrąglenia, pełne bevele, `topInset` = status bar z zewnątrz.
- Czat (pisanie) wymusza fullscreen + `hideControls` (zwinięta dolna obudowa).

---

## 3. Ekran — `Display.tsx` + `ScreenMatrix.tsx` + `ScreenChrome.tsx`

### 3a. `Display` — szyba + slot (minimalne API)

```ts
Display({ children?: ReactNode })   // jedyny prop = treść trybu
```
Warstwy (kolejność Z):
1. **screen_frame** — zewnętrzny `LinearGradient gradient.darkSurface` (`#1A1A1A→#212121` 135°),
   `padding: 2` = ciemna ramka.
2. **screen (szyba)** — `bg:'#1A1A1A'`, `borderRadius:4`, `overflow:'hidden'`,
   `boxShadow: 'inset 0 0 12px rgba(255,255,255,0.05)'` (wrażenie zagłębienia).
3. **SLOT** — `position:'absolute', inset:0, padding:16, gap:16` → tu `{children}`. `gap:16`
   układa treść trybu w pionowy stos (topbar / content / bottombar).
4. **ScreenMatrix** — matryca punktowa nad treścią.
5. **Sheen** (połysk) + **Glow** (poświata) — zawsze na wierzchu, `pointerEvents:'none'`.

Reakcja na tilt:
- **Sheen**: `LinearGradient screenSheen` (`rgba(255,255,255,0.5)→rgba(153,153,153,0)`),
  `translateX ±44`, `opacity` 0.16 (spoczynek) → 0.34 (pełne wychylenie), overscan ±56.
- **Glow**: SVG `RadialGradient`, środek `cx:22% cy:14% r:80%` (lewy-górny róg), `#FFFFFF`
  0.28→0, `translateX ±18 / translateY ±10`, `opacity` rośnie z magnitudą: 0.45 (spoczynek) →
  1.0, overscan −24.

### 3b. `ScreenMatrix` — matryca punktowa (kafelkowany PNG, nie generowana siatka)

```ts
ScreenMatrix({ radius?: number })
```
- Asset `assets/figma/screen_matrix.png` (ciemne piksele ~10–25% + przezroczyste oczka),
  `resizeMode:'repeat'`, kafel 16px.
- Trik skalowania: `Image` powiększony do 400% (`100/SCALE %`, `SCALE=0.25`) + `transform:
  [{scale:0.25}]`, `transformOrigin:'top left'` → kafel docelowego rozmiaru bez zmiany gęstości.
- Kontener absolutny, `overflow:'hidden'`, `pointerEvents:'none'`.
- **Do portu potrzebny sam PNG** (jedyna binarna zależność) albo wygenerować teksturę 16px.

### 3c. `ScreenChrome.tsx` — spięcie ekranu z trybem + wskaźniki

Tryby:
```ts
type Mode = 'RECORDING' | 'PLAYBACK' | 'SETTINGS';
const NEXT = { RECORDING:'PLAYBACK', PLAYBACK:'SETTINGS', SETTINGS:'RECORDING' };
export const nextMode = (m) => NEXT[m];
```
Przełącznik trybu = „zakamuflowana" pigułka wyglądająca jak label — tap cykluje tryb.

Każdy ekran buduje `content` jako fragment: `<ScreenTopBar/>` → obszar treści (`flex:1`) →
`<BottomBar/>`. `gap:16` ze slotu Display rozdziela te trzy pasy.

Komponenty chrome (wszystkie kolory z `screen.olive`/`screen.red`, fosfor + glow):
- **`ScreenTopBar`** = `DeApiLabel` (lewo) + `ScreenLabel` (prawo, pigułka trybu).
- **`ScreenLabel`** (pigułka): `active` = pełne tło fosfor + glow; nieaktywny = tło 25%;
  `blink` = przełącza Active↔Inactive w rytm `useBlink`. RECORDING → czerwona z kropką „REC";
  reszta → olive z nazwą trybu. Ciemny napis (`#212121`) na jasnej pigułce. Haptyka press/release.
- **`DeApiLabel`** (status AI): ikona + do 2 linii tekstu (Inter 10, fosfor + glow). `pulse`
  (upload/processing) → animacja opacity ikony 1↔0.6 700 ms. **Kolor ZAWSZE fosfor, nigdy
  czerwony** (status AI nie alarmuje).
- **`BottomBar`** (miernik stereo): `[L segmenty][badge L] … MONO/STEREO+HQ/MQ … [badge R][R
  segmenty]`, 6 segmentów `MeterBar` 8×12 r2, refresh 120 ms (`level` 0..1 → round×6; null →
  mock losowy; `!active` → zero). `ChannelBadge L/R` 12×12 fosfor z glow.
- **`phosphorGlow`** helper: `textShadowColor: rgba(226,255,228,0.25), radius:4`.
- **`stopBackKey({canStop,onStop,onBack})`** — konfig lewego METALOWEGO klawisza (patrz §4).

Dioda REC na obudowie (`Mic.tsx`): `ledOn = recording && (muted || blinkOn)` — miga tym samym
`useBlink` co pigułka REC, w mute świeci statycznie.

---

## 4. Klawiatura kontekstowa — `Keyboard.tsx` + `KeyButton.tsx`

Fizyczna metafora: siatka **2 rzędy × 3 klawisze**. Górny = klawisze „screen" (ciemna szyba,
zmieniają treść/akcje ekranu), dolny = klawisze „metal" (jasny metal, transport). Sterowane
DANYMI — ekran zwraca `KeyboardConfig`, `Keyboard` go renderuje.

### 4a. Kontrakt (typy — serce kontekstowości)

```ts
type ScreenKeyDef = { label; supporting?; variant?; onPress?; onLongPress?;
                      onHoldComplete?; onHoldStart?; holdMs?; progress? };
type MetalKeyDef =
  | { type:'label'; upper; lower?; active?; lowerActive?; onPress? }
  | { type:'record'; onPress? };
type KeyboardConfig = { screen: ScreenKeyDef[]; metal: MetalKeyDef[] };
const EMPTY_KEYBOARD = { screen:[], metal:[] };
```

### 4b. Klawisze EKRANOWE (górny rząd) — `ScreenKey`

```ts
ScreenKey({ label, supporting?, variant='default', onPress?, onLongPress?,
            onHoldComplete?, onHoldStart?, holdMs=2000, progress? })
```
Warstwy (surface `'screen'`): `Bevel` (`keyScreenStroke`, radius 4) → `tile` (miska 60×60,
`dish` wklęsła/wypukła) → `ScreenMatrix` → `ScreenSheen` (połysk z tiltu) → `ClickedDim`
(nakładka wciśnięcia, tylko gdy `pressed`, `rgba(26,26,26,0.25)` + inset).

Warianty (`KeyVariant`): `default` (fosfor + glow), `primary` (ciemny tekst na tle fosfor),
`risk` (czerwony — DELETE/ABORT/MUTE), `highRisk` (ciemny na czerwonym).

- `label` Kode Mono Bold 12, wyśrodkowany; `supporting` drugi wiersz Kode Mono 10 (`[HOLD]`,
  `[CYCLE]`, `[CLOSE]`).
- **Hold z pierścieniem postępu**: gdy `onHoldComplete` — `Animated.Value` 0→1 przez `holdMs`,
  rysowany przez `ProgressRing` (SVG). Puszczenie przed końcem → wraca do 0 + `hapticCancel()`.
  Klawisz może mieć JEDNOCZEŚNIE `onPress` (tap) i `onHoldComplete` (hold) — np. DELETE (tap =
  prompt, hold = usuń). Flaga `completed.current` pomija `onPress` po ukończonym holdzie.
- `progress` (statyczny pierścień, `StaticRing`) — niezależny od holdu, np. bieg prędkości na
  klawiszu SPEED.
- Pusty `{ label:'' }` = klawisz-widmo (dish + wibracje, bez akcji).

### 4c. Klawisze METALOWE (dolny rząd) — **zawsze 3 sloty**

```ts
MetalLabelKey({ upper, lower?, active=true, lowerActive=false, onPress? })   // surface 'metal', Bevel raisedBevel, fill t.metal
RecordKey({ onPress? })   // dish 'elevation', czerwona dioda 16×16
```
Podświetlenie: napis aktywny → `t.buttonActive` (`#FFFFFF`) + white glow; wygaszony →
`t.buttonInactive` (`#898989`) bez glow. `active`/`lowerActive` sterują górnym/dolnym napisem
niezależnie (np. PLAY vs PAUSE).

**Konwencja stałych labeli** — helper w `ScreenChrome.tsx`:
```ts
stopBackKey({ canStop?, onStop?, onBack? }) => ({
  type:'label', upper:'STOP', lower:'BACK',
  active: canStop,                      // STOP świeci gdy jest co zatrzymać
  lowerActive: !canStop && !!onBack,    // BACK świeci gdy dostępny powrót
  onPress: canStop ? onStop : onBack,
})
```
Trzy sloty na KAŻDYM ekranie, labele nadrukowane na stałe:
- `metal[0]` = **STOP/BACK** (`stopBackKey`)
- `metal[1]` = **RECORD** (`type:'record'`, dioda)
- `metal[2]` = **PLAY/PAUSE**

| Ekran/stan | metal[0] STOP/BACK | metal[1] RECORD | metal[2] PLAY/PAUSE |
|---|---|---|---|
| Recording READY | oba zgaszone | `start` | nieaktywny |
| Recording RECORDING | STOP → `stop` | `pause` | nieaktywny |
| Recording SAVED | zgaszony | `start` | aktywny → open w playerze |
| Playback (gra) | STOP → `playerStop` | `onStartRecording` | PAUSE → `playerPlayPause` |
| Playback (stop) | BACK → `backToList` | ⏺ | PLAY aktywny |
| Settings | BACK → `onClose` | record (bez akcji) | nieaktywny |

### 4d. Układ — `Keyboard`

```ts
Keyboard({ config })
```
Kontener `Bevel` (`recessedBevel`, `fillGradient: gradient.keyboard` `#000→#1B1B1B`, radius 6),
dwa `Row` (flexrow, center, `gap:2`): górny `config.screen.map(ScreenKey)`, dolny
`config.metal.map(MetalKey)`.

**Reużywalność-gotcha**: `key={`${i}:${k.label}`}` — zmiana klawisza w slocie REMONTUJE go, żeby
cleanup wyczyścił hold-timer (inaczej `[HOLD]` mógłby „wypalić" po nawigacji między ekranami).

### 4e. Łamanie długich labeli (dywiz)

Labele > 76 px łamane RĘCZNIE twardym `-\n` (nie soft-hyphen). Klawisz `textAlign:'center'`, obie
linie wyśrodkowane. Przykłady: `'RECORD-\nINGS'`, `'TRANS-\nCRIBE'`, `'ASK\nAI'` (bez dywizu),
dynamiczne `` `${speed}X\nSPEED` ``. W Settings słownik:
```ts
const KEY_WRAP = { REMAINING:'REMAIN-\nING', FULLSCREEN:'FULL-\nSCREEN',
                   'SYSTEM DEFAULT':'SYSTEM\nDEFAULT' };
```

---

## 5. Knob / Slider — `components/chrome/SeekSlider.tsx`

**UWAGA: mimo nazwy „knob" to NIE pokrętło obrotowe** — to **poziomy shuttle** (`translateX`)
sprężynujący do środka (pozycja 0) po puszczeniu, jak jog/shuttle na sprzęcie audio. Layout:
`[◀ SeekButton] [10X◀] [—— groove z knobem ——] [▶10X] [SeekButton ▶]`.

Wizualnie: metalowy prostokąt 64×20 z **trzema pionowymi liniami uchwytu** (`.map([0,1,2])`), na
wypukłym bevelu (`raisedBevel`, fill `t.metal`) z `knobShadow`; pod nim ciemny wklęsły `groove`
(4px, `recessedBevel` + `sliderGroove`).

Gest (`PanResponder`): aktywacja gdy `|dx|>4`; `clamped = clamp(dx, ±max)`, `tx.setValue`,
`ratio = clamped/max` (−1..1); puszczenie → `Animated.spring(tx→0)` + haptyka powrotu.
`maxTravel = (trackW - knob.width)/2` (od środka do krawędzi w każdą stronę).

**API to kontroler WZGLĘDNY/inkrementalny — brak `value/min/max`.** Stan wartości trzyma
ekran-hook, nie slider.
```ts
type SliderConfig = {
  highlighted?: boolean;   // aktywny na tym ekranie (jasne ikony) vs przygaszony
  discrete?: boolean;      // krok ±1 po przekroczeniu 10% wychylenia, jeden impuls
  onPrev?: () => void;     // przycisk ◀
  onNext?: () => void;     // przycisk ▶
  onAdjust?: (dir:-1|1) => void;   // knob discrete/ciągły
  onScrub?: (rate:number) => void; // ciągły scrub, rate −1..1, co ~100 ms
  onScrubEnd?: () => void;
};
```
Trzy tryby pracy:
1. **discrete** (Settings, Listy): po przekroczeniu 10% wychylenia `onAdjust(±1)` RAZ (bez
   narastania), pojedynczy `hapticKnob`.
2. **ciągły adjust** (stały próg 16px): haptyka narasta co 45 ms proporcjonalnie do wychylenia.
3. **scrub** (Player): dopóki trzymany, `onScrub(ratio)` co 100 ms; `onScrubEnd` na puszczenie
   (audio pauzowane na czas scrubu; kwantyzacja prędkości np. `[0,2.5,5,7.5,10]`).

Bez configu → wariant nieaktywny (przygaszony, sprężynuje bez efektu).

---

## 6. Settings — `screens/SettingsScreen.tsx`

### Model danych — **cykliczny wybór opcji** (nie toggle, nie segment)

```ts
type Item = { label:string; options:string[]; value:number; locked?:boolean; action?:boolean; hints?:string[] };
type SectionData = { header:string; items:Item[] };
```
Każdy wiersz ma tablicę `options` i indeks `value`; zmiana = `(value + dir + n) % n`. ON/OFF to
po prostu `options:['OFF','ON']`. Sekcje: RECORDING / PLAYBACK / OTHER (THEME, UI LANGUAGE, VIEW
device/fullscreen, MOTION, HANDED right/left, INFO jako `action:true`).

### Wiersz — `Row`

Etykieta mono (lewo, `flex:1`) + wartość (większy font, prawo) w jednym `Pressable`. Stany:
`selected` → tło fosfor + ciemny tekst (bez glow); niezaznaczony → fosfor + `phosphorGlow`;
`locked` → wartość w `screen.olive.inactive` (np. wymuszone MONO). **Kontrolki NIE mają
fizycznych beveli** — to warstwa „wyświetlacza" (fosfor na ciemnym). Skeuomorfizm fizyczny jest
w obudowie/klawiszach/sliderze.

Nawigacja: `selected` = indeks w SPŁASZCZONEJ liście; `move(dir)` z zawijaniem; tap w wiersz
zaznacza i cyklą; knob/CHANGE → `changeBy`; wiersz `action` (INFO) otwiera `InfoDialog`.
Auto-scroll trzyma zaznaczony wiersz w widoku (lookahead góra 64 / dół 44 px).

### Persystencja — AsyncStorage (NIE kontekst, NIE globalny store)

- Klucz `'recai.settings.v1'`, `@react-native-async-storage/async-storage` (web → localStorage).
- Stan lokalny `useState<SectionData[]>`; hydratacja po starcie (mapa `label→value`, walidacja
  `!locked`/integer/zakres); zapis przy każdej zmianie (po hydratacji) jako mapa `label→value`.

### Wyjście hooka

`useSettingsScreen` zwraca `{ content, keyboard, slider }` PLUS wyprowadzone wartości ustawień
(`theme, motion, fullscreen, leftHanded, autoTranscribe, recordMono, recordQuality, language,
uiLang, showTimeLeft, keepScreenOn, ...`) — czytane po labelu, by `App` sterował obudową (motyw,
fullscreen, motion, left-handed). Kontekstowy klawisz #1 dynamicznie pokazuje NASTĘPNĄ wartość
opcji (TURN ON/OFF, nazwa opcji, `keyWrap`).

---

## 7. Listy — `hooks/useRecordings.ts` + widok w `PlaybackScreen.tsx`

### Store — `useRecordings` (hook + SQLite/AsyncStorage, NIE Context/Redux)

Stan `useState<Rec[]>`, trwałość: **SQLite natywnie, AsyncStorage na web** (`lib/db`,
`.web.ts` split). UI aktualizuje się natychmiast (pamięć), zapis w tle przez kolejkę `dbQueue`.
```ts
type RecordingsStore = { recordings:Rec[]; add; removeById; insertAt; update };
add(r)              // sortOrder = ++maxOrder → na górę: [rec, ...prev]
removeById(id)      // plik audio kasowany LENIWIE (GC przy starcie) → UNDO działa
insertAt(r, index)  // UNDO: splice na dawną pozycję
update(id, patch)   // np. { title, transcribed } po transkrypcji
```
Sortowanie: nowe na górze (`sortOrder` malejąco). Przy starcie: `loadRecordings` +
`cleanupOrphanFiles`. `Rec = { id, uri?, title?, date, lengthSec, sizeBytes?, seq?, samples?,
transcribed, sortOrder? }` (`uri` obecne = realny plik; brak = demo/mock).

### Render — `ScrollView` + `.map` (NIE FlatList)

Lista krótka + potrzebny precyzyjny auto-scroll (`measureLayout`), więc `<ScrollView>` z
`recs.map(<Row/>)`, `innerRef` rejestruje węzły w `Map id→View` do auto-scrolla.

### Wiersz — `Row`

`{ rec, name, selected, onSelect, options:RowActionDef[], focus, innerRef }`. Układ:
`[AiBadge] nazwa(numberOfLines=1, flex:1) … data`. `selected` → tło fosfor + ciemny tekst +
glow, rozwija POD nazwą inline rząd opcji menu. `rec.transcribed` steruje kolorem badge AI. Web:
`onHoverIn={onSelect}`. Tytuł: jeśli `transcribed && title` → tytuł AI, inaczej
`genericName(date, seq)` (np. `10_06_26_REC01`).

### Menu kontekstowe / akcje — `RowActionDef` + inline pills

```ts
type RowActionDef = { label; run; risk?; keyLabel?; supporting?; onHoldComplete?; holdMs? };
```
`menuOptions` budowane dynamicznie wg stanu zaznaczonego nagrania:
- `uri && !transcribed` → **TRANSCRIBE**
- `uri && transcribed` → **ASK AI** (przejście do CHAT)
- `uri` → **SHARE** (`expo-sharing` `Sharing.shareAsync`)
- **DETAILS** (`keyLabel:'SHOW DETAILS'`) → `DetailsPanel` (NAME/DATE/LENGTH/SIZE/AI)
- **DELETE** (`risk:true, supporting:'[HOLD]', onHoldComplete:confirmDelete, holdMs:2000`)

Render `RowOption`: aktywna opcja (i===focus) = ciemna pigułka z „•" + glow; `risk` → czerwień.
Cyklowanie: `cycleMenu` (knob discrete lub klawisz MENU `[CYCLE]`). Aktywna opcja „odbija się" na
klawiszu akcji (`actionKey`, wariant highRisk/hold dla risk).

### Usuwanie z UNDO — maszyna stanów `phase`

`Phase = 'LIST'|'CONFIRM'|'DELETED'|'DETAILS'`. `confirmDelete` zapamiętuje
`lastDeleted={rec,index,name}`, `removeById`, → DELETED z auto-dismiss 3 s; `undo` →
`insertAt(rec, index)`. Klawisz UNDO hold 1000 ms (krótszy niż DELETE 2000 ms). Pusta lista →
komunikat + tylko SETTINGS aktywny.

---

## 8. Wzorzec kontekstowości + kompozytor w `App.tsx`

Każdy ekran to hook zwracający spójny kształt:
- `useRecordingScreen` → `{ content, keyboard, ... }` (bez slidera — w nagrywaniu nieaktywny)
- `usePlaybackScreen` → `{ content, keyboard, slider, goBack }`
- `useSettingsScreen` → `{ content, keyboard, slider, + wartości ustawień }`

`App.tsx` składa to tak (kolejność ważna):
1. **Wszystkie hooki zawsze zamontowane** (reguły hooków + zachowanie stanu między trybami).
2. Wybór wg `mode` → `content` + `baseKeyboard`.
3. **Left-handed**: zamiana `screen[0]↔screen[2]` gdy `leftHanded && screen.length>=3`.
4. **Override RECORD poza nagrywaniem**: w trybach ≠ RECORDING klawisz `type:'record'` BEZ
   własnego `onPress` dostaje `onPress:()=>setMode('RECORDING')` (jeśli ekran nie nadał własnej
   akcji, np. czat: ⏺ = nagraj pytanie).
5. **Slider**: `SETTINGS ? settings.slider : PLAYBACK ? playback.slider : undefined`.
6. **Onboarding**: `showWelcome` podmienia keyboard/slider na `welcome.*`.
7. Do `DeviceShell`: `keyboard={finalKeyboard} slider={slider} theme={settings.theme}
   motion={settings.motion} variant={fullscreen?'fullscreen':'device'}`.

Back systemowy (Android): RECORDING ← lista ← playback (przez `stopBackKey`/`goBack`).

---

## 9. Haptyka — `lib/haptics.ts` (samodzielny moduł, w pełni przenośny)

RN `Vibration` / web `navigator.vibrate` znają tylko on/off (ms), więc „moc" symulowana przez
**PWM** (`PERIOD=16 ms`, `pwm(segs)` moduluje duty cycle). Pattern `[on,off,on,...]`; Android
prependuje `0`.
- `hapticPress()=[110]` / `hapticRelease()=[45]` — wejście/zwolnienie aktywnego klawisza.
- `hapticShort()=[45]` — puste/nieaktywne klawisze.
- `hapticHold(ms)` — impulsy co 70 ms, intensywność 0→50% do końca przytrzymania.
- `hapticCancel()` — przerwanie holdu (`Vibration.cancel()`).
- `hapticRecordStart()=[350]` (długi buzz), `hapticRecordStop()=[200,110,200]` (buzz-buzz).
- `hapticKnob(intensity)` / `hapticKnobReturn(active)` — tick slidera (nieaktywny `[45]`,
  aktywny `[28,50,28]`).
- `hapticContinuous(on)` — ciągła na granicy nagrania.

Wywołania w `KeyButton.handlePressIn/Out`: klawisz z akcją → press/release; pusty → short; hold →
`hapticHold` → `hapticRelease` (ukończenie) / `hapticCancel` (anulowanie); cleanup przy
odmontowaniu → `hapticCancel`.

---

## 10. Checklist przenośności (kolejność portowania do nowego projektu)

Warstwa 0 (fundament, ~1:1, brak zależności UI):
- [ ] `theme/tokens.ts` — kolory, `Gradient`, RAISED/RECESSED, palety motywów, `dims`, `font`,
      cienie. (Wymaga fontów: **Inter** + **Kode Mono**.)
- [ ] `theme/ThemeContext.tsx`, `theme/BlinkContext.tsx`, `theme/TiltContext.tsx`
- [ ] `lib/haptics.ts` (zero zależności)
- [ ] `hooks/useTilt.ts` (natywnie lazy `expo-sensors`; web bez zależności) — opcjonalny

Warstwa 1 (prymitywy wizualne):
- [ ] `components/chrome/primitives.tsx` (`Bevel`, `MicGrille`) — dep: tokens, `react-native-svg`,
      `expo-linear-gradient`
- [ ] Assety binarne: `assets/figma/body_texture.png`, `assets/figma/screen_matrix.png`
      (jedyne, których nie da się odtworzyć z kodu — przenieść pliki)

Warstwa 2 (obudowa + ekran):
- [ ] `DeviceShell.tsx`, `Display.tsx`, `ScreenMatrix.tsx`, `Mic.tsx`
- [ ] `ScreenChrome.tsx` (`Mode`, `nextMode`, `stopBackKey`, top/bottom bar, pigułki)

Warstwa 3 (kontrolki kontekstowe):
- [ ] `Keyboard.tsx` + `KeyButton.tsx` (`ScreenKey`/`MetalLabelKey`/`RecordKey`) + typy
      `KeyboardConfig`
- [ ] `SeekSlider.tsx` + typ `SliderConfig`

Warstwa 4 (wzorzec aplikacji — do zaadaptowania pod nowe ekrany):
- [ ] Kompozytor w `App.tsx`: maszyna trybów, wybór `{content,keyboard,slider}`, left-handed swap,
      override record, onboarding
- [ ] Persystencja: wzorzec AsyncStorage `label→value` (settings) + store `useRecordings`
      (SQLite/AsyncStorage split `.web.ts`) — o ile nowa apka ma listy/ustawienia

### Kluczowe wzory do zapamiętania (ściąga)
- Bevel wypukły: border L-góra `rgba(255,255,255,0.25)`, P-dół `rgba(33,33,33,0.25)`; wklęsły =
  odwrotna kolejność w tokenie.
- Recess ekranu: 1px SHADOW nad, 1px LIGHT pod.
- Rogi obudowy: `bodyRadius {8,8,32,32}` (tl,tr,br,bl).
- Tekstura metalu: `opacity 0.5` + `mixBlendMode:'overlay'` NA WRAPPERZE, overscan ±24, parallax ±16.
- Ekran = slot: `padding:16, gap:16`, wszystkie efekty nad treścią z `pointerEvents:'none'`.
- Fizyczne klawisze: 3 sloty (STOP/BACK, RECORD, PLAY/PAUSE), STAŁE labele, zmienne podświetlenie.
- Knob = poziomy shuttle sprężynujący do 0, API względne (`±1`/`rate`), bez `value/min/max`.
- Kontrakt ekranu: `useXScreen() → { content, keyboard, slider }`; keyboard/slider to DANE, nie JSX.
- Fosfor `#E2FFE4` z glow `rgba(226,255,228,0.25) r4`; ekran niezależny od motywu obudowy.
- Wariant device↔fullscreen: jedno źródło prawdy = wiersz VIEW w Settings; pinch → `setFullscreen`
  synchronizuje gest z przełącznikiem; fullscreen = edge-to-edge bez boków (patrz §2b).

---

## 11. Adaptacja pod skeuomorficzną galerię-aparat z AI (docelowy nowy projekt)

Cel drugiej apki: **galeria zdjęć na Androida** z chrome inspirowanym aparatem cyfrowym
(viewfinder, mode dial, spust migawki), ale nowoczesna w użyciu, mocno customizowalna, z motywami
i funkcjami AI. Poniżej mapowanie: co z rec_ai bierzemy 1:1, co trzeba rozbudować, co jest zupełnie
nowe. To NIE jest plan implementacji — to lista decyzji projektowych do podjęcia na starcie.

### 11a. Przenosi się 1:1 (fundament — portuj bez zmian)
- **Warstwa 0** (§1): `tokens.ts` (konwencja światła RAISED/RECESSED, `dims`, `font`, cienie),
  `ThemeContext`/`BlinkContext`/`TiltContext`, `haptics.ts`, `useTilt`. To jest DNA skeuomorfizmu
  i jest domenowo neutralne.
- **Rama + slot** (§2): `DeviceShell` jako obudowa, ekran jako slot na `children`. Idealnie pasuje
  do „viewfinder w korpusie aparatu".
- **device ↔ fullscreen** (§2b): bez zmian — fullscreen = tryb przeglądania zdjęcia edge-to-edge.
- **Klawiatura kontekstowa + wzorzec `useXScreen → {content,keyboard,slider}` + kompozytor
  `App.tsx`** (§4, §8): rdzeń kontekstowości. Tryby aparatu (BROWSE / VIEWER / EDIT / SETTINGS)
  mapują się na `Mode` dokładnie jak RECORDING/PLAYBACK/SETTINGS.
- **Fizyczne klawisze ze stałym labelem** (§4c): naturalne dla aparatu (SHUTTER, PLAY/DELETE itd.).

### 11b. Wymaga rozbudowy / przemyślenia (rozjazdy względem dyktafonu)

**1. Ekran: 3-stopniowy TRYB WYŚWIETLANIA wybierany przez użytkownika (ZBUDOWANE, zweryfikowane z Figmą).**
Dyktafon ma zielony fosfor + dot-matrix (`ScreenMatrix`, `screen.olive`); galeria pokazuje
zdjęcia. Zamiast jednego kompromisu — **wybór użytkownika w Settings**: wiersz `SCREEN`
(opcje `IMMERSIVE/RETRO/CLEAN`, sekcja VIEWER; persystencja `label→value` jak THEME, §6),
wyprowadzany do `GalleryScreen` jako `displayMode`. Trzy poziomy „ile skeuomorfizmu na treści":

1. **IMMERSIVE** — zdjęcia jako **zielony monochrom**: grayscale + fosfor (na web `filter:grayscale`
   + warstwa fosforu `mix-blend-mode:multiply` na pełnej sile). Matryca + glow/sheen szyby. Maks.
   klimat „vintage viewfinder", kosztem czytelności.
2. **RETRO / HYBRID** — **zdjęcia KOLOROWE + lekki fosforowy tint** (multiply ~0.22 → biele lekko
   zielenieją). Matryca + sheen widać, fotografia trzyma kolor. Kompromis klimat ↔ czytelność.
3. **CLEAN** — **zdjęcia w pełnym kolorze, bez filtra fosforowego**. UWAGA (rozjazd vs poprzednia
   wersja tych notatek; zweryfikowane z Figmą, node `device/folders/clean`): **matryca ZOSTAJE**
   (tak jak w IMMERSIVE/RETRO) — CLEAN gasi TYLKO fosfor na obrazie, nie matrycę. Glow/sheen też zostają.

Wspólne dla wszystkich trzech (chrome nigdy nie znika):
- `ScreenMatrix` (matryca), `Glow`/`Sheen`/inset szyby oraz cały korpus/klawisze/joystick zostają
  zawsze we WSZYSTKICH trzech trybach — tryb steruje WYŁĄCZNIE filtrem fosforowym na zdjęciu
  (monochrom / lekki tint / brak). Podpisy kafli (nazwa+licznik) też pozostają fosforowe zawsze.
- Kolory `olive/red` przenieść z „treści ekranu" na **akcenty HUD/UI** (ramki AF, wskaźniki,
  etykiety statusu) — niezależnie od trybu HUD ma kolor motywu, nie zdjęcia.

Uwaga implementacyjna (ważny rozjazd techniczny): w dyktafonie fosfor to był tylko KOLOR TEKSTU.
Tu trzeba filtrować REALNE zdjęcia (grayscale + tint fosforu). RN nie ma natywnych CSS-filtrów, więc:
- **Native**: filtr przez `@shopify/react-native-skia` (ColorMatrix → desaturacja + tint fosforu na
  `<Image>`/`ColorMatrix`), ewentualnie shader. Matryca dalej jako nakładka PNG (§3b) NAD obrazem.
  STATUS: na razie fallback bez Skia (lekki tint opacity) — do dorobienia.
- **Web (podgląd, ZBUDOWANE)**: `<Image>` z `filter:grayscale()` (tylko IMMERSIVE) + osobna warstwa
  fosforu `mix-blend-mode:multiply` (IMMERSIVE=1.0, RETRO=~0.22, CLEAN=brak). Wynik 1:1 z Figmą.
- Wydajność w siatce miniatur: filtr liczyć na miniaturach, nie na pełnych zdjęciach; rozważyć
  cache przefiltrowanych miniatur per tryb (albo filtr GPU/Skia w locie).
- ScreenMatrix nad zdjęciem: **WŁĄCZONA we wszystkich trzech trybach** (Figma CLEAN też ją ma) —
  tryb różnicuje wyłącznie obróbkę fosforową obrazu, nie warstwę matrycy.

**2. Listy → SIATKA miniatur (to największy rozjazd).**
rec_ai renderuje listę przez `ScrollView + .map` (§7) — świadomie, bo nagrań jest mało.
**Galeria to setki/tysiące zdjęć → to NIE zadziała.** Potrzebne:
- Wirtualizacja: `FlatList numColumns` albo `@shopify/flash-list` (rekomendowane dla dużych
  siatek). Auto-scroll przez `measureLayout` z rec_ia trzeba zastąpić `scrollToIndex`.
- Miniatury + cache (nie ładować pełnych zdjęć do siatki): `expo-image` z cache, generowanie/
  cache thumbnaili.
- Sekcje po dacie (nagłówki jak `SectionHeader`, ale w gridzie — `SectionList` lub grupowanie
  ręczne).
- Store `useRecordings` → `useMedia`: wzorzec zostaje (SQLite natywnie / AsyncStorage web split
  `.web.ts`, kolejka `dbQueue`, `add/removeById/update`), ale indeksem jest biblioteka zdjęć.
  Źródło zdjęć: **`expo-media-library`** (uprawnienia!) + ewentualny import. `Rec` → `MediaItem`
  `{ id, uri, thumbUri?, date, width, height, aiTags?, aiDescribed, ... }`.
- Menu kontekstowe wiersza (§7 `RowActionDef`) → menu kafla (SHARE / DELETE-hold / DETAILS /
  ASK AI / TAG) — wzorzec inline-pills + maszyna `phase` (delete/undo/details) przenosi się.

**3. Knob: liniowy shuttle → prawdopodobnie POKRĘTŁO OBROTOWE (mode dial).**
rec_ai `SeekSlider` to poziomy shuttle sprężynujący do 0 (§5), mimo nazwy „knob". Aparat sugeruje
prawdziwe **rotary dial** (obrót palcem = zmiana trybu/wartości, „klik" co krok). Decyzje:
- Zbudować wariant obrotowy (gest = kąt względem środka, `PanResponder`, haptyka co krok) LUB
  zostać przy shuttle, jeśli w praktyce wygodniejszy kciukiem.
- **Kontrakt `SliderConfig` (względny: `±1` / `rate`, bez `value/min/max`) zostaje** — jest
  agnostyczny wobec tego, czy fizycznie to suwak czy pokrętło. Zmienia się tylko render + gest.
- Spust migawki: `type:'record'` (RecordKey z diodą) → SHUTTER; ta sama mechanika slotu metal.

**4. Motywy: enum → mocna customizacja.**
rec_ia ma 4 sztywne motywy (`ThemeName = 'LIGHT'|'DARK'|'ORANGE'|'NAVY'`, §1a). „Mocno
customizowalny" → decyzje:
- Rozszerzyć z enuma na **motyw parametryczny**: użytkownik ustawia kolor metalu / kolor akcentu /
  jasny-ciemny, a `ThemePalette` liczona jest z tych parametrów (zamiast wybierana z listy).
- Persystencja: wzorzec Settings `label→value` (§6) obsługuje enumy; dla dowolnych kolorów dodać
  zapis wartości hex (rozszerzyć schemat AsyncStorage). Rozważyć osobny „theme editor" jako Mode.
- `casingDark` (jasne/ciemne ikony status bara) liczyć z jasności wybranego metalu.
- Konwencja bevela (półprzezroczyste 25%) jest theme-agnostic → działa dla dowolnego koloru metalu
  bez zmian. To duża zaleta na starcie customizacji.

**5. AI: transkrypcja/czat → operacje na obrazie.**
Wzorzec z rec_ia (backend proxy, per-item status, `DeApiLabel`, badge, kolejka jobów) mapuje się na:
- opis zdjęcia / auto-tagi / OCR / **wyszukiwanie semantyczne** / „zapytaj AI o to zdjęcie".
- Per-kafel badge statusu (jak `AiBadge`), nie-alarmowy (kolor akcentu, nigdy „error-red" na HUD —
  ta sama zasada co „pasek deAPI nigdy czerwony").
- Backend: ten sam kształt (stateless proxy, webhook-driven, `X-App-Key` + rate-limit) — zmienia
  się dostawca modelu (vision zamiast Whisper) i kontrakt endpointu.

### 11c. Zupełnie nowe (nie ma w rec_ai — zaprojektować od zera)
- **Uprawnienia + dostęp do zdjęć**: `expo-media-library` (READ, ewentualnie zapis edycji),
  ekran/onboarding zgody.
- **Pełnoekranowy viewer zdjęcia z gestami**: pinch-zoom, pan, swipe między zdjęciami
  (uwaga: pinch jest już zajęty przez device↔fullscreen — trzeba rozstrzygnąć konflikt gestów,
  np. pinch w viewerze = zoom zdjęcia, a przełączanie obudowy innym gestem lub tylko z Settings).
- **Wirtualizacja + cache miniatur** (patrz 11b.2) — kluczowe dla wydajności.
- **Edycja/filtry** (jeśli w zakresie) — nowy Mode EDIT z własnym `keyboard`/`slider`.

### 11d. Kolejność startu (rekomendacja)
1. Warstwa 0 + rama+slot + device/fullscreen (§1, §2, §2b) — postaw „martwy" korpus z pustym
   ekranem. To daje natychmiast skeuomorficzny szkielet.
2. Kontekstowa klawiatura + kompozytor (§4, §8) z trybami BROWSE/VIEWER/SETTINGS (na sztywnych
   danych mock).
3. Siatka miniatur na `expo-media-library` (nowość 11b.2) — pierwszy realny content.
4. Viewer pełnoekranowy + gesty (11c).
5. Settings + motywy parametryczne (11b.4).
6. AI (11b.5) na końcu — jak w rec_ai, warstwa proxy dokłada się na gotowy UI.
