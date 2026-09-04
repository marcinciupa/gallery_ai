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
import { File as FsFile } from 'expo-file-system';
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
 * Trwałe kasowanie plików — używane przy MOVE (oryginały po skopiowaniu) i przy opróżnianiu kosza.
 *
 * ⚠️ ZMIANA 0.969: apka NIE MA JUŻ „dostępu do wszystkich plików" (`MANAGE_EXTERNAL_STORAGE`). Google Play
 * odrzuciło je dwukrotnie: galeria nie jest na liście dozwolonych zastosowań (menedżer plików, backup,
 * antywirus), a dla samych zdjęć polityka wymaga MediaStore. Uprawnienie NIGDY nie odblokowywało tu żadnej
 * funkcji — służyło wyłącznie do wyciszenia systemowego okna zgody, więc jego usunięcie nic nie psuje.
 *
 * Zostają DWIE ścieżki, w tej kolejności:
 *  1. `File.delete()` na ścieżce pliku — działa BEZ ŻADNEGO OKNA dla plików, których WŁAŚCICIELEM jest nasza
 *     apka (kopie z COPY/MOVE, zdjęcia zapisane po edycji AI). Android 11+ dopuszcza zapis po ścieżce do
 *     własnych plików bez uprawnień specjalnych — to jest zgodne z polityką i nie wymaga deklaracji.
 *     Dla cudzych plików (zdjęcia z aparatu) rzuci — i o to chodzi, spadamy niżej.
 *  2. `Asset.delete` → `MediaStore.createDeleteRequest` — JEDNO systemowe okno zgody na CAŁĄ paczkę,
 *     niezależnie czy kasujesz 1 zdjęcie czy 300. To jest droga, którą Google wskazuje wprost.
 *
 * ⚠️ NIE UŻYWAĆ legacy `deleteAsync` z `expo-file-system/legacy` (znalezione na emulatorze API 34, v0.9665):
 * sprawdza prawo zapisu na ścieżce z DOSŁOWNIE doklejonym `/..` (`Uri.withAppendedPath(uri, "..")`), a jądro
 * na `plik.jpg/..` zwraca ENOTDIR → `canWrite()` = false → „isn't deletable" ZANIM cokolwiek spróbuje skasować.
 * Nowe API (`File.delete()`) waliduje ścieżkę samego pliku.
 *
 * ⚠️ ŻADNEGO CICHEGO POMIJANIA. Wcześniejsza wersja przy nieczytelnej ścieżce pomijała plik w OBU ścieżkach:
 * bez kasowania, bez okna, bez błędu — a wołający raportował sukces. Przy MOVE znaczyło to „przeniesiono",
 * podczas gdy oryginał zostawał na miejscu. Teraz każdy plik kończy albo w `deleted`, albo w `leftovers`.
 */
async function deleteCore(ML: any, assetIds: string[]): Promise<{ deleted: string[]; denied: boolean }> {
  const deleted: string[] = [];
  const leftovers: string[] = [];
  for (const id of assetIds) {
    try {
      const path = await new ML.Asset(id).getUri();
      if (!path) { leftovers.push(id); continue; }
      const file = new FsFile(path);
      // ⚠️ `exists === false` NIE ZNACZY „pliku nie ma". `FileSystemFile.exists` zwraca false także wtedy, gdy
      // apka nie ma prawa ODCZYTU ścieżki (`File.canRead()`), a bez „dostępu do wszystkich plików" dotyczy to
      // m.in. karty SD. Gdyby brać to za sukces, kasowanie z kosza raportowałoby „skasowane" bez skasowania
      // czegokolwiek i bez okna zgody — wpis znikałby z kosza, a zdjęcie wracało do galerii. Więc: nie widzę
      // pliku → oddaję sprawę drodze systemowej, ona rozstrzygnie. Osierocony wiersz MediaStore skasuje się
      // wtedy bez szkody, a plik na SD dostanie okno zgody, którego naprawdę potrzebuje.
      if (!file.exists) { leftovers.push(id); continue; }
      file.delete();
      if (file.exists) { leftovers.push(id); continue; } // delete nie rzucił, ale plik został → droga systemowa
      deleted.push(id);
    } catch {
      leftovers.push(id); // brak prawa zapisu (cudzy plik) albo nieczytelna ścieżka → droga systemowa
    }
  }
  if (!leftovers.length) return { deleted, denied: false };
  try {
    await ML.Asset.delete(leftovers.map((id: string) => new ML.Asset(id))); // JEDNO okno na całą resztę
    deleted.push(...leftovers);
    return { deleted, denied: false };
  } catch {
    return { deleted, denied: true }; // user odmówił — `deleted` mówi, co mimo to zniknęło
  }
}

