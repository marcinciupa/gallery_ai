/**
 * Zapis edytowanego obrazu. Natywnie: do biblioteki zdjęć przez NOWE API expo-media-library
 * (`Asset.create`, spójnie z `useMedia` — stare `saveToLibraryAsync` w SDK 56 rzuca w runtime).
 * Web: pobranie pliku (anchor download) — biblioteka mediów nie działa w przeglądarce.
 */
import { Platform } from 'react-native';
import { addAiTag } from './aiTags';

export type SaveResult = 'ok' | 'denied' | 'error';

// `ai` = zapisywany obraz powstał z ingerencją AI → oznacz nowy asset lokalnie (etykieta „AI" na miniaturze).
// STANDARD: docelowo zamiast lokalnego znacznika osadzać IPTC digitalSourceType / C2PA (wymaga native).
export async function saveImageToLibrary(uri: string, opts?: { ai?: boolean }): Promise<SaveResult> {
  if (!uri) return 'error';
  if (Platform.OS === 'web') {
    try {
      const a = document.createElement('a');
      a.href = uri;
      a.download = `edit_${Math.floor(Date.now() / 1000)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return 'ok';
    } catch {
      return 'error';
    }
  }
  try {
    const ML: any = await import('expo-media-library');
    const perm = await ML.requestPermissionsAsync();
    if (!perm.granted) return 'denied';
    const asset = await ML.Asset.create(uri); // dodaje plik do biblioteki (nowe klasowe API)
    if (opts?.ai && asset?.id) { try { await addAiTag(asset.id); } catch { /* tag best-effort */ } }
    return 'ok';
  } catch {
    return 'error';
  }
}
