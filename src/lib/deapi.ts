/**
 * Klient edycji obrazu AI (deAPI / model z-image). Wzorzec z rec_ai: klucz API trzyma cienki BACKEND-PROXY,
 * nigdy bundle apki — apka woła proxy, proxy forwarduje do deAPI. Baza z `EXPO_PUBLIC_API_URL`.
 *
 * STAN: STUB. Dopóki `EXPO_PUBLIC_API_URL` nie jest ustawione, `editImage` zwraca wejściowy obraz po
 * krótkim opóźnieniu (echo) — pełny przepływ UI działa bez backendu. Po postawieniu proxy wystarczy
 * ustawić env; realna ścieżka (multipart image+prompt → { uri }) jest już poniżej.
 */
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

/**
 * Magic Erase — usuwa zaznaczony (namalowany palcem) obszar i domalowuje tło (inpaint).
 * `uri` = obraz, `mask` = URI maski (biała = do usunięcia) — na razie opcjonalny (STUB nie potrzebuje maski).
 * STUB: echo wejścia. Realnie: proxy → deAPI (inpaint z maską).
 */
export async function eraseImage({ uri, mask }: { uri: string; mask?: string }): Promise<ImageEditResult> {
  if (AI_STUB) {
    await sleep(1400);
    return { uri };
  }
  const fields: Record<string, string> = {};
  return postImage('/api/v1/image-erase', uri, fields, mask ? { mask } : undefined);
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
  return postImage('/api/v1/remove-background', uri);
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

/** Wspólne wysłanie obrazu (+pola, +opcjonalna maska) do proxy; kontrakt: 200 { uri?; image_base64? }. */
async function postImage(path: string, uri: string, fields: Record<string, string> = {}, extraImages?: Record<string, string>): Promise<ImageEditResult> {
  // Android otwiera part FormData tylko dla file/content/asset — zdalny wynik (https/data) najpierw
  // sprowadzamy do lokalnego pliku, inaczej łańcuchowa edycja wysyłałaby pusty obraz.
  const localUri = await ensureLocalFile(uri);
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('image', { uri: localUri, name: 'image.png', type: 'image/png' } as any);
  for (const [k, v] of Object.entries(extraImages ?? {})) form.append(k, { uri: v, name: `${k}.png`, type: 'image/png' } as any);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 90000); // generacja bywa wolna (~30 s) — hojny limit
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...appKeyHeader }, body: form, signal: ctrl.signal });
    if (!res.ok) {
      // backend zwraca JSON { error }, ale bądźmy odporni na nie-JSON (np. HTML z proxy pośredniego)
      let msg = `${path} failed (${res.status})`;
      try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch {}
      throw new ApiError(res.status, msg);
    }
    const json: { uri?: string; image_base64?: string } = await res.json();
    if (json.uri) return { uri: json.uri };
    if (json.image_base64) return { uri: `data:image/png;base64,${json.image_base64}` };
    throw new ApiError(0, `${path}: empty response`);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // AbortController po timeoucie rzuca AbortError („Aborted") — pokaż to jako czytelny TIMEOUT
    if (e instanceof Error && e.name === 'AbortError') throw new ApiError(0, 'TIMEOUT — generation took too long');
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  } finally {
    clearTimeout(timeout);
  }
}