/**
 * Sprzątanie WŁASNYCH kopii po nieudanym MOVE. Świadomie po ścieżce, a NIE przez `Asset.delete`: ten idzie
 * przez `MediaStore.createDeleteRequest` (AssetModernDeleter → DeleteContract), czyli pokazałby DRUGIE okno
 * zgody zaraz po tym, jak użytkownik odmówił w pierwszym. Kopie zrobiliśmy my, więc plikowe kasowanie
 * własnego pliku przechodzi bez pytania. Gdy się nie uda — zostaje duplikat, i to jest lepszy wynik niż
 * kolejny systemowy dialog.
 */
async function deleteOwnCopies(assets: any[]): Promise<void> {
  for (const a of assets) {
    try {
      const path = await a?.getUri?.();
      if (!path) continue;
      const f = new FsFile(path);
      if (f.exists) f.delete();
    } catch { /* zostaje duplikat — świadomie */ }
  }
}

/**
 * Kasowanie na zlecenie apki (kosz). Zwraca ID, które FAKTYCZNIE zniknęły — wołający ma po czym poznać, czego
 * NIE usuwać ze swojego stanu, gdy użytkownik odmówił w systemowym oknie. Nie rzuca.
 */
export async function deleteAssets(assetIds: string[]): Promise<string[]> {
  if (!nativeOnly() || !assetIds.length) return [];
  return (await deleteCore(await loadML(), assetIds)).deleted;
}

/**
 * MOVE do ISTNIEJĄCEGO albumu: kopia do celu + skasowanie oryginałów (jedno systemowe okno na paczkę).
 * Kasujemy WYŁĄCZNIE te oryginały, których kopia faktycznie powstała — inaczej nieudana kopia oznaczałaby
 * utratę pliku.
 *
 * ⚠️ ODMOWA W OKNIE ZGODY JEST CZĘŚCIOWA. Paczka bywa mieszana: pliki NASZE (kopie, zdjęcia po edycji AI)
 * kasują się od razu i bez pytania, cudze idą przez okno. Gdy user odmówi, część oryginałów już nie istnieje —
 * kasowanie ich kopii oznaczałoby BEZPOWROTNĄ UTRATĘ ZDJĘCIA. Dlatego sprzątamy tylko te kopie, których
 * oryginał PRZEŻYŁ (żeby nie zostawić duplikatu), a resztę zostawiamy i uczciwie raportujemy jako przeniesione.
 */
