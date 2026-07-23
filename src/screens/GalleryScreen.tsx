/**
 * GalleryScreen (galeria). Dwa widoki w trybie GALLERY:
 *   • ROOT — siatka FOLDERÓW (okładka + nazwa + licznik), 2/3 kolumny (VIEW), gap 10.
 *   • WNĘTRZE FOLDERU (node 358:5112) — breadcrumb `.../<nazwa>/` + gęsta siatka ZDJĘĆ (bez podpisów,
 *     gap 4, 2/3 kolumny). Joystick press w ROOT = wejdź w folder; tap w breadcrumb / back = wyjdź.
 *
 * Klawiatura: SORTING · PREV · JOYSTICK · NEXT · VIEW (VIEW przełącza gęstość 2↔3 kol.).
 * Tryb wyświetlania (IMMERSIVE/RETRO/CLEAN) = `displayMode` (§11b.1) steruje filtrem okładek/zdjęć.
 * Źródło zdjęć: MOCK (assets/mock) — realne z expo-media-library później.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Platform, FlatList, LayoutChangeEvent, ImageSourcePropType } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { color, font, screen, textShadow, dims } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';
import { MenuBar } from '../components/chrome/MenuBar';
import { ScreenTopBar, Mode, DisplayMode } from './ScreenChrome';
import { useMedia } from '../hooks/useMedia';
import { scrollFlag } from '../components/PerfHud';
import { applyLibraryFilter, momentsFolderIds } from '../hooks/useLibraryFilter';
import { FeedGridHandle, FeedGrid, packFeed } from '../components/FeedGrid';
import { MomentsGrid, MomentsGridHandle } from '../components/MomentsGrid';
import { useImageEditor } from './EditorScreen';
import { MOCK_FOLDERS, type Folder } from './mockFolders';
import { Diag, DIAG_ALL } from '../lib/diag';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFS_KEY = 'gallery_ai:view_prefs'; // zapamiętane preferencje widoku galerii

// MOCK_FOLDERS re-eksportowane dla App (natywnie puste, na web z `mockFolders.web.ts`)
export { MOCK_FOLDERS };
export type { Folder };

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;
const redGlow = {
  textShadowColor: 'rgba(255,76,76,0.25)',
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

// web = placeholdery (projektowanie); natywnie/APK = realne media z expo-media-library (bez mocków)
export const DESIGN = Platform.OS === 'web';

// STABILNA pusta referencja — bez niej `media.folders ?? []` dawałoby nową tablicę co render,
// a że `folders` jest zależnością efektu → nieskończona pętla re-renderów (dławiła wątek JS na urządzeniu).
export const EMPTY_FOLDERS: Folder[] = [];

// Kafel = ZWYKŁY obraz (bez isolation/mixBlendMode/boxShadow per-kafel). Filtr trybu (monochrom/fosfor)
// nakładany JEDEN raz nad całą siatką (patrz ScreenFilter) — kilkadziesiąt offscreenów per-kafel było
// przyczyną migotliwego janku na granicy GPU. `selected` = obrys.
/**
 * Etykiety miniatury (Figma 426:7196): „AI" (ingerencja AI) i „RAW" (format) w prawym-górnym rogu.
 * Fosforowy tekst z ciemną obwódką (textShadow) → czytelny nad jasnymi zdjęciami. Tylko gdy dana flaga zachodzi.
 */
function ThumbBadges({ ai, raw }: { ai?: boolean; raw?: boolean }) {
  if (!ai && !raw) return null;
  const badge = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.primary, textShadowColor: color.dark21, textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } } as const;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 6, right: 8, flexDirection: 'row', gap: 6 }}>
      {ai ? <Text style={badge}>AI</Text> : null}
      {raw ? <Text style={badge}>RAW</Text> : null}
    </View>
  );
}

/**
 * usePhotoAi — czy zdjęcie ma ingerencję AI. W SIATCE tylko lokalny tag (sync, ZERO I/O).
 * ⚠️ PERF: wykrywanie AI z metadanych (IPTC/C2PA) = odczyt+dekodowanie nagłówka pliku per kafel → synchroniczny
 * `b64ToStr` blokował wątek JS = „prawie zero FPS" przy siatce. Prowieniencja z metadanych żyje TYLKO w panelu
 * INFO (pojedynczy, otwarty obraz), nie per-miniatura. (patrz pamięć: getassetinfo-copies-files-perf)
 */
function usePhotoAi(source?: ImageSourcePropType): boolean {
  return !!(source as any)?.ai;
}

// Checkbox trybu zaznaczania (Figma 460:2831) — kwadracik w LEWYM-górnym rogu (badge'y RAW/AI są w prawym).
// Zaznaczony = wypełniony fosforem z „✓"; niezaznaczony = pusta ramka na półprzezroczystym tle (czytelny nad zdjęciem).
function TileCheck({ on }: { on: boolean }) {
  // Checkbox bez ptaszka (Figma 450:1861): niezaznaczony = wypełniony fosforem, ZAZNACZONY = ciemny.
  // Ramka fosforowa w obu stanach, więc pozycja i rozmiar nie skaczą przy przełączaniu.
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, borderRadius: 3, borderWidth: 2, borderColor: screen.olive.primary, backgroundColor: on ? color.dark21 : screen.olive.primary }}
    />
  );
}

function PhosphorCover({ source, size, selected, images = true, ai: aiProp, badges = true, check, danger }: { source?: ImageSourcePropType; size: number; selected?: boolean; images?: boolean; ai?: boolean; badges?: boolean; check?: boolean | null; danger?: boolean }) {
  const raw = !!(source as any)?.raw; // flaga RAW doklejona do źródła (useMedia)
  const ai = aiProp ?? !!(source as any)?.ai;
  // Zaznaczenie = PODWÓJNY obrys (fig 337:6150 strokes=[#E2FFE4,#1A1A1A]) — OBIE ramki WEWNĘTRZNE (inset na tej
  // samej krawędzi, nakładają się na zdjęcie): czarna 3px pod spodem, fosforowa 2px na wierzchu ją przykrywa →
  // widać fosfor 2px (na ciemnym tle) + wewn. 1px czarnej (kontrast przy JASNYCH zdjęciach; sam jasny obrys ginął).
  // Glow per-kafel świadomie pominięty (decyzja perf — patrz gallery-matrix-repeat-perf).
  const overlay = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2 };
  return (
    <View style={{ width: '100%', height: size, borderRadius: 2, overflow: 'hidden' }}>
      {/* DIAG images=false → zwykłe kolorowe View zamiast expo-image (bisect: dekodowanie/render obrazów) */}
      {!images ? (
        <View style={{ width: '100%', height: '100%', backgroundColor: '#3A3A3A' }} />
      ) : source ? (
        <ExpoImage source={source} contentFit="cover" cachePolicy="memory-disk" style={{ width: '100%', height: '100%' }} />
      ) : null}
      {selected ? (
        <>
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 3, borderColor: color.dark1A }} />
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 2, borderColor: danger ? screen.red.primary : screen.olive.primary }} />
        </>
      ) : null}
      {badges && images && source ? <ThumbBadges ai={ai} raw={raw} /> : null}
      {check != null ? <TileCheck on={check} /> : null}
    </View>
  );
}

/**
 * Filtr EKRANOWY (§11b.1) — jedna nakładka nad siatką zamiast N per-kafel:
 *   IMMERSIVE: saturation(szary) → monochrom + multiply(fosfor) → zielony
 *   RETRO:     multiply(fosfor) → lekki zielony tint (fosfor ≈ biel)
 *   CLEAN:     brak
 * Wymaga `isolation:'isolate'` na kontenerze siatki, by blend nie sięgał metalu za ekranem.
 */
function ScreenFilter({ displayMode }: { displayMode: DisplayMode }) {
  if (displayMode === 'CLEAN') return null;
  return (
    <>
      {displayMode === 'IMMERSIVE' ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#808080', mixBlendMode: 'saturation' } as any} />
      ) : null}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.phosphor, mixBlendMode: 'multiply' } as any} />
    </>
  );
}

const FolderTile = memo(function FolderTile({ folder, size, selected, images, onPress, onLongPress, check, danger }: { folder: Folder; size: number; selected?: boolean; images?: boolean; onPress?: () => void; onLongPress?: () => void; check?: boolean | null; danger?: boolean }) {
  // wg projektu: nazwa = Mono/Label (bold 12), podkreślona gdy zaznaczona; licznik = Mono/Caption (10).
  // KOSZ (danger) = czerwony label/licznik + czerwony glow, żeby wyróżniał się od zwykłych folderów.
  const glow = danger ? { textShadowColor: screen.red.primary, textShadowRadius: textShadow.phosphor.radius, textShadowOffset: { width: 0, height: 0 } } : phosphorGlow;
  const fg = danger ? screen.red.primary : screen.olive.primary;
  const name = { fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: fg, ...glow } as const;
  const cap = { fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: fg, ...glow } as const;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ width: '100%', gap: 8 }}>
      <PhosphorCover source={folder.cover} size={size} selected={selected} images={images} badges={false} check={check} danger={danger} />
      <View style={{ gap: 4 }}>
        <Text numberOfLines={1} style={[name, selected ? { textDecorationLine: 'underline' } : null]}>{folder.name}</Text>
        {folder.count != null ? (
          <Text style={cap}>{`${folder.count} image${folder.count === 1 ? '' : 's'}`}</Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const PhotoTile = memo(function PhotoTile({ source, size, selected, images, onPress, onLongPress, check }: { source: ImageSourcePropType; size: number; selected?: boolean; images?: boolean; onPress?: () => void; onLongPress?: () => void; check?: boolean | null }) {
  const ai = usePhotoAi(source); // tag lokalny lub metadane (IPTC/C2PA)
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ width: '100%' }}>
      <PhosphorCover source={source} size={size} selected={selected} images={images} ai={ai} check={check} />
    </Pressable>
  );
});

// MENU (node 360:5309) — kontekstowe menu galerii. Popover fosforowy (#E2FFE4) z ciemnym tekstem; zaznaczona
// pozycja = ciemna „pigułka" z zielonym tekstem i bulletem „•". Nawigacja joystick góra/dół + press (lub tap).
const MENU_ITEMS = ['SELECT', 'SORT', 'FILTER MEDIA', 'SHOW HIDDEN ELEMENTS', 'OPEN TRASH BIN', 'SETTINGS'] as const;
// W PODGLĄDZIE menu dotyczy pojedynczego zdjęcia, więc pozycje operujące na LIŚCIE (zaznaczanie,
// sortowanie, filtrowanie, ukrywanie) nie mają tam sensu — zostają tylko te działające zawsze.
const MENU_ITEMS_VIEWER = ['DELETE', 'OPEN TRASH BIN', 'SETTINGS'] as const;
const MENU_RISK = ['DELETE'] as const; // pozycje MENU podświetlane na czerwono po wybraniu

