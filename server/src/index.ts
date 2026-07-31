/**
 * gallery-ai-proxy — cienki backend-proxy między apką a deAPI (natywny REST v2, api.deapi.ai).
 *
 * PO CO: klucz deAPI NIGDY nie trafia do bundla apki. Apka woła ten proxy (multipart: obraz+prompt),
 * proxy dokłada klucz + model i forwarduje do deAPI v2, czeka na wynik i zwraca URL.
 *
 * MODEL WYKONANIA: deAPI v2 jest ASYNCHRONICZNE — submit zwraca `request_id`, wynik odbieramy przez
 * WEBHOOK (szybko) z FALLBACKIEM na polling `GET /api/v2/jobs/{id}` (pewność, gdyby webhook nie dotarł).
 * Apka dostaje odpowiedź SYNCHRONICZNIE (trzymamy połączenie do czasu wyniku) — dzięki temu apka nie
 * wymaga przebudowy: kontrakt HTTP proxy się nie zmienia.
 *
 * KONTRAKT (zgodny z src/lib/deapi.ts w apce):
 *   POST /api/v1/image-edits        multipart { image, prompt, mask_paths? } → 200 { uri } | { image_base64, mime }
 *   POST /api/v1/image-fills        multipart { image }                      → 200 { uri } | { image_base64, mime }
 *   POST /api/v1/remove-background  multipart { image }                      → 200 { uri }   (dedykowany model, np. Ben2)
 *   POST /api/v1/image-erase        multipart { image, mask_paths? }         → 200 { uri } | { image_base64, mime }
 *   POST /api/v1/prompt-boost       json { prompt }                          → 200 { prompt }
 *   Nagłówek X-App-Key (opcjonalny współdzielony sekret) — chroni przed zassaniem kredytów.
 *   POST /webhooks/deapi — odbiornik callbacków deAPI (POZA /api; autoryzacja podpisem HMAC, nie X-App-Key).
 *
 * MASKA (inpainting): deAPI NIE MA maskowanego inpaintingu — docs `images/edits` mówią wprost „Inpainting
 * (`mask` parameter) is not supported", więc model regeneruje CAŁY obraz i edycja rozlewała się daleko poza
 * zaznaczenie. Rozwiązanie: apka wysyła maskę WEKTOROWO (`mask_paths`, patrz [[mask.ts]]), proxy kadruje
 * wycinek wokół zaznaczenia, puszcza na nim edycję i SKŁADA wynik z oryginałem przez rozmytą maskę
 * ([[compose.ts]]). Piksele poza zaznaczeniem zostają nietknięte. Odpowiedź jest wtedy obrazem
 * (`image_base64` + `mime`), bo proxy oddaje własną kompozycję, a nie URL od deAPI.
 * BEZ `mask_paths` trasy zachowują się jak dawniej ({ uri }) — starsze, już wydane wersje apki działają dalej.
 *
 * AUTH deAPI: REST v2 (api.deapi.ai) NIE akceptuje prefiksu `dpn-sk-`. OpenAI-compat go wymaga — dlatego
 * DEAPI_API_KEY trzymamy Z prefiksem (kompatybilnie), a tutaj go ODCINAMY na potrzeby v2.
 *
 * WSZYSTKIE PROMPTY WYSYŁANE DO deAPI SĄ PO ANGIELSKU (modele działają najlepiej na EN).
 */
import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import { parseMaskPaths, rasterizeMask, maskBBox, expandRoi, coversWholeImage, type Roi, type MaskPaths } from './mask.js';
import { BadRequest, ProxyError } from './errors.js';
import {
  readImage, maskFromAlpha, softenMask, cropRegion, prefillHoles, upscaleForModel, compositeThroughMask, passthroughJpeg,
  type Composed, type ImageFacts,
} from './compose.js';

