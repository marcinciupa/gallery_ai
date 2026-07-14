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
import { Platform, ImageSourcePropType } from 'react-native';
import { getAiTags } from '../lib/aiTags';

export type MediaStatus = 'idle' | 'loading' | 'denied' | 'ready' | 'error' | 'unsupported';

// Źródło zdjęcia wzbogacone o flagi na etykiety miniatur (extra pola ignorowane przez <Image>).
export type PhotoSource = { uri: string; raw?: boolean; ai?: boolean };

// Formaty RAW (po rozszerzeniu nazwy pliku). Detekcja best-effort — filename z metadanych, gdy dostępny.
const RAW_RE = /\.(dng|arw|cr[23w]|nef|nrw|orf|raf|rw2|pef|sr[2fw]|raw|x3f|3fr|fff|iiq|kdc|mos|mrw|dcr|k25)$/i;
const isRaw = (name?: string) => !!name && RAW_RE.test(name);
const flag = (m: any, tags: Set<string>): PhotoSource => ({ uri: m.id, raw: isRaw(m.filename), ai: tags.has(m.id) });
// count opcjonalny — świadomie NIE liczymy zdjęć na starcie (skan wszystkich metadanych = lawina GC = jank).
export type MediaFolder = { id: string; name: string; cover?: ImageSourcePropType; count?: number };

export function useMedia() {
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [status, setStatus] = useState<MediaStatus>('idle');
  const [error, setError] = useState<string | null>(null);

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
  }, []);

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

  return { folders, status, error, loadPhotos };
}
