/**
 * Klient edycji obrazu AI (deAPI / model z-image). Wzorzec z rec_ai: klucz API trzyma cienki BACKEND-PROXY,
 * nigdy bundle apki — apka woła proxy, proxy forwarduje do deAPI. Baza z `EXPO_PUBLIC_API_URL`.
 *
 * STAN: STUB. Dopóki `EXPO_PUBLIC_API_URL` nie jest ustawione, `editImage` zwraca wejściowy obraz po
 * krótkim opóźnieniu (echo) — pełny przepływ UI działa bez backendu. Po postawieniu proxy wystarczy
 * ustawić env; realna ścieżka (multipart image+prompt → { uri }) jest już poniżej.
 */
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

  // REALNY proxy: multipart (obraz + prompt) → backend forwarduje do deAPI (z-image) i zwraca wynik.
  // Kontrakt (do ustalenia z backendem): 200 { uri?: string; image_base64?: string }.
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('image', { uri, name: 'image.png', type: 'image/png' } as any);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60000); // edycja bywa wolna — hojny limit
  try {
    const res = await fetch(`${BASE}/api/v1/image-edits`, {
      method: 'POST',
      headers: { ...appKeyHeader },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ApiError(res.status, `image-edit failed (${res.status})`);
    const json: { uri?: string; image_base64?: string } = await res.json();
    if (json.uri) return { uri: json.uri };
    if (json.image_base64) return { uri: `data:image/png;base64,${json.image_base64}` };
    throw new ApiError(0, 'image-edit: empty response');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  } finally {
    clearTimeout(timeout);
  }
}
