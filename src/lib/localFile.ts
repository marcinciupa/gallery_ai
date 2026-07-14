/**
 * ensureLocalFile — sprowadza dowolny URI obrazu do LOKALNEGO pliku (`file://`), który da się:
 *   • wgrać do proxy przez FormData (Android otwiera part tylko dla file/content/asset, NIE http/data),
 *   • zapisać do biblioteki przez `MediaLibrary.Asset.create` (wymaga lokalnego pliku).
 *
 * Dlaczego: wynik edycji AI z deAPI to zdalny `https://` (podpisany URL, wygasa ~5 h) albo `data:` (base64).
 * Bez pobrania do pliku łańcuchowa edycja (edycja już-edytowanego zdjęcia), generative-fill i ZAPIS
 * cicho padały. Pobranie w momencie edycji uniezależnia też apkę od wygaśnięcia podpisanego URL-a.
 *
 * Lokalne schematy (file/content/asset/ph) zwracamy bez zmian — są już nadające się do uploadu/zapisu.
 * Import z `expo-file-system/legacy` = stabilne API (downloadAsync/writeAsStringAsync) w SDK 56.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

const LOCAL_SCHEME = /^(file|content|asset|ph):/i;
const EXT_RE = /\.(png|jpe?g|webp)(?:\?|$)/i;

let seq = 0;
function cacheDest(ext: string): string {
  const dir = FileSystem.cacheDirectory ?? '';
  seq += 1;
  return `${dir}gai-${Date.now()}-${seq}.${ext}`;
}

/** Zwraca lokalny `file://` (lub oryginał, jeśli już lokalny). Rzuca przy błędzie pobrania/zapisu. */
export async function ensureLocalFile(uri: string): Promise<string> {
  if (!uri) throw new Error('empty uri');
  if (LOCAL_SCHEME.test(uri)) return uri;

  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new Error('malformed data uri');
    const base64 = uri.slice(comma + 1);
    const dest = cacheDest('png');
    await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType.Base64 });
    return dest;
  }

  if (/^https?:/i.test(uri)) {
    const ext = (uri.match(EXT_RE)?.[1] ?? 'png').toLowerCase();
    const { uri: local } = await FileSystem.downloadAsync(uri, cacheDest(ext));
    return local;
  }

  return uri; // nieznany schemat — spróbuj jak jest (nie blokujemy)
}

/**
 * bakeOrientation — WYPALA orientację EXIF w piksele (jak normalizacja w CropStage): manipulator dekoduje obraz
 * z uwzględnieniem EXIF i zapisuje „prosto", bez flagi orientacji. Dzięki temu backend (który ignoruje EXIF)
 * dostaje już poprawnie zorientowane piksele i nie zwraca obróconego/odwróconego wyniku (np. remove-background).
 * PNG (bezstratnie — brak degradacji przy edycji łańcuchowej). Błąd → oryginał (nie blokujemy wysyłki).
 */
export async function bakeOrientation(uri: string): Promise<string> {
  try {
    const r = await ImageManipulator.manipulateAsync(uri, [], { format: ImageManipulator.SaveFormat.PNG });
    return r.uri;
  } catch {
    return uri;
  }
}