function GalleryMenu({ index, onPick, items = MENU_ITEMS, leftHanded = false, riskLabels }: { index: number; onPick: (i: number) => void; items?: readonly string[]; leftHanded?: boolean; riskLabels?: readonly string[] }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  // popover trzyma się klawisza MENU: domyślnie prawy dolny róg; w trybie left-handed klawiatura jest
  // lustrzana → MENU po lewej, więc i menu po lewej.
  return (
    <View
      style={{ position: 'absolute', ...(leftHanded ? { left: 0 } : { right: 0 }), bottom: 0, padding: 8, gap: 8, borderRadius: 2, backgroundColor: screen.olive.primary, boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any}
    >
      {items.map((label, i) => {
        const sel = i === index;
        // pozycja RYZYKOWNA (DELETE): po WYBRANIU (kursor na niej) tekst i bullet na czerwono
        const risk = !!riskLabels?.includes(label);
        const fg = sel ? (risk ? screen.red.primary : screen.olive.primary) : color.dark21;
        const glowSel = risk ? redGlow : phosphorGlow;
        // Bullet TYLKO przy zaznaczonej pozycji (Figma 360:5309) — i tylko tam przesuwa etykietę w prawo.
        // Niezaznaczone etykiety zaczynają się przy samej krawędzi, na równi z lewym brzegiem pigułki;
        // rezerwowanie miejsca PRZED nimi dałoby wcięcie, którego w projekcie nie ma.
        // Żeby przy tym szerokość CAŁEGO menu nie skakała przy przesuwaniu zaznaczenia, niezaznaczone
        // wiersze dostają rezerwę o szerokości bulletu na KOŃCU. Rezerwą jest ten sam <Text> z opacity 0,
        // więc mierzy się co do piksela tak samo (zgadywanie stałej szerokości by się rozjechało).
        // Ukrywanie przez `color: 'transparent'` NIE działa — tak było wcześniej i kropka i tak się rysowała.
        return (
          <Pressable
            key={label}
            onPress={() => onPick(i)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 2, paddingRight: 4, paddingLeft: 2, borderRadius: 2, backgroundColor: sel ? color.dark21 : 'transparent' }}
          >
            {sel ? <Text style={{ ...txt, color: fg, ...glowSel }}>{'•'}</Text> : null}
            <Text style={{ ...txt, color: fg, ...(sel ? glowSel : null) }}>{label}</Text>
            {sel ? null : (
              <View style={{ opacity: 0 }}>
                <Text style={txt}>{'•'}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Zasłona pod MENU: blokuje dotyk poza menu (wcześniej dało się przeklikać apkę przy otwartym menu)
 * i przyciemnia treść, żeby zdjęcia pod spodem miały ~25% widoczności.
 * `Pressable` z pustym handlerem jest tu celowy — zwykły `View` NIE przechwytuje dotyku (nie zostaje
 * responderem), więc dotknięcia i tak trafiałyby w siatkę pod spodem.
 */
function MenuScrim() {
  // Tylko BLOKADA DOTYKU (przezroczysta). Przygaszenie treści do 25% robi opacity na content_area /
  // podglądzie — user chce realnej WIDOCZNOŚCI 25%, nie ciemnej nakładki.
  return <Pressable onPress={() => {}} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />;
}

// KOSZ (app-level, soft-delete): usuwanie = przeniesienie do kosza (pliki zostają na dysku, tylko ukryte).
// Syntetyczny folder TRASH przyczepiony ZAWSZE na końcu listy FOLDERS. Trwałe kasowanie dopiero z wnętrza kosza.
const TRASH_ID = '__TRASH__';
const TRASH_KEY = 'gallery_ai:trash'; // persystencja: photoKey → źródło (zserializowane obiekty PhotoSource)
// Domyślne zaznaczenie w menu = ŚRODEK listy; przy parzystej liczbie pozycji — lewy ze środkowych.
const midIdx = (n: number) => Math.max(0, Math.floor((n - 1) / 2));
const SELECT_RISK = ['DELETE'] as const; // pozycje menu zaznaczania renderowane na czerwono (High Risk)

// MENU ZAZNACZANIA (Figma 460:2831) — dwupoziomowy popover jak pasek EDIT: górny wiersz [SELECT (n) · ACTION],
// dolny = podopcje aktywnego wiersza. Nawigacja joystickiem: ←/→ w wierszu, ↑/↓ między wierszami, press = akcja.
function SelectMenu({
  count, focus, rootIdx, subIdx, subItems, onPickRoot, onPickSub, riskLabels,
}: {
  count: number; focus: 0 | 1 | 2; rootIdx: number; subIdx: number; subItems: readonly string[];
  onPickRoot: (i: number) => void; onPickSub: (i: number) => void; riskLabels?: readonly string[];
}) {
  // Licznik [n] jest PRZECHODNI — dokleja się do aktualnie zaznaczonej pozycji poziomu 1, zamiast
  // wisieć na stałe przy SELECT. Dzięki temu liczba zaznaczonych jest widoczna tam, gdzie patrzysz.
  const rootItems = ['SELECTION', 'SELECT', 'ACTION'].map((l, i) => (i === rootIdx ? `${l} [${count}]` : l));
  // W PRZEPŁYWIE (Figma 460:2541 „multi_menu" jest rodzeństwem content_area, nie nakładką) → content_area kurczy się,
  // robiąc miejsce na menu. Jak pasek EDIT: gap 16 między poziomami; pod-pasek (podopcje) na górze, główny na dole.
  return (
    <View style={{ alignSelf: 'stretch', gap: 16 }}>
      {/* Poziom 2 odsłania się DOPIERO po zatwierdzeniu pozycji poziomu 1 (press na joysticku lub tap).
          Wcześniej całe drzewko było widoczne od razu. Powrót zwija poziom (joystick w dół lub BACK). */}
      {focus === 1 && subItems.length > 0 ? (
        <MenuBar items={subItems} index={subIdx} focused onPick={onPickSub} riskLabels={riskLabels} />
      ) : null}
      {/* focus 2 = sterowanie przeszło na SIATKĘ → żaden pasek nie jest podświetlony */}
      <MenuBar items={rootItems} index={rootIdx} focused={focus === 0} onPick={onPickRoot} boldDigits />
    </View>
  );
}

// OVERLAY potwierdzenia/wyniku (à la rec_ai PlaybackScreen) — nakładka na całą treść ekranu. `tone`:
// 'red' = destrukcyjne (trwałe kasowanie), 'phosphor' = neutralne (do kosza / wynik).
/**
 * Wielki panel-nakładka nad treścią: CONFIRM (czerwony) / DELETED (phosphor).
 * Wzorzec z rec_ai (Figma 130:4623 „recordings/delete-confirm") — apki dzielą system wizualny.
 *
 * CZYTELNOŚĆ: wcześniej był tu kolorowy tekst z poświatą na półprzezroczystej czerni
 * (rgba(0,0,0,0.55)) — nad gęstą siatką zdjęć zdjęcia przebijały przez tło, a jasny tekst z glow
 * zlewał się z nimi. Teraz odwrotnie: PEŁNE tło w kolorze akcentu i CIEMNY tekst na nim, czyli
 * maksymalny kontrast niezależnie od tego, co jest pod spodem.
 *
 * `top: 48` zostawia widoczny pasek statusu ekranu — komunikat ma przykryć treść, nie kontekst.
 */
function OverlayPanel({ tone, title, sub }: { tone: 'red' | 'phosphor'; title: string; sub?: string }) {
  const bg = tone === 'phosphor' ? screen.olive.primary : color.recordRed;
  const sh = tone === 'phosphor' ? 'rgba(226,255,228,0.25)' : 'rgba(255,76,76,0.25)';
  return (
    // PASMO wyśrodkowane w treści, NIE prostokąt do dołu ekranu (Figma 138:2626) — nad i pod panelem
    // widać dalszą część zawartości. Wcześniej panel wypełniał wszystko od nagłówka w dół.
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center' }}>
      <View
        style={
          {
            alignSelf: 'stretch',
            backgroundColor: bg,
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 64, // duży zapas pionowy — w projekcie tekst pływa w środku pasma
            paddingHorizontal: 24,
            gap: 8,
            borderRadius: 4,
            boxShadow: `0px 0px 8px 0px ${sh}`,
          } as any
        }
      >
        {/* CIEMNY tekst na pełnym tle w kolorze akcentu — kontrast niezależny od tego, co pod spodem */}
        <Text style={{ fontFamily: font.timer.family, fontSize: 24, lineHeight: 30, color: color.dark21, textAlign: 'center' }}>{title}</Text>
        {sub ? <Text style={{ fontFamily: font.monoBody.family, fontSize: 12, color: color.dark21, textAlign: 'center' }}>{sub}</Text> : null}
      </View>
    </View>
  );
}

// stabilny klucz zdjęcia do persystencji wyróżnień feeda: URI/ID assetu (media) lub String(require) (mock/web).
// NIE indeks tablicy — feed jest przebudowywany od najnowszych, więc indeksy przesuwają się między sesjami.
const photoKey = (src: ImageSourcePropType): string =>
  src != null && typeof src === 'object' && 'uri' in src && (src as { uri?: unknown }).uri
    ? String((src as { uri: unknown }).uri)
    : String(src);

const FOLDER_GAP = 8; // odstęp między kolumnami w siatce folderów (ROOT)
const PHOTO_GAP = 8; //  odstęp między kolumnami w siatce zdjęć (spójny z feedem — FEED_GAP)

export function useGalleryScreen({ mode = 'GALLERY', onCycleMode, onOpenSettings, onExitApp, media, allFolders = EMPTY_FOLDERS, included = [], excluded = [], hidden = [], moments = [], displayMode = 'IMMERSIVE', diag = DIAG_ALL, leftHanded = false, promptBooster = false }: { mode?: Mode; onCycleMode?: () => void; onOpenSettings?: () => void; onExitApp?: () => void; media?: ReturnType<typeof useMedia>; allFolders?: Folder[]; included?: string[]; excluded?: string[]; hidden?: string[]; moments?: string[]; displayMode?: DisplayMode; diag?: Diag; leftHanded?: boolean; promptBooster?: boolean } = {}) {
  // rozmiar miniatur (2=medium ↔ 3=small) — NIEZALEŻNY dla gallery view i feed view
  const [galleryCols, setGalleryCols] = useState<2 | 3>(2);
  const [feedCols, setFeedCols] = useState<2 | 3>(2);
  const [selected, setSelected] = useState(0);
  const [openFolder, setOpenFolder] = useState<number | null>(null); // null = ROOT (foldery); index = wnętrze
  const [viewerOpen, setViewerOpen] = useState(false); // pełnoekranowy podgląd zdjęcia (pokazuje photos[selected])
  const [immersiveOpen, setImmersiveOpen] = useState(false); // IMMERSIVE — obraz na cały ekran telefonu (poza obudową)
  const [menuOpen, setMenuOpen] = useState(false); // kontekstowe MENU (popover)
  const [menuIndex, setMenuIndex] = useState(0);   // zaznaczona pozycja menu
  const [feedMode, setFeedMode] = useState(false); // FEED = płaska siatka WSZYSTKICH mediów (vs foldery)
  const [momentsMode, setMomentsMode] = useState(false); // MOMENTS = te same media pogrupowane po dacie
  const momentsRef = useRef<MomentsGridHandle>(null);
  // MOMENTS: nazwa miejsca per grupa-dzień (klucz = dzień lokalny). Rozwiązywana LENIWIE i tylko dla
  // 1 reprezentanta na dzień (getAssetInfoAsync jest drogie). `''` = już próbowano, brak miejsca.
  const [placeByDay, setPlaceByDay] = useState<Record<string, string>>({});
  const placeResolving = useRef<Set<string>>(new Set());
  const [feedPhotos, setFeedPhotos] = useState<ImageSourcePropType[]>([]);
  const [feedSpans, setFeedSpans] = useState<Record<string, number>>({}); // rozmiar kafla feeda: photoKey → 1..cols
  const [momentsBig, setMomentsBig] = useState<Record<string, string>>({}); // MOMENTS: dzień → photoKey zdjęcia 2× (jedno na grupę)
  const [contentW, setContentW] = useState(0);
  const [photos, setPhotos] = useState<ImageSourcePropType[]>([]); // zdjęcia otwartego folderu (mock lub media)

  // TRYB ZAZNACZANIA (multi-select, Figma 460:2831). Wejście: long-press kafla / MENU→SELECT / przytrzymanie
  // joysticka. `selectedIds` = klucze zaznaczonych (folder.id lub photoKey). Dwupoziomowe menu (SELECT/ACTION).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 0 = poziom 1 menu, 1 = poziom 2 (podopcje), 2 = SIATKA (joystick nawiguje kafle, press zaznacza)
  const [selFocus, setSelFocus] = useState<0 | 1 | 2>(0);
  const [selRoot, setSelRoot] = useState(1);  // 0 = SELECTION, 1 = SELECT (środek, domyślny; oddaje fokus siatce), 2 = ACTION
  const [selSub, setSelSub] = useState(0);            // indeks w podopcjach
  // Przepływ usuwania wg rec_ai (Figma 478:17683): confirm (czerwony) → [trzymanie: DELETING]
  // → deleted (fosforowy) z UNDO [HOLD] → [trzymanie: RESTORING] → restored (fosforowy).
  const [delPhase, setDelPhase] = useState<'none' | 'confirm' | 'deleted' | 'restored'>('none');
  const [holding, setHolding] = useState(false); // trwa przytrzymanie klawisza akcji → zmienia jego etykietę
  const [delMsg, setDelMsg] = useState<{ title: string; sub?: string; permanent: boolean }>({ title: '', permanent: false });

  // KURSOR chowany podczas swipe-follow i przytrzymania joysticka (wraca po zatrzymaniu). Nie zmienia `selected`,
  // tylko renderowaną ramkę (auto-scroll dalej działa na realnym `selected`).
  const [cursorHidden, setCursorHidden] = useState(false);

  // KOSZ — soft-delete. Mapa photoKey → źródło (pełny obiekt), persystowana. Filtruje feed/foldery; wnętrze
  // folderu TRASH pokazuje właśnie te źródła. Trwałe kasowanie (media.deleteItems) dopiero z wnętrza kosza.
  const [trashed, setTrashed] = useState<Record<string, ImageSourcePropType>>({});
  const trashLoaded = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(TRASH_KEY).then((raw) => {
      if (raw) { try { const p = JSON.parse(raw); if (p && typeof p === 'object') setTrashed(p); } catch { /* uszkodzone → pusty kosz */ } }
      trashLoaded.current = true;
    }).catch(() => { trashLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!trashLoaded.current) return;
    AsyncStorage.setItem(TRASH_KEY, JSON.stringify(trashed)).catch(() => {});
  }, [trashed]);
  const trashedKeys = useMemo(() => new Set(Object.keys(trashed)), [trashed]);

  // SORT — tryb sortowania feeda/wnętrza folderu (0=DATE↓ jak z zapytania, 1=DATE↑, 2=NAME A-Z, 3=NAME Z-A).
  // creationTime/filename z metadanych źródła. Raw (przed sortem) w refach → re-sort bez ponownego zapytania.
  const SORTS = ['DATE ↓', 'DATE ↑', 'NAME A-Z', 'NAME Z-A'] as const;
  const [sortMode, setSortMode] = useState(0);
  const feedRaw = useRef<ImageSourcePropType[]>([]);
  const photosRaw = useRef<ImageSourcePropType[]>([]);
  const sortPhotos = (arr: ImageSourcePropType[], mode: number): ImageSourcePropType[] => {
    if (mode === 0) return arr; // najnowsze pierwsze — tak zwraca loadPhotos (orderBy CREATION_TIME desc)
    const byName = mode >= 2;
    const key = (s: any) => (byName ? String(s?.filename ?? '').toLowerCase() : (s?.creationTime ?? 0));
    const sorted = [...arr].sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    return mode === 1 || mode === 2 ? sorted : sorted.reverse(); // 1=DATE↑ i 2=NAME A-Z rosnąco; 3=NAME Z-A malejąco
  };

  // aktywny rozmiar miniatur zależy od widoku; zmiana (THUMB SIZE / pinch) dotyka TYLKO aktywnego widoku
  const cols = feedMode ? feedCols : galleryCols;
  const setColsActive = (fn: (c: 2 | 3) => 2 | 3) => (feedMode ? setFeedCols(fn) : setGalleryCols(fn));

  // PERSYSTENCJA preferencji widoku (rozmiar miniatur, tryb feed/gallery, wyróżnione/powiększone kafle feeda)
  const prefsLoaded = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PREFS_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (p.galleryCols === 2 || p.galleryCols === 3) setGalleryCols(p.galleryCols);
          if (p.feedCols === 2 || p.feedCols === 3) setFeedCols(p.feedCols);
          if (typeof p.feedMode === 'boolean') setFeedMode(p.feedMode);
          if (typeof p.momentsMode === 'boolean') setMomentsMode(p.momentsMode);
          if (p.momentsBig && typeof p.momentsBig === 'object') setMomentsBig(p.momentsBig);
          if (p.feedSpans && typeof p.feedSpans === 'object') setFeedSpans(p.feedSpans);
        }
      } catch { /* brak/uszkodzone prefs → domyślne */ }
      prefsLoaded.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!prefsLoaded.current) return; // nie nadpisuj zapisu domyślnymi zanim wczytamy
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ galleryCols, feedCols, feedMode, momentsMode, feedSpans, momentsBig })).catch(() => {});
  }, [galleryCols, feedCols, feedMode, momentsMode, feedSpans, momentsBig]);

  // widoczne foldery = whitelist (jeśli niepusta) − blacklist. Reszta ekranu (siatka/feed/nawigacja) używa TYCH.
  // Źródło (`allFolders`) i `media` podaje App (jedno useMedia — współdzielone z Settings).
  // widoczne foldery = whitelist − blacklist, dodatkowo bez `hidden` (chyba że SHOW HIDDEN ELEMENTS w menu).
  const [showHidden, setShowHidden] = useState(false);
  const trashValues = useMemo(() => Object.values(trashed), [trashed]);
  const folders: Folder[] = useMemo(() => {
    let base = applyLibraryFilter(allFolders, included, excluded);
    if (!showHidden) base = base.filter((f) => !hidden.includes(f.id));
    if (sortMode >= 2) { base = [...base].sort((a, b) => a.name.localeCompare(b.name)); if (sortMode === 3) base.reverse(); } // NAME A-Z / Z-A
    // KOSZ — syntetyczny folder na końcu, TYLKO gdy NIEPUSTY (pusty → niewidoczny). Okładka = ostatnio wyrzucone;
    // licznik = liczba w koszu. Nawigacja/otwieranie jak zwykły folder (id=TRASH_ID → wnętrze z `trashed`).
    if (trashValues.length > 0) {
      base = [...base, { id: TRASH_ID, name: 'TRASH', cover: trashValues[trashValues.length - 1], count: trashValues.length } as Folder];
    }
    return base;
  }, [allFolders, included, excluded, hidden, showHidden, sortMode, trashValues]);

  // wejście/wyjście z folderu → zaznaczenie na pierwszy + załaduj zdjęcia (mock inline / media leniwie)
  useEffect(() => {
    setSelected(0);
    setViewerOpen(false); // zmiana folderu → zamknij ewentualny podgląd
    setMenuOpen(false);   // i menu
    // guard: nie ustawiaj nowej pustej tablicy, jeśli już pusta (unikaj zbędnego re-rendera)
    const clear = () => setPhotos((p) => (p.length ? [] : p));
    if (openFolder == null) { clear(); return; }
    const f = folders[openFolder];
    if (!f) { setOpenFolder(null); clear(); return; } // folder zniknął (np. opróżniony kosz) → wróć do ROOT
    if (f.id === TRASH_ID) { photosRaw.current = []; clear(); return; } // kosz: wnętrze bierze wprost z `trashed` (photosView)
    if (f.photos) { photosRaw.current = f.photos; setPhotos(sortPhotos(f.photos, sortMode)); return; } // mock (web)
    if (!media) { clear(); return; }
    let cancelled = false;
    media.loadPhotos(f.id).then((ps) => { if (!cancelled) { photosRaw.current = ps; setPhotos(sortPhotos(ps, sortMode)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFolder, folders]);

  // FEED — załaduj media, gdy wejdziemy w tryb feed. Web: mock (złączone zdjęcia folderów). Natywnie:
  // zbierz media ze WSZYSTKICH zdefiniowanych folderów (Promise.all + flatten).
  useEffect(() => {
    if (!feedMode && !momentsMode) return;
    // feed/moments respektują filtr biblioteki: bierzemy tylko WIDOCZNE foldery (`folders`) — bez syntetycznego kosza
    const realFolders = folders.filter((f) => f.id !== TRASH_ID);
    if (DESIGN) { const raw = realFolders.flatMap((f) => f.photos ?? []); feedRaw.current = raw; setFeedPhotos(sortPhotos(raw, sortMode)); return; }
    if (!media) { setFeedPhotos([]); return; }
    let cancelled = false;
    // taguj albumId per folder → MOMENTS filtruje po folderach aparatu (patrz momentsFolderIds)
    Promise.all(realFolders.map((f) => media.loadPhotos(f.id).then((ps) => ps.map((p) => ({ ...(p as any), albumId: f.id })) as ImageSourcePropType[]).catch(() => [] as ImageSourcePropType[])))
      .then((lists) => { if (!cancelled) { feedRaw.current = lists.flat(); setFeedPhotos(sortPhotos(feedRaw.current, sortMode)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedMode, momentsMode, folders]);
  // re-sort BEZ ponownego zapytania (raw w refie) + kursor na górę (kolejność się zmieniła)
  useEffect(() => {
    setFeedPhotos(sortPhotos(feedRaw.current, sortMode));
    setPhotos(sortPhotos(photosRaw.current, sortMode));
    setSelected(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortMode]);

  // Auto-scroll: widok podąża za zaznaczeniem (joystick/PREV/NEXT) — FlashList.scrollToIndex.
  const listRef = useRef<any>(null);
  const gridSkipAuto = useRef(false);                   // po swipe siatki NIE re-centruj (kursor już na kaflu; inaczej „skacze")
  const [gridViewH, setGridViewH] = useState(0);        // wysokość viewportu FlatListy (do follow-swipe: kafel w środku)
  const gridScrolling = useRef(false);                  // trwa swipe siatki → auto-scroll wyłączony (nie walczy ze swipem)
  const gridScrollT = useRef<ReturnType<typeof setTimeout> | null>(null);

  // TOAST trybu wyświetlania: pokazywany przy swipie, znika 2 s po OSTATNIM swipie (timer resetowany).
  const [toastVisible, setToastVisible] = useState(false);
  const [menuToast, setMenuToast] = useState<string | null>(null); // komunikat z menu (SORT/HIDDEN) zamiast trybu wyświetlania
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showModeToast = () => {
    setMenuToast(null); setToastVisible(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 2000);
  };
  const showMenuToast = (msg: string, ms = 2000) => {
    setMenuToast(msg); setToastVisible(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => { setToastVisible(false); setMenuToast(null); }, ms);
  };
  // double-back: pierwszy systemowy BACK w ROOT → ten toast (3 s); drugi w oknie → wyjście z apki (App).
  const showExitToast = () => showMenuToast('"BACK" AGAIN TO CLOSE THE APP', 3000);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const inside = openFolder !== null;
  // WIDOKI filtrowane koszem: feed/wnętrze folderu bez elementów w koszu; wnętrze KOSZA = wprost `trashed`.
  const isTrashOpen = inside && folders[openFolder!]?.id === TRASH_ID;
  const photosView = useMemo(
    () => (isTrashOpen ? trashValues : photos.filter((s) => !trashedKeys.has(photoKey(s)))),
    [isTrashOpen, trashValues, photos, trashedKeys]
  );
  const feedView = useMemo(() => feedPhotos.filter((s) => !trashedKeys.has(photoKey(s))), [feedPhotos, trashedKeys]);
  // MOMENTS bierze te same media co feed, ale ograniczone do folderów aparatu (lub ręcznie wybranych).
  const momentsFolders = useMemo(() => momentsFolderIds(allFolders as any[], moments), [allFolders, moments]);
  const momentsView = useMemo(() => {
    const filtered = momentsFolders.length
      ? feedView.filter((s) => new Set(momentsFolders).has((s as any)?.albumId))
      : feedView;
    // MUSI być GLOBALNIE po dacie malejąco. feedView jest sklejeniem folderów (każdy z osobna date-desc),
    // więc bez tego dodany folder dokleja zdjęcia na KONIEC listy (pod spód MOMENTS) zamiast wpleść je
    // chronologicznie — filtr rósł (434→934), ale top się nie zmieniał.
    return [...filtered].sort((a, b) => ((b as any)?.creationTime ?? 0) - ((a as any)?.creationTime ?? 0));
  }, [feedView, momentsFolders]);

  // Rozwiąż nazwy miejsc dla dni w MOMENTS — próbkujemy KILKA zdjęć dnia (bo dzień może mieć wiele
  // lokalizacji), zliczamy miasta i formatujemy: „[najczęstsze], [drugie], [trzecie] & more".
  useEffect(() => {
    if (!momentsMode || !media || DESIGN) return;
    const dayKeyOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    const SAMPLE_PER_DAY = 5;
    const idsByDay: Record<string, string[]> = {};
    for (const src of momentsView) {
      const t = (src as any)?.creationTime; const id = (src as any)?.uri;
      if (t == null || !id) continue;
      const k = dayKeyOf(t);
      (idsByDay[k] ||= []).length < SAMPLE_PER_DAY && idsByDay[k].push(id);
    }
    // Miasta wg CZĘSTOŚCI: do 3 nazw, „& more" gdy jest ich więcej. Puste → brak miejsca.
    const formatPlaces = (cities: string[]): string => {
      const count = new Map<string, number>();
      for (const c of cities) count.set(c, (count.get(c) ?? 0) + 1);
      const ranked = [...count.keys()].sort((a, b) => (count.get(b)! - count.get(a)!));
      if (ranked.length === 0) return '';
      const head = ranked.slice(0, 3).join(', ');
      return ranked.length > 3 ? `${head} & more` : head;
    };
    let cancelled = false;
    (async () => {
      for (const [day, ids] of Object.entries(idsByDay)) {
        if (cancelled) return;
        if (day in placeByDay || placeResolving.current.has(day)) continue;
        placeResolving.current.add(day);
        const cities: string[] = [];
        for (const id of ids) { const c = await media.placeOfAsset(id); if (cancelled) return; if (c) cities.push(c); }
        setPlaceByDay((m) => ({ ...m, [day]: formatPlaces(cities) }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [momentsMode, momentsView]);
  const n = momentsMode ? momentsView.length : feedMode ? feedView.length : inside ? photosView.length : folders.length;
  const gap = inside ? PHOTO_GAP : FOLDER_GAP;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (n <= 0 || feedMode || momentsMode || viewerOpen) return; // feed/moments mają własny auto-scroll; przy podglądzie siatka odmontowana
    if (gridScrolling.current) return;             // kursor podąża za swipem (onScroll) → nie centruj, nie walcz ze swipem
    if (gridSkipAuto.current) { gridSkipAuto.current = false; return; } // tuż po swipe: kursor już na kaflu → nie „snapuj"
    // FlatList z numColumns pracuje na WIERSZACH (getItemCount = ceil(n/cols)), więc scrollToIndex oczekuje
    // indeksu WIERSZA, nie elementu. Zaznaczenie jest w tym wierszu, więc centrujemy wiersz. Po zamknięciu
    // podglądu (viewerOpen→false) siatka montuje się od nowa (scroll na górze) — rAF czeka na ref/layout,
    // żeby WRÓCIĆ do oglądanego pliku (getItemLayout czyni scroll pewnym).
    const row = Math.floor(selected / cols);
    const raf = requestAnimationFrame(() => { try { listRef.current?.scrollToIndex({ index: row, animated: false, viewPosition: 0.5 }); } catch {} });
    return () => cancelAnimationFrame(raf);
    // UWAGA: bez `cols` w zależnościach — na zmianę rozmiaru (THUMB SIZE) FlatList jest REMONTOWANY (key=cols).
  }, [selected, openFolder, viewerOpen]);

  // NAWIGACJA ramką. Pojedynczy ruch W PIONIE (zmiana wiersza): najpierw KRÓTKI animowany scroll, dopiero
  // po nim ramka przeskakuje na nowy element (SCROLL_LEAD_MS). Ruch w poziomie (ten sam wiersz) i PRZYTRZYMANIE
  // joysticka (repeat, szybkie kolejne ruchy) → natychmiast. `targetRef` = kursor logiczny (może wyprzedzać
  // `selected` w oknie animacji); resync do `selected`, gdy nie ma zaległego przeskoku.
  const selRef = useRef(selected); selRef.current = selected;
  const targetRef = useRef(selected);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMoveAt = useRef(0);
  const SCROLL_LEAD_MS = 130;
  const scrollToIdx = (idx: number) => {
    if (feedMode) return; // feed: FeedGrid scrolluje sam na zmianę selected
    try { listRef.current?.scrollToIndex({ index: Math.floor(idx / cols), animated: true, viewPosition: 0.5 }); } catch {}
  };
  const move = (d: number) => {
    if (n <= 0) return;
    if (!moveTimer.current) targetRef.current = selRef.current; // brak zaległej animacji → kursor = realny stan
    const base = targetRef.current;
    const target = Math.max(0, Math.min(n - 1, base + d));
    if (target === base) return; // krawędź
    targetRef.current = target;
    if (feedMode || viewerOpen) { setSelected(target); return; } // feed / podgląd (prev-next) → natychmiast, bez leadowania
    const now = Date.now();
    const rapid = now - lastMoveAt.current < 250; // szybkie kolejne ruchy = przytrzymanie
    lastMoveAt.current = now;
    if (moveTimer.current) { clearTimeout(moveTimer.current); moveTimer.current = null; }
    const sameRow = Math.floor(base / cols) === Math.floor(target / cols);
    if (sameRow || rapid) { setSelected(target); return; } // ten sam wiersz (poziom) LUB hold → natychmiast
    scrollToIdx(target);                                    // pionowy pojedynczy: KRÓTKI animowany scroll…
    moveTimer.current = setTimeout(() => { moveTimer.current = null; setSelected(target); }, SCROLL_LEAD_MS); // …potem ramka
  };
  // przerwij zaległy przeskok ramki przy zmianie folderu/trybu/podglądu (żeby nie skoczyć na nieaktualny target)
  useEffect(() => () => { if (moveTimer.current) clearTimeout(moveTimer.current); }, []);
  useEffect(() => { if (moveTimer.current) { clearTimeout(moveTimer.current); moveTimer.current = null; } }, [openFolder, feedMode, viewerOpen]);
  const toggleView = () => setColsActive((c) => (c === 2 ? 3 : 2));
  // pinch na ekranie: rozsunięcie ('out') → mniej kolumn (większe kafle), zsunięcie ('in') → więcej
  const pinchColumns = (dir: 'in' | 'out') =>
    setColsActive((c) => Math.max(2, Math.min(3, dir === 'out' ? c - 1 : c + 1)) as 2 | 3);
  // press: FEED → podgląd; ROOT → wejdź w folder; folder → podgląd zaznaczonego zdjęcia
  const enter = () => {
    if (feedMode || momentsMode) { if (n > 0) setViewerOpen(true); return; }
    if (!inside) { setOpenFolder(selected); return; }
    if (n > 0) setViewerOpen(true);
  };
  const closeViewer = () => { setViewerOpen(false); setImmersiveOpen(false); };

  // FEED ⇄ GALLERY (przycisk FEED VIEW / GALLERY VIEW). Wejście w feed zamyka folder/menu/podgląd, zeruje kursor.
  // NIE czyścimy feedSpans — powiększone/wyróżnione kafle mają być zapamiętane (persystencja) między sesjami.
  const toggleFeed = () => {
    setMenuOpen(false); setViewerOpen(false); setOpenFolder(null); setSelected(0);
    // cykl: FOLDERS → FEED → MOMENTS → FOLDERS
    if (!feedMode && !momentsMode) { setFeedMode(true); }
    else if (feedMode) { setFeedMode(false); setMomentsMode(true); }
    else { setMomentsMode(false); }
  };
  // etykieta klawisza = NASTĘPNY widok w cyklu
  const nextViewLabel = !feedMode && !momentsMode ? 'FEED' : feedMode ? 'MOMENTS' : 'FOLDERS';
  // FeedGrid pozycjonuje po indeksie → przełóż wyróżnienia (photoKey → span) na indeks bieżącego feeda.
  const feedSpansByIndex = useMemo(() => {
    const out: Record<number, number> = {};
    feedView.forEach((src, i) => { const v = feedSpans[photoKey(src)]; if (v) out[i] = v; });
    return out;
  }, [feedView, feedSpans]);

  // NAWIGACJA PRZESTRZENNA po feedzie (masonry). Odtwarzamy pakowanie (1:1 z FeedGrid) + mapę komórka→index.
  const feedPack = useMemo(() => {
    const spanArr = feedView.map((_, i) => Math.min(feedSpansByIndex[i] || 1, feedCols));
    return packFeed(spanArr, feedCols);
  }, [feedView, feedSpansByIndex, feedCols]);
  const feedCellGrid = useMemo(() => {
    const g: number[][] = [];
    feedPack.pos.forEach((p, i) => {
      for (let dr = 0; dr < p.k; dr++) { const row = g[p.r + dr] || (g[p.r + dr] = []); for (let dc = 0; dc < p.k; dc++) row[p.c + dc] = i; }
    });
    return g;
  }, [feedPack]);
  const feedRef = useRef<FeedGridHandle>(null); // joystick: przewijanie feeda o stały krok (patrz FeedGrid.nudge)
  const [prefCol, setPrefCol] = useState(0); // zapamiętana kolumna nawigacji (przetrwa przejście przez kafle innego rozmiaru)
  const feedTileAt = (r: number, c: number): number | undefined =>
    r >= 0 && c >= 0 && c < feedCols && feedCellGrid[r] ? feedCellGrid[r][c] : undefined;
  // GÓRA/DÓŁ w feedzie, POJEDYNCZE pchnięcie: kursor na sąsiedni kafel (w kolumnie `prefCol`, w wierszu
  // tuż nad/pod bieżącym). Przytrzymanie przechodzi w płynny przesuw i obsługuje je FeedGrid
  // (`navStart`/`navEnd`) — tam krok jest liczony w px/s, więc wysokie kafle nie powodują przeskoków.
  const feedMoveV = (dir: -1 | 1) => {
    const T = feedPack.pos[selected]; if (!T) return;
    let c = prefCol; if (c < T.c || c >= T.c + T.k) c = T.c;
    const r = dir > 0 ? T.r + T.k : T.r - 1;
    let idx = feedTileAt(r, c);
    for (let d = 1; idx === undefined && d < feedCols; d++) idx = feedTileAt(r, c - d) ?? feedTileAt(r, c + d);
    if (idx !== undefined) { if (c !== prefCol) setPrefCol(c); setSelected(idx); }
  };
  // lewo/prawo: kafel bezpośrednio z boku bieżącego (kolumna tuż za jego krawędzią) → zmiana prefCol.
  const feedMoveH = (dir: -1 | 1) => {
    const T = feedPack.pos[selected]; if (!T) return;
    const c = dir > 0 ? T.c + T.k : T.c - 1;
    const idx = feedTileAt(T.r, c);
    if (idx !== undefined) { setPrefCol(c); setSelected(idx); }
  };

  // uchwyt trójkąta: cykl rozmiaru kafla feeda 1→2→…→cols→1 (limit = liczba kolumn).
  // Klucz = stabilne photoKey zdjęcia (nie indeks) → wyróżnienie zostaje przy TYM zdjęciu między sesjami.
  // MOMENTS: dzień lokalny danego kafla (do wykluczania 2× w obrębie grupy).
  const momDay = (i: number): string | null => {
    const t = (momentsView[i] as any)?.creationTime; if (t == null) return null;
    const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  // Powiększenie 2× jednego zdjęcia w grupie — JEDNO na dzień. Ponowne na tym samym = zmniejszenie;
  // na innym = przeniesienie (poprzednie automatycznie wraca do 1×, bo trzymamy 1 klucz na dzień).
  const cycleMomentBig = (i: number) => {
    const day = momDay(i); const src = momentsView[i]; if (!day || src == null) return;
    const key = photoKey(src);
    setMomentsBig((m) => { const nx = { ...m }; if (nx[day] === key) delete nx[day]; else nx[day] = key; return nx; });
  };
  const isMomentBig = (i: number): boolean => { const day = momDay(i); const src = momentsView[i]; return !!day && src != null && momentsBig[day] === photoKey(src); };

  const cycleSpan = (i: number) =>
    setFeedSpans((s) => {
      const src = feedView[i];
      if (src == null) return s;
      const key = photoKey(src);
      const cur = Math.min(s[key] || 1, cols);
      return { ...s, [key]: (cur % cols) + 1 };
    });
  const openViewerAt = (i: number) => { setSelected(i); setViewerOpen(true); };

  // EDYTOR — pełnoekranowy podgląd + edycja (Figma „fullscreen_view/edit"). Aktywny, gdy `viewerOpen`;
  // przejmuje treść ekranu i klawiaturę. Źródło = zaznaczone zdjęcie (feed lub wnętrze folderu).
  const currentSource = (momentsMode ? momentsView : feedMode ? feedView : photosView)[selected];
  // Lokalizacja dla panelu INFO w podglądzie — rozwiązywana dla POJEDYNCZEGO bieżącego zdjęcia (tanie).
  const [viewerPlace, setViewerPlace] = useState<string | null>(null);
  useEffect(() => {
    setViewerPlace(null);
    if (!viewerOpen || !media || DESIGN) return;
    const id = (currentSource as any)?.uri; if (!id) return;
    let cancelled = false;
    media.placeOfAsset(id).then((pl) => { if (!cancelled) setViewerPlace(pl); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerOpen, currentSource]);

  const editor = useImageEditor({
    source: currentSource,
    open: viewerOpen,
    place: viewerPlace,
    onExit: closeViewer,
    onPrev: () => move(-1),
    onNext: () => move(1),
    onOpenSettings,
    onMenu: () => toggleMenu(), // klawisz MENU w podglądzie → kontekstowe menu galerii
    onRequestImmersive: () => setImmersiveOpen(true), // press joysticka / pinch-out → IMMERSIVE
    leftHanded,
    promptBooster,
  });

  // IMMERSIVE — deskryptor renderowany przez App w ROOCIE (poza obudową). Współdzieli `selected` z podglądem,
  // więc wyjście wraca na to samo zdjęcie. Lista = aktywne źródło (feed lub wnętrze folderu).
  const immersive = viewerOpen && immersiveOpen && currentSource
    ? { photos: (momentsMode ? momentsView : feedMode ? feedView : photosView), index: selected, setIndex: (i: number) => setSelected(i), close: () => setImmersiveOpen(false), info: editor.info }
    : null;

  // MENU
  const toggleMenu = () => setMenuOpen((o) => { if (!o) setMenuIndex(0); return !o; });
  // nawigacja zapętlona (loop): z końca wracamy na początek i odwrotnie
  // Lista pozycji zależy od kontekstu — `pickMenu`/`menuMove` MUSZĄ indeksować po niej, nie po stałej
  // MENU_ITEMS, bo po odfiltrowaniu pozycji indeksy się przesuwają i klikałoby się nie to, co widać.
  // DELETE pojedynczego elementu w MENU — wszędzie POZA widokiem folderów (ROOT). Pod SELECT.
  const inFileGrid = !viewerOpen && (feedMode || momentsMode || inside);
  const menuItems: readonly string[] = viewerOpen
    ? MENU_ITEMS_VIEWER
    : inFileGrid
      ? ['SELECT', 'DELETE', 'SORT', 'FILTER MEDIA', 'SHOW HIDDEN ELEMENTS', 'OPEN TRASH BIN', 'SETTINGS']
      : MENU_ITEMS;
  const menuMove = (d: number) => setMenuIndex((i) => (i + d + menuItems.length) % menuItems.length);
  const pickMenu = (i: number) => {
    const item = menuItems[i];
    // SORT i SHOW HIDDEN działają „w miejscu" — menu ZOSTAJE otwarte (można cyklować / od razu zobaczyć efekt).
    if (item === 'SORT') { const m = (sortMode + 1) % SORTS.length; setSortMode(m); showMenuToast(`SORT: ${SORTS[m]}`); return; }
    if (item === 'SHOW HIDDEN ELEMENTS') { const next = !showHidden; setShowHidden(next); showMenuToast(next ? 'SHOWING HIDDEN' : 'HIDING HIDDEN'); return; }
    setMenuOpen(false);
    if (item === 'SELECT') { enterSelect(viewerOpen ? undefined : selected); return; } // wejście w tryb zaznaczania (zaznacz bieżący)
    if (item === 'OPEN TRASH BIN') { const ti = folders.findIndex((f) => f.id === TRASH_ID); if (ti >= 0) { setFeedMode(false); setOpenFolder(ti); } else showMenuToast('TRASH EMPTY'); return; }
    if (item === 'DELETE') { deleteCurrent(); return; }
    if (item === 'SETTINGS') { onOpenSettings?.(); return; }
    // FILTER MEDIA — dorobimy (backlog)
  };
  // etykiety menu (dynamiczne: SHOW ⇄ HIDE HIDDEN wg stanu)
  const menuLabels = menuItems.map((l) => (l === 'SHOW HIDDEN ELEMENTS' ? (showHidden ? 'HIDE HIDDEN ELEMENTS' : 'SHOW HIDDEN ELEMENTS') : l));
  // zmiana kontekstu (wejście/wyjście z podglądu) skraca listę → zaznaczenie mogłoby wypaść poza zakres
  useEffect(() => { setMenuIndex((i) => Math.min(i, menuItems.length - 1)); }, [menuItems.length]);

  // ── TRYB ZAZNACZANIA ────────────────────────────────────────────────────────────────────────────
  const curList: any[] = momentsMode ? momentsView : feedMode ? feedView : inside ? photosView : folders;
  const isFolderView = !feedMode && !inside;
  // klucz elementu: folder.id (ROOT) lub photoKey (feed/wnętrze). KOSZ jako kafel folderu jest NIEzaznaczalny.
  const keyOfIndex = (i: number): string | undefined => {
    const it = curList[i];
    if (it == null) return undefined;
    if (isFolderView) return undefined; // FOLDERÓW nie zaznaczamy — tylko pliki (wnętrze / feed / moments)
    return photoKey(it as ImageSourcePropType);
  };
  const allKeys = (): string[] => curList.map((_, i) => keyOfIndex(i)).filter(Boolean) as string[];

  const enterSelect = (i?: number) => {
    if (isFolderView) return; // ROOT = foldery: brak zaznaczania (zaznaczamy tylko pliki)
    setMenuOpen(false); setViewerOpen(false); setImmersiveOpen(false); setCursorHidden(false);
    setSelectMode(true); setSelFocus(0); setSelRoot(1); setSelSub(0); setDelPhase('none'); // selRoot 1 = SELECT (środek)
    const k = i != null ? keyOfIndex(i) : undefined;
    setSelectedIds(k ? new Set([k]) : new Set());
  };
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitSelect = () => {
    if (delTimer.current) { clearTimeout(delTimer.current); delTimer.current = null; }
    setSelectMode(false); setSelectedIds(new Set()); setDelPhase('none');
  };
  const toggleSelectAt = (i: number) => {
    const k = keyOfIndex(i); if (!k) return;
    setSelectedIds((s) => { const nx = new Set(s); nx.has(k) ? nx.delete(k) : nx.add(k); return nx; });
  };
  const selectAll = () => setSelectedIds(new Set(allKeys()));
  const invertSel = () => setSelectedIds((s) => { const nx = new Set<string>(); for (const k of allKeys()) if (!s.has(k)) nx.add(k); return nx; });
  const clearSel = () => setSelectedIds(new Set());

  // KOSZ — operacje. moveToTrash zwraca faktycznie dodane photoKey (do UNDO). Dla ROOT (foldery) ładuje ich zdjęcia.
  const moveToTrash = async (keys: string[]): Promise<string[]> => {
    const add: Record<string, ImageSourcePropType> = {};
    if (isFolderView) {
      for (const f of folders) {
        if (f.id === TRASH_ID || !keys.includes(f.id)) continue;
        let ps: ImageSourcePropType[] = f.photos ?? [];
        if (!f.photos && media) { try { ps = await media.loadPhotos(f.id); } catch { ps = []; } }
        ps.forEach((s) => { add[photoKey(s)] = s; });
      }
    } else {
      curList.forEach((s) => { const k = photoKey(s as ImageSourcePropType); if (keys.includes(k)) add[k] = s as ImageSourcePropType; });
    }
    const added = Object.keys(add);
    if (added.length) setTrashed((t) => ({ ...t, ...add }));
    return added;
  };
  const restoreFromTrash = (keys: string[]) => setTrashed((t) => { const nx = { ...t }; keys.forEach((k) => delete nx[k]); return nx; });
  const deleteForever = async (keys: string[]) => {
    // ROOT (foldery) → keys to album-id (Album.delete); feed/wnętrze/kosz → keys to content:// URI (Asset.delete)
    try { await (isFolderView ? media?.deleteItems([], keys) : media?.deleteItems(keys, [])); } catch { /* systemowy dialog odrzucony */ }
    setTrashed((t) => { const nx = { ...t }; keys.forEach((k) => delete nx[k]); return nx; });
    media?.reload(); // odśwież okładki/liczniki albumów po trwałym skasowaniu
  };

  // USUWANIE — potwierdzenie (overlay) → wykonanie → wynik (auto-znika, 2,5 s → wyjście z trybu). Poza koszem =
  // przeniesienie do kosza (odwracalne, UNDO); w koszu = TRWAŁE (czerwony overlay). (wzorzec rec_ai delete flow)
  const lastMoved = useRef<string[]>([]);
  // MOVE TO BIN = soft-delete (do kosza, odwracalne + UNDO). DELETE = TRWAŁE (czerwone potwierdzenie).
  const askTrash = () => {
    if (selectedIds.size === 0) { showMenuToast('NOTHING SELECTED'); return; }
    setDelMsg({ title: `MOVE ${selectedIds.size} TO TRASH?`, permanent: false });
    setDelPhase('confirm');
  };
  const askPermanent = () => {
    if (selectedIds.size === 0) { showMenuToast('NOTHING SELECTED'); return; }
    setDelMsg({ title: `DELETE ${selectedIds.size} FOREVER?`, sub: 'THIS CANNOT BE UNDONE', permanent: true });
    setDelPhase('confirm');
  };
  const restoreSelected = () => {
    const keys = Array.from(selectedIds);
    if (!keys.length) { showMenuToast('NOTHING SELECTED'); return; }
    restoreFromTrash(keys); setSelectedIds(new Set()); showMenuToast('RESTORED');
  };
  // DELETE z menu PODGLĄDU: dotyczy pojedynczego, bieżącego zdjęcia (nie zaznaczenia). Podpinamy je pod
  // ten sam przepływ co tryb zaznaczania — ustawiamy `selectedIds` na bieżący klucz i pytamy. W koszu =
  // trwałe (askPermanent), poza koszem = do kosza (askTrash). Po zakończeniu zamykamy podgląd (timer niżej).
  // DELETE z MENU dla POJEDYNCZEGO elementu (podgląd lub kursor w feed/moments/wnętrzu). W koszu = trwałe.
  const deleteCurrent = () => {
    const k = keyOfIndex(selected);
    if (!k) return;
    setSelectedIds(new Set([k]));
    if (isTrashOpen) { setDelMsg({ title: 'DELETE FOREVER?', permanent: true }); }
    else { setDelMsg({ title: 'MOVE TO TRASH?', permanent: false }); }
    setDelPhase('confirm');
  };
  const confirmDelete = async () => {
    const keys = Array.from(selectedIds);
    setHolding(false);
    if (delMsg.permanent) { await deleteForever(keys); setDelMsg((m) => ({ ...m, title: 'DELETED', sub: undefined })); lastMoved.current = []; }
    else { lastMoved.current = await moveToTrash(keys); setDelMsg((m) => ({ ...m, title: 'MOVED TO TRASH', sub: undefined })); }
    setSelectedIds(new Set());
    setDelPhase('deleted');
    if (delTimer.current) clearTimeout(delTimer.current);
    delTimer.current = setTimeout(() => { setDelPhase('none'); setSelectMode(false); setViewerOpen(false); }, 2500);
  };
  const cancelDelete = () => { setHolding(false); setDelPhase('none'); };
  const undoTrash = () => {
    if (lastMoved.current.length) restoreFromTrash(lastMoved.current);
    lastMoved.current = [];
    setHolding(false);
    setDelMsg((m) => ({ ...m, title: 'RESTORED', sub: undefined }));
    setDelPhase('restored');
    if (delTimer.current) clearTimeout(delTimer.current);
    delTimer.current = setTimeout(() => { setDelPhase('none'); setSelectMode(false); setViewerOpen(false); }, 2000);
  };

  // dwupoziomowe menu jak pasek EDIT: pod-pasek (podopcje) NA GÓRZE, pasek główny [SELECT · ACTION] NA DOLE.
  // W koszu ACTION = [RESTORE · DELETE]. Nawigacja 1:1 z EDIT: ←/→ w aktywnym pasku, ↑ = pod-pasek, ↓ = główny.
  const SUB_SELECT = ['ALL', 'INVERSE', 'DESELECT'] as const;
  const SUB_ACTION = (isTrashOpen ? ['RESTORE', 'DELETE'] : ['MOVE', 'COPY', 'DELETE']) as readonly string[];
  // SELECTION (0) = operacje na zaznaczeniu; SELECT (1) = oddaje fokus siatce, BRAK poziomu 2; ACTION (2) = operacje na plikach
  const subItems: readonly string[] = selRoot === 0 ? SUB_SELECT : selRoot === 2 ? SUB_ACTION : [];
  useEffect(() => { setSelSub(midIdx(subItems.length)); }, [selRoot, isTrashOpen, subItems.length]);
  const activateSub = (i: number) => {
    if (selRoot === 0) { if (i === 0) selectAll(); else if (i === 1) invertSel(); else clearSel(); return; }
    if (isTrashOpen) {
      if (i === 0) restoreSelected(); else askPermanent(); // kosz: RESTORE / DELETE (TRWAŁE)
    } else {
      if (SUB_ACTION[i] === 'DELETE') askTrash(); else showMenuToast('COMING SOON'); // DELETE = soft (do kosza); MOVE/COPY — stub
    }
  };
  // press: na pasku głównym (focus 0) wchodzi w pod-pasek; na pod-pasku (focus 1) odpala akcję (jak EDIT).
  const selPress = () => {
    if (selFocus === 2) { toggleSelectAt(selected); return; }        // siatka: zaznacz/odznacz bieżący kafel
    if (selFocus === 1) { activateSub(selSub); return; }
    if (selRoot === 1) { setSelFocus(2); return; }                   // SELECT → oddaj sterowanie siatce
    if (subItems.length > 0) setSelFocus(1);
  };
  const selMoveH = (d: -1 | 1) => {
    if (selFocus === 0) setSelRoot((r) => (r + d + 3) % 3);
    else setSelSub((s) => { const len = subItems.length; return (s + d + len) % len; });
  };
  // PION NIE PRZEŁĄCZA POZIOMÓW. W dół zwijał wcześniej poziom 2, ale przy jednoczesnym BACK-u okazało się
  // to mylące (dwa różne gesty do tego samego, a joystick w innych kontekstach nawiguje po treści).
  // Wejście w poziom 2 = zatwierdzenie (press/tap), wyjście = WYŁĄCZNIE BACK.

  // back: kolejno zamknij MENU → (edytor: menu edycji/pod-widok, a na końcu podgląd) → folder → feed
  const goBack = () => {
    if (delPhase === 'confirm') { cancelDelete(); return true; }
    if (selectMode && selFocus !== 0) { setSelFocus(0); return true; } // najpierw wróć z siatki / poziomu 2 do menu
    if (selectMode) { exitSelect(); return true; }
    if (menuOpen) { setMenuOpen(false); return true; }
    if (viewerOpen) { if (!editor.goBack()) setViewerOpen(false); return true; }
    if (inside) { setOpenFolder(null); return true; }
    if (feedMode) { setFeedMode(false); setSelected(0); return true; }
    if (momentsMode) { setMomentsMode(false); setSelected(0); return true; }
    return false;
  };

  // komórka = szerokość kolumny; bok kwadratowego kafla = komórka minus przerwa (padding gap/2)
  const itemWidth = contentW > 0 ? Math.floor(contentW / cols) : 0;
  const imgSize = itemWidth > 0 ? itemWidth - gap : 0;
  const rowHeight = imgSize + gap + (inside ? 0 : 34); // +podpis dla folderów (getItemLayout → pewny scrollToIndex)

  // FOLDERS/wnętrze folderu (FlatList): kursor PODĄŻA za swipem (kafel w środku pionowym; 3 kol.→środek, 2 kol.→lewa).
  // userScrolling tylko z realnego drag (onScrollBeginDrag) — programowy scrollToIndex nie blokuje wtedy auto-scrollu.
  const gridPendingSel = useRef<number | null>(null); // kafel pod środkiem — ustawiany w `selected` DOPIERO po zatrzymaniu
  const onGridScrollBeginDrag = () => { gridScrolling.current = true; scrollFlag.at = Date.now(); setCursorHidden(true); if (gridScrollT.current) clearTimeout(gridScrollT.current); };
  const onGridScroll = (e: { nativeEvent: { contentOffset: { y: number } } }) => {
    scrollFlag.at = Date.now(); // PerfHud: patrz FeedGrid.onScroll
    if (!gridScrolling.current || gridViewH <= 0 || rowHeight <= 0 || n <= 0) return;
    if (gridScrollT.current) clearTimeout(gridScrollT.current);
    // PERF: kursor schowany podczas swipe → NIE wołamy setSelected na każde zdarzenie (re-render całego ekranu
    // ~30×/s = okresowe spadki fps). Zapamiętujemy kafel pod środkiem, ustawiamy `selected` RAZ po zatrzymaniu.
    const y = e.nativeEvent.contentOffset.y;
    const row = Math.max(0, Math.floor((y + gridViewH / 2) / rowHeight));
    gridPendingSel.current = Math.min(n - 1, row * cols + (cols === 3 ? 1 : 0));
    gridScrollT.current = setTimeout(() => {
      gridScrolling.current = false; setCursorHidden(false);
      if (gridPendingSel.current != null && gridPendingSel.current !== selected) { gridSkipAuto.current = true; setSelected(gridPendingSel.current); }
      gridPendingSel.current = null;
    }, 160);
  };
  useEffect(() => () => { if (gridScrollT.current) clearTimeout(gridScrollT.current); }, []);

  // Klawiatura (kolejność): THUMB SIZE · FEED VIEW · joystick · MENU · BACK.
  // 1 = THUMB SIZE (cykl gęstości 2/3 kol.), 2 = FEED VIEW (w folderach) ⇄ GALLERY VIEW (w feedzie),
  // 4 = MENU (otwarte = CLOSE MENU, zielony), 5 = BACK — TYLKO wewnątrz folderu. FEED VIEW jest trybem
  // RÓWNOLEGŁYM do GALLERY VIEW (przełączany klawiszem FEED/GALLERY), więc tam BACK się NIE pojawia.
  // Bez BACK klawisz zostaje WIDOCZNY (puste szkło), tylko bez labela i funkcji. Gęstość też pinch.
  const canBack = inside;

  // chowanie kursora podczas SZYBKIEJ nawigacji joystickiem ↑/↓ (przytrzymanie = repeat); wraca 220 ms po ostatnim
  // ruchu. Pojedynczy krok NIE chowa (nie „mruga"). Auto-scroll dalej podąża za realnym `selected` (kursor tylko
  // niewidoczny). Wzorzec jak swipe-follow.
  const navHideT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNavAt = useRef(0);
  const bumpNavHide = () => {
    const now = Date.now();
    const rapid = now - lastNavAt.current < 200; // drugi szybki ruch = przytrzymanie
    lastNavAt.current = now;
    if (rapid) setCursorHidden(true);
    if (navHideT.current) clearTimeout(navHideT.current);
    navHideT.current = setTimeout(() => setCursorHidden(false), 220);
  };
  useEffect(() => () => { if (navHideT.current) clearTimeout(navHideT.current); }, []);

  // Przy OTWARTYM MENU wygaszamy klawisze zmieniające kontekst pod spodem: SIZE, FOLDERS/FEED, EXIT
  // i BACK. Zostają puste, ale widoczne (konwencja z klawiszy 2/4 — `metal: []` robiłoby dziury
  // w klawiaturze). Menu zamyka się klawiszem CLOSE MENU albo systemowym back.
  const keyboard: KeyboardConfig = {
    screen: menuOpen
      ? [{ label: '' }, { label: '' }]
      : [
      { label: 'SIZE', onPress: toggleView },
      // wewnątrz folderu = BACK; w ROOT (gallery view) i feedzie = EXIT (czerwony, przytrzymaj → wyjście z apki)
      canBack
        ? { label: 'BACK', onPress: () => { goBack(); } }
        : { label: 'EXIT', supporting: '[HOLD]', variant: 'risk', onHoldComplete: () => onExitApp?.(), holdMs: 1500 },
    ],
    metal: [
      menuOpen ? { type: 'label', upper: '' } : { type: 'label', upper: nextViewLabel, onPress: toggleFeed },
      { type: 'label', upper: menuOpen ? 'CLOSE\nMENU' : 'MENU', variant: menuOpen ? 'primary' : undefined, onPress: toggleMenu },
    ],
    joystick: {
      highlighted: true,
      repeat: true, // przytrzymanie = powtarzaj nawigację (krok co 1 element / wiersz)
      shortStepHaptic: true, // krótszy haptic przy przełączaniu miniatur w gallery/feed

      // feed: góra/dół = równe przewijanie (FeedGrid.nudge), lewo/prawo = kafel obok (feedMoveH);
      // folder = równa siatka (move ±cols/±1); podgląd = prev/next
      onUp: () => { if (menuOpen) menuMove(-1); else if (viewerOpen) return; else if (momentsMode) { bumpNavHide(); momentsRef.current?.moveV(-1); } else if (!feedMode) { bumpNavHide(); move(-cols); } },
      onDown: () => { if (menuOpen) menuMove(1); else if (viewerOpen) return; else if (momentsMode) { bumpNavHide(); momentsRef.current?.moveV(1); } else if (!feedMode) { bumpNavHide(); move(cols); } },
      onLeft: () => { if (menuOpen) return; if (feedMode && !viewerOpen) feedMoveH(-1); else if (momentsMode && !viewerOpen) momentsRef.current?.moveH(-1); else move(-1); },   // podgląd: poprzednie zdjęcie
      onRight: () => { if (menuOpen) return; if (feedMode && !viewerOpen) feedMoveH(1); else if (momentsMode && !viewerOpen) momentsRef.current?.moveH(1); else move(1); },    // podgląd: następne zdjęcie
      // feed: PŁYNNY przesuw sterowany wychyleniem (nie serią kroków) — patrz FeedGrid.navStart/navEnd.
      // Pion obsługuje wyłącznie ta ścieżka, więc onUp/onDown w feedzie celowo nic nie robią.
      // Pojedyncze pchnięcie = przeskok kursora na sąsiedni kafel (natychmiast). Jeśli wychylenie
      // potrwa dłużej, FeedGrid przejdzie w płynny przesuw — patrz FeedGrid.navStart.
      onDirStart: (d) => {
        if (!feedMode || menuOpen || viewerOpen || (d !== 'up' && d !== 'down')) return;
        const dir = d === 'up' ? -1 : 1;
        feedMoveV(dir);
        feedRef.current?.navStart(dir);
      },
      onDirEnd: () => { if (feedMode) feedRef.current?.navEnd(); },
      onPress: menuOpen ? () => pickMenu(menuIndex) : viewerOpen ? closeViewer : enter,
      // przytrzymanie środka w siatce (nie w menu/podglądzie) → tryb zaznaczania; kursor chowany na czas trzymania
      onHoldStart: () => { if (!menuOpen && !viewerOpen) setCursorHidden(true); },
      onHoldCancel: () => setCursorHidden(false),
      onHoldComplete: () => { if (!menuOpen && !viewerOpen && n > 0) enterSelect(selected); },
      holdMs: 550,
    },
  };

  // KLAWIATURA trybu zaznaczania: DELETE · ALL · [joy] · (RESTORE w koszu) · BACK. DELETE poza koszem = SOFT
  // (przeniesienie do kosza, odwracalne) → NIE high-risk. W koszu DELETE = TRWAŁE → czerwony + RESTORE.
  const selectKeyboard: KeyboardConfig = {
    screen: [
      // Sterowanie na SIATCE (po wejściu w SELECT) → CONFIRM oddaje fokus z powrotem do menu.
      // Poza tym pierwszy klawisz jest pusty: DELETE zdjęty z klawiatury, usuwanie jest w menu ACTION.
      selFocus === 2 ? { label: 'CONFIRM', variant: 'primary', onPress: () => setSelFocus(0) } : { label: '' },
      { label: 'BACK', onPress: () => { if (selFocus !== 0) setSelFocus(0); else exitSelect(); } },
    ],
    metal: [
      // ALL zdjęte — zaznaczanie wszystkiego jest w menu SELECT.
      { type: 'label', upper: '' },
      isTrashOpen
        ? { type: 'label', upper: 'RESTORE', onPress: restoreSelected }
        : { type: 'label', upper: '', onPress: undefined },
    ],
    joystick: {
      highlighted: true,
      repeat: selFocus === 2, // po oddaniu sterowania siatce przytrzymanie przewija kafle jak zwykle
      // focus 2 = nawigacja po kaflach (jak poza trybem zaznaczania); inaczej ruch po pozycjach menu
      onUp: () => { if (selFocus === 2) { if (feedMode) feedMoveV(-1); else { bumpNavHide(); move(-cols); } } },
      onDown: () => { if (selFocus === 2) { if (feedMode) feedMoveV(1); else { bumpNavHide(); move(cols); } } },
      onLeft: () => { if (selFocus === 2) { if (feedMode) feedMoveH(-1); else move(-1); } else selMoveH(-1); },
      onRight: () => { if (selFocus === 2) { if (feedMode) feedMoveH(1); else move(1); } else selMoveH(1); },
      onPress: selPress,
    },
  };
  // KLAWIATURA potwierdzenia usuwania. CONFIRM: CANCEL + przytrzymaj DELETE/MOVE (czerwony, progress ring).
  // DELETED: UNDO (do kosza) / CLOSE. Hold + progress ring to funkcja klawisza EKRANOWEGO (nie metalowego).
  const confirmKeyboard: KeyboardConfig = {
    screen: delPhase === 'confirm'
      ? [
          // Akcja destrukcyjna na PIERWSZYM klawiszu, wycofanie na PIĄTYM. W trakcie przytrzymania
          // etykieta zmienia się na DELETING (pierścień postępu rysuje sam klawisz).
          {
            label: holding ? 'DELETING' : delMsg.permanent ? 'DELETE' : 'TRASH',
            supporting: holding ? undefined : '[HOLD]',
            variant: delMsg.permanent ? 'risk' : undefined,
            onHoldStart: () => setHolding(true),
            onHoldCancel: () => setHolding(false),
            onHoldComplete: confirmDelete,
            holdMs: 1200,
          },
          { label: 'CANCEL', onPress: cancelDelete },
        ]
      : delPhase === 'restored'
        ? [{ label: '' }, { label: '' }] // po przywróceniu nie ma już czego cofać — panel sam znika
        : [
          // po usunięciu: UNDO na przytrzymanie (jak w rec_ai), w trakcie → RESTORING
          delMsg.permanent
            ? { label: 'CLOSE', onPress: exitSelect }
            : {
                label: holding ? 'RESTORING' : 'UNDO',
                supporting: holding ? undefined : '[HOLD]',
                onHoldStart: () => setHolding(true),
                onHoldCancel: () => setHolding(false),
                onHoldComplete: undoTrash,
                holdMs: 1200,
              },
          { label: 'CLOSE', onPress: exitSelect },
        ],
    metal: [
      { type: 'label', upper: '', onPress: undefined },
      { type: 'label', upper: '', onPress: undefined },
    ],
    joystick: { highlighted: false },
  };

  const cap = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.primary, ...phosphorGlow } as const;
  const pill = { fontFamily: font.bodyLgBold.family, fontSize: font.bodyLgBold.size, color: color.dark21 } as const;

  // Ramka = KURSOR (gdzie jesteś), nie zaznaczenie. Zaznaczenie pokazuje wyłącznie checkbox — inaczej
  // dwa różne znaczenia dzieliłyby jedno wyróżnienie. Kursor chowany tylko podczas swipe-follow /
  // przytrzymania joysticka (selEff=-1 → żaden kafel niepodświetlony).
  const selEff = cursorHidden ? -1 : selected;

  const content = (
    <>
      <ScreenTopBar mode={mode} label={feedMode ? 'FEED' : momentsMode ? 'MOMENTS' : 'FOLDERS'} onCycleMode={onCycleMode} />

      {/* content_area: przy otwartym menu przygaszona do 25% widoczności (opacity, wg życzenia usera).
          UWAGA: group-opacity na wspólnym rodzicu siatki i filtra znosi kompozycję mixBlendMode, więc filtr
          immersive/retro przy otwartym menu zanika — akceptowalne, bo treść jest wtedy i tak przygaszona. */}
      <View style={{ flex: 1, alignSelf: 'stretch', gap: 12, opacity: menuOpen ? 0.25 : 1 }}>

      {/* breadcrumb tylko we wnętrzu folderu; tap = wyjście do listy folderów */}
      {!feedMode && inside && folders[openFolder!] ? (
        <Pressable onPress={goBack} style={{ alignSelf: 'stretch' }}>
          <Text style={cap}>{`.../${folders[openFolder!].name}/`}</Text>
        </Pressable>
      ) : null}

      {!diag.grid ? (
        // DIAG GRID = OFF: bez siatki/expo-image/filtra — sam placeholder (bisect: czy to siatka tnie)
        <View style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={cap}>GRID OFF (DIAG)</Text>
        </View>
      ) : (
      <View
        style={{ flex: 1, alignSelf: 'stretch', isolation: 'isolate' } as any}
        onLayout={(e: LayoutChangeEvent) => {
          const w = e.nativeEvent.layout.width;
          setContentW((prev) => (Math.abs(prev - w) < 1 ? prev : w)); // ignoruj sub-pikselowe drgania (bez pętli re-renderów)
        }}
      >
        {momentsMode ? (
          contentW > 0 ? (
            <MomentsGrid
              ref={momentsRef}
              data={momentsView}
              timeOf={(i) => (momentsView[i] as any)?.creationTime}
              placeOf={(i) => { const t = (momentsView[i] as any)?.creationTime; if (t == null) return undefined; const d = new Date(t); const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; return placeByDay[k] || undefined; }}
              width={contentW}
              selected={selected}
              hideCursor={cursorHidden}
              images={diag.images}
              onOpen={selectMode ? toggleSelectAt : openViewerAt}
              onSelectAt={(i) => setSelected(i)}
              onScrollActive={setCursorHidden}
              spanOf={(i) => (isMomentBig(i) ? 2 : 1)}
              onCycleSpan={cycleMomentBig}
              selectMode={selectMode}
              checkedAt={(i) => { const s = momentsView[i]; return s != null && selectedIds.has(photoKey(s)); }}
              onLongPressAt={enterSelect}
            />
          ) : null
        ) : feedMode ? (
          contentW > 0 ? (
            <FeedGrid
              ref={feedRef}
              data={feedView}
              cols={cols}
              width={contentW}
              spans={feedSpansByIndex}
              selected={selected}
              hideCursor={cursorHidden}
              images={diag.images}
              onCycleSpan={cycleSpan}
              onOpen={selectMode ? toggleSelectAt : openViewerAt}
              onSelectAt={(i) => { setSelected(i); setPrefCol(feedCols === 3 ? 1 : 0); }}
              onScrollActive={setCursorHidden}
              selectMode={selectMode}
              checkedAt={(i) => { const s = feedView[i]; return s != null && selectedIds.has(photoKey(s)); }}
              onLongPressAt={enterSelect}
            />
          ) : null
        ) : itemWidth > 0 ? (
          <FlatList
            ref={listRef}
            key={`${inside ? 'p' : 'f'}-${cols}`} // remount na zmianę widoku/kolumn → czysty relayout
            data={(inside ? photosView : folders) as any[]}
            numColumns={cols}
            extraData={`${selEff}:${diag.images}:${selectMode}:${selectedIds.size}`}
            keyExtractor={(item: any, index: number) => (inside ? `p${index}` : (item as Folder).id)}
            // numColumns → `index` to indeks WIERSZA (nie elementu); offset = rowHeight * wiersz.
            getItemLayout={(_: any, index: number) => ({ length: rowHeight, offset: rowHeight * index, index })}
            onScrollToIndexFailed={() => {}}
            onLayout={(e: LayoutChangeEvent) => setGridViewH(e.nativeEvent.layout.height)}
            scrollEventThrottle={32}
            onScrollBeginDrag={onGridScrollBeginDrag}
            onScroll={onGridScroll}
            showsVerticalScrollIndicator={false}
            renderItem={({ item, index }: { item: any; index: number }) => {
              const isTrashTile = !inside && (item as Folder).id === TRASH_ID;
              const k = inside ? photoKey(item as ImageSourcePropType) : (item as Folder).id;
              const checked = selectMode && !isTrashTile ? selectedIds.has(k) : undefined;
              const onTap = selectMode
                ? (isTrashTile ? undefined : () => toggleSelectAt(index)) // w select mode kosz nieklikalny
                : inside
                  ? () => { setSelected(index); setViewerOpen(true); }
                  : () => setOpenFolder(index);
              const onLong = isTrashTile || isFolderView ? undefined : () => enterSelect(index);
              return (
                <View style={{ width: itemWidth, padding: gap / 2 }}>
                  {inside ? (
                    <PhotoTile source={item as ImageSourcePropType} size={imgSize} selected={index === selEff} images={diag.images} onPress={onTap} onLongPress={onLong} check={checked} />
                  ) : (
                    <FolderTile folder={item as Folder} size={imgSize} selected={index === selEff} images={diag.images} onPress={onTap} onLongPress={onLong} check={checked} danger={isTrashTile} />
                  )}
                </View>
              );
            }}
          />
        ) : null}
        {/* filtr trybu — JEDNA nakładka nad całą siatką (zamiast N per-kafel). DIAG: filter */}
        {diag.filter ? <ScreenFilter displayMode={displayMode} /> : null}
      </View>
      )}

      {/* natywnie: brak folderów → komunikat statusu (uprawnienie/ładowanie); web ma mock, więc nie dotyczy */}
      {!DESIGN && !feedMode && !inside && folders.length === 0 ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
          <Text style={{ ...cap, textAlign: 'center' }}>
            {media?.status === 'denied'
              ? 'NO PHOTO ACCESS'
              : media?.status === 'error'
                ? `MEDIA ERROR:\n${media?.error ?? ''}`
                : media?.status === 'ready'
                  ? (allFolders.length === 0 ? 'NO PHOTOS' : 'NO FOLDERS MATCH FILTER')
                  : 'LOADING…'}
          </Text>
        </View>
      ) : null}

      {/* TOAST trybu wyświetlania — fosforowa pigułka z nazwą trybu przy dolnej krawędzi, wyśrodkowana.
          Pojawia się przy swipie i znika 2 s po ostatnim (§ toast, node 360:5309). */}
      {toastVisible ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center' }}>
          <View
            style={
              {
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 2,
                backgroundColor: screen.olive.primary,
                boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)',
              } as any
            }
          >
            <Text style={pill}>{menuToast ?? displayMode}</Text>
          </View>
        </View>
      ) : null}

      </View>

      {/* MENU (popover) — nad siatką, gdy nie ma podglądu; podąża za klawiszem MENU (left-handed → lewy róg) */}
      {menuOpen && !viewerOpen ? (
        <>
          <MenuScrim />
          <GalleryMenu index={menuIndex} onPick={pickMenu} items={menuLabels} leftHanded={leftHanded} riskLabels={MENU_RISK} />
        </>
      ) : null}

      {/* TRYB ZAZNACZANIA — dwupoziomowe menu (SELECT/ACTION) w rogu; overlay potwierdzenia/wyniku usuwania na wierzchu */}
      {selectMode && !viewerOpen ? (
        <SelectMenu
          count={selectedIds.size}
          focus={selFocus}
          rootIdx={selRoot}
          subIdx={selSub}
          subItems={subItems}
          riskLabels={SELECT_RISK} // DELETE zawsze na czerwono — także poza koszem (usuwanie to akcja destrukcyjna)
          onPickRoot={(i) => { setSelFocus(0); setSelRoot(i); }}
          onPickSub={(i) => { setSelFocus(1); setSelSub(i); activateSub(i); }}
        />
      ) : null}
      {/* kolor panelu wg FAZY (nie wg trwałości): pytanie = czerwone, wynik = fosforowy */}
      {delPhase !== 'none' ? (
        <OverlayPanel tone={delPhase === 'confirm' ? 'red' : 'phosphor'} title={delMsg.title} sub={delPhase === 'confirm' ? delMsg.sub : undefined} />
      ) : null}
    </>
  );

  // PODGLĄD/EDYCJA — gdy `viewerOpen`, edytor przejmuje CAŁĄ treść ekranu i klawiaturę (Figma
  // „fullscreen_view/edit"). Inaczej: siatka + klawiatura galerii.
  // MENU (kontekstowe menu galerii) można otworzyć też NAD podglądem: wtedy popover + klawiatura galerii
  // (nawigacja joystickiem, CLOSE MENU) przejmują sterowanie, a treść podglądu zostaje pod spodem.
  // STRUKTURA DRZEWA MUSI BYĆ STAŁA. Wcześniej przy zamkniętym menu treścią był goły element, a przy
  // otwartym — fragment; React widział w tym miejscu inny typ węzła, odmontowywał całe poddrzewo
  // podglądu i obrazek ładował się od nowa. Teraz zawsze fragment, menu tylko dochodzi jako drugie
  // dziecko, więc `editor.content` zostaje na swojej pozycji i nie jest przemontowywany.
  const finalContent = viewerOpen ? (
    <>
      <View style={{ flex: 1, alignSelf: 'stretch', gap: dims.screenGap, opacity: menuOpen ? 0.25 : 1 }}>{editor.content}</View>
      {menuOpen ? (
        <>
          <MenuScrim />
          <GalleryMenu index={menuIndex} onPick={pickMenu} items={menuLabels} leftHanded={leftHanded} riskLabels={MENU_RISK} />
        </>
      ) : null}
      {delPhase !== 'none' ? (
        <OverlayPanel tone={delPhase === 'confirm' ? 'red' : 'phosphor'} title={delMsg.title} sub={delPhase === 'confirm' ? delMsg.sub : undefined} />
      ) : null}
    </>
  ) : content;
  const finalKeyboard = delPhase !== 'none' ? confirmKeyboard : selectMode ? selectKeyboard : menuOpen ? keyboard : viewerOpen ? editor.keyboard : keyboard;

  return { content: finalContent, keyboard: finalKeyboard, goBack, pinchColumns, showModeToast, showExitToast, viewerOpen, menuOpen, selectMode, allFolders, immersive, typing: viewerOpen ? editor.typing : false };
}
