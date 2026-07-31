/**
 * ensureLocalFile — sprowadza dowolny URI obrazu do LOKALNEGO pliku (`file://`), który da się:
 *   • wgrać do proxy przez FormData (Android otwiera part tylko dla file/content/asset, NIE http/data),
 *   • zapisać do biblioteki przez `MediaLibrary.Asset.create` (wymaga lokalnego pliku).
 *
 * Dlaczego: wynik edycji AI z deAPI to zdalny `https://` (podpisany URL, wygasa ~5 h) albo `data:` (base64).
 * Bez pobrania do pliku łańcuchowa edycja (edycja już-edytowanego zdjęcia), generative-fill i ZAPIS
 * cicho padały. Pobranie w momencie edycji uniezależnia też apkę od wygaśnięcia podpisanego URL-a.
 *
 * Tylko realny `file://` zwracamy bez zmian. `content://` (galeria/MediaStore Androida), `asset://`, `ph://`
 * są czytelne przez ContentResolver, ale `uploadAsync` ORAZ `MediaLibrary` wymagają PRAWDZIWEJ ścieżki
 * pliku — więc kopiujemy je do katalogu roboczego (inaczej uploadAsync rzuca „Directory ... doesn't exist").
 * Import z `expo-file-system/legacy` = stabilne API (downloadAsync/writeAsStringAsync/copyAsync) w SDK 56.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

const CONTENT_SCHEME = /^(content|asset|ph):/i;
const EXT_RE = /\.(png|jpe?g|webp)(?:\?|$)/i;

/**
 * Katalog na pliki robocze edytora — ŚWIADOMIE `documentDirectory`, a NIE `cacheDirectory`.
 *
 * Android traktuje cache aplikacji jako miejsce do skasowania w dowolnej chwili i robi to, gdy kończy się
 * miejsce na dysku. Wynik edycji AI musi natomiast dożyć do momentu, aż użytkownik naciśnie SAVE — a to
 * bywa minuty później. Na urządzeniu testowym (dysk zajęty w 93%) plik z wynikiem znikał w kilkadziesiąt
 * sekund: obraz był jeszcze widoczny (zdążył trafić do cache'u `expo-image`), ale zapis do galerii padał
 * z `FileNotFoundException`, więc edycji nie dało się zachować.
 */
