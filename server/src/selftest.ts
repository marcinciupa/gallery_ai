/**
 * selftest.ts — testy logiki maski i kompozycji. Uruchom: `npm test` (w server/).
 *
 * Bez sieci i bez deAPI: sprawdzamy DOKŁADNIE to, co miało zostać naprawione — że po kompozycji piksele
 * POZA zaznaczeniem zostają takie jak w oryginale, a w środku pochodzą z wyniku modelu. Reszta to sanity
 * na parserze maski (dane od klienta) i na geometrii wycinka.
 *
 * Świadomie bez frameworka testowego: kilkanaście asercji nie jest warte kolejnej zależności w obrazie
 * deployowanym na Railway.
 */
import sharp from 'sharp';
import { parseMaskPaths, rasterizeMask, maskBBox, maskComponents, expandRoi, coversWholeImage, DEFAULT_ROI, type MaskPaths } from './mask.js';
import { softenMask, compositeThroughMask, maskFromAlpha, readImage as readImageFacts, fillHolesNearest, blankMaskedArea } from './compose.js';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ── parser maski (wejście od klienta — musi odrzucać śmieci, nie wywracać serwera) ───────────────
console.log('parseMaskPaths');
check('brak pola → null', parseMaskPaths(undefined) === null);
check('pusty string → null', parseMaskPaths('   ') === null);
check('nie-JSON → null', parseMaskPaths('{oj') === null);
check('brak strokes → null', parseMaskPaths('{"a":1}') === null);
check('puste strokes → null', parseMaskPaths('{"strokes":[]}') === null);
check('stroke bez punktów → null', parseMaskPaths('{"strokes":[{"size":0.1,"pts":[]}]}') === null);
check('NaN w punkcie → null', parseMaskPaths('{"strokes":[{"size":0.1,"pts":[["x",2]]}]}') === null);
check('za dużo pociągnięć → null', parseMaskPaths(JSON.stringify({ strokes: Array.from({ length: 501 }, () => ({ size: 0.1, pts: [[0.5, 0.5]] })) })) === null);
check('za dużo punktów → null', parseMaskPaths(JSON.stringify({ strokes: [{ size: 0.1, pts: Array.from({ length: 60_001 }, () => [0.5, 0.5]) }] })) === null);
const parsed = parseMaskPaths('{"strokes":[{"add":true,"size":0.1,"pts":[[0.2,0.3],[0.4,0.5]]},{"add":false,"size":0.05,"pts":[[0.3,0.4]]}]}');
check('poprawny JSON → 2 pociągnięcia', parsed?.strokes.length === 2);
check('add:false zachowane', parsed?.strokes[1]?.add === false);
check('add domyślnie true', parseMaskPaths('{"strokes":[{"size":0.1,"pts":[[0.5,0.5]]}]}')?.strokes[0]?.add === true);
check('rozmiar przycięty do sensownego zakresu', (parseMaskPaths('{"strokes":[{"size":9999,"pts":[[0.5,0.5]]}]}')?.strokes[0]?.size ?? 0) <= 0.5);
// Number(null)===0 i Number('')===0, więc bez kontroli typu takie punkty przechodziły jako (x, 0)
check('null jako współrzędna → null', parseMaskPaths('{"strokes":[{"size":0.1,"pts":[[0.5,null]]}]}') === null);
check('pusty string jako współrzędna → null', parseMaskPaths('{"strokes":[{"size":0.1,"pts":[[0.5,""]]}]}') === null);
check('tablica jako współrzędna → null', parseMaskPaths('{"strokes":[{"size":0.1,"pts":[[0.5,[]]]}]}') === null);

// ── rasteryzacja ─────────────────────────────────────────────────────────────────────────────────
console.log('rasterizeMask');
const W = 400, H = 300;
const dot: MaskPaths = { strokes: [{ add: true, size: 0.1, pts: [[0.5, 0.5]] }] }; // r = 0.1*400/2 = 20 px
const dotMask = rasterizeMask(dot, W, H);
const dotBox = maskBBox(dotMask, W, H);
check('kropka ma bbox ~40×40', !!dotBox && near(dotBox.width, 40, 2) && near(dotBox.height, 40, 2), JSON.stringify(dotBox));
check('kropka wyśrodkowana', !!dotBox && near(dotBox.left + dotBox.width / 2, 200, 1.5) && near(dotBox.top + dotBox.height / 2, 150, 1.5));
check('środek kropki zamalowany', dotMask[150 * W + 200] === 255);
check('róg nietknięty', dotMask[0] === 0);
check('pusta maska → bbox null', maskBBox(Buffer.alloc(W * H), W, H) === null);

// REMOVE FROM SELECT musi wycinać z wcześniejszego zaznaczenia (kolejność pociągnięć ma znaczenie)
const carved = rasterizeMask({ strokes: [
  { add: true, size: 0.5, pts: [[0.5, 0.5]] },   // r = 100
  { add: false, size: 0.1, pts: [[0.5, 0.5]] },  // r = 20
] }, W, H);
check('remove wycina dziurę', carved[150 * W + 200] === 0);
check('add zostaje poza dziurą', carved[150 * W + (200 + 60)] === 255);

// koło zostaje kołem mimo różnych W/H (x·W i y·H używają tej samej skali, bo pole ma proporcje obrazu)
const round = rasterizeMask(dot, 400, 800);
const roundBox = maskBBox(round, 400, 800)!;
check('pędzel jest kołem, nie elipsą', near(roundBox.width, roundBox.height, 2), `${roundBox.width}×${roundBox.height}`);

// pociągnięcie częściowo poza obrazem nie może wyjść poza bufor
const outside = rasterizeMask({ strokes: [{ add: true, size: 0.2, pts: [[-0.5, -0.5], [0.05, 0.05]] }] }, W, H);
check('pociągnięcie spoza kadru przycięte', !!maskBBox(outside, W, H) && maskBBox(outside, W, H)!.left === 0);

