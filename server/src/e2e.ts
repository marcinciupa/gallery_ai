/**
 * e2e.ts — test END-TO-END na ŻYWYM deAPI. Uruchom przy działającym proxy:
 *
 *   npm start                 # w jednym terminalu
 *   npm run e2e               # w drugim   (E2E_BASE=... jeśli inny host niż localhost:8787)
 *
 * ⚠️ PALI KREDYTY deAPI (4 generacje). Dlatego NIE jest częścią `npm test` — selftest sprawdza logikę
 * maski offline, a to tutaj sprawdza rzeczy, których offline sprawdzić się nie da: że deAPI przyjmuje
 * nasz wycinek, że wynik da się pobrać i złożyć, i — najważniejsze — że po kompozycji piksele POZA
 * zaznaczeniem naprawdę zostają takie jak w oryginale.
 *
 * Wyniki lądują w `server/.e2e/` (gitignored) do obejrzenia okiem.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const BASE = (process.env.E2E_BASE || 'http://localhost:8787').replace(/\/+$/, '');
const APP_KEY = process.env.APP_KEY;
const OUT = new URL('../.e2e/', import.meta.url);

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const W = 768, H = 1024;

/** Syntetyczne „zdjęcie": niebo z gradientem, zielona ziemia i wyraźny czerwony obiekt do usunięcia. */
async function makePhoto(): Promise<Buffer> {
  const sky = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 120, g: 170, b: 225 } } }).png().toBuffer();
  const ground = await sharp({ create: { width: W, height: Math.round(H * 0.35), channels: 3, background: { r: 90, g: 130, b: 70 } } }).png().toBuffer();
  const ball = await sharp({ create: { width: 120, height: 120, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } })
    .composite([{ input: Buffer.from(`<svg width="120" height="120"><circle cx="60" cy="60" r="60" fill="#fff"/></svg>`), blend: 'dest-in' }])
    .png().toBuffer();
  return sharp(sky)
    .composite([{ input: ground, left: 0, top: H - Math.round(H * 0.35) }, { input: ball, left: 330, top: 430 }])
    .png().toBuffer();
}

/** Maska w układzie znormalizowanym — koło przykrywające czerwony obiekt (środek ~0.51/0.48). */
const ballMask = JSON.stringify({ strokes: [{ add: true, size: 0.2, pts: [[0.508, 0.478]] }] });

/** Mierzy też CZAS — apka odcina żądanie po 90 s, więc realny czas trasy to informacja, nie ciekawostka. */
async function post(path: string, image: Buffer, fields: Record<string, string>): Promise<{ status: number; json: any }> {
  const form = new FormData();
  form.append('image', new Blob([image as unknown as BlobPart], { type: 'image/png' }), 'image.png');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: APP_KEY ? { 'X-App-Key': APP_KEY } : {}, body: form });
  const text = await r.text();
  console.log(`  ·    ${path} → ${r.status} w ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(text.length / 1024).toFixed(0)} kB`);
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text.slice(0, 200) } }; }
}

/** Średnia różnica kanałów RGB między dwoma obrazami w prostokącie (0 = identyczne). */
async function diffIn(a: Buffer, b: Buffer, box: { left: number; top: number; width: number; height: number }): Promise<number> {
  const [pa, pb] = await Promise.all([
    sharp(a).extract(box).removeAlpha().raw().toBuffer(),
    sharp(b).extract(box).removeAlpha().raw().toBuffer(),
  ]);
  let sum = 0;
  for (let i = 0; i < pa.length; i++) sum += Math.abs((pa[i] ?? 0) - (pb[i] ?? 0));
  return sum / pa.length;
}

const decode = (res: any): Buffer | null => (typeof res?.image_base64 === 'string' ? Buffer.from(res.image_base64, 'base64') : null);

await mkdir(OUT, { recursive: true });
const photo = await makePhoto();
await writeFile(new URL('00-original.png', OUT), photo);

console.log(`e2e → ${BASE}`);
const health = await (await fetch(`${BASE}/health`)).json();
check('/health odpowiada i zna maski', health?.ok === true && health?.masking === true, JSON.stringify(health));

// ── 1. MAGIC ERASE z maską: wynik ma być obrazem, zmieniony TYLKO w zaznaczeniu ──────────────────
console.log('image-erase + maska');
const erase = await post('/api/v1/image-erase', photo, { mask_paths: ballMask });
check('200', erase.status === 200, JSON.stringify(erase.json).slice(0, 200));
const erased = decode(erase.json);
check('odpowiedź to obraz (kompozycja proxy), nie URL', !!erased && erase.json.mime === 'image/jpeg');
if (erased) {
  await writeFile(new URL('01-erase.jpg', OUT), erased);
  const inside = await diffIn(photo, erased, { left: 340, top: 440, width: 100, height: 100 });
  const farTop = await diffIn(photo, erased, { left: 0, top: 0, width: W, height: 200 });
  const farBottom = await diffIn(photo, erased, { left: 0, top: H - 150, width: W, height: 150 });
  check('w zaznaczeniu obraz się zmienił', inside > 8, `różnica ${inside.toFixed(1)}`);
  check('daleko od zaznaczenia (góra) oryginał nietknięty', farTop < 2, `różnica ${farTop.toFixed(2)}`);
  check('daleko od zaznaczenia (dół) oryginał nietknięty', farBottom < 2, `różnica ${farBottom.toFixed(2)}`);
}

