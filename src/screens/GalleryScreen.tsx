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
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Platform, FlatList, LayoutChangeEvent, ImageSourcePropType, Image as RNImage, Animated, PanResponder } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { color, font, screen, textShadow } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';
import { ScreenTopBar, Mode, DisplayMode } from './ScreenChrome';
import { useMedia } from '../hooks/useMedia';
import { applyLibraryFilter } from '../hooks/useLibraryFilter';
import { FeedGrid } from '../components/FeedGrid';
import { Diag, DIAG_ALL } from '../lib/diag';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

// mockowe zdjęcia „Space" (wnętrze folderu) — realne z biblioteki mediów później
const SPACE_PHOTOS: ImageSourcePropType[] = [
  require('../../assets/mock/space/moon.jpg'),
  require('../../assets/mock/space/milkyway.jpg'),
  require('../../assets/mock/space/redstar.jpg'),
  require('../../assets/mock/space/forest.png'),
  require('../../assets/mock/space/nebula.jpg'),
  require('../../assets/mock/space/galaxy.jpg'),
  require('../../assets/mock/space/bluestar.jpg'),
  require('../../assets/mock/space/purple.jpg'),
  require('../../assets/mock/space/sun.jpg'),
];

type Folder = { id: string; name: string; cover?: ImageSourcePropType; count?: number; photos?: ImageSourcePropType[] };

// web = placeholdery (projektowanie); natywnie/APK = realne media z expo-media-library (bez mocków)
export const DESIGN = Platform.OS === 'web';

// STABILNA pusta referencja — bez niej `media.folders ?? []` dawałoby nową tablicę co render,
// a że `folders` jest zależnością efektu → nieskończona pętla re-renderów (dławiła wątek JS na urządzeniu).
export const EMPTY_FOLDERS: Folder[] = [];

// MOCK — TYLKO web (do projektowania UI bez urządzenia). „Space" spięty z breadcrumbem `.../Space/`.
export const MOCK_FOLDERS: Folder[] = [
  { id: 'space', name: 'Space', cover: require('../../assets/mock/lightroom.jpg'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'camera', name: 'Camera', cover: require('../../assets/mock/camera.jpg'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'camera_raw', name: 'Camera RAW', cover: require('../../assets/mock/camera_raw.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'nature', name: 'Nature', cover: require('../../assets/mock/nature.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'hikes', name: 'Hikes', cover: require('../../assets/mock/hikes.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'wild', name: 'Wild Animals', cover: require('../../assets/mock/wild_animals.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'vacations', name: 'Vacations', cover: require('../../assets/mock/vacations.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
];

// Kafel = ZWYKŁY obraz (bez isolation/mixBlendMode/boxShadow per-kafel). Filtr trybu (monochrom/fosfor)
// nakładany JEDEN raz nad całą siatką (patrz ScreenFilter) — kilkadziesiąt offscreenów per-kafel było
// przyczyną migotliwego janku na granicy GPU. `selected` = obrys.
function PhosphorCover({ source, size, selected, images = true }: { source?: ImageSourcePropType; size: number; selected?: boolean; images?: boolean }) {
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
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 2, borderColor: screen.olive.primary }} />
        </>
      ) : null}
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

const FolderTile = memo(function FolderTile({ folder, size, selected, images, onPress }: { folder: Folder; size: number; selected?: boolean; images?: boolean; onPress?: () => void }) {
  // wg projektu: nazwa = Mono/Label (bold 12), podkreślona gdy zaznaczona; licznik = Mono/Caption (10)
  const name = { fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: screen.olive.primary, ...phosphorGlow } as const;
  const cap = { fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.primary, ...phosphorGlow } as const;
  return (
    <Pressable onPress={onPress} style={{ width: '100%', gap: 8 }}>
      <PhosphorCover source={folder.cover} size={size} selected={selected} images={images} />
      <View style={{ gap: 4 }}>
        <Text numberOfLines={1} style={[name, selected ? { textDecorationLine: 'underline' } : null]}>{folder.name}</Text>
        {folder.count != null ? (
          <Text style={cap}>{`${folder.count} image${folder.count === 1 ? '' : 's'}`}</Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const PhotoTile = memo(function PhotoTile({ source, size, selected, images, onPress }: { source: ImageSourcePropType; size: number; selected?: boolean; images?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: '100%' }}>
      <PhosphorCover source={source} size={size} selected={selected} images={images} />
    </Pressable>
  );
});

/**
 * ImageViewer — prosty podgląd zdjęcia: CZYSTY obraz (bez fosforu/matrycy — renderowany NAD filtrem ekranu),
 * dopasowany do szerokości ekranu, na czarnym tle, wyśrodkowany. Pinch = zoom (1×–6×), 1 palcem = przesuwanie
 * gdy powiększone; puszczenie poniżej 1× wraca do dopasowania. Gesty na PanResponderze (brak gesture-handlera
 * w projekcie) — jak pinch obudowy. Remount przez `key` (nawigacja PREV/NEXT) zeruje zoom.
 */
function ImageViewer({ source, width }: { source: ImageSourcePropType; width: number }) {
  const initRatio = useMemo(() => {
    try { const a = RNImage.resolveAssetSource(source as any); return a?.width && a?.height ? a.width / a.height : 1; } catch { return 1; }
  }, [source]);
  const [ratio, setRatio] = useState(initRatio); // szer/wys

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const cur = useRef({ s: 1, x: 0, y: 0 });      // bieżące wartości (setValue nie da się odczytać zwrotnie)
  const base = useRef({ s: 1, x: 0, y: 0 });      // stan na początku gestu
  const pinch = useRef<{ d0: number; s0: number } | null>(null);

  const dist2 = (ts: any[]) => Math.hypot(ts[0].pageX - ts[1].pageX, ts[0].pageY - ts[1].pageY);
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { base.current = { ...cur.current }; pinch.current = null; },
      onPanResponderMove: (e, g) => {
        const ts = e.nativeEvent.touches;
        if (ts.length >= 2) {
          const d = dist2(ts);
          if (!pinch.current) pinch.current = { d0: d, s0: base.current.s };
          const s = clamp(pinch.current.s0 * (d / pinch.current.d0), 1, 6);
          cur.current.s = s;
          scale.setValue(s);
        } else if (ts.length === 1 && base.current.s > 1) {
          cur.current.x = base.current.x + g.dx;
          cur.current.y = base.current.y + g.dy;
          tx.setValue(cur.current.x);
          ty.setValue(cur.current.y);
        }
      },
      onPanResponderRelease: () => {
        pinch.current = null;
        if (cur.current.s <= 1.01) {
          cur.current = { s: 1, x: 0, y: 0 };
          base.current = { s: 1, x: 0, y: 0 };
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
            Animated.spring(tx, { toValue: 0, useNativeDriver: true }),
            Animated.spring(ty, { toValue: 0, useNativeDriver: true }),
          ]).start();
        } else {
          base.current = { ...cur.current };
        }
      },
    }),
  ).current;

  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      {...responder.panHandlers}
    >
      <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
        <ExpoImage
          source={source}
          contentFit="contain"
          cachePolicy="memory-disk"
          onLoad={(ev: any) => { const s = ev?.source; if (s?.width && s?.height) setRatio(s.width / s.height); }}
          style={{ width, height: width / ratio }}
        />
      </Animated.View>
    </View>
  );
}

// MENU (node 360:5309) — kontekstowe menu galerii. Popover fosforowy (#E2FFE4) z ciemnym tekstem; zaznaczona
// pozycja = ciemna „pigułka" z zielonym tekstem i bulletem „•". Nawigacja joystick góra/dół + press (lub tap).
const MENU_ITEMS = ['SORT', 'FILTER MEDIA', 'SHOW HIDDEN ELEMENTS', 'OPEN TRASH BIN', 'CREATE NEW FOLDER', 'SETTINGS'] as const;