// BUDŻET PRACY — rasteryzacja jest synchroniczna, więc maska „60 000 punktów grubym pędzlem" zablokowałaby
// event loop na minuty (razem z odbiornikiem webhooków deAPI). Limit liczy PRACĘ, nie liczbę punktów.
const heavy: MaskPaths = { strokes: [{ add: true, size: 0.5, pts: Array.from({ length: 20_000 }, (_, i) => [(i % 100) / 100, (i % 97) / 97] as [number, number]) }] };
let rejected = false;
const t0 = Date.now();
try { rasterizeMask(heavy, 1536, 2048); } catch { rejected = true; }
check('kosztowna maska odrzucona, nie licząca minutami', rejected && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
// realistyczna maska z apki (pędzel ~0.06, kilkaset punktów) musi przejść i być szybka
const realistic: MaskPaths = { strokes: Array.from({ length: 8 }, (_, s) => ({ add: true, size: 0.06, pts: Array.from({ length: 300 }, (_, i) => [0.1 + (i / 300) * 0.8, 0.2 + s * 0.07] as [number, number]) })) };
const t1 = Date.now();
const realMask = rasterizeMask(realistic, 1536, 2048);
check('realna maska z apki przechodzi i jest szybka', !!maskBBox(realMask, 1536, 2048) && Date.now() - t1 < 500, `${Date.now() - t1} ms`);

// ── wycinek (ROI) ────────────────────────────────────────────────────────────────────────────────
console.log('expandRoi');
const roiSmall = expandRoi({ left: 190, top: 140, width: 20, height: 20 }, W, H);
check('ROI zawiera zaznaczenie', roiSmall.left <= 190 && roiSmall.top <= 140 && roiSmall.left + roiSmall.width >= 210 && roiSmall.top + roiSmall.height >= 160);
check('ROI ma min. 256 px boku', Math.min(roiSmall.width, roiSmall.height) >= Math.min(256, H), JSON.stringify(roiSmall));
check('ROI mieści się w obrazie', roiSmall.left >= 0 && roiSmall.top >= 0 && roiSmall.left + roiSmall.width <= W && roiSmall.top + roiSmall.height <= H);

const roiThin = expandRoi({ left: 10, top: 10, width: 300, height: 4 }, W, H); // bardzo płaskie zaznaczenie
check('ROI wyrównuje skrajne proporcje', Math.max(roiThin.width / roiThin.height, roiThin.height / roiThin.width) <= DEFAULT_ROI.maxAspect + 0.01, JSON.stringify(roiThin));
check('ROI (płaskie) wciąż w obrazie', roiThin.left + roiThin.width <= W && roiThin.top + roiThin.height <= H);

const roiHuge = expandRoi({ left: 5, top: 5, width: W - 10, height: H - 10 }, W, H);
check('duże zaznaczenie → cały obraz', coversWholeImage(roiHuge, W, H));
check('małe zaznaczenie → NIE cały obraz', !coversWholeImage(roiSmall, W, H));

// FUZZ — pojedyncze przypadki nie wystarczyły: naruszenie proporcji wychodziło TYLKO dla zaznaczeń przy
// krawędzi kadru (margines wypychany poza obraz nie był przenoszony na drugą stronę), czyli w ~2% wejść.
// Deterministycznie (LCG), żeby nieudany przebieg dało się powtórzyć.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let bad = { contain: 0, bounds: 0, aspect: 0 };
for (let i = 0; i < 20000; i++) {
  const iw = 200 + Math.floor(rnd() * 1800), ih = 200 + Math.floor(rnd() * 1800);
  const bw = 1 + Math.floor(rnd() * iw), bh = 1 + Math.floor(rnd() * ih);
  const box = { left: Math.floor(rnd() * (iw - bw + 1)), top: Math.floor(rnd() * (ih - bh + 1)), width: bw, height: bh };
  const r = expandRoi(box, iw, ih);
  if (r.left > box.left || r.top > box.top || r.left + r.width < box.left + box.width || r.top + r.height < box.top + box.height) bad.contain++;
  if (r.left < 0 || r.top < 0 || r.left + r.width > iw || r.top + r.height > ih || r.width < 1 || r.height < 1) bad.bounds++;
  // limit proporcji obowiązuje tylko wtedy, gdy sam obraz go spełnia (inaczej zgodny wycinek nie istnieje)
  const imgAspect = Math.max(iw / ih, ih / iw);
  const roiAspect = Math.max(r.width / r.height, r.height / r.width);
  if (imgAspect <= DEFAULT_ROI.maxAspect && roiAspect > DEFAULT_ROI.maxAspect + 0.01) bad.aspect++;
}
check('fuzz: ROI zawsze zawiera zaznaczenie', bad.contain === 0, `${bad.contain}/20000`);
check('fuzz: ROI zawsze wewnątrz obrazu', bad.bounds === 0, `${bad.bounds}/20000`);
check('fuzz: ROI dotrzymuje limitu proporcji', bad.aspect === 0, `${bad.aspect}/20000`);

// ── zmiękczenie maski ────────────────────────────────────────────────────────────────────────────
// Dwa warunki, oba wykryły realne błędy:
//  1. ŚRODEK zaznaczenia musi mieć alfę 255 — inaczej edycja nakłada się tylko częściowo (efekt „duch").
//  2. Rozmyta maska musi mieścić się w wycinku — inaczej kompozycja urywa gradient na krawędzi ROI
//     i zostaje widoczny prostokątny brzeg.
console.log('softenMask');
const softDot = await softenMask(dotMask, W, H, 16);
check('środek zaznaczenia jest w pełni kryjący', softDot[150 * W + 200] === 255, String(softDot[150 * W + 200]));
check('zmiękczenie ROZSZERZA zaznaczenie (dilate przed feather)', maskBBox(softDot, W, H)!.width > dotBox!.width);
check('krawędź jest miękka, nie skokowa', new Set(softDot.filter((v) => v > 0 && v < 255)).size > 10);

const boxes = [
  { left: 190, top: 140, width: 20, height: 20 },   // drobne zaznaczenie → σ przycięte do 2
  { left: 100, top: 60, width: 120, height: 100 },  // średnie
  { left: 20, top: 10, width: 340, height: 260 },   // prawie cały obraz (ROI = całość)
  { left: 0, top: 0, width: 60, height: 60 },       // przy krawędzi (ROI przycinany do obrazu)
];
for (const box of boxes) {
  const sigma = Math.min(16, Math.max(2, 0.05 * Math.min(box.width, box.height)));
  const hard = Buffer.alloc(W * H);
  for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) hard[y * W + x] = 255;
  const soft = await softenMask(hard, W, H, sigma);
  const expanded = expandRoi(box, W, H);
  const roi = coversWholeImage(expanded, W, H) ? { left: 0, top: 0, width: W, height: H } : expanded;
  let outside = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (soft[y * W + x] === 0) continue;
      if (x < roi.left || x >= roi.left + roi.width || y < roi.top || y >= roi.top + roi.height) outside++;
    }
  }
  check(`zmiękczona maska ⊂ ROI (${box.width}×${box.height})`, outside === 0, `${outside} px poza`);
}

// ── kompozycja: to jest sedno poprawki ───────────────────────────────────────────────────────────
console.log('compositeThroughMask');
const original = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer();
// „Wynik modelu" jak w rzeczywistości: ten sam kadr, ale z globalnym dryfem jasności (+25 na kanał)
// i nową treścią w zaznaczeniu. Dryf MUSI zostać skasowany dopasowaniem tonalnym, inaczej po wklejeniu
// widać jaśniejszą łatę.
const blueDisc = Buffer.from(`<svg width="${roiSmall.width}" height="${roiSmall.height}"><circle cx="128" cy="128" r="60" fill="rgb(45,65,255)"/></svg>`);
const editedFull = await sharp({ create: { width: roiSmall.width, height: roiSmall.height, channels: 3, background: { r: 245, g: 55, b: 55 } } })
  .composite([{ input: blueDisc }]).png().toBuffer();
const composed = await compositeThroughMask(original, editedFull, softDot, { width: W, height: H }, roiSmall);
check('wynik to JPEG', composed.mime === 'image/jpeg');
const px = await sharp(composed.buffer).raw().toBuffer();
const at = (x: number, y: number) => [px[(y * W + x) * 3] ?? 0, px[(y * W + x) * 3 + 1] ?? 0, px[(y * W + x) * 3 + 2] ?? 0] as const;
const corner = at(2, 2), centre = at(200, 150), farEdge = at(W - 3, H - 3);
check('poza maską zostaje oryginał (róg)', near(corner[0], 220, 6) && near(corner[2], 30, 6), corner.join(','));
check('poza maską zostaje oryginał (przeciwny róg)', near(farEdge[0], 220, 6) && near(farEdge[2], 30, 6), farEdge.join(','));
check('w masce jest wynik modelu', near(centre[2], 230, 10), centre.join(','));
// dryf +25 modelu ma zostać zdjęty: dysk 45,65,255 → 20,40,230 (bez korekty byłoby ~45,65,255)
check('dryf jasności modelu skasowany (matchTone)', near(centre[0], 20, 10) && near(centre[1], 40, 10), centre.join(','));
const composedFacts = await readImageFacts(composed.buffer);
check('rozmiar obrazu bez zmian', composedFacts.width === W && composedFacts.height === H);

// wynik modelu o innym rozmiarze niż ROI (modele „przyciągają" bok do wielokrotności 8/16) musi wrócić do ROI
const editedOff = await sharp({ create: { width: roiSmall.width + 13, height: roiSmall.height - 7, channels: 3, background: { r: 20, g: 40, b: 230 } } }).png().toBuffer();
const composedOff = await compositeThroughMask(original, editedOff, softDot, { width: W, height: H }, roiSmall);
check('rozjechany rozmiar wyniku nie wywraca kompozycji', (await readImageFacts(composedOff.buffer)).width === W);

