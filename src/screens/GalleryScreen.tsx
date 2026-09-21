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
import { View, Text, Pressable, Platform, AppState, FlatList, PanResponder, LayoutChangeEvent, ImageSourcePropType, TextInput } from 'react-native';
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
import { moveToAlbum, copyToAlbum, createAlbumWith, isValidAlbumName, MediaOpResult } from '../lib/mediaOps';
import { mediaManageSupported, canManageMedia, openMediaManageSettings } from '../lib/mediaManage';
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
function ThumbBadges({ ai, raw, fg = screen.olive.primary }: { ai?: boolean; raw?: boolean; fg?: string }) {
  if (!ai && !raw) return null;
  const badge = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: fg, textShadowColor: color.dark21, textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } } as const;
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

/**
 * chromePhosphor — fosfor dla UI RYSOWANEGO W SIATCE (checkboxy, obrys kursora, badge'y, podpisy folderów).
 * Te elementy leżą pod `ScreenFilter`, więc w IMMERSIVE/RETRO są mnożone przez fosfor i wychodzą ciemniejsze
 * (#E2FFE4 × #E2FFE4 ≈ #C8FFC9) niż ten sam token poza siatką. Podajemy więc BIEL: biel × fosfor = fosfor,
 * a `saturation` (IMMERSIVE) bieli nie zmienia. W CLEAN i przy wyłączonym filtrze (DIAG) — zwykły token.
 * Ramka multiselekcji NIE korzysta z tego mechanizmu: ją dało się wynieść ponad filtr (patrz render siatki).
 */
const chromePhosphor = (displayMode: DisplayMode, filterOn: boolean) =>
  displayMode === 'CLEAN' || !filterOn ? screen.olive.primary : '#FFFFFF';

// Checkbox trybu zaznaczania (Figma 460:2831) — kwadracik w LEWYM-górnym rogu (badge'y RAW/AI są w prawym).
// Zaznaczony = wypełniony fosforem z „✓"; niezaznaczony = pusta ramka na półprzezroczystym tle (czytelny nad zdjęciem).
function TileCheck({ on, fg = screen.olive.primary }: { on: boolean; fg?: string }) {
  // Checkbox bez ptaszka (Figma 450:1861): niezaznaczony = wypełniony fosforem, ZAZNACZONY = ciemny.
  // Ramka fosforowa w obu stanach, więc pozycja i rozmiar nie skaczą przy przełączaniu.
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, borderRadius: 3, borderWidth: 2, borderColor: fg, backgroundColor: on ? color.dark21 : fg }}
    />
  );
}

function PhosphorCover({ source, size, selected, images = true, ai: aiProp, badges = true, check, danger, chrome = screen.olive.primary }: { source?: ImageSourcePropType; size: number; selected?: boolean; images?: boolean; ai?: boolean; badges?: boolean; check?: boolean | null; danger?: boolean; chrome?: string }) {
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
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 2, borderColor: danger ? screen.red.primary : chrome }} />
        </>
      ) : null}
      {badges && images && source ? <ThumbBadges ai={ai} raw={raw} fg={chrome} /> : null}
      {check != null ? <TileCheck on={check} fg={chrome} /> : null}
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
  const box = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };
  return (
    <>
      {displayMode === 'IMMERSIVE' ? (
        <View pointerEvents="none" style={{ ...box, backgroundColor: '#808080', mixBlendMode: 'saturation' } as any} />
      ) : null}
      <View pointerEvents="none" style={{ ...box, backgroundColor: color.phosphor, mixBlendMode: 'multiply' } as any} />
    </>
  );
}

const FolderTile = memo(function FolderTile({ folder, size, selected, images, onPress, onLongPress, check, danger, dim, chrome = screen.olive.primary }: { folder: Folder; size: number; selected?: boolean; images?: boolean; onPress?: () => void; onLongPress?: () => void; check?: boolean | null; danger?: boolean; dim?: boolean; chrome?: string }) {
  // wg projektu: nazwa = Mono/Label (bold 12), podkreślona gdy zaznaczona; licznik = Mono/Caption (10).
  // KOSZ (danger) = czerwony label/licznik + czerwony glow, żeby wyróżniał się od zwykłych folderów.
  const glow = danger ? { textShadowColor: screen.red.primary, textShadowRadius: textShadow.phosphor.radius, textShadowOffset: { width: 0, height: 0 } } : phosphorGlow;
  const fg = danger ? screen.red.primary : chrome;
  const name = { fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: fg, ...glow } as const;
  const cap = { fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: fg, ...glow } as const;
  return (
    // `dim` = kafel niedostępny (w pickerze: folder ŹRÓDŁOWY — przenoszenie do samego siebie nie ma sensu)
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ width: '100%', gap: 8, opacity: dim ? 0.35 : 1 }}>
      <PhosphorCover source={folder.cover} size={size} selected={selected} images={images} badges={false} check={check} danger={danger} chrome={chrome} />
      <View style={{ gap: 4 }}>
        <Text numberOfLines={1} style={[name, selected ? { textDecorationLine: 'underline' } : null]}>{folder.name}</Text>
        {folder.count != null ? (
          <Text style={cap}>{`${folder.count} image${folder.count === 1 ? '' : 's'}`}</Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const PhotoTile = memo(function PhotoTile({ source, size, selected, images, onPress, onLongPress, check, chrome }: { source: ImageSourcePropType; size: number; selected?: boolean; images?: boolean; onPress?: () => void; onLongPress?: () => void; check?: boolean | null; chrome?: string }) {
  const ai = usePhotoAi(source); // tag lokalny lub metadane (IPTC/C2PA)
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ width: '100%' }}>
      <PhosphorCover source={source} size={size} selected={selected} images={images} ai={ai} check={check} chrome={chrome} />
    </Pressable>
  );
});

// MENU (node 360:5309) — kontekstowe menu galerii. Popover fosforowy (#E2FFE4) z ciemnym tekstem; zaznaczona
// pozycja = ciemna „pigułka" z zielonym tekstem i bulletem „•". Nawigacja joystick góra/dół + press (lub tap).
const MENU_ITEMS = ['SELECT', 'SORT', 'FILTER MEDIA', 'SHOW HIDDEN ELEMENTS', 'OPEN TRASH BIN', 'SETTINGS'] as const;
// W PODGLĄDZIE menu dotyczy pojedynczego zdjęcia, więc pozycje operujące na LIŚCIE (zaznaczanie,
// sortowanie, filtrowanie, ukrywanie) nie mają tam sensu — zostają tylko te działające zawsze.
const MENU_ITEMS_VIEWER = ['DELETE', 'OPEN TRASH BIN', 'SETTINGS'] as const;
const MENU_RISK = ['DELETE', 'EMPTY TRASH'] as const; // pozycje MENU podświetlane na czerwono po wybraniu

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
const TRASH_KEY = 'gallery_ai:trash'; // persystencja: photoKey → { src, at } (źródło + moment wyrzucenia)
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // kosz sam kasuje pliki po 30 dniach
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
 * Panel potwierdzenia / wyniku (CONFIRM czerwony, wynik fosforowy) — 1:1 z Figmą „delete prompt"
 * (plik AI+, node 134:1740). Wymiary są w projekcie PODANE WPROST, więc bierzemy je stąd, a nie na oko:
 *   • pełna szerokość treści (w projekcie 330 px), WYSOKOŚĆ STAŁA 320 px (projekt ma 240 — nasz ekran jest
 *     wyższy niż w rec_ai, więc na życzenie użytkownika panel jest odpowiednio większy),
 *   • w pionie WYŚRODKOWANY na ekranie urządzenia (odejście od `y=60` z projektu — decyzja użytkownika),
 *   • padding 16, gap 8, radius 2, tło #FF4C4C (albo fosfor), tekst #212121,
 *   • tytuł Mono/Display LG (Kode Mono 24, wyśrodkowany), podpis Mono/Body (Kode Mono 14).
 *
 * ⚠️ HISTORIA POMYŁKI: sam komponent był przepisany z rec_ai co do piksela, ale renderowaliśmy go jako
 * rodzeństwo CAŁEJ treści ekranu, czyli względem korzenia — przy `top:48 … bottom:0` dawało to pas od
 * krawędzi do krawędzi i do samego dna („dialogi są ogromne"). rec_ai wstawia go do kontenera listy, więc
 * te same liczby znaczą tam coś zupełnie innego. Dlatego renderujemy go TERAZ WEWNĄTRZ obszaru treści
 * (patrz `overlays` niżej) i trzymamy wysokość z projektu.
 */
function OverlayPanel({ tone, title, sub }: { tone: 'red' | 'phosphor'; title: string; sub?: string }) {
  const bg = tone === 'phosphor' ? screen.olive.primary : color.recordRed;
  // Nakładka musi POŁKNĄĆ dotyk: i tapnięcia, i przeciągnięcia. Sam `Pressable` blokuje tylko tapnięcia —
  // gest przewijania przechwyciłby ScrollView siatki pod spodem i lista jeździłaby pod dialogiem.
  const block = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
    }),
    []
  );
  return (
    // Warstwa na całym obszarze treści: centruje panel w pionie i połyka dotyk (patrz `block` wyżej).
    // Szerokość bierze się z układu — panel jest renderowany WEWNĄTRZ obszaru treści, jak w rec_ai.
    <View {...block.panHandlers} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'stretch', justifyContent: 'center' }}>
      <View
        style={{
          height: 320,
          borderRadius: 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          gap: 8,
        }}
      >
        <Text style={{ fontFamily: font.timer.family, fontSize: 24, lineHeight: 30, color: color.dark21, textAlign: 'center' }}>{title}</Text>
        {sub ? <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: color.dark21, textAlign: 'center' }}>{sub}</Text> : null}
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
  // choose  = fosforowy dialog wyboru (SHRED = na zawsze / TRASH = do kosza)
  // confirm = CZERWONE potwierdzenie trwałego kasowania (po tapnięciu w SHRED; przytrzymanie je pomija)
  const [delPhase, setDelPhase] = useState<'none' | 'choose' | 'confirm'>('none');
  const [holding, setHolding] = useState(false); // trwa przytrzymanie klawisza akcji → zmienia jego etykietę
  const [delMsg, setDelMsg] = useState<{ title: string; sub?: string; permanent: boolean }>({ title: '', permanent: false });

  // MOVE / COPY (Figma: siatka folderów w roli pickera). Przepływ: wybór plików → PICKER (siatka folderów,
  // klawisz NEW FOLDER) → wykonanie → panel wyniku z klawiszem OPEN. `pick.from` = folder źródłowy (tylko gdy
  // operację zaczynamy z wnętrza folderu) — jest w siatce przygaszony i nieklikalny.
  const [pick, setPick] = useState<null | { op: 'MOVE' | 'COPY'; keys: string[]; from?: string }>(null);
  const [pickIdx, setPickIdx] = useState(0);        // kursor w siatce pickera
  const [naming, setNaming] = useState(false);      // ekran nazwy nowego folderu
  const [newName, setNewName] = useState('');
  // Fokus w polu nazwy = systemowa klawiatura na ekranie → tryb „typing" (fullscreen, chowane klawisze apki —
  // wzorzec z promptu AI). Po zamknięciu klawiatury klawisze CREATE/CANCEL wracają.
  const [nameFocus, setNameFocus] = useState(false);
  const nameInputRef = useRef<TextInput>(null);
  // Prośba o „zarządzanie multimediami" (MANAGE_MEDIA) — pokazywana RAZ na uruchomienie, dokładnie w chwili,
  // gdy jest potrzebna (pierwsze MOVE / trwałe kasowanie), zamiast wiersza w ustawieniach. Trzyma zawieszoną
  // operację, żeby po powrocie z ekranu systemowego dokończyć ją bez powtarzania całej ścieżki.
  // (Ten sam przepływ co dawne „ALLOW FILE ACCESS?" z 0.968 — zmieniło się tylko uprawnienie pod spodem.)
  const [accessAsk, setAccessAsk] = useState<null | { run: () => void }>(null);
  const accessAsked = useRef(false);

  // KURSOR chowany podczas swipe-follow i przytrzymania joysticka (wraca po zatrzymaniu). Nie zmienia `selected`,
  // tylko renderowaną ramkę (auto-scroll dalej działa na realnym `selected`).
  const [cursorHidden, setCursorHidden] = useState(false);

  // KOSZ — soft-delete. Mapa photoKey → źródło (pełny obiekt), persystowana. Filtruje feed/foldery; wnętrze
  // folderu TRASH pokazuje właśnie te źródła. Trwałe kasowanie (media.deleteItems) dopiero z wnętrza kosza.
  // KOSZ: photoKey → { src, at }. `at` = moment wyrzucenia, potrzebny do automatycznego kasowania po 30 dniach.
  const [trashed, setTrashed] = useState<Record<string, { src: ImageSourcePropType; at: number }>>({});
  const trashLoaded = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(TRASH_KEY).then((raw) => {
      if (raw) {
        try {
          const p = JSON.parse(raw);
          if (p && typeof p === 'object') {
            // MIGRACJA starego formatu (sam obiekt źródła, bez daty) — wpisom bez `at` nadajemy „teraz",
            // żeby po aktualizacji nic nie wyparowało z kosza natychmiast.
            const now = Date.now();
            const out: Record<string, { src: ImageSourcePropType; at: number }> = {};
            for (const [k, v] of Object.entries(p as Record<string, any>)) {
              out[k] = v && typeof v === 'object' && 'src' in v ? v : { src: v, at: now };
            }
            setTrashed(out);
          }
        } catch { /* uszkodzone → pusty kosz */ }
      }
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
  // ADDED ↓ = data MODYFIKACJI (kiedy plik trafił do tego folderu), a nie zrobienia zdjęcia. Bez tego trybu
  // świeżo PRZENIESIONY plik ginie: przenoszenie nie rusza DATE_TAKEN, więc ląduje w środku listy według
  // swojej starej daty, podczas gdy menedżery plików pokazują go na górze (sortują po modyfikacji).
  const SORTS = ['DATE ↓', 'DATE ↑', 'ADDED ↓', 'NAME A-Z', 'NAME Z-A'] as const;
  const [sortMode, setSortMode] = useState(0);
  // FILTER MEDIA — co pokazujemy w feedzie i we wnętrzu folderu. Wideo trafiło do biblioteki razem ze
  // zdjęciami (useMedia pyta o IMAGE + VIDEO), więc filtr jest jedyną drogą, żeby zobaczyć same filmy
  // albo same zdjęcia. Kolejność cyklu jak w SORT: klawisz przełącza, menu zostaje otwarte.
  const MEDIA_FILTERS = ['ALL', 'PHOTOS', 'VIDEOS'] as const;
  const [mediaFilter, setMediaFilter] = useState(0);
  const passesMedia = (s: any) => mediaFilter === 0 || (mediaFilter === 2 ? !!s?.video : !s?.video);
  const feedRaw = useRef<ImageSourcePropType[]>([]);
  const photosRaw = useRef<ImageSourcePropType[]>([]);
  const sortPhotos = (arr: ImageSourcePropType[], mode: number): ImageSourcePropType[] => {
    if (mode === 0) return arr; // najnowsze pierwsze — tak zwraca loadPhotos (orderBy CREATION_TIME desc)
    const key = (s: any) =>
      mode >= 3 ? String(s?.filename ?? '').toLowerCase()
        : mode === 2 ? (s?.modificationTime ?? s?.creationTime ?? 0)
          : (s?.creationTime ?? 0);
    const sorted = [...arr].sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    // rosnąco: 1=DATE↑ i 3=NAME A-Z; malejąco (reverse): 2=ADDED↓ i 4=NAME Z-A
    return mode === 1 || mode === 3 ? sorted : sorted.reverse();
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
  const trashValues = useMemo(() => Object.values(trashed).map((t) => t.src), [trashed]);

  // OKŁADKI I LICZNIKI vs KOSZ. Kosz jest funkcją APKI (filtrujemy listy zdjęć), a okładka i licznik folderu
  // pochodzą wprost z MediaStore, który o nim nic nie wie — wyrzucone zdjęcie zostawało więc na kaflu folderu,
  // z którego je wyrzucono, i wliczało się do licznika. Dla folderów, których okładka wylądowała w koszu,
  // dociągamy listę zdjęć raz i podmieniamy okładkę na najnowsze NIE-wyrzucone (przy okazji poprawiając licznik).
  const [coverFix, setCoverFix] = useState<Record<string, { cover: ImageSourcePropType | null; count: number }>>({});
  const coverBroken = (f: Folder) => !!f.cover && f.id !== TRASH_ID && trashedKeys.has(photoKey(f.cover));
  useEffect(() => {
    if (!media || DESIGN) return;
    // odświeżamy też wtedy, gdy podmieniona okładka SAMA wylądowała potem w koszu (kolejne wyrzucanie z rzędu)
    const need = applyLibraryFilter(allFolders, included, excluded).filter((f) => {
      if (!coverBroken(f)) return false;
      const fix = coverFix[f.id];
      return !fix || (fix.cover != null && trashedKeys.has(photoKey(fix.cover)));
    });
    if (!need.length) return;
    let cancelled = false;
    (async () => {
      for (const f of need) {
        try {
          const ps = await media.loadPhotos(f.id);
          const live = ps.filter((sr) => !trashedKeys.has(photoKey(sr)));
          if (!cancelled) setCoverFix((m) => ({ ...m, [f.id]: { cover: live[0] ?? null, count: live.length } }));
        } catch { /* nie udało się — kafel zostaje jak był */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFolders, included, excluded, trashedKeys, media]);

  const folders: Folder[] = useMemo(() => {
    let base = applyLibraryFilter(allFolders, included, excluded);
    if (!showHidden) base = base.filter((f) => !hidden.includes(f.id));
    // podmiana działa TYLKO dopóki oryginalna okładka jest w koszu → po RESTORE kafel wraca sam, bez czyszczenia cache
    base = base
      .map((f) => {
        const fix = coverBroken(f) ? coverFix[f.id] : undefined;
        if (!fix) return f;
        const fresh = fix.cover != null && !trashedKeys.has(photoKey(fix.cover)) ? fix.cover : undefined;
        return { ...f, cover: fresh, count: fix.count } as Folder;
      })
      // Folder, z którego wszystko poszło do kosza, znika z listy. Na dysku pliki jeszcze są, więc MediaStore
      // nadal go zna — pustkę widzimy dopiero po odfiltrowaniu kosza (fix.count). Albumy bez zdjęć w ogóle
      // odsiewa już `useMedia` przy wczytywaniu.
      .filter((f) => f.count !== 0);
    if (sortMode >= 2) { base = [...base].sort((a, b) => a.name.localeCompare(b.name)); if (sortMode === 3) base.reverse(); } // NAME A-Z / Z-A
    // KOSZ — syntetyczny folder na końcu, TYLKO gdy NIEPUSTY (pusty → niewidoczny). Okładka = ostatnio wyrzucone;
    // licznik = liczba w koszu. Nawigacja/otwieranie jak zwykły folder (id=TRASH_ID → wnętrze z `trashed`).
    if (trashValues.length > 0) {
      base = [...base, { id: TRASH_ID, name: 'TRASH', cover: trashValues[trashValues.length - 1], count: trashValues.length } as Folder];
    }
    return base;
  }, [allFolders, included, excluded, hidden, showHidden, sortMode, trashValues, trashedKeys, coverFix]);

  // Po WYJŚCIU z folderu kursor wraca NA TEN FOLDER, nie na początek listy. Zapamiętujemy jego id (nie indeks),
  // bo po `media.reload()` kolejność albumów potrafi się zmienić. Efekt przelicza to tylko przy realnej zmianie
  // `openFolder` — zmiana samej listy folderów (np. odświeżenie okładek) nie rusza kursora w ROOT.
  const leftFolderId = useRef<string | null>(null);
  const prevOpenFolder = useRef<number | null>(null);

  // wejście/wyjście z folderu → kursor (wejście: pierwszy element, wyjście: opuszczony folder) + załaduj zdjęcia
  useEffect(() => {
    const prev = prevOpenFolder.current;
    prevOpenFolder.current = openFolder;
    if (openFolder != null) {
      leftFolderId.current = folders[openFolder]?.id ?? null;
      if (prev !== openFolder) setSelected(0);
    } else if (prev != null) {
      const back = leftFolderId.current ? folders.findIndex((f) => f.id === leftFolderId.current) : -1;
      setSelected(back >= 0 ? back : 0);
    }
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
    () => (isTrashOpen ? trashValues : photos.filter((s) => !trashedKeys.has(photoKey(s)) && passesMedia(s))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTrashOpen, trashValues, photos, trashedKeys, mediaFilter]
  );
  // KOSZ filtra NIE stosuje — tam ma być widać wszystko, co czeka na skasowanie, niezależnie od typu.
  const feedView = useMemo(
    () => feedPhotos.filter((s) => !trashedKeys.has(photoKey(s)) && passesMedia(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feedPhotos, trashedKeys, mediaFilter]
  );
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

  // Przesunięcie CENTRUJĄCE wiersz, przycięte do zera. `scrollToIndex(viewPosition: 0.5)` dla pierwszych
  // wierszy wylicza ujemny offset i lista zatrzymuje się w POŁOWIE kafla zamiast na samej górze — widać to
  // było po wyjściu z folderu stojącego na początku listy. Liczymy więc offset sami i przycinamy.
  const centeredOffset = (row: number) => Math.max(0, rowHeight * row - Math.max(0, (gridViewH - rowHeight) / 2));

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
    const raf = requestAnimationFrame(() => { try { listRef.current?.scrollToOffset({ offset: centeredOffset(row), animated: false }); } catch {} });
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
    try { listRef.current?.scrollToOffset({ offset: centeredOffset(Math.floor(idx / cols)), animated: true }); } catch {}
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
  const [viewerPlace, setViewerPlace] = useState<string | null>(null);

  // NAKŁADKI (potwierdzenie/wynik/pytanie o dostęp) — jeden fragment wstawiany w każdą gałąź treści na
  // poziomie EKRANU, bo panel centruje się w pionie względem całego ekranu urządzenia.
  // Treść i menu pod dialogiem WYGASZONE do 25% — wartość Z PROJEKTU, jedna dla całej apki (tyle samo co pod
  // otwartym menu). UWAGA: kod rec_ai ma w tym miejscu 0.35 i odbiega od makiety — nie brać go tu za wzorzec.
  const dialogOpen = delPhase !== 'none' || !!accessAsk;
  const overlays = (
    <>
      {/* kolor panelu wg FAZY (nie wg trwałości): pytanie = czerwone, wynik = fosforowy */}
      {delPhase !== 'none' ? (
        // Czerwień włącza się już w MOMENCIE ROZPOCZĘCIA przytrzymania SHRED (nie dopiero po nim): trzymasz
        // klawisz i od razu widzisz, że to nieodwracalne. Puszczenie przed czasem wraca do fosforu.
        <OverlayPanel
          tone={delPhase === 'confirm' || (delPhase === 'choose' && holding) ? 'red' : 'phosphor'}
          title={delMsg.title}
          // Ostrzeżenie pojawia się RAZEM z czerwienią, czyli już w chwili rozpoczęcia przytrzymania — a nie
          // dopiero na ekranie potwierdzenia. Trzymasz klawisz i od razu czytasz, co się właśnie dzieje.
          sub={delPhase === 'choose' && holding ? 'THIS CANNOT BE UNDONE' : delMsg.sub}
        />
      ) : null}
      {accessAsk ? <OverlayPanel tone="phosphor" title="ALLOW MEDIA MANAGEMENT?" sub="WITHOUT IT ANDROID ASKS FOR CONFIRMATION ON EVERY MOVE AND DELETE" /> : null}
    </>
  );

  // sąsiedzi bieżącego zdjęcia — pager podglądu montuje je obok, żeby swipe pokazywał, co nadjeżdża
  const viewerList = momentsMode ? momentsView : feedMode ? feedView : photosView;
  const editor = useImageEditor({
    source: currentSource,
    prevSource: viewerList[selected - 1],
    nextSource: viewerList[selected + 1],
    open: viewerOpen,
    overlay: overlays, // panel siedzi w obszarze treści podglądu — ta sama szerokość co nad siatką
    dimmed: dialogOpen, // przygaszenie dotyczy TREŚCI podglądu, nie panelu (ten jest renderowany obok niej)
    place: viewerPlace,
    onExit: closeViewer,
    onPrev: () => move(-1),
    onNext: () => move(1),
    onOpenSettings,
    onMenu: () => toggleMenu(), // klawisz MENU w podglądzie → kontekstowe menu galerii
    // press joysticka / pinch-out → IMMERSIVE. Dla WIDEO nie wchodzimy: nakładka pełnoekranowa rysuje
    // klatkę przez expo-image i nie ma czym sterować odtwarzaniem — film ogląda się w zwykłym podglądzie.
    onRequestImmersive: (currentSource as any)?.video ? undefined : () => setImmersiveOpen(true),
    leftHanded,
    promptBooster,
  });

  // LOKALIZACJA dla panelu INFO. ⚠️ PERF: `placeOfAsset` to NIE jest tania operacja — czyta EXIF assetu
  // (otwarcie strumienia pliku) i robi reverseGeocode (usługa systemowa/sieć). Wcześniej leciało przy KAŻDEJ
  // zmianie `currentSource`, czyli przy każdym swipie między zdjęciami → chrupanie przewijania. Teraz jak
  // prowieniencja w EditorScreen: tylko gdy panel INFO jest OTWARTY (bez panelu nikt tego nie ogląda) i po
  // 350 ms ciszy — przy szybkim przewijaniu żadne zapytanie nie startuje.
  useEffect(() => {
    setViewerPlace(null);
    if (!viewerOpen || !editor.info.open || !media || DESIGN) return;
    const id = (currentSource as any)?.uri; if (!id) return;
    let cancelled = false;
    const t = setTimeout(() => {
      media.placeOfAsset(id).then((pl) => { if (!cancelled) setViewerPlace(pl); }).catch(() => {});
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerOpen, currentSource, editor.info.open]);

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
  // MOVE TO / COPY TO działają na PLIKU, więc tylko tam, gdzie jest realny plik i realna biblioteka:
  // nie w widoku folderów, nie w koszu (tam pliki są „usunięte") i nie na webie (mock).
  const canFileOps = !DESIGN && !!media && !isTrashOpen && (viewerOpen || inFileGrid);
  const FILE_OPS = canFileOps ? (['MOVE TO', 'COPY TO'] as const) : ([] as const);
  const menuItems: readonly string[] = viewerOpen
    ? [...FILE_OPS, ...MENU_ITEMS_VIEWER]
    // KOSZ ma własny, krótki zestaw: nie ma tu co sortować, filtrować ani przenosić — pliki czekają
    // wyłącznie na przywrócenie albo skasowanie (i tak znikną same po 30 dniach).
    : isTrashOpen
      ? ['SELECT', 'EMPTY TRASH', 'RESTORE ALL']
      : inFileGrid
        ? ['SELECT', ...FILE_OPS, 'DELETE', 'SORT', 'FILTER MEDIA', 'SHOW HIDDEN ELEMENTS', 'OPEN TRASH BIN', 'SETTINGS']
        : MENU_ITEMS;
  const menuMove = (d: number) => setMenuIndex((i) => (i + d + menuItems.length) % menuItems.length);
  const pickMenu = (i: number) => {
    const item = menuItems[i];
    // SORT i SHOW HIDDEN działają „w miejscu" — menu ZOSTAJE otwarte (można cyklować / od razu zobaczyć efekt).
    if (item === 'SORT') { const m = (sortMode + 1) % SORTS.length; setSortMode(m); showMenuToast(`SORT: ${SORTS[m]}`); return; }
    if (item === 'FILTER MEDIA') { const m = (mediaFilter + 1) % MEDIA_FILTERS.length; setMediaFilter(m); showMenuToast(`FILTER: ${MEDIA_FILTERS[m]}`); return; }
    if (item === 'SHOW HIDDEN ELEMENTS') { const next = !showHidden; setShowHidden(next); showMenuToast(next ? 'SHOWING HIDDEN' : 'HIDING HIDDEN'); return; }
    setMenuOpen(false);
    if (item === 'SELECT') { enterSelect(viewerOpen ? undefined : selected); return; } // wejście w tryb zaznaczania (zaznacz bieżący)
    if (item === 'OPEN TRASH BIN') { const ti = folders.findIndex((f) => f.id === TRASH_ID); if (ti >= 0) { setFeedMode(false); setOpenFolder(ti); } else showMenuToast('TRASH EMPTY'); return; }
    if (item === 'DELETE') { deleteCurrent(); return; }
    if (item === 'EMPTY TRASH') {
      const all = Object.keys(trashed);
      if (!all.length) { showMenuToast('TRASH EMPTY'); return; }
      setSelectedIds(new Set(all));
      setDelMsg({ title: `DELETE ${all.length} FOREVER?`, sub: 'THIS CANNOT BE UNDONE', permanent: true });
      setDelPhase('confirm');
      return;
    }
    if (item === 'RESTORE ALL') {
      const all = Object.keys(trashed);
      if (!all.length) { showMenuToast('TRASH EMPTY'); return; }
      restoreFromTrash(all);
      showMenuToast(`${all.length} RESTORED`);
      return;
    }
    // MOVE TO / COPY TO z MENU dotyczą POJEDYNCZEGO elementu (bieżące zdjęcie w podglądzie lub pod kursorem)
    if (item === 'MOVE TO' || item === 'COPY TO') {
      const k = keyOfIndex(selected);
      if (k) startPick(item === 'MOVE TO' ? 'MOVE' : 'COPY', [k]);
      return;
    }
    if (item === 'SETTINGS') { onOpenSettings?.(); return; }
  };
  // etykiety menu (dynamiczne: SHOW ⇄ HIDE HIDDEN wg stanu)
  const menuLabels = menuItems.map((l) => (l === 'SHOW HIDDEN ELEMENTS' ? (showHidden ? 'HIDE HIDDEN ELEMENTS' : 'SHOW HIDDEN ELEMENTS') : l));
  // zmiana kontekstu (wejście/wyjście z podglądu) skraca listę → zaznaczenie mogłoby wypaść poza zakres
  useEffect(() => { setMenuIndex((i) => Math.min(i, menuItems.length - 1)); }, [menuItems.length]);

  // ── TRYB ZAZNACZANIA ────────────────────────────────────────────────────────────────────────────
  const curList: any[] = momentsMode ? momentsView : feedMode ? feedView : inside ? photosView : folders;
  // ROOT = lista folderów. MOMENTS to widok PLIKÓW (jak feed), więc musi być tu uwzględniony — bez tego
  // apka brała go za listę folderów i `keyOfIndex` nie zwracał klucza pliku, przez co kasowanie z MENU
  // po cichu nic nie robiło (a zaznaczanie i long-press też były zablokowane).
  const isFolderView = !feedMode && !momentsMode && !inside;
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
    if (added.length) {
      const at = Date.now();
      setTrashed((t) => ({ ...t, ...Object.fromEntries(Object.entries(add).map(([k, v]) => [k, { src: v, at }])) }));
    }
    return added;
  };
  const restoreFromTrash = (keys: string[]) => setTrashed((t) => { const nx = { ...t }; keys.forEach((k) => delete nx[k]); return nx; });
  /**
   * TRWAŁE kasowanie. Od 0.969 (bez „dostępu do wszystkich plików") Android pyta o zgodę systemowym oknem,
   * więc ODMOWA JEST NORMALNYM WYNIKIEM i nie wolno wtedy czyścić wpisu w koszu. Poprzednia wersja robiła
   * `setTrashed` bezwarunkowo — użytkownik klikał „Nie zezwalaj", a zdjęcie i tak znikało z kosza i wracało
   * do galerii: kosz kłamał, że plik został skasowany. Zwracamy klucze, które FAKTYCZNIE zniknęły.
   */
  const deleteForever = async (keys: string[]): Promise<string[]> => {
    // ROOT (foldery) → keys to album-id (Album.delete); feed/wnętrze/kosz → keys to content:// URI (Asset.delete)
    const gone = (await (isFolderView ? media?.deleteItems([], keys) : media?.deleteItems(keys, []))) ?? [];
    if (!gone.length) return gone;
    setTrashed((t) => { const nx = { ...t }; gone.forEach((k) => delete nx[k]); return nx; });
    media?.reload(); // odśwież okładki/liczniki albumów po trwałym skasowaniu
    return gone;
  };

  // Kosz sam się opróżnia: wpisy starsze niż 30 dni kasujemy TRWALE — ale DOPIERO PRZY WEJŚCIU DO KOSZA,
  // nie przy starcie apki. Bez „dostępu do wszystkich plików" kasowanie pokazuje systemowe okno zgody, a
  // odpalane ze startu wyskakiwałoby użytkownikowi na powitanie, bez żadnego kontekstu. W koszu widzi, czego
  // okno dotyczy. Odmowa = wpisy zostają do następnego wejścia (czyści je `deleteForever`, i tylko te realne).
  const purgedOnce = useRef(false);
  useEffect(() => {
    if (!isTrashOpen || purgedOnce.current || !trashLoaded.current) return;
    const stale = Object.entries(trashed).filter(([, v]) => Date.now() - v.at > TRASH_TTL_MS).map(([k]) => k);
    if (!stale.length) return;
    // Zapowiedź PRZED kasowaniem: zaraz może wyskoczyć systemowe okno zgody na pliki, których użytkownik
    // w tej sesji nie tknął — bez tej informacji wyglądałoby jak okno znikąd.
    showMenuToast(`EMPTYING ${stale.length} EXPIRED ITEM${stale.length > 1 ? 'S' : ''}`, 3000);
    void deleteForever(stale).then((gone) => {
      // Zatrzask DOPIERO po realnym skasowaniu. Gdyby leciał przed await, odmowa w oknie zgody blokowałaby
      // ponowną próbę aż do restartu apki — a komentarz obok obiecuje, że wpisy czekają do następnego wejścia.
      if (gone.length === stale.length) purgedOnce.current = true; // częściowy wynik → resztę spróbujemy znowu
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTrashOpen]);

  // USUWANIE — potwierdzenie (overlay) → wykonanie → wynik (auto-znika, 2,5 s → wyjście z trybu). Poza koszem =
  // przeniesienie do kosza (odwracalne, UNDO); w koszu = TRWAŁE (czerwony overlay). (wzorzec rec_ai delete flow)
  const lastMoved = useRef<string[]>([]);
  /** Etykieta celu operacji: „NAZWA.JPG" dla jednego pliku, „N FILES" dla paczki. */
  const targetLabel = (keys: string[]): string => {
    if (keys.length !== 1) return `${keys.length} FILES`;
    const src = curList.find((it) => it != null && photoKey(it as ImageSourcePropType) === keys[0]) as any;
    const name = src?.filename ?? trashed[keys[0]]?.src ? (src?.filename ?? (trashed[keys[0]]?.src as any)?.filename) : null;
    return name ? `"${String(name).toUpperCase()}"` : '1 FILE';
  };
  // MOVE TO BIN = soft-delete (do kosza, odwracalne + UNDO). DELETE = TRWAŁE (czerwone potwierdzenie).
  /** Do kosza BEZ pytania — operacja odwracalna, więc potwierdzenie byłoby zbędnym klikiem. Zostaje toast. */
  const trashNow = async (keys: string[]) => {
    if (!keys.length) { showMenuToast('NOTHING SELECTED'); return; }
    const label = targetLabel(keys);
    setDelPhase('none');
    lastMoved.current = await moveToTrash(keys);
    setSelectedIds(new Set());
    setSelectMode(false);
    setViewerOpen(false);
    showMenuToast(`${label} MOVED TO TRASH`, 2500);
  };
  /** DELETE = fosforowy dialog z wyborem: SHRED (na zawsze) albo TRASH (do kosza). W koszu od razu trwałe. */
  const askDelete = (keys: string[]) => {
    if (!keys.length) { showMenuToast('NOTHING SELECTED'); return; }
    const label = targetLabel(keys);
    if (isTrashOpen) { setDelMsg({ title: `DELETE ${label} FOREVER?`, sub: 'THIS CANNOT BE UNDONE', permanent: true }); setDelPhase('confirm'); return; }
    setDelMsg({ title: `DELETE ${label}`, permanent: false });
    setDelPhase('choose');
  };
  const askTrash = () => trashNow(Array.from(selectedIds));
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
    askDelete([k]);
  };
  // SHRED = kasowanie TRWAŁE. Przytrzymanie klawisza odpala je od razu; samo tapnięcie prowadzi najpierw do
  // CZERWONEGO potwierdzenia — akcja jest nieodwracalna, więc jeden świadomy gest to za mało.
  const askShred = () => {
    setDelMsg((m) => ({ ...m, permanent: true, sub: 'THIS CANNOT BE UNDONE', title: `${m.title} FOREVER?` }));
    setDelPhase('confirm');
  };
  const shredNow = () => {
    setDelMsg((m) => ({ ...m, permanent: true }));
    void confirmDelete(true);
  };
  // `permanentOverride` — bo `setDelMsg` jest asynchroniczne: przy przytrzymaniu SHRED wywołujemy kasowanie
  // w tej samej klatce, w której ustawiamy flagę, więc odczyt ze stanu byłby jeszcze nieaktualny.
  const confirmDelete = async (permanentOverride?: boolean) => {
    const permanent = permanentOverride ?? delMsg.permanent;
    const keys = Array.from(selectedIds);
    const label = targetLabel(keys);
    setHolding(false);
    // Trwałe kasowanie cudzych zdjęć bez MANAGE_MEDIA = systemowe okno. Pytamy WCZEŚNIEJ, żeby ścieżka nie
    // wyglądała tak: okno systemu → dopiero potem prośba o przełącznik, który by je wyłączył.
    if (permanent && needsAccessAsk()) {
      setDelPhase('none');
      setAccessAsk({ run: () => { void confirmDelete(permanent); } });
      return;
    }
    // Po potwierdzeniu zostaje sam TOAST — panel wyniku niczego już nie wnosił: decyzja jest podjęta, a UNDO
    // przy trwałym kasowaniu i tak nie istnieje. Kosz ma własne cofnięcie (RESTORE), więc i tam panel zbędny.
    setDelPhase('none');
    setSelectedIds(new Set());
    setSelectMode(false);
    setViewerOpen(false);
    const gone = await deleteForever(keys);
    // Paczka bywa mieszana (nasze pliki lecą bez pytania, cudze przez jedno okno), więc wynik CZĘŚCIOWY jest
    // normalny — i musi być powiedziany wprost, bo reszta zdjęć zostaje widoczna w koszu.
    showMenuToast(
      gone.length === 0 ? 'DELETE CANCELLED'
        : gone.length < keys.length ? `${gone.length} OF ${keys.length} DELETED`
          : `${label} DELETED`,
      3000
    );
  };
  const cancelDelete = () => { setHolding(false); setDelPhase('none'); };

  // ── MOVE / COPY ─────────────────────────────────────────────────────────────────────────────────
  // Cel wybiera się w SIATCE FOLDERÓW (ten sam widok co ROOT). Wybór folderu JEST potwierdzeniem — operacje
  // nie niszczą danych, więc dodatkowe pytanie byłoby zbędnym klikiem; wynik leci toastem.
  const startPick = (op: 'MOVE' | 'COPY', keys: string[]) => {
    if (!keys.length) { showMenuToast('NOTHING SELECTED'); return; }
    if (!DESIGN && !media) { showMenuToast('NOT AVAILABLE HERE'); return; }
    setMenuOpen(false); setViewerOpen(false); setImmersiveOpen(false); setCursorHidden(false);
    const from = inside && !isTrashOpen ? folders[openFolder!]?.id : undefined;
    setPick({ op, keys, from });
    // kursor startuje na pierwszym MOŻLIWYM celu — gdyby stanął na folderze źródłowym (przygaszonym),
    // pierwsze naciśnięcie joysticka nic by nie robiło
    const targets = folders.filter((f) => f.id !== TRASH_ID);
    setPickIdx(Math.max(0, targets.findIndex((f) => f.id !== from)));
    setNaming(false); setNewName(''); setNameFocus(false);
  };
  const cancelPick = () => { setPick(null); setNaming(false); setNewName(''); setNameFocus(false); };
  // KOSZ nie jest celem (to widok soft-delete, nie folder na dysku); folder źródłowy zostaje widoczny, ale przygaszony.
  const pickTargets = useMemo(() => folders.filter((f) => f.id !== TRASH_ID), [folders]);
  const chooseTarget = (i: number) => {
    const f = pickTargets[i];
    if (!f || f.id === pick?.from) return; // folder źródłowy = brak operacji
    void runFileOp(f.id);
  };
  const pickMove = (d: number) => setPickIdx((i) => Math.max(0, Math.min(pickTargets.length - 1, i + d)));
  const pickListRef = useRef<any>(null); // siatka celów podąża za kursorem (jak siatka folderów w ROOT)
  useEffect(() => {
    if (!pick || naming) return;
    const row = Math.floor(pickIdx / galleryCols);
    const raf = requestAnimationFrame(() => { try { pickListRef.current?.scrollToIndex({ index: row, animated: false, viewPosition: 0.5 }); } catch {} });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickIdx, pick, naming]);
  // nazwa nowego folderu: znaki wg walidatora MediaStore + brak kolizji z istniejącym folderem (inaczej
  // operacja po cichu dolałaby pliki do cudzego albumu — patrz createAlbumWith)
  const nameTaken = useMemo(
    () => folders.some((f) => f.name.trim().toLowerCase() === newName.trim().toLowerCase()),
    [folders, newName]
  );
  const nameOk = isValidAlbumName(newName) && !nameTaken;

  // Czy pytać o MANAGE_MEDIA: Android 12+, przełącznik wyłączony, w tym uruchomieniu jeszcze nie pytaliśmy.
  // Raz na URUCHOMIENIE, nie raz na zawsze: trwała flaga sprawiłaby, że jedno SKIP odcina przyznanie na stałe
  // (wiersza w ustawieniach apki nie ma).
  const needsAccessAsk = () => !DESIGN && !accessAsked.current && mediaManageSupported() && !canManageMedia();
  const awaitingAccess = useRef(false); // wyszliśmy do ustawień systemu i czekamy na powrót
  const finishAccessAsk = (grant: boolean) => {
    const pending = accessAsk;
    accessAsked.current = true;
    if (!pending) { setAccessAsk(null); return; }
    if (grant && openMediaManageSettings()) { awaitingAccess.current = true; return; } // dokończymy po powrocie
    setAccessAsk(null);
    pending.run();
  };
  // Powrót z ekranu systemowego → dokańczamy zawieszoną akcję (z przełącznikiem albo bez, jak zdecydował user).
  // Restart nie jest potrzebny: stan przełącznika system sprawdza przy każdej prośbie, nie przy starcie procesu.
  useEffect(() => {
    if (!accessAsk) return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !awaitingAccess.current) return;
      awaitingAccess.current = false;
      const pending = accessAsk;
      setAccessAsk(null);
      pending.run();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessAsk]);

  /** Brama uprawnienia: MOVE kasuje oryginał, a bez MANAGE_MEDIA system pyta o zgodę przy każdym takim kasowaniu. */
  const runFileOp = async (targetId: string | null, name?: string) => {
    if (!pick) return;
    const { op, keys } = pick;
    if (op === 'MOVE' && needsAccessAsk()) {
      setPick(null); setNaming(false); setNewName(''); setNameFocus(false);
      setAccessAsk({ run: () => { void execFileOp(op, keys, targetId, name); } });
      return;
    }
    await execFileOp(op, keys, targetId, name);
  };

  /** Właściwe wykonanie. `name` ≠ null → najpierw powstaje nowy folder; inaczej cel = istniejący album. */
  const execFileOp = async (op: 'MOVE' | 'COPY', keys: string[], targetId: string | null, name?: string) => {
    const total = keys.length;
    const targetName = (name ?? folders.find((f) => f.id === targetId)?.name ?? '').toUpperCase();
    setPick(null); setNaming(false); setNewName(''); setNameFocus(false);
    // MOVE i COPY nic nie niszczą, więc nie zasłaniamy ekranu panelem — wystarczy toast. Postęp też idzie
    // toastem (obie operacje przepisują pliki po kolei, patrz mediaOps); długi czas życia komunikatu jest po
    // to, żeby nie zgasł w trakcie — każdy kolejny go nadpisuje.
    const verbIng = op === 'MOVE' ? 'MOVING' : 'COPYING';
    const HOLD = 120000;
    showMenuToast(`${verbIng} 0/${total}…`, HOLD);
    const onProgress = (done: number, n: number) => showMenuToast(`${verbIng} ${done}/${n}…`, HOLD);
    let res: MediaOpResult;
    if (DESIGN) {
      showMenuToast('PREVIEW ONLY — FILE OPS WORK ON DEVICE', 2500); // web = mock, plików nie ruszamy
      return;
    }
    if (name) res = await createAlbumWith(name, keys, op, onProgress);
    else if (op === 'MOVE') res = await moveToAlbum(keys, targetId!, onProgress);
    else res = await copyToAlbum(keys, targetId!, onProgress);

    const verb = op === 'MOVE' ? 'MOVED' : 'COPIED';
    if (res.ok === 0) {
      // odmowa systemowego dialogu albo błąd — zaznaczenie ZOSTAJE (można spróbować z innym celem)
      showMenuToast(`CANCELLED — NOTHING ${verb}`, 3000);
      return;
    }
    showMenuToast(`${verb} ${res.ok}${res.fail ? ` OF ${total}` : ''} → ${targetName}`, 3000);
    setSelectedIds(new Set());
    setSelectMode(false);
    media?.reload(); // okładki i liczniki albumów się zmieniły
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
      const a = SUB_ACTION[i];
      if (a === 'DELETE') askDelete(Array.from(selectedIds));          // DELETE → dialog wyboru: SHRED / TRASH
      else startPick(a as 'MOVE' | 'COPY', Array.from(selectedIds));    // MOVE/COPY → picker folderu docelowego
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
  // PION przełącza poziomy (obok press/tap i BACK): GÓRA wchodzi głębiej, DÓŁ cofa — patrz onUp/onDown.
  // Wyjątek: gdy sterowanie jest na SIATCE (focus 2), pion nawiguje kafle, a powrót do menu = CONFIRM.

  // back: kolejno zamknij MENU → (edytor: menu edycji/pod-widok, a na końcu podgląd) → folder → feed
  const goBack = () => {
    if (accessAsk) { setAccessAsk(null); return true; }        // prośba o przełącznik = anulowanie operacji
    if (naming) { setNaming(false); setNewName(''); setNameFocus(false); return true; } // nazwa nowego folderu → wróć do siatki celów
    if (pick) { cancelPick(); return true; }                            // picker → wróć do zaznaczenia/siatki
    if (delPhase === 'confirm' || delPhase === 'choose') { cancelDelete(); return true; }
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
  // W multiselekcie content_area dostaje fosforową RAMKĘ (Figma 460:2831): fosforowe tło pokazuje się
  // w odstępach między miniaturami, a ujemny margines rozszerza je NA ZEWNĄTRZ o gap/2 → ramka szerokości
  // gapu (gap/2 z paddingu kafla + gap/2 z marginesu). Siatka NIE kurczy się (brak reflow przy wejściu).
  const SEL_FRAME = PHOTO_GAP / 2;
  // Fosfor kafli skompensowany pod filtr; W KOSZU cały akcent jest CZERWONY (jak kafel TRASH w ROOT).
  // Czerwieni nie kompensujemy: żeby po przemnożeniu wyszło #FF4C4C, kanał R musiałby startować powyżej 255.
  const chromeFg = isTrashOpen ? screen.red.primary : chromePhosphor(displayMode, diag.filter);
  const SEL_GAP = 2;                              // odstęp między ramką multiselekcji a siatką
  const SEL_OUT = PHOTO_GAP - SEL_FRAME + SEL_GAP; // o tyle ramka wystaje na zewnątrz kontenera (8-4+2 = 6)
  const gw = contentW;
  const itemWidth = gw > 0 ? Math.floor(gw / cols) : 0;
  const imgSize = itemWidth > 0 ? itemWidth - gap : 0;
  const rowHeight = imgSize + gap + (inside ? 0 : 34); // +podpis dla folderów (getItemLayout → pewny scrollToIndex)

  // FOLDERS/wnętrze folderu (FlatList): kursor PODĄŻA za swipem (kafel w środku pionowym; 3 kol.→środek, 2 kol.→lewa).
  // userScrolling tylko z realnego drag (onScrollBeginDrag) — programowy scrollToIndex nie blokuje wtedy auto-scrollu.
  const gridPendingSel = useRef<number | null>(null); // kafel pod środkiem — ustawiany w `selected` DOPIERO po zatrzymaniu
  // Koniec przewijania: pokaż kursor z powrotem i ustaw go na kaflu, który wyszedł na środek.
  const gridSettle = () => {
    gridScrolling.current = false; setCursorHidden(false);
    if (gridPendingSel.current != null && gridPendingSel.current !== selected) { gridSkipAuto.current = true; setSelected(gridPendingSel.current); }
    gridPendingSel.current = null;
  };
  const scheduleGridSettle = (ms = 160) => {
    if (gridScrollT.current) clearTimeout(gridScrollT.current);
    gridScrollT.current = setTimeout(gridSettle, ms);
  };
  const onGridScrollBeginDrag = () => { gridScrolling.current = true; scrollFlag.at = Date.now(); setCursorHidden(true); if (gridScrollT.current) clearTimeout(gridScrollT.current); };
  const onGridScroll = (e: { nativeEvent: { contentOffset: { y: number } } }) => {
    scrollFlag.at = Date.now(); // PerfHud: patrz FeedGrid.onScroll
    if (!gridScrolling.current || gridViewH <= 0 || rowHeight <= 0 || n <= 0) return;
    // PERF: kursor schowany podczas swipe → NIE wołamy setSelected na każde zdarzenie (re-render całego ekranu
    // ~30×/s = okresowe spadki fps). Zapamiętujemy kafel pod środkiem, ustawiamy `selected` RAZ po zatrzymaniu.
    const y = e.nativeEvent.contentOffset.y;
    const row = Math.max(0, Math.floor((y + gridViewH / 2) / rowHeight));
    gridPendingSel.current = Math.min(n - 1, row * cols + (cols === 3 ? 1 : 0));
    scheduleGridSettle();
  };
  // ⚠️ Kursor MUSI wracać także wtedy, gdy przeciągnięcie nie wywołało ANI JEDNEGO `onScroll` — a tak jest
  // na krańcach listy (swipe w górę na samym dole / w dół na samej górze: Android tylko podświetla krawędź,
  // offset się nie zmienia). Wcześniej chowaliśmy kursor w `onScrollBeginDrag`, a przywracał go wyłącznie
  // timer ustawiany w `onScroll` → przy takim geście kursor znikał na dobre. Feed i MOMENTS mają te handlery
  // od początku, dlatego objaw był tylko w siatce folderów.
  const onGridScrollEndDrag = () => scheduleGridSettle();
  const onGridMomentumEnd = () => { if (gridScrollT.current) clearTimeout(gridScrollT.current); gridSettle(); };
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
      : isTrashOpen
      // KOSZ: zostaje wyłącznie przełącznik gęstości miniatur i wyjście. Reszta funkcji (sortowanie, feed,
      // przenoszenie) nie ma tu zastosowania, więc klawisze zostają puste zamiast udawać, że coś robią.
      ? [
          { label: 'SIZE', icon: cols >= 3 ? 'cols3' : 'cols2', onPress: toggleView },
          { label: 'BACK', onPress: () => { goBack(); } },
        ]
      : [
      { label: 'SIZE', icon: cols >= 3 ? 'cols3' : 'cols2', onPress: toggleView }, // ta sama para ikon we WSZYSTKICH trybach
      // wewnątrz folderu = BACK; w ROOT (gallery view) i feedzie = EXIT (czerwony, przytrzymaj → wyjście z apki)
      canBack
        ? { label: 'BACK', onPress: () => { goBack(); } }
        : { label: 'EXIT', supporting: '[HOLD]', variant: 'risk', onHoldComplete: () => onExitApp?.(), holdMs: 1500 },
    ],
    metal: [
      menuOpen || isTrashOpen ? { type: 'label', upper: '' } : { type: 'label', upper: nextViewLabel, onPress: toggleFeed },
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
      // Pion: w SIATCE (focus 2) = nawigacja kafli (powrót do menu tylko przez CONFIRM). W menu: GÓRA wchodzi
      // głębiej (poziom 1 → poziom 2 lub siatka dla SELECT), DÓŁ cofa (poziom 2 → poziom 1).
      onUp: () => {
        if (selFocus === 2) { if (feedMode) feedMoveV(-1); else { bumpNavHide(); move(-cols); } }
        else if (selFocus === 0) { if (selRoot === 1) setSelFocus(2); else if (subItems.length > 0) setSelFocus(1); }
      },
      onDown: () => {
        if (selFocus === 2) { if (feedMode) feedMoveV(1); else { bumpNavHide(); move(cols); } }
        else if (selFocus === 1) setSelFocus(0);
      },
      onLeft: () => { if (selFocus === 2) { if (feedMode) feedMoveH(-1); else move(-1); } else selMoveH(-1); },
      onRight: () => { if (selFocus === 2) { if (feedMode) feedMoveH(1); else move(1); } else selMoveH(1); },
      onPress: selPress,
    },
  };
  // KLAWIATURA potwierdzenia usuwania. CONFIRM: CANCEL + przytrzymaj DELETE/MOVE (czerwony, progress ring).
  // DELETED: UNDO (do kosza) / CLOSE. Hold + progress ring to funkcja klawisza EKRANOWEGO (nie metalowego).
  const confirmKeyboard: KeyboardConfig = {
    screen: delPhase === 'choose'
      ? [
          // WYBÓR (fosforowy dialog): SHRED = na zawsze (czerwony, high risk), TRASH = do kosza od razu.
          // Przytrzymanie SHRED kasuje wprost; samo tapnięcie prowadzi do czerwonego potwierdzenia.
          {
            label: holding ? 'DELETING' : 'DELETE',
            supporting: holding ? undefined : '[HOLD]',
            variant: 'risk',
            icon: 'shred',
            onPress: askShred,
            onHoldStart: () => setHolding(true),
            onHoldCancel: () => setHolding(false),
            onHoldComplete: shredNow,
            holdMs: 1200,
          },
          { label: 'CANCEL', icon: 'close', onPress: cancelDelete },
        ]
      : delPhase === 'confirm'
      ? [
          // POTWIERDZENIE: tu wystarczy TAPNIĘCIE. Kasowanie ma dwie równoważne drogi — przytrzymanie SHRED
          // w dialogu wyboru ALBO dwa tapnięcia (shred → potwierdź). Drugie przytrzymanie byłoby trzecim
          // gestem pod rząd na tę samą decyzję.
          { label: 'DELETE', variant: 'risk', icon: 'shred', onPress: () => { void confirmDelete(true); } },
          { label: 'CANCEL', icon: 'close', onPress: cancelDelete },
        ]
      : [{ label: '' }, { label: '' }],
    metal: [
      // Układ klawiatury: [1 · 2 · JOYSTICK · 4 · 5]; wszystkie sloty renderują się jako klawisze „screen"
      // (tablica `metal` to już tylko historyczna nazwa z rec_ai). W dialogu wyboru: SHRED na 1 (skrajnie,
      // jak każda akcja destrukcyjna), TRASH na 2, odwołanie na 5.
      // TRASH zostaje także w CZERWONYM potwierdzeniu: skoro user już tam trafił, ma mieć wyjście łagodniejsze
      // niż skasowanie na zawsze, bez cofania się o krok. W samym koszu nie ma sensu — nie ma dokąd przenosić.
      (delPhase === 'choose' || delPhase === 'confirm') && !isTrashOpen
        ? { type: 'label', upper: 'TRASH', icon: 'trash', onPress: () => { void trashNow(Array.from(selectedIds)); } }
        : { type: 'label', upper: '', onPress: undefined },
      { type: 'label', upper: '', onPress: undefined },
    ],
    joystick: { highlighted: false },
  };

  // KLAWIATURA prośby o MANAGE_MEDIA: ALLOW wychodzi do systemowego przełącznika, SKIP robi operację
  // po staremu (z systemowym oknem zgody).
  const accessKeyboard: KeyboardConfig = {
    screen: [
      { label: 'ALLOW', variant: 'primary', onPress: () => finishAccessAsk(true) },
      { label: 'SKIP', onPress: () => finishAccessAsk(false) },
    ],
    metal: [{ type: 'label', upper: '' }, { type: 'label', upper: '' }],
    joystick: { highlighted: false },
  };

  // KLAWIATURA PICKERA (wybór folderu docelowego): NEW FOLDER · [joy: nawigacja + wybór] · BACK.
  const pickKeyboard: KeyboardConfig = {
    screen: [
      { label: 'NEW\nFOLDER', onPress: () => { setNaming(true); setNewName(''); } },
      { label: 'BACK', onPress: cancelPick },
    ],
    metal: [{ type: 'label', upper: '' }, { type: 'label', upper: '' }],
    joystick: {
      highlighted: true,
      repeat: true,
      shortStepHaptic: true,
      onUp: () => pickMove(-galleryCols),
      onDown: () => pickMove(galleryCols),
      onLeft: () => pickMove(-1),
      onRight: () => pickMove(1),
      onPress: () => chooseTarget(pickIdx),
    },
  };
  // KLAWIATURA nazwy nowego folderu. CREATE wygaszony, dopóki nazwa nie jest poprawna (znaki + brak kolizji).
  const nameKeyboard: KeyboardConfig = {
    screen: [
      { label: 'CREATE', variant: nameOk ? 'primary' : undefined, onPress: nameOk ? () => runFileOp(null, newName.trim()) : undefined },
      { label: 'CANCEL', onPress: () => { setNaming(false); setNewName(''); setNameFocus(false); } },
    ],
    metal: [{ type: 'label', upper: '' }, { type: 'label', upper: '' }],
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
      {/* Pudełko treści BEZ przygaszenia — wyznacza geometrię nakładek. Przygaszana jest dopiero warstwa
          wewnętrzna, żeby dialog (renderowany obok niej) został w pełnej jasności. */}
      <View style={{ flex: 1, alignSelf: 'stretch' }}>
      <View style={{ flex: 1, alignSelf: 'stretch', gap: 12, opacity: menuOpen || dialogOpen ? 0.25 : 1 }}>

      {/* breadcrumb tylko we wnętrzu folderu; tap = wyjście do listy folderów */}
      {!feedMode && inside && folders[openFolder!] ? (
        <Pressable onPress={goBack} style={{ alignSelf: 'stretch' }}>
          <Text style={[cap, isTrashOpen ? { color: screen.red.primary, textShadowColor: 'rgba(255,76,76,0.25)' } : null]}>
            {`.../${folders[openFolder!].name}/`}
          </Text>
        </Pressable>
      ) : null}

      {!diag.grid ? (
        // DIAG GRID = OFF: bez siatki/expo-image/filtra — sam placeholder (bisect: czy to siatka tnie)
        <View style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={cap}>GRID OFF (DIAG)</Text>
        </View>
      ) : (
      // Opakowanie POZA grupą filtra: ramka multiselekcji musi być rysowana obok kontenera z `isolation`,
      // nie w środku. Wystaje ona o gap/2 poza siatkę, a ScreenFilter (multiply fosforem) przykrywa TYLKO
      // wnętrze kontenera — więc gdy ramka siedziała w środku, jej wystający pierścień był czystym fosforem,
      // a wnętrze przemnożonym, ciemniejszym. Jeden element w dwóch kolorach. Tutaj filtr jej nie dotyka
      // wcale, przez co tło multiselekcji ma dokładnie ten sam fosfor co pasek SELECT i reszta UI.
      <View style={{ flex: 1, alignSelf: 'stretch' }}>
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
              width={gw}
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
              chrome={chromeFg}
            />
          ) : null
        ) : feedMode ? (
          contentW > 0 ? (
            <FeedGrid
              ref={feedRef}
              data={feedView}
              cols={cols}
              width={gw}
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
              chrome={chromeFg}
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
            onScrollEndDrag={onGridScrollEndDrag}
            onMomentumScrollEnd={onGridMomentumEnd}
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
                    <PhotoTile source={item as ImageSourcePropType} size={imgSize} selected={index === selEff} images={diag.images} onPress={onTap} onLongPress={onLong} check={checked} chrome={chromeFg} />
                  ) : (
                    <FolderTile folder={item as Folder} size={imgSize} selected={index === selEff} images={diag.images} onPress={onTap} onLongPress={onLong} check={checked} danger={isTrashTile} chrome={chromeFg} />
                  )}
                </View>
              );
            }}
          />
        ) : null}
        {/* filtr trybu — JEDNA nakładka nad całą siatką (zamiast N per-kafel). DIAG: filter */}
        {diag.filter ? <ScreenFilter displayMode={displayMode} /> : null}
        {/* RAMKA multiselekcji — NAD filtrem, bo `mixBlendMode` miesza się ze WSZYSTKIM, co jest pod spodem
            (kontener z `isolation` tego na Androidzie nie zatrzymuje). Leżąc pod filtrem, była przemnażana
            przez fosfor i wychodziła ciemniej niż jej wystający pierścień, którego filtr już nie obejmował —
            stąd tło ciemniejsze od obrysu. Nad filtrem ma dokładnie `screen.olive.primary`, tak jak pasek
            SELECT. Rysowana jako OBRAMOWANIE (przezroczysty środek), żeby nie przykryła miniatur; szerokość
            = gap, czyli tyle, ile zajmował poprzedni pas widoczny w odstępach. */}
        {selectMode ? (
          // Geometria: kafle mają własny padding gap/2, więc OBRAZY zaczynają się 4 px od krawędzi kontenera.
          // Chcemy 2 px oddechu między ramką a siatką → wewnętrzna krawędź ramki musi wypaść na +2, czyli przy
          // grubości `gap` (8) trzeba wysunąć ją o 6 px na zewnątrz. Siatki to nie rusza — ramka rośnie tylko
          // na zewnątrz, w wolne miejsce wewnątrz paddingu ekranu.
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: -SEL_OUT, left: -SEL_OUT, right: -SEL_OUT, bottom: -SEL_OUT, borderWidth: PHOTO_GAP, borderColor: isTrashOpen ? screen.red.primary : screen.olive.primary, borderRadius: 2 }}
          />
        ) : null}
      </View>
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
      {overlays}
      </View>

      {/* MENU (popover) — nad siatką, gdy nie ma podglądu; podąża za klawiszem MENU (left-handed → lewy róg) */}
      {menuOpen && !viewerOpen ? (
        <>
          <MenuScrim />
          <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: dialogOpen ? 0.25 : 1 }}>
            <GalleryMenu index={menuIndex} onPick={pickMenu} items={menuLabels} leftHanded={leftHanded} riskLabels={MENU_RISK} />
          </View>
        </>
      ) : null}

      {/* TRYB ZAZNACZANIA — dwupoziomowe menu (SELECT/ACTION) w rogu; overlay potwierdzenia/wyniku usuwania na wierzchu */}
      {/* pasek SELECT/ACTION gaśnie razem z treścią, gdy nad wszystkim jest dialog — inaczej świecił pełnym
          fosforem obok przygaszonej siatki i przyciągał wzrok bardziej niż samo pytanie */}
      {selectMode && !viewerOpen ? (
        <View style={{ alignSelf: 'stretch', opacity: dialogOpen ? 0.25 : 1 }}>
        <SelectMenu
          count={selectedIds.size}
          focus={selFocus}
          rootIdx={selRoot}
          subIdx={selSub}
          subItems={subItems}
          riskLabels={SELECT_RISK} // DELETE zawsze na czerwono — także poza koszem (usuwanie to akcja destrukcyjna)
          // TAP = zatwierdzenie pozycji, dokładnie jak press na joysticku (tak działa też pasek EDIT w edytorze):
          // SELECT oddaje sterowanie siatce, SELECTION i ACTION odsłaniają poziom 2. Wcześniej tap tylko
          // przestawiał zaznaczenie i palcem nie dało się wejść głębiej.
          onPickRoot={(i) => { setSelRoot(i); setSelFocus(i === 1 ? 2 : 1); }}
          onPickSub={(i) => { setSelFocus(1); setSelSub(i); activateSub(i); }}
        />
        </View>
      ) : null}
    </>
  );

  // PICKER MOVE/COPY — treść ekranu: nagłówek „MOVE 12 →" + ta sama siatka folderów co w ROOT (kursor
  // joystickiem, tap = wybór). Folder ŹRÓDŁOWY przygaszony i nieklikalny, KOSZ w ogóle nie na liście.
  // Ekran nazwy nowego folderu zastępuje siatkę (klawiatura CREATE/CANCEL), żeby nie mieszać dwóch fokusów.
  const pickItemW = contentW > 0 ? Math.floor(contentW / galleryCols) : 0;
  const pickImgSize = pickItemW > 0 ? pickItemW - FOLDER_GAP : 0;
  const pickRowH = pickImgSize + FOLDER_GAP + 34;
  const pickerContent = pick ? (
    <>
      <ScreenTopBar mode={mode} label={pick.op} />
      <View style={{ flex: 1, alignSelf: 'stretch' }}>
      <View style={{ flex: 1, alignSelf: 'stretch', gap: 12, opacity: dialogOpen ? 0.25 : 1 }}>
        <Text style={cap}>{`${pick.op} ${pick.keys.length} →`}</Text>
        {naming ? (
          <View style={{ alignSelf: 'stretch', gap: 8 }}>
            <Text style={cap}>NEW FOLDER NAME</Text>
            {/* pigułka fosforowa z polem — jak pole promptu AI; tap wraca do pisania po zamknięciu klawiatury */}
            <Pressable onPress={() => nameInputRef.current?.focus()} style={{ alignSelf: 'stretch', backgroundColor: screen.olive.primary, borderRadius: 2, padding: 6 }}>
              <TextInput
                ref={nameInputRef}
                autoFocus
                value={newName}
                onChangeText={setNewName}
                onFocus={() => setNameFocus(true)}
                onBlur={() => setNameFocus(false)}
                onSubmitEditing={() => { if (nameOk) runFileOp(null, newName.trim()); }}
                placeholder="Folder name…"
                placeholderTextColor={color.dark21}
                returnKeyType="done"
                maxLength={40}
                style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: color.dark21, padding: 0 }}
              />
            </Pressable>
            {/* nazwa idzie do MediaStore.RELATIVE_PATH — natywny walidator przyjmuje tylko [\w -] */}
            <Text style={{ ...cap, opacity: 0.6 }}>
              {nameTaken ? 'FOLDER ALREADY EXISTS' : 'LETTERS, DIGITS, SPACE, - AND _ ONLY'}
            </Text>
          </View>
        ) : pickItemW > 0 || contentW === 0 ? (
          <View
            style={{ flex: 1, alignSelf: 'stretch', isolation: 'isolate' } as any}
            onLayout={(e: LayoutChangeEvent) => {
              const w = e.nativeEvent.layout.width;
              setContentW((prev) => (Math.abs(prev - w) < 1 ? prev : w));
            }}
          >
            {pickItemW > 0 ? (
              <FlatList
                ref={pickListRef}
                key={`pick-${galleryCols}`}
                data={pickTargets}
                numColumns={galleryCols}
                extraData={`${pickIdx}:${pick.from ?? ''}`}
                keyExtractor={(item: Folder) => item.id}
                getItemLayout={(_: any, index: number) => ({ length: pickRowH, offset: pickRowH * index, index })}
                onScrollToIndexFailed={() => {}}
                showsVerticalScrollIndicator={false}
                renderItem={({ item, index }: { item: Folder; index: number }) => {
                  const isSource = item.id === pick.from;
                  return (
                    <View style={{ width: pickItemW, padding: FOLDER_GAP / 2 }}>
                      <FolderTile
                        folder={item}
                        size={pickImgSize}
                        selected={index === pickIdx}
                        images={diag.images}
                        onPress={isSource ? undefined : () => { setPickIdx(index); chooseTarget(index); }}
                        dim={isSource}
                        chrome={chromeFg}
                      />
                    </View>
                  );
                }}
              />
            ) : null}
            {diag.filter ? <ScreenFilter displayMode={displayMode} /> : null}
          </View>
        ) : null}
        {!naming && pickTargets.length === 0 ? <Text style={cap}>NO TARGET FOLDERS — USE NEW FOLDER</Text> : null}
      </View>
      {overlays}
      </View>
    </>
  ) : null;

  // PODGLĄD/EDYCJA — gdy `viewerOpen`, edytor przejmuje CAŁĄ treść ekranu i klawiaturę (Figma
  // „fullscreen_view/edit"). Inaczej: siatka + klawiatura galerii.
  // MENU (kontekstowe menu galerii) można otworzyć też NAD podglądem: wtedy popover + klawiatura galerii
  // (nawigacja joystickiem, CLOSE MENU) przejmują sterowanie, a treść podglądu zostaje pod spodem.
  // STRUKTURA DRZEWA MUSI BYĆ STAŁA. Wcześniej przy zamkniętym menu treścią był goły element, a przy
  // otwartym — fragment; React widział w tym miejscu inny typ węzła, odmontowywał całe poddrzewo
  // podglądu i obrazek ładował się od nowa. Teraz zawsze fragment, menu tylko dochodzi jako drugie
  // dziecko, więc `editor.content` zostaje na swojej pozycji i nie jest przemontowywany.
  const viewerContent = (
    <>
      {/* Gdy otwarty jest IMMERSIVE (nakładka na CAŁY ekran telefonu), podglądu w ramce i tak nie widać —
          a renderowany dalej przeładowywał to samo zdjęcie przy KAŻDYM swipie, drugi raz obok slotu immersive.
          Zdejmujemy go z drzewa na ten czas; stan edytora żyje w hooku, więc po zamknięciu wraca jak stał. */}
      <View style={{ flex: 1, alignSelf: 'stretch', gap: dims.screenGap, opacity: menuOpen ? 0.25 : 1 }}>
        {immersiveOpen ? null : editor.content}
      </View>
      {menuOpen ? (
        <>
          <MenuScrim />
          <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: dialogOpen ? 0.25 : 1 }}>
            <GalleryMenu index={menuIndex} onPick={pickMenu} items={menuLabels} leftHanded={leftHanded} riskLabels={MENU_RISK} />
          </View>
        </>
      ) : null}
    </>
  );

  const finalContent = pick ? pickerContent : viewerOpen ? viewerContent : content;
  const finalKeyboard = accessAsk
    ? accessKeyboard
    : naming
      ? nameKeyboard
      : pick
        ? pickKeyboard
        : delPhase !== 'none' ? confirmKeyboard : selectMode ? selectKeyboard : menuOpen ? keyboard : viewerOpen ? editor.keyboard : keyboard;

  return { content: finalContent, keyboard: finalKeyboard, goBack, pinchColumns, showModeToast, showExitToast, viewerOpen, menuOpen, selectMode, allFolders, immersive, typing: nameFocus || (viewerOpen ? editor.typing : false) };
}
