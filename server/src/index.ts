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
 *   POST /api/v1/image-edits        multipart { image, prompt }  → 200 { uri }
 *   POST /api/v1/image-fills        multipart { image }          → 200 { uri }
 *   POST /api/v1/remove-background  multipart { image }          → 200 { uri }   (dedykowany model, np. Ben2)
 *   POST /api/v1/image-erase        multipart { image }          → 200 { uri }
 *   POST /api/v1/prompt-boost       json { prompt }              → 200 { prompt }
 *   Nagłówek X-App-Key (opcjonalny współdzielony sekret) — chroni przed zassaniem kredytów.
 *   POST /webhooks/deapi — odbiornik callbacków deAPI (POZA /api; autoryzacja podpisem HMAC, nie X-App-Key).
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

const {
  DEAPI_API_KEY,
  DEAPI_V2_BASE_URL = 'https://api.deapi.ai',
  DEAPI_MODEL = 'Flux_2_Klein_4B_BF16', // model edycji (img2img). Alternatywa: QwenImageEdit_Plus_NF4
  DEAPI_STEPS = '4', //                    Flux.2 Klein = distilled, 4 kroki wystarczą
  DEAPI_BG_MODEL = 'Ben2', //              dedykowany model usuwania tła (alternatywa: RMBG-1.4)
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
const RESULT_TIMEOUT_MS = 85_000; // < 90 s timeoutu apki (uploadAsync) — chcemy oddać błąd zanim apka sама odetnie

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

  // replay-protection: odrzuć starsze niż 5 min
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return res.status(400).json({ error: 'stale or bad timestamp' });
  }
  // weryfikacja podpisu (stałoczasowa)
  const expected = 'sha256=' + createHmac('sha256', DEAPI_WEBHOOK_SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
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
  res.json({ ok: true, editModel: DEAPI_MODEL, bgModel: DEAPI_BG_MODEL, steps: EDIT_STEPS, webhooks: WEBHOOKS_ON }));

// ─────────────────────────────────────────────────────────────────────────────
// deAPI v2 — submit + oczekiwanie na wynik (webhook lub polling)
// ─────────────────────────────────────────────────────────────────────────────

/** Wysyła job do deAPI v2 (multipart: obraz + pola). Zwraca `request_id`. */
async function submitJob(kind: string, image: Buffer, fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([image as unknown as BlobPart], { type: 'image/png' }), 'image.png');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (WEBHOOKS_ON) {
    form.append('webhook_url', `${PUB_URL}/webhooks/deapi`);
    form.append('webhook_secret', DEAPI_WEBHOOK_SECRET!);
  }
  const r = await fetch(`${V2_BASE}/api/v2/images/${kind}`, { method: 'POST', headers: V2_AUTH, body: form });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw Object.assign(new Error(`submit ${kind} ${r.status}: ${body.slice(0, 300)}`), { status: r.status });
  }
  const j = (await r.json()) as { data?: { request_id?: string } };
  const id = j?.data?.request_id;
  if (!id) throw new Error(`submit ${kind}: brak request_id w odpowiedzi`);
  return id;
}

/** Odpytuje status joba. Zwraca URL wyniku (status=done), null (jeszcze nie gotowe) lub rzuca (status=error). */
async function pollJob(id: string): Promise<string | null> {
  const r = await fetch(`${V2_BASE}/api/v2/jobs/${id}`, { headers: V2_AUTH });
  if (!r.ok) return null; // przejściowy błąd odczytu — czekamy dalej (webhook może i tak dojść)
  const d = ((await r.json()) as { data?: any })?.data ?? {};
  if (d.status === 'done' && d.result_url) return String(d.result_url);
  if (d.status === 'error') throw Object.assign(new Error(String(d.error_message ?? 'deAPI job error')), { status: 502 });
  return null;
}

/** Czeka na wynik joba: webhook (szybko) LUB polling (fallback), do RESULT_TIMEOUT_MS. Zwraca URL wyniku. */
async function awaitResult(id: string): Promise<string> {
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
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

/** Skrót: edycja img2img promptem. deAPI v2 `edits` wymaga `seed` — losujemy per żądanie (różnorodność wyników). */
function runEdit(image: Buffer, prompt: string): Promise<string> {
  const seed = String(Math.floor(Math.random() * 1_000_000_000));
  return submitJob('edits', image, { prompt, model: DEAPI_MODEL, steps: String(EDIT_STEPS), seed }).then(awaitResult);
}

/** Błąd wywołania deAPI → apce oddajemy 502 (lub 504 timeout) z ogólnym komunikatem; detal tylko do logów. */
function sendUpstreamError(res: express.Response, e: unknown, where: string) {
  const err = e as { status?: number; message?: string };
  const code = err?.status === 504 ? 504 : 502;
  console.error(`[${where}] upstream ${err?.status ?? '?'}:`, err?.message ?? e);
  res.status(code).json({ error: code === 504 ? `${where} timed out` : `${where} failed (upstream)` });
}

// EDYCJA PROMPTEM — obraz + instrukcja użytkownika (EN).
app.post('/api/v1/image-edits', upload.single('image'), async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  if (!prompt) return res.status(400).json({ error: 'missing "prompt" field' });
  try {
    res.json({ uri: await runEdit(req.file.buffer, prompt) });
  } catch (e) {
    sendUpstreamError(res, e, 'image-edits');
  }
});

// GENERATIVE FILL — wypełnia puste/przezroczyste obszary (np. rogi po obrocie). deAPI nie ma maskowanego
// inpaintingu, więc używamy edycji z promptem opisującym domalowanie krawędzi.
const FILL_PROMPT =
  'Seamlessly fill the empty or transparent border areas by naturally extending the surrounding photo content. ' +
  'Keep the original subject and composition untouched. Match lighting, texture, color and perspective for a coherent result.';

app.post('/api/v1/image-fills', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    res.json({ uri: await runEdit(req.file.buffer, FILL_PROMPT) });
  } catch (e) {
    sendUpstreamError(res, e, 'image-fills');
  }
});

// REMOVE BACKGROUND — DEDYKOWANY model deAPI v2 (Ben2/RMBG). Zwraca wynik z usuniętym tłem (przezroczystość).
app.post('/api/v1/remove-background', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    const uri = await submitJob('background-removals', req.file.buffer, { model: DEAPI_BG_MODEL }).then(awaitResult);
    res.json({ uri });
  } catch (e) {
    sendUpstreamError(res, e, 'remove-background');
  }
});

// MAGIC ERASE — usuwa niechciane obiekty i naturalnie domalowuje tło. UWAGA: apka na razie NIE wysyła maski
// (obszaru zaznaczenia), więc erase jest ogólne. Gdy dojdzie maska, tu podłączymy inpaint z maską.
const ERASE_PROMPT =
  'Remove any unwanted foreground objects, people or distracting elements and seamlessly fill the area by ' +
  'naturally extending the surrounding background. Keep the rest of the photo untouched, matching lighting, texture and perspective.';

app.post('/api/v1/image-erase', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    res.json({ uri: await runEdit(req.file.buffer, ERASE_PROMPT) });
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
