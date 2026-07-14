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
import { ensureLocalFile } from './localFile';

const BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');
const APP_KEY = process.env.EXPO_PUBLIC_APP_KEY;
const appKeyHeader: Record<string, string> = APP_KEY ? { 'X-App-Key': APP_KEY } : {};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type ImageEditResult = { uri: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Czy edycja AI woła realny backend (env ustawione), czy działa na stubie. */
export const AI_STUB = !BASE;

/**
 * Edytuje obraz promptem. `uri` = lokalny URI zdjęcia (asset/plik), `prompt` = instrukcja edycji.
 * Zwraca URI wyniku (do wyświetlenia w <Image>). Rzuca `ApiError` przy błędzie backendu.
 */
export async function editImage({ uri, prompt }: { uri: string; prompt: string }): Promise<ImageEditResult> {
  if (AI_STUB) {
    // STUB — echo wejściowego obrazu (podmień na realny wynik po podłączeniu proxy deAPI/z-image)
    await sleep(1400);
    return { uri };
  }

  // REALNY proxy: multipart (obraz + prompt) → backend forwarduje do deAPI i zwraca wynik.
  // Model wybiera backend (np. z-image albo Qwen Edit Plus — oba dostępne w deAPI).
  return postImage('/api/v1/image-edits', uri, { prompt });
}

/**
 * Generative fill — wypełnia PRZEZROCZYSTE/puste obszary obrazu (np. czarne rogi po kadrze z obrotem).
 * `uri` = obraz PNG, w którym obszary do domalowania są przezroczyste (kanał alfa = maska inpaintingu).
 * STUB: zwraca wejściowy obraz. Realnie: proxy → deAPI (z-image inpaint/outpaint).
 */
export async function fillImage({ uri }: { uri: string }): Promise<ImageEditResult> {
  if (AI_STUB) {
    await sleep(1400);
    return { uri };
  }
  return postImage('/api/v1/image-fills', uri);
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

/** Wspólny parser odpowiedzi proxy (status + surowe body); kontrakt: 2xx { uri?; image_base64? }. */
function parseResult(path: string, status: number, body: string): ImageEditResult {
  if (status < 200 || status >= 300) {
    // backend zwraca JSON { error }, ale bądźmy odporni na nie-JSON (np. HTML z proxy pośredniego)
    let msg = `${path} failed (${status})`;
    try { const j = JSON.parse(body); if (j?.error) msg = String(j.error); } catch {}
    throw new ApiError(status, msg);
  }
  let json: { uri?: string; image_base64?: string };
  try { json = JSON.parse(body); } catch { throw new ApiError(0, `${path}: malformed response`); }
  if (json.uri) return { uri: json.uri };
  if (json.image_base64) return { uri: `data:image/png;base64,${json.image_base64}` };
  throw new ApiError(0, `${path}: empty response`);
}

/** Wspólne wysłanie obrazu (+pola) do proxy; kontrakt odpowiedzi: 2xx { uri?; image_base64? }. */
async function postImage(path: string, uri: string, fields: Record<string, string> = {}): Promise<ImageEditResult> {
  // Android otwiera plik tylko dla file/content/asset — zdalny wynik (https/data) najpierw
  // sprowadzamy do lokalnego pliku, inaczej łańcuchowa edycja wysyłałaby pusty obraz.
  const localUri = await ensureLocalFile(uri);
  const url = `${BASE}${path}`;

  // WEB: brak natywnego uploadAsync — użyj fetch+FormData (web to tylko podgląd UI, nie ścieżka produkcyjna AI).
  if (Platform.OS === 'web') return postImageWeb(url, path, localUri, fields);

  // NATYWNIE: FileSystem.uploadAsync streamuje plik jako multipart NATYWNIE (Android/iOS), z pominięciem
  // globalnego fetch. KLUCZOWE: w Expo SDK 56 globalny `fetch` = winter-fetch, którego enkoder multipart
  // NIE obsługuje FormData part typu { uri, name, type } — rzuca „Unsupported FormDataPart implementation".
  // uploadAsync omija ten problem i nie wymaga wczytywania obrazu do JS (bez base64 w pamięci).
  try {
    const res = await withTimeout(
      FileSystem.uploadAsync(url, localUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'image',
        mimeType: 'image/png',
        parameters: fields, // pozostałe pola (np. prompt) → pola tekstowe formularza multipart
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
async function postImageWeb(url: string, path: string, localUri: string, fields: Record<string, string>): Promise<ImageEditResult> {
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
