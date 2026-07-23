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
  const [moments, setMoments] = useState<string[]>([]); // foldery pokazywane w MOMENTS
  const [momentsSeeded, setMomentsSeeded] = useState(false); // czy zasiano już auto-folderami aparatu
  const hydrated = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(LIBRARY_KEY)
      .then((raw) => {
        if (!raw) return;
        const s = JSON.parse(raw) as { included?: string[]; excluded?: string[]; hidden?: string[]; moments?: string[]; momentsSeeded?: boolean };
        if (Array.isArray(s.included)) setIncluded(s.included);
        if (Array.isArray(s.excluded)) setExcluded(s.excluded);
        if (Array.isArray(s.hidden)) setHidden(s.hidden);
        if (Array.isArray(s.moments)) setMoments(s.moments);
        if (s.momentsSeeded) setMomentsSeeded(true);
      })
      .catch(() => {})
      .finally(() => { hydrated.current = true; });
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify({ included, excluded, hidden, moments, momentsSeeded })).catch(() => {});
  }, [included, excluded, hidden, moments, momentsSeeded]);

  const toggle = (id: string, which: 'inc' | 'exc' | 'hid' | 'mom') => {
    const setter = which === 'inc' ? setIncluded : which === 'exc' ? setExcluded : which === 'hid' ? setHidden : setMoments;
    setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return {
    included,
    excluded,
    hidden,
    toggleIncluded: (id: string) => toggle(id, 'inc'),
    toggleExcluded: (id: string) => toggle(id, 'exc'),
    toggleHidden: (id: string) => toggle(id, 'hid'),
    moments,
    toggleMoments: (id: string) => toggle(id, 'mom'),
    // Zasiej listę MOMENTS folderami aparatu — TYLKO raz (potem użytkownik zarządza ręcznie, także
    // wyzerowaniem do pustej). `hydrated` chroni przed nadpisaniem wczytanego stanu.
    seedMoments: (ids: string[]) => { if (hydrated.current && !momentsSeeded) { setMoments(ids); setMomentsSeeded(true); } },
    momentsSeeded,
  };
}

// Foldery „aparatowe" po nazwie — domyślne dla MOMENTS, gdy użytkownik nie wybrał ręcznie.
// Popularne lokalizacje zdjęć z telefonu: Camera / Camera RAW / DCIM / Screenshots.
const CAMERA_RE = /camera|dcim|screenshot|zrzut/i;
export function momentsFolderIds<T extends { id: string; name: string }>(folders: T[], moments: string[]): string[] {
  if (moments.length) return moments;
  return folders.filter((f) => CAMERA_RE.test(f.name)).map((f) => f.id);
}

/** Zastosuj filtr do listy folderów: whitelist (jeśli niepusta) → minus blacklist. `id`+`name` wymagane. */
export function applyLibraryFilter<T extends { id: string }>(folders: T[], included: string[], excluded: string[]): T[] {
  const inc = included.length ? folders.filter((f) => included.includes(f.id)) : folders;
  return excluded.length ? inc.filter((f) => !excluded.includes(f.id)) : inc;
}