export async function moveToAlbum(
  assetIds: string[],
  albumId: string,
  onProgress?: (done: number, total: number) => void
): Promise<MediaOpResult> {
  if (!nativeOnly() || !assetIds.length) return { ok: 0, fail: assetIds.length };
  const ML = await loadML();
  const album = new ML.Album(albumId);
  const { created, copiedIds } = await copyIntoAlbum(ML, assetIds, album, onProgress);
  if (!copiedIds.length) return { ok: 0, fail: assetIds.length, albumId };
  const { deleted } = await deleteCore(ML, copiedIds);
  const moved = new Set(deleted);
  const orphanCopies = created.filter((_: any, i: number) => !moved.has(copiedIds[i]));
  // kopie bez skasowanego oryginału = duplikaty; są NASZE, więc kasujemy je po ścieżce — bez kolejnego okna
  if (orphanCopies.length) await deleteOwnCopies(orphanCopies);
  await moveAiTags(
    copiedIds.filter((id: string) => moved.has(id)),
    created.filter((_: any, i: number) => moved.has(copiedIds[i]))
  );
  return { ok: deleted.length, fail: assetIds.length - deleted.length, albumId };
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
  // ⚠️ KOLIZJA NAZWY = RYZYKO SKASOWANIA CUDZEGO ALBUMU. Natywne `Album.create` NIE tworzy nowego albumu, gdy
  // katalog `Pictures/<name>/` już istnieje: `AlbumModernFactory.createFromFilePaths` robi po wstawieniu
  // `queryAlbumId(relativePath)` i oddaje id ISTNIEJĄCEGO kubełka. Walidacja w UI (`nameTaken`) liczy po
  // WIDOCZNEJ liście folderów, więc nie zna folderów ukrytych, odfiltrowanych w Settings ani takich, których
  // wszystkie zdjęcia siedzą w koszu — i taką nazwę przepuści. Wcześniejszy rollback wołał wtedy
  // `Album.delete`, które natywnie kasuje WSZYSTKIE assety kubełka: odmowa w oknie zgody mogła wyczyścić
  // cudzy, wielosetzdjęciowy folder. Dlatego kolizję wykrywamy PRZED utworzeniem i po prostu przenosimy do
  // istniejącego albumu (to samo, co MOVE do folderu z listy), a rollback NIGDY nie kasuje albumu.
  // Uwaga na zakres: `Album.get` dopasowuje po `BUCKET_DISPLAY_NAME` w CAŁEJ pamięci, a `Album.create`
  // założyłoby `Pictures/<name>/`. Więc gdy folder o tej nazwie leży gdzie indziej (np. `DCIM/Trip`),
  // trafimy do NIEGO zamiast zakładać nowy w `Pictures`. Świadomy kompromis: zdjęcia lądują w folderze
  // o nazwie, którą użytkownik wpisał, i nic nie ginie — a alternatywą było ryzyko skasowania cudzego albumu.
  const existing = await ML.Album.get(name).catch(() => null);
  if (existing?.id) {
    return op === 'MOVE'
      ? moveToAlbum(assetIds, existing.id, onProgress)
      : copyToAlbum(assetIds, existing.id, onProgress);
  }
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
      // Ta sama zasada co w `moveToAlbum`: przy częściowej odmowie NIE kasujemy kopii, których oryginał już
      // zniknął — to byłaby utrata zdjęcia. Sprzątamy tylko duplikaty (oryginał przeżył). Świeży album
      // usuwamy jedynie wtedy, gdy nie przeniosło się NIC.
      const { deleted } = await deleteCore(ML, done);
      const moved = new Set(deleted);
      const orphanCopies = doneCopies.filter((c: any, i: number) => c && !moved.has(done[i]));
      // Kopie kasujemy po ścieżce (nasze pliki, bez okna). Świeżo utworzonego albumu NIE kasujemy przez
      // `Album.delete` — natywnie kasuje ono całą zawartość kubełka, co przy kolizji nazw jest bombą.
      // Album bez zawartości i tak nie istnieje dla MediaStore, więc nie ma czego sprzątać.
      if (orphanCopies.length) await deleteOwnCopies(orphanCopies);
      if (!deleted.length) return { ok: 0, fail: assetIds.length };
      await moveAiTags(
        done.filter((id: string) => moved.has(id)),
        doneCopies.filter((_: any, i: number) => moved.has(done[i]))
      );
      return { ok: deleted.length, fail: assetIds.length - deleted.length, albumId: album?.id };
    }
    await copyAiTags(done, doneCopies);
    return { ok: done.length, fail, albumId: album?.id };
  } catch {
    return { ok: 0, fail: assetIds.length };
  }
}
