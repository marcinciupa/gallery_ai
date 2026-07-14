/**
 * gallery-ai-proxy — cienki backend-proxy między apką a deAPI (OpenAI-compatible).
 *
 * PO CO: klucz deAPI NIGDY nie trafia do bundla apki. Apka woła ten proxy (multipart: obraz+prompt),
 * proxy dokłada klucz + parametry modelu i forwarduje do deAPI, po czym zwraca URL wyniku.
 *
 * KONTRAKT (zgodny z src/lib/deapi.ts w apce):
 *   POST /api/v1/image-edits   multipart { image, prompt }  → 200 { uri } | { image_base64 }
 *   POST /api/v1/image-fills   multipart { image }          → 200 { uri } | { image_base64 }
 *   Nagłówek X-App-Key (opcjonalny współdzielony sekret) — chroni przed zassaniem kredytów.
 *
 * WSZYSTKIE PROMPTY WYSYŁANE DO deAPI SĄ PO ANGIELSKU (modele działają najlepiej na EN).
 */
import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';

const {
  DEAPI_API_KEY,
  DEAPI_BASE_URL = 'https://oai.deapi.ai/v1',
  DEAPI_MODEL = 'Flux_2_Klein_4B_BF16', // domyślny model edycji (wybór użytkownika: Flux.2 Klein 4B)
  DEAPI_STEPS = '4', //                     Flux.2 Klein to model distilled — 4 kroki wystarczą
  DEAPI_FILL_MODEL, //                      opcjonalnie inny model do generative-fill (domyślnie = DEAPI_MODEL)
  DEAPI_FILL_STEPS, //                      opcjonalnie inne kroki do fill
  APP_KEY, //                               współdzielony sekret apka↔proxy (jeśli pusty → brak kontroli, tylko DEV)
  ALLOWED_ORIGINS, //                       CORS: lista originów po przecinku (domyślnie porty Expo web)
  PORT = '8787',
} = process.env;

// --- walidacja konfiguracji na starcie (fail fast, nie w połowie żądania) ---
if (!DEAPI_API_KEY) {
  console.error('FATAL: brak DEAPI_API_KEY — ustaw go w server/.env (patrz .env.example)');
  process.exit(1);
}
const EDIT_STEPS = Number(DEAPI_STEPS);
const FILL_STEPS = Number(DEAPI_FILL_STEPS || DEAPI_STEPS);
for (const [name, val] of [['DEAPI_STEPS', EDIT_STEPS], ['DEAPI_FILL_STEPS', FILL_STEPS]] as const) {
  if (!Number.isFinite(val) || val <= 0) {
    console.error(`FATAL: ${name} musi być dodatnią liczbą (jest: "${name === 'DEAPI_STEPS' ? DEAPI_STEPS : DEAPI_FILL_STEPS}")`);
    process.exit(1);
  }
}
const FILL_MODEL = DEAPI_FILL_MODEL || DEAPI_MODEL;

// Klient OpenAI SDK wskazany na deAPI. `enhance_prompt`/`steps`/`seed` to rozszerzenia deAPI — SDK forwarduje
// je jako pola formularza multipart (createForm iteruje po wszystkich kluczach body), więc przechodzą.
const client = new OpenAI({
  apiKey: DEAPI_API_KEY,
  baseURL: DEAPI_BASE_URL,
  timeout: 120_000, // generacja bywa wolna (~30 s) — hojny limit
  maxRetries: 1,
});

const app = express();
app.disable('x-powered-by');
app.use(helmet()); // nagłówki bezpieczeństwa (nosniff, HSTS itd.)

