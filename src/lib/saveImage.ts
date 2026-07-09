/**
 * Zapis edytowanego obrazu. Natywnie: do biblioteki zdjęć (`expo-media-library`, wymaga uprawnienia
 * zapisu). Web: pobranie pliku (anchor download) — biblioteka mediów nie działa w przeglądarce.
 */
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

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
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) return 'denied';
    await MediaLibrary.saveToLibraryAsync(uri);
    return 'ok';
  } catch {
    return 'error';
  }
}
