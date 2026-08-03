/**
 * mediaOps — PRZENOSZENIE i KOPIOWANIE plików w bibliotece urządzenia (expo-media-library, class-based API).
 * Uzupełnia `useMedia` (odczyt + kasowanie) o operacje zmieniające przynależność zdjęcia do albumu.
 *
 * ⚠️ DLACZEGO MOVE = KOPIA + KASOWANIE ORYGINAŁU, a nie `album.add()`
 * `album.add(assets)` woła natywnie `updateRelativePath` (AssetExtensions.kt), które ustawia WYŁĄCZNIE
 * `RELATIVE_PATH`. Kolumny `BUCKET_ID` / `BUCKET_DISPLAY_NAME` (po nich MediaStore grupuje foldery) są
 * wyliczane przez MediaProvider i przy takiej aktualizacji potrafią NIE zostać przeliczone. Efekt na
 * urządzeniu (2026-08-03): plik fizycznie leżał w nowym katalogu i inne galerie go tam pokazywały, ale
 * dla MediaStore wciąż należał do starego kubełka — a że CAŁE expo-media-library (lista albumów, licznik
 * zdjęć, zapytanie o zawartość) filtruje po `BUCKET_ID`, w naszej apce plik zniknął z obu folderów.
 * Licznik folderu docelowego pokazywał 3 zamiast 4, więc problem był w indeksie, nie w naszej siatce.
 * Z JS nie mamy jak wymusić przeskanowania pliku (MediaScannerConnection to API natywne), dlatego
 * przenosimy WŁASNYM wstawieniem: `Asset.create` robi normalny `insert` do MediaStore, przy którym
 * kolumny kubełka liczą się od nowa i zawsze są poprawne. Potem kasujemy oryginał.
 *
 * Konsekwencje tej decyzji:
 *  • plik dostaje NOWE content:// URI (nasze `photoKey`), więc znacznik AI przenosimy jawnie (retagAiAsset),
 *  • zamiast systemowego dialogu ZAPISU pojawia się systemowy dialog KASOWANIA — nadal jeden na paczkę,
 *  • odmowa w tym dialogu = sprzątamy własne kopie, żeby nie zostawić duplikatów (operacja albo cała, albo nic),
 *  • kosztuje realne przepisanie bajtów (wolniejsze niż zmiana ścieżki) — cena za poprawny wynik.
 *
 * Pozostałe fakty natywne, które kształtują ten plik:
 *  • COPY musi iść przez `Asset.create(<ścieżka pliku>, album)`. NIE przez `Album.create(name, assets, false)`
 *    ani natywne `Asset.copy` — one wpisują jako DISPLAY_NAME całe `file:///storage/...`, więc kopia dostaje
 *    śmieciową nazwę. Ścieżkę bierzemy z `asset.getUri()`, bo `Asset.create` wyprowadza nazwę pliku z
 *    ostatniego segmentu (z content:// URI wyszłoby samo ID, bez rozszerzenia).
 *  • Na Androidzie zdjęcie należy do JEDNEGO albumu (brak „usuń z albumu bez kasowania").
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { getAiTags, addAiTag, retagAiAsset } from './aiTags';

/** Wynik operacji: ile plików się udało, ile padło, oraz id albumu docelowego (do klawisza OPEN). */
export type MediaOpResult = { ok: number; fail: number; albumId?: string };

/**
 * Nazwa nowego folderu trafia do `MediaStore.RELATIVE_PATH`, a natywny walidator (RelativePath.kt) przyjmuje
 * WYŁĄCZNIE `[\w -]+` — polskie znaki, kropki czy ukośniki rzucają wyjątkiem ZANIM folder powstanie. Dlatego
 * walidujemy w polu, a nie po fakcie.
 */
export const ALBUM_NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;
export const isValidAlbumName = (name: string) => ALBUM_NAME_RE.test(name.trim());

const nativeOnly = () => Platform.OS === 'android' || Platform.OS === 'ios';
const loadML = async (): Promise<any> => await import('expo-media-library');