// ── 2. TEXT TO IMAGE z maską (inpainting) ────────────────────────────────────────────────────────
console.log('image-edits + maska');
const edit = await post('/api/v1/image-edits', photo, { prompt: 'a yellow flower', mask_paths: ballMask });
check('200', edit.status === 200, JSON.stringify(edit.json).slice(0, 200));
const edited = decode(edit.json);
check('odpowiedź to obraz', !!edited);
if (edited) {
  await writeFile(new URL('02-edit.jpg', OUT), edited);
  const farTop = await diffIn(photo, edited, { left: 0, top: 0, width: W, height: 200 });
  check('prompt nie ruszył reszty zdjęcia', farTop < 2, `różnica ${farTop.toFixed(2)}`);
}

// ── 3. GENERATIVE FILL: maska z alfy (dziura w rogu) ─────────────────────────────────────────────
console.log('image-fills (maska z alfy)');
const holed = await sharp(photo).ensureAlpha()
  .composite([{ input: await sharp({ create: { width: 160, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), left: 0, top: 0, blend: 'dest-out' }])
  .png().toBuffer();
await writeFile(new URL('03-holed.png', OUT), holed);
const fill = await post('/api/v1/image-fills', holed, { mask_from_alpha: '1' });
check('200', fill.status === 200, JSON.stringify(fill.json).slice(0, 200));
const filled = decode(fill.json);
check('odpowiedź to obraz', !!filled);
if (filled) {
  await writeFile(new URL('04-fill.jpg', OUT), filled);
  // UWAGA: sharp `stats()` liczy statystyki WEJŚCIA i ignoruje `extract()` w łańcuchu — mierzyłby całe
  // zdjęcie i przepuścił czarny róg. Liczymy średnią z surowych pikseli wyciętego fragmentu.
  const holePx = await sharp(filled).extract({ left: 10, top: 10, width: 100, height: 100 }).removeAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < holePx.length; i++) sum += holePx[i] ?? 0;
  const holeMean = sum / holePx.length;
  check('dziura wypełniona (nie została czarna)', holeMean > 40, `średnia jasność ${holeMean.toFixed(1)}`);
  const farBottom = await diffIn(photo, filled, { left: 0, top: H - 150, width: W, height: 150 });
  check('fill nie ruszył reszty zdjęcia', farBottom < 2, `różnica ${farBottom.toFixed(2)}`);
}

// ── 4. zgodność wstecz: starsza apka bez maski dostaje URL, jak dotąd ────────────────────────────
// To NIE jest kosmetyka: wydane v0.9625 ignoruje `mime` w odpowiedzi i zapisałoby bajty JPEG-a
// do pliku `.png`. Obie trasy muszą zostać na dawnym kontrakcie, dopóki klient nie zgłosi nowego.
console.log('bez maski / bez flagi (starsze wydania apki)');
const legacy = await post('/api/v1/image-erase', photo, {});
check('erase: 200', legacy.status === 200, JSON.stringify(legacy.json).slice(0, 200));
check('erase: odpowiedź to { uri } (dawny kontrakt)', typeof legacy.json?.uri === 'string');
const legacyFill = await post('/api/v1/image-fills', holed, {}); // bez `mask_from_alpha`
check('fill: 200', legacyFill.status === 200, JSON.stringify(legacyFill.json).slice(0, 200));
check('fill: odpowiedź to { uri } (dawny kontrakt)', typeof legacyFill.json?.uri === 'string' && !legacyFill.json?.image_base64);

// ── 5. odporność na śmieciową maskę ──────────────────────────────────────────────────────────────
console.log('maska pusta / śmieciowa');
const onlyErase = await post('/api/v1/image-erase', photo, { mask_paths: '{"strokes":[{"add":false,"size":0.2,"pts":[[0.5,0.5]]}]}' });
check('sama „gumka" → 400, bez palenia kredytów', onlyErase.status === 400, `${onlyErase.status} ${JSON.stringify(onlyErase.json)}`);
// uszkodzona maska NIE MOŻE po cichu spaść do edycji całego obrazu — to byłby powrót do naprawianego buga
const broken = await post('/api/v1/image-erase', photo, { mask_paths: '{"strokes":[{"size":"nie-liczba"' });
check('zepsuta maska → 400, nie cicha edycja całości', broken.status === 400, `${broken.status} ${JSON.stringify(broken.json)}`);
// maska tak kosztowna, że jej rasteryzacja blokowałaby event loop na minuty
const heavyMask = JSON.stringify({ strokes: [{ add: true, size: 0.5, pts: Array.from({ length: 20_000 }, (_, i) => [(i % 100) / 100, (i % 97) / 97]) }] });
const heavy = await post('/api/v1/image-erase', photo, { mask_paths: heavyMask });
check('maska ponad budżet CPU → 400', heavy.status === 400, `${heavy.status} ${JSON.stringify(heavy.json)}`);
// obraz ponad limit megapikseli (mały plik, ogromna rozdzielczość) → 400, nie OOM kontenera
const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
const bombRes = await post('/api/v1/image-erase', bomb, { mask_paths: ballMask });
check(`obraz 144 MP (${(bomb.length / 1024).toFixed(0)} kB) → 400, nie OOM`, bombRes.status === 400, `${bombRes.status} ${JSON.stringify(bombRes.json)}`);

console.log(failed === 0 ? `\nWSZYSTKO OK (wyniki: server/.e2e/)` : `\n${failed} NIEUDANYCH ASERCJI`);
process.exit(failed === 0 ? 0 : 1);