// ── maska z alfy (GENERATIVE FILL) ───────────────────────────────────────────────────────────────
console.log('maskFromAlpha');
// dziurę wycinamy KRYJĄCYM prostokątem w trybie dest-out (dest × (1 − src.alfa)) — przezroczysty src
// niczego by nie usunął
const hole = await sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
const withHole = await sharp({ create: { width: 200, height: 160, channels: 4, background: { r: 10, g: 200, b: 10, alpha: 1 } } })
  .composite([{ input: hole, left: 0, top: 0, blend: 'dest-out' }]).png().toBuffer();
const alphaMask = await maskFromAlpha(withHole, 200, 160);
const alphaBox = maskBBox(alphaMask, 200, 160);
check('dziura wykryta z alfy', !!alphaBox && alphaBox.left === 0 && alphaBox.top === 0 && alphaBox.width === 100 && alphaBox.height === 80, JSON.stringify(alphaBox));
const opaque = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
check('obraz bez dziur → maska pusta', maskBBox(await maskFromAlpha(opaque, 40, 40), 40, 40) === null);

// ── limit rozdzielczości ─────────────────────────────────────────────────────────────────────────
// Limit ROZMIARU PLIKU nie chroni: jednolity PNG 12000×12000 waży poniżej 0.5 MB, a rozpakowany zjada
// w tej ścieżce ~1.7 GB (bufory RGBA + kolejka BFS) → OOM kontenera.
console.log('readImage');
const huge = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
check(`ogromny PNG waży tyle co nic (${(huge.length / 1024).toFixed(0)} kB) — limit pliku go nie łapie`, huge.length < 2 * 1024 * 1024);
let hugeRejected = false;
try { await readImageFacts(huge); } catch (e) { hugeRejected = (e as { status?: number })?.status === 400; }
check('obraz ponad limit megapikseli → 400', hugeRejected);
let junkRejected = false;
try { await readImageFacts(Buffer.from('to nie jest obraz')); } catch (e) { junkRejected = (e as { status?: number })?.status === 400; }
check('nieczytelny plik → 400, nie „awaria deAPI"', junkRejected);

// ── zalepianie dziur przed wysyłką do modelu (GENERATIVE FILL) ───────────────────────────────────
// deAPI spłaszcza przezroczystość do CZERNI, więc model dostawał czarny kwadrat i go zostawiał.
console.log('prefillHoles');
const rgbaHole = await sharp(withHole).toColorspace('srgb').ensureAlpha().raw().toBuffer();
const nearest = fillHolesNearest(rgbaHole, 200, 160);
check('dziura dostaje kolor sąsiada, nie czerń', (nearest[(20 * 200 + 20) * 3 + 1] ?? 0) > 150, `G=${nearest[(20 * 200 + 20) * 3 + 1]}`);
check('treść poza dziurą nietknięta', (nearest[(100 * 200 + 150) * 3 + 1] ?? 0) > 150);
// tak samo jak w produkcji: maska z alfy → wymazanie obszaru z wycinka przed wysyłką do modelu
const holeMask = await maskFromAlpha(withHole, 200, 160);
const prefilled = await blankMaskedArea(withHole, holeMask, 200, 160, 4);
const preStats = await sharp(prefilled).extract({ left: 5, top: 5, width: 80, height: 60 }).stats();
check('wycinek dla modelu nie ma czarnego kwadratu', (preStats.channels[1]?.mean ?? 0) > 150, String(Math.round(preStats.channels[1]?.mean ?? 0)));
check('wycinek dla modelu jest nieprzezroczysty', !(await readImageFacts(prefilled)).hasAlpha);

// obraz W CAŁOŚCI przezroczysty nie może wywrócić BFS-a (brak piksela źródłowego)
const allClear = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
const allClearRaw = await sharp(allClear).toColorspace('srgb').ensureAlpha().raw().toBuffer();
check('w pełni przezroczysty obraz nie wywraca zalepiania', fillHolesNearest(allClearRaw, 8, 8).length === 8 * 8 * 3);

