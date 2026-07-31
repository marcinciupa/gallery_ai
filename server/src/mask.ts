/**
 * mask.ts — CZYSTA (bez I/O, bez sharpa) geometria maski inpaintingu. Wydzielone z tras, żeby dało się
 * to testować bez sieci i bez deAPI (patrz `npm run test` → src/mask.test.ts).
 *
 * PO CO MASKA: deAPI NIE MA maskowanego inpaintingu — dokumentacja `images/edits` mówi wprost
 * „Inpainting (`mask` parameter) is not supported". Model edycji regeneruje CAŁY obraz, więc zmiana
 * wychodziła daleko poza zaznaczenie. Jedyny sposób na zlokalizowanie edycji to KOMPOZYCJA: uruchom
 * edycję, a wynik wklej tylko tam, gdzie maska — resztę pikseli weź z oryginału.
 *
 * CO PRZYSYŁA APKA: maskę WEKTOROWO (JSON, kilka kB), nie rastrowo — pociągnięcia pędzla w
 * współrzędnych ZNORMALIZOWANYCH (0…1 względem pola obrazu). Serwer rasteryzuje je dopiero w
 * rozdzielczości realnego obrazu, więc maska nigdy się nie „rozjeżdża" ze zdjęciem i nie ma
 * kosztu przesyłania PNG-a z telefonu.
 *
 * UKŁAD WSPÓŁRZĘDNYCH: pole obrazu w apce ma DOKŁADNIE te same proporcje co obraz, więc x·W i y·H
 * używają tego samego współczynnika skali → koło pędzla zostaje kołem. `size` = szerokość pędzla
 * znormalizowana do SZEROKOŚCI pola (stąd promień = size·W/2).
 */

/** Pojedyncze pociągnięcie pędzla. `add`=false → wycinanie z zaznaczenia (tryb REMOVE FROM SELECT). */
import { BadRequest } from './errors.js';

export type MaskStroke = { add: boolean; size: number; pts: [number, number][] };
export type MaskPaths = { strokes: MaskStroke[] };
export type Roi = { left: number; top: number; width: number; height: number };

// Limity sanity — maska to dane od KLIENTA, a rasteryzacja jest synchroniczna (blokuje event loop,
// w tym odbiornik webhooków deAPI), więc jej koszt musi być ograniczony z góry.
const MAX_STROKES = 500;
const MAX_POINTS_TOTAL = 60_000;
const MIN_BRUSH = 0.001; // 0.1% szerokości obrazu — cieńszy pędzel nie ma sensu (i dzieli przez ~0)
const MAX_BRUSH = 0.5;   // pędzel = pół szerokości obrazu; apka używa maks. ~0.06, więc to i tak 8× zapas

/**
 * Budżet PRACY rasteryzacji (liczba odwiedzonych pikseli). Sama liczba punktów niczego nie ogranicza:
 * koszt to punkty × pole pędzla, więc 60 000 punktów grubym pędzlem to na zdjęciu 1536 px kilka MINUT
 * zajętego, synchronicznego CPU. Realna maska z apki kosztuje ~4 mln, więc 120 mln (≈1 s) to 30× zapas
 * dla użytkownika i twarda ściana dla żądania spreparowanego.
 */
const MAX_STAMP_WORK = 120_000_000;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Parsuje i WALIDUJE JSON maski z apki. Zwraca `null`, gdy pola nie ma, jest niepoprawny albo pusty —
 * wywołujący sam decyduje, czy to błąd (erase), czy po prostu brak maski (edycja całego obrazu).
 * Punkty dopuszczamy lekko poza polem (palec zjeżdża poza obraz) — rasteryzacja i tak je przytnie.
 */
export function parseMaskPaths(raw: unknown): MaskPaths | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return null; }
  const strokesRaw = (json as { strokes?: unknown })?.strokes;
  if (!Array.isArray(strokesRaw) || strokesRaw.length === 0 || strokesRaw.length > MAX_STROKES) return null;

  const strokes: MaskStroke[] = [];
  let total = 0;
  for (const s of strokesRaw) {
    const size = Number((s as { size?: unknown })?.size);
    const ptsRaw = (s as { pts?: unknown })?.pts;
    if (!Number.isFinite(size) || !Array.isArray(ptsRaw) || ptsRaw.length === 0) return null;
    total += ptsRaw.length;
    if (total > MAX_POINTS_TOTAL) return null;

    const pts: [number, number][] = [];
    for (const p of ptsRaw) {
      // `typeof` PRZED koercją: Number(null) === 0 i Number('') === 0, więc sama kontrola Number.isFinite
      // przepuszczała `[0.5, null]` jako punkt (0.5, 0) — pociągnięcie cicho lądowało przy górnej krawędzi
      // zamiast dać 400.
      if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
      const x = p[0], y = p[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      pts.push([clamp(x, -1, 2), clamp(y, -1, 2)]);
    }
    strokes.push({ add: (s as { add?: unknown })?.add !== false, size: clamp(size, MIN_BRUSH, MAX_BRUSH), pts });
  }
  return { strokes };
}

/**
 * Rasteryzuje pociągnięcia do bufora 8-bit (255 = piksel DO ZMIANY, 0 = zostaw oryginał).
 * Kolejność ma znaczenie: `add` maluje 255, `!add` wyciera na 0 — dokładnie jak na ekranie telefonu.
 * Krawędzie zostają twarde; zmiękcza je dopiero feather w [[compose.softenMask]].
 */
export function rasterizeMask(paths: MaskPaths, width: number, height: number): Buffer {
  const work = estimateStampWork(paths, width, height);
  if (work > MAX_STAMP_WORK) throw new BadRequest('mask too complex to process');

  const out = Buffer.alloc(width * height); // Buffer.alloc = wyzerowany (Buffer.allocUnsafe zostawiłby śmieci)
  for (const s of paths.strokes) {
    const r = Math.max(0.5, (s.size * width) / 2);
    const v = s.add ? 255 : 0;
    const first = s.pts[0];
    if (!first) continue;
    if (s.pts.length === 1) {
      stampCapsule(out, width, height, first[0] * width, first[1] * height, first[0] * width, first[1] * height, r, v);
      continue;
    }
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1]!, b = s.pts[i]!;
      stampCapsule(out, width, height, a[0] * width, a[1] * height, b[0] * width, b[1] * height, r, v);
    }
  }
  return out;
}

/**
 * Szacuje koszt rasteryzacji (liczbę pikseli do odwiedzenia) BEZ jej wykonywania — tanie O(punkty).
 * Liczymy pole prostokąta otaczającego każdą kapsułę, czyli dokładnie tyle, ile przejdzie `stampCapsule`.
 */
function estimateStampWork(paths: MaskPaths, width: number, height: number): number {
  let work = 0;
  for (const s of paths.strokes) {
    const d = 2 * Math.max(0.5, (s.size * width) / 2);
    if (s.pts.length === 1) { work += d * d; continue; }
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1]!, b = s.pts[i]!;
      const len = Math.hypot((b[0] - a[0]) * width, (b[1] - a[1]) * height);
      work += (d + len) * d;
    }
  }
  return work;
}

/** Wypełnia „kapsułę" (odcinek o grubości 2r z zaokrąglonymi końcami) — odpowiednik SVG stroke-linecap="round". */
function stampCapsule(out: Buffer, W: number, H: number, x0: number, y0: number, x1: number, y1: number, r: number, v: number): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + r));
  if (minX > maxX || minY > maxY) return; // odcinek całkiem poza obrazem

  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const r2 = r * r;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const row = y * W;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      // rzut punktu na odcinek (t przycięte do [0,1] → zaokrąglone końce)
      let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy);
      if (ex * ex + ey * ey <= r2) out[row + x] = v;
    }
  }
}

