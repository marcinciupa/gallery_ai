/**
 * Klient edycji obrazu AI (deAPI / model z-image). Wzorzec z rec_ai: klucz API trzyma cienki BACKEND-PROXY,
 * nigdy bundle apki — apka woła proxy, proxy forwarduje do deAPI. Baza z `EXPO_PUBLIC_API_URL`.
 *
 * STAN: STUB. Dopóki `EXPO_PUBLIC_API_URL` nie jest ustawione, `editImage` zwraca wejściowy obraz po
 * krótkim opóźnieniu (echo) — pełny przepływ UI działa bez backendu. Po postawieniu proxy wystarczy
 * ustawić env; realna ścieżka (multipart image+prompt → { uri }) jest już poniżej.
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { ensureLocalFile, bakeOrientation } from './localFile';

const BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');
const APP_KEY = process.env.EXPO_PUBLIC_APP_KEY;
const appKeyHeader: Record<string, string> = APP_KEY ? { 'X-App-Key': APP_KEY } : {};

// Cap dłuższego boku wysyłanego obrazu (px). deAPI odrzuca za dużą rozdzielczość (422 „invalid image dimensions"),
// a zdjęcia z telefonu (3000–4000 px) daleko przekraczają limity modeli. Limity per model (bok):
//   • edycja/fill/erase (Flux_2_Klein) = 256–1536   • upscale (RealESRGAN_x4) = 128–2048   • tło (Ben2) = 128–2048
// 1536 to wspólny bezpieczny mianownik dla WSZYSTKICH tras (mieści się w każdym limicie) → jeden cap wszędzie.
const AI_MAX_DIM = 1536;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type ImageEditResult = { uri: string };

/**
 * MASKA INPAINTINGU — pociągnięcia pędzla w współrzędnych ZNORMALIZOWANYCH (0…1 względem pola obrazu);
 * `size` = szerokość pędzla znormalizowana do SZEROKOŚCI pola. Wysyłamy wektor, nie PNG: kilka kB zamiast
 * setek, bez rasteryzacji na telefonie, a backend i tak rasteryzuje ją w rozdzielczości realnego zdjęcia.
 * Bez maski model deAPI regeneruje CAŁY obraz (nie ma maskowanego inpaintingu) i edycja wychodzi daleko
 * poza zaznaczenie — maska + kompozycja po stronie proxy to jedyne, co ją lokalizuje.
 */
export type MaskStroke = { add: boolean; size: number; pts: [number, number][] };
export type MaskPaths = { strokes: MaskStroke[] };

