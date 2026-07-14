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
import { View, Text, Pressable, Platform, FlatList, LayoutChangeEvent, ImageSourcePropType } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { color, font, screen, textShadow } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';
import { ScreenTopBar, Mode, DisplayMode } from './ScreenChrome';
import { useMedia } from '../hooks/useMedia';
import { applyLibraryFilter } from '../hooks/useLibraryFilter';
import { FeedGrid } from '../components/FeedGrid';
import { useImageEditor } from './EditorScreen';
import { MOCK_FOLDERS, type Folder } from './mockFolders';
import { Diag, DIAG_ALL } from '../lib/diag';
import { getProvenance, isAiSource } from '../lib/imageMeta';

// MOCK_FOLDERS re-eksportowane dla App (natywnie puste, na web z `mockFolders.web.ts`)
export { MOCK_FOLDERS };
export type { Folder };

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
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
 * usePhotoAi — czy zdjęcie ma ingerencję AI. Najpierw lokalny tag (sync), a jeśli nie — LENIWY, cache'owany
 * odczyt prowieniencji z metadanych (IPTC digitalSourceType / C2PA). Błędy ciche → zostaje sam tag.
 */
function usePhotoAi(source?: ImageSourcePropType): boolean {
  const tag = !!(source as any)?.ai;
  const id = (source as any)?.uri as string | undefined;
  const [meta, setMeta] = useState(false);
  useEffect(() => {
    setMeta(false);
    if (tag || !id || typeof id !== 'string') return;
    let alive = true;
    getProvenance(id).then((pv) => { if (alive && isAiSource(pv.sourceType)) setMeta(true); }).catch(() => {});
    return () => { alive = false; };
  }, [id, tag]);
  return tag || meta;
}

function PhosphorCover({ source, size, selected, images = true, ai: aiProp }: { source?: ImageSourcePropType; size: number; selected?: boolean; images?: boolean; ai?: boolean }) {
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
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 2, borderColor: screen.olive.primary }} />
        </>
      ) : null}
      {images && source ? <ThumbBadges ai={ai} raw={raw} /> : null}
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
  const ai = usePhotoAi(source); // tag lokalny lub metadane (IPTC/C2PA)
  return (
    <Pressable onPress={onPress} style={{ width: '100%' }}>
      <PhosphorCover source={source} size={size} selected={selected} images={images} ai={ai} />
    </Pressable>
  );
});

// MENU (node 360:5309) — kontekstowe menu galerii. Popover fosforowy (#E2FFE4) z ciemnym tekstem; zaznaczona
// pozycja = ciemna „pigułka" z zielonym tekstem i bulletem „•". Nawigacja joystick góra/dół + press (lub tap).
const MENU_ITEMS = ['SORT', 'FILTER MEDIA', 'SHOW HIDDEN ELEMENTS', 'OPEN TRASH BIN', 'CREATE NEW FOLDER', 'SETTINGS'] as const;

