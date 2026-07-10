/**
 * Zapis edytowanego obrazu. Natywnie: do biblioteki zdjęć przez NOWE API expo-media-library
 * (`Asset.create`, spójnie z `useMedia` — stare `saveToLibraryAsync` w SDK 56 rzuca w runtime).
 * Web: pobranie pliku (anchor download) — biblioteka mediów nie działa w przeglądarce.
 */
import { Platform } from 'react-native';

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
    await ML.Asset.create(uri); // dodaje plik do biblioteki (nowe klasowe API)
    return 'ok';
  } catch {
    return 'error';
  }
}