/** Prostokąt otaczający niezerowe piksele maski; `null` = maska pusta (nic nie zaznaczono). */
export function maskBBox(mask: Buffer, width: number, height: number): Roi | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export type RoiOptions = {
  /** Margines kontekstu wokół zaznaczenia, jako ułamek dłuższego boku bboxa (model musi widzieć otoczenie). */
  padFrac: number;
  /** Minimalny margines w px — dla drobnych zaznaczeń ułamek dałby prawie zero kontekstu. */
  minPad: number;
  /** Minimalny bok wycinka — deAPI odrzuca wejście poniżej 256 px (422). */
  minSide: number;
  /** Maksymalny stosunek boków — skrajne panoramy modele odrzucają. */
  maxAspect: number;
};

export const DEFAULT_ROI: RoiOptions = { padFrac: 0.35, minPad: 48, minSide: 256, maxAspect: 2.5 };

/**
 * Zamienia bbox zaznaczenia na WYCINEK do wysłania modelowi: dokłada kontekst, pilnuje minimalnego boku
 * i proporcji, przycina do obrazu. Wycinek zamiast całego zdjęcia daje modelowi więcej pikseli na
 * interesującym fragmencie i sam z siebie ogranicza jego „rozlewanie się".
 */
export function expandRoi(bbox: Roi, width: number, height: number, opt: RoiOptions = DEFAULT_ROI): Roi {
  const pad = Math.max(opt.minPad, Math.round(opt.padFrac * Math.max(bbox.width, bbox.height)));
  let left = bbox.left - pad;
  let top = bbox.top - pad;
  let right = bbox.left + bbox.width + pad;
  let bottom = bbox.top + bbox.height + pad;

  // Rozszerz do minimalnego boku i wyrównaj skrajne proporcje (obie operacje = „urośnij symetrycznie").
  // ⚠️ Przycięcie do krawędzi obrazu MUSI lecieć zawsze, także gdy nic nie dorastamy. Wcześniej był tu
  // wczesny `return` przy `need <= 0`, więc margines wychodzący poza kadr nigdy nie był przenoszony na
  // przeciwną stronę — tylko obcinany na końcu. Zaznaczenie przy krawędzi dawało wtedy ROI o proporcji
  // ~3.5 przy limicie 2.5 (2,2% losowych bboxów), a taki kadr deAPI odrzuca 422 i użytkownik dostawał
  // „AI could not process this photo" dla zdjęcia, które by zadziałało.
  const grow = (lo: number, hi: number, target: number, limit: number): [number, number] => {
    const need = target - (hi - lo);
    let a = lo, b = hi;
    if (need > 0) { a -= need / 2; b += need / 2; }
    if (a < 0) { b -= a; a = 0; }
    if (b > limit) { a -= b - limit; b = limit; }
    return [Math.max(0, a), Math.min(limit, b)];
  };

  [left, right] = grow(left, right, Math.min(opt.minSide, width), width);
  [top, bottom] = grow(top, bottom, Math.min(opt.minSide, height), height);
  [left, right] = grow(left, right, Math.min((bottom - top) / opt.maxAspect, width), width);
  [top, bottom] = grow(top, bottom, Math.min((right - left) / opt.maxAspect, height), height);

  const l = Math.max(0, Math.floor(left));
  const t = Math.max(0, Math.floor(top));
  return {
    left: l,
    top: t,
    width: Math.max(1, Math.min(width - l, Math.ceil(right) - l)),
    height: Math.max(1, Math.min(height - t, Math.ceil(bottom) - t)),
  };
}

/** Czy wycinek pokrywa prawie cały obraz → nie ma sensu kadrować, wyślij całość (mniej skalowań). */
export function coversWholeImage(roi: Roi, width: number, height: number): boolean {
  return roi.width * roi.height >= 0.85 * width * height;
}