/** Serializacja maski do pola multipart. 4 miejsca po przecinku = ~0.15 px na zdjęciu 1536 px (dość). */
function maskField(mask?: MaskPaths | null): Record<string, string> {
  if (!mask?.strokes.length) return {};
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  const strokes = mask.strokes.map((s) => ({ add: s.add, size: r(s.size), pts: s.pts.map(([x, y]) => [r(x), r(y)]) }));
  return { mask_paths: JSON.stringify({ strokes }) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Czy edycja AI woła realny backend (env ustawione), czy działa na stubie. */
export const AI_STUB = !BASE;

/**
 * Edytuje obraz promptem. `uri` = lokalny URI zdjęcia (asset/plik), `prompt` = instrukcja edycji,
 * `mask` (opcjonalnie) = zamalowany obszar → INPAINTING: zmiana zostaje w zaznaczeniu, reszta pikseli
 * pochodzi z oryginału. Zwraca URI wyniku. Rzuca `ApiError` przy błędzie backendu.
 */
export async function editImage({ uri, prompt, mask }: { uri: string; prompt: string; mask?: MaskPaths | null }): Promise<ImageEditResult> {
  if (AI_STUB) {
    // STUB — echo wejściowego obrazu (podmień na realny wynik po podłączeniu proxy deAPI/z-image)
    await sleep(1400);
    return { uri };
  }

  // REALNY proxy: multipart (obraz + prompt [+ maska]) → backend forwarduje do deAPI i zwraca wynik.
  // Cap 1536: Flux (model edycji) odrzuca wejście > 1536 px (422) — bez capa edycja realnych zdjęć padała.
  return postImage('/api/v1/image-edits', uri, { prompt, ...maskField(mask) }, AI_MAX_DIM);
}

/**
 * Generative fill — wypełnia PRZEZROCZYSTE/puste obszary obrazu (np. rogi po kadrze z obrotem).
 * `uri` = obraz PNG, w którym obszary do domalowania są przezroczyste. Maski nie wysyłamy: backend
 * odczyta ją wprost z kanału alfa i po edycji złoży wynik tak, by przemalowane zostały TYLKO dziury.
 * STUB: zwraca wejściowy obraz.
 */
export async function fillImage({ uri }: { uri: string }): Promise<ImageEditResult> {
  if (AI_STUB) {
    await sleep(1400);
    return { uri };
  }
  // `mask_from_alpha` = zgoda na nowy kontrakt tej trasy (maska z alfy + kompozycja + odpowiedź obrazem).
  // Bez tej flagi proxy zachowuje się jak dla starszych wydań apki, które nie umiały odczytać `mime`.
  return postImage('/api/v1/image-fills', uri, { mask_from_alpha: '1' }, AI_MAX_DIM); // Flux (edycja) → cap 1536, inaczej 422
}

/**
 * Magic Erase — usuwa zamalowany palcem obszar i domalowuje tło (inpaint).
 * `mask` = pociągnięcia pędzla; bez niej backend usuwa „cokolwiek niechcianego" z całego zdjęcia.
 * STUB: echo wejścia.
 */
export async function eraseImage({ uri, mask }: { uri: string; mask?: MaskPaths | null }): Promise<ImageEditResult> {
  if (AI_STUB) {
    await sleep(1400);
    return { uri };
  }
  return postImage('/api/v1/image-erase', uri, maskField(mask), AI_MAX_DIM); // Flux (edycja) → cap 1536
}

/**
 * Remove Background — usuwa tło, zostawia pierwszy plan (jednoklik, bez maski).
 * STUB: echo wejścia. Realnie: proxy → deAPI (segmentacja/rembg).
 */
export async function removeBackground({ uri }: { uri: string }): Promise<ImageEditResult> {
  if (AI_STUB) {
    await sleep(1400);
    return { uri };
  }
  // Model tła (Ben2) też ma limit rozdzielczości wejścia (duże zdjęcia z telefonu dostają 422) → cap.
  return postImage('/api/v1/remove-background', uri, {}, AI_MAX_DIM);
}

/**
 * Upscale — powiększa i wyostrza obraz dedykowanym modelem (deAPI: RealESRGAN x4). Jednoklik, bez promptu/maski.
 * STUB: echo wejścia. Realnie: proxy → deAPI (RealESRGAN_x4).
 */
export async function upscaleImage({ uri }: { uri: string }): Promise<ImageEditResult> {
  if (AI_STUB) {
    await sleep(1400);
    return { uri };
  }
  // deAPI upscale (x4) ma limit rozdzielczości wejścia — duże zdjęcia z telefonu (np. 2000×2800) dostają 422.
  // Cap dłuższego boku (wyjście x4 = do 6144 px, aż nadto). Bez tego upscale realnych zdjęć padał.
  return postImage('/api/v1/upscale', uri, {}, AI_MAX_DIM);
}

export type PromptBoostResult = { prompt: string };

/**
 * Prompt booster — ulepsza prompt użytkownika PRZED edycją obrazu, żeby model lepiej wykonał zadanie
 * (doprecyzowanie, styl, zachowanie kompozycji). Wejście/wyjście: sam tekst (bez obrazu).
 * STUB: zwraca prompt bez zmian po krótkim opóźnieniu. Realnie: proxy → LLM (deAPI/OpenRouter) przepisuje.
 */
export async function boostPrompt({ prompt }: { prompt: string }): Promise<PromptBoostResult> {
  if (AI_STUB) {
    await sleep(900);
    return { prompt }; // STUB — echo; realnie backend zwróci przepisany prompt
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${BASE}/api/v1/prompt-boost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...appKeyHeader },
      body: JSON.stringify({ prompt }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ApiError(res.status, `prompt-boost failed (${res.status})`);
    const json: { prompt?: string } = await res.json();
    return { prompt: json.prompt || prompt }; // fallback: oryginał, gdy backend nic nie zwróci
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  } finally {
    clearTimeout(timeout);
  }
}

const TIMEOUT_MS = 90000; // generacja bywa wolna (~30 s) — hojny limit

/** Odrzuca po `ms`, jeśli `p` nie zdąży (upload trwa dalej natywnie, ale UI dostaje czytelny TIMEOUT). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError(0, 'TIMEOUT — generation took too long')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Wspólny parser odpowiedzi proxy (status + surowe body); kontrakt: 2xx { uri } albo { image_base64, mime }.
 * `image_base64` przychodzi z tras, gdzie proxy SAMO składa obraz (kompozycja z maską) — nie ma wtedy URL-a
 * deAPI do oddania. `mime` musi trafić do data-URI, bo od niego zależy rozszerzenie zapisywanego pliku.
 */
function parseResult(path: string, status: number, body: string): ImageEditResult {
  if (status < 200 || status >= 300) {
    // backend zwraca JSON { error }, ale bądźmy odporni na nie-JSON (np. HTML z proxy pośredniego)
    let msg = `${path} failed (${status})`;
    try { const j = JSON.parse(body); if (j?.error) msg = String(j.error); } catch {}
    throw new ApiError(status, msg);
  }
  let json: { uri?: string; image_base64?: string; mime?: string };
  try { json = JSON.parse(body); } catch { throw new ApiError(0, `${path}: malformed response`); }
  if (json.uri) return { uri: json.uri };
  if (json.image_base64) return { uri: `data:${json.mime || 'image/png'};base64,${json.image_base64}` };
  throw new ApiError(0, `${path}: empty response`);
}

/** Wspólne wysłanie obrazu (+pola tekstowe) do proxy; kontrakt: 2xx { uri } albo { image_base64, mime }. */
async function postImage(
  path: string,
  uri: string,
  fields: Record<string, string> = {},
  maxDim?: number, // cap dłuższego boku (px) — modele deAPI mają limit rozdzielczości wejścia
): Promise<ImageEditResult> {
  // zdalny wynik (https/data) najpierw sprowadzamy do lokalnego pliku (inaczej łańcuchowa edycja wysyłałaby
  // pusty obraz), a potem WYPALAMY orientację EXIF w piksele (+ ewentualny cap rozdzielczości) — backend
  // ignoruje EXIF, więc bez tego zwraca obrócony/odwrócony wynik (np. remove-background).
  const localUri = await bakeOrientation(await ensureLocalFile(uri), maxDim);
  const url = `${BASE}${path}`;

  // WEB: brak natywnego uploadAsync — użyj fetch+FormData (web to tylko podgląd UI, nie ścieżka produkcyjna AI).
  if (Platform.OS === 'web') return postImageWeb(url, path, localUri, fields);

  // NATYWNIE: FileSystem.uploadAsync streamuje plik multipart NATYWNIE (Android/iOS), z pominięciem
  // globalnego fetch. KLUCZOWE: w Expo SDK 56 globalny `fetch` = winter-fetch, którego enkoder multipart
  // NIE obsługuje FormData part typu { uri, name, type } — rzuca „Unsupported FormDataPart implementation".
  // uploadAsync to omija i nie wymaga wczytywania obrazu do JS (bez base64 w pamięci). Maska jedzie
  // jako zwykłe pole tekstowe (`parameters`), bo jest wektorem, a nie plikiem.
  try {
    const res = await withTimeout(
      FileSystem.uploadAsync(url, localUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'image',
        mimeType: 'image/png',
        parameters: fields,
        headers: { ...appKeyHeader },
      }),
      TIMEOUT_MS,
    );
    return parseResult(path, res.status, res.body);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  }
}

/** Ścieżka web (podgląd UI): standardowy fetch+FormData — przeglądarkowy fetch obsługuje part { uri }. */
async function postImageWeb(
  url: string,
  path: string,
  localUri: string,
  fields: Record<string, string>,
): Promise<ImageEditResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('image', { uri: localUri, name: 'image.png', type: 'image/png' } as any);
  try {
    const res = await withTimeout(
      fetch(url, { method: 'POST', headers: { ...appKeyHeader }, body: form }),
      TIMEOUT_MS,
    );
    return parseResult(path, res.status, await res.text());
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  }
}