/**
 * Źródło do skopiowania: PRAWDZIWA ścieżka pliku (`file://…`), bo z niej `Asset.create` bierze nazwę kopii.
 * Gdy `getUri()` nie zadziała (scoped storage bywa kapryśne), przepisujemy bajty przez ContentResolver do
 * cache — pod poprawną nazwą z metadanych, żeby kopia nie nazwała się numerem wiersza MediaStore.
 */
let tmpSeq = 0;
async function readableSource(ML: any, assetId: string): Promise<{ uri: string; cleanup?: () => Promise<void> }> {
  const asset = new ML.Asset(assetId);
  try {
    const uri = await asset.getUri();
    if (uri && /^file:/i.test(uri)) return { uri };
  } catch { /* spadamy na kopię do cache */ }
  // Nazwa pliku w cache MUSI zostać oryginalna (to z niej `Asset.create` bierze nazwę kopii), więc żeby
  // dwa pliki o tej samej nazwie nie deptały sobie po ścieżce, każdy dostaje własny katalog tymczasowy.
  const name = (await asset.getFilename().catch(() => null)) || `photo-${Date.now()}.jpg`;
  tmpSeq += 1;
  const dir = `${FileSystem.cacheDirectory ?? ''}mediaops-${tmpSeq}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const dest = `${dir}${name}`;
  await FileSystem.copyAsync({ from: assetId, to: dest });
  return { uri: dest, cleanup: () => FileSystem.deleteAsync(dir, { idempotent: true }) };
}

/**
 * Wstawia kopie assetów do albumu. Zwraca PARY źródło↔kopia — bez nich nie da się ani skasować wyłącznie
 * udanych oryginałów (MOVE), ani poprawnie przenieść etykiet AI. Etykiet TU nie ruszamy, bo znaczą co
 * innego przy MOVE (przenieś) i przy COPY (oryginał zostaje, więc etykietę trzeba zduplikować).
 */
async function copyIntoAlbum(
  ML: any,
  assetIds: string[],
  album: any,
  onProgress?: (done: number, total: number) => void
): Promise<{ created: any[]; copiedIds: string[]; fail: number }> {
  const created: any[] = [];
  const copiedIds: string[] = [];
  let fail = 0;
  for (let i = 0; i < assetIds.length; i++) {
    const src = await readableSource(ML, assetIds[i]).catch(() => null);
    if (src) {
      try {
        const asset = await ML.Asset.create(src.uri, album);
        created.push(asset);
        copiedIds.push(assetIds[i]);
      } catch {
        fail++;
      } finally {
        await src.cleanup?.().catch(() => {});
      }
    } else {
      fail++;
    }
    onProgress?.(i + 1, assetIds.length);
  }
  return { created, copiedIds, fail };
}

/** MOVE: etykieta AI wędruje ze zdjęciem (oryginał znika). Wołane DOPIERO po udanym skasowaniu oryginałów. */
async function moveAiTags(srcIds: string[], created: any[]): Promise<void> {
  for (let i = 0; i < srcIds.length && i < created.length; i++) {
    if (created[i]?.id) { try { await retagAiAsset(srcIds[i], created[i].id); } catch { /* dodatek */ } }
  }
}

/** COPY: oryginał ZOSTAJE ze swoją etykietą, a kopia dostaje własną (kopia zdjęcia AI to nadal zdjęcie AI). */
async function copyAiTags(srcIds: string[], created: any[]): Promise<void> {
  try {
    const tagged = await getAiTags();
    for (let i = 0; i < srcIds.length && i < created.length; i++) {
      if (tagged.has(srcIds[i]) && created[i]?.id) await addAiTag(created[i].id);
    }
  } catch { /* dodatek */ }
}

/**
 * Skasowanie oryginałów (po skopiowaniu przy MOVE) oraz trwałe kasowanie z kosza.
 *
 * ⚠️ DLACZEGO NIE `Asset.delete`: OBIE ścieżki kasowania w expo-media-library — nowa (`AssetModernDeleter`)
 * i stara (`MediaLibraryModule.deleteAssetsAsync`) — kończą się `createDeleteRequest`, czyli systemowym oknem
 * zgody. Stara filtruje wprawdzie URI przez `checkUriPermission`, ale ten sprawdza WYŁĄCZNIE uprawnienia
 * nadane per-URI i NIE uwzględnia `MANAGE_EXTERNAL_STORAGE`. Dlatego okno wyskakiwało nawet po przyznaniu
 * „dostępu do wszystkich plików".
 *
 * Rozwiązanie: mając to uprawnienie, kasujemy PLIK wprost przez system plików. Na Androidzie 11+ dostęp
 * plikowy idzie przez FUSE, więc MediaProvider sam usuwa wtedy wpis z MediaStore. Dla pewności sprawdzamy
 * po każdym pliku, czy wpis faktycznie zniknął — jeśli nie (np. karta SD), dokańczamy takie sztuki starą
 * drogą z oknem zgody, żeby nie zostawić „duchów": miniatur wskazujących na nieistniejące pliki.
 * Bez uprawnienia zachowanie jest jak dotąd: jedno systemowe okno na paczkę.
 */
export async function deleteAssets(assetIds: string[]): Promise<void> {
  if (!nativeOnly() || !assetIds.length) return;
  await deleteOriginals(await loadML(), assetIds);
}

async function deleteOriginals(ML: any, assetIds: string[]): Promise<void> {
  // NAJPIERW kasowanie pliku wprost — bez pytania o nic. Nie sprawdzamy wcześniej uprawnienia (próba odczytu
  // katalogu sama bywała zawodna i wysyłała nas na ścieżkę systemową mimo przyznanego dostępu): jeśli
  // uprawnienia nie ma, po prostu rzuci i spadniemy niżej. Operacja jest tu jedynym wiarygodnym testem.
  const leftovers: string[] = [];
  for (const id of assetIds) {
    let path = '';
    try {
      path = await new ML.Asset(id).getUri();
      if (!path) throw new Error('NO PATH');
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {
      // brak prawa zapisu do pliku (czyli brak „dostępu do wszystkich plików") → niech pójdzie drogą systemową
      leftovers.push(id);
      continue;
    }
    // Sprawdzamy TYLKO to, co jest rozstrzygające: czy pliku faktycznie nie ma. Wcześniej pytałem jeszcze
    // MediaStore o nazwę i brak błędu brałem za „wpis został" — a ten indeks nadąża za FUSE z opóźnieniem,
    // więc dla realnie skasowanego pliku i tak wchodziliśmy w systemowe kasowanie, czyli w to okno, które
    // właśnie omijamy. Ewentualny osierocony rekord MediaProvider sprząta sam.
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) leftovers.push(id);
    } catch { /* nie da się sprawdzić — ufamy, że deleteAsync nie rzucił */ }
  }
  if (!leftovers.length) return;
  await ML.Asset.delete(leftovers.map((id: string) => new ML.Asset(id))); // rzuci, gdy user odmówi
}

/**
 * MOVE do ISTNIEJĄCEGO albumu: kopia do celu + skasowanie oryginałów (jeden systemowy dialog na paczkę).
 * Kasujemy WYŁĄCZNIE te oryginały, których kopia faktycznie powstała — inaczej nieudana kopia oznaczałaby
 * utratę pliku. Odmowa dialogu = kasujemy własne kopie i raportujemy zero (bez duplikatów w bibliotece).
 */
export async function moveToAlbum(
  assetIds: string[],
  albumId: string,
  onProgress?: (done: number, total: number) => void
): Promise<MediaOpResult> {
  if (!nativeOnly() || !assetIds.length) return { ok: 0, fail: assetIds.length };
  const ML = await loadML();
  const album = new ML.Album(albumId);
  const { created, copiedIds, fail } = await copyIntoAlbum(ML, assetIds, album, onProgress);
  if (!copiedIds.length) return { ok: 0, fail: assetIds.length, albumId };
  try {
    await deleteOriginals(ML, copiedIds);
  } catch {
    try { await ML.Asset.delete(created); } catch { /* nie udało się posprzątać — trudno, plik zostaje */ }
    return { ok: 0, fail: assetIds.length, albumId };
  }
  await moveAiTags(copiedIds, created);
  return { ok: copiedIds.length, fail, albumId };
}

/** COPY do ISTNIEJĄCEGO albumu — plik po pliku, z raportem postępu (bez dialogu systemowego). */
export async function copyToAlbum(
  assetIds: string[],
  albumId: string,
  onProgress?: (done: number, total: number) => void
): Promise<MediaOpResult> {
  if (!nativeOnly() || !assetIds.length) return { ok: 0, fail: assetIds.length };
  const ML = await loadML();
  const { created, copiedIds, fail } = await copyIntoAlbum(ML, assetIds, new ML.Album(albumId), onProgress);
  await copyAiTags(copiedIds, created);
  return { ok: copiedIds.length, fail, albumId };
}

/**
 * NOWY folder + operacja w JEDNYM kroku (album bez zawartości i tak nie istnieje w MediaStore).
 * Album zakładamy przeciążeniem ze ŚCIEŻKAMI (`Album.create(name, filePaths)`) — ono kopiuje pliki przez
 * `assetFactory.create`, czyli normalnym insertem, więc kubełek jest poprawny i nazwy plików też.
 * MOVE = to samo + skasowanie oryginałów (jak wyżej). NIE używamy `Album.create(name, assets, true)`,
 * bo to znowu `updateRelativePath` z tym samym błędem kubełka.
 */
export async function createAlbumWith(
  name: string,
  assetIds: string[],
  op: 'MOVE' | 'COPY',
  onProgress?: (done: number, total: number) => void
): Promise<MediaOpResult> {
  if (!nativeOnly() || !assetIds.length) return { ok: 0, fail: assetIds.length };
  const ML = await loadML();
  try {
    // Album materializujemy PIERWSZYM plikiem (album bez zawartości nie istnieje w MediaStore), a resztę
    // dokładamy tą samą, sprawdzoną ścieżką co przy istniejącym albumie. Dzięki temu mamy dokładne pary
    // źródło↔kopia (potrzebne do etykiet AI i do kasowania tylko udanych), zamiast zgadywać po kolejności.
    const first = await readableSource(ML, assetIds[0]).catch(() => null);
    if (!first) return { ok: 0, fail: assetIds.length };
    onProgress?.(0, assetIds.length);
    let album: any;
    try {
      album = await ML.Album.create(name, [first.uri]);
    } finally {
      await first.cleanup?.().catch(() => {});
    }
    // świeży album ma dokładnie JEDEN asset — naszą kopię, więc para źródło↔kopia jest jednoznaczna
    let firstCopy: any = null;
    try { firstCopy = (await album.getAssets())[0] ?? null; } catch { /* etykieta AI to dodatek */ }
    onProgress?.(1, assetIds.length);

    const rest = assetIds.slice(1);
    const { created, copiedIds, fail } = rest.length
      ? await copyIntoAlbum(ML, rest, album, (done, n) => onProgress?.(1 + done, 1 + n))
      : { created: [] as any[], copiedIds: [] as string[], fail: 0 };
    const done = [assetIds[0], ...copiedIds];

    const doneCopies = [firstCopy, ...created];
    if (op === 'MOVE') {
      try {
        await deleteOriginals(ML, done);
      } catch {
        // odmowa kasowania → sprzątamy kopie i cały świeżo utworzony album, żeby nie zostawić duplikatów
        try { await ML.Asset.delete(created); } catch { /* best-effort */ }
        try { await ML.Album.delete([album]); } catch { /* best-effort */ }
        return { ok: 0, fail: assetIds.length };
      }
      await moveAiTags(done, doneCopies);
    } else {
      await copyAiTags(done, doneCopies);
    }
    return { ok: done.length, fail, albumId: album?.id };
  } catch {
    return { ok: 0, fail: assetIds.length };
  }
}