const {
  DEAPI_API_KEY,
  DEAPI_V2_BASE_URL = 'https://api.deapi.ai',
  DEAPI_MODEL = 'Flux_2_Klein_4B_BF16', // model edycji (img2img). Alternatywa: QwenImageEdit_Plus_NF4
  DEAPI_STEPS = '4', //                    Flux.2 Klein = distilled, 4 kroki wystarczą
  DEAPI_BG_MODEL = 'Ben2', //              dedykowany model usuwania tła (alternatywa: RMBG-1.4)
  DEAPI_UPSCALE_MODEL = 'RealESRGAN_x4', // dedykowany model upscalu (x4)
  DEAPI_WEBHOOK_SECRET, //                 sekret HMAC do weryfikacji callbacków deAPI (min. 32 znaki)
  PUBLIC_URL, //                           publiczny URL proxy (do webhook_url). Domyślnie z RAILWAY_PUBLIC_DOMAIN
  RAILWAY_PUBLIC_DOMAIN,
  APP_KEY, //                              współdzielony sekret apka↔proxy (jeśli pusty → brak kontroli, tylko DEV)
  ALLOWED_ORIGINS, //                      CORS: lista originów po przecinku (domyślnie porty Expo web)
  PORT = '8787',
} = process.env;

// --- walidacja konfiguracji na starcie (fail fast) ---
if (!DEAPI_API_KEY) {
  console.error('FATAL: brak DEAPI_API_KEY — ustaw go w server/.env (patrz .env.example)');
  process.exit(1);
}
const EDIT_STEPS = Number(DEAPI_STEPS);
if (!Number.isFinite(EDIT_STEPS) || EDIT_STEPS <= 0) {
  console.error(`FATAL: DEAPI_STEPS musi być dodatnią liczbą (jest: "${DEAPI_STEPS}")`);
  process.exit(1);
}

const V2_BASE = DEAPI_V2_BASE_URL.replace(/\/+$/, '');
const V2_KEY = DEAPI_API_KEY.replace(/^dpn-sk-/i, ''); // REST v2 nie akceptuje prefiksu dpn-sk-
const V2_AUTH = { Authorization: `Bearer ${V2_KEY}` };

// Publiczny URL proxy → webhook_url. Railway wstrzykuje RAILWAY_PUBLIC_DOMAIN automatycznie.
const PUB_URL = (PUBLIC_URL || (RAILWAY_PUBLIC_DOMAIN ? `https://${RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '');
const WEBHOOKS_ON = Boolean(PUB_URL && DEAPI_WEBHOOK_SECRET); // bez publicznego URL (np. lokalnie) → sam polling

const POLL_INTERVAL_MS = 2500;
// Budżet apki na całe żądanie = 90 s. Rozdział: generacja ≤ 60 s + pobranie wyniku ≤ 20 s + kompozycja (~1 s),
// czyli w najgorszym razie ~81 s — mieści się z zapasem. Wcześniej sama generacja miała 75 s, ale wtedy nic
// nie działo się po niej; teraz proxy musi jeszcze ściągnąć wynik i go złożyć.
const OVERALL_TIMEOUT_MS = 60_000;    // całkowity budżet na submit + czekanie na wynik deAPI
const SUBMIT_TIMEOUT_MS = 30_000;     // górny limit na sam submit (upload obrazu do deAPI v2)
const POLL_FETCH_TIMEOUT_MS = 10_000; // pojedynczy GET /jobs — krótki, żeby zawieszony poll nie blokował pętli deadline
const RESULT_FETCH_TIMEOUT_MS = 20_000; // pobranie gotowego obrazu z deAPI (potrzebne tylko przy kompozycji)
const MAX_RESULT_BYTES = 40 * 1024 * 1024; // sanity na pobierany wynik (obraz, nie film)

// sharp: bez cache'a i na jednym wątku — kontener Railway ma mało RAM/rdzeni, a obrazy są małe (≤1536 px),
// więc pula wątków libvips dawała tylko narzut i skoki pamięci.
sharp.cache(false);
sharp.concurrency(1);

const app = express();
app.disable('x-powered-by');
app.use(helmet());

const origins = (ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:19006')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK: odbiornik callbacków deAPI. MUSI być przed guardem /api (deAPI nie wysyła X-App-Key) i używać
// RAW body (podpis liczony z surowego JSON-a). Autoryzacja = HMAC-SHA256(secret, timestamp + "." + raw).
// ─────────────────────────────────────────────────────────────────────────────
type Pending = { resolve: (url: string) => void; reject: (e: Error) => void };
const pending = new Map<string, Pending>(); // request_id → oczekujące żądanie apki (rozwiązywane przez webhook)

app.post('/webhooks/deapi', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (!DEAPI_WEBHOOK_SECRET) return res.status(503).json({ error: 'webhooks disabled' });
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
  const sig = req.header('X-DeAPI-Signature') ?? '';
  const ts = req.header('X-DeAPI-Timestamp') ?? '';

  // replay-protection: odrzuć starsze niż 5 min. Tolerujemy sekundy LUB milisekundy (deAPI mógłby wysłać ms).
  let tsSec = Number(ts);
  if (Number.isFinite(tsSec) && tsSec > 1e12) tsSec = tsSec / 1000;
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
    console.warn('[webhook] odrzucony: zły/nieaktualny timestamp');
    return res.status(400).json({ error: 'stale or bad timestamp' });
  }
  // weryfikacja podpisu (stałoczasowa), liczona na SUROWYCH bajtach: HMAC(secret, ts + "." + raw_body)
  const mac = createHmac('sha256', DEAPI_WEBHOOK_SECRET).update(Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), raw])).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(`sha256=${mac}`);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn('[webhook] odrzucony: zły podpis');
    return res.status(401).json({ error: 'bad signature' });
  }

  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
  const event = String(payload?.event ?? req.header('X-DeAPI-Event') ?? '');
  const data = payload?.data ?? {};
  const id = String(data?.job_request_id ?? '');
  const waiter = id && pending.get(id);
  if (waiter) {
    if (event === 'job.completed' && data?.result_url) { pending.delete(id); waiter.resolve(String(data.result_url)); }
    else if (event === 'job.failed') { pending.delete(id); waiter.reject(new Error(String(data?.error_message ?? 'deAPI job failed'))); }
    // job.processing → nic nie robimy (czekamy dalej)
  }
  res.status(200).json({ ok: true }); // szybkie 200 — deAPI nie ponawia
});

// Współdzielony sekret: jeśli APP_KEY ustawiony, każdy /api/* musi podać zgodny X-App-Key (stałoczasowo).
app.use('/api', (req, res, next) => {
  if (!APP_KEY) return next();
  const supplied = Buffer.from(req.header('X-App-Key') ?? '');
  const expected = Buffer.from(APP_KEY);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ error: 'unauthorized (bad or missing X-App-Key)' });
  }
  next();
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, editModel: DEAPI_MODEL, bgModel: DEAPI_BG_MODEL, upscaleModel: DEAPI_UPSCALE_MODEL, steps: EDIT_STEPS, webhooks: WEBHOOKS_ON, masking: true }));

// ─────────────────────────────────────────────────────────────────────────────
// deAPI v2 — submit + oczekiwanie na wynik (webhook lub polling)
// ─────────────────────────────────────────────────────────────────────────────

/** Wysyła job do deAPI v2 (multipart: obraz + pola). Zwraca `request_id`. Fetch ograniczony do budżetu (abort). */
async function submitJob(kind: string, image: Buffer, fields: Record<string, string>, deadline: number): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([image as unknown as BlobPart], { type: 'image/png' }), 'image.png');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (WEBHOOKS_ON) {
    form.append('webhook_url', `${PUB_URL}/webhooks/deapi`);
    form.append('webhook_secret', DEAPI_WEBHOOK_SECRET!);
  }
  const budget = Math.max(1000, Math.min(SUBMIT_TIMEOUT_MS, deadline - Date.now()));
  let r: Response;
  try {
    r = await fetch(`${V2_BASE}/api/v2/images/${kind}`, { method: 'POST', headers: V2_AUTH, body: form, signal: AbortSignal.timeout(budget) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw Object.assign(new Error(`submit ${kind} timeout`), { status: 504 });
    throw e; // inny błąd sieci → 502
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw Object.assign(new Error(`submit ${kind} ${r.status}: ${body.slice(0, 300)}`), { status: r.status });
  }
  const j = (await r.json()) as { data?: { request_id?: string } };
  const id = j?.data?.request_id;
  if (!id) throw new Error(`submit ${kind}: brak request_id w odpowiedzi`);
  return id;
}

/** Odpytuje status joba (fetch z krótkim abortem). URL wyniku (done), null (nie gotowe/przejściowy błąd) lub rzuca (error). */
async function pollJob(id: string): Promise<string | null> {
  let r: Response;
  try {
    r = await fetch(`${V2_BASE}/api/v2/jobs/${id}`, { headers: V2_AUTH, signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS) });
  } catch {
    return null; // abort/błąd sieci — przejściowo; pętla i tak pilnuje deadline'u
  }
  if (!r.ok) return null;
  const d = ((await r.json().catch(() => ({}))) as { data?: any })?.data ?? {};
  if (d.status === 'done' && d.result_url) return String(d.result_url);
  if (d.status === 'error') throw Object.assign(new Error(String(d.error_message ?? 'deAPI job error')), { status: 502 });
  return null;
}

/** Czeka na wynik joba: webhook (szybko) LUB polling (fallback), do `deadline`. Zwraca URL wyniku. */
async function awaitResult(id: string, deadline: number): Promise<string> {
  let onDone!: (u: string) => void;
  let onFail!: (e: Error) => void;
  const viaWebhook = new Promise<string>((resolve, reject) => { onDone = resolve; onFail = reject; });
  if (WEBHOOKS_ON) pending.set(id, { resolve: onDone, reject: onFail });
  try {
    while (Date.now() < deadline) {
      // wyścig: webhook vs upływ interwału pollingu
      const tick = new Promise<null>((r) => setTimeout(() => r(null), POLL_INTERVAL_MS));
      const winner = await Promise.race([viaWebhook, tick]); // string=webhook done | null=tick | throw=webhook fail
      if (typeof winner === 'string') return winner;
      const polled = await pollJob(id); // rzuci przy status=error
      if (polled) return polled;
    }
    throw Object.assign(new Error('TIMEOUT — generation took too long'), { status: 504 });
  } finally {
    pending.delete(id);
  }
}

/** submit + oczekiwanie na wynik pod JEDNYM budżetem czasu (obejmuje upload legs + czekanie). Zwraca URL wyniku. */
async function runJob(kind: string, image: Buffer, fields: Record<string, string>): Promise<string> {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const id = await submitJob(kind, image, fields, deadline);
  return awaitResult(id, deadline);
}

/** Skrót: edycja img2img promptem. deAPI v2 `edits` wymaga `seed` — losujemy per żądanie (różnorodność wyników). */
function runEdit(image: Buffer, prompt: string): Promise<string> {
  const seed = String(Math.floor(Math.random() * 1_000_000_000));
  return runJob('edits', image, { prompt, model: DEAPI_MODEL, steps: String(EDIT_STEPS), seed });
}

// ─────────────────────────────────────────────────────────────────────────────
// KOMPOZYCJA Z MASKĄ — lokalizuje edycję do zaznaczonego obszaru (patrz nagłówek pliku)
// ─────────────────────────────────────────────────────────────────────────────

/** Model generuje wyraźnie lepiej, gdy wycinek nie jest miniaturką — mały ROI podbijamy przed wysyłką. */
const MODEL_TARGET_SIDE = 768;

/** Rozmycie szwu, skalowane do wielkości zaznaczenia: małe zaznaczenie = wąskie przejście, duże = szersze. */
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const paintedFeather = (bbox: Roi) => clamp(0.05 * Math.min(bbox.width, bbox.height), 2, 16);
const alphaFeather = (facts: ImageFacts) => clamp(0.004 * Math.min(facts.width, facts.height), 2, 8);

/** Pobiera gotowy obraz z deAPI (podpisany URL). Potrzebne tylko przy kompozycji — inaczej URL leci do apki. */
async function downloadResult(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS) });
  if (!r.ok) throw Object.assign(new Error(`pobranie wyniku ${r.status}`), { status: 502 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_RESULT_BYTES) throw Object.assign(new Error('wynik deAPI za duży'), { status: 502 });
  return buf;
}

/**
 * Pełna ścieżka „edycja tylko w masce": wycinek wokół zaznaczenia → edycja w deAPI → wklejenie wyniku
 * w oryginał przez rozmytą maskę.
 *
 * Dlaczego ROI (kadr wokół zaznaczenia), a nie całe zdjęcie: model dostaje wtedy więcej pikseli na
 * istotnym fragmencie, a jego naturalne „rozlewanie się" i tak nie ma gdzie wyjść poza wycinek.
 *
 * Zmiękczona maska MUSI mieścić się w wycinku, inaczej gradient szwu urwałby się na krawędzi ROI
 * i zostałby widoczny prostokąt. Zasięg zmiękczenia to ≈5.2·σ (dilate + feather), a margines ROI to
 * max(48 px, 0.35·dłuższy bok). Przy σ = 0.05·krótszy bok (przycięte do 2…16) zasięg ≤ 0.26·krótszy
 * bok < margines — w obie strony, także po przycięciu σ. Pilnuje tego selftest („zmiękczona maska ⊂ ROI").
 */
async function maskedEdit(
  image: Buffer, facts: ImageFacts, mask: Buffer, prompt: string, sigma: number,
  prepare?: (crop: Buffer, roi: Roi) => Promise<Buffer>, // np. zalepienie dziur przed wysyłką (FILL)
): Promise<Composed> {
  const bbox = maskBBox(mask, facts.width, facts.height);
  if (!bbox) throw new BadRequest('empty selection — nothing to edit');

  const full: Roi = { left: 0, top: 0, width: facts.width, height: facts.height };
  const expanded = expandRoi(bbox, facts.width, facts.height);
  const roi = coversWholeImage(expanded, facts.width, facts.height) ? full : expanded;

  const soft = await softenMask(mask, facts.width, facts.height, sigma);
  const crop = await cropRegion(image, roi);
  const ready = prepare ? await prepare(crop, roi) : crop;
  const edited = await downloadResult(await runEdit(await upscaleForModel(ready, roi, MODEL_TARGET_SIDE), prompt));
  return compositeThroughMask(image, edited, soft, facts, roi);
}

/**
 * Odróżnia „apka NIE przysłała maski" (starsze wydanie → dawne zachowanie) od „przysłała, ale zepsutą".
 * To drugie musi być głośnym 400: ciche potraktowanie go jak braku maski oznaczałoby powrót do edycji
 * CAŁEGO obrazu, czyli dokładnie do buga, który maska naprawia — tylko że niewidocznie.
 */
function readMask(raw: unknown): MaskPaths | null {
  const parsed = parseMaskPaths(raw);
  if (!parsed && typeof raw === 'string' && raw.trim()) throw new BadRequest('malformed "mask_paths"');
  return parsed;
}

/** Wariant dla maski malowanej palcem (JSON z apki): rasteryzacja → [[maskedEdit]]. */
async function maskedEditFromPaths(image: Buffer, paths: NonNullable<ReturnType<typeof parseMaskPaths>>, prompt: string): Promise<Composed> {
  const facts = await readImage(image);
  const mask = rasterizeMask(paths, facts.width, facts.height);
  const bbox = maskBBox(mask, facts.width, facts.height);
  if (!bbox) throw new BadRequest('empty selection — nothing to edit');
  return maskedEdit(image, facts, mask, prompt, paintedFeather(bbox));
}

/** Odpowiedź apce: gotowy obraz (kompozycja proxy) zamiast URL-a deAPI. */
const imageBody = (c: Composed) => ({ image_base64: c.buffer.toString('base64'), mime: c.mime });

/** Błąd wywołania deAPI → apce oddajemy 502 (lub 504 timeout) z ogólnym komunikatem; detal tylko do logów. */
function sendUpstreamError(res: express.Response, e: unknown, where: string) {
  const err = e as { status?: number; message?: string };
  const status = err?.status;
  console.error(`[${where}] upstream ${status ?? '?'}:`, err?.message ?? e);

  // Wina ŻĄDANIA (puste/za ciężkie zaznaczenie, nieczytelny lub za duży obraz) — komunikat jest nasz
  // i bezpieczny do pokazania; ponawianie nic nie da, więc NIE udawaj przejściowej awarii deAPI.
  if (e instanceof BadRequest) return res.status(400).json({ error: e.message });
  // Naruszona asercja wewnętrzna proxy — też nie jest winą deAPI. Szczegóły zostają w logu (wyżej).
  if (e instanceof ProxyError) return res.status(500).json({ error: 'image processing failed' });

  // 422 = deAPI ODRZUCIŁO wejście (najczęściej rozdzielczość poza limitem modelu, np. bok < 256 lub skrajne
  // proporcje panoramy). Błąd NIEPRZEJŚCIOWY — ponawianie nic nie da. Nie maskujemy go jako 502 „upstream
  // failed" (co sugeruje przejściowy problem serwera); przekazujemy 422 z komunikatem, który apka pokaże
  // użytkownikowi (EditorScreen renderuje `ERROR: <message>`), żeby wiedział, że to kwestia samego zdjęcia.
  if (status === 422) {
    return res.status(422).json({ error: 'AI could not process this photo (unsupported dimensions) — try a different one' });
  }
  const code = status === 504 ? 504 : 502;
  res.status(code).json({ error: code === 504 ? `${where} timed out` : `${where} failed (upstream)` });
}

// EDYCJA PROMPTEM — obraz + instrukcja użytkownika (EN). Z `mask_paths` = INPAINTING (zmiana tylko
// w zamalowanym obszarze); bez maski = edycja całego obrazu (i tak zachowanie starszych wydań apki).
// Sufiks o kompozycji pomaga modelowi trzymać kadr wycinka, żeby szew z oryginałem był niewidoczny.
const inpaintPrompt = (p: string) => `${p}. Keep the framing, lighting, colour and perspective of the photo unchanged.`;

app.post('/api/v1/image-edits', upload.single('image'), async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  if (!prompt) return res.status(400).json({ error: 'missing "prompt" field' });
  try {
    const paths = readMask(req.body?.mask_paths);
    if (!paths) return res.json({ uri: await runEdit(req.file.buffer, prompt) });
    res.json(imageBody(await maskedEditFromPaths(req.file.buffer, paths, inpaintPrompt(prompt))));
  } catch (e) {
    sendUpstreamError(res, e, 'image-edits');
  }
});

// GENERATIVE FILL — wypełnia puste/przezroczyste obszary (np. rogi po obrocie kadru). Maski nie musi
// przysyłać apka: obszarem do domalowania są DOKŁADNIE piksele przezroczyste, więc czytamy ją z alfy.
// Kompozycja przez tę maskę pilnuje, żeby model przemalował rogi, a nie całe zdjęcie.
//
// ⚠️ WYMAGA JAWNEJ ZGODY KLIENTA (`mask_from_alpha=1`). Ta trasa nie ma pola `mask_paths`, po którym
// dałoby się poznać nową apkę, a WYDANE wydanie (v0.9625) ignoruje `mime` w odpowiedzi i zapisuje bajty
// JPEG-a do pliku `.png` (MediaStore dostaje wtedy zły typ przy zapisie do galerii). Bez flagi zostaje
// więc dawne zachowanie: edycja całości i `{ uri }`.
//
// Prompt opisuje to, CO MODEL REALNIE WIDZI: nie przezroczystość (deAPI spłaszcza ją do czerni), tylko
// nasze wstępne zalepienie — rozmytą, rozciągniętą smugę przy krawędzi, którą ma domalować „na ostro".
const FILL_PROMPT =
  'The blurred, smeared area near the border is a rough placeholder. Repaint it so it seamlessly continues the ' +
  'surrounding photo with matching detail, texture, colour, lighting and perspective. ' +
  'Keep the original subject and composition untouched.';

// Wersja dla starszych apek: model dostaje obraz z (spłaszczoną do czerni) dziurą, bez zalepiania.
const FILL_PROMPT_LEGACY =
  'Seamlessly fill the empty or transparent border areas by naturally extending the surrounding photo content. ' +
  'Keep the original subject and composition untouched. Match lighting, texture, color and perspective for a coherent result.';

app.post('/api/v1/image-fills', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  const image = req.file.buffer;
  const wantsAlphaMask = String(req.body?.mask_from_alpha ?? '') === '1';
  try {
    if (!wantsAlphaMask) return res.json({ uri: await runEdit(image, FILL_PROMPT_LEGACY) });
    const facts = await readImage(image);
    // brak alfy → nie ma czego maskować (obraz bez dziur)
    if (!facts.hasAlpha) return res.json({ uri: await runEdit(image, FILL_PROMPT_LEGACY) });
    const mask = await maskFromAlpha(image, facts.width, facts.height);
    // alfa jest, ale w pełni kryjąca → nie ma dziur do wypełnienia. Oddaj obraz bez zmian: edycja całości
    // przemalowałaby zdjęcie bez powodu (i za kredyty), a to jest dokładnie ten bug, który tu naprawiamy.
    if (!maskBBox(mask, facts.width, facts.height)) return res.json(imageBody(await passthroughJpeg(image)));
    const sigma = alphaFeather(facts);
    const composed = await maskedEdit(image, facts, mask, FILL_PROMPT, sigma, (crop, roi) => prefillHoles(crop, roi.width, roi.height, sigma));
    res.json(imageBody(composed));
  } catch (e) {
    sendUpstreamError(res, e, 'image-fills');
  }
});

// REMOVE BACKGROUND — DEDYKOWANY model deAPI v2 (Ben2/RMBG). Zwraca wynik z usuniętym tłem (przezroczystość).
app.post('/api/v1/remove-background', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    res.json({ uri: await runJob('background-removals', req.file.buffer, { model: DEAPI_BG_MODEL }) });
  } catch (e) {
    sendUpstreamError(res, e, 'remove-background');
  }
});

// UPSCALE — powiększa/wyostrza obraz DEDYKOWANYM modelem deAPI v2 (RealESRGAN x4).
app.post('/api/v1/upscale', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    res.json({ uri: await runJob('upscales', req.file.buffer, { model: DEAPI_UPSCALE_MODEL }) });
  } catch (e) {
    sendUpstreamError(res, e, 'upscale');
  }
});

// MAGIC ERASE — usuwa zamalowany obiekt i domalowuje tło. Z `mask_paths` edycja jest zawężona do
// zaznaczenia (kadr wokół niego + kompozycja); bez maski leci dawna, ogólna wersja — tak działają
// wydania apki sprzed maski i nie chcemy im psuć funkcji.
const ERASE_PROMPT =
  'Remove the main unwanted object, person or distracting element in this crop and seamlessly fill the area by ' +
  'naturally extending the surrounding background. Keep the rest of the photo untouched, matching lighting, texture and perspective.';

app.post('/api/v1/image-erase', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    const paths = readMask(req.body?.mask_paths);
    if (!paths) return res.json({ uri: await runEdit(req.file.buffer, ERASE_PROMPT) });
    res.json(imageBody(await maskedEditFromPaths(req.file.buffer, paths, ERASE_PROMPT)));
  } catch (e) {
    sendUpstreamError(res, e, 'image-erase');
  }
});

// PROMPT BOOSTER — passthrough (zwraca prompt bez zmian). Dedykowany enhancer v2 (prompts/enhancements) pod
// generację ZMYŚLA całe sceny (nieodpowiednie dla EDYCJI istniejącego zdjęcia), a wariant pod edycję wymaga
// obrazu, którego apka przy boost nie wysyła. Apka i tak ma fallback do oryginału — echo jest bezpieczne.
app.post('/api/v1/prompt-boost', express.json(), (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ error: 'missing "prompt" field' });
  res.json({ prompt });
});

// 404 w formacie JSON (apka nigdy nie dostaje HTML-a Expressa)
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// Terminal error-handler: błędy multera (za duży plik, zły part) omijają try/catch tras — łapiemy je tu jako JSON.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(code).json({ error: err.message });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(Number(PORT), () => {
  console.log(`gallery-ai-proxy → :${PORT}  (deAPI v2 ${V2_BASE}, edit ${DEAPI_MODEL}, bg ${DEAPI_BG_MODEL}, webhooks ${WEBHOOKS_ON ? 'ON' : 'OFF (polling)'})`);
  if (!APP_KEY) console.warn('UWAGA: APP_KEY pusty — endpointy /api/* są otwarte. OK na DEV, ustaw przed deployem.');
  if (!WEBHOOKS_ON) console.warn('INFO: webhooks OFF (brak PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN lub DEAPI_WEBHOOK_SECRET) — używam pollingu.');
});

// Graceful shutdown: Railway wysyła SIGTERM przy każdym redeployu — domknij trwające żądania zamiast ubijać.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig} — zamykam serwer…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });
