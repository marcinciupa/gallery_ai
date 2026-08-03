/**
 * allFilesAccess — „dostęp do wszystkich plików" (`MANAGE_EXTERNAL_STORAGE`), czyli to samo uprawnienie,
 * które mają menedżery plików (Solid Explorer) i galerie spoza systemu, które nie pytają o nic przy
 * przenoszeniu i kasowaniu.
 *
 * PO CO: bez niego Android przy KAŻDEJ operacji na cudzym pliku (zdjęcia z aparatu należą do aplikacji
 * aparatu) pokazuje systemowe okno zgody — przy przenoszeniu prosimy o skasowanie oryginału, patrz mediaOps.
 * Z nim MediaProvider widzi, że mamy pełny dostęp, i okna nie pokazuje.
 *
 * ⚠️ To uprawnienie SPECJALNE: nie przyznaje się go zwykłym runtime-owym pytaniem, tylko przełącznikiem na
 * osobnym ekranie ustawień systemu (`ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`). Nie da się go też
 * odczytać przez PermissionsAndroid — stan wykrywamy próbą odczytu katalogu poza naszym obszarem.
 *
 * ⚠️ POLITYKA GOOGLE PLAY: dopuszcza je dla menedżerów plików, backupu i antywirusów. Galeria nie jest na tej
 * liście, więc przy wysyłce aktualizacji do sklepu trzeba to uzasadnić albo usunąć. Dla wersji instalowanej
 * z APK nie ma znaczenia. Apka działa BEZ tego uprawnienia — wtedy po prostu wraca systemowe okno zgody.
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

const PKG = 'com.glue010.galleryai';
// Test ZAPISU na ISTNIEJĄCYM katalogu. `expo-file-system` sprawdza uprawnienie przez `File.canWrite()` DLA
// PODANEJ ŚCIEŻKI — a dla ścieżki, która jeszcze nie istnieje, `canWrite()` zawsze zwraca false. Poprzednia
// wersja próbowała utworzyć katalog `.gallery_ai_probe` i przez to raportowała brak dostępu nawet wtedy, gdy
// uprawnienie było przyznane (apka pytała o nie przy każdym kasowaniu). `makeDirectoryAsync` z
// `intermediates: true` na istniejącym katalogu kończy się sukcesem i NICZEGO nie tworzy — czyli jest czystym
// sprawdzeniem prawa zapisu do korzenia pamięci współdzielonej.
const PROBE_DIR = 'file:///storage/emulated/0/';

export async function hasAllFilesAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    await FileSystem.makeDirectoryAsync(PROBE_DIR, { intermediates: true });
    return true;
  } catch {
    return false;
  }
}

/** Otwiera systemowy ekran z przełącznikiem „dostęp do wszystkich plików" dla NASZEJ apki. */
export async function openAllFilesAccessSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync('android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION', {
      data: `package:${PKG}`,
    });
  } catch {
    // niektóre nakładki nie mają ekranu per-apka → otwórz listę ogólną
    try { await IntentLauncher.startActivityAsync('android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION'); } catch { /* brak ekranu */ }
  }
}