const WORK_DIR = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ''}gai-work/`;
/** Pliki robocze starsze niż doba są bezużyteczne (sesja edytora dawno zamknięta) — sprzątamy je. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let dirReady: Promise<void> | null = null;
/** Tworzy katalog roboczy (raz na uruchomienie) i przy okazji kasuje stare pliki. */
function ensureWorkDir(): Promise<void> {
  dirReady ??= (async () => {
    try { await FileSystem.makeDirectoryAsync(WORK_DIR, { intermediates: true }); } catch { /* już istnieje */ }
    void pruneOldFiles();
  })();
  return dirReady;
}

/** Sprzątanie best-effort: znacznik czasu jest w NAZWIE, więc nie trzeba odpytywać systemu o daty plików. */
async function pruneOldFiles(): Promise<void> {
  try {
    const names = await FileSystem.readDirectoryAsync(WORK_DIR);
    const now = Date.now();
    for (const name of names) {
      const stamp = Number(/^gai-(\d+)-/.exec(name)?.[1]);
      if (Number.isFinite(stamp) && now - stamp > MAX_AGE_MS) {
        await FileSystem.deleteAsync(WORK_DIR + name, { idempotent: true });
      }
    }
  } catch { /* sprzątanie nie może przeszkodzić w edycji */ }
}

let seq = 0;
async function workDest(ext: string): Promise<string> {
  await ensureWorkDir();
  seq += 1;
  return `${WORK_DIR}gai-${Date.now()}-${seq}.${ext}`;
}

/**
 * Przenosi WYNIK EDYCJI do katalogu roboczego, jeśli jeszcze tam nie leży. Dla plików z
 * `expo-image-manipulator` (kadr/rotacja), które lądują w cache'u biblioteki — a więc mogą zniknąć,
 * zanim użytkownik naciśnie SAVE (patrz [[WORK_DIR]]). Błąd kopiowania nie może zablokować edycji,
 * więc w najgorszym razie zostajemy przy oryginalnej ścieżce.
 */
export async function persistWorkFile(uri: string): Promise<string> {
  if (!uri || uri.startsWith(WORK_DIR)) return uri;
  try {
    const ext = (uri.match(EXT_RE)?.[1] ?? 'png').toLowerCase();
    const dest = await workDest(ext);
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri;
  }
}

/** Zwraca lokalny `file://` (lub oryginał, jeśli już lokalny). Rzuca przy błędzie pobrania/zapisu. */
export async function ensureLocalFile(uri: string): Promise<string> {
  if (!uri) throw new Error('empty uri');
  if (/^file:/i.test(uri)) return uri; // realny plik — od razu OK pod upload/zapis

  // content:// / asset:// / ph:// — skopiuj bajty przez resolver do realnego pliku w cache.
  if (CONTENT_SCHEME.test(uri)) {
    const ext = (uri.match(EXT_RE)?.[1] ?? 'jpg').toLowerCase(); // MediaStore URI nie ma rozszerzenia → domyślnie jpg
    const dest = await workDest(ext);
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  }

  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new Error('malformed data uri');
    const base64 = uri.slice(comma + 1);
    // Rozszerzenie WPROST z typu MIME — proxy oddaje kompozycję z maską jako JPEG, a plik `.png`
    // z bajtami JPEG-a myli MediaStore przy zapisie do galerii (zły mime na zapisanym zdjęciu).
    const semi = uri.indexOf(';');
    const mime = uri.slice(5, semi >= 0 && semi < comma ? semi : comma).toLowerCase();
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const dest = await workDest(ext);
    await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType.Base64 });
    return dest;
  }

  if (/^https?:/i.test(uri)) {
    const ext = (uri.match(EXT_RE)?.[1] ?? 'png').toLowerCase();
    const { uri: local } = await FileSystem.downloadAsync(uri, await workDest(ext));
    return local;
  }

  return uri; // nieznany schemat — spróbuj jak jest (nie blokujemy)
}

/**
 * bakeOrientation — WYPALA orientację EXIF w piksele (jak normalizacja w CropStage): manipulator dekoduje obraz
 * z uwzględnieniem EXIF i zapisuje „prosto", bez flagi orientacji. Dzięki temu backend (który ignoruje EXIF)
 * dostaje już poprawnie zorientowane piksele i nie zwraca obróconego/odwróconego wyniku (np. remove-background).
 * PNG (bezstratnie — brak degradacji przy edycji łańcuchowej). Błąd → oryginał (nie blokujemy wysyłki).
 *
 * `maxDim` (opcjonalnie) — cap dłuższego boku w px. Potrzebne dla upscalu: deAPI (RealESRGAN x4 = 16× pikseli)
 * odrzuca za dużą rozdzielczość wejścia (422 „invalid image dimensions"), więc duże zdjęcia zmniejszamy.
 */
export async function bakeOrientation(uri: string, maxDim?: number): Promise<string> {
  try {
    const r = await ImageManipulator.manipulateAsync(uri, [], { format: ImageManipulator.SaveFormat.PNG });
    const longest = Math.max(r.width, r.height);
    if (!maxDim || longest <= maxDim) return r.uri;
    // zmniejsz proporcjonalnie: ustawiamy tylko dłuższy bok = maxDim, manipulator dobiera drugi z zachowaniem proporcji
    const resize = r.width >= r.height ? { width: maxDim } : { height: maxDim };
    const capped = await ImageManipulator.manipulateAsync(r.uri, [{ resize }], { format: ImageManipulator.SaveFormat.PNG });
    return capped.uri;
  } catch {
    return uri;
  }
}