// CORS: domyślnie tylko porty Expo web (dev); natywne żądania nie wysyłają Origin → zawsze przechodzą.
const origins = (ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:19006')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins }));

// multipart w pamięci; deAPI limit pliku to 20 MB — trzymamy ten sam bezpieczny sufit
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Współdzielony sekret: jeśli APP_KEY ustawiony, każdy /api/* musi podać zgodny X-App-Key (porównanie stałoczasowe).
app.use('/api', (req, res, next) => {
  if (!APP_KEY) return next();
  const supplied = Buffer.from(req.header('X-App-Key') ?? '');
  const expected = Buffer.from(APP_KEY);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ error: 'unauthorized (bad or missing X-App-Key)' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, model: DEAPI_MODEL, steps: EDIT_STEPS }));

type EditOut = { uri: string } | { image_base64: string };

/** Wspólne wywołanie edycji obrazu w deAPI przez OpenAI SDK. Zwraca URL wyniku (albo base64, gdyby deAPI go dał). */
async function runEdit(buffer: Buffer, prompt: string, model: string, steps: number): Promise<EditOut> {
  const image = await toFile(buffer, 'image.png', { type: 'image/png' });
  const result = (await client.images.edit({
    model,
    image,
    prompt,
    // rozszerzenia deAPI (poza typami OpenAI) — forwardowane jako pola multipart:
    steps,
    enhance_prompt: 1, // PROMPT BOOSTER — deAPI podbija prompt przed generacją
  } as any)) as { data?: Array<{ url?: string; b64_json?: string }> };

  const first = result?.data?.[0];
  if (first?.url) return { uri: first.url };
  if (first?.b64_json) return { image_base64: first.b64_json };
  throw new Error('deAPI zwróciło pustą odpowiedź (brak url/b64_json)');
}

/** Błąd wywołania deAPI → apce oddajemy STABILNY 502 z ogólnym komunikatem; realny detal tylko do logów serwera.
 *  (Nie forwardujemy statusu deAPI — np. 401 od naszego klucza nie może udawać „złego X-App-Key" po stronie apki.) */
function sendUpstreamError(res: express.Response, e: unknown, where: string) {
  const err = e as { status?: number; message?: string };
  console.error(`[${where}] upstream ${err?.status ?? '?'}:`, err?.message ?? e);
  res.status(502).json({ error: `${where} failed (upstream)` });
}

// EDYCJA PROMPTEM — obraz + instrukcja użytkownika (EN). Model/kroki/booster dokłada serwer.
app.post('/api/v1/image-edits', upload.single('image'), async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  if (!prompt) return res.status(400).json({ error: 'missing "prompt" field' });
  try {
    res.json(await runEdit(req.file.buffer, prompt, DEAPI_MODEL, EDIT_STEPS));
  } catch (e) {
    sendUpstreamError(res, e, 'image-edits');
  }
});

// GENERATIVE FILL — wypełnia puste/przezroczyste obszary (np. rogi po obrocie kadru). deAPI nie ma
// maskowanego inpaintingu (mask → 400), więc używamy edycji z promptem opisującym domalowanie krawędzi.
const FILL_PROMPT =
  'Seamlessly fill the empty or transparent border areas by naturally extending the surrounding photo content. ' +
  'Keep the original subject and composition untouched. Match lighting, texture, color and perspective for a coherent result.';

app.post('/api/v1/image-fills', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing "image" file' });
  try {
    res.json(await runEdit(req.file.buffer, FILL_PROMPT, FILL_MODEL, FILL_STEPS));
  } catch (e) {
    sendUpstreamError(res, e, 'image-fills');
  }
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
  console.log(`gallery-ai-proxy → :${PORT}  (deAPI ${DEAPI_BASE_URL}, model ${DEAPI_MODEL}, steps ${EDIT_STEPS})`);
  if (!APP_KEY) console.warn('UWAGA: APP_KEY pusty — endpointy /api/* są otwarte. OK na DEV, ustaw przed deployem.');
});

// Graceful shutdown: Railway wysyła SIGTERM przy każdym redeployu — domknij trwające edycje zamiast ubijać.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig} — zamykam serwer…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref(); // twardy limit, gdyby połączenia wisiały
  });
}
// Ostatnia siatka bezpieczeństwa — loguj zamiast cichego wywalenia procesu.
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });
