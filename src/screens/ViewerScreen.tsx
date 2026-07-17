/**
 * ViewerScreen — tryb VIEWER (górny Mode obok GALLERY/SETTINGS). Pokazuje pełnoekranowy podgląd
 * PIERWSZEGO zdjęcia z urządzenia — dokładnie „pierwszy z feeda" (płaska lista wszystkich WIDOCZNYCH
 * folderów, spłaszczona, posortowana od najnowszego). PREV/NEXT przewijają cały feed.
 *
 * Nie duplikuje UI podglądu — re-używa `useImageEditor` (ten sam pełnoekranowy viewer + zoom + menu
 * EDIT co w galerii). Ładowanie mediów jak w feedzie galerii: WEB → mocki, natywnie → media.loadPhotos
 * ze wszystkich folderów (Promise.all + flatten). Feed ładujemy leniwie: dopiero gdy tryb jest aktywny.
 */
import { useEffect, useMemo, useState } from 'react';
import { ImageSourcePropType } from 'react-native';
import { useMedia } from '../hooks/useMedia';
import { applyLibraryFilter } from '../hooks/useLibraryFilter';
import { DESIGN, EMPTY_FOLDERS, type Folder } from './GalleryScreen';
import { useImageEditor } from './EditorScreen';

export function useViewerScreen({
  active,
  onCycleMode,
  onBack,
  leftHanded = false,
  promptBooster = false,
  media,
  allFolders = EMPTY_FOLDERS,
  included = [],
  excluded = [],
}: {
  active: boolean; // tryb VIEWER wybrany
  onCycleMode?: () => void; // kliknięcie kafelka trybu → cykl GALLERY/VIEWER/SETTINGS
  onBack?: () => void; // BACK (klawisz 1 / joystick press) → powrót do GALLERY
  leftHanded?: boolean; // klawiatura lustrzana → popover menu po lewej
  promptBooster?: boolean; // ustawienie EDIT/PROMPT BOOSTER
  media?: ReturnType<typeof useMedia>;
  allFolders?: Folder[];
  included?: string[];
  excluded?: string[];
}) {
  // te same WIDOCZNE foldery co galeria (whitelist − blacklist)
  const folders = useMemo(() => applyLibraryFilter(allFolders, included, excluded), [allFolders, included, excluded]);
  const [photos, setPhotos] = useState<ImageSourcePropType[]>([]);
  const [selected, setSelected] = useState(0);

  // feed ładujemy dopiero po wejściu w tryb VIEWER (leniwie); wyjście zeruje zaznaczenie na pierwszy
  useEffect(() => {
    if (!active) { setSelected(0); return; }
    if (DESIGN) { setPhotos(folders.flatMap((f) => f.photos ?? [])); return; }
    if (!media) { setPhotos([]); return; }
    let cancelled = false;
    Promise.all(folders.map((f) => media.loadPhotos(f.id).catch(() => [] as ImageSourcePropType[])))
      .then((lists) => { if (!cancelled) setPhotos(lists.flat()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, folders]);

  const n = photos.length;
  const source = photos[selected];
  const move = (d: number) => setSelected((i) => Math.max(0, Math.min(n - 1, i + d)));
  const [immersiveOpen, setImmersiveOpen] = useState(false);
  useEffect(() => { if (!active) setImmersiveOpen(false); }, [active]); // wyjście z trybu → zamknij immersive

  // ten sam pełnoekranowy viewer co w galerii; „open" = tryb aktywny i mamy co pokazać
  const editor = useImageEditor({
    source,
    open: active && !!source,
    onExit: () => onBack?.(), // w trybie VIEWER „wyjście z podglądu" = powrót do GALLERY
    onPrev: () => move(-1),
    onNext: () => move(1),
    onCycleMode,
    onRequestImmersive: () => setImmersiveOpen(true),
    leftHanded,
    promptBooster,
  });

  const immersive = active && immersiveOpen && source
    ? { photos, index: selected, setIndex: (i: number) => setSelected(i), close: () => setImmersiveOpen(false), info: editor.info }
    : null;

  return { content: editor.content, keyboard: editor.keyboard, goBack: editor.goBack, typing: editor.typing, immersive };
}
