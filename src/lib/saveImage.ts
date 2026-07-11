/**
 * Zapis edytowanego obrazu. Natywnie: do biblioteki zdjęć przez NOWE API expo-media-library
 * (`Asset.create`, spójnie z `useMedia` — stare `saveToLibraryAsync` w SDK 56 rzuca w runtime).
 * Web: pobranie pliku (anchor download) — biblioteka mediów nie działa w przeglądarce.
 */
import { Platform } from 'react-native';
import { ensureLocalFile } from './localFile';

export type SaveResult = 'ok' | 'denied' | 'error';

export async function saveImageToLibrary(uri: string): Promise<SaveResult> {
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
    // wynik AI to zdalny https:// / data: — Asset.create wymaga lokalnego pliku, więc najpierw pobieramy
    const local = await ensureLocalFile(uri);
    await ML.Asset.create(local); // dodaje plik do biblioteki (nowe klasowe API)
    return 'ok';
  } catch (e) {
    console.warn('[saveImage] save failed:', e); // nie połykaj po cichu — czytelna przyczyna w logach
    return 'error';
  }
}