function GalleryMenu({ index, onPick }: { index: number; onPick: (i: number) => void }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  return (
    <View
      style={{ position: 'absolute', right: 0, bottom: 0, padding: 8, gap: 8, borderRadius: 2, backgroundColor: screen.olive.primary, boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any}
    >
      {MENU_ITEMS.map((label, i) =>
        i === index ? (
          <Pressable key={label} onPress={() => onPick(i)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 2, paddingRight: 4, paddingLeft: 2, borderRadius: 2, backgroundColor: color.dark21 }}>
            <Text style={{ ...txt, color: screen.olive.primary, ...phosphorGlow }}>{'•'}</Text>
            <Text style={{ ...txt, color: screen.olive.primary, ...phosphorGlow }}>{label}</Text>
          </Pressable>
        ) : (
          <Pressable key={label} onPress={() => onPick(i)}>
            <Text style={{ ...txt, color: color.dark21 }}>{label}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

const FOLDER_GAP = 10; // odstęp w siatce folderów (ROOT)
const PHOTO_GAP = 4; //  odstęp w siatce zdjęć (wnętrze folderu — gęściej)

export function useGalleryScreen({ mode = 'GALLERY', onCycleMode, onOpenSettings, media, allFolders = EMPTY_FOLDERS, included = [], excluded = [], displayMode = 'IMMERSIVE', diag = DIAG_ALL }: { mode?: Mode; onCycleMode?: () => void; onOpenSettings?: () => void; media?: ReturnType<typeof useMedia>; allFolders?: Folder[]; included?: string[]; excluded?: string[]; displayMode?: DisplayMode; diag?: Diag } = {}) {
  const [cols, setCols] = useState<2 | 3>(2); // VIEW: 2 (medium) ↔ 3 (small)
  const [selected, setSelected] = useState(0);
  const [openFolder, setOpenFolder] = useState<number | null>(null); // null = ROOT (foldery); index = wnętrze
  const [viewerOpen, setViewerOpen] = useState(false); // pełnoekranowy podgląd zdjęcia (pokazuje photos[selected])
  const [menuOpen, setMenuOpen] = useState(false); // kontekstowe MENU (popover)
  const [menuIndex, setMenuIndex] = useState(0);   // zaznaczona pozycja menu
  const [feedMode, setFeedMode] = useState(false); // FEED = płaska siatka WSZYSTKICH mediów (vs foldery)
  const [feedPhotos, setFeedPhotos] = useState<ImageSourcePropType[]>([]);
  const [feedSpans, setFeedSpans] = useState<Record<number, number>>({}); // rozmiar kafla feeda: index → 1..cols
  const [contentW, setContentW] = useState(0);
  const [photos, setPhotos] = useState<ImageSourcePropType[]>([]); // zdjęcia otwartego folderu (mock lub media)

  // widoczne foldery = whitelist (jeśli niepusta) − blacklist. Reszta ekranu (siatka/feed/nawigacja) używa TYCH.
  // Źródło (`allFolders`) i `media` podaje App (jedno useMedia — współdzielone z Settings).
  const folders: Folder[] = useMemo(() => applyLibraryFilter(allFolders, included, excluded), [allFolders, included, excluded]);

  // wejście/wyjście z folderu → zaznaczenie na pierwszy + załaduj zdjęcia (mock inline / media leniwie)
  useEffect(() => {
    setSelected(0);
    setViewerOpen(false); // zmiana folderu → zamknij ewentualny podgląd
    setMenuOpen(false);   // i menu
    // guard: nie ustawiaj nowej pustej tablicy, jeśli już pusta (unikaj zbędnego re-rendera)
    const clear = () => setPhotos((p) => (p.length ? [] : p));
    if (openFolder == null) { clear(); return; }
    const f = folders[openFolder];
    if (!f) { clear(); return; }
    if (f.photos) { setPhotos(f.photos); return; } // mock (web)
    if (!media) { clear(); return; }
    let cancelled = false;
    media.loadPhotos(f.id).then((ps) => { if (!cancelled) setPhotos(ps); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFolder, folders]);

  // FEED — załaduj media, gdy wejdziemy w tryb feed. Web: mock (złączone zdjęcia folderów). Natywnie:
  // zbierz media ze WSZYSTKICH zdefiniowanych folderów (Promise.all + flatten).
  useEffect(() => {
    if (!feedMode) return;
    // feed respektuje filtr biblioteki: bierzemy tylko WIDOCZNE foldery (`folders`)
    if (DESIGN) { setFeedPhotos(folders.flatMap((f) => f.photos ?? [])); return; }
    if (!media) { setFeedPhotos([]); return; }
    let cancelled = false;
    Promise.all(folders.map((f) => media.loadPhotos(f.id).catch(() => [] as ImageSourcePropType[])))
      .then((lists) => { if (!cancelled) setFeedPhotos(lists.flat()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedMode, folders]);

  // Auto-scroll: widok podąża za zaznaczeniem (joystick/PREV/NEXT) — FlashList.scrollToIndex.
  const listRef = useRef<any>(null);

  // TOAST trybu wyświetlania: pokazywany przy swipie, znika 2 s po OSTATNIM swipie (timer resetowany).
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showModeToast = () => {
    setToastVisible(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 2000);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const inside = openFolder !== null;
  const n = feedMode ? feedPhotos.length : inside ? photos.length : folders.length;
  const gap = inside ? PHOTO_GAP : FOLDER_GAP;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (n <= 0 || feedMode) return; // feed ma własny auto-scroll (FeedGrid)
    // FlatList z numColumns pracuje na WIERSZACH (getItemCount = ceil(n/cols)), więc scrollToIndex oczekuje
    // indeksu WIERSZA, nie elementu. Podanie indeksu elementu wywalało scroll dla 2. kolumny/dalszych kafli
    // (index ≥ liczby wierszy → wyjątek). Zaznaczenie i tak jest w tym wierszu, więc centrujemy wiersz.
    const row = Math.floor(selected / cols);
    try { listRef.current?.scrollToIndex({ index: row, animated: true, viewPosition: 0.5 }); } catch {}
  }, [selected, openFolder, cols]);

  const move = (d: number) => setSelected((i) => Math.max(0, Math.min(n - 1, i + d)));
  const toggleView = () => setCols((c) => (c === 2 ? 3 : 2));
  // pinch na ekranie: rozsunięcie ('out') → mniej kolumn (większe kafle), zsunięcie ('in') → więcej
  const pinchColumns = (dir: 'in' | 'out') =>
    setCols((c) => Math.max(2, Math.min(3, dir === 'out' ? c - 1 : c + 1)) as 2 | 3);
  // press: FEED → podgląd; ROOT → wejdź w folder; folder → podgląd zaznaczonego zdjęcia
  const enter = () => {
    if (feedMode) { if (n > 0) setViewerOpen(true); return; }
    if (!inside) { setOpenFolder(selected); return; }
    if (n > 0) setViewerOpen(true);
  };
  const closeViewer = () => setViewerOpen(false);

  // FEED ⇄ GALLERY (przycisk FEED VIEW / GALLERY VIEW). Wejście w feed zamyka folder/menu/podgląd, zeruje stan.
  const toggleFeed = () => {
    setMenuOpen(false); setViewerOpen(false); setOpenFolder(null); setSelected(0);
    setFeedMode((f) => { if (!f) setFeedSpans({}); return !f; });
  };
  // uchwyt trójkąta: cykl rozmiaru kafla feeda 1→2→…→cols→1 (limit = liczba kolumn)
  const cycleSpan = (i: number) =>
    setFeedSpans((s) => { const cur = Math.min(s[i] || 1, cols); return { ...s, [i]: (cur % cols) + 1 }; });
  const openViewerAt = (i: number) => { setSelected(i); setViewerOpen(true); };

  // MENU
  const toggleMenu = () => setMenuOpen((o) => { if (!o) setMenuIndex(0); return !o; });
  const menuMove = (d: number) => setMenuIndex((i) => Math.max(0, Math.min(MENU_ITEMS.length - 1, i + d)));
  const pickMenu = (i: number) => {
    setMenuOpen(false);
    if (MENU_ITEMS[i] === 'SETTINGS') { onOpenSettings?.(); return; }
    // pozostałe pozycje: funkcje dorobimy później (SORT/FILTER/HIDDEN/TRASH/CREATE FOLDER)
  };

  // back: kolejno zamknij MENU → podgląd → wyjdź z folderu → wyjdź z feeda
  const goBack = () => {
    if (menuOpen) { setMenuOpen(false); return true; }
    if (viewerOpen) { setViewerOpen(false); return true; }
    if (inside) { setOpenFolder(null); return true; }
    if (feedMode) { setFeedMode(false); setSelected(0); return true; }
    return false;
  };

  // komórka = szerokość kolumny; bok kwadratowego kafla = komórka minus przerwa (padding gap/2)
  const itemWidth = contentW > 0 ? Math.floor(contentW / cols) : 0;
  const imgSize = itemWidth > 0 ? itemWidth - gap : 0;
  const rowHeight = imgSize + gap + (inside ? 0 : 34); // +podpis dla folderów (getItemLayout → pewny scrollToIndex)

  // Klawiatura wg projektu (354:5109 / 386:5645): FEED VIEW · PREV · JOYSTICK · NEXT · MENU.
  // Lewy „screen": FEED VIEW (w folderach) ⇄ GALLERY VIEW (w feedzie) — wchodzi/wychodzi z feeda.
  // Gęstość 2/3 kol.: pinch na ekranie. MENU → popover; gdy otwarte = CLOSE MENU (zielony, variant primary).
  const keyboard: KeyboardConfig = {
    screen: [
      { label: feedMode ? 'GALLERY\nVIEW' : 'FEED\nVIEW', onPress: toggleFeed },
      { label: menuOpen ? 'CLOSE\nMENU' : 'MENU', variant: menuOpen ? 'primary' : 'default', onPress: toggleMenu },
    ],
    metal: [
      { type: 'label', upper: 'PREV', active: true, onPress: () => { if (!menuOpen) move(-1); } },
      { type: 'label', upper: 'NEXT', active: true, onPress: () => { if (!menuOpen) move(1); } },
    ],
    joystick: {
      highlighted: true,
      onUp: () => { if (menuOpen) menuMove(-1); else if (!viewerOpen) move(-cols); },
      onDown: () => { if (menuOpen) menuMove(1); else if (!viewerOpen) move(cols); },
      onLeft: () => { if (!menuOpen) move(-1); },   // w podglądzie: poprzednie zdjęcie
      onRight: () => { if (!menuOpen) move(1); },    // w podglądzie: następne zdjęcie
      onPress: menuOpen ? () => pickMenu(menuIndex) : viewerOpen ? closeViewer : enter,
    },
  };

  const cap = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.primary, ...phosphorGlow } as const;
  const pill = { fontFamily: font.bodyLgBold.family, fontSize: font.bodyLgBold.size, color: color.dark21 } as const;

  const content = (
    <>
      <ScreenTopBar mode={mode} label={feedMode ? 'FEED' : undefined} onCycleMode={onCycleMode} />

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
        {feedMode ? (
          contentW > 0 ? (
            <FeedGrid
              data={feedPhotos}
              cols={cols}
              width={contentW}
              spans={feedSpans}
              selected={selected}
              images={diag.images}
              onCycleSpan={cycleSpan}
              onOpen={openViewerAt}
            />
          ) : null
        ) : itemWidth > 0 ? (
          <FlatList
            ref={listRef}
            key={`${inside ? 'p' : 'f'}-${cols}`} // remount na zmianę widoku/kolumn → czysty relayout
            data={(inside ? photos : folders) as any[]}
            numColumns={cols}
            extraData={`${selected}:${diag.images}`}
            keyExtractor={(item: any, index: number) => (inside ? `p${index}` : (item as Folder).id)}
            // numColumns → `index` to indeks WIERSZA (nie elementu); offset = rowHeight * wiersz.
            getItemLayout={(_: any, index: number) => ({ length: rowHeight, offset: rowHeight * index, index })}
            onScrollToIndexFailed={() => {}}
            showsVerticalScrollIndicator={false}
            renderItem={({ item, index }: { item: any; index: number }) => (
              <View style={{ width: itemWidth, padding: gap / 2 }}>
                {inside ? (
                  <PhotoTile source={item as ImageSourcePropType} size={imgSize} selected={index === selected} images={diag.images} onPress={() => { setSelected(index); setViewerOpen(true); }} />
                ) : (
                  <FolderTile folder={item as Folder} size={imgSize} selected={index === selected} images={diag.images} onPress={() => setOpenFolder(index)} />
                )}
              </View>
            )}
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

      {/* TOAST trybu wyświetlania — fosforowa pigułka `< TRYB >` przy dolnej krawędzi, wyśrodkowana.
          Pojawia się przy swipie i znika 2 s po ostatnim (§ toast, node 360:5309). */}
      {toastVisible ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center' }}>
          <View
            style={
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 2,
                backgroundColor: screen.olive.primary,
                boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)',
              } as any
            }
          >
            <Text style={pill}>{'<'}</Text>
            <Text style={pill}>{displayMode}</Text>
            <Text style={pill}>{'>'}</Text>
          </View>
        </View>
      ) : null}

      {/* MENU (popover) — nad siatką, gdy nie ma podglądu */}
      {menuOpen && !viewerOpen ? <GalleryMenu index={menuIndex} onPick={pickMenu} /> : null}

      {/* PODGLĄD ZDJĘCIA — pełnoekranowa nakładka NAD filtrem/matrycą (czysty obraz), pinch-zoom.
          Źródło: feed lub wnętrze folderu. key=selected → remount przy PREV/NEXT zeruje zoom. */}
      {viewerOpen && (feedMode ? feedPhotos[selected] : inside && photos[selected]) ? (
        <ImageViewer key={selected} source={(feedMode ? feedPhotos : photos)[selected]} width={contentW || 0} />
      ) : null}
    </>
  );

  return { content, keyboard, goBack, pinchColumns, showModeToast, viewerOpen, menuOpen, allFolders };
}
