/**
 * useMedia — realne media z urządzenia (expo-media-library, NOWY class-based API: Album/Query) dla APK.
 *   album → folder (nazwa, okładka = najnowsze zdjęcie, licznik)
 *   zdjęcia albumu → wnętrze folderu (leniwie przy wejściu)
 * WEB: niewspierane → `status:'unsupported'`, `folders:null` — ekran galerii używa mocków (projektowanie).
 * Import DYNAMICZNY i tylko natywnie. Uprawnienia funkcyjne (niedeprecated); zapytania przez `Query`.
 *
 * Wydajność: używamy `exeForMetadata()` (lekkie metadane, bez dekodowania/ścieżek) i bierzemy `id`
 * jako źródło obrazu — na Androidzie `id` to content:// URI, ładowalny bezpośrednio przez expo-image
 * (bez ~N× `getUri`). `denied` tylko przy realnym braku zgody; błąd zapytań → `error` (+ komunikat).
 */
import { useEffect, useState } from 'react';
import { Platform, PermissionsAndroid, ImageSourcePropType } from 'react-native';
import { getAiTags } from '../lib/aiTags';

export type MediaStatus = 'idle' | 'loading' | 'denied' | 'ready' | 'error' | 'unsupported';

// Źródło zdjęcia wzbogacone o flagi + metadane pliku (extra pola ignorowane przez <Image>, czytane przez panel INFO).
// ⚠️ PERF: wymiary trzymamy pod NIE-standardowymi kluczami mediaWidth/mediaHeight, a NIE width/height — bo width/height
// to rozpoznawane pola ImageSourcePropType i expo-image dekodowałoby wtedy KAŻDĄ miniaturę w pełnej rozdzielczości
// oryginału → zapaść pamięci/FPS. mediaWidth/mediaHeight/filename są ignorowane przez expo-image (jak raw/ai).
export type PhotoSource = { uri: string; raw?: boolean; ai?: boolean; mediaWidth?: number | null; mediaHeight?: number | null; filename?: string | null; creationTime?: number | null; albumId?: string };

// Formaty RAW (po rozszerzeniu nazwy pliku). Detekcja best-effort — filename z metadanych, gdy dostępny.
const RAW_RE = /\.(dng|arw|cr[23w]|nef|nrw|orf|raf|rw2|pef|sr[2fw]|raw|x3f|3fr|fff|iiq|kdc|mos|mrw|dcr|k25)$/i;
const isRaw = (name?: string | null) => !!name && RAW_RE.test(name);
// Jednorazowa prośba o ACCESS_MEDIA_LOCATION (runtime) — patrz placeOfAsset.
let mediaLocAsked = false;

const flag = (m: any, tags: Set<string>): PhotoSource => ({ uri: m.id, raw: isRaw(m.filename), ai: tags.has(m.id), mediaWidth: m.width ?? null, mediaHeight: m.height ?? null, filename: m.filename ?? null, creationTime: m.creationTime ?? null });
// count opcjonalny — świadomie NIE liczymy zdjęć na starcie (skan wszystkich metadanych = lawina GC = jank).
export type MediaFolder = { id: string; name: string; cover?: ImageSourcePropType; count?: number };