function GalleryMenu({ index, onPick, leftHanded = false }: { index: number; onPick: (i: number) => void; leftHanded?: boolean }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  // popover trzyma się klawisza MENU: domyślnie prawy dolny róg; w trybie left-handed klawiatura jest
  // lustrzana → MENU po lewej, więc i menu po lewej.
  return (
    <View
      style={{ position: 'absolute', ...(leftHanded ? { left: 0 } : { right: 0 }), bottom: 0, padding: 8, gap: 8, borderRadius: 2, backgroundColor: screen.olive.primary, boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any}
    >
      {MENU_ITEMS.map((label, i) => {
        const sel = i === index;
        // każdy wiersz ma tę samą strukturę (bullet + label + padding) → szerokość menu = najszerszy label,
        // stała niezależnie od zaznaczenia (bullet przezroczysty, gdy niezaznaczony — rezerwuje miejsce).
        return (
          <Pressable
            key={label}
            onPress={() => onPick(i)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 2, paddingRight: 4, paddingLeft: 2, borderRadius: 2, backgroundColor: sel ? color.dark21 : 'transparent' }}
          >
            <Text style={{ ...txt, color: sel ? screen.olive.primary : 'transparent', ...(sel ? phosphorGlow : null) }}>{'•'}</Text>
            <Text style={{ ...txt, color: sel ? screen.olive.primary : color.dark21, ...(sel ? phosphorGlow : null) }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const FOLDER_GAP = 8; // odstęp między kolumnami w siatce folderów (ROOT)
const PHOTO_GAP = 8; //  odstęp między kolumnami w siatce zdjęć (spójny z feedem — FEED_GAP)

export function useGalleryScreen({ mode = 'GALLERY', onCycleMode, onOpenSettings, media, allFolders = EMPTY_FOLDERS, included = [], excluded = [], displayMode = 'IMMERSIVE', diag = DIAG_ALL, leftHanded = false, promptBooster = false }: { mode?: Mode; onCycleMode?: () => void; onOpenSettings?: () => void; media?: ReturnType<typeof useMedia>; allFolders?: Folder[]; included?: string[]; excluded?: string[]; displayMode?: DisplayMode; diag?: Diag; leftHanded?: boolean; promptBooster?: boolean } = {}) {
  // rozmiar miniatur (2=medium ↔ 3=small) — NIEZALEŻNY dla gallery view i feed view
  const [galleryCols, setGalleryCols] = useState<2 | 3>(2);
  const [feedCols, setFeedCols] = useState<2 | 3>(2);
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

  // aktywny rozmiar miniatur zależy od widoku; zmiana (THUMB SIZE / pinch) dotyka TYLKO aktywnego widoku
  const cols = feedMode ? feedCols : galleryCols;
  const setColsActive = (fn: (c: 2 | 3) => 2 | 3) => (feedMode ? setFeedCols(fn) : setGalleryCols(fn));

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
    // UWAGA: bez `cols` w zależnościach — na zmianę rozmiaru (THUMB SIZE) FlatList jest REMONTOWANY (key=cols)
    // i wtedy scrollToIndex odpaliłby się z niezmierzonym viewportem (visibleLength=0) → skok o ~½ kafla.
  }, [selected, openFolder]);

  const move = (d: number) => setSelected((i) => Math.max(0, Math.min(n - 1, i + d)));
  const toggleView = () => setColsActive((c) => (c === 2 ? 3 : 2));
  // pinch na ekranie: rozsunięcie ('out') → mniej kolumn (większe kafle), zsunięcie ('in') → więcej
  const pinchColumns = (dir: 'in' | 'out') =>
    setColsActive((c) => Math.max(2, Math.min(3, dir === 'out' ? c - 1 : c + 1)) as 2 | 3);
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

  // EDYTOR — pełnoekranowy podgląd + edycja (Figma „fullscreen_view/edit"). Aktywny, gdy `viewerOpen`;
  // przejmuje treść ekranu i klawiaturę. Źródło = zaznaczone zdjęcie (feed lub wnętrze folderu).
  const currentSource = (feedMode ? feedPhotos : photos)[selected];
  const editor = useImageEditor({
    source: currentSource,
    open: viewerOpen,
    onExit: closeViewer,
    onPrev: () => move(-1),
    onNext: () => move(1),
    onOpenSettings,
    onMenu: () => toggleMenu(), // klawisz MENU w podglądzie → kontekstowe menu galerii
    leftHanded,
    promptBooster,
  });

  // MENU
  const toggleMenu = () => setMenuOpen((o) => { if (!o) setMenuIndex(0); return !o; });
  // nawigacja zapętlona (loop): z końca wracamy na początek i odwrotnie
  const menuMove = (d: number) => setMenuIndex((i) => (i + d + MENU_ITEMS.length) % MENU_ITEMS.length);
  const pickMenu = (i: number) => {
    setMenuOpen(false);
    if (MENU_ITEMS[i] === 'SETTINGS') { onOpenSettings?.(); return; }
    // pozostałe pozycje: funkcje dorobimy później (SORT/FILTER/HIDDEN/TRASH/CREATE FOLDER)
  };

  // back: kolejno zamknij MENU → (edytor: menu edycji/pod-widok, a na końcu podgląd) → folder → feed
  const goBack = () => {
    if (menuOpen) { setMenuOpen(false); return true; }
    if (viewerOpen) { if (!editor.goBack()) setViewerOpen(false); return true; }
    if (inside) { setOpenFolder(null); return true; }
    if (feedMode) { setFeedMode(false); setSelected(0); return true; }
    return false;
  };

  // komórka = szerokość kolumny; bok kwadratowego kafla = komórka minus przerwa (padding gap/2)
  const itemWidth = contentW > 0 ? Math.floor(contentW / cols) : 0;
  const imgSize = itemWidth > 0 ? itemWidth - gap : 0;
  const rowHeight = imgSize + gap + (inside ? 0 : 34); // +podpis dla folderów (getItemLayout → pewny scrollToIndex)

  // Klawiatura (kolejność): THUMB SIZE · FEED VIEW · joystick · MENU · BACK.
  // 1 = THUMB SIZE (cykl gęstości 2/3 kol.), 2 = FEED VIEW (w folderach) ⇄ GALLERY VIEW (w feedzie),
  // 4 = MENU (otwarte = CLOSE MENU, zielony), 5 = BACK — TYLKO wewnątrz folderu. FEED VIEW jest trybem
  // RÓWNOLEGŁYM do GALLERY VIEW (przełączany klawiszem FEED/GALLERY), więc tam BACK się NIE pojawia.
  // Bez BACK klawisz zostaje WIDOCZNY (puste szkło), tylko bez labela i funkcji. Gęstość też pinch.
  const canBack = inside;
  const keyboard: KeyboardConfig = {
    screen: [
      { label: 'THUMB\nSIZE', onPress: toggleView },
      canBack ? { label: 'BACK', onPress: () => { goBack(); } } : { label: '' },
    ],
    metal: [
      { type: 'label', upper: feedMode ? 'GALLERY\nVIEW' : 'FEED\nVIEW', onPress: toggleFeed },
      { type: 'label', upper: menuOpen ? 'CLOSE\nMENU' : 'MENU', variant: menuOpen ? 'primary' : undefined, onPress: toggleMenu },
    ],
    joystick: {
      highlighted: true,
      repeat: true, // przytrzymanie = powtarzaj nawigację (krok co 1 element / wiersz)
      shortStepHaptic: true, // krótszy haptic przy przełączaniu miniatur w gallery/feed

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

      {/* content_area: przy otwartym menu przygaszona do 25% widoczności (menu zostaje pełne, poza tym wrapperem) */}
      <View style={{ flex: 1, alignSelf: 'stretch', opacity: menuOpen && !viewerOpen ? 0.25 : 1 }}>

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
            <Text style={pill}>{displayMode}</Text>
          </View>
        </View>
      ) : null}

      </View>

      {/* MENU (popover) — nad siatką, gdy nie ma podglądu; podąża za klawiszem MENU (left-handed → lewy róg) */}
      {menuOpen && !viewerOpen ? <GalleryMenu index={menuIndex} onPick={pickMenu} leftHanded={leftHanded} /> : null}
    </>
  );

  // PODGLĄD/EDYCJA — gdy `viewerOpen`, edytor przejmuje CAŁĄ treść ekranu i klawiaturę (Figma
  // „fullscreen_view/edit"). Inaczej: siatka + klawiatura galerii.
  // MENU (kontekstowe menu galerii) można otworzyć też NAD podglądem: wtedy popover + klawiatura galerii
  // (nawigacja joystickiem, CLOSE MENU) przejmują sterowanie, a treść podglądu zostaje pod spodem.
  const finalContent = viewerOpen
    ? (menuOpen ? <>{editor.content}<GalleryMenu index={menuIndex} onPick={pickMenu} leftHanded={leftHanded} /></> : editor.content)
    : content;
  const finalKeyboard = menuOpen ? keyboard : viewerOpen ? editor.keyboard : keyboard;

  return { content: finalContent, keyboard: finalKeyboard, goBack, pinchColumns, showModeToast, viewerOpen, menuOpen, allFolders, typing: viewerOpen ? editor.typing : false };
}
