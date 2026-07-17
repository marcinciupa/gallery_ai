/**
 * useLibraryFilter — współdzielony filtr biblioteki: które foldery są widoczne w galerii/feedzie.
 *   • included (whitelist) — jeśli NIEPUSTA, galeria pokazuje TYLKO te foldery; pusta = wszystkie.
 *   • excluded (blacklist) — ZAWSZE usuwane z biblioteki (wygrywa nad included).
 *   • hidden — schowane, ale ODKRYWALNE przez „SHOW HIDDEN ELEMENTS" (osobne od excluded).
 * Trzymane w JEDNYM miejscu (App) i podawane do Settings (edycja) oraz Gallery (filtrowanie); trwałość w
 * AsyncStorage (web=localStorage). Wartości = ID folderów (MOCK_FOLDERS.id na web / MediaLibrary album id).
 */
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LIBRARY_KEY = 'galleryai.library.v1';

export function useLibraryFilter() {
  const [included, setIncluded] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const hydrated = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(LIBRARY_KEY)
      .then((raw) => {
        if (!raw) return;
        const s = JSON.parse(raw) as { included?: string[]; excluded?: string[]; hidden?: string[] };
        if (Array.isArray(s.included)) setIncluded(s.included);
        if (Array.isArray(s.excluded)) setExcluded(s.excluded);
        if (Array.isArray(s.hidden)) setHidden(s.hidden);
      })
      .catch(() => {})
      .finally(() => { hydrated.current = true; });
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify({ included, excluded, hidden })).catch(() => {});
  }, [included, excluded, hidden]);

  const toggle = (id: string, which: 'inc' | 'exc' | 'hid') => {
    const setter = which === 'inc' ? setIncluded : which === 'exc' ? setExcluded : setHidden;
    setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return {
    included,
    excluded,
    hidden,
    toggleIncluded: (id: string) => toggle(id, 'inc'),
    toggleExcluded: (id: string) => toggle(id, 'exc'),
    toggleHidden: (id: string) => toggle(id, 'hid'),
  };
}

/** Zastosuj filtr do listy folderów: whitelist (jeśli niepusta) → minus blacklist. `id`+`name` wymagane. */
export function applyLibraryFilter<T extends { id: string }>(folders: T[], included: string[], excluded: string[]): T[] {
  const inc = included.length ? folders.filter((f) => included.includes(f.id)) : folders;
  return excluded.length ? inc.filter((f) => !excluded.includes(f.id)) : inc;
}