export function useMedia() {
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [status, setStatus] = useState<MediaStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reloadN, setReloadN] = useState(0); // bump → ponowne przeładowanie albumów (po usunięciu/operacjach na plikach)

  useEffect(() => {
    if (Platform.OS === 'web') { setStatus('unsupported'); return; }
    let cancelled = false;
    (async () => {
      setStatus('loading');
      const ML: any = await import('expo-media-library');
      const perm = await ML.requestPermissionsAsync();
      if (!perm.granted && perm.accessPrivileges !== 'limited') {
        if (!cancelled) setStatus('denied');
        return;
      }
      const tags = await getAiTags();
      const albums = await ML.Album.getAll();
      const out = (
        await Promise.all(
          albums.map(async (a: any) => {
            try {
              // tylko OKŁADKA: 1 najnowsze zdjęcie (limit 1) → 1 obiekt metadanych na album (bez skanu liczników)
              const meta = await new ML.Query()
                .album(a)
                .eq(ML.AssetField.MEDIA_TYPE, ML.MediaType.IMAGE)
                .orderBy({ key: ML.AssetField.CREATION_TIME, ascending: false })
                .limit(1)
                .exeForMetadata();
              if (!meta.length) return null; // pomiń albumy bez zdjęć
              const title = await a.getTitle();
              return { id: a.id, name: title ?? 'ALBUM', cover: flag(meta[0], tags) as ImageSourcePropType } as MediaFolder;
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean) as MediaFolder[];
      if (!cancelled) { setFolders(out); setStatus('ready'); }
      // TŁO: liczniki zdjęć (lekkie metadane) — PO pierwszym renderze okładek, nie blokuje startu.
      // Nowy API nie ma taniego count, więc liczymy przez exeForMetadata().length; leniwie i jednorazowo.
      if (!cancelled) {
        Promise.all(
          out.map(async (f) => {
            try {
              const m = await new ML.Query()
                .album(new ML.Album(f.id))
                .eq(ML.AssetField.MEDIA_TYPE, ML.MediaType.IMAGE)
                .exeForMetadata();
              return [f.id, m.length] as const;
            } catch {
              return [f.id, undefined] as const;
            }
          })
        )
          .then((pairs) => {
            if (cancelled) return;
            const counts = new Map(pairs);
            setFolders((prev) => (prev ? prev.map((f) => ({ ...f, count: counts.get(f.id) ?? f.count })) : prev));
          })
          .catch(() => {});
      }
    })().catch((e: any) => {
      if (!cancelled) { setError(String(e?.message ?? e)); setStatus('error'); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadN]);

  const reload = () => setReloadN((n) => n + 1);

  /**
   * Usuwanie z biblioteki (TRWAŁE — brak wbudowanego kosza). `assetUris` = content:// URI zdjęć (Asset.delete),
   * `albumIds` = id albumów (Album.delete; na Androidzie kasuje też zawartość). Android pokazuje SYSTEMOWY
   * dialog potwierdzenia usunięcia. Po zakończeniu wołający robi `reload()`, by odświeżyć siatkę.
   */
  const deleteItems = async (assetUris: string[], albumIds: string[]): Promise<void> => {
    if (Platform.OS === 'web') return;
    const ML: any = await import('expo-media-library');
    if (assetUris.length) {
      try { await ML.Asset.delete(assetUris.map((u) => new ML.Asset(u))); } catch { /* odmowa/anulowanie systemowego dialogu */ }
    }
    if (albumIds.length) {
      try { await ML.Album.delete(albumIds.map((id) => new ML.Album(id))); } catch { /* j.w. */ }
    }
  };

  /** Leniwe pobranie zdjęć albumu (przy wejściu w folder). */
  const loadPhotos = async (albumId: string): Promise<ImageSourcePropType[]> => {
    if (Platform.OS === 'web') return [];
    const ML: any = await import('expo-media-library');
    const tags = await getAiTags();
    const meta = await new ML.Query()
      .album(new ML.Album(albumId))
      .eq(ML.AssetField.MEDIA_TYPE, ML.MediaType.IMAGE)
      .orderBy({ key: ML.AssetField.CREATION_TIME, ascending: false })
      .limit(500)
      .exeForMetadata();
    return meta.map((m: any) => flag(m, tags) as ImageSourcePropType);
  };

  // GPS + nazwa miejsca dla POJEDYNCZEGO assetu (id = PhotoSource.uri). DROGIE: getAssetInfoAsync
  // kopiuje plik do cache — wołać RZADKO (w MOMENTS tylko dla 1 reprezentanta na grupę-dzień, nie
  // per zdjęcie). reverseGeocode wymaga uprawnienia lokalizacji (Android); brak → zwracamy null.
  const placeOfAsset = async (assetId: string): Promise<string | null> => {
    if (Platform.OS === 'web') return null;
    try {
      // Uprawnienie lokalizacji (dla reverseGeocode) — poproś, jeśli jeszcze nie ma.
      const Loc: any = await import('expo-location');
      if (!(await Loc.getForegroundPermissionsAsync()).granted) {
        if (!(await Loc.requestForegroundPermissionsAsync()).granted) return null;
      }
      // ACCESS_MEDIA_LOCATION — RUNTIME (API 29+); bez niego system zeruje GPS w EXIF. Deklaracja w
      // manifeście (plugin expo-media-library isAccessMediaLocationEnabled) NIE wystarcza — trzeba poprosić.
      if (Platform.OS === 'android' && !mediaLocAsked) {
        mediaLocAsked = true;
        try { await PermissionsAndroid.request('android.permission.ACCESS_MEDIA_LOCATION' as any); } catch {}
      }
      // GPS bierzemy z NOWEGO class-based API: `new Asset(id).getLocation()`. Legacy getAssetInfoAsync
      // NIE działa, bo id z Query to content:// URI (a legacy oczekuje numerycznego _ID → zwraca null).
      const ML: any = await import('expo-media-library');
      const loc = await new ML.Asset(assetId).getLocation();
      if (!loc || loc.latitude == null || loc.longitude == null) return null;
      const res = await Loc.reverseGeocodeAsync({ latitude: loc.latitude, longitude: loc.longitude });
      const a = res?.[0];
      return a ? (a.city || a.subregion || a.region || a.country || null) : null;
    } catch { return null; }
  };;
  return { folders, status, error, loadPhotos, deleteItems, reload, placeOfAsset };
}