// ── wymazanie zaznaczenia przed wysyłką do modelu (MAGIC ERASE / TEXT TO IMAGE) ──────────────────
// Bez tego model nie wie, gdzie jest maska: erase oddaje kadr bez zmian, a inpaint maluje obok.
console.log('blankMaskedArea');
const W2 = 120, H2 = 90;
// tło zielone + wyraźny czerwony obiekt, który maska ma wymazać
const objMask = Buffer.alloc(W2 * H2);
for (let y = 30; y < 60; y++) for (let x = 40; x < 80; x++) objMask[y * W2 + x] = 255;
const photo2 = await sharp({ create: { width: W2, height: H2, channels: 3, background: { r: 40, g: 160, b: 60 } } })
  .composite([{ input: await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer(), left: 40, top: 30 }])
  .png().toBuffer();
const blanked = await blankMaskedArea(photo2, objMask, W2, H2, 3);
const blankedRaw = await sharp(blanked).toColorspace('srgb').removeAlpha().raw().toBuffer();
const pixAt = (x: number, y: number) => ({ r: blankedRaw[(y * W2 + x) * 3] ?? 0, g: blankedRaw[(y * W2 + x) * 3 + 1] ?? 0 });
const midPix = pixAt(60, 45), cornerPix = pixAt(10, 10);
check('obiekt spod maski zniknął (nie ma już czerwieni)', midPix.r < 120, `R=${midPix.r}`);
check('w miejscu maski jest kolor tła, nie czerń', midPix.g > 100, `G=${midPix.g}`);
check('piksele poza maską nietknięte', cornerPix.r === 40 && cornerPix.g === 160, `${cornerPix.r},${cornerPix.g}`);
check('wycinek dla modelu jest nieprzezroczysty', !(await readImageFacts(blanked)).hasAlpha);
let blankMismatch = false;
try { await blankMaskedArea(photo2, Buffer.alloc(10), W2, H2, 3); } catch { blankMismatch = true; }
check('maska w złym rozmiarze → błąd, nie ciche wysłanie kadru bez zmian', blankMismatch);

// ── spójne obszary maski (GENERATIVE FILL wypełnia każdy róg osobno) ─────────────────────────────
console.log('maskComponents');
const corners = Buffer.alloc(W * H);
const paint = (x0: number, y0: number, w: number, h: number) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) corners[y * W + x] = 255;
};
paint(0, 0, 30, 20); paint(W - 40, 0, 40, 25); paint(0, H - 15, 20, 15); // trzy rogi
const comps = maskComponents(corners, W, H, 4);
check('trzy dziury → trzy obszary', comps?.length === 3, String(comps?.length));
check('największy obszar pierwszy', (comps?.[0]?.width ?? 0) * (comps?.[0]?.height ?? 0) === 40 * 25);
check('bbox obszaru dokładny', comps?.[2]?.left === 0 && comps?.[2]?.top === H - 15 && comps?.[2]?.width === 20);
// jeden wspólny bbox obejmowałby PRAWIE CAŁY kadr — to jest dokładnie ten bug z rogami po obrocie
const all = maskBBox(corners, W, H)!;
check('wspólny bbox obejmuje niemal cały kadr (dlaczego rozbijamy)', all.width * all.height > 0.9 * W * H);
check('brak dziur → pusta lista', maskComponents(Buffer.alloc(W * H), W, H, 4)?.length === 0);
const scattered = Buffer.alloc(W * H);
for (let k = 0; k < 12; k++) scattered[(20 + k * 15) * W + (20 + k * 25)] = 255; // 12 osobnych kropek
check('za dużo kawałków → null (jeden wspólny wycinek)', maskComponents(scattered, W, H, 4) === null);

console.log(failed === 0 ? '\nWSZYSTKO OK' : `\n${failed} NIEUDANYCH ASERCJI`);
process.exit(failed === 0 ? 0 : 1);
